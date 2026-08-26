-- Durable, observable and fail-closed Asaas automations.
--
-- Provider guarantees used by this migration:
--   * webhook delivery is at-least-once;
--   * body.id is stable across duplicate deliveries;
--   * HTTP 200 must only be returned after durable persistence.
--
-- No function below mutates Asaas. Provider writes remain in Edge Functions
-- and the teacher PIX path is feature-gated until homologation.

alter table public.student_payments
  alter column tenant_id drop default;

alter table public.student_payments
  add column if not exists last_provider_event_id text,
  add column if not exists last_provider_event_at timestamptz,
  add column if not exists last_provider_event_rank integer not null default 0,
  add column if not exists provider_status text,
  add column if not exists estimated_credit_at timestamptz,
  add column if not exists automation_key text;

-- NAO_RECEITA is a deliberate local accounting classification, not an Asaas
-- lifecycle status. Never infer its provider status during the backfill.
update public.student_payments
   set provider_status = status
 where provider_status is null
   and status <> 'NAO_RECEITA';

create unique index if not exists student_payments_automation_key_uidx
  on public.student_payments (automation_key)
  where automation_key is not null;

comment on column public.student_payments.tenant_id is
  'Tenant resolved from the canonical student/customer relationship. There is deliberately no default: unresolved Asaas money goes to triage.';
comment on column public.student_payments.credited_at is
  'Actual Asaas balance availability (payment.creditDate). Never populated from estimatedCreditDate or PAYMENT_CONFIRMED.';
comment on column public.student_payments.estimated_credit_at is
  'Provider estimate only; never used as actual cash availability.';
comment on column public.student_payments.refunded_amount is
  'Cumulative completed provider refund, bounded by the original payment value.';
comment on column public.student_payments.provider_status is
  'Latest observed Asaas lifecycle status. Kept separate so a provider retry never erases the local NAO_RECEITA classification.';

create table if not exists public.asaas_webhook_inbox (
  provider_event_id text primary key,
  event_name text not null,
  provider_entity_id text not null,
  event_created_at timestamptz,
  payload jsonb not null,
  payload_hash text not null,
  status text not null default 'RECEIVED'
    check (status in ('RECEIVED', 'PROCESSING', 'RETRY', 'PROCESSED', 'TRIAGE', 'DEAD_LETTER')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  delivery_count integer not null default 1 check (delivery_count > 0),
  lease_owner uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint asaas_webhook_event_id_length check (
    length(provider_event_id) between 1 and 240
  ),
  constraint asaas_webhook_event_name_length check (
    length(event_name) between 1 and 120
  ),
  constraint asaas_webhook_entity_id_length check (
    length(provider_entity_id) between 1 and 240
  )
);

create index if not exists asaas_webhook_inbox_pending_idx
  on public.asaas_webhook_inbox
    (next_attempt_at, event_created_at, received_at, provider_event_id)
  where status in ('RECEIVED', 'RETRY');
create index if not exists asaas_webhook_inbox_entity_order_idx
  on public.asaas_webhook_inbox
    (provider_entity_id, event_created_at, received_at, provider_event_id);
create index if not exists asaas_webhook_inbox_failed_idx
  on public.asaas_webhook_inbox (updated_at desc)
  where status in ('TRIAGE', 'DEAD_LETTER');

alter table public.asaas_webhook_inbox enable row level security;
revoke all on table public.asaas_webhook_inbox from public, anon, authenticated;
grant select, insert, update on table public.asaas_webhook_inbox
  to service_role;

create table if not exists public.asaas_automation_worker_locks (
  worker_name text primary key,
  lease_owner uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.asaas_automation_worker_locks (worker_name)
values ('webhook')
on conflict (worker_name) do nothing;

alter table public.asaas_automation_worker_locks enable row level security;
revoke all on table public.asaas_automation_worker_locks
  from public, anon, authenticated;
grant select, update on table public.asaas_automation_worker_locks
  to service_role;

create table if not exists public.asaas_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'RUNNING'
    check (status in ('RUNNING', 'COMPLETED', 'FAILED')),
  window_start date not null,
  window_end date not null,
  cursor_state jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  constraint asaas_reconciliation_window_valid check (
    window_end >= window_start and window_end - window_start <= 366
  )
);

create index if not exists asaas_reconciliation_runs_recent_idx
  on public.asaas_reconciliation_runs (started_at desc);
create unique index if not exists asaas_reconciliation_one_running_uidx
  on public.asaas_reconciliation_runs ((status))
  where status = 'RUNNING';

create table if not exists public.asaas_reconciliation_issues (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.asaas_reconciliation_runs(id) on delete cascade,
  tenant_id text references public.tenants(id) on delete set null,
  source text not null,
  kind text not null,
  severity text not null check (severity in ('INFO', 'WARNING', 'HIGH', 'CRITICAL')),
  provider_entity_id text,
  local_entity_id text,
  fingerprint text not null,
  details jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text
);

create unique index if not exists asaas_reconciliation_run_fingerprint_uidx
  on public.asaas_reconciliation_issues (run_id, fingerprint)
  where run_id is not null;
create unique index if not exists asaas_reconciliation_open_automation_uidx
  on public.asaas_reconciliation_issues (source, fingerprint)
  where run_id is null and resolved_at is null;
create index if not exists asaas_reconciliation_open_severity_idx
  on public.asaas_reconciliation_issues (severity, observed_at desc)
  where resolved_at is null;

alter table public.asaas_reconciliation_runs enable row level security;
alter table public.asaas_reconciliation_issues enable row level security;
revoke all on table public.asaas_reconciliation_runs,
  public.asaas_reconciliation_issues from public, anon, authenticated;
grant select, insert, update on table public.asaas_reconciliation_runs,
  public.asaas_reconciliation_issues to service_role;

create table if not exists public.asaas_teacher_transfer_attempts (
  id uuid primary key default gen_random_uuid(),
  closing_id uuid not null references public.teacher_closings(id) on delete restrict,
  tenant_id text not null references public.tenants(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  external_reference text not null,
  status text not null default 'CLAIMED'
    check (status in ('CLAIMED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'BLOCKED')),
  expected_amount numeric(12, 2) not null check (expected_amount > 0),
  destination_pix_key text not null,
  destination_pix_key_type text not null
    check (destination_pix_key_type in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP')),
  destination_fingerprint text not null
    check (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  transfer_description text not null
    check (length(transfer_description) between 1 and 300),
  provider_transfer_id text,
  provider_status text,
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  submit_attempt_count integer not null default 0 check (submit_attempt_count between 0 and 1),
  reconciliation_count integer not null default 0 check (reconciliation_count >= 0),
  last_http_status integer,
  last_error text,
  provider_response jsonb,
  submitted_at timestamptz,
  reconciled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (closing_id),
  unique (external_reference),
  unique (provider_transfer_id)
);

-- Keep the migration restartable if an earlier validation run created the
-- table before durable destination snapshots were introduced. New SUBMIT_ONCE
-- attempts always populate every field atomically in the claim RPC below.
alter table public.asaas_teacher_transfer_attempts
  add column if not exists destination_pix_key text,
  add column if not exists destination_pix_key_type text,
  add column if not exists transfer_description text;

comment on column public.asaas_teacher_transfer_attempts.destination_pix_key is
  'Service-only immutable Pix destination captured by the claim transaction. Never expose in API responses, logs or reconciliation issues.';
comment on column public.asaas_teacher_transfer_attempts.destination_fingerprint is
  'SHA-256 of normalized Pix type:key captured before submission.';

create index if not exists asaas_teacher_transfer_attention_idx
  on public.asaas_teacher_transfer_attempts (status, updated_at)
  where status in ('CLAIMED', 'SUBMITTED', 'UNKNOWN', 'FAILED', 'BLOCKED');

alter table public.asaas_teacher_transfer_attempts enable row level security;
revoke all on table public.asaas_teacher_transfer_attempts
  from public, anon, authenticated;
revoke all on table public.asaas_teacher_transfer_attempts from service_role;
grant select (
  id, closing_id, tenant_id, requested_by, external_reference, status,
  expected_amount, destination_pix_key_type, destination_fingerprint,
  transfer_description, provider_transfer_id, provider_status, claim_token,
  lease_expires_at, submit_attempt_count, reconciliation_count,
  last_http_status, last_error, provider_response, submitted_at,
  reconciled_at, completed_at, created_at, updated_at
) on public.asaas_teacher_transfer_attempts to service_role;

alter table public.teacher_closings
  add column if not exists asaas_transfer_id text,
  add column if not exists transfer_status text;

create or replace function public.enqueue_asaas_webhook_event(
  p_event_id text,
  p_event_name text,
  p_entity_id text,
  p_event_created_at timestamptz,
  p_payload jsonb,
  p_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing_row public.asaas_webhook_inbox%rowtype;
  inserted boolean := false;
begin
  if nullif(trim(p_event_id), '') is null
     or length(p_event_id) > 240
     or nullif(trim(p_event_name), '') is null
     or length(p_event_name) > 120
     or nullif(trim(p_entity_id), '') is null
     or length(p_entity_id) > 240
     or p_payload is null
     or nullif(trim(p_payload_hash), '') is null
  then
    raise exception using errcode = '22023', message = 'invalid_asaas_webhook_event';
  end if;

  insert into public.asaas_webhook_inbox (
    provider_event_id,
    event_name,
    provider_entity_id,
    event_created_at,
    payload,
    payload_hash
  ) values (
    trim(p_event_id),
    trim(p_event_name),
    trim(p_entity_id),
    p_event_created_at,
    p_payload,
    trim(p_payload_hash)
  )
  on conflict (provider_event_id) do nothing;
  inserted := found;

  select inbox.*
    into existing_row
    from public.asaas_webhook_inbox as inbox
   where inbox.provider_event_id = trim(p_event_id)
   for update;

  if existing_row.payload_hash is distinct from trim(p_payload_hash) then
    update public.asaas_webhook_inbox
       set status = 'TRIAGE',
           delivery_count = delivery_count + 1,
           last_received_at = now(),
           last_error = 'duplicate_event_id_payload_mismatch',
           updated_at = now()
     where provider_event_id = trim(p_event_id);

    insert into public.asaas_reconciliation_issues (
      source, kind, severity, provider_entity_id, fingerprint, details
    ) values (
      'WEBHOOK', 'DUPLICATE_EVENT_PAYLOAD_MISMATCH', 'CRITICAL',
      trim(p_event_id), 'webhook-payload-mismatch:' || trim(p_event_id),
      jsonb_build_object('event', trim(p_event_name), 'entityId', trim(p_entity_id))
    )
    on conflict do nothing;

    return jsonb_build_object(
      'inserted', false,
      'duplicate', true,
      'processable', false,
      'status', 'TRIAGE'
    );
  end if;

  if not inserted then
    update public.asaas_webhook_inbox
       set delivery_count = delivery_count + 1,
           last_received_at = now(),
           updated_at = now()
     where provider_event_id = trim(p_event_id);
  end if;

  return jsonb_build_object(
    'inserted', inserted,
    'duplicate', not inserted,
    'processable', existing_row.status not in ('PROCESSED', 'TRIAGE', 'DEAD_LETTER'),
    'status', existing_row.status
  );
end;
$function$;

revoke all on function public.enqueue_asaas_webhook_event(
  text, text, text, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.enqueue_asaas_webhook_event(
  text, text, text, timestamptz, jsonb, text
) to service_role;

create or replace function public.claim_next_asaas_webhook_event(
  p_worker_token uuid,
  p_lease_seconds integer default 240
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  worker_lock public.asaas_automation_worker_locks%rowtype;
  claimed public.asaas_webhook_inbox%rowtype;
  safe_lease integer := greatest(30, least(coalesce(p_lease_seconds, 240), 600));
begin
  if p_worker_token is null then
    raise exception using errcode = '22023', message = 'worker_token_required';
  end if;

  insert into public.asaas_automation_worker_locks (worker_name)
  values ('webhook')
  on conflict (worker_name) do nothing;

  select lock_row.*
    into worker_lock
    from public.asaas_automation_worker_locks as lock_row
   where lock_row.worker_name = 'webhook'
   for update;

  if worker_lock.lease_owner is not null
     and worker_lock.lease_owner <> p_worker_token
     and worker_lock.lease_expires_at > now()
  then
    return null;
  end if;

  update public.asaas_automation_worker_locks
     set lease_owner = p_worker_token,
         lease_expires_at = now() + make_interval(secs => safe_lease),
         updated_at = now()
   where worker_name = 'webhook';

  update public.asaas_webhook_inbox
     set status = 'RETRY',
         lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = now(),
         last_error = coalesce(last_error, 'processing_lease_expired'),
         updated_at = now()
   where status = 'PROCESSING'
     and lease_expires_at <= now();

  select inbox.*
    into claimed
    from public.asaas_webhook_inbox as inbox
   where inbox.status in ('RECEIVED', 'RETRY')
     and inbox.next_attempt_at <= now()
     and not exists (
       select 1
         from public.asaas_webhook_inbox as earlier
        where earlier.provider_entity_id = inbox.provider_entity_id
          and earlier.status in ('RECEIVED', 'RETRY', 'PROCESSING')
          and (
            coalesce(earlier.event_created_at, 'infinity'::timestamptz),
            earlier.received_at,
            earlier.provider_event_id
          ) < (
            coalesce(inbox.event_created_at, 'infinity'::timestamptz),
            inbox.received_at,
            inbox.provider_event_id
          )
     )
   order by
     inbox.next_attempt_at asc,
     inbox.event_created_at asc nulls last,
     inbox.received_at asc,
     inbox.provider_event_id asc
   for update skip locked
   limit 1;

  if claimed.provider_event_id is null then
    update public.asaas_automation_worker_locks
       set lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where worker_name = 'webhook'
       and lease_owner = p_worker_token;
    return null;
  end if;

  update public.asaas_webhook_inbox
     set status = 'PROCESSING',
         attempt_count = least(attempt_count + 1, 100),
         lease_owner = p_worker_token,
         lease_expires_at = now() + make_interval(secs => safe_lease),
         updated_at = now()
   where provider_event_id = claimed.provider_event_id;

  return jsonb_build_object(
    'provider_event_id', claimed.provider_event_id,
    'event_name', claimed.event_name,
    'provider_entity_id', claimed.provider_entity_id,
    'event_created_at', claimed.event_created_at,
    'payload', claimed.payload,
    'attempt_count', claimed.attempt_count + 1
  );
end;
$function$;

revoke all on function public.claim_next_asaas_webhook_event(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_asaas_webhook_event(uuid, integer)
  to service_role;

create or replace function public.finish_asaas_webhook_event(
  p_event_id text,
  p_worker_token uuid,
  p_outcome text,
  p_error text default null,
  p_tenant_id text default null,
  p_local_entity_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  inbox_row public.asaas_webhook_inbox%rowtype;
  final_status text;
  delay_seconds integer;
begin
  select inbox.*
    into inbox_row
    from public.asaas_webhook_inbox as inbox
   where inbox.provider_event_id = p_event_id
   for update;

  if inbox_row.provider_event_id is null
     or inbox_row.status <> 'PROCESSING'
     or inbox_row.lease_owner is distinct from p_worker_token
  then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  final_status := case upper(coalesce(p_outcome, ''))
    when 'PROCESSED' then 'PROCESSED'
    when 'TRIAGE' then 'TRIAGE'
    when 'DEAD_LETTER' then 'DEAD_LETTER'
    else case when inbox_row.attempt_count >= 12 then 'DEAD_LETTER' else 'RETRY' end
  end;
  delay_seconds := least(3600, greatest(15, (power(2, least(inbox_row.attempt_count, 8)) * 15)::integer));

  update public.asaas_webhook_inbox
     set status = final_status,
         lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = case
           when final_status = 'RETRY' then now() + make_interval(secs => delay_seconds)
           else now()
         end,
         last_error = nullif(left(coalesce(p_error, ''), 500), ''),
         processed_at = case
           when final_status in ('PROCESSED', 'TRIAGE', 'DEAD_LETTER') then now()
           else null
         end,
         updated_at = now()
   where provider_event_id = p_event_id;

  if final_status in ('TRIAGE', 'DEAD_LETTER') then
    insert into public.asaas_reconciliation_issues (
      tenant_id, source, kind, severity, provider_entity_id,
      local_entity_id, fingerprint, details
    ) values (
      p_tenant_id,
      'WEBHOOK',
      case when final_status = 'TRIAGE' then 'WEBHOOK_TRIAGE' else 'WEBHOOK_DEAD_LETTER' end,
      case when final_status = 'TRIAGE' then 'HIGH' else 'CRITICAL' end,
      inbox_row.provider_entity_id,
      p_local_entity_id,
      lower(final_status) || ':' || p_event_id,
      jsonb_build_object(
        'providerEventId', p_event_id,
        'eventName', inbox_row.event_name,
        'attemptCount', inbox_row.attempt_count,
        'error', left(coalesce(p_error, 'unknown'), 500)
      )
    )
    on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', final_status,
    'retry_after_seconds', case when final_status = 'RETRY' then delay_seconds else null end
  );
end;
$function$;

revoke all on function public.finish_asaas_webhook_event(
  text, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.finish_asaas_webhook_event(
  text, uuid, text, text, text, text
) to service_role;

create or replace function public.release_asaas_webhook_worker(p_worker_token uuid)
returns void
language sql
security definer
set search_path = ''
as $function$
  update public.asaas_automation_worker_locks
     set lease_owner = null,
         lease_expires_at = null,
         updated_at = now()
   where worker_name = 'webhook'
     and lease_owner = p_worker_token;
$function$;

revoke all on function public.release_asaas_webhook_worker(uuid)
  from public, anon, authenticated;
grant execute on function public.release_asaas_webhook_worker(uuid)
  to service_role;

create or replace function public.generate_monthly_student_payments(
  p_tenant_id text,
  p_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  period_start date := date_trunc('month', p_period_start)::date;
  period_end date := (date_trunc('month', p_period_start) + interval '1 month')::date;
  inserted_count integer := 0;
  eligible_count integer := 0;
begin
  if nullif(trim(p_tenant_id), '') is null or p_period_start is null then
    raise exception using errcode = '22023', message = 'tenant_and_period_required';
  end if;
  if not exists (
    select 1 from public.tenants as tenant
     where tenant.id = trim(p_tenant_id)
  ) then
    raise exception using errcode = '23503', message = 'tenant_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'monthly-student-payments:' || trim(p_tenant_id) || ':' || period_start::text,
    0
  ));

  select count(*)
    into eligible_count
    from public.profiles as student
    join public.tenant_memberships as membership
      on membership.user_id = student.id
     and membership.tenant_id = trim(p_tenant_id)
     and membership.role = 'STUDENT'
     and membership.status = 'ACTIVE'
   where student.role = 'STUDENT'
     and student.tenant_id = trim(p_tenant_id)
     and student.status = 'Ativo'
     and lower(trim(coalesce(student.lifecycle_status, ''))) = 'active'
     and coalesce(student.monthly_fee, 0) > 0;

  insert into public.student_payments (
    student_id,
    tenant_id,
    value,
    amount_cents,
    due_date,
    status,
    billing_type,
    asaas_payment_id,
    automation_key,
    description,
    created_at,
    updated_at
  )
  select
    student.id,
    trim(p_tenant_id),
    student.monthly_fee,
    round(student.monthly_fee * 100)::integer,
    make_date(
      extract(year from period_start)::integer,
      extract(month from period_start)::integer,
      least(greatest(coalesce(student.due_day, 10), 1),
        extract(day from (period_end - interval '1 day'))::integer)
    ),
    case
      when current_date > make_date(
        extract(year from period_start)::integer,
        extract(month from period_start)::integer,
        least(greatest(coalesce(student.due_day, 10), 1),
          extract(day from (period_end - interval '1 day'))::integer)
      ) then 'OVERDUE'
      else 'PENDING'
    end,
    'MANUAL',
    'MANUAL_MONTHLY_' || to_char(period_start, 'YYYYMM') || '_' || replace(student.id::text, '-', ''),
    'monthly:' || trim(p_tenant_id) || ':' || student.id::text || ':' || to_char(period_start, 'YYYY-MM'),
    'Mensalidade ' || to_char(period_start, 'MM/YYYY'),
    now(),
    now()
  from public.profiles as student
  join public.tenant_memberships as membership
    on membership.user_id = student.id
   and membership.tenant_id = trim(p_tenant_id)
   and membership.role = 'STUDENT'
   and membership.status = 'ACTIVE'
  where student.role = 'STUDENT'
    and student.tenant_id = trim(p_tenant_id)
    and student.status = 'Ativo'
    and lower(trim(coalesce(student.lifecycle_status, ''))) = 'active'
    and coalesce(student.monthly_fee, 0) > 0
    and not exists (
      select 1
        from public.student_payments as existing
       where existing.student_id = student.id
         and existing.tenant_id = trim(p_tenant_id)
         and existing.due_date >= period_start
         and existing.due_date < period_end
    )
  on conflict (automation_key) where automation_key is not null do nothing;
  get diagnostics inserted_count = row_count;

  return jsonb_build_object(
    'ok', true,
    'tenant_id', trim(p_tenant_id),
    'period_start', period_start,
    'eligible', eligible_count,
    'created', inserted_count,
    'skipped', greatest(eligible_count - inserted_count, 0)
  );
end;
$function$;

revoke all on function public.generate_monthly_student_payments(text, date)
  from public, anon, authenticated;
grant execute on function public.generate_monthly_student_payments(text, date)
  to service_role;

create or replace function public.claim_asaas_teacher_transfer(
  p_closing_id uuid,
  p_actor_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  closing_row public.teacher_closings%rowtype;
  teacher_row public.profiles%rowtype;
  actor_role text;
  attempt_row public.asaas_teacher_transfer_attempts%rowtype;
  teacher_nf_exempt boolean := false;
  require_nf boolean := false;
  external_ref text;
  normalized_pix_key text;
  normalized_pix_type text;
  destination_hash text;
  description_snapshot text;
begin
  if p_closing_id is null or p_actor_id is null or p_claim_token is null then
    raise exception using errcode = '22023', message = 'transfer_claim_arguments_required';
  end if;

  select closing.* into closing_row
    from public.teacher_closings as closing
   where closing.id = p_closing_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'closing_not_found');
  end if;

  select profile.role into actor_role
    from public.profiles as profile
   where profile.id = p_actor_id
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active';

  if actor_role is null or (
    actor_role <> 'SUPER_ADMIN'
    and not exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = p_actor_id
         and membership.tenant_id = closing_row.tenant_id
         and membership.role = 'SCHOOL_ADMIN'
         and membership.status = 'ACTIVE'
    )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  select teacher.* into teacher_row
    from public.profiles as teacher
    join public.tenant_memberships as membership
      on membership.user_id = teacher.id
     and membership.tenant_id = closing_row.tenant_id
     and membership.role = 'TEACHER'
     and membership.status = 'ACTIVE'
   where teacher.id = closing_row.teacher_id
     and teacher.role = 'TEACHER'
     and lower(trim(coalesce(teacher.lifecycle_status, ''))) = 'active'
   for share of teacher, membership;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'teacher_membership_inactive');
  end if;

  teacher_nf_exempt := coalesce(teacher_row.nf_exempt, false);
  select coalesce(tenant.require_nf_for_transfer, false)
    into require_nf
    from public.tenants as tenant
   where tenant.id = closing_row.tenant_id;
  if require_nf and not teacher_nf_exempt and exists (
    select 1
      from public.teacher_closings as prior
     where prior.teacher_id = closing_row.teacher_id
       and prior.tenant_id = closing_row.tenant_id
       and prior.id <> closing_row.id
       and prior.status in ('PAID_WAITING_NF', 'REJECTED', 'REJEITADO')
       and coalesce(prior.total_amount, 0) > 0
       and nullif(trim(prior.nf_link), '') is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'fiscal_lock_pending_invoice');
  end if;

  if coalesce(closing_row.total_amount, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  normalized_pix_type := upper(trim(coalesce(teacher_row.pix_key_type, '')));
  if normalized_pix_type = 'TELEFONE' then
    normalized_pix_type := 'PHONE';
  end if;
  if normalized_pix_type not in ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP') then
    return jsonb_build_object('ok', false, 'reason', 'teacher_pix_key_type_invalid');
  end if;

  normalized_pix_key := trim(coalesce(teacher_row.pix_key, ''));
  if normalized_pix_type in ('CPF', 'CNPJ', 'PHONE') then
    normalized_pix_key := regexp_replace(normalized_pix_key, '\D', '', 'g');
  end if;
  if normalized_pix_key = ''
     or length(normalized_pix_key) > 180
     or (normalized_pix_type = 'CPF' and normalized_pix_key !~ '^\d{11}$')
     or (normalized_pix_type = 'CNPJ' and normalized_pix_key !~ '^\d{14}$')
     or (normalized_pix_type = 'PHONE' and normalized_pix_key !~ '^\d{10,15}$')
     or (normalized_pix_type = 'EMAIL' and normalized_pix_key !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
     or (normalized_pix_type = 'EVP' and normalized_pix_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  then
    return jsonb_build_object('ok', false, 'reason', 'teacher_pix_key_invalid');
  end if;

  destination_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(normalized_pix_type || ':' || normalized_pix_key, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  description_snapshot := left(
    'Pagamento Professor - ' ||
    regexp_replace(trim(coalesce(teacher_row.full_name, 'Professor')), '[\r\n\t]+', ' ', 'g') ||
    ' - Ref: ' ||
    regexp_replace(trim(coalesce(closing_row.month_year::text, 'sem-periodo')), '[\r\n\t]+', ' ', 'g'),
    300
  );

  select attempt.* into attempt_row
    from public.asaas_teacher_transfer_attempts as attempt
   where attempt.closing_id = p_closing_id
   for update;

  if found then
    if attempt_row.status in ('SUBMITTED', 'UNKNOWN') then
      update public.asaas_teacher_transfer_attempts
         set claim_token = p_claim_token,
             lease_expires_at = now() + interval '5 minutes',
             updated_at = now()
       where id = attempt_row.id;
      return jsonb_build_object(
        'ok', true,
        'action', 'RECONCILE_REQUIRED',
        'attempt_id', attempt_row.id,
        'tenant_id', attempt_row.tenant_id,
        'expected_amount', attempt_row.expected_amount,
        'destination_fingerprint', attempt_row.destination_fingerprint,
        'external_reference', attempt_row.external_reference,
        'created_at', attempt_row.created_at,
        'provider_transfer_id', attempt_row.provider_transfer_id,
        'claim_token', p_claim_token,
        'status', attempt_row.status
      );
    elsif attempt_row.status = 'COMPLETED' then
      return jsonb_build_object(
        'ok', true,
        'action', 'ALREADY_COMPLETED',
        'attempt_id', attempt_row.id,
        'tenant_id', attempt_row.tenant_id,
        'provider_transfer_id', attempt_row.provider_transfer_id,
        'status', attempt_row.status
      );
    elsif attempt_row.status = 'CLAIMED' then
      if attempt_row.lease_expires_at > now() then
        return jsonb_build_object(
          'ok', true,
          'action', 'IN_PROGRESS',
          'attempt_id', attempt_row.id,
          'tenant_id', attempt_row.tenant_id
        );
      end if;

      -- Crash window: the provider POST may have succeeded before the Edge
      -- Function persisted its response. Never submit again. Reclaim only for
      -- a GET reconciliation by id/externalReference.
      update public.asaas_teacher_transfer_attempts
         set claim_token = p_claim_token,
             lease_expires_at = now() + interval '5 minutes',
             status = 'UNKNOWN',
             last_error = 'submit_outcome_unknown_after_lease_expiry',
             updated_at = now()
       where id = attempt_row.id;
      return jsonb_build_object(
        'ok', true,
        'action', 'RECONCILE_REQUIRED',
        'attempt_id', attempt_row.id,
        'tenant_id', attempt_row.tenant_id,
        'expected_amount', attempt_row.expected_amount,
        'destination_fingerprint', attempt_row.destination_fingerprint,
        'external_reference', attempt_row.external_reference,
        'created_at', attempt_row.created_at,
        'provider_transfer_id', attempt_row.provider_transfer_id,
        'claim_token', p_claim_token,
        'status', 'UNKNOWN'
      );
    else
      return jsonb_build_object(
        'ok', false,
        'reason', 'attempt_requires_manual_review',
        'attempt_id', attempt_row.id,
        'status', attempt_row.status
      );
    end if;
  end if;

  if closing_row.asaas_transfer_id is not null
     or closing_row.status in ('PAID_WAITING_NF', 'UNDER_REVIEW', 'COMPLETED', 'PAGO')
  then
    return jsonb_build_object('ok', false, 'reason', 'closing_already_paid_or_submitted');
  end if;

  external_ref := 'wisewolf-teacher-closing:' || p_closing_id::text;
  insert into public.asaas_teacher_transfer_attempts (
    closing_id, tenant_id, requested_by, external_reference, expected_amount,
    destination_pix_key, destination_pix_key_type, destination_fingerprint,
    transfer_description, claim_token, lease_expires_at
  ) values (
    p_closing_id, closing_row.tenant_id, p_actor_id, external_ref,
    closing_row.total_amount, normalized_pix_key, normalized_pix_type,
    destination_hash, description_snapshot, p_claim_token,
    now() + interval '5 minutes'
  ) returning * into attempt_row;

  return jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'attempt_id', attempt_row.id,
    'tenant_id', attempt_row.tenant_id,
    'external_reference', attempt_row.external_reference,
    'expected_amount', attempt_row.expected_amount,
    'destination_pix_key', attempt_row.destination_pix_key,
    'destination_pix_key_type', attempt_row.destination_pix_key_type,
    'destination_fingerprint', attempt_row.destination_fingerprint,
    'transfer_description', attempt_row.transfer_description,
    'claim_token', attempt_row.claim_token,
    'status', attempt_row.status
  );
end;
$function$;

revoke all on function public.claim_asaas_teacher_transfer(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_asaas_teacher_transfer(uuid, uuid, uuid)
  to service_role;

create or replace function public.record_asaas_teacher_transfer_state(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_transfer_id text default null,
  p_provider_status text default null,
  p_http_status integer default null,
  p_error text default null,
  p_provider_response jsonb default null,
  p_destination_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_teacher_transfer_attempts%rowtype;
  normalized_status text := upper(trim(coalesce(p_status, '')));
  closing_status text;
  teacher_nf_exempt boolean := false;
begin
  if normalized_status not in ('SUBMITTED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'BLOCKED') then
    raise exception using errcode = '22023', message = 'invalid_transfer_attempt_status';
  end if;

  select attempt.* into attempt_row
    from public.asaas_teacher_transfer_attempts as attempt
   where attempt.id = p_attempt_id
   for update;
  if not found or attempt_row.claim_token is distinct from p_claim_token then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if attempt_row.status = 'COMPLETED' and normalized_status <> 'COMPLETED' then
    return jsonb_build_object('ok', true, 'status', 'COMPLETED', 'ignored_regression', true);
  end if;

  if p_destination_fingerprint is not null
     and attempt_row.destination_fingerprint is distinct from p_destination_fingerprint
  then
    return jsonb_build_object('ok', false, 'reason', 'destination_snapshot_mismatch');
  end if;

  update public.asaas_teacher_transfer_attempts
     set status = normalized_status,
         provider_transfer_id = coalesce(p_provider_transfer_id, provider_transfer_id),
         provider_status = coalesce(p_provider_status, provider_status),
         last_http_status = p_http_status,
         last_error = nullif(left(coalesce(p_error, ''), 500), ''),
         provider_response = coalesce(p_provider_response, provider_response),
         submit_attempt_count = case
           when attempt_row.status = 'CLAIMED' and normalized_status in ('SUBMITTED', 'COMPLETED', 'UNKNOWN', 'FAILED')
             then 1
           else submit_attempt_count
         end,
         reconciliation_count = reconciliation_count + case
           when attempt_row.status in ('SUBMITTED', 'UNKNOWN') then 1 else 0 end,
         submitted_at = case
           when normalized_status in ('SUBMITTED', 'COMPLETED') then coalesce(submitted_at, now())
           else submitted_at
         end,
         reconciled_at = case
           when attempt_row.status in ('SUBMITTED', 'UNKNOWN') then now()
           else reconciled_at
         end,
         completed_at = case when normalized_status = 'COMPLETED' then now() else completed_at end,
         updated_at = now()
   where id = p_attempt_id;

  if normalized_status in ('SUBMITTED', 'COMPLETED') and p_provider_transfer_id is not null then
    select coalesce(teacher.nf_exempt, false)
      into teacher_nf_exempt
      from public.teacher_closings as closing
      join public.profiles as teacher on teacher.id = closing.teacher_id
     where closing.id = attempt_row.closing_id;
    closing_status := case
      when normalized_status = 'COMPLETED' then
        case when teacher_nf_exempt
          then 'PAGO' else 'PAID_WAITING_NF' end
      else 'UNDER_REVIEW'
    end;

    update public.teacher_closings as closing
       set asaas_transfer_id = p_provider_transfer_id,
           transfer_status = coalesce(p_provider_status, normalized_status),
           status = closing_status,
           paid_at = case when normalized_status = 'COMPLETED' then coalesce(closing.paid_at, now()) else closing.paid_at end,
           updated_at = now()
     where closing.id = attempt_row.closing_id
       and (closing.asaas_transfer_id is null or closing.asaas_transfer_id = p_provider_transfer_id);
  end if;

  if normalized_status in ('UNKNOWN', 'FAILED', 'BLOCKED') then
    insert into public.asaas_reconciliation_issues (
      tenant_id, source, kind, severity, provider_entity_id,
      local_entity_id, fingerprint, details
    ) values (
      attempt_row.tenant_id,
      'TRANSFER',
      'TEACHER_TRANSFER_' || normalized_status,
      case when normalized_status = 'UNKNOWN' then 'CRITICAL' else 'HIGH' end,
      p_provider_transfer_id,
      attempt_row.closing_id::text,
      'teacher-transfer:' || attempt_row.id::text || ':' || normalized_status,
      jsonb_build_object(
        'attemptId', attempt_row.id,
        'externalReference', attempt_row.external_reference,
        'httpStatus', p_http_status,
        'error', left(coalesce(p_error, 'unknown'), 500)
      )
    ) on conflict do nothing;
  end if;

  return jsonb_build_object('ok', true, 'status', normalized_status);
end;
$function$;

revoke all on function public.record_asaas_teacher_transfer_state(
  uuid, uuid, text, text, text, integer, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_asaas_teacher_transfer_state(
  uuid, uuid, text, text, text, integer, text, jsonb, text
) to service_role;

create or replace function public.begin_asaas_reconciliation_run(
  p_window_start date,
  p_window_end date,
  p_started_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run_row public.asaas_reconciliation_runs%rowtype;
begin
  if p_window_start is null or p_window_end is null
     or p_window_end < p_window_start
     or p_window_end - p_window_start > 366
  then
    raise exception using errcode = '22023', message = 'invalid_reconciliation_window';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('asaas-reconciliation-run', 0));

  update public.asaas_reconciliation_runs
     set status = 'FAILED',
         finished_at = now(),
         last_error = 'stale_run_reclaimed',
         updated_at = now()
   where status = 'RUNNING'
     and updated_at < now() - interval '30 minutes';

  select run.* into run_row
    from public.asaas_reconciliation_runs as run
   where run.status = 'RUNNING'
   order by run.started_at
   limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'already_running', 'run_id', run_row.id);
  end if;

  insert into public.asaas_reconciliation_runs (
    window_start, window_end, started_by
  ) values (
    p_window_start, p_window_end, p_started_by
  ) returning * into run_row;

  return jsonb_build_object('ok', true, 'run_id', run_row.id);
end;
$function$;

revoke all on function public.begin_asaas_reconciliation_run(date, date, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_asaas_reconciliation_run(date, date, uuid)
  to service_role;

create or replace function private.trigger_asaas_automation_worker()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  service_key text;
begin
  select secret.decrypted_secret into service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;
  if nullif(service_key, '') is null then
    raise warning 'wisewolf_service_role_key is not configured';
    return;
  end if;

  perform net.http_post(
    url := 'http://kong:8000/functions/v1/asaas-webhook',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'apikey', service_key,
      'Content-Type', 'application/json'
    ),
    body := '{"operation":"drain"}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$function$;

revoke all on function private.trigger_asaas_automation_worker()
  from public, anon, authenticated;

create or replace function private.trigger_asaas_reconciliation()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  service_key text;
begin
  select secret.decrypted_secret into service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;
  if nullif(service_key, '') is null then
    raise warning 'wisewolf_service_role_key is not configured';
    return;
  end if;

  perform net.http_post(
    url := 'http://kong:8000/functions/v1/asaas-reconcile',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'apikey', service_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('lookbackDays', 45),
    timeout_milliseconds := 120000
  );
end;
$function$;

revoke all on function private.trigger_asaas_reconciliation()
  from public, anon, authenticated;

-- A terminal inbox state or a failed/stale audit must reach an operator; rows
-- in an observability table alone are not an alert. This notifier emits one
-- compact, PII-free summary per day through the existing durable queue.
create or replace function private.notify_asaas_automation_health()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  admin_row record;
  dedupe_id uuid;
  triage_count integer := 0;
  dead_letter_count integer := 0;
  stale_inbox_count integer := 0;
  failed_run_count integer := 0;
  stale_run_count integer := 0;
  open_severe_issue_count integer := 0;
  http_failure_count integer := 0;
  inactive_job_count integer := 0;
  failed_job_run_count integer := 0;
  alert_message text;
begin
  if not pg_try_advisory_xact_lock(
    hashtextextended('asaas-automation-health-notifier', 0)
  ) then
    return 0;
  end if;

  -- pg_cron considera sucesso quando o pg_net apenas enfileira a requisicao.
  -- O coletor posterior confronta cada request_id com a resposta HTTP real.
  if to_regprocedure('private.collect_asaas_http_failures()') is not null then
    perform private.collect_asaas_http_failures();
  end if;

  select
    count(*) filter (where inbox.status = 'TRIAGE'),
    count(*) filter (where inbox.status = 'DEAD_LETTER'),
    count(*) filter (
      where (
        inbox.status = 'PROCESSING'
        and inbox.lease_expires_at < now()
      ) or (
        inbox.status in ('RECEIVED', 'RETRY')
        and inbox.updated_at < now() - interval '2 hours'
      )
    )
    into triage_count, dead_letter_count, stale_inbox_count
    from public.asaas_webhook_inbox as inbox;

  select
    count(*) filter (
      where run.status = 'FAILED'
        and run.updated_at > now() - interval '7 days'
    ),
    count(*) filter (
      where run.status = 'RUNNING'
        and run.updated_at < now() - interval '30 minutes'
    )
    into failed_run_count, stale_run_count
    from public.asaas_reconciliation_runs as run;

  select count(*)
    into open_severe_issue_count
    from public.asaas_reconciliation_issues as issue
   where issue.resolved_at is null
     and issue.severity in ('HIGH', 'CRITICAL')
     and issue.observed_at > now() - interval '24 hours';

  select count(*)
    into http_failure_count
    from public.asaas_reconciliation_issues as issue
   where issue.resolved_at is null
     and issue.source = 'AUTOMATION_HTTP'
     and issue.observed_at > now() - interval '24 hours';

  select count(*)
    into inactive_job_count
    from (
      values
        ('wisewolf-asaas-webhook-worker'),
        ('wisewolf-asaas-reconciliation'),
        ('wisewolf-asaas-health'),
        ('wisewolf-sync-plan-change-billing'),
        ('wisewolf-reconcile-ledger'),
        ('wisewolf-sync-subscriptions'),
        ('wisewolf-payment-split-sweep')
    ) as expected(jobname)
    left join cron.job as job
      on job.jobname = expected.jobname
     and job.active is true
   where job.jobid is null;

  select count(*)
    into failed_job_run_count
    from cron.job_run_details as detail
    join cron.job as job on job.jobid = detail.jobid
     where job.jobname in (
       'wisewolf-asaas-webhook-worker',
       'wisewolf-asaas-reconciliation',
       'wisewolf-sync-plan-change-billing',
       'wisewolf-reconcile-ledger',
       'wisewolf-sync-subscriptions',
       'wisewolf-payment-split-sweep'
     )
     and detail.status = 'failed'
     and detail.start_time > now() - interval '24 hours';

  if triage_count = 0
     and dead_letter_count = 0
     and stale_inbox_count = 0
     and failed_run_count = 0
     and stale_run_count = 0
     and open_severe_issue_count = 0
     and http_failure_count = 0
     and inactive_job_count = 0
     and failed_job_run_count = 0
  then
    return 0;
  end if;

  select
    profile.id,
    membership.tenant_id,
    profile.phone
    into admin_row
    from public.tenant_memberships as membership
    join public.profiles as profile on profile.id = membership.user_id
   where membership.tenant_id = 'school-wise-wolf'
     and membership.role = 'SCHOOL_ADMIN'
     and membership.status = 'ACTIVE'
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
     and nullif(trim(profile.phone), '') is not null
     and coalesce(profile.is_test_account, false) is false
   order by membership.is_primary desc nulls last, membership.created_at, profile.id
   limit 1;

  if admin_row.id is null then
    raise exception using
      errcode = '55000',
      message = 'asaas_health_notification_recipient_unavailable';
  end if;

  insert into public.automation_sent (kind, subject_id, ref_date)
  values ('ASAAS_HEALTH', 'school-wise-wolf', current_date)
  on conflict (kind, subject_id, ref_date) do nothing
  returning id into dedupe_id;
  if dedupe_id is null then
    return 0;
  end if;

  alert_message :=
    '🔴 *Asaas requer atenção*' || E'\n\n' ||
    'Triagem: ' || triage_count ||
    ' | fila morta: ' || dead_letter_count ||
    ' | fila parada: ' || stale_inbox_count || E'\n' ||
    'Auditorias falhas: ' || failed_run_count ||
    ' | auditorias travadas: ' || stale_run_count ||
    ' | divergências graves recentes: ' || open_severe_issue_count || E'\n' ||
    'Chamadas HTTP falhas/sem resposta: ' || http_failure_count || E'\n' ||
    'Crons ausentes/desligados: ' || inactive_job_count ||
    ' | execuções de cron falhas: ' || failed_job_run_count || E'\n\n' ||
    'Consulte o painel técnico antes de reenviar ou corrigir qualquer valor.';

  insert into public.notification_queue (
    tenant_id,
    teacher_id,
    student_phone,
    message_body,
    scheduled_for,
    status,
    attempts,
    source_id,
    source_type,
    class_date,
    notification_kind
  ) values (
    admin_row.tenant_id,
    admin_row.id,
    admin_row.phone,
    alert_message,
    now(),
    'pending',
    0,
    dedupe_id,
    'ASAAS_HEALTH',
    current_date,
    'ASAAS_HEALTH'
  );

  return 1;
end;
$function$;

revoke all on function private.notify_asaas_automation_health()
  from public, anon, authenticated, service_role;

do $schedule$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net')
  then
    perform cron.unschedule(jobid)
      from cron.job
     where jobname in (
       'wisewolf-asaas-webhook-worker',
       'wisewolf-asaas-reconciliation',
       'wisewolf-asaas-health'
     );

    perform cron.schedule(
      'wisewolf-asaas-webhook-worker',
      '* * * * *',
      'select private.trigger_asaas_automation_worker();'
    );
    perform cron.schedule(
      'wisewolf-asaas-reconciliation',
      '17 6 * * *',
      'select private.trigger_asaas_reconciliation();'
    );
    perform cron.schedule(
      'wisewolf-asaas-health',
      '*/15 * * * *',
      'select private.notify_asaas_automation_health();'
    );
  end if;
end;
$schedule$;

do $postcheck$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'student_payments'
       and column_name = 'tenant_id'
       and column_default is not null
  ) then
    raise exception 'student_payments.tenant_id still has a silent default';
  end if;

  if has_table_privilege('anon', 'public.asaas_webhook_inbox', 'SELECT')
     or has_table_privilege('authenticated', 'public.asaas_webhook_inbox', 'SELECT')
  then
    raise exception 'Asaas webhook inbox leaked to public API roles';
  end if;

  if has_function_privilege(
    'anon',
    'public.enqueue_asaas_webhook_event(text,text,text,timestamptz,jsonb,text)',
    'EXECUTE'
  ) then
    raise exception 'anon can enqueue forged Asaas events';
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (
       select 1
         from (
           values
             (
               'wisewolf-asaas-webhook-worker',
               '* * * * *',
               'select private.trigger_asaas_automation_worker();'
             ),
             (
               'wisewolf-asaas-reconciliation',
               '17 6 * * *',
               'select private.trigger_asaas_reconciliation();'
             ),
             (
               'wisewolf-asaas-health',
               '*/15 * * * *',
               'select private.notify_asaas_automation_health();'
             )
         ) as expected(jobname, schedule, command)
         left join lateral (
           select
             count(*) as total_count,
             count(*) filter (
               where job.active
                 and job.schedule = expected.schedule
                 and job.command = expected.command
             ) as exact_count
             from cron.job as job
            where job.jobname = expected.jobname
         ) as actual on true
        where actual.total_count <> 1
           or actual.exact_count <> 1
     )
  then
    raise exception 'one or more Asaas automation cron jobs drifted';
  end if;
end;
$postcheck$;
