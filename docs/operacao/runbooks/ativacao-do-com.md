# Runbook: ativação do `.com`

## Quando usar

Uma vez, para levar a produção do `workers.dev` para `https://open-auri.com` e abrir o cadastro
público. Staging continua no `workers.dev`. Executável pelo agente com o login OAuth do wrangler,
exceto os registros DNS do domínio de envio (passo 5, **bloqueado**, ver abaixo).

## Estado

| Passo | Estado |
|---|---|
| 1. Zona do domínio na conta | **Feito:** zona ativa na mesma conta de `CLOUDFLARE_ACCOUNT_ID`. |
| 2. Domínio customizado do Worker + 301 do `workers.dev` | A fazer (depende do pré-requisito de código B). |
| 3. `PUBLIC_ORIGIN` novo | A fazer. |
| 4. Domínios do widget Turnstile | A fazer (API, coberto pelo OAuth). |
| 5. Domínio de envio no Resend + registros DNS | **Bloqueado:** o OAuth do wrangler lê a zona, mas não escreve DNS. Opções na issue #32. |
| 6. Verificação do domínio de envio | Depende do 5. |
| 7. `RESEND_FROM` novo | Depende do 6. |
| 8. `SIGNUP_ENABLED=true` | Depende do 7. Até lá, produção fica com o cadastro fechado e o remetente de teste. |
| 9. Novo deploy e smoke | Duas vezes: fase A (domínio) e fase B (e-mail). |

## Pré-condições

- Login OAuth do wrangler na conta de `CLOUDFLARE_ACCOUNT_ID` (`npx wrangler whoami`).
- `.env` completo, com `PUBLIC_LGPD_*` e `PUBLIC_POLICY_EFFECTIVE_DATE` preenchidos.
- Produção já publicada no `workers.dev` pelo fluxo de [`docs/deploy.md`](../../deploy.md).
- Funções `Get-EnvValue`, `Set-EnvValue` da sessão pwsh carregadas (definidas em
  [`rotacao-de-segredos.md`](rotacao-de-segredos.md)).
- Cópia de segurança privada do `.env`, fora do repositório.
- **Pré-requisitos de código** (PRs separados, com testes, antes da fase A):
  - **A. Varredura de dados sensíveis:** `tools/check-sensitive.mjs` trata todo valor do `.env`
    como segredo. Com `PUBLIC_ORIGIN` igual ao domínio público, toda menção versionada ao endereço
    do produto passaria a falhar. Incluir `PUBLIC_ORIGIN` na lista de valores públicos da
    ferramenta (o subdomínio do `workers.dev` continua coberto pela chave
    `CLOUDFLARE_WORKERS_SUBDOMAIN`), e o mesmo para o domínio de e-mail derivado de `RESEND_FROM`
    antes da fase B.
  - **B. Redirecionamento 301:** o Worker web responde 301 para `PUBLIC_ORIGIN` + caminho + query
    quando o host da requisição termina em `.workers.dev` e é diferente do host de `PUBLIC_ORIGIN`.
    Staging não muda (lá `PUBLIC_ORIGIN` é o próprio `workers.dev`). Regras de redirecionamento da
    zona não alcançam o `workers.dev`, por isso a regra fica no Worker.
  - **C. (preferido) Domínio no template:** em `web/wrangler.template.jsonc`, no nível superior e em
    `env.production`, `"routes": [{ "pattern": "open-auri.com", "custom_domain": true }]`. Assim o
    domínio fica versionado e o deploy o mantém. Sem C, use a alternativa por API do passo 2.

Sessão pwsh comum aos passos (o token fica só na variável, nunca impresso):

```pwsh
$acct = Get-EnvValue 'CLOUDFLARE_ACCOUNT_ID'
$token = (npx wrangler auth token --json | ConvertFrom-Json).token
$cf = @{ Authorization = "Bearer $token" }
$api = 'https://api.cloudflare.com/client/v4'
```

## Fase A: domínio

### 1. Zona (conferência)

```pwsh
$zone = (Invoke-RestMethod -Headers $cf -Uri "$api/zones?name=open-auri.com").result[0]
$zone.status          # esperado: active
```

### 2. Domínio customizado do Worker

Com o pré-requisito C, o deploy do passo 9 anexa o domínio (o certificado e o registro do domínio
são criados pela própria Cloudflare). Alternativa por API, sem C:

```pwsh
$body = @{
  hostname = 'open-auri.com'
  service = (Get-EnvValue 'WORKER_NAME_WEB')
  zone_id = $zone.id
  environment = 'production'
} | ConvertTo-Json
$domain = (Invoke-RestMethod -Method Put -Headers $cf -ContentType 'application/json' `
  -Uri "$api/accounts/$acct/workers/domains" -Body $body).result
$domain.hostname      # esperado: open-auri.com
```

Guarde `$domain.id` só na sessão (serve ao rollback). O 301 do `workers.dev` vem do pré-requisito B
e entra em vigor com o deploy do passo 9.

### 3. `PUBLIC_ORIGIN`

```pwsh
Set-EnvValue 'PUBLIC_ORIGIN' 'https://open-auri.com'
```

`PUBLIC_ORIGIN` entra no bundle do cliente, nas páginas legais pré-renderizadas, nos links dos
e-mails, nas origens confiáveis da autenticação e na checagem de `hostname` do Turnstile: só vale
depois de um build e deploy novos.

### 4. Domínios do widget Turnstile

A atualização exige o corpo completo do widget; leia o atual e acrescente o domínio, sem remover os
existentes (o staging continua usando o `workers.dev`). Nada é impresso:

```pwsh
$site = Get-EnvValue 'PUBLIC_TURNSTILE_SITE_KEY'
$w = (Invoke-RestMethod -Headers $cf -Uri "$api/accounts/$acct/challenges/widgets/$site").result
$body = @{
  name = $w.name
  mode = $w.mode
  domains = @(@($w.domains) + 'open-auri.com' | Select-Object -Unique)
} | ConvertTo-Json
$null = Invoke-RestMethod -Method Put -Headers $cf -ContentType 'application/json' `
  -Uri "$api/accounts/$acct/challenges/widgets/$site" -Body $body
(Invoke-RestMethod -Headers $cf -Uri "$api/accounts/$acct/challenges/widgets/$site").result.domains -contains 'open-auri.com'
# esperado: True
```

### 9a. Deploy e smoke (fase A)

```pwsh
node --env-file=.env tools/deploy.mjs --env production --confirm-production
```

O script confere a conta, roda `check:sensitive`, testes e build com as `PUBLIC_*` reais, sincroniza
os segredos, cria o bookmark do Time Travel, aplica migrações, publica web e jobs e roda o smoke
([`docs/deploy.md`](../../deploy.md)). Depois, se houver webhook do Resend, troque a URL dele para
`https://open-auri.com/api/webhooks/resend` (painel ou API do Resend); se houver aplicação do
Cloudflare Access em `/admin`, acrescente o domínio novo a ela.

## Fase B: e-mail e cadastro

### 5. Domínio de envio no Resend e registros DNS

Subdomínio de envio: `mail.<DOMINIO>`, com `<DOMINIO>` = o domínio do produto.

```pwsh
$rs = @{ Authorization = "Bearer $(Get-EnvValue 'RESEND_API_KEY')" }
$body = @{ name = 'mail.<DOMINIO>' } | ConvertTo-Json
$rd = Invoke-RestMethod -Method Post -Headers $rs -ContentType 'application/json' `
  -Uri 'https://api.resend.com/domains' -Body $body
$rd.records | Select-Object record, type, name, value, priority, status
```

A resposta traz os registros exigidos (SPF em TXT, MX de retorno e DKIM em TXT no subdomínio de
envio). São públicos por natureza, mas não os copie para arquivos versionados.

**Bloqueio:** criar esses registros na zona exige escrita de DNS, que o OAuth do wrangler não tem.
Opções (decisão registrada na issue #32):

- **Token restrito do operador:** um token de API da Cloudflare com permissão só de edição de DNS
  nesta zona, colocado numa variável de processo (nunca no `.env` versionável nem em log). Com ele,
  para cada registro de `$rd.records`:

  ```pwsh
  $dns = @{ Authorization = "Bearer $env:<VARIAVEL_DO_TOKEN_DNS>" }
  foreach ($r in $rd.records) {
    $rec = @{ type = $r.type; name = $r.name; content = $r.value; ttl = 1 }
    if ($r.type -eq 'MX') { $rec.priority = [int]$r.priority }
    $null = Invoke-RestMethod -Method Post -Headers $dns -ContentType 'application/json' `
      -Uri "$api/zones/$($zone.id)/dns_records" -Body ($rec | ConvertTo-Json)
  }
  ```

  `name` no Resend é relativo à zona; a API da Cloudflare aceita o nome relativo ou o completo.
  Registros DKIM e SPF ficam "DNS only" (TXT e MX não passam pelo proxy).
- **Painel:** o operador cria os mesmos registros à mão no painel de DNS da zona.
- **Configuração automática do Resend** para domínios na Cloudflare, se disponível na conta, feita
  pelo operador no painel do Resend.

### 6. Verificação

```pwsh
$null = Invoke-RestMethod -Method Post -Headers $rs -Uri "https://api.resend.com/domains/$($rd.id)/verify"
(Invoke-RestMethod -Headers $rs -Uri "https://api.resend.com/domains/$($rd.id)").status
# esperado: verified (a propagação pode levar de minutos a horas; repita)
```

### 7. `RESEND_FROM`

```pwsh
Set-EnvValue 'RESEND_FROM' '<NOME_DO_REMETENTE> <<ENDERECO>@mail.<DOMINIO>>'
```

Antes, aplique a parte de e-mail do pré-requisito A, ou a varredura do deploy falha.

### 8. Abrir o cadastro

```pwsh
Set-EnvValue 'SIGNUP_ENABLED' 'true'
```

### 9b. Deploy e smoke (fase B)

```pwsh
node --env-file=.env tools/deploy.mjs --env production --confirm-production
Remove-Variable token, cf, rs -ErrorAction SilentlyContinue
```

## Verificação

```pwsh
(Invoke-WebRequest -Uri 'https://open-auri.com/').StatusCode                      # 200
$wd = "https://$(Get-EnvValue 'WORKER_NAME_WEB').$(Get-EnvValue 'CLOUDFLARE_WORKERS_SUBDOMAIN').workers.dev/biblioteca?x=1"
$r = Invoke-WebRequest -Uri $wd -MaximumRedirection 0 -SkipHttpErrorCheck
$r.StatusCode, $r.Headers.Location                                               # 301, https://open-auri.com/biblioteca?x=1
```

- `https://open-auri.com/privacidade` mostra o endereço novo e os dados do controlador.
- Cabeçalhos de segurança presentes no domínio novo (HSTS, CSP, `Permissions-Policy` com `hid`).
- WebHID: a página `/cabo` pede o dispositivo normalmente (contexto seguro no domínio novo).
- Fase B: criar uma conta de teste no domínio novo, receber o e-mail de verificação vindo de
  `mail.<DOMINIO>` (SPF e DKIM "pass" no cabeçalho da mensagem), entrar, e depois encerrar a conta
  de teste por `/conta`.
- Staging continua no `workers.dev`, sem redirecionamento.
- `node tools/check-sensitive.mjs` sai 0.

## Rollback

- **Cadastro:** `Set-EnvValue 'SIGNUP_ENABLED' 'false'` e deploy. Contas já criadas continuam.
- **Remetente:** volte `RESEND_FROM` ao valor anterior (cópia privada do `.env`) e faça deploy.
- **Domínio:** volte `PUBLIC_ORIGIN` ao `workers.dev` anterior e faça deploy (o 301 deixa de valer,
  porque o host passa a ser o próprio `PUBLIC_ORIGIN`); depois desanexe o domínio, revertendo o
  pré-requisito C ou, pela API:

  ```pwsh
  Invoke-RestMethod -Method Delete -Headers $cf -Uri "$api/accounts/$acct/workers/domains/<DOMAIN_ID>"
  ```

  Navegadores que já receberam HSTS de `open-auri.com` continuam exigindo HTTPS nele, o que não
  impede a volta. Sessões abertas no domínio novo não valem no antigo (cookies por host).
- **Turnstile:** manter o domínio a mais no widget é inofensivo; para remover, repita o passo 4 sem
  ele.
- **Resend:** o domínio de envio e os registros DNS podem ficar; não afetam o remetente de teste.
