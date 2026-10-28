/**
 * The blind test on the cable (issue #74, slice 5), end to end: a real client app with a FakeHID
 * cable and the page's own engine. Start (checklist, gesture) → change check → rounds; what the
 * fake firmware plays is the candidate mapped to the chosen position, and nothing in the DOM or
 * aria names a candidate, a CRC or a level meanwhile. The reveal shows the mapping, and "Salvar a
 * vencedora no cabo" opens the write checklist with the winner's ORIGINAL curve.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { CABLE_LIVE_KEY } from '#lib/cable/service.ts';
import { planComparison } from '#lib/cable/compare.ts';
import { formatNumber } from '#lib/components/cable/i18n.ts';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import { checkCurves } from '#lib/components/pages/teste-cego/cable-round.ts';
import { officialCandidates } from '#lib/components/pages/teste-cego/experiment.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { fakeAppOptions } from '../../app/fakes.ts';

vi.mock('#lib/workers/gate-client.ts', () => ({
	createGateWorker: () => ({
		commit: async () => ({ verdict: { ok: true, reasons: [] } }),
		dispose: () => undefined,
		cancel: () => undefined
	})
}));

let apps: ClientApp[] = [];
let engines: AudioEngine[] = [];

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

/** CRC-16 the fake firmware plays from RAM (bytes 218..219 of the live payload). */
function playingCrc(fake: ReturnType<typeof fakeAppOptions>): number | null {
	const payload = fake.device.firmware.live;
	if (payload === null) return null;
	return (payload[218] ?? 0) | ((payload[219] ?? 0) << 8);
}

const announcement = () =>
	document.querySelector('.blind-test > [role="status"][aria-live="polite"]')?.textContent ?? '';

const score = (number: number) =>
	page.getByRole('slider', { name: m.cego_rating({ number }), exact: true });

async function rate(number: number, key: '{Home}' | '{End}') {
	const input = score(number).element();
	if (!(input instanceof HTMLInputElement)) throw new Error('Missing score fader');
	input.focus();
	await userEvent.keyboard(key);
}

test('start → check → rounds on the cable, no identity in the DOM, reveal and save the original', async () => {
	// Every random word is 0: the order of every round is [second, first] (Fisher–Yates).
	vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => array);
	const fake = fakeAppOptions();
	const app = createClientApp(fake.options);
	apps.push(app);
	await app.start();
	expect(await app.cable.connect()).not.toBeNull();
	const gestures = vi
		.spyOn(app.cable, 'createGesture')
		.mockImplementation(() =>
			createGestureToken(
				{ isTrusted: true, type: 'click' },
				{ now: () => fake.time.value, userActivation: null }
			)
		);
	const switches = vi.spyOn(app.cable, 'switchComparison');
	const audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	audio.setVolume(-40);
	engines.push(audio);
	const build = vi.spyOn(audio, 'buildChain');

	// Official order: the page's chosen set is in this order (plan index = candidate index).
	const [first, second] = officialCandidates().filter((c) => /^(Auri|Natural)\b/.test(c.name));
	if (first === undefined || second === undefined) throw new Error('expected two presets');
	const plan = planComparison(
		[first, second].map((c) => ({ bands: c.bands, preampDb: c.preampDb })),
		{ match: true }
	);
	expect(plan.refusal).toBeUndefined();
	const [itemFirst, itemSecond] = plan.items;
	if (itemFirst === undefined || itemSecond === undefined) throw new Error('expected two items');
	const checkPlan = planComparison(checkCurves(), { match: true });

	const screen = await render(BlindTest, { audio, client: app, reducedMotion: true });
	await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
	await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
	await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
	const roundsInput = document.querySelector<HTMLInputElement>('input[id$="-rounds"]');
	if (roundsInput === null) throw new Error('Missing rounds');
	roundsInput.value = '2';
	roundsInput.dispatchEvent(new Event('input', { bubbles: true }));

	// The cable tab: checklist, then "Começar no cabo" (locked until the volume lever).
	await page.getByRole('tab', { name: new RegExp(m.cego_cable()) }).click();
	await expect.element(page.getByText(m.cable_blind_gate_ok())).toBeVisible();
	const go = page.getByRole('button', { name: m.cable_blind_start() });
	await expect.element(go).toHaveAttribute('aria-disabled', 'true');
	await page.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	// A candidate with HS/LP/HP asks for the experimental lever too.
	const experimental = page.getByRole('checkbox', { name: m.cable_confirm_experimental() });
	if (experimental.elements().length > 0) await experimental.click();
	await expect.element(go).not.toHaveAttribute('aria-disabled');
	await go.click();

	// The change check: non-blind, labelled; the telefone item plays on the cable.
	await expect.element(page.getByText(m.cable_blind_check_title())).toBeVisible();
	expect(app.cableState.live?.comparison?.blind).toBe(false);
	expect(playingCrc(fake)).toBe(checkPlan.items[0]?.crc);
	const changed = page.getByRole('button', { name: m.cable_blind_check_changed() });
	await expect.element(changed).toHaveAttribute('aria-disabled', 'true');
	await page.getByRole('button', { name: m.cable_blind_check_phone() }).click();
	await vi.waitFor(() => expect(playingCrc(fake)).toBe(checkPlan.items[1]?.crc));
	await expect.element(changed).not.toHaveAttribute('aria-disabled');
	await changed.click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison).toMatchObject({ blind: true }));
	expect(gestures).toHaveBeenCalledTimes(2);
	// One flat browser chain for the whole test (Neutro, trim 0), no per-candidate meter.
	expect(build).toHaveBeenCalledTimes(1);
	expect(build.mock.calls[0]?.[2]).toMatchObject({ gainDb: 0, on: false });
	expect(screen.container.querySelector('.candidate-meter')).toBeNull();

	const levels = [itemFirst, itemSecond].flatMap((item) => [
		`${formatNumber(item.levelDb, 1)} dB`,
		`${formatNumber(item.preampDb, 1)} dB`,
		`${formatNumber(item.original.preampDb, 1)} dB`
	]);
	const forbidden = [first.name, second.name, ...levels];
	const crcs = [itemFirst, itemSecond].flatMap((item) => [item.crc, item.original.crc]);
	/** Nothing in the page names a candidate, its CRC or its level. */
	const noLeak = () => {
		const html = document.body.innerHTML;
		const text = document.body.textContent ?? '';
		expect(html).not.toMatch(/crc/i);
		expect(text).not.toContain(first.name);
		expect(text).not.toContain(second.name);
		// The controls (the stage's live meter readouts aside, which follow the one flat chain).
		const controls = [...document.querySelectorAll('.tablet, .rack')]
			.map((element) => element.textContent ?? '')
			.join('\n');
		for (const value of levels) expect(controls).not.toContain(value);
		for (const crc of crcs) {
			expect(text).not.toMatch(new RegExp(`\\b${crc}\\b`));
			expect(text.toLowerCase()).not.toContain(crc.toString(16).padStart(4, '0'));
		}
		for (const element of document.body.querySelectorAll('*')) {
			for (const attribute of element.attributes) {
				if (!attribute.name.startsWith('aria-') && !attribute.name.startsWith('data-')) continue;
				for (const value of forbidden) expect(attribute.value).not.toContain(value);
				for (const crc of crcs) expect(attribute.value).not.toBe(String(crc));
			}
		}
		// The service state is redacted too.
		expect(app.cableState.live?.applied).toBeNull();
		expect(app.cableState.live?.ackLevelDb).toBeNull();
	};
	noLeak();

	const panel = page.getByRole('tabpanel');
	for (let round = 0; round < 2; round++) {
		// Position 1 is the second candidate, position 2 the first.
		const calls = switches.mock.calls.length;
		const play = panel.getByRole('button', { name: m.cego_play(), exact: true });
		await expect.element(play).not.toHaveAttribute('aria-disabled');
		await play.click();
		await vi.waitFor(() => expect(announcement()).toBe(m.cable_blind_position_ready({ number: 1 })), {
			timeout: 4000
		});
		expect(playingCrc(fake)).toBe(itemSecond.crc);
		noLeak();
		await panel.getByRole('button', { name: new RegExp(`${m.cego_position({ number: 2 })}`) }).click();
		await vi.waitFor(() => expect(announcement()).toBe(m.cable_blind_position_ready({ number: 2 })), {
			timeout: 4000
		});
		expect(playingCrc(fake)).toBe(itemFirst.crc);
		noLeak();
		// The same position again switches again (same window, same announcement).
		await panel.getByRole('button', { name: new RegExp(`${m.cego_position({ number: 2 })}`) }).click();
		await vi.waitFor(() => expect(switches.mock.calls.length).toBe(calls + 3));
		await vi.waitFor(() => expect(announcement()).toBe(m.cable_blind_position_ready({ number: 2 })), {
			timeout: 4000
		});
		await expect.element(score(1)).toBeEnabled();
		await expect.element(score(2)).toBeEnabled();
		await rate(1, '{End}');
		await rate(2, '{Home}');
		const next = panel.getByRole('button', { name: m.cego_next(), exact: true });
		await expect.element(next).not.toHaveAttribute('aria-disabled');
		await next.click();
	}

	// The reveal: the mapping and the scores; the second candidate won.
	await expect
		.element(page.getByText(m.cego_winner({ name: second.name })).first())
		.toBeVisible();
	expect(screen.container.textContent).toContain(first.name);
	// Still blind on the cable until saved or ended: saving waits for the end.
	expect(app.cableState.live?.comparison).toMatchObject({ blind: true, active: true });
	const save = page.getByRole('button', { name: m.cable_blind_save_winner() });
	await expect.element(save).not.toHaveAttribute('aria-disabled');
	await save.click();
	await vi.waitFor(() => expect(app.pendingWrite).not.toBeNull());
	expect(app.cableState.live?.status).toBe('ended');
	const pending = app.pendingWrite;
	expect(pending?.name).toBe(second.name);
	expect(pending?.preampDb).toBe(itemSecond.original.preampDb);
	expect(pending?.bands).toEqual(itemSecond.original.bands);
	// Nothing was written to flash during the test.
	expect(fake.device.firmware.commitCount).toBe(0);
}, 60000);

test('without a live-capable cable the tab says why and nothing starts', async () => {
	await render(BlindTest, { reducedMotion: true });
	await page.getByRole('tab', { name: new RegExp(m.cego_cable()) }).click();
	await expect
		.element(page.getByText(m.cable_blind_unavailable(), { exact: true }).first())
		.toBeVisible();
	await expect
		.element(page.getByRole('button', { name: m.cable_blind_start() }))
		.toHaveAttribute('aria-disabled', 'true');
});
