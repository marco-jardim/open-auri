# Runbook: modo somente leitura

## Quando usar

- Escrita indevida em curso (defeito, abuso, inundação de publicações ou de denúncias).
- Migração ou restauração do D1 que exige o banco parado para escrita.
- Investigação de incidente em que novas escritas atrapalham ([`incidente.md`](incidente.md)).

## O que o modo faz

- O interruptor é a chave `mode:read-only` no KV `CONFIG`: valor `1` liga; chave ausente desliga
  (qualquer outro valor conta como desligado).
- Com ele ligado, toda requisição que não seja GET, HEAD ou OPTIONS recebe **503** com código
  `READ_ONLY` (cabeçalho `x-error-code`), `Retry-After: 300` e `Cache-Control: no-store`.
  Navegações recebem uma página estática bilíngue.
- Também são bloqueados os dois links de e-mail que mudam estado por GET: verificação de e-mail e
  confirmação de encerramento de conta.
- **Continuam funcionando:** navegação, editor, prévias, teste cego e gravação no cabo (tudo no
  navegador); entrar, segundo fator e sair; exportação LGPD em `/conta/exportar`; toda a área
  `/admin` (inclusive a moderação e o próprio interruptor).
- Propagação: cada isolate guarda o valor por até 10 s e o KV leva até cerca de 60 s para chegar a
  todos os pontos. Uma falha de leitura do KV mantém o último valor conhecido (ou desligado).

## Pré-condições

- Caminho principal: conta `admin` com 2FA (e Access, se configurado).
- Caminho de emergência (sem `/admin`): login OAuth do wrangler na conta de
  `CLOUDFLARE_ACCOUNT_ID` e `.env` atual.

## Procedimento

### Pelo `/admin` (preferido: fica na auditoria)

1. Abra `<PUBLIC_ORIGIN>/admin`.
2. Use o botão do modo somente leitura (liga quando desligado, desliga quando ligado) e confirme.
   A ação grava `audit_log` com o seu ator antes de mudar o KV.

### Pelo wrangler (emergência)

Sem trilha automática na auditoria: anote data, operador e motivo no registro do incidente.

```pwsh
npm run -w web gen                       # gera web/wrangler.jsonc a partir do .env
Set-Location web
# ligar (produção; acrescente --env staging para o staging)
npx wrangler kv key put "mode:read-only" 1 --binding CONFIG --remote
# desligar
npx wrangler kv key delete "mode:read-only" --binding CONFIG --remote
Set-Location ..
```

## Verificação

Espere até 1 minuto depois da mudança.

```pwsh
$origin = '<PUBLIC_ORIGIN>'
try {
  Invoke-WebRequest -Method Post -Uri "$origin/api/v1/shares" -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck |
    Select-Object StatusCode, @{ n = 'code'; e = { $_.Headers['x-error-code'] } }
} catch { $_.Exception.Message }
```

- **Ligado:** `StatusCode` 503 e `code` `READ_ONLY`.
- **Desligado:** outro status (por exemplo 401 ou 403 sem sessão), nunca `READ_ONLY`.
- `/admin` mostra o estado atual; `/admin/auditoria` mostra a ação (caminho pelo `/admin`).
- A página inicial abre normalmente nos dois casos.

## Rollback

Desligar é o rollback: o mesmo botão em `/admin` ou `wrangler kv key delete` acima. Escritas
recusadas durante o modo não são enfileiradas no servidor; o cliente social guarda a atividade na
fila offline e reenvia depois. Links de e-mail que expiraram nesse meio-tempo precisam ser pedidos
de novo.
