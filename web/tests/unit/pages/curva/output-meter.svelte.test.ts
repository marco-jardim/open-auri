import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { m } from '#lib/paraglide/messages.js';
import { LiveMeter } from '#lib/components/meters/index.ts';
import type { MeterFrame, MeterListener, MeterSource } from '#lib/audio/meters.ts';
import OutputPanel from '#lib/components/pages/curva/OutputPanel.svelte';
import { formatNumber, formatSignedDb } from '#lib/components/pages/curva/format.ts';
import { verdictFor, type Curve } from '#lib/components/pages/curva/model.ts';
import type { GateVerdict } from '#lib/components/pages/curva/reasons.ts';

const curve: Curve = {
	bands: [{ kind: 'PK', freqHz: 1000, gainDb: -3, qFactor: 1 }, ...NEUTRO.bands.slice(1)],
	preampDb: -1
};
const verdict = verdictFor(curve);
const frame = (vu: number): MeterFrame => ({
	vuL: vu - 1,
	vuR: vu,
	ppmL: -8,
	ppmR: -8,
	truePeakDb: -6,
	lufsM: -17,
	lufsS: -18,
	correlation: 0.9,
	active: true
});

/** A meter source driven by the test, like a worklet tap. */
function fakeSource(): MeterSource & { emit(frame: MeterFrame | null): void } {
	let listener: MeterListener | null = null;
	return {
		subscribe(next) {
			listener = next;
			next({ frame: null, mode: 'data' });
			return () => {
				listener = null;
			};
		},
		emit(value) {
			listener?.({ frame: value, mode: value ? 'live' : 'data' });
		}
	};
}

const angle = (db: number) => -50 + ((Math.min(3, Math.max(-12, db)) + 12) / 15) * 100;

/**
 * The needle's rotation in degrees. The browser re-serialises the inline style (a whole number
 * such as "-50.00deg" comes back as "-50deg"), so compare numbers, not text.
 */
function rotation(needle: Element | null): number {
	const match = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(needle?.getAttribute('style') ?? '');
	return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

afterEach(() => cleanup());

test('idle, the needle shows the predicted output peak from the gate (DADOS) and glides to it', async () => {
	const screen = await render(OutputPanel, {
		curve,
		verdict,
		locale: 'pt-BR',
		mode: 'data',
		frame: null,
		reducedMotion: false
	});
	const peak = verdict.metrics.outputAudible?.db;
	if (peak === undefined) throw new Error('Missing gate metric');
	const meter = page.getByRole('meter', { name: m.curva_vu_label() });
	await expect
		.element(meter)
		.toHaveAttribute(
			'aria-valuetext',
			m.curva_vu_value_data({ db: formatSignedDb(peak, 'pt-BR', 2) })
		);
	await expect.element(page.getByText(m.meter_mode_data(), { exact: true })).toBeVisible();
	await expect.element(page.getByText(m.curva_vu_caption_data())).toBeVisible();
	const needle = screen.container.querySelector<SVGGElement>('.needle');
	if (!needle) throw new Error('Missing needle');
	expect(rotation(needle)).toBeCloseTo(angle(peak), 1);
	expect(getComputedStyle(needle).transitionDuration).toBe('0.9s');
	expect(screen.container.querySelector('.meter')?.getAttribute('data-mode')).toBe('data');
	expect(screen.container.querySelector('.meter .unit')?.textContent).toBe('dB');
});

test('during the preview the needle follows the live VU from a meter source (AO VIVO)', async () => {
	const live = new LiveMeter();
	const source = fakeSource();
	live.connect(source);
	expect(live.mode).toBe('data');
	const screen = await render(OutputPanel, {
		curve,
		verdict,
		locale: 'pt-BR',
		mode: live.mode,
		frame: live.frame,
		side: 'A',
		reducedMotion: false
	});
	source.emit(frame(-4));
	expect(live.mode).toBe('live');
	await screen.rerender({ mode: live.mode, frame: live.frame });
	const meter = page.getByRole('meter', { name: m.curva_vu_label() });
	await expect
		.element(meter)
		.toHaveAttribute('aria-valuetext', m.curva_vu_value_live({ vu: formatNumber(-4, 'pt-BR', 1) }));
	await expect.element(meter).toHaveAttribute('aria-valuenow', '-4');
	await expect.element(page.getByText(m.meter_mode_live(), { exact: true })).toBeVisible();
	await expect.element(page.getByText(m.curva_vu_caption_live({ side: 'A' }))).toBeVisible();
	const needle = screen.container.querySelector<SVGGElement>('.needle');
	if (!needle) throw new Error('Missing needle');
	expect(rotation(needle)).toBeCloseTo(angle(-4), 1);
	// Live ballistics come from the worklet: no easing is added on top.
	expect(getComputedStyle(needle).transitionDuration).toBe('0s');
	expect(screen.container.querySelector('.meter .unit')?.textContent).toBe('VU');
	source.emit(frame(-2));
	await screen.rerender({ mode: live.mode, frame: live.frame });
	expect(rotation(needle)).toBeCloseTo(angle(-2), 1);
	// Silence (no active frame): back to the curve data, labelled as such.
	source.emit(null);
	await screen.rerender({ mode: live.mode, frame: live.frame });
	await expect.element(page.getByText(m.meter_mode_data(), { exact: true })).toBeVisible();
	live.disconnect();
});

test('without data the needle rests and nothing claims a reading', async () => {
	const missing: GateVerdict = {
		ok: false,
		reasons: [{ code: 'f:codec' }],
		metrics: { grid: verdict.metrics.grid, thresholds: verdict.metrics.thresholds }
	};
	const screen = await render(OutputPanel, {
		curve,
		verdict: missing,
		locale: 'pt-BR',
		// "live" without a frame is not a reading either.
		mode: 'live',
		frame: null,
		reducedMotion: false
	});
	const meter = screen.container.querySelector('.meter');
	expect(meter?.getAttribute('data-dark')).toBe('true');
	expect(meter?.getAttribute('role')).toBe('img');
	expect(meter?.getAttribute('aria-valuenow')).toBeNull();
	// At rest: the left stop of the scale.
	expect(rotation(screen.container.querySelector('.needle'))).toBe(-50);
	await expect.element(page.getByText(m.meter_mode_data(), { exact: true })).toBeVisible();
	expect(screen.container.textContent).toContain(m.curva_out_unknown());
	// No reading prints the "?" of a non-finite number. The "o que é isso?" explainer triggers
	// (preamp, gate) carry a "?" glyph by design: they are not readings, so leave them out.
	const readings = screen.container.cloneNode(true);
	if (!(readings instanceof Element)) throw new Error('Expected an element');
	const triggers = readings.querySelectorAll('button[aria-haspopup="dialog"]');
	expect(triggers.length).toBeGreaterThan(0);
	for (const trigger of triggers) trigger.remove();
	expect(readings.textContent).not.toContain('?');
});

test('reduced motion: no needle easing and a numeric readout instead', async () => {
	const screen = await render(OutputPanel, {
		curve,
		verdict,
		locale: 'pt-BR',
		mode: 'data',
		frame: null,
		reducedMotion: true
	});
	const needle = screen.container.querySelector<SVGGElement>('.needle');
	if (!needle) throw new Error('Missing needle');
	expect(getComputedStyle(needle).transitionDuration).toBe('0s');
	const peak = verdict.metrics.outputAudible?.db ?? NaN;
	await expect
		.element(page.getByTestId('vu-readout'))
		.toHaveTextContent(m.curva_vu_value_data({ db: formatSignedDb(peak, 'pt-BR', 2) }));
	await screen.rerender({ reducedMotion: false });
	await expect.element(page.getByTestId('vu-readout')).not.toBeInTheDocument();
});
