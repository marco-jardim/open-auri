// "Editar nome e descrição" of an own creation in Minha biblioteca: a new version with the head's
// exact curve and the new text, through the versions endpoint with the head as its parent.
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import {
	createSocialApi,
	createSocialSession,
	type LibraryItem,
	type rememberOrigin
} from '#lib/social/index.ts';
import MinhaBiblioteca from '#lib/components/pages/biblioteca/MinhaBiblioteca.svelte';
import type { KeyValueStorage } from '#lib/components/pages/biblioteca/social.ts';
import { m } from '#lib/paraglide/messages.js';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

const curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const s1 = encodeS1(curve);
const recipe = { solver: { name: 'autoeq', version: '1.0.0' }, params: { target: 'harman' } };

function item(id: string, name: string, over: Partial<LibraryItem> = {}): LibraryItem {
	return {
		id,
		own: true,
		visibility: 'private',
		status: 'active',
		moderation: 'visible',
		curated: false,
		forkedFromVersion: null,
		createdAt: 1,
		updatedAt: 1,
		author: { username: 'ana', displayUsername: 'Ana' },
		head: {
			id: `${id}v`,
			parentId: null,
			name,
			description: '',
			license: 'CC-BY-4.0',
			lang: 'pt-BR',
			recipe: null,
			labels: null,
			createdAt: 1
		},
		curve: { id: `${id}c`, s1, levelDb: null, gateOk: true },
		at: 1,
		...over
	};
}

function mine(over: Partial<LibraryItem['head']> = {}): LibraryItem {
	const base = item('lin1', 'Grave quente');
	return {
		...base,
		head: { ...base.head, description: 'Antiga', recipe: JSON.stringify(recipe), ...over }
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

interface Call {
	method: string;
	path: string;
	shelf: string | null;
	body: unknown;
}
/** `count`: how many earlier calls the same route already answered. */
type Route = (url: URL, body: unknown, count: number) => Response | Promise<Response>;

function server(created: () => LibraryItem[], routes: Record<string, Route> = {}) {
	const calls: Call[] = [];
	const all: Record<string, Route> = {
		'GET /api/v1/me/library': (url) => {
			const shelf = url.searchParams.get('shelf');
			return json({ shelf, items: shelf === 'created' ? created() : [], nextCursor: null });
		},
		'GET /api/v1/me/packs': () => json({ items: [], nextCursor: null }),
		...routes
	};
	const fetch = async (input: string, init: RequestInit) => {
		const url = new URL(input, 'https://example.test');
		const method = init.method ?? 'GET';
		const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		const key = `${method} ${url.pathname}`;
		const count = calls.filter((call) => `${call.method} ${call.path}` === key).length;
		calls.push({ method, path: url.pathname, shelf: url.searchParams.get('shelf'), body });
		const route = all[key];
		return route ? route(url, body, count) : json({ error: { code: 'NOT_FOUND' } }, 404);
	};
	const versions = (lineageId: string) =>
		calls.filter(
			(call) => call.method === 'POST' && call.path === `/api/v1/lineages/${lineageId}/versions`
		);
	return { calls, versions, api: createSocialApi({ fetch, online: () => true }) };
}

function memoryStorage(): KeyValueStorage {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		}
	};
}

async function setup(api: ReturnType<typeof createSocialApi>) {
	const remember = vi.fn<typeof rememberOrigin>(async () => {});
	const session = createSocialSession({
		initial: { id: 'u-ana', username: 'Ana', emailVerified: true }
	});
	const screen = await render(MinhaBiblioteca, {
		session,
		api,
		origin: 'https://example.test',
		locale: 'pt-BR',
		storage: memoryStorage(),
		remember
	});
	return { remember, screen, session };
}

const editButton = (name: string) =>
	page.getByRole('button', { name: m.cvedit_edit_label({ name }) });
const form = (name: string) => page.getByRole('form', { name: m.cvedit_edit_title({ name }) });
const nameBox = (name: string) => form(name).getByRole('textbox', { name: m.curva_social_name() });
const descriptionBox = (name: string) =>
	form(name).getByRole('textbox', { name: m.curva_social_description() });
const saveButton = (name: string) =>
	form(name).getByRole('button', { name: m.cvedit_save_confirm(), exact: true });

test('the edit form is prefilled from the head and focused; Esc cancels; unchanged text sends nothing', async () => {
	const { api, calls } = server(() => [mine()]);
	await setup(api);
	await expect.element(page.getByText('Grave quente', { exact: true })).toBeVisible();
	await expect.element(editButton('Grave quente')).toHaveAttribute('aria-expanded', 'false');
	await editButton('Grave quente').click();
	await expect.element(editButton('Grave quente')).toHaveAttribute('aria-expanded', 'true');
	await expect.element(nameBox('Grave quente')).toHaveValue('Grave quente');
	await expect.element(nameBox('Grave quente')).toHaveFocus();
	await expect.element(descriptionBox('Grave quente')).toHaveValue('Antiga');
	await expect
		.element(descriptionBox('Grave quente'))
		.toHaveAccessibleDescription(m.cvedit_description_hint());
	await expect.element(form('Grave quente')).toMatchTextContent(m.cvedit_edit_version());
	await expect
		.element(form('Grave quente').getByText(m.biblioteca_edit_gate_refused_hint()))
		.not.toBeInTheDocument();
	await userEvent.keyboard('{Escape}');
	await expect.element(form('Grave quente')).not.toBeInTheDocument();
	await expect.element(editButton('Grave quente')).toHaveFocus();

	await editButton('Grave quente').click();
	await saveButton('Grave quente').click();
	await expect.element(page.getByText(m.cvedit_edit_unchanged())).toBeVisible();
	await expect.element(form('Grave quente')).not.toBeInTheDocument();
	expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
});

test('saving appends a version with the head curve and the new text; the row shows the new name', async () => {
	const { api, versions } = server(() => [mine()], {
		'POST /api/v1/lineages/lin1/versions': (_url, _body, count) =>
			json({ lineageId: 'lin1', versionId: `lin1v${count + 2}`, curveId: 'lin1c' }, 201)
	});
	const { remember } = await setup(api);
	await editButton('Grave quente').click();
	await nameBox('Grave quente').fill('Grave mais quente');
	await descriptionBox('Grave quente').fill('Para fones fechados.\nMenos brilho.');
	await saveButton('Grave quente').click();
	await expect.element(page.getByText('Grave mais quente', { exact: true })).toBeVisible();
	await expect
		.element(page.getByText(m.cvedit_edit_done({ name: 'Grave mais quente' })))
		.toBeVisible();
	await expect.element(page.getByText('Para fones fechados.', { exact: false })).toBeVisible();
	await expect
		.element(page.getByText('Para fones fechados.', { exact: false }))
		.toHaveStyle({ whiteSpace: 'pre-line' });
	expect(versions('lin1')).toHaveLength(1);
	expect(versions('lin1')[0]?.body).toEqual({
		parentVersionId: 'lin1v',
		envelope: {
			format: 'open-auri/preset@1',
			name: 'Grave mais quente',
			description: 'Para fones fechados.\nMenos brilho.',
			license: 'CC-BY-4.0',
			source: 'custom',
			code: s1,
			preampDb: NEUTRO.preampDb,
			bands: NEUTRO.bands,
			lang: 'pt-BR',
			createdAt: expect.any(String),
			recipe
		}
	});
	expect(remember).toHaveBeenCalledWith({ s1, lineageId: 'lin1', versionId: 'lin1v2' });

	// The new version is the next parent.
	await expect.element(editButton('Grave mais quente')).toHaveFocus();
	await editButton('Grave mais quente').click();
	await nameBox('Grave mais quente').fill('Grave suave');
	await saveButton('Grave mais quente').click();
	await expect.element(page.getByText('Grave suave', { exact: true })).toBeVisible();
	expect(versions('lin1')[1]?.body).toMatchObject({
		parentVersionId: 'lin1v2',
		envelope: { name: 'Grave suave', description: 'Para fones fechados.\nMenos brilho.' }
	});
});

test('too long and linked text is explained per field and nothing is sent', async () => {
	const { api, calls } = server(() => [mine()]);
	await setup(api);
	await editButton('Grave quente').click();
	// 48 typed characters that the S5 normalization (NFKC) turns into 96.
	await nameBox('Grave quente').fill('\u{FB00}'.repeat(48));
	await descriptionBox('Grave quente').fill('Ouça em https://exemplo.com');
	await saveButton('Grave quente').click();
	await expect
		.element(form('Grave quente').getByRole('status'))
		.toHaveTextContent(m.cvedit_invalid());
	await expect.element(nameBox('Grave quente')).toHaveAttribute('aria-invalid', 'true');
	await expect.element(nameBox('Grave quente')).toHaveAccessibleDescription(m.cvedit_name_length());
	await expect.element(nameBox('Grave quente')).toHaveFocus();
	await expect
		.element(descriptionBox('Grave quente'))
		.toHaveAccessibleDescription(m.comunidade_env_url());

	await nameBox('Grave quente').fill('Grave quente 2');
	await descriptionBox('Grave quente').fill('um\ndois\ntrês\nquatro\ncinco\nseis');
	await saveButton('Grave quente').click();
	await expect
		.element(descriptionBox('Grave quente'))
		.toHaveAccessibleDescription(m.cvedit_description_length());
	await expect.element(descriptionBox('Grave quente')).toHaveFocus();
	await expect.element(nameBox('Grave quente')).not.toHaveAttribute('aria-invalid');
	expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
	await expect.element(page.getByText('Grave quente', { exact: true })).toBeVisible();
});

test('HEAD_MOVED explains, reloads the rows and the next save uses the current head', async () => {
	let moved = false;
	const { api, calls, versions } = server(
		() => [moved ? mine({ id: 'lin1v9', name: 'Grave de outra aba' }) : mine()],
		{
			'POST /api/v1/lineages/lin1/versions': (_url, _body, count) => {
				if (count > 0) return json({ lineageId: 'lin1', versionId: 'lin1v10', curveId: 'c' }, 201);
				moved = true;
				return json({ error: { code: 'HEAD_MOVED' } }, 409);
			}
		}
	);
	await setup(api);
	await editButton('Grave quente').click();
	await nameBox('Grave quente').fill('Meu nome');
	const createdLoads = () =>
		calls.filter(
			(call) =>
				call.method === 'GET' && call.path === '/api/v1/me/library' && call.shelf === 'created'
		).length;
	const beforeSave = createdLoads();
	await saveButton('Grave quente').click();
	// The rows reload with the current head: the open form now carries its name in its title,
	// and keeps both the explanation and the typed text.
	await expect.element(page.getByText('Grave de outra aba', { exact: true })).toBeVisible();
	await expect
		.element(form('Grave de outra aba').getByRole('status'))
		.toMatchTextContent(m.cvedit_head_moved_reload());
	expect(createdLoads()).toBe(beforeSave + 1);
	await expect.element(nameBox('Grave de outra aba')).toHaveValue('Meu nome');
	await saveButton('Grave de outra aba').click();
	await expect.element(page.getByText('Meu nome', { exact: true })).toBeVisible();
	expect(versions('lin1').map((call) => call.body)).toMatchObject([
		{ parentVersionId: 'lin1v' },
		{ parentVersionId: 'lin1v9', envelope: { name: 'Meu nome' } }
	]);
});

test('gate rejection and rate limits show the existing messages and keep the form', async () => {
	const { api, versions } = server(() => [mine()], {
		'POST /api/v1/lineages/lin1/versions': (_url, _body, count) =>
			count === 0
				? json({ error: { code: 'GATE_REJECTED', details: { reasons: ['e:output-full'] } } }, 422)
				: json({ error: { code: 'RATE_LIMITED' } }, 429)
	});
	await setup(api);
	await editButton('Grave quente').click();
	await nameBox('Grave quente').fill('Outro nome');
	await saveButton('Grave quente').click();
	const status = form('Grave quente').getByRole('status');
	await expect.element(status).toMatchTextContent(m.biblioteca_social_error_gate());
	await expect.element(status).toMatchTextContent(m.curva_why_output_full());
	await expect.element(nameBox('Grave quente')).toHaveValue('Outro nome');
	await saveButton('Grave quente').click();
	await expect.element(status).toMatchTextContent(m.biblioteca_social_error_rate());
	await expect.element(status).not.toMatchTextContent(m.curva_why_output_full());
	await expect.element(page.getByText('Grave quente', { exact: true })).toBeVisible();
	expect(page.getByText('Outro nome', { exact: true }).query()).toBeNull();
	expect(versions('lin1')).toHaveLength(2);
});

for (const code of ['CONFLICT', 'NOT_FOUND'] as const) {
	test(`${code} closes the editor, keeps the page notice and focuses the refreshed row or shelf heading`, async () => {
		let failed = false;
		const refreshed = deferred<Response>();
		const { api, versions } = server(() => [mine()], {
			'GET /api/v1/me/library': (url) => {
				const shelf = url.searchParams.get('shelf');
				if (shelf === 'created' && failed) return refreshed.promise;
				return json({ shelf, items: shelf === 'created' ? [mine()] : [], nextCursor: null });
			},
			'POST /api/v1/lineages/lin1/versions': () => {
				failed = true;
				return json({ error: { code } }, code === 'CONFLICT' ? 409 : 404);
			}
		});
		const { screen } = await setup(api);
		await editButton('Grave quente').click();
		await nameBox('Grave quente').fill('Outro nome');
		await saveButton('Grave quente').click();
		const message =
			code === 'CONFLICT' ? m.cvedit_edit_unavailable() : m.biblioteca_social_error_missing();
		const notice = screen.container.querySelector<HTMLElement>('.notice');
		await expect.element(notice).toHaveTextContent(message);
		await expect.element(form('Grave quente')).not.toBeInTheDocument();
		// The row remains mounted during the reload, even though the editor has already closed.
		await expect.element(screen.container.querySelector<HTMLElement>('.rows .row')).toHaveFocus();
		refreshed.resolve(
			json({
				shelf: 'created',
				items: code === 'CONFLICT' ? [{ ...mine(), status: 'retracted' }] : [],
				nextCursor: null
			})
		);
		if (code === 'CONFLICT') {
			await expect
				.element(page.getByText(m.biblioteca_social_retracted(), { exact: true }))
				.toBeVisible();
			await expect.element(screen.container.querySelector<HTMLElement>('.rows .row')).toHaveFocus();
		} else {
			await expect.element(page.getByText(m.biblioteca_social_empty_created())).toBeVisible();
			await expect
				.element(page.getByRole('heading', { name: m.biblioteca_social_shelf_created(), level: 3 }))
				.toHaveFocus();
		}
		await expect.element(notice).toHaveTextContent(message);
		expect(editButton('Grave quente').query()).toBeNull();
		expect(versions('lin1')).toHaveLength(1);
	});
}

for (const outcome of ['success', 'conflict', 'missing'] as const) {
	test(`a late version ${outcome} after an account switch cannot change the new account's rows, origins or notice`, async () => {
		let switched = false;
		const pending = deferred<Response>();
		const { api, versions } = server(() => [mine()], {
			'GET /api/v1/me/library': (url) => {
				const shelf = url.searchParams.get('shelf');
				const items =
					shelf === 'created'
						? [switched ? item('lin2', 'Curva do Bruno') : mine()]
						: shelf === 'favorites' && switched
							? [{ ...mine(), own: false }]
							: [];
				return json({ shelf, items, nextCursor: null });
			},
			'POST /api/v1/lineages/lin1/versions': () => pending.promise
		});
		const append = vi.spyOn(api, 'appendVersion');
		const { remember, screen, session } = await setup(api);
		await editButton('Grave quente').click();
		await nameBox('Grave quente').fill('Nome da Ana');
		await saveButton('Grave quente').click();
		await expect
			.element(form('Grave quente').getByRole('button', { name: m.cvedit_saving() }))
			.toBeDisabled();
		expect(versions('lin1')).toHaveLength(1);
		expect(append).toHaveBeenCalledTimes(1);

		switched = true;
		session.set({ id: 'u-bruno', username: 'Bruno', emailVerified: true });
		await expect.element(page.getByText('Curva do Bruno', { exact: true })).toBeVisible();
		await page
			.getByRole('tab', { name: new RegExp(`^${m.biblioteca_social_shelf_favorites()}`) })
			.click();
		await expect.element(page.getByText('Grave quente', { exact: true })).toBeVisible();
		remember.mockClear();
		pending.resolve(
			outcome === 'success'
				? json({ lineageId: 'lin1', versionId: 'lin1v2', curveId: 'lin1c' }, 201)
				: json(
						{ error: { code: outcome === 'conflict' ? 'CONFLICT' : 'NOT_FOUND' } },
						outcome === 'conflict' ? 409 : 404
					)
		);
		// Drain the response parsing and Svelte updates before making negative assertions.
		await Promise.allSettled([append.mock.results[0]?.value]);
		await tick();
		await expect.element(page.getByText('Grave quente', { exact: true })).toBeVisible();
		expect(page.getByText('Nome da Ana', { exact: true }).query()).toBeNull();
		expect(remember).not.toHaveBeenCalled();
		expect(screen.container.querySelector('.notice')?.textContent).toBe('');
	});
}

test('a gate-refused curve still offers editing but warns before another gate attempt', async () => {
	const base = mine();
	const { api, versions } = server(() => [{ ...base, curve: { ...base.curve, gateOk: false } }]);
	await setup(api);
	await editButton('Grave quente').click();
	await expect
		.element(form('Grave quente').getByText(m.biblioteca_edit_gate_refused_hint()))
		.toBeVisible();
	expect(versions('lin1')).toHaveLength(0);
});

test('retracted, moderated and other authors’ rows are never offered the edit', async () => {
	const { api } = server(
		() => [
			mine(),
			// Names differ from the row badges ("Retirada", "Oculta pela moderação").
			item('lin2', 'Fita antiga', { status: 'retracted' }),
			item('lin3', 'Fita escondida', { moderation: 'hidden' }),
			item('lin4', 'De outra pessoa', { own: false })
		],
		{
			'POST /api/v1/lineages/lin1/retract': () =>
				json({
					lineageId: 'lin1',
					status: 'retracted',
					visibility: 'private',
					moderation: 'visible'
				})
		}
	);
	await setup(api);
	await expect.element(editButton('Grave quente')).toBeVisible();
	for (const name of ['Fita antiga', 'Fita escondida', 'De outra pessoa']) {
		await expect.element(page.getByText(name, { exact: true })).toBeVisible();
		expect(editButton(name).query()).toBeNull();
	}
	// Retracting the open creation closes its form and removes the action.
	await editButton('Grave quente').click();
	await expect.element(form('Grave quente')).toBeVisible();
	// The first row is "Grave quente" (the moderated row has its own "Retirar").
	await page.getByRole('button', { name: m.biblioteca_social_retract() }).first().click();
	await expect.element(page.getByText(m.biblioteca_social_retracted_done())).toBeVisible();
	await expect.element(form('Grave quente')).not.toBeInTheDocument();
	expect(editButton('Grave quente').query()).toBeNull();
});
