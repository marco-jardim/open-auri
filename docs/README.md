# Documentação — open-auri

Notas de engenharia reversa do firmware **`0xCB`** da família de chips **CB5100**
(bridge USB de áudio da Savitech, ecossistema *Walkplay*).

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
| [`verification.md`](verification.md) | Teste de equivalência do payload (`npm test`) e o que ele prova. |
| [`ideas.md`](ideas.md) | Usos previstos, excêntricos e não previstos abertos pelo protocolo. |
| [`social.md`](social.md) | Camada social: formato compacto, proveniência, versionamento, hospedagem. |
| [`probing.md`](probing.md) | Plano técnico: sondagem do firmware, testes cegos, otimizações de qualidade. |
| [`open-questions.md`](open-questions.md) | O que está confirmado, o que é hipótese e o que falta. |

## Créditos

- **Presets e implementação de referência:** [Kuba](https://equalizador.kuba.audio/)
  (`kuba.audio`). A própria página credita a curva padrão a **Leonardo**
  ("Padrão = filtros do Leonardo"). Os bytes de referência em
  `test/fixtures/` derivam dessa implementação — ver
  [`verification.md`](verification.md).

## Resumo executivo

- O chip que hospeda o DSP/PEQ é o **Savitech CB5100** (linha S-Core), integrado em
  módulos pela **Shenzhen TTGK Technology** (dona do app *WalkPlay*). ✅
- O cabo analisado enumera como VID `0x3302` / PID `0x8902` ("USB DSP Audio"). ✅
- Existem **dois wire formats** na mesma família de VID:
  - **`0x4B`** — padrão documentado em vários projetos abertos (Q30, byte de tipo de filtro, leitura). ✅
  - **`0xCB`** — o do cabo analisado ("EQ1#", Q27, CRC16, bloco de 10 bandas, sem leitura conhecida). ✅ (formato) / ❌ (device)
- O formato `0xCB` **só está documentado na própria página do kuba**; nenhum projeto aberto o descreve. ✅
- A spec oficial do PEQ da Savitech **não é pública** (gated por NDA); FCC não se aplica a
  cabo USB sem rádio. ✅
