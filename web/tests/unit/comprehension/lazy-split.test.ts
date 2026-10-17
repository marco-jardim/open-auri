import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { explainerHeadings, type ExplainerId } from '#lib/comprehension/explainer-titles.ts';
import { explainers } from '#lib/comprehension/explainers.ts';

// FUX.B: pages keep only triggers and titles in their initial JS; prose loads with the panels.
const source = (name: string) =>
	readFileSync(
		new URL(`../../../src/lib/components/comprehension/${name}`, import.meta.url),
		'utf8'
	);

test('eager headings and lazy bodies cover the same explainers with the same term and title', () => {
	const ids = Object.keys(explainerHeadings) as ExplainerId[];
	expect(Object.keys(explainers).sort()).toEqual([...ids].sort());
	for (const id of ids) {
		expect(explainers[id].term).toBe(explainerHeadings[id].term);
		expect(explainers[id].title).toBe(explainerHeadings[id].title);
		expect(explainers[id].anchor).toBe(`/docs#g-${explainerHeadings[id].term}`);
	}
});

test('the page-facing barrel and the eager hosts never import the prose registries', () => {
	const barrel = source('index.ts');
	expect(barrel).not.toMatch(/export \{[^}]*\btourSteps\b/);
	expect(barrel).not.toContain("from '#lib/comprehension/explainers.ts'");
	const tour = source('Tour.svelte');
	expect(tour).not.toMatch(/import \{[^}]*\btourSteps\b/);
	expect(tour).toContain("import type { TourPage } from '#lib/comprehension/steps.ts'");
	expect(source('TourTrigger.svelte')).not.toMatch(/import \{[^}]*\btourSteps\b/);
	expect(source('Explainer.svelte')).not.toContain("from '#lib/comprehension/explainers.ts'");
	// The panels are dynamic imports, one shared loader each.
	const panels = source('panels.ts');
	expect(panels).toContain("import('./TourPanel.svelte')");
	expect(panels).toContain("import('./ExplainerPanel.svelte')");
	expect(source('TourPanel.svelte')).toContain('tourSteps[page]');
	expect(source('ExplainerPanel.svelte')).toContain('explainers[term]');
});
