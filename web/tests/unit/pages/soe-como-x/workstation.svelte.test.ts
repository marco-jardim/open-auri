import axe from 'axe-core';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { neutralCurve } from '#lib/state/model.ts';
import Workstation from '#lib/components/pages/soe-como-x/Workstation.svelte';
import { CSV, fakeDataClient, fitResult, measurement } from './fixtures.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await setLocale('pt-BR', { reload: false });
});

async function select(id: string, value: string) {
	const input = document.getElementById(id);
	if (!(input instanceof HTMLSelectElement)) throw new Error(`Missing select ${id}`);
	if (![...input.options].some((option) => option.value === value)) {
		throw new Error(`Unknown option ${value} for ${id}`);
	}
	input.value = value;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await tick();
}

async function accessible(container: HTMLElement) {
	const { violations } = await axe.run(container);
	const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
	expect(blocking).toEqual([]);
}

// RESOLVER and the other primitives never use `disabled`: unavailable means aria-disabled + reason.
const solveButton = () => page.getByRole('button', { name: m.soe_solve() });
const unavailable = (locator: ReturnType<typeof solveButton>) =>
	expect.element(locator).toHaveAttribute('aria-disabled', 'true');
const available = (locator: ReturnType<typeof solveButton>) =>
	expect.element(locator).not.toHaveAttribute('aria-disabled');

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`AutoEq credit, worker result and editor-only use in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const client = fakeDataClient();
		const result = fitResult();
		const solve = vi.fn(async () => ({ result }));
		const onuse = vi.fn(() => true);
		const worker = { solve, cancel: vi.fn(), dispose: vi.fn() };
		const factory = vi.fn(() => worker);
		const screen = await render(Workstation, {
			dataClient: client,
			solverFactory: factory,
			current: neutralCurve(),
			onuse
		});
		await expect
			.element(page.getByRole('heading', { level: 1 }))
			.toHaveTextContent(`${m.soe_title()} X`);
		await unavailable(solveButton());
		expect(factory).not.toHaveBeenCalled();
		await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
		await page.getByRole('searchbox', { name: m.soe_search() }).first().fill('Independent lab');
		await select('soe-measurement', measurement.id);
		await expect
			.poll(() => screen.container.querySelectorAll('[data-testid="autoeq-attribution"]').length)
			.toBe(2);
		for (const credit of screen.container.querySelectorAll('[data-testid="autoeq-attribution"]')) {
			expect(credit.textContent).toContain(measurement.source);
			expect(credit.textContent).toContain(m.soe_data_credit());
		}
		await select('soe-target', 'target-0');
		await available(solveButton());
		await expect
			.poll(() => screen.container.querySelectorAll('[data-testid="autoeq-attribution"]').length)
			.toBe(4);
		await solveButton().click();
		await expect.element(page.getByText(m.soe_gate_pass(), { exact: true })).toBeVisible();
		// Focusing the search only prefetched code: RESOLVER created the single page worker.
		expect(factory).toHaveBeenCalledOnce();
		expect(solve).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({
					measurement: expect.any(Array),
					target: expect.any(Array)
				})
			})
		);
		expect(solve).toHaveBeenLastCalledWith(
			expect.objectContaining({ options: expect.objectContaining({ maxIterations: 400 }) })
		);
		expect(onuse).not.toHaveBeenCalled();
		await unavailable(page.getByRole('button', { name: m.soe_listen() }));
		await expect.element(page.getByRole('button', { name: m.soe_current() })).toBeVisible();
		await expect.element(page.getByRole('button', { name: m.soe_candidate() })).toBeVisible();
		expect(screen.container.querySelectorAll('[data-mode="data"]').length).toBeGreaterThan(2);
		await accessible(screen.container);
		await page.getByRole('button', { name: m.soe_use() }).click();
		expect(onuse).toHaveBeenCalledWith(
			expect.objectContaining({ source: 'custom', preampDb: -0.5 })
		);
		await expect.element(page.getByText(m.soe_used(), { exact: true })).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: m.soe_editor() }))
			.toHaveAttribute('href', '/?camada=ajustar');
		// An edit invalidates the result instead of silently reusing a stale fitted curve.
		const speed = document.getElementById('soe-speed');
		if (!(speed instanceof HTMLInputElement)) throw new Error('Missing speed');
		speed.value = '100';
		speed.dispatchEvent(new Event('input', { bubbles: true }));
		await expect.element(page.getByRole('button', { name: m.soe_use() })).not.toBeInTheDocument();
	}, 20000);

	test(`missing data still permits CSV import and keyboard-drawn targets in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const client = fakeDataClient();
		vi.mocked(client.loadIndex).mockRejectedValue(new Error('HTTP 404'));
		const screen = await render(Workstation, { dataClient: client });
		await expect.element(page.getByText(m.soe_missing(), { exact: true })).toBeVisible();
		await select('soe-target-kind', 'drawn');
		const first = page.getByRole('slider', { name: `${m.soe_point()} 1`, exact: true });
		first.element().focus();
		await userEvent.keyboard('{ArrowUp}');
		await expect.element(first).toHaveAttribute('aria-valuenow', '0.5');
		await page.getByRole('button', { name: m.soe_reset() }).click();
		await expect.element(first).toHaveAttribute('aria-valuenow', '0');
		await page.getByRole('button', { name: m.soe_fux_paste() }).click();
		await page.getByRole('textbox', { name: m.soe_import_measurement(), exact: true }).fill(CSV);
		await page.getByRole('button', { name: m.soe_import(), exact: true }).click();
		await available(solveButton());
		expect(screen.container.querySelector('[data-testid="autoeq-attribution"]')).toBeNull();
		await accessible(screen.container);
		await select('soe-target-kind', 'csv');
		await unavailable(solveButton());
		await page.getByRole('button', { name: m.soe_fux_paste() }).last().click();
		await page.getByRole('textbox', { name: m.soe_import_target(), exact: true }).fill(CSV);
		await page.getByRole('button', { name: m.soe_import(), exact: true }).last().click();
		await available(solveButton());
		await accessible(screen.container);
	}, 20000);
}

test('missing packs are explicit; manifest failure cannot remove source credit', async () => {
	const client = fakeDataClient();
	vi.mocked(client.getAttribution).mockRejectedValue(new Error('manifest offline'));
	await render(Workstation, { dataClient: client });
	await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
	await select('soe-measurement', measurement.id);
	await expect
		.poll(() => document.querySelectorAll('[data-testid="autoeq-attribution"]').length)
		.toBe(2);
	vi.mocked(client.loadEntry).mockRejectedValue(new Error('binary pack offline'));
	await select('soe-target', 'target-1');
	await expect.element(page.getByText(m.soe_missing(), { exact: true })).toBeVisible();
	await unavailable(solveButton());
	expect(document.querySelector('[data-testid="autoeq-attribution"]')?.textContent).toContain(
		'Independent lab'
	);
	vi.mocked(client.loadEntry).mockResolvedValue({
		frequencies: [20, 1000, 20000],
		values: [0, 0, 0]
	});
	await page.getByRole('button', { name: m.soe_fux_retry() }).click();
	await available(solveButton());
	await expect.element(page.getByText(m.soe_missing(), { exact: true })).not.toBeInTheDocument();
});

test('late data cannot replace CSV input; cancelled workers cannot expose a result', async () => {
	const client = fakeDataClient();
	let resolveEntry:
		((value: { frequencies: readonly number[]; values: number[] }) => void) | undefined;
	vi.mocked(client.loadEntry).mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveEntry = resolve;
			})
	);
	let resolveFit: ((value: { result: ReturnType<typeof fitResult> }) => void) | undefined;
	const worker = {
		solve: vi.fn(
			() =>
				new Promise<{ result: ReturnType<typeof fitResult> }>((resolve) => {
					resolveFit = resolve;
				})
		),
		cancel: vi.fn(),
		dispose: vi.fn()
	};
	await render(Workstation, { dataClient: client, solverFactory: () => worker });
	await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
	await select('soe-measurement', measurement.id);
	await page.getByRole('button', { name: m.soe_fux_paste() }).click();
	await page.getByRole('textbox', { name: m.soe_import_measurement(), exact: true }).fill(CSV);
	await page.getByRole('button', { name: m.soe_import(), exact: true }).click();
	resolveEntry?.({ frequencies: [20, 1000, 20000], values: [0, 0, 0] });
	await tick();
	expect(document.querySelector('[data-testid="autoeq-attribution"]')).toBeNull();
	await select('soe-target-kind', 'preset');
	await solveButton().click();
	await page.getByRole('button', { name: m.soe_cancel() }).click();
	resolveFit?.({ result: fitResult() });
	await tick();
	expect(worker.cancel).toHaveBeenCalled();
	// The superseded progress pass never starts the full solve.
	expect(worker.solve).toHaveBeenCalledOnce();
	await expect.element(page.getByRole('button', { name: m.soe_use() })).not.toBeInTheDocument();
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`empty index, unmatched searches and cleared selections do not enable solving in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const client = fakeDataClient();
		vi.mocked(client.loadIndex).mockResolvedValueOnce([]);
		await render(Workstation, { dataClient: client });
		await expect.element(page.getByText(m.soe_missing(), { exact: true })).toBeVisible();
		await page.getByRole('button', { name: m.soe_fux_retry() }).click();
		await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
		await page.getByRole('searchbox', { name: m.soe_search() }).first().fill('no measurement');
		await page.getByRole('searchbox', { name: m.soe_search() }).last().fill('no target');
		await expect.element(page.getByText(m.empty_soe_body(), { exact: true })).toBeVisible();
		await expect.element(page.getByText(m.soe_no_matches(), { exact: true })).toBeVisible();
		expect(document.querySelectorAll('#soe-measurement option')).toHaveLength(1);
		expect(document.querySelectorAll('#soe-target option')).toHaveLength(1);
		await page.getByRole('searchbox', { name: m.soe_search() }).first().fill('');
		await page.getByRole('searchbox', { name: m.soe_search() }).last().fill('');
		await select('soe-measurement', measurement.id);
		await select('soe-target', 'target-0');
		await available(solveButton());
		await select('soe-measurement', '');
		await unavailable(solveButton());
		await expect.element(page.getByText(m.soe_wait_measurement(), { exact: true })).toBeVisible();
	});

	test(`solver failure retries and a refused editor use never claims success in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const result: ReturnType<typeof fitResult> = {
			...fitResult(),
			bands: [{ kind: 'PK', freqHz: 1000, gainDb: -1, qFactor: 1 }, ...fitResult().bands.slice(1)]
		};
		const worker = {
			solve: vi
				.fn()
				.mockRejectedValueOnce(new Error('solver crashed'))
				.mockResolvedValue({ result }),
			cancel: vi.fn(),
			dispose: vi.fn()
		};
		const onuse = vi.fn(() => false);
		await render(Workstation, {
			dataClient: fakeDataClient(),
			solverFactory: () => worker,
			current: neutralCurve(),
			onuse
		});
		await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
		await select('soe-measurement', measurement.id);
		await select('soe-target-kind', 'preset');
		await select('soe-preset', 'pref6');
		await page.getByRole('checkbox', { name: m.soe_fux_iso() }).click();
		const d5 = document.getElementById('soe-d5');
		if (!(d5 instanceof HTMLInputElement)) throw new Error('Missing D5 control');
		d5.value = '0';
		d5.dispatchEvent(new Event('input', { bubbles: true }));
		await solveButton().click();
		await expect.element(page.getByText(m.soe_solver_error(), { exact: true })).toBeVisible();
		await solveButton().click();
		await expect.element(page.getByText(m.soe_gate_pass(), { exact: true })).toBeVisible();
		await page.getByRole('button', { name: m.soe_use() }).click();
		expect(onuse).toHaveBeenCalledOnce();
		await expect.element(page.getByText(m.soe_used(), { exact: true })).not.toBeInTheDocument();
		expect(worker.solve).toHaveBeenLastCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({ d5Weight: 0, weights: 'flat', maxIterations: 400 })
			})
		);
	});
}

test('missing Worker and factory failure are explicit and never expose a usable result', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const factory = vi.fn(() => {
		throw new Error('worker creation refused');
	});
	await render(Workstation, { dataClient: fakeDataClient(), solverFactory: factory });
	await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
	await select('soe-measurement', measurement.id);
	await select('soe-target-kind', 'preset');
	vi.stubGlobal('Worker', undefined);
	await solveButton().click();
	await expect.element(page.getByText(m.soe_worker_unavailable(), { exact: true })).toBeVisible();
	expect(factory).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
	await solveButton().click();
	expect(factory).toHaveBeenCalledOnce();
	await expect.element(page.getByText(m.soe_worker_unavailable(), { exact: true })).toBeVisible();
	await expect.element(page.getByRole('button', { name: m.soe_use() })).not.toBeInTheDocument();
});
