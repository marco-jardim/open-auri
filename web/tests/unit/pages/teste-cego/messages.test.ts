import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

function catalog(locale: string): Record<string, string> {
	const staging = fileURLToPath(
		new URL(`../../../../messages/_staging/T2.14.${locale}.json`, import.meta.url)
	);
	const merged = fileURLToPath(new URL(`../../../../messages/${locale}.json`, import.meta.url));
	const messages = JSON.parse(
		readFileSync(existsSync(staging) ? staging : merged, 'utf8')
	) as Record<string, string>;
	const qa = fileURLToPath(
		new URL(`../../../../messages/_staging/QA1TC.${locale}.json`, import.meta.url)
	);
	if (existsSync(qa)) Object.assign(messages, JSON.parse(readFileSync(qa, 'utf8')));
	return Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith('cego_')));
}

test('both locales cover every page key and use the same interpolation fields', () => {
	const pt = catalog('pt-BR'),
		en = catalog('en-US');
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	expect(Object.keys(pt).length).toBeGreaterThan(80);
	for (const [key, value] of Object.entries(pt)) {
		expect(value).not.toContain('—');
		expect(value.match(/\{\w+\}/g) ?? []).toEqual(en[key]?.match(/\{\w+\}/g) ?? []);
		expect(en[key]?.length).toBeGreaterThan(0);
	}
	const component = readFileSync(
		fileURLToPath(
			new URL('../../../../src/lib/components/pages/teste-cego/BlindTest.svelte', import.meta.url)
		),
		'utf8'
	);
	const room = readFileSync(
		fileURLToPath(
			new URL(
				'../../../../src/lib/components/pages/teste-cego/ListeningRoom.svelte',
				import.meta.url
			)
		),
		'utf8'
	);
	const meter = readFileSync(
		fileURLToPath(
			new URL(
				'../../../../src/lib/components/pages/teste-cego/CandidateMeter.svelte',
				import.meta.url
			)
		),
		'utf8'
	);
	const stage = readFileSync(
		fileURLToPath(
			new URL('../../../../src/lib/components/pages/teste-cego/Stage.svelte', import.meta.url)
		),
		'utf8'
	);
	for (const match of `${component}\n${room}\n${meter}\n${stage}`.matchAll(/m\.(cego_\w+)\(/g)) {
		expect(pt[match[1]!], match[1]).toBeTruthy();
	}
});

test('the page has no transport write or submission API', () => {
	const source = ['BlindTest.svelte', 'experiment.ts', 'preview.ts']
		.map((file) =>
			readFileSync(
				fileURLToPath(
					new URL(`../../../../src/lib/components/pages/teste-cego/${file}`, import.meta.url)
				),
				'utf8'
			)
		)
		.join('\n');
	expect(source).not.toMatch(
		/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|writeCurve|requestWrite|createGesture)\s*\(/
	);
	expect(source).not.toContain('open-auri/transport');
});

test('the feature never navigates imperatively and every browser-test locale change disables reload', () => {
	const sources = [
		'../../../../src/routes/teste-cego/+page.svelte',
		...['BlindTest.svelte', 'CandidateMeter.svelte', 'ListeningRoom.svelte'].map(
			(file) => `../../../../src/lib/components/pages/teste-cego/${file}`
		),
		'./page.svelte.test.ts'
	].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));
	for (const source of sources) {
		expect(source).not.toMatch(/\bgoto\s*\(|\blocation\s*\.\s*(?:assign|replace|reload)\s*\(/);
		expect(source).not.toMatch(/\blocation\s*(?:\.\s*\w+\s*)?=/);
		expect(source).not.toMatch(/<form\b/);
		for (const call of source.match(/\bsetLocale\([^;]+?\);/g) ?? []) {
			expect(call).toMatch(/,\s*\{\s*reload:\s*false\s*\}\s*\)/);
		}
	}
});
