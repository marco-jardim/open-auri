# Status: confirmado, hipótese e pendente

> Até 2026-10-15 nada no caminho de dispositivo tinha sido validado em hardware.
> Em **2026-10-28** chegou o primeiro cabo real: WebHID (B1, B2) e o byte-stream
> no fio estão validados, assim como as sondas acústicas **B4, B7, B10, B12 e
> B13** (esta com ressalvas). Registro
> em [`probing.md`](probing.md#f-registro-de-resultados-com-o-cabo).

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
| O cabo expõe só o `0xCB`: output e input de 31 bytes (usos vendor `0xFF000002` / `0xFF000003`) e Consumer Control; **não existe report `0x4B`** | B1, cabo real (2026-10-28) |
| **Não há feature reports**: `receiveFeatureReport(0/1/0xCB)` dá `NotAllowedError` | B2, cabo real |
| O firmware **aceita sem erro** os bytes do codec: 11 presets oficiais + Neutro | captura USB, cabo real |
| Página oficial e open-auri mandam **os mesmos bytes**: 11/11 presets iguais ao fixture; `padrao` do open-auri igual ao oficial nos 10 reports | captura USB, `test/tools/usb-golden-real.test.mjs` |
| Commit de 5 bytes (referência) e de 31 bytes (codec) são **idênticos no fio**: o WebHID completa com zeros até 31 | captura USB (Windows/Edge) |
| No Windows/Chromium os reports vão por **interrupt OUT** (endpoint `0x05` nessa máquina), não por SET_REPORT | captura USB |
| O cabo **não responde** às gravações: nenhum input report, nenhum tráfego interrupt IN | captura USB; escuta passiva de 10 s |
| O firmware aceita os projetos PK de 2 e 5 kHz (−12 dB, Q3, pré-amp −0,5 dB) e os aplica como previsto; PK 2 kHz concorda com `magnitudeDb` em ~0,5 dB; Neutro reproduzível em ±0,5 dB | B4, medição acústica (2026-10-28) |
| O DSP roda a **96 kHz com stream do host a 48 kHz**: vales em 2000 e 5040 Hz, resolução de 1/6 de oitava + simetria | B10 |
| O firmware **valida o CRC**: PK 5 kHz com CRC corrompido mantém PK 2 kHz (2 medições); CRC correto aplica. Rejeição silenciosa, sem input report | B7 |
| Existe modo **só-RAM**: 9 reports de dados sem commit aplicam ao vivo; replug restaura o PK 2 kHz commitado. O commit persiste na flash; bytes `01 FF` não variados | B12 |
| O app oficial WalkPlay ([`peq.szwalkplay.com`](https://peq.szwalkplay.com/), espelho [`Ircama/walkplay`](https://github.com/Ircama/walkplay)) contém uma classe `"CB1100AU"` (fora do caminho principal do app, que cria a classe genérica `"CB"` pelo report `0x4B`) com o mesmo frame: `REPORT_ID 0xCB`, 9 pacotes de 30 bytes, Q27/Q23, `"EQ1#"`, CRC-16/CCITT-FALSE | código do app (2026-10-28); [`protocol-0xcb.md`](protocol-0xcb.md#confirmação-pelo-app-oficial-walkplay) |
| Bytes 4–5 do header = comprimento `14 + 20·n`; bytes 7 e 11 = `n`, nº de filtros ativos | `buildEqBuffer` do app oficial |
| Comando final: `01 <tag> 00 01 FF` salva na flash (`saveEqInfo`); `01 <tag> 00 00 FF` aplica sem salvar (`setEqInfo`) | app oficial |
| `01 65 00 00 FF` após os 9 reports é acusticamente equivalente a só dados (Neutro e PK 2 kHz −12 dB); tag sempre `80 65`, sem resposta aos dados/apply. Não persiste: após replug o cabo voltou à curva commitada | Kuba Auri real, QuadCast S (2026-10-28); registro em `probing.md`, seção F |
| **Existe leitura no `0xCB`, só da tag de EQ**: `80 00 00 00 FF` ⇒ input report `80 <tag> …`; no Kuba Auri a tag é `0x65` (101) | app oficial (`readEqTagId`); medido no cabo real (2026-10-28) |
| **Versão de firmware e curva gravada não podem ser lidas**: o app marca `readDeviceVersion`, `readFilterInfo` e outras como "芯片不支持" (o chip não suporta) para esta classe | app oficial |
| Troca Neutro → PK 2 kHz com tom de 2 kHz: queda de ~10 dB em rampa de ~15 ms, sem energia de clique audível nem mute no ensaio; limite de HF do microfone e ~17% de frames perdidos impedem excluir cliques só em HF e alinhar o tempo absoluto da escrita | B13, com ressalvas |

## Hipótese 🟡

| Hipótese | Base | Como verificar |
|---|---|---|
| O fabricante do CB5100 é a **Savitech** | **uma fonte só**, secundária (AuraPEQ, projeto de hobby); a TTGK nunca nomeia o fabricante | foto da marcação do chip; A2 |
| O núcleo do DSP mantém **96 kHz em outras taxas de stream** | B10 confirmou 96 kHz com host a 48 kHz | repetir em 44,1 / 96 / 192 kHz |
| O firmware do cabo **aceita qualquer biquad** (não só PK/LS) | não há byte de tipo; só 5 coeficientes | B4 + ensaio com HS/LP/HP |
| Bytes 8–10 do header (`04 05 01`) = geometria (4 bytes, 5 coef., 1 canal?) | padrão dos valores; o app oficial os escreve como constantes, sem nome (bytes 4–5 e 7/11 já confirmados acima) | B5 |
| Pode existir **EQ por canal** (se o byte 10 for nº de canais) | hipótese acima | B5 |
| `0xCB` e `0x4B` vêm do mesmo SDK | `0xCB = 0x4B \| 0x80`; commit contém `0x65 = 101 = FILTER_SLOT` do `0x4B` | A2 (o B1 mostrou que este cabo não expõe o `0x4B`) |
| O `padrao` é o preset de fábrica do Auri | "a assinatura do Auri" na referência | comparar com o cabo novo de fábrica |
| PID `0x8902` é uma revisão do CB5100 | VID Walkplay + formato aparentado ao `0x4B` | foto do chip / descriptors |

## Pendente ❌ (só com o cabo)

| Pendência | Por quê |
|---|---|
| ~~Existência de leitura no `0xCB`~~ | **resolvido**: só a tag de EQ (`80 00 00 00 FF` ⇒ `80 <tag>`), ver Confirmado. Pull/verify/rollback da curva e versão de firmware: não suportados, segundo o app oficial. A página do kuba continua sem ler nada |
| Significado das outras tags (além de `0x65`) | o app só lê a tag e a repete no comando final; não sabemos que valores existem nem o que mudam |
| Significado da flag interna que **nega o pré-amp** no app oficial | vista no código do app; a origem da flag não foi identificada |
| Frames com `n < 10` neste cabo | o app oficial envia só os filtros ativos; a página do kuba e o open-auri sempre enviam 10; não testado no cabo |
| Persistência do comando oficial de aplicar `01 65 00 00 FF` | comparação acústica com só dados **resolvida**: equivalentes no ensaio de 2026-10-28. Falta checar após replug se o apply persiste; “sem salvar” é a declaração do app |
| Significado dos bytes 6 e 12–13 do header | sem padrão aparente; o app oficial escreve `00` / `00 00` |
| Durabilidade da flash e efeito de corte de energia durante a gravação | desconhecidos |
| Comportamento de troca fora do ensaio B13; cliques muito curtos só em HF | limites do microfone e perda de frames; B13 não cobre todas as curvas |
| B3, B5, B6, B8, B9 e B11 | ainda não executadas; ver registro em `probing.md` |

Plano de sondagem para fechar cada linha, com prioridade e receita: [`probing.md`](probing.md).

### Tentativa de obter firmware (2026-10-28)

Não foi possível baixar firmware da classe genérica **CB (`0x4B`)**. Os caminhos
do app oficial `/api/v3-1/common/getFirmwareInfoListByPidAndVid` e
`checkFirmwareVersion` responderam **405** em `peq.szwalkplay.com` e **404** em
`www.szwalkplay.com`. A base real da API está ofuscada no bundle; o app ao vivo
exige um login que o usuário não consegue concluir. Investigação encerrada sem
firmware obtido; não se prosseguiu.

## Divergência conhecida e ainda não explicada

O bundle do kuba usa `0xCB` / `"EQ1#"` / Q27 / CRC16, que **não bate** com o
`0x4B` / Q30 / comando documentado da família. Duas coincidências (report ID
`0x4B | 0x80` e o slot `0x65 = 101` no commit) sugerem que os dois saem do mesmo
SDK: o `0xCB` pode ser um canal de baixo nível (bloco de coeficientes crus) ao
lado do protocolo por comandos. Não resolvido. ✅ (o fato de divergir) / 🟡 (o
parentesco) / ❌ (a causa)

## Estratégia enquanto não há hardware

1. **Core agnóstico de device** + camada de protocolo plugável com duas
   implementações: `0xCB` (do bundle) e `0x4B` (dos projetos abertos).
2. **Dummy device** (ideia do `glacier-eq`) para desenvolver tudo sem cabo.
3. **Teste de equivalência de payload** ✅ **feito**: ver [`verification.md`](verification.md).
4. **Validação antes da flash** ✅ **feita no codec**: nada nocivo chega ao `encodePayload()`.
5. **Console de pacotes TX/RX** para quando o cabo chegar.
6. Formato de arquivo `.txt` (EqualizerAPO / eq.hangout.audio) para import/export,
   com mapeamento **explícito** de `LSQ`/`HSQ`.

## Riscos

- **Sucesso só se prova no hardware.** Sem o cabo, o máximo verificável é o
  byte-stream; o resto é hipótese.
- **Escrita parcial corrompe.** O codec valida tudo antes de gerar o 1º relatório;
  o transporte ainda precisa tratar desconexão no meio do envio.
- **Sem leitura da curva ⇒ sem undo garantido.** O cabo só informa a tag de EQ;
  a curva gravada não pode ser lida. Mitigar com snapshot local do último envio
  e com o preset neutro (`NEUTRAL_BANDS`).
- **Desgaste da flash.** Cada commit grava; o teste cego e a gravação em lote
  multiplicam as gravações. B12 confirmou envio só-RAM sem commit; o modo sem
  flash ("Ouvir no cabo", #62), o X2 no cabo ("Comparar no cabo", #73) e o
  teste cego no cabo (aba "No cabo" do Teste cego, #74) estão implementados e
  tocam só na RAM, sem commit.
- **Licenças.** `eqloader` sem licença e `equalizer.js` proprietário: nada deles
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
| `ideas.md` X3 | pré-escuta "bit-exata" | com coeficientes exatos (aritmética interna desconhecida) | não se aplica |
| `social.md` S1 | `f` inteiro "como a referência grava"; 46 B | o `0xCB` não guarda `f`; 48 B com discriminador e CRC-8 | não se aplica |
| `social.md` S6 | agregação "anônima" via GitHub | pseudônima e pública; anônima exige servidor | não se aplica |
| `verification.md` | CRC como "único" teste independente | 7 verificações independentes | não se aplica |
| `open-questions.md` | `0x4B` no cabo 🟡; firmware `0xCB` ❌; commit de 5 × 31 bytes não verificado | sem `0x4B`; `0xCB` aceito; commits idênticos no fio | cabo real, 2026-10-28 |

## Fontes

Acessadas em 2026-10-14 e 2026-10-15.

- Página analisada: `https://equalizador.kuba.audio/` (sha256 do template em `test/fixtures/`)
- TTGK: `https://www.szttgk.com/en` (briefs de módulo em PDF)
- TTGK `TT39510B01` (brief do CB5100, 2024-06-14): `https://szttgk.com/uploads/files/20240725/51fad44bb79a05a35046af38b0017de5.pdf`
- TTGK CB5100PRO: `https://szttgk.com/en/product/HIFIhighfidelityaudiomodule/815.html`
- App oficial WalkPlay PEQ: `https://peq.szwalkplay.com/` (espelho offline `https://github.com/Ircama/walkplay`, `public/assets/index-BEOfvcHi.js`; acessado em 2026-10-28)
- AuraPEQ: `https://github.com/mandy321/Audiocular-Aura` (protocolo em `dist/assets/index.js`)
- frost-tune: `https://github.com/Bukutsu/frost-tune` (`src/hardware/devices/walkplay_protocol.rs`)
- eqloader: `https://github.com/devilAPI/walkplay-eqloader` (+ `eqloader.py` na branch `legacy-tkinter`)
- devicePEQ: `https://github.com/jeromeof/devicePEQ`
- eq.hangout.audio: `https://eq.hangout.audio/shared/equalizer.js`
- AutoEq (MIT): `https://github.com/jaakkopasanen/AutoEq`
- Savitech: `https://www.savitech-ic.com/products`, `https://www.savitech.co`
- FCC (homônimo, não relacionado): `https://fccid.io/2AVJ8-CB5100`
