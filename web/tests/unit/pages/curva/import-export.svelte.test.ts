import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick, type ComponentProps } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import ImportExport from '#lib/components/pages/curva/ImportExport.svelte';
import { exportS5, importTxt, readLinkHash } from '#lib/components/pages/curva/io.ts';
import type { Curve } from '#lib/components/pages/curva/model.ts';

const neutral: Curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const experimental: Curve = {
	bands: [{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }, ...NEUTRO.bands.slice(1)],
	preampDb: -1
};

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

async function setup(overrides: Partial<ComponentProps<typeof ImportExport>> = {}) {
	const download = vi.fn<(name: string, blob: Blob) => void>();
	const clipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
	const notify = vi.fn();
	const onimport = vi.fn();
	const screen = await render(ImportExport, {
		curve: neutral,
		name: 'Minha curva',
		source: 'custom',
		layer: 'ajustar',
		locale: 'pt-BR',
		pageUrl: new URL('https://example.test/?camada=ajustar#old'),
		now: () => Date.UTC(2026, 9, 16),
		download,
		clipboard,
		notify,
		onimport,
		...overrides
	});
	return { screen, download, clipboard, notify, onimport };
}

function chooseFile(container: HTMLElement, file?: File) {
	const input = container.querySelector('input[type="file"]');
	if (!(input instanceof HTMLInputElement)) throw new Error('Missing import input');
	const transfer = new DataTransfer();
	if (file) transfer.items.add(file);
	input.files = transfer.files;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	return input;
}

for (const locale of ['pt-BR', 'en-US']) {
	test(`exports TXT, JSON and binary through callbacks (${locale})`, async () => {
		const { download, notify, onimport } = await setup({ locale });
		await page.getByRole('button', { name: m.curva_export_txt(), exact: true }).click();
		await page.getByRole('button', { name: m.curva_export_json(), exact: true }).click();
		await page.getByRole('button', { name: m.curva_export_bin(), exact: true }).click();
		expect(download).toHaveBeenCalledTimes(3);
		const [txt, json, bin] = download.mock.calls;
		if (!txt || !json || !bin) throw new Error('Missing downloads');
		expect(txt[0]).toBe('minha-curva.txt');
		expect(txt[1].type).toBe('text/plain;charset=utf-8');
		expect(importTxt(await txt[1].text(), 'ajustar')).toMatchObject({
			ok: true,
			curve: { bands: NEUTRO.bands, preampDb: -0.5 }
		});
		expect(json[0]).toBe('minha-curva.json');
		expect(json[1].type).toBe('application/json');
		expect(JSON.parse(await json[1].text())).toMatchObject({
			format: 'open-auri/preset@1',
			name: 'Minha curva',
			source: 'custom',
			lang: locale,
			createdAt: '2026-10-16T00:00:00.000Z'
		});
		expect(bin[0]).toBe('minha-curva.bin');
		expect(bin[1].type).toBe('application/octet-stream');
		const bytes = new Uint8Array(await bin[1].arrayBuffer());
		expect(bytes).toHaveLength(220);
		expect([...bytes.slice(0, 4)]).toEqual([0x45, 0x51, 0x31, 0x23]);
		expect((bytes[218] ?? 0) | ((bytes[219] ?? 0) << 8)).toBe(0x4fff);
		expect(notify.mock.calls.map(([message]) => message)).toEqual(
			['txt', 'json', 'bin'].map((ext) => m.curva_exported({ name: `minha-curva.${ext}` }))
		);
		expect(onimport).not.toHaveBeenCalled();
	});
}

test.each([
	['bad.txt', 'Filter 1: ON PK Fc abc Hz Gain 1 dB Q 1', 'format'],
	['bad.json', '{"format":', 'envelope'],
	['large.txt', 'x'.repeat(65537), 'format'],
	['hs.txt', 'Preamp: -1 dB\nFilter 1: ON HS Fc 8000 Hz Gain -3 dB Q 0.7', 'experimental-layer'],
	['boost.txt', 'Preamp: 0 dB\nFilter 1: ON PK Fc 1000 Hz Gain 6 dB Q 1', 'gate']
])('refuses %s and clears the input for another attempt', async (name, text, error) => {
	const { screen, onimport, download } = await setup();
	const input = chooseFile(screen.container, new File([text], name));
	await vi.waitFor(() => expect(onimport).toHaveBeenCalledTimes(1));
	expect(onimport).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error }));
	expect(input.value).toBe('');
	expect(download).not.toHaveBeenCalled();
});

test('cancel is a no-op; valid TXT and JSON imports are delivered to the page', async () => {
	const { screen, onimport } = await setup();
	chooseFile(screen.container);
	await tick();
	expect(onimport).not.toHaveBeenCalled();
	chooseFile(screen.container, new File(['Preamp: -0.5 dB\n'], 'flat.txt'));
	await vi.waitFor(() => expect(onimport).toHaveBeenCalledTimes(1));
	expect(onimport).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, warnings: 0 }));
	const json = exportS5(
		neutral,
		{ name: 'Imported', source: 'custom', lang: 'pt-BR', now: 0 },
		'ajustar'
	);
	if (!json.ok) throw new Error('Invalid fixture');
	chooseFile(screen.container, new File([json.value], 'curve.json'));
	await vi.waitFor(() => expect(onimport).toHaveBeenCalledTimes(2));
	expect(onimport).toHaveBeenLastCalledWith(
		expect.objectContaining({ ok: true, curve: expect.objectContaining({ name: 'Imported' }) })
	);
});

test('shares/selects the link and keeps it when clipboard access fails', async () => {
	const { clipboard, notify } = await setup();
	await page.getByRole('button', { name: m.curva_share() }).click();
	expect(clipboard).toHaveBeenCalledTimes(1);
	const link = clipboard.mock.calls[0]?.[0];
	if (!link) throw new Error('Missing shared link');
	expect(new URL(link).search).toBe('?camada=ajustar');
	expect(readLinkHash(new URL(link).hash, 'ajustar')).toMatchObject({ ok: true });
	expect(notify).toHaveBeenLastCalledWith(m.curva_link_copied());
	const field = page.getByRole('textbox', { name: m.curva_link_field() });
	await expect.element(field).toHaveValue(link);
	const input = field.element();
	if (!(input instanceof HTMLInputElement)) throw new Error('Missing link field');
	input.dispatchEvent(new FocusEvent('focus'));
	expect(input.selectionStart).toBe(0);
	expect(input.selectionEnd).toBe(link.length);
	clipboard.mockRejectedValueOnce(new Error('denied'));
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await page.getByRole('button', { name: m.curva_share() }).click();
	await vi.waitFor(() =>
		expect(notify).toHaveBeenLastCalledWith(m.curva_link_copy_failed(), 'error')
	);
	await expect.element(field).toHaveValue(link);
	expect(warn).toHaveBeenCalledWith('Clipboard refused', expect.any(Error));
});

test('Ajustar refuses experimental exports and erases an earlier link', async () => {
	const { screen, download, clipboard, notify } = await setup();
	await page.getByRole('button', { name: m.curva_share() }).click();
	await expect.element(page.getByRole('textbox')).toBeVisible();
	await screen.rerender({ curve: experimental });
	for (const name of [m.curva_export_txt(), m.curva_export_json(), m.curva_share()]) {
		await page.getByRole('button', { name, exact: true }).click();
		expect(notify).toHaveBeenLastCalledWith(
			m.curva_export_refused({ reason: m.curva_io_error_experimental() }),
			'error'
		);
	}
	expect(download).not.toHaveBeenCalled();
	expect(clipboard).toHaveBeenCalledTimes(1);
	await expect.element(page.getByRole('textbox')).not.toBeInTheDocument();
});

test('off-grid JSON/link and a gate-refused binary never reach a download callback', async () => {
	const { screen, download, clipboard, notify } = await setup({
		curve: { ...neutral, preampDb: -0.55 }
	});
	for (const name of [m.curva_export_json(), m.curva_share()]) {
		await page.getByRole('button', { name, exact: true }).click();
		expect(notify).toHaveBeenLastCalledWith(
			m.curva_export_refused({ reason: m.curva_io_error_grid() }),
			'error'
		);
	}
	await screen.rerender({ curve: { ...neutral, preampDb: 1 } });
	await page.getByRole('button', { name: m.curva_export_bin(), exact: true }).click();
	expect(notify).toHaveBeenLastCalledWith(expect.any(String), 'error');
	expect(download).not.toHaveBeenCalled();
	expect(clipboard).not.toHaveBeenCalled();
});

test('disabled import/export controls say why and do nothing (T8)', async () => {
	const { screen, download, clipboard, onimport, notify } = await setup({ disabled: true });
	for (const name of [
		m.curva_export_txt(),
		m.curva_export_json(),
		m.curva_export_bin(),
		m.curva_share()
	]) {
		const button = page.getByRole('button', { name, exact: true });
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
		await expect.element(button).toHaveAccessibleDescription(m.curva_v2_loading_reason());
		// A DOM click, so an open reason tooltip never intercepts the next press.
		const element = button.element();
		if (element instanceof HTMLElement) element.click();
	}
	const file = screen.container.querySelector('input[type="file"]');
	expect(file).toHaveProperty('disabled', true);
	expect(file?.getAttribute('aria-describedby')).toBeTruthy();
	expect(screen.container.textContent).toContain(m.curva_v2_loading_reason());
	expect(notify).not.toHaveBeenCalled();
	await screen.rerender({ disabled: true, disabledReason: 'Custom reason' });
	await expect
		.element(page.getByRole('button', { name: m.curva_export_bin(), exact: true }))
		.toHaveAccessibleDescription('Custom reason');
	expect(download).not.toHaveBeenCalled();
	expect(clipboard).not.toHaveBeenCalled();
	expect(onimport).not.toHaveBeenCalled();
});
