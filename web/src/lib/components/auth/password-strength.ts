// Local password-strength estimate (no library, nothing leaves the browser). Advisory only: the
// one hard rule is the server's length window (PASSWORD_MIN..PASSWORD_MAX); the meter never blocks
// a submission.
//
// Algorithm (an entropy estimate with pattern penalties, in the spirit of zxcvbn but tiny):
// 1. NFKC-normalise and split into code points.
// 2. Character pool = sum of the classes present: lowercase 26, uppercase 26, digits 10, ASCII
//    symbols and space 33, anything else 100. Each "free" character is worth log2(pool) bits.
// 3. Predictable characters are worth 1 bit instead: a repeat of the previous character, the next
//    step of an ascending/descending run (abc, 321) or of a keyboard row (qwerty, asdf, 1234).
// 4. Common passwords: after lower-casing, undoing common leet substitutions and trimming leading
//    and trailing digits/symbols, a core found in COMMON_PASSWORDS caps the estimate at
//    10 bits + 3.3 bits per character outside the core.
// 5. Personal data: every context token (e.g. the e-mail's local part) of 3+ characters found in
//    the password removes its characters' bits (minus 1 bit each).
// 6. Level from bits: < 30 → 0, < 45 → 1, < 60 → 2, < 80 → 3, otherwise 4. Under the minimum
//    length the level is 0 and `tooShort` is set.

/** Must match MIN_PASSWORD_LENGTH / MAX_PASSWORD_LENGTH in #lib/server/auth.ts (a test checks). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export type StrengthLevel = 0 | 1 | 2 | 3 | 4;
export type StrengthHint = 'length' | 'common' | 'repeat' | 'sequence' | 'personal' | 'variety';

export interface StrengthEstimate {
	level: StrengthLevel;
	/** Estimated entropy in bits (rounded to one decimal). */
	bits: number;
	/** Length in code points (entropy); the length rule uses String#length like the server. */
	length: number;
	tooShort: boolean;
	tooLong: boolean;
	hints: StrengthHint[];
}

/** Small list of the most used passwords and words (pt-BR and en-US), lower case, no leet. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
	'password',
	'passw',
	'pass',
	'senha',
	'minhasenha',
	'qwerty',
	'qwertyuiop',
	'asdf',
	'asdfgh',
	'zxcvbn',
	'abc',
	'abcd',
	'abcdef',
	'iloveyou',
	'teamo',
	'admin',
	'administrator',
	'root',
	'letmein',
	'welcome',
	'bemvindo',
	'monkey',
	'dragon',
	'master',
	'football',
	'futebol',
	'baseball',
	'superman',
	'batman',
	'princess',
	'princesa',
	'sunshine',
	'shadow',
	'trustno',
	'starwars',
	'pokemon',
	'brasil',
	'brazil',
	'flamengo',
	'corinthians',
	'palmeiras',
	'saopaulo',
	'vasco',
	'gremio',
	'santos',
	'cruzeiro',
	'botafogo',
	'fluminense',
	'internacional',
	'jesus',
	'deus',
	'amor',
	'familia',
	'mudar',
	'mudarsenha',
	'changeme',
	'secret',
	'segredo',
	'login',
	'usuario',
	'user',
	'test',
	'teste',
	'guest',
	'openauri',
	'auri',
	'kuba'
]);

const KEYBOARD_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const LEET: Readonly<Record<string, string>> = {
	'0': 'o',
	'1': 'i',
	'3': 'e',
	'4': 'a',
	'5': 's',
	'7': 't',
	'@': 'a',
	$: 's',
	'!': 'i'
};

function classOf(char: string): 'lower' | 'upper' | 'digit' | 'symbol' | 'other' {
	if (char >= 'a' && char <= 'z') return 'lower';
	if (char >= 'A' && char <= 'Z') return 'upper';
	if (char >= '0' && char <= '9') return 'digit';
	const code = char.codePointAt(0) ?? 0;
	if (code >= 0x20 && code <= 0x7e) return 'symbol';
	return 'other';
}

const POOL = { lower: 26, upper: 26, digit: 10, symbol: 33, other: 100 } as const;

function keyboardStep(previous: string, current: string): boolean {
	const a = previous.toLowerCase();
	const b = current.toLowerCase();
	return KEYBOARD_ROWS.some((row) => {
		const i = row.indexOf(a);
		const j = row.indexOf(b);
		return i !== -1 && j !== -1 && Math.abs(i - j) === 1;
	});
}

function deleet(value: string): string {
	return [...value].map((char) => LEET[char] ?? char).join('');
}

const EDGES = /^[^a-z\u00c0-\u024f]+|[^a-z\u00c0-\u024f]+$/g;

/**
 * The password's alphabetic core: lower case, edge digits/symbols trimmed, leet undone. Returns
 * the first candidate found in COMMON_PASSWORDS, else the trimmed-then-deleeted form.
 */
export function passwordCore(password: string): string {
	const lowered = password.normalize('NFKC').toLowerCase();
	const trimmed = lowered.replace(EDGES, '');
	const candidates = [trimmed, deleet(trimmed), deleet(lowered).replace(EDGES, '')];
	return candidates.find((candidate) => COMMON_PASSWORDS.has(candidate)) ?? deleet(trimmed);
}

function levelFromBits(bits: number): StrengthLevel {
	if (bits < 30) return 0;
	if (bits < 45) return 1;
	if (bits < 60) return 2;
	if (bits < 80) return 3;
	return 4;
}

/** Context tokens worth checking: the e-mail local part and its pieces (3+ characters). */
export function contextTokens(values: readonly string[]): string[] {
	const tokens = new Set<string>();
	for (const value of values) {
		const local = value.normalize('NFKC').toLowerCase().split('@', 1)[0] ?? '';
		for (const piece of [local, ...local.split(/[^a-z0-9\u00c0-\u024f]+/)]) {
			if (piece.length >= 3) tokens.add(piece);
		}
	}
	return [...tokens];
}

export function estimateStrength(
	password: string,
	context: readonly string[] = []
): StrengthEstimate {
	const chars = [...password.normalize('NFKC')];
	const length = chars.length;
	const hints = new Set<StrengthHint>();
	if (length === 0) {
		return { level: 0, bits: 0, length, tooShort: true, tooLong: false, hints: [] };
	}

	const classes = new Set(chars.map(classOf));
	const pool = [...classes].reduce((sum, name) => sum + POOL[name], 0);
	const perChar = Math.log2(Math.max(pool, 10));
	if (classes.size === 1) hints.add('variety');

	let bits = 0;
	let previousStep: number | null = null;
	for (const [index, char] of chars.entries()) {
		const previous = index > 0 ? chars[index - 1] : undefined;
		if (previous === undefined) {
			bits += perChar;
			continue;
		}
		const step = (char.codePointAt(0) ?? 0) - (previous.codePointAt(0) ?? 0);
		if (step === 0) {
			hints.add('repeat');
			bits += 1;
			previousStep = step;
			continue;
		}
		const run = Math.abs(step) === 1 && classOf(char) === classOf(previous);
		if (run || keyboardStep(previous, char)) {
			// The first step of a run is still a guess; the following ones are predictable.
			if (previousStep !== null && Math.abs(previousStep) === 1) hints.add('sequence');
			bits += previousStep !== null && Math.abs(previousStep) === 1 ? 1 : perChar / 2;
			previousStep = run ? step : 1;
			continue;
		}
		previousStep = step;
		bits += perChar;
	}

	const core = passwordCore(password);
	if (core.length >= 3 && COMMON_PASSWORDS.has(core)) {
		hints.add('common');
		bits = Math.min(bits, 10 + 3.3 * Math.max(0, length - core.length));
	}

	const lowered = password.normalize('NFKC').toLowerCase();
	for (const token of contextTokens(context)) {
		if (lowered.includes(token)) {
			hints.add('personal');
			bits = Math.max(0, bits - token.length * Math.max(0, perChar - 1));
		}
	}

	// The server counts UTF-16 code units (String#length); mirror it so the meter never disagrees.
	const tooShort = password.length < PASSWORD_MIN;
	const tooLong = password.length > PASSWORD_MAX;
	if (tooShort) hints.add('length');
	const level = tooShort ? 0 : levelFromBits(bits);
	if (!tooShort && level < 3 && length < 16) hints.add('length');
	return {
		level,
		bits: Math.round(bits * 10) / 10,
		length,
		tooShort,
		tooLong,
		hints: [...hints]
	};
}
