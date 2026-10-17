import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, type Locator } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { FakeHIDDevice } from 'open-auri/transport';
import PreWriteChecklist from '#lib/components/cable/PreWriteChecklist.svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { cableUi } from './ui-fake.ts';
import { writtenOutcome } from './outcomes.ts';
import type { WriteOutcome } from '#lib/cable/types.ts';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
});

async function confirm() {
	await page.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await page.getByRole('checkbox', { name: m.cable_confirm_connection() }).click();
}

/** FUX.P6: GRAVAR is a `Button` lever: locked means aria-disabled plus the reason it states. */
async function expectLocked(button: Locator, reason: string) {
	await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	await expect.element(button).toHaveAccessibleDescription(reason);
}

async function expectArmed(button: Locator) {
	await expect.element(button).not.toHaveAttribute('aria-disabled');
}

test('refusal preserves confirmations, success clears them, and closing/reopening starts fresh', async () => {
	const device = new FakeHIDDevice();
	const fake = cableUi({ device, devices: [device], deviceLabels: ['Test cable'] });
	const write = vi
		.fn<typeof fake.service.write>()
		.mockResolvedValueOnce({ status: 'refused', reason: 'gesture' })
		.mockResolvedValueOnce(writtenOutcome('simulated'));
	fake.service.write = write;
	const onresult = vi.fn();
	const onclose = vi.fn();
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: false,
		...NEUTRO,
		onresult,
		onclose
	});
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
	await screen.rerender({ open: true });
	const button = page.getByRole('button', { name: m.cable_write_simulated(), exact: true });
	await expectLocked(button, m.cable_fux_lock_levers());
	await confirm();
	await expectArmed(button);
	expect(write).not.toHaveBeenCalled();
	await button.click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_refused_gesture());
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_volume() }))
		.toBeChecked();
	await button.click();
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent(m.cable_result_simulated({ crc: '0x4FFF' }));
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_volume() }))
		.not.toBeChecked();
	await expectLocked(button, m.cable_fux_lock_levers());
	expect(onresult).toHaveBeenCalledTimes(2);
	expect(write.mock.calls[0][0]).toMatchObject({
		bands: NEUTRO.bands,
		preampDb: NEUTRO.preampDb,
		experimental: false,
		name: '',
		gesture: { kind: 'cable-gesture' },
		confirmations: { volumeLowered: true, keepConnected: true, experimental: false }
	});
	await confirm();
	await page.getByRole('button', { name: m.cable_close(), exact: true }).click();
	expect(onclose).toHaveBeenCalledOnce();
	await screen.rerender({ open: false });
	await screen.rerender({ open: true });
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_connection() }))
		.not.toBeChecked();
	expect(page.getByRole('status').elements()).toHaveLength(0);
});

test('the target cable is shown next to the write button; without one the user must choose', async () => {
	const left = new FakeHIDDevice();
	const right = new FakeHIDDevice();
	const fake = cableUi({
		connection: 'connected',
		devices: [left, right],
		deviceLabels: ['Left cable', 'Right cable'],
		device: null,
		deviceLabel: null
	});
	const write = vi.fn<typeof fake.service.write>();
	fake.service.write = write;
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose: vi.fn()
	});
	const button = page.getByRole('button', { name: m.cable_write_simulated(), exact: true });
	await expect.element(page.getByText(m.cable_target_required())).toBeVisible();
	expect(screen.container.querySelector('[data-target-device]')).toBeNull();
	expect(page.getByText(m.cable_refused_no_device(), { exact: true }).elements()).toHaveLength(0);
	await confirm();
	await expectLocked(button, m.cable_fux_lock_target());
	const select = page.getByRole('dialog').getByRole('combobox', { name: m.cable_select_device() });
	expect((select.element() as HTMLSelectElement).value).toBe('');
	await select.selectOptions('1');
	expect(fake.selectDevice).toHaveBeenCalledExactlyOnceWith(right);
	// Selecting never writes.
	expect(write).not.toHaveBeenCalled();
	fake.publish({ device: right, deviceLabel: 'Right cable' });
	await expect
		.element(page.getByText(m.cable_target_device({ device: 'Right cable' }), { exact: true }))
		.toBeVisible();
	expect(screen.container.querySelector('[data-target-device]')?.textContent?.trim()).toBe(
		m.cable_target_device({ device: 'Right cable' })
	);
	expect((select.element() as HTMLSelectElement).value).toBe('1');
	// The confirmations were given before a target existed: a new target asks for them again.
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_volume() }))
		.not.toBeChecked();
	await expectLocked(button, m.cable_fux_lock_levers());
	await confirm();
	await expectArmed(button);
	expect(write).not.toHaveBeenCalled();
	// One cable: the label is shown and no selector is needed.
	fake.publish({ devices: [right], deviceLabels: ['Right cable'] });
	await expect
		.element(page.getByText(m.cable_target_device({ device: 'Right cable' }), { exact: true }))
		.toBeVisible();
	expect(page.getByRole('dialog').getByRole('combobox').elements()).toHaveLength(0);
});

test('unplugging the target clears the confirmations and never shows another cable as the target', async () => {
	const left = new FakeHIDDevice();
	const right = new FakeHIDDevice();
	const fake = cableUi({
		connection: 'connected',
		devices: [left, right],
		deviceLabels: ['Left cable', 'Right cable'],
		device: left,
		deviceLabel: 'Left cable'
	});
	const write = vi.fn<typeof fake.service.write>();
	fake.service.write = write;
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose: vi.fn()
	});
	const button = page.getByRole('button', { name: m.cable_write_simulated(), exact: true });
	await confirm();
	await expectArmed(button);
	// The service leaves no target after an unplug; the ticked boxes were for "Left cable".
	fake.publish({
		devices: [right],
		deviceLabels: ['Right cable'],
		device: null,
		deviceLabel: null
	});
	await expect.element(page.getByText(m.cable_target_required())).toBeVisible();
	expect(screen.container.querySelector('[data-target-device]')).toBeNull();
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_volume() }))
		.not.toBeChecked();
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_connection() }))
		.not.toBeChecked();
	await expectLocked(button, m.cable_fux_lock_target());
	// A state update that keeps the same target keeps the confirmations.
	fake.publish({ device: right, deviceLabel: 'Right cable' });
	await confirm();
	fake.publish({ writing: false });
	await expectArmed(button);
	expect(write).not.toHaveBeenCalled();
});

test('a dialog forced closed mid-write reopens at once, shows the outcome and closes only afterwards', async () => {
	const device = new FakeHIDDevice();
	const fake = cableUi({ device, devices: [device], deviceLabels: ['Test cable'] });
	let finish: ((outcome: WriteOutcome) => void) | undefined;
	fake.service.write = vi.fn<typeof fake.service.write>(() => {
		fake.publish({ writing: true });
		return new Promise<WriteOutcome>((resolve) => {
			finish = resolve;
		});
	});
	const onclose = vi.fn();
	const onresult = vi.fn();
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose,
		onresult
	});
	const dialog = screen.container.querySelector('dialog');
	if (!dialog) throw new Error('Missing dialog');
	expect(dialog.getAttribute('closedby')).toBe('closerequest');
	await confirm();
	await page.getByRole('button', { name: m.cable_write_simulated(), exact: true }).click();
	await expect.poll(() => dialog.getAttribute('closedby')).toBe('none');
	// Chromium's close watcher can close a modal without a cancelable `cancel` (second Esc,
	// Android back): emulate that forced close.
	dialog.close();
	expect(dialog.open).toBe(false);
	await expect.poll(() => dialog.open).toBe(true);
	expect(dialog.matches(':modal')).toBe(true);
	expect(onclose).not.toHaveBeenCalled();
	// The outcome still reaches the reopened dialog and the parent.
	fake.publish({ writing: false });
	finish?.(writtenOutcome('simulated'));
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent(m.cable_result_simulated({ crc: '0x4FFF' }));
	expect(onresult).toHaveBeenCalledOnce();
	expect(dialog.getAttribute('closedby')).toBe('closerequest');
	// After the write a close is an ordinary close: the parent releases its checklist state.
	dialog.close();
	await expect.poll(() => onclose.mock.calls.length).toBe(1);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(dialog.open).toBe(false);
});

test('diagnostics show failed/unknown lamps, loudness, experimental consent and cooldown; cancellation is blocked during writes', async () => {
	const fake = cableUi();
	const original = fake.service.checklist;
	let waitMs = 20;
	let deltaDb: number | null = 3;
	fake.service.checklist = vi.fn<typeof fake.service.checklist>((request, gate) => {
		const result = original(request, gate);
		return {
			...result,
			crc: null,
			lamps: result.lamps.map((lamp, index) => ({
				...lamp,
				state: index === 0 ? ('fail' as const) : ('unknown' as const),
				reasons:
					index === 0
						? [
								{
									code: 'g:preamp' as const,
									messageKey: 'cable_reason_g_preamp' as const,
									stage: 1,
									value: 1,
									limit: 0
								}
							]
						: []
			})),
			loudness: {
				...result.loudness,
				warn: true,
				reasons: ['jump' as const, 'unknown-state' as const],
				deltaDb
			},
			experimentalRequired: true,
			dailyNotice: { show: true, text: result.dailyNotice.text },
			spacing: { ok: waitMs === 0, waitMs },
			canWrite: false
		};
	});
	const onclose = vi.fn();
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		experimental: true,
		onclose
	});
	await expect.element(page.getByText(m.cable_loudness_jump({ delta: '+3,0' }))).toBeVisible();
	await expect.element(page.getByText(m.cable_loudness_unknown())).toBeVisible();
	await expect.element(page.getByText(m.cable_flash_notice())).toBeVisible();
	await expect.element(page.getByText(m.cable_refused_no_device(), { exact: true })).toBeVisible();
	await expect.element(page.getByText(m.cable_spacing_wait({ seconds: '0,0' }))).toBeVisible();
	await page.getByRole('checkbox', { name: m.cable_confirm_experimental() }).click();
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_experimental() }))
		.toBeChecked();
	expect(screen.container.querySelector('[data-state="fail"] ul')).not.toBeNull();
	expect(screen.container.querySelectorAll('[data-state="unknown"]')).toHaveLength(7);
	waitMs = 0;
	await expect.element(page.getByText(m.cable_spacing_ready())).toBeVisible();
	deltaDb = null;
	fake.publish({ writing: true, mode: 'real' });
	await expectLocked(
		page.getByRole('button', { name: m.cable_close(), exact: true }),
		m.cable_fux_close_locked()
	);
	await expectLocked(
		page.getByRole('button', { name: m.cable_write(), exact: true }),
		m.cable_fux_lock_writing()
	);
	expect(page.getByText(m.cable_loudness_jump({ delta: '+3,0' })).elements()).toHaveLength(0);
	const dialog = screen.container.querySelector('dialog')!;
	const blocked = new Event('cancel', { cancelable: true });
	dialog.dispatchEvent(blocked);
	expect(blocked.defaultPrevented).toBe(true);
	expect(onclose).not.toHaveBeenCalled();
	fake.publish({ writing: false });
	await tick();
	const allowed = new Event('cancel', { cancelable: true });
	dialog.dispatchEvent(allowed);
	expect(allowed.defaultPrevented).toBe(false);
	dialog.close();
	await expect.poll(() => onclose.mock.calls.length).toBe(1);
});
