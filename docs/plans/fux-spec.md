# FUX · Polimento de UI/UX: auditoria e especificação

- **Status:** proposta do architect, 2026-10-17 (sessão de auditoria, papel só de leitura; gravado pelo orquestrador). Executa: orquestrador, via model-router.
- **Fase:** FUX (entre FX-UX e QG rodada 2), registrada no progresso (Decisões, 2026-10-17) e na issue #34.
- **Fontes:** plano §0.12, §3.3, §3.4, §3.5, §3.6 e §3.9; `docs/plans/f2-delegate-brief.md`; mocks `design/mocks/v2/*.html` e capturas `design/mocks/v2/_qa/*.png`; snapshots `web/tests/e2e/visual.spec.ts-snapshots/*.png`; build em `web/.svelte-kit/output/**`; log `_qa/deploy-production.txt`.
- **Lacunas conhecidas desta versão** (fecham no FUX.0, FUX.1 e FUX.2):
  - a comparação lado a lado de Biblioteca, Comparar e Soe como X e de todas as capturas mobile ficou só como lista do que verificar (§1.2 a §1.4);
  - alguns tamanhos de chunk são estimados por subtração (marcados como tal na §5.2); o FUX.2 mede por chunk;
  - os contrastes sobre painéis de hardware usam cores estimadas das capturas; o teste de contraste do FUX.1 confere com os valores reais dos mocks;
  - a Curva foi corrigida depois desta auditoria (FX-UX, commit `9eb5259`: caixa segura, linha de limite, mensagens por banda, VU, botões do mock). A §1.1 descreve o estado anterior; o FUX.P10 parte do estado novo.

## 0. Princípios, restrições e evidência

**0.1 Norte.** Um instrumento de estúdio que explica a si mesmo. Em conflito, nesta ordem:
1. Segurança e verdade dos dados antes da beleza.
2. Clareza para leigo antes da densidade para especialista; a densidade fica atrás de divulgação progressiva.
3. O drama nasce de material, luz e estado real, nunca de animação que finja medir.

**0.2 Restrições inegociáveis.**
- **Plano §0.12 inteiro:** medidores só com dado real (0.12.7); nenhum byte ao cabo sem gate, checklist e gesto (0.12.1, 0.12.2); HS, LP e HP só na Engenharia (0.12.5); nenhum controle inexistente no protocolo (0.12.6).
- **Texto (§3.4, §3.5):** pt-BR sem travessão, com sinal de menos "−" e vírgula decimal; sem "Honest note:" e sem "Just X. Just Y."; marcas proibidas como branding; homenageados só em texto; textos fixos literais (Aviso, EM BREVE, Confirmação experimental, Aviso de flash, Aviso de loudness, ressalva do gate §3.3).
- **Pedidos do operador de 2026-10-17 que entram na FUX:** tirar códigos do plano dos títulos visíveis (ex.: "S6 · Preferência", "S7 · Troca às cegas"); menu suspenso ao clicar no nome do usuário; lista de bloqueio de apelidos (ver handover, seção 0000).
- **Desempenho (§3.9):** LCP < 2,5 s em 4G simulado e JS inicial < 250 kB gzip por rota. A FUX adota metas mais duras (§5.7).

**0.3 Evidência.**
- Retângulos **magenta** nas capturas atuais são máscaras do Playwright (medidores, canvas, dados variáveis), não defeitos.
- **Rotas sem baseline visual:** `/entrar`, `/criar-conta`, `/verificar-email`, `/esqueci-senha`, `/redefinir-senha`, `/conta/**`, `/u/[apelido]`, `/c/[id]`, `/privacidade`, `/termos`. Nunca passaram por QA visual.

---

## 1. Diagnóstico por página

### 1.0 Achados transversais

| ID | Achado | Evidência |
|---|---|---|
| T1 | Botão "♪ Áudio" fora do sistema da barra: no mock tem borda como Neutro e Padrão Auri; hoje é texto sem borda e maior que os vizinhos. | mocks `teste-cego.png`, `cabo.png`, `curva-ajustar.png`; atuais `curva-`, `teste-cego-`, `comunidade-desktop-default-*`; `web/src/lib/components/audio/AudioLoader.svelte` |
| T2 | Plural errado na barra: "1 alterações não gravadas" (mock: "1 alteração não gravada"). | `teste-cego-desktop-default-*`, `cabo-desktop-default-*` |
| T3 | O "?" de ajuda flutuante cobre conteúdo à direita no desktop (Curva, Teste cego, Total Recall, rack do Cabo). Nos mocks a ajuda fica no cabeçalho da página. | `web/src/routes/+layout.svelte:258-260`, `:315-320` |
| T4 | Botões de ação em mono e peso alto; `fonts.css` só tem JetBrains Mono 400 e 500, então é negrito sintetizado. | `curva-desktop-default-*`; `web/src/lib/styles/fonts.css:44-65` |
| T5 | Escala tipográfica pequena e sem papéis (corpo 14, UI 13, rótulo 11); cada página improvisa; no Teste cego o rótulo "Rodadas" é maior que o valor. | `web/src/lib/styles/tokens.css:54-58` |
| T6 | Borda de controles (`--rule` 12%) dá ~1,3:1 sobre `--ink`, abaixo de 3:1 (WCAG 1.4.11) quando é o único limite do controle. | `tokens.css:15` |
| T7 | `--muted` #8f8a80 passa sobre `--ink` (5,6:1) e `--ink-2` (5,2:1), mas cai a ~4,1:1 sobre painéis de hardware (~#2b2a27). | §2.2 |
| T8 | Desabilitado só com `opacity: .45`, sem motivo (Desfazer, Refazer, Publicar curva, Ouvir A/B). | `web/src/lib/styles/base.css:52-56` |
| T9 | Painéis mortos para quem não tem conta: o aviso de login se repete 4 vezes e "Aperte SEL num canal…" 2. | `comunidade-desktop-default-*` |
| T10 | Turnstile monta antes do consentimento e já mostra erro. Import estático nas rotas Comunidade, Conta e Teste cego. | `web/.svelte-kit/output/client/.vite/manifest.json:329-349`, `:364-382`, `:551-572` |
| T11 | Fontes de época declaradas duas vezes: além de `fonts.css`, páginas importam CSS do Fontsource (latin-ext e vietnamese de Courier Prime, Barlow Condensed, Oswald, Special Elite, Permanent Marker, VT323; e `700.*.css`). | `manifest.json:232-363`, `:587-596`, `:757-766` |
| T12 | Vazios que não ensinam: diário vazio do Cabo é uma linha (mock: 3 caixas EXEMPLO); canais vazios da Comunidade são uma frase num bloco preto; Curva em Neutro sem pontos nem caixa segura. | mocks × capturas |
| T13 | Hierarquia achatada: Comunidade e Cabo empilham 8 a 10 painéis com o mesmo peso. | capturas |
| T14 | Movimento de estado perdido: seletor rotativo de camada, diagrama de estados do WebHID, carretéis e alavancas do checklist. | mocks × capturas |
| T15 | Códigos do plano visíveis em títulos (S1, S4, S5, S6, S7, S8, S9, S10). Pedido do operador: só nomes em linguagem natural. | `web/messages/*.json`, componentes |

### 1.1 Curva (Bob Moog) · estado antes do FX-UX

Evidência: `curva-desktop-default-*` × `curva-ajustar.png`, `curva-ouvir.png`, `curva-engenharia.png`, `curva-scope-detail.png`, `curva-inspection-detail.png`.
- Camada: mock usa knob rotativo de três posições com lâmpada; atual eram três caixas em mono negrito.
- Gráfico: mock ±15 dB, traço laranja com brilho, pontos 1 a 10, caixa segura, linha do pico de saída, referência Auri tracejada, moldura de osciloscópio com parafusos. (O FX-UX trouxe escala ±15, caixa segura, linha de limite e pontos; conferir o resto no FUX.P10.)
- Presets: mock usa cartões com mini curva e lâmpada; atual são botões de texto.
- Macros: mock tem knobs graduados de −6 a +6 com readout LCD.
- Rótulos de seção (PRESETS, AJUSTE FINO, OSCILOSCÓPIO, RESGATE) aparecem como cabeçalho seguido de vazio; no mock são gravações sob o conteúdo, com filete.
- Neutro e Padrão: no mock são chaves listradas com o CRC (0x4FFF, 0x1970); atual quadrados vermelhos.
- Abaixo do rack, "Sua curva, conectada" e "Importar e exportar" são cartões cinza fora do tema.

### 1.1b Curva · estado depois do FX-UX (captura de 2026-10-17)

Evidência: `web/test-results/.../curva-desktop-default-motion-actual.png` (build de `9eb5259`, camada Ouvir) × `curva-ajustar.png`. Unidade da Curva 335/335 e e2e `curva` verdes. O que o FX-UX resolveu: escala ±15, linha "pico de saída ≤ −0,47 dB", rótulo "perto do limite", readouts de saída, "Máximo sem clipping", envelope com lâmpada. O que falta para o FUX.P10:
- Camada: os três botões OUVIR/AJUSTAR/ENGENHARIA continuam caixas mono; o knob acima deles é decorativo e solto. Mock: knob único com rótulos ao redor e lâmpada na camada ativa.
- Layout do rack: o mock põe o osciloscópio em largura quase total, com presets em cartões (mini curva, lâmpada, nome em negrito) e ajuste fino (4 knobs graduados −6 a +6 com LCD e "n seções") **abaixo** do scope; o atual põe presets como botões de texto numa coluna à esquerda, com um vão vazio grande sob "CURVAS DE REFERÊNCIA" e o rótulo "PRESETS" boiando no meio da coluna.
- Rótulos de seção (PRESETS, AJUSTE FINO, OSCILOSCÓPIO, SAÍDA, RESGATE) aparecem como títulos seguidos de vazio; no mock são gravações centradas sob o conteúdo, com filete.
- Neutro e Padrão: quadrados vermelhos; mock: chaves listradas com CRC 0x4FFF e 0x1970.
- Prévia: alavanca e "A · AURI"/"B · EDITOR" pequenos e apagados; mock tem duas alavancas com legenda de estado ("desligada · ruído rosa", "B · editor").
- Em Neutro o gráfico não mostra os 10 pontos estacionados nem dica (T12).
- Desfazer, Refazer, "Salvar na biblioteca da minha conta" e "Publicar curva" apagados sem motivo (T8); "Sua curva, conectada" e "Importar e exportar" seguem cartões cinza fora do tema, com botões mono negrito (T4).
- "?" flutuante cobre a coluna SAÍDA (T3); "♪ Áudio" sem borda (T1).
- Banco de filtros (camada Ajustar): conferir as 10 tiras com knobs FREQ/GANHO/Q, chave PK/LS/OFF, CORTE/REFORÇO e mini resposta, e a régua do gate v2 com as 7 lâmpadas (a) a (g) e valores.

### 1.2 Biblioteca (Geoff Emerick) · completar no FUX.0

Capturas: `biblioteca.png`, `biblioteca-mobile.png`, `biblioteca-mobile-top.png`, `biblioteca-audio-popover.png` × `biblioteca-{desktop,mobile}-{default,reduced}-motion-*`. Verificar: material da estante e caixas com etiqueta em Courier Prime; abertura da ficha; VU L/R, PPM, LUFS e correlação com rótulo AO VIVO ou DADOS; vazio; exportar e compartilhar; popover de áudio; ordem no mobile. Transversais: T1 a T5, T8, T11.

### 1.3 Comparar (Les Paul) · completar no FUX.0

Capturas: `comparar.png`, `comparar-top.png` × `comparar-*`. Verificar: pistas como fita; armar com lâmpada; nível igualado visível (quanto cada pista desceu); VU por pista armada; sobreposição; exportar PNG; mobile. Transversais: T1 a T5, T8, T11.

### 1.4 Soe como X (Andy Hildebrand) · completar no FUX.0

Captura: `soe-como-x.png` × `soe-como-x-*`. Verificar: busca (inicial, carregando índice AutoEq, sem resultado); escolha do alvo; progresso do solver; A/B com VU e espectro; "levar ao editor"; explicação do solver; mobile. Transversais: T1 a T5, T8.

### 1.5 Comunidade (Bob Clearmountain)

Evidência: `comunidade-desktop-default-*` (comparação fina com `comunidade.png`, `comunidade-mixer-detail.png` no FUX.0).
- Legenda do cabeçalho (CANAL, SOLO/SEL, TOTAL RECALL, NO AR) é boa ideia, mas mono 11 px sem interação: vira a porta do tour.
- Mesa vazia: frase laranja num bloco preto e "0 canais na mesa"; sem convite visual.
- Scope master vazio, readouts com "−", Ouvir A/B desabilitado sem motivo.
- Avisos e painéis vazios em excesso (T9); Total Recall, compartilhamento, Denunciar e Comunidade prefere competem com o que funciona.
- "Publicar é ir ao ar": a fita crepe é boa homenagem, mas o envelope S5 aberto ocupa a maior área da página por padrão.
- S6: consentimento bem escrito, Turnstile já com erro (T10).
- Hierarquia: Publicar, S6 e S7 têm o mesmo peso que Denunciar e Packs.

### 1.6 Teste cego (Floyd Toole e Sean Olive)

Evidência: `teste-cego.png` × `teste-cego-desktop-default-*`.
- Palco: no mock as placas 1, 2 e 3 ficam em perspectiva no chão, grandes, no cone de luz; atual são três caixas tracejadas pequenas. O "? atalhos" do palco sumiu (T3). A pílula "TELA FECHADA" perdeu "aguardando candidatos".
- Console: mock tem LCDs RODADA "−−/−−" e TAXA DSP "96 kHz", play redondo grande, chave "Troca de 3 s", lâmpadas "Nível igualado" e "Em posição"; atual tem "Rodadas" maior que o valor, "▶ Tocar" pequeno e fantasma, checkbox nativa e uma só lâmpada.
- Preparo: mock em 3 colunas (FONTE com "Escolher arquivo de áudio", SAÍDA · OBRIGATÓRIO, NÍVEL com tabela candidato/nível/ajuste) mais o cartão MOTOR DE ÁUDIO; atual em 2 colunas, sem o botão direto e sem a tabela.
- Manter: cortina, cone de luz, madeira, abas 01 a 06.

### 1.7 Cabo (Ray Dolby)

Evidência: `cabo.png`, `cabo-u1-detail.png` × `cabo-desktop-default-*`.
- U1: mock tem chave CABO REAL/SIMULAR, trecho `navigator.hid.requestDevice(...)` e diagrama de estados em SVG; atual são 7 lâmpadas soltas.
- U2: o mapa de bytes em papel creme é ótimo, mas parece outra página; tratar como folha presa ao rack (fita, sombra). Sumiram o stepper de preamp e o PREAMP AUTO do mock.
- U3: mock materializa o checklist (VU creme, critérios (a) a (g) com valores, nível previsto, salto, três alavancas ABAIXEI O VOLUME, NÃO VOU DESCONECTAR, GRAVAR); atual é lista com "aprovado" e "Levantar tampa do checklist". Perdeu-se o "salto", que é a razão do aviso de loudness.
- U4: mock tem carretéis e fita R0 a R8 com leader e commit; atual tem faixa tipo filme e 9 botões "Report N" sem propósito claro.
- U5: vazio sem exemplo (T12). U7: mock lista cabos A, B, C com estado; atual tem texto e dois botões.
- Manter: rack, contadores mecânicos (U6), EM BREVE (U8).

### 1.8 Docs (Harry Nyquist)

Evidência: `docs-top.png` × `docs-desktop-default-*`, mais `docs.png`, `docs-middle.png`, `docs-bottom.png`. Topo fiel (fita, índice, título, plano complexo, notas marginais). A página ficou longa (seções sociais da F4 no fim). Falta orientação de leitura (seção atual no índice, progresso, voltar ao topo, âncoras copiáveis) e ancorar o glossário para os explicadores (§4.5).

### 1.9 Auth, conta, perfil, /c/[id], legal e offline

Sem baseline (§0.3): FUX.P8, P9 e P11 criam as capturas antes de mudar. Referências: Rupert Neve (auth e conta), Chris Lord-Alge (perfil), ficha da Biblioteca (/c/[id]). `/offline` carrega 126,8 kB de JS numa página estática (§5). Formulários de auth carregam `kit-enhance` (10,33 kB gzip) e o Turnstile: skeleton do widget e `preconnect` só nessas rotas.

---

## 2. Design system v2.1

### 2.1 Tipografia

| Papel | Token novo | Família | Pesos | Uso |
|---|---|---|---|---|
| Display | `--face-display: var(--serif)` | Instrument Serif | 400 normal e itálico | títulos de página e painel, wordmark, homenageado |
| Corpo e ação | `--face-body: var(--sans)` | Geist variável | 400, 500, 600 | texto, botões, formulários |
| Dados | `--face-data: var(--mono)` | JetBrains Mono | só 400 e 500 | números, códigos, hex, eyebrows, readouts |
| Gravação de painel | `--face-engrave` (por página) | fonte de época | conforme `fonts.css` | rótulos de hardware |

Gravação por página: Curva e Cabo `--cond`; Biblioteca `--type`; Comparar `--plate` e `--tape`; Comunidade `--marker` e `--crt`; Docs `--journal`; auth e perfil `--cond`.

Regras: ação nunca em mono; mono nunca acima de 500; `font-synthesis: none` no `html`; readouts com `font-variant-numeric: tabular-nums slashed-zero`; contagens em Geist com `tabular-nums`.

| Token | Valor | Altura de linha | Tracking |
|---|---|---|---|
| `--fs-display-xl` | `clamp(64px, 3.2rem + 3.5vw, 120px)` | `--lh-display: .92` | `--tracking-display: -0.025em` |
| `--fs-display-l` | `clamp(48px, 2.4rem + 2.2vw, 84px)` | .95 | −0.02em |
| `--fs-display-m` | `clamp(32px, 1.6rem + 1.2vw, 48px)` | 1.0 | −0.015em |
| `--fs-title` | `clamp(22px, 1.1rem + .6vw, 28px)` | `--lh-title: 1.1` | `--tracking-title: -0.01em` |
| `--fs-lede` | `clamp(16px, .95rem + .25vw, 19px)` | 1.5 | 0 |
| `--fs-body` | 15px (era 14px) | `--lh-body: 1.55` | 0 |
| `--fs-ui` | 14px (era 13px) | `--lh-ui: 1.3` | 0 |
| `--fs-small` | 13px | 1.4 | 0 |
| `--fs-caption` | 12px | 1.4 | 0.01em |
| `--label-min` | 11px no desktop e no mobile (era 10px no mobile) | `--lh-caps: 1.35` | `--tracking-caps: .14em` |
| `--fs-eyebrow` | 11px | 1.35 | `--tracking-eyebrow: .18em` |
| `--fs-readout-l` | `clamp(22px, 1.2rem + .5vw, 28px)` | 1 | `--tracking-data: .02em` |
| `--fs-readout` | 14px | 1.2 | .02em |
| `--fs-honoree` | `clamp(28px, 1.4rem + .8vw, 36px)` | 1 | −0.01em |

### 2.2 Cor (contrastes WCAG 2.x calculados)

| Token | Valor | Uso | Contraste |
|---|---|---|---|
| `--ink` | #0f0f0e (mantém) | fundo | |
| `--ink-2` | #171715 (mantém) | barra, popover | |
| `--ink-3` (novo) | #1d1c1a | painel elevado | |
| `--ink-4` (novo) | #2b2a27 | painel de hardware escuro | |
| `--text` | #ece7dd (mantém) | | |
| `--text-2` (novo, alias de `--nav-link`) | #cfc9be | secundário | |
| `--muted` | #8f8a80 (mantém) | só sobre `--ink` e `--ink-2` | 5,6:1 e 5,2:1 |
| `--muted-hi` (novo) | #a39d92 | sobre `--ink-3` e `--ink-4` | 5,25:1 sobre #2b2a27 |
| `--rule` | 12% (mantém) | só filetes decorativos | |
| `--rule-control` (novo) | `rgba(236,231,221,.40)` | borda de input, select, botão outline | ~3,4:1 (1.4.11) |
| `--ok` (novo) | #4cc38a | | 8,7:1 |
| `--warn` (novo) | #e5a23a | | 8,7:1 |
| `--danger` | #e5484d (mantém) | | 4,9:1 |
| `--lamp-off` (novo) | `rgba(236,231,221,.10)` | lâmpada apagada | |

`--accent-text` por página (acento garantido ≥ 4,5:1 sobre a superfície dominante): Curva, Biblioteca, Comparar, Comunidade e Teste cego usam `var(--accent)` (Curva 7,4:1, Biblioteca 8,5:1 sobre ink); Soe como X usa `var(--accent-hi)` sobre painéis (o acento passa sobre ink, 5,7:1, e reprova sobre #2b2a27, 4,2:1; #ff78af dá 5,8:1); Cabo usa `var(--accent)` sobre ink e `--accent-on-metal: #12554f` sobre metal (~5,2:1 sobre #c9c9c5, estimado); Docs usa #8c2f2f sobre papel #efe6d2 (6,6:1).

Teste novo `web/tests/unit/styles/contrast.test.ts` (FUX.1): cada par texto/superfície e acento/superfície, com as superfícies tiradas dos `:root` e classes dos mocks v2.

### 2.3 Elevação, brilho e material

```css
--elev-1: inset 0 1px 0 rgba(255,255,255,.04), 0 1px 0 rgba(0,0,0,.6);
--elev-2: inset 0 1px 0 rgba(255,255,255,.05), 0 10px 24px -10px rgba(0,0,0,.75);
--elev-3: 0 24px 64px -16px rgba(0,0,0,.8), 0 0 0 1px rgba(236,231,221,.06);
--well: inset 0 2px 6px rgba(0,0,0,.7), inset 0 0 0 1px rgba(0,0,0,.6); /* LCD, readout, fenda de fita */
--bevel: inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 0 rgba(0,0,0,.45);
--glow-1: 0 0 0 1px var(--accent-soft), 0 0 14px color-mix(in srgb, var(--accent) 30%, transparent);
--glow-2: 0 0 0 1px var(--accent-glow), 0 0 28px color-mix(in srgb, var(--accent) 45%, transparent);
--mat-metal: linear-gradient(180deg, #d4d4cf 0%, #bdbdb7 48%, #c9c9c4 100%);
--mat-lcd: radial-gradient(120% 80% at 50% 30%, #0e2a26 0%, #071513 70%);
```

Grão opcional: PNG pequeno em `web/static/textures/grain.png` (`img-src 'self'`). Madeira e papel reaproveitam os mocks.

### 2.4 Raio, espaçamento e layout

Mantém `--rad-xs` a `--rad-pill`; entram `--rad-2xl: 16px` e `--rad-bezel: 20px`. Mantém `--space-1` a `--space-8`; entram `--space-9: 120px`, `--section-gap: clamp(48px, 6vw, 96px)`, `--panel-pad: clamp(16px, 1.6vw, 28px)`. Alvos de toque `--hit`: 44px no mobile, 36px no desktop.

### 2.5 Movimento

```css
--dur-instant: 80ms; --dur-fast: .12s; --dur-base: .2s; --dur-slow: .36s; --dur-scene: .72s;
--ease-out: cubic-bezier(.2,.8,.2,1); /* mantém */
--ease-in-out: cubic-bezier(.65,0,.35,1);
--ease-mech: cubic-bezier(.3,1.4,.5,1); /* alavanca e knob com leve batente */
```

Medidores nunca usam esses tokens (balística real, §3.6). Reduced motion: bloco global de `base.css:115-130`; readouts a 10 Hz. Decorativo só se não lembrar medidor, parar com `prefers-reduced-motion` e não rodar em loop acima da dobra (exceção: fita do Docs, com pausa).

### 2.6 Receitas de componentes

Em `web/src/lib/styles/components.css` (novo) e `web/src/lib/components/primitives/**` (novo).

- **Botão `.btn`:** variantes `--primary` (acento cheio, texto `--accent-ink`), `--plate` (`--bevel` + `--rule-control`), `--ghost`, `--danger`, `--key` (tecla com LED, só por estado real), `--lever` (só confirmação física). Tamanhos sm 28, md 36, lg 44 (mínimo 44 no mobile). Geist 500 `--fs-ui`; caixa alta com `--face-engrave` e `--tracking-caps`. Hover `translateY(-1px)` + `--glow-1`; active `translateY(1px)` + `--well`; foco anel 2 px acento offset 3 px; loading com `aria-busy`, spinner e largura fixa. Desabilitado com motivo: `aria-disabled="true"`, focável, motivo em tooltip e `aria-describedby`, estilo `--lamp-off`. API `<Button disabledReason="…">`; desabilitado sem motivo é proibido.
- **Input:** 36 px (44 no mobile), fundo `--ink`, borda `--rule-control`; inválido com borda `--danger`, mensagem com ícone e `aria-invalid`; número com sufixo de unidade e steppers.
- **Slider e knob:** mostram a faixa permitida em acento (faixas suaves §3.3); excesso hachurado e não selecionável.
- **Painel:** `.panel` (ink-3, `--elev-1`, `--rad-lg`), `.panel--hardware` (material da página), `.panel--paper`; cabeçalho com eyebrow mono caps, título serif e slot para o Explainer.
- **Chip:** ok, warn, danger, neutral, accent; chip de modo sempre AO VIVO, DADOS ou APAGADO (§3.6).
- **Toast:** embaixo à direita no desktop, embaixo ao centro no mobile acima da safe area; no máximo 3; ícone de tom e ação opcional "Desfazer".
- **Tooltip:** atraso 400 ms, abre por foco, fecha com Esc; nunca é o único lugar de informação crítica.
- **Explainer ("o que é isso?"):** gatilho "?" 24 px (alvo 44 no mobile); popover não modal com 1 a 3 frases e "Ver no glossário"; foco volta ao gatilho.
- **EmptyState:** ilustração SVG temática, título, frase de "por quê", ação primária, link "o que é isso?".
- **Skeleton:** mesma geometria do final (CLS zero), `aria-busy` no contêiner, shimmer 1,2 s (estático em reduced motion), "Carregando…" só para leitor de tela.
- **Lâmpada:** `on`/`off`, sempre ligada a estado real.
- **Menu do usuário (pedido do operador):** gatilho no nome da conta na barra; itens minha conta, perfil público, minha biblioteca, admin (só admin), sair; `aria-haspopup="menu"`, `role="menu"`, setas, Enter/Espaço, Esc fecha e devolve o foco, clique fora fecha; posição fixa abaixo do botão (a barra rola na horizontal e corta posição absoluta, como no painel de áudio).

### 2.7 Edições exatas de tokens

- `tokens.css`: acrescentar os blocos de §2.1 a §2.5; `--fs-body` 15px, `--fs-ui` 14px, `--fs-honoree` clamp; remover `--label-min: 10px` do media query mobile.
- `accents.css`: `--accent-text` em cada `[data-page]`; `--accent-on-metal` em `[data-page='cabo']`.
- `base.css`: `html { font-synthesis: none }`; `body` com `--lh-body`; classes `.h-display-xl`, `.h-display-l`, `.h-display-m`, `.title`, `.lede`, `.eyebrow`, `.readout`; trocar a regra de disabled (`base.css:52-56`) por `--lamp-off` + cursor, `opacity: .55` só em controles nativos.
- `theme.css`: mapear `--text-display-xl`, `--text-display-l`, `--text-display-m`, `--text-title`, `--text-lede`, `--text-small`, `--text-caption`, `--color-ink-3`, `--color-ink-4`, `--color-muted-hi`, `--color-ok`, `--color-warn`, `--color-accent-text`, `--radius-2xl`.
- `index.css`: importar `./components.css` depois de `base.css`.

---

## 3. Dramaticidade por tema

Todo movimento é estado real (dado, gate, transporte, rede) ou decorativo declarado; decorativo não lembra medidor, para em reduced motion e não roda em loop acima da dobra.

| Página e homenagem | Hero | Movimento assinatura | Origem | Materialidade |
|---|---|---|---|---|
| Curva · Bob Moog | painel de módulo com madeira lateral e parafusos; seletor rotativo de camada | traço se desenha ao carregar preset (360 ms); caixa segura acende ao pegar um ponto; na fronteira, batente de 120 ms e chip com o motivo | curva e gate (real) | osciloscópio com vidro e brilho, knobs graduados, LCD |
| Biblioteca · Geoff Emerick | estante de caixas de fita com etiquetas datilografadas | caixa desliza da estante, ficha abre como papel | transição de UI; VUs reais | papelão, fita, papel milimetrado |
| Comparar · Les Paul | mesa multipista com pistas como fita | ao igualar nível, trims deslizam até o valor calculado, uma vez | levelDb (real) | placa Oswald, rótulo Special Elite, lâmpada de armar |
| Soe como X · Andy Hildebrand | medição e alvo sobrepostos | curva corrigida converge seguindo as iterações do solver | progresso do worker (real) | tela escura, traço em acento |
| Comunidade · Bob Clearmountain | console grande "ao vivo", mesa A de 1985 | NO AR acende com a aprovação do servidor; SEL acende o canal e o scope traça a curva | servidor e dados (real) | fita crepe com marcador, LCD VT323 |
| Teste cego · Toole e Olive | palco, cortina, cone de luz, placas em perspectiva | cortina abre no resultado; placas trocam na troca | estado do teste (real); poeira no cone decorativa, só no hero | veludo, madeira, console de couro |
| Cabo · Ray Dolby | rack 19" U1 a U8 | diagrama WebHID acende o nó atual; carretéis giram só em ensaio ou gravação, sincronizados com report 0 a 8 e commit; alavancas com batente | estado do cabo e índice do report (real) | alumínio escovado, LCD verde, contadores mecânicos |
| Docs · Harry Nyquist | caderno técnico com fita de transmissão | figuras se traçam ao entrar na viewport, uma vez | dados da curva (real) | papel, tinta vermelha, EB Garamond |
| Auth e conta · Rupert Neve | canal de console vertical: entrada, ganho, EQ, saída = campos | canal acende estágio por estágio conforme os campos validam | validação (real) | painel azul-acinzentado, knobs, filetes |
| Perfil · Chris Lord-Alge | coleção assinada: parede de "discos" com as curvas públicas | disco gira 1/8 no hover (decorativo, sem loop) | decorativo declarado | vinil, assinatura, acento do T4.11 |

---

## 4. Camada de compreensão

### 4.1 Mecanismos

- **Divulgação progressiva:** blocos técnicos (envelope S5, hex, palavras Q27, estágios do gate) fechados em "Ver detalhes técnicos" no Ouvir e no Ajustar; abertos na Engenharia e no Cabo.
- **Consentimento silencioso:** nada aparece "com erro" antes de o usuário pedir (Turnstile só depois do consentimento).
- **Padrões seguros:** carregar Neutro, Padrão ou preset por cima de edição não gravada gera toast com Desfazer (`app.state.curve.undo()`), sem modal (hoje só toast simples, `+layout.svelte:153-157`); nível igualado ligado por padrão em todo A/B; publicação com padrão "Não listada" é **proposta, exige OK do PO** antes do FUX.P4.
- **Desfazer visível:** Ctrl+Z global (`+layout.svelte:159-173`) entra no HelpOverlay e nos toasts das ações que trocam a curva.
- **Sem códigos do plano na UI** (T15): "S6" vira "Preferência anônima", "S7" vira "Troca às cegas", "S1" vira "código da curva", etc.; o código fica só em ids, arquivos e Docs técnicos.

### 4.2 Tour guiado

3 a 5 passos, dispensável, lembrado em `oa.tour.v1` (`{ <pagina>: "visto" | "dispensado" }`), que entra no contrato de armazenamento (plano §4.3, pelo orquestrador) e em "Apagar dados locais"; nunca enviado. Abre na primeira visita só no desktop (no mobile vira "Como funciona"); reabre pelo "?" do cabeçalho. `role="dialog"` não modal, foco gerenciado, Esc fecha, fundo utilizável; sem destaque animado em reduced motion.

Curva:

| Passo | pt-BR | en-US |
|---|---|---|
| 1 | **Três camadas, um instrumento.** Ouvir para escolher, Ajustar para mexer nas 10 seções, Engenharia para tipos experimentais. Troque com 1, 2 e 3. | **Three layers, one instrument.** Listen to choose, Adjust to move the 10 sections, Engineering for experimental types. Switch with 1, 2 and 3. |
| 2 | **O gráfico é o que vai para o cabo.** A linha cheia é a saída com preamp, calculada com os mesmos números que o chip usa. A caixa tracejada mostra até onde o ponto selecionado pode ir. | **The chart is what goes to the cable.** The solid line is the output with preamp, computed with the same numbers the chip uses. The dashed box shows how far the selected point can go. |
| 3 | **Comece por um preset.** Os presets oficiais e o Neutro carregam no editor. Nada é gravado só por clicar. | **Start from a preset.** Official presets and Neutral load into the editor. Nothing is written just by clicking. |
| 4 | **Gravar é sempre um gesto seu.** Gravar no cabo abre um checklist: gate, volume e conexão. Sem ele, nenhum byte sai. | **Writing is always your gesture.** Write to cable opens a checklist: gate, volume and connection. Without it, no byte leaves. |

Outras páginas (FUX.3 escreve en-US): Comunidade (canais e SEL; scope master e A/B; publicar; preferência anônima e troca às cegas); Cabo (conectar ou simular; os 220 bytes; checklist; fita; diário); Soe como X (fone; alvo; solver; A/B; levar ao editor); Comparar (pistas; armar; nível igualado); Teste cego (preparo; escuta; resultado); Biblioteca (estante; ficha; compartilhar).

### 4.3 Explicadores

Registro `web/src/lib/comprehension/explainers.ts` (termo, título, pt-BR, en-US, âncora do glossário).

- **Gate.** pt-BR: "Antes de qualquer gravação, o open-auri confere a curva com os números exatos que iriam para o cabo. Se ela sair do que os presets oficiais já fazem, o botão Gravar fica travado e mostramos o motivo. É uma política de semelhança com o que os 11 presets oficiais já fazem o chip calcular, não uma prova de segurança do hardware." en-US: "Before any write, open-auri checks the curve against the exact numbers that would go to the cable. If it goes beyond what the official presets already do, Write stays locked and we show you why." + ressalva en-US existente (ou "It is a similarity policy with what the 11 official presets already make the chip compute, not a proof of hardware safety.").
- **Motivos do gate** (sem `stage`, usar "na curva inteira" / "across the whole curve"; o FX-UX já nomeia a banda quando há `stage`):

| Código | pt-BR | en-US |
|---|---|---|
| a | Um dos números deste filtro ficou maior do que qualquer preset oficial usa. Diminua o ganho ou o Q desta seção. | One of this filter's numbers is larger than any official preset uses. Lower this section's gain or Q. |
| b | Este filtro ficaria perto demais do limite de estabilidade. Afaste a frequência dos extremos ou reduza o Q. | This filter would sit too close to the stability limit. Move the frequency away from the extremes or lower Q. |
| c | Sozinha, esta seção reforça mais de 9,2 dB em algum ponto. Reduza o ganho. | On its own, this section boosts more than 9.2 dB somewhere. Lower the gain. |
| d | Somando as seções até aqui, o sinal passaria de −0,2 dB dentro do chip. Abaixe o preamp ou reduza os reforços. | Adding the sections so far, the signal would exceed −0.2 dB inside the chip. Lower the preamp or the boosts. |
| e | A saída passaria de −0,47 dB entre 20 Hz e 20 kHz (ou de +2,5 dB até 48 kHz). Abaixe o preamp. | The output would exceed −0.47 dB between 20 Hz and 20 kHz (or +2.5 dB up to 48 kHz). Lower the preamp. |
| f | Os valores não cabem no formato que o cabo entende. | The values do not fit the format the cable understands. |
| g | O preamp precisa ficar entre −25,5 e −0,5 dB. | The preamp must stay between −25.5 and −0.5 dB. |

- **Envelope observado.** pt-BR: "A caixa tracejada mostra até onde este filtro pode ir sem sair do envelope observado: frequência, ganho e Q que os presets oficiais já usam. Arraste à vontade dentro dela. Na borda, o ponto para e explicamos o motivo." en-US: "The dashed box shows how far this filter can go without leaving the observed envelope: the frequency, gain and Q the official presets already use. Drag freely inside it. At the edge, the point stops and we explain why."
- **Q.** pt-BR: "Q é a largura do filtro. Q baixo (0,5 a 1) mexe numa faixa larga e soa natural. Q alto (2 a 4) mexe numa faixa estreita, bom para corrigir um pico pontual. Reforços ficam limitados a Q 4." en-US: "Q is the filter's width. Low Q (0.5 to 1) moves a wide band and sounds natural. High Q (2 to 4) moves a narrow band, good for fixing a single peak. Boosts are limited to Q 4."
- **Preamp.** pt-BR: "O preamp abaixa o volume de tudo antes dos filtros, para os reforços não estourarem dentro do chip. Ele só desce: vai de −25,5 a −0,5 dB. O botão Máximo sem clipping escolhe o preamp mais alto que mantém a curva dentro do gate." en-US: "The preamp lowers everything before the filters so boosts do not clip inside the chip. It only goes down: from −25.5 to −0.5 dB. Max without clipping picks the highest preamp that keeps the curve inside the gate."
- **Código da curva (S1).** pt-BR: "O código da curva é a curva inteira escrita num texto curto, o link #p=. Quem abre o link vê a mesma curva no editor. Nada vai para o cabo sem passar de novo pelo gate e pelo checklist. Não precisa de conta nem de servidor." en-US: "The curve code is the whole curve written as short text, the #p= link. Whoever opens it sees the same curve in the editor. Nothing goes to the cable without passing the gate and the checklist again. No account or server needed."
- **A/B com nível igualado.** pt-BR: "Volumes diferentes enganam o ouvido: o mais alto quase sempre parece melhor. Por isso A e B tocam com o mesmo nível percebido (média de 300 Hz a 3 kHz, preamp incluído). Sempre abaixamos o mais alto e nunca subimos o mais baixo. Vale só para a prévia no navegador." en-US: "Different loudness fools the ear: the louder one almost always seems better. So A and B play at the same perceived level (average from 300 Hz to 3 kHz, preamp included). We always lower the louder one and never raise the quieter one. Browser preview only."
- **Teste cego.** pt-BR: "Você ouve até três curvas sem saber qual é qual, com o mesmo nível e em ordem sorteada, e escolhe de ouvido. Os nomes só aparecem no fim. É o jeito mais honesto de descobrir do que você gosta, sem a influência do nome ou do gráfico. Nada é gravado no cabo durante o teste." en-US: "You hear up to three curves without knowing which is which, at the same level and in random order, and choose by ear. Names only appear at the end. It is the most honest way to find what you like, free from names and charts. Nothing is written to the cable during the test."
- **Checklist de gravação.** pt-BR: "Gravar é a única ação que muda o cabo, e o cabo não devolve o que guarda. Antes de cada gravação: 1) o gate confere a curva de novo; 2) você confirma que abaixou o volume; 3) você confirma que não vai desconectar durante a gravação (cerca de 0,3 s); 4) você aperta Gravar. Nada é gravado sozinho, nem ao arrastar." Sempre visível e literal na mesma tela: "A nova curva pode soar mais alta. Abaixe o volume antes de gravar." en-US: "Writing is the only action that changes the cable, and the cable never gives back what it stores. Before every write: 1) the gate checks the curve again; 2) you confirm you lowered the volume; 3) you confirm you will not unplug during the write (about 0.3 s); 4) you press Write. Nothing is ever written on its own, not even while dragging."
- **Preferência anônima (S6).** pt-BR: "Você compara pares de curvas às cegas e pode doar o resultado, sem conta e sem IP, só com o seu consentimento. O navegador guarda um recibo para você retirar o lote quando quiser. Os lotes formam o ranking Comunidade prefere." en-US: "You compare pairs of curves blind and may donate the result, with no account and no IP, only with your consent. Your browser keeps a receipt so you can withdraw the batch anytime. Batches feed the Community prefers ranking."
- **Troca às cegas (S7).** pt-BR: "Você entra numa fila com uma curva sua aprovada no gate. Quando outra pessoa entrar, cada um ouve a curva do outro às cegas e dá uma nota de 1 a 5. Os nomes aparecem depois das duas notas. Sem par em 72 h, a troca expira. Precisa de conta com e-mail verificado." en-US: "You join a queue with one of your gate-approved curves. When someone else joins, each of you hears the other's curve blind and rates it from 1 to 5. Names appear after both ratings. With no match in 72 h, the trade expires. Requires an account with a verified e-mail."
- **Apoio** (FUX.3 escreve en-US): Camadas ("Ouvir: escolher e comparar. Ajustar: mexer nas 10 seções PK e LS dentro do envelope. Engenharia: HS, LP e HP experimentais, com confirmação extra antes de gravar."); Neutro ("10 seções desligadas e preamp −0,5 dB. É o ponto seguro para voltar."); Ficha técnica (S5) ("A ficha técnica da curva em JSON (bandas, licença, receita). É o que o servidor valida. Você não precisa ler para publicar.").

### 4.4 Vazios que ensinam

- **Comunidade sem canais:** "A mesa está montada. Os canais acendem quando as primeiras curvas forem publicadas." Ação "Publicar a curva do editor". Três strips EXEMPLO com presets oficiais, sem SEL de publicação, rótulo "exemplo, não publicado".
- **Visitante sem conta:** um cartão único no lugar dos avisos repetidos. Cadastro aberto: "Publicar, favoritar e trocar pedem uma conta com e-mail verificado. Ouvir, comparar e compartilhar por link funcionam sem conta." Cadastro fechado: "Contas novas abrem em breve. Ouvir, comparar e compartilhar por link já funcionam sem conta."
- **Diário vazio (Cabo):** "O diário é a única memória do que foi gravado, porque o cabo não devolve o que guarda. Depois da primeira gravação real, ela aparece aqui como uma caixa de fita, com CRC e curva para regravar." + 3 caixas EXEMPLO não interativas.
- **Biblioteca vazia:** "Sua estante está vazia. Salve a curva do editor ou importe um .txt do EqualizerAPO. Tudo fica neste navegador."
- **Soe como X sem resultado:** "Nenhum fone com esse nome. Tente parte do nome, como aparece no AutoEq, ou importe uma medição."
- **Curva em Neutro:** 10 pontos estacionados em 0 dB com a dica "Arraste um ponto para criar um filtro, ou carregue um preset"; caixa segura ao focar um ponto.

### 4.5 Glossário

`web/src/lib/comprehension/glossary.ts` mapeia termo → `/docs#g-<termo>` (gate, envelope, q, preamp, s1, s5, s6, s7, ab-nivel, teste-cego, checklist, flash, crc, q27, q23, camadas, neutro). O FUX.P7 garante cada âncora no Glossário do Docs; um e2e percorre os links e falha se faltar âncora.

---

## 5. Estratégia de carregamento

### 5.1 O que o layout carrega em toda rota

Imports estáticos de `web/src/routes/+layout.svelte:2-34`: contexto do app; chrome; `AudioLoader`; `CableStatus`, `PreWriteChecklist`, `RescueNotice`; `PolicyBanner`; `SocialSync`; `startOutboxBridge`; `createSocialApi`, `createSocialOutbox`, `createSocialSession`.

- `createClientApp` importa catálogo, safety, policy, motor de áudio, serviço do cabo, estado e toasts (`web/src/lib/app/client.svelte.ts:1-17`), e cria motor (`:31`) e serviço do cabo (`:37`) em todo mount (`+layout.svelte:142-151`).
- O serviço do cabo importa transport (WebHID e FakeHID), policy, dsp e `gateForWrite` (`web/src/lib/cable/service.ts:20-36`).
- `AudioLoader` importa o motor e o barril de medidores (`AudioLoader.svelte:9-21`).

No build (`manifest.json:191-215`), `nodes/0` importa: `BXYIYki6` (catálogo, transport, motor de áudio, validação S5), `BYQ7OMc_` (sessão, aceite de política, cola dos medidores; `:909-926`), `D9iE5TBL` (cabo; `:1036-1052`), `nqzwuMCw` (medidores; `:1192-1204`), `CWrDADXf` (PolicyBanner), `Tr8s_T2y` (api), `DLrtwr-i` (outbox), `DxpCl-Eg` (motion), `CDtJ0hSD` (dsp). Os hashes mudam a cada build; o FUX.2 refaz a tabela com `--by-chunk`.

### 5.2 Decomposição de `/offline` (126,8 kB gzip)

| Parte | kB gzip | Base |
|---|---|---|
| Boot do SvelteKit e do Svelte | 44,9 | medido (mesmos hashes no log de deploy) |
| Nó da página `/offline` | 0,70 | medido |
| Módulos pequenos do layout | 14,3 | medidos: dsp 4,19, i18n do cabo 2,60, outbox 2,34, api 2,09, ConfirmDialog 0,81, EmBreve 0,60, modal 0,53, outros |
| `nodes/0` | ~13 | estimado (build anterior 13,06) |
| Chunk "app" | ~32 | estimado (build anterior 31,70) |
| Cabo, social, sessão, medidores, PolicyBanner, motion | ~22 | estimado por subtração |

Leitura: ~81 kB, quase dois terços do JS de uma página estática, vêm do layout (áudio, cabo, gate, social, medidores) que a página não usa.

### 5.3 Mudanças sob demanda, em ordem

| # | Mudança | Onde | Economia (gzip) | Impacto |
|---|---|---|---|---|
| L1 | Runtime do app por import dinâmico: `context.mount()` assíncrono com `import('#lib/app/client.svelte.ts')`; contrato "client é null antes do mount" mantido (`context.svelte.ts:14-17`); toast store nasce no layout e é injetado | `lib/app/**` e layout | −30 a −35 nas estáticas | LCP −100 a −300 ms em 4G móvel; menos hidratação e TBT |
| L2 | Ilhas de chrome sob demanda: `PreWriteChecklist` e `MultiCableQueue` só com `pendingWrite`; `CableStatus` na primeira abertura; `RescueNotice` só com marcador; painel do `AudioLoader` no primeiro clique ou hover; `HelpOverlay` ao abrir; `UpdatePrompt` no idle; `PolicyBanner` só se a versão não foi vista | layout e `AudioLoader` | −15 a −20 | idem |
| L3 | Social adiado: só `AccountEntry` eager; api, outbox, bridge e `SocialSync` no idle, ou na hora se há conta ou itens na outbox | layout e `lib/social/**` | −4 a −6 | menor |
| L4 | Núcleo em chunks por área (`advancedChunks`: catalog, safety, transport, audio, share, meter-fmt) | `web/vite.config.ts` (fila) | −5 a −15 em Docs, Biblioteca, Teste cego | menor |
| L5 | `SocialPublish` sob demanda (abaixo da dobra) | Curva, Comparar, Soe | −3 a −5 por rota | menor |
| L6 | Comunidade: QR sob demanda (4,19) e Turnstile só depois do consentimento (1,18) | Comunidade | −5,4 | sem terceiros antes do consentimento; some o erro T10 |
| L7 | Docs com conteúdo por locale (nó tinha 26,30 kB, quase tudo prosa bilíngue) | Docs | −8 a −12 | menor |
| L8 | Uma fonte de verdade para fontes (§5.6, T11) | páginas | CSS e woff duplicados | menos bytes concorrentes |

Salvaguardas do L1 e L2:
- **Resgate imediato:** no mount o layout lê de forma síncrona `localStorage['oa.cable.inflight']`; com marcador, importa o runtime na hora; o e2e do resgate continua verde.
- **Offline (§3.9):** o service worker guarda os chunks dinâmicos; e2e offline cobre editor, cabo simulado, prévia e teste cego sem rede.
- **Rotas-instrumento** (`/`, `/comparar`, `/soe-como-x`, `/cabo`, `/teste-cego`, `/biblioteca`, `/comunidade`) incluem o runtime no closure estático (`preloadAppRuntime()`), sem cascata.
- **Barra enquanto carrega:** status do cabo em skeleton de pílula; "Gravar no cabo" desabilitado com "Carregando o motor do cabo…".

### 5.4 Pré-aquecimento

| # | Ação | Detalhe |
|---|---|---|
| W1 | Navegação | `data-sveltekit-preload-code="hover"` no Nav (cobre foco e toque); confirmar `data-sveltekit-preload-data="hover"` no `<body>` de `web/src/app.html`; sem pré-carga em massa no mobile |
| W2 | Runtime | Estáticas: `requestIdleCallback` (timeout 1500 ms) ou na hora com marcador. Instrumento: estático |
| W3 | Áudio | `pointerdown`/`keydown` em controle de tocar: criar ou retomar `AudioContext` e `addModule` do worklet antes do `click`; no idle das páginas com medidor, aquecer o cache do `meter-processor` com fetch de baixa prioridade |
| W4 | Workers | gate worker no idle após a primeira pintura (Curva, Soe, Comparar); solver worker ao focar a busca do Soe |
| W5 | AutoEq | prefetch de `/data/autoeq/index.json` no hover/foco do "Soe como X" e no idle da página; se passar de 150 kB gzip, só ao focar a busca |
| W6 | Fontes | preloads da §5.6 |
| W7 | Terceiros | `preconnect` a `https://challenges.cloudflare.com` só em auth e na Comunidade depois do consentimento |

### 5.5 Skeletons e placeholders

Barra (status do cabo); gráficos (caixa com `aspect-ratio` fixo e grade estática, CLS zero); Comunidade (6 strips durante o fetch; linhas no Total Recall e rankings); Soe (resultados enquanto o índice carrega); Biblioteca (cartões durante o restore do IndexedDB); `/conta` (sessões e exportação); `/u/[apelido]` (cabeçalho e grade); Turnstile (caixa de 65 px "Preparando verificação…"). Medidores nunca têm skeleton animado: mostram DADOS ou APAGADO na hora (§3.6).

### 5.6 Fontes

- Fonte única: `fonts.css`; remover imports `@fontsource/*` das páginas (grep `@fontsource` em `web/src`); conferir que todo peso usado existe em `fonts.css`.
- Preloads globais (no máximo 3, `app.html` ou head do layout): Geist variável latin; Instrument Serif itálico (wordmark); Instrument Serif normal (h1). Por página, no máximo um, só se a fonte de época aparece acima da dobra (`<svelte:head>` da rota).
- `font-display: swap` para corpo, UI e display; `optional` para fontes de época decorativas abaixo da dobra.
- Fallbacks com métricas: `@font-face` "Instrument Serif Fallback" (Georgia) e "Geist Fallback" (Arial) com `size-adjust`, `ascent-override`, `descent-override`, medidos por script Playwright (`measureText`) no FUX.1, sem pacote novo.
- Subconjunto latin atual (`fonts.css:6`) cobre pt-BR, en-US e U+2212.

### 5.7 Metas de JS inicial (gzip) depois do FUX.2

| Classe | Rotas | Hoje | Meta |
|---|---|---|---|
| Estática | `/offline`, `/privacidade`, `/termos`, `/verificar-email`, `/esqueci-senha`, `/redefinir-senha` | 126,8 a 130,6 | ≤ 80 |
| Auth | `/entrar`, `/criar-conta`, `/conta/**` | 139,5 | ≤ 100 |
| Docs | `/docs` | 160,0 | ≤ 130 |
| Instrumento leve | `/teste-cego`, `/cabo`, `/biblioteca`, `/c/[id]`, `/u/[apelido]` | 144,0 a 153,1 | ≤ 140 |
| Instrumento pesado | `/`, `/soe-como-x`, `/comparar`, `/comunidade` | 162,5 a 170,7 | ≤ 160 (alvo 150) |

`web/scripts/check-budgets.mjs` ganha `--by-chunk` (tabela por rota com o `name` do manifest) e metas por classe num JSON versionado ao lado, que falham o build.

---

## 6. Plano de implementação

Regras: W disjuntos; fila de integração para `web/vite.config.ts`, `web/tests/e2e/visual.spec.ts`, mescla de `web/messages/*.json` e §4.3 do plano; mensagens só em `web/messages/_staging/FUX.<id>.{pt-BR,en-US}.json` (o `merge-messages.mjs` recusa chaves existentes: para mudar texto de chave existente, renomear a chave ou o orquestrador edita o JSON mesclado); QA sempre heavy; nunca Co-Authored-By nem "Generated with".

Ordem: FUX.0 em paralelo com FUX.1; FUX.2 (serial) em paralelo com FUX.3; FUX.P1 a P9 e P11 em paralelo; FUX.P10 (Curva) depois do FUX.1 a FUX.3; FUX.T; FUX.Q.

Aceite comum de toda tarefa de UI:

| ID | Critério |
|---|---|
| A1 | revisão visual lado a lado com o mock, checklist da §1 fechado, capturas citadas |
| A2 | axe sem violações sérias ou críticas, desktop e mobile, movimento padrão e reduzido |
| A3 | orçamento da rota na meta da §5.7, sem passar de +3 kB sobre a base pós-FUX.2 |
| A4 | testes da área verdes; snapshots regenerados só da própria página |
| A5 | reduced motion: sem animação, readouts a 10 Hz |
| A6 | sem travessão no staging pt-BR, sem marcas proibidas, textos literais inalterados (teste com string exata), sem códigos do plano em títulos visíveis |
| A7 | §0.12: medidores APAGADO ou DADOS sem áudio; gravação só via `app.requestWrite()` |
| A8 | nenhuma edição fora do W |

| ID | Objetivo | W | Dep. | Tier | Aceite específico |
|---|---|---|---|---|---|
| FUX.0 | completar o diagnóstico de Biblioteca, Comparar, Soe e todas as capturas mobile e de movimento reduzido | `docs/plans/fux-spec.md` (§1.2 a §1.4 e mobile da §1.0) | nenhuma | normal (explorer lê; orquestrador grava) | cada achado com nome da captura |
| FUX.1 | tokens, tipografia, cor, botões, primitivos e menu do usuário; adoção no chrome | `web/src/lib/styles/{tokens,accents,base,theme,fonts,index}.css`, `components.css` (novo), `web/src/lib/components/primitives/**` (Button, IconButton, Chip, Panel, Field, Tooltip, Lamp, Skeleton, EmptyState, Menu, index.ts), `web/src/lib/components/chrome/{CableBar,Nav,Footer,Toast,ToastItem,ConfirmDialog,EmBreve,AccountEntry,LanguageToggle,HelpOverlay}.svelte`, staging FUX.1, `web/tests/unit/primitives/**`, `web/tests/unit/styles/contrast.test.ts`, todos os snapshots | nenhuma | **heavy** | A1 a A8; T2, T3, T4 a T8 resolvidos no chrome; menu do usuário (§2.6); contraste cobrindo §2.2; fallbacks de fonte medidos |
| FUX.2 | carregamento sob demanda e pré-aquecimento | `web/src/routes/+layout.svelte`, `web/src/app.html`, `web/src/lib/app/**`, `web/src/lib/components/audio/**` (gatilho separado do painel, estilo da barra T1), `web/src/lib/components/social/SocialSync.svelte`, `web/src/lib/social/**`, `web/src/lib/components/chrome/account*.ts`, `Nav.svelte` (só preload, depois do FUX.1), `web/src/lib/pwa/**`, `web/src/service-worker.ts` (se o precache exigir), `web/scripts/check-budgets.mjs` + JSON de metas + testes, `web/tests/e2e/loading.spec.ts` (novo); `vite.config.ts` via fila | FUX.1 | **heavy** | §5.7 cumprida; e2e de resgate, checklist, gravação simulada e offline verdes; sem erro de hidratação; tabela `--by-chunk` no relatório; LCP antes e depois |
| FUX.3 | tour, explicadores, glossário e remoção dos códigos do plano dos textos | `web/src/lib/comprehension/**` (tour.svelte.ts, explainers.ts, glossary.ts), `web/src/lib/components/comprehension/**` (Tour, Explainer, GlossaryLink), módulo de "Apagar dados locais" (só `oa.tour.v1`), staging FUX.3 (copy de §4.3, §4.4 e títulos sem códigos), testes | FUX.1 (paralelo ao FUX.2) | normal | acessíveis por teclado e leitor de tela; chave apagada por "Apagar dados locais"; orquestrador registra a chave na §4.3 do plano |
| FUX.P0 | lista de bloqueio de apelidos (pedido do operador) | `web/src/lib/server/auth/username-blocklist.ts` (novo, dados versionados sem dados pessoais), `web/src/lib/server/auth/username.ts` (usar a lista no `checkUsername`), testes | nenhuma | normal | ódio (racismo, homofobia e demais, pt-BR e en-US, com leetspeak e acentos via o esqueleto de confundíveis), personificação da administração (admin, moderador, suporte, equipe, oficial, open-auri, staff e variações), marcas registradas do meio (fones, DACs, cabos, plataformas de áudio) e gerais; cadastro e troca de apelido recusam; mensagem não revela a regra; reaproveita os reservados atuais |
| FUX.P1 | Biblioteca e /c/[id] | `web/src/routes/biblioteca/**`, `web/src/routes/c/[id]/+page.svelte`, `web/src/lib/components/pages/biblioteca/**`, testes, staging, snapshots biblioteca-* | FUX.1 a 3 | normal | A1 a A8; tour; vazio que ensina; fim do Fontsource |
| FUX.P2 | Comparar | `web/src/routes/comparar/**`, `web/src/lib/components/pages/comparar/**`, testes, staging, snapshots | idem | normal | nível igualado visível; L5; fim do Fontsource |
| FUX.P3 | Soe como X | `web/src/routes/soe-como-x/**`, `web/src/lib/components/pages/soe-como-x/**`, testes, staging, snapshots | idem | normal | W4 e W5; progresso real do solver; L5 |
| FUX.P4 | Comunidade e visual do SocialPublish | `web/src/routes/comunidade/**`, `web/src/lib/components/pages/comunidade/**`, `SocialPublish` (só visual), testes, staging, snapshots comunidade-* | idem; padrão de visibilidade só com OK do PO | **heavy** | L6; cartão único de login; canais EXEMPLO rotulados; ficha técnica recolhida; Publicar, preferência anônima e troca às cegas acima de Packs e Denunciar |
| FUX.P5 | Teste cego | `web/src/routes/teste-cego/**`, `web/src/lib/components/pages/teste-cego/**`, testes, staging, snapshots | idem | normal | console com LCDs, play grande, chave; Preparo em 3 colunas com "Escolher arquivo de áudio"; Turnstile depois do consentimento |
| FUX.P6 | Cabo e checklist global | `web/src/routes/cabo/**`, `web/src/lib/components/pages/cabo/**`, `web/src/lib/components/cable/**`, testes, staging, snapshots cabo-* | idem | **heavy** | diagrama de estados real; carretéis no índice do report; cada alavanca ligada a uma confirmação real; salto de nível visível; aviso de loudness literal; diário com EXEMPLO; testes de segurança do checklist verdes |
| FUX.P7 | Docs e legais | `web/src/routes/{docs,privacidade,termos}/+page.svelte` e `+page.ts`, `web/src/lib/components/pages/docs/**`, `web/src/lib/components/legal/**` exceto PolicyBanner, testes, staging, snapshots docs-* | idem | normal | índice fixo com seção atual; âncoras do glossário (e2e); L7 |
| FUX.P8 | Auth e conta | rotas de auth e `web/src/routes/conta/**/+page.svelte`, componentes de conta, `Turnstile.svelte`, staging; baselines novas via fila | idem | normal | canal de console; skeleton do Turnstile; W7; baselines criadas |
| FUX.P9 | Perfil público | `web/src/routes/u/[apelido]/+page.svelte`, componentes do perfil, staging; baseline via fila | idem | normal | parede de discos; vazio que ensina |
| FUX.P10 | Curva: adoção do sistema | `web/src/routes/+page.svelte`, `web/src/lib/components/pages/curva/**`, testes, staging, snapshots curva-* | FUX.1 a 3 | **heavy** | tour §4.2; seletor rotativo de camada; cartões de preset; knobs graduados; chaves Neutro/Padrão com CRC; L5; W3 e W4 |
| FUX.P11 | Offline e página de erro | `web/src/routes/offline/+page.svelte`, `web/src/routes/+error.svelte`, staging, snapshots offline-* | FUX.1 e 2 | normal | meta estática ≤ 80 kB |
| FUX.T | bateria da fase | só testes | todas | normal (runner) | suítes completas, orçamentos, axe em todas as rotas, snapshots revisados |
| FUX.Q | QA adversarial em 2 rodadas (§0.5) | nenhum | FUX.T | **heavy** | PASS conforme §0.5, foco em §0.12, offline, resgate, textos literais |

## 7. Riscos

| Risco | Mitigação |
|---|---|
| L1 atrasar o aviso de resgate ou a barra | leitura síncrona do marcador, import imediato com marcador, e2e dedicado (FUX.2) |
| Chunks dinâmicos fora do cache offline | e2e offline obrigatório no FUX.2 e no FUX.T |
| Regressão visual em massa com o FUX.1 | FUX.1 serial e primeiro, regenera e revisa todos os snapshots; depois cada P só regenera os seus |
| Animação confundida com medição | lista dos movimentos com origem (real ou decorativo) na revisão de cada P, checada no QA |
| Mudança de padrão de publicação | só com OK do PO, registrado no progresso |
| Lista de apelidos bloquear nomes legítimos | lista curada e testada com casos legítimos (ex.: "assassin" dentro de "passassin" não; comparar por token e esqueleto); recusa genérica |
