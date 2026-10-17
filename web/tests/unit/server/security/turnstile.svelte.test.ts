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
import TurnstileFormFixture from './TurnstileFormFixture.svelte';

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

test('shows the 65 px "Preparando verificação…" box until the widget renders, without an error', async () => {
	const fake = installFake();
	// render() not giving an id yet: the widget is not on the page.
	fake.render = (_container, options) => {
		fake.options = options;
		return null;
	};
	const screen = await render(Turnstile, { siteKey: 'k', action: 'sign-in' });
	await rendered(fake);
	// Visible text, and the same words for screen readers inside the busy skeleton.
	expect(screen.container.querySelector('.preparing')?.textContent).toBe('Preparando verificação…');
	expect(screen.container.querySelector('.skeleton-box .sr-only')?.textContent).toBe(
		'Preparando verificação…'
	);
	const box = screen.container.querySelector<HTMLElement>('.placeholder');
	expect(box?.getBoundingClientRect().height).toBe(65);
	expect(box?.querySelector('[aria-busy="true"]')).not.toBeNull();
	expect(page.getByRole('alert').elements()).toHaveLength(0);
});

test('the placeholder steps aside once the widget is rendered', async () => {
	const fake = installFake();
	const screen = await render(Turnstile, { siteKey: 'k', action: 'sign-in' });
	await rendered(fake);
	await expect.poll(() => screen.container.querySelector('.placeholder')).toBeNull();
	expect(page.getByText('Preparando verificação…').elements()).toHaveLength(0);
});

test('inside a form, a failure waits for the user to act before it is announced', async () => {
	const fake = installFake();
	const screen = await render(TurnstileFormFixture);
	const options = await rendered(fake);
	// Bounded resets run out with nobody having touched the form: no alert yet.
	for (let index = 0; index < 3; index += 1) options['error-callback']?.('110200');
	await tick();
	expect(fake.resets).toBe(2);
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	// The token stays empty all along (nothing to submit as solved).
	expect(
		screen.container.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value
	).toBe('');
	// The first action on the form (focus) brings the error.
	await page.getByLabelText('E-mail', { exact: true }).click();
	await expect
		.element(page.getByRole('alert'))
		.toHaveTextContent(
			'Não foi possível carregar a verificação de segurança. Recarregue a página e tente de novo.'
		);
});

test('inside a form, a load failure keeps a still box and no text until the user acts', async () => {
	const fake = installFake();
	fake.render = () => {
		throw new Error('render failed');
	};
	const screen = await render(TurnstileFormFixture);
	// render() throwing rejects the load chain: failed, not announced, no "preparing" text.
	await expect
		.poll(() => screen.container.querySelector('.placeholder')?.getAttribute('data-state'))
		.toBe('stalled');
	expect(screen.container.querySelector('.preparing')).toBeNull();
	expect(page.getByRole('alert').elements()).toHaveLength(0);
	await page.getByLabelText('E-mail', { exact: true }).fill('ana@example.com');
	await expect.element(page.getByRole('alert')).toBeVisible();
	expect(screen.container.querySelector('.placeholder')).toBeNull();
});

test('removes the widget on unmount', async () => {
	const fake = installFake();
	const screen = await render(Turnstile, { siteKey: 'k', action: 'change-email' });
	await rendered(fake);
	await screen.unmount();
	expect(fake.removed).toEqual(['widget-1']);
});
