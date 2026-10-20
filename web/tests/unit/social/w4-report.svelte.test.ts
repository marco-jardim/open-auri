import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import Perfil from '#lib/components/pages/perfil/Perfil.svelte';
import ReportAction from '#lib/components/social/ReportAction.svelte';
import ReportPanel from '#lib/components/pages/comunidade/ReportPanel.svelte';
import type { ProfileView, LineageCard } from '#lib/components/pages/perfil/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { ANONYMOUS, VERIFIED, apiWith, fakeFetch, S1_NEUTRAL } from '../pages/comunidade/fixtures.ts';

vi.mock('$app/state', async (original) => {
	const module = await original<typeof import('$app/state')>();
	return { ...module, page: { ...module.page, data: { user: { id: 'me', username: 'Ana', emailVerified: true } }, url: new URL('https://example.test/u/ana?tab=favorites#saved') } };
});

afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });

const creation: LineageCard = {
	id: 'my-curve', name: 'My creation', description: '', license: 'CC0-1.0', lang: 'pt-BR',
	curveId: 'c1', s1: S1_NEUTRAL, levelDb: -1, curated: false, forked: false,
	author: { id: 'me-public', username: 'ana', displayUsername: 'Ana' }, createdAt: 1, updatedAt: 1
};

test('owners see no Report on their profile, packs or creations, but favorites link and report the other author', async () => {
	const data: ProfileView = {
		profile: { authorId: 'me-public', username: 'ana', displayUsername: 'Ana', bio: null, library: 'public', activity: 'public', counts: { lineages: 1, packs: 1 } },
		lineages: { items: [creation], nextCursor: null },
		packs: { items: [{ id: 'my-pack', name: 'My pack', description: '', createdAt: 1, updatedAt: 1 }], nextCursor: null },
		favorites: { items: [{ at: 1, lineage: { ...creation, id: 'other-curve', name: 'Other favorite', author: { id: 'zoe-public', username: 'zoe', displayUsername: 'Zoë' } } }], nextCursor: null }
	};
	await render(Perfil, { data });
	await expect.element(page.getByRole('link', { name: 'Other favorite', exact: true })).toHaveAttribute('href', '/c/other-curve');
	await expect.element(page.getByRole('link', { name: 'Zoë', exact: true })).toHaveAttribute('href', '/u/zoe');
	await expect.element(page.getByText(m.fxpc_report_item({ name: 'Other favorite' }), { exact: true })).toBeVisible();
	await expect.element(page.getByRole('button', { name: m.fxpc_hide_curve({ name: 'Other favorite' }), exact: true })).toBeVisible();
	for (const name of ['Ana', 'My pack', 'My creation'])
		expect(page.getByText(m.fxpc_report_item({ name }), { exact: true }).elements()).toHaveLength(0);
});

for (const kind of ['lineage', 'pack', 'user'] as const) {
	test(`ReportAction hides the owner's ${kind} using case-insensitive public usernames`, async () => {
		const screen = await render(ReportAction, {
			subject: { kind, id: kind === 'user' ? 'ANA' : 'opaque-id' }, author: 'ANA', name: 'Mine', session: { ...VERIFIED, nickname: 'ana' }
		});
		expect(screen.container.querySelector('details')).toBeNull();
	});
}

test('ReportPanel sign-in returns to the current path, query and fragment', async () => {
	await render(ReportPanel, { api: apiWith(fakeFetch(() => undefined)), session: ANONYMOUS, subject: { kind: 'lineage', id: 'curve' }, siteKey: '', online: true });
	await expect.element(page.getByRole('link', { name: m.shared_curve_login(), exact: true })).toHaveAttribute('href', '/entrar?next=%2Fu%2Fana%3Ftab%3Dfavorites%23saved');
});
