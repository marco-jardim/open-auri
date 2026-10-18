import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import {
	createSocialSession,
	ORIGINS_KEY,
	originOf,
	rememberOrigin,
	SocialApiError,
	type SocialFetch
} from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';
import SocialActions from '#lib/components/pages/curva/SocialActions.svelte';
import { curvaSocialApi } from '#lib/components/pages/curva/social.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const s1 = encodeS1(curve);
const apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps.splice(0)) app.dispose();
	localStorage.removeItem(ORIGINS_KEY);
	vi.restoreAllMocks();
});

async function setup(
	respond: SocialFetch = async () => Response.json({ items: [], nextCursor: null })
) {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	await app.state.ready;
	const fetcher = vi.fn<SocialFetch>(respond);
	const api = curvaSocialApi(fetcher);
	const session = createSocialSession({
		initial: { id: 'u-branches', username: 'Listener', emailVerified: true }
	});
	const clipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
	const screen = await render(SocialActions, {
		app,
		curve,
		name: 'Editor snapshot',
		locale: 'en-US',
		pageUrl: new URL('https://example.test/?view=eq'),
		api,
		session,
		clipboard
	});
	return { app, api, fetcher, session, clipboard, screen };
}

test.each([
	{
		error: new SocialApiError(401, 'AUTH_REQUIRED'),
		message: () => m.curva_social_login(),
		reason: () => m.curva_v2_social_login_reason()
	},
	{
		error: new SocialApiError(403, 'EMAIL_NOT_VERIFIED'),
		message: () => m.curva_social_verify(),
		reason: () => m.curva_v2_social_verify_reason()
	},
	{
		error: new SocialApiError(429, 'RATE_LIMITED'),
		message: () => m.curva_social_limit(),
		reason: () => null
	},
	{
		error: new SocialApiError(409, 'QUOTA_EXCEEDED'),
		message: () => m.curva_social_limit(),
		reason: () => null
	},
	{
		error: new SocialApiError(403, 'FORBIDDEN'),
		message: () => m.curva_social_error(),
		reason: () => null
	},
	{ error: new Error('unexpected'), message: () => m.curva_social_error(), reason: () => null },
	{
		error: new SocialApiError(503, 'INTERNAL'),
		message: () => m.curva_social_offline(),
		reason: () => m.curva_v2_social_offline_reason()
	}
])(
	'account save handles $error without editing or writing the cable',
	async ({ error, message, reason }) => {
		const { app, api, screen } = await setup();
		vi.spyOn(api, 'publishCurve').mockRejectedValueOnce(error);
		const before = structuredClone(app.state.curve.current);
		await page.getByRole('button', { name: m.curva_social_save(), exact: true }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('button', { name: m.cvedit_save_confirm(), exact: true }).click();
		await expect.poll(() => screen.container.textContent).toContain(message());
		// The dialog keeps the text for a retry; closing it shows why the panel action waits.
		await dialog.getByRole('button', { name: m.curva_social_cancel() }).click();
		const save = page.getByRole('button', { name: m.curva_social_save(), exact: true });
		const why = reason();
		if (why) {
			await expect.element(save).toHaveAttribute('aria-disabled', 'true');
			await expect.element(save).toHaveAccessibleDescription(why);
		} else await expect.element(save).not.toHaveAttribute('aria-disabled');
		expect(app.state.curve.current).toEqual(before);
		expect(app.pendingWrite).toBeNull();
	}
);

test('loading, unencodable curves and offline events each explain unavailable account actions', async () => {
	const { screen, api, session } = await setup();
	const publish = vi.spyOn(api, 'publishCurve');
	const save = page.getByRole('button', { name: m.curva_social_save(), exact: true });
	await screen.rerender({ app: null });
	await expect.element(save).toHaveAccessibleDescription(m.curva_v2_loading_reason());
	const app = apps[0];
	if (!app) throw new Error('Missing client app');
	await screen.rerender({ app, curve: { ...curve, preampDb: Number.NaN } });
	await expect.element(save).toHaveAccessibleDescription(m.curva_v2_social_code_reason());
	await screen.rerender({ curve });
	window.dispatchEvent(new Event('offline'));
	await expect.element(save).toHaveAccessibleDescription(m.curva_v2_social_offline_reason());
	const refresh = vi.spyOn(session, 'refresh').mockResolvedValue(session.account);
	window.dispatchEvent(new Event('online'));
	await expect.element(save).not.toHaveAttribute('aria-disabled');
	expect(refresh).toHaveBeenCalledOnce();
	expect(publish).not.toHaveBeenCalled();
});

test('publish freezes its draft, locks fields and cancellation while busy, and saves the chosen visibility', async () => {
	const { api, screen } = await setup();
	let finish: ((value: Awaited<ReturnType<typeof api.publishCurve>>) => void) | undefined;
	const publish = vi.spyOn(api, 'publishCurve').mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	await page.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
	const dialog = page.getByRole('dialog');
	const nativeDialog = dialog.element();
	if (!(nativeDialog instanceof HTMLDialogElement)) throw new Error('Missing publish dialog');
	expect(nativeDialog.open).toBe(true);
	await dialog.getByRole('textbox', { name: m.curva_social_name() }).fill('Private draft');
	await dialog
		.getByRole('textbox', { name: m.curva_social_description() })
		.fill('Snapshot description');
	await dialog.getByRole('combobox', { name: m.curva_social_license() }).selectOptions('CC-BY-4.0');
	await dialog
		.getByRole('combobox', { name: m.curva_social_visibility() })
		.selectOptions('private');
	await screen.rerender({ curve: { ...curve, preampDb: -1 }, name: 'Changed editor' });
	await dialog.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
	expect(publish).toHaveBeenCalledWith(
		expect.objectContaining({
			visibility: 'private',
			envelope: expect.objectContaining({
				code: s1,
				name: 'Private draft',
				description: 'Snapshot description',
				license: 'CC-BY-4.0'
			})
		})
	);
	for (const field of [
		dialog.getByRole('textbox', { name: m.curva_social_name() }),
		dialog.getByRole('textbox', { name: m.curva_social_description() }),
		dialog.getByRole('combobox', { name: m.curva_social_license() }),
		dialog.getByRole('combobox', { name: m.curva_social_visibility() })
	])
		await expect.element(field).toBeDisabled();
	await expect
		.element(dialog.getByRole('button', { name: m.curva_social_cancel() }))
		.toHaveAccessibleDescription(m.curva_v2_social_busy_reason());
	await expect
		.element(page.getByRole('button', { name: m.curva_social_save(), exact: true }))
		.toHaveAccessibleDescription(m.curva_v2_social_busy_reason());
	const cancel = new Event('cancel', { cancelable: true });
	dialog.element().dispatchEvent(cancel);
	expect(cancel.defaultPrevented).toBe(true);
	finish?.({ lineageId: 'private-draft', versionId: 'v1', curveId: 'hash' });
	await expect.poll(() => nativeDialog.open).toBe(false);
	await expect.element(nativeDialog).not.toBeVisible();
	await expect.poll(() => screen.container.textContent).toContain(m.curva_social_saved());
	expect(await originOf(s1)).toBeNull();
});

test('closing a gate-rejected dialog preserves localized feedback outside it and reopening resets the draft', async () => {
	const { api } = await setup();
	vi.spyOn(api, 'publishCurve').mockRejectedValueOnce(
		new SocialApiError(422, 'GATE_REJECTED', { reasons: ['e:output-full'] })
	);
	await page.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
	const dialog = page.getByRole('dialog');
	const nativeDialog = dialog.element();
	if (!(nativeDialog instanceof HTMLDialogElement)) throw new Error('Missing publish dialog');
	expect(nativeDialog.open).toBe(true);
	await dialog.getByRole('textbox', { name: m.curva_social_name() }).fill('Rejected draft');
	await dialog.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
	await expect.element(dialog).toMatchTextContent(m.curva_social_gate());
	await dialog.getByRole('button', { name: m.curva_social_cancel() }).click();
	await expect.poll(() => nativeDialog.open).toBe(false);
	await expect.element(nativeDialog).not.toBeVisible();
	await expect.element(page.getByRole('status').first()).toMatchTextContent(m.curva_social_gate());
	await expect
		.element(page.getByRole('status').first())
		.toMatchTextContent(m.curva_why_output_full());
	await page.getByRole('button', { name: m.curva_social_publish(), exact: true }).click();
	await expect.poll(() => nativeDialog.open).toBe(true);
	await expect
		.element(dialog.getByRole('textbox', { name: m.curva_social_name() }))
		.toHaveValue('Editor snapshot');
	expect(dialog.getByRole('status').element().textContent?.trim()).toBe('');
	const cancel = new Event('cancel', { cancelable: true });
	dialog.element().dispatchEvent(cancel);
	expect(cancel.defaultPrevented).toBe(false);
});

test.each(['lineage', 'version', 'gate', 'private'] as const)(
	'origin hints reject a mismatched %s',
	async (mismatch) => {
		const { api, screen } = await setup(async () =>
			Response.json({
				lineage: {
					id: mismatch === 'lineage' ? 'other' : 'hinted',
					visibility: mismatch === 'private' ? 'private' : 'public'
				},
				version: { id: mismatch === 'version' ? 'other' : 'v1' },
				curve: { s1, gate: { ok: mismatch !== 'gate' } }
			})
		);
		const get = vi.spyOn(api, 'getCurve');
		await screen.rerender({ originHint: { s1, lineageId: 'hinted', versionId: 'v1' } });
		await expect.poll(() => get.mock.calls.length).toBe(1);
		await get.mock.results[0]?.value;
		await tick();
		expect(await originOf(s1)).toBeNull();
		await expect
			.element(page.getByRole('link', { name: m.curva_social_open() }))
			.not.toBeInTheDocument();
	}
);

test('favorite lookup paginates to a match and stops a repeated cursor without blocking sharing', async () => {
	await rememberOrigin({ s1, lineageId: 'existing', versionId: 'v1' });
	const { fetcher } = await setup(async (url) =>
		Response.json(
			url.includes('cursor=next')
				? { items: [{ id: 'existing' }], nextCursor: null }
				: { items: [], nextCursor: 'next' }
		)
	);
	await expect
		.element(page.getByRole('button', { name: m.curva_social_unfavorite(), exact: true }))
		.toHaveAttribute('aria-pressed', 'true');
	expect(fetcher.mock.calls.filter(([url]) => url.includes('/me/library'))).toHaveLength(2);
	await cleanup();
	const second = await setup(async () => Response.json({ items: [], nextCursor: 'cycle' }));
	await expect
		.element(page.getByRole('button', { name: m.curva_social_favorite(), exact: true }))
		.not.toHaveAttribute('aria-disabled');
	expect(second.fetcher.mock.calls.filter(([url]) => url.includes('/me/library'))).toHaveLength(2);
});

test('loading favorites explains the lock, errors preserve origin actions, and short links survive clipboard failure', async () => {
	await rememberOrigin({ s1, lineageId: 'community-one', versionId: 'v1' });
	let finish: ((response: Response) => void) | undefined;
	const { api, clipboard, screen } = await setup(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	const favorite = page.getByRole('button', { name: m.curva_social_favorite(), exact: true });
	await expect.element(favorite).toHaveAccessibleDescription(m.curva_v2_social_busy_reason());
	finish?.(Response.json({ items: [], nextCursor: null }));
	await expect.element(favorite).not.toHaveAttribute('aria-disabled');
	vi.spyOn(api, 'favorite').mockRejectedValueOnce(new SocialApiError(403, 'FORBIDDEN'));
	await favorite.click();
	await expect.poll(() => screen.container.textContent).toContain(m.curva_social_error());
	const share = vi
		.spyOn(api, 'createShare')
		.mockRejectedValueOnce(new Error('share refused'))
		.mockResolvedValueOnce({ shareId: 'short /id', url: 'https://untrusted.invalid/' });
	await page.getByRole('button', { name: m.curva_social_share() }).click();
	await expect.poll(() => share.mock.calls.length).toBe(1);
	await expect
		.element(page.getByRole('button', { name: m.curva_social_share() }))
		.not.toHaveAttribute('aria-disabled');
	await page.getByRole('button', { name: m.curva_social_share() }).click();
	const link = page.getByRole('textbox', { name: m.curva_social_link() });
	const expected = 'https://example.test/c/community-one?s=short%20%2Fid';
	await expect.element(link).toHaveValue(expected);
	const input = link.element();
	if (!(input instanceof HTMLInputElement)) throw new Error('Missing short link');
	input.focus();
	expect(input.selectionStart).toBe(0);
	expect(input.selectionEnd).toBe(expected.length);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	clipboard
		.mockRejectedValueOnce(new Error('clipboard denied'))
		.mockRejectedValueOnce('clipboard denied');
	for (let attempt = 0; attempt < 2; attempt++) {
		await page.getByRole('button', { name: m.curva_social_copy() }).click();
		await expect.poll(() => screen.container.textContent).toContain(m.curva_link_copy_failed());
	}
	await expect.element(link).toHaveValue(expected);
});
