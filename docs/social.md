# Camada social — curvas como objetos compartilháveis

Ideias para transformar o preset de "configuração que mora num cabo" em
**conteúdo que circula**: código curto, proveniência, versionamento, curadoria.

Marca de confiança: ✅ confirmado/medido · 🟡 hipótese · ❌ precisa do cabo.

## Antes: calibração de *prior art*

Isto **não** é território virgem. O `jeromeof/devicePEQ` já tem `sharePEQ/`,
`visualizePEQ/`, `subjectizePEQ/` e `treblizerPEQ/` — compartilhar e visualizar
preset é padrão naquele ecossistema (`0x4B`).

O que **é** novo aqui: fazer isso para `0xCB` **e** as camadas que eles não têm —
forma compacta canônica (S1), proveniência (S2), versionamento (S3), envelope com
receita (S5) e agregação sem servidor (S6).

## Estado das decisões

| ID | Ideia | Decisão |
|---|---|---|
| **S1** | Formato compacto canônico | ✅ **adotar** — 46 B, campo fixo, zero codec |
| **S2** | Assinatura criptográfica | ❌ **descartada** — proveniência por link basta |
| **S3** | Curvas versionadas (git) | ✅ **adotar** — 100% estático, sem backend |
| **S4** | Distância entre curvas | ✅ **adotar** — barato, `response()` já existe |
| **S5** | Envelope: números **+** receita | ✅ **adotar** — os dois, não um ou outro |
| **S6** | Preferência crowdsourced | ✅ **adotar** — agregável via GitHub Actions |
| **S7** | "Blind trade" | 🟡 opcional |
| **S8** | Curva como identidade | 🟡 opcional |
| **S9** | Packs curados e licenciáveis | ✅ **adotar** — resolve licença de curva |
| **S10** | Antes/depois compartilhável | ✅ **adotar** — barato, é o que faz circular |

---

## S1 — O formato compacto ✅

O blob de gravação tem 220 B (296 chars em base64). Isso não circula num post.
O preset real, porém, é só `(type, f, g, q)` × 10 + preamp.

### Medição (corpus: 11 presets, 110 bandas)

| Esquema | Bytes | base64url | base85 |
|---|---|---|---|
| blob cru (referência) | 220 | 296 | 275 |
| campo fixo, domínio restrito | **46** | **64** | 58 |
| campo fixo, domínio *perceptual* (f em 1/96 oitava) | 39 | 52 | 49 |
| entropia ideal medida | 22,6 | 32 | 29 |

⚠️ Os 22,6 B são **overfit**: 104 valores distintos de `f` em 110 amostras. Todo
`f` inédito precisaria de escape, então não é alcançável — é estimativa otimista.

### O ponto conceitual

**"Lossless" não é propriedade dos bytes — é propriedade do domínio canônico
escolhido.** Cortar os valores impossíveis **é** a compressão: 220 → 46 B sem
algoritmo nenhum (4,8×). Comprimir algoritmicamente por cima rende no máximo
~1,5×, ao custo de um codec, de fragilidade e de perder a depurabilidade. Aos
46 bytes, os 33% de overhead do base64 já dominam.

### Domínio canônico (46 B)

| Campo | Bits | Domínio | Racional |
|---|---|---|---|
| `type` | 3 | 5 valores | hoje só `PK`/`LS` aparecem (entropia real 0,23 bit) |
| `f` | 15 | Hz inteiro < 32768 | **exato**, e é como a referência já grava |
| `g` | 8 | int8 a 0,1 dB | cobre −12,7..+12,7 (observado: −12,0..+9,2) |
| `q` | 10 | a 0,01 | cobre ≤ 10,23 (observado: 0,10..4,00) |
| `preamp` | 8 | int8 a 0,1 dB | 1 por preset |
| **total** | **368 bits = 46 B** | 10 × 36 bits + 8 bits | |

O range observado é **estreito** — é aí que está o ganho, não em algoritmo.

**Variante de 39 B rejeitada:** `f` numa grade de 1/96 oitava (925 passos) tem erro
máximo de **0,36%** em `f`. Economiza 7 bytes = 12 caracteres, e cobra o adjetivo
"lossless". Não vale.

### Dois sabores + discriminador ✅

| Sabor | Conteúdo | Tamanho | Quando |
|---|---|---|---|
| `parametric` | 10 × `(type, f, g, q)` + preamp | 46 B | curvas RBJ — praticamente tudo |
| `raw` | 10 × 5 coeficientes int32 | 200 B | biquad que não é expressável como RBJ |

Um byte de discriminador resolve. Sem ele, o formato compacto mentiria sobre
curvas desenhadas direto em coeficientes.

### Canonicalização por ordenação ✅

Bandas em série **comutam** (LTI). Portanto qualquer preset pode ser **ordenado
por `f`** para virar forma canônica — o que torna diff, hash e comparação
determinísticos de graça. A resposta em frequência é idêntica.

> ⚠️ Só não reordene o **envio** sem motivo: os coeficientes são calculados por
> banda e não mudam, mas a ordem de processamento interna do chip é fixa.

---

## S2 — Proveniência, não assinatura ❌ descartada

Assinatura criptográfica foi **descartada**, e o argumento é bom: o pior caso de
uma curva adulterada é um EQ diferente — sem dano. E sem leitura não há como
verificar nada de qualquer forma.

Substituto: campo **`source`** apontando para a origem canônica (commit, PR,
gist). É verificável de graça e é a identidade real.

Assinatura só voltaria em um cenário: **S9 virar comercial** (packs vendidos). Aí
o correto é assinar **a receita** (medição + alvo + versão do solver), não o blob.

---

## S3 — Hospedagem: GitHub Pages dá conta ✅

**S1, S3, S4, S5, S8, S10 rodam 100% estáticos.** Três mecanismos:

1. **Fragmento de URL** (`#p=<código>`, 64 chars) — zero armazenamento.
   Compartilhar é mandar um link.
2. **Repo-como-banco** — presets como arquivos de texto. A **UI do GitHub é a
   camada social**: PR = contribuição, issue = discussão, blame = atribuição,
   fork = remix, stars = curadoria, licença por arquivo = S9. Versionamento,
   histórico e revisão saem de graça.
3. **Busca no cliente** — 10.000 presets × 64 chars ≈ **640 KB**. Nada.
   Fuse.js client-side, que é o que o próprio `eq.hangout.audio` usa.

### Agregação sem servidor (destrava o S6) ✅

**GitHub Actions como backend.** Resultados opt-in entram como dado no repo; um
job agendado recalcula o alvo da comunidade e publica o JSON. Sem servidor, sem
custo — e **o dataset inteiro fica auditável**, o que é vantagem, não remédio.

### Quando o backend é inevitável

| Necessidade | Por quê |
|---|---|
| escrita por usuário não-técnico | git é barreira real |
| identidade / conta | OAuth do GitHub exige troca de token → Worker mínimo |
| S7 (pareamento anônimo) | precisa de estado do servidor |
| ranking/voto além do GitHub | idem |
| telemetria e antabuso | idem |

Stack natural: **Cloudflare Workers + KV/D1/R2**, free tier cobre isto
trivialmente.

**Recomendação: começar 100% estático.** O Worker entra quando a agregação doer.

Requisitos atendidos: Pages é HTTPS ⇒ WebHID funciona ✅. Limites do Pages
(repo ~1 GB, ~100 GB/mês, ~10 builds/h) são irrelevantes nesta escala ✅.

---

## S4 — Distância entre curvas ✅

Comparação exata: amostrar as duas respostas numa grade log e reportar delta RMS,
delta máximo e **onde** divergem ("+2,3 dB a 150 Hz; acima de 4 kHz idênticas").

Usos: escolher entre 3 curvas compartilhadas, saber se vale baixar, e "esta é a
minha com mais grave". A `response()` do codec já faz o trabalho pesado.

---

## S5 — Envelope: números **e** receita ✅

O envelope carrega **as duas coisas**, e cada uma resolve um problema distinto:

| Parte | O que garante |
|---|---|
| os **10 números** | autossuficiência — aplica offline, sem base, sem rede |
| a **receita** (medição + alvo + versão do solver) | auditabilidade e re-derivação |

Só receita deixa o app refém da base de dados; só números, ninguém audita.

```json
{
  "format": "open-auri/preset@1",
  "kind": "parametric",
  "name": "Exemplo",
  "author": "…",
  "source": "https://github.com/<org>/<repo>/commit/<sha>",
  "license": "CC0-1.0",
  "code": "<S1, 64 chars>",
  "preamp": -3.4,
  "bands": [{ "type": "PK", "f": 150, "g": -3.0, "q": 0.69 }],
  "recipe": {
    "measurement": "AutoEq:oratory1990/<modelo>",
    "target": "JM-1",
    "solver": { "name": "autoeq", "version": "1", "params": {} }
  }
}
```

---

## S6 — Preferência crowdsourced ✅

O teste cego (X2 em [`ideas.md`](ideas.md)) gera pares A/B **localmente**. Com
opt-in, sobe só o resultado anônimo dos pares — e a comunidade constrói um **alvo
derivado de dados reais**, continuamente. É como a curva Harman nasceu, mas
aberto e sem parar. Transforma usuários em corpus.

Agregável pelo truque do S3 (Actions). Depende do X2 e do cabo ❌.

---

## S7 — "Blind trade" 🟡 opcional

Dois usuários trocam curvas **anonimamente** e pontuam. Gamifica a coleta e dá ao
autor feedback **sem viés de marca ou nome**. Precisa de backend.

## S8 — Curva como identidade 🟡 opcional

Assinatura sonora como avatar em reviews/fóruns; cartões de preset imprimíveis
com QR. Une digital e físico. Depende de S1.

## S9 — Packs curados e licenciáveis ✅

"Pack v1", packs de reviewers, cada curva com licença explícita (`CC0`, `CC-BY`)
para remix legal. Resolve **de propósito** o problema de licença de curva — que é
o mesmo problema já tratado no [`README.md`](README.md#créditos).

## S10 — Antes/depois compartilhável ✅

Exportar o gráfico (curva sobre o alvo) como PNG/SVG. Barato, e é o que faz uma
ideia circular.

---

## Roteiro

| Ordem | O que | Depende de |
|---|---|---|
| 1 | **S1** (código compacto) + **S5** (envelope) | nada — puro design |
| 2 | **S10** + **S4** | S1 |
| 3 | **S3** (repo-como-banco + Pages) | S1, S5 |
| 4 | **S9** (licença por curva) | S3 |
| 5 | **S6** | X2 + cabo ❌ |
| 6 | S7 / S8 | backend / opcional |

**S1 + S5 são o alicerce.** Sem eles, nada mais escala; com eles, S3/S4/S9/S10
saem quase de graça e continuam 100% estáticos.
