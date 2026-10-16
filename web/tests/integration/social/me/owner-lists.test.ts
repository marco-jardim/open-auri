// T4.14b: GET /api/v1/me/packs and GET /api/v1/me/shares, the owner-only lists of "Minha
// biblioteca" (own items in any visibility, never someone else's, paginated, private no-store).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { createPack, createShare } from '#lib/server/social/repo.ts';
import type { PackVisibility } from '#lib/server/social/types.ts';
import { GET as PACKS } from '../../../../src/routes/api/v1/me/packs/+server.ts';
import { GET as SHARES } from '../../../../src/routes/api/v1/me/shares/+server.ts';
import {
	errorCode,
	member,
	publish,
	routeEvent,
	sid,
	signedIn,
	SIGNED_OUT
} from '../activity/helpers.ts';

const PACKS_ROUTE = '/api/v1/me/packs';
const SHARES_ROUTE = '/api/v1/me/shares';

interface PackPage {
	items: { id: string; name: string; visibility: string; ownerUserId?: unknown }[];
	nextCursor: string | null;
}

interface SharePage {
	items: {
		id: string;
		lineage: { id: string; name: string | null };
		versionId: string | null;
		channel: string | null;
		createdAt: number;
	}[];
	nextCursor: string | null;
}

function myPacks(auth: AuthLocals, query = '') {
	return PACKS(routeEvent({ path: `${PACKS_ROUTE}${query}`, routeId: PACKS_ROUTE, locals: auth }));
}

function myShares(auth: AuthLocals, query = '') {
	return SHARES(
		routeEvent({ path: `${SHARES_ROUTE}${query}`, routeId: SHARES_ROUTE, locals: auth })
	);
}

async function pack(ownerUserId: string, visibility: PackVisibility, now: number): Promise<string> {
	const id = sid('pack');
	const created = await createPack(env.DB, {
		id,
		ownerUserId,
		name: `Pack ${visibility}`,
		description: '',
		visibility,
		now
	});
	if (!created.ok) throw new Error(`pack failed: ${created.code}`);
	return id;
}

async function shareAt(
	lineageId: string,
	ownerUserId: string,
	now: number,
	options: { versionId?: string; channel?: string } = {}
): Promise<string> {
	const id = sid('shr');
	const created = await createShare(env.DB, {
		id,
		lineageId,
		versionId: options.versionId ?? null,
		ownerUserId,
		channel: options.channel ?? null,
		now
	});
	if (!created.ok) throw new Error(`share failed: ${created.code}`);
	return id;
}

async function code(response: Response, status: number): Promise<string> {
	return ((await errorCode(response, status)) as { code: string }).code;
}

describe('GET /api/v1/me/packs', () => {
	it('requires a session', async () => {
		expect(await code(await myPacks(SIGNED_OUT), 401)).toBe('AUTH_REQUIRED');
	});

	it('lists own packs in any visibility, newest first, and never other users packs', async () => {
		const owner = await member();
		const other = await member();
		const now = Date.now();
		const priv = await pack(owner.id, 'private', now - 3000);
		const unlisted = await pack(owner.id, 'unlisted', now - 2000);
		const pub = await pack(owner.id, 'public', now - 1000);
		const foreign = await pack(other.id, 'public', now);

		const response = await myPacks(signedIn(owner));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(response.headers.get('cache-control')).toContain('private');
		const page = (await response.json()) as PackPage;
		expect(page.items.map((item) => item.id)).toEqual([pub, unlisted, priv]);
		expect(page.items.map((item) => item.visibility)).toEqual(['public', 'unlisted', 'private']);
		expect(page.items.every((item) => item.ownerUserId === undefined)).toBe(true);
		expect(page.nextCursor).toBeNull();

		const otherPage = (await (await myPacks(signedIn(other))).json()) as PackPage;
		expect(otherPage.items.map((item) => item.id)).toEqual([foreign]);
	});

	it('paginates with nextCursor and refuses bad cursors and limits', async () => {
		const owner = await member();
		const now = Date.now();
		const ids = [
			await pack(owner.id, 'private', now - 3000),
			await pack(owner.id, 'public', now - 2000),
			await pack(owner.id, 'private', now - 1000)
		].reverse();

		const first = (await (await myPacks(signedIn(owner), '?limit=2')).json()) as PackPage;
		expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
		expect(first.nextCursor).not.toBeNull();
		const cursor = encodeURIComponent(first.nextCursor ?? '');
		const second = (await (
			await myPacks(signedIn(owner), `?limit=2&cursor=${cursor}`)
		).json()) as PackPage;
		expect(second.items.map((item) => item.id)).toEqual(ids.slice(2));
		expect(second.nextCursor).toBeNull();

		expect(await code(await myPacks(signedIn(owner), '?cursor=***'), 400)).toBe('INVALID_CURSOR');
		expect(await code(await myPacks(signedIn(owner), '?limit=0'), 400)).toBe('INVALID_BODY');
		expect(await code(await myPacks(signedIn(owner), '?limit=101'), 400)).toBe('INVALID_BODY');
	});
});

describe('GET /api/v1/me/shares', () => {
	it('requires a session', async () => {
		expect(await code(await myShares(SIGNED_OUT), 401)).toBe('AUTH_REQUIRED');
	});

	it('lists own shares with lineage id and name, newest first, never others', async () => {
		const owner = await member();
		const other = await member();
		const now = Date.now();
		const privateLineage = await publish(owner.id, { visibility: 'private' });
		const publicLineage = await publish(owner.id);
		const older = await shareAt(privateLineage.lineageId, owner.id, now - 2000);
		const newer = await shareAt(publicLineage.lineageId, owner.id, now - 1000, {
			versionId: publicLineage.versionId,
			channel: 'whatsapp'
		});
		const foreign = await shareAt(publicLineage.lineageId, other.id, now);

		const response = await myShares(signedIn(owner));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(response.headers.get('cache-control')).toContain('private');
		const page = (await response.json()) as SharePage;
		expect(page.items).toEqual([
			{
				id: newer,
				lineage: { id: publicLineage.lineageId, name: 'Warm vocal' },
				versionId: publicLineage.versionId,
				channel: 'whatsapp',
				createdAt: now - 1000
			},
			{
				id: older,
				lineage: { id: privateLineage.lineageId, name: 'Warm vocal' },
				versionId: null,
				channel: null,
				createdAt: now - 2000
			}
		]);
		expect(page.nextCursor).toBeNull();

		const otherPage = (await (await myShares(signedIn(other))).json()) as SharePage;
		expect(otherPage.items.map((item) => item.id)).toEqual([foreign]);
	});

	it('hides the name of a lineage the sharer can no longer read', async () => {
		const author = await member();
		const sharer = await member();
		const lineage = await publish(author.id);
		const shareId = await shareAt(lineage.lineageId, sharer.id, Date.now());
		await env.DB.prepare("UPDATE lineages SET visibility = 'private' WHERE id = ?")
			.bind(lineage.lineageId)
			.run();

		const page = (await (await myShares(signedIn(sharer))).json()) as SharePage;
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.id).toBe(shareId);
		expect(page.items[0]?.lineage).toEqual({ id: lineage.lineageId, name: null });
	});

	it('paginates with nextCursor and refuses bad cursors', async () => {
		const owner = await member();
		const { lineageId } = await publish(owner.id);
		const now = Date.now();
		const ids = [
			await shareAt(lineageId, owner.id, now - 3000),
			await shareAt(lineageId, owner.id, now - 2000),
			await shareAt(lineageId, owner.id, now - 1000)
		].reverse();

		const first = (await (await myShares(signedIn(owner), '?limit=1')).json()) as SharePage;
		expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 1));
		expect(first.nextCursor).not.toBeNull();
		const cursor = encodeURIComponent(first.nextCursor ?? '');
		const rest = (await (
			await myShares(signedIn(owner), `?limit=5&cursor=${cursor}`)
		).json()) as SharePage;
		expect(rest.items.map((item) => item.id)).toEqual(ids.slice(1));
		expect(rest.nextCursor).toBeNull();

		expect(await code(await myShares(signedIn(owner), '?cursor=***'), 400)).toBe('INVALID_CURSOR');
		expect(await code(await myShares(signedIn(owner), '?limit=abc'), 400)).toBe('INVALID_BODY');
	});
});
