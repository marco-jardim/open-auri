import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import NativeModalFixture from './NativeModalFixture.svelte';
import NativePopoverFixture from './NativePopoverFixture.svelte';
import ConfirmDialog from '#lib/components/chrome/ConfirmDialog.svelte';
import AndroidUntestedNotice from '#lib/components/cable/AndroidUntestedNotice.svelte';
import { NATIVE_BACK_EVENT, registerNativeBack } from '#lib/components/chrome/native-back.ts';
import { cableUi } from '../cable/ui-fake.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import '../primitives/design-system.ts';

/** The cancelable event portion of MainActivity.NATIVE_BACK_SCRIPT. */
function pressBack(): boolean {
	return !window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT, { cancelable: true }));
}

/** The full native script result, before MainActivity performs history/leave navigation. */
function nativeBackAction(): 'consumed' | 'leave' | 'history' {
	return window.__oaWriteInProgress === true || pressBack()
		? 'consumed'
		: window.__oaBackLeaves === true
			? 'leave'
			: 'history';
}

/** Lets any Svelte update or dialog event caused by the press land before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	// At 360 px the bar shows its menu button (FUX.NAV): the phone layout.
	await page.viewport(360, 760);
	vi.stubGlobal('Capacitor', {
		isNativePlatform: () => true,
		getPlatform: () => 'android'
	});
	localStorage.removeItem('oa.androidDisclaimerAck');
});

afterEach(async () => {
	try {
		await cleanup();
		// Every unmounted modal unregistered: Back is the app's again (history, else exit).
		expect(window.__oaBackLeaves).toBe(false);
		expect(pressBack()).toBe(false);
	} finally {
		localStorage.removeItem('oa.androidDisclaimerAck');
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await setLocale('pt-BR', { reload: false });
		await page.viewport(1440, 900);
	}
});

async function openChecklist(unsaved = false) {
	const fake = cableUi();
	const onclose = vi.fn();
	await render(NativeModalFixture, { service: fake.service, onclose, unsaved });
	const trigger = page.getByRole('button', { name: m.chrome_write(), exact: true });
	await trigger.click();
	await expect.element(page.getByRole('dialog', { name: m.cable_checklist_title() })).toBeVisible();
	return { fake, onclose, trigger };
}

test('Back closes the write sheet and restored unsaved-tooltip focus does not consume the next Back', async () => {
	const push = vi.spyOn(history, 'pushState');
	const back = vi.spyOn(history, 'back');
	const length = history.length;
	const { onclose, trigger } = await openChecklist(true);
	expect(pressBack()).toBe(true);
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(onclose).toHaveBeenCalledOnce();
	await expect.element(trigger).toHaveFocus();
	await expect
		.element(page.getByRole('tooltip', { includeHidden: true }).filter({ hasText: m.chrome_unsaved() }))
		.toBeVisible();
	// Only a passive tooltip is open: Back is left to the app (history, else leave).
	expect(pressBack()).toBe(false);
	expect(onclose).toHaveBeenCalledOnce();
	expect(push).not.toHaveBeenCalled();
	expect(back).not.toHaveBeenCalled();
	expect(history.length).toBe(length);
});

test.each(['button', 'Escape'] as const)(
	'after a %s close the stack is empty; reopening registers again',
	async (method) => {
		const { onclose, trigger } = await openChecklist();
		if (method === 'button') {
			await page.getByRole('button', { name: m.cable_close(), exact: true }).click();
		} else {
			await userEvent.keyboard('{Escape}');
		}
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
		expect(onclose).toHaveBeenCalledOnce();
		expect(pressBack()).toBe(false);
		await trigger.click();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		expect(pressBack()).toBe(true);
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
		expect(onclose).toHaveBeenCalledTimes(2);
		await expect.element(trigger).toHaveFocus();
	}
);

test('stacked dialogs close topmost first, one per Back', async () => {
	const { onclose } = await openChecklist();
	const onResult = vi.fn();
	await render(ConfirmDialog, { open: true, title: 'Topmost', onResult });
	await expect.element(page.getByRole('dialog', { name: 'Topmost' })).toBeVisible();
	expect(pressBack()).toBe(true);
	await expect.element(page.getByRole('dialog', { name: 'Topmost' })).not.toBeInTheDocument();
	expect(onResult).toHaveBeenCalledExactlyOnceWith(false);
	expect(onclose).not.toHaveBeenCalled();
	await expect.element(page.getByRole('dialog', { name: m.cable_checklist_title() })).toBeVisible();
	expect(pressBack()).toBe(true);
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(onclose).toHaveBeenCalledOnce();
	expect(pressBack()).toBe(false);
});

test('the menu drawer closes on Back and returns focus; a dialog opened from it is the next Back', async () => {
	await render(NativeModalFixture, { service: cableUi().service, onclose: vi.fn() });
	const menu = page.getByRole('button', { name: m.fuxnav_menu_open(), exact: true });
	await menu.click();
	await expect.element(page.getByRole('dialog', { name: m.fuxnav_sheet_title() })).toBeVisible();
	expect(pressBack()).toBe(true);
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	await expect.element(menu).toHaveFocus();
	expect(pressBack()).toBe(false);
	// The sheet closes first, then its action opens a dialog: only that dialog is on the stack.
	await menu.click();
	await page.getByRole('button', { name: m.chrome_help_open(), exact: true }).click();
	await expect.element(page.getByRole('dialog', { name: 'Help confirmation' })).toBeVisible();
	expect(page.getByRole('dialog', { name: m.fuxnav_sheet_title() }).elements()).toHaveLength(0);
	expect(pressBack()).toBe(true);
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(pressBack()).toBe(false);
});

test('a write in progress consumes Back without closing; after the write Back closes the sheet', async () => {
	const { fake, onclose } = await openChecklist();
	fake.publish({ writing: true });
	const dialog = page.getByRole('dialog').element() as HTMLDialogElement;
	await expect.element(dialog).toHaveAttribute('closedby', 'none');
	for (let press = 0; press < 3; press += 1) {
		expect(pressBack()).toBe(true);
		await settle();
		expect(dialog.matches(':modal')).toBe(true);
	}
	expect(onclose).not.toHaveBeenCalled();
	// A forced native close (repeated Esc) reopens at once and keeps Back registered.
	dialog.close();
	await expect.poll(() => dialog.matches(':modal')).toBe(true);
	expect(pressBack()).toBe(true);
	await settle();
	expect(dialog.matches(':modal')).toBe(true);
	expect(onclose).not.toHaveBeenCalled();
	fake.publish({ writing: false });
	await expect.element(dialog).toHaveAttribute('closedby', 'closerequest');
	expect(pressBack()).toBe(true);
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(onclose).toHaveBeenCalledOnce();
	expect(pressBack()).toBe(false);
});

// Outside and trigger dismissal are the popover's own behaviour (covered with the real layout);
// in this fixture the top-layer popover covers both targets.
test.each(['Back', 'Escape'] as const)(
	'the cable status popover closes on %s, unregisters, and Back works again after reopening',
	async (method) => {
		const fake = cableUi();
		const screen = await render(NativePopoverFixture, { service: fake.service });
		const trigger = page.getByRole('button', { name: 'Cable status', exact: true });
		const popover = screen.container.querySelector<HTMLElement>('[data-chrome="status"]')!;
		expect(pressBack()).toBe(false);
		await trigger.click();
		await expect.element(popover).toBeVisible();
		if (method === 'Back') expect(pressBack()).toBe(true);
		else await userEvent.keyboard('{Escape}');
		await expect.element(popover).not.toBeVisible();
		expect(pressBack()).toBe(false);
		await trigger.click();
		await expect.element(popover).toBeVisible();
		expect(pressBack()).toBe(true);
		await expect.element(popover).not.toBeVisible();
		expect(pressBack()).toBe(false);
		await trigger.click();
		await expect.element(popover).toBeVisible();
		await cleanup();
		expect(pressBack()).toBe(false);
		expect(fake.connect).not.toHaveBeenCalled();
		expect(fake.disconnect).not.toHaveBeenCalled();
	}
);

test('outside Android the cable status popover does not register Back', async () => {
	vi.stubGlobal('Capacitor', undefined);
	const screen = await render(NativePopoverFixture, { service: cableUi().service });
	await page.getByRole('button', { name: 'Cable status', exact: true }).click();
	const popover = screen.container.querySelector<HTMLElement>('[data-chrome="status"]')!;
	await expect.element(popover).toBeVisible();
	expect(pressBack()).toBe(false);
	await expect.element(popover).toBeVisible();
});

test('the first-run notice lets Back leave without closing or acknowledging until Entendi', async () => {
	await render(AndroidUntestedNotice, { kind: 'native', validated: false, version: 1 });
	await expect.element(page.getByRole('dialog')).toBeVisible();
	const dialog = page.getByRole('dialog').element() as HTMLDialogElement;
	const ack = page.getByRole('button', { name: m.android_untested_ack() });
	expect(window.__oaBackLeaves).toBe(true);
	for (let press = 0; press < 3; press += 1) {
		expect(nativeBackAction()).toBe('leave');
		await settle();
		expect(dialog.matches(':modal')).toBe(true);
		expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
	}
	await expect.element(ack).toHaveFocus();
	// A forced close reopens with focus on Entendi; Back still lets the app leave.
	dialog.close();
	await expect.poll(() => dialog.matches(':modal')).toBe(true);
	await expect.element(ack).toHaveFocus();
	expect(pressBack()).toBe(false);
	await ack.click();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(localStorage.getItem('oa.androidDisclaimerAck')).toBe('1');
	expect(window.__oaBackLeaves).toBe(false);
	expect(nativeBackAction()).toBe('history');
});

test('switching the notice to the recovery banner unregisters it; back to the modal registers again', async () => {
	const dismissBelow = vi.fn();
	const releaseBelow = registerNativeBack({ canDismiss: () => true, dismiss: dismissBelow });
	try {
		const screen = await render(AndroidUntestedNotice, { kind: 'native', validated: false });
		await expect.element(page.getByRole('dialog')).toBeVisible();
		expect(window.__oaBackLeaves).toBe(true);
		expect(pressBack()).toBe(false);
		expect(dismissBelow).not.toHaveBeenCalled();
		await screen.rerender({ presentation: 'banner' });
		await expect.element(page.getByRole('complementary')).toBeVisible();
		expect(window.__oaBackLeaves).toBe(false);
		expect(pressBack()).toBe(true);
		expect(dismissBelow).toHaveBeenCalledOnce();
		await screen.rerender({ presentation: 'modal' });
		await expect.element(page.getByRole('dialog')).toBeVisible();
		expect(window.__oaBackLeaves).toBe(true);
		expect(pressBack()).toBe(false);
		expect(dismissBelow).toHaveBeenCalledOnce();
		expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
	} finally {
		releaseBelow();
	}
});

test('the stack: topmost first, a guarded top consumes Back without reaching the one below', () => {
	let guarded = true;
	const below = { canDismiss: vi.fn(() => true), dismiss: vi.fn() };
	const top = { canDismiss: vi.fn(() => !guarded), dismiss: vi.fn() };
	const releaseBelow = registerNativeBack(below);
	const releaseTop = registerNativeBack(top);
	expect(pressBack()).toBe(true);
	expect(top.canDismiss).toHaveBeenCalledOnce();
	expect(top.dismiss).not.toHaveBeenCalled();
	expect(below.canDismiss).not.toHaveBeenCalled();
	expect(below.dismiss).not.toHaveBeenCalled();
	guarded = false;
	expect(pressBack()).toBe(true);
	expect(top.dismiss).toHaveBeenCalledOnce();
	expect(below.dismiss).not.toHaveBeenCalled();
	// Unregistering is the owner's job (and idempotent); then the one below is topmost.
	releaseTop();
	releaseTop();
	expect(pressBack()).toBe(true);
	expect(below.dismiss).toHaveBeenCalledOnce();
	releaseBelow();
	expect(pressBack()).toBe(false);
});

test('a blocked notice on top lets Back through without dismissing the overlay below', async () => {
	const onResult = vi.fn();
	await render(ConfirmDialog, { open: true, title: 'Below the notice', onResult });
	await render(AndroidUntestedNotice, { kind: 'native', validated: false });
	const notice = page.getByRole('dialog', { name: m.android_untested_title() });
	await expect.element(notice).toBeVisible();
	expect(pressBack()).toBe(false);
	expect(onResult).not.toHaveBeenCalled();
	expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
	await notice.getByRole('button', { name: m.android_untested_ack() }).click();
	await expect.element(notice).not.toBeInTheDocument();
	expect(pressBack()).toBe(true);
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(onResult).toHaveBeenCalledExactlyOnceWith(false);
});

test('outside the Android app nothing registers and Back is never consumed', async () => {
	vi.stubGlobal('Capacitor', undefined);
	const dismiss = vi.fn();
	const release = registerNativeBack({ canDismiss: () => true, dismiss });
	expect(pressBack()).toBe(false);
	expect(dismiss).not.toHaveBeenCalled();
	release();
	const push = vi.spyOn(history, 'pushState');
	await render(NativeModalFixture, { service: cableUi().service, onclose: vi.fn() });
	await page.getByRole('button', { name: m.chrome_write(), exact: true }).click();
	const sheet = page.getByRole('dialog', { name: m.cable_checklist_title() });
	await expect.element(sheet).toBeVisible();
	expect(pressBack()).toBe(false);
	await settle();
	await expect.element(sheet).toBeVisible();
	await page.getByRole('button', { name: m.cable_close(), exact: true }).click();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(push).not.toHaveBeenCalled();
});

test('a notice lets Back leave unless any lower consuming overlay is busy; stack changes refresh the leave flag', () => {
	let busy = true;
	const dismissBusy = vi.fn();
	const dismissMiddle = vi.fn();
	const dismissNotice = vi.fn();
	const dismissAbove = vi.fn();
	const releaseBusy = registerNativeBack({ canDismiss: () => !busy, dismiss: dismissBusy });
	const releaseMiddle = registerNativeBack({ canDismiss: () => true, dismiss: dismissMiddle });
	const releaseNotice = registerNativeBack({
		canDismiss: () => false,
		dismiss: dismissNotice,
		consumeWhenBlocked: false
	});
	let releaseAbove: () => void = () => undefined;
	try {
		expect(window.__oaBackLeaves).toBe(true);
		expect(nativeBackAction()).toBe('consumed');
		expect(dismissBusy).not.toHaveBeenCalled();
		expect(dismissMiddle).not.toHaveBeenCalled();
		expect(dismissNotice).not.toHaveBeenCalled();
		busy = false;
		expect(nativeBackAction()).toBe('leave');
		releaseAbove = registerNativeBack({ canDismiss: () => true, dismiss: dismissAbove });
		expect(window.__oaBackLeaves).toBe(false);
		expect(nativeBackAction()).toBe('consumed');
		expect(dismissAbove).toHaveBeenCalledOnce();
		releaseAbove();
		expect(window.__oaBackLeaves).toBe(true);
		// Removing non-top entries must not clear the notice's leave flag.
		releaseBusy();
		releaseMiddle();
		expect(window.__oaBackLeaves).toBe(true);
		releaseNotice();
		expect(window.__oaBackLeaves).toBe(false);
		releaseNotice();
		expect(window.__oaBackLeaves).toBe(false);
		expect(nativeBackAction()).toBe('history');
	} finally {
		releaseAbove();
		releaseNotice();
		releaseMiddle();
		releaseBusy();
	}
});

test('a non-consuming overlay that becomes dismissible clears the leave flag on Back', () => {
	let blocked = true;
	const dismiss = vi.fn();
	const release = registerNativeBack({
		canDismiss: () => !blocked,
		dismiss,
		consumeWhenBlocked: false
	});
	try {
		expect(window.__oaBackLeaves).toBe(true);
		blocked = false;
		expect(nativeBackAction()).toBe('consumed');
		expect(window.__oaBackLeaves).toBe(false);
		expect(dismiss).toHaveBeenCalledOnce();
	} finally {
		release();
	}
});

test('the native write flag consumes Back before dispatch even when the notice requests leave', async () => {
	await render(AndroidUntestedNotice, { kind: 'native', validated: false });
	await expect.element(page.getByRole('dialog')).toBeVisible();
	const dispatched = vi.fn();
	window.addEventListener(NATIVE_BACK_EVENT, dispatched);
	try {
		vi.stubGlobal('__oaWriteInProgress', true);
		expect(window.__oaBackLeaves).toBe(true);
		expect(nativeBackAction()).toBe('consumed');
		expect(dispatched).not.toHaveBeenCalled();
		expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
	} finally {
		window.removeEventListener(NATIVE_BACK_EVENT, dispatched);
	}
});
