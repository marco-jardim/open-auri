/**
 * Cable service (T2.7): support detection, connection, pre-write checklist, real and
 * simulated writes, journal, rescue after interruption and the X9 multi-cable queue.
 *
 * Every write goes through, in this order: a fresh single-use gesture token, the
 * checklist (gate on a snapshot, confirmations, 2 s spacing), the cross-tab write lock
 * (Web Locks `oa-cable-write`, `ifAvailable`), the checklist again with fresh flash state,
 * then `writeCurve` / `writeMany` from `open-auri/transport`, which run `gateForWrite`
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
 * Create it in the browser only (never during SSR module evaluation).
 */
import {
	ConcurrentWriteError,
	DeviceUnusableError,
	FAKE_PRODUCT_NAME,
	FakeHID,
	FakeHIDDevice,
	GateRejectedError,
	PRODUCT_NAME,
	WRITE_SPACING_MS,
	requestCable,
	systemClock,
	writeCurve,
	writeMany
} from 'open-auri/transport';
import {
	JOURNAL_WAIVED_MAX,
	MIN_INTERVAL_MS,
	observeFlashState,
	recordWrite
} from 'open-auri/policy';
import { NEUTRAL_BANDS, USB_PID, USB_VID } from 'open-auri/dsp';
import { gateForWrite, isWaivable } from 'open-auri/safety';
import { evaluateChecklist, flashCountersOf } from './checklist.ts';
import { NativeHID } from './native/hid.ts';
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

function browserLocks(): WriteLockManager | null {
	if (typeof window === 'undefined') return null;
	const nav = globalThis.navigator as unknown as { locks?: WriteLockManager } | undefined;
	const locks = nav?.locks;
	return typeof locks === 'object' && locks !== null && typeof locks.request === 'function'
		? locks
		: null;
}

function browserInflight(): InflightPort | null {
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
				return backend.getItem(CABLE_INFLIGHT_KEY);
			} catch (cause) {
				console.warn('cable in-flight marker read failed', cause);
				return null;
			}
		},
		write(value) {
			try {
				if (value === null) backend.removeItem(CABLE_INFLIGHT_KEY);
				else backend.setItem(CABLE_INFLIGHT_KEY, value);
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
				if (event.key === CABLE_INFLIGHT_KEY || event.key === null) listener();
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
	return marker;
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
}

/** What the synchronous first phase captured: the request read once and its gate verdict. */
interface Prepared {
	captured: ChecklistInput;
	verdict: GateResult;
	/** The checklist as evaluated in the caller's task (refusal details before the lock). */
	checklist: ChecklistResult;
	name: string;
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

export function createCableService(deps: CableServiceDeps) {
	const detected = detectCableSupport() === 'real' ? navigatorHid() : null;
	const resolved = deps.hid === undefined ? detected : deps.hid;
	const mode: CableMode = resolved === null ? 'simulated' : 'real';
	const native = resolved instanceof NativeHID;
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

	function context(): ChecklistContext {
		const now = nowMs();
		if (mode === 'simulated') {
			return {
				nowMs: now,
				flash: currentFlash(now),
				lastWrittenLevelDb: simulatedLevelDb,
				sessionWriteCount: simulatedFlash.session,
				lastJournalStatus: null,
				yoloSession: yoloSession()
			};
		}
		return {
			cableMode: native ? 'native' : mode,
			nowMs: now,
			flash: currentFlash(now),
			lastWrittenLevelDb: deps.lastWrittenLevelDb(),
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
			error
		};
	}

	function emit() {
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
		emit();
	}

	function onDisconnect(event: Event) {
		const device = deviceOf(event);
		if (!devices.includes(device as CableDevice)) return;
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
					: {})
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
				: {})
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
	function holdAlive(): true | Promise<boolean> {
		if (mode === 'simulated' || inflight === null || locks === null || aliveHeld) return true;
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
		run: () => Promise<T | Refused>
	): Promise<T | Refused> {
		const guarded = async (): Promise<T | Refused> => {
			try {
				return await run();
			} finally {
				unmark();
			}
		};
		if (locks === null) return guarded();
		return locks.request(CABLE_WRITE_LOCK, { ifAvailable: true }, async (lock) => {
			if (lock === null) return refuse('busy');
			const taken = holdAlive();
			if (taken !== true && !(await taken)) return refuse('error');
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
	 * with fresh flash/journal state (another tab may have written meanwhile).
	 */
	function authorize(prepared: Prepared): Authorized | Refused {
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
			crc: checklist.crc
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
		const { checklist, snapshot, preampDb, name, profile } = authorized;
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
				...(yolo ? { profile: 'yolo' as const, waived: [...checklist.waived] } : {})
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

	// A marker left by a tab closed mid-write becomes an `interrupted` entry and the rescue notice.
	const ready = recover();
	// A marker another tab writes later: wait for that writer, so its death surfaces here too.
	const stopWatching = inflight?.subscribe?.(() => watchWriter()) ?? null;

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

		/** Forgets a device in this page (closes it when possible). Refused while writing. */
		async disconnect(device: CableDevice | null = primary): Promise<boolean> {
			if (device === null || writing || !devices.includes(device)) return false;
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
			try {
				return await exclusive<WriteOutcome>(async () => {
					const guard = crossTabGuard();
					if (guard !== null) return guard;
					const authorized = authorize(prepared);
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
					const outcome = settle(result, label, authorized);
					lastOutcome = outcome;
					return outcome;
				});
			} catch (cause) {
				// The lock manager failed: nothing was sent.
				return refuse(refusalFromError(cause), { error: cause });
			} finally {
				release();
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
				return await exclusive<QueueOutcome>(async () => {
					const guard = crossTabGuard();
					if (guard !== null) return guard;
					const authorized = authorize(prepared);
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
					results.forEach((result, index) => {
						const item = items[index];
						if (item === undefined) return;
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
						items: items.map((item) => ({ ...item }))
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
			listeners.clear();
			disposed = true;
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
