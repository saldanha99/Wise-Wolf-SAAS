-- Make Hub onboarding idempotent and keep personalization writes behind a
-- narrow server-side contract. This migration is safe for accounts created by
-- an interrupted first-access flow: an account without any subscription can
-- still receive its one Discovery trial.

create or replace function private.hub_claim_trial_internal(
  p_audience text default 'EDUCATOR',
  p_account_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_account public.hub_accounts%rowtype;
  v_plan public.hub_plans%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_audience text := upper(coalesce(nullif(trim(p_audience), ''), 'EDUCATOR'));
  v_name text;
  v_had_subscription boolean := false;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if v_audience not in ('LEARNER', 'EDUCATOR', 'INSTITUTION') then
    raise exception 'invalid_audience' using errcode = '22023';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id;
  if not found then
    raise exception 'profile_required' using errcode = 'P0001';
  end if;

  select account.* into v_account
  from public.hub_accounts account
  join public.hub_memberships membership on membership.account_id = account.id
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
  order by (membership.membership_role = 'OWNER') desc, account.created_at
  limit 1;

  if not found then
    v_name := coalesce(
      nullif(trim(p_account_name), ''),
      nullif(trim(v_profile.full_name), ''),
      split_part(coalesce(v_profile.email, 'Conta Wise Wolf'), '@', 1)
    );
    insert into public.hub_accounts (
      account_type, audience, name, owner_user_id, status
    ) values (
      case when v_audience = 'INSTITUTION' then 'ORGANIZATION' else 'PERSONAL' end,
      v_audience,
      left(v_name, 160),
      v_user_id,
      'ACTIVE'
    ) returning * into v_account;

    insert into public.hub_memberships (account_id, user_id, membership_role, status)
    values (v_account.id, v_user_id, 'OWNER', 'ACTIVE');

    perform set_config('app.enrollment_claim', '1', true);
    update public.profiles
       set role = 'NON_STUDENT'
     where id = v_user_id
       and role = 'STUDENT'
       and tenant_id is null;
  end if;

  select * into v_subscription
  from public.hub_subscriptions
  where account_id = v_account.id
    and status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
  order by created_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'accountId', v_account.id,
      'subscriptionId', v_subscription.id,
      'status', v_subscription.status,
      'trialEndsAt', v_subscription.trial_ends_at,
      'alreadyActive', true
    );
  end if;

  select exists (
    select 1 from public.hub_subscriptions history
    where history.account_id = v_account.id
  ) into v_had_subscription;

  if v_had_subscription then
    raise exception 'trial_already_claimed' using errcode = 'P0001';
  end if;

  select * into v_plan
  from public.hub_plans
  where code = 'DISCOVERY' and is_active = true;
  if not found then
    raise exception 'discovery_plan_unavailable' using errcode = 'P0001';
  end if;

  insert into public.hub_subscriptions (
    account_id, plan_id, status, trial_starts_at, trial_ends_at,
    current_period_starts_at, current_period_ends_at,
    metadata
  ) values (
    v_account.id, v_plan.id, 'TRIALING', now(),
    now() + make_interval(days => greatest(v_plan.trial_days, 1)),
    now(), now() + make_interval(days => greatest(v_plan.trial_days, 1)),
    jsonb_build_object('source', 'hub_onboarding')
  ) returning * into v_subscription;

  update public.hub_accounts
     set trial_claimed_at = coalesce(trial_claimed_at, now()),
         audience = v_audience,
         account_type = case when v_audience = 'INSTITUTION' then 'ORGANIZATION' else account_type end
   where id = v_account.id
   returning * into v_account;

  return jsonb_build_object(
    'accountId', v_account.id,
    'subscriptionId', v_subscription.id,
    'status', v_subscription.status,
    'trialEndsAt', v_subscription.trial_ends_at,
    'alreadyActive', false
  );
end;
$$;

create or replace function private.hub_update_preferences_internal(
  p_account_id uuid,
  p_preferences jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_preferences jsonb := coalesce(p_preferences, '{}'::jsonb);
  v_account public.hub_accounts%rowtype;
  v_level text := upper(coalesce(v_preferences->>'level', ''));
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if not private.hub_is_account_manager(p_account_id) then
    raise exception 'hub_manager_required' using errcode = '42501';
  end if;
  if jsonb_typeof(v_preferences) <> 'object' then
    raise exception 'invalid_preferences' using errcode = '22023';
  end if;
  if v_level <> '' and v_level not in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2') then
    raise exception 'invalid_cefr_level' using errcode = '22023';
  end if;
  if length(coalesce(v_preferences->>'role', '')) > 120
     or length(coalesce(v_preferences->>'goal', '')) > 320
     or length(coalesce(v_preferences->>'interests', '')) > 320 then
    raise exception 'preferences_too_long' using errcode = '22023';
  end if;

  update public.hub_accounts
     set metadata = metadata || jsonb_build_object(
       'onboarding_completed', true,
       'level', nullif(v_level, ''),
       'role', nullif(trim(v_preferences->>'role'), ''),
       'goal', nullif(trim(v_preferences->>'goal'), ''),
       'interests', nullif(trim(v_preferences->>'interests'), ''),
       'preferred_modality', case
         when v_preferences->>'preferred_modality' in ('text', 'voice', 'mixed')
           then v_preferences->>'preferred_modality'
         else 'mixed'
       end,
       'personalized_at', now()
     )
   where id = p_account_id
   returning * into v_account;

  return to_jsonb(v_account);
end;
$$;

create or replace function public.hub_update_preferences(
  p_account_id uuid,
  p_preferences jsonb
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog, public, private
as $$ select private.hub_update_preferences_internal(p_account_id, p_preferences); $$;

revoke all on function private.hub_update_preferences_internal(uuid,jsonb) from public;
grant execute on function private.hub_update_preferences_internal(uuid,jsonb) to authenticated;
revoke all on function public.hub_update_preferences(uuid,jsonb) from public;
grant execute on function public.hub_update_preferences(uuid,jsonb) to authenticated;

comment on function public.hub_update_preferences(uuid,jsonb) is
  'Stores validated Hub onboarding preferences for an account manager.';

alter table public.hub_checkout_sessions
  add column if not exists request_key uuid;

create unique index if not exists hub_checkout_sessions_request_key_unique
  on public.hub_checkout_sessions(requested_by, request_key)
  where request_key is not null;

comment on column public.hub_checkout_sessions.request_key is
  'Client-generated idempotency key. One checkout intent per user and key.';
