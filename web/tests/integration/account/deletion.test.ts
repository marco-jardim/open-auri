// Account closure with the content-deletion policy (T3.7): the mode chosen in /conta is recorded,
// Better Auth's beforeDelete runs the policy in one batch when the mailed link is opened, both
// modes delete every private row, 'anonymize' keeps the nickname held without an owner, and
// other users' rows are never touched. T4.1 extends these tests with the social tables.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';
import {
	accountDeletionHook,
	createContentDeletionPolicy,
	readDeletionRequest,
	recordDeletionRequest,
	ACCOUNT_DELETION_PARTS,
	type DeletionMode,
	type DeletionPart
} from '#lib/server/account/deletion.ts';
import { requestAccountClosure } from '#lib/server/account/auth-actions.ts';
import { recordEmailChangeRequest } from '#lib/server/account/email-change.ts';
import { changeNickname, NICKNAME_HOLD_MS, resolveNickname } from '#lib/server/account/nickname.ts';
import { batch, sql } from '#lib/server/db.ts';
import { recordAcceptance } from '#lib/server/legal/acceptance.ts';
import {
	createVerifiedUser,
	Harness,
	linkOf,
	mockNetwork,
	PASSWORD,
	signedIn,
	uniqueEmail
} from '../auth/harness.ts';
import { DAY, count, nick, seedUser } from './helpers.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

function harness(): Harness {
	network.resetHandlers();
	mockNetwork(network);
	return new Harness({}, { beforeDeleteUser: accountDeletionHook({ db: env.DB }) });
}

interface Fixture {
	id: string;
	email: string;
	current: string;
	old: string;
}

/** Verified user with a previous nickname on hold, an acceptance and a pending e-mail change. */
async function fixture(h: Harness, prefix: string): Promise<Fixture> {
	const email = uniqueEmail(prefix);
	const old = nick('o');
	const id = await createVerifiedUser(h, email, { username: old });
	const current = nick('c');
	const changed = await changeNickname(env.DB, id, current, Date.now());
	if (!changed.ok) throw new Error(`nickname change failed: ${changed.error}`);
	await recordAcceptance(env.DB, id, POLICY_VERSION, Date.now());
	await recordEmailChangeRequest(env.DB, id, uniqueEmail(`${prefix}-next`), Date.now());
	return { id, email, current, old };
}

async function rowsOf(id: string) {
	return {
		user: await count('SELECT count(*) AS n FROM "user" WHERE "id" = ?', id),
		sessions: await count('SELECT count(*) AS n FROM "session" WHERE "userId" = ?', id),
		accounts: await count('SELECT count(*) AS n FROM "account" WHERE "userId" = ?', id),
		acceptances: await count('SELECT count(*) AS n FROM policy_acceptances WHERE user_id = ?', id),
		holds: await count('SELECT count(*) AS n FROM username_holds WHERE user_id = ?', id),
		emailChanges: await count(
			'SELECT count(*) AS n FROM email_change_requests WHERE user_id = ?',
			id
		),
		closures: await count(
			'SELECT count(*) AS n FROM account_deletion_requests WHERE user_id = ?',
			id
		)
	};
}

const GONE = {
	user: 0,
	sessions: 0,
	accounts: 0,
	acceptances: 0,
	holds: 0,
	emailChanges: 0,
	closures: 0
};

async function closeAccount(h: Harness, user: Fixture, mode: DeletionMode): Promise<void> {
	const client = await signedIn(h, user.email);
	const requested = await requestAccountClosure(h.auth.api, client.headers({ origin: h.origin }), {
		db: env.DB,
		userId: user.id,
		password: PASSWORD,
		mode,
		acknowledged: true,
		now: Date.now()
	});
	expect(requested).toEqual({ ok: true });
	expect((await readDeletionRequest(env.DB, user.id))?.mode).toBe(mode);
	await h.flush();
	// Nothing is deleted before the mailed link is opened.
	expect((await rowsOf(user.id)).user).toBe(1);
	const confirmed = await client.get(linkOf(h.mail(user.email, 'confirm-account-deletion')));
	expect(confirmed.status).toBe(302);
	expect(confirmed.headers.get('location')).toContain('/conta/encerrada');
	await h.flush();
	expect(h.mails(user.email, 'account-deleted')).toHaveLength(1);
}

describe('closure request', () => {
	it('refuses a wrong password or a missing acknowledgement and records nothing', async () => {
		const h = harness();
		const user = await fixture(h, 'close-refuse');
		const client = await signedIn(h, user.email);
		const headers = client.headers({ origin: h.origin });
		const base = { db: env.DB, userId: user.id, mode: 'anonymize' as const, now: Date.now() };
		expect(
			await requestAccountClosure(h.auth.api, headers, {
				...base,
				password: 'not my password 00',
				acknowledged: true
			})
		).toMatchObject({ ok: false, code: 'wrong-password' });
		expect(
			await requestAccountClosure(h.auth.api, headers, {
				...base,
				password: PASSWORD,
				acknowledged: false
			})
		).toMatchObject({ ok: false, code: 'not-acknowledged' });
		expect(await readDeletionRequest(env.DB, user.id)).toBeNull();
		await h.flush();
		expect(h.mails(user.email, 'confirm-account-deletion')).toHaveLength(0);
	});
});

describe('delete-all', () => {
	it('deletes every row of the user and frees the nickname at once', async () => {
		const h = harness();
		const user = await fixture(h, 'close-all');
		const bystander = await fixture(h, 'close-all-other');
		await closeAccount(h, user, 'delete-all');

		expect(await rowsOf(user.id)).toEqual(GONE);
		expect(await resolveNickname(env.DB, user.current, Date.now())).toBeNull();
		expect(await resolveNickname(env.DB, user.old, Date.now())).toBeNull();
		expect(
			await count(
				'SELECT count(*) AS n FROM username_holds WHERE username IN (?, ?)',
				user.current,
				user.old
			)
		).toBe(0);
		// The other account is untouched.
		expect(await rowsOf(bystander.id)).toMatchObject({
			user: 1,
			acceptances: 1,
			holds: 1,
			emailChanges: 1
		});
	});
});

describe('anonymize', () => {
	it('deletes every row of the user and holds the nickname unowned for 90 days', async () => {
		const h = harness();
		const user = await fixture(h, 'close-anon');
		const bystander = await fixture(h, 'close-anon-other');
		const before = Date.now();
		await closeAccount(h, user, 'anonymize');

		expect(await rowsOf(user.id)).toEqual(GONE);
		const hold = await env.DB.prepare(
			'SELECT username, user_id, released_at, redirect_to FROM username_holds WHERE username = ?'
		)
			.bind(user.current)
			.first<{
				username: string;
				user_id: string | null;
				released_at: number;
				redirect_to: string | null;
			}>();
		expect(hold).toMatchObject({ username: user.current, user_id: null, redirect_to: null });
		expect(hold?.released_at).toBeGreaterThanOrEqual(before + NICKNAME_HOLD_MS);
		expect(hold?.released_at).toBeLessThanOrEqual(Date.now() + NICKNAME_HOLD_MS);
		expect(await resolveNickname(env.DB, user.current, Date.now())).toEqual({ kind: 'held' });
		// The previous nickname (held for the deleted owner) is released.
		expect(await resolveNickname(env.DB, user.old, Date.now())).toBeNull();

		const newcomer = await seedUser();
		expect(await changeNickname(env.DB, newcomer.id, user.current, Date.now())).toEqual({
			ok: false,
			error: 'taken'
		});
		const later = Date.now() + NICKNAME_HOLD_MS + DAY;
		expect(await changeNickname(env.DB, newcomer.id, user.current, later)).toMatchObject({
			ok: true
		});
		expect(await rowsOf(bystander.id)).toMatchObject({ user: 1, acceptances: 1, holds: 1 });
	});
});

describe('policy', () => {
	it('without a recorded choice the default mode (delete-all) applies', async () => {
		const h = harness();
		const user = await fixture(h, 'close-default');
		const client = await signedIn(h, user.email);
		// Closure requested straight through Better Auth, not through /conta.
		const response = await client.post('/delete-user', { password: PASSWORD, callbackURL: '/' });
		expect(response.status).toBe(200);
		await h.flush();
		await client.get(linkOf(h.mail(user.email, 'confirm-account-deletion')));
		expect(await rowsOf(user.id)).toEqual(GONE);
		const held = await count(
			'SELECT count(*) AS n FROM username_holds WHERE username = ?',
			user.current
		);
		expect(held).toBe(0);
	});

	it('is idempotent and keeps the chosen mode for a retry after a failed delete', async () => {
		const user = await seedUser({ username: nick('id') });
		await recordAcceptance(env.DB, user.id, POLICY_VERSION, Date.now());
		await recordDeletionRequest(env.DB, user.id, 'anonymize', Date.now());
		const hook = accountDeletionHook({ db: env.DB });
		await hook({ id: user.id, email: user.email });
		// The user row survived (as if Better Auth's delete failed): the retry runs again.
		await hook({ id: user.id, email: user.email });
		expect((await readDeletionRequest(env.DB, user.id))?.mode).toBe('anonymize');
		const acceptances = await count(
			'SELECT count(*) AS n FROM policy_acceptances WHERE user_id = ?',
			user.id
		);
		expect(acceptances).toBe(0);
		const holds = await env.DB.prepare('SELECT user_id FROM username_holds WHERE username = ?')
			.bind(user.username ?? '')
			.all<{ user_id: string | null }>();
		expect(holds.results).toEqual([{ user_id: null }]);
		// The request row goes with the user row (foreign key cascade).
		await env.DB.prepare('DELETE FROM "user" WHERE "id" = ?').bind(user.id).run();
		expect(await readDeletionRequest(env.DB, user.id)).toBeNull();
	});

	it('passes the recorded mode to every part and validates its input', async () => {
		const seen: string[] = [];
		const spy: DeletionPart = {
			name: 'spy',
			statements: (_db, userId, mode) => {
				seen.push(`${userId}:${mode}`);
				return [];
			}
		};
		const policy = createContentDeletionPolicy([spy, ...ACCOUNT_DELETION_PARTS], 'anonymize');
		expect(policy.mode).toBe('anonymize');
		const user = await seedUser();
		await recordDeletionRequest(env.DB, user.id, 'delete-all', Date.now());
		await accountDeletionHook({ db: env.DB }, { policy })({ id: user.id, email: user.email });
		expect(seen).toEqual([`${user.id}:delete-all`]);

		const other = await seedUser();
		await accountDeletionHook({ db: env.DB }, { policy })({ id: other.id, email: other.email });
		expect(seen).toEqual([`${user.id}:delete-all`, `${other.id}:anonymize`]);

		expect(() => policy.statements(env.DB, '', 'anonymize')).toThrow();
		const invalid: unknown = 'everything';
		expect(() => policy.statements(env.DB, user.id, invalid as DeletionMode)).toThrow();
	});

	it('a failing statement rolls the whole batch back', async () => {
		const user = await seedUser();
		await recordAcceptance(env.DB, user.id, POLICY_VERSION, Date.now());
		const broken: DeletionPart = {
			name: 'broken',
			statements: (db) => [sql(db, 'DELETE FROM no_such_table')]
		};
		const policy = createContentDeletionPolicy([...ACCOUNT_DELETION_PARTS, broken]);
		const run = async () =>
			batch(env.DB, policy.statements(env.DB, user.id, 'delete-all', Date.now()));
		await expect(run()).rejects.toThrow();
		const acceptances = await count(
			'SELECT count(*) AS n FROM policy_acceptances WHERE user_id = ?',
			user.id
		);
		expect(acceptances).toBe(1);
	});
});
