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
 *   round, included) mutes the browser output, calls `switchComparison` and unmutes at
 *   max(`CABLE_SWITCH_WINDOW_MS`, the switch's settle time), the same for every candidate.
 * - A round is voided (not scored; completed rounds stay) on any switch status but `applied`, a
 *   switch slower than `CABLE_SWITCH_LIMIT_MS`, an unplugged cable, the comparison ending on its
 *   own, another tab's preview, or "O som parou de mudar". "Retomar" needs a new start (gesture).
 * - Audible change check: before the blind set starts, and again every `CABLE_CHECK_EVERY`
 *   rounds, a short NON-blind comparison of two labelled curves with an obvious contrast (Neutro
 *   and a band-limited "telefone"), level-matched. It is a separate comparison (ended before the
 *   blind set starts again), so it never takes part in the candidates' level matching. "Ouvi
 *   mudar" (its click is the gesture of the blind start) starts the blind set; "Não mudou" pauses
 *   and asks to replug.
 * - Telemetry: rounds heard on the cable never reach S6 (`s6Session`).
 * - A void never ends the comparison by itself: the session stays, so "Encerrar" can still revert
 *   the cable to its saved curve (with a gesture), and "Retomar" ends it before the check.
 */
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import { THRESHOLDS, autoPreamp } from 'open-auri/safety';
import type { CableService } from '#lib/cable/service.ts';
import type {
	Band,
	CableState,
	ComparisonCurve,
	ComparisonOutcome,
	ComparisonSwitchStatus,
	Confirmations,
	GestureToken,
	LiveOutcome
} from '#lib/cable/types.ts';
import type { Round, Session } from './experiment.ts';

/** The fixed muted window of every switch (ms): longer than a live apply (~0.35 s). */
export const CABLE_SWITCH_WINDOW_MS = 1200;
/** A switch that has not settled after this long voids the round (ms). */
export const CABLE_SWITCH_LIMIT_MS = 3000;
/** The audible change check runs before the first round and again every this many rounds. */
export const CABLE_CHECK_EVERY = 4;

/** The cable service calls this controller makes (the app's `CableService` satisfies it). */
export type CableRoundPort = Pick<
	CableService,
	'getState' | 'startComparison' | 'switchComparison' | 'cancelHold' | 'endComparison' | 'confirmLive'
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
}

export type CableVoidReason =
	/** The cable was unplugged (or the page lost it). */
	| 'disconnected'
	/** The comparison ended without this page ending it. */
	| 'ended'
	/** Another tab's preview may be playing on a cable. */
	| 'elsewhere'
	/** "O som parou de mudar". */
	| 'stuck'
	/** A switch slower than `CABLE_SWITCH_LIMIT_MS`. */
	| 'slow'
	| Exclude<ComparisonSwitchStatus, 'applied'>;

export type CablePause =
	| CableVoidReason
	/** The check is due (every `CABLE_CHECK_EVERY` rounds): not a void. */
	| 'check-due'
	/** "Não mudou" in the check: replug, then Retomar. */
	| 'no-change'
	/** A start of the check or of the blind set was refused (the page shows why). */
	| 'refused'
	/** "Encerrar" did not leave the cable on its saved curve (the page shows why). */
	| 'end-failed';

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
	/** The blind set ended (`reverted`, `kept` or `gone`: unplugged meanwhile). */
	| 'ended';

export interface CableRoundView {
	readonly phase: CablePhase;
	readonly pause: CablePause | null;
	/** A blind switch window is open (output muted). */
	readonly switching: boolean;
	/** The position whose switch completed in this round (null: the next play switches first). */
	readonly ready: number | null;
	/** Check: the item playing (0 Neutro, 1 telefone), and the items heard at least once. */
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
	/** A round was voided: the page drops its ratings (completed rounds stay). */
	onvoid?: (reason: CableVoidReason) => void;
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
	/** Bumped by every void and end: a switch that outlived it changes nothing. */
	let epoch = 0;
	/** The phase "Encerrar" started from (a cancelled held revert goes back to it). */
	let beforeEnd: CablePhase = 'idle';
	/** The blind set (`begin`) and the levers of the last start, reused by its blind start. */
	let blindSet: { curves: readonly ComparisonCurve[]; experimental: boolean } | null = null;
	let confirmations: Partial<Confirmations> = {};

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

	/**
	 * Starts (or, from a pause, restarts) with the change check: ends what this test left running,
	 * then the non-blind check comparison, Neutro first.
	 */
	async function startCheck(request: CableStartRequest): Promise<ComparisonOutcome> {
		const from = view.phase;
		if (from !== 'idle' && from !== 'paused' && from !== 'ended') return busy();
		if (blindSet === null) return { status: 'refused', reason: 'error' };
		epoch++;
		confirmations = { ...request.confirmations };
		set({ phase: 'starting', switching: false, ready: null });
		mute();
		await endKept();
		const outcome = await port.startComparison({
			curves: checkCurves(),
			match: true,
			blind: false,
			first: 0,
			confirmations: { ...confirmations },
			gesture: request.gesture
		});
		if (outcome.status !== 'accepted') {
			set({ phase: from === 'idle' || from === 'ended' ? from : 'paused' });
			return outcome;
		}
		set({
			phase: 'checking',
			pause: null,
			checkPlaying: 0,
			checkHeard: [true, false],
			endedReason: null
		});
		unmute();
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
		const heard: [boolean, boolean] = [view.checkHeard[0], view.checkHeard[1]];
		heard[index] = true;
		set({ switching: false, checkPlaying: index, checkHeard: heard });
		unmute();
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
		epoch++;
		mute();
		if (!changed) {
			set({ phase: 'paused', pause: 'no-change', checkPlaying: null });
			return null;
		}
		set({ phase: 'starting', checkPlaying: null });
		await endKept();
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
		if (outcome.status !== 'accepted') {
			set({ phase: 'paused', pause: 'refused' });
			return outcome;
		}
		set({ phase: 'blind', pause: null, ready: null, switching: false, sinceCheck: 0 });
		return outcome;
	}

	/**
	 * Plays `position` (candidate `index` of the set): mute, switch, unmute at
	 * max(`CABLE_SWITCH_WINDOW_MS`, settled). Any failure, or a switch slower than
	 * `CABLE_SWITCH_LIMIT_MS`, voids the round (the output stays muted).
	 */
	async function select(position: number, index: number): Promise<CableSelectResult> {
		if (view.phase !== 'blind' || view.switching) return 'busy';
		const at = ++epoch;
		set({ switching: true, ready: null });
		mute();
		const window = timer.sleep(CABLE_SWITCH_WINDOW_MS);
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
	 * Every `CABLE_CHECK_EVERY` rounds the check is due before the next one.
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
			set({ phase: 'paused', pause: 'check-due', ready: null, switching: false, sinceCheck });
			return;
		}
		set({ ready: null, switching: false, sinceCheck });
	}

	/** Voids the round in play (or the check): muted, paused; the comparison is left running. */
	async function voidRound(reason: CableVoidReason): Promise<void> {
		if (view.phase !== 'blind' && view.phase !== 'checking') return;
		epoch++;
		mute();
		set({ phase: 'paused', pause: reason, switching: false, ready: null, checkPlaying: null });
		deps.onvoid?.(reason);
	}

	/** The cable state changed: unplugged, ended elsewhere or another tab's preview voids. */
	function observe(state: CableState) {
		const phase = view.phase;
		const active = comparisonActive(state);
		if (phase === 'blind' || phase === 'checking') {
			if ((state.liveOrphan ?? null) !== null) {
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
	 * "Encerrar": back to the saved curve (gesture), then the session ends. A held revert (the
	 * saved curve ≥ 3 dB louder) waits for `confirmHeld` or `cancelHeld`; another failure pauses.
	 */
	async function end(request: Gesture): Promise<LiveOutcome | null> {
		const from = view.phase;
		if (from === 'starting' || from === 'end-held') return null;
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
		set(from === 'done' ? { phase: 'done' } : { phase: 'paused', pause: 'end-failed' });
		return outcome;
	}

	/** "Abaixei o volume, aplicar": the held saved curve plays, then the session ends there. */
	async function confirmHeld(request: Gesture): Promise<LiveOutcome> {
		if (view.phase !== 'end-held') return { status: 'refused', reason: 'no-hold' };
		const outcome = await port.confirmLive({ gesture: request.gesture });
		if (outcome.status !== 'accepted') return outcome;
		const live = port.getState().live;
		if (live === null || live.hold !== null || live.status === 'unknown') {
			return { status: 'refused', reason: 'revert-failed' };
		}
		epoch++;
		const ended = await port.endComparison({ revert: false });
		set({ phase: 'ended', endedReason: 'reverted', pause: null });
		return ended;
	}

	/** Drops the held revert: the cable keeps the candidate, the set goes on (no I/O). */
	function cancelHeld(): void {
		if (view.phase !== 'end-held') return;
		port.cancelHold();
		set(beforeEnd === 'done' ? { phase: 'done' } : { phase: 'paused', pause: 'end-failed' });
	}

	/** Ends the blind set with the cable keeping its curve (before "Salvar esta", or leaving). */
	async function endKeep(): Promise<void> {
		epoch++;
		mute();
		const from = view.phase;
		if (from === 'idle' || from === 'ended') return;
		set({ phase: 'starting', switching: false, ready: null });
		await endKept();
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
		/** Back to idle (a new test); nothing on the cable changes. */
		reset() {
			epoch++;
			blindSet = null;
			set({ ...IDLE_VIEW });
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
