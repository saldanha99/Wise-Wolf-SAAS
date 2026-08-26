-- Durable fencing for the remaining destructive/financial student lifecycle
-- operations. Provider calls happen outside the database, but every call is
-- authorized by an immutable snapshot and a short-lived fencing token.

-- These are operational claims, not financial history. Permanent account
-- deletion is restricted by the application to test fixtures; keeping either
-- FK as RESTRICT would let a completed Pix/message attempt strand the Auth
-- deletion after all provider resources had already been removed.
alter table public.asaas_student_billing_period_claims
  drop constraint if exists asaas_student_billing_period_claims_student_id_fkey;
alter table public.asaas_student_billing_period_claims
  add constraint asaas_student_billing_period_claims_student_id_fkey
  foreign key (student_id) references public.profiles(id) on delete cascade;

alter table public.asaas_outbound_message_attempts
  drop constraint if exists asaas_outbound_message_attempts_student_id_fkey;
alter table public.asaas_outbound_message_attempts
  add constraint asaas_outbound_message_attempts_student_id_fkey
  foreign key (student_id) references public.profiles(id) on delete cascade;

-- Notification rows are disposable delivery state. They must not strand the
-- authorized test-account deletion after provider resources are gone.
alter table public.notification_queue
  drop constraint if exists notification_queue_student_id_fkey;
alter table public.notification_queue
  add constraint notification_queue_student_id_fkey
  foreign key (student_id) references public.profiles(id) on delete cascade;

alter table public.student_overdue_card_charge_claims
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists submitted_at timestamptz,
  add column if not exists completed_at timestamptz;

update public.student_overdue_card_charge_claims
   set claim_token = coalesce(claim_token, gen_random_uuid()),
       lease_expires_at = coalesce(lease_expires_at, updated_at),
       status = case
         when status = 'PROCESSING' then 'UNKNOWN'
         else status
       end
 where claim_token is null
    or lease_expires_at is null
    or status = 'PROCESSING';

alter table public.student_overdue_card_charge_claims
  alter column claim_token set not null,
  alter column lease_expires_at set not null;

revoke all on table public.student_overdue_card_charge_claims
  from service_role;
grant select on table public.student_overdue_card_charge_claims
  to service_role;

alter table public.student_overdue_card_charge_claims
  drop constraint if exists student_overdue_card_charge_claims_status_check;
alter table public.student_overdue_card_charge_claims
  add constraint student_overdue_card_charge_claims_status_check
  check (status in (
    'PROCESSING', 'SUBMITTING', 'SUCCEEDED', 'DECLINED', 'UNKNOWN', 'BLOCKED'
  ));

create or replace function public.claim_student_overdue_card_charge(
  p_tenant_id text,
  p_student_id uuid,
  p_subscription_id text,
  p_payment_id text,
  p_requested_by uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim_row public.student_overdue_card_charge_claims%rowtype;
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  normalized_subscription text := nullif(trim(coalesce(p_subscription_id, '')), '');
  normalized_payment text := nullif(trim(coalesce(p_payment_id, '')), '');
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
  retry_after integer;
  lifecycle_operation_active boolean := false;
begin
  if normalized_tenant is null
     or p_student_id is null
     or normalized_subscription is null
     or normalized_payment is null
     or p_claim_token is null
  then
    raise exception using errcode = '22023', message = 'invalid_overdue_charge_claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' || p_student_id::text,
      0
    )
  );
  if not exists (
    select 1 from public.profiles as profile
     where profile.id = p_student_id
       and profile.tenant_id = normalized_tenant
       and profile.role = 'STUDENT'
       and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
  ) or (
    select count(*) from public.tenant_memberships as membership
     where membership.user_id = p_student_id
  ) <> 1 or not exists (
    select 1 from public.tenant_memberships as membership
     where membership.user_id = p_student_id
       and membership.tenant_id = normalized_tenant
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    return jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'student_lifecycle_inactive'
    );
  end if;

  -- These tables are created later in this same migration. Dynamic lookup
  -- keeps migration parsing ordered while still enforcing the final runtime
  -- contract under the same advisory lock.
  if pg_catalog.to_regclass('public.student_offboarding_operations') is not null then
    execute $sql$
      select exists (
        select 1 from public.student_offboarding_operations
         where tenant_id = $1 and student_id = $2
           and status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
      )
    $sql$ into lifecycle_operation_active using normalized_tenant, p_student_id;
  end if;
  if not lifecycle_operation_active
     and pg_catalog.to_regclass('public.student_account_deletion_claims') is not null
  then
    execute $sql$
      select exists (
        select 1 from public.student_account_deletion_claims
         where tenant_id = $1 and student_id = $2
           and status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
      )
    $sql$ into lifecycle_operation_active using normalized_tenant, p_student_id;
  end if;
  if not lifecycle_operation_active
     and pg_catalog.to_regclass('public.student_billing_method_operations') is not null
  then
    execute $sql$
      select exists (
        select 1 from public.student_billing_method_operations
         where tenant_id = $1 and student_id = $2
           and status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED')
      )
    $sql$ into lifecycle_operation_active using normalized_tenant, p_student_id;
  end if;
  if lifecycle_operation_active then
    return jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'lifecycle_operation_active'
    );
  end if;

  insert into public.student_overdue_card_charge_claims (
    tenant_id,
    student_id,
    asaas_subscription_id,
    asaas_payment_id,
    status,
    requested_by,
    claim_token,
    lease_expires_at,
    processing_started_at,
    updated_at
  ) values (
    normalized_tenant,
    p_student_id,
    normalized_subscription,
    normalized_payment,
    'PROCESSING',
    p_requested_by,
    p_claim_token,
    now() + make_interval(secs => safe_lease),
    now(),
    now()
  ) on conflict (asaas_payment_id) do nothing;

  select charge.*
    into claim_row
    from public.student_overdue_card_charge_claims as charge
   where charge.asaas_payment_id = normalized_payment
   for update;

  if claim_row.tenant_id is distinct from normalized_tenant
     or claim_row.student_id is distinct from p_student_id
     or claim_row.asaas_subscription_id is distinct from normalized_subscription
  then
    if claim_row.status <> 'SUCCEEDED' then
      update public.student_overdue_card_charge_claims
         set status = 'BLOCKED',
             last_error = 'overdue_charge_binding_mismatch',
             lease_expires_at = now(),
             updated_at = now()
       where id = claim_row.id;
    end if;
    return jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'binding_mismatch',
      'claim_id', claim_row.id
    );
  end if;

  if claim_row.status = 'SUCCEEDED' then
    return jsonb_build_object(
      'ok', true,
      'action', 'COMPLETED',
      'claim_id', claim_row.id,
      'provider_status', claim_row.provider_status
    );
  end if;

  -- Once submission starts, no lease expiry can authorize another POST. The
  -- only safe next action is provider GET/manual reconciliation.
  if claim_row.status in ('SUBMITTING', 'UNKNOWN', 'BLOCKED') then
    return jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'provider_outcome_requires_reconciliation',
      'claim_id', claim_row.id,
      'status', claim_row.status
    );
  end if;

  if claim_row.status = 'PROCESSING'
     and claim_row.claim_token <> p_claim_token
     and claim_row.lease_expires_at > now()
  then
    retry_after := greatest(
      1,
      ceil(extract(epoch from (claim_row.lease_expires_at - now())))::integer
    );
    return jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'claim_id', claim_row.id,
      'retry_after_seconds', retry_after
    );
  end if;

  -- PROCESSING has not crossed the submit fence. DECLINED is a proven
  -- deterministic rejection, so a new card may safely start a new attempt.
  update public.student_overdue_card_charge_claims
     set status = 'PROCESSING',
         attempt_count = case
           when claim_token = p_claim_token and status = 'PROCESSING'
             then attempt_count
           else attempt_count + 1
         end,
         requested_by = p_requested_by,
         claim_token = p_claim_token,
         lease_expires_at = now() + make_interval(secs => safe_lease),
         processing_started_at = now(),
         provider_status = null,
         provider_http_status = null,
         last_error = null,
         submitted_at = null,
         completed_at = null,
         updated_at = now()
   where id = claim_row.id
   returning * into claim_row;

  return jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'claim_id', claim_row.id,
    'claim_token', claim_row.claim_token
  );
end;
$function$;

create or replace function public.mark_student_overdue_card_charge_submitting(
  p_claim_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim_row public.student_overdue_card_charge_claims%rowtype;
  changed_id uuid;
begin
  select charge.* into claim_row
    from public.student_overdue_card_charge_claims as charge
   where charge.id = p_claim_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || claim_row.tenant_id || ':' || claim_row.student_id::text,
      0
    )
  );

  update public.student_overdue_card_charge_claims as charge
     set status = 'SUBMITTING',
         submitted_at = now(),
         updated_at = now()
   where charge.id = p_claim_id
     and charge.claim_token = p_claim_token
     and charge.status = 'PROCESSING'
     and charge.lease_expires_at > now()
     and exists (
       select 1 from public.profiles as profile
        where profile.id = charge.student_id
          and profile.tenant_id = charge.tenant_id
          and profile.role = 'STUDENT'
          and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
          and nullif(trim(coalesce(profile.subscription_id, '')), '')
              = charge.asaas_subscription_id
     )
     and (
       select count(*) from public.tenant_memberships as membership
        where membership.user_id = charge.student_id
     ) = 1
     and exists (
       select 1 from public.tenant_memberships as membership
        where membership.user_id = charge.student_id
          and membership.tenant_id = charge.tenant_id
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
     )
     and not exists (
       select 1 from public.student_offboarding_operations as offboarding
        where offboarding.tenant_id = charge.tenant_id
          and offboarding.student_id = charge.student_id
          and offboarding.status in (
            'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
          )
     )
     and not exists (
       select 1 from public.student_account_deletion_claims as deletion
        where deletion.tenant_id = charge.tenant_id
          and deletion.student_id = charge.student_id
          and deletion.status in (
            'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
          )
     )
   returning charge.id into changed_id;
  return jsonb_build_object(
    'ok', changed_id is not null,
    'reason', case when changed_id is null then 'claim_lost' else null end
  );
end;
$function$;

create or replace function public.finish_student_overdue_card_charge(
  p_claim_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_status text default null,
  p_provider_http_status integer default null,
  p_last_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_status text := upper(trim(coalesce(p_status, '')));
  changed_id uuid;
begin
  if normalized_status not in ('SUCCEEDED', 'DECLINED', 'UNKNOWN', 'BLOCKED') then
    raise exception using errcode = '22023', message = 'invalid_overdue_charge_status';
  end if;

  update public.student_overdue_card_charge_claims
     set status = normalized_status,
         provider_status = nullif(trim(coalesce(p_provider_status, '')), ''),
         provider_http_status = p_provider_http_status,
         last_error = nullif(left(coalesce(p_last_error, ''), 500), ''),
         completed_at = case
           when normalized_status in ('SUCCEEDED', 'DECLINED', 'BLOCKED') then now()
           else null
         end,
         lease_expires_at = now(),
         updated_at = now()
   where id = p_claim_id
     and claim_token = p_claim_token
     and (
       (normalized_status = 'SUCCEEDED' and status in ('PROCESSING', 'SUBMITTING', 'UNKNOWN'))
       or (normalized_status = 'BLOCKED' and status in ('PROCESSING', 'SUBMITTING'))
       or (normalized_status in ('DECLINED', 'UNKNOWN') and status = 'SUBMITTING')
       or status = normalized_status
     )
   returning id into changed_id;

  return jsonb_build_object(
    'ok', changed_id is not null,
    'reason', case when changed_id is null then 'claim_lost' else null end
  );
end;
$function$;

alter function public.claim_student_overdue_card_charge(text, uuid, text, text, uuid, uuid, integer) owner to postgres;
alter function public.mark_student_overdue_card_charge_submitting(uuid, uuid) owner to postgres;
alter function public.finish_student_overdue_card_charge(uuid, uuid, text, text, integer, text) owner to postgres;
revoke all on function public.claim_student_overdue_card_charge(text, uuid, text, text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.mark_student_overdue_card_charge_submitting(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_student_overdue_card_charge(uuid, uuid, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.claim_student_overdue_card_charge(text, uuid, text, text, uuid, uuid, integer) to service_role;
grant execute on function public.mark_student_overdue_card_charge_submitting(uuid, uuid) to service_role;
grant execute on function public.finish_student_overdue_card_charge(uuid, uuid, text, text, integer, text) to service_role;

-- A provider creation can finish remotely before its id is bound locally.
-- Keep the student lifecycle locked across that entire span so offboarding
-- cannot snapshot an old null binding and then miss the new provider object.
alter table public.asaas_provider_creation_attempts
  add column if not exists lifecycle_student_id uuid,
  add column if not exists lifecycle_binding_kind text,
  add column if not exists lifecycle_expected_customer_id text,
  add column if not exists lifecycle_bound_at timestamptz,
  add column if not exists lifecycle_released_at timestamptz,
  add column if not exists lifecycle_last_error text;

alter table public.asaas_provider_creation_attempts
  drop constraint if exists asaas_creation_lifecycle_binding_kind_check;
alter table public.asaas_provider_creation_attempts
  add constraint asaas_creation_lifecycle_binding_kind_check check (
    lifecycle_binding_kind is null or lifecycle_binding_kind in (
      'CUSTOMER', 'ENROLLMENT_PAYMENT', 'SUBSCRIPTION',
      'BILLING_PERIOD_PAYMENT', 'STUDENT_PAYMENT', 'TOPUP_ORDER'
    )
  );

create index if not exists asaas_creation_student_lifecycle_active_idx
  on public.asaas_provider_creation_attempts (
    tenant_id, lifecycle_student_id, status
  )
  where lifecycle_student_id is not null
    and lifecycle_released_at is null
    and status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED');

create table if not exists public.student_billing_method_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null,
  requested_by uuid,
  customer_id text not null,
  subscription_id text not null,
  source_billing_type text not null check (
    source_billing_type in ('PIX', 'BOLETO', 'CREDIT_CARD')
  ),
  target_billing_type text not null check (
    target_billing_type in ('PIX', 'BOLETO', 'CREDIT_CARD')
  ),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  integration_snapshot jsonb not null check (
    jsonb_typeof(integration_snapshot) = 'object'
  ),
  status text not null check (
    status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'COMPLETED', 'FAILED', 'BLOCKED')
  ),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  provider_started_at timestamptz,
  completed_at timestamptz,
  provider_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists student_billing_method_one_active_uidx
  on public.student_billing_method_operations (tenant_id, student_id)
  where status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED');
create index if not exists student_billing_method_attention_idx
  on public.student_billing_method_operations (status, updated_at)
  where status in ('MUTATING', 'UNKNOWN', 'BLOCKED');

alter table public.student_billing_method_operations owner to postgres;
alter table public.student_billing_method_operations enable row level security;
alter table public.student_billing_method_operations force row level security;
revoke all on table public.student_billing_method_operations from public, anon, authenticated, service_role;
grant select on table public.student_billing_method_operations to service_role;

create table if not exists public.student_account_deletion_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null,
  requested_by uuid,
  status text not null check (status in (
    'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
    'UNKNOWN', 'COMPLETED', 'BLOCKED'
  )),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  customer_id text,
  subscription_id text,
  billing_cpf_hash text not null check (billing_cpf_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb not null,
  integration_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(integration_snapshot) = 'object'),
  subscription_deleted boolean not null default false,
  customer_deleted boolean not null default false,
  provider_started_at timestamptz,
  provider_completed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id)
);

alter table public.student_account_deletion_claims owner to postgres;
alter table public.student_account_deletion_claims enable row level security;
alter table public.student_account_deletion_claims force row level security;
revoke all on table public.student_account_deletion_claims from public, anon, authenticated, service_role;
grant select on table public.student_account_deletion_claims to service_role;

create index if not exists student_account_deletion_attention_idx
  on public.student_account_deletion_claims (status, updated_at)
  where status in ('PROVIDER_MUTATING', 'UNKNOWN', 'BLOCKED');

create or replace function public.begin_student_account_deletion(
  p_tenant_id text,
  p_student_id uuid,
  p_requested_by uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  profile_row public.profiles%rowtype;
  claim_row public.student_account_deletion_claims%rowtype;
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  billing_cpf text;
  cpf_hash text;
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
  retry_after integer;
  action text;
begin
  if normalized_tenant is null or p_student_id is null or p_claim_token is null then
    raise exception using errcode = '22023', message = 'invalid_student_deletion_claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' || p_student_id::text,
      0
    )
  );

  select deletion.* into claim_row
    from public.student_account_deletion_claims as deletion
   where deletion.student_id = p_student_id
   for update;

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_student_id
   for update;
  if not found then
    if claim_row.id is null
       or claim_row.tenant_id is distinct from normalized_tenant
       or claim_row.status not in ('PROVIDER_COMPLETE', 'COMPLETED')
    then
      return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'profile_missing_before_provider_complete');
    end if;
    if claim_row.status = 'COMPLETED' then
      return jsonb_build_object('ok', true, 'action', 'ALREADY_COMPLETED', 'claim_id', claim_row.id);
    end if;
    update public.student_account_deletion_claims
       set claim_token = p_claim_token,
           requested_by = p_requested_by,
           lease_expires_at = now() + make_interval(secs => safe_lease),
           updated_at = now()
     where id = claim_row.id
     returning * into claim_row;
    return jsonb_build_object(
      'ok', true,
      'action', 'FINALIZE_REQUIRED',
      'claim_id', claim_row.id,
      'claim_token', claim_row.claim_token,
      'tenant_id', claim_row.tenant_id,
      'student_id', claim_row.student_id,
      'customer_id', claim_row.customer_id,
      'subscription_id', claim_row.subscription_id,
      'subscription_deleted', claim_row.subscription_deleted,
      'customer_deleted', claim_row.customer_deleted
    );
  end if;
  if profile_row.tenant_id is distinct from normalized_tenant
     or profile_row.role is distinct from 'STUDENT'
     or lower(trim(coalesce(profile_row.lifecycle_status, ''))) <> 'active'
     or profile_row.is_test_account is not true
  then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'profile_not_deletable');
  end if;

  if (
    select count(*)
      from public.tenant_memberships as membership
     where membership.user_id = p_student_id
  ) <> 1 or not exists (
    select 1
      from public.tenant_memberships as membership
     where membership.user_id = p_student_id
       and membership.tenant_id = normalized_tenant
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'membership_scope_changed');
  end if;
  if exists (
    select 1
      from public.asaas_student_billing_period_claims as billing_claim
     where billing_claim.tenant_id = normalized_tenant
       and billing_claim.student_id = p_student_id
       and billing_claim.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN')
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'billing_creation_in_flight');
  end if;
  if exists (
    select 1
      from public.asaas_provider_creation_attempts as creation
     where creation.tenant_id = normalized_tenant
       and creation.lifecycle_student_id = p_student_id
       and creation.lifecycle_released_at is null
       and creation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED')
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'provider_creation_in_flight');
  end if;
  if exists (
    select 1
      from public.student_overdue_card_charge_claims as charge
     where charge.tenant_id = normalized_tenant
       and charge.student_id = p_student_id
       and (
         charge.status in ('SUBMITTING', 'UNKNOWN')
         or (charge.status = 'PROCESSING' and charge.lease_expires_at > now())
         or (
           charge.status = 'SUCCEEDED'
           and not exists (
             select 1 from public.student_payments as payment
              where payment.tenant_id = normalized_tenant
                and payment.student_id = p_student_id
                and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = charge.asaas_payment_id
                and upper(trim(coalesce(payment.status, ''))) in ('RECEIVED', 'RECEIVED_IN_CASH')
           )
         )
       )
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'overdue_charge_in_flight');
  end if;
  if exists (
    select 1 from public.student_billing_method_operations as billing_method
     where billing_method.tenant_id = normalized_tenant
       and billing_method.student_id = p_student_id
       and billing_method.status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED')
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'billing_method_mutation_in_flight');
  end if;
  update public.asaas_outbound_message_attempts
     set status = 'SUPPRESSED',
         lease_expires_at = now(),
         last_error = 'student_deletion_requested_before_send',
         updated_at = now()
   where tenant_id = normalized_tenant
     and student_id = p_student_id
     and status = 'CLAIMED'
     and submit_attempt_count = 0;
  if exists (
    select 1 from public.asaas_outbound_message_attempts as message_attempt
     where message_attempt.tenant_id = normalized_tenant
       and message_attempt.student_id = p_student_id
       and message_attempt.status in ('SUBMITTING', 'UNKNOWN')
  ) then
    return jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'outbound_message_in_flight'
    );
  end if;

  billing_cpf := regexp_replace(
    case
      when profile_row.guardian_id is not null
        or nullif(trim(coalesce(profile_row.guardian_cpf, '')), '') is not null
        then coalesce(profile_row.guardian_cpf, '')
      else coalesce(profile_row.cpf, '')
    end,
    '[^0-9]', '', 'g'
  );
  if length(billing_cpf) <> 11 then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'billing_cpf_invalid');
  end if;
  cpf_hash := encode(extensions.digest(pg_catalog.convert_to(billing_cpf, 'UTF8'), 'sha256'), 'hex');

  insert into public.student_account_deletion_claims (
    tenant_id, student_id, requested_by, status, claim_token,
    lease_expires_at, customer_id, subscription_id, billing_cpf_hash,
    snapshot, subscription_deleted, customer_deleted
  ) values (
    normalized_tenant, p_student_id, p_requested_by, 'CLAIMED', p_claim_token,
    now() + make_interval(secs => safe_lease),
    nullif(trim(coalesce(profile_row.asaas_customer_id, '')), ''),
    nullif(trim(coalesce(profile_row.subscription_id, '')), ''),
    cpf_hash,
    jsonb_build_object(
      'tenant_id', normalized_tenant,
      'student_id', p_student_id,
      'role', profile_row.role,
      'lifecycle_status', profile_row.lifecycle_status,
      'is_test_account', profile_row.is_test_account,
      'customer_id', nullif(trim(coalesce(profile_row.asaas_customer_id, '')), ''),
      'subscription_id', nullif(trim(coalesce(profile_row.subscription_id, '')), ''),
      'billing_cpf_hash', cpf_hash
    ),
    nullif(trim(coalesce(profile_row.subscription_id, '')), '') is null,
    nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '') is null
  ) on conflict (student_id) do nothing;

  select deletion.* into claim_row
    from public.student_account_deletion_claims as deletion
   where deletion.student_id = p_student_id
   for update;

  if claim_row.tenant_id is distinct from normalized_tenant
     or claim_row.customer_id is distinct from nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
     or claim_row.subscription_id is distinct from nullif(trim(coalesce(profile_row.subscription_id, '')), '')
     or claim_row.billing_cpf_hash is distinct from cpf_hash
  then
    update public.student_account_deletion_claims
       set status = 'BLOCKED', last_error = 'deletion_snapshot_mismatch', updated_at = now()
     where id = claim_row.id and status <> 'COMPLETED';
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'snapshot_mismatch', 'claim_id', claim_row.id);
  end if;

  if claim_row.status = 'COMPLETED' then
    return jsonb_build_object('ok', true, 'action', 'ALREADY_COMPLETED', 'claim_id', claim_row.id);
  end if;
  if claim_row.status = 'BLOCKED' then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'claim_id', claim_row.id);
  end if;
  if claim_row.status = 'CLAIMED'
     and claim_row.claim_token <> p_claim_token
     and claim_row.lease_expires_at > now()
  then
    retry_after := greatest(1, ceil(extract(epoch from (claim_row.lease_expires_at - now())))::integer);
    return jsonb_build_object('ok', true, 'action', 'IN_PROGRESS', 'claim_id', claim_row.id, 'retry_after_seconds', retry_after);
  end if;

  action := case
    when claim_row.status in ('PROVIDER_MUTATING', 'UNKNOWN') then 'RECONCILE_REQUIRED'
    when claim_row.status = 'PROVIDER_COMPLETE' then 'FINALIZE_REQUIRED'
    else 'PROCEED'
  end;
  update public.student_account_deletion_claims
     set claim_token = p_claim_token,
         requested_by = p_requested_by,
         lease_expires_at = now() + make_interval(secs => safe_lease),
         updated_at = now()
   where id = claim_row.id
   returning * into claim_row;

  return jsonb_build_object(
    'ok', true,
    'action', action,
    'claim_id', claim_row.id,
    'claim_token', claim_row.claim_token,
    'tenant_id', claim_row.tenant_id,
    'student_id', claim_row.student_id,
    'customer_id', claim_row.customer_id,
    'subscription_id', claim_row.subscription_id,
    'billing_cpf', billing_cpf,
    'subscription_deleted', claim_row.subscription_deleted,
    'customer_deleted', claim_row.customer_deleted
  );
end;
$function$;

create or replace function public.bind_student_account_deletion_integrations(
  p_claim_id uuid,
  p_claim_token uuid,
  p_subscription_integration_id text,
  p_subscription_version integer,
  p_subscription_environment text,
  p_subscription_mode text,
  p_customer_integration_id text,
  p_customer_version integer,
  p_customer_environment text,
  p_customer_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim_row public.student_account_deletion_claims%rowtype;
  expected_snapshot jsonb;
begin
  select deletion.* into claim_row
    from public.student_account_deletion_claims as deletion
   where deletion.id = p_claim_id
   for update;
  if not found
     or claim_row.claim_token is distinct from p_claim_token
     or claim_row.status not in ('CLAIMED', 'PROVIDER_MUTATING', 'UNKNOWN')
  then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if (claim_row.subscription_id is null) is distinct from (p_subscription_integration_id is null)
     or (claim_row.customer_id is null) is distinct from (p_customer_integration_id is null)
     or (p_subscription_integration_id is not null and (
       nullif(trim(p_subscription_integration_id), '') is null
       or coalesce(p_subscription_version, 0) < 1
       or p_subscription_environment not in ('platform', 'production', 'sandbox')
       or p_subscription_mode not in ('PLATFORM_MANAGED_ROOT', 'PLATFORM_MANAGED_SUBACCOUNT', 'TENANT_BYOK')
     ))
     or (p_customer_integration_id is not null and (
       nullif(trim(p_customer_integration_id), '') is null
       or coalesce(p_customer_version, 0) < 1
       or p_customer_environment not in ('platform', 'production', 'sandbox')
       or p_customer_mode not in ('PLATFORM_MANAGED_ROOT', 'PLATFORM_MANAGED_SUBACCOUNT', 'TENANT_BYOK')
     ))
  then
    update public.student_account_deletion_claims
       set status = 'BLOCKED', last_error = 'integration_snapshot_invalid', updated_at = now()
     where id = claim_row.id;
    return jsonb_build_object('ok', false, 'reason', 'integration_snapshot_invalid');
  end if;

  expected_snapshot := jsonb_build_object(
    'subscription', case when p_subscription_integration_id is null then null else jsonb_build_object(
      'integration_id', trim(p_subscription_integration_id),
      'version', p_subscription_version,
      'environment', p_subscription_environment,
      'mode', p_subscription_mode
    ) end,
    'customer', case when p_customer_integration_id is null then null else jsonb_build_object(
      'integration_id', trim(p_customer_integration_id),
      'version', p_customer_version,
      'environment', p_customer_environment,
      'mode', p_customer_mode
    ) end
  );

  if claim_row.integration_snapshot = '{}'::jsonb then
    update public.student_account_deletion_claims
       set integration_snapshot = expected_snapshot,
           status = case
             when subscription_deleted and customer_deleted
               then 'PROVIDER_COMPLETE'
             else status
           end,
           provider_completed_at = case
             when subscription_deleted and customer_deleted
               then coalesce(provider_completed_at, now())
             else provider_completed_at
           end,
           lease_expires_at = case
             when subscription_deleted and customer_deleted then now()
             else lease_expires_at
           end,
           updated_at = now()
     where id = claim_row.id;
    return jsonb_build_object(
      'ok', true,
      'action', case
        when claim_row.subscription_deleted and claim_row.customer_deleted
          then 'BOUND_PROVIDER_COMPLETE'
        else 'BOUND'
      end
    );
  end if;
  if claim_row.integration_snapshot is distinct from expected_snapshot then
    update public.student_account_deletion_claims
       set status = 'BLOCKED',
           last_error = 'integration_context_changed',
           lease_expires_at = now(),
           updated_at = now()
     where id = claim_row.id;
    return jsonb_build_object('ok', false, 'reason', 'integration_context_changed');
  end if;
  if claim_row.subscription_deleted and claim_row.customer_deleted then
    update public.student_account_deletion_claims
       set status = 'PROVIDER_COMPLETE',
           provider_completed_at = coalesce(provider_completed_at, now()),
           lease_expires_at = now(),
           updated_at = now()
     where id = claim_row.id;
    return jsonb_build_object('ok', true, 'action', 'ALREADY_BOUND_PROVIDER_COMPLETE');
  end if;
  return jsonb_build_object('ok', true, 'action', 'ALREADY_BOUND');
end;
$function$;

create or replace function public.record_student_account_deletion_provider_state(
  p_claim_id uuid,
  p_claim_token uuid,
  p_resource text,
  p_outcome text,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_resource text := lower(trim(coalesce(p_resource, '')));
  normalized_outcome text := upper(trim(coalesce(p_outcome, '')));
  changed_id uuid;
begin
  if normalized_resource not in ('subscription', 'customer')
     or normalized_outcome not in ('STARTED', 'DELETED', 'ABSENT', 'UNKNOWN', 'FAILED')
  then
    raise exception using errcode = '22023', message = 'invalid_deletion_provider_state';
  end if;

  update public.student_account_deletion_claims
     set status = case
           when status = 'PROVIDER_COMPLETE' then 'PROVIDER_COMPLETE'
           when normalized_outcome in ('UNKNOWN', 'FAILED') then 'UNKNOWN'
           when (
             (normalized_resource = 'subscription' or subscription_deleted)
             and (normalized_resource = 'customer' or customer_deleted)
             and normalized_outcome in ('DELETED', 'ABSENT')
           ) then 'PROVIDER_COMPLETE'
           else 'PROVIDER_MUTATING'
         end,
         subscription_deleted = subscription_deleted or (
           normalized_resource = 'subscription' and normalized_outcome in ('DELETED', 'ABSENT')
         ),
         customer_deleted = customer_deleted or (
           normalized_resource = 'customer' and normalized_outcome in ('DELETED', 'ABSENT')
         ),
         provider_started_at = coalesce(provider_started_at, now()),
         provider_completed_at = case
           when status = 'PROVIDER_COMPLETE' then provider_completed_at
           when (
             (subscription_deleted or (normalized_resource = 'subscription' and normalized_outcome in ('DELETED', 'ABSENT')))
             and (customer_deleted or (normalized_resource = 'customer' and normalized_outcome in ('DELETED', 'ABSENT')))
           ) then now()
           else provider_completed_at
         end,
         last_error = case
           when status = 'PROVIDER_COMPLETE' then last_error
           else nullif(left(coalesce(p_error, ''), 500), '')
         end,
         updated_at = now()
   where id = p_claim_id
     and claim_token = p_claim_token
     and integration_snapshot <> '{}'::jsonb
     and status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN')
   returning id into changed_id;
  return jsonb_build_object('ok', changed_id is not null, 'reason', case when changed_id is null then 'claim_lost' else null end);
end;
$function$;

create or replace function public.finalize_student_account_deletion(
  p_claim_id uuid,
  p_claim_token uuid,
  p_profile_absent boolean,
  p_auth_absent boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim_tenant_id text;
  claim_student_id uuid;
  changed_id uuid;
begin
  if p_profile_absent is not true or p_auth_absent is not true then
    return jsonb_build_object('ok', false, 'reason', 'local_deletion_unverified');
  end if;

  -- Resolve the immutable lock identity without holding a row lock, then take
  -- the lifecycle advisory before the claim row. This matches every begin/apply
  -- path and avoids operation-row/advisory lock inversion.
  select deletion.tenant_id, deletion.student_id
    into claim_tenant_id, claim_student_id
    from public.student_account_deletion_claims as deletion
   where deletion.id = p_claim_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || claim_tenant_id || ':' || claim_student_id::text,
      0
    )
  );

  update public.student_account_deletion_claims
     set status = 'COMPLETED', completed_at = now(), lease_expires_at = now(), updated_at = now()
   where id = p_claim_id
     and tenant_id = claim_tenant_id
     and student_id = claim_student_id
     and claim_token = p_claim_token
     and status = 'PROVIDER_COMPLETE'
     and subscription_deleted
     and customer_deleted
   returning id into changed_id;
  return jsonb_build_object('ok', changed_id is not null, 'reason', case when changed_id is null then 'claim_lost' else null end);
end;
$function$;

create table if not exists public.student_offboarding_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null,
  requested_by uuid,
  source_lifecycle_status text not null,
  target_lifecycle_status text not null check (target_lifecycle_status in ('suspended', 'offboarded')),
  reason text,
  status text not null check (status in (
    'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
    'UNKNOWN', 'COMPLETED', 'BLOCKED'
  )),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  customer_id text,
  subscription_id text,
  enrollment_payment_id text,
  payment_snapshot jsonb not null default '[]'::jsonb,
  snapshot jsonb not null,
  integration_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(integration_snapshot) = 'object'),
  provider_started_at timestamptz,
  provider_completed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists student_offboarding_one_active_uidx
  on public.student_offboarding_operations (tenant_id, student_id)
  where status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED');
create index if not exists student_offboarding_attention_idx
  on public.student_offboarding_operations (status, updated_at)
  where status in ('PROVIDER_MUTATING', 'UNKNOWN', 'BLOCKED');

alter table public.student_offboarding_operations owner to postgres;
alter table public.student_offboarding_operations enable row level security;
alter table public.student_offboarding_operations force row level security;
revoke all on table public.student_offboarding_operations from public, anon, authenticated, service_role;
grant select on table public.student_offboarding_operations to service_role;

-- A manual Pix notification is an irreversible provider mutation too. Keep
-- its claim and the final pre-submit transition on the same student lifecycle
-- advisory lock used by billing creation, offboarding and deletion. An
-- offboarding/deletion request may safely suppress an unsubmitted CLAIMED
-- message, but SUBMITTING/UNKNOWN remains review-blocking because delivery may
-- already have happened.
create or replace function public.claim_asaas_outbound_message(
  p_tenant_id text,
  p_student_id uuid,
  p_provider_entity_id text,
  p_notification_kind text,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_outbound_message_attempts%rowtype;
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  normalized_provider_id text := nullif(pg_catalog.btrim(coalesce(p_provider_entity_id, '')), '');
  normalized_kind text := upper(pg_catalog.btrim(coalesce(p_notification_kind, '')));
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
begin
  if normalized_tenant is null or p_student_id is null
     or normalized_provider_id is null or length(normalized_provider_id) > 240
     or normalized_kind !~ '^[A-Z0-9_]{1,80}$' or p_claim_token is null
  then
    raise exception using errcode = '22023', message = 'invalid_outbound_message_claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' || p_student_id::text,
      0
    )
  );

  if not exists (
    select 1 from public.profiles as profile
     where profile.id = p_student_id
       and profile.tenant_id = normalized_tenant
       and profile.role = 'STUDENT'
       and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
  ) or (
    select count(*) from public.tenant_memberships as membership
     where membership.user_id = p_student_id
  ) <> 1 or not exists (
    select 1 from public.tenant_memberships as membership
     where membership.user_id = p_student_id
       and membership.tenant_id = normalized_tenant
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'student_lifecycle_inactive'
    );
  end if;

  if exists (
    select 1 from public.student_offboarding_operations as operation
     where operation.tenant_id = normalized_tenant
       and operation.student_id = p_student_id
       and operation.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  ) or exists (
    select 1 from public.student_account_deletion_claims as deletion
     where deletion.tenant_id = normalized_tenant
       and deletion.student_id = p_student_id
       and deletion.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'lifecycle_operation_active'
    );
  end if;

  insert into public.asaas_outbound_message_attempts (
    tenant_id, student_id, provider_entity_id, notification_kind,
    claim_token, lease_expires_at
  ) values (
    normalized_tenant, p_student_id, normalized_provider_id, normalized_kind,
    p_claim_token, now() + pg_catalog.make_interval(secs => safe_lease)
  ) on conflict (tenant_id, provider_entity_id, notification_kind) do nothing;

  select message_attempt.* into attempt_row
    from public.asaas_outbound_message_attempts as message_attempt
   where message_attempt.tenant_id = normalized_tenant
     and message_attempt.provider_entity_id = normalized_provider_id
     and message_attempt.notification_kind = normalized_kind
   for update;

  if attempt_row.student_id is distinct from p_student_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'outbound_message_student_mismatch',
      'attempt_id', attempt_row.id
    );
  end if;
  if attempt_row.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED')
     or attempt_row.submit_attempt_count > 0
  then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'action', 'ALREADY_FINAL',
      'attempt_id', attempt_row.id, 'status', attempt_row.status
    );
  end if;
  if attempt_row.claim_token is distinct from p_claim_token
     and attempt_row.lease_expires_at > now()
  then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'action', 'IN_PROGRESS',
      'attempt_id', attempt_row.id, 'status', attempt_row.status
    );
  end if;

  update public.asaas_outbound_message_attempts
     set claim_token = p_claim_token,
         lease_expires_at = now() + pg_catalog.make_interval(secs => safe_lease),
         updated_at = now()
   where id = attempt_row.id
   returning * into attempt_row;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'action', 'SUBMIT_ONCE', 'attempt_id', attempt_row.id,
    'claim_token', attempt_row.claim_token, 'status', attempt_row.status
  );
end;
$function$;

create or replace function public.mark_asaas_outbound_message_submitting(
  p_attempt_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_outbound_message_attempts%rowtype;
  lifecycle_blocked boolean;
  payment_notification_invalid boolean := false;
  communication_disabled boolean := false;
  source_payment_status text;
begin
  -- Read immutable scope first, then take the advisory lock, then lock/re-read
  -- the row. This keeps lock ordering aligned with begin_* and avoids a
  -- row-lock/advisory-lock deadlock.
  select message_attempt.* into attempt_row
    from public.asaas_outbound_message_attempts as message_attempt
   where message_attempt.id = p_attempt_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || attempt_row.tenant_id || ':' || attempt_row.student_id::text,
      0
    )
  );

  select message_attempt.* into attempt_row
    from public.asaas_outbound_message_attempts as message_attempt
   where message_attempt.id = p_attempt_id
   for update;
  if not found or attempt_row.status <> 'CLAIMED'
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.lease_expires_at <= now()
     or attempt_row.submit_attempt_count <> 0
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  lifecycle_blocked := not exists (
    select 1 from public.profiles as profile
     where profile.id = attempt_row.student_id
       and profile.tenant_id = attempt_row.tenant_id
       and profile.role = 'STUDENT'
       and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
  ) or (
    select count(*) from public.tenant_memberships as membership
     where membership.user_id = attempt_row.student_id
  ) <> 1 or not exists (
    select 1 from public.tenant_memberships as membership
     where membership.user_id = attempt_row.student_id
       and membership.tenant_id = attempt_row.tenant_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) or exists (
    select 1 from public.student_offboarding_operations as operation
     where operation.tenant_id = attempt_row.tenant_id
       and operation.student_id = attempt_row.student_id
       and operation.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  ) or exists (
    select 1 from public.student_account_deletion_claims as deletion
     where deletion.tenant_id = attempt_row.tenant_id
       and deletion.student_id = attempt_row.student_id
       and deletion.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  );

  if attempt_row.notification_kind in (
    'PAYMENT_CONFIRMED_CAPI', 'PAYMENT_CONFIRMED_WHATSAPP',
    'PAYMENT_DUE_REMINDER', 'PAYMENT_OVERDUE_3',
    'PAYMENT_OVERDUE_10', 'PAYMENT_OVERDUE_20'
  ) then
    select upper(pg_catalog.btrim(coalesce(payment.status, '')))
      into source_payment_status
      from public.student_payments as payment
     where payment.id::text = attempt_row.provider_entity_id
       and payment.tenant_id = attempt_row.tenant_id
       and payment.student_id = attempt_row.student_id
     for update;
    payment_notification_invalid := not found
      or case
        when attempt_row.notification_kind in (
          'PAYMENT_CONFIRMED_CAPI', 'PAYMENT_CONFIRMED_WHATSAPP'
        ) then source_payment_status not in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
        when attempt_row.notification_kind = 'PAYMENT_DUE_REMINDER'
          then source_payment_status <> 'PENDING'
        else source_payment_status not in ('PENDING', 'OVERDUE')
      end;
  end if;

  if attempt_row.notification_kind in (
    'MANUAL_PIX_CREATED', 'PAYMENT_CONFIRMED_WHATSAPP',
    'PAYMENT_DUE_REMINDER', 'PAYMENT_OVERDUE_3',
    'PAYMENT_OVERDUE_10', 'PAYMENT_OVERDUE_20'
  ) then
    communication_disabled := true;
    select not (
      coalesce(tenant.whatsapp_enabled, false)
      and coalesce(settings.student_notifications_enabled, false)
    )
      into communication_disabled
      from public.tenants as tenant
      left join public.tenant_admin_settings as settings
        on settings.tenant_id = tenant.id
     where tenant.id = attempt_row.tenant_id;
  end if;

  if lifecycle_blocked or payment_notification_invalid
     or communication_disabled
  then
    update public.asaas_outbound_message_attempts
       set status = 'SUPPRESSED',
           lease_expires_at = now(),
           last_error = case
             when lifecycle_blocked then 'student_lifecycle_inactive_before_send'
             when payment_notification_invalid
               then 'payment_state_changed_before_notification_send'
             else 'student_notifications_disabled_before_send'
           end,
           updated_at = now()
     where id = attempt_row.id
       and status = 'CLAIMED'
       and submit_attempt_count = 0;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'SUPPRESSED',
      'status', 'SUPPRESSED', 'reason', case
        when lifecycle_blocked then 'student_lifecycle_inactive'
        when payment_notification_invalid
          then 'payment_state_changed_before_notification_send'
        else 'student_notifications_disabled_before_send'
      end
    );
  end if;

  update public.asaas_outbound_message_attempts
     set status = 'SUBMITTING', submit_attempt_count = 1,
         lease_expires_at = now() + interval '10 minutes', updated_at = now()
   where id = attempt_row.id;
  return pg_catalog.jsonb_build_object('ok', true, 'status', 'SUBMITTING');
end;
$function$;

create or replace function public.bind_student_asaas_creation_lifecycle(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_tenant_id text,
  p_student_id uuid,
  p_binding_kind text,
  p_expected_customer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_provider_creation_attempts%rowtype;
  profile_row public.profiles%rowtype;
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  normalized_kind text := upper(trim(coalesce(p_binding_kind, '')));
  normalized_customer text := nullif(trim(coalesce(p_expected_customer_id, '')), '');
  normalized_provider_entity text;
  already_bound boolean;
  exact_succeeded_legacy_binding boolean := false;
begin
  if p_attempt_id is null or normalized_tenant is null or p_student_id is null
     or normalized_kind not in (
       'CUSTOMER', 'ENROLLMENT_PAYMENT', 'SUBSCRIPTION',
       'BILLING_PERIOD_PAYMENT', 'STUDENT_PAYMENT', 'TOPUP_ORDER'
     )
  then
    raise exception using errcode = '22023', message = 'invalid_student_creation_lifecycle_binding';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' || p_student_id::text,
      0
    )
  );

  select attempt.* into attempt_row
    from public.asaas_provider_creation_attempts as attempt
   where attempt.id = p_attempt_id
   for update;
  if not found
     or attempt_row.tenant_id is distinct from normalized_tenant
     or attempt_row.status not in ('CLAIMED', 'UNKNOWN', 'SUCCEEDED')
     or (attempt_row.status <> 'SUCCEEDED' and attempt_row.claim_token is distinct from p_claim_token)
     or (normalized_kind = 'CUSTOMER' and attempt_row.operation <> 'CUSTOMER_CREATE')
     or (normalized_kind in ('ENROLLMENT_PAYMENT', 'BILLING_PERIOD_PAYMENT', 'STUDENT_PAYMENT', 'TOPUP_ORDER') and attempt_row.operation <> 'PAYMENT_CREATE')
     or (normalized_kind = 'SUBSCRIPTION' and attempt_row.operation <> 'SUBSCRIPTION_CREATE')
  then
    return jsonb_build_object('ok', false, 'reason', 'creation_claim_lost');
  end if;

  already_bound := attempt_row.lifecycle_student_id is not null;
  normalized_provider_entity := nullif(
    trim(coalesce(attempt_row.provider_entity_id, '')),
    ''
  );
  if already_bound and (
    attempt_row.lifecycle_student_id is distinct from p_student_id
    or attempt_row.lifecycle_binding_kind is distinct from normalized_kind
    or attempt_row.lifecycle_expected_customer_id is distinct from normalized_customer
  ) then
    update public.asaas_provider_creation_attempts
       set lifecycle_last_error = 'student_creation_lifecycle_binding_mismatch',
           updated_at = now()
     where id = attempt_row.id;
    return jsonb_build_object('ok', false, 'reason', 'lifecycle_binding_mismatch');
  end if;

  -- CUSTOMER/SUBSCRIPTION/ENROLLMENT are singleton bindings on profiles. The
  -- logical creation key differs between some callers, so the lifecycle
  -- advisory lock must also prevent two distinct durable attempts from both
  -- observing the same null local field and crossing separate POST fences.
  if normalized_kind in ('CUSTOMER', 'ENROLLMENT_PAYMENT', 'SUBSCRIPTION')
     and exists (
       select 1
         from public.asaas_provider_creation_attempts as competing
        where competing.id <> attempt_row.id
          and competing.tenant_id = normalized_tenant
          and competing.lifecycle_student_id = p_student_id
          and competing.lifecycle_binding_kind = normalized_kind
          and competing.lifecycle_released_at is null
          and competing.status in (
            'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED'
          )
     )
  then
    return jsonb_build_object(
      'ok', false,
      'reason', 'singleton_creation_binding_in_flight'
    );
  end if;

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_student_id
     and profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
   for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'student_lifecycle_inactive');
  end if;

  if normalized_kind = 'CUSTOMER' then
    exact_succeeded_legacy_binding := not already_bound
      and attempt_row.status = 'SUCCEEDED'
      and normalized_provider_entity is not null
      and nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
          is not distinct from normalized_provider_entity;
    if normalized_customer is not null
       or (
         nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '') is not null
         and (
           (not already_bound and not exact_succeeded_legacy_binding)
           or nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
              is distinct from normalized_provider_entity
         )
       )
    then
      return jsonb_build_object('ok', false, 'reason', 'student_customer_binding_changed');
    end if;
  elsif normalized_customer is null
        or nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
           is distinct from normalized_customer
  then
    return jsonb_build_object('ok', false, 'reason', 'student_customer_binding_changed');
  end if;

  if normalized_kind = 'ENROLLMENT_PAYMENT'
     and nullif(trim(coalesce(profile_row.enrollment_payment_id, '')), '') is not null
     and (
       (
         not already_bound
         and not (
           attempt_row.status = 'SUCCEEDED'
           and normalized_provider_entity is not null
           and nullif(trim(coalesce(profile_row.enrollment_payment_id, '')), '')
               is not distinct from normalized_provider_entity
         )
       )
       or nullif(trim(coalesce(profile_row.enrollment_payment_id, '')), '')
          is distinct from normalized_provider_entity
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'student_payment_binding_changed');
  end if;
  if normalized_kind = 'SUBSCRIPTION'
     and nullif(trim(coalesce(profile_row.subscription_id, '')), '') is not null
     and (
       (
         not already_bound
         and not (
           attempt_row.status = 'SUCCEEDED'
           and normalized_provider_entity is not null
           and nullif(trim(coalesce(profile_row.subscription_id, '')), '')
               is not distinct from normalized_provider_entity
         )
       )
       or nullif(trim(coalesce(profile_row.subscription_id, '')), '')
          is distinct from normalized_provider_entity
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'student_subscription_binding_changed');
  end if;
  if normalized_kind = 'TOPUP_ORDER' and (
    attempt_row.logical_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or attempt_row.external_reference is distinct from 'wolfie-topup-order:' || attempt_row.logical_key
    or not exists (
      select 1 from public.wolfie_topup_orders as topup
       where topup.id::text = attempt_row.logical_key
         and topup.tenant_id = normalized_tenant
         and topup.student_id = p_student_id
         and topup.status in ('PENDING', 'CREATING')
         and topup.provider_payment_id is null
    )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'topup_order_binding_changed');
  end if;

  if (
    select count(*) from public.tenant_memberships as membership
     where membership.user_id = p_student_id
  ) <> 1 or not exists (
    select 1 from public.tenant_memberships as membership
     where membership.user_id = p_student_id
       and membership.tenant_id = normalized_tenant
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'student_membership_changed');
  end if;

  if exists (
    select 1 from public.student_offboarding_operations as operation
     where operation.tenant_id = normalized_tenant
       and operation.student_id = p_student_id
       and operation.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
  ) or exists (
    select 1 from public.student_account_deletion_claims as deletion
     where deletion.tenant_id = normalized_tenant
       and deletion.student_id = p_student_id
       and deletion.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
  ) or exists (
    select 1 from public.student_billing_method_operations as billing_method
     where billing_method.tenant_id = normalized_tenant
       and billing_method.student_id = p_student_id
       and billing_method.status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'lifecycle_operation_active');
  end if;

  update public.asaas_provider_creation_attempts
     set lifecycle_student_id = p_student_id,
         lifecycle_binding_kind = normalized_kind,
         lifecycle_expected_customer_id = normalized_customer,
         lifecycle_bound_at = coalesce(lifecycle_bound_at, now()),
         lifecycle_released_at = null,
         lifecycle_last_error = null,
         updated_at = now()
   where id = attempt_row.id;
  return jsonb_build_object(
    'ok', true,
    'action', case when already_bound then 'ALREADY_BOUND' else 'BOUND' end
  );
end;
$function$;

create or replace function public.mark_student_asaas_creation_submitting(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_tenant_id text,
  p_student_id uuid,
  p_binding_kind text,
  p_expected_customer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  bound jsonb;
begin
  bound := public.bind_student_asaas_creation_lifecycle(
    p_attempt_id,
    p_claim_token,
    p_tenant_id,
    p_student_id,
    p_binding_kind,
    p_expected_customer_id
  );
  if coalesce((bound ->> 'ok')::boolean, false) is not true then
    return bound;
  end if;
  return public.mark_asaas_provider_creation_submitting(
    p_attempt_id,
    p_claim_token
  );
end;
$function$;

create or replace function public.release_student_asaas_creation_lifecycle(
  p_attempt_id uuid,
  p_tenant_id text,
  p_student_id uuid,
  p_provider_entity_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_provider_creation_attempts%rowtype;
  profile_row public.profiles%rowtype;
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  normalized_provider_id text := nullif(trim(coalesce(p_provider_entity_id, '')), '');
  local_binding_matches boolean := false;
begin
  if p_attempt_id is null or normalized_tenant is null or p_student_id is null
     or normalized_provider_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_student_creation_lifecycle_release';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' || p_student_id::text,
      0
    )
  );
  select attempt.* into attempt_row
    from public.asaas_provider_creation_attempts as attempt
   where attempt.id = p_attempt_id
   for update;
  if not found
     or attempt_row.tenant_id is distinct from normalized_tenant
     or attempt_row.lifecycle_student_id is distinct from p_student_id
     or attempt_row.lifecycle_bound_at is null
     or attempt_row.status <> 'SUCCEEDED'
     or attempt_row.provider_entity_id is distinct from normalized_provider_id
  then
    return jsonb_build_object('ok', false, 'reason', 'creation_binding_not_ready');
  end if;
  if attempt_row.lifecycle_released_at is not null then
    return jsonb_build_object('ok', true, 'action', 'ALREADY_RELEASED');
  end if;

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_student_id
     and profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
   for share;
  if not found
     or (
       select count(*) from public.tenant_memberships as membership
        where membership.user_id = p_student_id
     ) <> 1
     or not exists (
       select 1 from public.tenant_memberships as membership
        where membership.user_id = p_student_id
          and membership.tenant_id = normalized_tenant
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'student_lifecycle_changed');
  end if;

  local_binding_matches := case attempt_row.lifecycle_binding_kind
    when 'CUSTOMER' then
      nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
        is not distinct from normalized_provider_id
    when 'ENROLLMENT_PAYMENT' then
      nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
        is not distinct from attempt_row.lifecycle_expected_customer_id
      and nullif(trim(coalesce(profile_row.enrollment_payment_id, '')), '')
        is not distinct from normalized_provider_id
    when 'SUBSCRIPTION' then
      nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
        is not distinct from attempt_row.lifecycle_expected_customer_id
      and nullif(trim(coalesce(profile_row.subscription_id, '')), '')
        is not distinct from normalized_provider_id
    when 'BILLING_PERIOD_PAYMENT' then
      nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
        is not distinct from attempt_row.lifecycle_expected_customer_id
      and exists (
        select 1 from public.asaas_student_billing_period_claims as billing
         where billing.tenant_id = normalized_tenant
           and billing.student_id = p_student_id
           and billing.provider_entity_id = normalized_provider_id
           and billing.status = 'BOUND'
      )
      and (
        select count(*) from public.student_payments as payment
         where payment.tenant_id = normalized_tenant
           and payment.student_id = p_student_id
           and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = normalized_provider_id
           and nullif(trim(coalesce(payment.provider_customer_id, '')), '')
                is not distinct from attempt_row.lifecycle_expected_customer_id
           and upper(coalesce(payment.status, '')) = 'PENDING'
           and payment.due_date >= current_date
      ) = 1
    when 'STUDENT_PAYMENT' then
      nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
        is not distinct from attempt_row.lifecycle_expected_customer_id
      and (
        select count(*) from public.student_payments as payment
         where payment.tenant_id = normalized_tenant
           and payment.student_id = p_student_id
           and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = normalized_provider_id
           and nullif(trim(coalesce(payment.provider_customer_id, '')), '')
                is not distinct from attempt_row.lifecycle_expected_customer_id
           and upper(trim(coalesce(payment.status, ''))) in (
             'PENDING', 'OVERDUE', 'RECEIVED', 'RECEIVED_IN_CASH'
           )
      ) = 1
    when 'TOPUP_ORDER' then
      nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
        is not distinct from attempt_row.lifecycle_expected_customer_id
      and exists (
        select 1 from public.wolfie_topup_orders as topup
         where topup.id::text = attempt_row.logical_key
           and topup.tenant_id = normalized_tenant
           and topup.student_id = p_student_id
           and topup.provider_payment_id = normalized_provider_id
           and topup.status = 'AWAITING_PAYMENT'
           and topup.reconciliation_required is false
      )
    else false
  end;
  if local_binding_matches is not true then
    update public.asaas_provider_creation_attempts
       set lifecycle_last_error = 'local_provider_binding_unverified',
           updated_at = now()
     where id = attempt_row.id;
    return jsonb_build_object('ok', false, 'reason', 'local_provider_binding_unverified');
  end if;

  update public.asaas_provider_creation_attempts
     set lifecycle_released_at = now(),
         lifecycle_last_error = null,
         updated_at = now()
   where id = attempt_row.id;
  return jsonb_build_object('ok', true, 'action', 'RELEASED');
end;
$function$;

alter function public.bind_student_asaas_creation_lifecycle(uuid, uuid, text, uuid, text, text) owner to postgres;
alter function public.mark_student_asaas_creation_submitting(uuid, uuid, text, uuid, text, text) owner to postgres;
alter function public.release_student_asaas_creation_lifecycle(uuid, text, uuid, text) owner to postgres;
revoke all on function public.bind_student_asaas_creation_lifecycle(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.mark_student_asaas_creation_submitting(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.release_student_asaas_creation_lifecycle(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.bind_student_asaas_creation_lifecycle(uuid, uuid, text, uuid, text, text) to service_role;
grant execute on function public.mark_student_asaas_creation_submitting(uuid, uuid, text, uuid, text, text) to service_role;
grant execute on function public.release_student_asaas_creation_lifecycle(uuid, text, uuid, text) to service_role;

-- Updating a subscription's billing type/card is a provider mutation, not a
-- harmless profile edit. Keep a durable one-way fence from the first PUT until
-- an exact provider GET proves the requested postcondition. UNKNOWN never
-- authorizes another PUT; it only leases a token for GET reconciliation.
create or replace function public.begin_student_billing_method_operation(
  p_tenant_id text,
  p_student_id uuid,
  p_requested_by uuid,
  p_customer_id text,
  p_subscription_id text,
  p_source_billing_type text,
  p_target_billing_type text,
  p_card_last4 text,
  p_integration_id text,
  p_integration_version integer,
  p_integration_environment text,
  p_integration_mode text,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_row public.student_billing_method_operations%rowtype;
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  normalized_customer text := nullif(trim(coalesce(p_customer_id, '')), '');
  normalized_subscription text := nullif(trim(coalesce(p_subscription_id, '')), '');
  normalized_source text := upper(trim(coalesce(p_source_billing_type, '')));
  normalized_target text := upper(trim(coalesce(p_target_billing_type, '')));
  normalized_last4 text := nullif(regexp_replace(coalesce(p_card_last4, ''), '[^0-9]', '', 'g'), '');
  normalized_integration_id text := nullif(trim(coalesce(p_integration_id, '')), '');
  normalized_integration_environment text := lower(trim(coalesce(p_integration_environment, '')));
  normalized_integration_mode text := upper(trim(coalesce(p_integration_mode, '')));
  expected_integration_snapshot jsonb;
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
  retry_after integer;
begin
  if normalized_tenant is null or p_student_id is null or p_claim_token is null
     or normalized_customer is null or normalized_subscription is null
     or normalized_source not in ('PIX', 'BOLETO', 'CREDIT_CARD')
     or normalized_target not in ('PIX', 'BOLETO', 'CREDIT_CARD')
     or (normalized_target = 'CREDIT_CARD' and normalized_last4 !~ '^[0-9]{4}$')
     or (normalized_target <> 'CREDIT_CARD' and normalized_last4 is not null)
     or normalized_integration_id is null
     or coalesce(p_integration_version, 0) < 1
     or normalized_integration_environment not in ('platform', 'production', 'sandbox')
     or normalized_integration_mode not in ('PLATFORM_MANAGED_ROOT', 'PLATFORM_MANAGED_SUBACCOUNT', 'TENANT_BYOK')
  then
    raise exception using errcode = '22023', message = 'invalid_student_billing_method_operation';
  end if;
  expected_integration_snapshot := jsonb_build_object(
    'integration_id', normalized_integration_id,
    'version', p_integration_version,
    'environment', normalized_integration_environment,
    'mode', normalized_integration_mode
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' || p_student_id::text,
      0
    )
  );

  if not exists (
    select 1 from public.profiles as profile
     where profile.id = p_student_id
       and profile.tenant_id = normalized_tenant
       and profile.role = 'STUDENT'
       and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
       and nullif(trim(coalesce(profile.asaas_customer_id, '')), '') = normalized_customer
       and nullif(trim(coalesce(profile.subscription_id, '')), '') = normalized_subscription
  ) or (
    select count(*) from public.tenant_memberships as membership
     where membership.user_id = p_student_id
  ) <> 1 or not exists (
    select 1 from public.tenant_memberships as membership
     where membership.user_id = p_student_id
       and membership.tenant_id = normalized_tenant
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'student_lifecycle_inactive');
  end if;

  if exists (
    select 1 from public.student_offboarding_operations as offboarding
     where offboarding.tenant_id = normalized_tenant
       and offboarding.student_id = p_student_id
       and offboarding.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
  ) or exists (
    select 1 from public.student_account_deletion_claims as deletion
     where deletion.tenant_id = normalized_tenant
       and deletion.student_id = p_student_id
       and deletion.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'lifecycle_operation_active');
  end if;
  if exists (
    select 1 from public.asaas_provider_creation_attempts as creation
     where creation.tenant_id = normalized_tenant
       and creation.lifecycle_student_id = p_student_id
       and creation.lifecycle_released_at is null
       and creation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED')
  ) or exists (
    select 1 from public.asaas_student_billing_period_claims as billing
     where billing.tenant_id = normalized_tenant
       and billing.student_id = p_student_id
       and billing.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN')
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'billing_creation_in_flight');
  end if;
  if exists (
    select 1 from public.student_overdue_card_charge_claims as charge
     where charge.tenant_id = normalized_tenant
       and charge.student_id = p_student_id
       and (
         charge.status in ('SUBMITTING', 'UNKNOWN')
         or (charge.status = 'PROCESSING' and charge.lease_expires_at > now())
         or (
           charge.status = 'SUCCEEDED'
           and not exists (
             select 1 from public.student_payments as payment
              where payment.tenant_id = normalized_tenant
                and payment.student_id = p_student_id
                and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = charge.asaas_payment_id
                and upper(trim(coalesce(payment.status, ''))) in ('RECEIVED', 'RECEIVED_IN_CASH')
           )
         )
       )
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'overdue_charge_in_flight');
  end if;

  select operation.* into operation_row
    from public.student_billing_method_operations as operation
   where operation.tenant_id = normalized_tenant
     and operation.student_id = p_student_id
     and operation.status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED')
   for update;

  if not found then
    insert into public.student_billing_method_operations (
      tenant_id, student_id, requested_by, customer_id, subscription_id,
      source_billing_type, target_billing_type, card_last4,
      integration_snapshot, status,
      claim_token, lease_expires_at
    ) values (
      normalized_tenant, p_student_id, p_requested_by, normalized_customer,
      normalized_subscription, normalized_source, normalized_target,
      normalized_last4, expected_integration_snapshot, 'CLAIMED', p_claim_token,
      now() + make_interval(secs => safe_lease)
    ) returning * into operation_row;
    return jsonb_build_object(
      'ok', true,
      'action', 'SUBMIT_ONCE',
      'operation_id', operation_row.id,
      'claim_token', operation_row.claim_token,
      'target_billing_type', operation_row.target_billing_type,
      'card_last4', operation_row.card_last4
    );
  end if;

  if operation_row.customer_id is distinct from normalized_customer
     or operation_row.subscription_id is distinct from normalized_subscription
     or operation_row.target_billing_type is distinct from normalized_target
     or operation_row.card_last4 is distinct from normalized_last4
     or operation_row.integration_snapshot is distinct from expected_integration_snapshot
  then
    update public.student_billing_method_operations
       set status = 'BLOCKED',
           last_error = 'billing_method_binding_mismatch',
           lease_expires_at = now(),
           updated_at = now()
     where id = operation_row.id;
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'binding_mismatch', 'operation_id', operation_row.id);
  end if;
  if operation_row.status = 'BLOCKED' then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', coalesce(operation_row.last_error, 'operation_blocked'), 'operation_id', operation_row.id);
  end if;
  if operation_row.status in ('CLAIMED', 'MUTATING')
     and operation_row.claim_token is distinct from p_claim_token
     and operation_row.lease_expires_at > now()
  then
    retry_after := greatest(1, ceil(extract(epoch from (operation_row.lease_expires_at - now())))::integer);
    return jsonb_build_object('ok', true, 'action', 'IN_PROGRESS', 'operation_id', operation_row.id, 'retry_after_seconds', retry_after);
  end if;

  if operation_row.status in ('MUTATING', 'UNKNOWN') then
    update public.student_billing_method_operations
       set status = 'UNKNOWN',
           requested_by = p_requested_by,
           claim_token = p_claim_token,
           lease_expires_at = now() + make_interval(secs => safe_lease),
           updated_at = now()
     where id = operation_row.id
     returning * into operation_row;
    return jsonb_build_object(
      'ok', true,
      'action', 'RECONCILE_REQUIRED',
      'operation_id', operation_row.id,
      'claim_token', operation_row.claim_token,
      'target_billing_type', operation_row.target_billing_type,
      'card_last4', operation_row.card_last4
    );
  end if;

  update public.student_billing_method_operations
     set requested_by = p_requested_by,
         claim_token = p_claim_token,
         lease_expires_at = now() + make_interval(secs => safe_lease),
         updated_at = now()
   where id = operation_row.id
     and status = 'CLAIMED'
   returning * into operation_row;
  return jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'operation_id', operation_row.id,
    'claim_token', operation_row.claim_token,
    'target_billing_type', operation_row.target_billing_type,
    'card_last4', operation_row.card_last4
  );
end;
$function$;

create or replace function public.mark_student_billing_method_mutating(
  p_operation_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_row public.student_billing_method_operations%rowtype;
  changed_id uuid;
begin
  select operation.* into operation_row
    from public.student_billing_method_operations as operation
   where operation.id = p_operation_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || operation_row.tenant_id || ':' || operation_row.student_id::text,
      0
    )
  );
  update public.student_billing_method_operations as operation
     set status = 'MUTATING',
         provider_started_at = coalesce(operation.provider_started_at, now()),
         lease_expires_at = now() + interval '10 minutes',
         updated_at = now()
   where operation.id = p_operation_id
     and operation.claim_token = p_claim_token
     and operation.status = 'CLAIMED'
     and operation.lease_expires_at > now()
     and exists (
       select 1 from public.profiles as profile
        where profile.id = operation.student_id
          and profile.tenant_id = operation.tenant_id
          and profile.role = 'STUDENT'
          and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
          and nullif(trim(coalesce(profile.asaas_customer_id, '')), '') = operation.customer_id
          and nullif(trim(coalesce(profile.subscription_id, '')), '') = operation.subscription_id
     )
     and (
       select count(*) from public.tenant_memberships as membership
        where membership.user_id = operation.student_id
     ) = 1
     and exists (
       select 1 from public.tenant_memberships as membership
        where membership.user_id = operation.student_id
          and membership.tenant_id = operation.tenant_id
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
     )
     and not exists (
       select 1 from public.student_offboarding_operations as offboarding
        where offboarding.tenant_id = operation.tenant_id
          and offboarding.student_id = operation.student_id
          and offboarding.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
     )
     and not exists (
       select 1 from public.student_account_deletion_claims as deletion
        where deletion.tenant_id = operation.tenant_id
          and deletion.student_id = operation.student_id
          and deletion.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
     )
   returning operation.id into changed_id;
  return jsonb_build_object('ok', changed_id is not null, 'reason', case when changed_id is null then 'claim_lost' else null end);
end;
$function$;

create or replace function public.finish_student_billing_method_operation(
  p_operation_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_http_status integer default null,
  p_last_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_outcome text := upper(trim(coalesce(p_outcome, '')));
  changed_id uuid;
begin
  if normalized_outcome not in ('COMPLETE', 'FAILED', 'UNKNOWN', 'BLOCKED') then
    raise exception using errcode = '22023', message = 'invalid_billing_method_outcome';
  end if;
  update public.student_billing_method_operations
     set status = case when normalized_outcome = 'COMPLETE' then 'COMPLETED' else normalized_outcome end,
         provider_http_status = p_provider_http_status,
         last_error = case when normalized_outcome = 'COMPLETE' then null else nullif(left(coalesce(p_last_error, ''), 500), '') end,
         completed_at = case when normalized_outcome in ('COMPLETE', 'FAILED', 'BLOCKED') then coalesce(completed_at, now()) else completed_at end,
         lease_expires_at = now(),
         updated_at = now()
   where id = p_operation_id
     and claim_token = p_claim_token
     and (
       (normalized_outcome = 'COMPLETE' and status in ('MUTATING', 'UNKNOWN'))
       or (normalized_outcome = 'FAILED' and status = 'MUTATING')
       or (normalized_outcome = 'UNKNOWN' and status in ('MUTATING', 'UNKNOWN'))
       or (normalized_outcome = 'BLOCKED' and status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED'))
       or (normalized_outcome = 'COMPLETE' and status = 'COMPLETED')
       or (normalized_outcome = status and status in ('FAILED', 'UNKNOWN', 'BLOCKED'))
     )
   returning id into changed_id;
  return jsonb_build_object('ok', changed_id is not null, 'reason', case when changed_id is null then 'claim_lost' else null end);
end;
$function$;

alter function public.begin_student_billing_method_operation(text, uuid, uuid, text, text, text, text, text, text, integer, text, text, uuid, integer) owner to postgres;
alter function public.mark_student_billing_method_mutating(uuid, uuid) owner to postgres;
alter function public.finish_student_billing_method_operation(uuid, uuid, text, integer, text) owner to postgres;
revoke all on function public.begin_student_billing_method_operation(text, uuid, uuid, text, text, text, text, text, text, integer, text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.mark_student_billing_method_mutating(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_student_billing_method_operation(uuid, uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.begin_student_billing_method_operation(text, uuid, uuid, text, text, text, text, text, text, integer, text, text, uuid, integer) to service_role;
grant execute on function public.mark_student_billing_method_mutating(uuid, uuid) to service_role;
grant execute on function public.finish_student_billing_method_operation(uuid, uuid, text, integer, text) to service_role;

-- A refund and a payment-confirmation send must have one order. Once the send
-- crossed SUBMITTING its outcome may be irreversible, so a concurrent reversal
-- waits for a terminal message state instead of committing between the final
-- payment check and the provider POST.
-- The preceding migration refreshes the public implementation. On a repeated
-- release an older private implementation may already exist, so replace it
-- instead of preserving stale function source behind the new wrapper.
drop function if exists
  public.apply_historical_asaas_payment_reversal_pre_message_fence_impl(
    text, uuid, uuid, text, text, text, text, timestamptz,
    integer, text, numeric, jsonb
  );
alter function public.apply_historical_asaas_payment_reversal(
  text, uuid, uuid, text, text, text, text, timestamptz,
  integer, text, numeric, jsonb
) rename to apply_historical_asaas_payment_reversal_pre_message_fence_impl;

alter function public.apply_historical_asaas_payment_reversal_pre_message_fence_impl(
  text, uuid, uuid, text, text, text, text, timestamptz,
  integer, text, numeric, jsonb
) owner to postgres;
revoke all on function public.apply_historical_asaas_payment_reversal_pre_message_fence_impl(
  text, uuid, uuid, text, text, text, text, timestamptz,
  integer, text, numeric, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.apply_historical_asaas_payment_reversal(
  p_provider_payment_id text,
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_expected_provider_customer_id text,
  p_event_id text,
  p_event_name text,
  p_event_created_at timestamptz,
  p_event_rank integer,
  p_provider_status text,
  p_refunded_amount numeric,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || trim(coalesce(p_expected_tenant_id, '')) ||
        ':' || p_expected_student_id::text,
      0
    )
  );
  if exists (
    select 1
      from public.asaas_outbound_message_attempts as attempt
     where attempt.tenant_id = trim(coalesce(p_expected_tenant_id, ''))
       and attempt.student_id = p_expected_student_id
       and attempt.provider_entity_id = p_expected_local_payment_id::text
       and attempt.notification_kind in (
         'PAYMENT_CONFIRMED_CAPI', 'PAYMENT_CONFIRMED_WHATSAPP'
       )
       and attempt.status in ('SUBMITTING', 'UNKNOWN')
  ) then
    return jsonb_build_object(
      'ok', false,
      'reason', 'payment_confirmation_delivery_in_flight'
    );
  end if;
  return public.apply_historical_asaas_payment_reversal_pre_message_fence_impl(
    p_provider_payment_id,
    p_expected_local_payment_id,
    p_expected_student_id,
    p_expected_tenant_id,
    p_expected_provider_customer_id,
    p_event_id,
    p_event_name,
    p_event_created_at,
    p_event_rank,
    p_provider_status,
    p_refunded_amount,
    p_payload
  );
end;
$function$;

alter function public.apply_historical_asaas_payment_reversal(
  text, uuid, uuid, text, text, text, text, timestamptz,
  integer, text, numeric, jsonb
) owner to postgres;
revoke all on function public.apply_historical_asaas_payment_reversal(
  text, uuid, uuid, text, text, text, text, timestamptz,
  integer, text, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_historical_asaas_payment_reversal(
  text, uuid, uuid, text, text, text, text, timestamptz,
  integer, text, numeric, jsonb
) to service_role;

-- The normal webhook path may insert/adopt a payment only while the student is
-- still canonically active. The lifecycle advisory makes that validation and
-- the ledger mutation one transaction with respect to offboarding/deletion.
-- Historical settlements/reversals deliberately use their update-only RPCs.
create or replace function public.apply_active_student_payment_event(
  p_provider_payment_id text,
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_expected_provider_customer_id text,
  p_expected_provider_subscription_id text,
  p_canonical_reference text,
  p_event_id text,
  p_event_name text,
  p_event_created_at timestamptz,
  p_event_rank integer,
  p_provider_status text,
  p_provider_value numeric,
  p_due_date date,
  p_payment_date date,
  p_billing_type text,
  p_invoice_url text,
  p_description text,
  p_payment_type text,
  p_credited_at timestamptz,
  p_estimated_credit_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  profile_row public.profiles%rowtype;
  payment_row public.student_payments%rowtype;
  normalized_payment_id text := nullif(pg_catalog.btrim(coalesce(p_provider_payment_id, '')), '');
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_expected_tenant_id, '')), '');
  normalized_customer text := nullif(pg_catalog.btrim(coalesce(p_expected_provider_customer_id, '')), '');
  normalized_subscription text := nullif(pg_catalog.btrim(coalesce(p_expected_provider_subscription_id, '')), '');
  normalized_reference text := nullif(pg_catalog.btrim(coalesce(p_canonical_reference, '')), '');
  normalized_event_id text := nullif(pg_catalog.btrim(coalesce(p_event_id, '')), '');
  normalized_event text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_event_name, '')));
  normalized_provider_status text := nullif(pg_catalog.btrim(coalesce(p_provider_status, '')), '');
  normalized_billing_type text := nullif(pg_catalog.btrim(coalesce(p_billing_type, '')), '');
  normalized_invoice_url text := nullif(pg_catalog.btrim(coalesce(p_invoice_url, '')), '');
  normalized_description text := coalesce(nullif(pg_catalog.btrim(coalesce(p_description, '')), ''), 'Mensalidade');
  normalized_payment_type text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_payment_type, '')));
  payload_event_created_text text;
  payload_event_created_at timestamptz;
  payload_value numeric;
  expected_rank integer;
  membership_count integer := 0;
  active_membership_count integer := 0;
  reference_parts text[];
  reference_is_canonical boolean := false;
  reference_offer_id uuid;
  inserted_payment_id uuid;
  next_status text;
  previous_status text;
  was_already_paid boolean := false;
  local_payment_count integer := 0;
  lifecycle_is_active boolean := false;
  lifecycle_operation_active boolean := false;
  inactive_result jsonb;
begin
  expected_rank := case
    when normalized_event in (
      'PAYMENT_REFUNDED', 'PAYMENT_DELETED',
      'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE'
    ) then 100
    when normalized_event = 'PAYMENT_REFUND_IN_PROGRESS' then 95
    when normalized_event = 'PAYMENT_PARTIALLY_REFUNDED' then 90
    when normalized_event in ('PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH') then 80
    when normalized_event = 'PAYMENT_CONFIRMED' then 60
    when normalized_event = 'PAYMENT_OVERDUE' then 40
    when normalized_event = 'PAYMENT_UPDATED' then 30
    when normalized_event = 'PAYMENT_CREATED' then 20
    else 10
  end;

  if normalized_payment_id is null or pg_catalog.length(normalized_payment_id) > 240
     or p_expected_student_id is null
     or normalized_tenant is null or pg_catalog.length(normalized_tenant) > 240
     or normalized_customer is null or pg_catalog.length(normalized_customer) > 240
     or normalized_reference is null or pg_catalog.length(normalized_reference) > 500
     or normalized_event_id is null or pg_catalog.length(normalized_event_id) > 240
     or normalized_event = '' or pg_catalog.length(normalized_event) > 240
     or p_event_created_at is null or p_event_rank is distinct from expected_rank
     or normalized_provider_status is null or pg_catalog.length(normalized_provider_status) > 120
     or p_provider_value is null
     or p_provider_value::text in ('NaN', 'Infinity', '-Infinity')
     or p_provider_value <= 0 or p_due_date is null
     or normalized_payment_type not in ('ENROLLMENT', 'PRO_RATA', 'REFUND', 'SUBSCRIPTION')
     or jsonb_typeof(p_payload) <> 'object'
     or normalized_event in (
       'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED',
       'PAYMENT_RECEIVED_IN_CASH_UNDONE'
     )
  then
    raise exception using errcode = '22023', message = 'active_payment_event_input_invalid';
  end if;

  if nullif(pg_catalog.btrim(p_payload #>> '{payment,id}'), '')
       is distinct from normalized_payment_id
     or nullif(pg_catalog.btrim(p_payload #>> '{payment,customer}'), '')
       is distinct from normalized_customer
     or nullif(pg_catalog.btrim(p_payload ->> 'id'), '')
       is distinct from normalized_event_id
     or pg_catalog.upper(pg_catalog.btrim(coalesce(p_payload ->> 'event', '')))
       is distinct from normalized_event
     or nullif(pg_catalog.btrim(p_payload #>> '{payment,subscription}'), '')
       is distinct from normalized_subscription
     or nullif(pg_catalog.btrim(p_payload #>> '{payment,dueDate}'), '')
       is distinct from p_due_date::text
     or nullif(pg_catalog.btrim(p_payload #>> '{payment,paymentDate}'), '')
       is distinct from (
         case when p_payment_date is null then null else p_payment_date::text end
       )
     or (
       nullif(pg_catalog.btrim(p_payload #>> '{payment,status}'), '') is not null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,status}'), '')
         is distinct from normalized_provider_status
     )
     or (
       normalized_billing_type is not null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,billingType}'), '')
         is distinct from normalized_billing_type
     )
     or (
       normalized_invoice_url is not null
       and coalesce(
         nullif(pg_catalog.btrim(p_payload #>> '{payment,bankSlipUrl}'), ''),
         nullif(pg_catalog.btrim(p_payload #>> '{payment,invoiceUrl}'), '')
       ) is distinct from normalized_invoice_url
     )
  then
    raise exception using errcode = '23514', message = 'active_payment_event_payload_identity_mismatch';
  end if;
  begin
    payload_value := (p_payload #>> '{payment,value}')::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '23514', message = 'active_payment_event_payload_value_invalid';
  end;
  if payload_value is null or payload_value::text in ('NaN', 'Infinity', '-Infinity')
     or pg_catalog.round(payload_value, 2) <> pg_catalog.round(p_provider_value, 2)
  then
    raise exception using errcode = '23514', message = 'active_payment_event_payload_value_mismatch';
  end if;
  payload_event_created_text := nullif(
    pg_catalog.btrim(coalesce(p_payload ->> 'dateCreated', '')),
    ''
  );
  begin
    payload_event_created_at := case
      when payload_event_created_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        then (payload_event_created_text || ' 12:00:00+00')::timestamptz
      when payload_event_created_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
        then (payload_event_created_text || '+00')::timestamptz
      else payload_event_created_text::timestamptz
    end;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '23514', message = 'active_payment_event_payload_timestamp_invalid';
  end;
  if payload_event_created_at is null
     or payload_event_created_at is distinct from p_event_created_at
  then
    raise exception using errcode = '23514', message = 'active_payment_event_payload_timestamp_mismatch';
  end if;

  -- A subscription-created charge may omit its own reference, but the caller
  -- supplies the canonical reference obtained from the authoritative parent
  -- subscription GET. Direct one-time/manual charges must carry it themselves.
  if normalized_reference = p_expected_student_id::text then
    reference_is_canonical := true;
  elsif pg_catalog.lower(normalized_reference) ~ (
    '^student:' || p_expected_student_id::text || ':(one-time|pro-rata)$'
  ) then
    reference_is_canonical := normalized_subscription is null;
  elsif pg_catalog.lower(normalized_reference) ~ (
    '^manual-pix:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:student:'
    || p_expected_student_id::text || '$'
  ) then
    reference_is_canonical := normalized_subscription is null;
  else
    reference_parts := pg_catalog.regexp_match(
      pg_catalog.lower(normalized_reference),
      '^enrollment:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(subscription|one-time|pro-rata|fee)$'
    );
    if reference_parts is not null
       and (
         (normalized_subscription is not null and reference_parts[2] = 'subscription')
         or (normalized_subscription is null and reference_parts[2] <> 'subscription')
       )
    then
      reference_offer_id := reference_parts[1]::uuid;
    end if;
  end if;
  if (not reference_is_canonical and reference_offer_id is null)
     or (
       normalized_subscription is null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,externalReference}'), '')
         is distinct from normalized_reference
     )
     or (
       normalized_subscription is not null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,externalReference}'), '') is not null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,externalReference}'), '')
         is distinct from normalized_reference
     )
  then
    raise exception using errcode = '23514', message = 'active_payment_event_reference_mismatch';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' || p_expected_student_id::text,
      0
    )
  );

  if exists (
    select 1
      from public.student_payments as payment
     where (
       nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
       or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id
     )
       and nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') is not null
       and nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') is not null
       and nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') <>
           nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'local_payment_provider_alias_divergence');
  end if;
  select count(*) into local_payment_count
    from public.student_payments as payment
   where nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
      or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id;
  if local_payment_count > 1 then
    return jsonb_build_object('ok', false, 'reason', 'local_payment_binding_ambiguous');
  end if;
  if local_payment_count = 1 then
    select payment.* into payment_row
      from public.student_payments as payment
     where nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
        or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id
     for update;
  end if;
  if payment_row.id is null and p_expected_local_payment_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'expected_local_payment_missing');
  end if;
  if payment_row.id is not null and (
    (p_expected_local_payment_id is not null and payment_row.id is distinct from p_expected_local_payment_id)
    or payment_row.student_id is distinct from p_expected_student_id
    or payment_row.tenant_id is distinct from normalized_tenant
    or nullif(pg_catalog.btrim(coalesce(payment_row.provider_customer_id, '')), '')
      is distinct from normalized_customer
    or payment_row.value is null
    or payment_row.value::text in ('NaN', 'Infinity', '-Infinity')
    or pg_catalog.round(payment_row.value, 2) <> pg_catalog.round(p_provider_value, 2)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'local_payment_binding_mismatch');
  end if;

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_expected_student_id
   for share;
  if not found
     or profile_row.tenant_id is distinct from normalized_tenant
     or profile_row.role is distinct from 'STUDENT'
     or nullif(pg_catalog.btrim(coalesce(profile_row.asaas_customer_id, '')), '')
       is distinct from normalized_customer
  then
    if normalized_event in ('PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH')
       and payment_row.id is not null
       and p_expected_local_payment_id is not null
    then
      inactive_result := public.apply_inactive_student_payment_settlement(
        normalized_payment_id,
        p_expected_local_payment_id,
        p_expected_student_id,
        normalized_tenant,
        normalized_customer,
        normalized_event_id,
        normalized_event,
        p_event_created_at,
        p_event_rank,
        normalized_provider_status,
        p_provider_value,
        p_payment_date,
        p_credited_at,
        p_estimated_credit_at,
        p_payload
      );
      return inactive_result || jsonb_build_object('inactive_update_only', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'student_binding_changed');
  end if;

  select count(*), count(*) filter (
    where membership.tenant_id = normalized_tenant
      and membership.role = 'STUDENT'
      and membership.status = 'ACTIVE'
  )
    into membership_count, active_membership_count
    from (
      select current_membership.tenant_id,
             current_membership.role,
             current_membership.status
        from public.tenant_memberships as current_membership
       where current_membership.user_id = p_expected_student_id
       for share
    ) as membership;
  lifecycle_operation_active := exists (
    select 1 from public.student_offboarding_operations as operation
     where operation.tenant_id = normalized_tenant
       and operation.student_id = p_expected_student_id
       and operation.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  ) or exists (
    select 1 from public.student_account_deletion_claims as deletion
     where deletion.tenant_id = normalized_tenant
       and deletion.student_id = p_expected_student_id
       and deletion.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  );
  lifecycle_is_active :=
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile_row.lifecycle_status, ''))) = 'active'
    and membership_count = 1
    and active_membership_count = 1
    and not lifecycle_operation_active;

  if not lifecycle_is_active then
    if normalized_event in ('PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH')
       and payment_row.id is not null
       and p_expected_local_payment_id is not null
    then
      inactive_result := public.apply_inactive_student_payment_settlement(
        normalized_payment_id,
        p_expected_local_payment_id,
        p_expected_student_id,
        normalized_tenant,
        normalized_customer,
        normalized_event_id,
        normalized_event,
        p_event_created_at,
        p_event_rank,
        normalized_provider_status,
        p_provider_value,
        p_payment_date,
        p_credited_at,
        p_estimated_credit_at,
        p_payload
      );
      return inactive_result || jsonb_build_object('inactive_update_only', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'student_lifecycle_or_binding_changed');
  end if;

  if normalized_subscription is not null
     and nullif(pg_catalog.btrim(coalesce(profile_row.subscription_id, '')), '')
       is distinct from normalized_subscription
  then
    return jsonb_build_object('ok', false, 'reason', 'student_subscription_binding_changed');
  end if;

  if reference_offer_id is not null then
    perform 1
      from public.offers as offer
     where offer.id = reference_offer_id
       and offer.tenant_id = normalized_tenant
       and offer.kind = 'ENROLLMENT'
       and p_expected_student_id in (offer.processing_by, offer.consumed_by)
     for share;
    if not found then
      raise exception using errcode = '23514', message = 'active_payment_event_reference_mismatch';
    end if;
  end if;
  -- An exact inbox retry repairs idempotent downstream effects without
  -- rewriting the financial row (or firing its ledger triggers again). A
  -- different event with the same provider timestamp/rank is not equivalent:
  -- keep the already persisted identity as the deterministic winner.
  if payment_row.id is not null
     and nullif(pg_catalog.btrim(coalesce(payment_row.last_provider_event_id, '')), '')
       is not distinct from normalized_event_id
  then
    return jsonb_build_object(
      'ok', true,
      'action', 'REPLAY',
      'id', payment_row.id,
      'due_date', payment_row.due_date,
      'status', payment_row.status,
      'previous_status', payment_row.status,
      'was_already_paid', payment_row.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
        or payment_row.provider_status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
    );
  end if;
  if payment_row.id is not null and payment_row.last_provider_event_at is not null and (
    p_event_created_at < payment_row.last_provider_event_at
    or (
      p_event_created_at = payment_row.last_provider_event_at
      and p_event_rank <= coalesce(payment_row.last_provider_event_rank, 0)
    )
  ) then
    return jsonb_build_object(
      'ok', true,
      'action', 'IGNORED',
      'id', payment_row.id,
      'due_date', payment_row.due_date,
      'status', payment_row.status,
      'previous_status', payment_row.status,
      'was_already_paid', payment_row.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
        or payment_row.provider_status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
    );
  end if;

  if payment_row.id is null then
    insert into public.student_payments (
      asaas_payment_id, student_id, tenant_id, provider_customer_id,
      value, status, provider_status, due_date, payment_date, billing_type,
      invoice_url, description, payment_type, credited_at, paid_at,
      estimated_credit_at, raw_payload, last_provider_event_id,
      last_provider_event_at, last_provider_event_rank, updated_at
    ) values (
      normalized_payment_id, p_expected_student_id, normalized_tenant,
      normalized_customer, p_provider_value, normalized_provider_status,
      normalized_provider_status, p_due_date, p_payment_date,
      normalized_billing_type, normalized_invoice_url, normalized_description,
      normalized_payment_type, p_credited_at, p_credited_at,
      p_estimated_credit_at, p_payload, normalized_event_id,
      p_event_created_at, p_event_rank, pg_catalog.clock_timestamp()
    )
    on conflict (asaas_payment_id) where asaas_payment_id is not null do nothing
    returning id into inserted_payment_id;

    select payment.* into payment_row
      from public.student_payments as payment
     where nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
     for update;
    if not found
       or (inserted_payment_id is null and (
         payment_row.student_id is distinct from p_expected_student_id
         or payment_row.tenant_id is distinct from normalized_tenant
         or nullif(pg_catalog.btrim(coalesce(payment_row.provider_customer_id, '')), '')
           is distinct from normalized_customer
         or payment_row.value is null
         or pg_catalog.round(payment_row.value, 2) <> pg_catalog.round(p_provider_value, 2)
       ))
    then
      return jsonb_build_object('ok', false, 'reason', 'provider_payment_identity_collision');
    end if;
    if inserted_payment_id is not null then
      return jsonb_build_object(
        'ok', true,
        'action', 'INSERTED',
        'id', payment_row.id,
        'due_date', payment_row.due_date,
        'status', payment_row.status,
        'previous_status', null,
        'was_already_paid', false
      );
    end if;
  end if;

  previous_status := payment_row.status;
  was_already_paid := (
    payment_row.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
    or payment_row.provider_status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
  );
  next_status := case
    when payment_row.status = 'NAO_RECEITA' then 'NAO_RECEITA'
    when payment_row.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
      and normalized_event in (
        'PAYMENT_REFUND_IN_PROGRESS', 'PAYMENT_CHARGEBACK_REQUESTED',
        'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
        'PAYMENT_DELETED'
      ) then payment_row.status
    else normalized_provider_status
  end;

  update public.student_payments as payment
     set status = next_status,
         provider_status = normalized_provider_status,
         due_date = p_due_date,
         payment_date = coalesce(p_payment_date, payment.payment_date),
         billing_type = coalesce(normalized_billing_type, payment.billing_type),
         invoice_url = coalesce(normalized_invoice_url, payment.invoice_url),
         description = normalized_description,
         payment_type = normalized_payment_type,
         credited_at = coalesce(p_credited_at, payment.credited_at),
         paid_at = coalesce(p_credited_at, payment.paid_at),
         estimated_credit_at = coalesce(p_estimated_credit_at, payment.estimated_credit_at),
         raw_payload = p_payload,
         last_provider_event_id = normalized_event_id,
         last_provider_event_at = p_event_created_at,
         last_provider_event_rank = p_event_rank,
         updated_at = pg_catalog.clock_timestamp()
   where payment.id = payment_row.id
   returning payment.* into payment_row;

  return jsonb_build_object(
    'ok', true,
    'action', 'UPDATED',
    'id', payment_row.id,
    'due_date', payment_row.due_date,
    'status', payment_row.status,
    'previous_status', previous_status,
    'was_already_paid', was_already_paid
  );
end;
$function$;

alter function public.apply_active_student_payment_event(text, uuid, uuid, text, text, text, text, text, text, timestamptz, integer, text, numeric, date, date, text, text, text, text, timestamptz, timestamptz, jsonb) owner to postgres;
revoke all on function public.apply_active_student_payment_event(text, uuid, uuid, text, text, text, text, text, text, timestamptz, integer, text, numeric, date, date, text, text, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.apply_active_student_payment_event(text, uuid, uuid, text, text, text, text, text, text, timestamptz, integer, text, numeric, date, date, text, text, text, text, timestamptz, timestamptz, jsonb) to service_role;

comment on function public.apply_active_student_payment_event(text, uuid, uuid, text, text, text, text, text, text, timestamptz, integer, text, numeric, date, date, text, text, text, text, timestamptz, timestamptz, jsonb) is
  'Atomically revalidates active student lifecycle and exact Asaas payment identity before applying an ordered normal webhook event.';

-- A signed cash-settlement event may arrive after the student was suspended or
-- offboarded. Apply it only to an already-bound payment with immutable
-- tenant/student/customer/value identity. This RPC cannot insert/adopt a row,
-- reactivate access, complete enrollment or enqueue communication.
create or replace function public.apply_inactive_student_payment_settlement(
  p_provider_payment_id text,
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_expected_provider_customer_id text,
  p_event_id text,
  p_event_name text,
  p_event_created_at timestamptz,
  p_event_rank integer,
  p_provider_status text,
  p_provider_value numeric,
  p_payment_date date,
  p_credited_at timestamptz,
  p_estimated_credit_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  payment_row public.student_payments%rowtype;
  normalized_payment_id text := nullif(trim(coalesce(p_provider_payment_id, '')), '');
  normalized_tenant text := nullif(trim(coalesce(p_expected_tenant_id, '')), '');
  normalized_customer text := nullif(trim(coalesce(p_expected_provider_customer_id, '')), '');
  normalized_event_id text := nullif(trim(coalesce(p_event_id, '')), '');
  normalized_event text := upper(trim(coalesce(p_event_name, '')));
  normalized_provider_status text := nullif(trim(coalesce(p_provider_status, '')), '');
  next_status text;
  payload_value numeric;
  local_payment_count integer := 0;
begin
  if normalized_payment_id is null or p_expected_local_payment_id is null
     or p_expected_student_id is null or normalized_tenant is null
     or normalized_customer is null or normalized_event_id is null
     or normalized_event not in ('PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH')
     or p_event_created_at is null or coalesce(p_event_rank, 0) <= 0
     or normalized_provider_status is null or p_provider_value is null
     or p_provider_value::text in ('NaN', 'Infinity', '-Infinity')
     or p_provider_value <= 0 or jsonb_typeof(p_payload) <> 'object'
     or (
       normalized_event = 'PAYMENT_RECEIVED_IN_CASH'
       and p_payment_date is null
     )
  then
    raise exception using errcode = '22023', message = 'inactive_settlement_input_invalid';
  end if;
  if nullif(trim(p_payload #>> '{payment,id}'), '') is distinct from normalized_payment_id
     or nullif(trim(p_payload #>> '{payment,customer}'), '') is distinct from normalized_customer
     or nullif(trim(p_payload ->> 'id'), '') is distinct from normalized_event_id
     or upper(trim(coalesce(p_payload ->> 'event', ''))) is distinct from normalized_event
     or nullif(trim(p_payload #>> '{payment,paymentDate}'), '')
          is distinct from (
            case when p_payment_date is null then null else p_payment_date::text end
          )
  then
    raise exception using errcode = '23514', message = 'inactive_settlement_payload_identity_mismatch';
  end if;
  begin
    payload_value := (p_payload #>> '{payment,value}')::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '23514', message = 'inactive_settlement_payload_value_invalid';
  end;
  if payload_value is null or payload_value::text in ('NaN', 'Infinity', '-Infinity')
     or round(payload_value, 2) <> round(p_provider_value, 2)
  then
    raise exception using errcode = '23514', message = 'inactive_settlement_payload_value_mismatch';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' ||
        p_expected_student_id::text,
      0
    )
  );

  if exists (
    select 1
      from public.student_payments as payment
     where (
       nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
       or nullif(trim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id
     )
       and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') is not null
       and nullif(trim(coalesce(payment.asaas_id, '')), '') is not null
       and trim(payment.asaas_payment_id) <> trim(payment.asaas_id)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'local_payment_provider_alias_divergence');
  end if;
  select count(*) into local_payment_count
    from public.student_payments as payment
   where nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
      or nullif(trim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id;
  if local_payment_count > 1 then
    return jsonb_build_object('ok', false, 'reason', 'local_payment_binding_ambiguous');
  end if;

  select payment.* into payment_row
    from public.student_payments as payment
   where payment.id = p_expected_local_payment_id
     and (
       nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
       or nullif(trim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id
     )
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'payment_not_found');
  end if;
  if payment_row.student_id is distinct from p_expected_student_id
     or payment_row.tenant_id is distinct from normalized_tenant
     or nullif(trim(coalesce(payment_row.provider_customer_id, '')), '') is distinct from normalized_customer
     or payment_row.value is null
     or payment_row.value::text in ('NaN', 'Infinity', '-Infinity')
     or round(payment_row.value, 2) <> round(p_provider_value, 2)
  then
    return jsonb_build_object('ok', false, 'reason', 'local_binding_mismatch');
  end if;
  if payment_row.last_provider_event_at is not null and (
    p_event_created_at < payment_row.last_provider_event_at
    or (
      p_event_created_at = payment_row.last_provider_event_at
      and p_event_rank < coalesce(payment_row.last_provider_event_rank, 0)
    )
  ) then
    return jsonb_build_object(
      'ok', true,
      'action', 'IGNORED',
      'id', payment_row.id,
      'due_date', payment_row.due_date,
      'status', payment_row.status
    );
  end if;

  next_status := case
    when payment_row.status = 'NAO_RECEITA' then 'NAO_RECEITA'
    when normalized_event = 'PAYMENT_RECEIVED_IN_CASH' then 'RECEIVED_IN_CASH'
    else 'RECEIVED'
  end;
  update public.student_payments as payment
     set status = next_status,
         provider_status = normalized_provider_status,
         payment_date = coalesce(p_payment_date, payment.payment_date),
         credited_at = coalesce(p_credited_at, payment.credited_at),
         paid_at = coalesce(
           p_credited_at,
           p_payment_date + interval '12 hours',
           payment.paid_at
         ),
         estimated_credit_at = coalesce(p_estimated_credit_at, payment.estimated_credit_at),
         raw_payload = p_payload,
         last_provider_event_id = normalized_event_id,
         last_provider_event_at = p_event_created_at,
         last_provider_event_rank = p_event_rank,
         updated_at = clock_timestamp()
   where payment.id = payment_row.id
   returning payment.* into payment_row;
  return jsonb_build_object(
    'ok', true,
    'action', 'UPDATED',
    'id', payment_row.id,
    'due_date', payment_row.due_date,
    'status', payment_row.status
  );
end;
$function$;

alter function public.apply_inactive_student_payment_settlement(text, uuid, uuid, text, text, text, text, timestamptz, integer, text, numeric, date, timestamptz, timestamptz, jsonb) owner to postgres;
revoke all on function public.apply_inactive_student_payment_settlement(text, uuid, uuid, text, text, text, text, timestamptz, integer, text, numeric, date, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.apply_inactive_student_payment_settlement(text, uuid, uuid, text, text, text, text, timestamptz, integer, text, numeric, date, timestamptz, timestamptz, jsonb) to service_role;

create or replace function public.guard_student_billing_period_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || new.tenant_id || ':' || new.student_id::text,
      0
    )
  );
  if not exists (
    select 1
      from public.profiles as profile
     where profile.id = new.student_id
       and profile.tenant_id = new.tenant_id
       and profile.role = 'STUDENT'
       and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
  ) or exists (
    select 1
      from public.student_offboarding_operations as operation
     where operation.tenant_id = new.tenant_id
       and operation.student_id = new.student_id
       and operation.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
  ) or exists (
    select 1
      from public.student_account_deletion_claims as deletion
     where deletion.tenant_id = new.tenant_id
       and deletion.student_id = new.student_id
       and deletion.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
  ) or exists (
    select 1
      from public.asaas_provider_creation_attempts as creation
     where creation.tenant_id = new.tenant_id
       and creation.lifecycle_student_id = new.student_id
       and creation.lifecycle_released_at is null
       and creation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED')
  ) or exists (
    select 1
      from public.student_billing_method_operations as billing_method
     where billing_method.tenant_id = new.tenant_id
       and billing_method.student_id = new.student_id
       and billing_method.status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED')
  ) then
    raise exception using
      errcode = '55000',
      message = 'student_billing_lifecycle_inactive';
  end if;
  return new;
end;
$function$;

drop trigger if exists guard_student_billing_period_lifecycle
  on public.asaas_student_billing_period_claims;
create trigger guard_student_billing_period_lifecycle
before insert on public.asaas_student_billing_period_claims
for each row execute function public.guard_student_billing_period_lifecycle();

alter function public.guard_student_billing_period_lifecycle() owner to postgres;
revoke all on function public.guard_student_billing_period_lifecycle()
  from public, anon, authenticated, service_role;

create or replace function public.begin_student_offboarding(
  p_tenant_id text,
  p_student_id uuid,
  p_requested_by uuid,
  p_target_status text,
  p_reason text,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  profile_row public.profiles%rowtype;
  operation_row public.student_offboarding_operations%rowtype;
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  normalized_target text := lower(trim(coalesce(p_target_status, '')));
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  payment_rows jsonb;
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
  retry_after integer;
  action text;
begin
  if normalized_tenant is null or p_student_id is null or p_claim_token is null
     or normalized_target not in ('suspended', 'offboarded')
  then
    raise exception using errcode = '22023', message = 'invalid_student_offboarding_claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' || p_student_id::text,
      0
    )
  );

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_student_id
   for update;
  if not found
     or profile_row.tenant_id is distinct from normalized_tenant
     or profile_row.role is distinct from 'STUDENT'
  then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'profile_scope_changed');
  end if;
  if lower(trim(coalesce(profile_row.lifecycle_status, ''))) = normalized_target then
    return jsonb_build_object('ok', true, 'action', 'ALREADY_COMPLETED');
  end if;
  if lower(trim(coalesce(profile_row.lifecycle_status, ''))) = 'offboarded' then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'profile_already_offboarded');
  end if;

  if (
    select count(*) from public.tenant_memberships as membership
     where membership.user_id = p_student_id
  ) <> 1 or not exists (
    select 1 from public.tenant_memberships as membership
     where membership.user_id = p_student_id
       and membership.tenant_id = normalized_tenant
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'membership_scope_changed');
  end if;
  if exists (
    select 1
      from public.asaas_student_billing_period_claims as billing_claim
     where billing_claim.tenant_id = normalized_tenant
       and billing_claim.student_id = p_student_id
       and billing_claim.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN')
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'billing_creation_in_flight');
  end if;
  if exists (
    select 1
      from public.asaas_provider_creation_attempts as creation
     where creation.tenant_id = normalized_tenant
       and creation.lifecycle_student_id = p_student_id
       and creation.lifecycle_released_at is null
       and creation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED')
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'provider_creation_in_flight');
  end if;
  if exists (
    select 1
      from public.student_overdue_card_charge_claims as charge
     where charge.tenant_id = normalized_tenant
       and charge.student_id = p_student_id
       and (
         charge.status in ('SUBMITTING', 'UNKNOWN')
         or (charge.status = 'PROCESSING' and charge.lease_expires_at > now())
         or (
           charge.status = 'SUCCEEDED'
           and not exists (
             select 1 from public.student_payments as payment
              where payment.tenant_id = normalized_tenant
                and payment.student_id = p_student_id
                and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') = charge.asaas_payment_id
                and upper(trim(coalesce(payment.status, ''))) in ('RECEIVED', 'RECEIVED_IN_CASH')
           )
         )
       )
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'overdue_charge_in_flight');
  end if;
  if exists (
    select 1 from public.student_billing_method_operations as billing_method
     where billing_method.tenant_id = normalized_tenant
       and billing_method.student_id = p_student_id
       and billing_method.status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED')
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'billing_method_mutation_in_flight');
  end if;
  update public.asaas_outbound_message_attempts
     set status = 'SUPPRESSED',
         lease_expires_at = now(),
         last_error = 'student_offboarding_requested_before_send',
         updated_at = now()
   where tenant_id = normalized_tenant
     and student_id = p_student_id
     and status = 'CLAIMED'
     and submit_attempt_count = 0;
  if exists (
    select 1 from public.asaas_outbound_message_attempts as message_attempt
     where message_attempt.tenant_id = normalized_tenant
       and message_attempt.student_id = p_student_id
       and message_attempt.status in ('SUBMITTING', 'UNKNOWN')
  ) then
    return jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'outbound_message_in_flight'
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', payment.id,
      'asaas_payment_id', coalesce(nullif(trim(coalesce(payment.asaas_payment_id, '')), ''), nullif(trim(coalesce(payment.asaas_id, '')), '')),
      'status', payment.status,
      'due_date', payment.due_date
    ) order by payment.id), '[]'::jsonb)
    into payment_rows
    from public.student_payments as payment
   where normalized_target = 'offboarded'
     and payment.tenant_id = normalized_tenant
     and payment.student_id = p_student_id
     and upper(coalesce(payment.status, '')) = 'PENDING'
     and payment.due_date >= current_date;

  if normalized_target = 'offboarded' and exists (
    select 1
      from public.student_payments as payment
     where payment.tenant_id = normalized_tenant
       and payment.student_id = p_student_id
       and upper(coalesce(payment.status, '')) = 'PENDING'
       and payment.due_date >= current_date
       and nullif(trim(coalesce(payment.asaas_payment_id, '')), '') is not null
       and nullif(trim(coalesce(payment.asaas_id, '')), '') is not null
       and trim(payment.asaas_payment_id) <> trim(payment.asaas_id)
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'payment_provider_binding_divergent');
  end if;
  if normalized_target = 'offboarded' and exists (
    select 1
      from (
        select coalesce(
                 nullif(trim(coalesce(payment.asaas_payment_id, '')), ''),
                 nullif(trim(coalesce(payment.asaas_id, '')), '')
               ) as provider_id
          from public.student_payments as payment
         where payment.tenant_id = normalized_tenant
           and payment.student_id = p_student_id
           and upper(coalesce(payment.status, '')) = 'PENDING'
           and payment.due_date >= current_date
      ) as binding
     where binding.provider_id is not null
     group by binding.provider_id
    having count(*) > 1
  ) then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'payment_provider_binding_duplicate');
  end if;

  select operation.* into operation_row
    from public.student_offboarding_operations as operation
   where operation.tenant_id = normalized_tenant
     and operation.student_id = p_student_id
     and operation.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
   for update;

  if not found then
    insert into public.student_offboarding_operations (
      tenant_id, student_id, requested_by, source_lifecycle_status,
      target_lifecycle_status, reason, status, claim_token, lease_expires_at,
      customer_id, subscription_id, enrollment_payment_id, payment_snapshot, snapshot
    ) values (
      normalized_tenant, p_student_id, p_requested_by,
      lower(trim(coalesce(profile_row.lifecycle_status, 'active'))),
      normalized_target, normalized_reason, 'CLAIMED', p_claim_token,
      now() + make_interval(secs => safe_lease),
      nullif(trim(coalesce(profile_row.asaas_customer_id, '')), ''),
      nullif(trim(coalesce(profile_row.subscription_id, '')), ''),
      nullif(trim(coalesce(profile_row.enrollment_payment_id, '')), ''),
      payment_rows,
      jsonb_build_object(
        'tenant_id', normalized_tenant,
        'student_id', p_student_id,
        'role', profile_row.role,
        'lifecycle_status', lower(trim(coalesce(profile_row.lifecycle_status, 'active'))),
        'customer_id', nullif(trim(coalesce(profile_row.asaas_customer_id, '')), ''),
        'subscription_id', nullif(trim(coalesce(profile_row.subscription_id, '')), ''),
        'enrollment_payment_id', nullif(trim(coalesce(profile_row.enrollment_payment_id, '')), ''),
        'payment_ids', payment_rows
      )
    ) returning * into operation_row;
  end if;

  if operation_row.target_lifecycle_status is distinct from normalized_target
     or operation_row.source_lifecycle_status is distinct from lower(trim(coalesce(profile_row.lifecycle_status, 'active')))
     or operation_row.customer_id is distinct from nullif(trim(coalesce(profile_row.asaas_customer_id, '')), '')
     or operation_row.subscription_id is distinct from nullif(trim(coalesce(profile_row.subscription_id, '')), '')
     or operation_row.enrollment_payment_id is distinct from nullif(trim(coalesce(profile_row.enrollment_payment_id, '')), '')
     or exists (
       select 1
         from jsonb_array_elements(operation_row.payment_snapshot) as entry
         left join public.student_payments as payment
           on payment.id = (entry ->> 'id')::uuid
          and payment.tenant_id = normalized_tenant
          and payment.student_id = p_student_id
        where payment.id is null
           or coalesce(
                nullif(trim(coalesce(payment.asaas_payment_id, '')), ''),
                nullif(trim(coalesce(payment.asaas_id, '')), '')
              ) is distinct from nullif(entry ->> 'asaas_payment_id', '')
           or payment.due_date is distinct from (entry ->> 'due_date')::date
     )
  then
    update public.student_offboarding_operations
       set status = 'BLOCKED', last_error = 'offboarding_snapshot_mismatch', updated_at = now()
     where id = operation_row.id;
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'snapshot_mismatch', 'operation_id', operation_row.id);
  end if;

  if operation_row.status = 'BLOCKED' then
    return jsonb_build_object('ok', false, 'action', 'REVIEW_REQUIRED', 'reason', coalesce(operation_row.last_error, 'operation_blocked'), 'operation_id', operation_row.id);
  end if;

  if operation_row.status = 'CLAIMED'
     and operation_row.claim_token <> p_claim_token
     and operation_row.lease_expires_at > now()
  then
    retry_after := greatest(1, ceil(extract(epoch from (operation_row.lease_expires_at - now())))::integer);
    return jsonb_build_object('ok', true, 'action', 'IN_PROGRESS', 'operation_id', operation_row.id, 'retry_after_seconds', retry_after);
  end if;

  action := case
    when operation_row.status in ('PROVIDER_MUTATING', 'UNKNOWN') then 'RECONCILE_REQUIRED'
    when operation_row.status = 'PROVIDER_COMPLETE' then 'FINALIZE_REQUIRED'
    else 'PROCEED'
  end;
  update public.student_offboarding_operations
     set claim_token = p_claim_token,
         requested_by = p_requested_by,
         lease_expires_at = now() + make_interval(secs => safe_lease),
         updated_at = now()
   where id = operation_row.id
   returning * into operation_row;

  return jsonb_build_object(
    'ok', true,
    'action', action,
    'operation_id', operation_row.id,
    'claim_token', operation_row.claim_token,
    'source_lifecycle_status', operation_row.source_lifecycle_status,
    'target_lifecycle_status', operation_row.target_lifecycle_status,
    'customer_id', operation_row.customer_id,
    'subscription_id', operation_row.subscription_id,
    'enrollment_payment_id', operation_row.enrollment_payment_id,
    'payment_snapshot', operation_row.payment_snapshot,
    'reason', operation_row.reason
  );
end;
$function$;

create or replace function public.bind_student_offboarding_integrations(
  p_operation_id uuid,
  p_claim_token uuid,
  p_subscription_integration_id text,
  p_subscription_version integer,
  p_subscription_environment text,
  p_subscription_mode text,
  p_payment_integration_id text,
  p_payment_version integer,
  p_payment_environment text,
  p_payment_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_row public.student_offboarding_operations%rowtype;
  expected_snapshot jsonb;
  payment_required boolean;
begin
  select operation.* into operation_row
    from public.student_offboarding_operations as operation
   where operation.id = p_operation_id
   for update;
  if not found
     or operation_row.claim_token is distinct from p_claim_token
     or operation_row.status not in ('CLAIMED', 'PROVIDER_MUTATING', 'UNKNOWN')
  then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  payment_required := exists (
    select 1
      from jsonb_array_elements(operation_row.payment_snapshot) as entry
     where nullif(entry ->> 'asaas_payment_id', '') is not null
  ) or operation_row.enrollment_payment_id is not null;
  if (operation_row.subscription_id is null) is distinct from (p_subscription_integration_id is null)
     or payment_required is distinct from (p_payment_integration_id is not null)
     or (p_subscription_integration_id is not null and (
       nullif(trim(p_subscription_integration_id), '') is null
       or coalesce(p_subscription_version, 0) < 1
       or p_subscription_environment not in ('platform', 'production', 'sandbox')
       or p_subscription_mode not in ('PLATFORM_MANAGED_ROOT', 'PLATFORM_MANAGED_SUBACCOUNT', 'TENANT_BYOK')
     ))
     or (p_payment_integration_id is not null and (
       nullif(trim(p_payment_integration_id), '') is null
       or coalesce(p_payment_version, 0) < 1
       or p_payment_environment not in ('platform', 'production', 'sandbox')
       or p_payment_mode not in ('PLATFORM_MANAGED_ROOT', 'PLATFORM_MANAGED_SUBACCOUNT', 'TENANT_BYOK')
     ))
  then
    update public.student_offboarding_operations
       set status = 'BLOCKED', last_error = 'integration_snapshot_invalid', updated_at = now()
     where id = operation_row.id;
    return jsonb_build_object('ok', false, 'reason', 'integration_snapshot_invalid');
  end if;

  expected_snapshot := jsonb_build_object(
    'subscription', case when p_subscription_integration_id is null then null else jsonb_build_object(
      'integration_id', trim(p_subscription_integration_id),
      'version', p_subscription_version,
      'environment', p_subscription_environment,
      'mode', p_subscription_mode
    ) end,
    'payment', case when p_payment_integration_id is null then null else jsonb_build_object(
      'integration_id', trim(p_payment_integration_id),
      'version', p_payment_version,
      'environment', p_payment_environment,
      'mode', p_payment_mode
    ) end
  );

  if operation_row.integration_snapshot = '{}'::jsonb then
    update public.student_offboarding_operations
       set integration_snapshot = expected_snapshot, updated_at = now()
     where id = operation_row.id;
    return jsonb_build_object('ok', true, 'action', 'BOUND');
  end if;
  if operation_row.integration_snapshot is distinct from expected_snapshot then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'integration_context_changed',
           lease_expires_at = now(),
           updated_at = now()
     where id = operation_row.id;
    return jsonb_build_object('ok', false, 'reason', 'integration_context_changed');
  end if;
  return jsonb_build_object('ok', true, 'action', 'ALREADY_BOUND');
end;
$function$;

create or replace function public.record_student_offboarding_provider_state(
  p_operation_id uuid,
  p_claim_token uuid,
  p_status text,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_status text := upper(trim(coalesce(p_status, '')));
  changed_id uuid;
begin
  if normalized_status not in ('MUTATING', 'COMPLETE', 'UNKNOWN') then
    raise exception using errcode = '22023', message = 'invalid_offboarding_provider_state';
  end if;
  update public.student_offboarding_operations
     set status = case
           when status = 'PROVIDER_COMPLETE' then 'PROVIDER_COMPLETE'
           when normalized_status = 'MUTATING' then 'PROVIDER_MUTATING'
           when normalized_status = 'COMPLETE' then 'PROVIDER_COMPLETE'
           else 'UNKNOWN'
         end,
         provider_started_at = coalesce(provider_started_at, now()),
         provider_completed_at = case
           when status = 'PROVIDER_COMPLETE' then provider_completed_at
           when normalized_status = 'COMPLETE' then now()
           else provider_completed_at
         end,
         last_error = case
           when status = 'PROVIDER_COMPLETE' then last_error
           else nullif(left(coalesce(p_error, ''), 500), '')
         end,
         updated_at = now()
   where id = p_operation_id
     and claim_token = p_claim_token
     and integration_snapshot <> '{}'::jsonb
     and status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN')
   returning id into changed_id;
  return jsonb_build_object('ok', changed_id is not null, 'reason', case when changed_id is null then 'claim_lost' else null end);
end;
$function$;

create or replace function public.finalize_student_offboarding(
  p_operation_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_row public.student_offboarding_operations%rowtype;
  operation_tenant_id text;
  operation_student_id uuid;
  updated_profile_id uuid;
  cancelled_count integer := 0;
begin
  -- Take the lifecycle advisory before locking the operation row. `begin` and
  -- the active webhook RPC use this same order, preventing both the race and a
  -- row/advisory deadlock.
  select operation.tenant_id, operation.student_id
    into operation_tenant_id, operation_student_id
    from public.student_offboarding_operations as operation
   where operation.id = p_operation_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || operation_tenant_id || ':' || operation_student_id::text,
      0
    )
  );

  select operation.* into operation_row
    from public.student_offboarding_operations as operation
   where operation.id = p_operation_id
   for update;
  if not found
     or operation_row.tenant_id is distinct from operation_tenant_id
     or operation_row.student_id is distinct from operation_student_id
     or operation_row.claim_token is distinct from p_claim_token
     or operation_row.status <> 'PROVIDER_COMPLETE'
  then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if (
    select count(*) from public.tenant_memberships as membership
     where membership.user_id = operation_row.student_id
  ) <> 1 or not exists (
    select 1 from public.tenant_memberships as membership
     where membership.user_id = operation_row.student_id
       and membership.tenant_id = operation_row.tenant_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    update public.student_offboarding_operations
       set status = 'BLOCKED', last_error = 'membership_scope_changed_before_finalize', updated_at = now()
     where id = operation_row.id;
    return jsonb_build_object('ok', false, 'reason', 'membership_scope_changed');
  end if;

  if exists (
    select 1
      from jsonb_array_elements(operation_row.payment_snapshot) as entry
      left join public.student_payments as payment
        on payment.id = (entry ->> 'id')::uuid
       and payment.tenant_id = operation_row.tenant_id
       and payment.student_id = operation_row.student_id
     where payment.id is null
        or coalesce(
             nullif(trim(coalesce(payment.asaas_payment_id, '')), ''),
             nullif(trim(coalesce(payment.asaas_id, '')), '')
           ) is distinct from nullif(entry ->> 'asaas_payment_id', '')
        or payment.due_date is distinct from (entry ->> 'due_date')::date
  ) or (
    operation_row.target_lifecycle_status = 'offboarded'
    and exists (
      select 1
        from public.student_payments as payment
       where payment.tenant_id = operation_row.tenant_id
         and payment.student_id = operation_row.student_id
         and upper(coalesce(payment.status, '')) = 'PENDING'
         and payment.due_date >= current_date
         and not exists (
           select 1
             from jsonb_array_elements(operation_row.payment_snapshot) as entry
            where (entry ->> 'id')::uuid = payment.id
         )
    )
  ) then
    update public.student_offboarding_operations
       set status = 'BLOCKED', last_error = 'payment_snapshot_changed_before_finalize', updated_at = now()
     where id = operation_row.id;
    return jsonb_build_object('ok', false, 'reason', 'payment_snapshot_changed');
  end if;

  update public.profiles as profile
     set lifecycle_status = operation_row.target_lifecycle_status,
         suspended_at = case when operation_row.target_lifecycle_status = 'suspended' then now() else null end,
         suspended_reason = case when operation_row.target_lifecycle_status = 'suspended' then operation_row.reason else null end,
         offboarding_status = case when operation_row.target_lifecycle_status = 'offboarded' then 'COMPLETED' else null end,
         offboarding_completed_at = case when operation_row.target_lifecycle_status = 'offboarded' then now() else null end,
         offboarding_reason = case when operation_row.target_lifecycle_status = 'offboarded' then operation_row.reason else null end
   where profile.id = operation_row.student_id
     and profile.tenant_id = operation_row.tenant_id
     and profile.role = 'STUDENT'
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = operation_row.source_lifecycle_status
     and nullif(trim(coalesce(profile.asaas_customer_id, '')), '') is not distinct from operation_row.customer_id
     and nullif(trim(coalesce(profile.subscription_id, '')), '') is not distinct from operation_row.subscription_id
     and nullif(trim(coalesce(profile.enrollment_payment_id, '')), '') is not distinct from operation_row.enrollment_payment_id
   returning profile.id into updated_profile_id;
  if updated_profile_id is null then
    update public.student_offboarding_operations
       set status = 'BLOCKED', last_error = 'profile_binding_changed_before_finalize', updated_at = now()
     where id = operation_row.id;
    return jsonb_build_object('ok', false, 'reason', 'profile_binding_changed');
  end if;

  if operation_row.target_lifecycle_status = 'offboarded' then
    with snapshot_ids as (
      select (entry ->> 'id')::uuid as id
        from jsonb_array_elements(operation_row.payment_snapshot) as entry
       where entry ? 'id'
    ), cancelled as (
      update public.student_payments as payment
         set status = 'CANCELLED', updated_at = now()
       where payment.id in (select id from snapshot_ids)
         and payment.tenant_id = operation_row.tenant_id
         and payment.student_id = operation_row.student_id
         and upper(coalesce(payment.status, '')) = 'PENDING'
       returning payment.id
    )
    select count(*) into cancelled_count from cancelled;
  end if;

  update public.student_offboarding_operations
     set status = 'COMPLETED', completed_at = now(), lease_expires_at = now(), updated_at = now()
   where id = operation_row.id;

  return jsonb_build_object(
    'ok', true,
    'action', 'COMPLETED',
    'future_payments_cancelled', cancelled_count
  );
end;
$function$;

alter function public.begin_student_account_deletion(text, uuid, uuid, uuid, integer) owner to postgres;
alter function public.bind_student_account_deletion_integrations(uuid, uuid, text, integer, text, text, text, integer, text, text) owner to postgres;
alter function public.record_student_account_deletion_provider_state(uuid, uuid, text, text, text) owner to postgres;
alter function public.finalize_student_account_deletion(uuid, uuid, boolean, boolean) owner to postgres;
alter function public.begin_student_offboarding(text, uuid, uuid, text, text, uuid, integer) owner to postgres;
alter function public.bind_student_offboarding_integrations(uuid, uuid, text, integer, text, text, text, integer, text, text) owner to postgres;
alter function public.record_student_offboarding_provider_state(uuid, uuid, text, text) owner to postgres;
alter function public.finalize_student_offboarding(uuid, uuid) owner to postgres;
alter function public.claim_asaas_outbound_message(text, uuid, text, text, uuid, integer) owner to postgres;
alter function public.mark_asaas_outbound_message_submitting(uuid, uuid) owner to postgres;

revoke all on function public.begin_student_account_deletion(text, uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.bind_student_account_deletion_integrations(uuid, uuid, text, integer, text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.record_student_account_deletion_provider_state(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.finalize_student_account_deletion(uuid, uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function public.begin_student_offboarding(text, uuid, uuid, text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.bind_student_offboarding_integrations(uuid, uuid, text, integer, text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.record_student_offboarding_provider_state(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.finalize_student_offboarding(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_asaas_outbound_message(text, uuid, text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.mark_asaas_outbound_message_submitting(uuid, uuid) from public, anon, authenticated;

grant execute on function public.begin_student_account_deletion(text, uuid, uuid, uuid, integer) to service_role;
grant execute on function public.bind_student_account_deletion_integrations(uuid, uuid, text, integer, text, text, text, integer, text, text) to service_role;
grant execute on function public.record_student_account_deletion_provider_state(uuid, uuid, text, text, text) to service_role;
grant execute on function public.finalize_student_account_deletion(uuid, uuid, boolean, boolean) to service_role;
grant execute on function public.begin_student_offboarding(text, uuid, uuid, text, text, uuid, integer) to service_role;
grant execute on function public.bind_student_offboarding_integrations(uuid, uuid, text, integer, text, text, text, integer, text, text) to service_role;
grant execute on function public.record_student_offboarding_provider_state(uuid, uuid, text, text) to service_role;
grant execute on function public.finalize_student_offboarding(uuid, uuid) to service_role;
grant execute on function public.claim_asaas_outbound_message(text, uuid, text, text, uuid, integer) to service_role;
grant execute on function public.mark_asaas_outbound_message_submitting(uuid, uuid) to service_role;

comment on table public.student_account_deletion_claims is
  'Fenced snapshot for permanent test-student deletion; stores only a hash of the billing CPF.';
comment on table public.student_offboarding_operations is
  'Fenced provider-first student suspension/offboarding operation. Terminal payments are never regressed.';
