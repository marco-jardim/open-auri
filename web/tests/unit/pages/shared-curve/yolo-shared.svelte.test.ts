// YOLO publication on /c/[id]: a published YOLO curve (class derived from its own S1) shows the
// `public` notice at the top. With Modo YOLO off the install action is "Ativar Modo YOLO" (the
// curve in the editor's Engenharia layer, never a checklist that would refuse it); with YOLO on it
// is "Instalar curva YOLO" and opens the checklist with the YOLO profile.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import type { ClientApp } from '#lib/app/client.svelte.ts';
import { IDLE_STATE } from '#lib/audio/engine.ts';
import SharedCurve from '#lib/components/pages/shared-curve/SharedCurve.svelte';
import type { SharedCurveData, SharedCurveMeta } from '#lib/components/pages/shared-curve/types.ts';
import { m } from '#lib/paraglide/messages.js';
import { neutralCurve } from '#lib/state/model.ts';
import { createYoloState, YOLO_PHRASE } from '#lib/state/yolo.svelte.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const YOLO_S1 = encodeS1({
	preampDb: -0.5,
	bands: [{ kind: 'HP', freqHz: 30, qFactor: 0.71 }, ...NEUTRO.bands.slice(1)]
});

function data(s1: string): SharedCurveData {
	return {
		lineageId: 'lin-yolo12345678',
		versionId: 'ver-yolo12345678',
		isHead: true,
		name: 'Subsônica',
		description: '',
		license: 'CC0-1.0',
		lang: 'pt-BR',
		author: { username: 'geoff', displayUsername: 'Geoff' },
		s1,
		visibility: 'public',
		shareId: null
	};
}

const META: SharedCurveMeta = {
	canonical: 'https://example.test/c/lin-yolo12345678',
	image: 'https://example.test/og/x.png',
	indexable: false
};

function fakeApp(yoloOn: boolean) {
	const requestWrite = vi.fn();
	const yolo = createYoloState();
	if (yoloOn && !yolo.enable(YOLO_PHRASE, 'engenharia')) throw new Error('YOLO refused');
	const app = {
		requestWrite,
		yolo,
		state: { curve: { current: neutralCurve() } },
		audio: {
			state: () => ({ ...IDLE_STATE }),
			onChange: () => () => undefined,
			getContext: () => ({ state: 'running', resume: async () => undefined }),
			createAB: vi.fn(() => ({ dispose: vi.fn(), select: vi.fn() })),
			stop: vi.fn(),
			pause: vi.fn()
		}
	};
	return { app: app as unknown as ClientApp, requestWrite };
}

test('a YOLO curve shows the public notice; with YOLO off the action is "Ativar Modo YOLO"', async () => {
	const { app, requestWrite } = fakeApp(false);
	await render(SharedCurve, { curve: data(YOLO_S1), meta: META, signedIn: false, app });
	const notice = page.getByRole('note', { name: m.yolo_curve_title_public() });
	await expect.element(notice).toBeVisible();
	await expect.element(notice).toMatchTextContent(m.yolo_curve_lede_public());
	const enable = page.getByTestId('shared-yolo-enable');
	await expect.element(enable).toHaveTextContent(m.yolopub_enable_yolo());
	const href = enable.element().getAttribute('href') ?? '';
	expect(href).toContain('camada=engenharia');
	expect(href).toContain(`#p=${YOLO_S1}`);
	await expect.element(page.getByTestId('shared-yolo-why')).toBeVisible();
	expect(page.getByRole('button', { name: m.yolopub_install_yolo() }).elements()).toHaveLength(0);
	expect(requestWrite).not.toHaveBeenCalled();
});

test('with YOLO on, "Instalar curva YOLO" opens the checklist with the YOLO profile', async () => {
	const { app, requestWrite } = fakeApp(true);
	await render(SharedCurve, { curve: data(YOLO_S1), meta: META, signedIn: false, app });
	await page.getByRole('button', { name: m.yolopub_install_yolo() }).click();
	expect(requestWrite).toHaveBeenCalledTimes(1);
	expect(requestWrite.mock.calls[0]?.[1]).toEqual({ profile: 'yolo' });
});

test('a standard curve has no notice and the plain install', async () => {
	const { app, requestWrite } = fakeApp(false);
	await render(SharedCurve, {
		curve: data(encodeS1(neutralCurve())),
		meta: META,
		signedIn: false,
		app
	});
	expect(document.querySelector('[data-yolo-curve-notice]')).toBeNull();
	await page.getByRole('button', { name: m.shared_curve_install() }).click();
	expect(requestWrite).toHaveBeenCalledTimes(1);
	expect(requestWrite.mock.calls[0]).toHaveLength(1);
});
