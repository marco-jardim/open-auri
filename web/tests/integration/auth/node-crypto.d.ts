// The integration program has no @types/node (it would clash with the Workers globals), but
// web/src/lib/server/auth/password.ts uses node:crypto (nodejs_compat). Only what it uses.
declare module 'node:crypto' {
	export function randomBytes(size: number): Uint8Array;
	export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
	export function scrypt(
		password: string | ArrayBufferView,
		salt: string | ArrayBufferView,
		keylen: number,
		options: { N?: number; r?: number; p?: number; maxmem?: number },
		callback: (error: Error | null, derivedKey: Uint8Array) => void
	): void;
}
