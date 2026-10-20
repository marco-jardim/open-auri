import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import NativeModalFixture from './NativeModalFixture.svelte';
import ConfirmDialog from '#lib/components/chrome/ConfirmDialog.svelte';
import AndroidUntestedNotice from '#lib/components/cable/AndroidUntestedNotice.svelte';
import { cableUi } from '../cable/ui-fake.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import '../primitives/design-system.ts';

const KEY = 'oa.nativeModal';
/**
 * Stands in for SvelteKit's router: a plain (non-capture) `popstate` listener on `window`,
 * added after the app's modules are evaluated, as `_start_router()` adds it after hydration
 * (the root layout imports the fence module statically). Back on a fence must never reach it.
 */
const navigation = vi.fn();
let originalState: unknown;
let originalUrl: string;

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	await page.viewport(360, 760);
	vi.stubGlobal('Capacitor', {
		isNativePlatform: () => true,
		getPlatform: () => 'android'
	});
	originalState = history.state;
	originalUrl = location.href;
	// A real previous entry, but same URL so a failed assertion cannot unload the runner.
	history.replaceState({ testPage: 'previous' }, '', originalUrl);
	history.pushState({ testPage: 'base', routerData: { preserved: true } }, '', originalUrl);
	navigation.mockClear();
	window.addEventListener('popstate', navigation);
	localStorage.removeItem('oa.androidDisclaimerAck');
});

afterEach(async () => {
	try {
		await cleanup();
		// UI close/unmount consumes its history fence asynchronously, before the next test.
		await expect.poll(() => history.state?.[KEY]).toBeUndefined();
	} finally {
		window.removeEventListener('popstate', navigation);
		history.replaceState(originalState, '', originalUrl);
		localStorage.removeItem('oa.androidDisclaimerAck');
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await setLocale('pt-BR', { reload: false });
		await page.viewport(1440, 900);
	}
});

async function openChecklist() {
	const fake = cableUi();
	const onclose = vi.fn();
	await render(NativeModalFixture, { service: fake.service, onclose });
	const trigger = page.getByRole('button', { name: m.chrome_write(), exact: true });
	await trigger.click();
	await expect.element(page.getByRole('dialog', { name: m.cable_checklist_title() })).toBeVisible();
	expect(history.state?.[KEY]).toEqual(expect.any(String));
	return { fake, onclose, trigger };
}

test('Android Back closes the header write sheet, returns focus and never reaches the router', async () => {
	const { onclose, trigger } = await openChecklist();
	expect(history.state.routerData).toEqual({ preserved: true });
	history.back();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(onclose).toHaveBeenCalledOnce();
	await expect.element(trigger).toHaveFocus();
	expect(history.state).toEqual({ testPage: 'base', routerData: { preserved: true } });
	expect(location.href).toBe(originalUrl);
	expect(navigation).not.toHaveBeenCalled();
	// With no overlay the next Back is ordinary page navigation, not another phantom sheet.
	history.back();
	await expect.poll(() => history.state?.testPage).toBe('previous');
	expect(navigation).toHaveBeenCalledOnce();
});

test.each(['button', 'Escape'] as const)(
	'%s close consumes the entry; reopen needs only one Back',
	async (method) => {
		const { onclose, trigger } = await openChecklist();
		if (method === 'button') {
			await page.getByRole('button', { name: m.cable_close(), exact: true }).click();
		} else {
			await userEvent.keyboard('{Escape}');
		}
		await expect.poll(() => history.state?.[KEY]).toBeUndefined();
		expect(history.state.testPage).toBe('base');
		expect(onclose).toHaveBeenCalledOnce();
		expect(navigation).not.toHaveBeenCalled();
		await trigger.click();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		history.back();
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
		expect(onclose).toHaveBeenCalledTimes(2);
		expect(history.state.testPage).toBe('base');
		history.back();
		await expect.poll(() => history.state?.testPage).toBe('previous');
	}
);

test('Back closes only the topmost dialog, then closes the underlying sheet', async () => {
	const { onclose } = await openChecklist();
	const onResult = vi.fn();
	await render(ConfirmDialog, { open: true, title: 'Topmost', onResult });
	await expect.element(page.getByRole('dialog', { name: 'Topmost' })).toBeVisible();
	history.back();
	await expect.element(page.getByRole('dialog', { name: 'Topmost' })).not.toBeInTheDocument();
	expect(onResult).toHaveBeenCalledExactlyOnceWith(false);
	expect(onclose).not.toHaveBeenCalled();
	await expect.element(page.getByRole('dialog', { name: m.cable_checklist_title() })).toBeVisible();
	expect(history.state?.[KEY]).toEqual(expect.any(String));
	history.back();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(onclose).toHaveBeenCalledOnce();
	expect(history.state.testPage).toBe('base');
	expect(navigation).not.toHaveBeenCalled();
});

test('the menu drawer closes on Back and a menu-to-dialog handoff survives pending cleanup', async () => {
	await render(NativeModalFixture, { service: cableUi().service, onclose: vi.fn() });
	const menu = page.getByRole('button', { name: m.fuxnav_menu_open(), exact: true });
	await menu.click();
	await expect.element(page.getByRole('dialog', { name: m.fuxnav_sheet_title() })).toBeVisible();
	history.back();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	await expect.element(menu).toHaveFocus();
	expect(history.state.testPage).toBe('base');
	await menu.click();
	await page.getByRole('button', { name: m.chrome_help_open(), exact: true }).click();
	await expect.element(page.getByRole('dialog', { name: 'Help confirmation' })).toBeVisible();
	await expect.poll(() => history.state?.[KEY]).toEqual(expect.any(String));
	history.back();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(history.state.testPage).toBe('base');
	expect(navigation).not.toHaveBeenCalled();
});

test('Back and forced native close cannot dismiss a write in progress', async () => {
	const { fake, onclose } = await openChecklist();
	fake.publish({ writing: true });
	const dialog = page.getByRole('dialog').element() as HTMLDialogElement;
	await expect.element(dialog).toHaveAttribute('closedby', 'none');
	const fence = history.state[KEY];
	history.back();
	await expect.poll(() => history.state?.[KEY]).not.toBe(fence);
	expect(history.state?.[KEY]).toEqual(expect.any(String));
	expect(dialog.open).toBe(true);
	expect(onclose).not.toHaveBeenCalled();
	dialog.close();
	await expect.poll(() => dialog.matches(':modal')).toBe(true);
	expect(onclose).not.toHaveBeenCalled();
	fake.publish({ writing: false });
	history.back();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(onclose).toHaveBeenCalledOnce();
	expect(navigation).not.toHaveBeenCalled();
});

test('the notice resists repeated Back and forced close until Entendi, without acknowledging', async () => {
	await render(AndroidUntestedNotice, { kind: 'native', validated: false, version: 1 });
	const dialog = page.getByRole('dialog').element() as HTMLDialogElement;
	for (let press = 0; press < 3; press += 1) {
		const fence = history.state[KEY];
		history.back();
		await expect.poll(() => history.state?.[KEY]).not.toBe(fence);
		expect(history.state?.[KEY]).toEqual(expect.any(String));
		expect(dialog.matches(':modal')).toBe(true);
		expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
	}
	dialog.close();
	await expect.poll(() => dialog.matches(':modal')).toBe(true);
	await expect.element(page.getByRole('button', { name: m.android_untested_ack() })).toHaveFocus();
	await page.getByRole('button', { name: m.android_untested_ack() }).click();
	await expect.poll(() => history.state?.[KEY]).toBeUndefined();
	expect(history.state.testPage).toBe('base');
	expect(localStorage.getItem('oa.androidDisclaimerAck')).toBe('1');
	expect(navigation).not.toHaveBeenCalled();
});

test('switching the notice to the recovery banner removes the fence without acknowledging', async () => {
	const screen = await render(AndroidUntestedNotice, { kind: 'native', validated: false });
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await screen.rerender({ presentation: 'banner' });
	await expect.element(page.getByRole('complementary')).toBeVisible();
	await expect.poll(() => history.state?.[KEY]).toBeUndefined();
	expect(history.state.testPage).toBe('base');
	expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
	await screen.rerender({ presentation: 'modal' });
	await expect.element(page.getByRole('dialog')).toBeVisible();
	expect(history.state?.[KEY]).toEqual(expect.any(String));
	expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
	expect(navigation).not.toHaveBeenCalled();
});

test('desktop/browser modals do not push or traverse history', async () => {
	vi.stubGlobal('Capacitor', undefined);
	const push = vi.spyOn(history, 'pushState');
	const back = vi.spyOn(history, 'back');
	await render(NativeModalFixture, { service: cableUi().service, onclose: vi.fn() });
	await page.getByRole('button', { name: m.chrome_write(), exact: true }).click();
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await page.getByRole('button', { name: m.cable_close(), exact: true }).click();
	expect(push).not.toHaveBeenCalled();
	expect(back).not.toHaveBeenCalled();
	expect(history.state.testPage).toBe('base');
});
