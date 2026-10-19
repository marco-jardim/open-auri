// YOLO publication from the Curva account panel (SocialActions): a YOLO curve is saved privately
// as it is (no step), opened to others only after the acknowledgement step (sent as
// `acknowledge: 'yolo'`), 409 YOLO_ACK_REQUIRED shows the step and 403 answers say why. A rejected
// curve is refused before anything is sent.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createSocialSession, ORIGINS_KEY, type SocialFetch } from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';
import SocialActions from '#lib/components/pages/curva/SocialActions.svelte';
import type { Band, Curve } from '#lib/components/pages/curva/model.ts';
import { curvaSocialApi } from '#lib/components/pages/curva/social.ts';
import { exitReason } from '#lib/components/pages/curva/yolo.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const pad = (bands: Band[]) => [...bands, ...NEUTRO.bands.slice(bands.length)];
const yoloCurve: Curve = {
	bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]),
	preampDb: -0.5
};
const neutral: Curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const apps: ClientApp[] = [];
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const created = () => json({ lineageId: 'lin', versionId: 'v1', curveId: 'c', yolo: true }, 201);

afterEach(async () => {
	await cleanup();
	for (const app of apps.splice(0)) app.dispose();
	localStorage.removeItem(ORIGINS_KEY);
	vi.restoreAllMocks();
});

async function setup(curve: Curve, publish: (body: unknown) => Response = created) {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	await app.state.ready;
	const sent: unknown[] = [];
	const fetcher = vi.fn<SocialFetch>(async (input, init) => {
		const path = new URL(input, 'https://example.test').pathname;
		const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		if (init.method === 'POST' && path === '/api/v1/curves') {
			sent.push(body);
			return publish(body);
		}
		return json({ error: { code: 'NOT_FOUND' } }, 404);
	});
	await render(SocialActions, {
		app,
		curve,
		name: 'Subsônica',
		locale: 'pt-BR',
		pageUrl: new URL('https://example.test/'),
		api: curvaSocialApi(fetcher),
		session: createSocialSession({
			initial: { id: 'u-ana', username: 'Ana', emailVerified: true }
		}),
		blockedReason: exitReason(curve),
		clipboard: vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
	});
	return { sent };
}

function nativeDialog(): HTMLDialogElement {
	const element = document.querySelector('dialog');
	if (!(element instanceof HTMLDialogElement)) throw new Error('Missing dialog');
	return element;
}
const acked = (body: unknown) => typeof body === 'object' && body !== null && 'acknowledge' in body;
const dialog = () => page.getByRole('dialog');
const step = () => dialog().getByRole('group', { name: m.yolopub_ack_title() });

async function openPublish() {
	await page.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
	await expect.poll(() => nativeDialog().open).toBe(true);
}
async function submitPublish() {
	await dialog().getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
}
async function acknowledge() {
	await step().getByRole('checkbox', { name: m.yolopub_ack_checkbox() }).click();
	await step().getByRole('button', { name: m.yolopub_ack_button() }).click();
}

test('a YOLO curve is saved privately with no step and no acknowledgement', async () => {
	const { sent } = await setup(yoloCurve);
	await page.getByRole('button', { name: m.curva_social_save(), exact: true }).click();
	await expect.poll(() => nativeDialog().open).toBe(true);
	await expect.element(dialog().getByTestId('publish-yolo-mark')).toBeVisible();
	await dialog().getByRole('button', { name: m.cvedit_save_confirm(), exact: true }).click();
	await expect.poll(() => sent.length).toBe(1);
	expect(sent[0]).toMatchObject({ visibility: 'private' });
	expect(acked(sent[0])).toBe(false);
});

test('publishing a YOLO curve goes through the step and sends the acknowledgement', async () => {
	const { sent } = await setup(yoloCurve);
	await openPublish();
	await submitPublish();
	await expect.element(step()).toMatchTextContent(m.yolopub_ack_body());
	expect(sent).toHaveLength(0);
	await acknowledge();
	await expect.poll(() => sent.length).toBe(1);
	expect(sent[0]).toMatchObject({ visibility: 'unlisted', acknowledge: 'yolo' });
	await expect.poll(() => nativeDialog().open).toBe(false);
});

test('409 YOLO_ACK_REQUIRED shows the step for a curve the client took as standard', async () => {
	const ackRequired = { error: { code: 'YOLO_ACK_REQUIRED', details: { waived: [] } } };
	const { sent } = await setup(neutral, (body) =>
		acked(body) ? created() : json(ackRequired, 409)
	);
	await openPublish();
	await submitPublish();
	await expect.element(step()).toBeVisible();
	await acknowledge();
	await expect.poll(() => sent.length).toBe(2);
	expect(sent[1]).toMatchObject({ acknowledge: 'yolo' });
});

test.each([
	['YOLO_PUBLICATION_OFF', undefined, () => m.yolopub_error_off()],
	['FORBIDDEN', { reason: 'account-age' }, () => m.yolopub_error_account_age()]
] as const)('403 %s says why', async (code, details, text) => {
	await setup(yoloCurve, () =>
		json({ error: details === undefined ? { code } : { code, details } }, 403)
	);
	await openPublish();
	await submitPublish();
	await acknowledge();
	await expect.element(dialog().getByText(text())).toBeVisible();
});

test('a rejected curve is refused before anything is sent', async () => {
	const boost: Band = { kind: 'PK', freqHz: 1000, gainDb: 9, qFactor: 1 };
	const rejected: Curve = { bands: pad([boost, boost, boost, boost]), preampDb: -0.5 };
	const reason = exitReason(rejected);
	expect(reason).toEqual(expect.any(String));
	const { sent } = await setup(rejected);
	const button = page.getByRole('button', { name: m.curva_social_publish(), exact: true });
	await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	expect(sent).toHaveLength(0);
});
