# Modo sem flash (prévia no cabo) — plano

Data: 2026-10-28. Origem: sonda B12 da Fase H (`docs/probing.md`, seção F).

## 1. Fato de hardware que motiva o plano

- Uma gravação são 9 reports de dados `0xCB` (índices 0 a 8, payload de 220 bytes com CRC)
  seguidos do commit `01 65 00 01 FF`.
- **Os 9 reports de dados sem o commit já mudam o som, na hora.** Depois de desconectar e
  reconectar, o cabo volta à última curva **commitada**. Dados = RAM; commit = flash (B12 ✅).
- **B12b ✅ (2026-10-28):** só reports 0..6, ou só 0..7 (com o CRC), **não mudam o som**; a
  curva só entra quando o report 8 chega. Uma sequência completa enviada depois de uma parcial
  funciona normalmente. Logo, um envio interrompido antes do report 8 é ignorado pelo cabo.
- O firmware valida o CRC: curva com CRC errado é ignorada em silêncio (B7 ✅). O cabo nunca
  responde (sem input reports). A troca de curva é suave, sem clique (B13 ✅).
- **B12c (resistência):** 1000 aplicações ao vivo seguidas (ritmo de ~2,4/s) mais 50 sem a
  espera de 150 ms; resultado registrado em `docs/probing.md`. A confirmação de que a curva
  commitada continua intacta depende de um replug manual (pendente, ver §6).

## 2. Escopo

Dentro: desktop WebHID, modo simulado **e Android** (decisão do usuário em 2026-10-28).
Fora (issues de acompanhamento): X2 no cabo (S9) e teste cego no cabo (S10).

Princípios que não mudam: o gate roda em toda aplicação; nada é gravado na flash sem gesto;
nada é repetido automaticamente; o protocolo no fio não muda além de omitir o commit.

## 3. Fases

Cada fase: pré-flight (estado do repo, testes da área verdes), implementação em fatias
atômicas, testes só do que a fatia toca, revisão QA sênior, correções, commit.

### Fase 0 — sondas (S0)
- B12b ✅, B12c (resistência) ✅ envio; replug manual pendente.

### Fase 1 — núcleo
- **S1 `applyCurve`** (`src/transport/webhid.mjs`): 9 reports, sem commit, `SETTLE_MS` dentro
  da trava, mesmo `approve()`/gate, mesma trava por cabo, sem retry; `WriteResult` com
  `committed: false`. `writeCurve` continua sendo "persistir". Cabeçalho do módulo e
  `docs/protocol-0xcb.md` passam a dizer dados = RAM, commit = flash.
- **S2 `FakeFirmware`** (`src/transport/fake-device.mjs`): buffer de 9 slots, `live` e
  `committed`, aplica no report 8 (B12b), CRC ruim ignorado, commit copia `live` para
  `committed`, `FakeHID.replug(device)` restaura `live = committed`. Testes existentes intactos.
- **S3 `src/policy/live.mjs`** (puro): constantes de ritmo (espera de 200 ms após a última
  edição, teto de 600 ms durante arrasto, no máximo 1 em voo + 1 pendente, a mais nova vence) e
  `liveHold(novoNível, nívelConfirmado, estado)` (salto ≥ 3 dB acima do nível confirmado segura;
  passos pequenos não somam; estado desconhecido segura).

### Fase 2 — serviço
- **S4 sessão de prévia** (`web/src/lib/cable/service.ts`, `types.ts`): `CableState.live`;
  `startLive` (gesto + checklist de prévia), `queueLive`, `confirmLive`, `revertLive`,
  `stopLive`; Salvar = `write()` do snapshot ao vivo (9 reports + commit). Prévias não entram no
  diário, não disparam `cable:written`, não tocam contadores da flash; contador próprio de
  prévias. Desconexão encerra a sessão ("o cabo voltou à curva salva"). Envio interrompido:
  pelo B12b, sem o report 8 o cabo mantém a curva anterior; o estado vira "anterior" se o
  report 8 não saiu e "desconhecido" se a falha foi depois dele.
- **S5 marcador e abas**: `oa.cable.live` no localStorage, trava `oa-cable-live`, motivo de
  recusa `'live-elsewhere'`, aviso de prévia órfã após recarregar.
- **S7 checklist**: comparação de volume usa o nível da prévia quando conhecido.
- Chave de publicação `LIVE_APPLY_POLICY = { enabled }`.

### Fase 3 — interface
- **S6 Curva**: "Ouvir no cabo" (gesto + checklist de prévia), motor do navegador sem EQ
  enquanto ligado, chip "No cabo: prévia não salva" com "Salvar no cabo" e "Voltar à curva
  salva", avisos de retenção (volume, gate, estado desconhecido), textos `cable_live_*` em
  pt-BR e en-US.
- **S8 Cabo**: contador de prévias, remover "EM BREVE" do modo RAM, texto de resgate ajustado
  ao B12, atualização do plano principal.

### Fase 4 — Android (S11)
- `FrameGuard.kt`: em `AwaitCommit`, um report 0 válido abandona a sequência não commitada e
  vai para `Receiving(1)`; testes Kotlin; anexo D.3 do plano Android atualizado.
- Capacidade no bridge (`getInfo().liveApply`) e detecção em `native/detect.ts`;
  `liveCapable` liga no nativo só com a capacidade presente. `ANDROID_WRITE_VALIDATED`
  continua `false`, então a prévia no Android exige a confirmação de "não testado".

### Fase 5 — QA adversarial do plano inteiro e DoD.

## 4. DoD

- Testes das áreas tocadas verdes (node `test:transport`/`test:tools` e afins, vitest
  `unit`/`component` dos arquivos tocados, Kotlin do `FrameGuard`), `check:web`, `lint`,
  formatação dos arquivos tocados.
- Nenhuma prévia altera diário, contadores da flash ou `cable:written`.
- Gate e retenção de volume cobertos por testes em toda aplicação ao vivo.
- Docs e textos coerentes com as medições.

## 5. Riscos

| Risco | Mitigação |
|---|---|
| A via de dados desgastar a flash | Ritmo limitado, contador separado, chave de publicação, B12c |
| Cadência mais rápida que a medida | Piso de ~300 ms por sequência |
| Duas abas | Trava de sessão e recusa `'live-elsewhere'` |
| `lastWritten` não é a verdade do cabo | "Voltar à curva salva" = última salva por este navegador; replug é o reset real |
| Android sem validação de escrita | Confirmação "não testado" obrigatória |

## 6. Pendências manuais

- Replug após o B12c para confirmar que a curva commitada (Neutro) sobreviveu.
