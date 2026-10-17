import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { PREVIEW_MIN_MS } from '#lib/social/index.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { m } from '#lib/paraglide/messages.js';
import MasterScope from '#lib/components/pages/comunidade/MasterScope.svelte';
import {
	COMUNIDADE_SESSION,
	createListener,
	type ListenRequest
} from '#lib/components/pages/comunidade/listener.svelte.ts';
import { channelOf, type FeedItem } from '#lib/components/pages/comunidade/model.ts';
import { fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';
import { feedItem } from './fixtures.ts';

const engines: AudioEngine[] = [];
const curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const request: ListenRequest = {
	a: { lineageId: 'lineage-a', curve },
	b: { lineageId: null, curve: { ...curve, preampDb: -2 } },
	initial: 'A',
	owner: 'scope'
};

function engine(): AudioEngine {
	const created = createAudioEngine(fakeEnv(null).env);
	engines.push(created);
	return created;
}

/** Manual clock and timers, so audible time is exact. */
function clock() {
	let time = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	let sequence = 0;
	return {
		now: () => time,
		setTimer: (callback: () => void, ms: number) => {
			timers.set(++sequence, { at: time + ms, callback });
			return sequence;
		},
		clearTimer: (handle: unknown) => {
			if (typeof handle === 'number') timers.delete(handle);
		},
		advance(ms: number) {
			time += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= time) {
					timers.delete(id);
					timer.callback();
				}
			}
		}
	};
}

beforeEach(resetAudioConfig);
afterEach(async () => {
	await cleanup();
	await Promise.all(engines.splice(0).map((item) => item.dispose()));
	vi.restoreAllMocks();
});

test('a preview starts at a random point, tagged with the Comunidade session', async () => {
	const audio = engine();
	const start = vi.spyOn(audio, 'start');
	const listener = createListener({ engine: () => audio });
	await listener.play(request);
	expect(start).toHaveBeenCalledExactlyOnceWith('chains', {
		startAt: 'random',
		session: COMUNIDADE_SESSION
	});
	expect(audio.state()).toMatchObject({ playing: true, session: COMUNIDADE_SESSION });
	listener.stop();
	expect(audio.state()).toMatchObject({ playing: false, paused: false, session: null });
});

test('a pause keeps the pair, side and trims, and silence never counts as listening', async () => {
	const audio = engine();
	const time = clock();
	const previewed = vi.fn();
	const stop = vi.spyOn(audio, 'stop');
	const listener = createListener({ engine: () => audio, onPreviewed: previewed, ...time });
	await listener.play(request);
	const trims = listener.trims;
	time.advance(4000);
	// Paused from the Transport or the navbar: before SEEK.2 this released the preview.
	audio.pause();
	expect(listener).toMatchObject({ paused: true, owner: 'scope', side: 'A' });
	expect(listener.trims).toBe(trims);
	expect(stop).not.toHaveBeenCalled();
	expect(listener.audibleMs('lineage-a')).toBe(4000);
	time.advance(PREVIEW_MIN_MS);
	expect(previewed).not.toHaveBeenCalled();
	expect(listener.audibleMs('lineage-a')).toBe(4000);

	expect(await listener.resume()).toBe(true);
	expect(listener.paused).toBe(false);
	expect(audio.state()).toMatchObject({ playing: true, session: COMUNIDADE_SESSION });
	time.advance(PREVIEW_MIN_MS - 4000);
	expect(previewed).toHaveBeenCalledExactlyOnceWith('lineage-a', PREVIEW_MIN_MS);

	listener.pause();
	expect(audio.state()).toMatchObject({ paused: true, session: COMUNIDADE_SESSION });
	// Another page's session replaces ours: the listener lets go without stopping it.
	await audio.start('raw', { session: 'audio-panel' });
	expect(listener.active).toBeNull();
	expect(stop).not.toHaveBeenCalled();
	expect(audio.state().mode).toBe('raw');
});

test('while the scope plays, the B source says why and a click, Enter or change never moves it', async () => {
	const audio = engine();
	const listener = createListener({ engine: () => audio });
	const target = channelOf(
		feedItem({ id: 'lin-target00001', name: 'Alvo' }) as unknown as FeedItem
	);
	const other = channelOf(
		feedItem({ id: 'lin-other000002', name: 'Outra' }) as unknown as FeedItem
	);
	await render(MasterScope, {
		selected: [target, other],
		editor: curve,
		listener,
		locale: 'pt-BR',
		canListen: true,
		onnotice: vi.fn(),
		onuse: vi.fn(),
		oninstall: vi.fn(),
		onopen: vi.fn()
	});
	const source = page.getByRole('combobox', { name: m.comunidade_ab_b_source() });
	const select = source.element() as HTMLSelectElement;
	await expect.element(source).not.toHaveAttribute('aria-disabled');
	expect(select.value).toBe('editor');

	await listener.play({ ...request, owner: 'scope' });
	await expect.element(source).toHaveAttribute('aria-disabled', 'true');
	await expect.element(source).not.toHaveAttribute('disabled');
	await expect.element(source).toHaveAccessibleDescription(m.fuxq1_scope_b_listening());
	select.click();
	select.focus();
	await userEvent.keyboard('{Enter}');
	await userEvent.keyboard('{ArrowDown}');
	expect(select.value).toBe('editor');
	// A change that still lands (script, assistive tech) is refused and the view snaps back.
	select.value = other.lineageId;
	select.dispatchEvent(new Event('change', { bubbles: true }));
	await expect.poll(() => select.value).toBe('editor');

	listener.stop();
	await expect.element(source).not.toHaveAttribute('aria-disabled');
	await expect.element(source).not.toHaveAttribute('aria-describedby');
	await userEvent.selectOptions(select, other.lineageId);
	await expect.poll(() => select.value).toBe(other.lineageId);
});

test('the master scope renders the compact Transport; its pause keeps the session', async () => {
	const audio = engine();
	const listener = createListener({ engine: () => audio });
	await render(MasterScope, {
		selected: [],
		editor: null,
		listener,
		locale: 'pt-BR',
		canListen: true,
		onnotice: vi.fn(),
		onuse: vi.fn(),
		oninstall: vi.fn(),
		onopen: vi.fn()
	});
	const transport = page.getByRole('group', { name: m.transport_group() });
	await expect.element(transport).toBeVisible();
	await expect
		.element(transport.getByRole('slider', { name: m.transport_seek() }))
		.toBeInTheDocument();
	// No strip selected: play cannot start the scope's A/B and says why.
	const play = transport.getByRole('button', { name: m.transport_play(), exact: true });
	await expect.element(play).toHaveAccessibleDescription(m.comunidade_v2_reason_ab_select());

	// A preview another panel started (a channel strip) is the page's session: pause keeps it.
	await listener.play({ ...request, owner: 'channel' });
	const pause = vi.spyOn(audio, 'pause');
	await transport.getByRole('button', { name: m.transport_pause(), exact: true }).click();
	expect(pause).toHaveBeenCalledOnce();
	expect(listener).toMatchObject({ paused: true, owner: 'channel' });
	await transport.getByRole('button', { name: m.transport_resume(), exact: true }).click();
	await expect.poll(() => audio.state().playing).toBe(true);
	expect(listener.paused).toBe(false);
	listener.stop();
});
