import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import UpdatePrompt from '#lib/pwa/UpdatePrompt.svelte';
import { registerPwa, type PwaController, type RegisterOptions } from '#lib/pwa/register.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

// The controller boundary is faked so tests never register a worker or reload/navigate the page.
vi.mock(import('#lib/pwa/register.ts'), () => ({ registerPwa: vi.fn() }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function controller(): PwaController {
	return { applyUpdate: vi.fn(() => true), dispose: vi.fn() };
}

function online(value: boolean) {
	vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(value);
	window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	vi.mocked(registerPwa).mockReset();
	vi.mocked(registerPwa).mockResolvedValue(controller());
	online(true);
});

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

test('disabled registration still reports connectivity and removes both window listeners', async () => {
	online(false);
	const remove = vi.spyOn(window, 'removeEventListener');
	await render(UpdatePrompt, { enabled: false });
	await expect
		.element(page.getByTestId('pwa-offline-notice'))
		.toHaveTextContent(m.pwa_offline_notice());
	expect(registerPwa).not.toHaveBeenCalled();
	online(true);
	await tick();
	expect(page.getByRole('complementary').elements()).toHaveLength(0);
	online(false);
	await expect.element(page.getByTestId('pwa-offline-notice')).toBeVisible();
	await cleanup();
	expect(remove).toHaveBeenCalledWith('online', expect.any(Function));
	expect(remove).toHaveBeenCalledWith('offline', expect.any(Function));
});

test('update notices announce blocked/applying states and only apply on an explicit click', async () => {
	const registered = controller();
	let options: RegisterOptions | undefined;
	vi.mocked(registerPwa).mockImplementation(async (next) => {
		options = next;
		return registered;
	});
	await render(UpdatePrompt, { workerUrl: '/custom-worker.js', scope: '/studio/' });
	await tick();
	expect(registerPwa).toHaveBeenCalledWith({
		workerUrl: '/custom-worker.js',
		scope: '/studio/',
		onState: expect.any(Function)
	});
	expect(page.getByRole('complementary').elements()).toHaveLength(0);
	options?.onState?.({ waiting: true, applying: false, blocked: false });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.pwa_update_available());
	expect(registered.applyUpdate).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.pwa_update_action() }).click();
	expect(registered.applyUpdate).toHaveBeenCalledExactlyOnceWith();
	options?.onState?.({ waiting: true, applying: false, blocked: true });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.pwa_update_write_blocked());
	options?.onState?.({ waiting: true, applying: true, blocked: false });
	await expect.element(page.getByRole('button', { name: m.pwa_update_applying() })).toBeDisabled();
	options?.onState?.({ waiting: false, applying: false, blocked: false });
	await tick();
	expect(page.getByTestId('pwa-update-prompt').elements()).toHaveLength(0);
	await cleanup();
	expect(registered.dispose).toHaveBeenCalledOnce();
});

test('a pending registration can show an update before the controller arrives, then disposes a late controller', async () => {
	const pending = deferred<PwaController>();
	vi.mocked(registerPwa).mockImplementation((options) => {
		options?.onState?.({ waiting: true, applying: false, blocked: false });
		return pending.promise;
	});
	await render(UpdatePrompt);
	await page.getByRole('button', { name: m.pwa_update_action() }).click();
	expect(registerPwa).toHaveBeenCalledWith(
		expect.objectContaining({ workerUrl: '/service-worker.js', scope: '/' })
	);
	await cleanup();
	const late = controller();
	pending.resolve(late);
	await tick();
	expect(late.dispose).toHaveBeenCalledOnce();
	expect(late.applyUpdate).not.toHaveBeenCalled();
});

test('registration failures are announced and can coexist with the offline notice', async () => {
	const failure = new Error('Registration denied');
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.mocked(registerPwa).mockRejectedValue(failure);
	await render(UpdatePrompt);
	await expect.element(page.getByText(m.pwa_registration_error())).toBeVisible();
	expect(warn).toHaveBeenCalledWith('PWA registration failed', failure);
	online(false);
	await expect.element(page.getByTestId('pwa-offline-notice')).toBeVisible();
	await expect.element(page.getByText(m.pwa_registration_error())).toBeVisible();
});

test('registration rejection after unmount does not resurrect the notice', async () => {
	const pending = deferred<PwaController>();
	vi.mocked(registerPwa).mockReturnValue(pending.promise);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await render(UpdatePrompt);
	await cleanup();
	pending.reject(new Error('Late failure'));
	await tick();
	await tick();
	expect(page.getByText(m.pwa_registration_error()).elements()).toHaveLength(0);
});
