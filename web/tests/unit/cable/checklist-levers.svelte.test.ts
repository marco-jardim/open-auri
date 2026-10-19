// FUX.P6: the materialised checklist. Each lever is bound to exactly one confirmation, GRAVAR
// stays the only gesture, the salto is shown and the literal loudness warning never leaves.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { FakeHIDDevice } from 'open-auri/transport';
import PreWriteChecklist from '#lib/components/cable/PreWriteChecklist.svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import type { Band, ChecklistResult } from '#lib/cable/types.ts';
import { cableUi } from './ui-fake.ts';
import { writtenOutcome } from './outcomes.ts';

/** Plan §3.4, literal (A6: exact string). */
const LOUDNESS_LITERAL = 'A nova curva pode soar mais alta. Abaixe o volume antes de gravar.';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

function connected() {
	const device = new FakeHIDDevice();
	return cableUi({
		connection: 'connected',
		device,
		devices: [device],
		deviceLabels: ['Test cable'],
		deviceLabel: 'Test cable'
	});
}

test('each lever is bound to exactly one confirmation and only GRAVAR writes, with a gesture', async () => {
	const fake = connected();
	const checklist = vi.spyOn(fake.service, 'checklist');
	const write = vi.fn<typeof fake.service.write>().mockResolvedValue(writtenOutcome('simulated'));
	fake.service.write = write;
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose: vi.fn()
	});
	const volume = page.getByRole('checkbox', { name: m.cable_confirm_volume(), exact: true });
	const connection = page.getByRole('checkbox', {
		name: m.cable_confirm_connection(),
		exact: true
	});
	const lever = page.getByRole('button', { name: m.cable_write_simulated(), exact: true });
	const latest = () => checklist.mock.calls.at(-1)?.[0].confirmations;
	const art = (kind: string) =>
		screen.container.querySelector(`[data-confirmation="${kind}"]`)?.getAttribute('data-on');

	await expect
		.poll(latest)
		.toEqual({ volumeLowered: false, keepConnected: false, experimental: false, yoloWrite: false });
	await expect.element(lever).toHaveAttribute('aria-disabled', 'true');
	await expect.element(lever).toHaveAccessibleDescription(m.cable_fux_lock_levers());

	await volume.click();
	await expect
		.poll(latest)
		.toEqual({ volumeLowered: true, keepConnected: false, experimental: false, yoloWrite: false });
	expect(art('volume')).toBe('true');
	expect(art('connection')).toBe('false');
	await expect.element(lever).toHaveAttribute('aria-disabled', 'true');

	await connection.click();
	await expect
		.poll(latest)
		.toEqual({ volumeLowered: true, keepConnected: true, experimental: false, yoloWrite: false });
	await expect.element(lever).not.toHaveAttribute('aria-disabled');

	// Throwing one lever back withdraws only its own confirmation.
	await volume.click();
	await expect
		.poll(latest)
		.toEqual({ volumeLowered: false, keepConnected: true, experimental: false, yoloWrite: false });
	await expect.element(lever).toHaveAccessibleDescription(m.cable_fux_lock_levers());
	await volume.click();
	await expect.element(lever).not.toHaveAttribute('aria-disabled');

	// Levers never write and never mint a gesture; GRAVAR does both, once, in its click.
	expect(write).not.toHaveBeenCalled();
	expect(fake.createGesture).not.toHaveBeenCalled();
	await lever.click();
	await expect.poll(() => write.mock.calls.length).toBe(1);
	expect(fake.createGesture).toHaveBeenCalledOnce();
	expect(write.mock.calls[0][0]).toMatchObject({
		bands: NEUTRO.bands,
		preampDb: NEUTRO.preampDb,
		confirmations: {
			volumeLowered: true,
			keepConnected: true,
			experimental: false,
			yoloWrite: false
		},
		gesture: { kind: 'cable-gesture' }
	});
	// Every write needs fresh levers.
	await expect.element(volume).not.toBeChecked();
	await expect.element(connection).not.toBeChecked();
	await expect.element(lever).toHaveAttribute('aria-disabled', 'true');
});

test('FUX.Q N7: the locked GRAVAR lever never writes on click, Enter or Space', async () => {
	const fake = connected();
	const write = vi.fn<typeof fake.service.write>().mockResolvedValue(writtenOutcome('simulated'));
	fake.service.write = write;
	const shelf: Band = { kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 };
	await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		bands: [shelf, ...NEUTRO.bands.slice(1)],
		preampDb: -1,
		experimental: true,
		onclose: vi.fn()
	});
	const lever = page.getByRole('button', { name: m.cable_write_simulated(), exact: true });
	const node = () => lever.element() as HTMLButtonElement;
	/**
	 * Every way a user (or a script) can activate the button. The pointer click is forced: an
	 * aria-disabled button fails the runner's "enabled" actionability check, but a real user
	 * can still press it.
	 */
	async function tryEverything(): Promise<void> {
		await userEvent.click(node(), { force: true });
		node().click();
		node().focus();
		await userEvent.keyboard('{Enter}');
		await userEvent.keyboard(' ');
		const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		node().dispatchEvent(enter);
	}
	/** Throws a lever without the pointer (the lever's open reason tooltip may cover others). */
	const throwLever = (name: string) =>
		(page.getByRole('checkbox', { name, exact: true }).element() as HTMLElement).click();

	// No lever thrown: locked by the levers, focusable, and it says why.
	await expect.element(lever).toHaveAttribute('aria-disabled', 'true');
	await expect.element(lever).toHaveAccessibleDescription(m.cable_fux_lock_levers());
	await tryEverything();
	expect(document.activeElement).toBe(node());

	// One lever thrown: still locked.
	throwLever(m.cable_confirm_volume());
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_volume(), exact: true }))
		.toBeChecked();
	await expect.element(lever).toHaveAttribute('aria-disabled', 'true');
	await tryEverything();

	// Both levers, but the experimental confirmation is missing: still locked, its own reason.
	throwLever(m.cable_confirm_connection());
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_connection(), exact: true }))
		.toBeChecked();
	await expect.element(lever).toHaveAttribute('aria-disabled', 'true');
	await expect.element(lever).toHaveAccessibleDescription(m.cable_fux_lock_experimental());
	await tryEverything();

	// Give any queued async write a chance to surface before asserting it never came.
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(write).not.toHaveBeenCalled();
	expect(fake.createGesture).not.toHaveBeenCalled();
});

test('the experimental lever appears only when required and is bound to its own confirmation', async () => {
	const fake = connected();
	const checklist = vi.spyOn(fake.service, 'checklist');
	const shelf: Band = { kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 };
	await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		bands: [shelf, ...NEUTRO.bands.slice(1)],
		preampDb: -1,
		experimental: true,
		onclose: vi.fn()
	});
	const lever = page.getByRole('button', { name: m.cable_write_simulated(), exact: true });
	await page.getByRole('checkbox', { name: m.cable_confirm_volume(), exact: true }).click();
	await page.getByRole('checkbox', { name: m.cable_confirm_connection(), exact: true }).click();
	await expect.element(lever).toHaveAccessibleDescription(m.cable_fux_lock_experimental());
	const extra = page.getByRole('checkbox', { name: m.cable_confirm_experimental(), exact: true });
	await extra.click();
	await expect
		.poll(() => checklist.mock.calls.at(-1)?.[0].confirmations)
		.toEqual({ volumeLowered: true, keepConnected: true, experimental: true, yoloWrite: false });
	await expect.element(lever).not.toHaveAttribute('aria-disabled');
});

test('a filter above 20 kHz asks for the experimental lever and says why', async () => {
	const fake = connected();
	// A PK cut at 25 kHz: no experimental kind, so the gate's own flag stays off.
	const ultra: Band = { kind: 'PK', freqHz: 25000, gainDb: -3, qFactor: 1 };
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		bands: [ultra, ...NEUTRO.bands.slice(1)],
		preampDb: -1,
		experimental: false,
		onclose: vi.fn()
	});
	const lever = page.getByRole('button', { name: m.cable_write_simulated(), exact: true });
	await page.getByRole('checkbox', { name: m.cable_confirm_volume(), exact: true }).click();
	await page.getByRole('checkbox', { name: m.cable_confirm_connection(), exact: true }).click();
	await expect.element(lever).toHaveAccessibleDescription(m.cable_fux_lock_experimental());
	await expect.element(page.getByText(m.cable_experimental_ultra())).toBeVisible();
	await page.getByRole('checkbox', { name: m.cable_confirm_experimental(), exact: true }).click();
	await expect.element(lever).not.toHaveAttribute('aria-disabled');
	// 20 kHz itself is audible: no lever, no note.
	const audible: Band = { kind: 'PK', freqHz: 20000, gainDb: -3, qFactor: 1 };
	await screen.rerender({ bands: [audible, ...NEUTRO.bands.slice(1)] });
	await expect
		.element(page.getByRole('checkbox', { name: m.cable_confirm_experimental(), exact: true }))
		.not.toBeInTheDocument();
	expect(screen.container.querySelector('[data-testid="ultra-experimental"]')).toBeNull();
});

test('the literal warning is always visible; its lamp and the salto follow the policy', async () => {
	const fake = connected();
	const original = fake.service.checklist;
	let loudness: Pick<ChecklistResult['loudness'], 'warn' | 'reasons' | 'deltaDb'> = {
		warn: false,
		reasons: [],
		deltaDb: 1.2
	};
	fake.service.checklist = vi.fn<typeof fake.service.checklist>((request, gate) => {
		const result = original(request, gate);
		return { ...result, loudness: { ...result.loudness, ...loudness } };
	});
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose: vi.fn()
	});
	const panel = () => screen.container.querySelector('[data-loudness]');
	const jump = () => screen.container.querySelector('[data-jump]');
	const lamp = () => panel()?.querySelector('.lamp')?.getAttribute('data-on');

	await expect.element(page.getByText(LOUDNESS_LITERAL, { exact: true })).toBeVisible();
	expect(panel()?.getAttribute('data-loudness')).toBe('calm');
	expect(lamp()).toBe('false');
	expect(jump()?.textContent?.trim()).toBe('+1,2 dB');
	expect(jump()?.getAttribute('data-jump')).toBe('under');
	await expect.element(page.getByText(m.cable_fux_level_jump(), { exact: true })).toBeVisible();

	loudness = { warn: true, reasons: ['jump'], deltaDb: 3.2 };
	fake.publish({});
	await expect.poll(() => panel()?.getAttribute('data-loudness')).toBe('warn');
	expect(lamp()).toBe('true');
	expect(jump()?.textContent?.trim()).toBe('+3,2 dB');
	expect(jump()?.getAttribute('data-jump')).toBe('over');
	await expect
		.element(page.getByText(m.cable_loudness_jump({ delta: '+3,2' }), { exact: true }))
		.toBeVisible();
	expect(page.getByText(LOUDNESS_LITERAL, { exact: true }).elements()).toHaveLength(1);

	loudness = { warn: true, reasons: ['unknown-state'], deltaDb: null };
	fake.publish({});
	await expect.poll(() => jump()?.textContent?.trim()).toBe(m.cable_fux_level_unknown());
	expect(jump()?.getAttribute('data-jump')).toBe('unknown');
	const unknown = page.getByText(m.cable_loudness_unknown(), { exact: true });
	await expect.element(unknown).toBeVisible();
	await expect.element(page.getByText(LOUDNESS_LITERAL, { exact: true })).toBeVisible();
});

test('criteria (a) to (g) show values from the same verdict, with lamps and the predicted level', async () => {
	const fake = connected();
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose: vi.fn()
	});
	const dialog = page.getByRole('dialog');
	await expect.element(dialog).toBeVisible();
	const criteria = screen.container.querySelectorAll('[data-lamp]');
	expect([...criteria].map((node) => node.getAttribute('data-lamp'))).toEqual([
		'a',
		'b',
		'c',
		'd',
		'e',
		'f',
		'g',
		'k'
	]);
	expect([...criteria].every((node) => node.getAttribute('data-state') === 'ok')).toBe(true);
	expect(screen.container.querySelector('[data-lamp="f"]')?.textContent).toContain('CRC 0x4FFF');
	expect(screen.container.querySelector('[data-lamp="g"]')?.textContent).toContain('−0,5 dB');
	for (const id of ['a', 'b', 'c', 'd', 'e']) {
		expect(screen.container.querySelector(`[data-lamp="${id}"] .value`), id).not.toBeNull();
	}
	await expect.element(page.getByText(m.cable_fux_vu_data(), { exact: true })).toBeVisible();
	// Explainers for the checklist, the CRC, the gate, Q27/Q23 and the flash counters.
	expect(screen.container.querySelectorAll('dialog button.trigger')).toHaveLength(6);
});
