import '../../primitives/design-system.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { page, type Locator } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import type { Written, JournalEntry } from '#lib/cable/types.ts';
import CaboPage from '#lib/components/pages/cabo/CaboPage.svelte';
import Journal from '#lib/components/pages/cabo/Journal.svelte';
import TransportTape from '#lib/components/pages/cabo/TransportTape.svelte';
import { fakeAppOptions } from '../../app/fakes.ts';

let app: ClientApp | null = null;
afterEach(async () => {
	await cleanup();
	app?.dispose();
	app = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

function entry(): JournalEntry {
	return {
		schema: 1,
		at: 1000,
		name: 'Sent neutral',
		bands: NEUTRO.bands.map((band) => ({ ...band })),
		preampDb: NEUTRO.preampDb,
		crc: NEUTRO.crc,
		status: 'ok',
		device: 'Test cable'
	};
}

function outcome(status: Written['status']): Written {
	return {
		status,
		simulated: status === 'simulated',
		entry: { ...entry(), status },
		result: {
			status: status === 'interrupted' ? 'interrupted' : 'ok',
			startedAt: 100,
			finishedAt: 450,
			reportsSent: status === 'interrupted' ? 2 : 9,
			committed: status !== 'interrupted',
			crc: NEUTRO.crc
		},
		deviceLabel: 'Test cable',
		crc: NEUTRO.crc,
		levelDb: -0.5
	};
}

/** FUX.P6: unavailable `Button`s are aria-disabled and state why (never native disabled). */
async function expectUnavailable(button: Locator, reason: string) {
	await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	await expect.element(button).toHaveAccessibleDescription(reason);
}

async function expectAvailable(button: Locator) {
	await expect.element(button).not.toHaveAttribute('aria-disabled');
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`rack is safe before an app exists and cover can close without requesting a write in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const screen = await render(CaboPage, { app: null, tourAutoOpen: false });
		await expectUnavailable(
			page.getByRole('button', { name: m.cabo_lift(), exact: true }),
			m.cabo_fux_loading()
		);
		await expect
			.element(page.getByRole('combobox', { name: m.cabo_presets(), exact: true }))
			.toBeDisabled();
		await expect
			.element(page.getByRole('combobox', { name: m.cabo_presets(), exact: true }))
			.toHaveAccessibleDescription(m.cabo_fux_loading());
		// The empty journal teaches (spec §4.4) and shows three EXAMPLE boxes.
		await expect.element(page.getByText(m.empty_journal_body(), { exact: true })).toBeVisible();
		expect(screen.container.querySelectorAll('[data-example]')).toHaveLength(3);
		const fake = fakeAppOptions();
		app = createClientApp(fake.options);
		const request = vi.spyOn(app, 'requestWrite');
		await screen.rerender({ app });
		await expect
			.element(page.getByRole('combobox', { name: m.cabo_presets(), exact: true }))
			.not.toBeDisabled();
		await expect
			.element(page.getByRole('combobox', { name: m.cabo_presets(), exact: true }))
			.not.toHaveAttribute('aria-describedby');
		await page.getByRole('button', { name: m.cabo_lift(), exact: true }).click();
		await expect
			.element(page.getByRole('button', { name: m.cabo_close_cover(), exact: true }))
			.toHaveAttribute('aria-expanded', 'true');
		await page.getByRole('button', { name: m.cabo_close_cover(), exact: true }).click();
		await expectUnavailable(
			page.getByRole('button', { name: m.cabo_review_write(), exact: true }),
			m.cabo_fux_review_closed()
		);
		expect(request).not.toHaveBeenCalled();
		expect(fake.device.sent).toHaveLength(0);
	});
}

test('the preset selector remains natively disabled and describes the active write', async () => {
	await setLocale('pt-BR', { reload: false });
	app = createClientApp(fakeAppOptions().options);
	vi.spyOn(app, 'cableState', 'get').mockReturnValue({ ...app.cableState, writing: true });
	const load = vi.spyOn(app.state.curve, 'loadPreset');
	await render(CaboPage, { app, tourAutoOpen: false });
	const preset = page.getByRole('combobox', { name: m.cabo_presets(), exact: true });
	await expect.element(preset).toBeDisabled();
	await expect.element(preset).toHaveAccessibleDescription(m.cabo_fux_busy_writing());
	// Other disabled Buttons have hidden tooltip copies of the same message.
	const reasonId = preset.element().getAttribute('aria-describedby');
	if (!reasonId) throw new Error('Missing preset disabled reason reference');
	const reason = document.getElementById(reasonId);
	if (!reason) throw new Error('Missing preset disabled reason');
	await expect.element(reason).toBeVisible();
	expect(load).not.toHaveBeenCalled();
});

for (const status of ['ok', 'simulated', 'interrupted'] as const) {
	test(`transport replays ${status} acceptance, not an unconditional commit`, async () => {
		const screen = await render(TransportTape, { curve: NEUTRO, outcome: outcome(status) });
		await expect.element(page.getByRole('status')).toHaveAttribute('data-status', status);
		const inspector = page.getByRole('combobox', { name: m.cabo_fux_inspect(), exact: true });
		await inspector.selectOptions('9');
		await expect
			.element(
				page.getByText(status === 'interrupted' ? m.cabo_not_sent() : m.cabo_accepted(), {
					exact: true
				})
			)
			.toBeVisible();
		await inspector.selectOptions('0');
		await expect.element(page.getByText(m.cabo_accepted(), { exact: true })).toBeVisible();
		await inspector.selectOptions('8');
		await expect
			.element(
				page.getByText(status === 'interrupted' ? m.cabo_not_sent() : m.cabo_accepted(), {
					exact: true
				})
			)
			.toBeVisible();
		await page.getByRole('button', { name: m.cabo_replay(), exact: true }).click();
		expect(screen.container.querySelector('.timing')?.textContent).toContain('350');
		await screen.rerender({ outcome: { status: 'refused', reason: 'gesture' } });
		await expectUnavailable(
			page.getByRole('button', { name: m.cabo_replay(), exact: true }),
			m.cabo_fux_replay_none()
		);
	});
}

/** Manual clock + frame queue: the rehearsal only advances when the test steps it. */
function manualFrames() {
	let time = 1000;
	let nextHandle = 0;
	const queue = new Map<number, FrameRequestCallback>();
	return {
		now: () => time,
		frame: (callback: FrameRequestCallback) => {
			nextHandle += 1;
			queue.set(nextHandle, callback);
			return nextHandle;
		},
		cancel: (handle: number) => {
			queue.delete(handle);
		},
		get pending() {
			return queue.size;
		},
		step(ms: number) {
			time += ms;
			const callbacks = [...queue.values()];
			queue.clear();
			for (const callback of callbacks) callback(time);
		}
	};
}

test('transport rehearsal can be stopped, and journal without a loader remains read-only', async () => {
	const clock = manualFrames();
	await render(TransportTape, {
		curve: NEUTRO,
		now: clock.now,
		frame: clock.frame,
		cancel: clock.cancel
	});
	const stop = page.getByRole('button', { name: m.cabo_stop(), exact: true });
	await expectUnavailable(stop, m.cabo_fux_stop_idle());
	await page.getByRole('button', { name: m.cabo_rehearse(), exact: true }).click();
	// Time is frozen: the rehearsal stays running until stopped, whatever the machine speed.
	await expectAvailable(stop);
	expect(clock.pending).toBe(1);
	clock.step(16);
	await expectAvailable(stop);
	expect(clock.pending).toBe(1);
	await stop.click();
	await expectUnavailable(stop, m.cabo_fux_stop_idle());
	expect(clock.pending).toBe(0);
	// A late step after Stop schedules nothing (the frame was cancelled).
	clock.step(10_000);
	expect(clock.pending).toBe(0);
	await expectUnavailable(stop, m.cabo_fux_stop_idle());
	// Without Stop, the rehearsal ends by itself once the clock passes the tape duration.
	await page.getByRole('button', { name: m.cabo_rehearse(), exact: true }).click();
	await expectAvailable(stop);
	clock.step(10_000);
	await expectUnavailable(stop, m.cabo_fux_stop_idle());
	expect(clock.pending).toBe(0);
	await cleanup();
	const screen = await render(Journal, { entries: [{ ...entry(), preampDb: 1 }] });
	await expectUnavailable(
		page.getByRole('button', { name: m.cabo_load(), exact: true }),
		m.cabo_fux_load_wait()
	);
	expect(screen.container.querySelector('.mini')).toBeNull();
});
