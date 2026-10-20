import { legalNotice } from '../docs/legal-notice.ts';
import type { LegalDocument } from '../docs/legal.ts';
import { POLICY_VERSION } from './version.ts';

const paragraph = (text: string) => ({ kind: 'paragraph' as const, text });
const heading = (text: string) => ({ kind: 'heading' as const, text });
const list = (items: string[]) => ({ kind: 'list' as const, items });

// TODO(Q-LEGAL): revisão jurídica dos termos antes da publicação.
export const termsPtBR: LegalDocument = {
	locale: 'pt-BR',
	title: 'Termos de uso do open-auri',
	blocks: [
		paragraph(
			`**Versão:** ${POLICY_VERSION} · **Vigência:** {{PUBLIC_POLICY_EFFECTIVE_DATE}} · {{PUBLIC_ORIGIN}}/termos`
		),
		paragraph(
			'Esta é a versão oficial dos termos. A tradução em inglês serve apenas como apoio. Em caso de diferença, vale este texto em português.'
		),
		heading('1. Projeto independente, interoperabilidade e isenção'),
		...legalNotice['pt-BR'].map(paragraph),
		heading('2. Uso responsável e gravação'),
		paragraph(
			'O site e o app são destinados a pessoas com 18 anos ou mais, inclusive no uso sem conta, e não são direcionados a menores de idade.'
		),
		paragraph(
			'O editor e as prévias locais não exigem conta. Nenhum byte deve ser enviado sem aprovação do gate v2 nos valores Q27/Q23 reais, checklist completo e gesto explícito. O gate é uma política de semelhança com o que os 11 presets oficiais já fazem o chip calcular, não uma prova de segurança do hardware. Abaixe o volume, mantenha a alimentação estável e não desconecte durante a gravação. Toda escrita conhecida persiste na flash, de vida útil desconhecida.'
		),
		paragraph(
			'Curvas da comunidade são conteúdo de outras pessoas. Passar no gate não significa que a curva seja segura para a sua audição ou para o seu equipamento. Ouça a prévia em volume baixo antes de gravar.'
		),
		heading('3. Conta e apelido público'),
		list([
			'A conta é opcional; o cadastro e o uso da conta exigem 18 anos ou mais. Cada pessoa mantém uma conta, com e-mail verificado para qualquer ação social.',
			'Você responde pela guarda da sua senha e pelas ações feitas na sua conta. Avise-nos pelo canal de privacidade se suspeitar de uso indevido.',
			'O apelido público é o único nome exibido. Ele não pode se passar por outra pessoa, por fabricantes, pelo projeto ou pelos homenageados, nem conter dados pessoais de terceiros. Apelidos reservados ou confundíveis com outros são recusados.',
			'O apelido pode ser trocado a cada 30 dias. O antigo fica reservado por 90 dias e redireciona para o novo.'
		]),
		heading('4. Conteúdo publicado e licenças'),
		paragraph(
			'Ao publicar uma curva, você escolhe uma de duas licenças Creative Commons para aquela versão: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/deed.pt-br) (dedicação ao domínio público, sem exigência de crédito) ou [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.pt-br) (uso livre com crédito ao seu apelido).'
		),
		list([
			'**A licença de uma versão publicada é irrevogável.** Você pode retirar a curva do site, mas cópias, forks e dumps públicos já feitos continuam válidos nos termos da licença.',
			'Versões são só por acréscimo: uma nova versão não apaga as anteriores do histórico.',
			'Um fork herda a obrigação de crédito da versão de origem quando ela for CC BY 4.0.',
			'Em packs, cada curva mantém a sua própria licença.',
			'Você declara que tem o direito de publicar o que publica. Não publique como seu o que é de terceiros, como presets oficiais da Kuba (licença a confirmar) ou dados de medição sem a atribuição exigida pela licença de origem. Os dados do AutoEq embutidos no app seguem a licença MIT.',
			'O software do open-auri é distribuído sob AGPL-3.0. Componentes de terceiros conservam suas licenças e atribuições. Estes termos não substituem nem restringem as permissões das licenças aplicáveis.'
		]),
		heading('5. Conduta'),
		paragraph('Ao usar as funções sociais, você não pode:'),
		list([
			'publicar conteúdo ilegal, ofensivo, discriminatório, de assédio ou que viole direitos de terceiros;',
			'usar nomes, descrições ou packs para spam, propaganda, links ou dados pessoais de outras pessoas;',
			'manipular rankings, contagens ou denúncias, inclusive com contas múltiplas ou automação;',
			'publicar curvas feitas para causar desconforto, dano auditivo ou dano ao equipamento, ou contornar o gate, o limite de taxa ou o Turnstile (o Modo YOLO não contorna o gate: ele aplica o perfil YOLO do próprio gate, com as travas de hardware);',
			'sondar falhas de segurança fora de um contato prévio pelo canal do projeto, ou sobrecarregar o serviço.'
		]),
		paragraph(
			'**Curvas YOLO.** Curvas feitas além dos limites padrão, no Modo YOLO, só são publicadas com a marca YOLO, depois do seu reconhecimento explícito, e ficam fora do feed principal, dos rankings e das demais listas padrão. Passar nas verificações do open-auri não quer dizer que a curva não ofereça risco à audição ou ao equipamento. Quem grava uma curva YOLO no cabo assume o risco.'
		),
		heading('6. Moderação'),
		list([
			'Contas verificadas podem denunciar conteúdo. Uma curva é ocultada automaticamente quando 3 contas verificadas diferentes, com 3 dias ou mais de existência, a denunciam; uma curva cuja versão atual é YOLO é ocultada já com 2 dessas contas.',
			'A moderação revê as ocultações automáticas e pode restaurar, ocultar, retirar conteúdo, marcar curadoria e banir contas que violem estes termos ou a lei. Cada ação fica no registro de auditoria.',
			'Se uma decisão afetar você, peça a revisão pelo canal de privacidade indicado na seção 8, inclusive de decisões automatizadas (LGPD, art. 20).',
			'Podemos remover conteúdo ou suspender contas para cumprir ordem judicial ou obrigação legal.'
		]),
		heading('7. Disponibilidade e responsabilidade'),
		paragraph(
			'O serviço é oferecido sem garantia de disponibilidade contínua e pode ser alterado, entrar em modo somente leitura ou ser encerrado. Na máxima extensão permitida pela lei, não respondemos por conteúdo publicado por usuários, nem pelo uso de curvas da comunidade no seu cabo ou fone. Os avisos da seção 1 valem para todo o serviço.'
		),
		heading('8. Dados e contato'),
		paragraph(
			'O áudio carregado nunca é enviado ao servidor. A política em {{PUBLIC_ORIGIN}}/privacidade descreve armazenamento local, cookies essenciais, conta, funções sociais e registros de acesso. Controlador: {{PUBLIC_LGPD_CONTROLLER}}. CNPJ: {{PUBLIC_LGPD_CNPJ}}. Endereço: {{PUBLIC_LGPD_ADDRESS}}. Contato de privacidade: {{PUBLIC_LGPD_CONTACT_EMAIL}}. Encarregado: {{PUBLIC_LGPD_DPO_NAME}}.'
		),
		heading('9. Lei aplicável e alterações'),
		paragraph(
			'Aplica-se a legislação brasileira, preservados direitos obrigatórios do usuário. Mudanças relevantes terão nova versão e data de vigência, com aviso no app. O aviso legal completo está em /docs#aviso-legal.'
		)
	]
};
