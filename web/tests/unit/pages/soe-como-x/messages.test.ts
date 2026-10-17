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

/** FUX.P3 copy: staging before the merge, the merged catalog after it. */
function fux(locale: string): Record<string, string> {
	const staging = new URL(`../../../../messages/_staging/FUX.P3.${locale}.json`, import.meta.url);
	const merged = new URL(`../../../../messages/${locale}.json`, import.meta.url);
	const parsed: Record<string, string> = JSON.parse(
		readFileSync(existsSync(staging) ? staging : merged, 'utf8')
	);
	return Object.fromEntries(Object.entries(parsed).filter(([key]) => key.startsWith('soe_fux_')));
}

test('FUX.P3 copy: same keys and variables, exact literals, no em dash, no plan codes', () => {
	const pt = fux('pt-BR');
	const en = fux('en-US');
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	expect(Object.keys(pt).length).toBeGreaterThan(25);
	const fields = (value: string) =>
		[...value.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();
	for (const key of Object.keys(pt)) expect(fields(pt[key]), key).toEqual(fields(en[key]));
	expect(pt.soe_fux_solve_reason).toBe('Escolha uma medição e um alvo');
	expect(pt.soe_fux_paste).toBe('Colar texto');
	expect(pt.soe_fux_retry).toBe('Tentar de novo');
	expect(pt.soe_fux_tech).toBe('Ver detalhes técnicos');
	expect(pt.soe_fux_method).toContain('AutoEq (projeto aberto, licença MIT)');
	expect(pt.soe_fux_method).toContain('o solver só aproxima, quem decide é o gate');
	for (const value of [...Object.values(pt), ...Object.values(en)]) {
		expect(value.trim()).not.toBe('');
		expect(value).not.toMatch(/\b(?:FIELD \d+|[SCDTF]\d{1,2})\b|GATE v2|Q27|Q23/);
	}
	for (const value of Object.values(pt)) expect(value).not.toContain('—');
	// The fixed copy this page shows keeps its exact wording (plan §3.5).
	const page = messages('pt-BR');
	expect(page.soe_method_title).toBe('O solver aproxima. O gate decide.');
	expect(page.soe_gate_note).toBe(
		'Envelope observado nos presets oficiais, não uma prova de segurança do hardware.'
	);
	expect(page.soe_use_note).toBe('Carrega somente no editor. Não grava no cabo.');
});
