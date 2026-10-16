# Medições e alvos do AutoEq

## Conteúdo incorporado

O importador lê os CSV de medições e os alvos do projeto
[AutoEq](https://github.com/jaakkopasanen/AutoEq), sem incorporar os resultados de
equalização de `results/`, imagens, filtros prontos ou o repositório completo.
As pequenas amostras em `test/fixtures/autoeq/` são inventadas à mão para testes,
não são medições de produtos reais.

Referência conhecida: branch padrão `master`, commit
`7ae0f56d53074872b028649617a22bbb4232feb7`, de 20/07/2025.
O repositório completo ocupa aproximadamente 4,2 GiB, principalmente por causa de
`results/`, e não usa Git LFS. Por isso usamos um repositório bare com filtro
`blob:none`, sem checkout. `measurements/Rtings` e `measurements/rtings` coexistem
no Git, mas colidem em sistemas de arquivos sem distinção de caixa, como o Windows.
Os caminhos são lidos por `git ls-tree` e os blobs por `git cat-file --batch`.
Nunca se deve extrair esse repositório para importar as medições no Windows.

São aceitos os dois layouts:

```text
measurements/<fonte>/data/<tipo>/<modelo>.csv
measurements/<fonte>/<tipo>/<modelo>.csv
targets/<alvo>.csv
```

Os tipos `in-ear`, `over-ear`, `on-ear` e `earbud` viram, respectivamente, `iem`,
`over-ear`, `on-ear` e `earbud`. Alvos têm tipo `target` e fonte `AutoEq targets`.
Exemplos de alvos do upstream: Harman in-ear 2019, Harman over-ear 2018,
Diffuse field 5128 e Diffuse field ISO 11904-1. A presença efetiva depende do SHA.

Cada CSV `frequency,raw` passa por `parseMeasurement`, `toGrid` e `normalize`
de `src/io/measurement.mjs`. O resultado é uma resposta relativa, normalizada em
1 kHz, na GRID logarítmica de 481 pontos entre 20 Hz e 20 kHz. Não é uma medida
de SPL absoluto nem uma garantia de resposta para outra unidade, ponteira ou
acoplador. Falhas de formato ou cobertura geram um aviso com `MeasurementError`
e pulam apenas aquele arquivo. Não há extrapolação fora das regras do parser.

## Formato publicado

A saída padrão é `web/static/data/autoeq/`, ignorada pelo Git. Não versionar a
base gerada nem o cache do upstream. Publicar os arquivos de uma mesma geração
juntos para não misturar índice e packs de revisões diferentes.

- `manifest.json`: SHA, data do commit, data da geração, GRID, contagens de
  medições, alvos, arquivos pulados, valores limitados e packs, licença,
  fontes com crédito e link, exclusões solicitadas.
- `index.json`: lista ordenada por ID, com `id`, `name`, `brand`, `source`, `type`,
  `pack` e `offset`. O nome e a marca aproveitam `name_index.tsv` quando existem
  campos correspondentes. Sem marca explícita, usamos o primeiro token do nome,
  uma heurística que pode errar em marcas compostas.
- `measurements-<fonte>-<tipo>-001.bin`, `002.bin` etc.: packs separados por
  fonte e tipo, cada um com até 5 MiB. Fontes com slugs iguais recebem um sufixo
  hash sensível à caixa, preservando a distinção entre `Rtings` e `rtings`.
- `targets-001.bin` etc.: packs exclusivos dos alvos, com o mesmo limite.

Cada entrada ocupa 962 bytes: 481 inteiros int16 little-endian, sem cabeçalho.
`offset` é um deslocamento em **bytes**, múltiplo de 962. Dividir cada inteiro
por 100 recupera dB. A quantização tem passo de 0,01 dB e erro inferior a 0,01 dB
para valores não limitados. Valores fora de ±327,67 dB são limitados e
contabilizados, com aviso por arquivo. Não usar a interpretação nativa de um
`Int16Array` sem garantir a ordem dos bytes.

A ordem dos caminhos, IDs, packs e exclusões é determinística. Para os mesmos
arquivos e opções, os binários e o índice não mudam; `generatedAt` registra cada
execução. Em `--from-tree`, `sha` é `from-tree` ou o SHA informado, e
`commitDate` é `null`, pois a pasta não prova a origem dos arquivos.

## Licença e atribuição das fontes

AutoEq é distribuído sob a licença MIT:
**Copyright (c) 2018-2022 Jaakko Pasanen**.
Consulte a [licença upstream](https://github.com/jaakkopasanen/AutoEq/blob/master/LICENSE).
O manifesto registra `MIT (AutoEq)`. Preserve o aviso de copyright e o texto da
licença na distribuição, inclusive nos avisos de terceiros da aplicação.

As medições continuam creditadas às respectivas fontes. O crédito ao AutoEq não
transforma o projeto no autor das medições e não implica endosso dos laboratórios
ou das marcas. A lista **completa da geração publicada** está em
`manifest.json`, campo `sources`: cada item contém nome original, quantidade de
medições aproveitadas, atribuição e link para a pasta no SHA importado. Essa
lista é derivada do Git, não de uma lista fixa que pode ficar desatualizada.

| Fonte ou conjunto | Atribuição mantida | Referência |
| --- | --- | --- |
| `Rtings` | Medições: Rtings; distribuição: AutoEq, Jaakko Pasanen, MIT | `manifest.sources`, item `name: "Rtings"` |
| `rtings` | Medições: rtings; distribuição: AutoEq, Jaakko Pasanen, MIT | `manifest.sources`, item `name: "rtings"`, distinto do anterior |
| Demais fontes presentes | Medições: nome original da fonte; distribuição: AutoEq, Jaakko Pasanen, MIT | Um item por fonte em `manifest.sources`, com link permanente |
| `AutoEq targets` | Alvos: AutoEq, Copyright (c) 2018-2022 Jaakko Pasanen, MIT | Pasta `targets/` no SHA do manifesto |

O cliente oferece `getAttribution(entry)` ou `getAttribution(source)` para exibir
esses créditos ao selecionar uma medição ou alvo. A identidade da fonte distingue
maiúsculas e minúsculas, mesmo que a busca não faça essa distinção.

## Solicitar remoção

Abra uma issue neste repositório, informando a fonte, os modelos ou caminhos e
o motivo do pedido. Para remover uma fonte da distribuição, regenere com
`--exclude-source "Nome exato da fonte"`. A opção pode ser repetida e distingue
maiúsculas de minúsculas. `--exclude-source Rtings` não exclui `rtings`.
`--exclude-source "AutoEq targets"` exclui os alvos. As exclusões aparecem no
manifesto; packs antigos produzidos pelo importador são removidos da pasta de
saída na regeneração. A publicação deve substituir o conjunto anterior e invalidar
os caches que ainda o disponibilizem. A exclusão local não altera o upstream.

## Regeneração

Requisitos: Node.js compatível com o projeto e Git com suporte a clones parciais.
O script é ESM e usa apenas módulos nativos do Node e o parser local.

```text
node tools/import-autoeq.mjs [--sha <sha>] [--out web/static/data/autoeq] [--cache <dir>] [--exclude-source <name>]... [--from-tree <dir>]
```

Exemplo reproduzível, a executar pelo responsável pela atualização:

```powershell
node tools/import-autoeq.mjs --sha 7ae0f56d53074872b028649617a22bbb4232feb7
node tools/import-autoeq.mjs --exclude-source Rtings --exclude-source rtings
```

Sem `--sha`, o script consulta
`https://api.github.com/repos/jaakkopasanen/AutoEq/commits/master` com `fetch`.
Em falha de rede, HTTP ou resposta inválida, usa o SHA em cache com data de commit
mais recente, informa a escolha e não inventa uma revisão. Sem cache utilizável,
encerra com erro. Com `--sha`, não consulta a API. O SHA deve ter 40 caracteres
hexadecimais.

O cache padrão é `os.tmpdir()/Claude/autoeq/<sha>`, normalmente
`%TEMP%\Claude\autoeq\<sha>` no Windows. `--cache <dir>` troca a raiz que contém
as subpastas por SHA, não a pasta de saída. Cada revisão usa `git init --bare`
e `git fetch --filter=blob:none --depth=1 origin <sha>`. O importador busca em
lotes apenas os blobs necessários, inclusive os índices TSV. Não baixa `results/`
nem usa LFS. Um cache completo permite regeneração offline. Um cache contendo só
o commit, mas sem os blobs necessários, ainda exige acesso ao upstream.

Teste manual sem rede com as amostras inventadas, usando uma saída descartável:

```powershell
node tools/import-autoeq.mjs --from-tree test/fixtures/autoeq --out web/static/data/autoeq
```

Não publicar essa saída de teste como se fossem medições reais. `--from-tree`
nunca consulta a rede, mesmo sem `--sha`. As pastas locais são úteis para testes,
não para contornar a colisão de caixa do upstream.

Antes de publicar, execute `npm test`, confira os avisos de arquivos pulados e
limitações, revise `manifest.json`, a atribuição e as exclusões, e valide o cliente
com os testes unitários web. A execução real com rede e a configuração do comando
`data:autoeq` pertencem ao processo de atualização do projeto.

## API web

`web/src/lib/data/autoeq.ts` exporta:

- `loadIndex()` e `loadManifest()`, com cache de promessas e nova tentativa em erro;
- `search(query, limit?)`, busca por modelo, marca e fonte, sem distinção de acento
  ou caixa, priorizando tokens exatos e prefixos; aceita um erro simples em tokens
  mais longos. `searchEntries(entries, query, limit?)` é a variante sem I/O;
- `loadEntry(entry)`, que busca o pack inteiro sob demanda e devolve
  `{ frequencies: GRID, values }`, com valores em dB. Requisições simultâneas
  compartilham o mesmo pack em memória. Não exige suporte a HTTP Range;
- `getAttribution(entryOrSource)`, que lê os créditos do manifesto;
- `createAutoEqClient({ baseUrl?, fetchImpl? })`, para instâncias isoladas e testes.

Buscar ou carregar o índice não baixa os packs. O cliente não implementa seu
próprio armazenamento persistente: os mesmos URLs podem ser armazenados pelo
service worker para uso offline posteriormente. Ao trocar de geração, recarregue
o cliente e atualize os caches juntos, pois nomes de packs podem ser reutilizados.
