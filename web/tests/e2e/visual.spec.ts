import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { openApp, settleRendering } from './helpers/a-app';
import { routes } from './helpers/a-routes';
import { dynamicRegions } from './helpers/a-visual';

// The capture injects tests/e2e/helpers/visual.css as a <style>; the strict CSP (T5.4) blocks
// injected styles. CSP itself is covered by csp.spec.ts, which runs without this bypass.
test.use({ bypassCSP: true });

/**
 * Every page of web/src/lib/comprehension/steps.ts dismissed (the `oa.tour.v1` contract), so a
 * first-visit guided tour never opens over a capture. Kept local: the shared helpers have no
 * fixture every spec uses, and community.spec.ts opens the tour on purpose.
 */
const TOURS_DISMISSED = JSON.stringify({
	curva: 'dispensado',
	comunidade: 'dispensado',
	cabo: 'dispensado',
	'soe-como-x': 'dispensado',
	comparar: 'dispensado',
	'teste-cego': 'dispensado',
	biblioteca: 'dispensado'
});

test.beforeEach(async ({ context }) => {
	await context.addInitScript((value) => {
		// Only real documents have a storage of the app's origin (not about:blank).
		if (location.protocol.startsWith('http')) localStorage.setItem('oa.tour.v1', value);
	}, TOURS_DISMISSED);
});

// Both configured projects run every case: desktop 1440 px and mobile 390 px.
const visualCss = fileURLToPath(new URL('./helpers/visual.css', import.meta.url));
// Comunidade (Phase 4) is added here only: the shared route list (helpers/a-routes.ts) also drives
// other specs. Its reference runs on :4173 (sign-up closed, nobody publishes there), so the feed is
// stable.
const visualRoutes = [...routes, { path: '/comunidade', name: 'comunidade' } as const];

/** Constant wall clock of the deterministic Comunidade capture (2026-01-01T00:00:00Z). */
const COMUNIDADE_EPOCH = Date.UTC(2026, 0, 1);

/**
 * Runs in the page before any app code (Comunidade only). The S6 payload preview carries a random
 * receipt and the S5 envelope preview the current `createdAt`; both are masked, but their wrapping
 * on narrow viewports changes their height and shifts everything below. So the capture fixes the
 * wall clock (`Date`, `Date.now`) to a constant and makes `crypto.getRandomValues`,
 * `crypto.randomUUID` and `Math.random` a seeded sequence. Timers, animation frames and
 * `performance.now` are untouched.
 */
function deterministicPage(epoch: number): void {
	const RealDate = Date;
	class FixedDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(epoch);
			else super(...(args as [number]));
		}
		static override now(): number {
			return epoch;
		}
	}
	Object.defineProperty(window, 'Date', { value: FixedDate, configurable: true, writable: true });

	// mulberry32, fixed seed.
	let state = 0x2545f491;
	function next(): number {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return (t ^ (t >>> 14)) >>> 0;
	}
	function fill<T extends ArrayBufferView | null>(array: T): T {
		if (array) {
			const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
			for (let index = 0; index < bytes.length; index += 1) bytes[index] = next() & 0xff;
		}
		return array;
	}
	function uuid(): `${string}-${string}-${string}-${string}-${string}` {
		const bytes = fill(new Uint8Array(16));
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
	Object.defineProperty(crypto, 'getRandomValues', { value: fill, configurable: true });
	Object.defineProperty(crypto, 'randomUUID', { value: uuid, configurable: true });
	Object.defineProperty(Math, 'random', {
		value: () => next() / 0x1_0000_0000,
		configurable: true,
		writable: true
	});
}

for (const motion of [
	{ name: 'default-motion', preference: 'no-preference' },
	{ name: 'reduced-motion', preference: 'reduce' }
] as const) {
	test.describe(motion.name, () => {
		test.describe.configure({ mode: 'parallel' });
		test.use({ reducedMotion: motion.preference });

		// Legal pages render operator data from the build env; their captures must never be versioned.
		for (const route of visualRoutes.filter(
			({ path }) => path !== '/privacidade' && path !== '/termos'
		)) {
			test(`${route.path} reference`, async ({ page }, testInfo) => {
				if (route.path === '/comunidade') {
					await page.addInitScript(deterministicPage, COMUNIDADE_EPOCH);
				}
				await openApp(page, route.path);
				await settleRendering(page);
				expect(
					await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
				).toBe(motion.preference === 'reduce');
				// Project and motion are explicit so update-snapshots cannot overwrite another variant.
				await expect(page).toHaveScreenshot(
					`${route.name}-${testInfo.project.name}-${motion.name}.png`,
					{
						fullPage: true,
						animations: 'disabled',
						caret: 'hide',
						mask: [
							...dynamicRegions(page),
							// Per-run values on Comunidade: the S6 payload preview carries a random
							// receipt and the S5 envelope preview the current `createdAt`.
							...(route.path === '/comunidade'
								? [page.getByTestId('s6-payload'), page.getByTestId('onair-s5')]
								: [])
						],
						maxDiffPixelRatio: 0.02,
						// Long pages (Docs) need more than the 5 s default to capture two identical frames.
						timeout: 30_000,
						stylePath: visualCss
					}
				);
			});
		}
	});
}
