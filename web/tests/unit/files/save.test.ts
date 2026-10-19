import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
	dispositionFilename,
	isAndroidApp,
	saveFile,
	saveFileErrorMessage,
	type SaveFileError
} from '#lib/files/save.ts';
import { m } from '#lib/paraglide/messages.js';
import { getLocale, overwriteGetLocale } from '#lib/paraglide/runtime.js';

const { nativeSave, registerPlugin } = vi.hoisted(() => {
	const nativeSave = vi.fn().mockResolvedValue({ saved: true });
	return { nativeSave, registerPlugin: vi.fn(() => ({ save: nativeSave })) };
});
vi.mock('@capacitor/core', () => ({ registerPlugin }));

const anchor = {
	href: '',
	download: '',
	rel: '',
	click: vi.fn(),
	remove: vi.fn()
};
const createElement = vi.fn(() => anchor);
const append = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	nativeSave.mockReset().mockResolvedValue({ saved: true });
	anchor.click.mockReset();
	vi.stubGlobal('Capacitor', undefined);
	vi.stubGlobal('document', { createElement, body: { append } });
	vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test.each([0, 1000])(
	'browser clicks an exact-name anchor and revokes after the click (%i ms)',
	async (revokeDelayMs) => {
		const data = new Uint8Array([7, 0, 255, 128, 8]).subarray(1, 4);
		await expect(
			saveFile({ name: 'Ação.bin', mime: 'application/octet-stream', bytes: data, revokeDelayMs })
		).resolves.toEqual({ saved: true });
		expect(createElement).toHaveBeenCalledExactlyOnceWith('a');
		expect(append).toHaveBeenCalledExactlyOnceWith(anchor);
		expect(anchor).toMatchObject({ href: 'blob:download', download: 'Ação.bin', rel: 'noopener' });
		expect(anchor.click).toHaveBeenCalledOnce();
		expect(anchor.remove).toHaveBeenCalledOnce();
		const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0];
		if (!(blob instanceof Blob)) throw new Error('Missing download blob');
		expect(blob.type).toBe('application/octet-stream');
		expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		if (revokeDelayMs) {
			vi.advanceTimersByTime(revokeDelayMs - 1);
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
		} else vi.runAllTimers();
		expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download');
		expect(registerPlugin).not.toHaveBeenCalled();
	}
);

test('browser text is UTF-8 with unchanged line endings; a supplied Blob is handed off intact', async () => {
	const text = 'ação 🎧\r\nline\n';
	await saveFile({ name: 'codes.txt', mime: 'text/plain;charset=utf-8', bytes: text });
	const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0];
	if (!(blob instanceof Blob)) throw new Error('Missing text blob');
	expect(await blob.text()).toBe(text);
	expect(blob.type).toBe('text/plain;charset=utf-8');
	await saveFile({ name: 'same.txt', mime: blob.type, bytes: blob });
	expect(vi.mocked(URL.createObjectURL).mock.calls[1][0]).toBe(blob);
});

test('browser handoff failure still removes the anchor and revokes its URL', async () => {
	const error = new Error('click failed');
	anchor.click.mockImplementationOnce(() => {
		throw error;
	});
	await expect(saveFile({ name: 'x', mime: 'text/plain', bytes: 'x' })).rejects.toBe(error);
	expect(anchor.remove).toHaveBeenCalledOnce();
	vi.runAllTimers();
	expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
});

test.each([
	undefined,
	{},
	{ isNativePlatform: (): boolean => true },
	{ getPlatform: (): string => 'web', isNativePlatform: (): boolean => true },
	{ getPlatform: (): string => 'ios' },
	{ getPlatform: (): string => 'Android' }
])('only getPlatform() === android selects native saving: %j', async (capacitor) => {
	vi.stubGlobal('Capacitor', capacitor);
	vi.stubGlobal('androidBridge', {});
	expect(isAndroidApp()).toBe(false);
	await saveFile({ name: 'x', mime: 'text/plain', bytes: 'x' });
	expect(anchor.click).toHaveBeenCalledOnce();
	expect(registerPlugin).not.toHaveBeenCalled();
});

test.each([
	new Uint8Array([42, 0, 255, 128, 42]).subarray(1, 4),
	new Blob([new Uint8Array([0, 255, 128])])
])('Android sends binary base64 without an anchor', async (bytes) => {
	vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
	expect(isAndroidApp()).toBe(true);
	await expect(
		saveFile({ name: 'preset.bin', mime: 'application/octet-stream', bytes })
	).resolves.toEqual({ saved: true });
	expect(registerPlugin).toHaveBeenCalledExactlyOnceWith('OpenAuriFiles');
	expect(nativeSave).toHaveBeenCalledExactlyOnceWith({
		name: 'preset.bin',
		mime: 'application/octet-stream',
		base64: 'AP+A'
	});
	expect(createElement).not.toHaveBeenCalled();
	expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test('Android encodes UTF-8 text, including non-ASCII characters and a final newline', async () => {
	vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
	const text = 'ação 🎧\n';
	await saveFile({ name: 'codes.txt', mime: 'text/plain;charset=utf-8', bytes: text });
	expect(nativeSave).toHaveBeenCalledExactlyOnceWith({
		name: 'codes.txt',
		mime: 'text/plain',
		base64: Buffer.from(text).toString('base64')
	});
});

test('Android base64 encoding is safe across chunk boundaries', async () => {
	vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
	const bytes = Uint8Array.from({ length: 100003 }, (_, index) => index % 256);
	await saveFile({ name: 'large.bin', mime: 'application/octet-stream', bytes });
	expect(nativeSave.mock.calls[0][0].base64).toBe(Buffer.from(bytes).toString('base64'));
});

test.each([
	['application/json', 'application/json'],
	['text/plain', 'text/plain'],
	['application/octet-stream', 'application/octet-stream'],
	['image/png', 'image/png'],
	['image/svg+xml;charset=utf-8', 'image/svg+xml'],
	['application/gzip', 'application/gzip'],
	['text/html', 'application/octet-stream'],
	['text/csv', 'application/octet-stream'],
	['application/zip', 'application/octet-stream'],
	['', 'application/octet-stream']
])('Android maps MIME %s to %s', async (mime, expected) => {
	vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
	await saveFile({ name: 'file', mime, bytes: '' });
	expect(nativeSave.mock.calls[0][0].mime).toBe(expected);
});

test('Android cancellation is not an error', async () => {
	vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
	nativeSave.mockResolvedValueOnce({ saved: false });
	await expect(saveFile({ name: 'x', mime: 'text/plain', bytes: 'x' })).resolves.toEqual({
		saved: false
	});
});

test.each(['FILES_BAD_ARGS', 'FILES_TOO_LARGE', 'FILES_IO', 'FILES_BUSY', 'FILES_ORIGIN'])(
	'native error %s propagates unchanged',
	async (code) => {
		vi.stubGlobal('Capacitor', { getPlatform: () => 'android' });
		const error = Object.assign(new Error('Native save failed'), { code });
		nativeSave.mockRejectedValueOnce(error);
		await expect(saveFile({ name: 'x', mime: 'text/plain', bytes: 'x' })).rejects.toBe(error);
		await expect(saveFile({ name: 'x', mime: 'text/plain', bytes: 'x' })).resolves.toEqual({
			saved: true
		});
		expect(error.code).toBe(code);
	}
);

test.each(['pt-BR', 'en-US'] as const)('save errors are localized (%s)', (locale) => {
	const previous = getLocale;
	overwriteGetLocale(() => locale);
	try {
		for (const [code, message] of [
			['FILES_BAD_ARGS', m.files_save_error_generic()],
			['FILES_TOO_LARGE', m.files_save_error_too_large()],
			['FILES_IO', m.files_save_error_io()],
			['FILES_BUSY', m.files_save_error_busy()],
			['FILES_ORIGIN', m.files_save_error_origin()]
		] as const) {
			const error: SaveFileError = Object.assign(new Error('Private native details'), { code });
			expect(saveFileErrorMessage(error)).toBe(message);
			expect(saveFileErrorMessage({ code })).toBe(message);
			expect(message).not.toContain('Private native details');
		}
		expect(
			new Set([
				m.files_save_error_generic(),
				m.files_save_error_too_large(),
				m.files_save_error_io(),
				m.files_save_error_busy(),
				m.files_save_error_origin()
			]).size
		).toBe(5);
		expect(saveFileErrorMessage({ code: 'FILES_ORIGIN' })).toBe(
			locale === 'pt-BR'
				? 'Não é permitido salvar arquivos aqui.'
				: 'Saving files is not allowed here.'
		);
	} finally {
		overwriteGetLocale(previous);
	}
});

test.each([null, undefined, 'FILES_IO', {}, { code: 'UNKNOWN' }, new Error('Private details')])(
	'unknown save errors use the generic save message, never native text: %j',
	(error) => expect(saveFileErrorMessage(error)).toBe(m.files_save_error_generic())
);

test('a preparation fallback never masks a recognized native save code', () => {
	const fallback = 'Preparation failed';
	expect(saveFileErrorMessage(new Error('fetch failed'), fallback)).toBe(fallback);
	expect(saveFileErrorMessage({ code: 'FILES_BAD_ARGS' }, fallback)).toBe(
		m.files_save_error_generic()
	);
	expect(saveFileErrorMessage({ code: 'FILES_IO' }, fallback)).toBe(m.files_save_error_io());
});

test.each([
	[null, null],
	['attachment', null],
	['attachment; filename="open-auri-export-2026-10-19.json"', 'open-auri-export-2026-10-19.json'],
	['attachment; filename=plain.json', 'plain.json'],
	["attachment; filename=plain.json; filename*=UTF-8''a%C3%A7%C3%A3o.json", 'ação.json'],
	["attachment; filename*=UTF-8'en'backup%20codes.txt; filename=plain.txt", 'backup codes.txt'],
	["attachment; filename*=UTF-8''bad%ZZ; filename=plain.json", 'plain.json'],
	["attachment; filename*=ISO-8859-1''%E7.json; filename=plain.json", 'plain.json'],
	['attachment; filename="a; b.json"', 'a; b.json'],
	['attachment; filename="a\\"b.json"', 'a"b.json']
])('Content-Disposition %s resolves to %s', (header, name) => {
	expect(dispositionFilename(header)).toBe(name);
});
