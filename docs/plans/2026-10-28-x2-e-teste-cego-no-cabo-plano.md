# X2 e teste cego no cabo — plano

Data: 2026-10-28. Issues: #73 (X2 no cabo), #74 (teste cego no cabo, T2.14).
Base: prévia sem flash (`docs/plans/2026-10-28-modo-sem-flash-plano.md`, #62).

## 1. Decisão

Um **conjunto pré-aprovado** dentro da sessão de prévia: todas as curvas passam pelo gate e têm o
nível casado (baixando o preamp da mais alta) antes da primeira troca. Com o nível confirmado igual
ao maior nível casado, a retenção de volume nunca dispara no meio da comparação. Trocas são
aguardáveis e têm o mesmo tempo para qualquer curva.

## 2. Fatias

| # | Fatia | Arquivos | Aceite |
|---|---|---|---|
| 1 | Casamento de nível | `web/src/lib/cable/compare.ts` | Nunca mais alto; recusa abaixo de −25,5 dB; gate refeito; CRC novo; `ack = max`; resíduo ≤ 0,1 dB; originais intactos |
| 2 | API de comparação no serviço | `service.ts`, `types.ts` | `startComparison` / `switchComparison` / `endComparison`; nenhuma retenção em 200 trocas; `queueLive` recusado durante a comparação; troca recusada em estado desconhecido; desconexão, ocupado e fim tratados |
| 3 | X2 na página Comparar | `CompararPage.svelte`, `CableAB.svelte`, fonte "Salvo no cabo", textos | Alavanca A/B no cabo, teclas, navegador sem EQ, "Salvar esta" grava a curva original |
| 4 | Ocultação no modo cego | visão da prévia, `CableBar.svelte`, `LivePanel.svelte` | Nada de CRC, nível ou retenção no DOM/aria durante o teste cego |
| 5 | Teste cego no cabo | `BlindTest.svelte` (aba do cabo), `cable-round.ts` | Janela de troca fixa e muda, tempo idêntico por candidata, rodada anulada em qualquer falha, checagem de mudança audível, rodadas no cabo fora do S6 |
| 6 | Docs | T2.14/T2.15, ideas, open-questions, página de docs | Coerente com as medições |

MVP de #73: fatias 1–3. #74 só sai com 4 e 5 juntas.

### Estado (2026-10-28): fatias 1–6 feitas

| # | Commits |
|---|---|
| 1 | `7a7a658` |
| 2 | `7a7a658`, `be31b43` (retenção de volume em toda troca, `cancelHold`) |
| 3 | `d63df6f`, `53915e7` (achados de QA do X2) |
| 4 | `be31b43`, `53915e7`, `ff5ae4b` (barra superior e painel da Curva constantes) |
| 5 | `ff5ae4b`, `328f4b0` e o commit desta fatia 6 (achados finais de QA: "Salvar a vencedora" grava a curva original da própria candidata; "Encerrar" travado sem curva salva conhecida; "Encerrar sem voltar" na Escuta; fim que falha não sorteia a rodada de novo) |
| 6 | o commit desta fatia (estas docs; encaixe "Teste cego no cabo" da página Cabo aponta para a aba "No cabo") |

Pendente: telemetria S6 com saída "cabo" (exige mudança no servidor); por ora as rodadas
ouvidas no cabo não vão para o S6.

## 3. Riscos

- O cabo não confirma nada: travamento silencioso invalidaria um teste cego. Mitigação: checagem
  de mudança audível no início e a cada 4 rodadas, botão "O som parou de mudar", trocas lentas.
- Nível casado pela métrica `levelDb` (média 300 Hz–3 kHz), a mesma do teste cego no navegador.
- Telemetria S6 com saída "cabo" exige mudança no servidor: fica para depois.
