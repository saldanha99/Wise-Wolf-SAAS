# Hub — primeira compra real em produção (roteiro)

Roteiro do primeiro teste de compra do Wise Wolf Hub com dinheiro de verdade.
Não existe sandbox do Asaas ligado ao Hub: a compra, o PIX e o estorno são reais,
na conta Asaas da escola. Escrito em 03/11/2026 a partir do código de
`create-hub-checkout`, `asaas-webhook`, `process-hub-fulfillment`,
`cancel-hub-subscription`, `asaas-reconcile` e das funções vivas no banco
(`hub_activate_paid_checkout`, `hub_reverse_paid_checkout`,
`hub_mark_checkout_overdue`, `hub_ensure_checkout_fulfillment_outbox`).

**Estado medido em 03/11/2026 (leitura):** `hub_checkout_sessions`,
`hub_subscription_payments`, `hub_payment_event_inbox`, `hub_fulfillment_outbox`
e `hub_core_legal_acceptances` estão **vazias** — o Hub nunca vendeu. Esta compra
é a primeira a atravessar o caminho inteiro. Qualquer desvio do que está
descrito aqui é achado, não ruído: pare e registre.

> ⚠️ A compra aceita os termos **vigentes** (`2026-08-24`, em
> `supabase/functions/create-hub-checkout/legal-documents.ts`). Este teste
> valida o Hub que já está no ar; não depende da Fase 1 (gestão de alunos do
> professor), que só será publicada com os termos v2 (rascunho em
> `docs/legal/hub-termos-v2-e-anexo-de-dados-rascunho.md`).

## Quem faz o quê

| Quem | Faz | Não faz |
|---|---|---|
| **Dono** | cria a conta, paga o PIX, confere a tela, cancela, estorna no painel do Asaas | não roda SQL |
| **Assistente** | roda as consultas de leitura de cada etapa e diz "pode seguir" ou "pare" | não escreve no banco, não chama o Asaas, não reenvia evento |

Nenhuma etapa deste roteiro escreve no banco por SQL. Se algo travar, o
assistente **descreve** o que viu e o dono decide; reparo é outra tarefa.

## Como o assistente roda as consultas

Todas as consultas são só leitura e filtram pelo e-mail da conta nova do dono,
passado como variável do `psql` (não escreva o e-mail no repositório):

```bash
ssh wisewolf-vps "docker exec -i supabase-db psql -U postgres -d postgres -At -F '|' -v ON_ERROR_STOP=1 -v email=EMAIL_DA_CONTA_NOVA" <<'SQL'
set default_transaction_read_only = on;
-- cole aqui a consulta da etapa
SQL
```

As consultas abaixo foram executadas assim em 03/11/2026 com um e-mail
inexistente: todas rodaram sem erro (resultado vazio, como esperado).

---

## Etapa 0 — Pré-checagem (assistente, antes de o dono começar)

```sql
select public.hub_catalog_checkout_is_ready() as catalogo_pronto,
       (select metadata ->> 'hubEnabled' from public.hub_settings
         where settings_key = 'default') as hub_enabled,
       (select metadata ->> 'catalogReady' from public.hub_settings
         where settings_key = 'default') as catalog_ready_flag;

select code, name, price_monthly, price_yearly, is_active, is_public
from public.hub_plans
where code = 'LIBRARY_SOLO' and product_family = 'HUB_CORE';

-- linha de base da fila do Asaas: anote os números para comparar depois
select status, count(*) from public.asaas_webhook_inbox
where status in ('RECEIVED','PROCESSING','RETRY','TRIAGE','DEAD_LETTER')
group by status;

select jobname, schedule, active from cron.job
where jobname in ('wisewolf-asaas-webhook-worker', 'wisewolf-hub-fulfillment',
                  'wisewolf-expire-hub-core-cancellations',
                  'wisewolf-asaas-reconciliation')
order by jobname;
```

**Pode seguir se:**
- `catalogo_pronto = t` (o checkout devolve `HUB_CATALOG_NOT_READY` e a
  ativação recusa `hub_catalog_not_ready` sem isso);
- `hub_enabled` é `true` ou vazio (o checkout só bloqueia com `false` →
  `HUB_DISABLED`); `catalog_ready_flag` vazio ou `true`;
- `LIBRARY_SOLO` = "Professor Essencial", R$ 59,00 mensal / R$ 590,00 anual,
  ativo e público (valor medido em 03/11/2026);
- os quatro crons existem e estão ativos (worker do Asaas e entrega do Hub a
  cada minuto, expiração de cancelamento a cada 5 min, conciliação às 06:17 UTC
  = 03:17 de Brasília).

Em 03/11/2026 a fila tinha **181 eventos em `TRIAGE`**, todos anteriores e da
escola. Não é bloqueio; é a base para ver se algum evento **novo** do Hub cai lá.

## Etapa 1 — Conta nova do dono (dono)

1. Em `https://hub.wisewolflanguage.com.br`, criar conta com um e-mail que
   **nunca** foi usado na plataforma (nem como diretor, professor ou aluno) e
   que não seja de teste: conta com `app_metadata.test_fixture` não passa no
   checkout real.
2. Escolher o caminho do **professor** (o Hub cria a conta `EDUCATOR`,
   `PERSONAL`, com a Descoberta em teste grátis).

**Assistente confere:**

```sql
select u.id as user_id, u.created_at,
       coalesce(u.raw_app_meta_data ->> 'test_fixture', 'false') as test_fixture,
       a.id as account_id, a.audience, a.account_type, a.status as account_status,
       a.asaas_customer_id, m.membership_role, m.status as membership_status
from auth.users as u
left join public.hub_memberships as m on m.user_id = u.id
left join public.hub_accounts as a on a.id = m.account_id
where lower(u.email) = lower(:'email');

select s.id, p.code, s.status, s.billing_cycle, s.trial_ends_at,
       s.current_period_ends_at, s.provider, s.provider_subscription_id
from public.hub_subscriptions as s
join public.hub_plans as p on p.id = s.plan_id
join public.hub_memberships as m
  on m.account_id = s.account_id and m.membership_role = 'OWNER'
join auth.users as u on u.id = m.user_id
where lower(u.email) = lower(:'email')
order by s.created_at;
```

**Esperado:** uma linha, `test_fixture = false`, `audience = EDUCATOR`,
`account_type = PERSONAL`, `account_status = ACTIVE`, `membership_role = OWNER`
ativa, `asaas_customer_id` ainda vazio; uma assinatura `DISCOVERY` `TRIALING`
sem provedor. Mais de uma conta para o mesmo usuário → pare (o checkout pode
responder `HUB_ACCOUNT_AMBIGUOUS`).

## Etapa 2 — Contratar o Essencial mensal por PIX (dono, antes das 21h)

1. Planos → **Professor Essencial** → **Mensal** → **PIX**.
2. Preencher nome, e-mail, telefone com DDD e o **CPF do dono**; marcar o
   aceite dos Termos e da Política (os dois são obrigatórios e gravados
   separadamente).
3. **Não pagar ainda.** Avisar o assistente quando o QR Code aparecer.

⚠️ **Por que antes das 21h:** o vencimento da 1ª cobrança é a **data UTC** de
`hub_checkout_sessions.created_at` (`checkoutCreatedDate`, em
`create-hub-checkout/index.ts`). Depois das 21h de Brasília essa data já é
"amanhã": a cobrança nasce vencendo no dia seguinte e o vencimento deixa de ser
o dia da compra, o que confunde a conferência e a conciliação do dia seguinte.

⚠️ Clicar duas vezes não cria duas cobranças: o checkout é idempotente pela
chave do pedido e por "já existe checkout aberto deste produto"
(`CHECKOUT_IN_PROGRESS` / `PENDING_CHECKOUT_EXISTS`) e devolve o mesmo PIX.

**Assistente confere:**

```sql
select c.id as checkout_id, c.status, c.billing_cycle, c.billing_type, c.amount,
       c.asaas_subscription_id, c.asaas_payment_id, c.created_at,
       c.metadata ->> 'dueDate' as due_date,
       c.metadata ->> 'terms_version' as terms_version,
       c.metadata ->> 'legal_acceptance_id' as legal_acceptance_id,
       coalesce(c.metadata ->> 'reconciliation_required', 'false')
         as reconciliation_required
from public.hub_checkout_sessions as c
join auth.users as u on u.id = c.requested_by
where lower(u.email) = lower(:'email')
order by c.created_at desc;

select o.checkout_id, o.channel, o.status, o.attempt_count, o.last_error
from public.hub_fulfillment_outbox as o
join auth.users as u on u.id = o.user_id
where lower(u.email) = lower(:'email')
order by o.checkout_id, o.channel;

select l.id, l.terms_version, l.privacy_version, l.terms_sha256,
       l.privacy_sha256, l.source, l.accepted_at,
       l.terms_sha256 = encode(extensions.digest(
         convert_to(l.terms_snapshot, 'UTF8'), 'sha256'), 'hex')
         as termos_conferem
from public.hub_core_legal_acceptances as l
join auth.users as u on u.id = l.user_id
where lower(u.email) = lower(:'email');
```

**Esperado (pode pagar):**
- **um** checkout `PENDING`, `MONTHLY`, `PIX`, `amount = 59.00`, com
  `asaas_subscription_id` **e** `asaas_payment_id` preenchidos, `due_date` = hoje
  e `reconciliation_required = false`;
- **duas** linhas na `hub_fulfillment_outbox` (`EMAIL` e `WHATSAPP`), ambas
  `WAITING_PAYMENT` — elas são gravadas **antes** de qualquer POST ao Asaas
  (`hub_ensure_checkout_fulfillment_outbox`, que exige `rowCount = 2`);
- **uma** linha em `hub_core_legal_acceptances`: `terms_version` e
  `privacy_version` = `2026-08-24`, `terms_sha256` começando em `ba35b46f`,
  `privacy_sha256` em `84082bbc`, `source = HUB_CORE_CHECKOUT`,
  `termos_conferem = t`; o `legal_acceptance_id` do checkout é o `id` dela.

**Pare (não pague) se:** o checkout ficou `CREATED` ou `FAILED`, falta um dos
dois ids do Asaas, `reconciliation_required = true`, há menos (ou mais) de duas
linhas na outbox, ou a tela mostrou `HUB_CHECKOUT_RECONCILIATION_REQUIRED` /
`HUB_FULFILLMENT_RECONCILIATION_REQUIRED`. Nesses casos o código deixa o
checkout aberto de propósito para a próxima chamada reconciliar só por leitura;
**não** apague cobrança no Asaas "para tentar de novo".

## Etapa 3 — Pagar o PIX (dono) e conferir a ativação (assistente)

1. Pagar o PIX pelo app do banco.
2. Esperar 2 a 3 minutos (o webhook grava na fila e o worker roda a cada minuto).

```sql
-- evento bruto do Asaas
select i.provider_event_id, i.event_name, i.status, i.attempt_count,
       i.last_error, i.received_at, i.processed_at
from public.asaas_webhook_inbox as i
where i.payload -> 'payment' ->> 'externalReference' in (
  select 'hub:' || c.id from public.hub_checkout_sessions as c
  join auth.users as u on u.id = c.requested_by
  where lower(u.email) = lower(:'email'))
order by i.received_at;

-- evento já roteado para o Hub
select e.event_key, e.event_name, e.payment_id, e.status, e.attempt_count,
       e.last_error, e.processed_at
from public.hub_payment_event_inbox as e
join public.hub_checkout_sessions as c on c.id = e.checkout_id
join auth.users as u on u.id = c.requested_by
where lower(u.email) = lower(:'email')
order by e.created_at;

-- assinatura
select s.id, p.code, s.status, s.billing_cycle, s.current_period_starts_at,
       s.current_period_ends_at,
       s.current_period_ends_at - s.current_period_starts_at as duracao,
       s.provider_subscription_id, s.provider_payment_id,
       s.metadata ->> 'checkoutId' as checkout_id
from public.hub_subscriptions as s
join public.hub_plans as p on p.id = s.plan_id
join public.hub_memberships as m
  on m.account_id = s.account_id and m.membership_role = 'OWNER'
join auth.users as u on u.id = m.user_id
where lower(u.email) = lower(:'email')
order by s.created_at;

-- livro de pagamentos do Hub
select hp.provider_payment_id, hp.status, hp.period_starts_at,
       hp.period_ends_at, hp.applied_at, hp.reversed_at, hp.metadata
from public.hub_subscription_payments as hp
join public.hub_checkout_sessions as c on c.id = hp.checkout_id
join auth.users as u on u.id = c.requested_by
where lower(u.email) = lower(:'email');

-- o pagamento do Hub NÃO pode ter caído no financeiro da escola
select count(*) as vazou_para_escola
from public.student_payments as sp
where sp.asaas_payment_id in (
  select c.asaas_payment_id from public.hub_checkout_sessions as c
  join auth.users as u on u.id = c.requested_by
  where lower(u.email) = lower(:'email') and c.asaas_payment_id is not null);
```

Repita a consulta do checkout e da outbox da Etapa 2.

**Esperado:**
- `asaas_webhook_inbox`: `PAYMENT_RECEIVED` (PIX liquida na hora) em
  `PROCESSED`. Pode haver também `PAYMENT_CREATED`, também `PROCESSED`.
  Nenhum evento do Hub em `RETRY`, `TRIAGE` ou `DEAD_LETTER`;
- `hub_payment_event_inbox`: uma linha por evento, `PROCESSED`, `last_error`
  vazio;
- `hub_subscriptions`: a `DISCOVERY` virou `EXPIRED`; nasceu uma `LIBRARY_SOLO`
  `ACTIVE`, `MONTHLY`, `duracao = 1 mon`, com `provider_subscription_id` igual ao
  `asaas_subscription_id` do checkout e `provider_payment_id` igual ao pagamento;
- `hub_subscription_payments`: **uma** linha `APPLIED` com o mesmo período da
  assinatura e `metadata.renewal = false`;
- checkout `PAID`;
- outbox: as duas linhas passam a `PENDING` no instante do pagamento (gatilho
  `hub_release_fulfillment_on_payment`) e a `SENT` em até alguns minutos (cron
  `wisewolf-hub-fulfillment`). O dono recebe o e-mail e o WhatsApp de
  boas-vindas;
- `vazou_para_escola = 0`. Pagamento com referência `hub:` é roteado antes de
  `processarPagamento`; se aparecer em `student_payments`, ele dispararia caixa,
  rateio e indicação (`trg_ledger_on_payment`, `trg_notify_payment_split`,
  `trg_grant_referral_reward`) — pare na hora.

**Pare se:** evento em `RETRY`/`TRIAGE` (leia `last_error`: `hub_*_mismatch`
indica divergência de identidade entre Asaas e checkout; `hub_checkout_unresolved`
indica referência sem checkout); checkout `PAID` sem assinatura `ACTIVE`; dois
`APPLIED` para a mesma compra; outbox `UNCERTAIN` ou `FAILED` (não reenvie: o
resultado incerto existe para não mandar duas vezes).

## Etapa 4 — Conferência na tela (dono)

Sair e entrar de novo no Hub e conferir:
- plano **Professor Essencial** ativo, com a data de renovação um mês à frente;
- Biblioteca abrindo um material completo (não só a prévia);
- "Gestão da assinatura" mostrando **Renovação automática ativa**;
- o e-mail e o WhatsApp de boas-vindas chegaram uma vez cada.

Anote no registro do teste (fim deste arquivo) qualquer texto errado ou link que
não abriu.

## Etapa 5 — Cancelar pela tela (dono)

1. "Gestão da assinatura" → Cancelar renovação → digitar **CANCELAR** →
   confirmar.
2. A tela deve dizer que o acesso continua até a data do fim do período.

O cancelamento (`cancel-hub-subscription`) marca a assinatura como
"cancelamento em andamento", apaga a assinatura no Asaas (nenhuma cobrança nova
é agendada) e grava `cancelAtPeriodEnd`. **O acesso não cai agora:** o cron
`wisewolf-expire-hub-core-cancellations` encerra só no fim do período pago.

```sql
select s.status, s.current_period_ends_at, s.cancelled_at,
       s.metadata ->> 'cancelAtPeriodEnd' as cancel_at_period_end,
       s.metadata ->> 'cancellationInProgress' as cancelamento_em_andamento,
       s.metadata ->> 'accessEndsAt' as acesso_ate
from public.hub_subscriptions as s
join public.hub_memberships as m
  on m.account_id = s.account_id and m.membership_role = 'OWNER'
join auth.users as u on u.id = m.user_id
where lower(u.email) = lower(:'email') and s.product_family = 'HUB_CORE'
order by s.created_at desc
limit 1;
```

**Esperado:** `status = ACTIVE`, `cancel_at_period_end = true`,
`cancelamento_em_andamento` vazio (a marca sai quando o cancelamento termina),
`acesso_ate` = `current_period_ends_at`, e esse fim de período inalterado.
`cancelamento_em_andamento = true` sobrando é cancelamento que parou no meio. No painel do Asaas, a assinatura do cliente
aparece removida e a cobrança paga continua lá, `Recebida`.

**Pare se:** a tela respondeu `HUB_CANCELLATION_RECONCILIATION_REQUIRED` ou a
assinatura continua ativa no Asaas.

## Etapa 6 — Estornar pelo painel do Asaas (dono)

1. No painel do Asaas: Cobranças → a cobrança de R$ 59,00 do cliente (descrição
   "Wise Wolf Hub - Professor Essencial (MONTHLY)", referência externa
   `hub:<checkout_id>`) → **Estornar** valor total.
2. Esperar o Asaas mandar o evento de estorno (pode levar alguns minutos; o PIX
   devolvido pode passar por `PAYMENT_REFUND_IN_PROGRESS` antes).

Repita as consultas da Etapa 3 (inbox, Hub inbox, assinatura, livro) e a do
checkout.

**Esperado:**
- `PAYMENT_REFUND_IN_PROGRESS` (se vier) `PROCESSED` **sem efeito**: o
  pagamento já está `APPLIED` e `hub_mark_checkout_overdue` o ignora;
- `PAYMENT_REFUNDED` `PROCESSED` nas duas filas;
- checkout `REVERSED` (com `reversalEvent = PAYMENT_REFUNDED` na metadata);
- assinatura `LIBRARY_SOLO` `CANCELLED`, `current_period_ends_at` ≈ hora do
  estorno, `cancelled_at` preenchido;
- `hub_subscription_payments` da compra `REVERSED`, `reversed_at` preenchido
  (o `applied_at` original fica — é ele que a consulta de receita usa);
- na tela, depois de sair e entrar, o Essencial **não** dá mais acesso à
  Biblioteca completa.

Antes de aplicar o estorno o webhook tenta apagar a assinatura no Asaas de novo;
como ela já foi apagada na Etapa 5, a resposta "não existe" é tratada como
concluída. **Pare se** o evento ficar em `RETRY` com erro de cancelamento no
provedor, ou se surgir um `PAYMENT_DELETED` de outra cobrança desse cliente (uma
cobrança futura apagada junto com a assinatura): ele cai no mesmo ramo de
estorno e deve falhar por `hub_checkout_payment_mismatch` em vez de mexer na
conta — registre e não reprocesse.

## Etapa 7 — Conciliação do dia seguinte (assistente)

O cron `wisewolf-asaas-reconciliation` roda às 03:17 de Brasília e a janela vai
até o dia anterior: a compra feita no dia D entra na rodada da madrugada de D+1.

```sql
select r.id, r.status, r.window_start, r.window_end, r.started_at,
       r.finished_at, r.last_error
from public.asaas_reconciliation_runs as r
order by r.started_at desc
limit 3;

select i.kind, i.severity, i.provider_entity_id, i.local_entity_id, i.details
from public.asaas_reconciliation_issues as i
where i.run_id = (
    select id from public.asaas_reconciliation_runs
    where status = 'COMPLETED'
    order by started_at desc
    limit 1)
  and (i.kind like 'PRODUCT_PAYMENT_%'
       or i.kind = 'STUDENT_AND_PRODUCT_PAYMENT_PROVIDER_ID_COLLISION');
```

**Esperado:** a rodada mais recente `COMPLETED`, com `window_end` = dia da compra,
e **nenhuma** linha na segunda consulta. Os tipos que acusariam problema do Hub
são `PRODUCT_PAYMENT_MISSING_LOCAL` (o Asaas tem a cobrança `hub:` e o livro
local não), `PRODUCT_PAYMENT_REFERENCE_MISSING_LOCAL` (referência `hub:` sem
checkout), `PRODUCT_PAYMENT_REFERENCE_MISMATCH`,
`PRODUCT_PAYMENT_PROVIDER_ID_COLLISION`, `PRODUCT_PAYMENT_REFERENCE_COLLISION` e
`STUDENT_AND_PRODUCT_PAYMENT_PROVIDER_ID_COLLISION` (o mesmo pagamento no Hub e
no financeiro da escola).

Conferir também que a fila do Asaas não ganhou eventos novos em `TRIAGE`
(comparar com a linha de base da Etapa 0).

## Depois do teste

- A conta do dono fica com o Essencial `CANCELLED`. Pode continuar usando a
  Descoberta? Não: a Descoberta foi consumida (`trial_claimed_at`). Para nova
  compra, um checkout novo.
- O estorno devolve o valor ao pagador; a tarifa do Asaas sobre o PIX não volta.
  O valor líquido real fica no extrato do Asaas (ver
  `docs/runbooks/hub-receita-da-plataforma.md`).
- Nada deste teste entra em `financial_transactions`, `student_payments`, DRE,
  rateio ou fechamento da escola. Se alguém lançar "para fechar o caixa", o
  rateio dispara.
- **Fora deste teste (decisões de 03/11 para a Fase 1, ainda não
  implementadas):** cancelamento automático de PIX/boleto sem 1º pagamento em 5
  dias e carência de 5 dias no atraso. Hoje um PIX não pago fica `PENDING` e,
  vencido, `OVERDUE` (`hub_mark_checkout_overdue`); não há prazo de corte.

## Registro do teste

| Etapa | Data/hora | Resultado | Observação |
|---|---|---|---|
| 0 Pré-checagem | | | |
| 1 Conta nova | | | |
| 2 Checkout PIX | | | |
| 3 Pagamento | | | |
| 4 Tela | | | |
| 5 Cancelamento | | | |
| 6 Estorno | | | |
| 7 Conciliação | | | |
