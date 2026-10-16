import { describe, expect, test } from 'vitest';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '#lib/server/auth.ts';
import {
	COMMON_PASSWORDS,
	PASSWORD_MAX,
	PASSWORD_MIN,
	contextTokens,
	estimateStrength,
	passwordCore
} from '#lib/components/auth/password-strength.ts';

describe('estimateStrength', () => {
	test('mirrors the server length rule', () => {
		expect(PASSWORD_MIN).toBe(MIN_PASSWORD_LENGTH);
		expect(PASSWORD_MAX).toBe(MAX_PASSWORD_LENGTH);
	});

	test('empty input lights nothing and gives no hints', () => {
		expect(estimateStrength('')).toEqual({
			level: 0,
			bits: 0,
			length: 0,
			tooShort: true,
			tooLong: false,
			hints: []
		});
	});

	test('anything under the minimum is level 0 and flagged short', () => {
		const result = estimateStrength('Zq8#vL2!x');
		expect(result.tooShort).toBe(true);
		expect(result.level).toBe(0);
		expect(result.hints).toContain('length');
	});

	test('counts length in UTF-16 units like the server', () => {
		// Five emoji = 10 code units: long enough for the server, so not "too short".
		expect(estimateStrength('\u{1F3A7}'.repeat(5)).tooShort).toBe(false);
		expect(estimateStrength('\u{1F3A7}'.repeat(4)).tooShort).toBe(true);
		expect(estimateStrength('a'.repeat(PASSWORD_MAX + 1)).tooLong).toBe(true);
	});

	test.each([
		['aaaaaaaaaaaa', 'repeat'],
		['abcdefghijkl', 'sequence'],
		['qwertyuiopas', 'sequence'],
		['1234567890123', 'sequence']
	])('%s is weak (%s)', (password, hint) => {
		const result = estimateStrength(password);
		expect(result.level).toBeLessThanOrEqual(1);
		expect(result.hints).toContain(hint);
	});

	test.each(['password123', 'P@ssw0rd2024', 'Senha12345!', 'flamengo1981', 'Qwerty!2345'])(
		'common password %s stays very weak',
		(password) => {
			const result = estimateStrength(password);
			expect(result.hints).toContain('common');
			expect(result.level).toBe(0);
		}
	);

	test('personal data from the e-mail lowers the estimate', () => {
		const plain = estimateStrength('marquinho!Rio7');
		const personal = estimateStrength('marquinho!Rio7', ['marquinho@example.com']);
		expect(personal.hints).toContain('personal');
		expect(personal.bits).toBeLessThan(plain.bits);
	});

	test('long random-looking passphrases are strong or very strong', () => {
		expect(estimateStrength('violino-tarde-cobalto-ninho').level).toBeGreaterThanOrEqual(3);
		expect(estimateStrength('K9#mZ2!vQx7@Lp4$').level).toBe(4);
	});

	test('the estimate is monotonic in added random characters', () => {
		const base = estimateStrength('Rf7!kQ2#mX').bits;
		expect(estimateStrength('Rf7!kQ2#mXv9').bits).toBeGreaterThan(base);
	});

	test('single character class gets the variety hint', () => {
		expect(estimateStrength('zlkqmvbtrwpy').hints).toContain('variety');
	});

	test('the meter never blocks: any length-valid password yields a level, no error', () => {
		for (const password of ['aaaaaaaaaa', 'password12', 'x'.repeat(PASSWORD_MAX)]) {
			const result = estimateStrength(password);
			expect(result.tooShort).toBe(false);
			expect(result.tooLong).toBe(false);
			expect([0, 1, 2, 3, 4]).toContain(result.level);
		}
	});
});

describe('helpers', () => {
	test('passwordCore trims edges and undoes leet', () => {
		expect(passwordCore('P@ssw0rd123')).toBe('password');
		expect(passwordCore('!!senha2024')).toBe('senha');
		expect(passwordCore('Fl4meng0')).toBe('flamengo');
	});

	test('contextTokens keeps the e-mail local part and its pieces', () => {
		expect(contextTokens(['ana.souza+eq@example.com'])).toEqual(['ana.souza+eq', 'ana', 'souza']);
		expect(contextTokens([''])).toEqual([]);
	});

	test('the common list is lower case and leet-free', () => {
		for (const entry of COMMON_PASSWORDS) expect(entry).toMatch(/^[a-z]+$/);
	});
});
