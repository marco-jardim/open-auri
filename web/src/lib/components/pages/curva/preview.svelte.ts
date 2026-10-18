/**
 * A/B preview and live meters of the Curva page, on the shared audio engine.
 * - `start` must be called from a user gesture (click/key); it builds A (reference) and B (editor)
 *   with `engine.createAB` (level-matched) and starts the engine in chain mode.
 * - meters: VU of the selected chain output (`tap`), one LED per active section of B
 *   (`tapStages`, mapped back to band indices) and the spectrum from `getAnalyserTap()` (the
 *   engine's pre-volume meter bus). Taps use the app's 0 VU reference (`reference` option).
 * - Transport (SEEK.2): a new preview starts at a random point in [25 %, 75 %] of the file
 *   (`startAt: 'random'`), tagged `CURVA_SESSION`; the file loops. The lever off (`stop`) and
 *   `pause` pause it, keeping the chains, the A/B selection, the trims and the taps: the
 *   Transport, the navbar or the lever continue it where it was. Only `dispose` (unmount) ends
 *   the session (`engine.stop()`) and releases this page's chains and taps; never the engine.
 * - A stop or dispose during the engine start wins: when the start resolves late, the engine is
 *   stopped again and nothing is left audible. An edit during the start is played once it resolves.
 */
import { AudioEngineError } from '#lib/audio/engine.ts';
import type { ABPreview, ABSide, AudioEngine } from '#lib/audio/engine.ts';
import {
	getReference,
	tap,
	tapStages,
	type MeterTap,
	type VuReference
} from '#lib/audio/meters.ts';
// Direct import (FUX.B): the meters barrel would bring every meter component into the page.
import { LiveMeter } from '#lib/components/meters/live.svelte.ts';
import { hasExperimental, type Curve } from './model.ts';

export type PreviewError = 'gesture' | 'suspended' | 'unsupported' | 'failed';

/** Session tag of the Curva preview (`engine.state().session`, the Transport and the navbar). */
export const CURVA_SESSION = 'curva';

export interface CurvaPreviewOptions {
	/**
	 * Modo YOLO is on (read at each A/B build): the A/B gets the engine's YOLO preview protection
	 * (float peak normalized to -1 dBFS, then a limiter). Off by default: nothing changes.
	 */
	yolo?: () => boolean;
	/** 0 VU reference for the taps (the app's `meterRef`); defaults to the module reference. */
	reference?: () => VuReference;
}

export class CurvaPreview {
	playing = $state(false);
	/** This preview's session is paused (resumable; chains, A/B and taps kept). */
	paused = $state(false);
	/** A new user-started session, shared by the social activity bridge (a resume is not new). */
	session = $state(0);
	/** True between the gesture and the engine start resolving. */
	starting = $state(false);
	/** False when the engine runs at a rate other than 96 kHz (approximate preview). */
	exact = $state(true);
	side = $state<ABSide>('B');
	error = $state<PreviewError | null>(null);
	analyser = $state.raw<AnalyserNode | null>(null);
	readonly vu = new LiveMeter();
	readonly stages: readonly LiveMeter[] = Array.from({ length: 10 }, () => new LiveMeter());
	#engine: AudioEngine;
	#reference: () => VuReference;
	#ab: ABPreview | null = null;
	#outputs: { A: MeterTap | null; B: MeterTap | null } = { A: null, B: null };
	#stageTaps: MeterTap[] = [];
	/** Band index of each stage tap (the editor's non-OFF sections, in written order). */
	#stageBands: number[] = [];
	#generation = 0;
	/** Whether Modo YOLO is on (the preview protection applies). */
	#yolo: () => boolean;
	/** Start attempts; `stop`/`dispose` bump it so a start still awaiting knows it lost. */
	#attempt = 0;
	/** This preview started (or is starting) chain mode, so it must stop it. */
	#owns = false;
	/** The curves the chains were last built from. */
	#built: { reference: Curve; editor: Curve } | null = null;
	/** The latest curves requested while starting. */
	#latest: { reference: Curve; editor: Curve } | null = null;
	#unsubscribe: (() => void) | null = null;
	#samples: Float32Array<ArrayBuffer> | null = null;

	constructor(engine: AudioEngine, options: CurvaPreviewOptions = {}) {
		this.#engine = engine;
		this.#reference = options.reference ?? getReference;
		this.#yolo = options.yolo ?? (() => false);
	}

	/**
	 * Call from a click or key handler only. Continues this preview's paused session where it
	 * was; otherwise builds the A/B and starts a new one at a random point of the file.
	 */
	async start(reference: Curve, editor: Curve): Promise<void> {
		const resuming = this.#resumable();
		if (!resuming) this.session++;
		this.error = null;
		const attempt = ++this.#attempt;
		this.#latest = { reference, editor };
		try {
			if (!resuming) this.#build(reference, editor);
			this.starting = true;
			this.#owns = true;
			this.#watch();
			// Called before the first await, while the gesture still grants user activation.
			if (resuming) {
				if (!(await this.#engine.resume())) throw new AudioEngineError('suspended');
			} else {
				await this.#engine.start('chains', { startAt: 'random', session: CURVA_SESSION });
			}
			if (attempt !== this.#attempt) {
				// Stopped or disposed while starting: the engine only reached chain mode now, after
				// stop() ran, so stop it again unless a newer start owns it.
				if (!this.#owns) this.#engine.stop();
				return;
			}
			this.starting = false;
			this.paused = false;
			this.playing = true;
			// A resume plays again: the meters held in DATA while paused read the taps again.
			if (resuming) this.#attachMeters();
			this.exact = this.#engine.state().exact;
			// An edit during the start must be heard, not the curve captured at the click.
			const latest = this.#latest;
			const built = this.#built;
			if (
				latest &&
				(!built || latest.reference !== built.reference || latest.editor !== built.editor)
			) {
				this.#build(latest.reference, latest.editor);
			}
			this.#latest = null;
			this.analyser = this.#engine.getAnalyserTap();
		} catch (cause) {
			if (attempt !== this.#attempt) return;
			this.#owns = false;
			this.#unwatch();
			this.#teardown();
			this.starting = false;
			this.paused = false;
			this.playing = false;
			if (cause instanceof AudioEngineError) {
				const { code } = cause;
				this.error =
					code === 'gesture' || code === 'suspended' || code === 'unsupported' ? code : 'failed';
			} else {
				this.error = 'failed';
				console.error('Curva preview failed', cause);
			}
		}
	}

	/**
	 * The lever off: pauses a playing preview (resumable) and cancels a start still in flight
	 * (the engine is stopped and the chains released). Teardown is `dispose`.
	 */
	stop(): void {
		if (this.playing) this.pause();
		else if (this.starting) this.#end();
	}

	/** Pauses this preview (`engine.pause()`): position, chains, A/B selection and trims stay. */
	pause(): void {
		if (!this.playing || !this.#owns) return;
		this.playing = false;
		this.paused = true;
		this.#detachMeters();
		this.#engine.pause();
	}

	/** This preview owns the engine's paused session and still has its chains. */
	#resumable(): boolean {
		if (!this.paused || !this.#owns || !this.#ab) return false;
		const state = this.#engine.state();
		return state.paused && state.session === CURVA_SESSION;
	}

	/** Ends the session (stopping the engine when this preview owns it) and releases everything. */
	#end(): void {
		this.#attempt++;
		const owned = this.#owns;
		this.#owns = false;
		this.#unwatch();
		if (owned) this.#engine.stop();
		this.playing = false;
		this.paused = false;
		this.starting = false;
		this.#latest = null;
		this.#teardown();
	}

	/**
	 * Rebuilds the chains with new curves while playing or paused (a resume from the Transport or
	 * the navbar plays the current curves); while starting, keeps them for when the start
	 * resolves (no-op when stopped). The new A/B exists before the old one goes, so a paused
	 * session never loses its chains.
	 */
	update(reference: Curve, editor: Curve): void {
		if (this.starting) this.#latest = { reference, editor };
		else if (this.playing || this.paused) this.#build(reference, editor);
	}

	select(side: ABSide): void {
		this.side = side;
		this.#ab?.select(side);
		// Paused: no real frames, so the meters stay in DATA until the resume.
		if (!this.paused) this.vu.connect(this.#outputs[side]);
	}

	/** Conservative proof of audible editor output; no context is created while idle. */
	audibleEditorTime(): number | null {
		const analyser = this.analyser;
		const ab = this.#ab;
		if (!this.playing || this.side !== 'B' || !analyser || !ab) return null;
		const state = this.#engine.state();
		const context = this.#engine.getContext();
		if (!state.playing || state.mode !== 'chains' || context.state !== 'running') return null;
		const volume = ab.b.volume.gain.value;
		if (!(volume > 0)) return null;
		if (this.#samples?.length !== analyser.fftSize) {
			this.#samples = new Float32Array(analyser.fftSize);
		}
		analyser.getFloatTimeDomainData(this.#samples);
		// The analyser is pre-monitor-volume. Inspect real PCM and the actual monitor gain, not
		// a peak-hold meter, so a silent file/muted output can never earn an activity event.
		return this.#samples.some((sample) => Math.abs(sample) * volume > 0.00001)
			? context.currentTime
			: null;
	}

	/** Unmount: ends the session (`engine.stop()` when owned) and disposes the chains. */
	dispose(): void {
		this.#end();
	}

	/**
	 * Follows the engine: rate changes (exactness); a pause or resume of this session from the
	 * Transport or the navbar; and a stop, another page's session or raw playback from elsewhere.
	 */
	#watch(): void {
		if (this.#unsubscribe) return;
		this.#unsubscribe = this.#engine.onChange((state) => {
			this.exact = state.exact;
			const ours = state.session === CURVA_SESSION;
			if (ours && state.playing && state.mode === 'chains') {
				// Continued from the Transport or the navbar (a resume of our own is still starting).
				if (this.#owns && this.paused && !this.starting) {
					this.paused = false;
					this.playing = true;
					this.#attachMeters();
				}
				return;
			}
			if (ours && state.paused) {
				// Paused from the Transport or the navbar: the session, chains and taps stay; the
				// meters show DATA (no real frames) until the resume.
				if (this.playing) {
					this.playing = false;
					this.paused = true;
					this.#detachMeters();
				}
				return;
			}
			if (this.playing || this.paused) {
				// Stopped by the chrome, replaced or switched to raw: no longer this preview's to stop,
				// and its meters no longer get real frames.
				this.#owns = false;
				this.playing = false;
				this.paused = false;
				this.#detachMeters();
			}
		});
	}

	#unwatch(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}

	#build(reference: Curve, editor: Curve): void {
		const generation = ++this.#generation;
		const previous = this.#ab;
		this.#disconnectMeters();
		this.#ab = this.#engine.createAB(reference, editor, {
			experimental: hasExperimental(reference.bands) || hasExperimental(editor.bands),
			initial: this.side,
			// Modo YOLO previews only: normalized to -1 dBFS and limited (engine, opt-in).
			...(this.#yolo() ? { protect: 'yolo' as const } : {})
		});
		this.#built = { reference, editor };
		previous?.dispose();
		void this.#connectMeters(generation, this.#ab, editor);
	}

	async #connectMeters(generation: number, ab: ABPreview, editor: Curve): Promise<void> {
		try {
			const reference = this.#reference();
			const [a, b, stages] = await Promise.all([
				tap(ab.a.output, { kinds: ['vu', 'truePeak'], reference }),
				tap(ab.b.output, { kinds: ['vu', 'truePeak'], reference }),
				tapStages(ab.b.stages, { reference })
			]);
			if (generation !== this.#generation) {
				for (const handle of [a, b, ...stages]) handle.disconnect();
				return;
			}
			this.#outputs = { A: a, B: b };
			this.#stageTaps = stages;
			// Stage nodes exist only for non-OFF sections, in written order.
			this.#stageBands = editor.bands.flatMap((band, index) =>
				band.kind === 'OFF' ? [] : [index]
			);
			// Taps of chains rebuilt while paused wait for the resume (no real frames meanwhile).
			if (!this.paused) this.#attachMeters();
		} catch (cause) {
			// Meters stay in DATA mode (labelled) when the worklet cannot load; audio keeps playing.
			console.warn('Curva meters unavailable', cause);
		}
	}

	/** Meters read the current taps: VU of the selected side, one LED per active section. */
	#attachMeters(): void {
		this.vu.connect(this.#outputs[this.side]);
		this.#stageBands.forEach((bandIndex, k) =>
			this.stages[bandIndex]?.connect(this.#stageTaps[k] ?? null)
		);
	}

	/** Meters back to DATA, keeping the taps for a resume (pause). */
	#detachMeters(): void {
		this.vu.disconnect();
		for (const meter of this.stages) meter.disconnect();
	}

	#disconnectMeters(): void {
		this.#detachMeters();
		for (const handle of [this.#outputs.A, this.#outputs.B, ...this.#stageTaps]) {
			handle?.disconnect();
		}
		this.#outputs = { A: null, B: null };
		this.#stageTaps = [];
		this.#stageBands = [];
	}

	#teardown(): void {
		this.#generation += 1;
		this.#disconnectMeters();
		this.#ab?.dispose();
		this.#ab = null;
		this.#built = null;
		this.analyser = null;
		this.#samples = null;
	}
}
