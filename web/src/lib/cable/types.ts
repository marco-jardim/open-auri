/**
 * Types of the cable service. Core types are derived from the `open-auri` package's
 * function signatures (the package index only re-exports values).
 */
import type { writeCurve, writeMany } from 'open-auri/transport';
import type { gateForWrite } from 'open-auri/safety';
import type { canWriteNow, lastEntry, loudnessWarning } from 'open-auri/policy';

export type WriteOptions = NonNullable<Parameters<typeof writeCurve>[3]>;
export type CableDevice = Parameters<typeof writeCurve>[0];
export type Band = Parameters<typeof writeCurve>[1][number];
export type Clock = NonNullable<WriteOptions['clock']>;
export type WriteResult = Awaited<ReturnType<typeof writeCurve>>;
export type ManyResult = Awaited<ReturnType<typeof writeMany>>[number];
export type GateResult = ReturnType<typeof gateForWrite>;
export type GateReason = GateResult['reasons'][number];
export type ReasonCode = GateReason['code'];
export type FlashState = Parameters<typeof canWriteNow>[0];
export type JournalEntry = NonNullable<ReturnType<typeof lastEntry>>;
export type JournalStatus = JournalEntry['status'];
export type LoudnessResult = ReturnType<typeof loudnessWarning>;

/** `{vendorId, productId}` filter, as in WebHID. */
export interface CableFilter {
	vendorId?: number;
	productId?: number;
}

/**
 * Subset of `navigator.hid` the service uses. `FakeHID` (simulated mode, tests) and
 * the browser's `navigator.hid` both satisfy it.
 */
export interface HidLike {
	requestDevice(options: { filters: CableFilter[] }): Promise<CableDevice[]>;
	getDevices?(): Promise<CableDevice[]>;
	addEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
	removeEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
}

/** Write journal port (the app state persists it; see `open-auri/policy` journal schema). */
export interface JournalPort {
	append(entry: JournalEntry): void;
	last(): JournalEntry | null;
}

/**
 * Flash bookkeeping port: `get()` returns the current state (pure: it may run inside a
 * derived), `record(nowMs)` persists one write attempt (called before the first byte).
 */
export interface FlashPort {
	get(): FlashState;
	record(nowMs: number): void;
	/**
	 * A write sequence that sent bytes ended at `nowMs` (ok or interrupted): advance
	 * `lastWriteAt` to it without counting another write, so the 2 s spacing is measured from
	 * the end of the write, not from its start.
	 */
	touch(nowMs: number): void;
	/**
	 * Optional: re-reads state other tabs persisted. Called inside the write lock, right before
	 * the second checklist evaluation (never from a derived).
	 */
	sync?(nowMs: number): void;
}

export interface UserActivationLike {
	readonly isActive: boolean;
}

/** A granted Web Lock (only its name is read). */
export interface WriteLock {
	readonly name?: string;
}

/**
 * Subset of the Web Locks API (`navigator.locks`) used for cross-tab write exclusion.
 * `request` is always called with `{ ifAvailable: true }`: the callback receives `null`
 * when another tab holds the lock, and the lock is held until the callback settles.
 */
export interface WriteLockManager {
	request<T>(
		name: string,
		options: { ifAvailable: true },
		callback: (lock: WriteLock | null) => Promise<T>
	): Promise<T>;
	query?(): Promise<{ held?: readonly WriteLock[] }>;
}

/**
 * Persisted in-flight write marker port (one `localStorage` key shared by every tab).
 * `write(null)` removes it; `write` returns false when the value could not be persisted.
 */
export interface InflightPort {
	read(): string | null;
	write(value: string | null): boolean;
}

/** In-flight marker: written before any I/O, removed when the write settles. */
export interface InflightMarker {
	/** Epoch ms when the marker was written (or the current device sequence started). */
	at: number;
	crc: number;
	name: string;
	preampDb: number;
	bands: Band[];
	/** Label of the device being written. */
	device: string;
	/** Service instance (tab/page load) that owns the write. */
	tabId: string;
}

export interface CableServiceDeps {
	/**
	 * `undefined`: detect (`navigator.hid` in a secure context ⇒ real, otherwise simulated).
	 * `null`: force simulated mode. An object: real mode through that HID.
	 */
	hid?: HidLike | null;
	journal: JournalPort;
	flash: FlashPort;
	/** Epoch milliseconds (integer). */
	now(): number;
	/**
	 * `levelDb` of the last curve actually written to the cable, if known. Derive it from the
	 * persisted journal (last `ok` entry, `writtenLevelDb`) so it survives tabs and reloads.
	 */
	lastWrittenLevelDb(): number | null;
	/** Real writes in this browser session. */
	sessionWriteCount(): number;
	/** Timing of the write sequence; defaults to the transport's `systemClock`. */
	clock?: Clock;
	/** Reads `navigator.userActivation`; `null` when unavailable. Defaults to the browser's. */
	userActivation?: () => UserActivationLike | null;
	/**
	 * Cross-tab write lock. `undefined`: `navigator.locks` in a browser window (none elsewhere).
	 * `null`: no Web Locks; the persisted in-flight marker is then the cross-tab guard.
	 */
	locks?: WriteLockManager | null;
	/**
	 * In-flight marker storage. `undefined`: `localStorage` key `oa.cable.inflight` in a browser
	 * window (none elsewhere). `null`: no marker.
	 */
	inflight?: InflightPort | null;
	/** Identifies this service instance in the in-flight marker; random by default. */
	tabId?: string;
}

export type CableMode = 'real' | 'simulated';
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface Confirmations {
	/** "Abaixei o volume". */
	volumeLowered: boolean;
	/** "Não vou desconectar durante a gravação (≈0,3 s)". */
	keepConnected: boolean;
	/** Experimental kinds (HS/LP/HP) acknowledged. */
	experimental: boolean;
}

export interface ChecklistInput {
	bands: readonly Band[];
	preampDb: number;
	/** Lets the gate accept HS/LP/HP (the experimental confirmation is then required). */
	experimental: boolean;
	confirmations: Confirmations;
}

export interface ChecklistContext {
	nowMs: number;
	flash: FlashState;
	lastWrittenLevelDb: number | null;
	sessionWriteCount: number;
	lastJournalStatus: JournalStatus | null;
}

export type LampId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'k';
export type LampState = 'ok' | 'fail' | 'unknown';

export interface ReasonView {
	code: ReasonCode;
	/** Paraglide message key (`cable_reason_*`). */
	messageKey: ReasonMessageKey;
	stage: number | null;
	value: number | null;
	limit: number | null;
}

export interface Lamp {
	id: LampId;
	state: LampState;
	labelKey: LampLabelKey;
	reasons: ReasonView[];
}

export type ChecklistItemId = 'gate' | 'volume' | 'connection' | 'experimental' | 'spacing';

export interface ChecklistItem {
	id: ChecklistItemId;
	required: boolean;
	satisfied: boolean;
}

export interface ChecklistResult {
	gateOk: boolean;
	lamps: Lamp[];
	reasons: ReasonView[];
	/** CRC-16 of the gated payload, when the codec accepted the curve. */
	crc: number | null;
	/** Frozen snapshot the gate evaluated (what a write sends), when available. */
	snapshot: readonly Readonly<Band>[] | null;
	newLevelDb: number | null;
	loudness: LoudnessResult & { text: string };
	experimentalRequired: boolean;
	experimentalText: string;
	spacing: { ok: boolean; waitMs: number };
	counters: { session: number; day: number; total: number };
	dailyNotice: { show: boolean; text: string };
	items: ChecklistItem[];
	canWrite: boolean;
}

export type ReasonMessageKey =
	| 'cable_reason_a_b0'
	| 'cable_reason_a_b2'
	| 'cable_reason_a_neg_a1'
	| 'cable_reason_a_b1'
	| 'cable_reason_a_neg_a2'
	| 'cable_reason_b_pole_radius'
	| 'cable_reason_c_section_peak'
	| 'cable_reason_d_prefix_peak'
	| 'cable_reason_e_output_audible'
	| 'cable_reason_e_output_full'
	| 'cable_reason_f_codec'
	| 'cable_reason_g_preamp'
	| 'cable_reason_k_kind_not_allowed'
	| 'cable_reason_d7_pk_boost_above_16k'
	| 'cable_reason_d7_boost_q'
	| 'cable_reason_unknown';

export type LampLabelKey =
	| 'cable_lamp_a'
	| 'cable_lamp_b'
	| 'cable_lamp_c'
	| 'cable_lamp_d'
	| 'cable_lamp_e'
	| 'cable_lamp_f'
	| 'cable_lamp_g'
	| 'cable_lamp_k';

/** Opaque, single-use proof of a trusted click/keypress (see `createGestureToken`). */
export interface GestureToken {
	readonly kind: 'cable-gesture';
}

export interface WriteRequest extends ChecklistInput {
	gesture: GestureToken | null | undefined;
	/** Curve name for the journal (truncated to 48 characters). */
	name?: string;
}

export interface QueueRequest extends WriteRequest {
	/** Devices the user listed and confirmed, in order (must be connected devices of the service). */
	devices: readonly CableDevice[];
}

export type RefusalReason =
	| 'gesture'
	| 'busy'
	| 'no-device'
	| 'unknown-device'
	| 'checklist'
	| 'gate'
	| 'unusable'
	| 'aborted'
	| 'error';

export interface Refused {
	status: 'refused';
	reason: RefusalReason;
	checklist?: ChecklistResult;
	gateReasons?: readonly GateReason[];
	error?: unknown;
}

export interface Written {
	status: 'ok' | 'interrupted' | 'simulated';
	simulated: boolean;
	result: WriteResult;
	/** Journal entry appended (null for an interrupted simulated write, which touches no cable). */
	entry: JournalEntry | null;
	deviceLabel: string;
	crc: number;
	/** `levelDb` of the written curve (the journal entry of an `ok` write carries it implicitly). */
	levelDb: number | null;
}

export type WriteOutcome = Refused | Written;

export type QueueItemStatus =
	| 'pending'
	| 'writing'
	/** The sequence for this cable ended; its result is known when the whole queue ends. */
	| 'sent'
	| 'ok'
	| 'simulated'
	| 'interrupted'
	| 'failed'
	| 'skipped';

export interface QueueItem {
	deviceLabel: string;
	status: QueueItemStatus;
	entry: JournalEntry | null;
	error?: unknown;
}

export interface QueueState {
	running: boolean;
	items: QueueItem[];
}

export type QueueOutcome = Refused | { status: 'done'; simulated: boolean; items: QueueItem[] };

export interface RescueState {
	at: number;
	deviceLabel: string | null;
	/** Data reports the cable accepted before the interruption (null when restored from the journal). */
	reportsSent: number | null;
}

export interface CableState {
	mode: CableMode;
	connection: ConnectionState;
	/** Device used by `write()`. */
	device: CableDevice | null;
	deviceLabel: string | null;
	/** All connected, permitted devices (the X9 queue candidates). */
	devices: readonly CableDevice[];
	deviceLabels: readonly string[];
	writing: boolean;
	rescue: RescueState | null;
	queue: QueueState | null;
	lastOutcome: WriteOutcome | null;
	/** Last connection error code, if any. */
	error: 'request-failed' | 'restore-failed' | 'journal-failed' | null;
}

export interface CableWrittenDetail {
	entry: JournalEntry;
	crc: number;
	preampDb: number;
	bands: Band[];
	deviceLabel: string;
	at: number;
	levelDb: number | null;
}
