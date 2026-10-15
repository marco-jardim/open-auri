# Status: confirmado, hipótese e pendente

> Nada no caminho de dispositivo foi validado em hardware — **não havia cabo
> disponível** nas sessões que produziram esta documentação.

## Confirmado ✅

| Achado | Fonte |
|---|---|
| O bridge que hospeda o PEQ se chama **CB5100**; variantes CB5100PRO / SPV5048PRO | briefs TTGK |
| Integrador/módulo e app **WalkPlay** = Shenzhen TTGK | site e PDFs da TTGK |
| VID `0x3302` / PID `0x8902`; report ID `0xCB`; 31 bytes; coeficientes projetados a `FS = 96000` | bundle do kuba |
| Wire format `0xCB`: header, pré-amp Q23, 10×5 coef. Q27, CRC16 | bundle do kuba |
| Ordem `[b0, b2, -a1, b1, -a2]`, `a0` implícito | bundle do kuba |
| Fatiamento 9 × 31 bytes + commit `[01 65 00 01 FF]`; 16 ms / 150 ms | bundle do kuba |
| A referência ordena **cortes antes dos reforços** de propósito, para evitar clipping | comentário na fonte do kuba; medido (pico interno −0,20 dB × +9,13 dB invertido) |
| Wire format `0x4B` (Q30, byte de tipo, leitura) | frost-tune, eqloader, AuraPEQ |
| Existem dois wire formats distintos na mesma família de VID | comparação cruzada |
| O caminho "Savitech" do AuraPEQ usa pré-amp em passo de **1,0 dB** | AuraPEQ |
| **Nosso codec reproduz o byte-stream da referência byte a byte**, nos 11 presets | `test/eq0xcb.test.mjs` |
| **O codec recusa entradas que gravariam silêncio, filtro instável ou pré-amp positivo** | `test/eq0xcb.test.mjs` |
| Erro de quantização Q27 é irrelevante (≤ 0,017 dB no pior caso extremo) | medido |
| O limite de `int32` depende do tipo (PK +31 dB, LS +48,5 dB, HS +18,5 dB); cortes nunca estouram | medido |
| A curva desenhada do `pref6` difere da gravada em até 3,87 dB (3–8 kHz) e 7,29 dB (11,5 kHz) | medido |
| Tipos de filtro anunciados para a família: **PK, LS, HS, LP, HP** (+ notch) | specs Keysion; README AuraPEQ |
| FCC não se aplica (cabo USB sem rádio); o `FCC ID 2AVJ8-CB5100` é **outro produto** | busca 2026-10-14/15 |
| Spec oficial do PEQ é **NDA-gated**, não pública | relato da comunidade |

## Hipótese 🟡

| Hipótese | Base | Como verificar |
|---|---|---|
| O fabricante do CB5100 é a **Savitech** | **uma fonte só**, secundária (AuraPEQ, projeto de hobby); a TTGK nunca nomeia o fabricante | foto da marcação do chip; A2 |
| O núcleo do DSP roda em **96 kHz fixos**, independente do stream | 3 implementações independentes projetam a 96 kHz (kuba, eqloader, frost-tune) | B10 |
| O firmware do cabo **aceita qualquer biquad** (não só PK/LS) | não há byte de tipo; só 5 coeficientes | B4 + ensaio com HS/LP/HP |
| Bytes 4–5 do header = **comprimento** (u16 LE 214 = 220 − 6) | bate exatamente | B5 |
| Bytes 7–11 do header = geometria (10 seções, 4 bytes, 5 coef., 1 canal?, 10) | padrão dos valores | B5 |
| Pode existir **EQ por canal** (se o byte 10 for nº de canais) | hipótese acima | B5 |
| `0xCB` e `0x4B` vêm do mesmo SDK | `0xCB = 0x4B \| 0x80`; commit contém `0x65 = 101 = FILTER_SLOT` do `0x4B` | B1 |
| O cabo também expõe o report `0x4B` | hipótese acima | B1 (sem risco) |
| O `padrao` é o preset de fábrica do Auri | "a assinatura do Auri" na referência | comparar com o cabo novo de fábrica |
| PID `0x8902` é uma revisão do CB5100 | VID Walkplay + formato aparentado ao `0x4B` | foto do chip / descriptors |

## Pendente ❌ (só com o cabo)

| Pendência | Por quê |
|---|---|
| Confirmar que o firmware é o `0xCB` (e não o `0x4B`, ou ambos) | não sabemos o firmware do produto |
| **Existência de leitura** no `0xCB` (pull/verify/rollback) | desconhecida — a página nunca lê; nenhum projeto aberto documenta |
| Significado dos bytes 6 e 12–13 do header | sem padrão aparente |
| Se o firmware **valida** o CRC | B7 |
| Se existe modo **só-RAM** (sem gravar na flash) | B12 |
| Durabilidade da flash e efeito de corte de energia durante a gravação | desconhecidos |
| Se a troca de preset estala durante a reprodução | B13 |
| Validação de escrita de fato | precisa gravar e ouvir/medir |
| Endereço USB completo / strings / interface HID | precisa enumerar |

Plano de sondagem para fechar cada linha, com prioridade e receita: [`probing.md`](probing.md).

## Divergência conhecida e ainda não explicada

O bundle do kuba usa `0xCB` / `"EQ1#"` / Q27 / CRC16, que **não bate** com o
`0x4B` / Q30 / comando documentado da família. Duas coincidências (report ID
`0x4B | 0x80` e o slot `0x65 = 101` no commit) sugerem que os dois saem do mesmo
SDK — o `0xCB` pode ser um canal de baixo nível (bloco de coeficientes crus) ao
lado do protocolo por comandos. Não resolvido. ✅ (o fato de divergir) / 🟡 (o
parentesco) / ❌ (a causa)

## Estratégia enquanto não há hardware

1. **Core agnóstico de device** + camada de protocolo plugável com duas
   implementações: `0xCB` (do bundle) e `0x4B` (dos projetos abertos).
2. **Dummy device** (ideia do `glacier-eq`) para desenvolver tudo sem cabo.
3. **Teste de equivalência de payload** ✅ **feito** — ver [`verification.md`](verification.md).
4. **Validação antes da flash** ✅ **feita no codec** — nada nocivo chega ao `encodePayload()`.
5. **Console de pacotes TX/RX** para quando o cabo chegar.
6. Formato de arquivo `.txt` (EqualizerAPO / eq.hangout.audio) para import/export,
   com mapeamento **explícito** de `LSQ`/`HSQ`.

## Riscos

- **Sucesso só se prova no hardware.** Sem o cabo, o máximo verificável é o
  byte-stream; o resto é hipótese.
- **Escrita parcial corrompe.** O codec valida tudo antes de gerar o 1º relatório;
  o transporte ainda precisa tratar desconexão no meio do envio.
- **Leitura desconhecida ⇒ sem undo garantido.** Mitigar com snapshot local do
  último envio e com o preset neutro (`NEUTRAL_BANDS`).
- **Desgaste da flash.** Cada commit grava; o teste cego e a gravação em lote
  multiplicam as gravações. Achar o modo só-RAM (B12) vem antes de usar X2/X9 em
  escala.
- **Licenças.** `eqloader` sem licença e `equalizer.js` proprietário — nada deles
  foi usado. O codec porta o projeto de PK/LS/HS do AutoEq (**MIT**, aviso em
  `THIRD_PARTY_NOTICES.md`) e não contém código nem nomes da referência do kuba.

## Errata

Correções da revisão de 2026-10-15. O texto antigo estava errado ou superestimado.

| Onde | Antes | Agora | Base |
|---|---|---|---|
| codec | `blob()` (hoje `encodePayload()`) aceitava `q = 0`, `f = NaN` (seção muda), `q < 0`, `f > Nyquist` (seção instável) e pré-amp `NaN` | recusa todos, e verifica estabilidade nos coeficientes quantizados | testes |
| codec | seguia a estrutura e os nomes do código da referência | projeto dos filtros portado do AutoEq (MIT), nomes próprios; mesmos bytes | diferencial de 196 mil bandas |
| codec | tipo desconhecido virava peaking em silêncio | erro | testes |
| `protocol-0xcb.md` | "~±24 dB por seção" | limite depende do tipo; cortes nunca estouram | medido |
| `protocol-0xcb.md` | reordenar as bandas tem efeito "desprezível" | o pico interno vai de −0,20 dB a +9,13 dB conforme a ordem | medido |
| `protocol-0xcb.md` | banda desligada = peaking com `g = 0` | identidade exata (`OFF`) | polos perto do círculo unitário |
| `social.md` | forma canônica ordenada por `f` sem ressalva | só para compartilhar; o envio mantém cortes primeiro | medido (+4,79 dB) |
| `probing.md` B7 | "mesma curva com CRC errado" | curva **diferente** com CRC errado (senão o teste não informa nada) | lógica |
| `probing.md` B10 | peaking negativo põe "zeros na circunferência unitária" | só o notch faz isso | matemática |
| `probing.md` B3 | varredura de comandos "de baixo risco" | risco alto às cegas; restringir a comandos de leitura | risco de reset/DFU/apagamento |
| `probing.md` D1 | "cortes primeiro" tratado como risco de ruído | é o padrão correto; estouro domina | medido |
| `probing.md` D2 | pré-amp "nunca estoura internamente" | falso (harman) e não protege banda larga | medido |
| `probing.md` C1/B8/D3 | quantização Q27 merecia teste e otimização | irrelevante (≤ 0,017 dB) | medido |
| `probing.md` D9 | `FS` como "item nº 1" 🚨 | urgência rebaixada (3 fontes) | eqloader, frost-tune |
| `hardware.md` | fabricante Savitech ✅ | 🟡, fonte única secundária | busca 2026-10-15 |
| `ideas.md` | "sem leitura" ✅ e "sem L/R" ✅ | leitura desconhecida ❌; L/R 🟡 | header |
| `ideas.md` X3 | pré-escuta "bit-exata" | com coeficientes exatos (aritmética interna desconhecida) | — |
| `social.md` S1 | `f` inteiro "como a referência grava"; 46 B | o `0xCB` não guarda `f`; 48 B com discriminador e CRC-8 | — |
| `social.md` S6 | agregação "anônima" via GitHub | pseudônima e pública; anônima exige servidor | — |
| `verification.md` | CRC como "único" teste independente | 7 verificações independentes | — |

## Fontes

Acessadas em 2026-10-14 e 2026-10-15.

- Página analisada: `https://equalizador.kuba.audio/` (sha256 do template em `test/fixtures/`)
- TTGK: `https://www.szttgk.com/en` (briefs de módulo em PDF)
- AuraPEQ: `https://github.com/mandy321/Audiocular-Aura` (protocolo em `dist/assets/index.js`)
- frost-tune: `https://github.com/Bukutsu/frost-tune` (`src/hardware/devices/walkplay_protocol.rs`)
- eqloader: `https://github.com/devilAPI/walkplay-eqloader` (+ `eqloader.py` na branch `legacy-tkinter`)
- devicePEQ: `https://github.com/jeromeof/devicePEQ`
- eq.hangout.audio: `https://eq.hangout.audio/shared/equalizer.js`
- AutoEq (MIT): `https://github.com/jaakkopasanen/AutoEq`
- Savitech: `https://www.savitech-ic.com/products`, `https://www.savitech.co`
- FCC (homônimo, não relacionado): `https://fccid.io/2AVJ8-CB5100`
