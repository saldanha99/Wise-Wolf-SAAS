-- Hub Educator native Planner persistence.
--
-- Hub accounts are an authorization domain separate from school tenants. These
-- tables intentionally do not reference profiles, lesson_plans, planner_ai_runs
-- or student_learning_memories. Every persisted row carries the Hub account,
-- learner and actor scopes so cross-account relationships fail at the database
-- boundary as well as in the Edge Function.

begin;

do $block$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'hub_educator_learners_account_id_key'
      and conrelid = 'public.hub_educator_learners'::pg_catalog.regclass
  ) then
    alter table public.hub_educator_learners
      add constraint hub_educator_learners_account_id_key
      unique (account_id, id);
  end if;
end
$block$;

do $block$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'hub_subscriptions_account_id_key'
      and conrelid = 'public.hub_subscriptions'::pg_catalog.regclass
  ) then
    alter table public.hub_subscriptions
      add constraint hub_subscriptions_account_id_key
      unique (account_id, id);
  end if;
end
$block$;

create table if not exists public.hub_educator_plan_runs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  account_id uuid not null
    references public.hub_accounts(id) on delete cascade,
  learner_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  subscription_id uuid not null,
  request_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  task_mode text not null,
  duration_minutes integer not null default 30
    check (duration_minutes between 10 and 120),
  bilingual boolean not null default true,
  teacher_request text not null default ''
    check (pg_catalog.char_length(teacher_request) <= 2500),
  model_id text not null,
  prompt_version text not null,
  response_id text,
  provider_usage jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(provider_usage) = 'object'),
  knowledge jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(knowledge) = 'object'),
  plan jsonb not null
    check (pg_catalog.jsonb_typeof(plan) = 'object'),
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'SAVED', 'EXPIRED')),
  created_at timestamptz not null default pg_catalog.now(),
  saved_at timestamptz,
  expires_at timestamptz not null default (pg_catalog.now() + interval '30 days'),
  constraint hub_educator_plan_runs_learner_fkey
    foreign key (account_id, learner_id)
    references public.hub_educator_learners(account_id, id)
    on delete cascade,
  constraint hub_educator_plan_runs_subscription_fkey
    foreign key (account_id, subscription_id)
    references public.hub_subscriptions(account_id, id)
    on delete restrict,
  constraint hub_educator_plan_runs_task_mode_check
    check (
      task_mode in (
        'lesson_plan',
        'student_feedback',
        'oral_test',
        'homework',
        'class_script',
        'vocabulary',
        'presentation_coaching',
        'progress_report',
        'material_generation'
      )
    ),
  unique (account_id, created_by, request_key),
  unique (id, account_id, learner_id, created_by)
);

create table if not exists public.hub_educator_plans (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  account_id uuid not null
    references public.hub_accounts(id) on delete cascade,
  learner_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  run_id uuid not null,
  objective text not null default '',
  task_mode text not null,
  duration_minutes integer not null
    check (duration_minutes between 10 and 120),
  bilingual boolean not null default true,
  teacher_request text not null default ''
    check (pg_catalog.char_length(teacher_request) <= 2500),
  plan jsonb not null
    check (pg_catalog.jsonb_typeof(plan) = 'object'),
  model_id text not null,
  prompt_version text not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint hub_educator_plans_learner_fkey
    foreign key (account_id, learner_id)
    references public.hub_educator_learners(account_id, id)
    on delete cascade,
  constraint hub_educator_plans_run_fkey
    foreign key (run_id, account_id, learner_id, created_by)
    references public.hub_educator_plan_runs(id, account_id, learner_id, created_by)
    on delete no action
    deferrable initially deferred,
  constraint hub_educator_plans_task_mode_check
    check (
      task_mode in (
        'lesson_plan',
        'student_feedback',
        'oral_test',
        'homework',
        'class_script',
        'vocabulary',
        'presentation_coaching',
        'progress_report',
        'material_generation'
      )
    ),
  unique (run_id),
  unique (id, account_id, learner_id, created_by)
);

create table if not exists public.hub_educator_memory (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  account_id uuid not null
    references public.hub_accounts(id) on delete cascade,
  learner_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  accumulated_context text not null default '',
  strong_points text[] not null default '{}'::text[],
  weak_points text[] not null default '{}'::text[],
  recommended_approach text,
  total_classes_analyzed integer not null default 0
    check (total_classes_analyzed >= 0),
  verification_status text not null default 'VERIFIED'
    check (verification_status = 'VERIFIED'),
  metadata jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint hub_educator_memory_learner_fkey
    foreign key (account_id, learner_id)
    references public.hub_educator_learners(account_id, id)
    on delete cascade,
  unique (account_id, learner_id, created_by)
);

create table if not exists public.hub_educator_memory_proposals (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  account_id uuid not null
    references public.hub_accounts(id) on delete cascade,
  learner_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  run_id uuid not null,
  proposal jsonb not null
    check (pg_catalog.jsonb_typeof(proposal) = 'object'),
  verification_status text not null default 'PROPOSED'
    check (verification_status in ('PROPOSED', 'VERIFIED', 'REJECTED')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint hub_educator_memory_proposals_learner_fkey
    foreign key (account_id, learner_id)
    references public.hub_educator_learners(account_id, id)
    on delete cascade,
  constraint hub_educator_memory_proposals_run_fkey
    foreign key (run_id, account_id, learner_id, created_by)
    references public.hub_educator_plan_runs(id, account_id, learner_id, created_by)
    on delete cascade,
  unique (run_id)
);

create index if not exists hub_educator_plan_runs_history_idx
  on public.hub_educator_plan_runs(
    account_id,
    learner_id,
    created_by,
    created_at desc
  );
create index if not exists hub_educator_plan_runs_expiry_idx
  on public.hub_educator_plan_runs(expires_at)
  where status = 'DRAFT';
create index if not exists hub_educator_plans_history_idx
  on public.hub_educator_plans(
    account_id,
    learner_id,
    created_at desc
  );
create index if not exists hub_educator_memory_history_idx
  on public.hub_educator_memory(account_id, learner_id, updated_at desc);
create index if not exists hub_educator_memory_proposals_review_idx
  on public.hub_educator_memory_proposals(
    account_id,
    learner_id,
    verification_status,
    created_at desc
  );

drop trigger if exists hub_educator_plans_set_updated_at
  on public.hub_educator_plans;
create trigger hub_educator_plans_set_updated_at
before update on public.hub_educator_plans
for each row execute function private.hub_set_updated_at();

drop trigger if exists hub_educator_memory_set_updated_at
  on public.hub_educator_memory;
create trigger hub_educator_memory_set_updated_at
before update on public.hub_educator_memory
for each row execute function private.hub_set_updated_at();

drop trigger if exists hub_educator_memory_proposals_set_updated_at
  on public.hub_educator_memory_proposals;
create trigger hub_educator_memory_proposals_set_updated_at
before update on public.hub_educator_memory_proposals
for each row execute function private.hub_set_updated_at();

create or replace function private.hub_guard_educator_learner_scope()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.account_id is distinct from old.account_id
     or new.created_by is distinct from old.created_by then
    raise exception 'hub_educator_learner_scope_is_immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

alter function private.hub_guard_educator_learner_scope()
  owner to postgres;
revoke all on function private.hub_guard_educator_learner_scope()
  from public, anon, authenticated, service_role;

drop trigger if exists hub_educator_learners_guard_scope
  on public.hub_educator_learners;
create trigger hub_educator_learners_guard_scope
before update of account_id, created_by on public.hub_educator_learners
for each row execute function private.hub_guard_educator_learner_scope();

grant execute on function private.hub_is_enabled() to postgres;
grant execute on function private.hub_profile_is_active(uuid) to postgres;

-- Internal feature predicate used by RLS through a current-user-only wrapper
-- and by service-only RPCs with an explicit authenticated user id.
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
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not private.hub_is_enabled() then
    return pg_catalog.jsonb_build_object('allowed', false, 'code', 'HUB_DISABLED');
  end if;
  if not private.hub_profile_is_active(p_user_id) then
    return pg_catalog.jsonb_build_object('allowed', false, 'code', 'PROFILE_INACTIVE');
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

  select membership.account_id, membership.membership_role
    into v_account_id, v_membership_role
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
    'membershipRole', v_membership_role
  );
end;
$function$;

alter function public.hub_authorize_educator_planner_access(uuid, uuid)
  owner to postgres;
revoke all on function public.hub_authorize_educator_planner_access(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.hub_authorize_educator_planner_access(uuid, uuid)
  to service_role;

-- Atomic, idempotent transition from a charged draft to a saved plan. The
-- committed usage event is checked inside the transaction so an uncommitted
-- draft can never be promoted after a provider or quota failure.
create or replace function public.save_hub_educator_plan_run(
  p_run_id uuid,
  p_actor_id uuid,
  p_account_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.hub_educator_plan_runs%rowtype;
  v_learner public.hub_educator_learners%rowtype;
  v_access jsonb;
  v_plan_id uuid;
  v_memory jsonb;
  v_memory_proposal jsonb;
  v_has_memory_proposal boolean;
  v_memory_proposal_status text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_run_id is null or p_actor_id is null then
    raise exception 'invalid_planner_save' using errcode = '22023';
  end if;

  select run.*
    into v_run
  from public.hub_educator_plan_runs as run
  where run.id = p_run_id
  for update;

  if not found then
    raise exception 'hub_planner_run_not_found' using errcode = 'P0002';
  end if;
  if v_run.created_by <> p_actor_id
     or (p_account_id is not null and v_run.account_id <> p_account_id) then
    raise exception 'hub_planner_run_forbidden' using errcode = '42501';
  end if;

  v_access := public.hub_authorize_educator_planner_access(
    p_actor_id,
    v_run.account_id
  );
  if v_access ->> 'allowed' <> 'true' then
    raise exception 'hub_planner_access_denied' using errcode = '42501';
  end if;

  select learner.*
    into v_learner
  from public.hub_educator_learners as learner
  where learner.account_id = v_run.account_id
    and learner.id = v_run.learner_id;

  if not found then
    raise exception 'hub_planner_learner_not_found' using errcode = 'P0002';
  end if;
  if v_access ->> 'membershipRole' = 'MEMBER'
     and v_learner.created_by <> p_actor_id then
    raise exception 'hub_planner_learner_forbidden' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.hub_usage_events as usage_event
    where usage_event.account_id = v_run.account_id
      and usage_event.subscription_id = v_run.subscription_id
      and usage_event.user_id = v_run.created_by
      and usage_event.feature_key = 'educator_ai.generate'
      and usage_event.request_key = v_run.request_key
  ) then
    raise exception 'hub_planner_usage_not_committed' using errcode = '42501';
  end if;

  if v_run.status = 'SAVED' then
    select plan.id
      into v_plan_id
    from public.hub_educator_plans as plan
    where plan.run_id = v_run.id;
    if v_plan_id is null then
      raise exception 'hub_planner_saved_run_inconsistent' using errcode = 'P0002';
    end if;
    select pg_catalog.to_jsonb(memory.*)
      into v_memory
    from public.hub_educator_memory as memory
    where memory.account_id = v_run.account_id
      and memory.learner_id = v_run.learner_id
      and memory.created_by = v_run.created_by;
    select proposal.verification_status
      into v_memory_proposal_status
    from public.hub_educator_memory_proposals as proposal
    where proposal.run_id = v_run.id;
    return pg_catalog.jsonb_build_object(
      'saved', true,
      'idempotent', true,
      'lessonPlanId', v_plan_id,
      'runId', v_run.id,
      'memory', v_memory,
      'memoryProposalStatus', v_memory_proposal_status
    );
  end if;

  if v_run.status <> 'DRAFT' or v_run.expires_at <= pg_catalog.now() then
    raise exception 'hub_planner_run_expired' using errcode = '22023';
  end if;

  insert into public.hub_educator_plans (
    account_id,
    learner_id,
    created_by,
    run_id,
    objective,
    task_mode,
    duration_minutes,
    bilingual,
    teacher_request,
    plan,
    model_id,
    prompt_version
  ) values (
    v_run.account_id,
    v_run.learner_id,
    v_run.created_by,
    v_run.id,
    coalesce(v_run.plan ->> 'objective', ''),
    v_run.task_mode,
    v_run.duration_minutes,
    v_run.bilingual,
    v_run.teacher_request,
    v_run.plan,
    v_run.model_id,
    v_run.prompt_version
  )
  on conflict (run_id) do nothing
  returning id into v_plan_id;

  if v_plan_id is null then
    select plan.id
      into v_plan_id
    from public.hub_educator_plans as plan
    where plan.run_id = v_run.id;
  end if;
  if v_plan_id is null then
    raise exception 'hub_planner_plan_persistence_failed' using errcode = 'P0002';
  end if;

  v_memory_proposal := coalesce(
    v_run.plan -> 'student_memory_update',
    '{}'::jsonb
  );
  v_has_memory_proposal := pg_catalog.jsonb_typeof(v_memory_proposal) = 'object'
    and exists (
      select 1
      from pg_catalog.jsonb_each(v_memory_proposal) as item(key, value)
      where item.key <> 'confidence_level'
        and (
          (
            pg_catalog.jsonb_typeof(item.value) = 'string'
            and pg_catalog.btrim(item.value #>> '{}') <> ''
          )
          or (
            pg_catalog.jsonb_typeof(item.value) = 'array'
            and pg_catalog.jsonb_array_length(item.value) > 0
          )
        )
    );

  if v_has_memory_proposal then
    insert into public.hub_educator_memory_proposals (
      account_id,
      learner_id,
      created_by,
      run_id,
      proposal
    ) values (
      v_run.account_id,
      v_run.learner_id,
      v_run.created_by,
      v_run.id,
      v_memory_proposal
    )
    on conflict (run_id) do nothing;
    v_memory_proposal_status := 'PROPOSED';
  end if;

  select pg_catalog.to_jsonb(memory.*)
    into v_memory
  from public.hub_educator_memory as memory
  where memory.account_id = v_run.account_id
    and memory.learner_id = v_run.learner_id
    and memory.created_by = v_run.created_by;

  update public.hub_educator_plan_runs as run
  set status = 'SAVED',
      saved_at = pg_catalog.now()
  where run.id = v_run.id;

  return pg_catalog.jsonb_build_object(
    'saved', true,
    'idempotent', false,
    'lessonPlanId', v_plan_id,
    'runId', v_run.id,
    'memory', v_memory,
    'memoryProposalStatus', v_memory_proposal_status
  );
end;
$function$;

alter function public.save_hub_educator_plan_run(uuid, uuid, uuid)
  owner to postgres;
revoke all on function public.save_hub_educator_plan_run(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.save_hub_educator_plan_run(uuid, uuid, uuid)
  to service_role;

alter table public.hub_educator_plan_runs enable row level security;
alter table public.hub_educator_plans enable row level security;
alter table public.hub_educator_memory enable row level security;
alter table public.hub_educator_memory_proposals enable row level security;

revoke all on table public.hub_educator_plan_runs
  from public, anon, authenticated;
revoke all on table public.hub_educator_plans
  from public, anon, authenticated;
revoke all on table public.hub_educator_memory
  from public, anon, authenticated;
revoke all on table public.hub_educator_memory_proposals
  from public, anon, authenticated;
grant select on table public.hub_educator_plans to authenticated;
grant select on table public.hub_educator_memory to authenticated;
grant all on table public.hub_educator_plan_runs to service_role;
grant all on table public.hub_educator_plans to service_role;
grant all on table public.hub_educator_memory to service_role;
grant all on table public.hub_educator_memory_proposals to service_role;

drop policy if exists hub_educator_plans_select_scoped
  on public.hub_educator_plans;
create policy hub_educator_plans_select_scoped
on public.hub_educator_plans
for select
to authenticated
using (
  (select private.hub_has_educator_planner_access(account_id))
  and (
    (select private.hub_is_account_manager(account_id))
    or created_by = (select auth.uid())
  )
);

drop policy if exists hub_educator_memory_select_scoped
  on public.hub_educator_memory;
create policy hub_educator_memory_select_scoped
on public.hub_educator_memory
for select
to authenticated
using (
  verification_status = 'VERIFIED'
  and
  (select private.hub_has_educator_planner_access(account_id))
  and (
    (select private.hub_is_account_manager(account_id))
    or created_by = (select auth.uid())
  )
);

-- OWNER/ADMIN keep account-wide learner management. MEMBER is restricted to
-- rows it created, with RLS as the authority even if the client filter is lost.
drop policy if exists hub_educator_learners_select_members
  on public.hub_educator_learners;
drop policy if exists hub_educator_learners_insert_members
  on public.hub_educator_learners;
drop policy if exists hub_educator_learners_update_members
  on public.hub_educator_learners;
drop policy if exists hub_educator_learners_delete_managers
  on public.hub_educator_learners;
drop policy if exists hub_educator_learners_select_scoped
  on public.hub_educator_learners;
drop policy if exists hub_educator_learners_insert_scoped
  on public.hub_educator_learners;
drop policy if exists hub_educator_learners_update_scoped
  on public.hub_educator_learners;
drop policy if exists hub_educator_learners_delete_scoped
  on public.hub_educator_learners;

create policy hub_educator_learners_select_scoped
on public.hub_educator_learners
for select
to authenticated
using (
  (select private.hub_has_educator_planner_access(account_id))
  and (
    (select private.hub_is_account_manager(account_id))
    or created_by = (select auth.uid())
  )
);

create policy hub_educator_learners_insert_scoped
on public.hub_educator_learners
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.hub_has_educator_planner_access(account_id))
);

create policy hub_educator_learners_update_scoped
on public.hub_educator_learners
for update
to authenticated
using (
  (select private.hub_has_educator_planner_access(account_id))
  and (
    (select private.hub_is_account_manager(account_id))
    or created_by = (select auth.uid())
  )
)
with check (
  (select private.hub_has_educator_planner_access(account_id))
  and (
    (select private.hub_is_account_manager(account_id))
    or created_by = (select auth.uid())
  )
);

create policy hub_educator_learners_delete_scoped
on public.hub_educator_learners
for delete
to authenticated
using (
  (select private.hub_has_educator_planner_access(account_id))
  and (
    (select private.hub_is_account_manager(account_id))
    or created_by = (select auth.uid())
  )
);

comment on table public.hub_educator_plan_runs is
  'Service-only Hub Planner drafts, provider audit and committed-usage linkage.';
comment on table public.hub_educator_plans is
  'Saved Hub Educator plans isolated by account, learner and creator.';
comment on table public.hub_educator_memory is
  'Verified Hub learner context maintained only by trusted server-side flows; saved plans remain proposals.';
comment on table public.hub_educator_memory_proposals is
  'Service-only Hub Planner memory proposals awaiting an explicit trusted review.';

commit;
