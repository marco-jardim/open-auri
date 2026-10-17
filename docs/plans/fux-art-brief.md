# FUX.ART · Arte temática e animações por página

Pedido do operador (2026-10-17, literal): "sinto falta dos svgs tematicos ao longo da pagina e background reforçando a conexão da pagina com o homenageado e o tema. adicione mais animacoes WOW e no tema das paginas."

Complementa `fux-spec.md` §3 (dramaticidade por tema) e `fux-delegate-brief.md`. Este pedido flexibiliza a regra da §2.5 sobre loop acima da dobra: o loop decorativo passa a ser permitido, desde que cumpra as regras abaixo.

## Regras

1. **Só decorativo.** Use `aria-hidden="true"` e `pointer-events: none`, sem texto. Nada pode imitar um medidor: nenhuma agulha, barra de nível, LED de nível ou traço de espectro que se mova como se medisse (§0.12.7). Se um elemento lembrar instrumento, ele fica parado ou se move de um jeito que claramente não é leitura, por exemplo deriva lenta ou rotação contínua de carretel.
2. **Movimento.**
   - Anime só `transform`, `opacity`, `stroke-dashoffset` e `filter` leve.
   - Pause fora da viewport com `animation-play-state` via IntersectionObserver, ou `content-visibility`, e com a aba oculta.
   - `prefers-reduced-motion: reduce` desliga tudo e deixa um quadro final bonito.
   - O ciclo longo (≥ 6 s) deve ser sutil e não brigar com o conteúdo; os momentos WOW ficam na entrada (reveal ao rolar, uma vez) e nas interações.
3. **Custo.**
   - A arte pesada vai como arquivo estático em `web/static/art/<pagina>/*.svg` (CSP `img-src 'self'`), referenciada por CSS `background-image` ou `<img alt="" aria-hidden>`. JS zero.
   - SVG inline só para traçados que se desenham (`stroke-dasharray`). Abaixo da dobra, vai num `Deferred`.
   - Orçamento: no máximo +2 kB gzip de JS por rota e 40 kB por página somando os SVGs (SVGO à mão: sem metadata, com `viewBox`, `currentColor` ou tokens).
4. **Legibilidade.** Arte de fundo atrás de texto mantém o contraste AA do texto. Use opacidade baixa, máscaras e vinheta. Nenhum par texto/superfície pode cair abaixo de 4,5:1. O teste `contrast.test.ts` continua valendo.
5. **Tema fiel ao homenageado.** Use a história real e o equipamento da época, sem marcas registradas como branding. Homenageado só em texto (regra do plano). Nada de rostos nem fotos.
6. **Layout.**
   - Camadas absolutas sob o conteúdo (`z-index` negativo dentro de um contêiner `isolation: isolate`), sem CLS.
   - Respeite a barra fixa (`--bar-h`).
   - No mobile, versões simplificadas.

## Direção por página (motivos e assinatura WOW)

| Página | Homenageado | Fundo e SVGs ao longo da página | WOW |
|---|---|---|---|
| Curva | Bob Moog | Painel modular com trilhos Eurorack e parafusos; cabos de patch em curvas catenárias ligando seções; ondas de oscilador (seno, dente de serra, quadrada) como gravação no metal; a patente da escada de transistores (diagrama esquemático estilizado) em marca d'água | Cabos de patch que se "plugam" ao entrar na viewport (traçado + leve balanço com `--ease-mech`); onda do oscilador que se forma no hero; brilho de lâmpada pulsando lento no módulo ativo |
| Biblioteca | Geoff Emerick | Prateleiras de caixas de fita com etiquetas datilografadas; grade da janela da sala de controle; fita magnética serpenteando entre seções | Carretéis girando devagar nas pontas da fita; caixa que "desliza" ao rolar; poeira de luz na janela |
| Comparar | Les Paul | Carretéis multipista e caminho da fita pelas cabeças; diagrama sound-on-sound em traço; listras de fita colorida por pista | Fita correndo pelas cabeças ao entrar na seção; carretéis girando enquanto a página está visível; eco visual em camadas (sound-on-sound) no título |
| Soe como X | Andy Hildebrand | Sismograma e camadas geológicas (o homenageado veio da sísmica); curva de pitch correction quantizada em degraus | Traço sísmico que se desenha no hero; camadas geológicas em parallax leve; degraus de quantização "encaixando" |
| Comunidade | Bob Clearmountain | Superfície de console grande, fileiras de canais, fita crepe com nomes à mão; luz de "NO AR" | Faders decorativos que deslizam uma vez ao entrar (não são medidores, estão parados depois); luz NO AR com halo; flare de estúdio |
| Teste cego | Floyd Toole e Sean Olive | Sala de audição com cortina acústica, caixas atrás do tecido, lóbulos de dispersão (polar) como marca d'água, difusores | Cortina com ondulação lenta; lóbulos polares se expandindo do palco; partículas no cone de luz |
| Cabo | Ray Dolby | Rack 19" com alumínio escovado; fita com o "dobly" de pré-ênfase representado como curva de compansão; diagrama de blocos de redução de ruído | Curva de compansão que se desenha; carretéis da U4 (já existem, só com dado real) complementados por um fundo de bobinas paradas; brilho de LCD |
| Docs | Harry Nyquist | Papel milimetrado, amostras discretas sobre senoide, função sinc, telégrafo e fita perfurada | Amostras "pingando" sobre a senoide ao rolar; fita de telégrafo correndo (já existe, com pausa); diagrama de Nyquist que se traça |
| Auth e conta | Rupert Neve | Canal de console vertical, transformadores, knobs | Knobs girando suavemente para a posição ao validar (estado real, já existente); brilho do transformador |
| Perfil | Chris Lord-Alge | Parede de discos, sulcos de vinil, assinatura | Sulcos com reflexo girando; disco que gira 1/8 no hover (já existe) |
| Offline e erro | — | Fita cortada ou sinal interrompido | Traço que falha e volta |
