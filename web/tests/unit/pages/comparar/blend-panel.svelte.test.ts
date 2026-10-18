import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import BlendPanel from '#lib/components/pages/comparar/BlendPanel.svelte';
import { solveBlend, type BlendResult } from '#lib/components/pages/comparar/blend.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import { copy } from '#lib/components/pages/comparar/copy.ts';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine } from '#lib/audio/engine.ts';
import { setLocale } from '#lib/paraglide/runtime.js';
import { createCurveSocial } from '#lib/components/pages/comparar/social.svelte.ts';
import { createSocialApi, createSocialSession } from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';

vi.mock('#lib/components/pages/comparar/blend.ts', () => ({ solveBlend: vi.fn() }));
vi.mock('#lib/workers/solver-client.ts', () => ({
	createSolverWorker: () => ({ solve: vi.fn(), cancel: vi.fn(), dispose: vi.fn() })
}));
vi.mock('#lib/workers/gate-client.ts', () => ({
	createGateWorker: () => ({ commit: vi.fn(), cancel: vi.fn(), dispose: vi.fn() })
}));

let app: ClientApp | null = null;
afterEach(async () => {
	await cleanup();
	app?.dispose();
	await app?.audio.dispose();
	app = null;
	vi.restoreAllMocks();
	vi.mocked(solveBlend).mockReset();
	await setLocale('pt-BR', { reload: false });
});

function accepted(): BlendResult {
	return { ok: true, curve: initialTracks()[1].curve, target: [], rmsDb: 0.25 };
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`blend save/write/bounce are explicit and refused editor changes cannot navigate in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		app = createClientApp({
			storage: { local: null, session: null, indexedDB: null, channel: null },
			audio: createAudioEngine({ indexedDB: null })
		});
		await app.state.ready;
		const saved = await app.state.library.save(app.state.curve.current);
		if (!saved) throw new Error('Could not prepare library result');
		const save = vi
			.spyOn(app.state.library, 'save')
			.mockResolvedValueOnce(null)
			.mockResolvedValue(saved);
		const set = vi.spyOn(app.state.curve, 'set').mockReturnValue(false);
		const write = vi.spyOn(app, 'requestWrite').mockImplementation(() => undefined);
		const onBounce = vi.fn();
		const t = copy(locale);
		vi.mocked(solveBlend).mockResolvedValue(accepted());
		await render(BlendPanel, { tracks: initialTracks(), t, locale, app, onBounce });
		const open = page.getByRole('link', { name: t.open, exact: true });
		const address = location.href;
		await expect.element(open).toHaveAttribute('aria-disabled', 'true');
		// Exercise the refusal handler without asking Playwright to click a disabled link.
		const refused = new MouseEvent('click', { bubbles: true, cancelable: true });
		open.element().dispatchEvent(refused);
		expect(refused.defaultPrevented).toBe(true);
		expect(location.href).toBe(address);
		expect(set).not.toHaveBeenCalled();
		await page.getByRole('button', { name: t.solve, exact: true }).click();
		await expect.element(page.getByText(t.ready, { exact: true })).toBeVisible();
		expect(save).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		await open.click();
		expect(set).toHaveBeenCalledOnce();
		expect(location.href).toBe(address);
		await expect.element(page.getByText(t.failed, { exact: true })).toBeVisible();
		await page.getByRole('button', { name: t.save, exact: true }).click();
		expect(save).toHaveBeenCalledOnce();
		await expect.element(page.getByText(t.failed, { exact: true })).toBeVisible();
		await page.getByRole('button', { name: t.save, exact: true }).click();
		await expect.element(page.getByText(t.saved, { exact: true })).toBeVisible();
		await page.getByRole('button', { name: t.write, exact: true }).click();
		expect(write).toHaveBeenCalledWith(expect.objectContaining({ schema: 1 }));
		await page.getByRole('button', { name: t.bounce, exact: true }).click();
		expect(onBounce).toHaveBeenCalledWith(8, expect.objectContaining({ bands: expect.any(Array) }));
	});

	test(`blend renders reason details and recovers from a failed calculation in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const t = copy(locale);
		vi.mocked(solveBlend)
			.mockRejectedValueOnce(new Error('worker unavailable'))
			.mockResolvedValueOnce({
				ok: false,
				reasons: [{ code: 'a:b0', stage: 0, value: 2.5, limit: 1.31 }, { code: 'f:codec' }]
			});
		await render(BlendPanel, { tracks: initialTracks(), t, locale, app: null, onBounce: vi.fn() });
		await page.getByRole('button', { name: t.solve, exact: true }).click();
		await expect.element(page.getByText(t.failed, { exact: true })).toBeVisible();
		await page.getByRole('button', { name: t.solve, exact: true }).click();
		await expect.element(page.getByText(t.refused, { exact: true })).toBeVisible();
		expect(document.querySelector('.reasons')?.textContent).toContain('#1');
		expect(document.querySelectorAll('.reasons li')).toHaveLength(2);
		await expect
			.element(page.getByRole('button', { name: t.bounce, exact: true }))
			.toHaveAttribute('aria-disabled', 'true');
	});
}

test('a late blend cannot expose a result after the mix changes or the panel unmounts', async () => {
	let finish: ((result: BlendResult) => void) | undefined;
	vi.mocked(solveBlend).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
	const t = copy('en-US');
	const screen = await render(BlendPanel, {
		tracks: initialTracks(),
		t,
		locale: 'en-US',
		app: null,
		onBounce: vi.fn()
	});
	await page.getByRole('button', { name: t.solve, exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: t.busy, exact: true }))
		.toHaveAttribute('aria-busy', 'true');
	const range = screen.container.querySelector('input[type="range"]');
	if (!(range instanceof HTMLInputElement)) throw new Error('Missing blend mix');
	range.value = '50';
	range.dispatchEvent(new Event('input', { bubbles: true }));
	await tick();
	finish?.(accepted());
	await tick();
	await expect.element(page.getByText(t.pending, { exact: true }).first()).toBeVisible();
	await expect
		.element(page.getByRole('button', { name: t.bounce, exact: true }))
		.toHaveAttribute('aria-disabled', 'true');
	await page.getByRole('button', { name: t.solve, exact: true }).click();
	await cleanup();
	finish?.(accepted());
	await tick();
	expect(screen.container.querySelector('.sect-table')).toBeNull();
});

test('an accepted offline blend can bounce but account and editor actions explain the missing engine', async () => {
	const t = copy('en-US');
	const result: BlendResult = { ok: true, curve: initialTracks()[0].curve, target: [], rmsDb: 0 };
	vi.mocked(solveBlend).mockResolvedValue(result);
	const onBounce = vi.fn();
	const social = createCurveSocial(createSocialApi(), createSocialSession({ initial: null }));
	const screen = await render(BlendPanel, {
		tracks: initialTracks(),
		t,
		locale: 'en-US',
		app: null,
		onBounce,
		social
	});
	for (const name of [t.save, t.write, t.bounce]) {
		await expect
			.element(page.getByRole('button', { name, exact: true }))
			.toHaveAccessibleDescription(t.pending);
	}
	await expect
		.element(page.getByRole('spinbutton', { name: t.preamp, exact: true }))
		.toBeDisabled();
	await page.getByRole('checkbox', { name: t.auto, exact: true }).click();
	await page.getByRole('spinbutton', { name: t.preamp, exact: true }).fill('-8');
	await page.getByRole('combobox', { name: t.before, exact: true }).selectOptions('3');
	await page.getByRole('combobox', { name: t.after, exact: true }).selectOptions('4');
	await page.getByRole('button', { name: t.solve, exact: true }).click();
	expect(solveBlend).toHaveBeenCalledWith(
		expect.objectContaining({ preampDb: -8 }),
		expect.anything(),
		expect.anything()
	);
	await expect.element(page.getByText(t.ready, { exact: true })).toBeVisible();
	for (const name of [t.save, t.write]) {
		await expect
			.element(page.getByRole('button', { name, exact: true }))
			.toHaveAttribute('aria-disabled', 'true');
		await expect
			.element(page.getByRole('button', { name, exact: true }))
			.toHaveAccessibleDescription(t.reasonEngine);
	}
	const open = page.getByRole('link', { name: t.open, exact: true });
	const click = new MouseEvent('click', { bubbles: true, cancelable: true });
	open.element().dispatchEvent(click);
	expect(click.defaultPrevented).toBe(true);
	await expect
		.element(page.getByRole('link', { name: m.curve_social_login() }))
		.toHaveAttribute('href', '/entrar?next=%2Fcomparar');
	await page.getByRole('combobox', { name: t.bounce, exact: true }).selectOptions('3');
	await page.getByRole('button', { name: t.bounce, exact: true }).click();
	expect(onBounce).toHaveBeenCalledWith(3, result.curve);
	expect(screen.container.querySelectorAll('.sect-table tbody tr')).toHaveLength(10);
	expect(screen.container.querySelector('.sect-table tbody')?.textContent).toContain('OFF');
});

test('a stale rejected calculation cannot erase a newer accepted result', async () => {
	let reject: ((cause: Error) => void) | undefined;
	vi.mocked(solveBlend)
		.mockImplementationOnce(
			() =>
				new Promise<BlendResult>((_, fail) => {
					reject = fail;
				})
		)
		.mockResolvedValue(accepted());
	const t = copy('en-US');
	const screen = await render(BlendPanel, {
		tracks: initialTracks(),
		t,
		locale: 'en-US',
		app: null,
		onBounce: vi.fn()
	});
	await page.getByRole('button', { name: t.solve, exact: true }).click();
	await page.getByRole('combobox', { name: t.base, exact: true }).selectOptions('2');
	await page.getByRole('button', { name: t.solve, exact: true }).click();
	await expect.element(page.getByText(t.ready, { exact: true })).toBeVisible();
	reject?.(new Error('old worker failed'));
	await tick();
	expect(screen.container.querySelector('.verdict')?.textContent).toContain(t.ready);
	expect(screen.container.querySelector('.verdict')?.textContent).not.toContain(t.failed);
});
