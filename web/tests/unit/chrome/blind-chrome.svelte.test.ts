/**
 * Slice 4 of issue #74: while a blind comparison runs on the cable, the chrome (top bar chip, the
 * Curva page's live panel) shows one constant "Teste cego em andamento" for every candidate, and
 * the bar chip stays the same whatever the unsaved flag says (it could flip when a candidate equals
 * the cable's saved curve, as one does here).
 */
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { planComparison } from '#lib/cable/compare.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { CABLE_LIVE_KEY } from '#lib/cable/service.ts';
import type { Band } from '#lib/cable/types.ts';
import { cableLiveUnsaved, liveBlind } from '#lib/components/cable/live.ts';
import CableBar from '#lib/components/chrome/CableBar.svelte';
import LivePanel from '#lib/components/pages/curva/LivePanel.svelte';
import { m } from '#lib/paraglide/messages.js';
import { fakeAppOptions } from '../app/fakes.ts';

vi.mock('#lib/workers/gate-client.ts', () => ({
	createGateWorker: () => ({
		commit: async () => ({ verdict: { ok: true, reasons: [] } }),
		dispose: () => undefined,
		cancel: () => undefined
	})
}));

const OFF: Band[] = Array.from({ length: 10 }, (): Band => ({ kind: 'OFF' }));
const SAVED = { bands: OFF, preampDb: -12 };
const LOUDER = {
	bands: [{ kind: 'PK', freqHz: 1000, gainDb: 3, qFactor: 1 } as Band, ...OFF.slice(1)],
	preampDb: -12
};
let apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps) app.dispose();
	apps = [];
	localStorage.removeItem(CABLE_LIVE_KEY);
	vi.restoreAllMocks();
});

async function blindApp() {
	const fake = fakeAppOptions();
	const app = createClientApp(fake.options);
	apps.push(app);
	await app.start();
	expect(await app.cable.connect()).not.toBeNull();
	const device = app.cable.getState().deviceLabel ?? '';
	// The cable's saved curve is the candidate the level match leaves untouched.
	const kept = planComparison([SAVED, LOUDER], { match: true }).items.find((item) => !item.matched);
	if (kept === undefined) throw new Error('expected an unmatched candidate');
	expect(
		app.state.journal.append({
			schema: 1,
			at: fake.time.value,
			name: 'Salva',
			crc: kept.crc,
			preampDb: kept.preampDb,
			bands: kept.bands,
			status: 'ok',
			device
		})
	).toBe(true);
	const outcome = await app.cable.startComparison({
		curves: [SAVED, LOUDER],
		match: true,
		blind: true,
		confirmations: { volumeLowered: true },
		gesture: createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ now: () => fake.time.value, userActivation: null }
		)
	});
	expect(outcome.status).toBe('accepted');
	return { app };
}

test('the top bar chip and the live panel stay constant for every candidate', async () => {
	const { app } = await blindApp();
	const bar = await render(CableBar, {
		liveBlind: liveBlind(app.cableState.live),
		liveUnsaved: cableLiveUnsaved(app.cableState, null)
	});
	await render(LivePanel, {
		app,
		curve: SAVED,
		experimental: false,
		profile: 'standard',
		saved: SAVED,
		blockedReason: null,
		locale: 'pt-BR'
	});
	const snapshots: { bar: string; panel: string }[] = [];
	for (const index of [0, 1, 0, 1]) {
		expect((await app.cable.switchComparison(index)).status).toBe('applied');
		await bar.rerender({
			liveBlind: liveBlind(app.cableState.live),
			liveUnsaved: cableLiveUnsaved(app.cableState, null)
		});
		await tick();
		const panel = document.querySelector('[data-live-panel]');
		expect(panel?.querySelector('[data-live-chip]')).toBeNull();
		expect(panel?.querySelector('[data-hold]')).toBeNull();
		snapshots.push({
			bar: document.querySelector('.live-slot')?.innerHTML ?? '',
			panel: panel?.textContent ?? ''
		});
	}
	// The chrome does not change with the candidate…
	expect(new Set(snapshots.map((s) => s.bar)).size).toBe(1);
	// …even when the unsaved flag would (a candidate equal to the saved curve).
	for (const liveUnsaved of [false, true]) {
		await bar.rerender({ liveBlind: true, liveUnsaved });
		await tick();
		expect(document.querySelector('.live-slot')?.innerHTML).toBe(snapshots[0]?.bar);
	}
	expect(new Set(snapshots.map((s) => s.panel)).size).toBe(1);
	expect(document.querySelector('[data-live-chip="blind"]')?.textContent).toContain(
		m.cable_blind_chrome()
	);
	expect(document.querySelector('[data-live-status]')?.textContent).toBe(m.cable_blind_chrome());
	expect(document.querySelector('[data-live-chip="bar"]')).toBeNull();
});
