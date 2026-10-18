// Issue #31: the nickname -> account-id merge flag transition. A legacy flag keyed by nickname is
// not read under the account id, so the local items are offered once more; the server reports
// them as duplicates (proved against the real route in
// tests/integration/social/library/merge-flag.test.ts) and the account-id flag then holds them.
import { expect, it } from 'vitest';
import type { LibraryMergeItem, MergeReport } from '#lib/social/index.ts';
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

/** In-memory merge endpoint: one lineage per curve, repeats answered as duplicates. */
function fakeServer() {
	const lineages = new Map<string, string>();
	const calls: LibraryMergeItem[][] = [];
	const api = {
		mergeLibrary: async (items: LibraryMergeItem[]): Promise<MergeReport> => {
			calls.push(items);
			const report: MergeReport = { created: [], duplicates: [], rejected: [], conflicts: [] };
			for (const item of items) {
				const existing = lineages.get(item.s1);
				if (existing === undefined) {
					const lineageId = `lineage-${lineages.size + 1}`;
					lineages.set(item.s1, lineageId);
					report.created.push({ localId: item.localId, lineageId });
				} else {
					report.duplicates.push({ localId: item.localId, lineageId: existing });
				}
			}
			return report;
		}
	};
	return { api, calls, lineages };
}

it('re-offers legacy nickname-handled items once under the account id, then not again', async () => {
	const account = { id: 'user-31', username: 'Legacy', emailVerified: true };
	const local = [{ id: 'legacy-local', name: 'Local curve', s1: 'S1-local-curve', updatedAt: 10 }];
	const values = new Map<string, string>();
	const storage: KeyValueStorage = {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		}
	};
	const server = fakeServer();

	const items = local.map((item) => toMergeItem(item, 'en-US'));
	expect(items).toEqual([
		{ localId: 'legacy-local', s1: 'S1-local-curve', name: 'Local curve', lang: 'en-US' }
	]);
	const original = await runMerge(server.api, items);
	const lineageId = original.report.created[0]?.lineageId;
	expect(original.report.created).toHaveLength(1);
	expect(lineageId).toEqual(expect.any(String));
	// The legacy flag: keyed by the nickname, as before issue #31.
	writeMergeFlag(storage, account.username, { offeredAt: 20, handled: original.handled });
	expect(unmergedItems(local, readMergeFlag(storage, account.username))).toEqual([]);
	expect(storage.getItem(MERGE_KEY)).toContain(account.username);

	const key = accountKey(account);
	expect(key).toBe(account.id);
	expect(readMergeFlag(storage, key)).toEqual({ offeredAt: null, handled: [] });
	const offered = unmergedItems(local, readMergeFlag(storage, key));
	expect(offered).toEqual(local);
	const repeated = await runMerge(
		server.api,
		offered.map((item) => toMergeItem(item, 'en-US'))
	);
	expect(repeated.error).toBeNull();
	expect(repeated.report).toEqual({
		created: [],
		duplicates: [{ localId: 'legacy-local', lineageId }],
		rejected: [],
		conflicts: []
	});
	expect(repeated.handled).toEqual(['legacy-local']);
	expect(server.lineages.size).toBe(1);

	writeMergeFlag(storage, key, { offeredAt: null, handled: repeated.handled });
	expect(readMergeFlag(storage, key)).toEqual({ offeredAt: null, handled: ['legacy-local'] });
	expect(unmergedItems(local, readMergeFlag(storage, key))).toEqual([]);
	const renamedKey = accountKey({ ...account, username: 'Renamed' });
	expect(renamedKey).toBe(key);
	expect(unmergedItems(local, readMergeFlag(storage, renamedKey))).toEqual([]);
	expect(server.calls).toHaveLength(2);
	expect(local).toHaveLength(1);
});
