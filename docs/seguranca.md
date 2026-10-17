# Segurança do open-auri web

Modelo de ameaças, mitigações e verificações da aplicação web (`web/`) e do Worker de jobs (`workers/jobs/`). Complementa o §3.8 do plano e os runbooks de `docs/operacao/runbooks/`. Nenhum ID, domínio de e-mail ou valor do `.env` aparece aqui.

## 1. Ativos

| Ativo                                  | Onde vive                                       | Por que importa                                              |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Contas (e-mail, senha com hash, TOTP)  | D1 (Better Auth)                                | Tomada de conta, vazamento de dados pessoais (LGPD)          |
| Sessões e cookies                      | D1 + cookie `HttpOnly`, `Secure`, `SameSite`    | Sequestro de sessão                                          |
| Curvas, pacotes e perfis públicos      | D1, imagens OG geradas sob demanda              | Integridade do conteúdo social, moderação                    |
| Registro de acesso (Marco Civil)       | Fila e R2 (`access-log/`), cifrado              | IP e horário de acesso: dado pessoal com dever de guarda     |
| Sais diários e pimenta de IP           | KV `CONFIG` (`salt:*`) e segredo do Worker      | Permitiriam reverter os hashes de IP dos limites             |
| Segredos do Worker                     | `wrangler secret` (nunca no repositório)        | Chaves de auth, Turnstile, Resend, chaveiro do access log    |
| Dispositivo de áudio do usuário (cabo) | Navegador, via WebHID                           | Escrita indevida no hardware                                 |
| Chave do modo somente leitura          | KV `CONFIG`, `mode:read-only`                   | Interruptor de emergência                                    |

## 2. Atores

- **Visitante anônimo:** usa as ferramentas locais (curva, biblioteca, comparar, cabo) e lê páginas públicas.
- **Usuário autenticado:** publica curvas, pacotes e votos; gere a própria conta.
- **Administrador:** modera, liga o modo somente leitura; exige segundo fator (`ADMIN_2FA_REQUIRED`).
- **Atacante remoto:** sem credenciais, tenta XSS, CSRF, enumeração, força bruta, abuso de API e de recursos.
- **Página de terceiros:** tenta enquadrar o site (clickjacking) ou ler respostas entre origens.
- **Cadeia de suprimentos:** dependência npm comprometida ou com licença incompatível.

## 3. Fronteiras de confiança

1. Navegador ↔ Worker web (HTTPS, cabeçalhos de §5, CSP).
2. Worker web ↔ D1, KV, R2, filas (bindings; nada exposto fora do Worker).
3. Worker web ↔ serviços externos: Turnstile (siteverify), Resend (envio e webhook assinado).
4. Página ↔ dispositivo HID (permissão explícita do usuário, `hid=(self)` no Permissions-Policy).
5. Worker de jobs ↔ fila do access log e R2 (só mensagens já cifradas atravessam a fila).
6. Operador ↔ conta Cloudflare (wrangler com OAuth local; segredos só em variável de processo).

## 4. Ameaças por superfície (STRIDE)

S = falsificação, T = adulteração, R = repúdio, I = divulgação, D = negação de serviço, E = elevação de privilégio.

| Superfície | Ameaça | STRIDE | Mitigação | Referência |
| --- | --- | --- | --- | --- |
| Cabo (WebHID) | Página enquadrada ou script de terceiros envia relatórios HID | T, E | `hid=(self)` (frames nunca recebem a permissão), `frame-ancestors 'none'` + `X-Frame-Options: DENY`, CSP sem script inline nem origem externa além do Turnstile; o navegador exige gesto e escolha do dispositivo | `web/src/lib/server/security/headers.ts`, `web/vite.config.ts` (bloco `csp`) |
| Cabo (WebHID) | Valores fora da faixa gravados no aparelho | T | Validação e limites no código do cabo antes de cada escrita | `web/src/lib/components/pages/cabo/` |
| Auth | Força bruta e preenchimento de credenciais | S, D | Limites em D1 por IP com hash, por identificador e por usuário; Turnstile antes de contar regras de terceiros (sem bloqueio de conta por terceiros) | `web/src/lib/server/security/auth-guard.ts`, `ratelimit.ts`, `README.md` da pasta |
| Auth | Enumeração de contas | I | Mesma resposta para endereço existente e inexistente; chaves de limite pelo texto digitado | `web/src/lib/server/security/README.md` (decisões Q3) |
| Auth | Sequestro de sessão por XSS | S, E | CSP estrita com nonce ou hash (§6), cookies `HttpOnly`, texto de usuário nunca renderizado como HTML | `web/vite.config.ts`, `web/src/lib/server/account/profile.ts` |
| Auth | CSRF em formulários e API | T | Verificação de origem do SvelteKit, `form-action 'self'`, `SameSite` nos cookies | `web/vite.config.ts` |
| API social | Conteúdo hostil (HTML, JS, URLs) em nomes e descrições | T, E | Texto guardado e devolvido como dado (JSON), nunca como marcação; URLs recusadas; apelidos com confusíveis recusados | `web/tests/integration/phase4/protections.test.ts` |
| API social | Abuso de escrita e spam | D | Cotas diárias por usuário, limites por rota, moderação no /admin | `web/src/lib/server/social/` |
| OG | Geração de imagem cara usada como amplificador | D | Rotas OG só leem (passam no modo somente leitura); cache; WASM do resvg roda no Worker (CSP do navegador não se aplica) | `web/tests/integration/phase4/protections.test.ts` |
| OG | Leitura entre origens de imagens | I | Só OG usa `Cross-Origin-Resource-Policy: cross-origin`; todo o resto é `same-origin` | `headers.ts` (`crossOriginResourcePolicy`) |
| Jobs | Mensagem da fila lida ou adulterada | I, T | Registro cifrado antes de entrar na fila (HKDF, chave por `kid`, AAD com a chave do objeto); a DLQ nunca tem IP em claro | `web/src/lib/server/security/access-log.ts`, `workers/jobs/src/jobs/access-log-crypto.js` |
| Jobs | Hashes de IP revertidos com o tempo | I | Sal diário rotacionado; sais com mais de um dia apagados | `workers/jobs/src/jobs/` (`rotate-salt`) |
| Admin | Ação administrativa sem autoria | R, E | Toda ação passa por `audited` (auditoria antes do efeito); segundo fator obrigatório | `web/src/lib/server/admin/audit.ts`, `read-only.ts` |
| Admin | Página do admin enquadrada | T | `frame-ancestors 'none'` em toda resposta HTML | `headers.ts` |
| Logs | Dado pessoal em log | I | Logs só com códigos e contagens; IP só no access log cifrado | `web/src/lib/server/security/README.md` |
| Logs | Segredo ou dado do `.env` versionado | I | `tools/check-sensitive.mjs` antes de cada commit (§9) | `tools/check-sensitive.mjs` |
| Todas | Incidente em andamento (abuso, falha de dados) | D, T | Modo somente leitura (§7) | `web/src/lib/server/admin/read-only.ts` |

## 5. Cabeçalhos

Aplicados a toda resposta do Worker por `applySecurityHeaders` (`web/src/hooks.server.ts`) e a todo arquivo servido direto pelo Workers Static Assets por `web/_headers`, gerado de `renderStaticHeadersFile()` (um teste unitário compara os dois).

| Cabeçalho | Valor | Motivo |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Dois anos; só enviado quando a origem é https |
| `Content-Security-Policy` | §6 | XSS e enquadramento |
| `X-Frame-Options` | `DENY` | Enquadramento em navegadores sem `frame-ancestors` |
| `Permissions-Policy` | `hid=(self)`, `autoplay=(self)`, `clipboard-write=(self)`; todo o resto `()` | Só o que a aplicação usa, só para a própria origem. Câmera e microfone desligados: o áudio vem de arquivos escolhidos pelo usuário, nunca de `getUserMedia`. `fullscreen` desligado: nenhuma tela o usa |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isola a janela de popups de outras origens |
| `Cross-Origin-Resource-Policy` | `same-origin` (OG: `cross-origin`) | Impede leitura das respostas por outras origens |
| `X-Content-Type-Options` | `nosniff` | Sem adivinhação de tipo |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Caminhos e parâmetros não vazam para terceiros |

Respostas que não são HTML recebem `default-src 'none'; frame-ancestors 'none'; base-uri 'none'`. Scripts JavaScript não recebem CSP do Worker (um worker dedicado usa a CSP da própria resposta).

## 6. Política de conteúdo (CSP)

Definida no bloco `csp` de `web/vite.config.ts`, modo `auto`: respostas SSR recebem o cabeçalho com nonce por requisição; páginas pré-renderizadas recebem uma `<meta>` com hashes sha256 dos scripts e estilos inline do Kit.

```
default-src 'none'
script-src 'self' https://challenges.cloudflare.com   (+ nonce ou hashes do Kit)
style-src 'self'                                       (+ nonce ou hashes do Kit)
style-src-attr 'unsafe-inline'
img-src 'self' data: blob:
font-src 'self'
connect-src 'self'
media-src 'self' blob:
worker-src 'self'
frame-src https://challenges.cloudflare.com
manifest-src 'self'
object-src 'none'
base-uri 'self'
form-action 'self'
frame-ancestors 'none'
```

Decisões:

- **Sem `'unsafe-inline'` em `script-src` nem em `style-src`.** O Kit põe nonce ou hash nos próprios scripts e estilos. O `lang-boot.js` de `web/src/app.html` é arquivo externo de propósito.
- **`style-src-attr 'unsafe-inline'` é a única exceção, e é inevitável.** Atributos `style=""` chegam como marcação em três lugares: o invólucro `<div style="display: contents">` do `app.html`, as diretivas `style:` e `style={...}` dos componentes Svelte (renderizadas no SSR e recriadas por `innerHTML` de template na hidratação) e o anunciador de rotas do Kit. Nonce e hash não cobrem atributos. O risco é pequeno: um atributo de estilo não carrega script, não tem seletores (sem exfiltração por seletor de atributo) e qualquer `url()` continua presa a `img-src` e `font-src`. Elementos `<style>` injetados continuam bloqueados (o teste e2e confere). Em desenvolvimento o próprio Kit acrescenta `'unsafe-inline'` a `style-src` porque o Vite injeta `<style>`; isso não vai para o build.
- **`default-src 'none'`.** Tudo o que a página carrega tem diretiva própria; o que não tem (por exemplo `child-src` sem frames nem workers, `fenced-frame-src`) fica fechado.
- **Workers e AudioWorklet.** `solver.worker.ts` e `gate.worker.ts` são criados com `new Worker(new URL(..., import.meta.url))` e o processador dos medidores vem de `meter-processor.js?worker&url` para `audioWorklet.addModule` (`web/src/lib/audio/meters.ts`): todos são arquivos da própria origem. `worker-src 'self'` (o `blob:` anterior saiu: nenhum worker é criado de blob). O módulo do AudioWorklet é regido por `script-src`, que já tem `'self'`.
- **`blob:` e `data:` só onde há uso.** `img-src data:` para os QR codes em SVG (`TwoFactorForm`, `SharePanel`, `TrackSheet`), a exportação em `CompararPage` e o ruído de `comparar.css`; `img-src blob:` para a rasterização da ficha (`sheet-export.ts`); `media-src blob:` para tocar arquivos locais (`web/src/lib/audio/engine.ts`).
- **Turnstile.** `script-src` e `frame-src` com `https://challenges.cloudflare.com`, como pede a documentação da Cloudflare. O script é carregado por `Turnstile.svelte` com um elemento `<script src>` (lista de hosts; o nonce não é necessário porque não usamos `'strict-dynamic'`).
- **Páginas pré-renderizadas.** A `<meta>` vale só a partir do ponto em que é lida e não aceita `frame-ancestors`. Por isso `web/_headers` envia uma segunda política (`STATIC_DOCUMENT_CSP` em `headers.ts`) com todas as diretivas que não dependem de hash: `frame-ancestors`, `object-src`, `base-uri`, `form-action`, `img-src`, `font-src`, `connect-src`, `media-src`, `worker-src`, `frame-src`, `manifest-src`. Ela não tem `default-src`, `script-src` nem `style-src*`, que bloqueariam os scripts inline com hash (todas as políticas aplicadas precisam permitir um recurso). Um teste unitário compara essa lista com o bloco do `vite.config.ts`. O mesmo cabeçalho chega aos arquivos de `/_app`, onde vira a política dos workers dedicados: eles só calculam, então cabe.
- **Fora, por ora:**
  - `upgrade-insecure-requests`: a aplicação só referencia a própria origem por caminho relativo e o HSTS já força https em produção; a diretiva quebraria o preview local em `http://localhost`.
  - `require-trusted-types-for 'script'`: o runtime do Svelte 5 e do Kit cria DOM por `innerHTML` de template sem política Trusted Types registrada; ligar a diretiva quebraria a hidratação. Reavaliar quando o Svelte publicar suporte.
  - `report-to`: não há coletor de relatórios; as violações são cobertas pelo teste e2e.

Verificação: `web/tests/unit/server/security/headers.test.ts` (política lida do `vite.config.ts`, sincronia com `web/_headers`) e `web/tests/e2e/csp.spec.ts`, que abre cada rota (as da Fase 2, `/comunidade`, as páginas de auth, `/conta`, `/conta/encerrada`, `/admin` e páginas de erro de `/c/[id]` e `/u/[apelido]`) e exige zero eventos `securitypolicyviolation` e zero mensagens de CSP no console, além de provar que um `<script>` e um `<style>` injetados são bloqueados. O widget real do Turnstile não roda no e2e (sem rede de terceiros); conferir em staging, numa página de auth, o console sem recusa de CSP.

Efeito em testes: ferramentas que injetam `<style>` na página (o `stylePath` e o `addStyleTag` do Playwright) são bloqueadas pela política, como qualquer estilo injetado. Especificações que dependem disso (as capturas visuais forçam `content-visibility: visible` por `stylePath`) usam `bypassCSP: true` no contexto; a CSP em si é verificada só pelo `csp.spec.ts`, que roda sem esse desvio. A política de produção não ganha exceção por causa de teste.

## 7. Interruptor de emergência: modo somente leitura

Chave `mode:read-only` no KV `CONFIG` (`web/src/lib/server/admin/read-only.ts:27`). Valor `1` liga; chave ausente desliga. Com o modo ligado, `enforceWritable` (`read-only.ts:218`) responde 503 `READ_ONLY` a toda escrita fora da lista permitida (entrar, segundo fator, sair, exportação LGPD e o /admin) e aos dois links GET do Better Auth que mudam estado; navegações recebem uma página HTML estática com CSP própria. Cache de até 10 s por isolate; o KV pode levar cerca de 60 s para propagar.

Como ligar e desligar:

1. Pelo painel: `/admin`, com sessão de administrador e segundo fator; fica auditado.
2. Pelo wrangler, a partir de `web/` com o `wrangler.jsonc` gerado (o operador já autenticado):
   - ligar: `npx wrangler kv key put --binding CONFIG "mode:read-only" 1 --remote`
   - desligar: `npx wrangler kv key delete --binding CONFIG "mode:read-only" --remote`
   - staging: acrescentar `--env staging` (ou o ambiente equivalente do template).

O caminho pelo wrangler não deixa registro de auditoria: anotar no relato do incidente (`docs/operacao/runbooks/incidente.md`). Passo a passo completo em `docs/operacao/runbooks/somente-leitura.md`.

Testado em:

- `web/tests/integration/admin/read-only.test.ts`: leitura e cache (`isReadOnly`), liga e desliga com auditoria (`setReadOnly`), bloqueio de escritas, lista permitida exata, links GET bloqueados, página HTML com `READ_ONLY_HTML_CSP`.
- `web/tests/integration/phase4/protections.test.ts:49`: com a chave valendo `1`, toda escrita de toda rota `/api/v1` responde 503 `READ_ONLY` e toda leitura passa (incluindo OG, `/c/[id]` e `/u/[apelido]`).

## 8. Dependências e licenças

O projeto é AGPL-3.0. Os campos `license` e marcas `dev`/`devOptional` do `package-lock.json` da raiz (workspaces `web` e `workers/jobs`; não há lockfile separado) descrevem a instalação, não o conteúdo distribuído. Nenhuma consulta de rede foi feita.

Pacotes que entram no bundle do Worker ou do cliente incluem dependências de produção e runtimes declarados em `devDependencies`, como `svelte`, `@sveltejs/kit` e `@inlang/paraglide-js`. A lista é extraída dos `sources` dos sourcemaps de todos os chunks em `web/.svelte-kit/output/**/*.map` por `npm run notices`, após o build, incluindo o runtime gerado do Paraglide. O gerador também lê imports externos do JS emitido, que o Wrangler incorpora depois, e inclui conservadoramente suas dependências de produção (inclusive WASM do resvg). Nomes, versões instaladas, identificadores e textos completos das licenças ficam em `web/static/third-party-licenses.txt`, servido em `/third-party-licenses.txt`; avisos adicionais em [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

Principais dependências de produção e runtimes distribuídos (a tabela não substitui a lista gerada):

| Pacote | Origem | Licença | Compatível com AGPL-3.0 |
| --- | --- | --- | --- |
| `@cf-wasm/resvg` | direta (web) | MPL-2.0 | Sim (MPL-2.0 §3.3, licenças secundárias GNU) |
| `@resvg/resvg-wasm` 2.6.2 e 2.4.1 (alias `-legacy`) | via `@cf-wasm/resvg` | MPL-2.0 | Sim |
| `better-auth` e `@better-auth/*`, `@better-fetch/fetch`, `better-call` | direta (web) e transitivas | MIT | Sim |
| `zod` | direta (web) | MIT | Sim |
| `uqr` | direta (web) | MIT | Sim |
| `svelte`, `@sveltejs/kit`, runtime de `@inlang/paraglide-js` | diretas (web, `devDependencies`) | MIT | Sim |
| Demais transitivas de produção (`jose`, `kysely`, `@noble/*`, `nanostores`, `defu`, `rou3` e outras) | transitivas | MIT, ISC, Apache-2.0 ou BSD | Sim |

`workers/jobs` não tem dependência de produção (só ferramentas de desenvolvimento). A raiz também não.

Outras licenças encontradas em pacotes marcados como de desenvolvimento no lockfile estão abaixo. Essa marca não prova ausência no bundle; a conferência de distribuição deve usar os sourcemaps e também os assets copiados.

| Licença | Pacotes | Marca no lockfile |
| --- | --- | --- |
| MPL-2.0 | `axe-core`, `@axe-core/playwright`, `lightningcss` e binários por plataforma | `dev` / `devOptional` |
| LGPL-3.0-or-later e `Apache-2.0 AND LGPL-3.0-or-later` | `@img/sharp-libvips-*`, `@img/sharp-*` (opcionais do wrangler) | `dev` |
| CC-BY-4.0 | dados do `caniuse-lite` | `dev` |
| BlueOak-1.0.0 | `minimatch` | `dev` |
| 0BSD | `tslib` | `dev`, opcional |
| `(MIT OR CC0-1.0)` | `type-fest` | `devOptional` |
| `MIT OR Apache-2.0` | `wrangler`, `@cloudflare/*` | `dev` |

Nenhuma licença incompatível com AGPL-3.0 identificada nessa revisão. As fontes `@fontsource*` ficam em `devDependencies`, mas seus arquivos são copiados para o build e servidos ao navegador, com OFL-1.1 ou Apache-2.0 conforme a família (avisos em `web/static/fonts/`). Os TTF usados nas imagens Open Graph também são distribuídos, sob OFL-1.1, com avisos e links ao texto em `web/static/og-font/LICENSE-OFL.txt`. A OFL-1.1 permite redistribuir fontes junto de software sob qualquer licença, desde que a própria fonte continue sob OFL e o aviso a acompanhe.

Vulnerabilidades: a revisão desta tarefa não usa rede. O orquestrador roda `npm audit --omit=dev` na raiz antes do deploy e registra o resultado no relatório da fase; achados em dependência de produção bloqueiam o deploy até correção ou justificativa escrita.

## 9. Varredura de segredos

- `node tools/check-sensitive.mjs` (`npm run check:sensitive`) procura no conteúdo versionável os valores do `.env` e derivados e formatos conhecidos de credencial (chaves do Resend e do Turnstile, tokens do GitHub, chaves AWS, chaves privadas PEM, caminhos de perfil do Windows). Só imprime caminho, linha e rótulo, nunca o valor. Testes em `test/tools/check-sensitive.test.mjs`.
- Obrigatório antes de cada commit (`CONTRIBUTING.md`) e depois de qualquer limpeza de incidente.
- Sem `.env` (CI), o modo `--no-env` roda só os formatos genéricos.
- Segredos do Worker só por `wrangler secret` ou `tools/sync-secrets.mjs`; `wrangler.jsonc` é gerado de template e não é versionado com IDs.
