import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import AccountHiddenFixture from './AccountHiddenFixture.svelte';
import { HIDDEN_STORAGE_KEY } from '#lib/social/hidden.ts';
import type { AccountProbe } from '#lib/components/chrome/account.svelte.ts';
import { m } from '#lib/paraglide/messages.js';

afterEach(async () => {
	await cleanup();
	localStorage.removeItem(HIDDEN_STORAGE_KEY);
	vi.restoreAllMocks();
});

test('failed prerender session checks retain local hides, fail closed and retry account preferences before showing sources', async () => {
	localStorage.setItem(
		HIDDEN_STORAGE_KEY,
		JSON.stringify({ authors: [], curves: ['local-blocked'] })
	);
	const probe = vi
		.fn<AccountProbe>()
		.mockResolvedValueOnce(undefined)
		.mockResolvedValue({ id: 'me', username: 'ana', emailVerified: true });
	const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(
			JSON.stringify({
				items: [
					{ targetType: 'curve', targetId: 'local-blocked', createdAt: 1 },
					{ targetType: 'curve', targetId: 'remote-blocked', createdAt: 1 }
				]
			}),
			{ headers: { 'content-type': 'application/json' } }
		)
	);
	const screen = await render(AccountHiddenFixture, { probe });
	await expect.element(page.getByRole('alert').getByText(m.hidden_error())).toBeVisible();
	expect(screen.container.querySelector('output')?.dataset.known).toBe('false');
	expect(screen.container.querySelector('output')?.dataset.curves).toBe('local-blocked');
	expect(screen.container.querySelector('[data-source]')).toBeNull();
	expect(localStorage.getItem(HIDDEN_STORAGE_KEY)).toContain('local-blocked');
	expect(fetcher).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.hidden_retry(), exact: true }).click();
	await expect.element(page.getByText('allowed', { exact: true })).toBeVisible();
	expect(probe).toHaveBeenCalledTimes(2);
	expect(screen.container.querySelector('[data-source="local-blocked"]')).toBeNull();
	expect(screen.container.querySelector('[data-source="remote-blocked"]')).toBeNull();
	expect(localStorage.getItem(HIDDEN_STORAGE_KEY)).toBeNull();
});
