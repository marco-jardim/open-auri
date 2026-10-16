// T4.11: GET /api/v1/users/[apelido] visibility matrix, nickname redirects and bans; packs CRUD,
// order, per-item license and visibility; the /u/[apelido] page load. Real routes, synthetic
// events, unique ids and nicknames per test (shared D1).
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { changeNickname } from '#lib/server/account/nickname.ts';
import { GET as getUser } from '../../../../src/routes/api/v1/users/[apelido]/+server.ts';
import { POST as createPackRoute } from '../../../../src/routes/api/v1/packs/+server.ts';
import {
	DELETE as deletePackRoute,
	GET as getPackRoute,
	PUT as putPackRoute
} from '../../../../src/routes/api/v1/packs/[id]/+server.ts';
import { load } from '../../../../src/routes/u/[apelido]/+page.server.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { locals as localsFor } from '../../account/helpers.ts';
import { ORIGIN, expectErrorResponse, randomIp, signedOut } from '../../api/helpers.ts';
import { ban, member, nick, publish, seedUser, type SeededUser } from '../repo/helpers.ts';

function signedIn(user: SeededUser): AuthLocals {
	return localsFor(user, crypto.randomUUID());
}

function userEvent(apelido: string, search = '') {
	const url = new URL(`${ORIGIN}/api/v1/users/${encodeURIComponent(apelido)}${search}`);
	return {
		request: new Request(url, { headers: { 'cf-connecting-ip': randomIp() } }),
		locals: signedOut(),
		platform: { env },
		route: { id: '/api/v1/users/[apelido]' },
		params: { apelido },
		url
	};
}

function packEvent(id: string | null, method: string, locals: AuthLocals, body?: unknown) {
	const path = id === null ? '/api/v1/packs' : `/api/v1/packs/${id}`;
	return {
		request: new Request(`${ORIGIN}${path}`, {
			method,
			headers: {
				'cf-connecting-ip': randomIp(),
				...(method === 'GET' ? {} : { origin: ORIGIN }),
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		}),
		locals,
		platform: { env },
		route: { id: id === null ? '/api/v1/packs' : '/api/v1/packs/[id]' },
		params: { id: id ?? '' }
	};
}

interface ProfileBody {
	profile: { username: string; library: string; activity: string; counts: { lineages: number } };
	lineages: { items: { id: string }[] } | null;
	packs: { items: { id: string }[] } | null;
	favorites: { items: { lineage: { id: string } }[] } | null;
}

async function favorite(userId: string, lineageId: string): Promise<void> {
	await env.DB.prepare('INSERT INTO favorites (user_id, lineage_id, created_at) VALUES (?, ?, ?)')
		.bind(userId, lineageId, Date.now())
		.run();
}

describe('GET /api/v1/users/[apelido]', () => {
	it('library off: nickname and counts only, no lists', async () => {
		const owner = await member({ library: 'private', activity: 'public' });
		await publish(owner.id);
		const response = await getUser(userEvent(owner.username));
		expect(response.status).toBe(200);
		const body = (await response.json()) as ProfileBody;
		expect(body.profile.username).toBe(owner.username);
		expect(body.profile.counts.lineages).toBe(1);
		expect(body).toMatchObject({ lineages: null, packs: null, favorites: null });
		expect(JSON.stringify(body)).not.toContain(owner.id);
		const list = await getUser(userEvent(owner.username, '?list=lineages'));
		expect(await list.json()).toEqual({ list: 'lineages', items: [], nextCursor: null });
	});

	it('library on, activity off: creations and packs, never favorites or private lineages', async () => {
		const owner = await member({ library: 'public', activity: 'private' });
		const open = await publish(owner.id);
		const hidden = await publish(owner.id, { visibility: 'private' });
		const unlisted = await publish(owner.id, { visibility: 'unlisted' });
		await favorite(owner.id, open.lineageId);
		const body = (await (await getUser(userEvent(owner.username))).json()) as ProfileBody;
		const ids = body.lineages?.items.map((item) => item.id) ?? [];
		expect(ids).toContain(open.lineageId);
		expect(ids).not.toContain(hidden.lineageId);
		expect(ids).not.toContain(unlisted.lineageId);
		expect(body.packs).toEqual({ items: [], nextCursor: null });
		expect(body.favorites).toBeNull();
	});

	it('library and activity on: public favorites, paginated with a cursor', async () => {
		const owner = await member({ library: 'public', activity: 'public' });
		const author = await member();
		const first = await publish(author.id);
		const second = await publish(author.id);
		await favorite(owner.id, first.lineageId);
		await favorite(owner.id, second.lineageId);
		const page = await getUser(userEvent(owner.username, '?list=favorites&limit=1'));
		const one = (await page.json()) as { items: unknown[]; nextCursor: string | null };
		expect(one.items).toHaveLength(1);
		expect(one.nextCursor).not.toBeNull();
		const next = await getUser(
			userEvent(owner.username, `?list=favorites&limit=1&cursor=${one.nextCursor ?? ''}`)
		);
		expect(((await next.json()) as { items: unknown[] }).items).toHaveLength(1);
		await expectErrorResponse(
			await getUser(userEvent(owner.username, '?list=favorites&cursor=%21bad')),
			400,
			'INVALID_CURSOR'
		);
		await expectErrorResponse(
			await getUser(userEvent(owner.username, '?list=nope')),
			400,
			'INVALID_BODY'
		);
	});

	it('banned, unknown and invalid nicknames: 404', async () => {
		const banned = await member({ library: 'public' });
		await ban(banned.id);
		await expectErrorResponse(await getUser(userEvent(banned.username)), 404, 'NOT_FOUND');
		await expectErrorResponse(await getUser(userEvent(nick('zz'))), 404, 'NOT_FOUND');
		await expectErrorResponse(await getUser(userEvent('x'.repeat(80))), 404, 'NOT_FOUND');
	});

	it('held previous nickname: 308 to the current one; spelling variants too', async () => {
		const old = nick('old');
		const user = await seedUser({ username: old });
		const fresh = nick('new');
		const changed = await changeNickname(env.DB, user.id, fresh, Date.now());
		expect(changed.ok).toBe(true);
		const response = await getUser(userEvent(old));
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe(`/api/v1/users/${fresh}`);
		expect(await response.json()).toEqual({ redirect: fresh });
		const upper = await getUser(userEvent(fresh.toUpperCase()));
		expect(upper.status).toBe(308);
		await ban(user.id);
		await expectErrorResponse(await getUser(userEvent(old)), 404, 'NOT_FOUND');
	});
});

describe('/u/[apelido] page load', () => {
	it('profile, 308 for a held nickname, 404 for a banned user', async () => {
		const owner = await member({ library: 'public' });
		const created = await publish(owner.id);
		const data = await load({ params: { apelido: owner.username }, platform: { env } });
		expect(data.profile.username).toBe(owner.username);
		expect(data.lineages?.items.map((item) => item.id)).toEqual([created.lineageId]);

		const old = nick('pold');
		const moved = await seedUser({ username: old });
		const fresh = nick('pnew');
		await changeNickname(env.DB, moved.id, fresh, Date.now());
		let thrown: unknown = null;
		try {
			await load({ params: { apelido: old }, platform: { env } });
		} catch (error) {
			thrown = error;
		}
		expect(isRedirect(thrown) && thrown.status === 308 && thrown.location === `/u/${fresh}`).toBe(
			true
		);

		await ban(owner.id);
		thrown = null;
		try {
			await load({ params: { apelido: owner.username }, platform: { env } });
		} catch (error) {
			thrown = error;
		}
		expect(isHttpError(thrown, 404)).toBe(true);
	});
});

describe('packs API', () => {
	it('create, reorder, per-item license, visibility and delete (owner only)', async () => {
		const owner = await member();
		const other = await member();
		const a = await publish(owner.id);
		const b = await publish(owner.id);
		const secret = await publish(owner.id, { visibility: 'private' });

		const created = await createPackRoute(
			packEvent(null, 'POST', signedIn(owner), {
				name: '  Mesa  ',
				visibility: 'public',
				items: [a.lineageId, { lineageId: b.lineageId, license: 'CC-BY-4.0' }, secret.lineageId]
			})
		);
		expect(created.status).toBe(201);
		const pack = (await created.json()) as {
			id: string;
			name: string;
			owned: boolean;
			items: { position: number; license: string; lineage: { id: string } }[];
		};
		expect(pack.name).toBe('Mesa');
		expect(pack.owned).toBe(true);
		expect(pack.items.map((item) => item.lineage.id)).toEqual([
			a.lineageId,
			b.lineageId,
			secret.lineageId
		]);
		expect(pack.items.every((item) => item.license === 'CC-BY-4.0')).toBe(true);

		// Someone else never sees the private lineage, and gets the public cache headers.
		const seen = await getPackRoute(packEvent(pack.id, 'GET', signedIn(other)));
		const view = (await seen.json()) as { owned: boolean; items: { lineage: { id: string } }[] };
		expect(view.owned).toBe(false);
		expect(view.items.map((item) => item.lineage.id)).toEqual([a.lineageId, b.lineageId]);
		const anonymous = await getPackRoute(packEvent(pack.id, 'GET', signedOut()));
		expect(((await anonymous.json()) as { items: unknown[] }).items).toHaveLength(2);

		// Reorder.
		const reordered = await putPackRoute(
			packEvent(pack.id, 'PUT', signedIn(owner), { items: [b.lineageId, a.lineageId] })
		);
		expect(reordered.status).toBe(200);
		const order = (await reordered.json()) as {
			items: { position: number; lineage: { id: string } }[];
		};
		expect(order.items.map((item) => [item.position, item.lineage.id])).toEqual([
			[0, b.lineageId],
			[1, a.lineageId]
		]);

		// License must match the head version.
		const mismatch = await putPackRoute(
			packEvent(pack.id, 'PUT', signedIn(owner), {
				items: [{ lineageId: a.lineageId, license: 'CC0-1.0' }]
			})
		);
		const conflict = await expectErrorResponse(mismatch, 409, 'CONFLICT');
		expect(conflict.error.details).toMatchObject({ reason: 'license-mismatch', index: 0 });

		// Duplicates and someone else's private lineage.
		await expectErrorResponse(
			await putPackRoute(
				packEvent(pack.id, 'PUT', signedIn(owner), { items: [a.lineageId, a.lineageId] })
			),
			400,
			'INVALID_BODY'
		);
		const theirs = await publish(other.id, { visibility: 'private' });
		await expectErrorResponse(
			await putPackRoute(packEvent(pack.id, 'PUT', signedIn(owner), { items: [theirs.lineageId] })),
			404,
			'NOT_FOUND'
		);

		// Not the owner: 404 on edit and delete.
		await expectErrorResponse(
			await putPackRoute(packEvent(pack.id, 'PUT', signedIn(other), { name: 'Mine' })),
			404,
			'NOT_FOUND'
		);
		await expectErrorResponse(
			await deletePackRoute(packEvent(pack.id, 'DELETE', signedIn(other))),
			404,
			'NOT_FOUND'
		);

		// Private pack: hidden from others, visible to the owner.
		await putPackRoute(packEvent(pack.id, 'PUT', signedIn(owner), { visibility: 'private' }));
		await expectErrorResponse(
			await getPackRoute(packEvent(pack.id, 'GET', signedIn(other))),
			404,
			'NOT_FOUND'
		);
		const own = await getPackRoute(packEvent(pack.id, 'GET', signedIn(owner)));
		expect(own.status).toBe(200);
		expect(own.headers.get('cache-control')).toContain('no-store');

		const removed = await deletePackRoute(packEvent(pack.id, 'DELETE', signedIn(owner)));
		expect(removed.status).toBe(204);
		await expectErrorResponse(
			await getPackRoute(packEvent(pack.id, 'GET', signedIn(owner))),
			404,
			'NOT_FOUND'
		);
	});

	it('create needs a verified e-mail and a valid name; text is normalized', async () => {
		const unverified = await seedUser({ username: nick('u'), verified: false });
		await expectErrorResponse(
			await createPackRoute(
				packEvent(
					null,
					'POST',
					localsFor(unverified, crypto.randomUUID(), { emailVerified: false }),
					{
						name: 'x'
					}
				)
			),
			403,
			'EMAIL_NOT_VERIFIED'
		);
		const owner = await member();
		await expectErrorResponse(
			await createPackRoute(packEvent(null, 'POST', signedIn(owner), { name: '   ' })),
			400,
			'INVALID_BODY'
		);
		await expectErrorResponse(
			await createPackRoute(
				packEvent(null, 'POST', signedIn(owner), { name: 'see https://example.com' })
			),
			400,
			'INVALID_BODY'
		);
		await expectErrorResponse(
			await createPackRoute(packEvent(null, 'POST', signedIn(owner), { name: 'ok', extra: 1 })),
			400,
			'INVALID_BODY'
		);
	});

	it('public packs show on a public profile only', async () => {
		const owner = await member({ library: 'public' });
		const created = await createPackRoute(
			packEvent(null, 'POST', signedIn(owner), { name: 'Shelf', visibility: 'public' })
		);
		const { id } = (await created.json()) as { id: string };
		await createPackRoute(
			packEvent(null, 'POST', signedIn(owner), { name: 'Hidden', visibility: 'unlisted' })
		);
		const body = (await (await getUser(userEvent(owner.username))).json()) as ProfileBody;
		expect(body.packs?.items.map((item) => item.id)).toEqual([id]);
	});
});
