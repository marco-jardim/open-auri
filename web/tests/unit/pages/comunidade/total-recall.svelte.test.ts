// T4.13: Total Recall (owner). Versions, the band diff between two versions, and "restore" as a
// NEW version appended on the head the owner saw; HEAD_MOVED is shown clearly, never retried.
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
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
	// Rows are named in natural language ("Filtro n"), never with a plan code (T15).
	await expect
		.element(
			page.getByRole('rowheader', { name: m.comunidade_v2_recall_filter({ n: '1' }), exact: true })
		)
		.toBeVisible();
	const rowHeaders = Array.from(document.querySelectorAll('th[scope="row"]'));
	expect(rowHeaders.length).toBeGreaterThan(0);
	for (const header of rowHeaders) {
		expect(header.textContent ?? '').not.toMatch(/^S\d+$/);
	}
});

test('restore is unavailable with a reason for an unverified owner', async () => {
	const { props, fetch } = setup(() => apiError('INTERNAL', 500));
	await render(TotalRecall, { ...props, canWrite: false });
	await expect.element(restoreButton()).toHaveAttribute('aria-disabled', 'true');
	const ids = restoreButton().element().getAttribute('aria-describedby')?.split(/\s+/) ?? [];
	const reason = ids.map((value) => document.getElementById(value)?.textContent?.trim()).join(' ');
	expect(reason).toBe(m.comunidade_verify_prompt());
	expect(fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
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

test('no creations stays empty without requests; offline waits until reconnected', async () => {
	const { props, fetch } = setup(() => apiError('INTERNAL', 500));
	const screen = await render(TotalRecall, { ...props, owned: [] });
	await expect.element(page.getByText(m.comunidade_recall_none())).toBeVisible();
	expect(fetch).not.toHaveBeenCalled();
	await screen.rerender({ owned: props.owned, online: false });
	await expect.element(page.getByText(m.comunidade_offline())).toBeVisible();
	expect(fetch).not.toHaveBeenCalled();
	await screen.rerender({ online: true });
	await expect.element(restoreButton()).toBeVisible();
	await screen.rerender({ online: false });
	await expect.element(restoreButton()).toHaveAttribute('aria-disabled', 'true');
	await expect.element(restoreButton()).toHaveAccessibleDescription(m.comunidade_offline());
});

test('loading has four placeholders and a failed lineage shows a localized error', async () => {
	const { props } = setup(() => apiError('INTERNAL', 500));
	let reject: (error: Error) => void = () => undefined;
	vi.spyOn(props.api, 'getLineage').mockReturnValue(
		new Promise((_resolve, fail) => {
			reject = fail;
		})
	);
	await render(TotalRecall, props);
	await expect.element(page.getByTestId('recall-loading')).toHaveAttribute('aria-busy', 'true');
	expect(document.querySelectorAll('.skel-row')).toHaveLength(4);
	reject(new Error('private failure'));
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.comunidade_error_generic());
	expect(document.querySelector('.commits')).toBeNull();
});

test('choosing head as the source hides restore and cached comparisons do not refetch', async () => {
	const { props, fetch } = setup(() => apiError('INTERNAL', 500));
	await render(TotalRecall, props);
	await expect.element(page.getByRole('table')).toBeVisible();
	const reads = fetch.mock.calls.length;
	const from = page.getByRole('combobox', { name: m.comunidade_recall_from() });
	await userEvent.selectOptions(from, 'ver2xxxxx');
	expect(restoreButton().elements()).toHaveLength(0);
	await expect.poll(() => document.querySelectorAll('tr.changed').length).toBe(0);
	await userEvent.selectOptions(from, 'ver1xxxxx');
	await expect.poll(() => document.querySelectorAll('tr.changed').length).toBe(1);
	await userEvent.selectOptions(
		page.getByRole('combobox', { name: m.comunidade_recall_to() }),
		'ver1xxxxx'
	);
	await expect.poll(() => document.querySelectorAll('tr.changed').length).toBe(0);
	expect(fetch.mock.calls.length).toBe(reads);
});

test.each([
	['GATE_REJECTED', { reasons: ['g:preamp', 'unknown'] }, m.cable_reason_g_preamp],
	['INVALID_CURVE', { codes: ['env:length'] }, m.comunidade_env_length],
	['QUOTA_EXCEEDED', {}, m.comunidade_error_rate]
] as const)(
	'restore failure %s lists actionable localized details without retry',
	async (code, details, message) => {
		const { props, fetch } = setup(() => apiError(code, 422, details));
		await render(TotalRecall, props);
		await restoreButton().click();
		await expect.element(page.getByText(message()).first()).toBeVisible();
		expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
		expect(page.getByTestId('recall-conflict').elements()).toHaveLength(0);
	}
);

test('invalid source S1 fails locally and never appends a version', async () => {
	const { props, fetch } = setup(() => apiError('INTERNAL', 500));
	const getCurve = props.api.getCurve.bind(props.api);
	vi.spyOn(props.api, 'getCurve').mockImplementation(async (...args) => {
		const full = await getCurve(...args);
		return { ...full, curve: { ...full.curve, s1: 'invalid' } };
	});
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await render(TotalRecall, props);
	await restoreButton().click();
	await expect.element(page.getByText(m.comunidade_env_invalid())).toBeVisible();
	expect(document.querySelector('table')).toBeNull();
	expect(fetch.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
});

test('curve fetch failure is shown and a later restore retries rather than caching the rejection', async () => {
	const { props } = setup(() => json({ lineageId: LINEAGE.id, versionId: 'ver3', curveId: 'c3' }));
	const original = props.api.getCurve.bind(props.api);
	const get = vi.spyOn(props.api, 'getCurve').mockRejectedValue(new Error('unavailable'));
	const onrestored = vi.fn();
	await render(TotalRecall, { ...props, onrestored });
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.comunidade_error_generic());
	get.mockImplementation(original);
	await restoreButton().click();
	await expect.poll(() => onrestored.mock.calls.length).toBe(1);
	expect(
		get.mock.calls.filter(([, options]) => options?.versionId === 'ver1xxxxx').length
	).toBeGreaterThanOrEqual(2);
});

test('preferred lineage is honored only when owned, and changing it ignores a stale successful response', async () => {
	const { props } = setup(() => apiError('INTERNAL', 500));
	const original = await props.api.getLineage(LINEAGE.id);
	let resolve: (value: typeof original) => void = () => undefined;
	const old = new Promise<typeof original>((done) => {
		resolve = done;
	});
	const get = vi.spyOn(props.api, 'getLineage').mockImplementation(async (id) => {
		if (id === LINEAGE.id) return old;
		return { ...original, lineage: { ...original.lineage, id }, versions: [] };
	});
	const screen = await render(TotalRecall, {
		...props,
		owned: [...props.owned, { id: 'lin-second', name: 'Segunda criação' }],
		preferred: 'not-owned'
	});
	await expect.poll(() => get.mock.calls.length).toBe(1);
	expect(get.mock.calls[0]?.[0]).toBe(LINEAGE.id);
	await screen.rerender({ preferred: 'lin-second' });
	await expect.poll(() => get.mock.calls.length).toBe(2);
	resolve(original);
	await old;
	await expect
		.element(page.getByRole('combobox', { name: m.comunidade_recall_lineage() }))
		.toHaveValue('lin-second');
	expect(document.querySelectorAll('.commit')).toHaveLength(0);
	expect(page.getByRole('table').elements()).toHaveLength(0);
});

test.each([{ versions: [] }, { versions: [version('ver1xxxxx', null, 'Única versão', true)] }])(
	'empty and root-only histories have no restore action ($versions)',
	async ({ versions }) => {
		const { props } = setup(() => apiError('INTERNAL', 500));
		const original = await props.api.getLineage(LINEAGE.id);
		vi.spyOn(props.api, 'getLineage').mockResolvedValue({
			...original,
			versions: versions as typeof original.versions
		});
		await render(TotalRecall, props);
		await expect
			.element(page.getByRole('combobox', { name: m.comunidade_recall_to() }))
			.toBeVisible();
		expect(document.querySelectorAll('.commit')).toHaveLength(versions.length);
		expect(restoreButton().elements()).toHaveLength(0);
		expect(page.getByRole('table').elements()).toHaveLength(0);
	}
);

test('missing head marker falls back to first version and restoring legacy language uses pt-BR', async () => {
	const { props, fetch } = setup(() =>
		json({ lineageId: LINEAGE.id, versionId: 'ver3', curveId: 'c3' })
	);
	const original = await props.api.getLineage(LINEAGE.id);
	vi.spyOn(props.api, 'getLineage').mockResolvedValue({
		...original,
		versions: original.versions.map((value) => ({ ...value, isHead: false, lang: 'legacy' }))
	});
	await render(TotalRecall, props);
	const from = page.getByRole('combobox', { name: m.comunidade_recall_from() });
	await expect
		.element(page.getByRole('combobox', { name: m.comunidade_recall_to() }))
		.toHaveValue('ver2xxxxx');
	await userEvent.selectOptions(from, 'ver1xxxxx');
	await restoreButton().click();
	await expect
		.element(page.getByText(m.comunidade_recall_restored({ version: 'ver1xxx' })))
		.toBeVisible();
	const post = fetch.mock.calls.find(([, init]) => init.method === 'POST');
	expect(JSON.parse(String(post?.[1].body))).toMatchObject({ envelope: { lang: 'pt-BR' } });
});
