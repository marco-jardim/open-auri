# Verificação: o que os testes provam

```powershell
npm test          # node --test
```

Resultado observado: **52/52 passando**.

## O que é verificado

Os testes se dividem em quatro grupos, e a separação importa: só os
**independentes** protegem contra um erro que a referência também tenha.

### 1. Independentes da referência

| Verificação | Origem |
|---|---|
| `crc16Ccitt("123456789") == 0x29B1` | catálogo de CRCs (CRC-16/CCITT-FALSE) |
| `preampWord(0) == 2^23` | definição do Q23 |
| peaking: ganho em `f0` == `g` | RBJ cookbook |
| peaking com `g = 0`: zeros coincidem com polos | RBJ cookbook |
| low shelf: DC == `g`, Nyquist == 0 dB | RBJ cookbook |
| high shelf: Nyquist == `g`, DC == 0 dB | RBJ cookbook |
| low/high pass: unitário na banda passante, −3,01 dB em `f0` com Q = 1/√2 | RBJ cookbook |

Sem este grupo, uma implementação idêntica à referência concordaria com o próprio
erro. É por ele que HS, LP e HP (que a referência não usa) estão cobertos.

### 2. Equivalência com a referência

| Verificação | Escopo |
|---|---|
| `PREAMBLE`, `COMMIT_COMMAND`, `HID_REPORT_ID`, `SAMPLE_RATE`, `USB_VID`, `USB_PID` | constantes |
| `encodePayload(eqBands, preampDb)` byte a byte | 11 presets |
| `encodeReports(eqBands, preampDb)` byte a byte | 11 presets |

### 3. Estrutura

| Verificação |
|---|
| 9 relatórios de 31 bytes, índice no byte 0 |
| bytes 4–5 do header == comprimento do restante (u16 LE) |
| `commitReport()` == `COMMIT_COMMAND` + zeros até 31 bytes |
| `PREAMBLE`, `COMMIT_COMMAND`, `NEUTRAL_BANDS` não podem ser alterados |
| `OFF` == seção identidade exata `[2^27, 0, 0, 0, 0]` |
| preset neutro: 10 seções identidade e resposta plana |

### 4. Validação: nada nocivo chega à flash

| Entrada recusada | O que seria gravado sem a recusa |
|---|---|
| `q = 0`, `f = NaN` | seção toda zero (**cabo mudo**) |
| `q < 0`, `f > Nyquist` | seção **instável** |
| `f = 0`, `f = Nyquist`, `g` não finito | valores arbitrários |
| tipo desconhecido (`LSQ`, ausente, `null`) | peaking no lugar de outro filtro |
| pré-amp não finito | 0 dB silenciosamente |
| pré-amp **> 0 dB** | ganho antes das bandas, clipping em escala cheia |
| coeficiente fora de `int32` | não se aplica |
| polos instáveis **após** a quantização | seção marginal que a verificação ideal deixaria passar |
| contagem de bandas ≠ 10 | não se aplica |

O último item da tabela de estabilidade é deliberado: um `a2 = 1 − 10⁻¹²` é
estável em ponto flutuante, mas quantiza para exatamente 1. O codec verifica os
coeficientes **que o chip vai executar**.

## Proveniência do fixture

`test/fixtures/eq0xcb.reference.json` é **dado derivado**: os bytes corretos para
cada preset, gerados rodando a implementação de referência.

- Gerador: `tools/extract-kuba-reference.mjs`. O código da referência só é
  executado se o sha256 dele bater com um hash revisado e pinado, num contexto
  V8 separado e com timeout.
  - `npm run fixtures:reference`: baixa a página e regenera o fixture **só se**
    ela bater com o hash pinado no fixture; se mudou, sai com erro sem executar
    nada e explica como revisar e pinar de novo;
  - `--fetch <arquivo>`: só baixa e salva;
  - `--template <arquivo> [--expect-sha256 <hash>]`: usa uma cópia local (e pina
    um hash novo).
- O sha256 do template usado fica em `_provenance.templateSha256`; com ele o
  fixture é reproduzível e determinístico (não há data de geração).
  Verificado em 2026-10-15: `npm run fixtures:reference` contra a página ao vivo
  regenerou o fixture sem nenhuma diferença.
- O código da referência **não** é vendorizado no repositório.

## Sobre a origem do codec

`src/dsp/eq0xcb.mjs` não contém código nem nomes da implementação de referência:

| Parte | Origem |
|---|---|
| peaking, low shelf, high shelf | porte do **AutoEq** (MIT), com aviso em [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) |
| low pass, high pass | RBJ cookbook |
| magnitude, validação, `OFF`/neutro, framing, `commitReport()` | próprios |
| layout dos bytes | aprendido da referência (fato do formato, não código) |

Os únicos identificadores em comum com o script da referência são `b0`, `b1`,
`b2`, `a0`, `a1`, `a2`, a notação do RBJ cookbook. Verificado tokenizando os dois
arquivos e cruzando os identificadores, fora palavras da linguagem.

### Prova de não-regressão da troca para o AutoEq

Feita em 2026-10-15, contra a versão anterior do codec (a que seguia a referência):

| Verificação | Resultado |
|---|---|
| bytes dos 11 presets (fixture) | idênticos |
| bytes de 200 mil bandas aleatórias (PK/LS/HS/LP/HP, ±24 dB, Q 0,1–10, pré-amp 0 a −12 dB) | **196 245 comparadas, 0 diferentes**; 3 755 recusadas pelas duas versões, 0 recusadas por só uma |
| erro da magnitude contra avaliação exata (200 bits) dos mesmos coeficientes | 4,4·10⁻⁹ dB → **5,7·10⁻¹⁴ dB** (melhorou) |

As tolerâncias dos testes não foram alteradas.

## O que os testes **não** provam

- Que o firmware **aceita** esses bytes (não houve transmissão): ❌
- Que existe leitura / pull / verify no `0xCB`: ❌
- Que o firmware aceita biquads fora de PK/LS (HS/LP/HP/notch): 🟡
- Que o `FS` do chip é 96 kHz: 🟡 (três implementações concordam)
- Que o firmware valida o CRC: 🟡 (sonda B7)

Ver [`open-questions.md`](open-questions.md) e [`probing.md`](probing.md).
