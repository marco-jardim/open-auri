// Root layout social wiring (FUX.Q N6, #35): the composition `+layout.svelte` uses, with the real
// app context and cable service. The social chunk failing or stalling never holds back the app,
// so the rescue notice still renders from it; a retry from the rescue recovers the wiring.
import '../primitives/design-system.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { CABLE_INFLIGHT_KEY, NEUTRAL_CURVE } from '#lib/cable/index.ts';
import { createAppContext, type AppContext } from '#lib/app/context.svelte.ts';
import type { ClientApp, ClientAppOptions } from '#lib/app/index.ts';
import {
	SOCIAL_RETRY_INTERVAL_MS,
	SocialAttachTimeoutError,
	createSocialAttacher,
	type SocialStop
} from '#lib/app/social-attach.ts';
import RescueNotice from '#lib/components/cable/RescueNotice.svelte';
import { fakeAppOptions } from './fakes.ts';

const contexts: AppContext[] = [];

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	for (const context of contexts.splice(0)) context.dispose();
	vi.restoreAllMocks();
});

const RETRY_WARNING = 'Social runtime still unavailable; the outbox stays unavailable';

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** App options whose storage holds the marker of a write interrupted in a closed tab. */
function interruptedWrite(): ClientAppOptions {
	const fake = fakeAppOptions();
	fake.local.setItem(
		CABLE_INFLIGHT_KEY,
		JSON.stringify({
			at: fake.time.value - 60_000,
			crc: 0x4fff,
			name: 'Neutro',
			preampDb: NEUTRAL_CURVE.preampDb,
			bands: NEUTRAL_CURVE.bands,
			device: 'USB DSP Audio',
			tabId: 'closed-tab'
		})
	);
	return fake.options;
}

/** Same wiring as `+layout.svelte`: optional prepare raced by the attacher, layout-owned retry. */
function layoutWiring(attach: (client: ClientApp) => Promise<SocialStop>, timeoutMs?: number) {
	const context = createAppContext();
	contexts.push(context);
	const state = { unavailable: false, clock: 0 };
	const attacher = createSocialAttacher<ClientApp>({
		attach,
		owns: (client) => context.client === null || context.client === client,
		onavailable: (available) => {
			state.unavailable = !available;
		},
		now: () => state.clock,
		...(timeoutMs === undefined ? {} : { timeoutMs })
	});
	const mount = (options: ClientAppOptions) =>
		context.mount(options, { prepare: (client) => attacher.prepare(client), optional: true });
	return { context, state, attacher, mount };
}

const rescueRegion = () => page.getByRole('region', { name: m.cable_rescue_title() });

test('the social chunk failing: the rescue notice still shows and a retry recovers', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const failure = new TypeError('Failed to fetch dynamically imported module');
	const stop = vi.fn();
	const attach = vi
		.fn<(client: ClientApp) => Promise<SocialStop>>()
		.mockRejectedValueOnce(failure)
		.mockResolvedValue(stop);
	const wiring = layoutWiring(attach);

	const client = await wiring.mount(interruptedWrite());
	if (!client) throw new Error('The app was not published');
	// Published without social: the layout marks `data-social="unavailable"` and keeps going.
	expect(wiring.context.client).toBe(client);
	expect(wiring.context.status).toBe('ready');
	expect(wiring.state.unavailable).toBe(true);
	expect(warn).toHaveBeenCalledWith(expect.any(String), failure);
	await client.start();
	expect(client.cableState.rescue).not.toBeNull();

	// The layout's rescue island needs only the published app and its cable service.
	const retries: boolean[] = [];
	await render(RescueNotice, {
		service: client.cable,
		onrescue: () => {
			retries.push(wiring.attacher.retry(wiring.context.client));
		}
	});
	await expect.element(rescueRegion()).toBeVisible();
	const rescue = page.getByRole('button', { name: m.cable_rescue_action() });

	// Right after the failed attach the rescue does not re-import (and never waits for social).
	await rescue.click();
	expect(retries).toEqual([false]);
	expect(attach).toHaveBeenCalledOnce();

	wiring.state.clock = SOCIAL_RETRY_INTERVAL_MS;
	await rescue.click();
	expect(retries).toEqual([false, true]);
	expect(attach).toHaveBeenCalledTimes(2);
	expect(attach).toHaveBeenLastCalledWith(client);
	await expect.poll(() => wiring.state.unavailable).toBe(false);
	// The recovered wiring is kept for the live app; nothing was logged for the retry.
	expect(stop).not.toHaveBeenCalled();
	expect(warn.mock.calls.filter(([message]) => message === RETRY_WARNING)).toHaveLength(0);
	await expect.element(rescueRegion()).toBeVisible();
});

test('a stalled social chunk times out: the cable chrome mounts without it, a late attach is kept', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const stalled = deferred<SocialStop>();
	const attach = vi.fn<(client: ClientApp) => Promise<SocialStop>>(() => stalled.promise);
	const wiring = layoutWiring(attach, 50);

	const client = await wiring.mount(interruptedWrite());
	if (!client) throw new Error('The app was not published');
	expect(wiring.context.status).toBe('ready');
	expect(wiring.state.unavailable).toBe(true);
	expect(warn).toHaveBeenCalledWith(expect.any(String), expect.any(SocialAttachTimeoutError));
	await client.start();
	await render(RescueNotice, { service: client.cable, onrescue: vi.fn() });
	await expect.element(rescueRegion()).toBeVisible();

	// The stalled request is still running: a retry would only wait on it.
	wiring.state.clock = SOCIAL_RETRY_INTERVAL_MS;
	expect(wiring.attacher.retry(client)).toBe(false);
	expect(attach).toHaveBeenCalledOnce();

	const stop = vi.fn();
	stalled.resolve(stop);
	await expect.poll(() => wiring.state.unavailable).toBe(false);
	expect(stop).not.toHaveBeenCalled();
	expect(wiring.context.client).toBe(client);
});

test('an app replaced without the layout going away: its late wiring stops, one bridge stays', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const stalled = deferred<SocialStop>();
	const late = vi.fn();
	const next = vi.fn();
	const attach = vi
		.fn<(client: ClientApp) => Promise<SocialStop>>()
		.mockReturnValueOnce(stalled.promise)
		.mockResolvedValueOnce(next);
	const wiring = layoutWiring(attach, 50);

	const first = await wiring.mount(fakeAppOptions().options);
	if (!first) throw new Error('The app was not published');
	expect(wiring.state.unavailable).toBe(true);
	stalled.resolve(late);
	await expect.poll(() => wiring.state.unavailable).toBe(false);
	expect(late).not.toHaveBeenCalled();

	// The context only undoes the cleanup its prepare returned in time: not this late one.
	wiring.context.dispose();
	const second = await wiring.mount(fakeAppOptions().options);
	if (!second) throw new Error('The replacement was not published');
	expect(second).not.toBe(first);
	expect(attach).toHaveBeenLastCalledWith(second);
	expect(late).toHaveBeenCalledOnce();
	expect(next).not.toHaveBeenCalled();
	expect(wiring.attacher.keeps(second)).toBe(true);
	expect(wiring.attacher.keeps(first)).toBe(false);
});
