import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { encodeS1 } from 'open-auri/share';
import { neutralCurve } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { createSocialApi, createSocialSession, originOf } from '#lib/social/index.ts';
import { createCurveSocial } from '#lib/components/pages/comparar/social.svelte.ts';
import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';
import SocialSources from '#lib/components/pages/comparar/SocialSources.svelte';
import SocialPublish from '#lib/components/pages/comparar/SocialPublish.svelte';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

function fixture(signedIn = true) {
	const curve = { ...neutralCurve(), name: 'Community tone' };
	const s1 = encodeS1(curve);
	const lineage = { id: 'social-lineage', head: { id: 'social-version', name: curve.name } };
	const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url) => {
		if (url.startsWith('/api/v1/curves/'))
			return Response.json({
				lineage,
				version: { id: lineage.head.id, name: curve.name },
				curve: { s1 }
			});
		if (url === '/api/v1/curves')
			return Response.json({
				lineageId: 'saved-lineage',
				versionId: 'saved-version',
				curveId: 'curve'
			});
		const library = url.includes('/me/library');
		return Response.json({ items: library ? [lineage] : [{ lineage }], nextCursor: null });
	});
	const session = createSocialSession({
		initial: signedIn ? { id: 'u-listener', username: 'listener', emailVerified: true } : null
	});
	return {
		curve,
		s1,
		fetcher,
		social: createCurveSocial(createSocialApi({ fetch: fetcher }), session)
	};
}

test('feed, rankings and private account library load exact curves and remember their origin', async () => {
	await setLocale('en-US', { reload: false });
	for (const source of ['feed', 'rankings', 'library']) {
		const { social, fetcher, s1 } = fixture();
		const onload = vi.fn();
		await render(SocialSources, { social, path: '/comparar', onload });
		await page
			.getByRole('combobox', { name: m.curve_social_sources(), exact: true })
			.selectOptions(source);
		await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
		await page
			.getByRole('combobox', { name: m.curve_social_choose(), exact: true })
			.selectOptions('social-lineage');
		await page.getByRole('button', { name: m.curve_social_add() }).click();
		await expect.poll(() => onload.mock.calls.length).toBe(1);
		expect(onload).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Community tone', source: 'community:social-lineage' })
		);
		expect(await originOf(s1)).toMatchObject({
			lineageId: 'social-lineage',
			versionId: 'social-version'
		});
		expect(fetcher.mock.calls[0]?.[0]).toContain(
			source === 'library' ? '/me/library' : source === 'rankings' ? '/rankings' : '/feed'
		);
		await cleanup();
	}
});

test('Comparar places a community curve in the chosen track without a cable write', async () => {
	await setLocale('en-US', { reload: false });
	const { social } = fixture();
	const screen = await render(CompararPage, { social, locale: 'en-US' });
	await page.getByRole('combobox', { name: m.curve_social_track() }).selectOptions('8');
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await page
		.getByRole('combobox', { name: m.curve_social_choose(), exact: true })
		.selectOptions('social-lineage');
	await page.getByRole('button', { name: m.curve_social_add() }).click();
	await expect
		.poll(() => screen.container.querySelectorAll('.lane')[7]?.textContent)
		.toContain('Community tone');
});

test('signed-out library prompts login and an unavailable API preserves local tools', async () => {
	const { social, fetcher } = fixture(false);
	await render(SocialSources, { social, path: '/comparar', onload: vi.fn() });
	await page
		.getByRole('combobox', { name: m.curve_social_sources(), exact: true })
		.selectOptions('library');
	await expect
		.element(page.getByRole('link', { name: m.curve_social_login() }))
		.toHaveAttribute('href', '/entrar?next=%2Fcomparar');
	expect(fetcher).not.toHaveBeenCalled();
	await page
		.getByRole('combobox', { name: m.curve_social_sources(), exact: true })
		.selectOptions('feed');
	fetcher.mockRejectedValueOnce(new TypeError('offline'));
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.curve_social_offline());
});

test('save is private; publishing exposes server gate feedback in localized messages', async () => {
	await setLocale('en-US', { reload: false });
	const { social, fetcher, curve } = fixture();
	await render(SocialPublish, { social, curve, path: '/comparar' });
	await page.getByRole('button', { name: m.curve_social_save() }).click();
	await expect
		.element(page.getByRole('combobox', { name: m.curve_social_visibility() }))
		.toHaveValue('private');
	await page.getByRole('button', { name: m.curve_social_submit() }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.curve_social_saved());
	const body: unknown = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
	expect(body).toMatchObject({
		visibility: 'private',
		envelope: { license: 'CC0-1.0', name: curve.name }
	});
	await page.getByRole('button', { name: m.curve_social_publish() }).click();
	await page.getByRole('combobox', { name: m.curve_social_license() }).selectOptions('CC-BY-4.0');
	fetcher.mockResolvedValueOnce(
		Response.json(
			{ error: { code: 'GATE_REJECTED', details: { reasons: ['g:preamp', 'b:unstable'] } } },
			{ status: 422 }
		)
	);
	await page.getByRole('button', { name: m.curve_social_submit() }).click();
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.curve_social_gate());
	await expect.element(page.getByText(m.comparar_reason_preamp(), { exact: true })).toBeVisible();
	await expect.element(page.getByText(m.comparar_reason_pole(), { exact: true })).toBeVisible();
	await page.getByRole('button', { name: m.curve_social_submit() }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.curve_social_published());
});

test('fields lock while sending and the message reports the visibility actually sent', async () => {
	await setLocale('en-US', { reload: false });
	const { social, fetcher, curve } = fixture();
	let finish: ((response: Response) => void) | undefined;
	fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
	await render(SocialPublish, { social, curve, path: '/comparar' });
	await page.getByRole('button', { name: m.curve_social_save() }).click();
	const visibility = page.getByRole('combobox', { name: m.curve_social_visibility() });
	await expect.element(visibility).toHaveValue('private');
	await page.getByRole('button', { name: m.curve_social_submit() }).click();
	await expect.element(page.getByRole('button', { name: m.curve_social_loading() })).toBeDisabled();
	await expect
		.element(page.getByRole('textbox', { name: m.curve_social_name(), exact: true }))
		.toBeDisabled();
	await expect
		.element(page.getByRole('textbox', { name: m.curve_social_description() }))
		.toBeDisabled();
	await expect
		.element(page.getByRole('combobox', { name: m.curve_social_license() }))
		.toBeDisabled();
	await expect.element(visibility).toBeDisabled();
	// Even a forced change during the request must not alter what the success message claims.
	const select = visibility.element();
	if (!(select instanceof HTMLSelectElement)) throw new Error('Missing visibility select');
	select.value = 'public';
	select.dispatchEvent(new Event('change', { bubbles: true }));
	finish?.(
		Response.json({ lineageId: 'held-lineage', versionId: 'held-version', curveId: 'curve' })
	);
	await expect.element(page.getByRole('status')).toHaveTextContent(m.curve_social_saved());
	await expect
		.element(page.getByText(m.curve_social_published(), { exact: true }))
		.not.toBeInTheDocument();
	const body: unknown = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
	expect(body).toMatchObject({ visibility: 'private' });
});

test('invalid URL-like names never send and offline publishing retains the dialog input', async () => {
	const { social, fetcher, curve } = fixture();
	await render(SocialPublish, { social, curve, path: '/comparar' });
	await page.getByRole('button', { name: m.curve_social_publish() }).click();
	await page.getByRole('textbox', { name: m.curve_social_name(), exact: true }).fill('example.com');
	await page.getByRole('button', { name: m.curve_social_submit() }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.curve_social_invalid());
	expect(fetcher).not.toHaveBeenCalled();
	await page.getByRole('textbox', { name: m.curve_social_name(), exact: true }).fill('My tone');
	fetcher.mockRejectedValueOnce(new TypeError('offline'));
	await page.getByRole('button', { name: m.curve_social_submit() }).click();
	await expect
		.element(page.getByRole('textbox', { name: m.curve_social_name(), exact: true }))
		.toHaveValue('My tone');
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await expect.element(page.getByRole('status').last()).toHaveTextContent(m.curve_social_offline());
});

test('source pages append, search case-insensitively and reset when the account shelf changes', async () => {
	const { social, fetcher } = fixture();
	fetcher.mockResolvedValueOnce(
		Response.json({
			items: [{ lineage: { id: 'first', head: { id: 'v1', name: 'Warm bass' } } }],
			nextCursor: 'next-page'
		})
	);
	fetcher.mockResolvedValueOnce(
		Response.json({
			items: [{ lineage: { id: 'second', head: { id: 'v2', name: 'Clear voice' } } }],
			nextCursor: null
		})
	);
	await render(SocialSources, { social, path: '/comparar', onload: vi.fn() });
	await expect.element(page.getByRole('button', { name: m.curve_social_add() })).toBeDisabled();
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await page.getByRole('button', { name: m.curve_social_more() }).click();
	expect(fetcher.mock.calls[1]?.[0]).toContain('cursor=next-page');
	await expect.element(page.getByRole('option', { name: 'Warm bass' })).toBeInTheDocument();
	await expect.element(page.getByRole('option', { name: 'Clear voice' })).toBeInTheDocument();
	await page.getByRole('searchbox').fill('VOICE');
	await expect.element(page.getByRole('option', { name: 'Warm bass' })).not.toBeInTheDocument();
	await expect.element(page.getByRole('option', { name: 'Clear voice' })).toBeInTheDocument();
	await page.getByRole('searchbox').fill('nothing matches');
	await expect.element(page.getByText(m.curve_social_empty(), { exact: true })).toBeVisible();
	await page.getByRole('searchbox').fill('');
	await page
		.getByRole('combobox', { name: m.curve_social_sources(), exact: true })
		.selectOptions('library');
	for (const shelf of ['favorites', 'installed']) {
		await page
			.getByRole('combobox', { name: m.curve_social_library(), exact: true })
			.selectOptions(shelf);
		await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
		await expect.element(page.getByRole('option', { name: 'Community tone' })).toBeInTheDocument();
		expect(fetcher.mock.calls.at(-1)?.[0]).toContain(`shelf=${shelf}`);
	}
});

test('source changes discard a late response and unlock controls for the next load', async () => {
	const { social, fetcher } = fixture();
	let finish: ((response: Response) => void) | undefined;
	fetcher.mockImplementationOnce(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	await render(SocialSources, { social, path: '/comparar', onload: vi.fn() });
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.curve_social_loading());
	await expect
		.element(page.getByRole('combobox', { name: m.curve_social_choose(), exact: true }))
		.toBeDisabled();
	await page
		.getByRole('combobox', { name: m.curve_social_sources(), exact: true })
		.selectOptions('rankings');
	finish?.(
		Response.json({
			items: [{ lineage: { id: 'late', head: { id: 'late-v', name: 'Stale tone' } } }],
			nextCursor: null
		})
	);
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await expect.element(page.getByRole('option', { name: 'Community tone' })).toBeInTheDocument();
	await expect.element(page.getByRole('option', { name: 'Stale tone' })).not.toBeInTheDocument();
});

test('empty pages and curve errors are visible; offline retry reloads public sources', async () => {
	const { social, fetcher } = fixture();
	const onload = vi.fn();
	fetcher.mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));
	await render(SocialSources, { social, path: '/comparar', onload });
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await expect.element(page.getByText(m.curve_social_empty(), { exact: true })).toBeVisible();
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await page
		.getByRole('combobox', { name: m.curve_social_choose(), exact: true })
		.selectOptions('social-lineage');
	fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
	await page.getByRole('button', { name: m.curve_social_add() }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.curve_social_failed());
	expect(onload).not.toHaveBeenCalled();
	fetcher.mockRejectedValueOnce(new TypeError('offline'));
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.curve_social_offline());
	await expect.element(page.getByRole('button', { name: m.curve_social_add() })).toBeDisabled();
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).last().click();
	await expect.element(page.getByRole('option', { name: 'Community tone' })).toBeInTheDocument();
	await expect
		.element(page.getByText(m.curve_social_offline(), { exact: true }))
		.not.toBeInTheDocument();
});
