# Matriz E2E segura — Wise Wolf Hub

Data: 24 de agosto de 2026

## Veredito

Os fluxos automatizados do Hub passaram da landing page até a fronteira segura do provedor, incluindo restauração da intenção de plano, módulos nativos, isolamento de conta/papel, replays de webhook, fulfillment idempotente e lifecycle de assinatura.

O resultado não autoriza afirmar que uma cobrança real foi concluída: o Asaas configurado é de produção, portanto nenhum pagamento, e-mail ou WhatsApp real foi disparado. O CPF autorizado para testes de matrícula não foi usado, porque este teste não era um fluxo de matrícula.

## Pós-release final

- Release ativa: `20260824T075111Z-cf1be584f050`.
- As sete rotas públicas passaram em 28 cenários de produção: desktop e mobile, nos modos claro e escuro.
- Não houve erro de console, runtime, rede, imagem ou responsividade no smoke público.
- O checkout do School OS aceita somente PIX e boleto. PAN, CVV e qualquer payload de cartão são recusados no navegador e na função server-side.
- Idempotência, reconciliação por `externalReference`, lease de tentativa e compensação fail-closed foram validados sem chamar o Asaas.
- `hub.wisewolflanguage.com.br` continua pendente porque o token Cloudflare fornecido não possui permissão de DNS. As rotas de compatibilidade em `system.wisewolflanguage.com.br/hub` estão funcionais.

## Cobertura e resultados

| Jornada | Evidência | Resultado |
| --- | --- | --- |
| Sete páginas públicas | catálogo de rotas, navegação, metadata, canonical, sitemap e HTML estático | aprovado |
| Preços e CTAs | três entradas para professores, Wolfie separado e School OS assistido | aprovado |
| Cadastro/login | plano e ciclo sobrevivem à confirmação de e-mail com expiração curta | aprovado |
| Checkout | revisão, máscara de documento, chave idempotente e chamada simulada do provider | aprovado sem cobrança real |
| Checkout School OS | PIX/boleto, bloqueio de cartão, reconciliação, lease e compensação | aprovado sem cobrança real |
| Falha de checkout | conta inativa e fixture fora de sandbox falham fechadas | aprovado |
| Webhook | identidade financeira, replay e roteamento Hub/SaaS | aprovado |
| Fulfillment | outbox, lease, idempotência e supressão de fixture | aprovado sem entrega real |
| Biblioteca | reutiliza `MaterialsLibrary` e abre conteúdo somente por URL assinada | aprovado em código; catálogo público vazio por direitos |
| Educador IA | reutiliza `LessonPlannerAI` por adapter isolado | aprovado |
| Wolfie | reutiliza catálogo e tutor nativos com escopo de conta | aprovado |
| School OS | abre a jornada do tenant escolar, sem simular um admin dentro do Hub | aprovado |
| Conta e papel | aluno não recebe ferramentas de professor; troca concorrente não mistura contas | aprovado |
| Lifecycle | atraso, estorno, cancelamento, replay e período expirado revogam acesso | aprovado |
| PII de professores/alunos | colunas privadas removidas do diretório compartilhado e protegidas por RPCs | aprovado |

## Execuções

### Interface e regras do Hub

- 25 arquivos Vitest.
- 95 testes aprovados em execução serial, sem timeout.
- A primeira execução paralela teve dois timeouts de 5 segundos; os mesmos sete cenários passaram isoladamente. A execução serial final eliminou a ambiguidade.
- Dois testes adicionais de privacidade de `profiles` passaram.
- TypeScript da aplicação: aprovado.

### Edge Functions

- 37 testes Deno aprovados.
- `deno check` aprovado para checkout, fulfillment, gestão de status, biblioteca, Educador IA, Wolfie e webhook Asaas.
- Cobertura inclui chave idempotente, compensação de customer, identidade financeira, replay determinístico, overdue/refund/recovery, outbox e isolamento da conversa Wolfie.

### Banco

As nove suítes abaixo passaram na VPS usando seus próprios envelopes `BEGIN`/`ROLLBACK`:

1. `hub_content_isolation.sql`
2. `hub_account_usage_hardening.sql`
3. `hub_fulfillment_outbox.sql`
4. `hub_wolfie_conversation_scope.sql`
5. `hub_educator_native_planner.sql`
6. `hub_account_mutations.sql`
7. `hub_member_profiles_and_learner_crud.sql`
8. `saas_subscription_lifecycle.sql`
9. `profile_teacher_pii_isolation.sql`

Nenhum artefato de fixture permaneceu após essas suítes.

## Lacuna adicionada

Foi criado `components/hub/HubPortalEntryMatrix.test.tsx` para provar a ligação que ainda não estava coberta de ponta a ponta:

- `/hub/biblioteca` → `library`;
- `/hub/educador-ia` → `educator`;
- `/hub/wolfie` → `wolfie`;
- `/hub/saas-escolar` → `saas`.

Assim, um usuário já autenticado entra no módulo relacionado à LP, em vez de cair sempre no resumo genérico.

## Bloqueios honestos

### Cobrança e entrega

- O ambiente Asaas disponível é de produção, não sandbox.
- Nenhuma cobrança real foi criada.
- Nenhum e-mail ou WhatsApp real foi enviado.
- A validação termina na função simulada, nas regras puras, no webhook e no banco transacional.
- Um E2E real do provedor depende de credenciais Asaas sandbox e destinos de comunicação isolados.

### Biblioteca externa

- Produção contém 57 `hub_content_items`, mas 0 estão ativos/publicados.
- Há 38 materiais nativos em `CONSENT_REQUIRED`.
- Opt-in, aprovação comercial e comprovação de direitos permanecem falsos.
- A Biblioteca externa ficará vazia até a direção registrar os direitos. Isso é proteção intencional, não autorização para publicar automaticamente.

### Vídeos

- O gate público continua fechado porque os recibos atuais não comprovam direitos comerciais.
- Os mockups permanecem como fallback seguro.

## Incidente durante a validação

O objetivo era testar três migrations dentro de uma transação revertida. Duas delas já continham `BEGIN`/`COMMIT`; seus `COMMIT` internos encerraram a transação externa. As três migrations de hardening foram, portanto, aplicadas diretamente na VPS duas vezes, embora nenhum deploy tivesse sido solicitado.

Janela registrada no transcript:

- início da chamada: `2026-08-24T06:37:57.195Z`;
- retorno do erro: `2026-08-24T06:37:58.349Z`;
- horário de Brasília: aproximadamente `03:37:57–03:37:58`.

Arquivos aplicados e SHA-256:

| Migration | SHA-256 |
| --- | --- |
| `20260824041712_hub_catalog_collection_read_grants.sql` | `88424a7b33761c156f8027a7fdc6779a58470a853b7b23f1ea9a65a6e7d88bf2` |
| `20260824051022_harden_saas_subscription_lifecycle.sql` | `76d956cb60da3a807afbe9e01580e95a6e6db2dc506139afc11f562a943ce2f5` |
| `20260824051348_restrict_teacher_profile_pii.sql` | `92714507754fb4445ccb12d4cad098fa38a5820be4f6f92662067a51d1a837d9` |

Estado observado somente por leitura após o incidente:

- zero markers de release para as três versões;
- inbox de billing com 0 linhas e 3 índices;
- 0 tenants com checkout SaaS provisionado, portanto nenhum tenant atual mudou de estado por causa da nova regra;
- 0 das 48 colunas privadas de `profiles` concedidas diretamente a `authenticated`;
- grants de coleção do Hub e políticas esperadas presentes;
- migrations não executam alteração de dados de clientes no momento da aplicação; elas mudam grants, políticas, funções, triggers e estrutura da inbox.

Não houve tentativa de reversão, porque reverter às cegas removeria hardening de segurança. O release normal pode reaplicar as migrations idempotentes e registrar seus markers.

## Conclusão de produto

O Hub herda os módulos nativos nos pontos críticos, e as fronteiras de assinatura/tenant estão cobertas por testes. Antes de uma publicação comercial completa, ainda são obrigatórios: liberar direitos dos materiais pela direção, obter ambiente Asaas sandbox para E2E real, manter notificações suprimidas em fixture e resolver os direitos comerciais dos vídeos.
