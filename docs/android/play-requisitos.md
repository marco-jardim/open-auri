# Requisitos da Google Play e da verificação de desenvolvedor Android (P0)

- **Pacote:** `com.openauri.app`
- **Consulta:** 2026-10-19 (todas as fontes abaixo foram acessadas nesta data)
- **Plano:** `D:\git\open-auri\docs\plans\2026-10-18-android-capacitor-plano.md`, Trilha P, P0

Itens marcados "não confirmado" ou "inferência" não foram verificados diretamente na documentação oficial.

## Alertas

1. **Registro de pacote da Play com prazo vencido.** "Effective September 30, 2026, all Play packages must be registered"; pacotes não registrados até essa data são removidos da Play (https://support.google.com/android-developer-console/answer/16984799). O registro de `com.openauri.app` entra na P6 e precisa acontecer antes do primeiro envio.
2. **Brasil incluído na verificação desde 2026-09-30.** O guia oficial (https://developer.android.com/developer-verification/guides, atualizado em 2026-08-18) e o blog de 2026-06-18 (http://android-developers.googleblog.com/2026/06/android-developer-verification.html) citam Brasil, Indonésia, Singapura e Tailândia. A ajuda do Android Developer Console (https://support.google.com/android-developer-console/answer/16561738) cita só Indonésia, Singapura e Tailândia. Prevalece developer.android.com, por ser mais recente (inferência).
3. **targetSdk 36 obrigatório para app novo.** A extensão até 2026-11-01 é descrita para quem precisa de mais tempo; não está confirmado que se aplique a app novo. O plano já usa targetSdk 36, então não depende da extensão.
4. **Sideload direto não é bloqueado nesta fase.** A exigência de 2026-09-30 "only applies to the specific participating stores" (https://developer.android.com/developer-verification/guides/faq, atualizada em 2026-07-15).

## 1. Conta antiga e encerramento por inatividade

- **Quando a conta é marcada:** conta com mais de 1 ano e, se não tem apps, que nunca enviou um app; se tem apps, todos somam menos de 1.000 instalações, telefone e e-mail de contato não verificados e Console sem uso nos últimos 180 dias. Aviso por e-mail e no Console, com lembretes de 60, 30 e 7 dias (https://support.google.com/googleplay/android-developer/answer/11605267).
- **O que mantém a conta:** verificar e-mail e telefone em Developer account > Account details; criar e configurar um app ou publicar uma atualização (vale enviar um bundle para teste interno ou fechado). A taxa de registro não é reembolsada se a conta for encerrada (mesma fonte).
- **Teste fechado de 12 testadores por 14 dias:** o artigo se aplica a "personal developer accounts created after November 13, 2023" (https://support.google.com/googleplay/android-developer/answer/14151465). Contas pessoais anteriores ficam fora do escopo (leitura do escopo, não isenção declarada; inferência).

## 2. Verificação de identidade no Play Console

- **Documentos (conta pessoal):** documento oficial de identidade, ligado ao perfil de pagamento Google, e verificação de dispositivo pelo app Play Console no celular (https://support.google.com/googleplay/android-developer/answer/10841920).
- **Prazo:** dá para verificar a partir de 60 dias antes do prazo individual da conta; a data exata não aparece na fonte (não confirmado). Sem verificação, não é possível enviar apps (mesma fonte).
- **O que fica público (conta pessoal):** "Google will display your legal name, your country (as per your legal address), and developer email address on Google Play. If you decide to monetize on Google Play then Google will display your full address" (https://support.google.com/googleplay/android-developer/answer/13628312). Telefone não é exibido.
- **Endereço num app gratuito sem compras:** pelo texto, o endereço completo só aparece com monetização (inferência). Conferir no Console antes de publicar.

## 3. Verificação de desenvolvedor Android

- **Países e datas:** proteções desde 2026-09-30 para usuários de Brasil, Indonésia, Singapura e Tailândia, em aparelhos certificados com Android 7 ou mais; expansão global prevista para 2027 (https://developer.android.com/developer-verification).
- **Lojas participantes:** Google Play, HONOR, OPPO, Samsung Galaxy Store, Transsion, vivo e Xiaomi (mesma fonte).
- **Registro de pacote e SHA-256 no Play Console:** Register package names, digitar o pacote, Add key com o SHA-256 do certificado de assinatura. O estado vai para "In review"; para pacote existente, prova de posse com um APK assinado contendo `adi-registration.properties` em `assets` (https://developer.android.com/developer-verification/guides/android-developer-console). A ajuda da Play diz "You do not need to upload the actual APK" (https://support.google.com/android-developer-console/answer/16984799). A interpretação exata para pacote novo fica para a P6, no Console.
- **APK fora da Play com a mesma chave:** "if the platform uses your signing key, you don't need to complete any further steps" (https://developer.android.com/developer-verification/guides/open-source-app-registration). O registro é por pacote e chave, então cobre o APK do GitHub assinado com a mesma chave (inferência bem sustentada).
- **Sideload:** fora das lojas participantes, apps não registrados só instalam com o "advanced flow" ou por ADB (https://developer.android.com/developer-verification/guides/faq).
- **Contas do Android Developer Console:** Full Distribution custa US$ 25; Limited Distribution é gratuita, sem documento, até 20 aparelhos (https://support.google.com/android-developer-console/answer/16561738).
- **Chave perdida:** o registro de pacote não pode ser refeito (https://developer.android.com/developer-verification/faq).

## 4. Play App Signing

- **Padrão para app novo:** assinatura híbrida com chaves geradas pelo Google. A chave pode ser trocada "before there is a release rolled out in open testing track or production track" (https://support.google.com/googleplay/android-developer/answer/9842756). Release em teste interno ou fechado não impede a troca (inferência).
- **Chave própria:** "Change the app signing key" > "Provide a copy of your app signing key", seguindo a PEPK; RSA de 2048 bits ou mais (mesma fonte).
- **Chave de upload:** "For maximum security, your upload key and app signing key should be different" (mesma fonte). O plano usa duas chaves separadas (seção 4.6).
- **Mesma assinatura na Play e no GitHub:** opção de gerar a chave própria e enviar uma cópia ao Google durante a configuração (mesma fonte). É a opção da seção 4.6 do plano.

## 5. Ficha da loja e imagens

| Item | Especificação | Fonte |
|---|---|---|
| Título | até 30 caracteres | https://support.google.com/googleplay/android-developer/answer/9898842 |
| Descrição curta | até 80 caracteres | https://support.google.com/googleplay/android-developer/answer/9866151 |
| Descrição completa | até 4.000 caracteres | https://support.google.com/googleplay/android-developer/answer/13393723 |
| Ícone | PNG 32 bits com alpha, 512 x 512 px, até 1024 KB | https://support.google.com/googleplay/android-developer/answer/9866151 |
| Feature graphic | JPEG ou PNG 24 bits, sem alpha, 1024 x 500 px | mesma fonte |
| Capturas de celular | mínimo 2, até 8 por tipo; JPEG ou PNG 24 bits sem alpha; lados entre 320 e 3840 px; proporção máxima 2:1 | mesma fonte |
| Capturas para recomendação | pelo menos 4, 1080 px, 16:9 (mín. 1920 x 1080) ou 9:16 (mín. 1080 x 1920) | mesma fonte |

Sem texto de ranking, preço ou promoção, nem selo de loja nas artes (mesma fonte).

## 6. Conteúdo do app

- **Data safety:** obrigatória em todas as faixas, com política de privacidade; app sem coleta também preenche. Dados processados só no aparelho não são declarados. WebView: "You do not need to declare data collection from a webview in which users are navigating the open web", mas, se o app controla o conteúdo da WebView (é o caso: o site é nosso), a coleta do site entra na declaração (https://support.google.com/googleplay/android-developer/answer/10787469).
- **Classificação (IARC):** questionário em App content > Content rating, com e-mail de contato; app sem classificação pode ser removido (https://support.google.com/googleplay/android-developer/answer/9859655).
- **Público-alvo:** faixa etária obrigatória; com crianças, valem as políticas Families (https://support.google.com/googleplay/android-developer/answer/9859455).
- **Anúncios:** declarar sim ou não (mesma fonte).
- **Acesso ao app:** se parte do app exigir login, fornecer credenciais válidas e reutilizáveis, em inglês (https://support.google.com/googleplay/android-developer/answer/15748846). O app funciona sem login; a seção ainda serve para explicar o cabo ao revisor.
- **ID de publicidade:** target 13 ou mais declara o uso de `com.google.android.gms.permission.AD_ID` (https://support.google.com/googleplay/android-developer/answer/6048248). O app não usa.
- **Recursos financeiros:** declaração obrigatória, inclusive "My app doesn't provide any financial features" (https://support.google.com/googleplay/android-developer/answer/13849271).
- **Saúde:** declaração obrigatória, inclusive "My app doesn't provide any health features" (https://support.google.com/googleplay/android-developer/answer/14738291).
- **Apps de governo:** declaração obrigatória desde 2023-01-31 (https://support.google.com/googleplay/android-developer/answer/9514050).
- **Notícias:** declarar se o app se apresenta como notícia ou revista (https://support.google.com/googleplay/android-developer/answer/9859455).

## 7. WebView, funcionalidade mínima e hardware externo

- **WebView de site:** proibido "provide a web view of a website without permission from the website owner or administrator" (https://support.google.com/googleplay/android-developer/answer/9899034). O site é do próprio desenvolvedor.
- **Funcionalidade mínima:** apps estáticos sem função própria são proibidos (https://support.google.com/googleplay/android-developer/answer/9898783). A gravação nativa por USB é a função própria do app; a ficha precisa deixar isso claro.
- **Interface JavaScript:** proibido "a webview with added JavaScript Interface that loads untrusted web content (for example, http:// URL) or unverified URLs" (https://support.google.com/googleplay/android-developer/answer/9888379). O plano atende com origem fixada em HTTPS, `allowNavigation` vazio, `OriginGuard` e `verifyCapacitorConfig` (RS1, 0.12.4, 0.12.5).
- **Hardware externo:** não há política específica (não confirmado). Instruções ao revisor em "Acesso ao app", com vídeo de demonstração opcional (https://support.google.com/googleplay/android-developer/answer/9859455).

## 8. Prazos de revisão

- App novo: "up to seven days or longer in exceptional cases" (https://support.google.com/googleplay/android-developer/answer/9859751).
- Pedido de acesso à produção (contas novas): "usually takes seven days or less" (https://support.google.com/googleplay/android-developer/answer/14151465).

## 9. targetSdk

- "Starting August 31, 2026: New apps and app updates must target Android 16 (API level 36) or higher" (https://support.google.com/googleplay/android-developer/answer/11926878).
- Extensão até 2026-11-01 para quem precisar de mais tempo; aplicação a app novo não confirmada. O plano usa targetSdk 36.
