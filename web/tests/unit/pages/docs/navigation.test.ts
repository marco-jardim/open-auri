import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('Docs controls and their component tests never reload or navigate the runner document', () => {
	const files = [
		'../../../../src/routes/docs/+page.svelte',
		'../../../../src/lib/components/pages/docs/DocsPage.svelte',
		'../../../../src/lib/components/pages/docs/SearchDialog.svelte',
		'../../../../src/lib/components/pages/docs/clear-local-data.ts',
		'./docs.svelte.test.ts'
	];
	for (const file of files) {
		const source = readFileSync(new URL(file, import.meta.url), 'utf8');
		expect(source, file).not.toMatch(/\blocation\s*\.\s*(?:reload|assign|replace)\s*\(/);
		expect(source, file).not.toMatch(/\blocation\s*(?:\.\s*(?:href|hash))?\s*=(?!=)/);
		expect(source, file).not.toMatch(/\bhistory\s*\.\s*(?:pushState|replaceState)\s*\(/);
		expect(source, file).not.toMatch(/\bgoto\s*\(/);
		for (const call of source.matchAll(/\bsetLocale\([^;]+?\)/g)) {
			expect(call[0], file).toMatch(/reload:\s*false/);
		}
	}
});
