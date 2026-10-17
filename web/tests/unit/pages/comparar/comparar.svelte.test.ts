import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';
import { copy } from '#lib/components/pages/comparar/copy.ts';
import { comparisonSvg, downloadComparison } from '#lib/components/pages/comparar/export.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import TrackLane from '#lib/components/pages/comparar/TrackLane.svelte';
import type { MeterSource } from '#lib/audio/meters.ts';

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`eight tracks, patch bay interaction, C3 validation and axe in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const t = copy(locale);
		const { container } = await render(CompararPage, { app: null, locale });
		await expect
			.element(page.getByRole('heading', { level: 1 }))
			.toHaveTextContent(`${t.titleOne} ${t.titleTwo}`);
		expect(container.querySelectorAll('.lane')).toHaveLength(8);
		expect(container.querySelectorAll('.lane-read')).toHaveLength(8);
		expect(container.querySelectorAll('.oa-vu[data-dark="true"]')).toHaveLength(8);
		expect(container.querySelectorAll('.bay-cell')).toHaveLength(12);
		await page.getByRole('switch', { name: `ARM · ${t.track} 4`, exact: true }).click();
		expect(container.querySelectorAll('.bay-cell')).toHaveLength(6);
		const jack = container.querySelectorAll<HTMLButtonElement>('.bay-cell')[1];
		if (!jack) throw new Error('Missing patch jack');
		jack.click();
		await tick();
		expect(jack.classList.contains('on')).toBe(true);
		await page.getByRole('button', { name: t.solve, exact: true }).click();
		await expect.element(page.getByText(t.ready, { exact: true })).toBeVisible();
		expect(container.querySelectorAll('.sect-table tbody tr')).toHaveLength(10);
		await expect.element(page.getByRole('button', { name: t.bounce, exact: true })).toBeEnabled();
		const { violations } = await axe.run(container);
		expect(
			violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
		).toEqual([]);
		const range = container.querySelector<HTMLInputElement>('input[aria-label="' + t.mix + '"]');
		if (!range) throw new Error('Missing C3 blend control');
		range.value = '50';
		range.dispatchEvent(new Event('input', { bubbles: true }));
		await tick();
		await expect
			.element(page.getByRole('button', { name: t.bounce, exact: true }))
			.toHaveAttribute('aria-disabled', 'true');
		await expect.element(page.getByText(t.pending, { exact: true }).first()).toBeVisible();
	}, 20000);

	test(`unsafe manual preamp shows localized gate reasons and no usable result in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const t = copy(locale);
		const { container } = await render(CompararPage, { app: null, locale });
		await page.getByRole('checkbox', { name: t.auto, exact: true }).click();
		await page.getByRole('spinbutton', { name: t.preamp, exact: true }).fill('0');
		await page.getByRole('button', { name: t.solve, exact: true }).click();
		await expect.element(page.getByText(t.refused, { exact: true })).toBeVisible();
		expect(container.querySelector('.reasons')?.textContent).toContain(t.reasonPreamp);
		expect(container.querySelector('.reasons')?.textContent).toContain('g:preamp');
		await expect
			.element(page.getByRole('button', { name: t.bounce, exact: true }))
			.toHaveAttribute('aria-disabled', 'true');
	}, 20000);

	test(`no armed tracks produces an accessible empty state in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const t = copy(locale);
		const { container } = await render(CompararPage, { app: null, locale });
		for (let id = 1; id <= 4; id++)
			await page.getByRole('switch', { name: `ARM · ${t.track} ${id}`, exact: true }).click();
		expect(container.querySelector('.bay table')).toBeNull();
		expect(container.textContent).toContain(t.empty);
		const { violations } = await axe.run(container);
		expect(
			violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
		).toEqual([]);
	}, 20000);
}

test('S10 renders the comparison into a real downloadable PNG', async () => {
	const address = window.location.href;
	const [a, b] = initialTracks();
	const svg = comparisonSvg(a.curve, b.curve, true, 1, true, 'en-US', copy('en-US'));
	const saveFile = vi.fn<(blob: Blob, filename: string) => void>();
	await downloadComparison(svg, 'png', saveFile);
	expect(saveFile).toHaveBeenCalledOnce();
	const [png, pngFilename] = saveFile.mock.calls[0];
	expect(png.type).toBe('image/png');
	expect(png.size).toBeGreaterThan(0);
	expect(pngFilename).toBe('open-auri-comparar.png');
	await downloadComparison(svg, 'svg', saveFile);
	expect(saveFile).toHaveBeenCalledTimes(2);
	const [vector, svgFilename] = saveFile.mock.calls[1];
	expect(await vector.text()).toBe(svg);
	expect(svgFilename).toBe('open-auri-comparar.svg');
	expect(window.location.href).toBe(address);
}, 15000);

test('an armed lane displays its actual tap VU value, not a predicted curve level', async () => {
	const stop = vi.fn();
	const meter: MeterSource = {
		subscribe(listener) {
			listener({
				mode: 'live',
				frame: {
					active: true,
					vuL: -3,
					vuR: -2,
					ppmL: -18,
					ppmR: -18,
					truePeakDb: -18,
					lufsM: -21,
					lufsS: -21,
					correlation: 1
				}
			});
			return stop;
		}
	};
	const { container } = await render(TrackLane, {
		track: initialTracks()[0],
		t: copy('en-US'),
		locale: 'en-US',
		selected: true,
		playing: true,
		meter,
		library: [],
		onSource: vi.fn(),
		onToggle: vi.fn(),
		onSelect: vi.fn()
	});
	await tick();
	expect(container.querySelector('.lane-read')?.textContent).toContain('LIVE');
	expect(container.querySelector('.lane-read output')?.textContent).toContain('−2 VU');
	await cleanup();
	expect(stop).toHaveBeenCalledOnce();
});
