import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { accountDeletionHook } from '#lib/server/account/deletion.ts';
import { buildAccountExport } from '#lib/server/account/export.ts';
import { putHidden, readHidden } from '#lib/server/social/hidden.ts';
import { getPublicProfile } from '#lib/server/social/repo.ts';
import { readFeed } from '#lib/server/social/rankings.ts';
import { changeNickname } from '#lib/server/account/nickname.ts';
import { GET, PUT, DELETE } from '../../../../src/routes/api/v1/me/hidden/+server.ts';
import { errorCode, member, publish, routeEvent, signedIn, SIGNED_OUT } from '../activity/helpers.ts';

const PATH = '/api/v1/me/hidden';
function event(method: string, who: AuthLocals = SIGNED_OUT, body?: unknown, origin?: string | null) {
	return routeEvent({ path: PATH, routeId: PATH, method, locals: who, ...(body === undefined ? {} : { body }), ...(origin === undefined ? {} : { origin }) });
}

describe('hidden preferences API in workerd', () => {
	test('requires authentication and same-origin mutations; unverified users can hide', async () => {
		expect(await errorCode(await GET(event('GET')), 401)).toMatchObject({ code: 'AUTH_REQUIRED' });
		const user = await member();
		for (const handler of [PUT, DELETE]) {
			for (const origin of [null, 'https://evil.example']) {
				expect(await errorCode(await handler(event('PUT', signedIn(user), {}, origin)), 403)).toMatchObject({ code: 'BAD_ORIGIN' });
			}
		}
		const result = await PUT(event('PUT', signedIn(user, { emailVerified: false }), { authors: [], curves: ['c1'] }));
		expect(result.status).toBe(200);
		expect(result.headers.get('cache-control')).toContain('no-store');
		expect(result.headers.get('cache-control')).toContain('private');
	});
	test('validates ids, target types, labels, unknown fields and array bounds', async () => {
		const user = await member();
		for (const body of [
			{ authors: ['<script>'], curves: [] }, { authors: [], curves: ['../bad'] },
			{ authors: [], curves: [], userId: 'someone-else' },
			{ authors: [], curves: Array.from({ length: 501 }, (_, i) => `c${i}`) },
			{ authors: [], curves: ['c1'], labels: { authors: {}, curves: { c1: 'x'.repeat(81) } } }
		]) {
			expect(await errorCode(await PUT(event('PUT', signedIn(user), body)), 400)).toMatchObject({ code: 'INVALID_BODY' });
		}
		expect(await errorCode(await DELETE(event('DELETE', signedIn(user), { targetType: 'pack', targetId: 'x' })), 400)).toMatchObject({ code: 'INVALID_BODY' });
		const unsupported = event('PUT', signedIn(user), { authors: [], curves: [] });
		unsupported.request.headers.set('content-type', 'text/plain');
		expect(await errorCode(await PUT(unsupported), 415)).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
	});
	test('persists an idempotent additive union with labels, isolates users and deletes one target', async () => {
		const user = await member();
		const other = await member();
		const body = { authors: ['author1'], curves: ['curve1'], labels: { authors: { author1: 'Geoff' }, curves: { curve1: 'Night radio' } } };
		expect((await PUT(event('PUT', signedIn(user), body))).status).toBe(200);
		const first = await readHidden(env.DB, user.id);
		await PUT(event('PUT', signedIn(user), body));
		await PUT(event('PUT', signedIn(user), { authors: [], curves: ['curve2'] }));
		const response = await GET(event('GET', signedIn(user)));
		const document = await response.json();
		expect(document).toMatchObject({ items: expect.arrayContaining([
			expect.objectContaining({ targetType: 'author', targetId: 'author1', label: 'Geoff' }),
			expect.objectContaining({ targetType: 'curve', targetId: 'curve1', label: 'Night radio', createdAt: first.items.find((item) => item.targetId === 'curve1')?.createdAt }),
			expect.objectContaining({ targetId: 'curve2' })
		]) });
		expect((await readHidden(env.DB, user.id)).items).toHaveLength(3);
		expect(await (await GET(event('GET', signedIn(other)))).json()).toEqual({ items: [] });
		const target = { targetType: 'curve', targetId: 'curve1' };
		await DELETE(event('DELETE', signedIn(other), target));
		expect((await readHidden(env.DB, user.id)).items).toHaveLength(3);
		await DELETE(event('DELETE', signedIn(user), target));
		await DELETE(event('DELETE', signedIn(user), target));
		expect((await readHidden(env.DB, user.id)).items.map((item) => item.targetId)).toEqual(expect.arrayContaining(['author1', 'curve2']));
	});
	test('the D1 cap is atomic, including concurrent merges, and never drops previous preferences', async () => {
		const user = await member();
		await putHidden(env.DB, user.id, { authors: [], curves: Array.from({ length: 499 }, (_, i) => `c${i}`) }, 1);
		const responses = await Promise.all(['last-a', 'last-b'].map((id) => PUT(event('PUT', signedIn(user), { authors: [], curves: [id] }))));
		expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
		expect((await readHidden(env.DB, user.id)).items).toHaveLength(500);
		const overflow = await PUT(event('PUT', signedIn(user), { authors: ['must-rollback'], curves: ['overflow'] }));
		expect(await errorCode(overflow, 409)).toMatchObject({ code: 'QUOTA_EXCEEDED' });
		expect((await readHidden(env.DB, user.id)).items.some((item) => item.targetId === 'must-rollback')).toBe(false);
	});
	test('exports private labels and ids for the owner only and deletes them in both closure modes', async () => {
		for (const mode of ['anonymize', 'delete-all'] as const) {
			const user = await member();
			await putHidden(env.DB, user.id, { authors: ['a1'], curves: ['c1'], labels: { authors: { a1: 'Author' }, curves: { c1: 'Curve' } } }, 1234);
			const document = await buildAccountExport({ db: env.DB, userId: user.id, currentSessionId: null, now: Date.now() });
			expect(document.sections.hiddenItems).toMatchObject({ items: expect.arrayContaining([
				expect.objectContaining({ targetType: 'author', targetId: 'a1', label: 'Author', createdAt: 1234 })
			]) });
			const { recordDeletionRequest } = await import('#lib/server/account/deletion.ts');
			await recordDeletionRequest(env.DB, user.id, mode, Date.now());
			await accountDeletionHook({ db: env.DB })({ id: user.id, email: user.email });
			expect(await readHidden(env.DB, user.id)).toEqual({ items: [] });
		}
		const user = await member();
		await putHidden(env.DB, user.id, { authors: [], curves: ['cascade'] }, 1);
		await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(user.id).run();
		expect(await readHidden(env.DB, user.id)).toEqual({ items: [] });
	});
	test('public author ids are distinct from auth ids, propagated to cards and stable across nickname changes', async () => {
		const user = await member();
		await publish(user.id);
		const profile = await getPublicProfile(env.DB, user.username ?? '');
		expect(profile?.authorId).toMatch(/^[a-f0-9]{32}$/);
		expect(profile?.authorId).not.toBe(user.id);
		const feed = await readFeed(env.DB, { sort: 'new', limit: 100 });
		expect(feed.items.some((item) => item.lineage.author?.id === profile?.authorId)).toBe(true);
		const nickname = `n${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
		expect((await changeNickname(env.DB, user.id, nickname, Date.now())).ok).toBe(true);
		expect((await getPublicProfile(env.DB, nickname))?.authorId).toBe(profile?.authorId);
	});
});
