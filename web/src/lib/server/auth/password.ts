// Password hashing for Better Auth (`emailAndPassword.password`), decided in PF3: node:crypto
// scrypt (N=2^14, r=8, p=5, 64-byte key, 16-byte salt), about 120 ms in workerd, under the 200 ms
// CPU budget. The stored format is versioned by its parameters:
//
//   scrypt$16384$8$5$<saltHex>$<hashHex>
//
// so a later cost increase keeps old hashes verifiable (`needsRehash` tells when to upgrade).
// Passwords are NFKC-normalized before hashing (the same password typed on different keyboards or
// input methods must match). Comparison is constant time. Malformed or out-of-policy hashes never
// verify, and their parameters are bounded so a tampered row cannot make verify burn CPU/memory.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 5 } as const;
export const KEY_LENGTH = 64;
export const SALT_LENGTH = 16;
/** 128 · N · r = 16 MiB for the current parameters; leave room for the accepted maximum. */
const MAX_MEMORY = 160 * 1024 * 1024;

const FORMAT = /^scrypt\$(\d{1,7})\$(\d{1,2})\$(\d{1,2})\$([0-9a-f]{32})\$([0-9a-f]{128})$/;

export interface ScryptParams {
	N: number;
	r: number;
	p: number;
}

interface ParsedHash extends ScryptParams {
	salt: Uint8Array;
	hash: Uint8Array;
}

function isPowerOfTwo(value: number): boolean {
	return value > 1 && (value & (value - 1)) === 0;
}

/** Parameters accepted when verifying: current ones or stronger, within a fixed ceiling. */
function acceptable({ N, r, p }: ScryptParams): boolean {
	return isPowerOfTwo(N) && N >= 16_384 && N <= 131_072 && r >= 8 && r <= 16 && p >= 1 && p <= 16;
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function bytesToHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

/** Parses a stored hash; `null` for anything malformed or outside the accepted parameters. */
export function parsePasswordHash(stored: string): ParsedHash | null {
	if (typeof stored !== 'string') return null;
	const match = FORMAT.exec(stored);
	if (!match) return null;
	const [, n, r, p, salt, hash] = match;
	const params = { N: Number(n), r: Number(r), p: Number(p) };
	if (!acceptable(params)) return null;
	return { ...params, salt: hexToBytes(salt ?? ''), hash: hexToBytes(hash ?? '') };
}

function derive(password: string, salt: Uint8Array, params: ScryptParams): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		scrypt(
			password.normalize('NFKC'),
			salt,
			KEY_LENGTH,
			{ N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY },
			(error, key) => {
				if (error) reject(error);
				else resolve(new Uint8Array(key.buffer, key.byteOffset, key.byteLength));
			}
		);
	});
}

export async function hashPassword(password: string): Promise<string> {
	if (typeof password !== 'string') throw new TypeError('password must be a string');
	const salt = new Uint8Array(randomBytes(SALT_LENGTH));
	const key = await derive(password, salt, SCRYPT_PARAMS);
	const { N, r, p } = SCRYPT_PARAMS;
	return `scrypt$${N}$${r}$${p}$${bytesToHex(salt)}$${bytesToHex(key)}`;
}

/** Better Auth's `verify({ hash, password })`. Never throws on bad input: returns false. */
export async function verifyPassword({
	hash,
	password
}: {
	hash: string;
	password: string;
}): Promise<boolean> {
	if (typeof password !== 'string') return false;
	const parsed = parsePasswordHash(hash);
	if (!parsed) return false;
	let key: Uint8Array;
	try {
		key = await derive(password, parsed.salt, parsed);
	} catch {
		return false;
	}
	return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}

/** True when a valid hash uses parameters other than the current ones (rehash on next login). */
export function needsRehash(stored: string): boolean {
	const parsed = parsePasswordHash(stored);
	if (!parsed) return true;
	return (
		parsed.N !== SCRYPT_PARAMS.N || parsed.r !== SCRYPT_PARAMS.r || parsed.p !== SCRYPT_PARAMS.p
	);
}

export const passwordHasher = { hash: hashPassword, verify: verifyPassword };
