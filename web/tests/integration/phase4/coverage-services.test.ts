// T4.T coverage top-up: focused tests for branches the per-service suites leave open (refusals,
// error mappings, alternate paths), in curves, shares, library, packs, trades, the social queries,
// rankings, the gate cache and the OG store/route/warm-up. Each case asserts behaviour, not just
// execution. Dead branches are listed in ./README.md instead of being forced here.
//
// Isolation: ids, nicknames and curves are unique per test; trades run in a far-future time window
// where the trades of other files are already expired (see social/trades/trades.test.ts).
import { env } from 'cloudflare:workers';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { canonKey, curveId, decodeS1, encodeS1 } from 'open-auri/share';
import { describe, expect, it } from 'vitest';
import { strongEtag } from '#lib/server/api/cache.ts';
import { ApiError } from '#lib/server/api/index.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { loadOgFonts, resetOgFonts, toArrayBuffer, type OgAssets } from '#lib/server/og/render.ts';
import { ogResponse } from '#lib/server/og/route.ts';
import { errorName, getOrCreateOg, ogKey, type OgEnv } from '#lib/server/og/store.ts';
import { OG_CARD_VERSION } from '#lib/server/og/keys.ts';
import { ogEnvOf } from '#lib/server/og/warm.ts';
import { recordOutbox } from '#lib/server/social/activity.ts';
import {
	appendCurveVersion,
	changeVisibility,
	forkCurve,
	loadLineageVersions,
	loadPublishedCurve,
	readResponse,
	repoError as curvesRepoError,
	restoreCurve,
	retractCurve,
	type ForkBody
} from '#lib/server/social/curves.ts';
import { checkCurve, regateStale } from '#lib/server/social/gate.ts';
import {
	favoriteLineage,
	listLibrary,
	mergeLocalLibrary,
	unfavoriteLineage
} from '#lib/server/social/library.ts';
import {
	checkPackItems,
	cleanPackText,
	createOwnPack,
	editOwnPack,
	removeOwnPack,
	repoError as packsRepoError,
	viewPack
} from '#lib/server/social/packs.ts';
import { isLinkableTombstone } from '#lib/server/social/queries/curves.ts';
import { ownHeadNames } from '#lib/server/social/queries/library.ts';
import { headLicensesForOwner } from '#lib/server/social/queries/packs.ts';
import { isRetractedLinkable } from '#lib/server/social/queries/shares.ts';
import { rankingsApiError } from '#lib/server/social/rankings.ts';
import { createTrade, publishLineage } from '#lib/server/social/repo.ts';
import {
	createShareFor,
	loadSharedCurve,
	recordShareOpen,
	sharedCurveMeta,
	shareStatsFor
} from '#lib/server/social/shares.ts';
import {
	cancelMyTrade,
	joinTrade,
	listMyTrades,
	retryWaitingPairs,
	scoreMyTrade
} from '#lib/server/social/trades.ts';
import {
	LOOKUP_IDS_MAX,
	PACK_ITEMS_MAX,
	SOCIAL_ERROR_CODES,
	SocialRepoError,
	TRADE_TTL_MS,
	type SocialErrorCode
} from '#lib/server/social/types.ts';
import { seedUser, uid } from '../account/helpers.ts';
import {
	actor,
	envelopeOf,
	presetCurve,
	published,
	uniqueRejectedCurve
} from '../social/curves/helpers.ts';
import { curveInput, publish, versionInput } from '../social/repo/helpers.ts';
import { ANONYMOUS, missingId, randomIp } from './helpers.ts';

/** The ApiError a promise rejects with (fails the test for anything else). */
async function apiFailure(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ApiError) return { status: error.status, code: error.code };
		throw error;
	}
	throw new Error('expected an ApiError');
}

const ANON_VIEWER = { userId: null };

// ---- curves.ts -----------------------------------------------------------------------------------

describe('curves service: error mapping and alternate paths', () => {
	it('repoError maps every repository code to its stable API error', () => {
		const expected: Record<SocialErrorCode, [number, string]> = {
			'not-found': [404, 'NOT_FOUND'],
			'invalid-input': [400, 'INVALID_BODY'],
			'invalid-cursor': [400, 'INVALID_CURSOR'],
			'head-moved': [409, 'HEAD_MOVED'],
			'gate-rejected': [422, 'GATE_REJECTED'],
			retracted: [409, 'CONFLICT'],
			duplicate: [409, 'DUPLICATE'],
			'already-active': [409, 'ALREADY_ACTIVE'],
			limit: [400, 'INVALID_BODY']
		};
		for (const code of SOCIAL_ERROR_CODES) {
			const error = curvesRepoError(code);
			expect([error.status, error.code], code).toEqual(expected[code]);
		}
	});

	it('readResponse: 410/404 errors; anonymous private reads are never publicly cached', async () => {
		const request = new Request(`${env.PUBLIC_ORIGIN}/api/v1/curves/x`);
		expect(await apiFailure(readResponse(request, { kind: 'gone' }, true))).toEqual({
			status: 410,
			code: 'GONE'
		});
		expect(await apiFailure(readResponse(request, { kind: 'not-found' }, false))).toMatchObject({
			status: 404
		});
		const value = { lineage: { visibility: 'private' as const } };
		const closed = await readResponse(request, { kind: 'ok', value }, true);
		expect(closed.headers.get('cache-control')).toContain('no-store');
		expect(closed.headers.get('etag')).toBeNull();
		const open = { lineage: { visibility: 'unlisted' as const } };
		const shared = await readResponse(request, { kind: 'ok', value: open }, true);
		expect(shared.headers.get('etag')).not.toBeNull();
	});

	it('loadPublishedCurve with a version id: malformed, foreign, head', async () => {
		const owner = await actor();
		const source = await published(owner);
		const other = await published(owner);
		const read = (versionId?: string | null) =>
			loadPublishedCurve(env.DB, source.lineageId, ANON_VIEWER, versionId);
		expect((await loadPublishedCurve(env.DB, 'bad id!', ANON_VIEWER)).kind).toBe('not-found');
		expect((await read('x')).kind).toBe('not-found');
		expect((await read(other.versionId)).kind).toBe('not-found');
		const head = await read(source.versionId);
		if (head.kind !== 'ok') throw new Error('head should be readable');
		expect(head.value.version.isHead).toBe(true);
		expect((await read(null)).kind).toBe('ok');
	});

	it('loadLineageVersions: malformed and unknown ids are 404, a forged cursor is 400', async () => {
		const owner = await actor();
		const source = await published(owner);
		expect((await loadLineageVersions(env.DB, 'bad id!', ANON_VIEWER)).kind).toBe('not-found');
		expect((await loadLineageVersions(env.DB, missingId(), ANON_VIEWER)).kind).toBe('not-found');
		expect(
			await apiFailure(
				loadLineageVersions(env.DB, source.lineageId, ANON_VIEWER, { cursor: 'not-a-cursor' })
			)
		).toEqual({ status: 400, code: 'INVALID_CURSOR' });
	});

	it('fork refusals: malformed or unknown source, foreign version, own retracted or hidden source', async () => {
		const owner = await actor();
		const forker = await actor();
		const source = await published(owner);
		const other = await published(owner);
		const fork = (who: string, id: string, body: ForkBody = {}) =>
			apiFailure(forkCurve(env.DB, who, id, body));
		expect(await fork(forker.user.id, 'bad id!')).toMatchObject({ status: 404 });
		expect(await fork(forker.user.id, missingId())).toMatchObject({ status: 404 });
		expect(
			await fork(forker.user.id, source.lineageId, { versionId: other.versionId })
		).toMatchObject({ status: 404 });
		expect(await fork(forker.user.id, source.lineageId, { versionId: 'x' })).toMatchObject({
			status: 404
		});

		const hidden = await published(owner);
		await env.DB.prepare("UPDATE lineages SET moderation = 'hidden' WHERE id = ?")
			.bind(hidden.lineageId)
			.run();
		expect(await fork(owner.user.id, hidden.lineageId)).toMatchObject({ status: 404 });

		const gone = await published(owner);
		await retractCurve(env.DB, owner.user.id, gone.lineageId);
		expect(await fork(owner.user.id, gone.lineageId)).toEqual({ status: 410, code: 'GONE' });
		// A retracted lineage cannot get new versions either (409).
		expect(
			await apiFailure(
				appendCurveVersion(env.DB, owner.user.id, gone.lineageId, {
					parentVersionId: gone.versionId,
					envelope: envelopeOf(presetCurve(1))
				})
			)
		).toEqual({ status: 409, code: 'CONFLICT' });
	});

	it('a CC-BY source cannot be forked into CC0 (422 INVALID_CURVE env:enum)', async () => {
		const owner = await actor();
		const forker = await actor();
		const source = await published(owner, {
			envelope: envelopeOf(presetCurve(0), { license: 'CC-BY-4.0' })
		});
		let details: unknown = null;
		try {
			await forkCurve(env.DB, forker.user.id, source.lineageId, {
				envelope: envelopeOf(presetCurve(0), { license: 'CC0-1.0' })
			});
		} catch (error) {
			if (!(error instanceof ApiError)) throw error;
			expect([error.status, error.code]).toEqual([422, 'INVALID_CURVE']);
			details = error.details;
		}
		expect(details).toEqual({ codes: ['env:enum'] });
	});

	it('opening a lineage whose head no longer decodes is refused; restoring a private one skips the gate', async () => {
		const owner = await seedUser({});
		const broken = await publish(owner.id, { visibility: 'private' });
		const opened = await apiFailure(changeVisibility(env.DB, owner.id, broken.lineageId, 'public'));
		expect(opened).toMatchObject({ status: 422, code: 'GATE_REJECTED' });

		await retractCurve(env.DB, owner.id, broken.lineageId);
		expect(await restoreCurve(env.DB, owner.id, broken.lineageId)).toMatchObject({
			status: 'active',
			visibility: 'private'
		});
	});

	it('text that normalizes to nothing is refused (422 INVALID_CURVE)', async () => {
		const owner = await actor();
		for (const overrides of [{ description: '\u200b\u200b' }, { name: '\u200b' }]) {
			const failure = await apiFailure(
				published(owner, { envelope: envelopeOf(presetCurve(0), overrides) })
			);
			expect(failure, JSON.stringify(overrides)).toEqual({ status: 422, code: 'INVALID_CURVE' });
		}
	});
});

// ---- shares.ts -----------------------------------------------------------------------------------

describe('shares service: refusals and shared versions', () => {
	it('createShareFor and shareStatsFor refuse malformed, unknown and foreign ids', async () => {
		const owner = await actor();
		const source = await published(owner);
		const other = await published(owner);
		const user = owner.user.id;
		expect(await apiFailure(createShareFor(env.DB, user, { lineageId: 'bad id!' }))).toMatchObject({
			status: 404
		});
		const malformedVersion = { lineageId: source.lineageId, versionId: 'x' };
		expect(await apiFailure(createShareFor(env.DB, user, malformedVersion))).toMatchObject({
			status: 404
		});
		const foreign = await apiFailure(
			createShareFor(env.DB, user, { lineageId: source.lineageId, versionId: other.versionId })
		);
		expect([400, 404]).toContain(foreign.status);
		expect(await apiFailure(shareStatsFor(env.DB, user, 'bad id!'))).toMatchObject({ status: 404 });
		expect(await apiFailure(shareStatsFor(env.DB, user, missingId()))).toMatchObject({
			status: 404
		});
		expect(await recordShareOpen(env.DB, 'bad id!')).toBe(false);
	});

	it('loadSharedCurve: an older shared version, the head, a foreign or malformed share', async () => {
		const owner = await actor();
		const source = await published(owner);
		const other = await published(owner);
		const next = await appendCurveVersion(env.DB, owner.user.id, source.lineageId, {
			parentVersionId: source.versionId,
			envelope: envelopeOf(presetCurve(1), { name: 'Segunda versão' })
		});
		const old = await createShareFor(env.DB, owner.user.id, {
			lineageId: source.lineageId,
			versionId: source.versionId
		});
		const atHead = await createShareFor(env.DB, owner.user.id, {
			lineageId: source.lineageId,
			versionId: next.versionId
		});
		const foreign = await createShareFor(env.DB, owner.user.id, { lineageId: other.lineageId });
		const load = (shareId: string | null) =>
			loadSharedCurve(env.DB, ANON_VIEWER, source.lineageId, shareId);

		const shown = await load(old.shareId);
		if (shown.kind !== 'ok') throw new Error('expected the shared curve');
		expect(shown.curve).toMatchObject({
			versionId: source.versionId,
			isHead: false,
			shareId: old.shareId
		});
		const head = await load(atHead.shareId);
		expect(head.kind === 'ok' && head.curve.isHead).toBe(true);
		const notOurs = await load(foreign.shareId);
		expect(notOurs.kind === 'ok' && notOurs.curve.shareId).toBeNull();
		const malformed = await load('x');
		expect(malformed.kind === 'ok' && malformed.curve.shareId).toBeNull();
		expect((await loadSharedCurve(env.DB, ANON_VIEWER, 'bad id!', null)).kind).toBe('not-found');
	});

	it('a retracted linkable lineage is gone for its owner and for everyone else', async () => {
		const owner = await actor();
		const source = await published(owner);
		await retractCurve(env.DB, owner.user.id, source.lineageId);
		const viewers = [ANON_VIEWER, { userId: owner.user.id }];
		for (const viewer of viewers) {
			expect((await loadSharedCurve(env.DB, viewer, source.lineageId, null)).kind).toBe('gone');
		}
	});

	it('sharedCurveMeta: absolute URLs without a doubled slash; unlisted is not indexable', async () => {
		const owner = await actor();
		const source = await published(owner, { visibility: 'unlisted' });
		const loaded = await loadSharedCurve(env.DB, ANON_VIEWER, source.lineageId, null);
		if (loaded.kind !== 'ok') throw new Error('unlisted should open by id');
		const meta = sharedCurveMeta('https://open-auri.example//', loaded.curve);
		expect(meta).toEqual({
			canonical: `https://open-auri.example/c/${source.lineageId}`,
			image: `https://open-auri.example/og/${source.versionId}.png`,
			indexable: false
		});
	});
});

// ---- library.ts ----------------------------------------------------------------------------------

async function mergeLineageId(userId: string, s1: string): Promise<string> {
	const { bands, preampDb } = decodeS1(s1);
	const material = new TextEncoder().encode(
		`open-auri:library-merge:v1\n${userId}\n${canonKey(bands, preampDb)}`
	);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
	let binary = '';
	for (const byte of digest.slice(0, 18)) binary += String.fromCharCode(byte);
	return `lm${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

describe('library service: refusals, filters and the merge race', () => {
	it('favorites: malformed ids and foreign or malformed shares change nothing', async () => {
		const owner = await actor();
		const fan = await actor();
		const source = await published(owner);
		const other = await published(owner);
		const foreign = await createShareFor(env.DB, owner.user.id, { lineageId: other.lineageId });
		expect(await favoriteLineage(env.DB, fan.user.id, 'bad id!')).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await unfavoriteLineage(env.DB, fan.user.id, 'bad id!')).toEqual({ removed: false });
		expect(
			await favoriteLineage(env.DB, fan.user.id, source.lineageId, { shareId: foreign.shareId })
		).toEqual({ ok: true, created: true, attributed: false });
		expect(await unfavoriteLineage(env.DB, fan.user.id, source.lineageId)).toEqual({
			removed: true
		});
		expect(await favoriteLineage(env.DB, fan.user.id, source.lineageId, { shareId: 'x' })).toEqual({
			ok: true,
			created: true,
			attributed: false
		});
	});

	it('shelves: created filtered by visibility with a limit; favorites and installed with a limit', async () => {
		const owner = await actor();
		await published(owner, { visibility: 'private' });
		await published(owner, { visibility: 'private' });
		await published(owner, { visibility: 'public' });
		const page = await listLibrary(env.DB, owner.user.id, {
			shelf: 'created',
			visibility: 'private',
			limit: 1
		});
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.visibility).toBe('private');
		expect(page.nextCursor).not.toBeNull();
		for (const shelf of ['favorites', 'installed'] as const) {
			expect((await listLibrary(env.DB, owner.user.id, { shelf, limit: 5 })).items).toEqual([]);
		}
	});

	it('merge: the deterministic lineage id already taken by the same user → name conflict', async () => {
		const user = await seedUser({});
		const s1 = encodeS1(presetCurve(5));
		const taken = await mergeLineageId(user.id, s1);
		const pre = await publishLineage(env.DB, {
			lineageId: taken,
			ownerUserId: user.id,
			visibility: 'private',
			curve: curveInput(),
			version: versionInput({ name: 'Nome anterior' }),
			now: Date.now()
		});
		expect(pre.ok).toBe(true);
		const report = await mergeLocalLibrary(env.DB, user.id, [
			{ localId: 'a', s1, name: 'Outro nome' }
		]);
		expect(report.conflicts).toEqual([{ localId: 'a', lineageId: taken, field: 'name' }]);
		expect(report.created).toEqual([]);
	});

	it('merge: the deterministic id taken by another account → rejected DUPLICATE', async () => {
		const user = await seedUser({});
		const squatter = await seedUser({});
		const s1 = encodeS1(presetCurve(6));
		const pre = await publishLineage(env.DB, {
			lineageId: await mergeLineageId(user.id, s1),
			ownerUserId: squatter.id,
			visibility: 'private',
			curve: curveInput(),
			version: versionInput(),
			now: Date.now()
		});
		expect(pre.ok).toBe(true);
		const report = await mergeLocalLibrary(env.DB, user.id, [{ localId: 'b', s1, name: 'Nome' }]);
		expect(report.rejected).toEqual([{ localId: 'b', code: 'DUPLICATE' }]);
	});
});

// ---- packs.ts ------------------------------------------------------------------------------------

describe('packs service: text, items and ownership refusals', () => {
	it('repoError maps every repository code to an API error', () => {
		for (const code of SOCIAL_ERROR_CODES) {
			const error = packsRepoError(code);
			expect(error, code).toBeInstanceOf(ApiError);
			expect(error.status, code).toBeGreaterThanOrEqual(400);
			expect(error.status, code).toBeLessThan(500);
		}
		expect(packsRepoError('limit').code).toBe('QUOTA_EXCEEDED');
		expect(packsRepoError('retracted').code).toBe('GONE');
	});

	it('cleanPackText: blank description is empty; blank, URL-like or too long names are 400', () => {
		expect(cleanPackText('description', '   \n ')).toBe('');
		for (const value of ['   ', 'https://evil.example/pack', 'x'.repeat(5000)]) {
			let status = 0;
			try {
				cleanPackText('name', value);
			} catch (error) {
				if (!(error instanceof ApiError)) throw error;
				status = error.status;
			}
			expect(status, value.slice(0, 20)).toBe(400);
		}
	});

	it('checkPackItems refuses too many, malformed, repeated, unknown and license-mismatched items', async () => {
		const owner = await actor();
		const source = await published(owner);
		const id = source.lineageId;
		const check = (items: { lineageId: string; license?: 'CC0-1.0' | 'CC-BY-4.0' }[]) =>
			apiFailure(checkPackItems(env.DB, owner.user.id, items));
		const many = Array.from({ length: PACK_ITEMS_MAX + 1 }, () => ({ lineageId: id }));
		expect(await check(many)).toMatchObject({ status: 400 });
		expect(await check([{ lineageId: 'bad id!' }])).toMatchObject({ status: 400 });
		expect(await check([{ lineageId: id }, { lineageId: id }])).toMatchObject({ status: 400 });
		expect(await check([{ lineageId: missingId() }])).toMatchObject({ status: 404 });
		expect(await check([{ lineageId: id, license: 'CC-BY-4.0' }])).toEqual({
			status: 409,
			code: 'CONFLICT'
		});
		const matching = [{ lineageId: id, license: 'CC0-1.0' as const }];
		expect(await checkPackItems(env.DB, owner.user.id, matching)).toEqual([id]);
	});

	it('malformed ids, empty item lists, item edits and editing someone else’s pack', async () => {
		const owner = await actor();
		const stranger = await actor();
		const source = await published(owner);
		const now = Date.now();
		expect(await viewPack(env.DB, 'bad id!', ANON_VIEWER)).toBeNull();
		expect(await removeOwnPack(env.DB, 'bad id!', owner.user.id)).toBe(false);
		expect(
			await apiFailure(editOwnPack(env.DB, 'bad id!', owner.user.id, { name: 'x' }, now))
		).toMatchObject({ status: 404 });

		const pack = await createOwnPack(env.DB, owner.user.id, { name: 'Vazio', items: [] }, now);
		expect(pack.items).toEqual([]);
		expect(pack.description).toBe('');
		const edited = await editOwnPack(
			env.DB,
			pack.id,
			owner.user.id,
			{ description: 'Com uma curva', items: [{ lineageId: source.lineageId }] },
			now
		);
		expect(edited.items).toHaveLength(1);
		expect(
			await apiFailure(editOwnPack(env.DB, pack.id, stranger.user.id, { name: 'Meu' }, now))
		).toMatchObject({ status: 404 });
		expect(await removeOwnPack(env.DB, pack.id, stranger.user.id)).toBe(false);
	});
});

// ---- trades.ts -----------------------------------------------------------------------------------

/** Far beyond the windows of social/trades/trades.test.ts (base + slots × 10 TTL, ~1 100 TTL). */
const FAR = Date.now() + 100_000 * TRADE_TTL_MS;

describe('trades service: input refusals, states and the pairing retry', () => {
	it('join, score and cancel refuse malformed input and unknown trades', async () => {
		const user = await seedUser({});
		expect(await joinTrade(env.DB, user.id, { lineageId: 'bad id!' })).toEqual({
			ok: false,
			code: 'invalid-input'
		});
		expect(await joinTrade(env.DB, user.id, { lineageId: missingId(), versionId: 'x' })).toEqual({
			ok: false,
			code: 'invalid-input'
		});
		for (const score of [0, 6, 2.5]) {
			expect(await scoreMyTrade(env.DB, user.id, missingId(), score)).toEqual({
				ok: false,
				code: 'invalid-input'
			});
		}
		expect(await scoreMyTrade(env.DB, user.id, 'bad id!', 3)).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await scoreMyTrade(env.DB, user.id, missingId(), 3)).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await cancelMyTrade(env.DB, user.id, 'bad id!')).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await cancelMyTrade(env.DB, user.id, missingId())).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await listMyTrades(env.DB, user.id, { cursor: 'not-a-cursor' })).toEqual({
			ok: false,
			code: 'invalid-cursor'
		});
	});

	it('cancelling a trade twice: the second is not-active', async () => {
		const user = await seedUser({});
		const own = await publish(user.id);
		const id = uid('trade');
		const created = await createTrade(env.DB, {
			id,
			userId: user.id,
			lineageId: own.lineageId,
			versionId: own.versionId,
			now: FAR + 50 * TRADE_TTL_MS
		});
		expect(created.ok).toBe(true);
		expect(await cancelMyTrade(env.DB, user.id, id)).toEqual({
			ok: true,
			value: { cancelled: true }
		});
		expect(await cancelMyTrade(env.DB, user.id, id)).toEqual({ ok: false, code: 'not-active' });
	});

	it('retryWaitingPairs pairs two waiting trades that missed each other, once', async () => {
		const a = await seedUser({});
		const b = await seedUser({});
		const la = await publish(a.id);
		const lb = await publish(b.id);
		const now = FAR + 20 * TRADE_TTL_MS;
		const first = await createTrade(env.DB, {
			id: uid('trade'),
			userId: a.id,
			lineageId: la.lineageId,
			versionId: la.versionId,
			now
		});
		const second = await createTrade(env.DB, {
			id: uid('trade'),
			userId: b.id,
			lineageId: lb.lineageId,
			versionId: lb.versionId,
			now: now + 1
		});
		expect([first.ok, second.ok]).toEqual([true, true]);
		expect(await retryWaitingPairs(env.DB, now + 2)).toBe(1);
		expect(await retryWaitingPairs(env.DB, now + 3, 0)).toBe(0);
	});
});

// ---- queries, rankings, activity -------------------------------------------------------------------

describe('social queries, rankings and activity helpers', () => {
	it('queries short-circuit on empty, oversized or malformed input', async () => {
		const user = await seedUser({});
		const many = Array.from({ length: PACK_ITEMS_MAX + 1 }, (_, i) => `lineage-${i}-xxxx`);
		expect((await headLicensesForOwner(env.DB, user.id, [])).size).toBe(0);
		expect((await headLicensesForOwner(env.DB, user.id, many)).size).toBe(0);
		expect((await ownHeadNames(env.DB, user.id, [])).size).toBe(0);
		const tooMany = Array.from({ length: LOOKUP_IDS_MAX + 1 }, (_, i) => `lineage-${i}-xxxx`);
		await expect(ownHeadNames(env.DB, user.id, tooMany)).rejects.toBeInstanceOf(SocialRepoError);
		expect(await isLinkableTombstone(env.DB, 'bad id!')).toBe(false);
		expect(await isRetractedLinkable(env.DB, 'bad id!')).toBe(false);
	});

	it('rankingsApiError maps cursor and input errors, passes anything else through', () => {
		expect(rankingsApiError(new SocialRepoError('invalid-cursor'))).toMatchObject({
			status: 400,
			code: 'INVALID_CURSOR'
		});
		expect(rankingsApiError(new SocialRepoError('invalid-input'))).toMatchObject({
			status: 400,
			code: 'INVALID_BODY'
		});
		const limit = new SocialRepoError('limit');
		expect(rankingsApiError(limit)).toBe(limit);
		const other = new TypeError('boom');
		expect(rankingsApiError(other)).toBe(other);
	});

	it('outbox: the event id is echoed only when the item carries a valid UUID', async () => {
		const user = await seedUser({});
		const eventId = crypto.randomUUID();
		const results = await recordOutbox(env.DB, user.id, [
			42,
			{ kind: 'installed' },
			{ eventId: 'not-a-uuid' },
			{ eventId, kind: 'bogus' }
		]);
		expect(results.map((result) => result.eventId)).toEqual([null, null, null, eventId]);
		expect(results.every((result) => result.status === 'rejected')).toBe(true);
	});
});

// ---- gate.ts ---------------------------------------------------------------------------------------

describe('gate cache: re-gating stale records', () => {
	it('counts a change of the ok flag, of the reason count and of a reason, not an equal verdict', async () => {
		const accepted = await checkCurve(env.DB, encodeS1(presetCurve(7)));
		const rejected = await checkCurve(env.DB, encodeS1(uniqueRejectedCurve()));
		if (!accepted.ok) throw new Error('preset 7 should pass the gate');
		if (rejected.ok || rejected.code !== 'gate-rejected') {
			throw new Error('the unique shelf curve should be rejected');
		}
		const reasons = rejected.reasons;
		expect(reasons.length).toBeGreaterThan(0);
		const stale = 'v0:stale';
		const records = [
			{ ...accepted.curve, gateVer: stale, gateOk: false, gateReasons: ['x'] },
			{ ...rejected.curve, gateVer: stale, gateReasons: [...reasons, 'extra'] },
			{
				...rejected.curve,
				gateVer: stale,
				gateReasons: reasons.map((reason, i) => (i === 0 ? 'other' : reason))
			},
			{ ...rejected.curve, gateVer: stale }
		];
		const summary = await regateStale(env.DB, 10, Date.now(), { list: async () => records });
		expect(summary).toEqual({ checked: 4, changed: 3 });
	});
});

// ---- OG: render, store, route, warm-up -------------------------------------------------------------

function randomS1(): string {
	const [a, b] = crypto.getRandomValues(new Uint32Array(2));
	const freqHz = 100 + ((a ?? 0) % 9900);
	const gain = 1 + ((b ?? 0) % 6);
	const gainDb = (b ?? 0) % 2 === 0 ? gain : -gain;
	const peak = { kind: 'PK', freqHz, gainDb, qFactor: 1 } as const;
	return encodeS1({ bands: NEUTRAL_BANDS.map((band, i) => (i === 0 ? peak : band)), preampDb: 0 });
}

async function linkableVersion(): Promise<{ versionId: string; curveId: string }> {
	const owner = await seedUser({});
	const s1 = randomS1();
	const id = await curveId(s1);
	const pub = await publish(owner.id, { curve: curveInput({ id, s1 }) });
	return { versionId: pub.versionId, curveId: id };
}

function ogEnv(media?: OgEnv['media']): OgEnv {
	const server = getServerEnv({ env });
	return {
		db: server.db,
		media: media ?? server.media,
		publicOrigin: 'http://localhost',
		assets: null
	};
}

function collector() {
	const pending: Promise<unknown>[] = [];
	return {
		ctx: { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) },
		settle: () => Promise.all(pending)
	};
}

const fakePng = async (svg: string): Promise<Uint8Array> =>
	new TextEncoder().encode(svg.slice(0, 64));

describe('OG image: fonts, store edge cases, route and warm-up environment', () => {
	it('fonts: a failed load is forgotten and retried; a good load is memoized', async () => {
		resetOgFonts();
		let calls = 0;
		const failing: OgAssets = {
			fetch: async () => {
				calls++;
				return new Response('missing', { status: 404 });
			}
		};
		await expect(loadOgFonts(failing, 'http://localhost')).rejects.toThrow(/answered 404/);
		const callsAfterFirst = calls;
		await expect(loadOgFonts(failing, 'http://localhost')).rejects.toThrow(/answered 404/);
		expect(calls).toBeGreaterThan(callsAfterFirst);

		resetOgFonts();
		const good: OgAssets = { fetch: async () => new Response(new Uint8Array([1, 2, 3])) };
		const first = loadOgFonts(good, 'http://localhost');
		expect(loadOgFonts(good, 'http://localhost')).toBe(first);
		expect((await first).map((bytes) => bytes.byteLength)).toEqual([3, 3]);
		resetOgFonts();
	});

	it('toArrayBuffer copies exactly the view; errorName names non-errors by type', () => {
		const view = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
		expect(Array.from(new Uint8Array(toArrayBuffer(view)))).toEqual([2, 3]);
		expect(errorName('oops')).toBe('string');
		expect(errorName(new RangeError('x'))).toBe('RangeError');
	});

	it('a cache miss without the ASSETS binding and without a renderer fails loudly', async () => {
		const { versionId } = await linkableVersion();
		const { ctx } = collector();
		await expect(getOrCreateOg(ogEnv(), ctx, versionId)).rejects.toThrow(/ASSETS binding missing/);
	});

	it('an R2 object without the etag metadata gets a computed strong ETag', async () => {
		const target = await linkableVersion();
		const bytes = new Uint8Array([7, 7, 7, 7]);
		await getServerEnv({ env }).media.put(ogKey(target.curveId, target.versionId), bytes, {
			customMetadata: { card: OG_CARD_VERSION }
		});
		const { ctx } = collector();
		const result = await getOrCreateOg(ogEnv(), ctx, target.versionId);
		if (!result.ok) throw new Error('expected the stored image');
		expect(result.source).toBe('r2');
		expect(result.etag).toBe(await strongEtag(toArrayBuffer(bytes)));
	});

	it('a failing R2 write is logged and never breaks the response', async () => {
		const { versionId } = await linkableVersion();
		const server = getServerEnv({ env });
		const media = new Proxy(server.media, {
			get(target, property) {
				if (property === 'put') return async () => Promise.reject(new Error('r2 down'));
				const value: unknown = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const { ctx, settle } = collector();
		const result = await getOrCreateOg(ogEnv(media), ctx, versionId, { render: fakePng });
		expect(result.ok && result.source).toBe('render');
		await expect(settle()).resolves.toBeDefined();
	});

	it('route: no execution context, HEAD without a body, missing id', async () => {
		const { versionId } = await linkableVersion();
		const event = (method: string, params: { id?: string }) => ({
			request: new Request(`${env.PUBLIC_ORIGIN}/og/${params.id ?? ''}.png`, {
				method,
				headers: { 'cf-connecting-ip': randomIp() }
			}),
			params,
			locals: ANONYMOUS,
			platform: { env }
		});
		const get = await ogResponse(event('GET', { id: versionId }), { render: fakePng });
		expect(get.status).toBe(200);
		const head = await ogResponse(event('HEAD', { id: versionId }), { render: fakePng });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe('');
		expect((await ogResponse(event('GET', {}), { render: fakePng })).status).toBe(404);
	});

	it('ogEnvOf: a missing, non-object or fetch-less ASSETS binding means no assets', () => {
		for (const assets of [undefined, 'not-a-binding', {}]) {
			const view = new Proxy(env, {
				get: (target, property) => (property === 'ASSETS' ? assets : Reflect.get(target, property))
			});
			expect(ogEnvOf({ env: view }).assets).toBeNull();
		}
	});
});
