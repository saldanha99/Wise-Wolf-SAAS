-- Isolate Hub member personalization and educator learner data by account.
-- Account authority and product persona are independent. Manager personas are
-- derived from account audience; MEMBER personas must be explicitly classified.

begin;

alter table public.hub_memberships
  add column if not exists subject_role text;

do $block$
begin
  if exists (
    select 1
    from public.hub_memberships as membership
    where membership.membership_role = 'MEMBER'
      and membership.subject_role is null
  ) then
    raise exception 'hub_member_subject_role_backfill_required'
      using errcode = 'P0001';
  end if;
end
$block$;

update public.hub_memberships as membership
set subject_role = case
  when membership.membership_role in ('OWNER', 'ADMIN') then
    case when account.audience = 'LEARNER' then 'LEARNER' else 'EDUCATOR' end
  when membership.subject_role in ('LEARNER', 'EDUCATOR')
    then membership.subject_role
  else 'LEARNER'
end
from public.hub_accounts as account
where account.id = membership.account_id
  and membership.subject_role is distinct from case
    when membership.membership_role in ('OWNER', 'ADMIN') then
      case when account.audience = 'LEARNER' then 'LEARNER' else 'EDUCATOR' end
    when membership.subject_role in ('LEARNER', 'EDUCATOR')
      then membership.subject_role
    else 'LEARNER'
  end;

alter table public.hub_memberships
  alter column subject_role set default 'LEARNER';
alter table public.hub_memberships
  alter column subject_role set not null;

do $block$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'hub_memberships_subject_role_check'
      and conrelid = 'public.hub_memberships'::pg_catalog.regclass
  ) then
    alter table public.hub_memberships
      add constraint hub_memberships_subject_role_check
      check (
        membership_role in ('OWNER', 'ADMIN', 'MEMBER')
        and subject_role in ('LEARNER', 'EDUCATOR')
      );
  end if;
end
$block$;

create or replace function private.hub_enforce_membership_subject_role()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_account_audience text;
begin
  if new.membership_role in ('OWNER', 'ADMIN') then
    select account.audience
    into v_account_audience
    from public.hub_accounts as account
    where account.id = new.account_id;

    new.subject_role := case
      when v_account_audience = 'LEARNER' then 'LEARNER'
      else 'EDUCATOR'
    end;
  elsif new.membership_role = 'MEMBER' then
    new.subject_role := coalesce(new.subject_role, 'LEARNER');
    if new.subject_role not in ('LEARNER', 'EDUCATOR') then
      raise exception 'invalid_hub_subject_role' using errcode = '22023';
    end if;
  else
    raise exception 'invalid_hub_membership_role' using errcode = '22023';
  end if;

  return new;
end;
$function$;

alter function private.hub_enforce_membership_subject_role()
  owner to postgres;
revoke all on function private.hub_enforce_membership_subject_role()
  from public, anon, authenticated, service_role;

drop trigger if exists hub_memberships_enforce_subject_role
  on public.hub_memberships;
create trigger hub_memberships_enforce_subject_role
before insert or update of membership_role, subject_role
on public.hub_memberships
for each row execute function private.hub_enforce_membership_subject_role();

create or replace function private.hub_sync_manager_subject_roles()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  update public.hub_memberships as membership
  set subject_role = case
    when new.audience = 'LEARNER' then 'LEARNER'
    else 'EDUCATOR'
  end,
      updated_at = pg_catalog.now()
  where membership.account_id = new.id
    and membership.membership_role in ('OWNER', 'ADMIN');

  return new;
end;
$function$;

alter function private.hub_sync_manager_subject_roles()
  owner to postgres;
revoke all on function private.hub_sync_manager_subject_roles()
  from public, anon, authenticated, service_role;

drop trigger if exists hub_accounts_sync_manager_subject_roles
  on public.hub_accounts;
create trigger hub_accounts_sync_manager_subject_roles
after update of audience
on public.hub_accounts
for each row
when (old.audience is distinct from new.audience)
execute function private.hub_sync_manager_subject_roles();

create table if not exists public.hub_member_profiles (
  account_id uuid not null,
  user_id uuid not null,
  display_name text not null,
  level text,
  role text,
  goal text,
  interests text,
  preferred_modality text not null default 'mixed',
  onboarding_completed boolean not null default false,
  personalized_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (account_id, user_id),
  foreign key (account_id, user_id)
    references public.hub_memberships(account_id, user_id)
    on delete cascade,
  constraint hub_member_profiles_display_name_check
    check (
      pg_catalog.char_length(pg_catalog.btrim(display_name)) between 1 and 120
    ),
  constraint hub_member_profiles_level_check
    check (level is null or level in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  constraint hub_member_profiles_role_check
    check (role is null or pg_catalog.char_length(role) <= 120),
  constraint hub_member_profiles_goal_check
    check (goal is null or pg_catalog.char_length(goal) <= 320),
  constraint hub_member_profiles_interests_check
    check (interests is null or pg_catalog.char_length(interests) <= 320),
  constraint hub_member_profiles_modality_check
    check (preferred_modality in ('text', 'voice', 'mixed'))
);

create index if not exists hub_member_profiles_user_idx
  on public.hub_member_profiles(user_id, account_id);

insert into public.hub_member_profiles (
  account_id,
  user_id,
  display_name,
  level,
  role,
  goal,
  interests,
  preferred_modality,
  onboarding_completed,
  personalized_at,
  created_at,
  updated_at
)
select
  membership.account_id,
  membership.user_id,
  pg_catalog.left(
    coalesce(
      nullif(
        pg_catalog.btrim(
          pg_catalog.regexp_replace(
            coalesce(profile.full_name, ''),
            '[[:space:]]+',
            ' ',
            'g'
          )
        ),
        ''
      ),
      nullif(
        pg_catalog.btrim(
          pg_catalog.regexp_replace(
            coalesce(account.name, ''),
            '[[:space:]]+',
            ' ',
            'g'
          )
        ),
        ''
      ),
      'Membro do Hub'
    ),
    120
  ),
  case
    when pg_catalog.upper(
      pg_catalog.btrim(coalesce(account.metadata ->> 'level', ''))
    ) in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
      then pg_catalog.upper(
        pg_catalog.btrim(account.metadata ->> 'level')
      )
    else null
  end,
  pg_catalog.left(
    nullif(pg_catalog.btrim(account.metadata ->> 'role'), ''),
    120
  ),
  pg_catalog.left(
    nullif(pg_catalog.btrim(account.metadata ->> 'goal'), ''),
    320
  ),
  pg_catalog.left(
    nullif(pg_catalog.btrim(account.metadata ->> 'interests'), ''),
    320
  ),
  case
    when pg_catalog.lower(
      pg_catalog.btrim(coalesce(account.metadata ->> 'preferred_modality', ''))
    ) in ('text', 'voice', 'mixed')
      then pg_catalog.lower(
        pg_catalog.btrim(account.metadata ->> 'preferred_modality')
      )
    else 'mixed'
  end,
  case
    when pg_catalog.jsonb_typeof(
      account.metadata -> 'onboarding_completed'
    ) = 'boolean'
      then (account.metadata ->> 'onboarding_completed')::boolean
    else false
  end,
  case
    when pg_catalog.jsonb_typeof(account.metadata -> 'personalized_at') = 'string'
      and pg_catalog.pg_input_is_valid(
        account.metadata ->> 'personalized_at',
        'timestamp with time zone'
      )
      then (account.metadata ->> 'personalized_at')::timestamptz
    else null
  end,
  membership.created_at,
  greatest(membership.updated_at, account.updated_at)
from public.hub_memberships as membership
join public.hub_accounts as account
  on account.id = membership.account_id
left join public.profiles as profile
  on profile.id = membership.user_id
on conflict (account_id, user_id) do nothing;

create or replace function private.hub_seed_member_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_display_name text;
begin
  select pg_catalog.left(
    coalesce(
      nullif(
        pg_catalog.btrim(
          pg_catalog.regexp_replace(
            coalesce(profile.full_name, ''),
            '[[:space:]]+',
            ' ',
            'g'
          )
        ),
        ''
      ),
      nullif(
        pg_catalog.btrim(
          pg_catalog.regexp_replace(
            coalesce(account.name, ''),
            '[[:space:]]+',
            ' ',
            'g'
          )
        ),
        ''
      ),
      'Membro do Hub'
    ),
    120
  )
  into v_display_name
  from public.hub_accounts as account
  left join public.profiles as profile
    on profile.id = new.user_id
  where account.id = new.account_id;

  if v_display_name is null then
    raise exception 'hub_account_missing' using errcode = '23503';
  end if;

  insert into public.hub_member_profiles (
    account_id,
    user_id,
    display_name
  ) values (
    new.account_id,
    new.user_id,
    v_display_name
  )
  on conflict (account_id, user_id) do nothing;

  return new;
end;
$function$;

alter function private.hub_seed_member_profile()
  owner to postgres;
revoke all on function private.hub_seed_member_profile()
  from public, anon, authenticated, service_role;

drop trigger if exists hub_memberships_seed_member_profile
  on public.hub_memberships;
create trigger hub_memberships_seed_member_profile
after insert or update of status
on public.hub_memberships
for each row execute function private.hub_seed_member_profile();

drop trigger if exists hub_member_profiles_set_updated_at
  on public.hub_member_profiles;
create trigger hub_member_profiles_set_updated_at
before update on public.hub_member_profiles
for each row execute function private.hub_set_updated_at();

create or replace function private.hub_guard_member_profile_scope()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.account_id is distinct from old.account_id
     or new.user_id is distinct from old.user_id then
    raise exception 'hub_member_profile_scope_is_immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

alter function private.hub_guard_member_profile_scope()
  owner to postgres;
revoke all on function private.hub_guard_member_profile_scope()
  from public, anon, authenticated, service_role;

drop trigger if exists hub_member_profiles_guard_scope
  on public.hub_member_profiles;
create trigger hub_member_profiles_guard_scope
before update of account_id, user_id on public.hub_member_profiles
for each row execute function private.hub_guard_member_profile_scope();

alter table public.hub_member_profiles enable row level security;

drop policy if exists hub_member_profiles_select_own
  on public.hub_member_profiles;
drop policy if exists hub_member_profiles_update_own
  on public.hub_member_profiles;

create policy hub_member_profiles_select_own
on public.hub_member_profiles
for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.hub_has_account_access(account_id))
);

create policy hub_member_profiles_update_own
on public.hub_member_profiles
for update
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.hub_has_account_access(account_id))
)
with check (
  user_id = (select auth.uid())
  and (select private.hub_has_account_access(account_id))
);

revoke all on table public.hub_member_profiles
  from public, anon, authenticated;
grant all on table public.hub_member_profiles to service_role;

create or replace function public.hub_get_member_profile(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if p_account_id is null then
    raise exception 'invalid_account_id' using errcode = '22023';
  end if;
  if not private.hub_has_account_access(p_account_id) then
    raise exception 'hub_account_access_denied' using errcode = '42501';
  end if;

  select pg_catalog.jsonb_build_object(
    'accountId', member_profile.account_id,
    'displayName', member_profile.display_name,
    'subjectRole', membership.subject_role,
    'onboarding_completed', member_profile.onboarding_completed,
    'level', member_profile.level,
    'role', member_profile.role,
    'goal', member_profile.goal,
    'interests', member_profile.interests,
    'preferred_modality', member_profile.preferred_modality,
    'personalized_at', member_profile.personalized_at
  )
  into v_result
  from public.hub_member_profiles as member_profile
  join public.hub_memberships as membership
    on membership.account_id = member_profile.account_id
   and membership.user_id = member_profile.user_id
   and membership.status = 'ACTIVE'
  where member_profile.account_id = p_account_id
    and member_profile.user_id = v_user_id;

  if v_result is null then
    raise exception 'hub_member_profile_missing' using errcode = 'P0001';
  end if;

  return v_result;
end;
$function$;

alter function public.hub_get_member_profile(uuid) owner to postgres;
revoke all on function public.hub_get_member_profile(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.hub_get_member_profile(uuid)
  to authenticated;

create or replace function public.hub_update_member_preferences(
  p_account_id uuid,
  p_preferences jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_preferences jsonb := coalesce(p_preferences, '{}'::jsonb);
  v_display_name text;
  v_level text;
  v_role text;
  v_goal text;
  v_interests text;
  v_preferred_modality text;
  v_updated_at timestamptz := pg_catalog.clock_timestamp();
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if p_account_id is null then
    raise exception 'invalid_account_id' using errcode = '22023';
  end if;
  if not private.hub_has_account_access(p_account_id) then
    raise exception 'hub_account_access_denied' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(v_preferences) <> 'object' then
    raise exception 'invalid_preferences' using errcode = '22023';
  end if;
  if pg_catalog.octet_length(v_preferences::text) > 2048 then
    raise exception 'preferences_too_large' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(v_preferences) as supplied(key)
    where not (
      supplied.key = any (
        array[
          'display_name',
          'level',
          'role',
          'goal',
          'interests',
          'preferred_modality'
        ]::text[]
      )
    )
  ) then
    raise exception 'unsupported_preference_key' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_each(v_preferences) as supplied(key, value)
    where pg_catalog.jsonb_typeof(supplied.value) not in ('string', 'null')
  ) then
    raise exception 'invalid_preference_value' using errcode = '22023';
  end if;

  if v_preferences ? 'display_name' then
    v_display_name := pg_catalog.btrim(
      pg_catalog.regexp_replace(
        coalesce(v_preferences ->> 'display_name', ''),
        '[[:space:]]+',
        ' ',
        'g'
      )
    );
    if pg_catalog.char_length(v_display_name) < 1
       or pg_catalog.char_length(v_display_name) > 120 then
      raise exception 'invalid_display_name' using errcode = '22023';
    end if;
  end if;

  if v_preferences ? 'level' then
    v_level := nullif(
      pg_catalog.upper(
        pg_catalog.btrim(coalesce(v_preferences ->> 'level', ''))
      ),
      ''
    );
    if v_level is not null
       and v_level not in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2') then
      raise exception 'invalid_cefr_level' using errcode = '22023';
    end if;
  end if;

  if v_preferences ? 'role' then
    v_role := nullif(
      pg_catalog.btrim(coalesce(v_preferences ->> 'role', '')),
      ''
    );
    if pg_catalog.char_length(coalesce(v_role, '')) > 120 then
      raise exception 'role_too_long' using errcode = '22023';
    end if;
  end if;

  if v_preferences ? 'goal' then
    v_goal := nullif(
      pg_catalog.btrim(coalesce(v_preferences ->> 'goal', '')),
      ''
    );
    if pg_catalog.char_length(coalesce(v_goal, '')) > 320 then
      raise exception 'goal_too_long' using errcode = '22023';
    end if;
  end if;

  if v_preferences ? 'interests' then
    v_interests := nullif(
      pg_catalog.btrim(coalesce(v_preferences ->> 'interests', '')),
      ''
    );
    if pg_catalog.char_length(coalesce(v_interests, '')) > 320 then
      raise exception 'interests_too_long' using errcode = '22023';
    end if;
  end if;

  if v_preferences ? 'preferred_modality' then
    v_preferred_modality := pg_catalog.lower(
      pg_catalog.btrim(
        coalesce(v_preferences ->> 'preferred_modality', '')
      )
    );
    if v_preferred_modality = '' then
      v_preferred_modality := 'mixed';
    elsif v_preferred_modality not in ('text', 'voice', 'mixed') then
      raise exception 'invalid_preferred_modality' using errcode = '22023';
    end if;
  end if;

  update public.hub_member_profiles as member_profile
  set display_name = case
        when v_preferences ? 'display_name' then v_display_name
        else member_profile.display_name
      end,
      level = case
        when v_preferences ? 'level' then v_level
        else member_profile.level
      end,
      role = case
        when v_preferences ? 'role' then v_role
        else member_profile.role
      end,
      goal = case
        when v_preferences ? 'goal' then v_goal
        else member_profile.goal
      end,
      interests = case
        when v_preferences ? 'interests' then v_interests
        else member_profile.interests
      end,
      preferred_modality = case
        when v_preferences ? 'preferred_modality'
          then v_preferred_modality
        else member_profile.preferred_modality
      end,
      onboarding_completed = true,
      personalized_at = v_updated_at,
      updated_at = v_updated_at
  where member_profile.account_id = p_account_id
    and member_profile.user_id = v_user_id
    and exists (
      select 1
      from public.hub_memberships as membership
      where membership.account_id = member_profile.account_id
        and membership.user_id = member_profile.user_id
        and membership.status = 'ACTIVE'
    )
  returning member_profile.updated_at into v_updated_at;

  if not found then
    raise exception 'hub_member_profile_missing' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'accountId', p_account_id,
    'updatedAt', v_updated_at
  );
end;
$function$;

alter function public.hub_update_member_preferences(uuid, jsonb)
  owner to postgres;
revoke all on function public.hub_update_member_preferences(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.hub_update_member_preferences(uuid, jsonb)
  to authenticated;

-- The legacy private bootstrap still builds account-level personalization.
-- Preserve its response contract and access codes, but remove that shared
-- metadata at the exposed boundary now that personalization is member-owned.
create or replace function public.hub_bootstrap(
  p_account_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with bootstrap as materialized (
    select private.hub_bootstrap_internal(p_account_id) as payload
  )
  select case
    when bootstrap.payload is null then null
    when pg_catalog.jsonb_typeof(bootstrap.payload) = 'object'
      and pg_catalog.jsonb_typeof(bootstrap.payload -> 'account') = 'object'
      then pg_catalog.jsonb_set(
        bootstrap.payload,
        '{account,metadata}'::text[],
        '{}'::jsonb,
        true
      )
    else bootstrap.payload
  end
  from bootstrap;
$function$;

alter function public.hub_bootstrap(uuid) owner to postgres;
revoke all on function public.hub_bootstrap(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.hub_bootstrap(uuid)
  to authenticated;

create or replace function public.hub_set_member_subject_role(
  p_account_id uuid,
  p_member_user_id uuid,
  p_subject_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_subject_role text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_subject_role, ''))
  );
  v_updated_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if p_account_id is null or p_member_user_id is null then
    raise exception 'invalid_member_scope' using errcode = '22023';
  end if;
  if v_subject_role not in ('LEARNER', 'EDUCATOR') then
    raise exception 'invalid_hub_subject_role' using errcode = '22023';
  end if;
  if not private.hub_is_account_manager(p_account_id) then
    raise exception 'hub_manager_required' using errcode = '42501';
  end if;

  update public.hub_memberships as membership
  set subject_role = v_subject_role,
      updated_at = pg_catalog.clock_timestamp()
  where membership.account_id = p_account_id
    and membership.user_id = p_member_user_id
    and membership.membership_role = 'MEMBER'
    and membership.status = 'ACTIVE'
  returning membership.updated_at into v_updated_at;

  if not found then
    raise exception 'active_member_required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'accountId', p_account_id,
    'userId', p_member_user_id,
    'subjectRole', v_subject_role,
    'updatedAt', v_updated_at
  );
end;
$function$;

alter function public.hub_set_member_subject_role(uuid, uuid, text)
  owner to postgres;
revoke all on function public.hub_set_member_subject_role(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.hub_set_member_subject_role(uuid, uuid, text)
  to authenticated;

-- Apply the functional role to every Planner authorization path while keeping
-- the signatures introduced by 20260823184000 unchanged.
create or replace function private.hub_user_has_educator_planner_access(
  p_account_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_account_id is not null
    and p_user_id is not null
    and private.hub_is_enabled()
    and private.hub_profile_is_active(p_user_id)
    and not exists (
      select 1
      from public.profiles as profile
      where profile.id = p_user_id
        and profile.tenant_id = 'wolfie-direct'
    )
    and exists (
      select 1
      from public.hub_accounts as account
      join public.hub_memberships as membership
        on membership.account_id = account.id
       and membership.user_id = p_user_id
       and membership.status = 'ACTIVE'
       and membership.subject_role = 'EDUCATOR'
      join public.hub_subscriptions as subscription
        on subscription.account_id = account.id
       and subscription.product_family = 'HUB_CORE'
      join public.hub_plans as plan
        on plan.id = subscription.plan_id
       and plan.product_family = 'HUB_CORE'
       and plan.is_active = true
      join public.hub_plan_entitlements as entitlement
        on entitlement.plan_id = plan.id
       and entitlement.feature_key = 'educator_ai.generate'
       and (entitlement.limit_value is null or entitlement.limit_value > 0)
      where account.id = p_account_id
        and account.status = 'ACTIVE'
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
    );
$function$;

alter function private.hub_user_has_educator_planner_access(uuid, uuid)
  owner to postgres;
revoke all on function private.hub_user_has_educator_planner_access(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function private.hub_has_educator_planner_access(
  p_account_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.hub_user_has_educator_planner_access(
    p_account_id,
    (select auth.uid())
  );
$function$;

alter function private.hub_has_educator_planner_access(uuid)
  owner to postgres;
revoke all on function private.hub_has_educator_planner_access(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.hub_has_educator_planner_access(uuid)
  to authenticated;

create or replace function public.hub_authorize_educator_planner_access(
  p_user_id uuid,
  p_account_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_account_id uuid;
  v_account_count integer;
  v_membership_role text;
  v_subject_role text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not private.hub_is_enabled() then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'HUB_DISABLED'
    );
  end if;
  if not private.hub_profile_is_active(p_user_id) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'PROFILE_INACTIVE'
    );
  end if;
  if exists (
    select 1
    from public.profiles as profile
    where profile.id = p_user_id
      and profile.tenant_id = 'wolfie-direct'
  ) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'PRODUCT_SCOPE_FORBIDDEN'
    );
  end if;

  if p_account_id is null then
    select pg_catalog.count(*)::integer
      into v_account_count
    from public.hub_memberships as membership
    join public.hub_accounts as account
      on account.id = membership.account_id
     and account.status = 'ACTIVE'
    where membership.user_id = p_user_id
      and membership.status = 'ACTIVE';

    if v_account_count > 1 then
      return pg_catalog.jsonb_build_object(
        'allowed', false,
        'code', 'HUB_ACCOUNT_AMBIGUOUS'
      );
    end if;
  end if;

  select
    membership.account_id,
    membership.membership_role,
    membership.subject_role
  into v_account_id, v_membership_role, v_subject_role
  from public.hub_memberships as membership
  join public.hub_accounts as account
    on account.id = membership.account_id
   and account.status = 'ACTIVE'
  where membership.user_id = p_user_id
    and membership.status = 'ACTIVE'
    and (p_account_id is null or membership.account_id = p_account_id)
  order by membership.created_at, membership.id
  limit 1;

  if v_account_id is null then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'HUB_ACCOUNT_REQUIRED'
    );
  end if;
  if v_subject_role is distinct from 'EDUCATOR' then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'EDUCATOR_ROLE_REQUIRED',
      'accountId', v_account_id,
      'membershipRole', v_membership_role,
      'subjectRole', v_subject_role
    );
  end if;
  if not private.hub_user_has_educator_planner_access(
    v_account_id,
    p_user_id
  ) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'SUBSCRIPTION_REQUIRED'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'accountId', v_account_id,
    'membershipRole', v_membership_role,
    'subjectRole', v_subject_role
  );
end;
$function$;

alter function public.hub_authorize_educator_planner_access(uuid, uuid)
  owner to postgres;
revoke all on function public.hub_authorize_educator_planner_access(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.hub_authorize_educator_planner_access(uuid, uuid)
  to service_role;

-- Normalize legacy learner rows before adding strict server constraints.
with normalized as (
  select
    learner.id,
    case
      when pg_catalog.char_length(
        pg_catalog.btrim(
          pg_catalog.regexp_replace(
            coalesce(learner.display_name, ''),
            '[[:space:]]+',
            ' ',
            'g'
          )
        )
      ) = 0 then 'Aluno'
      when pg_catalog.char_length(
        pg_catalog.btrim(
          pg_catalog.regexp_replace(
            coalesce(learner.display_name, ''),
            '[[:space:]]+',
            ' ',
            'g'
          )
        )
      ) = 1 then pg_catalog.btrim(
        pg_catalog.regexp_replace(
          coalesce(learner.display_name, ''),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ) || '.'
      else pg_catalog.left(
        pg_catalog.btrim(
          pg_catalog.regexp_replace(
            coalesce(learner.display_name, ''),
            '[[:space:]]+',
            ' ',
            'g'
          )
        ),
        120
      )
    end as display_name,
    case
      when pg_catalog.upper(
        pg_catalog.btrim(coalesce(learner.level_tag, ''))
      ) in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
        then pg_catalog.upper(pg_catalog.btrim(learner.level_tag))
      else null
    end as level_tag,
    pg_catalog.left(
      nullif(pg_catalog.btrim(learner.objective), ''),
      800
    ) as objective,
    coalesce(
      (
        select pg_catalog.array_agg(item.value order by item.ordinality)
        from (
          select
            pg_catalog.left(pg_catalog.btrim(source.value), 80) as value,
            source.ordinality
          from pg_catalog.unnest(
            coalesce(learner.interests, '{}'::text[])
          ) with ordinality as source(value, ordinality)
          where source.value is not null
            and nullif(pg_catalog.btrim(source.value), '') is not null
          order by source.ordinality
          limit 12
        ) as item
      ),
      '{}'::text[]
    ) as interests,
    pg_catalog.left(
      nullif(pg_catalog.btrim(learner.notes), ''),
      1200
    ) as notes
  from public.hub_educator_learners as learner
)
update public.hub_educator_learners as learner
set display_name = normalized.display_name,
    level_tag = normalized.level_tag,
    objective = normalized.objective,
    interests = normalized.interests,
    notes = normalized.notes
from normalized
where normalized.id = learner.id
  and (
    learner.display_name,
    learner.level_tag,
    learner.objective,
    learner.interests,
    learner.notes
  ) is distinct from (
    normalized.display_name,
    normalized.level_tag,
    normalized.objective,
    normalized.interests,
    normalized.notes
  );

create or replace function private.hub_educator_interests_valid(
  p_interests text[]
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_interests is not null
    and pg_catalog.cardinality(p_interests) <= 12
    and pg_catalog.pg_column_size(p_interests) <= 2048
    and not exists (
      select 1
      from pg_catalog.unnest(p_interests) as interest(value)
      where interest.value is null
        or pg_catalog.char_length(pg_catalog.btrim(interest.value)) < 1
        or pg_catalog.char_length(pg_catalog.btrim(interest.value)) > 80
    );
$function$;

alter function private.hub_educator_interests_valid(text[])
  owner to postgres;
revoke all on function private.hub_educator_interests_valid(text[])
  from public, anon, authenticated, service_role;
grant execute on function private.hub_educator_interests_valid(text[])
  to service_role;

do $block$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'hub_educator_learners_display_name_check'
      and conrelid = 'public.hub_educator_learners'::pg_catalog.regclass
  ) then
    alter table public.hub_educator_learners
      add constraint hub_educator_learners_display_name_check
      check (
        pg_catalog.char_length(pg_catalog.btrim(display_name)) between 2 and 120
      );
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'hub_educator_learners_objective_check'
      and conrelid = 'public.hub_educator_learners'::pg_catalog.regclass
  ) then
    alter table public.hub_educator_learners
      add constraint hub_educator_learners_objective_check
      check (objective is null or pg_catalog.char_length(objective) <= 800);
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'hub_educator_learners_notes_check'
      and conrelid = 'public.hub_educator_learners'::pg_catalog.regclass
  ) then
    alter table public.hub_educator_learners
      add constraint hub_educator_learners_notes_check
      check (notes is null or pg_catalog.char_length(notes) <= 1200);
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'hub_educator_learners_interests_check'
      and conrelid = 'public.hub_educator_learners'::pg_catalog.regclass
  ) then
    alter table public.hub_educator_learners
      add constraint hub_educator_learners_interests_check
      check (private.hub_educator_interests_valid(interests));
  end if;
end
$block$;

alter table public.hub_educator_learners enable row level security;

do $block$
declare
  v_policy_name text;
begin
  for v_policy_name in
    select policy.policyname
    from pg_catalog.pg_policies as policy
    where policy.schemaname = 'public'
      and policy.tablename = 'hub_educator_learners'
  loop
    execute pg_catalog.format(
      'drop policy %I on public.hub_educator_learners',
      v_policy_name
    );
  end loop;
end
$block$;

revoke all on table public.hub_educator_learners
  from public, anon, authenticated;
grant all on table public.hub_educator_learners to service_role;

create or replace function public.hub_list_educator_learners(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_is_manager boolean;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if p_account_id is null then
    raise exception 'invalid_account_id' using errcode = '22023';
  end if;
  if not private.hub_has_educator_planner_access(p_account_id) then
    raise exception 'educator_planner_access_required' using errcode = '42501';
  end if;

  v_is_manager := private.hub_is_account_manager(p_account_id);

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', learner.id,
        'display_name', learner.display_name,
        'level_tag', learner.level_tag
      )
      order by learner.display_name, learner.id
    ),
    '[]'::jsonb
  )
  into v_result
  from public.hub_educator_learners as learner
  where learner.account_id = p_account_id
    and (v_is_manager or learner.created_by = v_user_id);

  return v_result;
end;
$function$;

alter function public.hub_list_educator_learners(uuid) owner to postgres;
revoke all on function public.hub_list_educator_learners(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.hub_list_educator_learners(uuid)
  to authenticated;

create or replace function public.hub_create_educator_learner(
  p_account_id uuid,
  p_name text,
  p_level text default null,
  p_objective text default null,
  p_interests text[] default '{}'::text[],
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_name text;
  v_level text;
  v_objective text;
  v_interests text[];
  v_notes text;
  v_learner_id uuid;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if p_account_id is null then
    raise exception 'invalid_account_id' using errcode = '22023';
  end if;
  if not private.hub_has_educator_planner_access(p_account_id) then
    raise exception 'educator_planner_access_required' using errcode = '42501';
  end if;

  v_name := pg_catalog.btrim(
    pg_catalog.regexp_replace(
      coalesce(p_name, ''),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
  if pg_catalog.char_length(v_name) < 2
     or pg_catalog.char_length(v_name) > 120 then
    raise exception 'invalid_learner_name' using errcode = '22023';
  end if;

  v_level := nullif(
    pg_catalog.upper(pg_catalog.btrim(coalesce(p_level, ''))),
    ''
  );
  if v_level is not null
     and v_level not in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2') then
    raise exception 'invalid_cefr_level' using errcode = '22023';
  end if;

  v_objective := nullif(pg_catalog.btrim(coalesce(p_objective, '')), '');
  if pg_catalog.char_length(coalesce(v_objective, '')) > 800 then
    raise exception 'learner_objective_too_long' using errcode = '22023';
  end if;

  v_notes := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  if pg_catalog.char_length(coalesce(v_notes, '')) > 1200 then
    raise exception 'learner_notes_too_long' using errcode = '22023';
  end if;

  if not private.hub_educator_interests_valid(p_interests) then
    raise exception 'invalid_learner_interests' using errcode = '22023';
  end if;
  select coalesce(
    pg_catalog.array_agg(source.value order by source.ordinality),
    '{}'::text[]
  )
  into v_interests
  from (
    select pg_catalog.btrim(item.value) as value, item.ordinality
    from pg_catalog.unnest(p_interests)
      with ordinality as item(value, ordinality)
  ) as source;

  insert into public.hub_educator_learners (
    account_id,
    created_by,
    display_name,
    level_tag,
    objective,
    interests,
    notes
  ) values (
    p_account_id,
    v_user_id,
    v_name,
    v_level,
    v_objective,
    v_interests,
    v_notes
  )
  returning id into v_learner_id;

  return pg_catalog.jsonb_build_object(
    'id', v_learner_id,
    'display_name', v_name,
    'level_tag', v_level
  );
end;
$function$;

alter function public.hub_create_educator_learner(
  uuid,
  text,
  text,
  text,
  text[],
  text
) owner to postgres;
revoke all on function public.hub_create_educator_learner(
  uuid,
  text,
  text,
  text,
  text[],
  text
) from public, anon, authenticated, service_role;
grant execute on function public.hub_create_educator_learner(
  uuid,
  text,
  text,
  text,
  text[],
  text
) to authenticated;

comment on column public.hub_memberships.subject_role is
  'Product persona independent from account authority. Managers follow account audience; MEMBER is explicitly LEARNER or EDUCATOR.';
comment on table public.hub_member_profiles is
  'Private per-account, per-member Hub personalization; accessible only through own-profile RPCs.';
comment on function public.hub_get_member_profile(uuid) is
  'Returns only the authenticated member own isolated Hub profile.';
comment on function public.hub_update_member_preferences(uuid, jsonb) is
  'Updates allowlisted fields on the authenticated member own Hub profile.';
comment on function public.hub_bootstrap(uuid) is
  'Returns the legacy Hub bootstrap contract with shared account personalization metadata removed.';
comment on function public.hub_set_member_subject_role(uuid, uuid, text) is
  'Allows an active account manager to assign LEARNER or EDUCATOR only to an active MEMBER.';
comment on function public.hub_list_educator_learners(uuid) is
  'Lists minimal learner summaries, own-only for educator MEMBER and account-wide for educator managers.';
comment on function public.hub_create_educator_learner(
  uuid,
  text,
  text,
  text,
  text[],
  text
) is
  'Creates a validated learner with created_by derived exclusively from auth.uid().';

commit;
