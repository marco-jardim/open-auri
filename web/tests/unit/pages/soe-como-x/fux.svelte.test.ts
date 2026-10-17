// FUX.P3 · Soe como X: states, real solver progress, warm-ups, comprehension and no plan codes.
import { tick } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { neutralCurve } from '#lib/state/model.ts';
import { GRID } from 'open-auri/dsp';
import Workstation from '#lib/components/pages/soe-como-x/Workstation.svelte';
import {
	deviation,
	initialStation,
	PROGRESS_BUDGETS,
	presetTarget,
	solveStationWithProgress,
	stationTransition,
	type SolveProgress,
	type StationState
} from '#lib/components/pages/soe-como-x/model.ts';
import type { SolveParameters } from '#lib/workers/solver-handler.ts';
import { CSV, fakeDataClient, fitResult, measurement } from './fixtures.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

async function select(id: string, value: string) {
	const input = document.getElementById(id);
	if (!(input instanceof HTMLSelectElement)) throw new Error(`Missing select ${id}`);
	input.value = value;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await tick();
}

function budgetOf(input: SolveParameters) {
	return input.options?.maxIterations ?? 0;
}

/** A solver that reports exactly the budget it was given: the iteration cap until the full run. */
function steppingWorker() {
	return {
		solve: vi.fn(async (input: SolveParameters) => {
			const budget = budgetOf(input);
			return {
				result: {
					...fitResult(),
					iterations: budget,
					stopReason: budget < 400 ? ('iterations' as const) : ('converged' as const)
				}
			};
		}),
		target: vi.fn(async () => ({ type: 'target' as const, values: [] })),
		cancel: vi.fn(),
		dispose: vi.fn()
	};
}

function ready(): StationState {
	const target = presetTarget('pref6');
	let state = stationTransition(initialStation(), {
		type: 'measurement',
		trace: { name: 'flat', kind: 'csv', values: GRID.map(() => 0) }
	});
	state = stationTransition(state, { type: 'target', trace: target });
	return stationTransition(state, { type: 'start' });
}

describe('model: real progress passes', () => {
	test('deviation is level matched on 20 Hz to 20 kHz', () => {
		const flat = GRID.map(() => 3);
		const target = GRID.map(() => 0);
		const { values, maxErrorDb } = deviation(flat, target);
		expect(values.every((value) => Math.abs(value) < 1e-9)).toBe(true);
		expect(maxErrorDb).toBeLessThan(1e-9);
	});

	test('each budget is a real solve and the full request always decides', async () => {
		const worker = steppingWorker();
		const seen: SolveProgress[] = [];
		const event = await solveStationWithProgress(ready(), worker, (progress) => {
			seen.push(progress);
			return true;
		});
		expect(worker.solve.mock.calls.map(([input]) => budgetOf(input))).toEqual([
			...PROGRESS_BUDGETS,
			400
		]);
		expect(seen.map((progress) => progress.iterations)).toEqual([...PROGRESS_BUDGETS]);
		expect(seen.every((progress) => progress.maxIterations === 400)).toBe(true);
		expect(event.type).toBe('result');
	});

	test('a pass that stops early ends the previews; a superseded page stops everything', async () => {
		const early = {
			solve: vi.fn(async () => ({ result: fitResult() })),
			cancel: vi.fn(),
			dispose: vi.fn()
		};
		await solveStationWithProgress(ready(), early, () => true);
		expect(early.solve).toHaveBeenCalledTimes(2);
		const stepping = steppingWorker();
		const event = await solveStationWithProgress(ready(), stepping, () => false);
		expect(stepping.solve).toHaveBeenCalledOnce();
		expect(event).toMatchObject({ type: 'error', error: 'solver:superseded' });
	});
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`no plan codes in visible text; technical details stay collapsed in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const screen = await render(Workstation, { dataClient: fakeDataClient() });
		await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
		const visible = screen.container.innerText;
		for (const code of ['FIELD 04', '04 / C1', 'C1 · C2 · C4', 'GATE v2', 'Q27', '(C2)', 'D4,']) {
			expect(visible).not.toContain(code);
		}
		expect(visible).toContain(m.soe_method_title());
		expect(visible).toContain(m.soe_fux_method());
		await page.getByText(m.soe_fux_tech(), { exact: true }).click();
		expect(screen.container.innerText).toContain('GATE v2 · Q27 / Q23');
	});
}

test('RESOLVER is a primitive with a reason, never a silent disabled button', async () => {
	const factory = vi.fn(steppingWorker);
	await render(Workstation, { dataClient: fakeDataClient(), solverFactory: factory });
	const solve = page.getByRole('button', { name: m.soe_solve() });
	await expect.element(solve).toHaveAttribute('aria-disabled', 'true');
	await expect.element(solve).not.toHaveAttribute('disabled');
	await expect.element(solve).toHaveClass(/btn--primary/);
	const describedBy = solve.element().getAttribute('aria-describedby');
	expect(describedBy).toBeTruthy();
	// Playwright refuses to click an aria-disabled control: dispatch on the element itself.
	(solve.element() as HTMLElement).click();
	await tick();
	expect(factory).not.toHaveBeenCalled();
	await expect.element(page.getByText(m.soe_solving(), { exact: true })).not.toBeInTheDocument();
	await expect
		.element(page.getByText(m.soe_fux_solve_reason(), { exact: true }))
		.toBeInTheDocument();
});

test('search states: loading skeleton, no result (§4.4), failure with retry', async () => {
	const client = fakeDataClient();
	let release: ((value: Awaited<ReturnType<typeof client.loadIndex>>) => void) | undefined;
	const original = await client.loadIndex();
	vi.mocked(client.loadIndex).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve;
			})
	);
	const screen = await render(Workstation, { dataClient: client });
	await page.getByRole('searchbox', { name: m.soe_search() }).first().click();
	await expect.poll(() => vi.mocked(client.loadIndex).mock.calls.length).toBeGreaterThan(1);
	// The visible caption (the two Skeletons also carry the same text for screen readers only).
	await expect
		.poll(() => screen.container.querySelector('.measurement p.state')?.textContent?.trim())
		.toBe(m.soe_fux_index_loading());
	expect(screen.container.querySelector('.measurement [aria-busy="true"]')).not.toBeNull();
	expect(document.getElementById('soe-measurement')).toBeNull();
	release?.(original);
	await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
	await expect
		.element(page.getByText(m.soe_fux_index_ready({ count: 1 }), { exact: true }))
		.toBeVisible();
	await page.getByRole('searchbox', { name: m.soe_search() }).first().fill('zzzz nenhum');
	await expect.element(page.getByText(m.empty_soe_body(), { exact: true })).toBeVisible();
	await cleanup();

	const failing = fakeDataClient();
	vi.mocked(failing.loadIndex).mockRejectedValueOnce(new Error('HTTP 503'));
	await render(Workstation, { dataClient: failing });
	await page.getByRole('button', { name: m.soe_fux_retry() }).click();
	await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
	await expect.element(page.getByText(m.soe_missing(), { exact: true })).not.toBeInTheDocument();
});

test('W4 and W5: gate bundle on idle; search focus loads the index and prefetches the solver once', async () => {
	const client = fakeDataClient();
	const factory = vi.fn(steppingWorker);
	const warmers = {
		gate: vi.fn(async () => '/gate.worker.js'),
		solver: vi.fn(async () => '/solver.worker.js')
	};
	await render(Workstation, { dataClient: client, solverFactory: factory, warmers });
	await expect.poll(() => warmers.gate.mock.calls.length).toBe(1);
	expect(warmers.solver).not.toHaveBeenCalled();
	await page.getByRole('searchbox', { name: m.soe_search() }).first().click();
	expect(warmers.solver).toHaveBeenCalledOnce();
	await expect.poll(() => vi.mocked(client.loadIndex).mock.calls.length).toBeGreaterThan(0);
	await page.getByRole('searchbox', { name: m.soe_search() }).last().click();
	expect(warmers.solver).toHaveBeenCalledOnce();
	// Warm-ups only fetch code: no worker exists until RESOLVER is pressed.
	expect(factory).not.toHaveBeenCalled();
});

test('a failed warm-up is logged and never breaks the page', async () => {
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const warmers = {
		gate: vi.fn(async () => {
			throw new Error('chunk offline');
		}),
		solver: vi.fn(async () => {
			throw new Error('chunk offline');
		})
	};
	await render(Workstation, { dataClient: fakeDataClient(), warmers });
	await page.getByRole('searchbox', { name: m.soe_search() }).first().click();
	await expect.poll(() => warning.mock.calls.length).toBeGreaterThanOrEqual(2);
	await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
});

test('themed import replaces the native file control and keeps it labelled', async () => {
	const screen = await render(Workstation, { dataClient: fakeDataClient() });
	const file = document.getElementById('soe-input-file');
	if (!(file instanceof HTMLInputElement)) throw new Error('Missing file input');
	expect(file.type).toBe('file');
	expect(file.labels?.[0]?.textContent).toContain(m.soe_import_measurement());
	expect(file.getBoundingClientRect().width).toBeLessThanOrEqual(1);
	expect(screen.container.innerText).not.toMatch(/Choose File|No file chosen/);
	const paste = page.getByRole('button', { name: m.soe_fux_paste() }).first();
	await expect.element(paste).toHaveAttribute('aria-expanded', 'false');
	await paste.click();
	await expect.element(paste).toHaveAttribute('aria-expanded', 'true');
	await expect
		.element(page.getByRole('textbox', { name: m.soe_import_measurement(), exact: true }))
		.toBeVisible();
});

test('target chart in every mode; Desenhar and Redefinir only in draw mode', async () => {
	const screen = await render(Workstation, { dataClient: fakeDataClient() });
	const chart = () => screen.container.querySelector('.target .target-chart');
	expect(chart()?.textContent).toContain(m.soe_no_trace());
	await expect
		.element(page.getByRole('button', { name: m.soe_fux_draw_start() }))
		.not.toBeInTheDocument();
	for (const kind of ['preset', 'csv', 'community', 'autoeq']) {
		await select('soe-target-kind', kind);
		expect(chart()).not.toBeNull();
	}
	await select('soe-target-kind', 'drawn');
	await page.getByRole('button', { name: m.soe_fux_draw_start() }).click();
	expect(document.activeElement?.getAttribute('role')).toBe('slider');
	await expect.element(page.getByRole('button', { name: m.soe_reset() })).toBeVisible();
});

test('real progress: ITER readout and deviation map follow each solver pass', async () => {
	const worker = steppingWorker();
	const screen = await render(Workstation, {
		dataClient: fakeDataClient(),
		solverFactory: () => worker,
		current: neutralCurve()
	});
	await expect.element(page.getByText(m.soe_fux_map_empty(), { exact: true })).toBeVisible();
	await page.getByRole('button', { name: m.soe_fux_paste() }).first().click();
	await page.getByRole('textbox', { name: m.soe_import_measurement(), exact: true }).fill(CSV);
	await page.getByRole('button', { name: m.soe_import(), exact: true }).click();
	await select('soe-target-kind', 'preset');
	await page.getByRole('button', { name: m.soe_solve() }).click();
	await expect.element(page.getByText(m.soe_gate_pass(), { exact: true })).toBeVisible();
	await expect
		.element(page.getByText(m.soe_fux_iter_short({ n: '400', total: '400' }), { exact: true }))
		.toBeInTheDocument();
	const map = screen.container.querySelector('.map svg[role="img"]');
	expect(map?.getAttribute('aria-label')).toContain(String(PROGRESS_BUDGETS.length + 2));
	expect(map?.querySelectorAll('rect').length).toBe(64 * (PROGRESS_BUDGETS.length + 2));
	const readouts = [...screen.container.querySelectorAll('.fit-readout strong')].map(
		(node) => node.textContent
	);
	expect(readouts).toHaveLength(2);
	expect(readouts.every((text) => text && text !== '∅')).toBe(true);
	for (const id of ['soe-headphone', 'soe-target', 'soe-solver', 'soe-ab', 'soe-editor']) {
		expect(screen.container.querySelector(`[data-tour="${id}"]`)).not.toBeNull();
	}
	expect(measurement.id).toBeTruthy();
});

test('client === null: the page renders and every unavailable action says why', async () => {
	const worker = steppingWorker();
	await render(Workstation, {
		dataClient: fakeDataClient(),
		solverFactory: () => worker,
		current: null,
		audio: null
	});
	await page.getByRole('button', { name: m.soe_fux_paste() }).first().click();
	await page.getByRole('textbox', { name: m.soe_import_measurement(), exact: true }).fill(CSV);
	await page.getByRole('button', { name: m.soe_import(), exact: true }).click();
	await select('soe-target-kind', 'preset');
	await page.getByRole('button', { name: m.soe_solve() }).click();
	await expect.element(page.getByText(m.soe_gate_pass(), { exact: true })).toBeVisible();
	await expect
		.element(page.getByRole('button', { name: m.soe_use() }))
		.toHaveAttribute('aria-disabled', 'true');
	await expect
		.element(page.getByRole('button', { name: m.soe_listen() }))
		.toHaveAttribute('aria-disabled', 'true');
	// Meters stay in DATA (no audio): never a fake live reading.
	expect(document.querySelectorAll('[data-mode="live"]')).toHaveLength(0);
});
