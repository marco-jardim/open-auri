// FUX.P7 (spec §4.5): every term of web/src/lib/comprehension/glossary.ts owns its
// `#g-<term>` anchor in the Docs glossary, and every GlossaryLink target resolves.
// The map is read as text so this spec does not depend on the Paraglide runtime.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

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
	await page.goto('/docs');
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

for (const href of hrefs) {
	test(`GlossaryLink target ${href} resolves and scrolls into view`, async ({ page }) => {
		await page.goto(href);
		const id = href.slice(href.indexOf('#') + 1);
		const target = page.locator(`[id="${id}"]`);
		await expect(target).toHaveCount(1);
		await expect(target).toBeInViewport();
		expect(await target.evaluate((element) => element.matches(':target'))).toBe(true);
	});
}
