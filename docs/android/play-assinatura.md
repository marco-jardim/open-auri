# Assinatura na Play e registro do pacote (P6)

Roteiro do mantenedor para o Anexo H.3 do plano. Chaves, senhas, PEPK e arquivos exportados ficam só na máquina do mantenedor, nunca no repositório, no chat ou em artifacts.

## Valores esperados

| Item | Valor |
|---|---|
| Pacote | `com.openauri.app` |
| SHA-256 do certificado do app (Play App Signing, APK do GitHub, `assetlinks.json`) | `FB:46:E3:4F:03:FD:6F:59:5B:4B:70:36:74:8F:92:83:08:FA:BF:31:C1:55:BF:E2:C5:0E:B1:B4:43:FF:61:D0` |
| SHA-256 do certificado de upload (AABs enviados à Play) | `59:1A:0A:1B:CC:E8:A5:39:AF:2F:25:60:DE:1D:D7:92:82:F0:42:BA:40:62:82:31:F3:E4:35:E3:A6:CD:04:16` |

## Passos

1. No Play Console, com o app já criado (P5), abra **Testar e lançar › Integridade do app › Assinatura de apps do Google Play** (ou o passo de assinatura que aparece ao criar a primeira versão).
2. Escolha **usar outra chave** e a opção de **exportar e enviar uma chave de um keystore Java**. Não aceite a chave gerada pelo Google: o APK do GitHub e os App Links usam a chave do app acima.
3. Baixe a ferramenta **PEPK** e a **chave pública de criptografia** que o Console oferece, na pasta privada das chaves.
4. Exporte a chave do app criptografada, no PowerShell, nessa pasta. O comando pede as senhas do keystore e da chave (as duas iguais):

   ```powershell
   java -jar pepk.jar --keystore=open-auri-app.p12 --alias=open-auri-app --output=open-auri-app-pepk.zip --include-cert --rsa-aes-encryption --encryption-key-path=encryption_public_key.pem
   ```

   Se o Console mostrar outro comando, use o do Console.
5. Envie `open-auri-app-pepk.zip` no Console.
6. Quando o Console pedir o **certificado da chave de upload**, envie `open-auri-upload-cert.pem`. Se ele não existir, gere-o:

   ```powershell
   keytool -exportcert -rfc -keystore open-auri-upload.p12 -storetype PKCS12 -alias open-auri-upload -file open-auri-upload-cert.pem
   ```

7. Confira na página de Assinatura de apps os dois certificados SHA-256 mostrados pelo Console: o **de assinatura do app** deve ser igual ao valor do app acima, e o **de upload**, igual ao de upload. Se algum divergir, pare e informe o agente.
8. Abra a página de **verificação de desenvolvedor do Android** no Console e confirme que `com.openauri.app` aparece registrado com o SHA-256 do app.
9. Apague `open-auri-app-pepk.zip` e a chave pública baixada depois do envio. Guarde o backup das chaves como no runbook.

## Resultado

Preenchido pelo agente com o que o Console mostrar.

| Conferência | Resultado |
|---|---|
| SHA-256 de assinatura do app no Console | pendente |
| SHA-256 de upload no Console | pendente |
| `com.openauri.app` na verificação de desenvolvedor | pendente |
