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

describe('nickname blocklist', () => {
	it('refuses each category on first choice and changes exactly like a taken name', async () => {
		const taken = nick('occupied');
		await seedUser({ username: taken });
		for (const username of [null, nick('original')]) {
			const user = await seedUser({ username });
			const before = await userRow(user.id);
			const takenResult = await changeNickname(env.DB, user.id, taken, T0);
			expect(takenResult).toEqual({ ok: false, error: 'taken' });
			for (const blocked of [
				'admin',
				'n1gg3r',
				'crioulo',
				'f4gg0t',
				'tr4nny',
				'b1tch',
				'wetback',
				'bolita',
				'r37ardad0',
				'nazista',
				'moderadora',
				'4dm1n',
				'a_d_m_i_n',
				'admiiin',
				'admin123',
				'sennheiser',
				'moondrop',
				'fiio',
				'audioquest',
				'spotify',
				'microsoft'
			]) {
				expect(await changeNickname(env.DB, user.id, blocked, T0)).toEqual(takenResult);
			}
			// Format first (FUX.Q N3): a malformed look-alike of a blocked name is just invalid,
			// exactly like any malformed string, so the format answer never probes the list.
			const malformed = await changeNickname(env.DB, user.id, 'bad name', T0);
			expect(malformed).toEqual({ ok: false, error: 'invalid' });
			for (const lookAlike of ['ádmín', 'аdmіn', 'sapatão']) {
				expect(await changeNickname(env.DB, user.id, lookAlike, T0)).toEqual(malformed);
			}
			expect(await userRow(user.id)).toEqual(before);
			expect(
				await count('SELECT count(*) AS n FROM username_holds WHERE user_id = ?', user.id)
			).toBe(0);
		}
	});

	it('answers a blocked name where a taken one is answered: after the change cooldown', async () => {
		const taken = nick('occupied');
		await seedUser({ username: taken });
		const user = await seedUser({ username: nick('original') });
		const renamed = nick('renamed');
		expect(await changeNickname(env.DB, user.id, renamed, T0)).toMatchObject({
			ok: true,
			kind: 'change'
		});
		const later = T0 + DAY;
		// Inside the 30-day window a taken name is "too soon", not "taken"…
		const takenResult = await changeNickname(env.DB, user.id, taken, later);
		expect(takenResult).toEqual({
			ok: false,
			error: 'too-soon',
			retryAt: T0 + NICKNAME_CHANGE_INTERVAL_MS
		});
		// …and so is every blocked or reserved one: the answer does not reveal the list.
		for (const blocked of ['admin', 'n1gg3r', 'moderadora', 'sennheiser', 'spotify', 'lg123']) {
			expect(await changeNickname(env.DB, user.id, blocked, later)).toEqual(takenResult);
		}
		// After the window both read "taken" again.
		const after = T0 + NICKNAME_CHANGE_INTERVAL_MS + DAY;
		expect(await changeNickname(env.DB, user.id, taken, after)).toEqual({
			ok: false,
			error: 'taken'
		});
		expect(await changeNickname(env.DB, user.id, 'admin', after)).toEqual({
			ok: false,
			error: 'taken'
		});
		expect((await userRow(user.id))?.username).toBe(renamed);
	});

	it('accepts common words and short handles that only folding made look blocked', async () => {
		// Each word stays a whole token of its own; the suffix only keeps nicknames unique.
		const suffix = () => `x${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
		for (const chosen of ['final', 'chord', 'tidal', 'ig.music'].map((w) => `${w}.${suffix()}`)) {
			const user = await seedUser();
			expect(await changeNickname(env.DB, user.id, chosen, T0)).toMatchObject({
				ok: true,
				username: chosen,
				kind: 'first'
			});
		}
	});

	it('allows legitimate substring look-alikes on first choice and later changes', async () => {
		for (const first of [true, false]) {
			for (const base of ['modesto', 'computador', 'tidalwave']) {
				const user = await seedUser({ username: first ? null : nick('original') });
				const chosen = nick(base);
				expect(await changeNickname(env.DB, user.id, chosen, T0)).toMatchObject({
					ok: true,
					username: chosen,
					kind: first ? 'first' : 'change'
				});
			}
		}
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

	it('two concurrent changes: the loser gets too-soon and changes nothing', async () => {
		const user = await seedUser({ username: nick('rc') });
		const winner = nick('wi');
		const loser = nick('lo');
		// The loser reads the row, then the winner's whole change runs before the loser's batch.
		let raced = false;
		const racing = new Proxy(env.DB, {
			get(target, property) {
				if (property === 'batch') {
					return async (statements: Parameters<typeof target.batch>[0]) => {
						if (!raced) {
							raced = true;
							expect(await changeNickname(env.DB, user.id, winner, T0)).toMatchObject({
								ok: true,
								kind: 'change'
							});
						}
						return target.batch(statements);
					};
				}
				const value: unknown = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		expect(await changeNickname(racing, user.id, loser, T0)).toEqual({
			ok: false,
			error: 'too-soon',
			retryAt: T0 + NICKNAME_CHANGE_INTERVAL_MS
		});
		expect(raced).toBe(true);
		const row = await userRow(user.id);
		expect(row?.username).toBe(winner);
		expect(row?.username_changed_at).toBe(T0);
		// Only the winner's hold (the original nickname, redirecting to the winner); the loser
		// neither held anything nor touched the redirects.
		const holds = await env.DB.prepare(
			'SELECT username, redirect_to FROM username_holds WHERE user_id = ?'
		)
			.bind(user.id)
			.all<{ username: string; redirect_to: string }>();
		expect(holds.results).toHaveLength(1);
		expect(holds.results[0]?.redirect_to).toBe(winner);
		expect(await resolveNickname(env.DB, loser, T0 + DAY)).toBeNull();
	});

	it('Promise.all of two changes: exactly one wins', async () => {
		const user = await seedUser({ username: nick('pa') });
		const a = nick('pb');
		const b = nick('pc');
		const results = await Promise.all([
			changeNickname(env.DB, user.id, a, T0),
			changeNickname(env.DB, user.id, b, T0)
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toEqual([
			{ ok: false, error: 'too-soon', retryAt: T0 + NICKNAME_CHANGE_INTERVAL_MS }
		]);
		const won = results.find((result) => result.ok);
		expect((await userRow(user.id))?.username).toBe(won?.ok ? won.username : null);
		expect(await count('SELECT count(*) AS n FROM username_holds WHERE user_id = ?', user.id)).toBe(
			1
		);
	});

	it('a cosmetic change racing a real change does not overwrite it', async () => {
		const name = nick('cr');
		const user = await seedUser({ username: name });
		const next = nick('cn');
		let raced = false;
		const racing = new Proxy(env.DB, {
			get(target, property) {
				if (property === 'batch') {
					return async (statements: Parameters<typeof target.batch>[0]) => {
						if (!raced) {
							raced = true;
							await changeNickname(env.DB, user.id, next, T0);
						}
						return target.batch(statements);
					};
				}
				const value: unknown = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		expect(await changeNickname(racing, user.id, name.toUpperCase(), T0)).toEqual({
			ok: false,
			error: 'too-soon',
			retryAt: T0 + NICKNAME_CHANGE_INTERVAL_MS
		});
		const row = await userRow(user.id);
		expect(row?.username).toBe(next);
		expect(row?.displayUsername).toBe(next);
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
