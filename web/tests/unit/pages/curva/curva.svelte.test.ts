import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import type { Layer } from '#lib/components/pages/curva/layers.ts';
import type { Band } from '#lib/components/pages/curva/model.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const OFF: Band = { kind: 'OFF' };
const pad = (bands: Band[]): Band[] => [
	...bands,
	...Array.from({ length: 10 - bands.length }, () => OFF)
];
const CUT: Band = { kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 };
const BOOST: Band = { kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 };

let apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps) app.dispose();
	apps = [];
	await setLocale('pt-BR', { reload: false });
});

function gateClient(): GateClient {
	let id = 0;
	return {
		async drag(input) {
			const response = handleGateRequest({ ...input, type: 'drag', id: ++id });
			if (response.type !== 'drag') throw new Error('unexpected');
			return response;
		},
		async commit(input) {
			const response = handleGateRequest({ ...input, type: 'commit', id: ++id });
			if (response.type !== 'commit') throw new Error('unexpected');
			return response;
		}
	};
}

function focus(locator: { element(): Element }) {
	const element = locator.element();
	if (element instanceof HTMLElement || element instanceof SVGElement) element.focus();
}

async function setup(layer: Layer, bands?: Band[], name = 'Teste', preampDb = -0.5) {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	if (bands) app.state.curve.set({ name, source: 'custom', preampDb, bands });
	const onlayer = vi.fn();
	const screen = await render(CurvaPage, {
		app,
		layer,
		hash: '',
		pageUrl: new URL('https://example.test/'),
		onlayer,
		gateClient: gateClient()
	});
	return { app, onlayer, screen };
}

async function expectAccessible(container: HTMLElement) {
	const { violations } = await axe.run(container);
	const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
	expect(blocking).toEqual([]);
}

for (const copy of [
	{ locale: 'pt-BR', title: 'Curva', eng: 'Gabinete modular', bank: 'Banco de filtros' },
	{ locale: 'en-US', title: 'Curve', eng: 'Modular cabinet', bank: 'Filter bank' }
] as const) {
	for (const layer of ['ouvir', 'ajustar', 'engenharia'] as const) {
		test(`renders ${layer} in ${copy.locale} without serious/critical axe violations`, async () => {
			await setLocale(copy.locale, { reload: false });
			const { screen } = await setup(layer);
			await tick();
			await expect.element(page.getByRole('heading', { level: 1, name: copy.title })).toBeVisible();
			expect(screen.container.querySelector('main')).not.toBeNull();
			// The bank is a deferred chunk (FUX.B): wait for it before reading the text.
			const text = () => screen.container.textContent ?? '';
			await expect
				.poll(() => text().includes(copy.bank), { timeout: 5000 })
				.toBe(layer !== 'ouvir');
			await expect
				.poll(() => text().includes(copy.eng), { timeout: 5000 })
				.toBe(layer === 'engenharia');
			await expectAccessible(screen.container);
		}, 30000);
	}
}

test('keys 1/2/3 request the layer; typing in a field does not', async () => {
	const { onlayer } = await setup('ouvir');
	await tick();
	await userEvent.keyboard('3');
	expect(onlayer).toHaveBeenLastCalledWith('engenharia');
	await userEvent.keyboard('2');
	expect(onlayer).toHaveBeenLastCalledWith('ajustar');
	onlayer.mockClear();
	focus(page.getByRole('slider', { name: /Grave/ }).first());
	await userEvent.keyboard('1');
	expect(onlayer).not.toHaveBeenCalled();
});

test('the layer selector radiogroup calls onlayer', async () => {
	const { onlayer } = await setup('ouvir');
	await page.getByRole('radio', { name: 'Engenharia' }).click();
	expect(onlayer).toHaveBeenCalledWith('engenharia');
});

test('a reorder the gate refuses springs back with the reason', async () => {
	const { app } = await setup('engenharia', pad([CUT, BOOST]));
	await tick();
	await page.getByRole('button', { name: 'Mover o filtro 2 para a esquerda' }).click();
	await expect.element(page.getByText(/Ordem recusada/).first()).toBeVisible();
	expect(app.state.curve.current.bands.slice(0, 2)).toEqual([CUT, BOOST]);
});

test('an accepted reorder updates the editor (undoable)', async () => {
	const { app } = await setup('engenharia', pad([CUT, BOOST]));
	await tick();
	await page.getByRole('button', { name: 'Mover o filtro 2 para a direita' }).click();
	await tick();
	expect(app.state.curve.current.bands[2]).toEqual(BOOST);
	expect(app.state.curve.canUndo).toBe(true);
});

test('untrusted curve names render as text, never as markup', async () => {
	const name = '<img src=x onerror="window.__pwned=1">';
	const { screen } = await setup('ouvir', pad([CUT]), name, -1);
	await tick();
	expect(screen.container.querySelector('img')).toBeNull();
	expect(screen.container.textContent).toContain(name);
});

test('HS/LP/HP are locked with a hint in Ajustar and editable in Engenharia', async () => {
	const hs: Band = { kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 };
	await setup('ajustar', pad([hs]), 'HS', -1);
	await tick();
	const handle = page.getByRole('slider', { name: /Filtro 1/ });
	await expect.element(handle).toHaveAttribute('aria-disabled', 'true');
	await expect.element(page.getByText(/disponíveis na camada Engenharia/).first()).toBeVisible();
	await cleanup();
	await setup('engenharia', pad([hs]), 'HS', -1);
	await tick();
	await expect
		.element(page.getByRole('slider', { name: /Filtro 1/ }))
		.toHaveAttribute('aria-disabled', 'false');
	await expect.element(page.getByText('EXPERIMENTAL').first()).toBeVisible();
});

test('keyboard nudges on a handle go through the gate and land in the editor', async () => {
	const { app } = await setup('ajustar', pad([CUT]), 'Teste', -1);
	await tick();
	focus(page.getByRole('slider', { name: /Filtro 1/ }));
	await userEvent.keyboard('{ArrowUp}');
	// Mock step: ↑ adds 1 dB.
	await vi.waitFor(() => expect(app.state.curve.current.bands[0]).toMatchObject({ gainDb: -5 }));
});

test('"Gravar no cabo" only opens the layout checklist through requestWrite', async () => {
	const { app } = await setup('ouvir', pad([CUT]), 'Teste', -1);
	const spy = vi.spyOn(app, 'requestWrite');
	await page.getByRole('button', { name: 'Gravar no cabo' }).click();
	expect(spy).toHaveBeenCalledTimes(1);
	expect(app.pendingWrite?.bands[0]).toEqual(CUT);
});
