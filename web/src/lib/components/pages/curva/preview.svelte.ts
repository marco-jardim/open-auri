/**
 * A/B preview and live meters of the Curva page, on the shared audio engine.
 * - `start` must be called from a user gesture (click/key); it builds A (reference) and B (editor)
 *   with `engine.createAB` (level-matched) and starts the engine in chain mode.
 * - meters: VU of the selected chain output (`tap`), one LED per active section of B
 *   (`tapStages`, mapped back to band indices) and the spectrum from `getAnalyserTap()` (the
 *   engine's pre-volume meter bus). Taps use the app's 0 VU reference (`reference` option).
 * - `stop`/`dispose` release this page's chains and taps and stop the shared engine only when this
 *   preview started it (or is starting it); they never dispose the engine.
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
import { LiveMeter } from '#lib/components/meters/index.ts';
import { hasExperimental, type Curve } from './model.ts';

export type PreviewError = 'gesture' | 'suspended' | 'unsupported' | 'failed';

export interface CurvaPreviewOptions {
	/** 0 VU reference for the taps (the app's `meterRef`); defaults to the module reference. */
	reference?: () => VuReference;
}

export class CurvaPreview {
	playing = $state(false);
	/** A new user-started session, shared by the social activity bridge. */
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
	#generation = 0;
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
	}

	/** Call from a click or key handler only. */
	async start(reference: Curve, editor: Curve): Promise<void> {
		this.session++;
		this.error = null;
		const attempt = ++this.#attempt;
		this.#latest = { reference, editor };
		try {
			this.#build(reference, editor);
			this.starting = true;
			this.#owns = true;
			this.#watch();
			// Called before the first await, while the gesture still grants user activation.
			await this.#engine.start('chains');
			if (attempt !== this.#attempt) {
				// Stopped or disposed while starting: the engine only reached chain mode now, after
				// stop() ran, so stop it again unless a newer start owns it.
				if (!this.#owns) this.#engine.stop();
				return;
			}
			this.starting = false;
			this.playing = true;
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

	/** Stops the engine whenever this preview started it or is starting it. */
	stop(): void {
		this.#attempt++;
		const owned = this.#owns;
		this.#owns = false;
		this.#unwatch();
		if (owned) this.#engine.stop();
		this.playing = false;
		this.starting = false;
		this.#latest = null;
		this.#teardown();
	}

	/**
	 * Rebuilds the chains with new curves while playing; while starting, keeps them for when the
	 * start resolves (no-op when stopped).
	 */
	update(reference: Curve, editor: Curve): void {
		if (this.playing) this.#build(reference, editor);
		else if (this.starting) this.#latest = { reference, editor };
	}

	select(side: ABSide): void {
		this.side = side;
		this.#ab?.select(side);
		this.vu.connect(this.#outputs[side]);
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

	dispose(): void {
		this.stop();
	}

	/** Follows the engine: rate changes (exactness) and a stop or switch to raw from elsewhere. */
	#watch(): void {
		if (this.#unsubscribe) return;
		this.#unsubscribe = this.#engine.onChange((state) => {
			this.exact = state.exact;
			if (this.playing && state.mode !== 'chains') {
				// Stopped by the chrome (or switched to raw): no longer this preview's to stop.
				this.#owns = false;
				this.playing = false;
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
			initial: this.side
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
			this.vu.connect(this.#outputs[this.side]);
			// Stage nodes exist only for non-OFF sections, in written order.
			const active = editor.bands.flatMap((band, index) => (band.kind === 'OFF' ? [] : [index]));
			active.forEach((bandIndex, k) => this.stages[bandIndex]?.connect(stages[k] ?? null));
		} catch (cause) {
			// Meters stay in DATA mode (labelled) when the worklet cannot load; audio keeps playing.
			console.warn('Curva meters unavailable', cause);
		}
	}

	#disconnectMeters(): void {
		this.vu.disconnect();
		for (const meter of this.stages) meter.disconnect();
		for (const handle of [this.#outputs.A, this.#outputs.B, ...this.#stageTaps]) {
			handle?.disconnect();
		}
		this.#outputs = { A: null, B: null };
		this.#stageTaps = [];
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
