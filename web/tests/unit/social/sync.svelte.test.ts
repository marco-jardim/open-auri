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
	const purge = vi.fn<SocialOutbox['purge']>(async () => 0);
	return { flush, pending, purge, queued };
}

const ANA = { id: 'user-ana', username: 'Ana', emailVerified: true };
const BIA = { id: 'user-bia', username: 'Bia', emailVerified: true };

const api: Pick<SocialApi, 'postActivityOutbox'> = {
	postActivityOutbox: async () => ({ results: [] })
};

test('flushes on mount, on "online" and when the tab becomes visible', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
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

	session.set({ ...ANA, emailVerified: false });
	flushSync();
	session.set(ANA);
	flushSync();
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(2));
});

test('an anonymous session purges nothing (offline probe or never signed in)', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: null });
	await render(SocialSync, { session, api, outbox });
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(1));
	expect(outbox.purge).not.toHaveBeenCalled();
});

test("signing in purges other accounts' events; signing out purges everything", async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	await render(SocialSync, { session, api, outbox });
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenCalledWith('user-ana'));

	session.set(null);
	flushSync();
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenLastCalledWith(null));
	expect(outbox.purge).toHaveBeenCalledTimes(2);
});

test("an account switch purges the previous account's events", async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	await render(SocialSync, { session, api, outbox });
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenCalledWith('user-ana'));

	session.set(BIA);
	flushSync();
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenLastCalledWith('user-bia'));
	expect(outbox.purge).not.toHaveBeenCalledWith(null);

	// The same account read again (e.g. verified later) does not purge again.
	session.set({ ...BIA, emailVerified: false });
	flushSync();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(outbox.purge).toHaveBeenCalledTimes(2);
});

test('a session read as signed out while offline keeps the queue', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	await render(SocialSync, { session, api, outbox });
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenCalledTimes(1));

	window.dispatchEvent(new Event('offline'));
	session.set(null);
	flushSync();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(outbox.purge).not.toHaveBeenCalledWith(null);
	window.dispatchEvent(new Event('online'));
});

test('a layout-provided account drives the session; no session request of its own', async () => {
	const outbox = fakeOutbox();
	const fetchSpy = vi.spyOn(globalThis, 'fetch');
	await render(SocialSync, {
		api,
		outbox,
		account: ANA
	});
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalled());
	expect(fetchSpy).not.toHaveBeenCalled();
	fetchSpy.mockRestore();
});

test('stops listening after unmount and renders only the optional indicator', async () => {
	const outbox = fakeOutbox();
	outbox.queued.push({
		eventId: 'e1',
		owner: 'user-ana',
		kind: 'installed',
		lineageId: 'lin1',
		at: 1,
		attempts: 0,
		nextAttemptAt: 0
	});
	const session = createSocialSession({ initial: ANA });
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
