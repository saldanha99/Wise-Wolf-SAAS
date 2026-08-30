-- Cross-flow fence for a student's monthly billing competence, plus an
-- at-most-once delivery fence for the manual Pix WhatsApp message.
--
-- Provider creation claims prevent a repeated POST for one logical route. The
-- period fence additionally prevents two different routes (recurring
-- subscription and manual Pix) from creating the same monthly charge.

create table if not exists public.asaas_student_billing_period_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  due_date date not null,
  source text not null check (source in ('MANUAL_PIX', 'SUBSCRIPTION')),
  source_key text not null check (length(source_key) between 1 and 240),
  request_fingerprint text not null check (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  status text not null default 'CLAIMED' check (
    status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BOUND', 'FAILED', 'BLOCKED')
  ),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  submit_attempt_count integer not null default 0 check (
    submit_attempt_count between 0 and 1
  ),
  provider_entity_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, student_id, due_date)
);

create index if not exists asaas_student_billing_period_attention_idx
  on public.asaas_student_billing_period_claims (status, updated_at)
  where status in ('SUBMITTING', 'UNKNOWN', 'FAILED', 'BLOCKED');

alter table public.asaas_student_billing_period_claims owner to postgres;
alter table public.asaas_student_billing_period_claims enable row level security;
revoke all on table public.asaas_student_billing_period_claims
  from public, anon, authenticated, service_role;
grant select on table public.asaas_student_billing_period_claims to service_role;

create or replace function public.claim_asaas_student_billing_period(
  p_tenant_id text,
  p_student_id uuid,
  p_due_date date,
  p_source text,
  p_source_key text,
  p_request_fingerprint text,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim_row public.asaas_student_billing_period_claims%rowtype;
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  normalized_source text := upper(pg_catalog.btrim(coalesce(p_source, '')));
  normalized_key text := nullif(pg_catalog.btrim(coalesce(p_source_key, '')), '');
  normalized_fingerprint text := lower(pg_catalog.btrim(coalesce(p_request_fingerprint, '')));
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
  retry_after integer;
begin
  if normalized_tenant is null
     or p_student_id is null
     or p_due_date is null
     or normalized_source not in ('MANUAL_PIX', 'SUBSCRIPTION')
     or normalized_key is null
     or length(normalized_key) > 240
     or normalized_fingerprint !~ '^[a-f0-9]{64}$'
     or p_claim_token is null
  then
    raise exception using errcode = '22023', message = 'invalid_student_billing_period_claim';
  end if;

  if not exists (
    select 1 from public.profiles as profile
     where profile.id = p_student_id
       and profile.tenant_id = normalized_tenant
       and profile.role = 'STUDENT'
  ) then
    raise exception using errcode = '42501', message = 'student_billing_period_scope_mismatch';
  end if;

  insert into public.asaas_student_billing_period_claims (
    tenant_id, student_id, due_date, source, source_key,
    request_fingerprint, claim_token, lease_expires_at
  ) values (
    normalized_tenant, p_student_id, p_due_date, normalized_source,
    normalized_key, normalized_fingerprint, p_claim_token,
    now() + pg_catalog.make_interval(secs => safe_lease)
  ) on conflict (tenant_id, student_id, due_date) do nothing;

  select billing_claim.*
    into claim_row
    from public.asaas_student_billing_period_claims as billing_claim
   where billing_claim.tenant_id = normalized_tenant
     and billing_claim.student_id = p_student_id
     and billing_claim.due_date = p_due_date
   for update;

  if claim_row.source is distinct from normalized_source
     or claim_row.source_key is distinct from normalized_key
  then
    insert into public.asaas_reconciliation_issues (
      tenant_id, source, kind, severity, local_entity_id, fingerprint, details
    ) values (
      normalized_tenant,
      'CREATION_GUARD',
      'STUDENT_BILLING_PERIOD_CONFLICT',
      'CRITICAL',
      claim_row.id::text,
      'student-billing-period:' || claim_row.id::text || ':' || normalized_source,
      pg_catalog.jsonb_build_object(
        'studentId', p_student_id,
        'dueDate', p_due_date,
        'winningSource', claim_row.source,
        'blockedSource', normalized_source
      )
    ) on conflict do nothing;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'CONFLICT',
      'reason', 'billing_period_owned_by_another_flow',
      'attempt_id', claim_row.id,
      'status', claim_row.status,
      'provider_entity_id', claim_row.provider_entity_id
    );
  end if;

  if claim_row.request_fingerprint is distinct from normalized_fingerprint then
    if claim_row.status <> 'BOUND' then
      update public.asaas_student_billing_period_claims
         set status = 'BLOCKED',
             last_error = 'billing_period_input_mismatch',
             lease_expires_at = now(),
             updated_at = now()
       where id = claim_row.id;
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'billing_period_input_mismatch',
      'attempt_id', claim_row.id
    );
  end if;

  if claim_row.status = 'BOUND' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_BOUND',
      'attempt_id', claim_row.id,
      'provider_entity_id', claim_row.provider_entity_id,
      'status', claim_row.status
    );
  end if;
  if claim_row.status in ('FAILED', 'BLOCKED') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'attempt_id', claim_row.id,
      'status', claim_row.status
    );
  end if;

  if claim_row.status in ('SUBMITTING', 'UNKNOWN')
     and claim_row.lease_expires_at > now()
     and claim_row.claim_token is distinct from p_claim_token
  then
    retry_after := greatest(
      1,
      ceil(extract(epoch from (claim_row.lease_expires_at - now())))::integer
    );
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', claim_row.id,
      'status', claim_row.status,
      'retry_after_seconds', retry_after
    );
  end if;

  if claim_row.status in ('SUBMITTING', 'UNKNOWN') then
    update public.asaas_student_billing_period_claims
       set status = 'UNKNOWN',
           claim_token = p_claim_token,
           lease_expires_at = now() + pg_catalog.make_interval(secs => safe_lease),
           updated_at = now()
     where id = claim_row.id
     returning * into claim_row;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'RECONCILE_REQUIRED',
      'attempt_id', claim_row.id,
      'claim_token', claim_row.claim_token,
      'status', claim_row.status
    );
  end if;

  if claim_row.status = 'CLAIMED'
     and claim_row.claim_token is distinct from p_claim_token
     and claim_row.lease_expires_at > now()
  then
    retry_after := greatest(
      1,
      ceil(extract(epoch from (claim_row.lease_expires_at - now())))::integer
    );
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', claim_row.id,
      'status', claim_row.status,
      'retry_after_seconds', retry_after
    );
  end if;

  update public.asaas_student_billing_period_claims
     set status = 'CLAIMED',
         claim_token = p_claim_token,
         lease_expires_at = now() + pg_catalog.make_interval(secs => safe_lease),
         updated_at = now()
   where id = claim_row.id
   returning * into claim_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'attempt_id', claim_row.id,
    'claim_token', claim_row.claim_token,
    'status', claim_row.status
  );
end;
$function$;

alter function public.claim_asaas_student_billing_period(
  text, uuid, date, text, text, text, uuid, integer
) owner to postgres;
revoke all on function public.claim_asaas_student_billing_period(
  text, uuid, date, text, text, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.claim_asaas_student_billing_period(
  text, uuid, date, text, text, text, uuid, integer
) to service_role;

create or replace function public.mark_asaas_student_billing_period_submitting(
  p_attempt_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim_row public.asaas_student_billing_period_claims%rowtype;
begin
  select billing_claim.* into claim_row
    from public.asaas_student_billing_period_claims as billing_claim
   where billing_claim.id = p_attempt_id
   for update;
  if not found
     or claim_row.status <> 'CLAIMED'
     or claim_row.claim_token is distinct from p_claim_token
     or claim_row.lease_expires_at <= now()
     or claim_row.submit_attempt_count <> 0
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  update public.asaas_student_billing_period_claims
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         lease_expires_at = now() + interval '10 minutes',
         updated_at = now()
   where id = claim_row.id;
  return pg_catalog.jsonb_build_object('ok', true, 'status', 'SUBMITTING');
end;
$function$;

alter function public.mark_asaas_student_billing_period_submitting(uuid, uuid)
  owner to postgres;
revoke all on function public.mark_asaas_student_billing_period_submitting(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_asaas_student_billing_period_submitting(uuid, uuid)
  to service_role;

create or replace function public.record_asaas_student_billing_period_state(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_entity_id text default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim_row public.asaas_student_billing_period_claims%rowtype;
  normalized_status text := upper(pg_catalog.btrim(coalesce(p_status, '')));
  normalized_provider_id text := nullif(pg_catalog.btrim(coalesce(p_provider_entity_id, '')), '');
begin
  if normalized_status not in ('RETRY', 'UNKNOWN', 'BOUND', 'FAILED', 'BLOCKED') then
    raise exception using errcode = '22023', message = 'invalid_student_billing_period_state';
  end if;
  select billing_claim.* into claim_row
    from public.asaas_student_billing_period_claims as billing_claim
   where billing_claim.id = p_attempt_id
   for update;
  if not found or claim_row.claim_token is distinct from p_claim_token then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  if claim_row.status = 'BOUND' then
    return pg_catalog.jsonb_build_object(
      'ok', normalized_status = 'BOUND'
        and claim_row.provider_entity_id is not distinct from normalized_provider_id,
      'status', claim_row.status,
      'provider_entity_id', claim_row.provider_entity_id,
      'ignored_regression', normalized_status <> 'BOUND'
    );
  end if;
  if normalized_status = 'BOUND' and normalized_provider_id is null then
    raise exception using errcode = '22023', message = 'billing_period_provider_id_required';
  end if;
  if normalized_status = 'RETRY'
     and (claim_row.status <> 'CLAIMED' or claim_row.submit_attempt_count <> 0)
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'unsafe_retry_rejected');
  end if;
  if normalized_status in ('UNKNOWN', 'FAILED')
     and (claim_row.status <> 'SUBMITTING' or claim_row.submit_attempt_count <> 1)
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'submit_not_started');
  end if;
  if claim_row.provider_entity_id is not null
     and normalized_provider_id is not null
     and claim_row.provider_entity_id is distinct from normalized_provider_id
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'provider_entity_id_mismatch');
  end if;

  update public.asaas_student_billing_period_claims
     set status = normalized_status,
         provider_entity_id = case
           when normalized_status = 'BOUND' then normalized_provider_id
           else provider_entity_id
         end,
         last_error = nullif(pg_catalog.left(coalesce(p_error, ''), 500), ''),
         lease_expires_at = now(),
         updated_at = now()
   where id = claim_row.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', normalized_status,
    'provider_entity_id', normalized_provider_id
  );
end;
$function$;

alter function public.record_asaas_student_billing_period_state(
  uuid, uuid, text, text, text
) owner to postgres;
revoke all on function public.record_asaas_student_billing_period_state(
  uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_asaas_student_billing_period_state(
  uuid, uuid, text, text, text
) to service_role;

-- The message body, destination and credentials never enter this table. Its
-- sole purpose is to fence one irreversible provider send attempt.
create table if not exists public.asaas_outbound_message_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  provider_entity_id text not null,
  notification_kind text not null,
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
  unique (tenant_id, provider_entity_id, notification_kind)
);

alter table public.asaas_outbound_message_attempts owner to postgres;
alter table public.asaas_outbound_message_attempts enable row level security;
revoke all on table public.asaas_outbound_message_attempts
  from public, anon, authenticated, service_role;
grant select on table public.asaas_outbound_message_attempts to service_role;

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
  if not exists (
    select 1 from public.profiles as profile
     where profile.id = p_student_id
       and profile.tenant_id = normalized_tenant
       and profile.role = 'STUDENT'
  ) then
    raise exception using errcode = '42501', message = 'outbound_message_scope_mismatch';
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

alter function public.claim_asaas_outbound_message(
  text, uuid, text, text, uuid, integer
) owner to postgres;
revoke all on function public.claim_asaas_outbound_message(
  text, uuid, text, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.claim_asaas_outbound_message(
  text, uuid, text, text, uuid, integer
) to service_role;

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
begin
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
  update public.asaas_outbound_message_attempts
     set status = 'SUBMITTING', submit_attempt_count = 1,
         lease_expires_at = now() + interval '10 minutes', updated_at = now()
   where id = attempt_row.id;
  return pg_catalog.jsonb_build_object('ok', true, 'status', 'SUBMITTING');
end;
$function$;

alter function public.mark_asaas_outbound_message_submitting(uuid, uuid)
  owner to postgres;
revoke all on function public.mark_asaas_outbound_message_submitting(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_asaas_outbound_message_submitting(uuid, uuid)
  to service_role;

create or replace function public.finish_asaas_outbound_message(
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
  attempt_row public.asaas_outbound_message_attempts%rowtype;
  normalized_status text := upper(pg_catalog.btrim(coalesce(p_status, '')));
begin
  if normalized_status not in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED') then
    raise exception using errcode = '22023', message = 'invalid_outbound_message_state';
  end if;
  select message_attempt.* into attempt_row
    from public.asaas_outbound_message_attempts as message_attempt
   where message_attempt.id = p_attempt_id
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
      return pg_catalog.jsonb_build_object('ok', false, 'reason', 'invalid_suppression_transition');
    end if;
  elsif attempt_row.status <> 'SUBMITTING' or attempt_row.submit_attempt_count <> 1 then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'submit_not_started');
  end if;
  update public.asaas_outbound_message_attempts
     set status = normalized_status,
         provider_http_status = p_provider_http_status,
         last_error = nullif(pg_catalog.left(coalesce(p_error, ''), 500), ''),
         lease_expires_at = now(),
         updated_at = now()
   where id = attempt_row.id;
  return pg_catalog.jsonb_build_object('ok', true, 'status', normalized_status);
end;
$function$;

alter function public.finish_asaas_outbound_message(
  uuid, uuid, text, integer, text
) owner to postgres;
revoke all on function public.finish_asaas_outbound_message(
  uuid, uuid, text, integer, text
) from public, anon, authenticated;
grant execute on function public.finish_asaas_outbound_message(
  uuid, uuid, text, integer, text
) to service_role;

do $verify_student_billing_fences$
begin
  if pg_catalog.to_regclass('public.asaas_student_billing_period_claims') is null
     or pg_catalog.to_regclass('public.asaas_outbound_message_attempts') is null
     or pg_catalog.to_regprocedure(
       'public.claim_asaas_student_billing_period(text,uuid,date,text,text,text,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.claim_asaas_outbound_message(text,uuid,text,text,uuid,integer)'
     ) is null
  then
    raise exception 'student billing fences were not installed';
  end if;
end;
$verify_student_billing_fences$;
