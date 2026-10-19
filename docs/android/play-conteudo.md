# Conteúdo do app na Google Play (P4)

Referência: 2026-10-19. Pacote: `com.openauri.app`. Preencher na ordem do Anexo H.2 (`docs/plans/2026-10-18-android-capacitor-plano.md:2758-2762`). Caminhos e linhas são relativos à raiz do repositório. Não registrar credenciais nem dados pessoais do mantenedor neste arquivo.

## 1. Política de privacidade

**URL:** https://open-auri.com/privacidade

O conteúdo oficial é `docs/legal/politica-de-privacidade.md`, importado pela página em `web/src/lib/content/docs/privacy.pt-BR.ts:1-4`. A política cobre o serviço usado pela WebView, inclusive conta opcional, segurança, registros de acesso, terceiros, exportação e exclusão. Não usar uma página que diga "não coletamos dados".

## 2. Acesso ao app

O utilitário funciona sem login. A conta opcional libera funções sociais e exige e-mail verificado (`docs/legal/politica-de-privacidade.md:66-70`). A gravação exige o cabo Kuba Auri via USB-C/OTG. Sem o cabo, o restante do utilitário pode ser avaliado; não confundir indisponibilidade do hardware com exigência de login. O aviso de operação ainda não validada em cabo real é intencional, não um erro a esconder (`docs/plans/2026-10-18-android-capacitor-plano.md:2060-2065`).

**Seleção no Console:** há partes restritas, porque `/conta`, publicação, favoritos e outras ações sociais exigem autenticação. Não marcar "todas as funcionalidades disponíveis sem restrição" só porque o utilitário principal dispensa conta. A denúncia exige conta verificada no próprio handler (`web/src/routes/api/v1/reports/+server.ts:37-53`).

**Instruções para colar no campo do revisor, em inglês conforme a exigência da Play** (`docs/android/play-requisitos.md:66`):

```text
open-auri is an audio equalizer utility. The main utility works without signing in.
You can browse curves, edit equalization, preview sound using a local audio file,
and inspect the interface without an account or the cable.

Writing equalization to hardware requires a compatible Kuba Auri USB-C cable,
connected to the Android device through USB-C/USB OTG. Android USB permission
is granted locally when connecting the cable. Without this cable, all other
non-hardware functionality can be evaluated; the USB write itself cannot.
The notice that writing has not yet been validated on a real cable is intentional.
Do not treat that notice as a sign-in failure or a request to bypass a safety check.

An account is optional and is used for community actions and account management.
Public community content can be viewed without signing in. Account creation may
be temporarily disabled; this does not prevent reviewing the main utility.
For account-only features, use the reusable review account provided separately
in the Play Console access fields. No administrator access is needed.

Optional hardware demonstration video: [MAINTAINER: insert a public, accessible
video URL, or remove this line if no video is provided].
```

**Ação do mantenedor antes de enviar:** se a revisão incluir recursos sociais, fornecer conta de revisão já verificada, comum e reutilizável nos campos privados do Console. Não exigir que o revisor crie conta, controle uma caixa de e-mail, peça código ao mantenedor ou tenha papel de administrador. Não colocar credenciais neste repositório. Testar as instruções na release após integrar USB/SAF; o shell lido nesta etapa ainda é mínimo (`apps/android/android/app/src/main/java/com/openauri/app/MainActivity.kt:1-5`). A disponibilidade de cadastro é controlada em `web/src/routes/criar-conta/+page.server.ts:14-29`.

**Vídeo opcional:** `[PREENCHER_PELO_MANTENEDOR: URL pública do vídeo demonstrando conexão e gravação USB]`. Se não houver vídeo, remover o marcador do texto submetido. Não inventar URL nem resultado de teste com cabo.

## 3. Anúncios

**Resposta: não, o app não contém anúncios.** Não há monetização por anúncios no utilitário; o script de estatísticas inserido em produção é o Simple Analytics, não uma rede de publicidade (`web/src/lib/server/analytics.ts:23-34`). Turnstile é proteção contra robôs, não publicidade (`web/src/lib/server/security/turnstile.ts:11-19`). A política explicita ausência de cookies de publicidade, venda de dados e e-mail de marketing (`docs/legal/politica-de-privacidade.md:25`, `docs/legal/politica-de-privacidade.md:204-219`). Conferir novamente as dependências e o manifesto mesclado do AAB final, sem tratar esta leitura como inspeção do binário.

## 4. Classificação de conteúdo (IARC)

Selecionar **app de utilidade/ferramenta de música e áudio, não jogo**. Preencher o e-mail de contato exigido diretamente no Console; nenhum dado pessoal do mantenedor deve ser copiado para cá. A classificação final é calculada pelo IARC para cada território. **13+ é o público-alvo, não uma classificação IARC pré-aprovada.** Não prometer classificação Livre/Everyone ou forçar resultado.

O questionário varia por categoria e território. Usar as respostas abaixo para os campos equivalentes, sem afirmar que UGC é um catálogo inteiramente revisado antes de publicação.

| Pergunta/tema | Resposta e motivo |
|---|---|
| Violência, sangue, mutilação, terror ou crueldade no conteúdo fornecido pelo desenvolvedor | Não. O produto edita parâmetros de equalização; curvas e versões são dados numéricos e texto (`web/migrations/0004_social.sql:14-22`, `web/migrations/0004_social.sql:66-79`). Não há cenas/jogo. |
| Nudez, conteúdo sexual ou serviços de encontro | Não como funcionalidade ou conteúdo editorial. Perfis são créditos de autores de curvas, não serviço de namoro. Bio e descrições são UGC; não declarar impossível a ocorrência de texto impróprio. |
| Linguagem imprópria/ofensiva | Não é conteúdo editorial pretendido. **Se a pergunta incluir conteúdo que usuários podem criar/encontrar, responder sim para possibilidade de texto ofensivo em UGC**, não "nenhum risco": há bio, apelido, nome/descrição de curvas e packs. Não há filtro automático de palavrões comprovado. |
| Drogas, álcool, tabaco ou incentivo ao seu consumo | Não no conteúdo editorial nem como finalidade do app. Para pergunta sobre UGC, manter a ressalva de texto não pré-curado. |
| Apostas, jogos de azar, cassino simulado ou prêmios em dinheiro | Não. Notas S7 e preferências S6 são avaliações de equalização, não apostas (`web/migrations/0005_s6_s7.sql:20-27`, `web/migrations/0005_s6_s7.sql:38-53`). |
| Compras, itens aleatórios pagos, loot boxes ou compras digitais | Não. Curvas/favoritos/instalações não são compras. Não há pagamento no fluxo de publicação; `payment=()` em `web/src/lib/server/security/headers.ts:95`. |
| Compartilha localização física do usuário com outros usuários | Não. Perfis e curvas não têm coordenadas (`web/src/lib/server/account/profile.ts:16-32`, `web/migrations/0004_social.sql:44-79`); geolocalização bloqueada em `web/src/lib/server/security/headers.ts:87`. IP legal não é exibido à comunidade. |
| Permite interação, troca ou compartilhamento de conteúdo entre usuários | **Sim.** Publicação de curvas, versões, forks e packs, perfis e troca S7. A ausência de chat não elimina UGC (`web/migrations/0004_social.sql:44-79`, `web/migrations/0004_social.sql:203-234`, `web/migrations/0005_s6_s7.sql:32-53`). |
| Contém conteúdo gerado por usuários acessível a outros | **Sim.** Apelidos, bio e textos de curvas/packs; conteúdo pode ser público, não listado ou privado. Não classificar o serviço como inteiramente fechado/offline. |
| Chat, mensagens privadas ou comentários livres entre usuários | **Não.** Não há esse recurso no schema social. S7 troca curvas e notas numéricas, não mensagens; nota da denúncia só chega à moderação (`web/src/routes/api/v1/reports/+server.ts:1-3`). |
| Usuário pode denunciar conteúdo e perfis inadequados | **Sim, com conta e e-mail verificado.** Alvos `lineage`, `pack`, `user`; motivo e nota de até 500 caracteres. Há Turnstile e cota de 30/dia (`web/migrations/0004_social.sql:240-250`, `web/src/routes/api/v1/reports/+server.ts:16-41`). |
| Há moderação e remoção de conteúdo abusivo | **Sim.** Ocultação automática por 3 contas elegíveis (2 se a curva atual é YOLO), com idade mínima de 3 dias, seguida de fila e decisão administrativa; ocultar, restaurar, remover, dispensar ou banir autor (`web/src/lib/server/social/moderation.ts:48-63`, `web/src/lib/server/social/moderation.ts:219-242`, `web/src/lib/server/social/moderation.ts:331-415`). |
| Conteúdo é todo aprovado antes de aparecer / filtro garante ausência de material impróprio | **Não.** Existe moderação por denúncia, não aprovação editorial prévia de toda publicação. Gate de segurança da curva não é filtro semântico universal. |
| Pode bloquear outro usuário individualmente | **Não há bloqueio individual comprovado.** Banimento administrativo existe, mas não é botão de bloquear à disposição de cada usuário. Não responder sim usando o ban da administração como substituto. Conferir a exigência aplicável de UGC antes da publicação. |
| Controles parentais próprios | Não comprovados no serviço. Conta é 18+, mas isso não é controle parental do aparelho. Não anunciar um recurso inexistente. |
| Navegador aberto, busca na internet irrestrita ou acesso livre a sites externos | Não. É uma WebView de origem definida, não navegador geral (`apps/android/capacitor.targets.mjs:4`, `apps/android/capacitor.targets.mjs:65-86`). Links externos não são um histórico de navegação oferecido pelo app. |
| Conteúdo noticioso, político editorial, compras físicas ou serviços regulados | Não. O acervo é de equalizações da comunidade, não notícias, mercado, aconselhamento financeiro ou atendimento clínico. |

**Provas de regras e tratamento de denúncias:** os termos proíbem conteúdo perigoso e abusivo e permitem revisão pelo canal da política (`web/src/lib/content/legal/terms.pt-BR.ts:54-64`); o handler de denúncia valida alvos, motivo e nota e exige conta verificada; a moderação conserva trilha de auditoria. Isso comprova denúncia/moderação, não ausência de todo abuso nem execução contínua de uma equipe humana. O mantenedor deve assegurar atendimento efetivo da fila em produção. Não enviar resposta dizendo que inexistem usuários interagindo ou que nenhum UGC pode conter linguagem imprópria.

## 5. Público-alvo e conteúdo

**Faixas:** 13 a 15, 16 a 17 e 18 anos ou mais, se forem essas as opções do Console. Não selecionar menores de 13. **Não direcionado a crianças; não participar do programa Families como app infantil.** O posicionamento é ferramenta de equalização/áudio para quem usa o cabo e quer ajustar som, sem personagens, jogos ou incentivos infantis. O plano especifica maiores de 13 sem foco em crianças (`docs/plans/2026-10-18-android-capacitor-plano.md:2057-2059`).

**Distinção importante:** a política permite uso anônimo a todos, mas **contas são para 18+** (`docs/legal/politica-de-privacidade.md:302-304`; `docs/lgpd.md:56`). Assim, adolescentes de 13 a 17 são público apenas do uso sem conta. Não escrever "cadastro liberado a partir de 13". O formulário de cadastro lido não pede data de nascimento (`web/src/lib/components/auth/SignUpForm.svelte:31-79`); não há comprovação de age gate robusto. A política permitir uso anônimo por menores não significa que a ficha deva ser dirigida a crianças. Revisar essa distinção na ficha e nas capturas antes de publicar.

## 6. Segurança dos dados (Data safety)

Copiar a matriz e as respostas gerais de [data-safety.md](./data-safety.md), incluindo a coleta do site carregado na WebView. Não selecionar "não coletamos dados" nem "todos os dados são processados efemeramente".

Resumo: conta/perfil opcionais; IP/registros legais e segurança nas requisições; atividade, UGC e preferências S6; diagnóstico; estatísticas Simple Analytics; Turnstile e e-mail transacional por prestadores. O S6 é tratado conservadoramente como informação de saúde na declaração de dados, sem transformar o produto em recurso médico. Criptografia em trânsito: sim para a release de produção. Exclusão/gestão em https://open-auri.com/conta e instruções na política. Há ressalvas de retenção legal e de terceiros. Resolver as pendências e divergências listadas no final de `data-safety.md` antes da confirmação definitiva no Console.

## 7. ID de publicidade

**Resposta: não usa ID de publicidade.** O manifesto contém somente a permissão `android.permission.INTERNET` (`apps/android/android/app/src/main/AndroidManifest.xml:38-41`), sem `com.google.android.gms.permission.AD_ID`. O shell lido apenas estende `BridgeActivity` (`apps/android/android/app/src/main/java/com/openauri/app/MainActivity.kt:1-5`). Simple Analytics usa script de contagem, não integração com Advertising ID (`web/src/lib/server/analytics.ts:23-34`). Tokens de sessão, IP/hash e sinais do Turnstile declarados em Data safety não são Advertising ID. Verificar também o manifesto mesclado da release, pois uma dependência futura poderia acrescentar permissão.

## 8. Recursos financeiros

**Selecionar: "Meu app não oferece recursos financeiros".** Não há banco, pagamento, transferência, empréstimo, investimento, crédito, criptoativo, seguro ou aconselhamento financeiro. Licença CC, favoritos, ranking e troca S7 não movimentam dinheiro (`web/migrations/0004_social.sql:66-79`, `web/migrations/0004_social.sql:138-143`, `web/migrations/0005_s6_s7.sql:32-53`). A declaração é obrigatória mesmo quando não se aplica (`docs/android/play-requisitos.md:68`).

## 9. Apps de saúde

**Selecionar: "Meu app não oferece recursos de saúde".** É utilitário de música/áudio e programação de equalização, não diagnóstico, tratamento, triagem, exame auditivo clínico, acompanhamento de doença, prontuário, condicionamento físico ou pesquisa médica. Nenhuma alegação terapêutica deve constar na ficha. O schema S6 guarda escolhas entre curvas e volume igualado, não audiograma ou diagnóstico (`web/src/routes/api/v1/s6/batches/+server.ts:30-46`).

**Não confundir formulários:** a LGPD trata essas preferências como potencialmente sensíveis e exige consentimento específico (`docs/legal/politica-de-privacidade.md:144-156`). Por isso Data safety declara informação de saúde de forma conservadora. Isso não autoriza responder "não tratamos nenhum dado potencialmente relacionado à saúde". Se a interface vigente da Play considerar esse tratamento, por si só, escopo da declaração de saúde, registrar a pergunta e revisar o enquadramento antes de confirmar, sem alegar certificação médica.

## 10. Apps de governo

**Resposta: não é um app governamental nem representa órgão público.** O produto é um utilitário comunitário de equalização, com controlador próprio identificado na política (`docs/legal/politica-de-privacidade.md:30-40`), não canal oficial de serviço público. Cumprir LGPD e Marco Civil ou armazenar registros legais não torna o app governamental.

## 11. Notícias

**Resposta: não é um app de notícias nem revista.** Feed, rankings, versões e packs são conteúdo técnico de equalização criado pela comunidade, não jornalismo (`web/migrations/0004_social.sql:44-79`, `web/migrations/0004_social.sql:203-234`). Não se apresenta como veículo noticioso. Manter a ficha coerente com essa finalidade.

## Antes de confirmar os formulários

- Conferir o AAB final após integrar as tarefas nativas: permissões mescladas, USB local, SAF, ausência de telemetria nativa e bloqueio de HTTP em produção.
- Conferir os scripts externos em produção e os contratos que fundamentam as exceções de compartilhamento da Play, sem transformar alegação do fornecedor em auditoria executada.
- Preencher somente no Console o contato IARC e a conta de revisão reutilizável; preencher ou remover o vídeo opcional.
- Resolver o risco de bloqueio individual/UGC e a distinção 13+ anônimo versus 18+ com conta. Não marcar recurso de proteção inexistente.
- Rever as "Divergências encontradas" de `data-safety.md`. Este documento fornece respostas e evidências, não comprova teste USB, inspeção do AAB ou aprovação da Play.
