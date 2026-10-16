import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { bytesToBase64Url, utcDay } from '#lib/server/security/encoding.ts';
import {
	forgetSalts,
	getDailySalt,
	ipHash,
	isKeyedHash,
	normalizeIp,
	saltExpiration,
	saltKey
} from '#lib/server/security/iphash.ts';

const pepper = env.IPHASH_PEPPER;
// KV rejects past expirations: days are relative to the real clock.
const today = new Date();
const tomorrow = new Date(today.getTime() + 86_400_000);

afterEach(async () => {
	forgetSalts(env.CONFIG);
	await env.CONFIG.delete(saltKey(utcDay(today)));
	await env.CONFIG.delete(saltKey(utcDay(tomorrow)));
});

describe('normalizeIp', () => {
	it('canonicalises IPv4, IPv6 and IPv4-mapped addresses', () => {
		expect(normalizeIp('203.0.113.009')).toEqual({ family: 4, address: '203.0.113.9' });
		expect(normalizeIp('::ffff:203.0.113.9')).toEqual({ family: 4, address: '203.0.113.9' });
		expect(normalizeIp('::FFFF:cb00:7109')).toEqual({ family: 4, address: '203.0.113.9' });
		expect(normalizeIp('[2001:DB8::1]')).toEqual({
			family: 6,
			address: '2001:0db8:0000:0000:0000:0000:0000:0001'
		});
		expect(normalizeIp('fe80::1%eth0')?.address).toBe('fe80:0000:0000:0000:0000:0000:0000:0001');
		expect(normalizeIp('2001:db8:0:0:0:0:0:1')).toEqual(normalizeIp('2001:db8::1'));
		expect(normalizeIp('64:ff9b::192.0.2.33')?.address).toBe(
			'0064:ff9b:0000:0000:0000:0000:c000:0221'
		);
	});

	it('rejects malformed input', () => {
		for (const bad of [
			'',
			'256.1.1.1',
			'1.2.3',
			'1::2::3',
			'12345::',
			'gggg::1',
			'x',
			':1.2.3.4'
		]) {
			expect(normalizeIp(bad)).toBeNull();
		}
	});
});

describe('ipHash', () => {
	it('is a keyed base64url HMAC, equal for equivalent spellings and never the raw IP', async () => {
		const salt = await getDailySalt(env.CONFIG, today);
		const a = await ipHash('203.0.113.9', { pepper, salt });
		expect(isKeyedHash(a)).toBe(true);
		expect(a).not.toContain('203');
		expect(await ipHash('::ffff:203.0.113.9', { pepper, salt })).toBe(a);
		expect(await ipHash('203.0.113.10', { pepper, salt })).not.toBe(a);
		expect(await ipHash('203.0.113.9', { pepper: `${pepper}x`, salt })).not.toBe(a);
	});

	it('groups an IPv6 /64 by default and can hash the full address', async () => {
		const salt = await getDailySalt(env.CONFIG, today);
		const one = await ipHash('2001:db8:1:2::1', { pepper, salt });
		const two = await ipHash('2001:db8:1:2:ffff::9', { pepper, salt });
		expect(one).toBe(two);
		expect(await ipHash('2001:db8:1:3::1', { pepper, salt })).not.toBe(one);
		expect(await ipHash('2001:db8:1:2::1', { pepper, salt, ipv6Prefix: 128 })).not.toBe(
			await ipHash('2001:db8:1:2:ffff::9', { pepper, salt, ipv6Prefix: 128 })
		);
	});

	it('throws without echoing an invalid address', async () => {
		const salt = await getDailySalt(env.CONFIG, today);
		await expect(ipHash('not-an-ip-secret', { pepper, salt })).rejects.toThrow(
			/^Not a valid IPv4 or IPv6 address$/
		);
	});
});

describe('daily salt', () => {
	it('creates the salt once per day in CONFIG with an absolute expiration', async () => {
		const salt = await getDailySalt(env.CONFIG, today);
		expect(salt).toHaveLength(32);
		forgetSalts(env.CONFIG);
		expect(await getDailySalt(env.CONFIG, today)).toEqual(salt);
		const listed = await env.CONFIG.list({ prefix: saltKey(utcDay(today)) });
		expect(listed.keys[0]?.expiration).toBe(saltExpiration(utcDay(today)));
	});

	it('changes the hash across days', async () => {
		const day1 = await ipHash('203.0.113.9', {
			pepper,
			salt: await getDailySalt(env.CONFIG, today)
		});
		const day2 = await ipHash('203.0.113.9', {
			pepper,
			salt: await getDailySalt(env.CONFIG, tomorrow)
		});
		expect(day2).not.toBe(day1);
	});

	it('makes old hashes irreproducible once the rotation job deleted the salt', async () => {
		const before = await ipHash('203.0.113.9', {
			pepper,
			salt: await getDailySalt(env.CONFIG, today)
		});
		// What workers/jobs rotate-salt does to a day older than yesterday.
		await env.CONFIG.delete(saltKey(utcDay(today)));
		forgetSalts(env.CONFIG);
		const after = await ipHash('203.0.113.9', {
			pepper,
			salt: await getDailySalt(env.CONFIG, today)
		});
		expect(after).not.toBe(before);
	});

	it('uses a salt pre-created by the rotation job instead of creating one', async () => {
		const preset = new Uint8Array(32).fill(7);
		await env.CONFIG.put(saltKey(utcDay(tomorrow)), bytesToBase64Url(preset));
		expect(await getDailySalt(env.CONFIG, tomorrow)).toEqual(preset);
	});

	it('reports KV failures as SaltUnavailableError (callers fail closed)', async () => {
		const broken = {
			get: () => Promise.reject(new Error('kv down')),
			put: () => Promise.reject(new Error('kv down'))
		};
		await expect(getDailySalt(broken, new Date('2030-01-01T00:00:00Z'))).rejects.toMatchObject({
			name: 'SaltUnavailableError'
		});
	});
});
