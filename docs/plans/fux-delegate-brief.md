# Brief comum dos delegados da fase FUX (UI/UX)

Leia antes de qualquer tarefa da FUX, junto com `D:\git\open-auri\docs\plans\fux-spec.md` (a especificação completa: diagnóstico §1, sistema de design §2, dramaticidade §3, compreensão §4, carregamento §5, tarefas §6) e a seção "Lições" de `D:\git\open-auri\docs\plans\f3-delegate-brief.md` e `f4-delegate-brief.md`. Plano: `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-plano.md` (§0.12 invariantes, §3.3 gate, §3.4 e §3.5 texto, §3.6 medidores, §3.9 desempenho).

## Pedido do operador (literal)

"Todas as páginas, de modo geral, carecem de stunning UI/UX. Falta mais dramaticidade pro tema. Falta facilidade para UX, principalmente em páginas complexas. Falta compreensividade com a potencial falta de conhecimento do usuário ao se deparar com uma interface e assuntos complexos. Falta capricho e revisão nas fontes, estilos, cores, font sizes. Falta revisão de warm up loading onde útil e lazy loading onde pouco necessário. Codifique como um senior software engineer criativo e detalhista, preocupado em entregar uma experiência WOW para o usuário."

## Norte

Um instrumento de estúdio que explica a si mesmo. Em conflito, nesta ordem: (1) segurança e verdade dos dados; (2) clareza para leigo, com a densidade atrás de divulgação progressiva; (3) drama que nasce de material, luz e estado real, nunca de animação que finja medir.

## Fonte de verdade visual

- Mocks: `D:\git\open-auri\design\mocks\v2\*.html` (abra o HTML para valores exatos de CSS, SVG e animação) e `D:\git\open-auri\design\mocks\v2\_qa\*.png`.
- Capturas atuais: `D:\git\open-auri\web\tests\e2e\visual.spec.ts-snapshots\*.png` (retângulos magenta são máscaras do Playwright, não defeitos).
- Paridade com o mock é o piso, não o teto: onde o mock é estático e a spec §3 pede movimento ligado a estado real, implemente o movimento.

## Sistema de design v2.1 (resumo; valores completos na spec §2)

**Tipografia (§2.1).** Papéis: display `--face-display` (Instrument Serif 400, normal e itálico) para títulos, wordmark e homenageado; corpo e ação `--face-body` (Geist 400/500/600) para texto, botões e formulários; dados `--face-data` (JetBrains Mono, só 400 e 500) para números, códigos, hex, eyebrows e readouts; gravação de painel `--face-engrave` por página (Curva e Cabo `--cond`; Biblioteca `--type`; Comparar `--plate`/`--tape`; Comunidade `--marker`/`--crt`; Docs `--journal`; auth e perfil `--cond`).
Regras: **ação nunca em mono; mono nunca acima de 500; `font-synthesis: none`**; readouts com `tabular-nums slashed-zero`. Escala: `--fs-display-xl/l/m`, `--fs-title`, `--fs-lede`, `--fs-body` 15px, `--fs-ui` 14px, `--fs-small` 13, `--fs-caption` 12, `--label-min` 11 (também no mobile), `--fs-eyebrow` 11, `--fs-readout-l`, `--fs-readout` 14, `--fs-honoree`. Use as classes `.h-display-xl`, `.h-display-l`, `.h-display-m`, `.title`, `.lede`, `.eyebrow`, `.readout` (criadas no FUX.1). Nada de tamanho de fonte improvisado em px nas páginas: use os tokens.

**Cor (§2.2).** `--ink` #0f0f0e, `--ink-2` #171715, `--ink-3` #1d1c1a (painel elevado), `--ink-4` #2b2a27 (hardware escuro); `--text` #ece7dd, `--text-2` #cfc9be; `--muted` #8f8a80 **só** sobre ink e ink-2; `--muted-hi` #a39d92 sobre ink-3 e ink-4; `--rule` só decorativo; `--rule-control` (40%) em borda de controle (≥ 3:1); `--ok` #4cc38a, `--warn` #e5a23a, `--danger` #e5484d; `--lamp-off`. Texto em acento usa `--accent-text` da página (≥ 4,5:1); Cabo tem `--accent-on-metal`. Todo par novo de texto/superfície entra no teste `web/tests/unit/styles/contrast.test.ts`.

**Material (§2.3).** `--elev-1/2/3`, `--well` (LCD, readout, fenda), `--bevel`, `--glow-1/2`, `--mat-metal`, `--mat-lcd`. Grão opcional em `web/static/textures/grain.png`.

**Espaço e raio (§2.4).** `--rad-xs` a `--rad-pill`, `--rad-2xl` 16, `--rad-bezel` 20; `--space-1` a `--space-9`, `--section-gap`, `--panel-pad`; alvo de toque `--hit` (44 mobile, 36 desktop).

**Movimento (§2.5).** `--dur-instant` 80ms, `--dur-fast` .12s, `--dur-base` .2s, `--dur-slow` .36s, `--dur-scene` .72s; `--ease-out`, `--ease-in-out`, `--ease-mech` (batente). **Medidores nunca usam esses tokens** (balística real, §3.6). Decorativo só se não lembrar medidor, parar com `prefers-reduced-motion` e não rodar em loop acima da dobra. Em reduced motion: sem animação, readouts a 10 Hz.

**Componentes (§2.6).** Primitivos em `web/src/lib/components/primitives/**` e `web/src/lib/styles/components.css`: `Button` (`primary`, `plate`, `ghost`, `danger`, `key`, `lever`; sm 28, md 36, lg 44; Geist 500; hover sobe 1px com `--glow-1`; active desce com `--well`; foco anel 2px acento offset 3px; loading com `aria-busy` e largura fixa; **desabilitado sempre com motivo**: `disabledReason` → `aria-disabled="true"`, focável, motivo em tooltip e `aria-describedby`), `IconButton`, `Chip` (modo de medidor sempre AO VIVO, DADOS ou APAGADO), `Panel` (`.panel`, `.panel--hardware`, `.panel--paper`), `Field`, `Tooltip` (400 ms, abre por foco, Esc fecha, nunca é o único lugar de informação crítica), `Lamp` (só estado real), `Skeleton` (mesma geometria, CLS zero, `aria-busy`), `EmptyState` (ilustração SVG temática, título, por quê, ação, "o que é isso?"), `Menu` (menu do usuário). Use os primitivos; não recrie botões locais.

**Compreensão (§4).** Tour (`oa.tour.v1`), `Explainer` ("o que é isso?") e `GlossaryLink` de `web/src/lib/components/comprehension/**` (FUX.3); textos da §4.3 e §4.4 são os oficiais. **Sem códigos do plano na UI** (S1…S10, T…, F…): só linguagem natural; o código fica em ids, arquivos e Docs técnicos.

**Carregamento (§5).** Nada pesado no closure estático de rota que não o usa; import dinâmico para o que aparece só depois de gesto ou abaixo da dobra; pré-aquecimento em hover/foco/idle; skeletons com geometria final; medidores nunca têm skeleton animado.

## Aceite comum de toda tarefa de UI (spec §6, A1 a A8)

A1 revisão lado a lado com o mock (checklist da §1 da página fechado, capturas citadas no relatório); A2 axe sem violações sérias ou críticas (desktop e mobile, movimento padrão e reduzido); A3 orçamento da rota na meta da §5.7 e no máximo +3 kB sobre a base pós-FUX.2; A4 testes da área verdes, snapshots só da própria página; A5 reduced motion; A6 sem travessão no pt-BR, sem marcas proibidas, textos literais inalterados (teste com string exata), sem códigos do plano em títulos visíveis; A7 §0.12 (medidores APAGADO ou DADOS sem áudio; gravação só via `app.requestWrite()`); A8 nenhuma edição fora do W.

## Regras de trabalho

- **W (conjunto de escrita) é lei.** Edite só os arquivos do seu W. Arquivos da fila de integração (layout raiz quando não estiver no seu W, `web/vite.config.ts`, `package.json`, `web/messages/*.json`, `web/tests/e2e/visual.spec.ts`, migrações, templates do wrangler) só o orquestrador edita: descreva a mudança no relatório.
- **Mensagens:** só em `web/messages/_staging/<TASK>.pt-BR.json` e `<TASK>.en-US.json` (sem `$schema`; mesmas chaves nos dois). O merge recusa chaves existentes: para mudar texto de chave existente, crie chave nova e pare de usar a antiga (liste as antigas no relatório para o orquestrador apagar). pt-BR sem travessão, com "−" e vírgula decimal.
- **Testes:** escreva e atualize os testes da sua área (Vitest em `web/tests/unit/**`, Playwright em `web/tests/e2e/**` só nos specs do seu W). **Você não roda testes do web**: o orquestrador roda a verificação central e devolve as saídas (em `D:\git\open-auri\_qa\`). Se pedir execução, diga exatamente o comando.
- **Vitest 5:** `toHaveTextContent` compara o texto inteiro; use `toMatchTextContent` para trecho. `expect.poll` com 5 s.
- **Svelte 5 runes**, TypeScript estrito; sem `as any`, `@ts-ignore`, `@ts-expect-error`, `catch` vazio; sem travessão em texto de UI pt-BR.
- **Repositório público:** nenhum dado pessoal, da empresa, ID de conta ou caminho `C:\Users\…` em arquivo.
- **Nunca commitar.** Nunca `Co-Authored-By` nem "Generated with" em lugar algum.
- **Invariantes §0.12:** nenhum byte ao cabo sem gate v2 + checklist + gesto; nunca gravar automaticamente; HS, LP e HP só na Engenharia; nenhum controle inexistente no protocolo; medidores só com dado real.
- **Relatório final:** arquivos alterados, decisões, checklist A1 a A8 com evidência, mudanças pedidas para a fila de integração, chaves antigas a apagar, comandos de teste sugeridos.
