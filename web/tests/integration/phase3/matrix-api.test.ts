// T3.T authorization matrix, part 1: the Better Auth HTTP surface (/api/auth/*) through the real
// handler (`auth.handler`, which routes/api/auth/[...all]/+server.ts delegates to), for
// anonymous × unverified × verified × admin (with and without the 2FA marker) × banned.
import { setupNetwork } from '@msw/cloudflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	createVerifiedUser,
	errorCode,
	NEW_PASSWORD,
	PASSWORD,
	signedIn,
	uniqueEmail,
	type Client
} from '../auth/harness.ts';
import {
	count,
	harness,
	persona,
	personas,
	PERSONAS,
	userRow,
	type PersonaName
} from './helpers.ts';

const network = setupNetwork();

// Building the six personas (sign-up, verification, sign-in, TOTP) takes several seconds.
vi.setConfig({ testTimeout: 60_000 });

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

const SIGNED_IN: readonly PersonaName[] = PERSONAS.filter((name) => name !== 'anonymous');

/** Session-bound endpoints: method, path and a body that would otherwise be valid. */
// FX3.1 (Q3-7): `/list-sessions` and `/update-user` left this list: the app does not use them and
// they now answer 404 over HTTP for everyone (covered in auth/hardening.test.ts). Issue #21:
// `/two-factor/disable` left it too (404 for every persona, asserted below); /conta turns 2FA off
// server-side with the password and a code.
const SESSION_ENDPOINTS: readonly { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
	{
		method: 'POST',
		path: '/change-password',
		body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }
	},
	{ method: 'POST', path: '/change-email', body: { newEmail: 'nobody-new@example.com' } },
	{ method: 'POST', path: '/delete-user', body: { password: PASSWORD } },
	{ method: 'POST', path: '/revoke-session', body: { token: 'not-a-token' } },
	{ method: 'POST', path: '/revoke-sessions' },
	{ method: 'POST', path: '/revoke-other-sessions' },
	{ method: 'POST', path: '/two-factor/enable', body: { password: PASSWORD } }
];

async function call(client: Client, method: 'GET' | 'POST', path: string, body?: unknown) {
	return method === 'GET' ? client.get(path) : client.post(path, body ?? {});
}

describe('/api/auth/* × personas', () => {
	it('anonymous: every session-bound endpoint answers 401 and changes nothing', async () => {
		const h = harness(network);
		const anonymous = await persona(h, 'anonymous');
		for (const endpoint of SESSION_ENDPOINTS) {
			const response = await call(anonymous.client, endpoint.method, endpoint.path, endpoint.body);
			expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
		}
		expect(await anonymous.client.session()).toBeNull();
	});

	it('signed-in personas reach their own session; cross-origin writes are refused', async () => {
		const h = harness(network);
		const all = await personas(h);
		// `banned` here is a flipped row with a live session (an artificial state: a real ban revokes
		// every session, covered below), so only its cross-origin refusal is asserted.
		// FX3.1: `/list-sessions` is closed over HTTP; the own-session check uses `/get-session`.
		for (const name of SIGNED_IN) {
			const { client } = all[name];
			if (name !== 'banned') {
				const current = await client.session();
				expect(current?.user.id, name).toBe(all[name].id);
				expect((await client.get('/list-sessions')).status, name).toBe(404);
			}

			const crossSite = await client.post(
				'/change-password',
				{ currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
				{ origin: 'https://evil.example' }
			);
			expect(crossSite.status, name).toBe(403);
			const noOrigin = await client.post('/revoke-other-sessions', {}, { origin: null });
			expect(noOrigin.status, name).toBe(403);
		}
	});

	it("the admin plugin's HTTP endpoints are 404 for everyone, admins with 2FA included", async () => {
		const h = harness(network);
		const all = await personas(h);
		for (const name of PERSONAS) {
			const { client } = all[name];
			expect((await client.get('/admin/list-users')).status, name).toBe(404);
			const promote = await client.post('/admin/set-role', {
				userId: all.verified.id,
				role: 'admin'
			});
			expect(promote.status, name).toBe(404);
		}
		expect(await localsRole(all.verified.client)).toBe('user');
	});

	it('/two-factor/disable is 404 over HTTP for everyone; 2FA stays on (issue #21)', async () => {
		const h = harness(network);
		const all = await personas(h);
		for (const name of PERSONAS) {
			const response = await all[name].client.post('/two-factor/disable', { password: PASSWORD });
			expect(response.status, name).toBe(404);
		}
		const adminId = all.admin2fa.id;
		if (adminId === null) throw new Error('admin2fa persona has no account id');
		expect(
			await count(
				'SELECT count(*) AS n FROM "user" WHERE id = ? AND "twoFactorEnabled" = 1',
				adminId
			)
		).toBe(1);
	});

	it('unverified: sign-in is refused until the link is opened (403)', async () => {
		const h = harness(network);
		const email = uniqueEmail('p3-unverified-signin');
		const client = h.client();
		expect((await client.signUp(email)).status).toBe(200);
		const response = await h.client().signIn(email);
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe('EMAIL_NOT_VERIFIED');
	});

	it('banned (through the admin API): sessions revoked at once and sign-in refused', async () => {
		const h = harness(network);
		const admin = await persona(h, 'admin2fa');
		const email = uniqueEmail('p3-ban-target');
		const id = await createVerifiedUser(h, email);
		const victim = await signedIn(h, email);
		expect(await victim.session()).not.toBeNull();

		await h.auth.api.banUser({
			headers: admin.client.headers({ origin: h.origin }),
			body: { userId: id, banReason: 'matrix test' }
		});
		expect((await userRow(id))?.banned).toBe(1);
		expect(await victim.session()).toBeNull();
		const again = await h.client().signIn(email);
		expect(again.status).toBe(403);
		// The banned user's former cookie cannot reach session endpoints either.
		// (FX3.1: `/list-sessions` is closed over HTTP; `/change-password` is session-bound.)
		expect(
			(
				await victim.post('/change-password', {
					currentPassword: PASSWORD,
					newPassword: NEW_PASSWORD
				})
			).status
		).toBe(401);
	});
});

async function localsRole(client: Client): Promise<string | null> {
	const current = await client.session();
	const role = current?.user.role;
	return typeof role === 'string' ? role : null;
}
