// YOLO publication in Total Recall: restoring a historical YOLO version (`curve.yolo`, the
// server's class) as the head of a lineage others can see goes through the acknowledgement step
// and is sent with `acknowledge: 'yolo'`, as on every other publication path. A private lineage
// needs no step; 409 YOLO_ACK_REQUIRED shows the step; 403 answers say why and end it.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import TotalRecall from '#lib/components/pages/comunidade/TotalRecall.svelte';
import { m } from '#lib/paraglide/messages.js';
import { S1_BOOST, S1_NEUTRAL, apiError, apiWith, fakeFetch, json } from './fixtures.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

type Visibility = 'private' | 'unlisted' | 'public';

function lineage(visibility: Visibility) {
	return {
		id: 'lin-yolo000001',
		visibility,
		status: 'active',
		moderation: 'visible',
		curated: false,
		forkedFromVersion: null,
		headVersion: 'ver2xxxxx',
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_100_000,
		isOwner: true
	};
}

function version(id: string, parentId: string | null, name: string, isHead: boolean) {
	return {
		id,
		parentId,
		curveId: `c-${id}`,
		name,
		description: '',
		license: 'CC0-1.0',
		lang: 'pt-BR',
		labels: null,
		createdAt: isHead ? 1_700_000_100_000 : 1_700_000_000_000,
		isHead
	};
}

const VERSIONS = [
	version('ver2xxxxx', 'ver1xxxxx', 'Segunda', true),
	version('ver1xxxxx', null, 'Subsônica', false)
];

/**
 * The lineage at `visibility`, whose old version `ver1xxxxx` is YOLO when `yolo` (the server's
 * class); `append` answers each restore.
 */
function setup(visibility: Visibility, yolo: boolean, append: (body: unknown) => Response) {
	const owned = lineage(visibility);
	const fetch = fakeFetch((url, init) => {
		if (url.pathname === `/api/v1/lineages/${owned.id}` && (init.method ?? 'GET') === 'GET') {
			return json({ lineage: owned, author: null, versions: VERSIONS, nextCursor: null });
		}
		if (url.pathname === `/api/v1/curves/${owned.id}`) {
			const id = url.searchParams.get('v') ?? '';
			const old = id === 'ver1xxxxx';
			const v = VERSIONS.find((item) => item.id === id) ?? VERSIONS[0];
			return json({
				lineage: owned,
				author: null,
				version: { ...v, recipe: null },
				curve: {
					id: `c-${id}`,
					s1: old ? S1_NEUTRAL : S1_BOOST,
					levelDb: null,
					gate: { ok: !(old && yolo), reasons: [], version: 'v2' },
					yolo: old && yolo,
					waived: old && yolo ? ['a:b2'] : []
				},
				counts: { favorites: 0, previewed: 0, installed: 0 }
			});
		}
		if (url.pathname === `/api/v1/lineages/${owned.id}/versions` && init.method === 'POST') {
			return append(JSON.parse(String(init.body)));
		}
		return undefined;
	});
	const posts = () =>
		fetch.mock.calls
			.filter(([, init]) => init.method === 'POST')
			.map(([, init]): unknown => JSON.parse(String(init.body)));
	return {
		posts,
		props: {
			api: apiWith(fetch),
			owned: [{ id: owned.id, name: 'Minha curva' }],
			canWrite: true,
			online: true
		}
	};
}

const restored = () => json({ lineageId: 'lin-yolo000001', versionId: 'ver3xxxxx', curveId: 'c3' });
const restoreButton = () =>
	page.getByRole('button', { name: m.comunidade_recall_restore({ version: 'ver1xxx' }) });
const step = () => page.getByRole('group', { name: m.yolopub_ack_title() });
const acked = (body: unknown) => typeof body === 'object' && body !== null && 'acknowledge' in body;

async function acknowledge() {
	await step().getByRole('checkbox', { name: m.yolopub_ack_checkbox() }).click();
	await step().getByRole('button', { name: m.yolopub_ack_button() }).click();
}

for (const visibility of ['public', 'unlisted'] as const) {
	test(`restoring a YOLO version into a ${visibility} lineage asks first, then sends the acknowledgement`, async () => {
		const { props, posts } = setup(visibility, true, restored);
		await render(TotalRecall, props);
		await restoreButton().click();
		await expect.element(step()).toMatchTextContent(m.yolopub_ack_body());
		// Nothing is sent before the step.
		expect(posts()).toEqual([]);
		await acknowledge();
		await expect
			.element(page.getByText(m.comunidade_recall_restored({ version: 'ver1xxx' })))
			.toBeVisible();
		expect(posts()).toHaveLength(1);
		expect(posts()[0]).toMatchObject({
			parentVersionId: 'ver2xxxxx',
			acknowledge: 'yolo',
			envelope: { code: S1_NEUTRAL, name: 'Subsônica' }
		});
		await expect.element(step()).not.toBeInTheDocument();
	});
}

test('a private lineage restores a YOLO version with no step and no acknowledgement', async () => {
	const { props, posts } = setup('private', true, restored);
	await render(TotalRecall, props);
	await restoreButton().click();
	await expect
		.element(page.getByText(m.comunidade_recall_restored({ version: 'ver1xxx' })))
		.toBeVisible();
	expect(posts()).toHaveLength(1);
	expect(acked(posts()[0])).toBe(false);
	expect(step().elements()).toEqual([]);
});

test('cancelling the step sends nothing and brings "Restaurar" back', async () => {
	const { props, posts } = setup('public', true, restored);
	await render(TotalRecall, props);
	await restoreButton().click();
	await expect.element(step()).toBeVisible();
	await step().getByRole('button', { name: m.yolopub_ack_cancel() }).click();
	await expect.element(step()).not.toBeInTheDocument();
	await expect.element(restoreButton()).toBeVisible();
	expect(posts()).toEqual([]);
});

test('409 YOLO_ACK_REQUIRED shows the step; confirming resends with the acknowledgement', async () => {
	// The client did not know the version is YOLO; the server's class says so.
	const { props, posts } = setup('public', false, (body) =>
		acked(body) ? restored() : apiError('YOLO_ACK_REQUIRED', 409, { waived: ['a:b2'] })
	);
	await render(TotalRecall, props);
	await restoreButton().click();
	await expect.element(step()).toBeVisible();
	expect(posts()).toHaveLength(1);
	expect(acked(posts()[0])).toBe(false);
	await acknowledge();
	await expect
		.element(page.getByText(m.comunidade_recall_restored({ version: 'ver1xxx' })))
		.toBeVisible();
	expect(posts()).toHaveLength(2);
	expect(posts()[1]).toMatchObject({ acknowledge: 'yolo' });
});

test.each([
	['YOLO_PUBLICATION_OFF', undefined, () => m.yolopub_error_off()],
	['FORBIDDEN', { reason: 'account-age' }, () => m.yolopub_error_account_age()]
] as const)('403 %s says why and ends the step', async (code, details, text) => {
	const { props, posts } = setup('public', true, () => apiError(code, 403, details));
	await render(TotalRecall, props);
	await restoreButton().click();
	await acknowledge();
	await expect.element(page.getByText(text(), { exact: true })).toBeVisible();
	await expect.element(step()).not.toBeInTheDocument();
	expect(posts()).toHaveLength(1);
	expect(posts()[0]).toMatchObject({ acknowledge: 'yolo' });
});
