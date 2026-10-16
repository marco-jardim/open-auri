// Public nickname rules (plan §3.7): 3 to 24 characters of [a-z0-9._-] after NFKC + lowercase,
// starting and ending with a letter or digit, no two separators in a row; unique after the
// confusable skeleton; reserved names refused by skeleton too.
//
// Skeleton: a reduced, ASCII-only take on UTS #39 confusable skeletons. Because the accepted
// alphabet is already ASCII after NFKC, only ASCII look-alikes matter: `0`→`o`; `1`, `i` and `l`
// fold together (stricter than UTS #39, which leaves `i` alone, so `adm1n` cannot pass for
// `admin`); `rn`→`m`, `vv`→`w`; every separator (`.`, `_`, `-`) folds to one. Non-ASCII
// look-alikes (Cyrillic `а`, Greek `ο`...) never get this far: the format check rejects them.
import { RESERVED_USERNAMES } from './reserved.ts';

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

const RESERVED_SKELETONS = new Set(RESERVED_USERNAMES.map(usernameSkeleton));

export function isReservedUsername(value: string): boolean {
	return RESERVED_SKELETONS.has(usernameSkeleton(value));
}

export type UsernameProblem = 'invalid' | 'reserved';

/** `null` when the nickname may be taken (uniqueness is checked against the database elsewhere). */
export function checkUsername(value: string): UsernameProblem | null {
	const normalized = normalizeUsername(value);
	if (!isValidUsername(normalized)) return 'invalid';
	if (isReservedUsername(normalized)) return 'reserved';
	return null;
}
