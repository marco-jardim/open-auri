/**
 * "Comparar no cabo" on the Comparar page (issue #73, X2 on the cable): the page's A and B lanes
 * as a level-matched comparison set on the live cable preview. A real client app with a FakeHID
 * cable (auto-advancing fake clock) and a fake Web Audio graph: what reaches the cable is read
 * from the fake firmware, what the browser plays from the chains it builds.
 */
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { snapshotBands } from 'open-auri/dsp';
import { THRESHOLDS, gateForWrite } from 'open-auri/safety';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import type { MeterUpdate } from '#lib/audio/meters.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { CABLE_LIVE_KEY } from '#lib/cable/service.ts';
import { planComparison } from '#lib/cable/compare.ts';
import type { Band, ComparisonCurve } from '#lib/cable/types.ts';
import { formatNumber } from '#lib/components/cable/i18n.ts';
import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';
import { copy } from '#lib/components/pages/comparar/copy.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { fakeAppOptions } from '../../app/fakes.ts';
import { fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';

const { fakeTap } = vi.hoisted(() => ({ fakeTap: vi.fn() }));
vi.mock('#lib/audio/meters.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/audio/meters.ts')>()),
	tap: fakeTap
}));
vi.mock('#lib/workers/gate-client.ts', () => ({
	createGateWorker: () => ({
		commit: async () => ({ verdict: { ok: true, reasons: [] } }),
		dispose: () => undefined,
		cancel: () => undefined
	})
}));

const OFF_BANDS: Band[] = Array.from({ length: 10 }, (): Band => ({ kind: 'OFF' }));
const t = copy('pt-BR');
let apps: ClientApp[] = [];
let engines: AudioEngine[] = [];

function meter() {
	return {
		disconnect: vi.fn(),
		setReference: vi.fn(),
		subscribe: vi.fn((listener: (update: MeterUpdate) => void) => {
			listener({ mode: 'data', frame: null });
			return () => undefined;
		})
	};
}

beforeEach(() => {
	resetAudioConfig();
	fakeTap.mockReset();
	fakeTap.mockImplementation(async () => meter());
	localStorage.removeItem(CABLE_LIVE_KEY);
});

afterEach(async () => {
	await cleanup();
	for (const app of apps) app.dispose();
	for (const engine of engines) await engine.dispose();
	apps = [];
	engines = [];
	vi.restoreAllMocks();
	localStorage.removeItem(CABLE_LIVE_KEY);
	await setLocale('pt-BR', { reload: false });
});

interface SetupOptions {
	/** The cable's saved curve (journal): all filters off at this preamp. */
	savedPreampDb?: number;
	livePolicy?: { enabled: boolean };
}

async function setup(options: SetupOptions = {}) {
	const fake = fakeAppOptions();
	const engine = createAudioEngine(fakeEnv(null).env);
	engines.push(engine);
	const app = createClientApp({
		...fake.options,
		audio: engine,
		cable: {
			...fake.options.cable,
			...(options.livePolicy === undefined ? {} : { livePolicy: options.livePolicy })
		}
	});
	apps.push(app);
	await app.start();
	expect(await app.cable.connect()).not.toBeNull();
	if (options.savedPreampDb !== undefined) {
		const device = app.cable.getState().deviceLabel;
		expect(device).not.toBeNull();
		const crc = gateForWrite(OFF_BANDS, options.savedPreampDb, { experimental: false }).metrics
			.payloadCrc;
		expect(
			app.state.journal.append({
				schema: 1,
				at: fake.time.value,
				name: 'Salva',
				crc: Number(crc),
				preampDb: options.savedPreampDb,
				bands: OFF_BANDS,
				status: 'ok',
				device
			})
		).toBe(true);
	}
	// Component clicks are synthetic here: mint real single-use tokens for each gesture.
	const gestures = vi
		.spyOn(app.cable, 'createGesture')
		.mockImplementation(() =>
			createGestureToken(
				{ isTrusted: true, type: 'click' },
				{ now: () => fake.time.value, userActivation: null }
			)
		);
	const build = vi.spyOn(engine, 'buildChain');
	await render(CompararPage, { app, locale: 'pt-BR' });
	await tick();
	return { app, fake, engine, gestures, build };
}

/** CRC-16 the fake firmware plays from RAM (bytes 218..219 of the live payload). */
function playingCrc(fake: ReturnType<typeof fakeAppOptions>): number | null {
	const payload = fake.device.firmware.live;
	if (payload === null) return null;
	return (payload[218] ?? 0) | ((payload[219] ?? 0) << 8);
}

function text(selector: string): string {
	return document.querySelector(selector)?.textContent?.trim() ?? '';
}

/** The default A (lane 1) and B (lane 2) curves. */
function defaultCurves(): ComparisonCurve[] {
	return initialTracks()
		.slice(0, 2)
		.map((track) => ({ bands: track.curve.bands, preampDb: track.curve.preampDb }));
}

async function laneSource(lane: number, value: string) {
	const input = document.getElementById(`comparar-source-${lane}`);
	if (!(input instanceof HTMLSelectElement)) throw new Error('Missing track source');
	if (![...input.options].some((option) => option.value === value)) {
		throw new Error(`Unknown track source ${value}`);
	}
	input.value = value;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await tick();
}

/** Loads `curve` into `lane` through the editor ("Curva atual"). */
async function laneCurve(app: ClientApp, lane: number, name: string, curve: ComparisonCurve) {
	expect(
		app.state.curve.set({
			name,
			source: 'custom',
			preampDb: curve.preampDb,
			bands: curve.bands.map((band) => ({ ...band }))
		})
	).toBe(true);
	await laneSource(lane, 'current');
	await expect
		.poll(() => (document.getElementById(`comparar-source-${lane}`) as HTMLSelectElement).value)
		.toBe('custom');
	await expect
		.poll(() =>
			[...(document.getElementById(`comparar-source-${lane}`) as HTMLSelectElement).options].some(
				(option) => option.value === 'custom' && option.text === name
			)
		)
		.toBe(true);
}

const startButton = () => page.getByRole('button', { name: m.cable_x2_start(), exact: true });
const checklistGroup = () => page.getByRole('group', { name: m.cable_x2_checklist_title() });
const radio = (side: 'A' | 'B', name: string) =>
	page.getByRole('radio', { name: m.cable_x2_side({ side, name }) });

async function openChecklist() {
	await startButton().click();
	const group = checklistGroup();
	await expect.element(group).toBeVisible();
	return group;
}

async function startComparison(app: ClientApp) {
	const group = await openChecklist();
	await group.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await group.getByRole('button', { name: m.cable_live_start() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.status).toBe('ready'));
}

type BuildCall = Parameters<AudioEngine['buildChain']>;

/** The newest chain the page built for `lane` (its bands and preamp). */
function lastChain(build: { mock: { calls: BuildCall[] } }, lane: number): BuildCall | undefined {
	return build.mock.calls.filter((call) => call[2]?.id?.startsWith(`comparar-${lane}-`)).at(-1);
}

test('hidden without a live-capable transport', async () => {
	await setup({ livePolicy: { enabled: false } });
	expect(startButton().all()).toHaveLength(0);
	expect(document.querySelector('[data-cable-ab]')).toBeNull();
});

test('start plays the level-matched A; B switches to the matched B; levels are shown', async () => {
	const { app, fake, gestures } = await setup();
	const plan = planComparison(defaultCurves(), { match: true });
	expect(plan.refusal).toBeUndefined();
	const [itemA, itemB] = plan.items;
	if (itemA === undefined || itemB === undefined) throw new Error('expected two items');

	const group = await openChecklist();
	const go = group.getByRole('button', { name: m.cable_live_start() });
	// Locked until the volume lever is confirmed; no gesture spent meanwhile.
	await expect.element(go).toHaveAttribute('aria-disabled', 'true');
	await expect.element(group.getByText(m.cable_x2_gate_ok())).toBeVisible();
	await expect.element(group.getByText(m.cable_x2_match_on())).toBeVisible();
	await group.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await go.click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.status).toBe('ready'));
	expect(gestures).toHaveBeenCalledTimes(1);
	expect(playingCrc(fake)).toBe(itemA.crc);
	expect(fake.device.firmware.commitCount).toBe(0);

	await expect.element(radio('A', 'Neutro')).toHaveAttribute('aria-checked', 'true');
	await expect.element(radio('B', 'Auri')).toHaveAttribute('aria-checked', 'false');
	// Focus moves to the lever.
	await expect.element(radio('A', 'Neutro')).toHaveFocus();
	await expect.element(page.getByRole('radiogroup', { name: m.cable_x2_lever() })).toBeVisible();
	expect(text('[data-cable-ab-levels]')).toBe(
		m.cable_x2_levels({ a: formatNumber(itemA.levelDb, 1), b: formatNumber(itemB.levelDb, 1) })
	);
	expect(text('[data-cable-ab-preamps]')).toBe(
		m.cable_x2_preamps({ a: formatNumber(itemA.preampDb, 1), b: formatNumber(itemB.preampDb, 1) })
	);
	expect(text('[data-cable-ab-residual]')).toBe(
		m.cable_x2_residual({
			a: formatNumber(itemA.residualDb, 2, true),
			b: formatNumber(itemB.residualDb, 2, true)
		})
	);
	expect(text('[data-cable-ab-announce]')).toBe(m.cable_x2_now({ side: 'A' }));

	await radio('B', 'Auri').click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.index).toBe(1));
	expect(playingCrc(fake)).toBe(itemB.crc);
	await expect.element(radio('B', 'Auri')).toHaveAttribute('aria-checked', 'true');
	await expect.poll(() => text('[data-cable-ab-announce]')).toBe(m.cable_x2_now({ side: 'B' }));
	await expect.poll(() => text('[data-cable-ab-status]')).toBe(m.cable_x2_now({ side: 'B' }));
	await expect
		.poll(() => document.querySelector('[data-cable-ab-lamp]')?.getAttribute('data-cable-ab-lamp'))
		.toBe('ok');
	expect(text('[data-cable-ab-latency]')).toMatch(/\d+ ms/);
	// Nothing held, nothing written.
	expect(app.cableState.live?.hold).toBeNull();
	expect(fake.device.firmware.commitCount).toBe(0);
	// No extra gesture for the switch.
	expect(gestures).toHaveBeenCalledTimes(1);
});

test('keyboard: A and B choose, Space toggles, arrows move the lever', async () => {
	const { app, fake } = await setup();
	const [itemA, itemB] = planComparison(defaultCurves(), { match: true }).items;
	await startComparison(app);
	(document.activeElement as HTMLElement | null)?.blur();
	/** The switch to `index` ended (the cable plays it, the lever is idle again). */
	const settled = async (index: number, crc: number | undefined) => {
		await vi.waitFor(() => {
			expect(playingCrc(fake)).toBe(crc);
			expect(app.cableState.live?.comparison).toMatchObject({ index, status: 'ready' });
			expect(
				document.querySelector('[data-cable-ab-lamp]')?.getAttribute('data-cable-ab-lamp')
			).toBe('ok');
		});
	};

	await userEvent.keyboard('b');
	await settled(1, itemB?.crc);
	await expect.element(radio('B', 'Auri')).toHaveAttribute('aria-checked', 'true');

	await userEvent.keyboard('a');
	await settled(0, itemA?.crc);

	document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
	await settled(1, itemB?.crc);
	document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
	await settled(0, itemA?.crc);

	// Inside a form field the keys belong to the field.
	const select = document.getElementById('comparar-source-3');
	select?.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
	await tick();
	await app.cable.whenLiveIdle();
	expect(playingCrc(fake)).toBe(itemA?.crc);

	// The radiogroup: arrows move focus and switch.
	(radio('A', 'Neutro').element() as HTMLElement).focus();
	await userEvent.keyboard('{ArrowRight}');
	await vi.waitFor(() => expect(playingCrc(fake)).toBe(itemB?.crc));
	await expect.element(radio('B', 'Auri')).toHaveFocus();
});

test('a level the match cannot reach is refused before starting, naming the louder side', async () => {
	const { app } = await setup();
	const loud: ComparisonCurve = {
		bands: [{ kind: 'PK', freqHz: 1000, gainDb: 3, qFactor: 1 }, ...OFF_BANDS.slice(1)],
		preampDb: -6
	};
	const quiet: ComparisonCurve = { bands: OFF_BANDS, preampDb: THRESHOLDS.preampMinDb };
	await laneCurve(app, 1, 'Alta', loud);
	await laneCurve(app, 2, 'Baixa', quiet);
	const plan = planComparison([loud, quiet], { match: true });
	expect(plan.refusal?.reason).toBe('level-range');

	const group = await openChecklist();
	const expected = m.cable_x2_refused_level_range({
		side: 'A',
		floor: formatNumber(THRESHOLDS.preampMinDb, 1),
		preamp: formatNumber(plan.refusal?.preampDb ?? 0, 1)
	});
	expect(expected).toContain('−25,5 dB');
	await expect.poll(() => text('[data-cable-ab-refusal] .gate-line')).toBe(expected);
	expect(document.querySelector('[data-cable-ab-refusal]')?.getAttribute('data-cable-ab-refusal')).toBe(
		'level-range'
	);
	await group.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await expect
		.element(group.getByRole('button', { name: m.cable_live_start() }))
		.toHaveAttribute('aria-disabled', 'true');
	expect(app.cableState.live).toBeNull();

	// Without level matching the same pair starts.
	await page.getByRole('checkbox', { name: t.match }).click();
	await expect.element(group.getByText(m.cable_x2_match_off())).toBeVisible();
	expect(document.querySelector('[data-cable-ab-refusal]')).toBeNull();
	await group.getByRole('button', { name: m.cable_live_start() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.status).toBe('ready'));
	expect(app.cableState.live?.comparison?.items?.every((item) => !item.matched)).toBe(true);
});

test('"Salvar esta" opens the write checklist with the original curve of the side that plays', async () => {
	const { app } = await setup();
	const plan = planComparison(defaultCurves(), { match: true });
	const matchedIndex = plan.items.findIndex((item) => item.matched);
	expect(matchedIndex).toBeGreaterThanOrEqual(0);
	const item = plan.items[matchedIndex];
	if (item === undefined) throw new Error('expected a matched item');
	const lane = initialTracks()[matchedIndex];
	if (lane === undefined) throw new Error('expected a lane');
	await startComparison(app);
	if (matchedIndex === 1) {
		await radio('B', 'Auri').click();
		await vi.waitFor(() => expect(app.cableState.live?.comparison?.index).toBe(1));
	}
	await page.getByRole('button', { name: m.cable_x2_save() }).click();
	await vi.waitFor(() => expect(app.pendingWrite).not.toBeNull());
	const pending = app.pendingWrite;
	// The original curve (not the level-matched one), named after its lane.
	expect(pending?.preampDb).toBe(item.original.preampDb);
	expect(pending?.preampDb).not.toBe(item.preampDb);
	expect(pending?.bands).toEqual(item.original.bands);
	expect(pending?.name).toBe(lane.curve.name);
	expect(pending?.source).toBe(lane.curve.source);
	// The save goes to the session's cable.
	expect(app.cableState.device).not.toBeNull();
	expect(app.cableState.deviceLabel).toBe(app.cableState.live?.deviceLabel);
});

test('"Encerrar" reverts to the saved curve; the browser chains play flat only meanwhile', async () => {
	const { app, fake, build } = await setup({ savedPreampDb: -12 });
	const savedCrc = Number(
		gateForWrite(OFF_BANDS, -12, { experimental: false }).metrics.payloadCrc
	);
	const auri = initialTracks()[1]?.curve;
	if (auri === undefined) throw new Error('expected lane 2');
	// The page's own audition: lane 2 (Auri) is built with its EQ.
	await page.getByRole('button', { name: t.play, exact: true }).click();
	await expect.poll(() => lastChain(build, 2)?.[0]).toEqual(auri.bands);

	await startComparison(app);
	// The cable applies the EQ now: every lane plays the flat Neutro curve.
	const flat = snapshotBands(NEUTRO.bands);
	await expect.poll(() => lastChain(build, 2)?.[0]).toEqual(flat);
	expect(lastChain(build, 2)?.[1]).toBe(NEUTRO.preampDb);
	await expect.element(page.getByText(m.cable_x2_browser_flat())).toBeVisible();

	await page.getByRole('button', { name: m.cable_x2_end(), exact: true }).click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('reverted'));
	expect(playingCrc(fake)).toBe(savedCrc);
	await expect.poll(() => text('[data-cable-ab-ended]')).toBe(m.cable_live_ended_reverted());
	// Back on the saved curve: the lanes' EQ again.
	await expect.poll(() => lastChain(build, 2)?.[0]).toEqual(auri.bands);
	// Focus goes back to the start control.
	await expect.element(startButton()).toHaveFocus();
});

test('a held revert offers the volume confirmation, then ends on the saved curve', async () => {
	// The saved curve is 10 dB above the set's confirmed level (−13 dB).
	const { app, fake } = await setup({ savedPreampDb: -3 });
	const savedCrc = Number(gateForWrite(OFF_BANDS, -3, { experimental: false }).metrics.payloadCrc);
	await laneCurve(app, 1, 'Baixa', { bands: OFF_BANDS, preampDb: -12 });
	await laneCurve(app, 2, 'Mais baixa', { bands: OFF_BANDS, preampDb: -13 });
	await startComparison(app);

	await page.getByRole('button', { name: m.cable_x2_end(), exact: true }).click();
	await vi.waitFor(() =>
		expect(app.cableState.live?.hold).toMatchObject({ reason: 'loudness', curve: 'saved' })
	);
	expect(app.cableState.live?.status).not.toBe('ended');
	await expect.poll(() => text('[data-cable-ab-message]')).toBe(m.cable_live_revert_failed_held());
	expect(document.querySelector('[data-cable-ab-hold]')?.getAttribute('data-cable-ab-hold')).toBe(
		'loudness'
	);
	const confirmEnd = vi.spyOn(app.cable, 'confirmEndComparison');
	const confirmLive = vi.spyOn(app.cable, 'confirmLive');
	await page.getByRole('button', { name: m.cable_live_hold_loudness_confirm() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.status).toBe('ended'));
	expect(playingCrc(fake)).toBe(savedCrc);
	// The session itself ends as reverted (not stopped): the cable is back on its saved curve.
	expect(app.cableState.live).toMatchObject({
		endedReason: 'reverted',
		playsUnsaved: false,
		comparison: { active: false }
	});
	expect(confirmEnd).toHaveBeenCalledTimes(1);
	expect(confirmLive).not.toHaveBeenCalled();
	await expect.poll(() => text('[data-cable-ab-ended]')).toBe(m.cable_live_ended_reverted());
});

test('"Encerrar sem voltar" ends with the cable keeping the curve', async () => {
	const { app, fake } = await setup();
	const [itemA] = planComparison(defaultCurves(), { match: true }).items;
	await startComparison(app);
	await page.getByRole('button', { name: m.cable_x2_end_keep() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	expect(playingCrc(fake)).toBe(itemA?.crc);
	await expect.poll(() => text('[data-cable-ab-ended]')).toBe(m.cable_x2_ended_stopped());
});

test('leaving the page ends the comparison without reverting', async () => {
	const { app, fake } = await setup();
	const [itemA] = planComparison(defaultCurves(), { match: true }).items;
	await startComparison(app);
	await cleanup();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	expect(playingCrc(fake)).toBe(itemA?.crc);
});

test('a lane change ends the comparison: a stale set is never switched', async () => {
	const { app } = await setup();
	await startComparison(app);
	await laneSource(2, 'preset:pref6');
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	await expect.poll(() => text('[data-cable-ab-ended]')).toBe(m.cable_x2_lanes_changed());
	expect(page.getByRole('radiogroup', { name: m.cable_x2_lever() }).all()).toHaveLength(0);
	// A new start compares the new set.
	await startComparison(app);
	await expect.element(radio('B', 'Natural')).toBeVisible();
});

test('turning level matching off during the comparison ends it too', async () => {
	const { app } = await setup();
	await startComparison(app);
	await page.getByRole('checkbox', { name: t.match }).click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	await expect.poll(() => text('[data-cable-ab-ended]')).toBe(m.cable_x2_lanes_changed());
});

test('locked while the Curva preview runs, with the reason', async () => {
	const { app, fake } = await setup();
	const outcome = await app.cable.startLive({
		curve: { bands: OFF_BANDS, preampDb: -12 },
		confirmations: { volumeLowered: true },
		gesture: createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ now: () => fake.time.value, userActivation: null }
		)
	});
	expect(outcome.status).toBe('accepted');
	await expect.element(startButton()).toHaveAttribute('aria-disabled', 'true');
	const described = startButton().element().getAttribute('aria-describedby') ?? '';
	expect(document.getElementById(described)?.textContent).toContain(m.cable_x2_reason_live());
	// A locked button only says why (the browser driver will not click an aria-disabled one).
	const locked = startButton().element();
	if (locked instanceof HTMLElement) locked.click();
	await tick();
	expect(document.querySelector('[data-cable-ab-checklist]')).toBeNull();
});

test('a Curva preview that is not the saved curve flattens the lanes too (no comparison)', async () => {
	const { app, fake, build } = await setup();
	const auri = initialTracks()[1]?.curve;
	if (auri === undefined) throw new Error('expected lane 2');
	await page.getByRole('button', { name: t.play, exact: true }).click();
	await expect.poll(() => lastChain(build, 2)?.[0]).toEqual(auri.bands);
	const outcome = await app.cable.startLive({
		curve: {
			bands: [{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }, ...OFF_BANDS.slice(1)],
			preampDb: -6
		},
		confirmations: { volumeLowered: true },
		gesture: createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ now: () => fake.time.value, userActivation: null }
		)
	});
	expect(outcome.status).toBe('accepted');
	await vi.waitFor(() => expect(app.cableState.live?.cableEq).toBe(true));
	expect(app.cableState.live?.comparison).toBeUndefined();
	// The cable applies an EQ already: every lane plays the flat Neutro curve.
	const flat = snapshotBands(NEUTRO.bands);
	await expect.poll(() => lastChain(build, 2)?.[0]).toEqual(flat);
	expect(lastChain(build, 2)?.[1]).toBe(NEUTRO.preampDb);
});

test('"Salvo no cabo" loads the cable\'s saved curve into a lane', async () => {
	await setup({ savedPreampDb: -9 });
	await laneSource(3, 'cable-saved');
	await expect
		.poll(() =>
			[...(document.getElementById('comparar-source-3') as HTMLSelectElement).options].some(
				(option) => option.value === 'custom' && option.text === m.cable_x2_source_saved()
			)
		)
		.toBe(true);
});

/** Same pair as the held-revert test: the saved curve (−3 dB) is far above the set's level. */
const QUIET_PAIR: ComparisonCurve[] = [
	{ bands: OFF_BANDS, preampDb: -12 },
	{ bands: OFF_BANDS, preampDb: -13 }
];

async function quietPair(app: ClientApp) {
	const [first, second] = QUIET_PAIR;
	if (first === undefined || second === undefined) throw new Error('expected two curves');
	await laneCurve(app, 1, 'Baixa', first);
	await laneCurve(app, 2, 'Mais baixa', second);
}

test('a session ended elsewhere (cable forgotten) never ends the next comparison', async () => {
	const { app } = await setup();
	await startComparison(app);
	expect(await app.cable.disconnect()).toBe(true);
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('forgotten'));
	expect(await app.cable.connect()).not.toBeNull();
	await vi.waitFor(() => expect(app.cableState.connection).toBe('connected'));
	// A new set: the first one's signature must not count against it.
	await laneSource(2, 'preset:pref6');
	await startComparison(app);
	await expect.element(radio('B', 'Natural')).toBeVisible();
	await tick();
	await app.cable.whenLiveIdle();
	expect(app.cableState.live).toMatchObject({ status: 'live', comparison: { active: true } });
	expect(text('[data-cable-ab-ended]')).toBe('');
	// And it still switches.
	await radio('B', 'Natural').click();
	await vi.waitFor(() =>
		expect(app.cableState.live?.comparison).toMatchObject({ index: 1, status: 'ready' })
	);
});

test('a held revert offers "Continuar comparando": the hold is dropped, the comparison goes on', async () => {
	const { app, fake } = await setup({ savedPreampDb: -3 });
	const [itemA, itemB] = planComparison(QUIET_PAIR, { match: true }).items;
	await quietPair(app);
	await startComparison(app);
	await page.getByRole('button', { name: m.cable_x2_end(), exact: true }).click();
	await vi.waitFor(() =>
		expect(app.cableState.live?.hold).toMatchObject({ reason: 'loudness', curve: 'saved' })
	);
	const keepComparing = page.getByRole('button', { name: m.cable_x2_continue() });
	await expect.element(keepComparing).toBeVisible();
	// Never the editor's wording for a comparison hold.
	expect(text('[data-cable-ab-hold-text]')).not.toBe('');
	expect(text('[data-cable-ab-hold-text]')).not.toContain('editor');

	// Every other status says what happened; the hold stays.
	const cancel = vi.spyOn(app.cable, 'cancelHold');
	const statuses = [
		['no-hold', m.cable_x2_continue_no_hold()],
		['unknown', m.cable_x2_switch_unknown()],
		['busy', m.cable_x2_continue_busy()],
		['ended', m.cable_live_refused_no_session()],
		['error', m.cable_live_refused_error()]
	] as const;
	for (const [status, expected] of statuses) {
		cancel.mockReturnValueOnce({ status });
		await keepComparing.click();
		await expect.poll(() => text('[data-cable-ab-message]')).toBe(expected);
		expect(app.cableState.live?.hold).not.toBeNull();
	}

	// The real one: no I/O, the candidate keeps playing.
	const attempts = fake.device.attempts;
	await keepComparing.click();
	await vi.waitFor(() => expect(app.cableState.live?.hold).toBeNull());
	expect(cancel).toHaveBeenCalledTimes(statuses.length + 1);
	expect(fake.device.attempts).toBe(attempts);
	await expect.poll(() => text('[data-cable-ab-message]')).toBe(m.cable_x2_continue_cleared());
	expect(app.cableState.live?.comparison).toMatchObject({ active: true, status: 'ready', index: 0 });
	expect(playingCrc(fake)).toBe(itemA?.crc);
	expect(document.querySelector('[data-cable-ab-hold]')).toBeNull();
	await expect.element(radio('A', 'Baixa')).toHaveFocus();
	// Switches go on.
	await radio('B', 'Mais baixa').click();
	await vi.waitFor(() => expect(playingCrc(fake)).toBe(itemB?.crc));
	expect(app.cableState.live?.hold).toBeNull();
});

test('an unknown state offers "Reaplicar": the current candidate plays again', async () => {
	const { app, fake, gestures } = await setup();
	const [, itemB] = planComparison(defaultCurves(), { match: true }).items;
	await startComparison(app);
	// Report 8 of the switch fails: what the cable plays is not known.
	fake.device.faults.throwAtReport = fake.device.attempts + 8;
	await radio('B', 'Auri').click();
	await vi.waitFor(() => expect(app.cableState.live?.status).toBe('unknown'));
	await expect.poll(() => text('[data-cable-ab-message]')).toBe(m.cable_x2_switch_unknown());
	expect(text('[data-cable-ab-hold-text]')).toBe(m.cable_x2_hold_unknown());
	expect(page.getByRole('button', { name: m.cable_x2_continue() }).all()).toHaveLength(0);

	const before = gestures.mock.calls.length;
	await page.getByRole('button', { name: m.cable_live_reapply() }).click();
	await vi.waitFor(() =>
		expect(app.cableState.live?.comparison).toMatchObject({ status: 'ready', index: 1 })
	);
	expect(app.cableState.live?.hold).toBeNull();
	expect(playingCrc(fake)).toBe(itemB?.crc);
	expect(gestures.mock.calls.length).toBe(before + 1);
	await expect.poll(() => text('[data-cable-ab-message]')).toBe('');
	expect(document.querySelector('[data-cable-ab-hold]')).toBeNull();
	await expect.element(radio('B', 'Auri')).toHaveFocus();
});

test('"Salvar esta" of the level-lowered side: once written, the comparison ends saying so', async () => {
	const { app, fake } = await setup();
	const plan = planComparison(defaultCurves(), { match: true });
	const loweredIndex = plan.items.findIndex((item) => item.matched);
	const item = plan.items[loweredIndex];
	const lane = initialTracks()[loweredIndex];
	if (item === undefined || lane === undefined) throw new Error('expected a lowered side');
	// The lowered candidate is not the original curve the save writes.
	expect(item.crc).not.toBe(item.original.crc);
	await startComparison(app);
	if (loweredIndex === 1) {
		await radio('B', 'Auri').click();
		await vi.waitFor(() =>
			expect(app.cableState.live?.comparison).toMatchObject({ index: 1, status: 'ready' })
		);
	}
	await page.getByRole('button', { name: m.cable_x2_save() }).click();
	await vi.waitFor(() => expect(app.pendingWrite).not.toBeNull());
	const pending = app.pendingWrite;
	if (pending === null) throw new Error('expected the write checklist');
	// Still comparing while the checklist is open.
	expect(app.cableState.live?.comparison?.active).toBe(true);

	// The write checklist's own path: a confirmed write with a fresh gesture.
	const outcome = await app.cable.write({
		...pending,
		experimental: false,
		confirmations: { volumeLowered: true, keepConnected: true, experimental: false },
		gesture: app.cable.createGesture({ isTrusted: true, type: 'click' })
	});
	app.onWriteResult(outcome);
	expect(outcome.status).toBe('ok');
	expect(fake.device.firmware.commitCount).toBe(1);

	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	expect(playingCrc(fake)).toBe(item.original.crc);
	await expect
		.poll(() => text('[data-cable-ab-ended]'))
		.toBe(m.cable_x2_saved({ name: lane.curve.name }));
	// No failure shown: the lever and its "not confirmed" status are gone.
	expect(document.querySelector('[data-cable-ab-status]')).toBeNull();
	expect(text('[data-cable-ab-message]')).toBe('');
	expect(text('[data-cable-ab-announce]')).toBe(m.cable_x2_saved({ name: lane.curve.name }));
});

test('"Encerrar" is locked without a known saved curve, pointing to "Encerrar sem voltar"', async () => {
	const { app } = await setup();
	await startComparison(app);
	expect(app.cable.liveSavedCurve()).toBeNull();
	const end = page.getByRole('button', { name: m.cable_x2_end(), exact: true });
	await expect.element(end).toHaveAttribute('aria-disabled', 'true');
	const described = end.element().getAttribute('aria-describedby') ?? '';
	expect(document.getElementById(described)?.textContent).toContain(m.cable_x2_end_no_saved());
	const locked = end.element();
	if (locked instanceof HTMLElement) locked.click();
	await tick();
	await app.cable.whenLiveIdle();
	expect(app.cableState.live?.comparison?.active).toBe(true);
	const keep = page.getByRole('button', { name: m.cable_x2_end_keep() });
	await expect.element(keep).not.toHaveAttribute('aria-disabled', 'true');
	await keep.click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
});

test('a lane change during a switch: the end note stands, focus goes back to the start button', async () => {
	const { app } = await setup();
	await startComparison(app);
	const side = radio('B', 'Auri').element();
	if (!(side instanceof HTMLElement)) throw new Error('expected the B radio');
	side.focus();
	side.click();
	await laneSource(2, 'preset:pref6');
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	await app.cable.whenLiveIdle();
	await expect.poll(() => text('[data-cable-ab-ended]')).toBe(m.cable_x2_lanes_changed());
	await tick();
	expect(text('[data-cable-ab-message]')).toBe('');
	await expect.element(startButton()).toHaveFocus();
});

test('A and B are ignored while a menu or listbox popup is open', async () => {
	const { app, fake } = await setup();
	const [itemA, itemB] = planComparison(defaultCurves(), { match: true }).items;
	await startComparison(app);
	(document.activeElement as HTMLElement | null)?.blur();
	for (const role of ['menu', 'listbox']) {
		const popup = document.createElement('div');
		popup.setAttribute('role', role);
		popup.textContent = role;
		document.body.append(popup);
		try {
			document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
			await tick();
			await app.cable.whenLiveIdle();
			expect(playingCrc(fake)).toBe(itemA?.crc);
			expect(app.cableState.live?.comparison?.index).toBe(0);
		} finally {
			popup.remove();
		}
	}
	await userEvent.keyboard('b');
	await vi.waitFor(() => expect(playingCrc(fake)).toBe(itemB?.crc));
});

test('the start button controls the checklist only while it exists; the empty status region stays', async () => {
	const { app } = await setup();
	expect(startButton().element().hasAttribute('aria-controls')).toBe(false);
	await openChecklist();
	const controls = startButton().element().getAttribute('aria-controls') ?? '';
	expect(document.getElementById(controls)?.hasAttribute('data-cable-ab-checklist')).toBe(true);
	const region = document.querySelector('[data-cable-ab-message]');
	if (!(region instanceof HTMLElement)) throw new Error('expected the status region');
	expect(region.getAttribute('role')).toBe('status');
	expect(region.classList.contains('sr-only')).toBe(true);
	expect(getComputedStyle(region).display).not.toBe('none');
	expect(app.cableState.live).toBeNull();
});
