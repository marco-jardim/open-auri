import { expect, test } from 'vitest';
import { gateForWrite } from 'open-auri/safety';

test('the workspace safety gate accepts Neutro', () => {
	const bands = Array.from({ length: 10 }, () => ({ kind: 'OFF' as const }));
	const result = gateForWrite(bands, -0.5);
	expect(result.ok).toBe(true);
	expect(result.reasons).toEqual([]);
});
