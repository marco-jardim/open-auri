# Plano de implementação · open-auri web v1

| Campo | Valor |
|---|---|
| Data | 2026-10-15 |
| Repositório | `D:\git\open-auri` (remoto `https://github.com/marco-jardim/open-auri`) |
| Plataforma de execução | Windows (win32), shell pwsh 7 |
| Fonte de verdade visual | `D:\git\open-auri\design\mocks\v2\*.html` e capturas em `D:\git\open-auri\design\mocks\v2\_qa\` |
| Fonte de verdade de segurança | `D:\git\open-auri\design\analysis\limites-v2.md`, `D:\git\open-auri\design\analysis\limites-v2.json`, `D:\git\open-auri\design\analysis\envelope.json` |
| Registro de progresso | `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-progresso.md` (criado no PF1, escrito só pelo orquestrador) |
| Executor | um agente LLM de alta capacidade, do início ao fim, orquestrando papéis via model-router |

---

## 0. Diretivas de execução (ler antes de tudo)

**0.1 Execução contínua.** Execute F1 → F2 → F3 → F4 → F5, wave após wave, sem pausas para reporte e sem pedir confirmação entre waves ou fases. Só interrompa e fale com o humano quando ocorrer um destes casos:
- (a) ambiguidade que muda o resultado e não está resolvida neste plano;
- (b) problema crítico: segurança, perda de dados, risco ao cabo ou à audição, violação de licença;
- (c) bloqueio: entrada humana ausente (seção 13), serviço externo indisponível por mais de 30 minutos, ou falha que persiste depois do protocolo de recuperação (0.5).

Ao interromper:
- registre no progresso;
- descreva o problema com evidência;
- proponha opções;
- continue as tarefas não afetadas, se houver.

**0.2 Solução definitiva, nunca entrega parcial.** Cada tarefa entrega a solução final do seu objetivo. São proibidos stubs, mocks em código de produção, "TODO depois" e caminhos felizes sem tratamento de erro.
- Exceção única: os recursos marcados **EM BREVE** (seção 3.1), que são decisão de produto dependente do hardware e usam o padrão de UI EM BREVE. Não são stubs.
- `TODO`/`FIXME` em código entregue só é permitido citando um ID da seção 13 (ex.: `// TODO(Q-KUBA-LIC)`).

**0.3 Pre-flight antes de cada fase.** Toda fase começa pelo seu PF (PF1…PF5). Tudo o que o PF encontrar é **corrigido na hora**. Se o problema já estiver marcado no plano para uma fase futura, apenas documente no progresso e na issue da fase. Uma fase não começa com o PF reprovado.

**0.4 Testes ao final de cada fase.** Toda fase termina com a tarefa `Tn.T` (bateria de testes da fase: cobertura, casos de borda, regressão), antes do QA.

**0.5 QA sênior adversarial ao final de cada fase, sempre em tier heavy.** Depois de `Tn.T`, rode `Qn` com papel `reviewer` e `[tier:heavy]`.
- **1ª rodada:** todos os achados (blocking, critical, major, minor) viram tarefas de correção `FXn.k`, implementadas e verificadas.
- **2ª rodada (heavy) sobre a mesma implementação:** de novo, todos os achados são corrigidos.
- **Depois da 2ª rodada:** não refaça reviews até esgotar os achados. Só se corrigem bugs **major, critical e blocking**, verificados por testes direcionados. Os achados **minor** restantes viram issues no GitHub (rótulo `qa-minor`, 0.20) e a fase segue.
- **Definição de PASS** em todo o plano: nenhum achado major, critical ou blocking aberto depois desse ciclo.
- **Fracasso persistente:** se o mesmo bug major ou pior resistir a 3 tentativas de correção:
  1. pare;
  2. reverta ao último estado bom;
  3. documente;
  4. consulte o `architect` em tier heavy;
  5. se não resolver, pergunte ao humano.

**0.6 Regra fixa: QA é sempre tier heavy.** Todo despacho de revisão, QA ou adversarial carrega `[tier:heavy]` e a linha de rota com `tier=heavy pin`. Sem exceção.

**0.7 Paralelismo máximo com segurança.** Siga a seção 6:
- conjuntos de escrita disjuntos;
- ninguém lê um arquivo enquanto outro agente o edita;
- arquivos serializados passam pela fila de integração.

**0.8 Commit often.**
- **Frequência e autoria:** um commit por tarefa verificada (ou por subtarefa grande), feito só pelo orquestrador, em série.
- **Mensagem:** Conventional Commits em inglês com o ID da tarefa (ex.: `feat(core): promote gate v2 to src/safety [T1.2]`).
- **Pathspec:** sempre explícito (`git add -- <arquivos do conjunto de escrita da tarefa>`). Nunca `git add -A` ou `git add .` com outras tarefas em voo.
- **Proibido:** `--no-verify`, `amend` de commit já pushado, force push, e linhas `Co-Authored-By` ou "Generated with". Esta última regra é absoluta e deve constar em toda delegação.
- **Dados sensíveis:** `npm run check:sensitive` verde antes de cada commit (0.16).
- **Push:** autorizado pelo operador (H-PUSH). Push para `origin/main` ao fim de cada fase aprovada no QA, e nunca com o `check:sensitive` acusando algo.

**0.9 Caminhos completos.** Toda referência a arquivo, no plano, nos despachos, nos relatórios e nos corpos de commit, usa o caminho absoluto (`D:\git\open-auri\...`).

**0.10 Model-router.** Todo despacho segue a seção 5:
- linha de rota como primeira linha;
- prompt em 7 seções (TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT);
- bloco `[acceptance]`;
- `VERIFY:required` em tarefas com dependentes.

O bloco ENVIRONMENT é obrigatório:

```
ENVIRONMENT: Working directory is D:\git\open-auri. Platform: win32. Shell: pwsh 7.
Paths are absolute. You are already here; do not ask for permission to read or write inside it.
Never add Co-Authored-By or "Generated with" lines. Do not commit (the orchestrator commits).
```

**0.11 Regras rígidas herdadas (AGENTS.md).**
- **Código:** sem `as any`, `@ts-ignore` ou `@ts-expect-error`; sem `catch` vazio ou erro engolido; nunca apagar ou pular teste que falha; nunca especular sobre código não lido; nunca deixar o repo quebrado; bugfix mínimo, sem refatorar junto.
- **Shell:** não interativo. Nada que espere input.
- **Windows:** pwsh, `$env:VAR`, temporários em `%TEMP%\Claude`.

**0.12 Invariantes de segurança (nunca regredir; o QA verifica em toda fase).**
1. Nenhum byte vai ao cabo sem: gate v2 aprovado nos valores Q27/Q23 reais, checklist pré-gravação completo e gesto explícito do usuário.
2. Nunca gravar automaticamente (sem gravar ao arrastar, sem gravar em lote não confirmado).
3. Os 11 presets oficiais são enviados byte a byte iguais ao fixture `D:\git\open-auri\test\fixtures\eq0xcb.reference.json`. O Neutro é 10 × OFF + preamp −0,5 dB, com CRC 0x4FFF.
4. O servidor nunca publica curva reprovada no gate. O navegador revalida antes de gravar qualquer curva, venha de onde vier.
5. HS, LP e HP só são editáveis na camada Engenharia, com confirmação extra antes de gravar.
6. Nenhum controle inexistente no protocolo (volume do cabo, crossfeed, L/R, filtro do DAC). O volume da prévia no navegador é permitido e rotulado "só no navegador".
7. Medidores (VU, LED, PPM) mostram só dados reais: áudio ao vivo ou dados da curva. Nunca animação decorativa que imite medição.

**0.13 Registro de progresso.** O orquestrador mantém `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-progresso.md` com:
- status de cada tarefa;
- tabela de locks ativa;
- resultado de cada PF e de cada QA;
- hashes de commit;
- decisões tomadas durante a execução;
- bloqueios.

Só o orquestrador escreve nesse arquivo.

**0.14 Versões sempre atuais do upstream.** Este plano não fixa versões. Em cada PF:
- para cada biblioteca e ferramenta usada na fase, consultar a última versão estável no upstream (`npm view <pacote> version`, releases e changelog no GitHub, documentação via context7);
- adotar essa versão, inclusive majors novas, com a migração feita dentro da própria fase.

O lockfile registra as versões exatas resolvidas. O progresso registra a tabela "pacote → versão → data da verificação". Pré-release só com justificativa registrada.

**0.15 Configuração do operador (`.env`).**
- **`D:\git\open-auri\.env`** (ignorado pelo git) guarda a configuração do operador:
  - **Cloudflare:** `CLOUDFLARE_ACCOUNT_ID` (há outras contas no mesmo login; nunca usar outra), `CLOUDFLARE_ACCOUNT_NAME`, `CLOUDFLARE_WORKERS_SUBDOMAIN`, `WORKER_NAME_WEB`, `WORKER_NAME_JOBS`.
  - **Públicas** (embutidas no bundle do cliente no build, prefixo `PUBLIC_`): `PUBLIC_ORIGIN`, `PUBLIC_GITHUB_URL`, `PUBLIC_TURNSTILE_SITE_KEY`, `PUBLIC_LGPD_CONTROLLER`, `PUBLIC_LGPD_CONTACT_EMAIL`, `PUBLIC_LGPD_CNPJ`, `PUBLIC_LGPD_ADDRESS`, `PUBLIC_LGPD_DPO_NAME`, `PUBLIC_POLICY_EFFECTIVE_DATE`.
  - **Segredos** (só em runtime, via `wrangler secret`): `ADMIN_EMAIL`, `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, `BETTER_AUTH_SECRET`, `IPHASH_PEPPER`, `ACCESS_LOG_KEY` e, quando criado, `RESEND_WEBHOOK_SECRET`.
  - **Flags:** `ACCESS_LOG_ENABLED=true`, `SIGNUP_ENABLED=false` (até o domínio de e-mail do `.com`), `ADMIN_2FA_REQUIRED=true`.
- **`D:\git\open-auri\.env.example`** (versionado) lista todas as chaves com **placeholders descritivos**, sem nenhum valor real. Toda chave nova entra nos dois arquivos.
- **Scripts Node** leem o `.env` diretamente ou com `node --env-file=D:\git\open-auri\.env`. Nunca imprimir valor secreto em log, relatório ou commit.
- **Configuração do Wrangler gerada:** `D:\git\open-auri\web\wrangler.template.jsonc` e `D:\git\open-auri\workers\jobs\wrangler.template.jsonc` (versionados, com `${VAR}`) viram `wrangler.jsonc` (ignorados pelo git) via `D:\git\open-auri\tools\render-wrangler.mjs`, executado nos scripts `predev`, `prebuild` e `predeploy`.
  - O `account_id` e os IDs de D1, KV e R2 ficam só no `.env` e no arquivo gerado.
  - O deploy recusa rodar se a conta ativa do wrangler (`wrangler whoami`) divergir de `CLOUDFLARE_ACCOUNT_ID`.
- **Segredos dos Workers** vão por `wrangler secret put` via `D:\git\open-auri\tools\sync-secrets.mjs`, que lê o `.env` sem ecoar valores.
- **Autenticação e deploy:** o deploy roda da máquina do operador com o OAuth já logado, via `D:\git\open-auri\tools\deploy.mjs` (seção T5.1). O deploy pelo GitHub Actions é opcional: só é ativado se existir o segredo `CLOUDFLARE_API_TOKEN` (H-CF-TOKEN).

**0.16 Repositório público: dados sensíveis.**
- **Nunca em arquivo versionado:** nome da empresa, e-mails, CNPJ, endereço, nome de pessoas (exceto o dono público do repositório no GitHub), IDs de conta e de recursos Cloudflare, subdomínio do workers.dev, chaves, tokens e caminhos do perfil do usuário (`C:\Users\<nome>`).
- **Como esses valores entram:** variáveis de ambiente.
  - No build: `PUBLIC_*` via `$env/static/public` do SvelteKit, carregadas do `.env` local ou dos segredos do CI.
  - No runtime: `vars` e segredos do Worker, injetados pelo `deploy.mjs` e pelo `sync-secrets.mjs`.
- **Textos legais e e-mails:** templates com `{{VAR}}`.
- **Antes de todo commit, e em todo PF:** rodar `npm run check:sensitive` (`D:\git\open-auri\tools\check-sensitive.mjs`). Ele procura no conteúdo versionável os valores do `.env` e seus derivados (domínio dos e-mails, subdomínio, caminho do perfil). Qualquer achado bloqueia o commit até a correção.
- **No CI:** os builds usam valores fictícios para as `PUBLIC_*`, mais uma varredura de segredos.
- **Relatórios e o registro de progresso** seguem as mesmas regras.

**0.17 Itere continuamente e assuma quando o router travar.**
- **Iteração:** siga wave após wave, fase após fase. Pare só diante de bloqueio ou de algo crítico (0.1).
- **Quando assumir:** se o que travou foi o model-router repetidas vezes (2 ou mais despachos seguidos da mesma tarefa) porque um agente menos capaz devolveu prolixidade, `NEED MORE`, `ESCALATE` sem progresso ou entrega fora do W, o orquestrador assume na hora e faz ele mesmo a leitura ou a implementação travada. O orquestrador é um modelo top tier, extremamente inteligente e capaz.
- **Depois de assumir:**
  - registrar no progresso o motivo e o que foi feito;
  - verificar com testes direcionados;
  - voltar a delegar a partir da tarefa seguinte.
- **Sem esse travamento,** a delegação continua sendo a regra (0.18).

**0.18 Delegação pelo model-router, sempre.**
- **Tarefas atômicas:** um objetivo e um W pequeno por despacho. Tarefas grandes do plano são quebradas em subtarefas despacháveis, mantendo os locks (seção 6).
- **Coding complexo vai para o heavy.** As tarefas abaixo carregam `[tier:heavy]` na implementação, com `tier=heavy pin` na rota:
  - F1: T1.2, T1.3, T1.9, T1.11, T1.12;
  - F2: T2.5, T2.6, T2.7, T2.10;
  - F3: T3.3, T3.5;
  - F4: T4.2, T4.4, T4.10, T4.13.

  As demais seguem a rota normal. O orquestrador pode marcar outras como heavy se a complexidade se revelar maior, registrando no progresso.
- **Separar o trabalho pesado do pós-trabalho:** a delegação heavy faz só o raciocínio e a escrita do código. Rodar testes, coletar resultados e correções mecânicas (imports, lint, digitação) vão para delegações mais leves: `runner` para rodar e coletar, `implementer` normal para consertos mecânicos.
- **Contexto antes do heavy:** o levantamento de arquivos e fatos é feito antes, por `explorer`/`runner`, e colado no prompt heavy.

**0.19 Testes direcionados, rápidos e paralelos.**
- **Escopo:** nunca rode a suíte completa sem necessidade. Rode só os testes que a modificação toca:
  - o arquivo de teste do módulo alterado;
  - os testes de quem importa o módulo;
  - os e2e da rota afetada.
- **Quando a suíte completa roda:** só na bateria `Tn.T`, no QA e antes do push de fim de fase.
- **Como acelerar:**
  - `node --test --test-concurrency=<núcleos>` com arquivos específicos;
  - Vitest com `--pool=threads` e filtro por arquivo ou `--changed`;
  - Playwright com `--workers=<núcleos>`, `--grep` e shards quando a bateria for longa;
  - build incremental e reuso do servidor de preview entre specs;
  - cache do pipeline do AutoEq e do Playwright.
- **Scripts por área** (criados na T1.1 e na T2.1): `test:dsp`, `test:safety`, `test:share`, `test:io`, `test:solver`, `test:transport`, `test:policy`, `test:meter`, `test:catalog`, `test:web:unit`, `test:web:int`, `test:web:e2e`. Assim o `router_run`, que só aceita scripts do `package.json`, consegue rodar testes direcionados.

**0.20 Issues no GitHub** (não usamos Linear).
- **Acompanhamento:** uma issue de acompanhamento e uma issue por fase (rótulos `plano`, `fase:1`…`fase:5`, `fase:H`), criadas na preparação, com checklist de PF, tarefas, `Tn.T` e QA.
- **Durante a execução, o orquestrador:**
  - marca os itens concluídos (`gh issue edit`/`gh issue comment`);
  - comenta com os hashes de commit;
  - fecha a issue da fase quando o QA da fase passa;
  - abre issues para achados `qa-minor` adiados (0.5) e para bloqueios (`bloqueio`).
- **Texto das issues:** nunca dados sensíveis ou que facilitem OSINT. Nada de nomes de pessoas ou empresa, e-mails, IDs de conta ou recurso, subdomínios, caminhos locais ou detalhes de infraestrutura privada. Rodar o conteúdo pelo `check:sensitive` antes de publicar (rascunho num arquivo não ignorado, varredura, publicação, remoção do rascunho).

**0.21 Handover.** Ao encerrar uma sessão, ou quando o contexto ficar pequeno, o orquestrador atualiza `D:\git\open-auri\docs\plans\2026-10-16-handover.md` e o prompt de retomada `D:\git\open-auri\docs\plans\2026-10-16-handover-prompt.md` com:
- estado e próxima ação;
- locks em voo;
- issues;
- problemas conhecidos.

Se o trabalho estiver numa worktree fora do diretório base, registrar os dois caminhos: diretório de trabalho da worktree e diretório base `D:\git\open-auri`.

---

## 1. Resumo

Transformar os mocks aprovados (8 páginas com homenagens) em um produto real:

- **Núcleo puro e testado** (`D:\git\open-auri\src\`): codec 0xCB existente, gate v2, formato S1 congelado, envelope S5, importação e exportação EqualizerAPO, medições, ISO 226, solver, catálogo oficial, transporte WebHID com dispositivo simulado, políticas de flash e loudness, e DSP de medição (VU, PPM, true peak, loudness, correlação).
- **Aplicação web local-first** (`D:\git\open-auri\web\`, SvelteKit 2 + Svelte 5 + TypeScript + Tailwind 4, Cloudflare Workers): 7 páginas temáticas, carregador de MP3 na barra superior, prévias com coeficientes exatos a 96 kHz, medidores fiéis à música em AudioWorklet, WebHID real com checklist e diário, PWA offline, i18n pt-BR e en-US.
- **Backend com login opcional** (Better Auth + D1 + Resend):
  - cadastro com verificação de e-mail;
  - recuperação e troca de senha, troca de e-mail, sessões;
  - encerramento de conta e exportação de dados (LGPD);
  - Turnstile, rate limiting e administração.
- **Social completo:**
  - publicação validada pelo gate no servidor, com versões e forks;
  - biblioteca pessoal (criações, favoritos, instaladas) e compartilhamentos com funil;
  - rastreio de quem experimentou, instalou e favoritou, respeitando a privacidade;
  - rankings (mais favoritadas, mais instaladas);
  - perfis, packs, moderação, S6 anônimo e S7 troca às cegas.
- **Produção:** CI/CD, observabilidade, backups, dump público, endurecimento de segurança, runbooks e deploy.

---

## 2. Estado atual

| Item | Situação |
|---|---|
| Codec | `D:\git\open-auri\src\dsp\eq0xcb.mjs`. JS ESM puro, sem I/O, compatível com navegador e Worker. Projeta PK/LS (AutoEq MIT) e HP/LP (RBJ), codifica payload/reports/commit e calcula `magnitudeDb`. |
| Testes | `D:\git\open-auri\test\eq0xcb.test.mjs` (`node:test`, 52 casos). Fixture `D:\git\open-auri\test\fixtures\eq0xcb.reference.json` com os 11 presets em bytes. |
| Ferramentas | `D:\git\open-auri\tools\extract-kuba-reference.mjs` (gera o fixture a partir da página oficial, com SHA-256 fixado). |
| Análise | `D:\git\open-auri\design\analysis\` (não versionado). `gate.mjs`, `gate.test.mjs` (53/53), `limites-v2.*`, `envelope.*`, `qa-parity.mjs`, `qa-audio.mjs`, `dump-kuba.mjs`, `report-kuba.mjs`. |
| Mocks | `D:\git\open-auri\design\mocks\v2\` (não versionado): curva, biblioteca, comparar, soe-como-x, comunidade, teste-cego, cabo, docs. QA aprovado: console limpo, paridade 88/88, blocos compartilhados idênticos, MP3 entre páginas, 96 kHz. |
| Docs | `D:\git\open-auri\docs\*.md` (pt-BR): protocolo, hardware, ideias, social, ecossistema, perguntas abertas, sondagem, verificação. |
| Pacote | `D:\git\open-auri\package.json`: ESM, `"test": "node --test"` (hoje também descobre `design\analysis\gate.test.mjs`). Sem dependências. |
| Licença | AGPL-3.0. AutoEq (MIT) atribuído em `D:\git\open-auri\THIRD_PARTY_NOTICES.md`. |
| Hardware | Cabo ainda não recebido. Nada foi validado em hardware. A página oficial só oferece presets (UI decodificada). |

---

## 3. Requisitos

### 3.1 Decisões aprovadas

| Área | Decisão |
|---|---|
| Design | Direção editorial com homenagens intensas por página (equipamento = UI). Modelo de camadas B na Curva: Ouvir ⊂ Ajustar ⊂ Engenharia, estado na URL `?camada=`. |
| Idiomas | pt-BR padrão + en-US. Anglicismos comuns da indústria mantidos. Sem travessão (—) no texto pt-BR. |
| Curvas | C1 Soe como X, C2 desenhar, C3 delta, C4 `.txt`, C5 loudness ISO 226 estática, C6 (só via HS/LP/HP experimentais na Engenharia; biquad cru EM BREVE), C8 WYSIWYG. C7 descartada. |
| Usos | X1 exportar bytes, X2-web (teste cego no navegador), X3 prévia exata, X4 resgate + diário, X5 headroom, X8 curadoria, X9 vários cabos em sequência. X2 no cabo: EM BREVE. X6: removido. X7 e sondas: fora da UI pública (FH). |
| Proteções | D1 (cortes antes de reforços como ordem padrão; quem decide é o gate), D2, D4, D5, D6, D7 (sem reforço PK acima de 16 kHz; Q ≤ 4 em reforços; cortes com Q maior se o gate aprovar), D8, D10 (OFF identidade). |
| Ideias novas | N1 macros Grave/Corpo/Presença/Brilho, N2 cuidado com a flash (sem limite rígido, 1 gravação a cada 2 s, contadores, aviso informativo a partir de 50/dia), N3 checklist + aviso de loudness (≥ +3 dB ou estado do cabo desconhecido). |
| Limites | Gate v2 "envelope observado" (3.3). PK, LS e OFF liberados. HS, LP e HP liberados como experimentais só na Engenharia. |
| Neutro | 10 × OFF + preamp −0,5 dB (CRC 0x4FFF). "Padrão Auri" = bytes oficiais do preset `padrao` (rótulo "Auri"). |
| Áudio | Carregador de MP3 na barra superior: IndexedDB, nunca enviado. Prévias e teste cego usam o arquivo; ruído rosa como fallback. Streaming via `HTMLAudioElement` + `createMediaElementSource`, contexto a 96 kHz quando possível. |
| Medidores | VU, LED e PPM reagem fielmente à música tocando (3.6). Em repouso, mostram dados da curva ou ficam apagados. Nunca decorativos. |
| Social | Login normal opcional (e-mail + senha) para toda a parte social e a biblioteca pessoal. Cada usuário escolhe um **apelido** único, que é o nome público em rankings, compartilhamentos e créditos das curvas; o e-mail nunca aparece. Sem login: navegar, ouvir, usar curvas, biblioteca local e compartilhar por link `#p=` (S1). Identidade por chave de dispositivo (proposta anterior): substituída pelo login. |
| Recursos sociais | S1, S3 (versões), S4, S5, S6 (anônimo com consentimento), S7 (troca às cegas, agora com backend), S8, S9, S10. Favoritos, criações, instaladas, compartilhamentos com funil, rastreio de quem experimentou, instalou e favoritou, rankings (mais favoritadas, mais instaladas), perfis públicos. Página pública com a biblioteca criada pelo usuário (opt-in, desligada por padrão). S2 descartada. |
| Conta | Trocar senha (revogando outras sessões), trocar e-mail (verifica o novo, avisa o antigo), sessões ativas, exportar dados, encerrar conta. |
| E-mail | Resend, porque o serviço da Cloudflare está em beta e exige DNS na Cloudflare. A chave é válida (no `.env`) e o envio de teste foi entregue em 2026-10-16. Até o `.com`, o remetente é o de teste do Resend (`RESEND_FROM`), que só entrega ao dono da conta. Por isso o cadastro público fica fechado (`SIGNUP_ENABLED=false`) até o domínio de envio do `.com` estar verificado. O site funciona inteiro sem conta. Interface `EmailProvider` para trocar no futuro. |
| Infra | Conta Cloudflare do operador, com plano **Workers Paid** confirmado (nome e ID em `CLOUDFLARE_ACCOUNT_NAME` e `CLOUDFLARE_ACCOUNT_ID`, só no `.env`). Domínio inicial gratuito `PUBLIC_ORIGIN` = `https://open-auri.<subdominio>.workers.dev`, com Workers `open-auri` e `open-auri-jobs`. Um `.com` será comprado depois (runbook "Ativação do .com", T5.5). O widget Turnstile `open-auri` já existe (chaves no `.env`). |
| Dados sensíveis | O repositório é público. Nenhum dado pessoal ou da empresa entra em arquivo versionado: nome, e-mails, CNPJ, endereço, IDs de conta e de recursos, subdomínio e caminhos do perfil do usuário. Esses dados vêm de variáveis de ambiente no build e no deploy (0.16). |
| Versões | Sempre a última estável do upstream, verificada em cada PF (0.14). |
| Rodapé | Link "Código-fonte no GitHub" (`https://github.com/marco-jardim/open-auri`) abaixo de "Aviso legal completo", em todas as páginas. |
| Licenças | Presets e descrições da Kuba: o humano pede autorização após o lançamento (Q-KUBA-LIC); os mocks e o produto mostram "licença: a confirmar". Medições e alvos do AutoEq: **incluídos no produto** por decisão do usuário, com atribuição por fonte e processo de remoção a pedido (`D:\git\open-auri\docs\autoeq-data.md`). |
| EM BREVE | Biquad cru, X2 no cabo, leitura do cabo (firmware, curva atual), modo sem flash (RAM), HP subsônico abaixo da fronteira do gate (≈28,6 Hz em Q 0,5). |

### 3.2 Verdade do hardware (nunca contradizer)

- **Dispositivo:** cabo DSP do fone Auri ("Cabo USB-C com DSP"), chip CB5100, VID 0x3302, PID 0x8902, produto "USB DSP Audio".
- **Transporte:** WebHID (Chrome/Edge desktop, HTTPS, gesto do usuário), report 0xCB, reports de 31 B.
- **Escrita:** só escrita, sem leitura de volta. Cada gravação vai para a flash, com vida útil desconhecida.
- **Processamento:** uma curva para os dois canais. DSP a 96 kHz (0 < f < 48 kHz).
- **Payload de 220 B:**
  - cabeçalho de 14 B: `45 51 31 23 D6 00 00 0A 04 05 01 0A 00 00`;
  - preamp int32 LE em Q23;
  - 10 biquads × 5 int32 LE em Q27, ordem no fio `[b0, b2, −a1, b1, −a2]`;
  - CRC16-CCITT-FALSE LE sobre os primeiros 218 B.
- **Envio:** 9 reports `[índice, 30 B]` (o report 7 tem 10 B, o report 8 vai vazio), 16 ms entre eles, espera de 150 ms, commit `[01 65 00 01 FF]` completado com zeros até 31 B. Cerca de 0,3 s no total.

### 3.3 Gate v2 ("envelope observado")

Uma curva só pode ser gravada ou publicada se, nos valores reais Q27/Q23 que vão no fio, passar em todos os critérios:

| ID | Critério | Limite exato |
|---|---|---|
| a | \|coef\| por posição no fio | b0 1.3123878836631775 · b2 0.9981335923075676 · −a1 1.9973274171352386 · b1 1.9973274171352386 · −a2 0.9973300918936729 |
| b | Raio dos polos em Q27 | ≤ 0.99986846753918 |
| c | Pico da seção isolada (DC–48 kHz) | ≤ 9.200000050722664 dB |
| d | Pico de cada prefixo, com preamp (20 Hz–20 kHz) | ≤ −0.20368875272918074 dB |
| e | Pico de saída 20 Hz–20 kHz · DC–48 kHz | ≤ −0.47087539615209006 dB · ≤ 2.5000638697363913 dB |
| f | Validação do codec | `encodePayload` não lança erro |
| g | Preamp nominal | −25,5 … −0,5 dB |

**Faixas suaves (caixas de uma seção, sempre dentro do gate):**

| Tipo | Frequência | Ganho | Q |
|---|---|---|---|
| PK-main | 150–20 000 Hz | −24…+6 dB | 1–2 |
| PK-narrow | 300–20 000 Hz | −24…+9 dB | 2–4 |
| LS | 80–1 000 Hz | −24…+6 dB | 0,5–0,7 |
| HS-cut | 80–20 000 Hz | −24…0 dB | 0,5–0,7 |
| HS-boost | 8 000–20 000 Hz | −24…+2 dB | 0,5–0,7 |
| LP | 30–20 000 Hz | (sem ganho) | 0,5–0,7 |
| HP | 50–20 000 Hz | (sem ganho) | 0,5–0,7 |

**Faixas absolutas dos controles:** f de 20 Hz a 20 kHz, ganho de −24 a +9,2 dB, Q de 0,1 a 20 (reforço com Q ≤ 4; nenhum reforço PK acima de 16 kHz).

**Arrastar:** para na fronteira por busca binária entre o último ponto aceito e o primeiro recusado e mostra o motivo em linguagem simples. Depois arredonda (ganho 0,1 dB, f 1 Hz, Q 0,01) e revalida.

**Ressalva obrigatória na UI e na Docs:** é uma política de semelhança com o que os 11 presets oficiais já fazem o chip calcular, não uma prova de segurança do hardware.

### 3.4 Design system, páginas e homenagens

**Chrome compartilhado:**
- **Barra superior** fixa e compacta (FUX.NAV, decisão do PO em 2026-10-17): uma linha de 40 px no desktop e 52 px no celular. Marca, navegação que dobra em "Mais" conforme a largura, estado do cabo, ♪ Áudio, play/pause da prévia (atalho k), menu "Carregar no editor" com Neutro e Padrão Auri (botões soltos a partir de 1600 px), Gravar no cabo com o indicador de alterações não gravadas, conta, PT · EN e ajuda. No celular, uma folha de menu reúne navegação, presets, conta, idioma e ajuda. Nunca rola na horizontal.
- **Rodapé:** homenagem com curiosidade e fonte; Aviso; "Aviso legal completo"; "Código-fonte no GitHub"; "Licença AGPL-3.0".
- **Fontes:** Instrument Serif, Geist, JetBrains Mono, mais até 2 fontes de época por página, todas auto-hospedadas e com licença OFL verificada.

**Textos fixos (copiar literalmente):**
- **Aviso:** "open-auri não é oficial nem endossado pela Kuba, pela TTGK, pela Savitech ou por qualquer fabricante. Tudo aqui foi obtido por estudo do protocolo para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição."
- **EM BREVE:** "Liberado assim que o fone chegar à bancada de testes. Até lá não gravamos nada que a página original da Kuba não grave."
- **EM BREVE com servidor:** não se aplica mais (há backend).
- **Confirmação experimental:** "Esta curva usa tipos que a página oficial nunca gravou. Os coeficientes estão dentro do envelope observado, mas o firmware nunca recebeu esses formatos."
- **Aviso de flash (a partir de 50/dia):** "A memória do cabo tem vida útil desconhecida; memórias desse tipo costumam aguentar de 10 mil a 1 milhão de gravações."
- **Aviso de loudness:** "A nova curva pode soar mais alta. Abaixe o volume antes de gravar."

| Rota | Página | Homenagem | Acento | Fonte do mock |
|---|---|---|---|---|
| `/` | Curva | Bob Moog | `#FF7A2F` | `D:\git\open-auri\design\mocks\v2\curva.html` |
| `/biblioteca` | Biblioteca | Geoff Emerick | `#D9A441` | `D:\git\open-auri\design\mocks\v2\biblioteca.html` |
| `/comparar` | Comparar | Les Paul | `#F2B33D` | `D:\git\open-auri\design\mocks\v2\comparar.html` |
| `/soe-como-x` | Soe como X | Andy Hildebrand | `#FF3D8B` | `D:\git\open-auri\design\mocks\v2\soe-como-x.html` |
| `/comunidade` | Comunidade | Bob Clearmountain | `#3DDC97` | `D:\git\open-auri\design\mocks\v2\comunidade.html` |
| `/teste-cego` | Teste cego | Floyd Toole e Sean Olive | `#FFD27A` | `D:\git\open-auri\design\mocks\v2\teste-cego.html` |
| `/cabo` | Cabo | Ray Dolby | `#4FD1C5` | `D:\git\open-auri\design\mocks\v2\cabo.html` |
| `/docs` (+ `/privacidade`, `/termos`) | Docs | Harry Nyquist | `#8C2F2F` sobre papel (tinta `#DEA6A0` no chrome) | `D:\git\open-auri\design\mocks\v2\docs.html` |
| `/c/[id]` | Curva compartilhada | Geoff Emerick (ficha da Biblioteca) | `#D9A441` | ficha de `biblioteca.html` |
| `/u/[apelido]` | Perfil público | Chris Lord-Alge (coleção assinada) | definir no T4.11 | novo, linguagem do console |
| `/entrar`, `/criar-conta`, `/verificar-email`, `/esqueci-senha`, `/redefinir-senha`, `/conta/**` | Login e conta | Rupert Neve (canal de console) | definir no T3.6 | novo |
| `/admin/**` | Administração | sem homenagem (ferramenta interna) | chrome neutro | novo |

**Marcas proibidas como branding:** Moog, Minimoog, EMI, Abbey Road, Beatles, Ampex, Gibson, Antares, Auto-Tune, SSL/Solid State Logic, Harman (fora do rótulo oficial do preset "Harman IE 2019"), JBL, Samsung, Dolby (incluindo o duplo D), Bell, AT&T, Exxon, Yamaha, Apogee, Neve, Waves e o logo da Kuba. Os nomes dos homenageados aparecem só em texto.

**Curiosidades:** as dos 8 homenageados já verificados estão nos mocks, com fontes. Neve e Lord-Alge são verificados no PF3 e no PF4.

### 3.5 i18n e texto

- **Locales:** pt-BR (base) e en-US, com Paraglide JS 2. Estratégia `["cookie", "localStorage", "preferredLanguage", "baseLocale"]`, cookie `oa_lang`.
- **Números:** pt-BR usa vírgula decimal e en-US usa ponto. Sinal de menos real "−".
- **Sem travessão (—) no texto pt-BR.** Sem "Honest note:" e sem "Just X. Just Y.".
- **E-mails transacionais:** nos dois idiomas, conforme o idioma da conta.

### 3.6 Áudio e medição fiel

- **Motor:** porta definitiva do bloco `audio-loader v1` dos mocks.
  - IndexedDB, `HTMLAudioElement` em streaming e `AudioContext({ sampleRate: 96000 })`. Se o navegador recusar, usa a taxa do dispositivo, recalcula os coeficientes e exibe nota de prévia aproximada.
  - Cadeias `IIRFilterNode` com os coeficientes Q27 exatos, depois o preamp Q23, depois o volume da prévia (padrão −6 dB, decisão do PO em 2026-10-17; a escolha do usuário persiste em `oa.audio.volume`).
  - Uma fonte distribuída em cadeias paralelas, com troca por ganho e nível igualado por `levelDb`.
- **Medição em AudioWorklet** (`web\src\lib\audio\meter-processor.js`), usando o DSP puro de `D:\git\open-auri\src\meter\`:
  - **VU** com balística IEC 60268-17 (subida a 99% em 300 ms; overshoot no limite da norma);
  - **PPM** tipo I e tipo II (IEC 60268-10);
  - **true peak** pela ITU-R BS.1770 anexo 2 (sobreamostragem até ≥ 192 kHz efetivos);
  - **loudness momentânea e de curto prazo** (BS.1770 com ponderação K recalculada para a taxa real);
  - **correlação estéreo** (janela documentada).
  - Referência de alinhamento selecionável: 0 VU = −18 dBFS (EBU R68, padrão), −20 dBFS (SMPTE RP155) ou −14 dBFS.
  - As constantes são conferidas em fonte primária no PF2.
- **Ligações por página:**
  - **Curva:** VU de saída; LEDs de pico interno por estágio, com tap após cada seção; espectro ao vivo no osciloscópio.
  - **Biblioteca:** VUs L/R, PPM, loudness momentânea e correlação reais. Em repouso, modo DADOS.
  - **Comparar:** um VU por pista armada, com cadeias paralelas.
  - **Comunidade:** LEDs por canal com a cadeia do canal.
  - **Teste cego:** nível por candidato.
  - **Soe como X:** VU A/B e espectro.
  - **Cabo:** modo dados (calibração do checklist).
  - **Docs:** sem medidores.
- **Modos:** "AO VIVO" quando há áudio passando pela cadeia, "DADOS" em repouso. O rótulo do modo fica sempre visível.
- **Reduced motion:** os ponteiros sem animação mostram o valor numérico atualizado a 10 Hz.

### 3.7 Login, conta e social

- **Login opcional** com e-mail + senha e verificação de e-mail obrigatória para qualquer ação social.
  - Turnstile em cadastro, entrada, recuperação, troca de e-mail, denúncia e envio S6.
  - Rate limit por rota.
- **Apelido público** (`/u/[apelido]`): o único nome exibido publicamente (rankings, feed, créditos, compartilhamentos, perfil e público das curvas).
  - Único, de 3 a 24 caracteres (letras, dígitos, `.`, `_`, `-`).
  - Unicidade calculada após NFKC e esqueleto de confundíveis (UTS #39).
  - Lista de reservados: `admin`, `open-auri`, `kuba`, `auri`, nomes dos homenageados e termos de sistema.
  - Troca permitida a cada 30 dias. O apelido antigo fica reservado por 90 dias e redireciona para o novo.
- **Página pública da biblioteca** (opt-in por `library_visibility`, privada por padrão).
  - Ligada: `/u/[apelido]` mostra as criações públicas e os packs públicos do usuário, e também os favoritos se `activity_visibility` for pública.
  - Desligada: o perfil mostra só o apelido e contagens agregadas.
  - Em qualquer caso, as curvas públicas continuam acessíveis individualmente, creditadas ao apelido.
- **Biblioteca pessoal:**
  - criações (rascunho privado, não listado ou público);
  - favoritos;
  - instaladas (sincronizadas do diário quando a gravação é real);
  - packs;
  - mesclagem da biblioteca local (anônima) ao entrar, sem duplicar.
- **Publicação:**
  - S5 + S1 validados;
  - gate no servidor com os mesmos códigos de motivo do navegador;
  - licença CC0 ou CC-BY 4.0;
  - versões só por acréscimo (Total Recall), forks e retirada por lápide.
- **Compartilhamentos:** link `/c/[id]?s=<shareId>`, imagem OG gerada no servidor, QR (S8).
  - O funil por compartilhamento conta aberturas, prévias, instalações e favoritos.
  - Aberturas anônimas entram só como contagem agregada por dia, sem identidade.
- **Rastreio:**
  - "experimentou" = prévia audível de pelo menos 10 s;
  - "instalou" = gravação real bem-sucedida no cabo;
  - "favoritou".
  - Contagens públicas por usuários distintos verificados.
  - A lista nominal só inclui usuários com `activity_visibility = 'public'` (opt-in, padrão privado). Os demais aparecem como "N pessoas com perfil privado".
  - O usuário vê e apaga o próprio histórico.
- **Rankings:**
  - métricas: mais favoritadas e mais instaladas;
  - janelas: 7 dias, 30 dias e sempre;
  - escopo: só curvas públicas, listadas e aprovadas no gate;
  - desempate: pontuação, atividade recente, id.
- **Moderação:**
  - denúncias, com ocultação automática quando 3 contas verificadas distintas com 3 dias ou mais de idade denunciam;
  - fila no `/admin`, banimento e registro de auditoria.
- **S6:** lote anônimo (sem conta e sem IP) com consentimento explícito (LGPD art. 11) e recibo local para retirada. Agregação Bradley–Terry vira "Comunidade prefere".
- **S7:** usuários logados, pareamento assíncrono, prévia no navegador, revelação depois que os dois dão nota, expiração em 72 h.

### 3.8 LGPD e segurança

- **IP e registros de acesso (Marco Civil, decisão: cumprir o art. 15):**
  - **O que se guarda:** registros de acesso à aplicação, um por requisição dinâmica atendida pelo Worker. Os arquivos estáticos servidos direto pela CDN não passam pela aplicação.
  - **Campos:** IP, data e hora com fuso, porta de origem quando disponível (CGNAT), `user_id` se logado e grupo de rota (sem query string).
  - **Retenção:** 6 meses, cifrados (AES-GCM com `ACCESS_LOG_KEY`).
  - **Uso:** nenhuma outra finalidade. Entregues só por ordem judicial, com cada acesso registrado na auditoria. Base legal: LGPD art. 7, II.
  - **Fora disso, não há IP em claro:** o rate limit usa HMAC(sal diário em KV, IP), apagado em até 48 h. O Better Auth roda com `advanced.ipAddress.disableIpTracking: true` e com o rate limit interno desligado (o da autenticação é o da T3.3).
  - **Pedidos de acesso do titular (art. 18, II) aos próprios registros:** atendidos pelo canal LGPD, mediante verificação de identidade. Q-LEGAL confirma o procedimento.
- **Cookies:** só os essenciais (sessão e idioma). Sem banner de consentimento; informar em `/privacidade`.
- **Páginas legais:** `/privacidade` e `/termos`, com encarregado (contato configurável) e menção ao adendo de privacidade do Turnstile.
- **Direitos do titular:** acesso (exportação JSON), correção (perfil), eliminação (encerrar conta) e portabilidade.
- **Conteúdo público CC no encerramento da conta:** o usuário escolhe entre manter anonimizado ("autor removido") ou apagar tudo. O conteúdo privado é sempre apagado.
- **Cabeçalhos:**
  - CSP com nonce;
  - HSTS;
  - `X-Content-Type-Options`;
  - `Referrer-Policy: strict-origin-when-cross-origin`;
  - `Permissions-Policy` com `hid=(self)`;
  - `frame-ancestors 'none'`;
  - COOP `same-origin`.
- **Cookies de sessão:** `Secure`, `HttpOnly`, `SameSite=Lax`.
- **Autenticação:** checagens de origem e CSRF do Better Auth, respostas uniformes para e-mail inexistente e senhas com mínimo de 10 caracteres e verificação de força.

### 3.9 Requisitos implícitos

- **Offline:** service worker com o shell do app. Presets, editor, cabo, prévias e teste cego funcionam sem rede. O social degrada com aviso.
- **Desempenho:** LCP < 2,5 s em 4G simulado nas páginas estáticas. JS inicial por rota < 250 kB gzip, sem contar fontes. Gate durante o arraste em Web Worker sem travar a UI (< 16 ms por frame no thread principal).
- **Acessibilidade:** WCAG 2.2 AA, teclado completo, foco visível, `aria` nos gráficos, `axe` sem violações sérias ou críticas.
- **Observabilidade:** logs estruturados sem dados pessoais, métricas de erro e de rejeição do gate.
- **Compatibilidade:**
  - gravação no cabo: Chrome e Edge desktop;
  - todo o resto: Firefox, Safari e mobile, em modo simulado.

---

## 4. Arquitetura e decisões técnicas

### 4.1 Opções avaliadas

| Tema | Opções | Escolha | Motivo |
|---|---|---|---|
| Frontend | Vanilla multi-página; SvelteKit 2 + Svelte 5 | SvelteKit 2 + Svelte 5 + TS + Tailwind 4 | É o stack da linhagem de design do usuário. SSR e prerender, service worker, adapter para Workers. |
| Hospedagem | Pages; Workers Static Assets | Workers Static Assets via `@sveltejs/adapter-cloudflare` | Recomendação atual da Cloudflare; assets grátis e ilimitados. |
| Auth | Better Auth; Auth.js; OpenAuth; implementação própria | Better Auth (última estável), D1 nativo (`database: env.DB`) | Cobre e-mail/senha, verificação, recuperação, troca de e-mail e senha, exclusão, sessões, rate limit, `username`, `admin`. Menos código de segurança próprio. |
| Hash de senha | scrypt padrão; `node:crypto` scrypt; PBKDF2 | Definido no PF3 por medição | Problema conhecido de CPU do scrypt em JS puro no Workers (corrigido no PR #8685). Se o CPU medido passar de 200 ms, usar `node:crypto.scryptSync` com `nodejs_compat`. |
| E-mail | Cloudflare Email Service (beta); Resend | Resend atrás de `EmailProvider` | Instrução do usuário; não está em beta; idempotência; webhooks de bounce. |
| i18n | Paraglide 2; svelte-i18n | Paraglide 2 | Oficial no `sv add` e com tree-shaking. |
| Cron | Handler `scheduled` no worker do SvelteKit; Worker separado | Worker separado `D:\git\open-auri\workers\jobs` | O adapter gera o entry; um Worker próprio isola os jobs com os mesmos bindings. |
| OG | Satori + resvg; resvg com SVG próprio; Browser Rendering | SVG determinístico próprio + `@cf-wasm/resvg` (spike no PF4; fallback Browser Rendering) | Sem Satori: o SVG sai das bandas. Nunca aceitar imagem enviada pelo usuário. |
| Solver | Port do SLSQP; otimizador próprio | Inicialização e perda do AutoEq (MIT, atribuído) + otimizador próprio com caixas e projeção no gate, em JS | Não há SLSQP confiável em JS. |
| Medições | Embutir dados do AutoEq; importação pelo usuário | **Ambos.** Um pipeline baixa o snapshot mais recente do AutoEq (tarball do último commit, com SHA registrado), extrai `measurements/**/*.csv` e `targets/*.csv` e gera pacotes compactos servidos como assets estáticos. A importação do usuário continua. | Decisão do usuário; atribuição por fonte e processo de remoção. |
| Rate limit da auth | Interno do Better Auth; próprio | Próprio (binding de rate limit com chave HMAC do IP); o interno fica desligado | O interno depende de IP em claro. |
| Linguagem | JS ESM; TS | Núcleo em JS ESM + JSDoc + `checkJs`; web e workers em TS | Mantém o núcleo existente; código novo de segurança tipado. |

### 4.2 Estrutura do repositório (após F1/F2)

```
D:\git\open-auri\
  package.json                 workspaces ["web", "workers/jobs"]; pacote "open-auri" (núcleo) com exports
  src\                         núcleo puro (JS ESM)
    dsp\eq0xcb.mjs  dsp\level.mjs  dsp\distance.mjs  dsp\iso226.mjs
    safety\gate.mjs  safety\thresholds.mjs  safety\policy.mjs
    share\s1.mjs  share\envelope.mjs
    io\equalizer-apo.mjs  io\measurement.mjs
    solver\peq.mjs
    catalog\presets.mjs
    transport\webhid.mjs  transport\fake-device.mjs
    policy\flash.mjs  policy\loudness.mjs  policy\journal.mjs
    meter\ballistics.mjs  meter\truepeak.mjs  meter\loudness.mjs  meter\correlation.mjs
    index.mjs
  schemas\preset-envelope-1.schema.json
  test\**\*.test.mjs           node:test
  tools\extract-kuba-reference.mjs  tools\gen-thresholds.mjs  tools\import-autoeq.mjs  tools\check-sensitive.mjs
  tools\render-wrangler.mjs  tools\sync-secrets.mjs  tools\deploy.mjs  tools\grant-admin.mjs  tools\access-log-query.mjs
  .env (ignorado)  .env.example (versionado)
  docs\legal\politica-de-privacidade.md  docs\legal\privacy-policy.en-US.md  docs\lgpd.md
  types\                       .d.ts gerados (tsc --emitDeclarationOnly)
  design\mocks\  design\analysis\   referência versionada (não executada nos testes)
  docs\  docs\plans\
  web\                         SvelteKit
    src\routes\…  src\lib\…  src\hooks.server.ts  src\hooks.ts  src\service-worker.ts
    messages\pt-BR.json  messages\en-US.json  messages\_staging\
    migrations\NNNN_*.sql
    static\fonts\  static\manifest.webmanifest  static\data\autoeq\ (gerado no build, ignorado pelo git)
    tests\unit\  tests\integration\  tests\e2e\  tests\fixtures\
    scripts\merge-messages.mjs  scripts\gen-fixtures.mjs
    wrangler.template.jsonc (versionado)  wrangler.jsonc e .dev.vars (gerados, ignorados)  svelte.config.js  vite.config.ts  playwright.config.ts
  workers\jobs\                Worker de cron (TS) com src\index.ts e src\jobs\*.ts
  .github\workflows\ci.yml  .github\workflows\deploy.yml
```

### 4.3 Contrato de armazenamento no navegador (produção)

| Chave | Onde | Conteúdo |
|---|---|---|
| `oa.lang` | localStorage + cookie `oa_lang` | `pt-BR` \| `en-US` |
| `oa.current` | localStorage | `{schema:1, name, source ('preset:<id>'\|'custom'\|'import'\|'community:<id>'), preampDb, bands:[{kind,freqHz,gainDb,qFactor}\|{kind:'OFF'}], updatedAt}` |
| `oa.journal` | localStorage | `[{schema:1, at, name, crc, preampDb, bands, status ('ok'\|'interrupted'\|'simulated'), device}]` (até 500 entradas, FIFO) |
| `oa.flash.day` / `oa.flash.total` / `oa.flash.lastWriteAt` | localStorage | `{date, count}` / número / epoch ms |
| `oa.flash.session` | sessionStorage | número |
| `oa.meter.ref` | localStorage | `-18` \| `-20` \| `-14` |
| `oa.audio.volume` | localStorage | inteiro em dB, −40…0 (volume da prévia no navegador; padrão −6; inválido volta ao padrão; nunca sobe sozinho) |
| `oa.tour.v1` | localStorage | `{ [pagina]: 'visto' \| 'dispensado' }` (tour guiado, FUX.3; nunca enviado; apagado por "Apagar dados locais") |
| `open-auri` | IndexedDB | stores `audio` (`current`), `library` (curvas e favoritos locais), `outbox` (eventos sociais pendentes offline) |

---

## 5. Anotações model-router

**Papéis:**

| Papel | Uso neste plano |
|---|---|
| `explorer` | Levantamentos de código e fatos no repositório |
| `researcher` | Documentação de bibliotecas e normas (context7, web) |
| `runner` | Rodar testes, build, lint, typecheck; pre-flights |
| `implementer` | Implementação e testes de cada tarefa |
| `architect` | Desenho e decisões técnicas (só leitura) |
| `reviewer` | QA sênior adversarial, sempre `[tier:heavy]` |
| `general` | Tarefas pequenas mistas (fila de integração) |

**Linha de rota:** primeira linha de todo despacho, no formato `[route class=<c> risk=<r> scope=<s> needs=<n,..> d=<d> budget=<n> root=<path>]`.
- Só passos marcados `[tier:heavy]` recebem `tier=heavy pin`. Neste plano, todos os QA e as revisões de segurança.
- Nunca definir `model` nem outro tier.

**Bloco de aceite:** toda tarefa leva `[acceptance] … [/acceptance]`. Prefira `check: testsPass` mais `criteria:` e `deliverable:`. Use `cwd:` quando houver worktree.

**VERIFY:**
- `VERIFY:required` em tarefas das quais outras dependem (está anotado);
- `deferred` nas demais.
- Antes de construir sobre um resultado `deferred` de risco médio ou alto, chamar `router_verify`.

**Retomada:**
- `NEED MORE: budget` ou nota `[router budget]`: retomar a MESMA `sessionID` com "continue and finish".
- `ESCALATE: authority`: retomar a mesma sessão.
- Verificação reprovada: retomar a mesma sessão com os achados.

**Despachos paralelos:** todos na mesma mensagem, respeitando os locks (seção 6).

**Modelo de despacho de QA (copiar):**

```
[route class=review risk=high scope=repo needs=shell tier=heavy pin]
TASK: Adversarial senior QA review of phase N (commits <start>..HEAD).
EXPECTED OUTCOME: findings list (severity critical/high/medium/low, file:line, repro, required fix) or PASS.
TOOLS: read, router_run (tests, build, lint, typecheck, e2e).
MUST DO: run the full phase test battery and coverage; try to break every acceptance criterion; check every invariant in §0.12;
  security (authz matrix, injection, XSS, CSRF, enumeration, rate-limit evasion), safety (any path that sends bytes without gate +
  checklist + gesture), spec conformance (§3), a11y, performance budgets, i18n completeness, copy rules, LGPD, docs accuracy.
MUST NOT DO: edit files; accept claims without evidence.
CONTEXT: plan D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-plano.md §<phase>; progress log.
ENVIRONMENT: (bloco padrão 0.10)
```

---

## 6. Paralelismo seguro, locks e fila de integração

1. **Conjunto de escrita (W) e de leitura (R) por tarefa.** Cada tarefa declara W (arquivos que cria ou altera) e R (arquivos que precisa ler e que outros podem estar editando). Os arquivos estáveis de fases anteriores não precisam constar em R.
2. **Regra de concorrência.** Duas tarefas só rodam juntas se:
   - (i) W₁ ∩ W₂ = ∅;
   - (ii) R₁ ∩ W₂ = ∅ e R₂ ∩ W₁ = ∅.

   Ninguém lê um arquivo que está em edição.
3. **Tabela de locks.** Antes de cada wave, o orquestrador:
   - calcula os locks a partir de W e R;
   - registra-os no progresso;
   - despacha em paralelo só o conjunto compatível.

   Uma tarefa que precise de um arquivo fora do seu W deve **parar e reportar**. Nunca editar fora do W.
4. **Barreira de wave.** A wave seguinte só começa quando todas as tarefas da atual estão verificadas e commitadas.
5. **Arquivos serializados.** Nenhuma tarefa de feature escreve nestes arquivos; eles só mudam pela **fila de integração** (uma tarefa `general` por vez, em série):
   - `D:\git\open-auri\package.json`
   - `D:\git\open-auri\package-lock.json`
   - `D:\git\open-auri\web\package.json`
   - `D:\git\open-auri\workers\jobs\package.json`
   - `D:\git\open-auri\web\wrangler.template.jsonc`
   - `D:\git\open-auri\workers\jobs\wrangler.template.jsonc`
   - `D:\git\open-auri\.env.example`
   - `D:\git\open-auri\web\svelte.config.js`
   - `D:\git\open-auri\web\vite.config.ts`
   - `D:\git\open-auri\web\project.inlang\settings.json`
   - `D:\git\open-auri\web\messages\pt-BR.json`
   - `D:\git\open-auri\web\messages\en-US.json`
   - `D:\git\open-auri\web\src\app.html`
   - `D:\git\open-auri\web\src\app.d.ts`
   - `D:\git\open-auri\workers\jobs\src\index.ts`
   - `D:\git\open-auri\docs\README.md`
   - `D:\git\open-auri\THIRD_PARTY_NOTICES.md`
6. **Mensagens i18n.** As tarefas escrevem as próprias chaves em `D:\git\open-auri\web\messages\_staging\<TASK-ID>.pt-BR.json` e `…\<TASK-ID>.en-US.json`, com o prefixo da feature (ex.: `curva_`, `conta_`). A fila roda `node D:\git\open-auri\web\scripts\merge-messages.mjs <TASK-ID>`, que:
   - mescla nos catálogos;
   - falha em chave duplicada ou ausente em um dos idiomas;
   - apaga o staging;
   - recompila o Paraglide.

   Só depois a verificação da tarefa roda.
7. **Dependências npm.** Cada fase instala no seu W1 todo o conjunto previsto. Dependências extras entram pela fila (uma por vez), com justificativa e verificação de licença.
8. **Migrações D1.** Números pré-atribuídos: 0001 auth (T3.5), 0002 e-mail (T3.2), 0003 admin/auditoria (T3.8), 0004 social, 0005 S6/S7, 0006 rankings (T4.1), 0007 registro de acesso (T3.3), 0008 política e aceites (T3.4), a partir de 0009 ajustes de QA. Cada arquivo tem um único dono. Migração aplicada nunca é editada; correções viram nova migração.
9. **Worktrees.** São opcionais para tarefas de risco alto que mexem em muitos arquivos (ex.: T1.1). Se usar, `root=<caminho absoluto>` na rota e `cwd:` no aceite. O merge é feito pelo orquestrador.
10. **Commits.** O orquestrador commita em série, logo após cada verificação, com o pathspec do W da tarefa.

---

## 7. Fases

Legenda: **W** = escreve, **R** = lê arquivos voláteis, **Dep** = depende de.

### Fase 1 · Núcleo definitivo

**Objetivo:** o núcleo `D:\git\open-auri\src\` completo, puro, tipado por JSDoc, com 95% ou mais de cobertura. É a fundação reutilizada idêntica no navegador, no Worker e nos testes.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| W1.1 | T1.1 | Serial (reestruturação) |
| W1.2 | T1.2, T1.3, T1.4, T1.5, T1.6, T1.7, T1.8, T1.9, T1.10, T1.11 | Paralelo (W disjuntos) |
| W1.3 | T1.12 | Serial (depende do gate, de ISO 226 e das medições) |
| W1.4 | T1.13 → T1.T | Serial |
| QA | Q1 `[tier:heavy]` → FX1.k → Q1 | 2 rodadas completas; depois só major, critical e blocking (0.5) |

#### PF1 · Pre-flight da Fase 1

`[route class=recon risk=low scope=repo needs=shell]` · papel `runner`

1. `git status` limpo, exceto `D:\git\open-auri\design\` (não versionado, entra no T1.1). Registrar o HEAD (6f040d1 ou posterior).
2. `node --version` ≥ 22.12 e `npm --version`. Registrar.
3. Linha de base: `npm test` verde. Registrar o número de testes, incluindo os 53 de `D:\git\open-auri\design\analysis\gate.test.mjs`.
4. `node D:\git\open-auri\design\analysis\qa-parity.mjs` verde (sem `--browser`).
5. Criar `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-progresso.md` (orquestrador) com a tabela de tarefas e locks.
6. Verificar via `researcher`:
   - as flags de cobertura do `node:test` (`--experimental-test-coverage`, `--test-coverage-lines` e afins);
   - a licença e a versão do `fast-check` (testes de propriedade).
7. Mapa de locks da F1 calculado e sem conflitos.
8. `npm run check:sensitive` sem achados. Esta checagem se repete em todo PF, antes de todo commit e antes de todo push.

**Aprovação:** todos os itens OK.

#### T1.1 · Reestruturação do repositório e tooling (serial)

`[route class=implement risk=high scope=repo needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\package.json`
- `D:\git\open-auri\package-lock.json`
- `D:\git\open-auri\jsconfig.json`
- `D:\git\open-auri\eslint.config.js`
- `D:\git\open-auri\.prettierrc.json`
- `D:\git\open-auri\.editorconfig`
- `D:\git\open-auri\.gitignore`
- `D:\git\open-auri\design\**` (versionar)
- `D:\git\open-auri\docs\README.md`

**Subtarefas:**
1. `package.json` raiz:
   - `"workspaces"`: comece vazio (`[]`). A T2.1 adiciona `"web"` e a T3.1 adiciona `"workers/jobs"`, cada uma no momento em que cria a pasta, porque o npm falha com workspaces inexistentes;
   - `exports` com subpaths (`./dsp`, `./safety`, `./share`, `./io`, `./solver`, `./catalog`, `./transport`, `./policy`, `./meter`);
   - scripts `test` = `node --test "test/**/*.test.mjs"`, `test:coverage` (limites de 95% em linhas, branches e funções), `lint`, `format:check`, `typecheck` (= `tsc -p jsconfig.json --noEmit`), `types` (emitir `D:\git\open-auri\types\`), scripts de teste por área (0.19: `test:dsp`, `test:safety`, `test:share`, `test:io`, `test:solver`, `test:transport`, `test:policy`, `test:meter`, `test:catalog`, todos com `--test-concurrency`) e manter o `check:sensitive` (já existe);
   - devDeps: `typescript`, `eslint`, `@eslint/js`, `globals`, `prettier`, `fast-check`.
2. `jsconfig.json` com `checkJs`, `strict`, `module NodeNext`.
3. `.gitignore`: `.svelte-kit`, `.wrangler`, `.dev.vars`, `coverage`, `playwright-report`, `test-results`. As capturas de `D:\git\open-auri\design\mocks\v2\_qa\` são versionadas como referência visual.
4. Versionar `D:\git\open-auri\design\mocks\` e `D:\git\open-auri\design\analysis\` (scripts e resultados). Os testes dessa pasta deixam de ser descobertos pelo `npm test`, que roda só `test\`.
5. Atualizar `D:\git\open-auri\docs\README.md` com o índice dos módulos novos (marcados "em construção" até o T1.13).

**Testes:** `npm test` verde, com os 52 testes existentes; `npm run lint`, `npm run typecheck` e `npm run format:check` limpos.

```
[acceptance]
check: testsPass
check: lintClean
criteria: workspaces/exports configured; npm test discovers only test/**; design/ versioned; typecheck clean on existing src
deliverable: D:\git\open-auri\package.json and tooling configs
[/acceptance]
```

#### T1.2 · Gate v2 e política de segurança no núcleo

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\src\safety\gate.mjs`
- `D:\git\open-auri\src\safety\thresholds.mjs`
- `D:\git\open-auri\src\safety\policy.mjs`
- `D:\git\open-auri\tools\gen-thresholds.mjs`
- `D:\git\open-auri\test\safety\gate.test.mjs`
- `D:\git\open-auri\test\safety\policy.test.mjs`

**R:** `D:\git\open-auri\design\analysis\gate.mjs`, `D:\git\open-auri\design\analysis\envelope.json`, `D:\git\open-auri\design\analysis\limites-v2.json`

**Subtarefas:**
1. Portar `gate()` com a mesma matemática e a mesma ordem de somas.
   - Expor: `gate(bands, preampDb, {experimental?: boolean, grid?: 'drag'|'full'})` → `{ok, reasons[], metrics}`, além de `levelDb`, `autoPreamp` e `sectionAnalysis`.
   - Os códigos de motivo são estáveis (`a:b0`, `b:pole-radius`, `c:section-peak`, `d:prefix-peak`, `e:output-audible`, `e:output-full`, `f:codec`, `g:preamp`, `k:kind-not-allowed`, `d7:pk-boost-above-16k`, `d7:boost-q`).
   - Mensagens pt-BR e en-US ficam na camada de UI, não no núcleo.
2. `thresholds.mjs` é gerado por `tools\gen-thresholds.mjs` a partir de `envelope.json`. Inclui proveniência (SHA-256 da fonte) e um teste que compara com a fonte. Sem `import … with {type:'json'}`, para compatibilidade com Workers.
3. `policy.mjs`:
   - faixas suaves e absolutas;
   - tipos por camada (`ouvir`, `ajustar`: PK/LS/OFF; `engenharia`: mais HS/LP/HP com `experimental: true`);
   - D7 (PK de reforço acima de 16 kHz recusado; Q de reforço ≤ 4);
   - grade de arredondamento;
   - `boundarySearch(from, to, predicate, iterations=24)`, puro, para o arraste.
4. Desempenho: modo `drag` com grade de 2 048 pontos e `full` com 16 384. Teste garantindo que o veredito `full` prevalece.

**Testes (mínimo):**
- os 11 presets passam;
- os 11 invertidos falham em `d`;
- 8/11 ordenados por frequência falham;
- contraexemplo "cortes primeiro mas 11,49 dB" falha;
- Neutro passa com CRC 0x4FFF;
- HP 30 Hz Q 0,5 passa e HP 20–25 Hz falha em `b2`;
- HS reforço +4,52 dB em 20 kHz Q 0,1 na fronteira `b0`;
- PK +12 dB Q 4 com preamp −12,6 dB falha só em `c`;
- propriedade (`fast-check`): `gate.ok ⇒ encodePayload` não lança erro e os coeficientes estão dentro de `a`;
- `boundarySearch` monotônico e o resultado sempre aceito.

```
[acceptance]
check: testsPass
criteria: gate parity with design/analysis/gate.mjs on all 126 analytic cases + 11 presets; thresholds generated and tested; D7 and layer kinds enforced
deliverable: D:\git\open-auri\src\safety\*.mjs
[/acceptance]
```

#### T1.3 · Formato S1 v1 congelado

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\src\share\s1.mjs`
- `D:\git\open-auri\docs\s1-format.md`
- `D:\git\open-auri\test\share\s1.test.mjs`

**R:** `D:\git\open-auri\docs\social.md`

**Requisitos do formato (a tarefa define o layout de bits e documenta):**
1. Versão + variante.
2. Tipos PK/LS/HS/LP/HP/OFF (3 bits).
3. **Sem perda** para qualquer valor da grade da UI: f inteiro de 1 a 20 000 Hz, ganho em passos de 0,1 dB entre −25,6 e +12,7 dB, Q em passos de 0,01 entre 0,01 e 20,47, preamp em passos de 0,1 dB entre 0 e −25,5 dB. Isso inclui os 11 presets oficiais exatos.
4. Ordem do fio preservada (o gate depende da ordem).
5. CRC.
6. base64url sem padding.

O tamanho resultante (≈ 51 B / 68 caracteres) é documentado.

**Outras subtarefas:**
- `canonKey(bands, preamp)` (forma ordenada para deduplicação e similaridade) e `curveId(s1)` (base32 de SHA-256 do S1 da ordem do fio, 12 caracteres, via WebCrypto `subtle.digest`, assíncrono).
- Atualizar a referência em `D:\git\open-auri\docs\social.md`: S1 de 48 B / 64 caracteres passa a ser S1 v1 conforme `D:\git\open-auri\docs\s1-format.md`.

**Testes:**
- ida e volta dos 11 presets e do Neutro, byte a byte no payload;
- propriedade (`fast-check`) de ida e volta na grade;
- casos de borda: versão desconhecida, CRC inválido, truncado, caracteres fora do base64url, tipo inválido, valores fora da grade (recusa, nunca arredondamento silencioso), 10 bandas obrigatórias;
- `curveId` estável e diferente para ordens diferentes;
- `canonKey` igual para permutações.

```
[acceptance]
check: testsPass
criteria: lossless on UI grid and official presets; wire order preserved; documented layout; social.md updated
deliverable: D:\git\open-auri\src\share\s1.mjs, D:\git\open-auri\docs\s1-format.md
[/acceptance]
```

#### T1.4 · Envelope S5 e JSON Schema

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`

**W:**
- `D:\git\open-auri\src\share\envelope.mjs`
- `D:\git\open-auri\schemas\preset-envelope-1.schema.json`
- `D:\git\open-auri\test\share\envelope.test.mjs`

**Subtarefas:**
1. Formato `open-auri/preset@1`: `name` ≤ 48, `description` ≤ 280, `author`, `source`, `license ∈ {CC0-1.0, CC-BY-4.0}`, `code` (S1), `preampDb`, `bands`, `recipe` estruturada (`measurement`, `target`, `solver`, `params`), `lang`, `createdAt`.
2. Validador sem dependências pesadas (validação manual alinhada ao schema e testada contra ele).
3. Normalização de texto: NFKC; remoção de bidi e de largura zero; recusa de URLs no texto livre.

**Testes:** válidos e inválidos por campo, limites de tamanho, Unicode malicioso, `code` incoerente com as bandas (recusa).

```
[acceptance]
check: testsPass
criteria: envelope validate/normalize/serialize; schema matches validator on a shared corpus
deliverable: D:\git\open-auri\src\share\envelope.mjs, D:\git\open-auri\schemas\preset-envelope-1.schema.json
[/acceptance]
```

#### T1.5 · Importação e exportação EqualizerAPO / AutoEq `.txt`

`[route class=implement risk=medium scope=single needs=edit,shell]` · `implementer`

**W:** `D:\git\open-auri\src\io\equalizer-apo.mjs`, `D:\git\open-auri\test\io\equalizer-apo.test.mjs`

**Regras:**
- `Preamp:`;
- `Filter N: ON|OFF <tipo> Fc <f> Hz Gain <g> dB Q <q>`;
- mapeamentos PK, LSC→LS, HSC→HS, LS/HS (Q padrão 0,7071 quando não há Q), LPQ/LP→LP, HPQ/HP→HP;
- LSQ e HSQ recusados com motivo;
- mais de 10 filtros: recusa com motivo (o solver pode reduzir em C1);
- vírgula ou ponto decimal, CRLF, BOM, comentários `#`, linhas desconhecidas reportadas.

Exportação nos mesmos tipos (HS→HSC, LP→LPQ, HP→HPQ).

**Testes:** corpus com arquivos reais típicos (escritos à mão), ida e volta, todos os erros com mensagens estáveis.

```
[acceptance]
check: testsPass
criteria: deterministic parse/serialize with explicit mappings and refusals
deliverable: D:\git\open-auri\src\io\equalizer-apo.mjs
[/acceptance]
```

#### T1.6 · Importação de medições e alvos

`[route class=implement risk=medium scope=single needs=edit,shell]` · `implementer`

**W:** `D:\git\open-auri\src\io\measurement.mjs`, `D:\git\open-auri\test\io\measurement.test.mjs`

**Subtarefas:**
1. CSV no formato AutoEq (`frequency,raw[,…]`) e TXT do REW (frequência, SPL, fase).
2. Detecção de separador e de decimal.
3. Reamostragem para a grade logarítmica de 20 Hz a 20 kHz (481 pontos) com interpolação em log-frequência.
4. Normalização em 1 kHz ou pela média entre 300 Hz e 3 kHz.
5. Suavização fracionária de oitava opcional (1/3, 1/6, 1/12).

**Testes:** arquivos válidos e inválidos, valores não finitos, frequências desordenadas ou duplicadas, cobertura parcial da banda (erro claro).

```
[acceptance]
check: testsPass
criteria: robust import to a canonical log grid with explicit errors
deliverable: D:\git\open-auri\src\io\measurement.mjs
[/acceptance]
```

#### T1.7 · Nível, distância e ISO 226

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`

**W:**
- `D:\git\open-auri\src\dsp\level.mjs`
- `D:\git\open-auri\src\dsp\distance.mjs`
- `D:\git\open-auri\src\dsp\iso226.mjs`
- `D:\git\open-auri\test\dsp\level.test.mjs`
- `D:\git\open-auri\test\dsp\distance.test.mjs`
- `D:\git\open-auri\test\dsp\iso226.test.mjs`

**Subtarefas:**
1. `levelDb` (método da Kuba: média de 93 pontos entre 300 Hz e 3 kHz, Q27/Q23), igual ao `gate.mjs` da análise.
2. S4: `distance(a, b)` retorna RMS, máximo com sua frequência e as bandas onde as curvas diferem acima de um limiar.
3. ISO 226:2003: contornos de igual loudness (tabela da norma), curvas de compensação de loudness para C5 (nível de escuta de referência × nível real) e pesos perceptuais para D4 e D6.

**Testes:**
- `levelDb` dos 11 presets igual à matriz de `D:\git\open-auri\design\analysis\limites-v2.md` (seção 7, tolerância 1e-9);
- valores da tabela ISO 226 em frequências de referência;
- simetria e desigualdade triangular aproximada da distância.

```
[acceptance]
check: testsPass
criteria: levelDb parity with analysis matrix; ISO 226 contour values within published tolerance; S4 metrics
deliverable: D:\git\open-auri\src\dsp\level.mjs, distance.mjs, iso226.mjs
[/acceptance]
```

#### T1.8 · Catálogo oficial e Neutro

`[route class=implement risk=high scope=single needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\src\catalog\presets.mjs`, `D:\git\open-auri\test\catalog\presets.test.mjs`

**Conteúdo:**
- **Os 11 presets do fixture,** com rótulos, descrições (atribuídas como "descrição da Kuba"), grupos e ordem oficial:
  - preferência: Auri, Natural, Em V, Basshead, Enérgico, Musical, Analítico;
  - referência: JM-1, Harman IE 2019, VDSF, Etymotic.
  - Também `licenseStatus: 'a confirmar'` (Q-KUBA-LIC).
- **`NEUTRO`** (10 × OFF, −0,5 dB) e **`PADRAO_AURI`** = `padrao`.
- **Crédito:** "filtros do Leonardo (segundo comentário no código da página oficial)".

**Testes:** payload e reports byte a byte iguais ao fixture para os 11; CRCs (`padrao` 0x1970, `pref6` 0x85B8, `emv` 0x14A9, `basshead` 0x932B, `energico` 0xBE4E, `musical` 0x7EA6, `analitico` 0x836C, `referencia` 0xEC19, `harman` 0xC738, `vdsf` 0x5C6A, `etymotic` 0xB68E); Neutro 0x4FFF; todos passam no gate.

```
[acceptance]
check: testsPass
criteria: byte-identical official presets and labels/order; Neutro CRC 0x4FFF
deliverable: D:\git\open-auri\src\catalog\presets.mjs
[/acceptance]
```

#### T1.9 · Transporte WebHID e dispositivo simulado

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\src\transport\webhid.mjs`
- `D:\git\open-auri\src\transport\fake-device.mjs`
- `D:\git\open-auri\test\transport\webhid.test.mjs`

**Subtarefas:**
1. `requestCable(hid)` com filtros VID/PID.
2. `writeCurve(device, bands, preampDb, {gate, signal, clock})`:
   - revalida com o gate;
   - envia os 9 reports com 16 ms, espera 150 ms, envia o commit;
   - aceita `AbortSignal`;
   - trata desconexão (`disconnect` durante o envio resulta em `status: 'interrupted'`);
   - um mutex por dispositivo impede gravação concorrente;
   - devolve `{crc, startedAt, finishedAt, reports}`.
3. `writeMany(devices, …)` em sequência, com intervalo mínimo de 2 s.
4. `fake-device.mjs`: um `HIDDevice` simulado que registra reports e tempos, injeta falhas (desconectar no report k, lançar erro em `sendReport`, atrasar) e funciona em Node e no navegador.

**Testes:**
- bytes enviados iguais a `encodeReports` + `commitReport` para os 11 presets;
- tempos dentro de ±5 ms no relógio falso;
- recusa sem gate aprovado (nunca envia nada);
- desconexão em cada índice de 0 a 9 resulta em `interrupted` e nenhum commit;
- concorrência recusada;
- `writeMany` sequencial com falha no meio.

```
[acceptance]
check: testsPass
criteria: exact bytes and timing; gate enforced inside transport; interruption and concurrency handled
deliverable: D:\git\open-auri\src\transport\webhid.mjs, fake-device.mjs
[/acceptance]
```

#### T1.10 · Políticas: flash, loudness e diário

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`

**W:**
- `D:\git\open-auri\src\policy\flash.mjs`
- `D:\git\open-auri\src\policy\loudness.mjs`
- `D:\git\open-auri\src\policy\journal.mjs`
- `D:\git\open-auri\test\policy\*.test.mjs`

**Subtarefas:**
1. **Flash:** pode gravar agora? (2 s desde `lastWriteAt`); contadores de sessão, dia (virada à meia-noite local) e total; aviso a partir de 50 no dia; sem limite rígido.
2. **Loudness:** aviso se `levelDb(novo) − levelDb(último gravado) ≥ 3` ou se o estado do cabo é desconhecido (primeira gravação da sessão, ou o diário tem entrada `interrupted` como última).
3. **Diário:** esquema (4.3), FIFO de 500 entradas, serialização e validação.

**Testes:** virada de dia, relógio retrocedendo, armazenamento corrompido (recupera com valores seguros), limiar exato de 3,0 dB, última gravação interrompida.

```
[acceptance]
check: testsPass
criteria: pure policies with clock injection and corruption-safe parsing
deliverable: D:\git\open-auri\src\policy\*.mjs
[/acceptance]
```

#### T1.11 · DSP de medição fiel

`[route class=implement risk=high scope=multi needs=edit,shell,web]` · `implementer` (o PF1 já verificou as fontes; a tarefa cita as constantes com referência)

**W:**
- `D:\git\open-auri\src\meter\ballistics.mjs`
- `D:\git\open-auri\src\meter\truepeak.mjs`
- `D:\git\open-auri\src\meter\loudness.mjs`
- `D:\git\open-auri\src\meter\correlation.mjs`
- `D:\git\open-auri\test\meter\*.test.mjs`

**Subtarefas:**
1. **VU** (IEC 60268-17): modelo de 2ª ordem sobre o sinal retificado, com a subida a 99% em 300 ms e o overshoot dentro da norma.
2. **PPM** tipo I e tipo II (IEC 60268-10): integração e retorno conforme a norma.
3. **True peak** (BS.1770 anexo 2): FIR polifásico de 4 fases a 48 kHz; a 96 kHz, 2× para ≥ 192 kHz efetivos.
4. **Loudness:** ponderação K derivada dos protótipos analógicos para qualquer taxa (alinhada à BS.1770 a 48 kHz); momentânea de 400 ms e curto prazo de 3 s.
5. **Correlação:** normalizada em [−1, +1], janela exponencial documentada.
6. **Interface:** processamento por blocos de 128 amostras, estado serializável e sem alocação por bloco.

Constantes com citação da fonte no código. Onde a norma for paga, a referência secundária usada é citada; registrar no progresso.

**Testes:**
- seno de 1 kHz a −18 dBFS dá 0 VU (referência −18), com tolerância ±0,1;
- resposta ao degrau do VU (99% em 300 ms ± 10%, overshoot no limite);
- PPM: rajadas de 5 e 10 ms e decaimento;
- true peak em seno a fs/4 com fase de pico entre amostras (> pico amostral);
- loudness: sinais de conformidade da EBU Tech 3341 gerados sinteticamente (seno de 1 kHz a −23 dBFS dá −23,0 LUFS-M ± 0,1, 2 canais conforme a norma);
- correlação: mono +1, invertido −1, ruídos independentes ≈ 0;
- silêncio sem NaN ou −Infinity (piso documentado).

```
[acceptance]
check: testsPass
criteria: standards-conformant meters on synthetic test signals; sources cited; no allocations per block
deliverable: D:\git\open-auri\src\meter\*.mjs
[/acceptance]
```

#### T1.12 · Solver PEQ (C1, C2, D4, D5)

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T1.2, T1.6, T1.7

**W:** `D:\git\open-auri\src\solver\peq.mjs`, `D:\git\open-auri\test\solver\peq.test.mjs`, `D:\git\open-auri\THIRD_PARTY_NOTICES.md` (pela fila de integração)

**Subtarefas:**
1. **Inicialização e perda do AutoEq** (`autoeq/peq.py`, MIT, com atribuição):
   - inicialização pelo maior pico ou vale (largura × altura);
   - shelves pela razão de nível entre 40 Hz e 10 kHz;
   - RMSE de 20 Hz a 20 kHz com média acima de 10 kHz e penalidade de nitidez.
2. **Otimizador próprio** com caixas e projeção, por exemplo coordenadas com busca de linha, ou Levenberg–Marquardt com caixas sobre (log f, Q, ganho):
   - cada candidato é projetado no gate pela busca de fronteira;
   - pesos ISO 226 (D4);
   - penalidade para bandas opostas vizinhas (D5);
   - "velocidade de correção" (0–100) como regularização;
   - critérios de parada: tempo máximo, perda-alvo, taxa mínima de melhora.
3. **Saída:** sempre 10 seções PK/LS/OFF (HS só com `allowExperimental` e camada Engenharia), ordem padrão com cortes antes de reforços, preamp automático, `gate.ok === true`.
4. **C2:** alvo desenhado (spline monotônica em log f) entra no mesmo solver.

**Testes:**
- alvo plano resulta em todas as seções OFF ou de ganho mínimo;
- alvos sintéticos reproduzidos com RMS < 0,5 dB;
- cada preset oficial usado como alvo (partindo do Neutro) com RMS < 1 dB;
- determinismo com semente fixa;
- tempo < 1,5 s em CI para 481 pontos;
- o resultado sempre passa no gate (propriedade com alvos aleatórios);
- D5 reduz vizinhos opostos.

```
[acceptance]
check: testsPass
criteria: gate-feasible results always; accuracy and time budgets met; MIT attribution recorded
deliverable: D:\git\open-auri\src\solver\peq.mjs
[/acceptance]
```

#### T1.13 · Integração do núcleo

`[route class=mechanical risk=medium scope=repo needs=edit,shell]` · `general` (fila de integração) · VERIFY:required

**W:** `D:\git\open-auri\src\index.mjs`, `D:\git\open-auri\package.json`, `D:\git\open-auri\types\**`, `D:\git\open-auri\docs\README.md`, `D:\git\open-auri\THIRD_PARTY_NOTICES.md`

**Subtarefas:** API pública (`index.mjs` e exports), `npm run types` gerando os `.d.ts`, índice da documentação, atribuições.

```
[acceptance]
check: testsPass
check: lintClean
criteria: all modules exported; types emitted; docs index updated
deliverable: D:\git\open-auri\src\index.mjs and D:\git\open-auri\types\
[/acceptance]
```

#### T1.T · Bateria de testes da Fase 1

`[route class=implement risk=medium scope=repo needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\test\integration\core-pipeline.test.mjs`, `D:\git\open-auri\test\integration\fuzz.test.mjs`

**Casos:**
- **Pipelines ponta a ponta:**
  - `.txt` → bandas → gate → S1 → envelope → payload → transporte falso → diário;
  - medição + alvo → solver → gate → S1;
  - medidores sobre a saída simulada do IIR.
- **Fuzz (`fast-check`, 1 000 casos ou mais):** S1, envelope, `.txt` e gate não quebram com entradas arbitrárias e nunca aprovam bytes fora de `a`/`b`.
- **Regressões dos bugs encontrados.**
- **Cobertura:** `npm run test:coverage` com 95% ou mais em linhas, branches e funções para `D:\git\open-auri\src\**`.

```
[acceptance]
check: testsPass
check: run command="npm run test:coverage" expect="pass"
criteria: ≥95% lines/branches/functions on src/**; fuzz and e2e core pipelines green
deliverable: phase 1 test battery
[/acceptance]
```

#### Critérios de aceite da Fase 1

1. Todos os módulos da seção 4.2 existem, são puros (sem DOM e sem I/O, exceto o transporte, que recebe o dispositivo injetado) e passam em typecheck, lint e format.
2. Paridade do gate com a análise, presets byte a byte iguais, Neutro 0x4FFF e S1 sem perda.
3. O transporte nunca envia nada sem gate aprovado e trata interrupções.
4. Os medidores passam nos sinais de teste das normas.
5. O solver sempre devolve curvas aprovadas no gate.
6. Cobertura de 95% ou mais.

#### Definition of Done da Fase 1

PF1 aprovado · todas as tarefas verificadas e commitadas · T1.T verde · Q1 aprovado conforme 0.5 · progresso atualizado · documentação atualizada (`D:\git\open-auri\docs\s1-format.md`, `D:\git\open-auri\docs\README.md`, `D:\git\open-auri\docs\social.md`) · nenhum `TODO` fora da seção 13.

#### Q1 · QA sênior adversarial da Fase 1 `[tier:heavy]`

`[route class=review risk=high scope=repo needs=shell tier=heavy pin]` · `reviewer`

**Foco:**
- tentar burlar o gate (NaN, −0, subnormais, ordem, preamp no limite, quantização na fronteira);
- S1 com colisões e entradas malformadas;
- transporte com corridas e tempos;
- medidores contra a norma;
- solver gerando curva reprovada;
- cobertura real (asserts que não testam nada).

Achados viram FX1.k (implementer) e o Q1 roda de novo conforme 0.5.

---

### Fase 2 · Aplicação web completa (local-first)

**Objetivo:** produto web completo para uso local, com todas as páginas exceto Comunidade, sem depender do backend: editor, biblioteca local, comparação, solver, teste cego, cabo, docs, áudio, medidores fiéis e PWA.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| W2.1 | T2.1 | Serial (scaffold e dependências) |
| W2.2 | T2.2, T2.3, T2.4, T2.5, T2.6, T2.7, T2.8, T2.19 | Paralelo |
| W2.3 | T2.9 | Serial (layout integra o chrome) |
| W2.4 | T2.10, T2.11, T2.12, T2.13, T2.14, T2.15, T2.16 | Paralelo (uma página por agente) |
| W2.5 | T2.17, T2.18 | Paralelo |
| W2.6 | T2.T | Serial |
| QA | Q2 `[tier:heavy]` | 2 rodadas completas; depois só major, critical e blocking (0.5) |

#### PF2 · Pre-flight da Fase 2

`runner` + `researcher`

1. Q1 PASS registrado e `git status` limpo.
2. Últimas versões estáveis do upstream (0.14) verificadas e adotadas via `researcher` (npm registry, releases e context7):
   - SvelteKit 2, Svelte 5, `@sveltejs/adapter-cloudflare`, Tailwind 4, Paraglide JS 2 (`sv add paraglide`), Vitest, `@vitest/coverage-v8`, Playwright, `@axe-core/playwright`, `svelte-check`;
   - se a documentação do Better Auth já usa imports do "SvelteKit 3", decidir a versão principal do SvelteKit e registrar.
3. Licenças OFL das fontes confirmadas (Instrument Serif, Geist, JetBrains Mono, Barlow Condensed, Special Elite, Oswald, EB Garamond ou Libre Caslon, fonte marcador para as tiras de identificação).
4. Spikes de viabilidade, descartáveis em `%TEMP%\Claude\spikes\`:
   - Playwright Chrome headless com `AudioContext({sampleRate: 96000})`, AudioWorklet e `OfflineAudioContext`;
   - stub de `navigator.hid` via `page.addInitScript`;
   - `createMediaElementSource` com arquivo local.
5. Constantes das normas de medição verificadas em fonte primária ou secundária confiável. ITU-R BS.1770 e EBU Tech 3341/3342/3343 são gratuitas; IEC 60268 tem referências secundárias citadas. Registrar a tabela no progresso.
6. Mapa de locks da F2 (uma pasta de componentes por página) sem conflitos.
7. AutoEq: confirmar no upstream a estrutura atual e o tamanho do tarball do último commit do branch padrão.
   - As pastas de `measurements/` não são uniformes: algumas fontes têm subpasta `data/`, outras não.
   - Nomes atuais dos alvos, por exemplo: `Harman in-ear 2019.csv`, `Harman over-ear 2018.csv`, `Diffuse field 5128.csv`, `Diffuse field ISO 11904-1.csv`. O README cita nomes antigos que não existem mais.

#### T2.1 · Scaffold SvelteKit e toolchain

`[route class=implement risk=high scope=repo needs=edit,shell,network]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\**` (scaffold)
- `D:\git\open-auri\package.json` (workspaces/scripts)
- `D:\git\open-auri\package-lock.json`

**Subtarefas:**
1. `npx sv create web` (TypeScript, Tailwind 4, ESLint, Prettier, Vitest, Playwright, Paraglide) com `adapter-cloudflare`.
2. `D:\git\open-auri\web\wrangler.template.jsonc` com `main`, `assets` e `compatibility_flags: ["nodejs_als"]`, sem `account_id` (0.15). Criar o `D:\git\open-auri\tools\render-wrangler.mjs` e os scripts `predev`, `prebuild` e `predeploy` que geram o `wrangler.jsonc` ignorado. Os `PUBLIC_*` do `.env` ficam disponíveis no build via `$env/static/public`; no CI, com valores fictícios.
3. Adicionar `"web"` aos `workspaces` da raiz e depender do núcleo com `"open-auri": "*"` (resolvido pelo workspace do npm).
4. Scripts web: `dev`, `build`, `preview`, `check`, `test:unit`, `test:e2e`, `lint`.
5. Scripts raiz: `test:all`, `check:all`.
6. `D:\git\open-auri\web\scripts\merge-messages.mjs` (seção 6.6), com testes próprios.
7. Paraglide com pt-BR base, en-US, estratégia da seção 3.5 e cookie `oa_lang`.
8. `src\app.html` com `%lang%`.
9. CSP em `svelte.config.js` com `mode: 'auto'`.
10. Prerender das rotas estáticas.
11. `vite.config.ts` com projetos Vitest separados: `unit`, com jsdom e arquivos `*.svelte.test.ts` para runes; `integration`, ainda vazio, preenchido na F3.
12. `playwright.config.ts` com `webServer` em build + preview, Chrome, projetos desktop (1440) e mobile (390).

```
[acceptance]
check: buildPasses
criteria: web builds for Cloudflare; core imported from workspace; i18n compiled; unit and e2e runners execute an empty smoke test
deliverable: D:\git\open-auri\web\
[/acceptance]
```

#### T2.2 · Tokens, fontes e estilos base

`[route class=implement risk=low scope=multi needs=edit]` · `implementer`

**W:** `D:\git\open-auri\web\static\fonts\**`, `D:\git\open-auri\web\src\lib\styles\**`

**Conteúdo:**
- tokens do chrome (`--ink`, `--ink-2`, `--text`, `--muted`, `--rule`, `--danger`) e acentos por página (seção 3.4);
- fontes auto-hospedadas (woff2 com subset latino) e `@font-face`;
- base tipográfica, foco visível, `prefers-reduced-motion`;
- utilitários Tailwind 4 mapeados aos tokens.

```
[acceptance]
check: buildPasses
criteria: tokens and self-hosted fonts available; no external font requests
deliverable: D:\git\open-auri\web\src\lib\styles\
[/acceptance]
```

#### T2.3 · Componentes do chrome

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`

**W:** `D:\git\open-auri\web\src\lib\components\chrome\**`, `D:\git\open-auri\web\tests\unit\chrome\**`, `D:\git\open-auri\web\messages\_staging\T2.3.*.json`

**Componentes:**
- `CableBar` com slots: estado, alterações, áudio, ações;
- `Nav`;
- `LanguageToggle` (Paraglide + `oa.lang`);
- `Footer`: homenagem por página via props (nome, anos, curiosidade, fontes), Aviso literal, "Aviso legal completo" → `/docs#aviso-legal`, **"Código-fonte no GitHub" → `https://github.com/marco-jardim/open-auri` (logo abaixo do aviso legal)**, "Licença AGPL-3.0";
- `EmBreve` (texto literal);
- `HelpOverlay` (atalhos);
- `Toast`;
- `ConfirmDialog` acessível.

**Testes:**
- render nos dois idiomas;
- ordem dos links do rodapé (GitHub logo abaixo do aviso legal);
- atalhos de teclado;
- `axe` nos componentes.

```
[acceptance]
check: testsPass
criteria: chrome components with i18n and a11y; GitHub link under legal notice
deliverable: D:\git\open-auri\web\src\lib\components\chrome\
[/acceptance]
```

#### T2.4 · Estado e contrato de armazenamento

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\web\src\lib\state\**`, `D:\git\open-auri\web\tests\unit\state\**`

**Conteúdo:**
- stores com runes (`*.svelte.ts`) para curva atual, diário, flash, idioma, referência do medidor e biblioteca local (IndexedDB `open-auri`, store `library`);
- outbox (store `outbox`) para eventos sociais pendentes, consumida na F4;
- sincronização entre abas (`storage` + `BroadcastChannel`);
- parse resistente a corrupção (políticas do núcleo);
- desfazer e refazer da curva (pilha de 100).

**Testes:** IndexedDB com `fake-indexeddb` (dependência instalada no T2.1), corrupção, duas abas, cota excedida.

```
[acceptance]
check: testsPass
criteria: storage contract §4.3 implemented with cross-tab sync and corruption safety
deliverable: D:\git\open-auri\web\src\lib\state\
[/acceptance]
```

#### T2.5 · Motor de áudio e carregador de MP3

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\src\lib\audio\engine.ts`
- `D:\git\open-auri\web\src\lib\audio\pink-noise.ts`
- `D:\git\open-auri\web\src\lib\components\audio\**`
- `D:\git\open-auri\web\tests\unit\audio\**`
- `D:\git\open-auri\web\messages\_staging\T2.5.*.json`

**R:** `D:\git\open-auri\design\mocks\v2\curva.html` (blocos `OA SHARED: audio-loader v1`, só como referência)

**Subtarefas:**
1. **Engine:**
   - `getContext()` a 96 kHz com fallback anotado;
   - `loadFile` / `removeFile` (IndexedDB `audio`);
   - fonte em streaming (`HTMLAudioElement`);
   - ruído rosa em loop;
   - `buildChain(bands, preampDb, {experimental})`, que usa os coeficientes Q27 do núcleo (recalculados na taxa real se ≠ 96 kHz);
   - `matchGains(levels)`, `start` / `stop`, `onChange`, `state()`;
   - fade de entrada; início só com gesto do usuário; volume da prévia (padrão −6 dB; persistido em `oa.audio.volume`).
2. **`AudioLoader`:** popover com carregar, nome, duração, tocar/pausar, volume, remover e o texto "O arquivo fica só neste navegador. Nada é enviado.".
3. **Prévias A/B:** `createAB(curveA, curveB)` com nível igualado.
4. **Erros:** arquivo inválido, decodificação recusada, contexto suspenso, troca de aba (pausa).

**Testes:** com `AudioContext` simulado na camada de unidade e o caminho real no e2e da T2.T.

```
[acceptance]
check: testsPass
criteria: streaming engine with exact coefficients, persistence, fallback and A/B
deliverable: D:\git\open-auri\web\src\lib\audio\engine.ts and audio components
[/acceptance]
```

#### T2.6 · Runtime de medição e componentes de medidor

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\src\lib\audio\meter-processor.js`
- `D:\git\open-auri\web\src\lib\audio\meters.ts`
- `D:\git\open-auri\web\src\lib\components\meters\**`
- `D:\git\open-auri\web\tests\unit\meters\**`

**Subtarefas:**
1. **AudioWorkletProcessor:** usa `D:\git\open-auri\src\meter\*.mjs` (empacotado no worklet), lê blocos de 128 amostras e publica a cerca de 60 Hz por `MessagePort` (VU L/R, PPM, true peak, LUFS-M e S, correlação).
2. **`meters.ts`:**
   - `tap(node, {kinds})`;
   - `tapStages(chain)` (um tap após cada seção, para os LEDs de estágio);
   - `subscribe` em rAF;
   - `setReference(-18 | -20 | -14)`.
3. **Componentes:** `VuMeter` (agulha com a balística do núcleo, escala VU), `LedLadder` (PPM em dBFS, com retenção de pico), `PpmBar`, `CorrelationMeter`, `PeakLamp` (true peak > −1 dBTP), `LoudnessReadout`, `SpectrumOverlay` (`AnalyserNode` só para espectro).
   - Modos AO VIVO e DADOS com rótulo visível.
   - Reduced motion: valor numérico atualizado a 10 Hz.
   - Nenhuma animação sem dado.

```
[acceptance]
check: testsPass
criteria: worklet meters use core DSP; components render live/data modes; no decorative animation
deliverable: D:\git\open-auri\web\src\lib\audio\meter-processor.js, meters.ts, meter components
[/acceptance]
```

#### T2.7 · Integração do cabo (WebHID, checklist, diário, vários cabos)

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\src\lib\cable\**`
- `D:\git\open-auri\web\src\lib\components\cable\**`
- `D:\git\open-auri\web\tests\unit\cable\**`
- `D:\git\open-auri\web\messages\_staging\T2.7.*.json`

**Subtarefas:**
1. **Detecção de suporte:** sem WebHID, modo simulado.
2. **Conexão e desconexão** com eventos (`connect` e `disconnect` do `navigator.hid`).
3. **`PreWriteChecklist`:**
   - gate (lâmpadas a–g com motivos nos dois idiomas);
   - aviso de loudness;
   - confirmações "Abaixei o volume" e "Não vou desconectar durante a gravação (≈0,3 s)";
   - confirmação experimental quando há HS/LP/HP;
   - contadores e espera de 2 s;
   - aviso de 50 por dia.
4. **Gravação real** via `D:\git\open-auri\src\transport\webhid.mjs`, diário (`ok`, `interrupted`, `simulated`), aviso de resgate após interrupção.
5. **Fila X9:** vários cabos, um por vez.
6. **Modo simulado** usando `fake-device`.
7. Evento interno `cable:written`, consumido pela outbox na F4.

```
[acceptance]
check: testsPass
criteria: no write path bypasses gate+checklist+gesture; journal and counters correct; simulated mode works without WebHID
deliverable: D:\git\open-auri\web\src\lib\cable\
[/acceptance]
```

#### T2.8 · Gráficos e Web Workers

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\web\src\lib\charts\**`, `D:\git\open-auri\web\src\lib\workers\**`, `D:\git\open-auri\web\tests\unit\charts\**`

**Conteúdo:**
- **Gráficos SVG:** resposta (soma da EQ e saída), mini curvas, polos e zeros, mapa de bytes, timeline de reports, diagrama polar (Docs), mapa de calor de erro, wiggle trace.
- **`gate.worker.ts`:** arraste com busca de fronteira (grade `drag`, confirmação `full` ao soltar).
- **`solver.worker.ts`.**
- Escalas log e dB com rótulos legíveis (≥ 11 px no desktop, ≥ 10 px no mobile).

```
[acceptance]
check: testsPass
criteria: charts render from core math only; workers keep main thread under 16 ms per frame during drag
deliverable: D:\git\open-auri\web\src\lib\charts\, D:\git\open-auri\web\src\lib\workers\
[/acceptance]
```

#### T2.19 · Dados do AutoEq embutidos (medições e alvos)

`[route class=implement risk=medium scope=multi needs=edit,shell,network]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\tools\import-autoeq.mjs`
- `D:\git\open-auri\test\tools\import-autoeq.test.mjs`
- `D:\git\open-auri\test\fixtures\autoeq\**`
- `D:\git\open-auri\web\src\lib\data\autoeq.ts`
- `D:\git\open-auri\web\tests\unit\data\autoeq.test.ts`
- `D:\git\open-auri\docs\autoeq-data.md`
- `D:\git\open-auri\.gitignore` (acrescenta `web/static/data/autoeq/`)

O script `data:autoeq` nos `package.json` entra pela fila de integração.

**Subtarefas:**
1. **Script:**
   - descobre o último commit do branch padrão do AutoEq (API do GitHub);
   - busca só o necessário desse SHA: clone parcial (`git clone --filter=blob:none --no-checkout`) + `git sparse-checkout set measurements targets` + checkout do SHA. O tarball inteiro passa de 4 GiB por causa de `results/`. Cache em `%TEMP%\Claude\autoeq\<sha>\` localmente e cache próprio no CI;
   - extrai só `measurements/**/*.csv` e `targets/*.csv`, inferindo fonte e tipo (IEM, over-ear, on-ear) pelo caminho, com e sem a subpasta `data/`;
   - converte cada resposta para a grade log de 481 pontos com `D:\git\open-auri\src\io\measurement.mjs`;
   - quantiza em int16 com passo de 0,01 dB e normaliza.
2. **Saída** em `D:\git\open-auri\web\static\data\autoeq\`:
   - `manifest.json`: SHA, data, contagens, fontes com atribuição e link;
   - `index.json`: nome, marca, fonte, tipo, id, pacote, deslocamento;
   - pacotes binários por fonte e tipo, com até 5 MiB cada; os alvos ficam em pacote próprio.
3. **Geração no build** (`npm run data:autoeq`): executada no CI antes do build e localmente sob demanda. Os artefatos gerados não são versionados.
4. **Cliente `autoeq.ts`:** busca fuzzy no índice, carregamento do pacote sob demanda e cache pelo service worker, para usar offline as medições já abertas.
5. **Atribuição** visível (fonte de cada medição e AutoEq MIT) em Soe como X e na Docs. `D:\git\open-auri\docs\autoeq-data.md` descreve as fontes e o processo de remoção a pedido do dono dos dados. O pipeline aceita `--exclude-source <nome>`.

**Testes:**
- conversão de amostras reais pequenas (fixtures);
- detecção de fonte e tipo nos layouts com e sem `data/`;
- quantização de ida e volta com erro < 0,01 dB;
- índice consistente com os pacotes;
- tamanho máximo de pacote;
- exclusão de fonte;
- falha de rede usando o cache.

```
[acceptance]
check: testsPass
criteria: latest upstream AutoEq snapshot converted to compact static packs with manifest (SHA), index, attribution and source exclusion; client search and lazy loading work offline after first open
deliverable: D:\git\open-auri\tools\import-autoeq.mjs, D:\git\open-auri\web\src\lib\data\autoeq.ts
[/acceptance]
```

#### T2.9 · Layout e integração do chrome

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\src\routes\+layout.svelte`
- `D:\git\open-auri\web\src\routes\+layout.ts`
- `D:\git\open-auri\web\src\routes\+error.svelte`
- `D:\git\open-auri\web\src\lib\page-meta.ts` (homenagens, acentos e curiosidades por rota)

**Integra:** `CableBar` + `AudioLoader` + estado do cabo + `PreWriteChecklist` + Neutro e Padrão Auri + `Footer` com metadados da rota. Prerender por padrão; página de erro temática.

```
[acceptance]
check: buildPasses
criteria: every route renders shared chrome with route-specific homage and accent
deliverable: D:\git\open-auri\web\src\routes\+layout.svelte
[/acceptance]
```

#### Páginas (W2.4, em paralelo; cada uma é dona da sua rota e da sua pasta de componentes)

Regras comuns a todas as páginas:
- porta definitiva do mock correspondente, sem código duplicado do núcleo;
- medidores ligados a dados reais (seção 3.6);
- i18n via staging;
- `axe` limpo;
- desktop 1440 e mobile 390;
- capturas de referência em `D:\git\open-auri\design\mocks\v2\_qa\`.

**T2.10 · Curva `/` (Bob Moog)**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required
- **W:** `D:\git\open-auri\web\src\routes\+page.svelte`, `D:\git\open-auri\web\src\routes\+page.ts`, `D:\git\open-auri\web\src\lib\components\pages\curva\**`, `D:\git\open-auri\web\tests\unit\pages\curva\**`, staging T2.10
- **Escopo:**
  - **Camadas:** Ouvir, Ajustar e Engenharia, com transformação animada, URL e teclas 1/2/3.
  - **Ouvir:** presets, macros N1, saída e resgate.
  - **Ajustar:** banco de 10 módulos e alças com fronteira do gate; HS/LP/HP travados com dica.
  - **Engenharia:** gabinete modular, cabos de patch com reordenação validada pelo gate, inspetor (coeficientes, palavras Q27, polos e zeros), sequenciador com os 9 reports e log TX; HS/LP/HP experimentais.
  - **Importar e exportar:** `.txt` (incluindo HS/LP/HP na Engenharia), JSON S5, `.bin`, link `#p=` (S1).
  - **Prévia A/B.**
  - **Medidores:** VU de saída, LEDs por estágio ao vivo e espectro.

**T2.11 · Biblioteca `/biblioteca` (Geoff Emerick)**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\biblioteca\**`, `D:\git\open-auri\web\src\lib\components\pages\biblioteca\**`, testes e staging
- **Escopo:**
  - **Prateleiras e busca:** oficiais (preferência e referência), biblioteca local, busca, tags automáticas, ordenação.
  - **Ficha (folha de pistas):** S5, S10 (exportar PNG/SVG), S1, cartão S8 com QR real (gerador de QR em `D:\git\open-auri\web\src\lib\qr\`, lib com licença verificada) e "Ouvir" A/B.
  - **Ponte de medidores:** ao vivo (VU L/R, PPM, LUFS-M, correlação) ou dados (nível, preamp, pico, salto, semelhança S4).
  - **Pack de referência Auri (S9).**

**T2.12 · Comparar `/comparar` (Les Paul)**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\comparar\**`, `D:\git\open-auri\web\src\lib\components\pages\comparar\**`, testes e staging
- **Escopo:**
  - **Pistas:** 8 pistas com VU ao vivo cada (cadeias paralelas).
  - **Comparação A/B:** "Onde diferem" (S4), patch bay de distâncias e A/B.
  - **Som sobre som (C3):** botão de mistura de 0 a 150%, aproximação em 10 seções e gate.
  - **Exportação S10.**

**T2.13 · Soe como X `/soe-como-x` (Andy Hildebrand)**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\soe-como-x\**`, `D:\git\open-auri\web\src\lib\components\pages\soe-como-x\**`, testes e staging
- **Escopo:**
  - **Fluxo:** quatro estações (medição importada, alvo, correção, resultado); o solver roda no worker.
  - **Medições e alvos:** base embutida do AutoEq (T2.19), com busca por modelo, marca e fonte e alvos como Harman in-ear 2019, Harman over-ear 2018 e campo difuso. Também presets oficiais como alvo, alvo desenhado (C2) e CSV importado. Atribuição da fonte sempre visível. Depende da T2.19.
  - **Correção:** pesos ISO 226 (D4), D5 e velocidade de correção.
  - **Resultado:** gate, prévia A/B, VU e espectro ao vivo.

**T2.14 · Teste cego `/teste-cego` (Toole e Olive)**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\teste-cego\**`, `D:\git\open-auri\web\src\lib\components\pages\teste-cego\**`, testes e staging
- **Escopo:**
  - **Cena:** tela que esconde as caixas e troca de posição em 3 s.
  - **Preparo:** fonte do motor compartilhado, confirmação "Cabo em Neutro" ou "Outra saída".
  - **Candidatos:** oficiais, curva atual, variações.
  - **Rodadas:** ordem sorteada, notas de 0 a 10.
  - **Resultado:** IC de 95% (t de Student) e chave de torneio.
  - **Cabo:** "Teste no cabo" EM BREVE, com o custo em gravações.
  - **S6:** painel de consentimento pronto; o envio é ligado na F4 (T4.16).
  - **Medidores:** nível por candidato ao vivo.

**T2.15 · Cabo `/cabo` (Ray Dolby)**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\cabo\**`, `D:\git\open-auri\web\src\lib\components\pages\cabo\**`, testes e staging
- **Escopo:**
  - **Rack:** interface USB (máquina de estados, WebHID real só com clique explícito) e codificador (4 regiões de bytes reais).
  - **Calibração:** VU do checklist com chaves com tampa; o checklist da T2.7 é embutido.
  - **Transporte:** fita dos 9 reports + commit em tempo real e câmera lenta ×10.
  - **Diário, contadores mecânicos e vários cabos.**
  - **EM BREVE:** ler cabo, firmware, modo RAM, teste cego no cabo.

**T2.16 · Docs `/docs` (Harry Nyquist)**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\docs\**`, `D:\git\open-auri\web\src\lib\components\pages\docs\**`, `D:\git\open-auri\web\src\lib\content\docs\**`, testes e staging
- **Escopo:**
  - **Visual:** reimpressão de periódico, fita de telégrafo com hex real, figura polar.
  - **Ferramentas:** busca local (Ctrl+K), sumário com acompanhamento de rolagem.
  - **Seções:** começo rápido; camadas; o que é seguro (gate v2 com limites exatos e ressalvas); protocolo (mapa de bytes, framing, amostragem, widgets Q23 e CRC); limites físicos; memória e vida útil; prévia com MP3; dados neste navegador (com "Apagar dados locais"); o que a página oficial faz; o que não sabemos; glossário; **aviso legal (`#aviso-legal`, pt-BR e en-US)**; créditos dos homenageados com fontes.
  - **Contas e social:** seções reservadas, preenchidas na F4 pela T4.18 (o conteúdo das F3/F4 entra nessas fases).

#### T2.17 · PWA e offline

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`

**W:** `D:\git\open-auri\web\src\service-worker.ts`, `D:\git\open-auri\web\static\manifest.webmanifest`, `D:\git\open-auri\web\static\icons\**`, `D:\git\open-auri\web\tests\e2e\offline.spec.ts`

**Conteúdo:**
- precache do shell e das fontes, versionado por build;
- estratégia de rede primeiro para `/api/**`;
- página offline;
- atualização com aviso.

#### T2.18 · Endurecimento de acessibilidade, desempenho e visual

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` (dono exclusivo das pastas `D:\git\open-auri\web\src\lib\components\pages\**` durante a W2.5)

**Conteúdo:**
- `axe` em todas as rotas;
- orçamentos de JS por rota e LCP;
- `content-visibility` nas cenas pesadas;
- regressão visual (`toHaveScreenshot`) em desktop e mobile, com e sem reduced motion;
- correção dos defeitos conhecidos dos mocks (rótulos polares apertados na Docs, espaço sobrando em "Onde diferem", seletor de idioma quebrando no mobile).

#### T2.T · Bateria de testes da Fase 2

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\web\tests\e2e\**`, `D:\git\open-auri\web\tests\fixtures\**`, `D:\git\open-auri\web\scripts\gen-fixtures.mjs`

**E2E (Playwright, Chrome, desktop e mobile):**
1. **`D:\git\open-auri\web\tests\e2e\smoke.spec.ts`:** todas as rotas sem erro de console e sem `NaN`, `undefined` ou `[object Object]` no texto; homenagem e rodapé com o link do GitHub abaixo do aviso legal.
2. **`curva.spec.ts`:**
   - camadas e URL;
   - arraste para na fronteira com motivo;
   - HS/LP/HP travados no Ajustar e experimentais na Engenharia;
   - reordenação recusada volta ao lugar;
   - importar e exportar `.txt` e S1.
3. **`parity.spec.ts`:** CRC exibido de cada preset igual ao fixture; Neutro 0x4FFF.
4. **`audio.spec.ts`:**
   - WAV gerado (seno de 440 Hz) carregado e persistido entre todas as páginas;
   - contexto a 96 kHz;
   - cadeias IIR com 10 seções por cadeia;
   - A/B troca o ganho sem recriar a fonte;
   - remover o arquivo cai no ruído rosa.
5. **`meters.spec.ts` (fidelidade):** sinais injetados por `OfflineAudioContext` e worklet:
   - seno de 1 kHz a −18 dBFS → 0 VU ± 0,2;
   - degrau → 99% em 300 ms ± 10%;
   - rajada PPM;
   - true peak entre amostras;
   - correlação mono +1 e invertida −1;
   - medidores em modo DADOS sem áudio;
   - nenhuma animação sem dado (o DOM não muda em repouso).
6. **`cable.spec.ts` (stub `navigator.hid`):**
   - bytes e tempos iguais ao fixture;
   - checklist obrigatório;
   - confirmação experimental;
   - aviso de loudness na primeira gravação e ao subir ≥ 3 dB;
   - espera de 2 s;
   - aviso de 50 por dia;
   - desconexão no meio resulta em diário `interrupted` e aviso de resgate;
   - X9 em sequência;
   - modo simulado sem WebHID.
7. **`i18n.spec.ts`:** troca de idioma persiste entre rotas e no SSR (cookie); números com vírgula e ponto; nenhuma chave faltando.
8. **`a11y.spec.ts`:** `axe` sem violações sérias ou críticas em todas as rotas; navegação completa por teclado nas camadas da Curva.
9. **`visual.spec.ts`:** capturas de referência.
10. **`offline.spec.ts`:** editor, presets e prévia offline.
11. **`perf.spec.ts`:** orçamentos de JS por rota (via manifest) e quadros longos durante o arraste.

**Cobertura:** Vitest v8 com 85% ou mais de linhas e branches em `D:\git\open-auri\web\src\lib\**` (exceto `.svelte` puramente visuais, listados em configuração).

```
[acceptance]
check: testsPass
check: buildPasses
criteria: all e2e specs green on desktop and mobile; coverage ≥85% for web/src/lib; meters conformance e2e green
deliverable: phase 2 test battery
[/acceptance]
```

#### Critérios de aceite da Fase 2

1. As 7 páginas (todas menos Comunidade) estão completas, fiéis aos mocks e funcionais em modo simulado e com o stub de WebHID.
2. Nenhum caminho de gravação burla gate, checklist e gesto (verificado por teste e por revisão).
3. O MP3 persiste entre páginas e alimenta todas as prévias e o teste cego; os medidores passam na conformidade e são fiéis à música.
4. Offline funciona; i18n completo; `axe` limpo; orçamentos de desempenho cumpridos.
5. Rodapé com o link do GitHub abaixo do aviso legal em todas as rotas.

#### Definition of Done da Fase 2

PF2 aprovado · tarefas verificadas e commitadas · T2.T verde (unidade + e2e + cobertura) · Q2 PASS · capturas de referência versionadas · progresso atualizado.

#### Q2 · QA sênior adversarial da Fase 2 `[tier:heavy]`

`[route class=review risk=high scope=repo needs=shell tier=heavy pin]` · `reviewer`

**Foco:**
- caminhos de gravação, como atalhos de teclado e chamadas da fila X9 sem checklist;
- medidores que animam sem dado;
- fidelidade dos medidores;
- vazamentos de áudio (contextos não fechados);
- XSS em nomes importados;
- `.txt` malicioso;
- regressões visuais;
- `axe`, i18n, orçamentos;
- regras de texto (sem travessão em pt-BR, marcas).

---

### Fase 3 · Backend, autenticação e conta

**Objetivo:** backend definitivo no mesmo Worker do SvelteKit e no Worker de jobs. Login com e-mail e senha completo, e-mails transacionais, área de conta, segurança, LGPD e base de administração.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| W3.1 | T3.1 | Serial (infra e dependências) |
| W3.2 | T3.2, T3.3, T3.4 | Paralelo |
| W3.3 | T3.5 | Serial (núcleo de auth; dono do `hooks.server.ts`) |
| W3.4 | T3.6, T3.7, T3.8 | Paralelo |
| W3.5 | T3.T | Serial |
| QA | Q3 `[tier:heavy]` | 2 rodadas completas; depois só major, critical e blocking (0.5) |

#### PF3 · Pre-flight da Fase 3

`runner` + `researcher`

1. Q2 PASS registrado e `git status` limpo.
2. Better Auth na última versão estável (0.14), via npm registry, changelog e context7:
   - API de `svelteKitHandler` e `sveltekitCookies`;
   - D1 nativo;
   - `emailVerification`, `changeEmail`, `changePassword`, `deleteUser` (`freshAge`, `sendDeleteAccountVerification`);
   - listagem e revogação de sessões;
   - plugins `username` e `admin`;
   - `rateLimit.storage: "database"`;
   - `ipAddressHeaders`;
   - CLI (`npx auth generate` e se o `migrate` funciona com D1 nativo);
   - `advanced.ipAddress.disableIpTracking` (efeito nas colunas `ipAddress` e `userAgent` da sessão) e `rateLimit.enabled: false`.
   Registrar as versões adotadas.
3. Spike de CPU do hash: medir scrypt (padrão da versão fixada) e `node:crypto.scryptSync` no `wrangler dev` (workerd) com `nodejs_compat`. Escolher o que der **≤ 200 ms de CPU** com parâmetros OWASP. Registrar a decisão.
4. Resend: API, `Idempotency-Key` e verificação de webhooks (svix). Testes usam `@msw/cloudflare` (ou equivalente atual).
5. `@cloudflare/vitest-plugin` (substituto do `vitest-pool-workers`) confirmado e configurado no projeto `integration`.
6. Entradas humanas: H-RESEND e H-TURNSTILE não bloqueiam a F3 (testes com mocks e chaves de teste do Turnstile). Registrar o que falta para a F5.
7. Curiosidade e fonte de Rupert Neve verificadas (`researcher`).
8. Q-MCI respondida (seção 13). Sem resposta, a T3.3 implementa a tabela `access_log` atrás de uma configuração desligada por padrão, e o progresso registra o bloqueio para a F5.

#### T3.1 · Infraestrutura do backend

`[route class=implement risk=high scope=repo needs=edit,shell,network]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\wrangler.template.jsonc`
- `D:\git\open-auri\workers\jobs\wrangler.template.jsonc`
- `D:\git\open-auri\tools\render-wrangler.mjs` (estende o criado na T2.1)
- `D:\git\open-auri\.env` e `D:\git\open-auri\.env.example` (IDs dos recursos criados; placeholders no exemplo)
- `D:\git\open-auri\web\package.json`
- `D:\git\open-auri\package.json` (adiciona `"workers/jobs"` aos `workspaces`)
- `D:\git\open-auri\package-lock.json`
- `D:\git\open-auri\web\src\app.d.ts`
- `D:\git\open-auri\web\.dev.vars.example`
- `D:\git\open-auri\web\src\lib\server\env.ts`
- `D:\git\open-auri\web\src\lib\server\db.ts`
- `D:\git\open-auri\workers\jobs\**` (scaffold)
- `D:\git\open-auri\web\vite.config.ts` (projeto `integration`)
- `D:\git\open-auri\tools\sync-secrets.mjs`

**Configuração já disponível no `.env` (0.15):** nomes `open-auri` e `open-auri-jobs`, `PUBLIC_ORIGIN`, chaves do Turnstile, `RESEND_API_KEY`, `RESEND_FROM`, `BETTER_AUTH_SECRET`, `IPHASH_PEPPER`, `ACCESS_LOG_KEY` e as flags.

**Templates e scripts desta tarefa:**
- `D:\git\open-auri\web\wrangler.template.jsonc` e `D:\git\open-auri\workers\jobs\wrangler.template.jsonc` (versionados, só com `${VAR}`).
- `D:\git\open-auri\tools\render-wrangler.mjs` gera os `wrangler.jsonc` (ignorados pelo git) com `account_id`, IDs de recursos e `vars` não secretas.
  - A T3.1 cria os recursos D1, KV, R2 e a fila de registros de acesso na conta de `CLOUDFLARE_ACCOUNT_ID` e grava os IDs no `.env`: `D1_DATABASE_ID`, `KV_CONFIG_ID`, `R2_BUCKET`, `ACCESS_LOG_QUEUE`, com variantes `_STAGING`. Também atualiza o `.env.example` com placeholders.
- `D:\git\open-auri\tools\sync-secrets.mjs` envia os segredos com `wrangler secret put` por stdin, sem ecoar valores. Falha se a conta do wrangler divergir de `CLOUDFLARE_ACCOUNT_ID`.
- Desenvolvimento local: `web\.dev.vars` (ignorado) gerado pelo mesmo `render-wrangler.mjs` a partir do `.env`.

**Subtarefas:**
1. **Bindings:** D1 `DB`, R2 `MEDIA`, KV `CONFIG`, rate limits (`RL_AUTH`, `RL_API`, `RL_WRITE`), variáveis `PUBLIC_ORIGIN` e `GITHUB_URL`, segredos `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TURNSTILE_SECRET`, `IPHASH_PEPPER`.
2. **Ambientes:** `env.staging` e `env.production`.
3. **Desenvolvimento local** com `platformProxy`.
4. **Tipos:** `wrangler types`.
5. **Worker de jobs:** `D:\git\open-auri\workers\jobs\wrangler.jsonc` com os mesmos D1, KV e R2 e um `src\index.ts` com registro de jobs (inicialmente: rotação do sal).
6. **Dependências da fase:** `better-auth`, `zod` (ou `valibot`), `@cloudflare/vitest-plugin`, `@msw/cloudflare`, `wrangler`.

```
[acceptance]
check: buildPasses
criteria: bindings typed; local dev boots with D1/R2/KV emulation; jobs worker builds; integration test project runs an empty test
deliverable: D:\git\open-auri\web\wrangler.jsonc, D:\git\open-auri\workers\jobs\
[/acceptance]
```

#### T3.2 · E-mail transacional (Resend)

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\src\lib\server\email\**`
- `D:\git\open-auri\web\src\routes\api\webhooks\resend\+server.ts`
- `D:\git\open-auri\web\migrations\0002_email.sql`
- `D:\git\open-auri\web\tests\integration\email\**`

**Subtarefas:**
1. Interface `EmailProvider.send({to, subject, html, text, idempotencyKey, tags})` e `ResendProvider` (fetch, `Idempotency-Key`, tratamento de 4xx e 5xx com nova tentativa exponencial só em 5xx e 429).
2. Templates pt-BR e en-US (HTML acessível + texto):
   - verificar e-mail;
   - redefinir senha;
   - confirmar novo e-mail;
   - aviso ao e-mail antigo;
   - senha alterada;
   - confirmar encerramento de conta;
   - conta encerrada.
   Sem rastreadores.
3. Webhook com verificação de assinatura svix (bounce e complaint) que grava na tabela `email_suppressions`; envios para endereços suprimidos são bloqueados com erro tratado.
4. Envio via `waitUntil`, sem bloquear a resposta.

**Testes:** idempotência, falhas transitórias, assinatura inválida, supressão, templates nos dois idiomas (snapshot), nenhum dado sensível em logs.

```
[acceptance]
check: testsPass
criteria: provider interface + Resend adapter with idempotency, retries, suppression via signed webhook; bilingual templates
deliverable: D:\git\open-auri\web\src\lib\server\email\
[/acceptance]
```

#### T3.3 · Segurança: Turnstile, rate limit, hash de IP, cabeçalhos

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\src\lib\server\security\**`
- `D:\git\open-auri\workers\jobs\src\jobs\rotate-salt.ts`
- `D:\git\open-auri\web\tests\integration\security\**`
- `D:\git\open-auri\web\src\lib\components\security\Turnstile.svelte`

**Subtarefas:**
1. **`verifyTurnstile(token, action, hostname)`:** siteverify com `idempotency_key`; checagem de `action` e `hostname`; sem `remoteip` por padrão.
2. **`rateLimit(binding, key)`** com chaves por usuário, por hash de IP e por rota.
3. **`ipHash(ip)`** = HMAC-SHA256(pepper ‖ sal diário do KV), com o job de rotação apagando o sal antigo.
4. **`securityHeaders()`** com os cabeçalhos da seção 3.8, CSP coordenada com o SvelteKit.
5. **Componente Turnstile** (modo gerenciado; nos testes, chave de teste).
6. **Rate limit da autenticação** (sign-up, sign-in, reset, change-email, reenvio de verificação): aplicado num hook antes do handler do Better Auth. A chave é HMAC do IP, combinada com o e-mail normalizado quando houver. Isso substitui o rate limit interno do Better Auth, que fica desligado.
7. **Registro de acesso (Marco Civil art. 15; decisão: cumprir):**
   - **Captura:** `D:\git\open-auri\web\src\lib\server\security\access-log.ts` é um middleware, ligado no `hooks.server.ts` pela T3.5. Para toda requisição dinâmica, ele envia `{ts, ip, port, user_id?, route_group, status}` à fila `ACCESS_LOG_QUEUE` via `waitUntil`, sem bloquear a resposta. Falha de envio gera log de erro sem PII e métrica.
   - **Gravação:** consumidor no Worker de jobs (`D:\git\open-auri\workers\jobs\src\jobs\access-log-consumer.ts`). Agrupa por hora, cifra cada lote (AES-GCM com `ACCESS_LOG_KEY`, IV aleatório, versão da chave para rotação) e grava no R2 em `access-log/AAAA/MM/DD/HH-<uuid>.ndjson.enc`.
   - **Purga:** regra de ciclo de vida do R2 no prefixo `access-log/` (180 dias), conferida pelo job de limpeza. Esses objetos ficam fora dos backups e do dump público, para que a exclusão em 6 meses seja real.
   - **Consulta por ordem judicial:** `D:\git\open-auri\tools\access-log-query.mjs`, usado só pelo operador.
     - Exige a referência do processo ou ofício e a janela de tempo.
     - Registra o pedido em `access_log_requests` (migração `D:\git\open-auri\web\migrations\0007_access_log.sql`) e na auditoria.
     - Decifra só a janela pedida e exporta o recorte.
   - **S6:** o lote não guarda horário (só o dia) e é gravado com atraso aleatório. O registro de acesso da rota S6 só guarda o grupo `s6`. Isso reduz a correlação entre os dois.
   - **Ativação:** `ACCESS_LOG_ENABLED=true` por padrão.
   - **Escopo de escrita:** os arquivos acima entram no W desta tarefa. A fila e o consumidor entram nos templates do wrangler pela fila de integração.

**Testes:** token inválido, expirado, de ação errada ou de hostname errado; limite excedido; o sal muda o hash entre dias e os hashes antigos não são reproduzíveis após a rotação; cabeçalhos presentes em todas as respostas.

```
[acceptance]
check: testsPass
criteria: turnstile, rate limit, daily-salted ip hash with rotation job, security headers
deliverable: D:\git\open-auri\web\src\lib\server\security\
[/acceptance]
```

#### T3.4 · Páginas legais e LGPD

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`

**W:**
- `D:\git\open-auri\web\src\routes\privacidade\**`
- `D:\git\open-auri\web\src\routes\termos\**`
- `D:\git\open-auri\web\src\lib\content\legal\**`
- `D:\git\open-auri\docs\lgpd.md`
- staging T3.4

**Conteúdo:**
- **Política de privacidade:** já escrita em `D:\git\open-auri\docs\legal\politica-de-privacidade.md` (pt-BR, prevalece) e `D:\git\open-auri\docs\legal\privacy-policy.en-US.md`. Esta tarefa porta os textos para as páginas e ajusta:
  - os dados do AutoEq passam a ser "embutidos";
  - o apelido público e a biblioteca pública opt-in;
  - a resposta da Q-MCI;
  - os placeholders preenchidos pelo humano (Q-LEGAL-FIELDS): CNPJ, endereço, encarregado, data de vigência.
  - Os documentos já são templates com `{{PUBLIC_LGPD_CONTROLLER}}`, `{{PUBLIC_LGPD_CONTACT_EMAIL}}`, `{{PUBLIC_LGPD_CNPJ}}`, `{{PUBLIC_LGPD_ADDRESS}}`, `{{PUBLIC_LGPD_DPO_NAME}}`, `{{PUBLIC_POLICY_EFFECTIVE_DATE}}` e `{{PUBLIC_ORIGIN}}`, renderizados no build (prerender) a partir das variáveis `PUBLIC_*`.
  - O build de produção falha se controlador, e-mail de contato ou data de vigência estiverem vazios. CNPJ, endereço e encarregado vazios geram aviso no build e ficam fora do texto.
  - O rodapé e a Docs usam as mesmas variáveis. Nada é literal no código.
- **Aviso de mudança de política:** versão da política em configuração; banner no app quando muda. Usuários logados registram o aceite em `policy_acceptances` (migração `D:\git\open-auri\web\migrations\0008_policy.sql`, no W desta tarefa); anônimos usam `oa.policy.seen` no localStorage.
- **Termos:** licenças CC das curvas publicadas, conduta, moderação, isenção.
- **`docs\lgpd.md`:** registro das operações de tratamento.
- Tema Nyquist (subpáginas da Docs).
- Revisão jurídica marcada como Q-LEGAL (não bloqueia o código).

#### T3.5 · Núcleo de autenticação (Better Auth)

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required · Dep: T3.1, T3.2, T3.3 · revisão de segurança extra `[tier:heavy]` ao final (Q3 cobre)

**W:**
- `D:\git\open-auri\web\src\lib\server\auth.ts`
- `D:\git\open-auri\web\src\hooks.server.ts`
- `D:\git\open-auri\web\src\hooks.ts`
- `D:\git\open-auri\web\src\routes\api\auth\[...all]\+server.ts`
- `D:\git\open-auri\web\migrations\0001_auth.sql`
- `D:\git\open-auri\web\src\lib\auth-client.ts`
- `D:\git\open-auri\web\tests\integration\auth\**`

**Subtarefas:**
1. **Instância por requisição** com `database: env.DB`.
2. **`emailAndPassword`:** habilitado; `requireEmailVerification: true`; mínimo de 10 caracteres; hash conforme o PF3.
3. **E-mails:** `sendVerificationEmail`, `sendResetPassword` e `revokeSessionsOnPasswordReset: true`, todos pelo `EmailProvider`.
4. **Usuário:** `user.changeEmail.enabled` (confirmação no e-mail atual + verificação no novo); `deleteUser.enabled` com `sendDeleteAccountVerification` e senha.
5. **Plugins:** `username` (normalização e reservas) e `admin` (papéis `user` e `admin`, ban).
6. **Rate limit:** o interno fica desligado (`rateLimit.enabled: false`). O hook da T3.3 aplica as regras antes do handler: sign-in 3/10 s, reset 3/60 s, sign-up 3/60 s, reenvio de verificação 3/300 s.
7. **Infra de requisição:**
   - `advanced.ipAddress.disableIpTracking: true` (a sessão não guarda IP; o user-agent é reduzido a navegador e sistema);
   - `trustedOrigins = [PUBLIC_ORIGIN]`;
   - cookies `Secure`/`HttpOnly`/`SameSite=Lax`;
   - registro de acesso da T3.3 ligado no `hooks.server.ts` para toda requisição dinâmica (`ACCESS_LOG_ENABLED`).
8. **2FA de administrador:** plugin `twoFactor` (TOTP + códigos de recuperação). Quando `ADMIN_2FA_REQUIRED=true`, o papel `admin` só tem efeito com 2FA ativo e verificado na sessão. Usuários comuns podem ativar o 2FA de forma opcional na área da conta.
8. **Turnstile** como pré-condição em sign-up, sign-in, reset e change-email, via hook antes do handler.
9. **`hooks.server.ts`:** compõe `paraglideMiddleware`, cabeçalhos de segurança, `svelteKitHandler` e `event.locals.user`/`session` via `auth.api.getSession`, com `sveltekitCookies` como último plugin.
10. **Migração `0001_auth.sql`** gerada pelo CLI e revisada.
11. **Atomicidade:** D1 não tem transações; documentar a ressalva do reset (seção 12) e mitigar com ordem segura das operações.

**Testes:**
- matriz completa de fluxos: cadastro, verificação, entrada, saída, reset (token de uso único e expirado), troca de e-mail (colisão com e-mail existente, link expirado), troca de senha (atual errada, revogação de outras sessões);
- exclusão (sem senha, sem confirmação, com confirmação);
- ban;
- rate limit;
- origem inválida;
- cookies;
- resposta uniforme para e-mail inexistente (anti-enumeração);
- usuário não verificado bloqueado nas rotas sociais (marcador `requireVerified`).

```
[acceptance]
check: testsPass
criteria: complete email/password auth with verification, reset, change email/password, delete, sessions, admin/username plugins, rate limit, turnstile, safe hooks composition
deliverable: D:\git\open-auri\web\src\lib\server\auth.ts, D:\git\open-auri\web\src\hooks.server.ts
[/acceptance]
```

#### T3.6 · Páginas de autenticação (Rupert Neve)

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`

**W:**
- `D:\git\open-auri\web\src\routes\entrar\**`
- `D:\git\open-auri\web\src\routes\criar-conta\**`
- `D:\git\open-auri\web\src\routes\verificar-email\**`
- `D:\git\open-auri\web\src\routes\esqueci-senha\**`
- `D:\git\open-auri\web\src\routes\redefinir-senha\**`
- `D:\git\open-auri\web\src\lib\components\auth\**`
- testes e staging

**Conteúdo:**
- tema de canal de console (sem marcas);
- com `SIGNUP_ENABLED=false`, `/criar-conta` explica que o cadastro abre em breve (sem formulário), e a API de cadastro responde 403 com código estável. Entrar, recuperar senha e conta continuam funcionando para contas existentes, como a do operador, criada por `D:\git\open-auri\tools\grant-admin.mjs --create`;
- formulários acessíveis com progressive enhancement (form actions);
- medidor de força de senha;
- Turnstile;
- mensagens uniformes;
- reenvio de verificação com espera;
- retorno para a página de origem;
- acento definido aqui e registrado em `D:\git\open-auri\web\src\lib\page-meta.ts` (pela fila).

#### T3.7 · Área da conta `/conta`

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\src\routes\conta\**`
- `D:\git\open-auri\web\src\lib\server\account\**`
- `D:\git\open-auri\web\src\lib\components\account\**`
- testes e staging

**Seções:**
- **Perfil:**
  - apelido público (regras da seção 3.7: unicidade com confundíveis, reservados, troca a cada 30 dias, reserva de 90 dias com redirecionamento), escolhido no primeiro acesso após a verificação do e-mail;
  - bio ≤ 280;
  - `activity_visibility` e `library_visibility`, ambos privados por padrão, com explicação clara do que passa a ficar público.
- **Segurança:**
  - trocar senha, com "encerrar outras sessões" marcado por padrão;
  - sessões ativas com dispositivo aproximado e última atividade, revogação individual e "sair de todas".
- **E-mail:** trocar, com estado pendente visível.
- **Dados:** exportar meus dados (JSON com conta, perfil, curvas, versões, favoritos, atividade, compartilhamentos; gerado sob demanda e baixado direto).
- **Encerrar conta:**
  - senha + confirmação por e-mail;
  - escolha "manter minhas curvas públicas anonimizadas" ou "apagar tudo";
  - efeitos explicados;
  - `beforeDelete` executa a política;
  - e-mail de conta encerrada.

**Testes:** autorização (só o dono), CSRF, exportação completa e sem dados de terceiros, e exclusão com as duas políticas.
- A T3.7 define a interface `ContentDeletionPolicy` e a testa com as tabelas que existem na F3 (conta e perfil).
- A T4.1 implementa a parte social dessa interface (lápides e anonimização) e estende os mesmos testes.

#### T3.8 · Base de administração

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`

**W:**
- `D:\git\open-auri\web\src\routes\admin\**`
- `D:\git\open-auri\web\src\lib\server\admin\**`
- `D:\git\open-auri\web\migrations\0003_admin.sql`
- testes e staging

**Conteúdo:**
- **guarda do `/admin`:** papel `admin` + 2FA verificado na sessão (T3.5) + sessão recente (reautenticação nos últimos 10 minutos para ações destrutivas).
  - O papel é atribuído só por `D:\git\open-auri\tools\grant-admin.mjs` (operador, usa o `ADMIN_EMAIL` do `.env`), nunca pela UI.
  - Cloudflare Access é **opcional**: se `ACCESS_AUD` e `ACCESS_TEAM_DOMAIN` estiverem configurados, o JWT `Cf-Access-Jwt-Assertion` também é exigido.
- tabela `audit_log` (ator, ação, alvo, detalhe, data);
- usuários (buscar, banir e desbanir com motivo e validade);
- trilha de auditoria;
- interruptor de emergência "somente leitura" (KV `CONFIG`) respeitado pelo middleware de escrita.

#### T3.T · Bateria de testes da Fase 3

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\web\tests\integration\phase3\**`, `D:\git\open-auri\web\tests\e2e\auth.spec.ts`, `D:\git\open-auri\web\tests\e2e\account.spec.ts`

**Casos:**
- **Integração (`@cloudflare/vitest-plugin` com D1 real local):** matriz de autorização anônimo × não verificado × verificado × admin × banido para todas as rotas da F3; fluxos completos com a caixa de e-mail simulada (captura dos links); concorrência (dois resets simultâneos, troca de e-mail concorrente); expirações; idempotência de e-mail; supressão; interruptor somente leitura; cabeçalhos de segurança e CSP em todas as respostas; logs sem PII.
- **E2E:** cadastro → verificação pelo link capturado → entrar → trocar senha → sair das outras sessões → trocar e-mail → exportar → encerrar conta (as duas políticas); nos dois idiomas; teclado e `axe`.
- **Desempenho:** CPU do login medida no `wrangler dev` dentro do limite do PF3.
- **Cobertura:** 90% ou mais de linhas e branches em `D:\git\open-auri\web\src\lib\server\**`.

```
[acceptance]
check: testsPass
criteria: authz matrix complete; full auth/account e2e green; ≥90% coverage on server code; no PII in logs
deliverable: phase 3 test battery
[/acceptance]
```

#### Critérios de aceite da Fase 3

1. Login opcional completo:
   - cadastro com verificação por e-mail (Resend);
   - entrada, saída, recuperação;
   - troca de senha e de e-mail;
   - sessões;
   - exportação;
   - encerramento com escolha de política.
2. Turnstile, rate limit, hash de IP com rotação, cabeçalhos e CSP ativos e testados.
3. Admin protegido por papel + Access; auditoria e modo somente leitura.
4. Páginas legais publicadas; nenhum IP puro persistido.

#### Definition of Done da Fase 3

PF3 aprovado · tarefas verificadas e commitadas · T3.T verde · Q3 PASS (com foco de segurança) · `D:\git\open-auri\docs\lgpd.md` e Docs atualizados · progresso atualizado.

#### Q3 · QA sênior adversarial da Fase 3 `[tier:heavy]`

`[route class=review risk=high scope=repo needs=shell tier=heavy pin]` · `reviewer`

**Foco:**
- bypass de autenticação e autorização;
- fixação e roubo de sessão;
- CSRF;
- enumeração de contas;
- força bruta e evasão de rate limit (troca de IP, cabeçalhos forjados);
- injeção SQL (consultas parametrizadas);
- XSS em perfil e e-mails;
- falsificação de webhook;
- tokens reutilizáveis;
- condições de corrida sem transação no D1;
- vazamento de PII em logs e exportação;
- exclusão incompleta;
- Access desligado em produção.

---

### Fase 4 · Social completo

**Objetivo:** toda a camada social sobre o backend:
- publicação validada, versões e forks;
- biblioteca pessoal e compartilhamentos com funil;
- rastreio com privacidade e rankings;
- perfis, packs, moderação, S6 e S7;
- Comunidade completa e integração nas demais páginas.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| W4.1 | T4.1 | Serial (esquema, repositório, política de exclusão) |
| W4.2 | T4.2, T4.3, T4.4, T4.5, T4.6, T4.7, T4.8, T4.9, T4.10, T4.11 | Paralelo (serviços com arquivos disjuntos) |
| W4.3 | T4.12 | Serial (registro de jobs) |
| W4.4 | T4.13, T4.14, T4.15, T4.16, T4.17, T4.18 | Paralelo (uma página ou área por agente) |
| W4.5 | T4.T | Serial |
| QA | Q4 `[tier:heavy]` | 2 rodadas completas; depois só major, critical e blocking (0.5) |

#### PF4 · Pre-flight da Fase 4

`runner` + `researcher`

1. Q3 PASS registrado e `git status` limpo.
2. **Spike de imagem OG:** SVG das bandas → `@cf-wasm/resvg` → PNG 1200×630 no `wrangler dev`. Medir bundle, CPU e fonte embutida.
   - Se reprovar (bundle > 10 MiB, CPU > 2 s ou incompatibilidade), adotar Browser Rendering e registrar.
3. **Spike de CPU do gate no Worker** (grade `full`) para curvas típicas. Se > 1 s, cachear por `curve_id` (planejado) e registrar o valor.
4. **Bibliotecas:**
   - QR (licença, tamanho);
   - Bradley–Terry (implementação própria; validar a fórmula com fonte);
   - sanitização de texto (sem HTML: renderizar como texto puro).
5. **Curiosidade e fonte de Chris Lord-Alge** verificadas.
6. **Mapa de locks:** serviços em arquivos disjuntos e o repositório compartilhado só de leitura na W4.2.

#### T4.1 · Esquema social, repositório e política de exclusão

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:**
- `D:\git\open-auri\web\migrations\0004_social.sql`
- `D:\git\open-auri\web\migrations\0005_s6_s7.sql`
- `D:\git\open-auri\web\migrations\0006_rankings.sql`
- `D:\git\open-auri\web\src\lib\server\social\repo.ts`
- `D:\git\open-auri\web\src\lib\server\social\types.ts`
- `D:\git\open-auri\web\src\lib\server\social\deletion.ts`
- `D:\git\open-auri\web\tests\integration\social\repo\**`

**Subtarefas:**
1. Tabelas (anexo A.2), com índices, `CHECK` e chaves estrangeiras.
2. `repo.ts`: o único ponto de acesso a dados sociais (consultas parametrizadas, `batch()`, paginação por chave, visibilidade sempre aplicada).
3. `deletion.ts`: implementa `ContentDeletionPolicy` da T3.7 para o conteúdo social (anonimizar ou apagar) e estende os testes de exclusão de conta.

```
[acceptance]
check: testsPass
criteria: migrations apply cleanly on fresh and migrated DB; repo enforces visibility; deletion policy covers all social tables
deliverable: D:\git\open-auri\web\src\lib\server\social\repo.ts and migrations 0004–0006
[/acceptance]
```

#### Serviços de API (W4.2, em paralelo; cada um é dono do seu serviço, das suas rotas e dos seus testes)

Contratos obrigatórios em todos os serviços:
- validação de entrada com schema;
- `requireVerified` em escrita;
- Turnstile onde indicado;
- rate limit;
- interruptor somente leitura;
- auditoria nas ações de moderação;
- respostas e erros com códigos estáveis;
- cache com ETag e `Cache-Control` onde indicado.

**T4.2 · Curvas, versões e forks**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required
- **W:** `D:\git\open-auri\web\src\lib\server\social\curves.ts`, `D:\git\open-auri\web\src\routes\api\v1\curves\**`, `D:\git\open-auri\web\src\routes\api\v1\lineages\**`, testes
- **Escopo:**
  - **Publicação** (S5 + S1, validados pelo núcleo): gate no servidor com os mesmos códigos de motivo, curva identificada por `curve_id` e gate cacheado com `gate_ver`.
  - **Visibilidade e licença:** privado, não listado ou público; licença CC0 ou CC-BY.
  - **Versões e forks:** nova versão com `parent == head` (409 se divergir); fork; retirada (lápide); restauração pelo dono.
  - **Limites:** cota diária por usuário; texto normalizado (NFKC, sem bidi, sem URL).

**T4.3 · Biblioteca pessoal e favoritos**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\server\social\library.ts`, `D:\git\open-auri\web\src\routes\api\v1\me\library\**`, `D:\git\open-auri\web\src\routes\api\v1\curves\[id]\favorite\**`, testes
- **Escopo:**
  - **Listagens:** criações (todas as visibilidades), favoritos e instaladas, com paginação e filtros.
  - **Favoritar e desfavoritar** de forma idempotente.
  - **Mesclagem da biblioteca local** (lote com deduplicação por `curve_id`/`canonKey`, relatório de conflitos).

**T4.4 · Rastreio de atividade e privacidade**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\server\social\activity.ts`, `D:\git\open-auri\web\src\routes\api\v1\curves\[id]\activity\**`, `D:\git\open-auri\web\src\routes\api\v1\me\activity\**`, testes
- **Escopo:**
  - **Eventos:** `previewed` (≥ 10 s) e `installed` (só gravação real), deduplicados por usuário e linhagem, com primeira e última vez.
  - **Para o autor:** contagens públicas e lista nominal só de perfis públicos, com "N pessoas com perfil privado".
  - **Para o usuário:** vê e apaga a própria atividade.
  - **Outbox:** eventos offline aceitos com data limitada (até 7 dias).

**T4.5 · Compartilhamentos e `/c/[id]`**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\server\social\shares.ts`, `D:\git\open-auri\web\src\routes\api\v1\shares\**`, `D:\git\open-auri\web\src\routes\c\[id]\**`, `D:\git\open-auri\web\src\lib\components\pages\shared-curve\**`, testes e staging
- **Escopo:**
  - **Compartilhar:** criar compartilhamento (canal opcional) e link `/c/[id]?s=<shareId>`.
  - **Funil:** aberturas anônimas agregadas por dia; prévias, instalações e favoritos atribuídos.
  - **Página `/c/[id]`:** SSR com metatags OG (imagem da T4.7), ficha no tema Biblioteca e ações (ouvir, abrir na Curva, favoritar, instalar via checklist). O fallback `#p=` funciona sem API.

**T4.6 · Rankings**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\server\social\rankings.ts`, `D:\git\open-auri\web\src\routes\api\v1\rankings\**`, `D:\git\open-auri\workers\jobs\src\jobs\rankings.ts`, testes
- **Escopo:**
  - **Métricas e janelas:** mais favoritadas e mais instaladas por usuários verificados distintos; janelas 7 dias, 30 dias e sempre.
  - **Materialização:** job a cada 15 minutos; leitura com cache de 60 s.
  - **Exclusões:** privado, oculto, retirado, reprovado no gate e contas banidas.
  - **Desempate:** determinístico.

**T4.7 · Imagens OG e QR**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\server\og\**`, `D:\git\open-auri\web\src\routes\og\[id].png\+server.ts`, `D:\git\open-auri\web\src\lib\qr\**` (se não criado na T2.11; senão só leitura), `D:\git\open-auri\web\static\og-font\**`, testes
- **Escopo:**
  - **Geração:** SVG determinístico (antes e depois, nome, licença, marca open-auri) → PNG pela opção decidida no PF4.
  - **Armazenamento:** R2 `og/<curveId>-<versionId>.png`, gerado na publicação via `waitUntil`, com cache imutável.
  - **Proibido:** imagem enviada pelo usuário.

**T4.8 · Moderação**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\server\social\moderation.ts`, `D:\git\open-auri\web\src\routes\api\v1\reports\**`, `D:\git\open-auri\web\src\routes\admin\moderacao\**`, testes e staging
- **Escopo:**
  - **Denúncias** com motivo e Turnstile.
  - **Ocultação automática** (3 contas verificadas distintas com 3 dias ou mais).
  - **Fila admin:** ocultar, restaurar, retirar, banir autor, marcar "curadoria".
  - **Auditoria.**

**T4.9 · S6 preferência anônima**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\server\social\s6.ts`, `D:\git\open-auri\web\src\routes\api\v1\s6\**`, `D:\git\open-auri\workers\jobs\src\jobs\s6-aggregate.ts`, testes
- **Escopo:**
  - **Lote:** sem conta e sem IP (só dia, versão do consentimento e pares); recibo aleatório para exclusão.
  - **Agregação:** Bradley–Terry diária → JSON público em R2 → "Comunidade prefere".
  - **Proteções:** Turnstile e limite por hash de IP (não persistido no lote).

**T4.10 · S7 troca às cegas**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\server\social\trades.ts`, `D:\git\open-auri\web\src\routes\api\v1\trades\**`, `D:\git\open-auri\workers\jobs\src\jobs\trades-expire.ts`, testes
- **Escopo:**
  - **Participação:** usuário verificado com curva aprovada no gate; uma troca ativa por usuário.
  - **Pareamento atômico:** `UPDATE … WHERE status='waiting'` em `batch`, com teste de corrida.
  - **Revelação** depois que os dois dão nota.
  - **Expiração** em 72 h.
  - **Médias** por linhagem.

**T4.11 · Perfis e packs**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\server\social\profiles.ts`, `D:\git\open-auri\web\src\lib\server\social\packs.ts`, `D:\git\open-auri\web\src\routes\api\v1\users\**`, `D:\git\open-auri\web\src\routes\api\v1\packs\**`, `D:\git\open-auri\web\src\routes\u\[apelido]\**`, `D:\git\open-auri\web\src\lib\components\pages\perfil\**`, testes e staging
- **Escopo:**
  - **Perfil público e biblioteca pública (opt-in):** página `/u/[apelido]` no tema Chris Lord-Alge (coleção assinada, sem marcas).
    - Com `library_visibility = 'public'`: mostra a biblioteca criada pelo usuário (criações e packs públicos, com filtros, ordenação e prévia A/B) e, se `activity_visibility = 'public'`, os favoritos públicos.
    - Com a opção desligada: mostra só o apelido e contagens agregadas.
    - Apelidos antigos redirecionam por 90 dias. A API respeita as mesmas regras.
  - **Packs (S9):** criar, editar ordem, licença por curva, visibilidade.

#### T4.12 · Registro de jobs

`[route class=mechanical risk=medium scope=multi needs=edit,shell]` · `general` (fila) · VERIFY:required

**W:** `D:\git\open-auri\workers\jobs\src\index.ts`, `D:\git\open-auri\workers\jobs\wrangler.template.jsonc`

**Conteúdo:** registrar `rotate-salt` (diário), `rankings` (15 min), `s6-aggregate` (diário) e `trades-expire` (horário), com crons em UTC, idempotência e logs estruturados.

#### UI social (W4.4, em paralelo)

**T4.13 · Comunidade `/comunidade` (Bob Clearmountain)**
- `[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required
- **W:** `D:\git\open-auri\web\src\routes\comunidade\**`, `D:\git\open-auri\web\src\lib\components\pages\comunidade\**`, testes e staging
- **Escopo:**
  - **Console:** feed por canais (recentes, mais favoritadas e mais instaladas por janela), com tiras de identificação, avatar de curva (S8) e LEDs ao vivo da cadeia do canal ao tocar.
  - **Escopo mestre:** S4 + A/B.
  - **Total Recall:** versões, diff e restauração para o dono.
  - **"NO AR / Publicar":** login exigido, gate, licença, S5/S1 e lâmpada ligada só quando aprovado.
  - **Painéis:** compartilhar (S10/S8); S6 (consentimento); S7 (entrar na fila, avaliar, revelar); packs; denunciar; "Comunidade prefere".
  - **Sem conta:** navegar e ouvir funcionam; ações pedem login.

**T4.14 · Biblioteca: "Minha biblioteca"**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\biblioteca\**`, `D:\git\open-auri\web\src\lib\components\pages\biblioteca\**`, testes e staging
- **Escopo:**
  - **Prateleiras pessoais:** criações (com visibilidade), favoritos, instaladas e packs.
  - **Público da curva:** para cada criação, quem experimentou, instalou e favoritou, respeitando a privacidade.
  - **Funil por compartilhamento.**
  - **Sincronização:** banner de mescla da biblioteca local ao entrar; consumo da outbox.

**T4.15 · Curva: ações sociais**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\+page.svelte`, `D:\git\open-auri\web\src\lib\components\pages\curva\**`, testes e staging
- **Escopo:** salvar na biblioteca, publicar, favoritar a curva atual de origem comunitária, compartilhar (link curto), evento `previewed` (≥ 10 s) pela outbox.

**T4.16 · Cabo e Teste cego: eventos e S6**
- `[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\cabo\**`, `D:\git\open-auri\web\src\lib\components\pages\cabo\**`, `D:\git\open-auri\web\src\routes\teste-cego\**`, `D:\git\open-auri\web\src\lib\components\pages\teste-cego\**`, `D:\git\open-auri\web\src\lib\cable\outbox-bridge.ts`, testes e staging
- **Escopo:**
  - `cable:written` real → evento `installed` (outbox);
  - envio S6 com prévia exata do payload e recibo;
  - candidatos vindos da Comunidade.

**T4.17 · Comparar e Soe como X: ações sociais**
- `[route class=implement risk=low scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\routes\comparar\**`, `D:\git\open-auri\web\src\lib\components\pages\comparar\**`, `D:\git\open-auri\web\src\routes\soe-como-x\**`, `D:\git\open-auri\web\src\lib\components\pages\soe-como-x\**`, testes e staging
- **Escopo:** carregar curvas da comunidade e da biblioteca nas pistas e alvos; salvar e publicar resultados (com receita S5 do solver).

**T4.18 · Documentação de contas, social e API**
- `[route class=implement risk=low scope=multi needs=edit,shell]` · `implementer`
- **W:** `D:\git\open-auri\web\src\lib\content\docs\**`, `D:\git\open-auri\docs\api.md`, `D:\git\open-auri\docs\social.md`
- **Escopo:**
  - seções da Docs: contas, privacidade da atividade, rankings, moderação, S6, S7;
  - `docs\api.md` com todos os endpoints v1 (contratos, erros, limites);
  - `docs\social.md` atualizado (login no lugar da identidade por dispositivo; S7 ativo).

#### T4.T · Bateria de testes da Fase 4

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\web\tests\integration\phase4\**`, `D:\git\open-auri\web\tests\e2e\social.spec.ts`, `D:\git\open-auri\web\tests\e2e\community.spec.ts`, `D:\git\open-auri\web\tests\integration\gate-parity.test.ts`

**Casos de integração:**
- **Autorização:** matriz anônimo × não verificado × verificado × dono × admin × banido para todos os endpoints v1.
- **Paridade do gate** navegador × servidor (mesmos códigos) em corpus com mais de 500 curvas, incluindo fronteiras.
- **Visibilidade:** curva privada nunca aparece em feed, ranking, OG, perfil, busca, compartilhamento de terceiros ou exportação de terceiros.
- **Versões:** concorrência (409).
- **Retirada e lápide** com forks preservados.
- **Favoritos** idempotentes.
- **Atividade:** deduplicação, janelas, perfis privados fora da lista nominal, exclusão da própria atividade.
- **Rankings:** empates; janelas; exclusões (oculto, banido, retirado, reprovado no gate); recalculo idempotente.
- **Funil** com anônimos agregados.
- **OG:** determinismo (mesmo SVG gera o mesmo PNG), chaves no R2, cache.
- **Moderação:** limiar com contas novas (não conta) e restauração.
- **S6:** sem consentimento recusa; recibo apaga; nenhum IP persiste.
- **S7:** corrida de dois `join` simultâneos, expiração, revelação.
- **Exclusão de conta:** cascata nas duas políticas.
- **Proteções gerais:** cotas e rate limits; XSS em todos os textos (renderização como texto); confundíveis em handles; paginação estável; modo somente leitura.

**Caso E2E:**
1. Usuário A publica.
2. Compartilha o link.
3. Usuário B abre `/c/[id]` (OG presente), ouve 10 s (experimentou), favorita e instala via stub HID (instalou).
4. Os rankings refletem a atividade após o job.
5. A vê o público respeitando a privacidade de B (privado: contagem; público: nome).
6. B apaga a própria atividade e as contagens caem.
7. Biblioteca local mesclada no login.
8. S7 completo entre A e B.
9. Denúncias por 3 contas ocultam; o admin restaura.

**Cobertura:** 90% ou mais em `D:\git\open-auri\web\src\lib\server\social\**` e no Worker de jobs.

```
[acceptance]
check: testsPass
criteria: authz matrix, gate parity, privacy invariants, rankings, S6/S7, deletion cascade, full social e2e green; ≥90% coverage
deliverable: phase 4 test battery
[/acceptance]
```

#### Critérios de aceite da Fase 4

1. Publicação, versões, forks e retirada funcionando, com gate no servidor.
2. Biblioteca pessoal completa, com mesclagem local.
3. Compartilhamentos com funil.
4. Rastreio de quem experimentou, instalou e favoritou, com privacidade correta.
5. Rankings de mais favoritadas e mais instaladas por janela.
6. Perfis e packs.
7. Moderação com auditoria.
8. S6 anônimo e S7 funcionando.
9. Comunidade completa; as demais páginas integradas; a Docs cobre contas, social e API.

#### Definition of Done da Fase 4

PF4 aprovado · tarefas verificadas e commitadas · T4.T verde · Q4 PASS · `D:\git\open-auri\docs\api.md` e `D:\git\open-auri\docs\social.md` atualizados · progresso atualizado.

#### Q4 · QA sênior adversarial da Fase 4 `[tier:heavy]`

`[route class=review risk=high scope=repo needs=shell tier=heavy pin]` · `reviewer`

**Foco:**
- IDOR em todos os IDs;
- vazamento de curva privada por qualquer canal;
- manipulação de rankings (contas múltiplas, eventos forjados, replay da outbox);
- desanonimização do S6;
- corrida no S7;
- publicação de curva perigosa por qualquer caminho (inclusive via fork e versão);
- XSS, SSRF (nenhum fetch de URL do usuário) e injeção;
- custo e abuso do OG;
- privacidade da atividade;
- cascata de exclusão.

---

### Fase 5 · Produção, operação e aceite global

**Objetivo:** CI/CD, observabilidade, backups, endurecimento, documentação operacional, testes de carga, deploy de staging e de produção, QA global.

| Wave | Tarefas | Paralelismo |
|---|---|---|
| W5.1 | T5.1, T5.2, T5.3, T5.4, T5.5, T5.6 | Paralelo |
| W5.2 | T5.7 | Serial (registro final de jobs + staging) |
| W5.3 | T5.T | Serial |
| W5.4 | T5.8 | Serial (produção; requer entradas humanas) |
| QA | QG `[tier:heavy]` (global) | 2 rodadas completas; depois só major, critical e blocking (0.5) |

#### PF5 · Pre-flight da Fase 5

`runner`

1. Q4 PASS registrado e `git status` limpo.
2. **Entradas humanas** (seção 13):
   - **Para o staging:** nada além do OAuth do operador (Workers Paid confirmado).
   - **Para a produção:** campos `PUBLIC_LGPD_*` e `PUBLIC_POLICY_EFFECTIVE_DATE` preenchidos (Q-LEGAL-FIELDS).
   - **Opcionais** (não bloqueiam): H-CF-TOKEN (deploy pelo GitHub) e H-ACCESS (Access no `/admin`).
   - O que faltar: executar W5.1, W5.2 (exceto deploy) e W5.3 localmente, depois parar com o bloqueio documentado antes do deploy.
3. **Recursos:** `npx wrangler whoami` confirmando que a conta ativa é a de `CLOUDFLARE_ACCOUNT_ID`. Criar e confirmar D1 (staging e prod), R2, KV e rate limits com nomes prefixados `open-auri-`. Segredos via `D:\git\open-auri\tools\sync-secrets.mjs` (nunca em arquivo versionado).
4. **Origem e HTTPS:** `https://open-auri.<subdominio>.workers.dev` (HTTPS automático do workers.dev; o WebHID exige contexto seguro). Quando houver o `.com`, rota customizada + DNS.

#### T5.1 · CI/CD

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\.github\workflows\ci.yml`, `D:\git\open-auri\.github\workflows\deploy.yml`, `D:\git\open-auri\tools\deploy.mjs`, `D:\git\open-auri\tools\grant-admin.mjs`, `D:\git\open-auri\docs\deploy.md`

**Pipeline:**
- **CI em PR e push** (GitHub Actions): lint, typecheck, testes do núcleo com cobertura, unidade e integração web, build com `PUBLIC_*` fictícias, e2e (Chrome), auditoria de dependências e varredura de segredos.
- **Deploy pela máquina do operador** (padrão; usa o OAuth já logado): `node --env-file=D:\git\open-auri\.env D:\git\open-auri\tools\deploy.mjs --env staging|production`. O script faz, nesta ordem, parando no primeiro erro:
  1. confere que a conta ativa é a de `CLOUDFLARE_ACCOUNT_ID`;
  2. roda `check:sensitive`, os testes e o build com as `PUBLIC_*` reais;
  3. gera os `wrangler.jsonc` e sincroniza os segredos;
  4. cria um bookmark do Time Travel;
  5. aplica as migrações;
  6. faz o deploy do web e dos jobs;
  7. roda o smoke.

  Em produção exige confirmação explícita (`--confirm-production`).
- **Deploy pelo GitHub** (`deploy.yml`): o mesmo fluxo. Só roda se existir o segredo `CLOUDFLARE_API_TOKEN` (H-CF-TOKEN, opcional); as `PUBLIC_*` reais vêm dos segredos do repositório.
- **Grant de admin:** `D:\git\open-auri\tools\grant-admin.mjs` atribui o papel `admin` ao usuário de `ADMIN_EMAIL` (já verificado) via D1 remoto e registra na auditoria.

#### T5.2 · Observabilidade

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`

**W:** `D:\git\open-auri\web\src\lib\server\observability\**`, `D:\git\open-auri\docs\operacao.md` (seção observabilidade)

**Conteúdo:**
- logs estruturados sem PII (id de requisição, rota, latência, status, código de erro);
- métricas no Analytics Engine: rejeições do gate por motivo, cadastros, falhas de e-mail, 5xx, denúncias, jobs;
- alertas por limiar (documentados);
- Workers Logs habilitado.

#### T5.3 · Backups, exportação e dump público

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer`

**W:** `D:\git\open-auri\workers\jobs\src\jobs\backup.ts`, `D:\git\open-auri\workers\jobs\src\jobs\public-dump.ts`, `D:\git\open-auri\workers\jobs\src\jobs\cleanup.ts`, `D:\git\open-auri\docs\operacao.md` (seção backups), testes

**Conteúdo:**
- export semanal do D1 para R2 (retenção de 12 semanas). Os registros de acesso ficam no prefixo `access-log/` do R2 e não entram em nenhum backup;
- dump público semanal: curvas públicas, versões, licenças e agregados, com o apelido do autor só para a atribuição CC-BY. Sem e-mail, sem atividade nominal, sem hashes;
- **job de limpeza diário** (`cleanup.ts`), alinhado às retenções de `D:\git\open-auri\docs\lgpd.md`:
  - sessões e tokens expirados;
  - `access_log` com mais de 6 meses (se ativo);
  - supressões de e-mail com mais de 12 meses;
  - auditoria com mais de 5 anos;
  - pares brutos S6 com mais de 24 meses (os agregados ficam);
  - reservas de apelido vencidas;
  - lápides antigas sem forks;
- runbook de restauração (Time Travel + export), testado em staging.

#### T5.4 · Endurecimento de segurança

`[route class=implement risk=high scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\web\src\lib\server\security\headers.ts`, `D:\git\open-auri\web\svelte.config.js` (pela fila), `D:\git\open-auri\docs\seguranca.md`

**Conteúdo:**
- CSP estrita com nonces e sem `unsafe-inline` (verificar worklets, workers e Turnstile);
- `Permissions-Policy` com `hid=(self)`;
- revisão de dependências (licenças compatíveis com AGPL, vulnerabilidades);
- varredura de segredos;
- modelo de ameaças documentado;
- interruptor de emergência testado.

#### T5.5 · Documentação e runbooks

`[route class=implement risk=low scope=multi needs=edit]` · `implementer`

**W:** `D:\git\open-auri\README.md`, `D:\git\open-auri\CONTRIBUTING.md`, `D:\git\open-auri\docs\operacao.md` (seções restantes), `D:\git\open-auri\docs\README.md` (pela fila)

**Conteúdo:**
- README do produto (o que é, segurança, desenvolvimento local, testes, deploy, licença, aviso);
- CONTRIBUTING (regras de commit; sem `Co-Authored-By`);
- runbooks: moderação, incidente, exclusão LGPD manual, rotação de segredos (incluindo `ACCESS_LOG_KEY` com versão), modo somente leitura, atendimento de ordem judicial (registros de acesso);
- runbook **"Ativação do .com"**, executável pelo agente com as permissões disponíveis:
  1. zona do domínio na conta;
  2. rota customizada dos Workers e redirecionamento 301 do workers.dev;
  3. `PUBLIC_ORIGIN` novo;
  4. domínios do widget Turnstile;
  5. domínio de envio no Resend via API (`POST /domains`, subdomínio `mail.<dominio>`) e registros DNS na zona;
  6. verificação;
  7. `RESEND_FROM` novo;
  8. `SIGNUP_ENABLED=true`;
  9. novo deploy e smoke.

#### T5.6 · Desempenho e carga

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer`

**W:** `D:\git\open-auri\web\tests\load\**`, `D:\git\open-auri\docs\operacao.md` (seção capacidade)

**Conteúdo:**
- carga com `npx autocannon` em staging (feed, `/c/[id]`, rankings, publicação com Turnstile de teste);
- metas: p95 < 300 ms nas leituras cacheadas e < 1,5 s na publicação (gate cacheado);
- relatório de capacidade versus o Workers Paid.

#### T5.7 · Registro final de jobs e deploy de staging

`[route class=mechanical risk=high scope=multi needs=edit,shell,network]` · `general` · VERIFY:required

**W:** `D:\git\open-auri\workers\jobs\src\index.ts`, `D:\git\open-auri\workers\jobs\wrangler.template.jsonc`

**Conteúdo:** registrar `backup`, `public-dump` e `cleanup`; deploy de staging (web + jobs) na conta de `CLOUDFLARE_ACCOUNT_ID`, com segredos via `D:\git\open-auri\tools\sync-secrets.mjs`; migrações; smoke automatizado (Playwright contra a URL de staging).

Também via API:
- **Webhook do Resend:** eventos de bounce e complaint para `/api/webhooks/resend`; o segredo é salvo no `.env` (`RESEND_WEBHOOK_SECRET`) e no Worker.
- **Access, se houver H-ACCESS:** aplicação self-hosted para `/admin` com política por `ADMIN_EMAIL`.
- **Turnstile:** atualizar os domínios do widget se a origem mudar.

#### T5.T · Bateria de testes da Fase 5

`[route class=implement risk=medium scope=multi needs=edit,shell]` · `implementer` · VERIFY:required

**W:** `D:\git\open-auri\web\tests\e2e\staging.spec.ts`, `D:\git\open-auri\web\tests\integration\phase5\**`

**Casos:**
- e2e completo contra staging: auth com e-mail real do Resend para caixa de teste, ou caixa controlada; social; cabo com stub; offline; i18n;
- restauração de backup em staging;
- dump sem PII (varredura automatizada);
- CSP sem violações (relatório);
- cabeçalhos;
- jobs executados e idempotentes;
- modo somente leitura.

#### T5.8 · Deploy de produção

`[route class=other risk=high scope=repo needs=shell,network]` · `general` · VERIFY:required

- **Requisitos:** campos `PUBLIC_LGPD_*` e `PUBLIC_POLICY_EFFECTIVE_DATE` preenchidos no `.env` (feito pelo operador; o build de produção confere).
- **Execução:** usa o OAuth do operador via `D:\git\open-auri\tools\deploy.mjs --env production --confirm-production`.
- **Cadastro:** sobe com `SIGNUP_ENABLED=false` até a ativação do `.com`.

**Conteúdo:** promoção manual aprovada, migrações com bookmark, deploy, smoke em produção (sem criar dados reais, exceto a conta de teste removida no final), registro no progresso, tag `v1.0.0`.

---

### Fase H · Validação em hardware (condicionada à chegada do cabo; fora da execução contínua)

Inicia por pedido do humano.

- **Ferramenta de bancada** separada (não pública): sondas B1 → B4 → B7, depois B10, B12, B13.
- **Regras de segurança** de `D:\git\open-auri\docs\probing.md`.
- **Resultado esperado:** liberar ou ajustar os itens EM BREVE (leitura, RAM, X2 no cabo, biquad cru) e calibrar o gate com medições reais.
- **Ciclo:** PF, testes, QA heavy e DoD próprios, no mesmo formato das fases.

---

## 8. Critérios de aceite globais

1. **Invariantes:** todos os itens de 0.12 verificados por teste automatizado e pelo QG.
2. **Paridade:** 11 presets byte a byte; Neutro 0x4FFF; gate igual entre núcleo, navegador e servidor em corpus com mais de 500 curvas.
3. **Páginas:** as 8 páginas temáticas, mais conta, autenticação, perfil, curva compartilhada, admin e legais, funcionais em pt-BR e en-US, com rodapé completo (GitHub abaixo do aviso legal).
4. **Áudio e medidores:** MP3 local em todas as prévias e no teste cego; medidores fiéis (conformidade) e nunca decorativos.
5. **Conta:** login opcional completo (verificação, recuperação, troca de senha e e-mail, sessões, exportação, encerramento).
6. **Social completo:** biblioteca, compartilhamentos com funil, rastreio com privacidade, rankings de favoritadas e instaladas, perfis, packs, moderação, S6, S7.
7. **Qualidade:**
   - offline;
   - WCAG 2.2 AA (`axe` limpo);
   - orçamentos de desempenho;
   - CSP estrita;
   - nenhum IP puro persistido;
   - LGPD documentada.
8. **Produção:** CI/CD verde; staging e produção no ar (sujeito às entradas humanas); backups testados; runbooks.

## 9. Definition of Done global

- F1 a F5 com DoD cumprido e QA PASS em cada fase.
- QG aprovado conforme 0.5.
- Testes verdes:
  - núcleo com cobertura de 95% ou mais;
  - código de servidor com 90% ou mais;
  - `web\src\lib` com 85% ou mais;
  - e2e desktop e mobile.
- Documentação atualizada: README, CONTRIBUTING, `docs\*.md`, Docs no app, `docs\api.md`, `docs\lgpd.md`, `docs\operacao.md`, `docs\seguranca.md`, `docs\deploy.md`, `docs\s1-format.md`.
- Commits pequenos e rastreáveis por tarefa, nenhum com `Co-Authored-By` ou "Generated with".
- Progresso final com o resumo das decisões tomadas durante a execução e as perguntas abertas restantes.
- Nenhum `TODO` fora da seção 13.

## 10. QA global (QG) `[tier:heavy]`

`[route class=review risk=high scope=repo needs=shell,network tier=heavy pin]` · `reviewer`

Revisão adversarial do sistema inteiro: tudo de Q1 a Q4 de novo, sobre o estado final, mais:
- testes contra staging;
- regressão entre fases;
- coerência entre Docs, `docs\` e o comportamento real;
- auditoria de licenças (AGPL, MIT do AutoEq, OFL das fontes, bibliotecas);
- revisão de texto (sem travessão em pt-BR, marcas, avisos literais);
- privacidade de ponta a ponta (exportação, exclusão, dump, logs).

Achados viram FXG.k e o QG roda de novo conforme 0.5.

---

## 11. Estratégia de testes (resumo)

| Camada | Ferramenta | Local | Meta |
|---|---|---|---|
| Núcleo | `node:test` + `fast-check` | `D:\git\open-auri\test\**` | ≥ 95% linhas, branches e funções |
| Unidade web | Vitest (jsdom; `*.svelte.test.ts` para runes) | `D:\git\open-auri\web\tests\unit\**` | ≥ 85% em `web\src\lib` |
| Integração servidor | `@cloudflare/vitest-plugin` (D1, R2, KV locais) + `@msw/cloudflare` | `D:\git\open-auri\web\tests\integration\**` | ≥ 90% em `web\src\lib\server` e jobs |
| E2E | Playwright (Chrome; desktop 1440, mobile 390; stub `navigator.hid`; `OfflineAudioContext`) | `D:\git\open-auri\web\tests\e2e\**` | Todas as rotas e fluxos críticos |
| A11y | `@axe-core/playwright` | `D:\git\open-auri\web\tests\e2e\a11y.spec.ts` | Sem violações sérias ou críticas |
| Visual | Playwright `toHaveScreenshot` | `D:\git\open-auri\web\tests\e2e\visual.spec.ts` | Referências versionadas |
| Carga | `npx autocannon` | `D:\git\open-auri\web\tests\load\**` | p95 nas metas da T5.6 |

**Casos de borda obrigatórios** (além dos listados por tarefa):
- entradas NaN, ±Infinity, −0 e subnormais;
- strings Unicode maliciosas (bidi, largura zero, confundíveis);
- arquivos vazios, enormes ou corrompidos;
- relógio retrocedendo e virada de dia;
- `localStorage` e IndexedDB cheios ou corrompidos;
- abas concorrentes;
- WebHID ausente ou desconectando;
- `AudioContext` a 96 kHz recusado;
- rede caindo no meio da publicação;
- tokens expirados ou reutilizados;
- corridas de concorrência sem transação no D1.

## 12. Riscos e mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| O gate v2 é semelhança, não prova | Curva aceita que o firmware trate mal | Ressalva na UI e na Docs; gate conservador; FH calibra com medição; interruptor para endurecer limites no servidor (`gate_ver`) |
| Vida útil da flash desconhecida | Desgaste | N2 (espera de 2 s, contadores, aviso); nunca gravar automaticamente; X2 no cabo EM BREVE |
| D1 sem transações | Atomicidade em reset e trocas | Ordem segura de operações; testes de corrida; documentação |
| CPU do hash ou do gate no Worker | Latência e custo | Medição no PF3/PF4; `node:crypto`; gate cacheado por `curve_id` |
| Resend com 100/dia no plano grátis | Falha de verificação em picos | Monitorar; plano pago quando necessário; idempotência; fila de nova tentativa |
| Licença dos presets da Kuba (Q-KUBA-LIC) | Retirada de conteúdo | "Licença a confirmar" visível; catálogo isolado em `D:\git\open-auri\src\catalog\presets.mjs` para remoção rápida |
| Dados do AutoEq embutidos (decisão do usuário) | Pedido de remoção por um dono de dados | Atribuição por fonte; processo de remoção em `D:\git\open-auri\docs\autoeq-data.md`; o pipeline exclui uma fonte num build (`--exclude-source`) |
| Registros de acesso do Marco Civil | Vazamento de dado pessoal sensível ao contexto | Cifrados (AES-GCM, chave versionada), fora de backups e do dump, purga em 180 dias, consulta só por ordem judicial com auditoria |
| Cadastro fechado até o `.com` | A parte social fica só para leitura no lançamento | Runbook "Ativação do .com" automatizado; `SIGNUP_ENABLED` abre o cadastro sem novo desenvolvimento |
| Repositório público com dado sensível | Exposição de dados pessoais ou da empresa | Placeholders e variáveis de ambiente (0.16); `check:sensitive` antes de todo commit e em todo PF; varredura de segredos no CI |
| Abuso sem login nos endpoints anônimos (S6) | Spam | Turnstile, rate limit por hash de IP, agregação robusta |
| Contas múltiplas inflando rankings | Ranking distorcido | Só verificados; deduplicação; janelas; moderação; métricas de anomalia |
| Normas de medição pagas (IEC) | Constantes imprecisas | Fontes secundárias citadas; testes de conformidade; registro no progresso |
| Majors novas ao seguir sempre a última versão (0.14) | Retrabalho ou quebra | Leitura do changelog no PF; migração dentro da fase; bateria completa de testes antes de seguir |
| Paralelismo causando conflitos | Corrupção de arquivos | Locks (seção 6), fila de integração, commits seriais |

## 13. Entradas humanas e perguntas abertas

**Entradas humanas** (só bloqueiam onde indicado):

| ID | Estado | Quando bloqueia |
|---|---|---|
| H-CF | ✅ Conta do operador (`CLOUDFLARE_ACCOUNT_NAME`) logada via OAuth, com Workers Paid confirmado pelo operador. `CLOUDFLARE_ACCOUNT_ID` no `.env` (o mesmo login tem outras contas). | — |
| H-CF-TOKEN | Opcional: token de API com escopo mínimo (permissões abaixo) como segredo `CLOUDFLARE_API_TOKEN` do GitHub, para ativar o deploy pelo Actions. Sem ele, o deploy roda da máquina do operador com o OAuth. | Não bloqueia |
| H-DOMAIN | ✅ Inicial: `https://open-auri.<subdominio>.workers.dev`. Com o `.com` futuro, trocar `PUBLIC_ORIGIN`, os domínios do Turnstile, o Access e o DNS do e-mail. | — |
| H-RESEND | ✅ Chave válida e e-mail de teste entregue. O domínio de envio fica para o `.com` (runbook "Ativação do .com"). O segredo do webhook é gerado quando a T5.7 cria o webhook via API. | Abertura do cadastro ao público (`SIGNUP_ENABLED`) |
| H-TURNSTILE | ✅ Widget `open-auri` criado via OAuth (escopo `challenge-widgets.write`); chaves no `.env` | — |
| H-ACCESS | Opcional. O `/admin` já fica protegido por papel + 2FA obrigatório + sessão recente. Se o operador quiser uma camada extra, ativa o Zero Trust (plano Free, escolhe um nome de time no painel) e a T5.7 cria via API a aplicação self-hosted para `/admin` com política por `ADMIN_EMAIL`. | Não bloqueia |
| H-PUSH | ✅ Autorizado; `gh` logado como `marco-jardim` (ADMIN no repositório) | — |
| H-DPO | ✅ Controlador e canal LGPD definidos pelo operador, em `PUBLIC_LGPD_CONTROLLER` e `PUBLIC_LGPD_CONTACT_EMAIL` no `.env`. Pendente: Q-LEGAL-FIELDS | Publicação da política |

**Permissões do H-CF-TOKEN:**
- **Conta** (restrita à conta do operador (`CLOUDFLARE_ACCOUNT_NAME`)):
  - Workers Scripts: Edit
  - Workers KV Storage: Edit
  - Workers R2 Storage: Edit
  - D1: Edit
  - Account Settings: Read
  - Turnstile: Edit
  - Access: Apps and Policies: Edit
  - Access: Organizations, Identity Providers, and Groups: Read
  - Workers Tail: Read
  - Account Analytics: Read
- **Zona** (só quando existir o `.com`, restrita a ele): Zone Read, Workers Routes Edit, DNS Edit.

**Perguntas abertas** (não bloqueiam a execução; registrar decisões no progresso):

| ID | Pergunta | Padrão adotado até resposta |
|---|---|---|
| Q-MCI | ✅ Resolvida: cumprir o art. 15 (registros de acesso por 6 meses, cifrados, só por ordem judicial; T3.3) | — |
| Q-MAIL-DOMAIN | ✅ Resolvida: esperar o `.com`. Até lá, `SIGNUP_ENABLED=false`. | — |
| Q-LEGAL-FIELDS | ✅ Resolvida: campos preenchidos no `.env` pelo operador. Retenções confirmadas: auditoria 5 anos, pedidos de titulares 5 anos, supressões 12 meses, pares brutos S6 24 meses, registros de acesso 6 meses. | — |
| Q-KUBA-LIC | Autorização da Kuba para presets e descrições | Mostrar com "licença: a confirmar"; o humano pede após o lançamento |
| Q-TARGETS | ✅ Resolvida: medições e alvos do AutoEq embutidos (T2.19) | — |
| Q-D7-HS | D7 cobre reforço HS? | Não: D7 só para PK; HS-boost limitado a +2 dB (recomendação aceita implicitamente) |
| Q-LEGAL | Revisão jurídica do aviso legal, da privacidade e dos termos. Inclui o enquadramento como agente de pequeno porte e se os DPAs da Cloudflare e da Resend trazem as cláusulas-padrão da ANPD. | Textos publicados com essa marcação no progresso |
| Q-2FA | 2FA (TOTP) ou passkeys no futuro | Fora do escopo v1 |

---

## 14. Registro de progresso (modelo)

Criado no PF1 em `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-progresso.md`:

```
# Progresso · open-auri web v1
## Estado
Fase atual: F1 · Wave: W1.2 · Último commit: <hash>
## Locks ativos
| Tarefa | Agente/sessão | W | R | Início |
## Tarefas
| ID | Status (pendente/em voo/verificada/commitada/bloqueada) | Commit | Notas |
## Pre-flights
| PF | Data | Resultado | Evidências |
## QA
| Q | Ciclo | Resultado | Achados → FX |
## Decisões durante a execução
## Bloqueios e perguntas ao humano
```

---

## Anexo A · Especificações de referência

### A.1 API v1 (resumo; contrato completo em `D:\git\open-auri\docs\api.md` na T4.18)

| Método e rota | Auth | Turnstile | Notas |
|---|---|---|---|
| `ALL /api/auth/*` | Better Auth | Sign-up, sign-in, reset, change-email | Fluxos de conta |
| `GET /api/v1/feed?sort=new\|favorites\|installs&window=7d\|30d\|all&cursor=` | — | — | Cache de 60 s |
| `POST /api/v1/curves` | Verificado | — | Publica (gate) |
| `GET /api/v1/curves/:id` · `GET /api/v1/lineages/:id` | — (visibilidade) | — | ETag |
| `POST /api/v1/lineages/:id/versions` · `POST …/fork` · `POST …/retract` · `POST …/restore` | Dono (fork: verificado) | — | 409 se o head divergir |
| `PUT\|DELETE /api/v1/curves/:id/favorite` | Verificado | — | Idempotente |
| `POST /api/v1/curves/:id/activity` | Verificado | — | `previewed` / `installed` |
| `GET /api/v1/curves/:id/audience` | Dono | — | Respeita a privacidade |
| `GET\|DELETE /api/v1/me/activity` · `GET /api/v1/me/library` · `POST /api/v1/me/library/merge` · `GET /api/v1/me/export` | Logado | — | LGPD |
| `POST /api/v1/shares` · `GET /api/v1/shares/:id/stats` · `POST /api/v1/shares/:id/open` | Verificado / dono / — | — | Funil |
| `GET /api/v1/rankings?metric=&window=` | — | — | Materializado |
| `GET /api/v1/users/:apelido` · `GET /api/v1/packs/:id` · `POST\|PUT /api/v1/packs` | — / verificado | — | Perfis e packs |
| `POST /api/v1/reports` | Verificado | Sim | Moderação |
| `POST /api/v1/s6/batches` · `DELETE /api/v1/s6/batches/:receipt` | — | Sim | Anônimo |
| `POST /api/v1/trades` · `POST /api/v1/trades/:id/score` · `GET /api/v1/trades/me` | Verificado | — | S7 |
| `GET /og/:id.png` · `GET /c/:id` | — | — | Cache imutável e SSR |
| `/admin/**` | Admin + Access | — | Auditoria |
| `POST /api/webhooks/resend` | Assinatura svix | — | Supressões |

### A.2 Tabelas D1 (além das do Better Auth)

- `profiles(user_id PK, nickname UNIQUE, nickname_norm UNIQUE, nickname_changed_at, bio, activity_visibility, library_visibility, created_at)`
- `nickname_history(nickname_norm PK, user_id, released_at)` (reserva de 90 dias e redirecionamento)
- `policy_acceptances(user_id, version, accepted_at, PK(user_id, version))`
- `access_log(id, user_id, event, ip_enc, at)`: só se Q-MCI = sim; cifrado; purga em 6 meses
- `email_suppressions(email_hash PK, reason, created_at)`
- `audit_log(id, at, actor_user_id, action, target, detail)`
- `curves(id PK, s1 UNIQUE, canon_key, gate_ver, gate_ok, gate_reasons, level_db, created_at)`
- `lineages(id PK, owner_user_id NULL, forked_from_version, head_version, visibility, status, curated, created_at, updated_at)`
- `versions(id PK, lineage_id, parent_id, curve_id, name, description, license, recipe, lang, created_at)`
- `favorites(user_id, lineage_id, created_at, PK(user_id, lineage_id))`
- `activity(user_id, lineage_id, kind, first_at, last_at, count, PK(user_id, lineage_id, kind))`
- `shares(id PK, lineage_id, version_id, owner_user_id, channel, created_at)`
- `share_events(share_id, day, kind, anon_count, PK(share_id, day, kind))`
- `share_event_users(share_id, user_id, kind, at)`
- `packs(id, owner_user_id, name, description, visibility, created_at)`
- `pack_items(pack_id, lineage_id, position, license)`
- `reports(id, target, reason, note, reporter_user_id, created_at, resolution)` com UNIQUE(`target`, `reporter_user_id`)
- `rankings(metric, window, lineage_id, score, rank, computed_at)`
- `s6_batches(id, receipt_hash, consent_ver, day)`
- `s6_pairs(batch_id, a, b, choice, level_matched)`
- `trades(id, user_id, lineage_id, version_id, status, match_id, score, created_at, expires_at)`

### A.3 Medidores (parâmetros a confirmar no PF2)

| Medidor | Norma | Parâmetros-alvo |
|---|---|---|
| VU | IEC 60268-17 | 99% em 300 ms ± 10%; overshoot conforme a norma; escala −20…+3 VU; referência 0 VU = −18 dBFS (selecionável) |
| PPM tipo I | IEC 60268-10 / DIN 45406 | Integração e retorno conforme a norma (citar a fonte) |
| PPM tipo II | IEC 60268-10 / EBU | Idem |
| True peak | ITU-R BS.1770 anexo 2 | Sobreamostragem até ≥ 192 kHz efetivos; FIR do anexo; dBTP |
| Loudness | ITU-R BS.1770 / EBU Tech 3341 | Ponderação K para a taxa real; M = 400 ms, S = 3 s; LUFS |
| Correlação | Definição normalizada | Janela exponencial de 300 ms (documentada) |

### A.4 Homenagens (curiosidades e fontes nos mocks; Neve e Lord-Alge verificados no PF3/PF4)

| Página | Homenageado | Fonte principal |
|---|---|---|
| Curva | Robert Moog (1934–2005) | https://patents.google.com/patent/US3475623A/en · https://en.wikipedia.org/wiki/Minimoog |
| Biblioteca e `/c/[id]` | Geoff Emerick (1945–2018) | https://en.wikipedia.org/wiki/Geoff_Emerick |
| Comparar | Les Paul (1915–2009) | https://en.wikipedia.org/wiki/Les_Paul#Multitrack_recording |
| Soe como X | Andy Hildebrand | https://priceonomics.com/the-inventor-of-auto-tune/ · https://en.wikipedia.org/wiki/AutoTune |
| Comunidade | Bob Clearmountain (1953–) | https://en.wikipedia.org/wiki/Bob_Clearmountain |
| Teste cego | Floyd Toole e Sean Olive | https://seanolive.blogspot.com/2009/01/video-on-how-we-measure-loudspeaker.html |
| Cabo | Ray Dolby (1933–2013) | https://en.wikipedia.org/wiki/Dolby_noise-reduction_system#Dolby_A |
| Docs e legais | Harry Nyquist (1889–1976) | https://en.wikipedia.org/wiki/Harry_Nyquist · https://en.wikipedia.org/wiki/Nyquist_stability_criterion |
| Login e conta | Rupert Neve (1926–2021) | https://en.wikipedia.org/wiki/Rupert_Neve (verificar no PF3) |
| Perfil | Chris Lord-Alge | https://en.wikipedia.org/wiki/Chris_Lord-Alge (verificar no PF4) |
