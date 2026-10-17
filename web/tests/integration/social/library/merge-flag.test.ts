// Issue #31: the nickname -> account-id merge flag transition may re-offer local items once;
// exercise the browser helpers together with the real merge route and D1 deduplication.
import { expect, it } from 'vitest';
import {
	accountKey,
	MERGE_KEY,
	readMergeFlag,
	runMerge,
	toMergeItem,
	unmergedItems,
	writeMergeFlag,
	type KeyValueStorage
} from '#lib/components/pages/biblioteca/social.ts';
import type { LibraryMergeItem, MergeReport } from '#lib/social/api.ts';
import { POST } from '../../../../src/routes/api/v1/me/library/merge/+server.ts';
import { bodyOf, count, member, presetS1, routeEvent } from './helpers.ts';

it('re-offers legacy nickname-handled items once under the account id, without duplicating server lineages', async () => {
	const me = await member();
	const account = { id: me.user.id, username: me.user.username, emailVerified: true };
	if (!account.username) throw new Error('fixture needs a nickname');
	const local = [{ id: 'legacy-local', name: 'Local curve', s1: presetS1(0), updatedAt: 10 }];
	const values = new Map<string, string>();
	const storage: KeyValueStorage = {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		}
	};
	const api = {
		mergeLibrary: async (items: LibraryMergeItem[]): Promise<MergeReport> => {
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
	};
	const items = local.map((item) => toMergeItem(item, 'en-US'));
	const original = await runMerge(api, items);
	const lineageId = original.report.created[0]?.lineageId;
	expect(original.report.created).toHaveLength(1);
	writeMergeFlag(storage, account.username, { offeredAt: 20, handled: original.handled });
	expect(unmergedItems(local, readMergeFlag(storage, account.username))).toEqual([]);
	expect(storage.getItem(MERGE_KEY)).toContain(account.username);

	const key = accountKey(account);
	expect(key).toBe(me.user.id);
	expect(readMergeFlag(storage, key)).toEqual({ offeredAt: null, handled: [] });
	const offered = unmergedItems(local, readMergeFlag(storage, key));
	expect(offered).toEqual(local);
	const repeated = await runMerge(
		api,
		offered.map((item) => toMergeItem(item, 'en-US'))
	);
	expect(repeated.error).toBeNull();
	expect(repeated.report).toEqual({
		created: [],
		duplicates: [{ localId: 'legacy-local', lineageId }],
		rejected: [],
		conflicts: []
	});
	expect(
		await count('SELECT count(*) AS n FROM lineages WHERE owner_user_id = ?', me.user.id)
	).toBe(1);
	writeMergeFlag(storage, key, { offeredAt: null, handled: repeated.handled });
	const renamedKey = accountKey({ ...account, username: 'Renamed' });
	expect(unmergedItems(local, readMergeFlag(storage, renamedKey))).toEqual([]);
	expect(local).toHaveLength(1);
});
