/**
 * Teste cego no cabo (issue #74, plan `docs/plans/2026-10-28-x2-e-teste-cego-no-cabo-plano.md`,
 * slice 5): the blind test's candidates play on the cable's RAM (a blind, level-matched
 * comparison set, `startComparison`), the browser plays one flat chain.
 *
 * This controller owns the timing and the failure rules; the page owns the session (order,
 * ratings, reveal) and the position → candidate mapping, which never reaches the cable state or
 * the DOM. Pure apart from the injected port (the cable service), timer and browser output.
 *
 * - Identical timing: every position change (the same position again, and the first play of a
 *   round, included) mutes the browser output, waits until it is silent at the ears (the mute
 *   ramp and the output latency, `quietMs`, at least `CABLE_MUTE_FLOOR_MS`), calls
 *   `switchComparison` and unmutes at max(`CABLE_SWITCH_WINDOW_MS` from the mute, the switch's
 *   settle time), the same for every candidate.
 * - A round is voided (not scored; completed rounds stay) on any switch status but `applied`, a
 *   switch slower than `CABLE_SWITCH_LIMIT_MS`, an unplugged cable, the comparison ending on its
 *   own, another tab's preview appearing after the start, or "O som parou de mudar". Every other
 *   pause that interrupts a round (a failed "Encerrar", a cancelled held revert, the check due)
 *   drops it too (`onvoid`: the page reshuffles it), once: a failed end tried again from the pause
 *   only says why. "Retomar" needs a new start (gesture); "Encerrar sem voltar" (`endKeep`) always
 *   ends it with the cable keeping its curve.
 * - A start (the check, the blind set) is refused (`live-elsewhere`, nothing sent) while the
 *   cable may still play an old preview (`liveOrphan`): unplug and replug, or "Já desconectei".
 * - Audible change check: before the blind set starts, and again every `CABLE_CHECK_EVERY`
 *   rounds, a short NON-blind comparison of two labelled curves with an obvious contrast (Neutro
 *   and a band-limited "telefone"), level-matched. It is a separate comparison (ended before the
 *   blind set starts again), so it never takes part in the candidates' level matching. An item
 *   counts as heard only while the audio plays with it on the cable (`audible`). "Ouvi mudar"
 *   (its click is the gesture of the blind start) starts the blind set; "Não mudou" pauses and
 *   asks to replug.
 * - Telemetry: rounds heard on the cable never reach S6 (`s6Session`).
 * - A void never ends the comparison by itself: the session stays, so "Encerrar" can still revert
 *   the cable to its saved curve (with a gesture), and "Retomar" ends it before the check.
 * - A start that outlives its controller (reset, destroyed, ended meanwhile) is ended again
 *   right away (`endComparison({ revert: false })`) and changes nothing here.
 */
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import { THRESHOLDS, autoPreamp } from 'open-auri/safety';
import type { CableService } from '#lib/cable/service.ts';
import type {
	Band,
	CableState,
	ComparisonCancelHoldStatus,
	ComparisonCurve,
	ComparisonOutcome,
	ComparisonSwitchStatus,
	Confirmations,
	GestureToken,
	LiveOutcome
} from '#lib/cable/types.ts';
import type { Round, Session } from './experiment.ts';

/** The fixed muted window of every switch (ms, from the mute): longer than a live apply (~0.35 s). */
export const CABLE_SWITCH_WINDOW_MS = 1200;
/** A switch that has not settled after this long voids the round (ms). */
export const CABLE_SWITCH_LIMIT_MS = 3000;
/** The audible change check runs before the first round and again every this many rounds. */
export const CABLE_CHECK_EVERY = 4;
/** The least wait between the mute and the switch (ms): the mute ramp plus some output latency. */
export const CABLE_MUTE_FLOOR_MS = 60;
/** The most that wait can be (ms): a bogus output latency never stalls a switch. */
export const CABLE_MUTE_MAX_MS = 400;

/** The cable service calls this controller makes (the app's `CableService` satisfies it). */
export type CableRoundPort = Pick<
	CableService,
	| 'getState'
	| 'startComparison'
	| 'switchComparison'
	| 'cancelHold'
	| 'endComparison'
	| 'confirmEndComparison'
>;

/** Time source of the switch window (monotonic ms) and its waits. */
export interface RoundTimer {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const browserTimer: RoundTimer = {
	now: () => performance.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/** The browser output the window mutes (one flat chain). */
export interface BrowserOutput {
	mute(): void;
	unmute(): void;
	/**
	 * How long after `mute` the output is silent at the ears (ms): the mute ramp plus the
	 * output latency. Never depends on the candidate.
	 */
	quietMs?(): number;
}

export type CableVoidReason =
	/** The cable was unplugged (or the page lost it). */
	| 'disconnected'
	/** The comparison ended without this page ending it. */
	| 'ended'
	/** Another tab's preview may be playing on a cable (it appeared after the start). */
	| 'elsewhere'
	/** "O som parou de mudar". */
	| 'stuck'
	/** A switch slower than `CABLE_SWITCH_LIMIT_MS`. */
	| 'slow'
	| Exclude<ComparisonSwitchStatus, 'applied'>;

export type CablePause =
	| CableVoidReason
	/** The check is due (every `CABLE_CHECK_EVERY` rounds). */
	| 'check-due'
	/** "Não mudou" in the check: replug, then Retomar. */
	| 'no-change'
	/** A start of the check or of the blind set was refused (the page shows why). */
	| 'refused'
	/** "Encerrar" did not leave the cable on its saved curve (the page shows why). */
	| 'end-failed'
	/** The held revert could not be dropped (the cable is busy or its state unknown). */
	| 'cancel-failed';

export type CablePhase =
	/** Nothing of this test on the cable. */
	| 'idle'
	/** A start or an end of this controller is in flight (state changes are not failures). */
	| 'starting'
	/** The non-blind change check runs. */
	| 'checking'
	/** The blind set runs: rounds are played. */
	| 'blind'
	/** Rounds are stopped (a void, the check due): "Retomar" starts again. */
	| 'paused'
	/** Every round was played: the blind set still runs until "Salvar" or "Encerrar". */
	| 'done'
	/** "Encerrar": the saved curve is louder and waits for the volume confirmation. */
	| 'end-held'
	/** The blind set ended (`reverted`, `kept` or `gone`: it ended without this page). */
	| 'ended';

export interface CableRoundView {
	readonly phase: CablePhase;
	readonly pause: CablePause | null;
	/** A blind switch window is open (output muted). */
	readonly switching: boolean;
	/** The position whose switch completed in this round (null: the next play switches first). */
	readonly ready: number | null;
	/**
	 * Check: the item on the cable (0 Neutro, 1 telefone), and the items heard: each counts once
	 * the audio played while it was on the cable.
	 */
	readonly checkPlaying: 0 | 1 | null;
	readonly checkHeard: readonly [boolean, boolean];
	/** Rounds scored since the last check. */
	readonly sinceCheck: number;
	readonly endedReason: 'reverted' | 'kept' | 'gone' | null;
}

export const IDLE_VIEW: CableRoundView = Object.freeze({
	phase: 'idle',
	pause: null,
	switching: false,
	ready: null,
	checkPlaying: null,
	checkHeard: [false, false] as const,
	sinceCheck: 0,
	endedReason: null
});

const OFF: Band = { kind: 'OFF' };

/**
 * The "telefone" curve of the check: a band-limited voice channel (≈ 300 Hz to 3.4 kHz), with a
 * low shelf cut and peaking cuts above it. Standard gate (no HS/LP/HP), preamp from `autoPreamp`.
 */
export function telephoneCurve(): ComparisonCurve {
	const bands: Band[] = [
		{ kind: 'LS', freqHz: 300, gainDb: -12, qFactor: 0.7 },
		{ kind: 'PK', freqHz: 4500, gainDb: -12, qFactor: 0.7 },
		{ kind: 'PK', freqHz: 9000, gainDb: -12, qFactor: 0.7 },
		...Array.from({ length: 7 }, (): Band => ({ ...OFF }))
	];
	const preampDb = autoPreamp(bands) ?? THRESHOLDS.preampMaxDb;
	return { bands, preampDb };
}

/** The two labelled items of the change check: 0 Neutro, 1 telefone. */
export function checkCurves(): [ComparisonCurve, ComparisonCurve] {
	return [{ bands: snapshotBands(NEUTRO.bands), preampDb: NEUTRO.preampDb }, telephoneCurve()];
}

/**
 * The session as S6 may see it: rounds heard on the cable are dropped (the S6 pairs keep their
 * four keys, `{a, b, choice, levelMatched}`; a cable output would need a server change first).
 */
export function s6Session(
	session: Session | null,
	cableRounds: ReadonlySet<Round> | WeakSet<Round>
): Session | null {
	if (session === null) return null;
	const completed = session.completed.filter((round) => !cableRounds.has(round));
	return completed.length === session.completed.length ? session : { ...session, completed };
}

/** The cable may still play an old preview (another tab's, or this one's before a reload). */
export function cableOrphan(state: CableState | null | undefined): boolean {
	return (state?.liveOrphan ?? null) !== null;
}

/** An identity of the orphan notice (a new one differs from the one seen at the start). */
function orphanKey(state: CableState): string | null {
	const orphan = state.liveOrphan ?? null;
	return orphan === null ? null : `${orphan.deviceLabel}\u0000${orphan.crc}\u0000${orphan.at}`;
}

/** Why a comparison-switch status voids the round. */
function voidOf(status: ComparisonSwitchStatus | 'slow'): CableVoidReason | null {
	return status === 'applied' ? null : status;
}

export interface CableRoundDeps {
	port: CableRoundPort;
	/** The output to mute (the page's flat chain); null: nothing to mute yet. */
	output: () => BrowserOutput | null;
	timer?: RoundTimer;
	/** Every view change. */
	onchange?: (view: CableRoundView) => void;
	/**
	 * The round in play was interrupted (a void, or a pause that stops it): the page drops its
	 * ratings and plays it again later in a new order (completed rounds stay).
	 */
	onvoid?: (reason: CablePause) => void;
}

export interface CableStartRequest {
	gesture: GestureToken | null | undefined;
	/** The checklist's levers, for the check and for the blind start that follows it. */
	confirmations: Partial<Confirmations>;
}

export interface CableBeginRequest extends CableStartRequest {
	/** The candidates, in the session's candidate order (plan index = candidate index). */
	curves: readonly ComparisonCurve[];
	/** Any candidate has HS/LP/HP (the experimental lever is then required). */
	experimental: boolean;
}

type Gesture = { gesture: GestureToken | null | undefined };

export type CableSelectResult = 'ready' | 'void' | 'busy';

export function createCableRound(deps: CableRoundDeps) {
	const { port } = deps;
	const timer = deps.timer ?? browserTimer;
	let view: CableRoundView = IDLE_VIEW;
	/** Bumped by every void, end, reset and destroy: work that outlived it changes nothing. */
	let epoch = 0;
	/** The phase "Encerrar" started from (a cancelled held revert goes back to it). */
	let beforeEnd: CablePhase = 'idle';
	/** The blind set (`begin`) and the levers of the last start, reused by its blind start. */
	let blindSet: { curves: readonly ComparisonCurve[]; experimental: boolean } | null = null;
	let confirmations: Partial<Confirmations> = {};
	/** The orphan notice seen at the last start (only a new one voids). */
	let orphanAtStart: string | null = null;
	/** The page's audio plays (the check counts an item heard only then). */
	let audible = false;

	function set(next: Partial<CableRoundView>) {
		view = { ...view, ...next };
		deps.onchange?.(view);
	}

	function mute() {
		deps.output()?.mute();
	}

	function unmute() {
		deps.output()?.unmute();
	}

	/** The wait between the mute and the switch (ms): the same for every candidate. */
	function quietMs(): number {
		let raw: number;
		try {
			raw = deps.output()?.quietMs?.() ?? 0;
		} catch {
			raw = 0;
		}
		const value = Number.isFinite(raw) ? raw : 0;
		return Math.min(CABLE_MUTE_MAX_MS, Math.max(CABLE_MUTE_FLOOR_MS, value));
	}

	/** A comparison (this test's, check or blind set) is running on the cable. */
	function comparisonActive(state: CableState = port.getState()): boolean {
		return state.live?.comparison?.active === true;
	}

	async function endKept(): Promise<void> {
		if (comparisonActive()) await port.endComparison({ revert: false });
	}

	function busy(): ComparisonOutcome {
		return { status: 'refused', reason: 'busy' };
	}

	/** A start that outlived this run (reset, destroyed, ended meanwhile): ended again. */
	async function dropStale(outcome: ComparisonOutcome): Promise<ComparisonOutcome> {
		if (outcome.status === 'accepted') await port.endComparison({ revert: false });
		return busy();
	}

	/** Pauses; a round that was in play (or about to be) is dropped by the page. */
	function pauseWith(pause: CablePause) {
		set({ phase: 'paused', pause, switching: false, ready: null, checkPlaying: null });
		deps.onvoid?.(pause);
	}

	/** Check: the item on the cable counts as heard while the audio plays. */
	function markHeard() {
		const index = view.checkPlaying;
		if (view.phase !== 'checking' || view.switching || !audible || index === null) return;
		if (view.checkHeard[index]) return;
		const heard: [boolean, boolean] = [view.checkHeard[0], view.checkHeard[1]];
		heard[index] = true;
		set({ checkHeard: heard });
	}

	/**
	 * Starts (or, from a pause, restarts) with the change check: ends what this test left running,
	 * then the non-blind check comparison, Neutro first. Refused while the cable may play an old
	 * preview (`liveOrphan`).
	 */
	async function startCheck(request: CableStartRequest): Promise<ComparisonOutcome> {
		const from = view.phase;
		if (from !== 'idle' && from !== 'paused' && from !== 'ended') return busy();
		if (blindSet === null) return { status: 'refused', reason: 'error' };
		const orphan = orphanKey(port.getState());
		if (orphan !== null) return { status: 'refused', reason: 'live-elsewhere' };
		const at = ++epoch;
		orphanAtStart = orphan;
		confirmations = { ...request.confirmations };
		set({ phase: 'starting', switching: false, ready: null });
		mute();
		await endKept();
		if (at !== epoch) return busy();
		const outcome = await port.startComparison({
			curves: checkCurves(),
			match: true,
			blind: false,
			first: 0,
			confirmations: { ...confirmations },
			gesture: request.gesture
		});
		if (at !== epoch) return dropStale(outcome);
		if (outcome.status !== 'accepted') {
			set({ phase: from === 'idle' || from === 'ended' ? from : 'paused' });
			return outcome;
		}
		set({
			phase: 'checking',
			pause: null,
			checkPlaying: 0,
			checkHeard: [false, false],
			endedReason: null
		});
		unmute();
		markHeard();
		return outcome;
	}

	/** Check: plays item `index` (0 Neutro, 1 telefone). */
	async function playCheck(index: 0 | 1): Promise<ComparisonSwitchStatus | 'busy'> {
		if (view.phase !== 'checking' || view.switching) return 'busy';
		const at = epoch;
		set({ switching: true });
		mute();
		const { status } = await port.switchComparison(index).catch(() => ({ status: 'error' as const }));
		if (at !== epoch || view.phase !== 'checking') return status;
		if (status !== 'applied') {
			set({ switching: false });
			await voidRound(voidOf(status) ?? 'error');
			return status;
		}
		set({ switching: false, checkPlaying: index });
		unmute();
		markHeard();
		return status;
	}

	/**
	 * The check's answer. "Ouvi mudar" (`changed`, both items heard) ends the check and starts the
	 * blind set with this click's gesture; "Não mudou" pauses (replug, then Retomar).
	 */
	async function answerCheck(changed: boolean, request: Gesture): Promise<ComparisonOutcome | null> {
		if (view.phase !== 'checking' || view.switching) return busy();
		if (changed && !(view.checkHeard[0] && view.checkHeard[1])) return busy();
		const target = blindSet;
		if (target === null) return { status: 'refused', reason: 'error' };
		const at = ++epoch;
		mute();
		if (!changed) {
			set({ phase: 'paused', pause: 'no-change', checkPlaying: null });
			return null;
		}
		if (orphanKey(port.getState()) !== orphanAtStart) {
			set({ phase: 'paused', pause: 'refused', checkPlaying: null });
			return { status: 'refused', reason: 'live-elsewhere' };
		}
		set({ phase: 'starting', checkPlaying: null });
		await endKept();
		if (at !== epoch) return busy();
		// First 0 for every round: the order lives in the page, and every play switches anyway.
		const outcome = await port.startComparison({
			curves: target.curves,
			match: true,
			blind: true,
			first: 0,
			experimental: target.experimental,
			confirmations: { ...confirmations },
			gesture: request.gesture
		});
		if (at !== epoch) return dropStale(outcome);
		if (outcome.status !== 'accepted') {
			set({ phase: 'paused', pause: 'refused' });
			return outcome;
		}
		set({ phase: 'blind', pause: null, ready: null, switching: false, sinceCheck: 0 });
		return outcome;
	}

	/**
	 * Plays `position` (candidate `index` of the set): mute, wait until silent (`quietMs`), switch,
	 * unmute at max(`CABLE_SWITCH_WINDOW_MS` from the mute, settled). Any failure, or a switch
	 * slower than `CABLE_SWITCH_LIMIT_MS`, voids the round (the output stays muted).
	 */
	async function select(position: number, index: number): Promise<CableSelectResult> {
		if (view.phase !== 'blind' || view.switching) return 'busy';
		const at = ++epoch;
		set({ switching: true, ready: null });
		mute();
		const window = timer.sleep(CABLE_SWITCH_WINDOW_MS);
		// The ramp and the output latency first: the switch itself is never heard.
		await timer.sleep(quietMs());
		if (at !== epoch || view.phase !== 'blind') return 'void';
		const status = await Promise.race([
			port.switchComparison(index).then(
				(result) => result.status,
				(): ComparisonSwitchStatus => 'error'
			),
			timer.sleep(CABLE_SWITCH_LIMIT_MS).then(() => 'slow' as const)
		]);
		if (at !== epoch || view.phase !== 'blind') return 'void';
		const failure = voidOf(status);
		if (failure !== null) {
			await voidRound(failure);
			return 'void';
		}
		await window;
		if (at !== epoch || view.phase !== 'blind') return 'void';
		set({ switching: false, ready: position });
		unmute();
		return 'ready';
	}

	/** A new round: its first play switches first. */
	function newRound() {
		if (view.phase === 'blind') set({ ready: null });
		mute();
	}

	/**
	 * A round was scored. `finished`: the last one (the blind set stays until Salvar/Encerrar).
	 * Every `CABLE_CHECK_EVERY` rounds the check is due before the next one (which is reshuffled).
	 */
	function roundRecorded(finished: boolean) {
		if (view.phase !== 'blind') return;
		epoch++;
		mute();
		const sinceCheck = view.sinceCheck + 1;
		if (finished) {
			set({ phase: 'done', ready: null, switching: false, sinceCheck });
			return;
		}
		if (sinceCheck >= CABLE_CHECK_EVERY) {
			set({ sinceCheck });
			pauseWith('check-due');
			return;
		}
		set({ ready: null, switching: false, sinceCheck });
	}

	/** Voids the round in play (or the check): muted, paused; the comparison is left running. */
	async function voidRound(reason: CableVoidReason): Promise<void> {
		if (view.phase !== 'blind' && view.phase !== 'checking') return;
		epoch++;
		mute();
		pauseWith(reason);
	}

	/**
	 * The cable state changed: unplugged, ended elsewhere or another tab's preview appearing
	 * after the start voids.
	 */
	function observe(state: CableState) {
		const phase = view.phase;
		const active = comparisonActive(state);
		if (phase === 'blind' || phase === 'checking') {
			const orphan = orphanKey(state);
			if (orphan !== null && orphan !== orphanAtStart) {
				void voidRound('elsewhere');
				return;
			}
			if (!active) {
				const unplugged =
					state.live?.endedReason === 'disconnected' || state.connection !== 'connected';
				void voidRound(unplugged ? 'disconnected' : 'ended');
			}
			return;
		}
		if ((phase === 'done' || phase === 'end-held') && !active) {
			epoch++;
			set({ phase: 'ended', endedReason: 'gone', pause: null });
		}
	}

	/**
	 * Pauses after a failed end: a round in play is dropped once; from a pause (nothing in play,
	 * already dropped) only the reason changes, so a failed end tried again never reshuffles.
	 */
	function stopAfterEnd(pause: CablePause) {
		if (beforeEnd === 'paused') {
			set({ phase: 'paused', pause, switching: false, ready: null, checkPlaying: null });
		} else pauseWith(pause);
	}

	/** After a failed end: back to `done`, or paused (the round in play is dropped once). */
	function backFromEnd(pause: CablePause) {
		if (beforeEnd === 'done') set({ phase: 'done', pause: null });
		else stopAfterEnd(pause);
	}

	/**
	 * "Encerrar": back to the saved curve (gesture), then the session ends. A held revert (the
	 * saved curve ≥ 3 dB louder) waits for `confirmHeld` or `cancelHeld`; another failure pauses.
	 */
	async function end(request: Gesture): Promise<LiveOutcome | null> {
		const from = view.phase;
		if (from === 'starting' || from === 'end-held' || from === 'ended') return null;
		epoch++;
		mute();
		if (!comparisonActive()) {
			set({ phase: 'ended', endedReason: 'gone', switching: false, ready: null, pause: null });
			return null;
		}
		beforeEnd = from;
		set({ phase: 'starting', switching: false, ready: null });
		const outcome = await port.endComparison({ revert: true, gesture: request.gesture });
		if (outcome.status === 'accepted') {
			set({ phase: 'ended', endedReason: 'reverted', pause: null });
			return outcome;
		}
		const hold = port.getState().live?.hold ?? null;
		const held = hold?.reason === 'loudness' && hold.curve === 'saved';
		if (outcome.reason === 'revert-failed' && held) {
			set({ phase: 'end-held' });
			return outcome;
		}
		if (!comparisonActive()) {
			set({ phase: 'ended', endedReason: 'gone', pause: null });
			return outcome;
		}
		backFromEnd('end-failed');
		return outcome;
	}

	/**
	 * "Abaixei o volume, aplicar": the held saved curve plays and, only once the cable is known to
	 * play it, the session ends there (`confirmEndComparison`: reverted, marker removed).
	 */
	async function confirmHeld(request: Gesture): Promise<LiveOutcome> {
		if (view.phase !== 'end-held') return { status: 'refused', reason: 'no-hold' };
		const at = ++epoch;
		// In flight: the session ending under this call is its own success, never `gone`.
		set({ phase: 'starting' });
		const outcome = await port.confirmEndComparison({ gesture: request.gesture });
		if (at !== epoch) return outcome;
		if (outcome.status === 'accepted') {
			set({ phase: 'ended', endedReason: 'reverted', pause: null });
			return outcome;
		}
		if (!comparisonActive()) {
			set({ phase: 'ended', endedReason: 'gone', pause: null });
			return outcome;
		}
		const hold = port.getState().live?.hold ?? null;
		// Nothing sent (a stale click): still held, the confirmation can be given again.
		if (hold?.reason === 'loudness' && hold.curve === 'saved') {
			set({ phase: 'end-held' });
			return outcome;
		}
		backFromEnd('end-failed');
		return outcome;
	}

	/**
	 * Drops the held revert (no I/O): the cable keeps the candidate, the set goes on (the round in
	 * play is dropped). A busy or unknown cable keeps the hold: paused, with why.
	 */
	function cancelHeld(): ComparisonCancelHoldStatus | null {
		if (view.phase !== 'end-held') return null;
		epoch++;
		const { status } = port.cancelHold();
		switch (status) {
			case 'cleared':
			case 'no-hold':
				backFromEnd('end-failed');
				break;
			case 'ended':
				set({ phase: 'ended', endedReason: 'gone', pause: null });
				break;
			default:
				stopAfterEnd('cancel-failed');
		}
		return status;
	}

	/**
	 * Ends the blind set with the cable keeping its curve ("Encerrar sem voltar", before "Salvar
	 * a vencedora", or leaving). A reset meanwhile wins: the view stays idle.
	 */
	async function endKeep(): Promise<void> {
		const at = ++epoch;
		mute();
		const from = view.phase;
		if (from === 'idle' || from === 'ended') return;
		set({ phase: 'starting', switching: false, ready: null });
		await endKept();
		if (at !== epoch) return;
		set({ phase: 'ended', endedReason: 'kept', pause: null });
	}

	return {
		get view() {
			return view;
		},
		/** Starts the test on the cable: the change check first, then (`answerCheck`) the set. */
		begin(request: CableBeginRequest): Promise<ComparisonOutcome> {
			if (view.phase !== 'idle' && view.phase !== 'ended') return Promise.resolve(busy());
			blindSet = { curves: [...request.curves], experimental: request.experimental };
			set({ ...IDLE_VIEW });
			return startCheck(request);
		},
		/** "Retomar" (paused): the check again (fresh levers and gesture), then the set. */
		resume(request: CableStartRequest): Promise<ComparisonOutcome> {
			if (view.phase !== 'paused') return Promise.resolve(busy());
			return startCheck(request);
		},
		/** The page's audio plays (true) or not: the check's item on the cable counts as heard. */
		audible(playing: boolean) {
			audible = playing;
			markHeard();
		},
		playCheck,
		answerCheck,
		select,
		newRound,
		roundRecorded,
		voidRound,
		observe,
		end,
		confirmHeld,
		cancelHeld,
		endKeep,
		/** Back to idle (a new test); nothing on the cable changes (a start in flight is ended). */
		reset() {
			epoch++;
			blindSet = null;
			set({ ...IDLE_VIEW });
		},
		/**
		 * The page goes away: nothing of this run changes the view any more, a start in flight is
		 * ended when it lands, and a running comparison ends with the cable keeping its curve.
		 */
		destroy(): Promise<void> {
			epoch++;
			const phase = view.phase;
			if (phase === 'idle' || phase === 'ended' || !comparisonActive()) return Promise.resolve();
			return port.endComparison({ revert: false }).then(() => undefined);
		},
		/** The blind set needs the experimental confirmation (any candidate has HS/LP/HP). */
		experimental(): boolean {
			return blindSet?.experimental ?? false;
		},
		/** A comparison of this test runs on the cable (check or blind set). */
		running(): boolean {
			return view.phase !== 'idle' && view.phase !== 'ended' && comparisonActive();
		}
	};
}

export type CableRound = ReturnType<typeof createCableRound>;
