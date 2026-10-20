import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import LegalPage from '#lib/components/pages/docs/LegalPage.svelte';
import { legalUi } from '#lib/components/pages/docs/legal-ui.ts';
import { renderLegalPage } from '#lib/content/legal/render.ts';

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

// Fake operator data only.
const hostile = 'Controlador Exemplo <img src=x onerror=alert(1)> & "Cia"';
const config = {
	PUBLIC_ORIGIN: 'https://exemplo.invalid',
	PUBLIC_LGPD_CONTROLLER: hostile,
	PUBLIC_LGPD_CONTACT_EMAIL: 'privacidade@exemplo.invalid',
	PUBLIC_LGPD_CNPJ: '',
	PUBLIC_LGPD_ADDRESS: '',
	PUBLIC_LGPD_DPO_NAME: '',
	PUBLIC_POLICY_EFFECTIVE_DATE: '2026-10-16'
};

for (const locale of ['pt-BR', 'en-US'] as const) {
	for (const kind of ['privacy', 'terms'] as const) {
		test(`${kind} (${locale}) rendered at prerender escapes HTML and omits empty fields`, async () => {
			await setLocale(locale, { reload: false });
			const data = renderLegalPage(kind, config, () => undefined);
			const screen = await render(LegalPage, {
				document: data.documents[locale],
				values: data.values,
				ui: legalUi()
			});
			const text = screen.container.textContent ?? '';
			if (kind === 'privacy') expect(text).not.toMatch(/advogado|lawyer|Q-LEGAL/i);
			expect(text).toContain(hostile);
			expect(screen.container.querySelector('img')).toBeNull();
			expect(screen.container.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt; &amp;');
			expect(text).not.toContain('{{');
			expect(text).not.toContain('CNPJ');
			expect(text).toContain('privacidade@exemplo.invalid');
			expect(text).toContain('2026-10-16');
			expect(screen.container.querySelector('h1')?.textContent).toBe(data.documents[locale].title);
		});
	}
}
