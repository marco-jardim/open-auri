// T4.13: Total Recall (owner). Versions, the band diff between two versions, and "restore" as a
// NEW version appended on the head the owner saw; HEAD_MOVED is shown clearly, never retried.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import TotalRecall from '#lib/components/pages/comunidade/TotalRecall.svelte';
import { m } from '#lib/paraglide/messages.js';
import { S1_BOOST, S1_NEUTRAL, apiError, apiWith, fakeFetch, headerOf, json } from './fixtures.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const LINEAGE = {
	id: 'lin-owned00001',
	visibility: 'public',
	status: 'active',
	moderation: 'visible',
	curated: false,
	forkedFromVersion: null,
	headVersion: 'ver2xxxxx',
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_100_000,
	isOwner: true
};

function version(id: string, parentId: string | null, name: string, isHead: boolean) {
	return {
		id,
		parentId,
		curveId: `c-${id}`,
		name,
		description: '',
		license: 'CC0-1.0',
		lang: 'pt-BR',
		createdAt: isHead ? 1_700_000_100_000 : 1_700_000_000_000,
		isHead
	};
}

const VERSIONS = [
	version('ver2xxxxx', 'ver1xxxxx', 'Segunda', true),
	version('ver1xxxxx', null, 'Primeira', false)
];

function curve(versionId: string, s1: string) {
	const v = VERSIONS.find((item) => item.id === versionId) ?? VERSIONS[0];
	return {
		lineage: LINEAGE,
		author: null,
		version: { ...v, recipe: null },
		curve: {
			id: `c-${versionId}`,
			s1,
			levelDb: null,
			gate: { ok: true, reasons: [], version: 'v2' }
		},
		counts: { favorites: 0, previewed: 0, installed: 0 }
	};
}

function setup(append: () => Response) {
	const fetch = fakeFetch((url, init) => {
		if (url.pathname === `/api/v1/lineages/${LINEAGE.id}` && (init.method ?? 'GET') === 'GET') {
			return json({ lineage: LINEAGE, author: null, versions: VERSIONS, nextCursor: null });
		}
		if (url.pathname === `/api/v1/curves/${LINEAGE.id}`) {
			const v = url.searchParams.get('v') ?? '';
			return json(curve(v, v === 'ver1xxxxx' ? S1_NEUTRAL : S1_BOOST));
		}
		if (url.pathname === `/api/v1/lineages/${LINEAGE.id}/versions` && init.method === 'POST') {
			return append();
		}
		return undefined;
	});
	return {
		fetch,
		props: {
			api: apiWith(fetch),
			owned: [{ id: LINEAGE.id, name: 'Minha curva' }],
			canWrite: true,
			online: true
		}
	};
}

const restoreButton = () =>
	page.getByRole('button', { name: m.comunidade_recall_restore({ version: 'ver1xxx' }) });

test('lists the versions and diffs the bands of two versions', async () => {
	const { props } = setup(() => apiError('INTERNAL', 500));
	await render(TotalRecall, props);
	await expect.element(page.getByText('Segunda').first()).toBeVisible();
	await expect.element(page.getByText('HEAD', { exact: true })).toBeVisible();
	await expect.element(page.getByText(m.comunidade_recall_diff_caption())).toBeVisible();
	await expect.poll(() => document.querySelectorAll('tr.changed').length).toBe(1);
});

test('restore appends a new version on the head that was seen', async () => {
	const { props, fetch } = setup(() =>
		json({ lineageId: LINEAGE.id, versionId: 'ver3xxxxx', curveId: 'c3' }, 201)
	);
	await render(TotalRecall, props);
	await restoreButton().click();
	await expect
		.element(page.getByText(m.comunidade_recall_restored({ version: 'ver1xxx' })))
		.toBeVisible();
	const post = fetch.mock.calls.find(([, init]) => init.method === 'POST');
	expect(post).toBeDefined();
	const body: unknown = JSON.parse(String(post?.[1].body));
	expect(body).toMatchObject({
		parentVersionId: 'ver2xxxxx',
		envelope: { code: S1_NEUTRAL, name: 'Primeira', license: 'CC0-1.0' }
	});
	expect(headerOf(post?.[1], 'content-type')).toBe('application/json');
});

test('a HEAD_MOVED conflict is shown clearly and offers to reload', async () => {
	const { props, fetch } = setup(() => apiError('HEAD_MOVED', 409));
	await render(TotalRecall, props);
	await restoreButton().click();
	await expect
		.element(page.getByTestId('recall-conflict'))
		.toMatchTextContent(m.comunidade_recall_head_moved());
	const posts = () => fetch.mock.calls.filter(([, init]) => init.method === 'POST').length;
	expect(posts()).toBe(1);
	const reads = fetch.mock.calls.length;
	await page.getByRole('button', { name: m.comunidade_recall_reload() }).click();
	await expect.poll(() => fetch.mock.calls.length).toBeGreaterThan(reads);
	expect(posts()).toBe(1);
});
