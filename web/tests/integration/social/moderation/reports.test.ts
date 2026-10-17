// T4.8: POST /api/v1/reports (verified, Turnstile, dedupe, readability) and the automatic hiding
// (3 distinct verified, non-banned accounts at least 3 days old; never over an admin decision).
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { changeNickname } from '#lib/server/account/nickname.ts';
import { listAudit } from '#lib/server/admin/audit.ts';
import { TURNSTILE_HEADER } from '#lib/server/api/index.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { SITEVERIFY_URL, TURNSTILE_ACTIONS } from '#lib/server/security/turnstile.ts';
import { AUTO_HIDE_THRESHOLD, fileReport, maybeAutoHide } from '#lib/server/social/moderation.ts';
import { createPack, insertReport, setModeration } from '#lib/server/social/repo.ts';
import { POST } from '../../../../src/routes/api/v1/reports/+server.ts';
import { expectErrorResponse, HOSTNAME, ORIGIN, randomIp, signedOut } from '../../api/helpers.ts';
import {
	apiLocals,
	lineageModeration,
	publish,
	reportCount,
	reporter,
	resolutions,
	seedUser,
	target,
	uid
} from './helpers.ts';

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

function turnstile(success: boolean, action: string = TURNSTILE_ACTIONS.report) {
	network.use(
		http.post(SITEVERIFY_URL, () =>
			HttpResponse.json(
				success
					? { success: true, action, hostname: HOSTNAME }
					: { success: false, 'error-codes': ['invalid-input-response'] }
			)
		)
	);
}

async function report(
	locals: AuthLocals,
	body: unknown,
	token: string | null = 'tok'
): Promise<Response> {
	const headers: Record<string, string> = {
		'cf-connecting-ip': randomIp(),
		origin: ORIGIN,
		'content-type': 'application/json'
	};
	if (token !== null) headers[TURNSTILE_HEADER] = token;
	const event = {
		request: new Request(`${ORIGIN}/api/v1/reports`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		}),
		locals,
		platform: { env },
		route: { id: '/api/v1/reports' },
		params: {}
	};
	return POST(event as never);
}

async function auditActions(targetId: string): Promise<string[]> {
	return (await listAudit(env.DB, { targetId })).rows.map((row) => row.action);
}

describe('POST /api/v1/reports: guards', () => {
	it('401 signed out, 403 unverified, 403 TURNSTILE_FAILED without or with a bad token', async () => {
		const { lineageId } = await target();
		const body = { targetKind: 'lineage', targetId: lineageId, reason: 'spam' };
		turnstile(true);
		await expectErrorResponse(await report(signedOut(), body), 401, 'AUTH_REQUIRED');
		const unverified = await reporter({ verified: false });
		await expectErrorResponse(
			await report(apiLocals(unverified, false), body),
			403,
			'EMAIL_NOT_VERIFIED'
		);
		const user = await reporter();
		await expectErrorResponse(await report(apiLocals(user), body, null), 403, 'TURNSTILE_FAILED');
		turnstile(false);
		await expectErrorResponse(await report(apiLocals(user), body), 403, 'TURNSTILE_FAILED');
		turnstile(true, 'signup');
		await expectErrorResponse(await report(apiLocals(user), body), 403, 'TURNSTILE_FAILED');
		expect(await reportCount('lineage', lineageId)).toBe(0);
	});

	it('400 INVALID_BODY for unknown kinds, reasons, fields and long notes', async () => {
		const { lineageId } = await target();
		const user = await reporter();
		turnstile(true);
		for (const body of [
			{ targetKind: 'curve', targetId: lineageId, reason: 'spam' },
			{ targetKind: 'lineage', targetId: lineageId, reason: 'boring' },
			{ targetKind: 'lineage', targetId: "x' OR 1=1", reason: 'spam' },
			{ targetKind: 'lineage', targetId: lineageId, reason: 'spam', note: 'x'.repeat(501) },
			{ targetKind: 'lineage', targetId: lineageId, reason: 'spam', note: 'bad\u0000' },
			{ targetKind: 'lineage', targetId: lineageId, reason: 'spam', extra: 1 }
		]) {
			await expectErrorResponse(await report(apiLocals(user), body), 400, 'INVALID_BODY');
		}
		expect(await reportCount('lineage', lineageId)).toBe(0);
	});
});

describe('POST /api/v1/reports: targets', () => {
	it('201 once, then 409 DUPLICATE for the same reporter and target', async () => {
		const { lineageId } = await target();
		const user = await reporter();
		turnstile(true);
		const body = {
			targetKind: 'lineage',
			targetId: lineageId,
			reason: 'dangerous',
			note: ' loud '
		};
		const first = await report(apiLocals(user), body);
		expect(first.status).toBe(201);
		expect(await first.json()).toEqual({ reported: true });
		await expectErrorResponse(
			await report(apiLocals(user), { ...body, reason: 'spam' }),
			409,
			'DUPLICATE'
		);
		const row = await env.DB.prepare(
			'SELECT reason, note, reporter_user_id AS r FROM reports WHERE target_id = ?'
		)
			.bind(lineageId)
			.first<{ reason: string; note: string; r: string }>();
		expect(row).toEqual({ reason: 'dangerous', note: 'loud', r: user.id });
	});

	it('404 for targets the reporter cannot read; 403 FORBIDDEN for own content', async () => {
		const owner = await seedUser();
		const priv = await publish(owner.id, { visibility: 'private' });
		const unlisted = await publish(owner.id, { visibility: 'unlisted' });
		const user = await reporter();
		const bannedNickname = `b${crypto.randomUUID().slice(0, 12)}`;
		const banned = await seedUser({ username: bannedNickname, banned: true });
		const nickname = `m${crypto.randomUUID().slice(0, 12)}`;
		const nicked = await seedUser({ username: nickname });
		turnstile(true);
		const cases: [string, string][] = [
			['lineage', priv.lineageId],
			['lineage', uid('missing')],
			['pack', uid('missing')],
			['user', banned.id],
			['user', bannedNickname],
			['user', nicked.id], // even an existing public profile cannot be reported by internal id
			['user', uid('missing')],
			['user', owner.id] // no nickname: no public profile
		];
		for (const [targetKind, targetId] of cases) {
			await expectErrorResponse(
				await report(apiLocals(user), { targetKind, targetId, reason: 'spam' }),
				404,
				'NOT_FOUND'
			);
		}
		// Unlisted is readable by id; a user with a profile can be reported.
		expect(
			(
				await report(apiLocals(user), {
					targetKind: 'lineage',
					targetId: unlisted.lineageId,
					reason: 'spam'
				})
			).status
		).toBe(201);
		expect(
			(
				await report(apiLocals(user), {
					targetKind: 'user',
					targetId: nickname,
					reason: 'impersonation'
				})
			).status
		).toBe(201);
		// The owner reporting their own private lineage (readable to them) is refused.
		await expectErrorResponse(
			await report(apiLocals(owner), {
				targetKind: 'lineage',
				targetId: priv.lineageId,
				reason: 'spam'
			}),
			403,
			'FORBIDDEN'
		);
		expect(await reportCount('lineage', priv.lineageId)).toBe(0);
	});

	it('resolves nicknames (including dots, case and held aliases), stores ids and deduplicates', async () => {
		const nickname = `listener.${crypto.randomUUID().slice(0, 8)}`;
		const profile = await seedUser({ username: nickname });
		const user = await reporter();
		const body = { targetKind: 'user', targetId: nickname.toUpperCase(), reason: 'impersonation' };
		turnstile(true);
		const response = await report(apiLocals(user), body);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ reported: true });
		expect(await reportCount('user', profile.id)).toBe(1);
		expect(await reportCount('user', nickname)).toBe(0);
		await expectErrorResponse(
			await report(apiLocals(user), { ...body, targetId: nickname }),
			409,
			'DUPLICATE'
		);
		await expectErrorResponse(await report(apiLocals(profile), body), 403, 'FORBIDDEN');
		expect(
			await fileReport(env.DB, {
				reporterUserId: user.id,
				targetKind: 'user',
				targetId: profile.id,
				reason: 'spam',
				note: null,
				now: Date.now()
			})
		).toEqual({ ok: false, code: 'NOT_FOUND' });

		const nextNickname = `renamed.${crypto.randomUUID().slice(0, 8)}`;
		expect((await changeNickname(env.DB, profile.id, nextNickname, Date.now())).ok).toBe(true);
		for (const targetId of [nickname, nextNickname]) {
			await expectErrorResponse(
				await report(apiLocals(user), { ...body, targetId }),
				409,
				'DUPLICATE'
			);
		}
		await env.DB.prepare('UPDATE "user" SET banned = 1 WHERE id = ?').bind(profile.id).run();
		for (const targetId of [nickname, nextNickname, profile.id, uid('unknown')]) {
			await expectErrorResponse(
				await report(apiLocals(user), { ...body, targetId }),
				404,
				'NOT_FOUND'
			);
		}
		expect(await reportCount('user', profile.id)).toBe(1);
	});

	it('the third eligible report through the API hides the lineage (audited, system)', async () => {
		const { lineageId } = await target();
		turnstile(true);
		for (let i = 0; i < AUTO_HIDE_THRESHOLD; i += 1) {
			expect(await lineageModeration(lineageId)).toBe('visible');
			const user = await reporter();
			const response = await report(apiLocals(user), {
				targetKind: 'lineage',
				targetId: lineageId,
				reason: 'offensive'
			});
			expect(response.status).toBe(201);
		}
		expect(await lineageModeration(lineageId)).toBe('auto_hidden');
		const trail = await listAudit(env.DB, { targetId: lineageId });
		expect(trail.rows).toHaveLength(1);
		expect(trail.rows[0]).toMatchObject({
			actorId: null,
			actorKind: 'system',
			action: 'moderation.auto_hide',
			targetKind: 'lineage',
			detail: { reporters: 3, threshold: 3 }
		});
		// Hidden now: a fourth reporter cannot read it any more.
		await expectErrorResponse(
			await report(apiLocals(await reporter()), {
				targetKind: 'lineage',
				targetId: lineageId,
				reason: 'spam'
			}),
			404,
			'NOT_FOUND'
		);
	});
});

describe('automatic hiding threshold', () => {
	it('counts only verified, non-banned accounts at least 3 days old', async () => {
		const { lineageId } = await target();
		const now = Date.now();
		const file = async (user: { id: string }) => {
			const result = await fileReport(env.DB, {
				reporterUserId: user.id,
				targetKind: 'lineage',
				targetId: lineageId,
				reason: 'spam',
				note: null,
				now
			});
			expect(result.ok).toBe(true);
			return result.ok ? result.autoHidden : null;
		};
		expect(await file(await reporter())).toBe(false);
		expect(await file(await reporter())).toBe(false);
		// New accounts (2 days old, and created today) do not count.
		expect(await file(await reporter({ ageDays: 2 }))).toBe(false);
		expect(await file(await reporter({ ageDays: 0 }))).toBe(false);
		// Unverified and banned reporters do not count (inserted directly: the API refuses them).
		for (const user of [await reporter({ verified: false }), await reporter({ banned: true })]) {
			await insertReport(env.DB, {
				id: crypto.randomUUID(),
				targetKind: 'lineage',
				targetId: lineageId,
				reason: 'spam',
				note: null,
				reporterUserId: user.id,
				now
			});
		}
		expect(await maybeAutoHide(env.DB, 'lineage', lineageId, now)).toBe(false);
		expect(await lineageModeration(lineageId)).toBe('visible');
		expect(await auditActions(lineageId)).toEqual([]);
		// Just over 3 days old counts.
		expect(await file(await reporter({ ageDays: 3.001 }))).toBe(true);
		expect(await lineageModeration(lineageId)).toBe('auto_hidden');
		expect(await auditActions(lineageId)).toEqual(['moderation.auto_hide']);
	});

	it('never overrides an admin hide or remove, nor re-hides after a restore', async () => {
		for (const state of ['hidden', 'removed'] as const) {
			const { lineageId } = await target();
			const now = Date.now();
			for (let i = 0; i < AUTO_HIDE_THRESHOLD; i += 1) {
				const user = await reporter();
				await insertReport(env.DB, {
					id: crypto.randomUUID(),
					targetKind: 'lineage',
					targetId: lineageId,
					reason: 'spam',
					note: null,
					reporterUserId: user.id,
					now
				});
			}
			expect(await setModeration(env.DB, 'lineage', lineageId, state, now)).toBe(true);
			expect(await maybeAutoHide(env.DB, 'lineage', lineageId, now)).toBe(false);
			expect(await lineageModeration(lineageId)).toBe(state);
			expect(await auditActions(lineageId)).toEqual([]);
		}

		// Restored by an admin: the open reports are resolved, so one more report does not re-hide.
		const { lineageId } = await target();
		const now = Date.now();
		for (let i = 0; i < AUTO_HIDE_THRESHOLD; i += 1) {
			await fileReport(env.DB, {
				reporterUserId: (await reporter()).id,
				targetKind: 'lineage',
				targetId: lineageId,
				reason: 'spam',
				note: null,
				now
			});
		}
		expect(await lineageModeration(lineageId)).toBe('auto_hidden');
		await setModeration(env.DB, 'lineage', lineageId, 'visible', now);
		await env.DB.prepare(
			"UPDATE reports SET resolution = 'restored', resolved_at = ? WHERE target_id = ?"
		)
			.bind(now, lineageId)
			.run();
		const again = await fileReport(env.DB, {
			reporterUserId: (await reporter()).id,
			targetKind: 'lineage',
			targetId: lineageId,
			reason: 'spam',
			note: null,
			now
		});
		expect(again).toEqual({ ok: true, autoHidden: false });
		expect(await lineageModeration(lineageId)).toBe('visible');
		const states = await resolutions('lineage', lineageId);
		expect(states.filter((state) => state === 'restored')).toHaveLength(3);
		expect(states.filter((state) => state === null)).toHaveLength(1);
	});

	it('hides packs too; reports on users never hide anything', async () => {
		const nickname = `m${crypto.randomUUID().slice(0, 12)}`;
		const owner = await seedUser({ username: nickname });
		const packId = uid('pack');
		const created = await createPack(env.DB, {
			id: packId,
			ownerUserId: owner.id,
			name: 'Vocals',
			description: '',
			visibility: 'public',
			now: Date.now()
		});
		expect(created.ok).toBe(true);
		const now = Date.now();
		const results: boolean[] = [];
		for (let i = 0; i < AUTO_HIDE_THRESHOLD; i += 1) {
			const result = await fileReport(env.DB, {
				reporterUserId: (await reporter()).id,
				targetKind: 'pack',
				targetId: packId,
				reason: 'offensive',
				note: null,
				now
			});
			results.push(result.ok && result.autoHidden);
		}
		expect(results).toEqual([false, false, true]);
		const pack = await env.DB.prepare('SELECT moderation FROM packs WHERE id = ?')
			.bind(packId)
			.first<{ moderation: string }>();
		expect(pack?.moderation).toBe('auto_hidden');
		expect(await auditActions(packId)).toEqual(['moderation.auto_hide']);

		for (let i = 0; i < AUTO_HIDE_THRESHOLD; i += 1) {
			const result = await fileReport(env.DB, {
				reporterUserId: (await reporter()).id,
				targetKind: 'user',
				targetId: nickname,
				reason: 'impersonation',
				note: 'pretends to be someone',
				now
			});
			expect(result).toEqual({ ok: true, autoHidden: false });
		}
		expect(await auditActions(owner.id)).toEqual([]);
	});
});
