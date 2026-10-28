/**
 * "Ouvir no cabo" on the Curva page (issue #69): the live (no-flash) preview UI on top of the
 * cable service's live session. A real client app with a FakeHID cable (auto-advancing fake
 * clock): what reaches the cable is read from the service state and the fake firmware.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import { formatNumber } from '#lib/components/cable/i18n.ts';
import CableBar from '#lib/components/chrome/CableBar.svelte';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import { CurvaPreview } from '#lib/components/pages/curva/preview.svelte.ts';
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import type { Band } from '#lib/components/pages/curva/model.ts';
import { fakeAppOptions } from '../../app/fakes.ts';
import '../../primitives/design-system.ts';

const OFF_BANDS: Band[] = Array.from({ length: 10 }, (): Band => ({ kind: 'OFF' }));

let apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps) app.dispose();
	apps = [];
	vi.restoreAllMocks();
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
		layer: 'ouvir',
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

async function startLive(app: ClientApp) {
	await liveSwitch().click();
	const dialog = page.getByRole('dialog', { name: m.cable_live_checklist_title() });
	await expect.element(dialog).toBeVisible();
	await dialog.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
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

test('while live, the browser preview chains play flat (no EQ on top of the cable)', async () => {
	const update = vi.spyOn(CurvaPreview.prototype, 'update');
	const { app } = await setup();
	const last = () => update.mock.calls.at(-1);
	await startLive(app);
	await vi.waitFor(() => {
		const [reference, editor] = last() ?? [];
		for (const curve of [reference, editor]) {
			expect(curve?.bands.every((band) => band.kind === 'OFF')).toBe(true);
			expect(curve?.preampDb).toBe(-0.5);
		}
	});
	await app.cable.stopLive({ revert: false });
	await vi.waitFor(() => expect(last()?.[1].preampDb).toBe(-12));
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

test('the A/B lever switches the cable between the saved curve (A) and the editor (B)', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	const a = page.getByRole('radio', { name: m.curva_ab_a({ name: m.curva_ab_ref_written() }) });
	const b = page.getByRole('radio', { name: m.curva_ab_b() });
	// Works without the browser preview playing.
	await expect.element(a).not.toHaveAttribute('aria-disabled', 'true');
	await a.click();
	await expect.element(a).toHaveAttribute('aria-checked', 'true');
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.applied?.preampDb).toBe(-11.5);
	});
	await b.click();
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.applied?.preampDb).toBe(-12);
	});
});

test('the unsaved chip shows on the page; "Salvar no cabo" opens the checklist on the applied curve', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	const chip = page.getByText(m.cable_live_chip());
	await expect.element(chip).toBeVisible();
	await page.getByRole('button', { name: m.cable_live_save() }).click();
	expect(app.pendingWrite?.preampDb).toBe(-12);
	expect(app.pendingWrite?.bands).toEqual(app.cableState.live?.applied?.bands);
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

test('"Voltar à curva salva" without a known saved curve says to unplug and replug', async () => {
	const { app } = await setup();
	await startLive(app);
	await page.getByRole('button', { name: m.cable_live_revert() }).click();
	await expect.element(page.getByText(m.cable_live_refused_no_saved_curve())).toBeVisible();
	expect(app.cableState.live?.status).toBe('live');
});

test('a louder edit is held with a banner; confirming applies it', async () => {
	const { app, set } = await setup();
	await startLive(app);
	expect(set(-6)).toBe(true);
	await vi.waitFor(async () => {
		await app.cable.whenLiveIdle();
		expect(app.cableState.live?.hold?.reason).toBe('loudness');
	});
	const delta = app.cableState.live?.hold?.deltaDb ?? Number.NaN;
	const banner = page.getByRole('alert').filter({ hasText: m.cable_live_hold_loudness({ delta: formatNumber(delta, 1) }) });
	await expect.element(banner).toBeVisible();
	expect(app.cableState.live?.applied?.preampDb).toBe(-12);
	await banner.getByRole('button', { name: m.cable_live_hold_loudness_confirm() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.applied?.preampDb).toBe(-6));
	expect(app.cableState.live?.hold).toBeNull();
	await expect.element(banner).not.toBeInTheDocument();
});

test('unplugging the cable ends the session with the disconnect message', async () => {
	const { app, fake } = await setup();
	await startLive(app);
	fake.hid.disconnect(fake.device);
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('disconnected'));
	await expect.element(page.getByText(m.cable_live_ended_disconnected())).toBeVisible();
	// Back on the saved curve: no unsaved chip.
	await expect.element(page.getByText(m.cable_live_chip())).not.toBeInTheDocument();
});

test('turning off with "Voltar à curva salva" reverts with a gesture, then ends', async () => {
	const { app } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	const stop = vi.spyOn(app.cable, 'stopLive');
	await liveSwitch().click();
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
	await expect.element(page.getByText(m.cable_live_chip())).not.toBeInTheDocument();
});

test('turning off with "Manter até desconectar" keeps the preview on the cable and the chip', async () => {
	const { app, fake } = await setup({ savedPreampDb: -11.5 });
	await startLive(app);
	const crc = playingCrc(fake);
	await liveSwitch().click();
	await page.getByRole('button', { name: m.cable_live_off_keep() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.endedReason).toBe('stopped'));
	expect(playingCrc(fake)).toBe(crc);
	await expect.element(page.getByText(m.cable_live_ended_stopped())).toBeVisible();
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
