-- Durable, snapshot-bound Hub provider mutations and atomic checkout writes.
--
-- A provider DELETE has an ambiguous outcome when the network fails after the
-- request left this system.  Each target therefore moves READY -> SUBMITTING
-- before the HTTP request.  A later invocation sees RECONCILE_ONLY and may
-- only prove the terminal provider state with GET; it cannot submit DELETE a
-- second time.

do $requirements$
begin
  if pg_catalog.to_regclass('public.hub_accounts') is null
     or pg_catalog.to_regclass('public.hub_checkout_sessions') is null
     or pg_catalog.to_regclass('public.hub_subscriptions') is null
     or pg_catalog.to_regclass(
       'public.asaas_provider_creation_attempts'
     ) is null
     or pg_catalog.to_regclass('public.wolfie_topup_orders') is null
     or pg_catalog.to_regprocedure(
       'extensions.digest(bytea,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.hub_finalize_account_status_internal(uuid,text,text[],uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.hub_begin_core_cancellation_internal(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.hub_schedule_core_cancellation_internal(uuid,uuid,text[])'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.mark_asaas_provider_creation_submitting(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hub_activate_paid_checkout(uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hub_reverse_paid_checkout(uuid,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.hub_mark_checkout_overdue(uuid,text)'
     ) is null then
    raise exception 'hub_provider_operation_dependencies_missing';
  end if;
end;
$requirements$;

create table if not exists private.hub_provider_operations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  logical_key text not null unique,
  operation_kind text not null
    check (operation_kind in (
      'ACCOUNT_STATUS', 'CORE_CANCELLATION', 'WEBHOOK_CANCELLATION'
    )),
  account_id uuid not null references public.hub_accounts(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete restrict,
  target_status text,
  reason text,
  snapshot jsonb not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'READY'
    check (status in ('READY', 'IN_PROGRESS', 'SUCCEEDED', 'BLOCKED')),
  lease_token uuid not null default pg_catalog.gen_random_uuid(),
  integration_id uuid,
  integration_version bigint,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  check (pg_catalog.jsonb_typeof(snapshot) = 'object'),
  check (
    (integration_id is null and integration_version is null)
    or (integration_id is not null and integration_version is not null
        and integration_version > 0)
  )
);

create table if not exists private.hub_provider_operation_targets (
  operation_id uuid not null
    references private.hub_provider_operations(id) on delete cascade,
  provider_subscription_id text not null
    check (pg_catalog.char_length(pg_catalog.btrim(provider_subscription_id))
      between 1 and 200),
  provider_customer_id text not null
    check (pg_catalog.char_length(pg_catalog.btrim(provider_customer_id))
      between 1 and 200),
  checkout_id uuid not null references public.hub_checkout_sessions(id)
    on delete restrict,
  state text not null default 'READY'
    check (state in ('READY', 'SUBMITTING', 'CONFIRMED', 'ABSENT', 'REVIEW_REQUIRED')),
  submission_token uuid,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (operation_id, provider_subscription_id),
  unique (operation_id, checkout_id),
  check (
    (state = 'READY' and submission_token is null and submitted_at is null)
    or (state <> 'READY' and submission_token is not null and submitted_at is not null)
  )
);

create unique index if not exists hub_provider_one_open_operation_idx
  on private.hub_provider_operations (account_id, operation_kind)
  where status in ('READY', 'IN_PROGRESS')
    and operation_kind in ('ACCOUNT_STATUS', 'CORE_CANCELLATION');

create index if not exists hub_provider_targets_provider_state_idx
  on private.hub_provider_operation_targets (
    provider_subscription_id,
    state,
    updated_at desc
  );

alter table private.hub_provider_operations enable row level security;
alter table private.hub_provider_operation_targets enable row level security;
revoke all on table private.hub_provider_operations
  from public, anon, authenticated, service_role;
revoke all on table private.hub_provider_operation_targets
  from public, anon, authenticated, service_role;

create or replace function private.hub_provider_operation_snapshot_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.logical_key is distinct from old.logical_key
     or new.operation_kind is distinct from old.operation_kind
     or new.account_id is distinct from old.account_id
     or new.actor_user_id is distinct from old.actor_user_id
     or new.target_status is distinct from old.target_status
     or new.reason is distinct from old.reason
     or new.snapshot is distinct from old.snapshot
     or new.snapshot_hash is distinct from old.snapshot_hash then
    raise exception 'hub_provider_operation_snapshot_immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_hub_provider_operation_snapshot_immutable
  on private.hub_provider_operations;
create trigger trg_hub_provider_operation_snapshot_immutable
before update on private.hub_provider_operations
for each row execute function
  private.hub_provider_operation_snapshot_immutable();

create or replace function private.hub_provider_target_identity_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.operation_id is distinct from old.operation_id
     or new.provider_subscription_id is distinct from
       old.provider_subscription_id
     or new.provider_customer_id is distinct from old.provider_customer_id
     or new.checkout_id is distinct from old.checkout_id then
    raise exception 'hub_provider_target_identity_immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_hub_provider_target_identity_immutable
  on private.hub_provider_operation_targets;
create trigger trg_hub_provider_target_identity_immutable
before update on private.hub_provider_operation_targets
for each row execute function
  private.hub_provider_target_identity_immutable();

create or replace function private.hub_service_role_required()
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
end;
$function$;

-- Generic semantic account-lifecycle fence. Hub checkout creations and
-- wolfie-direct top-up creations bind their own local entity, but share the
-- exact advisory lock used by provider cancellation begin/finalize.
create or replace function public.hub_mark_account_provider_creation_submitting(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_account_id uuid,
  p_entity_kind text,
  p_entity_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_entity_kind text := pg_catalog.upper(pg_catalog.btrim(
    coalesce(p_entity_kind, '')
  ));
  v_attempt public.asaas_provider_creation_attempts%rowtype;
  v_account public.hub_accounts%rowtype;
  v_checkout public.hub_checkout_sessions%rowtype;
  v_topup public.wolfie_topup_orders%rowtype;
  v_result jsonb;
begin
  perform private.hub_service_role_required();
  if p_attempt_id is null or p_claim_token is null or p_account_id is null
     or p_entity_id is null
     or v_entity_kind not in ('HUB_CHECKOUT', 'WOLFIE_TOPUP_ORDER') then
    raise exception 'invalid_hub_provider_creation_fence'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-operation:' || p_account_id::text,
      0
    )
  );

  select account.* into v_account
  from public.hub_accounts as account
  where account.id = p_account_id
  for update;
  if not found or v_account.status <> 'ACTIVE' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'account_lifecycle_fenced'
    );
  end if;

  select attempt.* into v_attempt
  from public.asaas_provider_creation_attempts as attempt
  where attempt.id = p_attempt_id
    and attempt.claim_token = p_claim_token
  for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'creation_scope_changed'
    );
  end if;

  if v_entity_kind = 'HUB_CHECKOUT' then
    select checkout.* into v_checkout
    from public.hub_checkout_sessions as checkout
    where checkout.id = p_entity_id
      and checkout.account_id = p_account_id
      and checkout.status in ('CREATED', 'PENDING')
    for update;
    if not found
       or v_attempt.tenant_id <> 'school-wise-wolf'
       or v_attempt.operation not in (
         'CUSTOMER_CREATE', 'SUBSCRIPTION_CREATE'
       )
       or (
         v_attempt.operation = 'CUSTOMER_CREATE'
         and (
           v_attempt.logical_key <>
             'hub-account:' || p_account_id::text
           or v_attempt.external_reference <>
             'hub-account:' || p_account_id::text
           or nullif(pg_catalog.btrim(v_account.asaas_customer_id), '')
             is not null
         )
       )
       or (
         v_attempt.operation = 'SUBSCRIPTION_CREATE'
         and (
           v_attempt.logical_key <>
             'hub-checkout:' || p_entity_id::text
           or v_attempt.external_reference <> 'hub:' || p_entity_id::text
           or v_checkout.asaas_subscription_id is not null
           or nullif(pg_catalog.btrim(v_account.asaas_customer_id), '')
             is null
         )
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'creation_scope_changed'
      );
    end if;
  else
    select topup.* into v_topup
    from public.wolfie_topup_orders as topup
    where topup.id = p_entity_id
      and topup.tenant_id = 'wolfie-direct'
      and topup.status in ('PENDING', 'CREATING')
      and topup.provider_payment_id is null
    for update;
    if not found
       or v_account.account_type <> 'PERSONAL'
       or v_account.owner_user_id is distinct from v_topup.student_id
       or not exists (
         select 1
         from public.hub_memberships as membership
         where membership.account_id = p_account_id
           and membership.user_id = v_topup.student_id
           and membership.membership_role = 'OWNER'
           and membership.status = 'ACTIVE'
       )
       or v_attempt.tenant_id <> 'wolfie-direct'
       or v_attempt.operation <> 'PAYMENT_CREATE'
       or v_attempt.logical_key <> p_entity_id::text
       or v_attempt.external_reference <>
         'wolfie-topup-order:' || p_entity_id::text
       or nullif(pg_catalog.btrim(v_account.asaas_customer_id), '') is null then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'creation_scope_changed'
      );
    end if;
  end if;

  if exists (
    select 1
    from private.hub_provider_operations as operation
    where operation.account_id = p_account_id
      and operation.status in ('READY', 'IN_PROGRESS', 'BLOCKED')
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'account_lifecycle_fenced'
    );
  end if;

  v_result := public.mark_asaas_provider_creation_submitting(
    p_attempt_id,
    p_claim_token
  );
  if coalesce((v_result ->> 'ok')::boolean, false) is not true then
    return coalesce(v_result, '{}'::jsonb) ||
      pg_catalog.jsonb_build_object('ok', false);
  end if;
  return v_result || pg_catalog.jsonb_build_object(
    'accountId', p_account_id,
    'entityKind', v_entity_kind,
    'entityId', p_entity_id
  );
end;
$function$;

-- Compatibility wrapper used by create-hub-checkout. The semantic generic
-- RPC above is also available to wolfie-direct top-up without coupling that
-- function to Hub checkout rows.
create or replace function public.hub_mark_provider_creation_submitting(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_account_id uuid,
  p_checkout_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select public.hub_mark_account_provider_creation_submitting(
    p_attempt_id,
    p_claim_token,
    p_account_id,
    'HUB_CHECKOUT',
    p_checkout_id
  );
$function$;

-- Atomically adopts a GET-proven provider customer/subscription and its local
-- binding. Recovery never records SUCCEEDED before it owns the same account
-- lifecycle fence used by cancellation.
create or replace function public.hub_adopt_provider_creation_binding(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_account_id uuid,
  p_checkout_id uuid,
  p_provider_entity_id text,
  p_provider_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_provider_id text := nullif(pg_catalog.btrim(p_provider_entity_id), '');
  v_provider_status text := nullif(pg_catalog.btrim(p_provider_status), '');
  v_attempt public.asaas_provider_creation_attempts%rowtype;
  v_account public.hub_accounts%rowtype;
  v_checkout public.hub_checkout_sessions%rowtype;
  v_recorded jsonb;
begin
  perform private.hub_service_role_required();
  if p_attempt_id is null or p_account_id is null or p_checkout_id is null
     or v_provider_id is null
     or pg_catalog.char_length(v_provider_id) > 200 then
    raise exception 'invalid_hub_provider_creation_adoption'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-operation:' || p_account_id::text,
      0
    )
  );

  select account.* into v_account
  from public.hub_accounts as account
  where account.id = p_account_id
  for update;
  select checkout.* into v_checkout
  from public.hub_checkout_sessions as checkout
  where checkout.id = p_checkout_id
    and checkout.account_id = p_account_id
  for update;
  select attempt.* into v_attempt
  from public.asaas_provider_creation_attempts as attempt
  where attempt.id = p_attempt_id
  for update;
  if v_account.id is null or v_account.status <> 'ACTIVE'
     or v_checkout.id is null
     or v_checkout.status not in ('CREATED', 'PENDING')
     or v_attempt.id is null
     or v_attempt.tenant_id <> 'school-wise-wolf'
     or v_attempt.operation not in (
       'CUSTOMER_CREATE', 'SUBSCRIPTION_CREATE'
     )
     or exists (
       select 1
       from private.hub_provider_operations as operation
       where operation.account_id = p_account_id
         and operation.status in ('READY', 'IN_PROGRESS', 'BLOCKED')
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'account_lifecycle_fenced'
    );
  end if;

  if v_attempt.operation = 'CUSTOMER_CREATE' then
    if v_attempt.logical_key <> 'hub-account:' || p_account_id::text
       or v_attempt.external_reference <>
         'hub-account:' || p_account_id::text
       or (
         nullif(pg_catalog.btrim(v_account.asaas_customer_id), '') is not null
         and pg_catalog.btrim(v_account.asaas_customer_id) <> v_provider_id
       )
       or exists (
         select 1 from public.hub_accounts as other_account
         where other_account.id <> p_account_id
           and pg_catalog.btrim(other_account.asaas_customer_id) = v_provider_id
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'creation_scope_changed'
      );
    end if;
  elsif v_attempt.logical_key <> 'hub-checkout:' || p_checkout_id::text
     or v_attempt.external_reference <> 'hub:' || p_checkout_id::text
     or nullif(pg_catalog.btrim(v_account.asaas_customer_id), '') is null
     or (
       nullif(pg_catalog.btrim(v_checkout.asaas_subscription_id), '')
         is not null
       and pg_catalog.btrim(v_checkout.asaas_subscription_id) <> v_provider_id
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'creation_scope_changed'
    );
  end if;

  if v_attempt.status = 'SUCCEEDED' then
    if pg_catalog.btrim(v_attempt.provider_entity_id)
         is distinct from v_provider_id then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'creation_scope_changed'
      );
    end if;
  else
    if p_claim_token is null
       or v_attempt.claim_token is distinct from p_claim_token
       or v_attempt.status not in ('CLAIMED', 'SUBMITTING', 'UNKNOWN') then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'claim_lost'
      );
    end if;
    v_recorded := public.record_asaas_provider_creation_state(
      p_attempt_id,
      p_claim_token,
      'SUCCEEDED',
      v_provider_id,
      v_provider_status,
      null,
      null,
      pg_catalog.jsonb_build_object(
        'id', v_provider_id,
        'status', v_provider_status
      )
    );
    if coalesce((v_recorded ->> 'ok')::boolean, false) is not true then
      return coalesce(v_recorded, '{}'::jsonb) ||
        pg_catalog.jsonb_build_object('ok', false);
    end if;
  end if;

  if v_attempt.operation = 'CUSTOMER_CREATE' then
    update public.hub_accounts as account
    set asaas_customer_id = coalesce(account.asaas_customer_id, v_provider_id),
        updated_at = pg_catalog.clock_timestamp()
    where account.id = p_account_id
      and account.status = 'ACTIVE'
      and (
        account.asaas_customer_id is null
        or pg_catalog.btrim(account.asaas_customer_id) = v_provider_id
      );
    if not found then
      raise exception 'hub_provider_creation_adoption_lost'
        using errcode = '55000';
    end if;
  else
    update public.hub_checkout_sessions as checkout
    set asaas_subscription_id = coalesce(
          checkout.asaas_subscription_id, v_provider_id
        ),
        metadata = coalesce(checkout.metadata, '{}'::jsonb) ||
          pg_catalog.jsonb_build_object(
            'providerAdoptedAt', pg_catalog.clock_timestamp()
          ),
        updated_at = pg_catalog.clock_timestamp()
    where checkout.id = p_checkout_id
      and checkout.account_id = p_account_id
      and checkout.status in ('CREATED', 'PENDING')
      and (
        checkout.asaas_subscription_id is null
        or checkout.asaas_subscription_id = v_provider_id
      );
    if not found then
      raise exception 'hub_provider_creation_adoption_lost'
        using errcode = '55000';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'operation', v_attempt.operation,
    'providerEntityId', v_provider_id,
    'accountId', p_account_id,
    'checkoutId', p_checkout_id
  );
end;
$function$;

create or replace function public.hub_begin_provider_cancellation(
  p_operation_kind text,
  p_account_id uuid,
  p_actor_user_id uuid,
  p_target_status text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_operation_kind, '')));
  v_target_status text := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_target_status, ''))), '');
  v_reason text := pg_catalog.left(coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'ADMIN_REQUEST'), 200);
  v_account public.hub_accounts%rowtype;
  v_account_row_version text;
  v_subscription public.hub_subscriptions%rowtype;
  v_logical_key text;
  v_operation private.hub_provider_operations%rowtype;
  v_provider_id text;
  v_checkout_id uuid;
  v_checkout_product_family text;
  v_count integer;
  v_snapshot jsonb;
begin
  perform private.hub_service_role_required();
  if p_account_id is null or v_kind not in ('ACCOUNT_STATUS', 'CORE_CANCELLATION') then
    raise exception 'invalid_hub_provider_operation' using errcode = '22023';
  end if;
  if v_kind = 'ACCOUNT_STATUS'
     and v_target_status not in ('SUSPENDED', 'CLOSED') then
    raise exception 'invalid_hub_provider_operation' using errcode = '22023';
  end if;
  if v_kind = 'CORE_CANCELLATION' and p_actor_user_id is null then
    raise exception 'invalid_hub_provider_operation' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hub-provider-operation:' || p_account_id::text, 0)
  );
  select account.* into v_account
  from public.hub_accounts as account
  where account.id = p_account_id
  for update;
  if not found then
    raise exception 'hub_account_not_found' using errcode = 'P0002';
  end if;
  select account.xmin::text || ':' || account.cmin::text
    into v_account_row_version
  from public.hub_accounts as account
  where account.id = p_account_id;

  if v_kind = 'ACCOUNT_STATUS' then
    if p_actor_user_id is not null and not exists (
      select 1 from public.profiles as profile
      where profile.id = p_actor_user_id and profile.role = 'SUPER_ADMIN'
    ) then
      raise exception 'hub_status_actor_forbidden' using errcode = '42501';
    end if;
    -- A status target can recur after reactivation. Bind idempotency to the
    -- immutable source-state version, not eternally to account+target.
    v_logical_key := 'ACCOUNT_STATUS:' || p_account_id::text || ':' ||
      v_target_status || ':' || v_account.status || ':' ||
      pg_catalog.to_char(
        v_account.updated_at at time zone 'UTC',
        'YYYYMMDDHH24MISS.US'
      ) || ':' || v_account_row_version;
  else
    if v_account.status <> 'ACTIVE' then
      raise exception 'hub_account_inactive' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.hub_memberships as membership
      where membership.account_id = p_account_id
        and membership.user_id = p_actor_user_id
        and membership.status = 'ACTIVE'
        and membership.membership_role in ('OWNER', 'ADMIN')
    ) then
      raise exception 'hub_manager_required' using errcode = '42501';
    end if;
    select subscription.* into v_subscription
    from public.hub_subscriptions as subscription
    where subscription.account_id = p_account_id
      and subscription.product_family = 'HUB_CORE'
      and subscription.status = 'ACTIVE'
      and subscription.current_period_ends_at > pg_catalog.now()
    order by subscription.created_at desc, subscription.id desc
    limit 1 for update;
    if not found then
      raise exception 'hub_active_paid_subscription_required' using errcode = '55000';
    end if;
    if v_subscription.provider is distinct from 'ASAAS'
       or nullif(pg_catalog.btrim(v_subscription.provider_subscription_id), '') is null then
      raise exception 'hub_subscription_reconciliation_required' using errcode = '55000';
    end if;
    v_logical_key := 'CORE_CANCELLATION:' || p_account_id::text || ':' || v_subscription.id::text;
  end if;

  -- Resume one unfinished operation even if an unrelated account write moved
  -- updated_at after its immutable snapshot was captured.
  select operation.* into v_operation
  from private.hub_provider_operations as operation
  where operation.account_id = p_account_id
    and operation.operation_kind = v_kind
    and operation.status in ('READY', 'IN_PROGRESS')
  order by operation.created_at desc, operation.id desc
  limit 1
  for update;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'action', 'RESUME', 'operationId', v_operation.id,
      'leaseToken', v_operation.lease_token, 'status', v_operation.status,
      'snapshot', v_operation.snapshot
    );
  end if;

  -- A provider POST that has crossed (or may have crossed) its durable submit
  -- boundary cannot be omitted from a cancellation snapshot. SUCCEEDED rows
  -- stop blocking only after their exact provider id is linked locally.
  if exists (
    select 1
    from public.asaas_provider_creation_attempts as attempt
    where (
        (
          attempt.tenant_id = 'school-wise-wolf'
          and attempt.operation = 'CUSTOMER_CREATE'
          and attempt.logical_key = 'hub-account:' || p_account_id::text
          and attempt.external_reference =
            'hub-account:' || p_account_id::text
          and (
            attempt.status in (
              'SUBMITTING', 'UNKNOWN', 'BLOCKED'
            )
            or (
              attempt.status = 'SUCCEEDED'
              and pg_catalog.btrim(attempt.provider_entity_id) is distinct from
                pg_catalog.btrim(v_account.asaas_customer_id)
            )
          )
        )
        or (
          attempt.tenant_id = 'school-wise-wolf'
          and attempt.operation = 'SUBSCRIPTION_CREATE'
          and exists (
            select 1
            from public.hub_checkout_sessions as creation_checkout
            where creation_checkout.account_id = p_account_id
              and (v_kind <> 'CORE_CANCELLATION'
                or creation_checkout.product_family = 'HUB_CORE')
              and attempt.logical_key =
                'hub-checkout:' || creation_checkout.id::text
              and attempt.external_reference =
                'hub:' || creation_checkout.id::text
              and (
                attempt.status in (
                  'SUBMITTING', 'UNKNOWN', 'BLOCKED'
                )
                or (
                  attempt.status = 'SUCCEEDED'
                  and pg_catalog.btrim(attempt.provider_entity_id)
                    is distinct from pg_catalog.btrim(
                      creation_checkout.asaas_subscription_id
                    )
                )
              )
          )
        )
        or (
          attempt.tenant_id = 'wolfie-direct'
          and attempt.operation = 'PAYMENT_CREATE'
          and v_account.account_type = 'PERSONAL'
          and exists (
            select 1
            from public.wolfie_topup_orders as topup
            where topup.tenant_id = 'wolfie-direct'
              and topup.student_id = v_account.owner_user_id
              and attempt.logical_key = topup.id::text
              and attempt.external_reference =
                'wolfie-topup-order:' || topup.id::text
              and (
                attempt.status in (
                  'SUBMITTING', 'UNKNOWN', 'BLOCKED'
                )
                or (
                  attempt.status = 'SUCCEEDED'
                  and pg_catalog.btrim(attempt.provider_entity_id)
                    is distinct from pg_catalog.btrim(
                      topup.provider_payment_id
                    )
                )
              )
          )
        )
      )
  ) then
    raise exception 'hub_provider_creation_reconciliation_required'
      using errcode = '55000';
  end if;

  -- A retry after successful finalization must remain idempotent. A later
  -- ACTIVE cycle has a different source status/version and therefore reaches
  -- the new logical key below.
  if v_kind = 'ACCOUNT_STATUS' and v_account.status = v_target_status then
    select operation.* into v_operation
    from private.hub_provider_operations as operation
    where operation.account_id = p_account_id
      and operation.operation_kind = 'ACCOUNT_STATUS'
      and operation.target_status = v_target_status
      and operation.status = 'SUCCEEDED'
    order by operation.completed_at desc nulls last, operation.id desc
    limit 1;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok', true, 'action', 'ALREADY_SUCCEEDED',
        'operationId', v_operation.id, 'leaseToken', v_operation.lease_token,
        'status', v_operation.status, 'snapshot', v_operation.snapshot
      );
    end if;
  end if;

  select operation.* into v_operation
  from private.hub_provider_operations as operation
  where operation.logical_key = v_logical_key
  for update;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', case when v_operation.status = 'SUCCEEDED'
        then 'ALREADY_SUCCEEDED' else 'RESUME' end,
      'operationId', v_operation.id,
      'leaseToken', v_operation.lease_token,
      'status', v_operation.status,
      'snapshot', v_operation.snapshot
    );
  end if;

  if nullif(pg_catalog.btrim(v_account.asaas_customer_id), '') is null then
    raise exception 'hub_customer_reconciliation_required' using errcode = '55000';
  end if;

  -- Freeze every local row that contributes to the immutable provider
  -- snapshot. The account row lock also fences concurrent FK-backed inserts
  -- until this begin transaction commits.
  perform subscription.id
  from public.hub_subscriptions as subscription
  join public.hub_plans as plan on plan.id = subscription.plan_id
  where subscription.account_id = p_account_id
    and (v_kind <> 'CORE_CANCELLATION'
      or subscription.product_family = 'HUB_CORE')
    and subscription.status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
    and not (subscription.provider is null
      and subscription.provider_subscription_id is null
      and plan.code = 'DISCOVERY')
  order by subscription.id
  for update of subscription;
  perform checkout.id
  from public.hub_checkout_sessions as checkout
  where checkout.account_id = p_account_id
    and (v_kind <> 'CORE_CANCELLATION'
      or checkout.product_family = 'HUB_CORE')
    and checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID')
  order by checkout.id
  for update of checkout;

  -- Every active provider subscription must map to exactly one immutable
  -- checkout/customer tuple.  Include ids found on either active local
  -- subscriptions or open/paid checkouts so no scheduler escapes cancellation.
  for v_provider_id in
    select ids.provider_id
    from (
      select distinct pg_catalog.btrim(subscription.provider_subscription_id) as provider_id
      from public.hub_subscriptions as subscription
      join public.hub_plans as plan on plan.id = subscription.plan_id
      where subscription.account_id = p_account_id
        and (v_kind <> 'CORE_CANCELLATION'
          or subscription.product_family = 'HUB_CORE')
        and subscription.status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
        and not (subscription.provider is null
          and subscription.provider_subscription_id is null
          and plan.code = 'DISCOVERY')
      union
      select distinct pg_catalog.btrim(checkout.asaas_subscription_id)
      from public.hub_checkout_sessions as checkout
      where checkout.account_id = p_account_id
        and (v_kind <> 'CORE_CANCELLATION'
          or checkout.product_family = 'HUB_CORE')
        and checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID')
        and nullif(pg_catalog.btrim(checkout.asaas_subscription_id), '') is not null
    ) as ids
    where nullif(ids.provider_id, '') is not null
    order by ids.provider_id
  loop
    if pg_catalog.char_length(v_provider_id) > 200 then
      raise exception 'hub_subscription_reconciliation_required' using errcode = '55000';
    end if;
    select pg_catalog.count(*)::integer,
           (pg_catalog.array_agg(checkout.id order by checkout.id))[1],
           pg_catalog.min(checkout.product_family)
      into v_count, v_checkout_id, v_checkout_product_family
    from public.hub_checkout_sessions as checkout
    where checkout.account_id = p_account_id
      and (v_kind <> 'CORE_CANCELLATION'
        or checkout.product_family = 'HUB_CORE')
      and checkout.asaas_subscription_id = v_provider_id;
    if v_count <> 1 or v_checkout_id is null then
      raise exception 'hub_subscription_reconciliation_required' using errcode = '55000';
    end if;
    if v_kind = 'CORE_CANCELLATION'
       and v_checkout_product_family <> 'HUB_CORE' then
      raise exception 'hub_subscription_reconciliation_required' using errcode = '55000';
    end if;
  end loop;

  -- A malformed active row without an id cannot be silently skipped.
  if exists (
    select 1 from public.hub_subscriptions as subscription
    join public.hub_plans as plan on plan.id = subscription.plan_id
    where subscription.account_id = p_account_id
      and (v_kind <> 'CORE_CANCELLATION'
        or subscription.product_family = 'HUB_CORE')
      and subscription.status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
      and not (subscription.provider is null
        and subscription.provider_subscription_id is null
        and plan.code = 'DISCOVERY')
      and (subscription.provider is distinct from 'ASAAS'
        or nullif(pg_catalog.btrim(subscription.provider_subscription_id), '') is null)
  ) or exists (
    select 1 from public.hub_checkout_sessions as checkout
    where checkout.account_id = p_account_id
      and (v_kind <> 'CORE_CANCELLATION'
        or checkout.product_family = 'HUB_CORE')
      and checkout.status in ('PENDING', 'OVERDUE', 'PAID')
      and nullif(pg_catalog.btrim(checkout.asaas_subscription_id), '') is null
  ) then
    raise exception 'hub_subscription_reconciliation_required' using errcode = '55000';
  end if;

  select pg_catalog.jsonb_build_object(
    'accountId', v_account.id,
    'accountStatus', v_account.status,
    'accountUpdatedAt', v_account.updated_at,
    'accountRowVersion', v_account_row_version,
    'providerCustomerId', pg_catalog.btrim(v_account.asaas_customer_id),
    'operationKind', v_kind,
    'targetStatus', v_target_status,
    'subscriptionId', v_subscription.id,
    'localSubscriptions', (
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', local_subscription.id,
          'productFamily', local_subscription.product_family,
          'status', local_subscription.status,
          'provider', local_subscription.provider,
          'providerSubscriptionId',
            local_subscription.provider_subscription_id
        ) order by local_subscription.id
      ), '[]'::jsonb)
      from public.hub_subscriptions as local_subscription
      join public.hub_plans as local_plan
        on local_plan.id = local_subscription.plan_id
      where local_subscription.account_id = p_account_id
        and (v_kind <> 'CORE_CANCELLATION'
          or local_subscription.product_family = 'HUB_CORE')
        and local_subscription.status in (
          'TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE'
        )
        and not (local_subscription.provider is null
          and local_subscription.provider_subscription_id is null
          and local_plan.code = 'DISCOVERY')
    ),
    'targets', coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'providerSubscriptionId', checkout.asaas_subscription_id,
        'providerCustomerId', pg_catalog.btrim(v_account.asaas_customer_id),
        'checkoutId', checkout.id,
        'productFamily', checkout.product_family,
        'checkoutStatus', checkout.status
      ) order by checkout.asaas_subscription_id
    ) filter (where checkout.id is not null), '[]'::jsonb)
  ) into v_snapshot
  from public.hub_checkout_sessions as checkout
  where checkout.account_id = p_account_id
    and (v_kind <> 'CORE_CANCELLATION'
      or checkout.product_family = 'HUB_CORE')
    and checkout.asaas_subscription_id in (
      select distinct ids.provider_id from (
        select pg_catalog.btrim(subscription.provider_subscription_id) as provider_id
        from public.hub_subscriptions as subscription
        join public.hub_plans as plan on plan.id = subscription.plan_id
        where subscription.account_id = p_account_id
          and (v_kind <> 'CORE_CANCELLATION'
            or subscription.product_family = 'HUB_CORE')
          and subscription.status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
          and not (subscription.provider is null
            and subscription.provider_subscription_id is null
            and plan.code = 'DISCOVERY')
        union
        select pg_catalog.btrim(open_checkout.asaas_subscription_id)
        from public.hub_checkout_sessions as open_checkout
        where open_checkout.account_id = p_account_id
          and (v_kind <> 'CORE_CANCELLATION'
            or open_checkout.product_family = 'HUB_CORE')
          and open_checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID')
          and nullif(pg_catalog.btrim(open_checkout.asaas_subscription_id), '') is not null
      ) as ids
    );

  insert into private.hub_provider_operations (
    logical_key, operation_kind, account_id, actor_user_id, target_status,
    reason, snapshot, snapshot_hash
  ) values (
    v_logical_key, v_kind, p_account_id, p_actor_user_id, v_target_status,
    v_reason, v_snapshot,
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(v_snapshot::text, 'UTF8'), 'sha256'),
      'hex'
    )
  ) returning * into v_operation;

  insert into private.hub_provider_operation_targets (
    operation_id, provider_subscription_id, provider_customer_id, checkout_id
  )
  select v_operation.id, item ->> 'providerSubscriptionId',
    item ->> 'providerCustomerId', (item ->> 'checkoutId')::uuid
  from pg_catalog.jsonb_array_elements(v_snapshot -> 'targets') as item;

  if v_kind = 'CORE_CANCELLATION' then
    perform private.hub_begin_core_cancellation_internal(p_account_id, p_actor_user_id);
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'action', 'STARTED', 'operationId', v_operation.id,
    'leaseToken', v_operation.lease_token, 'status', v_operation.status,
    'snapshot', v_operation.snapshot
  );
end;
$function$;

create or replace function public.hub_bind_provider_operation_integration(
  p_operation_id uuid,
  p_lease_token uuid,
  p_integration_id uuid,
  p_integration_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_operation private.hub_provider_operations%rowtype;
begin
  perform private.hub_service_role_required();
  if p_operation_id is null or p_lease_token is null or p_integration_id is null
     or p_integration_version is null or p_integration_version < 1 then
    raise exception 'invalid_hub_provider_integration_binding' using errcode = '22023';
  end if;
  select operation.* into v_operation from private.hub_provider_operations operation
  where operation.id = p_operation_id for update;
  if not found or v_operation.lease_token is distinct from p_lease_token then
    raise exception 'hub_provider_operation_claim_lost' using errcode = '55000';
  end if;
  if (v_operation.integration_id is not null and
      (v_operation.integration_id is distinct from p_integration_id or
       v_operation.integration_version is distinct from p_integration_version)) then
    raise exception 'hub_provider_integration_version_changed' using errcode = '55000';
  end if;
  update private.hub_provider_operations operation
  set integration_id = coalesce(operation.integration_id, p_integration_id),
      integration_version = coalesce(operation.integration_version, p_integration_version),
      updated_at = pg_catalog.clock_timestamp()
  where operation.id = p_operation_id;
  return pg_catalog.jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.hub_claim_provider_cancellation_target(
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
  v_operation private.hub_provider_operations%rowtype;
  v_target private.hub_provider_operation_targets%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform private.hub_service_role_required();
  select operation.* into v_operation from private.hub_provider_operations operation
  where operation.id = p_operation_id for update;
  if not found or v_operation.lease_token is distinct from p_lease_token
     or v_operation.integration_id is null then
    raise exception 'hub_provider_operation_claim_lost' using errcode = '55000';
  end if;
  select target.* into v_target from private.hub_provider_operation_targets target
  where target.operation_id = p_operation_id
    and target.provider_subscription_id = pg_catalog.btrim(p_provider_subscription_id)
  for update;
  if not found then
    raise exception 'hub_provider_target_not_found' using errcode = 'P0002';
  end if;
  if v_target.state in ('CONFIRMED', 'ABSENT') then
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'ALREADY_SUCCEEDED',
      'target', pg_catalog.to_jsonb(v_target));
  end if;
  if v_target.state = 'SUBMITTING' then
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'RECONCILE_ONLY',
      'target', pg_catalog.to_jsonb(v_target));
  end if;
  if v_target.state = 'REVIEW_REQUIRED' then
    return pg_catalog.jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED',
      'target', pg_catalog.to_jsonb(v_target));
  end if;
  if not exists (
    select 1 from public.hub_accounts account
    where account.id = v_operation.account_id
      and pg_catalog.btrim(account.asaas_customer_id) = v_target.provider_customer_id
  ) or not exists (
    select 1 from public.hub_checkout_sessions checkout
    where checkout.id = v_target.checkout_id
      and checkout.account_id = v_operation.account_id
      and checkout.asaas_subscription_id = v_target.provider_subscription_id
  ) then
    update private.hub_provider_operation_targets target
    set state = 'REVIEW_REQUIRED', submission_token = pg_catalog.gen_random_uuid(),
        submitted_at = v_now, updated_at = v_now
    where target.operation_id = v_target.operation_id
      and target.provider_subscription_id = v_target.provider_subscription_id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'LOCAL_SCOPE_CHANGED'
    );
  end if;
  -- Provider GET is safe to repeat. Do not cross the at-most-once mutation
  -- boundary until a second RPC rechecks this exact local snapshot.
  return pg_catalog.jsonb_build_object('ok', true, 'action', 'VERIFY_REQUIRED',
    'target', pg_catalog.to_jsonb(v_target));
end;
$function$;

-- Recomputes the complete immutable local scope immediately before a provider
-- mutation is authorized. Row locks remain held by the caller transaction, so
-- a webhook cannot change the account/subscription/checkout snapshot between
-- this proof and READY -> SUBMITTING.
create or replace function private.hub_provider_operation_scope_is_current(
  p_operation_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation private.hub_provider_operations%rowtype;
  v_account public.hub_accounts%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_checkout public.hub_checkout_sessions%rowtype;
  v_account_id uuid;
  v_account_row_version text;
  v_item jsonb;
begin
  perform private.hub_service_role_required();
  select operation.account_id into v_account_id
  from private.hub_provider_operations operation
  where operation.id = p_operation_id;
  if not found then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-operation:' || v_account_id::text,
      0
    )
  );
  select operation.* into v_operation
  from private.hub_provider_operations operation
  where operation.id = p_operation_id
  for update;
  if not found
     or v_operation.account_id is distinct from v_account_id
     or v_operation.lease_token is distinct from p_lease_token
     or v_operation.snapshot_hash is distinct from pg_catalog.encode(
       extensions.digest(
         pg_catalog.convert_to(v_operation.snapshot::text, 'UTF8'),
         'sha256'
       ),
       'hex'
     )
     or pg_catalog.jsonb_typeof(v_operation.snapshot -> 'targets')
       is distinct from 'array' then
    return false;
  end if;

  select account.* into v_account
  from public.hub_accounts account
  where account.id = v_operation.account_id
  for update;
  if not found
     or pg_catalog.btrim(v_account.asaas_customer_id) is distinct from
       (v_operation.snapshot ->> 'providerCustomerId') then
    return false;
  end if;

  if v_operation.operation_kind in (
    'ACCOUNT_STATUS', 'CORE_CANCELLATION'
  ) then
    -- Lock the complete account/product row sets, not only rows present in the
    -- old snapshot. This serializes an inactive->active transition or checkout
    -- rebinding that began without the advisory before the comparison below.
    perform subscription.id
    from public.hub_subscriptions subscription
    where subscription.account_id = v_operation.account_id
      and (v_operation.operation_kind <> 'CORE_CANCELLATION'
        or subscription.product_family = 'HUB_CORE')
    order by subscription.id
    for update;
    perform checkout.id
    from public.hub_checkout_sessions checkout
    where checkout.account_id = v_operation.account_id
      and (v_operation.operation_kind <> 'CORE_CANCELLATION'
        or checkout.product_family = 'HUB_CORE')
    order by checkout.id
    for update;

    select account.xmin::text || ':' || account.cmin::text
      into v_account_row_version
    from public.hub_accounts account
    where account.id = v_operation.account_id;
    if v_account.status is distinct from
         (v_operation.snapshot ->> 'accountStatus')
       or v_account.updated_at is distinct from
         (v_operation.snapshot ->> 'accountUpdatedAt')::timestamptz
       or v_account_row_version is distinct from
         (v_operation.snapshot ->> 'accountRowVersion')
       or pg_catalog.jsonb_typeof(
         v_operation.snapshot -> 'localSubscriptions'
       ) is distinct from 'array' then
      return false;
    end if;

    for v_item in
      select element.value
      from pg_catalog.jsonb_array_elements(
        v_operation.snapshot -> 'localSubscriptions'
      ) as element(value)
    loop
      select subscription.* into v_subscription
      from public.hub_subscriptions subscription
      where subscription.id = (v_item ->> 'id')::uuid
        and subscription.account_id = v_operation.account_id
      for update;
      if not found
         or v_subscription.product_family is distinct from
           (v_item ->> 'productFamily')
         or v_subscription.status is distinct from (v_item ->> 'status')
         or v_subscription.provider is distinct from (v_item ->> 'provider')
         or v_subscription.provider_subscription_id is distinct from
           (v_item ->> 'providerSubscriptionId') then
        return false;
      end if;
    end loop;

    if exists (
      select 1
      from public.hub_subscriptions subscription
      join public.hub_plans plan on plan.id = subscription.plan_id
      where subscription.account_id = v_operation.account_id
        and (v_operation.operation_kind <> 'CORE_CANCELLATION'
          or subscription.product_family = 'HUB_CORE')
        and subscription.status in (
          'TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE'
        )
        and not (
          subscription.provider is null
          and subscription.provider_subscription_id is null
          and plan.code = 'DISCOVERY'
        )
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            v_operation.snapshot -> 'localSubscriptions'
          ) as item(value)
          where item.value ->> 'id' = subscription.id::text
        )
    ) or exists (
      select 1
      from public.hub_checkout_sessions checkout
      where checkout.account_id = v_operation.account_id
        and (v_operation.operation_kind <> 'CORE_CANCELLATION'
          or checkout.product_family = 'HUB_CORE')
        and checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID')
        and nullif(
          pg_catalog.btrim(checkout.asaas_subscription_id),
          ''
        ) is not null
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            v_operation.snapshot -> 'targets'
          ) as item(value)
          where item.value ->> 'checkoutId' = checkout.id::text
            and item.value ->> 'providerSubscriptionId' =
              checkout.asaas_subscription_id
        )
    ) or exists (
      select 1
      from public.hub_checkout_sessions checkout
      where checkout.account_id = v_operation.account_id
        and (v_operation.operation_kind <> 'CORE_CANCELLATION'
          or checkout.product_family = 'HUB_CORE')
        and checkout.status in ('PENDING', 'OVERDUE', 'PAID')
        and nullif(
          pg_catalog.btrim(checkout.asaas_subscription_id),
          ''
        ) is null
    ) then
      return false;
    end if;
  end if;

  for v_item in
    select element.value
    from pg_catalog.jsonb_array_elements(
      v_operation.snapshot -> 'targets'
    ) as element(value)
  loop
    select checkout.* into v_checkout
    from public.hub_checkout_sessions checkout
    where checkout.id = (v_item ->> 'checkoutId')::uuid
      and checkout.account_id = v_operation.account_id
      and checkout.asaas_subscription_id =
        (v_item ->> 'providerSubscriptionId')
    for update;
    if not found
       or pg_catalog.btrim(v_account.asaas_customer_id) is distinct from
         (v_item ->> 'providerCustomerId')
       or (
         v_operation.operation_kind in (
           'ACCOUNT_STATUS', 'CORE_CANCELLATION'
         ) and (
           v_checkout.product_family is distinct from
             (v_item ->> 'productFamily')
           or v_checkout.status is distinct from
             (v_item ->> 'checkoutStatus')
         )
       ) then
      return false;
    end if;
  end loop;

  return true;
end;
$function$;

create or replace function public.hub_mark_provider_cancellation_submitting(
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
  v_operation private.hub_provider_operations%rowtype;
  v_target private.hub_provider_operation_targets%rowtype;
  v_other_state text;
  v_scope_current boolean;
  v_provider_subscription_id text := nullif(
    pg_catalog.btrim(p_provider_subscription_id),
    ''
  );
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform private.hub_service_role_required();
  if v_provider_subscription_id is null
     or pg_catalog.char_length(v_provider_subscription_id) > 200 then
    raise exception 'invalid_hub_provider_subscription_id'
      using errcode = '22023';
  end if;

  v_scope_current := private.hub_provider_operation_scope_is_current(
    p_operation_id,
    p_lease_token
  );

  -- Every Hub cancellation path (account status, Core self-service and
  -- webhook cleanup) shares this mutation boundary. Separate durable
  -- operations may safely perform repeatable GETs, but only one of them may
  -- ever move the same provider scheduler to SUBMITTING.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-delete:' || v_provider_subscription_id,
      0
    )
  );
  select operation.* into v_operation
  from private.hub_provider_operations operation
  where operation.id = p_operation_id
  for update;
  if not found or v_operation.lease_token is distinct from p_lease_token
     or v_operation.integration_id is null then
    raise exception 'hub_provider_operation_claim_lost' using errcode = '55000';
  end if;
  select target.* into v_target
  from private.hub_provider_operation_targets target
  where target.operation_id = p_operation_id
    and target.provider_subscription_id = v_provider_subscription_id
  for update;
  if not found then
    raise exception 'hub_provider_target_not_found' using errcode = 'P0002';
  end if;
  if v_target.state in ('CONFIRMED', 'ABSENT') then
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'ALREADY_SUCCEEDED');
  end if;
  if v_target.state = 'SUBMITTING' then
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'RECONCILE_ONLY');
  end if;
  if not v_scope_current
     or v_target.state <> 'READY'
     or not exists (
       select 1 from public.hub_accounts account
       where account.id = v_operation.account_id
         and pg_catalog.btrim(account.asaas_customer_id) = v_target.provider_customer_id
     )
     or not exists (
       select 1 from public.hub_checkout_sessions checkout
       where checkout.id = v_target.checkout_id
         and checkout.account_id = v_operation.account_id
         and checkout.asaas_subscription_id = v_target.provider_subscription_id
     ) then
    update private.hub_provider_operation_targets target
    set state = 'REVIEW_REQUIRED',
        submission_token = coalesce(
          target.submission_token, pg_catalog.gen_random_uuid()
        ),
        submitted_at = coalesce(target.submitted_at, v_now),
        updated_at = v_now
    where target.operation_id = v_target.operation_id
      and target.provider_subscription_id = v_target.provider_subscription_id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'LOCAL_SCOPE_CHANGED'
    );
  end if;

  -- A provider id must always resolve to the same immutable local tuple.
  -- Conflicting historical targets are triage evidence, never permission to
  -- mutate the provider.
  if exists (
    select 1
    from private.hub_provider_operation_targets other_target
    where other_target.provider_subscription_id =
        v_provider_subscription_id
      and other_target.operation_id <> v_target.operation_id
      and other_target.state in (
        'SUBMITTING', 'CONFIRMED', 'ABSENT', 'REVIEW_REQUIRED'
      )
      and (
        other_target.provider_customer_id is distinct from
          v_target.provider_customer_id
        or other_target.checkout_id is distinct from v_target.checkout_id
      )
  ) then
    update private.hub_provider_operation_targets target
    set state = 'REVIEW_REQUIRED',
        submission_token = coalesce(
          target.submission_token,
          pg_catalog.gen_random_uuid()
        ),
        submitted_at = coalesce(target.submitted_at, v_now),
        updated_at = v_now
    where target.operation_id = v_target.operation_id
      and target.provider_subscription_id = v_provider_subscription_id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'PROVIDER_TARGET_IDENTITY_CONFLICT'
    );
  end if;

  -- A terminal proof obtained by another operation is authoritative for the
  -- same exact tuple. Propagate it into this operation atomically so its
  -- finalizer never mistakes a READY row for completed work.
  select other_target.state into v_other_state
  from private.hub_provider_operation_targets other_target
  where other_target.provider_subscription_id = v_provider_subscription_id
    and other_target.operation_id <> v_target.operation_id
    and other_target.provider_customer_id = v_target.provider_customer_id
    and other_target.checkout_id = v_target.checkout_id
    and other_target.state in ('CONFIRMED', 'ABSENT')
  order by other_target.confirmed_at desc nulls last,
    other_target.updated_at desc,
    other_target.operation_id
  limit 1;
  if found then
    update private.hub_provider_operation_targets target
    set state = v_other_state,
        submission_token = coalesce(
          target.submission_token,
          pg_catalog.gen_random_uuid()
        ),
        submitted_at = coalesce(target.submitted_at, v_now),
        confirmed_at = coalesce(target.confirmed_at, v_now),
        updated_at = v_now
    where target.operation_id = v_target.operation_id
      and target.provider_subscription_id = v_provider_subscription_id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_SUCCEEDED',
      'state', v_other_state
    );
  end if;

  if exists (
    select 1
    from private.hub_provider_operation_targets other_target
    where other_target.provider_subscription_id =
        v_provider_subscription_id
      and other_target.operation_id <> v_target.operation_id
      and other_target.provider_customer_id = v_target.provider_customer_id
      and other_target.checkout_id = v_target.checkout_id
      and other_target.state = 'REVIEW_REQUIRED'
  ) then
    update private.hub_provider_operation_targets target
    set state = 'REVIEW_REQUIRED',
        submission_token = coalesce(
          target.submission_token,
          pg_catalog.gen_random_uuid()
        ),
        submitted_at = coalesce(target.submitted_at, v_now),
        updated_at = v_now
    where target.operation_id = v_target.operation_id
      and target.provider_subscription_id = v_provider_subscription_id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'PROVIDER_TARGET_REVIEW_REQUIRED'
    );
  end if;

  if exists (
    select 1
    from private.hub_provider_operation_targets other_target
    where other_target.provider_subscription_id =
        v_provider_subscription_id
      and other_target.operation_id <> v_target.operation_id
      and other_target.provider_customer_id = v_target.provider_customer_id
      and other_target.checkout_id = v_target.checkout_id
      and other_target.state = 'SUBMITTING'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'RECONCILE_ONLY',
      'reason', 'PROVIDER_DELETE_ALREADY_SUBMITTED'
    );
  end if;

  update private.hub_provider_operation_targets target
  set state = 'SUBMITTING', submission_token = pg_catalog.gen_random_uuid(),
      submitted_at = v_now, updated_at = v_now
  where target.operation_id = v_target.operation_id
    and target.provider_subscription_id = v_target.provider_subscription_id;
  update private.hub_provider_operations operation
  set status = 'IN_PROGRESS', updated_at = v_now
  where operation.id = v_operation.id;
  return pg_catalog.jsonb_build_object('ok', true, 'action', 'SUBMIT_ALLOWED');
end;
$function$;

create or replace function public.hub_claim_webhook_provider_cancellation(
  p_account_id uuid,
  p_checkout_id uuid,
  p_provider_subscription_id text,
  p_provider_customer_id text,
  p_integration_id uuid,
  p_integration_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_subscription_id text := nullif(pg_catalog.btrim(p_provider_subscription_id), '');
  v_customer_id text := nullif(pg_catalog.btrim(p_provider_customer_id), '');
  v_logical_key text;
  v_snapshot jsonb;
  v_operation private.hub_provider_operations%rowtype;
  v_target private.hub_provider_operation_targets%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform private.hub_service_role_required();
  if p_account_id is null or p_checkout_id is null or v_subscription_id is null
     or v_customer_id is null or p_integration_id is null
     or p_integration_version is null or p_integration_version < 1
     or pg_catalog.char_length(v_subscription_id) > 200
     or pg_catalog.char_length(v_customer_id) > 200 then
    raise exception 'invalid_hub_webhook_provider_cancellation' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hub-webhook-provider-delete:' || v_subscription_id, 0)
  );
  if not exists (
    select 1 from public.hub_accounts account
    where account.id = p_account_id
      and pg_catalog.btrim(account.asaas_customer_id) = v_customer_id
  ) or not exists (
    select 1 from public.hub_checkout_sessions checkout
    where checkout.id = p_checkout_id
      and checkout.account_id = p_account_id
      and checkout.asaas_subscription_id = v_subscription_id
  ) then
    raise exception 'hub_provider_operation_scope_changed' using errcode = '55000';
  end if;

  v_logical_key := 'WEBHOOK_CANCELLATION:' || v_subscription_id;
  select operation.* into v_operation
  from private.hub_provider_operations operation
  where operation.logical_key = v_logical_key
  for update;
  if not found then
    v_snapshot := pg_catalog.jsonb_build_object(
      'accountId', p_account_id,
      'operationKind', 'WEBHOOK_CANCELLATION',
      'providerCustomerId', v_customer_id,
      'targets', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'providerSubscriptionId', v_subscription_id,
        'providerCustomerId', v_customer_id,
        'checkoutId', p_checkout_id
      ))
    );
    insert into private.hub_provider_operations (
      logical_key, operation_kind, account_id, actor_user_id, snapshot,
      snapshot_hash, integration_id, integration_version
    ) values (
      v_logical_key, 'WEBHOOK_CANCELLATION', p_account_id, null, v_snapshot,
      pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(v_snapshot::text, 'UTF8'), 'sha256'),
        'hex'
      ),
      p_integration_id, p_integration_version
    ) returning * into v_operation;
    insert into private.hub_provider_operation_targets (
      operation_id, provider_subscription_id, provider_customer_id, checkout_id
    ) values (
      v_operation.id, v_subscription_id, v_customer_id, p_checkout_id
    );
  elsif v_operation.operation_kind <> 'WEBHOOK_CANCELLATION'
     or v_operation.account_id <> p_account_id
     or v_operation.integration_id is distinct from p_integration_id
     or v_operation.integration_version is distinct from p_integration_version
     or v_operation.snapshot ->> 'providerCustomerId' <> v_customer_id
     or v_operation.snapshot -> 'targets' -> 0 ->> 'checkoutId' <> p_checkout_id::text then
    raise exception 'hub_provider_operation_scope_changed' using errcode = '55000';
  end if;

  select target.* into v_target
  from private.hub_provider_operation_targets target
  where target.operation_id = v_operation.id
    and target.provider_subscription_id = v_subscription_id
  for update;
  if not found then
    raise exception 'hub_provider_target_not_found' using errcode = 'P0002';
  end if;
  if v_target.state in ('CONFIRMED', 'ABSENT') then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'action', 'ALREADY_SUCCEEDED',
      'operationId', v_operation.id, 'leaseToken', v_operation.lease_token
    );
  end if;
  if v_target.state = 'SUBMITTING' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'action', 'RECONCILE_ONLY',
      'operationId', v_operation.id, 'leaseToken', v_operation.lease_token
    );
  end if;
  if v_target.state <> 'READY' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'operationId', v_operation.id, 'leaseToken', v_operation.lease_token
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'action', 'VERIFY_REQUIRED',
    'operationId', v_operation.id, 'leaseToken', v_operation.lease_token
  );
end;
$function$;

create or replace function public.hub_complete_provider_cancellation_target(
  p_operation_id uuid,
  p_lease_token uuid,
  p_provider_subscription_id text,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_outcome text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_outcome, '')));
  v_provider_subscription_id text := nullif(
    pg_catalog.btrim(p_provider_subscription_id),
    ''
  );
  v_state text;
begin
  perform private.hub_service_role_required();
  if v_outcome not in ('CONFIRMED', 'ABSENT')
     or v_provider_subscription_id is null
     or pg_catalog.char_length(v_provider_subscription_id) > 200 then
    raise exception 'invalid_hub_provider_target_outcome' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-delete:' || v_provider_subscription_id,
      0
    )
  );
  if not exists (select 1 from private.hub_provider_operations operation
    where operation.id = p_operation_id and operation.lease_token = p_lease_token) then
    raise exception 'hub_provider_operation_claim_lost' using errcode = '55000';
  end if;
  update private.hub_provider_operation_targets target
  set state = v_outcome,
      submission_token = coalesce(target.submission_token, pg_catalog.gen_random_uuid()),
      submitted_at = coalesce(target.submitted_at, pg_catalog.clock_timestamp()),
      confirmed_at = coalesce(target.confirmed_at, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
  where target.operation_id = p_operation_id
    and target.provider_subscription_id = v_provider_subscription_id
    and (
      target.state in ('SUBMITTING', 'CONFIRMED', 'ABSENT')
      or (target.state = 'READY' and v_outcome = 'ABSENT')
    )
  returning target.state into v_state;
  if v_state is null then
    raise exception 'hub_provider_target_completion_rejected' using errcode = '55000';
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'state', v_state);
end;
$function$;

create or replace function private.hub_assert_provider_operation_complete(
  p_operation_id uuid,
  p_lease_token uuid
)
returns private.hub_provider_operations
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation private.hub_provider_operations%rowtype;
  v_account public.hub_accounts%rowtype;
  v_checkout public.hub_checkout_sessions%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_account_id uuid;
  v_account_row_version text;
  v_item jsonb;
begin
  perform private.hub_service_role_required();
  select operation.account_id into v_account_id
  from private.hub_provider_operations operation
  where operation.id = p_operation_id;
  if not found then
    raise exception 'hub_provider_operation_claim_lost'
      using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-operation:' || v_account_id::text,
      0
    )
  );
  select operation.* into v_operation from private.hub_provider_operations operation
  where operation.id = p_operation_id for update;
  if not found or v_operation.account_id is distinct from v_account_id
     or v_operation.lease_token is distinct from p_lease_token then
    raise exception 'hub_provider_operation_claim_lost' using errcode = '55000';
  end if;
  if exists (select 1 from private.hub_provider_operation_targets target
    where target.operation_id = p_operation_id
      and target.state not in ('CONFIRMED', 'ABSENT')) then
    raise exception 'hub_provider_cancellation_not_confirmed' using errcode = '55000';
  end if;
  if v_operation.snapshot_hash is distinct from pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_operation.snapshot::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  ) then
    raise exception 'hub_provider_operation_snapshot_corrupt'
      using errcode = '55000';
  end if;
  if pg_catalog.jsonb_typeof(v_operation.snapshot -> 'targets')
       is distinct from 'array' then
    raise exception 'hub_provider_operation_snapshot_corrupt'
      using errcode = '55000';
  end if;
  if v_operation.status = 'SUCCEEDED' then
    return v_operation;
  end if;

  select account.* into v_account
  from public.hub_accounts as account
  where account.id = v_operation.account_id
  for update;
  if not found
     or pg_catalog.btrim(v_account.asaas_customer_id) is distinct from
       (v_operation.snapshot ->> 'providerCustomerId') then
    raise exception 'hub_provider_operation_scope_changed'
      using errcode = '55000';
  end if;
  select account.xmin::text || ':' || account.cmin::text
    into v_account_row_version
  from public.hub_accounts as account
  where account.id = v_operation.account_id;

  if v_operation.operation_kind in ('ACCOUNT_STATUS', 'CORE_CANCELLATION') then
    perform subscription.id
    from public.hub_subscriptions subscription
    where subscription.account_id = v_operation.account_id
      and (v_operation.operation_kind <> 'CORE_CANCELLATION'
        or subscription.product_family = 'HUB_CORE')
    order by subscription.id
    for update;
    perform checkout.id
    from public.hub_checkout_sessions checkout
    where checkout.account_id = v_operation.account_id
      and (v_operation.operation_kind <> 'CORE_CANCELLATION'
        or checkout.product_family = 'HUB_CORE')
    order by checkout.id
    for update;

    if v_account.status is distinct from
         (v_operation.snapshot ->> 'accountStatus')
       or v_account.updated_at is distinct from
         (v_operation.snapshot ->> 'accountUpdatedAt')::timestamptz
       or v_account_row_version is distinct from
         (v_operation.snapshot ->> 'accountRowVersion')
       or pg_catalog.jsonb_typeof(
         v_operation.snapshot -> 'localSubscriptions'
       ) is distinct from 'array' then
      raise exception 'hub_provider_operation_scope_changed'
        using errcode = '55000';
    end if;

    for v_item in
      select element.value
      from pg_catalog.jsonb_array_elements(
        v_operation.snapshot -> 'localSubscriptions'
      ) as element(value)
    loop
      select subscription.* into v_subscription
      from public.hub_subscriptions as subscription
      where subscription.id = (v_item ->> 'id')::uuid
        and subscription.account_id = v_operation.account_id
      for update;
      if not found
         or v_subscription.product_family is distinct from
           (v_item ->> 'productFamily')
         or v_subscription.status is distinct from (v_item ->> 'status')
         or v_subscription.provider is distinct from (v_item ->> 'provider')
         or v_subscription.provider_subscription_id is distinct from
           (v_item ->> 'providerSubscriptionId') then
        raise exception 'hub_provider_operation_scope_changed'
          using errcode = '55000';
      end if;
    end loop;

    if exists (
      select 1
      from public.hub_subscriptions as subscription
      join public.hub_plans as plan on plan.id = subscription.plan_id
      where subscription.account_id = v_operation.account_id
        and (v_operation.operation_kind <> 'CORE_CANCELLATION'
          or subscription.product_family = 'HUB_CORE')
        and subscription.status in (
          'TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE'
        )
        and not (subscription.provider is null
          and subscription.provider_subscription_id is null
          and plan.code = 'DISCOVERY')
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            v_operation.snapshot -> 'localSubscriptions'
          ) as item(value)
          where item.value ->> 'id' = subscription.id::text
        )
    ) then
      raise exception 'hub_provider_operation_scope_changed'
        using errcode = '55000';
    end if;

    -- No provider-linked checkout may appear after the immutable snapshot,
    -- even if its subscription row has not been materialized yet. Creation
    -- RPCs are fenced earlier; this is the final compare-and-set defense.
    if exists (
      select 1
      from public.hub_checkout_sessions as checkout
      where checkout.account_id = v_operation.account_id
        and (v_operation.operation_kind <> 'CORE_CANCELLATION'
          or checkout.product_family = 'HUB_CORE')
        and checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID')
        and nullif(
          pg_catalog.btrim(checkout.asaas_subscription_id),
          ''
        ) is not null
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            v_operation.snapshot -> 'targets'
          ) as item(value)
          where item.value ->> 'checkoutId' = checkout.id::text
            and item.value ->> 'providerSubscriptionId' =
              checkout.asaas_subscription_id
        )
    ) or exists (
      select 1
      from public.hub_checkout_sessions as checkout
      where checkout.account_id = v_operation.account_id
        and (v_operation.operation_kind <> 'CORE_CANCELLATION'
          or checkout.product_family = 'HUB_CORE')
        and checkout.status in ('PENDING', 'OVERDUE', 'PAID')
        and nullif(
          pg_catalog.btrim(checkout.asaas_subscription_id),
          ''
        ) is null
    ) then
      raise exception 'hub_provider_operation_scope_changed'
        using errcode = '55000';
    end if;
  end if;

  for v_item in
    select element.value
    from pg_catalog.jsonb_array_elements(
      v_operation.snapshot -> 'targets'
    ) as element(value)
  loop
    if not exists (
      select 1
      from private.hub_provider_operation_targets as target
      where target.operation_id = v_operation.id
        and target.provider_subscription_id =
          (v_item ->> 'providerSubscriptionId')
        and target.provider_customer_id =
          (v_item ->> 'providerCustomerId')
        and target.checkout_id = (v_item ->> 'checkoutId')::uuid
        and target.state in ('CONFIRMED', 'ABSENT')
    ) then
      raise exception 'hub_provider_operation_scope_changed'
        using errcode = '55000';
    end if;

    select checkout.* into v_checkout
    from public.hub_checkout_sessions as checkout
    where checkout.id = (v_item ->> 'checkoutId')::uuid
      and checkout.account_id = v_operation.account_id
      and checkout.asaas_subscription_id =
        (v_item ->> 'providerSubscriptionId')
    for update;
    if not found
       or (
         v_operation.operation_kind in (
           'ACCOUNT_STATUS', 'CORE_CANCELLATION'
         ) and (
           v_checkout.product_family is distinct from
             (v_item ->> 'productFamily')
           or v_checkout.status is distinct from
             (v_item ->> 'checkoutStatus')
         )
       ) then
      raise exception 'hub_provider_operation_scope_changed'
        using errcode = '55000';
    end if;
  end loop;
  return v_operation;
end;
$function$;

create or replace function public.hub_finalize_webhook_provider_cancellation(
  p_operation_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_operation private.hub_provider_operations%rowtype;
begin
  v_operation := private.hub_assert_provider_operation_complete(
    p_operation_id, p_lease_token
  );
  if v_operation.operation_kind <> 'WEBHOOK_CANCELLATION' then
    raise exception 'invalid_hub_provider_operation' using errcode = '55000';
  end if;
  update private.hub_provider_operations operation
  set status = 'SUCCEEDED', completed_at = coalesce(
        operation.completed_at, pg_catalog.clock_timestamp()
      ), updated_at = pg_catalog.clock_timestamp()
  where operation.id = v_operation.id and operation.status <> 'SUCCEEDED';
  return pg_catalog.jsonb_build_object(
    'ok', true, 'operationId', v_operation.id,
    'idempotent', v_operation.status = 'SUCCEEDED'
  );
end;
$function$;

create or replace function public.hub_finalize_provider_cancellation(
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
  v_provider_ids text[];
  v_result jsonb;
begin
  v_operation := private.hub_assert_provider_operation_complete(p_operation_id, p_lease_token);
  if v_operation.status = 'SUCCEEDED' then
    return pg_catalog.jsonb_build_object('ok', true, 'idempotent', true,
      'operationId', v_operation.id);
  end if;
  select coalesce(pg_catalog.array_agg(target.provider_subscription_id order by target.provider_subscription_id), '{}'::text[])
    into v_provider_ids
  from private.hub_provider_operation_targets target
  where target.operation_id = v_operation.id;
  if v_operation.operation_kind = 'ACCOUNT_STATUS' then
    v_result := private.hub_finalize_account_status_internal(
      v_operation.account_id, v_operation.target_status, v_provider_ids,
      v_operation.actor_user_id, v_operation.reason
    );
  elsif v_operation.operation_kind = 'CORE_CANCELLATION' then
    v_result := private.hub_schedule_core_cancellation_internal(
      v_operation.account_id, v_operation.actor_user_id, v_provider_ids
    );
  else
    raise exception 'invalid_hub_provider_operation' using errcode = '55000';
  end if;
  update private.hub_provider_operations operation
  set status = 'SUCCEEDED', completed_at = coalesce(operation.completed_at, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
  where operation.id = v_operation.id and operation.status <> 'SUCCEEDED';
  return coalesce(v_result, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'ok', true, 'operationId', v_operation.id
  );
end;
$function$;

-- The payment webhook writers below predate the durable provider operation.
-- Preserve their reviewed implementations as private apply functions, then
-- expose wrappers that take the account lifecycle fence before any row lock.
-- This makes READY/SUBMITTING cancellation and paid/reversal/overdue writes
-- linearizable: whichever owns the account advisory first is the only side
-- allowed to mutate its state.
do $move_hub_provider_event_writers$
begin
  if pg_catalog.to_regprocedure(
    'private.hub_activate_paid_checkout_provider_apply(uuid,text)'
  ) is null then
    if pg_catalog.to_regprocedure(
      'public.hub_activate_paid_checkout(uuid,text)'
    ) is null then
      raise exception 'hub_activate_paid_checkout_dependency_missing';
    end if;
    alter function public.hub_activate_paid_checkout(uuid,text)
      set schema private;
    alter function private.hub_activate_paid_checkout(uuid,text)
      rename to hub_activate_paid_checkout_provider_apply;
  end if;

  if pg_catalog.to_regprocedure(
    'private.hub_reverse_paid_checkout_provider_apply(uuid,text,text)'
  ) is null then
    if pg_catalog.to_regprocedure(
      'public.hub_reverse_paid_checkout(uuid,text,text)'
    ) is null then
      raise exception 'hub_reverse_paid_checkout_dependency_missing';
    end if;
    alter function public.hub_reverse_paid_checkout(uuid,text,text)
      set schema private;
    alter function private.hub_reverse_paid_checkout(uuid,text,text)
      rename to hub_reverse_paid_checkout_provider_apply;
  end if;

  if pg_catalog.to_regprocedure(
    'private.hub_mark_checkout_overdue_provider_apply(uuid,text)'
  ) is null then
    if pg_catalog.to_regprocedure(
      'public.hub_mark_checkout_overdue(uuid,text)'
    ) is null then
      raise exception 'hub_mark_checkout_overdue_dependency_missing';
    end if;
    alter function public.hub_mark_checkout_overdue(uuid,text)
      set schema private;
    alter function private.hub_mark_checkout_overdue(uuid,text)
      rename to hub_mark_checkout_overdue_provider_apply;
  end if;
end;
$move_hub_provider_event_writers$;

create or replace function private.hub_lock_provider_event_writer(
  p_checkout_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_account_id uuid;
  v_locked_account_id uuid;
begin
  -- Production callers must carry the service-role JWT. The postgres session
  -- exception is limited to migration owners/rollback-only SQL verification;
  -- the public wrappers are additionally EXECUTE-revoked from clients.
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_checkout_id is null then
    raise exception 'invalid_hub_checkout' using errcode = '22023';
  end if;
  select checkout.account_id into v_account_id
  from public.hub_checkout_sessions checkout
  where checkout.id = p_checkout_id;
  if not found then
    raise exception 'hub_checkout_not_found' using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-operation:' || v_account_id::text,
      0
    )
  );
  -- Lock only after the account advisory, in the same account->checkout order
  -- used by begin, mark and finalization.
  perform account.id
  from public.hub_accounts account
  where account.id = v_account_id
  for update;
  if not found then
    raise exception 'hub_provider_operation_scope_changed'
      using errcode = '55000';
  end if;
  select checkout.account_id into v_locked_account_id
  from public.hub_checkout_sessions checkout
  where checkout.id = p_checkout_id
  for update;
  if not found or v_locked_account_id is distinct from v_account_id then
    raise exception 'hub_provider_operation_scope_changed'
      using errcode = '55000';
  end if;
  if exists (
    select 1
    from private.hub_provider_operations operation
    where operation.account_id = v_account_id
      and operation.status in ('READY', 'IN_PROGRESS', 'BLOCKED')
  ) then
    raise exception 'hub_provider_operation_in_progress'
      using errcode = '55000';
  end if;
  return v_account_id;
end;
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
begin
  v_account_id := private.hub_lock_provider_event_writer(p_checkout_id);
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
  return private.hub_reverse_paid_checkout_provider_apply(
    p_checkout_id,
    p_payment_id,
    p_event_name
  );
end;
$function$;

create or replace function public.hub_mark_checkout_overdue(
  p_checkout_id uuid,
  p_payment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.hub_lock_provider_event_writer(p_checkout_id);
  return private.hub_mark_checkout_overdue_provider_apply(
    p_checkout_id,
    p_payment_id
  );
end;
$function$;

-- Atomic merge and null-or-same payment fencing for checkout/event writes.
create or replace function public.hub_bind_checkout_provider_subscription(
  p_checkout_id uuid,
  p_subscription_id text,
  p_metadata_patch jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_checkout public.hub_checkout_sessions%rowtype;
  v_subscription_id text := nullif(pg_catalog.btrim(p_subscription_id), '');
  v_account_id uuid;
begin
  perform private.hub_service_role_required();
  if p_checkout_id is null or v_subscription_id is null
     or pg_catalog.char_length(v_subscription_id) > 200
     or p_metadata_patch is null
     or pg_catalog.jsonb_typeof(p_metadata_patch) <> 'object'
     or pg_catalog.pg_column_size(p_metadata_patch) > 8192 then
    raise exception 'invalid_hub_checkout_subscription_binding'
      using errcode = '22023';
  end if;
  select checkout.account_id into v_account_id
  from public.hub_checkout_sessions checkout
  where checkout.id = p_checkout_id;
  if not found then
    raise exception 'hub_checkout_not_found' using errcode = 'P0002';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-operation:' || v_account_id::text,
      0
    )
  );
  select checkout.* into v_checkout
  from public.hub_checkout_sessions checkout
  where checkout.id = p_checkout_id
  for update;
  if not found then
    raise exception 'hub_checkout_not_found' using errcode = 'P0002';
  end if;
  if v_checkout.status not in ('CREATED', 'PENDING')
     or (v_checkout.asaas_subscription_id is not null
       and v_checkout.asaas_subscription_id is distinct from v_subscription_id)
     or not exists (
       select 1 from public.hub_accounts account
       where account.id = v_checkout.account_id
         and account.status = 'ACTIVE'
     )
     or exists (
       select 1 from private.hub_provider_operations operation
       where operation.account_id = v_checkout.account_id
         and operation.status in ('READY', 'IN_PROGRESS', 'BLOCKED')
     ) then
    raise exception 'hub_checkout_subscription_mismatch' using errcode = '42501';
  end if;
  update public.hub_checkout_sessions checkout
  set asaas_subscription_id = coalesce(
        checkout.asaas_subscription_id, v_subscription_id
      ),
      metadata = coalesce(checkout.metadata, '{}'::jsonb) || p_metadata_patch,
      updated_at = pg_catalog.clock_timestamp()
  where checkout.id = p_checkout_id
  returning checkout.* into v_checkout;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'checkoutId', v_checkout.id,
    'subscriptionId', v_checkout.asaas_subscription_id
  );
end;
$function$;

create or replace function public.hub_merge_checkout_provider_state(
  p_checkout_id uuid,
  p_metadata_patch jsonb default '{}'::jsonb,
  p_payment_id text default null,
  p_expected_subscription_id text default null,
  p_status text default null,
  p_invoice_url text default null,
  p_bank_slip_url text default null,
  p_allowed_statuses text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_checkout public.hub_checkout_sessions%rowtype;
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_subscription_id text := nullif(pg_catalog.btrim(p_expected_subscription_id), '');
  v_account_id uuid;
begin
  perform private.hub_service_role_required();
  if p_checkout_id is null or p_metadata_patch is null
     or pg_catalog.jsonb_typeof(p_metadata_patch) <> 'object'
     or pg_catalog.pg_column_size(p_metadata_patch) > 8192
     or (v_payment_id is not null and pg_catalog.char_length(v_payment_id) > 200)
     or (v_subscription_id is not null and pg_catalog.char_length(v_subscription_id) > 200) then
    raise exception 'invalid_hub_checkout_provider_state' using errcode = '22023';
  end if;
  select checkout.account_id into v_account_id
  from public.hub_checkout_sessions checkout
  where checkout.id = p_checkout_id;
  if not found then
    raise exception 'hub_checkout_not_found' using errcode = 'P0002';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-provider-operation:' || v_account_id::text,
      0
    )
  );
  select checkout.* into v_checkout from public.hub_checkout_sessions checkout
  where checkout.id = p_checkout_id for update;
  if not found then raise exception 'hub_checkout_not_found' using errcode = 'P0002'; end if;
  if exists (
    select 1 from private.hub_provider_operations operation
    where operation.account_id = v_checkout.account_id
      and operation.status in ('READY', 'IN_PROGRESS', 'BLOCKED')
  ) then
    raise exception 'hub_account_provider_operation_in_progress'
      using errcode = '55000';
  end if;
  if p_allowed_statuses is not null and not (v_checkout.status = any(p_allowed_statuses)) then
    raise exception 'hub_checkout_status_changed' using errcode = '55000';
  end if;
  if v_subscription_id is not null
     and v_checkout.asaas_subscription_id is distinct from v_subscription_id then
    raise exception 'hub_checkout_subscription_mismatch' using errcode = '42501';
  end if;
  if v_payment_id is not null and v_checkout.asaas_payment_id is not null
     and v_checkout.asaas_payment_id is distinct from v_payment_id then
    raise exception 'hub_checkout_payment_mismatch' using errcode = '42501';
  end if;
  update public.hub_checkout_sessions checkout
  set metadata = coalesce(checkout.metadata, '{}'::jsonb) || p_metadata_patch,
      asaas_payment_id = coalesce(checkout.asaas_payment_id, v_payment_id),
      status = coalesce(nullif(pg_catalog.btrim(p_status), ''), checkout.status),
      invoice_url = coalesce(p_invoice_url, checkout.invoice_url),
      bank_slip_url = coalesce(p_bank_slip_url, checkout.bank_slip_url),
      updated_at = pg_catalog.clock_timestamp()
  where checkout.id = p_checkout_id
  returning checkout.* into v_checkout;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'checkoutId', v_checkout.id, 'status', v_checkout.status,
    'paymentId', v_checkout.asaas_payment_id,
    'subscriptionId', v_checkout.asaas_subscription_id
  );
end;
$function$;

alter table private.hub_provider_operations owner to postgres;
alter table private.hub_provider_operation_targets owner to postgres;
alter function private.hub_provider_operation_snapshot_immutable()
  owner to postgres;
alter function private.hub_provider_target_identity_immutable()
  owner to postgres;
alter function private.hub_service_role_required() owner to postgres;
alter function private.hub_assert_provider_operation_complete(uuid,uuid)
  owner to postgres;
alter function private.hub_provider_operation_scope_is_current(uuid,uuid)
  owner to postgres;
alter function private.hub_activate_paid_checkout_provider_apply(uuid,text)
  owner to postgres;
alter function private.hub_reverse_paid_checkout_provider_apply(uuid,text,text)
  owner to postgres;
alter function private.hub_mark_checkout_overdue_provider_apply(uuid,text)
  owner to postgres;
alter function private.hub_lock_provider_event_writer(uuid)
  owner to postgres;
alter function public.hub_mark_account_provider_creation_submitting(uuid,uuid,uuid,text,uuid)
  owner to postgres;
alter function public.hub_mark_provider_creation_submitting(uuid,uuid,uuid,uuid)
  owner to postgres;
alter function public.hub_adopt_provider_creation_binding(uuid,uuid,uuid,uuid,text,text)
  owner to postgres;
alter function public.hub_begin_provider_cancellation(text,uuid,uuid,text,text)
  owner to postgres;
alter function public.hub_bind_provider_operation_integration(uuid,uuid,uuid,bigint)
  owner to postgres;
alter function public.hub_claim_provider_cancellation_target(uuid,uuid,text)
  owner to postgres;
alter function public.hub_mark_provider_cancellation_submitting(uuid,uuid,text)
  owner to postgres;
alter function public.hub_claim_webhook_provider_cancellation(uuid,uuid,text,text,uuid,bigint)
  owner to postgres;
alter function public.hub_complete_provider_cancellation_target(uuid,uuid,text,text)
  owner to postgres;
alter function public.hub_finalize_webhook_provider_cancellation(uuid,uuid)
  owner to postgres;
alter function public.hub_finalize_provider_cancellation(uuid,uuid)
  owner to postgres;
alter function public.hub_activate_paid_checkout(uuid,text)
  owner to postgres;
alter function public.hub_reverse_paid_checkout(uuid,text,text)
  owner to postgres;
alter function public.hub_mark_checkout_overdue(uuid,text)
  owner to postgres;
alter function public.hub_bind_checkout_provider_subscription(uuid,text,jsonb)
  owner to postgres;
alter function public.hub_merge_checkout_provider_state(uuid,jsonb,text,text,text,text,text,text[])
  owner to postgres;

revoke all on function private.hub_provider_operation_snapshot_immutable()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_provider_target_identity_immutable()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_service_role_required()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_assert_provider_operation_complete(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_provider_operation_scope_is_current(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_activate_paid_checkout_provider_apply(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_reverse_paid_checkout_provider_apply(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_mark_checkout_overdue_provider_apply(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_lock_provider_event_writer(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.hub_mark_account_provider_creation_submitting(uuid,uuid,uuid,text,uuid)
  from public, anon, authenticated;
revoke all on function public.hub_mark_provider_creation_submitting(uuid,uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.hub_adopt_provider_creation_binding(uuid,uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.hub_begin_provider_cancellation(text,uuid,uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.hub_bind_provider_operation_integration(uuid,uuid,uuid,bigint)
  from public, anon, authenticated;
revoke all on function public.hub_claim_provider_cancellation_target(uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.hub_mark_provider_cancellation_submitting(uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.hub_complete_provider_cancellation_target(uuid,uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.hub_finalize_provider_cancellation(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.hub_activate_paid_checkout(uuid,text)
  from public, anon, authenticated;
revoke all on function public.hub_reverse_paid_checkout(uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.hub_mark_checkout_overdue(uuid,text)
  from public, anon, authenticated;
revoke all on function public.hub_merge_checkout_provider_state(uuid,jsonb,text,text,text,text,text,text[])
  from public, anon, authenticated;
revoke all on function public.hub_bind_checkout_provider_subscription(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.hub_begin_provider_cancellation(text,uuid,uuid,text,text)
  to service_role;
grant execute on function public.hub_mark_account_provider_creation_submitting(uuid,uuid,uuid,text,uuid)
  to service_role;
grant execute on function public.hub_mark_provider_creation_submitting(uuid,uuid,uuid,uuid)
  to service_role;
grant execute on function public.hub_adopt_provider_creation_binding(uuid,uuid,uuid,uuid,text,text)
  to service_role;
grant execute on function public.hub_bind_provider_operation_integration(uuid,uuid,uuid,bigint)
  to service_role;
grant execute on function public.hub_claim_provider_cancellation_target(uuid,uuid,text)
  to service_role;
grant execute on function public.hub_mark_provider_cancellation_submitting(uuid,uuid,text)
  to service_role;
grant execute on function public.hub_complete_provider_cancellation_target(uuid,uuid,text,text)
  to service_role;
revoke all on function public.hub_claim_webhook_provider_cancellation(uuid,uuid,text,text,uuid,bigint)
  from public, anon, authenticated;
revoke all on function public.hub_finalize_webhook_provider_cancellation(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.hub_claim_webhook_provider_cancellation(uuid,uuid,text,text,uuid,bigint)
  to service_role;
grant execute on function public.hub_finalize_webhook_provider_cancellation(uuid,uuid)
  to service_role;
grant execute on function public.hub_finalize_provider_cancellation(uuid,uuid)
  to service_role;
grant execute on function public.hub_activate_paid_checkout(uuid,text)
  to service_role;
grant execute on function public.hub_reverse_paid_checkout(uuid,text,text)
  to service_role;
grant execute on function public.hub_mark_checkout_overdue(uuid,text)
  to service_role;
grant execute on function public.hub_merge_checkout_provider_state(uuid,jsonb,text,text,text,text,text,text[])
  to service_role;
grant execute on function public.hub_bind_checkout_provider_subscription(uuid,text,jsonb)
  to service_role;

comment on table private.hub_provider_operations is
  'Immutable Hub provider-mutation snapshots; retries after SUBMITTING are GET-only.';
comment on function public.hub_merge_checkout_provider_state(uuid,jsonb,text,text,text,text,text,text[]) is
  'Atomically merges Hub checkout metadata and enforces null-or-same provider payment identity.';
comment on function public.hub_activate_paid_checkout(uuid,text) is
  'Serializes paid Hub activation against durable provider cancellation.';
comment on function public.hub_reverse_paid_checkout(uuid,text,text) is
  'Serializes Hub payment reversal against durable provider cancellation.';
comment on function public.hub_mark_checkout_overdue(uuid,text) is
  'Serializes Hub overdue transitions against durable provider cancellation.';
