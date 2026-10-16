// Byte helpers shared by the e-mail modules. Returned arrays are backed by a plain ArrayBuffer so
// they satisfy WebCrypto's BufferSource under both lib.dom and @cloudflare/workers-types.

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(encoder.encode(text));
}

export function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Standard base64 (RFC 4648 section 4, padding optional) to bytes; null when malformed. */
export function fromBase64(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length === 0) return null;
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		return null;
	}
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
	return out;
}

export function toBase64(buffer: ArrayBuffer): string {
	let binary = '';
	for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Compares two byte arrays in time that depends only on their lengths. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}
