import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

function messages(locale: string): Record<string, string> {
	const staging = new URL(`../../../../messages/_staging/T2.11.${locale}.json`, import.meta.url);
	const merged = new URL(`../../../../messages/${locale}.json`, import.meta.url);
	const values: Record<string, string> = JSON.parse(
		readFileSync(existsSync(staging) ? staging : merged, 'utf8')
	);
	const vu = new URL(`../../../../messages/_staging/BIBVU.${locale}.json`, import.meta.url);
	if (existsSync(vu)) Object.assign(values, JSON.parse(readFileSync(vu, 'utf8')));
	return Object.fromEntries(
		Object.entries(values).filter(([key]) => key.startsWith('biblioteca_'))
	);
}

test('both locales supply all Biblioteca copy and obey the publication copy rules', () => {
	const pt = messages('pt-BR');
	const en = messages('en-US');
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	expect(Object.keys(pt).length).toBeGreaterThan(80);
	expect(Object.values(pt).every((text) => text.length > 0 && !text.includes('—'))).toBe(true);
	expect(Object.values(en).every((text) => text.length > 0)).toBe(true);
	expect(pt.biblioteca_title).toBe('Biblioteca');
	expect(en.biblioteca_title).toBe('Library');
	expect(pt.biblioteca_license).toBe('licença: a confirmar');
	for (const file of ['Biblioteca.svelte', 'MeterBridge.svelte', 'TrackSheet.svelte']) {
		const source = readFileSync(
			new URL(`../../../../src/lib/components/pages/biblioteca/${file}`, import.meta.url),
			'utf8'
		);
		for (const key of source.matchAll(/m\.(biblioteca_[a-z0-9_]+)/g)) {
			expect(pt[key[1]], `${file}: ${key[1]}`).toBeDefined();
		}
	}
});

test('the bridge explains pre-volume metering and the calculated jump in both locales', () => {
	expect(messages('pt-BR').biblioteca_live_note).toContain('antes do volume');
	expect(messages('pt-BR').biblioteca_live_note).toContain('Salto continua calculado');
	expect(messages('en-US').biblioteca_live_note).toContain('before browser volume');
	expect(messages('en-US').biblioteca_live_note).toContain('Jump stays calculated');
});
