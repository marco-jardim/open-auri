// Profile of the signed-in user for /conta: read, bio, visibility (plan §3.7, migration 0009).
// The bio is stored as plain text and must be escaped on output (Svelte text interpolation does
// it; never render it with {@html}).
import type { D1Database } from '@cloudflare/workers-types';
import { first, run, sql } from '../db.ts';
import { nextNicknameChangeAt } from './nickname.ts';

export const BIO_MAX = 280;
export const VISIBILITIES = ['private', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export function isVisibility(value: unknown): value is Visibility {
	return value === 'private' || value === 'public';
}

export interface AccountProfile {
	userId: string;
	email: string;
	/** Private account name (never public). */
	name: string;
	emailVerified: boolean;
	username: string | null;
	displayUsername: string | null;
	bio: string | null;
	activityVisibility: Visibility;
	libraryVisibility: Visibility;
	/** Epoch ms of the last nickname choice in /conta, or null. */
	usernameChangedAt: number | null;
	/** Epoch ms when the nickname may change again, or null when it may change now. */
	nextNicknameChangeAt: number | null;
	/** Epoch ms. */
	createdAt: number | null;
}

/** Epoch ms of a Better Auth DATE column (ISO string or number), or null. */
export function toEpoch(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'string' && value !== '') {
		const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	if (value instanceof Date) {
		const time = value.getTime();
		return Number.isFinite(time) ? time : null;
	}
	return null;
}

interface ProfileRow {
	id: string;
	email: string;
	name: string | null;
	emailVerified: number | boolean | null;
	username: string | null;
	displayUsername: string | null;
	bio: string | null;
	activity_visibility: string | null;
	library_visibility: string | null;
	username_changed_at: number | null;
	createdAt: string | number | null;
}

export async function getAccountProfile(
	db: D1Database,
	userId: string,
	now: number
): Promise<AccountProfile | null> {
	const row = await first<ProfileRow>(
		sql(
			db,
			'SELECT "id", "email", "name", "emailVerified", "username", "displayUsername", "bio", ' +
				'"activity_visibility", "library_visibility", "username_changed_at", "createdAt" ' +
				'FROM "user" WHERE "id" = ?',
			userId
		)
	);
	if (!row) return null;
	return {
		userId: row.id,
		email: row.email,
		name: row.name ?? '',
		emailVerified: row.emailVerified === 1 || row.emailVerified === true,
		username: row.username,
		displayUsername: row.displayUsername ?? row.username,
		bio: row.bio,
		activityVisibility: isVisibility(row.activity_visibility) ? row.activity_visibility : 'private',
		libraryVisibility: isVisibility(row.library_visibility) ? row.library_visibility : 'private',
		usernameChangedAt: row.username_changed_at,
		nextNicknameChangeAt: nextNicknameChangeAt(
			{ username: row.username, changedAt: row.username_changed_at },
			now
		),
		createdAt: toEpoch(row.createdAt)
	};
}

// C0 and C1 controls except line feed, plus bidirectional overrides and isolates (they can make
// a bio display something other than what it stores) and the BOM.
// eslint-disable-next-line no-control-regex
const STRIPPED = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Plain-text bio: NFC, CRLF/CR → LF, tabs → space, controls and bidi overrides removed, at most
 * one blank line in a row, trailing spaces of each line and outer whitespace trimmed.
 */
export function sanitizeBio(input: string): string {
	return input
		.normalize('NFC')
		.replace(/\r\n?/g, '\n')
		.replace(/\t/g, ' ')
		.replace(STRIPPED, '')
		.replace(/[ \u00A0]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Length as stored and checked by SQLite (`length()` counts code points). */
export function bioLength(value: string): number {
	return [...value].length;
}

export type BioResult = { ok: true; bio: string | null } | { ok: false; error: 'too-long' };

export async function updateBio(db: D1Database, userId: string, raw: string): Promise<BioResult> {
	const bio = sanitizeBio(typeof raw === 'string' ? raw : '');
	if (bioLength(bio) > BIO_MAX) return { ok: false, error: 'too-long' };
	const value = bio === '' ? null : bio;
	await run(
		sql(
			db,
			'UPDATE "user" SET "bio" = ?, "updatedAt" = ? WHERE "id" = ?',
			value,
			new Date().toISOString(),
			userId
		)
	);
	return { ok: true, bio: value };
}

export async function updateVisibility(
	db: D1Database,
	userId: string,
	visibility: { activity: Visibility; library: Visibility }
): Promise<void> {
	if (!isVisibility(visibility.activity) || !isVisibility(visibility.library)) {
		throw new Error('Invalid visibility');
	}
	await run(
		sql(
			db,
			'UPDATE "user" SET "activity_visibility" = ?, "library_visibility" = ?, "updatedAt" = ? ' +
				'WHERE "id" = ?',
			visibility.activity,
			visibility.library,
			new Date().toISOString(),
			userId
		)
	);
}
