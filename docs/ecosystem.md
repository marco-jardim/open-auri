# Ecossistema e implementações de referência

O mesmo chipset (VID `0x3302`) tem um **wire format irmão**, o `0x4B`, que é
**bem documentado** em projetos abertos. O nosso `0xCB` não. Este documento
registra os dois e o que dá para reusar de cada um.

## `0x4B` × `0xCB` — comparação

| | **`0x4B`** (padrão documentado) | **`0xCB`** (o do cabo analisado) |
|---|---|---|
| Report ID | `0x4B` | `0xCB` (= `0x4B \| 0x80`) |
| Tamanho do relatório | 64 bytes | 31 bytes |
| Header | por-comando (com campo de comprimento) | `"EQ1#"` + comprimento u16 + geometria do bloco 🟡 |
| Fatiamento | **1 pacote por banda** | **bloco de 10 bandas** em 9 pacotes |
| Escala dos coeficientes | **Q30** (`2^30`) ⇒ \|coef\| < 2 | **Q27** (`2^27`) ⇒ \|coef\| < 16 |
| Ordem dos coeficientes | `[b0, b1, b2, -a1, -a2]` | `[b0, b2, -a1, b1, -a2]` |
| Byte de tipo de filtro | **sim** (`LSQ=1, PK=2, HSQ=3, LP=4, HP=5`), mais `f`, `Q` e ganho no pacote | **não** — só coeficientes |
| CRC | não | **CRC16-CCITT** |
| Leitura (*read*) | documentada (`0x80`) | **desconhecida** |
| Gravação só na RAM | `TEMP_WRITE` (`0x0A`) | desconhecida |
| Commit | `TEMP_WRITE` → `FLASH_EQ` (slot `101` no frost-tune); o eqloader envia antes `0x05` e `0x17`, não documentados | `[01 65 00 01 FF]` (contém `0x65 = 101`) |
| `FS` de projeto | 96 kHz (eqloader, frost-tune) | 96 kHz (kuba) |
| **Confiança** | ✅ (código aberto) | ✅ (formato) / ❌ (device) |

Consequência de projeto: um `core` agnóstico + **camada de protocolo plugável**
com duas implementações (`0xCB`, `0x4B`) — porque **não sabemos** qual o cabo usa
até plugá-lo. As duas coincidências na tabela (report ID e slot `101`) sugerem
um SDK comum; o cabo pode expor **os dois** reports (sonda B1).

**Faixa dos coeficientes.** Em Q30 nenhum coeficiente chega a 2: reforços
grandes em frequências altas não cabem, e as ferramentas `0x4B` fazem *clamp*
silencioso (`clamp_i32` no frost-tune) — o filtro gravado deixa de ser o
projetado. O Q27 do `0xCB` dá 8× mais margem.

**Projeto dos coeficientes no `0x4B`.** O `eqloader` comenta que calcula
*"always a peaking design, whatever the band's type, matching the vendor tool"*.
Como o pacote também leva `f`, `Q`, ganho e tipo, é provável que o firmware
`0x4B` recalcule os coeficientes a partir dos parâmetros. No `0xCB` isso é
impossível — só os coeficientes viajam.

## Comandos do `0x4B` (referência)

Do `frost-tune` (`walkplay_protocol.rs`) e do `eqloader.py`:

| Comando | Valor |
|---|---|
| `WRITE` / `READ` | `0x01` / `0x80` |
| `END` | `0x00` |
| `FLASH_EQ` | `0x01` |
| `GLOBAL_GAIN` | `0x03` |
| `PEQ_VALUES` | `0x09` |
| `TEMP_WRITE` | `0x0A` |
| `VERSION` | `0x0C` |
| `FILTER_SLOT` | `101` |

Leitura de banda: `[0x80, 0x09, nonce, 0x00, index, 0x00]` ⇒ permite **pull /
verify / rollback** (o que o `0xCB` ainda não tem documentado).

Ganho global: o `0x4B` grava **dB inteiro** num registrador, e alguns aparelhos
têm um **buffer de hardware** (ex.: `-5 dB` no CrinEar Protocol Micro) somado a ele.

## Implementações abertas

| Projeto | O que é | Protocolo | Licença |
|---|---|---|---|
| [`devilAPI/walkplay-eqloader`](https://github.com/devilAPI/walkplay-eqloader) | App Flutter (web no GitHub Pages + desktop/Android) e `eqloader.py` (branch `legacy-tkinter`). Editor, push/pull, AutoEQ, formato `.txt`. | `0x4B` | **sem arquivo de licença** ⇒ tratar como todos os direitos reservados |
| [`Bukutsu/frost-tune`](https://github.com/Bukutsu/frost-tune) | Rust; `walkplay_protocol.rs` com pull/verify/rollback. | `0x4B` | MIT (SPDX no header do arquivo) |
| [`Bukutsu/glacier-eq`](https://github.com/Bukutsu/glacier-eq) | App Tauri; tem **dummy DAC** para desenvolvimento. | `0x4B` | não verificado |
| [`jeromeof/devicePEQ`](https://github.com/jeromeof/devicePEQ) | Plugin JS WebHID multi-marca (`walkplayJS/`). | `0x4B` | possui `LICENSE.txt` (conteúdo não verificado) |
| [`mandy321/Audiocular-Aura`](https://github.com/mandy321/Audiocular-Aura) | Web app WebHID; `dist/assets/index.js` traz implementação multi-protocolo + tabela de VID/PID. | `0x4B` (+ outros) | não verificado |
| [`cheesyserg/pyBlackPearl`](https://github.com/cheesyserg/pyBlackPearl) | Scripts de query (TRN Black Pearl). | `0x4B` | não verificado |
| [`eq.hangout.audio`](https://eq.hangout.audio) (Crinacle's EQ Tool) | **Só a matemática** (`shared/equalizer.js`): biquads RBJ, otimizador AutoEQ, graphic EQ. `DefaultSampleRate = 48000`. | — | site proprietário |

> **Licença é bloqueador.** Antes de copiar código: `eqloader` **não tem licença**
> e o `equalizer.js` é de um site proprietário. Algoritmos e fórmulas (RBJ,
> AutoEQ) não são protegidos por direito autoral; **implementações** são. O
> próprio `equalizer.js` declara que tirou os biquads do
> [`AutoEq`](https://github.com/jaakkopasanen/AutoEq), que é **MIT** (verificado
> em 2026-10-15) — portar a partir do AutoEq é o caminho limpo. O `open-auri` é
> AGPL-3.0.

## Matemática reusável (sem protocolo)

O `shared/equalizer.js` do hangout.audio e o `eqloader.py` implementam o
*mesmo* motor, e são a referência para:

- biquads RBJ (peak, low-shelf, high-shelf, low-pass, high-pass);
- resposta somada (`calc_gains`) para desenhar curvas;
- **AutoEQ** (`search_candidates` + otimizador `strip`/`optimize`), com
  `AutoEQRange = [20, 15000]`, `OptimizeQRange = [0.5, 2]`, `OptimizeGainRange = [-12, 12]`;
- **normalização de loudness ISO 226:2003** (port do CrinGraph), para alinhar
  medição e alvo antes de otimizar;
- cômputo de **preamp seguro** (`calc_preamp`), com `min(0, ...)` para nunca adicionar ganho.

Útil porque, para o `0xCB`, só o *cálculo* roda aqui; o chip recebe biquads crus.

## Formato de arquivo de perfil

`EqualizerAPO` / `eq.hangout.audio` (`.txt`), usado pelo `eqloader`:

```
Preamp: -6.0 dB
Filter 1: ON PK Fc 1000.0 Hz Gain 3.5 dB Q 1.000
Filter 2: ON LS Fc 80.0 Hz Gain -2.0 dB Q 0.707
```

Tipos: `PK`, `LS`/`LSC`/`LSQ`, `HS`/`HSC`/`HSQ`, `LP`, `HP`.
Bom candidato a formato de import/export por ser interoperável.

O codec só aceita `PK`, `LS`, `HS`, `LP`, `HP` e `OFF`, e recusa qualquer outro
nome. Um importador precisa mapear `LSC`/`LSQ` → `LS` e `HSC`/`HSQ` → `HS`
explicitamente — antes, o codec transformava silenciosamente um shelf
desconhecido em peaking.
