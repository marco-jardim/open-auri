import { describe, expect, it, vi } from 'vitest';
import { GRID } from 'open-auri/dsp';
import {
	createAutoEqClient,
	searchEntries,
	type AutoEqEntry,
	type AutoEqManifest
} from '../../../src/lib/data/autoeq';

const entries: AutoEqEntry[] = [
	{
		id: 'a',
		name: 'Áudio Bud Reference',
		brand: 'Áudio Works',
		source: 'Rtings',
		type: 'iem',
		pack: 'measurements-rtings-abc-iem-001.bin',
		offset: 0
	},
	{
		id: 'b',
		name: 'Audio Budget',
		brand: 'Audio',
		source: 'rtings',
		type: 'iem',
		pack: 'measurements-rtings-abc-iem-001.bin',
		offset: 962
	},
	{
		id: 'c',
		name: 'Acme Studio',
		brand: 'Acme',
		source: 'Legacy Lab',
		type: 'over-ear',
		pack: 'measurements-legacy-lab-over-ear-001.bin',
		offset: 0
	},
	{
		id: 't',
		name: 'Harman in-ear 2019',
		brand: 'AutoEq',
		source: 'AutoEq targets',
		type: 'target',
		pack: 'targets-001.bin',
		offset: 0
	}
];

const manifest: AutoEqManifest = {
	sha: '7ae0f56d53074872b028649617a22bbb4232feb7',
	commitDate: '2025-07-20T00:00:00Z',
	generatedAt: '2026-10-16T00:00:00Z',
	grid: { points: 481, minHz: 20, maxHz: 20000 },
	counts: { measurements: 3, targets: 1, skipped: 0, clampedValues: 0, packs: 3 },
	sources: [
		{
			name: 'Rtings',
			measurements: 1,
			attribution: 'Rtings via AutoEq, Jaakko Pasanen, MIT.',
			link: 'https://github.com/jaakkopasanen/AutoEq'
		},
		{
			name: 'rtings',
			measurements: 1,
			attribution: 'rtings via AutoEq, Jaakko Pasanen, MIT.',
			link: 'https://github.com/jaakkopasanen/AutoEq'
		}
	],
	license: 'MIT (AutoEq)',
	excluded: []
};

function pack(...values: number[]): ArrayBuffer {
	const buffer = new ArrayBuffer(values.length * 962);
	const view = new DataView(buffer);
	values.forEach((value, entry) => {
		for (let point = 0; point < 481; point++) view.setInt16(entry * 962 + point * 2, value, true);
	});
	return buffer;
}

function fixtureClient() {
	const fetchImpl = vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url.endsWith('/index.json')) return Response.json(entries);
		if (url.endsWith('/manifest.json')) return Response.json(manifest);
		if (url.endsWith(entries[0].pack)) return new Response(pack(-1234, 567));
		if (url.endsWith(entries[2].pack)) return new Response(pack(321));
		if (url.endsWith(entries[3].pack)) return new Response(pack(100));
		return new Response(null, { status: 404 });
	});
	return { client: createAutoEqClient({ fetchImpl }), fetchImpl };
}

describe('AutoEq search', () => {
	it('folds accents/case, scores token prefixes and searches brand and source', () => {
		expect(searchEntries(entries, 'AUDIO bud').map((entry) => entry.id)).toEqual(['a', 'b']);
		expect(searchEntries(entries, 'áud wor RTI').map((entry) => entry.id)).toEqual(['a']);
		expect(searchEntries(entries, 'LEG stu').map((entry) => entry.id)).toEqual(['c']);
		expect(searchEntries(entries, 'HARM 2019').map((entry) => entry.id)).toEqual(['t']);
		expect(searchEntries(entries, 'audio missing')).toEqual([]);
	});

	it('accepts one typo in longer tokens, stable ties, empty queries and limits', () => {
		expect(searchEntries(entries, 'stduio')).toEqual([]); // Two substitutions, not one.
		expect(searchEntries(entries, 'studoo').map((entry) => entry.id)).toEqual(['c']);
		expect(searchEntries(entries.toReversed(), '').map((entry) => entry.id)).toEqual([
			'a',
			'b',
			'c',
			't'
		]);
		expect(searchEntries(entries, 'audio', 1).map((entry) => entry.id)).toEqual(['a']);
		expect(searchEntries(entries, '', 0)).toEqual([]);
		expect(() => searchEntries(entries, '', -1)).toThrow(RangeError);
	});
});

describe('AutoEq lazy client', () => {
	it('deduplicates index requests and does not fetch packs during search', async () => {
		const { client, fetchImpl } = fixtureClient();
		const [first, second] = await Promise.all([client.loadIndex(), client.loadIndex()]);
		expect(first).toBe(second);
		expect(await client.search('acme')).toEqual([entries[2]]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith('/data/autoeq/index.json');
	});

	it('loads a shared pack once, decodes LE signed values and byte offsets onto GRID', async () => {
		const { client, fetchImpl } = fixtureClient();
		const [first, second] = await Promise.all([
			client.loadEntry(entries[0]),
			client.loadEntry(entries[1])
		]);
		expect(first.frequencies).toBe(GRID);
		expect(first.values).toEqual(Array(481).fill(-12.34));
		expect(second.values).toEqual(Array(481).fill(5.67));
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		first.values[0] = 999;
		expect((await client.loadEntry(entries[0])).values[0]).toBe(-12.34);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect((await client.loadEntry(entries[2])).values[0]).toBe(3.21);
		expect((await client.loadEntry(entries[3])).values[0]).toBe(1);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it('gets per-source attribution with case-sensitive identity, plus target credits', async () => {
		const { client, fetchImpl } = fixtureClient();
		expect(await client.getAttribution(entries[0])).toEqual(manifest.sources[0]);
		expect(await client.getAttribution('rtings')).toEqual(manifest.sources[1]);
		expect(await client.getAttribution('unknown')).toBeUndefined();
		expect(await client.getAttribution(entries[3])).toMatchObject({
			name: 'AutoEq targets',
			attribution: expect.stringContaining('Copyright (c) 2018-2022 Jaakko Pasanen, MIT.')
		});
		expect((await client.getAttribution(entries[3]))?.link).toContain(`${manifest.sha}/targets`);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('retries failed index, manifest and pack fetches instead of caching rejected promises', async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const client = createAutoEqClient({ baseUrl: '/fixture/', fetchImpl });
		fetchImpl
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(Response.json(entries));
		await expect(client.loadIndex()).rejects.toThrow('HTTP 503');
		expect(await client.loadIndex()).toEqual(entries);
		fetchImpl
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(Response.json(manifest));
		await expect(client.loadManifest()).rejects.toThrow('offline');
		expect(await client.loadManifest()).toEqual(manifest);
		fetchImpl
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(new Response(pack(123, 456)));
		await expect(client.loadEntry(entries[0])).rejects.toThrow('HTTP 404');
		expect((await client.loadEntry(entries[0])).values[0]).toBe(1.23);
		expect(fetchImpl).toHaveBeenCalledWith(`/fixture/${entries[0].pack}`);
	});

	it('rejects invalid paths/offsets, truncated packs, out-of-bounds entries and foreign grids', async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const client = createAutoEqClient({ fetchImpl });
		await expect(client.loadEntry({ ...entries[0], pack: '../secret.bin' })).rejects.toThrow(
			'Invalid AutoEq'
		);
		await expect(client.loadEntry({ ...entries[0], offset: -962 })).rejects.toThrow(
			'Invalid AutoEq'
		);
		await expect(client.loadEntry({ ...entries[0], offset: 2 })).rejects.toThrow('Invalid AutoEq');
		expect(fetchImpl).not.toHaveBeenCalled();
		fetchImpl
			.mockResolvedValueOnce(new Response(new ArrayBuffer(961)))
			.mockResolvedValueOnce(new Response(pack(1)));
		await expect(client.loadEntry(entries[0])).rejects.toThrow('Truncated AutoEq');
		await expect(client.loadEntry(entries[1])).rejects.toThrow('out-of-bounds');
		fetchImpl.mockResolvedValueOnce(
			Response.json({ ...manifest, grid: { points: 480, minHz: 20, maxHz: 20000 } })
		);
		await expect(client.loadManifest()).rejects.toThrow('Unsupported AutoEq grid');
	});
});
