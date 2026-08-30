-- A financial settlement and its management-group notification intent must be
-- committed together. The provider call remains asynchronous, but there is no
-- longer a time window in which money can be recorded without a durable item
-- for the worker to find.

create schema if not exists private;
revoke all on schema private from public, anon;

create table if not exists public.management_payment_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  payment_id uuid not null references public.student_payments(id) on delete restrict,
  notification_kind text not null check (
    notification_kind in ('PAYMENT_SPLIT', 'PAYMENT_RECEIVED')
  ),
  status text not null default 'PENDING' check (
    status in (
      'PENDING', 'CLAIMED', 'PREPARED', 'SUBMITTING', 'SENT', 'FAILED', 'UNKNOWN',
      'SUPPRESSED'
    )
  ),
  claim_token uuid,
  lease_expires_at timestamptz,
  submit_attempt_count integer not null default 0 check (
    submit_attempt_count between 0 and 1
  ),
  configured_destination_snapshot text,
  provider_destination text,
  provider_instance_name text,
  provider_integration_id uuid,
  provider_integration_version bigint,
  provider_endpoint_hash text,
  provider_credential_hash text,
  message_body text,
  source_snapshot jsonb,
  source_snapshot_hash text,
  snapshot_hash text,
  provider_message_id text,
  provider_http_status integer,
  provider_delivery_status text check (
    provider_delivery_status is null
    or provider_delivery_status in (
      'accepted', 'sent', 'delivered', 'read', 'failed', 'uncertain'
    )
  ),
  last_error text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (tenant_id, payment_id),
  constraint management_payment_notification_claim_check check (coalesce((
    (
      status = 'PENDING'
      and claim_token is null
      and lease_expires_at is null
      and submit_attempt_count = 0
    )
    or (
      status = 'CLAIMED'
      and claim_token is not null
      and lease_expires_at is not null
      and submit_attempt_count = 0
    )
    or (
      status = 'PREPARED'
      and claim_token is not null
      and lease_expires_at is not null
      and submit_attempt_count = 0
      and configured_destination_snapshot is not null
      and provider_destination is not null
      and provider_instance_name is not null
      and provider_integration_id is not null
      and provider_integration_version > 0
      and provider_endpoint_hash is null
      and provider_credential_hash is null
      and message_body is not null
      and pg_catalog.jsonb_typeof(source_snapshot) = 'object'
      and source_snapshot_hash ~ '^[0-9a-f]{64}$'
      and snapshot_hash is null
    )
    or (
      status in ('SUBMITTING', 'SENT', 'FAILED', 'UNKNOWN')
      and claim_token is not null
      and lease_expires_at is not null
      and submit_attempt_count = 1
      and configured_destination_snapshot is not null
      and provider_destination is not null
      and provider_instance_name is not null
      and provider_integration_id is not null
      and provider_integration_version > 0
      and provider_endpoint_hash ~ '^[0-9a-f]{64}$'
      and provider_credential_hash ~ '^[0-9a-f]{64}$'
      and message_body is not null
      and pg_catalog.jsonb_typeof(source_snapshot) = 'object'
      and source_snapshot_hash ~ '^[0-9a-f]{64}$'
      and snapshot_hash ~ '^[0-9a-f]{64}$'
    )
    or (
      status = 'SUPPRESSED'
      and submit_attempt_count = 0
    )
  ), false))
);

alter table public.management_payment_notification_outbox owner to postgres;
alter table public.management_payment_notification_outbox enable row level security;
alter table public.management_payment_notification_outbox force row level security;
revoke all on table public.management_payment_notification_outbox
  from public, anon, authenticated, service_role;
grant select on table public.management_payment_notification_outbox
  to service_role;

create index if not exists management_payment_notification_outbox_pending_idx
  on public.management_payment_notification_outbox (created_at, id)
  where status in ('PENDING', 'CLAIMED', 'PREPARED')
    and submit_attempt_count = 0;
create index if not exists management_payment_notification_outbox_attention_idx
  on public.management_payment_notification_outbox (updated_at, id)
  where status in ('SUBMITTING', 'FAILED', 'UNKNOWN');
create index if not exists management_payment_notification_outbox_payment_idx
  on public.management_payment_notification_outbox (payment_id);
create unique index if not exists management_payment_notification_provider_idx
  on public.management_payment_notification_outbox (
    tenant_id,
    lower(provider_instance_name),
    provider_message_id
  )
  where provider_instance_name is not null
    and provider_message_id is not null;

create or replace function private.normalize_management_group_destination(
  p_destination text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_destination text := pg_catalog.btrim(coalesce(p_destination, ''));
  v_phone text;
begin
  if v_destination ~ '^[0-9]{10,25}@g[.]us$' then
    return v_destination;
  end if;

  v_phone := pg_catalog.regexp_replace(v_destination, '\D', '', 'g');
  if pg_catalog.char_length(v_phone) in (10, 11) then
    v_phone := '55' || v_phone;
  end if;
  if pg_catalog.char_length(v_phone) not between 12 and 15 then
    return null;
  end if;
  return v_phone;
end;
$function$;

alter function private.normalize_management_group_destination(text)
  owner to postgres;
revoke all on function private.normalize_management_group_destination(text)
  from public, anon, authenticated, service_role;

create or replace function private.management_payment_notification_kind(
  p_tenant_id text
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when not exists (
      select 1
      from public.dre_report_settings as management
      where management.tenant_id = p_tenant_id
        and management.is_active
        and private.normalize_management_group_destination(
          management.destino
        ) is not null
    ) then null
    when exists (
      select 1
      from public.payment_split_settings as split
      where split.tenant_id = p_tenant_id
        and split.is_active
    ) then 'PAYMENT_SPLIT'
    else 'PAYMENT_RECEIVED'
  end
$function$;

alter function private.management_payment_notification_kind(text)
  owner to postgres;
revoke all on function private.management_payment_notification_kind(text)
  from public, anon, authenticated, service_role;

create or replace function private.management_payment_is_test_fixture(
  p_tenant_id text,
  p_payment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select lower(coalesce(payment.raw_payload ->> 'testMode', '')) in (
             'true', '1'
           )
        or lower(coalesce(payment.raw_payload ->> 'test_mode', '')) in (
             'true', '1'
           )
        or lower(coalesce(payment.raw_payload ->> 'testFixture', '')) in (
             'true', '1'
           )
        or lower(coalesce(payment.raw_payload ->> 'test_fixture', '')) in (
             'true', '1'
           )
        or exists (
          select 1
          from public.profiles as student
          where student.id = payment.student_id
            and student.tenant_id = payment.tenant_id
            and (
              coalesce(student.is_test_account, false)
              or student.test_fixture_key is not null
            )
        )
    from public.student_payments as payment
    where payment.id = p_payment_id
      and payment.tenant_id = p_tenant_id
  ), false)
$function$;

alter function private.management_payment_is_test_fixture(text,uuid)
  owner to postgres;
revoke all on function private.management_payment_is_test_fixture(text,uuid)
  from public, anon, authenticated, service_role;

create or replace function private.management_payment_notification_replacement_kind(
  p_tenant_id text,
  p_payment_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select private.management_payment_notification_kind(payment.tenant_id)
  from public.student_payments as payment
  join public.tenants as tenant
    on tenant.id = payment.tenant_id
    and tenant.whatsapp_enabled is true
    and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) in (
      'active', 'trial', 'trialing'
    )
  where payment.id = p_payment_id
    and payment.tenant_id = p_tenant_id
    and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
      'RECEIVED', 'RECEIVED_IN_CASH'
    )
    and coalesce(payment.value, 0) > 0
    and not private.management_payment_is_test_fixture(
      payment.tenant_id,
      payment.id
    )
$function$;

alter function private.management_payment_notification_replacement_kind(
  text,uuid
) owner to postgres;
revoke all on function private.management_payment_notification_replacement_kind(
  text,uuid
) from public, anon, authenticated, service_role;

create or replace function private.management_payment_notification_scope_active(
  p_tenant_id text,
  p_payment_id uuid,
  p_notification_kind text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.student_payments as payment
    join public.tenants as tenant
      on tenant.id = payment.tenant_id
      and tenant.whatsapp_enabled is true
      and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) in (
        'active', 'trial', 'trialing'
      )
    where payment.id = p_payment_id
      and payment.tenant_id = p_tenant_id
      and upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
        'RECEIVED', 'RECEIVED_IN_CASH'
      )
      and coalesce(payment.value, 0) > 0
      and not private.management_payment_is_test_fixture(
        payment.tenant_id,
        payment.id
      )
      and private.management_payment_notification_kind(payment.tenant_id)
        = p_notification_kind
      and not (
        p_notification_kind = 'PAYMENT_SPLIT'
        and (
          exists (
            select 1
            from public.automation_sent as sent
            where sent.kind = 'PAYMENT_SPLIT'
              and sent.subject_id = payment.id::text
          )
          or exists (
            select 1
            from public.asaas_payment_split_message_attempts as legacy
            where legacy.tenant_id = payment.tenant_id
              and legacy.payment_id = payment.id
              and (
                legacy.submit_attempt_count > 0
                or legacy.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUBMITTING')
              )
          )
        )
      )
      and not (
        p_notification_kind = 'PAYMENT_RECEIVED'
        and exists (
          select 1
          from public.management_group_message_attempts as legacy
          where legacy.tenant_id = payment.tenant_id
            and legacy.notification_kind = 'PAYMENT_CONFIRMED'
            and legacy.subject_id = payment.id::text
            and (
              legacy.submit_attempt_count > 0
              or legacy.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUBMITTING')
            )
        )
      )
  )
$function$;

alter function private.management_payment_notification_scope_active(
  text,uuid,text
) owner to postgres;
revoke all on function private.management_payment_notification_scope_active(
  text,uuid,text
) from public, anon, authenticated, service_role;

-- The worker builds the human-readable body from this canonical snapshot and
-- sends the same JSON back to the final fence. Recomputing it under the final
-- database snapshot prevents a stale value, student name, schedule, teacher
-- rate or split percentage from being sealed and sent after a concurrent
-- change.
create or replace function public.management_payment_notification_source_snapshot(
  p_tenant_id text,
  p_payment_id uuid,
  p_notification_kind text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_kind text := upper(pg_catalog.btrim(coalesce(p_notification_kind, '')));
  v_snapshot jsonb;
begin
  if nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '') is null
     or p_payment_id is null
     or v_kind not in ('PAYMENT_SPLIT', 'PAYMENT_RECEIVED') then
    raise exception 'invalid_management_payment_notification_source'
      using errcode = '22023';
  end if;

  if v_kind = 'PAYMENT_SPLIT' then
    select public.payment_split_breakdown(p_payment_id)
    into v_snapshot;

    if pg_catalog.jsonb_typeof(v_snapshot) <> 'object'
       or v_snapshot ? 'error'
       or v_snapshot ->> 'tenant_id' is distinct from p_tenant_id then
      return null;
    end if;

    return v_snapshot || pg_catalog.jsonb_build_object(
      'is_test_fixture',
      private.management_payment_is_test_fixture(p_tenant_id, p_payment_id)
    );
  end if;

  select pg_catalog.jsonb_build_object(
    'payment_id', payment.id,
    'tenant_id', payment.tenant_id,
    'student_id', payment.student_id,
    'student_name', coalesce(
      nullif(pg_catalog.btrim(coalesce(student.full_name, '')), ''),
      'sem aluno vinculado'
    ),
    'value', payment.value,
    'status', upper(pg_catalog.btrim(coalesce(payment.status, ''))),
    'billing_type', payment.billing_type,
    'due_date', payment.due_date,
    'payment_date', payment.payment_date,
    'paid_at', payment.paid_at,
    'credited_at', payment.credited_at,
    'created_at', payment.created_at,
    'is_test_fixture', private.management_payment_is_test_fixture(
      payment.tenant_id,
      payment.id
    )
  )
  into v_snapshot
  from public.student_payments as payment
  left join public.profiles as student
    on student.id = payment.student_id
    and student.tenant_id = payment.tenant_id
  where payment.id = p_payment_id
    and payment.tenant_id = p_tenant_id;

  return v_snapshot;
end;
$function$;

alter function public.management_payment_notification_source_snapshot(
  text,uuid,text
) owner to postgres;
revoke all on function public.management_payment_notification_source_snapshot(
  text,uuid,text
) from public, anon, authenticated;
grant execute on function public.management_payment_notification_source_snapshot(
  text,uuid,text
) to service_role;

create or replace function public.notify_payment_split()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification_kind text;
  v_status text := 'PENDING';
  v_error text;
  v_outbox_id uuid;
  v_service_key text;
  v_request_id bigint;
begin
  if new.status not in ('RECEIVED', 'RECEIVED_IN_CASH')
     or coalesce(new.value, 0) <= 0 then
    return new;
  end if;
  -- Legacy/unbound payments have no school and therefore no truthful
  -- management-group route.  They must remain reconcilable without either
  -- inventing a tenant or aborting the settlement on the outbox invariant.
  if nullif(pg_catalog.btrim(coalesce(new.tenant_id, '')), '') is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  v_notification_kind := private.management_payment_notification_kind(
    new.tenant_id
  );
  if private.management_payment_is_test_fixture(new.tenant_id, new.id) then
    v_status := 'SUPPRESSED';
    v_error := 'test_fixture_suppressed';
  elsif v_notification_kind is null then
    v_status := 'SUPPRESSED';
    v_error := 'management_group_notification_disabled';
  end if;

  -- Test fixtures must remain suppressible even when the tenant has no active
  -- management destination.  The durable row still needs a canonical kind to
  -- satisfy its invariant; it will never be eligible for submission because
  -- SUPPRESSED is terminal.
  v_notification_kind := coalesce(v_notification_kind, 'PAYMENT_RECEIVED');

  insert into public.management_payment_notification_outbox (
    tenant_id,
    payment_id,
    notification_kind,
    status,
    lease_expires_at,
    last_error
  ) values (
    new.tenant_id,
    new.id,
    v_notification_kind,
    v_status,
    case when v_status = 'SUPPRESSED' then pg_catalog.now() else null end,
    v_error
  )
  on conflict (tenant_id, payment_id) do nothing
  returning id into v_outbox_id;

  if v_outbox_id is null or v_status <> 'PENDING' then
    return new;
  end if;

  -- The HTTP request is only a nudge. Its nested exception block cannot roll
  -- back the outbox INSERT above; the unlimited sweep is the recovery path.
  begin
    select secret.decrypted_secret
    into v_service_key
    from vault.decrypted_secrets as secret
    where secret.name = 'wisewolf_service_role_key'
    limit 1;

    if nullif(pg_catalog.btrim(coalesce(v_service_key, '')), '') is not null then
      select net.http_post(
        url := 'http://kong:8000/functions/v1/payment-split-notify',
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key,
          'apikey', v_service_key
        ),
        body := pg_catalog.jsonb_build_object(
          'management_notification_payment_id',
          new.id
        ),
        timeout_milliseconds := 20000
      ) into v_request_id;
    end if;
  exception when others then
    raise warning 'management payment notification nudge failed: %', sqlerrm;
  end;

  return new;
end;
$function$;

alter function public.notify_payment_split() owner to postgres;
revoke all on function public.notify_payment_split()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_notify_management_payment_confirmation
  on public.student_payments;
drop trigger if exists trg_notify_payment_split on public.student_payments;
create trigger trg_notify_payment_split
after insert or update of status on public.student_payments
for each row execute function public.notify_payment_split();

-- CREATE TRIGGER holds a relation lock until the release transaction commits.
-- Backfill only after that lock is acquired: writers that arrive now wait and
-- then execute the new trigger, so no settlement can fall between the
-- historical snapshot and transactional intent creation.
--
-- Settlements predating this outbox cannot be proven unsent. Keep them as
-- suppressed history instead of flooding the group on the first sweep. These
-- placeholders are deliberately terminal; only a genuinely new payment that
-- was still open before this migration can create a new PENDING intent.
insert into public.management_payment_notification_outbox (
  tenant_id,
  payment_id,
  notification_kind,
  status,
  lease_expires_at,
  last_error
)
select
  payment.tenant_id,
  payment.id,
  coalesce(
    private.management_payment_notification_kind(payment.tenant_id),
    'PAYMENT_RECEIVED'
  ),
  'SUPPRESSED',
  pg_catalog.now(),
  'pre_migration_settlement_without_atomic_intent'
from public.student_payments as payment
where upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
    'RECEIVED', 'RECEIVED_IN_CASH'
  )
  and coalesce(payment.value, 0) > 0
on conflict (tenant_id, payment_id) do nothing;

create or replace function public.management_payment_notification_pending(
  p_limit integer default 50
)
returns table (
  payment_id uuid,
  tenant_id text,
  notification_kind text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    outbox.payment_id,
    outbox.tenant_id,
    outbox.notification_kind
  from public.management_payment_notification_outbox as outbox
  where outbox.submit_attempt_count = 0
    and (
      outbox.status = 'PENDING'
      or (
        outbox.status in ('CLAIMED', 'PREPARED')
        and outbox.lease_expires_at <= pg_catalog.now()
      )
    )
  order by outbox.created_at, outbox.id
  limit greatest(1, least(coalesce(p_limit, 50), 200))
$function$;

alter function public.management_payment_notification_pending(integer)
  owner to postgres;
revoke all on function public.management_payment_notification_pending(integer)
  from public, anon, authenticated;
grant execute on function public.management_payment_notification_pending(integer)
  to service_role;

create or replace function public.claim_management_payment_notification(
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
  v_outbox public.management_payment_notification_outbox%rowtype;
  v_tenant_id text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  v_replacement_kind text;
  v_lease_seconds integer := greatest(
    60,
    least(coalesce(p_lease_seconds, 300), 600)
  );
begin
  if v_tenant_id is null or p_payment_id is null or p_claim_token is null then
    raise exception 'invalid_management_payment_notification_claim'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'management-payment-notification:' || v_tenant_id || ':' ||
        p_payment_id::text,
      0
    )
  );

  select outbox.*
  into v_outbox
  from public.management_payment_notification_outbox as outbox
  where outbox.tenant_id = v_tenant_id
    and outbox.payment_id = p_payment_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'durable_payment_notification_intent_missing'
    );
  end if;

  if v_outbox.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED')
     or v_outbox.submit_attempt_count > 0 then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_FINAL',
      'attempt_id', v_outbox.id,
      'status', v_outbox.status,
      'notification_kind', v_outbox.notification_kind
    );
  end if;

  v_replacement_kind :=
    private.management_payment_notification_replacement_kind(
      v_outbox.tenant_id,
      v_outbox.payment_id
    );
  if v_replacement_kind is not null
     and v_replacement_kind is distinct from v_outbox.notification_kind then
    update public.management_payment_notification_outbox
    set notification_kind = v_replacement_kind,
        status = 'PENDING',
        claim_token = null,
        lease_expires_at = null,
        configured_destination_snapshot = null,
        provider_destination = null,
        provider_instance_name = null,
        provider_integration_id = null,
        provider_integration_version = null,
        provider_endpoint_hash = null,
        provider_credential_hash = null,
        message_body = null,
        source_snapshot = null,
        source_snapshot_hash = null,
        snapshot_hash = null,
        last_error = 'management_payment_notification_kind_regenerated',
        updated_at = pg_catalog.now()
    where id = v_outbox.id
      and submit_attempt_count = 0;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'RETRY',
      'attempt_id', v_outbox.id,
      'status', 'PENDING',
      'notification_kind', v_replacement_kind,
      'reason', 'management_payment_notification_kind_regenerated'
    );
  end if;

  if not private.management_payment_notification_scope_active(
    v_outbox.tenant_id,
    v_outbox.payment_id,
    v_outbox.notification_kind
  ) then
    v_replacement_kind :=
      private.management_payment_notification_replacement_kind(
        v_outbox.tenant_id,
        v_outbox.payment_id
      );
    if v_replacement_kind is not null
       and v_replacement_kind is distinct from v_outbox.notification_kind then
      update public.management_payment_notification_outbox
      set notification_kind = v_replacement_kind,
          status = 'PENDING',
          claim_token = null,
          lease_expires_at = null,
          configured_destination_snapshot = null,
          provider_destination = null,
          provider_instance_name = null,
          provider_integration_id = null,
          provider_integration_version = null,
          provider_endpoint_hash = null,
          provider_credential_hash = null,
          message_body = null,
          source_snapshot = null,
          source_snapshot_hash = null,
          snapshot_hash = null,
          last_error = 'management_payment_notification_kind_regenerated',
          updated_at = pg_catalog.now()
      where id = v_outbox.id
        and submit_attempt_count = 0;
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'RETRY',
        'status', 'PENDING',
        'notification_kind', v_replacement_kind,
        'reason', 'management_payment_notification_kind_regenerated'
      );
    end if;

    update public.management_payment_notification_outbox
    set status = 'SUPPRESSED',
        lease_expires_at = pg_catalog.now(),
        last_error = 'management_payment_notification_scope_inactive',
        updated_at = pg_catalog.now()
    where id = v_outbox.id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'attempt_id', v_outbox.id,
      'status', 'SUPPRESSED',
      'reason', 'management_payment_notification_scope_inactive'
    );
  end if;

  if v_outbox.status in ('CLAIMED', 'PREPARED')
     and v_outbox.claim_token is distinct from p_claim_token
     and v_outbox.lease_expires_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', v_outbox.id,
      'status', v_outbox.status,
      'notification_kind', v_outbox.notification_kind
    );
  end if;

  update public.management_payment_notification_outbox
  set status = 'CLAIMED',
      claim_token = p_claim_token,
      lease_expires_at = pg_catalog.now()
        + pg_catalog.make_interval(secs => v_lease_seconds),
      configured_destination_snapshot = null,
      provider_destination = null,
      provider_instance_name = null,
      provider_integration_id = null,
      provider_integration_version = null,
      provider_endpoint_hash = null,
      provider_credential_hash = null,
      message_body = null,
      source_snapshot = null,
      source_snapshot_hash = null,
      snapshot_hash = null,
      last_error = null,
      updated_at = pg_catalog.now()
  where id = v_outbox.id
    and submit_attempt_count = 0
  returning * into v_outbox;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'attempt_id', v_outbox.id,
    'claim_token', v_outbox.claim_token,
    'status', v_outbox.status,
    'tenant_id', v_outbox.tenant_id,
    'payment_id', v_outbox.payment_id,
    'notification_kind', v_outbox.notification_kind
  );
end;
$function$;

alter function public.claim_management_payment_notification(
  text,uuid,uuid,integer
) owner to postgres;
revoke all on function public.claim_management_payment_notification(
  text,uuid,uuid,integer
) from public, anon, authenticated;
grant execute on function public.claim_management_payment_notification(
  text,uuid,uuid,integer
) to service_role;

create or replace function public.begin_management_payment_notification_submission(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_expected_destination text,
  p_provider_destination text,
  p_provider_instance_name text,
  p_integration_id uuid,
  p_integration_version bigint,
  p_source_snapshot jsonb,
  p_message_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_outbox public.management_payment_notification_outbox%rowtype;
  v_payment public.student_payments%rowtype;
  v_instance public.whatsapp_instances%rowtype;
  v_connection private.tenant_integration_connections%rowtype;
  v_expected_destination text :=
    private.normalize_management_group_destination(p_expected_destination);
  v_provider_destination text :=
    private.normalize_management_group_destination(p_provider_destination);
  v_current_destination text;
  v_instance_name text := pg_catalog.btrim(
    coalesce(p_provider_instance_name, '')
  );
  v_source_snapshot jsonb := p_source_snapshot;
  v_current_source_snapshot jsonb;
  v_source_snapshot_hash text;
  v_replacement_kind text;
  v_message_body text := coalesce(p_message_body, '');
  v_destination_matches boolean := false;
begin
  if p_attempt_id is null
     or p_claim_token is null
     or v_expected_destination is null
     or v_provider_destination is null
     or pg_catalog.char_length(v_instance_name) not between 3 and 120
     or p_integration_id is null
     or coalesce(p_integration_version, 0) <= 0
     or pg_catalog.jsonb_typeof(v_source_snapshot) <> 'object'
     or pg_catalog.char_length(v_message_body) not between 1 and 8000 then
    raise exception 'invalid_management_payment_notification_submission'
      using errcode = '22023';
  end if;

  select outbox.*
  into v_outbox
  from public.management_payment_notification_outbox as outbox
  where outbox.id = p_attempt_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'claim_lost'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'management-payment-notification:' || v_outbox.tenant_id || ':' ||
        v_outbox.payment_id::text,
      0
    )
  );

  -- Canonical order matches the settlement trigger: financial source first,
  -- then its outbox row. A repeated provider transition cannot deadlock the
  -- final submission fence by holding these rows in the inverse order.
  select payment.*
  into v_payment
  from public.student_payments as payment
  where payment.id = v_outbox.payment_id
    and payment.tenant_id = v_outbox.tenant_id
  for update;

  select outbox.*
  into v_outbox
  from public.management_payment_notification_outbox as outbox
  where outbox.id = p_attempt_id
  for update;

  if not found
     or v_outbox.status <> 'CLAIMED'
     or v_outbox.claim_token is distinct from p_claim_token
     or v_outbox.lease_expires_at <= pg_catalog.now()
     or v_outbox.submit_attempt_count <> 0 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'claim_lost'
    );
  end if;

  v_replacement_kind :=
    private.management_payment_notification_replacement_kind(
      v_outbox.tenant_id,
      v_outbox.payment_id
    );
  if v_replacement_kind is not null
     and v_replacement_kind is distinct from v_outbox.notification_kind then
    update public.management_payment_notification_outbox
    set notification_kind = v_replacement_kind,
        status = 'PENDING',
        claim_token = null,
        lease_expires_at = null,
        configured_destination_snapshot = null,
        provider_destination = null,
        provider_instance_name = null,
        provider_integration_id = null,
        provider_integration_version = null,
        provider_endpoint_hash = null,
        provider_credential_hash = null,
        message_body = null,
        source_snapshot = null,
        source_snapshot_hash = null,
        snapshot_hash = null,
        last_error = 'management_payment_notification_kind_regenerated',
        updated_at = pg_catalog.now()
    where id = v_outbox.id
      and submit_attempt_count = 0;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'RETRY',
      'status', 'PENDING',
      'notification_kind', v_replacement_kind,
      'reason', 'management_payment_notification_kind_regenerated'
    );
  end if;

  if v_payment.id is null
     or not private.management_payment_notification_scope_active(
       v_outbox.tenant_id,
       v_outbox.payment_id,
       v_outbox.notification_kind
     ) then
    update public.management_payment_notification_outbox
    set status = 'SUPPRESSED',
        lease_expires_at = pg_catalog.now(),
        last_error = 'management_payment_scope_changed_before_send',
        updated_at = pg_catalog.now()
    where id = v_outbox.id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'status', 'SUPPRESSED',
      'reason', 'management_payment_scope_changed_before_send'
    );
  end if;

  select private.normalize_management_group_destination(management.destino)
  into v_current_destination
  from public.dre_report_settings as management
  where management.tenant_id = v_outbox.tenant_id
    and management.is_active
  for share;

  if v_current_destination is null
     or v_current_destination is distinct from v_expected_destination then
    update public.management_payment_notification_outbox
    set status = 'SUPPRESSED',
        lease_expires_at = pg_catalog.now(),
        last_error = 'management_destination_changed_before_send',
        updated_at = pg_catalog.now()
    where id = v_outbox.id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'status', 'SUPPRESSED',
      'reason', 'management_destination_changed_before_send'
    );
  end if;

  v_destination_matches := case
    when v_expected_destination like '%@g.us'
      then v_provider_destination = v_expected_destination
    else private.notification_phones_same_recipient(
      v_expected_destination,
      v_provider_destination
    )
  end;
  if not coalesce(v_destination_matches, false) then
    update public.management_payment_notification_outbox
    set status = 'SUPPRESSED',
        lease_expires_at = pg_catalog.now(),
        last_error = 'management_provider_destination_mismatch',
        updated_at = pg_catalog.now()
    where id = v_outbox.id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'status', 'SUPPRESSED',
      'reason', 'management_provider_destination_mismatch'
    );
  end if;

  select instance.*
  into v_instance
  from public.whatsapp_instances as instance
  where instance.tenant_id = v_outbox.tenant_id
    and lower(instance.instance_name) = lower(v_instance_name)
    and lower(pg_catalog.btrim(coalesce(instance.status, ''))) in (
      'connected', 'open'
    )
    and instance.inbox_enabled is true
    and instance.webhook_auth_version = 3
    and instance.integration_id = p_integration_id
    and instance.integration_version = p_integration_version
    and exists (
      select 1
      from public.tenant_memberships as membership
      where membership.tenant_id = instance.tenant_id
        and membership.user_id = instance.user_id
        and membership.role = 'SCHOOL_ADMIN'
        and membership.status = 'ACTIVE'
    )
  for share;

  select connection.*
  into v_connection
  from private.tenant_integration_connections as connection
  where connection.id = p_integration_id
    and connection.tenant_id = v_outbox.tenant_id
    and connection.provider = 'evolution'
    and connection.version = p_integration_version
    and connection.mode <> 'DISABLED'
    and connection.status = 'healthy'
  for share;

  if v_instance.id is null or v_connection.id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'management_provider_binding_changed'
    );
  end if;

  -- Hold the exact active admin authority through the commit that seals the
  -- submission. The instance lookup above validates membership, while this
  -- lock prevents a concurrent revocation from slipping between that lookup
  -- and the immutable snapshot transition.
  perform 1
  from public.tenant_memberships as membership
  where membership.tenant_id = v_instance.tenant_id
    and membership.user_id = v_instance.user_id
    and membership.role = 'SCHOOL_ADMIN'
    and membership.status = 'ACTIVE'
  for share;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'management_provider_authority_changed'
    );
  end if;

  -- This is deliberately the last mutable business-scope read before the
  -- PREPARED snapshot. It catches a settlement reversal,
  -- fixture flag, tenant switch, split toggle or legacy attempt that changed
  -- while the destination/provider binding was being resolved.
  if not private.management_payment_notification_scope_active(
    v_outbox.tenant_id,
    v_outbox.payment_id,
    v_outbox.notification_kind
  ) then
    v_replacement_kind :=
      private.management_payment_notification_replacement_kind(
        v_outbox.tenant_id,
        v_outbox.payment_id
      );
    if v_replacement_kind is not null
       and v_replacement_kind is distinct from v_outbox.notification_kind then
      update public.management_payment_notification_outbox
      set notification_kind = v_replacement_kind,
          status = 'PENDING',
          claim_token = null,
          lease_expires_at = null,
          configured_destination_snapshot = null,
          provider_destination = null,
          provider_instance_name = null,
          provider_integration_id = null,
          provider_integration_version = null,
          provider_endpoint_hash = null,
          provider_credential_hash = null,
          message_body = null,
          source_snapshot = null,
          source_snapshot_hash = null,
          snapshot_hash = null,
          last_error = 'management_payment_notification_kind_regenerated',
          updated_at = pg_catalog.now()
      where id = v_outbox.id
        and submit_attempt_count = 0;
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'RETRY',
        'status', 'PENDING',
        'notification_kind', v_replacement_kind,
        'reason', 'management_payment_notification_kind_regenerated'
      );
    end if;

    update public.management_payment_notification_outbox
    set status = 'SUPPRESSED',
        lease_expires_at = pg_catalog.now(),
        last_error = 'management_payment_scope_changed_at_final_fence',
        updated_at = pg_catalog.now()
    where id = v_outbox.id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'status', 'SUPPRESSED',
      'reason', 'management_payment_scope_changed_at_final_fence'
    );
  end if;

  v_current_source_snapshot :=
    public.management_payment_notification_source_snapshot(
      v_outbox.tenant_id,
      v_outbox.payment_id,
      v_outbox.notification_kind
    );
  if v_current_source_snapshot is null
     or v_current_source_snapshot is distinct from v_source_snapshot then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'management_payment_source_changed_before_send'
    );
  end if;

  v_source_snapshot_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_source_snapshot::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  update public.management_payment_notification_outbox
  set status = 'PREPARED',
      submit_attempt_count = 0,
      configured_destination_snapshot = v_expected_destination,
      provider_destination = v_provider_destination,
      provider_instance_name = v_instance.instance_name,
      provider_integration_id = p_integration_id,
      provider_integration_version = p_integration_version,
      message_body = v_message_body,
      source_snapshot = v_source_snapshot,
      source_snapshot_hash = v_source_snapshot_hash,
      provider_endpoint_hash = null,
      provider_credential_hash = null,
      snapshot_hash = null,
      lease_expires_at = pg_catalog.now() + interval '5 minutes',
      last_error = null,
      updated_at = pg_catalog.now()
  where id = v_outbox.id
    and status = 'CLAIMED'
    and claim_token = p_claim_token
    and lease_expires_at > pg_catalog.now()
    and submit_attempt_count = 0
  returning * into v_outbox;

  if not found then
    raise exception 'management_payment_submission_transition_failed';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'PREPARED',
    'status', v_outbox.status,
    'attempt_id', v_outbox.id,
    'notification_kind', v_outbox.notification_kind,
    'provider_destination', v_outbox.provider_destination,
    'provider_instance_name', v_outbox.provider_instance_name,
    'provider_integration_id', v_outbox.provider_integration_id,
    'provider_integration_version', v_outbox.provider_integration_version,
    'message_body', v_outbox.message_body,
    'source_snapshot_hash', v_outbox.source_snapshot_hash
  );
end;
$function$;

alter function public.begin_management_payment_notification_submission(
  uuid,uuid,text,text,text,uuid,bigint,jsonb,text
) owner to postgres;
revoke all on function public.begin_management_payment_notification_submission(
  uuid,uuid,text,text,text,uuid,bigint,jsonb,text
) from public, anon, authenticated;
grant execute on function public.begin_management_payment_notification_submission(
  uuid,uuid,text,text,text,uuid,bigint,jsonb,text
) to service_role;

create or replace function private.requeue_prepared_management_payment_notification(
  p_attempt_id uuid,
  p_reason text,
  p_notification_kind text default null
)
returns void
language sql
security definer
set search_path = ''
as $function$
  update public.management_payment_notification_outbox as outbox
  set notification_kind = coalesce(p_notification_kind, outbox.notification_kind),
      status = 'PENDING',
      claim_token = null,
      lease_expires_at = null,
      configured_destination_snapshot = null,
      provider_destination = null,
      provider_instance_name = null,
      provider_integration_id = null,
      provider_integration_version = null,
      provider_endpoint_hash = null,
      provider_credential_hash = null,
      message_body = null,
      source_snapshot = null,
      source_snapshot_hash = null,
      snapshot_hash = null,
      last_error = pg_catalog.left(coalesce(p_reason, 'prepared_retry'), 500),
      updated_at = pg_catalog.now()
  where outbox.id = p_attempt_id
    and outbox.status in ('CLAIMED', 'PREPARED')
    and outbox.submit_attempt_count = 0
$function$;

alter function private.requeue_prepared_management_payment_notification(
  uuid,text,text
) owner to postgres;
revoke all on function private.requeue_prepared_management_payment_notification(
  uuid,text,text
) from public, anon, authenticated, service_role;

create or replace function public.authorize_management_payment_notification_submission(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_integration_id uuid,
  p_integration_version bigint,
  p_provider_endpoint_hash text,
  p_provider_credential_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_outbox public.management_payment_notification_outbox%rowtype;
  v_payment public.student_payments%rowtype;
  v_instance public.whatsapp_instances%rowtype;
  v_connection private.tenant_integration_connections%rowtype;
  v_current_destination text;
  v_current_source_snapshot jsonb;
  v_replacement_kind text;
  v_decrypted_api_key text;
  v_expected_endpoint_hash text;
  v_expected_credential_hash text;
  v_snapshot jsonb;
  v_snapshot_hash text;
  v_endpoint_hash text := lower(pg_catalog.btrim(
    coalesce(p_provider_endpoint_hash, '')
  ));
  v_credential_hash text := lower(pg_catalog.btrim(
    coalesce(p_provider_credential_hash, '')
  ));
begin
  if p_attempt_id is null
     or p_claim_token is null
     or p_integration_id is null
     or coalesce(p_integration_version, 0) <= 0
     or v_endpoint_hash !~ '^[0-9a-f]{64}$'
     or v_credential_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_management_payment_provider_snapshot'
      using errcode = '22023';
  end if;

  select outbox.* into v_outbox
  from public.management_payment_notification_outbox as outbox
  where outbox.id = p_attempt_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'prepared_claim_lost'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'management-payment-notification:' || v_outbox.tenant_id || ':' ||
        v_outbox.payment_id::text,
      0
    )
  );

  select payment.* into v_payment
  from public.student_payments as payment
  where payment.id = v_outbox.payment_id
    and payment.tenant_id = v_outbox.tenant_id
  for update;

  select outbox.* into v_outbox
  from public.management_payment_notification_outbox as outbox
  where outbox.id = p_attempt_id
  for update;

  if not found
     or v_outbox.status <> 'PREPARED'
     or v_outbox.claim_token is distinct from p_claim_token
     or v_outbox.lease_expires_at <= pg_catalog.now()
     or v_outbox.submit_attempt_count <> 0 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'prepared_claim_lost'
    );
  end if;

  v_replacement_kind :=
    private.management_payment_notification_replacement_kind(
      v_outbox.tenant_id,
      v_outbox.payment_id
    );
  if v_replacement_kind is not null
     and v_replacement_kind is distinct from v_outbox.notification_kind then
    perform private.requeue_prepared_management_payment_notification(
      v_outbox.id,
      'management_payment_notification_kind_regenerated',
      v_replacement_kind
    );
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'RETRY',
      'status', 'PENDING',
      'notification_kind', v_replacement_kind,
      'reason', 'management_payment_notification_kind_regenerated'
    );
  end if;

  if v_payment.id is null
     or not private.management_payment_notification_scope_active(
       v_outbox.tenant_id,
       v_outbox.payment_id,
       v_outbox.notification_kind
     ) then
    update public.management_payment_notification_outbox
    set status = 'SUPPRESSED',
        lease_expires_at = pg_catalog.now(),
        last_error = 'management_payment_scope_changed_at_provider_fence',
        updated_at = pg_catalog.now()
    where id = v_outbox.id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'status', 'SUPPRESSED',
      'reason', 'management_payment_scope_changed_at_provider_fence'
    );
  end if;

  select private.normalize_management_group_destination(management.destino)
  into v_current_destination
  from public.dre_report_settings as management
  where management.tenant_id = v_outbox.tenant_id
    and management.is_active
  for share;
  if v_current_destination is null
     or v_current_destination is distinct from
       v_outbox.configured_destination_snapshot then
    perform private.requeue_prepared_management_payment_notification(
      v_outbox.id,
      'management_destination_changed_at_provider_fence',
      null
    );
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'management_destination_changed_at_provider_fence'
    );
  end if;

  v_current_source_snapshot :=
    public.management_payment_notification_source_snapshot(
      v_outbox.tenant_id,
      v_outbox.payment_id,
      v_outbox.notification_kind
    );
  if v_current_source_snapshot is null
     or v_current_source_snapshot is distinct from v_outbox.source_snapshot then
    perform private.requeue_prepared_management_payment_notification(
      v_outbox.id,
      'management_payment_source_changed_at_provider_fence',
      null
    );
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'management_payment_source_changed_at_provider_fence'
    );
  end if;

  select instance.* into v_instance
  from public.whatsapp_instances as instance
  where instance.tenant_id = v_outbox.tenant_id
    and lower(instance.instance_name) = lower(v_outbox.provider_instance_name)
    and lower(pg_catalog.btrim(coalesce(instance.status, ''))) in (
      'connected', 'open'
    )
    and instance.inbox_enabled is true
    and instance.webhook_auth_version = 3
    and instance.integration_id = p_integration_id
    and instance.integration_version = p_integration_version
    and exists (
      select 1
      from public.tenant_memberships as membership
      where membership.tenant_id = instance.tenant_id
        and membership.user_id = instance.user_id
        and membership.role = 'SCHOOL_ADMIN'
        and membership.status = 'ACTIVE'
    )
  for share;

  select connection.* into v_connection
  from private.tenant_integration_connections as connection
  where connection.id = p_integration_id
    and connection.id = v_outbox.provider_integration_id
    and connection.tenant_id = v_outbox.tenant_id
    and connection.provider = 'evolution'
    and connection.version = p_integration_version
    and connection.version = v_outbox.provider_integration_version
    and connection.mode <> 'DISABLED'
    and connection.status = 'healthy'
  for share;

  if v_instance.id is null or v_connection.id is null then
    perform private.requeue_prepared_management_payment_notification(
      v_outbox.id,
      'management_provider_binding_changed_at_final_fence',
      null
    );
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'management_provider_binding_changed_at_final_fence'
    );
  end if;

  perform 1
  from public.tenant_memberships as membership
  where membership.tenant_id = v_instance.tenant_id
    and membership.user_id = v_instance.user_id
    and membership.role = 'SCHOOL_ADMIN'
    and membership.status = 'ACTIVE'
  for share;
  if not found then
    perform private.requeue_prepared_management_payment_notification(
      v_outbox.id,
      'management_provider_authority_changed_at_final_fence',
      null
    );
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'management_provider_authority_changed_at_final_fence'
    );
  end if;

  if v_connection.mode = 'TENANT_BYOK' then
    v_expected_endpoint_hash := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.regexp_replace(
            pg_catalog.btrim(v_connection.connection_config ->> 'baseUrl'),
            '/+$',
            '',
            'g'
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );

    select secret.decrypted_secret
    into v_decrypted_api_key
    from private.tenant_secret_registry as registry
    join vault.decrypted_secrets as secret
      on secret.id = registry.vault_secret_id
    where registry.tenant_id = v_outbox.tenant_id
      and registry.provider = 'evolution'
      and registry.status = 'healthy'
      and registry.last_validated_at is not null
    for share of registry;

    if nullif(pg_catalog.btrim(coalesce(v_decrypted_api_key, '')), '') is null then
      perform private.requeue_prepared_management_payment_notification(
        v_outbox.id,
        'management_provider_credential_unavailable_at_final_fence',
        null
      );
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'RETRY',
        'reason', 'management_provider_credential_unavailable_at_final_fence'
      );
    end if;

    v_expected_credential_hash := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(pg_catalog.btrim(v_decrypted_api_key), 'UTF8'),
        'sha256'
      ),
      'hex'
    );

    if v_endpoint_hash is distinct from v_expected_endpoint_hash
       or v_credential_hash is distinct from v_expected_credential_hash then
      perform private.requeue_prepared_management_payment_notification(
        v_outbox.id,
        'management_provider_secret_changed_at_final_fence',
        null
      );
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'RETRY',
        'reason', 'management_provider_secret_changed_at_final_fence'
      );
    end if;
  elsif v_connection.mode <> 'PLATFORM_MANAGED' then
    perform private.requeue_prepared_management_payment_notification(
      v_outbox.id,
      'management_provider_mode_invalid_at_final_fence',
      null
    );
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'management_provider_mode_invalid_at_final_fence'
    );
  end if;

  -- One last fresh scope/source check occurs after every provider and
  -- credential lock. No mutable read is permitted between this RPC response
  -- and the single provider POST.
  if not private.management_payment_notification_scope_active(
       v_outbox.tenant_id,
       v_outbox.payment_id,
       v_outbox.notification_kind
     )
     or public.management_payment_notification_source_snapshot(
       v_outbox.tenant_id,
       v_outbox.payment_id,
       v_outbox.notification_kind
     ) is distinct from v_outbox.source_snapshot then
    perform private.requeue_prepared_management_payment_notification(
      v_outbox.id,
      'management_payment_changed_at_last_provider_fence',
      null
    );
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'management_payment_changed_at_last_provider_fence'
    );
  end if;

  v_snapshot := pg_catalog.jsonb_build_object(
    'tenantId', v_outbox.tenant_id,
    'paymentId', v_outbox.payment_id,
    'notificationKind', v_outbox.notification_kind,
    'paymentStatus', upper(pg_catalog.btrim(coalesce(v_payment.status, ''))),
    'paymentValue', v_payment.value,
    'studentId', v_payment.student_id,
    'configuredDestination', v_outbox.configured_destination_snapshot,
    'providerDestination', v_outbox.provider_destination,
    'providerInstanceName', v_outbox.provider_instance_name,
    'integrationId', p_integration_id,
    'integrationVersion', p_integration_version,
    'providerEndpointHash', v_endpoint_hash,
    'providerCredentialHash', v_credential_hash,
    'sourceSnapshotHash', v_outbox.source_snapshot_hash,
    'sourceSnapshot', v_outbox.source_snapshot,
    'messageBody', v_outbox.message_body
  );
  v_snapshot_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_snapshot::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  update public.management_payment_notification_outbox
  set status = 'SUBMITTING',
      submit_attempt_count = 1,
      provider_endpoint_hash = v_endpoint_hash,
      provider_credential_hash = v_credential_hash,
      snapshot_hash = v_snapshot_hash,
      lease_expires_at = pg_catalog.now() + interval '10 minutes',
      last_error = null,
      updated_at = pg_catalog.now()
  where id = v_outbox.id
    and status = 'PREPARED'
    and claim_token = p_claim_token
    and lease_expires_at > pg_catalog.now()
    and submit_attempt_count = 0
  returning * into v_outbox;

  if not found then
    raise exception 'management_payment_provider_submission_transition_failed';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMITTING',
    'status', v_outbox.status,
    'attempt_id', v_outbox.id,
    'notification_kind', v_outbox.notification_kind,
    'provider_destination', v_outbox.provider_destination,
    'provider_instance_name', v_outbox.provider_instance_name,
    'provider_integration_id', v_outbox.provider_integration_id,
    'provider_integration_version', v_outbox.provider_integration_version,
    'provider_endpoint_hash', v_outbox.provider_endpoint_hash,
    'provider_credential_hash', v_outbox.provider_credential_hash,
    'message_body', v_outbox.message_body,
    'source_snapshot_hash', v_outbox.source_snapshot_hash,
    'snapshot_hash', v_outbox.snapshot_hash
  );
end;
$function$;

alter function public.authorize_management_payment_notification_submission(
  uuid,uuid,uuid,bigint,text,text
) owner to postgres;
revoke all on function public.authorize_management_payment_notification_submission(
  uuid,uuid,uuid,bigint,text,text
) from public, anon, authenticated;
grant execute on function public.authorize_management_payment_notification_submission(
  uuid,uuid,uuid,bigint,text,text
) to service_role;

create or replace function private.apply_management_payment_notification_receipt(
  p_tenant_id text,
  p_provider_instance_name text,
  p_provider_message_id text,
  p_delivery_status text,
  p_accepted_at timestamptz,
  p_delivered_at timestamptz,
  p_read_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text := lower(pg_catalog.btrim(coalesce(p_delivery_status, '')));
  v_outbox public.management_payment_notification_outbox%rowtype;
begin
  if v_status not in (
       'accepted', 'sent', 'delivered', 'read', 'failed', 'uncertain'
     ) then
    return;
  end if;

  update public.management_payment_notification_outbox as outbox
  set provider_delivery_status = v_status,
      status = case
        when v_status in ('delivered', 'read') then 'SENT'
        when v_status = 'failed' then 'FAILED'
        when v_status = 'uncertain' then 'UNKNOWN'
        else outbox.status
      end,
      accepted_at = case
        when p_accepted_at is null then outbox.accepted_at
        else least(coalesce(outbox.accepted_at, p_accepted_at), p_accepted_at)
      end,
      delivered_at = case
        when p_delivered_at is null then outbox.delivered_at
        else least(
          coalesce(outbox.delivered_at, p_delivered_at),
          p_delivered_at
        )
      end,
      read_at = case
        when p_read_at is null then outbox.read_at
        else least(coalesce(outbox.read_at, p_read_at), p_read_at)
      end,
      lease_expires_at = pg_catalog.now(),
      last_error = case
        when v_status in ('sent', 'delivered', 'read') then null
        when v_status = 'failed' then 'provider_reported_failed'
        when v_status = 'uncertain' then 'provider_delivery_uncertain'
        else outbox.last_error
      end,
      updated_at = pg_catalog.now()
  where outbox.tenant_id = p_tenant_id
    and lower(outbox.provider_instance_name) = lower(
      pg_catalog.btrim(coalesce(p_provider_instance_name, ''))
    )
    and outbox.provider_message_id = pg_catalog.btrim(
      coalesce(p_provider_message_id, '')
    )
    and outbox.submit_attempt_count = 1
    and outbox.status in ('SUBMITTING', 'SENT', 'FAILED', 'UNKNOWN')
  returning outbox.* into v_outbox;

  if v_outbox.id is not null
     and v_outbox.status = 'SENT'
     and v_outbox.notification_kind = 'PAYMENT_SPLIT' then
    insert into public.automation_sent (kind, subject_id, ref_date)
    select
      'PAYMENT_SPLIT',
      payment.id::text,
      coalesce(payment.created_at, pg_catalog.now())::date
    from public.student_payments as payment
    where payment.id = v_outbox.payment_id
      and payment.tenant_id = v_outbox.tenant_id
    on conflict (kind, subject_id, ref_date) do nothing;
  end if;
end;
$function$;

alter function private.apply_management_payment_notification_receipt(
  text,text,text,text,timestamptz,timestamptz,timestamptz
) owner to postgres;
revoke all on function private.apply_management_payment_notification_receipt(
  text,text,text,text,timestamptz,timestamptz,timestamptz
) from public, anon, authenticated, service_role;

create or replace function private.bridge_management_payment_notification_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.apply_management_payment_notification_receipt(
    new.tenant_id,
    new.provider_instance_name,
    new.provider_message_id,
    new.delivery_status,
    new.accepted_at,
    new.delivered_at,
    new.read_at
  );
  return new;
end;
$function$;

alter function private.bridge_management_payment_notification_receipt()
  owner to postgres;
revoke all on function private.bridge_management_payment_notification_receipt()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_bridge_management_payment_notification_receipt
  on private.whatsapp_provider_delivery_receipts;
create trigger trg_bridge_management_payment_notification_receipt
after insert or update of
  delivery_status, accepted_at, delivered_at, read_at
on private.whatsapp_provider_delivery_receipts
for each row execute function
  private.bridge_management_payment_notification_receipt();

create or replace function public.finish_management_payment_notification(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_message_id text default null,
  p_provider_http_status integer default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_outbox public.management_payment_notification_outbox%rowtype;
  v_status text := upper(pg_catalog.btrim(coalesce(p_status, '')));
  v_provider_message_id text := nullif(
    pg_catalog.left(
      pg_catalog.btrim(coalesce(p_provider_message_id, '')),
      320
    ),
    ''
  );
  v_error text := nullif(
    pg_catalog.left(pg_catalog.btrim(coalesce(p_error, '')), 500),
    ''
  );
  v_receipt private.whatsapp_provider_delivery_receipts%rowtype;
begin
  if v_status not in ('SENT', 'FAILED', 'UNKNOWN') then
    raise exception 'invalid_management_payment_notification_outcome'
      using errcode = '22023';
  end if;

  select outbox.*
  into v_outbox
  from public.management_payment_notification_outbox as outbox
  where outbox.id = p_attempt_id
  for update;

  if not found or v_outbox.claim_token is distinct from p_claim_token then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'claim_lost'
    );
  end if;
  if v_outbox.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED') then
    return pg_catalog.jsonb_build_object(
      'ok', v_outbox.status = v_status,
      'status', v_outbox.status,
      'provider_delivery_status', v_outbox.provider_delivery_status,
      'ignored_regression', v_outbox.status <> v_status
    );
  end if;
  if v_outbox.status <> 'SUBMITTING'
     or v_outbox.submit_attempt_count <> 1
     or v_outbox.snapshot_hash is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'submit_not_started'
    );
  end if;

  -- A 2xx response without the provider identity cannot ever be correlated to
  -- an Evolution receipt. Keep it terminal UNKNOWN instead of claiming that
  -- the management group received the message.
  if v_status = 'SENT' and v_provider_message_id is null then
    v_status := 'UNKNOWN';
    v_error := 'provider_acceptance_without_message_id';
  end if;

  update public.management_payment_notification_outbox
  set status = case when v_status = 'SENT' then 'SUBMITTING' else v_status end,
      provider_message_id = v_provider_message_id,
      provider_http_status = p_provider_http_status,
      provider_delivery_status = case
        when v_status = 'SENT' then 'accepted'
        when v_status = 'FAILED' then 'failed'
        when v_status = 'UNKNOWN' then 'uncertain'
      end,
      last_error = v_error,
      accepted_at = case
        when v_status = 'SENT' then pg_catalog.now()
        else accepted_at
      end,
      lease_expires_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where id = v_outbox.id
  returning * into v_outbox;

  -- A provider echo may win the race and be stored before the HTTP caller can
  -- persist its message id. Reconcile an already-visible receipt here; later
  -- receipts are bridged by the trigger above.
  if v_provider_message_id is not null then
    select receipt.*
    into v_receipt
    from private.whatsapp_provider_delivery_receipts as receipt
    where receipt.tenant_id = v_outbox.tenant_id
      and lower(receipt.provider_instance_name) = lower(
        v_outbox.provider_instance_name
      )
      and receipt.provider_message_id = v_provider_message_id;

    if found then
      perform private.apply_management_payment_notification_receipt(
        v_receipt.tenant_id,
        v_receipt.provider_instance_name,
        v_receipt.provider_message_id,
        v_receipt.delivery_status,
        v_receipt.accepted_at,
        v_receipt.delivered_at,
        v_receipt.read_at
      );
      select outbox.* into v_outbox
      from public.management_payment_notification_outbox as outbox
      where outbox.id = v_outbox.id;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', v_outbox.status,
    'provider_delivery_status', v_outbox.provider_delivery_status
  );
end;
$function$;

alter function public.finish_management_payment_notification(
  uuid,uuid,text,text,integer,text
) owner to postgres;
revoke all on function public.finish_management_payment_notification(
  uuid,uuid,text,text,integer,text
) from public, anon, authenticated;
grant execute on function public.finish_management_payment_notification(
  uuid,uuid,text,text,integer,text
) to service_role;

create or replace function public.management_payment_notification_attention(
  p_limit integer default 100
)
returns table (
  attempt_id uuid,
  tenant_id text,
  payment_id uuid,
  notification_kind text,
  status text,
  submit_attempt_count integer,
  provider_message_id text,
  provider_delivery_status text,
  updated_at timestamptz,
  last_error text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    outbox.id,
    outbox.tenant_id,
    outbox.payment_id,
    outbox.notification_kind,
    outbox.status,
    outbox.submit_attempt_count,
    outbox.provider_message_id,
    outbox.provider_delivery_status,
    outbox.updated_at,
    outbox.last_error
  from public.management_payment_notification_outbox as outbox
  where outbox.status in ('SUBMITTING', 'FAILED', 'UNKNOWN')
  order by outbox.updated_at, outbox.id
  limit greatest(1, least(coalesce(p_limit, 100), 500))
$function$;

alter function public.management_payment_notification_attention(integer)
  owner to postgres;
revoke all on function public.management_payment_notification_attention(integer)
  from public, anon, authenticated;
grant execute on function public.management_payment_notification_attention(integer)
  to service_role;

-- Retire the service-role entry points that could independently claim or
-- submit the same payment through the pre-outbox split/simple pipelines. The
-- functions remain present for historical inspection and migration tests, but
-- production workers have only the canonical outbox API above. There is no
-- generic historical requeue API: reopening an ambiguous financial message
-- requires an explicit, audited future migration/operation.
revoke execute on function public.payment_split_pending()
  from service_role;
revoke execute on function public.claim_asaas_payment_split_message(
  text,uuid,uuid,integer
) from service_role;
revoke execute on function public.mark_asaas_payment_split_message_submitting(
  uuid,uuid
) from service_role;
revoke execute on function public.finish_asaas_payment_split_message(
  uuid,uuid,text,integer,text
) from service_role;
revoke execute on function public.management_payment_confirmation_pending()
  from service_role;

comment on table public.management_payment_notification_outbox is
  'Transactional outbox and submit-once ledger for settled-payment messages to the tenant management group.';
comment on function public.management_payment_notification_pending(integer) is
  'Unlimited-age sweep of durable pending settlement notifications; terminal or ambiguous attempts are never retried.';
comment on function public.management_payment_notification_attention(integer) is
  'Service-only attention queue for SUBMITTING, FAILED and UNKNOWN management payment deliveries.';

do $postcheck$
declare
  v_trigger_definition text;
  v_pending_definition text;
  v_begin_definition text;
  v_authorize_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.notify_payment_split()'::pg_catalog.regprocedure
  ) into v_trigger_definition;
  select pg_catalog.pg_get_functiondef(
    'public.management_payment_notification_pending(integer)'::pg_catalog.regprocedure
  ) into v_pending_definition;
  select pg_catalog.pg_get_functiondef(
    'public.begin_management_payment_notification_submission(uuid,uuid,text,text,text,uuid,bigint,jsonb,text)'::pg_catalog.regprocedure
  ) into v_begin_definition;
  select pg_catalog.pg_get_functiondef(
    'public.authorize_management_payment_notification_submission(uuid,uuid,uuid,bigint,text,text)'::pg_catalog.regprocedure
  ) into v_authorize_definition;

  if pg_catalog.to_regclass(
       'public.management_payment_notification_outbox'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.claim_management_payment_notification(text,uuid,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.begin_management_payment_notification_submission(uuid,uuid,text,text,text,uuid,bigint,jsonb,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.management_payment_notification_source_snapshot(text,uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.authorize_management_payment_notification_submission(uuid,uuid,uuid,bigint,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finish_management_payment_notification(uuid,uuid,text,text,integer,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.management_payment_notification_attention(integer)'
     ) is null
     or v_trigger_definition not like '%management_payment_notification_outbox%'
     or v_trigger_definition not like '%management_notification_payment_id%'
     or v_pending_definition like '%interval%'
     or v_begin_definition not like '%snapshot_hash%'
     or v_begin_definition not like '%provider_integration_version%'
     or v_begin_definition not like '%notification_phones_same_recipient%'
     or v_begin_definition not like '%inbox_enabled%'
     or v_begin_definition not like '%webhook_auth_version%'
     or v_authorize_definition not like '%provider_endpoint_hash%'
     or v_authorize_definition not like '%provider_credential_hash%'
     or v_authorize_definition not like '%source_snapshot_hash%'
     or v_authorize_definition not like '%snapshot_hash%'
     or v_authorize_definition not like '%inbox_enabled%'
     or v_authorize_definition not like '%webhook_auth_version%'
     or (
       select pg_catalog.count(*)
       from pg_catalog.pg_trigger as trigger
       where trigger.tgrelid = 'public.student_payments'::pg_catalog.regclass
         and not trigger.tgisinternal
         and trigger.tgname in (
           'trg_notify_payment_split',
           'trg_notify_management_payment_confirmation'
         )
     ) <> 1
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.management_payment_notification_outbox',
       'SELECT'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.claim_management_payment_notification(text,uuid,uuid,integer)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.management_payment_notification_pending(integer)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.authorize_management_payment_notification_submission(uuid,uuid,uuid,bigint,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.payment_split_pending()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.claim_asaas_payment_split_message(text,uuid,uuid,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.management_payment_confirmation_pending()',
       'EXECUTE'
     ) then
    raise exception 'management_payment_notification_outbox_contract_invalid';
  end if;
end
$postcheck$;
