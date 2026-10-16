import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
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

test('queue requires two connected and selected cables, a passing checklist and no active write', async () => {
	const fake = cableUi();
	const screen = await render(MultiCableQueue, { ...input, service: fake.service });
	await expect.element(page.getByText(m.cable_queue_need_two())).toBeVisible();
	expect(page.getByRole('checkbox').elements()).toHaveLength(0);
	const devices = [new FakeHIDDevice(), new FakeHIDDevice()];
	fake.publish({ devices, deviceLabels: ['One', 'Two'] });
	const review = page.getByRole('button', { name: m.cable_queue_review() });
	await expect.element(review).toBeEnabled();
	await screen.rerender({ canWrite: false });
	await expect.element(review).toBeDisabled();
	await screen.rerender({ canWrite: true });
	fake.publish({ writing: true });
	await expect.element(review).toBeDisabled();
	await expect.element(page.getByRole('checkbox', { name: 'One' })).toBeDisabled();
	fake.publish({ writing: false });
	await page.getByRole('checkbox', { name: 'Two' }).click();
	await expect.element(review).toBeDisabled();
	await page.getByRole('checkbox', { name: 'Two' }).click();
	await expect.element(review).toBeEnabled();
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
	await expect.element(confirm).toBeDisabled();
	await screen.rerender({ canWrite: true });
	fake.publish({ writing: true });
	await expect.element(confirm).toBeDisabled();
	await expect.element(page.getByRole('button', { name: m.cable_queue_back() })).toBeDisabled();
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
