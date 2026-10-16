// Profile of /conta and migration 0009: private-by-default visibility, bio sanitation and limit
// (also enforced by the database), profile read.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	BIO_MAX,
	bioLength,
	getAccountProfile,
	sanitizeBio,
	toEpoch,
	updateBio,
	updateVisibility,
	type Visibility
} from '#lib/server/account/profile.ts';
import { changeNickname } from '#lib/server/account/nickname.ts';
import { DAY, nick, seedUser } from './helpers.ts';

interface Column {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
}

describe('migration 0009', () => {
	it('adds the profile columns to "user" with private defaults', async () => {
		const { results } = await env.DB.prepare('PRAGMA table_info("user")').all<Column>();
		const byName = new Map(results.map((column) => [column.name, column]));
		expect(byName.get('bio')).toMatchObject({ type: 'TEXT', notnull: 0 });
		expect(byName.get('activity_visibility')).toMatchObject({
			type: 'TEXT',
			notnull: 1,
			dflt_value: "'private'"
		});
		expect(byName.get('library_visibility')).toMatchObject({
			type: 'TEXT',
			notnull: 1,
			dflt_value: "'private'"
		});
		expect(byName.get('username_changed_at')).toMatchObject({ type: 'INTEGER' });
	});

	it('creates username_holds, email_change_requests and account_deletion_requests', async () => {
		for (const [table, columns] of [
			['username_holds', ['skeleton', 'username', 'user_id', 'released_at', 'redirect_to']],
			['email_change_requests', ['user_id', 'new_email', 'requested_at', 'expires_at']],
			['account_deletion_requests', ['user_id', 'mode', 'requested_at']]
		] as const) {
			const { results } = await env.DB.prepare(`PRAGMA table_info("${table}")`).all<Column>();
			expect(results.map((column) => column.name)).toEqual([...columns]);
		}
	});

	it('the database refuses bad visibility values and bios over 280 characters', async () => {
		const user = await seedUser();
		const update = (query: string, value: string) =>
			env.DB.prepare(query).bind(value, user.id).run();
		await expect(
			update('UPDATE "user" SET "activity_visibility" = ? WHERE "id" = ?', 'friends')
		).rejects.toThrow();
		await expect(
			update('UPDATE "user" SET "library_visibility" = ? WHERE "id" = ?', 'everyone')
		).rejects.toThrow();
		await expect(
			update('UPDATE "user" SET "bio" = ? WHERE "id" = ?', 'x'.repeat(281))
		).rejects.toThrow();
		// 280 multi-byte characters fit: SQLite counts characters, not bytes.
		await update('UPDATE "user" SET "bio" = ? WHERE "id" = ?', 'ã'.repeat(280));
		await expect(
			env.DB.prepare(
				'INSERT INTO account_deletion_requests (user_id, mode, requested_at) VALUES (?, ?, ?)'
			)
				.bind(user.id, 'keep-some', Date.now())
				.run()
		).rejects.toThrow();
	});
});

describe('sanitizeBio', () => {
	it('keeps plain text and line breaks, drops controls and bidi overrides', () => {
		expect(sanitizeBio('  Olá,\r\nmundo\t!  ')).toBe('Olá,\nmundo !');
		expect(sanitizeBio('a\u0000b\u0007c\u007fd\u0085e')).toBe('abcde');
		expect(sanitizeBio('safe\u202Eevil\u2066x\u2069\uFEFF')).toBe('safeevilx');
		expect(sanitizeBio('one\n\n\n\n\ntwo')).toBe('one\n\ntwo');
		expect(sanitizeBio('trailing   \nspaces')).toBe('trailing\nspaces');
		expect(sanitizeBio('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
		expect(sanitizeBio('e\u0301')).toBe('é');
	});

	it('counts code points like SQLite', () => {
		expect(bioLength('🎧🎧')).toBe(2);
		expect(bioLength('abc')).toBe(3);
	});
});

describe('updateBio', () => {
	it('stores the sanitized bio up to 280 code points and clears it when empty', async () => {
		const user = await seedUser();
		expect(await updateBio(env.DB, user.id, '🎧'.repeat(BIO_MAX))).toEqual({
			ok: true,
			bio: '🎧'.repeat(BIO_MAX)
		});
		expect(await updateBio(env.DB, user.id, 'x'.repeat(BIO_MAX + 1))).toEqual({
			ok: false,
			error: 'too-long'
		});
		expect((await getAccountProfile(env.DB, user.id, Date.now()))?.bio).toBe('🎧'.repeat(BIO_MAX));
		// Controls removed before the count: this fits.
		const padded = `${'y'.repeat(BIO_MAX)}\u0000\u0000`;
		expect(await updateBio(env.DB, user.id, padded)).toEqual({
			ok: true,
			bio: 'y'.repeat(BIO_MAX)
		});
		expect(await updateBio(env.DB, user.id, '  \n ')).toEqual({ ok: true, bio: null });
		expect((await getAccountProfile(env.DB, user.id, Date.now()))?.bio).toBeNull();
	});

	it('only writes the given user', async () => {
		const me = await seedUser();
		const them = await seedUser();
		await updateBio(env.DB, them.id, 'theirs');
		await updateBio(env.DB, me.id, 'mine');
		expect((await getAccountProfile(env.DB, them.id, Date.now()))?.bio).toBe('theirs');
	});
});

describe('visibility', () => {
	it('is private by default and toggles each flag independently', async () => {
		const user = await seedUser();
		const before = await getAccountProfile(env.DB, user.id, Date.now());
		expect(before).toMatchObject({ activityVisibility: 'private', libraryVisibility: 'private' });
		await updateVisibility(env.DB, user.id, { activity: 'private', library: 'public' });
		expect(await getAccountProfile(env.DB, user.id, Date.now())).toMatchObject({
			activityVisibility: 'private',
			libraryVisibility: 'public'
		});
		await updateVisibility(env.DB, user.id, { activity: 'public', library: 'private' });
		expect(await getAccountProfile(env.DB, user.id, Date.now())).toMatchObject({
			activityVisibility: 'public',
			libraryVisibility: 'private'
		});
	});

	it('rejects values outside private/public', async () => {
		const user = await seedUser();
		const invalid: unknown = 'friends';
		await expect(
			updateVisibility(env.DB, user.id, { activity: invalid as Visibility, library: 'private' })
		).rejects.toThrow();
	});
});

describe('getAccountProfile', () => {
	it('returns the profile with the nickname clock', async () => {
		const now = Date.UTC(2026, 9, 16, 12, 0, 0);
		const user = await seedUser({ verified: true });
		const name = nick('pf');
		await changeNickname(env.DB, user.id, name, now);
		expect(await getAccountProfile(env.DB, user.id, now + DAY)).toMatchObject({
			userId: user.id,
			email: user.email,
			emailVerified: true,
			username: name,
			displayUsername: name,
			usernameChangedAt: now,
			nextNicknameChangeAt: now + 30 * DAY
		});
		expect(await getAccountProfile(env.DB, 'no-such-user', now)).toBeNull();
	});

	it('toEpoch reads ISO strings, numbers and dates', () => {
		expect(toEpoch('2026-10-16T12:00:00.000Z')).toBe(Date.UTC(2026, 9, 16, 12));
		expect(toEpoch(1_700_000_000_000)).toBe(1_700_000_000_000);
		expect(toEpoch('1700000000000')).toBe(1_700_000_000_000);
		expect(toEpoch(new Date(5))).toBe(5);
		expect(toEpoch('not a date')).toBeNull();
		expect(toEpoch(null)).toBeNull();
	});
});
