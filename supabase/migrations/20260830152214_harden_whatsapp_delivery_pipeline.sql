-- Durable WhatsApp delivery state for the existing notification queue.
--
-- This migration is deliberately additive. Existing producers can continue to
-- insert the legacy columns while the canonical worker adopts the claim and
-- reconciliation RPCs below. A provider call that may have started is never
-- returned blindly to the pending queue.

create schema if not exists private;
revoke all on schema private from public, anon;

alter table public.whatsapp_instances
  add column if not exists webhook_auth_version smallint,
  add column if not exists integration_id uuid,
  add column if not exists integration_version bigint;

-- Bind every pre-existing instance to the exact Evolution broker receipt that
-- currently owns its tenant. Future credential rotations deliberately leave
-- the previous version on the instance until the proxy successfully
-- reconfigures that concrete provider instance.
update public.whatsapp_instances as instance
set integration_id = connection.id,
    integration_version = connection.version
from private.tenant_integration_connections as connection
where connection.tenant_id = instance.tenant_id
  and connection.provider = 'evolution'
  and (
    instance.integration_id is null
    or instance.integration_version is null
  );

do $whatsapp_instance_integration_preflight$
declare
  v_unresolved bigint;
begin
  select count(*)
  into v_unresolved
  from public.whatsapp_instances as instance
  where instance.integration_id is null
    or instance.integration_version is null
    or not exists (
      select 1
      from private.tenant_integration_connections as connection
      where connection.id = instance.integration_id
        and connection.tenant_id = instance.tenant_id
        and connection.provider = 'evolution'
        and connection.version >= instance.integration_version
    );

  if v_unresolved > 0 then
    raise exception 'whatsapp_instance_integration_backfill_unresolved:%',
      v_unresolved;
  end if;
end
$whatsapp_instance_integration_preflight$;

update public.whatsapp_instances
set webhook_auth_version = 1
where webhook_auth_version is null;

alter table public.whatsapp_instances
  alter column webhook_auth_version set default 1,
  alter column webhook_auth_version set not null,
  alter column integration_id set not null,
  alter column integration_version set not null;

do $webhook_auth_version_constraint$
begin
  -- A partially applied predecessor may already have installed the v1/v2
  -- constraint. Rebuild the named check so reruns converge on the v1/v2/v3
  -- contract instead of preserving the narrower definition.
  alter table public.whatsapp_instances
    drop constraint if exists whatsapp_instances_webhook_auth_version_check;
  alter table public.whatsapp_instances
    add constraint whatsapp_instances_webhook_auth_version_check
    check (webhook_auth_version in (1, 2, 3));

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.whatsapp_instances'::pg_catalog.regclass
      and conname = 'whatsapp_instances_integration_version_check'
  ) then
    alter table public.whatsapp_instances
      add constraint whatsapp_instances_integration_version_check
      check (integration_version > 0);
  end if;
end
$webhook_auth_version_constraint$;

create or replace function private.validate_whatsapp_instance_integration_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Compatibility for older instance producers: a missing pair is filled from
  -- the tenant's current broker receipt inside the same INSERT transaction.
  if new.integration_id is null and new.integration_version is null then
    select connection.id, connection.version
    into new.integration_id, new.integration_version
    from private.tenant_integration_connections as connection
    where connection.tenant_id = new.tenant_id
      and connection.provider = 'evolution';
  end if;

  if new.integration_id is null
     or coalesce(new.integration_version, 0) <= 0
     or not exists (
       select 1
       from private.tenant_integration_connections as connection
       where connection.id = new.integration_id
         and connection.tenant_id = new.tenant_id
         and connection.provider = 'evolution'
         and connection.version = new.integration_version
     ) then
    raise exception 'invalid_whatsapp_instance_integration_binding'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

alter function private.validate_whatsapp_instance_integration_binding()
  owner to postgres;
revoke all on function private.validate_whatsapp_instance_integration_binding()
  from public, anon, authenticated, service_role;

drop trigger if exists whatsapp_instances_validate_integration_binding
  on public.whatsapp_instances;
create trigger whatsapp_instances_validate_integration_binding
before insert or update of tenant_id, integration_id, integration_version
on public.whatsapp_instances
for each row execute function
  private.validate_whatsapp_instance_integration_binding();

-- No new browser grant is intentional. The version participates only in the
-- service-side webhook authentication decision.

alter table public.notification_queue
  add column if not exists idempotency_key text,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists provider_instance_name text,
  add column if not exists provider_destination text,
  add column if not exists provider_integration_id uuid,
  add column if not exists provider_integration_version bigint,
  add column if not exists provider_message_id text,
  add column if not exists provider_http_status integer,
  add column if not exists delivery_status text,
  add column if not exists accepted_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists dead_letter_at timestamptz,
  add column if not exists max_attempts integer;

update public.notification_queue
set attempts = coalesce(attempts, 0),
    next_attempt_at = coalesce(next_attempt_at, scheduled_for, now()),
    max_attempts = coalesce(max_attempts, 5),
    delivery_status = coalesce(
      delivery_status,
      case status
        when 'sent' then 'accepted'
        when 'failed' then 'failed'
        when 'skipped' then 'skipped'
        -- A legacy PROCESSING row may already have crossed the provider
        -- boundary. Failing closed prevents a duplicate after deployment.
        when 'processing' then 'uncertain'
        else 'queued'
      end
    ),
    accepted_at = case
      when status = 'sent' then coalesce(accepted_at, updated_at, created_at)
      else accepted_at
    end,
    dead_letter_at = case
      when status = 'processing' then coalesce(dead_letter_at, now())
      else dead_letter_at
    end,
    last_error = case
      when status = 'processing'
        then coalesce(last_error, 'legacy_processing_state_uncertain')
      else last_error
    end,
    status = case when status = 'processing' then 'failed' else status end,
    claim_token = case when status = 'processing' then null else claim_token end,
    lease_expires_at = case
      when status = 'processing' then null else lease_expires_at
    end
where attempts is null
   or next_attempt_at is null
   or max_attempts is null
   or delivery_status is null;

alter table public.notification_queue
  alter column attempts set default 0,
  alter column attempts set not null,
  alter column next_attempt_at set default now(),
  alter column next_attempt_at set not null,
  alter column delivery_status set default 'queued',
  alter column delivery_status set not null,
  alter column max_attempts set default 5,
  alter column max_attempts set not null;

do $notification_delivery_constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.notification_queue'::pg_catalog.regclass
      and conname = 'notification_queue_delivery_status_check'
  ) then
    alter table public.notification_queue
      add constraint notification_queue_delivery_status_check check (
        delivery_status in (
          'queued', 'preparing', 'submitting', 'accepted', 'sent',
          'delivered', 'read', 'failed', 'uncertain', 'skipped'
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.notification_queue'::pg_catalog.regclass
      and conname = 'notification_queue_provider_destination_check'
  ) then
    alter table public.notification_queue
      add constraint notification_queue_provider_destination_check check (
        provider_destination is null
        or (
          (
            provider_destination ~ '^[0-9]{12,15}$'
            or provider_destination ~ '^[0-9]{10,25}@g[.]us$'
          )
          and provider_destination = pg_catalog.btrim(provider_destination)
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.notification_queue'::pg_catalog.regclass
      and conname = 'notification_queue_max_attempts_check'
  ) then
    alter table public.notification_queue
      add constraint notification_queue_max_attempts_check
      check (max_attempts between 1 and 20);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.notification_queue'::pg_catalog.regclass
      and conname = 'notification_queue_provider_http_status_check'
  ) then
    alter table public.notification_queue
      add constraint notification_queue_provider_http_status_check
      check (
        provider_http_status is null
        or provider_http_status between 100 and 599
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.notification_queue'::pg_catalog.regclass
      and conname = 'notification_queue_idempotency_key_check'
  ) then
    alter table public.notification_queue
      add constraint notification_queue_idempotency_key_check check (
        idempotency_key is null
        or (
          char_length(idempotency_key) between 1 and 320
          and idempotency_key = pg_catalog.btrim(idempotency_key)
          and idempotency_key !~ '[[:cntrl:]]'
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.notification_queue'::pg_catalog.regclass
      and conname = 'notification_queue_provider_integration_check'
  ) then
    alter table public.notification_queue
      add constraint notification_queue_provider_integration_check check (
        (
          provider_integration_id is null
          and provider_integration_version is null
        )
        or (
          provider_integration_id is not null
          and provider_integration_version is not null
          and provider_integration_version > 0
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.notification_queue'::pg_catalog.regclass
      and conname = 'notification_queue_provider_identity_check'
  ) then
    alter table public.notification_queue
      add constraint notification_queue_provider_identity_check check (
        (
          provider_message_id is null
          and (
            delivery_status not in ('accepted', 'sent', 'delivered', 'read')
            or status = 'sent'
          )
        )
        or (
          provider_instance_name is not null
          and char_length(provider_instance_name) between 3 and 120
          and provider_instance_name = pg_catalog.btrim(provider_instance_name)
          and provider_instance_name !~ '[[:cntrl:]]'
          and char_length(provider_message_id) between 1 and 320
          and provider_message_id = pg_catalog.btrim(provider_message_id)
          and provider_message_id !~ '[[:cntrl:]]'
        )
      );
  end if;
end
$notification_delivery_constraints$;

create unique index if not exists notification_queue_tenant_idempotency_idx
  on public.notification_queue (tenant_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists notification_queue_delivery_due_idx
  on public.notification_queue (next_attempt_at, scheduled_for, created_at, id)
  where status = 'pending' and delivery_status = 'queued';

create index if not exists notification_queue_delivery_stale_idx
  on public.notification_queue (lease_expires_at, id)
  where status = 'processing'
    and delivery_status in ('preparing', 'submitting');

create index if not exists notification_queue_legacy_processing_stale_idx
  on public.notification_queue (updated_at, id)
  where status = 'processing'
    and delivery_status = 'queued'
    and claim_token is null
    and lease_expires_at is null;

create unique index if not exists notification_queue_provider_receipt_idx
  on public.notification_queue (
    tenant_id,
    lower(provider_instance_name),
    provider_message_id
  )
  where provider_instance_name is not null
    and provider_message_id is not null;

alter table public.asaas_outbound_message_attempts
  add column if not exists notification_queue_id uuid,
  add column if not exists provider_instance_name text,
  add column if not exists provider_destination text,
  add column if not exists provider_message_id text,
  add column if not exists provider_delivery_status text;

do $asaas_outbound_delivery_constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid =
      'public.asaas_outbound_message_attempts'::pg_catalog.regclass
      and conname = 'asaas_outbound_message_attempts_queue_id_fkey'
  ) then
    alter table public.asaas_outbound_message_attempts
      add constraint asaas_outbound_message_attempts_queue_id_fkey
      foreign key (notification_queue_id)
      references public.notification_queue(id)
      on delete set null
      not valid;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid =
      'public.asaas_outbound_message_attempts'::pg_catalog.regclass
      and conname = 'asaas_outbound_message_attempts_provider_instance_check'
  ) then
    alter table public.asaas_outbound_message_attempts
      add constraint asaas_outbound_message_attempts_provider_instance_check
      check (
        provider_instance_name is null
        or (
          char_length(provider_instance_name) between 3 and 120
          and provider_instance_name = pg_catalog.btrim(provider_instance_name)
          and provider_instance_name !~ '[[:cntrl:]]'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid =
      'public.asaas_outbound_message_attempts'::pg_catalog.regclass
      and conname = 'asaas_outbound_message_attempts_destination_check'
  ) then
    alter table public.asaas_outbound_message_attempts
      add constraint asaas_outbound_message_attempts_destination_check check (
        provider_destination is null
        or (
          provider_destination ~ '^[0-9]{12,15}$'
          and provider_destination = pg_catalog.btrim(provider_destination)
        )
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid =
      'public.asaas_outbound_message_attempts'::pg_catalog.regclass
      and conname = 'asaas_outbound_message_attempts_provider_message_check'
  ) then
    alter table public.asaas_outbound_message_attempts
      add constraint asaas_outbound_message_attempts_provider_message_check
      check (
        provider_message_id is null
        or (
          char_length(provider_message_id) between 1 and 320
          and provider_message_id = pg_catalog.btrim(provider_message_id)
          and provider_message_id !~ '[[:cntrl:]]'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid =
      'public.asaas_outbound_message_attempts'::pg_catalog.regclass
      and conname = 'asaas_outbound_message_attempts_delivery_status_check'
  ) then
    alter table public.asaas_outbound_message_attempts
      add constraint asaas_outbound_message_attempts_delivery_status_check
      check (
        provider_delivery_status is null
        or provider_delivery_status in (
          'accepted', 'sent', 'delivered', 'read', 'failed', 'uncertain'
        )
      );
  end if;
end;
$asaas_outbound_delivery_constraints$;

alter table public.asaas_outbound_message_attempts
  validate constraint asaas_outbound_message_attempts_queue_id_fkey;

create unique index if not exists asaas_outbound_message_attempts_queue_uidx
  on public.asaas_outbound_message_attempts (notification_queue_id)
  where notification_queue_id is not null;

create unique index if not exists asaas_outbound_message_attempts_provider_uidx
  on public.asaas_outbound_message_attempts (
    tenant_id,
    lower(provider_instance_name),
    provider_message_id
  )
  where provider_instance_name is not null
    and provider_message_id is not null;

create index if not exists asaas_outbound_message_attempts_student_active_idx
  on public.asaas_outbound_message_attempts (tenant_id, student_id, status)
  where status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN');

create or replace function private.canonical_payment_notification_kind(
  p_notification_kind text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case upper(pg_catalog.btrim(coalesce(p_notification_kind, '')))
    when 'PAYMENT_CONFIRMED' then 'PAYMENT_CONFIRMED_WHATSAPP'
    else upper(pg_catalog.btrim(coalesce(p_notification_kind, '')))
  end
$function$;

revoke all on function private.canonical_payment_notification_kind(text)
  from public, anon, authenticated, service_role;

create or replace function private.normalize_notification_phone(
  p_destination text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_phone text := pg_catalog.regexp_replace(
    coalesce(p_destination, ''),
    '\D',
    '',
    'g'
  );
begin
  if char_length(v_phone) in (10, 11) then
    v_phone := '55' || v_phone;
  end if;

  if char_length(v_phone) not between 12 and 15 then
    return null;
  end if;

  return v_phone;
end;
$function$;

revoke all on function private.normalize_notification_phone(text)
  from public, anon, authenticated, service_role;

create or replace function private.notification_phones_same_recipient(
  p_left text,
  p_right text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when private.normalize_notification_phone(p_left) is null
      or private.normalize_notification_phone(p_right) is null then false
    when private.normalize_notification_phone(p_left) =
      private.normalize_notification_phone(p_right) then true
    else
      pg_catalog.left(
        pg_catalog.right(private.normalize_notification_phone(p_left), 10),
        2
      ) = pg_catalog.left(
        pg_catalog.right(private.normalize_notification_phone(p_right), 10),
        2
      )
      and pg_catalog.right(private.normalize_notification_phone(p_left), 8) =
        pg_catalog.right(private.normalize_notification_phone(p_right), 8)
  end
$function$;

alter function private.notification_phones_same_recipient(text,text)
  owner to postgres;
revoke all on function private.notification_phones_same_recipient(text,text)
  from public, anon, authenticated, service_role;

create or replace function private.merge_notification_delivery_status(
  p_current text,
  p_incoming text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_current text := lower(pg_catalog.btrim(coalesce(p_current, 'queued')));
  v_incoming text := lower(pg_catalog.btrim(coalesce(p_incoming, '')));
  v_current_rank integer;
  v_incoming_rank integer;
begin
  if v_incoming not in (
    'queued', 'preparing', 'submitting', 'accepted', 'sent',
    'delivered', 'read', 'failed', 'uncertain', 'skipped'
  ) then
    raise exception 'invalid_notification_delivery_status'
      using errcode = '22023';
  end if;
  if v_current not in (
    'queued', 'preparing', 'submitting', 'accepted', 'sent',
    'delivered', 'read', 'failed', 'uncertain', 'skipped'
  ) then
    v_current := 'queued';
  end if;

  v_current_rank := case v_current
    when 'accepted' then 40
    when 'sent' then 50
    when 'delivered' then 60
    when 'read' then 70
    else 0
  end;
  v_incoming_rank := case v_incoming
    when 'accepted' then 40
    when 'sent' then 50
    when 'delivered' then 60
    when 'read' then 70
    else 0
  end;

  -- HTTP/provider acceptance is not proof of send or delivery. A definitive
  -- provider failure therefore closes ACCEPTED (and every earlier local state)
  -- as FAILED. SENT/DELIVERED/READ are stronger provider evidence and cannot
  -- be erased by a late, out-of-order failure receipt.
  if v_incoming = 'failed'
     and v_current not in ('sent', 'delivered', 'read') then
    return 'failed';
  end if;
  if v_current = 'failed'
     and v_incoming not in ('sent', 'delivered', 'read') then
    return 'failed';
  end if;

  if v_current_rank > 0 or v_incoming_rank > 0 then
    if v_incoming_rank > v_current_rank then
      return v_incoming;
    end if;
    return v_current;
  end if;

  if v_current = 'failed' then return 'failed'; end if;
  if v_current = 'skipped' then return 'skipped'; end if;
  if v_current = 'uncertain' then
    if v_incoming = 'failed' then return 'failed'; end if;
    return 'uncertain';
  end if;
  if v_incoming in ('failed', 'uncertain', 'skipped') then
    return v_incoming;
  end if;

  return case
    when v_current = 'submitting' or v_incoming = 'submitting'
      then 'submitting'
    when v_current = 'preparing' or v_incoming = 'preparing'
      then 'preparing'
    else 'queued'
  end;
end;
$function$;

revoke all on function private.merge_notification_delivery_status(text,text)
  from public, anon, authenticated;
grant execute on function private.merge_notification_delivery_status(text,text)
  to postgres, supabase_admin, service_role;

create table if not exists private.whatsapp_provider_delivery_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  provider_instance_name text not null,
  provider_message_id text not null,
  notification_id uuid references public.notification_queue(id) on delete set null,
  delivery_status text not null,
  accepted_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_provider_delivery_receipts_status_check check (
    delivery_status in (
      'accepted', 'sent', 'delivered', 'read', 'failed', 'uncertain'
    )
  ),
  constraint whatsapp_provider_delivery_receipts_instance_check check (
    char_length(provider_instance_name) between 3 and 120
    and provider_instance_name = lower(pg_catalog.btrim(provider_instance_name))
    and provider_instance_name !~ '[[:cntrl:]]'
  ),
  constraint whatsapp_provider_delivery_receipts_message_check check (
    char_length(provider_message_id) between 1 and 320
    and provider_message_id = pg_catalog.btrim(provider_message_id)
    and provider_message_id !~ '[[:cntrl:]]'
  ),
  unique (tenant_id, provider_instance_name, provider_message_id)
);

alter table private.whatsapp_provider_delivery_receipts owner to postgres;
revoke all on table private.whatsapp_provider_delivery_receipts
  from public, anon, authenticated, service_role;

create index if not exists whatsapp_provider_delivery_receipts_notification_idx
  on private.whatsapp_provider_delivery_receipts (notification_id)
  where notification_id is not null;

-- Remove the unbound rollout marker explicitly. Keeping both overloads would
-- leave a service-role path capable of promoting an instance without fencing
-- the concrete Evolution integration receipt that was just configured.
drop function if exists public.set_whatsapp_webhook_auth_version(
  text,
  text,
  smallint
);

create or replace function public.set_whatsapp_webhook_auth_version(
  p_tenant_id text,
  p_instance_name text,
  p_version smallint,
  p_integration_id uuid,
  p_integration_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  v_instance_name text := nullif(
    pg_catalog.btrim(coalesce(p_instance_name, '')),
    ''
  );
  v_instance public.whatsapp_instances%rowtype;
begin
  if v_tenant_id is null
     or v_instance_name is null
     or p_version not in (1, 2, 3)
     or p_integration_id is null
     or coalesce(p_integration_version, 0) <= 0 then
    raise exception 'invalid_whatsapp_webhook_auth_version'
      using errcode = '22023';
  end if;

  update public.whatsapp_instances as instance
  set webhook_auth_version = p_version,
      updated_at = now()
  where instance.tenant_id = v_tenant_id
    and lower(instance.instance_name) = lower(v_instance_name)
    and instance.integration_id = p_integration_id
    and instance.integration_version = p_integration_version
    and exists (
      select 1
      from private.tenant_integration_connections as connection
      where connection.id = p_integration_id
        and connection.tenant_id = v_tenant_id
        and connection.provider = 'evolution'
        and connection.version = p_integration_version
    )
  returning instance.* into v_instance;

  if not found then
    if exists (
      select 1
      from public.whatsapp_instances as instance
      where instance.tenant_id = v_tenant_id
        and lower(instance.instance_name) = lower(v_instance_name)
    ) then
      raise exception 'whatsapp_instance_integration_binding_stale'
        using errcode = '55000';
    end if;

    raise exception 'whatsapp_instance_not_found' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'tenantId', v_instance.tenant_id,
    'instanceName', v_instance.instance_name,
    'webhookAuthVersion', v_instance.webhook_auth_version,
    'integrationId', v_instance.integration_id,
    'integrationVersion', v_instance.integration_version
  );
end;
$function$;

alter function public.set_whatsapp_webhook_auth_version(
  text,
  text,
  smallint,
  uuid,
  bigint
)
  owner to postgres;
revoke all on function public.set_whatsapp_webhook_auth_version(
  text,
  text,
  smallint,
  uuid,
  bigint
)
  from public, anon, authenticated, service_role;
grant execute on function public.set_whatsapp_webhook_auth_version(
  text,
  text,
  smallint,
  uuid,
  bigint
)
  to service_role;

create or replace function public.reconcile_whatsapp_provider_delivery(
  p_tenant_id text,
  p_instance_name text,
  p_provider_message_id text,
  p_provider_status text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  v_instance_name text := lower(pg_catalog.btrim(coalesce(p_instance_name, '')));
  v_provider_message_id text := pg_catalog.btrim(
    coalesce(p_provider_message_id, '')
  );
  v_provider_status text := lower(
    pg_catalog.btrim(coalesce(p_provider_status, ''))
  );
  v_occurred_at timestamptz := coalesce(p_occurred_at, now());
  v_notification public.notification_queue%rowtype;
  v_discovered_notification public.notification_queue%rowtype;
  v_receipt private.whatsapp_provider_delivery_receipts%rowtype;
  v_outbound public.asaas_outbound_message_attempts%rowtype;
  v_discovered_outbound public.asaas_outbound_message_attempts%rowtype;
  v_merged text;
  v_outbound_merged text;
  v_financial_scope_locked boolean := false;
begin
  if v_tenant_id is null
     or char_length(v_instance_name) not between 3 and 120
     or char_length(v_provider_message_id) not between 1 and 320
     or v_provider_status not in (
       'accepted', 'sent', 'delivered', 'read', 'failed', 'uncertain'
     )
     or v_occurred_at < timestamptz '2000-01-01 00:00:00+00'
     or v_occurred_at > now() + interval '1 day' then
    raise exception 'invalid_whatsapp_provider_delivery'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.whatsapp_instances as instance
    where instance.tenant_id = v_tenant_id
      and lower(instance.instance_name) = v_instance_name
  ) then
    raise exception 'whatsapp_provider_instance_not_found'
      using errcode = 'P0002';
  end if;

  -- Discover a possible financial fence without taking row locks. When one is
  -- visible, its lifecycle advisory must precede the provider advisory and the
  -- attempt/queue row locks. This is the same global order used by offboarding,
  -- deletion, payment reversal and the paired delivery bridge.
  select notification.*
  into v_discovered_notification
  from public.notification_queue as notification
  where notification.tenant_id = v_tenant_id
    and lower(notification.provider_instance_name) = v_instance_name
    and notification.provider_message_id = v_provider_message_id;

  if found then
    select outbound.*
    into v_discovered_outbound
    from public.asaas_outbound_message_attempts as outbound
    where (
        outbound.notification_queue_id = v_discovered_notification.id
        or (
          outbound.notification_queue_id is null
          and outbound.tenant_id = v_discovered_notification.tenant_id
          and outbound.student_id = v_discovered_notification.student_id
          and outbound.provider_entity_id =
            v_discovered_notification.source_id::text
          and upper(pg_catalog.btrim(coalesce(
            outbound.notification_kind,
            ''
          ))) = 'PAYMENT_CONFIRMED_WHATSAPP'
          and private.canonical_payment_notification_kind(
            v_discovered_notification.notification_kind
          ) = 'PAYMENT_CONFIRMED_WHATSAPP'
        )
      )
    order by (outbound.notification_queue_id =
      v_discovered_notification.id) desc
    limit 1;

    if found then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'student-billing-lifecycle:' || v_discovered_outbound.tenant_id ||
          ':' || v_discovered_outbound.student_id::text,
          0
        )
      );
      v_financial_scope_locked := true;
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'notification-provider:' || v_tenant_id || ':' || v_instance_name || ':' ||
      v_provider_message_id,
      0
    )
  );

  if v_financial_scope_locked then
    select outbound.*
    into v_outbound
    from public.asaas_outbound_message_attempts as outbound
    where outbound.id = v_discovered_outbound.id
    for update;
  end if;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.tenant_id = v_tenant_id
    and lower(notification.provider_instance_name) = v_instance_name
    and notification.provider_message_id = v_provider_message_id
  for update;

  insert into private.whatsapp_provider_delivery_receipts as receipt (
    tenant_id,
    provider_instance_name,
    provider_message_id,
    delivery_status,
    accepted_at,
    sent_at,
    delivered_at,
    read_at,
    first_seen_at,
    last_seen_at
  ) values (
    v_tenant_id,
    v_instance_name,
    v_provider_message_id,
    v_provider_status,
    case when v_provider_status in ('accepted', 'sent', 'delivered', 'read')
      then v_occurred_at end,
    case when v_provider_status in ('sent', 'delivered', 'read')
      then v_occurred_at end,
    case when v_provider_status in ('delivered', 'read')
      then v_occurred_at end,
    case when v_provider_status = 'read' then v_occurred_at end,
    v_occurred_at,
    v_occurred_at
  )
  on conflict (tenant_id, provider_instance_name, provider_message_id)
  do update set
    delivery_status = private.merge_notification_delivery_status(
      receipt.delivery_status,
      excluded.delivery_status
    ),
    accepted_at = case
      when excluded.accepted_at is null then receipt.accepted_at
      else least(coalesce(receipt.accepted_at, excluded.accepted_at), excluded.accepted_at)
    end,
    sent_at = case
      when excluded.sent_at is null then receipt.sent_at
      else least(coalesce(receipt.sent_at, excluded.sent_at), excluded.sent_at)
    end,
    delivered_at = case
      when excluded.delivered_at is null then receipt.delivered_at
      else least(
        coalesce(receipt.delivered_at, excluded.delivered_at),
        excluded.delivered_at
      )
    end,
    read_at = case
      when excluded.read_at is null then receipt.read_at
      else least(coalesce(receipt.read_at, excluded.read_at), excluded.read_at)
    end,
    first_seen_at = least(receipt.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(receipt.last_seen_at, excluded.last_seen_at),
    updated_at = now()
  returning receipt.* into v_receipt;

  if v_notification.id is not null then
    v_merged := private.merge_notification_delivery_status(
      v_notification.delivery_status,
      v_receipt.delivery_status
    );

    update public.notification_queue as notification
    set delivery_status = v_merged,
        status = case
          when v_merged in ('accepted', 'sent', 'delivered', 'read') then 'sent'
          when v_merged in ('failed', 'uncertain') then 'failed'
          else notification.status
        end,
        accepted_at = case
          when v_receipt.accepted_at is null then notification.accepted_at
          else least(
            coalesce(notification.accepted_at, v_receipt.accepted_at),
            v_receipt.accepted_at
          )
        end,
        sent_at = case
          when v_receipt.sent_at is null then notification.sent_at
          else least(
            coalesce(notification.sent_at, v_receipt.sent_at),
            v_receipt.sent_at
          )
        end,
        delivered_at = case
          when v_receipt.delivered_at is null then notification.delivered_at
          else least(
            coalesce(notification.delivered_at, v_receipt.delivered_at),
            v_receipt.delivered_at
          )
        end,
        read_at = case
          when v_receipt.read_at is null then notification.read_at
          else least(
            coalesce(notification.read_at, v_receipt.read_at),
            v_receipt.read_at
          )
        end,
        dead_letter_at = case
          when v_merged in ('failed', 'uncertain')
            then coalesce(notification.dead_letter_at, now())
          when v_merged in ('accepted', 'sent', 'delivered', 'read') then null
          else notification.dead_letter_at
        end,
        last_error = case
          when v_merged in ('accepted', 'sent', 'delivered', 'read') then null
          when v_merged = 'failed' then coalesce(
            notification.last_error,
            'provider_reported_failed'
          )
          when v_merged = 'uncertain' then coalesce(
            notification.last_error,
            'provider_delivery_uncertain'
          )
          else notification.last_error
        end,
        claim_token = null,
        lease_expires_at = null,
        updated_at = now()
    where notification.id = v_notification.id
    returning notification.* into v_notification;

    update private.whatsapp_provider_delivery_receipts as receipt
    set notification_id = coalesce(receipt.notification_id, v_notification.id),
        updated_at = now()
    where receipt.id = v_receipt.id
      and (
        receipt.notification_id is null
        or receipt.notification_id = v_notification.id
      );

    -- If the financial row was visible during discovery it is already locked
    -- in lifecycle -> provider -> attempt -> queue order. Never discover and
    -- lock a new attempt after locking the queue: a concurrent lifecycle
    -- operation uses the opposite order and would deadlock.
    if v_outbound.id is not null then
      if v_outbound.notification_queue_id is not null
         and v_outbound.notification_queue_id <> v_notification.id then
        raise exception 'financial_outbound_queue_identity_mismatch'
          using errcode = '23514';
      end if;

      if v_outbound.tenant_id is distinct from v_notification.tenant_id
         or v_outbound.student_id is distinct from v_notification.student_id
         or v_notification.source_id is null
         or v_outbound.provider_entity_id is distinct from
           v_notification.source_id::text
         or upper(pg_catalog.btrim(coalesce(
           v_notification.source_type,
           ''
         ))) <> 'ASAAS_PAYMENT'
         or upper(pg_catalog.btrim(coalesce(
           v_outbound.notification_kind,
           ''
         ))) <> 'PAYMENT_CONFIRMED_WHATSAPP'
         or private.canonical_payment_notification_kind(
           v_notification.notification_kind
         ) <> 'PAYMENT_CONFIRMED_WHATSAPP' then
        raise exception 'financial_outbound_queue_binding_mismatch'
          using errcode = '23514';
      end if;

      if (
        v_outbound.provider_instance_name is not null
        and lower(v_outbound.provider_instance_name) <> v_instance_name
      ) or (
        v_outbound.provider_message_id is not null
        and v_outbound.provider_message_id <> v_provider_message_id
      ) then
        raise exception 'financial_outbound_provider_identity_mismatch'
          using errcode = '23514';
      end if;

      v_outbound_merged := private.merge_notification_delivery_status(
        coalesce(
          v_outbound.provider_delivery_status,
          case v_outbound.status
            when 'SENT' then 'accepted'
            when 'FAILED' then 'failed'
            when 'UNKNOWN' then 'uncertain'
            else 'queued'
          end
        ),
        v_receipt.delivery_status
      );

      update public.asaas_outbound_message_attempts as outbound
      set notification_queue_id = coalesce(
            outbound.notification_queue_id,
            v_notification.id
          ),
          provider_instance_name = coalesce(
            outbound.provider_instance_name,
            v_notification.provider_instance_name
          ),
          provider_message_id = coalesce(
            outbound.provider_message_id,
            v_provider_message_id
          ),
          provider_delivery_status = v_outbound_merged,
          status = case
            when v_outbound_merged in (
              'accepted', 'sent', 'delivered', 'read'
            ) then 'SENT'
            when v_outbound_merged = 'failed' then 'FAILED'
            when v_outbound_merged = 'uncertain' then 'UNKNOWN'
            else outbound.status
          end,
          submit_attempt_count = case
            when v_outbound_merged in (
              'accepted', 'sent', 'delivered', 'read', 'failed', 'uncertain'
            ) then 1
            else outbound.submit_attempt_count
          end,
          lease_expires_at = now(),
          last_error = case
            when v_outbound_merged in (
              'accepted', 'sent', 'delivered', 'read'
            ) then null
            when v_outbound_merged = 'failed' then coalesce(
              outbound.last_error,
              'provider_reported_failed'
            )
            when v_outbound_merged = 'uncertain' then coalesce(
              outbound.last_error,
              'provider_delivery_uncertain'
            )
            else outbound.last_error
          end,
          updated_at = now()
      where outbound.id = v_outbound.id
        and outbound.status <> 'SUPPRESSED'
      returning outbound.* into v_outbound;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'matched', v_notification.id is not null,
    'notificationId', v_notification.id,
    'financialAttemptId', v_outbound.id,
    'financialStatus', v_outbound.status,
    'providerStatus', v_receipt.delivery_status,
    'providerMessageId', v_receipt.provider_message_id
  );
end;
$function$;

alter function public.reconcile_whatsapp_provider_delivery(
  text,text,text,text,timestamptz
) owner to postgres;
revoke all on function public.reconcile_whatsapp_provider_delivery(
  text,text,text,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.reconcile_whatsapp_provider_delivery(
  text,text,text,text,timestamptz
) to service_role;

create or replace function public.claim_notification_delivery_batch(
  p_limit integer default 50,
  p_lease_seconds integer default 120
)
returns setof public.notification_queue
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_lease_seconds integer := greatest(
    30,
    least(coalesce(p_lease_seconds, 120), 600)
  );
  v_stale_pair record;
  v_stale_outbound public.asaas_outbound_message_attempts%rowtype;
  v_stale_notification public.notification_queue%rowtype;
begin
  -- A crash before SUBMITTING is provably side-effect free. Release the
  -- financial CLAIMED row for a retry, or retain it as SUPPRESSED when the
  -- queue has exhausted its attempts. Both paths use lifecycle -> attempt ->
  -- queue and prevent an expired CLAIMED fence from blocking the student.
  for v_stale_pair in
    select
      notification.id as notification_id,
      outbound.id as outbound_id,
      outbound.tenant_id,
      outbound.student_id
    from public.notification_queue as notification
    join public.asaas_outbound_message_attempts as outbound
      on outbound.notification_queue_id is null
     and outbound.tenant_id = notification.tenant_id
     and outbound.student_id = notification.student_id
     and outbound.provider_entity_id = notification.source_id::text
     and upper(pg_catalog.btrim(coalesce(
       outbound.notification_kind,
       ''
     ))) = 'PAYMENT_CONFIRMED_WHATSAPP'
    where notification.status = 'processing'
      and notification.delivery_status = 'preparing'
      and notification.lease_expires_at <= now()
      and upper(pg_catalog.btrim(coalesce(
        notification.source_type,
        ''
      ))) = 'ASAAS_PAYMENT'
      and private.canonical_payment_notification_kind(
        notification.notification_kind
      ) = 'PAYMENT_CONFIRMED_WHATSAPP'
      and outbound.status = 'CLAIMED'
      and outbound.submit_attempt_count = 0
    order by notification.lease_expires_at, notification.id
    limit 200
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-lifecycle:' || v_stale_pair.tenant_id || ':' ||
        v_stale_pair.student_id::text,
        0
      )
    );

    select outbound.*
    into v_stale_outbound
    from public.asaas_outbound_message_attempts as outbound
    where outbound.id = v_stale_pair.outbound_id
    for update;

    if not found then
      continue;
    end if;

    select notification.*
    into v_stale_notification
    from public.notification_queue as notification
    where notification.id = v_stale_pair.notification_id
    for update;

    if v_stale_outbound.status = 'CLAIMED'
       and v_stale_outbound.submit_attempt_count = 0
       and v_stale_outbound.notification_queue_id is null
       and v_stale_notification.status = 'processing'
       and v_stale_notification.delivery_status = 'preparing'
       and v_stale_notification.lease_expires_at <= now()
       and v_stale_outbound.provider_entity_id =
         v_stale_notification.source_id::text then
      if v_stale_notification.attempts >=
         v_stale_notification.max_attempts then
        update public.asaas_outbound_message_attempts as outbound
        set notification_queue_id = v_stale_notification.id,
            status = 'SUPPRESSED',
            lease_expires_at = now(),
            last_error = 'payment_confirmation_delivery_attempts_exhausted',
            updated_at = now()
        where outbound.id = v_stale_outbound.id;

        update public.notification_queue as notification
        set status = 'failed',
            delivery_status = 'failed',
            dead_letter_at = coalesce(notification.dead_letter_at, now()),
            last_error = 'notification_delivery_attempts_exhausted',
            claim_token = null,
            lease_expires_at = null,
            updated_at = now()
        where notification.id = v_stale_notification.id;
      else
        delete from public.asaas_outbound_message_attempts as outbound
        where outbound.id = v_stale_outbound.id;

        update public.notification_queue as notification
        set status = 'pending',
            delivery_status = 'queued',
            next_attempt_at = now(),
            dead_letter_at = null,
            last_error = 'notification_preparation_lease_expired',
            claim_token = null,
            lease_expires_at = null,
            updated_at = now()
        where notification.id = v_stale_notification.id;
      end if;
    end if;
  end loop;

  -- A paired payment submission must never leave only the queue terminal. Work
  -- through bounded candidates without row locks, then use the canonical
  -- lifecycle -> financial attempt -> queue order and revalidate both states.
  -- This converts a crash after SUBMITTING to UNKNOWN/UNCERTAIN atomically.
  for v_stale_pair in
    select
      notification.id as notification_id,
      outbound.id as outbound_id,
      outbound.tenant_id,
      outbound.student_id
    from public.notification_queue as notification
    join public.asaas_outbound_message_attempts as outbound
      on outbound.notification_queue_id = notification.id
    where notification.status = 'processing'
      and notification.delivery_status = 'submitting'
      and notification.lease_expires_at <= now()
      and outbound.status = 'SUBMITTING'
      and outbound.submit_attempt_count = 1
    order by notification.lease_expires_at, notification.id
    limit 200
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-lifecycle:' || v_stale_pair.tenant_id || ':' ||
        v_stale_pair.student_id::text,
        0
      )
    );

    select outbound.*
    into v_stale_outbound
    from public.asaas_outbound_message_attempts as outbound
    where outbound.id = v_stale_pair.outbound_id
    for update;

    if not found then
      continue;
    end if;

    select notification.*
    into v_stale_notification
    from public.notification_queue as notification
    where notification.id = v_stale_pair.notification_id
    for update;

    if v_stale_outbound.status = 'SUBMITTING'
       and v_stale_outbound.submit_attempt_count = 1
       and v_stale_outbound.notification_queue_id =
         v_stale_notification.id
       and v_stale_notification.status = 'processing'
       and v_stale_notification.delivery_status = 'submitting'
       and v_stale_notification.lease_expires_at <= now() then
      update public.asaas_outbound_message_attempts as outbound
      set status = 'UNKNOWN',
          provider_delivery_status =
            private.merge_notification_delivery_status(
              coalesce(outbound.provider_delivery_status, 'submitting'),
              'uncertain'
            ),
          lease_expires_at = now(),
          last_error = coalesce(
            outbound.last_error,
            'payment_confirmation_submission_lease_expired'
          ),
          updated_at = now()
      where outbound.id = v_stale_outbound.id;

      update public.notification_queue as notification
      set status = 'failed',
          delivery_status = 'uncertain',
          dead_letter_at = coalesce(notification.dead_letter_at, now()),
          last_error = coalesce(
            notification.last_error,
            'notification_submission_lease_expired'
          ),
          claim_token = null,
          lease_expires_at = null,
          updated_at = now()
      where notification.id = v_stale_notification.id;
    end if;
  end loop;

  -- During a rolling cutover, an already-running legacy worker can still set
  -- only STATUS=PROCESSING after this migration lands. It may subsequently
  -- cross the provider boundary without a claim token. Once stale, that state
  -- is ambiguous and must fail closed instead of remaining stuck or retrying.
  update public.notification_queue as notification
  set status = 'failed',
      delivery_status = 'uncertain',
      dead_letter_at = coalesce(notification.dead_letter_at, now()),
      last_error = coalesce(
        notification.last_error,
        'legacy_worker_delivery_state_uncertain'
      ),
      claim_token = null,
      lease_expires_at = null,
      updated_at = now()
  where notification.status = 'processing'
    and notification.delivery_status = 'queued'
    and notification.claim_token is null
    and notification.lease_expires_at is null
    and notification.updated_at <= now() - interval '10 minutes';

  -- A claim that expired before SUBMITTING is safe to retry. At max attempts it
  -- is dead-lettered instead of being claimed forever.
  update public.notification_queue as notification
  set status = case
        when notification.attempts >= notification.max_attempts
          then 'failed'
        else 'pending'
      end,
      delivery_status = case
        when notification.attempts >= notification.max_attempts
          then 'failed'
        else 'queued'
      end,
      next_attempt_at = case
        when notification.attempts >= notification.max_attempts
          then notification.next_attempt_at
        else now()
      end,
      dead_letter_at = case
        when notification.attempts >= notification.max_attempts
          then coalesce(notification.dead_letter_at, now())
        else null
      end,
      last_error = case
        when notification.attempts >= notification.max_attempts
          then 'notification_delivery_attempts_exhausted'
        else 'notification_preparation_lease_expired'
      end,
      claim_token = null,
      lease_expires_at = null,
      updated_at = now()
  where notification.status = 'processing'
    and notification.delivery_status = 'preparing'
    and notification.lease_expires_at <= now()
    and not exists (
      select 1
      from public.asaas_outbound_message_attempts as outbound
      where outbound.notification_queue_id is null
        and outbound.tenant_id = notification.tenant_id
        and outbound.student_id = notification.student_id
        and outbound.provider_entity_id = notification.source_id::text
        and outbound.status = 'CLAIMED'
        and outbound.submit_attempt_count = 0
        and upper(pg_catalog.btrim(coalesce(
          outbound.notification_kind,
          ''
        ))) = 'PAYMENT_CONFIRMED_WHATSAPP'
    );

  -- Once SUBMITTING began, a crash or timeout has an ambiguous side effect.
  -- The row is terminally uncertain and must be reconciled, never blind-retried.
  update public.notification_queue as notification
  set status = 'failed',
      delivery_status = 'uncertain',
      dead_letter_at = coalesce(notification.dead_letter_at, now()),
      last_error = coalesce(
        notification.last_error,
        'notification_submission_lease_expired'
      ),
      claim_token = null,
      lease_expires_at = null,
      updated_at = now()
  where notification.status = 'processing'
    and notification.delivery_status = 'submitting'
    and notification.lease_expires_at <= now()
    and not exists (
      select 1
      from public.asaas_outbound_message_attempts as outbound
      where outbound.notification_queue_id = notification.id
        and outbound.status = 'SUBMITTING'
        and outbound.submit_attempt_count = 1
    );

  update public.notification_queue as notification
  set status = 'failed',
      delivery_status = 'failed',
      dead_letter_at = coalesce(notification.dead_letter_at, now()),
      last_error = coalesce(
        notification.last_error,
        'notification_delivery_attempts_exhausted'
      ),
      claim_token = null,
      lease_expires_at = null,
      updated_at = now()
  where notification.status = 'pending'
    and notification.delivery_status = 'queued'
    and notification.attempts >= notification.max_attempts;

  return query
  with due as (
    select notification.id
    from public.notification_queue as notification
    where notification.status = 'pending'
      and notification.delivery_status = 'queued'
      and notification.attempts < notification.max_attempts
      and notification.scheduled_for <= now()
      and notification.next_attempt_at <= now()
    order by
      notification.next_attempt_at,
      notification.scheduled_for,
      notification.created_at,
      notification.id
    for update skip locked
    limit v_limit
  )
  update public.notification_queue as notification
  set status = 'processing',
      delivery_status = 'preparing',
      attempts = notification.attempts + 1,
      claim_token = gen_random_uuid(),
      lease_expires_at = now() + pg_catalog.make_interval(
        secs => v_lease_seconds
      ),
      last_error = null,
      updated_at = now()
  from due
  where notification.id = due.id
  returning notification.*;
end;
$function$;

alter function public.claim_notification_delivery_batch(integer,integer)
  owner to postgres;
revoke all on function public.claim_notification_delivery_batch(integer,integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_delivery_batch(integer,integer)
  to service_role;

create or replace function public.mark_notification_delivery_submitting(
  p_notification_id uuid,
  p_claim_token uuid,
  p_provider_instance_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.notification_queue%rowtype;
  v_instance_name text := pg_catalog.btrim(
    coalesce(p_provider_instance_name, '')
  );
begin
  if p_notification_id is null
     or p_claim_token is null
     or char_length(v_instance_name) not between 3 and 120 then
    raise exception 'invalid_notification_delivery_submission'
      using errcode = '22023';
  end if;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id
  for update;

  if not found
     or v_notification.claim_token is distinct from p_claim_token
     or v_notification.status <> 'processing'
     or v_notification.delivery_status <> 'preparing' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'notification_delivery_claim_lost'
    );
  end if;

  if v_notification.lease_expires_at <= now() then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'notification_delivery_claim_expired'
    );
  end if;

  select instance.instance_name
  into v_instance_name
  from public.whatsapp_instances as instance
  where instance.tenant_id = v_notification.tenant_id
    and lower(instance.instance_name) = lower(v_instance_name)
    and lower(pg_catalog.btrim(coalesce(instance.status, '')))
      in ('connected', 'open')
  limit 1;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'notification_provider_instance_unavailable'
    );
  end if;

  update public.notification_queue as notification
  set delivery_status = 'submitting',
      provider_instance_name = v_instance_name,
      lease_expires_at = now() + interval '10 minutes',
      updated_at = now()
  where notification.id = v_notification.id
    and notification.claim_token = p_claim_token
    and notification.status = 'processing'
    and notification.delivery_status = 'preparing'
  returning notification.* into v_notification;

  return pg_catalog.jsonb_build_object(
    'ok', found,
    'notificationId', v_notification.id,
    'status', v_notification.status,
    'deliveryStatus', v_notification.delivery_status,
    'providerInstanceName', v_notification.provider_instance_name,
    'leaseExpiresAt', v_notification.lease_expires_at
  );
end;
$function$;

alter function public.mark_notification_delivery_submitting(uuid,uuid,text)
  owner to postgres;
revoke all on function public.mark_notification_delivery_submitting(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.mark_notification_delivery_submitting(uuid,uuid,text)
  to service_role;

create or replace function public.finalize_notification_delivery(
  p_notification_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_message_id text,
  p_provider_http_status integer,
  p_error text,
  p_retry_delay_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.notification_queue%rowtype;
  v_financial_outbound public.asaas_outbound_message_attempts%rowtype;
  v_outcome text := lower(pg_catalog.btrim(coalesce(p_outcome, '')));
  v_provider_message_id text := nullif(
    pg_catalog.btrim(coalesce(p_provider_message_id, '')),
    ''
  );
  v_error text := nullif(
    pg_catalog.left(pg_catalog.btrim(coalesce(p_error, '')), 500),
    ''
  );
  v_retry_delay integer := greatest(
    0,
    least(coalesce(p_retry_delay_seconds, 0), 86400)
  );
  v_reconcile jsonb;
  v_was_preparing boolean := false;
begin
  if p_notification_id is null
     or p_claim_token is null
     or v_outcome not in (
       'accepted', 'sent', 'delivered', 'read',
       'failed', 'uncertain', 'skipped'
     )
     or (
       p_provider_http_status is not null
       and p_provider_http_status not between 100 and 599
     )
     or (
       v_provider_message_id is not null
       and char_length(v_provider_message_id) > 320
     ) then
    raise exception 'invalid_notification_delivery_result'
      using errcode = '22023';
  end if;

  -- The unlocked read only discovers immutable lock scope. Payment delivery
  -- uses lifecycle -> provider -> financial attempt -> queue; all predicates
  -- are checked again after those locks are held.
  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id;

  if found
     and private.canonical_payment_notification_kind(
       v_notification.notification_kind
     ) = 'PAYMENT_CONFIRMED_WHATSAPP'
     and upper(pg_catalog.btrim(coalesce(
       v_notification.source_type,
       ''
     ))) = 'ASAAS_PAYMENT' then
    select outbound.*
    into v_financial_outbound
    from public.asaas_outbound_message_attempts as outbound
    where outbound.notification_queue_id = v_notification.id
       or (
         outbound.notification_queue_id is null
         and outbound.tenant_id = v_notification.tenant_id
         and outbound.student_id = v_notification.student_id
         and outbound.provider_entity_id = v_notification.source_id::text
         and upper(pg_catalog.btrim(coalesce(
           outbound.notification_kind,
           ''
         ))) = 'PAYMENT_CONFIRMED_WHATSAPP'
       )
    order by (outbound.notification_queue_id = v_notification.id) desc
    limit 1;

    if found then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'student-billing-lifecycle:' || v_financial_outbound.tenant_id ||
          ':' || v_financial_outbound.student_id::text,
          0
        )
      );
    end if;
  end if;

  if v_notification.id is not null
     and v_provider_message_id is not null
     and v_notification.provider_instance_name is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'notification-provider:' || v_notification.tenant_id || ':' ||
        lower(v_notification.provider_instance_name) || ':' ||
        v_provider_message_id,
        0
      )
    );
  end if;

  if v_financial_outbound.id is not null then
    select outbound.*
    into v_financial_outbound
    from public.asaas_outbound_message_attempts as outbound
    where outbound.id = v_financial_outbound.id
    for update;
  end if;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id
  for update;

  if not found
     or v_notification.claim_token is distinct from p_claim_token
     or v_notification.status <> 'processing'
     or v_notification.delivery_status not in ('preparing', 'submitting') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'notification_delivery_claim_lost'
    );
  end if;

  v_was_preparing := v_notification.delivery_status = 'preparing';

  if v_outcome in ('accepted', 'sent', 'delivered', 'read') then
    if v_notification.delivery_status <> 'submitting'
       or v_notification.provider_instance_name is null
       or v_provider_message_id is null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'provider_identity_required_after_submission'
      );
    end if;

    update public.notification_queue as notification
    set status = 'sent',
        delivery_status = private.merge_notification_delivery_status(
          notification.delivery_status,
          v_outcome
        ),
        provider_message_id = coalesce(
          notification.provider_message_id,
          v_provider_message_id
        ),
        provider_http_status = p_provider_http_status,
        accepted_at = coalesce(notification.accepted_at, now()),
        sent_at = case
          when v_outcome in ('sent', 'delivered', 'read')
            then coalesce(notification.sent_at, now())
          else notification.sent_at
        end,
        delivered_at = case
          when v_outcome in ('delivered', 'read')
            then coalesce(notification.delivered_at, now())
          else notification.delivered_at
        end,
        read_at = case
          when v_outcome = 'read' then coalesce(notification.read_at, now())
          else notification.read_at
        end,
        dead_letter_at = null,
        last_error = null,
        claim_token = null,
        lease_expires_at = null,
        updated_at = now()
    where notification.id = v_notification.id
      and (
        notification.provider_message_id is null
        or notification.provider_message_id = v_provider_message_id
      )
    returning notification.* into v_notification;

    if not found then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'provider_message_id_conflict'
      );
    end if;

    v_reconcile := public.reconcile_whatsapp_provider_delivery(
      v_notification.tenant_id,
      v_notification.provider_instance_name,
      v_provider_message_id,
      v_outcome,
      now()
    );

    select notification.*
    into strict v_notification
    from public.notification_queue as notification
    where notification.id = p_notification_id;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'FINALIZED',
      'notificationId', v_notification.id,
      'status', v_notification.status,
      'deliveryStatus', v_notification.delivery_status,
      'providerMessageId', v_notification.provider_message_id,
      'reconciled', coalesce((v_reconcile ->> 'ok')::boolean, false)
    );
  end if;

  if v_outcome = 'failed'
     and v_retry_delay > 0
     and v_notification.delivery_status = 'preparing'
     and v_notification.attempts < v_notification.max_attempts then
    update public.notification_queue as notification
    set status = 'pending',
        delivery_status = 'queued',
        next_attempt_at = now() + pg_catalog.make_interval(
          secs => v_retry_delay
        ),
        provider_message_id = null,
        provider_http_status = p_provider_http_status,
        accepted_at = null,
        sent_at = null,
        delivered_at = null,
        read_at = null,
        dead_letter_at = null,
        last_error = coalesce(v_error, 'notification_delivery_retry_scheduled'),
        claim_token = null,
        lease_expires_at = null,
        updated_at = now()
    where notification.id = v_notification.id
    returning notification.* into v_notification;

    -- No provider boundary was crossed. Release the financial CLAIMED fence so
    -- a later queue retry can acquire a fresh submit-once claim and lifecycle
    -- operations are not blocked by an expired operational lease forever.
    if v_financial_outbound.id is not null then
      delete from public.asaas_outbound_message_attempts as outbound
      where outbound.id = v_financial_outbound.id
        and outbound.status = 'CLAIMED'
        and outbound.submit_attempt_count = 0
        and outbound.notification_queue_id is null
        and outbound.tenant_id = v_notification.tenant_id
        and outbound.student_id = v_notification.student_id
        and outbound.provider_entity_id = v_notification.source_id::text
        and upper(pg_catalog.btrim(coalesce(
          outbound.notification_kind,
          ''
        ))) = 'PAYMENT_CONFIRMED_WHATSAPP';
    end if;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'RETRY_SCHEDULED',
      'notificationId', v_notification.id,
      'status', v_notification.status,
      'deliveryStatus', v_notification.delivery_status,
      'nextAttemptAt', v_notification.next_attempt_at
    );
  end if;

  update public.notification_queue as notification
  set status = case when v_outcome = 'skipped' then 'skipped' else 'failed' end,
      delivery_status = case
        when v_outcome = 'skipped' then 'skipped'
        when v_outcome = 'uncertain' then 'uncertain'
        else 'failed'
      end,
      provider_message_id = coalesce(
        notification.provider_message_id,
        v_provider_message_id
      ),
      provider_http_status = p_provider_http_status,
      dead_letter_at = case
        when v_outcome = 'skipped' then null
        else coalesce(notification.dead_letter_at, now())
      end,
      last_error = coalesce(
        v_error,
        case
          when v_outcome = 'uncertain' then 'notification_delivery_uncertain'
          when v_outcome = 'skipped' then 'notification_delivery_skipped'
          when notification.attempts >= notification.max_attempts
            then 'notification_delivery_attempts_exhausted'
          else 'notification_delivery_failed'
        end
      ),
      claim_token = null,
      lease_expires_at = null,
      updated_at = now()
  where notification.id = v_notification.id
  returning notification.* into v_notification;

  -- Exhaustion before POST is definitive and safe to suppress. Retaining the
  -- terminal identity prevents a later producer from sending the same payment
  -- confirmation through a new queue row.
  if v_was_preparing
     and v_outcome = 'failed'
     and v_financial_outbound.id is not null then
    update public.asaas_outbound_message_attempts as outbound
    set notification_queue_id = v_notification.id,
        status = 'SUPPRESSED',
        lease_expires_at = now(),
        last_error = coalesce(
          v_error,
          'payment_confirmation_delivery_attempts_exhausted'
        ),
        updated_at = now()
    where outbound.id = v_financial_outbound.id
      and outbound.status = 'CLAIMED'
      and outbound.submit_attempt_count = 0
      and outbound.tenant_id = v_notification.tenant_id
      and outbound.student_id = v_notification.student_id
      and outbound.provider_entity_id = v_notification.source_id::text
      and upper(pg_catalog.btrim(coalesce(
        outbound.notification_kind,
        ''
      ))) = 'PAYMENT_CONFIRMED_WHATSAPP';
  end if;

  if v_provider_message_id is not null
     and v_notification.provider_instance_name is not null
     and v_outcome in ('failed', 'uncertain') then
    perform public.reconcile_whatsapp_provider_delivery(
      v_notification.tenant_id,
      v_notification.provider_instance_name,
      v_provider_message_id,
      v_outcome,
      now()
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'TERMINAL',
    'notificationId', v_notification.id,
    'status', v_notification.status,
    'deliveryStatus', v_notification.delivery_status,
    'deadLetterAt', v_notification.dead_letter_at
  );
end;
$function$;

alter function public.finalize_notification_delivery(
  uuid,uuid,text,text,integer,text,integer
) owner to postgres;
revoke all on function public.finalize_notification_delivery(
  uuid,uuid,text,text,integer,text,integer
) from public, anon, authenticated;
grant execute on function public.finalize_notification_delivery(
  uuid,uuid,text,text,integer,text,integer
) to service_role;

-- Payment confirmations are fenced twice: the generic notification queue and
-- the financial submit-once ledger. Crossing the provider boundary in two
-- independent RPCs permits a half-commit, so this bridge owns both transitions
-- in one transaction.
drop function if exists public.begin_payment_confirmation_delivery_submission(
  uuid,uuid,uuid,uuid,text,text,uuid,bigint
);

create or replace function public.begin_payment_confirmation_delivery_submission(
  p_notification_id uuid,
  p_notification_claim_token uuid,
  p_outbound_attempt_id uuid,
  p_outbound_claim_token uuid,
  p_provider_instance_name text,
  p_expected_destination text,
  p_provider_destination text,
  p_integration_id uuid,
  p_integration_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.notification_queue%rowtype;
  v_outbound public.asaas_outbound_message_attempts%rowtype;
  v_profile public.profiles%rowtype;
  v_instance public.whatsapp_instances%rowtype;
  v_connection private.tenant_integration_connections%rowtype;
  v_instance_name text := pg_catalog.btrim(
    coalesce(p_provider_instance_name, '')
  );
  v_expected_destination text := private.normalize_notification_phone(
    p_expected_destination
  );
  v_provider_destination text := private.normalize_notification_phone(
    p_provider_destination
  );
  v_current_destination text;
  v_payment_status text;
  v_tenant_whatsapp_enabled boolean := false;
  v_student_notifications_enabled boolean := false;
  v_lifecycle_blocked boolean := false;
  v_suppression_reason text;
  v_queue_result jsonb;
begin
  if p_notification_id is null
     or p_notification_claim_token is null
     or p_outbound_attempt_id is null
     or p_outbound_claim_token is null
     or char_length(v_instance_name) not between 3 and 120
     or v_expected_destination is null
     or v_provider_destination is null
     or not private.notification_phones_same_recipient(
       v_expected_destination,
       v_provider_destination
     )
     or p_integration_id is null
     or coalesce(p_integration_version, 0) <= 0 then
    raise exception 'invalid_payment_confirmation_submission'
      using errcode = '22023';
  end if;

  -- Unlocked discovery only supplies the immutable advisory-lock scope. Every
  -- predicate is checked again after the advisory and row locks are held.
  select outbound.*
  into v_outbound
  from public.asaas_outbound_message_attempts as outbound
  where outbound.id = p_outbound_attempt_id;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id;

  if v_outbound.id is null or v_notification.id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'claim_lost'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || v_outbound.tenant_id || ':' ||
      v_outbound.student_id::text,
      0
    )
  );

  -- Canonical lock order for this bridge: student advisory, financial row,
  -- queue row, then the mutable source/profile/configuration rows.
  select outbound.*
  into v_outbound
  from public.asaas_outbound_message_attempts as outbound
  where outbound.id = p_outbound_attempt_id
  for update;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id
  for update;

  -- Idempotent replay after a committed begin whose HTTP response was lost.
  -- Only the exact paired claim and immutable provider snapshot are allowed to
  -- receive authorization again.
  if v_outbound.id is not null
     and v_notification.id is not null
     and v_outbound.status = 'SUBMITTING'
     and v_outbound.submit_attempt_count = 1
     and v_outbound.lease_expires_at > now()
     and v_outbound.claim_token = p_outbound_claim_token
     and v_outbound.notification_queue_id = v_notification.id
     and v_notification.status = 'processing'
     and v_notification.delivery_status = 'submitting'
     and v_notification.lease_expires_at > now()
     and v_notification.claim_token = p_notification_claim_token
     and lower(coalesce(v_outbound.provider_instance_name, '')) =
       lower(v_instance_name)
     and lower(coalesce(v_notification.provider_instance_name, '')) =
       lower(v_instance_name)
     and v_outbound.provider_destination = v_provider_destination
     and v_notification.provider_destination = v_provider_destination
     and v_notification.provider_integration_id = p_integration_id
     and v_notification.provider_integration_version = p_integration_version
     and private.normalize_notification_phone(v_notification.student_phone) =
       v_expected_destination then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'SUBMITTING',
      'status', v_notification.status,
      'deliveryStatus', v_notification.delivery_status,
      'financialStatus', v_outbound.status,
      'notificationId', v_notification.id,
      'outboundAttemptId', v_outbound.id,
      'providerInstanceName', v_notification.provider_instance_name,
      'providerDestination', v_notification.provider_destination,
      'messageBody', v_notification.message_body,
      'integrationId', v_notification.provider_integration_id,
      'integrationVersion', v_notification.provider_integration_version
    );
  end if;

  if v_outbound.id is null
     or v_notification.id is null
     or v_outbound.status <> 'CLAIMED'
     or v_outbound.claim_token is distinct from p_outbound_claim_token
     or v_outbound.lease_expires_at <= now()
     or v_outbound.submit_attempt_count <> 0
     or v_notification.status <> 'processing'
     or v_notification.delivery_status <> 'preparing'
     or v_notification.claim_token is distinct from
       p_notification_claim_token
     or v_notification.lease_expires_at <= now() then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'claim_lost'
    );
  end if;

  if v_notification.tenant_id is distinct from v_outbound.tenant_id
     or v_notification.student_id is distinct from v_outbound.student_id
     or v_notification.source_id is null
     or v_notification.source_id::text is distinct from
       pg_catalog.btrim(v_outbound.provider_entity_id)
     or upper(pg_catalog.btrim(coalesce(
       v_notification.source_type,
       ''
     ))) <> 'ASAAS_PAYMENT'
     or private.canonical_payment_notification_kind(
       v_notification.notification_kind
     ) <> 'PAYMENT_CONFIRMED_WHATSAPP'
     or upper(pg_catalog.btrim(coalesce(
       v_outbound.notification_kind,
       ''
     ))) <> 'PAYMENT_CONFIRMED_WHATSAPP'
     or (
       v_outbound.notification_queue_id is not null
       and v_outbound.notification_queue_id <> v_notification.id
     )
     or (
       v_outbound.provider_instance_name is not null
       and lower(v_outbound.provider_instance_name) <>
         lower(v_instance_name)
     )
     or v_outbound.provider_message_id is not null
     or v_notification.provider_message_id is not null
     or (
       v_notification.provider_instance_name is not null
       and lower(v_notification.provider_instance_name) <>
         lower(v_instance_name)
     )
     or (
       v_notification.provider_destination is not null
       and v_notification.provider_destination <> v_provider_destination
     )
     or (
       v_outbound.provider_destination is not null
       and v_outbound.provider_destination <> v_provider_destination
     )
     or (
       v_notification.provider_integration_id is not null
       and v_notification.provider_integration_id <> p_integration_id
     )
     or (
       v_notification.provider_integration_version is not null
       and v_notification.provider_integration_version <>
         p_integration_version
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'payment_confirmation_binding_mismatch'
    );
  end if;

  select profile.*
  into v_profile
  from public.profiles as profile
  where profile.id = v_outbound.student_id
    and profile.tenant_id = v_outbound.tenant_id
  for update;

  if found then
    v_current_destination := private.normalize_notification_phone(
      case
        when v_profile.guardian_id is not null
          or nullif(pg_catalog.btrim(coalesce(v_profile.guardian_cpf, '')), '')
            is not null
          then v_profile.guardian_phone
        else v_profile.phone
      end
    );
  end if;

  v_lifecycle_blocked := v_profile.id is null
    or v_profile.role is distinct from 'STUDENT'
    or coalesce(v_profile.is_test_account, false)
    or lower(pg_catalog.btrim(coalesce(v_profile.lifecycle_status, ''))) <>
      'active'
    or (
      select count(*)
      from public.tenant_memberships as membership
      where membership.user_id = v_outbound.student_id
    ) <> 1
    or not exists (
      select 1
      from public.tenant_memberships as membership
      where membership.user_id = v_outbound.student_id
        and membership.tenant_id = v_outbound.tenant_id
        and membership.role = 'STUDENT'
        and membership.status = 'ACTIVE'
    )
    or exists (
      select 1
      from public.student_offboarding_operations as operation
      where operation.tenant_id = v_outbound.tenant_id
        and operation.student_id = v_outbound.student_id
        and operation.status in (
          'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
          'UNKNOWN', 'BLOCKED'
        )
    )
    or exists (
      select 1
      from public.student_account_deletion_claims as deletion
      where deletion.tenant_id = v_outbound.tenant_id
        and deletion.student_id = v_outbound.student_id
        and deletion.status in (
          'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
          'UNKNOWN', 'BLOCKED'
        )
    );

  select upper(pg_catalog.btrim(coalesce(payment.status, '')))
  into v_payment_status
  from public.student_payments as payment
  where payment.id::text = v_outbound.provider_entity_id
    and payment.tenant_id = v_outbound.tenant_id
    and payment.student_id = v_outbound.student_id
  for update;

  if not found then
    v_payment_status := null;
  end if;

  select coalesce(tenant.whatsapp_enabled, false)
  into v_tenant_whatsapp_enabled
  from public.tenants as tenant
  where tenant.id = v_outbound.tenant_id
  for share;

  select coalesce(settings.student_notifications_enabled, false)
  into v_student_notifications_enabled
  from public.tenant_admin_settings as settings
  where settings.tenant_id = v_outbound.tenant_id
  for share;

  select instance.*
  into v_instance
  from public.whatsapp_instances as instance
  where instance.tenant_id = v_outbound.tenant_id
    and lower(instance.instance_name) = lower(v_instance_name)
  for share;

  select connection.*
  into v_connection
  from private.tenant_integration_connections as connection
  where connection.id = p_integration_id
    and connection.tenant_id = v_outbound.tenant_id
    and connection.provider = 'evolution'
  for share;

  if v_instance.id is null
     or lower(pg_catalog.btrim(coalesce(v_instance.status, ''))) not in (
       'connected', 'open'
     )
     or v_instance.integration_id is distinct from p_integration_id
     or v_instance.integration_version is distinct from
       p_integration_version
     or v_connection.id is null
     or v_connection.version is distinct from p_integration_version
     or v_connection.mode = 'DISABLED'
     or v_connection.status <> 'healthy' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'payment_confirmation_provider_binding_changed'
    );
  end if;

  v_suppression_reason := case
    when v_lifecycle_blocked then 'student_lifecycle_inactive_before_send'
    when private.normalize_notification_phone(v_notification.student_phone)
      is distinct from v_expected_destination
      or v_current_destination is distinct from v_expected_destination
      then 'payment_confirmation_destination_changed'
    when coalesce(v_payment_status, '') not in (
      'RECEIVED', 'RECEIVED_IN_CASH', 'PAGO'
    )
      then 'payment_state_changed_before_notification_send'
    when not coalesce(v_tenant_whatsapp_enabled, false)
      or not coalesce(v_student_notifications_enabled, false)
      then 'student_notifications_disabled_before_send'
    else null
  end;

  if v_suppression_reason is not null then
    v_queue_result := public.finalize_notification_delivery(
      v_notification.id,
      p_notification_claim_token,
      'skipped',
      null,
      null,
      v_suppression_reason,
      0
    );

    if coalesce((v_queue_result ->> 'ok')::boolean, false) is not true then
      raise exception 'payment_confirmation_queue_suppression_failed';
    end if;

    update public.asaas_outbound_message_attempts as outbound
    set notification_queue_id = v_notification.id,
        status = 'SUPPRESSED',
        lease_expires_at = now(),
        last_error = v_suppression_reason,
        updated_at = now()
    where outbound.id = v_outbound.id
      and outbound.status = 'CLAIMED'
      and outbound.claim_token = p_outbound_claim_token
      and outbound.submit_attempt_count = 0
    returning outbound.* into v_outbound;

    if not found then
      raise exception 'payment_confirmation_ledger_suppression_failed';
    end if;

    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'reason', v_suppression_reason,
      'status', v_outbound.status,
      'notificationStatus', v_queue_result ->> 'status'
    );
  end if;

  update public.asaas_outbound_message_attempts as outbound
  set notification_queue_id = v_notification.id,
      provider_instance_name = v_instance.instance_name,
      provider_destination = v_provider_destination,
      status = 'SUBMITTING',
      submit_attempt_count = 1,
      lease_expires_at = now() + interval '10 minutes',
      last_error = null,
      updated_at = now()
  where outbound.id = v_outbound.id
    and outbound.status = 'CLAIMED'
    and outbound.claim_token = p_outbound_claim_token
    and outbound.lease_expires_at > now()
    and outbound.submit_attempt_count = 0
  returning outbound.* into v_outbound;

  if not found then
    raise exception 'payment_confirmation_outbound_transition_failed';
  end if;

  update public.notification_queue as notification
  set delivery_status = 'submitting',
      provider_instance_name = v_instance.instance_name,
      provider_destination = v_provider_destination,
      provider_integration_id = p_integration_id,
      provider_integration_version = p_integration_version,
      lease_expires_at = now() + interval '10 minutes',
      last_error = null,
      updated_at = now()
  where notification.id = v_notification.id
    and notification.status = 'processing'
    and notification.delivery_status = 'preparing'
    and notification.claim_token = p_notification_claim_token
    and notification.lease_expires_at > now()
  returning notification.* into v_notification;

  if not found then
    raise exception 'payment_confirmation_queue_transition_failed';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMITTING',
    'status', v_notification.status,
    'deliveryStatus', v_notification.delivery_status,
    'financialStatus', v_outbound.status,
    'notificationId', v_notification.id,
    'outboundAttemptId', v_outbound.id,
    'providerInstanceName', v_notification.provider_instance_name,
    'providerDestination', v_notification.provider_destination,
    'messageBody', v_notification.message_body,
    'integrationId', v_notification.provider_integration_id,
    'integrationVersion', v_notification.provider_integration_version
  );
end;
$function$;

alter function public.begin_payment_confirmation_delivery_submission(
  uuid,uuid,uuid,uuid,text,text,text,uuid,bigint
) owner to postgres;
revoke all on function public.begin_payment_confirmation_delivery_submission(
  uuid,uuid,uuid,uuid,text,text,text,uuid,bigint
) from public, anon, authenticated, service_role;
grant execute on function public.begin_payment_confirmation_delivery_submission(
  uuid,uuid,uuid,uuid,text,text,text,uuid,bigint
) to service_role;

create or replace function public.finalize_payment_confirmation_delivery(
  p_notification_id uuid,
  p_notification_claim_token uuid,
  p_outbound_attempt_id uuid,
  p_outbound_claim_token uuid,
  p_outcome text,
  p_provider_message_id text,
  p_provider_http_status integer,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.notification_queue%rowtype;
  v_outbound public.asaas_outbound_message_attempts%rowtype;
  v_outcome text := lower(pg_catalog.btrim(coalesce(p_outcome, '')));
  v_provider_message_id text := nullif(
    pg_catalog.btrim(coalesce(p_provider_message_id, '')),
    ''
  );
  v_error text := nullif(
    pg_catalog.left(pg_catalog.btrim(coalesce(p_error, '')), 500),
    ''
  );
  v_financial_status text;
  v_queue_result jsonb;
begin
  if p_notification_id is null
     or p_notification_claim_token is null
     or p_outbound_attempt_id is null
     or p_outbound_claim_token is null
     or v_outcome not in (
       'accepted', 'sent', 'delivered', 'read', 'failed', 'uncertain'
     )
     or (
       p_provider_http_status is not null
       and p_provider_http_status not between 100 and 599
     )
     or (
       v_provider_message_id is not null
       and char_length(v_provider_message_id) > 320
     ) then
    raise exception 'invalid_payment_confirmation_delivery_result'
      using errcode = '22023';
  end if;

  select outbound.*
  into v_outbound
  from public.asaas_outbound_message_attempts as outbound
  where outbound.id = p_outbound_attempt_id;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id;

  if v_outbound.id is null or v_notification.id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'claim_lost'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || v_outbound.tenant_id || ':' ||
      v_outbound.student_id::text,
      0
    )
  );

  if v_provider_message_id is not null
     and v_outbound.provider_instance_name is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'notification-provider:' || v_outbound.tenant_id || ':' ||
        lower(v_outbound.provider_instance_name) || ':' ||
        v_provider_message_id,
        0
      )
    );
  end if;

  select outbound.*
  into v_outbound
  from public.asaas_outbound_message_attempts as outbound
  where outbound.id = p_outbound_attempt_id
  for update;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id
  for update;

  if v_outbound.id is null
     or v_notification.id is null
     or v_outbound.status <> 'SUBMITTING'
     or v_outbound.submit_attempt_count <> 1
     or v_outbound.claim_token is distinct from p_outbound_claim_token
     or v_notification.status <> 'processing'
     or v_notification.delivery_status <> 'submitting'
     or v_notification.claim_token is distinct from
       p_notification_claim_token then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'claim_lost'
    );
  end if;

  if v_outbound.notification_queue_id is distinct from v_notification.id
     or v_outbound.tenant_id is distinct from v_notification.tenant_id
     or v_outbound.student_id is distinct from v_notification.student_id
     or v_notification.source_id is null
     or v_outbound.provider_entity_id is distinct from
       v_notification.source_id::text
     or upper(pg_catalog.btrim(coalesce(
       v_notification.source_type,
       ''
     ))) <> 'ASAAS_PAYMENT'
     or upper(pg_catalog.btrim(coalesce(
       v_outbound.notification_kind,
       ''
     ))) <> 'PAYMENT_CONFIRMED_WHATSAPP'
     or private.canonical_payment_notification_kind(
       v_notification.notification_kind
     ) <> 'PAYMENT_CONFIRMED_WHATSAPP'
     or v_notification.provider_instance_name is null
     or v_outbound.provider_instance_name is null
     or lower(v_outbound.provider_instance_name) <>
       lower(v_notification.provider_instance_name)
     or v_notification.provider_destination is null
     or v_outbound.provider_destination is null
     or v_outbound.provider_destination is distinct from
       v_notification.provider_destination
     or v_notification.provider_integration_id is null
     or v_notification.provider_integration_version is null
     or (
       v_outbound.provider_message_id is not null
       and v_outbound.provider_message_id is distinct from
         v_provider_message_id
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'payment_confirmation_binding_mismatch'
    );
  end if;

  v_financial_status := case
    when v_outcome in ('accepted', 'sent', 'delivered', 'read') then 'SENT'
    when v_outcome = 'failed' then 'FAILED'
    else 'UNKNOWN'
  end;

  v_queue_result := public.finalize_notification_delivery(
    v_notification.id,
    p_notification_claim_token,
    v_outcome,
    v_provider_message_id,
    p_provider_http_status,
    v_error,
    0
  );

  if coalesce((v_queue_result ->> 'ok')::boolean, false) is not true then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', coalesce(
        v_queue_result ->> 'reason',
        'notification_delivery_finalize_failed'
      )
    );
  end if;

  -- A provider identity causes the generic finalizer to write the receipt and
  -- reconcile the linked financial row inside this same transaction. Accept
  -- that already-terminal state; without a provider id (FAILED/UNCERTAIN), this
  -- statement performs the sole SUBMITTING -> terminal transition. Either path
  -- still requires the original financial claim token and submit-once count.
  update public.asaas_outbound_message_attempts as outbound
  set provider_message_id = coalesce(
        outbound.provider_message_id,
        v_provider_message_id
      ),
      provider_delivery_status = case
        when outbound.status = 'SUBMITTING' then v_outcome
        else outbound.provider_delivery_status
      end,
      status = case
        when outbound.status = 'SUBMITTING' then v_financial_status
        else outbound.status
      end,
      provider_http_status = coalesce(
        p_provider_http_status,
        outbound.provider_http_status
      ),
      last_error = case
        when outbound.status <> 'SUBMITTING' then outbound.last_error
        when v_financial_status = 'SENT' then null
        else coalesce(
          v_error,
          case
            when v_financial_status = 'UNKNOWN'
              then 'notification_delivery_uncertain'
            else 'notification_delivery_failed'
          end
        )
      end,
      lease_expires_at = now(),
      updated_at = now()
  where outbound.id = v_outbound.id
    and outbound.status in ('SUBMITTING', 'SENT', 'FAILED', 'UNKNOWN')
    and outbound.claim_token = p_outbound_claim_token
    and outbound.submit_attempt_count = 1
    and (
      outbound.provider_message_id is null
      or outbound.provider_message_id = v_provider_message_id
    )
  returning outbound.* into v_outbound;

  if not found then
    raise exception 'payment_confirmation_ledger_finalize_failed';
  end if;

  select notification.*
  into strict v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'FINALIZED',
    'status', v_notification.status,
    'deliveryStatus', v_notification.delivery_status,
    'financialStatus', v_outbound.status,
    'providerMessageId', v_outbound.provider_message_id,
    'notificationId', v_notification.id,
    'outboundAttemptId', v_outbound.id
  );
end;
$function$;

alter function public.finalize_payment_confirmation_delivery(
  uuid,uuid,uuid,uuid,text,text,integer,text
) owner to postgres;
revoke all on function public.finalize_payment_confirmation_delivery(
  uuid,uuid,uuid,uuid,text,text,integer,text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_payment_confirmation_delivery(
  uuid,uuid,uuid,uuid,text,text,integer,text
) to service_role;

-- Version the two delivery workers that previously existed only in the live
-- scheduler. The secret must already be provisioned: a release must never
-- create an active cron that can only fail authentication.
do $whatsapp_delivery_cron_preconditions$
declare
  v_secret_count bigint;
  v_nonempty_secret_count bigint;
begin
  if not exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pg_cron'
  ) then
    raise exception 'pg_cron_is_required_for_whatsapp_delivery_workers';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pg_net'
  ) then
    raise exception 'pg_net_is_required_for_whatsapp_delivery_workers';
  end if;

  if pg_catalog.to_regclass('vault.decrypted_secrets') is null then
    raise exception 'supabase_vault_is_required_for_whatsapp_delivery_workers';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'service_role'
  ) then
    raise exception 'service_role_is_required_for_whatsapp_delivery_workers';
  end if;

  select
    count(*),
    count(*) filter (
      where nullif(pg_catalog.btrim(secret.decrypted_secret), '') is not null
    )
  into v_secret_count, v_nonempty_secret_count
  from vault.decrypted_secrets as secret
  where secret.name = 'wisewolf_service_role_key';

  if v_secret_count <> 1 or v_nonempty_secret_count <> 1 then
    raise exception 'wisewolf_service_role_key_must_exist_exactly_once';
  end if;
end;
$whatsapp_delivery_cron_preconditions$;

create or replace function public.trigger_process_queue()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_secret_count bigint;
  v_request_id bigint;
begin
  select count(*), max(secret.decrypted_secret)
  into v_secret_count, v_service_key
  from vault.decrypted_secrets as secret
  where secret.name = 'wisewolf_service_role_key';

  if v_secret_count <> 1
     or nullif(pg_catalog.btrim(v_service_key), '') is null then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/process-notification-queue',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_request_id;

  if v_request_id is null then
    raise exception 'process_notification_queue_http_request_was_not_queued';
  end if;

  return v_request_id;
end;
$function$;

alter function public.trigger_process_queue() owner to postgres;
revoke all on function public.trigger_process_queue()
  from public, anon, authenticated, service_role;
grant execute on function public.trigger_process_queue()
  to service_role;

create or replace function private.trigger_reconcile_whatsapp_webhooks()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_secret_count bigint;
  v_request_id bigint;
begin
  select count(*), max(secret.decrypted_secret)
  into v_secret_count, v_service_key
  from vault.decrypted_secrets as secret
  where secret.name = 'wisewolf_service_role_key';

  if v_secret_count <> 1
     or nullif(pg_catalog.btrim(v_service_key), '') is null then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/reconcile-whatsapp-webhooks',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key,
      'Content-Type', 'application/json'
    ),
    body := pg_catalog.jsonb_build_object('limit', 100),
    timeout_milliseconds := 120000
  ) into v_request_id;

  if v_request_id is null then
    raise exception 'reconcile_whatsapp_webhooks_http_request_was_not_queued';
  end if;

  return v_request_id;
end;
$function$;

alter function private.trigger_reconcile_whatsapp_webhooks()
  owner to postgres;
revoke all on function private.trigger_reconcile_whatsapp_webhooks()
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant execute on function private.trigger_reconcile_whatsapp_webhooks()
  to service_role;

-- Unschedule by jobid so historical duplicate rows cannot survive a release.
do $whatsapp_delivery_cron_schedule$
begin
  perform cron.unschedule(job.jobid)
  from cron.job as job
  where job.jobname in (
    'wisewolf-process-queue',
    'wisewolf-reconcile-whatsapp-webhooks'
  );

  perform cron.schedule(
    'wisewolf-process-queue',
    '* * * * *',
    'select public.trigger_process_queue();'
  );

  perform cron.schedule(
    'wisewolf-reconcile-whatsapp-webhooks',
    '*/15 * * * *',
    'select private.trigger_reconcile_whatsapp_webhooks();'
  );
end;
$whatsapp_delivery_cron_schedule$;

do $whatsapp_delivery_cron_postconditions$
declare
  v_process_definition text;
  v_reconcile_definition text;
begin
  if (
    select count(*)
    from (
      values
        ('public.trigger_process_queue()'),
        ('private.trigger_reconcile_whatsapp_webhooks()')
    ) as expected(signature)
    join pg_catalog.pg_proc as procedure
      on procedure.oid = pg_catalog.to_regprocedure(expected.signature)
    where procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[]
      and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
  ) <> 2 then
    raise exception 'whatsapp_delivery_wrapper_security_postcondition_failed';
  end if;

  if pg_catalog.has_function_privilege(
       'anon', 'public.trigger_process_queue()', 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', 'public.trigger_process_queue()', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', 'public.trigger_process_queue()', 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon', 'private.trigger_reconcile_whatsapp_webhooks()', 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'private.trigger_reconcile_whatsapp_webhooks()',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'private.trigger_reconcile_whatsapp_webhooks()',
       'EXECUTE'
     ) then
    raise exception 'whatsapp_delivery_wrapper_acl_postcondition_failed';
  end if;

  v_process_definition := pg_catalog.pg_get_functiondef(
    'public.trigger_process_queue()'::pg_catalog.regprocedure
  );
  v_reconcile_definition := pg_catalog.pg_get_functiondef(
    'private.trigger_reconcile_whatsapp_webhooks()'::pg_catalog.regprocedure
  );

  if position('vault.decrypted_secrets' in v_process_definition) = 0
     or position(
       '/functions/v1/process-notification-queue' in v_process_definition
     ) = 0
     or position('Authorization' in v_process_definition) = 0
     or position('apikey' in v_process_definition) = 0
     or position('timeout_milliseconds := 30000' in v_process_definition) = 0
     or position('vault.decrypted_secrets' in v_reconcile_definition) = 0
     or position(
       '/functions/v1/reconcile-whatsapp-webhooks' in v_reconcile_definition
     ) = 0
     or position('Authorization' in v_reconcile_definition) = 0
     or position('apikey' in v_reconcile_definition) = 0
     or position('jsonb_build_object(''limit'', 100)' in v_reconcile_definition) = 0
     or position('timeout_milliseconds := 120000' in v_reconcile_definition) = 0
  then
    raise exception 'whatsapp_delivery_wrapper_contract_postcondition_failed';
  end if;

  if exists (
    select 1
    from (
      values
        (
          'wisewolf-process-queue',
          '* * * * *',
          'select public.trigger_process_queue();'
        ),
        (
          'wisewolf-reconcile-whatsapp-webhooks',
          '*/15 * * * *',
          'select private.trigger_reconcile_whatsapp_webhooks();'
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
  ) then
    raise exception 'whatsapp_delivery_cron_postcondition_failed';
  end if;
end;
$whatsapp_delivery_cron_postconditions$;

do $whatsapp_delivery_pipeline_verify$
begin
  if pg_catalog.to_regprocedure(
    'public.claim_notification_delivery_batch(integer,integer)'
  ) is null
     or pg_catalog.to_regprocedure(
       'public.mark_notification_delivery_submitting(uuid,uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finalize_notification_delivery(uuid,uuid,text,text,integer,text,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.reconcile_whatsapp_provider_delivery(text,text,text,text,timestamptz)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.set_whatsapp_webhook_auth_version(text,text,smallint,uuid,bigint)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.set_whatsapp_webhook_auth_version(text,text,smallint)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.begin_payment_confirmation_delivery_submission(uuid,uuid,uuid,uuid,text,text,text,uuid,bigint)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.begin_payment_confirmation_delivery_submission(uuid,uuid,uuid,uuid,text,text,uuid,bigint)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.finalize_payment_confirmation_delivery(uuid,uuid,uuid,uuid,text,text,integer,text)'
     ) is null
     or pg_catalog.to_regclass(
       'private.whatsapp_provider_delivery_receipts'
     ) is null then
    raise exception 'whatsapp_delivery_pipeline_installation_failed';
  end if;
end
$whatsapp_delivery_pipeline_verify$;
