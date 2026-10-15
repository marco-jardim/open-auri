# Hardware — fabricante do chip e identificação

## Resumo

O PEQ roda **dentro do bridge chip USB**, não no DAC decodificador. Na família
que estamos tratando, esse bridge é o **Savitech CB5100**.

| Camada | Componente | Confiança |
|---|---|---|
| Bridge USB + DSP/PEQ | **Savitech CB5100** (linha S-Core) | ✅ |
| Variantes do mesmo bridge | **CB5100PRO**, **SPV5048PRO** | ✅ |
| Fabricante do chip | **Savitech Corp. (盛微先進科技)**, Taiwan | ✅ |
| Integrador do módulo / dono do app *WalkPlay* | **Shenzhen TTGK Technology (通通高科)**, Shenzhen, desde 2014 | ✅ |
| DAC decodificador (a jusante) | Cirrus Logic **CS43131** / **CS43198** (comum); AKM **AK4493S** | ✅ |

O DAC decodificador **não** é onde o PEQ é aplicado — por isso ele varia entre
produtos sem afetar o protocolo.

## VID / PID

| ID | Valor | Observação | Confiança |
|---|---|---|---|
| VID do produto analisado | `0x3302` | "Walkplay" — VID compartilhado por vários dongles | ✅ |
| PID do produto analisado | `0x8902` | string USB "USB DSP Audio" | ✅ |
| VID registrado da Savitech | `0x262A` | aparece no `usb.ids` | ✅ |
| PID do TRN Black Pearl | `0x43E8` (VID `0x3302`) | mesmo chipset CB5100 + CS43131 | ✅ |
| Registrante do `0x3302` | — | **não confirmado** em nenhuma lista pública | 🟡 |

O `0x3302` **não** é o VID registrado da Savitech (`0x262A`); é um VID
compartilhado pela família Walkplay. Quem o registrou não foi identificado.

O PID `0x8902` não aparece em nenhuma tabela pública de dispositivos.

## Evidências

### 1. Datasheets de módulo da TTGK (públicos)

A TTGK publica os *briefs* dos próprios módulos, que nomeiam o bridge e o
número de bandas de EQ:

| Módulo | Bridge | DAC | EQ |
|---|---|---|---|
| `TT39518B01` | CB5100 | CS43198 | 8 bandas |
| `TT39518K01` | CB5100 | CS43198 | 10 bandas |
| `TT39493F01-PRO` | CB5100PRO | AK4493S | 8 bandas |
| `TTUM39518-PRO` | SPV5048PRO | CS43198 | 10 bandas |

Trecho (tradução): *"bridge USB de áudio de alta performance **CB5100** … DSP/ADC/PGA
de alta performance integrado, suporta configuração flexível de EQ de 8 seções …
suporta **EQ do app WALK PLAY**"*.
Fontes: `szttgk.com` (PDFs de produto, busca de 2026-10-14).

### 2. Tabela de dispositivos do AuraPEQ (código-fonte público)

O bundle do projeto `mandy321/Audiocular-Aura` embute a identificação:

```
"TRN Black Pearl",  chipset:"Savitech CB5100 + CS43131",  protocol:"SAVITECH",  VID 0x3302
"Audiocular Aura",  chipset:"Savitech CB5100 + CS43131",  protocol:"SAVITECH",  VID 0x3302
"Fosi Audio DS2 / iBasso DC04 Pro", chipset:"Savitech Official (CB5100 series)", VID 0x262A
```

### 3. Specs de venda de produtos com o mesmo chip

- **TRN Black Pearl** — "CB5100 USB audio bridge chip … inner DSP chip supports **8 bands PEQ** through the **Walk Play app**".
- **Keysion KSHF-02 Pro** — "**CB5100 Pro** … 10-segment EQ, **five filter modes**, WALK PLAY APP EQ linkage".

## Precisão de preamp

O AuraPEQ trata o caminho Savitech com passo de **1,0 dB**, contra 0,1 dB de
Moondrop/FiiO. ✅ Fonte: `dist/assets/index.js` do AuraPEQ (`n === "SAVITECH" ? step 1 : step 0.1`).

## Tipos de filtro

- "**Five filter modes**" (specs do Keysion) ⇒ **PK, LS, HS, LP, HP**. ✅
- O AuraPEQ afirma que o DSP executa "RBJ cookbook filters (Peak, Low Shelf,
  High Shelf, and Notch)". ✅ (do README do projeto)

## FCC — beco sem saída

**Não** há FCC ID esperado para um cabo/dongle DAC USB **sem rádio** (FCC cobre
emissor intencional). Nenhum arquivamento foi encontrado para Savitech, TTGK ou
CB5100, e não deveria existir. ✅ (ausência verificada em busca 2026-10-14)

Para tentar FCC seria preciso o **modelo/marca exato** do cabo e, ainda assim,
só valeria se houvesse versão com Bluetooth.

## Datasheets públicas — o que existe e o que não existe

| Existe público | Não existe público |
|---|---|
| Datasheets dos controladores USB **antigos** da Savitech: `SA9312L`, `SA9137` | O mapa de registradores / guia de programação do **PEQ** |
| Briefs de módulo da TTGK (feature-level) | Datasheet do **CB5100** |
| A implementação do protocolo (ver [`ecosystem.md`](ecosystem.md)) | Qualquer doc oficial do protocolo HID do CB5100 |

A Savitech é notoriamente fechada; o guia de programação é **gated por NDA**
(relato da comunidade: *"requires NDA to get FW USB programming app"*).
Consequência: **a especificação do protocolo não sai de datasheet** — sai de
engenharia reversa.

## O que ainda falta para confirmar o hardware do cabo

1. Marca/modelo do cabo, ou **foto do chip** (marcação no encapsulamento).
2. O cabo físico, para ler os descriptors USB e a string de produto.

Ver [`open-questions.md`](open-questions.md).
