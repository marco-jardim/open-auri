# Mapa estático parcial do protocolo irmão `0x4B`

**Estado: revisão técnica direta concluída em 2026-10-29; resultado aceito como análise estática parcial com limites. Não é protocolo completo nem protocolo Auri.** Foram examinados somente os plaintexts 43CC, 43CD e C20F já aceitos. Não houve rede, instalação, hardware, USB/HID, emulação ou execução de firmware/ELF/bundle. Nenhum frame abaixo foi enviado a dispositivo.

Esta nota aprofunda a [análise RV32/XAndesPerf](firmware-rv32-analysis.md), sem substituir suas conclusões históricas. `docs/ecosystem.md` foi guia para nomes de comandos do aplicativo; nomes como `FLASH_EQ`, `GLOBAL_GAIN`, `PEQ_VALUES`, `TEMP_WRITE` e `VERSION` **não são prova dos efeitos finais do firmware**.

## Evidência local e duas bases de endereço

Run: `_qa/firmware/protocol4b-20261029T034025179Z/`, ignorado pelo Git. Helpers e binários não são distribuídos por esta nota; um clone sem esses artefatos locais não reproduz a análise apenas com a documentação. Inputs: `decrypt-2026-10-29T02-49-07-096Z-47488/images/{43CC,43CD,C20F}/plaintext.bin` e `summary.json`, sob `_qa/firmware/`.

Os cenários de cópia continuam condicionais: a rotina externa `0x80318` não está disponível. PC residente é `0x48000000 + fileOffset`; PC do texto candidato copiado é `fileOffset − origemTexto`, **não uma base única**.

| Imagem | Texto: arquivo → PC | Origem de dados → RAM candidata | GP | Entrada do dispatcher: arquivo / PC |
|---|---|---|---|---|
| 43CC | `[e900,1a10a)` → `[0,b80a)` | `1a120` → `100000`, tamanho `6478` | `106be0` | `19288 / a988` |
| 43CD | `[f8b0,18586)` → `[0,8cd6)` | `185a0` → `100000`, tamanho `63e0` | `106b48` | `178a8 / 7ff8` |
| C20F | `[78f8,c56a)` → `[0,4c72)` | `c580` → `100000`, tamanho `62c8` | `106a88` | `bf5c / 4664` |

Todos os números de endereço nas tabelas são hexadecimais. Os tamanhos candidatos de dados 43CD/C20F excedem o plaintext em 4/5 bytes: **nenhum byte foi lido além do arquivo, inventado ou recuperado de padding**. Os três descritores de 74 bytes continuam integralmente disponíveis e mapeiam condicionalmente a GP−`850`; IDs `03/4b/54` em 43CC/C20F e `03/4b/01` em 43CD. INPUT Constant `03` versus OUTPUT Data `02` continua não demonstrando um canal de respostas observado.

## Prefixo e domínio dos campos

Seja `B` o ponteiro carregado de `contexto+4`, não uma estrutura inventada de pacote completo:

| Local | Observação literal | Confiança/limite |
|---|---|---|
| `B[0]` | Byte comparado com `4b`; divergência retorna/sai. | Alta, três imagens. Não é `cb`. |
| `B[1]` | `01` segue árvore de escrita; `80` segue árvore de leitura; outros valores saem. | Alta; rótulos read/write descrevem direção dos acessos, não tráfego observado. |
| `B[2]` | Byte seleciona subcomando, com casos `00` e, na escrita, `ff` antes das árvores esparsas. | Todos os 256 valores classificados em cada direção/imagem pelo driver estático. |
| `B[3]` | Usado em limites de cópia no caso `00`; alguns retornos escrevem o valor 2. | **Não** há base para impor comprimento/nonce universal a todos os comandos. |
| `B+4` | Acessos diferentes por comando: byte, halfword signed/unsigned ou word LE. | Não presumir um tipo único. |
| `B+8` | Início de blocos em operações de cópia/coeficientes. | Não prova sozinho geometria de bandas ou escala Q. |

Há ainda uma palavra de estado `contexto+0`, testada contra 2; a saída comum escreve 1. Não se demonstrou que isso valide comprimento de frame. Não foi encontrada validação genérica de tamanho 64 no header do dispatcher; ela pode existir em outra camada. Alguns casos `00` verificam byte 3 >7 e calculam iterações com `(B[3]−4)/4` por sequência signed; não se deve substituir isso por uma API segura de leitura/escrita arbitrária.

## Enumeração de todos os ramos

As tabelas dão **início do corpo em offset de arquivo**, não endereço final de função. `—` significa que o valor segue default nessa árvore, não ausência do comando em toda a família. JSON local contém os 256 resultados por direção, seus guardas, bytes e listas completas de default.

### Escrita: `B[1]=01`

| Cmd | C20F | 43CC | 43CD | Efeito/campo comprovado ou limite |
|---|---|---|---|---|
| `00` | `c00e` | `19346` | `17972` | Word em `B+4`, payload em `B+8`, loop de words condicionado a byte 3; sem nome semântico final. |
| `01` | `c0a4` | `19420` | `17a5c` | Grava flag halfword 2 em configuração e chama rotina de alteração/commit candidata. Persistência bloqueada em ROM. |
| `02` | `c0bc` | `19438` | `17a74` | Em C20F `lh B+4` (signed), caminhos conforme sinal, constantes `±c0`, cálculo e stores em configuração; unidade não demonstrada. |
| `03` | `c124` | `194a0` | `17aec` | Em C20F `lhu B+4`, soma `80`, máscara `−100`, store halfword em configuração+`a`, duas chamadas de processamento. Nome GLOBAL_GAIN vem do app. |
| `04` | `c174` | `19504` | `17b64` | Mesma preparação de flag/chamada principal de `01` em C20F; não prova mesma intenção de usuário. |
| `05` | `c18c` | `1951c` | `17b7c` | Byte `B[4]` seleciona ramos `1/4/2` e outros; atualiza flags/halfwords e chama processamento. |
| `09` | `c1bc` | `195c4` | `17c18` | Word `B+4`, low byte limitado a `0..1` em C20F; `B+8`, constantes `a0`/`14`, extrações BFOZ; barreira longa impede fechar todos os campos/coeficientes. |
| `0a` | `c24c` | `196b4` | `17d10` | Em C20F low byte do word `B+4` ≤1, BFOZ com operandos `2,9`, shift direito 16, store em configuração+`10` e chamada PC `1518`. Não prova TEMP_WRITE só na RAM. |
| `0d` | `c092` | `196dc` | `17d38` | Em C20F argumentos: word `B+4`, constante `28`, ponteiro `B+8`, chamada PC `1804`; efeito do callee não fechado. |
| `11` | — | `196f0` | `17d4c` | Corpo com acessos ao payload/estado, calls registrados no mapa local; significado não atribuído. |
| `12` | — | — | `17d78` | GP/configuração; sem equivalência inferida entre produtos. |
| `16` | — | `1971c` | `17d98` | Atualizações de estado e processamento; efeito persistente não provado. |
| `17` | — | `197a0` | `17e20` | Vários resets de campos/flags; não denominar factory reset sem fechar callees. |
| `18` | — | `19804` | — | Byte de payload e flags GP-relativas. |
| `19` | — | `19814` | `17f6c` | Estado/flags, caminhos distintos por produto. |
| `1a` | — | `19850` | — | Limites de estado e cópia candidata; opaco longo. |
| `1d` | — | `198f8` | `17a30` | Campos/flags distintos; não unificar sem prova. |
| `1e` | — | `193fe` | — | Byte `B[4]` seleciona estado e chamada; nome não atribuído. |
| `ff` | `c050` | `19388` | `179b4` | Prepara a0=`a`, chama rotina e outra chamada; não afirmar reset/persistência sem os callees. |
| default | `bf70` | `192b0` | `178d8` | Estado 1 e retorno 0; inclui respectivamente 246/238/240 valores. |

Os valores default incluem `06/07/08`, rejeitados por guarda de faixa nas três árvores. As enumerações não executam os corpos: classificam apenas guardas estáticos com domínio byte e param em memória/call/semântica opaca.

### Leitura: `B[1]=80`

| Cmd | C20F | 43CC | 43CD | Efeito/campo comprovado ou limite |
|---|---|---|---|---|
| `00` | `bfa8` | `192e0` | `1790c` | Copia words para `B+8` a partir de endereço derivado do word `B+4`, com condição de byte 3; prepara chamada de 64. |
| `02` | `c2a4` | `19984` | `1804c` | Tipo byte 3=2; signed halfword de configuração convertido e armazenado como **word** em `B+4`. |
| `03` | `c2c0` | `199a0` | `18068` | Igual formato de retorno de `02`, outro deslocamento GP; detalhe abaixo. |
| `09` | `c2e0` | `199bc` | `18084` | Limites/índices, acesso a blocos e preparação de 64; parte do caminho opaca. Q30 não demonstrado. |
| `0c` | `c398` | `19a8c` | `18128` | C20F lê comprimento em endereço flash `48007498`, aceita `1..9` e copia bytes seguintes para `B+4`; prepara 64. VERSION é rótulo externo do app. |
| `0d` | `c3e0` | `19ad0` | `1816c` | C20F chama PC `18a0` com word `B+4`, constante `28`, `B+8`; depois prepara 64. |
| `0e` | `c28c` | `19af0` | `1818c` | Word de estado GP-relativo para `B+4`, prepara 64; byte 3 não é reescrito nesse trecho de C20F. |
| `11` | — | `19b08` | `181a4` | Caso explícito; loads/stores e calls preservados no mapa local, sem nome semântico. |
| `16` | — | `19b24` | `181c0` | Caso explícito de leitura de estado/configuração. |
| `18` | — | `19b68` | — | Caso explícito, sem generalização para CD/C20F. |
| `19` | — | `19b84` | `18204` | Caso explícito, tipo/unidade dependem do corpo. |
| `1a` | — | `19bb8` | — | Caso explícito, corpo parcial. |
| `1d` | — | `19b9c` | `1802c` | Caso explícito, diferenças entre produtos preservadas. |
| `1e` | — | `1996c` | — | Word de estado para payload; prepara 64. |
| default | `bf70` | `192b0` | `178d8` | 249/242/245 valores, incluindo `01` e `ff`; não confundidos com árvore de escrita. |

Para casos esparsos sem interpretação fechada, o mapa local registra todos os loads/stores literalmente (largura, registrador-base e deslocamento), bytes, calls, saídas e barreiras. Nem todo load/store do corpo é acesso a `B`: há configuração, pilha e MMIO. Não foi inventado layout de resposta para essas linhas.

## Exemplo auditável: leitura `03` do C20F

```text
file c2c0 / PC 49c8: 0947       li a4,2
file c2c2 / PC 49ca: a381e700   sb a4,3(a5)
file c2c6 / PC 49ce: 2b17fb6c   nds.lhgp a4,0x15ece
file c2ca / PC 49d2: d8c3       sw a4,4(a5)
file c2cc / PC 49d4: 13060004   li a2,64
file c2d0 / PC 49d8: 83a54500   lw a1,4(a1)
file c2d4 / PC 49dc: 97100048   auipc ra,0x48001
file c2d8 / PC 49e0: e780805f   jalr 0x5f8(ra) → 0x48005fd4
```

`LH` é signed: um halfword `00 ff` vira `−256`, e o `SW` escreve `00 ff ff ff`. Byte 3=2 **não** prova que só dois bytes sejam retornados: esse caller prepara comprimento 64. Não houve observação de padding efetivo ou transferência USB.

## Chamadas de resposta: contagem corrigida e efeitos reais

O relatório anterior contava qualquer call com a2=64 entre a entrada e o fim do texto copiado. Isso era uma **contagem regional**, não prova de alcançabilidade nem de resposta. O driver novo mantém conjuntos separados e contém teste com call64 morta que é excluída do CFG.

Nesta execução os valores coincidem numericamente, mas por análises diferentes:

| Imagem | Calls regionais a2=64 | Calls a2=64 alcançáveis no CFG da entrada | Instruções alcançáveis |
|---|---:|---:|---:|
| C20F | 7 | 7 | 298 |
| 43CC | 14 | 14 | 561 |
| 43CD | 11 | 11 | 599 |

São **call sites de preparação no caller**, não 7/14/11 respostas USB comprovadas. Calls são supostos retornáveis, branches de runtime têm ambos os caminhos, constantes são invalidadas em calls/junções e GP é condicionado à ABI/startup. Não houve cap atingido nos CFGs principais; desconhecidos interrompem caminhos e podem ocultar outros sites.

Destino C20F `resident file 5fd4 / PC 48005fd4`: grava a2 em `obj+4`, a1 em `obj+0`, coloca a1=0 e chama PC copiado `2cd8` (file `a5d0`). Este marca `obj+4` com `−1`, usa `obj+8` como seletor byte e passa ponteiro/tamanho aos helpers. Os equivalentes de 43CC são `9f34→853c`; de 43CD, `761c→5f98`.

Isso conecta caller a uma estrutura e a rotinas de transporte candidatas, mas não fecha sozinho USB endpoint, interrupção de conclusão, tamanho realmente transmitido ou formato de cada resposta. O artefato `expanded-callees.json` preserva um nível adicional de helpers e endereços MMIO candidatos, sem nomes de registradores físicos inventados.

## Escrita `01/04`: persistência continua condicionada à ROM

No C20F, o corpo `01` grava halfword 2 em configuração+`c` e chama PC copiado `1700` (file `8ff8`). `04` prepara o mesmo par. A rotina faz read/modify/write de `20090000`, aguarda bit 5 de `20090008`, escreve `13` em `20002020`, modifica `20002000`, e depois chama código externo.

Primeiro alvo resolvido no próprio bloco: **`0x82356`**, com a0=0. A sequência mantém s0 inicialmente formado como `82000`; se a ABI externa preservar s0, as preparações posteriores correspondem a **`8213c`**, **`82200`**, **`8236e`**, com endereço `20000` e comprimento `f0` no C20F. Isso é uma hipótese ABI explicitada, não propagação automática de constantes através de calls. O driver conservador deixa esses alvos posteriores como indiretos não resolvidos.

Nos maiores, os callees principais são `43CC:63f8` e `43CD:40e4`, com primeiro alvo externo `82356` e argumentos de endereço `38000` e comprimentos `bb8`/`ad4` em preparações posteriores. O código parece uma operação de memória não volátil/configuração, mas **persistência não está demonstrada** sem semântica dessas rotinas externas. Não se rotulou cmd `01` como flash-save apenas porque o aplicativo o chama FLASH_EQ. Flags e scheduler observados não substituem essa prova.

## Ligação de entrada e limites de CFG/ISA

Foi encontrado um **caller direto** da entrada em cada imagem: C20F PC `318`, 43CC PC `1548`, 43CD PC `11c0`. Isso é nova evidência de ligação, não registro final de callback USB. Ausência de ponteiro literal na faixa inicializada não prova inexistência de callback; não foram inventados ponteiros com bit 0 marcado.

Há barreiras longas reais no LLVM, por exemplo C20F PC `48e6` (`7f17c5c40b165b6c32971385`) e `4a20` (`7f97b6c48b165b6c3307d700`). Não se mascarou `17ff/177f` para reinterpretá-lo como C.ADDI. O driver procura alvos diretos confirmados **estritamente dentro** de linhas opacas e gera plano de ressincronização a partir deles. Nesta passagem o plano é vazio: não apareceu alvo elegível nos grafos examinados, portanto nenhuma janela foi fabricada. O teste sintético cobre essa classificação e a incorporação de um alvo ressincronizado.

Complemento documental verificado pelo orquestrador em 2026-10-29, sem nova consulta à rede nesta atualização: [`RISCVDisassembler.cpp`, linhas 753–760](https://raw.githubusercontent.com/llvm/llvm-project/main/llvm/lib/Target/RISCV/Disassembler/RISCVDisassembler.cpp) calcula `nnn = (Bytes[1] >> 4) & 7`, atribui `Size = 10 + 2 * nnn` e retorna `Fail` nesse ramo. Para os bytes **`FF 17`**, `nnn = 1`, logo o avanço é **12 bytes**. Isso explica o salto longo do desassemblador, **não prova uma instrução Andes real de 96 bits nem criptografia**. O exemplo não extrapola a conta para outros prefixos e não autoriza mascarar bits ou reinterpretar como instrução comprimida de 16 bits.

O mapa da árvore de seleção está enumerado; **os efeitos de todos os corpos não estão completos**. Em especial: índices/contagens em trechos opacos, escala Q dos coeficientes, unidades de ganho, efeito persistente, callbacks e transporte concluído permanecem limitados. Comparações com app não substituem constantes/fórmulas reais. Ausência literal de `EQ1#` não prova ausência de implementação `0xCB` em toda família.

## Execução e reprodução local

Node local e LLVM 23.1.4 existentes, via fallback PowerShell autorizado após a recusa de allowlist informada anteriormente. Nenhuma ferramenta instalada. `run4b.ps1` executou as suítes existentes **11/11** e **7/7**, mais **7/7 testes novos**, e seis desmontagens LLVM em foreground. Os novos testes cobrem árvores/defaults/00/ff, duas bases, signedness, retorno/cap, call64 morta, clobbers e alvo dentro de opaque.

Artefatos principais: `preflight.json`, `inputs-before.json`, `inputs-after.json`, `layouts.json`, `command-map.round{1,2}.json`, `*.handler.round*.{json,txt}`, janelas por corpo/callee com bytes, `MAPA.md`, `expanded-callees.json`, `completion.json`, e logs com argv/cwd/timestamps/stdout/stderr/exit code. O manifesto recursivo verifica todos os artefatos aceitos anteriores, não só os helpers copiados.

Com os arquivos locais disponíveis, em **novo diretório irmão** (outputs sem sobrescrita), o encadeamento é:

```powershell
& "$r/run4b.ps1"
& "$r/run-step.ps1" -NodeScript analyze4b.cjs -ScriptArguments @('1')
& "$r/resync4b.ps1"
& "$r/run-step.ps1" -NodeScript analyze4b.cjs -ScriptArguments @('2')
& "$r/run-step.ps1" -NodeScript close4b.cjs
```

Não executar os ELF. A segunda passagem preserva os limites e compara o CFG à primeira; sem novas arestas elegíveis, a busca para e registra bloqueios, em vez de repetir scans indefinidamente. Não foram rodados build/web/tests do aplicativo porque não houve alteração de app.

**Conclusão desta etapa:** árvores `0x4B` enumeradas e corpos/callees aprofundados com bytes, larguras e limites; não todo o protocolo decifrado. Esses firmwares parentes não demonstram capacidades do Auri nem decifram seu protocolo `0xCB`.

## Registro da revisão direta — 2026-10-29

Parecer do orquestrador, informado e registrado nesta atualização documental: foram lidos diretamente esta nota, `analyze4b.cjs`, `core4b.cjs`, `protocol-selftest.cjs`, as faixas de `completion.json`, `C20F.callee.0x1700.round2.txt`, `C20F.entry-caller.0x2fc.txt`, o stdout final de `close4b` e os resultados dos sete testes novos. **Não houve reexecução de testes ou firmware pelo orquestrador**; esta atualização registra a revisão recebida, não uma nova revisão independente.

A revisão confirmou que os 256 domínios por direção são classificações da árvore, **não corpos executados nem 256 comandos válidos**. O CFG distingue a call morta da contagem regional, com teste específico, e mantém clobbers, caps e desconhecidos como limites. O caller C20F `PC 318 → 4664` está presente; o registro de callback USB ainda não foi provado.

Persistência continua bloqueada no primeiro call de ROM `82356`; os possíveis alvos posteriores dependem da preservação de s0, sem fechar flash-save. Não há persistência observada, firmware Auri, escala Q ou unidade de ganho provada. Não foi encontrado achado major bloqueante para este **registro parcial**. Resultado: **revisão técnica direta concluída; análise estática parcial com limites aceita**, sem declaração de protocolo Auri completo.
