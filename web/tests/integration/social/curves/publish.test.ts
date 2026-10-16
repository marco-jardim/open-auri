// T4.2: POST /api/v1/curves: authz, happy path, core validation, server gate (nothing published
// on rejection), daily quota and the onPublished hook.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { curveId, encodeS1 } from 'open-auri/share';
import { ApiError } from '#lib/server/api/index.ts';
import { DAILY_PUBLICATION_QUOTA, publishCurve, utcDayStart } from '#lib/server/social/curves.ts';
import { DAY_MS } from '#lib/server/social/types.ts';
import { publish } from '../repo/helpers.ts';
import {
	actor,
	ANON,
	call,
	count,
	envelopeOf,
	expectError,
	presetCurve,
	route,
	uniqueRejectedCurve
} from './helpers.ts';

const curves = await route('curves/');

function body(envelope: Record<string, unknown>, visibility = 'public'): unknown {
	return { envelope, visibility };
}

describe('POST /api/v1/curves: authz', () => {
	it('declares prerender = false', () => {
		expect(curves.prerender).toBe(false);
	});

	it('anonymous 401, unverified 403, banned 403, verified 201', async () => {
		const payload = body(envelopeOf(presetCurve(0)));
		await expectError(await call(curves, 'POST', { body: payload }), 401, 'AUTH_REQUIRED');
		const unverified = await actor({ verified: false });
		await expectError(
			await call(curves, 'POST', { locals: unverified.locals, body: payload }),
			403,
			'EMAIL_NOT_VERIFIED'
		);
		const banned = await actor({ banned: true });
		await expectError(
			await call(curves, 'POST', { locals: banned.locals, body: payload }),
			403,
			'BANNED'
		);
		const verified = await actor();
		const response = await call(curves, 'POST', { locals: verified.locals, body: payload });
		expect(response.status).toBe(201);
	});

	it('refuses a foreign origin before anything else', async () => {
		const owner = await actor();
		const response = await call(curves, 'POST', {
			locals: owner.locals,
			body: body(envelopeOf(presetCurve(0))),
			headers: { origin: 'https://evil.example' }
		});
		await expectError(response, 403, 'BAD_ORIGIN');
	});
});

describe('POST /api/v1/curves: publication', () => {
	it('publishes lineage + root version with normalized text and the gate cache', async () => {
		const owner = await actor();
		const curve = presetCurve(1);
		const envelope = envelopeOf(curve, {
			name: '  Ｖｏｃａｌ\u200b   quente ',
			license: 'CC-BY-4.0',
			lang: 'en-US'
		});
		const response = await call(curves, 'POST', {
			locals: owner.locals,
			body: body(envelope, 'unlisted')
		});
		expect(response.status).toBe(201);
		const created = (await response.json()) as {
			lineageId: string;
			versionId: string;
			curveId: string;
		};
		expect(created.curveId).toBe(await curveId(encodeS1(curve)));
		const lineage = await env.DB.prepare(
			'SELECT owner_user_id, visibility, status, head_version FROM lineages WHERE id = ?'
		)
			.bind(created.lineageId)
			.first<{ owner_user_id: string; visibility: string; status: string; head_version: string }>();
		expect(lineage).toEqual({
			owner_user_id: owner.user.id,
			visibility: 'unlisted',
			status: 'active',
			head_version: created.versionId
		});
		const version = await env.DB.prepare(
			'SELECT name, license, lang, parent_id, curve_id FROM versions WHERE id = ?'
		)
			.bind(created.versionId)
			.first();
		expect(version).toEqual({
			name: 'Vocal quente',
			license: 'CC-BY-4.0',
			lang: 'en-US',
			parent_id: null,
			curve_id: created.curveId
		});
		expect(
			await count('SELECT count(*) AS n FROM curves WHERE id = ? AND gate_ok = 1', created.curveId)
		).toBe(1);
	});

	it('400 INVALID_BODY for a bad shape (missing visibility, envelope not an object)', async () => {
		const owner = await actor();
		await expectError(
			await call(curves, 'POST', { locals: owner.locals, body: { envelope: {} } }),
			400,
			'INVALID_BODY'
		);
		await expectError(
			await call(curves, 'POST', {
				locals: owner.locals,
				body: { envelope: 'S1', visibility: 'public' }
			}),
			400,
			'INVALID_BODY'
		);
	});

	it('422 INVALID_CURVE with core codes; nothing is written', async () => {
		const owner = await actor();
		const mismatch = envelopeOf(presetCurve(0), { code: encodeS1(presetCurve(2)) });
		const cases: [Record<string, unknown>, string][] = [
			[mismatch, 'env:code-mismatch'],
			[envelopeOf(presetCurve(0), { name: 'veja example.com' }), 'env:url'],
			[envelopeOf(presetCurve(0), { name: '\u200b\u2066' }), 'env:length'],
			[envelopeOf(presetCurve(0), { description: '\u200b\u202e' }), 'env:length'],
			[envelopeOf(presetCurve(0), { license: 'MIT' }), 'env:enum'],
			[{ ...envelopeOf(presetCurve(0)), extra: 1 }, 'env:extra']
		];
		for (const [envelope, code] of cases) {
			const error = await expectError(
				await call(curves, 'POST', { locals: owner.locals, body: body(envelope) }),
				422,
				'INVALID_CURVE'
			);
			expect((error.details as { codes: string[] }).codes).toContain(code);
		}
		expect(
			await count('SELECT count(*) AS n FROM lineages WHERE owner_user_id = ?', owner.user.id)
		).toBe(0);
	});

	it('422 GATE_REJECTED with reasons; no lineage or version references the curve', async () => {
		const owner = await actor();
		const curve = uniqueRejectedCurve();
		const id = await curveId(encodeS1(curve));
		const error = await expectError(
			await call(curves, 'POST', { locals: owner.locals, body: body(envelopeOf(curve)) }),
			422,
			'GATE_REJECTED'
		);
		const reasons = (error.details as { reasons: string[] }).reasons;
		expect(reasons.length).toBeGreaterThan(0);
		expect(reasons).toContain('k:kind-not-allowed');
		expect(await count('SELECT count(*) AS n FROM versions WHERE curve_id = ?', id)).toBe(0);
		expect(
			await count('SELECT count(*) AS n FROM lineages WHERE owner_user_id = ?', owner.user.id)
		).toBe(0);
		// The rejection is cached (same reason codes on the next attempt, also for private).
		expect(await count('SELECT count(*) AS n FROM curves WHERE id = ? AND gate_ok = 0', id)).toBe(
			1
		);
		await expectError(
			await call(curves, 'POST', {
				locals: owner.locals,
				body: body(envelopeOf(curve), 'private')
			}),
			422,
			'GATE_REJECTED'
		);
	});
});

describe('daily quota', () => {
	it(`429 QUOTA_EXCEEDED after ${DAILY_PUBLICATION_QUOTA} versions in the UTC day`, async () => {
		const owner = await actor();
		const now = Date.now();
		for (let i = 0; i < DAILY_PUBLICATION_QUOTA; i++) await publish(owner.user.id, { now });
		const response = await call(curves, 'POST', {
			locals: owner.locals,
			body: body(envelopeOf(presetCurve(0)))
		});
		await expectError(response, 429, 'QUOTA_EXCEEDED');
		expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
	});

	it('versions of the previous UTC day do not count', async () => {
		const owner = await actor();
		const yesterday = utcDayStart(Date.now()) - DAY_MS + 1000;
		for (let i = 0; i < DAILY_PUBLICATION_QUOTA; i++) {
			await publish(owner.user.id, { now: yesterday });
		}
		const response = await call(curves, 'POST', {
			locals: owner.locals,
			body: body(envelopeOf(presetCurve(0)))
		});
		expect(response.status).toBe(201);
	});

	it('utcDayStart is midnight UTC', () => {
		expect(utcDayStart(Date.UTC(2026, 9, 16, 23, 59, 59))).toBe(Date.UTC(2026, 9, 16));
	});
});

describe('publishCurve (service)', () => {
	it('calls onPublished once with the ids; a throwing hook does not fail the publication', async () => {
		const owner = await actor();
		const hook = vi.fn();
		const info = await publishCurve(
			env.DB,
			owner.user.id,
			{ envelope: envelopeOf(presetCurve(0)), visibility: 'public' },
			{ onPublished: hook }
		);
		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook).toHaveBeenCalledWith(info);
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const again = await publishCurve(
			env.DB,
			owner.user.id,
			{ envelope: envelopeOf(presetCurve(0)), visibility: 'private' },
			{
				onPublished: () => {
					throw new Error('og down');
				}
			}
		);
		expect(again.lineageId).not.toBe(info.lineageId);
		expect(log).toHaveBeenCalledTimes(1);
		expect(String(log.mock.calls[0]?.[0])).not.toContain(owner.user.id);
		log.mockRestore();
	});

	it('throws ApiError GATE_REJECTED and never calls the hook for a rejected curve', async () => {
		const owner = await actor();
		const hook = vi.fn();
		let caught: unknown = null;
		try {
			await publishCurve(
				env.DB,
				owner.user.id,
				{ envelope: envelopeOf(uniqueRejectedCurve()), visibility: 'public' },
				{ onPublished: hook }
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ApiError);
		expect(caught instanceof ApiError ? caught.code : null).toBe('GATE_REJECTED');
		expect(hook).not.toHaveBeenCalled();
	});

	it('anonymous locals constant is signed out', () => {
		expect(ANON.user).toBeNull();
	});
});
