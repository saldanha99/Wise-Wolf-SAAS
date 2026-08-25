begin;

-- Hub purchases do not belong to a school tenant, so they must not reuse the
-- tenant-scoped classroom notification queue. This outbox is private to the
-- service role and keeps payment activation independent from provider latency.
create table public.hub_fulfillment_outbox (
  id bigint generated always as identity primary key,
  checkout_id uuid not null
    references public.hub_checkout_sessions(id) on delete cascade,
  subscription_id uuid
    references public.hub_subscriptions(id) on delete set null,
  account_id uuid not null
    references public.hub_accounts(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete restrict,
  product_family text not null
    check (product_family in ('HUB_CORE', 'WOLFIE_STANDALONE')),
  plan_code text not null
    check (char_length(plan_code) between 1 and 64),
  plan_name text not null
    check (char_length(plan_name) between 1 and 160),
  channel text not null
    check (channel in ('EMAIL', 'WHATSAPP')),
  recipient text not null
    check (char_length(recipient) between 3 and 320),
  recipient_name text not null
    check (char_length(recipient_name) between 1 and 160),
  status text not null default 'WAITING_PAYMENT'
    check (
      status in (
        'WAITING_PAYMENT', 'PENDING', 'PROCESSING', 'SENT', 'FAILED',
        'SKIPPED', 'UNCERTAIN'
      )
    ),
  attempt_count integer not null default 0
    check (attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_dispatch_started_at timestamptz,
  provider_message_id text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(metadata) = 'object'
      and pg_column_size(metadata) <= 4096
    ),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    status <> 'PROCESSING'
    or (lease_token is not null and lease_expires_at is not null)
  ),
  unique (checkout_id, channel)
);

create index hub_fulfillment_outbox_account_idx
  on public.hub_fulfillment_outbox(account_id, created_at desc);
create index hub_fulfillment_outbox_user_idx
  on public.hub_fulfillment_outbox(user_id, created_at desc);
create index hub_fulfillment_outbox_subscription_idx
  on public.hub_fulfillment_outbox(subscription_id)
  where subscription_id is not null;
create index hub_fulfillment_outbox_pending_idx
  on public.hub_fulfillment_outbox(next_attempt_at, created_at)
  where status = 'PENDING';
create index hub_fulfillment_outbox_stale_lease_idx
  on public.hub_fulfillment_outbox(lease_expires_at, created_at)
  where status = 'PROCESSING';

alter table public.hub_fulfillment_outbox enable row level security;
revoke all on table public.hub_fulfillment_outbox
  from public, anon, authenticated;
grant all on table public.hub_fulfillment_outbox to service_role;
revoke all on sequence public.hub_fulfillment_outbox_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.hub_fulfillment_outbox_id_seq
  to service_role;

create or replace function private.hub_release_fulfillment_on_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_is_renewal boolean := coalesce(new.metadata ->> 'renewal', 'false') =
    'true';
begin
  if new.status <> 'APPLIED'
     or (tg_op = 'UPDATE' and old.status = 'APPLIED')
     or v_is_renewal then
    return new;
  end if;

  update public.hub_fulfillment_outbox as delivery
  set subscription_id = new.subscription_id,
      status = case
        when coalesce(delivery.metadata ->> 'test_fixture', 'false') = 'true'
          then 'SKIPPED'
        else 'PENDING'
      end,
      next_attempt_at = pg_catalog.now(),
      lease_token = null,
      lease_expires_at = null,
      provider_dispatch_started_at = null,
      last_error = case
        when coalesce(delivery.metadata ->> 'test_fixture', 'false') = 'true'
          then 'test_fixture_suppressed'
        else null
      end,
      completed_at = case
        when coalesce(delivery.metadata ->> 'test_fixture', 'false') = 'true'
          then pg_catalog.now()
        else null
      end,
      updated_at = pg_catalog.now()
  where delivery.checkout_id = new.checkout_id
    and delivery.account_id = new.account_id
    and delivery.product_family = new.product_family
    and delivery.status = 'WAITING_PAYMENT';

  return new;
end;
$function$;

revoke all on function private.hub_release_fulfillment_on_payment()
  from public, anon, authenticated;

create trigger hub_release_fulfillment_after_payment_insert
after insert on public.hub_subscription_payments
for each row
execute function private.hub_release_fulfillment_on_payment();

create trigger hub_release_fulfillment_after_payment_update
after update of status on public.hub_subscription_payments
for each row
execute function private.hub_release_fulfillment_on_payment();

create or replace function private.hub_close_unpaid_fulfillment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status in ('FAILED', 'CANCELLED', 'REVERSED')
     and old.status is distinct from new.status then
    update public.hub_fulfillment_outbox as delivery
    set status = 'SKIPPED',
        lease_token = null,
        lease_expires_at = null,
        provider_dispatch_started_at = null,
        last_error = 'checkout_closed_before_payment',
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where delivery.checkout_id = new.id
      and delivery.status = 'WAITING_PAYMENT';
  end if;
  return new;
end;
$function$;

revoke all on function private.hub_close_unpaid_fulfillment()
  from public, anon, authenticated;

create trigger hub_close_unpaid_fulfillment_after_checkout
after update of status on public.hub_checkout_sessions
for each row
execute function private.hub_close_unpaid_fulfillment();

create or replace function public.claim_hub_fulfillment_outbox(
  p_checkout_id uuid default null,
  p_limit integer default 10
)
returns table (
  id bigint,
  checkout_id uuid,
  channel text,
  recipient text,
  recipient_name text,
  product_family text,
  plan_code text,
  plan_name text,
  attempt_count integer,
  lease_token uuid,
  provider_dispatch_started_at timestamptz,
  metadata jsonb
)
language sql
security definer
set search_path = ''
as $function$
  with quarantined as (
    update public.hub_fulfillment_outbox as queued
    set status = 'UNCERTAIN',
        lease_token = null,
        lease_expires_at = null,
        last_error = 'provider_outcome_unknown',
        updated_at = pg_catalog.now()
    where queued.status in ('PENDING', 'PROCESSING')
      and queued.provider_dispatch_started_at is not null
      and (
        (
          queued.status = 'PENDING'
          and queued.next_attempt_at <= pg_catalog.now()
        )
        or (
          queued.status = 'PROCESSING'
          and queued.lease_expires_at <= pg_catalog.now()
        )
      )
      and (
        queued.channel = 'WHATSAPP'
        or queued.provider_dispatch_started_at <=
          pg_catalog.now() - interval '23 hours'
      )
    returning queued.id
  ), candidates as (
    select queued.id
    from public.hub_fulfillment_outbox as queued
    where (p_checkout_id is null or queued.checkout_id = p_checkout_id)
      and queued.attempt_count < 8
      and (
        (
          queued.status = 'PENDING'
          and queued.next_attempt_at <= pg_catalog.now()
        )
        or (
          queued.status = 'PROCESSING'
          and queued.lease_expires_at <= pg_catalog.now()
        )
      )
      and (
        queued.provider_dispatch_started_at is null
        or (
          queued.channel = 'EMAIL'
          and queued.provider_dispatch_started_at >
            pg_catalog.now() - interval '23 hours'
        )
      )
      and not exists (
        select 1
        from quarantined
        where quarantined.id = queued.id
      )
    order by queued.next_attempt_at, queued.created_at, queued.id
    limit greatest(least(p_limit, 10), 1)
    for update skip locked
  ), claimed as (
    update public.hub_fulfillment_outbox as queued
    set status = 'PROCESSING',
        attempt_count = queued.attempt_count + 1,
        lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = pg_catalog.now() + interval '5 minutes',
        last_error = null,
        updated_at = pg_catalog.now()
    from candidates
    where queued.id = candidates.id
    returning
      queued.id,
      queued.checkout_id,
      queued.channel,
      queued.recipient,
      queued.recipient_name,
      queued.product_family,
      queued.plan_code,
      queued.plan_name,
      queued.attempt_count,
      queued.lease_token,
      queued.provider_dispatch_started_at,
      queued.metadata
  )
  select * from claimed;
$function$;

revoke all on function public.claim_hub_fulfillment_outbox(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_hub_fulfillment_outbox(uuid, integer)
  to service_role;

create or replace function public.trigger_hub_fulfillment_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_request_id bigint;
begin
  select secret.decrypted_secret
  into v_service_key
  from vault.decrypted_secrets as secret
  where secret.name = 'wisewolf_service_role_key'
  limit 1;

  if v_service_key is null or v_service_key = '' then
    raise warning 'wisewolf_service_role_key is not configured';
    return -1;
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/process-hub-fulfillment',
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_request_id;

  return v_request_id;
end;
$function$;

revoke all on function public.trigger_hub_fulfillment_worker()
  from public, anon, authenticated;
grant execute on function public.trigger_hub_fulfillment_worker()
  to service_role;

do $cron$
begin
  if exists (
    select 1 from cron.job
    where jobname = 'wisewolf-hub-fulfillment'
  ) then
    perform cron.unschedule('wisewolf-hub-fulfillment');
  end if;
  perform cron.schedule(
    'wisewolf-hub-fulfillment',
    '* * * * *',
    'select public.trigger_hub_fulfillment_worker();'
  );
end;
$cron$;

comment on table public.hub_fulfillment_outbox is
  'Service-only transactional outbox for paid Hub/Wolfie onboarding email and WhatsApp delivery.';
comment on function public.claim_hub_fulfillment_outbox(uuid, integer) is
  'Claims due Hub deliveries with tokenized leases, quarantining ambiguous provider outcomes. Service role only.';

commit;
