# open-auri
Open protocol for 0xCB firmware of the CB5100 chip family

open-auri é um app web aberto para ajustar a equalização do cabo DSP do fone Auri ("Cabo USB-C com
DSP") direto do navegador, por WebHID, sem instalar nada. Ele reconstrói o protocolo `0xCB` da
família de chips CB5100, mostra e deixa ouvir cada curva antes de gravar, e só grava no cabo o que
passa por um gate de segurança conservador. Em produção, o produto fica em
`https://open-auri.com`.

Pesquisa e engenharia reversa: [`docs/`](docs/README.md).

## Segurança primeiro

### O que o hardware é (e o que não sabemos)

- **Dispositivo:** chip CB5100, VID `0x3302`, PID `0x8902`, produto "USB DSP Audio".
- **Transporte:** WebHID (Chrome ou Edge no desktop, contexto HTTPS e gesto do usuário), report
  `0xCB` com reports de 31 B.
- **Só escrita:** não há leitura de volta. O app não sabe qual curva está no cabo; sabe só o que ele
  mesmo gravou (diário local).
- **Flash com vida útil desconhecida:** cada gravação vai para a memória do cabo. O app espaça as
  gravações (uma a cada 2 s), conta quantas foram feitas e avisa a partir de 50 por dia.
- **Processamento:** uma curva para os dois canais, DSP a 96 kHz, payload de 220 B com 10 biquads
  em Q27, pré-amp em Q23 e CRC16. Detalhes em [`docs/protocol-0xcb.md`](docs/protocol-0xcb.md) e
  [`docs/hardware.md`](docs/hardware.md).

### O gate v2 ("envelope observado")

Nenhuma curva é gravada no cabo nem publicada sem passar no gate v2, avaliado nos valores Q27 e Q23
que vão de fato no fio: limite de cada coeficiente por posição, raio dos polos, pico de cada seção
isolada, pico de cada prefixo com pré-amp, pico de saída e pré-amp nominal entre −25,5 e −0,5 dB. O
gate roda no navegador antes de gravar e de novo no servidor antes de publicar, com os mesmos
códigos de motivo. Ao arrastar um controle, o editor para na fronteira do gate e explica o motivo.

> O gate é uma política de semelhança com o que os 11 presets oficiais já fazem o chip calcular,
> não uma prova de segurança do hardware.

### Nada é gravado sozinho

- O app nunca grava no cabo sem um clique em "Gravar no cabo" e a passagem pelo checklist
  do cabo, e só com a curva aprovada no gate.
- O aviso de loudness aparece quando a nova curva pode soar 3 dB ou mais acima da anterior, ou
  quando o estado do cabo é desconhecido.
- "Neutro" (10 filtros desligados e pré-amp de −0,5 dB) fica sempre a um clique para resgatar o
  cabo. O diário local guarda o que foi gravado.
- Tipos que a página oficial nunca gravou (HS, LP e HP) ficam só na camada Engenharia, como
  experimentais, com confirmação extra. Biquad cru, gravação no cabo durante o teste cego e leitura
  do cabo estão marcados como EM BREVE até a validação em hardware.

## Páginas

| Rota | Página | O que faz |
|---|---|---|
| `/` | Curva | Editor em três camadas (Ouvir, Ajustar, Engenharia), macros Grave/Corpo/Presença/Brilho, prévia exata e gravação no cabo. |
| `/biblioteca` | Biblioteca | Presets oficiais, Neutro, biblioteca local e da conta, com medidores reais. |
| `/comparar` | Comparar | Várias curvas lado a lado, com troca por nível igualado. |
| `/soe-como-x` | Soe como X | Ajuste paramétrico para soar como uma medição ou um alvo (dados do AutoEq embutidos). |
| `/comunidade` | Comunidade | Feed, rankings, curvas publicadas, "Comunidade prefere" e troca às cegas. |
| `/teste-cego` | Teste cego | Comparação cega no navegador com o seu próprio arquivo de áudio. |
| `/cabo` | Cabo | Conexão WebHID, checklist, diário de gravações e vários cabos em sequência. |
| `/docs` | Docs | Documentação de uso, protocolo, gate, dados neste navegador. |
| `/c/[id]` | Curva compartilhada | Página pública de uma curva, com imagem OG e QR. |
| `/u/[apelido]` | Perfil público | Apelido, contagens e, se o usuário quiser, a biblioteca pública. |
| `/entrar`, `/criar-conta`, `/conta/**` | Conta | Login opcional por e-mail e senha, sessões, exportação de dados e encerramento. |
| `/privacidade`, `/termos` | Páginas legais | Política de privacidade e termos de uso. |

O áudio carregado na barra superior fica no navegador (IndexedDB) e nunca é enviado. O site
funciona inteiro sem conta e offline (PWA); a conta só é necessária para a parte social.

## Desenvolvimento local

Requisitos: Node 24 (o mínimo aceito pelo `engines` é 22.12) e npm. O repositório é um workspace
npm com o núcleo na raiz (`src/`), o app web em `web/` e o Worker de jobs em `workers/jobs/`.

```pwsh
npm ci
Copy-Item .env.example .env   # preencha os valores; o .env nunca entra no repositório
npm run -w web dev            # gera web/wrangler.jsonc a partir do template e sobe o Vite
```

- `npm run -w web dev-vars` gera o `web/.dev.vars` local a partir do `.env`.
- `npm run build:web` faz o build de produção do app (gera o `wrangler.jsonc` antes).
- Os `wrangler.jsonc` são gerados por `tools/render-wrangler.mjs` a partir dos templates
  versionados e ficam fora do git.
- Para os fluxos de conta locais, `npm run -w web preview:auth-flow` (depois do build) sobe o
  Worker com cadastro ligado e a caixa de e-mail capturada em D1.

## Testes

| Camada | Comando |
|---|---|
| Núcleo (`src/`, `node --test`) | `npm test` |
| Núcleo com cobertura (≥ 95% de linhas, branches e funções) | `npm run test:coverage` |
| Ferramentas do operador (`tools/*.mjs`) | `npm run test:tools` |
| Web: unidade e componentes (Vitest, Chromium real) | `npm run test:web:unit` |
| Web: integração em workerd com D1 local | `npm run test:web:int` |
| Web: e2e (Playwright) | `npm run test:web:e2e` |
| Worker de jobs | `npm run -w workers/jobs test` e `npm run -w workers/jobs check` |
| Lint, tipos e svelte-check | `npm run check:all` |
| Formatação | `npm run format:check` |
| Dados sensíveis no repositório | `npm run check:sensitive` |

Não rode `test:web:unit` em paralelo com `test:web:int` ou com o build. A verificação dos bytes
contra a implementação de referência está descrita em [`docs/verification.md`](docs/verification.md).

## Deploy e operação

- Deploy (staging e produção): [`docs/deploy.md`](docs/deploy.md).
- Operação e runbooks: [`docs/operacao.md`](docs/operacao.md).
- Segurança e modelo de ameaças: [`docs/seguranca.md`](docs/seguranca.md).
- Registro LGPD das operações de tratamento: [`docs/lgpd.md`](docs/lgpd.md).
- API pública: [`docs/api.md`](docs/api.md).

## Contribuir

Leia [`CONTRIBUTING.md`](CONTRIBUTING.md) antes de abrir um PR.

## Licença

Código sob [AGPL-3.0](LICENSE). Avisos de terceiros (AutoEq, fontes e demais dependências) em
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) e lista completa de pacotes distribuídos em
[`/third-party-licenses.txt`](web/static/third-party-licenses.txt), gerada após o build com
`npm run notices`. A lista vem dos sourcemaps do cliente e do servidor/Worker, não das marcas
`devDependencies`: runtimes como Svelte, SvelteKit e Paraglide também entram nos bundles.
Dados do AutoEq embutidos e processo de remoção
a pedido em [`docs/autoeq-data.md`](docs/autoeq-data.md). Os presets e descrições da Kuba aparecem
com "licença: a confirmar". As curvas publicadas pelos usuários ficam sob a licença escolhida por
eles (CC0 1.0 ou CC BY 4.0).

## App Android

O app `open-auri` (`com.openauri.app`) abre o mesmo site em uma WebView e acrescenta o transporte
USB nativo para gravar no cabo CB5100. O Chrome Android não oferece WebHID; o app mantém o gate,
o checklist e o diário do site, sem gravação automática.

- **Google Play, quando público:** https://play.google.com/store/apps/details?id=com.openauri.app
- **APK no GitHub Releases:** https://github.com/marco-jardim/open-auri/releases/latest
- **Certificado do app (SHA-256):**
  `FB:46:E3:4F:03:FD:6F:59:5B:4B:70:36:74:8F:92:83:08:FA:BF:31:C1:55:BF:E2:C5:0E:B1:B4:43:FF:61:D0`
- **Requisitos:** Android 8.0 ou superior, Android System WebView atualizado, aparelho com USB
  host (OTG), conexão USB-C/OTG de dados e cabo Auri compatível (VID `0x3302`, PID `0x8902`).
  Cada gravação pelo app confirma com o servidor que a página é a do deploy atual. Após um
  deploy, use **Recarregar** se o app pedir. Se a confirmação falhar (sem conexão ou servidor
  indisponível), o app só grava com a última confirmação do servidor para esta mesma versão da
  página (e avisa a data dela); sem nenhuma confirmação, ou depois de ver um deploy mais novo
  ou a gravação desligada, recusa a gravação nativa.

Para verificar um APK baixado, compare o SHA-256 do arquivo com a entrada correspondente no
`SHA256SUMS.txt` da mesma release. Depois execute `apksigner verify --print-certs` e compare o
fingerprint SHA-256 do certificado com o publicado pelo projeto, não com o hash do APK:

```pwsh
$apk = Read-Host 'Caminho do APK baixado'
Get-FileHash -Algorithm SHA256 -LiteralPath $apk
apksigner verify --print-certs $apk
```

O `apksigner` faz parte do Android SDK Build-Tools e precisa estar no `PATH`. Se a verificação
falhar ou um dos valores divergir, não instale. A distribuição prevê a mesma chave de assinatura
na Play e no GitHub, para permitir atualização entre fontes; confira o certificado publicado
antes de trocar. Instruções técnicas e estado de validação em
[`D:\git\open-auri\docs\android.md`](docs/android.md).

> Aviso: a gravação pelo app ainda não foi testada num cabo Auri real. O app usa o mesmo protocolo e envia os mesmos bytes que o site no computador (conferido por testes automáticos); em teoria o resultado é o mesmo, mas não há garantia. Relate o resultado em https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml

## Aviso legal

open-auri não é oficial nem endossado pela Kuba, pela TTGK, pela Savitech ou por qualquer fabricante. Tudo aqui foi obtido por estudo do protocolo para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição.

Os nomes de pessoas homenageadas nas páginas aparecem só como texto, sem uso de marcas.
