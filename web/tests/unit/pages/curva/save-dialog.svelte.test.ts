// "Salvar" on the Curva page asks for the name and description of the private copy, and saving
// the same curve again appends a version to that copy instead of creating a duplicate lineage,
// but only after a fresh read shows the copy is still private and active.
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createSocialSession, ORIGINS_KEY, originOf, type SocialFetch } from '#lib/social/index.ts';
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
/** `count`: how many earlier calls the same route already answered. */
type Route = (body: unknown, count: number) => Response;

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
	const session = createSocialSession({
		initial: { id: 'u-ana', username: 'Ana', emailVerified: true }
	});
	const screen = await render(SocialActions, {
		app,
		curve,
		name: 'Editor',
		locale: 'pt-BR',
		pageUrl: new URL('https://example.test/'),
		api: curvaSocialApi(fetcher),
		session,
		clipboard: vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
	});
	const posts = (path: string) =>
		calls.filter((call) => call.method === 'POST' && call.path === path);
	const reads = (path: string) =>
		calls.filter((call) => call.method === 'GET' && call.path === path);
	return { app, calls, posts, reads, screen, session };
}

const dialog = () => page.getByRole('dialog');
const nameBox = () => dialog().getByRole('textbox', { name: m.curva_social_name() });
const descriptionBox = () => dialog().getByRole('textbox', { name: m.curva_social_description() });
const confirm = () => dialog().getByRole('button', { name: m.cvedit_save_confirm(), exact: true });

function nativeDialog(): HTMLDialogElement {
	const element = document.querySelector('dialog');
	if (!(element instanceof HTMLDialogElement)) throw new Error('Missing save dialog');
	return element;
}

async function openSave() {
	await page.getByRole('button', { name: m.curva_social_save(), exact: true }).click();
	await expect.poll(() => nativeDialog().open).toBe(true);
}

const created = (lineageId: string, versionId: string) => () =>
	json({ lineageId, versionId, curveId: 'hash' }, 201);

interface LineageFixture {
	visibility?: 'public' | 'unlisted' | 'private';
	status?: string;
	head?: string;
}
/** `GET /api/v1/lineages/[id]` as its owner reads it (private and active unless told otherwise). */
const lineage =
	(id: string, { visibility = 'private', status = 'active', head = 'v1' }: LineageFixture = {}) =>
	() =>
		json({
			lineage: {
				id,
				visibility,
				status,
				moderation: 'visible',
				curated: false,
				forkedFromVersion: null,
				headVersion: head,
				createdAt: 1,
				updatedAt: 2,
				isOwner: true
			},
			author: null,
			versions: [],
			nextCursor: null
		});

test('Salvar opens a private save dialog prefilled with the editor name; Esc cancels without a request', async () => {
	const { calls } = await setup({ 'POST /api/v1/curves': created('mine', 'v1') });
	await openSave();
	await expect
		.element(dialog().getByRole('heading', { name: m.curva_social_save() }))
		.toBeVisible();
	await expect.element(nameBox()).toHaveValue('Editor');
	await expect.element(nameBox()).toHaveFocus();
	await expect.element(descriptionBox()).toHaveValue('');
	await expect.element(descriptionBox()).toHaveAccessibleDescription(m.cvedit_description_hint());
	await expect.element(dialog()).toMatchTextContent(m.cvedit_save_private());
	// Visibility is fixed to private: no license or visibility pickers in this dialog.
	expect(dialog().getByRole('combobox').elements()).toHaveLength(0);
	await userEvent.keyboard('{Escape}');
	await expect.poll(() => nativeDialog().open).toBe(false);
	expect(calls).toEqual([]);
});

test('the save sends the chosen name and description, privately, and remembers no public origin', async () => {
	const { posts } = await setup({ 'POST /api/v1/curves': created('mine', 'v1') });
	await openSave();
	await nameBox().fill('Grave quente');
	await descriptionBox().fill('Para fones fechados.\nMenos brilho.');
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
	await expect.element(page.getByRole('status').first()).toMatchTextContent(m.curva_social_saved());
	expect(posts('/api/v1/curves')).toHaveLength(1);
	expect(posts('/api/v1/curves')[0]?.body).toMatchObject({
		visibility: 'private',
		envelope: {
			name: 'Grave quente',
			description: 'Para fones fechados.\nMenos brilho.',
			code: s1,
			license: 'CC0-1.0',
			lang: 'pt-BR'
		}
	});
	expect(await originOf(s1)).toBeNull();
});

test('saving the same curve again appends versions to the saved lineage with the right parent', async () => {
	const { posts, reads, screen } = await setup({
		'POST /api/v1/curves': (_body, count) => created(`mine-${count}`, `v1-${count}`)(),
		'GET /api/v1/lineages/mine-0': lineage('mine-0', { head: 'v1-0' }),
		'POST /api/v1/lineages/mine-0/versions': (_body, count) =>
			json({ lineageId: 'mine-0', versionId: `v${count + 2}`, curveId: 'hash' }, 201)
	});
	await openSave();
	await nameBox().fill('Primeiro nome');
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);

	// Reopening prefills the saved text and says a new version will be created.
	await openSave();
	await expect.element(nameBox()).toHaveValue('Primeiro nome');
	await expect.element(dialog()).toMatchTextContent(m.cvedit_save_version_page());
	await descriptionBox().fill('Agora com descrição.');
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
	await expect
		.element(page.getByRole('status').first())
		.toMatchTextContent(m.cvedit_save_updated());
	const versions = () => posts('/api/v1/lineages/mine-0/versions');
	expect(versions()).toHaveLength(1);
	expect(versions()[0]?.body).toMatchObject({
		parentVersionId: 'v1-0',
		envelope: { name: 'Primeiro nome', description: 'Agora com descrição.', code: s1 }
	});
	// The visibility was read right before that append, not trusted from memory.
	expect(reads('/api/v1/lineages/mine-0')).toHaveLength(1);

	// The new version is the next parent.
	await openSave();
	await expect.element(descriptionBox()).toHaveValue('Agora com descrição.');
	await nameBox().fill('Segundo nome');
	await confirm().click();
	await expect.poll(() => versions().length).toBe(2);
	await expect.poll(() => nativeDialog().open).toBe(false);
	expect(versions()[1]?.body).toMatchObject({
		parentVersionId: 'v2',
		envelope: { name: 'Segundo nome', description: 'Agora com descrição.' }
	});

	// Unchanged text appends nothing.
	await openSave();
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
	await expect
		.element(page.getByRole('status').first())
		.toMatchTextContent(m.cvedit_save_unchanged());
	expect(versions()).toHaveLength(2);
	expect(posts('/api/v1/curves')).toHaveLength(1);

	// Another curve is another lineage.
	await screen.rerender({ curve: { ...curve, preampDb: -1 } });
	await openSave();
	await expect.element(dialog()).not.toMatchTextContent(m.cvedit_save_version_page());
	await confirm().click();
	await expect.poll(() => posts('/api/v1/curves').length).toBe(2);
	expect(versions()).toHaveLength(2);
});

test('too long and linked text is explained per field and nothing is sent', async () => {
	const { calls } = await setup({ 'POST /api/v1/curves': created('mine', 'v1') });
	await openSave();
	// 48 typed characters that the S5 normalization (NFKC) turns into 96.
	await nameBox().fill('\u{FB00}'.repeat(48));
	await descriptionBox().fill('Ouça em https://exemplo.com');
	await confirm().click();
	await expect.element(dialog().getByRole('status')).toHaveTextContent(m.cvedit_invalid());
	await expect.element(nameBox()).toHaveAttribute('aria-invalid', 'true');
	await expect.element(nameBox()).toHaveAccessibleDescription(m.cvedit_name_length());
	await expect.element(nameBox()).toHaveFocus();
	await expect.element(descriptionBox()).toHaveAttribute('aria-invalid', 'true');
	await expect.element(descriptionBox()).toHaveAccessibleDescription(m.comunidade_env_url());
	expect(nativeDialog().open).toBe(true);

	await nameBox().fill('Curva válida');
	await descriptionBox().fill('um\ndois\ntrês\nquatro\ncinco\nseis');
	await confirm().click();
	await expect.element(descriptionBox()).toHaveAccessibleDescription(m.cvedit_description_length());
	await expect.element(descriptionBox()).toHaveFocus();
	await expect.element(nameBox()).not.toHaveAttribute('aria-invalid');
	expect(calls).toEqual([]);
});

test('after an account switch, Salvar creates a new lineage and never appends to the other account copy', async () => {
	const { calls, posts, session } = await setup({
		'POST /api/v1/curves': (_body, count) => created(`mine-${count}`, 'v1')(),
		'GET /api/v1/lineages/mine-0': lineage('mine-0'),
		'POST /api/v1/lineages/mine-0/versions': () =>
			json({ lineageId: 'mine-0', versionId: 'v2', curveId: 'hash' }, 201)
	});
	await openSave();
	await nameBox().fill('Da Ana');
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);

	session.set({ id: 'u-bia', username: 'Bia', emailVerified: true });
	await openSave();
	// Ana's copy is neither offered nor prefilled to Bia.
	await expect.element(dialog()).not.toMatchTextContent(m.cvedit_save_version_page());
	await expect.element(nameBox()).toHaveValue('Editor');
	await nameBox().fill('Da Bia');
	await confirm().click();
	await expect.poll(() => posts('/api/v1/curves').length).toBe(2);
	await expect.poll(() => nativeDialog().open).toBe(false);
	expect(posts('/api/v1/curves')[1]?.body).toMatchObject({
		visibility: 'private',
		envelope: { name: 'Da Bia', code: s1 }
	});
	expect(calls.filter((call) => call.path.startsWith('/api/v1/lineages/'))).toEqual([]);
});

test.each(['public', 'unlisted'] as const)(
	'a saved copy made %s elsewhere gets no new version: Salvar creates a new private lineage and says so',
	async (visibility) => {
		const { posts, reads } = await setup({
			'POST /api/v1/curves': (_body, count) => created(`mine-${count}`, `v1-${count}`)(),
			'GET /api/v1/lineages/mine-0': lineage('mine-0', { visibility, head: 'v1-0' }),
			'GET /api/v1/lineages/mine-1': lineage('mine-1', { head: 'v1-1' }),
			'POST /api/v1/lineages/mine-0/versions': () =>
				json({ lineageId: 'mine-0', versionId: 'v2', curveId: 'hash' }, 201),
			'POST /api/v1/lineages/mine-1/versions': () =>
				json({ lineageId: 'mine-1', versionId: 'v2', curveId: 'hash' }, 201)
		});
		await openSave();
		await nameBox().fill('Privada');
		await confirm().click();
		await expect.poll(() => nativeDialog().open).toBe(false);

		// This page still remembers the copy, so the dialog offers a new version of it...
		await openSave();
		await expect.element(dialog()).toMatchTextContent(m.cvedit_save_version_page());
		await descriptionBox().fill('Texto que só eu vejo.');
		await confirm().click();
		await expect.poll(() => nativeDialog().open).toBe(false);
		// ...but the read right before the append finds it is no longer private.
		await expect
			.element(page.getByRole('status').first())
			.toMatchTextContent(m.cvedit_save_not_private());
		expect(reads('/api/v1/lineages/mine-0')).toHaveLength(1);
		expect(posts('/api/v1/lineages/mine-0/versions')).toEqual([]);
		expect(posts('/api/v1/curves')).toHaveLength(2);
		expect(posts('/api/v1/curves')[1]?.body).toMatchObject({
			visibility: 'private',
			envelope: { name: 'Privada', description: 'Texto que só eu vejo.', code: s1 }
		});

		// The new private lineage is the copy the next "Salvar" updates.
		await openSave();
		await expect.element(descriptionBox()).toHaveValue('Texto que só eu vejo.');
		await nameBox().fill('Privada de novo');
		await confirm().click();
		await expect.poll(() => posts('/api/v1/lineages/mine-1/versions').length).toBe(1);
		await expect.poll(() => nativeDialog().open).toBe(false);
		expect(posts('/api/v1/lineages/mine-1/versions')[0]?.body).toMatchObject({
			parentVersionId: 'v1-1',
			envelope: { name: 'Privada de novo' }
		});
		expect(posts('/api/v1/lineages/mine-0/versions')).toEqual([]);
		expect(posts('/api/v1/curves')).toHaveLength(2);
	}
);

test('HEAD_MOVED on a re-save explains, reloads the head and the next save uses it', async () => {
	const { posts, calls } = await setup({
		'POST /api/v1/curves': created('mine', 'v1'),
		'POST /api/v1/lineages/mine/versions': (_body, count) =>
			count === 0
				? json({ error: { code: 'HEAD_MOVED' } }, 409)
				: json({ lineageId: 'mine', versionId: 'v10', curveId: 'hash' }, 201),
		'GET /api/v1/lineages/mine': () =>
			json({
				lineage: {
					id: 'mine',
					visibility: 'private',
					status: 'active',
					moderation: 'visible',
					curated: false,
					forkedFromVersion: null,
					headVersion: 'v9',
					createdAt: 1,
					updatedAt: 2,
					isOwner: true
				},
				author: null,
				versions: [
					{
						id: 'v9',
						parentId: 'v1',
						curveId: 'hash',
						name: 'Nome de outra aba',
						description: '',
						license: 'CC0-1.0',
						lang: 'pt-BR',
						labels: null,
						createdAt: 2,
						isHead: true
					}
				],
				nextCursor: null
			})
	});
	await openSave();
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
	await openSave();
	await nameBox().fill('Nome novo');
	await confirm().click();
	await expect.element(dialog().getByRole('status')).toHaveTextContent(m.cvedit_head_moved());
	expect(nativeDialog().open).toBe(true);
	await expect.element(nameBox()).toHaveValue('Nome novo');
	expect(calls.some((call) => call.method === 'GET' && call.path === '/api/v1/lineages/mine')).toBe(
		true
	);
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
	const versions = posts('/api/v1/lineages/mine/versions');
	expect(versions.map((call) => call.body)).toMatchObject([
		{ parentVersionId: 'v1' },
		{ parentVersionId: 'v9', envelope: { name: 'Nome novo' } }
	]);
	expect(posts('/api/v1/curves')).toHaveLength(1);
});

test('a HEAD_MOVED reload that finds the copy no longer private forgets it instead of reloading it', async () => {
	const { posts } = await setup({
		'POST /api/v1/curves': (_body, count) => created(`mine-${count}`, 'v1')(),
		// Private at the read before the append, public by the time the head is reloaded.
		'GET /api/v1/lineages/mine-0': (_body, count) =>
			lineage('mine-0', { visibility: count === 0 ? 'private' : 'public', head: 'v9' })(),
		'POST /api/v1/lineages/mine-0/versions': () => json({ error: { code: 'HEAD_MOVED' } }, 409)
	});
	await openSave();
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
	await openSave();
	await nameBox().fill('Nome novo');
	await confirm().click();
	await expect
		.element(dialog().getByRole('status'))
		.toHaveTextContent(m.cvedit_save_not_private_retry());
	expect(nativeDialog().open).toBe(true);
	await expect.element(dialog()).not.toMatchTextContent(m.cvedit_save_version_page());
	await confirm().click();
	await expect.poll(() => posts('/api/v1/curves').length).toBe(2);
	await expect.poll(() => nativeDialog().open).toBe(false);
	expect(posts('/api/v1/curves')[1]?.body).toMatchObject({
		visibility: 'private',
		envelope: { name: 'Nome novo' }
	});
	expect(posts('/api/v1/lineages/mine-0/versions')).toHaveLength(1);
});

test('gate rejection and account limits keep the dialog, its text and the saved copy', async () => {
	const { posts } = await setup({
		'POST /api/v1/curves': (_body, count) =>
			count === 0
				? json({ error: { code: 'GATE_REJECTED', details: { reasons: ['e:output-full'] } } }, 422)
				: created('mine', 'v1')(),
		'GET /api/v1/lineages/mine': lineage('mine'),
		'POST /api/v1/lineages/mine/versions': (_body, count) =>
			count === 0
				? json({ error: { code: 'RATE_LIMITED' } }, 429)
				: json({ lineageId: 'mine', versionId: 'v2', curveId: 'hash' }, 201)
	});
	await openSave();
	await nameBox().fill('Rejeitada');
	await confirm().click();
	await expect.element(dialog()).toMatchTextContent(m.curva_social_gate());
	await expect.element(dialog()).toMatchTextContent(m.curva_why_output_full());
	expect(nativeDialog().open).toBe(true);
	await expect.element(nameBox()).toHaveValue('Rejeitada');
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);

	await openSave();
	await descriptionBox().fill('Mais tarde.');
	await confirm().click();
	await expect.element(dialog().getByRole('status')).toHaveTextContent(m.curva_social_limit());
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
	expect(posts('/api/v1/lineages/mine/versions').map((call) => call.body)).toMatchObject([
		{ parentVersionId: 'v1' },
		{ parentVersionId: 'v1' }
	]);
	expect(posts('/api/v1/curves')).toHaveLength(2);
});

test('a retracted saved copy is forgotten: the next save creates a new private lineage', async () => {
	const { posts } = await setup({
		'POST /api/v1/curves': (_body, count) => created(`mine-${count}`, 'v1')(),
		'GET /api/v1/lineages/mine-0': lineage('mine-0'),
		'POST /api/v1/lineages/mine-0/versions': () => json({ error: { code: 'CONFLICT' } }, 409)
	});
	await openSave();
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
	await openSave();
	await nameBox().fill('Depois de retirada');
	await confirm().click();
	await expect.element(dialog().getByRole('status')).toHaveTextContent(m.cvedit_save_gone());
	await expect.element(dialog()).not.toMatchTextContent(m.cvedit_save_version_page());
	await confirm().click();
	await expect.poll(() => posts('/api/v1/curves').length).toBe(2);
	expect(posts('/api/v1/curves')[1]?.body).toMatchObject({
		visibility: 'private',
		envelope: { name: 'Depois de retirada' }
	});
});

test('a 200 answer cannot claim a new version', async () => {
	const { screen } = await setup({
		'POST /api/v1/curves': created('mine', 'v1'),
		'GET /api/v1/lineages/mine': lineage('mine'),
		'POST /api/v1/lineages/mine/versions': () =>
			json({ lineageId: 'mine', versionId: 'v2', curveId: 'hash' }, 200)
	});
	await openSave();
	await confirm().click();
	await expect.poll(() => nativeDialog().open).toBe(false);
	await openSave();
	await nameBox().fill('Outro nome');
	await confirm().click();
	await vi.waitFor(() => expect(screen.container.textContent).toContain(m.curva_social_offline()));
	expect(screen.container.textContent).not.toContain(m.cvedit_save_updated());
});
