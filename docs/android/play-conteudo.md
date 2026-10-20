# Conteúdo do app na Google Play (P4)

Referência: 2026-10-20. Pacote: `com.openauri.app`. Preencher na ordem do Anexo H.2 (`docs/plans/2026-10-18-android-capacitor-plano.md:2824-2828`), usando o checklist [play-console-passos.md](./play-console-passos.md). Caminhos e linhas são relativos à raiz do repositório. Não registrar credenciais nem dados pessoais do mantenedor neste arquivo.

## 1. Política de privacidade

**URL:** https://open-auri.com/privacidade

O conteúdo oficial é `docs/legal/politica-de-privacidade.md`, importado pela página em `web/src/lib/content/docs/privacy.pt-BR.ts:1-4`. A política cobre o serviço usado pela WebView, inclusive conta opcional, segurança, registros de acesso, terceiros, exportação e exclusão. Não usar uma página que diga "não coletamos dados".

## 2. Acesso ao app

O utilitário funciona sem login. A conta opcional libera funções sociais e exige e-mail verificado (`docs/legal/politica-de-privacidade.md:70-74`). A gravação exige o cabo Kuba Auri via USB-C/OTG. Sem o cabo, o restante do utilitário pode ser avaliado; não confundir indisponibilidade do hardware com exigência de login. O aviso de operação ainda não validada em cabo real é intencional, não um erro a esconder (`docs/plans/2026-10-18-android-capacitor-plano.md:2783-2807`).

**Seleção no Console:** há partes restritas, porque `/conta`, publicação, favoritos e outras ações sociais exigem autenticação. Não marcar "todas as funcionalidades disponíveis sem restrição" só porque o utilitário principal dispensa conta. A denúncia exige conta verificada no próprio handler (`web/src/routes/api/v1/reports/+server.ts:37-53`).

**Instruções para colar no campo do revisor, em inglês conforme a exigência da Play** (`docs/android/play-requisitos.md:66`):

```text
open-auri is an audio equalizer utility. The main utility works without signing in.
It is intended for adults aged 18 or over. You can browse curves, edit equalization,
preview sound using pink noise or a local audio file, and inspect the interface
without an account or the cable.

If the app first shows an Android System WebView update screen, update the active
WebView provider using that screen's button, then reopen the app. This compatibility
gate runs before the app content loads; it is not a sign-in or subscription screen.

Writing equalization to hardware requires a compatible Kuba Auri USB-C cable,
connected to the Android device through USB-C/USB OTG. Open Menu > Cabo (Cable) >
Conectar (Connect over Android USB) to open the native Android device picker and
grant USB permission locally. Without a cable, the app reports that no compatible
device was found. With a cable connected, the Engineering layer on the Cable page
shows USB Diagnostics. Without a cable, all non-hardware functionality can still
be evaluated; the USB write itself cannot.
The notice that writing has not yet been validated on a real cable is intentional.
Do not treat that notice as a sign-in failure or a request to bypass a safety check.

An account is optional and is used for community actions and account management.
Public community content can be viewed without signing in. Account creation may
be temporarily disabled; this does not prevent reviewing the main utility.
For account-only features, sign in using the verified, reusable review account
provided in the private Play Console access fields. No administrator access,
new account, email inbox access or code from the maintainer is needed.
From community content, verified users can report inappropriate content.
Hide this author / Hide this curve is available in this release: hiding is local
for visitors and synced for signed-in accounts.

The required hardware demonstration video is provided in the Console's review
materials. It demonstrates native USB connection and the guarded write flow.
```

**Checklist obrigatório do mantenedor antes de enviar (fora do bloco para colar):**

- Fornecer conta de revisão já verificada, comum e reutilizável nos campos privados do Console. É **obrigatória**, pois há recursos restritos. Credenciais somente no Console, nunca no repositório. Não exigir cadastro, caixa de e-mail, código do mantenedor ou papel de administrador.
- **Vídeo demonstrativo obrigatório:** `[PREENCHER_PELO_MANTENEDOR: URL pública e acessível do vídeo de conexão USB nativa e fluxo de gravação com gate/checklist]`. Inserir o link nos materiais de revisão do Console. Não submeter sem ele; não inventar URL ou alegar validação de hardware inexistente.
- Verificar entrada com Turnstile e saída na WebView da **release** no smoke de lançamento, Anexo F.7 (`docs/plans/2026-10-18-android-capacitor-plano.md:2773`). Registrar o resultado antes do envio; esta documentação não afirma que o smoke já foi executado.
- Testar as instruções com e sem cabo, incluindo Diagnóstico USB na camada Engenharia, ruído rosa e tela de atualização da WebView. `MainActivity` já registra USB/SAF e aplica o gate antes de carregar a WebView (`apps/android/android/app/src/main/java/com/openauri/app/MainActivity.kt:37-88`); não é um shell mínimo. A disponibilidade de cadastro é controlada em `web/src/routes/criar-conta/+page.server.ts:14-29`.

## 3. Anúncios

**Resposta: não, o app não contém anúncios.** Não há monetização por anúncios no utilitário; o script de estatísticas inserido em produção é o Simple Analytics, não uma rede de publicidade (`web/src/lib/server/analytics.ts:23-34`). Turnstile é proteção contra robôs, não publicidade (`web/src/lib/server/security/turnstile.ts:11-19`). A política explicita ausência de cookies de publicidade, venda de dados e e-mail de marketing (`docs/legal/politica-de-privacidade.md:27`, `docs/legal/politica-de-privacidade.md:211-228`, `docs/legal/politica-de-privacidade.md:245`). Conferir novamente as dependências e o manifesto mesclado do AAB final, sem tratar esta leitura como inspeção do binário.

## 4. Classificação de conteúdo (IARC)

Selecionar **app de utilidade/ferramenta de música e áudio, não jogo**. Preencher o e-mail de contato exigido diretamente no Console; nenhum dado pessoal do mantenedor deve ser copiado para cá. A classificação final é calculada pelo IARC para cada território. **18+ é o público-alvo, não uma classificação IARC pré-aprovada.** Não prometer classificação Livre/Everyone ou forçar resultado.

**Regra única:** classificar o conteúdo fornecido pelo desenvolvedor nas perguntas de conteúdo; declarar UGC na pergunta **"usuários interagem" (users interact)** e nos campos de interação/moderação correspondentes. Não usar a mera possibilidade de texto ofensivo em UGC para responder sim às perguntas de conteúdo editorial. O questionário varia por categoria e território; seguir essa regra nos campos equivalentes, sem afirmar que UGC é um catálogo inteiramente revisado antes de publicação.

| Pergunta/tema | Resposta e motivo |
|---|---|
| Violência, sangue, mutilação, terror ou crueldade no conteúdo fornecido pelo desenvolvedor | Não. O produto edita parâmetros de equalização; curvas e versões são dados numéricos e texto (`web/migrations/0004_social.sql:14-22`, `web/migrations/0004_social.sql:66-79`). Não há cenas/jogo. |
| Nudez, conteúdo sexual ou serviços de encontro | Não como funcionalidade ou conteúdo editorial. Perfis são créditos de autores de curvas, não serviço de namoro. Bio e descrições são UGC; não declarar impossível a ocorrência de texto impróprio. |
| Linguagem imprópria/ofensiva | Não no conteúdo fornecido pelo desenvolvedor. UGC é declarado em "usuários interagem": bio, apelido e textos de curvas/packs podem conter abuso e são sujeitos a denúncia, ocultação e moderação, não pré-aprovação universal. |
| Drogas, álcool, tabaco ou incentivo ao seu consumo | Não no conteúdo fornecido pelo desenvolvedor nem como finalidade do app; UGC segue a regra de "usuários interagem" acima. |
| Apostas, jogos de azar, cassino simulado ou prêmios em dinheiro | Não. Notas S7 e preferências S6 são avaliações de equalização, não apostas (`web/migrations/0005_s6_s7.sql:20-27`, `web/migrations/0005_s6_s7.sql:38-53`). |
| Compras, itens aleatórios pagos, loot boxes ou compras digitais | Não. Curvas/favoritos/instalações não são compras. Não há pagamento no fluxo de publicação; `payment=()` em `web/src/lib/server/security/headers.ts:95`. |
| Compartilha localização física do usuário com outros usuários | Não. Perfis e curvas não têm coordenadas (`web/src/lib/server/account/profile.ts:16-32`, `web/migrations/0004_social.sql:44-79`); geolocalização bloqueada em `web/src/lib/server/security/headers.ts:87`. IP legal não é exibido à comunidade. |
| Permite interação, troca ou compartilhamento de conteúdo entre usuários | **Sim.** Publicação de curvas, versões, forks e packs, perfis e troca S7. A ausência de chat não elimina UGC (`web/migrations/0004_social.sql:44-79`, `web/migrations/0004_social.sql:203-234`, `web/migrations/0005_s6_s7.sql:32-53`). |
| Contém conteúdo gerado por usuários acessível a outros | **Sim.** Apelidos, bio e textos de curvas/packs; conteúdo pode ser público, não listado ou privado. Não classificar o serviço como inteiramente fechado/offline. |
| Chat, mensagens privadas ou comentários livres entre usuários | **Não.** Não há esse recurso no schema social. S7 troca curvas e notas numéricas, não mensagens; nota da denúncia só chega à moderação (`web/src/routes/api/v1/reports/+server.ts:1-3`). |
| Usuário pode denunciar conteúdo e perfis inadequados | **Sim, com conta e e-mail verificado, a partir de todas as superfícies de UGC.** Denúncia de curvas (alvo `lineage`, abrangendo a linhagem), packs (`pack`) e usuários (`user`); motivo e nota de até 500 caracteres. Há Turnstile e cota de 30/dia (`web/migrations/0004_social.sql:240-250`, `web/src/routes/api/v1/reports/+server.ts:16-41`). Conferir esses três alvos em cada superfície de UGC na release antes do envio. |
| Há moderação e remoção de conteúdo abusivo | **Sim.** Ocultação automática por 3 contas elegíveis (2 se a curva atual é YOLO), com idade mínima de 3 dias, seguida de fila e decisão administrativa; ocultar, restaurar, remover, dispensar ou banir autor (`web/src/lib/server/social/moderation.ts:48-63`, `web/src/lib/server/social/moderation.ts:219-242`, `web/src/lib/server/social/moderation.ts:331-415`). |
| Conteúdo é todo aprovado antes de aparecer / filtro garante ausência de material impróprio | **Não.** Existe moderação por denúncia, não aprovação editorial prévia de toda publicação. Gate de segurança da curva não é filtro semântico universal. |
| Usuário pode ocultar autores e curvas individualmente | **Sim, nesta release.** "Ocultar este autor" / "Ocultar esta curva" ficam disponíveis no app: a ocultação é local para visitantes e sincronizada para contas. É controle de visibilidade do próprio usuário, não banimento administrativo nem bloqueio de comunicação (não há chat/DM). Conferir ambos os fluxos na release antes do envio. |
| Controles parentais próprios | Não comprovados no serviço. Conta é 18+, mas isso não é controle parental do aparelho. Não anunciar um recurso inexistente. |
| Navegador aberto, busca na internet irrestrita ou acesso livre a sites externos | Não. É uma WebView de origem definida, não navegador geral (`apps/android/capacitor.targets.mjs:4`, `apps/android/capacitor.targets.mjs:65-86`). Links externos não são um histórico de navegação oferecido pelo app. |
| Conteúdo noticioso, político editorial, compras físicas ou serviços regulados | Não. O acervo é de equalizações da comunidade, não notícias, mercado, aconselhamento financeiro ou atendimento clínico. |

**Provas de regras e tratamento de denúncias:** os termos proíbem conteúdo perigoso e abusivo e permitem revisão pelo canal da política (`web/src/lib/content/legal/terms.pt-BR.ts:54-64`); o handler de denúncia valida alvos, motivo e nota e exige conta verificada; a moderação conserva trilha de auditoria. Isso comprova denúncia/moderação, não ausência de todo abuso nem execução contínua de uma equipe humana. O mantenedor deve assegurar atendimento efetivo da fila em produção. Não enviar resposta dizendo que inexistem usuários interagindo ou que nenhum UGC pode conter linguagem imprópria.

## 5. Público-alvo e conteúdo

**Faixa única: 18 anos ou mais (18+).** Não selecionar nenhuma faixa de menores de idade, nem para uso sem conta. **Não direcionado a crianças ou adolescentes; não participar do programa Families como app infantil.** O posicionamento é ferramenta de equalização/áudio para adultos que usam o cabo e querem ajustar som, sem personagens, jogos ou incentivos infantis. Esta decisão do mantenedor substitui o público anterior do plano.

**Consistência com a política:** o app não é direcionado a menores, inclusive como visitante, e **contas são para 18+** (`docs/legal/politica-de-privacidade.md:313-315`). É requisito de uso, não comprovação técnica de idade. O formulário não pede data de nascimento (`web/src/lib/components/auth/SignUpForm.svelte:31-79`); não anunciar age gate robusto ou controles parentais inexistentes. Ficha, capturas e respostas do Console devem manter esse público único.

## 6. Segurança dos dados (Data safety)

Copiar a matriz e as respostas gerais de [data-safety.md](./data-safety.md), incluindo a coleta do site carregado na WebView. Não selecionar "não coletamos dados" nem "todos os dados são processados efemeramente".

Resumo: conta/perfil opcionais; IP/registros legais e segurança nas requisições; atividade, UGC e preferências S6; diagnóstico; estatísticas e país aproximado derivado do fuso horário, coletados e compartilhados com Simple Analytics para Analytics, sem exigir conta; Turnstile e e-mail transacional por prestadores. O S6 é tratado conservadoramente como informação de saúde na declaração de dados, sem transformar o produto em recurso médico. Criptografia em trânsito: sim para a release de produção. Exclusão/gestão em https://open-auri.com/conta e instruções na política. Há ressalvas de retenção legal e de terceiros. Resolver as pendências e divergências listadas no final de `data-safety.md` antes da confirmação definitiva no Console.

## 7. ID de publicidade

**Resposta: não usa ID de publicidade.** O manifesto declara o recurso USB host opcional e a permissão `android.permission.INTERNET` (`apps/android/android/app/src/main/AndroidManifest.xml:4-5`), sem `com.google.android.gms.permission.AD_ID`. A atividade registra os plugins USB/SAF (`apps/android/android/app/src/main/java/com/openauri/app/MainActivity.kt:52-55`). Simple Analytics usa script de contagem, não integração com Advertising ID (`web/src/lib/server/analytics.ts:23-34`). Tokens de sessão, IP/hash e sinais do Turnstile declarados em Data safety não são Advertising ID. Verificar também o manifesto mesclado da release, pois dependências podem acrescentar permissões.

## 8. Recursos financeiros

**Selecionar: "Meu app não oferece recursos financeiros".** Não há banco, pagamento, transferência, empréstimo, investimento, crédito, criptoativo, seguro ou aconselhamento financeiro. Licença CC, favoritos, ranking e troca S7 não movimentam dinheiro (`web/migrations/0004_social.sql:66-79`, `web/migrations/0004_social.sql:138-143`, `web/migrations/0005_s6_s7.sql:32-53`). A declaração é obrigatória mesmo quando não se aplica (`docs/android/play-requisitos.md:68`).

## 9. Apps de saúde

**Selecionar: "Meu app não oferece recursos de saúde".** É utilitário de música/áudio e programação de equalização, não diagnóstico, tratamento, triagem, exame auditivo clínico, acompanhamento de doença, prontuário, condicionamento físico ou pesquisa médica. Nenhuma alegação terapêutica deve constar na ficha. O schema S6 guarda escolhas entre curvas e volume igualado, não audiograma ou diagnóstico (`web/src/routes/api/v1/s6/batches/+server.ts:30-46`).

**Não confundir formulários:** a LGPD trata essas preferências como potencialmente sensíveis e exige consentimento específico (`docs/legal/politica-de-privacidade.md:147-161`). Por isso Data safety declara informação de saúde de forma conservadora. Isso não autoriza responder "não tratamos nenhum dado potencialmente relacionado à saúde". Se a interface vigente da Play considerar esse tratamento, por si só, escopo da declaração de saúde, registrar a pergunta e revisar o enquadramento antes de confirmar, sem alegar certificação médica.

## 10. Apps de governo

**Resposta: não é um app governamental nem representa órgão público.** O produto é um utilitário comunitário de equalização, com controlador próprio identificado na política (`docs/legal/politica-de-privacidade.md:32-42`), não canal oficial de serviço público. Cumprir LGPD e Marco Civil ou armazenar registros legais não torna o app governamental.

## 11. Notícias

**Resposta: não é um app de notícias nem revista.** Feed, rankings, versões e packs são conteúdo técnico de equalização criado pela comunidade, não jornalismo (`web/migrations/0004_social.sql:44-79`, `web/migrations/0004_social.sql:203-234`). Não se apresenta como veículo noticioso. Manter a ficha coerente com essa finalidade.

## Antes de confirmar os formulários

- Conferir o AAB final após integrar as tarefas nativas: permissões mescladas, USB local, SAF, ausência de telemetria nativa e bloqueio de HTTP em produção.
- Conferir os scripts externos em produção e os contratos que fundamentam as exceções de compartilhamento da Play, sem transformar alegação do fornecedor em auditoria executada.
- Preencher somente no Console o contato IARC, a conta de revisão reutilizável obrigatória e o link do vídeo obrigatório, sem marcadores nos campos submetidos.
- Confirmar público 18+ único, denúncia e "Ocultar este autor/esta curva" no app (local para visitantes, sincronizado para contas). Não confundir ocultação com banimento administrativo.
- Rever as "Divergências encontradas" de `data-safety.md`. Este documento fornece respostas e evidências, não comprova teste USB, inspeção do AAB ou aprovação da Play.
