// QA1 m9 and m5: the library merge compares filter labels (open-auri/preset@2) as well as names.
// A duplicate of an own curve whose labels differ is reported as a `labels` conflict instead of
// being silently dropped; nothing is changed in the account. Labels the insert would refuse (an
// ill-formed lone surrogate, whose JSON would also exceed the 0012 CHECK) are INVALID_TEXT before
// the gate runs or the daily gated quota is spent.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import { canonKey, decodeS1, encodeS1, LABEL_COUNT, LABEL_MAX } from 'open-auri/share';
import { mergeLocalLibrary, type MergeItem } from '#lib/server/social/library.ts';
import { LABELS_JSON_MAX } from '#lib/server/social/types.ts';
import { count, member, presetS1 } from './helpers.ts';

const ten = (entries: (string | null)[]): (string | null)[] =>
	Array.from({ length: LABEL_COUNT }, (_, index) => entries[index] ?? null);

function item(
	localId: string,
	s1: string,
	name: string,
	labels?: (string | null)[] | null
): MergeItem {
	return { localId, s1, name, ...(labels === undefined ? {} : { labels }) };
}

async function headLabels(lineageId: string): Promise<string | null> {
	const row = await env.DB.prepare(
		'SELECT v.labels AS labels FROM lineages l JOIN versions v ON v.id = l.head_version ' +
			'WHERE l.id = ?'
	)
		.bind(lineageId)
		.first<{ labels: string | null }>();
	return row?.labels ?? null;
}

describe('mergeLocalLibrary: filter labels', () => {
	it("reports a labels conflict against the account's lineage and changes nothing", async () => {
		const me = await member();
		const s1 = presetS1(9);
		const grave = ten(['Grave', null, 'Ar']);
		const first = await mergeLocalLibrary(env.DB, me.user.id, [item('a', s1, 'Curva', grave)]);
		expect(first.created).toHaveLength(1);
		const lineageId = first.created[0]?.lineageId ?? '';
		expect(JSON.parse((await headLabels(lineageId)) ?? 'null')).toEqual(grave);

		const result = await mergeLocalLibrary(env.DB, me.user.id, [
			// Same name and labels (normalized the same way): a plain duplicate.
			item('same', s1, 'Curva', ten([' Grave ', null, 'Ａｒ'])),
			item('other', s1, 'Curva', ten(['Corpo'])),
			item('none', s1, 'Curva'),
			item('nulls', s1, 'Curva', ten([])),
			item('both', s1, 'Outro nome', ten(['Corpo'])),
			item('name', s1, 'Outro nome', grave)
		]);
		expect(result.created).toEqual([]);
		expect(result.rejected).toEqual([]);
		expect(result.duplicates).toEqual([{ localId: 'same', lineageId }]);
		expect(result.conflicts).toEqual([
			{ localId: 'other', lineageId, field: 'labels' },
			{ localId: 'none', lineageId, field: 'labels' },
			{ localId: 'nulls', lineageId, field: 'labels' },
			{ localId: 'both', lineageId, field: 'name' },
			{ localId: 'both', lineageId, field: 'labels' },
			{ localId: 'name', lineageId, field: 'name' }
		]);
		// The account keeps its own labels and still has one lineage and one version.
		expect(JSON.parse((await headLabels(lineageId)) ?? 'null')).toEqual(grave);
		const versions = 'SELECT count(*) AS n FROM versions WHERE lineage_id = ?';
		expect(await count(versions, lineageId)).toBe(1);
	});

	it('compares labels inside the batch too; no labels and ten nulls are the same', async () => {
		const me = await member();
		const s1 = presetS1(10);
		const result = await mergeLocalLibrary(env.DB, me.user.id, [
			item('one', s1, 'Lote'),
			item('two', s1, 'Lote', ten([])),
			item('three', s1, 'Lote', ten(['Sub']))
		]);
		expect(result.created).toHaveLength(1);
		const lineageId = result.created[0]?.lineageId ?? '';
		expect(result.duplicates).toEqual([{ localId: 'two', lineageId }]);
		expect(result.conflicts).toEqual([{ localId: 'three', lineageId, field: 'labels' }]);
		expect(await headLabels(lineageId)).toBeNull();
	});

	it('a labels conflict also covers refused local labels (nothing is stored)', async () => {
		const me = await member();
		const s1 = presetS1(11);
		const first = await mergeLocalLibrary(env.DB, me.user.id, [item('a', s1, 'Curva')]);
		const lineageId = first.created[0]?.lineageId ?? '';
		const result = await mergeLocalLibrary(env.DB, me.user.id, [
			item('link', s1, 'Curva', ten(['evil.com']))
		]);
		expect(result.conflicts).toEqual([{ localId: 'link', lineageId, field: 'labels' }]);
		expect(await headLabels(lineageId)).toBeNull();
	});

	it('ill-formed labels are INVALID_TEXT before the gate or the gated quota is used', async () => {
		const me = await member();
		// Ten entries of LABEL_MAX lone surrogates: JSON escapes each as \udXXX, beyond the CHECK.
		const lone = Array.from({ length: LABEL_COUNT }, () => '\ud800'.repeat(LABEL_MAX));
		expect(JSON.stringify(lone).length).toBeGreaterThan(LABELS_JSON_MAX);
		let runs = 0;
		const gate: typeof gateForWrite = (bands, preampDb) => {
			runs++;
			return gateForWrite(bands, preampDb);
		};
		const result = await mergeLocalLibrary(
			env.DB,
			me.user.id,
			[
				item('lone', presetS1(12), 'Curva', lone),
				item('one', presetS1(13), 'Curva', ten(['a\udc00b']))
			],
			{ deps: { gate } }
		);
		expect(result.created).toEqual([]);
		expect(result.rejected.map((entry) => [entry.localId, entry.code])).toEqual([
			['lone', 'INVALID_TEXT'],
			['one', 'INVALID_TEXT']
		]);
		for (const entry of result.rejected) expect(entry.reasons).toContain('env:pattern');
		expect(runs).toBe(0);
		// The daily gated counter (`slidingWindowLimit`, one-day window) was never touched.
		const counter = 'SELECT count(*) AS n FROM rate_limit_counters WHERE key = ?';
		expect(await count(counter, `u:library.merge.gated:${me.user.id}:86400`)).toBe(0);
		const lineages = 'SELECT count(*) AS n FROM lineages WHERE owner_user_id = ?';
		expect(await count(lineages, me.user.id)).toBe(0);
	});
});

describe('mergeLocalLibrary: labels of a canonKey duplicate follow their bands', () => {
	type Curve = Parameters<typeof encodeS1>[0];
	type Band = Curve['bands'][number];

	/** `s1` in another wire order: entry i of `order` is the old index of the band now at i. */
	function reorder(s1: string, order: readonly number[]): string {
		const { bands, preampDb } = decodeS1(s1);
		const moved = order.map((index) => {
			const band = bands[index];
			if (!band) throw new Error(`no band ${index}`);
			return band;
		});
		return encodeS1({ bands: moved, preampDb });
	}
	const moveLabels = (labels: (string | null)[], order: readonly number[]) =>
		order.map((index) => labels[index] ?? null);
	/** The first band goes last: every band changes wire index. */
	const ROTATE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

	it('the same bands in another order: labels that moved with their filters are no conflict', async () => {
		const me = await member();
		const s1 = presetS1(3);
		const moved = reorder(s1, ROTATE);
		// Another curve id (wire order), the same canonical curve.
		expect(moved).not.toBe(s1);
		const original = decodeS1(s1);
		const other = decodeS1(moved);
		expect(canonKey(other.bands, other.preampDb)).toBe(canonKey(original.bands, original.preampDb));
		const labels = ten(['Grave', 'Corpo', 'Médio']);
		const first = await mergeLocalLibrary(env.DB, me.user.id, [item('a', s1, 'Curva', labels)]);
		expect(first.created).toHaveLength(1);
		const lineageId = first.created[0]?.lineageId ?? '';

		const result = await mergeLocalLibrary(env.DB, me.user.id, [
			// The names moved with their filters: the same labels, a plain duplicate.
			item('moved', moved, 'Curva', moveLabels(labels, ROTATE)),
			// The names stayed on the slots, so now they name other filters.
			item('stayed', moved, 'Curva', labels),
			// Two filters traded names.
			item('traded', moved, 'Curva', moveLabels(ten(['Corpo', 'Grave', 'Médio']), ROTATE)),
			// One name less.
			item('fewer', moved, 'Curva', moveLabels(ten(['Grave', 'Corpo']), ROTATE))
		]);
		expect(result.created).toEqual([]);
		expect(result.rejected).toEqual([]);
		expect(result.duplicates).toEqual([{ localId: 'moved', lineageId }]);
		expect(result.conflicts).toEqual([
			{ localId: 'stayed', lineageId, field: 'labels' },
			{ localId: 'traded', lineageId, field: 'labels' },
			{ localId: 'fewer', lineageId, field: 'labels' }
		]);
		// Nothing changed in the account.
		expect(JSON.parse((await headLabels(lineageId)) ?? 'null')).toEqual(labels);
		const versions = 'SELECT count(*) AS n FROM versions WHERE lineage_id = ?';
		expect(await count(versions, lineageId)).toBe(1);
	});

	it('inside the batch too: a reordered copy is compared band by band', async () => {
		const me = await member();
		const s1 = presetS1(4);
		const moved = reorder(s1, ROTATE);
		expect(moved).not.toBe(s1);
		const labels = ten(['Sub', null, 'Ar']);
		const result = await mergeLocalLibrary(env.DB, me.user.id, [
			item('first', s1, 'Lote', labels),
			item('moved', moved, 'Lote', moveLabels(labels, ROTATE)),
			item('stayed', moved, 'Lote', labels)
		]);
		expect(result.created).toHaveLength(1);
		const lineageId = result.created[0]?.lineageId ?? '';
		expect(result.duplicates).toEqual([{ localId: 'moved', lineageId }]);
		expect(result.conflicts).toEqual([{ localId: 'stayed', lineageId, field: 'labels' }]);
	});

	it('identical bands are interchangeable: which one carries a name never matters', async () => {
		const me = await member();
		const cut: Band = { kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 };
		const other: Band = { kind: 'PK', freqHz: 4000, gainDb: -2, qFactor: 1 };
		const off: Band = { kind: 'OFF' };
		const s1 = encodeS1({
			bands: [cut, cut, other, ...Array.from({ length: 7 }, () => off)],
			preampDb: -1.3
		});
		/** The distinct band first: [other, cut, cut, OFF…]. */
		const order = [2, 0, 1, 3, 4, 5, 6, 7, 8, 9];
		const moved = reorder(s1, order);
		expect(moved).not.toBe(s1);
		const labels = ten(['A', 'B', 'C']);
		const first = await mergeLocalLibrary(env.DB, me.user.id, [item('a', s1, 'Par', labels)]);
		expect(first.created).toHaveLength(1);
		const lineageId = first.created[0]?.lineageId ?? '';

		const batch = [
			item('moved', moved, 'Par', ten(['C', 'A', 'B'])),
			// The two identical cuts traded names: still the same labelled curve.
			item('twins', moved, 'Par', ten(['C', 'B', 'A'])),
			// 'C' left the distinct band for a cut, 'A' went to the distinct band.
			item('crossed', moved, 'Par', ten(['A', 'B', 'C']))
		];
		const expected = {
			duplicates: [
				{ localId: 'moved', lineageId },
				{ localId: 'twins', lineageId }
			],
			conflicts: [{ localId: 'crossed', lineageId, field: 'labels' }]
		};
		// Deterministic: the same answer every time.
		for (let run = 0; run < 2; run++) {
			const result = await mergeLocalLibrary(env.DB, me.user.id, batch);
			expect(result.created).toEqual([]);
			expect(result.rejected).toEqual([]);
			expect({ duplicates: result.duplicates, conflicts: result.conflicts }).toEqual(expected);
		}
		expect(JSON.parse((await headLabels(lineageId)) ?? 'null')).toEqual(labels);
	});
});
