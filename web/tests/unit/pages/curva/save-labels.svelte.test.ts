// QA1 M1: filter labels live on the version (migration 0012), so "Salvar" of the same curve with
// only its labels changed appends a new version; the saved copy remembers the labels it sent, and
// saving again with the same labels and text appends nothing.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1, LABEL_COUNT } from 'open-auri/share';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createSocialSession, ORIGINS_KEY, type SocialFetch } from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';
import SocialActions from '#lib/components/pages/curva/SocialActions.svelte';
import { curvaSocialApi } from '#lib/components/pages/curva/social.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const s1 = encodeS1(curve);
const apps: ClientApp[] = [];
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
const ten = (entries: (string | null)[]) =>
	Array.from({ length: LABEL_COUNT }, (_, index) => entries[index] ?? null);

afterEach(async () => {
	await cleanup();
	for (const app of apps.splice(0)) app.dispose();
	localStorage.removeItem(ORIGINS_KEY);
	vi.restoreAllMocks();
});

interface Call {
	method: string;
	path: string;
	body: unknown;
}
type Route = (body: unknown, count: number) => Response;

const lineage = (id: string, head: string, versions: unknown[] = []) =>
	json({
		lineage: {
			id,
			visibility: 'private',
			status: 'active',
			moderation: 'visible',
			curated: false,
			forkedFromVersion: null,
			headVersion: head,
			createdAt: 1,
			updatedAt: 2,
			isOwner: true
		},
		author: null,
		versions,
		nextCursor: null
	});

async function setup(routes: Record<string, Route>) {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	await app.state.ready;
	const calls: Call[] = [];
	const fetcher = vi.fn<SocialFetch>(async (input, init) => {
		const method = init.method ?? 'GET';
		const path = new URL(input, 'https://example.test').pathname;
		const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		const count = calls.filter((call) => call.method === method && call.path === path).length;
		calls.push({ method, path, body });
		const route = routes[`${method} ${path}`];
		return route ? route(body, count) : json({ error: { code: 'NOT_FOUND' } }, 404);
	});
	await render(SocialActions, {
		app,
		curve,
		name: 'Editor',
		locale: 'pt-BR',
		pageUrl: new URL('https://example.test/'),
		api: curvaSocialApi(fetcher),
		session: createSocialSession({
			initial: { id: 'u-ana', username: 'Ana', emailVerified: true }
		}),
		clipboard: vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
	});
	const posts = (path: string) =>
		calls.filter((call) => call.method === 'POST' && call.path === path);
	return { app, posts };
}

const dialog = () => page.getByRole('dialog');
const confirm = () => dialog().getByRole('button', { name: m.cvedit_save_confirm(), exact: true });

function nativeDialog(): HTMLDialogElement {
	const element = document.querySelector('dialog');
	if (!(element instanceof HTMLDialogElement)) throw new Error('Missing save dialog');
	return element;
}

async function saveOnce() {
	await page.getByRole('button', { name: m.curva_social_save(), exact: true }).click();
	await expect.poll(() => nativeDialog().open).toBe(true);
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
}

test('a labels-only change appends a version; the same labels again append nothing', async () => {
	const { app, posts } = await setup({
		'POST /api/v1/curves': () => json({ lineageId: 'mine', versionId: 'v1', curveId: 'h' }, 201),
		'GET /api/v1/lineages/mine': (_body, count) => lineage('mine', `v${count + 1}`),
		'POST /api/v1/lineages/mine/versions': (_body, count) =>
			json({ lineageId: 'mine', versionId: `v${count + 2}`, curveId: 'h' }, 201)
	});
	const versions = () => posts('/api/v1/lineages/mine/versions');

	// First save: no labels, a plain @1 private copy.
	await saveOnce();
	expect(posts('/api/v1/curves')).toHaveLength(1);
	const first = posts('/api/v1/curves')[0]?.body;
	expect(first).toMatchObject({ envelope: { format: 'open-auri/preset@1', code: s1 } });
	expect(JSON.stringify(first)).not.toContain('"labels"');

	// Same curve, same name and description, only a filter renamed: a new version with labels.
	expect(app.state.curve.setLabels(ten(['Grave quente']))).toBe(true);
	await saveOnce();
	await expect
		.element(page.getByRole('status').first())
		.toMatchTextContent(m.cvedit_save_updated());
	expect(versions()).toHaveLength(1);
	expect(versions()[0]?.body).toMatchObject({
		parentVersionId: 'v1',
		envelope: {
			format: 'open-auri/preset@2',
			code: s1,
			name: 'Editor',
			labels: ten(['Grave quente'])
		}
	});

	// Saving again with the very same labels and text appends nothing.
	await saveOnce();
	await expect
		.element(page.getByRole('status').first())
		.toMatchTextContent(m.cvedit_save_unchanged());
	expect(versions()).toHaveLength(1);

	// Another label change is another version, parented on the last one.
	expect(app.state.curve.setLabels(ten(['Grave quente', null, 'Ar']))).toBe(true);
	await saveOnce();
	await expect.poll(() => versions().length).toBe(2);
	expect(versions()[1]?.body).toMatchObject({
		parentVersionId: 'v2',
		envelope: { labels: ten(['Grave quente', null, 'Ar']) }
	});

	// Clearing every label is a change too: back to @1, without labels.
	expect(app.state.curve.setLabels(ten([]))).toBe(true);
	await saveOnce();
	await expect.poll(() => versions().length).toBe(3);
	const cleared = versions()[2]?.body;
	expect(cleared).toMatchObject({
		parentVersionId: 'v3',
		envelope: { format: 'open-auri/preset@1', code: s1 }
	});
	expect(JSON.stringify(cleared)).not.toContain('"labels"');
	expect(posts('/api/v1/curves')).toHaveLength(1);
});
