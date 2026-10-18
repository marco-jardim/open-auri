import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import MasterScope from '#lib/components/pages/comunidade/MasterScope.svelte';
import { createListener } from '#lib/components/pages/comunidade/listener.svelte.ts';
import { channelOf, type FeedItem } from '#lib/components/pages/comunidade/model.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { m } from '#lib/paraglide/messages.js';
import { fakeEnv } from '../../audio/fake-audio.ts';
import { NEUTRAL, S1_BOOST, feedItem } from './fixtures.ts';

const engines: AudioEngine[] = [];
const listeners: ReturnType<typeof createListener>[] = [];
const target = channelOf(feedItem({ name: 'Alvo', s1: S1_BOOST }) as unknown as FeedItem);
const other = channelOf(feedItem({ id: 'lin-bbbbbbbbbbbb', name: 'Outra' }) as unknown as FeedItem);
function setup() {
	const audio = createAudioEngine(fakeEnv(null).env);
	engines.push(audio);
	const listener = createListener({ engine: () => audio });
	listeners.push(listener);
	return {
		audio,
		listener,
		props: {
			selected: [target, other],
			editor: NEUTRAL,
			listener,
			locale: 'pt-BR',
			canListen: true,
			onnotice: vi.fn(),
			onuse: vi.fn(),
			oninstall: vi.fn(),
			onopen: vi.fn()
		}
	};
}
afterEach(async () => {
	await cleanup();
	listeners.splice(0).forEach((listener) => listener.stop());
	await Promise.all(engines.splice(0).map((audio) => audio.dispose()));
	vi.restoreAllMocks();
});

test('scale changes redraw traces; invalid channels are excluded from the B selector', async () => {
	const { props } = setup();
	await render(MasterScope, {
		...props,
		selected: [target, other, { ...other, lineageId: 'invalid', curve: null }]
	});
	const traces = () => [...document.querySelectorAll('[data-testid="scope-trace"]')];
	expect(traces()).toHaveLength(2);
	expect(traces()[0].getAttribute('class')).toContain('tr-sel');
	expect(traces()[1].getAttribute('stroke')).toMatch(/^hsl/);
	const original = traces()[0].getAttribute('d');
	await userEvent.selectOptions(
		page.getByRole('combobox', { name: m.comunidade_scope_scale() }),
		'6'
	);
	await expect.poll(() => traces()[0].getAttribute('d')).not.toBe(original);
	await userEvent.selectOptions(
		page.getByRole('combobox', { name: m.comunidade_scope_scale() }),
		'18'
	);
	await expect.element(page.getByTestId('s4-rms')).not.toHaveTextContent('–');
	expect(
		page
			.getByRole('combobox', { name: m.comunidade_ab_b_source() })
			.element()
			.querySelectorAll('option')
	).toHaveLength(2);
});

test('scope listens to selected B, switches sides, reports both origins, and stops', async () => {
	const { props, listener } = setup();
	const play = vi.spyOn(listener, 'play');
	const screen = await render(MasterScope, props);
	const source = page.getByRole('combobox', { name: m.comunidade_ab_b_source() });
	await userEvent.selectOptions(source, other.lineageId);
	await page.getByRole('button', { name: m.comunidade_listen(), exact: true }).click();
	expect(play).toHaveBeenCalledWith(
		expect.objectContaining({
			owner: 'scope',
			initial: 'A',
			b: { lineageId: other.lineageId, curve: other.curve }
		})
	);
	expect(props.onopen.mock.calls).toEqual([[target], [other]]);
	await expect.element(source).toHaveAttribute('aria-disabled', 'true');
	await page.getByRole('button', { name: m.comunidade_ab_b(), exact: true }).click();
	expect(listener.side).toBe('B');
	await page.getByRole('button', { name: m.comunidade_ab_a(), exact: true }).click();
	expect(listener.side).toBe('A');
	await page.getByRole('button', { name: m.comunidade_stop(), exact: true }).click();
	expect(listener.active).toBeNull();
	await screen.rerender({ selected: [target] });
	await expect.poll(() => (source.element() as HTMLSelectElement).value).toBe('editor');
	await page.getByRole('button', { name: m.comunidade_listen(), exact: true }).click();
	expect(play).toHaveBeenLastCalledWith(
		expect.objectContaining({ b: { lineageId: null, curve: NEUTRAL } })
	);
	expect(props.onopen).toHaveBeenCalledTimes(3);
});

test('scope actions hand the target to their callbacks without writing directly', async () => {
	const { props } = setup();
	await render(MasterScope, props);
	await page.getByRole('button', { name: m.comunidade_use_curve(), exact: true }).click();
	await page.getByRole('button', { name: m.comunidade_install(), exact: true }).click();
	expect(props.onuse).toHaveBeenCalledExactlyOnceWith(target);
	expect(props.oninstall).toHaveBeenCalledExactlyOnceWith(target);
	const link = page.getByRole('link', { name: m.comunidade_open_curva() });
	await expect.element(link).toHaveAttribute('href', `/#p=${target.s1}`);
	link.element().addEventListener('click', (event) => event.preventDefault());
	(link.element() as HTMLElement).click();
	expect(props.onopen).toHaveBeenCalledExactlyOnceWith(target);
});

test.each([
	{ selected: [], canListen: true, reason: m.comunidade_v2_reason_ab_select },
	{ selected: [{ ...target, curve: null }], canListen: true, reason: m.comunidade_channel_invalid },
	{ selected: [target], canListen: false, reason: m.comunidade_audio_unavailable }
])('unavailable scope action explains its state %#', async ({ selected, canListen, reason }) => {
	const { props, listener } = setup();
	await render(MasterScope, { ...props, selected, canListen, editor: null });
	const play = page.getByRole('button', { name: m.comunidade_listen(), exact: true });
	await expect.element(play).toHaveAttribute('aria-disabled', 'true');
	await expect.element(play).toHaveAccessibleDescription(reason());
	(play.element() as HTMLElement).click();
	expect(listener.active).toBeNull();
	await expect.element(page.getByTestId('s4-rms')).toHaveTextContent('–');
});

test('no B curve produces a notice; a failed engine produces an audio error', async () => {
	const { props, listener } = setup();
	const screen = await render(MasterScope, { ...props, editor: null });
	await page.getByRole('button', { name: m.comunidade_listen(), exact: true }).click();
	expect(props.onnotice).toHaveBeenCalledWith(m.comunidade_audio_unavailable());
	await screen.rerender({ editor: NEUTRAL });
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.spyOn(listener, 'play').mockRejectedValueOnce('blocked');
	await page.getByRole('button', { name: m.comunidade_listen(), exact: true }).click();
	await expect.poll(() => props.onnotice.mock.calls).toContainEqual([m.comunidade_audio_error()]);
	expect(props.onopen).not.toHaveBeenCalled();
});

test('a pending preview makes the scope unavailable until it settles', async () => {
	const { props, audio, listener } = setup();
	let release: () => void = () => undefined;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(audio, 'start').mockReturnValueOnce(pending);
	await render(MasterScope, props);
	const started = listener.play({
		a: { lineageId: null, curve: NEUTRAL },
		b: { lineageId: null, curve: NEUTRAL },
		initial: 'A',
		owner: 'channel'
	});
	await expect
		.element(page.getByRole('button', { name: m.comunidade_listen(), exact: true }))
		.toHaveAccessibleDescription(m.comunidade_v2_reason_busy());
	release();
	await started;
});
