// FUX.P7 (spec §4.5): every term of web/src/lib/comprehension/glossary.ts owns its
// `#g-<term>` anchor in the Docs glossary, and every GlossaryLink target resolves.
// The map is read as text so this spec does not depend on the Paraglide runtime.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openApp, waitForApp } from './helpers/a-app';

const source = readFileSync(
	new URL('../../src/lib/comprehension/glossary.ts', import.meta.url),
	'utf8'
);
const hrefs = [...source.matchAll(/href:\s*'(\/docs#g-[a-z0-9-]+)'/g)].map((match) => match[1]);
const terms = hrefs.map((href) => href.slice('/docs#g-'.length));

test('the glossary map lists the 17 terms of the spec', () => {
	expect(terms).toEqual([
		'gate',
		'envelope',
		'q',
		'preamp',
		's1',
		's5',
		's6',
		's7',
		'ab-nivel',
		'teste-cego',
		'checklist',
		'flash',
		'crc',
		'q27',
		'q23',
		'camadas',
		'neutro'
	]);
});

test('/docs has exactly one anchor per glossary term, inside the Glossary section', async ({
	page
}) => {
	await openApp(page, '/docs');
	for (const term of terms) {
		const anchor = page.locator(`[id="g-${term}"]`);
		await expect(anchor, term).toHaveCount(1);
		await expect(page.locator(`#glossario [id="g-${term}"]`), term).toHaveCount(1);
		await expect(anchor.locator('dt'), term).not.toHaveText(/^\s*$/);
		await expect(anchor.locator('dd'), term).not.toHaveText(/^\s*$/);
	}
	// In-page links that point into the glossary resolve too.
	const internal = await page
		.locator('a[href^="#g-"], a[href^="/docs#g-"]')
		.evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
	for (const href of internal) {
		const id = href.slice(href.indexOf('#') + 1);
		await expect(page.locator(`[id="${id}"]`), href).toHaveCount(1);
	}
});

/** Every page tour dismissed (the `oa.tour.v1` contract): nothing auto-opens over the controls. */
const TOURS_DISMISSED = JSON.stringify({
	curva: 'dispensado',
	comunidade: 'dispensado',
	cabo: 'dispensado',
	'soe-como-x': 'dispensado',
	comparar: 'dispensado',
	'teste-cego': 'dispensado',
	biblioteca: 'dispensado'
});

// Operator bug: from a Curva explainer, "Ver no glossário" navigated client-side to
// /docs#g-camadas, but the page kept moving after the router's hash scroll (fonts, the
// two-column glossary rebalancing) and the term ended 360px above the viewport.
test('"Ver no glossário" from the Curva lands on the term under the bar and stays there', async ({
	page
}) => {
	await page.addInitScript((value) => {
		// Only real documents have a storage of the app's origin (not about:blank).
		if (location.protocol.startsWith('http')) localStorage.setItem('oa.tour.v1', value);
	}, TOURS_DISMISSED);
	// Hydrated first: a press on the prerendered trigger before mount does nothing.
	await openApp(page, '/');
	const trigger = page
		.getByRole('button', {
			name: /^(?:O que é isso\?|What is this\?) (?:Camadas do editor|Editor layers)$/
		})
		.first();
	await trigger.click();
	// The explanation opens once its lazy panel chunk has loaded (FUX.B): wait for it.
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	const panel = page.getByRole('dialog', { name: /^(?:Camadas do editor|Editor layers)$/ });
	await expect(panel).toBeVisible();
	const link = panel.getByRole('link', { name: /^(?:Ver no glossário|View in glossary)$/ });
	await expect(link).toBeVisible();
	await expect(link).toHaveAttribute('href', '/docs#g-camadas');
	await link.click();
	await page.waitForURL(/\/docs#g-camadas$/);

	const target = page.locator('[id="g-camadas"]');
	await expect(target).toHaveCount(1);
	const placement = () =>
		target.evaluate((element) => ({
			top: element.getBoundingClientRect().top,
			bar: document.querySelector('[data-chrome="bar"]')?.getBoundingClientRect().bottom ?? 0,
			viewport: window.innerHeight
		}));
	const underTheBar = async () => {
		const { top, bar, viewport } = await placement();
		return top >= bar - 1 && top < viewport;
	};
	await expect.poll(underTheBar, { timeout: 8000 }).toBe(true);
	// Still in place once the Docs fonts have loaded and layout has settled (the bug's shift).
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
	await expect.poll(underTheBar, { timeout: 8000 }).toBe(true);
	const { top, bar, viewport } = await placement();
	expect(top).toBeGreaterThanOrEqual(bar - 1);
	expect(top).toBeLessThan(viewport);
	// Client-side arrival: pushState does not update `:target`, so the page marks the term.
	await expect(target).toHaveClass(/\bis-target\b/);
});

for (const href of hrefs) {
	test(`GlossaryLink target ${href} resolves and scrolls into view`, async ({ page }) => {
		await page.goto(href);
		const id = href.slice(href.indexOf('#') + 1);
		const target = page.locator(`[id="${id}"]`);
		// In the prerendered HTML…
		await expect(target).toHaveCount(1);
		// …and still after hydration and the app mount: a client error on a deep link (scrolled
		// at mount) used to swap the whole page for the 500 page, which a fast check missed.
		await waitForApp(page);
		await page.evaluate(async () => {
			await document.fonts.ready;
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		});
		await expect(page.locator('#glossario')).toHaveCount(1);
		await expect(target).toHaveCount(1);
		await expect(target).toBeInViewport();
		expect(await target.evaluate((element) => element.matches(':target'))).toBe(true);
		await expect(target).toHaveClass(/\bis-target\b/);
	});
}
