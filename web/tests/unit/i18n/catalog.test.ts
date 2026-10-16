import { expect, test } from 'vitest';
import ptBR from '../../../messages/pt-BR.json';
import enUS from '../../../messages/en-US.json';

const portuguese: Record<string, string> = ptBR;
const english: Record<string, string> = enUS;
const keys = (catalog: Record<string, string>) =>
	Object.keys(catalog)
		.filter((key) => key !== '$schema')
		.sort();
const placeholders = (message: string) => [...new Set(message.match(/\{[^{}]+\}/g) ?? [])].sort();

test('pt-BR and en-US have identical complete message key sets, excluding $schema', () => {
	expect(keys(portuguese)).toEqual(keys(english));
});

test('no pt-BR message value contains an em dash', () => {
	const offendingKeys = Object.entries(portuguese)
		.filter(([, value]) => value.includes('\u2014'))
		.map(([key]) => key);
	expect(offendingKeys).toEqual([]);
});

test('every message has the same placeholder set in pt-BR and en-US', () => {
	for (const key of keys(portuguese)) {
		expect(english, key).toHaveProperty(key);
		expect(placeholders(portuguese[key]), key).toEqual(placeholders(english[key]));
	}
});
