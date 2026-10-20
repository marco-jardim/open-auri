import { afterEach, describe, expect, test, vi } from 'vitest';
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
import { setLocale } from '#lib/paraglide/runtime.js';
import { NATIVE_BACK_EVENT } from '#lib/components/chrome/native-back.ts';
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
	vi.unstubAllGlobals();
	await setLocale('pt-BR', { reload: false });
});

function pressBack(): boolean {
	return !window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT, { cancelable: true }));
}

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

test.each(['save', 'publish'] as const)(
	'Android Back closes the Curva %s dialog and unregisters on reopen and unmount',
	async (mode) => {
		vi.stubGlobal('Capacitor', {
			isNativePlatform: () => true,
			getPlatform: () => 'android'
		});
		await setLocale('pt-BR', { reload: false });
		const { fetcher } = await setup();
		const trigger = page.getByRole('button', {
			name: mode === 'save' ? m.curva_social_save() : m.curva_social_publish(),
			exact: true
		});
		await trigger.click();
		const dialog = page.getByRole('dialog');
		await expect.element(dialog).toBeVisible();
		await dialog.getByRole('textbox', { name: m.curva_social_description() }).fill('Rascunho');
		expect(pressBack()).toBe(true);
		// A closed <dialog> leaves the accessibility tree, so its role locator finds nothing.
		await expect.poll(() => document.querySelector('dialog[open]')).toBeNull();
		expect(pressBack()).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
		await trigger.click();
		await expect.element(dialog).toBeVisible();
		expect(pressBack()).toBe(true);
		// A closed <dialog> leaves the accessibility tree, so its role locator finds nothing.
		await expect.poll(() => document.querySelector('dialog[open]')).toBeNull();
		await trigger.click();
		await expect.element(dialog).toBeVisible();
		await cleanup();
		expect(pressBack()).toBe(false);
	}
);

test('a busy Curva dialog consumes Android Back and keeps its draft until the request settles', async () => {
	vi.stubGlobal('Capacitor', {
		isNativePlatform: () => true,
		getPlatform: () => 'android'
	});
	await setLocale('pt-BR', { reload: false });
	let finish: (response: Response) => void = () => undefined;
	const response = new Promise<Response>((resolve) => (finish = resolve));
	await setup(() => response);
	await page.getByRole('button', { name: m.curva_social_save() }).click();
	const dialog = page.getByRole('dialog');
	const description = dialog.getByRole('textbox', { name: m.curva_social_description() });
	await description.fill('Rascunho ocupado');
	await dialog.getByRole('button', { name: m.cvedit_save_confirm(), exact: true }).click();
	await expect.element(description).toBeDisabled();
	for (let press = 0; press < 3; press += 1) expect(pressBack()).toBe(true);
	await expect.element(dialog).toBeVisible();
	await expect.element(description).toHaveValue('Rascunho ocupado');
	finish(json({ error: { code: 'INVALID_CURVE' } }, 422));
	await expect.element(description).not.toBeDisabled();
	expect(pressBack()).toBe(true);
	// A closed <dialog> leaves the accessibility tree, so its role locator finds nothing.
	await expect.poll(() => document.querySelector('dialog[open]')).toBeNull();
	expect(pressBack()).toBe(false);
});

test('outside Android the Curva dialog does not register Back', async () => {
	vi.stubGlobal('Capacitor', undefined);
	await setup();
	await page.getByRole('button', { name: m.curva_social_save() }).click();
	await expect.element(page.getByRole('dialog')).toBeVisible();
	expect(pressBack()).toBe(false);
	await expect.element(page.getByRole('dialog')).toBeVisible();
});

test('account save asks for the text, is private and never edits or writes the cable', async () => {
	const { app, fetcher } = await setup(async () =>
		json({ lineageId: 'mine', versionId: 'v1', curveId: 'hash' }, 201)
	);
	const before = app.state.curve.current;
	await page.getByRole('button', { name: m.curva_social_save() }).click();
	const dialog = page.getByRole('dialog');
	await expect
		.element(dialog.getByRole('textbox', { name: m.curva_social_name() }))
		.toHaveValue('Editor');
	expect(fetcher.mock.calls.some(([url]) => url === '/api/v1/curves')).toBe(false);
	await dialog.getByRole('button', { name: m.cvedit_save_confirm(), exact: true }).click();
	await expect.element(page.getByRole('status').first()).toMatchTextContent(m.curva_social_saved());
	const request = fetcher.mock.calls.find(([url]) => url === '/api/v1/curves');
	expect(request?.[1].method).toBe('POST');
	expect(JSON.parse(String(request?.[1].body))).toMatchObject({
		visibility: 'private',
		envelope: { name: 'Editor', description: '', code: s1 }
	});
	expect(await originOf(s1)).toBeNull();
	expect(app.state.curve.current).toEqual(before);
	expect(app.pendingWrite).toBeNull();
});

test.each(['unlisted', 'public', 'private'])(
	'publish opens unlisted and submits the chosen visibility (%s)',
	async (chosen) => {
		const { fetcher } = await setup(async (url) =>
			url.includes('/me/library')
				? json({ items: [], nextCursor: null })
				: json({ lineageId: 'published', versionId: 'v1', curveId: 'hash' }, 201)
		);
		await page.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
		const dialog = page.getByRole('dialog');
		const visibility = dialog.getByRole('combobox', { name: m.curva_social_visibility() });
		await expect.element(visibility).toHaveValue('unlisted');
		if (chosen !== 'unlisted') await visibility.selectOptions(chosen);
		await dialog.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
		await expect
			.element(page.getByRole('status').first())
			.toMatchTextContent(
				chosen === 'private' ? m.curva_social_saved() : m.curva_social_published()
			);
		const request = fetcher.mock.calls.find(([url]) => url === '/api/v1/curves');
		expect(JSON.parse(String(request?.[1].body))).toMatchObject({ visibility: chosen });
	}
);

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
	await page
		.getByRole('dialog')
		.getByRole('button', { name: m.cvedit_save_confirm(), exact: true })
		.click();
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
	// Unavailable, focusable and saying why (T8); a press does nothing.
	const why = signedIn ? m.curva_v2_social_verify_reason() : m.curva_v2_social_login_reason();
	for (const name of [m.curva_social_save(), m.curva_social_publish()]) {
		const button = page.getByRole('button', { name, exact: true });
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
		await expect.element(button).toHaveAccessibleDescription(why);
		const element = button.element();
		if (element instanceof HTMLElement) element.click();
	}
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
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
	await page
		.getByRole('dialog')
		.getByRole('button', { name: m.cvedit_save_confirm(), exact: true })
		.click();
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

describe('a verified link origin brings its version labels (never through #p=)', () => {
	const LABELS = ['Grave', null, 'Presença', null, null, null, null, null, null, 'Ar'];
	/** The public version of `l`/`v`, preset@2 with labels, whose S1 is `code`. */
	const version = (code: string) => async () =>
		json({
			lineage: { id: 'linked', visibility: 'public' },
			version: { id: 'v1', labels: LABELS },
			curve: { s1: code, gate: { ok: true } },
			items: [],
			nextCursor: null
		});
	/** What "Abrir na Curva" leaves in the editor: the decoded `#p=` curve, without labels. */
	function loadLink(app: ClientApp, preampDb = curve.preampDb) {
		expect(
			app.state.curve.set({
				name: 'Link',
				source: 'import',
				preampDb,
				bands: curve.bands,
				labels: null
			})
		).toBe(true);
	}

	test('lineage, version and S1 match: the editor curve gets the labels, its S1 unchanged', async () => {
		const { app, screen } = await setup(version(s1));
		loadLink(app);
		await screen.rerender({ originHint: { s1, lineageId: 'linked', versionId: 'v1' } });
		await vi.waitFor(() => expect(app.state.curve.current.labels).toEqual(LABELS));
		expect(encodeS1(app.state.curve.current)).toBe(s1);
		expect(app.state.curve.current.name).toBe('Link');
		expect(app.pendingWrite).toBeNull();
	});

	test('a version with another S1 brings nothing', async () => {
		const { app, screen } = await setup(version(encodeS1({ ...curve, preampDb: -1 })));
		loadLink(app);
		await screen.rerender({ originHint: { s1, lineageId: 'linked', versionId: 'v1' } });
		await new Promise<void>((done) => setTimeout(done, 50));
		expect(app.state.curve.current.labels).toBeNull();
	});

	test('an edit since the link loaded wins: no labels on a curve that is no longer that S1', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((done) => {
			release = done;
		});
		const respond = version(s1);
		const { app, screen } = await setup(async () => {
			await gate;
			return respond();
		});
		loadLink(app);
		await screen.rerender({ originHint: { s1, lineageId: 'linked', versionId: 'v1' } });
		// The person edits before the origin check answers.
		loadLink(app, -1);
		await screen.rerender({ curve: { ...curve, preampDb: -1 } });
		release();
		await vi.waitFor(async () => expect((await originOf(s1))?.lineageId).toBe('linked'));
		await new Promise<void>((done) => setTimeout(done, 20));
		expect(app.state.curve.current.labels).toBeNull();
	});

	test('a same-S1 preset loaded while the check is pending never takes the labels', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((done) => {
			release = done;
		});
		const respond = version(s1);
		const { app, screen } = await setup(async () => {
			await gate;
			return respond();
		});
		loadLink(app);
		await screen.rerender({ originHint: { s1, lineageId: 'linked', versionId: 'v1' } });
		// Neutro is the link's exact S1, unlabeled: only the store curve's identity tells them apart.
		expect(app.loadNeutral()).toBe(true);
		expect(encodeS1(app.state.curve.current)).toBe(s1);
		expect(app.state.curve.current.labels).toBeNull();
		release();
		await vi.waitFor(async () => expect((await originOf(s1))?.lineageId).toBe('linked'));
		await new Promise<void>((done) => setTimeout(done, 20));
		expect(app.state.curve.current.labels).toBeNull();
		expect(app.state.curve.current.source).toBe(`preset:${NEUTRO.id}`);
	});

	test('a retry after a reconnect still compares with the curve the link loaded', async () => {
		let attempt = 0;
		const respond = version(s1);
		const { app, screen, session } = await setup(async () => {
			attempt++;
			if (attempt === 1) throw new TypeError('network');
			return respond();
		});
		loadLink(app);
		await screen.rerender({ originHint: { s1, lineageId: 'linked', versionId: 'v1' } });
		await vi.waitFor(() =>
			expect(screen.container.textContent).toContain(m.curva_social_offline())
		);
		expect(attempt).toBe(1);
		// The same S1, unlabeled, loaded before the connection comes back.
		expect(app.loadNeutral()).toBe(true);
		const refresh = vi.spyOn(session, 'refresh').mockResolvedValue(session.account);
		window.dispatchEvent(new Event('online'));
		expect(refresh).toHaveBeenCalledOnce();
		await vi.waitFor(async () => expect((await originOf(s1))?.lineageId).toBe('linked'));
		await new Promise<void>((done) => setTimeout(done, 20));
		expect(app.state.curve.current.labels).toBeNull();
	});

	test('a rename since the link loaded wins over the version labels', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((done) => {
			release = done;
		});
		const respond = version(s1);
		const { app, screen } = await setup(async () => {
			await gate;
			return respond();
		});
		loadLink(app);
		await screen.rerender({ originHint: { s1, lineageId: 'linked', versionId: 'v1' } });
		const mine = ['Meu', null, null, null, null, null, null, null, null, null];
		expect(app.state.curve.setLabels(mine)).toBe(true);
		release();
		await vi.waitFor(async () => expect((await originOf(s1))?.lineageId).toBe('linked'));
		await new Promise<void>((done) => setTimeout(done, 20));
		expect(app.state.curve.current.labels).toEqual(mine);
	});
});

test('gate details map strings and structured stages without rendering arbitrary API text', () => {
	expect(
		serverGateMessages({ reasons: [{ code: 'c:section-peak', stage: 3 }, 'unknown'] })
	).toEqual([
		m.curva_why_section_peak({ where: m.curva_where_band_bare({ index: '3' }) }),
		m.curva_reason_unknown()
	]);
});
