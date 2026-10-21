import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import AccountHiddenFixture from './AccountHiddenFixture.svelte';
import { HIDDEN_STORAGE_KEY } from '#lib/social/hidden.ts';
import type { AccountProbe } from '#lib/components/chrome/account.svelte.ts';

afterEach(async () => {
	await cleanup();
	localStorage.removeItem(HIDDEN_STORAGE_KEY);
	vi.restoreAllMocks();
});

const hiddenResponse = (...curves: string[]) =>
	new Response(
		JSON.stringify({
			items: curves.map((targetId) => ({ targetType: 'curve', targetId, createdAt: 1 }))
		}),
		{ headers: { 'content-type': 'application/json' } }
	);

function state(container: HTMLElement) {
	const output = container.querySelector('output')!;
	return { ...output.dataset };
}

test('a failed first session check reads as a visitor: local hides apply, sources show, no alert', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	localStorage.setItem(
		HIDDEN_STORAGE_KEY,
		JSON.stringify({ authors: [], curves: ['local-blocked'] })
	);
	const probe = vi
		.fn<AccountProbe>()
		.mockResolvedValueOnce(undefined)
		.mockResolvedValue({ id: 'me', username: 'ana', emailVerified: true });
	const fetcher = vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(hiddenResponse('local-blocked', 'remote-blocked'));
	const screen = await render(AccountHiddenFixture, { probe });
	await expect.element(page.getByText('allowed', { exact: true })).toBeVisible();
	expect(state(screen.container)).toMatchObject({
		known: 'false',
		ready: 'true',
		signedIn: 'false',
		curves: 'local-blocked'
	});
	expect(screen.container.querySelector('[data-source="local-blocked"]')).toBeNull();
	expect(screen.container.querySelector('[role="alert"]')).toBeNull();
	expect(localStorage.getItem(HIDDEN_STORAGE_KEY)).toContain('local-blocked');
	expect(fetcher).not.toHaveBeenCalled();
	// The account answers later: it wins at once and the local list is merged into it.
	await page.getByTestId('probe-again').click();
	await expect.poll(() => state(screen.container).curves).toBe('local-blocked,remote-blocked');
	expect(state(screen.container)).toMatchObject({ known: 'true', ready: 'true', signedIn: 'true' });
	expect(probe).toHaveBeenCalledTimes(2);
	expect(fetcher.mock.calls[0]?.[1]?.method).toBe('PUT');
	expect(screen.container.querySelector('[data-source="remote-blocked"]')).toBeNull();
	await expect.element(page.getByText('allowed', { exact: true })).toBeVisible();
	expect(localStorage.getItem(HIDDEN_STORAGE_KEY)).toBeNull();
});

test('a known account whose probe fails is kept; another account or a sign-out answer wins at once', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const probe = vi
		.fn<AccountProbe>()
		.mockResolvedValueOnce({ id: 'me', username: 'ana', emailVerified: true })
		.mockResolvedValueOnce(undefined)
		.mockResolvedValueOnce({ id: 'zoe', username: 'zoe', emailVerified: true })
		.mockResolvedValueOnce(undefined)
		.mockResolvedValueOnce(null);
	const fetcher = vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValueOnce(hiddenResponse('remote-blocked'))
		.mockResolvedValueOnce(hiddenResponse('zoe-blocked'));
	const screen = await render(AccountHiddenFixture, { probe });
	await expect.poll(() => state(screen.container).curves).toBe('remote-blocked');
	expect(state(screen.container)).toMatchObject({ known: 'true', ready: 'true', signedIn: 'true' });

	// Offline: the account is neither purged nor turned into a visitor.
	await page.getByTestId('probe-again').click();
	await expect.poll(() => state(screen.container).known).toBe('false');
	expect(state(screen.container)).toMatchObject({
		ready: 'true',
		signedIn: 'true',
		curves: 'remote-blocked'
	});
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(screen.container.querySelector('[role="alert"]')).toBeNull();

	// A successful probe for a different account replaces it immediately.
	await page.getByTestId('probe-again').click();
	await expect.poll(() => state(screen.container).curves).toBe('zoe-blocked');
	expect(state(screen.container)).toMatchObject({ known: 'true', ready: 'true', signedIn: 'true' });
	expect(fetcher).toHaveBeenCalledTimes(2);
	await expect.element(page.getByText('remote-blocked', { exact: true })).toBeVisible();

	// Failure again (kept), then a definitive signed-out answer wins immediately.
	await page.getByTestId('probe-again').click();
	await expect.poll(() => state(screen.container).known).toBe('false');
	expect(state(screen.container)).toMatchObject({ signedIn: 'true', curves: 'zoe-blocked' });
	await page.getByTestId('probe-again').click();
	await expect.poll(() => state(screen.container).signedIn).toBe('false');
	expect(state(screen.container)).toMatchObject({ known: 'true', ready: 'true', curves: '' });
	await expect.element(page.getByText('zoe-blocked', { exact: true })).toBeVisible();
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(probe).toHaveBeenCalledTimes(5);
});
