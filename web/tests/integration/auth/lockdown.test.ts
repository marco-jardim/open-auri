// Integration follow-up (T3.7/T3.8): admin plugin endpoints closed over HTTP but usable
// server-side, nickname changes only through /conta, held nicknames refused at sign-up.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usernameSkeleton } from '#lib/server/auth/username.ts';
import {
	createVerifiedUser,
	errorCode,
	Harness,
	mockNetwork,
	signedIn,
	uniqueEmail,
	uniqueUsername
} from './harness.ts';

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
	return new Harness();
}

async function makeAdmin(email: string): Promise<void> {
	await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE email = ?`).bind(email).run();
}

async function nickname(id: string) {
	return env.DB.prepare('SELECT username, displayUsername FROM "user" WHERE id = ?')
		.bind(id)
		.first<{ username: string | null; displayUsername: string | null }>();
}

describe('admin plugin endpoints', () => {
	it('answer 404 over HTTP, impersonation included, even for an admin', async () => {
		const h = harness();
		const adminEmail = uniqueEmail('lock-admin');
		await createVerifiedUser(h, adminEmail);
		await makeAdmin(adminEmail);
		const targetId = await createVerifiedUser(h, uniqueEmail('lock-target'));
		const admin = await signedIn(h, adminEmail);

		const posts: [string, Record<string, unknown>][] = [
			['/admin/impersonate-user', { userId: targetId }],
			['/admin/stop-impersonating', {}],
			['/admin/set-role', { userId: targetId, role: 'admin' }],
			['/admin/ban-user', { userId: targetId }],
			['/admin/create-user', { email: uniqueEmail('x'), password: 'whatever long 123', name: 'X' }],
			['/admin/update-user', { userId: targetId, data: { username: 'stolen' } }],
			['/admin/remove-user', { userId: targetId }],
			['/admin/set-user-password', { userId: targetId, newPassword: 'whatever long 123' }],
			['/admin/revoke-user-sessions', { userId: targetId }]
		];
		for (const [path, body] of posts) {
			const response = await admin.post(path, body);
			expect(response.status, path).toBe(404);
		}
		for (const path of ['/admin/list-users', `/admin/get-user?id=${targetId}`]) {
			expect((await admin.get(path)).status, path).toBe(404);
		}
		const target = await env.DB.prepare('SELECT role, banned FROM "user" WHERE id = ?')
			.bind(targetId)
			.first<{ role: string | null; banned: number | null }>();
		expect(target?.role).not.toBe('admin');
		expect(target?.banned ?? 0).toBe(0);
		const current = await admin.session();
		expect(current?.session.impersonatedBy ?? null).toBeNull();
	});

	it('keep working through server-side auth.api calls', async () => {
		const h = harness();
		const adminEmail = uniqueEmail('api-admin');
		await createVerifiedUser(h, adminEmail);
		await makeAdmin(adminEmail);
		const targetId = await createVerifiedUser(h, uniqueEmail('api-target'));
		const admin = await signedIn(h, adminEmail);

		await h.auth.api.banUser({
			body: { userId: targetId, banReason: 'test' },
			headers: admin.headers()
		});
		const target = await env.DB.prepare('SELECT banned FROM "user" WHERE id = ?')
			.bind(targetId)
			.first<{ banned: number }>();
		expect(target?.banned).toBe(1);
	});
});

describe('nickname changes outside /conta', () => {
	// FX3.1 (Q3-7): `/update-user` is closed over HTTP (404 for every body); server-side calls still
	// refuse nickname fields with USERNAME_CHANGE_NOT_ALLOWED and accept the other fields.
	it('/update-user: 404 over HTTP; server-side it refuses nickname fields, accepts others', async () => {
		const h = harness();
		const email = uniqueEmail('upd');
		const original = uniqueUsername('orig');
		const id = await createVerifiedUser(h, email, { username: original });
		const client = await signedIn(h, email);

		for (const body of [
			{ username: uniqueUsername('new') },
			{ displayUsername: original.toUpperCase() },
			{ username: original, displayUsername: original.toUpperCase() },
			{ name: 'Renamed' }
		]) {
			expect((await client.post('/update-user', body)).status).toBe(404);
		}
		for (const body of [
			{ username: uniqueUsername('new') },
			{ displayUsername: original.toUpperCase() }
		]) {
			const error = await h.auth.api
				.updateUser({ body, headers: client.headers() })
				.then(() => null)
				.catch((caught: unknown) => caught);
			expect(JSON.stringify((error as { body?: unknown } | null)?.body ?? null)).toContain(
				'USERNAME_CHANGE_NOT_ALLOWED'
			);
		}
		await h.auth.api.updateUser({ body: { name: 'Renamed' }, headers: client.headers() });
		expect(await nickname(id)).toEqual({ username: original, displayUsername: original });
	});

	it('is refused for server-side calls too, including the admin plugin', async () => {
		const h = harness();
		const adminEmail = uniqueEmail('upd-admin');
		await createVerifiedUser(h, adminEmail);
		await makeAdmin(adminEmail);
		const email = uniqueEmail('upd-server');
		const original = uniqueUsername('keep');
		const id = await createVerifiedUser(h, email, { username: original });
		const user = await signedIn(h, email);
		const admin = await signedIn(h, adminEmail);

		await expect(
			h.auth.api.updateUser({ body: { username: uniqueUsername('srv') }, headers: user.headers() })
		).rejects.toThrow();
		await expect(
			h.auth.api.adminUpdateUser({
				body: { userId: id, data: { username: uniqueUsername('adm') } },
				headers: admin.headers()
			})
		).rejects.toThrow();
		expect((await nickname(id))?.username).toBe(original);
	});
});

describe('held nicknames at sign-up', () => {
	async function hold(username: string, releasedAt: number): Promise<void> {
		await env.DB.prepare(
			'INSERT INTO username_holds (skeleton, username, user_id, released_at, redirect_to) ' +
				'VALUES (?, ?, NULL, ?, NULL)'
		)
			.bind(usernameSkeleton(username), username, releasedAt)
			.run();
	}

	it('refuses a held nickname exactly like a taken one', async () => {
		const h = harness();
		const held = uniqueUsername('held');
		await hold(held, Date.now() + 86_400_000);
		const taken = uniqueUsername('taken');
		await createVerifiedUser(h, uniqueEmail('owner'), { username: taken });

		const heldResponse = await h.client().signUp(uniqueEmail('wants-held'), { username: held });
		const takenResponse = await h.client().signUp(uniqueEmail('wants-taken'), { username: taken });
		expect(heldResponse.status).toBe(400);
		expect(takenResponse.status).toBe(400);
		expect(await errorCode(takenResponse)).toBe('USERNAME_IS_ALREADY_TAKEN');
		expect(await heldResponse.json()).toEqual(await takenResponse.json());
	});

	it('refuses look-alikes of a held nickname and accepts an expired hold', async () => {
		const h = harness();
		const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
		await hold(`paulo${suffix}`, Date.now() + 86_400_000);
		const lookalike = await h.client().signUp(uniqueEmail('lookalike'), {
			username: `pau1o${suffix}`
		});
		expect(lookalike.status).toBe(400);
		expect(await errorCode(lookalike)).toBe('USERNAME_IS_ALREADY_TAKEN');

		const expired = uniqueUsername('gone');
		await hold(expired, Date.now() - 1_000);
		const response = await h.client().signUp(uniqueEmail('expired'), { username: expired });
		expect(response.status).toBe(200);
	});
});
