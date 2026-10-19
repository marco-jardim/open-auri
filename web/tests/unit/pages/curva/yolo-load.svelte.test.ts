// YOLO publication, client phase A, in the Curva editor: a YOLO curve loaded from a `#p=` link
// with Modo YOLO off is kept (viewable, previewed behind the engine's protection, which covers
// any curve the standard gate refuses: preview.svelte.test.ts), shows the `share` notice and
// locks the edits, offering "Ativar Modo YOLO". Exports, import and the account panel stay open
// in YOLO (nothing is refused for being YOLO any more).
import '../../primitives/design-system.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { m } from '#lib/paraglide/messages.js';
import { createYoloState, YOLO_PHRASE } from '#lib/state/yolo.svelte.ts';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import { linkHash } from '#lib/components/pages/curva/io.ts';
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import type { Layer } from '#lib/components/pages/curva/layers.ts';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { classOf } from '#lib/components/pages/curva/yolo.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const neutral: Curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const pad = (bands: Band[]) => [...bands, ...NEUTRO.bands.slice(bands.length)];
/** Refused by the standard gate on class-2 reasons only, accepted by YOLO: "subsônica". */
const yoloCurve: Curve = {
	bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]),
	preampDb: -0.5
};
const apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps.splice(0)) app.dispose();
	vi.restoreAllMocks();
});

function gateClient(): GateClient {
	let id = 0;
	return {
		async drag(input) {
			const result = handleGateRequest({ ...input, type: 'drag', id: ++id });
			if (result.type !== 'drag') throw new Error('Unexpected drag response');
			return result;
		},
		async commit(input) {
			const result = handleGateRequest({ ...input, type: 'commit', id: ++id });
			if (result.type !== 'commit') throw new Error('Unexpected commit response');
			return result;
		}
	};
}

async function setup(layer: Layer, hash = '', yoloOn = false) {
	const yolo = createYoloState();
	const app = createClientApp({ ...fakeAppOptions().options, yolo });
	apps.push(app);
	await app.state.ready;
	app.state.curve.set({ ...neutral, name: 'Editor', source: 'custom' });
	if (yoloOn && !yolo.enable(YOLO_PHRASE, layer)) throw new Error('YOLO needs Engenharia');
	const screen = await render(CurvaPage, {
		app,
		layer,
		hash,
		pageUrl: new URL('https://example.test/'),
		onlayer: vi.fn(),
		gateClient: gateClient(),
		clearLinkHash: vi.fn(),
		tourAutoOpen: false
	});
	await tick();
	return { app, yolo, screen };
}

test('the fixture is YOLO: the standard gate refuses it, the class is yolo', () => {
	expect(verdictFor(yoloCurve).ok).toBe(false);
	expect(classOf(yoloCurve).class).toBe('yolo');
});

test('a YOLO link with YOLO off loads, shows the notice, locks the edits and offers YOLO', async () => {
	const hash = linkHash(yoloCurve, 'engenharia');
	if (!hash.ok) throw new Error('YOLO link refused');
	expect(hash.yolo).toBe(true);
	const { app, yolo } = await setup('engenharia', hash.value);
	await vi.waitFor(() => expect(app.state.curve.current.source).toBe('import'));
	// Kept as it is: viewable and previewable, never rewritten to a standard curve.
	expect(app.state.curve.current.bands).toEqual(yoloCurve.bands);
	expect(app.state.curve.current.preampDb).toBe(yoloCurve.preampDb);
	expect(yolo.enabled).toBe(false);
	const notice = page.getByRole('note', { name: m.yolo_curve_title_share() });
	await expect.element(notice).toBeVisible();
	await expect.element(notice).toMatchTextContent(m.yolo_curve_lede_share());
	expect(document.querySelector('[data-yolo-locked="editor"]')).not.toBeNull();
	expect(document.querySelector('.yolo-curve-why')?.textContent?.trim()).toBe(
		m.yolopub_editor_locked()
	);
	await expect.element(page.getByRole('button', { name: m.yolopub_enable_yolo() })).toBeVisible();
	// The preview lever is still there (the engine plays the curve protected).
	expect(document.querySelector('[data-yolo-locked="social"]')).toBeNull();
	// Exports stay open, marked.
	await vi.waitFor(() => expect(document.querySelector('[data-yolo-export]')).not.toBeNull());
});

test('a YOLO curve with YOLO on is not locked, and import and the account panel stay open', async () => {
	const { app, screen } = await setup('engenharia', '', true);
	app.state.curve.set({ ...yoloCurve, name: 'Subsônica', source: 'custom' });
	await tick();
	await expect.element(page.getByRole('note', { name: m.yolo_curve_title_editor() })).toBeVisible();
	expect(document.querySelector('[data-yolo-locked="editor"]')).toBeNull();
	expect(document.querySelector('[data-yolo-locked="social"]')).toBeNull();
	await vi.waitFor(() => {
		const input = screen.container.querySelector('input[type="file"]');
		expect(input).toBeInstanceOf(HTMLInputElement);
		if (input instanceof HTMLInputElement) expect(input.disabled).toBe(false);
	});
});

test('a standard curve shows no YOLO notice', async () => {
	await setup('ajustar');
	expect(document.querySelector('[data-yolo-curve-notice]')).toBeNull();
});
