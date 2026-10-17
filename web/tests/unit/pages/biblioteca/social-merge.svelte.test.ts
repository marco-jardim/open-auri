import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { SocialApiError, type LibraryMergeItem, type MergeReport } from '#lib/social/index.ts';
import MergeBanner from '#lib/components/pages/biblioteca/MergeBanner.svelte';
import {
	MERGE_KEY,
	accountKey,
	readMergeFlag,
	runMerge,
	unmergedItems,
	type KeyValueStorage,
	type LocalLibraryItem
} from '#lib/components/pages/biblioteca/social.ts';

vi.mock('#lib/paraglide/messages.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('#lib/paraglide/messages.js')>();
	const { getLocale } = await import('#lib/paraglide/runtime.js');
	const catalogs = import.meta.glob<Record<string, string>>(
		[
			'../../../../messages/_staging/T4.14.*.json',
			'../../../../messages/pt-BR.json',
			'../../../../messages/en-US.json'
		],
		{ eager: true, import: 'default' }
	);
	const catalog = (locale: string) =>
		Object.assign(
			{},
			...Object.entries(catalogs)
				.filter(([path]) => path.endsWith(`${locale}.json`))
				.map(([, values]) => values)
		) as Record<string, string>;
	const pt = catalog('pt-BR');
	const en = catalog('en-US');
	const task = Object.fromEntries(
		Object.keys(pt)
			.filter((key) => key.startsWith('biblioteca_social_'))
			.map((key) => [
				key,
				(values: Record<string, string | number> = {}) =>
					(getLocale() === 'en-US' ? en : pt)[key].replace(/\{(\w+)\}/g, (_, name: string) =>
						String(values[name] ?? '')
					)
			])
	);
	return { ...original, m: { ...original.m, ...task } };
});

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		}
	};
}

function locals(count: number, updatedAt = 10): LocalLibraryItem[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `loc${index}`,
		name: `Curva ${index}`,
		s1: `s1-${index}`,
		updatedAt
	}));
}

/** Server stand-in: loc1 is a duplicate, loc2 a name conflict, loc3 fails the gate;
 * optionally loc4 hits the daily quota (transient). Every other item is created. */
function fakeMerge({ quota = false } = {}) {
	const batches: LibraryMergeItem[][] = [];
	const mergeLibrary = vi.fn(async (items: LibraryMergeItem[]): Promise<MergeReport> => {
		batches.push(items);
		const report: MergeReport = { created: [], duplicates: [], rejected: [], conflicts: [] };
		for (const entry of items) {
			const lineageId = `lin-${entry.localId}`;
			if (entry.localId === 'loc1') report.duplicates.push({ localId: entry.localId, lineageId });
			else if (entry.localId === 'loc2')
				report.conflicts.push({ localId: entry.localId, lineageId, field: 'name' });
			else if (entry.localId === 'loc3')
				report.rejected.push({
					localId: entry.localId,
					code: 'GATE_REJECTED',
					reasons: ['gain.max', 'slope']
				});
			else if (quota && entry.localId === 'loc4')
				report.rejected.push({ localId: entry.localId, code: 'QUOTA_EXCEEDED' });
			else report.created.push({ localId: entry.localId, lineageId });
		}
		return report;
	});
	return { batches, api: { mergeLibrary } };
}

test('account merge flags use the stable id across nickname changes and isolate nickname reuse', () => {
	const storage = memoryStorage();
	const account = { id: 'u-ana', username: 'Ana', emailVerified: true };
	const key = accountKey(account);
	expect(key).toBe('u-ana');
	storage.setItem(MERGE_KEY, JSON.stringify({ [key]: { offeredAt: 50, handled: ['loc0'] } }));
	expect(readMergeFlag(storage, accountKey({ ...account, username: 'Outro' })).handled).toEqual([
		'loc0'
	]);
	expect(accountKey({ ...account, username: null })).toBe(key);
	expect(readMergeFlag(storage, accountKey({ ...account, id: 'u-other' })).handled).toEqual([]);
	expect(accountKey(null)).toBe('~');
});

test('runMerge sends batches of at most 20 and remembers permanent rejections', async () => {
	const { batches, api } = fakeMerge();
	const items = locals(45).map((item) => ({ localId: item.id, s1: item.s1, name: item.name }));
	const outcome = await runMerge(api, items);
	expect(batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
	expect(outcome.error).toBeNull();
	expect(outcome.unsent).toBe(0);
	expect(outcome.report.created).toHaveLength(42);
	expect(outcome.handled).toContain('loc3');
	expect(outcome.handled).toContain('loc4');
});

test('runMerge auto-continues quota items while retries make progress, without duplicate reports', async () => {
	const batches: LibraryMergeItem[][] = [];
	const progress = vi.fn();
	const outcome = await runMerge(
		{
			mergeLibrary: async (batch) => {
				batches.push(batch);
				const accepted = batches.length === 1 ? 10 : batches.length === 2 ? 5 : batch.length;
				return {
					created: batch.slice(0, accepted).map((entry) => ({
						localId: entry.localId,
						lineageId: `lin-${entry.localId}`
					})),
					duplicates: [],
					conflicts: [],
					rejected: batch.slice(accepted).map((entry) => ({
						localId: entry.localId,
						code: 'QUOTA_EXCEEDED'
					}))
				};
			}
		},
		locals(45).map((item) => ({ localId: item.id, s1: item.s1, name: item.name })),
		progress
	);
	expect(batches.map((batch) => batch.length)).toEqual([20, 10, 5, 20, 5]);
	expect(batches[1]?.map((entry) => entry.localId)).toEqual(
		batches[0]?.slice(10).map((entry) => entry.localId)
	);
	expect(outcome.report.created).toHaveLength(45);
	expect(outcome.report.rejected).toEqual([]);
	expect(new Set(outcome.handled).size).toBe(45);
	expect(outcome.error).toBeNull();
	expect(outcome.unsent).toBe(0);
	expect(progress.mock.calls).toEqual([
		[10, 45],
		[15, 45],
		[20, 45],
		[40, 45],
		[45, 45]
	]);
});

test('daily quota stops after one retry pass without progress and leaves the rest offerable', async () => {
	const { batches, api } = fakeMerge({ quota: true });
	const outcome = await runMerge(
		api,
		locals(45).map((item) => ({ localId: item.id, s1: item.s1, name: item.name }))
	);
	expect(batches.map((batch) => batch.length)).toEqual([20, 1]);
	expect(batches[1]?.map((entry) => entry.localId)).toEqual(['loc4']);
	expect(outcome.error).toBe('QUOTA_EXCEEDED');
	expect(outcome.unsent).toBe(25);
	expect(outcome.report.rejected.filter((entry) => entry.code === 'QUOTA_EXCEEDED')).toEqual([
		{ localId: 'loc4', code: 'QUOTA_EXCEEDED' }
	]);
	expect(outcome.handled).toHaveLength(19);
	expect(outcome.handled).not.toContain('loc4');
});

test('a fully spent daily quota gets only one retry, not a loop over the rest of the library', async () => {
	const mergeLibrary = vi.fn(async (batch: LibraryMergeItem[]): Promise<MergeReport> => ({
		created: [],
		duplicates: [],
		conflicts: [],
		rejected: batch.map((entry) => ({ localId: entry.localId, code: 'QUOTA_EXCEEDED' }))
	}));
	const outcome = await runMerge(
		{ mergeLibrary },
		locals(45).map((item) => ({ localId: item.id, s1: item.s1, name: item.name }))
	);
	expect(mergeLibrary).toHaveBeenCalledTimes(2);
	expect(mergeLibrary.mock.calls[1]?.[0]).toEqual(mergeLibrary.mock.calls[0]?.[0]);
	expect(outcome.error).toBe('QUOTA_EXCEEDED');
	expect(outcome.unsent).toBe(25);
	expect(outcome.report.rejected).toHaveLength(20);
	expect(outcome.handled).toEqual([]);
});

test('runMerge stops at the first failed batch and reports the unsent items', async () => {
	let calls = 0;
	const outcome = await runMerge(
		{
			mergeLibrary: async (batch) => {
				calls += 1;
				if (calls === 2) throw new SocialApiError(0, 'OFFLINE');
				return {
					created: batch.map((entry) => ({ localId: entry.localId, lineageId: 'x' })),
					duplicates: [],
					rejected: [],
					conflicts: []
				};
			}
		},
		locals(230).map((item) => ({ localId: item.id, s1: item.s1, name: item.name }))
	);
	expect(calls).toBe(2);
	expect(outcome.error).toBe('OFFLINE');
	expect(outcome.unsent).toBe(210);
	expect(outcome.handled).toHaveLength(20);
});

test('a failed quota retry retains the unresolved rejection and does not resend handled items', async () => {
	let calls = 0;
	const mergeLibrary = vi.fn(async (batch: LibraryMergeItem[]): Promise<MergeReport> => {
		if (++calls === 2) throw new SocialApiError(0, 'OFFLINE');
		return {
			created: batch.slice(1).map((entry) => ({ localId: entry.localId, lineageId: 'x' })),
			duplicates: [],
			conflicts: [],
			rejected: [{ localId: 'loc0', code: 'QUOTA_EXCEEDED' }]
		};
	});
	const outcome = await runMerge(
		{ mergeLibrary },
		locals(21).map((item) => ({ localId: item.id, s1: item.s1, name: item.name }))
	);
	expect(mergeLibrary.mock.calls[1]?.[0].map((entry) => entry.localId)).toEqual(['loc0']);
	expect(outcome.error).toBe('OFFLINE');
	expect(outcome.unsent).toBe(1);
	expect(outcome.handled).toHaveLength(19);
	expect(outcome.report.rejected).toEqual([{ localId: 'loc0', code: 'QUOTA_EXCEEDED' }]);
});

test('one banner click auto-continues request quota rejections and all remaining 20-item batches', async () => {
	const storage = memoryStorage();
	const onMerged = vi.fn();
	let calls = 0;
	const mergeLibrary = vi.fn(async (batch: LibraryMergeItem[]): Promise<MergeReport> => {
		const quotaId = ++calls === 1 ? 'loc19' : null;
		return {
			created: batch
				.filter((entry) => entry.localId !== quotaId)
				.map((entry) => ({ localId: entry.localId, lineageId: `lin-${entry.localId}` })),
			duplicates: [],
			conflicts: [],
			rejected: quotaId ? [{ localId: quotaId, code: 'QUOTA_EXCEEDED' }] : []
		};
	});
	render(MergeBanner, {
		items: locals(21),
		account: 'u-ana',
		verified: true,
		api: { mergeLibrary },
		storage,
		locale: 'pt-BR',
		onMerged
	});
	expect(mergeLibrary).not.toHaveBeenCalled();
	await page.getByRole('button', { name: 'Mesclar biblioteca local' }).click();
	await expect.element(page.getByText('Criadas na conta: 21')).toBeVisible();
	await expect.element(page.getByText('Recusadas: 0 (ficam só neste navegador)')).toBeVisible();
	expect(mergeLibrary.mock.calls.map(([batch]) => batch.length)).toEqual([20, 1, 1]);
	expect(readMergeFlag(storage, 'u-ana').handled).toHaveLength(21);
	expect(onMerged).toHaveBeenCalledTimes(1);
});

test('the banner never merges by itself; the click merges and shows the full report', async () => {
	const storage = memoryStorage();
	const { batches, api } = fakeMerge({ quota: true });
	const onMerged = vi.fn();
	render(MergeBanner, {
		items: locals(6),
		account: 'ana',
		verified: true,
		api,
		storage,
		locale: 'pt-BR',
		onMerged
	});
	await expect
		.element(page.getByText(/6 curvas salvas neste navegador ainda não estão na sua conta/))
		.toBeVisible();
	expect(api.mergeLibrary).not.toHaveBeenCalled();

	await page.getByRole('button', { name: 'Mesclar biblioteca local' }).click();
	await expect.element(page.getByRole('heading', { name: 'Relatório da mescla' })).toBeVisible();
	expect(batches).toHaveLength(2);
	expect(batches[0]?.[0]).toEqual({ localId: 'loc0', s1: 's1-0', name: 'Curva 0', lang: 'pt-BR' });
	await expect.element(page.getByText('Criadas na conta: 2')).toBeVisible();
	await expect.element(page.getByText('Já estavam na conta: 1')).toBeVisible();
	await expect.element(page.getByText('Mesmo som já na conta com outro nome: 1')).toBeVisible();
	await expect.element(page.getByText('Recusadas: 2 (ficam só neste navegador)')).toBeVisible();
	await expect.element(page.getByText('Motivos do gate: gain.max, slope')).toBeVisible();
	await expect.element(page.getByText(/limite diário atingido/)).toBeVisible();
	expect(onMerged).toHaveBeenCalledTimes(1);

	// Remembered per account: merged and gate-rejected ids are not offered again; the quota one is.
	const flag = readMergeFlag(storage, 'ana');
	expect(flag.handled.sort()).toEqual(['loc0', 'loc1', 'loc2', 'loc3', 'loc5']);
	expect(unmergedItems(locals(6), flag).map((item) => item.id)).toEqual(['loc4']);
	expect(readMergeFlag(storage, 'bia').handled).toEqual([]);

	await page.getByRole('button', { name: 'Fechar relatório' }).click();
	await expect.element(page.getByText(/1 curvas salvas neste navegador/)).toBeVisible();
});

test('"Agora não" is remembered for that account until the local library changes', async () => {
	const storage = memoryStorage();
	const { api } = fakeMerge();
	const first = await render(MergeBanner, {
		items: locals(2),
		account: 'ana',
		verified: true,
		api,
		storage,
		locale: 'pt-BR',
		now: () => 50
	});
	await page.getByRole('button', { name: 'Agora não' }).click();
	await expect
		.element(page.getByRole('button', { name: 'Mesclar biblioteca local' }))
		.not.toBeInTheDocument();
	expect(JSON.parse(storage.data.get(MERGE_KEY) ?? '{}').ana.offeredAt).toBe(50);
	await first.unmount();

	render(MergeBanner, {
		items: [...locals(2), { id: 'new', name: 'Nova', s1: 's1-new', updatedAt: 60 }],
		account: 'ana',
		verified: true,
		api,
		storage,
		locale: 'pt-BR'
	});
	await expect.element(page.getByText(/1 curvas salvas/)).toBeVisible();
	expect(api.mergeLibrary).not.toHaveBeenCalled();
});

test('unverified e-mail: the merge is offered but cannot be sent', async () => {
	const { api } = fakeMerge();
	render(MergeBanner, {
		items: locals(1),
		account: 'ana',
		verified: false,
		api,
		storage: memoryStorage(),
		locale: 'pt-BR'
	});
	await expect
		.element(page.getByRole('button', { name: 'Mesclar biblioteca local' }))
		.toBeDisabled();
	await expect
		.element(page.getByText('Confirme seu e-mail para mesclar a biblioteca local.'))
		.toBeVisible();
});
