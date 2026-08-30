begin;

-- A definitive student offboarding must state what happens to the competence
-- in which the student leaves.  The decision is frozen with the provider
-- mutation snapshot; retries cannot silently switch from charging to waiving.
alter table public.student_offboarding_operations
  add column if not exists billing_policy text,
  add column if not exists billing_period_start date,
  add column if not exists billing_cancel_from_date date,
  add column if not exists effective_end_date date,
  add column if not exists preserved_payment_snapshot jsonb
    not null default '[]'::jsonb,
  add column if not exists provider_subscription_final_status text;

alter table public.student_offboarding_operations
  drop constraint if exists
    student_offboarding_operations_target_lifecycle_status_check;
alter table public.student_offboarding_operations
  add constraint student_offboarding_operations_target_lifecycle_status_check
  check (target_lifecycle_status in ('active', 'suspended', 'offboarded'));

alter table public.student_offboarding_operations
  drop constraint if exists student_offboarding_operations_status_check;
alter table public.student_offboarding_operations
  add constraint student_offboarding_operations_status_check check (status in (
    'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
    'UNKNOWN', 'COMPLETED', 'BLOCKED', 'ABORTED'
  ));

do $constraints$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'student_offboarding_billing_policy_check'
       and conrelid = 'public.student_offboarding_operations'::pg_catalog.regclass
  ) then
    alter table public.student_offboarding_operations
      add constraint student_offboarding_billing_policy_check check (
        billing_policy is null
        or billing_policy in (
          'KEEP_OPEN_INVOICES',
          'CHARGE_CURRENT_MONTH',
          'WAIVE_CURRENT_MONTH'
        )
      );
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'student_offboarding_billing_period_check'
       and conrelid = 'public.student_offboarding_operations'::pg_catalog.regclass
  ) then
    alter table public.student_offboarding_operations
      add constraint student_offboarding_billing_period_check check (
        billing_period_start is null
        or billing_period_start =
          pg_catalog.date_trunc('month', billing_period_start)::date
      );
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'student_offboarding_preserved_payment_snapshot_check'
       and conrelid = 'public.student_offboarding_operations'::pg_catalog.regclass
  ) then
    alter table public.student_offboarding_operations
      add constraint student_offboarding_preserved_payment_snapshot_check check (
        pg_catalog.jsonb_typeof(preserved_payment_snapshot) = 'array'
      );
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'student_offboarding_provider_final_status_check'
       and conrelid = 'public.student_offboarding_operations'::pg_catalog.regclass
  ) then
    alter table public.student_offboarding_operations
      add constraint student_offboarding_provider_final_status_check check (
        provider_subscription_final_status is null
        or provider_subscription_final_status in (
          'ACTIVE', 'INACTIVE', 'NOT_FOUND'
        )
      );
  end if;
end;
$constraints$;

create table if not exists public.student_billing_exemptions (
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  period_start date not null,
  reason text not null check (reason in ('OFFBOARDING_CANCELLED')),
  offboarding_operation_id uuid not null
    references public.student_offboarding_operations(id) on delete restrict,
  created_by uuid,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (tenant_id, student_id, period_start),
  check (
    period_start = pg_catalog.date_trunc('month', period_start)::date
  )
);

alter table public.student_billing_exemptions owner to postgres;
alter table public.student_billing_exemptions enable row level security;
alter table public.student_billing_exemptions force row level security;
revoke all on table public.student_billing_exemptions
  from public, anon, authenticated, service_role;
grant select on table public.student_billing_exemptions to service_role;

create index if not exists student_billing_exemptions_operation_idx
  on public.student_billing_exemptions (offboarding_operation_id);

-- The legacy binder considered the one-time enrollment charge part of every
-- lifecycle operation. Monthly pause/waiver intentionally governs recurring
-- tuition only, so a payment integration is required exclusively when the
-- frozen recurring snapshot contains provider payments.
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
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'claim_lost'
    );
  end if;

  payment_required := exists (
    select 1
      from pg_catalog.jsonb_array_elements(
        operation_row.payment_snapshot
      ) as entry
     where nullif(entry ->> 'asaas_payment_id', '') is not null
  );
  if (operation_row.subscription_id is null) is distinct from
       (p_subscription_integration_id is null)
     or payment_required is distinct from
       (p_payment_integration_id is not null)
     or (p_subscription_integration_id is not null and (
       nullif(pg_catalog.btrim(p_subscription_integration_id), '') is null
       or coalesce(p_subscription_version, 0) < 1
       or p_subscription_environment not in (
         'platform', 'production', 'sandbox'
       )
       or p_subscription_mode not in (
         'PLATFORM_MANAGED_ROOT', 'PLATFORM_MANAGED_SUBACCOUNT', 'TENANT_BYOK'
       )
     ))
     or (p_payment_integration_id is not null and (
       nullif(pg_catalog.btrim(p_payment_integration_id), '') is null
       or coalesce(p_payment_version, 0) < 1
       or p_payment_environment not in (
         'platform', 'production', 'sandbox'
       )
       or p_payment_mode not in (
         'PLATFORM_MANAGED_ROOT', 'PLATFORM_MANAGED_SUBACCOUNT', 'TENANT_BYOK'
       )
     ))
  then
    update public.student_offboarding_operations
       set status = case
             when provider_started_at is null then 'ABORTED'
             else 'BLOCKED'
           end,
           last_error = 'integration_snapshot_invalid',
           completed_at = case
             when provider_started_at is null then pg_catalog.now()
             else completed_at
           end,
           lease_expires_at = case
             when provider_started_at is null then pg_catalog.now()
             else lease_expires_at
           end,
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'integration_snapshot_invalid'
    );
  end if;

  expected_snapshot := pg_catalog.jsonb_build_object(
    'subscription', case
      when p_subscription_integration_id is null then null
      else pg_catalog.jsonb_build_object(
        'integration_id', pg_catalog.btrim(p_subscription_integration_id),
        'version', p_subscription_version,
        'environment', p_subscription_environment,
        'mode', p_subscription_mode
      )
    end,
    'payment', case
      when p_payment_integration_id is null then null
      else pg_catalog.jsonb_build_object(
        'integration_id', pg_catalog.btrim(p_payment_integration_id),
        'version', p_payment_version,
        'environment', p_payment_environment,
        'mode', p_payment_mode
      )
    end
  );

  if operation_row.integration_snapshot = '{}'::jsonb then
    update public.student_offboarding_operations
       set integration_snapshot = expected_snapshot,
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'BOUND');
  end if;
  if operation_row.integration_snapshot is distinct from expected_snapshot then
    update public.student_offboarding_operations
       set status = case
             when provider_started_at is null then 'ABORTED'
             else 'BLOCKED'
           end,
           last_error = 'integration_context_changed',
           lease_expires_at = pg_catalog.now(),
           completed_at = case
             when provider_started_at is null then pg_catalog.now()
             else completed_at
           end,
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'integration_context_changed'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'action', 'ALREADY_BOUND'
  );
end;
$function$;

alter function public.bind_student_offboarding_integrations(
  uuid, uuid, text, integer, text, text, text, integer, text, text
) owner to postgres;
revoke all on function public.bind_student_offboarding_integrations(
  uuid, uuid, text, integer, text, text, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.bind_student_offboarding_integrations(
  uuid, uuid, text, integer, text, text, text, integer, text, text
) to service_role;

-- A provider object proven absent before any mutation is a terminal local
-- outcome, not an ambiguous provider call. Release the active-operation fence
-- so the coordinator can choose definitive offboarding or a new enrollment.
create or replace function public.abort_student_lifecycle_operation(
  p_operation_id uuid,
  p_claim_token uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_tenant_id text;
  operation_student_id uuid;
  normalized_reason text := nullif(
    pg_catalog.left(pg_catalog.btrim(coalesce(p_reason, '')), 500),
    ''
  );
  changed_id uuid;
begin
  if p_operation_id is null or p_claim_token is null
     or normalized_reason is null
  then
    raise exception using
      errcode = '22023', message = 'student_lifecycle_abort_invalid';
  end if;

  select operation.tenant_id, operation.student_id
    into operation_tenant_id, operation_student_id
    from public.student_offboarding_operations as operation
   where operation.id = p_operation_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || operation_tenant_id || ':' ||
        operation_student_id::text,
      0
    )
  );

  update public.student_offboarding_operations
     set status = 'ABORTED',
         last_error = normalized_reason,
         lease_expires_at = pg_catalog.now(),
         completed_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = p_operation_id
     and tenant_id = operation_tenant_id
     and student_id = operation_student_id
     and claim_token = p_claim_token
     and (
       (
         status = 'CLAIMED'
         and provider_started_at is null
       )
       or (
         status = 'BLOCKED'
         and provider_started_at is null
         and normalized_reason = 'blocked_pre_provider_released'
       )
       or (
         status in ('PROVIDER_MUTATING', 'UNKNOWN')
         and target_lifecycle_status in ('suspended', 'active')
         and normalized_reason = 'subscription_absent_new_enrollment_required'
       )
     )
   returning id into changed_id;

  return pg_catalog.jsonb_build_object(
    'ok', changed_id is not null,
    'action', case when changed_id is null then null else 'ABORTED' end,
    'reason', case when changed_id is null then 'claim_lost' else null end
  );
end;
$function$;

alter function public.abort_student_lifecycle_operation(uuid, uuid, text)
  owner to postgres;
revoke all on function public.abort_student_lifecycle_operation(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.abort_student_lifecycle_operation(
  uuid, uuid, text
) to service_role;

-- Provider-first lifecycle changes cross two database transactions. Freeze the
-- identity and tenant authority while the durable operation is active so an
-- Asaas mutation can never be finalized against a different student binding.
create or replace function private.guard_student_membership_lifecycle_operation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  subject_id uuid;
  profile_tenant text;
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'tenant_membership_user_id_immutable'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    subject_id := old.user_id;
  else
    subject_id := new.user_id;
  end if;

  select profile.tenant_id
    into profile_tenant
    from public.profiles as profile
   where profile.id = subject_id;

  -- A non-blocking advisory lock closes the BEFORE-trigger visibility gap.
  -- If a begin/finalize RPC already owns the student lifecycle key, fail
  -- immediately instead of waiting while holding a row lock (which could
  -- invert the RPC's advisory -> row lock order). The owning finalizer
  -- transaction can reacquire its own key and continue.
  if profile_tenant is not null and not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || profile_tenant || ':' ||
        subject_id::text,
      0
    )
  ) then
    raise exception 'student_lifecycle_operation_in_flight'
      using errcode = '55000';
  end if;

  if exists (
    select 1
      from public.student_offboarding_operations as operation
     where operation.student_id = subject_id
       and operation.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN'
       )
  ) then
    raise exception 'student_lifecycle_operation_in_flight'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

alter function private.guard_student_membership_lifecycle_operation()
  owner to postgres;
revoke all on function private.guard_student_membership_lifecycle_operation()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_student_membership_lifecycle_operation
  on public.tenant_memberships;
create trigger guard_student_membership_lifecycle_operation
before insert or update or delete on public.tenant_memberships
for each row execute function
  private.guard_student_membership_lifecycle_operation();

create or replace function private.guard_student_profile_lifecycle_operation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_row public.student_offboarding_operations%rowtype;
  finalizer_id text := coalesce(
    pg_catalog.current_setting('app.student_lifecycle_finalizer', true),
    ''
  );
begin
  if tg_op = 'UPDATE' and new.id is distinct from old.id then
    raise exception 'student_profile_id_immutable'
      using errcode = '55000';
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || old.tenant_id || ':' || old.id::text,
      0
    )
  ) then
    raise exception 'student_lifecycle_operation_in_flight'
      using errcode = '55000';
  end if;
  if tg_op = 'UPDATE'
     and new.tenant_id is distinct from old.tenant_id
     and not pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended(
         'student-billing-lifecycle:' || new.tenant_id || ':' || new.id::text,
         0
       )
     )
  then
    raise exception 'student_lifecycle_operation_in_flight'
      using errcode = '55000';
  end if;

  select operation.*
    into operation_row
    from public.student_offboarding_operations as operation
   where operation.student_id = old.id
     and (
       operation.tenant_id = old.tenant_id
       or (tg_op = 'UPDATE' and operation.tenant_id = new.tenant_id)
     )
     and operation.status in (
       'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN'
     )
   order by operation.created_at desc, operation.id
   limit 1;

  -- Check OLD as well as NEW authority so role/tenant rewrites cannot move the
  -- student out of an already-frozen operation. Only the exact finalizer
  -- transaction may apply its compare-and-swap profile update.
  if found and finalizer_id is distinct from operation_row.id::text then
    raise exception 'student_lifecycle_operation_in_flight'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

alter function private.guard_student_profile_lifecycle_operation()
  owner to postgres;
revoke all on function private.guard_student_profile_lifecycle_operation()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_student_profile_lifecycle_binding_update
  on public.profiles;
create trigger guard_student_profile_lifecycle_binding_update
before update of
  id, tenant_id, role, status, lifecycle_status, asaas_customer_id,
  subscription_id, enrollment_payment_id, due_day, monthly_fee,
  asaas_subscription_status, asaas_subscription_synced_at
on public.profiles
for each row execute function private.guard_student_profile_lifecycle_operation();

drop trigger if exists guard_student_profile_lifecycle_delete
  on public.profiles;
create trigger guard_student_profile_lifecycle_delete
before delete on public.profiles
for each row execute function private.guard_student_profile_lifecycle_operation();

-- A cancelled offboarding competence must never be reintroduced by the
-- RECORDED_INVOICE arm of the monthly roster when a cancelled legacy invoice
-- is still retained for audit.
create or replace function public.suppress_exempt_monthly_payment_obligation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
      from public.student_billing_exemptions as exemption
     where exemption.tenant_id = new.tenant_id
       and exemption.student_id = new.student_id
       and exemption.period_start = new.period_start
  ) then
    return null;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_suppress_exempt_monthly_payment_obligation
  on public.monthly_payment_obligations;
create trigger trg_suppress_exempt_monthly_payment_obligation
before insert on public.monthly_payment_obligations
for each row execute function public.suppress_exempt_monthly_payment_obligation();

alter function public.suppress_exempt_monthly_payment_obligation()
  owner to postgres;
revoke all on function public.suppress_exempt_monthly_payment_obligation()
  from public, anon, authenticated, service_role;

create or replace function public.begin_student_offboarding_with_billing_policy(
  p_tenant_id text,
  p_student_id uuid,
  p_requested_by uuid,
  p_target_status text,
  p_reason text,
  p_billing_policy text,
  p_effective_end_date date,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_target text := lower(pg_catalog.btrim(coalesce(p_target_status, '')));
  normalized_policy text := upper(pg_catalog.btrim(coalesce(p_billing_policy, '')));
  normalized_reason text := nullif(
    pg_catalog.btrim(coalesce(p_reason, '')),
    ''
  );
  business_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_effective_end_date date := p_effective_end_date;
  business_period date;
  cancel_from date;
  base_result jsonb;
  operation_id uuid;
  operation_row public.student_offboarding_operations%rowtype;
  desired_payments jsonb := '[]'::jsonb;
  desired_preserved_payments jsonb := '[]'::jsonb;
  expected_subscription_final_status text;
begin
  if normalized_reason is null or pg_catalog.length(normalized_reason) > 500 then
    raise exception using
      errcode = '22023', message = 'student_offboarding_reason_required';
  end if;
  if v_effective_end_date is null
     or v_effective_end_date < date '2020-01-01'
     or v_effective_end_date > business_today
  then
    raise exception using
      errcode = '22023',
      message = 'student_offboarding_effective_end_date_invalid';
  end if;
  business_period := pg_catalog.date_trunc('month', v_effective_end_date)::date;

  if normalized_target = 'suspended' then
    if normalized_policy not in ('', 'KEEP_OPEN_INVOICES') then
      raise exception using
        errcode = '22023',
        message = 'student_offboarding_billing_policy_invalid';
    end if;
    normalized_policy := 'KEEP_OPEN_INVOICES';
    cancel_from := null;
    expected_subscription_final_status := 'INACTIVE';
  elsif normalized_target = 'offboarded' then
    if normalized_policy not in (
      'CHARGE_CURRENT_MONTH', 'WAIVE_CURRENT_MONTH'
    ) then
      raise exception using
        errcode = '22023',
        message = 'student_offboarding_billing_policy_required';
    end if;
    cancel_from := case normalized_policy
      when 'WAIVE_CURRENT_MONTH' then business_period
      else (business_period + interval '1 month')::date
    end;
    expected_subscription_final_status := case normalized_policy
      when 'WAIVE_CURRENT_MONTH' then 'NOT_FOUND'
      else 'INACTIVE'
    end;
  else
    raise exception using
      errcode = '22023',
      message = 'student_offboarding_target_invalid';
  end if;

  -- The existing function owns all lifecycle/in-flight communication fences.
  -- This wrapper runs in the same transaction and takes the same advisory
  -- lock, then replaces the still-unsubmitted invoice snapshot atomically.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || p_tenant_id || ':' ||
        p_student_id::text,
      0
    )
  );
  -- A BLOCKED operation that never crossed the provider fence is safe to
  -- release under this same student advisory lock. Doing this inside begin
  -- makes crash recovery independent from a follow-up RPC and its old token.
  update public.student_offboarding_operations as operation
     set status = 'ABORTED',
         lease_expires_at = pg_catalog.now(),
         completed_at = pg_catalog.now(),
         snapshot = operation.snapshot || pg_catalog.jsonb_build_object(
           'pre_provider_block_released_at', pg_catalog.now(),
           'pre_provider_block_last_error', operation.last_error
         ),
         updated_at = pg_catalog.now()
   where operation.tenant_id = p_tenant_id
     and operation.student_id = p_student_id
     and operation.status = 'BLOCKED'
     and operation.provider_started_at is null;

  -- Reject an implicit refund before creating a new durable operation. This
  -- runs after safe BLOCKED recovery so even a changed retry decision cannot
  -- leave the previous pre-provider claim as a permanent student fence.
  if normalized_target = 'offboarded'
     and normalized_policy = 'WAIVE_CURRENT_MONTH'
     and exists (
       select 1
         from public.student_payments as payment
        where payment.tenant_id = p_tenant_id
          and payment.student_id = p_student_id
          and payment.payment_type = 'SUBSCRIPTION'
          and payment.due_date >= business_period
          and payment.due_date < (business_period + interval '1 month')::date
          and upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
            'PENDING', 'OVERDUE', 'CANCELLED'
          )
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'current_period_not_waivable'
    );
  end if;

  -- Serialize membership mutations with operation creation. Once the claim is
  -- visible, the lifecycle guard below keeps this authority frozen through the
  -- provider round-trip.
  perform 1
    from public.tenant_memberships as membership
   where membership.user_id = p_student_id
   for share;
  base_result := public.begin_student_offboarding(
    p_tenant_id,
    p_student_id,
    p_requested_by,
    normalized_target,
    normalized_reason,
    p_claim_token,
    p_lease_seconds
  );

  if coalesce(base_result ->> 'action', '') in (
    'ALREADY_COMPLETED', 'IN_PROGRESS', 'REVIEW_REQUIRED'
  ) or coalesce((base_result ->> 'ok')::boolean, false) is false then
    return base_result;
  end if;

  begin
    operation_id := (base_result ->> 'operation_id')::uuid;
  exception when invalid_text_representation then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'offboarding_operation_invalid'
    );
  end;

  if normalized_target = 'offboarded' then
    if exists (
      select 1
        from public.student_payments as payment
       where payment.tenant_id = p_tenant_id
         and payment.student_id = p_student_id
         and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
           'PENDING', 'OVERDUE'
         )
         and payment.payment_type = 'SUBSCRIPTION'
         and payment.due_date >= cancel_from
         and nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '')
               is not null
         and nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
               is not null
         and pg_catalog.btrim(payment.asaas_payment_id) <>
               pg_catalog.btrim(payment.asaas_id)
    ) then
      update public.student_offboarding_operations
         set status = 'BLOCKED',
             last_error = 'payment_provider_binding_divergent',
             updated_at = pg_catalog.now()
       where id = operation_id;
      return pg_catalog.jsonb_build_object(
        'ok', false, 'action', 'REVIEW_REQUIRED',
        'reason', 'payment_provider_binding_divergent',
        'operation_id', operation_id
      );
    end if;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', payment.id,
      'asaas_payment_id', coalesce(
        nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), ''),
        nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
      ),
      'status', payment.status,
      'due_date', payment.due_date,
      'value', payment.value
    ) order by payment.id), '[]'::jsonb)
      into desired_payments
      from public.student_payments as payment
     where payment.tenant_id = p_tenant_id
       and payment.student_id = p_student_id
       and payment.payment_type = 'SUBSCRIPTION'
       and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
         'PENDING', 'OVERDUE'
       )
       and payment.due_date >= cancel_from;

    if normalized_policy = 'CHARGE_CURRENT_MONTH' then
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', payment.id,
        'asaas_payment_id', coalesce(
          nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), ''),
          nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
        ),
        'status', payment.status,
        'provider_status', payment.provider_status,
        'due_date', payment.due_date,
        'value', payment.value
      ) order by payment.id), '[]'::jsonb)
        into desired_preserved_payments
        from public.student_payments as payment
       where payment.tenant_id = p_tenant_id
         and payment.student_id = p_student_id
         and payment.payment_type = 'SUBSCRIPTION'
         and payment.due_date >= business_period
         and payment.due_date <
           (business_period + interval '1 month')::date
         and upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
           'CANCELLED', 'DELETED', 'REFUNDED', 'REVERSED'
         );
    end if;

    if exists (
      select 1
        from pg_catalog.jsonb_array_elements(desired_payments) as entry
       where nullif(entry ->> 'asaas_payment_id', '') is not null
       group by entry ->> 'asaas_payment_id'
      having pg_catalog.count(*) > 1
    ) then
      update public.student_offboarding_operations
         set status = 'BLOCKED',
             last_error = 'payment_provider_binding_duplicate',
             updated_at = pg_catalog.now()
       where id = operation_id;
      return pg_catalog.jsonb_build_object(
        'ok', false, 'action', 'REVIEW_REQUIRED',
        'reason', 'payment_provider_binding_duplicate',
        'operation_id', operation_id
      );
    end if;
  end if;

  select operation.* into operation_row
    from public.student_offboarding_operations as operation
   where operation.id = operation_id
     and operation.claim_token = p_claim_token
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'claim_lost'
    );
  end if;

  if operation_row.reason is distinct from normalized_reason then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'offboarding_reason_snapshot_mismatch',
           updated_at = pg_catalog.now()
     where id = operation_id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'offboarding_reason_snapshot_mismatch',
      'operation_id', operation_id
    );
  end if;

  if normalized_policy = 'CHARGE_CURRENT_MONTH' and (
       pg_catalog.jsonb_array_length(desired_preserved_payments) <> 1
       or exists (
         select 1
           from pg_catalog.jsonb_array_elements(
             desired_preserved_payments
           ) as entry
          where nullif(entry ->> 'asaas_payment_id', '') is null
       )
     )
  then
    update public.student_offboarding_operations
       set status = case
             when provider_started_at is null then 'ABORTED'
             else 'BLOCKED'
           end,
           last_error = 'preserved_current_payment_invalid',
           lease_expires_at = case
             when provider_started_at is null then pg_catalog.now()
             else lease_expires_at
           end,
           completed_at = case
             when provider_started_at is null then pg_catalog.now()
             else completed_at
           end,
           updated_at = pg_catalog.now()
     where id = operation_id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'preserved_current_payment_invalid',
      'operation_id', operation_id
    );
  end if;

  if operation_row.billing_policy is null then
    if operation_row.status <> 'CLAIMED'
       or operation_row.provider_started_at is not null
    then
      update public.student_offboarding_operations
         set status = 'BLOCKED',
             last_error = 'billing_policy_missing_after_provider_start',
             updated_at = pg_catalog.now()
       where id = operation_id;
      return pg_catalog.jsonb_build_object(
        'ok', false, 'action', 'REVIEW_REQUIRED',
        'reason', 'billing_policy_missing_after_provider_start',
        'operation_id', operation_id
      );
    end if;
    update public.student_offboarding_operations
       set billing_policy = normalized_policy,
           billing_period_start = business_period,
           billing_cancel_from_date = cancel_from,
           effective_end_date = v_effective_end_date,
           payment_snapshot = desired_payments,
           preserved_payment_snapshot = desired_preserved_payments,
           provider_subscription_final_status =
             expected_subscription_final_status,
           snapshot = snapshot || pg_catalog.jsonb_build_object(
             'billing_policy', normalized_policy,
             'billing_period_start', business_period,
             'billing_cancel_from_date', cancel_from,
             'effective_end_date', v_effective_end_date,
             'reason', normalized_reason,
             'payment_ids', desired_payments,
             'preserved_payment_ids', desired_preserved_payments,
             'provider_subscription_final_status',
               expected_subscription_final_status
           ),
           updated_at = pg_catalog.now()
     where id = operation_id
     returning * into operation_row;
  elsif operation_row.billing_policy is distinct from normalized_policy
     or operation_row.billing_period_start is distinct from business_period
     or operation_row.billing_cancel_from_date is distinct from cancel_from
     or operation_row.effective_end_date is distinct from v_effective_end_date
     or operation_row.provider_subscription_final_status is distinct from
       expected_subscription_final_status
     or (
       operation_row.provider_started_at is null
       and operation_row.status = 'CLAIMED'
       and (
         operation_row.payment_snapshot is distinct from desired_payments
         or operation_row.preserved_payment_snapshot is distinct from
           desired_preserved_payments
       )
     )
  then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'offboarding_billing_snapshot_mismatch',
           updated_at = pg_catalog.now()
     where id = operation_id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'offboarding_billing_snapshot_mismatch',
      'operation_id', operation_id
    );
  end if;

  return base_result || pg_catalog.jsonb_build_object(
    'billing_policy', operation_row.billing_policy,
    'billing_period_start', operation_row.billing_period_start,
    'billing_cancel_from_date', operation_row.billing_cancel_from_date,
    'effective_end_date', operation_row.effective_end_date,
    'reason', operation_row.reason,
    'payment_snapshot', operation_row.payment_snapshot,
    'preserved_payment_snapshot', operation_row.preserved_payment_snapshot,
    'provider_subscription_final_status',
      operation_row.provider_subscription_final_status
  );
end;
$function$;

alter function public.begin_student_offboarding_with_billing_policy(
  text, uuid, uuid, text, text, text, date, uuid, integer
) owner to postgres;
revoke all on function public.begin_student_offboarding_with_billing_policy(
  text, uuid, uuid, text, text, text, date, uuid, integer
) from public, anon, authenticated;
grant execute on function public.begin_student_offboarding_with_billing_policy(
  text, uuid, uuid, text, text, text, date, uuid, integer
) to service_role;

create or replace function public.finalize_student_offboarding_with_billing_policy(
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
  exempted_count integer := 0;
  schedules_cancelled integer := 0;
begin
  select operation.tenant_id, operation.student_id
    into operation_tenant_id, operation_student_id
    from public.student_offboarding_operations as operation
   where operation.id = p_operation_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || operation_tenant_id || ':' ||
        operation_student_id::text,
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
     or operation_row.target_lifecycle_status not in ('suspended', 'offboarded')
     or operation_row.billing_policy is null
     or operation_row.billing_period_start is null
     or operation_row.effective_end_date is null
     or operation_row.provider_subscription_final_status is distinct from (
       case
         when operation_row.target_lifecycle_status = 'suspended'
           then 'INACTIVE'
         when operation_row.billing_policy = 'WAIVE_CURRENT_MONTH'
           then 'NOT_FOUND'
         else 'INACTIVE'
       end
     )
     or (
       operation_row.billing_policy = 'CHARGE_CURRENT_MONTH'
       and pg_catalog.jsonb_array_length(
         operation_row.preserved_payment_snapshot
       ) <> 1
     )
     or (
       operation_row.billing_policy <> 'CHARGE_CURRENT_MONTH'
       and pg_catalog.jsonb_array_length(
         operation_row.preserved_payment_snapshot
       ) <> 0
     )
     or (
       operation_row.target_lifecycle_status = 'offboarded'
       and (
         operation_row.billing_policy not in (
           'CHARGE_CURRENT_MONTH', 'WAIVE_CURRENT_MONTH'
         )
         or operation_row.billing_cancel_from_date is null
       )
     )
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if (
    select pg_catalog.count(*)
      from public.tenant_memberships as membership
     where membership.user_id = operation_row.student_id
  ) <> 1 or not exists (
    select 1
      from public.tenant_memberships as membership
     where membership.user_id = operation_row.student_id
       and membership.tenant_id = operation_row.tenant_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'membership_scope_changed_before_finalize',
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'membership_scope_changed'
    );
  end if;

  -- CHARGE_CURRENT_MONTH owns two disjoint snapshots: future open invoices to
  -- cancel and the single current-competence invoice to preserve. Revalidate
  -- the preserved row separately so it can never enter the cancellation CTE.
  if operation_row.billing_policy = 'CHARGE_CURRENT_MONTH' and (
    exists (
      select 1
        from pg_catalog.jsonb_array_elements(
          operation_row.preserved_payment_snapshot
        ) as entry
        left join public.student_payments as payment
          on payment.id = (entry ->> 'id')::uuid
         and payment.tenant_id = operation_row.tenant_id
         and payment.student_id = operation_row.student_id
       where payment.id is null
          or payment.payment_type is distinct from 'SUBSCRIPTION'
          or (
            nullif(
              pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), ''
            ) is not null
            and nullif(
              pg_catalog.btrim(coalesce(payment.asaas_id, '')), ''
            ) is not null
            and pg_catalog.btrim(payment.asaas_payment_id) <>
              pg_catalog.btrim(payment.asaas_id)
          )
          or coalesce(
               nullif(
                 pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), ''
               ),
               nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
             ) is distinct from nullif(entry ->> 'asaas_payment_id', '')
          or payment.due_date is distinct from (entry ->> 'due_date')::date
          or payment.due_date < operation_row.billing_period_start
          or payment.due_date >=
            (operation_row.billing_period_start + interval '1 month')::date
          or pg_catalog.round(coalesce(payment.value, 0), 2) is distinct from
             pg_catalog.round((entry ->> 'value')::numeric, 2)
          or upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
               'CANCELLED', 'DELETED', 'REFUNDED', 'REVERSED'
             )
    ) or exists (
      select 1
        from public.student_payments as payment
       where payment.tenant_id = operation_row.tenant_id
         and payment.student_id = operation_row.student_id
         and payment.payment_type = 'SUBSCRIPTION'
         and payment.due_date >= operation_row.billing_period_start
         and payment.due_date <
           (operation_row.billing_period_start + interval '1 month')::date
         and upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
           'CANCELLED', 'DELETED', 'REFUNDED', 'REVERSED'
         )
         and not exists (
           select 1
             from pg_catalog.jsonb_array_elements(
               operation_row.preserved_payment_snapshot
             ) as entry
            where (entry ->> 'id')::uuid = payment.id
         )
    )
  ) then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'preserved_payment_snapshot_changed_before_finalize',
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'preserved_payment_snapshot_changed'
    );
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(operation_row.payment_snapshot) as entry
      left join public.student_payments as payment
        on payment.id = (entry ->> 'id')::uuid
       and payment.tenant_id = operation_row.tenant_id
       and payment.student_id = operation_row.student_id
     where payment.id is null
        or coalesce(
             nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), ''),
             nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
           ) is distinct from nullif(entry ->> 'asaas_payment_id', '')
        or payment.due_date is distinct from (entry ->> 'due_date')::date
        or pg_catalog.round(coalesce(payment.value, 0), 2) is distinct from
           pg_catalog.round((entry ->> 'value')::numeric, 2)
        or upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
             'PENDING', 'OVERDUE', 'CANCELLED'
           )
  ) or (
    operation_row.target_lifecycle_status = 'offboarded'
    and exists (
      select 1
        from public.student_payments as payment
       where payment.tenant_id = operation_row.tenant_id
         and payment.student_id = operation_row.student_id
         and payment.payment_type = 'SUBSCRIPTION'
         and upper(pg_catalog.btrim(coalesce(payment.status, ''))) <>
           'CANCELLED'
         and payment.due_date >= operation_row.billing_cancel_from_date
         and not exists (
           select 1
             from pg_catalog.jsonb_array_elements(
               operation_row.payment_snapshot
             ) as entry
            where (entry ->> 'id')::uuid = payment.id
         )
    )
  ) then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'payment_snapshot_changed_before_finalize',
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'payment_snapshot_changed'
    );
  end if;

  if operation_row.target_lifecycle_status = 'offboarded'
     and exists (
       select 1
         from public.monthly_payment_obligations as obligation
        where obligation.tenant_id = operation_row.tenant_id
          and obligation.student_id = operation_row.student_id
          and obligation.period_start >= operation_row.billing_cancel_from_date
          and (
            coalesce(obligation.settled_amount, 0) > 0
            or upper(pg_catalog.btrim(coalesce(obligation.status, ''))) in (
              'SETTLED', 'PAID', 'RECEIVED'
            )
          )
     )
  then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'settled_obligation_in_cancellation_period',
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'settled_obligation_in_cancellation_period'
    );
  end if;

  -- A waiver is not an implicit refund. If Asaas settled/confirmed the current
  -- competence while the operation was in flight, stop for human review.
  if operation_row.billing_policy = 'WAIVE_CURRENT_MONTH'
     and exists (
       select 1
         from public.student_payments as payment
        where payment.tenant_id = operation_row.tenant_id
          and payment.student_id = operation_row.student_id
          and payment.payment_type = 'SUBSCRIPTION'
          and payment.due_date >= operation_row.billing_period_start
          and payment.due_date <
            (operation_row.billing_period_start + interval '1 month')::date
          and upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
            'PENDING', 'OVERDUE', 'CANCELLED', 'NAO_RECEITA'
          )
     )
  then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'current_period_not_waivable',
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'current_period_not_waivable'
    );
  end if;

  perform pg_catalog.set_config(
    'app.student_lifecycle_finalizer', operation_row.id::text, true
  );
  update public.profiles as profile
     set status = 'Inativo',
         lifecycle_status = operation_row.target_lifecycle_status,
         subscription_id = case
           when operation_row.target_lifecycle_status = 'offboarded'
             and operation_row.billing_policy = 'WAIVE_CURRENT_MONTH'
             then null
           else profile.subscription_id
         end,
         asaas_subscription_status =
           operation_row.provider_subscription_final_status,
         asaas_subscription_synced_at = pg_catalog.now(),
         suspended_at = case
           when operation_row.target_lifecycle_status = 'suspended'
             then pg_catalog.now()
           else null
         end,
         suspended_reason = case
           when operation_row.target_lifecycle_status = 'suspended'
             then operation_row.reason
           else null
         end,
         offboarding_status = case
           when operation_row.target_lifecycle_status = 'offboarded'
             then 'COMPLETED'
           else null
         end,
         offboarding_completed_at = case
           when operation_row.target_lifecycle_status = 'offboarded'
             then pg_catalog.now()
           else null
         end,
         offboarding_reason = case
           when operation_row.target_lifecycle_status = 'offboarded'
             then operation_row.reason
           else null
         end,
         offboarding_last_day = case
           when operation_row.target_lifecycle_status = 'offboarded'
             then operation_row.effective_end_date
           else null
         end
   where profile.id = operation_row.student_id
     and profile.tenant_id = operation_row.tenant_id
     and profile.role = 'STUDENT'
     and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) =
       operation_row.source_lifecycle_status
     and nullif(pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')), '')
       is not distinct from operation_row.customer_id
     and nullif(pg_catalog.btrim(coalesce(profile.subscription_id, '')), '')
       is not distinct from operation_row.subscription_id
     and nullif(pg_catalog.btrim(coalesce(profile.enrollment_payment_id, '')), '')
       is not distinct from operation_row.enrollment_payment_id
   returning profile.id into updated_profile_id;
  if updated_profile_id is null then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'profile_binding_changed_before_finalize',
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'profile_binding_changed'
    );
  end if;

  if operation_row.target_lifecycle_status = 'offboarded' then
    with cancelled_bookings as (
      update public.bookings as booking
         set status = 'CANCELLED'
       where booking.tenant_id = operation_row.tenant_id
         and booking.student_id = operation_row.student_id
         and upper(pg_catalog.btrim(coalesce(booking.status, ''))) = 'SCHEDULED'
       returning booking.id
    )
    select pg_catalog.count(*) into schedules_cancelled
      from cancelled_bookings;

    with snapshot_ids as (
      select (entry ->> 'id')::uuid as id
        from pg_catalog.jsonb_array_elements(
          operation_row.payment_snapshot
        ) as entry
       where entry ? 'id'
    ), cancelled as (
      update public.student_payments as payment
         set status = 'CANCELLED', updated_at = pg_catalog.now()
       where payment.id in (select id from snapshot_ids)
         and payment.tenant_id = operation_row.tenant_id
         and payment.student_id = operation_row.student_id
         and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
           'PENDING', 'OVERDUE'
         )
       returning payment.id
    )
    select pg_catalog.count(*) into cancelled_count from cancelled;

    insert into public.student_billing_exemptions (
      tenant_id,
      student_id,
      period_start,
      reason,
      offboarding_operation_id,
      created_by
    )
    select distinct
      operation_row.tenant_id,
      operation_row.student_id,
      period.period_start,
      'OFFBOARDING_CANCELLED',
      operation_row.id,
      operation_row.requested_by
    from (
      select pg_catalog.date_trunc(
        'month',
        (entry ->> 'due_date')::date
      )::date as period_start
      from pg_catalog.jsonb_array_elements(
        operation_row.payment_snapshot
      ) as entry
      union all
      select obligation.period_start
        from public.monthly_payment_obligations as obligation
       where obligation.tenant_id = operation_row.tenant_id
         and obligation.student_id = operation_row.student_id
         and obligation.period_start >= operation_row.billing_cancel_from_date
      union all
      select series.period_start::date
        from pg_catalog.generate_series(
          operation_row.billing_cancel_from_date::timestamptz,
          greatest(
            operation_row.billing_cancel_from_date,
            pg_catalog.date_trunc(
              'month',
              pg_catalog.now() at time zone 'America/Sao_Paulo'
            )::date
          )::timestamptz,
          interval '1 month'
        ) as series(period_start)
    ) as period
    on conflict (tenant_id, student_id, period_start) do nothing;
    get diagnostics exempted_count = row_count;

    update public.monthly_payment_obligations as obligation
       set status = 'EXCLUDED',
           payment_ids = '{}',
           billed_amount = 0,
           settled_amount = 0,
           details = coalesce(obligation.details, '{}'::jsonb) ||
             pg_catalog.jsonb_build_object(
               'excluded_reason', 'OFFBOARDING_CANCELLED',
               'offboarding_operation_id', operation_row.id
             ),
           updated_at = pg_catalog.now()
     where obligation.tenant_id = operation_row.tenant_id
       and obligation.student_id = operation_row.student_id
       and exists (
         select 1
           from public.student_billing_exemptions as exemption
          where exemption.tenant_id = obligation.tenant_id
            and exemption.student_id = obligation.student_id
            and exemption.period_start = obligation.period_start
       );
  end if;

  update public.student_offboarding_operations
     set status = 'COMPLETED',
         completed_at = pg_catalog.now(),
         lease_expires_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = operation_row.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'COMPLETED',
    'billing_policy', operation_row.billing_policy,
    'billing_period_start', operation_row.billing_period_start,
    'effective_end_date', operation_row.effective_end_date,
    'provider_subscription_final_status',
      operation_row.provider_subscription_final_status,
    'payments_cancelled', cancelled_count,
    'billing_periods_exempted', exempted_count,
    'schedules_cancelled', schedules_cancelled
  );
end;
$function$;

alter function public.finalize_student_offboarding_with_billing_policy(
  uuid, uuid
) owner to postgres;
revoke all on function public.finalize_student_offboarding_with_billing_policy(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.finalize_student_offboarding_with_billing_policy(
  uuid, uuid
) to service_role;

-- The legacy public entry points do not carry a monthly billing decision.
-- Keep them as private implementation details for the policy-aware begin RPC,
-- but prevent service clients from creating or finalizing an operation that
-- can bypass CHARGE_CURRENT_MONTH versus WAIVE_CURRENT_MONTH.
revoke all on function public.begin_student_offboarding(
  text, uuid, uuid, text, text, uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.finalize_student_offboarding(
  uuid, uuid
) from public, anon, authenticated, service_role;

-- Reactivation is also provider-first and uses the same unique active
-- operation index.  An offboarding and a reactivation therefore cannot cross
-- each other between the Asaas PUT and the local lifecycle update.
create or replace function public.begin_student_reactivation(
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
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  safe_lease integer := greatest(
    60, least(coalesce(p_lease_seconds, 300), 600)
  );
  profile_row public.profiles%rowtype;
  operation_row public.student_offboarding_operations%rowtype;
  action text;
  retry_after integer;
  business_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
begin
  if normalized_tenant is null
     or p_student_id is null
     or p_claim_token is null
  then
    raise exception using
      errcode = '22023', message = 'student_reactivation_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' ||
        p_student_id::text,
      0
    )
  );

  -- A pre-provider BLOCKED reactivation is locally reversible. Release it and
  -- create/reclaim the next durable operation under the same advisory lock so
  -- a crashed coordinator cannot strand the student indefinitely.
  update public.student_offboarding_operations as operation
     set status = 'ABORTED',
         lease_expires_at = pg_catalog.now(),
         completed_at = pg_catalog.now(),
         snapshot = operation.snapshot || pg_catalog.jsonb_build_object(
           'pre_provider_block_released_at', pg_catalog.now(),
           'pre_provider_block_last_error', operation.last_error
         ),
         updated_at = pg_catalog.now()
   where operation.tenant_id = normalized_tenant
     and operation.student_id = p_student_id
     and operation.status = 'BLOCKED'
     and operation.provider_started_at is null;

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_student_id
   for update;
  if not found
     or profile_row.tenant_id is distinct from normalized_tenant
     or profile_row.role is distinct from 'STUDENT'
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'profile_scope_changed'
    );
  end if;
  if lower(pg_catalog.btrim(coalesce(profile_row.lifecycle_status, ''))) = 'active' then
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'ALREADY_COMPLETED');
  end if;
  if lower(pg_catalog.btrim(coalesce(profile_row.lifecycle_status, ''))) <> 'suspended' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'new_enrollment_required'
    );
  end if;
  if nullif(pg_catalog.btrim(coalesce(profile_row.asaas_customer_id, '')), '') is null
     or nullif(pg_catalog.btrim(coalesce(profile_row.subscription_id, '')), '') is null
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'subscription_binding_missing'
    );
  end if;
  if profile_row.due_day is null
     or profile_row.due_day < 1
     or profile_row.due_day > 31
     or profile_row.monthly_fee is null
     or profile_row.monthly_fee <= 0
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'subscription_billing_terms_invalid'
    );
  end if;
  perform 1
    from public.tenant_memberships as membership
   where membership.user_id = p_student_id
   for share;
  if (
    select pg_catalog.count(*)
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
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'membership_scope_changed'
    );
  end if;

  select operation.* into operation_row
    from public.student_offboarding_operations as operation
   where operation.tenant_id = normalized_tenant
     and operation.student_id = p_student_id
     and operation.status in (
       'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
       'UNKNOWN', 'BLOCKED'
     )
   for update;

  if not found then
    insert into public.student_offboarding_operations (
      tenant_id, student_id, requested_by, source_lifecycle_status,
      target_lifecycle_status, reason, status, claim_token, lease_expires_at,
      customer_id, subscription_id, enrollment_payment_id, payment_snapshot,
      snapshot, billing_policy, billing_period_start, effective_end_date,
      provider_subscription_final_status
    ) values (
      normalized_tenant, p_student_id, p_requested_by, 'suspended',
      'active', 'Reativado pela coordenação', 'CLAIMED', p_claim_token,
      pg_catalog.now() + pg_catalog.make_interval(secs => safe_lease),
      nullif(pg_catalog.btrim(profile_row.asaas_customer_id), ''),
      nullif(pg_catalog.btrim(profile_row.subscription_id), ''),
      nullif(pg_catalog.btrim(coalesce(profile_row.enrollment_payment_id, '')), ''),
      '[]'::jsonb,
      pg_catalog.jsonb_build_object(
        'tenant_id', normalized_tenant,
        'student_id', p_student_id,
        'role', profile_row.role,
        'lifecycle_status', 'suspended',
        'customer_id', nullif(pg_catalog.btrim(profile_row.asaas_customer_id), ''),
        'subscription_id', nullif(pg_catalog.btrim(profile_row.subscription_id), ''),
        'due_day', profile_row.due_day,
        'monthly_fee', profile_row.monthly_fee,
        'provider_subscription_final_status', 'ACTIVE'
      ),
      'KEEP_OPEN_INVOICES',
      pg_catalog.date_trunc('month', business_today)::date,
      business_today,
      'ACTIVE'
    ) returning * into operation_row;
  end if;

  if operation_row.target_lifecycle_status is distinct from 'active'
     or operation_row.source_lifecycle_status is distinct from 'suspended'
     or operation_row.customer_id is distinct from
       nullif(pg_catalog.btrim(profile_row.asaas_customer_id), '')
     or operation_row.subscription_id is distinct from
       nullif(pg_catalog.btrim(profile_row.subscription_id), '')
     or operation_row.snapshot -> 'due_day' is distinct from
       pg_catalog.to_jsonb(profile_row.due_day)
     or operation_row.snapshot -> 'monthly_fee' is distinct from
       pg_catalog.to_jsonb(profile_row.monthly_fee)
     or operation_row.provider_subscription_final_status is distinct from
       'ACTIVE'
     or operation_row.preserved_payment_snapshot is distinct from '[]'::jsonb
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'lifecycle_operation_in_flight'
    );
  end if;
  if operation_row.status = 'BLOCKED' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', coalesce(operation_row.last_error, 'operation_blocked')
    );
  end if;
  if operation_row.status = 'CLAIMED'
     and operation_row.claim_token <> p_claim_token
     and operation_row.lease_expires_at > pg_catalog.now()
  then
    retry_after := greatest(
      1,
      pg_catalog.ceil(extract(
        epoch from operation_row.lease_expires_at - pg_catalog.now()
      ))::integer
    );
    return pg_catalog.jsonb_build_object(
      'ok', true, 'action', 'IN_PROGRESS',
      'operation_id', operation_row.id,
      'retry_after_seconds', retry_after
    );
  end if;

  action := case
    when operation_row.status in ('PROVIDER_MUTATING', 'UNKNOWN')
      then 'RECONCILE_REQUIRED'
    when operation_row.status = 'PROVIDER_COMPLETE'
      then 'FINALIZE_REQUIRED'
    else 'PROCEED'
  end;
  update public.student_offboarding_operations
     set claim_token = p_claim_token,
         requested_by = p_requested_by,
         lease_expires_at = pg_catalog.now() +
           pg_catalog.make_interval(secs => safe_lease),
         updated_at = pg_catalog.now()
   where id = operation_row.id
   returning * into operation_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', action,
    'operation_id', operation_row.id,
    'claim_token', operation_row.claim_token,
    'source_lifecycle_status', operation_row.source_lifecycle_status,
    'target_lifecycle_status', operation_row.target_lifecycle_status,
    'customer_id', operation_row.customer_id,
    'subscription_id', operation_row.subscription_id,
    'due_day', operation_row.snapshot -> 'due_day',
    'monthly_fee', operation_row.snapshot -> 'monthly_fee',
    'enrollment_payment_id', operation_row.enrollment_payment_id,
    'billing_policy', operation_row.billing_policy,
    'billing_period_start', operation_row.billing_period_start,
    'effective_end_date', operation_row.effective_end_date,
    'payment_snapshot', operation_row.payment_snapshot,
    'provider_subscription_final_status',
      operation_row.provider_subscription_final_status
  );
end;
$function$;

create or replace function public.finalize_student_reactivation(
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
  changed_id uuid;
begin
  select operation.tenant_id, operation.student_id
    into operation_tenant_id, operation_student_id
    from public.student_offboarding_operations as operation
   where operation.id = p_operation_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || operation_tenant_id || ':' ||
        operation_student_id::text,
      0
    )
  );
  select operation.* into operation_row
    from public.student_offboarding_operations as operation
   where operation.id = p_operation_id
   for update;
  if not found
     or operation_row.claim_token is distinct from p_claim_token
     or operation_row.status <> 'PROVIDER_COMPLETE'
     or operation_row.source_lifecycle_status <> 'suspended'
     or operation_row.target_lifecycle_status <> 'active'
     or operation_row.provider_subscription_final_status is distinct from
       'ACTIVE'
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if (
    select pg_catalog.count(*)
      from public.tenant_memberships as membership
     where membership.user_id = operation_row.student_id
  ) <> 1 or not exists (
    select 1
      from public.tenant_memberships as membership
     where membership.user_id = operation_row.student_id
       and membership.tenant_id = operation_row.tenant_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'membership_scope_changed_before_reactivation',
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'membership_scope_changed'
    );
  end if;

  perform pg_catalog.set_config(
    'app.student_lifecycle_finalizer', operation_row.id::text, true
  );
  update public.profiles as profile
     set status = 'Ativo',
         lifecycle_status = 'active',
         asaas_subscription_status =
           operation_row.provider_subscription_final_status,
         asaas_subscription_synced_at = pg_catalog.now(),
         suspended_at = null,
         suspended_reason = null,
         offboarding_status = null,
         offboarding_requested_at = null,
         offboarding_completed_at = null,
         offboarding_last_day = null,
         offboarding_reason = null
   where profile.id = operation_row.student_id
     and profile.tenant_id = operation_row.tenant_id
     and profile.role = 'STUDENT'
     and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) =
       'suspended'
     and nullif(pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')), '')
       is not distinct from operation_row.customer_id
     and nullif(pg_catalog.btrim(coalesce(profile.subscription_id, '')), '')
       is not distinct from operation_row.subscription_id
     and operation_row.snapshot -> 'due_day' is not distinct from
       pg_catalog.to_jsonb(profile.due_day)
     and operation_row.snapshot -> 'monthly_fee' is not distinct from
       pg_catalog.to_jsonb(profile.monthly_fee)
   returning profile.id into changed_id;
  if changed_id is null then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'profile_binding_changed_before_reactivation',
           updated_at = pg_catalog.now()
     where id = operation_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'profile_binding_changed'
    );
  end if;

  update public.student_offboarding_operations
     set status = 'COMPLETED',
         completed_at = pg_catalog.now(),
         lease_expires_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = operation_row.id;
  -- The aggregate recompute deliberately preserves state while an operation is
  -- active. Mark this operation complete first; both changes still share this
  -- transaction/advisory lock and roll back together on any failure.
  perform public.recompute_student_financial_status(
    operation_row.tenant_id,
    operation_row.student_id
  );
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'COMPLETED',
    'provider_subscription_final_status',
      operation_row.provider_subscription_final_status
  );
end;
$function$;

alter function public.begin_student_reactivation(
  text, uuid, uuid, uuid, integer
) owner to postgres;
alter function public.finalize_student_reactivation(uuid, uuid)
  owner to postgres;
revoke all on function public.begin_student_reactivation(
  text, uuid, uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.finalize_student_reactivation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_student_reactivation(
  text, uuid, uuid, uuid, integer
) to service_role;
grant execute on function public.finalize_student_reactivation(uuid, uuid)
  to service_role;

-- BLOCKED is an attention state, not an in-flight mutation. Keeping it in the
-- aggregate-preservation fence made a later Asaas settlement unable to clear
-- an overdue student indefinitely. Provider mutation/finalization remains
-- fenced by the operation itself, while financial truth can keep converging.
create or replace function public.recompute_student_financial_status(
  p_tenant_id text,
  p_student_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_tenant text := nullif(
    pg_catalog.btrim(coalesce(p_tenant_id, '')),
    ''
  );
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if normalized_tenant is null or p_student_id is null then
    raise exception 'invalid_student_financial_scope' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' ||
        p_student_id::text,
      0
    )
  );

  if exists (
       select 1 from public.student_offboarding_operations as operation
        where operation.tenant_id = normalized_tenant
          and operation.student_id = p_student_id
          and operation.status in (
            'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN'
          )
     ) or exists (
       select 1 from public.student_account_deletion_claims as deletion
        where deletion.tenant_id = normalized_tenant
          and deletion.student_id = p_student_id
          and deletion.status in (
            'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
            'UNKNOWN', 'BLOCKED'
          )
     )
  then
    perform 1
      from public.profiles as profile
     where profile.id = p_student_id
       and profile.tenant_id = normalized_tenant
       and profile.role = 'STUDENT'
     for share;
    if not found then
      return public.recompute_student_financial_status_pre_lifecycle_impl(
        normalized_tenant,
        p_student_id
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'PRESERVED',
      'reason', 'student_lifecycle_operation_active'
    );
  end if;

  return public.recompute_student_financial_status_pre_lifecycle_impl(
    normalized_tenant,
    p_student_id
  );
end;
$function$;

alter function public.recompute_student_financial_status(text, uuid)
  owner to postgres;
revoke all on function public.recompute_student_financial_status(text, uuid)
  from public, anon, authenticated;
grant execute on function public.recompute_student_financial_status(text, uuid)
  to service_role;

create or replace function public.student_lifecycle_operation_attention()
returns table (
  operation_id uuid,
  tenant_id text,
  student_id uuid,
  source_lifecycle_status text,
  target_lifecycle_status text,
  operation_status text,
  provider_started_at timestamptz,
  provider_completed_at timestamptz,
  last_error text,
  updated_at timestamptz
)
language sql
security definer
set search_path = ''
as $function$
  select
    operation.id,
    operation.tenant_id,
    operation.student_id,
    operation.source_lifecycle_status,
    operation.target_lifecycle_status,
    operation.status,
    operation.provider_started_at,
    operation.provider_completed_at,
    operation.last_error,
    operation.updated_at
  from public.student_offboarding_operations as operation
  where coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
    and operation.status in ('UNKNOWN', 'BLOCKED')
  order by operation.updated_at, operation.id;
$function$;

alter function public.student_lifecycle_operation_attention()
  owner to postgres;
revoke all on function public.student_lifecycle_operation_attention()
  from public, anon, authenticated;
grant execute on function public.student_lifecycle_operation_attention()
  to service_role;

comment on column public.student_offboarding_operations.billing_policy is
  'Frozen decision for the exit competence: keep open, charge current month, or waive current month.';
comment on table public.student_billing_exemptions is
  'Auditable competences removed from forecasts after a definitive student offboarding.';

do $postcheck$
begin
  if pg_catalog.to_regprocedure(
       'public.begin_student_offboarding_with_billing_policy(text,uuid,uuid,text,text,text,date,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finalize_student_offboarding_with_billing_policy(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.begin_student_reactivation(text,uuid,uuid,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finalize_student_reactivation(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.abort_student_lifecycle_operation(uuid,uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.student_lifecycle_operation_attention()'
     ) is null
     or pg_catalog.to_regclass('public.student_billing_exemptions') is null
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.begin_student_offboarding_with_billing_policy(text,uuid,uuid,text,text,text,date,uuid,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.begin_student_reactivation(text,uuid,uuid,uuid,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.abort_student_lifecycle_operation(uuid,uuid,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.student_lifecycle_operation_attention()',
       'EXECUTE'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.student_billing_exemptions', 'SELECT'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.finalize_student_offboarding_with_billing_policy(uuid,uuid)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.finalize_student_reactivation(uuid,uuid)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.abort_student_lifecycle_operation(uuid,uuid,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.student_lifecycle_operation_attention()',
       'EXECUTE'
     )
  then
    raise exception 'student offboarding billing policy was not installed safely';
  end if;
end;
$postcheck$;

commit;
