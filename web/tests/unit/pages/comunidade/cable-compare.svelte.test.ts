// Issue #89, slice 4: "Comparar no cabo" on the Comunidade scope pair (a real app and a FakeHID
// cable). The scope's A/B keys mirror to the cable; a change of the selection ends the comparison
// as stale; while the cable plays an unsaved curve the non-blind previews play flat (rebuilt in
// place); the blind rounds (S6, S7) never go flat and say what the connected cable adds.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { CABLE_LIVE_KEY } from '#lib/cable/service.ts';
import { createTour } from '#lib/comprehension/tour.svelte.ts';
import Comunidade from '#lib/components/pages/comunidade/Comunidade.svelte';
import { decodeCurve, type SessionView } from '#lib/components/pages/comunidade/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import type { TradeDto } from '#lib/social/index.ts';
import { fakeAppOptions } from '../../app/fakes.ts';
import { fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';
import {
	ANONYMOUS,
	S1_BOOST,
	VERIFIED,
	apiWith,
	fakeFetch,
	feedItem,
	feedPage,
	json,
	type Route
} from './fixtures.ts';

const FLAT = { bands: snapshotBands(NEUTRO.bands), preampDb: NEUTRO.preampDb };
const BOOST = decodeCurve(S1_BOOST);
const ITEMS = [
	feedItem({ id: 'lin-alvo00000001', name: 'Alvo', s1: S1_BOOST }),
	feedItem({ id: 'lin-outra0000002', name: 'Outra' })
];

const apps: ClientApp[] = [];
const engines: AudioEngine[] = [];

beforeEach(async () => {
	resetAudioConfig();
	localStorage.removeItem(CABLE_LIVE_KEY);
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	apps.splice(0).forEach((app) => app.dispose());
	await Promise.all(engines.splice(0).map((audio) => audio.dispose()));
	vi.restoreAllMocks();
	localStorage.removeItem(CABLE_LIVE_KEY);
});

async function setup(options: { session?: SessionView; route?: Route } = {}) {
	const fake = fakeAppOptions();
	const audio = createAudioEngine(fakeEnv(null).env);
	engines.push(audio);
	const app = createClientApp({ ...fake.options, audio });
	apps.push(app);
	await app.start();
	expect(await app.cable.connect()).not.toBeNull();
	vi.spyOn(app.cable, 'createGesture').mockImplementation(() =>
		createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ now: () => fake.time.value, userActivation: null }
		)
	);
	// No real meter worklet: the channels still try to tap the audible chain.
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const fetch = fakeFetch((url, init) => {
		if (url.pathname === '/api/v1/feed') return json(feedPage(ITEMS));
		return options.route?.(url, init);
	});
	const create = vi.spyOn(audio, 'createAB');
	await render(Comunidade, {
		app,
		api: apiWith(fetch),
		session: options.session ?? ANONYMOUS,
		storage: null,
		remember: vi.fn(async () => undefined),
		tourController: createTour({ storage: () => undefined, isDesktop: () => false }),
		isOnline: () => true,
		tap: vi.fn().mockRejectedValue(new Error('no meter'))
	});
	await expect.element(page.getByRole('link', { name: 'Alvo' })).toBeVisible();
	return { app, audio, create, fake };
}

const select = (name: string) =>
	page.getByRole('button', { name: m.comunidade_channel_select({ name }) });
const cablePanel = () => page.getByRole('region', { name: m.cable_x2_title() });

/** "Comparar no cabo" → volume lever → "Começar", then waits for the cable to play. */
async function startCable(app: ClientApp) {
	const panel = cablePanel();
	await panel.getByRole('button', { name: m.cable_x2_start(), exact: true }).click();
	const group = panel.getByRole('group', { name: m.cable_x2_checklist_title() });
	await group.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await group.getByRole('button', { name: m.cable_live_start() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.status).toBe('ready'));
}

/** A comparison started on the service directly (another page's, or this one's earlier). */
async function startServiceComparison(app: ClientApp) {
	if (!BOOST) throw new Error('fixture curve does not decode');
	const outcome = await app.cable.startComparison({
		curves: [
			{ bands: BOOST.bands, preampDb: BOOST.preampDb, experimental: false },
			{ bands: FLAT.bands, preampDb: FLAT.preampDb, experimental: false }
		],
		match: true,
		blind: false,
		confirmations: { volumeLowered: true },
		gesture: app.cable.createGesture({ isTrusted: true, type: 'click' })
	});
	expect(outcome.status).toBe('accepted');
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.status).toBe('ready'));
}

test('the scope pair starts on the cable; changing the selection ends it as stale', async () => {
	const { app } = await setup();
	await select('Alvo').click();
	await startCable(app);
	expect(app.cableState.live?.comparison?.active).toBe(true);
	expect(app.cableState.live?.comparison?.blind).toBe(false);
	// A new target: the set changed, so the comparison ends (without reverting) and says why.
	await select('Outra').click();
	await expect
		.poll(() => document.querySelector('[data-cable-ab-ended]')?.textContent?.trim())
		.toBe(m.cable_x2_lanes_changed());
	expect(app.cableState.live?.comparison?.active).not.toBe(true);
});

test('the scope A/B keys mirror to the cable; the cable starts on the side the scope plays', async () => {
	const { app, audio, create } = await setup();
	await select('Alvo').click();
	const ab = page.getByRole('group', { name: m.comunidade_ab_title() });
	await ab.getByRole('button', { name: m.comunidade_listen(), exact: true }).click();
	await expect.poll(() => audio.state().playing).toBe(true);
	await ab.getByRole('button', { name: m.comunidade_ab_b(), exact: true }).click();
	const read = document.querySelector('[data-testid="scope-ab-read"]');
	// Level-matched in the browser: the trims show.
	expect(read?.textContent?.trim()).not.toBe('');
	expect(read?.textContent?.trim()).not.toBe(m.comunidade_ab_note());
	const stop = vi.spyOn(audio, 'stop');
	await startCable(app);
	expect(app.cableState.live?.comparison?.index).toBe(1);
	// The cable applies the EQ now: the scope pair plays flat, rebuilt in place on B.
	await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
	expect(create.mock.calls[1]?.[0]).toMatchObject(FLAT);
	expect(create.mock.calls[1]?.[1]).toMatchObject(FLAT);
	expect(create.mock.calls[1]?.[2]).toEqual({ experimental: true, initial: 'B' });
	expect(stop).not.toHaveBeenCalled();
	expect(audio.state().playing).toBe(true);
	// No level-match trims while flat.
	await expect.poll(() => read?.textContent?.trim()).toBe('');
	const switchComparison = vi.spyOn(app.cable, 'switchComparison');
	await ab.getByRole('button', { name: m.comunidade_ab_a(), exact: true }).click();
	await vi.waitFor(() => expect(switchComparison).toHaveBeenCalledExactlyOnceWith(0));
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.index).toBe(0));
	await expect
		.element(ab.getByRole('button', { name: m.comunidade_ab_a(), exact: true }))
		.toHaveAttribute('aria-pressed', 'true');
	await app.cable.whenLiveIdle();
	await ab.getByRole('button', { name: m.comunidade_ab_b(), exact: true }).click();
	await vi.waitFor(() => expect(switchComparison).toHaveBeenLastCalledWith(1));
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.index).toBe(1));
});

test('channel listening goes flat in place when the cable plays an unsaved curve', async () => {
	const { app, audio, create } = await setup();
	await page.getByRole('button', { name: m.comunidade_channel_listen({ name: 'Alvo' }) }).click();
	await expect.poll(() => audio.state().playing).toBe(true);
	expect(create).toHaveBeenCalledOnce();
	expect(create.mock.calls[0]?.[1]).toMatchObject({ preampDb: BOOST?.preampDb });
	const stop = vi.spyOn(audio, 'stop');
	await startServiceComparison(app);
	await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
	expect(create.mock.calls[1]?.[0]).toMatchObject(FLAT);
	expect(create.mock.calls[1]?.[1]).toMatchObject(FLAT);
	expect(create.mock.calls[1]?.[2]).toEqual({ experimental: true, initial: 'B' });
	expect(stop).not.toHaveBeenCalled();
	expect(audio.state().playing).toBe(true);
	// The same session plays on, now flat: the cable's curve is heard, not the channel's, so the
	// strip no longer claims the channel plays (no "playing" mark, no LED chain).
	await expect
		.element(page.getByRole('button', { name: m.comunidade_channel_listen({ name: 'Alvo' }) }))
		.toBeVisible();
	expect(
		document.querySelector(`[aria-label="${m.comunidade_channel_stop({ name: 'Alvo' })}"]`)
	).toBeNull();
	expect(audio.state().playing).toBe(true);
});

test('S6 rounds never go flat while the cable plays an unsaved curve', async () => {
	const { app, create } = await setup();
	await select('Alvo').click();
	await select('Outra').click();
	await startServiceComparison(app);
	await page.getByRole('button', { name: m.comunidade_s6_round_start(), exact: true }).click();
	await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
	const [x, y] = create.mock.calls[0] ?? [];
	const preamps = [x?.preampDb, y?.preampDb];
	expect(preamps).toContain(BOOST?.preampDb);
	expect([x?.bands, y?.bands]).toContainEqual(BOOST?.bands);
	// Not rebuilt flat either.
	expect(create).toHaveBeenCalledOnce();
});

test('S7 blind listening never goes flat while the cable plays an unsaved curve', async () => {
	const partner: TradeDto['partner'] = { revealed: false, curveId: 'c-partner', s1: S1_BOOST };
	const trade: TradeDto = {
		id: 'matched',
		status: 'matched',
		lineageId: 'lin-one',
		versionId: 'ver-lin-one',
		score: null,
		createdAt: 1_700_000_000_000,
		matchedAt: null,
		scoredAt: null,
		expiresAt: 1_700_000_000_000 + 72 * 3_600_000,
		partner
	};
	const { app, create } = await setup({
		session: VERIFIED,
		route: (url) => {
			if (url.pathname === '/api/v1/trades/me') return json({ items: [trade], nextCursor: null });
			if (url.pathname === '/api/v1/me/library') return json({ items: [], nextCursor: null });
			return undefined;
		}
	});
	await startServiceComparison(app);
	await page.getByRole('button', { name: m.comunidade_s7_listen_blind(), exact: true }).click();
	await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
	expect(create.mock.calls[0]?.[1]).toMatchObject({
		preampDb: BOOST?.preampDb,
		bands: BOOST?.bands
	});
	expect(create).toHaveBeenCalledOnce();
});

test('a connected cable: the blind notice in the blind section, the sum notice above the desk', async () => {
	const { app } = await setup();
	const text = (id: string) =>
		document.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
	await expect.poll(() => text('cable-blind-notice')).toBe(m.cable_sum_blind());
	await expect.poll(() => text('cable-sum-notice')).toContain(m.cable_sum_note());
	// Kept on the cable after the comparison (not its saved curve): the browser plays flat.
	await startServiceComparison(app);
	await app.cable.endComparison({ revert: false });
	await expect.poll(() => text('cable-sum-notice')).toBe(m.cable_sum_flat());
	// The blind rounds stay browser-only: their notice does not change.
	expect(text('cable-blind-notice')).toBe(m.cable_sum_blind());
});
