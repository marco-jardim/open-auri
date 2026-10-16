import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

function messages(locale: string): Record<string, string> {
	const staging = new URL(`../../../../messages/_staging/T2.12.${locale}.json`, import.meta.url);
	const merged = new URL(`../../../../messages/${locale}.json`, import.meta.url);
	const contents: Record<string, string> = JSON.parse(
		readFileSync(existsSync(staging) ? staging : merged, 'utf8')
	);
	return Object.fromEntries(
		Object.entries(contents).filter(([key]) => key.startsWith('comparar_'))
	);
}

test('both catalogs have matching comparar_ keys and complete nonempty copy', () => {
	const pt = messages('pt-BR');
	const en = messages('en-US');
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	expect(Object.keys(pt).length).toBeGreaterThan(80);
	expect(Object.values(pt).every((value) => value.trim().length > 0)).toBe(true);
	expect(Object.values(en).every((value) => value.trim().length > 0)).toBe(true);
	expect(Object.values(pt).join(' ')).not.toContain('—');
	expect(pt.comparar_reason_preamp).toContain('−25,5');
	expect(en.comparar_reason_preamp).toContain('−25.5');
});
