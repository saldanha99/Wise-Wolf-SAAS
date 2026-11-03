-- Checkout do Hub abandonado (HUB_CORE e WOLFIE_STANDALONE).
--
-- Decisão do dono (03/11/2026): PIX/boleto sem o 1º pagamento é cancelado em
-- 5 dias. Hoje quem gera a cobrança e não paga deixa a assinatura viva no
-- Asaas (que continua gerando cobrança todo mês) e o checkout PENDING/OVERDUE
-- bloqueia a compra de outro plano (409 PENDING_CHECKOUT_EXISTS).
--
-- A rotina reaproveita o trilho durável de mutação no provedor
-- (20260825195830_harden_hub_provider_operations): uma operação imutável por
-- checkout (kind ABANDONED_CHECKOUT), o DELETE da assinatura atravessa o mesmo
-- limite READY -> SUBMITTING das outras operações (no máximo um DELETE por
-- assinatura, retentativa só com GET), e a 1ª cobrança é removida
-- explicitamente com o mesmo desenho, numa tabela própria.
--
-- Enquanto a operação está aberta, private.hub_lock_provider_event_writer
-- recusa os escritores do webhook da conta (pagamento, estorno, atraso): um
-- pagamento chegando na mesma hora espera. Depois do cancelamento, o pagamento
-- tardio nunca libera acesso: fica registrado no checkout para conciliação
-- manual (wrappers recriados no fim deste arquivo).

do $requirements$
begin
  if pg_catalog.to_regclass('private.hub_provider_operations') is null
     or pg_catalog.to_regclass('private.hub_provider_operation_targets') is null
     or pg_catalog.to_regclass('public.hub_checkout_sessions') is null
     or pg_catalog.to_regclass('public.hub_subscription_payments') is null
     or pg_catalog.to_regclass('public.hub_fulfillment_outbox') is null
     or pg_catalog.to_regclass('public.asaas_provider_creation_attempts') is null
     or pg_catalog.to_regprocedure(
       'public.hub_mark_provider_cancellation_submitting(uuid,uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.hub_assert_provider_operation_complete(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.hub_lock_provider_event_writer(uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.hub_activate_paid_checkout_provider_apply(uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.hub_reverse_paid_checkout_provider_apply(uuid,text,text)'
     ) is null
     or pg_catalog.to_regprocedure('private.hub_service_role_required()') is null
     or pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception 'hub_abandoned_checkout_dependencies_missing';
  end if;
end;
$requirements$;

-- 1. Novo tipo de operação e o estado terminal ABORTED (nenhuma mutação, ou
--    pagamento confirmado no meio do caminho). ABORTED não está na lista
--    READY/IN_PROGRESS/BLOCKED que cerca os escritores do webhook.
do $constraints$
declare
  v_kind_def text;
  v_status_def text;
begin
  select pg_catalog.pg_get_constraintdef(constraint_row.oid) into v_kind_def
  from pg_catalog.pg_constraint as constraint_row
  where constraint_row.conrelid = 'private.hub_provider_operations'::regclass
    and constraint_row.conname = 'hub_provider_operations_operation_kind_check';
  if v_kind_def is null or pg_catalog.strpos(v_kind_def, 'ABANDONED_CHECKOUT') = 0 then
    alter table private.hub_provider_operations
      drop constraint if exists hub_provider_operations_operation_kind_check;
    alter table private.hub_provider_operations
      add constraint hub_provider_operations_operation_kind_check
      check (operation_kind in (
        'ACCOUNT_STATUS', 'CORE_CANCELLATION', 'WEBHOOK_CANCELLATION',
        'ABANDONED_CHECKOUT'
      ));
  end if;

  select pg_catalog.pg_get_constraintdef(constraint_row.oid) into v_status_def
  from pg_catalog.pg_constraint as constraint_row
  where constraint_row.conrelid = 'private.hub_provider_operations'::regclass
    and constraint_row.conname = 'hub_provider_operations_status_check';
  if v_status_def is null or pg_catalog.strpos(v_status_def, 'ABORTED') = 0 then
    alter table private.hub_provider_operations
      drop constraint if exists hub_provider_operations_status_check;
    alter table private.hub_provider_operations
      add constraint hub_provider_operations_status_check
      check (status in ('READY', 'IN_PROGRESS', 'SUCCEEDED', 'BLOCKED', 'ABORTED'));
  end if;
end;
$constraints$;

-- 2. A 1ª cobrança do checkout, removida explicitamente depois da assinatura.
--    Mesmo contrato de estados dos alvos de assinatura: SUBMITTING antes do
--    DELETE; depois disso, só GET decide.
create table if not exists private.hub_abandoned_checkout_payment_targets (
  operation_id uuid primary key
    references private.hub_provider_operations(id) on delete cascade,
  checkout_id uuid not null
    references public.hub_checkout_sessions(id) on delete restrict,
  provider_payment_id text not null
    check (pg_catalog.char_length(pg_catalog.btrim(provider_payment_id))
      between 1 and 200),
  provider_customer_id text
    check (provider_customer_id is null
      or pg_catalog.char_length(pg_catalog.btrim(provider_customer_id))
        between 1 and 200),
  provider_subscription_id text
    check (provider_subscription_id is null
      or pg_catalog.char_length(pg_catalog.btrim(provider_subscription_id))
        between 1 and 200),
  state text not null default 'READY'
    check (state in ('READY', 'SUBMITTING', 'CONFIRMED', 'ABSENT')),
  submission_token uuid,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  check (
    (state = 'READY' and submission_token is null and submitted_at is null)
    or (state <> 'READY' and submission_token is not null
      and submitted_at is not null)
  )
);

alter table private.hub_abandoned_checkout_payment_targets
  enable row level security;
alter table private.hub_abandoned_checkout_payment_targets owner to postgres;
revoke all on table private.hub_abandoned_checkout_payment_targets
  from public, anon, authenticated, service_role;

create index if not exists hub_abandoned_checkout_payment_targets_payment_idx
  on private.hub_abandoned_checkout_payment_targets (provider_payment_id);

-- Índice para a varredura: só checkouts ainda abertos.
create index if not exists hub_checkout_sessions_open_created_idx
  on public.hub_checkout_sessions (created_at)
  where status in ('CREATED', 'PENDING', 'OVERDUE');

-- 3. Regra de elegibilidade num lugar só. NULL = pode cancelar.
--    Tudo que não é prova de abandono vira motivo de bloqueio (conciliação
--    manual), nunca cancelamento por palpite.
create or replace function private.hub_abandoned_checkout_block_reason(
  p_checkout_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_checkout public.hub_checkout_sessions%rowtype;
  v_customer_id text;
begin
  select checkout.* into v_checkout
  from public.hub_checkout_sessions as checkout
  where checkout.id = p_checkout_id;
  if not found then
    return 'CHECKOUT_NOT_FOUND';
  end if;
  if v_checkout.product_family not in ('HUB_CORE', 'WOLFIE_STANDALONE') then
    return 'PRODUCT_FAMILY_UNSUPPORTED';
  end if;
  if v_checkout.status not in ('CREATED', 'PENDING', 'OVERDUE') then
    return 'CHECKOUT_NOT_OPEN';
  end if;
  -- Decisão do dono: PIX e boleto. Cartão recusado fica fora desta regra.
  if v_checkout.billing_type not in ('PIX', 'BOLETO') then
    return 'BILLING_TYPE_NOT_COVERED';
  end if;
  if v_checkout.created_at > pg_catalog.now() - interval '5 days' then
    return 'ABANDONMENT_WINDOW_NOT_REACHED';
  end if;
  -- Um único pagamento aplicado (inclusive renovação de um checkout que já
  -- foi pago e depois ficou OVERDUE) tira o checkout desta rotina.
  if exists (
    select 1
    from public.hub_subscription_payments as payment
    where payment.checkout_id = v_checkout.id
      and payment.status = 'APPLIED'
  ) then
    return 'PAYMENT_APPLIED';
  end if;
  if exists (
    select 1
    from public.hub_subscriptions as subscription
    where subscription.account_id = v_checkout.account_id
      and subscription.status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
      and (
        subscription.metadata ->> 'checkoutId' = v_checkout.id::text
        or (
          nullif(pg_catalog.btrim(v_checkout.asaas_subscription_id), '') is not null
          and subscription.provider_subscription_id = v_checkout.asaas_subscription_id
        )
      )
  ) then
    return 'LIVE_SUBSCRIPTION_BOUND';
  end if;
  if pg_catalog.jsonb_typeof(v_checkout.metadata -> 'requiresManualReconciliation') = 'boolean'
     and (v_checkout.metadata ->> 'requiresManualReconciliation')::boolean then
    return 'MANUAL_RECONCILIATION_REQUIRED';
  end if;
  -- Criação no provedor ainda ambígua (ou criada e não ligada ao checkout):
  -- pode existir uma assinatura no Asaas que este checkout não conhece.
  if exists (
    select 1
    from public.asaas_provider_creation_attempts as attempt
    where attempt.tenant_id = 'school-wise-wolf'
      and attempt.operation = 'SUBSCRIPTION_CREATE'
      and attempt.logical_key = 'hub-checkout:' || v_checkout.id::text
      and (
        attempt.status in ('CLAIMED', 'RETRY', 'SUBMITTING', 'UNKNOWN', 'BLOCKED')
        or (
          attempt.status = 'SUCCEEDED'
          and pg_catalog.btrim(coalesce(attempt.provider_entity_id, ''))
            is distinct from pg_catalog.btrim(coalesce(v_checkout.asaas_subscription_id, ''))
        )
      )
  ) then
    return 'PROVIDER_CREATION_RECONCILIATION_REQUIRED';
  end if;
  if v_checkout.status in ('PENDING', 'OVERDUE')
     and nullif(pg_catalog.btrim(v_checkout.asaas_subscription_id), '') is null then
    return 'SUBSCRIPTION_RECONCILIATION_REQUIRED';
  end if;
  if pg_catalog.char_length(coalesce(v_checkout.asaas_subscription_id, '')) > 200
     or pg_catalog.char_length(coalesce(v_checkout.asaas_payment_id, '')) > 200 then
    return 'SUBSCRIPTION_RECONCILIATION_REQUIRED';
  end if;
  if nullif(pg_catalog.btrim(v_checkout.asaas_subscription_id), '') is not null
     or nullif(pg_catalog.btrim(v_checkout.asaas_payment_id), '') is not null then
    select nullif(pg_catalog.btrim(account.asaas_customer_id), '')
      into v_customer_id
    from public.hub_accounts as account
    where account.id = v_checkout.account_id;
    if v_customer_id is null or pg_catalog.char_length(v_customer_id) > 200 then
      return 'CUSTOMER_RECONCILIATION_REQUIRED';
    end if;
  end if;
  return null;
end;
$function$;

-- 4. Lista o que a rotina deve olhar: operações abertas primeiro (retomada),
--    depois os elegíveis mais antigos; bloqueados vêm com o motivo.
create or replace function public.hub_list_abandoned_checkouts(
  p_limit integer default 10
)
returns table (checkout_id uuid, block_reason text, operation_open boolean)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.hub_service_role_required();
  return query
  with candidates as (
    select checkout.id,
      checkout.created_at,
      exists (
        select 1
        from private.hub_provider_operations as operation
        where operation.logical_key = 'ABANDONED_CHECKOUT:' || checkout.id::text
          and operation.status in ('READY', 'IN_PROGRESS', 'BLOCKED')
      ) as is_open
    from public.hub_checkout_sessions as checkout
    where checkout.status in ('CREATED', 'PENDING', 'OVERDUE')
      and checkout.product_family in ('HUB_CORE', 'WOLFIE_STANDALONE')
      and checkout.billing_type in ('PIX', 'BOLETO')
      and checkout.created_at <= pg_catalog.now() - interval '5 days'
      and not exists (
        select 1
        from private.hub_provider_operations as closed_operation
        where closed_operation.logical_key =
            'ABANDONED_CHECKOUT:' || checkout.id::text
          and closed_operation.status in ('SUCCEEDED', 'ABORTED')
      )
  ), classified as (
    select candidate.id,
      candidate.created_at,
      candidate.is_open,
      case when candidate.is_open then null
        else private.hub_abandoned_checkout_block_reason(candidate.id)
      end as reason
    from candidates as candidate
  )
  select classified.id, classified.reason, classified.is_open
  from classified
  order by classified.is_open desc,
    (classified.reason is null) desc,
    classified.created_at,
    classified.id
  -- least/greatest são formas especiais: sem prefixo pg_catalog.
  limit least(greatest(coalesce(p_limit, 10), 1), 25);
end;
$function$;

-- 5. Início (ou retomada) da operação de um checkout.
create or replace function public.hub_begin_abandoned_checkout_cancellation(
  p_checkout_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_account_id uuid;
  v_account public.hub_accounts%rowtype;
  v_checkout public.hub_checkout_sessions%rowtype;
  v_operation private.hub_provider_operations%rowtype;
  v_logical_key text;
  v_reason text;
  v_customer_id text;
  v_subscription_id text;
  v_payment_id text;
  v_snapshot jsonb;
begin
  perform private.hub_service_role_required();
  if p_checkout_id is null then
    raise exception 'invalid_hub_checkout' using errcode = '22023';
  end if;

  select checkout.account_id into v_account_id
  from public.hub_checkout_sessions as checkout
  where checkout.id = p_checkout_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'SKIPPED', 'reason', 'CHECKOUT_NOT_FOUND'
    );
  end if;

  -- Mesma ordem de travas das outras operações: advisory da conta, conta,
  -- checkout.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hub-provider-operation:' || v_account_id::text, 0)
  );
  select account.* into v_account
  from public.hub_accounts as account
  where account.id = v_account_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'SKIPPED', 'reason', 'ACCOUNT_NOT_FOUND'
    );
  end if;
  select checkout.* into v_checkout
  from public.hub_checkout_sessions as checkout
  where checkout.id = p_checkout_id
  for update;
  if not found or v_checkout.account_id is distinct from v_account_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'SKIPPED', 'reason', 'CHECKOUT_SCOPE_CHANGED'
    );
  end if;

  v_logical_key := 'ABANDONED_CHECKOUT:' || v_checkout.id::text;
  select operation.* into v_operation
  from private.hub_provider_operations as operation
  where operation.logical_key = v_logical_key
  for update;
  if found then
    if v_operation.status = 'SUCCEEDED' then
      return pg_catalog.jsonb_build_object(
        'ok', true, 'action', 'ALREADY_SUCCEEDED',
        'operationId', v_operation.id, 'leaseToken', v_operation.lease_token,
        'snapshot', v_operation.snapshot
      );
    end if;
    if v_operation.status = 'ABORTED' then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'action', 'SKIPPED', 'reason', 'PREVIOUSLY_ABORTED',
        'operationId', v_operation.id
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'action', 'RESUME',
      'operationId', v_operation.id, 'leaseToken', v_operation.lease_token,
      'status', v_operation.status, 'snapshot', v_operation.snapshot
    );
  end if;

  v_reason := private.hub_abandoned_checkout_block_reason(v_checkout.id);
  if v_reason is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'SKIPPED', 'reason', v_reason
    );
  end if;
  -- Outra mutação da conta em andamento: espera a próxima rodada em vez de
  -- intercalar snapshots.
  if exists (
    select 1
    from private.hub_provider_operations as operation
    where operation.account_id = v_account_id
      and operation.status in ('READY', 'IN_PROGRESS', 'BLOCKED')
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'SKIPPED',
      'reason', 'ACCOUNT_PROVIDER_OPERATION_IN_PROGRESS'
    );
  end if;

  v_customer_id := pg_catalog.btrim(v_account.asaas_customer_id);
  v_subscription_id := nullif(pg_catalog.btrim(v_checkout.asaas_subscription_id), '');
  v_payment_id := nullif(pg_catalog.btrim(v_checkout.asaas_payment_id), '');

  v_snapshot := pg_catalog.jsonb_build_object(
    'accountId', v_account.id,
    'operationKind', 'ABANDONED_CHECKOUT',
    'checkoutId', v_checkout.id,
    'checkoutStatus', v_checkout.status,
    'checkoutCreatedAt', v_checkout.created_at,
    'productFamily', v_checkout.product_family,
    'billingType', v_checkout.billing_type,
    'providerCustomerId', v_customer_id,
    'providerSubscriptionId', v_subscription_id,
    'providerPaymentId', v_payment_id,
    'targets', case when v_subscription_id is null then '[]'::jsonb
      else pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'providerSubscriptionId', v_subscription_id,
        'providerCustomerId', v_customer_id,
        'checkoutId', v_checkout.id
      ))
    end,
    'payment', case when v_payment_id is null then null
      else pg_catalog.jsonb_build_object(
        'providerPaymentId', v_payment_id,
        'providerCustomerId', v_customer_id,
        'providerSubscriptionId', v_subscription_id,
        'checkoutId', v_checkout.id
      )
    end
  );

  insert into private.hub_provider_operations (
    logical_key, operation_kind, account_id, actor_user_id, target_status,
    reason, snapshot, snapshot_hash
  ) values (
    v_logical_key, 'ABANDONED_CHECKOUT', v_account.id, null, 'CANCELLED',
    'ABANDONED_UNPAID', v_snapshot,
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(v_snapshot::text, 'UTF8'), 'sha256'),
      'hex'
    )
  ) returning * into v_operation;

  if v_subscription_id is not null then
    insert into private.hub_provider_operation_targets (
      operation_id, provider_subscription_id, provider_customer_id, checkout_id
    ) values (
      v_operation.id, v_subscription_id, v_customer_id, v_checkout.id
    );
  end if;
  if v_payment_id is not null then
    insert into private.hub_abandoned_checkout_payment_targets (
      operation_id, checkout_id, provider_payment_id, provider_customer_id,
      provider_subscription_id
    ) values (
      v_operation.id, v_checkout.id, v_payment_id, v_customer_id,
      v_subscription_id
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'action', 'STARTED',
    'operationId', v_operation.id, 'leaseToken', v_operation.lease_token,
    'status', v_operation.status, 'snapshot', v_operation.snapshot
  );
end;
$function$;

-- 6. Reconfere, sob as mesmas travas, que o checkout continua exatamente como
--    no snapshot e sem pagamento aplicado. Devolve NULL quando está tudo igual.
create or replace function private.hub_abandoned_checkout_operation_drift(
  p_operation_id uuid,
  p_lease_token uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_account_id uuid;
  v_operation private.hub_provider_operations%rowtype;
  v_checkout public.hub_checkout_sessions%rowtype;
begin
  perform private.hub_service_role_required();
  select operation.account_id into v_account_id
  from private.hub_provider_operations as operation
  where operation.id = p_operation_id;
  if not found then
    raise exception 'hub_provider_operation_claim_lost' using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hub-provider-operation:' || v_account_id::text, 0)
  );
  select operation.* into v_operation
  from private.hub_provider_operations as operation
  where operation.id = p_operation_id
  for update;
  if not found
     or v_operation.lease_token is distinct from p_lease_token
     or v_operation.operation_kind <> 'ABANDONED_CHECKOUT' then
    raise exception 'hub_provider_operation_claim_lost' using errcode = '55000';
  end if;
  if v_operation.status not in ('READY', 'IN_PROGRESS') then
    return 'OPERATION_CLOSED';
  end if;
  if v_operation.snapshot_hash is distinct from pg_catalog.encode(
       extensions.digest(pg_catalog.convert_to(v_operation.snapshot::text, 'UTF8'), 'sha256'),
       'hex'
     ) then
    raise exception 'hub_provider_operation_snapshot_corrupt' using errcode = '55000';
  end if;

  perform account.id
  from public.hub_accounts as account
  where account.id = v_operation.account_id
  for update;
  select checkout.* into v_checkout
  from public.hub_checkout_sessions as checkout
  where checkout.id = (v_operation.snapshot ->> 'checkoutId')::uuid
  for update;
  if not found
     or v_checkout.account_id is distinct from v_operation.account_id
     or v_checkout.status is distinct from (v_operation.snapshot ->> 'checkoutStatus')
     or nullif(pg_catalog.btrim(v_checkout.asaas_subscription_id), '')
       is distinct from (v_operation.snapshot ->> 'providerSubscriptionId')
     or nullif(pg_catalog.btrim(v_checkout.asaas_payment_id), '')
       is distinct from (v_operation.snapshot ->> 'providerPaymentId') then
    return 'CHECKOUT_CHANGED';
  end if;
  if exists (
    select 1
    from public.hub_subscription_payments as payment
    where payment.checkout_id = v_checkout.id
      and payment.status = 'APPLIED'
  ) then
    return 'PAYMENT_APPLIED';
  end if;
  return null;
end;
$function$;

-- 7. Encerramento sem cancelar: nenhuma mutação aconteceu (ou o pagamento foi
--    confirmado no provedor). Libera a cerca dos escritores do webhook e deixa
--    a prova no checkout para conciliação manual.
create or replace function private.hub_abort_abandoned_checkout_internal(
  p_operation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation private.hub_provider_operations%rowtype;
  v_reason text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_reason, '')));
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_reason not in (
    'PAYMENT_SETTLED_AT_PROVIDER', 'PAYMENT_SETTLED_DURING_CANCELLATION',
    'PROVIDER_SUBSCRIPTION_REVIEW', 'PROVIDER_PAYMENT_REVIEW',
    'CHECKOUT_CHANGED', 'PAYMENT_APPLIED'
  ) then
    raise exception 'invalid_hub_abandoned_checkout_abort_reason' using errcode = '22023';
  end if;
  select operation.* into v_operation
  from private.hub_provider_operations as operation
  where operation.id = p_operation_id
  for update;
  if not found or v_operation.operation_kind <> 'ABANDONED_CHECKOUT' then
    raise exception 'hub_provider_operation_claim_lost' using errcode = '55000';
  end if;
  if v_operation.status = 'ABORTED' then
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'ABORTED',
      'idempotent', true, 'operationId', v_operation.id);
  end if;
  if v_operation.status not in ('READY', 'IN_PROGRESS') then
    raise exception 'hub_abandoned_checkout_operation_closed' using errcode = '55000';
  end if;
  -- Um DELETE de assinatura com resultado desconhecido nunca é abandonado:
  -- só um GET pode encerrar esse alvo.
  if exists (
    select 1
    from private.hub_provider_operation_targets as target
    where target.operation_id = v_operation.id
      and target.state = 'SUBMITTING'
  ) then
    raise exception 'hub_abandoned_checkout_abort_blocked_by_submission'
      using errcode = '55000';
  end if;
  -- A cobrança com DELETE em aberto só pode ser encerrada pela prova de que
  -- ela foi paga.
  if exists (
    select 1
    from private.hub_abandoned_checkout_payment_targets as payment_target
    where payment_target.operation_id = v_operation.id
      and payment_target.state = 'SUBMITTING'
  ) and v_reason <> 'PAYMENT_SETTLED_DURING_CANCELLATION' then
    raise exception 'hub_abandoned_checkout_abort_blocked_by_submission'
      using errcode = '55000';
  end if;

  update private.hub_provider_operations as operation
  set status = 'ABORTED',
      completed_at = coalesce(operation.completed_at, v_now),
      updated_at = v_now
  where operation.id = v_operation.id;

  update public.hub_checkout_sessions as checkout
  set metadata = coalesce(checkout.metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'abandonedCancellationAbortedAt', v_now,
          'abandonedCancellationAbortReason', v_reason,
          'abandonedCancellationOperationId', v_operation.id,
          'requiresManualReconciliation', true
        ),
      updated_at = v_now
  where checkout.id = (v_operation.snapshot ->> 'checkoutId')::uuid;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'action', 'ABORTED', 'idempotent', false,
    'operationId', v_operation.id, 'reason', v_reason
  );
end;
$function$;

create or replace function public.hub_abort_abandoned_checkout_cancellation(
  p_operation_id uuid,
  p_lease_token uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_drift text;
begin
  v_drift := private.hub_abandoned_checkout_operation_drift(
    p_operation_id, p_lease_token
  );
  if v_drift = 'OPERATION_CLOSED' then
    if exists (
      select 1 from private.hub_provider_operations as operation
      where operation.id = p_operation_id and operation.status = 'ABORTED'
    ) then
      return pg_catalog.jsonb_build_object('ok', true, 'action', 'ABORTED',
        'idempotent', true, 'operationId', p_operation_id);
    end if;
    raise exception 'hub_abandoned_checkout_operation_closed' using errcode = '55000';
  end if;
  return private.hub_abort_abandoned_checkout_internal(p_operation_id, p_reason);
end;
$function$;

-- 8. Antes do DELETE da assinatura: reconfere o checkout e só então passa pelo
--    limite único de DELETE das operações do Hub.
create or replace function public.hub_mark_abandoned_checkout_subscription_submitting(
  p_operation_id uuid,
  p_lease_token uuid,
  p_provider_subscription_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_drift text;
begin
  v_drift := private.hub_abandoned_checkout_operation_drift(
    p_operation_id, p_lease_token
  );
  if v_drift = 'OPERATION_CLOSED' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'OPERATION_CLOSED'
    );
  end if;
  if v_drift is not null then
    return private.hub_abort_abandoned_checkout_internal(p_operation_id, v_drift)
      || pg_catalog.jsonb_build_object('ok', false);
  end if;
  return public.hub_mark_provider_cancellation_submitting(
    p_operation_id, p_lease_token, p_provider_subscription_id
  );
end;
$function$;

-- 9. DELETE da 1ª cobrança: só depois de todas as assinaturas comprovadamente
--    encerradas, e no máximo uma vez por cobrança.
create or replace function public.hub_mark_abandoned_checkout_payment_submitting(
  p_operation_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_drift text;
  v_target private.hub_abandoned_checkout_payment_targets%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  v_drift := private.hub_abandoned_checkout_operation_drift(
    p_operation_id, p_lease_token
  );
  if v_drift = 'OPERATION_CLOSED' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'OPERATION_CLOSED'
    );
  end if;
  if v_drift is not null then
    return private.hub_abort_abandoned_checkout_internal(p_operation_id, v_drift)
      || pg_catalog.jsonb_build_object('ok', false);
  end if;
  if exists (
    select 1
    from private.hub_provider_operation_targets as target
    where target.operation_id = p_operation_id
      and target.state not in ('CONFIRMED', 'ABSENT')
  ) then
    raise exception 'hub_abandoned_checkout_subscription_pending'
      using errcode = '55000';
  end if;

  select payment_target.* into v_target
  from private.hub_abandoned_checkout_payment_targets as payment_target
  where payment_target.operation_id = p_operation_id;
  if not found then
    raise exception 'hub_provider_target_not_found' using errcode = 'P0002';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-payment-delete:' || v_target.provider_payment_id, 0
    )
  );
  select payment_target.* into v_target
  from private.hub_abandoned_checkout_payment_targets as payment_target
  where payment_target.operation_id = p_operation_id
  for update;
  if v_target.state in ('CONFIRMED', 'ABSENT') then
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'ALREADY_SUCCEEDED');
  end if;
  if v_target.state = 'SUBMITTING' then
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'RECONCILE_ONLY');
  end if;
  -- Outra operação (de outro checkout) já tocou esta mesma cobrança: prova
  -- de identidade conflitante, nunca permissão para um segundo DELETE.
  if exists (
    select 1
    from private.hub_abandoned_checkout_payment_targets as other_target
    where other_target.provider_payment_id = v_target.provider_payment_id
      and other_target.operation_id <> v_target.operation_id
      and other_target.state <> 'READY'
  ) then
    raise exception 'hub_provider_payment_target_conflict' using errcode = '55000';
  end if;

  update private.hub_abandoned_checkout_payment_targets as payment_target
  set state = 'SUBMITTING',
      submission_token = pg_catalog.gen_random_uuid(),
      submitted_at = v_now,
      updated_at = v_now
  where payment_target.operation_id = p_operation_id;
  update private.hub_provider_operations as operation
  set status = 'IN_PROGRESS', updated_at = v_now
  where operation.id = p_operation_id;
  return pg_catalog.jsonb_build_object('ok', true, 'action', 'SUBMIT_ALLOWED');
end;
$function$;

create or replace function public.hub_complete_abandoned_checkout_payment(
  p_operation_id uuid,
  p_lease_token uuid,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_outcome text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_outcome, '')));
  v_target private.hub_abandoned_checkout_payment_targets%rowtype;
  v_state text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform private.hub_service_role_required();
  if v_outcome not in ('CONFIRMED', 'ABSENT') then
    raise exception 'invalid_hub_provider_target_outcome' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from private.hub_provider_operations as operation
    where operation.id = p_operation_id
      and operation.lease_token = p_lease_token
      and operation.operation_kind = 'ABANDONED_CHECKOUT'
  ) then
    raise exception 'hub_provider_operation_claim_lost' using errcode = '55000';
  end if;
  select payment_target.* into v_target
  from private.hub_abandoned_checkout_payment_targets as payment_target
  where payment_target.operation_id = p_operation_id;
  if not found then
    raise exception 'hub_provider_target_not_found' using errcode = 'P0002';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-payment-delete:' || v_target.provider_payment_id, 0
    )
  );
  -- Estado terminal já gravado prevalece (retentativa idempotente).
  update private.hub_abandoned_checkout_payment_targets as payment_target
  set state = case
        when payment_target.state in ('CONFIRMED', 'ABSENT')
          then payment_target.state
        else v_outcome
      end,
      submission_token = coalesce(payment_target.submission_token, pg_catalog.gen_random_uuid()),
      submitted_at = coalesce(payment_target.submitted_at, v_now),
      confirmed_at = coalesce(payment_target.confirmed_at, v_now),
      updated_at = v_now
  where payment_target.operation_id = p_operation_id
    and (
      payment_target.state in ('SUBMITTING', 'CONFIRMED', 'ABSENT')
      or (payment_target.state = 'READY' and v_outcome = 'ABSENT')
    )
  returning payment_target.state into v_state;
  if v_state is null then
    raise exception 'hub_provider_target_completion_rejected' using errcode = '55000';
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'state', v_state);
end;
$function$;

-- 10. Finalização: com assinatura e cobrança comprovadamente encerradas no
--     provedor, o checkout vira CANCELLED (ABANDONED_UNPAID) e as entregas
--     WAITING_PAYMENT são encerradas sem envio, tudo na mesma transação.
create or replace function public.hub_finalize_abandoned_checkout_cancellation(
  p_operation_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation private.hub_provider_operations%rowtype;
  v_checkout public.hub_checkout_sessions%rowtype;
  v_payment_state text;
  v_drift text;
  v_closed_deliveries integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  -- Prova genérica: hash do snapshot, todos os alvos de assinatura
  -- CONFIRMED/ABSENT e cada checkout do snapshot ainda ligado à assinatura.
  v_operation := private.hub_assert_provider_operation_complete(
    p_operation_id, p_lease_token
  );
  if v_operation.operation_kind <> 'ABANDONED_CHECKOUT' then
    raise exception 'invalid_hub_provider_operation' using errcode = '55000';
  end if;
  if v_operation.status = 'SUCCEEDED' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'idempotent', true, 'operationId', v_operation.id,
      'checkoutId', v_operation.snapshot ->> 'checkoutId'
    );
  end if;
  if v_operation.status = 'ABORTED' then
    raise exception 'hub_abandoned_checkout_operation_aborted' using errcode = '55000';
  end if;

  select payment_target.state into v_payment_state
  from private.hub_abandoned_checkout_payment_targets as payment_target
  where payment_target.operation_id = v_operation.id;
  if found and v_payment_state not in ('CONFIRMED', 'ABSENT') then
    raise exception 'hub_provider_cancellation_not_confirmed' using errcode = '55000';
  end if;

  v_drift := private.hub_abandoned_checkout_operation_drift(
    p_operation_id, p_lease_token
  );
  if v_drift is not null then
    -- Depois de DELETE no provedor não há como "desfazer": a divergência é
    -- deixada para conciliação manual, com a operação ainda aberta.
    raise exception 'hub_provider_operation_scope_changed' using errcode = '55000';
  end if;

  select checkout.* into v_checkout
  from public.hub_checkout_sessions as checkout
  where checkout.id = (v_operation.snapshot ->> 'checkoutId')::uuid
  for update;

  update public.hub_fulfillment_outbox as delivery
  set status = 'SKIPPED',
      lease_token = null,
      lease_expires_at = null,
      provider_dispatch_started_at = null,
      last_error = 'checkout_abandoned_unpaid',
      completed_at = v_now,
      updated_at = v_now
  where delivery.checkout_id = v_checkout.id
    and delivery.status = 'WAITING_PAYMENT';
  get diagnostics v_closed_deliveries = row_count;

  update public.hub_checkout_sessions as checkout
  set status = 'CANCELLED',
      metadata = coalesce(checkout.metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'cancellationReason', 'ABANDONED_UNPAID',
          'abandonedCancelledAt', v_now,
          'abandonedCancellationOperationId', v_operation.id,
          'abandonedPreviousStatus', v_checkout.status,
          'providerSubscriptionCancelled',
            pg_catalog.jsonb_array_length(v_operation.snapshot -> 'targets') > 0,
          'providerPaymentRemoved', v_payment_state is not null
        ),
      updated_at = v_now
  where checkout.id = v_checkout.id;

  insert into public.hub_conversion_events (
    account_id, user_id, event_name, source, metadata
  ) values (
    v_checkout.account_id,
    v_checkout.requested_by,
    case when v_checkout.product_family = 'WOLFIE_STANDALONE'
      then 'wolfie_checkout_abandoned'
      else 'hub_checkout_abandoned'
    end,
    'hub_abandoned_checkout_cleanup',
    pg_catalog.jsonb_build_object(
      'checkoutId', v_checkout.id,
      'operationId', v_operation.id,
      'previousStatus', v_checkout.status,
      'billingType', v_checkout.billing_type
    )
  );

  update private.hub_provider_operations as operation
  set status = 'SUCCEEDED',
      completed_at = coalesce(operation.completed_at, v_now),
      updated_at = v_now
  where operation.id = v_operation.id
    and operation.status <> 'SUCCEEDED';

  return pg_catalog.jsonb_build_object(
    'ok', true, 'idempotent', false, 'operationId', v_operation.id,
    'checkoutId', v_checkout.id, 'status', 'CANCELLED',
    'closedDeliveries', v_closed_deliveries
  );
end;
$function$;

-- 11. Escritores do webhook. A cerca continua a mesma (hub_lock_provider_
--     event_writer). Para o checkout cancelado por abandono:
--     - pagamento confirmado: NUNCA ativa; grava a prova para conciliação
--       manual (o cliente pagou e precisa de contato/estorno) e responde
--       applied=false, que o webhook já trata como "não liberar";
--     - exclusão/estorno da 1ª cobrança: não há o que estornar (nada foi
--       aplicado); o checkout continua CANCELLED em vez de virar REVERSED, e
--       o Wolfie não suspende o aluno por uma cobrança que nunca valeu.
create or replace function private.hub_checkout_is_abandoned_unpaid(
  p_checkout_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.hub_checkout_sessions as checkout
    where checkout.id = p_checkout_id
      and checkout.status = 'CANCELLED'
      and checkout.metadata ->> 'cancellationReason' = 'ABANDONED_UNPAID'
      and not exists (
        select 1
        from public.hub_subscription_payments as payment
        where payment.checkout_id = checkout.id
          and payment.status = 'APPLIED'
      )
  );
$function$;

create or replace function public.hub_activate_paid_checkout(
  p_checkout_id uuid,
  p_payment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_account_id uuid;
  v_checkout public.hub_checkout_sessions%rowtype;
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_already_recorded boolean;
begin
  v_account_id := private.hub_lock_provider_event_writer(p_checkout_id);

  if private.hub_checkout_is_abandoned_unpaid(p_checkout_id) then
    if v_payment_id is null or pg_catalog.char_length(v_payment_id) > 200 then
      raise exception 'invalid_hub_payment' using errcode = '22023';
    end if;
    select checkout.* into v_checkout
    from public.hub_checkout_sessions as checkout
    where checkout.id = p_checkout_id
    for update;
    -- Sem a chave, a comparação dá NULL: decide o nulo explicitamente.
    v_already_recorded := coalesce(
      v_checkout.metadata ->> 'paymentAfterAbandonmentId' = v_payment_id,
      false
    );
    if not v_already_recorded then
      update public.hub_checkout_sessions as checkout
      set metadata = coalesce(checkout.metadata, '{}'::jsonb)
            || pg_catalog.jsonb_build_object(
              'paymentAfterAbandonmentId', v_payment_id,
              'paymentAfterAbandonmentObservedAt', pg_catalog.now(),
              'requiresManualReconciliation', true
            ),
          updated_at = pg_catalog.now()
      where checkout.id = v_checkout.id;
      insert into public.hub_conversion_events (
        account_id, user_id, event_name, source, metadata
      ) values (
        v_checkout.account_id,
        v_checkout.requested_by,
        case when v_checkout.product_family = 'WOLFIE_STANDALONE'
          then 'wolfie_payment_after_abandonment'
          else 'hub_payment_after_abandonment'
        end,
        'asaas_webhook',
        pg_catalog.jsonb_build_object(
          'checkoutId', v_checkout.id,
          'paymentId', v_payment_id,
          'requiresManualReconciliation', true
        )
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'accountId', v_checkout.account_id,
      'subscriptionId', null,
      'status', 'CANCELLED',
      'idempotent', v_already_recorded,
      'applied', false,
      'abandonedUnpaid', true,
      'requiresManualReconciliation', true
    );
  end if;

  if not exists (
    select 1
    from public.hub_accounts account
    where account.id = v_account_id
      and account.status = 'ACTIVE'
  ) then
    raise exception 'hub_account_inactive' using errcode = '55000';
  end if;
  return private.hub_activate_paid_checkout_provider_apply(
    p_checkout_id,
    p_payment_id
  );
end;
$function$;

create or replace function public.hub_reverse_paid_checkout(
  p_checkout_id uuid,
  p_payment_id text,
  p_event_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.hub_lock_provider_event_writer(p_checkout_id);
  if private.hub_checkout_is_abandoned_unpaid(p_checkout_id) then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'ignored', true,
      'status', 'CANCELLED',
      'reason', 'ABANDONED_UNPAID_NOTHING_TO_REVERSE'
    );
  end if;
  return private.hub_reverse_paid_checkout_provider_apply(
    p_checkout_id,
    p_payment_id,
    p_event_name
  );
end;
$function$;

-- 12. Gatilho do cron (padrão trigger_*): chave de serviço do vault + pg_net.
create or replace function public.trigger_hub_abandoned_checkout_cleanup()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_request_id bigint;
begin
  select secret.decrypted_secret
  into v_service_key
  from vault.decrypted_secrets as secret
  where secret.name = 'wisewolf_service_role_key'
  limit 1;

  if v_service_key is null or v_service_key = '' then
    raise warning 'wisewolf_service_role_key is not configured';
    return -1;
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/expire-hub-abandoned-checkouts',
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end;
$function$;

-- Donos e permissões: tudo do postgres, só service_role executa as RPCs.
alter function private.hub_abandoned_checkout_block_reason(uuid) owner to postgres;
alter function public.hub_list_abandoned_checkouts(integer) owner to postgres;
alter function public.hub_begin_abandoned_checkout_cancellation(uuid) owner to postgres;
alter function private.hub_abandoned_checkout_operation_drift(uuid,uuid) owner to postgres;
alter function private.hub_abort_abandoned_checkout_internal(uuid,text) owner to postgres;
alter function public.hub_abort_abandoned_checkout_cancellation(uuid,uuid,text) owner to postgres;
alter function public.hub_mark_abandoned_checkout_subscription_submitting(uuid,uuid,text) owner to postgres;
alter function public.hub_mark_abandoned_checkout_payment_submitting(uuid,uuid) owner to postgres;
alter function public.hub_complete_abandoned_checkout_payment(uuid,uuid,text) owner to postgres;
alter function public.hub_finalize_abandoned_checkout_cancellation(uuid,uuid) owner to postgres;
alter function private.hub_checkout_is_abandoned_unpaid(uuid) owner to postgres;
alter function public.hub_activate_paid_checkout(uuid,text) owner to postgres;
alter function public.hub_reverse_paid_checkout(uuid,text,text) owner to postgres;
alter function public.trigger_hub_abandoned_checkout_cleanup() owner to postgres;

revoke all on function private.hub_abandoned_checkout_block_reason(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_abandoned_checkout_operation_drift(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_abort_abandoned_checkout_internal(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_checkout_is_abandoned_unpaid(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.hub_list_abandoned_checkouts(integer)
  from public, anon, authenticated;
revoke all on function public.hub_begin_abandoned_checkout_cancellation(uuid)
  from public, anon, authenticated;
revoke all on function public.hub_abort_abandoned_checkout_cancellation(uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.hub_mark_abandoned_checkout_subscription_submitting(uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.hub_mark_abandoned_checkout_payment_submitting(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.hub_complete_abandoned_checkout_payment(uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.hub_finalize_abandoned_checkout_cancellation(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.hub_activate_paid_checkout(uuid,text)
  from public, anon, authenticated;
revoke all on function public.hub_reverse_paid_checkout(uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.trigger_hub_abandoned_checkout_cleanup()
  from public, anon, authenticated;

grant execute on function public.hub_list_abandoned_checkouts(integer) to service_role;
grant execute on function public.hub_begin_abandoned_checkout_cancellation(uuid) to service_role;
grant execute on function public.hub_abort_abandoned_checkout_cancellation(uuid,uuid,text) to service_role;
grant execute on function public.hub_mark_abandoned_checkout_subscription_submitting(uuid,uuid,text) to service_role;
grant execute on function public.hub_mark_abandoned_checkout_payment_submitting(uuid,uuid) to service_role;
grant execute on function public.hub_complete_abandoned_checkout_payment(uuid,uuid,text) to service_role;
grant execute on function public.hub_finalize_abandoned_checkout_cancellation(uuid,uuid) to service_role;
grant execute on function public.hub_activate_paid_checkout(uuid,text) to service_role;
grant execute on function public.hub_reverse_paid_checkout(uuid,text,text) to service_role;
grant execute on function public.trigger_hub_abandoned_checkout_cleanup() to service_role;

-- 13. A cada hora (minuto 17, fora do pico dos outros crons do Hub).
do $cron$
begin
  if exists (
    select 1 from cron.job
    where jobname = 'wisewolf-hub-abandoned-checkouts'
  ) then
    perform cron.unschedule('wisewolf-hub-abandoned-checkouts');
  end if;
  perform cron.schedule(
    'wisewolf-hub-abandoned-checkouts',
    '17 * * * *',
    'select public.trigger_hub_abandoned_checkout_cleanup();'
  );
end;
$cron$;

comment on table private.hub_abandoned_checkout_payment_targets is
  'Primeira cobrança de um checkout do Hub abandonado; DELETE no máximo uma vez, retentativa só com GET.';
comment on function public.hub_begin_abandoned_checkout_cancellation(uuid) is
  'Abre (ou retoma) a operação durável que cancela no Asaas um checkout PIX/boleto sem pagamento há mais de 5 dias.';
comment on function public.hub_finalize_abandoned_checkout_cancellation(uuid,uuid) is
  'Com assinatura e 1ª cobrança comprovadamente encerradas, marca o checkout CANCELLED (ABANDONED_UNPAID) e fecha as entregas sem enviar.';
