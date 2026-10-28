// FUX.P6 Cabo: the state diagram follows the service, the reels follow real report progress,
// the empty journal teaches with EXAMPLE boxes and U7 lists the cables with their state.
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { FakeHIDDevice } from 'open-auri/transport';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import type { CableState, JournalEntry, Written } from '#lib/cable/types.ts';
import { formatCrc } from '#lib/components/cable/i18n.ts';
import CaboPage from '#lib/components/pages/cabo/CaboPage.svelte';
import CableList from '#lib/components/pages/cabo/CableList.svelte';
import Journal from '#lib/components/pages/cabo/Journal.svelte';
import TransportTape from '#lib/components/pages/cabo/TransportTape.svelte';
import { exampleBoxes } from '#lib/components/pages/cabo/model.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

let app: ClientApp | null = null;
afterEach(async () => {
	await cleanup();
	app?.dispose();
	app = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

/** Manual clock + frame queue: nothing moves unless the test steps it. */
function manualFrames() {
	let time = 1000;
	let nextHandle = 0;
	const queue = new Map<number, FrameRequestCallback>();
	return {
		now: () => time,
		frame: (callback: FrameRequestCallback) => {
			nextHandle += 1;
			queue.set(nextHandle, callback);
			return nextHandle;
		},
		cancel: (handle: number) => {
			queue.delete(handle);
		},
		get pending() {
			return queue.size;
		},
		step(ms: number) {
			time += ms;
			const callbacks = [...queue.values()];
			queue.clear();
			for (const callback of callbacks) callback(time);
		}
	};
}

function entry(status: JournalEntry['status']): JournalEntry {
	return {
		schema: 1,
		at: 1000,
		name: 'Sent neutral',
		bands: NEUTRO.bands.map((band) => ({ ...band })),
		preampDb: NEUTRO.preampDb,
		crc: NEUTRO.crc,
		status,
		device: 'Test cable'
	};
}

function interrupted(reportsSent: number): Written {
	return {
		status: 'interrupted',
		simulated: false,
		entry: entry('interrupted'),
		result: {
			status: 'interrupted',
			startedAt: 100,
			finishedAt: 160,
			reportsSent,
			committed: false,
			crc: NEUTRO.crc
		},
		deviceLabel: 'Test cable',
		crc: NEUTRO.crc,
		levelDb: -0.5
	};
}

test('the U1 diagram lights the node of the real service state', async () => {
	await setLocale('pt-BR', { reload: false });
	app = createClientApp(fakeAppOptions().options);
	const screen = await render(CaboPage, { app, tourAutoOpen: false });
	const machine = page.getByRole('list', { name: m.cabo_state_machine(), exact: true });
	const current = () =>
		[...screen.container.querySelectorAll('[aria-current="step"]')].map((node) =>
			node.getAttribute('data-state')
		);
	await expect.element(machine).toBeVisible();
	expect(current()).toEqual(['disconnected']);
	await app.cable.connect();
	await expect.poll(current).toEqual(['connected']);
	await expect
		.element(machine.getByRole('listitem').filter({ hasText: m.cabo_state_connected() }))
		.toHaveAttribute('aria-current', 'step');
	// The page connects only through the service: no report was sent by connecting.
	expect(screen.container.querySelectorAll('[data-tour^="cabo-"]')).toHaveLength(5);
});

test('reels stay still without a rehearsal or a write and move only with real report progress', async () => {
	await setLocale('pt-BR', { reload: false });
	const clock = manualFrames();
	const screen = await render(TransportTape, {
		curve: NEUTRO,
		writing: true,
		progress: null,
		now: clock.now,
		frame: clock.frame,
		cancel: clock.cancel
	});
	const reel = () => screen.container.querySelector('.reel');
	const turns = () => reel()?.getAttribute('data-turns');
	const angle = () => reel()?.getAttribute('data-angle');
	// Writing, but the service reported no progress yet: nothing is invented.
	expect(turns()).toBe('0');
	expect(angle()).toBe('0');
	expect(clock.pending).toBe(0);
	await expect.element(page.getByRole('status')).toHaveAttribute('data-status', 'writing');

	await screen.rerender({ progress: { reportsSent: 3, committed: false } });
	await expect.poll(turns).toBe('3');
	expect(angle()).toBe('120');
	expect(screen.container.querySelectorAll('.seg.live')).toHaveLength(3);

	await screen.rerender({ progress: { reportsSent: 9, committed: true } });
	await expect.poll(turns).toBe('10');
	expect(angle()).toBe('400');
	expect(screen.container.querySelectorAll('.seg.live')).toHaveLength(9);

	// The write ended without a result: the tape forgets the progress and the reels do not
	// rewind (no motion that is not a report going through).
	await screen.rerender({ writing: false, progress: null });
	await expect.poll(turns).toBe('0');
	expect(angle()).toBe('400');
	expect(clock.pending).toBe(0);
});

test('a rehearsal turns the reels report by report on its own clock and never claims acceptance', async () => {
	await setLocale('pt-BR', { reload: false });
	const clock = manualFrames();
	const screen = await render(TransportTape, {
		curve: NEUTRO,
		now: clock.now,
		frame: clock.frame,
		cancel: clock.cancel
	});
	const turns = () => screen.container.querySelector('.reel')?.getAttribute('data-turns');
	expect(turns()).toBe('0');
	await page.getByRole('button', { name: m.cabo_rehearse(), exact: true }).click();
	expect(turns()).toBe('0');
	clock.step(20);
	await expect.poll(turns).toBe('2');
	clock.step(10_000);
	// Nine nominal reports; a rehearsal never lights the commit or an acceptance.
	await expect.poll(turns).toBe('9');
	expect(screen.container.querySelectorAll('.accepted')).toHaveLength(0);
	expect(screen.container.querySelectorAll('.seg.passed')).toHaveLength(9);
});

test('while the tape runs, the speed switch says why and a click or Enter never toggles it', async () => {
	await setLocale('pt-BR', { reload: false });
	const clock = manualFrames();
	await render(TransportTape, {
		curve: NEUTRO,
		now: clock.now,
		frame: clock.frame,
		cancel: clock.cancel
	});
	const slow = page.getByRole('checkbox', { name: m.cabo_slow(), exact: true });
	await expect.element(slow).not.toHaveAttribute('aria-disabled');
	await page.getByRole('button', { name: m.cabo_rehearse(), exact: true }).click();
	await expect.element(slow).toHaveAttribute('aria-disabled', 'true');
	await expect.element(slow).not.toHaveAttribute('disabled');
	await expect.element(slow).toHaveAccessibleDescription(m.fuxq1_tape_slow_running());
	const input = slow.element() as HTMLInputElement;
	input.click();
	input.focus();
	await userEvent.keyboard('{Enter}');
	expect(input.checked).toBe(false);
	await expect.element(slow).not.toBeChecked();

	clock.step(10_000);
	await expect.element(slow).not.toHaveAttribute('aria-disabled');
	await expect.element(slow).not.toHaveAttribute('aria-describedby');
	await slow.click();
	await expect.element(slow).toBeChecked();
});

test('the real result never lights a report the cable did not accept', async () => {
	await setLocale('pt-BR', { reload: false });
	const clock = manualFrames();
	const screen = await render(TransportTape, {
		curve: NEUTRO,
		outcome: interrupted(2),
		now: clock.now,
		frame: clock.frame,
		cancel: clock.cancel
	});
	clock.step(10_000);
	const turns = () => screen.container.querySelector('.reel')?.getAttribute('data-turns');
	await expect.poll(turns).toBe('2');
	expect(screen.container.querySelectorAll('.seg.accepted')).toHaveLength(2);
	expect(screen.container.querySelector('.commit.accepted')).toBeNull();
});

test('the empty journal teaches (spec §4.4) with three non-interactive EXAMPLE boxes', async () => {
	await setLocale('pt-BR', { reload: false });
	const screen = await render(Journal, { entries: [] });
	await expect.element(page.getByText(m.empty_journal_body(), { exact: true })).toBeVisible();
	await expect
		.element(page.getByRole('heading', { name: m.empty_journal_title(), exact: true }))
		.toBeVisible();
	const examples = page.getByRole('list', { name: m.cabo_fux_examples_label(), exact: true });
	await expect.element(examples).toBeVisible();
	expect(examples.getByRole('listitem').elements()).toHaveLength(3);
	expect(page.getByText(m.empty_example(), { exact: true }).elements()).toHaveLength(3);
	// Not entries: no status, nothing to press, nothing to load.
	const boxes = screen.container.querySelectorAll('[data-example]');
	expect(boxes).toHaveLength(3);
	for (const box of boxes) {
		expect(box.hasAttribute('data-status')).toBe(false);
		expect(box.querySelectorAll('button, a, input, select, [tabindex]')).toHaveLength(0);
	}
	for (const box of exampleBoxes()) {
		const crc = page.getByText(formatCrc(box.crc), { exact: true }).first();
		await expect.element(crc).toBeVisible();
	}
	const exported = page.getByRole('button', { name: m.cabo_export(), exact: true });
	await expect.element(exported).toHaveAttribute('aria-disabled', 'true');
	await expect.element(exported).toHaveAccessibleDescription(m.cabo_fux_export_empty());
});

test('U7 lists cables A, B and C with their real state; the list is read-only', async () => {
	await setLocale('pt-BR', { reload: false });
	const [one, two, three] = [new FakeHIDDevice(), new FakeHIDDevice(), new FakeHIDDevice()];
	const cable: CableState = {
		mode: 'simulated',
		connection: 'connected',
		device: one,
		deviceLabel: 'USB DSP Audio',
		devices: [one, two, three],
		deviceLabels: ['USB DSP Audio', 'USB DSP Audio #2', 'USB DSP Audio #3'],
		writing: true,
		rescue: null,
		queue: {
			running: true,
			items: [
				{ deviceLabel: 'USB DSP Audio', status: 'ok', entry: null },
				{ deviceLabel: 'USB DSP Audio #2', status: 'writing', entry: null }
			]
		},
		lastOutcome: null,
		error: null,
		liveCapable: true,
		live: null
	};
	const screen = await render(CableList, { cable });
	const list = page.getByRole('list', { name: m.cabo_fux_cables_label(), exact: true });
	expect(list.getByRole('listitem').elements()).toHaveLength(3);
	const row = (letter: string) => screen.container.querySelector(`[data-cable="${letter}"]`);
	expect(row('A')?.textContent).toContain(m.cabo_fux_cable_name({ letter: 'A' }));
	expect(row('A')?.textContent).toContain(m.cable_queue_status_ok());
	expect(row('A')?.textContent).toContain(m.cabo_fux_cable_target());
	expect(row('B')?.getAttribute('data-queue')).toBe('writing');
	expect(row('B')?.textContent).toContain(m.cable_queue_status_writing());
	expect(row('C')?.textContent).toContain(m.cabo_fux_cable_ready());
	expect(screen.container.querySelectorAll('button, input, select')).toHaveLength(0);
	await screen.rerender({ cable: null });
	const empty = page.getByText(m.cabo_fux_cables_empty(), { exact: true });
	await expect.element(empty).toBeVisible();
});
