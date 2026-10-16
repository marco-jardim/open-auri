// T4.T visibility invariants, end to end through the real routes and services: a private lineage
// never appears in the feed, rankings, OG image, profile (API and page), curve search, someone
// else's share, someone else's pack or someone else's export; an unlisted lineage opens by id
// only. The lineages of this file share one curve that nobody else uses (unique curve, forced
// accepted), so "present" assertions are deterministic in the shared database.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { updateVisibility } from '#lib/server/account/profile.ts';
import { ApiError } from '#lib/server/api/index.ts';
import { ogResponse } from '#lib/server/og/route.ts';
import { publishCurve, type PublishedInfo } from '#lib/server/social/curves.ts';
import { socialSection } from '#lib/server/social/export.ts';
import { favoriteLineage } from '#lib/server/social/library.ts';
import { createOwnPack, viewPack } from '#lib/server/social/packs.ts';
import { listLineagesByCurve } from '#lib/server/social/repo.ts';
import { createShareFor, loadSharedCurve } from '#lib/server/social/shares.ts';
import { acceptAll, envelopeOf, uniqueRejectedCurve } from '../social/curves/helpers.ts';
import {
	ANONYMOUS,
	invoke,
	loadStatus,
	member,
	randomIp,
	syntheticEvent,
	textOf,
	type Member
} from './helpers.ts';

const feedRoute = () => import('../../../src/routes/api/v1/feed/+server.ts');
const rankingsRoute = () => import('../../../src/routes/api/v1/rankings/+server.ts');
const usersRoute = () => import('../../../src/routes/api/v1/users/[apelido]/+server.ts');
const curveRoute = () => import('../../../src/routes/api/v1/curves/[id]/+server.ts');
const lineageRoute = () => import('../../../src/routes/api/v1/lineages/[id]/+server.ts');
const profilePage = () => import('../../../src/routes/u/[apelido]/+page.server.ts');

interface World {
	author: Member;
	viewer: Member;
	third: Member;
	curveId: string;
	open: PublishedInfo;
	hidden: PublishedInfo;
	unlisted: PublishedInfo;
	names: { open: string; hidden: string; unlisted: string };
}

function tag(prefix: string): string {
	return `${prefix} ${crypto.randomUUID().slice(0, 8)}`;
}

async function world(): Promise<World> {
	const author = await member({ prefix: 'p4vis' });
	await updateVisibility(env.DB, author.user.id, { activity: 'public', library: 'public' });
	const viewer = await member({ prefix: 'p4vw' });
	const third = await member({ prefix: 'p4th' });
	const shape = uniqueRejectedCurve();
	const names = { open: tag('Aberta'), hidden: tag('Segredo'), unlisted: tag('Por link') };
	const publish = (name: string, visibility: 'public' | 'private' | 'unlisted') =>
		publishCurve(
			env.DB,
			author.user.id,
			{ envelope: envelopeOf(shape, { name }), visibility },
			{ gate: acceptAll }
		);
	const open = await publish(names.open, 'public');
	const hidden = await publish(names.hidden, 'private');
	const unlisted = await publish(names.unlisted, 'unlisted');
	return { author, viewer, third, curveId: open.curveId, open, hidden, unlisted, names };
}

function expectAbsent(text: string, w: World, label: string, unlistedToo = true): void {
	expect(text, label).not.toContain(w.hidden.lineageId);
	expect(text, label).not.toContain(w.hidden.versionId);
	expect(text, label).not.toContain(w.names.hidden);
	if (unlistedToo) {
		expect(text, label).not.toContain(w.unlisted.lineageId);
		expect(text, label).not.toContain(w.names.unlisted);
	}
}

const fakePng = async (svg: string): Promise<Uint8Array> => new TextEncoder().encode(svg);

function ogEvent(versionId: string) {
	return {
		request: new Request(`${env.PUBLIC_ORIGIN}/og/${versionId}.png`, {
			headers: { 'cf-connecting-ip': randomIp() }
		}),
		params: { id: versionId },
		locals: ANONYMOUS,
		platform: { env, ctx: { waitUntil: (promise: Promise<unknown>) => void promise } }
	};
}

describe('private and unlisted lineages stay out of every listing', () => {
	it('feed and rankings (anonymous and signed in), every sort and window', async () => {
		const w = await world();
		const feed = await feedRoute();
		const rankings = await rankingsRoute();
		for (const who of [ANONYMOUS, w.viewer.locals, w.third.locals]) {
			for (const query of ['?sort=new&limit=100', '?sort=favorites&window=all&limit=100']) {
				const response = await invoke(feed, 'GET', syntheticEvent('feed', 'GET', who, { query }));
				expect(response.status).toBe(200);
				expectAbsent(await textOf(response), w, `feed${query}`);
			}
			for (const query of ['?metric=favorites&window=all', '?metric=installs&window=7d']) {
				const response = await invoke(
					rankings,
					'GET',
					syntheticEvent('rankings', 'GET', who, { query: `${query}&limit=100` })
				);
				expect(response.status).toBe(200);
				expectAbsent(await textOf(response), w, `rankings${query}`);
			}
		}
	});

	it('profile: API overview and lists, and the /u page, show the public lineage only', async () => {
		const w = await world();
		const users = await usersRoute();
		const params = { apelido: w.author.user.username };
		for (const query of ['', '?list=lineages&limit=100', '?list=favorites', '?list=packs']) {
			for (const who of [ANONYMOUS, w.viewer.locals]) {
				const event = syntheticEvent('users/[apelido]', 'GET', who, { params, query });
				const response = await invoke(users, 'GET', event);
				expect(response.status, query).toBe(200);
				const text = await textOf(response);
				expectAbsent(text, w, `profile${query}`);
				if (query === '' || query.startsWith('?list=lineages')) {
					expect(text, query).toContain(w.open.lineageId);
				}
			}
		}
		const page = await profilePage();
		const overview = await page.load({ params, platform: { env } });
		const text = await textOf(overview);
		expectAbsent(text, w, '/u page');
		expect(text).toContain(w.open.lineageId);
	});

	it('curve search (lineages by curve): only the public one, plus the owner own ones', async () => {
		const w = await world();
		for (const viewer of [{ userId: null }, { userId: w.viewer.user.id }]) {
			const text = await textOf(await listLineagesByCurve(env.DB, w.curveId, viewer, 100));
			expectAbsent(text, w, `search as ${viewer.userId ?? 'anonymous'}`);
			expect(text).toContain(w.open.lineageId);
		}
		const owner = { userId: w.author.user.id };
		const own = await textOf(await listLineagesByCurve(env.DB, w.curveId, owner, 100));
		expect(own).toContain(w.hidden.lineageId);
	});

	it('OG image: private 404, unlisted and public rendered (linkable by id)', async () => {
		const w = await world();
		expect((await ogResponse(ogEvent(w.hidden.versionId), { render: fakePng })).status).toBe(404);
		expect((await ogResponse(ogEvent(w.unlisted.versionId), { render: fakePng })).status).toBe(200);
		expect((await ogResponse(ogEvent(w.open.versionId), { render: fakePng })).status).toBe(200);
	});

	it('unlisted: readable by id (API and /c), never listed', async () => {
		const w = await world();
		const curve = await curveRoute();
		const lineage = await lineageRoute();
		const params = { id: w.unlisted.lineageId };
		const anonymousRead = syntheticEvent('curves/[id]', 'GET', ANONYMOUS, { params });
		expect((await invoke(curve, 'GET', anonymousRead)).status).toBe(200);
		const history = await invoke(
			lineage,
			'GET',
			syntheticEvent('lineages/[id]', 'GET', w.viewer.locals, { params })
		);
		expect(history.status).toBe(200);
		const page = await loadSharedCurve(env.DB, { userId: null }, w.unlisted.lineageId, null);
		expect(page.kind).toBe('ok');
		// …and the private one is 404 for everyone but its owner, by id too.
		const hidden = { id: w.hidden.lineageId };
		for (const who of [ANONYMOUS, w.viewer.locals]) {
			const response = await invoke(
				curve,
				'GET',
				syntheticEvent('curves/[id]', 'GET', who, { params: hidden })
			);
			expect(response.status).toBe(404);
		}
		expect((await loadSharedCurve(env.DB, { userId: null }, w.hidden.lineageId, null)).kind).toBe(
			'not-found'
		);
	});
});

describe("someone else's share, pack and export", () => {
	it('a share of the private lineage is refused; the owner own share does not open it for others', async () => {
		const w = await world();
		await expect(
			createShareFor(env.DB, w.viewer.user.id, { lineageId: w.hidden.lineageId })
		).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
		const ownShare = await createShareFor(env.DB, w.author.user.id, {
			lineageId: w.hidden.lineageId
		});
		const opened = await loadSharedCurve(
			env.DB,
			{ userId: w.viewer.user.id },
			w.hidden.lineageId,
			ownShare.shareId
		);
		expect(opened.kind).toBe('not-found');
		// The share of an unlisted lineage works by link (linkable).
		const link = await createShareFor(env.DB, w.viewer.user.id, {
			lineageId: w.unlisted.lineageId
		});
		expect(link.url).toContain(w.unlisted.lineageId);
	});

	it('a pack of another user never lists private or unlisted lineages, even after the fact', async () => {
		const w = await world();
		const now = Date.now();
		await expect(
			createOwnPack(
				env.DB,
				w.viewer.user.id,
				{ name: 'Leaky pack', visibility: 'public', items: [{ lineageId: w.hidden.lineageId }] },
				now
			)
		).rejects.toBeInstanceOf(ApiError);
		const pack = await createOwnPack(
			env.DB,
			w.viewer.user.id,
			{
				name: 'Mixed pack',
				visibility: 'public',
				items: [{ lineageId: w.open.lineageId }, { lineageId: w.unlisted.lineageId }]
			},
			now
		).catch(() =>
			// Unlisted items may be refused up front (also fine): retry with the public one only.
			createOwnPack(
				env.DB,
				w.viewer.user.id,
				{ name: 'Mixed pack', visibility: 'public', items: [{ lineageId: w.open.lineageId }] },
				now
			)
		);
		const seen = await textOf(await viewPack(env.DB, pack.id, { userId: w.third.user.id }));
		expectAbsent(seen, w, "third party's view of the pack");
		expect(seen).toContain(w.open.lineageId);

		// The author closes the public lineage: it leaves the other user's pack at once.
		await env.DB.prepare("UPDATE lineages SET visibility = 'private' WHERE id = ?")
			.bind(w.open.lineageId)
			.run();
		const after = await textOf(await viewPack(env.DB, pack.id, { userId: w.third.user.id }));
		expect(after).not.toContain(w.open.lineageId);
		expect(after).not.toContain(w.names.open);
	});

	it("another user's export never carries the private lineage (nor its name or curve)", async () => {
		const w = await world();
		expect(await favoriteLineage(env.DB, w.viewer.user.id, w.hidden.lineageId)).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect((await favoriteLineage(env.DB, w.viewer.user.id, w.open.lineageId)).ok).toBe(true);
		await env.DB.prepare("UPDATE lineages SET visibility = 'private' WHERE id = ?")
			.bind(w.open.lineageId)
			.run();
		const exported = await textOf(
			await socialSection.collect({
				db: env.DB,
				userId: w.viewer.user.id,
				currentSessionId: null,
				now: Date.now()
			})
		);
		expectAbsent(exported, w, 'export of another user');
		expect(exported).not.toContain(w.names.open);
		// The author's own export has all three.
		const own = await textOf(
			await socialSection.collect({
				db: env.DB,
				userId: w.author.user.id,
				currentSessionId: null,
				now: Date.now()
			})
		);
		expect(own).toContain(w.hidden.lineageId);
		expect(own).toContain(w.unlisted.lineageId);
	});

	it('the /c page of a private lineage is 404 for others even with a valid share id', async () => {
		const w = await world();
		const page = await import('../../../src/routes/c/[id]/+page.server.ts');
		const share = await createShareFor(env.DB, w.author.user.id, {
			lineageId: w.hidden.lineageId
		});
		const url = new URL(`/c/${w.hidden.lineageId}?s=${share.shareId}`, env.PUBLIC_ORIGIN);
		const status = await loadStatus(async () =>
			Reflect.apply(page.load, undefined, [
				{
					params: { id: w.hidden.lineageId },
					url,
					request: new Request(url, { headers: { 'cf-connecting-ip': randomIp() } }),
					locals: w.viewer.locals,
					platform: { env }
				}
			])
		);
		expect(status).toBe(404);
	});
});
