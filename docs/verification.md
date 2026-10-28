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

## Validação no fio com o cabo real

Feita em 2026-10-28 com um cabo "Kuba Auri" real (VID `0x3302`, PID `0x8902`),
Windows 11, Edge 156 (WebHID), USBPcap 1.5.4.0 e tshark 4.6.9. É a primeira
evidência física; os fixtures `synthetic-*.json` continuam sendo só testes da
ferramenta.

| Arquivo | Conteúdo |
|---|---|
| `test/fixtures/usb-golden/capture-2026-10-28-edge-win.raw.json` | fonte: 130 buffers interrupt OUT `{frame, t, hex}` na ordem da captura |
| `test/fixtures/usb-golden/capture-2026-10-28-edge-win.provenance.json` | proveniência: sistema, navegador, ferramentas, série do cabo, método e ordem das gravações |
| `test/fixtures/usb-wire-golden.json` | golden gerado por `tools/usb-golden.mjs --input-format interrupt-out-raw --provenance …` |
| `test/tools/usb-golden-real.test.mjs` | testes abaixo |

| Verificação | Resultado |
|---|---|
| gravações 1–11 (página oficial) contra `eq0xcb.reference.json` | ✅ **11/11** idênticas (reports 0–8) |
| gravação 12 (`padrao` do open-auri) | ✅ igual a `encodeReports` e à gravação oficial nos 10 reports, commit incluso |
| gravação 13 (Neutro do open-auri) | ✅ igual a `encodeReports(NEUTRAL_BANDS, -0.5)` |
| CRC recalculado | ✅ 13/13 |
| commit no fio | ✅ `cb 01 65 00 01 ff` + 26 zeros nas 13 (`cb` + `commitReport()`) |
| regenerar o golden pela CLI | ✅ idêntico byte a byte |

A ferramenta emite um aviso esperado: `out-of-order curve: padrao` (a gravação
12 repete o `padrao` depois do `etymotic`). O teste exige exatamente esse aviso.

Intervalos observados: página oficial ≈ 18–32 ms entre reports (típico 24) e
176–195 ms antes do commit; open-auri 18–33 ms e 175–178 ms.

## Validação acústica com o cabo real

Feita em 2026-10-28. Saída do fone Kuba Auri → HyperX QuadCast S, concha
fixada contra o microfone e volume constante (~40–50%). WebAudio a 48 kHz no
Windows, com `echoCancellation`, `noiseSuppression` e `autoGainControl`
desligados. Senoides de 707 Hz a 8 kHz em passos de 1/6 de oitava, 2 passagens
por ponto, pico na FFT de 32768; SNR 40–60 dB de 1 kHz para cima, <30 dB
abaixo de ~1 kHz por acoplamento fraco. A/B ×3 (Neutro/curva), referência
distante em 6,3–8 kHz. A tentativa inicial com movimento foi descartada
(dispersão ±15–25 dB): fixar o transdutor e não mudar o volume.

Envio pelo console com frames do codec: 9 reports, 16 ms entre eles, 150 ms
de espera e commit (exceto B12), 2,1 s entre escritas; B12b/B12c sem commit,
com cadências detalhadas na seção F. PK 2000 e 5000 Hz,
−12 dB Q3, pré-amp −0,5 dB, ambos `standard` em `src/safety/classify.mjs`;
CRCs `0x3D48` e `0xBE68`. Números por frequência e detalhes em
[`probing.md`, seção F](probing.md#medição-acústica-mesmo-dia).

| Sonda | Resultado medido |
|---|---|
| B4 | ✅ PK 2 kHz: B−A médio de 3 ciclos concorda com `magnitudeDb` em ~0,5 dB (2000 Hz: −12,4 dB vs −12,0 previstos). Efeito imediato (≤ ~1,5 s), sem replug; Neutro reproduzível em ±0,5 dB entre 4 medições |
| B10 | ✅ Vales em 2000 e 5040 Hz, como projetados a `SAMPLE_RATE = 96000`; vizinhos −7,7/−7,5 dB no PK 2 kHz. DSP a 96 kHz com host a 48 kHz, resolução de 1/6 de oitava + simetria. PK 5 kHz válido: 5040 −12,4; 4490 −7,5; 5657 −7,4; 4000 −4,2 dB (previstos: 5657 −7,4 e 4000 −4,4) |
| B7 | ✅ Com PK 2 kHz armazenado, PK 5 kHz com último byte do CRC `XOR 0xFF` (report 7 byte 10) não mudou a resposta, medida duas vezes; CRC correto aplicou normalmente. Validação pelo firmware, rejeição silenciosa sem input report |
| B13 | ✅ com ressalva: Neutro → PK 2 kHz durante tom de 2 kHz, queda de ~10 dB em rampa suave de ~15 ms, sem energia de clique audível nem mute. Sensibilidade HF do microfone limita cliques muito curtos só em HF; ScriptProcessor perdeu ~17% dos frames, sem alinhamento temporal absoluto dentro da escrita |
| B12 | ✅ Com PK 2 kHz commitado, 9 reports de Neutro sem `01 65 00 01 FF` aplicaram ao vivo (2 medições); replug restaurou PK 2 kHz (2000 Hz −12,8 dB vs referência, 3 passagens). Dados aplicam em RAM; commit persiste na flash. Bytes `01 FF` não variados |
| B12b | ✅ Com Neutro commitado, PK 2 kHz só com reports 0..6 (−7,17 vs −6,95 dB neutro) ou 0..7 com CRC (−7,77 dB) não aplicou; 0..8 aplicou (−16,3 dB), inclusive após parcial. Efeito só ao chegar o report 8 |
| B12c | ✅ com ressalva: após 1000 prévias normais + 50 sem espera, 0 erros de envio, mas prévias deixaram de mudar o som; escrita completa com commit ainda aplicou, sem recuperar as prévias; replug recuperou. Não reproduzido após replug em 1005 aplicações normais (5 lotes verificados) + 10 e 50 sem espera; aplicações normais posteriores funcionaram. Curva ao vivo estável por 45 s (−19,05 → −19,0 dB) |

B12b/B12c usam o nível em 2 kHz relativo à média de 7127/8000 Hz:
Neutro ≈ −6 a −10 dB, PK 2 kHz −12 dB Q3 ≈ −18 a −21 dB.

**Integridade da curva commitada (B12c) ✅:** o Neutro salvo pelo commit de
diagnóstico da rodada 1 sobreviveu a ≈1100 aplicações ao vivo da rodada 2 e
testes posteriores (normais e seguidas sem espera), sem commit no intervalo.
Após replug, 2 kHz relativo a 7127/8000 Hz, respectivamente: −1,95/−1,5 dB;
Neutro ao vivo logo depois: −2,2/−1,35 e −1,55/−1,45 dB; PK 2 kHz −12 dB
ao vivo: −13,6/−13,25 dB. O cabo voltou exatamente ao Neutro commitado.
O conjunto acústico havia mudado desde os ensaios anteriores: valem as
referências ao vivo da mesma sessão, não os valores absolutos da seção F.

B12 demonstra a viabilidade de modo sem flash, X2 no cabo e teste cego no
cabo, **não a implementação**. Antes de B12b/B12c: ~12 escritas com commit na
bancada + 13 na captura, além de 1 envio só de dados; **Padrão Auri regravado
com commit**, bytes oficiais, CRC `0x1970`.

## O que os testes **não** provam

- Que todas as curvas têm o **efeito acústico** esperado: B4 validou os PK
  ensaiados por diferença contra Neutro, não os 11 presets nem a planicidade
  acústica absoluta do fone; abaixo de ~1 kHz o acoplamento foi insuficiente
- Que existe leitura / pull / verify no `0xCB`: ❌ (sem feature reports; o input
  report `0xCB` existe e é o canal candidato)
- Que o firmware aceita biquads fora de PK/LS (HS/LP/HP/notch): 🟡
- Que o DSP mantém 96 kHz em outras taxas de stream: confirmado só com host
  a 48 kHz (B10)
- Que nenhuma troca pode estalar: B13 tem limites de detecção em HF e de timing
- Que variar `01 FF` seleciona RAM/flash: não testado; B12 omitiu o commit inteiro
- O gatilho do estado travado observado uma vez em B12c: desconhecido, não
  reproduzido em ≈1065 aplicações adicionais; fluxo contínuo de 11 min, ausência
  de áudio e aba oficial também com o cabo aberto não foram isolados como causas
- Durabilidade da flash, comportamento em corte de energia e demais sondas
  B5, B6, B8, B9 e B11: ainda não medidos

Ver [`open-questions.md`](open-questions.md) e [`probing.md`](probing.md).
