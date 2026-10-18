// T4.11: /u/[apelido] components (Chromium): private library (counts only), empty states,
// favorites only when present, user text rendered as text, A/B preview through the shared audio
// engine, and the filters, sort and paging helpers of the model.
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { encodeS1 } from 'open-auri/share';
import type { ClientApp } from '#lib/app/client.svelte.ts';
import {
	IDLE_STATE,
	type AudioEngineState,
	type PlayMode,
	type StartOptions
} from '#lib/audio/engine.ts';
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
import { setLocale } from '#lib/paraglide/runtime.js';
import { neutralCurve } from '#lib/state/model.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
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

/** A stateful fake engine: sessions, pause and resume as the SEEK.1 transport reports them. */
function fakeApp(currentCurve: ReturnType<typeof neutralCurve> | null = neutralCurve()) {
	let current: AudioEngineState = { ...IDLE_STATE };
	const listeners = new Set<(state: AudioEngineState) => void>();
	const set = (next: Partial<AudioEngineState>) => {
		current = { ...current, ...next };
		for (const listener of listeners) listener(current);
	};
	const audio = {
		createAB: vi.fn(() => ({ dispose: vi.fn(), select: vi.fn() })),
		start: vi.fn(async (mode: PlayMode = 'chains', options: StartOptions = {}) => {
			set({ mode, playing: true, paused: false, session: options.session ?? null });
		}),
		stop: vi.fn(() => set({ mode: 'off', playing: false, paused: false, session: null })),
		pause: vi.fn(() => set({ mode: 'off', playing: false, paused: true })),
		resume: vi.fn(async () => {
			set({ mode: 'chains', playing: true, paused: false });
			return true;
		}),
		seek: vi.fn(() => false),
		restart: vi.fn(() => false),
		// The Transport warms the engine on press; a running context needs nothing more.
		getContext: () => ({ state: 'running', resume: async () => undefined }),
		state: () => current,
		onChange: (listener: (state: AudioEngineState) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
	const app = { state: { curve: { current: currentCurve } }, audio };
	return { app: app as unknown as ClientApp, audio, set };
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
	// A comparison starts at a random point of the file (SEEK.2), tagged with the page session.
	expect(audio.start).toHaveBeenCalledWith('chains', { startAt: 'random', session: 'perfil' });
	await page.getByRole('button', { name: m.perfil_stop() }).click();
	await expect.poll(() => audio.stop.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0);
	await expect.element(page.getByRole('button', { name: m.perfil_stop() })).not.toBeInTheDocument();
});

test('the Transport renders; its pause keeps the comparison and a listen key continues it', async () => {
	const { app, audio } = fakeApp();
	await render(Perfil, { data: view({ lineages: { items: [card()], nextCursor: null } }), app });
	const transport = page.getByRole('group', { name: m.transport_group() });
	await expect.element(transport).toBeVisible();
	await expect
		.element(transport.getByRole('slider', { name: m.transport_seek() }))
		.toBeInTheDocument();
	await page.getByRole('button', { name: m.perfil_listen_b() }).click();
	await expect.poll(() => audio.start.mock.calls.length).toBe(1);
	await transport.getByRole('button', { name: m.transport_pause(), exact: true }).click();
	expect(audio.pause).toHaveBeenCalledOnce();
	expect(audio.stop).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ paused: true, session: 'perfil' });
	// The Transport continues the paused Perfil session; no new A/B, no new random point.
	await transport.getByRole('button', { name: m.transport_resume(), exact: true }).click();
	await expect.poll(() => audio.resume.mock.calls.length).toBe(1);
	expect(audio.createAB).toHaveBeenCalledOnce();
	expect(audio.start).toHaveBeenCalledOnce();
});

test('another session taking the engine ends the comparison: "Parar" goes and the A/B is disposed', async () => {
	const { app, audio } = fakeApp();
	await render(Perfil, { data: view({ lineages: { items: [card()], nextCursor: null } }), app });
	await page.getByRole('button', { name: m.perfil_listen_b() }).click();
	await expect.element(page.getByRole('button', { name: m.perfil_stop() })).toBeVisible();
	const chains = audio.createAB.mock.results[0]?.value;
	if (!chains) throw new Error('Missing A/B preview');

	// A pause from the Transport or the navbar keeps the comparison (same session).
	audio.pause();
	await expect.element(page.getByRole('button', { name: m.perfil_stop() })).toBeVisible();
	expect(chains.dispose).not.toHaveBeenCalled();

	// Another page starts its own session: no longer this page's to show or to stop.
	await audio.start('raw', { session: 'audio-panel' });
	await expect.element(page.getByRole('button', { name: m.perfil_stop() })).not.toBeInTheDocument();
	await expect
		.element(page.getByRole('button', { name: m.perfil_listen_b() }))
		.toHaveAttribute('aria-pressed', 'false');
	expect(chains.dispose).toHaveBeenCalledOnce();
	// The other session keeps playing: this page never stops what it did not start.
	expect(audio.stop).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ playing: true, session: 'audio-panel' });

	// Released for good: later engine changes do not touch this page again.
	audio.stop();
	expect(chains.dispose).toHaveBeenCalledOnce();
});

test('a stop from elsewhere (navbar) also releases the comparison and its chains', async () => {
	const { app, audio } = fakeApp();
	await render(Perfil, { data: view({ lineages: { items: [card()], nextCursor: null } }), app });
	await page.getByRole('button', { name: m.perfil_listen_a() }).click();
	await expect.element(page.getByRole('button', { name: m.perfil_stop() })).toBeVisible();
	const chains = audio.createAB.mock.results[0]?.value;
	if (!chains) throw new Error('Missing A/B preview');
	audio.stop();
	await expect.element(page.getByRole('button', { name: m.perfil_stop() })).not.toBeInTheDocument();
	expect(chains.dispose).toHaveBeenCalledOnce();
	expect(audio.stop).toHaveBeenCalledOnce();
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

for (const list of ['lineages', 'packs', 'favorites'] as const) {
	test(`${list}: pagination encodes the request, merges duplicates and exhausts the cursor`, async () => {
		const first = card({ id: 'first', name: 'First creation' });
		const second = card({ id: 'second', name: 'Second creation', author: null });
		const firstPack = {
			id: 'pack1',
			name: 'First pack',
			description: '',
			createdAt: 0,
			updatedAt: 0
		};
		const secondPack = {
			...firstPack,
			id: 'pack2',
			name: 'Second pack',
			description: 'Pack notes'
		};
		const data = view({
			profile: { ...view().profile, username: 'ana space', activity: 'public' },
			lineages: { items: [first], nextCursor: list === 'lineages' ? 'next +/&' : null },
			packs: { items: [firstPack], nextCursor: list === 'packs' ? 'next +/&' : null },
			favorites: {
				items: [{ at: 0, lineage: first }],
				nextCursor: list === 'favorites' ? 'next +/&' : null
			}
		});
		const items =
			list === 'lineages'
				? [first, second]
				: list === 'packs'
					? [firstPack, secondPack]
					: [
							{ at: 0, lineage: first },
							{ at: 1, lineage: second }
						];
		const pending = deferred<Response>();
		const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise);
		const screen = await render(Perfil, { data });
		const more = page.getByRole('button', { name: m.perfil_load_more(), exact: true });
		await more.click();
		await expect.element(more).toHaveAttribute('aria-busy', 'true');
		(more.element() as HTMLElement).click();
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		const requested = new URL(String(url), 'https://example.test');
		expect(requested.pathname).toBe('/api/v1/users/ana%20space');
		expect(Object.fromEntries(requested.searchParams)).toEqual({ list, cursor: 'next +/&' });
		expect(init?.headers).toEqual({ accept: 'application/json' });
		pending.resolve(new Response(JSON.stringify({ items, nextCursor: null })));
		await expect.element(more).not.toBeInTheDocument();
		const collection = screen.container.querySelector(
			list === 'lineages' ? '.collection' : `.${list}`
		);
		expect(
			collection?.querySelectorAll(list === 'lineages' ? '[data-testid="profile-record"]' : 'li')
		).toHaveLength(2);
		expect(collection?.textContent).toContain(list === 'packs' ? secondPack.name : second.name);
		if (list === 'packs') expect(collection?.textContent).toContain('Pack notes');
		if (list === 'favorites') expect(collection?.textContent).toContain('Ana');
	});

	test(`${list}: a page arriving after a profile change cannot repopulate the old collection`, async () => {
		const pending = deferred<Response>();
		vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise);
		const data = view({
			profile: { ...view().profile, activity: 'public' },
			[list]: { items: [], nextCursor: 'old' }
		});
		const screen = await render(Perfil, { data });
		await page.getByRole('button', { name: m.perfil_load_more() }).click();
		await screen.rerender({
			data: view({ profile: { ...view().profile, username: 'bia', displayUsername: 'Bia' } })
		});
		pending.resolve(new Response(JSON.stringify({ items: [], nextCursor: 'stale' })));
		await pending.promise;
		await tick();
		await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('Bia');
		await expect
			.element(page.getByRole('button', { name: m.perfil_load_more() }))
			.not.toBeInTheDocument();
	});
}

for (const failure of ['http', 'network', 'unknown'] as const) {
	test(`pagination ${failure} failure is announced and the same cursor can be retried`, async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fetch = vi.spyOn(globalThis, 'fetch');
		if (failure === 'http') fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
		else fetch.mockRejectedValueOnce(failure === 'network' ? new Error('offline') : 'offline');
		fetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ items: [card({ name: 'Recovered' })], nextCursor: null }))
		);
		const screen = await render(Perfil, {
			data: view({ lineages: { items: [], nextCursor: 'retry' } })
		});
		const more = page.getByRole('button', { name: m.perfil_load_more() });
		await more.click();
		// The failure is announced in the page's `role="status"` live region (Perfil.svelte:428).
		await expect.element(page.getByRole('status')).toHaveTextContent(m.perfil_load_error());
		await expect.element(more).not.toHaveAttribute('aria-busy', 'true');
		await more.click();
		await expect.element(page.getByRole('heading', { level: 3 })).toHaveTextContent('Recovered');
		// A new request clears the notice (Perfil.svelte:185). The empty region stays in the DOM
		// but is `display: none` (`.notice:empty`, Perfil.svelte:591), so it leaves the
		// accessibility tree rather than announcing an empty string.
		const notice = screen.container.querySelector<HTMLElement>('.room > .notice[role="status"]');
		expect(notice).not.toBeNull();
		await expect.poll(() => notice?.textContent).toBe('');
		expect(page.getByRole('status').query()).toBeNull();
		expect(page.getByText(m.perfil_load_error()).query()).toBeNull();
		expect(fetch.mock.calls[1]?.[0]).toBe(fetch.mock.calls[0]?.[0]);
	});
}

test('a rejected old profile request does not announce an error on the new private profile', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const pending = deferred<Response>();
	vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise);
	const screen = await render(Perfil, { data: view({ packs: { items: [], nextCursor: 'old' } }) });
	await page.getByRole('button', { name: m.perfil_load_more() }).click();
	await screen.rerender({
		data: view({ profile: { ...view().profile, library: 'private' }, lineages: null, packs: null })
	});
	pending.reject('late failure');
	await pending.promise.catch(() => undefined);
	await tick();
	await expect.element(page.getByTestId('library-private')).toBeVisible();
	// The stale rejection is dropped (Perfil.svelte:204 checks `data === requestedView`): the
	// notice region stays empty, hence `display: none` and outside the accessibility tree.
	const notice = screen.container.querySelector<HTMLElement>('.room > .notice[role="status"]');
	expect(notice).not.toBeNull();
	expect(notice?.textContent).toBe('');
	expect(page.getByRole('status').query()).toBeNull();
	expect(page.getByText(m.perfil_load_error()).query()).toBeNull();
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`profile controls apply license, name and level ordering in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		await render(Perfil, {
			data: view({ lineages: { items, nextCursor: null }, packs: null, favorites: null })
		});
		const names = () =>
			[...document.querySelectorAll('[data-testid="profile-record"] h3')].map(
				(node) => node.textContent
			);
		await userEvent.selectOptions(page.getByRole('combobox', { name: m.perfil_sort() }), 'name');
		await expect.poll(names).toEqual(['Água', 'beta', 'Zeta']);
		await userEvent.selectOptions(page.getByRole('combobox', { name: m.perfil_sort() }), 'level');
		await expect.poll(names).toEqual(['Água', 'Zeta', 'beta']);
		await userEvent.selectOptions(
			page.getByRole('combobox', { name: m.perfil_license(), exact: true }),
			'CC0-1.0'
		);
		await expect.poll(names).toEqual(['Zeta']);
		await page.getByRole('searchbox', { name: m.perfil_filter() }).fill('Água');
		await expect.element(page.getByTestId('creations-no-match')).toBeVisible();
		await page.getByRole('button', { name: m.perfil_clear(), exact: true }).click();
		await expect.poll(names).toEqual(['Água', 'Zeta', 'beta']);
		await expect
			.element(page.getByRole('combobox', { name: m.perfil_license(), exact: true }))
			.toHaveValue('all');
	});
}

test('switching sides reuses a playing comparison and resumes a paused one', async () => {
	const { app, audio } = fakeApp(null);
	await render(Perfil, { data: view({ lineages: { items: [card()], nextCursor: null } }), app });
	await page.getByRole('button', { name: m.perfil_listen_b() }).click();
	await page.getByRole('button', { name: m.perfil_listen_a() }).click();
	const preview = audio.createAB.mock.results[0].value;
	expect(preview.select).toHaveBeenLastCalledWith('A');
	expect(audio.resume).not.toHaveBeenCalled();
	audio.pause();
	await page.getByRole('button', { name: m.perfil_listen_b() }).click();
	expect(preview.select).toHaveBeenLastCalledWith('B');
	expect(audio.resume).toHaveBeenCalledOnce();
	expect(audio.createAB).toHaveBeenCalledOnce();
	expect(audio.start).toHaveBeenCalledOnce();
	expect(audio.createAB.mock.calls[0]).toEqual([
		neutralCurve(),
		previewCurve(S1),
		{ experimental: true, initial: 'B' }
	]);
});

for (const reason of [new Error('resume refused'), 'resume refused']) {
	test(`a failed resume (${typeof reason}) keeps the comparison retryable`, async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { app, audio } = fakeApp();
		await render(Perfil, { data: view({ lineages: { items: [card()], nextCursor: null } }), app });
		await page.getByRole('button', { name: m.perfil_listen_a() }).click();
		audio.pause();
		audio.resume.mockRejectedValueOnce(reason);
		await page.getByRole('button', { name: m.perfil_listen_b() }).click();
		await expect.element(page.getByRole('status')).toHaveTextContent(m.perfil_audio_error());
		await expect.element(page.getByRole('button', { name: m.perfil_stop() })).toBeVisible();
		await page.getByRole('button', { name: m.perfil_listen_a() }).click();
		expect(audio.resume).toHaveBeenCalledTimes(2);
		expect(audio.createAB).toHaveBeenCalledOnce();
	});
}

for (const reason of [new Error('start refused'), 'start refused']) {
	test(`a failed start (${typeof reason}) disposes the preview and permits a new attempt`, async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { app, audio } = fakeApp();
		audio.start.mockRejectedValueOnce(reason);
		await render(Perfil, { data: view({ lineages: { items: [card()], nextCursor: null } }), app });
		await page.getByRole('button', { name: m.perfil_listen_a() }).click();
		await expect.element(page.getByRole('status')).toHaveTextContent(m.perfil_audio_error());
		expect(audio.createAB.mock.results[0].value.dispose).toHaveBeenCalledOnce();
		await expect
			.element(page.getByRole('button', { name: m.perfil_stop() }))
			.not.toBeInTheDocument();
		await page.getByRole('button', { name: m.perfil_listen_b() }).click();
		await expect.element(page.getByRole('button', { name: m.perfil_stop() })).toBeVisible();
		expect(audio.start).toHaveBeenCalledTimes(2);
	});
}

test('changing profile while audio starts cancels selection and stops only a late owned session', async () => {
	const { app, audio, set } = fakeApp();
	const pending = deferred<void>();
	audio.start.mockImplementationOnce(async () => {
		await pending.promise;
		set({ session: 'perfil', mode: 'chains', playing: true });
	});
	const screen = await render(Perfil, {
		data: view({ lineages: { items: [card()], nextCursor: null } }),
		app
	});
	await page.getByRole('button', { name: m.perfil_listen_a() }).click();
	await expect
		.element(page.getByRole('button', { name: m.perfil_listen_b() }))
		.toHaveAttribute('aria-disabled', 'true');
	await screen.rerender({ data: view() });
	pending.resolve();
	await expect.poll(() => audio.stop.mock.calls.length).toBe(1);
	expect(audio.createAB.mock.results[0].value.dispose).toHaveBeenCalledOnce();
	await expect.element(page.getByTestId('creations-empty')).toBeVisible();
});

test('an engine claimed before subscription is left playing without a selected record', async () => {
	const { app, audio, set } = fakeApp();
	audio.start.mockImplementationOnce(async () =>
		set({ session: 'other', mode: 'raw', playing: true })
	);
	await render(Perfil, { data: view({ lineages: { items: [card()], nextCursor: null } }), app });
	await page.getByRole('button', { name: m.perfil_listen_a() }).click();
	await expect.element(page.getByRole('button', { name: m.perfil_stop() })).not.toBeInTheDocument();
	expect(audio.stop).not.toHaveBeenCalled();
	expect(audio.createAB.mock.results[0].value.dispose).toHaveBeenCalledOnce();
});

test('public profiles with omitted collections use empty shelves but never invent public activity', async () => {
	await render(Perfil, {
		data: view({
			profile: { ...view().profile, activity: 'public' },
			lineages: null,
			packs: null,
			favorites: null
		})
	});
	await expect.element(page.getByTestId('creations-empty')).toBeVisible();
	await expect.element(page.getByTestId('packs-empty')).toBeVisible();
	await expect
		.element(page.getByRole('heading', { name: m.perfil_favorites() }))
		.not.toBeInTheDocument();
	await expect
		.element(page.getByRole('button', { name: m.perfil_load_more() }))
		.not.toBeInTheDocument();
});

test('selecting another record releases the previous chains and unmount releases a paused comparison', async () => {
	const { app, audio } = fakeApp();
	const screen = await render(Perfil, {
		data: view({
			lineages: {
				items: [card({ id: 'one', name: 'One' }), card({ id: 'two', name: 'Two' })],
				nextCursor: null
			}
		}),
		app
	});
	await page.getByRole('button', { name: m.perfil_listen_a() }).nth(0).click();
	const previous = audio.createAB.mock.results[0].value;
	await page.getByRole('button', { name: m.perfil_listen_b() }).nth(1).click();
	expect(previous.dispose).toHaveBeenCalledOnce();
	expect(audio.stop).toHaveBeenCalledOnce();
	expect(audio.createAB).toHaveBeenCalledTimes(2);
	await expect
		.element(page.getByRole('button', { name: m.perfil_listen_a() }).nth(0))
		.toHaveAttribute('aria-pressed', 'false');
	await expect
		.element(page.getByRole('button', { name: m.perfil_listen_b() }).nth(1))
		.toHaveAttribute('aria-pressed', 'true');
	audio.pause();
	await screen.unmount();
	expect(audio.stop).toHaveBeenCalledTimes(2);
	expect(audio.createAB.mock.results[1].value.dispose).toHaveBeenCalledOnce();
});

test('a cancelled start which finishes in another session never stops that other session', async () => {
	const { app, audio, set } = fakeApp();
	const pending = deferred<void>();
	audio.start.mockImplementationOnce(async () => {
		await pending.promise;
		set({ session: 'other-page', mode: 'raw', playing: true });
	});
	const screen = await render(Perfil, {
		data: view({ lineages: { items: [card()], nextCursor: null } }),
		app
	});
	await page.getByRole('button', { name: m.perfil_listen_b() }).click();
	await screen.rerender({ data: view() });
	pending.resolve();
	await pending.promise;
	await tick();
	expect(audio.stop).not.toHaveBeenCalled();
	expect(audio.state()).toMatchObject({ session: 'other-page', playing: true });
	expect(audio.createAB.mock.results[0].value.dispose).toHaveBeenCalledOnce();
});
