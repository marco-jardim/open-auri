// Issue #31: the nickname -> account-id merge flag transition may re-offer local items once; the
// real merge route and D1 must then deduplicate them. The browser flag helpers are covered in
// tests/unit/pages/biblioteca/merge-flag.test.ts (this project has no DOM types).
import { expect, it } from 'vitest';
import type { MergeItem, MergeReport } from '#lib/server/social/library.ts';
import { POST } from '../../../../src/routes/api/v1/me/library/merge/+server.ts';
import { bodyOf, count, member, presetS1, routeEvent, type Member } from './helpers.ts';

async function merge(me: Member, items: MergeItem[]): Promise<MergeReport> {
	const response = await POST(
		routeEvent({
			method: 'POST',
			path: '/api/v1/me/library/merge',
			locals: me.locals,
			body: { items }
		})
	);
	expect(response.status).toBe(200);
	return bodyOf<MergeReport>(response);
}

it('a re-offered local item is reported as a duplicate, without duplicating server lineages', async () => {
	const me = await member();
	// The shape the client's `toMergeItem` sends for a local item under the en-US locale.
	const items: MergeItem[] = [
		{ localId: 'legacy-local', s1: presetS1(0), name: 'Local curve', lang: 'en-US' }
	];
	const lineages = () =>
		count('SELECT count(*) AS n FROM lineages WHERE owner_user_id = ?', me.user.id);

	const original = await merge(me, items);
	expect(original.created).toHaveLength(1);
	const lineageId = original.created[0]?.lineageId;
	expect(lineageId).toEqual(expect.any(String));
	expect(await lineages()).toBe(1);

	const repeated = await merge(me, items);
	expect(repeated).toEqual({
		created: [],
		duplicates: [{ localId: 'legacy-local', lineageId }],
		rejected: [],
		conflicts: []
	});
	expect(await lineages()).toBe(1);
});
