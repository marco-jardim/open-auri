import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import {
	createSocialApi,
	createSocialSession,
	type LibraryItem,
	type rememberOrigin
} from '#lib/social/index.ts';
import MinhaBiblioteca from '#lib/components/pages/biblioteca/MinhaBiblioteca.svelte';
import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';
import type { KeyValueStorage } from '#lib/components/pages/biblioteca/social.ts';

// Layer this task's staging copy over the generated catalogs (same pattern as the T2.11 tests).
vi.mock('#lib/paraglide/messages.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('#lib/paraglide/messages.js')>();
	const { getLocale } = await import('#lib/paraglide/runtime.js');
	const catalogs = import.meta.glob<Record<string, string>>(
		[
			'../../../../messages/_staging/T2.11.*.json',
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
			.filter((key) => key.startsWith('biblioteca_'))
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

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage & {
	data: Map<string, string>;
} {
	const data = new Map(Object.entries(seed));
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		}
	};
}

function item(id: string, name: string, over: Partial<LibraryItem> = {}): LibraryItem {
	return {
		id,
		own: true,
		visibility: 'public',
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
			createdAt: 1
		},
		curve: { id: `${id}c`, s1: `s1-${id}`, levelDb: null, gateOk: true },
		at: 1,
		...over
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: URL, body: unknown) => Response;

function server(routes: Record<string, Handler>, options: { down?: boolean } = {}) {
	const calls: { method: string; path: string; body: unknown }[] = [];
	const fetch = async (input: string, init: RequestInit) => {
		const url = new URL(input, 'https://example.test');
		const method = init.method ?? 'GET';
		const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		calls.push({ method, path: url.pathname + url.search, body });
		if (options.down) throw new TypeError('Failed to fetch');
		const handler = routes[`${method} ${url.pathname}`];
		return handler ? handler(url, body) : json({ error: { code: 'NOT_FOUND' } }, 404);
	};
	return {
		calls,
		api: createSocialApi({ fetch, online: () => !options.down })
	};
}

const shelves: Record<string, LibraryItem[]> = {
	created: [
		item('lin1', 'Grave quente'),
		item('lin2', 'Rascunho', { visibility: 'private' }),
		item('lin3', 'Antiga', { status: 'retracted', visibility: 'unlisted' })
	],
	favorites: [item('fav1', 'Favorita da Bia', { own: false, author: null })],
	installed: [item('ins1', 'Instalada', { own: false })]
};

function library(): Handler {
	return (url) => {
		const shelf = url.searchParams.get('shelf') ?? 'created';
		const visibility = url.searchParams.get('visibility');
		const items = (shelves[shelf] ?? []).filter(
			(entry) => visibility === null || entry.visibility === visibility
		);
		return json({ shelf, items, nextCursor: null });
	};
}

const signedIn = () =>
	createSocialSession({ initial: { id: 'u-ana', username: 'Ana', emailVerified: true } });

test('signed out: only the sign-in invite, no account request', async () => {
	const { api, calls } = server({});
	render(MinhaBiblioteca, {
		session: createSocialSession({ initial: null }),
		api,
		origin: 'https://example.test',
		locale: 'pt-BR',
		storage: memoryStorage()
	});
	await expect.element(page.getByRole('link', { name: 'Entrar' })).toBeVisible();
	expect(page.getByRole('tablist').query()).toBeNull();
	expect(calls).toEqual([]);
});

test('Biblioteca without the social prop keeps the local library as before', async () => {
	const screen = await render(Biblioteca, { origin: 'https://example.test' });
	expect(screen.container.querySelectorAll('.tape')).toHaveLength(11);
	expect(page.getByRole('heading', { name: 'Minha biblioteca' }).query()).toBeNull();
});

test('signed in: shelves, visibility badge, origins and visibility/retract controls', async () => {
	const remember = vi.fn<typeof rememberOrigin>(async () => {});
	const { api, calls } = server({
		'GET /api/v1/me/library': library(),
		'GET /api/v1/me/packs': () =>
			json({
				items: [
					{
						id: 'pk1',
						name: 'Pack de graves',
						description: 'Três curvas',
						visibility: 'private',
						moderation: 'visible',
						createdAt: 1,
						updatedAt: 1
					}
				],
				nextCursor: null
			}),
		'PUT /api/v1/lineages/lin2/visibility': (_url, body) =>
			json({
				lineageId: 'lin2',
				status: 'active',
				visibility: (body as { visibility: string }).visibility,
				moderation: 'visible'
			}),
		'POST /api/v1/lineages/lin1/retract': () =>
			json({
				lineageId: 'lin1',
				status: 'retracted',
				visibility: 'public',
				moderation: 'visible'
			})
	});
	const screen = await render(MinhaBiblioteca, {
		session: signedIn(),
		api,
		origin: 'https://example.test',
		locale: 'pt-BR',
		storage: memoryStorage(),
		remember
	});
	const rowOf = (name: string) =>
		[...screen.container.querySelectorAll('.row')].find((row) =>
			row.querySelector('strong')?.textContent?.includes(name)
		);
	await expect.element(page.getByText('Grave quente')).toBeVisible();
	await expect.element(page.getByText('Rascunho')).toBeVisible();
	expect(rowOf('Grave quente')?.querySelector('.vis-public')?.textContent).toBe('Pública');
	expect(rowOf('Rascunho')?.querySelector('.vis-private')?.textContent).toBe('Privada');
	expect(rowOf('Antiga')?.textContent).toContain('Retirada');
	// Every account curve listed is remembered as a published origin (exact bytes + version).
	await vi.waitFor(() => expect(remember).toHaveBeenCalledTimes(5));
	expect(remember).toHaveBeenCalledWith({ s1: 's1-lin1', lineageId: 'lin1', versionId: 'lin1v' });

	await userEvent.selectOptions(
		page.getByRole('combobox', { name: 'Visibilidade de Rascunho' }),
		'unlisted'
	);
	await expect.element(page.getByText('Visibilidade atualizada.')).toBeVisible();
	expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ visibility: 'unlisted' });
	await vi.waitFor(() =>
		expect(rowOf('Rascunho')?.querySelector('.vis-unlisted')?.textContent).toBe('Não listada')
	);

	await page.getByRole('button', { name: 'Retirar' }).first().click();
	await expect
		.element(page.getByText('Curva retirada. Você pode restaurá-la depois.'))
		.toBeVisible();
	await expect.element(page.getByRole('button', { name: 'Restaurar' }).first()).toBeVisible();

	await page.getByRole('tab', { name: /Favoritas/ }).click();
	await expect.element(page.getByText('Favorita da Bia')).toBeVisible();
	await expect.element(page.getByText('autor removido')).toBeVisible();
	await page.getByRole('tab', { name: /Packs/ }).click();
	await expect.element(page.getByText('Pack de graves')).toBeVisible();
	// Own packs of any visibility come from GET /me/packs (no public-profile list).
	expect(rowOf('Pack de graves')?.querySelector('.vis-private')?.textContent).toBe('Privada');
	expect(calls.some((call) => call.path.startsWith('/api/v1/users/'))).toBe(false);

	await page.getByRole('tab', { name: /Criações/ }).click();
	await userEvent.selectOptions(page.getByRole('combobox', { name: /^Mostrar/ }), 'private');
	await vi.waitFor(() =>
		expect(calls.some((call) => call.path.includes('visibility=private'))).toBe(true)
	);
});

test('audience with privacy and the funnel of the account shares', async () => {
	const storage = memoryStorage();
	const share = (id: string, lineageId: string) => ({
		id,
		lineage: { id: lineageId, name: lineageId },
		versionId: null,
		channel: 'link',
		createdAt: 1
	});
	const group = (total: number, named: string[], privateCount: number) => ({
		total,
		named: named.map((name) => ({ username: name.toLowerCase(), displayUsername: name, at: 1 })),
		privateCount
	});
	const { api, calls } = server({
		'GET /api/v1/me/library': library(),
		'GET /api/v1/me/packs': () => json({ items: [], nextCursor: null }),
		// Two pages; only the shares of lin1 belong to this creation's funnel.
		'GET /api/v1/me/shares': (url) =>
			url.searchParams.get('cursor') === 'p2'
				? json({ items: [share('sh_1', 'lin1')], nextCursor: null })
				: json({ items: [share('sh_9', 'lin2')], nextCursor: 'p2' }),
		'GET /api/v1/curves/lin1/audience': () =>
			json({
				audience: {
					previewed: group(5, ['Bia', 'Caio'], 3),
					installed: group(1, [], 1),
					favorited: group(0, [], 0)
				}
			}),
		'GET /api/v1/shares/sh_1/stats': () =>
			json({
				shareId: 'sh_1',
				opens: {
					total: 9,
					days: [
						{ day: '2026-10-14', count: 4 },
						{ day: '2026-10-15', count: 5 }
					]
				},
				attributed: { previewed: 2, installed: 1, favorited: 1 }
			}),
		'POST /api/v1/shares': () => json({ shareId: 'sh_2', url: '/c/lin1?s=sh_2' }, 201),
		'GET /api/v1/shares/sh_2/stats': () =>
			json({
				shareId: 'sh_2',
				opens: { total: 0, days: [] },
				attributed: { previewed: 0, installed: 0, favorited: 0 }
			})
	});
	render(MinhaBiblioteca, {
		session: signedIn(),
		api,
		origin: 'https://example.test',
		locale: 'pt-BR',
		storage,
		remember: vi.fn<typeof rememberOrigin>(async () => {})
	});
	await page.getByRole('button', { name: 'Público e funil' }).first().click();
	await expect.element(page.getByText('3 pessoas com perfil privado')).toBeVisible();
	await expect.element(page.getByText('1 pessoas com perfil privado')).toBeVisible();
	await expect.element(page.getByRole('link', { name: 'Bia' })).toHaveAttribute('href', '/u/bia');
	await expect.element(page.getByText('Aberturas: 9')).toBeVisible();
	await expect.element(page.getByText('2026-10-15: 5')).toBeVisible();
	await expect
		.element(page.getByText('Com conta: 2 experimentaram, 1 instalaram, 1 favoritaram'))
		.toBeVisible();

	await page.getByRole('button', { name: 'Criar link de compartilhamento' }).click();
	await expect.element(page.getByText('Aberturas: 0')).toBeVisible();
	await expect.element(page.getByText('Aberturas: 9')).toBeVisible();
	expect(calls.some((call) => call.path.startsWith('/api/v1/shares/sh_9'))).toBe(false);
	expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
		lineageId: 'lin1',
		channel: 'link'
	});
	// Nothing about shares is kept in the browser any more.
	expect([...storage.data.keys()]).toEqual([]);
});

test('offline: one notice in place of the shelves, never an empty state', async () => {
	const { api } = server({}, { down: true });
	render(MinhaBiblioteca, {
		session: signedIn(),
		api,
		origin: 'https://example.test',
		locale: 'pt-BR',
		storage: memoryStorage(),
		localItems: [{ id: 'loc1', name: 'Local', s1: 's1-loc', updatedAt: 1 }],
		remember: vi.fn<typeof rememberOrigin>(async () => {})
	});
	await expect
		.element(page.getByText('Sem conexão: a parte social volta quando a rede voltar.'))
		.toBeVisible();
	expect(page.getByText('Você ainda não publicou curvas.').query()).toBeNull();
	// The merge banner waits for the network: nothing is offered (or sent) offline.
	expect(page.getByRole('button', { name: 'Mesclar biblioteca local' }).query()).toBeNull();
});

test('English copy of the shelves', async () => {
	await setLocale('en-US', { reload: false });
	const { api } = server({
		'GET /api/v1/me/library': library(),
		'GET /api/v1/me/packs': () => json({ items: [], nextCursor: null })
	});
	render(MinhaBiblioteca, {
		session: signedIn(),
		api,
		origin: 'https://example.test',
		locale: 'en-US',
		storage: memoryStorage(),
		remember: vi.fn<typeof rememberOrigin>(async () => {})
	});
	await expect.element(page.getByRole('heading', { name: 'My library' })).toBeVisible();
	await expect.element(page.getByRole('tab', { name: /Creations/ })).toBeVisible();
	await page.getByRole('tab', { name: /Packs/ }).click();
	await expect.element(page.getByText('You have not created packs yet.')).toBeVisible();
});
