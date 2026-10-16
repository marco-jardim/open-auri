import type { MeterFrame, MeterMode, MeterSource } from '#lib/audio/meters.ts';

/**
 * Reactive view of a meter source (a tap from `#lib/audio/meters.ts` or a fake): `frame` is the
 * latest live frame (null in data mode) and `mode` is `live` or `data`.
 */
export class LiveMeter {
	frame = $state<MeterFrame | null>(null);
	mode = $state<MeterMode>('data');
	#unsubscribe: (() => void) | null = null;

	connect(source: MeterSource | null): void {
		this.disconnect();
		if (source === null) return;
		this.#unsubscribe = source.subscribe((update) => {
			this.frame = update.frame;
			this.mode = update.mode;
		});
	}

	disconnect(): void {
		if (this.#unsubscribe !== null) this.#unsubscribe();
		this.#unsubscribe = null;
		this.frame = null;
		this.mode = 'data';
	}
}
