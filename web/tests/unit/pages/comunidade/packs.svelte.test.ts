import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import PacksPanel from '#lib/components/pages/comunidade/PacksPanel.svelte';
import { m } from '#lib/paraglide/messages.js';
import { ANONYMOUS, VERIFIED, apiWith, fakeFetch, feedItem, json } from './fixtures.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

const pack = (id: string, visibility: 'private' | 'unlisted' | 'public') => ({
	id,
	name: `Pack ${visibility}`,
	description: `Descrição ${visibility}`,
	visibility,
	moderation: 'visible',
	createdAt: 1,
	updatedAt: 1
});

test('own packs of every visibility reload via myPacks, even without a public nickname/library', async () => {
	const fetch = fakeFetch((url) => {
		if (url.pathname === '/api/v1/me/library') return json({ items: [], nextCursor: null });
		if (url.pathname === '/api/v1/me/packs') {
			return json({
				items: [
					pack('pk-private', 'private'),
					pack('pk-unlisted', 'unlisted'),
					pack('pk-public', 'public')
				],
				nextCursor: null
			});
		}
		return undefined;
	});
	const props = {
		api: apiWith(fetch),
		session: { ...VERIFIED, nickname: null },
		online: true
	};
	const first = await render(PacksPanel, props);
	await expect.element(page.getByText('Pack private', { exact: true })).toBeVisible();
	await expect.element(page.getByText('Pack unlisted', { exact: true })).toBeVisible();
	await expect.element(page.getByText('Pack public', { exact: true })).toBeVisible();
	for (const name of ['Pack private', 'Pack unlisted', 'Pack public']) {
		await expect
			.element(page.getByText(m.fxpc_report_item({ name }), { exact: true }))
			.toBeVisible();
	}
	await first.unmount();
	await render(PacksPanel, props);
	await expect.element(page.getByText('Pack private', { exact: true })).toBeVisible();
	expect(fetch.mock.calls.filter(([url]) => url.includes('/api/v1/me/packs'))).toHaveLength(2);
	expect(fetch.mock.calls.some(([url]) => url.includes('/api/v1/users/'))).toBe(false);
	expect(fetch.mock.calls.some(([url]) => url.includes('/api/v1/me/packs?limit=50'))).toBe(true);
});

test('a new pack defaults to private in both the form and the create request', async () => {
	const favorite = feedItem().lineage;
	const fetch = fakeFetch((url, init) => {
		if (url.pathname === '/api/v1/me/library') {
			return json({ items: [favorite], nextCursor: null });
		}
		if (url.pathname === '/api/v1/me/packs') return json({ items: [], nextCursor: null });
		if (url.pathname === '/api/v1/packs' && init.method === 'POST') {
			return json({ ...pack('pk-new', 'private'), name: 'Meu pack' }, 201);
		}
		return undefined;
	});
	await render(PacksPanel, { api: apiWith(fetch), session: VERIFIED, online: true });
	await expect.element(page.getByRole('combobox')).toHaveValue('private');
	await page.getByRole('textbox', { name: m.comunidade_packs_name() }).fill('Meu pack');
	await page.getByRole('checkbox', { name: favorite.head.name }).click();
	await page.getByRole('button', { name: m.comunidade_packs_create() }).click();
	await expect.element(page.getByText('Meu pack', { exact: true })).toBeVisible();
	const request = fetch.mock.calls.find(([, init]) => init.method === 'POST');
	expect(JSON.parse(String(request?.[1].body))).toEqual({
		name: 'Meu pack',
		description: '',
		visibility: 'private',
		items: [favorite.id]
	});
});

test('signed-out visitors do not load own packs or favorites; the action says why', async () => {
	const fetch = fakeFetch(() => undefined);
	await render(PacksPanel, { api: apiWith(fetch), session: ANONYMOUS, online: true });
	const create = page.getByRole('button', { name: m.comunidade_packs_create() });
	await expect.element(create).toHaveAttribute('aria-disabled', 'true');
	const ids = create.element().getAttribute('aria-describedby')?.split(/\s+/) ?? [];
	const reason = ids.map((value) => document.getElementById(value)?.textContent?.trim()).join(' ');
	expect(reason).toBe(m.comunidade_v2_reason_account());
	// The page's single account card explains accounts (T9): no prompt of its own here.
	expect(document.querySelector('[data-testid="login-prompt"]')).toBeNull();
	expect(fetch).not.toHaveBeenCalled();
});
