# Catálogo de firmware e comparação offline de variantes

Análise em **2026-10-29**, sem rede nesta fase, sem hardware e sem executar
firmware, ELF, updater ou bundle. São **10 arquivos guardados**: três originais
previamente decriptados e sete downloads adicionais, não os 59 itens do cadastro.
Nada aqui autoriza gravar uma imagem em outro aparelho.

## Proveniência e escopo

- Coleção: `_qa/firmware/catalog-20261029T030604720Z/manifest.json` e
  `scan-source.txt`; sete GETs anteriores, todos HTTP 200 e
  `application/octet-stream`. Nenhuma nova consulta API ou varredura nesta análise.
- SHA-256 da cópia integral dos 59 metadados capturados:
  `c93fdc60a11249b066daa52663be0a4ca1af2e0222132db675badd99316c974b`.
  A coleta conferiu o hash da fonte antes/depois; esta fase conferiu a cópia.
- Novos resultados: `_qa/firmware/variants-20261029T031500Z/`;
  `provenance.json`, `report.json`, sete `0xPID.result.json`, plaintexts,
  entradas não vazias, descritores extraídos e logs reais de execução.
- Três originais: resumo já validado em
  `_qa/firmware/decrypt-2026-10-29T02-49-07-096Z-47488/images/summary.json`.
  Seus plaintexts foram relidos, conferidos por hash e analisados como dados;
  **não foram novamente decriptados**.
- Os auxiliares e artefatos `_qa` são locais/ignorados pelo Git; esta nota é o
  registro versionável, não uma distribuição dos binários nem dos auxiliares.
- PID nominal da linha e `data.pid` determinam a seleção, não o nome do arquivo.
  `deviceType`, `schemeNo`, versão e nome abaixo são **rótulos da API**, não
  identificação comprovada do hardware. O PID 43CC vem do resumo original e da
  documentação anterior; não é um dos 59 registros da cópia da varredura.

Os metadados foram obtidos anteriormente pela rota
`POST https://walkplay-api.szwalkplay.com/api/v3-1/common/checkFirmwareVersion`,
com VID `0x3302` e o PID correspondente, conforme [ecossistema](ecosystem.md).
As URLs abaixo são os downloads registrados, **não novas consultas**.

## Dez arquivos preservados

Todos têm AES externo/PKCS7/container estruturalmente validados; isso **não**
valida assinatura, checksums internos, execução, autenticidade ou compatibilidade.
As versões e nomes são conservados exatamente como registrados.

### 0x43CC — original

- API: CB5100; scheme `16`; versão `1.4`; nome `CB5100_PID43CC_V1.4_251219`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/202602021611340fb8190cd6499b42f9.bin>
- Raw: 233552 bytes; SHA-256 `8a835fd109f3187660e42079ffd63167f1b602d8079a2ecf4ac10e82bb7c5a45`.
- Plain: 233543 bytes; padding 9; SHA-256 `37d97e0929b0fc885004e7d518bd85a97da91b794ff3db9a283c8b5fb9297a1e`.
- HID estático: grupo A; offset 132272.

### 0x43CD — original

- API: CB5100; scheme `16`; versão `0.4`; nome `CB5100_PID43CD_V0.4_260228`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/20260228154932c11768a31e9000f5f9.bin>
- Raw: 125312 bytes; SHA-256 `ecea93ce7058c56bb126a445d7f6e7d12204cc53e5ba7b4f320889d28d8d3b58`.
- Plain: 125308 bytes; padding 4; SHA-256 `847e173bd403bbfa780854a7ef2d9b6ea0999704546afa866f5657622292ff8c`.
- HID estático: grupo B; offset 125080.

### 0xC20F — original

- API: CB1200; scheme `11`; versão `0.2`; nome `CB1200_C20F_V0.2_260709`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/202607091523497e0b255de074326bb6.bin>
- Raw: 75856 bytes; SHA-256 `76d8e7c3edcb886800bad6e6ea84bfc28dc1a70519a3582073ca3f382530b254`.
- Plain: 75843 bytes; padding 13; SHA-256 `96635555d7f5cac87a6b0e33922103c7214df0acb277227af36005902ca314e5`.
- HID estático: grupo A; offset 75704.

### 0x1233 — novo

- API: CB1200; scheme `11`; versão `0.2`; nome `CB1200_1233_V0.2_260920_LRFIX_EQFIX`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/20260920151619ba5e7009eedffe9e1a.bin>
- Raw: 76016 bytes; SHA-256 `c39ce6032a1c4d2f580b84e4f810fefc625453d5111a3a117a87526188dd3553`.
- Plain: 76009 bytes; padding 7; SHA-256 `699565f48ceb1b918e1ae50417a1d884bbe529c6aadd7fdec2a96e2ba677cc0e`.
- HID estático: grupo A; offset 75864.

### 0x1237 — novo

- API: CB1200; scheme `11`; versão `0.5`; nome `CB1200_0x1237_v0.5_uac12`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/202610141046545aa0863bc02a3f7ef3.bin>
- Raw: 131392 bytes; SHA-256 `25982792c0e43fc1faa8e9dcac4fa82d25fe6239ed2a7965a66fc64236720f31`.
- Plain: 131390 bytes; padding 2; SHA-256 `3bfaac4ced7dc1a777bd334a5992b7b1a849ac14274f094e787d29455f5029f3`.
- HID estático: grupo A; offset 105664.

### 0x123F — novo

- API: CB1200; scheme `11`; versão `0.7`; nome `CB1200_0x123F_V0.7`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/202610131606034db6691ed26a976e65.bin>
- Raw: 131392 bytes; SHA-256 `e64b6fd5c0acb57e49e5ab5c6b23ae1f9954e69c4d59a99213fe4badfcb65ca5`.
- Plain: 131390 bytes; padding 2; SHA-256 `db987211aa98da65b00aacff1b899883620aabc8b3aad22771d819bfa54f5775`.
- HID estático: grupo A; offset 105664. Descritor igual não implica imagem igual.

### 0x4308 — novo

- API: CB5100; scheme `15`; versão `V0.2`; nome `CB5100_PID4308_V0.2`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/202601121433098aaacd1d65fda411f2.bin>
- Raw: 126528 bytes; SHA-256 `feed02499dcfb1dcd7f8e8e1e24f7553bfadea1fe7e3634d7f66cff4bddbea55`.
- Plain: 126524 bytes; padding 4; SHA-256 `e6a93289e2f214ccd1cf1b7c4fd6b53c56056a750734ae9ee689b89defad43de`.
- HID estático: grupo B; offset 126296; bytes completos iguais aos de 43CD.

### 0x43EE — novo

- API: CB5100; scheme `15`; versão `1.0.1`; nome `CB5100_43EE_V1.0.1`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/20260904135007c3d6bd1c97306e42a1.bin>
- Raw: 233552 bytes; SHA-256 `f62a8ca5dfe462facbd522966787c4e54a77c718e2d7edec5535e8eb36309e43`.
- Plain: 233543 bytes; padding 9; SHA-256 `8f0d88a7d83ea4b6675e2e7521b7470497455d825939aaf5fbae6d1724654067`.
- HID estático: grupo A; offset 133768.

### 0x431D — novo

- API: CB5100; scheme `16`; versão `0.2`; nome `CB5100PRO_0x431D_V0.2`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/20260720182231c51d9e0f8b26523cce.bin>
- Raw: 233552 bytes; SHA-256 `e155c575e62af84a64e5a9f92178403ab9987cc2dcdbc93e4a18c6ed38f888ee`.
- Plain: 233543 bytes; padding 9; SHA-256 `a07d94bd1e7dfee997279879d41a0d6a5e981a7eac40cf0567fd8b827f2cf2bb`.
- HID estático: grupo A; offset 132528. O texto PRO no nome não identifica hardware.

### 0x4336 — novo

- API: CB5100; scheme `16`; versão `0.2`; nome `CB5100_V0.2_20261026_4336`.
- Download: <https://walkplay-api.szwalkplay.com/api/common/download/20261026120741b4b52ee76f2deaadfc.bin>
- Raw: 233552 bytes; SHA-256 `7a3b0f5557dc2a33f59a1e636e1f8e6ca65454f7ad5f06571da5a27c5df7cb99`.
- Plain: 233543 bytes; padding 9; SHA-256 `2e03a5eafdee9b6681ffce6d0afd2791850451ff1bb3cebf59f37911f363b43d`.
- HID estático: grupo A; offset 134280; string de identificação divergente abaixo.

## Validação externa e limites do container

Derivação por arquivo, usando `data.code` da resposta capturada e conferida contra
a cópia da varredura, não um segundo literal independente:

```text
key = UTF8(MD5(UTF8(data.code)).hex.slice(0, 16))
AES-128-ECB, sem IV; remover PKCS7 somente após verificar cada byte do padding
```

Os sete passaram em uma única decriptação externa por arquivo, padding estrito,
magic `SPV@` em offset 4, flag superior `0x4f414d`, tabela de quatro entradas e
bounds. A re-encriptação coincidiu byte a byte, mas não é autenticação.
As funções puras de `decrypt.cjs` foram importadas sem executar sua CLI ou
alterar seus três inputs hardcoded. Nenhuma chave alternativa, fixup ou segunda AES.

Entradas `size=0` continuam metadados mesmo com endereço mascarado além do EOF:
sem acesso ao payload nem arquivo vazio. Entradas não vazias têm bounds e
interseções rigorosamente verificados. Flags baixas `0x40` foram preservadas e
anotadas, não corrigidas para `0x41`. Todos os dez raws e os três plaintexts
originais permaneceram inalterados; helpers originais também.

`encryptAddr=0x48001000` nos dez arquivos é somente um campo do container.
Os tamanhos declarados nos sete novos são, na ordem 1233/1237/123F/4308/43EE/431D/4336:
24576/40960/40960/49152/53248/45056/53248 bytes. Não se conclui que essa região
seja cifrada, ou que o restante seja código executável legível. Datas/horas,
checksums registrados, regiões e warnings completos estão nos resultados JSON.

## Descritores HID: comparação integral, não `85 CB`

Foi encontrado um candidato balanceado de **74 bytes** em cada um dos dez
plaintexts. O parser verificou itens completos, coleções, pilha global,
Report IDs, Report Size/Count e flags de Input/Output; os sete descritores
novos foram também salvos integralmente com offset e SHA-256.

**Limite importante:** são streams completos até o fechamento de uma coleção
de topo, mas não houve corroboração por tamanho de descritor HID em configuração
USB estática. Podem ser subdescritores de uma composição maior. A busca cobre
Usage Page `05`/`06` com Collection nos primeiros 24 bytes e itens curtos;
descritores gerados em runtime, não contíguos ou com itens longos não estão cobertos.
Não houve enumeração USB nem prova de ponteiro/handler ativo.

- **Grupo A:** 43CC, C20F, 1233, 1237, 123F, 43EE, 431D, 4336.
  SHA-256 `39042ab406abaf694caecb32f91601e7e766da6c7166b2ff544109d0a1d3a951`.
  Report IDs `0x03`, `0x4B`, `0x54`.
- **Grupo B:** 43CD, 4308.
  SHA-256 `66aa2e6592f21b583e246038a96d22e90bf689abea7340acea9c9e2f18d95ab0`.
  Report IDs `0x03`, `0x4B`, `0x01`.
- As igualdades são de **todos os 74 bytes**, não apenas do hash ou de dois bytes.
  Os 29 pares iguais foram conferidos pelo verificador de artefatos.
- Em ambos: `0x03` tem Input de 8 bits: 4 Data e 4 Constant (2 bytes com ID).
  `0x4B` e o terceiro ID têm Report Size 8, Count 63: 63 bytes de payload,
  64 incluindo ID, tanto Input quanto Output. Input usa flags `0x03`
  (**Constant**, Variable, Absolute); Output usa `0x02` (Data, Variable, Absolute).
  **Input Constant não é evidência de canal de resposta de dados.**
- 4308 e 43EE têm o mesmo rótulo API scheme 15, porém caem em grupos diferentes;
  43CD tem scheme 16 e o mesmo descritor de 4308. Logo o scheme, isoladamente,
  não seleciona esse layout HID nem prova o protocolo.

Bytes completos do grupo A:

```text
050c0901a1018503150025037501950209e909ea81027501950209cd09cf81027501950481010601ff854b7508953f09018103953f0902910285547508953f09038103953f09049102c0
```

Bytes completos do grupo B:

```text
050c0901a1018503150025037501950209e909ea81027501950209cd09cf81027501950481010601ff854b7508953f09018103953f0902910285017508953f09038103953f09049102c0
```

Nenhum campo Report ID `0xCB` foi encontrado nesses candidatos estruturais.
Isso **não prova ausência de todo protocolo `0xCB`**: não se analisou handler,
seleção de descritor em runtime ou toda forma possível de composição. Os literais
ASCII `EQ1#` e sua ordem reversa não apareceram nos dez plaintexts; é somente
uma busca literal, não prova de ausência de funcionalidade. Nenhum resultado
promove compatibilidade com Auri `0x3302:0x8902`.

## Strings de produto/SN: correlação, não identificação de hardware

Os seguintes candidatos têm cabeçalho de string USB e UTF-16LE imprimível.
Offsets são decimais, relativos ao plaintext. A associação a índices de
produto/SN não foi estabelecida por um device descriptor estático validado;
os nomes abaixo são conteúdos observados, não identificação do cabo real.

```text
PID    produto candidato (offset)        string tipo SN (offset)          correlação textual
43CC   Protocol Max (107480)             330243CC251219 (107412)          contém 3302 + PID
43CD   AURORA (100288)                   330243CD260228 (100220)          contém 3302 + PID
C20F   Protocol Micro (50776,50912)      3302C20F260709H (50844)          contém 3302 + PID
1233   G10 (50936,51072)                 33021233260920 (51004)           contém 3302 + PID
1237   WHIZZER BEAT DAC (80804,80872)    33021237261014 (80736)           contém 3302 + PID
123F   XIBERIA K-Blade (80736,80872)     3302123F261013 (80804)           contém 3302 + PID
4308   lifeme HS1 Pro (101504)           33024308260110 (101436)          contém 3302 + PID
43EE   lifeme HD2 (108976)               330243EE260904 (108908)          contém 3302 + PID
431D   BGVP Herculis (107736)            3302431D260720 (107668)          contém 3302 + PID
4336   Misiom-Star Ultra (109488)        12CC3011261026 (109420)          DIVERGE do padrão/PID nominal
```

Em 4336 não se deve reinterpretar `12CC3011` como confirmação de VID/PID,
nem trocar a identidade nominal por outro dispositivo. Strings genéricas
`SPACETOUCH` / `SPV4040 HIFI AUDIO` também coexistem em algumas entradas EXT;
não substituem os rótulos API nem provam CPU/chip.

## Verificação reproduzida

- 16/16 testes originais de AES/container e 10/10 testes novos, contagens
  explicitamente verificadas: manifesto contra payload da fonte, hash/tamanho
  incorretos, code/URL/PID divergentes, HID válido/truncado, Constant Input,
  múltiplas coleções, pilha e rejeição do simples hit `85 CB`.
- Driver: sete processados, sete validados, zero rejeitados,
  `hasRejectedInputs=false`; exit code 0.
- Verificador separado: sete resultados, 26 artefatos, sete descritores novos,
  zero campos CB, dez hashes raw inalterados e três plaintexts originais
  reutilizados. Recalculou hashes e reanalisou estrutura sem nova AES; exit code 0.
- Logs finais: `attempt-2-execution.json` e
  `attempt-2-{original-decrypt-tests,variant-tests,driver,verification}.execution.json`,
  com stdout/stderr, horários e exit codes reais. A primeira tentativa passou os
  16 testes, mas o harness rejeitou a contagem no reporter padrão; o log original
  foi preservado e a segunda execução selecionou TAP explicitamente.
- Outputs de dados criados com exclusividade (`wx`), sem sobrescrever a coleção,
  helpers ou resultados anteriores. Nenhuma instalação, rede ou hardware.

Para uma reprodução, escolher **outro diretório novo** e ajustar apenas o destino
dos auxiliares locais; executar `node run.cjs` em foreground. Não reexecutar o
driver sobre o mesmo destino: sua proteção contra sobrescrita é intencional.
