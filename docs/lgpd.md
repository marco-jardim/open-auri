<!--
Modelo: os marcadores {{...}} são substituídos no build a partir de variáveis de ambiente.
Variáveis usadas: PUBLIC_LGPD_CONTROLLER, PUBLIC_LGPD_CONTACT_EMAIL, PUBLIC_LGPD_CNPJ,
PUBLIC_LGPD_ADDRESS, PUBLIC_LGPD_DPO_NAME, PUBLIC_POLICY_EFFECTIVE_DATE, PUBLIC_ORIGIN.
Não coloque valores reais neste arquivo: o repositório é público.
-->

# Registro das operações de tratamento (LGPD, art. 37)

**Versão:** 1.0 · **Data:** {{PUBLIC_POLICY_EFFECTIVE_DATE}} · **Política relacionada:** `docs\legal\politica-de-privacidade.md` (pt-BR, oficial) e `docs\legal\privacy-policy.en-US.md` (tradução)

Fonte técnica: plano de implementação `docs\plans\2026-10-15-open-auri-web-plano.md` (§3.7, §3.8, §4.3, T3.2 a T3.8, T4.1 a T4.12, T5.2, T5.3 e Anexo A.2), mais as decisões do controlador registradas nesta versão (registros de acesso do Marco Civil, dados do AutoEq embutidos, 2FA para administradores).

## Identificação

| Campo | Valor |
|---|---|
| Controlador | {{PUBLIC_LGPD_CONTROLLER}} |
| CNPJ | {{PUBLIC_LGPD_CNPJ}} |
| Endereço | {{PUBLIC_LGPD_ADDRESS}} |
| Canal do titular e do encarregado | {{PUBLIC_LGPD_CONTACT_EMAIL}} |
| Encarregado (se houver) | {{PUBLIC_LGPD_DPO_NAME}} |
| Porte | Agente de tratamento de pequeno porte (Resolução CD/ANPD nº 2/2022). Este registro segue o modelo simplificado permitido pelo art. 9º da Resolução. O canal de comunicação é mantido conforme o art. 11, mesmo sem obrigação de indicar encarregado |
| Produto | open-auri ({{PUBLIC_ORIGIN}}), app web e API em Cloudflare Workers |

## Legendas

**Operadores e transferência internacional**

| Código | Operador | Serviços | Transferência internacional |
|---|---|---|---|
| CF | Cloudflare, Inc. | Workers, D1, R2, KV, Analytics Engine, Workers Logs, Turnstile, Access | Sim: EUA e demais países da rede da Cloudflare. LGPD art. 33, II, "b": cláusulas-padrão contratuais da Resolução CD/ANPD nº 19/2024 e DPA da Cloudflare |
| RS | Resend | E-mail transacional e webhooks de bounce e reclamação | Sim: EUA. LGPD art. 33, II, "b": cláusulas-padrão contratuais da Resolução CD/ANPD nº 19/2024 e DPA da Resend |
| MX | Provedor da caixa {{PUBLIC_LGPD_CONTACT_EMAIL}} (definido pelo controlador) | Caixa de e-mail do canal do titular | A confirmar conforme o provedor |

**Medidas de segurança comuns (aplicam-se a todas as operações no servidor)**

| Código | Medida |
|---|---|
| M1 | HTTPS com HSTS; CSP com nonce; `X-Content-Type-Options`; `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy` com `hid=(self)`; `frame-ancestors 'none'`; COOP `same-origin` |
| M2 | Acesso a dados só por camada única (`repo.ts`) com consultas parametrizadas e visibilidade sempre aplicada |
| M3 | Validação de entrada por schema; `requireVerified` em toda escrita social; rate limit por rota |
| M4 | Logs operacionais da aplicação sem dados pessoais (id de requisição, rota, latência, status, código de erro) |
| M5 | Interruptor de emergência "somente leitura" |
| M6 | Administração com guarda dupla (papel `admin` + JWT do Cloudflare Access), autenticação em dois fatores para administradores e registro de auditoria |
| M7 | Backups semanais com retenção de 12 semanas; restauração testada em staging |

## Operações de tratamento

| # | Operação | Finalidade | Dados | Titulares | Base legal | Retenção | Operadores | Transferência internacional | Medidas de segurança |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Uso local sem conta | Funcionamento do app no navegador | Idioma (`oa.lang`, cookie `oa_lang`), curva atual, diário de gravações (até 500), contadores de gravação, referência do medidor, biblioteca local, fila offline, arquivo de áudio carregado, arquivos de medição importados | Qualquer visitante | Não há tratamento pelo controlador: os dados ficam no aparelho e não são enviados. O áudio nunca é enviado. Requisições dinâmicas ao servidor entram na operação 25 | Até o usuário apagar (Docs > "Dados neste navegador" ou limpeza do navegador) | Nenhum | Não | Dados ficam no aparelho |
| 2 | Cadastro, autenticação e verificação de e-mail | Criar e proteger a conta; liberar ações sociais | E-mail, hash da senha (scrypt), flag de verificação, tokens de verificação e de redefinição de senha | Usuários com conta (18+) | Art. 7º, V (execução de contrato) | Conta: até o encerramento. Tokens: até uso ou expiração | CF | Sim (CF) | M1 a M7; senha mínima de 10 caracteres com verificação de força; respostas uniformes contra enumeração; Turnstile; rate limit (sign-in 3/10 s, reset 3/60 s, sign-up 3/60 s); CSRF e checagem de origem; revogação de sessões ao redefinir a senha. O cadastro pode ficar indisponível até a verificação do domínio de e-mail transacional |
| 3 | Sessões | Manter o usuário conectado; listar e revogar sessões | Id e token da sessão, dispositivo aproximado (derivado do user-agent), datas de criação, última atividade e expiração. Sem IP (o IP fica só na operação 25) | Usuários com conta | Art. 7º, V | Até expirar, sair ou revogar; apagadas no encerramento da conta | CF | Sim (CF) | M1 a M6; cookie `Secure`, `HttpOnly`, `SameSite=Lax` |
| 4 | Perfil e preferências | Identificar o autor publicamente; configurar a conta | Apelido (único, público), nome de exibição (opcional), bio (opcional, ≤ 280), idioma, `activity_visibility`, opção de biblioteca pública | Usuários com conta | Art. 7º, V; para visibilidade pública da atividade e da biblioteca, art. 7º, I (consentimento, padrão desligado) | Até o encerramento da conta | CF | Sim (CF) | M1 a M7; normalização NFKC, checagem de caracteres confundíveis e nomes reservados |
| 5 | Biblioteca da conta e favoritos | Sincronizar criações, favoritos e instaladas; mesclar a biblioteca local ao entrar | Lista de criações, favoritos (usuário, curva, data), instaladas | Usuários com conta | Art. 7º, V | Até o usuário apagar ou encerrar a conta | CF | Sim (CF) | M1 a M7 |
| 6 | Publicação de conteúdo | Publicar curvas, versões, forks e packs sob licença CC | Curva (S1/S5), nome, descrição, receita, idioma, licença (CC0-1.0 ou CC-BY-4.0), visibilidade, vínculo com o dono, datas; imagem OG gerada no servidor (sem imagem do usuário) | Usuários com conta (autores) | Art. 7º, V | Até apagar ou retirar (lápide) ou encerrar a conta. No encerramento: anonimizar ("autor removido") ou apagar, à escolha do titular; privado sempre apagado. Licença de versão publicada é irrevogável | CF | Sim (CF) | M1 a M7; gate no servidor; texto normalizado (NFKC, sem bidi, sem URL); cota diária |
| 7 | Compartilhamentos e funil | Gerar links de compartilhamento e medir seu alcance | Id do compartilhamento, curva, versão, dono, canal (opcional), data; aberturas anônimas só como contagem por dia; eventos atribuídos de usuários com conta (usuário, tipo, data) | Donos de compartilhamentos; usuários com conta que interagem; visitantes anônimos (só contagem, sem identidade) | Art. 7º, V | Até o encerramento da conta do dono; eventos atribuídos até o encerramento da conta de quem agiu | CF | Sim (CF) | M1 a M7 |
| 8 | Rastreio de atividade | Contagens públicas por curva e lista de público para autores | Usuário, curva, tipo (`previewed` ≥ 10 s, `installed` só gravação real, favorito), primeira e última vez, contagem | Usuários com conta | Art. 7º, V (registro e contagens); art. 7º, I (exibição nominal, opt-in, padrão privado) | Até o usuário apagar a atividade ou encerrar a conta | CF | Sim (CF) | M1 a M7; lista nominal só de perfis públicos; demais como "N pessoas com perfil privado"; outbox aceita eventos de até 7 dias |
| 9 | Biblioteca pública | Página pública com as curvas criadas pelo usuário | Apelido, curvas públicas criadas, estatísticas agregadas | Usuários com conta que optarem | Art. 7º, I (opt-in, padrão desligado) | Enquanto a opção estiver ligada | CF | Sim (CF) | M1 a M7 |
| 10 | Rankings | Destacar curvas mais favoritadas e mais instaladas (7 d, 30 d, sempre) | Contagens agregadas por contas verificadas distintas; nenhuma identidade exibida | Usuários com conta (de forma agregada) | Art. 7º, IX (legítimo interesse) | Recalculado a cada 15 min; só o agregado é guardado | CF | Sim (CF) | M1 a M7; exclui privado, oculto, retirado, reprovado no gate e contas banidas |
| 11 | Denúncias e moderação | Remover conteúdo abusivo e aplicar os termos | Alvo, motivo, nota, denunciante, data, resolução; ocultação automática (3 contas verificadas distintas com 3 dias ou mais) | Denunciantes; autores denunciados | Art. 7º, IX | Enquanto a conta do denunciante existir; no encerramento, o vínculo é apagado | CF | Sim (CF) | M1 a M7; Turnstile; UNIQUE (alvo, denunciante); revisão humana da ocultação automática (art. 20) |
| 12 | Registro de auditoria | Rastrear ações de moderação e administração e todo acesso aos registros de acesso (operação 25) | Ator, ação, alvo, detalhe, data | Administradores; usuários afetados | Art. 7º, IX; art. 7º, VI (exercício regular de direitos) | 5 anos. Justificativa: prazo de 5 anos do CDC (art. 27) para pretensão de reparação; permite defender decisões de moderação e comprovar o controle de acesso aos registros do Marco Civil | CF | Sim (CF) | M1 a M7; acesso só por administradores com guarda dupla e 2FA |
| 13 | S6: preferência anônima do teste cego | Agregar preferências (Bradley–Terry) em "Comunidade prefere" | Pares A/B, escolha, se o volume foi igualado, dia, versão do consentimento, hash do recibo. Sem conta e sem IP no lote | Participantes anônimos | Art. 11, I (consentimento específico e destacado; dado possivelmente relativo à saúde) | Até a retirada pelo recibo. Agregado anônimo permanece | CF | Sim (CF) | M1, M3 a M7; Turnstile; rate limit por hash de IP não persistido no lote; recibo só no aparelho do titular. A requisição de envio gera registro de acesso (operação 25) sem o conteúdo do lote |
| 14 | S7: troca às cegas | Trocar curvas entre usuários e coletar notas | Usuário, curva e versão, status, pareamento, nota, datas de criação e expiração | Usuários com conta verificada | Art. 7º, V | Não pareada: expira em 72 h. Concluída: até o encerramento da conta. Médias por curva são agregadas | CF | Sim (CF) | M1 a M7; pareamento atômico; uma troca ativa por usuário |
| 15 | Cloudflare Turnstile | Distinguir pessoas de robôs em cadastro, entrada, recuperação, troca de e-mail, denúncia e S6 | Dados técnicos do navegador coletados pela Cloudflare (adendo de privacidade do Turnstile); token e resultado. Sem `remoteip` na verificação | Visitantes e usuários nesses fluxos | Art. 7º, IX (prevenção a fraude e segurança) | Token: uso único. Dados na Cloudflare: conforme o adendo do Turnstile | CF | Sim (CF) | Verificação de `action` e `hostname`; `idempotency_key` |
| 16 | Rate limit com hash de IP | Impedir abuso e ataques de força bruta | HMAC-SHA256 do IP com pepper e sal diário (KV); contadores por chave. O hash serve só para o limite de taxa | Todos que acessam rotas protegidas | Art. 7º, IX | Hashes: até 48 h. Sal: apagado na rotação diária | CF | Sim (CF) | Sal rotativo; hashes não reproduzíveis após a rotação |
| 17 | Logs operacionais e da plataforma | Operar, diagnosticar erros e medir falhas | Logs operacionais da aplicação sem dados pessoais; métricas agregadas (Analytics Engine); logs da plataforma Cloudflare (podem conter dados técnicos de conexão) | Todos os visitantes | Art. 7º, IX | Logs da plataforma: conforme a retenção da Cloudflare | CF | Sim (CF) | M4; alertas por limiar |
| 18 | E-mail transacional | Verificação, redefinição de senha, troca de e-mail (novo e antigo), aviso de senha alterada, confirmação de encerramento e aviso de conta encerrada | E-mail, idioma, conteúdo transacional, chave de idempotência | Usuários com conta | Art. 7º, V | No controlador: não guarda cópia do e-mail enviado. Na Resend: conforme a retenção da Resend | RS, CF | Sim (RS, CF) | Sem marketing e sem pixels de rastreamento; nenhum dado sensível em logs |
| 19 | Lista de supressão de e-mail | Não reenviar a endereços com bounce ou reclamação | Hash do e-mail, motivo, data | Destinatários de e-mails | Art. 7º, IX | Até 12 meses após o último bounce ou reclamação | RS, CF | Sim (RS, CF) | Webhook com assinatura svix |
| 20 | Atendimento a titulares | Responder pedidos do art. 18 e dúvidas | E-mail, conteúdo do pedido, dados para confirmar a titularidade, resposta | Titulares que nos escrevem | Art. 7º, II (cumprimento de obrigação legal: arts. 18 e 19) | 5 anos após a resposta, para comprovar o atendimento | MX | A confirmar conforme o provedor (MX) | Acesso restrito à equipe responsável |
| 21 | Exportação de dados (portabilidade e acesso) | Entregar ao titular seus dados em JSON | Conta, perfil, curvas, versões, favoritos, atividade, compartilhamentos | Usuários com conta | Art. 7º, II (arts. 18, II e V) | Gerado sob demanda e baixado direto; não é guardado | CF | Sim (CF) | Só o dono; sem dados de terceiros; CSRF |
| 22 | Backups | Recuperar o serviço após falha ou incidente | Cópia integral do D1 (inclui dados de conta) | Todos os titulares com dados no servidor | Art. 7º, IX (segurança e continuidade) | Até 12 semanas; dados apagados podem permanecer nesse período sem uso | CF | Sim (CF) | M6, M7; acesso restrito |
| 23 | Dump público semanal | Preservar e abrir o acervo público de curvas | Curvas públicas, versões, licenças, agregados. Sem e-mail, sem atividade nominal, sem hashes, sem IP | Autores de curvas públicas | Art. 7º, IX; conteúdo publicado sob licença CC escolhida pelo titular | Cópias públicas permanecem; novos dumps refletem exclusões e anonimizações | CF | Sim (CF) | Geração automatizada que exclui dados de conta |
| 24 | Acesso administrativo | Restringir `/admin` a administradores | E-mail e identidade do administrador no Cloudflare Access; JWT de acesso; fator de autenticação adicional | Administradores | Art. 7º, IX | Conforme a retenção do Cloudflare Access | CF | Sim (CF) | M6 (inclui 2FA) |
| 25 | Registros de acesso a aplicações (Marco Civil da Internet) | Cumprir o art. 15 da Lei nº 12.965/2014 (registros definidos no art. 5º, VIII) | Endereço IP; data e hora com fuso horário; identificador da conta, se conectado; tipo de requisição (grupo de rotas). Para toda requisição dinâmica atendida pela aplicação; arquivos estáticos servidos direto pela CDN não são registrados pela aplicação | Todos que fazem requisições dinâmicas (com ou sem conta) | Art. 7º, II (cumprimento de obrigação legal) | 6 meses, depois exclusão automática. Guarda maior só a pedido de autoridade (MCI, art. 15, §2º). Não pode ser apagado antes a pedido do titular (LGPD, art. 16, I) | CF | Sim (CF) | Cifrado em repouso (AES-GCM); ambiente controlado e seguro; acesso restrito; entrega só mediante ordem judicial (MCI, art. 10 e art. 15, §3º); todo acesso anotado no registro de auditoria (operação 12); sem uso para perfil, análise ou marketing |

## Cookies

| Cookie | Tipo | Finalidade | Base legal |
|---|---|---|---|
| Sessão (Better Auth) | Essencial | Autenticação | Art. 7º, V |
| `oa_lang` | Essencial | Idioma | Art. 7º, V (funcionamento solicitado pelo usuário) |

Sem cookies de análise ou publicidade. Sem banner de consentimento; informação na política (§3.8 do plano).

## Dados não pessoais embutidos

O app inclui medições e alvos públicos do projeto AutoEq, com atribuição da fonte. São dados de equipamentos, sem dados pessoais, e por isso não constituem operação de tratamento.

## Direitos do titular: onde cada um é atendido

| Direito (art. 18) | Canal |
|---|---|
| Confirmação e acesso | Exportar meus dados (JSON) em `{{PUBLIC_ORIGIN}}/conta`; {{PUBLIC_LGPD_CONTACT_EMAIL}} |
| Correção | Perfil e e-mail em `{{PUBLIC_ORIGIN}}/conta` |
| Anonimização, bloqueio, eliminação | Apagar atividade; encerrar conta (anonimizar CC público ou apagar tudo; privado sempre apagado); {{PUBLIC_LGPD_CONTACT_EMAIL}}. Registros de acesso (operação 25) ficam até completar 6 meses |
| Portabilidade | Exportação JSON |
| Revogação do consentimento | `activity_visibility` privado; biblioteca pública desligada; recibo do S6 |
| Revisão de decisão automatizada (art. 20) | Ocultação automática por denúncias: fila de moderação e {{PUBLIC_LGPD_CONTACT_EMAIL}} |
| Prazo | Simplificado: imediato. Declaração completa: até 15 dias (art. 19, II) |
| Reclamação | Petição à ANPD |

## Incidentes

Comunicação à ANPD e aos titulares conforme o art. 48 da LGPD e a Resolução CD/ANPD nº 15/2024. Titulares com conta são avisados por e-mail e por aviso no app.

## Pontos em aberto (para revisão jurídica e implementação)

1. **Q-LEGAL: enquadramento como pequeno porte.** A Resolução CD/ANPD nº 2/2022 exclui quem faz tratamento de alto risco. O S6 trata dado possivelmente sensível; confirmar que não há "larga escala" que afaste o enquadramento.
2. **Q-LEGAL: cláusulas-padrão.** Confirmar que os DPAs da Cloudflare e da Resend incorporam as cláusulas-padrão da Resolução CD/ANPD nº 19/2024; se não, firmá-las.
3. **Q-LEGAL: porta lógica de origem.** Com IPs compartilhados (CGNAT), autoridades e tribunais costumam pedir também a porta de origem. Avaliar se ela deve entrar na operação 25 e se a Cloudflare a disponibiliza ao Worker.
4. **Q-LEGAL: acesso do titular aos próprios registros de acesso.** A política diz que esses registros só são entregues mediante ordem judicial (MCI, art. 10). Confirmar como conciliar com o direito de acesso do art. 18, II, da LGPD.
5. **Q-LEGAL: S6 e registros de acesso.** O lote do S6 guarda só o dia, mas o registro de acesso do envio tem IP, hora e grupo de rotas. Avaliar o risco de reidentificação por cruzamento e, se necessário, registrar o S6 num grupo de rotas genérico.
6. **Implementação: registros de acesso.** O plano não tem tarefa para a operação 25. Falta definir armazenamento, gestão da chave AES-GCM (segredo fora do banco), job de exclusão aos 6 meses, trilha de auditoria de cada acesso e fluxo de entrega por ordem judicial. Os registros precisam ficar fora do backup semanal do D1 (ou ter backup próprio que respeite os 6 meses), para que a exclusão aos 6 meses seja real.
7. **Implementação: IP no Better Auth.** O Better Auth grava `ipAddress` na tabela de sessão e usa o IP como chave do rate limit com `storage: "database"`. Como a política diz que a sessão não guarda IP e que o IP fica só nos registros de acesso, esses campos precisam ficar vazios ou receber o hash de IP (T3.3/T3.5).
8. **Implementação: 2FA para administradores.** Definir se o segundo fator vem do provedor de identidade do Cloudflare Access ou de um plugin de dois fatores no Better Auth.
9. **Implementação: biblioteca pública opt-in.** A tabela `profiles` (Anexo A.2) só tem `activity_visibility`; falta a preferência de biblioteca pública (padrão desligado). A T4.11 mostra criações públicas no perfil sem citar opt-in.
10. **Implementação: jobs de expurgo.** O registro de jobs (T4.12) não prevê limpeza do `audit_log` após 5 anos, da `email_suppressions` após 12 meses, de sessões e tokens expirados nem dos registros de acesso após 6 meses.
11. **Implementação: aviso de mudança da política no app.** Não há tarefa no plano para esse aviso.
12. **Dump público e apelido.** Se o dump incluir o apelido do autor (crédito exigido pela CC-BY), ele passa a conter dado pessoal público; ajustar a operação 23 e a política.
13. **S6 sem prazo máximo.** Sem o recibo, o lote não pode ser localizado. Avaliar um prazo máximo para os pares brutos (o agregado é anônimo).

---

Este documento não é aconselhamento jurídico e deve ser revisado por um advogado antes da publicação. (Q-LEGAL)
