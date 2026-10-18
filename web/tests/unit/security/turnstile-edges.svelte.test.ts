// Turnstile wrapper edges: the api.js loader (script injection, reuse, failures, de-duplication)
// and the widget callbacks not covered by tests/unit/server/security/turnstile.svelte.test.ts.
// The real api.js is never fetched: `document.head.append` puts the injected script into <head> as
// on a real page, but inert (type text/plain), so its load/error events are dispatched by hand.
//
// Order matters inside this file: the loader keeps a successful load for the page's lifetime,
// so every test that needs a pending load runs before the only test that lets a load succeed.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import Turnstile, {
	TURNSTILE_SCRIPT_URL,
	loadTurnstile,
	type TurnstileApi,
	type TurnstileRenderOptions
} from '#lib/components/security/Turnstile.svelte';

const SCRIPT_ID = 'cf-turnstile-api';
/** Outcome the loader stamps on the api.js tag ('loaded' | 'failed'). */
const STATE_ATTR = 'data-turnstile-state';

interface FakeTurnstile extends TurnstileApi {
	options: TurnstileRenderOptions | null;
	renders: number;
	resets: (string | undefined)[];
	removed: (string | undefined)[];
}

function fakeTurnstile(
	widgetId: () => string | null | undefined = () => 'widget-1'
): FakeTurnstile {
	const fake: FakeTurnstile = {
		options: null,
		renders: 0,
		resets: [],
		removed: [],
		render(_container, options) {
			fake.renders += 1;
			fake.options = options;
			return widgetId();
		},
		reset(widgetId) {
			fake.resets.push(widgetId);
		},
		remove(widgetId) {
			fake.removed.push(widgetId);
		}
	};
	return fake;
}

function install(fake: FakeTurnstile): FakeTurnstile {
	Object.assign(window, { turnstile: fake });
	return fake;
}

async function renderedOptions(fake: FakeTurnstile): Promise<TurnstileRenderOptions> {
	await expect.poll(() => fake.options).not.toBeNull();
	const { options } = fake;
	if (!options) throw new Error('not rendered');
	return options;
}

/**
 * Keeps injected api.js scripts inert (no network) and returns them. They still go into <head>,
 * so a later load meets whatever tag an earlier one left there, as on a real page.
 */
function trapScripts() {
	const original = HTMLHeadElement.prototype.append;
	const trapped: HTMLScriptElement[] = [];
	const spy = vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
		for (const node of nodes) {
			if (node instanceof HTMLScriptElement && node.id === SCRIPT_ID) {
				// Not a JavaScript type: the browser neither fetches it nor fires its events.
				node.type = 'text/plain';
				trapped.push(node);
			}
		}
		original.apply(document.head, nodes);
	});
	return { trapped, restore: () => spy.mockRestore() };
}

/** A tag already in <head> before the loader runs (inert, no src). */
function placeTag(state?: 'loaded' | 'failed'): HTMLScriptElement {
	const tag = document.createElement('script');
	tag.id = SCRIPT_ID;
	tag.type = 'text/plain';
	if (state) tag.setAttribute(STATE_ATTR, state);
	document.head.appendChild(tag);
	return tag;
}

const hiddenToken = (container: HTMLElement, name = 'cf-turnstile-response') =>
	container.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	Reflect.deleteProperty(window, 'turnstile');
	for (const tag of document.querySelectorAll(`#${SCRIPT_ID}`)) tag.remove();
});

describe('loadTurnstile', () => {
	test('injects api.js once (explicit render, async) and shares the pending load', async () => {
		const scripts = trapScripts();
		try {
			const first = loadTurnstile();
			const second = loadTurnstile();
			expect(second).toBe(first);
			expect(scripts.trapped).toHaveLength(1);
			const script = scripts.trapped[0]!;
			expect(script.src).toBe(TURNSTILE_SCRIPT_URL);
			expect(script.async).toBe(true);
			expect(script.id).toBe(SCRIPT_ID);
			expect(document.getElementById(SCRIPT_ID)).toBe(script);
			// Loaded, but api.js did not define window.turnstile: the useless tag leaves <head>.
			script.dispatchEvent(new Event('load'));
			await expect(first).rejects.toThrow('turnstile-missing');
			expect(script.isConnected).toBe(false);
		} finally {
			scripts.restore();
		}
	});

	test('a network error rejects and is not cached: the failed tag leaves <head> and the retry injects a fresh one', async () => {
		const scripts = trapScripts();
		try {
			const failed = loadTurnstile();
			const dead = scripts.trapped[0]!;
			expect(document.getElementById(SCRIPT_ID)).toBe(dead);
			dead.dispatchEvent(new Event('error'));
			await expect(failed).rejects.toThrow('turnstile-load');
			expect(dead.isConnected).toBe(false);
			expect(dead.getAttribute(STATE_ATTR)).toBe('failed');

			const retry = loadTurnstile();
			expect(retry).not.toBe(failed);
			expect(scripts.trapped).toHaveLength(2);
			const fresh = scripts.trapped[1]!;
			expect(fresh).not.toBe(dead);
			expect(fresh.src).toBe(TURNSTILE_SCRIPT_URL);
			expect(fresh.hasAttribute(STATE_ATTR)).toBe(false);
			expect(document.getElementById(SCRIPT_ID)).toBe(fresh);
			fresh.dispatchEvent(new Event('error'));
			await expect(retry).rejects.toThrow('turnstile-load');
			expect(fresh.isConnected).toBe(false);
		} finally {
			scripts.restore();
		}
	});

	// Such a tag fired its events already (e.g. left by an earlier copy of the module): waiting on it
	// would hang, so it is swapped for a fresh one.
	for (const state of ['failed', 'loaded'] as const) {
		test(`a tag marked "${state}" without the api on the page is replaced, not awaited`, async () => {
			const stale = placeTag(state);
			const scripts = trapScripts();
			try {
				const load = loadTurnstile();
				expect(stale.isConnected).toBe(false);
				expect(scripts.trapped).toHaveLength(1);
				expect(document.getElementById(SCRIPT_ID)).toBe(scripts.trapped[0]);
				scripts.trapped[0]!.dispatchEvent(new Event('error'));
				await expect(load).rejects.toThrow('turnstile-load');
			} finally {
				scripts.restore();
			}
		});
	}

	test('an api already on the page is used at once, without a script', async () => {
		const scripts = trapScripts();
		try {
			const fake = install(fakeTurnstile());
			await expect(loadTurnstile()).resolves.toBe(fake);
			expect(scripts.trapped).toHaveLength(0);
		} finally {
			scripts.restore();
		}
	});

	test('a reused tag that already loaded resolves at once: no wait, no new script', async () => {
		const loaded = placeTag('loaded');
		const scripts = trapScripts();
		try {
			const fake = install(fakeTurnstile());
			await expect(loadTurnstile()).resolves.toBe(fake);
			expect(scripts.trapped).toHaveLength(0);
			expect(document.getElementById(SCRIPT_ID)).toBe(loaded);
		} finally {
			scripts.restore();
		}
	});
});

describe('widget lifecycle while api.js is loading', () => {
	test('unmounting before a failed load reports nothing', async () => {
		const scripts = trapScripts();
		const codes: string[] = [];
		try {
			const screen = await render(Turnstile, {
				siteKey: 'k',
				action: 'sign-in',
				onerror: (code: string) => codes.push(code)
			});
			await expect.poll(() => scripts.trapped.length).toBe(1);
			await screen.unmount();
			scripts.trapped[0]!.dispatchEvent(new Event('error'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(codes).toEqual([]);
		} finally {
			scripts.restore();
		}
	});

	test('outside a form, a failed load is announced at once and reported as "load"', async () => {
		const scripts = trapScripts();
		const codes: string[] = [];
		try {
			const screen = await render(Turnstile, {
				siteKey: 'k',
				action: 'sign-in',
				onerror: (code: string) => codes.push(code)
			});
			await expect.poll(() => scripts.trapped.length).toBe(1);
			scripts.trapped[0]!.dispatchEvent(new Event('error'));
			await expect
				.element(page.getByRole('alert'))
				.toHaveTextContent(
					'Não foi possível carregar a verificação de segurança. Recarregue a página e tente de novo.'
				);
			expect(codes).toEqual(['load']);
			expect(hiddenToken(screen.container)).toBe('');
			expect(screen.container.querySelector('.placeholder')).toBeNull();
		} finally {
			scripts.restore();
		}
	});

	test('after a failed load the next mount retries with a fresh tag and reports its failure too', async () => {
		const scripts = trapScripts();
		const codes: string[] = [];
		const onerror = (code: string) => codes.push(code);
		try {
			const first = await render(Turnstile, { siteKey: 'k', action: 'sign-in', onerror });
			await expect.poll(() => scripts.trapped.length).toBe(1);
			const dead = scripts.trapped[0]!;
			expect(document.getElementById(SCRIPT_ID)).toBe(dead);
			dead.dispatchEvent(new Event('error'));
			await expect.poll(() => codes).toEqual(['load']);
			expect(dead.isConnected).toBe(false);
			await first.unmount();

			// The retry must not wait on the dead tag (it would stay "Preparando verificação…").
			const second = await render(Turnstile, { siteKey: 'k', action: 'sign-in', onerror });
			await expect.poll(() => scripts.trapped.length).toBe(2);
			const fresh = scripts.trapped[1]!;
			expect(fresh).not.toBe(dead);
			expect(document.getElementById(SCRIPT_ID)).toBe(fresh);
			fresh.dispatchEvent(new Event('error'));
			await expect
				.element(page.getByRole('alert'))
				.toHaveTextContent(
					'Não foi possível carregar a verificação de segurança. Recarregue a página e tente de novo.'
				);
			expect(codes).toEqual(['load', 'load']);
			expect(second.container.querySelector('.placeholder')).toBeNull();
		} finally {
			scripts.restore();
		}
	});

	// The only test whose load succeeds (see the note at the top).
	test('a script tag already on the page is reused; a widget unmounted meanwhile never renders', async () => {
		const existing = document.createElement('script');
		existing.id = SCRIPT_ID;
		existing.type = 'text/plain';
		// Inserted before the trap (which would keep it detached).
		document.head.appendChild(existing);
		const scripts = trapScripts();
		try {
			const screen = await render(Turnstile, { siteKey: 'k', action: 'sign-in' });
			await tick();
			await screen.unmount();
			expect(scripts.trapped).toHaveLength(0);
			expect(existing.getAttribute('src')).toBeNull();
			const fake = install(fakeTurnstile());
			existing.dispatchEvent(new Event('load'));
			await expect(loadTurnstile()).resolves.toBe(fake);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(fake.renders).toBe(0);
			expect(fake.removed).toEqual([]);
		} finally {
			scripts.restore();
		}
	});
});

describe('widget callbacks', () => {
	test('passes theme, language and a custom field name through', async () => {
		const fake = install(fakeTurnstile());
		const screen = await render(Turnstile, {
			siteKey: 'site',
			action: 'sign-up',
			theme: 'dark',
			language: 'en',
			name: 'turnstile-token'
		});
		expect(await renderedOptions(fake)).toMatchObject({
			sitekey: 'site',
			action: 'sign-up',
			theme: 'dark',
			language: 'en',
			'response-field': false
		});
		expect(hiddenToken(screen.container, 'turnstile-token')).toBe('');
	});

	test('the default theme is auto', async () => {
		const fake = install(fakeTurnstile());
		await render(Turnstile, { siteKey: 'site', action: 'sign-in' });
		expect((await renderedOptions(fake)).theme).toBe('auto');
	});

	test('a timeout clears the token and resets this widget', async () => {
		const fake = install(fakeTurnstile());
		const screen = await render(Turnstile, { siteKey: 'k', action: 'sign-in' });
		const options = await renderedOptions(fake);
		options.callback?.('token-1');
		await tick();
		expect(hiddenToken(screen.container)).toBe('token-1');
		options['timeout-callback']?.();
		await tick();
		expect(hiddenToken(screen.container)).toBe('');
		expect(fake.resets).toEqual(['widget-1']);
	});

	test('a solved challenge clears the failure and restarts the reset budget', async () => {
		const fake = install(fakeTurnstile());
		const screen = await render(Turnstile, { siteKey: 'k', action: 'sign-in' });
		const options = await renderedOptions(fake);
		for (let index = 0; index < 3; index += 1) options['error-callback']?.('300030');
		// Outside a form the widget is the action: the failure is shown at once.
		await expect.element(page.getByRole('alert')).toBeVisible();
		expect(fake.resets).toHaveLength(2);

		options.callback?.('token-2');
		await tick();
		expect(page.getByRole('alert').elements()).toHaveLength(0);
		expect(hiddenToken(screen.container)).toBe('token-2');

		// Two fresh resets before giving up again.
		options['error-callback']?.('300030');
		options['error-callback']?.('300030');
		await tick();
		expect(fake.resets).toHaveLength(4);
		expect(page.getByRole('alert').elements()).toHaveLength(0);
		expect(hiddenToken(screen.container)).toBe('');
		options['error-callback']?.('300030');
		await expect.element(page.getByRole('alert')).toBeVisible();
	});

	test('errors are handled without an onerror listener and always claim the error', async () => {
		const fake = install(fakeTurnstile());
		await render(Turnstile, { siteKey: 'k', action: 'sign-in' });
		const options = await renderedOptions(fake);
		expect(options['error-callback']?.('110100')).toBe(true);
		expect(options['error-callback']?.('110100')).toBe(true);
		expect(options['error-callback']?.('110100')).toBe(true);
		expect(fake.resets).toEqual(['widget-1', 'widget-1']);
		await expect.element(page.getByRole('alert')).toBeVisible();
	});

	test('without a widget id the placeholder stays, resets target the default widget and unmount removes nothing', async () => {
		const fake = install(fakeTurnstile(() => undefined));
		const screen = await render(Turnstile, { siteKey: 'k', action: 'sign-in' });
		const options = await renderedOptions(fake);
		await tick();
		expect(screen.container.querySelector('.placeholder')?.getAttribute('data-state')).toBe(
			'preparing'
		);
		options['expired-callback']?.();
		options['timeout-callback']?.();
		options['error-callback']?.('x');
		expect(fake.resets).toEqual([undefined, undefined, undefined]);
		await screen.unmount();
		expect(fake.removed).toEqual([]);
	});
});
