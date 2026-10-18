import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import {
	createSocialApi,
	createSocialSession,
	SocialApiError,
	type LibraryItem,
	type ShareFunnel,
	type SocialApi,
	type rememberOrigin
} from '#lib/social/index.ts';
import MinhaBiblioteca from '#lib/components/pages/biblioteca/MinhaBiblioteca.svelte';
import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';
import CreationInsights from '#lib/components/pages/biblioteca/CreationInsights.svelte';
import type { KeyValueStorage } from '#lib/components/pages/biblioteca/social.ts';
import { m } from '#lib/paraglide/messages.js';

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
	vi.restoreAllMocks();
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
				? json({ items: [share('sh_1', 'lin1'), share('sh_3', 'lin1')], nextCursor: null })
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
			}),
		'GET /api/v1/shares/sh_3/stats': () =>
			json({
				shareId: 'sh_3',
				opens: { total: 3, days: [] },
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
	await expect.element(page.getByText('Aberturas: 3')).toBeVisible();
	await expect.element(page.getByText('2026-10-15: 5')).toBeVisible();
	await expect
		.element(page.getByText('Com conta: 2 experimentaram, 1 instalaram, 1 favoritaram'))
		.toBeVisible();

	await page.getByRole('button', { name: 'Criar link de compartilhamento' }).click();
	await expect.element(page.getByText('Aberturas: 0')).toBeVisible();
	await expect.element(page.getByText('Aberturas: 9')).toBeVisible();
	// Only the newly created share gets stats; the existing funnels stay cached.
	for (const shareId of ['sh_1', 'sh_2', 'sh_3']) {
		expect(calls.filter((call) => call.path === `/api/v1/shares/${shareId}/stats`)).toHaveLength(1);
	}
	expect(calls.some((call) => call.path.startsWith('/api/v1/shares/sh_9'))).toBe(false);
	expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
		lineageId: 'lin1',
		channel: 'link'
	});
	// Nothing about shares is kept in the browser any more.
	expect([...storage.data.keys()]).toEqual([]);
});

test('creating a share keeps existing in-flight stats alive and fetches only the new share', async () => {
	let finishStats: ((funnel: ShareFunnel) => void) | undefined;
	const pendingStats = new Promise<ShareFunnel>((resolve) => {
		finishStats = resolve;
	});
	const funnel = (shareId: string, total: number): ShareFunnel => ({
		shareId,
		opens: { total, days: [] },
		attributed: { previewed: 0, installed: 0, favorited: 0 }
	});
	const shareStats = vi.fn<SocialApi['shareStats']>((shareId) =>
		shareId === 'sh_old' ? pendingStats : Promise.resolve(funnel(shareId, 0))
	);
	const group = { total: 0, named: [], privateCount: 0 };
	const screen = await render(CreationInsights, {
		lineageId: 'lin1',
		name: 'Minha curva',
		verified: true,
		origin: 'https://example.test',
		api: {
			audience: async () => ({
				audience: { previewed: group, installed: group, favorited: group }
			}),
			myShares: async () => ({
				items: [
					{
						id: 'sh_old',
						lineage: { id: 'lin1', name: 'Minha curva' },
						versionId: null,
						channel: 'link',
						createdAt: 1
					}
				],
				nextCursor: null
			}),
			createShare: async () => ({ shareId: 'sh_new', url: '/c/lin1?s=sh_new' }),
			shareStats
		}
	});
	await vi.waitFor(() => expect(shareStats).toHaveBeenCalledTimes(1));
	const signal = shareStats.mock.calls[0]?.[1]?.signal;
	expect(signal?.aborted).toBe(false);
	await page.getByRole('button', { name: 'Criar link de compartilhamento' }).click();
	await expect.element(page.getByText('Aberturas: 0')).toBeVisible();
	expect(shareStats.mock.calls.map(([shareId]) => shareId)).toEqual(['sh_old', 'sh_new']);
	expect(signal?.aborted).toBe(false);
	finishStats?.(funnel('sh_old', 7));
	await expect.element(page.getByText('Aberturas: 7')).toBeVisible();
	await screen.unmount();
	expect(signal?.aborted).toBe(true);
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function emptyServer(routes: Record<string, Handler> = {}) {
	return server({
		'GET /api/v1/me/library': (url) =>
			json({ shelf: url.searchParams.get('shelf'), items: [], nextCursor: null }),
		'GET /api/v1/me/packs': () => json({ items: [], nextCursor: null }),
		...routes
	});
}

function mineProps(api: SocialApi) {
	return {
		session: signedIn(),
		api,
		origin: 'https://example.test',
		locale: 'pt-BR',
		storage: memoryStorage(),
		remember: vi.fn<typeof rememberOrigin>(async () => {})
	};
}

test('unknown session waits without requests, then the signed-out invite preserves the return path', async () => {
	const { api, calls } = emptyServer();
	const screen = await render(MinhaBiblioteca, {
		...mineProps(api),
		session: { signedIn: false, verified: false, nickname: null, account: null, known: false },
		currentPath: '/biblioteca?tag=bass'
	});
	await expect
		.element(page.getByText(m.biblioteca_social_loading()))
		.toHaveAttribute('aria-busy', 'true');
	expect(calls).toEqual([]);
	await screen.rerender({ session: createSocialSession({ initial: null }) });
	const link = page.getByRole('link', { name: m.biblioteca_social_signin_link() });
	await expect.element(link).toBeVisible();
	expect(new URL((link.element() as HTMLAnchorElement).href).searchParams.get('next')).toBe(
		'/biblioteca?tag=bass'
	);
	expect(calls).toEqual([]);
});

test('all four empty shelves have their own copy and keyboard tabs wrap in both directions', async () => {
	const { api } = emptyServer();
	await render(MinhaBiblioteca, mineProps(api));
	await expect.element(page.getByText(m.biblioteca_social_empty_created())).toBeVisible();
	const tabs = page.getByRole('tab');
	const first = tabs.nth(0);
	(first.element() as HTMLElement).focus();
	await userEvent.keyboard('{ArrowLeft}');
	await expect.element(tabs.nth(3)).toHaveAttribute('aria-selected', 'true');
	await expect.element(tabs.nth(3)).toHaveFocus();
	await expect.element(page.getByText(m.biblioteca_social_empty_packs_own())).toBeVisible();
	await userEvent.keyboard('{ArrowRight}');
	await expect.element(first).toHaveFocus();
	await userEvent.keyboard('{ArrowRight}');
	await expect.element(page.getByText(m.biblioteca_social_empty_favorites())).toBeVisible();
	await userEvent.keyboard('{ArrowRight}');
	await expect.element(page.getByText(m.biblioteca_social_empty_installed())).toBeVisible();
	await userEvent.keyboard('{Home}');
	await expect.element(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
});

for (const target of ['created', 'packs'] as const) {
	test(`${target}: loading keeps a busy placeholder and pagination appends rows`, async () => {
		const pending = deferred<Awaited<ReturnType<SocialApi['myLibrary']>>>();
		const { api } = emptyServer({
			'GET /api/v1/me/library': (url) =>
				json({
					shelf: url.searchParams.get('shelf'),
					items: [item('second', 'Second')],
					nextCursor: null
				}),
			'GET /api/v1/me/packs': (url) =>
				json({
					items: [
						{
							id: url.searchParams.has('cursor') ? 'second' : 'first',
							name: url.searchParams.has('cursor') ? 'Second pack' : 'First pack',
							description: url.searchParams.has('cursor') ? '' : 'Notes',
							visibility: 'unlisted',
							moderation: url.searchParams.has('cursor') ? 'visible' : 'hidden',
							createdAt: 0,
							updatedAt: 0
						}
					],
					nextCursor: url.searchParams.has('cursor') ? null : 'pack-next'
				})
		});
		const load = vi.spyOn(api, 'myLibrary');
		load.mockImplementationOnce(() =>
			Promise.resolve({ shelf: 'favorites', items: [], nextCursor: null })
		);
		load.mockImplementationOnce(() =>
			Promise.resolve({ shelf: 'installed', items: [], nextCursor: null })
		);
		load.mockImplementationOnce(() => pending.promise);
		const screen = await render(MinhaBiblioteca, mineProps(api));
		await expect
			.element(page.getByText(m.biblioteca_social_loading()))
			.toHaveAttribute('aria-busy', 'true');
		pending.resolve({
			shelf: 'created',
			items: [item('first', 'First')],
			nextCursor: 'shelf-next'
		});
		await expect.element(page.getByText('First', { exact: true })).toBeVisible();
		if (target === 'packs') {
			await page.getByRole('tab', { name: /Packs/ }).click();
			await expect.element(page.getByText('Notes', { exact: true })).toBeVisible();
			await expect.element(page.getByText(m.biblioteca_social_moderated())).toBeVisible();
		}
		await page.getByRole('button', { name: m.biblioteca_social_more(), exact: true }).click();
		await expect
			.element(page.getByText(target === 'packs' ? 'Second pack' : 'Second', { exact: true }))
			.toBeVisible();
		expect(screen.container.querySelectorAll('.row')).toHaveLength(2);
		await expect
			.element(page.getByRole('button', { name: m.biblioteca_social_more(), exact: true }))
			.not.toBeInTheDocument();
		if (target === 'created')
			expect(load.mock.lastCall?.[0]).toEqual({ shelf: 'created', cursor: 'shelf-next' });
	});
}

const errorCases = [
	{ code: 'AUTH_REQUIRED', text: () => m.biblioteca_social_error_auth() },
	{ code: 'EMAIL_NOT_VERIFIED', text: () => m.biblioteca_social_verify() },
	{ code: 'GATE_REJECTED', text: () => m.biblioteca_social_error_gate() },
	{ code: 'RATE_LIMITED', text: () => m.biblioteca_social_error_rate() },
	{ code: 'NOT_FOUND', text: () => m.biblioteca_social_error_missing() },
	{ code: 'INTERNAL', text: () => m.biblioteca_social_error_generic() }
] as const;

for (const target of ['created', 'packs'] as const) {
	for (const { code, text } of errorCases) {
		test(`${target}: ${code} is explained and an explicit retry recovers`, async () => {
			const { api } = emptyServer();
			if (target === 'created')
				vi.spyOn(api, 'myLibrary')
					.mockImplementationOnce(async () => ({ shelf: 'favorites', items: [], nextCursor: null }))
					.mockImplementationOnce(async () => ({ shelf: 'installed', items: [], nextCursor: null }))
					.mockRejectedValueOnce(new SocialApiError(400, code));
			else vi.spyOn(api, 'myPacks').mockRejectedValueOnce(new SocialApiError(400, code));
			await render(MinhaBiblioteca, mineProps(api));
			if (target === 'packs') await page.getByRole('tab', { name: /Packs/ }).click();
			await expect.element(page.getByRole('alert')).toHaveTextContent(text());
			await page.getByRole('button', { name: m.biblioteca_social_retry() }).click();
			await expect
				.element(
					page.getByText(
						target === 'packs'
							? m.biblioteca_social_empty_packs_own()
							: m.biblioteca_social_empty_created()
					)
				)
				.toBeVisible();
			await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
		});
	}
}

test('offline/online events hide merging and retry shelves once on reconnection', async () => {
	const { api, calls } = emptyServer();
	await render(MinhaBiblioteca, mineProps(api));
	await expect.element(page.getByText(m.biblioteca_social_empty_created())).toBeVisible();
	window.dispatchEvent(new Event('offline'));
	await expect.element(page.getByText(m.biblioteca_social_offline())).toBeVisible();
	window.dispatchEvent(new Event('online'));
	await expect.element(page.getByText(m.biblioteca_social_offline())).not.toBeInTheDocument();
	await expect.poll(() => calls.length).toBe(8);
});

test('unverified owners cannot publish or restore; other authors never receive owner controls', async () => {
	const { api } = emptyServer({
		'GET /api/v1/me/library': (url) =>
			json({
				shelf: url.searchParams.get('shelf'),
				items:
					url.searchParams.get('shelf') === 'created'
						? [
								item('own', 'Owned', {
									status: 'retracted',
									moderation: 'hidden',
									curve: { id: 'curve', s1: 's1', levelDb: 0, gateOk: false }
								}),
								item('other', 'Other author', { own: false })
							]
						: [item('favorite', 'Named favorite', { own: false })],
				nextCursor: null
			})
	});
	const props = mineProps(api);
	props.session = createSocialSession({
		initial: { id: 'u', username: 'Ana', emailVerified: false }
	});
	const screen = await render(MinhaBiblioteca, props);
	await expect
		.element(
			page.getByRole('combobox', { name: m.biblioteca_social_change_visibility({ name: 'Owned' }) })
		)
		.toBeDisabled();
	await expect
		.element(page.getByRole('button', { name: m.biblioteca_social_restore() }))
		.toBeDisabled();
	await expect.element(page.getByText(m.biblioteca_social_gate_failed())).toBeVisible();
	await expect.element(page.getByText(m.biblioteca_social_moderated())).toBeVisible();
	await expect
		.element(
			page.getByRole('combobox', {
				name: m.biblioteca_social_change_visibility({ name: 'Other author' })
			})
		)
		.not.toBeInTheDocument();
	expect(screen.container.querySelectorAll('.row-actions a')).toHaveLength(1);
	await page.getByRole('tab', { name: /Favoritas/ }).click();
	await expect.element(page.getByText(m.biblioteca_social_by({ name: 'Ana' }))).toBeVisible();
});

test('restoring patches every shelf and opening insights toggles back closed', async () => {
	const { api } = emptyServer({
		'GET /api/v1/me/library': (url) =>
			json({
				shelf: url.searchParams.get('shelf'),
				items: [item('same', 'Same creation', { status: 'retracted' }), item('other', 'Unchanged')],
				nextCursor: null
			}),
		'POST /api/v1/lineages/same/restore': () =>
			json({ lineageId: 'same', status: 'active', visibility: 'public', moderation: 'visible' }),
		'GET /api/v1/curves/same/audience': () =>
			json({
				audience: {
					previewed: { total: 0, named: [], privateCount: 0 },
					installed: { total: 0, named: [], privateCount: 0 },
					favorited: { total: 0, named: [], privateCount: 0 }
				}
			}),
		'GET /api/v1/me/shares': () => json({ items: [], nextCursor: null })
	});
	await render(MinhaBiblioteca, mineProps(api));
	await page.getByRole('button', { name: m.biblioteca_social_restore() }).click();
	await expect.element(page.getByText(m.biblioteca_social_restored_done())).toBeVisible();
	const insights = page.getByRole('button', { name: m.biblioteca_social_insights() }).first();
	await insights.click();
	await expect.element(insights).toHaveAttribute('aria-expanded', 'true');
	await expect
		.element(
			page.getByRole('heading', {
				name: m.biblioteca_social_audience_title({ name: 'Same creation' })
			})
		)
		.toBeVisible();
	await insights.click();
	await expect.element(insights).toHaveAttribute('aria-expanded', 'false');
	await expect
		.element(
			page.getByRole('heading', {
				name: m.biblioteca_social_audience_title({ name: 'Same creation' })
			})
		)
		.not.toBeInTheDocument();
	for (const tab of [/Favoritas/, /Instaladas/]) {
		await page.getByRole('tab', { name: tab }).click();
		await expect
			.element(
				page.getByRole('link', { name: m.biblioteca_social_open_label({ name: 'Same creation' }) })
			)
			.toHaveAttribute('href', '/c/same');
		await expect
			.element(page.getByText(m.biblioteca_social_retracted(), { exact: true }))
			.not.toBeInTheDocument();
	}
});

test('a pending owner action locks other controls and a failed action can be retried', async () => {
	const { api } = emptyServer({ 'GET /api/v1/me/library': library() });
	const pending = deferred<Awaited<ReturnType<SocialApi['retractLineage']>>>();
	const retract = vi
		.spyOn(api, 'retractLineage')
		.mockReturnValueOnce(pending.promise)
		.mockRejectedValueOnce(new SocialApiError(0, 'OFFLINE'));
	await render(MinhaBiblioteca, mineProps(api));
	const button = page.getByRole('button', { name: m.biblioteca_social_retract() }).first();
	await button.click();
	await expect.element(button).toBeDisabled();
	await expect
		.element(
			page.getByRole('combobox', {
				name: m.biblioteca_social_change_visibility({ name: 'Rascunho' })
			})
		)
		.toBeDisabled();
	pending.reject(new SocialApiError(429, 'RATE_LIMITED'));
	await expect.element(page.getByText(m.biblioteca_social_error_rate())).toBeVisible();
	await expect.element(button).toBeEnabled();
	await button.click();
	await expect.element(page.getByText(m.biblioteca_social_offline())).toBeVisible();
	expect(retract).toHaveBeenCalledTimes(2);
});

for (const target of ['created', 'packs'] as const) {
	test(`${target}: aborting on sign-out is silent and cancels the request signal`, async () => {
		const { api } = emptyServer();
		const library = deferred<Awaited<ReturnType<SocialApi['myLibrary']>>>();
		const packs = deferred<Awaited<ReturnType<SocialApi['myPacks']>>>();
		const loadLibrary = vi.spyOn(api, 'myLibrary');
		const loadPacks = vi.spyOn(api, 'myPacks');
		if (target === 'created') loadLibrary.mockImplementation(() => library.promise);
		else loadPacks.mockReturnValue(packs.promise);
		const screen = await render(MinhaBiblioteca, mineProps(api));
		if (target === 'packs') await page.getByRole('tab', { name: /Packs/ }).click();
		await expect
			.element(page.getByText(m.biblioteca_social_loading()))
			.toHaveAttribute('aria-busy', 'true');
		const signal =
			target === 'created'
				? loadLibrary.mock.lastCall?.[1]?.signal
				: loadPacks.mock.lastCall?.[1]?.signal;
		await screen.rerender({ session: createSocialSession({ initial: null }) });
		expect(signal?.aborted).toBe(true);
		const abort = new DOMException('Cancelled', 'AbortError');
		if (target === 'created') library.reject(abort);
		else packs.reject(abort);
		await expect
			.element(page.getByRole('link', { name: m.biblioteca_social_signin_link() }))
			.toBeVisible();
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});
}

test('merging local items reloads all account shelves only after explicit confirmation', async () => {
	const { api, calls } = emptyServer({
		'POST /api/v1/me/library/merge': () =>
			json({
				created: [{ localId: 'local', lineageId: 'merged' }],
				duplicates: [],
				rejected: [],
				conflicts: []
			})
	});
	await render(MinhaBiblioteca, {
		...mineProps(api),
		localItems: [{ id: 'local', name: 'Local', s1: 's1-local', updatedAt: 1 }]
	});
	await expect.element(page.getByText(m.biblioteca_social_empty_created())).toBeVisible();
	expect(calls).toHaveLength(4);
	await page.getByRole('button', { name: 'Mesclar biblioteca local', exact: true }).click();
	await expect.poll(() => calls.filter((call) => call.method === 'GET').length).toBe(8);
	expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});
