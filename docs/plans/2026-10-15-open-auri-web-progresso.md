# Progresso · open-auri web v1

## Estado

Fase atual: F1 · Etapa: Q1 (rodada 1) · Último commit: 1811c06

## Locks ativos

| Tarefa | Agente/sessão | W | R | Início |
|---|---|---|---|---|
| Q1 | reviewer heavy | — (só leitura) | repositório inteiro | 2026-10-16 |

## Mapa de locks da F1 (calculado no PF1, ajustado na execução)

| Wave | Tarefa | W | R | Conflitos |
|---|---|---|---|---|
| W1.1 | T1.1 | tooling raiz, `design\**`, `docs\README.md` | — | serial |
| W1.2 | T1.2 | `src\safety\{gate,thresholds,policy}.mjs`, `src\dsp\level.mjs`, `tools\gen-thresholds.mjs`, `test\safety\*`, `test\dsp\level.test.mjs` | `design\analysis\*` (estável) | nenhum |
| W1.2 | T1.3 | `src\share\s1.mjs`, `docs\s1-format.md`, `docs\social.md`, `test\share\s1.test.mjs` | — | nenhum |
| W1.2 | T1.5 | `src\io\equalizer-apo.mjs`, `test\io\equalizer-apo.test.mjs` | — | nenhum |
| W1.2 | T1.6 | `src\io\measurement.mjs`, `test\io\measurement.test.mjs` | `src\dsp\grid.mjs` (estável) | nenhum |
| W1.2 | T1.7 | `src\dsp\{distance,iso226}.mjs`, `test\dsp\{distance,iso226}.test.mjs` | `src\dsp\grid.mjs` (estável) | nenhum |
| W1.2 | T1.9 | `src\transport\{webhid,fake-device}.mjs`, `test\transport\webhid.test.mjs` | — | nenhum (gate injetado) |
| W1.2 | T1.10 | `src\policy\{flash,loudness,journal}.mjs`, `test\policy\*` | — | nenhum (`levelDb` injetado) |
| W1.2 | T1.11 | `src\meter\*.mjs`, `test\meter\*` | — | nenhum |
| W1.3 | T1.4 | `src\share\envelope.mjs`, `schemas\preset-envelope-1.schema.json`, `test\share\envelope.test.mjs` | `src\share\s1.mjs` (estável) | nenhum |
| W1.3 | T1.8 | `src\catalog\presets.mjs`, `test\catalog\presets.test.mjs` | gate e level (estáveis) | nenhum |
| W1.3 | T1.12 | `src\solver\peq.mjs`, `test\solver\peq.test.mjs` (+ `THIRD_PARTY_NOTICES.md` pela fila) | núcleo estável | nenhum |
| W1.4 | T1.13 | `src\index.mjs`, `src\*\index.mjs`, `test\index.test.mjs`, `types\**`, `docs\README.md` | — | paralela à T1.T (W disjuntos; T1.T importa módulos diretamente) |
| W1.4 | T1.T | `test\integration\*` | núcleo estável | idem |

## Tarefas

| ID | Status | Commit | Notas |
|---|---|---|---|
| PF1 | verificada | b60fc72 | ver Pre-flights |
| T1.1 | commitada | 6384d56 | orquestrador rodou format:check, types e coverage (allowlist); script `types` corrigido com `jsconfig.types.json` |
| prep | commitada | 06b95cf | `src\dsp\grid.mjs` (grade canônica de 481 pontos) criado pelo orquestrador para a T1.6 e a T1.7 |
| T1.2 | commitada | 52951aa | paridade bit a bit em `full`; drag 1,6–2,0 ms, full 8,8–10 ms por chamada |
| T1.3 | commitada | 9844007 | S1 v1: 408 bits = 51 B = 68 caracteres; CRC-16/CCITT-FALSE |
| T1.4 | commitada | 57fff6b, 6b8dde9 | 176 casos estruturais concordam com Ajv 2020; 12 exclusões semânticas marcadas |
| T1.5 | commitada | f991e8a | |
| T1.6 | commitada | f77373c | |
| T1.7 | commitada | 1714e62 | |
| T1.8 | commitada | 519e123 | `descriptionEn: null` (o mock não traz traduções das descrições da Kuba) |
| T1.9 | commitada | 9fe76e3 | |
| T1.10 | commitada | e1f254e | |
| T1.11 | commitada | 2b8b756 | teste de ganho DC do FIR corrigido pelo orquestrador (tabela publicada não é unitária) |
| T1.12 | commitada | 1deacf2, 2ba3f7c | RMS por preset 0,107–0,289 dB; 61–210 ms por solução |
| T1.13 | commitada | ca72131 | "NOT ACCEPTED" do verificador era falso (rodou durante a escrita da T1.T); verificação independente verde |
| T1.T | commitada | 1811c06 | 36 testes de integração; 8 propriedades × 1 000 execuções (semente 20261016) |
| Q1 | em voo | | heavy |

Bateria completa no fim da W1.4: 517/517; cobertura `src\**` 99,80% linhas, 99,45% branches, 99,55% funções; lint, typecheck, prettier e scanner limpos; `npm run types` emite 34 declarações.

## Pre-flights

| PF | Data | Resultado | Evidências |
|---|---|---|---|
| PF1 | 2026-10-16 | aprovado | HEAD 1e2f241; `git status`: só `design/` não versionado (49 arquivos, ~33,7 MB; maior 4,24 MB); Node v24.21.0, npm 12.0.2; `npm test` 59/59 (52 codec + 6 scanner + 1 agregado do `design\analysis\gate.test.mjs`); `qa-parity.mjs` 0 falhas (Neutro 0x4FFF); `check-sensitive` saída 0; 16 núcleos |

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
| @types/node | 24.x | MIT | 2026-10-16 |
| ajv | 8.20.0 | MIT | 2026-10-16 |

### Fatos do `node:test` (PF1.6)

- `--experimental-test-coverage` segue experimental no Node 24/26; `--test-coverage-lines|branches|functions=<n>` encerram com código 1 abaixo do limite; `--test-coverage-include|exclude` aceitam globs repetíveis; `--test-concurrency` tem padrão `availableParallelism() − 1`.
- Globs entre aspas (`node --test "test/**/*.test.mjs"`) são expandidos pelo próprio Node.

### Fontes dos medidores (T1.11)

- BS.1770-5 (11/2023, igual à -4 nos coeficientes): ponderação K a 48 kHz (tabelas 1 e 2), offset −0,691, janelas de 400 ms e 3 s; outras taxas pela derivação do libebur128 (MIT).
- BS.1770 anexo 2: FIR de 48 coeficientes e 4 fases. As fases publicadas não têm ganho DC unitário (0 e 3: 1,0015869140625; 1 e 2: 0,9730224609375). O teste 15 da EBU Tech 3341 passa (−6,0 dBTP dentro da tolerância).
- EBU Tech 3341 (2016): casos 1, 2, 9, 12 e 15 cobertos.
- VU: IEC 60268-17 via fontes secundárias (ITU-R BS.2054-4, Wikipedia): 99% em 300 ms, overshoot de 1 a 1,5%. Constantes adotadas: ζ = 0,81, ωn = 13,422 rad/s (99% em 300 ms exatos), calibração por valor médio retificado.
- PPM: IEC 60268-10 é paga. Tipo II pela EBU Tech 3205 (tabela 2), com dois retificadores (1,1 ms e 5 ms) em média; tipo I pela Wikipedia (secundária), τ = 1,42 ms; tolerâncias do tipo I definidas pelo projeto.
- −14 dBFS como alinhamento: sem fonte encontrada. Mantido como opção do produto, rotulado sem citar norma.

## QA

| Q | Ciclo | Resultado | Achados → FX |
|---|---|---|---|

## Decisões durante a execução

- 2026-10-16 · PF1: o router_run recusa `node`, `npm --version`, `check:sensitive`, `format:check`, `types`, `test:coverage` e os scripts `test:<área>` (fora da allowlist; só `test`, `lint` e `typecheck` passam). O orquestrador roda esses comandos direto (0.17) numa rodada central após cada wave. `npm install` também é feito pelo orquestrador (fila de integração).
- 2026-10-16 · Locks: `src\dsp\level.mjs` e `test\dsp\level.test.mjs` passaram da T1.7 para a T1.2, porque o gate usa `levelDb`. A T1.7 ficou com distância e ISO 226.
- 2026-10-16 · Exports por área apontam para `src\<área>\index.mjs`, criados na T1.13 (W ampliado). A raiz exporta namespaces (`dsp`, `safety`, …) e 20 atalhos sem colisão.
- 2026-10-16 · W1.2/W1.3: a T1.4 e a T1.8 passaram para a W1.3, junto da T1.12, porque leem arquivos em edição na W1.2. A T1.9 e a T1.10 recebem o gate e o `levelDb` por injeção e testam com stubs; a integração real está na T1.T.
- 2026-10-16 · Gate: os códigos do plano (§T1.2) são o contrato estável; `reasons` é uma lista de objetos `{code, stage?, value?, limit?}`, em ordem documentada. O modo `drag` pode aprovar o que o `full` reprova (caso LP 20 968 Hz Q 2, diferença de 1,55e-4 dB); por isso transporte e servidor usam sempre `gateForWrite` (sempre `full`). Na amostra de 234 curvas, os vereditos foram idênticos.
- 2026-10-16 · Transporte: espera de 16 ms depois de cada um dos 9 relatórios, inclusive o último, e mais 150 ms antes do commit (total ≈ 294 ms), conforme `docs\protocol-0xcb.md`. `writeMany` para na primeira falha e marca os demais como `skipped`.
- 2026-10-16 · S1: além dos códigos de decodificação do plano, a codificação usa `s1:bands` e `s1:grid`. LP/HP são gravados com ganho 0 e decodificados sem `gainDb`; o payload continua idêntico.
- 2026-10-16 · Solver: as caixas padrão são as `ABS_RANGES`, porque os presets oficiais ficam fora das `SOFT_RANGES` (PK em 20–25 Hz, Q 0,1–0,5, +9,2 dB); `ranges: 'soft'` continua disponível. Termo `trebleDetail` (padrão 0,5) acrescentado à perda do AutoEq: com 0 a perda é exatamente a do AutoEq, mas o preset Enérgico fica com 1,22 dB e falha o critério de < 1 dB. O otimizador é Levenberg–Marquardt próprio sobre (log f, log Q, ganho).
- 2026-10-16 · ISO 226: tabela 1 confirmada por duas implementações independentes e pelo texto da norma até 5 kHz; linhas de 6,3 a 12,5 kHz só pelas implementações. Delta da revisão 2023 documentado (até 0,6 dB).

## Bloqueios e perguntas ao humano

Nenhum.
