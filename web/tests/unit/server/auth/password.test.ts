// Same contract as tests/integration/auth/password.test.ts, under Node's node:crypto.
import { describe, expect, it } from 'vitest';
import {
	hashPassword,
	KEY_LENGTH,
	needsRehash,
	parsePasswordHash,
	passwordHasher,
	SALT_LENGTH,
	SCRYPT_PARAMS,
	verifyPassword
} from '#lib/server/auth/password.ts';

describe('scrypt password hash', () => {
	it('uses N=2^14, r=8, p=5, a 16-byte salt and a 64-byte key', async () => {
		expect(SCRYPT_PARAMS).toEqual({ N: 16384, r: 8, p: 5 });
		expect(SALT_LENGTH).toBe(16);
		expect(KEY_LENGTH).toBe(64);
		const hash = await hashPassword('correct horse battery 1');
		expect(hash).toMatch(/^scrypt\$16384\$8\$5\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
		const parsed = parsePasswordHash(hash);
		expect(parsed?.salt).toHaveLength(16);
		expect(parsed?.hash).toHaveLength(64);
	});

	it('round-trips through the Better Auth hasher shape', async () => {
		const hash = await passwordHasher.hash('correct horse battery 1');
		expect(await passwordHasher.verify({ hash, password: 'correct horse battery 1' })).toBe(true);
		expect(await passwordHasher.verify({ hash, password: 'correct horse battery' })).toBe(false);
		expect(needsRehash(hash)).toBe(false);
	});

	it('treats canonically equivalent passwords as equal (NFKC)', async () => {
		const hash = await hashPassword('ma\u00e7\u00e3-verde-10');
		expect(await verifyPassword({ hash, password: 'mac\u0327a\u0303-verde-10' })).toBe(true);
	});

	it('returns false for malformed hashes and non-string input', async () => {
		for (const hash of ['', 'scrypt$', 'scrypt$16384$8$5$zz$zz', 'argon2id$v=19$m=65536']) {
			expect(await verifyPassword({ hash, password: 'x' })).toBe(false);
		}
		const hash = await hashPassword('correct horse battery 1');
		expect(await verifyPassword({ hash, password: 42 as unknown as string })).toBe(false);
		await expect(hashPassword(undefined as unknown as string)).rejects.toThrow(TypeError);
	});
});
