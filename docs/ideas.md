# Ideias — usos previstos, excêntricos e não previstos

Catálogo de possibilidades abertas pelo formato `0xCB`. Cada ideia é ancorada em
uma propriedade **do protocolo** — nada aqui é "seria legal se".

Marcas de confiança: ✅ confirmado · 🟡 hipótese · ❌ só com o cabo.

## As três liberdades que a página de referência não usa

| # | Liberdade | Consequência | Confiança |
|---|---|---|---|
| L1 | Aceita **biquad cru**, sem byte de tipo | Qualquer filtro estável cabe — não só PK/LS | ✅ (formato) / 🟡 (firmware) |
| L2 | Pré-amp é **Q23 contínuo** dentro do blob | Ganho de entrada praticamente contínuo, não passo de 1 dB | ✅ |
| L3 | Gravação é **barata e persistente** (~0,3 s, vai para a flash) | Dá para escrever muitas curvas em sequência; e o preset sobrevive a qualquer aparelho | ✅ |

Cálculo do ~0,3 s: 9 pacotes × 16 ms (144 ms) + 150 ms de settle + commit.

---

## A. Formas de **criar** curvas

| ID | Ideia | O que a habilita | Confiança |
|---|---|---|---|
| **C1** | **"Soe como X"** — escolher a medição do meu fone + o alvo desejado e resolver as 10 bandas | L1 + motor AutoEQ já existente | ✅ |
| **C2** | **Desenhar a curva final, não as bandas** — o usuário desenha a resposta desejada e o solver inverte | o chip só recebe o resultado; parametrizar é problema do host | ✅ |
| **C3** | **Editar por delta** — carregar duas curvas e usar a diferença como novo preset | idem | ✅ |
| **C4** | **Importar tuning existente** — `.txt` do EqualizerAPO / AutoEq / Wavelet / Poweramp | L1 + formato `.txt` interoperável | ✅ |
| **C5** | **Curvas de loudness (ISO 226)** — presets para escuta em volume baixo | normalização ISO 226 já implementada no motor de referência | ✅ (motor) / 🟡 (posição do volume no chip) |
| **C6** | **Filtros que a página não expressa**: HPF sub-sônico, notch de ressonância, shelf de 1ª ordem, 4ª ordem empilhada | L1 | ✅ (formato) / 🟡 (firmware) |
| **C7** | **Curva que mostra o que o chip *realmente* faz** — simular o arredondamento Q27 e exibir a resposta pós-quantização | sabemos a escala exata | ✅ |
| **C8** | **Garantia "o que você vê é o que é gravado"** | a página de referência **falha** nisso: desenha a curva de `show` (quando existe) mas grava `bands`, e os dois divergem no preset `pref6` | ✅ (defeito observado) |

### C6 em detalhe — os filtros que faltam

| Filtro | Para que serve | Seções |
|---|---|---|
| **HPF sub-sônico** (~20–25 Hz) | protege o driver abaixo da afinação — evita excursão desnecessária | 1 |
| **Notch** estreito | domar ressonância de 5–8 kHz em IEM híbrido | 1 |
| **Shelf de 1ª ordem** (`b2 = a2 = 0`) | correção mais suave, menos "degrau" | 1 |
| **4ª ordem** (2 seções) | sub-sônico ou corte mais íngreme onde precisa | 2 |

Nenhuma ferramenta `0xCB` consegue expressar nada disso hoje.

---

## B. Usos excêntricos e não previstos

### X1 — O blob é um formato de preset portátil

220 bytes autossuficientes ⇒ **permalink** (`…/#<base64>`), QR code, ou arquivo.
A curva deixa de ser configuração e passa a ser **objeto compartilhável**.
Hoje a página só grava; não exporta nada.

⚠️ O blob **não tem metadados** (nem nome, nem autor, nem alvo) — é anônimo.
Por isso ele precisa de um *wrapper* para circular com contexto.

Confiança: ✅ · Esforço: baixo

### X2 — Teste cego automatizado de preferência ⭐

A ideia mais original, e ela nasce **da limitação**: não dá para ler, mas dá para
**escrever rápido e persistir** (L3).

1. a ferramenta gera candidatos ao redor de um alvo (C1/C2);
2. escreve A, escreve B, **embaralha**, o usuário responde só "prefiro 1 ou 2";
3. um torneio converge para a **curva pessoal** dele.

Resultado: um "Harman pessoal", medido no próprio ouvido. O protocolo é
write-only; nós transformamos isso em **método**.

Confiança: ✅ (viabilidade) / ❌ (precisa do cabo) · Esforço: alto

### X3 — Pré-escuta bit-exata offline

Como conhecemos os coeficientes exatos (mesmo `FS`, mesma escala Q27), dá para
**renderizar um trecho de música com exatamente o filtro que será gravado** e
entregar um WAV.

É o mais perto de "ouvir antes de gravar" que existe **sem o cabo** — e o único
preview fiel, já que o preview no navegador não passa pelo chip.

Confiança: ✅ · Esforço: médio

### X4 — Botão de resgate (requisito, não enfeite)

Sem leitura, um estado ruim é **irreversível**. Um "neutro garantido"
(10 bandas identidade + pré-amp 0, bytes conhecidos-bons) é a única saída.
Deve ser o primeiro botão da UI.

Confiança: ✅ · Esforço: baixo

### X5 — Gerenciador de headroom

Com o pré-amp contínuo (L2), expor os dois modos que ninguém expõe:

| Modo | Fórmula | Para quê |
|---|---|---|
| **Igualar volume** | o que a página faz manualmente por preset | comparar presets sem viés de volume |
| **Máximo sem clipping** | `pre = −max(curva somada)` | usar todo o headroom disponível |

Há um trade-off real entre os dois, e ele é **tomada de decisão do usuário**.

Confiança: ✅ · Esforço: baixo

### X6 — Espacializador por comb filter (experimental)

10 notches na série harmônica ≈ um filtro comb — a única coisa remotamente
"espacial" que um banco de filtros lineares permite.

**Honesto:** colore o som e **não é** um espacializador de verdade. Experimento,
não feature.

Confiança: 🟡 (o formato permite; a utilidade é duvidosa) · Esforço: baixo

### X7 — Autoteste do cabo

Escrever curvas de teste e inferir o que o firmware aceita. Fecha as incógnitas
do [`open-questions.md`](open-questions.md) — inclusive **confirmar o `FS = 96 kHz`**,
que é a suposição mais frágil de todas (errar o FS desloca toda a resposta acima
de ~10 kHz).

Confiança: ❌ (precisa do cabo) · Esforço: médio

### X8 — Curadoria distribuída ("curvas assinadas")

Com X1, um revisor/artista publica a curva dele como um link. O cabo vira o
**meio** de distribuição de assinaturas sonoras. É produto/rede, não técnica.

Confiança: ✅ · Esforço: baixo (dado X1)

### X9 — Lote multi-dispositivo

Aplicar a mesma curva em vários cabos (linha de produção, loja, review).
L3 + um mesmo driver HID.

Confiança: ✅ · Esforço: baixo

---

## C. Limites duros (para não virar fantasia)

| Limite | Detalhe | Confiança |
|---|---|---|
| **Só filtros lineares e invariantes no tempo** | Nada de compressor, exciter, harmônicos, reverb, bass virtual. Não há como gerar frequência que não entrou. | ✅ |
| **Uma curva só, sem L/R independente** | O blob tem 10 bandas e **nenhuma dimensão de canal** ⇒ crossfeed, mono-bass e balanço de canais são impossíveis. | ✅ |
| **Estático** | Não muda com volume nem com conteúdo. | ✅ |
| **Sem leitura** | Sem undo/verify automáticos; toda a segurança é do host. | ✅ |
| **Escrita é bloco inteiro** | Não existe "atualizar uma banda"; cada gravação reescreve as 10. | ✅ |
| **Sem modo só-RAM conhecido** | A única sequência conhecida grava na flash. | 🟡 |

Tudo assumindo o formato reconstruído — o autoteste (X7) pode derrubar alguma.

---

## D. Ordem por ROI

| Ordem | O que | Por quê |
|---|---|---|
| 1 | **X4 + validação + journal** | confiança antes de features — é o que a ausência de leitura exige |
| 2 | **C4 + C1** | valor percebido imediato, motor já pronto |
| 3 | **C6** | a curva que a página não sabe fazer |
| 4 | **X1 + X8** | barato, e cria rede: o preset vira conteúdo |
| 5 | **X3 + X2** | diferenciais grandes, mais esforço |

## Pendências que bloqueiam o resto

Duas incógnitas derrubam várias ideias se derem errado:

1. **O firmware aceita biquads fora de RBJ?** (L1) ⇒ C6, C7, X6
2. **O `FS` é mesmo 96 kHz?** ⇒ C7, X3, e a precisão de tudo acima de ~10 kHz
