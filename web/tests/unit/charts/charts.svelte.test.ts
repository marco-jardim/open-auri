import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ChartGallery from './ChartGallery.svelte';

test('all SVG charts expose names and descriptions and render finite paths', async () => {
	render(ChartGallery);
	const names = [
		'Response',
		'Thumbnail',
		'Poles and zeros',
		'Payload',
		'Reports',
		'Polar',
		'Errors',
		'Trace'
	];
	for (const name of names) {
		await expect.element(page.getByRole('img', { name, exact: true })).toBeVisible();
	}
	const charts = [...document.querySelectorAll('svg[role="img"]')];
	expect(charts).toHaveLength(8);
	for (const chart of charts) {
		expect(chart.querySelector('title')?.textContent).toBeTruthy();
		expect(chart.querySelector('desc')?.textContent).toBeTruthy();
		for (const path of chart.querySelectorAll('path')) {
			expect(path.getAttribute('d')).not.toMatch(/NaN|Infinity/);
		}
	}
});

test('counter-scales narrow-chart labels to ≥11 desktop / ≥10 mobile CSS px', async () => {
	render(ChartGallery, { width: 320 });
	await expect.element(page.getByRole('img', { name: 'Response', exact: true })).toBeVisible();
	const svg = document.querySelector<SVGSVGElement>('svg[aria-label="Response"]');
	if (!svg) throw new Error('Missing response chart');
	const label = svg.querySelector('text');
	if (!label) throw new Error('Missing axis label');
	await expect
		.poll(() => {
			const size = Number.parseFloat(getComputedStyle(label).fontSize);
			return (size * svg.getBoundingClientRect().width) / 820;
		})
		.toBeGreaterThanOrEqual(innerWidth <= 720 ? 9.99 : 10.99);
});
