import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import Footer from '#lib/components/chrome/Footer.svelte';
import { m } from '#lib/paraglide/messages.js';

afterEach(async () => {
	await cleanup();
});

test('footer accepts a repository override and updates an empty sources list without stale links', async () => {
	const honoree = {
		name: 'Test honoree',
		years: '1900–2000',
		curiosity: 'A sourced fact.',
		sources: []
	};
	const screen = await render(Footer, { honoree, githubUrl: 'https://example.org/source' });
	const sources = page.getByRole('list', { name: m.chrome_sources() });
	await expect.element(sources).toBeInTheDocument();
	expect(sources.element().children).toHaveLength(0);
	await expect
		.element(page.getByRole('link', { name: m.chrome_github_link() }))
		.toHaveAttribute('href', 'https://example.org/source');
	await screen.rerender({
		honoree: {
			...honoree,
			sources: [
				{ label: 'First source', href: 'https://example.org/one' },
				{ label: 'Second source', href: 'https://example.org/two' }
			]
		}
	});
	for (const name of ['First source ↗', 'Second source ↗']) {
		const link = page.getByRole('link', { name });
		await expect.element(link).toHaveAttribute('target', '_blank');
		await expect.element(link).toHaveAttribute('rel', 'noreferrer');
	}
	await screen.rerender({ honoree });
	expect(sources.element().children).toHaveLength(0);
	expect(page.getByRole('link', { name: 'First source ↗' }).elements()).toHaveLength(0);
});
