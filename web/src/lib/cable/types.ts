/**
 * Types of the cable service. Core types are derived from the `open-auri` package's
 * function signatures (the package index only re-exports values).
 */
import type { writeCurve, writeMany } from 'open-auri/transport';
import type { gateForWrite } from 'open-auri/safety';
import type { canWriteNow, lastEntry, loudnessWarning } from 'open-auri/policy';
import type { NativeWriteFreshness } from './native-freshness.ts';

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
	/**
	 * Optional: every entry, oldest first, as persisted (shared by every tab). The live preview
	 * reads each cable's saved curve from it; without it only `last()` is consulted.
	 */
	readonly entries?: readonly JournalEntry[];
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
 * Writes always call `request` with `{ ifAvailable: true }`: the callback receives `null`
 * when another tab holds the lock, and the lock is held until the callback settles. A writing
 * tab also takes its liveness lock `oa-cable-alive:<tabId>` that way and holds it until it is
 * disposed or dies. Only the interruption watcher waits (`{ signal }`, no `ifAvailable`), and
 * only on another tab's liveness lock, never on the write lock: it is granted once that tab is
 * gone and then only records, never writes.
 */
export interface WriteLockManager {
	request<T>(
		name: string,
		options: { ifAvailable?: true; signal?: AbortSignal },
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
	/**
	 * Optional: calls `listener` when another tab changed the marker (`storage` events). Returns
	 * the unsubscribe function.
	 */
	subscribe?(listener: () => void): () => void;
}

/** In-flight marker: written before any I/O, removed when the write settles. */
export interface InflightMarker {
	/** Epoch ms when the marker was written (or the current device sequence started). */
	at: number;
	crc: number;
	name: string;
	preampDb: number;
	bands: Band[];
	/** Label of the device being written (the last one written when `between` is true). */
	device: string;
	/** Service instance (tab/page load) that owns the write. */
	tabId: string;
	/**
	 * X9 queue between two cables: the previous cable committed (and is journaled) and the next
	 * one has not started. No cable is being written, so recovering it records nothing.
	 */
	between?: true;
	/**
	 * Modo YOLO write: recovered as a YOLO `interrupted` entry. Absent on standard writes and on
	 * markers persisted before it existed (both recovered as standard).
	 */
	profile?: 'yolo';
	/**
	 * The class-2 codes the YOLO write waived (only with `profile: 'yolo'`; at most
	 * `JOURNAL_WAIVED_MAX`, waivable codes only), copied into the recovered entry.
	 */
	waived?: ReasonCode[];
	/**
	 * Native writes: the deploy check that cleared it (`live` or the offline `last-good`
	 * record), copied into the recovered entry. Absent on desktop and on older markers.
	 */
	freshness?: NativeWriteFreshness;
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
	/**
	 * Modo YOLO session state of this tab (memory only, `lib/state/yolo.svelte.ts`): true while
	 * the phrase was typed in this tab and YOLO is on. Read at each checklist evaluation; a YOLO
	 * write is refused unless it returns true. Defaults to `() => false`.
	 */
	yoloSession?: () => boolean;
	/**
	 * Live preview switch; defaults to `LIVE_APPLY_POLICY` (`live-policy.ts`). Injectable for
	 * tests.
	 */
	livePolicy?: { readonly enabled: boolean };
	/**
	 * Native (Android) transport only: whether the app's write guard accepts live applies
	 * (`detectNativeCable()` → `liveApply`, passed by `mountNativeCable`). Absent or false:
	 * native is not live-capable.
	 */
	nativeLiveApply?: boolean;
	/**
	 * Live preview marker storage (S5). `undefined`: `localStorage` key `oa.cable.live` in a
	 * browser window (none elsewhere). `null`: no marker (no orphan detection).
	 */
	liveMarker?: InflightPort | null;
}

/**
 * Persisted live preview marker (`oa.cable.live`, S5): written before the first live apply that
 * differs from the saved curve, removed once the cable plays the saved curve again (a revert, a
 * save) or is unplugged. Left behind by a tab that is gone, it means the cable may still play an
 * unsaved preview.
 */
export interface LiveMarker {
	/** Service instance (tab/page load) that applied the preview. */
	tabId: string;
	/** Label of the device playing the preview. */
	device: string;
	/** CRC-16 of the last live curve sent. */
	crc: number;
	/** Epoch ms of the last update. */
	at: number;
}

/** A live marker whose tab is gone: the cable may still play an unsaved preview. */
export interface LiveOrphan {
	crc: number;
	/** Epoch ms of the orphan preview's last apply. */
	at: number;
	/** Label of the cable it was applied to. */
	deviceLabel: string;
}

/** Gate profile of a write: only `'yolo'` (Modo YOLO) changes anything. */
export type WriteProfile = 'standard' | 'yolo';

export type CableMode = 'real' | 'simulated';
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface Confirmations {
	/** "Abaixei o volume". */
	volumeLowered: boolean;
	/** "Não vou desconectar durante a gravação (≈0,3 s)". */
	keepConnected: boolean;
	/** Experimental kinds (HS/LP/HP) acknowledged. */
	experimental: boolean;
	/**
	 * Modo YOLO, per write: "Gravar curva YOLO: fora do envelope observado (…). Abaixei o volume e
	 * aceito o risco." Required on every YOLO write; never remembered between writes.
	 */
	yoloWrite?: boolean;
	/** Android app writing is not validated on a real cable; fresh acknowledgement per checklist. */
	androidUntested?: boolean;
}

export interface ChecklistInput {
	bands: readonly Band[];
	preampDb: number;
	/** Lets the gate accept HS/LP/HP (the experimental confirmation is then required). */
	experimental: boolean;
	confirmations: Confirmations;
	/**
	 * `'yolo'`: gate with the YOLO profile (class-2 reasons waived, class 1 and
	 * `d:prefix-peak-full` still block) and require `yolo-session` and `yolo-write`. Anything
	 * else is the standard profile.
	 */
	profile?: WriteProfile;
}

export interface ChecklistContext {
	/** Native app transport, desktop WebHID or simulation; absent means desktop. */
	cableMode?: CableMode | 'native';
	/** Defaults to ANDROID_WRITE_VALIDATED; injectable for checklist tests. */
	androidWriteValidated?: boolean;
	nowMs: number;
	flash: FlashState;
	lastWrittenLevelDb: number | null;
	/**
	 * `levelDb` of the curve a live (no-flash) session is playing right now, when known. When
	 * finite it replaces `lastWrittenLevelDb` in the loudness comparison: it is what the user is
	 * actually hearing (S7, issue #70).
	 */
	liveLevelDb?: number | null;
	sessionWriteCount: number;
	lastJournalStatus: JournalStatus | null;
	/** Modo YOLO is on in this tab, with the phrase typed (see `CableServiceDeps.yoloSession`). */
	yoloSession?: boolean;
}

export type LampId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'k';
/** `waived`: only class-2 reasons the YOLO profile waived (amber, "dispensado (YOLO)"). */
export type LampState = 'ok' | 'fail' | 'waived' | 'unknown';

export interface ReasonView {
	code: ReasonCode;
	/** Paraglide message key (`cable_reason_*`). */
	messageKey: ReasonMessageKey;
	stage: number | null;
	value: number | null;
	limit: number | null;
	/** Waived by the YOLO profile (shown, never blocking). */
	waived?: true;
}

export interface Lamp {
	id: LampId;
	state: LampState;
	labelKey: LampLabelKey;
	/** Blocking reasons first, then the waived ones (flagged `waived`). */
	reasons: ReasonView[];
}

export type ChecklistItemId =
	| 'gate'
	| 'volume'
	| 'connection'
	| 'experimental'
	| 'spacing'
	/** Modo YOLO on in this tab, phrase typed (required for a YOLO write). */
	| 'yolo-session'
	/** The per-write YOLO confirmation (required for every YOLO write). */
	| 'yolo-write'
	/** Explicit acknowledgement while Android writes have not been validated on a real cable. */
	| 'android-untested';

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
	/** Gate profile the verdict used. */
	profile: WriteProfile;
	/** Codes the YOLO profile waived, once each (empty in the standard profile). */
	waived: ReasonCode[];
	/** The waived reasons with their values (amber lamps). */
	waivedReasons: ReasonView[];
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
	| 'cable_reason_d_prefix_peak_full'
	| 'cable_reason_d_prefix_peak_extended'
	| 'cable_reason_e_output_audible'
	| 'cable_reason_e_output_extended'
	| 'cable_reason_e_output_full'
	| 'cable_reason_f_codec'
	| 'cable_reason_g_preamp'
	| 'cable_reason_k_kind_not_allowed'
	| 'cable_reason_d7_pk_boost_above_16k'
	| 'cable_reason_d7_boost_q'
	| 'cable_reason_d7_boost_above_20k'
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
	/**
	 * Another tab died mid-write (its marker was left behind): the interruption was just recorded
	 * and the rescue notice raised; nothing was sent by this attempt.
	 */
	| 'interrupted-elsewhere'
	/** Modo YOLO writes one cable at a time: the X9 queue refuses a YOLO request. */
	| 'yolo-queue'
	/** Another tab runs a live preview session (S5): its cable may be playing an unsaved curve. */
	| 'live-elsewhere'
	/**
	 * A blind comparison runs: nothing is saved until it ends (a save would tell the candidates
	 * apart). "Salvar esta" saves a candidate's original once the comparison ended.
	 */
	| 'blind'
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
	/** Native writes only: whether the deploy check was live or the offline last-good record. */
	freshness?: NativeWriteFreshness;
}

export type WriteOutcome = Refused | Written;

export type QueueItemStatus =
	| 'pending'
	| 'writing'
	/** The sequence for this cable ended; its result is settled right after (same task). */
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

export type QueueOutcome =
	| Refused
	| {
			status: 'done';
			simulated: boolean;
			items: QueueItem[];
			/** Native queues only, as `Written.freshness`. */
			freshness?: NativeWriteFreshness;
	  };

export interface RescueState {
	at: number;
	deviceLabel: string | null;
	/** Data reports the cable accepted before the interruption (null when restored from the journal). */
	reportsSent: number | null;
	/**
	 * True when the interruption was detected in this page session (a write here, or a marker
	 * recovered now); absent when restored from the journal on load, so it is not re-announced.
	 */
	fresh?: true;
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
	/** Last connection feedback/error code; request-empty is informational, not a failure. */
	error: 'request-empty' | 'request-failed' | 'restore-failed' | 'journal-failed' | null;
	/** Whether this transport may run a live (no-flash) preview session (`LIVE_APPLY_POLICY`). */
	liveCapable: boolean;
	/** The live preview session (the last one, `status: 'ended'`, until a new one starts). */
	live: LiveState | null;
	/**
	 * A live marker left by a tab that is gone (S5): the cable may still play an unsaved preview
	 * ("desconecte e reconecte"). The loudness of a write is then compared with an unknown state.
	 * Cleared when that cable is unplugged, plugged in again (its RAM was lost), saved or
	 * reverted, or by `dismissLiveOrphan` ("Já desconectei"). Absent or null: none.
	 */
	liveOrphan?: LiveOrphan | null;
}

/** A curve for the live preview: read once when it is queued. */
export interface LiveCurve {
	bands: readonly Band[];
	preampDb: number;
	/** `startLive` only: lets the gate accept HS/LP/HP for the whole session. */
	experimental?: boolean;
	/** `startLive` only: gate profile of the whole session (`'yolo'` needs Modo YOLO on). */
	profile?: WriteProfile;
}

/** The curve the cable is playing from RAM after a successful live apply (or a commit). */
export interface LiveApplied {
	crc: number;
	bands: Band[];
	preampDb: number;
	levelDb: number | null;
	/** Epoch ms. */
	at: number;
	profile?: 'yolo';
}

export type LiveStatus = 'starting' | 'applying' | 'live' | 'held' | 'unknown' | 'ended';

export interface LiveHoldState {
	/**
	 * `loudness`: ≥ 3 dB above the confirmed level; `gate`: the newest curve fails the gate
	 * (never confirmable); `unknown-state`: what the cable plays is not known; `experimental`:
	 * the curve has HS/LP/HP or a band above 20 kHz and the session's start checklist did not
	 * confirm experimental filters (`confirmLive` with `confirmations.experimental`).
	 */
	reason: 'loudness' | 'gate' | 'unknown-state' | 'experimental';
	deltaDb?: number;
	gateReasons?: readonly GateReason[];
	/**
	 * `'saved'`: the held curve is the cable's saved curve (a revert held for loudness, or an
	 * unknown-state revert turned into one); `confirmLive` applies it. Absent: an edit.
	 */
	curve?: 'saved';
}

export type LiveEndedReason =
	/** `stopLive({ revert: false })`: the cable keeps the live curve until it is unplugged. */
	| 'stopped'
	/** `stopLive({ revert: true })`: the last saved curve was applied live, then the session ended. */
	| 'reverted'
	/**
	 * The cable was unplugged: it went back to the saved (committed) curve. Also set on a
	 * `stopped` or `forgotten` session when its cable is unplugged later.
	 */
	| 'disconnected'
	/** The page forgot the device (`disconnect()`): the cable keeps the live curve. */
	| 'forgotten';

export interface LiveState {
	deviceLabel: string;
	status: LiveStatus;
	/** What the cable plays (null until the first apply succeeds). */
	applied: LiveApplied | null;
	/** A newer curve waits for the scheduler. */
	pending: boolean;
	/** The level the user last confirmed (start, confirm, revert or a save). */
	ackLevelDb: number | null;
	hold: LiveHoldState | null;
	/** Live applies in this session that reached report 8 successfully. */
	applies: number;
	/** Successful live applies in this page (all sessions; memory only). */
	total: number;
	/** Why the last live apply failed (it is never retried automatically); null after a success. */
	lastError: unknown;
	endedReason?: LiveEndedReason;
	/**
	 * CRC-16 of the curve the session's cable holds in flash, as the service knows it (shared
	 * journal, this page's saves); null when unknown. Absent: not reported.
	 */
	savedCrc?: number | null;
	/**
	 * The session's comparison set (`startComparison`). When blind, `applied`, `ackLevelDb` and
	 * `savedCrc` are redacted (null / absent) for the whole session (also once it ended); a hold
	 * keeps only its `reason` (and `curve`), and `lastError` is only `'busy'` or `'error'`.
	 */
	comparison?: LiveComparisonState;
	/**
	 * The cable plays something other than its saved curve (a running session's curve that is
	 * not the saved one or is unknown; an ended session's curve kept on the cable). Set by the
	 * service in every state, blind included (it never tells candidates apart). When the service
	 * does not know the saved curve (`savedCrc` null), any applied curve counts as unsaved.
	 */
	playsUnsaved?: boolean;
	/**
	 * The cable applies a live EQ curve: the browser preview must stay flat (no EQ on top). Set by
	 * the service in every state, blind included.
	 */
	cableEq?: boolean;
}

export type LiveRefusalReason =
	| 'gesture'
	| 'busy'
	| 'no-device'
	| 'checklist'
	/** Live preview is off (`LIVE_APPLY_POLICY`) or not supported by this transport. */
	| 'unavailable'
	| 'no-session'
	/** `confirmLive` without a confirmable hold. */
	| 'no-hold'
	/** `confirmLive` on a gate hold: a curve the gate refuses is never sent. */
	| 'gate'
	/**
	 * `confirmLive` on an unknown-state hold whose curve is ≥ 3 dB above the confirmed level:
	 * nothing was sent, the hold became a loudness hold (confirm again to send it).
	 */
	| 'loudness'
	/** `revertLive` / `stopLive({ revert: true })` without a known saved curve. */
	| 'no-saved-curve'
	/**
	 * `revertLive` / `stopLive({ revert: true })`: the saved curve is not what the cable plays
	 * afterwards (`revertFailure` says why). `stopLive` keeps the session.
	 */
	| 'revert-failed'
	/** Another tab runs a live preview session (S5). */
	| 'live-elsewhere'
	/**
	 * `revertLive` / `stopLive({ revert: true })` while a comparison runs: end it with
	 * `endComparison({ revert: true })` instead (the session goes on, nothing sent).
	 */
	| 'comparison-active'
	| 'error';

/** Why a revert did not leave the cable on the saved curve. */
export type LiveRevertFailure =
	/**
	 * A hold stopped it (gate, experimental, unknown state, or loudness: the saved curve is ≥ 3 dB
	 * above the confirmed level and waits for `confirmLive`): see `LiveState.hold`.
	 */
	| 'held'
	/** What the cable plays is unknown (report 8 went out unconfirmed). */
	| 'unknown'
	/** The apply stopped before report 8 (the cable kept the previous curve), or failed. */
	| 'error'
	/** The cross-tab write lock stayed busy: nothing was sent. */
	| 'busy'
	/** The session ended meanwhile (unplugged, disposed). */
	| 'ended';

export interface LiveRefused {
	status: 'refused';
	reason: LiveRefusalReason;
	checklist?: ChecklistResult;
	error?: unknown;
	/** `revert-failed` only. */
	revertFailure?: LiveRevertFailure;
	/** `revert-failed` only: the session as it is after the attempt. */
	live?: LiveState | null;
}

export type LiveOutcome = LiveRefused | { status: 'accepted'; live: LiveState | null };

/** The last saved curve, for `revertLive` / `stopLive({ revert: true })`. */
export interface LiveSavedCurve {
	bands: readonly Band[];
	preampDb: number;
}

export interface LiveStartRequest {
	/** The curve to apply first; its `experimental`/`profile` hold for the whole session. */
	curve: LiveCurve;
	/** Same confirmations as a write, minus `keepConnected` (an unplug only reverts the cable). */
	confirmations: Partial<Confirmations> | undefined;
	gesture: GestureToken | null | undefined;
}

export interface LiveGestureRequest {
	gesture: GestureToken | null | undefined;
	/**
	 * `confirmLive` on an `experimental` hold: `experimental: true` is required (it then holds
	 * for the rest of the session). Ignored elsewhere.
	 */
	confirmations?: Partial<Pick<Confirmations, 'experimental'>>;
}

export interface LiveRevertRequest extends LiveGestureRequest {
	/**
	 * The last saved curve, used only when its payload CRC equals the session cable's saved
	 * curve: the newest `ok` journal entry naming that cable (`simulated` in simulated mode),
	 * or the last curve this page committed to it when that is newer. Otherwise that saved curve
	 * is applied instead; none known: refused `no-saved-curve`.
	 */
	saved?: LiveSavedCurve | null;
}

export interface LiveStopRequest {
	/** true: apply the saved curve live first (needs `gesture`), then end the session. */
	revert: boolean;
	gesture?: GestureToken | null;
	saved?: LiveSavedCurve | null;
}

// --- Comparison on the cable (issues #73/#74) -------------------------------------------------

/** A comparison candidate (read once). `profile: 'yolo'` is refused in the MVP. */
export type ComparisonCurve = LiveCurve;

export interface ComparisonOptions {
	/** Lower the louder candidates' preamp to the quietest level (never boost). */
	match: boolean;
	/** Only `'standard'` in the MVP (`'yolo'` is refused `yolo-unsupported`). */
	profile?: WriteProfile;
	/** Gate option of every apply (HS/LP/HP); OR-ed with each candidate's own flag. */
	experimental?: boolean;
}

export type ComparisonRefusalReason =
	/** Fewer than two candidates. */
	| 'too-few'
	/** A candidate (as given, or once matched: `matched`) fails the gate. */
	| 'gate'
	/** A candidate's level cannot be computed. */
	| 'level-unknown'
	/** Matching would put a candidate's preamp below −25.5 dB (the quiet one is never boosted). */
	| 'level-range'
	/** A candidate (or the request) needs the Modo YOLO profile: not in the MVP. */
	| 'yolo-unsupported'
	/** `startComparison` with a `first` index outside the set. */
	| 'bad-index'
	/** A candidate is missing or not an object (`index`). */
	| 'invalid'
	/** A blind comparison needs `match: true` (a level difference would tell candidates apart). */
	| 'blind-needs-match';

export interface ComparisonRefusal {
	reason: ComparisonRefusalReason;
	/** The candidate that refused the set. */
	index?: number;
	gateReasons?: readonly GateReason[];
	/** The refusal is about the level-matched curve, not the one given. */
	matched?: boolean;
	/** `level-range`: the matched preamp that fell below the floor. */
	preampDb?: number;
}

/** One pre-approved candidate: what is played (gated, level-matched) and the original. */
export interface ComparisonItem {
	index: number;
	/** The gate's snapshot of the played curve. */
	bands: Band[];
	/** Matched preamp (the original one when not lowered). */
	preampDb: number;
	/** CRC-16 of the played payload (changes with the preamp). */
	crc: number;
	/** `levelDb` of the played curve. */
	levelDb: number;
	/** `levelDb − targetLevelDb` (≤ 0.1 dB in magnitude when matched). */
	residualDb: number;
	/** The preamp was lowered. */
	matched: boolean;
	/** HS/LP/HP or a band above 20 kHz. */
	experimentalRequired: boolean;
	/** The gate verdict of the played curve (session options). */
	verdict: GateResult;
	/** The candidate as given (gated snapshot), untouched: "Salvar esta" saves this one. */
	original: { bands: Band[]; preampDb: number; crc: number; levelDb: number };
}

export interface ComparisonPlan {
	items: ComparisonItem[];
	/** The level confirmed for the set: the highest level played (null when refused). */
	ackLevelDb: number | null;
	/** The quietest original level (null when refused). */
	targetLevelDb: number | null;
	match: boolean;
	/** Gate option of every apply. */
	experimental: boolean;
	/** Any candidate needs the experimental confirmation (OR). */
	experimentalRequired: boolean;
	profile: 'standard';
	refusal?: ComparisonRefusal;
}

export interface ComparisonStartRequest {
	curves: readonly ComparisonCurve[];
	match: boolean;
	/**
	 * Blind: the state never tells which candidate plays (nor its CRC, level or hold details).
	 * Needs `match: true` (refused `blind-needs-match`); saves are refused `blind` meanwhile.
	 */
	blind: boolean;
	/** Index applied first (default 0). */
	first?: number;
	/** Gate option of the session (OR-ed with each candidate's). */
	experimental?: boolean;
	profile?: WriteProfile;
	confirmations: Partial<Confirmations> | undefined;
	gesture: GestureToken | null | undefined;
}

/** Per-candidate summary returned by `startComparison` (never in the state when blind). */
export interface ComparisonItemSummary {
	index: number;
	preampDb: number;
	levelDb: number;
	residualDb: number;
	matched: boolean;
}

export interface ComparisonSummary {
	items: ComparisonItemSummary[];
	ackLevelDb: number;
	targetLevelDb: number;
	experimentalRequired: boolean;
	blind: boolean;
}

export interface ComparisonRefused {
	status: 'refused';
	reason: 'comparison';
	refusal: ComparisonRefusal;
}

export type ComparisonOutcome =
	| LiveRefused
	| ComparisonRefused
	| { status: 'accepted'; live: LiveState | null; plan: ComparisonSummary };

export type ComparisonSwitchStatus = 'applied' | 'unknown' | 'held' | 'busy' | 'ended' | 'error';

/**
 * `cancelHold`: `cleared` (the hold is gone, the cable keeps what it plays), `no-hold`,
 * `unknown` (what the cable plays is not known: "Reaplicar" / `confirmLive` re-applies the
 * current candidate), `busy` (a switch or the end's revert runs), `ended`, `error` (no comparison).
 */
export type ComparisonCancelHoldStatus =
	| 'cleared'
	| 'no-hold'
	| 'unknown'
	| 'busy'
	| 'ended'
	| 'error';

export interface ComparisonEndRequest {
	/** true: apply the saved curve live first (needs `gesture`), then end the session. */
	revert: boolean;
	gesture?: GestureToken | null;
	saved?: LiveSavedCurve | null;
}

/** Coarse progress of a comparison (the only status a blind one exposes). */
export type ComparisonStatus = 'applying' | 'ready' | 'failed';

export interface LiveComparisonState {
	/** The session is running and the comparison with it. */
	active: boolean;
	blind: boolean;
	count: number;
	status: ComparisonStatus;
	/** Not blind only: the candidate playing (last applied). */
	index?: number;
	/** Not blind only: per-candidate matched preamp and level. */
	items?: ComparisonItemSummary[];
}

export interface CableWrittenDetail {
	entry: JournalEntry;
	crc: number;
	preampDb: number;
	bands: Band[];
	deviceLabel: string;
	at: number;
	levelDb: number | null;
	/**
	 * `'yolo'`: a real Modo YOLO write, marked like its journal entry (option B, YOLO
	 * publication): the app marks the curve as written and the outbox counts the install like any
	 * other. Absent, or `'standard'`, on a standard write. Simulated and interrupted writes
	 * dispatch nothing.
	 */
	profile?: WriteProfile;
	/** The class-2 codes the YOLO write waived (only with `profile: 'yolo'`). */
	waived?: ReasonCode[];
}
