import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';
import TapeDeck from '#lib/components/pages/comparar/TapeDeck.svelte';
import { copy } from '#lib/components/pages/comparar/copy.ts';
import { comparisonSvg } from '#lib/components/pages/comparar/export.ts';
import { compareCurves, initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import {
	OUTPUT_LIMIT_DB,
	OVERLAY_RANGE_DB,
	plotPeak,
	plotTicks
} from '#lib/components/pages/comparar/plot.ts';
import ptAll from '../../../../messages/pt-BR.json';
import enAll from '../../../../messages/en-US.json';

const own = (all: Record<string, string>) =>
	Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith('comparar_fux_')));
const ptBR = own(ptAll) as typeof ptAll;
const enUS = own(enAll) as typeof enAll;

afterEach(() => cleanup());

describe('FUX.P2 copy', () => {
	test('both locales have the same keys, no em dash in pt-BR, literal legends', () => {
		expect(Object.keys(ptBR).sort()).toEqual(Object.keys(enUS).sort());
		for (const value of Object.values(ptBR)) expect(value).not.toContain('—');
		expect(ptBR.comparar_fux_head_extra).toBe('EXTRA');
		expect(ptBR.comparar_fux_head_erase).toBe('APAGAR');
		expect(ptBR.comparar_fux_head_rec).toBe('GRAVAR');
		expect(ptBR.comparar_fux_head_play).toBe('REPROD.');
		expect(ptBR.comparar_fux_envelope_ok).toBe('Dentro do envelope observado');
		expect(ptBR.comparar_fux_counter).toBe('gravações neste navegador');
		expect(ptBR.comparar_fux_output_limit).toBe('limite de saída −0,47 dB');
	});
});

describe('overlay helpers', () => {
	test('±15 dB grid, output ceiling and peak come from real values', () => {
		expect(OVERLAY_RANGE_DB).toBe(15);
		expect(OUTPUT_LIMIT_DB).toBe(-0.47);
		expect(plotTicks(15)).toEqual([-15, -10, -5, 0, 5, 10, 15]);
		const peak = plotPeak([{ name: 'x', color: '#000', values: [-3, 2.5, -1] }]);
		expect(peak?.db).toBe(2.5);
		expect(plotPeak([])).toBeNull();
	});
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	describe(`Comparar page without a runtime (${locale})`, () => {
		test('renders with client === null: play explains why, meters stay DATA, deck idle', async () => {
			const t = copy(locale);
			const { container } = await render(CompararPage, { app: null, locale });
			const play = page.getByRole('button', { name: t.play, exact: true });
			await expect.element(play).toHaveAttribute('aria-disabled', 'true');
			expect(container.querySelector('.deck-svg')?.getAttribute('data-playing')).toBe('false');
			expect(container.querySelectorAll('.drum')).toHaveLength(4);
			expect(container.querySelectorAll('.lane-read')).toHaveLength(8);
			for (const read of container.querySelectorAll('.lane-read span'))
				expect(read.textContent).toBe(t.data);
		});

		test('each lane shows predicted level and level-match trim, separately and never positive', async () => {
			const t = copy(locale);
			const { container } = await render(CompararPage, { app: null, locale });
			expect(container.querySelectorAll('.lane .predicted')).toHaveLength(8);
			const trims = [...container.querySelectorAll<HTMLElement>('.lane .trim')];
			expect(trims).toHaveLength(8);
			const [a, b] = initialTracks();
			const expected = compareCurves(a.curve, b.curve, true, 1).trims;
			const shown = trims.slice(0, 2).map((trim) => Number(trim.dataset.trim));
			expect(shown).toEqual(expected.map((value) => Math.min(0, value)));
			for (const value of shown) expect(value).toBeLessThanOrEqual(0);
			for (const trim of trims.slice(2)) expect(trim.textContent).toBe(t.levelTrimOff);
			await page.getByRole('checkbox', { name: t.match, exact: true }).click();
			expect(trims[0].textContent).toBe(t.levelTrimUnmatched);
		});

		test('overlay, patch cable, PEQ table, reasons and tour anchors are present', async () => {
			const t = copy(locale);
			const { container } = await render(CompararPage, { app: null, locale });
			expect(container.querySelector('.main-plot .limit text')?.textContent).toBe(t.outputLimit);
			expect(container.querySelector('.main-plot .peak')).not.toBeNull();
			expect(container.querySelector('.bay-cables .cable')).not.toBeNull();
			// The pending PEQ table fills in once the blend is computed: wait for it under load (CI).
			await expect
				.poll(() => container.querySelectorAll('.sect-table-pending tbody tr').length)
				.toBe(10);
			for (const name of [t.save, t.write, t.bounce]) {
				const button = page.getByRole('button', { name, exact: true });
				await expect.element(button).toHaveAttribute('aria-disabled', 'true');
				await expect.element(button).toHaveAccessibleDescription(t.pending);
			}
			for (const id of ['comparar-tracks', 'comparar-arm', 'comparar-level'])
				expect(container.querySelectorAll(`[data-tour="${id}"]`)).toHaveLength(1);
			expect(container.querySelector('script, link[href*="fontsource"]')).toBeNull();
		});

		test('PNG/SVG export carries RMS, labelled bands and the real trims', () => {
			const t = copy(locale);
			const [a, b] = initialTracks();
			const svg = comparisonSvg(a.curve, b.curve, true, 1, true, locale, t);
			expect(svg).toContain('RMS');
			expect(svg).toContain(t.exportBands);
			expect(svg.match(/<path /g)).toHaveLength(3);
			const off = comparisonSvg(a.curve, b.curve, false, 1, false, locale, t);
			expect(off).toContain(t.exportLevelOff);
			expect(off).not.toMatch(/NaN|Infinity|undefined/);
		});
	});
}

test('tape deck turns and lights only while playing', async () => {
	const props = {
		label: 'deck',
		plate: 'plate',
		heads: ['EXTRA', 'APAGAR', 'GRAVAR', 'REPROD.'] as const,
		status: 'status'
	};
	const idle = await render(TapeDeck, { ...props, playing: false });
	expect(idle.container.querySelector('.legend.lit')).toBeNull();
	expect(idle.container.querySelector('svg.playing')).toBeNull();
	cleanup();
	const live = await render(TapeDeck, { ...props, playing: true });
	expect(live.container.querySelector('svg.playing')).not.toBeNull();
	expect(live.container.querySelector('.legend.lit')?.textContent).toBe('REPROD.');
});
