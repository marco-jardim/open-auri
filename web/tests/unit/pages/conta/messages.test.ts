// Message catalog of the account area (staging T3.7, or the merged catalog after the merge):
// same keys in both locales, `conta_` prefix, same interpolation fields, no em dash in pt-BR, and
// every `m.conta_*` used by the account components and routes exists.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const WEB = fileURLToPath(new URL('../../../../', import.meta.url));

function catalog(locale: string): Record<string, string> {
	const staging = join(WEB, 'messages', '_staging', `T3.7.${locale}.json`);
	const merged = join(WEB, 'messages', `${locale}.json`);
	const messages = JSON.parse(
		readFileSync(existsSync(staging) ? staging : merged, 'utf8')
	) as Record<string, string>;
	return Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith('conta_')));
}

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.(svelte|ts)$/.test(name) ? [readFileSync(path, 'utf8')] : [];
	});
}

test('both locales have the same conta_ keys and interpolation fields', () => {
	const pt = catalog('pt-BR');
	const en = catalog('en-US');
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	expect(Object.keys(pt).length).toBeGreaterThan(100);
	for (const [key, value] of Object.entries(pt)) {
		expect(value, key).not.toContain('—');
		expect(value.trim(), key).not.toBe('');
		expect(en[key]?.trim(), key).not.toBe('');
		const fields = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
		expect(fields(value), key).toEqual(fields(en[key] ?? ''));
	}
});

test('every m.conta_* used by the account area exists', () => {
	const pt = catalog('pt-BR');
	const code = [
		...sources(join(WEB, 'src', 'lib', 'components', 'account')),
		...sources(join(WEB, 'src', 'routes', 'conta'))
	].join('\n');
	const used = new Set([...code.matchAll(/\bm\.(conta_\w+)\(/g)].map((match) => match[1] ?? ''));
	expect(used.size).toBeGreaterThan(50);
	for (const key of used) expect(pt[key], key).toBeTruthy();
});

test('the bio is never rendered as HTML', () => {
	const code = [
		...sources(join(WEB, 'src', 'lib', 'components', 'account')),
		...sources(join(WEB, 'src', 'routes', 'conta'))
	].join('\n');
	expect(code).not.toContain('{@html');
});
