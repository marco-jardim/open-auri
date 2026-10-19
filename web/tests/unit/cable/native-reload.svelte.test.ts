import axe from 'axe-core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { updated } from '$app/state';
import { NEUTRO } from 'open-auri/catalog';
import { FakeHIDDevice } from 'open-auri/transport';
import { evaluateChecklist } from '#lib/cable/checklist.ts';
import { NativeFreshnessError } from '#lib/cable/native-freshness.ts';
import { withWriteFlag } from '#lib/cable/write-flag.ts';
import type { NativeCableStatus } from '#lib/app/context.svelte.ts';
import AndroidUpdateBanner from '#lib/components/cable/AndroidUpdateBanner.svelte';
import MultiCableQueue from '#lib/components/cable/MultiCableQueue.svelte';
import PreWriteChecklist from '#lib/components/cable/PreWriteChecklist.svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { cableUi } from './ui-fake.ts';

const kit = vi.hoisted(() => ({ newer: false }));
vi.mock('$app/state', async () => {
	const { SvelteMap } = await import('svelte/reactivity');
	const state = new SvelteMap([['current', false]]);
	return {
		updated: {
			get current() {
				return state.get('current') ?? false;
			},
			async check() {
				state.set('current', kit.newer);
				return kit.newer;
			}
		}
	};
});

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	kit.newer = false;
	await updated.check();
});

afterEach(async () => {
	await cleanup();
	window.__oaWriteInProgress = false;
	kit.newer = false;
	await updated.check();
	await setLocale('pt-BR', { reload: false });
	vi.restoreAllMocks();
});

type Surface = 'checklist' | 'queue';

async function refuse(surface: Surface, error: Error, reload: () => void) {
	const devices = [new FakeHIDDevice(), new FakeHIDDevice()];
	const fake = cableUi({
		mode: 'real',
		connection: 'connected',
		device: devices[0],
		devices: surface === 'queue' ? devices : devices.slice(0, 1),
		deviceLabel: 'One',
		deviceLabels: surface === 'queue' ? ['One', 'Two'] : ['One']
	});
	const outcome = { status: 'refused', reason: 'error', error } as const;
	if (surface === 'checklist') {
		fake.service.checklist = (input, gate) =>
			evaluateChecklist(
				input,
				{
					cableMode: 'native',
					androidWriteValidated: true,
					nowMs: 10_000,
					flash: { day: { date: null, count: 0 }, total: 0, lastWriteAt: 0, session: 0 },
					lastWrittenLevelDb: null,
					sessionWriteCount: 0,
					lastJournalStatus: null
				},
				gate
			);
		fake.service.write = vi.fn<typeof fake.service.write>().mockResolvedValue(outcome);
		await render(PreWriteChecklist, {
			service: fake.service,
			open: true,
			...NEUTRO,
			onclose: vi.fn(),
			reload
		});
		await page.getByRole('checkbox', { name: m.cable_confirm_volume(), exact: true }).click();
		await page.getByRole('checkbox', { name: m.cable_confirm_connection(), exact: true }).click();
		await page.getByRole('button', { name: m.cable_write(), exact: true }).click();
	} else {
		fake.writeQueue.mockResolvedValue(outcome);
		await render(MultiCableQueue, {
			service: fake.service,
			...NEUTRO,
			experimental: false,
			confirmations: { volumeLowered: true, keepConnected: true, experimental: false },
			canWrite: true,
			reload
		});
		await page.getByRole('button', { name: m.cable_queue_review(), exact: true }).click();
		await page
			.getByRole('button', { name: m.cable_queue_confirm({ count: '2' }), exact: true })
			.click();
	}
	return fake;
}

for (const surface of ['checklist', 'queue'] as const) {
	for (const locale of ['pt-BR', 'en-US'] as const) {
		test.each(['newer', 'unavailable'] as const)(
			`${surface}, ${locale}: %s refusal offers an explicit working reload`,
			async (reason) => {
				await setLocale(locale, { reload: false });
				const reload = vi.fn();
				await refuse(surface, new NativeFreshnessError(reason), reload);
				await expect
					.element(page.getByRole('status'))
					.toHaveTextContent(
						reason === 'newer' ? m.cable_native_reload_newer() : m.cable_native_reload_unavailable()
					);
				const button = page.getByRole('button', {
					name: locale === 'pt-BR' ? 'Recarregar' : 'Reload',
					exact: true
				});
				await expect.element(button).toBeVisible();
				expect(reload).not.toHaveBeenCalled();
				await button.click();
				expect(reload).toHaveBeenCalledOnce();
			}
		);
	}

	test(`${surface}: other errors never offer a reload`, async () => {
		const reload = vi.fn();
		await refuse(surface, new Error('USB failure'), reload);
		await expect.element(page.getByRole('status')).toHaveTextContent(m.cable_refused_error());
		expect(
			page.getByRole('button', { name: m.cable_native_reload(), exact: true }).elements()
		).toHaveLength(0);
		expect(reload).not.toHaveBeenCalled();
	});

	test(`${surface}: a new write hides reload and stale clicks recheck both write guards`, async () => {
		const reload = vi.fn();
		const fake = await refuse(surface, new NativeFreshnessError('newer'), reload);
		const button = page.getByRole('button', { name: m.cable_native_reload(), exact: true });
		await expect.element(button).toBeVisible();
		const staleButton = button.element();
		if (!(staleButton instanceof HTMLElement)) throw new Error('Missing reload button');
		fake.publish({ writing: true });
		staleButton.click();
		expect(reload).not.toHaveBeenCalled();
		await expect.element(button).not.toBeInTheDocument();
		fake.publish({ writing: false });
		await expect.element(button).toBeVisible();
		window.__oaWriteInProgress = true;
		await button.click();
		expect(reload).not.toHaveBeenCalled();
		window.__oaWriteInProgress = false;
		let finish: () => void = () => undefined;
		const writing = withWriteFlag(() => new Promise<void>((resolve) => (finish = resolve)));
		try {
			await expect.element(button).not.toBeInTheDocument();
			expect(reload).not.toHaveBeenCalled();
		} finally {
			finish();
			await writing;
		}
		await expect.element(button).toBeVisible();
		expect(reload).not.toHaveBeenCalled();
		await button.click();
		expect(reload).toHaveBeenCalledOnce();
	});
}

const appKinds: NativeCableStatus['kind'][] = [
	'native',
	'native-outdated',
	'native-write-disabled',
	'native-no-usb-host'
];

test.each(appKinds)(
	'%s: the banner reacts to Kit updated state without a waiting worker',
	async (kind) => {
		const reload = vi.fn();
		const screen = await render(AndroidUpdateBanner, { kind, reload });
		expect(page.getByRole('status').elements()).toHaveLength(0);
		kit.newer = true;
		await updated.check();
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent(m.cable_native_update_available());
		const { violations } = await axe.run(screen.container);
		expect(
			violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
		).toEqual([]);
		await page.getByRole('button', { name: m.cable_native_reload(), exact: true }).click();
		expect(reload).toHaveBeenCalledOnce();
	}
);

test('desktop never shows the banner or reload even when Kit reports an update', async () => {
	kit.newer = true;
	await updated.check();
	const screen = await render(AndroidUpdateBanner, { kind: 'none', reload: vi.fn() });
	expect(screen.container.querySelector('[data-testid="android-update-banner"]')).toBeNull();
	expect(page.getByRole('button').elements()).toHaveLength(0);
});

test('the app banner hides reload during writes and never reloads automatically afterwards', async () => {
	kit.newer = true;
	await updated.check();
	const reload = vi.fn();
	const screen = await render(AndroidUpdateBanner, { kind: 'native', reload });
	const button = page.getByRole('button', { name: m.cable_native_reload(), exact: true });
	await expect.element(button).toBeVisible();
	window.__oaWriteInProgress = true;
	await button.click();
	expect(reload).not.toHaveBeenCalled();
	window.__oaWriteInProgress = false;
	await screen.rerender({ writing: true });
	await expect.element(button).not.toBeInTheDocument();
	await screen.rerender({ writing: false });
	let finish: () => void = () => undefined;
	const writing = withWriteFlag(() => new Promise<void>((resolve) => (finish = resolve)));
	try {
		await expect.element(button).not.toBeInTheDocument();
		await expect.element(page.getByText(m.cabo_fux_busy_writing(), { exact: true })).toBeVisible();
	} finally {
		finish();
		await writing;
	}
	await expect.element(button).toBeVisible();
	expect(reload).not.toHaveBeenCalled();
	await button.click();
	expect(reload).toHaveBeenCalledOnce();
});
