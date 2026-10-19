// Unbiased random values for test fixtures (unique curves). `randomInt` masks a 32-bit draw to the
// smallest power of two that covers the range and draws again when the value falls outside it
// (rejection sampling): every value of the range is equally likely. A plain `draw % span` favors
// the low values whenever 2^32 is not a multiple of `span`. Decimal fixtures are picked from their
// grid (`randomPick`, `randomTenths`) instead of dividing a random integer, so a value always lies
// on its grid (tenths of a dB for gains and preamps) and inside its range.

/** A uniform integer of [min, max], both included (at most 2^31 values). */
export function randomInt(min: number, max: number): number {
	const span = max - min + 1;
	if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || span < 1 || span > 2 ** 31) {
		throw new RangeError(`randomInt: invalid range [${min}, ${max}]`);
	}
	let mask = 1;
	while (mask < span) mask *= 2;
	mask -= 1;
	for (;;) {
		const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
		const draw = value & mask;
		if (draw < span) return min + draw;
	}
}

/** One element of `values` (not empty), each equally likely. */
export function randomPick<T>(values: readonly T[]): T {
	if (values.length === 0) throw new RangeError('randomPick: no values');
	const value = values[randomInt(0, values.length - 1)];
	if (value === undefined) throw new RangeError('randomPick: hole in the values');
	return value;
}

/** Tenths from `fromTenths / 10` to `toTenths / 10` (e.g. 60 and 90: 6.0, 6.1, …, 9.0). */
export function tenthsGrid(fromTenths: number, toTenths: number): number[] {
	return Array.from({ length: toTenths - fromTenths + 1 }, (_, i) => (fromTenths + i) / 10);
}

/** A uniform value of {@link tenthsGrid}`(fromTenths, toTenths)`. */
export function randomTenths(fromTenths: number, toTenths: number): number {
	return randomPick(tenthsGrid(fromTenths, toTenths));
}
