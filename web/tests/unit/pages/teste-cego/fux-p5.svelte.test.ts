import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import ListeningRoom from '#lib/components/pages/teste-cego/ListeningRoom.svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { m } from '#lib/paraglide/messages.js';
import { getLocale, setLocale } from '#lib/paraglide/runtime.js';

let audio: AudioEngine | null = null;
afterEach(async () => {
	await cleanup();
	await audio?.dispose();
	audio = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

function reasonOf(element: Element | null) {
	const ids = element?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
	return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`renders without an app client: idle console, unlit lamps and stated reasons in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const screen = await render(BlindTest, { reducedMotion: true });
		const rack = screen.container.querySelector('[data-tour="cego-listen"]');
		if (!(rack instanceof HTMLElement)) throw new Error('Missing console');
		expect([...rack.querySelectorAll('.seg-value')].map((node) => node.textContent)).toEqual([
			'−−/−−',
			'−− kHz'
		]);
		expect(rack.textContent).toContain(m.cego_fux_round_lcd());
		expect(rack.textContent).toContain(m.cego_fux_rate_lcd());
		expect(rack.textContent).toContain(m.cego_fux_round_none());
		for (const seg of rack.querySelectorAll('.seg')) {
			const label = seg.querySelector('small');
			const value = seg.querySelector('.seg-value');
			if (!label || !value) throw new Error('Incomplete LCD');
			expect(parseFloat(getComputedStyle(label).fontSize)).toBeLessThanOrEqual(
				parseFloat(getComputedStyle(value).fontSize)
			);
		}
		// Two real lamps, both off with no test running.
		expect([...rack.querySelectorAll('.lamp')].map((lamp) => lamp.getAttribute('data-on'))).toEqual(
			['false', 'false']
		);
		expect(rack.textContent).toContain(m.cego_matched());
		expect(rack.textContent).toContain(m.cego_fux_lock());
		expect(rack.textContent).toContain(m.cego_fux_level_none());
		// Big play: a Button (never mono), unavailable with its reason.
		const play = rack.querySelector('.btn.cego-play');
		expect(play?.getAttribute('aria-label')).toBe(m.cego_play());
		expect(play?.getAttribute('aria-disabled')).toBe('true');
		expect(reasonOf(play)).toContain(m.cego_fux_reason_play_idle());
		for (const key of rack.querySelectorAll('.btn.cego-key')) {
			expect(key.getAttribute('aria-disabled')).toBe('true');
			expect(reasonOf(key)).toContain(m.cego_fux_reason_idle());
		}
		// The 3 s swap is a switch, not a native checkbox.
		const toggle = page.getByRole('switch', { name: new RegExp(m.cego_switch()) });
		await expect.element(toggle).toHaveAttribute('aria-checked', 'false');
		await toggle.click();
		await expect.element(toggle).toHaveAttribute('aria-checked', 'true');
		expect(screen.container.querySelector('input[type="checkbox"]')).toBeNull();
		// Preparation: three columns, direct file button, level table and the engine card.
		expect(screen.container.querySelectorAll('.grid3 > .card')).toHaveLength(3);
		const pick = page.getByRole('button', { name: m.cego_fux_pick_file(), exact: true });
		await expect.element(pick).toHaveAttribute('aria-disabled', 'true');
		expect(reasonOf(pick.element())).toContain(m.cego_fux_reason_no_audio());
		await expect.element(page.getByText(m.cego_fux_level_empty(), { exact: true })).toBeVisible();
		await expect.element(page.getByRole('table', { name: m.cego_fux_level_table() })).toBeVisible();
		// The engine card title shares its heading with the eyebrow, so read the heading itself.
		const engine = screen.container.querySelector('.engine h3');
		expect(engine?.textContent).toContain(m.cego_fux_engine_eyebrow());
		expect(engine?.textContent).toContain(m.cego_fux_engine_title());
		await expect.element(page.getByText(m.cego_fux_output_hint(), { exact: true })).toBeVisible();
		await page.getByRole('radio').last().click();
		expect(screen.container.textContent).not.toContain(m.cego_fux_output_hint());
		// Stage: idle pill, three bays that say why they are unavailable, shortcuts restored.
		const room = screen.container.querySelector('.room');
		expect(room?.getAttribute('data-tour')).toBe('cego-result');
		expect(room?.querySelector('.cue')?.textContent).toContain(m.cego_fux_waiting());
		const bays = room?.querySelectorAll('.btn.cego-bay') ?? [];
		expect(bays).toHaveLength(3);
		for (const bay of bays) expect(bay.getAttribute('aria-disabled')).toBe('true');
		expect(room?.querySelectorAll('.ripple')).toHaveLength(0);
		const help = page.getByRole('button', { name: m.cego_fux_shortcuts_aria(), exact: true });
		await expect.element(help).toHaveAttribute('aria-expanded', 'false');
		await help.click();
		await expect.element(page.getByText(m.cego_shortcuts(), { exact: true })).toBeVisible();
		expect(screen.container.querySelector('[data-tour="cego-prepare"]')).not.toBeNull();
	});
}

test('real state drives the console: file source, level table, round LCD, DSP rate and lamps', async () => {
	await setLocale('en-US', { reload: false });
	audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	audio.setVolume(-40);
	const load = vi.spyOn(audio, 'loadFile').mockResolvedValue(undefined);
	const screen = await render(BlindTest, { audio, reducedMotion: true });
	const input = screen.container.querySelector('input[type="file"]');
	if (!(input instanceof HTMLInputElement)) throw new Error('Missing file input');
	const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
	await page.getByRole('button', { name: m.cego_fux_pick_file(), exact: true }).click();
	expect(click).toHaveBeenCalledOnce();
	const file = new File([new Uint8Array(8)], 'tone.wav', { type: 'audio/wav' });
	const transfer = new DataTransfer();
	transfer.items.add(file);
	input.files = transfer.files;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await expect.poll(() => load.mock.calls.length).toBe(1);
	expect(load).toHaveBeenCalledWith(file);

	await page.getByRole('radio').last().click();
	await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
	await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
	await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
	await page.getByRole('tab', { name: new RegExp(m.cego_setup()) }).click();
	const table = screen.container.querySelector('table.lv');
	expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
	expect(table?.textContent).toContain('Auri');
	expect(screen.container.textContent).toContain(m.cego_fux_level_status({ count: 2 }));
	const rack = screen.container.querySelector('[data-tour="cego-listen"]');
	if (!(rack instanceof HTMLElement)) throw new Error('Missing console');
	expect(rack.textContent).toContain(m.cego_fux_level_ready());

	await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
	await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
	await expect.poll(() => rack.querySelector('.seg-value')?.textContent).toBe('01/06');
	expect([...rack.querySelectorAll('.lamp')].map((lamp) => lamp.getAttribute('data-on'))).toEqual([
		'true',
		'true'
	]);
	expect(rack.querySelector('.btn.cego-play')?.hasAttribute('aria-disabled')).toBe(false);
	// Identities stay hidden on the console and the stage while listening.
	expect(rack.textContent).not.toContain('Auri');
	expect(screen.container.querySelector('.room')?.textContent).not.toContain('Natural');

	await page
		.getByRole('tabpanel')
		.getByRole('button', { name: m.cego_play(), exact: true })
		.click();
	await expect.poll(() => audio?.state().ready).toBe(true);
	const rate = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 3 }).format(
		audio.state().rate / 1000
	);
	await expect.poll(() => rack.querySelectorAll('.seg-value')[1]?.textContent).toBe(`${rate} kHz`);

	const plate = page.getByRole('button', { name: m.cego_position({ number: 2 }) }).first();
	await expect.element(plate).not.toHaveAttribute('aria-disabled');
	await plate.click();
	await expect.element(plate).toHaveAttribute('aria-pressed', 'true');
	expect(rack.querySelectorAll('.btn.cego-key')[1]?.getAttribute('aria-pressed')).toBe('true');
	await page.getByRole('button', { name: m.cego_cancel(), exact: true }).click();
	expect(audio.state().playing).toBe(false);
}, 30000);

test('the cabinets slide on their rails only while the test swaps, never with reduced motion', async () => {
	const onselect = vi.fn();
	const screen = await render(ListeningRoom, { onselect, reducedMotion: false });
	const cab = screen.container.querySelector('.cab');
	if (!(cab instanceof HTMLElement)) throw new Error('Missing cabinet');
	expect(getComputedStyle(cab).animationName).toBe('none');
	await screen.rerender({ moving: true, disabled: false });
	expect(screen.container.querySelector('.room')?.classList.contains('moving')).toBe(true);
	if (matchMedia('(prefers-reduced-motion: no-preference)').matches) {
		expect(getComputedStyle(cab).animationName).not.toBe('none');
		expect(getComputedStyle(cab).animationDuration).toBe('3s');
		expect(getComputedStyle(cab).animationIterationCount).toBe('1');
	}
	expect(screen.container.querySelector('.cue')?.textContent).toContain(m.cego_shuffling());
	expect(screen.container.querySelector('.cue')?.textContent).not.toContain(m.cego_fux_waiting());
	await screen.rerender({ moving: false, reducedMotion: true });
	expect(getComputedStyle(cab).animationName).toBe('none');
	expect(screen.container.querySelector('.lamp')?.getAttribute('data-on')).toBe('true');
});
