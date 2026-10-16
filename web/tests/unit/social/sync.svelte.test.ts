import { createRawSnippet, flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import SocialSync, { type SocialSyncStatus } from '#lib/components/social/SocialSync.svelte';
import {
	createSocialSession,
	type FlushReport,
	type QueuedActivity,
	type SocialApi,
	type SocialOutbox
} from '#lib/social/index.ts';

afterEach(async () => {
	await cleanup();
});

function fakeOutbox(pendingCount = 0) {
	const report: FlushReport = {
		status: 'done',
		sent: 0,
		removed: 0,
		dropped: 0,
		kept: pendingCount
	};
	const flush = vi.fn<SocialOutbox['flush']>(async () => report);
	const queued: QueuedActivity[] = [];
	const pending = vi.fn<SocialOutbox['pending']>(async () => queued);
	return { flush, pending, queued };
}

const api: Pick<SocialApi, 'postActivityOutbox'> = {
	postActivityOutbox: async () => ({ results: [] })
};

test('flushes on mount, on "online" and when the tab becomes visible', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: { username: 'Ana', emailVerified: true } });
	await render(SocialSync, { session, api, outbox });
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(1));
	expect(outbox.flush).toHaveBeenCalledWith(api);

	window.dispatchEvent(new Event('online'));
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(2));

	// The test page is visible: a visibilitychange to "visible" flushes again.
	expect(document.visibilityState).toBe('visible');
	document.dispatchEvent(new Event('visibilitychange'));
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(3));
});

test('flushes when the session becomes signed in and verified', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: null });
	await render(SocialSync, { session, api, outbox });
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(1));

	session.set({ username: 'Ana', emailVerified: false });
	flushSync();
	session.set({ username: 'Ana', emailVerified: true });
	flushSync();
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(2));
});

test('a layout-provided account drives the session; no session request of its own', async () => {
	const outbox = fakeOutbox();
	const fetchSpy = vi.spyOn(globalThis, 'fetch');
	await render(SocialSync, {
		api,
		outbox,
		account: { username: 'Ana', emailVerified: true }
	});
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalled());
	expect(fetchSpy).not.toHaveBeenCalled();
	fetchSpy.mockRestore();
});

test('stops listening after unmount and renders only the optional indicator', async () => {
	const outbox = fakeOutbox();
	outbox.queued.push({
		eventId: 'e1',
		kind: 'installed',
		lineageId: 'lin1',
		at: 1,
		attempts: 0,
		nextAttemptAt: 0
	});
	const session = createSocialSession({ initial: { username: 'Ana', emailVerified: true } });
	const indicator = createRawSnippet((status: () => SocialSyncStatus) => ({
		render: () => '<span data-testid="sync-indicator"></span>',
		setup: (node: Element) => {
			$effect(() => {
				node.textContent = `${status().online ? 'on' : 'off'}:${status().pending}`;
			});
		}
	}));
	const screen = await render(SocialSync, { session, api, outbox, children: indicator });
	await expect.element(page.getByTestId('sync-indicator')).toHaveTextContent('on:1');
	expect(screen.container.textContent?.trim()).toBe('on:1');

	await screen.unmount();
	const calls = outbox.flush.mock.calls.length;
	window.dispatchEvent(new Event('online'));
	document.dispatchEvent(new Event('visibilitychange'));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(outbox.flush).toHaveBeenCalledTimes(calls);
});
