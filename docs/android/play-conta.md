# Conta da Play: estado, identidade e segurança (P1)

- **Plano:** `D:\git\open-auri\docs\plans\2026-10-18-android-capacitor-plano.md`, Trilha P, P1 e Anexo H.1
- **Base:** `D:\git\open-auri\docs\android\play-requisitos.md` (P0, consultado em 2026-10-19)
- **Regra:** este arquivo nunca guarda documento, endereço completo, telefone nem senha.

## Passos do mantenedor

1. Entrar em https://play.google.com/console com a conta Google antiga.
2. Se aparecer aviso de conta fechada ou "inativa", parar e informar o texto exato. A conta é marcada quando tem mais de 1 ano, poucas instalações, contato não verificado e nenhum uso do Console em 180 dias (P0, item 1).
3. Em "Detalhes da conta": conferir e verificar o e-mail de contato e o telefone; salvar. Isso, mais criar o app na P5, mantém a conta ativa.
4. Na conta Google: ativar a verificação em duas etapas.
5. Concluir a verificação de identidade pedida pelo Console (documento oficial e verificação do aparelho pelo app Play Console). O documento vai só para o Console, nunca para o chat.
6. Conferir o nome público de desenvolvedor e o e-mail público. Para conta pessoal, a Play mostra nome legal, país e e-mail de desenvolvedor; o endereço completo só aparece com monetização (P0, item 2). O app é gratuito e sem compras.
7. Informar ao agente:
   - conta ativa ou fechada;
   - data de criação (em "Detalhes da conta");
   - tipo (pessoal ou organização);
   - identidade verificada (sim ou não);
   - se recebeu aviso de inatividade.

## Por que a data de criação importa

Contas pessoais criadas depois de 2023-11-13 precisam de teste fechado com 12 testadores por 14 dias antes da produção (P0, item 1). Conta anterior a essa data publica direto (P7, caminho isento).

## Desvio (conta fechada ou irrecuperável)

1. Abrir conta nova, com taxa de registro e verificação de identidade.
2. A P7 passa a incluir o teste fechado (12 testadores por 14 dias).
3. O agente prepara o texto de convite e o formulário de inscrição de testadores para a comunidade.

## Resultado

| Campo | Valor |
|---|---|
| Estado da conta | ativa (informado pelo mantenedor em 2026-10-20) |
| Data de criação | anterior a 2023-11-13 ("conta muito antiga") |
| Tipo | pessoal |
| Identidade verificada | não; publicação bloqueada pelo Console até concluir a verificação |
| Aviso de inatividade | nenhum informado |
| Caminho da P7 | isento de teste fechado (conta pessoal anterior a 2023-11-13); envio direto para produção depois do teste interno |

**Próximo passo do mantenedor:** concluir a verificação de identidade no Play Console (passo 5 acima). Enquanto ela não terminar, a P5 (criar o app e preencher a ficha) pode ser feita como rascunho, mas nenhuma versão pode ser enviada.
