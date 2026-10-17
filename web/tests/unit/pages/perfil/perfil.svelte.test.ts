// T4.11: /u/[apelido] components (Chromium): private library (counts only), empty states,
// favorites only when present, user text rendered as text, A/B preview through the shared audio
// engine, and the filters, sort and paging helpers of the model.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { encodeS1 } from 'open-auri/share';
import type { ClientApp } from '#lib/app/client.svelte.ts';
import Perfil from '#lib/components/pages/perfil/Perfil.svelte';
import ProfileRecord from '#lib/components/pages/perfil/ProfileRecord.svelte';
import recordSource from '#lib/components/pages/perfil/ProfileRecord.svelte?raw';
import { miniCurvePath } from '#lib/charts/response.ts';
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
		.toMatchTextContent(m.fux_p9_empty_title());
	await expect
		.element(page.getByTestId('creations-empty'))
		.toMatchTextContent(m.fux_p9_empty_why());
	await expect.element(page.getByRole('button', { name: m.fux_p9_explore() })).toBeVisible();
	await expect.element(page.getByTestId('packs-empty')).toHaveTextContent(m.perfil_packs_empty());
	await expect.element(page.getByTestId('favorites-empty')).not.toBeInTheDocument();
	await expect.element(page.getByTestId('library-private')).not.toBeInTheDocument();
});

test('favorites section when the activity is public', async () => {
	await render(Perfil, {
		data: view({
			profile: { ...view().profile, activity: 'public' },
			favorites: { items: [], nextCursor: null }
		})
	});
	await expect
		.element(page.getByTestId('favorites-empty'))
		.toHaveTextContent(m.perfil_favorites_empty());
});

test('private activity hides favorites even when a payload mistakenly includes them', async () => {
	await render(Perfil, {
		data: view({
			favorites: {
				items: [{ at: 1, lineage: card({ name: 'Hidden favorite' }) }],
				nextCursor: 'private-cursor'
			}
		})
	});
	await expect.element(page.getByText('Hidden favorite')).not.toBeInTheDocument();
	await expect
		.element(page.getByRole('heading', { name: m.perfil_favorites() }))
		.not.toBeInTheDocument();
	await expect
		.element(page.getByRole('button', { name: m.perfil_load_more() }))
		.not.toBeInTheDocument();
});

test('private library never renders supplied collections or extra account fields', async () => {
	const data = {
		...view({
			profile: { ...view().profile, library: 'private', activity: 'public' },
			lineages: { items: [card({ name: 'Hidden creation' })], nextCursor: 'hidden' },
			packs: {
				items: [{ id: 'hidden', name: 'Hidden pack', description: '', createdAt: 1, updatedAt: 1 }],
				nextCursor: null
			},
			favorites: {
				items: [{ at: 1, lineage: card({ name: 'Hidden favorite' }) }],
				nextCursor: null
			}
		}),
		email: 'must-not-render@example.invalid',
		sessionToken: 'must-not-render-token'
	};
	await render(Perfil, { data });
	await expect.element(page.getByTestId('library-private')).toBeVisible();
	for (const text of [
		'Hidden creation',
		'Hidden pack',
		'Hidden favorite',
		data.email,
		data.sessionToken
	]) {
		await expect.element(page.getByText(text, { exact: true })).not.toBeInTheDocument();
	}
	await expect.element(page.getByTestId('profile-record')).not.toBeInTheDocument();
});

test('loading reserves the header and a disc grid without needing the runtime', async () => {
	await render(Perfil, { data: view(), app: null, loading: true });
	await expect.element(page.getByTestId('profile-loading')).toHaveAttribute('aria-busy', 'true');
	await expect.element(page.getByRole('heading', { level: 1 })).not.toBeInTheDocument();
	expect(document.querySelectorAll('.skeleton-header .skeleton-box')).toHaveLength(4);
	expect(document.querySelectorAll('.skeleton-disc')).toHaveLength(4);
	await expect.element(page.getByTestId('creations-empty')).not.toBeInTheDocument();
});

test('a signed record draws the real public curve on its label and links to it', async () => {
	const curve = { ...neutralCurve(), preampDb: -6 };
	const item = card({ id: 'public-record', name: 'Public record', s1: encodeS1(curve) });
	await render(ProfileRecord, { item, index: 0, locale: 'en-US', canPreview: false });
	await expect.element(page.getByTestId('profile-vinyl')).toBeVisible();
	await expect
		.element(page.getByRole('link', { name: item.name, exact: true }))
		.toHaveAttribute('href', '/c/public-record');
	await expect
		.element(page.getByRole('img', { name: m.fux_p9_curve_label({ name: item.name }) }))
		.toBeVisible();
	const decoded = previewCurve(item.s1);
	if (!decoded) throw new Error('The test curve must decode');
	expect(document.querySelector('.mini-curve svg path:last-child')?.getAttribute('d')).toBe(
		miniCurvePath(decoded, 120, 32, -15, 15)
	);
});

test('record with an invalid curve shows an honest placeholder, never a fake graph', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await render(ProfileRecord, { item: card({ s1: 'invalid' }), index: 0, locale: 'en-US' });
	await expect.element(page.getByText(m.fux_p9_curve_unavailable())).toBeVisible();
	await expect.element(page.getByRole('img')).not.toBeInTheDocument();
	await expect
		.element(page.getByRole('button', { name: m.perfil_listen_b() }))
		.not.toBeInTheDocument();
});

test('record preview uses the Button primitive and explains why it is busy', async () => {
	const onListen = vi.fn();
	await render(ProfileRecord, { item: card(), index: 0, locale: 'en-US', busy: true, onListen });
	const listen = page.getByRole('button', { name: m.perfil_listen_b() });
	await expect.element(listen).toHaveAttribute('aria-disabled', 'true');
	await expect.element(listen).toHaveAccessibleDescription(m.fux_p9_preview_busy());
	(listen.element() as HTMLElement).click();
	expect(onListen).not.toHaveBeenCalled();
});

test('record hover follows the motion preference', async () => {
	const item = card();
	await render(ProfileRecord, { item, index: 0, locale: 'en-US', canPreview: false });
	await page.getByRole('link', { name: item.name, exact: true }).hover();
	const shouldTurn =
		matchMedia('(hover: hover)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches;
	await expect
		.poll(
			() => {
				const disc = document.querySelector('.vinyl');
				if (!disc) throw new Error('Expected a vinyl disc');
				const transform = getComputedStyle(disc).transform;
				return transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).m11;
			},
			{ timeout: 5000 }
		)
		.toBeCloseTo(shouldTurn ? Math.SQRT1_2 : 1, 3);
});

test('record motion is a decorative eighth turn, not a loop, and is static under reduced motion', () => {
	expect(recordSource).toContain('transform: rotate(45deg)');
	expect(recordSource).toMatch(
		/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.sleeve:hover \.vinyl,\s*\.sleeve:focus-visible \.vinyl,\s*\.sleeve \.vinyl\s*\{\s*transition: none;\s*transform: none;/
	);
	expect(recordSource).not.toContain('@keyframes');
	expect(recordSource).not.toMatch(/animation\s*:/);
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
