/**
 * Cable service (T2.7): support detection, connection, pre-write checklist, real and
 * simulated writes, journal, rescue after interruption and the X9 multi-cable queue.
 *
 * Every write goes through, in this order: a fresh single-use gesture token, the
 * checklist (gate on a snapshot, confirmations, 2 s spacing), the cross-tab write lock
 * (Web Locks `oa-cable-write`, `ifAvailable`), a bounded live deploy check for native writes
 * (offline: only the last live confirmation of this same build), the checklist again with fresh flash state, then `writeCurve` / `writeMany` from
 * `open-auri/transport`, which run `gateForWrite`
 * again on that snapshot. Nothing is ever retried or written automatically; the lock and
 * the in-flight marker only ever refuse or record.
 *
 * Before any I/O a marker (`oa.cable.inflight`) is persisted and, as each device sequence
 * starts, pointed at that device (or the sequence is refused) and the flash attempt is
 * recorded. A marker left behind by a closed tab becomes an
 * `interrupted` journal entry (and the rescue notice) on the next load, or in any open tab
 * that saw the marker appear and waited for the writing tab's liveness lock
 * (`oa-cable-alive:<tabId>`; only writers ever request the write lock). An X9 queue journals
 * each cable as it commits and, between cables, leaves a `between` marker that names no write.
 *
 * Live preview (issues #67/#70): `startLive` / `queueLive` / `confirmLive` / `revertLive` /
 * `stopLive` send curves to the cable's RAM with `applyCurve` (no commit). They are not writes:
 * no flash bookkeeping, journal, `cable:written` or in-flight marker; see "Live (no-flash)
 * preview" below. `write()` during a session is "Salvar" and waits for the apply in flight.
 *
 * Create it in the browser only (never during SSR module evaluation).
 */
import {
	CommitCollisionError,
	ConcurrentWriteError,
	DeviceDisconnectedError,
	DeviceUnusableError,
	FAKE_PRODUCT_NAME,
	FakeHID,
	FakeHIDDevice,
	GateRejectedError,
	PRODUCT_NAME,
	WRITE_SPACING_MS,
	applyCurve,
	requestCable,
	systemClock,
	writeCurve,
	writeMany
} from 'open-auri/transport';
import {
	JOURNAL_WAIVED_MAX,
	LIVE_MAX_WAIT_MS,
	MIN_INTERVAL_MS,
	coalesce,
	liveHold,
	nextApplyDelay,
	observeFlashState,
	recordWrite
} from 'open-auri/policy';
import { NEUTRAL_BANDS, USB_PID, USB_VID } from 'open-auri/dsp';
import { gateForWrite, isWaivable } from 'open-auri/safety';
import {
	evaluateChecklist,
	evaluateLiveChecklist,
	flashCountersOf,
	hasExperimentalKinds,
	hasUltrasonicBands,
	writtenLevelDb
} from './checklist.ts';
import { LIVE_APPLY_POLICY } from './live-policy.ts';
import { isNativeHid } from './native/brand.ts';
import {
	assertNativeWriteFresh,
	type NativeFreshnessDeps,
	type NativeWriteFreshness
} from './native-freshness.ts';
import { consumeGestureToken, createGestureToken, type GestureEventLike } from './gesture.ts';
import { withWriteFlag } from './write-flag.ts';
import type {
	Band,
	CableDevice,
	Clock,
	CableMode,
	CableServiceDeps,
	CableState,
	CableWrittenDetail,
	ChecklistContext,
	ChecklistInput,
	ChecklistResult,
	ConnectionState,
	FlashState,
	GateResult,
	GestureToken,
	HidLike,
	InflightMarker,
	InflightPort,
	JournalEntry,
	JournalStatus,
	LiveApplied,
	LiveCurve,
	LiveEndedReason,
	LiveGestureRequest,
	LiveHoldState,
	LiveMarker,
	LiveOrphan,
	LiveOutcome,
	LiveRefusalReason,
	LiveRefused,
	LiveRevertFailure,
	LiveRevertRequest,
	LiveSavedCurve,
	LiveStartRequest,
	LiveState,
	LiveStatus,
	LiveStopRequest,
	ManyResult,
	QueueItem,
	QueueOutcome,
	QueueRequest,
	QueueState,
	ReasonCode,
	Refused,
	RefusalReason,
	RescueState,
	WriteOutcome,
	WriteLockManager,
	WriteProfile,
	WriteRequest,
	WriteResult,
	Written
} from './types.ts';

/**
 * Web Locks name held from the in-lock authorization through settle, in every tab. Only
 * writers request it, always with `ifAvailable`: this service never waits in its queue.
 */
export const CABLE_WRITE_LOCK = 'oa-cable-write';
/** Prefix of the per-tab liveness lock (`oa-cable-alive:<tabId>`). */
export const CABLE_ALIVE_LOCK_PREFIX = 'oa-cable-alive:';

/**
 * Liveness lock of the tab `tabId`: taken inside its first write lock, before its first
 * marker, and held until that tab is disposed or dies. Other tabs wait on it (never on the
 * write lock) to learn that the tab named by a marker is gone.
 */
export function cableAliveLock(tabId: string): string {
	return CABLE_ALIVE_LOCK_PREFIX + tabId;
}
/** `localStorage` key of the persisted in-flight write marker. */
export const CABLE_INFLIGHT_KEY = 'oa.cable.inflight';
/**
 * Age after which an unsettled marker is considered abandoned when the lock state cannot be
 * queried (a write takes about 0.35 s per cable; the marker is refreshed per cable).
 */
export const INFLIGHT_STALE_MS = 10_000;
/**
 * Web Locks name held by the tab running a live preview session, for the whole session (S5):
 * a second tab's `startLive` and other tabs' writes are refused (`live-elsewhere`) meanwhile.
 */
export const CABLE_LIVE_LOCK = 'oa-cable-live';
/** `localStorage` key of the persisted live preview marker (S5). */
export const CABLE_LIVE_KEY = 'oa.cable.live';
/** First wait after a busy write lock (nothing sent); doubled on each busy attempt. */
export const LIVE_BUSY_BACKOFF_MS = 300;
/** Busy attempts of one live apply before the edit is dropped (`lastError: 'busy'`). */
export const LIVE_BUSY_MAX_ATTEMPTS = 5;

function browserLocks(): WriteLockManager | null {
	if (typeof window === 'undefined') return null;
	const nav = globalThis.navigator as unknown as { locks?: WriteLockManager } | undefined;
	const locks = nav?.locks;
	return typeof locks === 'object' && locks !== null && typeof locks.request === 'function'
		? locks
		: null;
}

function browserInflight(key: string = CABLE_INFLIGHT_KEY): InflightPort | null {
	if (typeof window === 'undefined') return null;
	let storage: Storage | null;
	try {
		storage = window.localStorage;
	} catch (cause) {
		console.warn('cable in-flight marker storage unavailable', cause);
		return null;
	}
	if (storage === null) return null;
	const backend = storage;
	return {
		read() {
			try {
				return backend.getItem(key);
			} catch (cause) {
				console.warn('cable in-flight marker read failed', cause);
				return null;
			}
		},
		write(value) {
			try {
				if (value === null) backend.removeItem(key);
				else backend.setItem(key, value);
				return true;
			} catch (cause) {
				console.warn('cable in-flight marker write failed', cause);
				return false;
			}
		},
		subscribe(listener) {
			// `storage` events only fire for changes made by other tabs of this origin.
			const onStorage = (event: StorageEvent) => {
				if (event.storageArea !== backend) return;
				if (event.key === key || event.key === null) listener();
			};
			window.addEventListener('storage', onStorage);
			return () => window.removeEventListener('storage', onStorage);
		}
	};
}

function randomTabId(): string {
	const crypto = globalThis.crypto as Partial<Crypto> | undefined;
	if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The waived codes of a persisted YOLO marker, checked like the journal checks an entry's
 * (`JOURNAL_WAIVED_MAX` at most) and restricted to the codes the YOLO profile can waive.
 * Null when the list is not valid: the recovered entry then names no waived code.
 */
function markerWaived(value: unknown): ReasonCode[] | null {
	if (!Array.isArray(value) || value.length > JOURNAL_WAIVED_MAX) return null;
	const codes: ReasonCode[] = [];
	for (const code of value as unknown[]) {
		if (!isWaivable(code)) return null;
		codes.push(code as ReasonCode);
	}
	return codes;
}

/** The `freshness` key of a journal entry or marker: a copy, or nothing when null. */
function journalFreshness(freshness: NativeWriteFreshness | null): Pick<JournalEntry, 'freshness'> {
	return freshness === null
		? {}
		: { freshness: { basis: freshness.basis, checkedAt: freshness.checkedAt } };
}

/**
 * The deploy check of a persisted marker, checked like the journal checks an entry's; null
 * when absent or not valid (the recovered entry then names none).
 */
function markerFreshness(value: unknown): NativeWriteFreshness | null {
	if (typeof value !== 'object' || value === null) return null;
	const { basis, checkedAt } = value as Partial<Record<keyof NativeWriteFreshness, unknown>>;
	if (basis !== 'live' && basis !== 'last-good') return null;
	if (!Number.isSafeInteger(checkedAt) || (checkedAt as number) < 0) return null;
	if ((checkedAt as number) > 8.64e15) return null;
	return { basis, checkedAt: checkedAt as number };
}

/**
 * Parses a persisted marker; null when it is unreadable or malformed. A marker without
 * `profile: 'yolo'` (a standard write, or one persisted before markers carried a profile) is
 * standard; `waived` is kept only on a YOLO marker and only when it is valid.
 */
export function parseInflightMarker(raw: string): InflightMarker | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (cause) {
		console.warn('cable in-flight marker is not JSON', cause);
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const candidate = value as Partial<Record<keyof InflightMarker, unknown>>;
	const { at, crc, name, preampDb, bands, device, tabId } = candidate;
	if (
		!finite(at) ||
		!finite(crc) ||
		!Number.isInteger(crc) ||
		typeof name !== 'string' ||
		!finite(preampDb) ||
		!Array.isArray(bands) ||
		typeof device !== 'string' ||
		typeof tabId !== 'string'
	) {
		return null;
	}
	const marker: InflightMarker = { at, crc, name, preampDb, bands: bands as Band[], device, tabId };
	if (candidate.between === true) marker.between = true;
	if (candidate.profile === 'yolo') {
		marker.profile = 'yolo';
		const waived = markerWaived(candidate.waived);
		if (waived !== null) marker.waived = waived;
	}
	const freshness = markerFreshness(candidate.freshness);
	if (freshness !== null) marker.freshness = freshness;
	return marker;
}

/** Parses a persisted live preview marker (S5); null when it is unreadable or malformed. */
export function parseLiveMarker(raw: string): LiveMarker | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (cause) {
		console.warn('cable live marker is not JSON', cause);
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const { tabId, device, crc, at } = value as Partial<Record<keyof LiveMarker, unknown>>;
	if (
		typeof tabId !== 'string' ||
		typeof device !== 'string' ||
		!finite(crc) ||
		!Number.isInteger(crc) ||
		!finite(at)
	) {
		return null;
	}
	return { tabId, device, crc, at };
}

/** Event dispatched on `service.events` after each real, successful write (F4 outbox). */
export const CABLE_WRITTEN_EVENT = 'cable:written';
/** Event dispatched on `service.events` whenever the state changes (detail: CableState). */
export const CABLE_STATUS_EVENT = 'cable:status';
/** Suffix of simulated device labels (journal data, not UI copy). */
export const SIMULATED_LABEL_SUFFIX = ' (simulado)';

/** Neutro (10 × OFF, preamp −0.5 dB, CRC 0x4FFF): the rescue curve after an interruption. */
export const NEUTRAL_CURVE: Readonly<{ bands: readonly Band[]; preampDb: number; name: string }> =
	Object.freeze({ bands: NEUTRAL_BANDS, preampDb: -0.5, name: 'Neutro' });

interface SupportEnv {
	navigator?: { hid?: unknown };
	isSecureContext?: boolean;
}

/** `real` when `navigator.hid` exists in a secure context, otherwise `simulated`. */
export function detectCableSupport(
	env: SupportEnv = globalThis as unknown as SupportEnv
): CableMode {
	const hid = env.navigator?.hid;
	return env.isSecureContext === true && typeof hid === 'object' && hid !== null
		? 'real'
		: 'simulated';
}

function navigatorHid(): HidLike | null {
	const nav = globalThis.navigator as unknown as { hid?: HidLike } | undefined;
	return nav?.hid ?? null;
}

/** Whether `value` looks like the 0xCB cable (VID 0x3302, PID 0x8902). */
export function isCableDevice(value: unknown): value is CableDevice {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<CableDevice>;
	return (
		candidate.vendorId === USB_VID &&
		candidate.productId === USB_PID &&
		typeof candidate.sendReport === 'function' &&
		typeof candidate.open === 'function'
	);
}

function deviceOf(event: Event): unknown {
	return (event as Event & { device?: unknown }).device;
}

function truncate(text: string, max: number): string {
	const points = [...text];
	return points.length > max ? points.slice(0, max).join('') : text;
}

function copyBands(snapshot: readonly Readonly<Band>[]): Band[] {
	return snapshot.map((band): Band => ({ ...band }));
}

/**
 * Wraps the HID so the start (`disconnect` listener added) and end (removed) of each
 * device sequence inside `writeMany` are observable. `onStart` runs before the listener is
 * attached: when it throws, the transport refuses that sequence before any I/O, no listener
 * is left on the real HID and `onEnd` never runs for it. Listeners are forwarded to the real
 * HID unchanged, so disconnect detection is identical.
 */
function observedHid(base: HidLike, onStart: () => void, onEnd: () => void): HidLike {
	/** Disconnect listeners of sequences that started (attached to the real HID). */
	const started = new Set<(event: Event) => void>();
	return {
		requestDevice: (options) => base.requestDevice(options),
		addEventListener(type, listener) {
			if (type === 'disconnect') onStart();
			base.addEventListener(type, listener);
			if (type === 'disconnect') started.add(listener);
		},
		removeEventListener(type, listener) {
			base.removeEventListener(type, listener);
			if (type === 'disconnect' && started.delete(listener)) onEnd();
		}
	};
}

/** What `authorize` captured from a request, read once; the only values a write uses. */
interface Authorized {
	checklist: ChecklistResult;
	/** The gate's frozen snapshot: exactly what the checklist approved and what is sent. */
	snapshot: readonly Readonly<Band>[];
	preampDb: number;
	experimental: boolean;
	/** Gate profile of the write (`'yolo'`: Modo YOLO, journaled as such). */
	profile: WriteProfile;
	/** Journal name, truncated to 48 characters. */
	name: string;
	/** CRC-16 of the gated payload. */
	crc: number;
	/** Native writes: the deploy check that cleared it (journaled); null otherwise. */
	freshness: NativeWriteFreshness | null;
}

/** What the synchronous first phase captured: the request read once and its gate verdict. */
interface Prepared {
	captured: ChecklistInput;
	verdict: GateResult;
	/** The checklist as evaluated in the caller's task (refusal details before the lock). */
	checklist: ChecklistResult;
	name: string;
}

/** A live curve read once and gated (session options) when it was queued. */
interface LiveCaptured {
	verdict: GateResult;
	/** The gate's frozen snapshot (what an apply sends); null when the codec refused it. */
	snapshot: readonly Readonly<Band>[] | null;
	preampDb: number;
	crc: number | null;
	levelDb: number | null;
	/**
	 * Start, confirm, revert or a re-sent held curve: the user just confirmed this level, so no
	 * debounce and no loudness / unknown-state hold (the gate always runs).
	 */
	confirmed: boolean;
	/**
	 * HS/LP/HP or a band above 20 kHz: never applied unless the session confirmed experimental
	 * filters (`LiveSession.experimentalConfirmed`).
	 */
	experimentalRequired: boolean;
	/** A revert to the saved curve: once applied, the live marker is removed. */
	revert: boolean;
	/** Set when the curve was dropped because the write lock stayed busy (nothing sent). */
	busy: boolean;
	/** Settles once this curve was applied, held, dropped, replaced or its session ended. */
	settled: Promise<void>;
	done: () => void;
}

/** The curve one cable holds in flash (a revert target), and when it was committed (epoch ms). */
interface SavedOnCable extends LiveSavedCurve {
	crc: number;
	at: number;
}

/** One live preview session (one device; it never moves to another one). */
interface LiveSession {
	device: CableDevice;
	label: string;
	/** Gate options of every apply of the session (from the start curve and its checklist). */
	experimental: boolean;
	profile: WriteProfile;
	/** Aborted when the session ends: an apply before report 8 stops there. */
	abort: AbortController;
	ended: LiveEndedReason | null;
	/** The first apply attempt settled (`starting` until then). */
	started: boolean;
	applied: LiveApplied | null;
	/** The newest edit not sent yet (one slot: newest wins). */
	pending: LiveCaptured | null;
	firstPendingEditMs: number;
	lastEditMs: number;
	/** The curve a hold stopped (what `confirmLive` sends). */
	held: LiveCaptured | null;
	hold: LiveHoldState | null;
	/** Whether what the cable plays is known (false after report 8 went out unconfirmed). */
	known: boolean;
	ackLevelDb: number | null;
	applies: number;
	lastError: unknown;
	/**
	 * The start checklist required and satisfied the experimental confirmation (or `confirmLive`
	 * confirmed it later): curves with HS/LP/HP or bands above 20 kHz may be applied.
	 */
	experimentalConfirmed: boolean;
	/** Consecutive busy attempts of the current apply (backoff; 0 when none). */
	busyAttempts: number;
	/** Releases the session lock `oa-cable-live` (S5); a no-op when none was taken. */
	releaseLock: () => void;
	/** `startLive` is still taking the session lock: nothing is applied yet. */
	gated: boolean;
	/** The newest edit queued while gated (it follows the start curve). */
	gatedEdit: LiveCaptured | null;
}

/** How one live apply attempt went, from inside (or instead of) the cross-tab lock. */
type LiveRun =
	| { kind: 'busy' }
	| { kind: 'skipped' }
	/** Another tab's in-flight write marker (live or recovered): the cable may have changed. */
	| { kind: 'foreign' }
	| { kind: 'refused'; cause: unknown }
	| { kind: 'done'; result: WriteResult };

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function refusalFromError(error: unknown): RefusalReason {
	if (error instanceof GateRejectedError) return 'gate';
	if (error instanceof ConcurrentWriteError) return 'busy';
	if (error instanceof DeviceUnusableError) return 'unusable';
	if (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'AbortError'
	) {
		return 'aborted';
	}
	return 'error';
}

function gateReasonsOf(error: unknown): Refused['gateReasons'] {
	if (!(error instanceof GateRejectedError)) return undefined;
	return error.reasons as Refused['gateReasons'];
}

export function createCableService(
	/** Freshness overrides (fetch, version, storage, now) are for tests; desktop ignores them. */
	deps: CableServiceDeps & { nativeFreshness?: NativeFreshnessDeps }
) {
	const detected = detectCableSupport() === 'real' ? navigatorHid() : null;
	const resolved = deps.hid === undefined ? detected : deps.hid;
	const mode: CableMode = resolved === null ? 'simulated' : 'real';
	const native = isNativeHid(resolved);
	const clock = deps.clock ?? systemClock;
	const events = new EventTarget();
	const listeners = new Set<(state: CableState) => void>();
	const nowMs = () => Math.floor(deps.now());

	let devices: CableDevice[] = [];
	let primary: CableDevice | null = null;
	let connection: ConnectionState = 'disconnected';
	let writing = false;
	let controller: AbortController | null = null;
	let queue: QueueState | null = null;
	let lastOutcome: WriteOutcome | null = null;
	let error: CableState['error'] = null;
	let rescue: RescueState | null = null;
	let disposed = false;

	// Cross-tab exclusion: the Web Lock, and the persisted in-flight marker.
	const locks = deps.locks === undefined ? browserLocks() : deps.locks;
	const inflight = deps.inflight === undefined ? browserInflight() : deps.inflight;
	const tabId = deps.tabId ?? randomTabId();
	/** The marker this instance persisted for the write in progress (real mode only). */
	let ownMarker: InflightMarker | null = null;
	/**
	 * The marker could not follow the X9 queue between two cables (`betweenCables`): the next
	 * cable is refused before any I/O. Cleared when the write ends (`unmark`).
	 */
	let markerAdrift = false;
	/** Raw markers this instance already turned into a journal entry (never block twice on one). */
	const recoveredMarkers = new Set<string>();
	let recheck: ReturnType<typeof setTimeout> | null = null;

	const lastJournal = deps.journal.last();
	// Restored from the journal: shown, but not announced as a new interruption (no `fresh`).
	if (mode === 'real' && lastJournal?.status === 'interrupted') {
		rescue = { at: lastJournal.at, deviceLabel: lastJournal.device, reportsSent: null };
	}

	// Simulated mode: an in-memory cable and flash bookkeeping that never touch the real ones.
	let simulatedFlash: FlashState = {
		day: { date: null, count: 0 },
		total: 0,
		lastWriteAt: Math.max(0, nowMs() - MIN_INTERVAL_MS),
		session: 0
	};
	let simulatedLevelDb: number | null = null;

	// Live (no-flash) preview. Times below are `clock.now()` (the transport's clock), not epoch.
	const livePolicy = deps.livePolicy ?? LIVE_APPLY_POLICY;
	/** The current (or last ended) live session. */
	let live: LiveSession | null = null;
	/** Successful live applies in this page, all sessions (memory only). */
	let liveTotal = 0;
	/** The live apply in flight (never rejects); null when none. */
	let liveInFlight: Promise<void> | null = null;
	/** The scheduler's pending wait, and the promise that settles after its handler ran. */
	let liveTimer: AbortController | null = null;
	let liveTimerDone: Promise<void> | null = null;
	/** After a busy lock: no new attempt before this time. */
	let liveNotBeforeMs: number | null = null;
	let lastApplyStartMs: number | null = null;
	/** End of the last write that sent (or may have sent) the commit: feeds LIVE_AFTER_COMMIT_MS. */
	let lastCommitMs: number | null = null;
	/** Writes in progress (`write()`): the scheduler never starts an apply meanwhile. */
	let liveSuspended = 0;
	/** The last curve this page committed to each cable (the default revert target). */
	const savedByDevice = new Map<CableDevice, SavedOnCable>();
	/**
	 * The shared flash state's `lastWriteAt` (epoch ms, touched at the end of every write
	 * sequence, any tab) converted once to the transport clock: the after-commit floor.
	 */
	let flashAnchor: { epoch: number; clock: number } | null = null;
	/** Live preview marker storage (S5; real mode only). */
	const liveStore =
		deps.liveMarker === undefined ? browserInflight(CABLE_LIVE_KEY) : deps.liveMarker;
	/** A live marker left by a tab that is gone (S5). */
	let liveOrphan: LiveOrphan | null = null;
	/** This tab holds the session lock `oa-cable-live`. */
	let liveLockHeld = false;
	/** Pending wait for the liveness lock of the tab named by another tab's live marker. */
	let liveWatch: { tabId: string; abort: AbortController } | null = null;
	/** Resolved at every emit (idle waiters re-check). */
	let emitted = deferred();

	const hid: HidLike = resolved ?? createSimulatedHid();

	function createSimulatedHid(): HidLike {
		const fake: FakeHID = new FakeHID({
			choose: (matching) => {
				const free = matching.find((device) => !devices.includes(device));
				if (free !== undefined) return [free];
				const device = new FakeHIDDevice({ productName: FAKE_PRODUCT_NAME });
				fake.addDevice(device);
				return [device];
			}
		});
		return fake;
	}

	// Flash anchors: an unknown (null) or future lastWriteAt is rebased once to the first
	// observation, so the 2 s wait is bounded and then expires (policy/flash.mjs).
	const anchors: { real: number | null; simulated: number | null } = {
		real: null,
		simulated: null
	};
	function flashView(source: 'real' | 'simulated', state: FlashState, now: number): FlashState {
		const observed = observeFlashState(state, now);
		if (observed.lastWriteAt === state.lastWriteAt) {
			anchors[source] = null;
			return observed;
		}
		const anchor = anchors[source];
		anchors[source] = anchor === null || anchor > now ? now : anchor;
		return { ...observed, lastWriteAt: anchors[source] };
	}

	/** The flash state the checklist sees (simulated: in memory; real: the shared store). */
	function currentFlash(now: number): FlashState {
		return mode === 'simulated'
			? flashView('simulated', simulatedFlash, now)
			: flashView('real', deps.flash.get(), now);
	}

	/** Modo YOLO session of this tab, read live (memory only; a throwing port counts as off). */
	function yoloSession(): boolean {
		try {
			return deps.yoloSession?.() === true;
		} catch {
			return false;
		}
	}

	/**
	 * `levelDb` of what an active live session is playing, when known (S7): the loudness
	 * comparison of a write then uses it instead of the last written level.
	 */
	function liveLevel(): Pick<ChecklistContext, 'liveLevelDb'> {
		const s = live;
		if (s === null || s.ended !== null || !s.known || s.applied === null) return {};
		// Only for the cable a write would go to: another target plays its saved curve.
		if (s.device !== primary || liveOrphan !== null) return {};
		return s.applied.levelDb === null ? {} : { liveLevelDb: s.applied.levelDb };
	}

	/**
	 * The last written level, or null (unknown) while another tab's orphan preview may be
	 * playing (S5): the loudness item then reports an unknown state.
	 */
	function writtenLevel(level: () => number | null): number | null {
		return liveOrphan === null ? level() : null;
	}

	function context(): ChecklistContext {
		const now = nowMs();
		if (mode === 'simulated') {
			return {
				nowMs: now,
				flash: currentFlash(now),
				lastWrittenLevelDb: writtenLevel(() => simulatedLevelDb),
				...liveLevel(),
				sessionWriteCount: simulatedFlash.session,
				lastJournalStatus: null,
				yoloSession: yoloSession()
			};
		}
		return {
			cableMode: native ? 'native' : mode,
			nowMs: now,
			flash: currentFlash(now),
			lastWrittenLevelDb: writtenLevel(() => deps.lastWrittenLevelDb()),
			...liveLevel(),
			sessionWriteCount: deps.sessionWriteCount(),
			lastJournalStatus: deps.journal.last()?.status ?? null,
			yoloSession: yoloSession()
		};
	}

	function labelOf(device: CableDevice): string {
		const name = device.productName || PRODUCT_NAME;
		const base = name + (mode === 'simulated' ? SIMULATED_LABEL_SUFFIX : '');
		const index = devices.filter((d) => (d.productName || PRODUCT_NAME) === name).indexOf(device);
		return index > 0 ? `${base} #${index + 1}` : base;
	}

	function snapshotState(): CableState {
		return {
			mode,
			connection,
			device: primary,
			deviceLabel: primary === null ? null : labelOf(primary),
			devices: devices.slice(),
			deviceLabels: devices.map(labelOf),
			writing,
			rescue,
			queue:
				queue === null
					? null
					: { running: queue.running, items: queue.items.map((item) => ({ ...item })) },
			lastOutcome,
			error,
			liveCapable: liveCapable(),
			live: liveView(),
			liveOrphan: liveOrphan === null ? null : { ...liveOrphan }
		};
	}

	/**
	 * Live preview switch and transport support: WebHID and simulated mode always, the native
	 * transport only when the app announced `liveApply` (`deps.nativeLiveApply`).
	 */
	function liveCapable(): boolean {
		if (livePolicy.enabled !== true) return false;
		// A real cable needs Web Locks: the session lock is what keeps other tabs out (S5).
		if (mode === 'real' && locks === null) return false;
		// `nativeLiveApply` comes from `detectNativeCable()` → `liveApply` (`mountNativeCable`).
		return native ? deps.nativeLiveApply === true : true;
	}

	function liveStatusOf(s: LiveSession): LiveStatus {
		if (s.ended !== null) return 'ended';
		if (!s.known) return 'unknown';
		if (s.hold !== null) return 'held';
		// A busy write lock retried with backoff stays "applying" (no flicker between attempts).
		if (liveInFlight !== null || s.busyAttempts > 0) return s.started ? 'applying' : 'starting';
		return s.started ? 'live' : 'starting';
	}

	function liveView(): LiveState | null {
		const s = live;
		if (s === null) return null;
		const hold: LiveHoldState | null =
			s.hold === null
				? null
				: {
						...s.hold,
						...(s.hold.gateReasons === undefined ? {} : { gateReasons: [...s.hold.gateReasons] })
					};
		return {
			deviceLabel: s.label,
			status: liveStatusOf(s),
			applied: s.applied === null ? null : { ...s.applied, bands: copyBands(s.applied.bands) },
			pending: s.pending !== null || s.gatedEdit !== null,
			ackLevelDb: s.ackLevelDb,
			hold,
			applies: s.applies,
			total: liveTotal,
			lastError: s.lastError,
			...(s.ended === null ? {} : { endedReason: s.ended }),
			savedCrc: savedCrcOf(s)
		};
	}

	function emit() {
		const woken = emitted;
		emitted = deferred();
		woken.resolve();
		if (disposed) return;
		const state = snapshotState();
		for (const listener of listeners) listener(state);
		events.dispatchEvent(new CustomEvent(CABLE_STATUS_EVENT, { detail: state }));
	}

	/**
	 * Adds a device without choosing it as the write target. Only `connect()` (the user picked
	 * it) and `selectDevice()` choose explicitly; otherwise a target is implied only when it is
	 * the single connected cable, which the checklist shows next to the write button.
	 */
	function addDevice(device: CableDevice) {
		if (!devices.includes(device)) devices.push(device);
		connection = 'connected';
	}

	/**
	 * With no explicit target, the single connected cable is the (visible) target. Only after a
	 * restore or a connect, never after a removal.
	 */
	function implyTarget() {
		if (primary === null && devices.length === 1) primary = devices[0] ?? null;
	}

	function removeDevice(device: CableDevice) {
		devices = devices.filter((candidate) => candidate !== device);
		// Never switch silently to another cable (even a single remaining one, whose label would
		// replace the target's in an open checklist): the user must choose again.
		if (primary === device) primary = null;
		connection = devices.length > 0 ? 'connected' : 'disconnected';
	}

	function onConnect(event: Event) {
		const device = deviceOf(event);
		if (!isCableDevice(device)) return;
		addDevice(device);
		implyTarget();
		// Plugged in (again): its RAM was lost while unplugged, so it plays its saved curve. A
		// preview marker naming it (an orphan's, maybe unplugged while no tab watched) is moot (S5).
		cableBackToSaved(labelOf(device));
		emit();
	}

	function onDisconnect(event: Event) {
		const device = deviceOf(event);
		// Unplugged: the cable lost its RAM and plays the saved (committed) curve again. The
		// session ends; nothing is re-applied when it comes back.
		const s = live;
		let changed = false;
		if (s !== null && s.device === device) {
			if (s.ended === null) {
				endLive(s, 'disconnected');
			} else if (s.ended === 'stopped' || s.ended === 'forgotten') {
				// An ended session whose curve the cable kept: back on the saved curve now.
				s.ended = 'disconnected';
				changed = true;
			}
			// The preview marker of that cable (this tab's, or an orphan's) is moot now (S5).
			cableBackToSaved(s.label);
		}
		if (devices.includes(device as CableDevice)) cableBackToSaved(labelOf(device as CableDevice));
		if (!devices.includes(device as CableDevice)) {
			if (changed) emit();
			return;
		}
		removeDevice(device as CableDevice);
		emit();
	}

	// --- In-flight marker -------------------------------------------------------------------

	/**
	 * Turns a marker left by a tab that is gone into an `interrupted` journal entry (and the
	 * rescue state), then removes it. Does nothing if the stored marker changed meanwhile.
	 * A `between` marker (X9 queue, between two cables) names no cable being written: it is
	 * only removed. Returns whether an interruption was recorded.
	 */
	function recoverMarker(raw: string, marker: InflightMarker | null): boolean {
		if (inflight === null || inflight.read() !== raw) return false;
		recoveredMarkers.add(raw);
		if (marker?.between === true) {
			if (!inflight.write(null)) console.warn('cable in-flight marker could not be removed');
			return false;
		}
		if (marker !== null) {
			const entry: JournalEntry = {
				schema: 1,
				at: marker.at,
				name: truncate(marker.name, 48),
				crc: marker.crc,
				preampDb: marker.preampDb,
				bands: copyBands(marker.bands),
				status: 'interrupted',
				device: truncate(marker.device, 64),
				// An interrupted Modo YOLO write stays marked, with the codes it waived (a marker
				// without a profile is a standard write, or one persisted before markers had one).
				...(marker.profile === 'yolo'
					? {
							profile: 'yolo' as const,
							...(marker.waived === undefined ? {} : { waived: [...marker.waived] })
						}
					: {}),
				// A marker without it (desktop, or persisted before it existed) journals none.
				...journalFreshness(marker.freshness ?? null)
			};
			try {
				deps.journal.append(entry);
			} catch (cause) {
				error = 'journal-failed';
				console.error('cable journal append failed (interrupted write)', cause);
			}
		}
		if (!inflight.write(null)) console.warn('cable in-flight marker could not be removed');
		if (mode === 'real') {
			rescue = {
				at: marker?.at ?? nowMs(),
				deviceLabel: marker?.device ?? null,
				reportsSent: null,
				fresh: true
			};
		}
		emit();
		return true;
	}

	/** Whether another context holds the write lock; null when it cannot be known. */
	async function lockHeld(): Promise<boolean | null> {
		if (locks === null || typeof locks.query !== 'function') return null;
		try {
			const snapshot = await locks.query();
			return (snapshot.held ?? []).some((lock) => lock.name === CABLE_WRITE_LOCK);
		} catch (cause) {
			console.warn('cable lock query failed', cause);
			return null;
		}
	}

	/** On load: a marker whose writer is gone (lock free, or too old) becomes `interrupted`. */
	async function recoverStaleMarker(): Promise<void> {
		if (inflight === null) return;
		const raw = inflight.read();
		if (raw === null || recoveredMarkers.has(raw)) return;
		const marker = parseInflightMarker(raw);
		if (marker !== null && marker.tabId === tabId) return;
		const held = await lockHeld();
		if (disposed) return;
		if (held === true) {
			// A live writer: wait for its tab, so its death mid-write surfaces here too. An
			// unreadable marker names no tab to wait for: the next write (holding the write
			// lock) or the next load with the lock free recovers it.
			if (marker !== null) watchWriter();
			return;
		}
		if (held === null && marker !== null) {
			const age = nowMs() - marker.at;
			if (Math.abs(age) <= INFLIGHT_STALE_MS) {
				// Maybe a live tab without Web Locks: look again once the marker is stale.
				recheck ??= setTimeout(
					() => {
						recheck = null;
						void recover();
					},
					Math.max(1, INFLIGHT_STALE_MS - age + 1)
				);
				return;
			}
		}
		recoverMarker(raw, marker);
	}

	function recover(): Promise<void> {
		return recoverStaleMarker().catch((cause: unknown) => {
			console.error('cable in-flight marker recovery failed', cause);
		});
	}

	/** The stored marker when it belongs to another tab and was not recovered yet. */
	function foreignMarker(): { raw: string; marker: InflightMarker | null } | null {
		if (inflight === null) return null;
		const raw = inflight.read();
		if (raw === null || recoveredMarkers.has(raw)) return null;
		const marker = parseInflightMarker(raw);
		if (marker !== null && marker.tabId === tabId) return null;
		return { raw, marker };
	}

	/**
	 * Pending wait for the liveness lock of the tab named by the stored marker (at most one);
	 * aborted when the marker goes away or names another tab, and on dispose.
	 */
	let watching: { tabId: string; abort: AbortController } | null = null;

	function unwatch() {
		watching?.abort.abort(new DOMException('cable writer wait stopped', 'AbortError'));
		watching = null;
	}

	/**
	 * Another tab's marker is present: wait for that tab's liveness lock (no `ifAvailable`),
	 * never for the write lock, so a waiting tab can neither hold nor delay a write. The writer
	 * holds its liveness lock from before its first marker until it is disposed or dies, and
	 * removes its marker before releasing the write lock: its own marker still there once the
	 * liveness lock is granted, with the write lock free, means it died mid-write. That is
	 * recorded (journal + rescue notice) here, without waiting for a reload. This only records.
	 */
	function watchWriter() {
		if (disposed) return;
		const found = foreignMarker();
		const writer = found?.marker?.tabId ?? null;
		if (watching !== null && watching.tabId === writer) return;
		// The marker is gone or names another tab: the previous wait is moot.
		unwatch();
		if (found === null) return;
		if (locks === null || writer === null) {
			// No Web Locks, or an unreadable marker naming no tab: the load-time recovery (write
			// lock free, or the age-based recheck) is all there is.
			void recover();
			return;
		}
		const abort = new AbortController();
		const current = { tabId: writer, abort };
		watching = current;
		void locks
			.request(cableAliveLock(writer), { signal: abort.signal }, async () => {
				if (disposed) return;
				// Write lock still held: the writer is alive after all (e.g. a version without a
				// liveness lock), or the next writer records it under the lock (crossTabGuard).
				if ((await lockHeld()) === true || disposed) return;
				const left = foreignMarker();
				if (left !== null && left.marker?.tabId === writer) recoverMarker(left.raw, left.marker);
			})
			.catch((cause: unknown) => {
				if (!abort.signal.aborted) console.warn('cable writer liveness wait failed', cause);
			})
			.finally(() => {
				if (watching === current) watching = null;
			});
	}

	/**
	 * Inside the write lock: refuses while another tab's marker is live. A marker from a tab
	 * that is gone is recovered (journal + rescue) and this attempt is refused with
	 * `interrupted-elsewhere`, so the user sees the interruption before any new byte is sent.
	 */
	function crossTabGuard(): Refused | null {
		const found = foreignMarker();
		if (found === null) return null;
		const { raw, marker } = found;
		const fresh = marker !== null && Math.abs(nowMs() - marker.at) <= INFLIGHT_STALE_MS;
		// Without Web Locks a fresh marker means another tab may be writing right now.
		if (locks === null && fresh) return refuse('busy');
		// A dead queue between two cables interrupted nothing: it is just cleared.
		if (!recoverMarker(raw, marker)) return null;
		return refuse('interrupted-elsewhere');
	}

	/** Persists the marker before any I/O (real mode). False: refuse, nothing is sent. */
	function mark(authorized: Authorized, label: string): boolean {
		if (mode === 'simulated' || inflight === null) return true;
		const marker: InflightMarker = {
			at: nowMs(),
			crc: authorized.crc,
			name: authorized.name,
			preampDb: authorized.preampDb,
			bands: copyBands(authorized.snapshot),
			device: truncate(label, 64),
			tabId,
			// Modo YOLO: what the journal entry would carry, so a recovered interruption keeps it.
			...(authorized.profile === 'yolo'
				? { profile: 'yolo' as const, waived: [...authorized.checklist.waived] }
				: {}),
			// Likewise the native deploy check that cleared the write.
			...journalFreshness(authorized.freshness)
		};
		ownMarker = marker;
		if (inflight.write(JSON.stringify(marker))) return true;
		console.warn('cable in-flight marker could not be persisted');
		// Without Web Locks the marker is the only cross-tab guard: never write unguarded.
		return locks !== null;
	}

	/** Removes this instance's marker (never another tab's). Runs in `finally` of every write. */
	function unmark() {
		markerAdrift = false;
		if (ownMarker === null) return;
		ownMarker = null;
		if (inflight === null) return;
		const raw = inflight.read();
		if (raw === null) return;
		const stored = parseInflightMarker(raw);
		if (stored !== null && stored.tabId !== tabId) return;
		if (!inflight.write(null)) console.warn('cable in-flight marker could not be removed');
	}

	/**
	 * A device sequence is about to send its first byte (gates passed, device locked): point
	 * the marker at this device and count the flash attempt now, so a tab closed mid-write
	 * still leaves both recorded. If the marker cannot be pointed at this device, the stored
	 * one would misdescribe the write (a `between` marker is recovered as "nothing was being
	 * written"): it is removed if possible and this throws, so the transport refuses the
	 * sequence before any I/O. Pre-I/O refusals are not counted. A marker that could not follow
	 * the queue from the previous cable (`betweenCables`) refuses the sequence the same way.
	 */
	function sequenceStarting(label: string) {
		const at = nowMs();
		if (mode === 'simulated') {
			simulatedFlash = recordWrite(simulatedFlash, at);
			return;
		}
		if (markerAdrift) {
			throw new Error('cable in-flight marker could not follow the queue; nothing was sent');
		}
		const device = truncate(label, 64);
		if (
			ownMarker !== null &&
			inflight !== null &&
			(ownMarker.device !== device || ownMarker.between === true)
		) {
			const next: InflightMarker = { ...ownMarker, at, device };
			delete next.between;
			ownMarker = next;
			if (!inflight.write(JSON.stringify(next))) {
				console.warn('cable in-flight marker could not be updated');
				if (!inflight.write(null)) console.warn('cable in-flight marker could not be removed');
				throw new Error('cable in-flight marker could not be updated; nothing was sent');
			}
		}
		// Counted per attempt that reaches the cable (conservative for wear and spacing).
		deps.flash.record(at);
	}

	/**
	 * X9 queue: the cable `label` committed and is journaled; the next one has not started. The
	 * marker stops naming a cable being written, so a tab closed during the 2 s spacing leaves
	 * nothing to recover as interrupted (it still marks a write in progress for other tabs).
	 * If that update fails, the stored marker would still name the committed cable as being
	 * written, so it is removed instead (the write lock still keeps other tabs out). The next
	 * cable is then refused before any I/O when the marker could not be removed either (it
	 * misdescribes the queue), or without Web Locks (the marker was the only cross-tab guard,
	 * and the spacing went unguarded). Never throws: it runs inside writeMany's spacing.
	 */
	function betweenCables(label: string) {
		if (ownMarker === null || inflight === null) return;
		ownMarker = { ...ownMarker, at: nowMs(), device: truncate(label, 64), between: true };
		if (inflight.write(JSON.stringify(ownMarker))) return;
		console.warn('cable in-flight marker could not be updated');
		if (!inflight.write(null)) {
			console.warn('cable in-flight marker could not be removed');
			markerAdrift = true;
		} else if (locks === null) {
			markerAdrift = true;
		}
	}

	/**
	 * A device sequence that started I/O just ended (ok, interrupted or a late throw): the cable
	 * was last touched now, so the 2 s spacing restarts from here. Counters are not incremented
	 * again. Never throws (it runs in the transport's `finally`; the result must not be lost).
	 */
	function sequenceEnded() {
		const at = nowMs();
		if (mode === 'simulated') {
			const last = simulatedFlash.lastWriteAt;
			if (last === null || last < at) simulatedFlash = { ...simulatedFlash, lastWriteAt: at };
			return;
		}
		try {
			deps.flash.touch(at);
		} catch (cause) {
			console.error('cable flash end-of-write bookkeeping failed', cause);
		}
	}

	/** Whether this tab holds its liveness lock right now. */
	let aliveHeld = false;
	/** The pending request for it: settles true once granted, false when it could not be taken. */
	let alive: Promise<boolean> | null = null;
	/** Releases the liveness lock (set once it is granted). */
	let releaseAlive: (() => void) | null = null;

	/**
	 * Takes this tab's liveness lock (`ifAvailable`, once) and holds it until dispose, so a
	 * marker naming this tab only ever exists while other tabs can wait on it. Called inside the
	 * write lock, before the marker. `true` at once when it is held (or not needed: no marker
	 * is written), otherwise whether it could be taken.
	 */
	function holdAlive(forLive = false): true | Promise<boolean> {
		if (mode === 'simulated' || locks === null || aliveHeld) return true;
		// Needed only when a marker naming this tab may be written (a write's or a live one).
		if ((forLive ? liveStore : inflight) === null) return true;
		if (disposed) return Promise.resolve(false);
		if (alive === null) {
			const manager = locks;
			const pending = new Promise<boolean>((settle) => {
				void manager
					.request(cableAliveLock(tabId), { ifAvailable: true }, (lock) => {
						if (lock === null || disposed) {
							settle(false);
							return Promise.resolve();
						}
						aliveHeld = true;
						settle(true);
						return new Promise<void>((resolve) => {
							releaseAlive = resolve;
						});
					})
					.catch((cause: unknown) => {
						console.warn('cable liveness lock failed', cause);
						settle(false);
					});
			});
			alive = pending;
			// Not taken: a later write asks again.
			void pending.then((held) => {
				if (!held && alive === pending) alive = null;
			});
		}
		// A lock manager that grants at once needs no wait: the marker follows in this task.
		return aliveHeld ? true : alive;
	}

	/**
	 * Runs `run` holding the cross-tab lock; refuses `busy` when another tab holds it, and
	 * `error` when this tab's liveness lock cannot be held. The marker is removed before the
	 * lock is released, so "marker present and lock free" always means the writing tab is gone.
	 */
	async function exclusive<T extends WriteOutcome | QueueOutcome>(
		run: (freshness: NativeWriteFreshness | null) => Promise<T | Refused>
	): Promise<T | Refused> {
		const guarded = async (): Promise<T | Refused> => {
			try {
				// Null for desktop and simulated writes, which never check the deployed policy.
				let freshness: NativeWriteFreshness | null = null;
				if (native) {
					try {
						freshness = await assertNativeWriteFresh(deps.nativeFreshness);
					} catch (cause) {
						return refuse('error', { error: cause });
					}
				}
				return await run(freshness);
			} finally {
				unmark();
			}
		};
		if (locks === null) return guarded();
		return locks.request(CABLE_WRITE_LOCK, { ifAvailable: true }, async (lock) => {
			if (lock === null) return refuse('busy');
			const taken = holdAlive();
			if (taken !== true && !(await taken)) return refuse('error');
			// S5: another tab plays a live preview on its cable; nothing is written meanwhile.
			// Checked after the liveness lock and before any marker, flash count or byte.
			const elsewhere = liveElsewhere();
			if (elsewhere === true || (elsewhere !== false && (await elsewhere))) {
				return refuse('live-elsewhere');
			}
			return guarded();
		});
	}

	hid.addEventListener('connect', onConnect);
	hid.addEventListener('disconnect', onDisconnect);

	/** Reads every checklist field of `request` exactly once (getters/Proxies cannot change mid-way). */
	function input(request: ChecklistInput): ChecklistInput {
		const bands = request.bands;
		const preampDb = request.preampDb;
		const experimental = request.experimental === true;
		const confirmations: Partial<ChecklistInput['confirmations']> | undefined =
			request.confirmations;
		const volumeLowered = confirmations?.volumeLowered === true;
		const keepConnected = confirmations?.keepConnected === true;
		const experimentalConfirmed = confirmations?.experimental === true;
		// Transport-owned context cannot be overridden by a write request. Capture once, just
		// like the other confirmations, and leave desktop/simulated requests unchanged.
		const androidConfirmation = native
			? { androidUntested: confirmations?.androidUntested === true }
			: {};
		// Read once, compared without coercion: only the exact string selects YOLO.
		const profile: unknown = request.profile;
		if (profile !== 'yolo') {
			return {
				bands,
				preampDb,
				experimental,
				confirmations: {
					volumeLowered,
					keepConnected,
					experimental: experimentalConfirmed,
					...androidConfirmation
				}
			};
		}
		const yoloWrite = confirmations?.yoloWrite === true;
		return {
			bands,
			preampDb,
			experimental,
			profile: 'yolo',
			confirmations: {
				volumeLowered,
				keepConnected,
				experimental: experimentalConfirmed,
				yoloWrite,
				...androidConfirmation
			}
		};
	}

	/** Gate options of a captured input (the profile only when it is YOLO). */
	function gateOptions(captured: ChecklistInput) {
		return captured.profile === 'yolo'
			? { experimental: captured.experimental, profile: 'yolo' as const }
			: { experimental: captured.experimental };
	}

	function refuse(reason: RefusalReason, extra: Omit<Refused, 'status' | 'reason'> = {}): Refused {
		const outcome: Refused = { status: 'refused', reason, ...extra };
		lastOutcome = outcome;
		emit();
		return outcome;
	}

	/**
	 * First, synchronous phase of every write path (in the caller's task). Spends the gesture,
	 * reads the request exactly once, gates that snapshot and evaluates the checklist. The
	 * captured values and the gate verdict are all that later phases use. Or a refusal.
	 */
	function prepare(request: WriteRequest): Prepared | Refused {
		// The token is spent first, whatever happens next: a refused attempt cannot be replayed.
		const gesture = request.gesture;
		if (!consumeGestureToken(gesture, nowMs())) return refuse('gesture');
		if (writing) return refuse('busy');
		const captured = input(request);
		const rawName: unknown = request.name;
		const verdict = gateForWrite(captured.bands, captured.preampDb, gateOptions(captured));
		const checklist = evaluateChecklist(captured, context(), verdict);
		if (!checklist.canWrite || checklist.snapshot === null || checklist.crc === null) {
			return refuse('checklist', { checklist });
		}
		return {
			captured,
			verdict,
			checklist,
			name: truncate(typeof rawName === 'string' ? rawName : '', 48)
		};
	}

	/**
	 * Second phase, holding the cross-tab lock: the checklist again on the same gate verdict
	 * with fresh flash/journal state (another tab may have written meanwhile). `freshness`: the
	 * native deploy check that cleared this write (null for desktop and simulated writes).
	 */
	function authorize(
		prepared: Prepared,
		freshness: NativeWriteFreshness | null
	): Authorized | Refused {
		deps.flash.sync?.(nowMs());
		const checklist = evaluateChecklist(prepared.captured, context(), prepared.verdict);
		if (!checklist.canWrite || checklist.snapshot === null || checklist.crc === null) {
			return refuse('checklist', { checklist });
		}
		return {
			checklist,
			snapshot: checklist.snapshot,
			preampDb: prepared.captured.preampDb,
			experimental: prepared.captured.experimental,
			profile: prepared.captured.profile === 'yolo' ? 'yolo' : 'standard',
			name: prepared.name,
			crc: checklist.crc,
			freshness
		};
	}

	/** Marks this tab as writing (blocks selection, disconnect and other writes; abortable). */
	function reserve(): AbortController {
		const abort = new AbortController();
		writing = true;
		controller = abort;
		emit();
		return abort;
	}

	/** Ends a write attempt on every path (refusal, throw, abort, interruption, success). */
	function release() {
		unmark();
		writing = false;
		controller = null;
		emit();
	}

	/**
	 * Journal, rescue and events for one device sequence that started I/O (its flash attempt
	 * was already recorded by `sequenceStarting`, before the first byte). `committed`: the
	 * sequence ended `ok`; otherwise it was interrupted after `reportsSent` data reports.
	 */
	function journalSequence(
		committed: boolean,
		crc: number,
		reportsSent: number | null,
		label: string,
		authorized: Authorized
	): { status: Written['status']; entry: JournalEntry | null } {
		const { checklist, snapshot, preampDb, name, profile, freshness } = authorized;
		const yolo = profile === 'yolo';
		const simulated = mode === 'simulated';
		const at = nowMs();
		const status: Written['status'] & JournalStatus = committed
			? simulated
				? 'simulated'
				: 'ok'
			: 'interrupted';
		let entry: JournalEntry | null = null;
		if (!simulated || committed) {
			entry = {
				schema: 1,
				at,
				name,
				crc,
				preampDb,
				bands: copyBands(snapshot),
				status,
				device: truncate(label, 64),
				// Modo YOLO: the entry is marked, with the class-2 codes the write waived.
				...(yolo ? { profile: 'yolo' as const, waived: [...checklist.waived] } : {}),
				// Android app: whether a live check or the last-good record cleared the write.
				...journalFreshness(freshness)
			};
			try {
				deps.journal.append(entry);
			} catch (cause) {
				error = 'journal-failed';
				console.error('cable journal append failed', cause);
			}
		}
		if (simulated) {
			if (committed) simulatedLevelDb = checklist.newLevelDb;
		} else if (committed) {
			rescue = null;
		} else {
			rescue = { at, deviceLabel: label, reportsSent, fresh: true };
		}
		// Only a real, committed write dispatches the written event (simulated and interrupted
		// writes never do). Every one, YOLO ones too, is the cable's new written snapshot (the app
		// marks it). A YOLO write is marked like its journal entry: `profile: 'yolo'` with the
		// class-2 codes it waived, so a listener can tell it apart (the outbox counts the install,
		// YOLO publication option B); the curve's class is derived again wherever it goes.
		if (!simulated && committed && entry !== null) {
			const detail: CableWrittenDetail = {
				entry,
				crc,
				preampDb,
				bands: copyBands(snapshot),
				deviceLabel: label,
				at,
				levelDb: checklist.newLevelDb,
				...(yolo ? { profile: 'yolo' as const, waived: [...checklist.waived] } : {})
			};
			events.dispatchEvent(new CustomEvent(CABLE_WRITTEN_EVENT, { detail }));
		}
		return { status, entry };
	}

	/** `journalSequence` for a finished `writeCurve` result. */
	function settle(result: WriteResult, label: string, authorized: Authorized): Written {
		const committed = result.status === 'ok';
		const { status, entry } = journalSequence(
			committed,
			result.crc,
			result.reportsSent,
			label,
			authorized
		);
		return {
			status,
			simulated: mode === 'simulated',
			result,
			entry,
			deviceLabel: label,
			crc: result.crc,
			levelDb: authorized.checklist.newLevelDb
		};
	}

	// --- Live (no-flash) preview ---------------------------------------------------------------
	//
	// A live apply sends the 9 data reports (`applyCurve`), never the commit: nothing reaches
	// the flash, so it is not a write. It records no flash attempt (not through `observedHid`),
	// no journal entry, no `cable:written` and no in-flight marker; it does take the cross-tab
	// write lock (`ifAvailable`) and the page's write flag, and the transport gates it again.
	// It is never retried after it started I/O; a busy lock (nothing sent) keeps the curve
	// pending and the scheduler tries again with backoff, without a hold, up to
	// LIVE_BUSY_MAX_ATTEMPTS (then the edit is dropped with `lastError: 'busy'`).
	//
	// Across tabs (S5): a session holds `oa-cable-live` (one session per origin; other tabs'
	// writes refuse `live-elsewhere`), and the `oa.cable.live` marker names the cable while it may
	// play a curve other than the saved one, so a reload can report an orphan preview.

	function liveRefuse(
		reason: LiveRefusalReason,
		extra: Omit<LiveRefused, 'status' | 'reason'> = {}
	): LiveRefused {
		return { status: 'refused', reason, ...extra };
	}

	function activeLive(): LiveSession | null {
		const s = live;
		return s !== null && s.ended === null && !disposed ? s : null;
	}

	function liveGateOptions(s: LiveSession) {
		return s.profile === 'yolo'
			? { experimental: s.experimental, profile: 'yolo' as const }
			: { experimental: s.experimental };
	}

	/** Captures a curve from a gate verdict (the session's options) and its preamp. */
	function capturedOf(
		verdict: GateResult,
		preampDb: number,
		confirmed: boolean,
		revert = false
	): LiveCaptured {
		const snapshot = verdict.metrics.bands ?? null;
		const crc =
			verdict.metrics.payloadCrc === undefined ? null : Number(verdict.metrics.payloadCrc);
		const signal = deferred();
		let finished = false;
		let experimentalRequired = false;
		if (snapshot !== null) {
			try {
				experimentalRequired = hasExperimentalKinds(snapshot) || hasUltrasonicBands(snapshot);
			} catch {
				// Unreadable bands: be conservative (the gate refuses them anyway).
				experimentalRequired = true;
			}
		}
		return {
			verdict,
			snapshot,
			preampDb,
			crc: crc !== null && Number.isInteger(crc) ? crc : null,
			levelDb: snapshot === null ? null : writtenLevelDb({ bands: copyBands(snapshot), preampDb }),
			confirmed,
			experimentalRequired,
			revert,
			busy: false,
			settled: signal.promise,
			done() {
				if (finished) return;
				finished = true;
				signal.resolve();
			}
		};
	}

	/** Reads `bands` and `preampDb` once and gates them with the session's options. */
	function captureLive(
		s: LiveSession,
		bands: readonly Band[],
		preampDb: number,
		confirmed: boolean,
		revert = false
	): LiveCaptured {
		return capturedOf(
			gateForWrite(bands, preampDb, liveGateOptions(s)),
			preampDb,
			confirmed,
			revert
		);
	}

	/** The same curve with a fresh settle signal. */
	function recaptured(curve: LiveCaptured, confirmed: boolean): LiveCaptured {
		return capturedOf(curve.verdict, curve.preampDb, confirmed, curve.revert);
	}

	function cancelLiveTimer() {
		const timer = liveTimer;
		liveTimer = null;
		liveTimerDone = null;
		timer?.abort(new DOMException('live wait cancelled', 'AbortError'));
	}

	/** Puts `curve` in the single pending slot (newest wins; the replaced one is settled). */
	function enqueueLive(s: LiveSession, curve: LiveCaptured) {
		const now = clock.now();
		const previous = s.pending;
		if (previous === null) s.firstPendingEditMs = now;
		s.pending = coalesce(previous, curve);
		s.lastEditMs = Math.max(now, s.firstPendingEditMs);
		if (previous !== null && previous !== s.pending) previous.done();
		// A confirmed curve skips the debounce: a wait already running may be too long.
		if (curve.confirmed) cancelLiveTimer();
	}

	/** Stops `curve` behind `hold` (no I/O); a newer pending edit, if any, is held instead. */
	function holdLive(s: LiveSession, curve: LiveCaptured, hold: LiveHoldState) {
		const newest = s.pending ?? curve;
		if (newest !== curve) curve.done();
		s.pending = null;
		if (s.held !== null && s.held !== newest) s.held.done();
		s.held = newest;
		s.hold = hold;
		newest.done();
	}

	/** Releases a hold without sending (a newer edit is evaluated again, or a save happened). */
	function clearHold(s: LiveSession): LiveCaptured | null {
		const held = s.held;
		s.held = null;
		s.hold = null;
		held?.done();
		return held;
	}

	function endLive(s: LiveSession, reason: LiveEndedReason, announce = true) {
		if (s.ended !== null) return;
		s.ended = reason;
		s.abort.abort(new DOMException('live session ended', 'AbortError'));
		if (live === s) {
			cancelLiveTimer();
			liveNotBeforeMs = null;
		}
		s.busyAttempts = 0;
		s.pending?.done();
		s.pending = null;
		s.gatedEdit?.done();
		s.gatedEdit = null;
		clearHold(s);
		// Other tabs may start a session (and write) again (S5).
		s.releaseLock();
		if (announce) emit();
	}

	/** A session that never got going (no session lock, busy): as if it never started. */
	function abandonLive(s: LiveSession, previous: LiveSession | null) {
		endLive(s, 'stopped', false);
		if (live === s) live = previous;
		emit();
	}

	/**
	 * The loudness hold of a curve that passes the gate and is ≥ 3 dB above the level the user
	 * confirmed (`liveHold`, the cable state taken as known); null otherwise (also when either
	 * level is unknown). A revert curve is flagged as the saved curve.
	 */
	function loudnessHold(s: LiveSession, curve: LiveCaptured): LiveHoldState | null {
		if (!curve.verdict.ok || curve.levelDb === null) return null;
		const hold = liveHold({ levelDb: curve.levelDb, ackLevelDb: s.ackLevelDb, state: 'known' });
		if (hold === null || hold.reason !== 'loudness') return null;
		return {
			reason: 'loudness',
			deltaDb: hold.deltaDb,
			...(curve.revert ? { curve: 'saved' as const } : {})
		};
	}

	/** Holds `curve` behind `unknown-state` when what the cable plays is not known (and no hold is set). */
	function reholdIfUnknown(s: LiveSession, curve: LiveCaptured) {
		if (!s.known && s.hold === null && s.ended === null) {
			holdLive(s, curve, { reason: 'unknown-state' });
		}
	}

	// --- Live preview across tabs (S5) ----------------------------------------------------------

	/**
	 * The transport clock's time of the shared flash state's last write end (epoch
	 * `lastWriteAt`, touched by every write sequence of any tab), converted once per value.
	 */
	function flashCommitAnchor(now: number): number | null {
		let epoch: unknown;
		try {
			epoch = (mode === 'simulated' ? simulatedFlash : deps.flash.get()).lastWriteAt;
		} catch (cause) {
			console.warn('cable flash state unreadable for live pacing', cause);
			return null;
		}
		if (!finite(epoch)) return null;
		if (flashAnchor !== null && flashAnchor.epoch === epoch) return flashAnchor.clock;
		const anchor = now - Math.max(0, nowMs() - epoch);
		flashAnchor = { epoch, clock: anchor };
		return anchor;
	}

	/** `clock.now()`, or null when the injected clock throws. */
	function clockNow(): number | null {
		try {
			return clock.now();
		} catch (cause) {
			console.error('cable clock failed', cause);
			return null;
		}
	}

	/** Persists the live marker before an apply of `crc` that differs from the saved curve. */
	function writeLiveMarker(s: LiveSession, crc: number) {
		if (mode !== 'real' || liveStore === null) return;
		const marker: LiveMarker = { tabId, device: truncate(s.label, 64), crc, at: nowMs() };
		if (!liveStore.write(JSON.stringify(marker))) {
			console.warn('cable live marker could not be persisted');
		}
	}

	/**
	 * The cable `label` plays its saved curve again (unplugged, reverted or committed): its live
	 * marker (this tab's or an orphan's) is removed and a matching orphan notice cleared.
	 */
	function cableBackToSaved(label: string) {
		const device = truncate(label, 64);
		if (liveStore !== null) {
			const raw = liveStore.read();
			const marker = raw === null ? null : parseLiveMarker(raw);
			if (marker !== null && marker.device === device && !liveStore.write(null)) {
				console.warn('cable live marker could not be removed');
			}
		}
		if (liveOrphan !== null && liveOrphan.deviceLabel === device) {
			liveOrphan = null;
			emit();
		}
	}

	function unwatchLive() {
		liveWatch?.abort.abort(new DOMException('cable live owner wait stopped', 'AbortError'));
		liveWatch = null;
	}

	/** The stored live marker of `owner` is still there and its tab is gone: an orphan preview. */
	function adoptOrphan(owner: string) {
		if (disposed || liveStore === null) return;
		const raw = liveStore.read();
		const marker = raw === null ? null : parseLiveMarker(raw);
		if (marker === null || marker.tabId !== owner || marker.tabId === tabId) return;
		liveOrphan = { crc: marker.crc, at: marker.at, deviceLabel: marker.device };
		emit();
	}

	/**
	 * Another tab's live marker: wait for that tab's liveness lock (granted once it is gone),
	 * then report the orphan preview. Only records; never touches the cable.
	 */
	function watchLiveMarker() {
		if (disposed || mode !== 'real' || liveStore === null || locks === null) return;
		const raw = liveStore.read();
		const marker = raw === null ? null : parseLiveMarker(raw);
		if (marker === null || marker.tabId === tabId) {
			unwatchLive();
			if (raw === null && liveOrphan !== null) {
				liveOrphan = null;
				emit();
			}
			return;
		}
		if (liveWatch !== null && liveWatch.tabId === marker.tabId) return;
		unwatchLive();
		const abort = new AbortController();
		const current = { tabId: marker.tabId, abort };
		liveWatch = current;
		void locks
			.request(cableAliveLock(marker.tabId), { signal: abort.signal }, () => {
				adoptOrphan(marker.tabId);
				return Promise.resolve();
			})
			.catch((cause: unknown) => {
				if (!abort.signal.aborted) console.warn('cable live owner liveness wait failed', cause);
			})
			.finally(() => {
				if (liveWatch === current) liveWatch = null;
			});
	}

	/** On load: an orphan live marker is reported before `ready` settles when locks can be queried. */
	async function probeLiveOrphan(): Promise<void> {
		if (mode !== 'real' || liveStore === null || locks === null) return;
		const raw = liveStore.read();
		const marker = raw === null ? null : parseLiveMarker(raw);
		if (marker !== null && marker.tabId !== tabId && typeof locks.query === 'function') {
			try {
				const snapshot = await locks.query();
				const alive = (snapshot.held ?? []).some(
					(lock) => lock.name === cableAliveLock(marker.tabId)
				);
				if (!alive) adoptOrphan(marker.tabId);
			} catch (cause) {
				console.warn('cable lock query failed', cause);
			}
		}
		watchLiveMarker();
	}

	/** Takes the session lock `oa-cable-live` (`ifAvailable`) and holds it until released. */
	function takeLiveLock(): Promise<{ release: () => void } | 'busy' | 'error'> {
		if (mode !== 'real' || locks === null) {
			return Promise.resolve({ release: () => undefined });
		}
		const manager = locks;
		return new Promise((settle) => {
			void manager
				.request(CABLE_LIVE_LOCK, { ifAvailable: true }, (lock) => {
					if (lock === null || disposed) {
						settle(lock === null ? 'busy' : 'error');
						return Promise.resolve();
					}
					liveLockHeld = true;
					return new Promise<void>((resolve) => {
						settle({
							release: () => {
								liveLockHeld = false;
								resolve();
							}
						});
					});
				})
				.catch((cause: unknown) => {
					console.warn('cable live session lock failed', cause);
					settle('error');
				});
		});
	}

	/**
	 * Whether another tab runs a live session right now (it holds `oa-cable-live`): probed with
	 * an `ifAvailable` request, released at once. A lock manager that answers in the same task
	 * gives the answer synchronously (no extra wait before the marker); otherwise a promise.
	 */
	function liveElsewhere(): boolean | Promise<boolean> {
		if (mode !== 'real' || locks === null || liveLockHeld) return false;
		const answer: { elsewhere: boolean | null } = { elsewhere: null };
		let probe: Promise<void>;
		try {
			probe = locks.request(CABLE_LIVE_LOCK, { ifAvailable: true }, (lock) => {
				answer.elsewhere = lock === null;
				return Promise.resolve();
			});
		} catch (cause) {
			console.warn('cable live session lock probe failed', cause);
			return false;
		}
		const failed = (cause: unknown) => {
			console.warn('cable live session lock probe failed', cause);
			return false;
		};
		if (answer.elsewhere !== null) {
			void probe.catch(failed);
			return answer.elsewhere;
		}
		return probe.then(() => answer.elsewhere === true, failed);
	}

	/**
	 * Starts the pending curve when it is due (`nextApplyDelay`), otherwise waits on the clock.
	 * Never while an apply is in flight or a write runs: they call it again when they end.
	 */
	function scheduleLive() {
		const s = activeLive();
		if (s === null || s !== live) return;
		if (liveInFlight !== null || liveSuspended > 0 || writing || liveTimer !== null) return;
		// Waiting for the session lock (`startLive`): nothing is applied before it is held.
		if (s.gated) return;
		const next = s.pending;
		if (next === null || s.hold !== null) return;
		const now = clock.now();
		let delay: number;
		try {
			// A confirmed curve has no edit wait; the start-to-start and after-commit floors stay.
			const editAnchor = next.confirmed ? now - LIVE_MAX_WAIT_MS : null;
			// After-commit floor: this page's last commit, and the end of the last write sequence of
			// any tab (the shared flash state; X9 queues included).
			const flashAt = flashCommitAnchor(now);
			const commitAnchor =
				lastCommitMs === null
					? flashAt
					: flashAt === null
						? lastCommitMs
						: Math.max(lastCommitMs, flashAt);
			delay = nextApplyDelay({
				nowMs: now,
				lastEditMs: editAnchor ?? s.lastEditMs,
				firstPendingEditMs: editAnchor ?? s.firstPendingEditMs,
				lastApplyStartMs,
				lastCommitMs: commitAnchor
			});
		} catch (cause) {
			console.error('cable live scheduling failed', cause);
			delay = LIVE_MAX_WAIT_MS;
		}
		if (liveNotBeforeMs !== null) delay = Math.max(delay, liveNotBeforeMs - now);
		if (delay <= 0) {
			liveNotBeforeMs = null;
			startLiveApply(s);
			return;
		}
		const timer = new AbortController();
		let sleeping: Promise<void>;
		try {
			sleeping = clock.sleep(delay, timer.signal);
		} catch (cause) {
			sleeping = Promise.reject(cause);
		}
		const fired = () => {
			if (liveTimer !== timer) return;
			liveTimer = null;
			liveTimerDone = null;
			scheduleLive();
		};
		liveTimer = timer;
		liveTimerDone = sleeping.then(fired, (cause: unknown) => {
			if (timer.signal.aborted) return;
			console.error('cable live wait failed', cause);
			// The injected clock failed: wait on a real timer instead, so the edit is not lost.
			return systemClock.sleep(delay).then(fired);
		});
	}

	/** Pre-checks (gate, Modo YOLO, loudness and state holds; no I/O), then the apply. */
	function startLiveApply(s: LiveSession) {
		const next = s.pending;
		if (next === null) return;
		s.pending = null;
		const { verdict, snapshot, crc } = next;
		if (!verdict.ok || snapshot === null || crc === null) {
			holdLive(s, next, { reason: 'gate', gateReasons: [...verdict.reasons] });
			emit();
			return;
		}
		if (s.profile === 'yolo' && !yoloSession()) {
			// Modo YOLO was turned off: a YOLO-gated curve is not sent any more.
			holdLive(s, next, { reason: 'gate', gateReasons: [] });
			emit();
			return;
		}
		if (next.experimentalRequired && !s.experimentalConfirmed) {
			// HS/LP/HP or above 20 kHz without the experimental confirmation: never sent unconfirmed.
			holdLive(s, next, { reason: 'experimental' });
			emit();
			return;
		}
		if (!next.confirmed) {
			const hold = liveHold({
				levelDb: next.levelDb ?? Number.NaN,
				ackLevelDb: s.ackLevelDb,
				state: s.known ? 'known' : 'unknown'
			});
			if (hold !== null) {
				holdLive(
					s,
					next,
					hold.reason === 'loudness'
						? { reason: 'loudness', deltaDb: hold.deltaDb }
						: { reason: 'unknown-state' }
				);
				emit();
				return;
			}
		}
		// A retry after a busy lock is not announced again (the status stays "applying").
		const retry = s.busyAttempts > 0;
		const run: Promise<void> = runLiveApply(s, next, snapshot, crc)
			.catch((cause: unknown) => {
				console.error('cable live apply failed', cause);
				s.lastError = cause;
				s.busyAttempts = 0;
				s.started = true;
				reholdIfUnknown(s, next);
				return true;
			})
			.then((announce) => {
				if (liveInFlight === run) liveInFlight = null;
				if (s.pending !== next) next.done();
				if (announce) emit();
				scheduleLive();
			});
		liveInFlight = run;
		if (!retry) emit();
	}

	/** One apply attempt holding the cross-tab write lock (`ifAvailable`; busy: nothing sent). */
	async function liveExclusive(
		s: LiveSession,
		snapshot: readonly Readonly<Band>[],
		preampDb: number,
		crc: number
	): Promise<LiveRun> {
		const body = async (): Promise<LiveRun> => {
			if (s.ended !== null || disposed) return { kind: 'skipped' };
			// Another tab's in-flight write marker (real cables): a writer that is still going, or a
			// dead one, recorded first like a write would (journal + rescue). Either way another tab
			// may have changed what the cable plays: nothing is sent, the state becomes unknown.
			const found = mode === 'real' ? foreignMarker() : null;
			if (found !== null) {
				const fresh =
					found.marker !== null && Math.abs(nowMs() - found.marker.at) <= INFLIGHT_STALE_MS;
				if (!(locks === null && fresh)) recoverMarker(found.raw, found.marker);
				return { kind: 'foreign' };
			}
			// S5: before a curve other than the saved one reaches the cable, leave a marker, so a
			// reload or another tab can tell the cable may play an unsaved preview.
			if (crc !== savedCrcOf(s)) writeLiveMarker(s, crc);
			lastApplyStartMs = clock.now();
			try {
				const result = await withWriteFlag(() =>
					applyCurve(s.device, snapshot, preampDb, {
						experimental: s.experimental,
						...(s.profile === 'yolo' ? { profile: 'yolo' as const } : {}),
						signal: s.abort.signal,
						clock,
						// The real HID: a live apply records no flash attempt (no observedHid).
						hid
					})
				);
				return { kind: 'done', result };
			} catch (cause) {
				// applyCurve only throws before any I/O: nothing reached the cable.
				return { kind: 'refused', cause };
			}
		};
		if (locks === null) return body();
		try {
			return await locks.request(CABLE_WRITE_LOCK, { ifAvailable: true }, (lock) =>
				lock === null ? Promise.resolve<LiveRun>({ kind: 'busy' }) : body()
			);
		} catch (cause) {
			return { kind: 'refused', cause };
		}
	}

	/**
	 * One live apply attempt and its bookkeeping. Returns whether the state changed in a way
	 * worth announcing (a busy attempt that will be retried is not).
	 */
	async function runLiveApply(
		s: LiveSession,
		next: LiveCaptured,
		snapshot: readonly Readonly<Band>[],
		crc: number
	): Promise<boolean> {
		const run = await liveExclusive(s, snapshot, next.preampDb, crc);
		if (s.ended !== null || disposed || run.kind === 'skipped') return true;
		if (
			run.kind === 'busy' ||
			(run.kind === 'refused' && run.cause instanceof ConcurrentWriteError)
		) {
			// Nothing was sent. No hold: the cable still plays what it played.
			s.busyAttempts += 1;
			if (s.busyAttempts >= LIVE_BUSY_MAX_ATTEMPTS) {
				// The lock stayed busy: the edit (and a newer one) is dropped, never sent.
				s.busyAttempts = 0;
				liveNotBeforeMs = null;
				next.busy = true;
				const newer = s.pending;
				s.pending = null;
				if (newer !== null) {
					newer.busy = true;
					newer.done();
				}
				s.lastError = 'busy';
				s.started = true;
				reholdIfUnknown(s, next);
				return true;
			}
			// Try again on the scheduler with backoff (unless a newer edit replaced it).
			if (s.pending === null) {
				s.pending = next;
				const now = clock.now();
				s.firstPendingEditMs = now;
				s.lastEditMs = now;
			}
			liveNotBeforeMs =
				clock.now() + LIVE_BUSY_BACKOFF_MS * 2 ** (s.busyAttempts - 1);
			return false;
		}
		s.busyAttempts = 0;
		s.started = true;
		if (run.kind === 'foreign') {
			s.known = false;
			// "Reaplicar" (`confirmLive`) checks this curve's loudness again before sending it.
			holdLive(s, next, { reason: 'unknown-state' });
			return true;
		}
		if (run.kind === 'refused') {
			const cause = run.cause;
			if (cause instanceof GateRejectedError || cause instanceof CommitCollisionError) {
				// Only this curve is held: a newer edit stays scheduled (it is gated on its own).
				if (s.pending !== null) return true;
				holdLive(s, next, {
					reason: 'gate',
					gateReasons: cause instanceof GateRejectedError ? gateReasonsOf(cause) ?? [] : []
				});
				return true;
			}
			// Nothing was sent; never retried.
			s.lastError = cause;
			reholdIfUnknown(s, next);
			return true;
		}
		const result = run.result;
		if (result.status === 'ok' && result.settleError === undefined) {
			s.applied = {
				crc,
				bands: copyBands(snapshot),
				preampDb: next.preampDb,
				levelDb: next.levelDb,
				at: nowMs(),
				...(s.profile === 'yolo' ? { profile: 'yolo' as const } : {})
			};
			s.known = true;
			s.applies += 1;
			liveTotal += 1;
			s.lastError = null;
			// The saved curve plays again: the preview marker is moot (S5). Only the cable's own
			// saved curve (shared journal), never another curve, even one sent as a revert.
			if (crc === savedCrcOf(s)) cableBackToSaved(s.label);
			return true;
		}
		if (result.status === 'interrupted' && result.error instanceof DeviceDisconnectedError) {
			// Unplugged during the apply: the cable is back on its saved curve.
			endLive(s, 'disconnected');
			cableBackToSaved(s.label);
			return true;
		}
		s.lastError = result.status === 'ok' ? result.settleError : result.error;
		// No count from the transport: assume report 8 may have gone out.
		const attempted = result.reportsAttempted ?? 9;
		if (result.status === 'ok' || attempted >= 9) {
			// Report 8 went out unconfirmed (or the settle failed): what the cable plays is unknown
			// until the user confirms a curve again.
			s.known = false;
			holdLive(s, next, { reason: 'unknown-state' });
			return true;
		}
		// Report 8 never attempted: the cable kept its previous live curve (B12b). Not retried;
		// an unknown state stays unknown.
		reholdIfUnknown(s, next);
		return true;
	}

	/**
	 * The newest committed journal entry (`ok`; `simulated` in simulated mode) naming the cable
	 * `device` (its truncated label). The journal is shared by every tab; a port without
	 * `entries` only offers its last entry.
	 */
	function lastCommittedEntry(device: string): JournalEntry | null {
		const status = mode === 'simulated' ? 'simulated' : 'ok';
		let entries: readonly JournalEntry[];
		try {
			const all = deps.journal.entries;
			if (all !== undefined) {
				entries = all;
			} else {
				const last = deps.journal.last();
				entries = last === null ? [] : [last];
			}
		} catch (cause) {
			console.warn('cable journal unreadable for the saved curve', cause);
			return null;
		}
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry !== undefined && entry.status === status && entry.device === device) {
				return entry;
			}
		}
		return null;
	}

	/**
	 * The curve the session's cable holds in flash, from shared data: the newest committed
	 * journal entry naming that cable (any tab's), or the last curve this page committed to it
	 * when that one is newer (or the journal names none). A save to another cable never counts.
	 * Null: unknown.
	 */
	function cableSaved(s: LiveSession): SavedOnCable | null {
		const own = savedByDevice.get(s.device) ?? null;
		const entry = lastCommittedEntry(truncate(s.label, 64));
		if (entry !== null && (own === null || entry.at >= own.at)) {
			return { bands: entry.bands, preampDb: entry.preampDb, crc: entry.crc, at: entry.at };
		}
		return own;
	}

	/** CRC of the session cable's saved curve (`cableSaved`), or null when unknown. */
	function savedCrcOf(s: LiveSession): number | null {
		return cableSaved(s)?.crc ?? null;
	}

	/**
	 * The curve a revert on `s` applies (confirmed): the caller's `given` only when its gated
	 * payload CRC is the cable's saved one, otherwise the cable's saved curve itself.
	 */
	function revertCurve(
		s: LiveSession,
		given: LiveSavedCurve | null | undefined,
		target: SavedOnCable
	): LiveCaptured {
		if (given !== null && given !== undefined) {
			const verdict = gateForWrite(given.bands, given.preampDb, liveGateOptions(s));
			const crc = verdict.metrics.payloadCrc;
			if (crc !== undefined && Number(crc) === target.crc) {
				return capturedOf(verdict, given.preampDb, true, true);
			}
		}
		return captureLive(s, target.bands, target.preampDb, true, true);
	}

	/** `device` committed `authorized`: its revert target, and its preview marker is moot. */
	function noteCommitted(device: CableDevice, label: string, authorized: Authorized) {
		savedByDevice.set(device, {
			bands: copyBands(authorized.snapshot),
			preampDb: authorized.preampDb,
			crc: authorized.crc,
			at: nowMs()
		});
		// An ended session on that cable (a curve kept until unplugged): the commit's data reports
		// made the saved curve the live one, so the cable no longer plays something unsaved.
		const s = live;
		if (s !== null && s.ended !== null && s.device === device) {
			s.applied = {
				crc: authorized.crc,
				bands: copyBands(authorized.snapshot),
				preampDb: authorized.preampDb,
				levelDb: authorized.checklist.newLevelDb,
				at: nowMs(),
				...(authorized.profile === 'yolo' ? { profile: 'yolo' as const } : {})
			};
		}
		cableBackToSaved(label);
	}

	/**
	 * After a write's sequence to `device` ended: records the commit time for the scheduler and
	 * keeps an active session on that device consistent (the commit's 9 data reports also made
	 * it the live curve).
	 */
	function liveAfterWrite(
		device: CableDevice,
		label: string,
		result: WriteResult,
		authorized: Authorized
	) {
		const committed = result.status === 'ok';
		if (committed || (result.reportsAttempted ?? 0) >= 10) {
			lastCommitMs = clockNow() ?? lastCommitMs;
		}
		if (committed) noteCommitted(device, label, authorized);
		const s = activeLive();
		if (s === null || s.device !== device) return;
		if (committed) {
			const levelDb = authorized.checklist.newLevelDb;
			s.applied = {
				crc: authorized.crc,
				bands: copyBands(authorized.snapshot),
				preampDb: authorized.preampDb,
				levelDb,
				at: nowMs(),
				...(authorized.profile === 'yolo' ? { profile: 'yolo' as const } : {})
			};
			s.known = true;
			s.started = true;
			// The user lowered the volume for this save: it is the new confirmed level.
			s.ackLevelDb = levelDb;
			// A held edit is evaluated again against it (after LIVE_AFTER_COMMIT_MS), unless it is
			// the curve just saved.
			const held = clearHold(s);
			if (held !== null && s.pending === null && held.crc !== authorized.crc) {
				enqueueLive(s, recaptured(held, false));
			}
			return;
		}
		if ((result.reportsAttempted ?? 9) >= 9) {
			s.known = false;
			const curve = s.pending ?? s.held ?? captureLive(s, authorized.snapshot, authorized.preampDb, false);
			s.pending = null;
			holdLive(s, curve, { reason: 'unknown-state' });
		}
	}

	/**
	 * Applies the last saved curve live (fresh gesture); the session goes on. Pending edits
	 * and holds are dropped; its level becomes the confirmed one. A saved curve ≥ 3 dB above the
	 * confirmed level is held instead (refused `revert-failed`, `held`) until `confirmLive`.
	 */
	async function revertLive(request: LiveRevertRequest): Promise<LiveOutcome> {
		if (!consumeGestureToken(request.gesture, nowMs())) return liveRefuse('gesture');
		const s = activeLive();
		if (s === null) return liveRefuse('no-session');
		const target = cableSaved(s);
		if (target === null) return liveRefuse('no-saved-curve');
		const curve = revertCurve(s, request.saved, target);
		clearHold(s);
		s.pending?.done();
		s.pending = null;
		// The saved curve ≥ 3 dB above the confirmed level: held like a louder edit, flagged as
		// the saved curve; only `confirmLive` (a fresh gesture, volume lowered) sends it.
		const loud = loudnessHold(s, curve);
		if (loud !== null) {
			holdLive(s, curve, loud);
			emit();
			return liveRefuse('revert-failed', { revertFailure: 'held', live: liveView() });
		}
		enqueueLive(s, curve);
		emit();
		scheduleLive();
		await curve.settled;
		// Success only when the cable plays its saved curve now (another tab may have saved meanwhile).
		const failure =
			revertFailure(s, curve) ?? (curve.crc === savedCrcOf(s) ? null : ('error' as const));
		if (failure !== null) {
			return liveRefuse('revert-failed', {
				revertFailure: failure,
				live: liveView(),
				...(s.lastError === null || s.lastError === undefined ? {} : { error: s.lastError })
			});
		}
		// Only now: the saved curve plays, its level is the confirmed one.
		s.ackLevelDb = curve.levelDb;
		cableBackToSaved(s.label);
		emit();
		return { status: 'accepted', live: liveView() };
	}

	/** Null when the cable plays the revert curve now (known); otherwise why not. */
	function revertFailure(s: LiveSession, curve: LiveCaptured): LiveRevertFailure | null {
		if (s.ended !== null || disposed) return 'ended';
		if (s.known && curve.crc !== null && s.applied?.crc === curve.crc) return null;
		if (curve.busy) return 'busy';
		if (!s.known) return 'unknown';
		if (s.hold !== null) return 'held';
		return 'error';
	}

	function liveIdle(): boolean {
		if (disposed) return true;
		const s = live;
		return (
			liveInFlight === null &&
			liveTimer === null &&
			(s === null || s.ended !== null || s.pending === null)
		);
	}

	// A marker left by a tab closed mid-write becomes an `interrupted` entry and the rescue notice.
	// A live marker left by a tab that is gone becomes the orphan preview notice (S5).
	const ready = recover().then(() =>
		probeLiveOrphan().catch((cause: unknown) => {
			console.error('cable live marker check failed', cause);
		})
	);
	// A marker another tab writes later: wait for that writer, so its death surfaces here too.
	const stopWatching = inflight?.subscribe?.(() => watchWriter()) ?? null;
	// Likewise for another tab's live marker: its death leaves an orphan preview.
	const stopLiveWatching = liveStore?.subscribe?.(() => watchLiveMarker()) ?? null;

	return {
		/** Service EventTarget: `cable:written` (real ok writes) and `cable:status`. */
		events,
		mode,

		getState: snapshotState,

		/** Svelte store contract: calls `listener` now and on every change. */
		subscribe(listener: (state: CableState) => void): () => void {
			listeners.add(listener);
			listener(snapshotState());
			return () => {
				listeners.delete(listener);
			};
		},

		/** Mints a gesture token; call it synchronously inside the click/keypress handler. */
		createGesture(event: GestureEventLike): GestureToken | null {
			return createGestureToken(event, {
				now: nowMs,
				userActivation: deps.userActivation === undefined ? undefined : deps.userActivation()
			});
		},

		/** Opens the picker (`requestCable`). MUST be called from a click handler. */
		async connect(): Promise<CableDevice | null> {
			if (connection === 'connecting') return null;
			connection = 'connecting';
			error = null;
			emit();
			try {
				const device = await requestCable(hid);
				if (device !== null && isCableDevice(device)) {
					addDevice(device);
					primary = device;
				} else if (device === null) {
					error = 'request-empty';
				}
				return device;
			} catch (cause) {
				error = 'request-failed';
				console.warn('cable request failed', cause);
				return null;
			} finally {
				if (connection === 'connecting') {
					connection = devices.length > 0 ? 'connected' : 'disconnected';
				}
				emit();
			}
		},

		/**
		 * Restores devices the page was already allowed to use (`hid.getDevices()`). A restored
		 * cable is never chosen silently: the target stays unset unless exactly one cable is
		 * connected (then it is shown as the target in the checklist); with several, the user
		 * must select one.
		 */
		async restore(): Promise<readonly CableDevice[]> {
			if (hid.getDevices === undefined) return [];
			try {
				const permitted = await hid.getDevices();
				for (const device of permitted) if (isCableDevice(device)) addDevice(device);
				implyTarget();
			} catch (cause) {
				error = 'restore-failed';
				console.warn('cable restore failed', cause);
			}
			emit();
			return devices.slice();
		},

		/** Chooses which connected device `write()` uses. */
		selectDevice(device: CableDevice): boolean {
			if (!devices.includes(device) || writing) return false;
			primary = device;
			emit();
			return true;
		},

		/**
		 * "Salvar" of the live preview: makes the active session's cable the write target, so the
		 * curve it plays is saved to that cable (the checklist names it). False without an active
		 * session, mid-write, or when its cable is gone.
		 */
		selectLiveCable(): boolean {
			const s = activeLive();
			if (s === null || writing || !devices.includes(s.device)) return false;
			if (primary !== s.device) {
				primary = s.device;
				emit();
			}
			return true;
		},

		/** Forgets a device in this page (closes it when possible). Refused while writing. */
		async disconnect(device: CableDevice | null = primary): Promise<boolean> {
			if (device === null || writing || !devices.includes(device)) return false;
			// Forgotten by the page, still plugged in: the cable keeps the live curve until unplugged.
			const s = activeLive();
			if (s !== null && s.device === device) endLive(s, 'forgotten');
			removeDevice(device);
			emit();
			const closable = device as CableDevice & { close?: () => Promise<void> };
			if (typeof closable.close === 'function') {
				try {
					await closable.close();
				} catch (cause) {
					console.warn('cable close failed', cause);
				}
			}
			return true;
		},

		/** Checklist for the current context (for display). `gate` may reuse a verdict for the same input. */
		checklist(request: ChecklistInput, gate?: GateResult): ChecklistResult {
			return evaluateChecklist(input(request), context(), gate);
		},

		/**
		 * The `startLive` checklist for the current context (display only; read-only, like
		 * `checklist`). `startLive` evaluates it again on its own.
		 */
		liveChecklist(request: ChecklistInput, gate?: GateResult): ChecklistResult {
			return evaluateLiveChecklist(input(request), context(), gate);
		},

		/** Flash counters exactly as the checklist shows them (simulated: in-memory bookkeeping). */
		counters(): ChecklistResult['counters'] {
			const now = nowMs();
			return flashCountersOf(currentFlash(now), now);
		},

		/** Settles once a stale in-flight marker found on load has been checked/recovered. */
		ready,

		/**
		 * Writes to the selected device. Refuses without a fresh gesture, a passing checklist, a
		 * device or the cross-tab write lock.
		 */
		async write(request: WriteRequest): Promise<WriteOutcome> {
			const prepared = prepare(request);
			if ('status' in prepared) return prepared;
			const abort = reserve();
			// "Salvar" during a live session: no new live apply starts until the write ends, and
			// the one in flight (holding the device and the write lock) is awaited first.
			liveSuspended += 1;
			cancelLiveTimer();
			try {
				if (liveInFlight !== null) await liveInFlight;
				return await exclusive<WriteOutcome>(async (freshness) => {
					const guard = crossTabGuard();
					if (guard !== null) return guard;
					const authorized = authorize(prepared, freshness);
					if ('status' in authorized) return authorized;
					const { checklist, snapshot, preampDb, experimental, profile } = authorized;
					const device = primary;
					if (device === null) return refuse('no-device', { checklist });
					if (abort.signal.aborted) return refuse('aborted', { checklist });
					const label = labelOf(device);
					if (!mark(authorized, label)) return refuse('error', { checklist });
					const startHid = observedHid(hid, () => sequenceStarting(label), sequenceEnded);
					let result: WriteResult;
					try {
						result = await withWriteFlag(() =>
							writeCurve(device, snapshot, preampDb, {
								experimental,
								// The transport gates again with the same profile before any byte.
								...(profile === 'yolo' ? { profile: 'yolo' as const } : {}),
								signal: abort.signal,
								clock,
								hid: startHid
							})
						);
					} catch (cause) {
						// writeCurve only throws before any I/O: nothing reached the cable.
						return refuse(refusalFromError(cause), {
							checklist,
							gateReasons: gateReasonsOf(cause),
							error: cause
						});
					}
					const written = settle(result, label, authorized);
					try {
						liveAfterWrite(device, label, result, authorized);
					} catch (cause) {
						// The write is journaled: its outcome stands whatever the live bookkeeping did.
						console.error('cable live bookkeeping after a write failed', cause);
					}
					const outcome: Written = freshness === null ? written : { ...written, freshness };
					lastOutcome = outcome;
					return outcome;
				});
			} catch (cause) {
				// The lock manager failed: nothing was sent.
				return refuse(refusalFromError(cause), { error: cause });
			} finally {
				liveSuspended -= 1;
				release();
				scheduleLive();
			}
		},

		/**
		 * X9: writes the same curve to the listed devices, one at a time (`writeMany`), after
		 * one gesture on the explicit queue confirmation. Stops at the first failure.
		 */
		async writeQueue(request: QueueRequest): Promise<QueueOutcome> {
			// Modo YOLO has no X9 queue: one cable, one confirmation, one write. The gesture is
			// spent all the same, so a refused attempt cannot be replayed.
			const profile: unknown = request.profile;
			if (profile === 'yolo') {
				consumeGestureToken(request.gesture, nowMs());
				return refuse('yolo-queue');
			}
			// Read once: the queue the user confirmed is copied before anything else happens.
			const requested: unknown = request.devices;
			const list: CableDevice[] = [];
			if (Array.isArray(requested)) {
				const length = requested.length;
				for (let index = 0; index < length; index++) {
					list.push(requested[index] as CableDevice);
				}
			}
			const prepared = prepare(request);
			if ('status' in prepared) return prepared;
			// One cable at a time while a live preview runs: stop it before an X9 queue.
			if (activeLive() !== null) return refuse('busy', { checklist: prepared.checklist });
			const valid = (): boolean =>
				list.length > 0 &&
				new Set(list).size === list.length &&
				list.every((device) => devices.includes(device));
			if (!valid()) {
				return refuse(list.length === 0 ? 'no-device' : 'unknown-device', {
					checklist: prepared.checklist
				});
			}
			const labels = list.map(labelOf);
			const items: QueueItem[] = labels.map((deviceLabel) => ({
				deviceLabel,
				status: 'pending',
				entry: null
			}));
			queue = { running: true, items };
			const abort = reserve();
			try {
				return await exclusive<QueueOutcome>(async (freshness) => {
					const guard = crossTabGuard();
					if (guard !== null) return guard;
					const authorized = authorize(prepared, freshness);
					if ('status' in authorized) return authorized;
					const { checklist, snapshot, preampDb, experimental } = authorized;
					// A cable may have been unplugged while waiting for the lock.
					if (!valid()) return refuse('unknown-device', { checklist });
					if (abort.signal.aborted) return refuse('aborted', { checklist });
					if (!mark(authorized, labels[0] ?? '')) return refuse('error', { checklist });
					let started = 0;
					/** Index of the cable whose sequence just ended, while its result is unknown. */
					let ended: number | null = null;
					/** Cables already journaled (as they ended), not settled again at the end. */
					const settled = new Set<number>();
					const progressHid = observedHid(
						hid,
						() => {
							ended = null;
							const item = items[started];
							if (item !== undefined) {
								sequenceStarting(item.deviceLabel);
								item.status = 'writing';
							}
							emit();
						},
						() => {
							sequenceEnded();
							const item = items[started];
							if (item !== undefined) item.status = 'sent';
							ended = started;
							started += 1;
							emit();
						}
					);
					// writeMany waits WRITE_SPACING_MS before the next cable only after an `ok`
					// (committed) write. That wait is where the previous cable is settled: journal,
					// rescue cleared, `cable:written`; then the marker stops naming it. So a tab closed
					// during the spacing never turns a committed cable into an interruption.
					const spacedClock: Clock = {
						now: () => clock.now(),
						sleep(ms, signal) {
							const previous = ended;
							const item = previous === null ? undefined : items[previous];
							if (previous !== null && item !== undefined && ms === WRITE_SPACING_MS) {
								ended = null;
								settled.add(previous);
								const written = journalSequence(
									true,
									authorized.crc,
									null,
									item.deviceLabel,
									authorized
								);
								item.status = written.status;
								item.entry = written.entry;
								const committedDevice = list[previous];
								if (committedDevice !== undefined) {
									noteCommitted(committedDevice, item.deviceLabel, authorized);
								}
								betweenCables(item.deviceLabel);
								emit();
							}
							return clock.sleep(ms, signal);
						}
					};
					let results: ManyResult[];
					try {
						results = await withWriteFlag(() =>
							writeMany(list, snapshot, preampDb, {
								experimental,
								signal: abort.signal,
								clock: spacedClock,
								hid: progressHid
							})
						);
					} catch (cause) {
						// writeMany only throws before the first device is touched.
						return refuse(refusalFromError(cause), {
							checklist,
							gateReasons: gateReasonsOf(cause),
							error: cause
						});
					}
					// Live pacing: a commit (or a sequence that may have sent it) ended just now.
					const sentCommit = results.some(
						(result) =>
							result.status === 'ok' ||
							(result.status === 'interrupted' && (result.reportsAttempted ?? 0) >= 10)
					);
					if (sentCommit) lastCommitMs = clockNow() ?? lastCommitMs;
					results.forEach((result, index) => {
						const item = items[index];
						if (item === undefined) return;
						if (result.status === 'ok' && !settled.has(index)) {
							const committedDevice = list[index];
							if (committedDevice !== undefined) {
								noteCommitted(committedDevice, item.deviceLabel, authorized);
							}
						}
						if (settled.has(index)) {
							// Journaled when it ended; writeMany only continued because it was `ok`.
							if (result.status !== 'ok') {
								console.error('cable queue: a settled cable reported', result.status);
							}
							return;
						}
						if (result.status === 'ok' || result.status === 'interrupted') {
							const written = settle(result, item.deviceLabel, authorized);
							item.status = written.status;
							item.entry = written.entry;
						} else if (result.status === 'failed') {
							item.status = 'failed';
							item.error = result.error;
						} else {
							item.status = 'skipped';
						}
					});
					queue = { running: false, items };
					return {
						status: 'done',
						simulated: mode === 'simulated',
						items: items.map((item) => ({ ...item })),
						...(freshness === null ? {} : { freshness })
					};
				});
			} catch (cause) {
				// The lock manager failed: nothing was sent.
				return refuse(refusalFromError(cause), { error: cause });
			} finally {
				// A refused queue leaves no summary; a finished one stays until cleared.
				if (queue?.running === true) queue = null;
				release();
			}
		},

		/**
		 * Starts a live (no-flash) preview on the selected cable and applies `curve` at once
		 * (after `LIVE_AFTER_COMMIT_MS` when a save just ended). Needs a fresh gesture and the
		 * live checklist (gate, volume, experimental when required, the Modo YOLO items, the
		 * Android acknowledgement on native; no spacing and no "keep connected"). Settles once
		 * that first apply settled (or was held). The level of `curve` becomes the confirmed one.
		 */
		async startLive(request: LiveStartRequest): Promise<LiveOutcome> {
			// The token is spent first, whatever happens next.
			if (!consumeGestureToken(request.gesture, nowMs())) return liveRefuse('gesture');
			if (!liveCapable() || disposed) return liveRefuse('unavailable');
			if (writing || activeLive() !== null) return liveRefuse('busy');
			const device = primary;
			if (device === null) return liveRefuse('no-device');
			// Read once: the curve and the confirmations.
			const curve = request.curve;
			const bands = curve.bands;
			const preampDb = curve.preampDb;
			const experimental = curve.experimental === true;
			const profile: unknown = curve.profile;
			const confirmations = request.confirmations;
			const captured = input({
				bands,
				preampDb,
				experimental,
				...(profile === 'yolo' ? { profile: 'yolo' as const } : {}),
				confirmations: {
					volumeLowered: confirmations?.volumeLowered === true,
					// Not part of the live checklist (an unplug only reverts the cable).
					keepConnected: false,
					experimental: confirmations?.experimental === true,
					yoloWrite: confirmations?.yoloWrite === true,
					androidUntested: confirmations?.androidUntested === true
				}
			});
			const verdict = gateForWrite(captured.bands, captured.preampDb, gateOptions(captured));
			const checklist = evaluateLiveChecklist(captured, context(), verdict);
			if (!checklist.canWrite) return liveRefuse('checklist', { checklist });
			if (native) {
				try {
					await assertNativeWriteFresh(deps.nativeFreshness);
				} catch (cause) {
					return liveRefuse('error', { error: cause });
				}
				if (disposed) return liveRefuse('unavailable');
				if (writing || activeLive() !== null) return liveRefuse('busy');
				if (primary !== device) return liveRefuse('no-device');
			}
			const now = clock.now();
			// The experimental item of the start checklist was required and checked: later curves
			// with HS/LP/HP or bands above 20 kHz may be applied. Otherwise they are held.
			const experimentalConfirmed =
				checklist.experimentalRequired && captured.confirmations.experimental === true;
			const s: LiveSession = {
				device,
				label: labelOf(device),
				experimental: captured.experimental,
				profile: captured.profile === 'yolo' ? 'yolo' : 'standard',
				abort: new AbortController(),
				ended: null,
				started: false,
				applied: null,
				pending: null,
				firstPendingEditMs: now,
				lastEditMs: now,
				held: null,
				hold: null,
				known: true,
				ackLevelDb: checklist.newLevelDb,
				applies: 0,
				lastError: null,
				experimentalConfirmed,
				busyAttempts: 0,
				releaseLock: () => undefined,
				gated: true,
				gatedEdit: null
			};
			const previous = live;
			live = s;
			const first = capturedOf(verdict, captured.preampDb, true);
			enqueueLive(s, first);
			emit();
			// S5: one live session across tabs (the session lock, held until the session ends), and
			// this tab's liveness lock, so other tabs can tell an orphan preview from a live one.
			const lock = await takeLiveLock();
			if (lock === 'busy' || lock === 'error' || s.ended !== null || disposed) {
				if (typeof lock === 'object') lock.release();
				abandonLive(s, previous);
				if (lock === 'busy') return liveRefuse('live-elsewhere');
				return liveRefuse(lock === 'error' ? 'error' : 'unavailable');
			}
			s.releaseLock = lock.release;
			if (mode === 'real') {
				const alive = holdAlive(true);
				if (alive !== true && !(await alive)) {
					abandonLive(s, previous);
					return liveRefuse('error');
				}
			}
			if (s.ended !== null || disposed) {
				abandonLive(s, previous);
				return liveRefuse('unavailable');
			}
			s.gated = false;
			scheduleLive();
			// An edit made meanwhile follows the start curve (newest wins, like any pending edit).
			const edit = s.gatedEdit;
			s.gatedEdit = null;
			if (edit !== null) {
				enqueueLive(s, edit);
				scheduleLive();
			}
			await first.settled;
			if (first.busy && s.applied === null) {
				// The write lock stayed busy: nothing was sent, the session did not start.
				abandonLive(s, previous);
				return liveRefuse('busy');
			}
			return { status: 'accepted', live: liveView() };
		},

		/**
		 * Queues an edited curve for the active live session (no gesture). Read once and gated
		 * now; applied by the scheduler (debounce, one apply in flight plus one pending, newest
		 * wins), unless the gate or a hold stops it. False when no session is active.
		 */
		queueLive(curve: LiveCurve): boolean {
			const s = activeLive();
			if (s === null) return false;
			const bands = curve.bands;
			const preampDb = curve.preampDb;
			const captured = captureLive(s, bands, preampDb, false);
			if (s.gated) {
				// The session lock is being taken: the edit waits for the start curve.
				s.gatedEdit?.done();
				s.gatedEdit = captured;
				emit();
				return true;
			}
			if (s.hold?.reason === 'unknown-state') {
				// Only a confirmation leaves an unknown state: the newest edit waits behind it.
				if (s.held !== null) s.held.done();
				s.held = captured;
				captured.done();
				emit();
				return true;
			}
			// A loudness or gate hold is evaluated again on the newest edit.
			if (s.hold !== null) clearHold(s);
			enqueueLive(s, captured);
			emit();
			scheduleLive();
			return true;
		},

		/**
		 * Releases a loudness or unknown-state hold (fresh gesture): the held curve's level
		 * becomes the confirmed one and the curve is applied. A gate hold is never confirmable. An
		 * unknown-state hold whose curve is ≥ 3 dB above the confirmed level becomes a loudness
		 * hold instead (refused `loudness`, nothing sent).
		 */
		async confirmLive(request: LiveGestureRequest): Promise<LiveOutcome> {
			if (!consumeGestureToken(request.gesture, nowMs())) return liveRefuse('gesture');
			// Read once.
			const experimentalConfirmed = request.confirmations?.experimental === true;
			const s = activeLive();
			if (s === null) return liveRefuse('no-session');
			const held = s.held;
			if (s.hold === null || held === null) return liveRefuse('no-hold');
			if (s.hold.reason === 'gate') return liveRefuse('gate');
			let again: LiveCaptured;
			if (s.hold.reason === 'experimental') {
				// Experimental filters need their own confirmation (it then holds for the session).
				// The level is not confirmed by it: an edit still goes through the loudness hold.
				if (!experimentalConfirmed) return liveRefuse('checklist');
				s.experimentalConfirmed = true;
				clearHold(s);
				again = recaptured(held, held.confirmed);
			} else {
				if (s.hold.reason === 'unknown-state') {
					// "Reaplicar" confirms sending again, not a louder level: a held curve ≥ 3 dB above
					// the confirmed one becomes a loudness hold (nothing sent; confirm again for it).
					const loud = loudnessHold(s, held);
					if (loud !== null) {
						s.hold = loud;
						emit();
						return liveRefuse('loudness');
					}
				}
				clearHold(s);
				s.ackLevelDb = held.levelDb;
				again = recaptured(held, true);
			}
			enqueueLive(s, again);
			emit();
			scheduleLive();
			await again.settled;
			if (again.busy) return liveRefuse('busy');
			return { status: 'accepted', live: liveView() };
		},

		/**
		 * Applies the last saved curve live (fresh gesture); the session goes on. Pending edits
		 * and holds are dropped; its level becomes the confirmed one. A saved curve ≥ 3 dB above
		 * the confirmed level is held (refused `revert-failed`, `held`) until `confirmLive`.
		 */
		revertLive,

		/**
		 * The saved curve of the live session's cable (the current or last ended session), the
		 * same one `revertLive` applies: the newest committed journal entry naming that cable, or
		 * this page's last save to it when newer. Null without a session or when none is known.
		 * Read-only.
		 */
		liveSavedCurve(): LiveSavedCurve | null {
			const s = live;
			if (s === null || disposed) return null;
			const saved = cableSaved(s);
			return saved === null ? null : { bands: copyBands(saved.bands), preampDb: saved.preampDb };
		},

		/**
		 * Clears the orphan preview notice and its marker ("Já desconectei": the user unplugged
		 * that cable while no tab watched). Only records; never touches the cable.
		 */
		dismissLiveOrphan(): void {
			const orphan = liveOrphan;
			if (orphan === null) return;
			if (liveStore !== null) {
				const raw = liveStore.read();
				const marker = raw === null ? null : parseLiveMarker(raw);
				// Only the orphan's own marker (never one a live tab wrote since).
				if (
					marker !== null &&
					marker.tabId !== tabId &&
					marker.device === orphan.deviceLabel &&
					marker.crc === orphan.crc &&
					marker.at === orphan.at &&
					!liveStore.write(null)
				) {
					console.warn('cable live marker could not be removed');
				}
			}
			liveOrphan = null;
			emit();
		},

		/**
		 * Ends the live session. `revert: true` first applies the saved curve live (needs a
		 * fresh gesture); otherwise the cable keeps playing the live curve until it is unplugged.
		 * Nothing is reverted automatically (not on unload either).
		 */
		async stopLive(request: LiveStopRequest): Promise<LiveOutcome> {
			const s = activeLive();
			if (!request.revert) {
				if (s === null) return liveRefuse('no-session');
				endLive(s, 'stopped');
				return { status: 'accepted', live: liveView() };
			}
			const reverted = await revertLive({
				gesture: request.gesture,
				...(request.saved === undefined ? {} : { saved: request.saved })
			});
			// Not reverted (held, unknown, busy, failed): the session goes on, the reason is returned.
			if (reverted.status === 'refused') return reverted;
			if (s !== null) endLive(s, 'reverted');
			return { status: 'accepted', live: liveView() };
		},

		/** Settles once no live apply is in flight or scheduled (tests, and a UI waiting to save). */
		async whenLiveIdle(): Promise<void> {
			while (!liveIdle()) {
				const waitFor = liveInFlight ?? liveTimerDone ?? emitted.promise;
				await waitFor;
			}
		},

		/** Aborts the write in progress (it ends as `interrupted`; the commit is never sent). */
		abort(): boolean {
			if (controller === null) return false;
			controller.abort(new DOMException('write aborted', 'AbortError'));
			return true;
		},

		/** Hides the rescue notice (the journal keeps the interruption). */
		dismissRescue() {
			rescue = null;
			emit();
		},

		/** Clears a finished queue summary. */
		clearQueue() {
			if (queue?.running) return;
			queue = null;
			emit();
		},

		dispose() {
			hid.removeEventListener('connect', onConnect);
			hid.removeEventListener('disconnect', onDisconnect);
			if (recheck !== null) clearTimeout(recheck);
			recheck = null;
			stopWatching?.();
			stopLiveWatching?.();
			unwatchLive();
			listeners.clear();
			disposed = true;
			// Live preview: timers stop and an apply in flight is aborted (before report 8 it stops
			// there; after it, it finishes and releases the lock). Never reverted here: an unload
			// cannot finish an apply reliably, and an unplug reverts the cable anyway.
			const session = live;
			if (session !== null) endLive(session, 'stopped');
			cancelLiveTimer();
			// Stop waiting for another tab's liveness lock (the wait only ever records).
			unwatch();
			// Other tabs may now treat this tab as gone: a write still running holds the write
			// lock, so they record nothing for it; later real writes are refused (holdAlive).
			const drop = releaseAlive;
			releaseAlive = null;
			aliveHeld = false;
			drop?.();
		}
	};
}

export type CableService = ReturnType<typeof createCableService>;
