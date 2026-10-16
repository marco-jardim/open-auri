/**
 * A/B preview and live meters of the Curva page, on the shared audio engine.
 * - `start` must be called from a user gesture (click/key); it builds A (reference) and B (editor)
 *   with `engine.createAB` (level-matched) and starts the engine in chain mode.
 * - meters: VU of the selected chain output (`tap`), one LED per active section of B
 *   (`tapStages`, mapped back to band indices) and the spectrum from `getAnalyserTap()`.
 * - `dispose` only releases this page's chains and taps, never the shared engine.
 */
import { AudioEngineError } from '#lib/audio/engine.ts';
import type { ABPreview, ABSide, AudioEngine } from '#lib/audio/engine.ts';
import { tap, tapStages, type MeterTap } from '#lib/audio/meters.ts';
import { LiveMeter } from '#lib/components/meters/index.ts';
import { hasExperimental, type Curve } from './model.ts';

export type PreviewError = 'gesture' | 'suspended' | 'unsupported' | 'failed';

export class CurvaPreview {
	playing = $state(false);
	side = $state<ABSide>('B');
	error = $state<PreviewError | null>(null);
	analyser = $state.raw<AnalyserNode | null>(null);
	readonly vu = new LiveMeter();
	readonly stages: readonly LiveMeter[] = Array.from({ length: 10 }, () => new LiveMeter());
	#engine: AudioEngine;
	#ab: ABPreview | null = null;
	#outputs: { A: MeterTap | null; B: MeterTap | null } = { A: null, B: null };
	#stageTaps: MeterTap[] = [];
	#generation = 0;

	constructor(engine: AudioEngine) {
		this.#engine = engine;
	}

	/** Call from a click or key handler only. */
	async start(reference: Curve, editor: Curve): Promise<void> {
		this.error = null;
		try {
			this.#build(reference, editor);
			await this.#engine.start('chains');
			this.playing = true;
			this.analyser = this.#engine.getAnalyserTap();
		} catch (cause) {
			this.#teardown();
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

	stop(): void {
		if (this.playing) this.#engine.stop();
		this.playing = false;
		this.#teardown();
	}

	/** Rebuilds the chains with new curves while playing (no-op when stopped). */
	update(reference: Curve, editor: Curve): void {
		if (this.playing) this.#build(reference, editor);
	}

	select(side: ABSide): void {
		this.side = side;
		this.#ab?.select(side);
		this.vu.connect(this.#outputs[side]);
	}

	dispose(): void {
		this.stop();
	}

	#build(reference: Curve, editor: Curve): void {
		const generation = ++this.#generation;
		const previous = this.#ab;
		this.#disconnectMeters();
		this.#ab = this.#engine.createAB(reference, editor, {
			experimental: hasExperimental(reference.bands) || hasExperimental(editor.bands),
			initial: this.side
		});
		previous?.dispose();
		void this.#connectMeters(generation, this.#ab, editor);
	}

	async #connectMeters(generation: number, ab: ABPreview, editor: Curve): Promise<void> {
		try {
			const [a, b, stages] = await Promise.all([
				tap(ab.a.output, { kinds: ['vu', 'truePeak'] }),
				tap(ab.b.output, { kinds: ['vu', 'truePeak'] }),
				tapStages(ab.b.stages)
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
		this.analyser = null;
	}
}
