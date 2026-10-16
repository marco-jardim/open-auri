// T3.T concurrency and expirations on D1 without interactive transactions (plan §12):
//   - two simultaneous resets with the same token: exactly one wins (DELETE … RETURNING);
//   - two accounts racing to the same new e-mail: the unique index lets exactly one through;
//   - expired verification, reset and deletion links change nothing.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	createVerifiedUser,
	errorCode,
	linkOf,
	NEW_PASSWORD,
	PASSWORD,
	signedIn,
	uniqueEmail
} from '../auth/harness.ts';
import { harness, userRow } from './helpers.ts';

const network = setupNetwork();

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});
afterEach(() => {
	vi.useRealTimers();
});

const OTHER_PASSWORD = 'yet another secret 333';
const TWO_HOURS = 2 * 60 * 60 * 1000;

async function idOf(email: string): Promise<string | null> {
	const row = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	return row?.id ?? null;
}

/** Moves every pending verification row of `userId` (reset / deletion tokens) into the past. */
async function expireTokens(userId: string): Promise<number> {
	const result = await env.DB.prepare('UPDATE verification SET "expiresAt" = ? WHERE value = ?')
		.bind(new Date(Date.now() - 60_000).toISOString(), userId)
		.run();
	return result.meta.changes;
}

describe('concurrency', () => {
	it('two simultaneous resets with the same token: exactly one succeeds', async () => {
		const h = harness(network);
		const email = uniqueEmail('race-reset');
		await createVerifiedUser(h, email);
		expect((await h.client().post('/request-password-reset', { email })).status).toBe(200);
		await h.flush();
		const token = linkOf(h.mail(email, 'reset-password')).searchParams.get('token') ?? '';
		expect(token).not.toBe('');

		const [first, second] = await Promise.all([
			h.client().post('/reset-password', { token, newPassword: NEW_PASSWORD }),
			h.client().post('/reset-password', { token, newPassword: OTHER_PASSWORD })
		]);
		const statuses = [first.status, second.status].sort();
		expect(statuses).toEqual([200, 400]);
		const loser = first.status === 200 ? second : first;
		expect(await errorCode(loser)).toBe('INVALID_TOKEN');

		const winner = first.status === 200 ? NEW_PASSWORD : OTHER_PASSWORD;
		const other = winner === NEW_PASSWORD ? OTHER_PASSWORD : NEW_PASSWORD;
		expect((await h.client().signIn(email, winner)).status).toBe(200);
		expect((await h.client().signIn(email, other)).status).toBe(401);
		expect((await h.client().signIn(email, PASSWORD)).status).toBe(401);
		// The token is spent for good.
		const replay = await h.client().post('/reset-password', { token, newPassword: PASSWORD });
		expect(replay.status).toBe(400);
	});

	it('two accounts moving to the same new address: exactly one ends up with it', async () => {
		const h = harness(network);
		const target = uniqueEmail('race-target');
		const owners = [uniqueEmail('race-a'), uniqueEmail('race-b')];
		const ids: string[] = [];
		for (const email of owners) {
			ids.push(await createVerifiedUser(h, email));
			const client = await signedIn(h, email);
			const response = await client.post('/change-email', { newEmail: target, callbackURL: '/' });
			expect(response.status).toBe(200);
		}
		await h.flush();
		for (const email of owners) {
			expect((await h.client().get(linkOf(h.mail(email, 'confirm-email-change')))).status).toBe(
				302
			);
		}
		await h.flush();
		const finals = h.mails(target, 'confirm-new-email');
		expect(finals).toHaveLength(2);

		const responses = await Promise.all(finals.map((mail) => h.client().get(linkOf(mail))));
		for (const response of responses) expect(response.status).toBeLessThan(600);
		const rows = await Promise.all(ids.map((id) => userRow(id)));
		const moved = rows.filter((row) => row?.email === target);
		expect(moved).toHaveLength(1);
		const stayed = rows.filter((row) => row && owners.includes(row.email));
		expect(stayed).toHaveLength(1);
		const holders = await env.DB.prepare('SELECT count(*) AS n FROM "user" WHERE email = ?')
			.bind(target)
			.first<{ n: number }>();
		expect(holders?.n).toBe(1);
	});

	it('concurrent sign-ins of one account create independent, revocable sessions', async () => {
		const h = harness(network);
		const email = uniqueEmail('race-signin');
		const id = await createVerifiedUser(h, email);
		const clients = await Promise.all([signedIn(h, email), signedIn(h, email)]);
		const sessions = await env.DB.prepare('SELECT count(*) AS n FROM "session" WHERE userId = ?')
			.bind(id)
			.first<{ n: number }>();
		expect(sessions?.n).toBe(2);
		const [a, b] = clients;
		if (!a || !b) throw new Error('clients missing');
		expect((await a.post('/revoke-other-sessions', {})).status).toBe(200);
		expect(await b.session()).toBeNull();
		expect(await a.session()).not.toBeNull();
	});
});

describe('expirations', () => {
	it('an expired reset link changes nothing', async () => {
		const h = harness(network);
		const email = uniqueEmail('expire-reset');
		const id = await createVerifiedUser(h, email);
		await h.client().post('/request-password-reset', { email });
		await h.flush();
		const token = linkOf(h.mail(email, 'reset-password')).searchParams.get('token') ?? '';
		expect(await expireTokens(id)).toBeGreaterThan(0);
		const response = await h.client().post('/reset-password', { token, newPassword: NEW_PASSWORD });
		expect(response.status).toBe(400);
		expect((await h.client().signIn(email, PASSWORD)).status).toBe(200);
	});

	it('an expired verification link leaves the address unverified', async () => {
		const h = harness(network);
		const email = uniqueEmail('expire-verify');
		expect((await h.client().signUp(email)).status).toBe(200);
		await h.flush();
		const link = linkOf(h.mail(email, 'verify-email'));
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + TWO_HOURS);
		const response = await h.client().get(link);
		vi.useRealTimers();
		expect(response.status).toBe(302);
		expect(response.headers.get('location') ?? '').toMatch(/error=/);
		const id = await idOf(email);
		expect((await userRow(id ?? ''))?.emailVerified).toBe(0);
		expect((await h.client().signIn(email)).status).toBe(403);
	});

	it('an expired account-deletion link deletes nothing', async () => {
		const h = harness(network);
		const email = uniqueEmail('expire-delete');
		const id = await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		expect(
			(await client.post('/delete-user', { password: PASSWORD, callbackURL: '/' })).status
		).toBe(200);
		await h.flush();
		const link = linkOf(h.mail(email, 'confirm-account-deletion'));
		expect(await expireTokens(id)).toBeGreaterThan(0);
		const response = await client.get(link);
		expect(response.status).not.toBe(200);
		expect(await userRow(id)).not.toBeNull();
		await h.flush();
		expect(h.mails(email, 'account-deleted')).toHaveLength(0);
	});
});
