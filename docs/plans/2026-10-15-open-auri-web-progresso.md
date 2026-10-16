# Progresso · open-auri web v1

## Estado

Fase atual: F1 · Wave: W1.2 · Último commit: 6384d56

## Locks ativos

| Tarefa | Agente/sessão | W | R | Início |
|---|---|---|---|---|
| T1.2 | implementer heavy | ver mapa | `design\analysis\*` | 2026-10-16 |
| T1.3 | implementer heavy | ver mapa | `docs\social.md` (no W) | 2026-10-16 |
| T1.5 | implementer | ver mapa | — | 2026-10-16 |
| T1.6 | implementer | ver mapa | — | 2026-10-16 |
| T1.7 | implementer | ver mapa | — | 2026-10-16 |
| T1.9 | implementer heavy | ver mapa | — | 2026-10-16 |
| T1.10 | implementer | ver mapa | — | 2026-10-16 |
| T1.11 | implementer heavy | ver mapa | — | 2026-10-16 |

## Mapa de locks da F1 (calculado no PF1)

| Wave | Tarefa | W | R | Conflitos |
|---|---|---|---|---|
| W1.1 | T1.1 | tooling raiz, `design\**`, `docs\README.md` | — | serial |
| W1.2 | T1.2 | `src\safety\{gate,thresholds,policy}.mjs`, `src\dsp\level.mjs`, `tools\gen-thresholds.mjs`, `test\safety\*`, `test\dsp\level.test.mjs` | `design\analysis\*` (estável) | nenhum |
| W1.2 | T1.3 | `src\share\s1.mjs`, `docs\s1-format.md`, `docs\social.md`, `test\share\s1.test.mjs` | — | nenhum |
| W1.2 | T1.4 | `src\share\envelope.mjs`, `schemas\preset-envelope-1.schema.json`, `test\share\envelope.test.mjs` | — | nenhum (S1 consumido por injeção/stub de teste; integração real na T1.T) |
| W1.2 | T1.5 | `src\io\equalizer-apo.mjs`, `test\io\equalizer-apo.test.mjs` | — | nenhum |
| W1.2 | T1.6 | `src\io\measurement.mjs`, `test\io\measurement.test.mjs` | — | nenhum |
| W1.2 | T1.7 | `src\dsp\{distance,iso226}.mjs`, `test\dsp\{distance,iso226}.test.mjs` | — | nenhum |
| W1.2 | T1.8 | `src\catalog\presets.mjs`, `test\catalog\presets.test.mjs` | — | nenhum |
| W1.2 | T1.9 | `src\transport\{webhid,fake-device}.mjs`, `test\transport\webhid.test.mjs` | — | nenhum (gate injetado) |
| W1.2 | T1.10 | `src\policy\{flash,loudness,journal}.mjs`, `test\policy\*` | — | nenhum (`levelDb` injetado) |
| W1.2 | T1.11 | `src\meter\*.mjs`, `test\meter\*` | — | nenhum |
| W1.3 | T1.12 | `src\solver\peq.mjs`, `test\solver\peq.test.mjs` (+ `THIRD_PARTY_NOTICES.md` pela fila) | — | depende de T1.2, T1.6, T1.7 |
| W1.4 | T1.13 | `src\index.mjs`, `src\*\index.mjs`, `package.json`, `types\**`, `docs\README.md`, `THIRD_PARTY_NOTICES.md` | todo `src\` | serial |
| W1.4 | T1.T | `test\integration\*` | todo `src\` | serial |

## Tarefas

| ID | Status | Commit | Notas |
|---|---|---|---|
| PF1 | verificada | — | ver Pre-flights |
| T1.1 | commitada | 6384d56 | allowlist do router_run: orquestrador rodou format:check, types e coverage; corrigiu o script `types` (jsconfig.types.json) |
| T1.2 | pendente | | heavy |
| T1.3 | pendente | | heavy |
| T1.4 | pendente | | |
| T1.5 | pendente | | |
| T1.6 | pendente | | |
| T1.7 | pendente | | |
| T1.8 | pendente | | |
| T1.9 | pendente | | heavy |
| T1.10 | pendente | | |
| T1.11 | pendente | | heavy |
| T1.12 | pendente | | heavy |
| T1.13 | pendente | | |
| T1.T | pendente | | |
| Q1 | pendente | | heavy |

## Pre-flights

| PF | Data | Resultado | Evidências |
|---|---|---|---|
| PF1 | 2026-10-16 | aprovado | HEAD 1e2f241; `git status`: só `design/` não versionado (49 arquivos, ~33,7 MB); Node v24.21.0, npm 12.0.2; `npm test` 59/59 (52 codec + 6 scanner + 1 agregado do `design\analysis\gate.test.mjs` com 53/53 internos); `qa-parity.mjs` 0 falhas (paridade 88/88, Neutro 0x4FFF); `check-sensitive` saída 0; 16 núcleos |

### Versões verificadas (0.14)

| Pacote | Versão | Licença | Data da verificação |
|---|---|---|---|
| node (LTS em uso) | 24.21.0 (LTS mais recente: 24.22.0; Current: 26.12.0) | MIT | 2026-10-16 |
| typescript | 7.0.2 (port nativo) | Apache-2.0 | 2026-10-16 |
| eslint | 10.12.0 | MIT | 2026-10-16 |
| @eslint/js | 10.0.1 | MIT | 2026-10-16 |
| globals | 17.13.0 | MIT | 2026-10-16 |
| prettier | 3.9.10 | MIT | 2026-10-16 |
| fast-check | 4.10.2 | MIT | 2026-10-16 |

### Fatos do `node:test` (PF1.6)

- `--experimental-test-coverage` segue experimental no Node 24/26; `--test-coverage-lines|branches|functions=<n>` encerram com código 1 abaixo do limite; `--test-coverage-include|exclude` aceitam globs repetíveis; `--test-concurrency` tem padrão `availableParallelism() − 1`.
- Globs entre aspas (`node --test "test/**/*.test.mjs"`) são expandidos pelo próprio Node.

### Fontes dos medidores (para a T1.11)

- BS.1770-5 (11/2023, igual à -4 nos coeficientes): ponderação K a 48 kHz (tabelas 1 e 2), offset −0,691, janelas de 400 ms e 3 s; protótipos analógicos para outras taxas pela derivação do libebur128 (MIT), a conferir numericamente contra a tabela.
- BS.1770 anexo 2: FIR polifásico de 48 coeficientes e 4 fases (reconstruído por simetria a partir de extração de texto; conferir na T1.11 que reproduz −6,0 dBTP no teste 15 da EBU Tech 3341). 2× a 96 kHz.
- EBU Tech 3341 (2016): casos 1, 2, 9, 12, 13, 14 (M/S) e 15 (true peak).
- VU: IEC 60268-17 via fontes secundárias (ITU-R BS.2054-4, Wikipedia): 99% em 300 ms, overshoot de 1 a 1,5%. Parâmetros de 2ª ordem derivados (ζ ≈ 0,81), sem fonte primária publicada.
- PPM: IEC 60268-10 é paga. Tipo II pela EBU Tech 3205 (tabela 2); tipo I pela Wikipedia (secundária).
- −14 dBFS como alinhamento: sem fonte encontrada. Mantido como opção do produto (decisão do plano §3.6), rotulado sem citar norma.

## QA

| Q | Ciclo | Resultado | Achados → FX |
|---|---|---|---|

## Decisões durante a execução

- 2026-10-16 · PF1: o router_run recusa `node`, `npm --version` e `check:sensitive` (fora da allowlist). O orquestrador rodou essas checagens direto (0.17). As devDeps da T1.1 são instaladas pelo orquestrador (fila de integração), porque `npm install` não passa pelo router_run.
- 2026-10-16 · Locks: `src\dsp\level.mjs` e `test\dsp\level.test.mjs` passam da T1.7 para a T1.2, porque o gate usa `levelDb` (`autoPreamp`, métricas). Assim o gate não duplica a matemática e as duas tarefas não leem arquivos uma da outra. A T1.7 fica com distância e ISO 226.
- 2026-10-16 · Exports por área (`./dsp`, `./safety`, …) apontam para `src\<área>\index.mjs`. Esses índices são criados na T1.13 (W ampliado).

- 2026-10-16 · W1.2/W1.3: a T1.4 (envelope, valida `code` contra S1) e a T1.8 (catálogo, testa gate e `levelDb`) passam para a W1.3, junto da T1.12, porque leem arquivos em edição na W1.2 (T1.3 e T1.2). A T1.9 e a T1.10 recebem o gate e o `levelDb` por injeção (como no plano) e testam com stubs; a integração real fica na T1.T.
- 2026-10-16 · Códigos de motivo do gate: os do plano (§T1.2) são o contrato estável. `reasons` vira lista de objetos `{code, stage?, value?, limit?}`; os códigos do `design\analysis\gate.mjs` (`d:internal-audible`, `g:preamp-range`, sufixo `:stage-n`) são mapeados no teste de paridade.
- 2026-10-16 · ISO 226: tabela 1 confirmada por duas implementações independentes (IoSR, MIT; gist de referência) e pelo texto da norma até 5 kHz; linhas de 6,3 a 12,5 kHz só pelas implementações. Delta da revisão 2023 documentado (até 0,6 dB).

## Bloqueios e perguntas ao humano

Nenhum.
