import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { REASON_CODES, REASON_MESSAGE_KEYS } from '#lib/components/pages/curva/reasons.ts';

const root = new URL('../../../../', import.meta.url);

function messages(locale: string): Record<string, string> {
	const staging = new URL(`messages/_staging/T2.10.${locale}.json`, root);
	const merged = new URL(`messages/${locale}.json`, root);
	return JSON.parse(readFileSync(existsSync(staging) ? staging : merged, 'utf8')) as Record<
		string,
		string
	>;
}

const pt = messages('pt-BR');
const en = messages('en-US');
const curvaKeys = (catalog: Record<string, string>) =>
	Object.keys(catalog)
		.filter((key) => key.startsWith('curva_'))
		.sort();

function usedKeys(): string[] {
	const dir = new URL('src/lib/components/pages/curva/', root);
	const used = new Set<string>();
	for (const file of readdirSync(dir)) {
		const source = readFileSync(new URL(file, dir), 'utf8');
		for (const match of source.matchAll(/\bm\.(curva_\w+)\(/g)) {
			if (match[1]) used.add(match[1]);
		}
	}
	return [...used].sort();
}

const variables = (text: string) =>
	[...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('Curva messages', () => {
	test('pt-BR and en-US have the same curva_ keys and the same variables', () => {
		expect(curvaKeys(pt)).toEqual(curvaKeys(en));
		for (const key of curvaKeys(pt)) {
			expect(variables(en[key] ?? ''), key).toEqual(variables(pt[key] ?? ''));
		}
	});

	test('every message used by the page exists', () => {
		const keys = new Set(curvaKeys(pt));
		for (const key of usedKeys()) expect(keys.has(key), key).toBe(true);
	});

	test('every gate reason code has a plain-language message in both locales', () => {
		expect(REASON_CODES).toHaveLength(15);
		for (const code of REASON_CODES) {
			const key = REASON_MESSAGE_KEYS[code];
			expect(pt[key], key).toBeTruthy();
			expect(en[key], key).toBeTruthy();
		}
		expect(pt.curva_reason_unknown).toBeTruthy();
	});

	test('pt-BR uses no em dash, a real minus and decimal commas in limits', () => {
		for (const key of curvaKeys(pt)) {
			expect(pt[key], key).not.toContain('—');
			expect(en[key], key).not.toContain('—');
		}
		expect(pt.curva_reason_d_prefix_peak).toContain('−0,20 dB');
		expect(en.curva_reason_d_prefix_peak).toContain('−0.20 dB');
		expect(pt.curva_preset_kuba).toBe('descrição da Kuba');
		expect(pt.curva_preset_license).toBe('licença: a confirmar');
	});
});
