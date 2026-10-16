# Brief comum dos delegados da Fase 2 (web)

Leia antes de qualquer tarefa da F2. Plano: `D:\git\open-auri\docs\plans\2026-10-15-open-auri-web-plano.md` (§3, §4.3, §6 e a tarefa citada no despacho).

## Stack instalado (não instalar nada; peça no relatório se faltar)

- SvelteKit **3.1.0** (Svelte 5.57 com runes), Vite 8, `@sveltejs/adapter-cloudflare` 8, Tailwind 4 (`@tailwindcss/vite`), Paraglide JS 2.29, Vitest 5 (projetos `unit`, `component` em Chromium real via `@vitest/browser-playwright` + `vitest-browser-svelte`, `integration`), Playwright 1.64 (projetos `desktop` 1440 e `mobile` 390), `@axe-core/playwright`, `fake-indexeddb`, TypeScript 6 (web e núcleo).
- Fontes: pacotes Fontsource instalados em `web/node_modules/@fontsource*/` (Instrument Serif, Geist variável, JetBrains Mono, Courier Prime, Barlow Condensed, Oswald, Special Elite, EB Garamond, Permanent Marker, VT323).

## Regras do SvelteKit 3 (diferem do Kit 2)

- Não existe `svelte.config.js`: a configuração está em `D:\git\open-auri\web\vite.config.ts` (arquivo serializado; só a fila de integração edita).
- `$lib` foi substituído por `#lib` (com extensão explícita: `import x from '#lib/state/curve.svelte.ts'`).
- `$app/environment` virou `$app/env`; use `$app/state` (não `$app/stores`); env público via `$app/env/public` (helper em `#lib/config/public.ts`).
- Tipos de hooks em `@sveltejs/kit/hooks`; `event.request` é somente leitura.

## Núcleo

- Importe do pacote `open-auri` por área: `open-auri/safety`, `open-auri/dsp`, `open-auri/share`, `open-auri/io`, `open-auri/solver`, `open-auri/catalog`, `open-auri/transport`, `open-auri/policy`, `open-auri/meter`. Nunca duplique matemática do núcleo.
- Gravação no cabo: só `writeCurve`/`writeMany` de `open-auri/transport`, que já aplicam `gateForWrite` sobre um snapshot. A UI acrescenta checklist + gesto explícito; nunca grava automaticamente.
- O gate devolve `reasons: [{code, stage?, value?, limit?}]`; as mensagens pt-BR/en-US ficam na UI.

## i18n

- Mensagens: só nos arquivos de staging da tarefa, `D:\git\open-auri\web\messages\_staging\<TASK-ID>.pt-BR.json` e `…\<TASK-ID>.en-US.json`, chaves com o prefixo da feature, mesmas chaves nos dois. O orquestrador mescla.
- Uso: `import { m } from '#lib/paraglide/messages.js'` (gerado após a mescla; nos testes, componha com as chaves que você criou).
- pt-BR sem travessão (—), sinal de menos real "−", vírgula decimal; en-US com ponto. Sem "Honest note:" e sem "Just X. Just Y.".
- Marcas proibidas como branding (plano §3.4). Homenageados só em texto.

## Qualidade

- TypeScript estrito; sem `any`, `as any`, `@ts-ignore`, `@ts-expect-error`; sem `catch` vazio; sem TODO (exceto IDs da §13).
- Prettier do web: tabs, aspas simples, largura 100 (`web/prettier.config.js`).
- Acessibilidade WCAG 2.2 AA: foco visível, teclado, `aria` em gráficos, `prefers-reduced-motion`.
- Medidores só com dado real (áudio ao vivo ou dados da curva). Nunca animação decorativa.

## Testes e verificação

- Unidade: `web/tests/unit/<área>/**/*.test.ts` (node) e `*.svelte.test.ts` (componentes, Chromium real).
- Você só consegue rodar `npm test`, `npm run lint` e `npm run typecheck` da raiz pelo `router_run`. A verificação do web (`check:web`, `test:web:unit`, build, e2e, lint do web, cobertura) é feita centralmente pelo orquestrador depois da wave. Escreva os testes e diga no relatório o que não pôde rodar.
- Nunca edite fora do seu conjunto de escrita (W). Se precisar, pare e reporte.
- Nunca commite. Nunca adicione `Co-Authored-By` nem "Generated with".

## Páginas (W2.4)

- **Fonte de verdade:** o mock da página em `D:\git\open-auri\design\mocks\v2\<página>.html` e as capturas em `design\mocks\v2\_qa\`. Porte definitivo em Svelte 5 + TS, fiel ao visual (desktop 1440 e mobile 390), sem duplicar matemática do núcleo.
- **O layout já cuida** de barra superior, rodapé com homenagem, `data-page`, áudio, checklist e toasts. A página só renderiza o conteúdo principal.
- **Contexto do app:** `const context = getAppContext()` (de `#lib/app/index.ts`, na inicialização do componente); `const app = $derived(context.client)` (é `null` no SSR e antes do mount). Use `app.state` (curve, journal, flash, meterRef, library, outbox), `app.audio` (engine: `buildChain`, `createAB`, `start`/`stop` só em gesto do usuário, `getChainOutput`), `app.cableState`, `app.cable` (status e conexão). Para gravar, só `app.requestWrite()`, que abre o checklist. Nunca chame `write()` nem `createGesture()`. Leia `D:\git\open-auri\web\src\lib\app\README.md`.
- **Reuso:** gráficos (`#lib/charts/index.ts`), workers (`#lib/workers/...`: `createGateWorker`, `createSolverWorker`), medidores (`#lib/components/meters/index.ts` + `#lib/audio/meters.ts`: `tap`, `tapStages`, `subscribe`; modo AO VIVO/DADOS sempre rotulado; sem dado, apagado), chrome (`EmBreve`, `ConfirmDialog`, `toast`), cabo (`#lib/components/cable/index.ts`), dados AutoEq (`#lib/data/autoeq.ts`).
- **Escopo:** rota em `web/src/routes/<rota>/` (ou `+page.svelte` na raiz para a Curva), componentes em `web/src/lib/components/pages/<página>/`, testes em `web/tests/unit/pages/<página>/`, mensagens em `web/messages/_staging/<TASK>.*.json` com prefixo da página. Não edite nada compartilhado (layout, chrome, state, audio, cable, charts, workers, styles); se precisar, descreva a mudança no relatório.
- **Rótulos dos presets:** de `open-auri/catalog` (`label`, `description` com "descrição da Kuba", `licenseStatus: 'a confirmar'`).
- **Componentes que importam `$app/*`** não rodam em teste de componente isolado; passe dados por prop.
