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

**Versão:** 2026-10-16 · **Vigência:** {{PUBLIC_POLICY_EFFECTIVE_DATE}} · **Endereço:** {{PUBLIC_ORIGIN}}/privacidade

Esta é a versão oficial da política. A tradução em inglês (`privacy-policy.en-US.md`) serve apenas como apoio. Em caso de diferença, vale este texto em português.

> **Resumo em 30 segundos**
>
> - Você pode usar o open-auri sem conta. Nesse caso, suas curvas, seu histórico e suas configurações ficam no seu navegador. O arquivo de áudio que você carrega **nunca** sai do seu aparelho.
> - A conta é opcional e serve para as funções sociais. Guardamos seu e-mail, um hash da senha (nunca a senha), seu apelido público e o que você escolher publicar.
> - Publicamente, você aparece só pelo apelido. A biblioteca pública e o perfil de atividade público são opcionais e vêm desligados.
> - A lei brasileira (Marco Civil da Internet) nos obriga a guardar registros de acesso: IP, data e hora e, se você estiver conectado, sua conta. Guardamos por 6 meses, cifrados, e só entregamos a terceiros com ordem judicial. Não usamos o IP para mais nada: sem perfil, sem análise, sem marketing.
> - Fora desses registros, seu IP não fica guardado: o limite de taxa usa um hash do IP com sal diário, apagado em até 48 horas.
> - Não usamos cookies de análise nem de publicidade. Não vendemos dados. Não mandamos e-mail de marketing.
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

## 2. Usar sem conta: tudo fica no seu navegador

Sem conta, o open-auri funciona inteiramente no seu navegador. Os dados abaixo ficam guardados no próprio aparelho (localStorage, sessionStorage e IndexedDB) e **não são enviados para nós**:

| O que | Para quê |
|---|---|
| Idioma (`oa.lang` e cookie `oa_lang`) | Mostrar o app no idioma escolhido |
| Curva atual (`oa.current`) | Continuar de onde você parou |
| Diário de gravações (`oa.journal`, até 500 entradas) | Registrar o que foi gravado no cabo, inclusive gravações interrompidas |
| Contadores de gravação (`oa.flash.*`) | Limitar o número de gravações por dia e por sessão, para proteger a memória do cabo |
| Referência do medidor (`oa.meter.ref`) | Lembrar sua escolha de referência |
| Versão da política já vista (`oa.policy.seen`) | Mostrar o aviso de mudança da política só quando ela muda |
| Biblioteca local (IndexedDB `library`) | Guardar curvas e favoritos sem conta |
| Fila offline (IndexedDB `outbox`) | Guardar ações sociais feitas sem internet até a conexão voltar (só com conta) |
| Arquivo de áudio que você carrega (IndexedDB `audio`) | Tocar a prévia com a curva aplicada |

**O arquivo de áudio (MP3 ou outro) nunca é enviado para nossos servidores.** Todo o processamento de som e medição acontece no seu aparelho.

Os arquivos de medição que você importa (CSV ou TXT) também são lidos no navegador.

Para apagar tudo isso, use **Docs > "Dados neste navegador"**. Você também pode limpar os dados do site nas configurações do navegador.

**Base legal:** como esses dados não chegam até nós, não há tratamento por parte do controlador. Eles ficam sob seu controle. Mesmo sem conta, as requisições que o navegador faz ao nosso servidor geram registros de acesso (seção 11).

## 3. Conta opcional

A conta é necessária só para publicar, favoritar, sincronizar a biblioteca e usar as funções sociais. Toda ação social exige e-mail verificado.

A criação de conta pode ficar temporariamente indisponível enquanto o domínio usado para os e-mails transacionais não estiver verificado. O site funciona normalmente sem conta.

| Dado | Para quê |
|---|---|
| E-mail | Entrar, verificar a conta, recuperar a senha e receber avisos de segurança. O e-mail nunca é exibido publicamente |
| Hash da senha | Conferir sua senha sem guardá-la. Nunca guardamos a senha em si |
| Apelido público (único) | Identificar você publicamente. É o único nome exibido: aparece nos rankings, no feed, nos créditos das curvas, nos compartilhamentos e no endereço `{{PUBLIC_ORIGIN}}/u/[apelido]`. Tem de 3 a 24 caracteres, pode ser trocado a cada 30 dias e o apelido antigo fica reservado por 90 dias, redirecionando para o novo |
| Bio (opcional, até 280 caracteres) | Apresentar seu perfil, se você quiser |
| Registros de sessão | Manter você conectado e permitir que veja e encerre sessões. Guardamos o navegador e o sistema (reduzidos a partir do user-agent) e as datas de criação, última atividade e expiração. A sessão não guarda seu IP: o sistema de autenticação roda com o rastreio de IP desligado |
| Tokens de verificação de e-mail e de redefinição de senha | Confirmar que o e-mail é seu e permitir trocar a senha com segurança |
| Preferências da conta | Idioma, visibilidade da atividade (privada ou pública, padrão privada) e biblioteca pública (ligada ou desligada, padrão desligada) |
| Aceites da política (versão e data) | Registrar que você viu a versão atual desta política e dos termos, para não repetir o aviso de mudança |

Ao entrar na conta, o app mescla a biblioteca local do navegador com a biblioteca da conta, sem duplicar curvas. A partir daí, essas curvas ficam guardadas também no servidor.

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

**Perfil público.** Todo usuário com conta tem a página `{{PUBLIC_ORIGIN}}/u/[apelido]`. Com a biblioteca pública desligada, ela mostra só o apelido e contagens agregadas.

**Biblioteca pública.** É opcional e vem **desligada**. Ligada, sua página mostra as curvas públicas que você criou e seus packs públicos, e também seus favoritos se o perfil de atividade for público. Você liga e desliga quando quiser. Em qualquer caso, cada curva que você publicou como pública continua acessível no próprio endereço, com crédito ao seu apelido. (Base legal: consentimento, art. 7º, I.)

**Rankings.** Mostramos as curvas mais favoritadas e mais instaladas em 7 dias, 30 dias e desde sempre. Os rankings usam só contagens de contas verificadas distintas e só curvas públicas. Eles não mostram quem favoritou ou instalou. (Base legal: legítimo interesse em destacar curvas relevantes para a comunidade, art. 7º, IX.)

**Compartilhamentos.** Quando você compartilha um link, contamos aberturas, prévias, instalações e favoritos vindos dele. Aberturas por pessoas sem conta entram só como uma contagem por dia, sem nenhuma identidade. Ações de pessoas com conta são associadas ao compartilhamento para formar esses números. (Base legal: execução do contrato, art. 7º, V.)

## 7. Denúncias e moderação

Pessoas com conta verificada podem denunciar conteúdo. Guardamos o alvo, o motivo, uma nota opcional, quem denunciou, a data e a decisão.

Uma curva é ocultada automaticamente quando 3 contas verificadas diferentes, com 3 dias ou mais de existência, a denunciam. Essa ocultação é revista pela moderação, que pode restaurar o conteúdo. Se você foi afetado, pode pedir a revisão dessa decisão automatizada (art. 20) pelo canal {{PUBLIC_LGPD_CONTACT_EMAIL}}.

As ações de moderação (ocultar, restaurar, retirar, banir, marcar curadoria) ficam num registro de auditoria com autor da ação, ação, alvo, detalhe e data.

**Base legal:** legítimo interesse em manter o serviço seguro e cumprir nossos termos (art. 7º, IX) e, para o registro de auditoria, também o exercício regular de direitos em processos (art. 7º, VI).

## 8. Teste cego anônimo (S6)

No teste cego, você pode, se quiser, enviar suas preferências para formar o resultado "Comunidade prefere".

- O envio só acontece com seu **consentimento explícito**, pedido na hora, com texto próprio. Como preferências de audição podem estar relacionadas à saúde, tratamos esses dados como sensíveis.
- **O lote não tem conta nem IP.** Ele contém só os pares A/B comparados, as escolhas, se o volume foi igualado, o dia do envio e a versão do termo de consentimento.
- Como toda requisição ao servidor, o envio gera um registro de acesso (seção 11) com IP, data, hora e o tipo de requisição. Esse registro não contém o conteúdo do lote nem o recibo, e o lote é gravado com atraso aleatório para dificultar o cruzamento.
- Um **recibo aleatório** fica guardado só no seu aparelho. No servidor fica apenas um hash dele. Com o recibo você retira o consentimento e apaga seu lote.
- Como não sabemos quem você é, **sem o recibo não conseguimos localizar seu lote**.
- Os resultados agregados (Bradley–Terry) são anônimos e publicados.

O envio é protegido por Turnstile e por limite de taxa com hash do IP. Esse hash não fica no lote.

**Base legal:** consentimento específico e destacado (art. 11, I).

## 9. Troca às cegas (S7)

Na troca às cegas, duas pessoas com conta trocam curvas sem saber de quem são. Guardamos sua participação, a curva e versão oferecidas, o pareamento, a nota que você deu e as datas. As curvas e as notas são reveladas aos dois depois que ambos avaliam. Uma troca não pareada expira em 72 horas. Mostramos médias de nota por curva.

**Base legal:** execução do contrato (art. 7º, V).

## 10. Segurança: proteção contra robôs e abuso

- **Cloudflare Turnstile.** Usamos o Turnstile para diferenciar pessoas de robôs no cadastro, na entrada, na recuperação de senha, na troca de e-mail, nas denúncias e no envio do teste cego. O Turnstile é operado pela Cloudflare, que trata dados técnicos do navegador conforme o [Adendo de Privacidade do Turnstile](https://www.cloudflare.com/turnstile-privacy-policy/). O widget roda no seu navegador e se comunica diretamente com a Cloudflare. Quando nosso servidor confere o resultado, não enviamos seu IP.
- **Limite de taxa.** Para impedir abuso, contamos requisições por rota usando um HMAC do seu IP com uma chave secreta e um sal que muda todo dia. O sal antigo é apagado na rotação e os hashes são apagados em até 48 horas. Esse hash serve só para o limite de taxa.
- **Nenhum outro IP guardado.** Fora dos registros de acesso (seção 11), não guardamos seu IP em lugar nenhum: nem na conta, nem na sessão, nem nos registros operacionais. O sistema de autenticação roda com o rastreio de IP desligado.
- **Registros da plataforma.** A Cloudflare, como operadora, mantém registros técnicos da plataforma com retenção própria, definida por ela. Nossos registros operacionais da aplicação não contêm dados pessoais (só identificador de requisição, rota, tempo de resposta, status e código de erro).

**Base legal:** legítimo interesse em proteger o serviço e as contas contra fraude e abuso (art. 7º, IX).

## 11. Registros de acesso (Marco Civil da Internet)

A Lei nº 12.965/2014 (Marco Civil da Internet) obriga provedores de aplicações a guardar os registros de acesso a aplicações de internet (art. 5º, VIII, e art. 15). Por isso, para cada requisição dinâmica atendida pela aplicação, guardamos:

- endereço IP e, quando disponível, a porta de origem (necessária para distinguir conexões que compartilham o mesmo IP);
- data e hora, com fuso horário;
- identificador da conta, se você estiver conectado;
- tipo de requisição (grupo de rotas, por exemplo "conta", "curvas" ou "teste cego", sem os parâmetros do endereço) e o status da resposta.

Arquivos estáticos entregues diretamente pela CDN (páginas pré-geradas, scripts, fontes, imagens) não passam pela aplicação e não entram nesses registros.

Como guardamos e usamos:

- **prazo:** 6 meses; depois, os registros são apagados automaticamente. A guarda só se estende se uma autoridade pedir, nos termos do art. 15, §2º, do Marco Civil;
- **segurança:** cifrados em repouso (AES-GCM) em lotes por hora, com chave guardada fora do banco de dados, em ambiente controlado e seguro, com acesso restrito. Ficam fora dos backups e do dump público, para que a exclusão em 6 meses seja real;
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

| Cookie | Para quê | Duração |
|---|---|---|
| Cookie de sessão (`Secure`, `HttpOnly`, `SameSite=Lax`) | Manter você conectado | Até sair, revogar ou expirar a sessão |
| `oa_lang` | Lembrar o idioma | Até você apagar |

Não usamos cookies de análise, de publicidade nem de terceiros para rastreamento. Por isso não mostramos banner de consentimento: esta política é a forma de informar você. A Cloudflare pode usar mecanismos estritamente necessários de segurança, conforme a política dela.

O armazenamento local do navegador está descrito na seção 2. O app também guarda uma cópia de si mesmo (service worker) para funcionar offline. Essa cópia não contém dados pessoais.

## 14. Quem trata dados para nós e transferência internacional

| Operador | O que faz |
|---|---|
| **Cloudflare, Inc.** | Hospedagem e processamento (Workers, banco D1, armazenamento R2, KV e filas), registros de acesso cifrados, limite de taxa, Turnstile, registros da plataforma e controle de acesso da administração (Cloudflare Access) |
| **Resend** | Envio dos e-mails transacionais e avisos de bounce e reclamação |

Esses fornecedores processam dados nos Estados Unidos e em outros países onde operam. Essa **transferência internacional** (LGPD, art. 33) se apoia nas cláusulas-padrão contratuais aprovadas pela Resolução CD/ANPD nº 19/2024 e nos acordos de tratamento de dados (DPAs) dos fornecedores.

Não vendemos nem alugamos dados. Só compartilhamos dados com esses operadores, para as finalidades desta política, ou com autoridades quando a lei ou uma ordem judicial exigir.

## 15. Por quanto tempo guardamos

| Dado | Prazo |
|---|---|
| Dados no navegador (seção 2) | Até você apagar. O diário guarda as últimas 500 entradas |
| Conta: e-mail, hash da senha, apelido, bio, preferências e aceites da política | Até o encerramento da conta |
| Apelido antigo, depois de uma troca | Reservado por 90 dias, redirecionando para o novo; depois fica livre |
| Sessões | Até expirar, você sair ou revogar |
| Tokens de verificação e de redefinição de senha | Até serem usados ou expirarem |
| Curvas, versões, forks, packs e compartilhamentos | Até você apagar ou retirar, ou até o encerramento da conta (veja a seção 17) |
| Atividade e favoritos | Até você apagar ou encerrar a conta |
| Trocas às cegas (S7) | Não pareadas: expiram em 72 horas. Concluídas: até o encerramento da conta. As médias por curva não identificam ninguém |
| Teste cego anônimo (S6) | Até você retirar o consentimento com o recibo. Resultados agregados são anônimos e permanecem |
| Denúncias | Enquanto sua conta existir. No encerramento, o vínculo com você é apagado |
| Pedidos enviados a {{PUBLIC_LGPD_CONTACT_EMAIL}} e nossas respostas | 5 anos após a resposta, para comprovar que atendemos o pedido |
| Registro de auditoria da moderação e dos acessos aos registros de acesso | 5 anos. Esse prazo acompanha o prazo de 5 anos para ações de reparação do Código de Defesa do Consumidor (art. 27) e permite defender decisões de moderação em eventuais processos |
| Registros de acesso (IP, porta, data e hora com fuso, conta, tipo de requisição) | 6 meses, depois apagados automaticamente (Marco Civil da Internet, art. 15), salvo pedido de autoridade para guarda maior (art. 15, §2º) |
| Hash do IP para limite de taxa | Até 48 horas. O sal diário é apagado na rotação |
| Hash do e-mail na lista de supressão | Até 12 meses após o último bounce ou reclamação |
| Registros da plataforma Cloudflare | Conforme a retenção definida pela Cloudflare |
| Cópias de segurança (backups) | Até 12 semanas. Dados apagados podem permanecer nos backups por até 12 semanas, sem uso, até serem sobrescritos |
| Dump público semanal | Contém só dados públicos: curvas públicas, versões, licenças, o apelido creditado e números agregados. Não contém e-mail, atividade individual, hashes, IPs nem outros dados de conta |

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
- **acessar e levar seus dados:** use "Exportar meus dados" para baixar um arquivo JSON com conta, perfil, curvas, versões, favoritos, atividade e compartilhamentos;
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

Em qualquer caso, **o conteúdo privado é sempre apagado**, junto com e-mail, hash da senha, perfil, apelido, sessões, tokens, favoritos, atividade e aceites da política.

Os registros de acesso ligados à conta continuam guardados até completar 6 meses, como exige o Marco Civil da Internet, e depois são apagados automaticamente. Nos backups, os dados apagados somem em até 12 semanas.

Lembre que a licença CC de versões publicadas é irrevogável: cópias e forks que outras pessoas já fizeram, e dumps públicos já distribuídos, continuam válidos e não podem ser recolhidos.

## 18. Menores de idade

Contas são para pessoas com **18 anos ou mais**. O uso anônimo, que fica todo no navegador, é aberto a todos.

## 19. Como protegemos os dados

- conexão sempre cifrada (HTTPS com HSTS) e cabeçalhos de segurança (CSP com nonce, proteção contra enquadramento e outros);
- senha guardada só como hash com sal, com mínimo de 10 caracteres e verificação de força;
- cookies de sessão `Secure`, `HttpOnly` e `SameSite=Lax`, checagem de origem e proteção contra CSRF;
- encerramento das outras sessões ao redefinir a senha;
- respostas iguais para e-mail cadastrado ou não, para dificultar a descoberta de contas;
- Turnstile e limite de taxa, com hash de IP de curta duração;
- registros de acesso cifrados em repouso (AES-GCM), com acesso restrito e auditado;
- administração protegida por dupla checagem (papel de administrador e Cloudflare Access) e autenticação em dois fatores, com registro de auditoria;
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

---

Este documento não é aconselhamento jurídico e deve ser revisado por um advogado antes da publicação. (Q-LEGAL)
