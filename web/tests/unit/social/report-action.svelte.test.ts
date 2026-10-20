import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import ReportAction from '#lib/components/social/ReportAction.svelte';
import SocialSources from '#lib/components/pages/comparar/SocialSources.svelte';
import { createCurveSocial } from '#lib/components/pages/comparar/social.svelte.ts';
import { createSocialSession } from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import {
	ANONYMOUS,
	apiWith,
	fakeFetch,
	feedItem,
	feedPage,
	json
} from '../pages/comunidade/fixtures.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`report action is named, on-demand and sign-in gated in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const fetch = vi.spyOn(globalThis, 'fetch');
		await render(ReportAction, {
			subject: { kind: 'user', id: 'ana.public' },
			name: 'Ana',
			session: ANONYMOUS,
			siteKey: 'site-key'
		});
		expect(page.getByTestId('report-panel').elements()).toHaveLength(0);
		await page.getByText(m.fxpc_report_item({ name: 'Ana' }), { exact: true }).click();
		await expect.element(page.getByText(m.fxpc_report_account(), { exact: true })).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: m.shared_curve_login() }))
			.toHaveAttribute('href', expect.stringMatching(/^\/entrar\?next=%2F/));
		expect(document.getElementById('cf-turnstile-api')).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
}

test('comparison sources let the selected lineage be reported without loading it', async () => {
	const fetch = fakeFetch(() =>
		json(feedPage([feedItem({ id: 'lineage-id', name: 'Night radio' })]))
	);
	const api = apiWith(fetch);
	const session = createSocialSession({ initial: null });
	await render(SocialSources, {
		social: createCurveSocial(api, session),
		path: '/comparar',
		onload: vi.fn()
	});
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await page.getByRole('combobox', { name: m.curve_social_choose() }).selectOptions('lineage-id');
	await page.getByText(m.fxpc_report_item({ name: 'Night radio' }), { exact: true }).click();
	await expect.element(page.getByTestId('report-panel')).toBeVisible();
	await expect.element(page.getByText(m.fxpc_report_account(), { exact: true })).toBeVisible();
	expect(fetch).toHaveBeenCalledOnce();
});
