// Small byte helpers shared by the security modules. Runtime-agnostic (workerd and Node): only
// TextEncoder, btoa/atob and Uint8Array.

const encoder = new TextEncoder();

/** UTF-8 bytes backed by a plain ArrayBuffer (what WebCrypto's `BufferSource` expects). */
export function utf8(value: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(encoder.encode(value));
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function bytesToBase64Url(bytes: Uint8Array | ArrayBuffer): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = '';
	for (const byte of view) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Decodes unpadded base64url; returns `null` for anything that is not base64url. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
	const padded = value.replaceAll('-', '+').replaceAll('_', '/');
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	const out = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
	return out;
}

/** UTC calendar day `YYYY-MM-DD` of `date`. */
export function utcDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}
