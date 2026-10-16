/**
 * Number formatting and scale mapping shared by the meter components. Pure functions, no DSP:
 * readings come ready from the worklet (core meters) or from curve data.
 */

/** Lowest reading the core meters return (FLOOR_DB of `open-auri/meter`). */
export const FLOOR_DB = -120;

/** VU scale limits, in VU. */
export const VU_MIN = -20;
export const VU_MAX = 3;

/** True-peak lamp threshold, in dBTP. */
export const TRUE_PEAK_LIMIT_DB = -1;

/** Peak hold time of the LED ladder and of the true-peak lamp, in ms. */
export const PEAK_HOLD_MS = 1500;

/** BS.1770 absolute gate; lower loudness readings are shown as "no signal". */
export const LOUDNESS_GATE_LUFS = -70;

/** Minimum interval between numeric updates (10 Hz), in ms. */
export const READOUT_INTERVAL_MS = 100;

const MINUS = '\u2212';

/** Locale number with a fixed number of decimals, explicit sign and a real minus sign (U+2212). */
export function formatSigned(value: number, digits: number, locale: string): string {
	const text = new Intl.NumberFormat(locale, {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
		signDisplay: 'exceptZero'
	}).format(value);
	return text.replace('-', MINUS);
}

/** Picks the value to show: live reading in live mode, curve data otherwise; null means dark. */
export function pick(
	mode: 'live' | 'data',
	live: number | null | undefined,
	data: number | null | undefined
): number | null {
	const value = mode === 'live' ? live : data;
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

/**
 * Needle position on a VU scale, 0 (left stop) to 1 (+3 VU). A VU scale is linear in deflection
 * (voltage), not in dB, so 0 VU sits at 10^(−3/20) ≈ 70.8 % of the arc.
 */
export function vuPosition(vu: number): number {
	if (!(vu > FLOOR_DB)) return 0;
	return clamp(10 ** ((vu - VU_MAX) / 20), 0, 1);
}

/** Linear position of a dB value between `min` and `max`, 0 to 1. */
export function linearPosition(value: number, min: number, max: number): number {
	return clamp((value - min) / (max - min), 0, 1);
}
