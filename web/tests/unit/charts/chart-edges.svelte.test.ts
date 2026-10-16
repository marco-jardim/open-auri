import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import ByteMap from '#lib/charts/ByteMap.svelte';
import ErrorHeatMap from '#lib/charts/ErrorHeatMap.svelte';
import MiniCurve from '#lib/charts/MiniCurve.svelte';
import PoleZeroPlot from '#lib/charts/PoleZeroPlot.svelte';
import ReportTimeline from '#lib/charts/ReportTimeline.svelte';

afterEach(async () => {
	await cleanup();
});

test('byte map hides the word inspector for an absent section and restores it on a valid selection', async () => {
	const screen = await render(ByteMap, {
		curve: NEUTRO,
		label: 'Payload bytes',
		description: 'Read-only protocol bytes',
		selectedSection: -1
	});
	await expect.element(page.getByRole('img', { name: 'Payload bytes' })).toBeVisible();
	expect(screen.container.textContent).not.toContain('Q27 /');
	await screen.rerender({ selectedSection: 9 });
	expect(screen.container.textContent).toContain('Q27 / 10');
	expect(screen.container.textContent).toContain('b₀');
	await screen.rerender({ selectedSection: 10 });
	expect(screen.container.textContent).not.toContain('Q27 /');
});

test('heat map handles empty rows and falls back to row numbers for unlabeled data', async () => {
	const screen = await render(ErrorHeatMap, {
		rows: [],
		rowLabels: [],
		label: 'Error heat map',
		description: 'Target minus response'
	});
	expect(screen.container.querySelectorAll('rect')).toHaveLength(0);
	await screen.rerender({ rows: [[-2, 2]], grid: [20, 20000], limitDb: 2, locale: 'pt-BR' });
	const cells = screen.container.querySelectorAll('rect');
	expect(cells).toHaveLength(2);
	expect(cells[0].querySelector('title')?.textContent).toContain('1: 20 Hz');
	expect(cells[0].getAttribute('fill')).not.toBe(cells[1].getAttribute('fill'));
	await screen.rerender({ rowLabels: ['Measured'], rows: [[0, 0]] });
	expect(screen.container.querySelector('rect title')?.textContent).toContain('Measured:');
});

test('mini curve draws a zero line only if the displayed range contains zero', async () => {
	const screen = await render(MiniCurve, {
		curve: NEUTRO,
		label: 'Small response',
		description: 'Neutral curve',
		minDb: 1,
		maxDb: 12,
		color: '#123456'
	});
	expect(screen.container.querySelectorAll('path')).toHaveLength(1);
	await screen.rerender({ minDb: -12, maxDb: -1 });
	expect(screen.container.querySelectorAll('path')).toHaveLength(1);
	await screen.rerender({ minDb: -12, maxDb: 12 });
	expect(screen.container.querySelectorAll('path')).toHaveLength(2);
	expect(screen.container.querySelector('path')?.getAttribute('stroke')).toBe('#123456');
});

test('pole plot clears section marks for empty bands but keeps its unit-circle reference', async () => {
	const screen = await render(PoleZeroPlot, {
		bands: [{ kind: 'PK', freqHz: 1000, gainDb: 2, qFactor: 1 }],
		label: 'Poles and zeros',
		description: 'Quantized roots',
		locale: 'pt-BR'
	});
	expect(screen.container.querySelectorAll('g')).toHaveLength(1);
	await screen.rerender({ bands: [] });
	expect(screen.container.querySelectorAll('g')).toHaveLength(0);
	expect(screen.container.querySelectorAll('circle')).toHaveLength(1);
	await expect.element(page.getByRole('img', { name: 'Poles and zeros' })).toBeVisible();
});

test('report timeline accepts an explicit commit label without changing the report schedule', async () => {
	const screen = await render(ReportTimeline, {
		curve: NEUTRO,
		label: 'Report schedule',
		description: 'Nine data reports followed by commit',
		commitLabel: 'Confirm write'
	});
	expect(screen.container.querySelectorAll('g')).toHaveLength(9);
	expect(screen.container.textContent).toContain('Confirm write');
	expect(screen.container.textContent).toContain('294 ms');
});
