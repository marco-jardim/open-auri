import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
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
});

test('status reflects connection, mode and errors without connecting automatically', async () => {
	const fake = cableUi();
	await render(CableStatus, { service: fake.service });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_status_disconnected());
	await expect.element(page.getByText(m.cable_simulated_hint())).toBeVisible();
	expect(fake.connect).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.cable_connect(), exact: true }).click();
	expect(fake.connect).toHaveBeenCalledExactlyOnceWith();

	fake.publish({ connection: 'connecting', mode: 'real' });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_status_connecting());
	await expect
		.element(page.getByRole('button', { name: m.cable_connect(), exact: true }))
		.toBeDisabled();
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
	for (const button of page.getByRole('button').elements()) expect(button).toBeDisabled();
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
	expect(select.value).toBe('0');
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
	await expect.element(page.getByRole('combobox')).toBeDisabled();
	expect(select.value).toBe('1');
	fake.publish({ device: new FakeHIDDevice(), writing: false });
	await tick();
	expect(select.value).toBe('0');
	fake.publish({ devices: [first], deviceLabels: ['Left'] });
	await tick();
	expect(page.getByRole('combobox').elements()).toHaveLength(0);
});

test('rescue is opt-in, shows zero sent reports, and hides missing journal metadata', async () => {
	const fake = cableUi();
	const onrescue = vi.fn();
	await render(RescueNotice, { service: fake.service, onrescue });
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	fake.publish({ rescue: { at: 1, reportsSent: 0, deviceLabel: 'Interrupted cable' } });
	await expect.element(page.getByRole('alert')).toBeVisible();
	await expect.element(page.getByText(m.cable_rescue_reports({ count: '0' }))).toBeVisible();
	await expect
		.element(page.getByText(m.cable_rescue_device({ device: 'Interrupted cable' })))
		.toBeVisible();
	expect(onrescue).not.toHaveBeenCalled();
	expect(fake.writeQueue).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.cable_rescue_action() }).click();
	expect(onrescue).toHaveBeenCalledExactlyOnceWith(expect.any(MouseEvent));
	fake.publish({ writing: true, rescue: { at: 1, reportsSent: null, deviceLabel: null } });
	await expect.element(page.getByRole('button', { name: m.cable_rescue_action() })).toBeDisabled();
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
