# Smoke de lançamento do app Android (T4.2, Anexo F)

Celular sem cabo, com adb. Aparelho: BV9900 Pro, Android 10 (API 29), Android System WebView 155.0.8059.43. Data: 2026-10-20.

## Primeira passada: release 1.0.0

A release `android-v1.0.0` (commit `b7d9ac2`) instalou e abriu, mas o smoke encontrou quatro defeitos. Eles viraram FX4-A a FX4-E, revisados no Q4 em duas rodadas, e saíram na 1.0.1.

| Achado | Gravidade | Correção |
|---|---|---|
| Um App Link `/c/<id>` abria o app na página inicial (o Capacitor ignora o endereço do link) | major | FX4-A: o link abre a página, só num lançamento novo e só para páginas |
| Offline, o app sempre trocava a página salva pelo service worker pela página nativa "Sem conexão" | major | FX4-B: a página nativa só aparece quando o site não carregou |
| O aviso do Anexo G.1 encostava na borda esquerda | minor | FX4-D |
| Voltar com a folha "Antes de gravar" aberta fechava o app | minor | FX4-E: Voltar fecha a folha ou o menu, volta no histórico do site e sai da página offline |

Por decisão do mantenedor, a 1.0.1 também grava offline com a última confirmação do servidor (FX4-C, ver `docs/android.md`).

## Segunda passada: release 1.0.1

Release `android-v1.0.1` (commit `202a194`, versionCode 10001), instalada a partir do APK baixado da release no GitHub.

| # | Item do Anexo F | Resultado | Evidência |
|---|---|---|---|
| 1 | SHA-256 e fingerprint conferidos | OK | `SHA256SUMS.txt` confere; `apksigner`: certificado `fb46e3…61d0`, igual ao `assetlinks.json` |
| 2 | Aviso G.1 no primeiro uso, não volta depois de "Entendi" | OK | modal centrado (16 px de cada lado em 360 px); não reaparece ao reabrir |
| 3 | Todas as páginas do RF1; troca de idioma | OK | Curva, Biblioteca, Comparar, Soe como X, Comunidade, Teste cego, Docs e Cabo carregam; em inglês, a faixa do cabo aparece em inglês |
| 4 | Página do cabo | OK | faixa do aviso visível; "Conectar pelo USB do Android" sem cabo acende "Sem cabo"; sem Diagnóstico USB; "Relatar resultado" abre o issue form no Chrome |
| 5 | Áudio de teste e arquivo próprio | OK | "Tocar arquivo" toca o sinal de teste (player AAudio `started` no uid do app); "Carregar MP3…" abre o seletor do sistema |
| 6 | Exportar JSON pelo SAF | OK | "JSON open-auri (preset)" abre o seletor do sistema, salva `neutro.json` com `open-auri/preset@1` (arquivo de teste apagado depois) |
| 7   | Entrar na conta (Turnstile) e sair | OK | o mantenedor entrou e saiu pelo menu do app (2026-10-20) |
| 8 | Link externo (Kuba) no navegador do sistema | OK | `kuba.audio` abre no Chrome |
| 9 | App Links | OK | `dumpsys package d`: `open-auri.com` com status `always` (verificado; o Android 10 não tem `pm get-app-links`); `/c/<id>` e `/u/<apelido>?x=1#f` abrem a página certa, com o app fechado e aberto |
| 10 | Modo avião | OK | sem o service worker (primeira abertura) aparece "Sem conexão" e Voltar sai do app; com o service worker, o editor abre da cópia salva |
| 11 | Instalar pela Play por cima do APK do GitHub | depois da P7 | |

Voltar com a folha "Antes de gravar" aberta fecha só a folha, e o app continua aberto.
