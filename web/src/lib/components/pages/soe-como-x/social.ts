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

/** Do not sanitize provenance into invented names. The S5 validator refuses URL-like input. */
export function solverRecipe(station: StationState): Envelope['recipe'] {
	if (!station.measurement || !station.target || !station.result) return undefined;
	return {
		measurement: {
			source: station.measurement.credit?.source ?? station.measurement.kind,
			name: station.measurement.name
		},
		target: { source: station.target.kind, name: station.target.name },
		solver: { name: 'open-auri', version: corePackage.version },
		params: {
			speed: station.controls.speed,
			iso: station.controls.iso,
			d5Weight: station.controls.d5Weight
		}
	};
}
