// T4.13 + FUX.P4: the anonymous preference needs all three explicit consents and sends exactly the
// previewed JSON, keeping the receipt locally; the Turnstile check is imported and mounted only
// after the consent (L6, T10). Reports need a Turnstile token and an account; their check mounts only
// when the form is shown. Unavailable actions say why (aria-disabled + reason).
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import ReportPanel from '#lib/components/pages/comunidade/ReportPanel.svelte';
import S6Panel from '#lib/components/pages/comunidade/S6Panel.svelte';
import { createListener, type Listener } from '#lib/components/pages/comunidade/listener.svelte.ts';
import {
	S6_RECEIPTS_KEY,
	channelOf,
	formatDate,
	readReceipts,
	type Channel,
	type DecodedCurve,
	type FeedItem,
	type ReceiptStorage
} from '#lib/components/pages/comunidade/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';
import {
	ANONYMOUS,
	S1_BOOST,
	VERIFIED,
	apiError,
	apiWith,
	deferred,
	domClick,
	fakeFetch,
	feedItem,
	headerOf,
	json,
	notesWith,
	reasonOf,
	statusOf
} from './fixtures.ts';

const engines: AudioEngine[] = [];

beforeEach(resetAudioConfig);
afterEach(async () => {
	await cleanup();
	await Promise.all(engines.splice(0).map((item) => item.dispose()));
	vi.restoreAllMocks();
	Reflect.deleteProperty(window, 'turnstile');
});

function engine(): AudioEngine {
	const created = createAudioEngine(fakeEnv(null).env);
	engines.push(created);
	return created;
}

function memoryStorage(): ReceiptStorage & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		}
	};
}

/**
 * A stand-in for Cloudflare's `window.turnstile`: the widget module finds it and never injects the
 * third-party script, so the test makes no network request.
 */
function stubTurnstile() {
	const renderWidget = vi.fn<(container: HTMLElement, options: { action: string }) => string>(
		() => 'widget-1'
	);
	Reflect.set(window, 'turnstile', { render: renderWidget, reset: vi.fn(), remove: vi.fn() });
	return renderWidget;
}

const PAIRS = [{ a: 'aaaaaaaaaaaa', b: 'bbbbbbbbbbbb', choice: 'a' as const, levelMatched: true }];

function s6Props(
	fetch: ReturnType<typeof fakeFetch>,
	storage: ReceiptStorage | null,
	overrides: { siteKey?: string; token?: string; online?: boolean } = {}
) {
	const online = overrides.online ?? true;
	return {
		api: apiWith(fetch, online),
		channels: [],
		listener: createListener({ engine: () => null }),
		canListen: false,
		siteKey: overrides.siteKey ?? '',
		online,
		storage,
		pairs: PAIRS,
		token: overrides.token ?? 'turnstile-token',
		onnotice: vi.fn()
	};
}

test('S6: nothing can be sent before the three explicit consents', async () => {
	const fetch = fakeFetch(() => json({ ok: true }));
	await render(S6Panel, s6Props(fetch, memoryStorage()));
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(send.element())).toBe(m.comunidade_s6_consent_required());
	expect(notesWith(m.comunidade_s6_consent_required())).toHaveLength(1);
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	const button = send.element();
	if (button instanceof HTMLElement) button.click();
	expect(fetch).not.toHaveBeenCalled();
});

test('S6: with consent it sends exactly the previewed payload and keeps the receipt', async () => {
	const fetch = fakeFetch((url, init) =>
		url.pathname === '/api/v1/s6/batches' && init.method === 'POST' ? json({ ok: true }) : undefined
	);
	const storage = memoryStorage();
	await render(S6Panel, s6Props(fetch, storage));
	// Wait for the browser-only receipt: the preview is then the final body.
	await expect.element(page.getByTestId('s6-payload')).toMatchTextContent('s6-consent-v1');
	await expect
		.poll(() => document.querySelector('[data-testid="s6-payload"]')?.textContent ?? '')
		.toMatch(/"receipt": "[A-Za-z0-9_-]{43}"/);
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_research() }).click();
	const preview: unknown = JSON.parse(
		document.querySelector('[data-testid="s6-payload"]')?.textContent ?? ''
	);
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	await expect.element(send).not.toHaveAttribute('aria-disabled');
	await send.click();
	await expect.element(page.getByText(m.comunidade_s6_sent())).toBeVisible();
	const [url, init] = fetch.mock.calls[0] ?? [];
	expect(url).toBe('/api/v1/s6/batches');
	expect(headerOf(init, 'x-turnstile-token')).toBe('turnstile-token');
	expect(JSON.parse(String(init?.body))).toEqual(preview);
	expect(preview).toMatchObject({ consentVersion: 's6-consent-v1', pairs: PAIRS });
	const receipts = readReceipts(storage);
	expect(receipts).toHaveLength(1);
	expect(storage.data.has(S6_RECEIPTS_KEY)).toBe(true);
	expect(receipts[0]?.receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(receipts[0]?.receipt).toBe(Reflect.get(Object(preview), 'receipt'));
});

test('S6: the Turnstile check is mounted only after the three consents, with no error before', async () => {
	const renderWidget = stubTurnstile();
	const fetch = fakeFetch(() => undefined);
	await render(S6Panel, s6Props(fetch, memoryStorage(), { siteKey: 'site-key', token: '' }));
	const check = page.getByTestId('s6-check');
	await expect.element(check).toHaveTextContent(m.comunidade_v2_turnstile_after_consent());
	expect(document.querySelector('input[name="cf-turnstile-response"]')).toBeNull();
	expect(document.querySelector('[role="alert"]')).toBeNull();
	expect(renderWidget).not.toHaveBeenCalled();

	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	expect(renderWidget).not.toHaveBeenCalled();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_research() }).click();

	await expect.poll(() => renderWidget.mock.calls.length).toBe(1);
	expect(renderWidget.mock.calls[0]?.[1]).toMatchObject({ action: 's6-submit' });
	expect(document.querySelector('input[name="cf-turnstile-response"]')).not.toBeNull();
	// The third-party script itself was never injected (the stub answered).
	expect(document.getElementById('cf-turnstile-api')).toBeNull();
	// Without a token the send action says what is missing.
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	expect(reasonOf(send.element())).toBe(m.comunidade_report_needs_check());
});

test('S6: without a site key the check says it is unavailable, only after the consent', async () => {
	const fetch = fakeFetch(() => undefined);
	await render(S6Panel, s6Props(fetch, memoryStorage(), { token: '' }));
	expect(notesWith(m.comunidade_turnstile_unavailable())).toHaveLength(0);
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_research() }).click();
	await expect.poll(() => notesWith(m.comunidade_turnstile_unavailable()).length).toBe(1);
});

// ---- S6: the blind round, the receipts and the failures ------------------------------------------

const ALFA = channelOf(feedItem({ id: 'lin-aaaaaaaaaaaa', name: 'Alfa' }) as unknown as FeedItem);
const BETA = channelOf(
	feedItem({ id: 'lin-bbbbbbbbbbbb', name: 'Beta', s1: S1_BOOST }) as unknown as FeedItem
);
const NO_CURVE: Channel = {
	...channelOf(feedItem({ id: 'lin-cccccccccccc', name: 'Sem curva' }) as unknown as FeedItem),
	curve: null
};
const STORED = 'R'.repeat(43);
const SENT_AT = 1_700_000_000_000;

function curveOf(item: Channel): DecodedCurve {
	if (!item.curve) throw new Error('fixture channel has no curve');
	return item.curve;
}

function roundProps(
	listener: Listener,
	overrides: { canListen?: boolean; channels?: Channel[]; random?: () => number } = {}
) {
	return {
		api: apiWith(fakeFetch(() => undefined)),
		channels: overrides.channels ?? [NO_CURVE, ALFA, BETA],
		listener,
		canListen: overrides.canListen ?? true,
		siteKey: '',
		online: true,
		storage: memoryStorage(),
		random: overrides.random ?? (() => 0),
		onnotice: vi.fn<(message: string) => void>()
	};
}

function storedWith(receipts: unknown[]) {
	const storage = memoryStorage();
	storage.setItem(S6_RECEIPTS_KEY, JSON.stringify(receipts));
	return storage;
}

async function consentAll() {
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_pairs() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_anonymous() }).click();
	await page.getByRole('checkbox', { name: m.comunidade_s6_consent_research() }).click();
}

/** Rows of the local pairs table: [A, B, choice]. */
function pairRows(): string[][] {
	return Array.from(document.querySelectorAll('[data-testid="s6-panel"] tbody tr'), (row) =>
		Array.from(row.querySelectorAll('td'), (cell) => cell.textContent?.trim() ?? '')
	);
}

function payloadOf(): unknown {
	return JSON.parse(document.querySelector('[data-testid="s6-payload"]')?.textContent ?? '');
}

function receiptOf(): string {
	const value: unknown = Reflect.get(Object(payloadOf()), 'receipt');
	return typeof value === 'string' ? value : '';
}

/** Whitespace collapsed like `toMatchTextContent` does (dates may hold narrow no-break spaces). */
function squash(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

const startButton = () =>
	page.getByRole('button', { name: m.comunidade_s6_round_start(), exact: true });
const roundKeys = () => page.getByRole('group', { name: m.comunidade_s6_round_title() });
const keyX = () => roundKeys().getByRole('button', { name: 'X', exact: true });
const keyY = () => roundKeys().getByRole('button', { name: 'Y', exact: true });
const receiptItems = () => page.getByTestId('s6-panel').getByRole('listitem');

test('S6: a blind round needs two strips with a curve', async () => {
	await render(
		S6Panel,
		roundProps(createListener({ engine: () => null }), { channels: [NO_CURVE, ALFA] })
	);
	await expect.element(page.getByText(m.comunidade_s6_need_two())).toBeVisible();
	expect(startButton().elements()).toHaveLength(0);
	await expect.element(page.getByText(m.comunidade_s6_no_pairs())).toBeVisible();
	await expect.element(page.getByText(m.comunidade_s6_no_receipts())).toBeVisible();
});

test('S6: without audio the round cannot start and says why', async () => {
	const listener = createListener({ engine: () => null });
	const play = vi.spyOn(listener, 'play');
	const props = roundProps(listener, { canListen: false });
	await render(S6Panel, props);
	await expect.element(startButton()).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(startButton().element())).toBe(m.comunidade_audio_unavailable());
	domClick(startButton().element());
	expect(play).not.toHaveBeenCalled();
	expect(props.onnotice).not.toHaveBeenCalled();
	expect(roundKeys().elements()).toHaveLength(0);
});

test('S6: while the preview engine is still starting, the round waits and says why', async () => {
	const audio = engine();
	const started = deferred<void>();
	vi.spyOn(audio, 'start').mockReturnValue(started.promise);
	const listener = createListener({ engine: () => audio });
	const running = listener.play({
		a: { lineageId: ALFA.lineageId, curve: curveOf(ALFA) },
		b: { lineageId: BETA.lineageId, curve: curveOf(BETA) },
		initial: 'A',
		owner: 'scope'
	});
	await render(S6Panel, roundProps(listener));
	await expect.element(startButton()).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(startButton().element())).toBe(m.comunidade_v2_reason_busy());
	started.resolve();
	await running;
	await expect.element(startButton()).not.toHaveAttribute('aria-disabled');
	expect(listener.owner).toBe('scope');
});

test('S6: a round plays X and Y blind; the vote records the pair and ends the round', async () => {
	const audio = engine();
	const listener = createListener({ engine: () => audio });
	await render(S6Panel, roundProps(listener, { random: () => 0 }));
	// No pairs yet: no consent warning under the send action.
	expect(notesWith(m.comunidade_s6_consent_required())).toHaveLength(0);
	await startButton().click();
	await expect.element(keyX()).toHaveAttribute('aria-pressed', 'true');
	await expect.element(keyY()).toHaveAttribute('aria-pressed', 'false');
	await expect.element(keyX()).not.toHaveAttribute('aria-disabled');
	await expect.element(keyY()).not.toHaveAttribute('aria-disabled');
	expect(keyX().element().querySelector('.btn__led')?.getAttribute('data-on')).toBe('true');
	expect(keyY().element().querySelector('.btn__led')?.getAttribute('data-on')).not.toBe('true');
	expect(listener.owner).toBe('s6');
	expect(listener.active?.request).toMatchObject({
		blind: true,
		initial: 'A',
		a: { lineageId: ALFA.lineageId, curve: ALFA.curve },
		b: { lineageId: BETA.lineageId, curve: BETA.curve }
	});
	expect(audio.state().playing).toBe(true);
	expect(startButton().elements()).toHaveLength(0);

	await keyY().click();
	await expect.element(keyY()).toHaveAttribute('aria-pressed', 'true');
	await expect.element(keyX()).toHaveAttribute('aria-pressed', 'false');
	expect(listener.side).toBe('B');

	await page.getByRole('button', { name: m.comunidade_s6_prefer_x(), exact: true }).click();
	await expect.element(startButton()).toBeVisible();
	expect(roundKeys().elements()).toHaveLength(0);
	expect(pairRows()).toEqual([[ALFA.curveId, BETA.curveId, 'a']]);
	expect(Reflect.get(Object(payloadOf()), 'pairs')).toEqual([
		{ a: ALFA.curveId, b: BETA.curveId, choice: 'a', levelMatched: true }
	]);
	expect(listener.owner).toBeNull();
	expect(audio.state().playing).toBe(false);
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(send.element())).toBe(m.comunidade_s6_consent_required());
	expect(notesWith(m.comunidade_s6_consent_required())).toHaveLength(1);
});

test('S6: a swapped round plays the second strip as X and records the vote in that order', async () => {
	const audio = engine();
	const listener = createListener({ engine: () => audio });
	await render(S6Panel, roundProps(listener, { random: () => 1 }));
	await startButton().click();
	await expect.element(keyX()).toHaveAttribute('aria-pressed', 'true');
	expect(listener.active?.request).toMatchObject({
		a: { lineageId: BETA.lineageId },
		b: { lineageId: ALFA.lineageId }
	});
	await page.getByRole('button', { name: m.comunidade_s6_prefer_y(), exact: true }).click();
	await expect.element(startButton()).toBeVisible();
	expect(pairRows()).toEqual([[BETA.curveId, ALFA.curveId, 'b']]);
	expect(listener.owner).toBeNull();
});

test('S6: when the round stops elsewhere, X and Y say why and a tie is still recorded', async () => {
	const audio = engine();
	const listener = createListener({ engine: () => audio });
	await render(S6Panel, roundProps(listener));
	await startButton().click();
	await expect.element(keyX()).not.toHaveAttribute('aria-disabled');
	listener.stop();
	for (const key of [keyX(), keyY()]) {
		await expect.element(key).toHaveAttribute('aria-disabled', 'true');
		expect(reasonOf(key.element())).toBe(m.comunidade_v2_reason_round());
		expect(key.element().querySelector('.btn__led')?.getAttribute('data-on')).not.toBe('true');
	}
	const stop = vi.spyOn(listener, 'stop');
	await page.getByRole('button', { name: m.comunidade_s6_tie(), exact: true }).click();
	await expect.poll(pairRows).toEqual([[ALFA.curveId, BETA.curveId, 'tie']]);
	expect(stop).not.toHaveBeenCalled();
	await expect.element(startButton()).toBeVisible();
});

test('S6: a round that fails to start says so and logs only the error name', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const props = roundProps(createListener({ engine: () => null }));
	await render(S6Panel, props);
	await startButton().click();
	await expect.poll(() => props.onnotice.mock.calls).toEqual([[m.comunidade_audio_error()]]);
	expect(warn).toHaveBeenCalledWith(
		JSON.stringify({ event: 'comunidade.s6_round_failed', error: 'Error' })
	);
	await expect.element(startButton()).toBeVisible();
	expect(roundKeys().elements()).toHaveLength(0);
	expect(pairRows()).toEqual([]);
});

test('S6: the Cloudflare preconnect is added only after the three consents', async () => {
	stubTurnstile();
	const preconnect = () =>
		document.head.querySelector('link[rel="preconnect"][href="https://challenges.cloudflare.com"]');
	await render(
		S6Panel,
		s6Props(
			fakeFetch(() => undefined),
			memoryStorage(),
			{ siteKey: 'site-key', token: '' }
		)
	);
	await expect
		.element(page.getByTestId('s6-check'))
		.toHaveTextContent(m.comunidade_v2_turnstile_after_consent());
	expect(preconnect()).toBeNull();
	await consentAll();
	await expect.poll(preconnect).not.toBeNull();
	expect(notesWith(m.comunidade_s6_consent_required())).toHaveLength(0);
});

test('S6: stored receipts are listed and a withdrawal deletes the batch and forgets it', async () => {
	const fetch = fakeFetch((url, init) =>
		url.pathname === `/api/v1/s6/batches/${STORED}` && init.method === 'DELETE'
			? new Response(null, { status: 204 })
			: undefined
	);
	const storage = storedWith([{ receipt: STORED, at: SENT_AT, pairs: 2 }]);
	await render(S6Panel, s6Props(fetch, storage));
	await expect
		.element(receiptItems())
		.toMatchTextContent(
			squash(
				`${formatDate(SENT_AT, getLocale())} · ${m.comunidade_s6_receipt_pairs({ count: '2' })}`
			)
		);
	expect(notesWith(m.comunidade_s6_no_receipts())).toHaveLength(0);
	await receiptItems().getByRole('button', { name: m.comunidade_s6_withdraw() }).click();
	await expect.poll(() => statusOf('s6-panel')).toBe(m.comunidade_s6_withdrawn());
	expect(fetch).toHaveBeenCalledOnce();
	await expect.element(page.getByText(m.comunidade_s6_no_receipts())).toBeVisible();
	expect(receiptItems().elements()).toHaveLength(0);
	expect(readReceipts(storage)).toEqual([]);
});

test('S6: a failed withdrawal keeps the receipt and says why', async () => {
	// The DELETE is not routed: the fake answers 404 NOT_FOUND.
	const fetch = fakeFetch(() => undefined);
	const storage = storedWith([{ receipt: STORED, at: SENT_AT, pairs: 2 }]);
	await render(S6Panel, s6Props(fetch, storage));
	await receiptItems().getByRole('button', { name: m.comunidade_s6_withdraw() }).click();
	await expect.poll(() => statusOf('s6-panel')).toBe(m.comunidade_error_not_found());
	expect(receiptItems().elements()).toHaveLength(1);
	expect(readReceipts(storage)).toEqual([{ receipt: STORED, at: SENT_AT, pairs: 2 }]);
});

test('S6: offline, the batch cannot be sent and no receipt can be withdrawn, and both say why', async () => {
	const fetch = fakeFetch(() => undefined);
	await render(
		S6Panel,
		s6Props(fetch, storedWith([{ receipt: STORED, at: SENT_AT, pairs: 2 }]), { online: false })
	);
	const withdraw = page.getByRole('button', { name: m.comunidade_s6_withdraw() });
	await expect.element(withdraw).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(withdraw.element())).toBe(m.comunidade_offline());
	await consentAll();
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	await expect.poll(() => reasonOf(send.element())).toBe(m.comunidade_offline());
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	domClick(withdraw.element());
	domClick(send.element());
	expect(fetch).not.toHaveBeenCalled();
});

test('S6: a refused batch keeps the pairs, asks for a new check and stores no receipt', async () => {
	const fetch = fakeFetch((url, init) =>
		url.pathname === '/api/v1/s6/batches' && init.method === 'POST'
			? apiError('TURNSTILE_FAILED', 403)
			: undefined
	);
	const storage = memoryStorage();
	await render(S6Panel, s6Props(fetch, storage));
	await expect.poll(receiptOf).toMatch(/^[A-Za-z0-9_-]{43}$/);
	await consentAll();
	const send = page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) });
	await expect.element(send).not.toHaveAttribute('aria-disabled');
	await send.click();
	await expect.poll(() => statusOf('s6-panel')).toBe(m.comunidade_error_turnstile());
	expect(pairRows()).toEqual([['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'a']]);
	// The token was spent: a new check is needed before another try.
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(send.element())).toBe(m.comunidade_report_needs_check());
	expect(readReceipts(storage)).toEqual([]);
	await expect.element(page.getByText(m.comunidade_s6_no_receipts())).toBeVisible();
	expect(fetch).toHaveBeenCalledOnce();
});

test('S6: without storage the sent receipt is shown once, and the next batch starts empty', async () => {
	const fetch = fakeFetch((url, init) =>
		url.pathname === '/api/v1/s6/batches' && init.method === 'POST' ? json({ ok: true }) : undefined
	);
	await render(S6Panel, { ...s6Props(fetch, null), now: () => SENT_AT });
	await expect.poll(receiptOf).toMatch(/^[A-Za-z0-9_-]{43}$/);
	const receipt = receiptOf();
	await consentAll();
	await page.getByRole('button', { name: m.comunidade_s6_send({ count: '1' }) }).click();
	await expect.poll(() => statusOf('s6-panel')).toBe(m.comunidade_s6_sent_unsaved({ receipt }));
	expect(fetch).toHaveBeenCalledOnce();
	// A new, empty batch with a fresh receipt.
	expect(pairRows()).toEqual([]);
	await expect.element(page.getByText(m.comunidade_s6_no_pairs())).toBeVisible();
	const next = page.getByRole('button', { name: m.comunidade_s6_send({ count: '0' }) });
	await expect.element(next).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(next.element())).toBe(m.comunidade_v2_reason_no_pairs());
	expect(receiptOf()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(receiptOf()).not.toBe(receipt);
	// The sent batch is still listed for this visit, so it can be withdrawn.
	await expect
		.element(receiptItems())
		.toMatchTextContent(
			squash(
				`${formatDate(SENT_AT, getLocale())} · ${m.comunidade_s6_receipt_pairs({ count: '1' })}`
			)
		);
	await expect
		.element(receiptItems().getByRole('button', { name: m.comunidade_s6_withdraw() }))
		.not.toHaveAttribute('aria-disabled');
});

const channel = channelOf(feedItem() as unknown as FeedItem);
const target = { kind: 'lineage' as const, id: channel.lineageId };

test('report: without a Turnstile token the report cannot be sent', async () => {
	const fetch = fakeFetch(() => json({ reported: true }));
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: VERIFIED,
		subject: target,
		siteKey: '',
		online: true
	});
	const send = page.getByRole('button', { name: m.comunidade_report_send() });
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(send.element())).toBe(m.comunidade_report_needs_check());
	expect(notesWith(m.comunidade_report_needs_check())).toHaveLength(1);
	expect(fetch).not.toHaveBeenCalled();
});

test('report: with a token it posts the reason and sends the token header', async () => {
	const fetch = fakeFetch((url) =>
		url.pathname === '/api/v1/reports' ? json({ reported: true }) : undefined
	);
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: VERIFIED,
		subject: target,
		siteKey: '',
		online: true,
		token: 'tok-123'
	});
	await page.getByRole('button', { name: m.comunidade_report_send() }).click();
	await expect.element(page.getByText(m.comunidade_report_sent())).toBeVisible();
	const [, init] = fetch.mock.calls[0] ?? [];
	expect(headerOf(init, 'x-turnstile-token')).toBe('tok-123');
	expect(JSON.parse(String(init?.body))).toEqual({
		targetKind: 'lineage',
		targetId: channel.lineageId,
		reason: 'dangerous',
		note: null
	});
	// Sent once for this curve: the action now says so.
	const send = page.getByRole('button', { name: m.comunidade_report_send() });
	await expect.poll(() => reasonOf(send.element())).toBe(m.comunidade_v2_reason_report_sent());
});

test('report: the Turnstile check mounts with the form, never before', async () => {
	const renderWidget = stubTurnstile();
	const fetch = fakeFetch(() => undefined);
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: VERIFIED,
		subject: null,
		siteKey: 'site-key',
		online: true
	});
	await expect.element(page.getByText(m.comunidade_select_first())).toBeVisible();
	expect(renderWidget).not.toHaveBeenCalled();
	cleanup();
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: VERIFIED,
		subject: target,
		siteKey: 'site-key',
		online: true
	});
	await expect.poll(() => renderWidget.mock.calls.length).toBe(1);
	expect(renderWidget.mock.calls[0]?.[1]).toMatchObject({ action: 'report' });
});

test('report: visitors get no form and no check, and the action says why', async () => {
	const renderWidget = stubTurnstile();
	const fetch = fakeFetch(() => undefined);
	await render(ReportPanel, {
		api: apiWith(fetch),
		session: ANONYMOUS,
		subject: target,
		siteKey: 'site-key',
		online: true
	});
	const send = page.getByRole('button', { name: m.comunidade_report_send() });
	await expect.element(send).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(send.element())).toBe(m.comunidade_v2_reason_account());
	expect(page.getByRole('textbox').elements()).toHaveLength(0);
	expect(document.querySelector('[data-testid="login-prompt"]')).toBeNull();
	expect(renderWidget).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});
