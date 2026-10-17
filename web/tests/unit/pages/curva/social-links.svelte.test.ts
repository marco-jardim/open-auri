import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { ORIGINS_KEY, originOf } from '#lib/social/index.ts';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import { m } from '#lib/paraglide/messages.js';
import { fakeAppOptions } from '../../app/fakes.ts';

const apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps.splice(0)) app.dispose();
	vi.unstubAllGlobals();
	localStorage.removeItem(ORIGINS_KEY);
});

test('the editor imports /?l=<id>&v=<version>#p=<S1> without writing', async () => {
	const curve = { bands: NEUTRO.bands, preampDb: -1 };
	const s1 = encodeS1(curve);
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		const body = String(input).includes('/api/v1/curves/')
			? {
					lineage: { id: 'linked-page', visibility: 'public' },
					version: { id: 'linked-version' },
					curve: { s1, gate: { ok: true } }
				}
			: null;
		return new Response(JSON.stringify(body), {
			headers: { 'content-type': 'application/json' }
		});
	});
	vi.stubGlobal('fetch', fetcher);
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	await app.state.ready;
	const clearLinkHash = vi.fn();
	const screen = await render(CurvaPage, {
		app,
		layer: 'ouvir',
		hash: `#p=${s1}`,
		pageUrl: new URL(`https://example.test/?l=linked-page&v=linked-version#p=${s1}`),
		onlayer: vi.fn(),
		clearLinkHash,
		gateClient: {
			async drag() {
				throw new Error('Unexpected drag');
			},
			async commit() {
				throw new Error('Unexpected commit');
			}
		}
	});
	// The account panel is a dynamic import (L5), fetched at once for a community link.
	await vi.waitFor(
		async () => {
			expect((await originOf(s1))?.lineageId).toBe('linked-page');
		},
		{ timeout: 5000 }
	);
	expect(app.state.curve.current.preampDb).toBe(-1);
	expect(clearLinkHash).toHaveBeenCalledOnce();
	expect(
		fetcher.mock.calls.some(
			([input]) => String(input) === '/api/v1/curves/linked-page?v=linked-version'
		)
	).toBe(true);
	await vi.waitFor(
		() => {
			expect(screen.container.textContent).toContain(m.curva_social_open());
		},
		{ timeout: 5000 }
	);
	expect(app.state.curve.update({ preampDb: -2 })).toBe(true);
	await tick();
	expect(screen.container.textContent).not.toContain(m.curva_social_open());
	expect(app.pendingWrite).toBeNull();
});
