import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import OfflinePage from '../../../../src/routes/offline/+page.svelte';
import ErrorPage from '../../../../src/routes/+error.svelte';
import offlineSource from '../../../../src/routes/offline/+page.svelte?raw';

// The error page reads `page` from $app/state; the test drives status and error by hand.
const routeState = vi.hoisted(() => ({
	status: 404,
	error: { message: 'SECRET_STACK at db.query (internal.ts:12)' } as { message: string } | null
}));

vi.mock('$app/state', () => ({
	page: {
		get status() {
			return routeState.status;
		},
		get error() {
			return routeState.error;
		}
	}
}));

let networkUp = true;

function stubNetwork() {
	Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => networkUp });
}

afterEach(async () => {
	await cleanup();
	Reflect.deleteProperty(navigator, 'onLine');
	networkUp = true;
	routeState.status = 404;
	routeState.error = { message: 'SECRET_STACK at db.query (internal.ts:12)' };
	await setLocale('pt-BR', { reload: false });
});

async function expectAccessible(container: HTMLElement) {
	const { violations } = await axe.run(container);
	expect(violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual(
		[]
	);
}

test('existing literal copy is unchanged and the new pt-BR copy has no em dash', () => {
	expect(m.pwa_offline_title()).toBe('Você está sem conexão');
	expect(m.pwa_offline_description()).toBe(
		'Esta página precisa de conexão. O editor, os presets e a prévia de áudio continuam disponíveis no aplicativo instalado.'
	);
	expect(m.pwa_offline_editor()).toBe('Abrir o editor');
	expect(m.layout_error_title()).toBe('Não foi possível abrir esta página');
	expect(m.layout_error_not_found()).toBe('Esta página não foi encontrada.');
	expect(m.layout_error_generic()).toBe('Ocorreu um erro. Tente novamente ou volte ao início.');
	expect(m.layout_error_home()).toBe('Voltar para Curva');
	expect(m.fux_p11_offline_retry()).toBe('Tentar de novo');
	const fresh = [
		m.fux_p11_offline_signal_none(),
		m.fux_p11_offline_signal_back(),
		m.fux_p11_offline_works_eyebrow(),
		m.fux_p11_offline_works_title(),
		m.fux_p11_offline_item_editor(),
		m.fux_p11_offline_item_editor_hint(),
		m.fux_p11_offline_item_cable(),
		m.fux_p11_offline_item_cable_hint(),
		m.fux_p11_offline_item_preview(),
		m.fux_p11_offline_item_preview_hint(),
		m.fux_p11_offline_item_blind(),
		m.fux_p11_offline_item_blind_hint(),
		m.fux_p11_offline_social_note(),
		m.fux_p11_offline_retry(),
		m.fux_p11_error_code_label(),
		m.fux_p11_error_not_found_hint(),
		m.fux_p11_error_generic_hint(),
		m.fux_p11_error_ways_label(),
		m.fux_p11_error_docs()
	];
	for (const text of fresh) {
		expect(text).not.toMatch(/[—–]/);
		// No plan codes (S1…S10, T…, F…, FUX…) in visible copy.
		expect(text).not.toMatch(/\b(?:S\d+|T\d+(?:\.\d+)?|F\d+|FUX)\b/);
	}
});

test('the offline page imports only light modules, never the app barrel', () => {
	const imports = [...offlineSource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
	expect(imports).toEqual([
		'$app/paths',
		'#lib/paraglide/messages.js',
		'#lib/components/primitives/Button.svelte',
		'#lib/components/primitives/Lamp.svelte',
		'#lib/components/primitives/Panel.svelte',
		// Decorative art (FUX.ART) arrives after idle through LazyArt (a dynamic import, so it is
		// not in the static closure); signal-art.svelte.test.ts holds SignalArt's script light.
		'#lib/components/art/LazyArt.svelte'
	]);
	expect(offlineSource).not.toMatch(/from\s+'#lib\/app\//);
});

test('offline explains what still works and offers to try again', async () => {
	stubNetwork();
	const screen = await render(OfflinePage);
	await expect
		.element(screen.getByRole('heading', { level: 1, name: m.pwa_offline_title(), exact: true }))
		.toHaveTextContent('Você está sem conexão');
	await expect.poll(() => document.title).toBe('Você está sem conexão · Open Auri');
	await expect
		.element(screen.getByText(m.pwa_offline_description(), { exact: true }))
		.toBeVisible();
	await expect
		.element(screen.getByRole('region', { name: m.fux_p11_offline_works_title(), exact: true }))
		.toBeVisible();
	const features = [...screen.container.querySelectorAll<HTMLElement>('li[data-feature]')];
	expect(features.map((item) => item.dataset.feature)).toEqual([
		'editor',
		'cable',
		'preview',
		'blind'
	]);
	await expect
		.element(screen.getByText(m.fux_p11_offline_item_blind(), { exact: true }))
		.toBeVisible();
	const retry = screen.getByRole('button', { name: 'Tentar de novo', exact: true });
	await expect.element(retry).toBeVisible();
	await expect.element(retry).not.toHaveAttribute('aria-disabled');
	await expect
		.element(screen.getByRole('link', { name: m.pwa_offline_editor(), exact: true }))
		.toHaveAttribute('href', '/');
});

test('the offline signal follows the browser network flag, as real state', async () => {
	stubNetwork();
	networkUp = true;
	const screen = await render(OfflinePage);
	const status = screen.getByRole('status');
	await expect.element(status).toHaveTextContent(m.fux_p11_offline_signal_back());
	await expect.element(status).toHaveAttribute('data-online', 'true');
	networkUp = false;
	window.dispatchEvent(new Event('offline'));
	await expect.element(status).toHaveTextContent(m.fux_p11_offline_signal_none());
	await expect.element(status).toHaveAttribute('data-online', 'false');
	networkUp = true;
	window.dispatchEvent(new Event('online'));
	await expect.element(status).toHaveTextContent(m.fux_p11_offline_signal_back());
});

test('404 shows the code as a readout, a plain message and ways back, never details', async () => {
	routeState.status = 404;
	const screen = await render(ErrorPage);
	await expect
		.poll(() => document.title)
		.toBe('404 · Não foi possível abrir esta página · open-auri');
	await expect
		.element(screen.getByRole('heading', { level: 1, name: m.layout_error_title(), exact: true }))
		.toBeVisible();
	const readout = screen.container.querySelector('.error-page__status');
	expect(readout?.textContent).toBe('404');
	expect(readout?.classList.contains('readout')).toBe(true);
	await expect.element(screen.getByText(m.layout_error_not_found(), { exact: true })).toBeVisible();
	await expect
		.element(screen.getByText(m.fux_p11_error_not_found_hint(), { exact: true }))
		.toBeVisible();
	const ways = screen.getByRole('navigation', { name: m.fux_p11_error_ways_label(), exact: true });
	await expect
		.element(ways.getByRole('link', { name: m.layout_error_home(), exact: true }))
		.toHaveAttribute('href', '/');
	await expect
		.element(ways.getByRole('link', { name: m.fux_p11_error_docs(), exact: true }))
		.toHaveAttribute('href', '/docs');
	expect(document.body.textContent).not.toContain('SECRET_STACK');
	expect(document.body.textContent).not.toContain('internal.ts');
});

test('a server error uses the generic message and still hides the error details', async () => {
	routeState.status = 500;
	routeState.error = { message: 'SECRET_STACK TypeError: x is undefined' };
	const screen = await render(ErrorPage);
	expect(screen.container.querySelector('.error-page__status')?.textContent).toBe('500');
	await expect.element(screen.getByText(m.layout_error_generic(), { exact: true })).toBeVisible();
	await expect
		.element(screen.getByText(m.fux_p11_error_generic_hint(), { exact: true }))
		.toBeVisible();
	expect(screen.container.querySelector('.error-page__hint')?.textContent?.trim()).toBe(
		m.fux_p11_error_generic_hint()
	);
	expect(document.body.textContent).not.toContain('SECRET_STACK');
	expect(document.body.textContent).not.toContain(m.layout_error_not_found());
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`offline has no serious or critical axe violations in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		stubNetwork();
		networkUp = false;
		const screen = await render(OfflinePage);
		await expect.element(screen.getByRole('status')).toHaveAttribute('data-online', 'false');
		await expectAccessible(screen.container);
	});

	for (const status of [404, 500]) {
		test(`error ${status} has no serious or critical axe violations in ${locale}`, async () => {
			await setLocale(locale, { reload: false });
			routeState.status = status;
			const screen = await render(ErrorPage);
			await expect
				.element(
					screen.getByRole('heading', { level: 1, name: m.layout_error_title(), exact: true })
				)
				.toBeVisible();
			await expectAccessible(screen.container);
		});
	}
}
