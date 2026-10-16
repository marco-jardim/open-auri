import { expect, test } from 'vitest';
import {
	clamp,
	FLOOR_DB,
	formatSigned,
	linearPosition,
	pick,
	vuPosition
} from '#lib/components/meters/format.ts';

test('meter source selection does not substitute curve data for missing live readings', () => {
	expect(pick('live', undefined, 0)).toBeNull();
	expect(pick('live', null, 0)).toBeNull();
	expect(pick('live', NaN, 0)).toBeNull();
	expect(pick('live', Infinity, 0)).toBeNull();
	expect(pick('live', 0, -10)).toBe(0);
	expect(pick('data', 0, undefined)).toBeNull();
	expect(pick('data', 0, -Infinity)).toBeNull();
	expect(pick('data', 0, -10)).toBe(-10);
});

test('meter scales clamp both ends, preserve interior values, and show the floor at the stop', () => {
	expect(clamp(-2, -1, 1)).toBe(-1);
	expect(clamp(2, -1, 1)).toBe(1);
	expect(clamp(0, -1, 1)).toBe(0);
	expect(linearPosition(-40, -20, 0)).toBe(0);
	expect(linearPosition(10, -20, 0)).toBe(1);
	expect(linearPosition(-10, -20, 0)).toBe(0.5);
	expect(vuPosition(FLOOR_DB)).toBe(0);
	expect(vuPosition(-Infinity)).toBe(0);
	expect(vuPosition(NaN)).toBe(0);
	expect(vuPosition(20)).toBe(1);
	expect(vuPosition(0)).toBeCloseTo(10 ** (-3 / 20));
	expect(formatSigned(-1.25, 2, 'pt-BR')).toBe('−1,25');
	expect(formatSigned(1.25, 2, 'en-US')).toBe('+1.25');
	expect(formatSigned(0, 1, 'en-US')).toBe('0.0');
});
