import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
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

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`rack is safe before an app exists and cover can close without requesting a write in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const screen = await render(CaboPage, { app: null });
		await expect
			.element(page.getByRole('button', { name: m.cabo_lift(), exact: true }))
			.toBeDisabled();
		await expect.element(page.getByRole('combobox')).toBeDisabled();
		await expect.element(page.getByText(m.cabo_journal_empty(), { exact: true })).toBeVisible();
		const fake = fakeAppOptions();
		app = createClientApp(fake.options);
		const request = vi.spyOn(app, 'requestWrite');
		await screen.rerender({ app });
		await page.getByRole('button', { name: m.cabo_lift(), exact: true }).click();
		await expect
			.element(page.getByRole('button', { name: m.cabo_close_cover(), exact: true }))
			.toHaveAttribute('aria-expanded', 'true');
		await page.getByRole('button', { name: m.cabo_close_cover(), exact: true }).click();
		await expect
			.element(page.getByRole('button', { name: m.cabo_review_write(), exact: true }))
			.toBeDisabled();
		expect(request).not.toHaveBeenCalled();
		expect(fake.device.sent).toHaveLength(0);
	});
}

for (const status of ['ok', 'simulated', 'interrupted'] as const) {
	test(`transport replays ${status} acceptance, not an unconditional commit`, async () => {
		const screen = await render(TransportTape, { curve: NEUTRO, outcome: outcome(status) });
		await expect.element(page.getByRole('status')).toHaveAttribute('data-status', status);
		await page.getByRole('button', { name: m.cabo_commit(), exact: true }).click();
		await expect
			.element(
				page.getByText(status === 'interrupted' ? m.cabo_not_sent() : m.cabo_accepted(), {
					exact: true
				})
			)
			.toBeVisible();
		await page.getByRole('button', { name: m.cabo_report({ index: '0' }), exact: true }).click();
		await expect.element(page.getByText(m.cabo_accepted(), { exact: true })).toBeVisible();
		await page.getByRole('button', { name: m.cabo_report({ index: '8' }), exact: true }).click();
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
		await expect
			.element(page.getByRole('button', { name: m.cabo_replay(), exact: true }))
			.toBeDisabled();
	});
}

test('transport rehearsal can be stopped, and journal without a loader remains read-only', async () => {
	await render(TransportTape, { curve: NEUTRO });
	await page.getByRole('button', { name: m.cabo_rehearse(), exact: true }).click();
	await page.getByRole('button', { name: m.cabo_stop(), exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: m.cabo_stop(), exact: true }))
		.toBeDisabled();
	await cleanup();
	const screen = await render(Journal, { entries: [{ ...entry(), preampDb: 1 }] });
	await expect
		.element(page.getByRole('button', { name: m.cabo_load(), exact: true }))
		.toBeDisabled();
	expect(screen.container.querySelector('.mini')).toBeNull();
});
