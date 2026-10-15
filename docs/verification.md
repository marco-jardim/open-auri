# Verificação — teste de equivalência do payload

## O que este teste prova

Que a nossa implementação do formato `0xCB` (`src/dsp/eq0xcb.mjs`) reproduz
**byte a byte** o byte-stream que a página de referência grava no chip, para
**todos os 11 presets** do Auri.

É o único ponto do caminho de dispositivo que é verificável **sem o cabo**:
o que sai daqui é o *conteúdo*; o que falta provar é a *transmissão*.

## Como rodar

```powershell
npm test          # node --test
```

## O que é verificado

| Verificação | Origem | Tipo |
|---|---|---|
| `crc16("123456789") == 0x29B1` | CRC catalogue (CRC-16/CCITT-FALSE) | **independente** |
| `HEADER`, `APPLY`, `REPORT_ID`, `FS`, `VID`, `PID` | referência | equivalência |
| `preampWord(0) == 2^23` | definição do formato (Q23) | independente |
| `blob(bands, pre)` vs referência | referência | equivalência (11 presets) |
| `packets(bands, pre)` vs referência | referência | equivalência (11 presets) |
| fatiamento 9 × 31 bytes, índice no byte 0 | spec | estrutural |
| `blob` rejeita contagem ≠ 10 bandas | spec | estrutural |

O vetor de CRC `0x29B1` é o **único** ponto de controle que **não** deriva da
implementação de referência — por isso ele importa: se o CRC estivesse errado,
uma implementação idêntica à referência concordaria com o próprio erro.

Resultado observado: **28/28 passando**.

## Proveniência do fixture

`test/fixtures/eq0xcb.reference.json` é **dado derivado**: os bytes corretos para
cada preset, gerados rodando a implementação de referência.

- Gerador: `tools/extract-kuba-reference.mjs` (`npm run fixtures:reference`).
- O código da referência **não** é vendorizado no repositório — ele é apenas
  avaliado para produzir os bytes esperados.
- O gerador aceita `--template <arquivo>` para usar um HTML salvo localmente,
  evitando depender da rede.

## O que este teste **não** prova

- Que o firmware **aceita** esses bytes (não houve transmissão) — ❌
- Que existe leitura / pull / verify no `0xCB` — ❌
- Que o firmware aceita biquads fora de RBJ (HS/LP/HP/notch) — 🟡
- Que os limites de ganho/Q/frequência se comportam como assumido — 🟡

Ver [`open-questions.md`](open-questions.md).
