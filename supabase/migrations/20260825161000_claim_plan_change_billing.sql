-- Durable queue claims for signed plan changes.
--
-- The previous read-then-mark pair allowed two Edge invocations to mutate the
-- same Asaas subscription. Worse, a slow failure could arrive after a newer
-- success and move the local row from SYNCED back to PENDING/FAILED. Claims are
-- now atomic (FOR UPDATE SKIP LOCKED) and every completion is fenced by the
-- token returned to that worker.
--
-- Keep this migration re-executable: release.sh applies its migration manifest
-- inside a single transaction and may replay a migration when repairing a
-- missing release marker.

alter table public.student_plan_changes
  add column if not exists billing_claim_token uuid,
  add column if not exists billing_lease_expires_at timestamptz,
  add column if not exists billing_claimed_at timestamptz;

-- Repair only structurally impossible legacy/partial states. A valid live
-- claim survives migration replay.
update public.student_plan_changes as plan_change
   set billing_claim_token = null,
       billing_lease_expires_at = null,
       billing_claimed_at = null
 where plan_change.billing_sync_status <> 'PENDING'
    or not (
      (plan_change.billing_claim_token is null
       and plan_change.billing_lease_expires_at is null
       and plan_change.billing_claimed_at is null)
      or
      (plan_change.billing_claim_token is not null
       and plan_change.billing_lease_expires_at is not null
       and plan_change.billing_claimed_at is not null)
    );

-- A pre-hardening row at the retry ceiling must not remain invisible forever.
update public.student_plan_changes as plan_change
   set billing_sync_status = 'FAILED',
       billing_sync_error = coalesce(
         nullif(plan_change.billing_sync_error, ''),
         'limite de tentativas atingido antes da fila duravel'
       )
 where plan_change.billing_sync_status = 'PENDING'
   and plan_change.billing_attempts >= 6
   and plan_change.billing_claim_token is null;

do $constraint$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint as constraint_definition
     where constraint_definition.conrelid =
             'public.student_plan_changes'::pg_catalog.regclass
       and constraint_definition.conname =
             'student_plan_changes_billing_claim_chk'
  ) then
    alter table public.student_plan_changes
      add constraint student_plan_changes_billing_claim_chk
      check (
        (
          billing_claim_token is null
          and billing_lease_expires_at is null
          and billing_claimed_at is null
        )
        or
        (
          billing_sync_status = 'PENDING'
          and billing_claim_token is not null
          and billing_lease_expires_at is not null
          and billing_claimed_at is not null
        )
      );
  end if;
end;
$constraint$;

create index if not exists ix_plan_change_billing_claimable
  on public.student_plan_changes (
    tenant_id,
    billing_lease_expires_at,
    signed_at,
    id
  )
  where billing_sync_status = 'PENDING'
    and status = 'SIGNED'
    and asaas_subscription_id is not null;

create or replace function public.claim_plan_changes_awaiting_billing(
  p_tenant_id text default null,
  p_limit integer default 50,
  p_lease_seconds integer default 900
)
returns table (
  id uuid,
  tenant_id text,
  student_id uuid,
  student_name text,
  asaas_subscription_id text,
  to_monthly_fee numeric,
  to_frequency text,
  update_pending_payments boolean,
  billing_attempts integer,
  billing_claim_token uuid,
  billing_lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := greatest(
    1,
    least(coalesce(p_limit, 50), 50)
  );
  v_lease_seconds integer := greatest(
    60,
    least(coalesce(p_lease_seconds, 900), 3600)
  );
  v_tenant_id text := nullif(pg_catalog.btrim(p_tenant_id), '');
begin
  if p_tenant_id is not null and v_tenant_id is null then
    raise exception using
      errcode = '22023',
      message = 'tenant_id_required_when_scoped';
  end if;

  return query
  with candidates as materialized (
    select queued.id
      from public.student_plan_changes as queued
     where queued.billing_sync_status = 'PENDING'
       and queued.status = 'SIGNED'
       -- Malformed non-null IDs are claimed too, so the worker can record a
       -- visible failure instead of leaving an invisible permanent backlog.
       and queued.asaas_subscription_id is not null
       and (v_tenant_id is null or queued.tenant_id = v_tenant_id)
       and (
         queued.billing_claim_token is null
         or queued.billing_lease_expires_at <= pg_catalog.clock_timestamp()
       )
       and (
         queued.billing_attempts < 6
         -- A crashed PUT is safe to retry because it sets the same desired
         -- subscription value. Keep an expired sixth claim recoverable; an
         -- explicit sixth failure still transitions to FAILED below.
         or queued.billing_claim_token is not null
       )
     order by queued.signed_at nulls last, queued.created_at, queued.id
     limit v_limit
     for update of queued skip locked
  ), claimed as (
    update public.student_plan_changes as queued
       set billing_claim_token = pg_catalog.gen_random_uuid(),
           billing_lease_expires_at = pg_catalog.clock_timestamp()
             + pg_catalog.make_interval(secs => v_lease_seconds),
           billing_claimed_at = pg_catalog.clock_timestamp(),
           billing_attempts = least(
             queued.billing_attempts + 1,
             6
           )
      from candidates
     where queued.id = candidates.id
    returning
      queued.id,
      queued.tenant_id,
      queued.student_id,
      queued.asaas_subscription_id,
      queued.to_monthly_fee,
      queued.to_frequency,
      queued.update_pending_payments,
      queued.billing_attempts,
      queued.billing_claim_token,
      queued.billing_lease_expires_at
  )
  select
    claimed.id,
    claimed.tenant_id,
    claimed.student_id,
    student.full_name,
    claimed.asaas_subscription_id,
    claimed.to_monthly_fee,
    claimed.to_frequency,
    claimed.update_pending_payments,
    claimed.billing_attempts,
    claimed.billing_claim_token,
    claimed.billing_lease_expires_at
  from claimed
  join public.profiles as student
    on student.id = claimed.student_id
  order by claimed.id;
end;
$function$;

create or replace function public.finish_plan_change_billing_claim(
  p_id uuid,
  p_claim_token uuid,
  p_ok boolean,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  plan_change public.student_plan_changes%rowtype;
  v_status text;
begin
  if p_id is null or p_claim_token is null or p_ok is null then
    raise exception using
      errcode = '22023',
      message = 'claim_completion_arguments_required';
  end if;

  select queued.*
    into plan_change
    from public.student_plan_changes as queued
   where queued.id = p_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'not_found'
    );
  end if;

  -- Monotonic terminal state: even a worker holding an obsolete token cannot
  -- turn a completed synchronization back into a retry or failure.
  if plan_change.billing_sync_status = 'SYNCED' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'status', 'SYNCED',
      'applied', false,
      'ignored_regression', not p_ok
    );
  end if;

  if plan_change.billing_sync_status <> 'PENDING'
     or plan_change.billing_claim_token is distinct from p_claim_token
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'claim_lost',
      'status', plan_change.billing_sync_status
    );
  end if;

  v_status := case
    when p_ok then 'SYNCED'
    when plan_change.billing_attempts >= 6 then 'FAILED'
    else 'PENDING'
  end;

  update public.student_plan_changes as queued
     set billing_sync_status = v_status,
         billing_sync_error = case
           when p_ok then null
           else pg_catalog.left(
             coalesce(p_error, 'erro desconhecido'),
             500
           )
         end,
         billing_synced_at = case
           when p_ok then pg_catalog.clock_timestamp()
           else queued.billing_synced_at
         end,
         billing_claim_token = null,
         billing_lease_expires_at = null,
         billing_claimed_at = null
   where queued.id = plan_change.id
     and queued.billing_claim_token = p_claim_token;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', v_status,
    'applied', true
  );
end;
$function$;

alter function public.claim_plan_changes_awaiting_billing(text, integer, integer)
  owner to postgres;
alter function public.finish_plan_change_billing_claim(uuid, uuid, boolean, text)
  owner to postgres;

revoke all on function public.claim_plan_changes_awaiting_billing(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.finish_plan_change_billing_claim(uuid, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.claim_plan_changes_awaiting_billing(text, integer, integer)
  to service_role;
grant execute on function public.finish_plan_change_billing_claim(uuid, uuid, boolean, text)
  to service_role;

-- Remove the unfenced API so an old service path cannot overwrite a newer
-- result during a rolling deployment. The Edge is deployed after migrations;
-- until then the old worker fails closed with an RPC-not-found response.
drop function if exists public.plan_changes_awaiting_billing();
drop function if exists public.mark_plan_change_billing(uuid, boolean, text);

do $postcheck$
begin
  if pg_catalog.to_regprocedure(
       'public.claim_plan_changes_awaiting_billing(text,integer,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finish_plan_change_billing_claim(uuid,uuid,boolean,text)'
     ) is null
  then
    raise exception 'durable plan-change claim RPCs are missing';
  end if;

  if pg_catalog.to_regprocedure('public.plan_changes_awaiting_billing()')
       is not null
     or pg_catalog.to_regprocedure(
       'public.mark_plan_change_billing(uuid,boolean,text)'
     ) is not null
  then
    raise exception 'unfenced plan-change billing RPCs are still callable';
  end if;

  if pg_catalog.has_function_privilege(
       'anon',
       'public.claim_plan_changes_awaiting_billing(text,integer,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.finish_plan_change_billing_claim(uuid,uuid,boolean,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.claim_plan_changes_awaiting_billing(text,integer,integer)',
       'EXECUTE'
     )
  then
    raise exception 'plan-change billing claim RPC privileges are unsafe';
  end if;
end;
$postcheck$;
