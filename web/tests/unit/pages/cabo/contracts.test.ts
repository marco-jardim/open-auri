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
	// The page's only write path; a YOLO entry passes its profile so the shared checklist
	// judges it with the YOLO gate and its per-write confirmation.
	expect(page).toMatch(/\bapp\?\.requestWrite\(/);
	expect(page).not.toMatch(/\bapp\??\.cable\.write\b/);
	expect(page).toContain('onclick={() => app?.cable.connect()}');
	// FUX.P6: the rack only lists cables (U7); queue selection and confirmation live only in
	// the shared checklist, so the page renders no queue component at all.
	expect(all).not.toContain('<MultiCableQueue');
	expect(all).not.toMatch(/\bwriteQueue\b|\bconfirmations=\{\{/);
	// The WebHID picker call is shown as code text (U1), never called from the page.
	expect(page).toContain('<span class="fn">requestDevice</span');
	expect(all).not.toMatch(/\.(?:write|writeQueue|createGesture|sendReport|requestDevice)\s*\(/);
	expect(all).not.toMatch(/\b(?:writeCurve|writeMany|createCableService|createClientApp)\s*\(/);
	// Read cable, firmware and blind test on the cable; the RAM slot points to "Ouvir no cabo".
	expect(page.match(/<EmBreve\s/g)).toHaveLength(3);
	expect(page).not.toContain('<EmBreve title={m.cabo_ram()}');
	expect(all).not.toContain('{@html');
	expect(all).not.toMatch(/double.?d|duplo.?d|(?:logo|brand|symbol)[^\n]*Dolby/i);
});

test('tour targets, explainers and the progress contract are wired on the page', () => {
	const page = source('CaboPage.svelte');
	const targets = ['cabo-connect', 'cabo-bytes', 'cabo-checklist', 'cabo-tape', 'cabo-journal'];
	for (const target of targets) expect(page).toContain(`data-tour="${target}"`);
	for (const term of ['checklist', 'crc', 'q27', 'q23', 'gate', 'flash']) {
		expect(page).toContain(`<Explainer term="${term}" />`);
	}
	expect(page).toContain('<Tour page="cabo"');
	expect(page).toContain('<TourTrigger page="cabo" />');
	// Live tape progress is only read from the service's events, never produced here.
	expect(source('model.ts')).toContain("CABLE_PROGRESS_EVENT = 'cable:progress'");
	expect(page).not.toMatch(/dispatchEvent\s*\(/);
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
