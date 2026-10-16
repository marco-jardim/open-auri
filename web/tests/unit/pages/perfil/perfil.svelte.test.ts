// T4.11: /u/[apelido] components (Chromium): private library (counts only), empty states,
// favorites only when present, user text rendered as text, A/B preview through the shared audio
// engine, and the filters, sort and paging helpers of the model.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { encodeS1 } from 'open-auri/share';
import type { ClientApp } from '#lib/app/client.svelte.ts';
import Perfil from '#lib/components/pages/perfil/Perfil.svelte';
import {
	mergePage,
	previewCurve,
	selectCreations,
	type LineageCard,
	type ProfileView
} from '#lib/components/pages/perfil/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { neutralCurve } from '#lib/state/model.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const S1 = encodeS1(neutralCurve());

function card(overrides: Partial<LineageCard> = {}): LineageCard {
	return {
		id: `lin-${crypto.randomUUID()}`,
		name: 'Warm vocal',
		description: 'A gentle lift.',
		license: 'CC-BY-4.0',
		lang: 'en-US',
		curveId: 'abcdefghijkl',
		s1: S1,
		levelDb: -3,
		curated: false,
		forked: false,
		author: { username: 'ana', displayUsername: 'Ana' },
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		...overrides
	};
}

function view(overrides: Partial<ProfileView> = {}): ProfileView {
	return {
		profile: {
			username: 'ana',
			displayUsername: 'Ana',
			bio: null,
			library: 'public',
			activity: 'private',
			counts: { lineages: 0, packs: 0 }
		},
		lineages: { items: [], nextCursor: null },
		packs: { items: [], nextCursor: null },
		favorites: null,
		...overrides
	};
}

function fakeApp() {
	const audio = {
		createAB: vi.fn(() => ({ dispose: vi.fn(), select: vi.fn() })),
		start: vi.fn(async () => undefined),
		stop: vi.fn(),
		state: () => ({ mode: 'chains', playing: true })
	};
	const app = { state: { curve: { current: neutralCurve() } }, audio };
	return { app: app as unknown as ClientApp, audio };
}

test('private library: nickname and counts only', async () => {
	await render(Perfil, {
		data: view({
			profile: { ...view().profile, library: 'private', counts: { lineages: 4, packs: 2 } },
			lineages: null,
			packs: null
		})
	});
	await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('Ana');
	await expect.element(page.getByTestId('library-private')).toBeVisible();
	await expect.element(page.getByText('4', { exact: true })).toBeVisible();
	await expect.element(page.getByText('2', { exact: true })).toBeVisible();
	await expect.element(page.getByTestId('creations-empty')).not.toBeInTheDocument();
	await expect.element(page.getByTestId('packs-empty')).not.toBeInTheDocument();
	await expect.element(page.getByTestId('favorites-empty')).not.toBeInTheDocument();
	expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
		'noindex'
	);
});

test('public library: empty states; favorites hidden unless given', async () => {
	await render(Perfil, { data: view() });
	await expect
		.element(page.getByTestId('creations-empty'))
		.toHaveTextContent(m.perfil_creations_empty());
	await expect.element(page.getByTestId('packs-empty')).toHaveTextContent(m.perfil_packs_empty());
	await expect.element(page.getByTestId('favorites-empty')).not.toBeInTheDocument();
	await expect.element(page.getByTestId('library-private')).not.toBeInTheDocument();
});

test('favorites section when the activity is public', async () => {
	await render(Perfil, { data: view({ favorites: { items: [], nextCursor: null } }) });
	await expect
		.element(page.getByTestId('favorites-empty'))
		.toHaveTextContent(m.perfil_favorites_empty());
});

test('renders user text as text, never as HTML', async () => {
	const hostile = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
	await render(Perfil, {
		data: view({
			profile: { ...view().profile, displayUsername: hostile, bio: hostile },
			lineages: { items: [card({ name: hostile, description: hostile })], nextCursor: null },
			packs: {
				items: [
					{ id: 'pack-12345678', name: hostile, description: hostile, createdAt: 1, updatedAt: 1 }
				],
				nextCursor: null
			}
		})
	});
	await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent(hostile);
	await expect.element(page.getByRole('heading', { level: 3 })).toHaveTextContent(hostile);
	expect(document.querySelector('img[src="x"]')).toBeNull();
	expect(document.querySelector('.room b')).toBeNull();
});

test('without the app, the strip says the preview is unavailable', async () => {
	await render(Perfil, { data: view({ lineages: { items: [card()], nextCursor: null } }) });
	await expect.element(page.getByText(m.perfil_preview_unavailable())).toBeVisible();
	await expect
		.element(page.getByRole('button', { name: m.perfil_listen_a() }))
		.not.toBeInTheDocument();
});

test('A/B preview goes through the shared audio engine and stops again', async () => {
	const { app, audio } = fakeApp();
	await render(Perfil, { data: view({ lineages: { items: [card()], nextCursor: null } }), app });
	await page.getByRole('button', { name: m.perfil_listen_b() }).click();
	await expect
		.element(page.getByRole('button', { name: m.perfil_listen_b() }))
		.toHaveAttribute('aria-pressed', 'true');
	expect(audio.createAB).toHaveBeenCalledTimes(1);
	expect(audio.start).toHaveBeenCalledWith('chains');
	await page.getByRole('button', { name: m.perfil_stop() }).click();
	await expect.poll(() => audio.stop.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
	await expect.element(page.getByRole('button', { name: m.perfil_stop() })).not.toBeInTheDocument();
});

test('filter with no match offers to clear it', async () => {
	await render(Perfil, {
		data: view({ lineages: { items: [card({ name: 'Zeta' })], nextCursor: null } })
	});
	await page.getByRole('searchbox', { name: m.perfil_filter() }).fill('nothing-like-this');
	await expect.element(page.getByRole('heading', { level: 3 })).not.toBeInTheDocument();
	await expect
		.element(page.getByTestId('creations-no-match'))
		.toHaveTextContent(m.perfil_no_match());
	await page.getByRole('button', { name: m.perfil_clear(), exact: true }).click();
	await expect.element(page.getByRole('heading', { level: 3 })).toHaveTextContent('Zeta');
});

const items = [
	card({ id: 'a', name: 'Zeta', license: 'CC0-1.0', levelDb: -6, createdAt: 3 }),
	card({ id: 'b', name: 'Água', license: 'CC-BY-4.0', levelDb: -1, createdAt: 2 }),
	card({ id: 'c', name: 'beta', license: 'CC-BY-4.0', levelDb: null, createdAt: 1 })
];

test('model: sorts by recent, name and level', () => {
	const base = { query: '', license: 'all', locale: 'pt-BR' } as const;
	const ids = (sort: 'recent' | 'name' | 'level') =>
		selectCreations(items, { ...base, sort }).map((item) => item.id);
	expect(ids('recent')).toEqual(['a', 'b', 'c']);
	expect(ids('name')).toEqual(['b', 'c', 'a']);
	expect(ids('level')).toEqual(['b', 'a', 'c']);
});

test('model: filters by accent-insensitive query and license', () => {
	const found = selectCreations(items, {
		query: 'agua',
		license: 'all',
		sort: 'recent',
		locale: 'pt-BR'
	});
	expect(found.map((item) => item.id)).toEqual(['b']);
	const cc0 = selectCreations(items, {
		query: '',
		license: 'CC0-1.0',
		sort: 'recent',
		locale: 'pt-BR'
	});
	expect(cc0.map((item) => item.id)).toEqual(['a']);
});

test('model: merges pages without repeats and refuses undecodable S1', () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	expect(mergePage([{ id: '1' }], [{ id: '1' }, { id: '2' }], (item) => item.id)).toEqual([
		{ id: '1' },
		{ id: '2' }
	]);
	expect(previewCurve('not-an-s1')).toBeNull();
	expect(previewCurve(S1)).not.toBeNull();
});
