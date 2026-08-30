-- A payment split alert goes to a tenant-owned management group. Some valid
-- cash entries have no student_id, so the student-scoped outbound fence cannot
-- represent them. This table records only the irreversible provider attempt;
-- message bodies, destinations and credentials are intentionally excluded.
create table if not exists public.asaas_payment_split_message_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  payment_id uuid not null references public.student_payments(id) on delete cascade,
  status text not null default 'CLAIMED' check (
    status in ('CLAIMED', 'SUBMITTING', 'SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED')
  ),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  submit_attempt_count integer not null default 0 check (
    submit_attempt_count between 0 and 1
  ),
  provider_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, payment_id)
);

alter table public.asaas_payment_split_message_attempts owner to postgres;
alter table public.asaas_payment_split_message_attempts enable row level security;
alter table public.asaas_payment_split_message_attempts force row level security;
revoke all on table public.asaas_payment_split_message_attempts
  from public, anon, authenticated, service_role;
grant select on table public.asaas_payment_split_message_attempts to service_role;

create or replace function public.claim_asaas_payment_split_message(
  p_tenant_id text,
  p_payment_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_payment_split_message_attempts%rowtype;
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
begin
  if normalized_tenant is null or p_payment_id is null or p_claim_token is null then
    raise exception using errcode = '22023', message = 'invalid_payment_split_message_claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'payment-split-message:' || normalized_tenant || ':' || p_payment_id::text,
      0
    )
  );

  perform 1
    from public.student_payments as payment
   where payment.id = p_payment_id
     and payment.tenant_id = normalized_tenant
     and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
       'RECEIVED', 'RECEIVED_IN_CASH'
     )
     and coalesce(payment.value, 0) > 0
   for update;
  if not found
     or not exists (
       select 1
         from public.payment_split_settings as setting
        where setting.tenant_id = normalized_tenant
          and setting.is_active
     )
     or not exists (
       select 1
         from public.tenants as tenant
        where tenant.id = normalized_tenant
          and tenant.whatsapp_enabled is true
          and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) in (
            'active', 'trial', 'trialing'
          )
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'payment_split_scope_or_state_invalid'
    );
  end if;

  insert into public.asaas_payment_split_message_attempts (
    tenant_id,
    payment_id,
    claim_token,
    lease_expires_at
  ) values (
    normalized_tenant,
    p_payment_id,
    p_claim_token,
    pg_catalog.now() + pg_catalog.make_interval(secs => safe_lease)
  ) on conflict (tenant_id, payment_id) do nothing;

  select attempt.* into attempt_row
    from public.asaas_payment_split_message_attempts as attempt
   where attempt.tenant_id = normalized_tenant
     and attempt.payment_id = p_payment_id
   for update;

  if attempt_row.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED')
     or attempt_row.submit_attempt_count > 0
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_FINAL',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status
    );
  end if;
  if attempt_row.claim_token is distinct from p_claim_token
     and attempt_row.lease_expires_at > pg_catalog.now()
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status
    );
  end if;

  update public.asaas_payment_split_message_attempts
     set claim_token = p_claim_token,
         lease_expires_at = pg_catalog.now()
           + pg_catalog.make_interval(secs => safe_lease),
         updated_at = pg_catalog.now()
   where id = attempt_row.id
   returning * into attempt_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'attempt_id', attempt_row.id,
    'claim_token', attempt_row.claim_token,
    'status', attempt_row.status
  );
end;
$function$;

create or replace function public.mark_asaas_payment_split_message_submitting(
  p_attempt_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_payment_split_message_attempts%rowtype;
  payment_valid boolean := false;
begin
  select attempt.* into attempt_row
    from public.asaas_payment_split_message_attempts as attempt
   where attempt.id = p_attempt_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'payment-split-message:' || attempt_row.tenant_id || ':' || attempt_row.payment_id::text,
      0
    )
  );

  perform 1
    from public.student_payments as payment
   where payment.id = attempt_row.payment_id
     and payment.tenant_id = attempt_row.tenant_id
     and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
       'RECEIVED', 'RECEIVED_IN_CASH'
     )
     and coalesce(payment.value, 0) > 0
   for update;
  payment_valid := found;

  select attempt.* into attempt_row
    from public.asaas_payment_split_message_attempts as attempt
   where attempt.id = p_attempt_id
   for update;
  if not found
     or attempt_row.status <> 'CLAIMED'
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.lease_expires_at <= pg_catalog.now()
     or attempt_row.submit_attempt_count <> 0
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if not payment_valid
     or not exists (
       select 1
         from public.payment_split_settings as setting
        where setting.tenant_id = attempt_row.tenant_id
          and setting.is_active
     )
     or not exists (
       select 1
         from public.tenants as tenant
        where tenant.id = attempt_row.tenant_id
          and tenant.whatsapp_enabled is true
          and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) in (
            'active', 'trial', 'trialing'
          )
     )
  then
    update public.asaas_payment_split_message_attempts
       set status = 'SUPPRESSED',
           lease_expires_at = pg_catalog.now(),
           last_error = 'payment_split_scope_or_state_changed_before_send',
           updated_at = pg_catalog.now()
     where id = attempt_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'status', 'SUPPRESSED',
      'reason', 'payment_split_scope_or_state_changed_before_send'
    );
  end if;

  update public.asaas_payment_split_message_attempts
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         lease_expires_at = pg_catalog.now() + interval '10 minutes',
         updated_at = pg_catalog.now()
   where id = attempt_row.id;
  return pg_catalog.jsonb_build_object('ok', true, 'status', 'SUBMITTING');
end;
$function$;

create or replace function public.finish_asaas_payment_split_message(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_http_status integer default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_payment_split_message_attempts%rowtype;
  normalized_status text := upper(pg_catalog.btrim(coalesce(p_status, '')));
begin
  if normalized_status not in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED') then
    raise exception using errcode = '22023', message = 'invalid_payment_split_message_state';
  end if;

  select attempt.* into attempt_row
    from public.asaas_payment_split_message_attempts as attempt
   where attempt.id = p_attempt_id
   for update;
  if not found or attempt_row.claim_token is distinct from p_claim_token then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  if attempt_row.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED') then
    return pg_catalog.jsonb_build_object(
      'ok', attempt_row.status = normalized_status,
      'status', attempt_row.status,
      'ignored_regression', attempt_row.status <> normalized_status
    );
  end if;
  if normalized_status = 'SUPPRESSED' then
    if attempt_row.status <> 'CLAIMED' or attempt_row.submit_attempt_count <> 0 then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'invalid_suppression_transition'
      );
    end if;
  elsif attempt_row.status <> 'SUBMITTING'
     or attempt_row.submit_attempt_count <> 1
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'submit_not_started');
  end if;

  update public.asaas_payment_split_message_attempts
     set status = normalized_status,
         provider_http_status = p_provider_http_status,
         last_error = nullif(
           pg_catalog.left(coalesce(p_error, ''), 500),
           ''
         ),
         lease_expires_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = attempt_row.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', normalized_status
  );
end;
$function$;

alter function public.claim_asaas_payment_split_message(text, uuid, uuid, integer)
  owner to postgres;
alter function public.mark_asaas_payment_split_message_submitting(uuid, uuid)
  owner to postgres;
alter function public.finish_asaas_payment_split_message(uuid, uuid, text, integer, text)
  owner to postgres;

revoke all on function public.claim_asaas_payment_split_message(text, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.mark_asaas_payment_split_message_submitting(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.finish_asaas_payment_split_message(uuid, uuid, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_asaas_payment_split_message(text, uuid, uuid, integer)
  to service_role;
grant execute on function public.mark_asaas_payment_split_message_submitting(uuid, uuid)
  to service_role;
grant execute on function public.finish_asaas_payment_split_message(uuid, uuid, text, integer, text)
  to service_role;

do $postcheck$
begin
  if pg_catalog.to_regclass('public.asaas_payment_split_message_attempts') is null
     or pg_catalog.to_regprocedure(
       'public.claim_asaas_payment_split_message(text,uuid,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.mark_asaas_payment_split_message_submitting(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finish_asaas_payment_split_message(uuid,uuid,text,integer,text)'
     ) is null
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.asaas_payment_split_message_attempts',
       'SELECT'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.claim_asaas_payment_split_message(text,uuid,uuid,integer)',
       'EXECUTE'
     )
  then
    raise exception 'payment split outbound fence was not installed safely';
  end if;
end;
$postcheck$;
