/**
 * AudioWorkletProcessor `oa-meter`: live metering with the core DSP of `open-auri/meter`.
 *
 * Bundling: the main thread loads this file with `import url from './meter-processor.js?worker&url'`
 * (see `meters.ts`). In `vite build` that query makes Vite bundle this entry and everything it
 * imports (the processing core and `open-auri/meter`) into one self-contained asset and return its
 * URL, which is passed to `audioWorklet.addModule(url)`. A plain `new URL('./meter-processor.js',
 * import.meta.url)` would copy the file as a static asset with its bare `open-auri/meter` import
 * unresolved, so it is not used. In `vite dev` the URL points at the module served by Vite (ES module
 * imports work in worklets). The entry has no exports because the worker bundle is an IIFE.
 *
 * Protocol
 * - `processorOptions`: `{ kinds?: MeterKind[], reference?: -18 | -20 | -14, ppmType?: 'I' | 'II' }`.
 * - Posts `{ vuL, vuR, ppmL, ppmR, truePeakDb, lufsM, lufsS, correlation, active }` at ≈ 60 Hz while
 *   there is signal, one frame with `active: false` when it stops, then nothing until it returns.
 * - Accepts `{ type: 'reference', value }`, `{ type: 'ppmType', value }` and `{ type: 'reset' }`.
 * @module
 */

import {
	METER_PROCESSOR_NAME,
	RENDER_QUANTUM,
	createMeterCore,
	readCoreOptions
} from '../components/meters/meter-core.js';

/**
 * @typedef {object} ProcessorBase
 * @property {MessagePort} port
 */

/**
 * @typedef {object} WorkletScope
 * @property {new (options?: unknown) => ProcessorBase} AudioWorkletProcessor
 * @property {(name: string, processor: new (options?: { processorOptions?: unknown }) => ProcessorBase) => void} registerProcessor
 * @property {number} sampleRate
 */

// AudioWorkletGlobalScope members are not in the DOM lib, so they are read through a typed view.
const scope = /** @type {WorkletScope} */ (/** @type {unknown} */ (globalThis));

class MeterProcessor extends scope.AudioWorkletProcessor {
	/** @param {{ processorOptions?: unknown }} [options] */
	constructor(options) {
		super(options);
		const settings = readCoreOptions(options?.processorOptions);
		this.core = createMeterCore({ sampleRate: scope.sampleRate, ...settings });
		this.port.onmessage = (event) => {
			this.core.handle(event.data);
		};
	}

	/**
	 * @param {Float32Array[][]} inputs
	 * @returns {boolean}
	 */
	process(inputs) {
		const input = inputs[0];
		const left = input !== undefined && input.length > 0 ? input[0] : undefined;
		const right = input !== undefined && input.length > 1 ? input[1] : undefined;
		const frame = this.core.process(left, right, RENDER_QUANTUM);
		if (frame !== null) this.port.postMessage(frame);
		return true;
	}
}

scope.registerProcessor(METER_PROCESSOR_NAME, MeterProcessor);
