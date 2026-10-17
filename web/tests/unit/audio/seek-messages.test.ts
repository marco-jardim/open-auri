// SEEK.1 copy: same keys in both locales, literal texts, no pt-BR em dash, no plan codes.
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

function messages(locale: string): Record<string, string> {
	const staging = new URL(`../../../messages/_staging/SEEK.1.${locale}.json`, import.meta.url);
	const merged = new URL(`../../../messages/${locale}.json`, import.meta.url);
	const contents: Record<string, string> = JSON.parse(
		readFileSync(existsSync(staging) ? staging : merged, 'utf8')
	);
	return Object.fromEntries(
		Object.entries(contents).filter(([key]) => key.startsWith('transport_'))
	);
}

test('transport messages match in both locales, with the literal pt-BR texts', () => {
	const pt = messages('pt-BR');
	const en = messages('en-US');
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	expect(Object.keys(pt).length).toBeGreaterThanOrEqual(17);
	for (const [key, value] of Object.entries(pt)) {
		expect(value.trim(), key).not.toBe('');
		expect(value, key).not.toContain('—');
		expect(value, key).not.toMatch(/\b(?:S\d+|T\d+(?:\.\d+)?|F\d+|SEEK\.\d)\b/);
	}
	for (const value of Object.values(en)) expect(value.trim()).not.toBe('');
	expect(pt.transport_valuetext).toBe('{elapsed} de {total}');
	expect(pt.transport_restart).toBe('Voltar ao início');
	expect(pt.transport_noise).toBe('ruído rosa · contínuo');
	expect(pt.transport_play).toBe('Tocar');
	expect(pt.transport_pause).toBe('Pausar');
	expect(en.transport_valuetext).toBe('{elapsed} of {total}');
});
