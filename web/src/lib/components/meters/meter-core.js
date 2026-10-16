/**
 * Pure processing core of the `oa-meter` AudioWorklet (`#lib/audio/meter-processor.js`).
 *
 * It owns the core meters from `open-auri/meter` (no DSP is reimplemented here), feeds them one
 * render quantum at a time and decides when to publish a frame:
 * - frames are accumulated and published at ≈ {@link PUBLISH_HZ} Hz (the remainder carries over, so
 *   the long-run rate is exact for any sample rate);
 * - an interval is "active" when any sample exceeds {@link ACTIVE_AMPLITUDE} (−100 dBFS);
 * - silence publishes exactly one frame with `active: false`, then nothing until signal returns.
 *
 * `process()` does no allocation on blocks that do not publish: readings go into the preallocated
 * {@link MeterCore.values} array and a plain frame object is built only at publish rate.
 *
 * It lives in its own module, with no worklet globals, so it can be unit-tested in Node and so the
 * worklet entry has no exports (the worklet bundle is an IIFE in `vite build`).
 * @module
 */

import {
	FLOOR_DB,
	VU_DEFAULT_REFERENCE,
	VU_REFERENCE_LEVELS,
	createCorrelationMeter,
	createLoudnessMeter,
	createPpmMeter,
	createTruePeakMeter,
	createVuMeter
} from 'open-auri/meter';

/** Name passed to `registerProcessor` and `new AudioWorkletNode`. */
export const METER_PROCESSOR_NAME = 'oa-meter';

/** Target publish rate, in Hz. */
export const PUBLISH_HZ = 60;

/** Linear amplitude above which a block counts as signal (−100 dBFS). */
export const ACTIVE_AMPLITUDE = 1e-5;

/** Size of a Web Audio render quantum. */
export const RENDER_QUANTUM = 128;

/** @typedef {'vu' | 'ppm' | 'truePeak' | 'loudness' | 'correlation'} MeterKind */
/** @typedef {'I' | 'II'} PpmType */

/** Every meter kind the core can run. */
export const METER_KINDS = /** @type {readonly MeterKind[]} */ (
	Object.freeze(['vu', 'ppm', 'truePeak', 'loudness', 'correlation'])
);

/**
 * Order of the numeric readings in {@link MeterCore.values} (`active` is stored as 0 or 1).
 */
export const FRAME_KEYS = Object.freeze([
	'vuL',
	'vuR',
	'ppmL',
	'ppmR',
	'truePeakDb',
	'lufsM',
	'lufsS',
	'correlation',
	'active'
]);

/**
 * One published reading. Levels are floored at −120 (FLOOR_DB of the core); meters that are not
 * running for this tap report the floor (correlation reports 0).
 * @typedef {object} MeterFrame
 * @property {number} vuL Left VU reading, in VU (dB re the 0 VU alignment).
 * @property {number} vuR Right VU reading, in VU.
 * @property {number} ppmL Left PPM reading, in dBFS.
 * @property {number} ppmR Right PPM reading, in dBFS.
 * @property {number} truePeakDb Highest true peak of both channels since the previous frame, in dBTP.
 * @property {number} lufsM Momentary loudness (400 ms), in LUFS.
 * @property {number} lufsS Short-term loudness (3 s), in LUFS.
 * @property {number} correlation Stereo correlation in [−1, 1] (0 when either channel is silent).
 * @property {boolean} active True when the interval carried signal above −100 dBFS.
 */

/**
 * @typedef {object} MeterCoreOptions
 * @property {number} sampleRate
 * @property {readonly MeterKind[]} [kinds] Meters to run (default: all).
 * @property {number} [reference] 0 VU alignment in dBFS: −18 (default), −20 or −14.
 * @property {PpmType} [ppmType] Default 'II'.
 * @property {number} [publishHz] Default {@link PUBLISH_HZ}.
 */

/**
 * @typedef {{ type: 'reference', value: number } | { type: 'ppmType', value: PpmType } | { type: 'reset' }} MeterCommand
 */

/**
 * @typedef {object} MeterCore
 * @property {(left: Float32Array | undefined, right?: Float32Array, frameCount?: number) => MeterFrame | null} process
 *   Feeds one block (missing input counts as silence of `frameCount` frames) and returns a frame
 *   when one is due, else null.
 * @property {(command: unknown) => boolean} handle Applies a {@link MeterCommand}; false if invalid.
 * @property {Float64Array} values Latest published readings in {@link FRAME_KEYS} order.
 * @property {readonly MeterKind[]} kinds
 * @property {number} interval Frames between publishes.
 * @property {() => number} reference
 * @property {() => PpmType} ppmType
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isVuReference(value) {
	return typeof value === 'number' && VU_REFERENCE_LEVELS.includes(value);
}

/**
 * @param {unknown} value
 * @returns {value is PpmType}
 */
export function isPpmType(value) {
	return value === 'I' || value === 'II';
}

/**
 * Keeps the known kinds, without duplicates, in canonical order; empty or missing means all.
 * @param {unknown} kinds
 * @returns {readonly MeterKind[]}
 */
export function normalizeKinds(kinds) {
	if (!Array.isArray(kinds)) return METER_KINDS;
	const picked = METER_KINDS.filter((kind) => kinds.includes(kind));
	return picked.length === 0 ? METER_KINDS : Object.freeze(picked);
}

/**
 * Reads `processorOptions` sent from the main thread; invalid fields fall back to the defaults.
 * @param {unknown} raw
 * @returns {{ kinds: readonly MeterKind[], reference: number, ppmType: PpmType }}
 */
export function readCoreOptions(raw) {
	/** @type {Record<string, unknown>} */
	const record =
		raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
	return {
		kinds: normalizeKinds(record.kinds),
		reference: isVuReference(record.reference) ? record.reference : VU_DEFAULT_REFERENCE,
		ppmType: isPpmType(record.ppmType) ? record.ppmType : 'II'
	};
}

/**
 * @param {Float32Array} samples
 * @param {number} n
 * @returns {boolean}
 */
function hasSignal(samples, n) {
	for (let i = 0; i < n; i++) {
		const x = samples[i];
		if (x > ACTIVE_AMPLITUDE || x < -ACTIVE_AMPLITUDE) return true;
	}
	return false;
}

/**
 * Creates the processing core.
 * @param {MeterCoreOptions} options
 * @returns {MeterCore}
 */
export function createMeterCore(options) {
	const sampleRate = options.sampleRate;
	const kinds = normalizeKinds(options.kinds);
	let reference = options.reference ?? VU_DEFAULT_REFERENCE;
	if (!isVuReference(reference)) {
		throw new RangeError(`VU reference must be one of ${VU_REFERENCE_LEVELS.join(', ')} dBFS`);
	}
	/** @type {PpmType} */
	let ppmType = options.ppmType ?? 'II';
	if (!isPpmType(ppmType)) throw new RangeError(`PPM type must be 'I' or 'II'`);
	const publishHz = options.publishHz ?? PUBLISH_HZ;
	if (!(publishHz > 0)) throw new RangeError('publishHz must be positive');

	/** @type {ReturnType<typeof createVuMeter> | null} */
	let vu = kinds.includes('vu') ? createVuMeter({ sampleRate, reference }) : null;
	/** @type {ReturnType<typeof createPpmMeter> | null} */
	let ppm = kinds.includes('ppm') ? createPpmMeter({ sampleRate, type: ppmType }) : null;
	const truePeak = kinds.includes('truePeak') ? createTruePeakMeter({ sampleRate }) : null;
	const loudness = kinds.includes('loudness') ? createLoudnessMeter({ sampleRate }) : null;
	const correlation = kinds.includes('correlation') ? createCorrelationMeter({ sampleRate }) : null;

	const interval = Math.max(1, Math.round(sampleRate / publishHz));
	const values = new Float64Array(FRAME_KEYS.length);
	let silence = new Float32Array(RENDER_QUANTUM);
	let pending = 0;
	let intervalActive = false;
	let lastPublishedActive = false;

	function clearValues() {
		values.fill(FLOOR_DB);
		values[7] = 0;
		values[8] = 0;
	}
	clearValues();

	/**
	 * Reads every running meter into `values` and builds the message (publish rate only).
	 * @param {boolean} active
	 * @returns {MeterFrame}
	 */
	function publish(active) {
		if (vu !== null) {
			const r = vu.read();
			values[0] = r.left;
			values[1] = r.right;
		}
		if (ppm !== null) {
			const r = ppm.read();
			values[2] = r.left;
			values[3] = r.right;
		}
		if (truePeak !== null) {
			values[4] = truePeak.read().max;
			// Restart the running maximum (public state API) so each frame carries the true peak of
			// its own interval; the interpolation history is kept, so no false edge is introduced.
			const state = truePeak.getState();
			state.peaks.fill(0);
			truePeak.setState(state);
		}
		if (loudness !== null) {
			const r = loudness.read();
			values[5] = r.momentary;
			values[6] = r.shortTerm;
		}
		if (correlation !== null) values[7] = correlation.read().correlation;
		values[8] = active ? 1 : 0;
		return {
			vuL: values[0],
			vuR: values[1],
			ppmL: values[2],
			ppmR: values[3],
			truePeakDb: values[4],
			lufsM: values[5],
			lufsS: values[6],
			correlation: values[7],
			active
		};
	}

	/**
	 * @param {Float32Array | undefined} leftIn
	 * @param {Float32Array} [rightIn]
	 * @param {number} [frameCount]
	 * @returns {MeterFrame | null}
	 */
	function process(leftIn, rightIn, frameCount = RENDER_QUANTUM) {
		/** @type {Float32Array} */
		let left;
		/** @type {Float32Array | undefined} */
		let right = rightIn;
		if (leftIn === undefined) {
			if (silence.length !== frameCount) silence = new Float32Array(frameCount);
			left = silence;
			right = undefined;
		} else {
			left = leftIn;
			if (right !== undefined && right.length < left.length) right = undefined;
		}
		const n = left.length;
		if (n === 0) return null;
		if (!intervalActive && (hasSignal(left, n) || (right !== undefined && hasSignal(right, n)))) {
			intervalActive = true;
		}
		if (vu !== null) vu.process(left, right);
		if (ppm !== null) ppm.process(left, right);
		if (truePeak !== null) truePeak.process(left, right);
		if (loudness !== null) loudness.process(left, right);
		if (correlation !== null) correlation.process(left, right);

		pending += n;
		if (pending < interval) return null;
		pending %= interval;
		const active = intervalActive;
		intervalActive = false;
		if (!active && !lastPublishedActive) return null;
		lastPublishedActive = active;
		return publish(active);
	}

	/**
	 * @param {unknown} command
	 * @returns {boolean}
	 */
	function handle(command) {
		if (command === null || typeof command !== 'object') return false;
		const record = /** @type {Record<string, unknown>} */ (command);
		if (record.type === 'reference') {
			const value = record.value;
			if (!isVuReference(value)) return false;
			if (value === reference) return true;
			reference = value;
			if (vu !== null) {
				// The filter state is an absolute amplitude, so it carries over to the new alignment
				// and the needle does not jump back to rest.
				const state = vu.getState();
				vu = createVuMeter({ sampleRate, reference: value });
				vu.setState({ ...state, reference: value });
			}
			return true;
		}
		if (record.type === 'ppmType') {
			const value = record.value;
			if (!isPpmType(value)) return false;
			if (value === ppmType) return true;
			ppmType = value;
			if (ppm !== null) ppm = createPpmMeter({ sampleRate, type: value });
			return true;
		}
		if (record.type === 'reset') {
			vu?.reset();
			ppm?.reset();
			truePeak?.reset();
			loudness?.reset();
			correlation?.reset();
			pending = 0;
			intervalActive = false;
			lastPublishedActive = false;
			clearValues();
			return true;
		}
		return false;
	}

	return {
		process,
		handle,
		values,
		kinds,
		interval,
		reference: () => reference,
		ppmType: () => ppmType
	};
}
