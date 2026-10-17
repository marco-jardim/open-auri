// T4.13: channel LEDs exist only while the channel plays and are fed by the meter tap of the
// channel chain (real data); an idle strip draws no LED at all.
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import type { PreviewChain } from '#lib/audio/engine.ts';
import type { MeterListener, MeterTap, MeterUpdate } from '#lib/audio/meters.ts';
import ChannelStrip from '#lib/components/pages/comunidade/ChannelStrip.svelte';
import { channelOf, type FeedItem } from '#lib/components/pages/comunidade/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { feedItem } from './fixtures.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const channel = channelOf(feedItem() as unknown as FeedItem);
const output = {};
const chain = { output } as unknown as PreviewChain;

function fakeTap(update: MeterUpdate) {
	const disconnect = vi.fn();
	const tap = vi.fn(async (node: AudioNode) => {
		expect(node).toBe(output);
		const meter = {
			subscribe(listener: MeterListener) {
				listener(update);
				return () => undefined;
			},
			disconnect
		};
		return meter as unknown as MeterTap;
	});
	return { tap, disconnect };
}

const LIVE = { mode: 'live', frame: { ppmL: -12, ppmR: -15 } } as unknown as MeterUpdate;

function props(overrides: Record<string, unknown> = {}) {
	return {
		channel,
		number: 1,
		onlisten: vi.fn(),
		onselect: vi.fn(),
		...overrides
	};
}

/** Accessible names are matched exactly: the label names the action and the curve. */
const listenButton = () =>
	page.getByRole('button', { name: m.comunidade_channel_listen({ name: channel.name }) });

test('an idle strip has no LEDs and never taps the audio graph', async () => {
	const { tap } = fakeTap(LIVE);
	await render(ChannelStrip, props({ chain, tap, playing: false }));
	await expect.element(listenButton()).toHaveAttribute('aria-pressed', 'false');
	expect(document.querySelector('[data-testid="channel-leds"]')).toBeNull();
	expect(document.querySelector('.oa-leds')).toBeNull();
	expect(tap).not.toHaveBeenCalled();
});

test('a playing strip lights its LEDs from the real tap of its own chain', async () => {
	const { tap } = fakeTap(LIVE);
	await render(ChannelStrip, props({ chain, tap, playing: true }));
	await expect.element(page.getByTestId('channel-leds')).toBeVisible();
	expect(tap).toHaveBeenCalledTimes(1);
	await expect
		.poll(() => document.querySelectorAll('.oa-led[data-lit="true"]').length)
		.toBeGreaterThan(0);
	const stop = page.getByRole('button', {
		name: m.comunidade_channel_stop({ name: channel.name })
	});
	await expect.element(stop).toHaveAttribute('aria-pressed', 'true');
});

test('stopping disconnects the meter and removes the LEDs', async () => {
	const { tap, disconnect } = fakeTap(LIVE);
	const screen = await render(ChannelStrip, props({ chain, tap, playing: true }));
	await expect.element(page.getByTestId('channel-leds')).toBeVisible();
	await screen.rerender(props({ chain: null, tap, playing: false }));
	await expect.poll(() => document.querySelector('[data-testid="channel-leds"]')).toBeNull();
	expect(disconnect).toHaveBeenCalled();
});

test('SOLO and SEL report the channel to the page', async () => {
	const onlisten = vi.fn();
	const onselect = vi.fn();
	await render(ChannelStrip, props({ onlisten, onselect }));
	await listenButton().click();
	await page
		.getByRole('button', { name: m.comunidade_channel_select({ name: channel.name }) })
		.click();
	expect(onlisten).toHaveBeenCalledWith(channel);
	expect(onselect).toHaveBeenCalledWith(channel);
});

/** The text of everything an element's aria-describedby points to (the Button's reason). */
function reasonOf(element: Element): string {
	const ids = element.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
	return ids
		.map((value) => document.getElementById(value)?.textContent?.trim() ?? '')
		.join(' ')
		.trim();
}

test('FUX.P4: unavailable keys say why (aria-disabled, still focusable, inert)', async () => {
	const broken = { ...channel, curve: null };
	const onlisten = vi.fn();
	const onselect = vi.fn();
	await render(ChannelStrip, props({ channel: broken, onlisten, onselect }));
	const solo = page
		.getByRole('button', { name: m.comunidade_channel_listen({ name: channel.name }) })
		.element();
	const sel = page
		.getByRole('button', { name: m.comunidade_channel_select({ name: channel.name }) })
		.element();
	for (const key of [solo, sel]) {
		expect(key.getAttribute('aria-disabled')).toBe('true');
		expect(key.hasAttribute('disabled')).toBe(false);
		expect(reasonOf(key)).toBe(m.comunidade_channel_invalid());
		if (key instanceof HTMLElement) key.click();
	}
	expect(onlisten).not.toHaveBeenCalled();
	expect(onselect).not.toHaveBeenCalled();
});

test('FUX.P4: while a preview starts, SOLO says to wait', async () => {
	// Comunidade passes `disabled={listener.busy}`: a prop, never the native attribute.
	const onlisten = vi.fn();
	await render(ChannelStrip, props({ disabled: true, onlisten }));
	const solo = listenButton().element();
	expect(solo.getAttribute('aria-disabled')).toBe('true');
	expect(solo.hasAttribute('disabled')).toBe(false);
	expect(reasonOf(solo)).toBe(m.comunidade_v2_reason_busy());
	if (!(solo instanceof HTMLElement)) throw new Error('Missing SOLO key');
	solo.click();
	solo.focus();
	await userEvent.keyboard('{Enter}');
	expect(onlisten).not.toHaveBeenCalled();
});
