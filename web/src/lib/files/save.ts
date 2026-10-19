import { m } from '#lib/paraglide/messages.js';

export type SaveFileErrorCode =
	'FILES_BAD_ARGS' | 'FILES_TOO_LARGE' | 'FILES_IO' | 'FILES_BUSY' | 'FILES_ORIGIN';

/** Native rejections retain their original code and identity. */
export interface SaveFileError extends Error {
	code: SaveFileErrorCode;
}

/** Never expose native exception text. A fallback may describe a fetch/preparation failure. */
export function saveFileErrorMessage(
	error: unknown,
	fallback: string = m.files_save_error_generic()
): string {
	const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
	switch (code) {
		case 'FILES_TOO_LARGE':
			return m.files_save_error_too_large();
		case 'FILES_BUSY':
			return m.files_save_error_busy();
		case 'FILES_IO':
			return m.files_save_error_io();
		case 'FILES_ORIGIN':
			return m.files_save_error_origin();
		case 'FILES_BAD_ARGS':
			return m.files_save_error_generic();
		default:
			return fallback;
	}
}

export interface SaveFileOptions {
	name: string;
	mime: string;
	bytes: Uint8Array | Blob | string;
	/** Preserve the browser download handoff delay of existing exporters. */
	revokeDelayMs?: number;
}

interface FilesPlugin {
	save(options: { name: string; mime: string; base64: string }): Promise<{ saved: boolean }>;
}

const NATIVE_MIMES = new Set([
	'application/json',
	'text/plain',
	'application/octet-stream',
	'image/png',
	'image/svg+xml',
	'application/gzip'
]);

/** A UI hint only. The native plugin enforces its own origin and frame guards. */
export function isAndroidApp(): boolean {
	return (
		(globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() ===
		'android'
	);
}

function base64Of(bytes: Uint8Array): string {
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
	}
	return btoa(chunks.join(''));
}

/** Save the exact bytes, using Android's document picker or the browser's download handoff. */
export async function saveFile({
	name,
	mime,
	bytes,
	revokeDelayMs = 0
}: SaveFileOptions): Promise<{ saved: boolean }> {
	if (isAndroidApp()) {
		// Never load Capacitor (which creates a global bridge) in an ordinary browser.
		const { registerPlugin } = await import('@capacitor/core');
		const files = registerPlugin<FilesPlugin>('OpenAuriFiles');
		const data =
			typeof bytes === 'string'
				? new TextEncoder().encode(bytes)
				: bytes instanceof Blob
					? new Uint8Array(await bytes.arrayBuffer())
					: bytes;
		const type = mime.split(';', 1)[0].trim().toLowerCase();
		// Do not wrap native errors: callers need the original FILES_* code.
		return files.save({
			name,
			mime: NATIVE_MIMES.has(type) ? type : 'application/octet-stream',
			base64: base64Of(data)
		});
	}

	const blob =
		bytes instanceof Blob
			? bytes
			: new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type: mime });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = name;
	anchor.rel = 'noopener';
	document.body.append(anchor);
	try {
		anchor.click();
	} finally {
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
	}
	return { saved: true };
}

/** Prefer RFC 5987's UTF-8 filename*, then the ordinary quoted or token filename. */
export function dispositionFilename(header: string | null): string | null {
	if (!header) return null;
	const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/i.exec(header);
	const fallback = (plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2]?.trim()) || null;
	const extended = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(header);
	const encoded = (extended?.[1] ?? extended?.[2] ?? '').trim();
	const utf8 = /^UTF-8'[^']*'(.*)$/i.exec(encoded);
	if (utf8) {
		try {
			const name = decodeURIComponent(utf8[1]);
			if (name) return name;
		} catch {
			// A malformed extended value must not hide a usable ordinary filename.
			return fallback;
		}
	}
	return fallback;
}
