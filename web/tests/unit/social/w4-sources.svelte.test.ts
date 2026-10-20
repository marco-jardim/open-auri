import { mount, unmount, type Component } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import { createCurveSocial } from '#lib/components/pages/comparar/social.svelte.ts';
import { createSocialSession } from '#lib/social/index.ts';
import { createHiddenStore, type HiddenStore } from '#lib/social/hidden-store.ts';
import { HIDDEN_CONTEXT } from '#lib/social/hidden-context.ts';
import { HIDDEN_STORAGE_KEY } from '#lib/social/hidden.ts';
import { ORIGINS_KEY } from '#lib/social/origins.ts';
import { m } from '#lib/paraglide/messages.js';
import { apiWith, fakeFetch, feedItem, feedPage, json } from '../pages/comunidade/fixtures.ts';

const cleanups: (() => Promise<void>)[] = [];
function show<Props extends Record<string, unknown>>(
	component: Component<Props>,
	props: Props,
	hidden: HiddenStore
) {
	const target = document.createElement('div');
	document.body.append(target);
	const instance = mount(component, {
		target,
		props,
		context: new Map([[HIDDEN_CONTEXT, hidden]])
	});
	cleanups.push(async () => {
		await unmount(instance);
		target.remove();
	});
	return target;
}
async function visitor() {
	const hidden = createHiddenStore({
		myHidden: async () => ({ items: [] }),
		putHidden: async () => ({ items: [] }),
		deleteHidden: async () => ({ items: [] })
	});
	await hidden.setUser(null);
	return hidden;
}
function sources() {
	const item = feedItem({
		id: 'night',
		name: 'Night radio',
		author: { id: 'author-id', username: 'ana', displayUsername: 'Ana' }
	});
	const second = feedItem({ id: 'dawn', name: 'Dawn radio', author: item.lineage.author });
	const fetch = fakeFetch((url) =>
		url.pathname === '/api/v1/feed'
			? json(feedPage([item, second]))
			: json({ lineage: item.lineage, version: item.lineage.head, curve: item.lineage.curve })
	);
	return { api: apiWith(fetch), fetch };
}
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	localStorage.removeItem(HIDDEN_STORAGE_KEY);
	localStorage.removeItem(ORIGINS_KEY);
	vi.restoreAllMocks();
});

for (const type of ['curve', 'author'] as const) {
	test(`comparison ${type} hiding removes source options but retains the loaded user track with a notice`, async () => {
		const hidden = await visitor();
		const { api } = sources();
		const target = show(
			CompararPage,
			{ social: createCurveSocial(api, createSocialSession({ initial: null })) },
			hidden
		);
		await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
		const choose = page.getByRole('combobox', { name: m.curve_social_choose(), exact: true });
		await choose.selectOptions('night');
		await page.getByRole('button', { name: m.curve_social_add(), exact: true }).click();
		await expect.poll(() => target.querySelector('.lanes')?.textContent).toContain('Night radio');
		await page
			.getByRole('button', {
				name:
					type === 'curve'
						? m.fxpc_hide_curve({ name: 'Night radio' })
						: m.fxpc_hide_author({ name: 'Ana', item: 'Night radio' }),
				exact: true
			})
			.click();
		await expect.element(page.getByText(m.w4_hidden_track_notice(), { exact: true })).toBeVisible();
		await expect.element(choose).toHaveValue('');
		expect(choose.element().querySelector('option[value="night"]')).toBeNull();
		expect(choose.element().querySelector('option[value="dawn"]') === null).toBe(type === 'author');
		expect(target.querySelector('.lanes')?.textContent).toContain('Night radio');
		expect(
			target.querySelector<HTMLOptionElement>('#comparar-source-1 option[value="community:night"]')
				?.disabled
		).toBe(true);
	});
}

test('hiding an already-added blind candidate removes it from selection and source offers', async () => {
	const hidden = await visitor();
	const { api } = sources();
	show(BlindTest, { api, reducedMotion: true }, hidden);
	await page.getByRole('tab', { name: /Candidatos/ }).click();
	await page.getByRole('button', { name: m.cegocom_load(), exact: true }).click();
	await page
		.getByRole('button', { name: m.cegocom_add_label({ name: 'Night radio' }), exact: true })
		.click();
	const candidate = page.getByRole('checkbox', { name: /^Night radio/ });
	await expect.element(candidate).toBeVisible();
	await candidate.click();
	await page
		.getByRole('button', {
			name: m.fxpc_hide_author({ name: 'Ana', item: 'Night radio' }),
			exact: true
		})
		.click();
	await expect.element(candidate).not.toBeInTheDocument();
	expect(
		page
			.getByRole('button', { name: m.cegocom_add_label({ name: 'Night radio' }), exact: true })
			.elements()
	).toHaveLength(0);
	expect(
		page
			.getByRole('button', { name: m.cegocom_add_label({ name: 'Dawn radio' }), exact: true })
			.elements()
	).toHaveLength(0);
});
