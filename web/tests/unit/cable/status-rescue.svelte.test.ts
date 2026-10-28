import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent, type Locator } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { FakeHIDDevice } from 'open-auri/transport';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import CableStatus from '#lib/components/cable/CableStatus.svelte';
import RescueNotice from '#lib/components/cable/RescueNotice.svelte';
import { cableUi } from './ui-fake.ts';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	vi.unstubAllGlobals();
});

/**
 * Unavailable says why (T8): aria-disabled, never the native attribute, the reason announced;
 * and it still never acts, clicked or pressed with Enter.
 */
async function expectRefused(control: Locator, reason: string) {
	await expect.element(control).toHaveAttribute('aria-disabled', 'true');
	await expect.element(control).not.toHaveAttribute('disabled');
	await expect.element(control).toHaveAccessibleDescription(reason);
	const element = control.element();
	if (!(element instanceof HTMLElement)) throw new Error('Missing control');
	element.click();
	element.focus();
	await userEvent.keyboard('{Enter}');
}

test('real disconnected status explains browser recognition and empty selection is polite feedback', async () => {
	const fake = cableUi({ mode: 'real' });
	await render(CableStatus, { service: fake.service });
	await expect.element(page.getByText(m.cable_connect_hint(), { exact: true })).toBeVisible();
	fake.publish({ error: 'request-empty' });
	await expect
		.element(page.getByText(m.cable_connect_no_selection(), { exact: true }))
		.toHaveAttribute('role', 'status');
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	const device = new FakeHIDDevice();
	fake.publish({
		connection: 'connected',
		device,
		deviceLabel: 'Kuba Auri',
		devices: [device],
		deviceLabels: ['Kuba Auri'],
		error: null
	});
	await tick();
	expect(page.getByText(m.cable_connect_hint(), { exact: true }).elements()).toHaveLength(0);
	expect(page.getByText(m.cable_connect_no_selection(), { exact: true }).elements()).toHaveLength(0);
});

test('native Android status does not give WebHID browser permission instructions', async () => {
	vi.stubGlobal('Capacitor', {
		isNativePlatform: () => true,
		getPlatform: () => 'android'
	});
	const fake = cableUi({ mode: 'real' });
	await render(CableStatus, { service: fake.service });
	expect(page.getByText(m.cable_connect_hint(), { exact: true }).elements()).toHaveLength(0);
	await page.getByRole('button', { name: m.cable_connect(), exact: true }).click();
	expect(fake.connect).toHaveBeenCalledExactlyOnceWith();
});

test('status reflects connection, mode and errors without connecting automatically', async () => {
	const fake = cableUi();
	await render(CableStatus, { service: fake.service });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_status_disconnected());
	await expect.element(page.getByText(m.cable_simulated_hint())).toBeVisible();
	expect(page.getByText(m.cable_connect_hint(), { exact: true }).elements()).toHaveLength(0);
	expect(fake.connect).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.cable_connect(), exact: true }).click();
	expect(fake.connect).toHaveBeenCalledExactlyOnceWith();

	fake.publish({ connection: 'connecting', mode: 'real' });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_status_connecting());
	// Waiting for the picker: a second request is refused, by click and by Enter.
	await expectRefused(
		page.getByRole('button', { name: m.cable_connect(), exact: true }),
		m.cabo_fux_connecting()
	);
	expect(fake.connect).toHaveBeenCalledOnce();
	expect(page.getByText(m.cable_simulated_hint()).elements()).toHaveLength(0);
	await expect.element(page.getByText(m.cable_mode_real(), { exact: true })).toBeVisible();

	fake.publish({ connection: 'connected', deviceLabel: 'Desk cable' });
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent(m.cable_status_connected({ device: 'Desk cable' }));
	await page.getByRole('button', { name: m.cable_add(), exact: true }).click();
	expect(fake.connect).toHaveBeenCalledTimes(2);
	await page.getByRole('button', { name: m.cable_disconnect(), exact: true }).click();
	expect(fake.disconnect).toHaveBeenCalledExactlyOnceWith();

	fake.publish({ writing: true });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_status_writing());
	// Mid-write nothing may connect, add or disconnect a cable: refused by click and by Enter.
	await expectRefused(
		page.getByRole('button', { name: m.cable_add(), exact: true }),
		m.cabo_fux_busy_writing()
	);
	await expectRefused(
		page.getByRole('button', { name: m.cable_disconnect(), exact: true }),
		m.cabo_fux_busy_writing()
	);
	expect(fake.connect).toHaveBeenCalledTimes(2);
	expect(fake.disconnect).toHaveBeenCalledOnce();
	fake.publish({ writing: false, deviceLabel: null });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_status_disconnected());

	for (const [error, text] of [
		['request-failed', m.cable_error_request()],
		['restore-failed', m.cable_error_restore()],
		['journal-failed', m.cable_error_journal()]
	] as const) {
		fake.publish({ error });
		await expect.element(page.getByRole('alert')).toHaveTextContent(text);
	}
	fake.publish({ error: null, connection: 'disconnected' });
	await tick();
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	expect(
		page.getByRole('button', { name: m.cable_disconnect(), exact: true }).elements()
	).toHaveLength(0);
	await cleanup();
	expect(fake.unsubscribe).toHaveBeenCalledOnce();
});

test('device selection handles no primary, a selected primary and an invalid change safely', async () => {
	const first = new FakeHIDDevice();
	const second = new FakeHIDDevice();
	const fake = cableUi({ devices: [first, second], deviceLabels: ['Left', 'Right'] });
	const screen = await render(CableStatus, { service: fake.service });
	const select = screen.container.querySelector<HTMLSelectElement>('select')!;
	// No target yet (e.g. several restored cables): a disabled placeholder, nothing preselected.
	expect(select.value).toBe('');
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_status_disconnected());
	expect(fake.selectDevice).not.toHaveBeenCalled();
	// Choosing the placeholder never selects a cable.
	select.dispatchEvent(new Event('change', { bubbles: true }));
	expect(fake.selectDevice).not.toHaveBeenCalled();
	select.value = '1';
	select.dispatchEvent(new Event('change', { bubbles: true }));
	expect(fake.selectDevice).toHaveBeenCalledExactlyOnceWith(second);
	// A select cannot retain a value that has no option: that becomes '', and Number('') is 0.
	// Use an actual out-of-range option to exercise a missing device rather than the first device.
	const missing = new Option('Unavailable device', '99');
	select.add(missing);
	select.value = '99';
	select.dispatchEvent(new Event('change', { bubbles: true }));
	expect(fake.selectDevice).toHaveBeenCalledOnce();
	missing.remove();
	fake.publish({ device: second, writing: true });
	// Mid-write the target never changes: locked but focusable, saying why, and a click, Enter,
	// arrow key or a change that still lands is refused (the real target is shown again).
	const combobox = page.getByRole('combobox');
	await expectRefused(combobox, m.cabo_fux_busy_writing());
	await userEvent.keyboard('{ArrowUp}');
	expect(select.value).toBe('1');
	select.value = '0';
	select.dispatchEvent(new Event('change', { bubbles: true }));
	expect(select.value).toBe('1');
	expect(fake.selectDevice).toHaveBeenCalledOnce();
	// A target that is not among the devices is never shown as one of them.
	fake.publish({ device: new FakeHIDDevice(), writing: false });
	await tick();
	expect(select.value).toBe('');
	fake.publish({ devices: [first], deviceLabels: ['Left'] });
	await tick();
	expect(page.getByRole('combobox').elements()).toHaveLength(0);
});

test('a single connected cable with no target still offers the selector', async () => {
	const only = new FakeHIDDevice();
	const fake = cableUi({
		connection: 'connected',
		devices: [only],
		deviceLabels: ['Only cable'],
		device: null,
		deviceLabel: null
	});
	await render(CableStatus, { service: fake.service });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_status_no_target());
	const select = page.getByRole('combobox', { name: m.cable_select_device() });
	await expect.element(select).toBeVisible();
	expect((select.element() as HTMLSelectElement).value).toBe('');
	await select.selectOptions('0');
	expect(fake.selectDevice).toHaveBeenCalledExactlyOnceWith(only);
	fake.publish({ device: only, deviceLabel: 'Only cable' });
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent(m.cable_status_connected({ device: 'Only cable' }));
	expect(page.getByRole('combobox').elements()).toHaveLength(0);
});

test('rescue is opt-in, shows zero sent reports, and hides missing journal metadata', async () => {
	const fake = cableUi();
	const onrescue = vi.fn();
	await render(RescueNotice, { service: fake.service, onrescue });
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	fake.publish({
		rescue: { at: 1, reportsSent: 0, deviceLabel: 'Interrupted cable', fresh: true }
	});
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.cable_rescue_body());
	// The alert is the body text only, not a container of buttons.
	expect(page.getByRole('alert').getByRole('button').elements()).toHaveLength(0);
	await expect.element(page.getByRole('region', { name: m.cable_rescue_title() })).toBeVisible();
	await expect.element(page.getByText(m.cable_rescue_reports({ count: '0' }))).toBeVisible();
	await expect
		.element(page.getByText(m.cable_rescue_device({ device: 'Interrupted cable' })))
		.toBeVisible();
	expect(onrescue).not.toHaveBeenCalled();
	expect(fake.writeQueue).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.cable_rescue_action() }).click();
	expect(onrescue).toHaveBeenCalledExactlyOnceWith(expect.any(MouseEvent));
	fake.publish({ writing: true, rescue: { at: 1, reportsSent: null, deviceLabel: null } });
	// A rescue never opens a second write mid-write: refused by click and by Enter.
	await expectRefused(
		page.getByRole('button', { name: m.cable_rescue_action() }),
		m.cabo_fux_busy_writing()
	);
	expect(onrescue).toHaveBeenCalledOnce();
	expect(page.getByText(m.cable_rescue_reports({ count: '0' })).elements()).toHaveLength(0);
	expect(
		page.getByText(m.cable_rescue_device({ device: 'Interrupted cable' })).elements()
	).toHaveLength(0);
	// Dismissal is still available during a write and never attempts another write.
	await page.getByRole('button', { name: m.cable_rescue_dismiss() }).click();
	expect(fake.dismissRescue).toHaveBeenCalledOnce();
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	await cleanup();
	expect(fake.unsubscribe).toHaveBeenCalledOnce();
});

test('an interruption restored from the journal on load is a polite region, not an alert (R2-12)', async () => {
	const fake = cableUi({ rescue: { at: 1, reportsSent: null, deviceLabel: 'Old cable' } });
	await render(RescueNotice, { service: fake.service, onrescue: vi.fn() });
	await expect.element(page.getByRole('region', { name: m.cable_rescue_title() })).toBeVisible();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_rescue_body());
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	await expect
		.element(page.getByRole('button', { name: m.cable_rescue_action() }))
		.not.toHaveAttribute('aria-disabled');
});
