import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { FakeHIDDevice } from 'open-auri/transport';
import { evaluateChecklist } from '#lib/cable/checklist.ts';
import { NativeFreshnessError } from '#lib/cable/native-freshness.ts';
import type { Band, ChecklistContext } from '#lib/cable/types.ts';
import PreWriteChecklist from '#lib/components/cable/PreWriteChecklist.svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { cableUi } from './ui-fake.ts';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	// The locale persists (cookie/localStorage) into later test files of the same browser.
	await setLocale('pt-BR', { reload: false });
	vi.restoreAllMocks();
});

function connected(context: Partial<ChecklistContext> = {}, count = 1) {
	const devices = Array.from({ length: count }, () => new FakeHIDDevice());
	const fake = cableUi({
		mode: context.cableMode === 'simulated' ? 'simulated' : 'real',
		connection: 'connected',
		device: devices[0],
		devices,
		deviceLabel: 'Cable 1',
		deviceLabels: devices.map((_, index) => `Cable ${index + 1}`)
	});
	// Exercise the actual checklist model with a controlled transport context. NativeHID and the
	// service's own context are covered by checklist-android.test.ts.
	fake.service.checklist = vi.fn<typeof fake.service.checklist>((input, gate) =>
		evaluateChecklist(
			input,
			{
				cableMode: 'native',
				nowMs: 10_000,
				flash: { day: { date: null, count: 0 }, total: 0, lastWriteAt: 0, session: 0 },
				lastWrittenLevelDb: null,
				sessionWriteCount: 0,
				lastJournalStatus: null,
				yoloSession: true,
				...context
			},
			gate
		)
	);
	return fake;
}

async function confirmNormal() {
	await page.getByRole('checkbox', { name: m.cable_confirm_volume(), exact: true }).click();
	await page.getByRole('checkbox', { name: m.cable_confirm_connection(), exact: true }).click();
}

test.each([{ cableMode: 'native' }, { cableMode: 'real' }, { cableMode: 'simulated' }] as const)(
	'$cableMode: no Android-only lever or write gate',
	async (context) => {
		const fake = connected(context);
		const screen = await render(PreWriteChecklist, {
			service: fake.service,
			open: true,
			...NEUTRO,
			onclose: vi.fn()
		});
		expect(screen.container.querySelectorAll('[data-confirmation]')).toHaveLength(2);
		await confirmNormal();
		const button = page.getByRole('button', {
			name: context.cableMode === 'simulated' ? m.cable_write_simulated() : m.cable_write(),
			exact: true
		});
		await expect.element(button).not.toHaveAttribute('aria-disabled');
	}
);

test('native experimental and YOLO levers are the only extra ones', async () => {
	const fake = connected();
	const bands: Band[] = [{ kind: 'HP', freqHz: 30, qFactor: 0.71 }, ...NEUTRO.bands.slice(1)];
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		bands,
		preampDb: -0.5,
		experimental: true,
		profile: 'yolo',
		onclose: vi.fn()
	});
	const button = page.getByRole('button', { name: m.cable_write(), exact: true });
	expect(screen.container.querySelectorAll('[data-confirmation]')).toHaveLength(4);
	await confirmNormal();
	await expect.element(button).toHaveAccessibleDescription(m.cable_fux_lock_experimental());
	await page.getByRole('checkbox', { name: m.cable_confirm_experimental(), exact: true }).click();
	await expect.element(button).toHaveAccessibleDescription(m.yolo_lock_write());
	const yolo = screen.container.querySelector<HTMLInputElement>('[data-confirmation="yolo"] input');
	if (yolo === null) throw new Error('Missing YOLO lever');
	yolo.click();
	await expect.element(button).not.toHaveAttribute('aria-disabled');
});

test('a native queue is reviewed and written with the normal levers only', async () => {
	const fake = connected({}, 2);
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose: vi.fn()
	});
	const review = page.getByRole('button', { name: m.cable_queue_review(), exact: true });
	expect(screen.container.querySelectorAll('[data-confirmation]')).toHaveLength(2);
	await confirmNormal();
	await review.click();
	const confirm = page.getByRole('button', {
		name: m.cable_queue_confirm({ count: '2' }),
		exact: true
	});
	await expect.element(confirm).not.toHaveAttribute('aria-disabled');
	await confirm.click();
	await expect.poll(() => fake.writeQueue.mock.calls.length).toBe(1);
	expect(fake.writeQueue.mock.calls[0][0]).toMatchObject({
		devices: fake.service.getState().devices,
		confirmations: { volumeLowered: true, keepConnected: true }
	});
	expect(Object.keys(fake.writeQueue.mock.calls[0][0].confirmations).sort()).toEqual([
		'experimental',
		'keepConnected',
		'volumeLowered',
		'yoloWrite'
	]);
});

test.each([
	{
		locale: 'pt-BR',
		reason: 'newer',
		message: 'Há uma versão nova do site. Use o botão Recarregar antes de gravar pelo app.'
	},
	{
		locale: 'en-US',
		reason: 'newer',
		message:
			'A newer version of the site is available. Use the Reload button before writing from the app.'
	},
	{
		locale: 'pt-BR',
		reason: 'unavailable',
		message:
			'Não foi possível confirmar a política de gravação atual. Conecte-se à internet e use o botão Recarregar antes de gravar pelo app.'
	},
	{
		locale: 'en-US',
		reason: 'unavailable',
		message:
			'The current write policy could not be confirmed. Connect to the internet and use the Reload button before writing from the app.'
	}
] as const)(
	'$locale: a $reason policy check displays the actionable refusal',
	async ({ locale, reason, message }) => {
		await setLocale(locale, { reload: false });
		const fake = connected();
		fake.service.write = vi.fn<typeof fake.service.write>().mockResolvedValue({
			status: 'refused',
			reason: 'error',
			error: new NativeFreshnessError(reason)
		});
		await render(PreWriteChecklist, {
			service: fake.service,
			open: true,
			...NEUTRO,
			onclose: vi.fn()
		});
		await confirmNormal();
		await page.getByRole('button', { name: m.cable_write(), exact: true }).click();
		await expect.element(page.getByText(message, { exact: true })).toBeVisible();
	}
);
