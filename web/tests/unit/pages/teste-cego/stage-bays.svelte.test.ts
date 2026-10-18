// The stage's bays are the heart of the page and real controls: one big button per position,
// named "Position N" with aria-pressed, unavailable with the reason while nothing is loaded (and
// then the stage leads to the candidates step), and clicking one goes through the very selection
// the console keys and the 1, 2, 3 shortcuts use.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import Stage from '#lib/components/pages/teste-cego/Stage.svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import '../../primitives/design-system.ts';

let audio: AudioEngine | null = null;
afterEach(async () => {
	await cleanup();
	await audio?.dispose();
	audio = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
});

function bays(container: HTMLElement): HTMLButtonElement[] {
	return [...container.querySelectorAll<HTMLButtonElement>('.stage .bays button.cego-bay')];
}

const stageBay = (number: number) =>
	page
		.getByRole('group', { name: m.cego_tcwow_bays(), exact: true })
		.getByRole('button', { name: m.cego_position({ number }), exact: true });

test('each bay is a large real button named by its position, with aria-pressed', async () => {
	const onselect = vi.fn();
	const screen = await render(Stage, { onselect, disabled: false, selected: 0 });
	const all = bays(screen.container);
	expect(all).toHaveLength(3);
	for (const [index, bay] of all.entries()) {
		expect(bay.type).toBe('button');
		expect(
			page
				.getByRole('button', { name: m.cego_position({ number: index + 1 }), exact: true })
				.element()
		).toBe(bay);
		expect(bay.getAttribute('aria-pressed')).toBe(String(index === 0));
		expect(bay.hasAttribute('aria-disabled')).toBe(false);
		expect(bay.hasAttribute('disabled')).toBe(false);
		const box = bay.getBoundingClientRect();
		expect(box.width).toBeGreaterThanOrEqual(24);
		expect(box.height).toBeGreaterThanOrEqual(24);
	}
	await stageBay(3).click();
	expect(onselect).toHaveBeenCalledOnce();
	expect(onselect).toHaveBeenCalledWith(2);
	await screen.rerender({ selected: 2 });
	expect(all.map((bay) => bay.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
	// The lamp above the chosen position is the one that is on.
	expect(
		[...screen.container.querySelectorAll('.fixture')].map((lamp) => lamp.getAttribute('data-on'))
	).toEqual(['false', 'false', 'true']);
	// While the test swaps, every bay refuses and says why.
	await screen.rerender({ moving: true });
	for (const bay of all) expect(bay.getAttribute('aria-disabled')).toBe('true');
	all[0]?.click();
	expect(onselect).toHaveBeenCalledTimes(1);
	await expect.element(stageBay(1)).toHaveAccessibleDescription(m.cego_fux_reason_moving());
});

test('nothing loaded: the bays say why, and the stage leads to the candidates step', async () => {
	await setLocale('en-US', { reload: false });
	await page.viewport(1440, 900);
	const screen = await render(BlindTest, { reducedMotion: true });
	for (const bay of bays(screen.container)) expect(bay.getAttribute('aria-disabled')).toBe('true');
	await expect.element(stageBay(2)).toHaveAccessibleDescription(m.cego_fux_reason_idle());
	const room = page.getByRole('region', { name: m.cego_title(), exact: true });
	await expect.element(room.getByText(m.cego_tcwow_cta(), { exact: true })).toBeVisible();
	await room.getByRole('button', { name: m.cego_pick(), exact: true }).click();
	const candidates = page.getByRole('tab', { name: new RegExp(m.cego_candidates()) });
	await expect.element(candidates).toHaveAttribute('aria-selected', 'true');
	expect(document.activeElement).toBe(candidates.element());
});

test('a bay selects through the same path as the console keys and the 1, 2, 3 shortcuts', async () => {
	await setLocale('en-US', { reload: false });
	audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	audio.setVolume(-40);
	const screen = await render(BlindTest, { audio, reducedMotion: true });
	await page.getByRole('radio').last().click();
	await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
	await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
	await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
	await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
	// The test is on: the CTA is gone and the bays act.
	expect(screen.container.querySelector('.stage .cta')).toBeNull();
	await expect.element(stageBay(1)).toHaveAttribute('aria-pressed', 'true');
	const keys = () =>
		[...screen.container.querySelectorAll('.btn.cego-key')].map((key) =>
			key.getAttribute('aria-pressed')
		);
	const panel = page.getByRole('tabpanel');
	const panelPosition = (number: number) =>
		panel.getByRole('button', { name: m.cego_position({ number }), exact: true });

	await stageBay(2).click();
	await expect.element(stageBay(2)).toHaveAttribute('aria-pressed', 'true');
	await expect.element(stageBay(1)).toHaveAttribute('aria-pressed', 'false');
	expect(keys()).toEqual(['false', 'true', 'false']);
	await expect.element(panelPosition(2)).toHaveAttribute('aria-pressed', 'true');
	expect(screen.container.querySelector('.counter .digit')?.textContent).toBe('2');

	// The shortcut lands on the same state, shown by the bay, the key and the panel alike.
	window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
	await expect.element(stageBay(1)).toHaveAttribute('aria-pressed', 'true');
	expect(keys()).toEqual(['true', 'false', 'false']);
	await expect.element(panelPosition(1)).toHaveAttribute('aria-pressed', 'true');

	// And the console key back to position 2 is mirrored on stage.
	await page
		.getByRole('complementary')
		.getByRole('button', { name: m.cego_position({ number: 2 }), exact: true })
		.click();
	await expect.element(stageBay(2)).toHaveAttribute('aria-pressed', 'true');
	// A two-candidate test: the third bay stays on stage, unavailable, and says why.
	await expect.element(stageBay(3)).toHaveAttribute('aria-disabled', 'true');
	await expect.element(stageBay(3)).toHaveAccessibleDescription(m.cego_fux_reason_no_position());
	await page.getByRole('button', { name: m.cego_cancel(), exact: true }).click();
	expect(audio.state().playing).toBe(false);
}, 30000);
