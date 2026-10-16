import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import PolicyBanner from '#lib/components/legal/PolicyBanner.svelte';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';
import { m } from '#lib/paraglide/messages.js';

afterEach(async () => {
	await cleanup();
});

const accept = () => page.getByRole('button', { name: m.legal_banner_accept() });
const region = () => page.getByRole('region', { name: m.legal_banner_title() });

test('hidden when the stored version is the current one', async () => {
	const onAccept = vi.fn();
	const screen = await render(PolicyBanner, { seenVersion: POLICY_VERSION, onAccept });
	expect(screen.container.querySelector('section')).toBeNull();
	expect(onAccept).not.toHaveBeenCalled();
});

test('shows for an older version, links to both texts and hides after accepting', async () => {
	const onAccept = vi.fn();
	await render(PolicyBanner, { seenVersion: '2020-01-01', onAccept });
	await expect.element(region()).toBeVisible();
	await expect.element(region()).toHaveAttribute('data-policy-version', POLICY_VERSION);
	await expect
		.element(page.getByText(m.legal_banner_body({ version: POLICY_VERSION })))
		.toBeVisible();
	await expect
		.element(page.getByRole('link', { name: m.legal_banner_privacy() }))
		.toHaveAttribute('href', '/privacidade');
	await expect
		.element(page.getByRole('link', { name: m.legal_banner_terms() }))
		.toHaveAttribute('href', '/termos');
	await accept().click();
	expect(onAccept).toHaveBeenCalledExactlyOnceWith(POLICY_VERSION);
	await expect.element(region()).not.toBeInTheDocument();
});

test('a null seen version (account without a record) shows the banner', async () => {
	await render(PolicyBanner, { version: '2027-01-01', seenVersion: null, onAccept: vi.fn() });
	await expect.element(region()).toBeVisible();
	const body = page.getByText(m.legal_banner_body({ version: '2027-01-01' }));
	await expect.element(body).toBeVisible();
});

test('a failed save keeps the banner, announces the error and allows a retry', async () => {
	let attempts = 0;
	let release: () => void = () => undefined;
	const onAccept = vi.fn(() => {
		attempts += 1;
		if (attempts === 1) return Promise.reject(new Error('offline'));
		return new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	await render(PolicyBanner, { seenVersion: '2020-01-01', onAccept });
	await accept().click();
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.legal_banner_error());
	await expect.element(region()).toBeVisible();

	await accept().click();
	const busy = page.getByRole('button', { name: m.legal_banner_busy() });
	await expect.element(busy).toBeDisabled();
	await expect.element(busy).toHaveAttribute('aria-busy', 'true');
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	release();
	await expect.element(region()).not.toBeInTheDocument();
	expect(onAccept).toHaveBeenCalledTimes(2);
});

test('the accept button works from the keyboard and meets the 24 px target size', async () => {
	const onAccept = vi.fn();
	await render(PolicyBanner, { seenVersion: '2020-01-01', onAccept });
	const button = accept().element() as HTMLButtonElement;
	button.focus();
	expect(document.activeElement).toBe(button);
	expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
	await userEvent.keyboard('{Enter}');
	await expect.element(region()).not.toBeInTheDocument();
	expect(onAccept).toHaveBeenCalledExactlyOnceWith(POLICY_VERSION);
});
