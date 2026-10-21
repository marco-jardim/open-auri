import { mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import ReportAction from '#lib/components/social/ReportAction.svelte';
import SocialSources from '#lib/components/pages/comparar/SocialSources.svelte';
import { createCurveSocial } from '#lib/components/pages/comparar/social.svelte.ts';
import { createSocialSession } from '#lib/social/index.ts';
import { VIEWER_CONTEXT, type Viewer } from '#lib/social/viewer-context.ts';
import type { FetchLike } from '#lib/components/chrome/account.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import {
	ANONYMOUS,
	apiWith,
	fakeFetch,
	feedItem,
	feedPage,
	json
} from '../pages/comunidade/fixtures.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`report action is named, on-demand and sign-in gated in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const fetch = vi.spyOn(globalThis, 'fetch');
		await render(ReportAction, {
			subject: { kind: 'user', id: 'ana.public' },
			name: 'Ana',
			session: ANONYMOUS,
			siteKey: 'site-key'
		});
		expect(page.getByTestId('report-panel').elements()).toHaveLength(0);
		await page.getByText(m.fxpc_report_item({ name: 'Ana' }), { exact: true }).click();
		await expect.element(page.getByText(m.fxpc_report_account(), { exact: true })).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: m.shared_curve_login() }))
			.toHaveAttribute('href', expect.stringMatching(/^\/entrar(?:\?next=%2F\S*)?$/));
		expect(document.getElementById('cf-turnstile-api')).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
}

test('comparison sources let the selected lineage be reported without loading it', async () => {
	const fetch = fakeFetch(() =>
		json(feedPage([feedItem({ id: 'lineage-id', name: 'Night radio' })]))
	);
	const api = apiWith(fetch);
	const session = createSocialSession({ initial: null });
	await render(SocialSources, {
		social: createCurveSocial(api, session),
		path: '/comparar',
		onload: vi.fn()
	});
	await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
	await page.getByRole('combobox', { name: m.curve_social_choose() }).selectOptions('lineage-id');
	await page.getByText(m.fxpc_report_item({ name: 'Night radio' }), { exact: true }).click();
	await expect.element(page.getByTestId('report-panel')).toBeVisible();
	await expect.element(page.getByText(m.fxpc_report_account(), { exact: true })).toBeVisible();
	expect(fetch).toHaveBeenCalledOnce();
});

/** Auth API answers: 503 for the first `failures` reads, then a signed-in verified user. */
function sessionFetch(failures: number, username = 'zoe') {
	let calls = 0;
	return vi.fn<FetchLike>(async () =>
		++calls <= failures
			? new Response('unavailable', { status: 503 })
			: json({ user: { id: `id-${username}`, username, emailVerified: true } })
	);
}

test('an unknown page session is the one refreshed: failure, retry and coming back online open the report', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const auth = sessionFetch(2);
	const session = createSocialSession({ fetch: auth });
	const fetch = vi.spyOn(globalThis, 'fetch');
	await render(ReportAction, {
		subject: { kind: 'lineage', id: 'curve' },
		name: 'Night radio',
		author: 'ana',
		session,
		siteKey: ''
	});
	await page.getByText(m.fxpc_report_item({ name: 'Night radio' }), { exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.w4r1_report_session_error());
	expect(auth).toHaveBeenCalledOnce();
	// Report-specific copy, never the hidden-items messages.
	expect(page.getByText(m.hidden_error()).elements()).toHaveLength(0);
	expect(page.getByText(m.hidden_loading()).elements()).toHaveLength(0);
	await page.getByRole('button', { name: m.w4r1_report_retry(), exact: true }).click();
	await expect.poll(() => auth.mock.calls.length).toBe(2);
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.w4r1_report_session_error());
	expect(session.known).toBe(false);
	window.dispatchEvent(new Event('online'));
	await expect.element(page.getByTestId('report-panel')).toBeVisible();
	expect(auth).toHaveBeenCalledTimes(3);
	expect(session.known).toBe(true);
	expect(session.verified).toBe(true);
	await expect
		.element(page.getByText(m.comunidade_report_target({ name: 'Night radio' }), { exact: true }))
		.toBeVisible();
	// The action's own fallback session was never used: only the given session read the API.
	expect(fetch).not.toHaveBeenCalled();
});

test('a closed report action does not probe the session when the network comes back', async () => {
	const auth = sessionFetch(0);
	await render(ReportAction, {
		subject: { kind: 'lineage', id: 'curve' },
		name: 'Night radio',
		session: createSocialSession({ fetch: auth }),
		siteKey: ''
	});
	window.dispatchEvent(new Event('online'));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(auth).not.toHaveBeenCalled();
});

function mountWithViewer(viewer: Viewer, props: Record<string, unknown>) {
	const target = document.createElement('div');
	document.body.append(target);
	const instance = mount(ReportAction, {
		target,
		props: {
			subject: { kind: 'lineage', id: 'mine' },
			name: 'Mine',
			author: 'ANA',
			session: ANONYMOUS,
			siteKey: '',
			...props
		} as never,
		context: new Map([[VIEWER_CONTEXT, viewer]])
	});
	return {
		target,
		destroy: async () => {
			await unmount(instance);
			target.remove();
		}
	};
}

test('prerendered pages read the viewer from the layout: own content known up front shows no Report', async () => {
	const layout = createSocialSession({
		initial: { id: 'me', username: 'Ana', emailVerified: true }
	});
	const viewer: Viewer = {
		get current() {
			return layout.account;
		},
		get known() {
			return layout.known;
		}
	};
	const own = mountWithViewer(viewer, {});
	const other = mountWithViewer(viewer, { author: 'zoe', name: 'Theirs' });
	try {
		await expect
			.element(page.getByText(m.fxpc_report_item({ name: 'Theirs' }), { exact: true }))
			.toBeVisible();
		expect(own.target.querySelector('details')).toBeNull();
	} finally {
		await own.destroy();
		await other.destroy();
	}
});

test('content found to be own after opening keeps the focused drawer mounted and says it is yours', async () => {
	const layout = createSocialSession();
	const viewer: Viewer = {
		get current() {
			return layout.account;
		},
		get known() {
			return layout.known;
		}
	};
	const screen = mountWithViewer(viewer, {});
	try {
		const summary = page.getByText(m.fxpc_report_item({ name: 'Mine' }), { exact: true });
		await summary.click();
		await expect.element(page.getByText(m.fxpc_report_account(), { exact: true })).toBeVisible();
		const details = screen.target.querySelector('details')!;
		const element = summary.element() as HTMLElement;
		element.focus();
		expect(details.open).toBe(true);
		// The layout's session probe answers only now: the item is the viewer's own.
		layout.set({ id: 'me', username: 'Ana', emailVerified: true });
		await expect.element(page.getByText(m.w4r1_report_own(), { exact: true })).toBeVisible();
		expect(screen.target.querySelector('details')).toBe(details);
		expect(details.open).toBe(true);
		expect(document.activeElement).toBe(element);
		expect(page.getByTestId('report-panel').elements()).toHaveLength(0);
	} finally {
		await screen.destroy();
	}
});

test('a drawer only focused before the viewer is known also stays mounted', async () => {
	const layout = createSocialSession();
	const viewer: Viewer = {
		get current() {
			return layout.account;
		},
		get known() {
			return layout.known;
		}
	};
	const screen = mountWithViewer(viewer, {});
	try {
		const summary = page.getByText(m.fxpc_report_item({ name: 'Mine' }), { exact: true });
		await expect.element(summary).toBeVisible();
		const element = summary.element() as HTMLElement;
		element.focus();
		layout.set({ id: 'me', username: 'Ana', emailVerified: true });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.target.querySelector('summary')).toBe(element);
		expect(document.activeElement).toBe(element);
	} finally {
		await screen.destroy();
	}
});

test('comparison social reads an unknown session again on retry and when the network comes back', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const auth = sessionFetch(2);
	const session = createSocialSession({ fetch: auth });
	const social = createCurveSocial(apiWith(fakeFetch(() => undefined)), session);
	const stop = social.mount();
	try {
		await expect.poll(() => auth.mock.calls.length).toBe(1);
		expect(session.known).toBe(false);
		social.retry();
		await expect.poll(() => auth.mock.calls.length).toBe(2);
		expect(session.known).toBe(false);
		window.dispatchEvent(new Event('online'));
		await expect.poll(() => session.known).toBe(true);
		expect(session.nickname).toBe('zoe');
		expect(auth).toHaveBeenCalledTimes(3);
		// Known: neither another online event nor a retry reads it again.
		window.dispatchEvent(new Event('online'));
		social.retry();
		expect(auth).toHaveBeenCalledTimes(3);
	} finally {
		stop();
	}
});
