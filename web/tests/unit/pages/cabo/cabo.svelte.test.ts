import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import type { JournalEntry } from '#lib/cable/types.ts';
import CaboPage from '#lib/components/pages/cabo/CaboPage.svelte';
import Journal from '#lib/components/pages/cabo/Journal.svelte';
import FlashCounters from '#lib/components/pages/cabo/FlashCounters.svelte';
import TransportTape from '#lib/components/pages/cabo/TransportTape.svelte';
import { fakeAppOptions } from '../../app/fakes.ts';
import CaboHarness from './CaboHarness.svelte';

let active: ClientApp | null = null;

afterEach(async () => {
	await cleanup();
	active?.dispose();
	active = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
});

for (const copy of [
	{
		locale: 'pt-BR',
		title: 'Cabo',
		read: 'Ler configuração do cabo',
		firmware: 'Versão do firmware',
		ram: 'Modo sem flash (RAM)',
		blind: 'Teste cego no cabo',
		badge: 'EM BREVE'
	},
	{
		locale: 'en-US',
		title: 'Cable',
		read: 'Read cable configuration',
		firmware: 'Firmware version',
		ram: 'Flash-free mode (RAM)',
		blind: 'Blind test on the cable',
		badge: 'COMING SOON'
	}
] as const) {
	test(`complete rack and four reserved features, accessible at desktop and mobile in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		active = createClientApp(fakeAppOptions().options);
		const screen = await render(CaboPage, { app: active });
		await expect
			.element(page.getByRole('heading', { name: copy.title, exact: true }))
			.toBeVisible();
		expect(screen.container.querySelectorAll('section.unit')).toHaveLength(8);
		for (const title of [copy.read, copy.firmware, copy.ram, copy.blind]) {
			await expect.element(page.getByText(title, { exact: true }).last()).toBeVisible();
		}
		expect(page.getByText(copy.badge, { exact: true }).elements()).toHaveLength(4);
		for (const width of [1440, 390]) {
			await page.viewport(width, 1000);
			const { violations } = await axe.run(screen.container);
			expect(
				violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
			).toEqual([]);
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
		}
	}, 20000);
}

test('HID picker only on a click; only final confirmation in the shared checklist sends bytes', async () => {
	await setLocale('pt-BR', { reload: false });
	const fake = fakeAppOptions();
	fake.time.value = Date.now();
	fake.local.setItem('oa.flash.lastWriteAt', String(fake.time.value - 5000));
	active = createClientApp(fake.options);
	const requestDevice = vi.spyOn(fake.hid, 'requestDevice');
	const connect = vi.spyOn(active.cable, 'connect');
	const write = vi.spyOn(active.cable, 'write');
	const gesture = vi.spyOn(active.cable, 'createGesture');
	const requestWrite = vi.spyOn(active, 'requestWrite');
	const screen = await render(CaboHarness, { app: active });
	expect(connect).not.toHaveBeenCalled();
	expect(requestDevice).not.toHaveBeenCalled();
	expect(fake.device.sent).toHaveLength(0);
	await page.getByRole('button', { name: 'Conectar via WebHID real' }).click();
	expect(connect).toHaveBeenCalledOnce();
	expect(requestDevice).toHaveBeenCalledOnce();
	expect(fake.device.sent).toHaveLength(0);
	await page.getByRole('button', { name: 'Levantar tampa do checklist' }).click();
	await page.getByRole('button', { name: 'Revisar e gravar' }).click();
	expect(requestWrite).toHaveBeenCalledOnce();
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await expect
		.element(page.getByRole('dialog').getByRole('button', { name: 'Gravar no cabo', exact: true }))
		.toBeDisabled();
	expect(write).not.toHaveBeenCalled();
	expect(gesture).not.toHaveBeenCalled();
	expect(fake.device.sent).toHaveLength(0);
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('checkbox').nth(0).click();
	await dialog.getByRole('checkbox').nth(1).click();
	expect(write).not.toHaveBeenCalled();
	await dialog.getByRole('button', { name: 'Gravar no cabo', exact: true }).click();
	await expect.poll(() => active?.cableState.lastOutcome?.status).toBe('ok');
	expect(write).toHaveBeenCalledOnce();
	expect(gesture).toHaveBeenCalledOnce();
	expect(fake.device.sent).toHaveLength(10);
	expect(active.state.journal.entries).toHaveLength(1);
	expect(active.state.flash.state.session).toBe(1);
	expect(active.state.flash.state.total).toBe(1);
	expect(active.state.flash.state.day.count).toBe(1);
	await expect
		.poll(() =>
			[...screen.container.querySelectorAll('.counters [role="img"]')].map((node) =>
				node.getAttribute('aria-label')
			)
		)
		.toEqual(['1', '1', '1']);
});

test('simulated mode: rack counters are the checklist counters, real flash stays untouched', async () => {
	await setLocale('pt-BR', { reload: false });
	const fake = fakeAppOptions();
	active = createClientApp({ ...fake.options, cable: { ...fake.options.cable, hid: null } });
	const app = active;
	const screen = await render(CaboHarness, { app });
	const drums = () =>
		[...screen.container.querySelectorAll('.counters [role="img"]')].map((node) =>
			node.getAttribute('aria-label')
		);
	const checklistCounters = () =>
		app.cable.checklist({
			bands: app.state.curve.current.bands,
			preampDb: app.state.curve.current.preampDb,
			experimental: false,
			confirmations: { volumeLowered: false, keepConnected: false, experimental: false }
		}).counters;
	await expect.poll(drums).toEqual(['0', '0', '0']);
	expect(app.cable.counters()).toEqual(checklistCounters());
	await app.cable.connect();
	await page.getByRole('button', { name: 'Levantar tampa do checklist' }).click();
	await page.getByRole('button', { name: 'Revisar e gravar' }).click();
	const dialog = page.getByRole('dialog');
	await expect.element(dialog).toBeVisible();
	await dialog.getByRole('checkbox').nth(0).click();
	await dialog.getByRole('checkbox').nth(1).click();
	await dialog.getByRole('button', { name: m.cable_write_simulated(), exact: true }).click();
	await expect.poll(() => app.cableState.lastOutcome?.status).toBe('simulated');
	const expected = checklistCounters();
	expect(expected).toEqual({ session: 1, day: 1, total: 1 });
	expect(app.cable.counters()).toEqual(expected);
	await expect
		.poll(drums)
		.toEqual([String(expected.session), String(expected.day), String(expected.total)]);
	// Simulated writes never touch the real flash bookkeeping.
	expect(app.state.flash.state).toMatchObject({ session: 0, total: 0 });
	expect(fake.device.sent).toHaveLength(0);
});

test('preset selection, rehearsal and journal loading never request a write or connect', async () => {
	await setLocale('pt-BR', { reload: false });
	const fake = fakeAppOptions();
	active = createClientApp(fake.options);
	const requestWrite = vi.spyOn(active, 'requestWrite');
	const connect = vi.spyOn(active.cable, 'connect');
	active.state.journal.append({
		schema: 1,
		at: fake.time.value,
		name: 'Saved curve',
		crc: NEUTRO.crc,
		bands: NEUTRO.bands.map((band) => ({ ...band })),
		preampDb: NEUTRO.preampDb,
		status: 'simulated',
		device: 'simulated cable'
	});
	await render(CaboPage, { app: active });
	await page.getByRole('combobox').selectOptions(PADRAO_AURI.id);
	expect(active.state.curve.current.bands).toEqual(PADRAO_AURI.bands);
	const byteWindows = page.getByRole('textbox').elements();
	expect(byteWindows).toHaveLength(4);
	for (const byteWindow of byteWindows) expect(byteWindow.hasAttribute('readonly')).toBe(true);
	await page.getByRole('button', { name: 'Ensaiar (não grava)' }).click();
	await page.getByRole('button', { name: 'Carregar no editor (não grava)' }).click();
	expect(active.state.curve.current.name).toBe('Saved curve');
	expect(requestWrite).not.toHaveBeenCalled();
	expect(connect).not.toHaveBeenCalled();
	expect(fake.device.sent).toHaveLength(0);
	expect(active.state.journal.entries).toHaveLength(1);
	expect(active.state.flash.state.total).toBe(0);
});

test('journal escapes untrusted names and devices, and distinguishes every status', async () => {
	await setLocale('pt-BR', { reload: false });
	const names = ['<img src=x onerror="throw 1">', '<script>alert(1)</script>', 'A & B'];
	const entries: JournalEntry[] = (['ok', 'interrupted', 'simulated'] as const).map(
		(status, index) => ({
			schema: 1,
			at: 1000 + index,
			name: names[index],
			device: '<svg onload=alert(1)>',
			bands: NEUTRO.bands.map((band) => ({ ...band })),
			preampDb: NEUTRO.preampDb,
			crc: NEUTRO.crc,
			status
		})
	);
	const onload = vi.fn();
	const screen = await render(Journal, { entries, onload });
	for (const name of names)
		await expect.element(page.getByRole('heading', { name, exact: true })).toBeVisible();
	expect(screen.container.querySelectorAll('img, script, svg[onload]')).toHaveLength(0);
	expect(screen.container.querySelectorAll('.mini svg')).toHaveLength(3);
	expect(screen.container.querySelectorAll('.card[data-status]')).toHaveLength(3);
	await page.getByRole('button', { name: 'Carregar no editor (não grava)' }).first().click();
	expect(onload).toHaveBeenCalledWith(entries[2]);
});

test('mechanical counters expose all significant digits and the daily advisory', async () => {
	await setLocale('pt-BR', { reload: false });
	const screen = await render(FlashCounters, { counters: { session: 3, day: 51, total: 123456 } });
	expect(
		[...screen.container.querySelectorAll('.drums[role="img"]')].map((node) =>
			node.getAttribute('aria-label')
		)
	).toEqual(['3', '51', '123456']);
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent('50 ou mais tentativas hoje. Considere ensaiar antes da próxima gravação.');
	expect(screen.container.querySelectorAll('.drums')[2].textContent).toBe('123456');
});

test('rehearsal is labeled, has ten inspectable reports and offers ×10 without claiming a commit', async () => {
	await setLocale('pt-BR', { reload: false });
	const screen = await render(TransportTape, { curve: NEUTRO });
	await page.getByRole('checkbox', { name: 'Câmera lenta ×10' }).click();
	await page.getByRole('button', { name: 'Ensaiar (não grava)' }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent('ENSAIO · nada foi gravado');
	expect(screen.container.querySelectorAll('.reports button')).toHaveLength(10);
	await page.getByRole('button', { name: 'Commit', exact: true }).click();
	expect(screen.container.querySelector('pre')?.textContent).toMatch(/^01 65 00 01 FF/);
	expect(screen.container.querySelectorAll('.accepted')).toHaveLength(0);
});
