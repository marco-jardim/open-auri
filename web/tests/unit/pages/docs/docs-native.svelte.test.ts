import { mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import DocsPage from '#lib/components/pages/docs/DocsPage.svelte';
import { docsContent } from '#lib/content/docs/index.ts';
import { docsUi } from '#lib/components/pages/docs/ui.ts';
import { setLocale } from '#lib/paraglide/runtime.js';
import { NATIVE_CABLE_CONTEXT } from '#lib/app/context.svelte.ts';
import { ANDROID_PLAY_URL, ANDROID_RELEASES_URL } from '#lib/cable/android-links.ts';

afterEach(async () => {
	await cleanup();
	vi.unstubAllGlobals();
	await setLocale('pt-BR', { reload: false });
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`native docs never render or index APK downloads; browser docs keep them (${locale})`, async () => {
		await setLocale(locale, { reload: false });
		const content = docsContent(locale);
		const ui = docsUi();
		const target = document.createElement('div');
		document.body.append(target);
		// Deliberately use the detection state, not a UA or Play-live flag.
		const instance = mount(DocsPage, {
			target,
			context: new Map([
				[NATIVE_CABLE_CONTEXT, { result: { kind: 'native-outdated', appVersion: '0.9' } }]
			]),
			props: { content, ui, githubUrl: 'https://example.test/source' }
		});
		try {
			await expect
				.poll(() => target.querySelector('#android a[href^="https://"]')?.getAttribute('href'))
				.toBe(ANDROID_PLAY_URL);
			expect(target.querySelector(`a[href="${ANDROID_RELEASES_URL}"]`)).toBeNull();
			expect(target.querySelector('#android')?.textContent).not.toContain('GitHub Releases');
			expect(target.querySelector('#android-assinatura')?.textContent).not.toContain('apksigner');
			await page.getByRole('button', { name: ui.search, exact: true }).click();
			await page.getByRole('searchbox', { name: ui.searchInput }).fill('apksigner');
			await expect.element(page.getByText(ui.noResults, { exact: true })).toBeVisible();
		} finally {
			await unmount(instance);
			target.remove();
		}
		const browser = await render(DocsPage, {
			content,
			ui,
			githubUrl: 'https://example.test/source'
		});
		expect(browser.container.querySelector(`a[href="${ANDROID_RELEASES_URL}"]`)).not.toBeNull();
	});
}

test('synchronous Capacitor detection hides APK links before native detection finishes', async () => {
	vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
	const screen = await render(DocsPage, {
		content: docsContent('pt-BR'),
		ui: docsUi(),
		githubUrl: 'https://example.test/source'
	});
	expect(screen.container.querySelector(`a[href="${ANDROID_RELEASES_URL}"]`)).toBeNull();
});
