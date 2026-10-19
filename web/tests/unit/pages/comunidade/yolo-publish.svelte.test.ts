// YOLO publication on the Comunidade page (migration 0013): a YOLO curve opened to others goes
// through the acknowledgement step and is sent with `acknowledge: 'yolo'`; a 409
// YOLO_ACK_REQUIRED shows the step; 403 YOLO_PUBLICATION_OFF and the account-age 403 say why; a
// private save needs no step. The "Curvas YOLO" toggle switches the feed to `yolo=only` (new
// only) and every YOLO card carries the badge.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createTour } from '#lib/comprehension/tour.svelte.ts';
import Comunidade from '#lib/components/pages/comunidade/Comunidade.svelte';
import OnAir from '#lib/components/pages/comunidade/OnAir.svelte';
import { curveClassification } from '#lib/gate-verdicts.ts';
import { m } from '#lib/paraglide/messages.js';
import {
	ANONYMOUS,
	NEUTRAL,
	VERIFIED,
	apiError,
	apiWith,
	fakeFetch,
	feedItem,
	feedPage,
	json,
	type Route
} from './fixtures.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** Refused by the standard gate on class-2 reasons only, accepted by YOLO: HP 30 Hz. */
const YOLO_EDITOR = {
	preampDb: -0.5,
	bands: [{ kind: 'HP' as const, freqHz: 30, qFactor: 0.71 }, ...NEUTRAL.bands.slice(1)]
};

function setup(route: Route) {
	const fetch = fakeFetch(route);
	return {
		fetch,
		props: {
			api: apiWith(fetch),
			session: VERIFIED,
			editor: YOLO_EDITOR,
			editorName: 'Subsônica',
			online: true
		}
	};
}

const published = () =>
	json({ lineageId: 'lin-y', versionId: 'ver-y', curveId: 'cy', yolo: true }, 201);
const onCurves: Route = (url) => (url.pathname === '/api/v1/curves' ? published() : undefined);
const bodies = (fetch: ReturnType<typeof fakeFetch>) =>
	fetch.mock.calls
		.filter(([input]) => new URL(input, 'https://example.test').pathname === '/api/v1/curves')
		.map(([, init]): unknown => JSON.parse(String(init?.body)));

test('the fixture is a YOLO curve', () => {
	expect(curveClassification(YOLO_EDITOR.bands, YOLO_EDITOR.preampDb).class).toBe('yolo');
});

test('a YOLO curve shows the mark and publishes only after the acknowledgement step', async () => {
	const { props, fetch } = setup(onCurves);
	await render(OnAir, props);
	await expect.element(page.getByTestId('onair-yolo')).toBeVisible();
	await page.getByRole('button', { name: m.comunidade_onair_publish() }).click();
	// Nothing is sent before the step.
	expect(bodies(fetch)).toHaveLength(0);
	const step = page.getByRole('group', { name: m.yolopub_ack_title() });
	await expect.element(step).toMatchTextContent(m.yolopub_ack_body());
	const confirm = step.getByRole('button', { name: m.yolopub_ack_button() });
	// The checkbox is required: the button says why it waits.
	await expect.element(confirm).toHaveAttribute('aria-disabled', 'true');
	await step.getByRole('checkbox', { name: m.yolopub_ack_checkbox() }).click();
	await confirm.click();
	await expect.element(page.getByTestId('onair-lamp')).toHaveAttribute('data-lit', 'true');
	expect(bodies(fetch)).toEqual([
		expect.objectContaining({ visibility: 'unlisted', acknowledge: 'yolo' })
	]);
});

test('a private save of a YOLO curve needs no step and sends no acknowledgement', async () => {
	const { props, fetch } = setup(onCurves);
	await render(OnAir, props);
	await page.getByRole('radio', { name: m.comunidade_visibility_private() }).click();
	await page.getByRole('button', { name: m.comunidade_onair_publish() }).click();
	await expect.element(page.getByTestId('onair-lamp')).toHaveAttribute('data-lit', 'true');
	const [body] = bodies(fetch);
	expect(body).toMatchObject({ visibility: 'private' });
	expect(body).not.toHaveProperty('acknowledge');
	expect(document.querySelector('[data-yolo-publish-ack]')).toBeNull();
});

test('409 YOLO_ACK_REQUIRED shows the step; confirming resends with the acknowledgement', async () => {
	let calls = 0;
	const { props, fetch } = setup((url, init) => {
		if (url.pathname !== '/api/v1/curves') return undefined;
		calls += 1;
		const body: unknown = JSON.parse(String(init.body));
		const acked = typeof body === 'object' && body !== null && 'acknowledge' in body;
		return acked ? published() : apiError('YOLO_ACK_REQUIRED', 409, { waived: ['a:b2'] });
	});
	// A standard-looking editor (the server classifies): the client sends without the step first.
	await render(OnAir, { ...props, editor: { preampDb: NEUTRAL.preampDb, bands: NEUTRAL.bands } });
	await page.getByRole('button', { name: m.comunidade_onair_publish() }).click();
	const step = page.getByRole('group', { name: m.yolopub_ack_title() });
	await expect.element(step).toBeVisible();
	await step.getByRole('checkbox', { name: m.yolopub_ack_checkbox() }).click();
	await step.getByRole('button', { name: m.yolopub_ack_button() }).click();
	await expect.element(page.getByTestId('onair-lamp')).toHaveAttribute('data-lit', 'true');
	expect(calls).toBe(2);
	expect(bodies(fetch)[1]).toMatchObject({ acknowledge: 'yolo' });
});

test.each([
	['YOLO_PUBLICATION_OFF', undefined, () => m.yolopub_error_off()],
	['FORBIDDEN', { reason: 'account-age' }, () => m.yolopub_error_account_age()]
] as const)('403 %s says why and keeps the lamp dark', async (code, details, text) => {
	const { props } = setup((url, init) => {
		if (url.pathname !== '/api/v1/curves') return undefined;
		const body: unknown = JSON.parse(String(init.body));
		return typeof body === 'object' && body !== null && 'acknowledge' in body
			? apiError(code, 403, details)
			: undefined;
	});
	await render(OnAir, props);
	await page.getByRole('button', { name: m.comunidade_onair_publish() }).click();
	const step = page.getByRole('group', { name: m.yolopub_ack_title() });
	await step.getByRole('checkbox', { name: m.yolopub_ack_checkbox() }).click();
	await step.getByRole('button', { name: m.yolopub_ack_button() }).click();
	await expect.element(page.getByRole('alert')).toMatchTextContent(text());
	await expect.element(page.getByTestId('onair-lamp')).toHaveAttribute('data-lit', 'false');
});

test('"Curvas YOLO" switches the feed to yolo=only (new) and every YOLO card has the badge', async () => {
	const item = feedItem({ id: 'lin-yyyyyyyyyyyy', name: 'Subsônica pública' });
	const yoloCurve = { ...item.lineage.curve, gateOk: false, yolo: true };
	const yoloItem = { ...item, lineage: { ...item.lineage, curve: yoloCurve } };
	const fetch = fakeFetch((url) => {
		if (url.pathname !== '/api/v1/feed') return undefined;
		return json(feedPage(url.searchParams.get('yolo') === 'only' ? [yoloItem] : [feedItem()]));
	});
	await render(Comunidade, {
		api: apiWith(fetch),
		session: ANONYMOUS,
		storage: null,
		remember: vi.fn(async () => undefined),
		tourController: createTour({ storage: () => undefined, isDesktop: () => false }),
		signupOpen: true,
		isOnline: () => true
	});
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	expect(document.querySelector('[data-yolo-curve-notice]')).toBeNull();
	// A ranked sort first: the toggle brings the list back to "new".
	await page.getByRole('button', { name: m.comunidade_sort_favorites() }).click();
	const toggle = page.getByTestId('feed-yolo-toggle');
	await expect.element(toggle).toHaveAttribute('aria-pressed', 'false');
	await toggle.click();
	await expect.element(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect.element(page.getByRole('link', { name: 'Subsônica pública' })).toBeVisible();
	const feedCalls = () =>
		fetch.mock.calls
			.map(([input]) => new URL(input, 'https://example.test'))
			.filter((url) => url.pathname === '/api/v1/feed');
	const last = feedCalls().at(-1) ?? new URL('https://example.test');
	expect(last.searchParams.get('yolo')).toBe('only');
	expect(last.searchParams.get('sort')).toBe('new');
	expect(last.searchParams.has('window')).toBe(false);
	const badge = page.getByRole('note', { name: m.yolo_curve_aria() });
	await expect.element(badge).toMatchTextContent(m.yolo_curve_compact());
	expect(document.querySelector('[data-yolo-curve-notice="public"][data-compact]')).not.toBeNull();
	// Off again: the standard list, without the parameter.
	await toggle.click();
	await expect.element(page.getByRole('link', { name: 'Rádio de madrugada' })).toBeVisible();
	const after = feedCalls().at(-1) ?? new URL('https://example.test/?yolo=only');
	expect(after.searchParams.has('yolo')).toBe(false);
});
