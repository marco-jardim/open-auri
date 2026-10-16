// Nickname rules of /conta (plan §3.7): first choice after verification, 30-day change clock,
// 90-day hold with redirect, confusables and reserved names.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	changeNickname,
	isNicknameHeld,
	listNicknameHolds,
	NICKNAME_CHANGE_INTERVAL_MS,
	NICKNAME_HOLD_MS,
	nextNicknameChangeAt,
	resolveNickname
} from '#lib/server/account/nickname.ts';
import { DAY, count, nick, seedUser } from './helpers.ts';

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

async function userRow(id: string) {
	return env.DB.prepare(
		'SELECT "username", "displayUsername", "usernameSkeleton", "username_changed_at" ' +
			'FROM "user" WHERE "id" = ?'
	)
		.bind(id)
		.first<{
			username: string | null;
			displayUsername: string | null;
			usernameSkeleton: string | null;
			username_changed_at: number | null;
		}>();
}

describe('first choice', () => {
	it('needs a verified e-mail', async () => {
		const user = await seedUser({ verified: false });
		const result = await changeNickname(env.DB, user.id, nick(), T0);
		expect(result).toEqual({ ok: false, error: 'unverified' });
		expect((await userRow(user.id))?.username).toBeNull();
	});

	it('sets nickname, display form, skeleton and starts the 30-day clock', async () => {
		const user = await seedUser();
		const chosen = `Ab${nick('x')}`;
		const result = await changeNickname(env.DB, user.id, `  ${chosen} `, T0);
		expect(result).toEqual({
			ok: true,
			username: chosen.toLowerCase(),
			displayUsername: chosen,
			kind: 'first'
		});
		const row = await userRow(user.id);
		expect(row?.username).toBe(chosen.toLowerCase());
		expect(row?.displayUsername).toBe(chosen);
		expect(row?.username_changed_at).toBe(T0);
		expect(await count('SELECT count(*) AS n FROM username_holds WHERE user_id = ?', user.id)).toBe(
			0
		);
	});

	it('rejects invalid formats and reserved names (also through confusables)', async () => {
		const user = await seedUser();
		for (const bad of ['ab', 'a'.repeat(25), 'bad name', '-start', 'end.', 'a..b', 'açaí1']) {
			expect(await changeNickname(env.DB, user.id, bad, T0)).toEqual({
				ok: false,
				error: 'invalid'
			});
		}
		for (const reserved of ['admin', 'Adm1n', 'ADMlN', '0pen-aur1', 'kuba', 'conta']) {
			expect(await changeNickname(env.DB, user.id, reserved, T0)).toEqual({
				ok: false,
				error: 'taken'
			});
		}
		expect((await userRow(user.id))?.username).toBeNull();
	});
});

describe('uniqueness by skeleton', () => {
	it('refuses a look-alike of a nickname in use', async () => {
		const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
		await seedUser({ username: `mo${hex}` });
		const other = await seedUser();
		// rn → m and 0 → o: same skeleton.
		expect(await changeNickname(env.DB, other.id, `rn0${hex}`, T0)).toEqual({
			ok: false,
			error: 'taken'
		});
		expect(await changeNickname(env.DB, other.id, `MO${hex}`, T0)).toEqual({
			ok: false,
			error: 'taken'
		});
	});

	it('a nickname held by nobody and used by nobody is free', async () => {
		const user = await seedUser();
		const name = nick('free');
		expect(await isNicknameHeld(env.DB, name, T0)).toBe(false);
		expect(await resolveNickname(env.DB, name, T0)).toBeNull();
		expect(await changeNickname(env.DB, user.id, name, T0)).toMatchObject({ ok: true });
	});
});

describe('30-day change clock', () => {
	it('a nickname set at sign-up (no clock yet) may change at once', async () => {
		const original = nick('su');
		const user = await seedUser({ username: original });
		const next = nick('nx');
		const result = await changeNickname(env.DB, user.id, next, T0);
		expect(result).toMatchObject({ ok: true, kind: 'change', username: next });
	});

	it('refuses a second change before 30 days and allows it after', async () => {
		const user = await seedUser();
		const first = nick('fa');
		await changeNickname(env.DB, user.id, first, T0);
		const second = nick('fb');
		expect(await changeNickname(env.DB, user.id, second, T0 + 29 * DAY)).toEqual({
			ok: false,
			error: 'too-soon',
			retryAt: T0 + NICKNAME_CHANGE_INTERVAL_MS
		});
		expect((await userRow(user.id))?.username).toBe(first);
		const later = await changeNickname(env.DB, user.id, second, T0 + 30 * DAY);
		expect(later).toMatchObject({ ok: true, kind: 'change', username: second });
	});

	it('case-only changes are cosmetic: allowed any time, clock and holds untouched', async () => {
		const user = await seedUser();
		const name = nick('cs');
		await changeNickname(env.DB, user.id, name, T0);
		const upper = name.toUpperCase();
		const result = await changeNickname(env.DB, user.id, upper, T0 + DAY);
		expect(result).toEqual({ ok: true, username: name, displayUsername: upper, kind: 'cosmetic' });
		const row = await userRow(user.id);
		expect(row?.displayUsername).toBe(upper);
		expect(row?.username_changed_at).toBe(T0);
		expect(await count('SELECT count(*) AS n FROM username_holds WHERE user_id = ?', user.id)).toBe(
			0
		);
		expect(await changeNickname(env.DB, user.id, upper, T0 + DAY)).toEqual({
			ok: false,
			error: 'unchanged'
		});
	});

	it('nextNicknameChangeAt', () => {
		expect(nextNicknameChangeAt({ username: null, changedAt: null }, T0)).toBeNull();
		expect(nextNicknameChangeAt({ username: 'abc', changedAt: null }, T0)).toBeNull();
		expect(nextNicknameChangeAt({ username: 'abc', changedAt: T0 }, T0 + DAY)).toBe(T0 + 30 * DAY);
		expect(nextNicknameChangeAt({ username: 'abc', changedAt: T0 }, T0 + 30 * DAY)).toBeNull();
	});
});

describe('90-day hold with redirect', () => {
	it('holds the old nickname for others, redirects it, and frees it after 90 days', async () => {
		const owner = await seedUser();
		const old = nick('od');
		const current = nick('cu');
		await changeNickname(env.DB, owner.id, old, T0);
		const changedAt = T0 + 31 * DAY;
		expect(await changeNickname(env.DB, owner.id, current, changedAt)).toMatchObject({ ok: true });

		const intruder = await seedUser();
		expect(await isNicknameHeld(env.DB, old, changedAt + DAY)).toBe(true);
		expect(await isNicknameHeld(env.DB, old, changedAt + DAY, owner.id)).toBe(false);
		expect(await changeNickname(env.DB, intruder.id, old, changedAt + DAY)).toEqual({
			ok: false,
			error: 'taken'
		});
		// Look-alike of the held name is held too.
		expect(await changeNickname(env.DB, intruder.id, old.toUpperCase(), changedAt + DAY)).toEqual({
			ok: false,
			error: 'taken'
		});
		expect(await resolveNickname(env.DB, old, changedAt + DAY)).toEqual({
			kind: 'redirect',
			to: current
		});
		expect(await resolveNickname(env.DB, current, changedAt + DAY)).toMatchObject({
			kind: 'user',
			userId: owner.id
		});
		expect(await listNicknameHolds(env.DB, owner.id, changedAt + DAY)).toEqual([
			{ username: old, releasedAt: changedAt + NICKNAME_HOLD_MS }
		]);

		const released = changedAt + NICKNAME_HOLD_MS;
		expect(await resolveNickname(env.DB, old, released)).toBeNull();
		expect(await changeNickname(env.DB, intruder.id, old, released)).toMatchObject({
			ok: true,
			kind: 'first'
		});
		expect(await resolveNickname(env.DB, old, released)).toMatchObject({
			kind: 'user',
			userId: intruder.id
		});
	});

	it('every held nickname redirects to the newest one', async () => {
		const owner = await seedUser();
		const a = nick('aa');
		const b = nick('bb');
		const c = nick('cc');
		await changeNickname(env.DB, owner.id, a, T0);
		await changeNickname(env.DB, owner.id, b, T0 + 30 * DAY);
		await changeNickname(env.DB, owner.id, c, T0 + 60 * DAY);
		const at = T0 + 61 * DAY;
		expect(await resolveNickname(env.DB, a, at)).toEqual({ kind: 'redirect', to: c });
		expect(await resolveNickname(env.DB, b, at)).toEqual({ kind: 'redirect', to: c });
	});

	it('the previous owner may take a held nickname back (after the 30 days)', async () => {
		const owner = await seedUser();
		const a = nick('ra');
		const b = nick('rb');
		await changeNickname(env.DB, owner.id, a, T0);
		await changeNickname(env.DB, owner.id, b, T0 + 30 * DAY);
		const back = await changeNickname(env.DB, owner.id, a, T0 + 60 * DAY);
		expect(back).toMatchObject({ ok: true, username: a, kind: 'change' });
		const holds = await listNicknameHolds(env.DB, owner.id, T0 + 60 * DAY);
		expect(holds.map((hold) => hold.username)).toEqual([b]);
		expect(await resolveNickname(env.DB, b, T0 + 61 * DAY)).toEqual({ kind: 'redirect', to: a });
	});
});
