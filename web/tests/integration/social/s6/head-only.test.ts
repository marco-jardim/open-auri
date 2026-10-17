// FX4.9 (nit): S6 accepts only the curve of the HEAD version of a publicly listable lineage; the
// curve of an older version of the same lineage is not an eligible item.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { listableCurveIds } from '#lib/server/social/queries/s6.ts';
import { appendVersion } from '#lib/server/social/repo.ts';
import { curveInput, publish, seedUser, versionInput } from '../repo/helpers.ts';

describe('S6 listableCurveIds: head only', () => {
	it('returns the head curve of a public lineage, never an older version of it', async () => {
		const owner = await seedUser();
		const first = await publish(owner.id);
		const next = curveInput();
		const appended = await appendVersion(env.DB, {
			lineageId: first.lineageId,
			ownerUserId: owner.id,
			expectedHead: first.versionId,
			curve: next,
			version: versionInput(),
			now: Date.now()
		});
		expect(appended.ok).toBe(true);
		const found = await listableCurveIds(env.DB, [first.curve.id, next.id]);
		expect([...found]).toEqual([next.id]);
	});

	it('an unlisted lineage head is still not listable', async () => {
		const owner = await seedUser();
		const unlisted = await publish(owner.id, { visibility: 'unlisted' });
		expect((await listableCurveIds(env.DB, [unlisted.curve.id])).size).toBe(0);
	});
});
