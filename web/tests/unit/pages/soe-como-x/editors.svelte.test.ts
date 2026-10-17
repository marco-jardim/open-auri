import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import CsvImport from '#lib/components/pages/soe-como-x/CsvImport.svelte';
import TargetEditor from '#lib/components/pages/soe-como-x/TargetEditor.svelte';
import { INITIAL_POINTS } from '#lib/components/pages/soe-como-x/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { CSV } from './fixtures.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

async function choose(file?: File) {
	const input = document.getElementById('csv-file');
	if (!(input instanceof HTMLInputElement)) throw new Error('Missing CSV input');
	const transfer = new DataTransfer();
	if (file) transfer.items.add(file);
	input.files = transfer.files;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await tick();
	return input;
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`CSV rejects invalid pasted data and recovers in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const onimport = vi.fn();
		await render(CsvImport, { id: 'csv', label: 'CSV trace', onimport });
		await page.getByRole('button', { name: m.soe_fux_paste() }).click();
		const submit = page.getByRole('button', { name: m.soe_import(), exact: true });
		await page.getByRole('textbox', { name: 'CSV trace' }).fill('   ');
		// Primitive Button: unavailable is aria-disabled with a reason, never `disabled`.
		await expect.element(submit).toHaveAttribute('aria-disabled', 'true');
		await page.getByRole('textbox', { name: 'CSV trace' }).fill('frequency,raw\n20,nope');
		await submit.click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(m.soe_import_error());
		expect(onimport).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalled();
		await page.getByRole('textbox', { name: 'CSV trace' }).fill(CSV);
		await submit.click();
		expect(onimport).toHaveBeenCalledWith(expect.objectContaining({ name: m.soe_imported() }));
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});
}

test('CSV files handle cancellation, size limits and read failures without importing', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const onimport = vi.fn();
	await render(CsvImport, { id: 'csv', label: 'CSV trace', onimport });
	await choose();
	await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	const large = new File(['x'.repeat(5 * 1024 * 1024 + 1)], 'large.csv');
	const read = vi.spyOn(large, 'text');
	await choose(large);
	await expect.element(page.getByRole('alert')).toBeVisible();
	expect(read).not.toHaveBeenCalled();
	const broken = new File([CSV], 'broken.csv');
	vi.spyOn(broken, 'text').mockRejectedValue(new Error('read refused'));
	await choose(broken);
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.soe_import_error());
	expect(onimport).not.toHaveBeenCalled();
	const input = await choose(new File([CSV], 'valid.csv'));
	await expect.poll(() => onimport.mock.calls.length).toBe(1);
	expect(onimport).toHaveBeenCalledWith(expect.objectContaining({ name: 'valid.csv' }));
	expect(input.value).toBe('');
	await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
});

test('only the latest CSV read may import; pending reads are disabled and ignored on unmount', async () => {
	const onimport = vi.fn();
	await render(CsvImport, { id: 'csv', label: 'CSV trace', onimport });
	await page.getByRole('button', { name: m.soe_fux_paste() }).click();
	await page.getByRole('textbox', { name: 'CSV trace' }).fill(CSV);
	let finish: ((text: string) => void) | undefined;
	const slow = new File([CSV], 'slow.csv');
	vi.spyOn(slow, 'text').mockImplementation(() => new Promise((resolve) => (finish = resolve)));
	await choose(slow);
	await expect.element(page.getByRole('status')).toHaveTextContent(m.soe_loading());
	await expect
		.element(page.getByRole('button', { name: m.soe_import() }))
		.toHaveAttribute('aria-busy', 'true');
	await choose(new File([CSV], 'latest.csv'));
	await expect.poll(() => onimport.mock.calls.length).toBe(1);
	finish?.(CSV);
	await tick();
	expect(onimport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'latest.csv' }));
	await choose(slow);
	await cleanup();
	finish?.(CSV);
	await tick();
	expect(onimport).toHaveBeenCalledTimes(1);
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`target keyboard respects gain limits and point ordering in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const points = [
			{ freqHz: 20, gainDb: 0 },
			{ freqHz: 1000, gainDb: 0 },
			{ freqHz: 20000, gainDb: 0 }
		];
		const onchange = vi.fn();
		await render(TargetEditor, { points, onchange });
		const sliders = document.querySelectorAll('[role="slider"]');
		const key = (index: number, value: string, shiftKey = false) => {
			const event = new KeyboardEvent('keydown', {
				key: value,
				shiftKey,
				bubbles: true,
				cancelable: true
			});
			sliders[index].dispatchEvent(event);
			return event;
		};
		expect(key(1, 'Escape').defaultPrevented).toBe(false);
		expect(onchange).not.toHaveBeenCalled();
		for (const [keyName, gain] of [
			['ArrowUp', 0.5],
			['ArrowDown', -0.5],
			['Home', -18],
			['End', 18]
		] as const) {
			expect(key(1, keyName).defaultPrevented).toBe(true);
			expect(onchange.mock.lastCall?.[0][1]).toEqual({ freqHz: 1000, gainDb: gain });
		}
		key(1, 'ArrowUp', true);
		expect(onchange.mock.lastCall?.[0][1].gainDb).toBe(2);
		key(0, 'ArrowLeft');
		expect(onchange.mock.lastCall?.[0][0].freqHz).toBe(20);
		key(2, 'ArrowRight');
		expect(onchange.mock.lastCall?.[0][2].freqHz).toBe(20000);
		key(1, 'ArrowLeft', true);
		expect(onchange.mock.lastCall?.[0][1].freqHz).toBeLessThan(1000);
		key(1, 'ArrowRight', true);
		expect(onchange.mock.lastCall?.[0][1].freqHz).toBeGreaterThan(1000);
		expect(points[1]).toEqual({ freqHz: 1000, gainDb: 0 });
		await page.getByRole('button', { name: m.soe_reset() }).click();
		expect(onchange.mock.lastCall?.[0]).toEqual(INITIAL_POINTS);
	});
}

test('target drag clamps to graph bounds and stops on pointer cancellation', async () => {
	const onchange = vi.fn();
	await render(TargetEditor, { points: INITIAL_POINTS, onchange });
	const circle = document.querySelector('circle');
	if (!(circle instanceof SVGCircleElement)) throw new Error('Missing target handle');
	vi.spyOn(circle, 'setPointerCapture').mockImplementation(() => undefined);
	const move = () =>
		circle.dispatchEvent(
			new PointerEvent('pointermove', { clientX: -100, clientY: -100, bubbles: true })
		);
	move();
	expect(onchange).not.toHaveBeenCalled();
	circle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true }));
	move();
	expect(onchange.mock.lastCall?.[0][0]).toEqual({ freqHz: 20, gainDb: 18 });
	circle.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
	move();
	expect(onchange).toHaveBeenCalledTimes(1);
	circle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, bubbles: true }));
	circle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
	move();
	expect(onchange).toHaveBeenCalledTimes(1);
});
