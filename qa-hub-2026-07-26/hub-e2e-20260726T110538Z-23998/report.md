# Relatório E2E — Wise Wolf Hub

- Data: 2026-07-26
- Ambiente: produção
- Rota: `https://system.wisewolflanguage.com.br/hub`
- Fixture: `hub-e2e-20260726T110538Z-23998`
- Público testado: professor/autônomo

## Resultado

O fluxo autenticado chegou ao portal do Hub. A consulta usada durante a
execução procurou incorretamente o estado `TRIAL`; o estado válido do produto é
`TRIALING`. Como a fixture foi removida antes dessa inconsistência ser
identificada e o arquivo de backup ficou vazio, essa execução não constitui
evidência suficiente para afirmar que o trial falhou. O provisionamento deve
ser retestado com a consulta corrigida.

O checkout não foi executado. O Asaas configurado na VPS é produção, o SMTP
está ativo e `create-hub-checkout` não oferece `testMode` nem supressão de
notificações. Prosseguir violaria o runbook de identidade E2E.

## Etapas validadas

- carregamento da landing pública;
- criação administrativa de identidade confirmada, sem envio de e-mail;
- login pelo formulário público;
- criação da conta e membership isoladas do Hub;
- carregamento do portal autenticado;
- carregamento da biblioteca com 27 materiais;
- exibição dos controles de prévia e upgrade;
- ausência de checkout, assinatura e cobrança;
- limpeza por IDs exatos.

## Inconsistência da evidência

### HUB-E2E-001 — Consulta de trial usou estado inválido

A consulta filtrou `TRIAL`, enquanto a constraint e as funções do Hub usam
`TRIALING`. O resultado anterior sobre ausência de assinatura foi invalidado.

## Cobrança e notificações

- Cobrança criada: não.
- Valor cobrado: R$ 0,00.
- Cliente/assinatura Asaas: não criados.
- E-mail, WhatsApp ou SMS: não disparados.

## Limpeza

A verificação final retornou zero registros para:

- `auth.users`;
- `profiles`;
- `hub_accounts`;
- `hub_memberships`;
- `hub_conversion_events`;
- `hub_checkout_sessions`.

O arquivo reservado para backup na VPS ficou vazio e não deve ser tratado como
backup válido:

`/opt/wisewolf/backups/e2e-hub-hub-e2e-20260726T110538Z-23998/fixture-sanitized.json`

## Evidências visuais

- `screenshots/login-filled.png`
- `screenshots/library.png`
