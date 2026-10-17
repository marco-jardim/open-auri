# Runbook: rotação de segredos

## Quando usar

- Rotação planejada (sugestão: anual, ou ao trocar quem opera).
- Suspeita ou confirmação de vazamento (rotação de emergência, junto com
  [`incidente.md`](incidente.md)).

## Segredos dos Workers

| Segredo no Worker | Chave no `.env` | Worker | Efeito da troca |
|---|---|---|---|
| `ACCESS_LOG_KEY` | `ACCESS_LOG_KEY` | web e jobs | Nenhum, se feita como keyring (abaixo). Trocar sem manter a chave antiga torna ilegíveis os registros de acesso dos últimos 6 meses. |
| `BETTER_AUTH_SECRET` | `BETTER_AUTH_SECRET` | web | Forte: ver seção própria abaixo. |
| `IPHASH_PEPPER` | `IPHASH_PEPPER` | web | Contadores de rate limit recomeçam (os hashes mudam). Inofensivo. |
| `TURNSTILE_SECRET` | `TURNSTILE_SECRET_KEY` | web | Nenhum, se a chave antiga continuar válida até o deploy. |
| `RESEND_API_KEY` | `RESEND_API_KEY` | web | Nenhum, se a chave antiga for apagada só depois do deploy. |
| `RESEND_WEBHOOK_SECRET` | `RESEND_WEBHOOK_SECRET` | web | Eventos de bounce assinados com o segredo antigo passam a ser recusados (o Resend reenvia). |

## Pré-condições

- Login OAuth do wrangler na conta de `CLOUDFLARE_ACCOUNT_ID`; `.env` atual na raiz.
- Cópia de segurança do `.env` fora do repositório, em local privado, apagada depois da
  verificação.
- Rotação ensaiada em staging (`--env staging`) antes da produção.

Funções de apoio para a sessão pwsh (rodar na raiz; nunca imprimem valores):

```pwsh
function Get-EnvValue([string]$Name) {
  ((Get-Content .env) | Where-Object { $_ -match "^$Name=" } | Select-Object -First 1) -replace "^$Name=", ''
}
function Set-EnvValue([string]$Name, [string]$Value) {
  $lines = Get-Content .env | ForEach-Object { if ($_ -match "^$Name=") { "$Name=$Value" } else { $_ } }
  Set-Content .env $lines
}
function New-Secret {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
}
```

## Procedimento comum

Depois de mudar o valor no `.env`:

```pwsh
node tools/sync-secrets.mjs --env staging --worker web
node tools/sync-secrets.mjs --env staging --worker jobs
# verificado o staging:
node tools/sync-secrets.mjs --worker web
node tools/sync-secrets.mjs --worker jobs
```

A ferramenta envia todos os segredos do Worker, um por vez pela entrada padrão, e só mostra nomes.
`wrangler secret put` publica uma nova versão do Worker; não é preciso redeploy. Staging e
produção usam os mesmos valores do `.env`.

## `ACCESS_LOG_KEY` (keyring versionado)

O valor é um keyring `kid:secret[,kid:secret...]`. A **primeira** entrada cifra; **todas**
decifram. `kid` tem de 1 a 16 caracteres `[a-z0-9]`; cada segredo tem pelo menos 32 caracteres. Um
valor sem `kid:` é a chave única `k1`. Cada objeto no R2 e cada mensagem da fila guardam o `kid`
com que foram cifrados.

1. Escolha o próximo `kid` (por exemplo, `k2` se o atual for `k1`).
2. Ponha a chave nova na frente e mantenha a antiga com o `kid` explícito:

   ```pwsh
   $old = Get-EnvValue 'ACCESS_LOG_KEY'
   if ($old -notmatch '^[a-z0-9]{1,16}:') { $old = "k1:$old" }   # valor sem kid era o k1
   $new = New-Secret
   Set-EnvValue 'ACCESS_LOG_KEY' "k2:$new,$old"
   Remove-Variable old, new
   ```

3. Sincronize web **e** jobs (procedimento comum), staging antes de produção.
4. **Mantenha a entrada antiga por pelo menos 190 dias** (180 dias do ciclo de vida do R2 em
   `access-log/` mais margem para mensagens na fila e na DLQ). Só então remova a entrada antiga do
   keyring e sincronize de novo. Se a chave antiga vazou, a troca protege só os dados novos: os
   objetos antigos continuam cifrados com ela até expirarem.
5. A ferramenta de ordem judicial lê o mesmo keyring do `.env`: mantenha o `.env` igual ao Worker.

## `BETTER_AUTH_SECRET`

Efeitos da troca, todos imediatos:

- **Sessões:** todos os usuários saem e precisam entrar de novo. Links de verificação, de
  redefinição de senha e de confirmação de encerramento já enviados deixam de valer.
- **Lista de supressão de e-mail:** guarda só HMAC-SHA256 do endereço, com chave derivada deste
  segredo. Com o segredo novo os hashes antigos não batem mais: endereços com bounce ou reclamação
  podem receber um e-mail de novo, até o próximo bounce suprimi-los outra vez. Não há como recalcular
  (os endereços não são guardados). O job de limpeza remove as linhas órfãs com 12 meses.
- **Claims de `eventId` da atividade:** as chaves anti-repetição usam um HMAC derivado deste
  segredo. Durante a janela de 8 dias, um evento antigo reenviado pela fila offline pode ser aceito
  uma segunda vez (afeta só a contagem privada do próprio usuário).
- **2FA:** o plugin de dois fatores do Better Auth cifra dados do segundo fator com o segredo da
  aplicação. Confirme em staging se o 2FA continua válido depois da troca. Se não continuar, todos
  com 2FA (inclusive administradores, que precisam dele para abrir `/admin`) terão de configurar de
  novo; prepare o acesso administrativo antes de rotacionar em produção.

Procedimento:

```pwsh
Set-EnvValue 'BETTER_AUTH_SECRET' (New-Secret)
node tools/sync-secrets.mjs --env staging --worker web
# confira entrada, 2FA e um envio de e-mail em staging; depois:
node tools/sync-secrets.mjs --worker web
```

## `IPHASH_PEPPER`

```pwsh
Set-EnvValue 'IPHASH_PEPPER' (New-Secret)
```

Depois, o procedimento comum (web).

## `TURNSTILE_SECRET_KEY`

Rotação pela API do Turnstile com o token OAuth do wrangler (só em variável de processo). A chave
antiga continua válida por um período de transição quando `invalidate_immediately` é `false`:

```pwsh
$acct = Get-EnvValue 'CLOUDFLARE_ACCOUNT_ID'
$site = Get-EnvValue 'PUBLIC_TURNSTILE_SITE_KEY'
$token = (npx wrangler auth token --json | ConvertFrom-Json).token
$headers = @{ Authorization = "Bearer $token" }
$res = Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' `
  -Uri "https://api.cloudflare.com/client/v4/accounts/$acct/challenges/widgets/$site/rotate_secret" `
  -Body '{"invalidate_immediately":false}'
Set-EnvValue 'TURNSTILE_SECRET_KEY' $res.result.secret
Remove-Variable res, token, headers
```

Depois, o procedimento comum (web). Em emergência, use `"invalidate_immediately":true` e sincronize
logo em seguida (formulários com Turnstile falham até o sync).

## `RESEND_API_KEY`

1. Crie uma chave nova no Resend (painel ou `POST https://api.resend.com/api-keys`, permissão
   "sending access" no domínio de envio) e grave no `.env` com `Set-EnvValue`, sem imprimir.
2. Procedimento comum (web) e um envio de teste (redefinição de senha da conta do operador).
3. Apague a chave antiga no Resend (`DELETE https://api.resend.com/api-keys/<API_KEY_ID>`).

## `RESEND_WEBHOOK_SECRET`

Gere um novo segredo de assinatura do webhook no Resend (painel do webhook de
`<PUBLIC_ORIGIN>/api/webhooks/resend`), grave no `.env` e rode o procedimento comum (web).

## Verificação

- A saída de `sync-secrets` lista "Uploaded secret <NOME>" para cada segredo, sem valores.
- `ACCESS_LOG_KEY`: depois de uma hora, um objeto novo existe em `access-log/`; um teste com
  `tools/access-log-query.mjs` em staging, numa janela que cruza a rotação, decifra os dois `kid`.
- `BETTER_AUTH_SECRET`: entrar, 2FA e redefinição de senha funcionam em staging e em produção.
- Turnstile e Resend: cadastro ou redefinição de senha completa o fluxo.
- `node tools/check-sensitive.mjs` sai 0 (nenhum valor foi parar em arquivo versionado).

## Rollback

Restaure o valor anterior a partir da cópia privada do `.env` com `Set-EnvValue` e rode o
procedimento comum. Para o `ACCESS_LOG_KEY`, nunca remova uma entrada do keyring enquanto houver
objetos cifrados com ela. Chaves externas já apagadas (Resend) ou invalidadas (Turnstile) não
voltam: gere outra.
