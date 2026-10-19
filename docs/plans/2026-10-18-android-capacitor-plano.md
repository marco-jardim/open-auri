# Plano · App Android (Capacitor) com gravação nativa no cabo

- **Data:** 2026-10-18
- **Revisão 2 (2026-10-18), por decisão do mantenedor:**
  - o app é lançado antes da validação num cabo real, com aviso explícito e controle remoto da gravação;
  - a validação em hardware vira a Fase 5, pós-lançamento;
  - monorepo confirmado, com os segredos de assinatura isolados num GitHub Environment e CI filtrado por caminhos.
- **Revisão 3 (2026-10-18), por decisão do mantenedor:**
  - `applicationId` `com.openauri.app` e nome `open-auri` confirmados;
  - execução na própria pasta do repositório confirmada;
  - merge e deploy feitos pelo orquestrador quando o CI estiver verde (0.21);
  - Trilha P (Google Play) em paralelo à implementação, com o orquestrador guiando o mantenedor no cadastro e na preparação (0.22).
- **Estado:** proposto, aguardando aprovação humana
- **Repositório:** `D:\git\open-auri` (monorepo; branch de trabalho `feat/android-app`, criada no PF1 a partir de `main`)
- **Formato herdado de:** `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-plano.md`
- **Executor:** um orquestrador LLM de alta capacidade, do PF1 ao QG (lançamento) e, depois, da F5 ao QGH (pós-hardware), com despachos via model-router
- **Idioma:** pt-BR no plano e nos documentos; inglês nos commits e no código

---

## 0. Diretivas

**0.1 Execução contínua, sem interrupções.** Execute PF1 → F1 → PF2 → F2 → PF3 → F3 → PF4 → F4 → QG, iterando wave a wave, sem pausas e sem pedir confirmação entre waves ou fases. Interrompa somente em um destes casos:
- (a) ambiguidade cuja resposta muda o resultado e que este plano não decide;
- (b) problema crítico: segurança, segredo exposto, perda de dados, risco ao cabo ou à audição, violação de licença;
- (c) bloqueio: entrada humana pendente da seção 13, serviço externo fora do ar por mais de 30 min, ou falha persistente conforme 0.16.

Ao interromper, entregue um relatório curto com: o problema, a evidência (arquivo:linha ou saída de comando), as opções e uma recomendação. Depois da resposta, retome exatamente do ponto em que parou.

**O fim do QG é uma parada planejada, não uma interrupção.** A F5 (validação em hardware) começa quando H-HW estiver disponível e segue a mesma regra de execução contínua até o QGH.

**Trilha P em paralelo.** As mensagens da Trilha P (0.22) para o mantenedor não são interrupções: a implementação continua enquanto ele faz os passos dele na Play.

**0.2 Solução definitiva.** Cada fase entrega um subobjetivo completo e final. Ficam proibidos:
- waves ou fases de "MVP" e entregas parciais a refazer depois;
- stubs ou mocks em código de produção;
- flags temporárias e `TODO depois`;
- testes pulados ou condicionais.

Um `TODO` só é aceito se carregar o ID de uma entrada humana da seção 13 (ex.: `TODO(H-KEY)`). Dependências externas reais (hardware, chave de assinatura, conta da Play) são entradas humanas, nunca código provisório.

As constantes de estado do produto em `D:\git\open-auri\web\src\lib\cable\android-status.ts` (`ANDROID_WRITE_VALIDATED`, `ANDROID_DISCLAIMER_VERSION`, `ANDROID_WRITE_POLICY`) não são flags temporárias. São controles operacionais documentados, com runbook, e fazem parte da solução definitiva.

**0.3 Pre-flight antes de cada fase.** Toda fase começa pelo seu PFn. O PF verifica pré-condições, corrige na hora o que for corrigível e só libera a fase com todos os itens OK. O que não puder ser corrigido vira interrupção (0.1 c).

**0.4 Testes novos ao fim de cada fase.** Antes do QA, a tarefa `Tn.T` acrescenta testes com boa cobertura e edge cases explícitos, além dos testes unitários que cada tarefa já entrega. Ela também roda a suíte completa da área.

**0.5 QA sênior adversarial ao fim de cada fase, da Trilha P e no final global.** Depois do `Tn.T`, rode `Qn` com o papel `reviewer`, sempre em `[tier:heavy]`. O revisor atua como adversário: tenta quebrar a entrega, prova cada achado com evidência e roda os testes que sustentam o veredito.
- **Correção total:** **todos os achados, de qualquer severidade, viram tarefas `FXn.k`.** Elas são implementadas, verificadas e commitadas.
- **Convergência:**
  - O `Qn` repete em rodadas completas até uma rodada sem achados major, critical ou blocking.
  - Os minor dessa última rodada também são corrigidos (`FXn.k`). O mesmo reviewer heavy confere essas correções em modo delta, olhando só os FX, sem abrir nova rodada completa.
  - **PASS** = zero achados abertos de qualquer severidade.
- **Limite:** no máximo 4 rodadas completas por fase. Se a 4ª ainda trouxer major ou mais, aplique 0.16.

O QA da Trilha P (`QP`), o QA global do lançamento (`QG`) e o QA global pós-hardware (`QGH`) seguem a mesma regra, com tarefas `FXP.k`, `FXG.k` e `FXGH.k`.

**0.6 Regra fixa: QA é sempre tier heavy.** Todo despacho de QA, revisão, auditoria de segurança ou verificação adversarial leva `[tier:heavy]` e a linha de rota com `tier=heavy pin`. Não há exceção. Delegue ao heavy a revisão adversarial do trabalho feito.

**0.7 Paralelismo máximo, com segurança.** Dentro de uma wave, rode em paralelo todas as tarefas cujos conjuntos de escrita (W) e leitura (R) satisfaçam a seção 6, incluindo as tarefas de agente da Trilha P. Pelas regras da seção 6:
- nenhum arquivo é escrito por mais de um agente ao mesmo tempo;
- nenhum arquivo é lido enquanto outro agente o edita;
- arquivos compartilhados passam pela fila de integração, em série;
- recursos exclusivos (Gradle, `npm install`, suítes web pesadas, emulador) usam locks de recurso.

**0.8 Commit often.**
- **Quando:** um commit por tarefa verificada (Tn.k, Pn, FXn.k, In.k, PF com correções). Só o orquestrador commita, em série, depois do veredito PASS do router.
- **Mensagem:** Conventional Commits em inglês com o ID entre colchetes, no padrão do repositório (`D:\git\open-auri\CONTRIBUTING.md:17-18`). Exemplo: `feat(android): usb host transport with interrupt out and set_report [T1.4]`.
- **Pathspec:** sempre explícito. Nunca `git add -A`.
- **Proibido:**
  - `--no-verify`;
  - amend de commit já enviado;
  - force push;
  - trailer `Co-Authored-By` de qualquer modelo e linha "Generated with" (`D:\git\open-auri\CONTRIBUTING.md:24-25`). Repasse essa proibição a todo delegado.
- **Antes de cada commit:** `npm run check:sensitive` verde.
- **Push:** da branch de trabalho para `origin` ao fim de cada fase com QA PASS. Merge segue 0.21.

**0.9 Caminhos absolutos.** Todo arquivo citado neste plano, nos despachos e nos relatórios usa o caminho completo a partir de `D:\git\open-auri\`.

**0.10 Model-router.** Todo despacho segue a seção 5: linha de rota na primeira linha, prompt em 7 seções (TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT), bloco `[acceptance]` e `VERIFY:required` quando houver dependentes. Nunca defina `model`.

**0.11 Regras de código.** Valem as instruções globais do agente (`AGENTS.md` do usuário) e o [`CONTRIBUTING.md`](../../CONTRIBUTING.md) do repositório. Ficam proibidos:
- `as any`, `@ts-ignore`, `@ts-expect-error`;
- em Kotlin, `@Suppress` para esconder erro de tipo ou `!!` sem prova de não nulo;
- catch vazio ou erro engolido;
- pular ou apagar teste que falha;
- `{@html}`;
- travessão U+2014 em qualquer texto, inclusive este plano, strings de UI e textos da Play.

Bugfix é mínimo e sem refatorar junto.

**0.12 Invariantes de segurança (não negociáveis).**
1. Nenhum byte chega ao cabo sem passar pelo mesmo caminho do desktop: gate v2 no JS (`D:\git\open-auri\src\safety\gate.mjs`), checklist (`D:\git\open-auri\web\src\lib\cable\checklist.ts`), gesto do usuário e `writeCurve`/`writeMany` de `D:\git\open-auri\src\transport\webhid.mjs`. **O núcleo `D:\git\open-auri\src\transport\*` não muda neste plano.**
2. Nada é gravado automaticamente.
3. O plugin nativo é defesa em profundidade e não substitui o gate. Ele recusa, sem enviar nada ao dispositivo, qualquer um destes casos:
   - report ID diferente de `0xCB`;
   - tamanho diferente de 31 bytes;
   - sequência fora de ordem;
   - commit sem os 9 reports anteriores válidos;
   - payload remontado com preâmbulo ou CRC inválidos;
   - commit a menos de 2000 ms do anterior no mesmo dispositivo.
4. A ponte nativa só responde à origem fixada (`https://open-auri.com`, ou a origem de staging/e2e nos builds de teste). Em qualquer outra origem: `SecurityError`, sem I/O.
5. O build de release recusa `server.url` diferente de `https://open-auri.com`, tráfego em claro, `allowNavigation` não vazio e depuração da WebView ligada.
6. `android:allowBackup="false"` e regras de extração que excluem cookies, storage e WebView. Nenhum segredo é versionado (keystore, senhas, `keystore.properties`).
7. Interrupção em qualquer ponto (desconexão, timeout, app em segundo plano, guarda) nunca envia o commit.
8. Desktop e navegadores móveis continuam funcionando sem nenhuma regressão: suítes existentes, orçamentos e e2e desktop/mobile verdes.
9. Enquanto `ANDROID_WRITE_VALIDATED` for `false`:
   - o app mostra o aviso de "não testado num cabo" (Anexo G) no primeiro uso e na página do cabo;
   - o checklist exige, a cada gravação pelo app (inclusive resgate e fila de vários cabos), o aceite do item correspondente.
10. `ANDROID_WRITE_POLICY` é avaliada antes de qualquer I/O. Gravação desligada ou versão do app bloqueada levam ao modo simulado com mensagem, sem nenhuma chamada ao plugin.

**0.13 Hardware físico.** Agentes nunca gravam num cabo físico. Só o humano grava, pelo fluxo normal do app, nas tarefas H da F5. O lançamento (F1 a F4) não depende de cabo.

**0.14 Versões sempre atuais.** Em cada PF, o `researcher` confirma as versões estáveis atuais e a compatibilidade entre elas: `@capacitor/core`, `@capacitor/cli`, `@capacitor/android` (linha 8.x, 8.5.3 em 2026-10-07), AGP, Gradle, Kotlin, JDK, `androidx.webkit`, Kover, Licensee, JUnit, Robolectric, `json-schema-validator` e as GitHub Actions usadas (`actions/setup-java`, `android-actions/setup-android`, `reactivecircus/android-emulator-runner`, `dorny/paths-filter`). Registre tudo na seção 14. Se aparecer uma major nova estável, ela entra só se o PF provar compatibilidade. Senão, interrupção (0.1 a).

**0.15 Segredos e chaves.**
- **Chaves:** são duas, criadas offline pelo mantenedor (H-KEY) e mantidas fora do repositório:
  - **chave de assinatura do app:** assina o APK do GitHub e é enviada ao Play App Signing pela ferramenta PEPK, para que a Play assine com a mesma chave (4.6);
  - **chave de upload:** assina o AAB enviado à Play.
- **CI:** as duas chegam ao CI apenas como secrets do GitHub Environment `android-release`, com aprovação obrigatória do mantenedor e liberação só para o workflow disparado por tag `android-v*`. As tags `android-v*` são protegidas (H-ENV). Nenhum outro workflow enxerga esses secrets.
- **Varredura:** `D:\git\open-auri\tools\check-sensitive.mjs` passa a bloquear `*.jks`, `*.keystore`, `*.pepk`, `keystore.properties`, `google-services.json` e `local.properties`.
- **Senhas e `.env`:** senhas da conta Google e da Play nunca passam pelo chat nem por arquivos do repositório. O `.env` local nunca é aberto por delegados.

**0.16 Falha persistente.** Depois de 3 tentativas sem sucesso no mesmo problema:
1. parar;
2. reverter ao último estado verificado;
3. documentar o que foi tentado e a falha real;
4. despachar o `architect` em `[tier:heavy]`;
5. se ainda assim não resolver, interromper (0.1 c).

**0.17 Testes direcionados.**
- **Durante as tarefas:** só os testes da área (`npm run test:transport`, `npm run test:tools`, `npm run test:android`, `npm run -w web test:unit -- <filtro>`).
- **Suíte completa:** só em `Tn.T`, `Qn`, `QG`, `QGH` e antes de cada push.
- **Nunca em paralelo:** `test:web:unit` com `test:web:int` ou com o build (`D:\git\open-auri\README.md:103`).

**0.18 Registro de progresso.** Só o orquestrador atualiza a seção 14 deste arquivo, ao fim de cada tarefa e de cada fase, incluindo o estado de cada passo da Trilha P. Cada atualização tem commit próprio (`docs(plans): progress [Tn.k]`).

**0.19 Compatibilidade app ↔ site.** O app carrega o site de produção, então o site é sempre mais novo que algum app instalado.
- O plugin expõe `bridgeApi` (inteiro). O site declara a faixa que suporta.
- App mais antigo que a faixa, ou listado em `ANDROID_WRITE_POLICY.blockedAppVersions`: o site mostra "atualize o app" e usa o modo simulado.
- Quebra de contrato só com `bridgeApi` novo e mantendo o anterior por pelo menos uma versão do app.

**0.20 Fora de escopo, com justificativa em `D:\git\open-auri\docs\android.md`:**
- iOS e iPadOS (seção 4.4);
- abrir o app automaticamente ao conectar o cabo;
- upload automatizado para a Play (os uploads são manuais, guiados pela Trilha P);
- outros chips além do CB5100.

**0.21 Merge e deploy autônomos (autorizados pelo mantenedor).** O orquestrador faz o merge e o deploy sozinho, desde que todas as condições abaixo valham:
- **Condições:**
  - CI verde no commit HEAD do PR (todos os jobs obrigatórios, inclusive os Android quando o filtro os acionar);
  - QA da fase em PASS, sem FX aberto;
  - `npm run check:sensitive` verde.
- **Merge:** `gh pr merge <n> --merge`, preservando os commits por tarefa. Sem squash, sem rebase forçado, sem `--admin` para furar proteção.
- **Deploy, sempre nesta ordem:**
  1. `gh workflow run deploy.yml -f environment=staging`;
  2. e2e de staging (projeto `staging` de `D:\git\open-auri\web\playwright.config.ts:78-88`, com `STAGING_ORIGIN`);
  3. `gh workflow run deploy.yml -f environment=production -f confirm=production`;
  4. smoke de produção (rotas principais, `/.well-known/assetlinks.json`, headers de segurança).
- **Falha de smoke:** rollback imediato pelo procedimento de `D:\git\open-auri\docs\operacao.md`, depois interrupção (0.1 b).
- **Execução:** comandos `gh` ficam fora do allowlist do `router_run`, então rodam por despacho explícito de tier `fast` com shell.
- **Aprovações que continuam humanas:** se o Environment `production` do GitHub exigir aprovador, a aprovação é humana e não bloqueia outras waves. A assinatura de release (Environment `android-release`) sempre exige aprovação humana.

**0.22 Trilha P (Google Play) em paralelo.** A Trilha P (seção 7, "Trilha P") prepara e publica o app na Play.
- **Divisão:** passos de agente (pesquisa, textos, artes, respostas de formulários, revisão) e passos do mantenedor no Play Console, guiados pelo orquestrador.
- **Início:** junto com o PF1.
- **Agente:** as tarefas de agente entram nas waves da implementação respeitando a seção 6.
- **Mantenedor:** os passos humanos são pedidos por mensagem, com checklist pronto (Anexo H), sem parar a implementação. A resposta do mantenedor retoma o passo correspondente.
- **Dependências com a implementação:** só P6 (assinatura e registro do pacote) e P7 (publicação). Ambas ficam na F4 e são pré-requisitos do lançamento.

---

## 1. Resumo

O objetivo é um app Android que grava curvas no cabo Auri pelo USB, coisa que o navegador do celular não consegue: o Chrome Android e a Android WebView não têm WebHID, e o WebUSB bloqueia as classes HID (0x03) e áudio (0x01). O app é um shell Capacitor 8 que carrega `https://open-auri.com` e injeta um transporte nativo com o mesmo formato do `navigator.hid`. O resto (site, gate, checklist, encoder e diário) fica igual. Só o último salto até o USB passa a ser nativo, com uma guarda extra que valida cada sequência antes do commit.

**Decisão do mantenedor (2026-10-18):** o app é lançado antes de ser testado num cabo real, porque o cabo vai demorar. A gravação usa o mesmo protocolo e os mesmos bytes de dados do site no desktop e da página oficial; testes automáticos provam isso byte a byte. O que não está validado é o caminho físico até o USB. Enquanto não houver validação:
- o app mostra um aviso explícito (Anexo G) e exige o aceite dele no checklist de cada gravação;
- o site consegue desligar ou restringir a gravação pelo app com um deploy, sem atualizar o app;
- o usuário pode relatar o resultado por um issue template, levando o JSON do diagnóstico USB.

| Fase | Subobjetivo |
|---|---|
| F1 | App Android e plugin USB nativo completos e testados com dispositivo falso e os bytes oficiais do fixture |
| F2 | Integração no site: transporte nativo, downloads, UI, aviso de não validado, controle remoto, docs e e2e com a ponte real do Capacitor |
| F3 | Distribuição, segurança e documentação: release assinado em Environment protegido, testes em emulador, licenças, runbooks, issue template |
| F4 | Lançamento sem validação em hardware: merge e deploy autônomos, release no GitHub, registro do pacote, publicação na Play, smoke num celular sem cabo |
| F5 | Pós-lançamento, quando o cabo chegar: captura de referência, paridade no fio, validação em 2 ou mais celulares, remoção do aviso ou correção |
| Trilha P | Em paralelo de F1 a F4: conta da Play revisada, verificação de identidade, ficha da loja, artes, formulários, assinatura, registro do pacote, publicação |

O lançamento fecha com o QG. A F5 fecha com o Q5 e o QGH.

---

## 2. Estado atual (com evidência)

| Fato | Evidência |
|---|---|
| Gravação usa só `sendReport(0xCB, 31 B)`: 9 reports de dados com 16 ms entre eles, 150 ms de settle e depois o commit `[01 65 00 01 FF]` completado com zeros | `D:\git\open-auri\src\transport\webhid.mjs:110,113,495-504`; `D:\git\open-auri\src\dsp\eq0xcb.mjs:47,61,66,67,562` |
| Interrupção nunca envia commit; operações penduradas são abandonadas e o dispositivo fica recusado | `D:\git\open-auri\src\transport\webhid.mjs:14-16,386-431,509` |
| `writeMany` recusa YOLO e espaça cabos em 2000 ms | `D:\git\open-auri\src\transport\webhid.mjs:116,556-598` |
| O serviço aceita um HID injetado (`deps.hid`). Com ele, `navigator.hid` e `isSecureContext` não são consultados | `D:\git\open-auri\web\src\lib\cable\service.ts:209-216,316-318`; `D:\git\open-auri\web\src\lib\cable\types.ts:126-131` |
| `HidLike` do web exige eventos `connect`/`disconnect` e `getDevices` opcional; o `CableHID` do núcleo só usa `disconnect` | `D:\git\open-auri\web\src\lib\cable\types.ts:24-38`; `D:\git\open-auri\src\transport\webhid.mjs:50-63` |
| Itens do checklist e condicionais (experimentais, YOLO) | `D:\git\open-auri\web\src\lib\cable\checklist.ts:225-244`; `D:\git\open-auri\web\src\lib\cable\types.ts:176` |
| Ponto de injeção: `createClientApp` aceita `cable.hid` e é montado pelo layout raiz | `D:\git\open-auri\web\src\lib\app\client.svelte.ts:26,46,64`; `D:\git\open-auri\web\src\lib\app\context.svelte.ts:59-61`; `D:\git\open-auri\web\src\routes\+layout.svelte:229` |
| Dispositivo falso completo para testes, com falhas injetáveis | `D:\git\open-auri\src\transport\fake-device.mjs:31-38,147-346` |
| 75 testes do transporte, entre eles bytes dos 11 presets, timing, desconexão por report e abort/hang | `D:\git\open-auri\test\transport\webhid.test.mjs:70-1721` |
| Fixture de referência byte a byte | `D:\git\open-auri\test\fixtures\eq0xcb.reference.json`; uso em `D:\git\open-auri\test\catalog\presets.test.mjs:90-105` |
| Descritor USB (interfaces, endpoints, report descriptor) **não documentado** | `D:\git\open-auri\docs\hardware.md:114-119`; `D:\git\open-auri\docs\probing.md:44-46` (sonda B1 pendente) |
| CSP estrita com nonce e hashes; `frame-ancestors 'none'`; `connect-src 'self'` | `D:\git\open-auri\web\vite.config.ts:43-65`; `D:\git\open-auri\web\src\lib\server\security\headers.ts:38-50,75-103` |
| Cookies `__Secure-open-auri.*`, `SameSite=Lax`; CSRF por Origin igual a `PUBLIC_ORIGIN` | `D:\git\open-auri\web\src\lib\server\auth.ts:149,263-268`; `D:\git\open-auri\web\src\lib\server\api\handler.ts:135` |
| Turnstile no cadastro, login, recuperação, denúncia, S6 e conta | `D:\git\open-auri\web\src\lib\server\security\turnstile.ts:6`; `D:\git\open-auri\web\src\lib\components\security\Turnstile.svelte:3` |
| Service worker de módulo, escopo `/`; navegação ao vivo nunca vem do cache | `D:\git\open-auri\web\src\lib\pwa\register.ts:33-42`; `D:\git\open-auri\web\src\service-worker.ts:92-93` |
| Layout móvel pronto (≤ 720 px, alvos de 44 px) e e2e em Pixel 7 | `D:\git\open-auri\web\src\lib\components\chrome\CableBar.svelte:9`; `D:\git\open-auri\web\src\lib\styles\tokens.css:145`; `D:\git\open-auri\web\playwright.config.ts:52,74` |
| Projeto Playwright de staging, ativo com `STAGING_ORIGIN` | `D:\git\open-auri\web\playwright.config.ts:78-88` |
| CI: jobs `static`, `test`, `build`, `e2e`, em Node 24, sem Android | `D:\git\open-auri\.github\workflows\ci.yml:22,66-197` |
| Deploy só por `workflow_dispatch` com confirmação | `D:\git\open-auri\.github\workflows\deploy.yml:15-29,49-53` |
| Coletor de licenças lê sourcemaps npm; não enxerga Maven/Gradle | `D:\git\open-auri\tools\third-party-notices.mjs:499-560` |
| `.gitignore`, `.prettierignore` e `eslint.config.js` não cobrem `android/` | `D:\git\open-auri\.gitignore`; `D:\git\open-auri\.prettierignore:1-11`; `D:\git\open-auri\eslint.config.js:7-16` |
| `router_run` só aceita npm/npx/node/vitest/etc.; Gradle tem de rodar por scripts npm | protocolo do router (seção 5.6) |

Pesquisa externa (2026-10-18; fontes na seção 4.5):
- **Capacitor:** 8.x estável, com Node 22 ou mais, minSdk 24, compile/targetSdk 36, AGP 8.13.0, Gradle 8.14.3, Kotlin 2.2.20 e JDK 21.
- **`server.url`:** existe, mas a doc oficial diz que não é para produção. O bridge é injetado na origem de `server.url`.
- **Play: teste fechado.** Contas pessoais criadas depois de 2023-11-13 precisam de teste fechado com 12 testadores por 14 dias. Contas mais antigas não.
- **Play: contas inativas.** São fechadas, com avisos por e-mail 60, 30 e 7 dias antes. Para manter a conta, é preciso verificar e-mail e telefone e publicar ou manter um app.
- **Play: targetSdk.** Exigido 36 desde 2026-08-31.
- **Verificação de desenvolvedor do Android:** todo pacote da Play precisa estar registrado até 2026-09-30. A proteção nos aparelhos certificados vale desde 2026-09-30 nos primeiros países; a lista exata (Brasil incluído ou não) fica para o P0 confirmar. Apps fora da Play também precisam de pacote e chave registrados.
- **Play App Signing:** aceita a chave do próprio desenvolvedor pela ferramenta PEPK, desde que a troca seja feita antes da primeira release em teste aberto ou produção.
- **Plugins existentes:** nenhum serve para output report HID genérico.
- **iPhone:** sem API pública viável.

---

## 3. Requisitos

### 3.1 Funcionais
- **RF1** · O app abre `https://open-auri.com` em tela cheia, com todas as páginas do site funcionando: `/`, `/biblioteca`, `/comparar`, `/soe-como-x`, `/comunidade`, `/teste-cego`, `/cabo`, `/docs`, `/c/[id]`, `/u/[apelido]`, conta e páginas legais.
- **RF2** · Na página do cabo, "Conectar" lista os cabos CB5100 (VID 0x3302, PID 0x8902) conectados por USB-C/OTG e pede a permissão do Android. Com mais de um cabo, abre um seletor nativo com múltipla escolha, equivalente ao seletor do WebHID.
- **RF3** · Gravar, resgatar (Neutro), gravar vários cabos em sequência e o diário funcionam como no desktop, pelo mesmo checklist.
- **RF4** · Os eventos de conectar e desconectar chegam ao site. Desconectar no meio da gravação gera `interrupted` sem commit.
- **RF5** · Todo download do site funciona no app e salva o arquivo onde o usuário escolher (Storage Access Framework):
  - exportações APO, JSON, `.bin`, PNG e SVG;
  - diário;
  - códigos de recuperação;
  - exportação de dados da conta;
  - packs.
- **RF6** · Abrir arquivo de áudio próprio (seletor de arquivos) funciona.
- **RF7** · Links externos (Kuba, GitHub, Simple Analytics, AutoEq) abrem no navegador do sistema. Navegação interna fica no app.
- **RF8** · "Diagnóstico USB" (camada Engenharia, só no app) mostra e copia em JSON: descritores de dispositivo, configuração e HID report, a interface e o endpoint escolhidos e o tamanho calculado do output report.
- **RF9** · No Chrome Android sem o app, a página do cabo mostra um aviso com link para baixar o app (Play e GitHub Releases). Desktop não muda.
- **RF10** · `/docs` ganha a seção "App Android", em pt-BR e en-US, incluindo o estado de validação.
- **RF11** · Sessões abertas pelo app aparecem como "App Android" na lista de sessões da conta.
- **RF12** · Links `https://open-auri.com/*` abrem no app quando ele está instalado (App Links verificados).
- **RF13** · Sem USB host (FEATURE_USB_HOST ausente), o site mostra "Este aparelho não suporta USB host (OTG)" e fica no modo simulado.
- **RF14** · Aviso de não validado (texto no Anexo G), enquanto `ANDROID_WRITE_VALIDATED = false`:
  - modal no primeiro uso do app, que reabre se `ANDROID_DISCLAIMER_VERSION` mudar;
  - banner fixo na página do cabo;
  - item obrigatório no checklist de cada gravação pelo app.

  Sai só com deploy do site (F5), sem nova versão do app.
- **RF15** · Controle remoto: `ANDROID_WRITE_POLICY = { enabled, blockedAppVersions }` no site desliga ou restringe a gravação pelo app com um deploy, sem atualizar o app.
- **RF16** · "Relatar resultado": link no aviso e no Diagnóstico USB para o issue template `D:\git\open-auri\.github\ISSUE_TEMPLATE\android-cable-report.yml`. O template pede aparelho, versão do Android, versão do app, o JSON do diagnóstico e o resultado.
- **RF17** · Distribuição na Google Play e no GitHub Releases com a **mesma assinatura** (chave própria enviada ao Play App Signing), de modo que o usuário possa trocar de fonte sem desinstalar. Pacote `com.openauri.app` registrado na verificação de desenvolvedor do Android com o SHA-256 da chave.

### 3.2 Não funcionais
- **RNF1** · minSdk 26 (Android 8.0). Motivo: `UsbRequest.queue(ByteBuffer)` e `requestWait(timeout)` sem APIs depreciadas. compileSdk e targetSdk 36.
- **RNF2** · WebView com `DOCUMENT_START_SCRIPT` e versão maior ou igual à baseline do build do site (o PF1 calcula a partir de `D:\git\open-auri\web\vite.config.ts`). Abaixo disso, tela nativa pedindo atualização do "Android System WebView".
- **RNF3** · Gravação no app com a mesma duração do desktop (cerca de 0,3 s), com variação de no máximo 50 ms por report no aparelho.
- **RNF4** · APK de release com no máximo 8 MB (o site é remoto).
- **RNF5** · Cobertura:
  - Kotlin (pacotes `com.openauri.usb` e `com.openauri.files`): pelo menos 90% de linhas e branches (Kover);
  - arquivos web novos: pelo menos 95%;
  - limites existentes mantidos: núcleo 95%, `D:\git\open-auri\web\src\lib` 85%, servidor 90%.
- **RNF6** · i18n nativo em `values\` (en-US) e `values-pt\` (pt-BR).
- **RNF7** · Acessibilidade das telas nativas (seletor, atualização da WebView, offline) e do aviso RF14: TalkBack ou leitor de tela lê tudo, alvos de pelo menos 48 dp, contraste AA, foco preso no modal.

### 3.3 Segurança
- **RS1** · Origem fixada no bridge e conferida de novo no plugin (`OriginGuard`).
- **RS2** · Sem cleartext em produção; `network_security_config` libera claro só para `10.0.2.2` no build de debug e2e.
- **RS3** · `allowBackup=false`; `webContentsDebuggingEnabled=false` no release; `debuggable=false`.
- **RS4** · Verificação de dependências do Gradle (`D:\git\open-auri\apps\android\android\gradle\verification-metadata.xml`, sha256) e `distributionSha256Sum` no wrapper.
- **RS5** · Licenças nativas permitidas só por lista (Licensee): Apache-2.0, MIT, BSD-2/3, EPL-2.0 e outras aprovadas no PF. Qualquer outra derruba o build.
- **RS6** · Permissões mínimas: `INTERNET` e `<uses-feature android:name="android.hardware.usb.host" android:required="false"/>`. Nada além disso.
- **RS7** · Logs nativos sem dados pessoais. O "wire log" (bytes enviados) só existe em builds de debug.
- **RS8** · Release assinado com esquemas v2 e v3, verificado por `apksigner verify --print-certs`, com SHA-256 e fingerprint do certificado publicados. Segredos só no Environment `android-release` (0.15).

---

## 4. Arquitetura

### 4.1 Decisão: onde roda o front

| Opção | Como | Prós | Contras | Decisão |
|---|---|---|---|---|
| **A · Site remoto (`server.url`)** | WebView carrega `https://open-auri.com`; o bridge Capacitor é injetado nessa origem | Uma única base de código; SSR, auth, cookies, CSRF, Turnstile e SW funcionam como no navegador; o site atualiza sem republicar o app; aviso e controle remoto mudam com um deploy | A doc do Capacitor marca `server.url` como não destinado a produção; offline depende do SW; o app depende do site no ar | **Escolhida** |
| B · Front empacotado (`webDir`) | Build estático do SvelteKit dentro do APK, chamando a API remota | Funciona offline sem SW | O app usa SSR e rotas `+page.server.ts`, o que exigiria reescrever; a origem `https://localhost` quebra cookies `SameSite=Lax`, CSRF por Origin e `trustedOrigins` (`D:\git\open-auri\web\src\lib\server\auth.ts:149,267-268`); muda o modelo de segurança | Rejeitada |
| C · Trusted Web Activity | Chrome em tela cheia | Zero WebView | Sem ponte nativa, então sem USB. Não resolve o problema | Rejeitada |

Mitigações da opção A:
- origem fixada (RS1);
- `allowNavigation` vazio;
- `errorPath` local para falha de rede;
- guarda de versão da WebView com `DOCUMENT_START_SCRIPT` (RNF2), para o bridge não depender de injeção inline, que a CSP com nonce bloquearia;
- teste em emulador contra a CSP real (T3.2);
- handshake `bridgeApi` (0.19);
- tarefa Gradle `verifyCapacitorConfig` que derruba o release se a configuração divergir (0.12.5).

### 4.2 Componentes

```
+--------------------------- APK (com.openauri.*) ----------------------------+
| MainActivity (Capacitor BridgeActivity)                                     |
|   WebViewCompatGate  -> tela "atualize a WebView" se faltar recurso         |
|   DownloadBridge     -> DownloadListener (anexos HTTP com cookies)          |
|   OpenAuriFilesPlugin -> save(name, mime, base64) via SAF                   |
|   OpenAuriUsbPlugin  -> OriginGuard -> FrameGuard -> HidFraming -> backend  |
|        UsbBackend (interface) <- AndroidUsbBackend (UsbManager/UsbRequest)  |
|        PermissionBroker, ClaimManager (claim sob demanda, solta ocioso)     |
|        HidReportDescriptor (parser), Diagnostics, DevicePicker             |
+----------------------------------^------------------------------------------+
                                   | Capacitor bridge (addWebMessageListener)
+----------------------- https://open-auri.com (WebView) ---------------------+
| +layout.svelte -> detectNative() -> android-status (aviso, política)        |
|                -> NativeHID (HidLike) -> createClientApp                    |
| cable/service.ts (inalterado na lógica) -> src/transport/webhid.mjs (igual) |
| checklist.ts (+ item "não testado" só no app) | files/save.ts (SAF no app)  |
+-----------------------------------------------------------------------------+
```

### 4.3 Contratos

- **API JS do plugin:** Anexo B, validada pelo schema `D:\git\open-auri\schemas\android-usb-bridge-1.schema.json` nos dois lados.
- **Mapeamento de erros:** Anexo C. Os nomes são os mesmos de `DOMException` que o WebHID usa, para o transporte classificar falhas igual ao desktop.
- **Framing no fio:** Anexo D. O tamanho do output report sai do descritor HID real, e não de `wMaxPacketSize`. A ordem de escolha é interrupt OUT (`UsbRequest`) se existir, senão SET_REPORT por controle (`0x21, 0x09, 0x02CB, interfaceId`).
- **Política de padding:** fixada na T1.2 como `WINDOWS_MAX_OUTPUT`. O buffer é `[0xCB] + 31 B`, completado com zeros até `maxOutputReportBytes + 1`, que é o que o Chrome no Windows entrega ao driver. Se o descritor declarar só o report 0xCB de 31 bytes, o resultado coincide com Linux e macOS (32 bytes). A F5 confirma pela captura; se divergir, corrige e publica nova versão do app.
- **FrameGuard:** máquina de estados por dispositivo, Anexo D.3.
- **Estado do Android no site:** `D:\git\open-auri\web\src\lib\cable\android-status.ts` (0.2, RF14, RF15).

### 4.4 iOS / iPadOS: fora de escopo
- **CoreHID:** só macOS 15 ou mais.
- **External Accessory:** exige MFi.
- **USBDriverKit:** só em iPad com chip M e com entitlement da Apple.

Não há rota pública para iPhone. O motivo fica documentado em `D:\git\open-auri\docs\android.md`.

### 4.5 Fontes externas (consultadas em 2026-10-18)
- **Capacitor:**
  - https://capacitorjs.com/docs/updating/8-0
  - https://capacitorjs.com/docs/config
  - https://capacitorjs.com/docs/android/custom-code
  - https://github.com/ionic-team/capacitor/blob/8.5.3/android/capacitor/src/main/java/com/getcapacitor/Bridge.java
  - https://github.com/ionic-team/capacitor/issues/8661
- **Android USB:**
  - https://developer.android.com/develop/connectivity/usb/host
  - https://github.com/aosp-mirror/platform_frameworks_base/blob/android-16.0.0_r1/core/java/android/hardware/usb/UsbRequest.java
  - https://github.com/aosp-mirror/platform_frameworks_base/blob/android-16.0.0_r1/core/jni/android_hardware_UsbDeviceConnection.cpp
- **Compatibilidade de navegadores:**
  - https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/HID.json
  - https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/USB.json
- **WebHID no Chromium:**
  - https://github.com/chromium/chromium/blob/b761f7b645d16671aa6931ae52a185d9d06928b8/services/device/hid/hid_connection_win.cc
  - https://github.com/chromium/chromium/blob/935133e72a654887fb49ffbe65c8b762bdff821f/services/device/hid/hid_connection_impl.cc
- **HID no Linux:** https://github.com/torvalds/linux/blob/v6.17/drivers/hid/usbhid/hid-core.c
- **Google Play:**
  - https://support.google.com/googleplay/android-developer/answer/14151465 (teste fechado para contas novas)
  - https://support.google.com/googleplay/android-developer/answer/11605267 (contas inativas)
  - https://support.google.com/googleplay/android-developer/answer/11926878 (target API)
  - https://support.google.com/googleplay/android-developer/answer/10787469 (Data safety)
  - https://support.google.com/googleplay/android-developer/answer/9888379 (abuso de dispositivo e rede)
  - https://support.google.com/googleplay/android-developer/answer/9842756 (Play App Signing e PEPK)
  - https://support.google.com/googleplay/android-developer/answer/16984799 (registro de pacotes da Play)
- **Verificação de desenvolvedor do Android:**
  - https://android-developers.googleblog.com/2026/03/android-developer-verification.html
  - https://developer.android.com/developer-verification/guides/android-developer-console
  - https://support.google.com/android-developer-console/answer/16561738
- **Distribuição:**
  - https://developer.android.com/tools/apksigner
  - https://f-droid.org/docs/Inclusion_Policy/
- **Apple:**
  - https://developer.apple.com/tutorials/data/documentation/corehid.json
  - https://developer.apple.com/documentation/driverkit.md

### 4.6 Distribuição e assinatura
- **Uma assinatura só, em todas as fontes.** A chave de assinatura do app é do mantenedor. Ela é enviada ao Play App Signing pela PEPK antes da primeira release em teste aberto ou produção.
  - O padrão da Play é gerar a chave do lado do Google. Com isso, o APK da Play e o do GitHub teriam assinaturas diferentes, e o usuário não conseguiria atualizar de uma fonte para a outra.
- **Fluxo:**
  - **AAB:** assinado com a chave de upload, enviado manualmente na Trilha P;
  - **APK do GitHub:** assinado com a chave do app, no Environment `android-release`.
- **Registro na verificação de desenvolvedor:** pacote `com.openauri.app` e SHA-256 da chave do app, feito no Play Console (P6). O registro cobre também o APK distribuído fora da Play, porque a assinatura é a mesma.
- **Se a Play não aceitar a chave própria (confirmação no P0):**
  - a chave gerada pela Play fica para a Play;
  - a chave própria fica para o GitHub;
  - as duas são registradas;
  - a troca entre fontes é documentada como incompatível.

---

## 5. Anotações model-router

### 5.1 Papéis

| Papel | Uso neste plano |
|---|---|
| `explorer` | Levantamentos de código nos PF |
| `researcher` | Versões atuais, políticas, compatibilidade (0.14); requisitos da Play (P0); leitura de issues públicos de relato (F5) |
| `runner` | Rodar scripts allowlisted e relatar (PF, Tn.T, pré-push) |
| `implementer` | Toda tarefa de código e testes; documentos e artes da Trilha P |
| `general` | Fila de integração (arquivos compartilhados); consolidação de pesquisa em documento |
| `architect` | Só em falha persistente (0.16), sempre `[tier:heavy]` |
| `reviewer` | QA sênior adversarial, **sempre `[tier:heavy]`** |
| tier `fast` explícito | Comandos fora do allowlist do `router_run`: `java -version`, `sdkmanager`, `keytool`, `gh` (merge, workflow run, status de checks). Só isso |

### 5.2 Linha de rota
- **Posição:** primeira linha de todo despacho, no formato `[route class=<c> risk=<r> scope=<s> needs=<n,..> d=<d> budget=<n> root=<path>]`.
- **`tier=heavy pin`:** só nos passos marcados `[tier:heavy]` deste plano, que são todos os QA (Qn, QP, QG, QGH) e as tarefas T1.2, T1.3, T1.4, T1.7, T2.1 e T5.2.
- **`model`:** nunca é definido.

### 5.3 Bloco de aceite
Toda tarefa leva `[acceptance] … [/acceptance]`:
- **Código web/núcleo:** `check: testsPass` mais `criteria:` e `deliverable:`.
- **Android:** `check: run command="npm run test:android" expect="BUILD SUCCESSFUL"` (o Gradle imprime essa frase).
- **`cwd:`:** não usado (execução na própria pasta do repositório).

### 5.4 VERIFY
- **`VERIFY:required`:** em toda tarefa que tem dependentes na wave seguinte, e em todo FX de achado major ou mais.
- **`VERIFY:deferred`:** nas demais. Elas precisam ser verificadas com `router_verify` antes do commit da wave.

### 5.5 Retomada
- **`NEED MORE: budget` ou nota `[router budget]`:** retomar a MESMA `sessionID` com "continue and finish".
- **`ESCALATE: authority`:** retomar a mesma sessão (o router amplia a autorização).
- **FAIL de verificação:** retomar a mesma sessão com os achados (o router sobe o tier).
- **CAP:** `CAP:none` só com `reason:` na mesma mensagem.

### 5.6 Gradle e o allowlist
O `router_run` só aceita npm, npx, node e similares. Por isso todo comando Gradle passa por scripts npm que chamam `D:\git\open-auri\tools\run-gradle.mjs`. Esse script escolhe `gradlew.bat` no win32 e `./gradlew` nos demais, encaminha a saída e devolve o código de saída. Scripts (na raiz `D:\git\open-auri\package.json`, delegando para `D:\git\open-auri\apps\android\package.json`):

| Script raiz | Faz |
|---|---|
| `doctor:android` | `node tools/android-doctor.mjs`: confere JDK 21, `ANDROID_HOME`, plataforma 36, build-tools e emulador opcional |
| `sync:android` | `cap sync android` com `OA_ANDROID_TARGET=prod` |
| `build:android` | sync + `assembleDebug` |
| `build:android:e2e` | sync com `OA_ANDROID_TARGET=e2e` + `assembleDebug` |
| `build:android:staging` | sync com `OA_ANDROID_TARGET=staging` + `assembleDebug` |
| `build:android:release` | sync prod + `verifyCapacitorConfig bundleRelease assembleRelease` (assinatura por variáveis de ambiente) |
| `test:android` | `testDebugUnitTest koverVerify` |
| `lint:android` | `lintDebug` |
| `test:android:device` | `connectedDebugAndroidTest` (emulador ou aparelho) |
| `notices:android` | `licensee` + `node tools/android-notices.mjs` (T3.3) |
| `icons:android` | `node tools/android-icons.mjs` (T1.8) |
| `usb:golden` | `node tools/usb-golden.mjs` (T3.6) |
| `play:assets` | `node tools/play-assets.mjs` (P3) |

### 5.7 Modelo de despacho (implementação)

```
[route class=implement risk=high scope=multi needs=edit,shell tier=heavy pin]
1. TASK: <ID e objetivo atômico>
2. EXPECTED OUTCOME: <arquivos e comportamento>
3. TOOLS: informativo; não é whitelist.
4. MUST DO: <subtarefas do plano, na ordem>; escrever só nos arquivos do conjunto W; ler só R ∪ W;
   rodar os testes da área; relatar mudanças pedidas em arquivos compartilhados sem tocá-los.
5. MUST NOT DO: commitar; tocar arquivo fora de W; ler arquivo em W de outra tarefa ativa;
   gravar em cabo físico; abrir .env; usar as any/@ts-ignore/@ts-expect-error/catch vazio; usar U+2014;
   adicionar trailer Co-Authored-By ou "Generated with".
6. CONTEXT: <evidências da seção 2, Anexos B/C/D/G/H, trechos relevantes>
7. ENVIRONMENT: Working directory is D:\git\open-auri (branch feat/android-app). Platform: win32.
   Shell: pwsh. Paths are absolute. You are already here; do not ask for permission to read or write inside it.
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: <critérios da tarefa>
deliverable: <lista W>
[/acceptance]
VERIFY:required
```

### 5.8 Modelo de despacho (QA heavy)

```
[route class=review risk=high scope=repo needs=shell tier=heavy pin]
1. TASK: Qn · QA sênior adversarial da Fase n (rodada r). Quebre a entrega.
2. EXPECTED OUTCOME: lista de achados com severidade (blocking|critical|major|minor), evidência arquivo:linha
   ou saída de comando, reprodução e correção sugerida; ou "PASS" com a prova dos critérios.
3. TOOLS: leitura e router_run (testes, lint, build, test:android).
4. MUST DO: verificar cada critério de aceite e DoD da fase; atacar invariantes 0.12; procurar regressão no
   desktop; rodar a suíte completa da área; conferir cobertura real; revisar testes (asserções fracas,
   mocks que escondem o comportamento, edge cases ausentes); conferir commits (mensagem, pathspec, sem trailers).
5. MUST NOT DO: editar arquivos; aceitar alegação sem prova; gravar em cabo físico.
6. CONTEXT: diff da fase (`git diff <HEAD do PFn>..HEAD`), seção da fase, seção 0.12, Anexos.
7. ENVIRONMENT: Working directory is D:\git\open-auri. Platform: win32. Shell: pwsh.
```

### 5.9 Modelo de mensagem ao mantenedor (Trilha P)

```
Trilha P · Pn · <título>
O que fazer agora (no Play Console / na sua máquina): <passos numerados do Anexo H>
O que eu já deixei pronto: <arquivos com caminho completo>
O que preciso de volta: <dado exato; nunca senha>
Enquanto isso, sigo com: <wave/tarefa em andamento>
```

---

## 6. Paralelismo seguro

**6.1 Regra de concorrência.** Duas tarefas T₁ e T₂ só rodam ao mesmo tempo se: (i) W₁ ∩ W₂ = ∅; (ii) R₁ ∩ W₂ = ∅ e R₂ ∩ W₁ = ∅. Os conjuntos R e W de cada tarefa, inclusive as da Trilha P, estão no plano. O PF de cada fase confere os conjuntos contra o estado real e publica a tabela de locks da fase na seção 14.

**6.2 Locks de arquivo.**
- O orquestrador mantém uma tabela `arquivo → tarefa dona (W)` e `arquivo → leitores ativos (R)`.
- Uma tarefa só é despachada quando consegue todos os seus locks.
- Os locks são liberados no veredito PASS e no commit.
- Arquivos gerados (`build\`, `.gradle\`, `.svelte-kit\`) não entram em R nem em W, mas ficam sob lock de recurso (6.4).

**6.3 Fila de integração (serial, papel `general`).** Estes arquivos compartilhados nunca entram no W de tarefas paralelas:
- `D:\git\open-auri\package.json` e `D:\git\open-auri\package-lock.json`;
- `D:\git\open-auri\web\package.json`;
- `D:\git\open-auri\.github\workflows\ci.yml`;
- `D:\git\open-auri\web\messages\pt-BR.json` e `D:\git\open-auri\web\messages\en-US.json`;
- `D:\git\open-auri\THIRD_PARTY_NOTICES.md`;
- `D:\git\open-auri\docs\README.md`;
- `D:\git\open-auri\.gitignore`, `D:\git\open-auri\.prettierignore` e `D:\git\open-auri\eslint.config.js`.

Funcionamento:
- As tarefas declaram no relatório as mudanças que precisam nesses arquivos.
- A tarefa `In.k` aplica tudo no fim da wave.
- Mensagens novas vão para `D:\git\open-auri\web\messages\_staging\<ID>\pt-BR.json` e `en-US.json`, que a integração funde e remove, conforme `D:\git\open-auri\CONTRIBUTING.md:46-49`.
- Exceção: tarefas em wave serial (W1.1, W1.4, W2.0, W2.3, W3.3) podem escrever esses arquivos diretamente.

**6.4 Locks de recurso** (um titular por vez):

| Lock | Protege |
|---|---|
| `res:gradle` | Qualquer comando Gradle em `D:\git\open-auri\apps\android\android` |
| `res:npm-install` | `npm install` e alterações de lockfile |
| `res:web-unit` | `test:web:unit` |
| `res:web-int` | `test:web:int` |
| `res:web-build` | Build web, `preview`, e2e e capturas de tela da Trilha P |
| `res:emulator` | Emulador Android |
| `res:deploy` | `gh pr merge` e `gh workflow run deploy.yml` (um por vez, 0.21) |

Regra extra: `res:web-unit`, `res:web-int` e `res:web-build` são mutuamente exclusivos (0.17).

**6.5 Barreira de wave.** A wave seguinte só começa quando todas as tarefas da atual estão verificadas, integradas e commitadas. Os passos humanos da Trilha P não fazem parte de nenhuma barreira, exceto P6 e P7 na F4.

**6.6 Leitura durante edição é proibida.** Isso vale também para revisores e PF. Se um QA ou PF precisa ler um arquivo, nenhuma tarefa com esse arquivo em W pode estar ativa. Os QA rodam sempre depois da barreira.

---

## 7. Fases

### Fase 1 · App Android e plugin USB nativo

**Subobjetivo:** o app compila, abre o site, valida a WebView e expõe os plugins `OpenAuriUsb` e `OpenAuriFiles` completos. Tudo testado com backend USB falso e com os bytes oficiais do fixture.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| PF1 | PF1 (+ P0 e P1 da Trilha P iniciados) | Serial |
| W1.1 | T1.1 | Serial (scaffold e tooling) |
| W1.2 | T1.2, T1.3, T1.4, T1.5, T1.6, T1.8, P2, P4 | Paralelo (W disjuntos; `res:gradle` serializa só os builds) |
| W1.3 | I1.1 → T1.7 | Serial (integração e depois a fachada do plugin, que depende de todo W1.2) |
| W1.4 | T1.9 → T1.T | Serial |
| QA | Q1 `[tier:heavy]` → FX1.k → Q1 | Regra 0.5 |

#### PF1 · Pre-flight da Fase 1
`[route class=recon risk=low scope=repo needs=shell]` · `runner`, com itens 3 a 5 por tier `fast` explícito (shell fora do allowlist)
1. `git status` limpo em `D:\git\open-auri`. Se houver trabalho em andamento do usuário (ex.: `D:\git\open-auri\web\src\lib\server\social\*`, `D:\git\open-auri\web\migrations\0013_yolo.sql`), interromper por H-CLEAN.
2. Atualizar `main` e criar a branch `feat/android-app`. Registrar o HEAD na seção 14. H-ID já resolvido: `applicationId` `com.openauri.app`, nome `open-auri`.
3. `gh auth status` (tier `fast`): autenticado no `github.com` com escopos `repo` e `workflow`, para 0.21. Se faltar, H-GH.
4. Toolchain (tier `fast`):
   - `java -version` = 21;
   - `$env:ANDROID_HOME` ou `$env:ANDROID_SDK_ROOT` definidos;
   - `sdkmanager --list_installed` com `platforms;android-36`, `build-tools;36.*` e `platform-tools`;
   - imagem `system-images;android-36;google_apis;x86_64` para a T3.2 local (opcional, pois o CI cobre).

   Instalar o que faltar com `sdkmanager`. Se houver aceite de licença interativo, H-SDK.
5. Node 22.12 ou mais (o CI usa 24) e npm, por tier `fast`.
6. `researcher` (0.14): versões estáveis atuais e compatíveis. Confirmar também:
   - (a) se Turnstile funciona em Android WebView;
   - (b) se `addDocumentStartJavaScript` não é bloqueado pela CSP da página;
   - (c) a versão mínima da WebView com `DOCUMENT_START_SCRIPT`.

   Registrar com URL e data. Se (a) ou (b) for negativo, interromper (0.1 a) com opções.
7. `explorer`:
   - baseline de recursos JS do build web, a partir de `D:\git\open-auri\web\vite.config.ts` (`build.target`) e, se existir, `browserslist`, para definir `minWebViewVersion`;
   - caminho real do ícone SVG do app em `D:\git\open-auri\web\static\`;
   - existência de `D:\git\open-auri\test\tools\check-sensitive.test.mjs`;
   - procedimento de rollback de deploy em `D:\git\open-auri\docs\operacao.md` (para 0.21);
   - se o Environment `production` exige aprovador (via `gh api repos/marco-jardim/open-auri/environments`, tier `fast`).
8. Baseline verde no HEAD: `npm test`, `npm run test:tools`, `npm run check:all`, `npm run -w web test:unit`, depois `npm run -w web test:int` (em série). Falhas pré-existentes ficam registradas para não serem atribuídas à fase.
9. `npm run check:sensitive` sem achados.
10. Iniciar a Trilha P: despachar P0 e enviar ao mantenedor a mensagem de P1 (5.9).
11. Publicar a tabela de locks de W1.2 (seção 14), incluindo P2 e P4.

**Aprovação:** itens 1 a 9 e 11 OK. O item 10 só precisa ter sido disparado.

#### T1.1 · Workspace, scaffold Capacitor e tooling (serial)
`[route class=implement risk=high scope=repo needs=edit,shell]` · `implementer` · VERIFY:required · Dep: PF1

**W:**
- `D:\git\open-auri\apps\android\package.json`
- `D:\git\open-auri\apps\android\capacitor.config.ts`
- `D:\git\open-auri\apps\android\www\index.html`
- `D:\git\open-auri\apps\android\www\offline.html`
- `D:\git\open-auri\apps\android\android\**` (gerado por `cap add android`)
- `D:\git\open-auri\package.json`
- `D:\git\open-auri\package-lock.json`
- `D:\git\open-auri\tools\run-gradle.mjs`
- `D:\git\open-auri\tools\android-doctor.mjs`
- `D:\git\open-auri\test\tools\run-gradle.test.mjs`
- `D:\git\open-auri\test\tools\android-doctor.test.mjs`
- `D:\git\open-auri\.gitignore`
- `D:\git\open-auri\.prettierignore`
- `D:\git\open-auri\eslint.config.js`
- `D:\git\open-auri\tools\check-sensitive.mjs` e o teste dele (caminho do PF1.7)

**R:** `D:\git\open-auri\web\vite.config.ts`, `D:\git\open-auri\.github\workflows\ci.yml`

**Subtarefas:**
1. Criar o workspace `apps/android` e adicioná-lo a `workspaces` em `D:\git\open-auri\package.json`. Dependências: `@capacitor/core`, `@capacitor/cli` e `@capacitor/android`, com a versão exata do PF1.6.
2. `D:\git\open-auri\apps\android\capacitor.config.ts`:
   - `appId: 'com.openauri.app'` e `appName: 'open-auri'`;
   - `webDir: 'www'`;
   - `server.url` derivado de `OA_ANDROID_TARGET`: `prod` → `https://open-auri.com`; `staging` → `STAGING_ORIGIN` obrigatório em HTTPS; `e2e` → `http://10.0.2.2:4173`, com `cleartext: true` só nesse alvo;
   - `server.errorPath: 'offline.html'`;
   - `allowNavigation: []`;
   - `android.appendUserAgent: 'OpenAuriAndroid/<versão>'`;
   - `android.minWebViewVersion` do PF1.7;
   - `android.webContentsDebuggingEnabled` só fora de `prod`;
   - validação que lança erro em combinações inválidas.
3. `www\index.html` (carregamento) e `www\offline.html` (sem rede, com "Tentar de novo" e texto pt-BR/en-US pelo `navigator.language`), sem script externo.
4. `npx cap add android`. Converter `MainActivity.java` para `MainActivity.kt` mínimo (a T1.5 completa). Namespace Gradle `com.openauri.app`; pacotes de código `com.openauri.app`, `com.openauri.usb` e `com.openauri.files`.
5. Gradle (`app\build.gradle`, `variables.gradle`, `build.gradle` e `settings.gradle` em `D:\git\open-auri\apps\android\android\`):
   - minSdk 26, compile/targetSdk 36, JDK 21, Kotlin, AGP e Gradle do PF1.6;
   - dependências: `androidx.webkit`; teste: JUnit4, Robolectric, `org.json`, `com.networknt:json-schema-validator`; androidTest: `androidx.test.ext:junit`, runner e Espresso-Intents;
   - Kover com verificação de 90% de linhas e branches nos pacotes `com.openauri.usb` e `com.openauri.files`;
   - Licensee com a lista de licenças permitidas (RS5);
   - `distributionSha256Sum` no wrapper;
   - `gradle\verification-metadata.xml` gerado com `--write-verification-metadata sha256`;
   - tarefa `verifyCapacitorConfig`, que lê `app\src\main\assets\capacitor.config.json` e falha no release se 0.12.5 for violado.
6. `D:\git\open-auri\tools\run-gradle.mjs` (Gradle por plataforma, código de saída preservado, sem shell) e `D:\git\open-auri\tools\android-doctor.mjs` (relatório legível; sai com código ≠ 0 se faltar requisito). Scripts da seção 5.6 que já tenham alvo existente nesta tarefa: `doctor:android`, `sync:android`, `build:android*`, `test:android`, `lint:android`, `test:android:device`.
7. Ignorar no Git os caminhos `apps/android/android/app/build/`, `apps/android/android/build/`, `apps/android/android/.gradle/`, `apps/android/android/local.properties`, `apps/android/android/app/src/main/assets/public/`, `apps/android/android/app/src/main/assets/capacitor.config.json`, `*.jks`, `*.keystore`, `*.pepk`, `keystore.properties`.
8. Prettier: ignorar `apps/android/android/`. ESLint: ignorar `apps/**` exceto `apps/android/capacitor.config.ts`, se a config raiz suportar TS. Se não suportar, o arquivo é checado por `tsc` via `apps/android/tsconfig.json`.
9. `check-sensitive`: bloquear os padrões de 0.15, com testes.

**Testes:**
- `run-gradle.test.mjs`: escolha do executável por plataforma, propagação do código de saída, argumentos repassados sem shell, erro claro sem wrapper;
- `android-doctor.test.mjs`: cada requisito faltante gera mensagem e código ≠ 0, sem ler segredos;
- `check-sensitive`: novos padrões.

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
check: run command="npm run build:android" expect="BUILD SUCCESSFUL"
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
check: lintClean
criteria: workspace apps/android criado com appId com.openauri.app; cap sync e assembleDebug verdes; verifyCapacitorConfig falha com server.url diferente de https://open-auri.com no release (teste do próprio Gradle ou script); nenhum arquivo gerado ou segredo versionado; scripts da seção 5.6 desta tarefa funcionam via npm.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T1.2 · Parser de HID report descriptor e framing `[tier:heavy]`
`[route class=implement risk=high scope=multi needs=edit,shell tier=heavy pin]` · `implementer` · VERIFY:required · Dep: T1.1

**W:**
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\HidReportDescriptor.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\HidFraming.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\HidReportDescriptorTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\HidFramingTest.kt`

**R:** `D:\git\open-auri\docs\protocol-0xcb.md`, Anexo D

**Subtarefas:**
1. Parser de itens curtos e longos (HID 1.11 §6.2.2):
   - Global: Report ID, Report Size, Report Count, Usage Page, com Push e Pop;
   - Local: Usage;
   - Main: Input, Output, Feature, Collection, End Collection.
2. Para cada report ID: bits de Input, Output e Feature, convertidos para bytes com arredondamento para cima.
3. Detectar `usesReportIds`.
4. Erros tipados para: descritor truncado, Pop sem Push, Collection desbalanceada, Report Size × Count acima de 65535 bits e item reservado.
5. `HidFraming.buildOutput(reportId, data, descriptor)`:
   - valida o report declarado como Output;
   - recusa dados maiores que o declarado;
   - monta `[reportId] + data` com padding zero até `maxOutputReportBytes + 1` (política única `WINDOWS_MAX_OUTPUT`, Anexo D.2);
   - em dispositivos sem report ID, não prefixa zero no fio.
6. `HidFraming.setReportSetup(reportId, interfaceId, length)` = `(0x21, 0x09, 0x0200 or reportId, interfaceId, length)`.

**Testes:**
- descritores reais de exemplo (teclado, gamepad, vendor 0xFF00);
- descritor sintético do CB5100 conforme a hipótese de `D:\git\open-auri\src\transport\fake-device.mjs:172-185` (Output, ID 0xCB, size 8, count 31);
- descritor com vários output reports de tamanhos diferentes (padding até o maior + 1);
- truncamentos em cada posição; itens longos; Push e Pop aninhados;
- ID zero; dados de 0, 30, 31 e 32 bytes.

```
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: parser cobre todos os itens listados e recusa descritores malformados sem exceção não tipada; framing produz [0xCB]+31 B (32 B) para o descritor sintético e completa até o maior output report + 1 quando houver outros; cobertura dos dois arquivos >= 95% de linhas e branches.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T1.3 · FrameGuard, CRC16 e constantes do protocolo `[tier:heavy]`
`[route class=implement risk=high scope=multi needs=edit,shell tier=heavy pin]` · `implementer` · VERIFY:required · Dep: T1.1

**W:**
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\ProtocolConstants.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\Crc16Ccitt.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\FrameGuard.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\Crc16CcittTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\FrameGuardTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\ProtocolFixtureTest.kt`

**R:**
- `D:\git\open-auri\src\dsp\eq0xcb.mjs`
- `D:\git\open-auri\src\transport\webhid.mjs`
- `D:\git\open-auri\docs\protocol-0xcb.md`
- `D:\git\open-auri\test\fixtures\eq0xcb.reference.json` (lido direto pelo teste via `rootProject.file("../../../test/fixtures/eq0xcb.reference.json")`, sem cópia)

**Subtarefas:**
1. Constantes copiadas com referência de linha:
   - `HID_REPORT_ID` = 0xCB (`eq0xcb.mjs:47`);
   - `REPORT_SIZE` = 31 (`eq0xcb.mjs:66`);
   - `REPORT_COUNT` = 9 (`eq0xcb.mjs:67`);
   - `PAYLOAD_SIZE` = 220 (`eq0xcb.mjs:64`);
   - `PREAMBLE` (`eq0xcb.mjs:56`);
   - `COMMIT` (`eq0xcb.mjs:61`) com padding (`eq0xcb.mjs:562`);
   - `WRITE_SPACING_MS` = 2000 (`webhid.mjs:116`);
   - layout do índice e dos dados por report (`docs\protocol-0xcb.md:120-123`).

   Teste de deriva: compara as constantes Kotlin com os valores extraídos de `eq0xcb.mjs` e `webhid.mjs` por regex. Se o JS mudar, o teste quebra.
2. CRC-16/CCITT-FALSE, com check value 0x29B1 (`D:\git\open-auri\src\dsp\eq0xcb.mjs`, conforme o commit `4af754c`).
3. `FrameGuard` por dispositivo, com relógio injetável (Anexo D.3):
   - `onReport(bytes, now)` → `Forward | Reject(reason)`;
   - estados `Idle`, `Receiving(n)` e `AwaitCommit`;
   - timeout de 2000 ms entre reports da mesma sequência, que volta para `Idle`;
   - commit só em `AwaitCommit`, depois de remontar o payload e validar preâmbulo e CRC, e com pelo menos `WRITE_SPACING_MS` desde o último commit;
   - qualquer rejeição zera o estado.
   - O guard não avalia o gate: curvas YOLO bem formadas passam, como no desktop.

**Testes:**
- os 11 presets e o Neutro do fixture passam;
- 1 bit invertido em cada byte do payload falha no CRC ou no preâmbulo;
- índice fora de ordem, repetido ou ausente;
- commit sem os 9 reports; dois commits seguidos;
- commit a 1999 ms e a 2000 ms;
- timeout entre reports; tamanho 30 e 32;
- report ID 0x00 e 0xCA; commit com byte extra não zero;
- sequência nova no meio de outra.

```
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: todos os casos acima cobertos; teste de deriva com o JS verde; nenhuma rejeição envia bytes; cobertura >= 95% nos três arquivos.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T1.4 · Backend USB Host `[tier:heavy]`
`[route class=implement risk=high scope=multi needs=edit,shell tier=heavy pin]` · `implementer` · VERIFY:required · Dep: T1.1

**W:**
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\UsbBackend.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\AndroidUsbBackend.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\PermissionBroker.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\ClaimManager.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\UsbFailure.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\FakeUsbBackend.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\AndroidUsbBackendTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\PermissionBrokerTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\ClaimManagerTest.kt`

**R:** Anexo D

**Subtarefas:**
1. Interface `UsbBackend`:
   - `list(filters)`, `hasPermission(dev)`, `requestPermission(dev)`, `open(dev)`;
   - `rawDescriptors(conn)`;
   - `hidReportDescriptor(conn, ifaceId, length)`: GET_DESCRIPTOR `0x81, 0x06, 0x2200, ifaceId`;
   - `findHidInterface(dev)`: classe 0x03, escolhida explicitamente e nunca por `getInterface(0)` às cegas;
   - `transferInterrupt(conn, ep, buf, timeoutMs)`;
   - `controlOut(conn, setup, buf, timeoutMs)`;
   - `claim`, `release`, `close`;
   - eventos `attached` e `detached`.
2. `AndroidUsbBackend`:
   - `UsbManager`;
   - `UsbRequest.initialize` + `queue(ByteBuffer)` + `requestWait(timeout)` para interrupt OUT, com `cancel` no timeout;
   - `controlTransfer` com timeout;
   - executor de thread única por dispositivo;
   - nenhuma I/O na main thread.
3. `PermissionBroker`:
   - `PendingIntent` com intent explícito para o pacote e `FLAG_MUTABLE` (necessário para receber `EXTRA_PERMISSION_GRANTED` e `EXTRA_DEVICE`; com target 34 ou mais, intent mutável exige pacote ou componente explícito);
   - receiver com `RECEIVER_NOT_EXPORTED` e ação privada `com.openauri.usb.PERMISSION`;
   - uma solicitação por dispositivo de cada vez; negação resolve `false`;
   - sem vazamento de receiver.
4. `ClaimManager`:
   - `claimInterface(intf, true)` sob demanda, no primeiro envio da sequência;
   - `releaseInterface` depois de 1500 ms ocioso, em `onStop` da Activity e no detach;
   - nunca faz reset do dispositivo nem `setConfiguration`;
   - registra se o driver do kernel foi desanexado (para o Diagnóstico).
5. Receivers dinâmicos de `ACTION_USB_DEVICE_ATTACHED` e `DETACHED` (broadcasts de sistema); detach cancela transfer pendente e emite evento.
6. `FakeUsbBackend` (só em `src\test`), com falhas injetáveis espelhando `D:\git\open-auri\src\transport\fake-device.mjs:31-38`: detach no report k, timeout, erro de transferência, permissão negada, claim EBUSY e descritor customizável.

**Testes (Robolectric):**
- permissão concedida, negada e solicitação concorrente;
- detach durante transfer;
- timeout em `requestWait`;
- escolha da interface HID num dispositivo composto (áudio 0x01 + HID 0x03), sem confundir com a interface 0;
- claim ocioso solto em 1500 ms;
- `onStop` solta; nenhuma I/O na main thread (asserção de `Looper`).

```
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: todos os casos acima cobertos; nenhuma chamada USB na main thread; receivers registrados com flags corretas para target 36; cobertura >= 90% nos arquivos do conjunto W.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T1.5 · Shell do app: Activity, WebView, rede, backup, strings
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T1.1

**W:**
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\app\MainActivity.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\app\WebViewCompatGate.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\AndroidManifest.xml`
- `D:\git\open-auri\apps\android\android\app\src\main\res\xml\network_security_config.xml`
- `D:\git\open-auri\apps\android\android\app\src\debug\res\xml\network_security_config.xml`
- `D:\git\open-auri\apps\android\android\app\src\main\res\xml\data_extraction_rules.xml`
- `D:\git\open-auri\apps\android\android\app\src\main\res\xml\backup_rules.xml`
- `D:\git\open-auri\apps\android\android\app\src\main\res\layout\activity_webview_update.xml`
- `D:\git\open-auri\apps\android\android\app\src\main\res\values\strings.xml`
- `D:\git\open-auri\apps\android\android\app\src\main\res\values-pt\strings.xml`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\app\WebViewCompatGateTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\app\ManifestPolicyTest.kt`

**R:** `D:\git\open-auri\apps\android\capacitor.config.ts`

**Subtarefas:**
1. Manifest:
   - `INTERNET`;
   - `uses-feature usb.host required=false`;
   - `allowBackup=false`, `fullBackupContent` e `dataExtractionRules` excluindo tudo;
   - `usesCleartextTraffic=false`;
   - `networkSecurityConfig`;
   - Activity `singleTask`;
   - intent-filter de App Links `https://open-auri.com` com `autoVerify=true` (a verificação depende do `assetlinks.json` da T2.4 e da chave H-KEY).
2. `network_security_config`: em main, sem cleartext; em debug, cleartext só para `10.0.2.2`.
3. `WebViewCompatGate`:
   - checa `WebViewFeature.DOCUMENT_START_SCRIPT` e a versão do pacote da WebView contra `minWebViewVersion`;
   - se insuficiente, mostra `activity_webview_update` com botão para a página da Play do "Android System WebView" (ou do pacote de WebView ativo) e texto acessível.
4. `MainActivity.kt`:
   - `BridgeActivity`;
   - gate antes de `super.onCreate`;
   - sem registro de plugins aqui (a T1.7 faz isso).
5. Strings en-US e pt-BR de todas as telas nativas.

**Testes:**
- política do manifest (permissões exatas, backup, cleartext) lida do manifest mesclado;
- gate com WebView suficiente, versão baixa, recurso ausente e pacote de WebView desconhecido.

```
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
check: run command="npm run lint:android" expect="BUILD SUCCESSFUL"
criteria: manifest com permissões exatamente INTERNET e usb.host opcional; backup desligado; cleartext só em debug para 10.0.2.2; tela de atualização da WebView acessível e testada.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T1.6 · Plugin de arquivos e downloads
`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T1.1

**W:**
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\files\OpenAuriFilesPlugin.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\files\DownloadBridge.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\files\OpenAuriFilesPluginTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\files\DownloadBridgeTest.kt`

**Subtarefas:**
1. `OpenAuriFiles.save({ name, mime, base64 })`:
   - abre `ACTION_CREATE_DOCUMENT` (SAF) com nome sugerido sanitizado (sem `/`, `\`, `..` nem controles; até 128 caracteres);
   - grava os bytes;
   - resolve `{ saved: true }`, ou `{ saved: false }` se o usuário cancelar;
   - limite de 50 MB;
   - mime de uma lista permitida: `application/json`, `text/plain`, `application/octet-stream`, `image/png`, `image/svg+xml`, `application/gzip`.
2. `DownloadBridge`: `DownloadListener` para respostas HTTP com `Content-Disposition: attachment` da origem fixada (ex.: `/conta/exportar`). Ele baixa com os cookies do `CookieManager` da mesma origem e salva via SAF. De outras origens, abre no navegador do sistema.

**Testes:**
- nomes perigosos;
- mime fora da lista;
- tamanho no limite e acima;
- cancelamento;
- anexo de origem estranha;
- cookie só da origem fixada.

```
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: casos acima cobertos; nenhum arquivo é gravado sem escolha do usuário; cookies nunca enviados a outra origem; cobertura >= 90%.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T1.8 · Ícones do app
`[route class=implement risk=low scope=multi needs=edit,shell]` · `implementer` · Dep: T1.1

**W:**
- `D:\git\open-auri\tools\android-icons.mjs`
- `D:\git\open-auri\test\tools\android-icons.test.mjs`
- `D:\git\open-auri\apps\android\android\app\src\main\res\mipmap-mdpi\` até `mipmap-xxxhdpi\` (`ic_launcher.png`, `ic_launcher_round.png`, `ic_launcher_foreground.png`)
- `D:\git\open-auri\apps\android\android\app\src\main\res\mipmap-anydpi-v26\ic_launcher.xml`
- `D:\git\open-auri\apps\android\android\app\src\main\res\mipmap-anydpi-v26\ic_launcher_round.xml`
- `D:\git\open-auri\apps\android\android\app\src\main\res\values\ic_launcher_background.xml`

**R:** o SVG do PF1.7, `D:\git\open-auri\node_modules\@cf-wasm\resvg\`

**Subtarefas:** renderizar PNGs pelos tamanhos padrão (48, 72, 96, 144 e 192 px; foreground adaptativo 108 dp com área segura de 66 dp) usando `@cf-wasm/resvg`, que já é dependência do web. Ícone adaptativo com cor de fundo do token de marca. Exportar a função de renderização para a P3 reusar no ícone de 512 px da Play. Script `icons:android` vai para a fila I1.1.

**Testes:** dimensões de cada PNG; saída determinística (hash estável); SVG ausente gera erro claro.

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
criteria: ícones gerados e determinísticos; ícone adaptativo válido (lintDebug sem avisos de ícone); função de renderização exportada.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### I1.1 · Integração da W1.2
`[route class=mechanical risk=medium scope=repo needs=edit,shell]` · `general` · VERIFY:required

**W:** arquivos da seção 6.3 pedidos pelas tarefas da W1.2 (ex.: script `icons:android` em `D:\git\open-auri\package.json`).

**Subtarefas:** aplicar os pedidos e rodar `npm run test:tools` e `npm run build:android`.

```
[acceptance]
check: run command="npm run build:android" expect="BUILD SUCCESSFUL"
criteria: todos os pedidos de arquivos compartilhados da W1.2 aplicados exatamente; build verde.
deliverable: diffs nos arquivos compartilhados
[/acceptance]
```

#### T1.7 · Fachada do plugin `OpenAuriUsb`, OriginGuard, seletor, diagnóstico e registro `[tier:heavy]`
`[route class=implement risk=high scope=multi needs=edit,shell tier=heavy pin]` · `implementer` · VERIFY:required · Dep: T1.2, T1.3, T1.4, T1.5, T1.6, I1.1

**W:**
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\OpenAuriUsbPlugin.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\OriginGuard.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\DevicePicker.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\Diagnostics.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\ErrorCodes.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\app\MainActivity.kt`
- `D:\git\open-auri\schemas\android-usb-bridge-1.schema.json`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\OpenAuriUsbPluginTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\OriginGuardTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\DevicePickerTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\DiagnosticsTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\BridgeSchemaTest.kt`

**R:** arquivos de W da T1.2, T1.3, T1.4, T1.5 e T1.6; Anexos B, C e D

**Subtarefas:**
1. Métodos do Anexo B: `getInfo`, `requestDevice`, `getDevices`, `open`, `close`, `sendReport`, `diagnostics`. Eventos `connect` e `disconnect`.
2. `OriginGuard`: antes de cada método, compara a origem da URL atual da WebView com a origem de `bridge.getConfig().getServerUrl()`. Divergência → `USB_ORIGIN`.
3. `requestDevice`:
   - filtra por VID/PID;
   - 0 cabos → `{devices: []}`;
   - 1 cabo → permissão;
   - 2 ou mais → `DevicePicker` (diálogo nativo de múltipla escolha, acessível) e permissão para cada escolhido;
   - negar ou cancelar → `{devices: []}`, como no seletor do WebHID.
4. `sendReport`:
   - valida argumentos (`USB_BAD_ARGS` → `TypeError`);
   - `FrameGuard.onReport`;
   - descritor em cache por conexão (lido no `open`);
   - `HidFraming`;
   - escolhe interrupt OUT ou SET_REPORT (Anexo D.1);
   - `ClaimManager`;
   - backend com timeout de 1000 ms;
   - mapeamento de erro do Anexo C;
   - no detach, emite `disconnect` antes de rejeitar o pendente.
5. Chave estável do dispositivo: `deviceName#deviceId`, válida durante uma conexão física. Reconectar gera chave nova, e o JS cria objeto novo.
6. `diagnostics`: JSON do Anexo B.
7. `MainActivity.kt`: `registerPlugin(OpenAuriUsbPlugin::class.java)` e `registerPlugin(OpenAuriFilesPlugin::class.java)` antes de `super.onCreate`, e `DownloadBridge` ligado à WebView do bridge.
8. Schema JSON do contrato. `BridgeSchemaTest` valida toda resposta e evento do plugin contra ele.

**Testes:**
- cada método em cada estado;
- origem divergente em todos os métodos;
- sequências reais do fixture passam ponta a ponta no `FakeUsbBackend`, com os buffers emitidos iguais ao Anexo D;
- detach no report k (0..9) nunca emite commit;
- timeout vira `NotAllowedError`;
- concorrência na mesma chave → `USB_BUSY`;
- seletor com 2 e 3 cabos e cancelamento;
- `getInfo` com e sem `FEATURE_USB_HOST`.

```
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
check: run command="npm run lint:android" expect="BUILD SUCCESSFUL"
criteria: contrato do Anexo B implementado e validado pelo schema; invariantes 0.12.3, 0.12.4 e 0.12.7 provados por teste; nenhuma I/O fora do executor; cobertura >= 90% no pacote.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T1.9 · Jobs Android no CI, com filtro por caminhos (serial)
`[route class=implement risk=medium scope=single needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T1.7

**W:** `D:\git\open-auri\.github\workflows\ci.yml`

**Subtarefas:**
1. **Filtro de caminhos:** job `changes` com `dorny/paths-filter` (versão do PF1.6). O job `android` roda:
   - em `pull_request`, só quando mudam `apps/android/**`, `web/src/lib/cable/**`, `web/src/lib/files/**`, `src/dsp/**`, `src/transport/**`, `schemas/android-*`, `test/fixtures/**`, `tools/run-gradle.mjs`, `tools/android-*.mjs`, `tools/usb-golden.mjs`, `tools/play-assets.mjs` ou `.github/workflows/ci.yml`;
   - em `push` para `main`, sempre.
2. **Job `android`:**
   - `actions/setup-java` (temurin 21) e `actions/setup-node` (24);
   - SDK via `android-actions/setup-android` ou o do runner;
   - `npm ci`, `npm run test:tools`, `npm run lint:android`, `npm run test:android` (Kover), `npm run build:android`;
   - `npm run build:android:release` com keystore efêmero gerado no job, para provar `verifyCapacitorConfig` e a assinatura;
   - upload do APK de debug como artefato;
   - cache do Gradle;
   - permissões `contents: read`.
3. Os jobs existentes (`static`, `test`, `build`, `e2e`) não mudam. O job `android` entra na lista de checks exigidos do PR quando acionado (o merge de 0.21 confere todos os checks do HEAD).

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
criteria: jobs definidos com os passos acima; filtro cobre exatamente os caminhos listados e roda sempre em main; YAML válido (actionlint via npx se disponível, senão revisão); nenhum segredo real usado; release de teste usa keystore efêmero.
deliverable: ci.yml atualizado
[/acceptance]
```

#### T1.T · Bateria de testes da Fase 1
`[route class=implement risk=medium scope=repo needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\EndToEndFixtureTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\DescriptorFuzzTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\GuardAdversarialTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\LifecycleTest.kt`

**Casos:**
- **Ponta a ponta com o fixture:** replay da sequência exata que `writeCurve` faria (9 reports com espaços de 16 ms, settle de 150 ms, commit) para os 11 presets e o Neutro, nas duas rotas de transferência. Os buffers emitidos são iguais byte a byte ao esperado.
- **Fuzz do parser:** 10.000 descritores aleatórios com semente fixa, sem exceção não tipada.
- **Guard adversarial:** permutações de ordem; reports duplicados; commit forjado com CRC válido mas preâmbulo errado; spam de commits (só 1 a cada 2 s passa); dois dispositivos intercalados (estado isolado por chave).
- **Ciclo de vida:** app em segundo plano no meio da sequência (onStop solta o claim; a sequência expira sem commit); rotação de tela; processo recriado; permissão revogada entre `open` e `sendReport`.
- **Suíte completa:** `npm run test:android` com Kover acima dos limites; `npm run lint:android`; `npm run test:tools`; `npm test`, para provar o núcleo intacto.

```
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
check: run command="npm test" expect="pass"
criteria: todos os casos acima verdes; Kover >= 90% linhas e branches em com.openauri.usb e com.openauri.files; núcleo src/ sem diff na fase.
deliverable: testes novos
[/acceptance]
```

#### Critérios de aceite F1
1. `npm run build:android`, `npm run test:android` e `npm run lint:android` verdes no Windows local e no job `android` do CI.
2. O plugin implementa o Anexo B inteiro, validado pelo schema.
3. Os buffers do fixture batem byte a byte nas duas rotas de transferência.
4. Os invariantes 0.12.3 a 0.12.7 estão provados por teste.
5. `D:\git\open-auri\src\` sem diff; suítes existentes verdes.
6. Nenhum arquivo gerado ou segredo versionado; `check:sensitive` verde.
7. O filtro de caminhos do CI dispara o job `android` nos caminhos certos e nunca em PR só de docs.

#### DoD F1
Critérios OK, Q1 PASS (0.5), commits por tarefa, push da branch, seção 14 atualizada.

#### Q1 · QA sênior adversarial da Fase 1 `[tier:heavy]`
`[route class=review risk=high scope=repo needs=shell tier=heavy pin]` · `reviewer`

**Foco:**
- Parser HID: robustez e conformidade com HID 1.11.
- FrameGuard: dá para enviar um commit inválido? Dá para gastar a flash?
- Threading e timeouts: há I/O pendurada que trava o próximo envio?
- Permissões em target 36: `PendingIntent` mutável com pacote explícito.
- OriginGuard: dá para chamar o plugin de outra origem?
- Manifest e backup; cobertura real versus asserções fracas.
- Supply chain: `verification-metadata`, wrapper, Licensee.
- Filtro do CI: algum caminho relevante escapa?

Os achados viram FX1.k e o Q1 roda de novo (0.5).

---

### Fase 2 · Integração no site

**Subobjetivo:** dentro do app, o site usa o transporte nativo de forma transparente, com o mesmo gate, checklist, diário e fila de vários cabos. Além disso:
- o aviso de não validado e o controle remoto da gravação funcionam;
- os downloads funcionam;
- a UI informa o estado nativo;
- o Chrome Android oferece o app.

Desktop e navegadores sem app ficam sem nenhuma regressão.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| PF2 | PF2 | Serial |
| W2.0 | T2.0 | Serial (dependência `@capacitor/core` e módulo de estado do Android) |
| W2.1 | T2.1, T2.2, T2.4 | Paralelo (W disjuntos) |
| W2.2 | T2.3, T2.5 | Paralelo (W disjuntos) |
| W2.3 | T2.6 | Serial (checklist; escreve `types.ts`, que os builds da W2.2 leem) |
| W2.4 | I2.1 | Serial (mensagens e orçamentos) |
| W2.5 | T2.T | Serial |
| QA | Q2 `[tier:heavy]` → FX2.k → Q2 | Regra 0.5 |

#### PF2 · Pre-flight da Fase 2
`[route class=recon risk=low scope=repo needs=shell]` · `runner` + `explorer`
1. Q1 PASS registrado; `git status` limpo; HEAD registrado.
2. `researcher`: versões (0.14); confirmação de que `@capacitor/core` no navegador comum não cria `isNativePlatform() === true`.
3. `explorer`: lista completa dos pontos de download no web, com busca em `D:\git\open-auri\web\src` por `download=`, `.download =`, `URL.createObjectURL`, `navigator.share`, `window.open(` e `location.href =` com URL de anexo. Cada ocorrência com arquivo:linha. Essa lista define o W da T2.2. Se algum arquivo cair também no W da T2.3 ou da T2.6, a parte de download desse arquivo vai para a T2.2, e a outra tarefa lê o resultado depois do commit (6.6).
4. `explorer`: confirmar que SvelteKit aceita a rota `D:\git\open-auri\web\src\routes\.well-known\assetlinks.json\+server.ts` com o adapter atual e que os headers de `D:\git\open-auri\web\src\lib\server\security\headers.ts` se aplicam.
5. `explorer`: localizar o teste de deriva do env tipado (`D:\git\open-auri\web\src\lib\server\env.ts` contra o template `D:\git\open-auri\web\wrangler.template.jsonc`).
6. `explorer`: estrutura dos itens do checklist (`D:\git\open-auri\web\src\lib\cable\checklist.ts:225-244`, `D:\git\open-auri\web\src\lib\cable\types.ts:176`), como itens condicionais entram (experimentais, YOLO), onde ficam os testes atuais do checklist e como `D:\git\open-auri\web\src\lib\components\cable\PreWriteChecklist.svelte` os renderiza.
7. Baseline: `npm run -w web test:unit`, depois `npm run -w web test:int`, depois `npm run -w web test:e2e` (em série); `npm run -w web budgets`.
8. Estado da Trilha P registrado na seção 14.
9. Tabelas de locks de W2.1, W2.2 e W2.3 publicadas.

**Aprovação:** todos os itens OK.

#### T2.0 · `@capacitor/core` no web e módulo de estado do Android (serial)
`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\package.json`
- `D:\git\open-auri\package-lock.json`
- `D:\git\open-auri\test\tools\capacitor-version-parity.test.mjs`
- `D:\git\open-auri\web\src\lib\cable\android-status.ts`
- `D:\git\open-auri\web\tests\unit\cable\android-status.test.ts`

**Subtarefas:**
1. Adicionar `@capacitor/core` com a mesma versão exata de `D:\git\open-auri\apps\android\package.json`.
2. Teste de paridade de versões: `@capacitor/core` do web, `@capacitor/core`, `@capacitor/android` e `@capacitor/cli` do app, todos iguais.
3. `android-status.ts`, com um comentário de uma linha por constante apontando para `D:\git\open-auri\docs\operacao\runbooks\android-release.md`:
   - `ANDROID_WRITE_VALIDATED = false`;
   - `ANDROID_DISCLAIMER_VERSION = 1`;
   - `ANDROID_WRITE_POLICY = { enabled: true, blockedAppVersions: [] as readonly string[] }`;
   - `isAppVersionBlocked(appVersion)`, com semver exato e faixas `<x.y.z`;
   - `canWriteFromApp(appVersion)`.

**Testes:** semver (pré-release, versão inválida, faixa, lista vazia); `enabled=false`; combinação de versão bloqueada e política ligada.

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
check: testsPass
criteria: versões iguais e teste de paridade verde; android-status.ts tipado e coberto 100%; build web inalterado.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T2.1 · Ponte nativa, `NativeHID` e detecção `[tier:heavy]`
`[route class=implement risk=high scope=multi needs=edit,shell tier=heavy pin]` · `implementer` · VERIFY:required · Dep: T2.0

**W:**
- `D:\git\open-auri\web\src\lib\cable\native\bridge.ts`
- `D:\git\open-auri\web\src\lib\cable\native\hid.ts`
- `D:\git\open-auri\web\src\lib\cable\native\detect.ts`
- `D:\git\open-auri\web\src\lib\cable\native\errors.ts`
- `D:\git\open-auri\web\src\lib\cable\native\index.ts`
- `D:\git\open-auri\web\src\lib\cable\types.ts`
- `D:\git\open-auri\web\tests\unit\cable\native-hid.test.ts`
- `D:\git\open-auri\web\tests\unit\cable\native-detect.test.ts`
- `D:\git\open-auri\web\tests\unit\cable\native-errors.test.ts`
- `D:\git\open-auri\web\tests\unit\cable\native-contract.test.ts`

**R:**
- `D:\git\open-auri\src\transport\webhid.mjs`
- `D:\git\open-auri\src\transport\fake-device.mjs`
- `D:\git\open-auri\web\src\lib\cable\service.ts`
- `D:\git\open-auri\web\src\lib\cable\android-status.ts`
- `D:\git\open-auri\schemas\android-usb-bridge-1.schema.json`

**Subtarefas:**
1. `detect.ts`:
   - `detectNativeCable()` é síncrono e barato: `typeof window.Capacitor?.isNativePlatform === 'function' && window.Capacitor.isNativePlatform() && window.Capacitor.getPlatform() === 'android'`;
   - só então faz import dinâmico de `bridge.ts` (que importa `@capacitor/core`), para o bundle de desktop não crescer;
   - handshake com `getInfo()`: `bridgeApi` dentro de `SUPPORTED_BRIDGE_API` = `[1, 1]`;
   - avalia `canWriteFromApp(appVersion)`;
   - resultados `{ kind: 'native', hid, appVersion } | { kind: 'native-outdated', appVersion } | { kind: 'native-write-disabled', appVersion } | { kind: 'native-no-usb-host', appVersion } | { kind: 'none' }`;
   - em `native-write-disabled`, o `hid` não é criado, então nenhuma chamada de I/O ao plugin é possível (0.12.10).
2. `hid.ts`:
   - `NativeHID` implementa o `HidLike` do web e o `CableHID` do núcleo: `requestDevice`, `getDevices`, `addEventListener`/`removeEventListener` de `connect` e `disconnect` com `event.device` estável;
   - `NativeHIDDevice` com `opened`, `vendorId`, `productId`, `productName`, `open()`, `close()`, `sendReport(reportId, data)`, com dados em base64;
   - identidade estável por chave nativa (Map); objetos de chaves que somem são descartados no `disconnect`.
3. `errors.ts`: Anexo C, códigos nativos → `DOMException(name)` ou `TypeError`. Sem catch vazio; código desconhecido → `DOMException('NotAllowedError')` com a mensagem original.
4. `types.ts`: alinhar `HidLike` para aceitar `NativeHID` sem cast e sem `any`.

**Testes:**
- detecção em navegador comum, app atual, app desatualizado, sem USB host, política desligada e versão bloqueada;
- import dinâmico ausente no caminho desktop (asserção sobre `import()` mockado);
- identidade de dispositivo em connect, disconnect e reconnect;
- todos os códigos do Anexo C;
- dados de 0, 31 e 32 bytes;
- contrato validado contra o schema com `ajv` (já é devDependency, `D:\git\open-auri\package.json:88-101`).

```
[acceptance]
check: testsPass
criteria: NativeHID satisfaz os tipos sem cast; mapeamento de erros completo; política remota impede criar o hid; desktop não importa @capacitor/core; cobertura >= 95% nos arquivos novos.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T2.2 · Abstração de salvar arquivo e migração dos downloads
`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T2.0

**W:**
- `D:\git\open-auri\web\src\lib\files\save.ts`
- `D:\git\open-auri\web\tests\unit\files\save.test.ts`
- os arquivos de chamada listados no PF2.3 (caminhos completos copiados do relatório do PF2 para o despacho)

**Subtarefas:**
1. `saveFile({ name, mime, bytes })`:
   - no navegador: âncora com `download` e `URL.revokeObjectURL` após o clique;
   - no app: `OpenAuriFiles.save`, detectado só por `window.Capacitor?.getPlatform?.() === 'android'`, sem ler o W da T2.1;
   - retorna `{ saved: boolean }`.
2. Migrar cada ponto de download listado para `saveFile`, sem mudar nomes de arquivo nem conteúdo.
3. `navigator.share`, se existir no código: manter com fallback para copiar link quando ausente (a WebView não tem Web Share).

**Testes:** navegador (âncora criada e revogada), app (plugin chamado com base64 correto), cancelamento, erro do plugin propagado, cada ponto migrado com teste de componente existente ou novo.

```
[acceptance]
check: testsPass
criteria: nenhum download do site depende de âncora quando no app; nomes e bytes idênticos aos atuais no navegador; testes existentes de exportação verdes.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T2.4 · Servidor: rótulo de sessão e `assetlinks.json`
`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T2.0

**W:**
- `D:\git\open-auri\web\src\lib\server\auth\user-agent.ts`
- `D:\git\open-auri\web\tests\unit\server\auth\user-agent-logger.test.ts`
- `D:\git\open-auri\web\src\routes\.well-known\assetlinks.json\+server.ts`
- `D:\git\open-auri\web\src\lib\server\android\app-links.ts`
- `D:\git\open-auri\web\src\lib\server\env.ts`
- `D:\git\open-auri\web\wrangler.template.jsonc`
- `D:\git\open-auri\.env.example`
- teste de deriva do env (caminho do PF2.5)
- `D:\git\open-auri\web\tests\integration\android\assetlinks.test.ts`

**Subtarefas:**
1. User-agent: `OpenAuriAndroid/<versão>` → rótulo "App Android <versão>", com prioridade sobre "Android".
2. `PUBLIC_ANDROID_APP_ID` (`com.openauri.app`) e `PUBLIC_ANDROID_CERT_SHA256` (lista separada por vírgula de fingerprints `AA:BB:...`, validada por regex). São valores públicos.
3. `GET /.well-known/assetlinks.json`:
   - com valores válidos, devolve o JSON `delegate_permission/common.handle_all_urls`;
   - sem valores, 404;
   - `content-type: application/json`, cache de 1 h, headers de segurança padrão.

**Testes:** formatos válidos e inválidos de fingerprint; 404 sem config; JSON exato; rótulo de UA com e sem versão; deriva do env.

```
[acceptance]
check: testsPass
criteria: rota e rótulo testados em integração (workerd) e unidade; env e template sem deriva; nenhuma variável secreta nova.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T2.3 · Ligação no layout, UI do cabo e aviso de não validado
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T2.1, T2.2

**W:**
- `D:\git\open-auri\web\src\routes\+layout.svelte`
- `D:\git\open-auri\web\src\lib\components\pages\cabo\CaboPage.svelte` (exceto trechos migrados pela T2.2, já commitados)
- `D:\git\open-auri\web\src\lib\components\cable\AndroidAppCallout.svelte`
- `D:\git\open-auri\web\src\lib\components\cable\AndroidUntestedNotice.svelte`
- `D:\git\open-auri\web\src\lib\components\pages\cabo\UsbDiagnostics.svelte`
- `D:\git\open-auri\web\src\lib\cable\android-links.ts`
- `D:\git\open-auri\web\messages\_staging\T2.3\pt-BR.json`
- `D:\git\open-auri\web\messages\_staging\T2.3\en-US.json`
- `D:\git\open-auri\web\tests\unit\cable\android-callout.svelte.test.ts`
- `D:\git\open-auri\web\tests\unit\cable\android-untested-notice.svelte.test.ts`
- `D:\git\open-auri\web\tests\unit\cable\usb-diagnostics.svelte.test.ts`
- `D:\git\open-auri\web\tests\unit\app\native-mount.test.ts`

**R:**
- `D:\git\open-auri\web\src\lib\cable\native\*`
- `D:\git\open-auri\web\src\lib\cable\android-status.ts`
- `D:\git\open-auri\web\src\lib\app\client.svelte.ts`
- `D:\git\open-auri\web\src\lib\app\context.svelte.ts`
- Anexo G

**Subtarefas:**
1. `+layout.svelte` (`:229`): antes de `context.mount`, rodar `detectNativeCable()`. Se `native`, passar `{ cable: { hid } }` em `mountOptions`; senão, manter o comportamento atual sem mudança nenhuma.
2. CaboPage:
   - estado "App Android vX, USB host OK";
   - `native-outdated` → aviso com link de atualização e modo simulado;
   - `native-write-disabled` → texto do Anexo G.4, link de atualização e modo simulado;
   - `native-no-usb-host` → mensagem RF13.
3. `AndroidUntestedNotice` (Anexo G.1 e G.2), enquanto `ANDROID_WRITE_VALIDATED = false` e só no app:
   - modal acessível no primeiro uso do app: foco preso, `Esc` não fecha sem escolha, botão "Entendi";
   - guarda `oa.androidDisclaimerAck = ANDROID_DISCLAIMER_VERSION`; versão nova reabre;
   - banner fixo no topo da página do cabo;
   - links "Relatar resultado" (`ANDROID_REPORT_URL`) e "Como resgatar" (âncora de `/docs`).
4. `AndroidAppCallout`:
   - aparece só quando `navigator.userAgentData?.platform === 'Android'`, ou o UA bate `/Android/`, e não é app;
   - links em `D:\git\open-auri\web\src\lib\cable\android-links.ts`:
     - `ANDROID_PLAY_URL` = `https://play.google.com/store/apps/details?id=com.openauri.app`, exibido só quando `ANDROID_PLAY_LIVE = true`, que a T4.3 liga quando a ficha estiver pública;
     - `ANDROID_RELEASES_URL` = `https://github.com/marco-jardim/open-auri/releases/latest`;
   - o callout também diz, em uma linha, que a gravação pelo app ainda não foi testada num cabo;
   - fechável, com a escolha guardada em `oa.androidCallout`.
5. `UsbDiagnostics`:
   - visível na camada Engenharia e só no app;
   - mostra o JSON de `diagnostics()` em `<pre>` com "Copiar" e "Relatar resultado" (`ANDROID_REPORT_URL` = `https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml`);
   - nada é enviado ao servidor.
6. Mensagens nas duas línguas via staging, com os textos exatos do Anexo G, sem U+2014.

**Testes:**
- montagem com app, sem app, desatualizado, gravação desligada, versão bloqueada e sem USB host;
- modal: primeiro uso, não reaparece após aceite, reaparece com versão nova, não aparece com `ANDROID_WRITE_VALIDATED = true` nem fora do app;
- banner: idem;
- callout em UA Android, desktop e app, com e sem `ANDROID_PLAY_LIVE`;
- diagnóstico só na Engenharia e só no app;
- copiar.

```
[acceptance]
check: testsPass
criteria: caminho desktop idêntico (testes existentes verdes e nenhum import novo no chunk inicial); aviso, política remota e UI nativa cobertos nos estados listados; textos do Anexo G nas duas línguas.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T2.5 · Documentação em `/docs`: seção "App Android"
`[route class=implement risk=low scope=multi needs=edit,shell]` · `implementer` · Dep: T2.0

**W:**
- `D:\git\open-auri\web\src\lib\content\docs\pt-BR.ts`
- `D:\git\open-auri\web\src\lib\content\docs\en-US.ts`
- `D:\git\open-auri\web\messages\_staging\T2.5\pt-BR.json`
- `D:\git\open-auri\web\messages\_staging\T2.5\en-US.json`
- `D:\git\open-auri\web\tests\unit\content\docs-android.test.ts`

**R:** `D:\git\open-auri\web\src\lib\cable\android-status.ts`, Anexo G

**Conteúdo:**
- o que é o app e onde baixar (Play e GitHub);
- **estado de validação:**
  - texto do Anexo G.1;
  - o que é garantido por teste: os mesmos reports, byte a byte, do site no desktop e da página oficial;
  - o que não é: o caminho físico até o USB;
  - como resgatar com o Neutro;
  - como relatar o resultado;
- requisitos: Android 8 ou mais, USB host/OTG, WebView atual;
- permissão USB; o que muda e o que não muda;
- diagnóstico;
- por que não há iPhone;
- como verificar a assinatura (SHA-256 e fingerprint, iguais na Play e no GitHub);
- privacidade (o app não coleta nada além do site).

**Testes:** seção presente nas duas línguas com as mesmas âncoras (incluindo a de resgate, usada pela T2.3); sem U+2014; links válidos.

```
[acceptance]
check: testsPass
criteria: seção completa nas duas línguas, com o estado de validação, e coberta por teste.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T2.6 · Item obrigatório no checklist do app (serial)
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T2.0, T2.1, T2.3

**W:**
- `D:\git\open-auri\web\src\lib\cable\checklist.ts`
- `D:\git\open-auri\web\src\lib\cable\types.ts`
- `D:\git\open-auri\web\src\lib\components\cable\PreWriteChecklist.svelte`
- `D:\git\open-auri\web\messages\_staging\T2.6\pt-BR.json`
- `D:\git\open-auri\web\messages\_staging\T2.6\en-US.json`
- `D:\git\open-auri\web\tests\unit\cable\checklist-android.test.ts`
- os testes atuais do checklist (caminhos do PF2.6)

**R:** `D:\git\open-auri\web\src\lib\cable\android-status.ts`, `D:\git\open-auri\web\src\lib\cable\native\*`, Anexo G.3

**Subtarefas:**
1. Item `androidUntested` (texto do Anexo G.3), acrescentado pelo mesmo mecanismo dos itens condicionais (`checklist.ts:225-244`) somente quando:
   - o modo do cabo é nativo (app);
   - `ANDROID_WRITE_VALIDATED = false`.
2. Comportamento:
   - obrigatório e sem pré-marcação, zerado a cada abertura do checklist;
   - vale para gravação, resgate (Neutro) e fila de vários cabos (uma confirmação por fila, como os demais itens);
   - combina com os itens de tipos experimentais e YOLO sem substituí-los.
3. No desktop e no modo simulado, a lista de itens fica idêntica à atual.

**Testes:**
- desktop: snapshot exato da lista atual;
- app não validado: item presente e botão "Gravar" desabilitado até marcar;
- app validado: item ausente;
- combinações com experimental, YOLO, resgate e fila;
- reabrir o checklist zera o item.

```
[acceptance]
check: testsPass
criteria: impossível gravar pelo app sem marcar o item enquanto não validado; desktop sem nenhuma mudança na lista; testes existentes do checklist verdes.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### I2.1 · Integração da Fase 2
`[route class=mechanical risk=medium scope=repo needs=edit,shell]` · `general` · VERIFY:required

**W:**
- `D:\git\open-auri\web\messages\pt-BR.json`
- `D:\git\open-auri\web\messages\en-US.json`
- remoção de `D:\git\open-auri\web\messages\_staging\T2.3\`, `D:\git\open-auri\web\messages\_staging\T2.5\` e `D:\git\open-auri\web\messages\_staging\T2.6\`
- arquivos compartilhados pedidos

**Subtarefas:** fundir as mensagens, compilar o Paraglide, `npm run -w web check`, `npm run -w web budgets`.

```
[acceptance]
check: testsPass
check: run command="npm run -w web check" expect=""
criteria: mensagens fundidas sem chave duplicada; svelte-check e orçamentos verdes.
deliverable: mensagens integradas
[/acceptance]
```

#### T2.T · Bateria de testes da Fase 2
`[route class=implement risk=high scope=repo needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\tests\unit\cable\native-parity.test.ts`
- `D:\git\open-auri\web\tests\e2e\fixtures\capacitor-bridge.ts`
- `D:\git\open-auri\web\tests\e2e\android-bridge.spec.ts`

**Casos:**
- **Paridade de bytes:** `writeCurve` e `writeMany` reais de `open-auri/transport`, rodando sobre `NativeHID` com um plugin falso, produzem a mesma sequência `(reportId, bytes)` que `FakeHIDDevice` para os 11 presets e o Neutro do fixture. O timing é o mesmo: 16 ms entre reports e 150 ms de settle, com relógio falso.
- **Ponte real do Capacitor no e2e:** a fixture injeta via `addInitScript` o `native-bridge.js` real de `D:\git\open-auri\node_modules\@capacitor\android\capacitor\src\main\assets\native-bridge.js` e um `androidBridge` falso por `page.exposeBinding`, que responde no protocolo do Capacitor (`window.Capacitor.fromNative`). Assim o `@capacitor/core` real do site conversa com um "nativo" simulado.
- **Fluxos e2e** (projetos `desktop` e `mobile`):
  - primeiro uso: modal do aviso; aceitar; recarregar não reabre;
  - banner na página do cabo;
  - conectar; checklist com o item `androidUntested` obrigatório (botão desabilitado até marcar); gravar; entrada no diário com rótulo do dispositivo;
  - desconectar no report 4 → interrupted sem commit;
  - timeout → interrupted;
  - permissão negada → nada acontece;
  - dois cabos → fila em sequência com uma confirmação do item;
  - YOLO grava um cabo só;
  - app desatualizado → aviso e simulado;
  - política `enabled=false` e versão bloqueada → simulado, com a asserção de que o `androidBridge` falso não recebeu nenhuma chamada de `requestDevice`, `open` ou `sendReport`;
  - sem USB host → mensagem;
  - download no app chama `OpenAuriFiles.save`;
  - callout no UA Android sem ponte;
  - desktop sem ponte → comportamento atual, sem modal, banner nem item.
- **Regressão:** `npm run -w web test:coverage`, depois `npm run -w web test:int:coverage`, depois `npm run -w web test:e2e` (em série); `npm run check:all`; `npm run -w web budgets`.

```
[acceptance]
check: testsPass
check: run command="npm run -w web budgets" expect=""
criteria: paridade de bytes verde para 12 curvas; e2e android-bridge verde em desktop e mobile, incluindo aviso e política remota; nenhuma regressão nas suítes existentes; coberturas >= limites (web lib 85%, servidor 90%, arquivos novos 95%).
deliverable: testes novos
[/acceptance]
```

#### Critérios de aceite F2
1. No app, o site detecta o transporte nativo e grava pelo mesmo `writeCurve`/`writeMany`, com bytes idênticos ao desktop (teste de paridade).
2. Fora do app, nada muda: suítes, orçamentos e e2e existentes verdes, e nenhum import de `@capacitor/core` no chunk inicial.
3. Downloads usam `saveFile` em todos os pontos; nenhum fica de fora (prova pela busca do PF2.3 repetida no fim).
4. UI do cabo, callout, diagnóstico e docs completos nas duas línguas.
5. `assetlinks.json` e rótulo de sessão testados.
6. Aviso de não validado:
   - modal, banner e item do checklist aparecem só no app e só enquanto `ANDROID_WRITE_VALIDATED = false`;
   - é impossível gravar pelo app sem aceitar o item.
7. Com `ANDROID_WRITE_POLICY` desligada ou versão bloqueada, o plugin não recebe nenhuma chamada de I/O.

#### DoD F2
Critérios OK, Q2 PASS, commits por tarefa, push, seção 14.

#### Q2 · QA sênior adversarial da Fase 2 `[tier:heavy]`
`[route class=review risk=high scope=repo needs=shell tier=heavy pin]` · `reviewer`

**Foco:**
- Regressão no desktop (detecção falso-positiva? import no chunk inicial?).
- Uma página no navegador comum consegue se passar por app e mudar de comportamento de forma perigosa?
- Dá para gravar pelo app sem aceitar o aviso (atalho, fila, resgate, YOLO, estado restaurado)?
- A política remota tem brecha? Por exemplo, o SW servindo versão antiga do site offline: a navegação ao vivo nunca vem do cache (`D:\git\open-auri\web\src\service-worker.ts:92-93`), mas confirme o caminho offline e documente o comportamento.
- Identidade de dispositivo e eventos; paridade de bytes real versus asserção fraca.
- O e2e usa mesmo o `native-bridge.js` real?
- Download que escapou da migração.
- i18n e textos do Anexo G exatos; acessibilidade do modal e do banner; CSP intacta.

Os achados viram FX2.k (0.5).

---

### Fase 3 · Distribuição, segurança e documentação

**Subobjetivo:** release reprodutível e assinado no CI, com segredos isolados num Environment protegido; teste em emulador contra a CSP real; licenças nativas; documentação, segurança, LGPD e operação atualizadas; issue template de relato; ferramenta da captura de referência pronta para a F5. Na Trilha P: artes da loja prontas e o QP aprovado.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| PF3 | PF3 | Serial |
| W3.1 | T3.1, T3.2, T3.3, T3.4, T3.5, T3.6, P3 | Paralelo (W disjuntos; `res:gradle`, `res:emulator` e `res:web-build` serializam a execução) |
| W3.2 | I3.1 | Serial |
| W3.3 | T3.T, QP | Serial, nessa ordem (o QP precisa da P3 commitada) |
| QA | Q3 `[tier:heavy]` → FX3.k → Q3 | Regra 0.5 |

#### PF3 · Pre-flight da Fase 3
`[route class=recon risk=low scope=repo needs=shell]` · `runner` + `explorer` + `researcher`
1. Q2 PASS; `git status` limpo; HEAD registrado.
2. `researcher`:
   - versões das actions (`actions/setup-java`, `android-actions/setup-android`, `reactivecircus/android-emulator-runner`, `dorny/paths-filter`, action de release do GitHub);
   - requisitos atuais de Data safety e da política de WebView da Play;
   - versões do Licensee;
   - como os GitHub Environments restringem secrets por branch ou tag e exigem aprovação.
3. `explorer`: arquivos da política de privacidade e termos (`D:\git\open-auri\web\src\lib\content\legal\`) e a constante de versão da política (arquivo:linha); fluxo de aceite de nova versão (`D:\git\open-auri\web\src\routes\conta\politica\+server.ts:9`).
4. `explorer`: estrutura de `D:\git\open-auri\docs\operacao.md`, de `D:\git\open-auri\docs\operacao\runbooks\` e de `D:\git\open-auri\.github\ISSUE_TEMPLATE\` (se existir).
5. Estado da Trilha P registrado (P1 e P5 em andamento ou concluídos).
6. Tabela de locks da W3.1 publicada. T3.1 e T3.2 escrevem workflows diferentes; `ci.yml` fica só com a T3.2; P3 tem `res:web-build` em turno próprio.

**Aprovação:** todos os itens OK.

#### T3.1 · Workflow de release Android em Environment protegido
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\.github\workflows\android-release.yml`
- `D:\git\open-auri\tools\android-artifacts.mjs`
- `D:\git\open-auri\test\tools\android-artifacts.test.mjs`
- `D:\git\open-auri\apps\android\android\app\build.gradle` (só `signingConfigs` e `versionCode`/`versionName`)

**R:** `D:\git\open-auri\web\src\lib\cable\android-status.ts`, Anexo G, seção 4.6

**Subtarefas:**
1. Gatilhos: tag `android-v*` e `workflow_dispatch` com `dry_run`.
2. **Job `build`, sem secrets:**
   - versão: `versionName` de `D:\git\open-auri\apps\android\package.json` e `versionCode` monotônico (maior que o da última release, consultado pela API do GitHub);
   - tag igual à `versionName`;
   - build `bundleRelease` e `assembleRelease` não assinados, com `verifyCapacitorConfig`;
   - upload dos binários como artefato.
3. **Job `sign-and-publish`:**
   - `environment: android-release`, com aprovação obrigatória e só para tags `android-v*` (configuração do Environment é H-ENV);
   - APK assinado com a chave do app (`ANDROID_APP_KEYSTORE_B64`, `ANDROID_APP_KEYSTORE_PASSWORD`, `ANDROID_APP_KEY_ALIAS`, `ANDROID_APP_KEY_PASSWORD`);
   - AAB assinado com a chave de upload (`ANDROID_UPLOAD_KEYSTORE_B64`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD`);
   - keystores decodificados em `$RUNNER_TEMP` e apagados no `always()`;
   - `zipalign` antes da assinatura; esquemas v2 e v3;
   - `apksigner verify --verbose --print-certs`, confirmando que o certificado do APK é o da chave do app.
4. `D:\git\open-auri\tools\android-artifacts.mjs` gera `SHA256SUMS.txt` e `release-manifest.json` com: versão, commit, SHA-256 do APK e do AAB, fingerprint do certificado do APK, link do código-fonte no commit (AGPL), versões do Capacitor e da WebView mínima, e `hardwareValidated` (lido de `android-status.ts`).
5. Notas da release:
   - como verificar;
   - enquanto `hardwareValidated = false`, o texto do Anexo G.5 no topo.
6. GitHub Release com APK, AAB, `SHA256SUMS.txt` e manifesto. O AAB fica anexado para o upload manual na Play (P7).
7. Permissões mínimas: `contents: read` no `build` e `contents: write` só no `sign-and-publish`. Sem secrets em PR de fork; o `dry_run` usa keystores efêmeros e não entra no Environment.

**Testes:** `android-artifacts.test.mjs` cobre hashes, manifesto, versão inconsistente, fingerprint mal formado, aviso presente ou ausente conforme `android-status.ts` e certificado do APK diferente do esperado (falha). O workflow roda em `dry_run` no CI.

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
criteria: workflow completo com duas chaves; secrets só no job em Environment protegido; dry_run reprodutível; manifesto, somas e aviso nas notas corretos.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T3.2 · Testes instrumentados em emulador
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\apps\android\android\app\src\androidTest\java\com\openauri\app\BridgeBootTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\androidTest\java\com\openauri\app\ExternalNavigationTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\androidTest\java\com\openauri\app\DownloadFlowTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\androidTest\java\com\openauri\app\DisclaimerTest.kt`
- `D:\git\open-auri\.github\workflows\ci.yml` (job `android-emulator`, com o mesmo filtro de caminhos da T1.9)

**Subtarefas:**
1. Build `build:android:e2e` contra o preview local (`npm run build:web` e `npm run -w web preview` na porta 4173, acessível em `10.0.2.2`), que usa a mesma CSP de produção (`D:\git\open-auri\web\vite.config.ts:43-65`).
2. `BridgeBootTest`:
   - a página carrega;
   - `Capacitor.isNativePlatform()` é `true`;
   - `isPluginAvailable('OpenAuriUsb')` e `isPluginAvailable('OpenAuriFiles')` são `true`;
   - `getInfo()` responde com `bridgeApi` 1;
   - nenhuma violação de CSP no console.
3. `ExternalNavigationTest`: link para `https://kuba.audio/...` dispara intent externo; navegação interna fica.
4. `DownloadFlowTest`: exportar JSON abre o SAF (via Espresso-Intents) com nome e mime corretos.
5. `DisclaimerTest`: o modal aparece no primeiro uso dentro do app real, aceitar persiste, e o banner aparece em `/cabo`.
6. Job `android-emulator` com `reactivecircus/android-emulator-runner` (API 36, x86_64, KVM).

```
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: testes instrumentados escritos e verdes no CI (link do run anexado); provam injeção do bridge sob a CSP real e o aviso no app real; nenhuma violação de CSP.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T3.3 · Licenças das dependências nativas
`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\tools\android-notices.mjs`
- `D:\git\open-auri\test\tools\android-notices.test.mjs`
- `D:\git\open-auri\web\static\third-party-licenses-android.txt`
- `D:\git\open-auri\web\src\lib\components\chrome\Footer.svelte` (link "Licenças do app Android")
- `D:\git\open-auri\web\messages\_staging\T3.3\pt-BR.json`
- `D:\git\open-auri\web\messages\_staging\T3.3\en-US.json`

**Subtarefas:**
1. Ler `D:\git\open-auri\apps\android\android\app\build\reports\licensee\release\artifacts.json` e gerar o texto com coordenadas Maven, versões, SPDX e URL de licença.
2. Falhar se aparecer SPDX fora da lista permitida.
3. Pedir à I3.1 a seção nova em `D:\git\open-auri\THIRD_PARTY_NOTICES.md` e o script `notices:android`.

**Testes:** JSON de exemplo, SPDX proibido, artefato sem licença, ordenação determinística.

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
criteria: arquivo de licenças gerado a partir do build real; link no rodapé nas duas línguas.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T3.4 · Documentação de desenvolvimento e issue template de relato
`[route class=implement risk=low scope=multi needs=edit]` · `implementer`

**W:**
- `D:\git\open-auri\docs\android.md`
- `D:\git\open-auri\docs\android\captura-usb.md`
- `D:\git\open-auri\README.md`
- `D:\git\open-auri\CONTRIBUTING.md`
- `D:\git\open-auri\.github\ISSUE_TEMPLATE\android-cable-report.yml`

**Conteúdo:**
- **`docs\android.md`:**
  - arquitetura (seção 4) e decisão A;
  - distribuição e assinatura (seção 4.6), com links para os documentos da Trilha P em `D:\git\open-auri\docs\android\`;
  - estado "não validado em hardware", com o texto do Anexo G.1 e a explicação técnica (mesmos reports por teste; caminho físico não validado; política de padding do Anexo D.2);
  - contrato (Anexo B), erros (Anexo C) e framing (Anexo D);
  - setup local no Windows (JDK 21, SDK, `npm run doctor:android`);
  - scripts da seção 5.6;
  - testes por camada;
  - troubleshooting (WebView antiga, OTG, permissão, claim);
  - fora de escopo (0.20), incluindo o motivo de não haver iOS.
- **`docs\android\captura-usb.md`:** runbook da captura de referência no Windows (F5) com USBPcap e Wireshark:
  - filtro por VID/PID;
  - gravar os 11 presets e o Neutro pelo site no Chrome desktop, na ordem do fixture;
  - exportar em JSON com `tshark -T json`;
  - rodar `npm run usb:golden`;
  - rodar a sonda B1 (`D:\git\open-auri\docs\probing.md:44`) e salvar `collections`.
- **`README.md`:** seção "App Android" (Play, GitHub, verificar, requisitos) com o aviso do Anexo G.5.
- **`CONTRIBUTING.md`:** como rodar e testar o Android.
- **`android-cable-report.yml`:** issue form com:
  - campos: aparelho e fabricante, versão do Android, versão do app, versão da WebView, origem da instalação (Play ou GitHub), JSON do Diagnóstico USB (`render: json`), curva gravada, resultado (funcionou / não funcionou / parcial), "o som mudou como esperado?", "o áudio cortou?", observações;
  - label `android-cable-report`;
  - aviso para não colar dados pessoais.

```
[acceptance]
criteria: documentos completos, com caminhos absolutos, sem U+2014, coerentes com o código (nomes de script e arquivos existentes); issue form válido (schema de issue forms do GitHub) com a label.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T3.5 · Segurança, LGPD e operação
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\docs\seguranca.md`
- `D:\git\open-auri\docs\lgpd.md`
- `D:\git\open-auri\docs\operacao.md`
- `D:\git\open-auri\docs\operacao\runbooks\android-release.md`
- arquivos de privacidade e termos e a constante de versão da política (PF3.3) e seus testes

**Conteúdo:**
- **Modelo de ameaças** (`D:\git\open-auri\docs\seguranca.md:18-43`):
  - ator "app Android"; fronteira "página ↔ ponte nativa";
  - ameaças: origem estranha, MITM, reempacotamento, chave roubada, gasto de flash, WebView antiga, gravação pelo app antes da validação, merge ou deploy automático indevido;
  - mitigação de cada uma (RS1 a RS8, 0.12, 0.21, RF14, RF15).
- **LGPD:** o app é um novo canal; nenhuma coleta adicional; dados locais (diário, curvas) na WebView sem backup.
- **Runbook de release** (`android-release.md`):
  - criar as duas chaves offline (comandos `keytool` completos, validade de 25 anos ou mais, RSA 4096);
  - backup em dois locais;
  - exportar a chave do app com a PEPK para o Play App Signing (o passo a passo do Console fica em `D:\git\open-auri\docs\android\play-assinatura.md`, da P6);
  - criar o Environment `android-release` com aprovação obrigatória, restrito a tags `android-v*`, e a regra de proteção dessas tags (H-ENV);
  - secrets no Environment;
  - rotação e chave de upload perdida (pedido de reset de upload key na Play);
  - revogação de release;
  - publicação do fingerprint em `PUBLIC_ANDROID_CERT_SHA256`;
  - **controle da gravação pelo app:** como desligar (`ANDROID_WRITE_POLICY.enabled = false`), como bloquear versões, como encerrar o aviso (`ANDROID_WRITE_VALIDATED = true`) e como reabrir o modal com `ANDROID_DISCLAIMER_VERSION`, sempre por deploy do site, com critério de quando usar cada um;
  - **merge e deploy autônomos (0.21):** condições, sequência staging → produção, smoke e rollback.
- **Privacidade:** se o texto precisar citar o app, aumentar a versão da política pelo fluxo existente (os usuários reaceitam). Se não precisar, registrar o porquê na seção 14. A URL `https://open-auri.com/privacidade` é a usada na Play (P4).

```
[acceptance]
check: testsPass
criteria: documentos completos e rastreáveis ao código; runbook cobre as duas chaves, Environment, controle remoto e 0.21; fluxo de versão da política intacto (testes verdes).
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T3.6 · Ferramenta da captura de referência (prepara a F5)
`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\tools\usb-golden.mjs`
- `D:\git\open-auri\test\tools\usb-golden.test.mjs`
- `D:\git\open-auri\test\fixtures\usb-golden\synthetic-tshark.json`

**Subtarefas:**
1. Ler a saída `tshark -T json` filtrada por VID/PID.
2. Extrair as transferências OUT da interface HID: interrupt OUT (URB_INTERRUPT out) ou SET_REPORT (bmRequestType 0x21, bRequest 0x09).
3. Agrupar por gravação (9 reports e o commit).
4. Gerar `D:\git\open-auri\test\fixtures\usb-wire-golden.json` com `{ capturedOn, os, browser, transfer: 'interrupt'|'control', reports: [hex...], commit: hex, curve: <nome do preset do fixture> }`.
5. Validar contra o fixture `eq0xcb.reference.json`: os dados de cada gravação, sem prefixo nem padding, são iguais aos reports esperados.
6. Modo `--compare <wire-log.json>`: compara o wire log exportado do app com o golden e lista diferenças.

**Testes:** captura sintética com as duas rotas, padding, pacotes de outra interface ignorados, gravação incompleta descartada com aviso, ordem fora do fixture e `--compare` com igualdade e divergência.

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
criteria: ferramenta pronta para a F5, testada com captura sintética das duas rotas e com o modo de comparação.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### I3.1 · Integração da Fase 3
`[route class=mechanical risk=medium scope=repo needs=edit,shell]` · `general` · VERIFY:required

**W:**
- `D:\git\open-auri\package.json` (scripts `notices:android`, `usb:golden` e `play:assets`)
- `D:\git\open-auri\THIRD_PARTY_NOTICES.md`
- `D:\git\open-auri\docs\README.md` (índice: `android.md`, `android\*.md`, runbook)
- `D:\git\open-auri\web\messages\pt-BR.json` e `D:\git\open-auri\web\messages\en-US.json` (fusão de `_staging\T3.3`)

```
[acceptance]
check: testsPass
criteria: pedidos aplicados; mensagens fundidas; índice de docs completo, incluindo os documentos da Trilha P.
deliverable: arquivos compartilhados atualizados
[/acceptance]
```

#### T3.T · Bateria de testes da Fase 3
`[route class=implement risk=medium scope=repo needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\test\tools\android-release-dryrun.test.mjs`, `D:\git\open-auri\test\tools\docs-consistency-android.test.mjs`

**Casos:**
- **Release dry-run local:** `npm run build:android:release` com dois keystores efêmeros em `$env:TEMP`, gerados por um script node que chama `keytool`. Depois `apksigner verify` e `android-artifacts`: hash, fingerprint e aviso nas notas batem; o APK tem o certificado da chave do app e o AAB o da chave de upload.
- **Consistência de docs:**
  - todo script citado em `D:\git\open-auri\docs\android.md` existe em `D:\git\open-auri\package.json`;
  - todo caminho citado existe;
  - o texto do Anexo G aparece igual no README, no `docs\android.md`, na ficha da Play (`D:\git\open-auri\docs\android\play-listing.md`) e nas mensagens do site;
  - nenhum U+2014.
- **Suíte completa:** `npm run test:android`, `npm run test:tools`, `npm test`, as suítes web em série e `npm run check:all`.
- **CI:** jobs `android` e `android-emulator` verdes na branch (link do run); PR só de docs não dispara os jobs Android (link do run).

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: dry-run de release com as duas chaves assinado e verificado; docs e aviso consistentes; CI verde e filtro comprovado com links.
deliverable: testes novos e evidências
[/acceptance]
```

#### Critérios de aceite F3
1. O release roda em `dry_run` no CI e localmente, com APK (chave do app) e AAB (chave de upload) assinados (v2 e v3), verificados, com SHA-256 e manifesto. Secrets reais só no job do Environment `android-release`.
2. Teste em emulador prova o bridge sob a CSP real e o aviso no app real.
3. Licenças nativas geradas, permitidas e publicadas.
4. Documentação de desenvolvimento, segurança, LGPD e operação (incluindo o controle remoto e 0.21) completa e rastreável. O aviso do Anexo G é idêntico em todos os pontos.
5. Issue template de relato publicado. A ferramenta `usb:golden` está pronta.
6. Trilha P: artes da loja (P3) prontas e QP em PASS.

#### DoD F3
Critérios OK, Q3 PASS, commits, push, PR `feat/android-app` → `main` aberto com CI verde (merge na F4, por 0.21), seção 14.

#### Q3 · QA sênior adversarial da Fase 3 `[tier:heavy]`
`[route class=review risk=high scope=repo needs=shell,network tier=heavy pin]` · `reviewer`

**Foco:**
- Vazamento de secrets no workflow (logs, `set -x`, artefatos, PR de fork, job sem Environment).
- Release que dá para assinar com config de staging.
- `versionCode` regressivo.
- Chaves trocadas entre APK e AAB.
- Teste de emulador que passa sem provar a injeção.
- Runbook de keystore que leva a perder a chave; runbook de controle remoto ou de 0.21 que não funciona como descrito.
- AGPL: código-fonte da versão sempre apontado.
- Licenças nativas incompletas.
- Aviso divergente entre canais.

Os achados viram FX3.k (0.5).

---

### Fase 4 · Lançamento sem validação em hardware

**Subobjetivo:** o app publicado e verificável no GitHub e enviado à Play, com o site de produção trazendo a integração, o aviso de não validado e o controle remoto. Pacote registrado na verificação de desenvolvedor. Smoke aprovado num celular sem cabo. Nada nesta fase depende do cabo.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| PF4 | PF4 | Serial (entradas humanas do lançamento) |
| W4.1 | T4.1 | Serial (merge, deploy, release no GitHub) |
| W4.2 | P6 → P7 (humano + agente), T4.2 (humano + agente) | P6 antes de P7; T4.2 em paralelo com P7 |
| W4.3 | T4.3 → T4.T | Serial |
| QA | Q4 `[tier:heavy]` → FX4.k → Q4 | Regra 0.5 |

#### PF4 · Pre-flight da Fase 4
`[route class=recon risk=medium scope=repo needs=shell]` · `runner` + pergunta única ao humano
1. Q3 e QP em PASS; `git status` limpo; HEAD registrado.
2. Pergunta única ao humano, com estas confirmações (se faltar alguma, interrupção 0.1 c):
   - H-KEY: as duas chaves criadas conforme `D:\git\open-auri\docs\operacao\runbooks\android-release.md`, backup feito e fingerprint SHA-256 da chave do app informado;
   - H-ENV: Environment `android-release` criado com aprovação obrigatória e restrito a tags `android-v*`, secrets das duas chaves configurados, regra de proteção das tags ativa;
   - Trilha P: P1 concluído (conta ativa, identidade verificada) e P5 concluído (app criado no Console, ficha e formulários preenchidos);
   - H-SMOKE: um celular Android qualquer, sem cabo, disponível para o smoke (adb opcional).
3. `researcher`: versões (0.14) e prazos da Play (targetSdk; extensão até 2026-11-01; registro de pacotes).
4. `npm run doctor:android`; `npm run build:android:release` em dry-run com keystores efêmeros, verde.
5. `gh pr checks` do PR (tier `fast`): todos verdes no HEAD.

**Aprovação:** todos os itens OK.

#### T4.1 · Merge, deploy e release no GitHub
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` (edições) + tier `fast` (comandos `gh`) · VERIFY:required

**W:**
- `D:\git\open-auri\web\wrangler.template.jsonc` (valores públicos `PUBLIC_ANDROID_APP_ID` e `PUBLIC_ANDROID_CERT_SHA256`)
- `D:\git\open-auri\README.md` (links finais)
- `D:\git\open-auri\apps\android\package.json` (versão 1.0.0, `versionCode` 1)

**Subtarefas:**
1. Configurar o fingerprint de H-KEY. Commit, push, CI verde.
2. Merge (0.21): `gh pr merge <n> --merge`.
3. Deploy (0.21): staging → e2e de staging → produção → smoke de produção, incluindo `https://open-auri.com/.well-known/assetlinks.json` com o fingerprint correto.
4. Tag `android-v1.0.0` em `main`. O release dispara, e o humano aprova o job no Environment `android-release`.
5. Verificar:
   - a release com APK, AAB, `SHA256SUMS.txt`, manifesto (`hardwareValidated: false`) e o aviso do Anexo G.5 nas notas;
   - o certificado do APK é o mesmo do fingerprint publicado;
   - o site de produção mostra o callout no Chrome Android, com a linha do aviso e o link do GitHub.

```
[acceptance]
check: testsPass
criteria: PR mesclado com CI verde; site em produção com smoke verde; GitHub Release android-v1.0.0 publicada com APK, AAB, SHA256SUMS e manifesto; aviso presente nas notas; assetlinks em produção com o fingerprint correto.
deliverable: merge, deploy e release publicados
[/acceptance]
```

#### T4.2 · Smoke de lançamento num celular sem cabo (H-SMOKE)
`[route class=implement risk=medium scope=single needs=edit]` · `implementer` · VERIFY:required · Dep: T4.1

**W:** `D:\git\open-auri\docs\android\smoke-lancamento.md`

**Subtarefas:**
1. O humano instala o APK da release do GitHub e executa o Anexo F.
2. O agente consolida o relatório com as evidências (capturas e saída do `adb`, se houver).
3. Qualquer falha vira FX4.k, com nova release de correção (`android-v1.0.x`) ou deploy do site, conforme a origem, e o smoke é refeito.

```
[acceptance]
criteria: Anexo F 100% aprovado com evidências; App Links verificados (pm get-app-links "verified") ou, sem adb, abertura de /c/<id> direto no app comprovada.
deliverable: docs\android\smoke-lancamento.md
[/acceptance]
```

#### T4.3 · Link da Play no site
`[route class=implement risk=low scope=single needs=edit,shell]` · `implementer` · VERIFY:required · Dep: P7

**W:** `D:\git\open-auri\web\src\lib\cable\android-links.ts`, `D:\git\open-auri\README.md`

**Subtarefas:**
1. Quando a ficha estiver pública na Play (P7 aprovado em produção), `ANDROID_PLAY_LIVE = true`, README com o link da Play, commit, PR, merge e deploy (0.21).
2. Se a revisão da Play ainda estiver pendente no fim da F4, a tarefa fica registrada na seção 14 com o estado da revisão. Ela é concluída quando a Play aprovar, sem bloquear o QG. É o único item que pode fechar depois do QG, porque depende só da revisão do Google.

```
[acceptance]
check: testsPass
criteria: callout e README apontam para a Play somente quando a ficha está pública.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T4.T · Bateria final do lançamento
`[route class=implement risk=medium scope=repo needs=edit,shell]` · `implementer` · VERIFY:required

**Casos:**
- regressão completa de todas as camadas, em série;
- e2e android-bridge;
- teste em emulador no CI;
- `npm run check:sensitive`;
- busca por `TODO` sem ID de H;
- busca por U+2014 nos arquivos tocados;
- smoke de produção no desktop (páginas principais, gravação simulada) para provar 0.12.8.

```
[acceptance]
check: testsPass
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: tudo verde; nenhum TODO sem H; nenhum U+2014; desktop em produção sem regressão.
deliverable: evidências na seção 14
[/acceptance]
```

#### Critérios de aceite F4
1. Release `android-v1.0.0` publicada e verificável no GitHub (SHA-256, fingerprint, manifesto), com o aviso nas notas.
2. Site em produção com a integração, o aviso (modal, banner, item do checklist), o controle remoto e o `assetlinks.json`, por merge e deploy autônomos com CI verde.
3. Pacote `com.openauri.app` registrado na verificação de desenvolvedor com o SHA-256 da chave do app (P6).
4. AAB enviado à Play: em revisão de produção, ou em teste fechado em andamento se a conta exigir (P7).
5. Smoke do Anexo F aprovado; App Links verificados.

#### DoD F4
Critérios OK, Q4 PASS, commits, push, seção 14 (com o estado da revisão da Play).

#### Q4 · QA sênior adversarial da Fase 4 `[tier:heavy]`
`[route class=review risk=high scope=repo needs=shell,network tier=heavy pin]` · `reviewer`

**Foco:**
- Release reprodutível; o fingerprint publicado bate com o APK e com o registrado na Play.
- `assetlinks.json` correto.
- Merge e deploy seguiram 0.21 à risca (CI verde no HEAD, ordem staging → produção, smoke).
- O aviso está em todos os pontos: modal, banner, checklist, callout, notas, README, `/docs`, ficha da Play.
- O runbook de controle remoto funciona: simulação em staging com `enabled=false` e retorno.
- Desktop intacto em produção.
- Smoke com evidência real e não só declaração.

Os achados viram FX4.k (0.5).

---

### Trilha P · Google Play (paralela, de PF1 a F4)

**Objetivo:** o app na Play com a mesma assinatura do GitHub, pacote registrado na verificação de desenvolvedor, ficha e formulários coerentes com o código e o aviso de não validado. O orquestrador prepara tudo o que não exige o Console e guia o mantenedor passo a passo (Anexo H). Senhas e documentos pessoais nunca passam pelo chat.

| Passo | Quem | Quando | Depende de |
|---|---|---|---|
| P0 · Requisitos atuais da Play | agente | PF1 | - |
| P1 · Conta: estado, identidade, segurança | mantenedor, guiado | a partir do PF1 | P0 |
| P2 · Ficha da loja (textos) | agente | W1.2 | P0 |
| P4 · Conteúdo do app (formulários) | agente | W1.2 | P0 |
| P5 · Criar o app no Console e preencher | mantenedor, guiado | depois de P1, P2 e P4 | P1, P2, P4 |
| P3 · Artes da loja | agente | W3.1 | T1.8, F2 concluída |
| QP · QA adversarial da trilha `[tier:heavy]` | agente | W3.3 | P2, P3, P4 |
| P6 · Assinatura e registro do pacote | mantenedor, guiado | W4.2 | H-KEY, P5, QP |
| P7 · Upload e publicação | mantenedor, guiado | W4.2 | P6, T4.1 |

#### P0 · Requisitos atuais da Play
`[route class=recon risk=medium scope=multi needs=web]` · `researcher`, depois `general` para gravar o documento

**W (general):** `D:\git\open-auri\docs\android\play-requisitos.md`

**Perguntas (cada resposta com URL e data):**
1. Conta antiga:
   - como saber se foi fechada por inatividade e o que fazer para mantê-la;
   - se contas pessoais criadas antes de 2023-11-13 estão isentas do teste fechado de 12 testadores por 14 dias.
2. Verificação de identidade no Play Console: documentos, prazo, o que aparece publicamente na ficha para conta pessoal (nome, país, e-mail, endereço) e se há como não expor o endereço num app gratuito sem compras.
3. Verificação de desenvolvedor do Android:
   - países e datas em vigor (Brasil está incluído desde 2026-09-30?);
   - como registrar pacote e SHA-256 no Play Console;
   - se o registro cobre APKs distribuídos fora da Play com a mesma chave.
4. Play App Signing:
   - como usar a chave própria (PEPK), até quando dá para trocar o padrão;
   - se a chave de upload pode ser a mesma ou deve ser separada.
5. Ficha da loja: limites (título, descrição curta, descrição completa) e especificações de ícone, feature graphic e capturas de telefone.
6. Seções de "Conteúdo do app": Data safety, classificação etária (questionário IARC), público-alvo, anúncios, acesso ao app, ID de publicidade, recursos financeiros, saúde, apps de governo, notícias.
7. Política para apps que exibem um site (WebView) e para apps que dependem de hardware externo: o que o revisor precisa ver.
8. Prazos típicos de revisão de um app novo.
9. Requisito de targetSdk em vigor e prazos de extensão.

```
[acceptance]
criteria: as 9 perguntas respondidas com URL e data ou marcadas "não confirmado" com as URLs tentadas; documento gravado em docs\android\play-requisitos.md sem U+2014.
deliverable: docs\android\play-requisitos.md
[/acceptance]
```

#### P1 · Conta: estado, identidade e segurança (mantenedor, guiado)
`[route class=other risk=medium scope=single needs=edit]` · `general` (prepara o guia e registra o resultado)

**W:** `D:\git\open-auri\docs\android\play-conta.md`

**Subtarefas:**
1. O agente escreve o guia a partir do P0 e do Anexo H.1 e manda a mensagem ao mantenedor (5.9).
2. O mantenedor:
   - entra no Play Console com a conta antiga;
   - verifica se há aviso de fechamento;
   - confere e-mail e telefone em "Detalhes da conta";
   - ativa a verificação em duas etapas da conta Google;
   - conclui a verificação de identidade;
   - confere o nome público de desenvolvedor.
3. O mantenedor informa: estado da conta (ativa ou fechada), data de criação da conta, tipo (pessoal ou organização), identidade verificada (sim ou não) e se recebeu aviso de inatividade.
4. **Desvio:** se a conta estiver fechada ou não puder ser recuperada:
   - abrir conta nova, com taxa de registro e verificação;
   - a P7 passa a incluir o teste fechado (12 testadores por 14 dias, se o P0 confirmar);
   - o agente prepara o texto de convite e um formulário de inscrição de testadores para a comunidade.

```
[acceptance]
criteria: estado da conta registrado em docs\android\play-conta.md sem dados sensíveis (sem documento, endereço completo nem senha); desvio aplicado quando necessário.
deliverable: docs\android\play-conta.md
[/acceptance]
```

#### P2 · Ficha da loja
`[route class=implement risk=low scope=multi needs=edit,shell]` · `implementer`

**W:**
- `D:\git\open-auri\docs\android\play-listing.md`
- `D:\git\open-auri\test\tools\play-listing.test.mjs`

**R:** `D:\git\open-auri\docs\android\play-requisitos.md`, Anexo G, seção 3.1

**Conteúdo (pt-BR e en-US):**
- título (`open-auri`, dentro do limite);
- descrição curta;
- descrição completa:
  - começa com o aviso do Anexo G.5;
  - diz o que o app faz e que é código aberto (AGPL-3.0, link do repositório);
  - diz que não é oficial nem endossado pela Kuba (aviso legal do `D:\git\open-auri\README.md:130-132`);
  - lista os requisitos (OTG, Android 8 ou mais);
  - diz como relatar o resultado;
- categoria (Música e áudio); tags;
- e-mail de contato e site (`https://open-auri.com`);
- URL da política de privacidade (`https://open-auri.com/privacidade`).

**Testes (`play-listing.test.mjs`):** limites de caracteres do P0 por campo e por idioma; aviso G.5 presente no início da descrição completa; aviso legal presente; nenhum U+2014; nenhum termo de marca proibido (`D:\git\open-auri\CONTRIBUTING.md:59-62`).

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
criteria: ficha completa nas duas línguas, dentro dos limites, com aviso, aviso legal e links.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### P4 · Conteúdo do app (respostas dos formulários)
`[route class=implement risk=high scope=multi needs=edit]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\docs\android\data-safety.md`
- `D:\git\open-auri\docs\android\play-conteudo.md`

**R:**
- `D:\git\open-auri\docs\android\play-requisitos.md`
- `D:\git\open-auri\docs\lgpd.md`
- `D:\git\open-auri\web\src\lib\server\analytics.ts`
- `D:\git\open-auri\web\src\lib\server\auth.ts`
- `D:\git\open-auri\web\src\lib\server\account\export.ts`
- `D:\git\open-auri\web\src\routes\api\v1\s6\batches\+server.ts`
- `D:\git\open-auri\web\src\lib\server\security\turnstile.ts`

**Conteúdo:**
- **Data safety:** respostas campo a campo derivadas do site real, com arquivo:linha de cada fonte:
  - conta: e-mail, apelido;
  - analytics sem cookie (Simple Analytics);
  - S6 anônimo;
  - Turnstile (Cloudflare);
  - criptografia em trânsito;
  - exclusão pela conta (`/conta`);
  - nada vendido nem compartilhado para publicidade.
- **Classificação etária:** respostas do questionário IARC.
- **Público-alvo:** maiores de 13 anos, sem foco em crianças.
- **Declarações:** anúncios: não; ID de publicidade: não usado.
- **Acesso ao app**, para o revisor:
  - o app funciona sem login;
  - a gravação exige o cabo Auri (USB-C/OTG);
  - sem o cabo, todo o resto pode ser avaliado;
  - o aviso de não validado é intencional;
  - link do vídeo opcional de demonstração.
- **Declarações que não se aplicam,** com o motivo: financeiro, saúde, governo, notícias.

```
[acceptance]
criteria: cada resposta de Data safety rastreável ao código com arquivo:linha; nenhuma resposta contradiz docs\lgpd.md ou a política de privacidade; demais formulários completos.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### P5 · Criar o app no Console e preencher (mantenedor, guiado)
`[route class=other risk=medium scope=single needs=edit]` · `general` (registra o andamento)

**W:** `D:\git\open-auri\docs\android\play-console-passos.md`

**Subtarefas:**
1. O agente manda a mensagem (5.9) com o Anexo H.2, apontando para `play-listing.md`, `data-safety.md` e `play-conteudo.md`.
2. O mantenedor:
   - cria o app (`open-auri`, idioma padrão pt-BR, app, gratuito, declarações de política);
   - preenche ficha, Data safety, classificação etária, público-alvo, anúncios e acesso ao app, copiando dos documentos;
   - salva como rascunho as partes que dependem das artes (P3).
3. O mantenedor informa o que ficou pendente ou o que o Console recusou. O agente corrige os textos (FXP.k) e devolve.

```
[acceptance]
criteria: app criado; seções de conteúdo concluídas no Console (confirmação do mantenedor); recusas do Console tratadas.
deliverable: docs\android\play-console-passos.md
[/acceptance]
```

#### P3 · Artes da loja
`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T1.8, F2 concluída

**W:**
- `D:\git\open-auri\tools\play-assets.mjs`
- `D:\git\open-auri\test\tools\play-assets.test.mjs`
- `D:\git\open-auri\design\play\feature-graphic.svg`
- `D:\git\open-auri\docs\android\play-assets\` (PNGs gerados)
- `D:\git\open-auri\web\tests\e2e\play-screenshots.spec.ts`

**R:** `D:\git\open-auri\tools\android-icons.mjs` (função exportada), o SVG do PF1.7, `D:\git\open-auri\docs\android\play-requisitos.md`

**Subtarefas:**
1. Ícone da loja 512 × 512 com a função da T1.8.
2. Feature graphic 1024 × 500 a partir de `feature-graphic.svg` (identidade visual do site, sem marcas de terceiros, sem texto do aviso), renderizado com `@cf-wasm/resvg`, sem transparência se o P0 exigir.
3. Capturas de telefone com Playwright no viewport do Pixel 7, contra o preview local (lock `res:web-build`):
   - páginas `/`, `/cabo` (com o banner do aviso), `/comparar`, `/soe-como-x`, `/comunidade` e `/teste-cego`;
   - em pt-BR e en-US;
   - nas dimensões e proporção do P0.
4. Script `play:assets` vai para a I3.1.

**Testes (`play-assets.test.mjs`):** dimensões e formato de cada arquivo conforme o P0; saída determinística do ícone e da feature graphic; quantidade mínima de capturas por idioma.

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
criteria: ícone, feature graphic e capturas nas especificações do P0, nas duas línguas.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### QP · QA sênior adversarial da Trilha P `[tier:heavy]`
`[route class=review risk=high scope=multi needs=shell,web tier=heavy pin]` · `reviewer`

**Foco:**
- Data safety contra o código real: algum dado coletado ficou de fora?
- Ficha: algo enganoso ou proibido pela política (promessa de funcionamento contrariando o aviso, marca de terceiro, palavras-chave abusivas)?
- Aviso G.5 igual ao do site.
- Artes dentro das especificações.
- Acesso ao app suficiente para o revisor.
- Risco de recusa por "wrapper de site" e se a ficha deixa clara a função nativa.
- Nada pessoal do mantenedor exposto nos documentos do repositório.

Os achados viram FXP.k (0.5).

#### P6 · Assinatura e registro do pacote (mantenedor, guiado)
`[route class=other risk=high scope=single needs=edit]` · `general` (prepara o guia e registra o resultado) · Dep: H-KEY, P5, QP

**W:** `D:\git\open-auri\docs\android\play-assinatura.md`

**Subtarefas:**
1. O agente escreve o passo a passo (Anexo H.3) e manda a mensagem.
2. O mantenedor:
   - abre Play App Signing e escolhe usar a própria chave;
   - baixa a PEPK;
   - exporta a chave do app criptografada e envia;
   - registra o certificado da chave de upload;
   - na página de verificação de desenvolvedor, confirma o registro de `com.openauri.app` com o SHA-256 da chave do app;
   - informa os fingerprints que o Console mostra.
3. O agente confere que o fingerprint da chave do app no Console é igual ao `PUBLIC_ANDROID_CERT_SHA256` e ao do APK do GitHub. Divergência = interrupção (0.1 b).
4. **Desvio** (se o P0 ou o Console não permitirem a chave própria): aplicar a alternativa da seção 4.6, registrar as duas chaves e atualizar `docs\android.md` e `assetlinks.json` com os dois fingerprints.

```
[acceptance]
criteria: Play App Signing configurado com a chave do app; pacote registrado com o SHA-256 correto; fingerprints conferidos e registrados no documento.
deliverable: docs\android\play-assinatura.md
[/acceptance]
```

#### P7 · Upload e publicação (mantenedor, guiado)
`[route class=other risk=medium scope=single needs=edit]` · `general` · Dep: P6, T4.1

**W:** `D:\git\open-auri\docs\android\play-publicacao.md`

**Subtarefas:**
1. O agente manda a mensagem com o Anexo H.4 e o link do AAB anexado à release `android-v1.0.0`.
2. O mantenedor:
   - envia o AAB para o teste interno;
   - instala pela Play no próprio celular;
   - confirma que a assinatura é a mesma do APK do GitHub (dá para instalar por cima sem desinstalar).
3. **Conta isenta de teste fechado (P1):** o mantenedor promove para produção, com o texto da versão (aviso G.5), e envia para revisão.
4. **Conta nova:** o teste fechado começa com os testadores recrutados. O agente acompanha os 14 dias e prepara o pedido de acesso à produção.
5. Se a revisão recusar, o mantenedor cola o motivo e o agente prepara a correção (FXP.k ou FX4.k) e a resposta ao recurso.
6. Quando a ficha estiver pública, liberar a T4.3.

```
[acceptance]
criteria: AAB no teste interno com instalação confirmada; app enviado à revisão de produção ou teste fechado em andamento; estado registrado.
deliverable: docs\android\play-publicacao.md
[/acceptance]
```

---

### QG · QA global do lançamento
Ver a seção 10. Depois do QG PASS vem a parada planejada (0.1).

---

### Fase 5 · Validação em hardware (pós-lançamento)

**Subobjetivo:** quando o cabo chegar, provar no cabo real, em pelo menos dois aparelhos de fabricantes diferentes, que o app emite no fio os mesmos bytes que o desktop e grava corretamente sem quebrar o áudio. Depois disso, encerrar o aviso. Se a validação falhar, corrigir e relançar ou desligar a gravação pelo app, sem deixar usuários expostos.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| PF5 | PF5 | Serial (entradas humanas) |
| W5.1 | T5.1 (humano + agente) | Serial |
| W5.2 | T5.2 | Serial |
| W5.3 | T5.3 (humano + agente) | Serial |
| W5.4 | T5.4 → T5.T | Serial |
| QA | Q5 `[tier:heavy]` → FX5.k → Q5, depois QGH | Regra 0.5 |

#### PF5 · Pre-flight da Fase 5
`[route class=recon risk=medium scope=repo needs=shell,web]` · `runner` + `researcher` + pergunta única ao humano
1. QG PASS registrado; `git status` limpo; branch nova `feat/android-hw-validation` a partir de `main`; HEAD registrado.
2. Pergunta única ao humano: H-HW (cabo em mãos; dois ou mais Android, com Android 8 ou mais e OTG, de fabricantes diferentes; PC Windows com Chrome/Edge, USBPcap e Wireshark).
3. `researcher`: versões (0.14); leitura dos issues públicos com label `android-cable-report` em `https://github.com/marco-jardim/open-auri/issues`, consolidada como insumo (aparelhos, resultados, diagnósticos).
4. Deploy de staging da branch (0.21, tier `fast`); `npm run doctor:android`; `npm run build:android:staging` com `STAGING_ORIGIN` e wire log de debug.

**Aprovação:** todos os itens OK.

#### T5.1 · Captura de referência no desktop (H-CAPTURE)
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\test\fixtures\usb-wire-golden.json`
- `D:\git\open-auri\docs\hardware.md`
- `D:\git\open-auri\docs\probing.md`
- `D:\git\open-auri\docs\protocol-0xcb.md` (seção "No fio")

**Subtarefas:**
1. O humano executa `D:\git\open-auri\docs\android\captura-usb.md` e entrega o JSON do tshark e a saída da sonda B1.
2. O agente roda `npm run usb:golden`.
3. Documentar em `hardware.md` os descritores reais (interfaces, endpoints, report descriptor, tamanho do output report), fechando a pendência `D:\git\open-auri\docs\hardware.md:114-119`.
4. Registrar o resultado da B1 em `probing.md`.
5. Documentar em `protocol-0xcb.md` a rota de transferência e o padding observados.

```
[acceptance]
check: run command="npm run test:tools" expect="pass"
criteria: golden com 12 gravações válidas contra o fixture; descritores documentados com a fonte (captura e data).
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T5.2 · Paridade do framing com a captura `[tier:heavy]`
`[route class=implement risk=high scope=multi needs=edit,shell tier=heavy pin]` · `implementer` · VERIFY:required · Dep: T5.1

**W:**
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\WireGoldenParityTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\HidFraming.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri\usb\HidFramingTest.kt`
- `D:\git\open-auri\apps\android\android\app\src\test\resources\cb5100-report-descriptor.bin`

**Subtarefas:**
1. Salvar o report descriptor real.
2. O teste roda o plugin com `FakeUsbBackend` configurado com o descritor real e confere que, para as 12 curvas, a rota de transferência e os buffers são iguais byte a byte ao golden.
3. Se a política `WINDOWS_MAX_OUTPUT` ou a escolha de rota divergirem, corrigir o `HidFraming` para bater, com teste. A correção exige nova versão do app (T5.4).
4. Atualizar o Anexo D deste plano e `D:\git\open-auri\docs\android.md`.

```
[acceptance]
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: paridade 12/12 com o golden do desktop; política final documentada; qualquer mudança no framing coberta por teste.
deliverable: arquivos do conjunto W
[/acceptance]
```

#### T5.3 · Validação no aparelho (H-DEVICE)
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T5.2

**W:** `D:\git\open-auri\docs\android\validacao-hardware.md`

**Subtarefas:**
1. Gerar o APK de debug de staging com o wire log ligado (com a correção da T5.2, se houve).
2. O humano executa o Anexo E em cada aparelho e devolve: o wire log exportado (pelo "Diagnóstico USB", em "Copiar"), as respostas do checklist e os resultados de áudio.
3. O agente compara os wire logs com o golden (`npm run usb:golden -- --compare <arquivo>`) e consolida o relatório, incluindo os relatos públicos do PF5.3.
4. Qualquer divergência vira FX5.k imediato e a validação é refeita.
5. O humano assina o relatório (H-SIGNOFF).

```
[acceptance]
criteria: Anexo E 100% aprovado em >= 2 fabricantes; wire logs iguais ao golden; áudio contínuo antes, durante e depois da gravação ou, se não for, o efeito é documentado e aceito pelo humano; relatório assinado.
deliverable: docs\android\validacao-hardware.md
[/acceptance]
```

#### T5.4 · Encerrar o aviso ou agir sobre a falha
`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` (edições) + tier `fast` (merge e deploy, 0.21) · VERIFY:required · Dep: T5.3

**W:**
- `D:\git\open-auri\web\src\lib\cable\android-status.ts`
- `D:\git\open-auri\web\tests\unit\cable\android-status.test.ts`
- `D:\git\open-auri\README.md`
- `D:\git\open-auri\docs\android.md`
- `D:\git\open-auri\web\src\lib\content\docs\pt-BR.ts`
- `D:\git\open-auri\web\src\lib\content\docs\en-US.ts`
- `D:\git\open-auri\docs\android\play-listing.md`
- `D:\git\open-auri\apps\android\package.json` (só se houve mudança nativa)

**Subtarefas:**
- **Caminho aprovado (T5.3 assinada):**
  1. `ANDROID_WRITE_VALIDATED = true`.
  2. Trocar o estado de validação nos docs, no README e na ficha da Play pelo texto do Anexo G.6, com a data e o relatório.
  3. Os testes de aviso e checklist passam a provar a ausência do aviso.
  4. Se houve mudança no framing: nova versão do app (`android-v1.1.0`), e `blockedAppVersions` passa a bloquear as versões anteriores com framing errado.
  5. PR, merge e deploy (0.21); release (H-ENV aprova); o mantenedor atualiza a ficha e envia o AAB novo na Play, guiado (H-PLAY-UPDATE).
- **Caminho reprovado:**
  1. Manter `ANDROID_WRITE_VALIDATED = false`.
  2. Se houver risco ao cabo, `ANDROID_WRITE_POLICY.enabled = false` com deploy imediato (0.21), antes de qualquer outra ação.
  3. Abrir issue com a evidência.
  4. Corrigir via 0.16 e repetir T5.2 e T5.3.

```
[acceptance]
check: testsPass
criteria: estado de validação coerente em código, docs, README, ficha da Play e notas; caminho escolhido executado por inteiro; usuários de versões com framing errado bloqueados se aplicável.
deliverable: arquivos do conjunto W e release/deploy correspondentes
[/acceptance]
```

#### T5.T · Bateria final pós-hardware
`[route class=implement risk=medium scope=repo needs=edit,shell]` · `implementer` · VERIFY:required

**Casos:**
- `WireGoldenParityTest`;
- regressão completa em série;
- e2e android-bridge com o estado novo;
- teste em emulador;
- `check:sensitive`;
- busca por TODO sem H e por U+2014.

```
[acceptance]
check: testsPass
check: run command="npm run test:android" expect="BUILD SUCCESSFUL"
criteria: tudo verde com o estado de validação final.
deliverable: evidências na seção 14
[/acceptance]
```

#### Critérios de aceite F5
1. Golden do desktop e descritores reais documentados em `D:\git\open-auri\docs\hardware.md`.
2. Paridade 12/12 em teste e nos aparelhos.
3. Anexo E aprovado em pelo menos dois fabricantes e assinado.
4. Aviso encerrado em todos os canais, ou mantido com a falha tratada (política remota, issue, correção).

#### DoD F5
Critérios OK, Q5 PASS, QGH PASS, commits, push, seção 14.

#### Q5 · QA sênior adversarial da Fase 5 `[tier:heavy]`
`[route class=review risk=high scope=repo needs=shell,network tier=heavy pin]` · `reviewer`

**Foco:**
- O golden prova o que diz? Captura completa, sem gravação misturada.
- A paridade cobre a rota real?
- Relatório de hardware com evidência real ou só declaração.
- Remoção do aviso coerente em todos os canais, inclusive na Play.
- Versões antigas bloqueadas quando o framing mudou.

Os achados viram FX5.k (0.5).

---

### Fase H · Entradas humanas
Ver a seção 13. O orquestrador agrupa as perguntas no PF1, no PF4 e no PF5. Os passos da Trilha P são pedidos sem parar a implementação (0.22).

---

## 8. Critérios de aceite globais

### 8.1 Lançamento (F1 a F4 + Trilha P + QG)
1. O app Android (Capacitor 8.x atual) abre `https://open-auri.com` com todas as páginas funcionando (RF1). A ponte nativa só existe na origem fixada.
2. A gravação no Android usa o mesmo gate, checklist e transporte do núcleo, sem diff em `D:\git\open-auri\src\transport\`. Os reports são idênticos byte a byte ao fixture oficial (paridade JS e Kotlin), e o framing segue o Anexo D. A validação física é da F5.
3. O FrameGuard recusa sequências malformadas e impõe 2000 ms entre commits. Interrupção nunca envia commit.
4. Aviso de não validado (RF14) presente e idêntico em todos os canais, inclusive na ficha da Play; gravação pelo app impossível sem o aceite. Controle remoto (RF15) comprovado. Relato (RF16) disponível.
5. Todos os downloads funcionam no app (RF5). Áudio próprio e links externos funcionam (RF6, RF7).
6. Desktop e navegadores móveis sem regressão: suítes, orçamentos e e2e verdes. O Chrome Android mostra o aviso do app (RF9).
7. CI com `android` e `android-emulator` verdes e filtrados por caminho. O release produz APK e AAB assinados e verificados, com SHA-256, fingerprint e manifesto, com secrets só no Environment `android-release`.
8. Distribuição (RF17): mesma assinatura na Play e no GitHub; pacote registrado na verificação de desenvolvedor; app enviado à revisão de produção na Play, ou teste fechado em andamento.
9. Segurança: RS1 a RS8 e 0.12 provados; `check:sensitive` verde; verificação de dependências ativa; merge e deploy feitos só nas condições de 0.21.
10. Documentação completa e consistente (desenvolvimento, segurança, LGPD, operação, Play, `/docs`). iOS explicitamente fora de escopo com justificativa.

### 8.2 Pós-hardware (F5 + QGH)
1. Bytes no fio iguais ao golden do desktop nas 12 curvas e em pelo menos dois fabricantes.
2. Descritores reais documentados; política de padding confirmada ou corrigida.
3. Estado de validação final coerente em código e em todos os canais, inclusive na Play.

## 9. Definition of Done global

### 9.1 Lançamento
1. F1 a F4 com DoD e QA PASS; QP PASS; QG PASS, com todos os achados corrigidos (0.5).
2. Coberturas:
   - Kotlin: 90% ou mais em `com.openauri.usb` e `com.openauri.files`;
   - arquivos web novos: 95% ou mais;
   - `D:\git\open-auri\web\src\lib`: 85% ou mais;
   - servidor: 90% ou mais;
   - núcleo: 95% ou mais.
3. e2e desktop, mobile e android-bridge verdes; teste em emulador verde no CI.
4. PR mesclado e site em produção pelas regras de 0.21.
5. GitHub Release `android-v1.0.0` publicada; smoke assinado (Anexo F).
6. Play: pacote registrado, Play App Signing com a chave do app, app enviado à revisão de produção (ou teste fechado iniciado). A aprovação final do Google e a T4.3 ficam registradas na seção 14 quando ocorrerem.
7. Commits pequenos, um por tarefa, sem trailers proibidos; branch enviada.
8. Seção 14 completa; nenhum `TODO` sem ID de H.

### 9.2 Pós-hardware
1. F5 com DoD, Q5 PASS e QGH PASS.
2. Relatório de hardware assinado (H-SIGNOFF).
3. Estado de validação publicado (T5.4) no site, no GitHub e na Play e, se houve mudança nativa, nova release com versões antigas bloqueadas.

## 10. QA global

### 10.1 QG · Lançamento `[tier:heavy]`
`[route class=review risk=high scope=repo needs=shell,network tier=heavy pin]` · `reviewer`

**Escopo:** todo o intervalo do lançamento em `main` (do HEAD do PF1 ao merge), a release publicada e os documentos da Trilha P. Ataques:
- outra origem chamando a ponte;
- gasto de flash pela ponte;
- commit sem os 9 reports válidos;
- gravar pelo app sem aceitar o aviso;
- política remota contornável;
- download para fora do SAF;
- vazamento de cookie;
- segredo em log, artefato ou job fora do Environment;
- reempacotamento sem detecção; assinatura divergente entre Play e GitHub;
- merge ou deploy feito fora das condições de 0.21;
- regressão no desktop;
- deriva de constantes JS ↔ Kotlin;
- divergência entre docs e código; Data safety incoerente;
- aviso divergente entre canais;
- falhas de i18n e acessibilidade.

Rodar todas as suítes. Os achados viram FXG.k, e o QG repete conforme 0.5.

### 10.2 QGH · Pós-hardware `[tier:heavy]`
`[route class=review risk=high scope=repo needs=shell,network tier=heavy pin]` · `reviewer`

**Escopo:** o diff da F5 e a release ou deploy que dela resultaram. Ataques:
- evidência de hardware insuficiente;
- aviso removido sem prova;
- versão antiga com framing errado ainda gravando;
- docs, README ou ficha da Play incoerentes.

Os achados viram FXGH.k (0.5).

## 11. Estratégia de testes

| Camada | Ferramenta | Onde | Fase |
|---|---|---|---|
| Kotlin unidade | JUnit4 + Robolectric + Kover | `D:\git\open-auri\apps\android\android\app\src\test\` | F1, F5 |
| Contrato da ponte | JSON Schema (`networknt` / `ajv`) | `D:\git\open-auri\schemas\android-usb-bridge-1.schema.json` | F1, F2 |
| Deriva de constantes | teste Kotlin lendo os `.mjs` | `ProtocolFixtureTest.kt` | F1 |
| Ferramentas | `node --test` | `D:\git\open-auri\test\tools\` | F1, F3, Trilha P |
| Web unidade/componente | Vitest (node + Chromium) | `D:\git\open-auri\web\tests\unit\` | F2 |
| Paridade de bytes JS | Vitest + transporte real | `native-parity.test.ts` | F2 |
| Integração servidor | Vitest em workerd | `D:\git\open-auri\web\tests\integration\android\` | F2 |
| e2e com ponte real | Playwright + `native-bridge.js` real | `android-bridge.spec.ts` | F2 |
| Instrumentado | AndroidX Test em emulador | `app\src\androidTest\` | F3 |
| Release | dry-run com duas chaves + `apksigner verify` | CI e local | F3 |
| Ficha e artes da Play | `node --test` (limites, aviso, dimensões) + Playwright (capturas) | `play-listing.test.mjs`, `play-assets.test.mjs`, `play-screenshots.spec.ts` | Trilha P |
| Deploy | e2e de staging + smoke de produção | `D:\git\open-auri\web\playwright.config.ts:78-88` | F4, F5 |
| Smoke sem cabo | Anexo F | humano + agente | F4 |
| Hardware | captura USBPcap + wire log + Anexo E | humano + agente | F5 |

## 12. Riscos

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| **Lançar sem validação:** o cabo ignora a gravação ou grava algo errado pelo app | Média | Alto | Aviso explícito com aceite em cada gravação (RF14); reports idênticos ao fixture por teste; FrameGuard com CRC antes do commit; Neutro a um clique e resgate pelo desktop; política remota para desligar ou bloquear versões (RF15); relatos pelo issue template (RF16); F5 |
| Conta antiga da Play fechada por inatividade | Média | Médio (atrasa a Play) | P1 verifica primeiro; desvio para conta nova com teste fechado e recrutamento de testadores na comunidade; GitHub Releases não depende da Play |
| Verificação de desenvolvedor do Android bloqueia a instalação do APK do GitHub no Brasil | Média | Alto | P0 confirma países e datas; P6 registra pacote e chave antes da release; mesma chave na Play e no GitHub |
| Assinatura diferente entre Play e GitHub | Baixa | Médio | Chave própria no Play App Signing antes da primeira release em produção (4.6); verificação de fingerprint na P6; alternativa documentada |
| Revisão da Play recusa (wrapper, aviso, hardware) | Média | Médio | Ficha deixa clara a função nativa; acesso ao app explica o cabo; QP ataca a ficha; resposta a recurso preparada pelo agente |
| Merge ou deploy automático leva regressão à produção | Baixa | Alto | 0.21: CI verde no HEAD, QA PASS, staging e e2e antes de produção, smoke e rollback imediato |
| Política remota não alcança app offline com site antigo em cache | Baixa | Médio | A navegação ao vivo nunca vem do cache (`D:\git\open-auri\web\src\service-worker.ts:92-93`); comportamento offline documentado no runbook; Q2 confirma |
| `server.url` não recomendado em produção | Média | Alto | Decisão A documentada; origem fixada; `verifyCapacitorConfig`; teste em emulador; fallback B está avaliado e é inviável sem reescrever o site |
| CSP com nonce bloqueia a injeção do bridge em WebView antiga | Média | Alto | `DOCUMENT_START_SCRIPT` obrigatório; tela de atualização; teste em emulador contra a CSP real |
| Turnstile não funciona na WebView | Baixa a média | Alto (login e cadastro) | Confirmação no PF1.6; smoke de login no Anexo F; se falhar, interrupção (0.1 a) |
| Claim da interface HID corta o áudio | Média | Médio | Claim só durante a sequência, solta com 1500 ms ocioso; F5 mede; documentar se o efeito for aceito |
| Descritor real difere da hipótese (tamanho, sem interrupt OUT) | Média | Alto | Framing guiado pelo descritor real lido em tempo de execução; as duas rotas implementadas; F5 confirma; política remota bloqueia versões erradas |
| Variação entre fabricantes (OTG, energia, kernel) | Média | Médio | Dois ou mais fabricantes no Anexo E; RF13; Diagnóstico USB; relatos públicos |
| Perda da chave de assinatura | Baixa | Alto | Runbook com backup duplo; com Play App Signing, perda da chave de upload tem reset pela Play |
| Secrets de assinatura expostos no monorepo | Baixa | Alto | Environment `android-release` com aprovação, restrito a tags protegidas; job de build sem secrets; Q3 e QG atacam |
| Deriva de versão entre `@capacitor/core` do site e o app | Média | Médio | Teste de paridade; `bridgeApi`; política 0.19 |
| Hardware atrasado | Alta | Bloqueia só a F5 | Lançamento independe do cabo; F5 começa com H-HW |

## 13. Entradas humanas

| ID | Quando | O quê | Bloqueia |
|---|---|---|---|
| H-CLEAN | PF1 | Commitar ou guardar o trabalho em andamento para o working tree ficar limpo | PF1 |
| H-ID | resolvido | `applicationId` `com.openauri.app`, nome `open-auri` | - |
| H-GH | PF1 (condicional) | `gh auth login` com escopos `repo` e `workflow`, se o PF1.3 falhar | merge e deploy (0.21) |
| H-SDK | PF1 (condicional) | Aceitar as licenças do Android SDK, se o `sdkmanager` exigir interação | T1.1 |
| H-PLAY-CONTA | P1 | Entrar no Play Console, conferir o estado da conta, verificar e-mail, telefone e identidade, ativar 2FA | P5 |
| H-PLAY-APP | P5 | Criar o app e preencher ficha e formulários a partir dos documentos | PF4 |
| H-KEY | até o PF4 (ideal: em paralelo à F2) | Criar as duas chaves offline pelo runbook, fazer o backup e informar o SHA-256 da chave do app | P6, T4.1 |
| H-ENV | até o PF4 | Criar o Environment `android-release` (aprovação obrigatória, só tags `android-v*`), cadastrar os secrets e proteger as tags | T4.1 |
| H-PLAY-SIGN | P6 | Play App Signing com a chave própria (PEPK), chave de upload, registro do pacote | P7 |
| H-ENV-APPROVE | T4.1, T5.4 | Aprovar o job de assinatura no Environment `android-release` | release |
| H-PROD-APPROVE | T4.1, T5.4 (condicional) | Aprovar o deploy no Environment `production`, se ele exigir aprovador | deploy |
| H-SMOKE | T4.2 | Executar o Anexo F num celular Android sem cabo | T4.2 |
| H-PLAY-PUB | P7 | Enviar o AAB para o teste interno, instalar, promover para produção (ou teste fechado), responder à revisão | DoD 9.1.6 |
| H-HW | PF5 | Cabo, 2 ou mais Android de fabricantes diferentes, PC Windows com USBPcap e Wireshark | F5 |
| H-CAPTURE | T5.1 | Executar `D:\git\open-auri\docs\android\captura-usb.md` | T5.1 |
| H-DEVICE | T5.3 | Executar o Anexo E em cada aparelho | T5.3 |
| H-SIGNOFF | T5.3 | Assinar `D:\git\open-auri\docs\android\validacao-hardware.md` | T5.4 |
| H-PLAY-UPDATE | T5.4 | Atualizar a ficha e enviar o AAB novo na Play | DoD 9.2.3 |

## 14. Registro de progresso

| Data | ID | Estado | Commit | Evidência |
|---|---|---|---|---|
| 2026-10-18 | Plano | proposto (revisão 3) | - | este arquivo |

**Versões verificadas (0.14):** preenchido no PF1.
**Tabelas de locks por wave:** preenchidas em cada PF.
**Falhas pré-existentes da baseline:** preenchidas no PF1.
**Trilha P:** estado de P0 a P7 e da revisão da Play, atualizado a cada passo.

---

## Anexo A · Modelos de despacho
- Implementação: seção 5.7.
- QA heavy: seção 5.8.
- Mensagem ao mantenedor (Trilha P): seção 5.9.

**Pre-flight:**
```
[route class=recon risk=low scope=repo needs=shell]
1. TASK: PFn · Pre-flight da Fase n. Verificar e corrigir na hora os itens <lista do plano>.
2. EXPECTED OUTCOME: cada item OK com evidência (saída de comando, arquivo:linha) ou a correção aplicada; itens não corrigíveis listados como bloqueio.
3. TOOLS: router_run (scripts allowlisted), leitura.
4. MUST DO: rodar as suítes da baseline em série; registrar falhas pré-existentes; publicar tabela de locks.
5. MUST NOT DO: editar código de produção fora de correção de PF aprovada; gravar em cabo físico; abrir .env.
6. CONTEXT: seção da fase, seção 6, seção 13.
7. ENVIRONMENT: Working directory is D:\git\open-auri (branch da fase). Platform: win32. Shell: pwsh.
```

**Merge e deploy (tier `fast`, 0.21):**
```
1. TASK: merge do PR <n> e deploy staging → produção conforme 0.21.
2. EXPECTED OUTCOME: saída de `gh pr checks <n>` (todos verdes), `gh pr merge <n> --merge`, `gh workflow run deploy.yml` (staging), e2e de staging, `gh workflow run deploy.yml` (produção, confirm=production), smoke de produção; ou o primeiro passo que falhou.
3. TOOLS: shell (gh), router_run (e2e).
4. MUST DO: parar no primeiro check vermelho; seguir a ordem exata; registrar o id de cada run.
5. MUST NOT DO: --admin, force push, squash, pular staging, rodar produção com e2e de staging vermelho.
6. CONTEXT: seção 0.21, runbook docs\operacao\runbooks\android-release.md.
7. ENVIRONMENT: Working directory is D:\git\open-auri. Platform: win32. Shell: pwsh.
```

**Fix de QA:**
```
[route class=debug risk=<da severidade> scope=<do achado> needs=edit,shell]
1. TASK: FXn.k · Corrigir o achado <id> do Qn rodada r: <texto do achado com evidência>.
2. EXPECTED OUTCOME: correção mínima + teste que falhava antes e passa depois.
3. TOOLS: informativo.
4. MUST DO: reproduzir primeiro; correção mínima; teste de regressão; rodar a área.
5. MUST NOT DO: refatorar junto; tocar arquivo fora do achado; pular teste.
6. CONTEXT: achado completo, arquivos citados.
7. ENVIRONMENT: Working directory is D:\git\open-auri (branch da fase). Platform: win32. Shell: pwsh.
[acceptance]
check: testsPass
criteria: o teste de regressão reproduz o achado antes e passa depois; nada mais muda.
deliverable: correção + teste
[/acceptance]
```
Se o achado for blocking ou critical, o fix leva `VERIFY:required`.

## Anexo B · Contrato da ponte `OpenAuriUsb` (bridgeApi 1)

```ts
interface NativeDeviceInfo {
  key: string;            // deviceName#deviceId, estável durante a conexão física
  vendorId: number;       // 0x3302
  productId: number;      // 0x8902
  productName: string;    // "USB DSP Audio"
}
interface UsbDiagnostics {
  device: NativeDeviceInfo;
  appVersion: string;
  androidVersion: string;
  webViewVersion: string;
  rawDescriptorsHex: string;          // UsbDeviceConnection.getRawDescriptors()
  hidInterfaceId: number;
  endpoints: { address: number; type: 'interrupt' | 'bulk' | 'control'; direction: 'in' | 'out'; maxPacketSize: number }[];
  reportDescriptorHex: string;
  outputReports: { reportId: number; bytes: number }[];
  transfer: 'interrupt' | 'control';
  paddedLength: number;
  kernelDriverDetached: boolean;
  wireLog?: { atMs: number; hex: string }[]; // só em build de debug
}
interface OpenAuriUsbPlugin {
  getInfo(): Promise<{ bridgeApi: 1; appVersion: string; usbHost: boolean; webViewVersion: string }>;
  requestDevice(o: { filters: { vendorId?: number; productId?: number }[] }): Promise<{ devices: NativeDeviceInfo[] }>;
  getDevices(): Promise<{ devices: NativeDeviceInfo[] }>;
  open(o: { key: string }): Promise<void>;
  close(o: { key: string }): Promise<void>;
  sendReport(o: { key: string; reportId: number; data: string /* base64 */ }): Promise<void>;
  diagnostics(o: { key: string }): Promise<UsbDiagnostics>;
  addListener(event: 'connect' | 'disconnect', cb: (e: { device: NativeDeviceInfo }) => void): Promise<{ remove(): Promise<void> }>;
}
interface OpenAuriFilesPlugin {
  save(o: { name: string; mime: string; base64: string }): Promise<{ saved: boolean }>;
}
```

## Anexo C · Erros nativos → JS

| Código nativo | Quando | JS (como o WebHID) |
|---|---|---|
| `USB_BAD_ARGS` | Argumento inválido (reportId fora de 0..255, base64 inválido, chave vazia) | `TypeError` |
| `USB_NOT_FOUND` | Chave desconhecida ou dispositivo ausente | `DOMException('NotFoundError')` |
| `USB_NOT_OPEN` | `sendReport` sem `open` | `DOMException('InvalidStateError')` |
| `USB_BUSY` | Sequência concorrente na mesma chave | `DOMException('InvalidStateError')` |
| `USB_PERMISSION_DENIED` | Permissão revogada depois do `open` | `DOMException('NotAllowedError')` |
| `USB_GUARD_REJECTED` | FrameGuard recusou (motivo na mensagem) | `DOMException('NotAllowedError')` |
| `USB_TRANSFER_FAILED` | Retorno negativo da transferência | `DOMException('NotAllowedError')` |
| `USB_TIMEOUT` | Transferência acima de 1000 ms | `DOMException('NotAllowedError')` |
| `USB_DETACHED` | Desconectado durante a operação (evento `disconnect` antes) | `DOMException('NotAllowedError')` |
| `USB_ORIGIN` | Origem da página diferente da fixada | `DOMException('SecurityError')` |
| `USB_NO_HOST` | Aparelho sem USB host | `DOMException('NotSupportedError')` |

## Anexo D · Framing e guarda

**D.1 Rota.** Se a interface HID tem endpoint interrupt OUT, use `UsbRequest`. Senão, SET_REPORT por controle: `controlTransfer(0x21, 0x09, 0x0200 | 0xCB, hidInterfaceId, buf, len, 1000)`. É a mesma ordem do Linux (`hidraw`: interrupt e, na falta, SET_REPORT) e do driver HID do Windows, conforme a seção 4.5.

**D.2 Buffer.**
- Montagem: `[0xCB] + 31 B de dados`, com padding zero até `paddedLength`.
- Política única no lançamento: `WINDOWS_MAX_OUTPUT`, em que `paddedLength = max(outputReports.bytes) + 1`, igual ao que `hid_connection_win.cc` entrega ao driver no Windows. Com um único output report de 31 bytes, isso dá 32 bytes, que é o mesmo que o Linux e o macOS enviam.
- Nunca usar `wMaxPacketSize` como tamanho do report.
- A T5.2 confirma pela captura ou corrige.

**D.3 FrameGuard (por chave de dispositivo).**
```
Idle --report[idx=0] ok--> Receiving(1)
Receiving(n) --report[idx=n] ok, n<8--> Receiving(n+1)
Receiving(8) --report[idx=8] ok--> AwaitCommit
AwaitCommit --commit exato + payload remontado (preâmbulo e CRC16 OK) + >=2000 ms do último commit--> Idle (forward)
qualquer estado --outro byte, idx fora de ordem, tamanho != 31, reportId != 0xCB, >2000 ms sem report--> Idle (reject, nada enviado)
```
- Reports de dados são encaminhados um a um, preservando o timing do transporte.
- O commit só é encaminhado depois da validação completa.

## Anexo E · Checklist de validação no aparelho (F5, por aparelho)
1. **Identificação:** modelo, fabricante, versão do Android, versão da WebView, versão do app, origem da instalação (Play ou GitHub).
2. **Diagnóstico USB:** JSON copiado, com `transfer` e `paddedLength` iguais aos da T5.2.
3. **Gravação:** gravar, pelo fluxo normal, os 11 presets e o Neutro, na ordem do fixture. O wire log bate com o golden em 12 de 12.
4. **Áudio:**
   - música tocando no fone pelo cabo antes, durante e depois de cada gravação;
   - anotar corte (sim ou não, duração);
   - o som muda conforme o preset gravado (A/B audível entre Basshead e Analítico).
5. **Interrupção:** desconectar o cabo no meio da gravação 3 vezes. Esperado: `interrupted`, sem commit no wire log, cabo funcionando depois do Neutro.
6. **Permissão:** negar, conceder, revogar nas configurações do Android e tentar de novo.
7. **Ciclo de vida:** mandar o app para segundo plano durante a gravação. Esperado: a sequência expira sem commit.
8. **Vários cabos:** fila com 2 cabos, se houver um segundo.
9. **Resgate:** gravar o Neutro pelo app e pelo desktop; os dois deixam o cabo neutro.

## Anexo F · Smoke de lançamento num celular sem cabo (F4)
1. Instalar o APK da release do GitHub; conferir o SHA-256 e o fingerprint com os publicados.
2. Abrir o app: o modal do aviso (Anexo G.1) aparece; aceitar; fechar e reabrir o app: o modal não volta.
3. Navegar por todas as páginas do RF1; trocar o idioma; o modal e o banner aparecem no idioma certo.
4. Página do cabo:
   - banner do aviso visível;
   - "Conectar" sem cabo → nenhum dispositivo, com mensagem clara;
   - o Diagnóstico USB não aparece sem cabo;
   - o link "Relatar resultado" abre o issue form no navegador do sistema.
5. Tocar um áudio de teste e um arquivo próprio; a prévia funciona.
6. Exportar o JSON de uma curva e o diário: o SAF abre e salva.
7. Entrar na conta (Turnstile) e sair.
8. Um link externo (Kuba) abre no navegador do sistema.
9. App Links:
   - abrir um link `/c/<id>` vindo de outro app: abre no app;
   - com adb: `adb shell pm get-app-links com.openauri.app` com estado `verified`.
10. Modo avião: reabrir o app → página em cache ou `offline.html` com "Tentar de novo".
11. Depois do P7: instalar pela Play por cima do APK do GitHub sem desinstalar (mesma assinatura).

## Anexo G · Textos do aviso (exatos; sem U+2014)

**G.1 Modal e banner (pt-BR)**
- **Título:** "Gravação pelo app ainda não testada num cabo"
- **Texto:** "O app Android ainda não foi testado num cabo Auri de verdade, então não dá para garantir que a gravação funcione. Ele usa o mesmo protocolo e envia os mesmos bytes que o site no computador e a página oficial da Kuba (testes automáticos conferem isso byte a byte). Só muda o caminho até o USB. Em teoria, o resultado deve ser o mesmo. Se o som ficar estranho depois de gravar, grave o Neutro. Se não resolver, grave o Neutro pelo site no computador (Chrome ou Edge)."
- **Botões e links:** "Entendi" · "Relatar resultado" · "Como resgatar"

**G.1 Modal e banner (en-US)**
- **Título:** "Writing from the app has not been tested on a cable yet"
- **Texto:** "The Android app has not been tested with a real Auri cable yet, so writing is not guaranteed to work. It uses the same protocol and sends the same bytes as the desktop site and Kuba's official page (automated tests check this byte by byte). Only the path to USB is different. In theory, the result should be the same. If the sound seems off after writing, write Neutral. If that does not fix it, write Neutral from the site on a computer (Chrome or Edge)."
- **Botões e links:** "Got it" · "Report result" · "How to recover"

**G.2 Banner curto (página do cabo)**
- pt-BR: "Gravação pelo app ainda não testada num cabo real. Em teoria funciona igual ao computador."
- en-US: "Writing from the app has not been tested on a real cable yet. In theory it works the same as on a computer."

**G.3 Item do checklist**
- pt-BR: "Entendo que a gravação pelo app Android ainda não foi testada num cabo real."
- en-US: "I understand that writing from the Android app has not been tested on a real cable yet."

**G.4 Gravação pelo app desligada (política remota)**
- pt-BR: "A gravação pelo app está desligada no momento. Use o site no computador (Chrome ou Edge) ou atualize o app."
- en-US: "Writing from the app is turned off for now. Use the site on a computer (Chrome or Edge) or update the app."

**G.5 Notas da release, README e ficha da Play**
- pt-BR: "Aviso: a gravação pelo app ainda não foi testada num cabo Auri real. O app usa o mesmo protocolo e envia os mesmos bytes que o site no computador (conferido por testes automáticos); em teoria o resultado é o mesmo, mas não há garantia. Relate o resultado em https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml"
- en-US: "Notice: writing from the app has not been tested on a real Auri cable yet. The app uses the same protocol and sends the same bytes as the desktop site (checked by automated tests); in theory the result is the same, but it is not guaranteed. Report your result at https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml"

**G.6 Depois da validação (F5)**
- pt-BR: "Gravação pelo app validada em cabo real em <data>, em <n> aparelhos. Relatório: docs/android/validacao-hardware.md"
- en-US: "Writing from the app validated on a real cable on <date>, on <n> devices. Report: docs/android/validacao-hardware.md"

## Anexo H · Roteiro do mantenedor na Play (o agente envia cada bloco na hora certa)

**H.1 Conta (P1), a partir do PF1**
1. Entrar em https://play.google.com/console com a conta Google antiga.
2. Se aparecer aviso de conta fechada ou "inativa", parar e informar o texto exato.
3. Em "Detalhes da conta": conferir e verificar e-mail de contato e telefone; salvar.
4. Na conta Google: ativar a verificação em duas etapas.
5. Concluir a verificação de identidade pedida pelo Console (documento enviado só no Console, nunca no chat).
6. Conferir o nome público de desenvolvedor e o e-mail público.
7. Informar ao agente: conta ativa ou fechada, data de criação (aparece em "Detalhes da conta"), tipo (pessoal ou organização), identidade verificada (sim ou não).

**H.2 App e formulários (P5), depois de P2 e P4**
1. "Criar app": nome `open-auri`, idioma padrão português (Brasil), app, gratuito, aceitar as declarações.
2. "Ficha principal da loja": copiar de `D:\git\open-auri\docs\android\play-listing.md` (pt-BR e en-US); artes ficam para depois da P3.
3. "Conteúdo do app": preencher na ordem de `D:\git\open-auri\docs\android\play-conteudo.md` (política de privacidade, acesso ao app, anúncios, classificação, público-alvo, Data safety a partir de `D:\git\open-auri\docs\android\data-safety.md`, demais declarações).
4. Informar ao agente o que ficou pendente ou o que o Console recusou, com o texto do erro.

**H.3 Assinatura e registro (P6), na F4**
1. Ter as duas chaves de H-KEY à mão, na sua máquina.
2. "Proteção da Play" > "Assinatura de apps": escolher usar a sua própria chave de assinatura; baixar a PEPK e seguir as instruções do Console para exportar e enviar a chave do app criptografada.
3. Registrar o certificado da chave de upload, conforme o Console pedir.
4. Abrir a página de verificação de desenvolvedor do Android no Console; confirmar `com.openauri.app` registrado com o SHA-256 da chave do app.
5. Informar ao agente os fingerprints SHA-256 que o Console mostra (chave do app e chave de upload).

**H.4 Publicação (P7), depois da T4.1**
1. Baixar o AAB da release `android-v1.0.0` no GitHub.
2. "Teste interno": criar versão, enviar o AAB, colar as notas da versão (aviso G.5), adicionar o seu e-mail como testador, publicar.
3. Instalar pela Play no seu celular, por cima do APK do GitHub, sem desinstalar. Informar se funcionou.
4. Se a conta for isenta de teste fechado: promover para "Produção", revisar e enviar. Se não for: criar o teste fechado com os testadores recrutados.
5. Se a revisão recusar, colar ao agente o motivo exato.
