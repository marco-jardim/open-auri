import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	LegalConfigError,
	OPTIONAL_LEGAL_KEYS,
	REQUIRED_LEGAL_KEYS,
	hasUnsafeCharacters,
	renderLegalDocument,
	renderLegalPage,
	renderLegalText,
	resolveLegalConfig
} from '#lib/content/legal/render.ts';
import {
	POLICY_VERSION,
	isPolicyVersion,
	legalContent,
	type LegalDocument,
	type LegalKey,
	type PublicLegalValues
} from '#lib/content/legal/index.ts';

// Fake operator data only. Real values live in the untracked .env.
const config: PublicLegalValues = {
	PUBLIC_ORIGIN: 'https://exemplo.invalid',
	PUBLIC_LGPD_CONTROLLER: 'Controlador Exemplo',
	PUBLIC_LGPD_CONTACT_EMAIL: 'privacidade@exemplo.invalid',
	PUBLIC_LGPD_CNPJ: 'CNPJ-EXEMPLO',
	PUBLIC_LGPD_ADDRESS: 'Rua Exemplo, 0',
	PUBLIC_LGPD_DPO_NAME: 'Encarregado Exemplo',
	PUBLIC_POLICY_EFFECTIVE_DATE: '2026-10-16'
};
const withoutOptional = {
	...config,
	PUBLIC_LGPD_CNPJ: '',
	PUBLIC_LGPD_ADDRESS: '  ',
	PUBLIC_LGPD_DPO_NAME: ''
};

const noop = () => undefined;
function thrown(action: () => unknown): unknown {
	try {
		action();
	} catch (caught) {
		return caught;
	}
	return undefined;
}
const texts = (document: LegalDocument) =>
	document.blocks.flatMap((block) =>
		block.kind === 'list' ? block.items : block.kind === 'table' ? block.rows.flat() : [block.text]
	);
const sectionList = (document: LegalDocument, heading: string) => {
	const start = document.blocks.findIndex(
		(block) => block.kind === 'heading' && block.text.startsWith(heading)
	);
	const block = document.blocks.slice(start + 1).find((candidate) => candidate.kind === 'list');
	return block?.kind === 'list' ? block.items : [];
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('template rendering with every field configured', () => {
	for (const kind of ['privacy', 'terms'] as const) {
		test(`${kind}: fills every placeholder in both locales without warnings`, () => {
			const warn = vi.fn();
			const page = renderLegalPage(kind, config, warn);
			expect(warn).not.toHaveBeenCalled();
			expect(page.kind).toBe(kind);
			expect(page.policyVersion).toBe(POLICY_VERSION);
			expect(page.values).toEqual(config);
			for (const locale of ['pt-BR', 'en-US'] as const) {
				const document = page.documents[locale];
				expect(document.locale).toBe(locale);
				const rendered = JSON.stringify(document);
				expect(rendered).not.toContain('{{');
				for (const value of Object.values(config)) expect(rendered).toContain(value);
			}
		});
	}

	test('the privacy policy keeps its 23 sections and the terms their 9', () => {
		const page = renderLegalPage('privacy', config, noop);
		const terms = renderLegalPage('terms', config, noop);
		for (const locale of ['pt-BR', 'en-US'] as const) {
			const headings = (document: LegalDocument) =>
				document.blocks.filter((block) => block.kind === 'heading').length;
			expect(headings(page.documents[locale])).toBe(23);
			expect(headings(terms.documents[locale])).toBe(9);
		}
	});

	test('the origin is normalized and the default warning sink is console.warn', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
		const trailingSlash = { ...withoutOptional, PUBLIC_ORIGIN: 'https://exemplo.invalid/' };
		const page = renderLegalPage('terms', trailingSlash);
		expect(page.values.PUBLIC_ORIGIN).toBe('https://exemplo.invalid');
		expect(JSON.stringify(page.documents)).not.toContain('invalid//');
		expect(warn).toHaveBeenCalledTimes(OPTIONAL_LEGAL_KEYS.length);
	});
});

describe('empty optional fields', () => {
	test('warn with the key name only and drop the sentences that mention them', () => {
		const warnings: string[] = [];
		const page = renderLegalPage('privacy', withoutOptional, (message) => warnings.push(message));
		expect(warnings).toHaveLength(3);
		for (const key of OPTIONAL_LEGAL_KEYS) {
			expect(warnings.some((warning) => warning.includes(key))).toBe(true);
		}
		expect(sectionList(page.documents['pt-BR'], '1.')).toEqual([
			'**Controlador Exemplo**',
			'Canal de privacidade e do encarregado: **privacidade@exemplo.invalid**'
		]);
		expect(sectionList(page.documents['en-US'], '1.')).toEqual([
			'**Controlador Exemplo**',
			'Privacy and data protection officer (encarregado) channel: **privacidade@exemplo.invalid**'
		]);
		const pt = JSON.stringify(page.documents['pt-BR']);
		const en = JSON.stringify(page.documents['en-US']);
		for (const rendered of [pt, en]) {
			expect(rendered).not.toContain('{{');
			expect(rendered).not.toContain('CNPJ');
		}
		expect(pt).not.toContain('Encarregado:');
		expect(en).not.toContain('Data protection officer:');
	});

	test('in a paragraph only the affected sentences go away', () => {
		const terms = renderLegalPage('terms', withoutOptional, noop);
		const contact = (document: LegalDocument) =>
			texts(document).find((text) => text.includes('/privacidade'));
		expect(contact(terms.documents['pt-BR'])).toBe(
			'O áudio carregado nunca é enviado ao servidor. A política em https://exemplo.invalid/privacidade descreve armazenamento local, cookies essenciais, conta, funções sociais e registros de acesso. Controlador: Controlador Exemplo. Contato de privacidade: privacidade@exemplo.invalid.'
		);
		expect(contact(terms.documents['en-US'])).toBe(
			'Loaded audio is never uploaded. The policy at https://exemplo.invalid/privacidade describes local storage, essential cookies, accounts, social features and access records. Controller: Controlador Exemplo. Privacy contact: privacidade@exemplo.invalid.'
		);
	});

	test('sentence splitting keeps abbreviations such as "art. 7º" and "nº 2" together', () => {
		const omitted = new Set<LegalKey>(['PUBLIC_LGPD_CNPJ']);
		const values = { ...config, PUBLIC_LGPD_CNPJ: '' };
		expect(
			renderLegalText(
				'Base: art. 7º, V. Resolução nº 2/2022. CNPJ: {{PUBLIC_LGPD_CNPJ}}. Fim.',
				values,
				omitted
			)
		).toBe('Base: art. 7º, V. Resolução nº 2/2022. Fim.');
		expect(renderLegalText('CNPJ: {{PUBLIC_LGPD_CNPJ}}', values, omitted)).toBeNull();
		expect(renderLegalText('Sem campo opcional.', values, omitted)).toBe('Sem campo opcional.');
	});

	test('blocks, list items and table rows that become empty are removed', () => {
		const template: LegalDocument = {
			locale: 'pt-BR',
			title: 'Título {{PUBLIC_LGPD_CONTROLLER}}',
			blocks: [
				{ kind: 'heading', text: 'Seção' },
				{ kind: 'paragraph', text: 'Encarregado: {{PUBLIC_LGPD_DPO_NAME}}.' },
				{ kind: 'list', items: ['Endereço: {{PUBLIC_LGPD_ADDRESS}}'] },
				{ kind: 'list', items: ['Fica', 'CNPJ: {{PUBLIC_LGPD_CNPJ}}'] },
				{
					kind: 'table',
					rows: [
						['Campo', 'Valor'],
						['CNPJ', '{{PUBLIC_LGPD_CNPJ}}'],
						['Contato', '{{PUBLIC_LGPD_CONTACT_EMAIL}}']
					]
				},
				{
					kind: 'table',
					rows: [
						['Campo', 'Valor'],
						['Encarregado', '{{PUBLIC_LGPD_DPO_NAME}}']
					]
				}
			]
		};
		const { values, omitted } = resolveLegalConfig(withoutOptional);
		expect(renderLegalDocument(template, values, omitted)).toEqual({
			locale: 'pt-BR',
			title: 'Título Controlador Exemplo',
			blocks: [
				{ kind: 'heading', text: 'Seção' },
				{ kind: 'list', items: ['Fica'] },
				{
					kind: 'table',
					rows: [
						['Campo', 'Valor'],
						['Contato', 'privacidade@exemplo.invalid']
					]
				}
			]
		});
		expect(renderLegalDocument(template, config).blocks).toHaveLength(6);
	});
});

describe('required fields and validation', () => {
	for (const key of REQUIRED_LEGAL_KEYS) {
		test(`an empty ${key} fails the build with the key name and no configured value`, () => {
			for (const broken of [
				{ ...config, [key]: '' },
				{ ...config, [key]: '   ' },
				Object.fromEntries(Object.entries(config).filter(([name]) => name !== key))
			]) {
				const error = thrown(() => renderLegalPage('privacy', broken, noop));
				expect(error).toBeInstanceOf(LegalConfigError);
				const { message, keys } = error as LegalConfigError;
				expect(keys).toEqual([key]);
				expect(message).toContain(`${key} is empty`);
				for (const value of Object.values(config)) expect(message).not.toContain(value);
			}
		});
	}

	test('all problems are reported together', () => {
		expect(() => resolveLegalConfig({})).toThrow(LegalConfigError);
		const error = thrown(() => resolveLegalConfig({ PUBLIC_LGPD_CNPJ: 7 }));
		expect(error).toBeInstanceOf(LegalConfigError);
		expect((error as LegalConfigError).keys).toEqual([...REQUIRED_LEGAL_KEYS]);
	});

	test.each([
		['PUBLIC_LGPD_CONTACT_EMAIL', 'sem-arroba', 'is not an e-mail address'],
		['PUBLIC_LGPD_CONTACT_EMAIL', 'a b@exemplo.invalid', 'is not an e-mail address'],
		['PUBLIC_POLICY_EFFECTIVE_DATE', '16/10/2026', 'is not a YYYY-MM-DD date'],
		['PUBLIC_POLICY_EFFECTIVE_DATE', '2026-02-30', 'is not a YYYY-MM-DD date'],
		['PUBLIC_POLICY_EFFECTIVE_DATE', '2026/02/30', 'is not a YYYY-MM-DD date'],
		['PUBLIC_POLICY_EFFECTIVE_DATE', '2026-10/16', 'is not a YYYY-MM-DD date'],
		['PUBLIC_ORIGIN', 'exemplo.invalid', 'is not an http(s) origin'],
		['PUBLIC_ORIGIN', 'ftp://exemplo.invalid', 'is not an http(s) origin'],
		['PUBLIC_ORIGIN', 'https://exemplo.invalid/caminho', 'is not an http(s) origin'],
		['PUBLIC_ORIGIN', 'https://usuario@exemplo.invalid', 'is not an http(s) origin']
	] as const)('%s = %j is rejected (%s)', (key, value, reason) => {
		expect(() => resolveLegalConfig({ ...config, [key]: value })).toThrow(`${key} ${reason}`);
	});

	test('a YYYY/MM/DD effective date is accepted and normalized to the ISO form', () => {
		const resolved = resolveLegalConfig({ ...config, PUBLIC_POLICY_EFFECTIVE_DATE: '2026/10/16' });
		expect(resolved.values.PUBLIC_POLICY_EFFECTIVE_DATE).toBe('2026-10-16');
	});

	test.each([
		'Controlador **Exemplo**',
		'Controlador `Exemplo`',
		'[Controlador](https://malicioso.invalid)',
		'Controlador {{PUBLIC_ORIGIN}}',
		'Controlador\u0007Exemplo',
		'Controlador\u007fExemplo'
	])('markup, braces and control characters are rejected: %j', (value) => {
		expect(hasUnsafeCharacters(value)).toBe(true);
		expect(() => resolveLegalConfig({ ...config, PUBLIC_LGPD_ADDRESS: value })).toThrow(
			'PUBLIC_LGPD_ADDRESS contains unsupported characters'
		);
	});

	test('HTML-looking values are kept as literal text for Svelte to escape', () => {
		const hostile = 'Exemplo <img src=x onerror=alert(1)> & "Cia" \'Ltda\'';
		expect(hasUnsafeCharacters(hostile)).toBe(false);
		const page = renderLegalPage('privacy', { ...config, PUBLIC_LGPD_CONTROLLER: hostile }, noop);
		const list = sectionList(page.documents['pt-BR'], '1.');
		expect(list[0]).toBe(`**${hostile}**`);
		expect(JSON.stringify(page.documents)).not.toContain('&amp;');
	});

	test('unknown placeholders in a template are rejected', () => {
		const template: LegalDocument = {
			locale: 'pt-BR',
			title: 'T',
			blocks: [{ kind: 'paragraph', text: '{{PUBLIC_SECRET}}' }]
		};
		expect(() => renderLegalDocument(template, config)).toThrow('Unknown legal placeholder');
	});
});

describe('versioned content', () => {
	test('rendered privacy pages contain no draft legal disclaimer in either locale', () => {
		for (const values of [config, withoutOptional]) {
			const page = renderLegalPage('privacy', values, noop);
			for (const locale of ['pt-BR', 'en-US'] as const) {
				expect(texts(page.documents[locale]).join('\n')).not.toMatch(/advogado|lawyer|Q-LEGAL/i);
			}
		}
	});

	test('both privacy locales describe Android and the corrected retention limits', () => {
		const fragments = {
			'pt-BR': [
				'app Android open-auri',
				'WebView',
				'sem backup pelo app',
				'local que você escolhe',
				'não acrescenta coleta independente',
				'USB',
				'Nome privado',
				'O lote é inserido diretamente, sem atraso aleatório.',
				'rate_limit_counters',
				'12 meses da primeira inserção',
				'Não é um limite de 12 semanas exatas.',
				'não uma verificação técnica de idade',
				'não é direcionado a menores de idade',
				'país aproximado a partir do fuso horário do navegador',
				'Ocultar este autor',
				'Ocultar esta curva',
				'guardada e sincronizada como preferência da conta'
			],
			'en-US': [
				'open-auri Android app',
				'WebView',
				'without app backup',
				'where you choose',
				'adds no collection independent',
				'USB',
				'Private name',
				'The batch is inserted directly, without random delay.',
				'rate_limit_counters',
				'12 months from first insertion',
				'This is not an exact 12-week limit.',
				'not technical age verification',
				'not directed to minors',
				"approximate country from the browser's timezone",
				'Hide this author',
				'Hide this curve',
				'stored and synced as an account preference'
			]
		};
		for (const locale of ['pt-BR', 'en-US'] as const) {
			const privacy = texts(legalContent('privacy', locale)).join('\n');
			for (const fragment of fragments[locale]) expect(privacy).toContain(fragment);
			expect(privacy).not.toContain('\u2014');
		}
	});

	test('POLICY_VERSION is an ISO date and every document states it', () => {
		expect(isPolicyVersion(POLICY_VERSION)).toBe(true);
		expect(isPolicyVersion('v2')).toBe(false);
		expect(isPolicyVersion(null)).toBe(false);
		for (const kind of ['privacy', 'terms'] as const) {
			for (const locale of ['pt-BR', 'en-US'] as const) {
				const first = legalContent(kind, locale).blocks[0];
				expect(first.kind).toBe('paragraph');
				expect(first.kind === 'paragraph' && first.text).toContain(POLICY_VERSION);
			}
		}
	});

	test('templates hold placeholders only, never operator data', () => {
		for (const kind of ['privacy', 'terms'] as const) {
			for (const locale of ['pt-BR', 'en-US'] as const) {
				const source = JSON.stringify(legalContent(kind, locale));
				expect(source).toContain('{{PUBLIC_LGPD_CONTROLLER}}');
				expect(source).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
				expect(source).not.toMatch(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/);
			}
		}
	});

	test('pt-BR texts carry the T3.4 adjustments and no em dash', () => {
		const privacy = texts(legalContent('privacy', 'pt-BR')).join('\n');
		const terms = texts(legalContent('terms', 'pt-BR')).join('\n');
		for (const fragment of [
			'traz embutidos',
			'Apelido público',
			'biblioteca pública',
			'rastreio de IP desligado',
			'sal que muda todo dia',
			'6 meses',
			'ordem judicial',
			'Resend (operadora)',
			'Cloudflare, Inc.',
			'Turnstile',
			'`oa.policy.seen`'
		]) {
			expect(privacy).toContain(fragment);
		}
		for (const fragment of ['CC0 1.0', 'CC BY 4.0', 'irrevogável', 'Conduta', 'Moderação']) {
			expect(terms).toContain(fragment);
		}
		expect(`${privacy}\n${terms}`).not.toContain('\u2014');
	});
});
