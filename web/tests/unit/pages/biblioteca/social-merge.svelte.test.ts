import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { SocialApiError, type LibraryMergeItem, type MergeReport } from '#lib/social/index.ts';
import MergeBanner from '#lib/components/pages/biblioteca/MergeBanner.svelte';
import {
	MERGE_KEY,
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

/** Server stand-in: loc0 is created, loc1 a duplicate, loc2 a name conflict, loc3 fails the gate,
 * loc4 hits the daily quota (transient); every other item is created. */
function fakeMerge() {
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
			else if (entry.localId === 'loc4')
				report.rejected.push({ localId: entry.localId, code: 'QUOTA_EXCEEDED' });
			else report.created.push({ localId: entry.localId, lineageId });
		}
		return report;
	});
	return { batches, api: { mergeLibrary } };
}

test('runMerge sends batches of at most 100 and keeps transient rejections offerable', async () => {
	const { batches, api } = fakeMerge();
	const items = locals(250).map((item) => ({ localId: item.id, s1: item.s1, name: item.name }));
	const outcome = await runMerge(api, items);
	expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
	expect(outcome.error).toBeNull();
	expect(outcome.unsent).toBe(0);
	expect(outcome.report.created).toHaveLength(246);
	expect(outcome.handled).toContain('loc3');
	expect(outcome.handled).not.toContain('loc4');
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
	expect(outcome.unsent).toBe(130);
	expect(outcome.handled).toHaveLength(100);
});

test('the banner never merges by itself; the click merges and shows the full report', async () => {
	const storage = memoryStorage();
	const { batches, api } = fakeMerge();
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
	expect(batches).toHaveLength(1);
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
