// FUX.2 (spec docs/plans/fux-spec.md §5.3, §5.4, §7 risks 1 and 2): the app runtime and the
// chrome islands load on demand without delaying the rescue notice, instrument routes get the
// runtime without a cascade, the checklist and a simulated write still work, the dynamic chunks
// are in the offline cache, and hydration stays clean.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installHidStub } from './helpers/b-hid';
import { barAction, barScope, closeChecklist, confirmBasics, connectCable } from './helpers/b-ui';

test.use({ locale: 'pt-BR', reducedMotion: 'reduce' });
test.setTimeout(60_000);

const RUNTIME_SOURCE = 'src/lib/app/client.svelte.ts';
/** Rollup/Rolldown chunk name of a chunk built around RUNTIME_SOURCE (`[name]`). */
const RUNTIME_NAME = 'client.svelte';
/** SvelteKit's root layout node (always node 0): its static closure loads on every route. */
const LAYOUT_NODE = /\/nodes\/0\.js$/;
const LOADING_REASON = 'Carregando o motor do cabo…';

interface ViteChunk {
	file: string;
	name?: string;
	imports?: string[];
	dynamicImports?: string[];
}

/**
 * Manifest key of the chunk `loadAppRuntime` imports. Built alone, client.svelte.ts is a chunk
 * keyed by its source. Once instrument pages import the `#lib/app` barrel statically, the
 * bundler merges it into a shared chunk named after it, keyed `_<hash>.js`. Either way it is the
 * target of a dynamic import made from the root layout's static closure, outside that closure
 * (a chunk the layout loads eagerly is not the lazy runtime, e.g. SvelteKit's own
 * `$app/state` `client.svelte` chunk).
 */
function runtimeKey(manifest: Record<string, ViteChunk>): string {
	const own = Object.keys(manifest).find((name) => name.endsWith(RUNTIME_SOURCE));
	if (own !== undefined) return own;
	const layout = Object.keys(manifest).find((name) => LAYOUT_NODE.test(name));
	if (layout === undefined) throw new Error('The root layout node is not in the manifest');
	const eager = new Set<string>();
	const load = (name: string) => {
		if (eager.has(name)) return;
		eager.add(name);
		for (const dependency of manifest[name]?.imports ?? []) load(dependency);
	};
	load(layout);
	const lazy = new Set(
		[...eager]
			.flatMap((name) => manifest[name]?.dynamicImports ?? [])
			.filter((name) => !eager.has(name))
	);
	const matches = [...lazy].filter((name) => manifest[name]?.name === RUNTIME_NAME);
	const [match, ...others] = matches;
	if (match === undefined || others.length > 0) {
		throw new Error(
			`Expected one lazy ${RUNTIME_SOURCE} chunk behind the root layout, found ${matches.length}`
		);
	}
	return match;
}

/** The runtime chunk and its static dependencies, from the build the preview server serves. */
function runtimeChunk(): { file: string; dependencies: string[] } {
	const manifest = JSON.parse(
		readFileSync(
			new URL('../../.svelte-kit/output/client/.vite/manifest.json', import.meta.url),
			'utf8'
		)
	) as Record<string, ViteChunk>;
	const key = runtimeKey(manifest);
	const dependencies = new Set<string>();
	const visit = (name: string) => {
		for (const dependency of manifest[name]?.imports ?? []) {
			const file = manifest[dependency]?.file;
			if (file === undefined || dependencies.has(file)) continue;
			dependencies.add(file);
			visit(dependency);
		}
	};
	visit(key);
	const file = manifest[key]?.file;
	if (file === undefined) throw new Error('Runtime chunk without a file');
	return { file, dependencies: [...dependencies] };
}

/**
 * Replaces requestIdleCallback with a queue the test drains by hand, so "before idle" is
 * deterministic: nothing scheduled for idle runs until `runIdle`.
 */
async function holdIdle(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const queue: IdleRequestCallback[] = [];
		Object.defineProperty(window, '__idleQueue', { value: queue, configurable: true });
		window.requestIdleCallback = (callback: IdleRequestCallback) => queue.push(callback);
		window.cancelIdleCallback = (handle: number) => {
			queue[handle - 1] = () => undefined;
		};
	});
}

async function idleScheduled(page: Page): Promise<void> {
	// The layout's onMount schedules its idle work: the page has hydrated.
	await page.waitForFunction(
		() => (Reflect.get(window, '__idleQueue') as IdleRequestCallback[] | undefined)?.length
	);
}

async function runIdle(page: Page): Promise<void> {
	await page.evaluate(() => {
		const queue = Reflect.get(window, '__idleQueue') as IdleRequestCallback[];
		for (const callback of queue.splice(0)) {
			callback({ didTimeout: false, timeRemaining: () => 50 });
		}
	});
}

function requested(page: Page): string[] {
	const urls: string[] = [];
	page.on('request', (request) => urls.push(new URL(request.url()).pathname));
	return urls;
}

const bar = (page: Page) => page.locator('[data-chrome="bar"]');
const barWrite = (page: Page) =>
	bar(page).getByRole('button', { name: 'Gravar no cabo', exact: true });
const statusTrigger = (page: Page) => bar(page).locator('button[popovertarget]');

test('a static route does not request the runtime chunk before idle, then loads it on idle', async ({
	page
}) => {
	const runtime = runtimeChunk();
	const urls = requested(page);
	await holdIdle(page);
	await page.goto('/offline');
	await idleScheduled(page);
	await expect(page.locator('.app-root')).toHaveAttribute('data-runtime', 'idle');
	// §5.5: the cable status is a pill skeleton and the write action says why it waits.
	const skeleton = bar(page).locator('.status-skeleton[aria-busy="true"]');
	await expect(skeleton).toHaveCount(1);
	await expect(skeleton).toContainText(LOADING_REASON);
	await expect(statusTrigger(page)).toHaveCount(0);
	await expect(barWrite(page)).toHaveAttribute('aria-disabled', 'true');
	await expect(barWrite(page)).toHaveAccessibleDescription(LOADING_REASON);
	// Two painted frames after hydration: an eager import would have been requested by now.
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			})
	);
	expect(urls.some((url) => url.endsWith(`/${runtime.file}`))).toBe(false);

	await runIdle(page);
	await expect(page.locator('.app-root')).toHaveAttribute('data-runtime', 'ready');
	await expect(statusTrigger(page)).toBeEnabled();
	await expect(barWrite(page)).not.toHaveAttribute('aria-disabled');
	expect(urls.some((url) => url.endsWith(`/${runtime.file}`))).toBe(true);
});

test('on a static route the first interaction with the bar loads the runtime at once', async ({
	page
}) => {
	await holdIdle(page);
	await page.goto('/privacidade');
	await idleScheduled(page);
	await expect(page.locator('.app-root')).toHaveAttribute('data-runtime', 'idle');
	await barWrite(page).focus();
	await expect(page.locator('.app-root')).toHaveAttribute('data-runtime', 'ready');
	await expect(statusTrigger(page)).toBeEnabled();
	// Loading never opens anything by itself: no checklist without a click.
	await expect(page.getByRole('dialog', { name: 'Antes de gravar', exact: true })).toHaveCount(0);
});

test('a rescue marker shows the rescue notice on a static route without waiting for idle', async ({
	page
}) => {
	await installHidStub(page);
	await holdIdle(page);
	// A write left in flight by a tab that is gone (no Web Lock is held for it).
	const marker = JSON.stringify({
		at: Date.now() - 120_000,
		crc: 0x1234,
		name: 'Curva interrompida',
		preampDb: -6,
		bands: [],
		device: 'USB DSP Audio',
		tabId: 'tab-that-closed'
	});
	await page.addInitScript((value) => {
		if (sessionStorage.getItem('fux2-seeded') !== null) return;
		sessionStorage.setItem('fux2-seeded', '1');
		localStorage.setItem('oa.cable.inflight', value);
	}, marker);
	await page.goto('/offline');
	const rescue = page.getByRole('region', { name: 'Gravação interrompida', exact: true });
	await expect(rescue).toBeVisible();
	await expect(rescue.getByRole('button', { name: 'Gravar Neutro', exact: true })).toBeVisible();
	// Idle work is still queued: the notice did not wait for it.
	const queued = await page.evaluate(
		() => (Reflect.get(window, '__idleQueue') as IdleRequestCallback[]).length
	);
	expect(queued).toBeGreaterThan(0);
	expect(await page.evaluate(() => localStorage.getItem('oa.cable.inflight'))).toBeNull();
	// The rescue goes through the checklist like any write: nothing is sent before it.
	await rescue.getByRole('button', { name: 'Gravar Neutro', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Antes de gravar', exact: true });
	await expect(dialog).toBeVisible();
	expect(await page.evaluate(() => Reflect.get(window, '__bHid').reports.length)).toBe(0);
});

test('an instrument route mounts the runtime at once, its dependencies fetched in parallel', async ({
	page
}) => {
	const runtime = runtimeChunk();
	await holdIdle(page);
	await page.goto('/cabo');
	await expect(page.locator('.app-root')).toHaveAttribute('data-runtime', 'ready');
	await expect(statusTrigger(page)).toBeEnabled();
	const timings = await page.evaluate(() =>
		performance.getEntriesByType('resource').map((entry) => ({
			path: new URL(entry.name).pathname,
			start: entry.startTime,
			end: (entry as PerformanceResourceTiming).responseEnd
		}))
	);
	const timing = (file: string) => timings.find((entry) => entry.path.endsWith(`/${file}`));
	const chunk = timing(runtime.file);
	expect(chunk, 'the runtime chunk was fetched').toBeDefined();
	for (const dependency of runtime.dependencies) {
		const entry = timing(dependency);
		expect(entry, `${dependency} was fetched`).toBeDefined();
		// No waterfall: every dependency was requested before the runtime chunk had arrived.
		expect(entry?.start ?? Infinity, dependency).toBeLessThanOrEqual(chunk?.end ?? -Infinity);
	}
});

test('the lazy checklist opens from the bar and a simulated write completes', async ({ page }) => {
	await installHidStub(page, { absent: true });
	await page.goto('/cabo');
	await expect(statusTrigger(page)).toBeEnabled();
	await connectCable(page, true);
	await barWrite(page).click();
	const dialog = page.getByRole('dialog', { name: 'Antes de gravar', exact: true });
	await expect(dialog).toBeVisible();
	const write = dialog.getByRole('button', { name: 'Gravar (simulado)', exact: true });
	await expect(write).toBeDisabled();
	await confirmBasics(dialog);
	await expect(write).toBeEnabled();
	await write.click();
	await expect(dialog.getByRole('status')).toHaveText(
		/^Gravação simulada concluída\..*Nada foi enviado a um cabo\.$/
	);
	await closeChecklist(dialog);
	expect(await page.evaluate(() => Reflect.get(window, '__bHid').reports.length)).toBe(0);
});

test('after a first visit, the runtime chunks are cached: editor and simulated cable offline', async ({
	page,
	context
}) => {
	await installHidStub(page, { absent: true });
	await page.goto('/');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (navigator.serviceWorker.controller) return;
		await new Promise<void>((resolve) => {
			navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
		});
	});

	await context.setOffline(true);
	await page.reload();
	await expect(page.locator('.app-root')).toHaveAttribute('data-runtime', 'ready');
	await expect(statusTrigger(page)).toBeEnabled();
	// FUX.NAV: a "Carregar no editor" item on desktop, a sheet button on mobile.
	const auri = await barAction(page, 'Padrão Auri');
	await expect(auri).not.toHaveAttribute('aria-disabled');
	await auri.click();

	// A document navigation (like offline.spec.ts): the prerendered page and its chunks come
	// from the precache, and the runtime mounts again from cached chunks.
	await page.goto('/cabo');
	await expect(page.locator('.app-root')).toHaveAttribute('data-runtime', 'ready');
	await connectCable(page, true);
	await barWrite(page).click();
	const dialog = page.getByRole('dialog', { name: 'Antes de gravar', exact: true });
	await expect(dialog).toBeVisible();
	await confirmBasics(dialog);
	await dialog.getByRole('button', { name: 'Gravar (simulado)', exact: true }).click();
	await expect(dialog.getByRole('status')).toHaveText(/^Gravação simulada concluída\./);
	await closeChecklist(dialog);
	// The help dialog and the status popover are lazy too, and also in the offline cache.
	await (await barAction(page, 'Ajuda e atalhos de teclado')).click();
	await expect(page.locator('dialog[open]')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.locator('dialog[open]')).toHaveCount(0);
	await statusTrigger(page).click();
	await expect(page.locator('[data-chrome="status"]')).not.toBeEmpty();
});

test('hydration stays clean across static, auth and instrument routes', async ({ page }) => {
	const problems: string[] = [];
	page.on('console', (message) => {
		if (/hydrat/i.test(message.text())) problems.push(`${message.type()}: ${message.text()}`);
	});
	page.on('pageerror', (error) => {
		if (/hydrat|svelte/i.test(error.message)) problems.push(`pageerror: ${error.message}`);
	});
	for (const path of [
		'/offline',
		'/privacidade',
		'/entrar',
		'/docs',
		'/',
		'/cabo',
		'/biblioteca'
	]) {
		await page.goto(path);
		await expect(page.locator('#main-content')).toBeVisible();
		await expect(statusTrigger(page)).toBeEnabled();
	}
	expect(problems).toEqual([]);
});

test('head hints: three global font preloads, Turnstile preconnect only on auth, nav preload', async ({
	page
}) => {
	const preconnect = page.locator(
		'link[rel="preconnect"][href="https://challenges.cloudflare.com"]'
	);
	const globalFonts = [
		'/fonts/geist/geist-latin-wght-normal.woff2',
		'/fonts/instrument-serif/instrument-serif-latin-400-italic.woff2',
		'/fonts/instrument-serif/instrument-serif-latin-400-normal.woff2'
	];
	await page.goto('/');
	for (const href of globalFonts) {
		await expect(page.locator(`link[rel="preload"][as="font"][href$="${href}"]`)).toHaveCount(1);
	}
	await expect(preconnect).toHaveCount(0);
	// The visible links (inline on desktop, in the menu sheet on mobile).
	const links = (await barScope(page))
		.getByRole('navigation', { name: 'Principal', exact: true })
		.getByRole('link');
	expect(await links.count()).toBeGreaterThan(0);
	for (const link of await links.all()) {
		await expect(link).toHaveAttribute('data-sveltekit-preload-code', 'hover');
	}
	await page.goto('/entrar');
	expect(await preconnect.count()).toBeGreaterThan(0);
	await page.goto('/privacidade');
	await expect(preconnect).toHaveCount(0);
});
