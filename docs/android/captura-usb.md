# Captura USB de referência no Windows (F5)

## Quando usar

Execute este runbook quando houver um cabo Auri CB5100 real disponível para
a F5. A referência é uma gravação pelo **site no Chrome desktop no Windows**,
não pelo app Android nem por um script de escrita. A captura permite
confirmar rota USB, prefixo, padding e bytes das 12 curvas antes de comparar
o app com o desktop.

O procedimento complementa
[`D:\git\open-auri\docs\android.md`](../android.md) e as tarefas T5.1/T5.2 e
Anexos D/E do
[`D:\git\open-auri\docs\plans\2026-10-18-android-capacitor-plano.md`](../plans/2026-10-18-android-capacitor-plano.md).
Capturar no desktop não encerra sozinho o aviso de hardware não validado:
depois ainda são necessários comparação do app e testes em pelo menos dois
celulares de fabricantes diferentes.

## Pré-condições e segurança

- PC Windows com Chrome atualizado e cabo CB5100, VID **`0x3302`**,
  PID **`0x8902`**. Use um único cabo por captura e feche outras ferramentas
  que possam gravar nele.
- Repositório e dependências prontos em `D:\git\open-auri`; Node.js 22.12
  ou superior. O fixture de referência é
  [`D:\git\open-auri\test\fixtures\eq0xcb.reference.json`](../../test/fixtures/eq0xcb.reference.json).
- Reserve uma pasta local para os artefatos gerados. Os nomes fornecidos
  às variáveis abaixo são arquivos novos da sessão de captura, não arquivos
  que já deveriam existir no repositório.
- Cada gravação substitui a curva anterior, que não pode ser lida de volta.
  Preserve a configuração que pretende restaurar. Baixe o volume e deixe
  o fone fora da orelha; não faça varreduras de comandos nem altere CRC,
  timing ou limites para produzir a referência.
- Mantenha uma aba de <https://open-auri.com/cabo> disponível para gravar o
  **Neutro** pelo fluxo normal se algo ficar estranho.
- USBPcap pode registrar outros dispositivos do mesmo controlador. Remova
  periféricos desnecessários, não digite segredos durante a captura e não
  publique o arquivo bruto sem revisão de dados pessoais/identificadores.

## 1. Instalar USBPcap e Wireshark

1. Baixe o Wireshark pelo site oficial <https://www.wireshark.org/> e
   instale o componente USBPcap oferecido pelo instalador. Se ele não vier
   incluído, obtenha USBPcap em <https://desowin.org/usbpcap/>. Use fontes
   oficiais, não pacotes de driver de terceiros.
2. Reinicie o Windows se a instalação do driver pedir. Confirme que o
   Wireshark lista interfaces USBPcap e que o executável `tshark` instalado
   com o Wireshark pode ser chamado no terminal. Ajuste o PATH local, se
   necessário. Npcap sozinho não captura USB.
3. Abra o Wireshark com os privilégios necessários para acessar USBPcap.
   Escolha o controlador/root hub ao qual o cabo será ligado; não selecione
   uma interface Ethernet/Wi-Fi. Se não souber qual é, observe a árvore de
   dispositivos do USBPcap ao conectar o cabo.
4. Inicie a captura **antes** de conectar/reconectar o cabo, para incluir
   enumeração, configuração e descritores. Não troque o driver HID/áudio do
   cabo por WinUSB: isso mudaria o caminho cuja referência queremos medir.

## 2. Identificar e filtrar o cabo

No Wireshark, localize o descritor do dispositivo com o filtro de exibição:

```text
usb.idVendor == 0x3302 && usb.idProduct == 0x8902
```

Esse filtro identifica o cabo na enumeração, mas **não basta para exportar
as gravações**: os URBs de dados normalmente não repetem VID/PID. Anote
`usb.bus_id` e `usb.device_address` do dispositivo encontrado. Depois use
esses valores para acompanhar todo o tráfego do cabo:

```text
usb.bus_id == <barramento observado> && usb.device_address == <endereço observado>
```

Os marcadores entre `< >` são valores da sua captura. Não copie o filtro
com os marcadores literais. Se reconectar e mudar o endereço, reinicie a
captura de referência ou registre todos os endereços e a separação das
sessões. Não misture gravações de dispositivos diferentes.

Preserve descritores e ambas as fases dos URBs no arquivo bruto. Para
inspeção, procure a interface HID (classe `0x03`), endpoint interrupt OUT
ou SET_REPORT de controle (`bmRequestType=0x21`, `bRequest=0x09`,
`wValue=0x02CB`, `wIndex` da interface HID). Não suponha que `wMaxPacketSize`
seja o tamanho do output report. Não descarte a rota de controle só porque
esperava encontrar interrupt OUT.

## 3. Gravar os 11 presets e o Neutro na ordem do fixture

1. Abra <https://open-auri.com/cabo> no **Chrome desktop**, em contexto
   seguro. Conecte pelo seletor WebHID e confirme o VID/PID do cabo. Deixe
   o modo real ativo, não o simulado. Não use a ponte Android nesta etapa.
2. Confirme a ordem das chaves `presets` do fixture atual. Na raiz do
   repositório, este comando somente lê o fixture, sem acessar USB:

   ```powershell
   Set-Location 'D:\git\open-auri'
   node --input-type=module -e "import fs from 'node:fs'; const f = JSON.parse(fs.readFileSync('test/fixtures/eq0xcb.reference.json', 'utf8')); console.log([...Object.keys(f.presets), 'neutro'].join('\n'));"
   ```

   A ordem atual é:

   | Ordem | Chave da curva |
   | --- | --- |
   | 1 | `padrao` |
   | 2 | `pref6` |
   | 3 | `emv` |
   | 4 | `basshead` |
   | 5 | `energico` |
   | 6 | `musical` |
   | 7 | `analitico` |
   | 8 | `referencia` |
   | 9 | `harman` |
   | 10 | `vdsf` |
   | 11 | `etymotic` |
   | 12 | `neutro` (Neutro/Neutral, depois dos presets) |

3. Para cada preset, carregue-o no editor pelo seletor de presets do site.
   Preserve bandas e pré-amplificação originais; não aplique normalização,
   AutoEq ou edições manuais. Carregar no editor ainda não grava.
4. Abra o checklist normal, confirme volume baixo e manutenção da conexão,
   confira a curva e acione **Gravar no cabo** por gesto explícito. Aguarde
   sucesso, registre horário/curva/resultado e só então passe à próxima.
   Respeite os intervalos e limites de flash impostos pelo site. Não use
   `sendReport` no console nem desative o gate para acelerar a captura.
5. Depois dos 11 presets, use o fluxo normal de resgate para gravar o
   **Neutro** uma única vez. No site atual ele usa as dez bandas desligadas
   e pré-amplificação de **-0,5 dB**. Não o substitua por uma curva manual
   de 0 dB: os bytes seriam diferentes. A definição está em
   [`D:\git\open-auri\web\src\lib\cable\service.ts`](../../web/src/lib/cable/service.ts).
6. Se uma gravação falhar, houver desconexão ou o checklist exigir mudar
   parâmetros, registre e interrompa a sequência. Faça o resgate necessário
   pelo site e recomece uma captura limpa. Não esconda tentativas extras
   nem reordene pacotes para fazer a referência passar.
7. Pare a captura e salve o arquivo bruto do Wireshark. Registre data/hora,
   versão do Windows, Chrome, Wireshark/USBPcap, commit do repositório,
   identificação do cabo, barramento/endereço e resultado de cada curva.

O esperado são **12 gravações completas**, cada uma com nove reports de
dados e um commit. O transporte envia dados de 31 bytes com ID `0xCB`;
o buffer observado no fio também inclui prefixo e possível padding.
URBs de submissão e conclusão não são duas gravações diferentes.

## 4. Exportar JSON com tshark

Em PowerShell 7, indique o arquivo bruto salvo, o destino novo para JSON
e os números observados. As variáveis evitam presumir pastas de instalação
ou nomes de captura que não existem no seu computador.

```powershell
$captura = Read-Host 'Caminho absoluto do arquivo bruto salvo no Wireshark'
$json = Read-Host 'Caminho absoluto do novo JSON de exportação'
$barramento = [int](Read-Host 'usb.bus_id observado')
$endereco = [int](Read-Host 'usb.device_address observado')
$filtro = "usb.bus_id == $barramento && usb.device_address == $endereco"
tshark -r $captura -Y $filtro -T json | Set-Content -LiteralPath $json -Encoding utf8NoBOM
```

Verifique o código de saída do tshark e se o JSON contém os dados USB, não
só os quadros de enumeração. Não exporte somente a lista resumida de
pacotes nem use `-T fields` no lugar de `-T json`. Não filtre somente o
report ID: a ferramenta precisa reconhecer interface, rota e URBs. Guarde
o bruto original para revisar descritores ou refazer uma exportação.

## 5. Gerar e validar o golden

A ferramenta da Fase 3 é
[`D:\git\open-auri\tools\usb-golden.mjs`](../../tools/usb-golden.mjs),
chamada por `node tools/usb-golden.mjs` na raiz `D:\git\open-auri`.
Ela deve extrair somente OUT da interface HID,
reconhecer interrupt e SET_REPORT, agrupar os nove reports e o commit e
comparar os dados sem prefixo/padding com o fixture oficial. Preserve o
prefixo e o padding no golden: justamente isso será comparado com o app.

O resultado só é referência física se vier desta captura real. Fixtures
sintéticos servem para testar a ferramenta e não devem ser apresentados
como validação do cabo.

## 6. Executar a sonda B1 e salvar collections

A sonda B1 está em
[`D:\git\open-auri\docs\probing.md`](../probing.md), seção B, linhas 40-50.
Ela apenas lê `HIDDevice.collections`, sem escrever ou tentar comandos de
leitura desconhecidos. Permite identificar reports input/output/feature,
seus tamanhos e a eventual presença do report `0x4B`. **Não execute B2/B3
ou outras sondas de escrita como parte desta captura.**

Na mesma origem do site, depois de conceder permissão pelo botão Conectar,
abra o DevTools do Chrome e execute:

```js
const cabosB1 = await navigator.hid.getDevices();
const caboB1 = cabosB1.find(
  (device) => device.vendorId === 0x3302 && device.productId === 0x8902,
);
if (!caboB1) throw new Error('Conecte e autorize o cabo pelo site antes da B1.');
const resultadoB1 = {
  vendorId: caboB1.vendorId,
  productId: caboB1.productId,
  productName: caboB1.productName,
  collections: caboB1.collections,
};
console.log(resultadoB1);
copy(JSON.stringify(resultadoB1, null, 2));
```

`copy` é uma função do console do DevTools, não uma API do site. Cole a
saída em um novo arquivo JSON na pasta da captura e guarde também a versão
do Chrome e a data da leitura. Não é necessário chamar `open`,
`sendReport` ou `receiveFeatureReport` para ler `collections`. Se a lista
vier vazia ou sem output report esperado, registre esse resultado em vez
de inventar um descritor.

## Verificação e entrega

- Bruto original preservado, JSON do tshark válido e filtrado pelo endereço
  do dispositivo que foi identificado por VID/PID.
- Doze gravações na ordem do fixture: onze presets e Neutro, sem tentativa
  extra confundida com uma curva.
- Golden validado contra os reports esperados, sem divergências, com rota,
  prefixo, padding, data, sistema e navegador identificados.
- JSON da B1 com `collections`, notas de captura e diário de resultados.
- Revisão de privacidade antes de compartilhar: o bruto pode conter tráfego
  de outros dispositivos e os descritores podem conter identificadores.

Entregue os artefatos ao responsável pela T5.1. Ele documentará os
descritores reais e a rota observada; a T5.2 compara o framing nativo com
a referência. Uma divergência exige investigação, teste de regressão e,
se o código nativo mudar, nova versão do app. Não remova o aviso apenas
porque a exportação JSON foi bem-sucedida.

## Recuperação se algo falhar

Interrompa a coleta, guarde a evidência e baixe o volume. Regrave o Neutro
pelo site no Chrome/Edge desktop, com o checklist normal. Se o cabo não
reaparecer, reconecte e conceda novamente a permissão. Não envie commit
isolado, não substitua drivers e não tente comandos aleatórios. Depois
do resgate, uma nova tentativa de referência começa com nova captura e
sequência completa, sem alterar a anterior.
