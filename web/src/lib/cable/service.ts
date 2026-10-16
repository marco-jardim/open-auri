/**
 * Cable service (T2.7): support detection, connection, pre-write checklist, real and
 * simulated writes, journal, rescue after interruption and the X9 multi-cable queue.
 *
 * Every write goes through, in this order: a fresh single-use gesture token, the
 * checklist (gate on a snapshot, confirmations, 2 s spacing), then `writeCurve` /
 * `writeMany` from `open-auri/transport`, which run `gateForWrite` again on that
 * snapshot. Nothing is ever retried or written automatically.
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
import { evaluateChecklist } from './checklist.ts';
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
	WriteRequest,
	WriteResult,
	Written
} from './types.ts';

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

	function context(): ChecklistContext {
		const now = nowMs();
		if (mode === 'simulated') {
			return {
				nowMs: now,
				flash: flashView('simulated', simulatedFlash, now),
				lastWrittenLevelDb: simulatedLevelDb,
				sessionWriteCount: simulatedFlash.session,
				lastJournalStatus: null
			};
		}
		return {
			nowMs: now,
			flash: flashView('real', deps.flash.get(), now),
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

	function addDevice(device: CableDevice) {
		if (!devices.includes(device)) devices.push(device);
		primary ??= device;
		connection = 'connected';
	}

	function onConnect(event: Event) {
		const device = deviceOf(event);
		if (!isCableDevice(device)) return;
		addDevice(device);
		emit();
	}

	function onDisconnect(event: Event) {
		const device = deviceOf(event);
		if (!devices.includes(device as CableDevice)) return;
		devices = devices.filter((candidate) => candidate !== device);
		if (primary === device) primary = devices[0] ?? null;
		connection = primary === null ? 'disconnected' : 'connected';
		emit();
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
	 * Common gate in front of every write path. Reads the request exactly once and returns
	 * the captured values (the gate's frozen snapshot, preamp, experimental flag, name)
	 * that the checklist evaluated; everything downstream uses only these. Or a refusal.
	 */
	function authorize(request: WriteRequest): Authorized | Refused {
		// The token is spent first, whatever happens next: a refused attempt cannot be replayed.
		const gesture = request.gesture;
		if (!consumeGestureToken(gesture, nowMs())) return refuse('gesture');
		if (writing) return refuse('busy');
		const captured = input(request);
		const rawName: unknown = request.name;
		const checklist = evaluateChecklist(captured, context());
		if (!checklist.canWrite || checklist.snapshot === null || checklist.crc === null) {
			return refuse('checklist', { checklist });
		}
		return {
			checklist,
			snapshot: checklist.snapshot,
			preampDb: captured.preampDb,
			experimental: captured.experimental,
			name: truncate(typeof rawName === 'string' ? rawName : '', 48)
		};
	}

	/** Journal, flash, rescue and events for one device sequence that started I/O. */
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
			simulatedFlash = recordWrite(simulatedFlash, at);
			if (result.status === 'ok') simulatedLevelDb = checklist.newLevelDb;
		} else {
			// Counted per attempt that reached the cable (conservative for wear and spacing).
			deps.flash.record(at);
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

		/** Restores devices the page was already allowed to use (`hid.getDevices()`). */
		async restore(): Promise<readonly CableDevice[]> {
			if (hid.getDevices === undefined) return [];
			try {
				const permitted = await hid.getDevices();
				for (const device of permitted) if (isCableDevice(device)) addDevice(device);
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
			devices = devices.filter((candidate) => candidate !== device);
			if (primary === device) primary = devices[0] ?? null;
			connection = primary === null ? 'disconnected' : 'connected';
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

		/** Writes to the selected device. Refuses without a fresh gesture, a passing checklist or a device. */
		async write(request: WriteRequest): Promise<WriteOutcome> {
			const authorized = authorize(request);
			if ('status' in authorized) return authorized;
			const { checklist, snapshot, preampDb, experimental } = authorized;
			const device = primary;
			if (device === null) return refuse('no-device', { checklist });
			const label = labelOf(device);
			writing = true;
			controller = new AbortController();
			emit();
			let result: WriteResult;
			try {
				const writeSignal = controller.signal;
				result = await withWriteFlag(() =>
					writeCurve(device, snapshot, preampDb, {
						experimental,
						signal: writeSignal,
						clock,
						hid
					})
				);
			} catch (cause) {
				// writeCurve only throws before any I/O: nothing reached the cable.
				writing = false;
				controller = null;
				return refuse(refusalFromError(cause), {
					checklist,
					gateReasons: gateReasonsOf(cause),
					error: cause
				});
			}
			writing = false;
			controller = null;
			const outcome = settle(result, label, authorized);
			lastOutcome = outcome;
			emit();
			return outcome;
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
			const authorized = authorize(request);
			if ('status' in authorized) return authorized;
			const { checklist, snapshot, preampDb, experimental } = authorized;
			if (
				list.length === 0 ||
				new Set(list).size !== list.length ||
				!list.every((device) => devices.includes(device))
			) {
				return refuse(list.length === 0 ? 'no-device' : 'unknown-device', { checklist });
			}
			const labels = list.map(labelOf);
			const items: QueueItem[] = labels.map((deviceLabel) => ({
				deviceLabel,
				status: 'pending',
				entry: null
			}));
			queue = { running: true, items };
			writing = true;
			controller = new AbortController();
			emit();
			let started = 0;
			const progressHid = observedHid(
				hid,
				() => {
					const item = items[started];
					if (item !== undefined) item.status = 'writing';
					emit();
				},
				() => {
					const item = items[started];
					if (item !== undefined) item.status = 'sent';
					started += 1;
					emit();
				}
			);
			let results: ManyResult[];
			try {
				const queueSignal = controller.signal;
				results = await withWriteFlag(() =>
					writeMany(list, snapshot, preampDb, {
						experimental,
						signal: queueSignal,
						clock,
						hid: progressHid
					})
				);
			} catch (cause) {
				// writeMany only throws before the first device is touched.
				writing = false;
				controller = null;
				queue = null;
				return refuse(refusalFromError(cause), {
					checklist,
					gateReasons: gateReasonsOf(cause),
					error: cause
				});
			}
			writing = false;
			controller = null;
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
			const outcome: QueueOutcome = {
				status: 'done',
				simulated: mode === 'simulated',
				items: items.map((item) => ({ ...item }))
			};
			emit();
			return outcome;
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
			listeners.clear();
			disposed = true;
		}
	};
}

export type CableService = ReturnType<typeof createCableService>;
