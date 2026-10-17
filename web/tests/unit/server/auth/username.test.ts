import { describe, expect, it } from 'vitest';
import { RESERVED_USERNAMES } from '#lib/server/auth/reserved.ts';
import {
	USERNAME_BLOCKLIST,
	USERNAME_BLOCKLIST_VERSION
} from '#lib/server/auth/username-blocklist.ts';
import {
	checkUsername,
	COMMON_WORD_TOKENS,
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

	it('keeps persisted uniqueness/hold keys separate from stricter moderation folding', () => {
		expect(usernameSkeleton('4dm1n')).toBe('4dmln');
		expect(usernameSkeleton('ádmín')).toBe('ádmín');
		expect(usernameSkeleton('аdmіn')).toBe('аdmіn');
		expect(usernameSkeleton('admiiin')).toBe('admllln');
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

	it('checkUsername preserves format limits and the generic reserved problem', () => {
		expect(checkUsername('ab')).toBe('invalid');
		expect(checkUsername('admin'.repeat(5))).toBe('invalid');
		expect(checkUsername('pаulo')).toBe('invalid');
		expect(checkUsername('açaí1')).toBe('invalid');
		expect(checkUsername('Admin')).toBe('reserved');
		expect(checkUsername('Paulo.Silva')).toBeNull();
	});
});

describe('nickname blocklist', () => {
	it('keeps the versioned data small, canonical and distinct from existing reservations', () => {
		expect(USERNAME_BLOCKLIST_VERSION).toBe(1);
		const entries = Object.values(USERNAME_BLOCKLIST).flatMap(({ tokens, substrings }) => [
			...tokens,
			...substrings
		]);
		const reserved = new Set(
			RESERVED_USERNAMES.map((name) => usernameSkeleton(name.replace(/[._-]/g, '')))
		);
		expect(entries.length).toBeLessThanOrEqual(200);
		expect(new Set(entries).size).toBe(entries.length);
		for (const entry of entries) {
			expect(entry).toMatch(/^[a-z]+$/);
			expect(usernameSkeleton(entry)).toBe(entry);
			expect(reserved.has(entry)).toBe(false);
			// A brand spelled like an ordinary word (chord) is accepted as that word.
			if (COMMON_WORD_TOKENS.has(entry)) {
				expect(checkUsername(entry)).toBeNull();
				continue;
			}
			expect(isReservedUsername(entry)).toBe(true);
			if (entry.length >= USERNAME_MIN) expect(checkUsername(entry)).toBe('reserved');
		}
	});

	it('refuses every category, including pt-BR and en-US slurs, with the reserved result', () => {
		const examples: Record<keyof typeof USERNAME_BLOCKLIST, readonly string[]> = {
			racism: ['nigger', 'crioulo'],
			antiLgbtq: ['faggot', 'bicha', 'tranny', 'traveco'],
			misogyny: ['bitch', 'vadia'],
			xenophobia: ['wetback', 'bolita'],
			ableism: ['retarded', 'retardado'],
			supremacy: ['nazista', 'whitepower'],
			administration: ['moderadora', 'administracao'],
			headphoneBrands: ['sennheiser', 'moondrop', '7hz', '64audio'],
			dacBrands: ['fiio', 'schiit', 'ifi', 'astellkern'],
			cableBrands: ['audioquest', 'tripowin'],
			// The plain word tidal is accepted (FUX.Q N3); the brand's leet form is not.
			audioPlatforms: ['spotify', 't1dal', 'qobuz'],
			generalBrands: ['microsoft', 'apple']
		};
		for (const names of Object.values(examples)) {
			for (const name of names) expect(checkUsername(name)).toBe(checkUsername('admin'));
		}
	});

	it('refuses authority names already maintained in reserved.ts without duplicating them', () => {
		for (const name of RESERVED_USERNAMES) {
			expect(isReservedUsername(name)).toBe(true);
			if (name.length >= USERNAME_MIN) expect(checkUsername(name)).toBe('reserved');
		}
	});

	it('format first: accented and Cyrillic/Greek look-alikes are invalid, never a list answer', () => {
		// Malformed strings never reach the list (FUX.Q N3): the answer is the one of any
		// malformed nickname. The moderation fold still recognizes them as blocked.
		for (const name of [
			'ádmín',
			'a\u0301dmi\u0301n',
			'аdmіn',
			'аԁmіո',
			'αdmιn',
			'sapatão',
			'аudіоtесhnіса'
		]) {
			expect(checkUsername(name)).toBe('invalid');
			expect(checkUsername(name)).toBe(checkUsername('bad name'));
			expect(isReservedUsername(name)).toBe(true);
		}
	});

	it('does not over-block common words and handles that only the folding made look blocked', () => {
		expect([...COMMON_WORD_TOKENS].sort()).toEqual(['chord', 'final', 'ig', 'tidal']);
		const accepted = ['ig.music', 'final', 'chord', 'tidal', 'Final.Mix', 'chord-lover', 'ig_2024'];
		for (const name of accepted) expect(checkUsername(name)).toBeNull();
		// The brands themselves, their leet forms and the real tokens stay refused.
		const refused = ['lg', 'lg123', '1g.music', 'f1nal', 't1dal', 'ch0rd', 'flnal', 'tldal'];
		for (const name of refused) {
			expect(isReservedUsername(name)).toBe(true);
			if (name.length >= USERNAME_MIN) expect(checkUsername(name)).toBe('reserved');
		}
	});

	it('refuses leet, compatibility forms and ASCII look-alikes generically', () => {
		for (const name of [
			'4dm1n',
			'Ａｄｍｉｎ',
			'm0d3r4d0r',
			'rnoderator',
			'5upp0r7',
			'0p3n-4ur1',
			'n1gg3r',
			'cr1ou10',
			'f4gg0t',
			'7r4nny',
			'b1tch',
			'r37ardad0',
			's3nnh3153r',
			's0ny',
			'f110',
			'4ud10qu357',
			'sp0t1fy',
			'g00gl3'
		]) {
			expect(checkUsername(name)).toBe('reserved');
		}
	});

	it('refuses separator/repetition evasions, whole tokens and numeric badges', () => {
		for (const name of [
			'a_d_m_i_n',
			'ad-m.in',
			'admiiin',
			'staafff',
			'm.o.d.e.r.a.d.o.r',
			's_e_n_n_h_e_i_s_e_r',
			'n.i.g.g.e.r',
			'faggggot',
			'admin123',
			'123admin',
			'007mod',
			'sony2026',
			'lg123',
			'listener_mod',
			'jbl.listener',
			'ouvinte-puta',
			'open_auri',
			'xxn1gg3rxx',
			'soundcloudfan',
			'microsoftfan'
		]) {
			expect(checkUsername(name)).toBe('reserved');
		}
	});

	it('accepts legitimate nicknames, neutral identities and substring look-alikes', () => {
		for (const name of [
			'Paulo.Silva',
			'modesto',
			'moderno',
			'commodity',
			'modelista',
			'admiral',
			'a.d.m.i.r.a.l',
			'assassin',
			'passassin',
			'passaro',
			'cassio',
			'classe',
			'classic_rock',
			'computador',
			'disputa',
			'chordata',
			'metafora',
			'appleton',
			'focalizar',
			'tidalwave',
			'fio',
			'fiiofan',
			'macacofeliz',
			'veadodocerrado',
			'aurifone',
			'autista',
			'trans',
			'gaymer',
			'queer',
			'negro',
			'preto',
			'brasileiro',
			'surdo',
			'cego',
			'staf',
			'19escuta24',
			'u123456789012',
			'c123456789012'
		]) {
			expect(checkUsername(name)).toBeNull();
		}
	});
});
