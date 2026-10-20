# Checklist do Play Console (P5)

Roteiro do mantenedor baseado no Anexo H.2 do plano (`docs/plans/2026-10-18-android-capacitor-plano.md:2824-2828`), depois de P2 e P4. Não contém credenciais, dados pessoais nem comprovação de submissão. Preencher dados privados somente no Console.

## Antes de preencher

- [ ] Confirmar conta de desenvolvedor ativa, identidade verificada e autenticação em duas etapas (P1).
- [ ] Abrir a política de produção em https://open-auri.com/privacidade, nos dois idiomas, e conferir vigência, contato, exclusão e ausência de texto de rascunho. A versão documental continua **2026-10-20**, ainda não publicada; não declarar que esta edição já está em produção sem conferir o deploy.
- [ ] **O controlador identificado na política de produção (`PUBLIC_LGPD_CONTROLLER`) deve ser igual ao nome de desenvolvedor exibido na ficha da Play; se forem diferentes, a política deve explicar expressamente a relação entre eles.** Comparar os valores exibidos, não apenas os nomes das variáveis. Corrigir antes de submeter.
- [ ] Disponibilizar conta comum de revisão, verificada e reutilizável, com credenciais **apenas nos campos privados do Console**, sem dependência de cadastro, caixa de e-mail, código do mantenedor ou acesso administrativo.
- [ ] Disponibilizar **vídeo demonstrativo obrigatório**, público e acessível, da conexão USB nativa e do fluxo de gravação com gate/checklist. Preencher o campo pendente em `play-conteudo.md` fora do bloco para colar e inserir a URL nos materiais de revisão. Não inventar validação em cabo real.
- [ ] Executar o smoke da release, inclusive entrada com Turnstile e saída na WebView (Anexo F.7), fluxo sem cabo, ruído rosa/arquivo local, SAF e gate de WebView desatualizada. Registrar resultados no processo de lançamento, não credenciais neste arquivo.

## 1. Criar app

- [ ] No Console, escolher "Criar app": nome **open-auri**, idioma padrão **português (Brasil)**, **app**, **gratuito**; revisar e aceitar as declarações aplicáveis.

## 2. Ficha principal da loja

- [ ] Copiar título, descrição curta e completa de [play-listing.md](./play-listing.md), pt-BR e en-US, somente os blocos de texto. Manter aviso inicial, USB nativo e identificação de projeto não oficial/independente.
- [ ] Preencher categoria Música e áudio, tags disponíveis, site e contato público diretamente no Console; não registrar dados do mantenedor no repositório.
- [ ] Regenerar e aprovar as artes de P3, com **7 capturas por idioma**, ícone e feature graphic, **16 PNGs ao todo**. Seguir os comandos em [play-listing.md](./play-listing.md#capturas-e-regeneração-p3). Conferir `3-comparar` sem sobreposição entre o botão de ajuda e o texto acima do título nos dois idiomas.
- [ ] Conferir `7-native-connect`: página Cabo com painel USB Android conectado, lâmpada Conectado acesa e aviso de gravação ainda não testada visível, sem abrir o checklist. A spec é opt-in (`PLAY_SCREENSHOTS=1`) e usa dispositivo falso pelo bridge nativo: não é prova de teste em hardware nem substitui o vídeo obrigatório.

## 3. Conteúdo do app, na ordem

Usar [play-conteudo.md](./play-conteudo.md) e [data-safety.md](./data-safety.md), sem copiar marcadores internos.

- [ ] Política de privacidade: https://open-auri.com/privacidade, acessível sem login.
- [ ] Acesso ao app: declarar partes restritas, colar as instruções em inglês e fornecer conta de revisão e vídeo obrigatórios nos campos apropriados. Conferir Menu > Cabo > Conectar pelo USB do Android, seletor Android, mensagem sem dispositivo e Diagnóstico USB com cabo. Testar página de curva > `Denunciar <nome>` / Ocultar esta curva; apelido do autor > perfil > `Denunciar <apelido>` / Ocultar este autor; Comunidade > selecionar curva > Mais da mesa > gaveta Denunciar.
- [ ] Anúncios: não.
- [ ] IARC: ferramenta de música/áudio, não jogo; classificar conteúdo do desenvolvedor e declarar UGC em "usuários interagem". Confirmar denúncia na página de curva, perfil, criações, packs, favoritos do perfil, fontes de comparação, candidatos do teste cego e Comunidade. Confirmar moderação e "Ocultar este autor/esta curva" nesta release (local para visitantes, sincronizado para contas).
- [ ] Público-alvo: **somente 18 anos ou mais**, inclusive uso sem conta; não direcionado a menores e não inscrito como app infantil/Families. Não confundir público-alvo com resultado IARC ou alegar verificação etária inexistente.
- [ ] Data safety: declarar coleta, incluindo a WebView; **localização aproximada coletada e compartilhada com Simple Analytics para Analytics**, país derivado do fuso horário, não requisito de conta. Conferir toda a matriz, criptografia, exclusão e retenções, sem marcar todos os fluxos como efêmeros.
- [ ] ID de publicidade: não; conferir também manifesto mesclado do AAB final.
- [ ] Recursos financeiros: não oferece.
- [ ] Apps de saúde: não oferece recursos de saúde; manter declaração conservadora de preferências S6 em Data safety e revisar qualquer pergunta do Console que altere esse enquadramento.
- [ ] Apps de governo: não.
- [ ] Notícias: não.

## 4. Conferência e retorno

- [ ] Resolver pendências de contratos, retenção/sinais de terceiros e inspeção do AAB indicadas em Data safety antes da confirmação definitiva.
- [ ] Conferir política/ficha/publicação 18+, dados, UGC, instruções e artes contra a release real, sem placeholders em campos submetidos.
- [ ] Informar ao agente o que ficou pendente ou foi recusado, com o texto exato do erro do Console e sem credenciais ou dados pessoais. Não marcar envio/aprovação sem evidência.
- [ ] Prosseguir para assinatura/registro (P6) e publicação (P7) somente quando as etapas anteriores estiverem concluídas; este checklist não substitui o runbook de release.
