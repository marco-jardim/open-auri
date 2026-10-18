// Async state must follow identity: CreationInsights shows only the current lineage's links and
// MinhaBiblioteca only the current account's rows, whatever the previous one answers late.
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import CreationInsights from '#lib/components/pages/biblioteca/CreationInsights.svelte';
import MinhaBiblioteca from '#lib/components/pages/biblioteca/MinhaBiblioteca.svelte';
import type { KeyValueStorage } from '#lib/components/pages/biblioteca/social.ts';
import {
	createSocialSession,
	type LibraryItem,
	type LibraryPage,
	type LibraryQuery,
	type MyShareItem,
	type ShareFunnel,
	type SocialApi,
	type rememberOrigin
} from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** Lets every pending microtask (late answers included) and the DOM update settle. */
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
}

// ---- CreationInsights: per-lineage state ---------------------------------------------------

const ORIGIN = 'https://example.test';
const linkOf = (lineageId: string, shareId: string) => `${ORIGIN}/c/${lineageId}?s=${shareId}`;
const linksIn = (container: HTMLElement) =>
	[...container.querySelectorAll('a.link')].map((node) => node.textContent);

const share = (id: string, lineageId: string): MyShareItem => ({
	id,
	lineage: { id: lineageId, name: lineageId },
	versionId: null,
	channel: 'link',
	createdAt: 0
});
const funnel = (shareId: string, total: number): ShareFunnel => ({
	shareId,
	opens: { total, days: [] },
	attributed: { previewed: 0, installed: 0, favorited: 0 }
});
const group = (names: string[]) => ({
	total: names.length,
	named: names.map((name) => ({ username: name.toLowerCase(), displayUsername: name, at: 0 })),
	privateCount: 0
});
const audienceOf = (names: string[]) => ({
	audience: { previewed: group(names), installed: group([]), favorited: group([]) }
});

/** Opens per share, so each lineage's stats are recognisable on screen. */
const OPENS: Record<string, number> = { sh_a: 4, sh_b: 6 };
/** The endpoint lists every own share; each lineage keeps only its own (`sharesOf`). */
const ALL_SHARES = { items: [share('sh_a', 'lin-a'), share('sh_b', 'lin-b')], nextCursor: null };

function insights() {
	const api = {
		audience: vi.fn<SocialApi['audience']>().mockResolvedValue(audienceOf([])),
		myShares: vi.fn<SocialApi['myShares']>().mockResolvedValue(ALL_SHARES),
		shareStats: vi
			.fn<SocialApi['shareStats']>()
			.mockImplementation(async (id) => funnel(id, OPENS[id] ?? 0)),
		createShare: vi
			.fn<SocialApi['createShare']>()
			.mockResolvedValue({ shareId: 'sh_new', url: '/unused' })
	};
	return { api, lineageId: 'lin-a', name: 'Creation', verified: true, origin: ORIGIN };
}

test('a new lineageId drops the previous lineage links and stats, and coming back reloads them', async () => {
	const props = insights();
	const screen = await render(CreationInsights, props);
	await expect
		.element(page.getByRole('link', { name: linkOf('lin-a', 'sh_a'), exact: true }))
		.toBeVisible();
	await expect
		.element(page.getByText(m.biblioteca_social_funnel_opens({ count: 4 })))
		.toBeVisible();

	await screen.rerender({ lineageId: 'lin-b' });
	await expect
		.element(page.getByRole('link', { name: linkOf('lin-b', 'sh_b'), exact: true }))
		.toBeVisible();
	await expect
		.element(page.getByText(m.biblioteca_social_funnel_opens({ count: 6 })))
		.toBeVisible();
	// No share of lin-a is listed under a link built for lin-b.
	expect(linksIn(screen.container)).toEqual([linkOf('lin-b', 'sh_b')]);
	expect(page.getByText(m.biblioteca_social_funnel_opens({ count: 4 })).query()).toBeNull();

	// Back to lin-a: its links and stats load again instead of staying on "loading".
	await screen.rerender({ lineageId: 'lin-a' });
	await expect
		.element(page.getByText(m.biblioteca_social_funnel_opens({ count: 4 })))
		.toBeVisible();
	expect(linksIn(screen.container)).toEqual([linkOf('lin-a', 'sh_a')]);
	expect(props.api.shareStats.mock.calls.map(([id]) => id)).toEqual(['sh_a', 'sh_b', 'sh_a']);
});

test('late answers for the previous lineage are ignored: audience, shares and a pending creation', async () => {
	const props = insights();
	const lateAudience = deferred<Awaited<ReturnType<SocialApi['audience']>>>();
	const lateShares = deferred<Awaited<ReturnType<SocialApi['myShares']>>>();
	const lateCreation = deferred<Awaited<ReturnType<SocialApi['createShare']>>>();
	props.api.audience.mockImplementation((lineageId) =>
		lineageId === 'lin-a' ? lateAudience.promise : Promise.resolve(audienceOf(['Bia']))
	);
	props.api.myShares.mockReturnValueOnce(lateShares.promise);
	props.api.createShare.mockReturnValueOnce(lateCreation.promise);
	const screen = await render(CreationInsights, props);
	const create = page.getByRole('button', { name: m.biblioteca_social_funnel_create() });
	await create.click();
	await expect.element(create).toBeDisabled();
	expect(props.api.createShare).toHaveBeenCalledExactlyOnceWith({
		lineageId: 'lin-a',
		channel: 'link'
	});
	const signals = [
		props.api.audience.mock.calls[0]?.[1]?.signal,
		props.api.myShares.mock.calls[0]?.[1]?.signal
	];

	await screen.rerender({ lineageId: 'lin-b' });
	expect(signals.every((signal) => signal?.aborted)).toBe(true);
	await expect.element(page.getByRole('link', { name: 'Bia', exact: true })).toBeVisible();
	await expect
		.element(page.getByRole('link', { name: linkOf('lin-b', 'sh_b'), exact: true }))
		.toBeVisible();
	// The new lineage is not locked by the previous lineage's creation.
	await expect.element(create).toBeEnabled();

	// lin-a's requests answer anyway (as a fake that ignores the abort signal would).
	lateAudience.resolve(audienceOf(['Ana']));
	lateShares.resolve({ items: [share('sh_a', 'lin-a')], nextCursor: null });
	lateCreation.resolve({ shareId: 'sh_late', url: '/unused' });
	await settle();
	expect(page.getByRole('link', { name: 'Ana', exact: true }).query()).toBeNull();
	await expect.element(page.getByRole('link', { name: 'Bia', exact: true })).toBeVisible();
	expect(linksIn(screen.container)).toEqual([linkOf('lin-b', 'sh_b')]);
	expect(props.api.shareStats.mock.calls.map(([id]) => id)).not.toContain('sh_late');
	expect(page.getByRole('alert').query()).toBeNull();
});

// ---- MinhaBiblioteca: per-account shelves --------------------------------------------------

type ShelfName = LibraryQuery['shelf'];

const ANA = { id: 'u-ana', username: 'Ana', emailVerified: true };
const BRUNO = { id: 'u-bruno', username: 'Bruno', emailVerified: true };

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

const ROWS: Record<string, Partial<Record<ShelfName, LibraryItem[]>>> = {
	[ANA.id]: {
		created: [item('a1', 'Curva da Ana')],
		favorites: [item('a2', 'Favorita da Ana', { own: false })]
	},
	[BRUNO.id]: { created: [item('b1', 'Curva do Bruno')] }
};

const pageOf = (accountId: string | null, shelf: ShelfName): LibraryPage => ({
	shelf,
	items: ROWS[accountId ?? '']?.[shelf] ?? [],
	nextCursor: null
});

/** A tab's name carries its row count ("Favoritas 0"): match the label, as the shelf tests do. */
const shelfTab = (label: string) => page.getByRole('tab', { name: new RegExp(`^${label}`) });
/** Row count shown on a shelf tab, without switching to it. */
const badge = (label: string) => shelfTab(label).element().querySelector('.badge')?.textContent;

function memoryStorage(): KeyValueStorage {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		}
	};
}

function library() {
	const session = createSocialSession({ initial: ANA });
	const api = {
		myLibrary: vi
			.fn<SocialApi['myLibrary']>()
			.mockImplementation(async (query) => pageOf(session.accountId, query.shelf)),
		myPacks: vi.fn<SocialApi['myPacks']>().mockResolvedValue({ items: [], nextCursor: null }),
		myShares: vi.fn<SocialApi['myShares']>().mockResolvedValue({ items: [], nextCursor: null }),
		setVisibility: vi.fn<SocialApi['setVisibility']>(),
		retractLineage: vi.fn<SocialApi['retractLineage']>(),
		restoreLineage: vi.fn<SocialApi['restoreLineage']>(),
		mergeLibrary: vi.fn<SocialApi['mergeLibrary']>(),
		audience: vi.fn<SocialApi['audience']>(),
		shareStats: vi.fn<SocialApi['shareStats']>(),
		createShare: vi.fn<SocialApi['createShare']>()
	};
	const remember = vi.fn<typeof rememberOrigin>(async () => {});
	return {
		session,
		api,
		remember,
		props: { session, api, origin: ORIGIN, locale: 'pt-BR', storage: memoryStorage(), remember }
	};
}

test('switching straight to another signed-in account clears the rows and reloads them', async () => {
	const { session, api, props } = library();
	const brunoCreated = deferred<LibraryPage>();
	api.myLibrary.mockImplementation((query) =>
		session.accountId === BRUNO.id && query.shelf === 'created'
			? brunoCreated.promise
			: Promise.resolve(pageOf(session.accountId, query.shelf))
	);
	await render(MinhaBiblioteca, props);
	await expect.element(page.getByText('Curva da Ana', { exact: true })).toBeVisible();
	await expect.poll(() => badge(m.biblioteca_social_shelf_favorites())).toBe('1');
	expect(api.myLibrary).toHaveBeenCalledTimes(3);
	expect(api.myPacks).toHaveBeenCalledTimes(1);

	// No signed-out step in between: the account id alone changes.
	session.set(BRUNO);
	await expect.element(page.getByText('Curva da Ana', { exact: true })).not.toBeInTheDocument();
	await expect
		.element(page.getByText(m.biblioteca_social_loading()))
		.toHaveAttribute('aria-busy', 'true');
	expect(api.myLibrary).toHaveBeenCalledTimes(6);
	expect(api.myPacks).toHaveBeenCalledTimes(2);

	brunoCreated.resolve(pageOf(BRUNO.id, 'created'));
	await expect.element(page.getByText('Curva do Bruno', { exact: true })).toBeVisible();
	expect(badge(m.biblioteca_social_shelf_favorites())).toBe('0');
	await shelfTab(m.biblioteca_social_shelf_favorites()).click();
	await expect.element(page.getByText(m.biblioteca_social_empty_favorites())).toBeVisible();
	expect(page.getByText('Favorita da Ana', { exact: true }).query()).toBeNull();
});

test('late answers for the previous account never land on the new account shelves', async () => {
	const { session, api, remember, props } = library();
	const late = new Map<ShelfName, Deferred<LibraryPage>>();
	const latePacks = deferred<Awaited<ReturnType<SocialApi['myPacks']>>>();
	api.myLibrary.mockImplementation((query) => {
		if (session.accountId === ANA.id) {
			const pending = deferred<LibraryPage>();
			late.set(query.shelf, pending);
			return pending.promise;
		}
		return Promise.resolve(pageOf(session.accountId, query.shelf));
	});
	api.myPacks.mockImplementation(async () =>
		session.accountId === ANA.id ? latePacks.promise : { items: [], nextCursor: null }
	);
	await render(MinhaBiblioteca, props);
	await expect
		.element(page.getByText(m.biblioteca_social_loading()))
		.toHaveAttribute('aria-busy', 'true');
	expect(late.size).toBe(3);
	const anaSignals = [...api.myLibrary.mock.calls, ...api.myPacks.mock.calls].map(
		([, options]) => options?.signal
	);

	session.set(BRUNO);
	await expect.element(page.getByText('Curva do Bruno', { exact: true })).toBeVisible();
	expect(anaSignals).toHaveLength(4);
	expect(anaSignals.every((signal) => signal?.aborted)).toBe(true);

	// Ana's requests answer anyway (as a fake that ignores the abort signal would).
	for (const [shelf, pending] of late) pending.resolve(pageOf(ANA.id, shelf));
	latePacks.resolve({
		items: [
			{
				id: 'pk-ana',
				name: 'Pack da Ana',
				description: '',
				visibility: 'public',
				moderation: 'visible',
				createdAt: 0,
				updatedAt: 0
			}
		],
		nextCursor: null
	});
	await settle();
	expect(page.getByText('Curva da Ana', { exact: true }).query()).toBeNull();
	await expect.element(page.getByText('Curva do Bruno', { exact: true })).toBeVisible();
	expect(badge(m.biblioteca_social_shelf_favorites())).toBe('0');
	expect(badge(m.biblioteca_social_shelf_packs())).toBe('0');
	await shelfTab(m.biblioteca_social_shelf_favorites()).click();
	await expect.element(page.getByText(m.biblioteca_social_empty_favorites())).toBeVisible();
	await shelfTab(m.biblioteca_social_shelf_packs()).click();
	await expect.element(page.getByText(m.biblioteca_social_empty_packs_own())).toBeVisible();
	expect(page.getByText('Pack da Ana', { exact: true }).query()).toBeNull();
	// Only the current account's curves are remembered as published origins.
	expect(remember).toHaveBeenCalledExactlyOnceWith({
		s1: 's1-b1',
		lineageId: 'b1',
		versionId: 'b1v'
	});
});
