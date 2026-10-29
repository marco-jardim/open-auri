/**
 * The blind test on the cable (issue #74, slice 5), end to end: a real client app with a FakeHID
 * cable and the page's own engine. Start (checklist, gesture) → change check → rounds; what the
 * fake firmware plays is the candidate mapped to the chosen position, and nothing in the DOM or
 * aria names a candidate, a CRC or a level meanwhile. The reveal shows the mapping, and "Salvar a
 * vencedora no cabo" opens the write checklist with the winner's ORIGINAL curve.
 */
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { THRESHOLDS, gateForWrite } from 'open-auri/safety';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { CABLE_LIVE_KEY } from '#lib/cable/service.ts';
import { planComparison } from '#lib/cable/compare.ts';
import type { Band, CableState, LiveState } from '#lib/cable/types.ts';
import { formatNumber } from '#lib/components/cable/i18n.ts';
import { cableLiveUnsaved, liveBlind } from '#lib/components/cable/live.ts';
import CableBar from '#lib/components/chrome/CableBar.svelte';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import CableBlind from '#lib/components/pages/teste-cego/CableBlind.svelte';
import {
	IDLE_VIEW,
	checkCurves,
	createCableRound,
	type CableRoundPort
} from '#lib/components/pages/teste-cego/cable-round.ts';
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

	const panel = page.getByRole('tabpanel');
	/**
	 * The change check: non-blind, labelled. An item counts as heard only while the audio plays
	 * with it on the cable; then "Ouvi mudar" (paused first, so each round starts with its play).
	 */
	async function changeCheck() {
		await expect.element(page.getByText(m.cable_blind_check_title())).toBeVisible();
		expect(app.cableState.live?.comparison?.blind).toBe(false);
		expect(playingCrc(fake)).toBe(checkPlan.items[0]?.crc);
		const changed = page.getByRole('button', { name: m.cable_blind_check_changed() });
		await expect.element(changed).toHaveAttribute('aria-disabled', 'true');
		// Both items on the cable, but no audio yet: nothing heard.
		await page.getByRole('button', { name: m.cable_blind_check_phone() }).click();
		await vi.waitFor(() => expect(playingCrc(fake)).toBe(checkPlan.items[1]?.crc));
		await page.getByRole('button', { name: m.cable_blind_check_neutral() }).click();
		await vi.waitFor(() => expect(playingCrc(fake)).toBe(checkPlan.items[0]?.crc));
		await expect.element(changed).toHaveAttribute('aria-disabled', 'true');
		// The audio plays: Neutro, then Telefone, are heard.
		await panel.getByRole('button', { name: m.cego_play(), exact: true }).click();
		await expect
			.element(panel.getByRole('button', { name: m.cego_pause(), exact: true }))
			.toBeVisible();
		await page.getByRole('button', { name: m.cable_blind_check_phone() }).click();
		await vi.waitFor(() => expect(playingCrc(fake)).toBe(checkPlan.items[1]?.crc));
		await expect.element(changed).not.toHaveAttribute('aria-disabled');
		await panel.getByRole('button', { name: m.cego_pause(), exact: true }).click();
		await changed.click();
		await vi.waitFor(() => expect(app.cableState.live?.comparison).toMatchObject({ blind: true }));
	}
	await changeCheck();
	expect(gestures).toHaveBeenCalledTimes(2);
	// The top bar, as the layout feeds it: one constant chip while the blind set runs.
	const bar = await render(CableBar, {
		liveBlind: liveBlind(app.cableState.live),
		liveUnsaved: cableLiveUnsaved(app.cableState, null)
	});
	const barSlots: string[] = [];
	const snapBar = async () => {
		await bar.rerender({
			liveBlind: liveBlind(app.cableState.live),
			liveUnsaved: cableLiveUnsaved(app.cableState, null)
		});
		await tick();
		barSlots.push(document.querySelector('.live-slot')?.innerHTML ?? '');
	};
	await snapBar();
	expect(document.querySelector('[data-live-chip="blind"]')).not.toBeNull();
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
	// The top bar has a fixed editor preset button, "Padrão Auri", whatever plays (a candidate here
	// is also named Auri): only that fixed label is set aside; its live slot must stay the same.
	const PRESET = 'Padrão Auri';
	const barSlot = () => bar.container.querySelector('.live-slot')?.innerHTML ?? '';
	const slotHtml = barSlot();
	const noLeak = () => {
		expect(barSlot()).toBe(slotHtml);
		const html = document.body.innerHTML;
		const text = [...document.body.children]
			.map((element) =>
				element === bar.container
					? (element.textContent ?? '').replaceAll(PRESET, '')
					: (element.textContent ?? '')
			)
			.join('\n');
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
		// Every attribute that could carry it: aria, data, class, title (tooltips), alt, placeholder.
		const scanned = (name: string) =>
			name.startsWith('aria-') ||
			name.startsWith('data-') ||
			name === 'class' ||
			name === 'title' ||
			name === 'alt' ||
			name === 'placeholder';
		for (const element of document.body.querySelectorAll('*')) {
			for (const attribute of element.attributes) {
				if (!scanned(attribute.name)) continue;
				for (const value of forbidden) expect(attribute.value).not.toContain(value);
				for (const crc of crcs) {
					expect(attribute.value).not.toMatch(new RegExp(`\\b${crc}\\b`));
					expect(attribute.value.toLowerCase()).not.toContain(crc.toString(16).padStart(4, '0'));
				}
			}
		}
		// The service state is redacted too.
		expect(app.cableState.live?.applied).toBeNull();
		expect(app.cableState.live?.ackLevelDb).toBeNull();
	};
	noLeak();

	for (let round = 0; round < 2; round++) {
		if (round === 1) {
			// "O som parou de mudar": the round is voided (the completed one stays), the cable keeps
			// the set; "Retomar" (levers and a gesture again) runs the check, then the set again.
			await panel.getByRole('button', { name: m.cable_blind_stuck() }).click();
			await expect.element(page.getByText(m.cable_blind_void_stuck())).toBeVisible();
			// The pause marker is constant: no failure kind (which could follow a candidate) in the DOM.
			expect(
				document.querySelector('[data-cable-blind-pause]')?.getAttribute('data-cable-blind-pause')
			).toBe('');
			expect(app.cableState.live?.comparison).toMatchObject({ blind: true, active: true });
			const resume = page.getByRole('button', { name: m.cable_blind_resume() });
			await expect.element(resume).toHaveAttribute('aria-disabled', 'true');
			await page.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
			const lever = page.getByRole('checkbox', { name: m.cable_confirm_experimental() });
			if (lever.elements().length > 0) await lever.click();
			await expect.element(resume).not.toHaveAttribute('aria-disabled');
			await resume.click();
			await changeCheck();
			expect(gestures).toHaveBeenCalledTimes(4);
			// Still round 2 of 2: the completed round counted, the voided one did not.
			expect(screen.container.textContent).toContain('02/02');
			noLeak();
		}
		// Position 1 is the second candidate, position 2 the first.
		const calls = switches.mock.calls.length;
		const play = panel.getByRole('button', { name: m.cego_play(), exact: true });
		await expect.element(play).not.toHaveAttribute('aria-disabled');
		await play.click();
		await vi.waitFor(
			() => expect(announcement()).toBe(m.cable_blind_position_ready({ number: 1 })),
			{
				timeout: 4000
			}
		);
		expect(playingCrc(fake)).toBe(itemSecond.crc);
		await snapBar();
		noLeak();
		await panel
			.getByRole('button', { name: new RegExp(`${m.cego_position({ number: 2 })}`) })
			.click();
		await vi.waitFor(
			() => expect(announcement()).toBe(m.cable_blind_position_ready({ number: 2 })),
			{
				timeout: 4000
			}
		);
		expect(playingCrc(fake)).toBe(itemFirst.crc);
		await snapBar();
		noLeak();
		// The same position again switches again (same window, same announcement).
		await panel
			.getByRole('button', { name: new RegExp(`${m.cego_position({ number: 2 })}`) })
			.click();
		await vi.waitFor(() => expect(switches.mock.calls.length).toBe(calls + 3));
		await vi.waitFor(
			() => expect(announcement()).toBe(m.cable_blind_position_ready({ number: 2 })),
			{
				timeout: 4000
			}
		);
		await expect.element(score(1)).toBeEnabled();
		await expect.element(score(2)).toBeEnabled();
		await rate(1, '{End}');
		await rate(2, '{Home}');
		const next = panel.getByRole('button', { name: m.cego_next(), exact: true });
		await expect.element(next).not.toHaveAttribute('aria-disabled');
		await next.click();
	}

	// The top bar never changed with the candidate on the cable.
	expect(barSlots.length).toBeGreaterThanOrEqual(5);
	expect(new Set(barSlots).size).toBe(1);
	expect(barSlots[0]).toContain(m.cable_blind_chrome());

	// The reveal: the mapping and the scores; the second candidate won.
	await expect.element(page.getByText(m.cego_winner({ name: second.name })).first()).toBeVisible();
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

/** A connected, live-capable cable state (no session). */
function cableFixture(partial: Partial<CableState> = {}): CableState {
	return {
		mode: 'real',
		connection: 'connected',
		device: {} as CableState['device'],
		deviceLabel: 'Cabo',
		devices: [],
		deviceLabels: ['Cabo'],
		writing: false,
		rescue: null,
		queue: null,
		lastOutcome: null,
		error: null,
		liveCapable: true,
		live: null,
		liveOrphan: null,
		...partial
	};
}

/** A stand-in app for CableBlind alone: a reactive cable state and the calls it makes. */
function standInApp(initial: CableState) {
	const cable = $state({ value: initial });
	const dismissLiveOrphan = vi.fn(() => {
		cable.value = { ...cable.value, liveOrphan: null };
	});
	const app = {
		get cableState() {
			return cable.value;
		},
		cable: {
			liveChecklist: () => ({ items: [], gateOk: true, canWrite: true }),
			createGesture: () => null,
			dismissLiveOrphan
		}
	} as unknown as ClientApp;
	const port = {
		getState: () => cable.value,
		startComparison: vi.fn(),
		switchComparison: vi.fn(),
		cancelHold: vi.fn(),
		endComparison: vi.fn(),
		confirmEndComparison: vi.fn()
	} as unknown as CableRoundPort;
	return { app, cable, dismissLiveOrphan, round: createCableRound({ port, output: () => null }) };
}

const pair = () =>
	officialCandidates()
		.filter((c) => c.accepted && !c.experimental)
		.slice(0, 2);

test('an old preview on the cable blocks the start with why; "Já desconectei" unblocks it', async () => {
	const orphan = { crc: 1, at: 2, deviceLabel: 'Cabo' };
	const fake = standInApp(cableFixture({ liveOrphan: orphan }));
	await render(CableBlind, {
		app: fake.app,
		round: fake.round,
		view: fake.round.view,
		mode: 'setup',
		candidates: pair()
	});
	const go = page.getByRole('button', { name: m.cable_blind_start() });
	await expect.element(page.getByText(m.cable_blind_reason_orphan()).first()).toBeVisible();
	await expect.element(go).toHaveAttribute('aria-disabled', 'true');
	await page.getByRole('button', { name: m.cable_live_orphan_dismiss() }).click();
	expect(fake.dismissLiveOrphan).toHaveBeenCalledTimes(1);
	await expect.element(page.getByText(m.cable_blind_reason_orphan())).not.toBeInTheDocument();
	await page.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await expect.element(go).not.toHaveAttribute('aria-disabled');
});

test.each([
	['disconnected', () => m.cable_live_ended_disconnected()],
	['stopped', () => m.cable_blind_ended_gone()],
	['forgotten', () => m.cable_blind_ended_gone()]
] as const)(
	'a test ended without the page (%s) says what the cable plays now',
	async (reason, text) => {
		const live: LiveState = {
			deviceLabel: 'Cabo',
			status: 'ended',
			applied: null,
			pending: false,
			ackLevelDb: null,
			hold: null,
			applies: 3,
			total: 3,
			lastError: null,
			endedReason: reason,
			comparison: { active: false, blind: true, count: 2, status: 'ready' }
		};
		const fake = standInApp(cableFixture({ live }));
		await render(CableBlind, {
			app: fake.app,
			round: fake.round,
			view: { ...IDLE_VIEW, phase: 'ended', endedReason: 'gone' },
			mode: 'results',
			candidates: pair(),
			winner: 0
		});
		const ended = document.querySelector('[data-cable-blind-ended]');
		expect(ended?.textContent?.trim()).toBe(text());
		if (reason !== 'disconnected') {
			expect(ended?.textContent).not.toContain(m.cable_live_ended_disconnected());
		}
	}
);

/** The saved curve's preamp: the floor, quieter than any test curve (its revert is never held). */
const SAVED_PREAMP_DB = THRESHOLDS.preampMinDb;

/**
 * A real app with a FakeHID cable, rendered BlindTest with Auri and Natural chosen (three rounds),
 * and "Começar no cabo" clicked. `saved`: the cable's saved curve (journal) is known, all filters
 * off at `SAVED_PREAMP_DB`.
 */
async function startOnCable(saved: boolean) {
	// Every random word is 0: the order of every round is [second, first] (Fisher–Yates).
	vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => array);
	const fake = fakeAppOptions();
	const app = createClientApp(fake.options);
	apps.push(app);
	await app.start();
	expect(await app.cable.connect()).not.toBeNull();
	if (saved) {
		const device = app.cable.getState().deviceLabel;
		if (device === null) throw new Error('expected a cable label');
		const bands = Array.from({ length: 10 }, (): Band => ({ kind: 'OFF' }));
		const crc = gateForWrite(bands, SAVED_PREAMP_DB, { experimental: false }).metrics.payloadCrc;
		expect(
			app.state.journal.append({
				schema: 1,
				at: fake.time.value,
				name: 'Salva',
				crc: Number(crc),
				preampDb: SAVED_PREAMP_DB,
				bands,
				status: 'ok',
				device
			})
		).toBe(true);
	}
	vi.spyOn(app.cable, 'createGesture').mockImplementation(() =>
		createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ now: () => fake.time.value, userActivation: null }
		)
	);
	const audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	audio.setVolume(-40);
	engines.push(audio);
	const [first, second] = officialCandidates().filter((c) => /^(Auri|Natural)\b/.test(c.name));
	if (first === undefined || second === undefined) throw new Error('expected two presets');
	const plan = planComparison(
		[first, second].map((c) => ({ bands: c.bands, preampDb: c.preampDb })),
		{ match: true }
	);
	const screen = await render(BlindTest, { audio, client: app, reducedMotion: true });
	await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
	await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
	await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
	const roundsInput = document.querySelector<HTMLInputElement>('input[id$="-rounds"]');
	if (roundsInput === null) throw new Error('Missing rounds');
	roundsInput.value = '3';
	roundsInput.dispatchEvent(new Event('input', { bubbles: true }));
	await page.getByRole('tab', { name: new RegExp(m.cego_cable()) }).click();
	await levers();
	await page.getByRole('button', { name: m.cable_blind_start() }).click();
	return { fake, app, first, second, plan, screen };
}

/** The levers of a start or of "Retomar" (volume, and experimental when asked). */
async function levers() {
	await page.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	const experimental = page.getByRole('checkbox', { name: m.cable_confirm_experimental() });
	if (experimental.elements().length > 0) await experimental.click();
}

/** The change check: both items heard with the audio playing, then "Ouvi mudar". */
async function passCheck(app: ClientApp) {
	const panel = page.getByRole('tabpanel');
	await expect.element(page.getByText(m.cable_blind_check_title())).toBeVisible();
	const changed = page.getByRole('button', { name: m.cable_blind_check_changed() });
	await panel.getByRole('button', { name: m.cego_play(), exact: true }).click();
	await expect
		.element(panel.getByRole('button', { name: m.cego_pause(), exact: true }))
		.toBeVisible();
	await page.getByRole('button', { name: m.cable_blind_check_phone() }).click();
	await expect.element(changed).not.toHaveAttribute('aria-disabled');
	await panel.getByRole('button', { name: m.cego_pause(), exact: true }).click();
	await changed.click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison).toMatchObject({ blind: true }));
}

/** One scored round: position 1 (the second candidate) gets 10, position 2 (the first) 0. */
async function scoreRound() {
	const panel = page.getByRole('tabpanel');
	await panel.getByRole('button', { name: m.cego_play(), exact: true }).click();
	await vi.waitFor(() => expect(announcement()).toBe(m.cable_blind_position_ready({ number: 1 })), {
		timeout: 4000
	});
	await panel
		.getByRole('button', { name: new RegExp(`${m.cego_position({ number: 2 })}`) })
		.click();
	await vi.waitFor(() => expect(announcement()).toBe(m.cable_blind_position_ready({ number: 2 })), {
		timeout: 4000
	});
	await rate(1, '{End}');
	await rate(2, '{Home}');
	const next = panel.getByRole('button', { name: m.cego_next(), exact: true });
	await expect.element(next).not.toHaveAttribute('aria-disabled');
	await next.click();
}

test('"Encerrar" during the change check after scored rounds: the reveal saves the winner\'s original curve', async () => {
	const { app, second, plan } = await startOnCable(true);
	const winner = plan.items[1];
	if (winner === undefined) throw new Error('expected two items');
	await passCheck(app);
	// Two scored rounds (of three): enough for a winner.
	await scoreRound();
	await scoreRound();
	// "O som parou de mudar", then "Retomar": the change check runs again (its own set).
	const panel = page.getByRole('tabpanel');
	await panel.getByRole('button', { name: m.cable_blind_stuck() }).click();
	await levers();
	await page.getByRole('button', { name: m.cable_blind_resume() }).click();
	await expect.element(page.getByText(m.cable_blind_check_title())).toBeVisible();
	expect(app.cableState.live?.comparison).toMatchObject({ blind: false, active: true });

	// "Encerrar" while the check (Neutro / telefone) plays: back to the saved curve.
	const end = page.getByRole('button', { name: m.cable_blind_end(), exact: true });
	await expect.element(end).not.toHaveAttribute('aria-disabled');
	await end.click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('reverted'));
	// The completed round is revealed.
	await expect.element(page.getByText(m.cego_winner({ name: second.name })).first()).toBeVisible();
	const save = page.getByRole('button', { name: m.cable_blind_save_winner() });
	await expect.element(save).not.toHaveAttribute('aria-disabled');
	await save.click();
	await vi.waitFor(() => expect(app.pendingWrite).not.toBeNull());
	const pending = app.pendingWrite;
	// The winner's own original curve, never the check's item at the same index.
	expect(pending?.name).toBe(second.name);
	expect(pending?.preampDb).toBe(winner.original.preampDb);
	expect(pending?.bands).toEqual(winner.original.bands);
	const phone = planComparison(checkCurves(), { match: true }).items[1];
	expect(pending?.bands).not.toEqual(phone?.original.bands);
}, 60000);

test('without a known saved curve "Encerrar" is locked with why; "Encerrar sem voltar" reveals the scored rounds', async () => {
	const { app, fake, second } = await startOnCable(false);
	await passCheck(app);
	// Two scored rounds (of three): enough for a winner.
	await scoreRound();
	await scoreRound();
	expect(app.cable.liveSavedCurve()).toBeNull();
	const end = page.getByRole('button', { name: m.cable_blind_end(), exact: true });
	await expect.element(end).toHaveAttribute('aria-disabled', 'true');
	const described = end.element().getAttribute('aria-describedby') ?? '';
	expect(document.getElementById(described)?.textContent).toContain(m.cable_x2_end_no_saved());
	// A locked button only says why: nothing reaches the cable.
	const locked = end.element();
	if (locked instanceof HTMLElement) locked.click();
	await tick();
	await app.cable.whenLiveIdle();
	expect(app.cableState.live?.comparison).toMatchObject({ blind: true, active: true });

	const playing = playingCrc(fake);
	const keep = page.getByRole('button', { name: m.cable_blind_end_keep(), exact: true });
	await expect.element(keep).not.toHaveAttribute('aria-disabled');
	await keep.click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	// The cable keeps its curve; the completed round is revealed, saying so.
	expect(playingCrc(fake)).toBe(playing);
	await expect.element(page.getByText(m.cego_winner({ name: second.name })).first()).toBeVisible();
	await expect
		.poll(() =>
			document.querySelector('[data-cable-blind-ended]')?.getAttribute('data-cable-blind-ended')
		)
		.toBe('kept');
	expect(document.querySelector('[data-cable-blind-ended]')?.textContent?.trim()).toBe(
		m.cable_blind_ended_kept()
	);
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
