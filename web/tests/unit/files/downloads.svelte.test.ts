import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import { saveFile } from '#lib/files/save.ts';
import type { JournalEntry } from '#lib/cable/types.ts';
import ImportExport from '#lib/components/pages/curva/ImportExport.svelte';
import { exportBin, exportS5, exportTxt } from '#lib/components/pages/curva/io.ts';
import { downloadComparison } from '#lib/components/pages/comparar/export.ts';
import { downloadBlob } from '#lib/components/pages/biblioteca/sheet-export.ts';
import Journal from '#lib/components/pages/cabo/Journal.svelte';
import SharePanel from '#lib/components/pages/comunidade/SharePanel.svelte';
import { channelOf, type FeedItem } from '#lib/components/pages/comunidade/model.ts';
import TwoFactorForm from '#lib/components/account/TwoFactorForm.svelte';
import ExportForm from '#lib/components/account/ExportForm.svelte';
import { apiWith, fakeFetch, feedItem, VERIFIED } from '../pages/comunidade/fixtures.ts';

const { nativeSave } = vi.hoisted(() => ({
	nativeSave: vi.fn().mockResolvedValue({ saved: true })
}));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ save: nativeSave }) }));
vi.mock('#lib/files/save.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('#lib/files/save.ts')>();
	return { ...original, saveFile: vi.fn(original.saveFile) };
});

const blobs: Blob[] = [];
const anchors: { name: string; href: string }[] = [];
const codes = ['aB3dE-fG4hI', 'jK5lM-nO6pQ'];
const svg =
	'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h2v2z"/></svg>';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
const channel = channelOf(feedItem() as unknown as FeedItem);

beforeEach(() => {
	blobs.length = 0;
	anchors.length = 0;
	vi.mocked(saveFile).mockClear();
	nativeSave.mockReset().mockResolvedValue({ saved: true });
	vi.stubGlobal('Capacitor', undefined);
	vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
		if (!(blob instanceof Blob)) throw new Error('Expected a file Blob');
		blobs.push(blob);
		return `blob:download-${blobs.length}`;
	});
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
		this: HTMLAnchorElement
	) {
		anchors.push({ name: this.download, href: this.href });
	});
});

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function bytesOf(bytes: Blob | Uint8Array | string): Promise<Uint8Array> {
	return typeof bytes === 'string'
		? new TextEncoder().encode(bytes)
		: bytes instanceof Blob
			? new Uint8Array(await bytes.arrayBuffer())
			: bytes;
}

async function expectSaved(
	platform: 'browser' | 'android',
	name: string,
	mime: string,
	expected: string | Uint8Array,
	index = 0
) {
	await expect.poll(() => vi.mocked(saveFile).mock.calls.length).toBe(index + 1);
	const options = vi.mocked(saveFile).mock.calls[index][0];
	expect(options.name).toBe(name);
	expect(options.mime).toBe(mime);
	const bytes = await bytesOf(options.bytes);
	expect(bytes).toEqual(await bytesOf(expected));
	if (platform === 'android') {
		await expect.poll(() => nativeSave.mock.calls.length).toBe(index + 1);
		expect(nativeSave.mock.calls[index][0]).toEqual({
			name,
			mime: mime.split(';')[0],
			base64: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
		});
		expect(anchors).toEqual([]);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	} else {
		expect(anchors[index]).toEqual({ name, href: `blob:download-${index + 1}` });
		expect(blobs[index].type).toBe(mime);
		expect(await bytesOf(blobs[index])).toEqual(bytes);
		expect(nativeSave).not.toHaveBeenCalled();
	}
}

for (const platform of ['browser', 'android'] as const) {
	function selectPlatform() {
		vi.stubGlobal('Capacitor', { getPlatform: () => (platform === 'android' ? 'android' : 'web') });
	}

	test(`Curva TXT, JSON and BIN retain their exact names and bytes (${platform})`, async () => {
		selectPlatform();
		const curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
		const notify = vi.fn();
		await render(ImportExport, {
			curve,
			name: 'Minha curva',
			source: 'custom',
			layer: 'ajustar',
			locale: 'pt-BR',
			pageUrl: new URL('https://example.test/curva'),
			now: () => 0,
			onimport: vi.fn(),
			notify
		});
		const txt = exportTxt(curve, 'ajustar', 'pt-BR');
		const json = exportS5(
			curve,
			{ name: 'Minha curva', source: 'custom', lang: 'pt-BR', now: 0 },
			'ajustar'
		);
		const bin = exportBin(curve, 'ajustar');
		if (!txt.ok || !json.ok || !bin.ok) throw new Error('Invalid export fixtures');
		for (const [index, label, ext, mime, bytes] of [
			[0, m.curva_export_txt(), 'txt', 'text/plain;charset=utf-8', txt.value],
			[1, m.curva_export_json(), 'json', 'application/json', json.value],
			[2, m.curva_export_bin(), 'bin', 'application/octet-stream', bin.value]
		] as const) {
			await page.getByRole('button', { name: label, exact: true }).click();
			await expectSaved(platform, `minha-curva.${ext}`, mime, bytes, index);
		}
		await expect.poll(() => notify.mock.calls.length).toBe(3);
	});

	test(`Comparar SVG delegates unchanged file bytes (${platform})`, async () => {
		selectPlatform();
		await downloadComparison(svg, 'svg');
		await expectSaved(platform, 'open-auri-comparar.svg', 'image/svg+xml;charset=utf-8', svg);
		expect(vi.mocked(saveFile).mock.calls[0][0].revokeDelayMs).toBe(1000);
	});

	test(`Comparar PNG delegates the rasterized PNG bytes (${platform})`, async () => {
		selectPlatform();
		// PNG rasterization also uses an object URL, independently of the download handoff.
		vi.mocked(URL.createObjectURL).mockRestore();
		await downloadComparison(svg, 'png');
		const options = vi.mocked(saveFile).mock.calls[0][0];
		expect(options).toMatchObject({ name: 'open-auri-comparar.png', mime: 'image/png' });
		const bytes = await bytesOf(options.bytes);
		expect(Array.from(bytes.slice(0, 8))).toEqual(Array.from(png.slice(0, 8)));
		if (platform === 'android') {
			expect(nativeSave.mock.calls[0][0]).toEqual({
				name: options.name,
				mime: options.mime,
				base64: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
			});
			expect(anchors).toEqual([]);
		} else {
			expect(anchors[0].name).toBe('open-auri-comparar.png');
			expect(nativeSave).not.toHaveBeenCalled();
		}
	});

	test.each([
		['open-auri-sheet.svg', 'image/svg+xml;charset=utf-8', svg],
		['open-auri-sheet.png', 'image/png', png],
		['open-auri-preset.json', 'application/json', '{"name":"ação"}\n'],
		['open-auri-reference-pack.json', 'application/json', '{"presets":[]}']
	] as const)(`Biblioteca helper saves %s unchanged (${platform})`, async (name, mime, bytes) => {
		selectPlatform();
		await downloadBlob(new Blob([bytes], { type: mime }), name);
		await expectSaved(platform, name, mime, bytes);
		expect(vi.mocked(saveFile).mock.calls[0][0].revokeDelayMs).toBe(1000);
	});

	test(`Cabo journal preserves the existing pretty JSON (${platform})`, async () => {
		selectPlatform();
		const entries: JournalEntry[] = [
			{
				schema: 1,
				at: 1000,
				name: 'Curva ação',
				device: 'simulated cable',
				bands: NEUTRO.bands.map((band) => ({ ...band })),
				preampDb: NEUTRO.preampDb,
				crc: NEUTRO.crc,
				status: 'simulated'
			}
		];
		await render(Journal, { entries });
		await page.getByRole('button', { name: m.cabo_export(), exact: true }).click();
		await expectSaved(
			platform,
			'open-auri-journal.json',
			'application/json',
			JSON.stringify(entries, null, 2)
		);
	});

	test(`TwoFactor codes retain the no-JS link and exact final newline (${platform})`, async () => {
		selectPlatform();
		await render(TwoFactorForm, {
			status: 'pending',
			feedback: {
				form: 'twoFactor',
				ok: true,
				detail: 'started',
				enrolment: { totpURI: 'otpauth://totp/test?secret=JBSWY3DPEHPK3PXP', backupCodes: codes }
			}
		});
		const link = page.getByRole('link', { name: m.conta_2fa_codes_download() });
		expect(link.element().getAttribute('href')).toBe(
			`data:text/plain;charset=utf-8,${encodeURIComponent(codes.join('\n') + '\n')}`
		);
		expect(link.element().getAttribute('download')).toBe('open-auri-recovery-codes.txt');
		await link.click();
		await expectSaved(
			platform,
			'open-auri-recovery-codes.txt',
			'text/plain;charset=utf-8',
			codes.join('\n') + '\n'
		);
	});
}

test('SharePanel keeps a plain browser download link with no fetch or saveFile', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal('fetch', fetch);
	await render(SharePanel, {
		api: apiWith(fakeFetch(() => undefined)),
		session: VERIFIED,
		channel,
		online: true
	});
	const link = page.getByRole('link', { name: m.comunidade_share_download_png() }).element();
	expect(link.getAttribute('href')).toBe(`/og/${channel.versionId}.png`);
	expect(link.hasAttribute('download')).toBe(true);
	const event = new MouseEvent('click', { bubbles: true, cancelable: true });
	event.preventDefault(); // Suppress the test browser's download, not the component handler.
	const preventDefault = vi.spyOn(event, 'preventDefault');
	link.dispatchEvent(event);
	expect(preventDefault).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
	expect(saveFile).not.toHaveBeenCalled();
});

test('SharePanel fetches the same-origin PNG and saves its exact bytes on Android', async () => {
	vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(png));
	vi.stubGlobal('fetch', fetch);
	await render(SharePanel, {
		api: apiWith(fakeFetch(() => undefined)),
		session: VERIFIED,
		channel,
		online: true
	});
	await page.getByRole('link', { name: m.comunidade_share_download_png() }).click();
	await expectSaved('android', `${channel.versionId}.png`, 'image/png', png);
	expect(fetch).toHaveBeenCalledExactlyOnceWith(`/og/${channel.versionId}.png`, {
		credentials: 'same-origin'
	});
});

test('ExportForm leaves browser submission entirely native, including without JS', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal('fetch', fetch);
	await render(ExportForm);
	const button = page.getByRole('button', { name: m.conta_export_submit() }).element();
	if (!(button instanceof HTMLButtonElement)) throw new Error('Missing export button');
	const form = button.closest('form');
	if (!form) throw new Error('Missing export form');
	expect(form.method).toBe('post');
	expect(form.getAttribute('action')).toBe('/conta/exportar');
	expect(form.hasAttribute('data-sveltekit-reload')).toBe(true);
	const event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: button });
	form.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(false);
	expect(fetch).not.toHaveBeenCalled();
	expect(saveFile).not.toHaveBeenCalled();
});

test.each([
	['attachment; filename="open-auri-export-2026-10-19.json"', 'open-auri-export-2026-10-19.json'],
	['attachment; filename=plain.json', 'plain.json'],
	[
		"attachment; filename=plain.json; filename*=UTF-8''exporta%C3%A7%C3%A3o%20conta.json",
		'exportação conta.json'
	],
	[
		"attachment; filename*=UTF-8'en'account%20export.json; filename=plain.json",
		'account export.json'
	],
	["attachment; filename*=UTF-8''bad%ZZ; filename=plain.json", 'plain.json']
])(
	'ExportForm Android POST preserves fields and attachment filename: %s',
	async (disposition, name) => {
		vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
		const text = '{"account":"ação","sections":{}}\n';
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			new Response(text, {
				headers: { 'content-type': 'application/json', 'content-disposition': disposition }
			})
		);
		vi.stubGlobal('fetch', fetch);
		await render(ExportForm);
		const button = page.getByRole('button', { name: m.conta_export_submit() });
		const form = button.element().closest('form');
		if (!form) throw new Error('Missing export form');
		const csrf = document.createElement('input');
		csrf.type = 'hidden';
		csrf.name = 'csrf';
		csrf.value = 'same-form-token';
		form.append(csrf);
		await button.click();
		await expectSaved('android', name, 'application/json', text);
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('/conta/exportar');
		expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
		expect(init?.headers).toBeUndefined(); // The browser supplies Origin and the multipart boundary.
		if (!(init?.body instanceof FormData)) throw new Error('Expected the same form fields');
		expect(Array.from(init.body.entries())).toEqual([['csrf', 'same-form-token']]);
		await expect.element(button).not.toHaveAttribute('aria-busy');
	}
);

test.each([401, 403, 500])(
	'ExportForm Android non-OK (%i) shows existing error UI and never saves',
	async (status) => {
		vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await render(ExportForm);
		const button = page.getByRole('button', { name: m.conta_export_submit() });
		await button.click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(m.conta_error_generic());
		await expect.element(button).not.toHaveAttribute('aria-busy');
		expect(saveFile).not.toHaveBeenCalled();
	}
);

test.each(['cancel', 'error'] as const)(
	'ExportForm Android native %s clears its busy state',
	async (outcome) => {
		vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('{}', {
					headers: {
						'content-disposition': 'attachment; filename="account.json"',
						'content-type': 'application/json'
					}
				})
			)
		);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		if (outcome === 'cancel') nativeSave.mockResolvedValueOnce({ saved: false });
		else
			nativeSave.mockRejectedValueOnce(
				Object.assign(new Error('Save failed'), { code: 'FILES_IO' })
			);
		await render(ExportForm);
		const button = page.getByRole('button', { name: m.conta_export_submit() });
		await button.click();
		await expect.poll(() => nativeSave.mock.calls.length).toBe(1);
		await expect.element(button).not.toHaveAttribute('aria-busy');
		if (outcome === 'cancel') expect(page.getByRole('alert').elements()).toHaveLength(0);
		else await expect.element(page.getByRole('alert')).toHaveTextContent(m.conta_error_generic());
		expect(anchors).toEqual([]);
	}
);
