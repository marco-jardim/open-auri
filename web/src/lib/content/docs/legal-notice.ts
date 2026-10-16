import type { DocsLocale } from './types.ts';

export const legalNotice: Record<DocsLocale, readonly string[]> = {
	'pt-BR': [
		'open-auri não é oficial nem endossado pela Kuba, pela TTGK, pela Savitech ou por qualquer fabricante. Tudo aqui foi obtido por estudo do protocolo para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição.',
		'As informações distinguem fatos confirmados no código, hipóteses e pontos que exigem testes no hardware. Nenhuma escrita foi validada por este projeto no cabo real. A ausência de falhas nos testes em software não constitui garantia de funcionamento ou segurança do dispositivo.',
		'O software e esta documentação são fornecidos “no estado em que se encontram” (“as is”), sem qualquer garantia, expressa ou implícita, incluindo comercialização, adequação a uma finalidade específica e não violação, na máxima extensão permitida pela legislação aplicável. Consulte a AGPL-3.0, especialmente a seção 15 (isenção de garantia) e a seção 16 (limitação de responsabilidade). Este aviso não substitui a licença nem afasta direitos que a lei não permita excluir.',
		'Na máxima extensão permitida pela legislação aplicável, os autores e colaboradores não se responsabilizam por danos ao cabo, aos fones, à audição, a outros equipamentos ou a dados, nem por perdas diretas, indiretas, incidentais ou consequenciais. Uma gravação pode persistir na flash; não há read-back, rollback ou recuperação garantidos no caminho conhecido. Isto não é uma promessa de segurança auditiva.',
		'Marcas e nomes de produtos pertencem aos seus respectivos titulares e são citados apenas para identificação, atribuição e interoperabilidade. As homenagens são tributos editoriais, sem vínculo, afiliação, aprovação ou endosso pelos homenageados, representantes ou espólios.'
	],
	'en-US': [
		'open-auri is not official or endorsed by Kuba, TTGK, Savitech, or any manufacturer. Everything here was obtained by studying the protocol for interoperability purposes. Use at your own risk: we accept no responsibility for damage to the cable, earphones, or your hearing.',
		'This documentation distinguishes facts confirmed in code, hypotheses, and matters requiring hardware testing. No write has been validated by this project on the actual cable. Passing software tests does not guarantee device operation or safety.',
		'The software and this documentation are provided “as is”, without any express or implied warranty, including merchantability, fitness for a particular purpose, and non-infringement, to the maximum extent permitted by applicable law. Refer to AGPL-3.0, particularly section 15 (Disclaimer of Warranty) and section 16 (Limitation of Liability). This notice does not replace the license or exclude rights that cannot lawfully be excluded.',
		'To the maximum extent permitted by applicable law, authors and contributors accept no responsibility for damage to the cable, earphones, hearing, other equipment, or data, or for direct, indirect, incidental, or consequential losses. A write may persist in flash; the known path provides no guaranteed read-back, rollback, or recovery. This is not a promise of hearing safety.',
		'Trademarks and product names belong to their respective owners and are mentioned only for identification, attribution, and interoperability. The homages are editorial tributes, with no connection, affiliation, approval, or endorsement by the honorees, their representatives, or their estates.'
	]
};
