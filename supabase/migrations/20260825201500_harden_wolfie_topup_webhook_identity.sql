-- A top-up webhook may credit minutes only after proving the exact provider
-- customer and payment that were frozen by the server-authored order.  A
-- signed webhook is transport authentication, not object ownership proof.

alter table public.wolfie_topup_orders
  add column if not exists provider_customer_id text;

alter table public.wolfie_topup_orders
  drop constraint if exists wolfie_topup_orders_provider_customer_check;
alter table public.wolfie_topup_orders
  add constraint wolfie_topup_orders_provider_customer_check check (
    provider_customer_id is null
    or pg_catalog.char_length(pg_catalog.btrim(provider_customer_id))
      between 1 and 200
  );

-- Backfill only unambiguous canonical links. Rows that cannot be proven stay
-- NULL and fail closed during webhook processing until manually reconciled.
update public.wolfie_topup_orders as orders
   set provider_customer_id = pg_catalog.btrim(profile.asaas_customer_id),
       updated_at = pg_catalog.now()
  from public.profiles as profile
 where orders.provider_customer_id is null
   and orders.tenant_id <> 'wolfie-direct'
   and profile.id = orders.student_id
   and profile.tenant_id = orders.tenant_id
   and profile.role = 'STUDENT'
   and nullif(pg_catalog.btrim(profile.asaas_customer_id), '') is not null;

with direct_candidates as (
  select
    orders.id as order_id,
    pg_catalog.min(pg_catalog.btrim(account.asaas_customer_id)) as customer_id,
    pg_catalog.count(
      distinct pg_catalog.btrim(account.asaas_customer_id)
    ) as candidate_count
  from public.wolfie_topup_orders as orders
  join public.hub_accounts as account
    on account.owner_user_id = orders.student_id
   and account.account_type = 'PERSONAL'
  join public.hub_memberships as membership
    on membership.account_id = account.id
   and membership.user_id = orders.student_id
   and membership.membership_role = 'OWNER'
  where orders.tenant_id = 'wolfie-direct'
    and orders.provider_customer_id is null
    and nullif(pg_catalog.btrim(account.asaas_customer_id), '') is not null
  group by orders.id
)
update public.wolfie_topup_orders as orders
   set provider_customer_id = candidate.customer_id,
       updated_at = pg_catalog.now()
  from direct_candidates as candidate
 where orders.id = candidate.order_id
   and candidate.candidate_count = 1
   and orders.provider_customer_id is null;

create index if not exists idx_wolfie_topup_orders_provider_customer
  on public.wolfie_topup_orders (provider_customer_id)
  where provider_customer_id is not null;

create or replace function private.guard_wolfie_topup_provider_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.provider_customer_id is not null
     and new.provider_customer_id is distinct from old.provider_customer_id
  then
    raise exception 'wolfie_topup_customer_snapshot_immutable'
      using errcode = '55000';
  end if;
  if old.provider_payment_id is null
     and new.provider_payment_id is not null
     and new.provider_customer_id is null
  then
    raise exception 'wolfie_topup_customer_snapshot_required'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_wolfie_topup_provider_snapshot
  on public.wolfie_topup_orders;
create trigger trg_wolfie_topup_provider_snapshot
before update of provider_customer_id, provider_payment_id
on public.wolfie_topup_orders
for each row execute function private.guard_wolfie_topup_provider_snapshot();

alter function private.guard_wolfie_topup_provider_snapshot() owner to postgres;
revoke all on function private.guard_wolfie_topup_provider_snapshot()
  from public, anon, authenticated, service_role;

-- The legacy five-argument function trusted a webhook-controlled payment id
-- when the local order was not linked yet. Keep it private to the database
-- owner for compatibility with the verified wrapper, but remove worker access.
revoke all on function public.apply_wolfie_topup_payment(
  uuid, text, text, numeric, numeric
) from public, anon, authenticated, service_role;

create or replace function public.apply_verified_wolfie_topup_payment(
  p_order_id uuid,
  p_payment_id text,
  p_event text,
  p_amount_brl numeric,
  p_refunded_amount_brl numeric,
  p_provider_customer_id text,
  p_external_reference text,
  p_billing_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.wolfie_topup_orders%rowtype;
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_customer_id text := nullif(
    pg_catalog.btrim(p_provider_customer_id),
    ''
  );
  v_reference text := nullif(pg_catalog.btrim(p_external_reference), '');
  v_expected_reference text;
begin
  if p_order_id is null
     or v_payment_id is null
     or pg_catalog.char_length(v_payment_id) > 200
     or v_customer_id is null
     or pg_catalog.char_length(v_customer_id) > 200
     or v_reference is null
     or pg_catalog.upper(pg_catalog.btrim(coalesce(p_billing_type, '')))
       <> 'PIX'
  then
    raise exception 'invalid_verified_wolfie_topup_identity';
  end if;

  select orders.*
    into v_order
    from public.wolfie_topup_orders as orders
   where orders.id = p_order_id
   for update;
  if not found then
    raise exception 'wolfie_topup_order_not_found';
  end if;

  v_expected_reference := 'wolfie-topup-order:' || v_order.id::text;
  if v_order.provider_customer_id is null
     or pg_catalog.btrim(v_order.provider_customer_id) <> v_customer_id
     or v_reference <> v_expected_reference
     or pg_catalog.round(v_order.amount_brl, 2)
       is distinct from pg_catalog.round(p_amount_brl, 2)
  then
    raise exception 'wolfie_topup_provider_identity_mismatch';
  end if;

  if v_order.provider_payment_id is not null then
    if pg_catalog.btrim(v_order.provider_payment_id) <> v_payment_id then
      raise exception 'wolfie_topup_payment_mismatch';
    end if;
  elsif not exists (
    select 1
      from public.asaas_provider_creation_attempts as attempt
     where attempt.tenant_id = v_order.tenant_id
       and attempt.operation = 'PAYMENT_CREATE'
       and attempt.logical_key = v_order.id::text
       and attempt.external_reference = v_expected_reference
       and attempt.status = 'SUCCEEDED'
       and pg_catalog.btrim(attempt.provider_entity_id) = v_payment_id
  ) then
    raise exception 'wolfie_topup_provider_creation_unproven';
  end if;

  return public.apply_wolfie_topup_payment(
    p_order_id,
    v_payment_id,
    p_event,
    p_amount_brl,
    p_refunded_amount_brl
  );
end;
$function$;

alter function public.apply_verified_wolfie_topup_payment(
  uuid, text, text, numeric, numeric, text, text, text
) owner to postgres;
revoke all on function public.apply_verified_wolfie_topup_payment(
  uuid, text, text, numeric, numeric, text, text, text
) from public, anon, authenticated;
grant execute on function public.apply_verified_wolfie_topup_payment(
  uuid, text, text, numeric, numeric, text, text, text
) to service_role;

comment on column public.wolfie_topup_orders.provider_customer_id is
  'Immutable canonical Asaas customer snapshot required before linking a top-up payment.';
comment on function public.apply_verified_wolfie_topup_payment(
  uuid, text, text, numeric, numeric, text, text, text
) is
  'Credits or reverses a top-up only after exact customer/reference/type/value proof and an existing local payment link or durable successful creation claim.';

-- A recovered wolfie-direct payment must be adopted under the same account
-- advisory lock as Hub cancellation. Otherwise cancellation could finish
-- between the provider GET and the local payment binding.
create or replace function public.hub_adopt_wolfie_topup_provider_binding(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_account_id uuid,
  p_order_id uuid,
  p_provider_entity_id text,
  p_provider_status text,
  p_provider_customer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_provider_id text := nullif(pg_catalog.btrim(p_provider_entity_id), '');
  v_provider_status text := nullif(pg_catalog.btrim(p_provider_status), '');
  v_customer_id text := nullif(pg_catalog.btrim(p_provider_customer_id), '');
  v_attempt public.asaas_provider_creation_attempts%rowtype;
  v_account public.hub_accounts%rowtype;
  v_order public.wolfie_topup_orders%rowtype;
  v_recorded jsonb;
begin
  perform private.hub_service_role_required();
  if p_attempt_id is null or p_account_id is null or p_order_id is null
     or v_provider_id is null or v_customer_id is null
     or pg_catalog.char_length(v_provider_id) > 200
     or pg_catalog.char_length(v_customer_id) > 200
  then
    raise exception 'invalid_hub_topup_provider_adoption'
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
  select orders.* into v_order
    from public.wolfie_topup_orders as orders
   where orders.id = p_order_id
   for update;
  select attempt.* into v_attempt
    from public.asaas_provider_creation_attempts as attempt
   where attempt.id = p_attempt_id
   for update;

  if v_account.id is null
     or v_account.status <> 'ACTIVE'
     or v_account.account_type <> 'PERSONAL'
     or v_order.id is null
     or v_order.tenant_id <> 'wolfie-direct'
     or v_order.student_id is distinct from v_account.owner_user_id
     or v_order.status not in ('PENDING', 'CREATING', 'AWAITING_PAYMENT')
     or nullif(pg_catalog.btrim(v_order.provider_customer_id), '')
       is distinct from v_customer_id
     or nullif(pg_catalog.btrim(v_account.asaas_customer_id), '')
       is distinct from v_customer_id
     or (
       v_order.provider_payment_id is not null
       and pg_catalog.btrim(v_order.provider_payment_id) <> v_provider_id
     )
     or not exists (
       select 1
         from public.hub_memberships as membership
        where membership.account_id = p_account_id
          and membership.user_id = v_order.student_id
          and membership.membership_role = 'OWNER'
          and membership.status = 'ACTIVE'
     )
     or v_attempt.id is null
     or v_attempt.tenant_id <> 'wolfie-direct'
     or v_attempt.operation <> 'PAYMENT_CREATE'
     or v_attempt.logical_key <> p_order_id::text
     or v_attempt.external_reference <>
       'wolfie-topup-order:' || p_order_id::text
     or exists (
       select 1
         from private.hub_provider_operations as operation
        where operation.account_id = p_account_id
          and operation.status in ('READY', 'IN_PROGRESS', 'BLOCKED')
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'account_lifecycle_fenced'
    );
  end if;

  if v_attempt.status = 'SUCCEEDED' then
    if nullif(pg_catalog.btrim(v_attempt.provider_entity_id), '')
         is distinct from v_provider_id then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'creation_scope_changed'
      );
    end if;
  else
    if p_claim_token is null
       or v_attempt.claim_token is distinct from p_claim_token
       or v_attempt.status not in ('CLAIMED', 'SUBMITTING', 'UNKNOWN')
    then
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

  update public.wolfie_topup_orders as orders
     set provider_payment_id = coalesce(
           orders.provider_payment_id,
           v_provider_id
         ),
         status = 'AWAITING_PAYMENT',
         reconciliation_required = false,
         creation_lease_expires_at = null,
         updated_at = pg_catalog.clock_timestamp()
   where orders.id = p_order_id
     and orders.tenant_id = 'wolfie-direct'
     and orders.student_id = v_account.owner_user_id
     and orders.provider_customer_id = v_customer_id
     and orders.status in ('PENDING', 'CREATING', 'AWAITING_PAYMENT')
     and (
       orders.provider_payment_id is null
       or orders.provider_payment_id = v_provider_id
     );
  if not found then
    raise exception 'hub_topup_provider_adoption_lost'
      using errcode = '55000';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'providerEntityId', v_provider_id,
    'accountId', p_account_id,
    'orderId', p_order_id
  );
end;
$function$;

alter function public.hub_adopt_wolfie_topup_provider_binding(
  uuid, uuid, uuid, uuid, text, text, text
) owner to postgres;
revoke all on function public.hub_adopt_wolfie_topup_provider_binding(
  uuid, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.hub_adopt_wolfie_topup_provider_binding(
  uuid, uuid, uuid, uuid, text, text, text
) to service_role;
