import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import PeakLamp from '#lib/components/meters/PeakLamp.svelte';
import MeterModeLabel from '#lib/components/meters/MeterModeLabel.svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

test('peak hold renews on each over, expires only on a new reading, and resets when data disappears', async () => {
	const now = vi.spyOn(performance, 'now').mockReturnValue(0);
	const screen = await render(PeakLamp, { mode: 'data', data: -1, label: 'Output peak' });
	const lamp = page.getByRole('img');
	await expect.element(lamp).toHaveAttribute('data-lit', 'false');
	await expect.element(lamp).toHaveAttribute('data-dark', 'false');
	await expect.element(lamp).toHaveAccessibleName(`Output peak: ${m.meter_true_peak_ok()}`);
	await screen.rerender({ data: 0 });
	await expect.element(lamp).toHaveAttribute('data-lit', 'true');
	await expect.element(lamp).toHaveAccessibleName(`Output peak: ${m.meter_true_peak_over()}`);
	now.mockReturnValue(100);
	await screen.rerender({ data: -2 });
	await expect.element(lamp).toHaveAttribute('data-lit', 'true');
	now.mockReturnValue(900);
	await screen.rerender({ data: -0.5 });
	now.mockReturnValue(2000);
	await screen.rerender({ data: -3 });
	await expect.element(lamp).toHaveAttribute('data-lit', 'true');
	const before = screen.container.innerHTML;
	now.mockReturnValue(2400);
	await tick();
	expect(screen.container.innerHTML).toBe(before);
	await screen.rerender({ data: -4 });
	await expect.element(lamp).toHaveAttribute('data-lit', 'false');
	await screen.rerender({ data: 1 });
	await expect.element(lamp).toHaveAttribute('data-lit', 'true');
	await screen.rerender({ data: null });
	await expect.element(lamp).toHaveAttribute('data-lit', 'false');
	await expect.element(lamp).toHaveAttribute('data-dark', 'true');
	await expect.element(lamp).toHaveAccessibleName(`Output peak: ${m.meter_no_data()}`);
});

test('peak mode selects only its own finite source and honors custom threshold/hold and styling', async () => {
	const screen = await render(PeakLamp, {
		mode: 'live',
		live: -4,
		data: 3,
		threshold: -3,
		holdMs: 0,
		class: 'custom-peak'
	});
	const lamp = page.getByRole('img');
	await expect.element(lamp).toHaveClass('custom-peak');
	await expect.element(lamp).toHaveAttribute('data-lit', 'false');
	await screen.rerender({ live: -2 });
	await expect.element(lamp).toHaveAttribute('data-lit', 'true');
	await screen.rerender({ live: -3 });
	await expect.element(lamp).toHaveAttribute('data-lit', 'false');
	await screen.rerender({ live: NaN });
	await expect.element(lamp).toHaveAttribute('data-dark', 'true');
	await screen.rerender({ mode: 'data' });
	await expect.element(lamp).toHaveAttribute('data-lit', 'true');
	await screen.rerender({ data: Infinity });
	await expect.element(lamp).toHaveAttribute('data-dark', 'true');
});

test.each(['pt-BR', 'en-US'] as const)(
	'mode label has an explicit accessible mode in %s and supports custom classes',
	async (locale) => {
		await setLocale(locale, { reload: false });
		const screen = await render(MeterModeLabel, { mode: 'data', class: 'rack-mode' });
		const status = page.getByRole('status');
		await expect.element(status).toHaveClass('rack-mode');
		await expect.element(status).toHaveTextContent(m.meter_mode_data());
		await expect
			.element(status)
			.toHaveAccessibleName(`${m.meter_mode_label()}: ${m.meter_mode_data()}`);
		await screen.rerender({ mode: 'live' });
		await expect.element(status).toHaveAttribute('data-mode', 'live');
		await expect.element(status).toHaveTextContent(m.meter_mode_live());
		await expect
			.element(status)
			.toHaveAccessibleName(`${m.meter_mode_label()}: ${m.meter_mode_live()}`);
	}
);
