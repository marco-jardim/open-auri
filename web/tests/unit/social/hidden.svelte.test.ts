import { mount, unmount, type Component } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import Comunidade from '#lib/components/pages/comunidade/Comunidade.svelte';
import SharedCurve from '#lib/components/pages/shared-curve/SharedCurve.svelte';
import Perfil from '#lib/components/pages/perfil/Perfil.svelte';
import type { ProfileView } from '#lib/components/pages/perfil/model.ts';
import HiddenItems from '#lib/components/social/HiddenItems.svelte';
import { createHiddenStore, type HiddenStore } from '#lib/social/hidden-store.ts';
import { HIDDEN_CONTEXT } from '#lib/social/hidden-context.ts';
import { HIDDEN_STORAGE_KEY } from '#lib/social/hidden.ts';
import { createTour } from '#lib/comprehension/tour.svelte.ts';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { ANONYMOUS, apiWith, fakeFetch, feedItem, feedPage, json, S1_NEUTRAL } from '../pages/comunidade/fixtures.ts';

const cleanups: (() => Promise<void>)[] = [];
function show<Props extends Record<string, unknown>>(component: Component<Props>, props: Props, store: HiddenStore) {
	const target = document.createElement('div');
	document.body.append(target);
	const instance = mount(component, { target, props, context: new Map([[HIDDEN_CONTEXT, store]]) });
	cleanups.push(async () => { await unmount(instance); target.remove(); });
	return target;
}
function remote() {
	return { myHidden: vi.fn(async () => ({ items: [] })), putHidden: vi.fn(async () => ({ items: [] })), deleteHidden: vi.fn(async () => ({ items: [] })) };
}
async function visitor() {
	const store = createHiddenStore(remote());
	await store.setUser(null);
	return store;
}
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	localStorage.removeItem(HIDDEN_STORAGE_KEY);
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`community curve/author hide actions and human-labelled management work in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const store = await visitor();
		const author = { id: 'public-author-1', username: 'geoff', displayUsername: 'Geoff' };
		const api = apiWith(fakeFetch((url) => url.pathname === '/api/v1/feed'
			? json(feedPage([feedItem({ id: 'curve-1', name: 'Night radio', author }), feedItem({ id: 'curve-2', name: 'Other curve', author })])) : undefined));
		const target = show(Comunidade, { api, session: ANONYMOUS, storage: null,
			tourController: createTour({ storage: () => undefined, isDesktop: () => false }) }, store);
		await expect.element(page.getByRole('link', { name: 'Night radio', exact: true })).toBeVisible();
		await page.getByRole('button', { name: m.hidden_hide_curve(), exact: true }).first().click();
		await expect.element(page.getByRole('link', { name: 'Night radio', exact: true })).not.toBeInTheDocument();
		await expect.element(page.getByRole('link', { name: 'Other curve', exact: true })).toBeVisible();
		await page.getByText(m.hidden_title(), { exact: true }).click();
		await expect.element(page.getByRole('button', { name: m.hidden_unhide_named({ name: 'Night radio' }) })).toBeVisible();
		expect(target.querySelector('.hidden-items')?.textContent).not.toContain('curve-1');
		await page.getByRole('button', { name: m.hidden_unhide_named({ name: 'Night radio' }) }).click();
		await expect.element(page.getByRole('link', { name: 'Night radio', exact: true })).toBeVisible();
		await page.getByRole('button', { name: m.hidden_hide_author(), exact: true }).first().click();
		await expect.element(page.getByRole('link', { name: 'Night radio', exact: true })).not.toBeInTheDocument();
		await expect.element(page.getByRole('link', { name: 'Other curve', exact: true })).not.toBeInTheDocument();
		expect(target.querySelector('.hidden-items')?.textContent).toContain('@Geoff');
		expect(target.querySelector('.hidden-items')?.textContent).not.toContain('public-author-1');
		await page.getByRole('button', { name: m.hidden_unhide_named({ name: 'Geoff' }) }).click();
		await expect.element(page.getByRole('link', { name: 'Other curve', exact: true })).toBeVisible();
	});
}

test('direct curve page hides content and offers unhide without reloading', async () => {
	const store = await visitor();
	show(SharedCurve, {
		curve: { lineageId: 'curve1', versionId: 'version1', isHead: true, name: 'Warm vocal', description: 'Description',
			license: 'CC0-1.0', lang: 'pt-BR', author: { id: 'author1', username: 'ana', displayUsername: 'Ana' },
			s1: S1_NEUTRAL, visibility: 'public', shareId: null },
		meta: { canonical: 'https://example.test/c/curve1', image: 'https://example.test/og/version1.png', indexable: true }, signedIn: false
	}, store);
	await page.getByRole('button', { name: m.hidden_hide_curve(), exact: true }).click();
	await expect.element(page.getByRole('heading', { name: 'Warm vocal', exact: true })).not.toBeInTheDocument();
	await expect.element(page.getByText(m.hidden_content(), { exact: true })).toBeVisible();
	await page.getByText(m.hidden_title(), { exact: true }).click();
	await page.getByRole('button', { name: m.hidden_unhide_named({ name: 'Warm vocal' }) }).click();
	await expect.element(page.getByRole('heading', { name: 'Warm vocal', exact: true })).toBeVisible();
});

test('profile author hiding removes bio, creations, packs and favorites until unhidden', async () => {
	const store = await visitor();
	const data: ProfileView = {
		profile: { authorId: 'author-ana', username: 'ana', displayUsername: 'Ana', bio: 'Private viewer choice', library: 'public', activity: 'public', counts: { lineages: 1, packs: 1 } },
		lineages: { items: [], nextCursor: null }, packs: { items: [{ id: 'pack1', name: 'My pack', description: '', createdAt: 1, updatedAt: 1 }], nextCursor: null }, favorites: { items: [], nextCursor: null }
	};
	const target = show(Perfil, { data }, store);
	await page.getByRole('button', { name: m.hidden_hide_author(), exact: true }).click();
	await expect.element(page.getByRole('heading', { name: 'Ana', exact: true })).not.toBeInTheDocument();
		expect(target.textContent).not.toContain('My pack');
		expect(target.textContent).not.toContain('Private viewer choice');
	await page.getByText(m.hidden_title(), { exact: true }).click();
	await page.getByRole('button', { name: m.hidden_unhide_named({ name: 'Ana' }) }).click();
	await expect.element(page.getByText('My pack', { exact: true })).toBeVisible();
});

test('account management uses synced human labels and DELETE instead of browser persistence', async () => {
	const api = remote();
	const myHidden = vi.fn(async () => ({ items: [{ targetType: 'curve' as const, targetId: 'opaque-id', label: '<b>Radio</b>', createdAt: 1 }] }));
	const store = createHiddenStore({ ...api, myHidden });
	await store.setUser('signed-in');
	const target = show(HiddenItems, {}, store);
	await page.getByText(m.hidden_title(), { exact: true }).click();
	await expect.element(page.getByRole('button', { name: m.hidden_unhide_named({ name: '<b>Radio</b>' }) })).toBeVisible();
		expect(target.querySelector('b')).toBeNull();
		expect(target.textContent).not.toContain('opaque-id');
	await page.getByRole('button', { name: m.hidden_unhide_named({ name: '<b>Radio</b>' }) }).click();
		expect(api.deleteHidden).toHaveBeenCalledWith({ targetType: 'curve', targetId: 'opaque-id' });
	await expect.element(page.getByText(m.hidden_empty(), { exact: true })).toBeVisible();
		expect(localStorage.getItem(HIDDEN_STORAGE_KEY)).toBeNull();
});

test('hidden curves stay out of ranked feed results, including after a sort change', async () => {
	const store = await visitor();
	await store.hide('curve', 'blocked', 'Blocked song');
	const api = apiWith(fakeFetch((url) => url.pathname === '/api/v1/feed'
		? json(feedPage([feedItem({ id: 'blocked', name: 'Blocked song' }), feedItem({ id: 'visible', name: 'Visible song' })])) : undefined));
	show(Comunidade, { api, session: ANONYMOUS, storage: null, tourController: createTour({ storage: () => undefined, isDesktop: () => false }) }, store);
	await expect.element(page.getByRole('link', { name: 'Visible song', exact: true })).toBeVisible();
	await page.getByRole('button', { name: m.comunidade_sort_favorites(), exact: true }).click();
	await expect.element(page.getByRole('link', { name: 'Visible song', exact: true })).toBeVisible();
		expect(page.getByRole('link', { name: 'Blocked song', exact: true }).elements()).toHaveLength(0);
});
