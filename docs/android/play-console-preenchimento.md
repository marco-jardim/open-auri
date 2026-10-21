# Folha de preenchimento do Play Console

Pacote `com.openauri.app`. Esta folha junta, em uma só página e na ordem de preenchimento, todos
os campos que ainda faltam no Google Play Console antes da publicação, com o valor exato para
copiar. Seções e campos aparecem em inglês, como no Console; as explicações estão em pt-BR. Os
rótulos do Console mudam com o tempo: se um nome não bater, use o campo equivalente.

Fontes (prevalecem em caso de dúvida): [play-console-passos.md](./play-console-passos.md),
[play-listing.md](./play-listing.md), [play-conteudo.md](./play-conteudo.md),
[data-safety.md](./data-safety.md), [play-assinatura.md](./play-assinatura.md),
[play-conta.md](./play-conta.md), `docs/legal/politica-de-privacidade.md` e o Anexo G.5 de
`docs/plans/2026-10-18-android-capacitor-plano.md`.

## Como usar

- Copie só o conteúdo dos blocos `text`, sem as cercas.
- Tudo entre `<` e `>` é placeholder: **você digita o valor só no Console**. Nunca grave
  credenciais, e-mails ou dados pessoais no repositório.
- "**não coberto: decidir**" marca pergunta que as fontes não respondem; segue uma sugestão
  conservadora com o motivo.

| Placeholder                       | O que digitar (só no Console)                                     |
| --------------------------------- | ----------------------------------------------------------------- |
| `<seu e-mail público de contato>` | o contato público de desenvolvedor (o mesmo conferido na P1)      |
| `<usuário da conta de revisão>`   | e-mail ou apelido da conta comum de revisão                       |
| `<senha da conta de revisão>`     | senha dessa conta                                                 |
| `<URL do vídeo no YouTube>`       | link do vídeo demonstrativo enviado como não listado (Unlisted)   |
| `<versão>` e `<versionCode>`      | versão da release Android a enviar (ver seção 6)                  |
| `<seu e-mail de testador>`        | a conta Google que você usa na Play do seu celular                |

## 0. Create app (só se o app ainda não existir)

Home > Create app. Se o app já foi criado como rascunho, pule para a seção 1.

| Campo                                  | Valor                                  |
| -------------------------------------- | -------------------------------------- |
| App name                               | `open-auri`                            |
| Default language                       | Portuguese (Brazil), pt-BR             |
| App or game                            | App                                    |
| Free or paid                           | Free                                   |
| Declarations > Developer Program Policies | ler e marcar **você mesmo**         |
| Declarations > US export laws          | ler e marcar **você mesmo**            |

## 1. Store settings

Menu: Grow users > Store presence > Store settings.

### App category

- **App or game:** App
- **Category:** Music & Audio
- **Tags > Manage tags:** marcar só tags que existam na lista do Console e descrevam o app,
  próximas de "equalização", "áudio" e "ferramentas de áudio" (sugestão de play-listing.md).
  Se não houver equivalente, deixar sem tag em vez de escolher uma enganosa.

### Store listing contact details

- **Email address:** `<seu e-mail público de contato>` (aparece publicamente na ficha).
- **Phone number:** não coberto: decidir. Sugestão: deixar vazio; as fontes não exigem e o
  campo publicaria um dado pessoal.
- **Website:**

```text
https://open-auri.com
```

### External marketing

Não coberto: decidir. Sugestão conservadora: **desmarcar** a promoção do app fora da Google Play
até a gravação ser validada em cabo real (F5). Motivo: a função principal ainda traz o aviso de
"não testada em cabo real"; a opção é reversível e pode ser ligada depois.

## 2. Main store listing

Menu: Grow users > Store presence > Main store listing. O idioma padrão é pt-BR; o en-US entra
como tradução (2.3). Os textos são cópia exata de play-listing.md. Contagens: manuais, em
caracteres, incluindo quebras de linha; `npm run test:tools` imprime o valor exato.

### 2.1 pt-BR (default) > App details

**App name** (9 de 30):

```text
open-auri
```

**Short description** (72 de 80):

```text
App não oficial para o cabo Auri, com equalização e USB nativo em teste.
```

**Full description** (cerca de 2.174 de 4.000):

```text
Aviso: a gravação pelo app ainda não foi testada num cabo Auri real. O app usa o mesmo protocolo e envia os mesmos bytes que o site no computador (conferido por testes automáticos); em teoria o resultado é o mesmo, mas não há garantia. Relate o resultado em https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml

Conecte o cabo Kuba Auri por USB-C/OTG e grave curvas de equalização pela camada USB nativa do Android, que o navegador do celular não oferece. O transporte USB nativo permite selecionar o cabo e pedir permissão ao Android. O protocolo e os bytes enviados são os mesmos da versão para computador; o caminho físico USB do app ainda não foi validado. A gravação depende de uma ação sua e do checklist, nunca é automática. Há também Diagnóstico USB e exportação de arquivos pelo seletor do sistema.

Projeto independente: open-auri não é oficial nem endossado pela Kuba e não tem afiliação com ela ou qualquer fabricante. Crie, explore e compare curvas de equalização. Acesse a biblioteca de curvas e presets, compare respostas e participe da comunidade.

Não há leitura de volta do cabo. A vida útil da memória flash é desconhecida.

Código aberto sob AGPL-3.0, com código-fonte e contribuições em:
https://github.com/marco-jardim/open-auri

O protocolo foi estudado para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição.

Requisitos: Android 8 ou mais recente, aparelho com USB host/OTG, cabo compatível e Android System WebView atualizado. É necessária conexão com a internet para carregar o conteúdo e usar os recursos online. Destinado a pessoas com 18 anos ou mais.

Para relatar resultados, use o link do aviso inicial. Informe o aparelho, as versões do Android e do app e o JSON do Diagnóstico USB. Não inclua dados pessoais no relato.

Consulte a seção Segurança dos dados (Data safety) desta ficha e a política de privacidade para conhecer os dados coletados e compartilhados, as finalidades e as opções de exclusão. O arquivo de áudio usado na prévia fica no aparelho.

Site: https://open-auri.com
Privacidade: https://open-auri.com/privacidade
```

### 2.2 pt-BR > Graphics

Antes de enviar, regenerar e aprovar os 56 PNGs (play-listing.md, "Capturas e regeneração (P3)")
e rodar `node tools/play-assets.mjs --check`. Caminhos relativos a
`D:\git\open-auri\docs\android\play-assets\`. Enviar as capturas **nesta ordem**: `1-editor.png`,
`2-cabo.png`, `3-comparar.png`, `4-soe-como-x.png`, `5-comunidade.png`, `6-teste-cego.png`,
`7-native-connect.png` (o desktop para no 6). Não misturar conjuntos.

| Campo do Console                         | Arquivos                                                   |
| ---------------------------------------- | ---------------------------------------------------------- |
| App icon                                 | `icon-512.png`                                             |
| Feature graphic                          | `feature-1024x500.png`                                     |
| Video                                    | `<URL do vídeo no YouTube>` (ver abaixo)                   |
| Phone screenshots                        | `screenshots\pt-BR\1-editor.png` a `7-native-connect.png` (7) |
| 7-inch tablet screenshots                | `screenshots\pt-BR\tablet-7\1-editor.png` a `7-native-connect.png` (7) |
| 10-inch tablet screenshots               | `screenshots\pt-BR\tablet-10\1-editor.png` a `7-native-connect.png` (7) |
| Chromebook / telas grandes (se existir)  | `screenshots\pt-BR\desktop\1-editor.png` a `6-teste-cego.png` (6) |

Telas grandes: o nome do campo varia (Chromebook, PC). Ter as imagens não é declaração de
compatibilidade com Google Play Games no PC; não marcar essa distribuição por causa delas.

**Video (YouTube):**

1. Enviar `%USERPROFILE%\Videos\open-auri-demo-1.0.1.mp4` ao YouTube com visibilidade
   **Unlisted** (não listado). O vídeo é o demonstrativo obrigatório: conexão USB nativa e fluxo
   de gravação com gate/checklist. Não alegar no título ou na descrição do vídeo uma validação em
   hardware que não existe.
2. Abrir o link numa janela anônima e conferir que toca sem login.
3. Colar o link em **Video**: `<URL do vídeo no YouTube>`. O mesmo link serve à revisão (3.2).

### 2.3 en-US translation

Main store listing > Manage translations > Add your own translations > English (United States),
en-US. Depois, trocar o seletor de idioma para en-US e preencher:

**App name** (9 de 30):

```text
open-auri
```

**Short description** (70 de 80):

```text
Unofficial Auri cable app with EQ curves and native USB under testing.
```

**Full description** (cerca de 2.122 de 4.000):

```text
Notice: writing from the app has not been tested on a real Auri cable yet. The app uses the same protocol and sends the same bytes as the desktop site (checked by automated tests); in theory the result is the same, but it is not guaranteed. Report your result at https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml

Connect the Kuba Auri cable through USB-C/OTG and write EQ curves through Android's native USB layer, which the phone browser does not provide. The native USB transport lets you select the cable and request Android permission. The protocol and transmitted bytes are the same as the computer version; the app's physical USB path has not been validated yet. Writing requires your action and the checklist, and is never automatic. USB Diagnostics and file exports through the system picker are also available.

Independent project: open-auri is not official or endorsed by Kuba and is not affiliated with Kuba or any manufacturer. Create, explore and compare EQ curves. Browse the curve and preset library, compare responses and take part in the community.

There is no readback from the cable. The lifespan of its flash memory is unknown.

Open source under AGPL-3.0, with source code and contributions at:
https://github.com/marco-jardim/open-auri

The protocol was studied for interoperability. Use at your own risk: we are not responsible for damage to the cable, headphones or your hearing.

Requirements: Android 8 or newer, a device with USB host/OTG, a compatible cable and an up-to-date Android System WebView. An internet connection is needed to load content and use online features. Intended for people aged 18 or over.

To report results, use the link in the opening notice. Include your device, Android and app versions, and the USB Diagnostics JSON. Do not include personal data in the report.

See the Data safety section of this listing and the privacy policy for collected and shared data, purposes and deletion options. The audio file used for previews stays on your device.

Website: https://open-auri.com
Privacy policy: https://open-auri.com/privacidade
```

**Graphics en-US:** ícone, feature graphic e vídeo são os mesmos do pt-BR. Capturas, mesma ordem
e mesmas pastas, trocando `pt-BR` por `en-US`:

| Campo do Console                         | Arquivos                                                   |
| ---------------------------------------- | ---------------------------------------------------------- |
| Phone screenshots                        | `screenshots\en-US\1-editor.png` a `7-native-connect.png` (7) |
| 7-inch tablet screenshots                | `screenshots\en-US\tablet-7\1-editor.png` a `7-native-connect.png` (7) |
| 10-inch tablet screenshots               | `screenshots\en-US\tablet-10\1-editor.png` a `7-native-connect.png` (7) |
| Chromebook / telas grandes (se existir)  | `screenshots\en-US\desktop\1-editor.png` a `6-teste-cego.png` (6) |

Conferir `7-native-connect` (telefone e tablets): painel USB Android, lâmpada Conectado/Connected e
aviso de gravação não testada visíveis. No desktop, `2-cabo` mostra **OA-01 · WebHID**. A captura
USB usa dispositivo falso: não é prova de hardware nem substitui o vídeo.

## 3. App content

Menu: Policy and programs > App content. Preencher todas as declarações abaixo; sem elas o envio
fica bloqueado.

### 3.1 Privacy policy

**Privacy policy URL:**

```text
https://open-auri.com/privacidade
```

Antes de salvar, abrir o link sem login (ver checklist final).

### 3.2 App access

Selecionar **All or some functionality in my app is restricted**. Não marcar "All functionality in
my app is available without any access restrictions": conta, publicação, favoritos e denúncia
exigem login.

Add instructions:

| Campo                                         | Valor                                              |
| --------------------------------------------- | -------------------------------------------------- |
| Name (Instruction name)                       | `Review account (regular verified user)`           |
| Username, email address or phone number       | `<usuário da conta de revisão>`                    |
| Password                                      | `<senha da conta de revisão>`                      |
| Any other information (489 caracteres)        | bloco abaixo                                       |

```text
Sign-in is optional: the EQ utility works without an account. This account is only for community features (save, publish, favorite, report). Sign in via Menu > Entrar (Sign in). A Cloudflare Turnstile check may appear and usually passes automatically. No 2-step verification, email code or admin access needed. For adults 18+. Writing needs a Kuba Auri USB-C cable: Menu > Cabo > Conectar pelo USB do Android; without it the app reports no device. The untested-cable notice is intentional.
```

Requisitos da conta de revisão (fora do Console, antes de salvar): conta comum (não admin), e-mail
já verificado, **sem verificação em duas etapas**, reutilizável, sem depender de caixa de e-mail ou
código seu. Entrar com ela no app da release e conferir que o Turnstile passa.

**Allow Android to use the credentials (testes automáticos), se o Console mostrar:** não coberto:
decidir. Sugestão conservadora: **desmarcar**. Motivo: testes automáticos com a conta poderiam
publicar, favoritar ou denunciar no serviço de produção.

**Instruções longas (play-conteudo.md, seção 2):** colar o bloco abaixo **somente** se o Console
oferecer um campo de texto que o comporte (o campo acima não cabe). Não truncar no meio. Se não
houver campo, o texto curto acima basta.

```text
open-auri is an audio equalizer utility. The main utility works without signing in.
It is intended for adults aged 18 or over. You can browse curves, edit equalization,
preview sound using pink noise or a local audio file, and inspect the interface
without an account or the cable.

If the app first shows an Android System WebView update screen, update the active
WebView provider using that screen's button, then reopen the app. This compatibility
gate runs before the app content loads; it is not a sign-in or subscription screen.

Writing equalization to hardware requires a compatible Kuba Auri USB-C cable,
connected to the Android device through USB-C/USB OTG. Open Menu > Cabo (Cable) >
Conectar pelo USB do Android (Connect over Android USB) to open the native Android
device picker and grant USB permission locally. Without a cable, the app reports
that no compatible device was found. With a cable connected, the Engineering layer
on the Cable page shows USB Diagnostics. Without a cable, all non-hardware
functionality can still be evaluated; the USB write itself cannot.
The notice that writing has not yet been validated on a real cable is intentional.
Do not treat that notice as a sign-in failure or a request to bypass a safety check.

An account is optional and is used for community actions and account management.
Public community content can be viewed without signing in. Account creation may
be temporarily disabled; this does not prevent reviewing the main utility.
For account-only features, sign in using the verified, reusable review account
provided in the private Play Console access fields. No administrator access,
new account, email inbox access or code from the maintainer is needed.
To find the moderation controls (English labels, with Portuguese labels in parentheses):
- Menu > Comunidade (Community) > open a curve's page: expand Report <curve name>
  (Denunciar <nome>) to report it, or choose Hide this curve (Ocultar esta curva).
- Open the author's nickname to visit their profile: expand Report <nickname>
  (Denunciar <apelido>) to report the author, or choose Hide this author
  (Ocultar este autor).
- On a profile, creations, packs and public favorites each have Report <item name>
  (Denunciar <nome>); comparison sources and blind-test candidates have it too.
- On Comunidade (Community), select a curve, then scroll to More from the desk
  (Mais da mesa) > Report (Denunciar) and expand that drawer. Hide this curve /
  Hide this author (Ocultar esta curva / Ocultar este autor) are on the curve's channel.
To submit a report, use the verified review account, choose a reason, complete
the security check and press Send report (Enviar denúncia). Hiding needs no
verified account: it is local for visitors and synced for signed-in accounts.

The required hardware demonstration video is provided in the Console's review
materials. It demonstrates native USB connection and the guarded write flow.
```

**Vídeo para a revisão:** as fontes exigem o link nos "materiais de revisão", mas não dizem em que
campo. Não coberto: decidir. Sugestão: o link já fica em Main store listing > Video (2.2); se o
App access aceitar uma segunda instrução sem credenciais, criar uma chamada
`Hardware demo video` com `<URL do vídeo no YouTube>` em "Any other information". Não enviar sem
o vídeo.

### 3.3 Ads

**Does your app contain ads?** No, my app does not contain ads.

Simple Analytics é estatística, Turnstile é proteção contra robôs: nenhum dos dois é anúncio.

### 3.4 Content rating

Content rating > Start new questionnaire (IARC).

- **Email address:** `<seu e-mail público de contato>`.
- **Category:** a categoria de utilidade/ferramenta (no Console, algo como "Utility, Productivity,
  Communication, or Other"). **Nunca "Game".**
- **Regra única:** responder as perguntas de conteúdo pelo conteúdo fornecido pelo desenvolvedor;
  declarar UGC só em "users interact" e nos campos de interação/moderação. A possibilidade de UGC
  ofensivo não vira "Yes" nas perguntas de conteúdo.
- **18+ é o público-alvo (3.5), não uma classificação.** Não tentar forçar resultado; o IARC
  calcula a classificação por território.

| Tema da pergunta no Console                                        | Resposta |
| ------------------------------------------------------------------ | -------- |
| Violence, blood, gore, horror or cruelty                           | No       |
| Sexuality, nudity or dating services                               | No       |
| Language: profanity or crude humor (conteúdo do desenvolvedor)     | No       |
| Controlled substances: drugs, alcohol, tobacco                     | No       |
| Gambling, simulated gambling or real-money prizes                  | No       |
| Digital purchases, paid random items, loot boxes                   | No       |
| Shares the user's physical location with other users               | No       |
| Users can interact or exchange content with other users            | **Yes**  |
| User-generated content visible to other users                      | **Yes**  |
| Chat, private messages or free-form comments between users         | No       |
| Users can report inappropriate content and users                   | **Yes** (com conta e e-mail verificados) |
| Moderation and removal of abusive content                          | **Yes**  |
| All content is approved before it appears / filter guarantees none | No       |
| Users can hide (block) authors and curves                          | **Yes** ("Ocultar este autor/esta curva") |
| Parental controls                                                  | No       |
| Web browser, search engine or unrestricted internet access         | No       |
| News, political editorial, physical goods or regulated services    | No       |

Qualquer outra pergunta de conteúdo que não esteja na tabela: não coberto: decidir. Sugestão
conservadora: **No** para o conteúdo do desenvolvedor (curvas são dados numéricos e texto técnico),
aplicando a regra única; se a pergunta for sobre interação entre usuários, responder como as
linhas "users interact" acima. Anotar a pergunta e avisar o agente.

Depois: Save > Next > conferir o resumo > Submit.

### 3.5 Target audience and content

- **Target age:** marcar **somente 18 and over**. Nenhuma faixa de menores, nem para uso sem
  conta.
- **Appeal to children** (se o Console perguntar se a ficha pode atrair crianças): **No**.
- **Families / Designed for Families:** não participar; o app não é infantil.
- Não alegar verificação de idade ou controle parental: o cadastro não pede data de nascimento.

### 3.6 News apps

**Is your app a news app?** No.

### 3.7 Data safety

Copiar exatamente as tabelas abaixo (fonte: data-safety.md). Não escolher "não coletamos dados"
nem marcar tudo como efêmero. A WebView carrega o site próprio, então a coleta do site entra.

#### Data collection and security

| Pergunta                                                                                    | Resposta |
| ------------------------------------------------------------------------------------------- | -------- |
| Does your app collect or share any of the required user data types?                         | **Yes**  |
| Is all of the user data collected by your app encrypted in transit?                         | **Yes**  |
| Which of the following methods of account creation does your app support?                  | **Username and password** (identificador principal é o e-mail; entrada também por apelido; 2FA opcional; sem OAuth/login social) |
| Delete account URL (link para pedir exclusão da conta e dos dados)                          | `https://open-auri.com/privacidade#secao-17` |
| Do you provide a way for users to request that some or all of their data is deleted, without requiring them to delete their account? | **Yes** (parcial: atividade, curvas, favoritos, ocultações, recibo S6) |
| URL dessa exclusão parcial (se o Console pedir)                                             | `https://open-auri.com/privacidade#secao-16` |
| Independent security review                                                                 | não declarar (não houve) |

A seção 17 aponta o fluxo em https://open-auri.com/conta. Se o Console tiver um campo separado só
para o link que inicia o fluxo, usar `https://open-auri.com/conta`.

#### Data types: marcar como coletados (12 tipos)

Legenda de finalidades (Console): **F** = App functionality; **C** = Account management;
**A** = Analytics; **S** = Fraud prevention, security, and compliance. Nunca marcar Advertising or
marketing, Personalization nem Developer communications.

"Optional" = "Users can choose whether this data is collected"; "Required" = "Data collection is
required". Em todas as linhas: **Is this data processed ephemerally? No**.

| Categoria > tipo                                   | Collected | Shared  | Ephemeral | Required / Optional | Purposes (collection) | Purposes (sharing) |
| -------------------------------------------------- | --------- | ------- | --------- | ------------------- | --------------------- | ------------------ |
| Location > Approximate location                    | Yes       | **Yes** | No        | Required            | A                     | A (Simple Analytics) |
| Personal info > Name                               | Yes       | No      | No        | Optional            | F, C                  |                    |
| Personal info > Email address                      | Yes       | No      | No        | Optional            | C, S                  |                    |
| Personal info > User IDs                           | Yes       | No      | No        | Optional            | F, C, A, S            |                    |
| Personal info > Other info                         | Yes       | No      | No        | Optional            | F, C, S               |                    |
| Health and fitness > Health info                   | Yes       | No      | No        | Optional            | F, A                  |                    |
| App activity > App interactions                    | Yes       | **Yes** | No        | Required            | F, A, S               | A (Simple Analytics) |
| App activity > Other user-generated content        | Yes       | No      | No        | Optional            | F, S                  |                    |
| App activity > Other actions                       | Yes       | No      | No        | Optional            | F, C, S               |                    |
| App info and performance > Diagnostics             | Yes       | No      | No        | Required            | F, A, S               |                    |
| App info and performance > Other app performance data | Yes    | No      | No        | Required            | F, A                  |                    |
| Device or other IDs > Device or other IDs          | Yes       | No      | No        | Required            | F, C, S               |                    |

Notas das linhas:

- **Approximate location:** país derivado pelo Simple Analytics a partir do fuso horário, não GPS;
  não é requisito para conta.
- **Name:** apelido público e campo privado `name`; não é nome civil.
- **Health info:** declaração conservadora das preferências do teste cego (S6), com
  consentimento; não transforma o app em recurso de saúde (3.10).
- **App interactions:** tem parte automática sem opt-out (contagens), por isso Required.
- **Other actions:** ocultações sincronizadas da conta, aceites, troca de apelido, sessões,
  pedidos de encerramento.
- "Shared = No" nas demais linhas usa as exceções da Play (prestador agindo por você, publicação
  pedida pelo usuário). Se um contrato não sustentar a exceção, mudar para Yes.

#### Data types: não marcar (não coletados)

- Location: Precise location.
- Personal info: Address; Phone number; Race and ethnicity; Political or religious beliefs; Sexual
  orientation.
- Financial info: User payment info; Purchase history; Credit score; Other financial info.
- Health and fitness: Fitness info.
- Messages: Emails; SMS or MMS; Other in-app messages.
- Photos and videos: Photos; Videos.
- Audio files: Voice or sound recordings; Music files; Other audio files.
- Files and docs.
- Calendar: Calendar events.
- Contacts.
- App activity: In-app search history; Installed apps.
- Web browsing: Web browsing history.
- App info and performance: Crash logs.

Antes de confirmar: na tela Preview, conferir linha a linha contra as tabelas acima. Resolver as
pendências de data-safety.md (inspeção dos beacons do Simple Analytics, contratos, manifesto
mesclado do AAB) antes do envio definitivo.

### 3.8 Government apps

**Is your app developed by or on behalf of a government?** No.

### 3.9 Financial features

Selecionar **My app doesn't provide any financial features**.

### 3.10 Health apps

Selecionar **My app doesn't provide any health features**. Isso não contradiz a linha Health info
do Data safety (declaração conservadora do S6). Se alguma pergunta do Console tratar esse dado como
recurso de saúde, parar, anotar a pergunta e revisar com o agente antes de confirmar.

### 3.11 Advertising ID

**Does your app use advertising ID?** No. Conferir no manifesto mesclado do AAB final que não há
`com.google.android.gms.permission.AD_ID`.

### 3.12 Outras declarações

As fontes cobrem as declarações acima (as mesmas de play-console-passos.md). Se o Console pedir
outra (por exemplo, permissões sensíveis ou serviço em primeiro plano): não coberto: decidir.
Sugestão conservadora: não declarar uso antes de conferir o AAB; o manifesto do app só tem
`android.permission.INTERNET` e USB host opcional
(`apps/android/android/app/src/main/AndroidManifest.xml:4-5`). Se o Console pede, uma dependência
acrescentou algo: parar e avisar o agente com o texto exato.

## 4. Pricing & distribution

No Console atual esses itens ficam espalhados (Create app, App content e a aba de países de cada
trilha); preencher onde o Console mostrar.

| Item                                   | Valor |
| -------------------------------------- | ----- |
| Price                                  | Free (gratuito, sem compras no app) |
| Contains ads                           | No (o mesmo de 3.3) |
| Countries / regions                    | não coberto: decidir (abaixo) |
| Content guidelines / Developer Program Policies | ler e aceitar **você mesmo** |
| US export laws                         | ler e aceitar **você mesmo** |

**Countries / regions:** as fontes não definem. Sugestão: **todos os países e regiões
disponíveis**, porque ficha, política e site são os mesmos para todos, em pt-BR e en-US.
Alternativa mais conservadora: só Brasil no primeiro lançamento, ampliando depois. A escolha vale
para a trilha Production (6.2).

## 5. App integrity > Play app signing

Menu: Test and release > App integrity > Play app signing (Settings).

**Feito (informado pelo mantenedor):** chave do app enviada por PEPK, com Play App Signing usando a
chave própria (não a gerada pelo Google). A tabela "Resultado" de play-assinatura.md ainda está
como pendente até você informar os valores abaixo.

Conferir, caractere por caractere:

| Certificado no Console                    | SHA-256 esperado |
| ----------------------------------------- | ---------------- |
| App signing key certificate               | `FB:46:E3:4F:03:FD:6F:59:5B:4B:70:36:74:8F:92:83:08:FA:BF:31:C1:55:BF:E2:C5:0E:B1:B4:43:FF:61:D0` |
| Upload key certificate (**a confirmar**)  | `59:1A:0A:1B:CC:E8:A5:39:AF:2F:25:60:DE:1D:D7:92:82:F0:42:BA:40:62:82:31:F3:E4:35:E3:A6:CD:04:16` |

- Se o certificado de upload ainda não aparecer, enviar `open-auri-upload-cert.pem` como pede
  play-assinatura.md, passo 6.
- Se algum valor divergir, **parar** e avisar o agente; não enviar AAB.
- Na página de **Android developer verification**, conferir que `com.openauri.app` está registrado
  com o SHA-256 da chave do app (`FB:46:...:61:D0`).
- Apagar `open-auri-app-pepk.zip` e a chave pública baixada, se ainda existirem.
- Informar ao agente os dois SHA-256 mostrados pelo Console (são públicos; nunca envie senha ou
  keystore).

## 6. Releases

### Como descobrir `<versão>` e baixar o AAB

1. Abrir https://github.com/marco-jardim/open-auri/releases e pegar a release mais recente cuja tag
   começa com `android-v` (por exemplo, `android-v1.0.2`). `<versão>` é o que vem depois de
   `android-v`.
2. Nas notas dessa release aparecem `# Android <versão>` e `Version code: <versionCode>`; o
   `release-manifest.json` tem os mesmos campos `version` e `versionCode`. A regra é
   maior x 10000 + menor x 100 + patch (1.0.2 dá 10002).
3. Baixar `open-auri-<versão>.aab` e `SHA256SUMS.txt` para a mesma pasta e conferir o hash no
   PowerShell, comparando com a linha do AAB no `SHA256SUMS.txt`:

```powershell
(Get-FileHash .\open-auri-<versão>.aab -Algorithm SHA256).Hash.ToLower()
```

**Release notes** (iguais nas duas trilhas; aviso G.5 exato, cerca de 344 e 349 caracteres). O
Console mostra as tags de idioma; manter as tags e colar o texto entre elas:

```text
<pt-BR>
Aviso: a gravação pelo app ainda não foi testada num cabo Auri real. O app usa o mesmo protocolo e envia os mesmos bytes que o site no computador (conferido por testes automáticos); em teoria o resultado é o mesmo, mas não há garantia. Relate o resultado em https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml
</pt-BR>
<en-US>
Notice: writing from the app has not been tested on a real Auri cable yet. The app uses the same protocol and sends the same bytes as the desktop site (checked by automated tests); in theory the result is the same, but it is not guaranteed. Report your result at https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml
</en-US>
```

### 6.1 Internal testing (primeiro)

Menu: Test and release > Testing > Internal testing.

1. **Testers** > Create email list:
   - List name: não coberto: decidir (rótulo livre, ex.: `open-auri mantenedor`).
   - Email addresses: `<seu e-mail de testador>`.
   - Feedback URL or email address: não coberto: decidir. Sugestão: deixar vazio (só você testa).
   - Salvar e deixar a lista marcada. Abrir o link de opt-in ("Join on the web") no celular, com a
     mesma conta, e aceitar.
2. **Releases** > Create new release:
   - App bundles > Upload: `open-auri-<versão>.aab`. Conferir que o Console lê o mesmo
     `<versionCode>` e a mesma `<versão>` e não acusa erro de chave de upload.
   - Release name: `<versão> (<versionCode>)`, por exemplo `1.0.2 (10002)`. Trocar pelos
     valores lidos na release.
   - Release notes: o bloco acima.
3. Next > Save > ler erros e avisos > **Start rollout to Internal testing**.
4. Instalar pela Play no seu celular **por cima do APK do GitHub, sem desinstalar**. Informar ao
   agente se funcionou.

### 6.2 Production

Conta pessoal criada antes de 2023-11-13 (play-conta.md): **isenta de teste fechado**, vai direto
para produção depois do teste interno.

1. Test and release > Production > **Countries / regions**: a escolha da seção 4.
2. Promover a versão do teste interno (Internal testing > Promote release > Production) ou, em
   Production > Create new release, usar Add from library e escolher o mesmo AAB.
3. Release name: o mesmo de 6.1 (`<versão> (<versionCode>)`). Release notes: o mesmo bloco G.5.
4. **Rollout percentage: 100%** (se o Console oferecer percentual).
5. Next > Save > Publishing overview > **Send changes for review**.
6. **Managed publishing:** não coberto: decidir. Sugestão conservadora: ligar, para publicar à mão
   só depois de conferir a ficha aprovada. Se ficar desligado, o app sai assim que aprovado.
7. Se a revisão recusar, colar ao agente o motivo exato, sem credenciais.

## 7. Checklist final antes de enviar

- [ ] https://open-auri.com/privacidade abre sem login e **sem 403** numa janela anônima, no celular
      e no computador, nos dois idiomas; versão e vigência corretas, sem texto de rascunho e sem
      `{{...}}` sobrando.
- [ ] https://open-auri.com/privacidade#secao-16 leva a "16. Seus direitos e como exercer" e
      https://open-auri.com/privacidade#secao-17 leva a "17. Encerrar a conta".
- [ ] https://open-auri.com/conta abre (pede login) e mostra o encerramento depois de entrar.
- [ ] O controlador da política (`PUBLIC_LGPD_CONTROLLER`) é igual ao nome de desenvolvedor da
      Play, ou a política explica a relação.
- [ ] **Nenhum placeholder** nos campos enviados: nada de `<seu ...>`, `<usuário ...>`,
      `<senha ...>`, `<URL ...>`, `<versão>`, `<versionCode>` ou `[PREENCHER...]`. As únicas tags
      que ficam são `<pt-BR>`/`<en-US>` das release notes.
- [ ] Conta de revisão entra no app da release, com Turnstile passando, e-mail verificado, sem 2FA
      e sem papel de admin.
- [ ] Link do vídeo abre numa janela anônima.
- [ ] 56 PNGs regenerados, validados (`node tools/play-assets.mjs --check`) e aprovados visualmente.
- [ ] Data safety: Preview igual às tabelas da seção 3.7; pendências de data-safety.md resolvidas.
- [ ] Manifesto mesclado do AAB final sem `AD_ID`, sem permissões além das esperadas e sem HTTP em
      produção.
- [ ] Os dois SHA-256 da seção 5 conferidos e informados ao agente.
- [ ] Smoke da release executado ([smoke-lancamento.md](./smoke-lancamento.md)), inclusive entrada
      com Turnstile, fluxo sem cabo, ruído rosa, SAF e gate de WebView.
- [ ] Teste interno instalado por cima do APK do GitHub, sem desinstalar.
- [ ] Dashboard sem tarefas pendentes; Publishing overview lista as mudanças esperadas.
- [ ] Pendências ou recusas informadas ao agente com o texto exato do Console, sem credenciais nem
      dados pessoais.
