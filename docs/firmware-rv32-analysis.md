# Evidência offline de código RV32 nos firmwares 43CC, 43CD e C20F

Continuação: [mapa estático parcial dos comandos `0x4B`](firmware-protocol-4b.md), com separação entre calls regionais, alcançabilidade no CFG e efeitos dos callees. As conclusões históricas desta nota permanecem preservadas.

**Estado:** revisão técnica direta concluída em 2026-10-29; resultado aceito como **análise estática parcial com limites**. Não é uma identificação definitiva do processador nem uma especificação do protocolo de aplicação.

**Atualização posterior:** a seção [XAndesPerf](#atualização-xandesperf-29102026) registra uma nova passagem que resolve várias barreiras do decoder inicial e encontra candidatos fortes de dispatch `0x4B`. As conclusões de desconhecimento nas seções iniciais são históricas, referentes ao baseline sem a extensão; não devem ser lidas como resultado final dessa passagem posterior.

## Escopo e disponibilidade da evidência

Esta nota registra uma reprodução nova da análise estática de três imagens previamente decriptadas externamente. Firmware foi tratado somente como dados (`Buffer`); não houve execução/emulação de firmware, ELF ou bundle, acesso a hardware/HID/USB, rede, instalação de ferramentas, commit, stage ou push.

Os helpers experimentais, imagens e logs ficam em `_qa`, que é **ignorado pelo Git**. Esta nota é o registro versionável dos resultados; não distribui binários nem os helpers. **Um clone sem esses arquivos locais não consegue repetir os comandos abaixo apenas com esta nota.** Os resultados não devem ser confundidos com uma suíte de reprodução distribuída no repositório.

Proveniência local, relativa à raiz do repositório:

* Entrada: `_qa/firmware/decrypt-2026-10-29T02-49-07-096Z-47488/images/summary.json` e `{43CC,43CD,C20F}/plaintext.bin` sob o mesmo diretório.
* Execução anterior, preservada: `_qa/firmware/rv32-analise-2026-10-29T02-52-00Z/`.
* **Reprodução desta nota:** `_qa/firmware/rv32-analise-20261029T030313711Z/`.

A reprodução copiou **somente nove helpers `.cjs`/`.ps1`** da execução anterior, usando `FileMode.CreateNew`, sem sobrescrita. Seus hashes de origem/cópia coincidiram; não foi necessário corrigir os wrappers utilizados. Depois foi acrescentado, somente no novo diretório, `inspect-reproduction.cjs`, para uma inspeção independente dos bytes, hashes e stdout reais. Nenhum arquivo da execução anterior foi alterado: os manifestos recursivos antes/depois coincidiram.

Esta contribuição acrescenta somente esta nota ao conjunto de arquivos versionáveis. Alterações já existentes em outras notas, documentação de UI ou testes de outros trabalhos não são atribuídas a esta análise.

## Entradas e decriptação externa anterior

O `summary.json` descreve a camada externa como AES-128-ECB com PKCS#7 estrito, com chave de 16 bytes **textuais**, não oito bytes decodificados de hexadecimal:

```js
Buffer.from(createHash('md5').update(code, 'utf8').digest('hex').slice(0, 16), 'utf8')
```

Essa derivação é proveniência da extração anterior, **não uma decriptação refeita neste job**. Os hashes raw abaixo são os declarados pelo summary anterior; nesta reprodução foram recalculados os hashes dos plaintexts e do próprio summary, não dos arquivos raw. Roundtrip anterior não é autenticação, e checksums de firmware não foram validados aqui.

| Imagem | `code` da extração | Build string no plaintext | Tamanho plaintext |
|---|---|---|---:|
| 43CC | `202602021611340fb8190cd6499b42f9` | `Dec 19 2025` / `11:26:48` | 233543 |
| 43CD | `20260228154932c11768a31e9000f5f9` | `Feb 28 2026` / `14:50:41` | 125308 |
| C20F | `202607091523497e0b255de074326bb6` | `Jul  9 2026` / `15:17:08` | 75843 |

SHA-256 raw, conforme `summary.json`:

```text
43CC 8a835fd109f3187660e42079ffd63167f1b602d8079a2ecf4ac10e82bb7c5a45
43CD ecea93ce7058c56bb126a445d7f6e7d12204cc53e5ba7b4f320889d28d8d3b58
C20F 76d8e7c3edcb886800bad6e6ea84bfc28dc1a70519a3582073ca3f382530b254
```

SHA-256 plaintext, **recalculados e iguais antes/depois**, inclusive após LLVM e inspeção independente:

```text
43CC 37d97e0929b0fc885004e7d518bd85a97da91b794ff3db9a283c8b5fb9297a1e
43CD 847e173bd403bbfa780854a7ef2d9b6ea0999704546afa866f5657622292ff8c
C20F 96635555d7f5cac87a6b0e33922103c7214df0acb277227af36005902ca314e5
```

O summary também permaneceu inalterado: SHA-256 `1aab88c90705201dac5d95da17ea10523de397502ba6696847675b2396598e4c`. `reproduction-inputs-before.json` e `reproduction-inputs-after.json` registram esses quatro arquivos.

## Hipótese RV32: evidência positiva, sem fechar o modelo de CPU

Ferramentas locais efetivamente usadas: **Node v24.22.1**, PowerShell e **LLVM 23.1.4** (`llvm-objdump`). A execução via shell PowerShell foi o fallback autorizado após a recusa de Node pela allowlist de `router_run` informada na dispatch anterior; essa recusa não foi reproduzida nesta execução e nenhuma configuração global foi alterada.

Há sequências coerentes little-endian de instruções de **16 e 32 bits**, corroboradas pelo LLVM: fluxo do bootstub, acesso a CSRs, operandos consistentes, prólogos/epílogos e pilha balanceada. Isso é evidência muito mais forte que contar opcodes em dados, mas **não prova Andes D25F exato**, nem todas as extensões presentes.

### Palavra inicial e bootstub

Nas três imagens, offset `0`: bytes `6f 00 40 0a`, word LE `0x0a40006f` (171966575). Para JAL: opcode `0x6f`, rd=0, `imm[20]=0`, `imm[10:1]=0x52`, `imm[11]=0`, `imm[19:12]=0`; deslocamento assinado **+0xa4**. Portanto a hipótese inicial é `jal x0,+0xa4`, pulando o header `SPV@` em offset 4. O cálculo foi testado com vetores e confrontado com o desassemblador real.

| Offset | Bytes em ordem de arquivo | Interpretação corroborada |
|---|---|---|
| `0x0` | `6f00400a` | `jal x0,+0xa4` |
| `0xa4` | `b7020048` | `lui t0,0x48000` |
| `0xa8` | `9382020b` | `addi t0,t0,0xb0` |
| `0xac` | `67800200` | `jalr x0,0(t0)` → absoluto `0x480000b0` |
| `0xb0` | `970214b8` | `auipc t0,0xb8140` |
| `0xb4` | `938202f5` | `addi t0,t0,-0xb0` |
| `0xb8` | `1681` | `c.mv sp,t0` |
| `0xba` | `5d37` | `c.jal` → offset `0x60` |
| `0xbc` | `ef005074` | `jal ra` → offset `0x1000` |

O header da entrada CPU indica `0x48000000`; o salto absoluto `a4→b0` corrobora **localmente** essa base candidata. Com ela, `b0/b4` forma `0x00140000`, transferido a sp. Isso não fixa o mapa global. A continuação após uma chamada no walker supõe retorno da chamada; não é uma execução observada.

O helper em `0x60` possui branch `0x88→0x94` e retorno `8280` em `0xa0`, mas contém a primeira barreira custom em `0x66`: bytes `5bfd1703`, word `0x0317fd5b`, também `<unknown>` no LLVM padrão. Não foi inventado mnemônico para essa palavra.

### Código coerente em `0x1000`

Bytes iniciais comuns, exceto o salto posterior:

```text
1000 b7520020  lui t0,0x20005
1004 03a30201  lw t1,0x10(t0)
1008 83a34201  lw t2,0x14(t0)
100c b3627300  or t0,t1,t2
1010 63880200  beq t0,zero,1020
1014 f3222034  csrrs t0,0x342,zero  # LLVM: mcause
1018 63840200  beq t0,zero,1020
```

43CC em `0x101c` salta para `0x106c`; 43CD/C20F, para `0x1070`. Esses destinos têm loop para si mesmos. Outro caminho inicializa gp/sp, faz read/modify/write de `0x20003024` e acessa CSRs `0x300`, `0x003`, `0x7ca`, `0x7d0`, `0x305`. Há chamadas `43CC:0x106a→0x12e0` e `43CD/C20F:0x106e→0x12e4`.

Endereços efetivos como `0x20005010`, `0x20005014`, `0x20003024` e `0x20110120` são **MMIO candidatos**, sem nomes de registradores físicos atribuídos: não há mapa oficial suficiente. Barreiras adicionais incluem word `0x4007d85b`, bytes `5bd80740`, em `43CC:0x1302` e `43CD/C20F:0x1306`. “Unknown/custom” significa decoder insuficiente, não instrução ilegal ou prova de criptografia.

## Faixas anotadas, entropia e código após elas

O header informa `encryptAddr=0x48001000`; intervalos abaixo são offsets com fim exclusivo. **Anotação não demonstra que toda a faixa ainda tenha cifra interna uniforme**, nem que a remoção de AES externo tenha removido toda proteção. A presença de código coerente em `0x1000` é observação direta; nenhuma decifração secundária, XOR ou brute force foi tentado.

Entropia Shannon empírica (bits/byte):

| Imagem | `[0,0x1000)` | Faixa anotada | Após faixa até fim CPU |
|---|---:|---|---|
| 43CC | 0.408888 | `[0x1000,0xc000)`: 6.884258 | `[0xc000,0x20594)`: 6.844842 |
| 43CD | 0.410349 | `[0x1000,0xd000)`: 6.888057 | `[0xd000,0x1e97c)`: 6.703512 |
| C20F | 0.402616 | `[0x1000,0x7000)`: 6.596598 | `[0x7000,0x12843)`: 6.512160 |

As bordas contêm zeros/tabelas, não uma continuação de código comprovada. A região de 43CC após fim CPU inclui grande padding e pequena entrada EXT; não foi misturada ao cálculo de “após faixa até fim CPU”. Entropia sozinha não classifica código nem proteção.

Foram encontrados 19/16/13 candidatos pós-faixa de função (43CC/43CD/C20F) com ajuste negativo de sp, save/restore de ra, ajuste positivo balanceado e retorno, sem desconhecido na sequência linear considerada. Branches condicionais podem sair da janela; esses candidatos **não são todos alcançáveis desde reset por prova estática**.

Exemplos confirmados também por LLVM, em bytes/largura das instruções:

| Imagem | Intervalo | Bytes | Instruções conferidas | Quadro de pilha |
|---|---|---:|---:|---:|
| 43CC | `[0x100c8,0x10164)` | 156 | 65 | 112 bytes |
| 43CD | `[0x10c78,0x10d1c)` | 164 | 67 | 112 bytes |
| C20F | `[0x813c,0x81d8)` | 156 | 62 | 112 bytes |

Prólogo comum `5971 86d6 a2d4`; epílogo `b650 2654 6561 67800000`. Calls diretos de exemplo: `43CC:0x10134→0x14414`, `0x10140→0x1450c`. Não foram identificados como funções HID. Entre os candidatos pós-faixa encontrados, não houve transferência direta identificada para dentro da faixa anotada; isso não exclui chamadas indiretas, extensões ou outros pontos de entrada.

### Limite importante: base flash não resolve o callgraph global

Pares AUIPC/JALR têm resultados incompatíveis com uma única interpretação ingênua de PC flash. Exemplos sintáticos de `evidence.json`:

| Imagem/offset | Bytes do par | Alvo com PC base `0x48000000` | Alvo no cenário de PC base zero |
|---|---|---|---|
| 43CC `0xe9f0` | `97300048e78000b3` | `0x90011520` | `0x48011520` |
| 43CD `0xf958` | `97800048e780c08e` | `0x90017244` | `0x48017244` |
| C20F `0x7918` | `97600048e780404f` | `0x9000de0c` | `0x4800de0c` |

É necessário esclarecer alias, cópia/link/relocação e destinos externos, sem escolher uma base silenciosamente. O cenário zero não foi comprovado. O decoder mantém destinos fora do arquivo como externos/não resolvidos, em vez de mascará-los para encaixar em bytes disponíveis.

## Descritores HID compostos e limites de capacidade

O parser local exige sequência composta de itens, coleção balanceada, main fields, report size/count e limites; não é uma busca de dois bytes. Há um candidato completo de **74 bytes** em cada imagem:

| Imagem | Offset | Report IDs | SHA-256 dos 74 bytes |
|---|---|---|---|
| 43CC | `0x204b0` | `03,4b,54` | `39042ab406abaf694caecb32f91601e7e766da6c7166b2ff544109d0a1d3a951` |
| 43CD | `0x1e898` | `03,4b,01` | `66aa2e6592f21b583e246038a96d22e90bf689abea7340acea9c9e2f18d95ab0` |
| C20F | `0x127b8` | `03,4b,54` | `39042ab406abaf694caecb32f91601e7e766da6c7166b2ff544109d0a1d3a951` |

Descritor completo idêntico de 43CC/C20F:

```text
050c0901a1018503150025037501950209e909ea81027501950209cd09cf81027501950481010601ff854b7508953f09018103953f0902910285547508953f09038103953f09049102c0
```

43CD troca `8554` por `8501` na seleção do segundo ID vendor; o restante coincide. Há usage page Consumer `0x0c` e vendor `0xff01`. Os IDs vendor descrevem 63 bytes de 8 bits por INPUT/OUTPUT, além do ID. **INPUT tem flags `0x03` (Constant/Variable/Absolute); OUTPUT tem `0x02` (Data/Variable/Absolute).** Portanto não se deve afirmar que o INPUT Constant seja um canal real de respostas. Nenhuma enumeração USB foi observada.

O filtro de ponteiros completos/formação local de endereço não conectou esses descritores a um handler. Busca composta de constantes de report ID, byte load e branch também não forneceu candidato que passasse o filtro. Isso não cobre gp com contexto externo, tabelas relocadas, construção dinâmica ou extensões desconhecidas. IDs e comandos CB/4B do aplicativo **não transferem capacidades desses produtos ao Auri**: não há firmware identificado como Auri neste conjunto. Handler HID e protocolo completo continuam **não identificados**.

### Strings e referências locais

* 43CC EXT em `0x3901a`: UTF-16LE **`SPV4040 HIFI AUDIO`**, com espaços; em `0x39003`, `SPACETOUCH`. EXT é a entrada do container, não parte da string. Isso não fecha a identificação de CPU ou compatibilidade Auri.
* C20F em `0x77a4`: ASCII `USB_PLAYING`. `0xaa68:37750048` + `0xaa6c:1305457a` forma `0x480077a4` em a0. Em `0xaa60/aa64`, a5 recebe um valor carregado de `0x00080080`; a chamada indireta seguinte usa **o conteúdo carregado**, não o endereço `0x80080` como alvo conhecido. A referência é local, sem conexão comprovada à raiz de reset ou handler HID.
* Build strings: 43CC `0xc9f4/0xca00`, 43CD `0xdaa8/0xdab4`, C20F `0x7720/0x772c`. Referências literais completas foram encontradas no header `0x14/0x18`; não foi descoberta referência de código adicional no filtro usado.
* Busca literal `EQ1#`, `Q1#`, reversão `#1QE`, ASCII/UTF-16LE: sem hit. Não exclui constante distribuída/codificada, outras codificações ou comando equivalente.

Comparações entre imagens usaram também intervalos idênticos de pelo menos 32 bytes, âncoras exatas deslocadas de 64 bytes e descritores completos. Coincidências curtas como `8280` não foram promovidas a símbolo comum ou evidência suficiente de arquitetura.

## Execuções, testes e auditoria desta reprodução

Os dois runners foram executados **em foreground**, sem processo background duplicado:

| Comando | Início UTC | Fim UTC | Exit code |
|---|---|---|---:|
| `pwsh -NoProfile -File <novo-run>/run.ps1` | `2026-10-29T03:03:13.8700439Z` | `2026-10-29T03:03:16.7699330Z` | 0 |
| `pwsh -NoProfile -File <novo-run>/final-verify.ps1` | `2026-10-29T03:03:16.7814018Z` | `2026-10-29T03:03:17.9779854Z` | 0 |

Ambos executaram efetivamente `selftest.cjs`: **11 testes, 11 pass, 0 fail** em cada execução. Cobrem extensão de sinal, JAL +4/-4/min/max/header, branches +8/-4/min/max, roundtrip exaustivo dos 1.048.576 deslocamentos pares JAL e 4096 de branch, stepping 16/32, saltos/branches C, truncamento/custom, limites, propagação conservadora, CFG sintético, ELF, entropia e HID composto/malformado. O controle BE é limitado: não implementa uma alternativa completa de RISC-V big-endian.

Confronto com LLVM real: **317 instruções iniciais** (105/106/106 por imagem) em bytes/largura e **48 alvos diretos**, mais **194 instruções** nas três funções pós-faixa e **4 alvos diretos**. Isso não valida cada operando de cada opcode do decoder parcial, nem a execução de todos os caminhos. O walker para em desconhecidos e não atribui semântica a eles.

Arquivos de auditoria sob o novo run:

* `copy-audit.json`: nove cópias sem sobrescrita, hashes de origem/destino.
* `reproduction-executions.json`, `run.ps1.{stdout,stderr}.txt`, `final-verify.ps1.{stdout,stderr}.txt`: comandos, timestamps e códigos dos runners.
* `logs-20261029T030314160Z/executions.json`: **9 subprocessos com exit 0**, incluindo testes, análise, versão LLVM, três disassemblies, followup e evidence.
* `final-logs-20261029T030317051Z/executions.json`: **5 subprocessos com exit 0**, incluindo testes, três funções LLVM e verificação final.
* Todos os 14 stderr desses subprocessos estavam vazios na inspeção.
* `analysis.json`, `followup.json`, `evidence.json`, `verification-final.json`, `*.graph.json`, `*.hexdump.txt`: dados e mapeamentos detalhados; ELF são apenas wrappers para leitura pelo desassemblador.
* `inspection-execution.json`, `inspection.stdout.txt`, `inspection.stderr.txt`, `inspection-result.json`: inspeção independente **exit 0**, que releu stdout real, bytes em `0/0xa4/0x1000`, os três descritores de 74 bytes, hashes dos inputs e identidade das cópias.
* `reproduction-inputs-{before,after}.json` e `previous-run-hashes-{before,after}.json`: entradas e execução anterior inalteradas.

Esta reprodução passou sem corrigir os nove helpers copiados. O `verify.ps1` histórico, também copiado, não foi usado: seu default aponta ao log antigo e sua etapa followup é one-shot. Os runners documentados acima usam o diretório novo e concluíram com sucesso. Não foi executada a suíte do aplicativo; nenhum arquivo de UI/teste renderer foi alterado neste trabalho.

## Repetição local, se os artefatos estiverem disponíveis

Exige as imagens locais com os hashes acima e os helpers experimentais; **não implica disponibilidade em clone**. Usar diretório irmão novo porque os auxiliares recusam sobrescrita de artefatos:

```powershell
$old = '_qa/firmware/rv32-analise-2026-10-29T02-52-00Z'
$new = '_qa/firmware/rv32-analise-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
New-Item -ItemType Directory $new -ErrorAction Stop | Out-Null
Get-ChildItem $old -File | Where-Object { $_.Extension -in '.cjs','.ps1' } | ForEach-Object {
  $inputStream = [IO.File]::OpenRead($_.FullName)
  try {
    $outputStream = [IO.File]::Open((Join-Path (Resolve-Path $new).Path $_.Name),
      [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
  } finally { $inputStream.Dispose() }
}
pwsh -NoProfile -File "$new/run.ps1"
if ($LASTEXITCODE -ne 0) { throw 'run.ps1 failed' }
pwsh -NoProfile -File "$new/final-verify.ps1"
if ($LASTEXITCODE -ne 0) { throw 'final-verify.ps1 failed' }
```

Exemplo da operação de desassemblagem usada, **não execução do ELF**:

```powershell
llvm-objdump --disassemble --triple=riscv32 --mattr=+m,+a,+c,+f,+d `
  --start-address=0x480000a4 --stop-address=0x480000c0 "$new/43CC.candidate.elf"
```

A seção ELF completa inclui dados/header/padding. Disassembly linear pode perder fronteira nesses dados; não tratar todo stdout como código. São necessários contexto, destinos e sequências coerentes, não apenas quantidade de mnemônicos.

## Fontes de contexto e próximo bloqueio

URLs fornecidas como contexto da pesquisa anterior, **não acessadas nem baixadas neste job**:

* Andes D25F: <https://www.andestech.com/en/products-solutions/andescore-processors/riscv-d25f/>.
* Fabricante Spacetouch: <https://www.spacetouch.co/pro8>.

A relação pública SPV4040/D25F não estabelece por si CB5100→D25F. Faltam decoder/documentação confiável dos opcodes custom efetivamente encontrados e mapa de execução/alias/relocação que explique os AUIPC/JALR. Depois disso, é necessário conectar callbacks/descritores a uma rotina real de recebimento e dispatch no firmware correto.

**Conclusão da etapa inicial, sem XAndesPerf:** leitura parcial de código RV32LE com mistura 16/32 corroborada por ferramenta independente; modelo exato, callgraph global, handler HID e protocolo de aplicação completo **inconclusivos**. Não foi demonstrado que um handler resida necessariamente numa zona criptografada, e nenhuma capacidade Auri foi inferida.

## Atualização XAndesPerf — 29/10/2026

Nova execução local: `_qa/firmware/xandes-analise-20261029T030839566Z/`. Usa exclusivamente os três plaintexts já aceitos e nove helpers copiados da reprodução aceita `rv32-analise-20261029T030313711Z`, preservados sem alteração. Nenhuma imagem da coleta paralela de outros firmwares foi usada. Os arquivos `_qa` continuam locais/ignorados, sem promessa de reprodução em clone sem esses artefatos.

### Feature nativa confirmada e fixtures

Antes de usar a extensão, `llvm-objdump --disassemble --triple=riscv32 --mattr=help` foi executado sobre o ELF candidato aceito. O LLVM local **23.1.4** lista literalmente `xandesperf — 'XAndesPerf' (Andes Performance Extension)`. A confirmação real foi preservada em `feature-help.{stdout,stderr}.txt` e `feature-help.execution.json`.

Foram geradas desmontagens dos mesmos bytes com `--mattr=+m,+a,+c,+f,+d` e com `--mattr=+m,+a,+c,+f,+d,+xandesperf`. Não foi baixado toolchain. Os ELF são somente invólucros de dados lidos pelo LLVM.

| Word LE | Interpretação nativa corroborada | Consequência |
|---|---|---|
| `0317fd5b` | `nds.bbc a5,17,+58` | Em offset `0x66`, alcança `0xa0`; a barreira inicial desaparece. |
| `4007d85b` | `nds.beqc a5,64,+16` | Em `43CC:0x1302`, destino `0x1312`; em `43CD/C20F:0x1306`, destino `0x1316`. |
| `0cd787db` | `nds.lea.w a5,a5,a3` | Compatível com formação `a5 + (a3 << 2)`, não salto. |
| `c203970b` | `nds.addigp a4,-27616` | Permite examinar endereços GP-relativos sob contexto explícito. |

Um decoder auxiliar pequeno cobre apenas essas classes fornecidas pelo recorte público de TableGen; o LLVM nativo decodifica as demais. Os campos que parecem `rd` nas branches custom **são imediatos**, não registradores de destino. Foram confrontadas **34 fixtures nativas**, incluindo sinal/limites de branches, BBC/BBS/BEQC/BNEC e ADDIGP negativo/positivo/ímpar. A suíte inicial de 11 testes passou; a suíte nova, após auditoria do parser, passou **7/7**, incluindo roundtrip de todos os 262144 imediatos assinados de 18 bits e invalidação de constantes nas junções de PC RAM.

Há um cuidado adicional de ferramenta: o LLVM imprime alguns `<unknown>` longos com vários grupos de bytes na mesma linha. O parser exploratório inicialmente confundia o segundo grupo com mnemônico. Isso foi corrigido e coberto por teste; **usar os artefatos `*-audited` e `final-findings.json`, não os mapas exploratórios anteriores, para contagens, barreiras e CFGs finais**. Os logs anteriores foram preservados, não sobrescritos.

### GP e evidência de cópia na inicialização

O par AUIPC/ADDI em `0x1020/0x1024`, ainda sob PC flash localmente corroborado, forma:

| Imagem | GP candidato | Texto a copiar: offsets de arquivo → PC candidato | Dados inicializados: origem → RAM candidata |
|---|---|---|---|
| 43CC | `0x00106be0` | `[0xe900,0x1a10a)` → `[0,0xb80a)` | `0x1a120` → `0x00100000`, tamanho `0x6478` |
| 43CD | `0x00106b48` | `[0xf8b0,0x18586)` → `[0,0x8cd6)` | `0x185a0` → `0x00100000`, tamanho `0x63e0` |
| C20F | `0x00106a88` | `[0x78f8,0xc56a)` → `[0,0x4c72)` | `0xc580` → `0x00100000`, tamanho `0x62c8` |

Não são aliases escolhidos para ajustar os resultados: os argumentos são montados em rotinas de inicialização e passados ao destino externo **`0x00080318`**, como `a0=destino`, `a1=origem flash`, `a2=tamanho` calculado por subtração. Em seguida há também chamada com zero em a1 para outro destino externo (`0x80410`) e `fence.i`. Isso é evidência estática forte de inicialização/cópia/zeragem, **não prova da implementação externa, que não está disponível e não foi executada**. A interpretação mantém explícita essa condição.

Chamadas de cópia candidatas: texto/dados em `43CC:0x57dc/0x5810`, `43CD:0x62c0/0x62f4`, `C20F:0x3b74/0x3ba8`. Uma cópia temporária anterior, de `0x1368` para zero com tamanho `0xa8`, mostra que o conteúdo em endereço zero pode variar por fase de startup; não se deve construir um mapa único que ignore a ordem de inicialização.

O tamanho de dados solicitado em 43CD alcança **4 bytes além do plaintext**; em C20F, **5 bytes**. Nenhum desses bytes foi lido, inventado, zerado ou recuperado de padding. O descritor completo está dentro dos bytes disponíveis, mas a borda impede afirmar uma imagem RAM final completa. Em 43CC há bytes disponíveis após a entrada CPU; isso também não transforma padding em código.

Sob esse cenário explícito, os AUIPC/JALR antes contraditórios deixam de exigir PC flash global. Exemplo: `43CC:file 0xe9f0` corresponde a **PC `0xf0`**, não ao antigo cenário simplificado `PC=fileOffset`. O par `97300048e78000b3` então chega a `0x48002c20`, enquanto executar os mesmos bytes no PC flash original daria `0x90011520`. Analogamente: `43CD:file 0xf958 / PC 0xa8 → 0x48007994`; `C20F:file 0x7918 / PC 0x20 → 0x48006514`.

O código candidato copiado foi desmontado novamente em ELF com base zero, não apenas remapeado silenciosamente no relatório. Nele não foram encontrados writes em GP nas instruções decodificadas. Usar GP fora do bloco continua condicionado ao cenário de startup e ABI; outras constantes são invalidadas em branches, junções e chamadas. Loads de RAM invalidam o destino — o analisador não simula o conteúdo de RAM.

### Referência coerente aos três descritores

Os descritores de 74 bytes e seus hashes permanecem os da etapa anterior. Ao aplicar **somente o cenário de cópia descrito acima**, todos caem em **`GP - 0x850`**:

| Imagem | Offset do descritor | RAM candidata | Instrução que forma a referência |
|---|---|---|---|
| 43CC | `0x204b0` | `0x00106390` | file `0x177d0`, PC `0x8ed0` |
| 43CD | `0x1e898` | `0x001062f8` | file `0x1614c`, PC `0x689c` |
| C20F | `0x127b8` | `0x00106238` | file `0xacc4`, PC `0x33cc` |

As três usam bytes **`8b970ffb`**, `nds.addigp a5,-0x850`, e armazenam esse ponteiro em `+0x10` de uma estrutura. O código vizinho compara comprimento com `0x49` (73), grava comprimento em `+0x0c` e estado 2 em `+0`. É uma ligação estática coerente de descriptor/setup, não enumeração observada. Há também writes locais ao descritor candidato em 43CD; isso desaconselha tratar o blob inicial como imutável durante execução.

### Candidatos fortes de dispatch `0x4B`, não protocolo Auri

| Imagem | Entrada candidata no arquivo | PC no cenário copiado | Verificação de Report ID |
|---|---|---|---|
| 43CC | `0x19288` | `0xa988` | `0x19290:5bd4b740`, BEQC byte 0 == `0x4b` |
| 43CD | `0x178a8` | `0x7ff8` | `0x178b0:5bd4b740`, BEQC byte 0 == `0x4b` |
| C20F | `0xbf5c` | `0x4664` | `0xbf8c:5b62b7fe`, BNEC byte 0 != `0x4b` → saída |

Nos dois primeiros, `lw a6,4(a1); lbu a5,0(a6)` antecede a comparação. C20F faz verificação de estado e obtém o buffer por `lw a5,4(a1)` antes de lê-lo. Os caminhos verificam **byte 1 == `0x01` ou `0x80`**, e depois despacham pelo **byte 2**. Isso é muito mais específico que string ou dois bytes coincidentes: formato, acessos ao buffer, estados, árvores de branches, construção de payload e chamadas convergem.

* Caminho byte 1=`01`: dispatch começa em file `43CC:0x19398`, `43CD:0x179c4`, `C20F:0xc064`. Todos têm comparações para subcomandos `01,02,03,04,05,09,0a,0d`; 43CC/43CD têm outros ramos. Esses números identificam casos, **não provam seus nomes/efeitos finais**.
* Caminho byte 1=`80`: dispatch começa em `43CC:0x19934`, `43CD:0x18000`, `C20F:0xc274`. Há casos `02,03,09,0c,0d,0e` nas três, além de outros nos maiores. No caso `03`, lê-se um halfword de estado GP-relativo, grava-se no payload em `+4` como word e define-se byte 3 como 2; há caminhos de resposta com argumento de comprimento **`0x40`**.
* Exemplo direto em C20F: file `0xc2c0..0xc2d8` escreve byte 3=2, carrega `nds.lhgp ... 0x15ece`, grava em buffer+4 e chama o destino candidato `0x48005fd4` com a2=64. Em 43CC, a rota semelhante chama PC candidato `0x9f34`. São chamadas **response-like** sob a interpretação dos argumentos, não pacotes observados no USB.
* Casos `09`/`0a` têm acessos a campos e estruturas de bandas/estado, mas trechos contêm prefixos longos ainda `<unknown>`. Não foram inferidos coeficientes, escala Q30, persistência em flash ou retorno completo só por coincidirem com nomes conhecidos do aplicativo.

`docs/ecosystem.md`, em especial WRITE/READ `01/80` e os números `03/09/0a/0c`, foi somente guia de busca. A evidência acima vem dos bytes/branches, não da projeção automática da tabela do aplicativo. Ainda falta fechar registro/encadeamento do callback USB e efeitos dos callees; ocorrências de ponteiros em dados iniciais são candidatas, não prova automática de registro.

**Confiança:** alta para existência de um parser/dispatcher estático de formato `0x4B` nesse conjunto específico, condicionada à leitura ISA e ao cenário de cópia; menor para nomes semânticos de subcomandos e transporte de resposta. Não há firmware Auri, evidência de parser `0xCB` equivalente, garantia de persistência, nem conclusão sobre toda a família CB5100. As flags INPUT Constant `03` versus OUTPUT Data `02` dos descritores continuam não provando um canal real de resposta.

### Evidência, limites e reprodução desta passagem

Além dos logs nativos baseline/XAndes, os principais artefatos são `relocations.json`, `handler-pass-audited.json`, `*.handler-candidates-audited.{json,txt}`, `*.relocated-native-map-audited.json` e `final-findings.json`. Os logs têm argv, cwd, timestamps, stdout/stderr e exit code. Os hashes de entrada antes/depois e a identidade dos nove helpers aceitos ficam nos manifestos desta execução. Não foi feita decifração secundária.

Com os helpers/imagens locais presentes, os comandos da passagem são:

```powershell
$r = '_qa/firmware/xandes-analise-20261029T030839566Z'
# One-shot em um NOVO diretório com cópias dos helpers; não sobrescrever este run.
& "$r/run-native.ps1"
# map-pass.cjs recebe o diretório native-logs-* produzido pelo runner.
& "$r/run-step.ps1" -NodeScript map-pass.cjs -ScriptArguments @('<native-logs absoluto>')
& "$r/run-relocations.ps1"
& "$r/run-step.ps1" -NodeScript xandes-selftest.cjs -Test
& "$r/run-step.ps1" -NodeScript handler-pass.cjs `
  -ScriptArguments @('<relocated-logs absoluto>', '-audited')
& "$r/run-step.ps1" -NodeScript final-findings.cjs
```

Esses comandos descrevem o encadeamento, não são um pacote distribuído. Todos os outputs são criados sem sobrescrita; repetir exige copiar os helpers desta passagem e os nove helpers-base para diretório irmão novo, mantendo o caminho relativo para o input aceito. O runner histórico `verify.ps1` copiado não participa dessa passagem.

Foram duas passagens de busca: (1) LLVM/fluxo/GP/cópia e comparações, (2) visão de texto copiado, descritores e dispatch; depois apenas auditoria focada do parser e das evidências. Os desconhecidos longos restantes e os limites de janela foram preservados como barreiras, não atravessados por mnemônicos inventados. Sem fechar os callees externos, os prefixos longos e a ligação de callback, não é honesto alegar protocolo completo.

Fontes públicas de TableGen fornecidas/verificadas pelo orquestrador, **sem acesso à rede neste job**: [RISCVInstrInfoXAndes.td](https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/lib/Target/RISCV/RISCVInstrInfoXAndes.td) e [RISCVFeatures.td](https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/lib/Target/RISCV/RISCVFeatures.td). A existência da feature e as desmontagens foram verificadas localmente; isso continua não identificando o core como D25F exato.

#### Fechamento auditado da passagem

Após a correção do parser de linhas longas, a contagem auditada de entradas `<unknown>` **ou** `unimp` caiu assim:

| Imagem | Seção completa: baseline → XAndesPerf | Texto candidato copiado: baseline → XAndesPerf | Ocorrências custom conferidas nas duas visões |
|---|---|---|---:|
| 43CC | 6538 → 4198 | 1931 → 80 | 2379 |
| 43CD | 6169 → 4227 | 1419 → 52 | 1908 |
| C20F | 4271 → 3215 | 770 → 25 | 1138 |

A seção completa contém dados; esses números **não são percentuais de código válido**. As 5425 ocorrências conferidas incluem bytes repetidos nas visões flash/copiada, não 5425 instruções únicas. Para as seis formas nativas BBC/BBS/BEQC/BNEC/LEA.W/ADDIGP, a auditoria confrontou registradores, imediatos e destinos com o decoder parcial; as demais classes continuam provenientes do LLVM, com efeitos limitados/conservadores no analisador.

`final-findings.json` registrou 14/11/7 chamadas response-like com comprimento 64 nas regiões examinadas de 43CC/43CD/C20F. Nenhuma ocorrência literal de ponteiro à **entrada correta** dos três dispatchers foi encontrada no intervalo de dados inicializados examinado. A hipótese exploratória de ponteiro a `43CD:PC 0x8000` foi descartada: esse PC era o branch interno de report ID, não a entrada `0x7ff8`. Isso reforça a ressalva sobre registro de callback ainda não fechado.

Execução final verificada em `run-final.ps1`: **11/11 testes-base**, **7/7 novos**, **34 fixtures nativas**, asserts dos campos de dispatch, comparação de ocorrências custom reais, hashes dos três plaintexts + summary antes/depois e identidade dos nove helpers aceitos, todos aprovados. Logs finais: `selftest-logs-20261029T032059492Z`, `xandes-selftest-logs-20261029T032100074Z`, `final-findings-logs-20261029T032100273Z`; exit code 0 em cada helper. Os manifests de entrada e `completion.json` são os registros finais de integridade desta passagem.

Histórico preservado: uma tentativa anterior de `final-findings.cjs` falhou **antes de carregar o script**, porque o wrapper PowerShell expandia o argumento único incorretamente (`Cannot find module ...\\D`, exit 1, log `final-findings-logs-20261029T032047470Z`). O wrapper novo foi corrigido para vetor de strings explícito, e a repetição acima passou. Essa falha não foi tratada como defeito ou resultado do firmware. Nenhum helper anterior aceito foi modificado para corrigi-la.

**Resultado atualizado, aceito após revisão técnica direta:** suporte XAndesPerf demonstrado no LLVM local, referências coerentes aos descritores e candidatos fortes de dispatch do protocolo irmão `0x4B`. Não foi fechado o transporte USB completo, o código externo de cópia, os trechos longos desconhecidos nem a semântica de todos os comandos. Não foi decifrado todo o protocolo e nenhuma capacidade Auri foi transferida desses três firmwares.

### Registro da revisão direta — 2026-10-29

Parecer do orquestrador, informado e registrado nesta atualização documental: foram lidos diretamente `xandes.cjs`, `map-pass.cjs`, `handler-pass.cjs`, `prepare-relocations.cjs`, `final-findings.cjs`, `xandes-selftest.cjs`, `relocations.json` e janelas nativas LLVM dos três firmwares, corroborando a leitura little-endian 16/32, o report ID `4B`, `01/80` em `B[1]` e o dispatch por `B[2]`. Foram lidos os logs reais de 11/11 testes-base, 7/7 XAndes e auditoria de 34 fixtures; **o orquestrador não reexecutou testes nem firmware**. Esta atualização apenas registra esse parecer, sem alegar outra revisão independente.

Não foi encontrado achado critical/major que invalide a identificação dos candidatos. A ressalva sobre os antigos contadores regionais 14/11/7 permanece: eles não demonstravam respostas. A etapa seguinte `protocol4b` separou contagem regional de alcançabilidade no CFG; a coincidência numérica não prova transferência USB.

A cópia flash→RAM foi aceita como **cenário explícito**, não observação dinâmica. CPU exata, ABI/semântica de ROM, transporte USB e capacidades Auri continuam não provados. Resultado da revisão: **aceito como análise estática parcial com limites**, sem fechar o protocolo inteiro.
