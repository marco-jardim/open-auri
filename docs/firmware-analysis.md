# WalkPlay: decriptação externa de firmware, offline

## Escopo e resultado

A camada externa AES dos downloads para **43CC, 43CD e C20F** foi decriptada
localmente. Padding PKCS7, cabeçalhos e limites das entradas não vazias foram
validados; os três containers foram extraídos. Isso **não** significa decriptação
completa do código, reconstrução integral do protocolo, identificação da CPU ou
compatibilidade com o Kuba Auri (`0x3302:0x8902`). Nenhum firmware foi executado,
enviado ao cabo ou gravado na flash. Checksums e autenticidade não foram validados.
A revisão adversarial foi concluída em 2026-10-29, sem findings críticos, major ou bloqueantes.

Contexto: [ecossistema](ecosystem.md#servidor-de-firmware-da-walkplay) e
[protocolo de EQ 0xCB](protocol-0xcb.md#confirmação-pelo-app-oficial-walkplay).
O script abaixo é uma ferramenta local de análise em Node, não uma função do
site, do navegador ou de um updater.

## Fontes e trilha reproduzível

- App oficial: <https://peq.szwalkplay.com/>.
- Espelho: <https://github.com/Ircama/walkplay>, bundle
  [`public/assets/index-BEOfvcHi.js`](https://github.com/Ircama/walkplay/blob/main/public/assets/index-BEOfvcHi.js).
  Esses endereços podem mudar; a evidência é o snapshot local, não a versão
  futura de uma branch.
- Snapshot bruto local: `_qa/walkplay/bundle.js`; cópia formatada usada para as
  referências de linha: `_qa/walkplay/bundle.pretty.js`. SHA-256 do texto UTF-8
  da **cópia formatada**:
  `9222328f8460f7277085904627fd898038322348161726ab121f5929c55047d8`.
  Esse hash não é atribuído ao arquivo bruto nem ao conteúdo futuro do espelho.
- Resolução dos nomes: `_qa/walkplay/firmware-decoder.cjs` e
  `_qa/walkplay/firmware-decoder-report.md`.
- Execução corrigida do parser:
  `_qa/firmware/decrypt-2026-10-29T02-49-07-096Z-47488/images/summary.json`,
  `images/report.md` e `audit.txt` no mesmo diretório de execução. Os artefatos
  `_qa` são evidência local não versionada; os dados necessários estão registrados
  nesta nota. Não é preciso executar o app ou obter acesso a esses relatórios
  para usar o snippet com uma cópia local do download.

### Resolver a ofuscação sem executar o app

Primeiro ler o bundle como texto, formatá-lo e registrar seu hash. Extrair apenas
as funções de decoder, suas tabelas e as IIFEs de rotação explicitamente
enumeradas. **A rotação é necessária**: indexar a tabela original sem ela produz
nomes errados. O helper avalia apenas esses trechos e expressões reduzidas numa
VM sem `require`, `fetch`, `navigator` ou `process`, sem geração de código por
strings/Wasm e com timeout de 1000 ms por avaliação. Isso reduz a superfície do
snapshot conhecido; `node:vm` não é uma fronteira segura para JavaScript hostil
arbitrário. Não avaliar o bundle inteiro.

Referências inclusivas em `bundle.pretty.js`:

| Grupo | Decoders/tabelas | Rotação |
| --- | --- | --- |
| UI (`ape`/`xpe`) | 93213–93240, 93287–93407 | 93242–93267 |
| Loader (`yue`/`wue`) | 85920–85984 | 85859–85884 |
| Hash (`T9`/`D9`) | 69678–69735 | 69624–69649 |
| AES (`K9`/`W9`) | 69952–69979, 70032–70060 | 70006–70031 |
| Host (`P9`/`N9`/`H9`) | 69760–69831 | 69736–69758 |
| Rota (`V9`/`R9`) | 69847–69898 | 69980–70005 |
| Método base | 86187–86270 | 86271–86296 |
| Upgrade CB | 86840–86870, 87296–87412 | 86871–86896 |
| API temporária | 94441–94503 | 94504–94529 |

Conferir strings conhecidas (`value`, `code`, `MD5`, `Utf8`, `ECB`, `Latin1`,
`loadBinFile`, host e rota) antes de interpretar as chamadas. Não executar UI,
CryptoJS, transporte, updater, parser do app ou firmware para resolver nomes.

## Duas camadas diferentes: JSON XOR e binário AES

**Respostas JSON da API:** Base64 decode da resposta, XOR byte a byte com a
chave repetida, UTF-8 decode e `JSON.parse`. A chave é o texto ASCII literal de
24 caracteres `d2Fsa3BsYXlAMjAyNS4uLw==`; **não** decodificar essa chave de
Base64. O interceptor está no snapshot bruto em offsets de bytes UTF-8
1328050–1329299. Esse XOR de metadados não é a cifra do arquivo `.bin`.

**Downloads binários:** a UI `DeviceUpgradAudiocular`, linhas 93543–93574,
usa `m.value.code` tanto para baixar quanto para derivar a chave:

```text
digest  = MD5(code em UTF-8).hex       # 32 caracteres hex minúsculos
keyText = digest.slice(0, 16)         # primeiros 16 caracteres
key     = UTF8(keyText)               # 16 bytes, não hex decode
plain   = AES-128-ECB-decrypt(download, key), com PKCS7, sem IV
```

Por exemplo, a chave 43CC é o texto `3a49c46eeee6f6bd`, não os oito bytes
obtidos ao decodificar esses caracteres como hex, nem os 16 bytes do digest MD5
binário inteiro. No app, `M9.MD5(...)` é uma chamada ao método MD5; a saída
CryptoJS é convertida de Latin1 para bytes, sem conversão textual do firmware.

O SDK tem uma implementação equivalente em `bue` (85985–86040), chamada por
`loadBinFile` (86335–86336). Ela compara MD5 do argumento com o literal `hue =
"46104068e87430d840cd51f71b57c132"`: se iguais, retorna os bytes sem AES. Fora
desse bypass exige argumento de 32 caracteres e usa a mesma derivação. Nenhum
dos três codes abaixo corresponde ao bypass. UI e SDK são caminhos alternativos,
**não duas rodadas sequenciais de AES** sobre o mesmo download. O fluxo temporário
`UpgradeTemp` recebe `hashKey` da API (94623–94817); não foi demonstrado que esse
campo seja igual ao código de consulta temporário ou aos codes desta nota.

### URLs observadas e arquivos efetivamente analisados

Os arquivos locais vieram das URLs `code.bin` abaixo; seus bytes foram
decriptados localmente. Separadamente, a função `U9` (69903–69951) constrói
`https://walkplay-api.szwalkplay.com/api/common/download/${code}-last.bin` e
retorna `Uint8Array` sem decriptação interna. Esse sufixo `-last.bin` foi
**apenas observado estaticamente**; não se afirma que essas URLs foram baixadas
ou que retornem os mesmos bytes de `code.bin`.

| PID / nome local em `_qa/firmware/` | Code e URL de origem |
| --- | --- |
| 43CC / `CB5100_PID43CC_V1.4_251219.bin` | `202602021611340fb8190cd6499b42f9` — <https://walkplay-api.szwalkplay.com/api/common/download/202602021611340fb8190cd6499b42f9.bin> |
| 43CD / `CB5100_PID43CD_V0.4_260228.bin` | `20260228154932c11768a31e9000f5f9` — <https://walkplay-api.szwalkplay.com/api/common/download/20260228154932c11768a31e9000f5f9.bin> |
| C20F / `CB1200_C20F_V0.2_260709.bin` | `202607091523497e0b255de074326bb6` — <https://walkplay-api.szwalkplay.com/api/common/download/202607091523497e0b255de074326bb6.bin> |

## Container após remover apenas o AES externo

O parser `ioe` (77661–77717) interpreta um cabeçalho de **32 B**, seguido de
`binCount` entradas de **16 B**. Inteiros são u32 little-endian; offsets abaixo
são zero-based. Nomes de campos são os usados na análise, não uma especificação
completa do fabricante.

| Offset | Campo |
| --- | --- |
| 0 | Palavra inicial, preservada sem interpretar |
| 4 | Magic `SPV@`, u32 LE `0x40565053` |
| 8 | `EncryptAddr` |
| 12 | Flag: `(flag & 0xffffff00) >>> 0` deve ser `0x4f414d00` |
| 16 | `EncryptSize` |
| 20 / 24 | Endereços de data / hora do build |
| 28 | `binCount` |

Cada entrada contém nome de quatro bytes (`CPU\0`, `MOD\0`, `PBK\0`,
`EXT\0`), endereço, tamanho e checksum, nessa ordem (offsets relativos 0, 4, 8 e 12).
O offset no arquivo é
`addr & 0x00ffffff`. Para **size > 0**, exigir `offset + size <= plain.length`.
Para **size = 0**, o endereço é apenas metadado e pode estar além do EOF:
`ioe` não copia nem acessa essa região. Rejeitar esses ponteiros vazios foi um
erro do primeiro parser, não prova de firmware inválido ou chave errada.
O cabeçalho e a tabela precisam caber integralmente no plaintext em todos os casos.

`EncryptAddr`/`EncryptSize` indicam uma região interna potencialmente protegida,
ainda em estudo. Não basta o nome para determinar cifra, compactação ou
tratamento pelo bootloader. Não aplicar `coe`, corrigir flags, recalcular
checksums ou preparar pacotes de atualização neste processo de análise.

## Reprodução local com Node

Salve o bloco como **`decrypt-walkplay.cjs`** fora do navegador. Requer Node com
`node:crypto`; não tem dependências, rede ou transporte. Recebe exatamente três
argumentos: code, arquivo de entrada e arquivo novo de saída. O diretório de
saída deve existir. Trabalhe com arquivos locais confiáveis, sem outros processos
trocando diretórios durante a execução. A entrada só é aberta para leitura; a
saída usa `wx` (criação exclusiva), nunca overwrite. Caminhos são canonicalizados
para recusar entrada e saída iguais, inclusive aliases por symlink e diferenças
de caixa no Windows. Uma saída já existente é sempre recusada.

```cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createDecipheriv } = require('node:crypto');

function check(ok, message) {
  if (!ok) throw new Error(message);
}
function main() {
  const args = process.argv.slice(2);
  check(args.length === 3, 'Usage: node decrypt-walkplay.cjs code input output');
  const [code, inputArg, outputArg] = args;
  check(/^[0-9a-fA-F]{32}$/.test(code), 'Code must contain exactly 32 hex characters');
  const input = fs.realpathSync(inputArg);
  const requestedOutput = path.resolve(outputArg);
  const output = path.join(
    fs.realpathSync(path.dirname(requestedOutput)),
    path.basename(requestedOutput),
  );
  const compare = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  let existingOutput;
  try {
    existingOutput = fs.realpathSync(output);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  check(compare(existingOutput ?? output) !== compare(input), 'Output equals input');
  check(existingOutput === undefined, 'Output already exists; refusing overwrite');
  const raw = fs.readFileSync(input);
  check(raw.length >= 16 && raw.length % 16 === 0, 'Input must be >=16 B and a multiple of 16');
  const md5 = createHash('md5').update(code, 'utf8').digest('hex');
  const key = Buffer.from(md5.slice(0, 16), 'utf8');
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true); // Native crypto validates and removes PKCS7.
  const plain = Buffer.concat([decipher.update(raw), decipher.final()]);
  check(plain.length >= 32, 'Truncated container header');
  const u32 = (offset) => plain.readUInt32LE(offset);
  check(u32(4) === 0x40565053, 'Expected SPV@ at offset 4');
  const flag = u32(12);
  check(((flag & 0xffffff00) >>> 0) === 0x4f414d00, 'Unexpected flag family');
  const binCount = u32(28);
  check(binCount > 0 && binCount <= Math.floor((plain.length - 32) / 16), 'Invalid entry table bounds');
  const entries = [];
  for (let i = 0; i < binCount; i++) {
    const at = 32 + 16 * i;
    const addr = u32(at + 4);
    const size = u32(at + 8);
    const offset = addr & 0x00ffffff;
    // Empty entries are metadata: no slicing or dereferencing their addresses.
    if (size > 0) check(offset + size <= plain.length, `Entry ${i} outside plaintext`);
    entries.push({ nameHex: plain.subarray(at, at + 4).toString('hex'), addr, size });
  }
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(output, plain, { flag: 'wx' });
  console.log(JSON.stringify({
    inputBytes: raw.length, inputSha256: sha256(raw),
    plaintextBytes: plain.length, plaintextSha256: sha256(plain),
    paddingBytes: raw.length - plain.length, flag, binCount, entries,
  }, null, 2));
}
try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
```

Exemplo no PowerShell, com os **três argumentos** posicionais, sem download:

```powershell
node .\decrypt-walkplay.cjs '202602021611340fb8190cd6499b42f9' '.\CB5100_PID43CC_V1.4_251219.bin' '.\43CC-plaintext-new.bin'
```

Compare os tamanhos e hashes impressos com os valores abaixo. O script preserva
integralmente o plaintext, inclusive flags e checksums, e não executa bytes do
firmware. Padding e estrutura coerentes não provam autenticidade: AES-ECB não
autentica o arquivo. Um roundtrip de reencriptação só demonstra consistência da
mesma fórmula, não assinatura, checksum ou segurança para flash.

## Vetores observados

| PID | MD5(code) | Chave textual UTF-8 de 16 B | Padding | Raw → plaintext (B) |
| --- | --- | --- | --- | --- |
| 43CC | `3a49c46eeee6f6bd98c4049ae249e4e1` | `3a49c46eeee6f6bd` | 9 | 233552 → 233543 |
| 43CD | `74ecf1749fc03832ea972976e11e6d2b` | `74ecf1749fc03832` | 4 | 125312 → 125308 |
| C20F | `9ae7c6766aeaf503e102ce33d1890cbc` | `9ae7c6766aeaf503` | 13 | 75856 → 75843 |

SHA-256 dos bytes, não dos textos de relatório:

| PID | Raw | Plaintext |
| --- | --- | --- |
| 43CC | `8a835fd109f3187660e42079ffd63167f1b602d8079a2ecf4ac10e82bb7c5a45` | `37d97e0929b0fc885004e7d518bd85a97da91b794ff3db9a283c8b5fb9297a1e` |
| 43CD | `ecea93ce7058c56bb126a445d7f6e7d12204cc53e5ba7b4f320889d28d8d3b58` | `847e173bd403bbfa780854a7ef2d9b6ea0999704546afa866f5657622292ff8c` |
| C20F | `76d8e7c3edcb886800bad6e6ea84bfc28dc1a70519a3582073ca3f382530b254` | `96635555d7f5cac87a6b0e33922103c7214df0acb277227af36005902ca314e5` |

Todos têm magic `SPV@` no offset 4, `binCount = 4`, tabela em `[32,96)` e
`EncryptAddr = 0x48001000`. Regiões abaixo usam offsets mascarados, fim exclusivo:

| PID | Flag preservada | Build textual | CPU / MOD / PBK / EXT (B) | Região Encrypt (offset / B) |
| --- | --- | --- | --- | --- |
| 43CC | `0x4f414d40` | `Dec 19 2025 11:26:48` | 132500 / 0 / 0 / 71 | `[0x1000,0xc000)` / 45056 |
| 43CD | `0x4f414d40` | `Feb 28 2026 14:50:41` | 125308 / 0 / 0 / 0 | `[0x1000,0xd000)` / 49152 |
| C20F | `0x4f414d41` | `Jul  9 2026 15:17:08` | 75843 / 0 / 0 / 0 | `[0x1000,0x7000)` / 24576 |

No 43CC, CPU começa em 0; MOD/PBK vazios e EXT apontam para `0x39000`, e EXT
termina no EOF. No 43CD, os três ponteiros vazios são `0x37000`; no C20F são
`0x40000`, ambos além do EOF, sem acesso a esses endereços. A string
`SPV4040 HIFI AUDIO` em EXT do 43CC é somente uma pista textual, **não prova da
CPU**. Os nomes CPU/MOD/PBK/EXT também não demonstram arquitetura ou compatibilidade.

A execução corrigida registrou 16 testes de parser aprovados, helper e análise
com exit 0, entradas sem alteração e hashes dos artefatos conferidos. Isso não
substitui revisão independente nem valida o conteúdo interno. Permanecem em
estudo a região interna potencialmente protegida, a semântica dos checksums,
arquitetura, bootloader e relação com o protocolo Auri. Nada aqui autoriza flash
cruzado, implementação de transporte ou uso dos reports 0x4B no Auri 0xCB.
