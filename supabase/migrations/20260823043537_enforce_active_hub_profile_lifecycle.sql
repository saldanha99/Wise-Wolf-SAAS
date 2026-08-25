-- Enforce active-profile lifecycle across Hub access and privileged RPCs.
-- Follow-up migration: the foundational migration is already immutable in production.
begin;

create or replace function private.hub_profile_is_active(
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_user_id is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = p_user_id
        and pg_catalog.lower(pg_catalog.btrim(profile.lifecycle_status)) = 'active'
    );
$function$;

-- Billing activation is guarded at the database boundary as well as in the
-- Edge Functions. This closes the suspension/kill-switch race between a paid
-- provider event and the local subscription write.
create or replace function private.hub_is_internal_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
    or (
      private.hub_profile_is_active((select auth.uid()))
      and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.role = 'SUPER_ADMIN'
      )
    );
$function$;

create or replace function private.hub_has_account_access(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.hub_is_enabled()
    and private.hub_profile_is_active((select auth.uid()))
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
    and private.hub_profile_is_active((select auth.uid()))
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
  v_membership public.hub_memberships%rowtype;
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
  if pg_catalog.lower(pg_catalog.btrim(v_profile.lifecycle_status)) <> 'active' then
    raise exception 'profile_inactive' using errcode = '42501';
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

    select membership.* into v_membership
    from public.hub_memberships as membership
    where membership.account_id = v_account.id
      and membership.user_id = v_user_id
    for update;
    if not found
      or v_membership.membership_role <> 'OWNER'
      or v_membership.status <> 'ACTIVE'
    then
      raise exception 'hub_membership_inactive' using errcode = '42501';
    end if;
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
  if not private.hub_profile_is_active(v_user_id) then
    raise exception 'profile_inactive' using errcode = '42501';
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
    and private.hub_profile_is_active(auth.uid())
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
  if not private.hub_profile_is_active(v_user_id) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'PROFILE_INACTIVE',
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
  if not private.hub_profile_is_active(v_user_id) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'PROFILE_INACTIVE',
      'productFamily', 'HUB_CORE'
    );
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
  if not private.hub_profile_is_active(v_user_id) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'PROFILE_INACTIVE',
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
  if not private.hub_profile_is_active(v_user_id) then
    raise exception 'profile_inactive' using errcode = '42501';
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

revoke all on function private.hub_profile_is_active(uuid)
  from public, anon, authenticated, service_role;

commit;
