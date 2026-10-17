// FUX.Q1 round 1: the reasons of controls that cannot act now (T8). Same keys in both locales,
// plain copy: no pt-BR em dash and no plan codes in what users read. Read from the staging file
// until it is merged, then from the merged messages.
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

function messages(locale: 'pt-BR' | 'en-US'): Record<string, string> {
	const staging = new URL(`../../../messages/_staging/FUXQ1.${locale}.json`, import.meta.url);
	const merged = new URL(`../../../messages/${locale}.json`, import.meta.url);
	const contents: Record<string, string> = JSON.parse(
		readFileSync(existsSync(staging) ? staging : merged, 'utf8')
	);
	return Object.fromEntries(Object.entries(contents).filter(([key]) => key.startsWith('fuxq1_')));
}

test('FUXQ1 reasons exist in both locales with the same keys and plain copy', () => {
	const pt = messages('pt-BR');
	const en = messages('en-US');
	expect(Object.keys(pt).sort()).toEqual([
		'fuxq1_queue_select_two',
		'fuxq1_scope_b_listening',
		'fuxq1_tape_slow_running'
	]);
	expect(Object.keys(en).sort()).toEqual(Object.keys(pt).sort());
	for (const [key, value] of [...Object.entries(pt), ...Object.entries(en)]) {
		expect(value.trim(), key).not.toBe('');
		expect(value, key).not.toMatch(/\b(?:S\d+|T\d+(?:\.\d+)?|F\d+|FUX\w*)\b/);
	}
	for (const [key, value] of Object.entries(pt)) expect(value, key).not.toMatch(/[—–]/);
});
