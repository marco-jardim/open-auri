import { legalNotice } from './legal-notice.ts';
import type { DocsContent } from './types.ts';

export const ptBR: DocsContent = {
	locale: 'pt-BR',
	title: 'O protocolo 0xCB e seus limites',
	titleLead: 'O protocolo 0xCB',
	titleEmphasis: 'e seus limites',
	subtitle: 'Documentação do open-auri',
	reprint: 'Reimpressão em homenagem a Harry Nyquist',
	introduction:
		'Estudo independente sobre bytes, amostragem e estabilidade. Revisão de 15 de outubro de 2026. Formato estudado; hardware ainda não validado.',
	polarCaption:
		'Fig. 1. Resposta H(eʲω) do preset com preamp Q23 e seções Q27. Traço contínuo: 0–48 kHz; pontilhado: frequências negativas. O ponto (−1, 0) é uma referência histórica: isto não é uma malha de realimentação nem uma aplicação do critério de estabilidade de Nyquist.',
	telegraphNote:
		'Em 1928, Nyquist descreveu como um canal de largura de banda B admite até 2B elementos independentes por segundo. A fita acima contém os 220 bytes reais do Padrão Auri, calculados pelo codec, sem transmissão ao cabo.',
	stabilityNote:
		'Em 1932 publicou “Regeneration Theory”. Aqui verificamos os polos do filtro digital depois de quantizar os coeficientes: |p| < 1. Não confundimos esse teste com o critério de estabilidade de uma malha de realimentação.',
	safetyCaveat:
		'O gate v2 é uma política de semelhança com o que os 11 presets oficiais já fazem o chip calcular, não uma prova de segurança do hardware.',
	flashNotice:
		'A memória do cabo tem vida útil desconhecida; memórias desse tipo costumam aguentar de 10 mil a 1 milhão de gravações.',
	thresholdLabels: [
		'Raio dos polos Q27',
		'Pico próprio, DC–48 kHz',
		'Todo prefixo com preamp, 20 Hz–20 kHz',
		'Saída, 20 Hz–20 kHz',
		'Saída, DC–48 kHz',
		'Preamp nominal',
		'Tolerância numérica em dB',
		'Tolerância numérica no raio'
	],
	sections: [
		{
			id: 'comeco',
			title: 'Começo rápido',
			paragraphs: [
				'Use Chrome ou Edge desktop, em HTTPS, para gravar. Editor, biblioteca local e prévias também funcionam sem cabo. Conecte o cabo Auri DSP e autorize WebHID com um clique; VID 0x3302, PID 0x8902, produto “USB DSP Audio”, bridge CB5100.',
				'Escolha um dos 11 presets oficiais ou ajuste a curva. Revise preamp e gate v2. Abaixe o volume, confirme cabo correto, alimentação estável e checklist, depois pressione Gravar no cabo. Nada é gravado ao arrastar, escolher preset ou abrir esta documentação.',
				'Neutro é 10 × OFF, identidade exata, com preamp −0,5 dB e CRC 0x4FFF (FF 4F no fio). Padrão Auri é o preset oficial padrao, não uma restauração de fábrica comprovada. Uma cópia local não é leitura do cabo e não oferece undo garantido.'
			],
			links: [
				{ label: 'Abrir a Curva', href: '/' },
				{ label: 'Conexão e checklist', href: '/cabo' }
			]
		},
		{
			id: 'camadas',
			title: 'As três camadas',
			paragraphs: [
				'A mesma curva, com diferentes quantidades de informação. Cada camada inclui a anterior. Mudar a vista não muda o payload nem concede permissão de escrita.'
			],
			items: [
				'Ouvir: presets, curva, macros de timbre e preamp para escolher e comparar.',
				'Ajustar: frequência, ganho e Q de PK, LS e OFF. Arraste e solver conservam a última curva aprovada; o gate revalida após o arredondamento.',
				'Engenharia: coeficientes Q27, palavra Q23, bytes e motivos de recusa. HS, LP e HP são experimentais, exigem gate v2 e confirmação extra. Biquads crus ainda não estão liberados.'
			],
			links: [
				{ label: 'Ouvir', href: '/?camada=ouvir' },
				{ label: 'Ajustar', href: '/?camada=ajustar' },
				{ label: 'Engenharia', href: '/?camada=engenharia' }
			]
		},
		{
			id: 'envelope',
			title: 'O que é seguro',
			paragraphs: [
				'O gate v2, “envelope observado”, avalia os valores Q27/Q23 reais que vão ao fio. Passar no gate não significa que a curva já tenha sido gravada pela Kuba. Máximos marginais não limitam todos os estados internos, transientes, limit cycles ou aritmética desconhecida.',
				'A sequência é: coeficientes em inteiros sem folga; polos quantizados; pico isolado de cada seção; cada prefixo na ordem real com preamp; saída audível e total; codec encodePayload sem erro; preamp nominal. Atenuar não corrige coeficientes, polos ou pico próprio reprovados.',
				'Cortes antes dos reforços é a ordem inicial, não um certificado. Dez seções aprovadas isoladamente podem falhar juntas. Prefixos só são limitados em 20 Hz–20 kHz; prefixos subsônicos ou ultrassônicos podem escapar. O gate continua obrigatório depois do snapping e antes de toda gravação ou publicação.',
				'Controles absolutos: 20 Hz–20 kHz, ganho −24 a +9,2 dB, Q de 0,1 a 20. Reforços PK têm Q ≤ 4 e não são permitidos acima de 16 kHz. HS, LP e HP ficam apenas na Engenharia, com confirmação experimental extra. Caixas suaves não são autorização de escrita.'
			]
		},
		{
			id: 'protocolo',
			title: 'Protocolo 0xCB',
			paragraphs: [
				'Uma curva vira 220 B: header de 14 B, preamp int32 little-endian Q23 de 4 B, dez biquads de 20 B e CRC de 2 B. Cada seção leva cinco int32 Q27 na ordem [b0, b2, −a1, b1, −a2], com a0 = 1 implícito. Não há byte de tipo de filtro.',
				'Header confirmado: 45 51 31 23 D6 00 00 0A 04 05 01 0A 00 00. “EQ1#” é ASCII; interpretar D6 00 como comprimento é hipótese. Os bytes 6 e 12–13 permanecem desconhecidos.',
				'WebHID usa report ID 0xCB e dados de 31 B (o ID fica fora deles). Reports 0 a 6 levam índice + 30 B; report 7 leva 10 B e padding zero; report 8 leva só o índice e zeros. Há 16 ms após cada report, depois 150 ms e commit 01 65 00 01 FF completado com zeros até 31 B: 294 ms nominais mais overhead. A equivalência do padding do commit no firmware ainda exige teste.',
				'Q23 guarda ganho linear: round(10^(dB/20) × 2²³). Q27 usa round(coef × 2²⁷). O CRC16-CCITT-FALSE cobre os primeiros 218 B: poly 0x1021, init 0xFFFF, sem reflexão ou XOR final, anexado little-endian. Integridade não prova autenticidade ou segurança.',
				'A amostragem ilustrada é a 96 kHz, com dobra em 48 kHz. Para 48 < f < 96 kHz, f_alias = 96 − f. O desenho não mede o clock real nem a entrada analógica. Os widgets são exemplos locais do codec, nunca autorização para gravar.'
			]
		},
		{
			id: 'limites',
			title: 'Limites físicos',
			paragraphs: [
				'O formato conhecido oferece 10 seções, uma curva para os dois canais e taxa de projeto de 96 kHz (0 < f < 48 kHz). Não oferece EQ L/R independente, crossfeed, compressor, reverb, volume do cabo ou seletor do filtro do DAC.',
				'O caminho é somente escrita: não há read-back, verify, pull ou rollback confirmado. Journal, snapshot e localStorage registram o envio no host, não o estado atual do cabo. Clock fixo e realização interna do DSP ainda não foram medidos.'
			]
		},
		{
			id: 'memoria',
			title: 'Memória e vida útil',
			paragraphs: [
				'Cada commit conhecido persiste na flash. Não há escrita automática. A política permite no máximo uma gravação a cada 2 s, com contadores de sessão, dia e total, e aviso informativo a partir de 50 gravações por dia, não um limite rígido diário.',
				'O tipo de memória e a estratégia de apagamento são desconhecidos. Ordens de grandeza típicas de datasheets não são especificações deste cabo; não calculamos “anos restantes”.',
				'A nova curva pode soar mais alta. Abaixe o volume antes de gravar. O aviso de loudness aparece para aumento previsto ≥ +3 dB ou curva atual desconhecida; a estimativa não é LUFS nem um limiar médico. Não desconecte durante a escrita.'
			]
		},
		{
			id: 'previa',
			title: 'Prévia com o seu MP3',
			paragraphs: [
				'Use ♪ Áudio na barra superior para carregar um MP3 ou outro áudio compatível. O arquivo fica apenas no IndexedDB open-auri, store audio, neste aparelho; nunca é enviado. Remover no carregador ou apagar dados locais o elimina.',
				'A prévia toca por streaming. Quando possível, usa 96 kHz, seções IIR com coeficientes Q27 exatos e preamp Q23; em outra taxa recalcula os coeficientes e indica prévia aproximada. Sem arquivo, usa ruído rosa local. Comparações e teste cego no navegador igualam o nível pelo candidato mais baixo.',
				'O volume da prévia é só no navegador. A aritmética interna do chip é desconhecida. Ouvir pela saída do próprio cabo soma a curva já persistida: use outra saída ou grave Neutro explicitamente antes. O teste cego no navegador não grava no cabo.'
			],
			links: [
				{ label: 'Comparar curvas', href: '/comparar' },
				{ label: 'Teste cego no navegador', href: '/teste-cego' }
			]
		},
		{
			id: 'dados-locais',
			title: 'Dados neste navegador',
			paragraphs: [
				'Curvas, diário, configurações e MP3 ficam no aparelho. Apagar dados locais remove somente chaves oa.* de localStorage e sessionStorage e o banco IndexedDB open-auri (audio, library, outbox), após confirmação. Não envia nada, não apaga a conta e não altera o cabo: o preset gravado nele continua lá.',
				'localStorage: oa.lang (idioma), oa.current (editor), oa.journal (últimas 500 entradas), oa.flash.day, oa.flash.total e oa.flash.lastWriteAt (contadores e intervalo), oa.meter.ref (referência), oa.curve.written (última curva gravada no cabo), oa.cable.inflight (gravação em curso, removido ao terminar). sessionStorage: oa.flash.session. IndexedDB: biblioteca, fila offline e áudio. O cookie essencial oa_lang e o cache offline não são apagados por esta ação.',
				'Exporte o que quiser guardar antes de apagar. Feche outras abas se o banco estiver bloqueado. A conta e as funções sociais são opcionais; consulte a política de privacidade para requisições ao servidor e registros de acesso. MP3 nunca é enviado.'
			],
			links: [{ label: 'Política de privacidade', href: '/privacidade' }]
		},
		{
			id: 'pagina-oficial',
			title: 'O que a página oficial faz',
			paragraphs: [
				'A página oficial oferece 11 presets, sem edição de frequência, ganho, Q ou preamp. Envia nove reports e um commit; não lê o cabo nem oferece slots. O preset permanece para uso em outro aparelho.',
				'Natural (pref6) desenha show, mas grava bands: os conjuntos diferem. Aqui figuras e bytes partem do que é gravado. Presets oficiais conservam ordem, preamp e bytes originais. Descrições são da Kuba; licença: a confirmar.',
				'Padrão Auri: filtros do Leonardo (segundo comentário no código da página oficial). O crédito não confirma o estado de fábrica.'
			],
			links: [
				{ label: 'Implementação oficial de referência', href: 'https://equalizador.kuba.audio/' }
			]
		},
		{
			id: 'perguntas',
			title: 'O que não sabemos',
			paragraphs: ['Nenhum teste de software substitui gravar, ouvir e medir o cabo real.'],
			items: [
				'Existe read-back, aplicação só em RAM ou verificação do CRC no firmware?',
				'Qual é o tipo de flash, endurance, estratégia de apagamento e efeito de perder energia no commit?',
				'Há click, estalo, mute ou transiente ao trocar durante áudio?',
				'O clock é sempre 96 kHz? Qual é a precisão interna, realização, guard bits e comportamento de limit cycles?',
				'O que significam os bytes desconhecidos do header? Quais interfaces e versões de firmware existem?',
				'CB5100 aparece em briefs TTGK; a atribuição à Savitech é hipótese de fonte secundária. Parentesco não torna 0xCB e 0x4B intercambiáveis.'
			]
		},
		{ id: 'glossario', title: 'Glossário', paragraphs: [] },
		{
			id: 'aviso-legal',
			title: 'Aviso legal',
			paragraphs: legalNotice['pt-BR'],
			links: [
				{ label: 'AGPL-3.0, seções 15 e 16', href: 'https://www.gnu.org/licenses/agpl-3.0.html' },
				{ label: 'Termos de uso', href: '/termos' }
			]
		},
		{
			id: 'creditos',
			title: 'Créditos',
			paragraphs: [
				'AutoEq: MIT, Copyright (c) 2018-2022 Jaakko Pasanen. Projeto PK/LS/HS derivado de autoeq/peq.py; LP/HP seguem o Audio EQ Cookbook de Robert Bristow-Johnson. Medições continuam creditadas às fontes originais, listadas no manifesto de cada geração.',
				'Para solicitar remoção de medições, abra uma issue com fonte, modelos ou caminhos e motivo. A distribuição é regenerada com a fonte excluída, substitui os packs anteriores e invalida caches; isso não altera o upstream. O processo completo está no documento de dados AutoEq.',
				'Os nomes abaixo são homenagens editoriais em texto, não marcas do open-auri nem indicação de endosso.'
			]
		},
		{
			id: 'contas',
			title: 'Contas',
			paragraphs: [
				'A conta é opcional. Editor, presets, biblioteca no navegador, prévias, teste cego e gravação no cabo funcionam sem ela. Publicar, favoritar, registrar atividade, compartilhar, montar packs, denunciar e trocar curvas exigem conta com e-mail verificado.',
				'Cadastro com e-mail e senha de pelo menos 10 caracteres, com verificação de força. Cadastro, entrada, recuperação e troca de e-mail passam pelo Turnstile. O link de verificação chega por e-mail; sem ele a conta só lê.',
				'O apelido é o único nome público: aparece em rankings, feed, créditos, compartilhamentos, perfil e público das curvas. Tem de 3 a 24 caracteres (letras, dígitos, ponto, sublinhado e hífen) e é único depois da normalização NFKC e do esqueleto de caracteres confundíveis (UTS #39). Alguns nomes são reservados, como admin, open-auri, kuba, auri, os homenageados e termos de sistema. A troca é permitida a cada 30 dias; o apelido antigo fica reservado por 90 dias e redireciona para o novo.',
				'Contas de administração usam segundo fator (app autenticador ou códigos de reserva). Ações destrutivas, como remover conteúdo ou banir, pedem uma sessão recente: até 10 minutos desde a entrada ou a última verificação do segundo fator.',
				'Encerrar a conta pede confirmação pelo link enviado ao e-mail. Você escolhe o destino do conteúdo público CC: manter anonimizado (curvas e packs públicos e ativos ficam como “autor removido” e o apelido fica reservado por 90 dias sem dono) ou apagar tudo (todas as curvas, versões e packs; o apelido fica livre na hora). Nos dois modos, o conteúdo privado, não listado ou retirado é apagado, junto com favoritos, atividade, compartilhamentos e trocas. Forks feitos por outras pessoas continuam. Exporte seus dados em JSON antes, se quiser guardá-los.'
			],
			links: [
				{ label: 'Minha conta', href: '/conta' },
				{ label: 'Política de privacidade', href: '/privacidade' }
			]
		},
		{
			id: 'privacidade-atividade',
			title: 'Privacidade da atividade',
			paragraphs: [
				'“Experimentou” é uma prévia audível de pelo menos 10 s. “Instalou” é uma gravação real e bem-sucedida no cabo, nunca a simulada; quem informa é o seu navegador, depois do checklist e do gesto. “Favoritou” é o favorito. Eventos feitos sem rede ficam numa fila e são aceitos até 7 dias depois.',
				'Os números públicos contam pessoas distintas, com e-mail verificado e não banidas; o autor nunca conta na própria curva. Repetir uma prévia ou instalação só aumenta um contador privado seu.',
				'A atividade é privada por padrão. Com ela privada, você entra no público de uma curva só como parte de “N pessoas com perfil privado”. Se torná-la pública, seu apelido aparece na lista de quem experimentou, instalou ou favoritou, e seus favoritos podem aparecer no perfil.',
				'A biblioteca pública também é opcional e começa desligada: o perfil mostra só o apelido e contagens agregadas. Ligada, mostra suas criações e packs públicos. Em qualquer caso, suas curvas públicas abrem por link, creditadas ao apelido.',
				'Você vê e apaga o próprio histórico, inteiro ou por curva e tipo. As contagens públicas caem na hora; os rankings, no próximo recálculo. Aberturas de links compartilhados são só um contador anônimo por dia.'
			],
			links: [{ label: 'Minha conta', href: '/conta' }]
		},
		{
			id: 'rankings',
			title: 'Rankings',
			paragraphs: [
				'Duas métricas: mais favoritadas e mais instaladas. Três janelas: 7 dias, 30 dias e sempre. A pontuação é o número de pessoas distintas, com e-mail verificado e não banidas, que favoritaram ou instalaram dentro da janela; o autor da curva não conta.',
				'Entram só curvas públicas e listadas, ativas, sem ocultação de moderação, com a versão atual aprovada no gate e autor não banido. Curvas não listadas ou privadas nunca entram.',
				'Desempate: pontuação, depois a atividade mais recente, depois o id. Os rankings são recalculados a cada 15 minutos, com até 1000 posições por métrica e janela. A visibilidade é conferida de novo em cada leitura: uma curva ocultada ou retirada sai da lista na hora.'
			],
			links: [{ label: 'Comunidade', href: '/comunidade' }]
		},
		{
			id: 'moderacao',
			title: 'Moderação',
			paragraphs: [
				'Qualquer conta com e-mail verificado pode denunciar uma curva, um pack ou um perfil, com um motivo (perigosa, spam, ofensiva, direitos autorais, falsidade de identidade ou outro) e uma nota opcional de até 500 caracteres, lida só pela administração. A denúncia passa pelo Turnstile; cada pessoa denuncia um mesmo alvo uma vez, até 30 denúncias por dia, e não pode denunciar o próprio conteúdo.',
				'Quando 3 contas distintas, verificadas, não banidas e com 3 dias ou mais de idade denunciam a mesma curva ou pack, o conteúdo é ocultado automaticamente até a revisão. A ocultação automática nunca desfaz uma decisão da administração. Perfis não são ocultados automaticamente.',
				'A administração revisa a fila e decide: ocultar, restaurar, remover, dispensar as denúncias ou banir o autor. Toda decisão fica no registro de auditoria, com o motivo. Para contestar uma decisão, use o canal de contato indicado na política de privacidade.'
			],
			links: [
				{ label: 'Política de privacidade', href: '/privacidade' },
				{ label: 'Termos de uso', href: '/termos' }
			]
		},
		{
			id: 's6',
			title: 'Preferências anônimas (S6)',
			paragraphs: [
				'Ao fim de um teste cego no navegador, você pode enviar o resultado dos pares. O envio é opcional, anônimo e não exige conta. Como preferência auditiva pode revelar condições de saúde, ele só acontece com o seu consentimento explícito (LGPD, art. 11).',
				'O servidor guarda só um identificador aleatório, o resumo SHA-256 do seu recibo, a versão do consentimento, o dia e os pares (curva A, curva B, escolha e se o nível estava igualado), em ordem embaralhada. Nada de conta, IP, navegador ou horário. O controle de abuso usa o Turnstile e um contador passageiro, sem gravar nada sobre você.',
				'O recibo fica só neste navegador. Com ele, você retira o envio a qualquer momento e os pares são apagados. Sem o recibo não há como achar o lote: guarde-o se quiser poder retirar depois.',
				'Uma vez por dia, os pares viram “Comunidade prefere” pelo modelo Bradley–Terry: empate vale meia vitória para cada lado e só as curvas ligadas entre si por comparações nos dois sentidos recebem pontuação. O resultado publicado tem só a pontuação e o número de comparações de cada curva.'
			],
			links: [
				{ label: 'Teste cego no navegador', href: '/teste-cego' },
				{ label: 'Comunidade', href: '/comunidade' }
			]
		},
		{
			id: 's7',
			title: 'Troca às cegas (S7)',
			paragraphs: [
				'Com e-mail verificado, você coloca na fila uma curva aprovada no gate: uma sua ou uma pública. Cada pessoa tem uma troca ativa por vez. O pareamento é assíncrono, com quem está esperando há mais tempo; se ninguém estiver na fila, a troca espera.',
				'Pareada, você ouve a curva do parceiro só pela prévia no navegador, sem nome, autor ou link. Instalar continua pedindo o checklist e o seu gesto. Dê uma nota de 1 a 5, uma única vez.',
				'Quando os dois dão nota, a troca é revelada: você vê o apelido do parceiro, a curva dele quando ela abre por link e as duas notas. Trocas não reveladas expiram 72 h depois de entrar na fila ou do pareamento; enquanto espera, você pode cancelar.'
			],
			links: [{ label: 'Comunidade', href: '/comunidade' }]
		}
	],
	glossary: [
		['biquad', 'Filtro de segunda ordem, cinco coeficientes com a0 = 1 implícito.'],
		['Q', 'Fator de qualidade, diferente da escala de ponto fixo Q23/Q27.'],
		['PK / LS / OFF', 'Peak, low shelf e identidade exata [1, 0, 0, 0, 0].'],
		[
			'HS / LP / HP',
			'High shelf, low pass e high pass; experimentais, só na Engenharia. LP/HP não têm ganho editável.'
		],
		['preamp', 'Ganho global antes das bandas; no fio é ganho linear Q23, não dB.'],
		['headroom / clipping', 'Margem até a amplitude máxima / recorte ao excedê-la.'],
		['Q23 / Q27', 'Inteiros int32 com 23 / 27 bits fracionários.'],
		['CRC', 'Verificação de integridade, não de segurança ou autenticidade.'],
		['WebHID / report', 'API de dispositivos com permissão explícita / unidade de dados HID.'],
		['flash', 'Memória não volátil de vida útil finita, desconhecida neste cabo.'],
		[
			'envelope observado',
			'Política de similaridade com os 11 payloads oficiais, não prova de segurança.'
		]
	]
};
