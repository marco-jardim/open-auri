// Blind trade (S7, T8/T9): visitors and unverified accounts get one unavailable join action that
// says why; a verified account joins with a gate-approved publication, listens to the partner
// blind against its editor curve, scores 1 to 5, sees the reveal and can cancel a waiting entry.
// While a request runs every action says to wait; every failure lands in the status line,
// localized by its code.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { mount, unmount } from 'svelte';
import { createHiddenStore } from '#lib/social/hidden-store.ts';
import { HIDDEN_CONTEXT } from '#lib/social/hidden-context.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import S7Panel from '#lib/components/pages/comunidade/S7Panel.svelte';
import { createListener, type Listener } from '#lib/components/pages/comunidade/listener.svelte.ts';
import {
	decodeCurve,
	formatDate,
	type DecodedCurve,
	type SessionView
} from '#lib/components/pages/comunidade/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import type { LibraryItem, TradeDto } from '#lib/social/index.ts';
import { fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';
import {
	ANONYMOUS,
	S1_BOOST,
	S1_NEUTRAL,
	VERIFIED,
	apiError,
	apiWith,
	deferred,
	domClick,
	fakeFetch,
	json,
	reasonOf,
	statusOf,
	type Route
} from './fixtures.ts';

const engines: AudioEngine[] = [];

beforeEach(resetAudioConfig);
afterEach(async () => {
	await cleanup();
	await Promise.all(engines.splice(0).map((item) => item.dispose()));
	vi.restoreAllMocks();
});

function engine(): AudioEngine {
	const created = createAudioEngine(fakeEnv(null).env);
	engines.push(created);
	return created;
}

function curveOf(s1: string): DecodedCurve {
	const curve = decodeCurve(s1);
	if (!curve) throw new Error('fixture curve does not decode');
	return curve;
}

const EDITOR = curveOf(S1_NEUTRAL);
const PARTNER = curveOf(S1_BOOST);
const CREATED = 1_700_000_000_000;
const UNVERIFIED: SessionView = {
	known: true,
	signedIn: true,
	verified: false,
	nickname: 'geoff'
};

/** One of the caller's own publications (`GET /me/library`), approved by the gate by default. */
function publication(
	id: string,
	name: string,
	overrides: {
		gateOk?: boolean;
		status?: LibraryItem['status'];
		visibility?: LibraryItem['visibility'];
	} = {}
): LibraryItem {
	return {
		id,
		own: true,
		visibility: overrides.visibility ?? 'public',
		status: overrides.status ?? 'active',
		moderation: 'visible',
		curated: false,
		forkedFromVersion: null,
		createdAt: CREATED,
		updatedAt: CREATED,
		author: null,
		head: {
			id: `ver-${id}`,
			parentId: null,
			name,
			description: '',
			license: 'CC-BY-4.0',
			lang: 'pt-BR',
			recipe: null,
			labels: null,
			createdAt: CREATED
		},
		curve: { id: `c-${id}`, s1: S1_NEUTRAL, levelDb: null, gateOk: overrides.gateOk ?? true },
		at: CREATED
	};
}

const BLIND: TradeDto['partner'] = { revealed: false, curveId: 'c-partner', s1: S1_BOOST };

function trade(
	id: string,
	status: TradeDto['status'],
	overrides: Partial<TradeDto> = {}
): TradeDto {
	return {
		id,
		status,
		lineageId: 'lin-one',
		versionId: 'ver-lin-one',
		score: null,
		createdAt: CREATED,
		matchedAt: null,
		scoredAt: null,
		expiresAt: CREATED + 72 * 3_600_000,
		partner: null,
		...overrides
	};
}

/** The trade API: `GET /trades/me` answers `list`; every other route goes to `rest`. */
function tradesApi(list: TradeDto[] | Response, rest: Route = () => undefined) {
	return fakeFetch((url, init) => {
		if (url.pathname === '/api/v1/trades/me') {
			return list instanceof Response ? list : json({ items: list, nextCursor: null });
		}
		return rest(url, init);
	});
}

interface Overrides {
	session?: SessionView;
	owned?: LibraryItem[];
	editor?: DecodedCurve | null;
	listener?: Listener;
	canListen?: boolean;
	online?: boolean;
}

function s7Props(fetch: ReturnType<typeof fakeFetch>, overrides: Overrides = {}) {
	const online = overrides.online ?? true;
	return {
		api: apiWith(fetch, online),
		session: overrides.session ?? VERIFIED,
		owned: overrides.owned ?? [publication('lin-one', 'Primeira')],
		editor: overrides.editor === undefined ? EDITOR : overrides.editor,
		listener: overrides.listener ?? createListener({ engine: () => null }),
		canListen: overrides.canListen ?? true,
		online,
		onnotice: vi.fn<(message: string) => void>()
	};
}

function callsWith(fetch: ReturnType<typeof fakeFetch>, method: string) {
	return fetch.mock.calls.filter(([, init]) => (init.method ?? 'GET') === method);
}

/** Text without any whitespace (dates may hold narrow no-break spaces). */
function bare(text: string | null | undefined): string {
	return (text ?? '').replace(/\s+/g, '');
}

const rows = () => page.getByRole('list', { name: m.comunidade_s7_title() }).getByRole('listitem');
const joinButton = () => page.getByRole('button', { name: m.comunidade_s7_join(), exact: true });
const listenButton = () =>
	page.getByRole('button', { name: m.comunidade_s7_listen_blind(), exact: true });
const stopButton = () => page.getByRole('button', { name: m.comunidade_stop(), exact: true });
const scoreSelect = () =>
	page.getByRole('combobox', { name: m.comunidade_s7_score(), exact: true });
const sendScore = () =>
	page.getByRole('button', { name: m.comunidade_s7_send_score(), exact: true });
const cancelButton = () =>
	page.getByRole('button', { name: m.comunidade_s7_cancel(), exact: true });

test('S7: hidden items do not remove own status/cancel or prevent joining after sync', async () => {
	const hidden = createHiddenStore(
		{
			myHidden: async () => ({
				items: [{ targetType: 'author', targetId: 'hidden-author', label: 'Hidden', createdAt: 1 }]
			}),
			putHidden: async () => ({ items: [] }),
			deleteHidden: async () => ({ items: [] })
		},
		() => null
	);
	await hidden.setUser('me');
	const fetch = tradesApi([trade('waiting', 'waiting')], (_url, init) =>
		init.method === 'DELETE' ? json({ cancelled: true }) : undefined
	);
	const target = document.createElement('div');
	document.body.append(target);
	const instance = mount(S7Panel, {
		target,
		props: s7Props(fetch),
		context: new Map([[HIDDEN_CONTEXT, hidden]])
	});
	try {
		await expect
			.element(page.getByText(m.comunidade_s7_status_waiting(), { exact: true }))
			.toBeVisible();
		await expect.element(joinButton()).not.toHaveAttribute('aria-disabled');
		await cancelButton().click();
		await expect
			.element(page.getByText(m.comunidade_s7_status_cancelled(), { exact: true }))
			.toBeVisible();
		expect(callsWith(fetch, 'DELETE')).toHaveLength(1);
	} finally {
		await unmount(instance);
		target.remove();
	}
});

// ---- Who can join ------------------------------------------------------------------------------

test('S7: an unrelated failed hide does not disable Join or matched listening/scoring', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const hidden = createHiddenStore({
		myHidden: async () => ({ items: [] }),
		putHidden: async () => {
			throw new Error('write failed');
		},
		deleteHidden: async () => ({ items: [] })
	});
	await hidden.setUser('me');
	const target = document.createElement('div');
	document.body.append(target);
	const instance = mount(S7Panel, {
		target,
		props: s7Props(tradesApi([trade('matched', 'matched', { partner: BLIND })])),
		context: new Map([[HIDDEN_CONTEXT, hidden]])
	});
	try {
		await expect.element(listenButton()).toBeVisible();
		await expect(hidden.hide('curve', 'unrelated')).rejects.toThrow('write failed');
		await expect.element(joinButton()).not.toHaveAttribute('aria-disabled');
		await expect.element(listenButton()).toBeVisible();
		await expect.element(sendScore()).toBeVisible();
	} finally {
		await unmount(instance);
		target.remove();
	}
});

test('S7: a failed hidden-list load has a visible retry that restores matched Listen and Score', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	let offline = true;
	const hidden = createHiddenStore({
		myHidden: async () => {
			if (offline) throw new Error('offline');
			return { items: [] };
		},
		putHidden: async () => ({ items: [] }),
		deleteHidden: async () => ({ items: [] })
	});
	await hidden.setUser('me');
	const fetch = tradesApi([trade('matched', 'matched', { partner: BLIND })]);
	const target = document.createElement('div');
	document.body.append(target);
	const instance = mount(S7Panel, {
		target,
		props: s7Props(fetch),
		context: new Map([[HIDDEN_CONTEXT, hidden]])
	});
	try {
		await expect.element(joinButton()).toHaveAccessibleDescription(m.hidden_error());
		const retry = page.getByRole('button', { name: m.w4r1_s7_retry_preferences(), exact: true });
		await expect.element(retry).toBeVisible();
		// The page-level hidden-items box announces the failed load; the panel does not repeat it.
		expect(target.querySelector('[role="alert"]')).toBeNull();
		expect(
			page.getByRole('button', { name: m.w4r1_s7_retry_trades(), exact: true }).elements()
		).toHaveLength(0);
		expect(fetch).not.toHaveBeenCalled();
		offline = false;
		await retry.click();
		await expect.element(listenButton()).toBeVisible();
		await expect.element(sendScore()).toBeVisible();
	} finally {
		await unmount(instance);
		target.remove();
	}
});

test('S7: retrying a failed trade-list load enables an already matched trade without another navigation', async () => {
	const fetch = tradesApi([trade('matched', 'matched', { partner: BLIND })]);
	fetch.mockResolvedValueOnce(apiError('RATE_LIMITED', 429));
	await render(S7Panel, s7Props(fetch));
	await expect
		.element(page.getByRole('button', { name: m.w4r1_s7_retry_trades(), exact: true }))
		.toBeVisible();
	expect(
		page.getByRole('button', { name: m.w4r1_s7_retry_preferences(), exact: true }).elements()
	).toHaveLength(0);
	await page.getByRole('button', { name: m.w4r1_s7_retry_trades(), exact: true }).click();
	await expect.element(listenButton()).toBeVisible();
	await expect.element(sendScore()).toBeVisible();
});

test('S7: visitors get one unavailable join action that says an account is needed', async () => {
	const fetch = tradesApi([]);
	await render(S7Panel, s7Props(fetch, { session: ANONYMOUS }));
	await expect.element(page.getByTestId('s7-panel')).toMatchTextContent(m.comunidade_s7_lede());
	await expect.element(joinButton()).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(joinButton().element())).toBe(m.comunidade_v2_reason_account());
	domClick(joinButton().element());
	expect(page.getByRole('combobox').elements()).toHaveLength(0);
	expect(statusOf('s7-panel')).toBeNull();
	expect(fetch).not.toHaveBeenCalled();
});

test('S7: an account still unverified is asked to verify, and no trade is fetched', async () => {
	const fetch = tradesApi([]);
	await render(S7Panel, s7Props(fetch, { session: UNVERIFIED }));
	await expect.element(joinButton()).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(joinButton().element())).toBe(m.comunidade_verify_prompt());
	expect(page.getByText(m.comunidade_s7_none()).elements()).toHaveLength(0);
	expect(fetch).not.toHaveBeenCalled();
});

test('S7: offline, a verified account sees its curve but cannot join, and nothing is fetched', async () => {
	const fetch = tradesApi([]);
	await render(S7Panel, s7Props(fetch, { online: false }));
	await expect
		.element(page.getByRole('combobox', { name: m.comunidade_s7_curve() }))
		.toHaveValue('lin-one');
	await expect.element(joinButton()).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(joinButton().element())).toBe(m.comunidade_offline());
	await expect.element(page.getByText(m.comunidade_s7_none())).toBeVisible();
	domClick(joinButton().element());
	expect(fetch).not.toHaveBeenCalled();
});

test('S7: only gate-approved, active, non-private publications can enter the queue', async () => {
	const fetch = tradesApi([]);
	await render(
		S7Panel,
		s7Props(fetch, {
			owned: [
				publication('lin-gate', 'Reprovada', { gateOk: false }),
				publication('lin-private', 'Privada', { visibility: 'private' }),
				publication('lin-retracted', 'Retirada', { status: 'retracted' })
			]
		})
	);
	await expect.element(page.getByText(m.comunidade_s7_need_approved())).toBeVisible();
	expect(page.getByRole('combobox').elements()).toHaveLength(0);
	expect(joinButton().elements()).toHaveLength(0);
	// The verified account still sees its own trades.
	await expect.poll(() => fetch.mock.calls.length).toBe(1);
	const [url] = fetch.mock.calls[0] ?? [];
	const requested = new URL(String(url), 'https://example.test');
	expect(requested.pathname).toBe('/api/v1/trades/me');
	expect(requested.searchParams.get('limit')).toBe('20');
	await expect.element(page.getByText(m.comunidade_s7_none())).toBeVisible();

	await cleanup();
	await render(
		S7Panel,
		s7Props(tradesApi([]), {
			owned: [
				publication('lin-one', 'Primeira'),
				publication('lin-gate', 'Reprovada', { gateOk: false }),
				publication('lin-two', 'Segunda', { visibility: 'unlisted' })
			]
		})
	);
	const select = page.getByRole('combobox', { name: m.comunidade_s7_curve() });
	await expect.element(select).toHaveValue('lin-one');
	expect(
		Array.from(select.element().querySelectorAll('option'), (option) => option.textContent)
	).toEqual(['Primeira', 'Segunda']);
	await expect.element(joinButton()).not.toHaveAttribute('aria-disabled');
});

// ---- Join and the trade list -------------------------------------------------------------------

test('S7: joining sends the chosen publication and lists the waiting entry', async () => {
	const fetch = tradesApi([], (url, init) =>
		url.pathname === '/api/v1/trades' && init.method === 'POST'
			? json({ trade: trade('t-new', 'waiting', { lineageId: 'lin-two' }) })
			: undefined
	);
	await render(
		S7Panel,
		s7Props(fetch, {
			owned: [publication('lin-one', 'Primeira'), publication('lin-two', 'Segunda')]
		})
	);
	await expect.element(page.getByText(m.comunidade_s7_none())).toBeVisible();
	await page.getByRole('combobox', { name: m.comunidade_s7_curve() }).selectOptions('lin-two');
	await joinButton().click();
	await expect.poll(() => statusOf('s7-panel')).toBe(m.comunidade_s7_joined());
	const post = callsWith(fetch, 'POST')[0];
	expect(post?.[0]).toBe('/api/v1/trades');
	expect(JSON.parse(String(post?.[1].body))).toEqual({ lineageId: 'lin-two' });
	await expect.poll(() => rows().elements().length).toBe(1);
	const entry = rows().first();
	await expect.element(entry).toMatchTextContent(m.comunidade_s7_status_waiting());
	await expect.element(entry.getByRole('button')).toHaveTextContent(m.comunidade_s7_cancel());
	expect(page.getByText(m.comunidade_s7_none()).elements()).toHaveLength(0);
});

test('S7: a join refused by the server says why, by its code', async () => {
	const fetch = tradesApi([], (url, init) =>
		url.pathname === '/api/v1/trades' && init.method === 'POST'
			? apiError('ALREADY_ACTIVE', 409)
			: undefined
	);
	await render(S7Panel, s7Props(fetch));
	await expect.poll(() => fetch.mock.calls.length).toBe(1);
	await joinButton().click();
	await expect.poll(() => statusOf('s7-panel')).toBe(m.comunidade_s7_already_active());
	expect(rows().elements()).toHaveLength(0);
	await expect.element(joinButton()).not.toHaveAttribute('aria-disabled');
});

test('S7: a trade list that fails to load is reported in the status line', async () => {
	await render(S7Panel, s7Props(tradesApi(apiError('RATE_LIMITED', 429))));
	await expect.poll(() => statusOf('s7-panel')).toBe(m.comunidade_error_rate());
	await expect.element(page.getByText(m.comunidade_s7_none())).toBeVisible();
	expect(rows().elements()).toHaveLength(0);
});

test('S7: every trade state shows its label and date, and only its own actions', async () => {
	await render(
		S7Panel,
		s7Props(
			tradesApi([
				trade('t-wait', 'waiting'),
				trade('t-blind', 'matched', { partner: BLIND }),
				trade('t-scored', 'matched', { partner: BLIND, score: 3 }),
				trade('t-full', 'revealed', {
					score: 5,
					partner: {
						revealed: true,
						curveId: 'c-full',
						s1: S1_BOOST,
						score: 4,
						nickname: 'Zé',
						username: 'josé',
						lineage: { id: 'lin-dela', versionId: 'ver-dela', name: 'Curva dela' }
					}
				}),
				trade('t-unnamed', 'revealed', {
					score: 1,
					partner: {
						revealed: true,
						curveId: 'c-unnamed',
						s1: S1_BOOST,
						score: 2,
						nickname: 'Ana',
						username: 'ana',
						lineage: { id: 'lin-ana', versionId: 'ver-ana', name: null }
					}
				}),
				trade('t-gone', 'revealed', {
					score: 2,
					partner: {
						revealed: true,
						curveId: 'c-gone',
						s1: S1_BOOST,
						score: null,
						nickname: null,
						username: null,
						lineage: null
					}
				}),
				trade('t-withheld', 'revealed'),
				trade('t-expired', 'expired'),
				trade('t-cancelled', 'cancelled'),
				trade('t-orphan', 'matched')
			])
		)
	);
	await expect.poll(() => rows().elements().length).toBe(10);
	const row = (index: number) => rows().nth(index);
	const date = formatDate(CREATED, getLocale());

	// Waiting: its date and one action, cancel.
	await expect.element(row(0)).toMatchTextContent(m.comunidade_s7_status_waiting());
	expect(bare(row(0).element().textContent)).toContain(bare(date));
	expect(
		row(0)
			.getByRole('button')
			.elements()
			.map((node) => node.textContent?.trim())
	).toEqual([m.comunidade_s7_cancel()]);

	// Matched, not scored yet: blind listen (not pressed), the 1 to 5 score and its send.
	await expect.element(row(1)).toMatchTextContent(m.comunidade_s7_status_matched());
	await expect
		.element(row(1).getByRole('button', { name: m.comunidade_s7_listen_blind(), exact: true }))
		.toHaveAttribute('aria-pressed', 'false');
	const score = row(1).getByRole('combobox', { name: m.comunidade_s7_score(), exact: true });
	await expect.element(score).toHaveValue('1');
	const values = Array.from(score.element().querySelectorAll('option'), (option) => option.value);
	expect(values).toEqual(['1', '2', '3', '4', '5']);
	await expect
		.element(row(1).getByRole('button', { name: m.comunidade_s7_send_score(), exact: true }))
		.not.toHaveAttribute('aria-disabled');

	// Matched and scored: still listenable, now waiting for the partner's score.
	await expect.element(row(2)).toMatchTextContent(m.comunidade_s7_waiting_partner());
	expect(row(2).getByRole('combobox').elements()).toHaveLength(0);
	expect(
		row(2)
			.getByRole('button')
			.elements()
			.map((node) => node.textContent?.trim())
	).toEqual([m.comunidade_s7_listen_blind()]);

	// Revealed: profile and curve links, and the score the partner gave.
	await expect.element(row(3)).toMatchTextContent(m.comunidade_s7_status_revealed());
	await expect
		.element(row(3).getByRole('link', { name: '@Zé', exact: true }))
		.toHaveAttribute('href', `/u/${encodeURIComponent('josé')}`);
	await expect
		.element(row(3).getByRole('link', { name: 'Curva dela', exact: true }))
		.toHaveAttribute('href', '/c/lin-dela');
	await expect.element(row(3)).toMatchTextContent(m.comunidade_s7_their_score({ score: '4' }));
	expect(row(3).getByRole('button').elements()).toHaveLength(0);

	// A partner curve without a name is linked by its curve id.
	await expect
		.element(row(4).getByRole('link', { name: '@Ana', exact: true }))
		.toHaveAttribute('href', '/u/ana');
	await expect
		.element(row(4).getByRole('link', { name: 'c-unnamed', exact: true }))
		.toHaveAttribute('href', '/c/lin-ana');
	await expect.element(row(4)).toMatchTextContent(m.comunidade_s7_their_score({ score: '2' }));

	// A removed partner without a score: no links, a dash for the score.
	await expect.element(row(5)).toMatchTextContent(m.comunidade_author_removed());
	await expect.element(row(5)).toMatchTextContent(m.comunidade_s7_their_score({ score: '–' }));
	expect(row(5).getByRole('link').elements()).toHaveLength(0);

	// Withheld reveal, expired, cancelled, matched without a partner: the label and date only.
	const labelOnly: [number, string][] = [
		[6, m.comunidade_s7_status_revealed()],
		[7, m.comunidade_s7_status_expired()],
		[8, m.comunidade_s7_status_cancelled()],
		[9, m.comunidade_s7_status_matched()]
	];
	for (const [index, label] of labelOnly) {
		expect(bare(row(index).element().textContent)).toBe(bare(`${label}${date}`));
		expect(row(index).getByRole('button').elements()).toHaveLength(0);
		expect(row(index).getByRole('link').elements()).toHaveLength(0);
	}
	expect(page.getByText(m.comunidade_s7_none()).elements()).toHaveLength(0);
});

// ---- Blind listening ---------------------------------------------------------------------------

test('S7: the blind listen plays the partner against the editor curve and stops on a second press', async () => {
	const audio = engine();
	const listener = createListener({ engine: () => audio });
	const props = s7Props(tradesApi([trade('t-blind', 'matched', { partner: BLIND })]), {
		listener
	});
	await render(S7Panel, props);
	await expect.element(listenButton()).toHaveAttribute('aria-pressed', 'false');
	await listenButton().click();
	await expect.element(stopButton()).toHaveAttribute('aria-pressed', 'true');
	expect(listener.owner).toBe('s7');
	expect(listener.side).toBe('B');
	expect(listener.active?.request).toMatchObject({
		blind: true,
		initial: 'B',
		a: { lineageId: null, curve: EDITOR },
		b: { lineageId: null, curve: PARTNER }
	});
	expect(audio.state().playing).toBe(true);

	await stopButton().click();
	await expect.element(listenButton()).toHaveAttribute('aria-pressed', 'false');
	expect(listener.owner).toBeNull();
	expect(audio.state().playing).toBe(false);
	expect(props.onnotice).not.toHaveBeenCalled();
});

test('S7: when another panel takes the preview, the trade listen control resets', async () => {
	const audio = engine();
	const listener = createListener({ engine: () => audio });
	await render(
		S7Panel,
		s7Props(tradesApi([trade('t-blind', 'matched', { partner: BLIND })]), { listener })
	);
	await listenButton().click();
	await expect.element(stopButton()).toHaveAttribute('aria-pressed', 'true');
	await listener.play({
		a: { lineageId: 'lin-x', curve: EDITOR },
		b: { lineageId: null, curve: PARTNER },
		initial: 'A',
		owner: 'scope'
	});
	await expect.element(listenButton()).toHaveAttribute('aria-pressed', 'false');
	expect(stopButton().elements()).toHaveLength(0);
	expect(listener.owner).toBe('scope');
});

test('S7: without audio, an editor curve or a decodable partner, listening says it is unavailable', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const cases: { overrides: Overrides; partner: TradeDto['partner'] }[] = [
		{ overrides: { canListen: false }, partner: BLIND },
		{ overrides: { editor: null }, partner: BLIND },
		{ overrides: {}, partner: { revealed: false, curveId: 'c-bad', s1: 'not-a-curve-code' } }
	];
	for (const { overrides, partner } of cases) {
		const listener = createListener({ engine: () => null });
		const play = vi.spyOn(listener, 'play');
		const props = s7Props(tradesApi([trade('t-blind', 'matched', { partner })]), {
			...overrides,
			listener
		});
		await render(S7Panel, props);
		await listenButton().click();
		await expect
			.poll(() => props.onnotice.mock.calls)
			.toEqual([[m.comunidade_audio_unavailable()]]);
		expect(play).not.toHaveBeenCalled();
		await expect.element(listenButton()).toHaveAttribute('aria-pressed', 'false');
		await cleanup();
	}
});

test('S7: a blind listen that fails to start says so and logs only the error name', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const props = s7Props(tradesApi([trade('t-blind', 'matched', { partner: BLIND })]));
	await render(S7Panel, props);
	await listenButton().click();
	await expect.poll(() => props.onnotice.mock.calls).toEqual([[m.comunidade_audio_error()]]);
	expect(warn).toHaveBeenCalledWith(
		JSON.stringify({ event: 'comunidade.s7_listen_failed', error: 'Error' })
	);
	await expect.element(listenButton()).toHaveAttribute('aria-pressed', 'false');
});

// ---- Score and cancel --------------------------------------------------------------------------

test('S7: scoring sends the chosen score and then waits for the partner', async () => {
	const fetch = tradesApi([trade('t-blind', 'matched', { partner: BLIND })], (url, init) =>
		url.pathname === '/api/v1/trades/t-blind/score' && init.method === 'POST'
			? json({ revealed: false, trade: trade('t-blind', 'matched', { partner: BLIND, score: 4 }) })
			: undefined
	);
	await render(S7Panel, s7Props(fetch));
	await scoreSelect().selectOptions('4');
	await sendScore().click();
	await expect.poll(() => statusOf('s7-panel')).toBe(m.comunidade_s7_scored());
	expect(JSON.parse(String(callsWith(fetch, 'POST')[0]?.[1].body))).toEqual({ score: 4 });
	await expect.element(rows().first()).toMatchTextContent(m.comunidade_s7_waiting_partner());
	expect(scoreSelect().elements()).toHaveLength(0);
	expect(sendScore().elements()).toHaveLength(0);
});

test('S7: the score that completes the pair reveals the partner and ends the blind listen', async () => {
	const audio = engine();
	const listener = createListener({ engine: () => audio });
	const revealed = trade('t-blind', 'revealed', {
		score: 1,
		partner: {
			revealed: true,
			curveId: 'c-partner',
			s1: S1_BOOST,
			score: 5,
			nickname: 'Bia',
			username: 'bia',
			lineage: { id: 'lin-bia', versionId: 'ver-bia', name: 'Noite' }
		}
	});
	const fetch = tradesApi([trade('t-blind', 'matched', { partner: BLIND })], (url, init) =>
		url.pathname === '/api/v1/trades/t-blind/score' && init.method === 'POST'
			? json({ revealed: true, trade: revealed })
			: undefined
	);
	await render(S7Panel, s7Props(fetch, { listener }));
	await listenButton().click();
	await expect.element(stopButton()).toBeVisible();
	expect(listener.owner).toBe('s7');
	// The score is left at its first option.
	await sendScore().click();
	await expect.poll(() => statusOf('s7-panel')).toBe(m.comunidade_s7_revealed());
	expect(JSON.parse(String(callsWith(fetch, 'POST')[0]?.[1].body))).toEqual({ score: 1 });
	expect(listener.owner).toBeNull();
	expect(audio.state().playing).toBe(false);
	await expect.element(rows().first()).toMatchTextContent(m.comunidade_s7_status_revealed());
	await expect
		.element(rows().first().getByRole('link', { name: '@Bia', exact: true }))
		.toHaveAttribute('href', '/u/bia');
	await expect
		.element(rows().first().getByRole('link', { name: 'Noite', exact: true }))
		.toHaveAttribute('href', '/c/lin-bia');
	await expect
		.element(rows().first())
		.toMatchTextContent(m.comunidade_s7_their_score({ score: '5' }));
	expect(rows().first().getByRole('button').elements()).toHaveLength(0);
});

test('S7: a refused score keeps the entry open and says why', async () => {
	const fetch = tradesApi([trade('t-blind', 'matched', { partner: BLIND })], (url, init) =>
		url.pathname === '/api/v1/trades/t-blind/score' && init.method === 'POST'
			? apiError('GONE', 410)
			: undefined
	);
	await render(S7Panel, s7Props(fetch));
	await sendScore().click();
	await expect.poll(() => statusOf('s7-panel')).toBe(m.comunidade_error_not_found());
	await expect.element(scoreSelect()).toBeVisible();
	await expect.element(sendScore()).not.toHaveAttribute('aria-disabled');
	await expect.element(rows().first()).toMatchTextContent(m.comunidade_s7_status_matched());
});

test('S7: cancelling a waiting entry marks it cancelled and removes the action', async () => {
	const fetch = tradesApi([trade('t-wait', 'waiting')], (url, init) =>
		url.pathname === '/api/v1/trades/t-wait' && init.method === 'DELETE'
			? json({ cancelled: true })
			: undefined
	);
	await render(S7Panel, s7Props(fetch));
	await cancelButton().click();
	await expect.element(rows().first()).toMatchTextContent(m.comunidade_s7_status_cancelled());
	expect(callsWith(fetch, 'DELETE').map(([url]) => url)).toEqual(['/api/v1/trades/t-wait']);
	expect(cancelButton().elements()).toHaveLength(0);
	expect(statusOf('s7-panel')).toBe('');
});

test('S7: a failed cancel keeps the entry waiting and says why', async () => {
	// The DELETE is not routed: the fake answers 404 NOT_FOUND.
	const fetch = tradesApi([trade('t-wait', 'waiting')]);
	await render(S7Panel, s7Props(fetch));
	await cancelButton().click();
	await expect.poll(() => statusOf('s7-panel')).toBe(m.comunidade_error_not_found());
	await expect.element(rows().first()).toMatchTextContent(m.comunidade_s7_status_waiting());
	await expect.element(cancelButton()).not.toHaveAttribute('aria-disabled');
	expect(callsWith(fetch, 'DELETE')).toHaveLength(1);
});

test('S7: while a request runs, every trade action says to wait', async () => {
	const gate = deferred<Response>();
	const fetch = tradesApi(
		[trade('t-wait', 'waiting'), trade('t-blind', 'matched', { partner: BLIND })],
		(url, init) =>
			url.pathname === '/api/v1/trades' && init.method === 'POST' ? gate.promise : undefined
	);
	await render(S7Panel, s7Props(fetch));
	await expect.element(cancelButton()).toBeVisible();
	await joinButton().click();
	for (const button of [joinButton(), cancelButton(), sendScore()]) {
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
		expect(reasonOf(button.element())).toBe(m.comunidade_v2_reason_wait());
	}
	domClick(cancelButton().element());
	domClick(sendScore().element());
	domClick(joinButton().element());
	expect(callsWith(fetch, 'POST')).toHaveLength(1);
	expect(callsWith(fetch, 'DELETE')).toHaveLength(0);

	gate.resolve(json({ trade: trade('t-new', 'waiting') }));
	await expect.poll(() => statusOf('s7-panel')).toBe(m.comunidade_s7_joined());
	await expect.element(joinButton()).not.toHaveAttribute('aria-disabled');
	await expect.element(sendScore()).not.toHaveAttribute('aria-disabled');
	await expect.poll(() => rows().elements().length).toBe(3);
	await expect.element(rows().first()).toMatchTextContent(m.comunidade_s7_status_waiting());
});
