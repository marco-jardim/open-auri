/**
 * Cable service (T2.7): support detection, connection, pre-write checklist, real and
 * simulated writes, journal, rescue after interruption and the X9 multi-cable queue.
 *
 * Every write goes through, in this order: a fresh single-use gesture token, the
 * checklist (gate on a snapshot, confirmations, 2 s spacing), the cross-tab write lock
 * (Web Locks `oa-cable-write`, `ifAvailable`), the checklist again with fresh flash state,
 * then `writeCurve` / `writeMany` from `open-auri/transport`, which run `gateForWrite`
 * again on that snapshot. Nothing is ever retried or written automatically; the lock and
 * the in-flight marker only ever refuse.
 *
 * Before any I/O a marker (`oa.cable.inflight`) is persisted and, as each device sequence
 * starts, the flash attempt is recorded. A marker left behind by a closed tab becomes an
 * `interrupted` journal entry (and the rescue notice) on the next load.
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
	requestCable,
	systemClock,
	writeCurve,
	writeMany
} from 'open-auri/transport';
import { MIN_INTERVAL_MS, observeFlashState, recordWrite } from 'open-auri/policy';
import { NEUTRAL_BANDS, USB_PID, USB_VID } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import { evaluateChecklist, flashCountersOf } from './checklist.ts';
import { consumeGestureToken, createGestureToken, type GestureEventLike } from './gesture.ts';
import type {
	Band,
	CableDevice,
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
	Refused,
	RefusalReason,
	RescueState,
	WriteOutcome,
	WriteLockManager,
	WriteRequest,
	WriteResult,
	Written
} from './types.ts';

/** Web Locks name held from the in-lock authorization through settle, in every tab. */
export const CABLE_WRITE_LOCK = 'oa-cable-write';
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

/** Parses a persisted marker; null when it is unreadable or malformed. */
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
	return { at, crc, name, preampDb, bands: bands as Band[], device, tabId };
}

/** Event dispatched on `service.events` after each real, successful write (F4 outbox). */
let activeWrites = 0;
/**
 * Marks a write in progress on `window.__oaWriteInProgress` for the PWA update flow, which must
 * never reload the page mid-write (see web/src/lib/pwa/README.md). Counts overlapping writes.
 */
async function withWriteFlag<T>(run: () => Promise<T>): Promise<T> {
	const scope = globalThis as typeof globalThis & { __oaWriteInProgress?: boolean };
	activeWrites += 1;
	scope.__oaWriteInProgress = true;
	try {
		return await run();
	} finally {
		activeWrites -= 1;
		scope.__oaWriteInProgress = activeWrites > 0;
	}
}
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
 * device sequence inside `writeMany` are observable. Listeners are forwarded to the
 * real HID unchanged, so disconnect detection is identical.
 */
function observedHid(base: HidLike, onStart: () => void, onEnd: () => void): HidLike {
	return {
		requestDevice: (options) => base.requestDevice(options),
		addEventListener(type, listener) {
			base.addEventListener(type, listener);
			if (type === 'disconnect') onStart();
		},
		removeEventListener(type, listener) {
			base.removeEventListener(type, listener);
			if (type === 'disconnect') onEnd();
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
	/** Raw markers this instance already turned into a journal entry (never block twice on one). */
	const recoveredMarkers = new Set<string>();
	let recheck: ReturnType<typeof setTimeout> | null = null;

	const lastJournal = deps.journal.last();
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

	function context(): ChecklistContext {
		const now = nowMs();
		if (mode === 'simulated') {
			return {
				nowMs: now,
				flash: currentFlash(now),
				lastWrittenLevelDb: simulatedLevelDb,
				sessionWriteCount: simulatedFlash.session,
				lastJournalStatus: null
			};
		}
		return {
			nowMs: now,
			flash: currentFlash(now),
			lastWrittenLevelDb: deps.lastWrittenLevelDb(),
			sessionWriteCount: deps.sessionWriteCount(),
			lastJournalStatus: deps.journal.last()?.status ?? null
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

	/** With no explicit target, the single connected cable is the (visible) target. */
	function implyTarget() {
		if (primary === null && devices.length === 1) primary = devices[0] ?? null;
	}

	function removeDevice(device: CableDevice) {
		devices = devices.filter((candidate) => candidate !== device);
		// Never switch silently to another of several cables: the user must choose again.
		if (primary === device) primary = null;
		implyTarget();
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
	 */
	function recoverMarker(raw: string, marker: InflightMarker | null): boolean {
		if (inflight === null || inflight.read() !== raw) return false;
		recoveredMarkers.add(raw);
		if (marker !== null) {
			const entry: JournalEntry = {
				schema: 1,
				at: marker.at,
				name: truncate(marker.name, 48),
				crc: marker.crc,
				preampDb: marker.preampDb,
				bands: copyBands(marker.bands),
				status: 'interrupted',
				device: truncate(marker.device, 64)
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
				reportsSent: null
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
		if (disposed || held === true) return;
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

	/**
	 * Inside the write lock: refuses while another tab's marker is live. A marker from a tab
	 * that is gone is recovered (journal + rescue) and this attempt is refused too, so the
	 * user sees the interruption before any new byte is sent.
	 */
	function crossTabGuard(): Refused | null {
		if (inflight === null) return null;
		const raw = inflight.read();
		if (raw === null || recoveredMarkers.has(raw)) return null;
		const marker = parseInflightMarker(raw);
		// Our own marker that could not be removed after its write settled.
		if (marker !== null && marker.tabId === tabId) return null;
		const fresh = marker !== null && Math.abs(nowMs() - marker.at) <= INFLIGHT_STALE_MS;
		// Without Web Locks a fresh marker means another tab may be writing right now.
		if (locks === null && fresh) return refuse('busy');
		recoverMarker(raw, marker);
		return refuse('busy');
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
			tabId
		};
		ownMarker = marker;
		if (inflight.write(JSON.stringify(marker))) return true;
		console.warn('cable in-flight marker could not be persisted');
		// Without Web Locks the marker is the only cross-tab guard: never write unguarded.
		return locks !== null;
	}

	/** Removes this instance's marker (never another tab's). Runs in `finally` of every write. */
	function unmark() {
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
	 * A device sequence is about to send its first byte (gates passed, device locked): count
	 * the flash attempt now, so a tab closed mid-write still leaves it recorded, and point the
	 * marker at this device. Pre-I/O refusals never reach this point and are not counted.
	 */
	function sequenceStarting(label: string) {
		const at = nowMs();
		if (mode === 'simulated') {
			simulatedFlash = recordWrite(simulatedFlash, at);
			return;
		}
		// Counted per attempt that reaches the cable (conservative for wear and spacing).
		deps.flash.record(at);
		const device = truncate(label, 64);
		if (ownMarker !== null && inflight !== null && ownMarker.device !== device) {
			ownMarker = { ...ownMarker, at, device };
			if (!inflight.write(JSON.stringify(ownMarker))) {
				console.warn('cable in-flight marker could not be updated');
			}
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

	/**
	 * Runs `run` holding the cross-tab lock; refuses `busy` when another tab holds it. The
	 * marker is removed before the lock is released, so "marker present and lock free" always
	 * means the writing tab is gone.
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
		return locks.request(CABLE_WRITE_LOCK, { ifAvailable: true }, async (lock) =>
			lock === null ? refuse('busy') : guarded()
		);
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
		return {
			bands,
			preampDb,
			experimental,
			confirmations: { volumeLowered, keepConnected, experimental: experimentalConfirmed }
		};
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
		const verdict = gateForWrite(captured.bands, captured.preampDb, {
			experimental: captured.experimental
		});
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
	 * was already recorded by `sequenceStarting`, before the first byte).
	 */
	function settle(result: WriteResult, label: string, authorized: Authorized): Written {
		const { checklist, snapshot, preampDb, name } = authorized;
		const simulated = mode === 'simulated';
		const at = nowMs();
		const status: JournalStatus =
			result.status === 'ok' ? (simulated ? 'simulated' : 'ok') : 'interrupted';
		let entry: JournalEntry | null = null;
		if (!simulated || result.status === 'ok') {
			entry = {
				schema: 1,
				at,
				name,
				crc: result.crc,
				preampDb,
				bands: copyBands(snapshot),
				status,
				device: truncate(label, 64)
			};
			try {
				deps.journal.append(entry);
			} catch (cause) {
				error = 'journal-failed';
				console.error('cable journal append failed', cause);
			}
		}
		if (simulated) {
			if (result.status === 'ok') simulatedLevelDb = checklist.newLevelDb;
		} else {
			if (result.status === 'ok') {
				rescue = null;
			} else {
				rescue = { at, deviceLabel: label, reportsSent: result.reportsSent };
			}
		}
		if (!simulated && result.status === 'ok' && entry !== null) {
			const detail: CableWrittenDetail = {
				entry,
				crc: result.crc,
				preampDb,
				bands: copyBands(snapshot),
				deviceLabel: label,
				at,
				levelDb: checklist.newLevelDb
			};
			events.dispatchEvent(new CustomEvent(CABLE_WRITTEN_EVENT, { detail }));
		}
		return {
			status: result.status === 'ok' ? (simulated ? 'simulated' : 'ok') : 'interrupted',
			simulated,
			result,
			entry,
			deviceLabel: label,
			crc: result.crc,
			levelDb: checklist.newLevelDb
		};
	}

	// A marker left by a tab closed mid-write becomes an `interrupted` entry and the rescue notice.
	const ready = recover();

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
					const { checklist, snapshot, preampDb, experimental } = authorized;
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
					const progressHid = observedHid(
						hid,
						() => {
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
							started += 1;
							emit();
						}
					);
					let results: ManyResult[];
					try {
						results = await withWriteFlag(() =>
							writeMany(list, snapshot, preampDb, {
								experimental,
								signal: abort.signal,
								clock,
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
			listeners.clear();
			disposed = true;
		}
	};
}

export type CableService = ReturnType<typeof createCableService>;
