import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
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
import { writtenOutcome } from './outcomes.ts';

const PT = 'Entendo que a gravação pelo app Android ainda não foi testada num cabo real.';
const EN =
	'I understand that writing from the Android app has not been tested on a real cable yet.';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
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
	// Exercise the actual checklist model with a controlled app/validation context. NativeHID
	// and the service's own context/capture are covered by checklist-android.test.ts.
	fake.service.checklist = vi.fn<typeof fake.service.checklist>((input, gate) =>
		evaluateChecklist(
			input,
			{
				cableMode: 'native',
				androidWriteValidated: false,
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

test.each([
	['pt-BR', PT],
	['en-US', EN]
] as const)(
	'%s: the exact Android lever gates writes and resets on reopening and success',
	async (locale, label) => {
		await setLocale(locale, { reload: false });
		const fake = connected();
		const write = vi.fn<typeof fake.service.write>().mockResolvedValue(writtenOutcome('ok'));
		fake.service.write = write;
		const screen = await render(PreWriteChecklist, {
			service: fake.service,
			open: true,
			...NEUTRO,
			onclose: vi.fn()
		});
		const android = page.getByRole('checkbox', { name: label, exact: true });
		const button = page.getByRole('button', { name: m.cable_write(), exact: true });
		await expect.element(android).not.toBeChecked();
		await confirmNormal();
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
		await expect.element(button).toHaveAccessibleDescription(m.cable_lock_android_untested());
		await userEvent.click(button.element(), { force: true });
		expect(write).not.toHaveBeenCalled();
		expect(fake.createGesture).not.toHaveBeenCalled();
		await android.click();
		await expect.element(button).not.toHaveAttribute('aria-disabled');

		await screen.rerender({ open: false });
		await screen.rerender({ open: true });
		await expect.element(android).not.toBeChecked();
		await confirmNormal();
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
		await android.click();
		await button.click();
		await expect.poll(() => write.mock.calls.length).toBe(1);
		expect(write.mock.calls[0][0].confirmations).toMatchObject({ androidUntested: true });
		expect(fake.createGesture).toHaveBeenCalledOnce();
		await expect.element(android).not.toBeChecked();
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	}
);

test.each([
	{ cableMode: 'native', androidWriteValidated: true },
	{ cableMode: 'real', androidWriteValidated: false },
	{ cableMode: 'simulated', androidWriteValidated: false }
] as const)(
	'$cableMode validated=$androidWriteValidated: no extra visible lever or write gate',
	async (context) => {
		const fake = connected(context);
		const screen = await render(PreWriteChecklist, {
			service: fake.service,
			open: true,
			...NEUTRO,
			onclose: vi.fn()
		});
		expect(page.getByRole('checkbox', { name: PT, exact: true }).elements()).toHaveLength(0);
		expect(screen.container.querySelectorAll('[data-confirmation]')).toHaveLength(2);
		await confirmNormal();
		const button = page.getByRole('button', {
			name: context.cableMode === 'simulated' ? m.cable_write_simulated() : m.cable_write(),
			exact: true
		});
		await expect.element(button).not.toHaveAttribute('aria-disabled');
	}
);

test('Android, experimental and YOLO levers combine without replacing each other', async () => {
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
	const android = page.getByRole('checkbox', { name: PT, exact: true });
	expect(screen.container.querySelectorAll('[data-confirmation]')).toHaveLength(5);
	await confirmNormal();
	await android.click();
	await expect.element(button).toHaveAccessibleDescription(m.cable_fux_lock_experimental());
	await page.getByRole('checkbox', { name: m.cable_confirm_experimental(), exact: true }).click();
	await expect.element(button).toHaveAccessibleDescription(m.yolo_lock_write());
	const yolo = screen.container.querySelector<HTMLInputElement>('[data-confirmation="yolo"] input');
	if (yolo === null) throw new Error('Missing YOLO lever');
	yolo.click();
	await expect.element(button).not.toHaveAttribute('aria-disabled');
	await android.click();
	await expect.element(button).toHaveAccessibleDescription(m.cable_lock_android_untested());
});

test('one Android confirmation gates the whole queue, is rechecked during review and resets afterwards', async () => {
	const fake = connected({}, 2);
	const screen = await render(PreWriteChecklist, {
		service: fake.service,
		open: true,
		...NEUTRO,
		onclose: vi.fn()
	});
	const android = page.getByRole('checkbox', { name: PT, exact: true });
	const review = page.getByRole('button', { name: m.cable_queue_review(), exact: true });
	await confirmNormal();
	await expect.element(review).toHaveAttribute('aria-disabled', 'true');
	expect(screen.container.querySelectorAll('[data-confirmation="android-untested"]')).toHaveLength(
		1
	);
	await android.click();
	await review.click();
	const confirm = page.getByRole('button', {
		name: m.cable_queue_confirm({ count: '2' }),
		exact: true
	});
	await expect.element(confirm).not.toHaveAttribute('aria-disabled');
	await android.click();
	await expect.element(confirm).toHaveAttribute('aria-disabled', 'true');
	await userEvent.click(confirm.element(), { force: true });
	expect(fake.writeQueue).not.toHaveBeenCalled();
	await android.click();
	await confirm.click();
	await expect.poll(() => fake.writeQueue.mock.calls.length).toBe(1);
	expect(fake.writeQueue.mock.calls[0][0]).toMatchObject({
		devices: fake.service.getState().devices,
		confirmations: { androidUntested: true }
	});
	await expect.element(android).not.toBeChecked();
});

test.each([
	{
		locale: 'pt-BR',
		reason: 'newer',
		message: 'Há uma versão nova do site. Recarregue a página antes de gravar pelo app.'
	},
	{
		locale: 'en-US',
		reason: 'newer',
		message:
			'A newer version of the site is available. Reload the page before writing from the app.'
	},
	{
		locale: 'pt-BR',
		reason: 'unavailable',
		message:
			'A gravação pelo app precisa de uma conexão para confirmar a política de gravação atual. Conecte-se à internet e tente de novo.'
	},
	{
		locale: 'en-US',
		reason: 'unavailable',
		message:
			'Writing from the app needs a connection to confirm the current write policy. Connect to the internet and try again.'
	}
] as const)(
	'$locale: a $reason policy check displays the actionable refusal',
	async ({ locale, reason, message }) => {
		await setLocale(locale, { reload: false });
		const fake = connected({ androidWriteValidated: true });
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
