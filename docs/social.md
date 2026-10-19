# Camada social: curvas como objetos compartilháveis

Ideias para transformar o preset de "configuração que mora num cabo" em
**conteúdo que circula**: código curto, proveniência, versionamento, curadoria.

Marca de confiança: ✅ confirmado/medido · 🟡 hipótese · ❌ precisa do cabo.

Contrato das rotas: [`api.md`](api.md). Esquema, regras de visibilidade e
semântica de exclusão: [`web/src/lib/server/social/README.md`](../web/src/lib/server/social/README.md).

## Antes: calibração de *prior art*

Isto **não** é território virgem. O `jeromeof/devicePEQ` já tem `sharePEQ/`,
`visualizePEQ/`, `subjectizePEQ/` e `treblizerPEQ/`: compartilhar e visualizar
preset é padrão naquele ecossistema (`0x4B`).

O que **é** novo aqui: fazer isso para `0xCB` **e** as camadas que eles não têm:
forma compacta canônica (S1), proveniência (S2), versionamento (S3), envelope com
receita (S5), agregação anônima (S6) e troca às cegas (S7).

## Estado das decisões

| ID | Ideia | Decisão |
|---|---|---|
| **S1** | Formato compacto canônico | ✅ **adotado**: S1 v1 (e v2 para bandas acima de 20 kHz), ver [`s1-format.md`](s1-format.md) |
| **S2** | Assinatura criptográfica | ❌ **descartada**: proveniência por link basta |
| **S3** | Curvas versionadas | ✅ **ativo**: linhagens com versões só por acréscimo, forks e lápide |
| **S4** | Distância entre curvas | ✅ **adotado**: barato, `magnitudeDb()` já existe |
| **S5** | Envelope: números **+** receita | ✅ **adotado**: os dois, não um ou outro |
| **S6** | Preferência crowdsourced | ✅ **ativo**: lote anônimo no Worker, com consentimento e recibo |
| **S7** | Troca às cegas | ✅ **ativo**: usuários verificados, pareamento assíncrono, 72 h |
| **S8** | Curva como identidade | 🟡 parcial: link `/c/<id>`, imagem OG e QR |
| **S9** | Packs curados e licenciáveis | ✅ **ativo**: packs com licença por item (CC0 ou CC-BY 4.0) |
| **S10** | Antes/depois compartilhável | ✅ **adotado**: barato, é o que faz circular |

---

## Identidade: login no lugar da identidade por dispositivo

O desenho inicial previa identidade por dispositivo (uma chave no navegador) e
nenhum servidor. Isso foi substituído por **conta opcional com e-mail e senha**:

- Sem conta, tudo o que é local continua: editor, presets, biblioteca no
  navegador, prévias, teste cego e gravação no cabo.
- Qualquer ação social exige conta com **e-mail verificado**: publicar,
  favoritar, registrar atividade, compartilhar, montar packs, denunciar e trocar
  (S7). Retirar uma publicação própria só exige estar logado.
- O único nome público é o **apelido** (`/u/<apelido>`): 3 a 24 caracteres
  (letras, dígitos, `.`, `_`, `-`), único depois de NFKC e do esqueleto de
  confundíveis (UTS #39), com lista de reservados. Troca a cada 30 dias; o antigo
  fica reservado por 90 dias e redireciona.
- Ao entrar, a biblioteca local anônima pode ser mesclada na conta sem duplicar.
- Turnstile protege cadastro, entrada, recuperação, troca de e-mail, denúncia e
  envio S6. Administradores usam segundo fator.
- Encerrar a conta oferece dois modos para o conteúdo público CC: **anonimizar**
  (curvas e packs públicos e ativos ficam como "autor removido"; o apelido fica
  reservado por 90 dias sem dono) ou **apagar tudo** (o apelido fica livre na
  hora). Conteúdo privado, não listado ou retirado é sempre apagado. Forks de
  outras pessoas continuam.

## Regras de privacidade

- **Visibilidade de uma linhagem:** privada (só o dono), não listada (abre por
  id, nunca listada) ou pública. Só aparece em feed, rankings, perfis, packs de
  outras pessoas e buscas a linhagem pública, ativa, sem ocultação de moderação,
  com a curva do head aprovada no gate atual e dono não banido.
- **Rastreio:** "experimentou" = prévia audível de pelo menos 10 s; "instalou" =
  gravação real bem-sucedida no cabo (nunca simulada); "favoritou". Os eventos
  saem do navegador por uma fila offline e são aceitos até 7 dias depois.
- **Contagens públicas** contam usuários distintos, com e-mail verificado, não
  banidos, e nunca o dono. Repetir um evento só aumenta um contador privado.
- **Perfil:** `activity_visibility` e `library_visibility` são privadas por
  padrão. Com atividade privada, a pessoa entra no público de uma curva só como
  "N pessoas com perfil privado". Com biblioteca privada, o perfil mostra só o
  apelido e contagens agregadas; as curvas públicas continuam abrindo por link,
  creditadas ao apelido.
- **Histórico:** o usuário vê e apaga a própria atividade (tudo ou por curva e
  tipo); as contagens públicas caem na hora e os rankings no próximo recálculo.
- **Compartilhamentos:** aberturas anônimas viram só um contador por dia, sem
  identidade. Prévia, instalação e favorito só são atribuídos a atores com
  atividade pública, uma vez por usuário e tipo; atividade privada nunca entra
  no funil. Só quem criou o compartilhamento **e** é dono da linhagem vê os
  números. Compartilhar a curva de outra pessoa não dá acesso nem às aberturas.
  As contagens atribuídas só incluem usuários que continuam elegíveis, com
  atividade pública, e-mail verificado e não banidos. Tornar a atividade privada
  ou ser banido retira o usuário desses números, inclusive nos eventos antigos.
- **Decisão aceita (plano §3.7):** o `privateCount` no público do autor permanece
  exato ("N pessoas com perfil privado"). O limite de 50 nomes públicos não
  aumenta esse contador. Essa visão do autor é separada do funil de compartilhamento.
- **IP:** o rate limit usa HMAC do IP com sal diário, descartado em até 48 h.
  Nenhuma tabela social guarda IP.

## Modelo de dados (resumo)

Tabelas D1 das migrações 0004 a 0006; o mapa completo, os gatilhos e os
predicados de visibilidade estão em
[`web/src/lib/server/social/README.md`](../web/src/lib/server/social/README.md).

| Tabela | Papel |
|---|---|
| `curves` | Curva endereçada pelo conteúdo (`id` = `curveId(s1)`), cache do gate por versão do gate. Sem autor. |
| `lineages` | Dono, visibilidade, estado (ativa ou retirada), moderação, curadoria, head e origem do fork. |
| `versions` | Só acréscimo; nome, descrição, licença, receita S5, idioma. Gatilho recusa curva reprovada no gate. |
| `favorites`, `activity` | Uma linha por usuário e linhagem (e tipo, na atividade), com primeira e última vez. |
| `shares`, `share_events`, `share_event_users` | Compartilhamento, contador anônimo diário e eventos atribuídos. |
| `packs`, `pack_items` | Packs com licença copiada da versão head. |
| `reports` | Denúncias, uma por alvo e denunciante. |
| `rankings`, `ranking_state` | Rankings materializados por métrica e janela. |
| `s6_batches`, `s6_pairs` | Lotes anônimos S6: hash do recibo, versão do consentimento, dia. |
| `trades` | Trocas S7; no máximo uma `waiting` ou `matched` por usuário. |

O perfil fica em colunas de `"user"` (`bio`, `activity_visibility`,
`library_visibility`, `username_changed_at`) e o histórico de apelidos em
`username_holds`.

---

## S1: o formato compacto ✅

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
`f` inédito precisaria de escape, então não é alcançável; é estimativa otimista.

### O ponto conceitual

**"Lossless" não é propriedade dos bytes; é propriedade do domínio canônico
escolhido.** Cortar os valores impossíveis **é** a compressão: 220 → 46 B sem
algoritmo nenhum (4,8×). Comprimir algoritmicamente por cima rende no máximo
~1,5×, ao custo de um codec, de fragilidade e de perder a depurabilidade. Aos
46 bytes, os 33% de overhead do base64 já dominam.

### Domínio canônico: S1 v1

O desenho inicial (48 B, 64 caracteres, CRC-8) foi substituído. O formato
congelado é o **S1 v1**, definido em [`s1-format.md`](s1-format.md): 51 B
(68 caracteres base64url), grade da UI sem perda (ganho de −25,6 a +12,7 dB, Q
até 20,47) e CRC-16/CCITT-FALSE.

A **S1 v2** ([`s1-format.md`](s1-format.md#s1-v2)) tem o mesmo layout e o mesmo
tamanho, com a frequência indo até 32 000 Hz. Os escritores só a emitem quando
alguma banda passa de 20 000 Hz; toda curva que cabe na v1 mantém o código, o
`curveId` e o `canonKey` v1.

O range observado é **estreito**: é aí que está o ganho, não em algoritmo.

**"Lossless" dentro do domínio.** Hz inteiro, 0,1 dB e Q com 2 casas cobrem todos
os presets de referência e a saída do AutoEQ do hangout.audio (que arredonda
para esses passos). **Não** cobrem tudo: o `eqloader` arredonda `f` a 0,1 Hz e o
ganho a 0,01 dB. Uma curva fora do domínio vai para o sabor `raw` e nunca é
arredondada em silêncio.

**Variante de 39 B rejeitada:** `f` numa grade de 1/96 oitava (925 passos) tem erro
máximo de **0,36%** em `f`. Economiza 7 bytes = 12 caracteres, e cobra o adjetivo
"lossless". Não vale.

### Dois sabores + discriminador ✅

| Sabor | Conteúdo | Tamanho | Quando |
|---|---|---|---|
| `parametric` | 10 × `(type, f, g, q)` + preamp | 51 B | curvas RBJ dentro do domínio, praticamente tudo |
| `raw` | 10 × 5 coeficientes int32 + preamp | ~203 B | biquad que não é expressável como RBJ, ou parâmetros fora do domínio |

O cabeçalho de 4 bits (2 de versão + 2 de variante) resolve. Na v1, só a variante
paramétrica está definida; `raw` fica reservado. Sem esse discriminador, o
formato compacto mentiria sobre curvas desenhadas direto em coeficientes.

### Forma canônica para compartilhar ≠ ordem de envio ⚠️

Bandas em série **comutam** na resposta ideal. Então qualquer preset pode ser
**ordenado** para virar forma canônica (por `f`, desempatando por tipo, Q e
ganho), o que torna diff, hash e comparação determinísticos de graça.

**Mas essa ordem nunca vai para o cabo.** O **pico interno** da cadeia depende da
ordem, e a referência ordena **cortes antes dos reforços** de propósito. Medido
nos 11 presets ([`protocol-0xcb.md`](protocol-0xcb.md#ordenação-das-bandas-cortes-antes-dos-reforços)):

| Ordem | Pior pico interno | Presets acima de 0 dBFS |
|---|---|---|
| da referência (cortes primeiro) | −0,20 dB | 0 |
| ordenada por `f` (canônica) | **+4,79 dB** | 7 |

Logo: a forma canônica é para **guardar e comparar**; ao gravar, a ferramenta
reconstrói a ordem de envio (cortes primeiro).

---

## S2: proveniência, não assinatura ❌ descartada

Assinatura criptográfica foi **descartada**, e o argumento é bom: o pior caso de
uma curva adulterada é um EQ diferente, sem dano (e o codec recusa curvas que
gravariam silêncio ou instabilidade). E, sem leitura conhecida, não há como
verificar o que está no cabo de qualquer forma.

Substituto: campo **`source`** apontando para a origem canônica (commit, PR,
gist), e a linhagem publicada com o apelido do autor. É verificável de graça e é
a identidade real.

Assinatura só voltaria em um cenário: **S9 virar comercial** (packs vendidos). Aí
o correto é assinar **a receita** (medição + alvo + versão do solver), não o blob.

---

## S3: versionamento e hospedagem ✅

O plano começou 100% estático (fragmento de URL, repositório como banco, busca
no cliente). Isso continua valendo para o que é local: o link `#p=<código>` (68
caracteres) não precisa de servidor, e editor, presets e teste cego funcionam
offline.

A camada social, porém, tem backend próprio (Worker + D1 + R2), porque escrita
por usuário não técnico, conta, S6 anônimo, S7, rankings e antiabuso exigem
estado no servidor:

- **Linhagem:** cada publicação cria uma linhagem; novas versões só se
  acrescentam e precisam partir do head atual (`HEAD_MOVED` se outra versão
  entrou antes). Nada é reescrito.
- **Fork:** qualquer usuário verificado copia uma versão legível para uma
  linhagem nova, privada por padrão. Fonte CC-BY 4.0 devolve a atribuição que o
  fork precisa manter.
- **Lápide:** o dono retira a linhagem (some das listas, responde 410 a outras
  pessoas) e pode restaurá-la; a moderação não muda com isso.
- **Gate:** toda publicação, versão e fork passa pelo gate v2 no servidor, com os
  mesmos códigos de motivo do navegador; um gatilho no banco recusa versão sobre
  curva reprovada, e linhagem cujo head reprova some de toda lista. As três ações
  compartilham cotas de 30 publicações bem-sucedidas por dia UTC e 60 tentativas
  na etapa de gate por usuário em janela móvel de 24 h, incluindo recusas e
  pareceres em cache (429 `QUOTA_EXCEEDED`). Leituras por id de curvas, `/c`, OG
  e S7 reavaliam pareceres desatualizados antes de servir; não basta haver um
  parecer antigo aprovado ou um PNG no R2.
- **Mescla local:** até 100 itens por lote; no máximo 20 execuções de gate sem
  cache por requisição e contador separado de 500 itens na etapa de gate por
  usuário em 24 h, incluindo recusas e acertos de cache. Os itens excedentes
  recebem `QUOTA_EXCEEDED` no relatório e ficam locais para nova tentativa.

---

## S4: distância entre curvas ✅

Comparação exata: amostrar as duas respostas numa grade log e reportar delta RMS,
delta máximo e **onde** divergem ("+2,3 dB a 150 Hz; acima de 4 kHz idênticas").

Usos: escolher entre 3 curvas compartilhadas, saber se vale baixar, e "esta é a
minha com mais grave". A `magnitudeDb()` do codec já faz o trabalho pesado.

---

## S5: envelope com números **e** receita ✅

O envelope carrega **as duas coisas**, e cada uma resolve um problema distinto:

| Parte | O que garante |
|---|---|
| os **10 números** | autossuficiência: aplica offline, sem base, sem rede |
| a **receita** (medição + alvo + versão do solver) | auditabilidade e re-derivação |

Só receita deixa o app refém da base de dados; só números, ninguém audita.

O validador de publicação normaliza texto com NFKC, remove caracteres das
classes Unicode `Default_Ignorable_Code_Point` e `Cf`, incluindo controles bidi,
e recusa URLs em todo texto livre. Só a descrição preserva LF (até cinco linhas).
Na detecção de URLs, `。`, `．`, `｡`, `․` e `﹒` equivalem a ponto; isso não altera a
pontuação publicada além da própria NFKC. São recusados esquemas com `://`,
`hxxp`/`hxxps`, `www.` e domínios com um rótulo de 1 a 63 letras, números ou
hífens seguido de ponto e de 2 a 24 letras Unicode. Não há lista fixa de TLDs.
Assim, `x.co` é recusado, mas `1.5 dB`, `v2.0`, `Sr.` e `e.g. graves` são aceitos:
um sufixo de uma só letra não basta, e não há junção através de espaços.

O limite do envelope normalizado continua em **8 KiB de JSON UTF-8**.
`parseEnvelope` também recusa texto bruto acima de **65536 unidades UTF-16** com
`env:size`, antes de chamar `JSON.parse`, incluindo espaços e escapes nesse teto.
Bandas `LP`/`HP` do envelope têm `kind`, `freqHz` e `qFactor`, sem `gainDb`;
até `gainDb: 0` é recusado como `env:extra`.

### Rótulos de filtro (`open-auri/preset@2`)

O formato `open-auri/preset@2` é o `@1` com um campo opcional a mais,
`labels: (string | null)[]`, e com bandas até 32 000 Hz em S1 v2 (ver
[abaixo](#bandas-acima-de-20-khz-s1-v2-em-open-auripreset2)). Ele só é emitido
quando a curva tem ao menos um rótulo ou uma banda acima de 20 000 Hz; senão,
todo escritor continua emitindo `@1`, byte a byte igual ao de antes. Em `@1`,
`labels` segue recusado como `env:extra`. O esquema normativo é
[`preset-envelope-2.schema.json`](../schemas/preset-envelope-2.schema.json).

- **Por índice de fio:** exatamente 10 entradas; `labels[i]` nomeia `bands[i]`.
  Contagem diferente dá `env:labels`.
- **Mesmo pipeline do nome:** cada rótulo passa por NFKC, remoção de invisíveis,
  colapso de espaços, recusa de controles (`env:pattern`) e de URL, domínio ou IP
  (`env:url`, `env:url-like`). De 1 a 24 pontos de código depois de normalizar;
  acima disso, `env:length`. Texto que normaliza para vazio vira `null`; uma
  lista toda `null` some do envelope.
- **Conta no teto de 8 KiB** do envelope serializado. Na ordem determinística,
  `labels` vem logo depois de `bands`.
- **Nunca é identidade:** rótulos ficam fora do S1, do `curveId`, do `canonKey`,
  do gate e da linha `curves`; a deduplicação os ignora. Também ficam fora do
  link `#p=`, da imagem OG, dos cartões de lista e feed e do payload da troca às
  cegas antes da revelação.
- `normalizeLabels` (exportado por `open-auri/share` com `LABEL_COUNT = 10` e
  `LABEL_MAX = 24`) aplica as mesmas regras fora do envelope; no modo `lenient`,
  usado pelo estado local, uma entrada recusada vira `null` em vez de erro.

Na nuvem, cada versão guarda os rótulos em `versions.labels` (JSON, migração
`0012_version_labels.sql`). Uma mudança só de rótulos acrescenta uma versão
nova (conta na cota) e reaproveita o gate da curva, que não muda.

### Bandas acima de 20 kHz (S1 v2 em `open-auri/preset@2`)

O `@2` também carrega as curvas [S1 v2](s1-format.md#s1-v2): não existe `@3`.

| Formato | `freqHz` das bandas | Código `code` | `labels` |
|---|---|---|---|
| `open-auri/preset@1` | 1 a **20 000** | só S1 v1 | recusado (`env:extra`) |
| `open-auri/preset@2` | 1 a **32 000** | S1 v1 ou v2 | opcional |

- **Coerência com o S1:** o `code` é v2 se e somente se alguma banda que não é
  `OFF` passa de 20 000 Hz, e v1 senão; um `code` que não descreve exatamente as
  bandas e o pré-amp dá `env:code-mismatch`, e um v2 sem banda acima de 20 kHz
  dá `env:s1` (`s1:noncanonical`).
- **`@1` continua igual:** banda acima de 20 000 Hz dá `env:range`, e um código
  v2 dá `env:s1` ("S1 v2 requires open-auri/preset@2"). O esquema
  [`preset-envelope-1.schema.json`](../schemas/preset-envelope-1.schema.json) não
  muda.
- **O menor formato que cabe:** os escritores emitem `@1` quando não há rótulo
  nem banda acima de 20 kHz, e `@2` nos outros casos. `envelopeFormat({ bands,
  labels })`, exportado por `open-auri/share`, faz essa escolha.

Esboço conceitual da receita (o esquema normativo é
[`preset-envelope-1.schema.json`](../schemas/preset-envelope-1.schema.json)):

```json
{
  "format": "open-auri/preset@1",
  "kind": "parametric",
  "name": "Exemplo",
  "author": "…",
  "source": "https://github.com/<org>/<repo>/commit/<sha>",
  "license": "CC0-1.0",
  "code": "<S1 v1, 51 B, 68 caracteres>",
  "preamp": -3.4,
  "bands": [{ "type": "PK", "f": 150, "g": -3.0, "q": 0.69 }],
  "recipe": {
    "measurement": "AutoEq:oratory1990/<modelo>",
    "target": "JM-1",
    "solver": { "name": "autoeq", "version": "1", "params": {} }
  }
}
```

### Classes de curva e publicação YOLO (migração 0013)

O servidor classifica cada curva publicada, versionada, bifurcada ou mesclada (`classifyCurve` do
núcleo, em `web/src/lib/server/social/gate.ts`); a classe nunca vem do cliente:

- **padrão**: o gate padrão aceita. `experimental` é derivado da própria curva (tem HS, LP ou HP),
  como no editor, então HS/LP/HP dentro dos limites são curvas padrão também no servidor;
- **YOLO**: o gate padrão recusa só por motivos dispensáveis e o perfil YOLO aceita; o cache guarda
  os códigos dispensados (`waived`);
- **reprovada**: nem um nem outro; nada é gravado (422 `GATE_REJECTED` com `details.hard`).

Uma curva YOLO sempre pode ser salva como **privada**. Para mostrá-la a terceiros (não listada ou
pública), a escrita precisa do interruptor `YOLO_PUBLICATION` = `on` (variável do Worker em
`web/wrangler.template.jsonc`, **padrão `off`**: 403 `YOLO_PUBLICATION_OFF`), de uma conta com 72 h
ou mais e do reconhecimento explícito `acknowledge: "yolo"` (409 `YOLO_ACK_REQUIRED` com os códigos
dispensados), no máximo 5 por 24 h. A vaga é reservada de forma atômica antes da escrita (pedidos
simultâneos nunca passam de 5) e devolvida se a escrita falha, então só reconhecimentos gravados
contam. O reconhecimento fica em `lineage_yolo_acks` (linhagem, curva): sem ele, um head YOLO não
abre nem por link.

As regras dependem da classe do head e da visibilidade, que podem mudar entre a leitura e a escrita
(uma versão YOLO nova e uma troca de visibilidade ao mesmo tempo). Cada escrita só vale no estado
que a decisão leu: uma versão YOLO só entra se a visibilidade não mudou, e abrir a linhagem
(visibilidade, restauração) só vale se o head classificado ainda é o head. Se o estado mudou, nada
é gravado e o servidor reaplica as regras ao estado novo (até 3 vezes, depois 409 `HEAD_MOVED`):
uma linhagem nunca fica visível a terceiros com um head YOLO que o dono não reconheceu.

O interruptor vale também para as **leituras**: com `YOLO_PUBLICATION` desligado, nenhum head YOLO
é servido a quem não é o dono, reconhecido ou não. Ele não abre por link (API, `/c/:id`), não vira
imagem OG, não aparece em `feed?yolo=only` (página vazia), não serve de origem de fork e não pode
ser favoritado, compartilhado ou denunciado por terceiros. O dono continua vendo a própria linhagem.
Religado, os heads reconhecidos voltam a abrir. Restaurar uma linhagem YOLO não privada com o
interruptor desligado a deixa **privada**. Packs nunca mostram linhagens YOLO de terceiros, com o
interruptor ligado ou não.

Separação: feed, rankings, perfis, packs de terceiros, S6, S7 e o dump público só mostram heads
**padrão**. Curvas YOLO públicas só aparecem em `GET /api/v1/feed?yolo=only` (ordem `new`). O dump
público semanal deixa YOLO de fora por enquanto (head e versões precisam de `gate_ok = 1`). O dump
tem `formatVersion` **2**: desde o GATE_IMPL 2 uma curva **padrão** pode ser S1 v2 (corte que não
amplifica acima de 20 kHz, bandas até 32 kHz), então cada `curve.s1` pode ser S1 v1 ou S1 v2. O
código S1 diz a própria versão ([`s1-format.md`](s1-format.md)); o resto do formato não mudou. A
imagem OG de uma curva YOLO leva o selo "YOLO" (layout de cartão `3`), a URL da imagem leva `?y=1`
e a página `/c/:id` sai com `noindex`. Uma URL de imagem cujo `?y=` não corresponde à classe atual
da versão recebe 302 para a URL certa (`no-store`; só `y` muda, os outros parâmetros ficam), para
que nenhum cache guarde o cartão da outra classe. O job `og-sweep` lê o mesmo interruptor (variável
`YOLO_PUBLICATION` também em `workers/jobs/wrangler.template.jsonc`, com o mesmo valor do Worker
web): ligado, mantém as imagens das versões YOLO reconhecidas; desligado, as apaga. Moderação: uma
linhagem com head YOLO é ocultada automaticamente com 2 denunciantes elegíveis (3 nas demais),
contando o head que ela tem no momento da ocultação (a condição está na própria escrita, e a
auditoria registra o limite aplicado); a fila do admin mostra o selo e os códigos dispensados; e a
curadoria recusa heads YOLO, conferidos de novo na escrita (recusada, nada é gravado nem auditado).

---

## S6: preferência crowdsourced ✅ ativo

O teste cego no navegador gera pares A/B **localmente**. Com consentimento, sobe
só o resultado dos pares, e a comunidade constrói uma preferência derivada de
dados reais, continuamente.

Preferência auditiva pode revelar perda de audição. Pela LGPD (art. 11), isso
pede **consentimento explícito** e dados minimizados. Como funciona:

- **Anônimo, sem conta:** a sessão, se houver, é ignorada. O lote guarda só um id
  aleatório, o SHA-256 do recibo, a versão do consentimento (`s6-consent-v1`) e o
  dia UTC; os pares (curva A, curva B, escolha, nível igualado) entram em ordem
  embaralhada. Nada de usuário, IP, hash de IP, navegador ou hora.
- **Antiabuso sem rastro:** Turnstile e contador de rajada pelo hash do IP com sal
  diário, sem cota gravada em banco.
- **Retirada:** o navegador gera um recibo de 32 bytes aleatórios e o guarda só
  localmente. Com ele, o lote e seus pares são apagados; a resposta é a mesma
  existindo ou não. Sem o recibo, não há como achar o lote.
- **Itens elegíveis:** só `curveId` de preset oficial ou curva HEAD de uma
  linhagem pública e listável. Um item inelegível recusa o lote inteiro com
  400 `INVALID_BODY` e issue `s6_unknown_item`; curvas apenas locais ou históricas
  não bastam. A agregação confere a elegibilidade novamente.
- **"Comunidade prefere":** um job diário roda Bradley–Terry (iteração MM de
  Zermelo, empate = meia vitória, normalização pela média geométrica, parada em
  1e-9 ou 10 000 iterações) e publica só pontuação e número de comparações por
  curva. Só a maior componente fortemente conexa do grafo de comparações recebe
  pontuação (Ford 1957); curvas fora dela ficam sem número publicado. Lê uma
  janela de 90 dias, até 200 000 pares, e limita trabalho e tempo do estimador.
  O JSON inclui `converged`; `false` indica uma estimativa interrompida por um
  limite, não convergência confirmada.

O caminho pseudônimo por PR ou issue no GitHub, previsto no desenho inicial, não
é usado: ele expõe o usuário do GitHub junto com os dados.

---

## S7: troca às cegas ✅ ativo

Dois usuários trocam curvas **sem saber de quem são** e dão nota. O autor recebe
retorno sem viés de nome.

- Um usuário verificado entra na fila com uma curva aprovada no gate: uma
  linhagem própria, ativa e sem ocultação de moderação, ou uma pública e
  listável. A versão precisa passar no gate; a listabilidade de linhagem alheia
  exige também o head aprovado. A própria pode ser privada ou não listada.
  No máximo uma troca ativa por vez.
- **Pareamento assíncrono:** na entrada, com a troca em espera mais antiga
  elegível; senão, um job de hora em hora tenta de novo. O pareamento é atômico:
  duas entradas simultâneas nunca pegam a mesma troca.
- **Às cegas:** cada lado recebe só a curva do parceiro (id e S1), o bastante
  para a prévia no navegador. Instalar passa pelo checklist e pelo gesto de
  sempre.
- **Nota de 1 a 5,** uma vez. A segunda nota do par revela as duas trocas no
  mesmo lote: apelido do parceiro (`nickname` de exibição e `username` canônico,
  se houver e não estiver banido), a linhagem quando ela abre por link e as duas
  notas. O id de usuário do parceiro nunca é exposto.
- **Revalidação:** toda leitura confere se o parceiro continua elegível e
  reavalia pareceres desatualizados do gate. Se deixar de qualificar, a curva
  não é servida e `partner` vem `null`; pares `matched` viram `cancelled`, mas
  trocas já `revealed` mantêm o estado. A leitura reavalia até 4 curvas; se ainda
  restar parecer desatualizado para o parceiro, ele fica `null` nessa leitura,
  sem cancelamento só por esse limite.
- **Expiração em 72 h** depois de entrar na fila ou do pareamento; dá para
  cancelar enquanto espera.

## S8: curva como identidade 🟡 parcial

Cada linhagem tem o link `/c/<id>` (com `?s=<shareId>` para o funil), imagem OG
gerada no servidor e QR. A imagem OG não contém autor ou apelido, só nome da
versão, licença, gráfico e marca do projeto. Usa `public, max-age=86400`, sem
`immutable`; a visibilidade e os pareceres do gate são conferidos antes de
servir, inclusive com imagem no R2 e na resposta 304. Cópias já guardadas por
navegadores ou CDNs podem durar até um dia após a mudança de visibilidade.
Assinatura sonora como avatar e cartões impressos continuam como ideia.

## S9: packs curados e licenciáveis ✅

Packs com licença explícita por item (`CC0-1.0` ou `CC-BY-4.0`, copiada da versão
head) para remix legal. Resolve **de propósito** o problema de licença de curva,
o mesmo tratado no [`README.md`](README.md#créditos). O pack de outra pessoa só
mostra linhagens públicas e listáveis.

## S10: antes/depois compartilhável ✅

Exportar o gráfico (curva sobre o alvo) como PNG/SVG. Barato, e é o que faz uma
ideia circular.

---

## Moderação e rankings (resumo)

- **Denúncias** de curva, pack ou perfil por usuários verificados, com Turnstile.
  Perfis são denunciados pelo apelido público, nunca pelo id interno da conta.
  Três contas distintas, verificadas, não banidas e com 3 dias ou mais ocultam
  automaticamente uma curva ou pack até a revisão. Administradores ocultam,
  restauram, removem, dispensam ou banem, sempre com registro de auditoria.
- **Rankings:** mais favoritadas e mais instaladas, em 7 dias, 30 dias e sempre;
  só curvas públicas, listáveis e aprovadas no gate; desempate por pontuação,
  atividade recente e id; recálculo a cada 15 minutos.

Detalhes e códigos de erro em [`api.md`](api.md).
