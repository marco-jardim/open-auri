import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const componentRoot = new URL('src/lib/components/pages/cabo/', root);
const source = (file: string) => readFileSync(new URL(file, componentRoot), 'utf8');

function messages(locale: string): Record<string, string> {
	const staging = new URL(`messages/_staging/T2.15.${locale}.json`, root);
	const merged = new URL(`messages/${locale}.json`, root);
	const parsed: Record<string, string> = JSON.parse(
		readFileSync(existsSync(staging) ? staging : merged, 'utf8')
	);
	return Object.fromEntries(Object.entries(parsed).filter(([key]) => key.startsWith('cabo_')));
}

test('both locales cover every Cabo message and obey copy rules', () => {
	const pt = messages('pt-BR');
	const en = messages('en-US');
	const files = readdirSync(fileURLToPath(componentRoot)).filter((file) =>
		file.endsWith('.svelte')
	);
	const used = files.flatMap((file) =>
		[...source(file).matchAll(/m\.(cabo_\w+)\(/g)].map((match) => match[1])
	);
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	expect(Object.keys(pt).length).toBeGreaterThan(70);
	expect(used.every((key) => typeof pt[key] === 'string' && typeof en[key] === 'string')).toBe(
		true
	);
	expect(Object.values(pt).join('\n')).not.toContain('—');
	expect(Object.values(pt).join('\n')).not.toMatch(/Honest note:|Just \w+\. Just /);
});

test('only the shared app checklist can authorize page writes; connection remains click-only', () => {
	const page = source('CaboPage.svelte');
	const all = readdirSync(fileURLToPath(componentRoot))
		.filter((file) => /\.(svelte|ts)$/.test(file))
		.map(source)
		.join('\n');
	expect(page).toContain('app?.requestWrite()');
	expect(page).toContain('onclick={() => app?.cable.connect()}');
	expect(page).toContain('<MultiCableQueue');
	expect(page).toContain('canWrite={false}');
	expect(all).not.toMatch(/\.(?:write|writeQueue|createGesture|sendReport|requestDevice)\s*\(/);
	expect(all).not.toMatch(/\b(?:writeCurve|writeMany|createCableService|createClientApp)\s*\(/);
	expect(page.match(/<EmBreve\s/g)).toHaveLength(4);
	expect(all).not.toContain('{@html');
	expect(all).not.toMatch(/double.?d|duplo.?d|(?:logo|brand|symbol)[^\n]*Dolby/i);
});

test('route uses only the layout-owned app context', () => {
	const route = readFileSync(new URL('src/routes/cabo/+page.svelte', root), 'utf8');
	expect(route).toContain('getAppContext()');
	expect(route).toContain('$derived(context.client)');
	expect(route).not.toMatch(/onMount|createClientApp|createCableService|\.connect\(/);
});

test('browser fixtures and Cabo components cannot navigate the Vitest runner', () => {
	const components = readdirSync(fileURLToPath(componentRoot))
		.filter((file) => /\.(svelte|ts)$/.test(file))
		.map(source);
	const testsRoot = new URL('./', import.meta.url);
	const browserTests = readdirSync(fileURLToPath(testsRoot))
		.filter((file) => file.endsWith('.svelte') || file.endsWith('.svelte.test.ts'))
		.map((file) => readFileSync(new URL(file, testsRoot), 'utf8'));
	const all = [...components, ...browserTests].join('\n');
	const localeChanges = [...all.matchAll(/\bsetLocale\(([^;]+)\);/g)];
	expect(localeChanges.length).toBeGreaterThan(0);
	for (const change of localeChanges) expect(change[1]).toMatch(/\{\s*reload:\s*false\s*\}/);
	expect(all).not.toMatch(/\blocation\b|\bgoto\s*\(|<form\b|\.(?:submit|requestSubmit)\s*\(/);
});
