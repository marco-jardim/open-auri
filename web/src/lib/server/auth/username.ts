// Public nickname rules (plan §3.7): 3 to 24 characters of [a-z0-9._-] after NFKC + lowercase,
// starting and ending with a letter or digit, no two separators in a row; unique after the
// confusable skeleton; reserved and blocked names share the generic "taken" refusal.
//
// Skeleton: a reduced, ASCII-only take on UTS #39 confusable skeletons. Because the accepted
// alphabet is already ASCII after NFKC, only ASCII look-alikes matter: `0`→`o`; `1`, `i` and `l`
// fold together (stricter than UTS #39, which leaves `i` alone, so `adm1n` cannot pass for
// `admin`); `rn`→`m`, `vv`→`w`; every separator (`.`, `_`, `-`) folds to one. Non-ASCII
// look-alikes (Cyrillic `а`, Greek `ο`...) cannot be stored: the format check rejects them.
// Moderation extends this skeleton separately, without changing persisted uniqueness/hold keys.
import { RESERVED_USERNAMES } from './reserved.ts';
import { USERNAME_BLOCKLIST } from './username-blocklist.ts';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;

const FORMAT = /^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9]))*$/;

export function normalizeUsername(value: string): string {
	return value.normalize('NFKC').trim().toLowerCase();
}

/** Format check on an already normalized nickname. */
export function isValidUsername(normalized: string): boolean {
	return (
		normalized.length >= USERNAME_MIN &&
		normalized.length <= USERNAME_MAX &&
		FORMAT.test(normalized)
	);
}

/** Confusable skeleton of a nickname (normalizes first). */
export function usernameSkeleton(value: string): string {
	return normalizeUsername(value)
		.replace(/[._-]+/g, '.')
		.replace(/rn/g, 'm')
		.replace(/vv/g, 'w')
		.replace(/0/g, 'o')
		.replace(/[1il]/g, 'l');
}

// Visual Cyrillic/Greek look-alikes and common leet substitutions, for moderation only.
// Non-blocked non-ASCII input still fails FORMAT; this is not a broader nickname alphabet.
const BLOCKLIST_FOLDS: Readonly<Record<string, string>> = {
	а: 'a',
	α: 'a',
	в: 'b',
	β: 'b',
	с: 'c',
	ԁ: 'd',
	е: 'e',
	ε: 'e',
	н: 'h',
	і: 'i',
	ι: 'i',
	ј: 'j',
	к: 'k',
	κ: 'k',
	ӏ: 'l',
	м: 'm',
	ո: 'n',
	η: 'n',
	о: 'o',
	ο: 'o',
	р: 'p',
	ρ: 'p',
	ѕ: 's',
	т: 't',
	τ: 't',
	υ: 'u',
	ν: 'v',
	х: 'x',
	χ: 'x',
	у: 'y',
	'2': 'z',
	'3': 'e',
	'4': 'a',
	'5': 's',
	'6': 'g',
	'7': 't',
	'8': 'b',
	'9': 'g',
	'@': 'a',
	$: 's',
	'!': 'i',
	'|': 'l'
};

function blocklistSkeleton(value: string): string {
	const decomposed = normalizeUsername(value).normalize('NFKD').replace(/\p{M}/gu, '');
	const folded = Array.from(decomposed, (character) => BLOCKLIST_FOLDS[character] ?? character);
	return usernameSkeleton(folded.join(''));
}

// Allow extra letters, but never delete a term's inherent doubles (e.g. staff, not staf).
function repetitionPattern(skeleton: string): string {
	return skeleton.replace(
		/([a-z0-9])\1*/g,
		(run: string, letter: string) => `${letter}{${run.length},}`
	);
}

const BLOCKED_TOKENS = [
	...RESERVED_USERNAMES.map((name) => blocklistSkeleton(name.replace(/[._-]/g, ''))),
	...Object.values(USERNAME_BLOCKLIST).flatMap(({ tokens }): readonly string[] => tokens)
].map((skeleton) => ({
	pattern: new RegExp(`^${repetitionPattern(skeleton)}$`),
	// A one-letter route reservation must not turn ordinary handles like u123 into refusals.
	numbered: skeleton.length >= 2
}));

const BLOCKED_SUBSTRINGS = Object.values(USERNAME_BLOCKLIST)
	.flatMap(({ substrings }): readonly string[] => substrings)
	.map((skeleton) => new RegExp(repetitionPattern(skeleton)));

export function isReservedUsername(value: string): boolean {
	const normalized = normalizeUsername(value);
	const compact = normalized.replace(/[._-]/g, '');
	// Preserve boundaries for short/ambiguous terms; also catch a_d_m_i_n and numeric badges.
	for (const token of new Set([compact, ...normalized.split(/[._-]+/)])) {
		const skeleton = blocklistSkeleton(token);
		const unnumbered = blocklistSkeleton(token.replace(/^\d+|\d+$/g, ''));
		if (
			BLOCKED_TOKENS.some(
				({ pattern, numbered }) => pattern.test(skeleton) || (numbered && pattern.test(unnumbered))
			)
		) {
			return true;
		}
	}
	const skeleton = blocklistSkeleton(compact);
	return BLOCKED_SUBSTRINGS.some((pattern) => pattern.test(skeleton));
}

export type UsernameProblem = 'invalid' | 'reserved';

/** `null` when the nickname may be taken (uniqueness is checked against the database elsewhere). */
export function checkUsername(value: string): UsernameProblem | null {
	const normalized = normalizeUsername(value);
	if (normalized.length < USERNAME_MIN || normalized.length > USERNAME_MAX) return 'invalid';
	// Check before the alphabet so accented/confusable blocked names get the same generic error.
	if (isReservedUsername(normalized)) return 'reserved';
	if (!isValidUsername(normalized)) return 'invalid';
	return null;
}
