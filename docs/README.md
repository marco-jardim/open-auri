# Documentação — open-auri

Notas de engenharia reversa do firmware **`0xCB`** da família de chips **CB5100**
(bridge USB de áudio do ecossistema *Walkplay*, atribuído à Savitech).

Todo o conteúdo aqui é rastreável a uma fonte primária: código que funciona,
código aberto de terceiros, ou um documento de fabricante. O que não tem fonte
está marcado como hipótese ou pendência — não como fato.

## Legenda de confiança

| Marca | Significado |
|---|---|
| ✅ **Confirmado** | Verificado em código-fonte que funciona, ou em fonte primária citada (link). |
| 🟡 **Hipótese** | Inferência plausível a partir do formato, ainda **não** verificada em hardware. |
| ❌ **Pendente** | Só fecha com o cabo físico (captura HID) ou com informação do produto. |

> ⚠️ **Contexto de verificação.** Até a data desta nota **não havia cabo disponível**.
> Portanto *nada* no caminho de dispositivo foi validado em hardware. O que é ✅ é
> a reconstrução do formato a partir de uma implementação que grava na flash
> (a página `equalizador.kuba.audio`), não a confirmação de que o nosso código
> conversa com o chip.

## Índice

| Documento | Conteúdo |
|---|---|
| [`hardware.md`](hardware.md) | Fabricante do chip, VID/PID, módulos da TTGK, FCC, datasheets. |
| [`protocol-0xcb.md`](protocol-0xcb.md) | O wire format `0xCB` reconstruído byte a byte. |
| [`ecosystem.md`](ecosystem.md) | Implementações abertas de referência e o formato `0x4B` (irmão). |
| [`verification.md`](verification.md) | Testes (`npm test`): equivalência, verificações independentes e validação. |
| [`ideas.md`](ideas.md) | Usos previstos, excêntricos e não previstos abertos pelo protocolo. |
| [`social.md`](social.md) | Camada social: formato compacto, proveniência, versionamento, hospedagem. |
| [`probing.md`](probing.md) | Plano técnico: sondagem do firmware, testes cegos, otimizações de qualidade. |
| [`open-questions.md`](open-questions.md) | O que está confirmado, o que é hipótese, o que falta — e a errata. |

## Índice do núcleo

| Módulo ou documento | Estado |
|---|---|
| [`src/dsp/level.mjs`](../src/dsp/level.mjs) | em construção |
| [`src/dsp/distance.mjs`](../src/dsp/distance.mjs) | em construção |
| [`src/dsp/iso226.mjs`](../src/dsp/iso226.mjs) | em construção |
| [`src/safety/`](../src/safety/) | em construção |
| [`src/share/`](../src/share/) | em construção |
| [`src/io/`](../src/io/) | em construção |
| [`src/solver/`](../src/solver/) | em construção |
| [`src/catalog/`](../src/catalog/) | em construção |
| [`src/transport/`](../src/transport/) | em construção |
| [`src/policy/`](../src/policy/) | em construção |
| [`src/meter/`](../src/meter/) | em construção |
| [`schemas/`](../schemas/) | em construção |
| [`docs/s1-format.md`](s1-format.md) | em construção |

## Créditos

- **Presets e implementação de referência:** [Kuba](https://equalizador.kuba.audio/)
  (`kuba.audio`). A própria página credita a curva padrão a **Leonardo**
  ("Padrão = filtros do Leonardo"). Os bytes de referência em
  `test/fixtures/` derivam dessa implementação — ver
  [`verification.md`](verification.md). O codec implementa o layout de bytes
  aprendido dessa referência, sem código nem nomes dela.
- **Projeto dos filtros PK/LS/HS:** porte do [AutoEq](https://github.com/jaakkopasanen/AutoEq)
  (MIT, Jaakko Pasanen) — ver [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
- **Fórmulas dos filtros:** Robert Bristow-Johnson, *Audio EQ Cookbook*.

## Resumo executivo

- O chip que hospeda o DSP/PEQ é o **CB5100**, integrado em módulos pela
  **Shenzhen TTGK Technology** (dona do app *WalkPlay*). ✅ O fabricante é
  atribuído à **Savitech** por uma única fonte secundária. 🟡
- O cabo analisado enumera como VID `0x3302` / PID `0x8902` ("USB DSP Audio"). ✅
- Existem **dois wire formats** na mesma família de VID:
  - **`0x4B`** — padrão documentado em vários projetos abertos (Q30, byte de tipo de filtro, leitura). ✅
  - **`0xCB`** — o do cabo analisado ("EQ1#", Q27, CRC16, bloco de 10 bandas, leitura desconhecida). ✅ (formato) / ❌ (device)
  - Os dois parecem vir do mesmo SDK (`0xCB = 0x4B | 0x80`; slot `101` nos dois). 🟡
- Entre os projetos abertos pesquisados, nenhum descreve o `0xCB`; a única fonte é
  a própria página do kuba. ✅
- O codec reproduz a referência byte a byte e **recusa entradas que gravariam
  silêncio, um filtro instável ou pré-amp positivo** na flash. ✅
- A ordem das bandas importa: a referência põe **cortes antes dos reforços**, e
  inverter isso cria até +9 dB de pico interno (medido). ✅
- A spec oficial do PEQ **não é pública** (gated por NDA); FCC não se aplica a
  cabo USB sem rádio. ✅
