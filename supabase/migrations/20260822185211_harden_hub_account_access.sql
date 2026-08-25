-- Wise Wolf Hub account, privilege and metering hardening.
--
-- Product access now depends on both an ACTIVE membership and an ACTIVE
-- account. Sensitive billing/usage rows are manager-only, trial state is
-- expired operationally, and AI/storage work uses a reserve/commit/release
-- protocol so failed work does not consume customer quota.

begin;

create schema if not exists private;

-- The public catalog may read this operational flag, but only an internal
-- SUPER_ADMIN or service_role can change it through the narrow RPC below.
update public.hub_settings
set metadata = case
      when coalesce(metadata, '{}'::jsonb) ? 'hubEnabled'
        then coalesce(metadata, '{}'::jsonb)
      else coalesce(metadata, '{}'::jsonb) || '{"hubEnabled":true}'::jsonb
    end,
    updated_at = pg_catalog.now()
where settings_key = 'default';

create or replace function private.hub_is_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when pg_catalog.jsonb_typeof(settings.metadata -> 'hubEnabled') = 'boolean'
      then (settings.metadata ->> 'hubEnabled')::boolean
    else true
  end
  from public.hub_settings as settings
  where settings.settings_key = 'default'
  union all
  select true
  where not exists (
    select 1
    from public.hub_settings as settings
    where settings.settings_key = 'default'
  )
  limit 1;
$function$;

-- Billing activation is guarded at the database boundary as well as in the
-- Edge Functions. This closes the suspension/kill-switch race between a paid
-- provider event and the local subscription write.
create or replace function private.hub_enforce_active_subscription_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_account_status text;
begin
  if new.status <> 'ACTIVE' then
    return new;
  end if;

  select account.status into v_account_status
  from public.hub_accounts as account
  where account.id = new.account_id;

  if v_account_status is distinct from 'ACTIVE' then
    raise exception 'hub_account_inactive' using errcode = '42501';
  end if;
  if new.product_family = 'HUB_CORE'
     and not private.hub_is_enabled() then
    raise exception 'hub_disabled' using errcode = '42501';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_hub_active_subscription_guard
  on public.hub_subscriptions;
create trigger trg_hub_active_subscription_guard
before insert or update on public.hub_subscriptions
for each row execute function private.hub_enforce_active_subscription_guard();

create or replace function private.hub_enforce_account_billing_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_account_id uuid := case
    when tg_op = 'DELETE' then old.id
    else new.id
  end;
begin
  if tg_op = 'UPDATE' then
    if new.status = old.status then
      return new;
    end if;
  end if;

  if exists (
    select 1
    from public.hub_subscriptions as subscription
    join public.hub_plans as plan
      on plan.id = subscription.plan_id
    where subscription.account_id = v_account_id
      and subscription.status in (
        'TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE'
      )
      and (
        plan.code <> 'DISCOVERY'
        or subscription.provider is not null
        or subscription.provider_subscription_id is not null
        or subscription.provider_payment_id is not null
      )
  ) or exists (
    select 1
    from public.hub_checkout_sessions as checkout
    where checkout.account_id = v_account_id
      and checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID')
  ) then
    raise exception 'hub_live_billing_cancellation_required'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_hub_account_billing_transition_guard
  on public.hub_accounts;
create trigger trg_hub_account_billing_transition_guard
before update of status or delete on public.hub_accounts
for each row execute function
  private.hub_enforce_account_billing_transition_guard();

create or replace function private.hub_public_settings_internal()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.jsonb_build_object(
      'settings_key', settings.settings_key,
      'brand_name', settings.brand_name,
      'headline', settings.headline,
      'subheadline', settings.subheadline,
      'saas_video_url', settings.saas_video_url,
      'saas_cta_url', settings.saas_cta_url,
      'support_url', settings.support_url,
      'metadata', pg_catalog.jsonb_build_object(
        'hubEnabled', case
          when pg_catalog.jsonb_typeof(settings.metadata -> 'hubEnabled') = 'boolean'
            then (settings.metadata ->> 'hubEnabled')::boolean
          else true
        end
      )
    )
    from public.hub_settings as settings
    where settings.settings_key = 'default'
  ), '{}'::jsonb);
$function$;

create or replace function public.hub_get_public_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.hub_public_settings_internal();
$function$;

create or replace function private.hub_is_internal_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
    or exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.role = 'SUPER_ADMIN'
    );
$function$;

create or replace function private.hub_set_enabled_internal(
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_settings public.hub_settings%rowtype;
begin
  if p_enabled is null then
    raise exception 'hub_enabled_required' using errcode = '22023';
  end if;
  if not private.hub_is_internal_manager() then
    raise exception 'hub_internal_manager_required' using errcode = '42501';
  end if;

  update public.hub_settings as settings
  set metadata = pg_catalog.jsonb_set(
        coalesce(settings.metadata, '{}'::jsonb),
        '{hubEnabled}',
        pg_catalog.to_jsonb(p_enabled),
        true
      ),
      updated_at = pg_catalog.now()
  where settings.settings_key = 'default'
  returning settings.* into v_settings;

  if not found then
    raise exception 'hub_settings_missing' using errcode = 'P0002';
  end if;

  insert into public.hub_conversion_events (
    account_id,
    user_id,
    event_name,
    source,
    metadata
  ) values (
    null,
    v_actor_user_id,
    'hub_operational_status_changed',
    'internal_admin',
    pg_catalog.jsonb_build_object('hubEnabled', p_enabled)
  );

  return pg_catalog.jsonb_build_object(
    'hubEnabled', p_enabled,
    'updatedAt', v_settings.updated_at
  );
end;
$function$;

create or replace function private.hub_finalize_account_status_internal(
  p_account_id uuid,
  p_target_status text,
  p_cancelled_provider_subscription_ids text[] default '{}'::text[],
  p_actor_user_id uuid default null,
  p_reason text default 'ADMIN_REQUEST'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_account public.hub_accounts%rowtype;
  v_target_status text := pg_catalog.upper(
    coalesce(nullif(pg_catalog.btrim(p_target_status), ''), '')
  );
  v_reason text := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'ADMIN_REQUEST'),
    200
  );
  v_subscription record;
  v_checkout record;
  v_idempotent boolean := false;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_account_id is null
     or v_target_status not in ('SUSPENDED', 'CLOSED') then
    raise exception 'invalid_hub_account_status_change' using errcode = '22023';
  end if;
  if p_actor_user_id is not null and not exists (
    select 1
    from public.profiles as profile
    where profile.id = p_actor_user_id
      and profile.role = 'SUPER_ADMIN'
  ) then
    raise exception 'hub_status_actor_forbidden' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hub-account-status:' || p_account_id::text,
      0
    )
  );

  select account.* into v_account
  from public.hub_accounts as account
  where account.id = p_account_id
  for update;
  if not found then
    raise exception 'hub_account_not_found' using errcode = 'P0002';
  end if;
  v_idempotent := v_account.status = v_target_status;

  for v_subscription in
    select
      subscription.id,
      subscription.provider,
      subscription.provider_subscription_id,
      plan.code as plan_code
    from public.hub_subscriptions as subscription
    join public.hub_plans as plan
      on plan.id = subscription.plan_id
    where subscription.account_id = v_account.id
      and subscription.status in (
        'TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE'
      )
    order by subscription.created_at, subscription.id
    for update of subscription
  loop
    if v_subscription.provider is null
       and v_subscription.provider_subscription_id is null
       and v_subscription.plan_code = 'DISCOVERY' then
      continue;
    end if;
    if v_subscription.provider is distinct from 'ASAAS'
       or nullif(v_subscription.provider_subscription_id, '') is null then
      raise exception 'hub_subscription_reconciliation_required'
        using errcode = '55000';
    end if;
    if not (
      v_subscription.provider_subscription_id = any(
        coalesce(p_cancelled_provider_subscription_ids, '{}'::text[])
      )
    ) then
      raise exception 'hub_provider_cancellation_not_confirmed'
        using errcode = '55000';
    end if;
  end loop;

  for v_checkout in
    select
      checkout.id,
      checkout.status,
      checkout.asaas_subscription_id,
      checkout.asaas_payment_id
    from public.hub_checkout_sessions as checkout
    where checkout.account_id = v_account.id
      and checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID')
    order by checkout.created_at, checkout.id
    for update of checkout
  loop
    if nullif(v_checkout.asaas_subscription_id, '') is null then
      if v_checkout.status <> 'CREATED'
         or nullif(v_checkout.asaas_payment_id, '') is not null then
        raise exception 'hub_checkout_reconciliation_required'
          using errcode = '55000';
      end if;
      continue;
    end if;
    if not (
      v_checkout.asaas_subscription_id = any(
        coalesce(p_cancelled_provider_subscription_ids, '{}'::text[])
      )
    ) then
      raise exception 'hub_provider_cancellation_not_confirmed'
        using errcode = '55000';
    end if;
  end loop;

  update public.hub_subscriptions as subscription
  set status = 'CANCELLED',
      cancelled_at = coalesce(subscription.cancelled_at, pg_catalog.now()),
      current_period_ends_at = least(
        coalesce(subscription.current_period_ends_at, pg_catalog.now()),
        pg_catalog.now()
      ),
      metadata = coalesce(subscription.metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'accountStatusChange', v_target_status,
          'accountStatusReason', v_reason,
          'accountStatusChangedAt', pg_catalog.now()
        ),
      updated_at = pg_catalog.now()
  where subscription.account_id = v_account.id
    and subscription.status in (
      'TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE'
    );

  update public.hub_checkout_sessions as checkout
  set status = 'CANCELLED',
      metadata = coalesce(checkout.metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'accountStatusChange', v_target_status,
          'accountStatusReason', v_reason,
          'providerCancellationConfirmedAt', pg_catalog.now()
        ),
      updated_at = pg_catalog.now()
  where checkout.account_id = v_account.id
    and checkout.status in ('CREATED', 'PENDING', 'OVERDUE', 'PAID');

  update public.hub_accounts as account
  set status = v_target_status,
      updated_at = pg_catalog.now()
  where account.id = v_account.id
  returning account.* into v_account;

  insert into public.hub_conversion_events (
    account_id,
    user_id,
    event_name,
    source,
    metadata
  ) values (
    v_account.id,
    p_actor_user_id,
    'hub_account_status_changed',
    'hub_billing_admin',
    pg_catalog.jsonb_build_object(
      'status', v_target_status,
      'reason', v_reason,
      'providerSubscriptionsCancelled',
        coalesce(p_cancelled_provider_subscription_ids, '{}'::text[])
    )
  );

  return pg_catalog.jsonb_build_object(
    'accountId', v_account.id,
    'status', v_account.status,
    'idempotent', v_idempotent
  );
end;
$function$;

create or replace function public.hub_set_enabled(p_enabled boolean)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_set_enabled_internal(p_enabled);
$function$;

create or replace function public.hub_finalize_account_status_change(
  p_account_id uuid,
  p_target_status text,
  p_cancelled_provider_subscription_ids text[] default '{}'::text[],
  p_actor_user_id uuid default null,
  p_reason text default 'ADMIN_REQUEST'
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_finalize_account_status_internal(
    p_account_id,
    p_target_status,
    p_cancelled_provider_subscription_ids,
    p_actor_user_id,
    p_reason
  );
$function$;

-- Account helpers are used by every Hub RLS policy. Keeping the account
-- status check here makes suspension immediate without waiting for JWT expiry.
create or replace function private.hub_has_account_access(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.hub_is_enabled()
    and exists (
      select 1
      from public.hub_memberships as membership
      join public.hub_accounts as account
        on account.id = membership.account_id
       and account.status = 'ACTIVE'
      where membership.account_id = p_account_id
        and membership.user_id = (select auth.uid())
        and membership.status = 'ACTIVE'
    );
$function$;

create or replace function private.hub_is_account_manager(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.hub_is_enabled()
    and exists (
      select 1
      from public.hub_memberships as membership
      join public.hub_accounts as account
        on account.id = membership.account_id
       and account.status = 'ACTIVE'
      where membership.account_id = p_account_id
        and membership.user_id = (select auth.uid())
        and membership.status = 'ACTIVE'
        and membership.membership_role in ('OWNER', 'ADMIN')
    );
$function$;

-- Trial expiration is private, idempotent and callable only by its owner/cron.
create or replace function private.expire_hub_trials_internal()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_expired integer := 0;
begin
  update public.hub_subscriptions as subscription
  set status = 'EXPIRED',
      current_period_ends_at = least(
        coalesce(
          subscription.current_period_ends_at,
          subscription.trial_ends_at,
          pg_catalog.now()
        ),
        pg_catalog.now()
      ),
      metadata = coalesce(subscription.metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'expiredBy', 'hub_trial_expiration',
          'expiredAt', pg_catalog.now()
        ),
      updated_at = pg_catalog.now()
  where subscription.status = 'TRIALING'
    and subscription.trial_ends_at is not null
    and subscription.trial_ends_at <= pg_catalog.now();

  get diagnostics v_expired = row_count;
  return v_expired;
end;
$function$;

select private.expire_hub_trials_internal();

do $cron$
begin
  if exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pg_cron'
  ) then
    perform cron.unschedule('wisewolf-expire-hub-trials')
    where exists (
      select 1
      from cron.job
      where jobname = 'wisewolf-expire-hub-trials'
    );
    perform cron.schedule(
      'wisewolf-expire-hub-trials',
      '*/15 * * * *',
      'select private.expire_hub_trials_internal();'
    );
  end if;
end;
$cron$;

-- Reservations live outside the exposed Data API. A unique request key per
-- subscription/feature is the durable idempotency boundary; the lease token
-- prevents an expired worker from committing or releasing a newer attempt.
create table if not exists private.hub_usage_reservations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  account_id uuid not null
    references public.hub_accounts(id) on delete cascade,
  subscription_id uuid not null
    references public.hub_subscriptions(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete restrict,
  feature_key text not null
    check (pg_catalog.char_length(feature_key) between 3 and 120),
  units integer not null check (units between 1 and 1000),
  request_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'RESERVED'
    check (status in ('RESERVED', 'COMMITTED', 'RELEASED')),
  lease_token uuid not null default pg_catalog.gen_random_uuid(),
  lease_expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
    check (
      pg_catalog.jsonb_typeof(metadata) = 'object'
      and pg_catalog.pg_column_size(metadata) <= 4096
    ),
  release_reason text,
  reserved_at timestamptz not null default pg_catalog.now(),
  committed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  unique (subscription_id, feature_key, request_key)
);

create index if not exists hub_usage_reservations_active_period_idx
  on private.hub_usage_reservations (
    subscription_id,
    feature_key,
    period_start,
    period_end
  )
  where status = 'RESERVED';

alter table private.hub_usage_reservations enable row level security;

revoke all on table private.hub_usage_reservations
  from public, anon, authenticated, service_role;

create or replace function private.hub_claim_trial_internal(
  p_audience text default 'EDUCATOR',
  p_account_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_account public.hub_accounts%rowtype;
  v_account_id uuid;
  v_plan public.hub_plans%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_audience text := pg_catalog.upper(
    coalesce(nullif(pg_catalog.btrim(p_audience), ''), 'EDUCATOR')
  );
  v_name text;
  v_had_subscription boolean := false;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if not private.hub_is_enabled() then
    raise exception 'hub_disabled' using errcode = 'P0001';
  end if;
  if v_audience not in ('LEARNER', 'EDUCATOR', 'INSTITUTION') then
    raise exception 'invalid_audience' using errcode = '22023';
  end if;
  if v_audience = 'INSTITUTION' then
    raise exception 'institutional_sales_assisted' using errcode = 'P0001';
  end if;
  if v_audience = 'LEARNER' then
    raise exception 'learner_product_routing_required' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hub-claim-trial:' || v_user_id::text, 0)
  );

  select * into v_profile
  from public.profiles as profile
  where profile.id = v_user_id;
  if not found then
    raise exception 'profile_required' using errcode = 'P0001';
  end if;
  if v_profile.tenant_id = 'wolfie-direct' then
    raise exception 'wolfie_direct_hub_restricted' using errcode = 'P0001';
  end if;

  select account.id into v_account_id
  from public.hub_accounts as account
  where account.owner_user_id = v_user_id
    and account.account_type = 'PERSONAL'
  order by account.created_at, account.id
  limit 1;

  if v_account_id is not null then
    select account.* into v_account
    from public.hub_accounts as account
    where account.id = v_account_id
    for update;
    if v_account.status <> 'ACTIVE' then
      raise exception 'hub_account_inactive' using errcode = '42501';
    end if;

    insert into public.hub_memberships (
      account_id,
      user_id,
      membership_role,
      status
    ) values (
      v_account.id,
      v_user_id,
      'OWNER',
      'ACTIVE'
    ) on conflict (account_id, user_id) do update
    set membership_role = 'OWNER',
        status = 'ACTIVE',
        updated_at = pg_catalog.now();
  else
    v_name := coalesce(
      nullif(pg_catalog.btrim(p_account_name), ''),
      nullif(pg_catalog.btrim(v_profile.full_name), ''),
      pg_catalog.split_part(
        coalesce(v_profile.email, 'Conta Wise Wolf'),
        '@',
        1
      )
    );

    insert into public.hub_accounts (
      account_type,
      audience,
      name,
      owner_user_id,
      status
    ) values (
      'PERSONAL',
      v_audience,
      pg_catalog.left(v_name, 160),
      v_user_id,
      'ACTIVE'
    ) returning * into v_account;

    insert into public.hub_memberships (
      account_id,
      user_id,
      membership_role,
      status
    ) values (
      v_account.id,
      v_user_id,
      'OWNER',
      'ACTIVE'
    );

    perform pg_catalog.set_config('app.enrollment_claim', '1', true);
    update public.profiles as profile
    set role = 'NON_STUDENT'
    where profile.id = v_user_id
      and profile.role = 'STUDENT'
      and profile.tenant_id is null;
  end if;

  update public.hub_subscriptions as expired_trial
  set status = 'EXPIRED',
      current_period_ends_at = least(
        coalesce(
          expired_trial.current_period_ends_at,
          expired_trial.trial_ends_at,
          pg_catalog.now()
        ),
        pg_catalog.now()
      ),
      updated_at = pg_catalog.now()
  where expired_trial.account_id = v_account.id
    and expired_trial.product_family = 'HUB_CORE'
    and expired_trial.status = 'TRIALING'
    and expired_trial.trial_ends_at <= pg_catalog.now();

  select subscription.* into v_subscription
  from public.hub_subscriptions as subscription
  where subscription.account_id = v_account.id
    and subscription.product_family = 'HUB_CORE'
    and subscription.status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
  order by subscription.created_at desc, subscription.id desc
  limit 1;
  if found then
    return pg_catalog.jsonb_build_object(
      'accountId', v_account.id,
      'subscriptionId', v_subscription.id,
      'status', v_subscription.status,
      'trialEndsAt', v_subscription.trial_ends_at,
      'alreadyActive', true,
      'productFamily', 'HUB_CORE'
    );
  end if;

  select exists (
    select 1
    from public.hub_subscriptions as history
    where history.account_id = v_account.id
      and history.product_family = 'HUB_CORE'
  ) into v_had_subscription;
  if v_had_subscription then
    raise exception 'trial_already_claimed' using errcode = 'P0001';
  end if;

  select plan.* into v_plan
  from public.hub_plans as plan
  where plan.code = 'DISCOVERY'
    and plan.product_family = 'HUB_CORE'
    and plan.is_active = true;
  if not found then
    raise exception 'discovery_plan_unavailable' using errcode = 'P0001';
  end if;

  insert into public.hub_subscriptions (
    account_id,
    plan_id,
    status,
    trial_starts_at,
    trial_ends_at,
    current_period_starts_at,
    current_period_ends_at,
    product_family,
    metadata
  ) values (
    v_account.id,
    v_plan.id,
    'TRIALING',
    pg_catalog.now(),
    pg_catalog.now() + pg_catalog.make_interval(
      days => greatest(v_plan.trial_days, 1)
    ),
    pg_catalog.now(),
    pg_catalog.now() + pg_catalog.make_interval(
      days => greatest(v_plan.trial_days, 1)
    ),
    'HUB_CORE',
    '{"source":"hub_onboarding","product_family":"HUB_CORE"}'::jsonb
  ) returning * into v_subscription;

  update public.hub_accounts as account
  set trial_claimed_at = coalesce(account.trial_claimed_at, pg_catalog.now()),
      audience = v_audience,
      updated_at = pg_catalog.now()
  where account.id = v_account.id
  returning * into v_account;

  return pg_catalog.jsonb_build_object(
    'accountId', v_account.id,
    'subscriptionId', v_subscription.id,
    'status', v_subscription.status,
    'trialEndsAt', v_subscription.trial_ends_at,
    'alreadyActive', false,
    'productFamily', 'HUB_CORE'
  );
end;
$function$;

create or replace function private.hub_bootstrap_internal(
  p_account_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_account_id uuid;
  v_active_account_count integer := 0;
  v_is_manager boolean := false;
  v_blocked record;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if not private.hub_is_enabled() then
    raise exception 'hub_disabled' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from public.profiles as profile
    where profile.id = v_user_id
      and profile.tenant_id = 'wolfie-direct'
  ) then
    return null;
  end if;

  if p_account_id is null then
    select pg_catalog.count(*)::integer into v_active_account_count
    from public.hub_memberships as membership
    join public.hub_accounts as account
      on account.id = membership.account_id
     and account.status = 'ACTIVE'
    where membership.user_id = v_user_id
      and membership.status = 'ACTIVE';

    if v_active_account_count > 1 then
      return pg_catalog.jsonb_build_object(
        'account', null,
        'membership', null,
        'isManager', false,
        'subscription', null,
        'plan', null,
        'entitlements', '{}'::jsonb,
        'settings', private.hub_public_settings_internal(),
        'access', pg_catalog.jsonb_build_object(
          'allowed', false,
          'code', 'HUB_ACCOUNT_AMBIGUOUS'
        )
      );
    end if;
  end if;

  select
    membership.account_id,
    membership.membership_role in ('OWNER', 'ADMIN')
  into v_account_id, v_is_manager
  from public.hub_memberships as membership
  join public.hub_accounts as account
    on account.id = membership.account_id
   and account.status = 'ACTIVE'
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
    and (p_account_id is null or membership.account_id = p_account_id)
  order by
    (membership.membership_role = 'OWNER') desc,
    (membership.membership_role = 'ADMIN') desc,
    membership.created_at,
    membership.id
  limit 1;

  if v_account_id is null then
    select
      account.id as account_id,
      account.name as account_name,
      account.account_type,
      account.audience,
      account.status as account_status,
      membership.membership_role,
      membership.status as membership_status
    into v_blocked
    from public.hub_memberships as membership
    join public.hub_accounts as account
      on account.id = membership.account_id
    where membership.user_id = v_user_id
      and membership.status <> 'REMOVED'
      and (p_account_id is null or membership.account_id = p_account_id)
      and (
        membership.status <> 'ACTIVE'
        or account.status <> 'ACTIVE'
      )
    order by
      (membership.membership_role = 'OWNER') desc,
      (membership.membership_role = 'ADMIN') desc,
      membership.created_at,
      membership.id
    limit 1;
    if found then
      return pg_catalog.jsonb_build_object(
        'account', pg_catalog.jsonb_build_object(
          'id', v_blocked.account_id,
          'name', v_blocked.account_name,
          'account_type', v_blocked.account_type,
          'audience', v_blocked.audience,
          'status', case
            when v_blocked.account_status = 'ACTIVE'
              then 'SUSPENDED'
            else v_blocked.account_status
          end,
          'metadata', '{}'::jsonb
        ),
        'membership', pg_catalog.jsonb_build_object(
          'membership_role', v_blocked.membership_role,
          'status', v_blocked.membership_status
        ),
        'isManager', false,
        'subscription', null,
        'plan', null,
        'entitlements', '{}'::jsonb,
        'settings', private.hub_public_settings_internal(),
        'access', pg_catalog.jsonb_build_object(
          'allowed', false,
          'code', 'HUB_ACCOUNT_INACTIVE'
        )
      );
    end if;
    return null;
  end if;

  select pg_catalog.jsonb_build_object(
    'account', pg_catalog.jsonb_build_object(
      'id', account.id,
      'name', account.name,
          'account_type', account.account_type,
          'audience', account.audience,
          'status', account.status,
          'trial_claimed_at', account.trial_claimed_at,
          'metadata', pg_catalog.jsonb_strip_nulls(
            pg_catalog.jsonb_build_object(
              'onboarding_completed', account.metadata -> 'onboarding_completed',
              'level', account.metadata -> 'level',
              'role', account.metadata -> 'role',
              'goal', account.metadata -> 'goal',
              'interests', account.metadata -> 'interests',
              'preferred_modality', account.metadata -> 'preferred_modality',
              'personalized_at', account.metadata -> 'personalized_at'
            )
          )
    ),
    'membership', pg_catalog.jsonb_build_object(
      'membership_role', membership.membership_role,
      'status', membership.status
    ),
    'isManager', v_is_manager,
    'subscription', case
      when subscription.id is null then null
      else pg_catalog.jsonb_build_object(
        'id', subscription.id,
        'plan_id', subscription.plan_id,
        'status', subscription.status,
        'billing_cycle', subscription.billing_cycle,
        'trial_starts_at', subscription.trial_starts_at,
        'trial_ends_at', subscription.trial_ends_at,
        'current_period_starts_at', subscription.current_period_starts_at,
        'current_period_ends_at', subscription.current_period_ends_at,
        'product_family', subscription.product_family
      )
    end,
    'plan', case
      when plan.id is null then null
      else pg_catalog.jsonb_build_object(
        'id', plan.id,
        'code', plan.code,
        'name', plan.name,
        'description', plan.description,
        'audience', plan.audience,
        'price_monthly', plan.price_monthly,
        'price_yearly', plan.price_yearly,
        'trial_days', plan.trial_days,
        'features', plan.features,
        'metadata', plan.metadata,
        'product_family', plan.product_family
      )
    end,
    'entitlements', coalesce((
      select pg_catalog.jsonb_object_agg(
        entitlement.feature_key,
        pg_catalog.jsonb_build_object(
          'limit', entitlement.limit_value,
          'resetPeriod', entitlement.reset_period,
          'used', coalesce(usage.used_units, 0)
        )
      )
      from public.hub_plan_entitlements as entitlement
      left join lateral (
        select counter.used_units
        from public.hub_usage_counters as counter
        where counter.subscription_id = subscription.id
          and counter.feature_key = entitlement.feature_key
          and pg_catalog.now() >= counter.period_start
          and pg_catalog.now() < counter.period_end
        order by counter.period_start desc
        limit 1
      ) as usage on true
      where entitlement.plan_id = plan.id
    ), '{}'::jsonb),
    'settings', private.hub_public_settings_internal()
  ) into v_result
  from public.hub_accounts as account
  join public.hub_memberships as membership
    on membership.account_id = account.id
   and membership.user_id = v_user_id
   and membership.status = 'ACTIVE'
  left join lateral (
    select candidate.*
    from public.hub_subscriptions as candidate
    where candidate.account_id = account.id
      and candidate.product_family = 'HUB_CORE'
      and (
        (
          candidate.status = 'TRIALING'
          and candidate.trial_ends_at > pg_catalog.now()
        )
        or (
          candidate.status = 'ACTIVE'
          and coalesce(
            candidate.current_period_ends_at,
            '-infinity'::timestamptz
          ) > pg_catalog.now()
        )
      )
    order by
      (candidate.status = 'ACTIVE') desc,
      candidate.created_at desc,
      candidate.id desc
    limit 1
  ) as subscription on true
  left join public.hub_plans as plan
    on plan.id = subscription.plan_id
   and plan.product_family = 'HUB_CORE'
  where account.id = v_account_id
    and account.status = 'ACTIVE';

  return v_result;
end;
$function$;

create or replace function private.hub_list_accounts_internal()
returns table (
  id uuid,
  name text,
  audience text,
  account_type text,
  status text,
  membership_role text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    account.id,
    account.name,
    account.audience,
    account.account_type,
    case
      when membership.status = 'ACTIVE' then account.status
      else 'SUSPENDED'
    end as status,
    membership.membership_role
  from public.hub_memberships as membership
  join public.hub_accounts as account
    on account.id = membership.account_id
  where membership.user_id = auth.uid()
    and membership.status <> 'REMOVED'
    and private.hub_is_enabled()
    and not exists (
      select 1
      from public.profiles as profile
      where profile.id = auth.uid()
        and profile.tenant_id = 'wolfie-direct'
    )
  order by
    (account.status = 'ACTIVE' and membership.status = 'ACTIVE') desc,
    (membership.membership_role = 'OWNER') desc,
    (membership.membership_role = 'ADMIN') desc,
    account.created_at,
    account.id;
$function$;

create or replace function private.hub_reserve_feature_internal(
  p_user_id uuid,
  p_feature_key text,
  p_units integer,
  p_request_key uuid,
  p_request_fingerprint text,
  p_account_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := p_user_id;
  v_account_id uuid;
  v_active_account_count integer := 0;
  v_subscription public.hub_subscriptions%rowtype;
  v_reservation private.hub_usage_reservations%rowtype;
  v_feature_key text := nullif(pg_catalog.btrim(p_feature_key), '');
  v_fingerprint text := pg_catalog.lower(
    coalesce(pg_catalog.btrim(p_request_fingerprint), '')
  );
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_limit integer;
  v_reset text;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_used integer := 0;
  v_reserved integer := 0;
  v_lease_token uuid := pg_catalog.gen_random_uuid();
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if v_feature_key is null
     or pg_catalog.char_length(v_feature_key) < 3
     or p_units is null
     or p_units <> 1
     or p_request_key is null
     or v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_usage_reservation' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_metadata) <> 'object'
     or pg_catalog.pg_column_size(v_metadata) > 4096 then
    raise exception 'invalid_usage_metadata' using errcode = '22023';
  end if;
  if not private.hub_is_enabled() then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'HUB_DISABLED',
      'productFamily', 'HUB_CORE'
    );
  end if;
  if exists (
    select 1
    from public.profiles as profile
    where profile.id = v_user_id
      and profile.tenant_id = 'wolfie-direct'
  ) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'PRODUCT_SCOPE_FORBIDDEN',
      'productFamily', 'HUB_CORE'
    );
  end if;

  if v_feature_key = 'educator_ai.generate' then
    if v_metadata ->> 'source' <> 'pedagogical-content'
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_metadata) as key(name)
         where key.name not in ('source')
       ) then
      raise exception 'invalid_usage_metadata' using errcode = '22023';
    end if;
    v_metadata := '{"source":"pedagogical-content"}'::jsonb;
  elsif v_feature_key = 'wolfie.turn' then
    if v_metadata ->> 'source' <> 'wolf-tutor-api'
       or coalesce(v_metadata ->> 'conversationId', '')
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or pg_catalog.char_length(coalesce(v_metadata ->> 'experienceId', '')) > 80
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_metadata) as key(name)
         where key.name not in ('source', 'conversationId', 'experienceId')
       ) then
      raise exception 'invalid_usage_metadata' using errcode = '22023';
    end if;
    v_metadata := pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'source', 'wolf-tutor-api',
        'conversationId', v_metadata ->> 'conversationId',
        'experienceId', nullif(pg_catalog.btrim(v_metadata ->> 'experienceId'), '')
      )
    );
  elsif v_feature_key in ('library.preview', 'library.full_access') then
    if v_metadata ->> 'source' <> 'hub-library-access'
       or coalesce(v_metadata ->> 'contentId', '')
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or v_metadata ->> 'assetKind' not in ('PREVIEW', 'FULL')
       or (
         v_feature_key = 'library.preview'
         and v_metadata ->> 'assetKind' <> 'PREVIEW'
       )
       or (
         v_feature_key = 'library.full_access'
         and v_metadata ->> 'assetKind' <> 'FULL'
       )
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_metadata) as key(name)
         where key.name not in ('source', 'contentId', 'assetKind')
       ) then
      raise exception 'invalid_usage_metadata' using errcode = '22023';
    end if;
    v_metadata := pg_catalog.jsonb_build_object(
      'source', 'hub-library-access',
      'contentId', v_metadata ->> 'contentId',
      'assetKind', v_metadata ->> 'assetKind'
    );
  else
    raise exception 'unsupported_usage_reservation_feature'
      using errcode = '22023';
  end if;

  if p_account_id is null then
    select pg_catalog.count(*)::integer into v_active_account_count
    from public.hub_memberships as membership
    join public.hub_accounts as account
      on account.id = membership.account_id
     and account.status = 'ACTIVE'
    where membership.user_id = v_user_id
      and membership.status = 'ACTIVE';

    if v_active_account_count > 1 then
      return pg_catalog.jsonb_build_object(
        'allowed', false,
        'code', 'HUB_ACCOUNT_AMBIGUOUS',
        'productFamily', 'HUB_CORE'
      );
    end if;
  end if;

  select membership.account_id into v_account_id
  from public.hub_memberships as membership
  join public.hub_accounts as account
    on account.id = membership.account_id
   and account.status = 'ACTIVE'
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
    and (p_account_id is null or membership.account_id = p_account_id)
  order by membership.created_at, membership.id
  limit 1;
  if v_account_id is null then
    if exists (
      select 1
      from public.hub_memberships as membership
      join public.hub_accounts as account
        on account.id = membership.account_id
      where membership.user_id = v_user_id
        and membership.status <> 'REMOVED'
        and (p_account_id is null or membership.account_id = p_account_id)
        and (
          membership.status <> 'ACTIVE'
          or account.status <> 'ACTIVE'
        )
    ) then
      return pg_catalog.jsonb_build_object(
        'allowed', false,
        'code', 'HUB_ACCOUNT_INACTIVE',
        'productFamily', 'HUB_CORE'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'HUB_ACCOUNT_REQUIRED',
      'productFamily', 'HUB_CORE'
    );
  end if;

  select subscription.* into v_subscription
  from public.hub_subscriptions as subscription
  join public.hub_plans as plan
    on plan.id = subscription.plan_id
   and plan.product_family = 'HUB_CORE'
  where subscription.account_id = v_account_id
    and subscription.product_family = 'HUB_CORE'
    and (
      (
        subscription.status = 'TRIALING'
        and subscription.trial_ends_at > pg_catalog.now()
      )
      or (
        subscription.status = 'ACTIVE'
        and coalesce(
          subscription.current_period_ends_at,
          '-infinity'::timestamptz
        ) > pg_catalog.now()
      )
    )
  order by
    (subscription.status = 'ACTIVE') desc,
    subscription.created_at desc,
    subscription.id desc
  limit 1
  for update of subscription;
  if not found then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'SUBSCRIPTION_REQUIRED',
      'productFamily', 'HUB_CORE'
    );
  end if;

  select entitlement.limit_value, entitlement.reset_period
  into v_limit, v_reset
  from public.hub_plan_entitlements as entitlement
  where entitlement.plan_id = v_subscription.plan_id
    and entitlement.feature_key = v_feature_key;
  if not found or v_limit = 0 then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'FEATURE_NOT_INCLUDED',
      'productFamily', 'HUB_CORE'
    );
  end if;

  if v_reset = 'DAY' then
    v_period_start := pg_catalog.date_trunc('day', pg_catalog.now());
    v_period_end := v_period_start + interval '1 day';
  elsif v_reset = 'SUBSCRIPTION' then
    v_period_start := coalesce(
      v_subscription.trial_starts_at,
      v_subscription.current_period_starts_at,
      v_subscription.created_at
    );
    v_period_end := coalesce(
      v_subscription.trial_ends_at,
      v_subscription.current_period_ends_at,
      'infinity'::timestamptz
    );
  else
    v_period_start := pg_catalog.date_trunc('month', pg_catalog.now());
    v_period_end := v_period_start + interval '1 month';
  end if;

  update private.hub_usage_reservations as expired_reservation
  set status = 'RELEASED',
      release_reason = 'LEASE_EXPIRED',
      released_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where expired_reservation.subscription_id = v_subscription.id
    and expired_reservation.feature_key = v_feature_key
    and expired_reservation.status = 'RESERVED'
    and expired_reservation.lease_expires_at <= pg_catalog.now();

  if exists (
    select 1
    from public.hub_usage_events as usage_event
    where usage_event.subscription_id = v_subscription.id
      and usage_event.feature_key = v_feature_key
      and usage_event.request_key = p_request_key
  ) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'idempotent', true,
      'code', 'REQUEST_ALREADY_COMPLETED',
      'subscriptionId', v_subscription.id,
      'productFamily', 'HUB_CORE'
    );
  end if;

  select reservation.* into v_reservation
  from private.hub_usage_reservations as reservation
  where reservation.subscription_id = v_subscription.id
    and reservation.feature_key = v_feature_key
    and reservation.request_key = p_request_key
  for update;
  if found then
    if v_reservation.user_id <> v_user_id
       or v_reservation.units <> p_units
       or v_reservation.request_fingerprint <> v_fingerprint then
      return pg_catalog.jsonb_build_object(
        'allowed', false,
        'idempotent', true,
        'code', 'IDEMPOTENCY_KEY_REUSED',
        'productFamily', 'HUB_CORE'
      );
    end if;
    if v_reservation.status = 'COMMITTED' then
      return pg_catalog.jsonb_build_object(
        'allowed', false,
        'idempotent', true,
        'code', 'REQUEST_ALREADY_COMPLETED',
        'subscriptionId', v_subscription.id,
        'productFamily', 'HUB_CORE'
      );
    end if;
    if v_reservation.status = 'RESERVED' then
      return pg_catalog.jsonb_build_object(
        'allowed', false,
        'idempotent', true,
        'code', 'REQUEST_IN_PROGRESS',
        'retryAfterSeconds', greatest(
          pg_catalog.ceil(
            extract(
              epoch from (
                v_reservation.lease_expires_at - pg_catalog.now()
              )
            )
          )::integer,
          1
        ),
        'subscriptionId', v_subscription.id,
        'productFamily', 'HUB_CORE'
      );
    end if;
  end if;

  select coalesce(counter.used_units, 0) into v_used
  from public.hub_usage_counters as counter
  where counter.subscription_id = v_subscription.id
    and counter.feature_key = v_feature_key
    and counter.period_start = v_period_start;
  v_used := coalesce(v_used, 0);

  select coalesce(pg_catalog.sum(reservation.units), 0)::integer
  into v_reserved
  from private.hub_usage_reservations as reservation
  where reservation.subscription_id = v_subscription.id
    and reservation.feature_key = v_feature_key
    and reservation.period_start = v_period_start
    and reservation.period_end = v_period_end
    and reservation.status = 'RESERVED';

  if v_limit is not null and v_used + v_reserved + p_units > v_limit then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'USAGE_LIMIT_REACHED',
      'subscriptionId', v_subscription.id,
      'productFamily', 'HUB_CORE',
      'used', v_used,
      'reserved', v_reserved,
      'limit', v_limit,
      'remaining', greatest(v_limit - v_used - v_reserved, 0),
      'periodEndsAt', v_period_end
    );
  end if;

  if v_reservation.id is null then
    insert into private.hub_usage_reservations (
      account_id,
      subscription_id,
      user_id,
      feature_key,
      units,
      request_key,
      request_fingerprint,
      period_start,
      period_end,
      status,
      lease_token,
      lease_expires_at,
      metadata
    ) values (
      v_account_id,
      v_subscription.id,
      v_user_id,
      v_feature_key,
      p_units,
      p_request_key,
      v_fingerprint,
      v_period_start,
      v_period_end,
      'RESERVED',
      v_lease_token,
      pg_catalog.now() + interval '10 minutes',
      v_metadata
    ) returning * into v_reservation;
  else
    update private.hub_usage_reservations as reservation
    set status = 'RESERVED',
        account_id = v_account_id,
        user_id = v_user_id,
        period_start = v_period_start,
        period_end = v_period_end,
        lease_token = v_lease_token,
        lease_expires_at = pg_catalog.now() + interval '10 minutes',
        release_reason = null,
        released_at = null,
        reserved_at = pg_catalog.now(),
        updated_at = pg_catalog.now(),
        metadata = v_metadata
    where reservation.id = v_reservation.id
    returning * into v_reservation;
  end if;

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'idempotent', false,
    'accountId', v_account_id,
    'subscriptionId', v_subscription.id,
    'reservationId', v_reservation.id,
    'leaseToken', v_reservation.lease_token,
    'requestKey', p_request_key,
    'productFamily', 'HUB_CORE',
    'used', v_used,
    'reserved', v_reserved + p_units,
    'limit', v_limit,
    'remaining', case when v_limit is null then null
      else greatest(v_limit - v_used - v_reserved - p_units, 0)
    end,
    'periodEndsAt', v_period_end,
    'leaseExpiresAt', v_reservation.lease_expires_at
  );
end;
$function$;

create or replace function private.hub_commit_feature_internal(
  p_user_id uuid,
  p_reservation_id uuid,
  p_lease_token uuid,
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := p_user_id;
  v_subscription_id uuid;
  v_subscription public.hub_subscriptions%rowtype;
  v_reservation private.hub_usage_reservations%rowtype;
  v_limit integer;
  v_used integer := 0;
  v_reserved integer := 0;
  v_event_id bigint;
  v_denial_code text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if p_reservation_id is null
     or p_lease_token is null
     or p_request_key is null then
    raise exception 'invalid_usage_commit' using errcode = '22023';
  end if;

  select reservation.subscription_id into v_subscription_id
  from private.hub_usage_reservations as reservation
  where reservation.id = p_reservation_id;
  if v_subscription_id is null then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'RESERVATION_NOT_FOUND',
      'productFamily', 'HUB_CORE'
    );
  end if;

  select subscription.* into v_subscription
  from public.hub_subscriptions as subscription
  where subscription.id = v_subscription_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'RESERVATION_NOT_FOUND',
      'productFamily', 'HUB_CORE'
    );
  end if;

  select reservation.* into v_reservation
  from private.hub_usage_reservations as reservation
  where reservation.id = p_reservation_id
    and reservation.subscription_id = v_subscription.id
    and reservation.user_id = v_user_id
    and reservation.request_key = p_request_key
    and reservation.lease_token = p_lease_token
  for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'RESERVATION_NOT_FOUND',
      'productFamily', 'HUB_CORE'
    );
  end if;

  if v_reservation.status = 'COMMITTED' then
    return pg_catalog.jsonb_build_object(
      'allowed', true,
      'idempotent', true,
      'accountId', v_reservation.account_id,
      'subscriptionId', v_reservation.subscription_id,
      'reservationId', v_reservation.id,
      'productFamily', 'HUB_CORE'
    );
  end if;
  if v_reservation.status = 'RELEASED' then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'idempotent', true,
      'code', 'RESERVATION_RELEASED',
      'productFamily', 'HUB_CORE'
    );
  end if;

  if not private.hub_is_enabled() then
    v_denial_code := 'HUB_DISABLED';
  elsif not exists (
    select 1
    from public.hub_accounts as account
    join public.hub_memberships as membership
      on membership.account_id = account.id
     and membership.user_id = v_user_id
     and membership.status = 'ACTIVE'
    where account.id = v_reservation.account_id
      and account.status = 'ACTIVE'
  ) then
    v_denial_code := 'HUB_ACCOUNT_INACTIVE';
  elsif v_subscription.account_id <> v_reservation.account_id
     or v_subscription.product_family <> 'HUB_CORE'
     or not (
       (
         v_subscription.status = 'TRIALING'
         and v_subscription.trial_ends_at > pg_catalog.now()
       )
       or (
         v_subscription.status = 'ACTIVE'
         and coalesce(
           v_subscription.current_period_ends_at,
           '-infinity'::timestamptz
         ) > pg_catalog.now()
       )
     ) then
    v_denial_code := 'SUBSCRIPTION_REQUIRED';
  elsif v_reservation.lease_expires_at <= pg_catalog.now() then
    v_denial_code := 'RESERVATION_EXPIRED';
  end if;

  if v_denial_code is not null then
    update private.hub_usage_reservations as reservation
    set status = 'RELEASED',
        release_reason = v_denial_code,
        released_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where reservation.id = v_reservation.id;
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', v_denial_code,
      'productFamily', 'HUB_CORE'
    );
  end if;

  select entitlement.limit_value into v_limit
  from public.hub_plan_entitlements as entitlement
  where entitlement.plan_id = v_subscription.plan_id
    and entitlement.feature_key = v_reservation.feature_key;
  if not found or v_limit = 0 then
    update private.hub_usage_reservations as reservation
    set status = 'RELEASED',
        release_reason = 'FEATURE_NOT_INCLUDED',
        released_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where reservation.id = v_reservation.id;
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'FEATURE_NOT_INCLUDED',
      'productFamily', 'HUB_CORE'
    );
  end if;

  insert into public.hub_usage_counters (
    account_id,
    subscription_id,
    feature_key,
    period_start,
    period_end,
    used_units
  ) values (
    v_reservation.account_id,
    v_reservation.subscription_id,
    v_reservation.feature_key,
    v_reservation.period_start,
    v_reservation.period_end,
    0
  ) on conflict (subscription_id, feature_key, period_start) do nothing;

  select counter.used_units into v_used
  from public.hub_usage_counters as counter
  where counter.subscription_id = v_reservation.subscription_id
    and counter.feature_key = v_reservation.feature_key
    and counter.period_start = v_reservation.period_start
  for update;
  v_used := coalesce(v_used, 0);

  if v_limit is not null and v_used + v_reservation.units > v_limit then
    update private.hub_usage_reservations as reservation
    set status = 'RELEASED',
        release_reason = 'USAGE_LIMIT_REACHED',
        released_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where reservation.id = v_reservation.id;
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'USAGE_LIMIT_REACHED',
      'used', v_used,
      'limit', v_limit,
      'remaining', greatest(v_limit - v_used, 0),
      'periodEndsAt', v_reservation.period_end,
      'productFamily', 'HUB_CORE'
    );
  end if;

  insert into public.hub_usage_events (
    account_id,
    subscription_id,
    user_id,
    feature_key,
    units,
    request_key,
    metadata
  ) values (
    v_reservation.account_id,
    v_reservation.subscription_id,
    v_user_id,
    v_reservation.feature_key,
    v_reservation.units,
    v_reservation.request_key,
    v_reservation.metadata
      || pg_catalog.jsonb_build_object('reservationId', v_reservation.id)
  ) returning id into v_event_id;

  update public.hub_usage_counters as counter
  set used_units = counter.used_units + v_reservation.units,
      updated_at = pg_catalog.now()
  where counter.subscription_id = v_reservation.subscription_id
    and counter.feature_key = v_reservation.feature_key
    and counter.period_start = v_reservation.period_start
  returning counter.used_units into v_used;

  update private.hub_usage_reservations as reservation
  set status = 'COMMITTED',
      committed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where reservation.id = v_reservation.id;

  select coalesce(pg_catalog.sum(reservation.units), 0)::integer
  into v_reserved
  from private.hub_usage_reservations as reservation
  where reservation.subscription_id = v_reservation.subscription_id
    and reservation.feature_key = v_reservation.feature_key
    and reservation.period_start = v_reservation.period_start
    and reservation.period_end = v_reservation.period_end
    and reservation.status = 'RESERVED';

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'idempotent', false,
    'accountId', v_reservation.account_id,
    'subscriptionId', v_reservation.subscription_id,
    'reservationId', v_reservation.id,
    'usageEventId', v_event_id,
    'productFamily', 'HUB_CORE',
    'used', v_used,
    'reserved', v_reserved,
    'limit', v_limit,
    'remaining', case when v_limit is null then null
      else greatest(v_limit - v_used - v_reserved, 0)
    end,
    'periodEndsAt', v_reservation.period_end
  );
end;
$function$;

create or replace function private.hub_release_feature_internal(
  p_user_id uuid,
  p_reservation_id uuid,
  p_lease_token uuid,
  p_request_key uuid,
  p_reason text default 'REQUEST_FAILED'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := p_user_id;
  v_subscription_id uuid;
  v_reservation private.hub_usage_reservations%rowtype;
  v_reason text := pg_catalog.upper(
    coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'REQUEST_FAILED')
  );
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if p_reservation_id is null
     or p_lease_token is null
     or p_request_key is null then
    raise exception 'invalid_usage_release' using errcode = '22023';
  end if;
  if v_reason not in (
    'REQUEST_FAILED',
    'PROVIDER_FAILED',
    'PERSISTENCE_FAILED',
    'DELIVERY_FAILED',
    'CLIENT_ABORTED'
  ) then
    v_reason := 'REQUEST_FAILED';
  end if;

  select reservation.subscription_id into v_subscription_id
  from private.hub_usage_reservations as reservation
  where reservation.id = p_reservation_id;
  if v_subscription_id is null then
    return pg_catalog.jsonb_build_object(
      'released', false,
      'code', 'RESERVATION_NOT_FOUND'
    );
  end if;

  perform 1
  from public.hub_subscriptions as subscription
  where subscription.id = v_subscription_id
  for update;

  select reservation.* into v_reservation
  from private.hub_usage_reservations as reservation
  where reservation.id = p_reservation_id
    and reservation.subscription_id = v_subscription_id
    and reservation.user_id = v_user_id
    and reservation.request_key = p_request_key
    and reservation.lease_token = p_lease_token
  for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'released', false,
      'code', 'RESERVATION_NOT_FOUND'
    );
  end if;

  if v_reservation.status = 'COMMITTED' then
    return pg_catalog.jsonb_build_object(
      'released', false,
      'idempotent', true,
      'code', 'REQUEST_ALREADY_COMPLETED'
    );
  end if;
  if v_reservation.status = 'RELEASED' then
    return pg_catalog.jsonb_build_object(
      'released', true,
      'idempotent', true,
      'reservationId', v_reservation.id
    );
  end if;

  update private.hub_usage_reservations as reservation
  set status = 'RELEASED',
      release_reason = v_reason,
      released_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where reservation.id = v_reservation.id;

  return pg_catalog.jsonb_build_object(
    'released', true,
    'idempotent', false,
    'reservationId', v_reservation.id
  );
end;
$function$;

-- Backward-compatible immediate metering. It remains one transaction, now
-- accounts for live reservations and explicitly initializes/locks the first
-- counter row before incrementing it.
create or replace function private.hub_consume_feature_internal(
  p_feature_key text,
  p_units integer default 1,
  p_request_key uuid default null,
  p_account_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_account_id uuid;
  v_subscription public.hub_subscriptions%rowtype;
  v_feature_key text := nullif(pg_catalog.btrim(p_feature_key), '');
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_limit integer;
  v_reset text;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_used integer := 0;
  v_reserved integer := 0;
  v_existing_event bigint;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if v_feature_key is null
     or pg_catalog.char_length(v_feature_key) < 3
     or p_units is null
     or p_units < 0
     or p_units > 1000 then
    raise exception 'invalid_usage_request' using errcode = '22023';
  end if;
  if v_feature_key in (
    'educator_ai.generate',
    'wolfie.turn',
    'library.preview',
    'library.full_access'
  ) and p_units <> 1 then
    raise exception 'invalid_usage_request' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_metadata) <> 'object'
     or pg_catalog.pg_column_size(v_metadata) > 4096 then
    raise exception 'invalid_usage_metadata' using errcode = '22023';
  end if;
  if not private.hub_is_enabled() then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'HUB_DISABLED',
      'productFamily', 'HUB_CORE'
    );
  end if;
  if exists (
    select 1
    from public.profiles as profile
    where profile.id = v_user_id
      and profile.tenant_id = 'wolfie-direct'
  ) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'PRODUCT_SCOPE_FORBIDDEN',
      'productFamily', 'HUB_CORE'
    );
  end if;

  select membership.account_id into v_account_id
  from public.hub_memberships as membership
  join public.hub_accounts as account
    on account.id = membership.account_id
   and account.status = 'ACTIVE'
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
    and (p_account_id is null or membership.account_id = p_account_id)
  order by
    (membership.membership_role = 'OWNER') desc,
    (membership.membership_role = 'ADMIN') desc,
    membership.created_at,
    membership.id
  limit 1;
  if v_account_id is null then
    if exists (
      select 1
      from public.hub_memberships as membership
      join public.hub_accounts as account
        on account.id = membership.account_id
      where membership.user_id = v_user_id
        and membership.status <> 'REMOVED'
        and (p_account_id is null or membership.account_id = p_account_id)
        and (
          membership.status <> 'ACTIVE'
          or account.status <> 'ACTIVE'
        )
    ) then
      return pg_catalog.jsonb_build_object(
        'allowed', false,
        'code', 'HUB_ACCOUNT_INACTIVE',
        'productFamily', 'HUB_CORE'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'HUB_ACCOUNT_REQUIRED',
      'productFamily', 'HUB_CORE'
    );
  end if;

  select subscription.* into v_subscription
  from public.hub_subscriptions as subscription
  join public.hub_plans as plan
    on plan.id = subscription.plan_id
   and plan.product_family = 'HUB_CORE'
  where subscription.account_id = v_account_id
    and subscription.product_family = 'HUB_CORE'
    and (
      (
        subscription.status = 'TRIALING'
        and subscription.trial_ends_at > pg_catalog.now()
      )
      or (
        subscription.status = 'ACTIVE'
        and coalesce(
          subscription.current_period_ends_at,
          '-infinity'::timestamptz
        ) > pg_catalog.now()
      )
    )
  order by
    (subscription.status = 'ACTIVE') desc,
    subscription.created_at desc,
    subscription.id desc
  limit 1
  for update of subscription;
  if not found then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'SUBSCRIPTION_REQUIRED',
      'productFamily', 'HUB_CORE'
    );
  end if;

  select entitlement.limit_value, entitlement.reset_period
  into v_limit, v_reset
  from public.hub_plan_entitlements as entitlement
  where entitlement.plan_id = v_subscription.plan_id
    and entitlement.feature_key = v_feature_key;
  if not found or v_limit = 0 then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'FEATURE_NOT_INCLUDED',
      'productFamily', 'HUB_CORE'
    );
  end if;

  if p_request_key is not null then
    select usage_event.id into v_existing_event
    from public.hub_usage_events as usage_event
    where usage_event.subscription_id = v_subscription.id
      and usage_event.feature_key = v_feature_key
      and usage_event.request_key = p_request_key;
    if found then
      select coalesce(counter.used_units, 0) into v_used
      from public.hub_usage_counters as counter
      where counter.subscription_id = v_subscription.id
        and counter.feature_key = v_feature_key
        and pg_catalog.now() >= counter.period_start
        and pg_catalog.now() < counter.period_end
      order by counter.period_start desc
      limit 1;
      return pg_catalog.jsonb_build_object(
        'allowed', true,
        'idempotent', true,
        'subscriptionId', v_subscription.id,
        'productFamily', 'HUB_CORE',
        'used', coalesce(v_used, 0),
        'limit', v_limit,
        'remaining', case when v_limit is null then null
          else greatest(v_limit - coalesce(v_used, 0), 0)
        end
      );
    end if;
    if exists (
      select 1
      from private.hub_usage_reservations as reservation
      where reservation.subscription_id = v_subscription.id
        and reservation.feature_key = v_feature_key
        and reservation.request_key = p_request_key
    ) then
      return pg_catalog.jsonb_build_object(
        'allowed', false,
        'idempotent', true,
        'code', 'IDEMPOTENCY_KEY_REUSED',
        'subscriptionId', v_subscription.id,
        'productFamily', 'HUB_CORE'
      );
    end if;
  end if;

  if v_reset = 'DAY' then
    v_period_start := pg_catalog.date_trunc('day', pg_catalog.now());
    v_period_end := v_period_start + interval '1 day';
  elsif v_reset = 'SUBSCRIPTION' then
    v_period_start := coalesce(
      v_subscription.trial_starts_at,
      v_subscription.current_period_starts_at,
      v_subscription.created_at
    );
    v_period_end := coalesce(
      v_subscription.trial_ends_at,
      v_subscription.current_period_ends_at,
      'infinity'::timestamptz
    );
  else
    v_period_start := pg_catalog.date_trunc('month', pg_catalog.now());
    v_period_end := v_period_start + interval '1 month';
  end if;

  update private.hub_usage_reservations as expired_reservation
  set status = 'RELEASED',
      release_reason = 'LEASE_EXPIRED',
      released_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where expired_reservation.subscription_id = v_subscription.id
    and expired_reservation.feature_key = v_feature_key
    and expired_reservation.status = 'RESERVED'
    and expired_reservation.lease_expires_at <= pg_catalog.now();

  if p_units > 0 then
    insert into public.hub_usage_counters (
      account_id,
      subscription_id,
      feature_key,
      period_start,
      period_end,
      used_units
    ) values (
      v_account_id,
      v_subscription.id,
      v_feature_key,
      v_period_start,
      v_period_end,
      0
    ) on conflict (subscription_id, feature_key, period_start) do nothing;

    select counter.used_units into v_used
    from public.hub_usage_counters as counter
    where counter.subscription_id = v_subscription.id
      and counter.feature_key = v_feature_key
      and counter.period_start = v_period_start
    for update;
  else
    select counter.used_units into v_used
    from public.hub_usage_counters as counter
    where counter.subscription_id = v_subscription.id
      and counter.feature_key = v_feature_key
      and counter.period_start = v_period_start;
  end if;
  v_used := coalesce(v_used, 0);

  select coalesce(pg_catalog.sum(reservation.units), 0)::integer
  into v_reserved
  from private.hub_usage_reservations as reservation
  where reservation.subscription_id = v_subscription.id
    and reservation.feature_key = v_feature_key
    and reservation.period_start = v_period_start
    and reservation.period_end = v_period_end
    and reservation.status = 'RESERVED';

  if v_limit is not null and v_used + v_reserved + p_units > v_limit then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'USAGE_LIMIT_REACHED',
      'subscriptionId', v_subscription.id,
      'productFamily', 'HUB_CORE',
      'used', v_used,
      'reserved', v_reserved,
      'limit', v_limit,
      'remaining', greatest(v_limit - v_used - v_reserved, 0),
      'periodEndsAt', v_period_end
    );
  end if;

  if p_units > 0 then
    insert into public.hub_usage_events (
      account_id,
      subscription_id,
      user_id,
      feature_key,
      units,
      request_key,
      metadata
    ) values (
      v_account_id,
      v_subscription.id,
      v_user_id,
      v_feature_key,
      p_units,
      p_request_key,
      v_metadata
    );

    update public.hub_usage_counters as counter
    set used_units = counter.used_units + p_units,
        updated_at = pg_catalog.now()
    where counter.subscription_id = v_subscription.id
      and counter.feature_key = v_feature_key
      and counter.period_start = v_period_start
    returning counter.used_units into v_used;
  end if;

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'idempotent', false,
    'accountId', v_account_id,
    'subscriptionId', v_subscription.id,
    'productFamily', 'HUB_CORE',
    'used', v_used,
    'reserved', v_reserved,
    'limit', v_limit,
    'remaining', case when v_limit is null then null
      else greatest(v_limit - v_used - v_reserved, 0)
    end,
    'periodEndsAt', v_period_end
  );
end;
$function$;

drop function if exists public.hub_track_event(text,text,jsonb);
drop function if exists private.hub_track_event_internal(text,text,jsonb);

create or replace function private.hub_track_event_internal(
  p_event_name text,
  p_source text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_account_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_account_id uuid;
  v_active_account_count integer := 0;
  v_is_manager boolean := false;
  v_event_name text := pg_catalog.lower(
    coalesce(pg_catalog.btrim(p_event_name), '')
  );
  v_source text := pg_catalog.lower(
    coalesce(pg_catalog.btrim(p_source), '')
  );
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_plan_code text;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if not private.hub_is_enabled() then
    raise exception 'hub_disabled' using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_typeof(v_metadata) <> 'object'
     or pg_catalog.octet_length(v_metadata::text) > 1024 then
    raise exception 'invalid_hub_event_metadata' using errcode = '22023';
  end if;

  if p_account_id is null then
    select pg_catalog.count(*)::integer into v_active_account_count
    from public.hub_memberships as membership
    join public.hub_accounts as account
      on account.id = membership.account_id
     and account.status = 'ACTIVE'
    where membership.user_id = v_user_id
      and membership.status = 'ACTIVE';
    if v_active_account_count > 1 then
      raise exception 'hub_account_ambiguous' using errcode = 'P0001';
    end if;
  end if;

  select
    membership.account_id,
    membership.membership_role in ('OWNER', 'ADMIN')
  into v_account_id, v_is_manager
  from public.hub_memberships as membership
  join public.hub_accounts as account
    on account.id = membership.account_id
   and account.status = 'ACTIVE'
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
    and (p_account_id is null or membership.account_id = p_account_id)
  order by
    (membership.membership_role = 'OWNER') desc,
    (membership.membership_role = 'ADMIN') desc,
    membership.created_at,
    membership.id
  limit 1;
  if v_account_id is null then
    raise exception 'hub_account_required' using errcode = '42501';
  end if;

  if v_event_name = 'hub_trial_activated' then
    if not v_is_manager
       or v_source <> 'hub_onboarding'
       or v_metadata ->> 'audience' is distinct from 'EDUCATOR'
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_metadata) as key(name)
         where key.name <> 'audience'
       ) then
      raise exception 'invalid_hub_event' using errcode = '22023';
    end if;
    v_metadata := pg_catalog.jsonb_build_object(
      'audience', v_metadata ->> 'audience'
    );
  elsif v_event_name = 'plan_interest' then
    v_plan_code := pg_catalog.upper(
      coalesce(pg_catalog.btrim(v_metadata ->> 'planCode'), '')
    );
    if v_source <> 'hub_plans'
       or v_plan_code !~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'
       or not exists (
         select 1
         from public.hub_plans as plan
         where plan.code = v_plan_code
           and plan.product_family = 'HUB_CORE'
           and plan.is_active = true
           and plan.is_public = true
       )
       or exists (
         select 1
         from pg_catalog.jsonb_object_keys(v_metadata) as key(name)
         where key.name <> 'planCode'
       ) then
      raise exception 'invalid_hub_event' using errcode = '22023';
    end if;
    v_metadata := pg_catalog.jsonb_build_object('planCode', v_plan_code);
  elsif v_event_name = 'saas_cta_click' then
    if v_source <> 'hub_portal'
       or v_metadata <> '{}'::jsonb then
      raise exception 'invalid_hub_event' using errcode = '22023';
    end if;
  else
    raise exception 'invalid_hub_event' using errcode = '22023';
  end if;

  insert into public.hub_conversion_events (
    account_id,
    user_id,
    event_name,
    source,
    metadata
  ) values (
    v_account_id,
    v_user_id,
    v_event_name,
    v_source,
    v_metadata
  );
end;
$function$;

create or replace function public.hub_claim_trial(
  p_audience text default 'EDUCATOR',
  p_account_name text default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_claim_trial_internal(p_audience, p_account_name);
$function$;

create or replace function public.hub_bootstrap(p_account_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select private.hub_bootstrap_internal(p_account_id);
$function$;

create or replace function public.hub_list_accounts()
returns table (
  id uuid,
  name text,
  audience text,
  account_type text,
  status text,
  membership_role text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select * from private.hub_list_accounts_internal();
$function$;

create or replace function public.hub_consume_feature(
  p_feature_key text,
  p_units integer default 1,
  p_request_key uuid default null,
  p_account_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_consume_feature_internal(
    p_feature_key,
    p_units,
    p_request_key,
    p_account_id,
    p_metadata
  );
$function$;

create or replace function public.hub_reserve_feature(
  p_user_id uuid,
  p_feature_key text,
  p_units integer,
  p_request_key uuid,
  p_request_fingerprint text,
  p_account_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_reserve_feature_internal(
    p_user_id,
    p_feature_key,
    p_units,
    p_request_key,
    p_request_fingerprint,
    p_account_id,
    p_metadata
  );
$function$;

create or replace function public.hub_commit_feature(
  p_user_id uuid,
  p_reservation_id uuid,
  p_lease_token uuid,
  p_request_key uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_commit_feature_internal(
    p_user_id,
    p_reservation_id,
    p_lease_token,
    p_request_key
  );
$function$;

create or replace function public.hub_release_feature(
  p_user_id uuid,
  p_reservation_id uuid,
  p_lease_token uuid,
  p_request_key uuid,
  p_reason text default 'REQUEST_FAILED'
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_release_feature_internal(
    p_user_id,
    p_reservation_id,
    p_lease_token,
    p_request_key,
    p_reason
  );
$function$;

create or replace function public.hub_track_event(
  p_event_name text,
  p_source text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_account_id uuid default null
)
returns void
language sql
security invoker
set search_path = ''
as $function$
  select private.hub_track_event_internal(
    p_event_name,
    p_source,
    p_metadata,
    p_account_id
  );
$function$;

-- Members may use entitled product features through the RPCs, but raw
-- billing, quota and event rows are visible only to active account managers.
drop policy if exists hub_subscriptions_select_members
  on public.hub_subscriptions;
drop policy if exists hub_subscriptions_select_managers
  on public.hub_subscriptions;
create policy hub_subscriptions_select_managers
  on public.hub_subscriptions
  for select
  to authenticated
  using ((select private.hub_is_account_manager(account_id)));

drop policy if exists hub_checkout_sessions_select_members
  on public.hub_checkout_sessions;
drop policy if exists hub_checkout_sessions_select_managers
  on public.hub_checkout_sessions;
create policy hub_checkout_sessions_select_managers
  on public.hub_checkout_sessions
  for select
  to authenticated
  using ((select private.hub_is_account_manager(account_id)));

drop policy if exists hub_usage_counters_select_members
  on public.hub_usage_counters;
drop policy if exists hub_usage_counters_select_managers
  on public.hub_usage_counters;
create policy hub_usage_counters_select_managers
  on public.hub_usage_counters
  for select
  to authenticated
  using ((select private.hub_is_account_manager(account_id)));

drop policy if exists hub_usage_events_select_members
  on public.hub_usage_events;
drop policy if exists hub_usage_events_select_managers
  on public.hub_usage_events;
create policy hub_usage_events_select_managers
  on public.hub_usage_events
  for select
  to authenticated
  using ((select private.hub_is_account_manager(account_id)));

drop policy if exists hub_content_access_select_members
  on public.hub_content_access_events;
drop policy if exists hub_content_access_select_managers
  on public.hub_content_access_events;
create policy hub_content_access_select_managers
  on public.hub_content_access_events
  for select
  to authenticated
  using ((select private.hub_is_account_manager(account_id)));

drop policy if exists hub_conversion_events_select_members
  on public.hub_conversion_events;
drop policy if exists hub_conversion_events_select_managers
  on public.hub_conversion_events;
create policy hub_conversion_events_select_managers
  on public.hub_conversion_events
  for select
  to authenticated
  using (
    account_id is not null
    and (select private.hub_is_account_manager(account_id))
  );

drop policy if exists hub_settings_public_read
  on public.hub_settings;
revoke select on table public.hub_settings from anon, authenticated;

-- Direct account reads are column-limited. Provider IDs, owner_user_id and
-- arbitrary metadata are available only through trusted server-side flows.
revoke select on table public.hub_accounts from authenticated;
grant select (
  id,
  account_type,
  audience,
  name,
  status,
  trial_claimed_at,
  created_at,
  updated_at
) on table public.hub_accounts to authenticated;

revoke all on function private.hub_is_enabled()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_enforce_active_subscription_guard()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_enforce_account_billing_transition_guard()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_public_settings_internal()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_is_internal_manager()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_set_enabled_internal(boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_finalize_account_status_internal(
  uuid,text,text[],uuid,text
) from public, anon, authenticated, service_role;
revoke all on function private.expire_hub_trials_internal()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_has_account_access(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_is_account_manager(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_claim_trial_internal(text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_bootstrap_internal(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_list_accounts_internal()
  from public, anon, authenticated, service_role;
revoke all on function private.hub_consume_feature_internal(
  text,integer,uuid,uuid,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.hub_reserve_feature_internal(
  uuid,text,integer,uuid,text,uuid,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.hub_commit_feature_internal(uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_release_feature_internal(uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_track_event_internal(text,text,jsonb,uuid)
  from public, anon, authenticated, service_role;

grant usage on schema private to authenticated, service_role;
grant execute on function private.hub_set_enabled_internal(boolean)
  to authenticated, service_role;
grant execute on function private.hub_finalize_account_status_internal(
  uuid,text,text[],uuid,text
) to service_role;
grant execute on function private.hub_has_account_access(uuid)
  to authenticated;
grant execute on function private.hub_is_account_manager(uuid)
  to authenticated;
grant execute on function private.hub_claim_trial_internal(text,text)
  to authenticated;
grant execute on function private.hub_bootstrap_internal(uuid)
  to authenticated;
grant execute on function private.hub_list_accounts_internal()
  to authenticated;
grant execute on function private.hub_reserve_feature_internal(
  uuid,text,integer,uuid,text,uuid,jsonb
) to service_role;
grant execute on function private.hub_commit_feature_internal(uuid,uuid,uuid,uuid)
  to service_role;
grant execute on function private.hub_release_feature_internal(uuid,uuid,uuid,uuid,text)
  to service_role;
grant execute on function private.hub_track_event_internal(text,text,jsonb,uuid)
  to authenticated;

revoke all on function public.hub_get_public_settings()
  from public, anon, authenticated, service_role;
revoke all on function public.hub_set_enabled(boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hub_finalize_account_status_change(
  uuid,text,text[],uuid,text
) from public, anon, authenticated, service_role;
revoke all on function public.hub_claim_trial(text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.hub_bootstrap(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hub_list_accounts()
  from public, anon, authenticated, service_role;
revoke all on function public.hub_consume_feature(
  text,integer,uuid,uuid,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.hub_reserve_feature(
  uuid,text,integer,uuid,text,uuid,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.hub_commit_feature(uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hub_release_feature(uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.hub_track_event(text,text,jsonb,uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.hub_get_public_settings()
  to anon, authenticated;
grant execute on function public.hub_set_enabled(boolean)
  to authenticated, service_role;
grant execute on function public.hub_finalize_account_status_change(
  uuid,text,text[],uuid,text
) to service_role;
grant execute on function public.hub_claim_trial(text,text)
  to authenticated;
grant execute on function public.hub_bootstrap(uuid)
  to authenticated;
grant execute on function public.hub_list_accounts()
  to authenticated;
grant execute on function public.hub_reserve_feature(
  uuid,text,integer,uuid,text,uuid,jsonb
) to service_role;
grant execute on function public.hub_commit_feature(uuid,uuid,uuid,uuid)
  to service_role;
grant execute on function public.hub_release_feature(uuid,uuid,uuid,uuid,text)
  to service_role;
grant execute on function public.hub_track_event(text,text,jsonb,uuid)
  to authenticated;

comment on function public.hub_set_enabled(boolean) is
  'Internal kill switch for Hub Core. Preserves all other settings metadata.';
comment on function public.hub_finalize_account_status_change(
  uuid,text,text[],uuid,text
) is
  'Service-only finalization after every live provider recurrence was cancelled.';
comment on function public.hub_reserve_feature(
  uuid,text,integer,uuid,text,uuid,jsonb
) is
  'Service-only reservation of Hub Core quota for one fingerprinted request.';
comment on function public.hub_commit_feature(uuid,uuid,uuid,uuid) is
  'Commits a valid Hub quota reservation after successful product work.';
comment on function public.hub_release_feature(uuid,uuid,uuid,uuid,text) is
  'Releases a Hub quota reservation after provider, persistence or delivery failure.';
comment on function private.expire_hub_trials_internal() is
  'Idempotently expires elapsed Hub trials. Owner/pg_cron only.';

commit;
