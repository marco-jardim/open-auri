import { legalNotice } from './legal-notice.ts';
import type { DocsContent } from './types.ts';

// BEGIN Android validation state ------------------------------------------------------------
// The only place in this file that says whether writing from the Android app was validated on
// a real cable (section `android-validacao`). While ANDROID_WRITE_VALIDATED is false
// (src/lib/cable/android-status.ts), the first two entries are the exact Anexo G.1 title and
// text of docs/plans/2026-10-18-android-capacitor-plano.md. At F5, replace this whole block
// with the Anexo G.6 text (date, number of devices and report). en-US.ts has the twin block.
const androidValidationState: readonly string[] = [
	'Gravação pelo app: teste em um celular',
	'O app Android foi testado num cabo Kuba Auri real com um Samsung Galaxy A70 (Android 11). A prévia sem gravar, a gravação e a restauração do Padrão Auri foram confirmadas pelo som, e os pacotes registrados na entrada da ponte nativa batem byte a byte com os do site no computador. Ainda não foi testado em celulares de outros fabricantes; a validação completa da gravação continua pendente. Se o som ficar estranho depois de gravar, grave o Neutro. Se não resolver, grave o Neutro pelo site no computador (Chrome ou Edge).',
	'O que os testes garantem: para cada curva, o app monta os mesmos nove reports de dados e o mesmo commit, byte a byte, que o site no computador e a página oficial enviam. Testes automáticos comparam esses bytes com a referência dos 11 presets oficiais, e antes do commit o app ainda confere cada sequência com uma guarda extra.',
	'O que ainda falta: segundo fabricante, paridade no fio e relatório assinado para encerrar a F5. Temos 1 de 2 fabricantes testados (Samsung). Os bytes foram conferidos na entrada da ponte nativa pelo logcat, não numa captura USB no fio. O wireLog ficou vazio porque a navegação ao Diagnóstico reabriu a sessão. Cada gravação pelo app continua pedindo um item a mais no checklist.'
];
// END Android validation state --------------------------------------------------------------

const androidReportHref =
	'https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml';
const androidReleasesHref = 'https://github.com/marco-jardim/open-auri/releases/latest';

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
				'Header confirmado: 45 51 31 23 D6 00 00 0A 04 05 01 0A 00 00. “EQ1#” é ASCII; D6 00 é o comprimento 14 + 20 × 10 = 214 e os dois 0A são o número de seções, como o app oficial WalkPlay calcula. Os bytes 6 e 12–13 permanecem desconhecidos.',
				'WebHID usa report ID 0xCB e dados de 31 B (o ID fica fora deles). Reports 0 a 6 levam índice + 30 B; report 7 leva 10 B e padding zero; report 8 leva só o índice e zeros. Há 16 ms após cada report, depois 150 ms e commit 01 65 00 01 FF completado com zeros até 31 B: 294 ms nominais mais overhead. A equivalência do padding do commit no firmware ainda exige teste.',
				'Q23 guarda ganho linear: round(10^(dB/20) × 2²³). Q27 usa round(coef × 2²⁷). O CRC16-CCITT-FALSE cobre os primeiros 218 B: poly 0x1021, init 0xFFFF, sem reflexão ou XOR final, anexado little-endian. Integridade não prova autenticidade ou segurança.',
				'A amostragem ilustrada é a 96 kHz, com dobra em 48 kHz. Para 48 < f < 96 kHz, f_alias = 96 − f. O desenho não mede o clock real nem a entrada analógica. Os widgets são exemplos locais do codec, nunca autorização para gravar.'
			]
		},
		{
			id: 'protocolo-cabo',
			title: 'Protocolo do cabo',
			paragraphs: [
				'O app oficial de PEQ da WalkPlay contém uma classe de dispositivo (grupo CB, log CB1100AU) que fala exatamente este protocolo e confirma o formato da seção anterior: report 0xCB, 9 pacotes com índice + 30 B, coeficientes Q27, preamp Q23, magic EQ1# e CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021) sobre os bytes anteriores, anexado little-endian. O caminho principal do app, porém, cria a classe genérica CB pelo report 0x4B, que o Auri não expõe; a classe CB1100AU fica fora desse caminho. Ela declara 48 kHz, mas calcula os filtros com π·f/48000, o mesmo que 2π·f/96000: o projeto efetivo é a 96 kHz, como na página do kuba e no open-auri.',
				'Frame: 45 51 31 23, comprimento u16 LE = 14 + 20 × n, depois 00 n 04 05 01 n 00 00, o preamp e n seções [b0, b2, −a1, b1, −a2]. O app oficial envia só os n filtros ativos; a página da Kuba e o open-auri sempre enviam 10, com as bandas desligadas como identidade. Frames com menos de 10 seções não foram testados neste cabo.',
				'Depois dos dados vem o comando final: 01 tag 00 01 FF salva na flash; 01 tag 00 00 FF aplica sem salvar. Com a tag 0x65, salvar é exatamente o commit da página da Kuba (01 65 00 01 FF). Os dados sozinhos já aplicam ao vivo (medido no cabo); o efeito do comando oficial de aplicar sem salvar ainda não foi medido.',
				'O protocolo tem uma só leitura: a tag de EQ. O pedido 80 00 00 00 FF, no report 0xCB, recebe a resposta 80 tag. No Auri real a resposta foi 80 65 00 00 FF, ou seja, tag 0x65 (101).',
				'Não temos leitura validada da versão de firmware nem da curva gravada neste cabo. O app oficial marca essas funções como não suportadas; isso não prova inexistência no firmware. Também marca como não suportados modos e balanço do DAC, offsets de microfone e reset. A última curva conhecida é a registrada neste aparelho, não uma leitura do cabo.',
				'O brief TTGK TT39510B01 descreve o bridge de áudio USB CB5100, com DSP e EQ integrados ao app Walk Play, mas não traz o protocolo HID. Se o Auri usa exatamente esse chip ou uma variante CB1100AU não está confirmado.',
				'A decriptação externa de três downloads WalkPlay, para os PIDs 43CC, 43CD e C20F, foi validada localmente: AES-128-ECB, sem IV, com PKCS7 e chave textual UTF-8(MD5(code).hex.slice(0,16)), usando o campo value.code da UI. São 16 caracteres do digest como texto, não bytes decodificados de hex. Isso é separado do Base64 + XOR das respostas JSON, cuja chave ASCII literal é d2Fsa3BsYXlAMjAyNS4uLw==; não se aplica AES duas vezes.',
				'Os três resultados têm container SPV@, cabeçalho de 32 B e quatro entradas CPU/MOD/PBK/EXT de 16 B. A validação cobre padding, tabela e limites das entradas não vazias; entradas vazias são apenas metadados e podem apontar além do fim do arquivo. Não foram validados checksum ou autenticidade. A região interna EncryptAddr/EncryptSize ainda está em estudo: não é decriptação completa do código nem reconstrução integral do protocolo, identificação da CPU ou prova de compatibilidade com o Auri. O guia técnico abaixo traz fontes, hashes e um script Node local que não sobrescreve arquivos; não executa firmware nem envia dados ao cabo.'
			],
			links: [
				{ label: 'App oficial WalkPlay PEQ', href: 'https://peq.szwalkplay.com/' },
				{
					label: 'Espelho offline do app (Ircama/walkplay)',
					href: 'https://github.com/Ircama/walkplay'
				},
				{
					label: 'Brief do chip TT39510B01 (PDF)',
					href: 'https://szttgk.com/uploads/files/20240725/51fad44bb79a05a35046af38b0017de5.pdf'
				},
				{
					label: 'CB5100PRO na TTGK',
					href: 'https://szttgk.com/en/product/HIFIhighfidelityaudiomodule/815.html'
				},
				{
					label: 'docs/protocol-0xcb.md no GitHub',
					href: 'https://github.com/marco-jardim/open-auri/blob/main/docs/protocol-0xcb.md'
				},
				{
					label: 'Guia de decriptação externa do firmware (Node local)',
					href: 'https://github.com/marco-jardim/open-auri/blob/main/docs/firmware-analysis.md'
				}
			]
		},
		{
			id: 'limites',
			title: 'Limites físicos',
			paragraphs: [
				'O formato conhecido oferece 10 seções, uma curva para os dois canais e taxa de projeto de 96 kHz (0 < f < 48 kHz). Não oferece EQ L/R independente, crossfeed, compressor, reverb, volume do cabo ou seletor do filtro do DAC.',
				'A única leitura validada do cabo é a tag de EQ: não temos read-back validado da curva nem da versão de firmware, verify, pull ou rollback. Journal, snapshot e localStorage registram o envio no host, não o estado atual do cabo. Clock fixo e realização interna do DSP ainda não foram medidos.'
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
				'O volume da prévia é só no navegador. A aritmética interna do chip é desconhecida. Ouvir pela saída do próprio cabo soma a curva já persistida. Para ouvir só a curva, use Ouvir no cabo (Curva), Comparar no cabo (Comparar, Soe como X, Comunidade e Biblioteca) ou a aba No cabo (Teste cego): a curva vai para a memória do cabo, sem gravar, o navegador toca sem EQ e, ao desconectar, o cabo volta à curva salva. Ou use outra saída, ou grave Neutro explicitamente antes. O teste cego no navegador não grava no cabo.'
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
				'Existe aplicação só em RAM ou verificação do CRC no firmware? Read-back da curva não foi validado: a única leitura validada do cabo é a tag de EQ.',
				'O que significam outras tags além de 0x65 e a flag que nega o preamp no app oficial? O cabo aceita frames com menos de 10 seções? Aplicar sem salvar (01 65 00 00 FF) muda algo em relação a enviar só os dados?',
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
			],
			links: [{ label: 'Licenças completas das dependências', href: '/third-party-licenses.txt' }]
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
		},
		{
			id: 'windows-volume',
			title: 'O volume do Windows não muda o fone',
			paragraphs: [
				'Se o nível muda no Windows, mas o volume do Auri continua igual, reinicie o serviço “Áudio do Windows” pelo aplicativo Serviços ou reinicie o PC. Abaixe o volume antes de testar de novo. Na bancada, era um estado travado dos serviços de áudio para esse dispositivo, não defeito do cabo; regravar a curva e reconectar o cabo não resolveu.'
			]
		},
		{
			id: 'android',
			title: 'App Android',
			paragraphs: [
				'O app Android do open-auri grava curvas no cabo Auri pelo USB do celular, coisa que o navegador do celular não consegue: o Chrome Android não tem WebHID. O app abre o próprio site open-auri.com e troca só o último trecho, até o USB, por um transporte nativo. Editor, presets, biblioteca, conta e comunidade são os mesmos do site.',
				'Requisitos: Android 8 ou mais novo, suporte a USB host (OTG) e o Android System WebView atualizado. Com uma WebView antiga, o app mostra uma tela pedindo a atualização. Sem USB host, o site avisa que o aparelho não suporta OTG e fica no modo simulado.'
			],
			browserOnly: {
				paragraphs: [
					'Onde baixar: na Google Play, quando a publicação for aprovada, e no GitHub Releases, onde cada versão traz o APK, o AAB e o arquivo SHA256SUMS.txt. As duas fontes usam a mesma assinatura, então dá para trocar de uma para a outra sem desinstalar.'
				],
				links: [{ label: 'Baixar no GitHub Releases', href: androidReleasesHref }]
			},
			appOnly: {
				paragraphs: ['Atualize o app pela Google Play.'],
				links: [
					{
						label: 'Abrir na Google Play',
						href: 'https://play.google.com/store/apps/details?id=com.openauri.app'
					}
				]
			}
		},
		{
			id: 'android-validacao',
			title: 'Estado de validação do app',
			paragraphs: androidValidationState,
			links: [
				{ label: 'Relatar resultado', href: androidReportHref },
				{
					label: 'Relatório do teste em hardware',
					href: 'https://github.com/marco-jardim/open-auri/blob/main/docs/android/validacao-hardware.md'
				}
			]
		},
		{
			id: 'android-resgate',
			title: 'Como resgatar com o Neutro',
			paragraphs: [
				'Se o som ficar estranho depois de gravar pelo app, abaixe o volume e grave o Neutro pelo próprio app, na página do cabo. Neutro é 10 × OFF, identidade exata, com preamp −0,5 dB: o cabo volta a tocar sem equalização.',
				'Se não resolver, grave o Neutro pelo site num computador com Chrome ou Edge: conecte o cabo, autorize o WebHID e use Neutro na página do cabo. Esse caminho não passa pelo app.',
				'Depois, relate o resultado, tenha funcionado ou não. O formulário no GitHub pede aparelho, versão do Android, versão do app, versão da WebView, origem da instalação (Play ou GitHub), o JSON do Diagnóstico USB e o que aconteceu. Cada relato ajuda a validar o app em mais aparelhos.'
			],
			links: [{ label: 'Relatar resultado', href: androidReportHref }]
		},
		{
			id: 'android-usb',
			title: 'Permissão USB no app',
			paragraphs: [
				'Na página do cabo, Conectar lista os cabos Auri ligados ao celular (VID 0x3302, PID 0x8902) e o Android pergunta se o open-auri pode acessar o dispositivo USB. Sem essa permissão, nada é enviado. Com mais de um cabo, um seletor do app faz o papel do seletor do WebHID.',
				'O que não muda: o mesmo gate v2, o mesmo checklist e o mesmo diário do site, com o mesmo codec e os mesmos bytes. Nada é gravado sem o seu gesto em Gravar no cabo, e desconectar no meio da gravação interrompe sem commit.',
				'O que muda: só o trecho final, do site até o USB, passa por código nativo do app, com uma guarda extra que confere cada sequência antes do commit. Downloads abrem o seletor de arquivos do Android, e links externos abrem no navegador do sistema. O app pede só acesso à internet e, quando você conecta o cabo, ao USB. Antes de cada gravação, o app confirma com o servidor a versão publicada do site. Se essa confirmação falhar (sem conexão ou servidor indisponível), a gravação segue com a última confirmação desta mesma versão, e o app mostra a data dela; sem nenhuma confirmação, ou depois que o app viu uma versão mais nova ou a gravação desligada, a gravação é recusada.'
			]
		},
		{
			id: 'android-diagnostico',
			title: 'Diagnóstico USB',
			paragraphs: [
				'O Diagnóstico USB fica na camada Engenharia e só existe no app. Ele mostra os descritores do dispositivo, da configuração e do HID report, a interface e o endpoint escolhidos e o tamanho calculado do output report.',
				'Copiar põe tudo isso em JSON na área de transferência, para colar no relato do resultado. Nada é enviado ao servidor: o JSON só sai do aparelho se você o colar em algum lugar.'
			],
			links: [{ label: 'Relatar resultado', href: androidReportHref }]
		},
		{
			id: 'android-iphone',
			title: 'Por que não há iPhone',
			paragraphs: [
				'Não há API pública que deixe um app de iPhone enviar ao cabo o output report HID de que a gravação precisa, e o Safari não tem WebHID. No iPhone, use o site para editar, comparar e ouvir prévias; para gravar, use um computador com Chrome ou Edge ou um celular Android com o app.'
			],
			items: [
				'CoreHID, a API de HID da Apple, só existe no macOS 15 ou mais novo.',
				'External Accessory só conversa com acessórios do programa MFi, certificados pela Apple.',
				'USBDriverKit só roda em iPad com chip da série M e exige um entitlement concedido pela Apple.'
			]
		},
		{
			id: 'android-assinatura',
			title: 'Verificar a assinatura',
			paragraphs: ['A Google Play verifica a assinatura ao instalar e atualizar o app.'],
			browserOnly: {
				paragraphs: [
					'Cada versão do app sai assinada com a mesma chave na Google Play e no GitHub. Junto com cada release são publicados o SHA-256 do APK e do AAB, também no arquivo SHA256SUMS.txt, e o fingerprint SHA-256 do certificado de assinatura, que é o mesmo nas duas fontes.',
					'Para conferir o APK baixado do GitHub, calcule o SHA-256 do arquivo (com sha256sum ou Get-FileHash, por exemplo) e compare com o SHA256SUMS.txt. Para conferir o certificado, rode apksigner verify --print-certs no APK e compare o SHA-256 do certificado com o fingerprint publicado. Se algo não bater, não instale.'
				],
				links: [{ label: 'Releases e SHA256SUMS.txt', href: androidReleasesHref }]
			}
		},
		{
			id: 'android-privacidade',
			title: 'Privacidade do app',
			paragraphs: [
				'O app não coleta nada além do que o site já coleta: ele abre o mesmo open-auri.com, com as mesmas regras da política de privacidade, e não acrescenta nenhuma coleta própria.',
				'Curvas, diário e configurações ficam no armazenamento do app, neste aparelho, como ficariam no navegador, e não entram no backup do Android. O Diagnóstico USB e os bytes enviados ao cabo não saem do aparelho. Na lista de sessões da conta, as sessões abertas pelo app aparecem como “App Android”.'
			]
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
