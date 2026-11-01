import '../primitives/design-system.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { FakeHIDDevice } from 'open-auri/transport';
import PreWriteChecklist from '#lib/components/cable/PreWriteChecklist.svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { cableUi } from './ui-fake.ts';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

function dialogIn(container: HTMLElement): HTMLDialogElement {
	const dialog = container.querySelector('dialog');
	if (!dialog) throw new Error('Missing dialog');
	return dialog;
}

/** A point on the backdrop: left of the panel, level with its top. */
function backdropPoint(dialog: HTMLDialogElement) {
	const box = dialog.getBoundingClientRect();
	expect(box.left).toBeGreaterThan(6);
	return { clientX: box.left - 6, clientY: box.top + 10 };
}

/** A point inside the panel's box. */
function panelPoint(dialog: HTMLDialogElement) {
	const box = dialog.getBoundingClientRect();
	return { clientX: box.left + 20, clientY: box.top + 20 };
}

type Point = { clientX: number; clientY: number };

/** The browser's sequence for one press: pointerdown where it starts, click where it ends. */
function press(down: Element, downAt: Point, up: Element, upAt: Point) {
	down.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, ...downAt }));
	up.dispatchEvent(new MouseEvent('click', { bubbles: true, ...upAt }));
}

function clickBackdrop(dialog: HTMLDialogElement) {
	const point = backdropPoint(dialog);
	press(dialog, point, dialog, point);
}

async function confirm() {
	await page.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await page.getByRole('checkbox', { name: m.cable_confirm_connection() }).click();
}

function closeButton(): HTMLElement {
	const element = page.getByRole('button', { name: m.cable_close(), exact: true }).element();
	if (!(element instanceof HTMLElement)) throw new Error('Missing close button');
	return element;
}

function channel(value: number): number {
	const c = value / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** RGBA of any CSS colour, resolved by the browser. */
function rgba(color: string): [number, number, number, number] {
	const context = new OffscreenCanvas(1, 1).getContext('2d');
	if (!context) throw new Error('No 2D canvas');
	context.fillStyle = color;
	context.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
	return [r, g, b, a];
}

function luminance(color: string): number {
	const [r, g, b] = rgba(color);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
	const [x, y] = [luminance(a), luminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The middle stop of the checklist's brushed-aluminium panel. */
const PANEL = '#b5b8b4';

async function settled(element: HTMLElement) {
	await expect.poll(() => element.getAnimations().length).toBe(0);
	return getComputedStyle(element);
}

test('a backdrop press closes like Fechar: same callback, focus restored, fresh confirmations', async () => {
	const opener = document.createElement('button');
	opener.textContent = 'opener';
	document.body.append(opener);
	opener.focus();
	try {
		const device = new FakeHIDDevice();
		const fake = cableUi({ device, devices: [device], deviceLabels: ['Test cable'] });
		const onclose = vi.fn();
		const screen = await render(PreWriteChecklist, {
			service: fake.service,
			open: true,
			...NEUTRO,
			onclose
		});
		const dialog = dialogIn(screen.container);
		await confirm();
		clickBackdrop(dialog);
		expect(onclose).toHaveBeenCalledOnce();
		expect(onclose).toHaveBeenCalledWith();
		await screen.rerender({ open: false });
		expect(dialog.open).toBe(false);
		expect(document.activeElement).toBe(opener);
		await screen.rerender({ open: true });
		await expect
			.element(page.getByRole('checkbox', { name: m.cable_confirm_volume() }))
			.not.toBeChecked();
		await expect
			.element(page.getByRole('checkbox', { name: m.cable_confirm_connection() }))
			.not.toBeChecked();
	} finally {
		opener.remove();
	}
});

test('presses inside the panel, on its scrollbar, or dragged across its edge never close it', async () => {
	const fake = cableUi();
	const onclose = vi.fn();
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose
	});
	const dialog = dialogIn(screen.container);
	const title = page.getByRole('heading', { name: m.cable_checklist_title() }).element();
	// A real click on the panel's content.
	await page.getByRole('heading', { name: m.cable_checklist_title() }).click();
	// Inside the dialog's own box (its padding or scrollbar), the target is the dialog itself.
	press(dialog, panelPoint(dialog), dialog, panelPoint(dialog));
	// Text selection or drag: starts in the panel, ends on the backdrop (click on the dialog).
	press(title, panelPoint(dialog), dialog, backdropPoint(dialog));
	// And the other way round: starts on the backdrop, ends in the panel.
	press(dialog, backdropPoint(dialog), dialog, panelPoint(dialog));
	// A click with no press first (keyboard activation, synthetic) is not a backdrop press.
	dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, ...backdropPoint(dialog) }));
	await tick();
	expect(onclose).not.toHaveBeenCalled();
	expect(dialog.open).toBe(true);
	// The tracking resets after each click: a later genuine backdrop press still closes.
	clickBackdrop(dialog);
	expect(onclose).toHaveBeenCalledOnce();
});

test('while a write is running a backdrop press does not close, exactly when Fechar is locked', async () => {
	const fake = cableUi();
	const onclose = vi.fn();
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose
	});
	const dialog = dialogIn(screen.container);
	fake.publish({ writing: true });
	await expect.element(closeButton()).toHaveAttribute('aria-disabled', 'true');
	await expect.element(closeButton()).toHaveAccessibleDescription(m.cable_fux_close_locked());
	clickBackdrop(dialog);
	await tick();
	expect(onclose).not.toHaveBeenCalled();
	expect(dialog.open).toBe(true);
	fake.publish({ writing: false });
	await expect.element(closeButton()).not.toHaveAttribute('aria-disabled');
	clickBackdrop(dialog);
	expect(onclose).toHaveBeenCalledOnce();
});

test('Fechar reads clearly on the metal panel, available and locked (WCAG AA)', async () => {
	const fake = cableUi();
	await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose: vi.fn()
	});
	const button = closeButton();
	const ready = await settled(button);
	expect(rgba(ready.backgroundColor)[3]).toBe(255);
	expect(contrast(ready.color, ready.backgroundColor)).toBeGreaterThanOrEqual(4.5);
	// The face itself stands out from the aluminium (non-text contrast, WCAG 1.4.11).
	expect(contrast(ready.backgroundColor, PANEL)).toBeGreaterThanOrEqual(3);

	fake.publish({ writing: true });
	await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	const locked = await settled(button);
	expect(rgba(locked.backgroundColor)[3]).toBe(255);
	expect(contrast(locked.color, locked.backgroundColor)).toBeGreaterThanOrEqual(4.5);
	expect(contrast(locked.backgroundColor, PANEL)).toBeGreaterThanOrEqual(3);
});
