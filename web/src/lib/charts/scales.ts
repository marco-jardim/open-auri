export interface Point {
	x: number;
	y: number;
}

export interface PlotBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

export const FREQUENCY_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
export const RESPONSE_BOX: PlotBox = { left: 66, top: 20, width: 722, height: 310 };

export function logScale(min = 20, max = 20000, start = 0, end = 1) {
	if (!(min > 0 && max > min)) throw new RangeError('Invalid log domain');
	const span = Math.log(max / min);
	return (value: number) => start + (Math.log(value / min) / span) * (end - start);
}

export function dbScale(min = -24, max = 12, start = 1, end = 0) {
	if (!(Number.isFinite(min) && Number.isFinite(max) && max > min)) {
		throw new RangeError('Invalid dB domain');
	}
	return (value: number) => start + ((value - min) / (max - min)) * (end - start);
}

export function dbTicks(min = -24, max = 12, step = 6): number[] {
	if (!(Number.isFinite(step) && step > 0 && Number.isFinite(min) && Number.isFinite(max))) {
		throw new RangeError('Invalid tick interval');
	}
	const count = Math.max(0, Math.floor(max / step) - Math.ceil(min / step) + 1);
	return Array.from({ length: count }, (_, i) => (Math.ceil(min / step) + i) * step);
}

/** Non-finite samples break a path rather than creating invalid SVG coordinates. */
export function linePath(points: readonly Point[], close = false): string {
	let penDown = false;
	let path = '';
	for (const { x, y } of points) {
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			penDown = false;
			continue;
		}
		path += `${penDown ? 'L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`;
		penDown = true;
	}
	return path && close ? `${path}Z` : path;
}

export function numberLabel(value: number, locale = 'en-US', digits = 0): string {
	return new Intl.NumberFormat(locale, {
		maximumFractionDigits: digits
	})
		.format(value)
		.replaceAll('-', '−');
}

export function frequencyLabel(value: number, locale = 'en-US'): string {
	return value >= 1000 ? `${numberLabel(value / 1000, locale, 1)}k` : numberLabel(value, locale);
}
