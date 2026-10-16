import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const literal = {
	'pt-BR': 'A nova curva pode soar mais alta. Abaixe o volume antes de gravar.',
	'en-US': 'The new curve may sound louder. Turn the volume down before writing.'
} as const;

function catalog(locale: keyof typeof literal): Record<string, unknown> {
	const path = fileURLToPath(new URL(`../../../../messages/${locale}.json`, import.meta.url));
	const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${locale}.json is not a message object`);
	}
	return parsed as Record<string, unknown>;
}

describe('biblioteca jump warning matches the cable loudness warning literally', () => {
	for (const locale of ['pt-BR', 'en-US'] as const) {
		it(`uses the exact literal in ${locale}`, () => {
			const messages = catalog(locale);
			expect(messages.biblioteca_jump_warning).toBe(literal[locale]);
			expect(messages.cable_loudness_warning).toBe(literal[locale]);
		});
	}
});
