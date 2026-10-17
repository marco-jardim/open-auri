import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { setLocale } from '#lib/paraglide/runtime.js';
import type { ClientApp } from '#lib/app/index.ts';
import AppFixture from './AppFixture.svelte';
import { fakeAppOptions } from './fakes.ts';

afterEach(async () => {
	await cleanup();
	await page.viewport(1440, 900);
	vi.restoreAllMocks();
});

test('Svelte context shares one app; preset buttons never write; only checklist confirm mints a gesture', async () => {
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1920, 1080);
	const fake = fakeAppOptions();
	const ready = vi.fn<(app: ClientApp) => void>();
	const consumer = vi.fn<(app: ClientApp) => void>();
	await render(AppFixture, { options: fake.options, onready: ready, onconsumer: consumer });
	await expect.poll(() => ready.mock.calls.length).toBe(1);
	const app = ready.mock.calls[0]?.[0];
	if (!app) throw new Error('Provider not mounted');
	await expect.poll(() => consumer.mock.calls[0]?.[0]).toBe(app);
	await app.cable.connect();
	const write = vi.spyOn(app.cable, 'write');
	const gesture = vi.spyOn(app.cable, 'createGesture');
	await page.getByRole('button', { name: 'Padrão Auri', exact: true }).click();
	expect(app.state.curve.current.bands).toEqual(PADRAO_AURI.bands);
	await page.getByRole('button', { name: 'Neutro', exact: true }).click();
	expect(app.state.curve.current.bands).toEqual(NEUTRO.bands);
	expect(write).not.toHaveBeenCalled();
	await page.getByRole('button', { name: 'Gravar no cabo', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await expect.element(dialog).toBeVisible();
	const confirm = dialog.getByRole('button', { name: 'Gravar no cabo', exact: true });
	await expect.element(confirm).toHaveAttribute('aria-disabled', 'true');
	expect(write).not.toHaveBeenCalled();
	expect(gesture).not.toHaveBeenCalled();
	const checks = dialog.getByRole('checkbox').elements();
	expect(checks).toHaveLength(2);
	// Native checkbox clicks and the final button click come from Playwright, not dispatchEvent.
	await dialog.getByRole('checkbox').nth(0).click();
	await dialog.getByRole('checkbox').nth(1).click();
	expect(write).not.toHaveBeenCalled();
	await expect.element(confirm).not.toHaveAttribute('aria-disabled');
	await confirm.click();
	await expect.poll(() => app.cableState.lastOutcome?.status).toBe('ok');
	expect(write).toHaveBeenCalledOnce();
	expect(gesture).toHaveBeenCalledOnce();
	expect(gesture.mock.calls[0]?.[0].isTrusted).toBe(true);
	// 9 payload reports plus the commit report.
	expect(fake.device.sent).toHaveLength(10);
	expect(app.state.curve.dirty).toBe(false);
});
