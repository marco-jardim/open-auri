// Daily-salted, peppered IP hash (plan §3.8): the only form in which a client IP is used outside
// the encrypted access log. HMAC-SHA256 with key = IPHASH_PEPPER ‖ daily salt; the salt lives in
// KV under `salt:YYYY-MM-DD` (UTC day) and is deleted by the jobs Worker (rotate-salt) once the day
// is older than yesterday, after which no hash of that day can be reproduced (the pepper alone is
// not enough). The same keyed hash pseudonymises e-mail identifiers for rate-limit keys.
//
// Salt creation race: the first request of a day in two isolates may both find the key missing and
// write different salts; KV is last-writer-wins and eventually consistent (~60 s), so for a short
// time two isolates may hash the same IP differently (a rate-limit key split, never a leak).
// Mitigations: the rotation job pre-creates tomorrow's salt every day, so creation here is only a
// fallback; after writing, the value is read back (converging on what KV kept); and each isolate
// memoises a salt for at most SALT_MEMO_MS so isolates converge on KV's value.
import type { KVNamespace } from '@cloudflare/workers-types';
import { base64UrlToBytes, bytesToBase64Url, concatBytes, utcDay, utf8 } from './encoding.ts';

export const SALT_PREFIX = 'salt:';
export const SALT_BYTES = 32;
/** Backstop TTL: a salt expires on its own 3 days after its day starts (≤ 48 h after it ends). */
export const SALT_TTL_DAYS = 3;
const SALT_MEMO_MS = 5 * 60_000;
const DAY_SECONDS = 86_400;

export class InvalidIpError extends Error {
	constructor() {
		// Never include the offending value.
		super('Not a valid IPv4 or IPv6 address');
		this.name = 'InvalidIpError';
	}
}

export class SaltUnavailableError extends Error {
	constructor(options?: { cause?: unknown }) {
		super('Daily salt unavailable', options);
		this.name = 'SaltUnavailableError';
	}
}

export function saltKey(day: string): string {
	return `${SALT_PREFIX}${day}`;
}

/** Absolute KV expiration (epoch seconds) for the salt of `day`. */
export function saltExpiration(day: string): number {
	return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + SALT_TTL_DAYS * DAY_SECONDS;
}

export interface NormalizedIp {
	family: 4 | 6;
	/** Dotted quad without leading zeros, or the 8 lowercase zero-padded groups of IPv6. */
	address: string;
}

function parseIpv4(value: string): number[] | null {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
	if (!match) return null;
	const octets = match.slice(1).map(Number);
	return octets.every((octet) => octet <= 255) ? octets : null;
}

function parseIpv6Groups(value: string): number[] | null {
	let text = value;
	const tail: number[] = [];
	if (text.includes('.')) {
		// Embedded dotted quad in the last 32 bits ("::ffff:1.2.3.4", "64:ff9b::1.2.3.4").
		const lastColon = text.lastIndexOf(':');
		if (lastColon < 0) return null;
		const v4 = parseIpv4(text.slice(lastColon + 1));
		if (!v4) return null;
		const [a = 0, b = 0, c = 0, d = 0] = v4;
		tail.push((a << 8) | b, (c << 8) | d);
		text = text.slice(0, lastColon);
		// "::1.2.3.4" leaves ":" and "1::1.2.3.4" leaves "1:": restore the "::".
		if (text.endsWith(':')) text += ':';
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const parse = (part: string): number[] | null => {
		if (part === '') return [];
		const groups = part.split(':');
		const out: number[] = [];
		for (const group of groups) {
			if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
			out.push(Number.parseInt(group, 16));
		}
		return out;
	};
	const head = parse(halves[0] ?? '');
	const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
	if (!head || !rest) return null;
	const explicit = head.length + rest.length + tail.length;
	if (halves.length === 2) {
		const fill = 8 - explicit;
		if (fill < 1) return null;
		return [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
	}
	return explicit === 8 ? [...head, ...tail] : null;
}

/**
 * Canonical form of an IP address: IPv4 without leading zeros; IPv6 fully expanded in lowercase,
 * brackets and zone index removed; IPv4-mapped IPv6 (`::ffff:a.b.c.d`, any spelling) becomes the
 * IPv4 address. Returns `null` for anything else.
 */
export function normalizeIp(input: string): NormalizedIp | null {
	let value = input.trim();
	if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
	const zone = value.indexOf('%');
	if (zone >= 0) value = value.slice(0, zone);
	if (value === '' || value.length > 64) return null;

	const v4 = parseIpv4(value);
	if (v4) return { family: 4, address: v4.join('.') };
	if (!value.includes(':')) return null;

	const groups = parseIpv6Groups(value);
	if (!groups) return null;
	const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
	if (mapped) {
		const hi = groups[6] ?? 0;
		const lo = groups[7] ?? 0;
		return { family: 4, address: [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.') };
	}
	return {
		family: 6,
		address: groups.map((group) => group.toString(16).padStart(4, '0')).join(':')
	};
}

/**
 * The material that is hashed: the IPv4 address, or the IPv6 address truncated to its first
 * `ipv6Prefix` bits (default /64: one subscriber usually controls a whole /64, so hashing the full
 * address would let a client rotate rate-limit keys for free).
 */
export function ipHashMaterial(ip: NormalizedIp, ipv6Prefix: 64 | 128 = 64): string {
	if (ip.family === 4) return `4:${ip.address}`;
	if (ipv6Prefix === 128) return `6:${ip.address}`;
	return `6:${ip.address.split(':').slice(0, 4).join(':')}::/64`;
}

export interface KeyedHasher {
	/** Hash of a client IP (throws {@link InvalidIpError} for an invalid address). */
	ip(ip: string, ipv6Prefix?: 64 | 128): Promise<string>;
	/** Hash of arbitrary material under the same key (used for e-mail identifiers). */
	value(material: string): Promise<string>;
}

export interface HashKeyMaterial {
	pepper: string;
	salt: Uint8Array<ArrayBuffer>;
}

/** Imports the HMAC key once and returns hashers bound to it. Output: base64url, 43 chars. */
export async function createKeyedHasher({ pepper, salt }: HashKeyMaterial): Promise<KeyedHasher> {
	if (pepper.length === 0 || salt.length < 16) throw new SaltUnavailableError();
	const key = await crypto.subtle.importKey(
		'raw',
		concatBytes(utf8(pepper), salt),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const value = async (material: string): Promise<string> =>
		bytesToBase64Url(await crypto.subtle.sign('HMAC', key, utf8(material)));
	return {
		value,
		ip: async (ip, ipv6Prefix = 64) => {
			const normalized = normalizeIp(ip);
			if (!normalized) throw new InvalidIpError();
			return value(ipHashMaterial(normalized, ipv6Prefix));
		}
	};
}

/** `ipHash(ip, { pepper, salt })`: HMAC-SHA256(pepper ‖ salt, normalized IP), base64url. */
export async function ipHash(
	ip: string,
	options: HashKeyMaterial & { ipv6Prefix?: 64 | 128 }
): Promise<string> {
	const hasher = await createKeyedHasher(options);
	return hasher.ip(ip, options.ipv6Prefix);
}

/** True for strings shaped like an output of the keyed hasher (and therefore never a raw IP). */
export function isKeyedHash(value: string): boolean {
	return /^[A-Za-z0-9_-]{43}$/.test(value);
}

type SaltStore = Pick<KVNamespace, 'get' | 'put'>;

const memo = new WeakMap<object, Map<string, { salt: Uint8Array<ArrayBuffer>; until: number }>>();

/** Drops the per-isolate salt memo (tests, or after a manual rotation). */
export function forgetSalts(kv: object): void {
	memo.delete(kv);
}

function decodeSalt(stored: string | null): Uint8Array<ArrayBuffer> | null {
	if (stored === null) return null;
	const bytes = base64UrlToBytes(stored);
	return bytes && bytes.length === SALT_BYTES ? bytes : null;
}

/**
 * Salt of the UTC day of `date`, from CONFIG (`salt:YYYY-MM-DD`, base64url of 32 random bytes).
 * Creates it when missing (see the race note at the top of this file). Throws
 * {@link SaltUnavailableError} when KV fails: callers decide whether to fail closed.
 */
export async function getDailySalt(
	kv: SaltStore,
	date: Date = new Date()
): Promise<Uint8Array<ArrayBuffer>> {
	const day = utcDay(date);
	let days = memo.get(kv);
	if (!days) {
		days = new Map();
		memo.set(kv, days);
	}
	const cached = days.get(day);
	if (cached && cached.until > Date.now()) return cached.salt;

	try {
		const key = saltKey(day);
		let salt = decodeSalt(await kv.get(key, 'text'));
		if (!salt) {
			const fresh = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
			await kv.put(key, bytesToBase64Url(fresh), { expiration: saltExpiration(day) });
			salt = decodeSalt(await kv.get(key, 'text')) ?? fresh;
		}
		days.clear();
		days.set(day, { salt, until: Date.now() + SALT_MEMO_MS });
		return salt;
	} catch (error) {
		throw new SaltUnavailableError({ cause: error });
	}
}
