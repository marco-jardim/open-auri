import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import {
	createSocialSession,
	ORIGINS_KEY,
	originOf,
	rememberOrigin,
	type SocialFetch
} from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';
import SocialActions from '#lib/components/pages/curva/SocialActions.svelte';
import { curvaSocialApi, serverGateMessages } from '#lib/components/pages/curva/social.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const s1 = encodeS1(curve);
const apps: ClientApp[] = [];
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

afterEach(async () => {
	await cleanup();
	for (const app of apps.splice(0)) app.dispose();
	localStorage.removeItem(ORIGINS_KEY);
	vi.restoreAllMocks();
});

async function setup(
	respond: SocialFetch = async () => json({ items: [], nextCursor: null }),
	signedIn = true,
	verified = true
) {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	await app.state.ready;
	const fetcher = vi.fn<SocialFetch>(respond);
	const session = createSocialSession({
		initial: signedIn ? { id: 'u-ana', username: 'Ana', emailVerified: verified } : null
	});
	const clipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
	const screen = await render(SocialActions, {
		app,
		curve,
		name: 'Editor',
		locale: 'pt-BR',
		pageUrl: new URL('https://example.test/'),
		api: curvaSocialApi(fetcher),
		session,
		clipboard
	});
	return { app, fetcher, session, clipboard, screen };
}

test('account save is private and never edits or writes the cable', async () => {
	const { app, fetcher } = await setup(async () =>
		json({ lineageId: 'mine', versionId: 'v1', curveId: 'hash' }, 201)
	);
	const before = app.state.curve.current;
	await page.getByRole('button', { name: m.curva_social_save() }).click();
	await expect.element(page.getByRole('status').first()).toMatchTextContent(m.curva_social_saved());
	const request = fetcher.mock.calls.find(([url]) => url === '/api/v1/curves');
	expect(request?.[1].method).toBe('POST');
	expect(JSON.parse(String(request?.[1].body))).toMatchObject({
		visibility: 'private',
		envelope: { name: 'Editor', code: s1 }
	});
	expect(await originOf(s1)).toBeNull();
	expect(app.state.curve.current).toEqual(before);
	expect(app.pendingWrite).toBeNull();
});

test('publish displays server gate reasons and remembers only an approved 201', async () => {
	let approved = false;
	await setup(async (url) => {
		if (url.includes('/me/library')) return json({ items: [], nextCursor: null });
		return approved
			? json({ lineageId: 'published', versionId: 'v1', curveId: 'hash' }, 201)
			: json(
					{
						error: {
							code: 'GATE_REJECTED',
							details: { reasons: ['e:output-full', '<script>bad</script>'] }
						}
					},
					422
				);
	});
	await page.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('textbox', { name: m.curva_social_name() }).fill('Minha curva');
	await dialog.getByRole('textbox', { name: m.curva_social_description() }).fill('<b>Texto</b>');
	await dialog.getByRole('combobox', { name: m.curva_social_license() }).selectOptions('CC-BY-4.0');
	await dialog
		.getByRole('combobox', { name: m.curva_social_visibility() })
		.selectOptions('unlisted');
	await dialog.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
	await expect.element(dialog).toMatchTextContent(m.curva_social_gate());
	await expect.element(dialog).toMatchTextContent(m.curva_why_output_full());
	await expect.element(dialog).toMatchTextContent(m.curva_reason_unknown());
	expect(document.querySelector('script[src="bad"]')).toBeNull();
	expect(await originOf(s1)).toBeNull();
	approved = true;
	await dialog.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
	await vi.waitFor(async () => expect((await originOf(s1))?.lineageId).toBe('published'));
	await expect
		.element(page.getByRole('link', { name: m.curva_social_open() }))
		.toHaveAttribute('href', '/c/published');
});

test('a 200 response cannot claim publication or remember an origin', async () => {
	const { screen } = await setup(async () =>
		json({ lineageId: 'not-created', versionId: 'v1', curveId: 'hash' }, 200)
	);
	await page.getByRole('button', { name: m.curva_social_save() }).click();
	await vi.waitFor(() => expect(screen.container.textContent).toContain(m.curva_social_offline()));
	expect(screen.container.textContent).not.toContain(m.curva_social_saved());
	expect(await originOf(s1)).toBeNull();
});

test('origin actions favorite, unfavorite and share; edits hide them', async () => {
	await rememberOrigin({ s1, lineageId: 'community', versionId: 'original' });
	const { fetcher, clipboard, screen } = await setup(async (url, init) => {
		if (url.includes('/me/library')) return json({ items: [], nextCursor: null });
		if (url.endsWith('/favorite')) {
			return json({ favorited: init.method === 'PUT', created: true, removed: true });
		}
		return json({ shareId: 'short', url: 'https://untrusted.invalid/' }, 201);
	});
	await page.getByRole('button', { name: m.curva_social_favorite(), exact: true }).click();
	await page.getByRole('button', { name: m.curva_social_unfavorite(), exact: true }).click();
	expect(
		fetcher.mock.calls.filter(([url]) => url.endsWith('/favorite')).map(([, init]) => init.method)
	).toEqual(['PUT', 'DELETE']);
	await page.getByRole('button', { name: m.curva_social_share() }).click();
	await expect
		.element(page.getByRole('textbox', { name: m.curva_social_link() }))
		.toHaveValue('https://example.test/c/community?s=short');
	await page.getByRole('button', { name: m.curva_social_copy() }).click();
	expect(clipboard).toHaveBeenCalledWith('https://example.test/c/community?s=short');
	await screen.rerender({ curve: { ...curve, preampDb: -1 } });
	await tick();
	expect(screen.container.textContent).not.toContain(m.curva_social_favorite());
	expect(screen.container.textContent).not.toContain(m.curva_social_open());
	expect(screen.container.querySelector('.social input')).toBeNull();
});

test('an existing account favorite starts in the remove state', async () => {
	await rememberOrigin({ s1, lineageId: 'existing', versionId: 'v1' });
	await setup(async () => json({ items: [{ id: 'existing' }], nextCursor: null }));
	await expect
		.element(page.getByRole('button', { name: m.curva_social_unfavorite(), exact: true }))
		.toHaveAttribute('aria-pressed', 'true');
});

test.each([false, true])('account guards never write (%s)', async (signedIn) => {
	const { fetcher, screen } = await setup(undefined, signedIn, false);
	await expect.element(page.getByRole('button', { name: m.curva_social_save() })).toBeDisabled();
	await expect.element(page.getByRole('button', { name: m.curva_social_publish() })).toBeDisabled();
	expect(screen.container.textContent).toContain(
		signedIn ? m.curva_social_verify() : m.curva_social_login()
	);
	expect(fetcher).not.toHaveBeenCalled();
});

test('network failure is discreet and preserves local use and offline fallback', async () => {
	const { app, screen } = await setup(async () => {
		throw new TypeError('network');
	});
	await page.getByRole('button', { name: m.curva_social_save() }).click();
	await vi.waitFor(() => expect(screen.container.textContent).toContain(m.curva_social_offline()));
	expect(screen.container.textContent).toContain(m.curva_social_fallback());
	expect(app.state.curve.update({ preampDb: -1 })).toBe(true);
	expect(app.pendingWrite).toBeNull();
});

test.each([true, false])('origin hints require exact S1 bytes (%s)', async (matches) => {
	const { screen } = await setup(async () =>
		json({
			lineage: { id: 'linked', visibility: 'public' },
			version: { id: 'v1' },
			curve: {
				s1: matches ? s1 : encodeS1({ ...curve, preampDb: -1 }),
				gate: { ok: true }
			},
			items: [],
			nextCursor: null
		})
	);
	await screen.rerender({ originHint: { s1, lineageId: 'linked', versionId: 'v1' } });
	if (matches) await vi.waitFor(async () => expect((await originOf(s1))?.lineageId).toBe('linked'));
	else {
		await new Promise<void>((done) => setTimeout(done, 50));
		expect(await originOf(s1)).toBeNull();
	}
});

test('gate details map strings and structured stages without rendering arbitrary API text', () => {
	expect(
		serverGateMessages({ reasons: [{ code: 'c:section-peak', stage: 3 }, 'unknown'] })
	).toEqual([
		m.curva_why_section_peak({ where: m.curva_where_band_bare({ index: '3' }) }),
		m.curva_reason_unknown()
	]);
});
