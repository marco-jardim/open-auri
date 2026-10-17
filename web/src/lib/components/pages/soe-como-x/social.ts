import { curveResponseDb, GRID } from 'open-auri/dsp';
import { normalize } from 'open-auri/io';
import type { validateEnvelope } from 'open-auri/share';
import corePackage from 'open-auri/package.json';
import type { CurveData } from '#lib/state/model.ts';
import type { StationState, Trace } from './model.ts';

type Envelope = Extract<ReturnType<typeof validateEnvelope>, { ok: true }>['value'];

export function socialTarget(curve: CurveData): Trace {
	return {
		name: curve.name,
		kind: 'community',
		values: normalize(curveResponseDb(curve, GRID), GRID),
		credit: { source: 'Community' }
	};
}

/** Only AutoEq traces have names/credits selected from the embedded dataset, not user input. */
function recipeTrace(trace: Trace, role: 'measurement' | 'target') {
	if (trace.kind === 'autoeq') {
		return { source: trace.credit?.source ?? 'autoeq', name: trace.name };
	}
	return {
		source: trace.kind,
		name: `${trace.kind === 'csv' ? 'imported' : trace.kind} ${role}`
	};
}

/** Local file names and other free-text trace labels never become public recipe metadata. */
export function solverRecipe(station: StationState): Envelope['recipe'] {
	if (!station.measurement || !station.target || !station.result) return undefined;
	return {
		measurement: recipeTrace(station.measurement, 'measurement'),
		target: recipeTrace(station.target, 'target'),
		solver: { name: 'open-auri', version: corePackage.version },
		params: {
			speed: station.controls.speed,
			iso: station.controls.iso,
			d5Weight: station.controls.d5Weight
		}
	};
}
