/**
 * S8 (#71): the Cabo page counts live previews (no flash write) apart from the flash counters,
 * points its former "Modo sem flash (RAM)" slot to "Ouvir no cabo" on the Curva page, and says
 * that an interrupted write may already play the new curve until the cable is replugged (B12).
 */
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import type { CableState, JournalEntry, LiveState } from '#lib/cable/types.ts';
import CaboPage from '#lib/components/pages/cabo/CaboPage.svelte';
import FlashCounters from '#lib/components/pages/cabo/FlashCounters.svelte';
import Journal from '#lib/components/pages/cabo/Journal.svelte';
import { livePreviewCount } from '#lib/components/pages/cabo/model.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

let active: ClientApp | null = null;

afterEach(async () => {
	await cleanup();
	active?.dispose();
	active = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

function liveState(patch: Partial<LiveState> = {}): LiveState {
	return {
		deviceLabel: 'Cabo A',
		status: 'live',
		applied: null,
		pending: false,
		ackLevelDb: null,
		hold: null,
		applies: 2,
		total: 5,
		lastError: null,
		...patch
	};
}

function entry(status: JournalEntry['status']): JournalEntry {
	return {
		schema: 1,
		at: 1000,
		name: `Curva ${status}`,
		device: 'Cabo A',
		bands: NEUTRO.bands.map((band) => ({ ...band })),
		preampDb: NEUTRO.preampDb,
		crc: NEUTRO.crc,
		status
	};
}

test('livePreviewCount reads the page total of live previews, 0 without a session', () => {
	expect(livePreviewCount(null)).toBe(0);
	const base = { live: null } as unknown as CableState;
	expect(livePreviewCount(base)).toBe(0);
	expect(livePreviewCount({ ...base, live: liveState() })).toBe(5);
	// An ended session keeps the page total.
	expect(
		livePreviewCount({ ...base, live: liveState({ status: 'ended', total: 9, applies: 1 }) })
	).toBe(9);
	for (const total of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
		expect(livePreviewCount({ ...base, live: liveState({ total }) })).toBe(0);
	}
});

for (const copy of [
	{
		locale: 'pt-BR',
		label: 'Prévias no cabo (sem gravação)',
		note: 'Prévias tocam a curva na hora sem gravar na memória do cabo; desconectar volta à curva salva.'
	},
	{
		locale: 'en-US',
		label: 'Previews on the cable (not saved)',
		note: "Previews play the curve right away without saving it to the cable's memory; unplugging goes back to the saved curve."
	}
] as const) {
	test(`the preview counter sits apart from the flash counters, explained, in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		const screen = await render(FlashCounters, {
			counters: { session: 1, day: 2, total: 3 },
			previews: 14
		});
		await expect.element(page.getByText(copy.label, { exact: true })).toBeVisible();
		await expect.element(page.getByText(copy.note, { exact: true })).toBeVisible();
		await expect
			.element(page.getByText(m.cabo_live_previews_scope(), { exact: true }))
			.toBeVisible();
		// The flash counters are unchanged; the preview drum is its own list.
		expect(
			[...screen.container.querySelectorAll('.counters [role="img"]')].map((node) =>
				node.getAttribute('aria-label')
			)
		).toEqual(['1', '2', '3']);
		const previews = screen.container.querySelector('[data-testid="cabo-live-previews"]');
		expect(previews?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('14');
		expect(previews?.closest('.counters')).toBeNull();
	});
}

test('the preview counter defaults to 0', async () => {
	const screen = await render(FlashCounters, { counters: { session: 0, day: 0, total: 0 } });
	const previews = screen.container.querySelector('[data-testid="cabo-live-previews"]');
	expect(previews?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('0');
});

test('the Cabo page shows the live preview total from the cable state', async () => {
	await setLocale('pt-BR', { reload: false });
	active = createClientApp(fakeAppOptions().options);
	const real = active;
	const cableState: CableState = { ...real.cableState, live: liveState({ total: 7 }) };
	// The real app, with a cable state that ran 7 previews in this page.
	const app = Object.create(real, { cableState: { get: () => cableState } }) as ClientApp;
	const screen = await render(CaboPage, { app, tourAutoOpen: false });
	await expect
		.poll(
			() =>
				screen.container
					.querySelector('[data-testid="cabo-live-previews"] [role="img"]')
					?.getAttribute('aria-label') ?? null,
			{ timeout: 10000 }
		)
		.toBe('7');
	await expect
		.element(page.getByText(m.cabo_live_previews(), { exact: true }))
		.toBeVisible();
});

for (const copy of [
	{ locale: 'pt-BR', badge: 'EM BREVE', ram: 'Modo sem flash (RAM)', hear: 'Ouvir no cabo' },
	{
		locale: 'en-US',
		badge: 'COMING SOON',
		ram: 'Flash-free mode (RAM)',
		hear: 'Hear on the cable'
	}
] as const) {
	test(`the RAM slot points to "Ouvir no cabo" on the Curva page, no EM BREVE, in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		active = createClientApp(fakeAppOptions().options);
		const screen = await render(CaboPage, { app: active, tourAutoOpen: false });
		const slot = screen.container.querySelector('[data-testid="cabo-ram-live"]');
		expect(slot).not.toBeNull();
		expect(slot?.textContent).toContain(copy.ram);
		expect(slot?.textContent).toContain(copy.hear);
		expect(slot?.textContent).not.toContain(copy.badge);
		expect(slot?.closest('.soon')).toBeNull();
		const link = slot?.querySelector('a');
		expect(link?.getAttribute('href')).toBe('/');
		expect(link?.textContent?.trim()).toBe(m.cabo_ram_live_link());
		// Read cable, firmware and blind test on the cable stay EM BREVE.
		const soon = [...screen.container.querySelectorAll('.slots .soon strong')].map(
			(node) => node.textContent
		);
		expect(soon).toEqual([m.cabo_read(), m.cabo_firmware(), m.cabo_blind()]);
	});
}

for (const copy of [
	{
		locale: 'pt-BR',
		b12: 'Uma gravação interrompida pode já estar tocando a curva nova até você desconectar e reconectar o cabo, porque os dados chegam ao cabo antes do comando de salvar.'
	},
	{
		locale: 'en-US',
		b12: 'An interrupted write may already be playing the new curve until you unplug and replug the cable, because the data reaches the cable before the save command.'
	}
] as const) {
	test(`an interrupted journal entry carries the B12 note in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		expect(m.cable_rescue_live()).toBe(copy.b12);
		const screen = await render(Journal, { entries: [entry('ok'), entry('interrupted')] });
		await expect.element(page.getByText(copy.b12, { exact: true })).toBeVisible();
		await screen.rerender({ entries: [entry('ok'), entry('simulated')] });
		expect(page.getByText(copy.b12, { exact: true }).elements()).toHaveLength(0);
	});
}
