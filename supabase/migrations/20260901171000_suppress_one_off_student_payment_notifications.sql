-- Exact, durable communication suppression for a single detached student
-- payment. The row is created before the provider POST and follows that
-- payment through its creation attempt, webhook and local ledger identities.
--
-- This affects only Wise Wolf's own outbound channels. It deliberately does
-- not change Asaas customer-notification settings.

create schema if not exists private;
revoke all on schema private from public, anon;

create table if not exists public.student_payment_notification_suppressions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  source_operation_id uuid not null,
  manual_pix_issuance_id uuid not null
    references public.student_manual_pix_issuances(id) on delete restrict,
  creation_attempt_id uuid not null
    references public.asaas_provider_creation_attempts(id) on delete restrict,
  external_reference text not null,
  due_date date not null,
  scope text not null default 'ALL_LOCAL_EXTERNAL'
    check (scope = 'ALL_LOCAL_EXTERNAL'),
  reason text not null default 'ONE_OFF_GAP_PIX_NO_EXTERNAL_COMMUNICATION'
    check (reason = 'ONE_OFF_GAP_PIX_NO_EXTERNAL_COMMUNICATION'),
  created_at timestamptz not null default pg_catalog.now(),
  constraint student_payment_notification_suppression_reference_check check (
    external_reference =
      'manual-pix:' || manual_pix_issuance_id::text ||
      ':student:' || student_id::text
  ),
  constraint student_payment_notification_suppression_reference_length check (
    pg_catalog.char_length(external_reference) between 1 and 240
    and external_reference = pg_catalog.btrim(external_reference)
    and external_reference !~ '[[:cntrl:]]'
  ),
  unique (source_operation_id),
  unique (manual_pix_issuance_id),
  unique (creation_attempt_id),
  unique (tenant_id, external_reference)
);

alter table public.student_payment_notification_suppressions owner to postgres;
alter table public.student_payment_notification_suppressions
  enable row level security;
alter table public.student_payment_notification_suppressions
  force row level security;
revoke all on table public.student_payment_notification_suppressions
  from public, anon, authenticated, service_role;
grant select on table public.student_payment_notification_suppressions
  to service_role;

create index if not exists student_payment_notification_suppression_student_idx
  on public.student_payment_notification_suppressions (
    tenant_id,
    student_id,
    created_at desc
  );

comment on table public.student_payment_notification_suppressions is
  'Immutable pre-provider policy suppressing every Wise Wolf external communication for one exact student payment.';
comment on column public.student_payment_notification_suppressions.source_operation_id is
  'Operator operation UUID. The operator owns the optional FK to its operation table.';

create or replace function private.validate_student_payment_notification_suppression()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_issuance public.student_manual_pix_issuances%rowtype;
  v_creation public.asaas_provider_creation_attempts%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || new.tenant_id || ':' ||
        new.student_id::text,
      0
    )
  );

  select issuance.*
  into v_issuance
  from public.student_manual_pix_issuances as issuance
  where issuance.id = new.manual_pix_issuance_id
  for update;

  select creation.*
  into v_creation
  from public.asaas_provider_creation_attempts as creation
  where creation.id = new.creation_attempt_id
  for update;

  if v_issuance.id is null
     or v_issuance.tenant_id is distinct from new.tenant_id
     or v_issuance.student_id is distinct from new.student_id
     or v_issuance.due_date is distinct from new.due_date
     or v_issuance.status <> 'PROCESSING'
     or v_issuance.asaas_payment_id is not null then
    raise exception 'notification_suppression_manual_pix_scope_invalid'
      using errcode = '23514';
  end if;

  if v_creation.id is null
     or v_creation.tenant_id is distinct from new.tenant_id
     or v_creation.operation <> 'PAYMENT_CREATE'
     or v_creation.logical_key is distinct from
       'manual-pix:' || new.manual_pix_issuance_id::text
     or v_creation.external_reference is distinct from new.external_reference
     or v_creation.lifecycle_student_id is distinct from new.student_id
     or v_creation.lifecycle_binding_kind is distinct from
       'BILLING_PERIOD_PAYMENT'
     or v_creation.lifecycle_bound_at is null
     or v_creation.lifecycle_released_at is not null
     or v_creation.status <> 'CLAIMED'
     or v_creation.submit_attempt_count <> 0
     or v_creation.provider_entity_id is not null
     or v_creation.submitted_at is not null then
    raise exception 'notification_suppression_must_precede_provider_submit'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

alter function private.validate_student_payment_notification_suppression()
  owner to postgres;
revoke all on function
  private.validate_student_payment_notification_suppression()
  from public, anon, authenticated, service_role;

drop trigger if exists student_payment_notification_suppression_validate
  on public.student_payment_notification_suppressions;
create trigger student_payment_notification_suppression_validate
before insert on public.student_payment_notification_suppressions
for each row execute function
  private.validate_student_payment_notification_suppression();

create or replace function private.reject_student_payment_notification_suppression_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'student_payment_notification_suppression_is_immutable'
    using errcode = '55000';
end;
$function$;

alter function private.reject_student_payment_notification_suppression_mutation()
  owner to postgres;
revoke all on function
  private.reject_student_payment_notification_suppression_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists student_payment_notification_suppression_immutable
  on public.student_payment_notification_suppressions;
create trigger student_payment_notification_suppression_immutable
before update or delete on public.student_payment_notification_suppressions
for each row execute function
  private.reject_student_payment_notification_suppression_mutation();

-- Resolve the same payment across the three identities used by current
-- producers:
--   * provider payment id (manual-Pix message);
--   * local student_payments UUID (CAPI, reminders and queue worker);
--   * webhook inbox externalReference (race before the creation attempt is
--     bound to its provider id).
-- No fallback by student or due date exists, so a later recurring charge can
-- never inherit this suppression.
create or replace function private.student_payment_notification_suppression_id(
  p_tenant_id text,
  p_student_id uuid,
  p_payment_identity text,
  p_notification_kind text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text := nullif(
    pg_catalog.btrim(coalesce(p_tenant_id, '')),
    ''
  );
  v_payment_identity text := nullif(
    pg_catalog.btrim(coalesce(p_payment_identity, '')),
    ''
  );
  v_kind text := upper(pg_catalog.btrim(coalesce(p_notification_kind, '')));
  v_local_payment_id uuid;
  v_suppression_id uuid;
begin
  if v_kind = 'PAYMENT_CONFIRMED' then
    v_kind := 'PAYMENT_CONFIRMED_WHATSAPP';
  end if;

  if v_tenant_id is null
     or p_student_id is null
     or v_payment_identity is null
     or v_kind not in (
       'MANUAL_PIX_CREATED',
       'PAYMENT_CONFIRMED_CAPI',
       'PAYMENT_CONFIRMED_WHATSAPP',
       'PAYMENT_DUE_REMINDER',
       'PAYMENT_OVERDUE_3',
       'PAYMENT_OVERDUE_10',
       'PAYMENT_OVERDUE_20',
       'PAYMENT_SPLIT',
       'PAYMENT_RECEIVED'
     ) then
    return null;
  end if;

  if v_payment_identity ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_local_payment_id := v_payment_identity::uuid;
  end if;

  with candidate_provider_ids as (
    select v_payment_identity as provider_payment_id
    union
    select nullif(pg_catalog.btrim(payment.asaas_payment_id), '')
    from public.student_payments as payment
    where v_local_payment_id is not null
      and payment.id = v_local_payment_id
      and payment.tenant_id = v_tenant_id
      and payment.student_id = p_student_id
      and payment.asaas_payment_id is not null
  ),
  candidate_external_references as (
    select distinct nullif(
      pg_catalog.btrim(coalesce(
        inbox.payload #>> '{payment,externalReference}',
        inbox.payload ->> 'externalReference',
        ''
      )),
      ''
    ) as external_reference
    from public.asaas_webhook_inbox as inbox
    join candidate_provider_ids as candidate
      on candidate.provider_payment_id is not null
      and inbox.provider_entity_id = candidate.provider_payment_id
  )
  select suppression.id
  into v_suppression_id
  from public.student_payment_notification_suppressions as suppression
  join public.asaas_provider_creation_attempts as creation
    on creation.id = suppression.creation_attempt_id
  join public.student_manual_pix_issuances as issuance
    on issuance.id = suppression.manual_pix_issuance_id
  where suppression.tenant_id = v_tenant_id
    and suppression.student_id = p_student_id
    and suppression.scope = 'ALL_LOCAL_EXTERNAL'
    and (
      exists (
        select 1
        from candidate_provider_ids as candidate
        where candidate.provider_payment_id is not null
          and candidate.provider_payment_id in (
            creation.provider_entity_id,
            issuance.asaas_payment_id
          )
      )
      or exists (
        select 1
        from candidate_external_references as candidate
        where candidate.external_reference = suppression.external_reference
      )
    )
  order by suppression.id
  limit 1;

  return v_suppression_id;
end;
$function$;

alter function private.student_payment_notification_suppression_id(
  text,uuid,text,text
) owner to postgres;
revoke all on function private.student_payment_notification_suppression_id(
  text,uuid,text,text
) from public, anon, authenticated, service_role;

create or replace function private.suppress_student_payment_outbound_attempt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_suppression_id uuid;
begin
  v_suppression_id :=
    private.student_payment_notification_suppression_id(
      new.tenant_id,
      new.student_id,
      new.provider_entity_id,
      new.notification_kind
    );
  if v_suppression_id is null then
    return new;
  end if;

  if coalesce(new.submit_attempt_count, 0) > 0
     or (tg_op = 'UPDATE' and coalesce(old.submit_attempt_count, 0) > 0) then
    raise exception 'suppressed_student_payment_outbound_boundary_already_crossed'
      using errcode = '55000';
  end if;

  new.status := 'SUPPRESSED';
  new.submit_attempt_count := 0;
  new.lease_expires_at := pg_catalog.now();
  new.provider_http_status := null;
  new.last_error := 'student_payment_notification_policy:' ||
    v_suppression_id::text;
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

alter function private.suppress_student_payment_outbound_attempt()
  owner to postgres;
revoke all on function private.suppress_student_payment_outbound_attempt()
  from public, anon, authenticated, service_role;

drop trigger if exists suppress_exact_student_payment_outbound_attempt
  on public.asaas_outbound_message_attempts;
create trigger suppress_exact_student_payment_outbound_attempt
before insert or update
on public.asaas_outbound_message_attempts
for each row execute function
  private.suppress_student_payment_outbound_attempt();

create or replace function private.suppress_student_payment_queue_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_suppression_id uuid;
begin
  if upper(pg_catalog.btrim(coalesce(new.source_type, ''))) <>
       'ASAAS_PAYMENT'
     or new.source_id is null
     or new.student_id is null then
    return new;
  end if;

  v_suppression_id :=
    private.student_payment_notification_suppression_id(
      new.tenant_id,
      new.student_id,
      new.source_id::text,
      new.notification_kind
    );
  if v_suppression_id is null then
    return new;
  end if;

  if new.delivery_status in (
       'submitting', 'accepted', 'sent', 'delivered', 'read', 'uncertain'
     ) or (
       tg_op = 'UPDATE'
       and old.delivery_status in (
         'submitting', 'accepted', 'sent', 'delivered', 'read', 'uncertain'
       )
     ) then
    raise exception 'suppressed_student_payment_queue_boundary_already_crossed'
      using errcode = '55000';
  end if;

  new.status := 'skipped';
  new.delivery_status := 'skipped';
  new.claim_token := null;
  new.lease_expires_at := null;
  new.next_attempt_at := pg_catalog.now();
  new.last_error := 'student_payment_notification_policy:' ||
    v_suppression_id::text;
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

alter function private.suppress_student_payment_queue_notification()
  owner to postgres;
revoke all on function private.suppress_student_payment_queue_notification()
  from public, anon, authenticated, service_role;

drop trigger if exists suppress_exact_student_payment_queue_notification
  on public.notification_queue;
create trigger suppress_exact_student_payment_queue_notification
before insert or update
on public.notification_queue
for each row execute function
  private.suppress_student_payment_queue_notification();

create or replace function private.suppress_management_payment_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid;
  v_suppression_id uuid;
begin
  select payment.student_id
  into v_student_id
  from public.student_payments as payment
  where payment.id = new.payment_id
    and payment.tenant_id = new.tenant_id;

  if v_student_id is null then
    return new;
  end if;

  v_suppression_id :=
    private.student_payment_notification_suppression_id(
      new.tenant_id,
      v_student_id,
      new.payment_id::text,
      new.notification_kind
    );
  if v_suppression_id is null then
    return new;
  end if;

  if coalesce(new.submit_attempt_count, 0) > 0
     or (tg_op = 'UPDATE' and coalesce(old.submit_attempt_count, 0) > 0) then
    raise exception 'suppressed_management_payment_boundary_already_crossed'
      using errcode = '55000';
  end if;

  new.status := 'SUPPRESSED';
  new.submit_attempt_count := 0;
  new.lease_expires_at := pg_catalog.now();
  new.last_error := 'student_payment_notification_policy:' ||
    v_suppression_id::text;
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

alter function private.suppress_management_payment_notification()
  owner to postgres;
revoke all on function private.suppress_management_payment_notification()
  from public, anon, authenticated, service_role;

drop trigger if exists suppress_exact_management_payment_notification
  on public.management_payment_notification_outbox;
create trigger suppress_exact_management_payment_notification
before insert or update
on public.management_payment_notification_outbox
for each row execute function
  private.suppress_management_payment_notification();
