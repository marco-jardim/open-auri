import { describe, expect, it } from 'vitest';
import { RESERVED_USERNAMES } from '#lib/server/auth/reserved.ts';
import {
	checkUsername,
	isReservedUsername,
	isValidUsername,
	normalizeUsername,
	USERNAME_MAX,
	USERNAME_MIN,
	usernameSkeleton
} from '#lib/server/auth/username.ts';

describe('normalizeUsername', () => {
	it('applies NFKC, trims and lowercases', () => {
		expect(normalizeUsername('  Paulo ')).toBe('paulo');
		expect(normalizeUsername('\uff30aulo')).toBe('paulo'); // fullwidth P
		expect(normalizeUsername('ﬁlho')).toBe('filho'); // ligature
	});
});

describe('isValidUsername', () => {
	it('accepts 3 to 24 characters of [a-z0-9._-] with letters or digits at both ends', () => {
		expect(USERNAME_MIN).toBe(3);
		expect(USERNAME_MAX).toBe(24);
		for (const ok of ['abc', 'a.b', 'a_b-c', 'x1y2', 'a'.repeat(24), '123']) {
			expect(isValidUsername(ok)).toBe(true);
		}
		for (const bad of [
			'ab',
			'a'.repeat(25),
			'.abc',
			'abc-',
			'a..b',
			'a_-b',
			'a b',
			'Abc',
			'pаulo',
			'é'
		]) {
			expect(isValidUsername(bad)).toBe(false);
		}
	});
});

describe('usernameSkeleton', () => {
	it('folds ASCII look-alikes and separators', () => {
		expect(usernameSkeleton('pau1o')).toBe(usernameSkeleton('paulo'));
		expect(usernameSkeleton('PAULO')).toBe(usernameSkeleton('paulo'));
		expect(usernameSkeleton('adm1n')).toBe(usernameSkeleton('admin'));
		expect(usernameSkeleton('j0ao')).toBe(usernameSkeleton('joao'));
		expect(usernameSkeleton('modern')).toBe(usernameSkeleton('modem'));
		expect(usernameSkeleton('vvave')).toBe(usernameSkeleton('wave'));
		expect(usernameSkeleton('a.b')).toBe(usernameSkeleton('a_b'));
		expect(usernameSkeleton('a-b')).toBe(usernameSkeleton('a__b'));
		expect(usernameSkeleton('paulo')).not.toBe(usernameSkeleton('pablo'));
	});
});

describe('reserved names', () => {
	it('covers the product, staff and route names, by skeleton', () => {
		for (const name of ['admin', 'open-auri', 'auri', 'kuba', 'conta', 'privacidade']) {
			expect(RESERVED_USERNAMES).toContain(name);
			expect(isReservedUsername(name)).toBe(true);
		}
		expect(isReservedUsername('Adm1n')).toBe(true);
		expect(isReservedUsername('open_auri')).toBe(true);
		expect(isReservedUsername('0pen.aur1')).toBe(true);
		expect(isReservedUsername('paulo')).toBe(false);
	});

	it('checkUsername reports invalid before reserved', () => {
		expect(checkUsername('ab')).toBe('invalid');
		expect(checkUsername('Admin')).toBe('reserved');
		expect(checkUsername('Paulo.Silva')).toBeNull();
	});
});
