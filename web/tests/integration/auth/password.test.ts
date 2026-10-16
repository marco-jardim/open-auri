// scrypt password hashing inside workerd (node:crypto through nodejs_compat).
import { describe, expect, it } from 'vitest';
import {
	hashPassword,
	needsRehash,
	parsePasswordHash,
	verifyPassword
} from '#lib/server/auth/password.ts';

const FORMAT = /^scrypt\$16384\$8\$5\$[0-9a-f]{32}\$[0-9a-f]{128}$/;

describe('password hash', () => {
	it('uses the versioned scrypt format with a random salt', async () => {
		const a = await hashPassword('correct horse battery 1');
		const b = await hashPassword('correct horse battery 1');
		expect(a).toMatch(FORMAT);
		expect(b).toMatch(FORMAT);
		expect(a).not.toBe(b);
		expect(needsRehash(a)).toBe(false);
	});

	it('verifies the right password and refuses a wrong one', async () => {
		const hash = await hashPassword('correct horse battery 1');
		expect(await verifyPassword({ hash, password: 'correct horse battery 1' })).toBe(true);
		expect(await verifyPassword({ hash, password: 'correct horse battery 2' })).toBe(false);
		expect(await verifyPassword({ hash, password: '' })).toBe(false);
	});

	it('normalizes with NFKC before hashing', async () => {
		const composed = 'Senha\u00e9segura10';
		const decomposed = 'Senhae\u0301segura10';
		const hash = await hashPassword(composed);
		expect(await verifyPassword({ hash, password: decomposed })).toBe(true);
		const fullwidth = await hashPassword('\uff21bcdefghij1');
		expect(await verifyPassword({ hash: fullwidth, password: 'Abcdefghij1' })).toBe(true);
	});

	it('refuses malformed or out-of-policy hashes without throwing', async () => {
		const good = await hashPassword('correct horse battery 1');
		const [, , , , salt, key] = good.split('$');
		const candidates = [
			'',
			'not-a-hash',
			'bcrypt$2b$10$abc',
			good.replace('scrypt$', 'Scrypt$'),
			good.slice(0, -2),
			`${good}00`,
			good.toUpperCase(),
			`scrypt$1024$8$5$${salt}$${key}`,
			`scrypt$16385$8$5$${salt}$${key}`,
			`scrypt$4194304$8$5$${salt}$${key}`,
			`scrypt$16384$1$5$${salt}$${key}`,
			`scrypt$16384$8$99$${salt}$${key}`,
			`scrypt$16384$8$5$${salt}$${key?.slice(0, 64)}`,
			`scrypt$16384$8$5$${salt?.slice(0, 16)}$${key}`
		];
		for (const hash of candidates) {
			expect(parsePasswordHash(hash)).toBeNull();
			expect(await verifyPassword({ hash, password: 'correct horse battery 1' })).toBe(false);
			expect(needsRehash(hash)).toBe(true);
		}
	});

	it('flags valid hashes with other parameters for rehash', async () => {
		const good = await hashPassword('correct horse battery 1');
		const [, , , , salt, key] = good.split('$');
		const stronger = `scrypt$32768$8$5$${salt}$${key}`;
		expect(parsePasswordHash(stronger)).not.toBeNull();
		expect(needsRehash(stronger)).toBe(true);
		// Same key under other parameters does not verify.
		expect(await verifyPassword({ hash: stronger, password: 'correct horse battery 1' })).toBe(
			false
		);
	});
});
