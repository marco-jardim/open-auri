// Simple Analytics is loaded on the production origin only (src/lib/server/analytics.ts, composed
// in hooks.server.ts). The handle runs on the real app.html, the way Kit renders and prerenders.
import { readFileSync } from 'node:fs';
import type { Handle } from '@sveltejs/kit/hooks';
import { describe, expect, it } from 'vitest';
import {
	ANALYTICS_PLACEHOLDER,
	ANALYTICS_SNIPPET,
	PRODUCTION_ORIGIN,
	analyticsEnabled,
	createAnalyticsHandle,
	injectAnalytics
} from '#lib/server/analytics.ts';

type Event = Parameters<Handle>[0]['event'];

const APP_HTML = readFileSync(new URL('../../../src/app.html', import.meta.url), 'utf8').replaceAll(
	'\r\n',
	'\n'
);
const DEPLOY = readFileSync(new URL('../../../../tools/deploy.mjs', import.meta.url), 'utf8');
const SCRIPT_TAG = '<script async src="https://scripts.simpleanalyticscdn.com/latest.js"></script>';

const PRODUCTION = 'https://open-auri.com';
const NOT_PRODUCTION = [
	'http://localhost:5173',
	'http://localhost:4173',
	'http://localhost:4174',
	'http://127.0.0.1:4173',
	'https://open-auri-staging.example-sub.workers.dev',
	// The production Worker's own workers.dev host (it answers 301 there anyway).
	'https://open-auri.example-sub.workers.dev',
	// ci.yml's PUBLIC_ORIGIN.
	'https://open-auri-ci.ci-fixture.workers.dev',
	'http://open-auri.com',
	'https://www.open-auri.com',
	'https://open-auri.com.evil.example',
	'',
	'not a url'
];

/** Runs the handle like Kit does: resolve applies the merged transformPageChunk to the shell. */
async function render(handle: Handle, url: string): Promise<string> {
	let html = APP_HTML;
	await handle({
		event: { url: new URL(url) } as unknown as Event,
		resolve: async (_event, options) => {
			html = (await options?.transformPageChunk?.({ html, done: true })) ?? html;
			return new Response(html, { headers: { 'content-type': 'text/html' } });
		}
	});
	return html;
}

describe('analytics gate', () => {
	it('uses the production origin of tools/deploy.mjs', () => {
		expect(PRODUCTION_ORIGIN).toBe(PRODUCTION);
		expect(/\bPRODUCTION_ORIGIN = '([^']+)'/.exec(DEPLOY)?.[1]).toBe(PRODUCTION_ORIGIN);
	});

	it('is on for a production build, while prerendering and for production requests', () => {
		expect(analyticsEnabled({ buildOrigin: PRODUCTION })).toBe(true);
		expect(analyticsEnabled({ buildOrigin: `${PRODUCTION}/` })).toBe(true);
		expect(analyticsEnabled({ buildOrigin: PRODUCTION, requestOrigin: PRODUCTION })).toBe(true);
		expect(
			analyticsEnabled({ buildOrigin: PRODUCTION, requestOrigin: 'https://OPEN-AURI.com' })
		).toBe(true);
	});

	it('is off for every other build origin, prerendered or not', () => {
		for (const buildOrigin of NOT_PRODUCTION) {
			expect(analyticsEnabled({ buildOrigin }), buildOrigin).toBe(false);
			expect(analyticsEnabled({ buildOrigin, requestOrigin: PRODUCTION }), buildOrigin).toBe(false);
		}
	});

	it('is off when a production build is served from any other origin (localhost, previews)', () => {
		for (const requestOrigin of NOT_PRODUCTION) {
			expect(analyticsEnabled({ buildOrigin: PRODUCTION, requestOrigin }), requestOrigin).toBe(
				false
			);
		}
	});
});

describe('analytics tag', () => {
	it('is the provider snippet unchanged: its comment, the official src, async, no inline code', () => {
		expect(ANALYTICS_SNIPPET.startsWith('<!-- 100% privacy-first analytics -->\n')).toBe(true);
		expect(ANALYTICS_SNIPPET.endsWith(SCRIPT_TAG)).toBe(true);
		expect(ANALYTICS_SNIPPET).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
		expect(ANALYTICS_SNIPPET.match(/<script/g)).toHaveLength(1);
	});

	it('has its placeholder once in app.html, at the end of <body>', () => {
		expect(APP_HTML.split(ANALYTICS_PLACEHOLDER)).toHaveLength(2);
		const body = APP_HTML.indexOf('%sveltekit.body%');
		const placeholder = APP_HTML.indexOf(ANALYTICS_PLACEHOLDER);
		expect(placeholder).toBeGreaterThan(body);
		expect(APP_HTML.slice(placeholder + ANALYTICS_PLACEHOLDER.length).trim()).toBe(
			'</body>\n</html>'
		);
	});

	it('fills the placeholder when enabled and removes it otherwise', () => {
		const on = injectAnalytics(APP_HTML, true);
		expect(on).toContain(ANALYTICS_SNIPPET);
		expect(on).not.toContain(ANALYTICS_PLACEHOLDER);
		expect(on.indexOf(SCRIPT_TAG)).toBeGreaterThan(on.indexOf('%sveltekit.body%'));
		expect(on.slice(on.indexOf(SCRIPT_TAG) + SCRIPT_TAG.length).trim()).toBe('</body>\n</html>');
		const off = injectAnalytics(APP_HTML, false);
		expect(off).not.toContain(ANALYTICS_PLACEHOLDER);
		expect(off).not.toContain('simpleanalytics');
		expect(off).not.toContain('privacy-first analytics');
	});
});

describe('analytics handle', () => {
	it('renders the tag on production SSR requests and on a production prerender', async () => {
		const ssr = createAnalyticsHandle({ building: false, buildOrigin: PRODUCTION });
		expect(await render(ssr, `${PRODUCTION}/curva`)).toContain(SCRIPT_TAG);
		// While prerendering the URL is Kit's internal one: the build's origin decides.
		const prerender = createAnalyticsHandle({ building: true, buildOrigin: PRODUCTION });
		expect(await render(prerender, 'http://sveltekit-prerender/docs')).toContain(SCRIPT_TAG);
	});

	it('renders no tag on localhost, the e2e previews, staging or CI builds', async () => {
		const production = createAnalyticsHandle({ building: false, buildOrigin: PRODUCTION });
		for (const url of ['http://localhost:4173/', 'http://localhost:4174/entrar']) {
			const html = await render(production, url);
			expect(html, url).not.toContain('simpleanalytics');
			expect(html, url).not.toContain(ANALYTICS_PLACEHOLDER);
		}
		for (const buildOrigin of NOT_PRODUCTION) {
			for (const building of [true, false]) {
				const handle = createAnalyticsHandle({ building, buildOrigin });
				const html = await render(handle, `${PRODUCTION}/`);
				expect(html, `${buildOrigin} building=${building}`).not.toContain('simpleanalytics');
				expect(html, `${buildOrigin} building=${building}`).not.toContain(ANALYTICS_PLACEHOLDER);
			}
		}
	});
});
