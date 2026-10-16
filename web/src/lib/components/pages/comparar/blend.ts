import { curveResponseDb, distance, snapshotBands } from 'open-auri/dsp';
import type { createSolverWorker } from '#lib/workers/solver-client.ts';
import type { createGateWorker } from '#lib/workers/gate-client.ts';
import { blendTarget, snapshotCurve, type NamedCurve } from './comparison.ts';
import type { PreviewCurve } from '#lib/audio/engine.ts';

export interface BlendInput {
	base: NamedCurve;
	a: NamedCurve;
	b: NamedCurve;
	percent: number;
	/** null uses the solver's automatic headroom. */
	preampDb: number | null;
	name: string;
}
type GateClient = Pick<ReturnType<typeof createGateWorker>, 'commit'>;
type SolverClient = Pick<ReturnType<typeof createSolverWorker>, 'solve'>;
export type BlendResult =
	| { ok: true; curve: NamedCurve; target: number[]; rmsDb: number }
	| { ok: false; reasons: { code: string; stage?: number; value?: unknown; limit?: number }[] };

export async function solveBlend(
	input: BlendInput,
	solver: SolverClient,
	gate: GateClient
): Promise<BlendResult> {
	if (input.preampDb !== null && !Number.isFinite(input.preampDb)) {
		return { ok: false, reasons: [{ code: 'g:preamp', value: input.preampDb }] };
	}
	const base = snapshotCurve(input.base);
	const a = snapshotCurve(input.a);
	const b = snapshotCurve(input.b);
	const target = blendTarget(base, a, b, input.percent);
	let fitted: PreviewCurve;
	const standard = (curve: NamedCurve) =>
		curve.bands.every((band) => ['PK', 'LS', 'OFF'].includes(band.kind));
	if (input.percent === 0 && standard(base)) fitted = base;
	else if (
		input.percent === 100 &&
		standard(b) &&
		JSON.stringify([base.bands, base.preampDb]) === JSON.stringify([a.bands, a.preampDb])
	) {
		fitted = b;
	} else {
		const { result } = await solver.solve({
			options: {
				target,
				maxBands: 10,
				layer: 'ajustar',
				allowExperimental: false,
				weights: 'flat',
				maxIterations: 240,
				maxTimeMs: 1800
			}
		});
		fitted = result;
	}
	const curve: NamedCurve = {
		name: input.name,
		source: 'custom',
		bands: snapshotBands(fitted.bands),
		preampDb: input.preampDb ?? fitted.preampDb
	};
	const { verdict } = await gate.commit({ ...curve, experimental: true });
	if (!verdict.ok) return { ok: false, reasons: verdict.reasons };
	return { ok: true, curve, target, rmsDb: distance(target, curveResponseDb(curve)).rmsDb };
}
