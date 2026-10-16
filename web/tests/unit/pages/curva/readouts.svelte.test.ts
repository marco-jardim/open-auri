import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import OutputPanel from '#lib/components/pages/curva/OutputPanel.svelte';
import Inspector from '#lib/components/pages/curva/Inspector.svelte';
import Sequencer from '#lib/components/pages/curva/Sequencer.svelte';
import RescuePanel from '#lib/components/pages/curva/RescuePanel.svelte';
import { verdictFor, type Curve } from '#lib/components/pages/curva/model.ts';
import type { GateVerdict } from '#lib/components/pages/curva/reasons.ts';
import type { MeterFrame } from '#lib/audio/meters.ts';

const curve: Curve = {
	bands: [{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }, ...NEUTRO.bands.slice(1)],
	preampDb: -1
};
const verdict = verdictFor(curve);
const missingMetrics: GateVerdict = {
	ok: false,
	reasons: [{ code: 'g:preamp' }],
	metrics: { grid: verdict.metrics.grid, thresholds: verdict.metrics.thresholds }
};
const frame: MeterFrame = {
	vuL: -2,
	vuR: -1,
	ppmL: -8,
	ppmR: -10,
	truePeakDb: -6,
	lufsM: -17,
	lufsS: -18,
	correlation: 0.9,
	active: true
};

afterEach(() => cleanup());

test('output labels real DATA/live values and explains refusal; absent metrics are unknown, not zero', async () => {
	const screen = await render(OutputPanel, {
		curve,
		verdict,
		locale: 'pt-BR',
		mode: 'data',
		frame: null
	});
	await expect.element(page.getByText(m.curva_gate_ok(), { exact: true })).toBeVisible();
	await expect.element(page.getByText(m.curva_gate_note())).toBeVisible();
	expect(screen.container.querySelectorAll('dd')[0]?.textContent).toBe('−1,0 dB');
	await screen.rerender({ verdict: missingMetrics, mode: 'live', frame });
	expect(screen.container.querySelector('.gate')?.textContent).toContain(m.curva_gate_no());
	await expect.element(page.getByText(m.curva_reason_g_preamp())).toBeVisible();
	const values = screen.container.querySelectorAll('dd');
	expect(values[1]?.textContent?.trim()).toBe('?');
	expect(values[2]?.textContent?.trim()).toBe('?');
	await expect
		.element(page.getByRole('meter', { name: m.curva_vu_label() }))
		.toHaveAttribute('aria-valuenow', '-1');
	await screen.rerender({ verdict: { ...missingMetrics, reasons: [] } });
	await expect.element(page.getByText(m.curva_reason_unknown())).toBeVisible();
});

test('inspector selects active/OFF sections and separates designed coefficients from unavailable gate metrics', async () => {
	const screen = await render(Inspector, { curve, verdict, selected: 0, locale: 'pt-BR' });
	await expect
		.element(page.getByRole('heading', { name: m.curva_insp_heading({ index: '1' }) }))
		.toBeVisible();
	expect(screen.container.querySelectorAll('dl.coef dd')).toHaveLength(5);
	expect(screen.container.querySelectorAll('ol.words li')).toHaveLength(5);
	expect(screen.container.textContent).toContain('Raio do polo');
	await screen.rerender({ verdict: missingMetrics });
	expect(screen.container.querySelectorAll('dl.coef dd')).toHaveLength(5);
	expect(screen.container.querySelector('ol.words')).toBeNull();
	await screen.rerender({ selected: 1 });
	await expect.element(page.getByText(m.curva_insp_off())).toBeVisible();
	expect(screen.container.querySelector('dl.coef')).toBeNull();
	await screen.rerender({ selected: 99 });
	await expect
		.element(page.getByRole('heading', { name: m.curva_insp_heading({ index: '100' }) }))
		.toBeVisible();
	await expect.element(page.getByText(m.curva_insp_off())).toBeVisible();
});

test('sequencer displays nine reports and commit; Send invokes only the supplied checklist callback', async () => {
	const onsend = vi.fn();
	const screen = await render(Sequencer, { curve, onsend });
	expect(screen.container.querySelectorAll('ol.tape li')).toHaveLength(10);
	await page.getByRole('button', { name: m.curva_seq_send(), exact: true }).click();
	expect(onsend).toHaveBeenCalledOnce();
	await screen.rerender({ disabled: true });
	await expect
		.element(page.getByRole('button', { name: m.curva_seq_send(), exact: true }))
		.toBeDisabled();
});

test('rescue/history controls honour availability and report journal entries, unsaved and saved state', async () => {
	const onneutral = vi.fn();
	const ondefault = vi.fn();
	const onrescue = vi.fn();
	const onundo = vi.fn();
	const onredo = vi.fn();
	const onwrite = vi.fn();
	const screen = await render(RescuePanel, {
		unsaved: false,
		canUndo: false,
		canRedo: false,
		journalCount: 0,
		onneutral,
		ondefault,
		onrescue,
		onundo,
		onredo,
		onwrite
	});
	await expect.element(page.getByText(m.curva_saved(), { exact: true })).toBeVisible();
	await expect.element(page.getByText(m.curva_journal_none())).toBeVisible();
	await expect
		.element(page.getByRole('button', { name: m.curva_undo(), exact: true }))
		.toBeDisabled();
	await expect
		.element(page.getByRole('button', { name: m.curva_redo(), exact: true }))
		.toBeDisabled();
	await screen.rerender({ unsaved: true, canUndo: true, canRedo: true, journalCount: 3 });
	await expect.element(page.getByText(m.curva_unsaved(), { exact: true })).toBeVisible();
	await expect.element(page.getByText(m.curva_journal_count({ count: '3' }))).toBeVisible();
	for (const [name, callback] of [
		[m.curva_rescue_neutral(), onneutral],
		[m.curva_rescue_default(), ondefault],
		[m.curva_rescue_cable(), onrescue],
		[m.curva_undo(), onundo],
		[m.curva_redo(), onredo],
		[m.curva_write(), onwrite]
	] as const) {
		await page.getByRole('button', { name, exact: true }).click();
		expect(callback).toHaveBeenCalledOnce();
	}
	await screen.rerender({ writeDisabled: true });
	await expect
		.element(page.getByRole('button', { name: m.curva_write(), exact: true }))
		.toBeDisabled();
	await expect
		.element(page.getByRole('button', { name: m.curva_rescue_cable(), exact: true }))
		.toBeDisabled();
	await screen.rerender({ disabled: true });
	for (const button of screen.container.querySelectorAll('button'))
		expect(button.disabled).toBe(true);
});
