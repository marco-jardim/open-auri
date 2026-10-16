import { expect, test } from 'vitest';
import { legalContent } from '#lib/content/docs/legal-content.ts';
import {
	LEGAL_KEYS,
	fillLegalText,
	parseLegalMarkdown,
	publicLegalValues,
	resolveLegalDocument,
	type PublicLegalValues
} from '#lib/content/docs/legal.ts';

const values: PublicLegalValues = {
	PUBLIC_ORIGIN: 'https://example.invalid',
	PUBLIC_LGPD_CONTROLLER: 'TEST_CONTROLLER',
	PUBLIC_LGPD_CONTACT_EMAIL: 'privacy@example.invalid',
	PUBLIC_LGPD_CNPJ: 'TEST_REGISTRATION',
	PUBLIC_LGPD_ADDRESS: 'TEST_ADDRESS',
	PUBLIC_LGPD_DPO_NAME: 'TEST_DPO',
	PUBLIC_POLICY_EFFECTIVE_DATE: '2026-10-15'
};

for (const locale of ['pt-BR', 'en-US'] as const) {
	for (const kind of ['privacy', 'terms'] as const) {
		test(`${kind} ${locale} retains placeholders in content and fills every operator field only from props`, () => {
			const template = legalContent(kind, locale);
			const source = JSON.stringify(template);
			for (const key of LEGAL_KEYS) {
				expect(source).toContain(`{{${key}}}`);
				expect(source).not.toContain(values[key]);
			}
			expect(source).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
			expect(source).not.toMatch(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
			const rendered = JSON.stringify(resolveLegalDocument(template, values));
			expect(rendered).not.toContain('{{PUBLIC_');
			for (const value of Object.values(values)) expect(rendered).toContain(value);
			expect(JSON.stringify(template)).toBe(source);
			if (kind === 'privacy')
				expect(template.blocks.filter((block) => block.kind === 'heading')).toHaveLength(23);
		});
	}
}

test('missing configuration fails closed with a key name only; unknown placeholders are rejected', () => {
	expect(publicLegalValues(values)).toEqual(values);
	expect(() => publicLegalValues({ PUBLIC_ORIGIN: values.PUBLIC_ORIGIN })).toThrow(
		'PUBLIC_LGPD_CONTROLLER'
	);
	expect(() => fillLegalText('{{PUBLIC_UNKNOWN}}', values)).toThrow('Unknown legal placeholder');
	expect(fillLegalText('Controller: {{PUBLIC_LGPD_CONTROLLER}}', values)).toBe(
		'Controller: TEST_CONTROLLER'
	);
});

test('versioned markdown becomes structured safe data, with tables, lists and no HTML evaluation', () => {
	const parsed = parseLegalMarkdown(
		'<!-- private comment -->\n# Title\n\n## Section\n\n> - item\n\n| A | B |\n|---|---|\n| x | y |\n\n<script>alert(1)</script>',
		'en-US'
	);
	expect(parsed.title).toBe('Title');
	expect(parsed.blocks).toEqual([
		{ kind: 'heading', text: 'Section' },
		{ kind: 'list', items: ['item'] },
		{
			kind: 'table',
			rows: [
				['A', 'B'],
				['x', 'y']
			]
		},
		{ kind: 'paragraph', text: '<script>alert(1)</script>' }
	]);
});
