import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent, type Locator } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { FakeHIDDevice } from 'open-auri/transport';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import MultiCableQueue from '#lib/components/cable/MultiCableQueue.svelte';
import { describeOutcome, queueStatus } from '#lib/components/cable/i18n.ts';
import type { QueueOutcome } from '#lib/cable/types.ts';
import { cableUi } from './ui-fake.ts';

const input = {
	bands: [{ kind: 'OFF' as const }],
	preampDb: -0.5,
	experimental: false,
	confirmations: { volumeLowered: true, keepConnected: true, experimental: false },
	canWrite: true
};

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
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

test('queue requires two connected and selected cables, a passing checklist and no active write', async () => {
	const fake = cableUi();
	const screen = await render(MultiCableQueue, { ...input, service: fake.service });
	await expect.element(page.getByText(m.cable_queue_need_two())).toBeVisible();
	expect(page.getByRole('checkbox').elements()).toHaveLength(0);
	const devices = [new FakeHIDDevice(), new FakeHIDDevice()];
	fake.publish({ devices, deviceLabels: ['One', 'Two'] });
	const review = page.getByRole('button', { name: m.cable_queue_review() });
	await expect.element(review).not.toHaveAttribute('aria-disabled');
	await screen.rerender({ canWrite: false });
	await expectRefused(review, m.cable_write_blocked());
	await screen.rerender({ canWrite: true });
	fake.publish({ writing: true });
	await expectRefused(review, m.cabo_fux_busy_writing());
	await expect.element(page.getByRole('checkbox', { name: 'One' })).toBeDisabled();
	fake.publish({ writing: false });
	await page.getByRole('checkbox', { name: 'Two' }).click();
	await expectRefused(review, m.fuxq1_queue_select_two());
	// None of the refused presses opened the review.
	expect(
		page.getByRole('heading', { name: m.cable_queue_confirm_heading() }).elements()
	).toHaveLength(0);
	await page.getByRole('checkbox', { name: 'Two' }).click();
	await expect.element(review).not.toHaveAttribute('aria-disabled');
	expect(fake.createGesture).not.toHaveBeenCalled();
	expect(fake.writeQueue).not.toHaveBeenCalled();
});

test('review/back preserves selection; only confirmation submits the reviewed queue and fresh gesture', async () => {
	const devices = [new FakeHIDDevice(), new FakeHIDDevice(), new FakeHIDDevice()];
	const fake = cableUi({ devices, deviceLabels: ['One', 'Two', 'Three'] });
	const outcome: QueueOutcome = {
		status: 'done',
		simulated: true,
		items: [
			{ deviceLabel: 'One', status: 'simulated', entry: null },
			{ deviceLabel: 'Three', status: 'simulated', entry: null }
		]
	};
	fake.writeQueue.mockResolvedValue(outcome);
	const onresult = vi.fn();
	const screen = await render(MultiCableQueue, {
		...input,
		service: fake.service,
		name: 'Reviewed curve',
		onresult
	});
	await page.getByRole('checkbox', { name: 'Two' }).click();
	await page.getByRole('button', { name: m.cable_queue_review() }).click();
	expect(
		page
			.getByRole('listitem')
			.elements()
			.map((item) => item.textContent)
	).toEqual(['One', 'Three']);
	expect(fake.writeQueue).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.cable_queue_back() }).click();
	await expect.element(page.getByRole('checkbox', { name: 'Two' })).not.toBeChecked();
	await page.getByRole('button', { name: m.cable_queue_review() }).click();
	const confirm = page.getByRole('button', { name: m.cable_queue_confirm({ count: '2' }) });
	await screen.rerender({ canWrite: false });
	await expectRefused(confirm, m.cable_write_blocked());
	await screen.rerender({ canWrite: true });
	fake.publish({ writing: true });
	await expectRefused(confirm, m.cabo_fux_busy_writing());
	await expect.element(page.getByRole('button', { name: m.cable_queue_back() })).toBeDisabled();
	// The write path never moved: no gesture, no queue write, still in review.
	expect(fake.createGesture).not.toHaveBeenCalled();
	expect(fake.writeQueue).not.toHaveBeenCalled();
	await expect.element(confirm).toBeVisible();
	fake.publish({ writing: false });
	await confirm.click();
	expect(fake.createGesture).toHaveBeenCalledOnce();
	expect(fake.createGesture.mock.calls[0][0]).toBeInstanceOf(MouseEvent);
	expect(fake.writeQueue).toHaveBeenCalledExactlyOnceWith({
		devices: [devices[0], devices[2]],
		bands: input.bands,
		preampDb: input.preampDb,
		experimental: false,
		confirmations: input.confirmations,
		gesture: { kind: 'cable-gesture' },
		name: 'Reviewed curve'
	});
	expect(fake.writeQueue.mock.calls[0][0].confirmations).not.toBe(input.confirmations);
	expect(onresult).toHaveBeenCalledExactlyOnceWith(outcome);
	await expect.element(page.getByRole('status')).toHaveTextContent(describeOutcome(outcome));
	await expect.element(page.getByRole('button', { name: m.cable_queue_review() })).toBeVisible();
});

test('the reviewed queue is frozen: a cable plugged or unplugged during review requires a new review', async () => {
	const devices = [new FakeHIDDevice(), new FakeHIDDevice()];
	const fake = cableUi({ devices, deviceLabels: ['One', 'Two'] });
	await render(MultiCableQueue, { ...input, service: fake.service });
	await page.getByRole('button', { name: m.cable_queue_review() }).click();
	const confirmTwo = page.getByRole('button', { name: m.cable_queue_confirm({ count: '2' }) });
	await expect.element(confirmTwo).toBeVisible();
	// A cable reconnects while the user reviews: it never joins the reviewed queue silently.
	const late = new FakeHIDDevice();
	fake.publish({ devices: [...devices, late], deviceLabels: ['One', 'Two', 'Three'] });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_queue_changed());
	expect(confirmTwo.elements()).toHaveLength(0);
	await expect.element(page.getByRole('checkbox', { name: 'Three' })).toBeChecked();
	expect(fake.writeQueue).not.toHaveBeenCalled();
	expect(fake.createGesture).not.toHaveBeenCalled();
	// Reviewed again, the list shown is exactly the list sent.
	await page.getByRole('button', { name: m.cable_queue_review() }).click();
	expect(
		page
			.getByRole('listitem')
			.elements()
			.map((item) => item.textContent)
	).toEqual(['One', 'Two', 'Three']);
	// Unplugging one also drops back out of review.
	fake.publish({ devices: [devices[0], late], deviceLabels: ['One', 'Three'] });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_queue_changed());
	await page.getByRole('button', { name: m.cable_queue_review() }).click();
	await page.getByRole('button', { name: m.cable_queue_confirm({ count: '2' }) }).click();
	expect(fake.writeQueue).toHaveBeenCalledOnce();
	expect(fake.writeQueue.mock.calls[0][0].devices).toEqual([devices[0], late]);
});

test('a refused queue has feedback without a result callback; missing labels do not break review', async () => {
	const fake = cableUi({
		devices: [new FakeHIDDevice(), new FakeHIDDevice()],
		deviceLabels: ['One']
	});
	fake.writeQueue.mockResolvedValue({ status: 'refused', reason: 'gesture' });
	await render(MultiCableQueue, { ...input, service: fake.service });
	await page.getByRole('button', { name: m.cable_queue_review() }).click();
	expect(
		page
			.getByRole('listitem')
			.elements()
			.map((item) => item.textContent)
	).toEqual(['One', '']);
	await page.getByRole('button', { name: m.cable_queue_confirm({ count: '2' }) }).click();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_refused_gesture());
	expect(fake.writeQueue.mock.calls[0][0].name).toBe('');
});

test('renders every queue progress state and permits clearing only a finished summary', async () => {
	const statuses = Object.keys(queueStatus) as (keyof typeof queueStatus)[];
	const items = statuses.map((status) => ({ deviceLabel: `Cable ${status}`, status, entry: null }));
	const fake = cableUi({ queue: { running: true, items } });
	const screen = await render(MultiCableQueue, { ...input, service: fake.service });
	for (const status of statuses) {
		expect(screen.container.querySelector(`[data-status="${status}"]`)?.textContent).toContain(
			queueStatus[status]()
		);
	}
	expect(page.getByRole('button', { name: m.cable_queue_clear() }).elements()).toHaveLength(0);
	fake.publish({ queue: { running: false, items } });
	await page.getByRole('button', { name: m.cable_queue_clear() }).click();
	expect(fake.clearQueue).toHaveBeenCalledOnce();
	await tick();
	expect(screen.container.querySelector('[aria-live]')).toBeNull();
	await cleanup();
	expect(fake.unsubscribe).toHaveBeenCalledOnce();
});
