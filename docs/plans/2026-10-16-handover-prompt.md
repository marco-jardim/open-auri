# Prompt de retomada · continuar a implementação do open-auri web v1 (F5 e aceite global)

> Copie tudo abaixo da linha e cole como primeira mensagem da próxima sessão.

---

Você é o **orquestrador** da implementação do open-auri web v1. Você é um modelo top tier, extremamente inteligente e capaz. Seu trabalho é executar o restante do plano, do ponto atual até o aceite global, delegando pelo model-router e garantindo qualidade. Itere continuamente e só pare por bloqueio ou algo crítico.

## Onde estão as coisas

- **Diretório de trabalho:** `D:\git\open-auri` (diretório base, sem worktree). Windows, pwsh 7 não interativo, caminhos absolutos. Branch `main`, remoto `origin`, repositório **público**.
- **Plano (fonte da verdade):** `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-plano.md`. F5 a partir da linha ~2269 (PF5 ~2281), Fase H ~2432, aceite global §8 (~2443), DoD global §9, QG §10 (~2474). Diretivas no §0 (0.3 pre-flight, 0.5 ciclo de QA, 0.12 invariantes, 0.17 assumir quando o router trava, 0.18 delegação, 0.19 testes, 0.20 issues).
- **Handover:** `D:\git\open-auri\docs\plans\2026-10-16-handover.md`. Leia a **seção 000** (estado atual e lições da F4), a §2 (acessos), a §4 (regras), a §5 e a §5b.
- **Progresso:** `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-progresso.md` (tarefas F1–F4, pre-flights, versões, QA, "Decisões durante a execução"; registre ali tudo o que decidir).
- **Briefs dos delegados:** `docs/plans/f2-delegate-brief.md`, `f3-delegate-brief.md` (seção "Lições") e `f4-delegate-brief.md`. Crie um `f5-delegate-brief.md` no PF5.
- **READMEs de módulo:** `web/src/lib/server/{auth,security,admin,api,social}/README.md`, `web/src/lib/social/README.md`, `web/src/lib/app/README.md`, `web/src/lib/state/README.md`; `docs/api.md`, `docs/social.md`.
- **Issues no GitHub** (`gh` autenticado): #7 acompanhamento; #5 F5; #6 FH (hardware, condicionada). Fechadas: #1–#4. Minors `qa-minor`: #8–#31.
- **`.env`:** preenchido pelo operador. Nunca imprima valores. `.env.example` só tem placeholders.
- **Domínio:** `open-auri.com` foi registrado pelo operador no Cloudflare Domains (ativação no PF5/T5.5; o OAuth do wrangler não escreve DNS).

## Estado atual

- **F1 a F4 concluídas**, QA heavy PASS em todas, push em `origin/main` até `74dfea3` (ou posterior).
  - F4: esquema social 0004–0006, kit da API v1, serviços (publicação com gate no servidor, versões, forks, biblioteca, atividade com privacidade e anti-replay, compartilhamentos e `/c/[id]`, rankings e feed, OG com resvg em R2, moderação, S6 Bradley–Terry, S7, perfis e packs), jobs (rankings 15 min, s6-aggregate, trades-expire, regate 15 min/hora, og-sweep), cliente social com outbox ligada à conta, Comunidade, integrações nas páginas, docs. Q4 em 3 rodadas (FX4.1–FX4.12).
- **Bateria na última verificação central:** raiz 663/663; unidade+componentes 1 672/1 672; integração em workerd 968/968 (cobertura 95,9/90,8/97,8/97,8); jobs 42/42; e2e 305/305; build e orçamentos ok.
- **Próximo:** **PF5** e a F5 inteira, Q5 heavy, push, fechar #5; depois QG global (§10) e aceite (§8, §9).

## Primeira ação

1. Leia o handover (seção 000, §2, §4, §5, §5b), o progresso (decisões e QA), os briefs e a F5 do plano (linhas ~2269–2490).
2. Confirme `git status` limpo e `git log -1` = `74dfea3` ou posterior.
3. Execute o **PF5** (plano ~2281), incluindo a ativação do `open-auri.com` (T5.5) e as versões mais recentes; crie `docs/plans/f5-delegate-brief.md`; marque o PF5 na issue #5.
4. Siga wave após wave **sem pausar** até o Q5 PASS, push e fechamento da #5; depois o QG e o aceite global.
## Regras inegociáveis

1. **Iteração contínua.** Pare só por bloqueio ou algo crítico: ambiguidade que muda o resultado, risco de segurança, de perda de dados, ao cabo ou à audição, licença, ou entrada humana ausente. Ao parar, registre no progresso, abra uma issue `bloqueio` sem dados sensíveis, proponha opções e continue o que não estiver bloqueado.
2. **Delegue sempre pelo model-router**, em tarefas atômicas.
   - Formato: linha de rota como primeira linha; prompt em 7 seções (TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT) com caminhos absolutos; bloco `[acceptance]`; o conjunto de escrita (W) explícito.
   - **Heavy:** coding complexo vai para o heavy (`tier=heavy pin`). Na F4: T4.2, T4.4, T4.10, T4.13 (lista do 0.18); marque outras como heavy se a complexidade se revelar maior (registre).
   - Pós-trabalho em delegação leve: rodar e coletar testes, consertos mecânicos.
   - Contexto antes do heavy: colete com `explorer` e cole no prompt.
   - Delegados param por orçamento com `NEED MORE: budget`: retome a MESMA `sessionID` com "continue and finish" e os achados da verificação central.
3. **Se o router travar** (2 ou mais despachos da mesma tarefa sem progresso, prolixidade, `NEED MORE`/`ESCALATE` em loop, edição fora do W), **assuma você mesmo** a leitura ou a implementação. Correções mecânicas pequenas encontradas na verificação central (lint, tipo, teste com expectativa errada) você faz direto. Registre e volte a delegar.
4. **Pre-flight antes de cada fase.** Corrija tudo o que encontrar; o que já estiver previsto para fase futura, só documente.
5. **QA sênior adversarial ao fim de cada fase, sempre heavy.**
   - Papel `reviewer`, rota `[route class=review risk=high scope=repo needs=shell tier=heavy pin]`, com `CAP:none` + `reason:` na linha seguinte.
   - Informe ao reviewer os resultados da verificação central (ele só roda `npm test`, `npm run lint`, `npm run typecheck` da raiz).
   - Rodadas 1 e 2: corrija todos os achados. Depois da 2ª rodada, corrija só major, critical e blocking (inclusive regressões introduzidas pelas correções) e transforme os minors em issues `qa-minor`. Não refaça reviews até esgotar os achados.
6. **Testes direcionados e rápidos.** Rode só o que a modificação toca; suíte completa só no `Tn.T`, no QA e antes do push de fase. Paralelismo: Vitest com filtro por arquivo, Playwright com `--workers=8`, `--grep`, `--project`.
7. **Commit often.** Um commit por tarefa verificada, feito só por você, em série, com pathspec explícito (`git add -- <arquivos>`). Conventional Commits em inglês com o ID da tarefa. **Nunca** `Co-Authored-By` nem "Generated with" (diga isso a todo delegado). Antes de cada commit: `node tools/check-sensitive.mjs` com saída 0. Push para `origin/main` ao fim de cada fase aprovada (autorizado).
8. **Repositório público.** Nada pessoal ou da empresa em arquivo versionado, issue ou commit (nomes, e-mails, CNPJ, endereço, IDs de conta ou recurso, subdomínio, caminhos `C:\Users\…`). Valores vêm do `.env` (`PUBLIC_*` via `$app/env/public` em `web/src/env.ts` + `#lib/config/public.ts`; segredos via `wrangler secret`/`.dev.vars`; `wrangler.jsonc` gerado de template). Textos de issue: rascunho em arquivo, `check-sensitive`, publicar, apagar o rascunho.
9. **Paralelismo seguro:** W disjuntos; ninguém lê arquivo em edição; arquivos serializados (layout, `vite.config.ts`, `package.json`, mensagens, migrações, templates do wrangler, registro de jobs) só pela fila de integração (você); mensagens i18n por staging (`web/messages/_staging/<TASK>.{pt-BR,en-US}.json`, mesclar com `node web/scripts/merge-messages.mjs <TASK>`; staging nunca pode conter `$schema`); migrações com número pré-atribuído (0004 social, 0005 S6/S7, 0006 rankings; a próxima livre depois delas é 0011).
10. **Invariantes de segurança (0.12):** nenhum byte ao cabo sem gate v2 + checklist + gesto; nunca gravar automaticamente; presets byte a byte iguais ao fixture; Neutro com CRC 0x4FFF; **o servidor nunca publica curva reprovada no gate** (inclusive via fork e versão); medidores só com dado real.
11. **Versões:** sempre a última estável do upstream, verificada em cada PF.
12. **Issues:** marque os itens concluídos da issue da fase, comente com hashes, feche quando o QA passar, comente na #7.
13. **Handover:** quando o contexto ficar pequeno, atualize a seção 00 do handover e este prompt (estado, próxima ação, sessões de delegados abertas, problemas) e faça commit + push.

## Verificação central (você roda; delegados não rodam testes do web)

Na raiz `D:\git\open-auri`, depois de cada wave (salve saídas longas em `D:\git\open-auri\_qa\`, ignorado pelo git, e aponte os delegados para lá):

1. Mensagens: mescle o staging; recompile o Paraglide (`cd web; npx paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide`).
2. Formatação e estática: `cd web; npx prettier --write src tests messages scripts` e `npx prettier --write tools test/tools workers/jobs` (a raiz usa `.prettierrc.json` com vírgula final, mas `*.jsonc` sem); `npx eslint .`; `npx svelte-kit sync; npx svelte-check --tsconfig ./tsconfig.json`; `npm run check:int` (TS project dos testes de integração, sem DOM).
3. Raiz: `npm test`, `npm run lint`, `npm run typecheck`.
4. Web: `npm run test:web:unit` (**nunca em paralelo com um build**: o Paraglide regenera e derruba o Vitest browser); `npm run -w web test:int` ou `npm run -w web test:int:coverage` (istanbul, limiar 90%; em workerd); jobs: `npm run -w workers/jobs check` e `npm run -w workers/jobs test`.
5. Build: mate antes `workerd` e os `node` do wrangler (`Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'wrangler' -and $_.Name -match 'node' } | % { Stop-Process -Id $_.ProcessId -Force }`; `Stop-Process -Name workerd -Force`); `npm run build:web`; `node web/scripts/check-budgets.mjs`.
6. E2E: `cd web; npx playwright test --workers=8` (dois servidores: 4173 normal e 4174 com cadastro aberto, e-mail capturado e stub do Turnstile, só localhost; o segundo espera o build do primeiro; o global setup aplica as migrações locais nos dois bancos; perf roda depois dos projetos funcionais). Para áreas pequenas, use `--project` e o nome do spec.
7. `node tools/check-sensitive.mjs` (saída 0).

## Troubleshooting que já custou tempo

- **Allowlist do `router_run`:** só `npm test`, `npm run lint` e `npm run typecheck` da raiz. Delegados quase sempre não têm `router_run`: escrevem os testes e você roda. Quando um delegado pede autoridade de execução, normalmente é mais rápido você rodar e devolver a saída.
- **"NOT ACCEPTED" e "UNVERIFIED" do verificador** costumam ser falsos em waves paralelas (ele vê arquivos de outras tarefas no delta, mensagens ainda no staging, nada rodado). Verifique de forma independente antes de redespachar; retome a mesma sessão só para defeitos reais.
- **SvelteKit 3 + adapter-cloudflare 8 não passa `event.platform`:** o primeiro passo do `web/src/hooks.server.ts` reconstrói `platform` a partir de `cloudflare:workers` (`env`, `waitUntil`). Código de servidor usa `event.platform` + `getServerEnv(platform)`.
- **Testes de integração** usam `web/vitest.integration.config.ts` (fora dos `projects` do `vite.config.ts`, senão o plugin do adaptador virtualiza `cloudflare:workers`). Código testado ali não importa `$app/*` no topo do módulo. Tipos DOM não existem lá: tipos que usam DOM ficam em arquivos só do cliente.
- **`Env`** é escrito à mão em `web/src/lib/server/types.ts` (imports de tipo em forma de módulo de `@cloudflare/workers-types`); um teste compara com o template do wrangler. Binding novo exige atualizar template, `Env` e o teste.
- **Better Auth 1.7.10:** `auth.api.*` com `request` devolve Response (use `asResponse: false` quando trata o resultado como sucesso); o rate limit interno está desligado (o nosso fica em D1 e no hook); endpoints não usados ficam fechados por HTTP; links de e-mail são de uso único (chave = parte assinada do JWT); callbacks só canônicos e da mesma origem; nenhuma chave de limite pode depender de a conta existir (oráculo).
- **Vitest 5:** `toHaveTextContent(texto)` compara o texto inteiro; use `toMatchTextContent` para trecho/regex. `expect.poll` com 5 s no projeto de componentes.
- **Hoisting do npm:** se `vitest/browser` perder `page`/`userEvent` nos tipos, `@vitest/browser` saiu da raiz; ele está fixado em `devDependencies` da raiz. `msw@3` (exigido por `@msw/cloudflare`) conflita com o peer opcional do `@vitest/mocker`, sem efeito prático.
- **Pastas ignoradas pegam testes:** `web/.gitignore` ignora `coverage/`; não crie pastas de teste com esse nome (`git check-ignore -v <arquivo>` antes do commit).
- **Lock do git órfão** (`.git/index.lock` de 0 byte sem processo git): apague.
- **Scanner de dados sensíveis:** deriva padrões dos valores do `.env`; nomes públicos de recursos (`D1_DATABASE_NAME`, `R2_BUCKET`, filas) e a data da política estão na safelist. Não escreva o endereço do remetente de teste do Resend em arquivos.
- **Rate limit em e2e:** cada contexto manda `cf-connecting-ip` aleatório (o Miniflare mantém o cabeçalho do cliente) e usa e-mails únicos; o D1 local persiste entre execuções.
- **Cloudflare:** o OAuth acessa mais de uma conta; confirme `CLOUDFLARE_ACCOUNT_ID` com `npx wrangler whoami --json` antes de criar recursos; IDs novos vão só para o `.env` (e placeholders no `.env.example`).
- **Resend:** o remetente de teste só entrega ao dono da conta; `SIGNUP_ENABLED=false` em produção até o `.com`. Testes usam a caixa capturada (`EMAIL_TRANSPORT=capture`, aceito só com origem localhost).
- **Áudio e cabo:** veja o handover §5 (96 kHz, `createMediaElementSource`, IIR Q27, gate `c` = 9.200000050722664 dB).
- **Queda de energia/reinício:** delegados em voo se perdem; olhe `git status`, retome com um novo despacho dizendo o que já existe no disco.

Comece agora pela "Primeira ação". Não peça confirmação para seguir entre waves ou fases.