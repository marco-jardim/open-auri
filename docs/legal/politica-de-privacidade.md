<!--
Modelo: os marcadores {{...}} são substituídos no build (prerender) a partir de variáveis de ambiente.
Variáveis usadas: PUBLIC_LGPD_CONTROLLER, PUBLIC_LGPD_CONTACT_EMAIL, PUBLIC_LGPD_CNPJ,
PUBLIC_LGPD_ADDRESS, PUBLIC_LGPD_DPO_NAME, PUBLIC_POLICY_EFFECTIVE_DATE, PUBLIC_ORIGIN.
Obrigatórias no build de produção: PUBLIC_LGPD_CONTROLLER, PUBLIC_LGPD_CONTACT_EMAIL e
PUBLIC_POLICY_EFFECTIVE_DATE. CNPJ, endereço e encarregado vazios geram aviso no build e a frase
que os contém sai do texto.
A versão abaixo acompanha POLICY_VERSION (web/src/lib/content/legal/version.ts); um teste confere.
Não coloque valores reais neste arquivo: o repositório é público.
-->

# Política de Privacidade do open-auri

**Versão:** 2026-10-20 · **Vigência:** {{PUBLIC_POLICY_EFFECTIVE_DATE}} · **Endereço:** {{PUBLIC_ORIGIN}}/privacidade

Esta é a versão oficial da política. A tradução em inglês (`privacy-policy.en-US.md`) serve apenas como apoio. Em caso de diferença, vale este texto em português.

Esta política cobre o site e o **app Android open-auri**, que abre o mesmo site em uma WebView. O app não acrescenta coleta independente à do site: o acesso USB ao cabo acontece só no aparelho, e os arquivos exportados são salvos apenas no local que você escolhe pelo seletor do Android. As requisições do site continuam sujeitas às seções abaixo, inclusive no app.

> **Resumo em 30 segundos**
>
> - Você pode usar o open-auri sem conta. Nesse caso, suas curvas, seu histórico e suas configurações ficam no seu navegador. O arquivo de áudio que você carrega **nunca** sai do seu aparelho.
> - A conta é opcional e serve para as funções sociais. Guardamos seu e-mail, um hash da senha (nunca a senha), seu apelido público e o que você escolher publicar.
> - Seu nome público é o apelido, acompanhado de um identificador público de autor aleatório e estável, que permite reconhecer o mesmo autor após trocas de apelido (seção 6). A biblioteca pública e o perfil de atividade público são opcionais e vêm desligados.
> - A lei brasileira (Marco Civil da Internet) nos obriga a guardar registros de acesso: IP, data e hora e, se você estiver conectado, sua conta, com a redução de precisão do teste cego descrita na seção 8. Guardamos por 6 meses, cifrados, e só entregamos a terceiros com ordem judicial. Não usamos esses registros para perfil, análise ou marketing.
> - O limite de taxa usa hashes do IP ou identificador com sal diário, inclusive em contadores no banco. Validade das janelas, expurgo e rotação do sal são descritos na seção 10, sem promessa de apagamento em 48 horas.
> - Não usamos cookies de análise nem de publicidade. No site de produção, inclusive na WebView Android, contamos visitas com o Simple Analytics. As alegações de ausência de dados pessoais e fingerprinting são do fornecedor, não uma auditoria nossa (seção 13). O painel das contagens é público. Não vendemos dados nem mandamos e-mail de marketing.
> - Você pode exportar seus dados, apagar sua atividade e encerrar a conta direto no app, ou escrever para **{{PUBLIC_LGPD_CONTACT_EMAIL}}**.

---

## 1. Quem somos e como falar conosco

O controlador dos dados pessoais tratados pelo open-auri ({{PUBLIC_ORIGIN}}) é:

- **{{PUBLIC_LGPD_CONTROLLER}}**
- CNPJ: {{PUBLIC_LGPD_CNPJ}}
- Endereço: {{PUBLIC_LGPD_ADDRESS}}
- Canal de privacidade e do encarregado: **{{PUBLIC_LGPD_CONTACT_EMAIL}}**
- Encarregado: {{PUBLIC_LGPD_DPO_NAME}}

Somos um agente de tratamento de pequeno porte, nos termos da Resolução CD/ANPD nº 2/2022. Mesmo nos casos em que a indicação de encarregado não é obrigatória, mantemos o canal de comunicação acima (art. 11 da Resolução) para receber pedidos, dúvidas e reclamações sobre seus dados.

## 2. Dados locais, com ou sem conta

As ferramentas locais do open-auri funcionam no navegador ou na WebView do app Android. Curvas locais, diário, lista de autores/curvas ocultos sem conta e áudio ficam no próprio aparelho (localStorage, sessionStorage e IndexedDB). A lista de ocultos de visitantes não é enviada enquanto você usa o serviço sem conta; ao entrar, ela é mesclada com a lista da conta no servidor, incluindo os rótulos em cache, e removida do armazenamento local após a sincronização bem-sucedida. O idioma também pode acompanhar requisições pelo cookie essencial; a biblioteca é sincronizada se você entrar na conta, e ações sociais da fila são enviadas quando a conexão volta:

| O que                                                 | Para quê                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Idioma (`oa.lang` e cookie `oa_lang`)                 | Mostrar o app no idioma escolhido                                                   |
| Curva atual (`oa.current`)                            | Continuar de onde você parou                                                        |
| Diário de gravações (`oa.journal`, até 500 entradas)  | Registrar o que foi gravado no cabo, inclusive gravações interrompidas              |
| Contadores de gravação (`oa.flash.*`)                 | Limitar o número de gravações por dia e por sessão, para proteger a memória do cabo |
| Referência do medidor (`oa.meter.ref`)                | Lembrar sua escolha de referência                                                   |
| Versão da política já vista (`oa.policy.seen`)        | Mostrar o aviso de mudança da política só quando ela muda                           |
| Lista local de ocultos (`oa.hidden.v1`, localStorage) | Ocultar autores e curvas sem conta, guardando o tipo e identificador do alvo e rótulos em cache (apelidos públicos de autores ou nomes de curvas); mesclar com a conta ao entrar |
| Biblioteca local (IndexedDB `library`)                | Guardar curvas e favoritos sem conta                                                |
| Fila offline (IndexedDB `outbox`)                     | Guardar ações sociais feitas sem internet até a conexão voltar (só com conta)       |
| Arquivo de áudio que você carrega (IndexedDB `audio`) | Tocar a prévia com a curva aplicada                                                 |

**O arquivo de áudio (MP3 ou outro) nunca é enviado para nossos servidores.** Todo o processamento de som e medição acontece no seu aparelho.

Os arquivos de medição que você importa (CSV ou TXT) também são lidos no navegador.

No Android, cookies e armazenamento local ficam na WebView do app, **sem backup pelo app** (backup e transferência desses dados estão desativados). A permissão USB é solicitada pelo Android para comunicar com o cabo conectado, apenas localmente. O app não envia o conteúdo USB para nós. Se você decidir compartilhar um diagnóstico, confira o arquivo antes de publicá-lo. Arquivos salvos no local escolhido por você ficam fora desse armazenamento; a retenção e eventual sincronização pelo provedor escolhido dependem de você e desse provedor.

Para apagar os dados locais da ferramenta, use **Docs > "Dados neste navegador"**; o áudio tem opção própria de remoção. Você também pode limpar os dados do site nas configurações do navegador ou os dados do app nas configurações do Android. Isso não encerra a conta nem apaga arquivos que você já salvou no local escolhido.

**Base legal:** para o conteúdo que permanece só no aparelho, não há tratamento por parte do controlador. Ele fica sob seu controle. A biblioteca e a lista de ocultos sincronizadas ao entrar seguem a seção 3. Mesmo sem conta, as requisições que o navegador faz ao nosso servidor geram registros de acesso (seção 11).

## 3. Conta opcional

A conta é necessária só para publicar, favoritar, sincronizar a biblioteca e usar as funções sociais. Toda ação social exige e-mail verificado.

A criação de conta pode ficar temporariamente indisponível enquanto o domínio usado para os e-mails transacionais não estiver verificado. O site funciona normalmente sem conta.

| Dado                                                      | Para quê                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-mail                                                    | Entrar, verificar a conta, recuperar a senha e receber avisos de segurança. O e-mail nunca é exibido publicamente                                                                                                                                                                                                       |
| Hash da senha                                             | Conferir sua senha sem guardá-la. Nunca guardamos a senha em si                                                                                                                                                                                                                                                         |
| Nome privado (`name`, se enviado à API)                    | Campo aceito pelo sistema de autenticação e incluído na exportação da conta. O formulário comum o envia vazio; não exigimos nome civil nem o exibimos publicamente |
| Apelido público (único)                                   | Identificar você publicamente pelo nome: aparece nos rankings, no feed, nos créditos das curvas, nos compartilhamentos e no endereço `{{PUBLIC_ORIGIN}}/u/[apelido]`, junto do identificador público de autor descrito abaixo. Tem de 3 a 24 caracteres, pode ser trocado a cada 30 dias e o apelido antigo fica reservado por 90 dias, redirecionando para o novo |
| Identificador público de autor (`public_author_id`)       | Cada conta recebe um identificador aleatório e estável, exposto com o perfil e o conteúdo público para que outras pessoas possam ocultar o mesmo autor mesmo após mudanças de apelido. Não é o identificador de autenticação da conta e não serve para entrar. Permite vincular o perfil entre apelidos diferentes e é apagado com a conta |
| Bio (opcional, até 280 caracteres)                        | Apresentar seu perfil, se você quiser                                                                                                                                                                                                                                                                                   |
| Registros de sessão                                       | Manter você conectado e permitir que veja e encerre sessões. Guardamos o navegador e o sistema (reduzidos a partir do user-agent) e as datas de criação, última atividade e expiração. A sessão não guarda seu IP: o sistema de autenticação roda com o rastreio de IP desligado                                        |
| Tokens de verificação de e-mail e de redefinição de senha | Confirmar que o e-mail é seu e permitir trocar a senha com segurança                                                                                                                                                                                                                                                    |
| Preferências da conta                                     | Idioma, visibilidade da atividade (privada ou pública, padrão privada), biblioteca pública (ligada ou desligada, padrão desligada) e lista de ocultos (`hidden_items`): tipo do alvo (autor ou curva), identificador público do autor ou da linhagem da curva, rótulo em cache (apelido público ou nome da curva, quando disponível) e data |
| Aceites da política (versão e data)                       | Registrar que você viu a versão atual desta política e dos termos, para não repetir o aviso de mudança                                                                                                                                                                                                                  |

Ao entrar na conta, o app mescla a biblioteca local do navegador com a biblioteca da conta, sem duplicar curvas. A partir daí, essas curvas ficam guardadas também no servidor.

A lista local de ocultos também é mesclada com a lista da conta ao entrar, sem substituir as preferências já guardadas por outros aparelhos. Com conta, as ocultações ficam no servidor, podem ser sincronizadas em outros aparelhos e não são gravadas na lista local de visitantes.

**Base legal:** execução do contrato de uso do serviço que você aceita ao criar a conta (LGPD, art. 7º, V). As preferências de visibilidade pública dependem do seu consentimento (art. 7º, I), que você pode retirar a qualquer momento nas configurações.

## 4. O que você publica

Quando você publica, guardamos e mostramos:

- curvas (os números da equalização, nome, descrição e receita);
- versões (só por acréscimo: versões antigas continuam no histórico) e forks;
- packs de curvas;
- a licença escolhida para cada curva: **CC0-1.0** ou **CC-BY-4.0**;
- compartilhamentos (links com identificador e, se você indicar, o canal).

Cada curva publicada mostra seu apelido como crédito. Você escolhe se a curva fica privada, não listada ou pública.

**A licença de uma versão publicada é irrevogável.** Você pode retirar a curva do site, mas quem já obteve uma cópia sob a licença CC pode continuar a usá-la nos termos dela.

**Base legal:** execução do contrato (art. 7º, V).

## 5. Atividade: experimentou, instalou, favoritou

Com conta, registramos três tipos de atividade sobre as curvas da comunidade:

- **experimentou:** você ouviu uma prévia da curva por pelo menos 10 segundos;
- **instalou:** você gravou a curva no cabo com sucesso (gravações simuladas não contam);
- **favoritou:** você marcou a curva como favorita.

Guardamos a curva, o tipo de atividade, a primeira e a última vez e quantas vezes ocorreu. Ações feitas offline são enviadas quando a conexão volta, e só são aceitas se tiverem até 7 dias.

**O que fica público:**

- as **contagens** (número de pessoas distintas, com conta verificada) são públicas;
- seu apelido só aparece na lista de público de um autor se você escolher **perfil de atividade público**. O padrão é **privado**. Com perfil privado, você entra só na contagem "N pessoas com perfil privado".

Você pode ver e apagar sua própria atividade a qualquer momento na sua conta.

**Base legal:** execução do contrato para o registro e as contagens (art. 7º, V); consentimento para a exibição nominal no perfil público (art. 7º, I).

## 6. Perfil público, biblioteca pública, rankings e compartilhamentos

**Perfil público.** Todo usuário com conta tem a página `{{PUBLIC_ORIGIN}}/u/[apelido]`. Com a biblioteca pública desligada, ela mostra o apelido e contagens agregadas, e seus dados públicos incluem o identificador de autor.

**Identificador público de autor.** O perfil e o conteúdo público incluem um identificador aleatório e estável (`public_author_id`), diferente do identificador de autenticação e que não serve para entrar na conta. Ele permite que outras pessoas ocultem o mesmo autor após trocas de apelido, mas também permite vincular o perfil entre apelidos diferentes. Esse identificador é apagado com a conta (seção 17); não muda quando o apelido muda.

**Biblioteca pública.** É opcional e vem **desligada**. Ligada, sua página mostra as curvas públicas que você criou e seus packs públicos, e também seus favoritos se o perfil de atividade for público. Você liga e desliga quando quiser. Em qualquer caso, cada curva que você publicou como pública continua acessível no próprio endereço, com crédito ao seu apelido. (Base legal: consentimento, art. 7º, I.)

**Rankings.** Mostramos as curvas mais favoritadas e mais instaladas em 7 dias, 30 dias e desde sempre. Os rankings usam só contagens de contas verificadas distintas e só curvas públicas. Eles não mostram quem favoritou ou instalou. (Base legal: legítimo interesse em destacar curvas relevantes para a comunidade, art. 7º, IX.)

**Compartilhamentos.** Quando você compartilha um link, contamos aberturas, prévias, instalações e favoritos vindos dele. Aberturas por pessoas sem conta entram só como uma contagem por dia, sem nenhuma identidade. Ações de pessoas com conta são associadas ao compartilhamento para formar esses números. (Base legal: execução do contrato, art. 7º, V.)

## 7. Denúncias e moderação

Pessoas com conta verificada podem denunciar conteúdo. Guardamos o alvo, o motivo, uma nota opcional, quem denunciou, a data e a decisão. Nesta release, você também pode escolher "Ocultar este autor" ou "Ocultar esta curva": sem conta, a preferência fica no aparelho; com conta, é guardada e sincronizada como preferência da conta. Essa escolha altera só a sua visualização, não remove o conteúdo para outras pessoas e pode ser desfeita.

Uma curva é ocultada automaticamente quando 3 contas verificadas diferentes, com 3 dias ou mais de existência, a denunciam; uma curva cuja versão atual é YOLO é ocultada já com 2 dessas contas. Essa ocultação é revista pela moderação, que pode restaurar o conteúdo. Se você foi afetado, pode pedir a revisão dessa decisão automatizada (art. 20) pelo canal {{PUBLIC_LGPD_CONTACT_EMAIL}}.

As ações de moderação (ocultar, restaurar, retirar, banir, marcar curadoria) ficam num registro de auditoria com autor da ação, ação, alvo, detalhe e data.

**Base legal:** legítimo interesse em manter o serviço seguro e cumprir nossos termos (art. 7º, IX) e, para o registro de auditoria, também o exercício regular de direitos em processos (art. 7º, VI).

## 8. Teste cego anônimo (S6)

No teste cego, você pode, se quiser, enviar suas preferências para formar o resultado "Comunidade prefere".

- O envio só acontece com seu **consentimento explícito**, pedido na hora, com texto próprio. Como preferências de audição podem estar relacionadas à saúde, tratamos esses dados como sensíveis.
- **O lote não tem conta nem IP.** Ele contém só os pares A/B comparados, as escolhas, se o volume foi igualado, o dia do envio e a versão do termo de consentimento.
- O envio gera um registro de acesso separado (seção 11), sem conteúdo do lote nem recibo. **O lote é inserido diretamente, sem atraso aleatório.** É a mensagem do registro de acesso que recebe atraso aleatório: ela contém IP e timestamp original enquanto está na fila cifrada. No objeto final, o registro não tem conta, usa grupo de rotas genérico e guarda só o dia, em vez da hora, para reduzir o risco de cruzamento. Isso não garante anonimato absoluto.
- Um **recibo aleatório** fica guardado só no seu aparelho. No servidor fica apenas um hash dele. Com o recibo você retira o consentimento e apaga seu lote.
- Como não sabemos quem você é, **sem o recibo não conseguimos localizar seu lote**.
- **Prazo máximo de 24 meses:** mesmo sem a retirada, o lote e seus pares são apagados automaticamente quando completam 24 meses do dia do envio.
- Os resultados agregados (Bradley–Terry) são anônimos e publicados.

O envio é protegido por Turnstile e por limite de taxa com hash do IP. Esse hash não fica no lote.

**Base legal:** consentimento específico e destacado (art. 11, I).

## 9. Troca às cegas (S7)

Na troca às cegas, duas pessoas com conta trocam curvas sem saber de quem são. Guardamos sua participação, a curva e versão oferecidas, o pareamento, a nota que você deu e as datas. As curvas e as notas são reveladas aos dois depois que ambos avaliam. Uma troca não pareada expira em 72 horas. Mostramos médias de nota por curva.

**Base legal:** execução do contrato (art. 7º, V).

## 10. Segurança: proteção contra robôs e abuso

- **Cloudflare Turnstile.** Usamos o Turnstile para diferenciar pessoas de robôs no cadastro, na entrada, na recuperação de senha, na troca de e-mail, nas denúncias e no envio do teste cego. O Turnstile é operado pela Cloudflare, que trata dados técnicos do navegador conforme o [Adendo de Privacidade do Turnstile](https://www.cloudflare.com/turnstile-privacy-policy/). O widget roda no seu navegador e se comunica diretamente com a Cloudflare. Quando nosso servidor confere o resultado, não enviamos seu IP.
- **Limite de taxa.** Para impedir abuso, contamos requisições por rota, usuário e por HMAC do IP ou identificador (por exemplo, e-mail), com chave secreta e sal que muda todo dia. Há contadores de rajada na Cloudflare e de janela no banco D1 (`rate_limit_counters`), sem IP ou e-mail em claro. No D1, a expiração é definida para o início mais duas janelas; o job diário remove fisicamente os contadores expirados, podendo atrasar se falhar. A rotação conserva os sais de hoje e de ontem e apaga os anteriores a ontem; há TTL de segurança de 3 dias desde o início do dia do sal. Enquanto existirem sal e chave, o hash é reproduzível. Esses dados servem só ao limite de taxa, não a análise ou publicidade.
- **IP no código próprio.** O sistema de autenticação roda com o rastreio de IP desligado. Não guardamos IP em claro na conta, na sessão ou nos registros operacionais da aplicação. Os registros legais e os hashes acima são fluxos distintos. Isso não impede o recebimento técnico de IP por fornecedores nas conexões com seus serviços.
- **Registros da plataforma.** A Cloudflare, como operadora, mantém registros técnicos da plataforma com retenção própria, definida por ela. Nossos registros operacionais da aplicação não contêm dados pessoais (só identificador de requisição, rota, tempo de resposta, status e código de erro).

**Base legal:** legítimo interesse em proteger o serviço e as contas contra fraude e abuso (art. 7º, IX).

## 11. Registros de acesso (Marco Civil da Internet)

A Lei nº 12.965/2014 (Marco Civil da Internet) obriga provedores de aplicações a guardar os registros de acesso a aplicações de internet (art. 5º, VIII, e art. 15). Por isso, para cada requisição dinâmica atendida pela aplicação, guardamos:

- endereço IP e, quando disponível, a porta de origem (necessária para distinguir conexões que compartilham o mesmo IP);
- data e hora, com fuso horário;
- identificador da conta, se você estiver conectado;
- tipo de requisição (grupo de rotas, por exemplo "conta", "curvas" ou "teste cego", sem os parâmetros do endereço) e o status da resposta.

Arquivos estáticos entregues diretamente pela CDN (páginas pré-geradas, scripts, fontes, imagens) não passam pela aplicação e não entram nesses registros.

No envio do teste cego S6, aplica-se a exceção da seção 8: sem conta, grupo genérico e apenas dia no objeto final. A fila cifrada ainda contém o timestamp original.

Como guardamos e usamos:

- **prazo:** 6 meses; depois, os registros são apagados automaticamente. A guarda só se estende se uma autoridade pedir, nos termos do art. 15, §2º, do Marco Civil;
- **segurança:** cifrados antes de entrar na fila e em repouso (AES-GCM), em lotes por hora (por dia para S6), com chave guardada fora do banco de dados, em ambiente controlado e seguro, com acesso restrito. Ficam fora dos backups e do dump público, para que a exclusão em 6 meses seja real;
- **entrega a terceiros:** só mediante ordem judicial (art. 10 e art. 15, §3º, do Marco Civil);
- **auditoria:** todo acesso a esses registros fica anotado no registro de auditoria;
- **finalidade única:** cumprir a lei. Não usamos o IP nem esses registros para perfil, análise de uso ou marketing.

**Base legal:** cumprimento de obrigação legal (LGPD, art. 7º, II).

## 12. E-mails

Enviamos só e-mails transacionais, pela Resend (operadora), que recebe seu endereço de e-mail e o conteúdo da mensagem:

- verificação de e-mail;
- redefinição de senha;
- troca de e-mail (confirmação no endereço novo e aviso no endereço antigo);
- aviso de senha alterada;
- confirmação de encerramento de conta e aviso de conta encerrada.

**Sem marketing e sem pixels de rastreamento.** Não guardamos cópia dos e-mails enviados. Se um e-mail volta (bounce) ou é marcado como spam, guardamos um hash do endereço para não insistir no envio.

**Base legal:** execução do contrato (art. 7º, V); para a lista de supressão, legítimo interesse (art. 7º, IX).

## 13. Cookies e armazenamento local

Usamos **só cookies essenciais**:

| Cookie                                                  | Para quê              | Duração                               |
| ------------------------------------------------------- | --------------------- | ------------------------------------- |
| Cookie de sessão (`Secure`, `HttpOnly`, `SameSite=Lax`) | Manter você conectado | Até sair, revogar ou expirar a sessão |
| `oa_lang`                                               | Lembrar o idioma      | Até você apagar                       |

Não usamos cookies de análise, de publicidade nem de terceiros para rastreamento. Por isso não mostramos banner de consentimento: esta política é a forma de informar você. A Cloudflare pode usar mecanismos estritamente necessários de segurança, conforme a política dela.

**Contagem de visitas (Simple Analytics).** No site de produção (`open-auri.com`), as páginas carregam o script do Simple Analytics, um serviço de estatísticas focado em privacidade, que conta as visitas às páginas. Segundo o fornecedor, ele não usa cookies, não coleta dados pessoais e não usa impressão digital do navegador (fingerprinting). O script é carregado direto do Simple Analytics e envia a contagem para os servidores dele. Ambientes de teste e de desenvolvimento não carregam o script. As contagens são públicas: o link "Estatísticas públicas", no rodapé de todas as páginas, abre o [painel do open-auri no Simple Analytics](https://dashboard.simpleanalytics.com/open-auri.com). O que o serviço registra está na [documentação do Simple Analytics](https://docs.simpleanalytics.com/what-we-collect), e as regras do próprio serviço estão na [política de privacidade do Simple Analytics](https://simpleanalytics.com/privacy-policy).

O provedor de análise pode derivar um país aproximado a partir do fuso horário do navegador, para estatísticas de visitas, sem exigir conta.

Essas descrições de privacidade são alegações do fornecedor: não auditamos aqui a versão remota do script nem todos os sinais do Turnstile. Carregar scripts e enviar contagens envolve conexões que expõem tecnicamente o IP ao destinatário; ausência de cookies não significa ausência de transmissão. O app Android usa essas mesmas páginas e acrescenta o marcador de app/versão ao user-agent das requisições, um sinal técnico, não um serviço extra de telemetria nativa.

O armazenamento local do navegador está descrito na seção 2. O app também guarda uma cópia de si mesmo (service worker) para funcionar offline. Essa cópia não contém dados pessoais.

## 14. Quem trata dados para nós e transferência internacional

| Operador             | O que faz                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare, Inc.** | Hospedagem e processamento (Workers, banco D1, armazenamento R2, KV e filas), registros de acesso cifrados, limite de taxa, Turnstile, registros da plataforma e, se for ativada, uma camada opcional de controle de acesso à administração (Cloudflare Access) |
| **Resend**           | Envio dos e-mails transacionais e avisos de bounce e reclamação                                                                                                                                                                                                 |

Esses fornecedores processam dados nos Estados Unidos e em outros países onde operam. Essa **transferência internacional** (LGPD, art. 33) se apoia nas cláusulas-padrão contratuais aprovadas pela Resolução CD/ANPD nº 19/2024 e nos acordos de tratamento de dados (DPAs) dos fornecedores.

O Simple Analytics também recebe as conexões e as contagens descritas na seção 13. A alegação de não coletar dados pessoais é do fornecedor; o enquadramento contratual e a retenção desse serviço ainda exigem confirmação. Não o omitimos dos destinatários com base apenas na ausência de cookies.

Não vendemos nem alugamos dados. Os destinatários são os serviços descritos nesta política, para suas finalidades, as pessoas que acessam conteúdo que você escolhe tornar público e as autoridades quando a lei ou uma ordem judicial exigir.

## 15. Por quanto tempo guardamos

| Dado                                                                             | Prazo                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dados no navegador (seção 2)                                                     | Até você apagar. O diário guarda as últimas 500 entradas                                                                                                                                                                                                                                                                                                                                                                                             |
| Conta: e-mail, hash da senha, nome privado se enviado, apelido, identificador público de autor, bio, preferências e aceites da política | Até o encerramento da conta |
| Lista de ocultos da conta (`hidden_items`), incluindo rótulos em cache | Até você desfazer a ocultação ou encerrar a conta |
| Apelido antigo, depois de uma troca                                              | Reservado por 90 dias, redirecionando para o novo; depois fica livre                                                                                                                                                                                                                                                                                                                                                                                 |
| Sessões                                                                          | Até expirar, você sair ou revogar                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tokens de verificação e de redefinição de senha                                  | Até serem usados ou expirarem                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Curvas, versões, forks, packs e compartilhamentos                                | Até você apagar ou retirar, ou até o encerramento da conta (veja a seção 17)                                                                                                                                                                                                                                                                                                                                                                         |
| Atividade e favoritos                                                            | Até você apagar ou encerrar a conta                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Trocas às cegas (S7)                                                             | Não pareadas: expiram em 72 horas. Concluídas: até o encerramento da conta. As médias por curva não identificam ninguém                                                                                                                                                                                                                                                                                                                              |
| Teste cego anônimo (S6)                                                          | Até você retirar o consentimento com o recibo, por no máximo 24 meses: depois disso, o lote e seus pares são apagados automaticamente. Resultados agregados são anônimos, continuam publicados e passam a refletir os lotes dos últimos 24 meses                                                                                                                                                                                                     |
| Denúncias                                                                        | Enquanto sua conta existir. No encerramento, o vínculo com você é apagado                                                                                                                                                                                                                                                                                                                                                                            |
| Pedidos enviados a {{PUBLIC_LGPD_CONTACT_EMAIL}} e nossas respostas              | 5 anos após a resposta, para comprovar que atendemos o pedido                                                                                                                                                                                                                                                                                                                                                                                        |
| Registro de auditoria da moderação e dos acessos aos registros de acesso         | 5 anos. Esse prazo acompanha o prazo de 5 anos para ações de reparação do Código de Defesa do Consumidor (art. 27) e permite defender decisões de moderação em eventuais processos                                                                                                                                                                                                                                                                   |
| Registros de acesso (IP, porta, data e hora com fuso, conta, tipo de requisição) | 6 meses, depois apagados automaticamente (Marco Civil da Internet, art. 15), salvo pedido de autoridade para guarda maior (art. 15, §2º)                                                                                                                                                                                                                                                                                                             |
| Hashes e contadores para limite de taxa | Expiração no D1: início mais duas janelas; remoção física pelo job diário após expirar, sujeita a atraso. Sal de hoje e de ontem conservado, anteriores apagados na rotação; TTL de segurança de 3 dias desde o início do dia do sal (seção 10) |
| Hash do e-mail na lista de supressão | Elegível ao expurgo pelo job após 12 meses da primeira inserção (`created_at`). Bounces/reclamações repetidos não renovam essa data |
| Registros da plataforma Cloudflare                                               | Conforme a retenção definida pela Cloudflare                                                                                                                                                                                                                                                                                                                                                                                                         |
| Cópias de segurança (backups) | Semana ISO atual e 12 anteriores; semanas anteriores ao corte são apagadas após concluir um manifesto. Não é um limite de 12 semanas exatas. Dados apagados podem permanecer nessas cópias sem uso; falhas ou atrasos do job podem prolongar a permanência e exigem acompanhamento. Excluem registros de acesso e contadores de rate limit; progresso em KV pode conter IDs. Restaurações devem reaplicar as exclusões |
| Dump público semanal                                                             | Publicado só pelo endereço `{{PUBLIC_ORIGIN}}/dados/dump/latest.json.gz` e pelas edições datadas em `{{PUBLIC_ORIGIN}}/dados/dump/AAAA-MM-DD.json.gz`. O armazenamento onde os arquivos ficam não é público. Cada novo dump reflete exclusões e anonimizações. Contém só dados públicos: curvas públicas, versões, licenças, o apelido creditado e números agregados. Não contém e-mail, atividade individual, hashes, IPs nem outros dados de conta |

## 16. Seus direitos e como exercer

Pela LGPD (art. 18), você pode pedir:

- confirmação de que tratamos seus dados e acesso a eles;
- correção de dados incompletos, inexatos ou desatualizados;
- anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados em desconformidade com a lei;
- portabilidade;
- eliminação dos dados tratados com seu consentimento;
- informação sobre com quem compartilhamos seus dados;
- informação sobre a possibilidade de não dar consentimento e suas consequências;
- revogação do consentimento;
- oposição a tratamento feito com base em legítimo interesse, quando houver descumprimento da lei;
- revisão de decisões tomadas só por meios automatizados (art. 20).

**No app, sem precisar escrever para nós:**

- **corrigir:** edite apelido (uma troca a cada 30 dias), bio e preferências no perfil, e troque e-mail e senha em `{{PUBLIC_ORIGIN}}/conta`;
- **acessar e levar seus dados:** use "Exportar meus dados" para baixar um arquivo JSON com conta, perfil, identificador público de autor, curvas, versões, favoritos, atividade, compartilhamentos e lista de ocultos (`hiddenItems`, com tipo e identificador do alvo, rótulo em cache e data). Esses rótulos podem incluir apelidos públicos de outras pessoas e nomes de curvas;
- **apagar atividade:** veja e apague sua atividade na conta;
- **retirar consentimento:** torne a atividade privada, desligue a biblioteca pública ou use o recibo do teste cego;
- **encerrar a conta:** veja a seção 17;
- **dados no navegador:** apague em Docs > "Dados neste navegador".

**Por e-mail:** escreva para **{{PUBLIC_LGPD_CONTACT_EMAIL}}**. Podemos pedir uma confirmação de que a conta é sua antes de atender. Respondemos de forma simplificada assim que possível e, quando você pedir uma declaração completa, em **até 15 dias** (art. 19, II).

Os registros de acesso (seção 11) são guardados por obrigação legal. Por isso, não podem ser apagados antes do fim dos 6 meses (LGPD, art. 16, I). Pedidos seus de acesso aos próprios registros são analisados por este canal, com verificação de identidade. A terceiros, eles só são entregues mediante ordem judicial.

Se não ficar satisfeito, você pode peticionar à **Autoridade Nacional de Proteção de Dados (ANPD)**.

## 17. Encerrar a conta

Você encerra a conta em `{{PUBLIC_ORIGIN}}/conta`, com sua senha e uma confirmação por e-mail. Antes, você escolhe o que fazer com as curvas públicas que publicou sob licença CC:

- **manter anonimizadas:** as curvas continuam no site com o crédito "autor removido", sem ligação com você; ou
- **apagar tudo:** as curvas são retiradas do site.

Em qualquer caso, **o conteúdo privado é sempre apagado**, junto com e-mail, hash da senha, perfil, apelido, identificador público de autor, sessões, tokens, favoritos, atividade, lista de ocultos da conta (`hidden_items`, incluindo rótulos em cache) e aceites da política.

Os registros de acesso ligados à conta continuam guardados até completar 6 meses, como exige o Marco Civil da Internet, e depois são apagados automaticamente. Nos backups, dados apagados podem permanecer sem uso até o expurgo por semana ISO, sujeito aos atrasos descritos na seção 15; não prometemos apagamento em 12 semanas exatas.

Lembre que a licença CC de versões publicadas é irrevogável: cópias e forks que outras pessoas já fizeram, e dumps públicos já distribuídos, continuam válidos e não podem ser recolhidos.

## 18. Menores de idade

O app é destinado a pessoas com **18 anos ou mais**, inclusive no uso sem conta, e não é direcionado a menores de idade. Contas também exigem 18 anos ou mais. Esse é um requisito de uso, não uma verificação técnica de idade: o cadastro atual não pede data de nascimento nem comprovação etária. Sem conta, as ferramentas locais ficam no aparelho, mas requisições, estatísticas e o envio opcional do S6 seguem esta política.

## 19. Como protegemos os dados

- conexão sempre cifrada (HTTPS com HSTS) e cabeçalhos de segurança (CSP com nonce, proteção contra enquadramento e outros);
- senha guardada só como hash com sal, com mínimo de 10 caracteres e verificação de força;
- cookies de sessão `Secure`, `HttpOnly` e `SameSite=Lax`, checagem de origem e proteção contra CSRF;
- encerramento das outras sessões ao redefinir a senha;
- respostas iguais para e-mail cadastrado ou não, para dificultar a descoberta de contas;
- Turnstile e limite de taxa, com hash de IP de curta duração;
- registros de acesso cifrados em repouso (AES-GCM), com acesso restrito e auditado;
- administração restrita a contas com papel de administrador e autenticação em dois fatores obrigatória, com nova autenticação recente exigida para ações destrutivas e registro de auditoria (o Cloudflare Access pode ser ativado como camada extra opcional);
- registros operacionais da aplicação sem dados pessoais;
- coleta mínima: o áudio e o diário de gravações ficam no seu aparelho;
- backups semanais com prazo de retenção limitado.

Nenhum sistema é totalmente seguro, mas revisamos essas medidas ao longo do tempo.

## 20. Incidentes de segurança

Se ocorrer um incidente de segurança que possa causar risco ou dano relevante a você, comunicaremos a ANPD e as pessoas afetadas, como manda o art. 48 da LGPD e no prazo da regulamentação da ANPD. Avisaremos por e-mail quem tiver conta e por aviso no app.

## 21. Dados públicos de medição

O app traz embutidos medições e alvos públicos de fones de ouvido do projeto AutoEq, com atribuição da fonte e licença MIT. Esses dados vêm dentro do próprio app: consultá-los não faz nenhuma requisição ao AutoEq nem a terceiros. Eles descrevem equipamentos, não pessoas, e não contêm dados pessoais.

## 22. Mudanças nesta política

Esta política tem versão e data de vigência. Quando houver mudança relevante, publicaremos a nova versão com a nova data e mostraremos um aviso no app. Com conta, registramos a versão e a data em que você confirmou o aviso. Sem conta, essa marca fica só no seu navegador (`oa.policy.seen`). Se a mudança exigir novo consentimento, pediremos de novo.

## 23. Lei aplicável

Esta política segue a lei brasileira, em especial a Lei nº 13.709/2018 (LGPD) e a Lei nº 12.965/2014 (Marco Civil da Internet).
