import { mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import DocsPage from '#lib/components/pages/docs/DocsPage.svelte';
import EnvironmentExtras from '#lib/components/pages/docs/EnvironmentExtras.svelte';
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
			expect(target.querySelector<HTMLElement>('#android')?.innerText).not.toContain(
				'GitHub Releases'
			);
			expect(target.querySelector<HTMLElement>('#android-assinatura')?.innerText).not.toContain(
				'apksigner'
			);
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

for (const inApp of [false, true]) {
	for (const part of ['paragraphs', 'links'] as const) {
		test(`docs environment ${part} slots reserve their prerender size without APK links before hydration (app=${inApp})`, async () => {
			const section = docsContent('pt-BR').sections.find((item) => item.id === 'android')!;
			const props = { section, inApp, hydrated: false, part };
			const screen = await render(EnvironmentExtras, props);
			const slot = screen.container.querySelector('.environment-extras')!;
			const before = slot.getBoundingClientRect().height;
			expect(screen.container.querySelector('a')).toBeNull();
			expect(before).toBeGreaterThan(0);
			await screen.rerender({ hydrated: true });
			expect(slot.getBoundingClientRect().height).toBe(before);
			// Only the links part renders links; the APK link only outside the app.
			expect(screen.container.querySelector(`a[href="${ANDROID_RELEASES_URL}"]`) !== null).toBe(
				part === 'links' && !inApp
			);
			if (part === 'paragraphs') expect(screen.container.querySelector('a, span')).toBeNull();
			await screen.rerender({ inApp: !inApp });
			expect(slot.getBoundingClientRect().height).toBe(before);
		});
	}
}

test('docs extras render inside the chapter columns and the links row, never as a separate block', async () => {
	const screen = await render(DocsPage, {
		content: docsContent('pt-BR'),
		ui: docsUi(),
		githubUrl: 'https://example.test/source'
	});
	const android = screen.container.querySelector('#android')!;
	await expect
		.poll(() => android.querySelector(`a[href="${ANDROID_RELEASES_URL}"]`))
		.not.toBeNull();
	const paragraphs = android.querySelector('.environment-extras:not(.links)')!;
	expect(paragraphs.parentElement?.classList.contains('columns')).toBe(true);
	const link = android.querySelector(`a[href="${ANDROID_RELEASES_URL}"]`)!;
	expect(link.closest('.environment-extras')?.classList.contains('links')).toBe(true);
	// The links row uses the same type as the chapter's own links row.
	const own = screen.container.querySelector('#android-validacao .links')!;
	expect(getComputedStyle(link).fontSize).toBe(getComputedStyle(own).fontSize);
	expect(getComputedStyle(link).fontFamily).toBe(getComputedStyle(own).fontFamily);
});

test('in the app, an empty app variant collapses the space reserved by browser-only text', async () => {
	const section = docsContent('pt-BR').sections.find((item) => item.id === 'android-assinatura')!;
	expect(section.appOnly).toBeUndefined();
	for (const part of ['paragraphs', 'links'] as const) {
		const screen = await render(EnvironmentExtras, {
			section,
			inApp: true,
			hydrated: false,
			part
		});
		// Before hydration the environment is unknown: the browser text still sizes the slot.
		const slot = screen.container.querySelector('.environment-extras');
		expect(slot?.getBoundingClientRect().height).toBeGreaterThan(0);
		await screen.rerender({ hydrated: true });
		expect(screen.container.querySelector('.environment-extras')).toBeNull();
		expect(screen.container.textContent).not.toContain('apksigner');
		// In the browser the same slot keeps (and shows) its text.
		await screen.rerender({ inApp: false });
		const height = () =>
			screen.container.querySelector('.environment-extras')?.getBoundingClientRect().height ?? 0;
		await expect.poll(height).toBeGreaterThan(0);
		await cleanup();
	}
});
