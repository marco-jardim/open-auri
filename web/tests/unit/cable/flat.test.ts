import { expect, test, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import type { ClientApp } from '#lib/app/client.svelte.ts';
import type { LiveState } from '#lib/cable/types.ts';
import { appBrowserFlat, flatCurve, liveComparing } from '#lib/components/cable/flat.ts';

function live(overrides: Partial<LiveState> = {}): LiveState {
	return {
		deviceLabel: 'Cabo',
		status: 'live',
		applied: null,
		pending: false,
		ackLevelDb: null,
		hold: null,
		applies: 1,
		total: 1,
		lastError: null,
		...overrides
	};
}

function client(state: LiveState | null, orphan = false) {
	const liveSavedCurve = vi.fn(() => null);
	const app = {
		cableState: {
			live: state,
			liveOrphan: orphan ? { crc: 1, at: 0, deviceLabel: 'Cabo' } : null,
			deviceLabels: ['Cabo']
		},
		cable: { liveSavedCurve }
	} as unknown as ClientApp;
	return { app, liveSavedCurve };
}

test('appBrowserFlat tolerates null and app stubs without cableState', () => {
	expect(appBrowserFlat(null)).toBe(false);
	expect(appBrowserFlat({} as ClientApp)).toBe(false);
});

test('without live, no saved curve is read; an orphan still flattens the browser', () => {
	const idle = client(null);
	expect(appBrowserFlat(idle.app)).toBe(false);
	expect(idle.liveSavedCurve).not.toHaveBeenCalled();
	expect(appBrowserFlat(client(null, true).app)).toBe(true);
});

test.each([true, false])(
	'appBrowserFlat follows cableEq=%s and reads the live saved curve',
	(cableEq) => {
		const { app, liveSavedCurve } = client(live({ cableEq }));
		expect(appBrowserFlat(app)).toBe(cableEq);
		expect(liveSavedCurve).toHaveBeenCalledOnce();
	}
);

test('flatCurve preserves metadata and object shape, replacing only EQ with a Neutro snapshot', () => {
	const curve = {
		name: 'Original',
		source: 'custom',
		bands: [{ kind: 'OFF' as const }],
		preampDb: -12,
		extra: { id: 3 }
	};
	const flat = flatCurve(curve);
	expect(flat).toEqual({ ...curve, bands: snapshotBands(NEUTRO.bands), preampDb: NEUTRO.preampDb });
	expect(flat).not.toBe(curve);
	expect(flat.extra).toBe(curve.extra);
	expect(flat.bands).not.toBe(NEUTRO.bands);
	expect(curve.preampDb).toBe(-12);
});

test('liveComparing only identifies active, non-blind, non-ended comparisons', () => {
	const comparison = { active: true, blind: false, count: 2, status: 'ready' as const };
	expect(liveComparing(live({ comparison }))).toBe(true);
	expect(liveComparing(live({ comparison: { ...comparison, blind: true } }))).toBe(false);
	expect(liveComparing(live({ comparison: { ...comparison, active: false } }))).toBe(false);
	expect(liveComparing(live({ comparison, status: 'ended' }))).toBe(false);
	expect(liveComparing(live())).toBe(false);
	expect(liveComparing(null)).toBe(false);
	expect(liveComparing(undefined)).toBe(false);
});
