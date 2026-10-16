// T4.2: reads (GET curves/[id], GET lineages/[id], ETag/304, cache headers), versions (409 on head
// divergence, concurrency), forks, retraction/restore (tombstone 410, moderation untouched) and
// visibility changes; invariant §0.12.4 on every path.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { loadPublishedCurve } from '#lib/server/social/curves.ts';
import { setModeration } from '#lib/server/social/repo.ts';
import {
	acceptAll,
	actor,
	call,
	count,
	envelopeOf,
	expectError,
	presetCurve,
	published,
	route,
	uniqueRejectedCurve,
	type Actor
} from './helpers.ts';

const curve = await route('curves/[id]/');
const lineage = await route('lineages/[id]/');
const versions = await route('lineages/[id]/versions/');
const fork = await route('lineages/[id]/fork/');
const retract = await route('lineages/[id]/retract/');
const restore = await route('lineages/[id]/restore/');
const visibility = await route('lineages/[id]/visibility/');

interface CurveBody {
	lineage: { id: string; visibility: string; status: string; moderation: string; isOwner: boolean };
	author: { username: string } | null;
	version: { id: string; isHead: boolean; license: string };
	curve: { id: string; gate: { ok: boolean } };
	counts: { favorites: number };
}

async function read(id: string, who?: Actor, query = ''): Promise<Response> {
	return call(curve, 'GET', { id, query, ...(who ? { locals: who.locals } : {}) });
}

/** A lineage whose (unique) head curve was accepted, then flipped to rejected in the cache. */
async function regatedToRejected(owner: Actor, vis: 'public' | 'private' = 'public') {
	const info = await published(owner, {
		visibility: vis,
		envelope: envelopeOf(uniqueRejectedCurve()),
		gate: acceptAll
	});
	await env.DB.prepare(`UPDATE curves SET gate_ok = 0, gate_reasons = '["k:test"]' WHERE id = ?`)
		.bind(info.curveId)
		.run();
	return info;
}

describe('GET /api/v1/curves/[id]', () => {
	it('anonymous read of a public curve: DTO, author nickname, ETag + public cache, 304', async () => {
		const owner = await actor();
		const info = await published(owner);
		const response = await read(info.lineageId);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
		const etag = response.headers.get('etag');
		expect(etag).toMatch(/^"/);
		const dto = (await response.json()) as CurveBody;
		expect(dto.lineage).toMatchObject({ id: info.lineageId, visibility: 'public', isOwner: false });
		expect(dto.author?.username).toBe(owner.user.username);
		expect(dto.version).toMatchObject({ id: info.versionId, isHead: true });
		expect(dto.curve).toMatchObject({ id: info.curveId, gate: { ok: true } });
		expect(dto.counts.favorites).toBe(0);
		expect(JSON.stringify(dto)).not.toContain(owner.user.id);
		expect(JSON.stringify(dto)).not.toContain(owner.user.email);
		const again = await call(curve, 'GET', {
			id: info.lineageId,
			headers: { 'if-none-match': etag ?? '' }
		});
		expect(again.status).toBe(304);
	});

	it('signed-in reads are private, no-store; the owner sees isOwner', async () => {
		const owner = await actor();
		const info = await published(owner);
		const response = await read(info.lineageId, owner);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(((await response.json()) as CurveBody).lineage.isOwner).toBe(true);
	});

	it('private: only the owner; anonymous and others get 404 (also lineages/[id])', async () => {
		const owner = await actor();
		const other = await actor();
		const info = await published(owner, { visibility: 'private' });
		await expectError(await read(info.lineageId), 404, 'NOT_FOUND');
		await expectError(await read(info.lineageId, other), 404, 'NOT_FOUND');
		expect((await read(info.lineageId, owner)).status).toBe(200);
		await expectError(
			await call(lineage, 'GET', { id: info.lineageId, locals: other.locals }),
			404,
			'NOT_FOUND'
		);
	});

	it('unlisted: readable by id; unknown or malformed ids are 404', async () => {
		const owner = await actor();
		const info = await published(owner, { visibility: 'unlisted' });
		expect((await read(info.lineageId)).status).toBe(200);
		await expectError(await read('nope'), 404, 'NOT_FOUND');
		await expectError(await read(`missing-${crypto.randomUUID()}`), 404, 'NOT_FOUND');
	});

	it('banned owner: the lineage disappears for others', async () => {
		const owner = await actor();
		const info = await published(owner);
		await env.DB.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').bind(owner.user.id).run();
		await expectError(await read(info.lineageId), 404, 'NOT_FOUND');
	});
});

describe('versions', () => {
	it('owner appends with parent = head; history lists both; ?v= reads the old one', async () => {
		const owner = await actor();
		const info = await published(owner);
		const response = await call(versions, 'POST', {
			id: info.lineageId,
			locals: owner.locals,
			body: { parentVersionId: info.versionId, envelope: envelopeOf(presetCurve(3)) }
		});
		expect(response.status).toBe(201);
		const next = (await response.json()) as { versionId: string; lineageId: string };
		expect(next.lineageId).toBe(info.lineageId);
		const history = await call(lineage, 'GET', { id: info.lineageId, query: '?limit=1' });
		expect(history.status).toBe(200);
		const page = (await history.json()) as {
			versions: { id: string; isHead: boolean; parentId: string | null }[];
			nextCursor: string | null;
		};
		expect(page.versions).toEqual([
			expect.objectContaining({ id: next.versionId, isHead: true, parentId: info.versionId })
		]);
		expect(page.nextCursor).not.toBeNull();
		const second = await call(lineage, 'GET', {
			id: info.lineageId,
			query: `?limit=1&cursor=${page.nextCursor ?? ''}`
		});
		const rest = (await second.json()) as { versions: { id: string }[] };
		expect(rest.versions.map((v) => v.id)).toEqual([info.versionId]);
		const old = await read(info.lineageId, undefined, `?v=${info.versionId}`);
		expect(((await old.json()) as CurveBody).version).toMatchObject({
			id: info.versionId,
			isHead: false
		});
		await expectError(
			await call(lineage, 'GET', { id: info.lineageId, query: '?cursor=%%%' }),
			400,
			'INVALID_CURSOR'
		);
	});

	it('409 HEAD_MOVED for a stale parent; 404 for other users; 403 unverified', async () => {
		const owner = await actor();
		const other = await actor();
		const info = await published(owner);
		const first = await call(versions, 'POST', {
			id: info.lineageId,
			locals: owner.locals,
			body: { parentVersionId: info.versionId, envelope: envelopeOf(presetCurve(4)) }
		});
		expect(first.status).toBe(201);
		const stale = { parentVersionId: info.versionId, envelope: envelopeOf(presetCurve(5)) };
		await expectError(
			await call(versions, 'POST', { id: info.lineageId, locals: owner.locals, body: stale }),
			409,
			'HEAD_MOVED'
		);
		await expectError(
			await call(versions, 'POST', { id: info.lineageId, locals: other.locals, body: stale }),
			404,
			'NOT_FOUND'
		);
		const unverified = await actor({ verified: false });
		await expectError(
			await call(versions, 'POST', { id: info.lineageId, locals: unverified.locals, body: stale }),
			403,
			'EMAIL_NOT_VERIFIED'
		);
	});

	it('two concurrent versions with the same parent: exactly one wins', async () => {
		const owner = await actor();
		const info = await published(owner);
		const attempt = (index: number) =>
			call(versions, 'POST', {
				id: info.lineageId,
				locals: owner.locals,
				body: { parentVersionId: info.versionId, envelope: envelopeOf(presetCurve(index)) }
			});
		const responses = await Promise.all([attempt(6), attempt(7)]);
		expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
		const loser = responses.find((r) => r.status === 409);
		if (loser) await expectError(loser, 409, 'HEAD_MOVED');
		expect(
			await count('SELECT count(*) AS n FROM versions WHERE lineage_id = ?', info.lineageId)
		).toBe(2);
	});

	it('gate-rejected new version: 422 and the head does not move', async () => {
		const owner = await actor();
		const info = await published(owner);
		await expectError(
			await call(versions, 'POST', {
				id: info.lineageId,
				locals: owner.locals,
				body: { parentVersionId: info.versionId, envelope: envelopeOf(uniqueRejectedCurve()) }
			}),
			422,
			'GATE_REJECTED'
		);
		expect(
			await count('SELECT count(*) AS n FROM versions WHERE lineage_id = ?', info.lineageId)
		).toBe(1);
	});
});

describe('forks', () => {
	it('public CC-BY source: private by default, attribution kept, license stays CC-BY', async () => {
		const owner = await actor();
		const forker = await actor();
		const info = await published(owner, {
			envelope: envelopeOf(presetCurve(2), { license: 'CC-BY-4.0' })
		});
		const response = await call(fork, 'POST', {
			id: info.lineageId,
			locals: forker.locals,
			body: {}
		});
		expect(response.status).toBe(201);
		const created = (await response.json()) as {
			lineageId: string;
			forkedFrom: { lineageId: string; versionId: string };
			attribution: { license: string; author: { username: string } | null } | null;
		};
		expect(created.forkedFrom).toEqual({ lineageId: info.lineageId, versionId: info.versionId });
		expect(created.attribution?.license).toBe('CC-BY-4.0');
		expect(created.attribution?.author?.username).toBe(owner.user.username);
		await expectError(await read(created.lineageId), 404, 'NOT_FOUND');
		const mine = (await (await read(created.lineageId, forker)).json()) as CurveBody;
		expect(mine.lineage.visibility).toBe('private');
		expect(mine.version.license).toBe('CC-BY-4.0');
		const relicensed = envelopeOf(presetCurve(2), { license: 'CC0-1.0' });
		const error = await expectError(
			await call(fork, 'POST', {
				id: info.lineageId,
				locals: forker.locals,
				body: { envelope: relicensed, visibility: 'public' }
			}),
			422,
			'INVALID_CURVE'
		);
		expect((error.details as { codes: string[] }).codes).toEqual(['env:enum']);
	});

	it('CC0 source: no attribution; visibility from the body; unlisted source by id', async () => {
		const owner = await actor();
		const forker = await actor();
		const info = await published(owner, { visibility: 'unlisted' });
		const response = await call(fork, 'POST', {
			id: info.lineageId,
			locals: forker.locals,
			body: { visibility: 'public' }
		});
		expect(response.status).toBe(201);
		const created = (await response.json()) as { lineageId: string; attribution: unknown };
		expect(created.attribution).toBeNull();
		expect((await read(created.lineageId)).status).toBe(200);
	});

	it('private source: 404 for others, allowed for the owner; anonymous 401', async () => {
		const owner = await actor();
		const other = await actor();
		const info = await published(owner, { visibility: 'private' });
		await expectError(
			await call(fork, 'POST', { id: info.lineageId, locals: other.locals, body: {} }),
			404,
			'NOT_FOUND'
		);
		await expectError(
			await call(fork, 'POST', { id: info.lineageId, body: {} }),
			401,
			'AUTH_REQUIRED'
		);
		const own = await call(fork, 'POST', { id: info.lineageId, locals: owner.locals, body: {} });
		expect(own.status).toBe(201);
	});

	it('head now gate-rejected: refused for the owner (422) and invisible to others (404)', async () => {
		const owner = await actor();
		const other = await actor();
		const info = await regatedToRejected(owner);
		await expectError(
			await call(fork, 'POST', { id: info.lineageId, locals: other.locals, body: {} }),
			404,
			'NOT_FOUND'
		);
		await expectError(
			await call(fork, 'POST', { id: info.lineageId, locals: owner.locals, body: {} }),
			422,
			'GATE_REJECTED'
		);
		expect(
			await count(
				'SELECT count(*) AS n FROM lineages WHERE forked_from_version = ?',
				info.versionId
			)
		).toBe(0);
	});
});

describe('retract, restore and visibility', () => {
	it('tombstone: 410 for others, 200 for the owner; restore brings it back', async () => {
		const owner = await actor();
		const other = await actor();
		const info = await published(owner);
		await expectError(
			await call(retract, 'POST', { id: info.lineageId, locals: other.locals }),
			404,
			'NOT_FOUND'
		);
		const done = await call(retract, 'POST', { id: info.lineageId, locals: owner.locals });
		expect(done.status).toBe(200);
		expect(await done.json()).toMatchObject({ status: 'retracted' });
		await expectError(await read(info.lineageId), 410, 'GONE');
		await expectError(await read(info.lineageId, other), 410, 'GONE');
		await expectError(await call(lineage, 'GET', { id: info.lineageId }), 410, 'GONE');
		await expectError(
			await call(fork, 'POST', { id: info.lineageId, locals: other.locals, body: {} }),
			410,
			'GONE'
		);
		expect(((await (await read(info.lineageId, owner)).json()) as CurveBody).lineage.status).toBe(
			'retracted'
		);
		await expectError(
			await call(restore, 'POST', { id: info.lineageId, locals: other.locals }),
			404,
			'NOT_FOUND'
		);
		const back = await call(restore, 'POST', { id: info.lineageId, locals: owner.locals });
		expect(back.status).toBe(200);
		expect((await read(info.lineageId)).status).toBe(200);
	});

	it('a retracted private lineage is a plain 404 (no existence leak)', async () => {
		const owner = await actor();
		const info = await published(owner, { visibility: 'private' });
		expect((await call(retract, 'POST', { id: info.lineageId, locals: owner.locals })).status).toBe(
			200
		);
		await expectError(await read(info.lineageId), 404, 'NOT_FOUND');
	});

	it('restore never undoes moderation', async () => {
		const owner = await actor();
		const info = await published(owner);
		await call(retract, 'POST', { id: info.lineageId, locals: owner.locals });
		await setModeration(env.DB, 'lineage', info.lineageId, 'hidden', Date.now());
		const back = await call(restore, 'POST', { id: info.lineageId, locals: owner.locals });
		expect(back.status).toBe(200);
		expect(await back.json()).toMatchObject({ status: 'active', moderation: 'hidden' });
		await expectError(await read(info.lineageId), 404, 'NOT_FOUND');
		expect(
			await count(
				`SELECT count(*) AS n FROM lineages WHERE id = ? AND moderation = 'hidden'`,
				info.lineageId
			)
		).toBe(1);
		const viewer = { userId: null };
		expect((await loadPublishedCurve(env.DB, info.lineageId, viewer)).kind).toBe('not-found');
	});

	it('visibility: owner only; private hides, unlisted opens by id', async () => {
		const owner = await actor();
		const other = await actor();
		const info = await published(owner);
		await expectError(
			await call(visibility, 'PUT', {
				id: info.lineageId,
				locals: other.locals,
				body: { visibility: 'private' }
			}),
			404,
			'NOT_FOUND'
		);
		const hidden = await call(visibility, 'PUT', {
			id: info.lineageId,
			locals: owner.locals,
			body: { visibility: 'private' }
		});
		expect(hidden.status).toBe(200);
		await expectError(await read(info.lineageId), 404, 'NOT_FOUND');
		const open = await call(visibility, 'PUT', {
			id: info.lineageId,
			locals: owner.locals,
			body: { visibility: 'unlisted' }
		});
		expect(await open.json()).toMatchObject({ visibility: 'unlisted' });
		expect((await read(info.lineageId)).status).toBe(200);
		await expectError(
			await call(visibility, 'PUT', {
				id: info.lineageId,
				locals: owner.locals,
				body: { visibility: 'everyone' }
			}),
			400,
			'INVALID_BODY'
		);
	});

	it('a now-rejected head can be neither opened nor restored into view', async () => {
		const owner = await actor();
		const info = await regatedToRejected(owner, 'private');
		await expectError(
			await call(visibility, 'PUT', {
				id: info.lineageId,
				locals: owner.locals,
				body: { visibility: 'public' }
			}),
			422,
			'GATE_REJECTED'
		);
		expect(
			await count(
				`SELECT count(*) AS n FROM lineages WHERE id = ? AND visibility = 'private'`,
				info.lineageId
			)
		).toBe(1);
		const shown = await regatedToRejected(owner, 'public');
		await call(retract, 'POST', { id: shown.lineageId, locals: owner.locals });
		await expectError(
			await call(restore, 'POST', { id: shown.lineageId, locals: owner.locals }),
			422,
			'GATE_REJECTED'
		);
		await expectError(await read(shown.lineageId), 404, 'NOT_FOUND');
	});
});
