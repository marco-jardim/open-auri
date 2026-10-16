import { legalNotice } from './legal-notice.ts';
import type { LegalDocument } from './legal.ts';

// TODO(Q-LEGAL): revisão jurídica dos termos antes da publicação.
export const termsPtBR: LegalDocument = {
	locale: 'pt-BR',
	title: 'Termos de uso do open-auri',
	blocks: [
		{
			kind: 'paragraph',
			text: 'Versão 1.0 · Vigência: {{PUBLIC_POLICY_EFFECTIVE_DATE}} · {{PUBLIC_ORIGIN}}/termos'
		},
		{ kind: 'heading', text: '1. Projeto independente e interoperabilidade' },
		...legalNotice['pt-BR'].map((text) => ({ kind: 'paragraph' as const, text })),
		{ kind: 'heading', text: '2. Uso responsável e gravação' },
		{
			kind: 'paragraph',
			text: 'O editor e as prévias locais não exigem conta. Nenhum byte deve ser enviado sem aprovação do gate v2 nos valores Q27/Q23 reais, checklist completo e gesto explícito. O gate é uma política de semelhança com o que os 11 presets oficiais já fazem o chip calcular, não uma prova de segurança do hardware. Abaixe o volume, mantenha a alimentação estável e não desconecte durante a gravação. Toda escrita conhecida persiste na flash, de vida útil desconhecida.'
		},
		{ kind: 'heading', text: '3. Licenças e direitos de terceiros' },
		{
			kind: 'paragraph',
			text: 'O software é distribuído sob AGPL-3.0. Componentes de terceiros conservam suas licenças e atribuições; AutoEq usa MIT. Presets e descrições oficiais da Kuba têm licença a confirmar. Você deve respeitar os direitos de terceiros ao importar ou compartilhar conteúdo. Estes termos não substituem nem restringem as permissões das licenças aplicáveis.'
		},
		{ kind: 'heading', text: '4. Dados e contato' },
		{
			kind: 'paragraph',
			text: 'O áudio carregado nunca é enviado ao servidor. A política em {{PUBLIC_ORIGIN}}/privacidade descreve armazenamento local, cookies essenciais, eventuais funções de conta e registros de acesso. Controlador: {{PUBLIC_LGPD_CONTROLLER}}. CNPJ: {{PUBLIC_LGPD_CNPJ}}. Endereço: {{PUBLIC_LGPD_ADDRESS}}. Contato de privacidade: {{PUBLIC_LGPD_CONTACT_EMAIL}}. Encarregado, se houver: {{PUBLIC_LGPD_DPO_NAME}}.'
		},
		{ kind: 'heading', text: '5. Lei aplicável e alterações' },
		{
			kind: 'paragraph',
			text: 'Aplica-se a legislação brasileira, preservados direitos obrigatórios do usuário. Mudanças relevantes terão nova versão e data de vigência. O aviso legal completo está em /docs#aviso-legal. Contas e recursos sociais terão regras específicas na fase em que forem disponibilizados.'
		}
	]
};
