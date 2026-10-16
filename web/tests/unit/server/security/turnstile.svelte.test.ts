// Component test of the Turnstile widget wrapper. A fake `window.turnstile` is installed first, so
// the component never injects the real api.js (no network in tests).
import { afterEach, beforeEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import Turnstile, {
	type TurnstileApi,
	type TurnstileRenderOptions
} from '#lib/components/security/Turnstile.svelte';

interface FakeTurnstile extends TurnstileApi {
	options: TurnstileRenderOptions | null;
	resets: number;
	removed: string[];
}

function installFake(): FakeTurnstile {
	const fake: FakeTurnstile = {
		options: null,
		resets: 0,
		removed: [],
		render(_container, options) {
			fake.options = options;
			return 'widget-1';
		},
		reset() {
			fake.resets += 1;
		},
		remove(id) {
			fake.removed.push(id ?? '');
		}
	};
	Object.assign(window, { turnstile: fake });
	return fake;
}

async function rendered(fake: FakeTurnstile): Promise<TurnstileRenderOptions> {
	await expect.poll(() => fake.options).not.toBeNull();
	return fake.options as TurnstileRenderOptions;
}

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	Reflect.deleteProperty(window, 'turnstile');
});

test('renders explicitly with site key and action, without loading api.js again', async () => {
	const fake = installFake();
	await render(Turnstile, { siteKey: '1x00000000000000000000AA', action: 'sign-in' });
	const options = await rendered(fake);
	expect(options).toMatchObject({
		sitekey: '1x00000000000000000000AA',
		action: 'sign-in',
		'response-field': false
	});
	expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
	await expect
		.element(page.getByRole('group', { name: 'Verificação de segurança' }))
		.toBeInTheDocument();
});

test('exposes the token in the hidden cf-turnstile-response field and clears it on expiry', async () => {
	const fake = installFake();
	const screen = await render(Turnstile, { siteKey: 'k', action: 'sign-up' });
	const options = await rendered(fake);
	const input = () =>
		screen.container.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');

	options.callback?.('token-123');
	await tick();
	expect(input()?.value).toBe('token-123');

	options['expired-callback']?.();
	await tick();
	expect(input()?.value).toBe('');
	expect(fake.resets).toBe(1);
});

test('resets on errors a bounded number of times, then shows an alert', async () => {
	const fake = installFake();
	const codes: string[] = [];
	await render(Turnstile, {
		siteKey: 'k',
		action: 'reset-password',
		label: 'Custom label',
		onerror: (code: string) => codes.push(code)
	});
	const options = await rendered(fake);
	for (let index = 0; index < 3; index += 1) options['error-callback']?.('110200');
	await tick();
	expect(fake.resets).toBe(2);
	expect(codes).toEqual(['110200', '110200', '110200']);
	await expect.element(page.getByRole('alert')).toBeVisible();
	await expect.element(page.getByRole('group', { name: 'Custom label' })).toBeInTheDocument();
});

test('removes the widget on unmount', async () => {
	const fake = installFake();
	const screen = await render(Turnstile, { siteKey: 'k', action: 'change-email' });
	await rendered(fake);
	await screen.unmount();
	expect(fake.removed).toEqual(['widget-1']);
});
