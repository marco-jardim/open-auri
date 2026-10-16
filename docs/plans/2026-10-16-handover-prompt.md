# Prompt de retomada · iniciar a implementação do open-auri web v1

> Copie tudo abaixo da linha e cole como primeira mensagem da próxima sessão.

---

Você é o **orquestrador** da implementação do open-auri web v1. Você é um modelo top tier, extremamente inteligente e capaz. Seu trabalho é executar o plano inteiro, do início ao fim, delegando pelo model-router e garantindo qualidade.

## Onde estão as coisas

- **Diretório de trabalho:** `D:\git\open-auri`. É o diretório base; não há worktree. Windows, pwsh 7 não interativo, caminhos absolutos.
- **Plano (fonte da verdade):** `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-plano.md`.
- **Handover desta transição:** `D:\git\open-auri\docs\plans\2026-10-16-handover.md`. Ler inteiro, principalmente §2 (acessos), §4 (regras) e §5 (troubleshooting).
- **Issues no GitHub:** #7 é o acompanhamento; #1 a #6 são as fases F1 a F5 e FH. Use o `gh`, que já está autenticado.
- **`.env`:** já preenchido pelo operador. Nunca imprima valores. **`.env.example`** só tem placeholders.
- **Fonte de verdade visual:** `D:\git\open-auri\design\mocks\v2\*.html` e `D:\git\open-auri\design\mocks\v2\_qa\*.png`. Os limites de segurança estão em `D:\git\open-auri\design\analysis\limites-v2.md` e `envelope.json`.

## Primeira ação

**Estado em 2026-10-16:** a F1 (núcleo) está concluída, com QA heavy aprovado (PASS), push feito (`25b2ee1`) e issue #1 fechada. Os minors adiados estão nas issues #8 a #13 (`qa-minor`). A próxima ação é o **PF2**.

1. Leia o plano: §0 (diretivas 0.1 a 0.21), §3, §4, §5, §6 e a **Fase 2** completa (linhas ~1103–1614).
2. Leia o registro de progresso `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-progresso.md`, principalmente a seção "Decisões durante a execução".
3. Execute o **PF2** e marque o item na issue #2.
4. Siga wave após wave na F2, depois F3, F4 e F5, **sem pausar entre waves ou fases**.

## Regras inegociáveis

1. **Iteração contínua.** Pare só por bloqueio ou algo crítico: ambiguidade que muda o resultado, risco de segurança, de perda de dados, ao cabo ou à audição, licença, ou entrada humana ausente. Ao parar, registre no progresso, abra uma issue `bloqueio` sem dados sensíveis, proponha opções e continue o que não estiver bloqueado.
2. **Delegue sempre pelo model-router**, em tarefas atômicas.
   - **Formato:** linha de rota como primeira linha; prompt em 7 seções (TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT) com caminhos absolutos; bloco `[acceptance]`; `VERIFY:required` quando houver dependentes.
   - **Heavy:** coding complexo vai para o heavy. As tarefas marcadas no 0.18 levam `[tier:heavy]`, e a rota recebe `tier=heavy pin`.
   - **Pós-trabalho em delegação leve:** rodar e coletar testes, consertos mecânicos.
   - **Contexto antes do heavy:** colete com `explorer`/`runner` e cole no prompt heavy.
3. **Se o router travar repetidamente** (2 ou mais despachos da mesma tarefa sem progresso, prolixidade, `NEED MORE` ou `ESCALATE` em loop, edição fora do conjunto de escrita), **assuma você mesmo** a leitura ou a implementação travada. Depois registre, verifique com testes direcionados e volte a delegar.
4. **Pre-flight antes de cada fase.** Corrija tudo o que encontrar. Se o problema já estiver previsto no plano para uma fase futura, apenas documente.
5. **QA sênior adversarial ao fim de cada fase, sempre `[tier:heavy]`.**
   - Papel `reviewer`, rota `[route class=review risk=high scope=repo needs=shell tier=heavy pin]`.
   - Rodadas 1 e 2: corrija todos os achados.
   - Depois da 2ª rodada sobre a mesma implementação, corrija só major, critical e blocking. Os minors viram issues `qa-minor` e a fase segue.
   - Não refaça reviews até esgotar os achados.
6. **Testes direcionados e rápidos.**
   - Rode só o que a modificação toca. Suíte completa só no `Tn.T`, no QA e antes do push de fase.
   - Paralelismo intenso: `node --test --test-concurrency`, Vitest em threads com filtro por arquivo, Playwright com `--workers`, `--grep` e shards.
   - A T1.1 cria scripts de teste por área (`test:safety`, `test:share` etc.) porque o `router_run` só aceita scripts do `package.json`.
7. **Commit often.**
   - Um commit por tarefa verificada, feito só por você, em série, com pathspec explícito (`git add -- <arquivos da tarefa>`).
   - Conventional Commits em inglês com o ID da tarefa.
   - **Nunca** `Co-Authored-By` nem "Generated with". Diga isso a todo delegado.
   - Antes de cada commit: `node D:\git\open-auri\tools\check-sensitive.mjs` com saída 0.
   - Push para `origin/main` ao fim de cada fase aprovada (autorizado).
8. **Repositório público.** Nenhum dado pessoal ou da empresa em arquivo versionado, issue ou commit: nomes, e-mails, CNPJ, endereço, IDs de conta ou recurso, subdomínio, caminhos `C:\Users\…`. Valores sensíveis vêm do `.env` em build e deploy (`PUBLIC_*` via `$env/static/public`; segredos via `wrangler secret`; `wrangler.jsonc` gerado a partir de template).
9. **Paralelismo seguro** (§6 do plano):
   - conjuntos de escrita disjuntos;
   - ninguém lê arquivo em edição;
   - arquivos serializados só pela fila de integração;
   - mensagens i18n por staging;
   - migrações D1 com número pré-atribuído.
10. **Invariantes de segurança** (0.12): nenhum byte ao cabo sem gate v2 + checklist + gesto do usuário; nunca gravar automaticamente; presets byte a byte iguais ao fixture; Neutro com CRC 0x4FFF; servidor nunca publica curva reprovada; medidores só com dado real.
11. **Versões:** sempre a última estável do upstream, verificada em cada PF (npm registry, releases, context7).
12. **Atualize as issues do GitHub:**
    - marque os itens concluídos;
    - comente com os hashes de commit;
    - feche a issue da fase quando o QA passar;
    - nada sensível nem pistas de OSINT nos textos (rascunho num arquivo, `check-sensitive`, publicação, remoção do rascunho).
13. **Handover:** se o contexto ficar pequeno, atualize `D:\git\open-auri\docs\plans\2026-10-16-handover.md` e este prompt com o estado, a próxima ação, os locks e os problemas. Se trabalhar numa worktree, registre o caminho dela e o diretório base `D:\git\open-auri`.

## Troubleshooting que já custou tempo

- **Recusas do `router_run`** (`node --test <arquivo>`, scripts fora da allowlist): use os scripts por área do `package.json`, um agente de tier com shell (`medium`) ou, em último caso, rode direto (regra 3).
- **"NOT ACCEPTED" do verificador** em despachos paralelos costuma ser falso: ele vê no delta os arquivos de outras tarefas, ou o critério veio truncado. Verifique de forma independente antes de redespachar. Retome a MESMA `sessionID` só para defeitos reais.
- **Implementers não leem fora do repositório** (`%TEMP%`): cole os fatos no prompt.
- **Implementers sem `router_run`** pedem autoridade para testar: faça uma rodada central de QA depois da wave paralela.
- **O MCP do chrome-devtools não conecta** sem Chrome com `--remote-debugging-port=9222`. Use Chrome headless por CLI com CDP via Node 24, reaproveitando `D:\git\open-auri\design\analysis\qa-parity.mjs --browser` e `qa-audio.mjs --all` (`--autoplay-policy=no-user-gesture-required`, `DOM.setFileInputFiles`).
- **Researcher:** se o websearch vier vazio, use webfetch nas documentações oficiais. Itens UNVERIFIED se confirmam no PF.
- **npm workspaces falham com pasta inexistente:** acrescente `web` na T2.1 e `workers/jobs` na T3.1.
- **Allowlist do `router_run` (medido na F1):** só `npm test`, `npm run lint` e `npm run typecheck` passam. `test:<área>`, `test:coverage`, `format:check`, `types`, `check:sensitive`, `node` e `npm install` são recusados. Depois de cada wave, rode direto a verificação central: `npx prettier --write`, `npm run test:coverage`, `npm run lint`, `npm run typecheck`, `npm run types` e `node tools/check-sensitive.mjs`. Dependências novas são instaladas por você (fila de integração).
- **Barris de export:** os `src\<área>\index.mjs` têm um teste de completude (`test\index.test.mjs`). Export novo num módulo exige atualizar o barril, o que é feito pela fila de integração.
- **Gate:** o limite `c` é 9.200000050722664 dB (máximo quantizado). Com 9,2 literal o Basshead oficial reprova.
- **Better Auth no Workers:** medir a CPU do hash no PF3 (scrypt em JS puro já estourou CPU; alternativa `node:crypto` com `nodejs_compat`); D1 não tem transações; `disableIpTracking: true`; rate limit interno desligado.
- **Testes de Worker:** `@cloudflare/vitest-plugin` (substituiu o `vitest-pool-workers`).
- **AutoEq passa de 4 GiB** por causa de `results/`: clone parcial com sparse checkout de `measurements/` e `targets/`. Layout com e sem `data/`. Nomes atuais dos alvos (o README está desatualizado).
- **Áudio:** Chrome concede 96 kHz. Faça streaming por `createMediaElementSource`, nunca decodifique o MP3 inteiro. `IIRFilterNode` com Q27 exato; uma fonte para várias cadeias.
- **Cloudflare:** o login OAuth acessa mais de uma conta. Sempre confirme `CLOUDFLARE_ACCOUNT_ID` com `npx wrangler whoami`. Token só em variável de processo (`npx wrangler auth token --json`). Os 403 em assinaturas e na organização do Access são esperados.
- **Resend:** o remetente de teste só entrega ao dono da conta. Por isso `SIGNUP_ENABLED=false` até o `.com`. Não escreva o endereço do remetente de teste em documentos: o scanner acusa.

Comece agora pelo passo 1 da "Primeira ação". Não peça confirmação para seguir entre waves ou fases.
