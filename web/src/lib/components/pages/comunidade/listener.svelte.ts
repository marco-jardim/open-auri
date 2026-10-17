// The page's single preview (T4.13): one A/B pair of chains on the shared audio engine, level
// matched by `createAB` (same rule as Curva, Comparar and /c/[id]). It knows which published
// lineage is audible, so a channel's LEDs light only while that channel really plays, and it counts
// audible time per lineage for the `previewed` activity (≥ 10 s, PREVIEW_MIN_MS). Nothing here
// writes to a cable.
// Transport (SEEK.2): every preview starts at a random point in [25 %, 75 %] of the file
// (`startAt: 'random'`), tagged `COMUNIDADE_SESSION`; the file loops. A pause (Transport, navbar)
// keeps the pair, the side and the trims and stops counting audible time; a resume counts again.
// Only `stop` (a panel's own stop, a new preview, unmount) ends the session with `engine.stop()`.
import type {
	ABPreview,
	ABSide,
	AudioEngine,
	AudioEngineState,
	PreviewChain,
	PreviewCurve
} from '#lib/audio/engine.ts';
import { PREVIEW_MIN_MS } from '#lib/social/index.ts';
import { createKeyedStore } from './keyed.ts';

export interface ListenSide {
	/** Published lineage of this side; null for the editor curve or a blind S7 partner. */
	lineageId: string | null;
	curve: PreviewCurve;
}

export interface ListenRequest {
	a: ListenSide;
	b: ListenSide;
	initial: ABSide;
	/** Blind rounds: no channel reveals itself (no LEDs, no "playing" marks). */
	blind?: boolean;
	/** Who asked (e.g. 'channel', 'scope', 's6', 's7'), so each panel shows its own state. */
	owner: string;
}

export interface ListenerOptions {
	engine: () => AudioEngine | null;
	/** Called once per lineage and page session when its audible preview reaches 10 s. */
	onPreviewed?: (lineageId: string, durationMs: number) => void;
	now?: () => number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

interface Active {
	request: ListenRequest;
	side: ABSide;
}

/** Session tag of the Comunidade preview, whichever panel owns it (Transport, navbar). */
export const COMUNIDADE_SESSION = 'comunidade';

export function createListener(options: ListenerOptions) {
	const now = options.now ?? (() => Date.now());
	const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer =
		options.clearTimer ??
		((handle) => {
			if (typeof handle === 'number') clearTimeout(handle);
		});

	let active = $state.raw<Active | null>(null);
	let preview = $state.raw<ABPreview | null>(null);
	let busy = $state(false);
	/** The running preview is paused (resumable): nothing counts as audible meanwhile. */
	let paused = $state(false);
	let engine: AudioEngine | null = null;
	let unsubscribe: (() => void) | null = null;
	let attempt = 0;

	// Non-reactive bookkeeping (never rendered): audible ms and lineages already reported.
	const totals = createKeyedStore<number>();
	const reported = createKeyedStore<true>();
	let segment: { lineageId: string; startedAt: number } | null = null;
	let timer: unknown = null;

	function audibleLineage(): string | null {
		if (!active) return null;
		const side = active.side === 'A' ? active.request.a : active.request.b;
		return side.lineageId;
	}

	function closeSegment() {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		if (!segment) return;
		const elapsed = Math.max(0, now() - segment.startedAt);
		totals.set(segment.lineageId, (totals.get(segment.lineageId) ?? 0) + elapsed);
		segment = null;
	}

	function openSegment() {
		closeSegment();
		const lineageId = audibleLineage();
		if (lineageId === null || !engine || !engine.state().playing) return;
		segment = { lineageId, startedAt: now() };
		if (reported.has(lineageId)) return;
		const remaining = Math.max(0, PREVIEW_MIN_MS - (totals.get(lineageId) ?? 0));
		timer = setTimer(() => {
			timer = null;
			closeSegment();
			const total = totals.get(lineageId) ?? 0;
			if (total >= PREVIEW_MIN_MS && !reported.has(lineageId)) {
				reported.set(lineageId, true);
				options.onPreviewed?.(lineageId, Math.round(total));
			}
			openSegment();
		}, remaining);
	}

	/** The engine plays or holds paused this page's session (not raw, not another page's). */
	function owned(target: AudioEngine): boolean {
		const state = target.state();
		return state.session === COMUNIDADE_SESSION && (state.playing || state.paused);
	}

	/** Ends the session (when still ours) and releases the pair. */
	function release() {
		closeSegment();
		attempt++;
		unsubscribe?.();
		unsubscribe = null;
		const used = engine;
		engine = null;
		if (used && owned(used)) used.stop();
		preview?.dispose();
		preview = null;
		active = null;
		paused = false;
		busy = false;
	}

	/** Follows the engine: pause/resume of this session, else a stop or another session. */
	function follow(state: AudioEngineState) {
		const ours = state.session === COMUNIDADE_SESSION;
		if (ours && state.playing && state.mode === 'chains') {
			// Resumed (Transport, navbar): audible time counts again from now.
			if (paused) {
				paused = false;
				openSegment();
			}
			return;
		}
		if (ours && state.paused) {
			// Paused: the pair, side and trims stay; silence never counts as listening.
			if (!paused) {
				paused = true;
				closeSegment();
			}
			return;
		}
		// Stopped, replaced or switched to raw elsewhere: no longer ours.
		release();
	}

	async function play(request: ListenRequest): Promise<void> {
		release();
		const target = options.engine();
		if (!target) throw new Error('audio-unavailable');
		const token = ++attempt;
		busy = true;
		let created: ABPreview | null = null;
		try {
			created = target.createAB(request.a.curve, request.b.curve, {
				experimental: true,
				initial: request.initial
			});
			// A comparison (and every blind round) starts at a random point of the file.
			await target.start('chains', { startAt: 'random', session: COMUNIDADE_SESSION });
			if (token !== attempt) {
				if (owned(target)) target.stop();
				created.dispose();
				return;
			}
			engine = target;
			preview = created;
			active = { request, side: request.initial };
			paused = false;
			unsubscribe = target.onChange(follow);
			openSegment();
		} catch (error) {
			if (owned(target)) target.stop();
			created?.dispose();
			throw error;
		} finally {
			if (token === attempt) busy = false;
		}
	}

	function select(side: ABSide) {
		if (!active || !preview) return;
		closeSegment();
		preview.select(side);
		active = { ...active, side };
		openSegment();
	}

	/** Pauses the running preview (`engine.pause()`), keeping it resumable. */
	function pause() {
		if (engine && active && !paused) engine.pause();
	}

	/** Continues the paused preview where it was (no new random point, same side). */
	async function resume(): Promise<boolean> {
		if (!engine || !active || !paused) return false;
		return engine.resume();
	}

	return {
		get busy() {
			return busy;
		},
		/** The running preview is paused (Transport, navbar). */
		get paused() {
			return paused;
		},
		/** The page's engine, for the Transport (null while the audio runtime loads). */
		get engine(): AudioEngine | null {
			return options.engine();
		},
		get active(): Readonly<Active> | null {
			return active;
		},
		get side(): ABSide | null {
			return active?.side ?? null;
		},
		get trims(): readonly [number, number] | null {
			return preview?.trims ?? null;
		},
		/** Owner of the running preview ('channel', 'scope', ...), or null. */
		get owner(): string | null {
			return active?.request.owner ?? null;
		},
		/** True while `lineageId` is the audible side of a non-blind preview (not while paused). */
		isPlaying(lineageId: string): boolean {
			return !!active && !paused && !active.request.blind && audibleLineage() === lineageId;
		},
		/**
		 * The chain of `lineageId` while it is audible (its real output feeds the LEDs); null while
		 * paused, so no LED lights without real frames.
		 */
		chainOf(lineageId: string): PreviewChain | null {
			if (!active || !preview || paused || active.request.blind) return null;
			if (audibleLineage() !== lineageId) return null;
			return active.side === 'A' ? preview.a : preview.b;
		},
		play,
		select,
		pause,
		resume,
		stop: release,
		/** Audible ms so far per lineage (closed segments only), for tests and diagnostics. */
		audibleMs(lineageId: string): number {
			return totals.get(lineageId) ?? 0;
		}
	};
}

export type Listener = ReturnType<typeof createListener>;
