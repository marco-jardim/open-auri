/**
 * "Ouvir no cabo" on the Curva page (issue #69): the live (no-flash) preview UI on top of the
 * cable service's live session. A real client app with a FakeHID cable (auto-advancing fake
 * clock): what reaches the cable is read from the service state and the fake firmware.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { PADRAO_AURI } from 'open-auri/catalog';
import { gateForWrite } from 'open-auri/safety';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { CABLE_LIVE_KEY, CABLE_LIVE_LOCK } from '#lib/cable/service.ts';
import type { LiveOutcome } from '#lib/cable/types.ts';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import { formatNumber } from '#lib/components/cable/i18n.ts';
import CableBar from '#lib/components/chrome/CableBar.svelte';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import { CurvaPreview } from '#lib/components/pages/curva/preview.svelte.ts';
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import type { Band, Curve } from '#lib/components/pages/curva/model.ts';
import { YOLO_PHRASE } from '#lib/state/yolo.svelte.ts';
import { fakeAppOptions } from '../../app/fakes.ts';
import '../../primitives/design-system.ts';

const OFF_BANDS: Band[] = Array.from({ length: 10 }, (): Band => ({ kind: 'OFF' }));

let apps: ClientApp[] = [];

beforeEach(() => {
	// The service keeps its live marker in the real localStorage here: no orphan from a previous test.
	localStorage.removeItem(CABLE_LIVE_KEY);
});

afterEach(async () => {
	await cleanup();
	for (const app of apps) {
		app.yolo.disable();
		app.dispose();
	}
	apps = [];
	vi.restoreAllMocks();
	localStorage.removeItem(CABLE_LIVE_KEY);
	await setLocale('pt-BR', { reload: false });
});

function gateClient(): GateClient {
	let id = 0;
	return {
		async drag(input) {
			const response = handleGateRequest({ ...input, type: 'drag', id: ++id });
			if (response.type !== 'drag') throw new Error('unexpected');
			return response;
		},
		async commit(input) {
			const response = handleGateRequest({ ...input, type: 'commit', id: ++id });
			if (response.type !== 'commit') throw new Error('unexpected');
			return response;
		}
	};
}

interface SetupOptions {
	/** The editor curve's preamp (all filters off). */
	preampDb?: number;
	/** A saved (written) curve's preamp, marked as the last write before the editor changes. */
	savedPreampDb?: number;
	livePolicy?: { enabled: boolean };
	layer?: 'ouvir' | 'engenharia';
}

async function setup(options: SetupOptions = {}) {
	const fake = fakeAppOptions();
	const app = createClientApp({
		...fake.options,
		cable: {
			...fake.options.cable,
			...(options.livePolicy === undefined ? {} : { livePolicy: options.livePolicy })
		}
	});
	apps.push(app);
	await app.start();
	// The fake picker grants the plugged-in cable (a restore only finds granted devices).
	expect(await app.cable.connect()).not.toBeNull();
	const set = (preampDb: number) =>
		app.state.curve.set({ name: 'Teste', source: 'custom', preampDb, bands: OFF_BANDS });
	if (options.savedPreampDb !== undefined) {
		expect(set(options.savedPreampDb)).toBe(true);
		expect(app.state.curve.markWritten()).toBe(true);
		// The cable's own saved curve (the service reads it from the shared journal).
		const savedCrc = gateForWrite(OFF_BANDS, options.savedPreampDb, { experimental: false })
			.metrics.payloadCrc;
		const device = app.cable.getState().deviceLabel;
		expect(device).not.toBeNull();
		expect(
			app.state.journal.append({
				schema: 1,
				at: fake.time.value,
				name: 'Teste',
				crc: Number(savedCrc),
				preampDb: options.savedPreampDb,
				bands: OFF_BANDS,
				status: 'ok',
				device
			})
		).toBe(true);
	}
	expect(set(options.preampDb ?? -12)).toBe(true);
	// Component clicks are synthetic here: mint real single-use tokens for each gesture.
	const gestures = vi
		.spyOn(app.cable, 'createGesture')
		.mockImplementation(() =>
			createGestureToken(
				{ isTrusted: true, type: 'click' },
				{ now: () => fake.time.value, userActivation: null }
			)
		);
	const screen = await render(CurvaPage, {
		app,
		layer: options.layer ?? 'ouvir',
		hash: '',
		pageUrl: new URL('https://example.test/'),
		onlayer: vi.fn(),
		gateClient: gateClient(),
		tourAutoOpen: false
	});
	await tick();
	return { app, fake, screen, set, gestures };
}

const liveSwitch = () => page.getByRole('switch', { name: m.cable_live_switch() });
const radioA = (name: string = m.curva_ab_ref_written()) =>
	page.getByRole('radio', { name: m.curva_ab_a({ name }) });
const radioB = () => page.getByRole('radio', { name: m.curva_ab_b() });

async function openChecklist() {
	await liveSwitch().click();
	const dialog = page.getByRole('dialog', { name: m.cable_live_checklist_title() });
	await expect.element(dialog).toBeVisible();
	await dialog.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	return dialog;
}

async function startLive(app: ClientApp) {
	const dialog = await openChecklist();
	await dialog.getByRole('button', { name: m.cable_live_start() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.status).toBe('live'));
	await app.cable.whenLiveIdle();
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

/** The browser A/B chains, as the last `CurvaPreview.update` call got them. */
function chains(update: { mock: { calls: [Curve, Curve][] } }): [Curve, Curve] | undefined {
	return update.mock.calls.at(-1);
}

function expectFlat(pair: [Curve, Curve] | undefined) {
	expect(pair).toBeDefined();
	for (const curve of pair ?? []) {
		expect(curve.bands.every((band) => band.kind === 'OFF')).toBe(true);
		expect(curve.preampDb).toBe(-0.5);
	}
}

test('the switch is hidden when the transport is not live-capable', async () => {
	const { app } = await setup({ livePolicy: { enabled: false } });
	expect(app.cableState.connection).toBe('connected');
	expect(liveSwitch().all()).toHaveLength(0);
	expect(document.querySelector('[data-live-panel]')).toBeNull();
});

test('the switch shows with a connected live-capable cable, off', async () => {
	await setup();
	await expect.element(liveSwitch()).toBeVisible();
	await expect.element(liveSwitch()).toHaveAttribute('aria-checked', 'false');
});

test('starting needs the live checklist and a gesture; then the cable plays the editor curve', async () => {
	const { app, fake, gestures } = await setup();
	await liveSwitch().click();
	const dialog = page.getByRole('dialog', { name: m.cable_live_checklist_title() });
	await expect.element(dialog).toBeVisible();
	// No spacing, no "keep connected": only the gate and the volume lever here.
	expect(dialog.getByRole('checkbox').all()).toHaveLength(1);
	const start = dialog.getByRole('button', { name: m.cable_live_start() });
	// Locked (aria-disabled, its reason announced) until the volume lever is confirmed.
	await expect.element(start).toHaveAttribute('aria-disabled', 'true');
	const locked = start.element();
	if (locked instanceof HTMLElement) locked.click();
	await tick();
	expect(app.cableState.live).toBeNull();
	expect(gestures).not.toHaveBeenCalled();

	await dialog.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await start.click();
	await vi.waitFor(() => expect(app.cableState.live?.status).toBe('live'));
	expect(gestures).toHaveBeenCalledTimes(1);
	await expect.element(dialog).not.toBeInTheDocument();
	await expect.element(liveSwitch()).toHaveAttribute('aria-checked', 'true');
	const applied = app.cableState.live?.applied;
	expect(applied?.preampDb).toBe(-12);
	expect(playingCrc(fake)).toBe(applied?.crc);
	// RAM only: nothing was committed to flash.
	expect(fake.device.firmware.commitCount).toBe(0);
	await expect.element(page.getByText(m.cable_live_stuck_note())).toBeVisible();
});

test('while starting, the checklist cannot be dismissed (the outcome must reach the page)', async () => {
	const { app } = await setup();
	let settle: (outcome: LiveOutcome) => void = () => undefined;
	vi.spyOn(app.cable, 'startLive').mockImplementation(
		() => new Promise<LiveOutcome>((resolve) => (settle = resolve))
	);
	const dialog = await openChecklist();
	await dialog.getByRole('button', { name: m.cable_live_start() }).click();
	await userEvent.keyboard('{Escape}');
	await tick();
	await expect.element(dialog).toBeVisible();
	settle({ status: 'refused', reason: 'busy' });
	await expect.element(dialog.getByText(m.cable_live_refused_busy())).toBeVisible();
	// Once settled, Escape closes it again.
	await userEvent.keyboard('{Escape}');
	await expect.element(dialog).not.toBeInTheDocument();
});

test('another tab running a preview refuses the start with live-elsewhere', async () => {
	const { app, fake } = await setup();
	fake.locks.held.add(CABLE_LIVE_LOCK);
	const dialog = await openChecklist();
	await dialog.getByRole('button', { name: m.cable_live_start() }).click();
	await expect.element(dialog.getByText(m.cable_live_refused_live_elsewhere())).toBeVisible();
	expect(app.cableState.live).toBeNull();
	await expect.element(liveSwitch()).toHaveAttribute('aria-checked', 'false');
	fake.locks.held.delete(CABLE_LIVE_LOCK);
});

test('while live, the browser chains play flat; after "Manter até desconectar" they stay flat', async () => {
	const update = vi.spyOn(CurvaPreview.prototype, 'update');
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	await vi.waitFor(() => expectFlat(chains(update)));
	await liveSwitch().click();
	await page.getByRole('button', { name: m.cable_live_off_keep() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	await tick();
	// The cable still plays the preview: no EQ in the browser on top of it.
	expectFlat(chains(update));
});

test('once the cable is back on the saved curve, the browser chains play the EQ again', async () => {
	const update = vi.spyOn(CurvaPreview.prototype, 'update');
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	await vi.waitFor(() => expectFlat(chains(update)));
	await liveSwitch().click();
	await page
		.getByRole('group', { name: m.cable_live_off_question() })
		.getByRole('button', { name: m.cable_live_revert() })
		.click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('reverted'));
	await vi.waitFor(() => {
		const [reference, editor] = chains(update) ?? [];
		expect(reference?.preampDb).toBe(-11.5);
		expect(editor?.preampDb).toBe(-12);
	});
});

test('a first apply that failed keeps the EQ chains (no level jump)', async () => {
	const update = vi.spyOn(CurvaPreview.prototype, 'update');
	const { app, fake } = await setup();
	// The first live apply stops before report 8: the cable keeps its saved curve.
	fake.device.faults.throwAtReport = fake.device.attempts + 2;
	const dialog = await openChecklist();
	await dialog.getByRole('button', { name: m.cable_live_start() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.lastError ?? null).not.toBeNull());
	await app.cable.whenLiveIdle();
	expect(app.cableState.live?.applied).toBeNull();
	await tick();
	const [reference, editor] = chains(update) ?? [];
	expect(editor?.preampDb).toBe(-12);
	expect(reference?.bands).toEqual(PADRAO_AURI.bands);
});

test('an orphan preview shows its notice and keeps the browser chains flat', async () => {
	// The orphan names the connected cable (the fake's default label): flat only while it is plugged in.
	localStorage.setItem(
		CABLE_LIVE_KEY,
		JSON.stringify({ tabId: 'gone-tab', device: 'USB DSP Audio', crc: 4660, at: 0 })
	);
	const update = vi.spyOn(CurvaPreview.prototype, 'update');
	const { app } = await setup();
	await vi.waitFor(() => expect(app.cableState.liveOrphan?.crc).toBe(4660));
	expect(app.cableState.deviceLabels).toContain('USB DSP Audio');
	await expect.element(page.getByText(m.cable_live_orphan())).toBeVisible();
	await vi.waitFor(() => expectFlat(chains(update)));
	// "Já desconectei": the notice and the marker go, the EQ'd chains come back.
	await page.getByRole('button', { name: m.cable_live_orphan_dismiss() }).click();
	await vi.waitFor(() => expect(app.cableState.liveOrphan ?? null).toBeNull());
	expect(localStorage.getItem(CABLE_LIVE_KEY)).toBeNull();
	await vi.waitFor(() => expect(chains(update)?.[1]?.preampDb).toBe(-12));
});

test('an orphan preview of a cable that is not connected keeps the EQ chains', async () => {
	localStorage.setItem(
		CABLE_LIVE_KEY,
		JSON.stringify({ tabId: 'gone-tab', device: 'Outro cabo', crc: 4660, at: 0 })
	);
	const update = vi.spyOn(CurvaPreview.prototype, 'update');
	const { app } = await setup();
	await vi.waitFor(() => expect(app.cableState.liveOrphan?.crc).toBe(4660));
	await expect.element(page.getByText(m.cable_live_orphan())).toBeVisible();
	await tick();
	await vi.waitFor(() => expect(chains(update)?.[1]?.preampDb).toBe(-12));
	const [reference] = chains(update) ?? [];
	expect(reference?.bands).toEqual(PADRAO_AURI.bands);
});

test('editing while live queues the new curve to the cable', async () => {
	const { app, fake, set } = await setup();
	await startLive(app);
	const queue = vi.spyOn(app.cable, 'queueLive');
	expect(set(-11)).toBe(true);
	await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(1));
	expect(queue.mock.calls[0]?.[0].preampDb).toBe(-11);
	await app.cable.whenLiveIdle();
	await vi.waitFor(() => expect(app.cableState.live?.applied?.preampDb).toBe(-11));
	expect(playingCrc(fake)).toBe(app.cableState.live?.applied?.crc);
	expect(fake.device.firmware.commitCount).toBe(0);
});

test('the free preview pauses following edits; turning it off sends the current curve', async () => {
	const { app, set } = await setup({ layer: 'engenharia' });
	await startLive(app);
	const queue = vi.spyOn(app.cable, 'queueLive');
	expect(app.yolo.enable(YOLO_PHRASE, 'engenharia')).toBe(true);
	app.yolo.setFreePreview(true);
	await tick();
	await expect.element(page.getByText(m.cable_live_follow_paused())).toBeVisible();
	expect(set(-11)).toBe(true);
	await tick();
	await tick();
	expect(queue).not.toHaveBeenCalled();
	app.yolo.setFreePreview(false);
	await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(1));
	expect(queue.mock.calls[0]?.[0].preampDb).toBe(-11);
});

test('the A/B lever switches the cable between the saved curve (A) and the editor (B)', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	const a = radioA();
	const b = radioB();
	// Works without the browser preview playing.
	await expect.element(a).not.toHaveAttribute('aria-disabled', 'true');
	await a.click();
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.applied?.preampDb).toBe(-11.5);
	});
	await expect.element(a).toHaveAttribute('aria-checked', 'true');
	// The cable plays the saved curve: nothing to save.
	await expect.element(page.getByText(m.cable_live_chip())).not.toBeInTheDocument();
	await b.click();
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.applied?.preampDb).toBe(-12);
	});
	await expect.element(b).toHaveAttribute('aria-checked', 'true');
});

test('A is unavailable while live when no saved curve is known', async () => {
	const { app } = await setup();
	await startLive(app);
	const a = radioA(PADRAO_AURI.label);
	await expect.element(a).toHaveAttribute('aria-disabled', 'true');
	await expect.element(page.getByText(m.cable_live_a_no_saved())).toBeVisible();
	const queue = vi.spyOn(app.cable, 'queueLive');
	(a.element() as HTMLElement).click();
	await tick();
	expect(queue).not.toHaveBeenCalled();
	expect(app.cableState.live?.applied?.preampDb).toBe(-12);
});

test('the unsaved chip shows on the page; "Salvar no cabo" opens the checklist on the applied curve', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	const chip = page.getByText(m.cable_live_chip());
	await expect.element(chip).toBeVisible();
	await page.getByRole('button', { name: m.cable_live_save() }).click();
	expect(app.pendingWrite?.preampDb).toBe(-12);
	expect(app.pendingWrite?.bands).toEqual(app.cableState.live?.applied?.bands);
	expect(app.pendingWrite?.name).toBe('Teste');
});

test('"Salvar" is locked while a louder edit is held; it names the curve that plays', async () => {
	const { app, set } = await setup();
	await startLive(app);
	expect(set(-6)).toBe(true);
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.hold?.reason).toBe('loudness');
	});
	// The cable still plays -12, not the editor's -6.
	const save = page.getByRole('button', { name: m.cable_live_save_playing_other() });
	await expect.element(save).toHaveAttribute('aria-disabled', 'true');
	(save.element() as HTMLElement).click();
	await tick();
	expect(app.pendingWrite).toBeFalsy();
	await page.getByRole('button', { name: m.cable_live_hold_loudness_confirm() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.applied?.preampDb).toBe(-6));
	await expect
		.element(page.getByRole('button', { name: m.cable_live_save() }))
		.not.toHaveAttribute('aria-disabled', 'true');
});

test('a curve other than the editor is saved under a neutral name, without the editor labels', async () => {
	const { app, set } = await setup({ savedPreampDb: -11.5 });
	expect(
		app.state.curve.set({
			name: 'Minha curva',
			source: 'custom',
			preampDb: -12,
			bands: OFF_BANDS,
			labels: ['Grave', null, null, null, null, null, null, null, null, null]
		})
	).toBe(true);
	await startLive(app);
	await liveSwitch().click();
	await page.getByRole('button', { name: m.cable_live_off_keep() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	// The editor moves on; the cable keeps -12.
	expect(set(-11)).toBe(true);
	const save = page.getByRole('button', { name: m.cable_live_save_playing_other() });
	await expect.element(save).not.toHaveAttribute('aria-disabled', 'true');
	await save.click();
	expect(app.pendingWrite?.preampDb).toBe(-12);
	expect(app.pendingWrite?.name).toBe(m.cable_live_save_name());
	expect(app.pendingWrite?.source).toBe('custom');
	expect(app.pendingWrite?.labels ?? null).toBeNull();
});

test('"Voltar à curva salva" calls revertLive with a gesture and the cable plays the saved curve', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	const revert = vi.spyOn(app.cable, 'revertLive');
	await page.getByRole('button', { name: m.cable_live_revert() }).click();
	await vi.waitFor(() => expect(revert).toHaveBeenCalledTimes(1));
	expect(revert.mock.calls[0]?.[0].gesture).not.toBeNull();
	expect(revert.mock.calls[0]?.[0].saved?.preampDb).toBe(-11.5);
	await vi.waitFor(() => expect(app.cableState.live?.applied?.preampDb).toBe(-11.5));
	await expect.element(page.getByText(m.cable_live_chip())).not.toBeInTheDocument();
	expect(app.cableState.live?.status).toBe('live');
});

test('after an accepted revert the lever shows A and B sends the editor curve again', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	await page.getByRole('button', { name: m.cable_live_revert() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.applied?.preampDb).toBe(-11.5));
	await expect.element(radioA()).toHaveAttribute('aria-checked', 'true');
	const device = app.cableState.live?.deviceLabel ?? '';
	await vi.waitFor(() =>
		expect(text('[data-live-status]')).toBe(m.cable_live_status_saved({ device }))
	);
	await radioB().click();
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.applied?.preampDb).toBe(-12);
	});
	await expect.element(radioB()).toHaveAttribute('aria-checked', 'true');
	await expect.element(page.getByText(m.cable_live_chip())).toBeVisible();
});

test('"Voltar à curva salva" without a known saved curve says to unplug and replug', async () => {
	const { app } = await setup();
	await startLive(app);
	await page.getByRole('button', { name: m.cable_live_revert() }).click();
	await vi.waitFor(() =>
		expect(text('[data-live-message]')).toBe(m.cable_live_refused_no_saved_curve())
	);
	expect(app.cableState.live?.status).toBe('live');
});

test('a revert the service held says so; it is never shown as a success', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	vi.spyOn(app.cable, 'revertLive').mockResolvedValue({
		status: 'refused',
		reason: 'revert-failed',
		revertFailure: 'held',
		live: app.cableState.live
	});
	await page.getByRole('button', { name: m.cable_live_revert() }).click();
	await vi.waitFor(() =>
		expect(text('[data-live-message]')).toBe(m.cable_live_revert_failed_held())
	);
	expect(document.querySelector('[data-live-ended]')).toBeNull();
});

test('turning off: a failed revert keeps the choice open and says to unplug and replug', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	vi.spyOn(app.cable, 'stopLive').mockResolvedValue({
		status: 'refused',
		reason: 'revert-failed',
		revertFailure: 'unknown',
		live: app.cableState.live
	});
	await liveSwitch().click();
	const group = page.getByRole('group', { name: m.cable_live_off_question() });
	await group.getByRole('button', { name: m.cable_live_revert() }).click();
	await vi.waitFor(() =>
		expect(text('[data-live-message]')).toBe(m.cable_live_revert_failed_retry())
	);
	await expect.element(group).toBeVisible();
	expect(document.querySelector('[data-live-ended]')).toBeNull();
	expect(document.body.textContent).not.toContain(m.cable_live_ended_reverted());
});

test('a louder edit is held with a banner; its alert is announced once; confirming applies it', async () => {
	const { app, set } = await setup();
	await startLive(app);
	expect(set(-6)).toBe(true);
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.hold?.reason).toBe('loudness');
	});
	const delta = app.cableState.live?.hold?.deltaDb ?? Number.NaN;
	const holdText = m.cable_live_hold_loudness({ delta: formatNumber(delta, 1) });
	await vi.waitFor(() => expect(text('[data-hold]')).toContain(holdText));
	// One persistent alert region, filled when the hold appears.
	const alerts = document.querySelectorAll('[data-live-panel] [role="alert"]');
	expect(alerts).toHaveLength(1);
	const region = alerts[0];
	expect(region?.textContent).toBe(holdText);
	// Another louder edit: still held, not announced again (same node, same text).
	expect(set(-5)).toBe(true);
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.hold?.reason).toBe('loudness');
	});
	await tick();
	expect(document.querySelector('[data-live-panel] [role="alert"]')).toBe(region);
	expect(region?.textContent).toBe(holdText);
	expect(app.cableState.live?.applied?.preampDb).toBe(-12);
	await page.getByRole('button', { name: m.cable_live_hold_loudness_confirm() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.applied?.preampDb).toBe(-5));
	expect(app.cableState.live?.hold).toBeNull();
	await expect.element(page.getByRole('button', { name: m.cable_live_hold_loudness_confirm() })).not.toBeInTheDocument();
});

test('status announcements: applying stays visual, live and ended are announced once', async () => {
	const { app, set } = await setup();
	await startLive(app);
	const device = app.cableState.live?.deviceLabel ?? '';
	const region = document.querySelector('[data-live-announce]');
	expect(region?.getAttribute('role')).toBe('status');
	await vi.waitFor(() => expect(region?.textContent).toBe(m.cable_live_status_live({ device })));
	const seen: string[] = [];
	const observer = new MutationObserver(() => seen.push(region?.textContent ?? ''));
	if (region) observer.observe(region, { childList: true, characterData: true, subtree: true });
	expect(set(-11)).toBe(true);
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.applied?.preampDb).toBe(-11);
	});
	await tick();
	expect(seen).toEqual([]);
	await app.cable.stopLive({ revert: false });
	await vi.waitFor(() => expect(region?.textContent).toBe(m.cable_live_ended_stopped()));
	observer.disconnect();
	// The same region (persistent), now with the end of the session.
	expect(document.querySelector('[data-live-announce]')).toBe(region);
	expect(seen.filter((entry) => entry === m.cable_live_status_applying())).toEqual([]);
});

test('unplugging the cable ends the session with the disconnect message', async () => {
	const { app, fake } = await setup();
	await startLive(app);
	fake.hid.disconnect(fake.device);
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('disconnected'));
	await vi.waitFor(() =>
		expect(text('[data-live-ended]')).toContain(m.cable_live_ended_disconnected())
	);
	// Back on the saved curve: no unsaved chip.
	await expect.element(page.getByText(m.cable_live_chip())).not.toBeInTheDocument();
});

test('turning off with "Voltar à curva salva" reverts with a gesture, then ends', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	const stop = vi.spyOn(app.cable, 'stopLive');
	await liveSwitch().click();
	await expect.element(liveSwitch()).toHaveAttribute('aria-expanded', 'true');
	const group = page.getByRole('group', { name: m.cable_live_off_question() });
	await expect.element(group).toBeVisible();
	const revert = group.getByRole('button', { name: m.cable_live_revert() });
	// The default choice gets the focus.
	await expect.element(revert).toHaveFocus();
	await revert.click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('reverted'));
	expect(stop.mock.calls[0]?.[0]).toMatchObject({ revert: true });
	expect(stop.mock.calls[0]?.[0].gesture).not.toBeNull();
	expect(app.cableState.live?.applied?.preampDb).toBe(-11.5);
	await expect.element(liveSwitch()).toHaveAttribute('aria-checked', 'false');
	await expect.element(liveSwitch()).toHaveFocus();
	await expect.element(page.getByText(m.cable_live_chip())).not.toBeInTheDocument();
});

test('the off choice: Escape cancels and the focus goes back to the switch', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	await expect.element(liveSwitch()).toHaveAttribute('aria-expanded', 'false');
	const controls = liveSwitch().element().getAttribute('aria-controls');
	await liveSwitch().click();
	const group = page.getByRole('group', { name: m.cable_live_off_question() });
	await expect.element(group).toBeVisible();
	expect(group.element().id).toBe(controls);
	await userEvent.keyboard('{Escape}');
	await expect.element(group).not.toBeInTheDocument();
	await expect.element(liveSwitch()).toHaveFocus();
	await expect.element(liveSwitch()).toHaveAttribute('aria-expanded', 'false');
	expect(app.cableState.live?.status).toBe('live');
	// "Cancelar" too.
	await liveSwitch().click();
	await group.getByRole('button', { name: m.cable_live_cancel() }).click();
	await expect.element(group).not.toBeInTheDocument();
	await expect.element(liveSwitch()).toHaveFocus();
});

test('turning off with "Manter até desconectar" keeps the preview on the cable and the chip', async () => {
	const { app, fake } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	const crc = playingCrc(fake);
	await liveSwitch().click();
	await page.getByRole('button', { name: m.cable_live_off_keep() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	expect(playingCrc(fake)).toBe(crc);
	await vi.waitFor(() => expect(text('[data-live-ended]')).toContain(m.cable_live_ended_stopped()));
	await expect.element(page.getByText(m.cable_live_chip())).toBeVisible();
});

test('leaving the page stops following edits; the cable keeps the preview', async () => {
	const { app, screen } = await setup();
	await startLive(app);
	screen.unmount();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	expect(app.cableState.live?.applied?.preampDb).toBe(-12);
});

test('the top bar shows a compact chip linking to the Curva page', async () => {
	await render(CableBar, { liveUnsaved: true });
	const chip = page.getByRole('link', { name: m.cable_live_chip_open() });
	await expect.element(chip).toBeVisible();
	await expect.element(chip).toHaveAttribute('href', '/');
});
