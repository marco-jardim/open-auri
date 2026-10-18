import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import CreationInsights from '#lib/components/pages/biblioteca/CreationInsights.svelte';
import {
	SocialApiError,
	type MyShareItem,
	type SocialApi,
	type ShareFunnel
} from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
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

const emptyGroup = { total: 0, named: [], privateCount: 0 };
const emptyAudience = {
	audience: { previewed: emptyGroup, installed: emptyGroup, favorited: emptyGroup }
};
const share = (id: string): MyShareItem => ({
	id,
	lineage: { id: 'lin /1', name: 'Creation' },
	versionId: null,
	channel: 'link',
	createdAt: 0
});
const funnel = (shareId: string): ShareFunnel => ({
	shareId,
	opens: { total: 0, days: [] },
	attributed: { previewed: 0, installed: 0, favorited: 0 }
});

function fixtures() {
	const api = {
		audience: vi.fn<SocialApi['audience']>().mockResolvedValue(emptyAudience),
		myShares: vi.fn<SocialApi['myShares']>().mockResolvedValue({ items: [], nextCursor: null }),
		shareStats: vi.fn<SocialApi['shareStats']>().mockImplementation(async (id) => funnel(id)),
		createShare: vi
			.fn<SocialApi['createShare']>()
			.mockResolvedValue({ shareId: 'new /share', url: '/unused' })
	};
	return {
		api,
		lineageId: 'lin /1',
		name: '<b>Creation</b>',
		verified: true,
		origin: 'https://example.test'
	};
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`empty audience and funnel use localized copy, with no share action before verification (${locale})`, async () => {
		await setLocale(locale, { reload: false });
		const props = fixtures();
		const screen = await render(CreationInsights, { ...props, verified: false });
		await expect.element(page.getByText(m.biblioteca_social_funnel_empty())).toBeVisible();
		await expect.poll(() => screen.container.querySelectorAll('.total').length).toBe(3);
		expect(
			[...screen.container.querySelectorAll('.total')].map((node) => node.textContent)
		).toEqual(Array(3).fill(m.biblioteca_social_audience_total({ count: 0 })));
		expect(screen.container.querySelector('.audience ul')).toBeNull();
		expect(screen.container.querySelector('.private')).toBeNull();
		expect(screen.container.querySelector('b')).toBeNull();
		await expect.element(page.getByText(m.biblioteca_social_verify())).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: m.biblioteca_social_funnel_create() }))
			.not.toBeInTheDocument();
		expect(props.api.createShare).not.toHaveBeenCalled();
	});
}

test('audience, share discovery and individual stats each retain their loading state', async () => {
	const props = fixtures();
	const audience = deferred<Awaited<ReturnType<SocialApi['audience']>>>();
	const shares = deferred<Awaited<ReturnType<SocialApi['myShares']>>>();
	const stats = deferred<ShareFunnel>();
	props.api.audience.mockReturnValue(audience.promise);
	props.api.myShares.mockReturnValue(shares.promise);
	props.api.shareStats.mockReturnValue(stats.promise);
	const screen = await render(CreationInsights, props);
	expect(screen.container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);
	shares.resolve({ items: [share('existing')], nextCursor: null });
	await expect.element(page.getByRole('article')).toBeVisible();
	expect(screen.container.querySelector('article [aria-busy="true"]')).not.toBeNull();
	audience.resolve({
		audience: {
			previewed: {
				total: 3,
				privateCount: 2,
				named: [{ username: 'a /b', displayUsername: '<img> Person', at: 0 }]
			},
			installed: emptyGroup,
			favorited: emptyGroup
		}
	});
	await expect
		.element(page.getByRole('link', { name: '<img> Person' }))
		.toHaveAttribute('href', '/u/a%20%2Fb');
	await expect
		.element(page.getByText(m.biblioteca_social_audience_private({ count: 2 })))
		.toBeVisible();
	stats.resolve({
		...funnel('existing'),
		opens: { total: 7, days: [{ day: '2026-10-17', count: 7 }] },
		attributed: { previewed: 3, installed: 2, favorited: 1 }
	});
	await expect
		.element(page.getByText(m.biblioteca_social_funnel_opens({ count: 7 })))
		.toBeVisible();
	await expect
		.element(page.getByText(m.biblioteca_social_funnel_day({ day: '2026-10-17', count: 7 })))
		.toBeVisible();
	await expect
		.element(
			page.getByText(
				m.biblioteca_social_funnel_attributed({ previewed: 3, installed: 2, favorited: 1 })
			)
		)
		.toBeVisible();
	expect(screen.container.querySelector('[aria-busy="true"]')).toBeNull();
});

const errors = [
	{ code: 'OFFLINE', text: () => m.biblioteca_social_offline() },
	{ code: 'AUTH_REQUIRED', text: () => m.biblioteca_social_error_auth() },
	{ code: 'EMAIL_NOT_VERIFIED', text: () => m.biblioteca_social_verify() },
	{ code: 'RATE_LIMITED', text: () => m.biblioteca_social_error_rate() },
	{ code: 'NOT_FOUND', text: () => m.biblioteca_social_error_missing() },
	{ code: 'GATE_REJECTED', text: () => m.biblioteca_social_error_generic() }
] as const;

for (const target of ['audience', 'shares', 'stats', 'create'] as const) {
	for (const { code, text } of errors) {
		test(`${target} explains ${code} without losing the rest of the insights`, async () => {
			const props = fixtures();
			const error = new SocialApiError(400, code);
			if (target === 'audience') props.api.audience.mockRejectedValueOnce(error);
			if (target === 'shares') props.api.myShares.mockRejectedValueOnce(error);
			if (target === 'stats') {
				props.api.myShares.mockResolvedValueOnce({ items: [share('existing')], nextCursor: null });
				props.api.shareStats.mockRejectedValueOnce(error);
			}
			if (target === 'create') props.api.createShare.mockRejectedValueOnce(error);
			await render(CreationInsights, props);
			if (target === 'create')
				await page.getByRole('button', { name: m.biblioteca_social_funnel_create() }).click();
			await expect.element(page.getByRole('alert')).toHaveTextContent(text());
			await expect
				.element(page.getByRole('heading', { name: m.biblioteca_social_funnel_title() }))
				.toBeVisible();
			if (target === 'audience') {
				await page.getByRole('button', { name: m.biblioteca_social_retry() }).click();
				await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
				expect(props.api.audience).toHaveBeenCalledTimes(2);
			} else if (target === 'create') {
				await page.getByRole('button', { name: m.biblioteca_social_funnel_create() }).click();
				await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
				await expect
					.element(
						page.getByRole('link', {
							name: 'https://example.test/c/lin%20%2F1?s=new%20%2Fshare',
							exact: true
						})
					)
					.toBeVisible();
			}
		});
	}
}

test('creation locks the button and deduplicates a link returned by the in-flight share list', async () => {
	const props = fixtures();
	const creation = deferred<Awaited<ReturnType<SocialApi['createShare']>>>();
	const discovery = deferred<Awaited<ReturnType<SocialApi['myShares']>>>();
	props.api.createShare.mockReturnValue(creation.promise);
	props.api.myShares.mockReturnValue(discovery.promise);
	const screen = await render(CreationInsights, props);
	const button = page.getByRole('button', { name: m.biblioteca_social_funnel_create() });
	await button.click();
	await expect.element(button).toBeDisabled();
	(button.element() as HTMLButtonElement).click();
	expect(props.api.createShare).toHaveBeenCalledExactlyOnceWith({
		lineageId: props.lineageId,
		channel: 'link'
	});
	creation.resolve({ shareId: 'same', url: '/unused' });
	await expect.element(page.getByRole('article')).toBeVisible();
	discovery.resolve({ items: [share('same'), share('same')], nextCursor: null });
	await expect.element(button).toBeEnabled();
	await tick();
	expect(screen.container.querySelectorAll('article')).toHaveLength(1);
	expect(props.api.shareStats).toHaveBeenCalledTimes(1);
	// Re-creating an existing link moves it to the top without requesting its stats again.
	props.api.createShare.mockResolvedValue({ shareId: 'same', url: '/unused' });
	await button.click();
	expect(screen.container.querySelectorAll('article')).toHaveLength(1);
	expect(props.api.shareStats).toHaveBeenCalledTimes(1);
});

test('cancellation is silent for audience, discovery and stats', async () => {
	const props = fixtures();
	const abort = new DOMException('Cancelled', 'AbortError');
	props.api.audience.mockRejectedValueOnce(abort);
	props.api.myShares.mockRejectedValueOnce(abort);
	const screen = await render(CreationInsights, props);
	await tick();
	expect(screen.container.querySelector('[role="alert"]')).toBeNull();
	await screen.unmount();
	const next = fixtures();
	next.api.myShares.mockResolvedValue({ items: [share('existing')], nextCursor: null });
	next.api.shareStats.mockRejectedValueOnce(abort);
	await render(CreationInsights, next);
	await expect.element(page.getByRole('article')).toBeVisible();
	await tick();
	expect(page.getByRole('alert').query()).toBeNull();
});

for (const result of ['resolve', 'reject'] as const) {
	test(`stats ${result} after unmount is ignored and all request signals are aborted`, async () => {
		const props = fixtures();
		const pending = deferred<ShareFunnel>();
		props.api.myShares.mockResolvedValue({ items: [share('existing')], nextCursor: null });
		props.api.shareStats.mockReturnValue(pending.promise);
		const screen = await render(CreationInsights, props);
		await expect.poll(() => props.api.shareStats.mock.calls.length).toBe(1);
		const signals = [
			props.api.audience.mock.calls[0]?.[1]?.signal,
			props.api.myShares.mock.calls[0]?.[1]?.signal,
			props.api.shareStats.mock.calls[0]?.[1]?.signal
		];
		expect(signals.every((signal) => signal && !signal.aborted)).toBe(true);
		await screen.unmount();
		expect(signals.every((signal) => signal?.aborted)).toBe(true);
		if (result === 'resolve') pending.resolve(funnel('existing'));
		else pending.reject(new Error('late response'));
		await pending.promise.catch(() => undefined);
		await tick();
		expect(screen.container.querySelector('article')).toBeNull();
	});
}
