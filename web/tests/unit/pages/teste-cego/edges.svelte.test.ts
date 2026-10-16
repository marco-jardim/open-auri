import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import ListeningRoom from '#lib/components/pages/teste-cego/ListeningRoom.svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { neutralCurve } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

let audio: AudioEngine | null = null;
afterEach(async () => {
	await cleanup();
	await audio?.dispose();
	audio = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

async function candidates() {
	await page.getByRole('radio').last().click();
	await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
}

async function pair() {
	await candidates();
	await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
	await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`empty panels, rejected current curve and missing audio stay explicit in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const screen = await render(BlindTest, {
			current: { ...neutralCurve(), preampDb: 0 },
			reducedMotion: true
		});
		await page.getByRole('tab', { name: new RegExp(m.cego_listen()) }).click();
		await expect.element(page.getByText(m.cego_empty_listen(), { exact: true })).toBeVisible();
		await page.getByRole('tab', { name: new RegExp(m.cego_results()) }).click();
		await expect.element(page.getByText(m.cego_empty_results(), { exact: true })).toBeVisible();
		await page.getByRole('tab', { name: new RegExp(m.cego_setup()) }).click();
		await candidates();
		await expect
			.element(page.getByRole('checkbox', { name: new RegExp(`^${m.cego_current()}`) }))
			.toBeDisabled();
		await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
		await expect
			.element(page.getByText(m.cego_candidates_required(), { exact: true }))
			.toBeVisible();
		await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
		await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
		await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
		await expect.element(page.getByText(m.cego_audio_error(), { exact: true })).toBeVisible();
		await page.getByRole('button', { name: m.cego_generate(), exact: true }).click();
		expect(screen.container.querySelectorAll('.candidate')).toHaveLength(15);
		await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
		await expect.element(page.getByRole('checkbox', { name: /^Natural\b/ })).not.toBeChecked();
	});
}

test('blind setup reports random-source and preview construction failures without starting', async () => {
	audio = createAudioEngine({ indexedDB: null });
	const start = vi.spyOn(audio, 'start');
	await render(BlindTest, { audio, reducedMotion: true });
	await pair();
	const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => {
		throw new Error('random source refused');
	});
	await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
	await expect.element(page.getByText(m.cego_random_error(), { exact: true })).toBeVisible();
	random.mockRestore();
	vi.spyOn(audio, 'createAB').mockImplementation(() => {
		throw new Error('audio graph refused');
	});
	await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
	await expect.element(page.getByText(m.cego_audio_error(), { exact: true })).toBeVisible();
	expect(start).not.toHaveBeenCalled();
});

test('tab keys wrap and unrelated keys do not change the selected panel', async () => {
	await render(BlindTest);
	const tabs = page.getByRole('tab').elements();
	const key = async (index: number, value: string) => {
		tabs[index].focus();
		tabs[index].dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
		tabs[index].dispatchEvent(event);
		await tick();
		return event;
	};
	expect((await key(0, 'Escape')).defaultPrevented).toBe(false);
	expect((await key(0, 'End')).defaultPrevented).toBe(true);
	await expect.element(tabs[5]).toHaveAttribute('aria-selected', 'true');
	await key(5, 'ArrowRight');
	await expect.element(tabs[0]).toHaveAttribute('aria-selected', 'true');
	await key(0, 'ArrowLeft');
	await expect.element(tabs[5]).toHaveAttribute('aria-selected', 'true');
	await key(5, 'Home');
	await expect.element(tabs[0]).toHaveAttribute('aria-selected', 'true');
});

test('two heard rounds compute confidence intervals, refuse invalid ratings and can continue a tournament', async () => {
	await setLocale('en-US', { reload: false });
	audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	audio.setVolume(-40);
	vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
		if (array instanceof Uint32Array) array.fill(0);
		return array;
	});
	const onopen = vi.fn(() => false);
	const screen = await render(BlindTest, { audio, onopen, reducedMotion: true });
	await pair();
	const rounds = screen.container.querySelector('input[type="range"][max="12"]');
	if (!(rounds instanceof HTMLInputElement)) throw new Error('Missing rounds input');
	rounds.value = '2';
	rounds.dispatchEvent(new Event('input', { bubbles: true }));
	await tick();
	await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
	const panel = page.getByRole('tabpanel');
	for (let round = 0; round < 2; round++) {
		await panel.getByRole('button', { name: m.cego_next(), exact: true }).click();
		await expect.element(page.getByText(m.cego_ratings_required(), { exact: true })).toBeVisible();
		await panel.getByRole('button', { name: m.cego_play(), exact: true }).click();
		await expect.element(panel.getByRole('spinbutton').nth(0)).toBeEnabled();
		if (round === 0) {
			await panel.getByRole('spinbutton').nth(0).fill('11');
			await panel.getByRole('spinbutton').nth(0).fill('');
			await panel.getByRole('button', { name: m.cego_next(), exact: true }).click();
			await expect
				.element(page.getByText(m.cego_ratings_required(), { exact: true }))
				.toBeVisible();
		}
		await panel.getByRole('spinbutton').nth(0).fill('0');
		const key = new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true });
		window.dispatchEvent(key);
		expect(key.defaultPrevented).toBe(true);
		await expect.element(panel.getByRole('spinbutton').nth(1)).toBeEnabled();
		await panel.getByRole('spinbutton').nth(1).fill('10');
		await panel.getByRole('button', { name: m.cego_next(), exact: true }).click();
	}
	await expect.element(page.getByRole('table')).toBeVisible();
	expect(screen.container.querySelectorAll('.chart line[stroke-width="3"]')).toHaveLength(2);
	expect(screen.container.querySelectorAll('tbody tr')).toHaveLength(2);
	const address = location.href;
	await page.getByRole('link', { name: m.cego_open(), exact: true }).click();
	expect(onopen).toHaveBeenCalledOnce();
	expect(location.href).toBe(address);
	await expect
		.element(page.getByRole('button', { name: m.cego_continue(), exact: true }))
		.toBeEnabled();
	await page.getByRole('button', { name: m.cego_continue(), exact: true }).click();
	await expect.element(panel.getByRole('spinbutton').nth(2)).toBeDisabled();
	await panel.getByRole('button', { name: m.cego_cancel(), exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: m.cego_start(), exact: true }))
		.toBeVisible();
	expect(audio.state().playing).toBe(false);
}, 30000);

test('listening room hides identities until reveal and delegates only enabled floor positions', async () => {
	const onselect = vi.fn();
	const screen = await render(ListeningRoom, { names: ['Hidden identity'], count: 2, onselect });
	expect(screen.container.textContent).not.toContain('Hidden identity');
	await expect.element(page.getByRole('button').first()).toBeDisabled();
	await screen.rerender({ disabled: false, moving: true });
	await expect.element(page.getByRole('button').first()).toBeDisabled();
	await screen.rerender({ moving: false, revealed: true, selected: 1 });
	expect(screen.container.textContent).toContain('Hidden identity');
	await page.getByRole('button', { name: m.cego_position({ number: 2 }), exact: true }).click();
	expect(onselect).toHaveBeenCalledWith(1);
	await expect.element(page.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
});
