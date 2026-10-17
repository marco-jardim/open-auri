import { createRawSnippet, flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO as NEUTRO_PRESET } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import type { AccountProbeResult } from '#lib/components/chrome/account.ts';
import SocialSync, { type SocialSyncStatus } from '#lib/components/social/SocialSync.svelte';
import {
	createSocialSession,
	ORIGINS_KEY,
	originOf,
	originsKey,
	rememberOrigin,
	type FlushReport,
	type QueuedActivity,
	type SocialApi,
	type SocialOutbox
} from '#lib/social/index.ts';

afterEach(async () => {
	await cleanup();
});

const signedOut = async (): Promise<AccountProbeResult> => ({ status: 'signed-out' });
const probeError = async (): Promise<AccountProbeResult> => ({ status: 'error' });
const NEUTRO = encodeS1({ bands: NEUTRO_PRESET.bands, preampDb: NEUTRO_PRESET.preampDb });

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

	// The account appearing triggers a flush (the outbox itself skips an unverified session) ...
	session.set({ ...ANA, emailVerified: false });
	flushSync();
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(2));
	// ... and so does the same account turning verified.
	session.set(ANA);
	flushSync();
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(3));
});

test('an anonymous session purges nothing (offline probe or never signed in)', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: null });
	await render(SocialSync, { session, api, outbox });
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(1));
	expect(outbox.purge).not.toHaveBeenCalled();
});

test("signing in purges others' events; a confirmed sign-out purges all", async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	const probe = vi.fn(signedOut);
	await render(SocialSync, { session, api, outbox, probe });
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenCalledWith('user-ana'));
	expect(probe).not.toHaveBeenCalled();

	session.set(null);
	flushSync();
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenLastCalledWith(null));
	expect(probe).toHaveBeenCalledTimes(1);
	expect(outbox.purge).toHaveBeenCalledTimes(2);
});

test("an account switch purges the previous account's events", async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	await render(SocialSync, { session, api, outbox, probe: probeError });
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

test('switching between two verified accounts flushes for the new one', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	await render(SocialSync, { session, api, outbox, probe: probeError });
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(1));

	session.set(BIA);
	flushSync();
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(2));
});

test('a session read as signed out while offline keeps the queue', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	const probe = vi.fn(probeError);
	await render(SocialSync, { session, api, outbox, probe });
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenCalledTimes(1));

	window.dispatchEvent(new Event('offline'));
	session.set(null);
	flushSync();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(probe).not.toHaveBeenCalled();
	expect(outbox.purge).not.toHaveBeenCalledWith(null);
	window.dispatchEvent(new Event('online'));
	await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(outbox.purge).not.toHaveBeenCalledWith(null);
});

test('a failed session probe never purges; a later definitive sign-out does (R2-3)', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	let answer: () => Promise<AccountProbeResult> = probeError;
	const probe = vi.fn(() => answer());
	await render(SocialSync, { session, api, outbox, probe });
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenCalledWith('user-ana'));

	// Online, the layout reads the session as signed out because its probe failed.
	session.set(null);
	flushSync();
	await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(outbox.purge).not.toHaveBeenCalledWith(null);

	// A probe that throws counts as a failure too.
	answer = () => Promise.reject(new TypeError('network'));
	document.dispatchEvent(new Event('visibilitychange'));
	await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(outbox.purge).not.toHaveBeenCalledWith(null);

	// The tab comes back and the auth API now answers "nobody is signed in": purge.
	answer = signedOut;
	document.dispatchEvent(new Event('visibilitychange'));
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenLastCalledWith(null));
	expect(probe).toHaveBeenCalledTimes(3);
});

test('a failed probe that turns out signed in keeps the queue and purges nothing', async () => {
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	const probe = vi.fn(async (): Promise<AccountProbeResult> => ({
		status: 'signed-in',
		account: ANA
	}));
	await render(SocialSync, { session, api, outbox, probe });
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenCalledTimes(1));
	session.set(null);
	flushSync();
	await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(outbox.purge).toHaveBeenCalledTimes(1);
});

test('an actor-mismatch flush re-reads the session and follows it (R2-2)', async () => {
	const outbox = fakeOutbox();
	outbox.flush.mockImplementationOnce(async () => ({
		status: 'actor-mismatch',
		sent: 0,
		removed: 0,
		dropped: 0,
		kept: 1
	}));
	const session = createSocialSession({ initial: ANA });
	const probe = vi.fn(async (): Promise<AccountProbeResult> => ({
		status: 'signed-in',
		account: BIA
	}));
	await render(SocialSync, { session, api, outbox, probe });
	await vi.waitFor(() => expect(session.accountId).toBe('user-bia'));
	expect(probe).toHaveBeenCalledTimes(1);
	// The switch purges Ana's events and flushes for Bia.
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenLastCalledWith('user-bia'));
	await vi.waitFor(() => expect(outbox.flush).toHaveBeenCalledTimes(2));
});

test('an actor-mismatch flush answered "signed out" purges everything once', async () => {
	const outbox = fakeOutbox();
	outbox.flush.mockImplementationOnce(async () => ({
		status: 'actor-mismatch',
		sent: 0,
		removed: 0,
		dropped: 0,
		kept: 1
	}));
	const session = createSocialSession({ initial: ANA });
	const probe = vi.fn(signedOut);
	await render(SocialSync, { session, api, outbox, probe });
	await vi.waitFor(() => expect(session.signedIn).toBe(false));
	await vi.waitFor(() => expect(outbox.purge).toHaveBeenLastCalledWith(null));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(probe).toHaveBeenCalledTimes(1);
	expect(outbox.purge.mock.calls.filter(([keep]) => keep === null)).toHaveLength(1);
});

test('origins follow the account; other keys are purged (R2-7)', async () => {
	localStorage.setItem(originsKey('user-old'), '{}');
	localStorage.setItem(ORIGINS_KEY, '{}');
	localStorage.setItem('unrelated', 'x');
	const outbox = fakeOutbox();
	const session = createSocialSession({ initial: ANA });
	await render(SocialSync, { session, api, outbox, probe: signedOut });
	await vi.waitFor(() => expect(localStorage.getItem(originsKey('user-old'))).toBeNull());
	expect(localStorage.getItem(ORIGINS_KEY)).toBeNull();
	expect(localStorage.getItem('unrelated')).toBe('x');

	// Ana's origins land under her key and are read back for her only.
	await rememberOrigin({ s1: NEUTRO, lineageId: 'lin_private', versionId: 'ver_1' });
	expect(localStorage.getItem(originsKey('user-ana'))).toContain('lin_private');
	expect((await originOf(NEUTRO))?.lineageId).toBe('lin_private');
	expect(await originOf(NEUTRO, { actor: null })).toBeNull();

	// Bia signs in: Ana's private ids are gone and Bia does not see them.
	session.set(BIA);
	flushSync();
	await vi.waitFor(() => expect(localStorage.getItem(originsKey('user-ana'))).toBeNull());
	expect(await originOf(NEUTRO)).toBeNull();

	// Definitive sign-out: Bia's origins go too; anonymous lookups use the plain key.
	await rememberOrigin({ s1: NEUTRO, lineageId: 'lin_bia', versionId: 'ver_1' });
	session.set(null);
	flushSync();
	await vi.waitFor(() => expect(localStorage.getItem(originsKey('user-bia'))).toBeNull());
	expect(await originOf(NEUTRO)).toBeNull();
	localStorage.removeItem('unrelated');
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
