import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { gateForWrite } from 'open-auri/safety';
import { clearGateVerdicts, gateVerdict } from '#lib/gate-verdicts.ts';
import {
	hasExperimental,
	verdictFor,
	type Band,
	type Curve
} from '#lib/components/pages/curva/model.ts';

vi.mock('open-auri/safety', async (importOriginal) => {
	const actual = await importOriginal<typeof import('open-auri/safety')>();
	return { ...actual, gateForWrite: vi.fn(actual.gateForWrite) };
});

const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
const cut: Curve = {
	bands: pad([{ kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 }]),
	preampDb: -1
};
const experimental: Curve = {
	bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]),
	preampDb: -0.5
};

beforeEach(() => {
	clearGateVerdicts();
	vi.mocked(gateForWrite).mockClear();
});
afterEach(() => clearGateVerdicts());

describe.each(['standard', 'yolo'] as const)('verdictFor in %s', (profile) => {
	it.each([
		['ordinary', cut],
		['experimental', experimental]
	] as const)(
		'judges an %s curve once, sharing the unchanged verdict with the preview',
		(_, curve) => {
			const options =
				profile === 'yolo'
					? { experimental: hasExperimental(curve.bands), profile }
					: { experimental: hasExperimental(curve.bands) };
			const first = verdictFor(curve, profile);
			expect(verdictFor(curve, profile)).toEqual(first);
			expect(gateVerdict(curve.bands, curve.preampDb, options)).toEqual(first);
			expect(gateForWrite).toHaveBeenCalledTimes(1);
			expect(gateForWrite).toHaveBeenCalledWith(curve.bands, curve.preampDb, options);
			expect(first).toEqual(gateForWrite(curve.bands, curve.preampDb, options));
		}
	);
});

it('annotates a legacy prefix reason on a copy without changing the cached verdict', () => {
	const boost: Band = { kind: 'PK', freqHz: 1000, gainDb: 9, qFactor: 1 };
	const curve: Curve = { bands: pad([boost, boost, boost, boost]), preampDb: -0.5 };
	const legacy = gateForWrite(curve.bands, curve.preampDb, { experimental: false });
	expect(legacy.reasons.some((reason) => reason.code === 'd:prefix-peak')).toBe(true);
	const stage = legacy.metrics.internalAudible?.stage;
	expect(stage).toBeDefined();
	for (const reason of legacy.reasons) {
		if (reason.code === 'd:prefix-peak') delete reason.stage;
		Object.freeze(reason);
	}
	Object.freeze(legacy.reasons);
	Object.freeze(legacy);
	const original = structuredClone(legacy);
	vi.mocked(gateForWrite).mockClear().mockReturnValueOnce(legacy);

	const cached = gateVerdict(curve.bands, curve.preampDb);
	const first = verdictFor(curve);
	expect(first).not.toBe(cached);
	expect(first).toEqual({
		...original,
		reasons: original.reasons.map((reason) =>
			reason.code === 'd:prefix-peak' ? { ...reason, stage } : reason
		)
	});
	expect(verdictFor(curve)).toEqual(first);
	expect(gateVerdict(curve.bands, curve.preampDb)).toBe(cached);
	expect(cached).toEqual(original);
	expect(gateForWrite).toHaveBeenCalledTimes(1);
});
