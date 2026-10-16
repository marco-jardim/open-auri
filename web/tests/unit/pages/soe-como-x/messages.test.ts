import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

function messages(locale: string): Record<string, string> {
	const staging = new URL(`../../../../messages/_staging/T2.13.${locale}.json`, import.meta.url);
	const merged = new URL(`../../../../messages/${locale}.json`, import.meta.url);
	const parsed: Record<string, string> = JSON.parse(
		readFileSync(existsSync(staging) ? staging : merged, 'utf8')
	);
	return Object.fromEntries(Object.entries(parsed).filter(([key]) => key.startsWith('soe_')));
}

test('matching soe_ locales, visible AutoEq credit and copy rules', () => {
	const pt = messages('pt-BR');
	const en = messages('en-US');
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	expect(Object.keys(pt).length).toBeGreaterThan(70);
	expect(pt.soe_data_credit).toBe('dados: AutoEq (MIT)');
	expect(en.soe_data_credit).toBe('data: AutoEq (MIT)');
	for (const value of Object.values(pt)) {
		expect(value.trim()).not.toBe('');
		expect(value).not.toContain('—');
	}
	for (const value of Object.values(en)) expect(value.trim()).not.toBe('');
});
