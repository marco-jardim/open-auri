import '../../primitives/design-system.ts';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { THRESHOLDS } from 'open-auri/safety';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import Inspector from '#lib/components/pages/curva/Inspector.svelte';
import { formatNumber, formatSignedDb } from '#lib/components/pages/curva/format.ts';
import { verdictFor, type Curve } from '#lib/components/pages/curva/model.ts';

const curve: Curve = {
	bands: [{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }, ...NEUTRO.bands.slice(1)],
	preampDb: -1
};
const verdict = verdictFor(curve);

function box(root: Element, selector: string): DOMRect {
	const element = root.querySelector(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element.getBoundingClientRect();
}

async function renderInspector(width: string | null) {
	const screen = await render(Inspector, { curve, verdict, selected: 0, locale: 'pt-BR' });
	// The panel's own width drives the layout (container queries), as in the page's columns.
	if (width) screen.container.style.width = width;
	await document.fonts.ready;
	return screen.container;
}

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
});

test('inspector renders both tables, the real readouts against their limits and the plot help', async () => {
	const root = await renderInspector(null);
	const analysis = verdict.metrics.sections?.[0];
	if (!analysis) throw new Error('Gate analysis missing for section 1');
	await expect.element(page.getByRole('heading', { name: m.curva_v2_insp_title() })).toBeVisible();
	expect(root.querySelectorAll('dl.coef dd')).toHaveLength(5);
	expect(root.querySelectorAll('ol.words li')).toHaveLength(5);
	// Both readouts share one shape: the real value on the first line, its gate limit below.
	const stats = Array.from(root.querySelectorAll('.insp-stats .stat'), (stat) => ({
		value: stat.querySelector(':scope > span'),
		limit: stat.querySelector(':scope > small')
	}));
	expect(stats).toHaveLength(2);
	const expected = [
		{
			value: m.curva_insp_pole({ value: formatNumber(analysis.poleRadius, 'pt-BR', 6) }),
			limit: m.curva_insp_limit({ value: formatNumber(THRESHOLDS.poleRadius, 'pt-BR', 6) })
		},
		{
			value: m.curva_insp_peak({ value: formatSignedDb(analysis.fullPeak.db, 'pt-BR', 1) }),
			limit: m.curva_insp_limit({ value: formatSignedDb(THRESHOLDS.sectionPeakDb, 'pt-BR', 1) })
		}
	];
	for (const [i, { value, limit }] of stats.entries()) {
		if (!value || !limit) throw new Error(`Readout ${i + 1} lacks its value or limit line`);
		expect(value.textContent?.trim()).toBe(expected[i]?.value);
		expect(limit.textContent?.trim()).toBe(expected[i]?.limit);
		expect(limit.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			value.getBoundingClientRect().bottom - 1
		);
	}
	expect(expected[1]?.value).toBe(
		`Pico da seção ${formatSignedDb(analysis.fullPeak.db, 'pt-BR', 1)}`
	);
	expect(expected[1]?.limit).toBe('limite +9,2 dB');
	expect(root.querySelector('.pz-help-title')?.textContent?.trim()).toBe(
		m.curva_v2_pz_help_title()
	);
	await expect.element(page.getByText(m.curva_v2_pz_help(), { exact: true })).toBeVisible();
	// The readouts sit above the help (or above the plot) in every layout, never beside it.
	const help = root.querySelector('.pz-help-body')?.textContent ?? '';
	expect(help).not.toContain('ao lado');
	expect(help).toContain('valores acima');
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`wide panel keeps the wire header on one line in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const screen = await render(Inspector, { curve, verdict, selected: 0, locale });
		const root = screen.container;
		await document.fonts.ready;
		// 821 px is the measured 1440 px page (a 793 px grid inside 14 px padding); 780 px of
		// grid is the narrowest wide layout.
		for (const width of ['821px', '808px', '920px']) {
			root.style.width = width;
			const block = root.querySelector('.insp-wire');
			const header = block?.querySelector('h4');
			if (!(block instanceof HTMLElement) || !(header instanceof HTMLElement)) {
				throw new Error('Missing wire table');
			}
			const fontSize = Number.parseFloat(getComputedStyle(header).fontSize);
			expect(fontSize).toBeGreaterThanOrEqual(11);
			// One line at line-height 1.35 is under two font sizes tall; two lines are not.
			expect(header.getBoundingClientRect().height).toBeLessThan(fontSize * 2);
			expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
			expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
			// Still the wide layout: the plot to the right of both tables, nothing overflowing.
			expect(box(root, '.insp-wire').right).toBeLessThanOrEqual(box(root, '.insp-plot').left);
			expect(box(root, '.insp-plot').width).toBeGreaterThanOrEqual(240);
			expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
		}
	});
}

test('wide panel: the plot alone on the right; tables, readouts and help fill the left', async () => {
	// The Curva engineering layer gives the inspector about 920 px (a 3fr column).
	const root = await renderInspector('920px');
	const cell = root.querySelector('.insp-plot');
	expect(cell?.children).toHaveLength(1);
	expect(cell?.querySelector('svg[role="img"]')).not.toBeNull();
	expect(cell?.querySelector('.pz-help')).toBeNull();
	const plot = box(root, '.insp-plot svg');
	const coef = box(root, '.insp-coef');
	const wire = box(root, '.insp-wire');
	const stats = box(root, '.insp-stats');
	const help = box(root, '.pz-help');
	const helpText = box(root, '.pz-help-body');
	// Both tables side by side, everything else left of the plot.
	expect(Math.abs(coef.top - wire.top)).toBeLessThan(2);
	expect(wire.left).toBeGreaterThanOrEqual(coef.right);
	for (const left of [coef, wire, stats, help]) {
		expect(left.right).toBeLessThanOrEqual(plot.left);
	}
	// Readouts under the tables, help right under the readouts and beside the plot.
	expect(stats.top).toBeGreaterThanOrEqual(Math.max(coef.bottom, wire.bottom));
	expect(help.top).toBeGreaterThanOrEqual(stats.bottom);
	expect(help.top - stats.bottom).toBeLessThanOrEqual(24);
	expect(help.top).toBeLessThan(plot.bottom);
	// No dead zone: the left content ends near the bottom of the plot.
	expect(Math.abs(helpText.bottom - plot.bottom)).toBeLessThan(plot.height / 2);
	expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
});

test('medium panel: tables side by side, readouts across, then the plot beside the help', async () => {
	const root = await renderInspector('600px');
	const coef = box(root, '.insp-coef');
	const wire = box(root, '.insp-wire');
	const stats = box(root, '.insp-stats');
	const plot = box(root, '.insp-plot');
	const help = box(root, '.pz-help');
	expect(Math.abs(coef.top - wire.top)).toBeLessThan(2);
	expect(stats.top).toBeGreaterThanOrEqual(Math.max(coef.bottom, wire.bottom));
	expect(plot.top).toBeGreaterThanOrEqual(stats.bottom);
	expect(help.top).toBeGreaterThanOrEqual(stats.bottom);
	expect(Math.abs(help.top - plot.top)).toBeLessThan(2);
	expect(help.left).toBeGreaterThanOrEqual(plot.right);
	expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
});

test('320 px: tables, readouts, plot and help stack with no horizontal overflow', async () => {
	await page.viewport(320, 800);
	const root = await renderInspector(null);
	const panel = root.querySelector('section.mod-panel');
	if (!(panel instanceof HTMLElement)) throw new Error('Missing inspector panel');
	expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
	expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
	const order = ['.insp-coef', '.insp-wire', '.insp-stats', '.insp-plot', '.pz-help'].map(
		(selector) => box(root, selector)
	);
	for (let i = 1; i < order.length; i++) {
		expect(order[i]?.top ?? 0).toBeGreaterThanOrEqual(order[i - 1]?.bottom ?? Infinity);
		expect(order[i]?.right ?? Infinity).toBeLessThanOrEqual(320);
	}
	expect(root.querySelectorAll('dl.coef dd')).toHaveLength(5);
	expect(root.querySelectorAll('ol.words li')).toHaveLength(5);
	await expect.element(page.getByText(m.curva_v2_pz_help(), { exact: true })).toBeVisible();
});
