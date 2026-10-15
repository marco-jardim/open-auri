# Status: confirmado, hipótese e pendente

> Nada no caminho de dispositivo foi validado em hardware — **não havia cabo
> disponível** nas sessões que produziram esta documentação.

## Confirmado ✅

| Achado | Fonte |
|---|---|
| Chip do PEQ é o **Savitech CB5100** (S-Core); variantes CB5100PRO / SPV5048PRO | briefs TTGK; tabela do AuraPEQ |
| Integrador/módulo e app **WalkPlay** = Shenzhen TTGK | site e PDFs da TTGK |
| VID `0x3302` / PID `0x8902`; report ID `0xCB`; 31 bytes; `FS = 96000` | bundle do kuba |
| Wire format `0xCB`: header, pré-amp Q23, 10×5 coef. Q27, CRC16 | bundle do kuba |
| Ordem `[b0, b2, -a1, b1, -a2]`, `a0` implícito | bundle do kuba |
| Fatiamento 9 × 31 bytes + commit `[01 65 00 01 FF]`; 16 ms / 150 ms | bundle do kuba |
| Wire format `0x4B` (Q30, byte de tipo, leitura) | frost-tune, eqloader, AuraPEQ |
| Existem dois wire formats distintos na mesma família de VID | comparação cruzada |
| Savitech usa preamp em passo de **1,0 dB** | AuraPEQ |
| **Nosso codec reproduz o byte-stream da referência byte a byte**, nos 11 presets | `test/eq0xcb.test.mjs` (28/28) |
| Tipos de filtro possíveis: **PK, LS, HS, LP, HP** (+ notch) | specs Keysion; README AuraPEQ |
| FCC não se aplica (cabo USB sem rádio); nenhum filing achado | busca 2026-10-14 |
| Spec oficial do PEQ da Savitech é **NDA-gated**, não pública | relato da comunidade |

## Hipótese 🟡

| Hipótese | Base | Como verificar |
|---|---|---|
| O firmware do cabo **aceita qualquer biquad** (não só RBJ PK/LS) | não há byte de tipo; só 5 coeficientes | protótipo no cabo |
| O `0x0A` (offset 7 e 11 do header) = nº de bandas (10) | valor 10 repetido | leitura do código do chip / engenharia reversa do FW |
| Ganho por seção limitado a ~**±24 dB** | \|coef\| < 16 em Q27 | ensaio no cabo |
| 10 bandas cobrem de 1 a 10 seções reais (`g=0` ⇒ identidade) | álgebra RBJ | ensaio no cabo |
| PID `0x8902` é uma revisão do CB5100 | VID Walkplay + formato Savitech-like | foto do chip / descriptors |

## Pendente ❌ (só com o cabo)

| Pendência | Por quê |
|---|---|
| Confirmar que o firmware é o `0xCB` (e não o `0x4B`) | não sabemos o firmware do produto |
| **Comandos de leitura** do `0xCB` (pull/verify/rollback) | a página nunca lê; nenhum projeto aberto documenta |
| Significado completo dos 10 bytes do header `"EQ1#"` | não documentado |
| Se há canal de *input reports* (resposta) | nunca usado pela página |
| Validação de escrita de fato | precisa gravar e ouvir/medir |
| Endereço USB completo / strings / interface HID | precisa enumerar |

Plano de sondagem para fechar cada linha, com prioridade e receita: [`probing.md`](probing.md).

## Divergência conhecida e ainda não explicada

O bundle do kuba usa `0xCB` / `"EQ1#"` / Q27 / CRC16, que **não bate** com o
`0x4B` / Q30 / comando documentado do CB5100. Como o VID `0x3302` **é** o da
família Walkplay, o chip é quase certamente um Savitech S-Core — mas o firmware
**`0xCB`** é uma variante que **nenhum projeto aberto descreve**. Pode ser:
revisão de firmware, customização de ODM, ou a interface HID de baixo nível do
módulo. Não resolvido. ✅ (o fato de divergir) / ❌ (a causa)

## Estratégia enquanto não há hardware

1. **Core agnóstico de device** + camada de protocolo plugável com duas
   implementações: `0xCB` (do bundle) e `0x4B` (dos projetos abertos).
2. **Dummy device** (ideia copiada do `glacier-eq`) para desenvolver tudo sem cabo.
3. **Teste de equivalência de payload** ✅ **feito** — `src/dsp/eq0xcb.mjs`
   reproduz o byte-stream da referência byte a byte (11 presets). Ver
   [`verification.md`](verification.md). É o que prova que a RE do formato
   `0xCB` está correta — e roda **sem** cabo.
4. **Console de pacotes TX/RX** para quando o cabo chegar.
5. Formato de arquivo `.txt` (EqualizerAPO / eq.hangout.audio) para import/export.

## Riscos

- **Sucesso só se prova no hardware.** Sem o cabo, o máximo verificável é o
  byte-stream; o resto é hipótese.
- **Escrita parcial corrompe.** Validar os 10×5 coeficientes (faixa + estabilidade)
  **antes** de enviar o 1º relatório; abortar tudo se qualquer banda falhar.
- **Sem leitura, não há undo.** Só regravar; mitigar com snapshot local do último envio.
- **Licenças.** `eqloader` sem licença e `equalizer.js` proprietário; o repo é
  AGPL-3.0 — portar *algoritmo*, não *código*.

## Fontes (acessadas em 2026-10-14)

- Página analisada: `https://equalizador.kuba.audio/`
- TTGK: `https://www.szttgk.com/en` (briefs de módulo em PDF)
- AuraPEQ: `https://github.com/mandy321/Audiocular-Aura` (protocolo em `dist/assets/index.js`)
- frost-tune: `https://github.com/Bukutsu/frost-tune` (`src/hardware/devices/walkplay_protocol.rs`)
- eqloader: `https://github.com/devilAPI/walkplay-eqloader` (+ `eqloader.py` na branch `legacy-tkinter`)
- devicePEQ: `https://github.com/jeromeof/devicePEQ`
- eq.hangout.audio: `https://eq.hangout.audio/shared/equalizer.js`
- Savitech: `https://www.savitech-ic.com/products`, `https://www.savitech.co`
