-- Wise Wolf Hub: commercial product foundation for the self-hosted VPS.
-- The Hub is intentionally independent from school tenant membership. A person
-- can keep Hub subscriptions while also being a student or teacher elsewhere.

create schema if not exists private;

create table if not exists public.hub_accounts (
  id uuid primary key default gen_random_uuid(),
  account_type text not null default 'PERSONAL'
    check (account_type in ('PERSONAL', 'ORGANIZATION')),
  audience text not null default 'EDUCATOR'
    check (audience in ('LEARNER', 'EDUCATOR', 'INSTITUTION')),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  trial_claimed_at timestamptz,
  asaas_customer_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists hub_personal_account_owner_unique
  on public.hub_accounts(owner_user_id)
  where account_type = 'PERSONAL';

create table if not exists public.hub_memberships (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  membership_role text not null default 'MEMBER'
    check (membership_role in ('OWNER', 'ADMIN', 'MEMBER')),
  status text not null default 'ACTIVE'
    check (status in ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, user_id)
);

create index if not exists hub_memberships_user_active_idx
  on public.hub_memberships(user_id, account_id)
  where status = 'ACTIVE';

create table if not exists public.hub_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  audience text not null default 'EDUCATOR'
    check (audience in ('ALL', 'LEARNER', 'EDUCATOR', 'INSTITUTION')),
  price_monthly numeric(12,2),
  price_yearly numeric(12,2),
  currency text not null default 'BRL',
  trial_days integer not null default 0 check (trial_days between 0 and 90),
  display_order integer not null default 0,
  is_public boolean not null default true,
  is_active boolean not null default true,
  features jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hub_plan_entitlements (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.hub_plans(id) on delete cascade,
  feature_key text not null,
  limit_value integer check (limit_value is null or limit_value >= 0),
  reset_period text not null default 'MONTH'
    check (reset_period in ('DAY', 'MONTH', 'SUBSCRIPTION')),
  metadata jsonb not null default '{}'::jsonb,
  unique (plan_id, feature_key)
);

create table if not exists public.hub_subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  plan_id uuid not null references public.hub_plans(id) on delete restrict,
  status text not null
    check (status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED')),
  billing_cycle text check (billing_cycle in ('MONTHLY', 'YEARLY')),
  trial_starts_at timestamptz,
  trial_ends_at timestamptz,
  current_period_starts_at timestamptz,
  current_period_ends_at timestamptz,
  cancelled_at timestamptz,
  provider text,
  provider_subscription_id text,
  provider_payment_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists hub_one_live_subscription_per_account
  on public.hub_subscriptions(account_id)
  where status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE');

create index if not exists hub_subscriptions_access_idx
  on public.hub_subscriptions(account_id, status, trial_ends_at, current_period_ends_at);

create table if not exists public.hub_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  plan_id uuid not null references public.hub_plans(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  billing_cycle text not null check (billing_cycle in ('MONTHLY', 'YEARLY')),
  billing_type text not null check (billing_type in ('PIX', 'BOLETO', 'CREDIT_CARD')),
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'CREATED'
    check (status in ('CREATED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'OVERDUE')),
  asaas_subscription_id text,
  asaas_payment_id text,
  invoice_url text,
  bank_slip_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists hub_checkout_asaas_payment_unique
  on public.hub_checkout_sessions(asaas_payment_id)
  where asaas_payment_id is not null;
create index if not exists hub_checkout_account_created_idx
  on public.hub_checkout_sessions(account_id, created_at desc);

create table if not exists public.hub_usage_counters (
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  subscription_id uuid not null references public.hub_subscriptions(id) on delete cascade,
  feature_key text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  used_units integer not null default 0 check (used_units >= 0),
  updated_at timestamptz not null default now(),
  primary key (subscription_id, feature_key, period_start)
);

create table if not exists public.hub_usage_events (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  subscription_id uuid not null references public.hub_subscriptions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  feature_key text not null,
  units integer not null check (units > 0),
  request_key uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists hub_usage_events_request_unique
  on public.hub_usage_events(subscription_id, feature_key, request_key)
  where request_key is not null;
create index if not exists hub_usage_events_account_created_idx
  on public.hub_usage_events(account_id, created_at desc);

create table if not exists public.hub_content_items (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text,
  content_type text not null default 'PDF'
    check (content_type in ('PDF', 'VIDEO', 'AUDIO', 'LINK', 'ACTIVITY')),
  level_tag text check (level_tag is null or level_tag in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  niche text not null default 'GENERAL',
  collection_name text,
  cover_url text,
  preview_enabled boolean not null default false,
  license_summary text,
  author_name text,
  rights_verified_at timestamptz,
  published_at timestamptz,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hub_content_catalog_idx
  on public.hub_content_items(is_active, published_at desc, level_tag, niche);

-- Asset paths never live in the public catalog table. They are resolved only
-- by a server-side function after subscription and entitlement checks.
create table if not exists public.hub_content_assets (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.hub_content_items(id) on delete cascade,
  asset_kind text not null check (asset_kind in ('PREVIEW', 'FULL', 'COVER')),
  bucket_id text not null default 'hub-library',
  object_path text not null,
  mime_type text,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  checksum_sha256 text,
  created_at timestamptz not null default now(),
  unique (content_id, asset_kind)
);

create table if not exists public.hub_content_access_events (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  content_id uuid not null references public.hub_content_items(id) on delete restrict,
  access_kind text not null check (access_kind in ('PREVIEW', 'OPEN', 'DOWNLOAD')),
  created_at timestamptz not null default now()
);

create index if not exists hub_content_access_account_idx
  on public.hub_content_access_events(account_id, created_at desc);

create table if not exists public.hub_educator_learners (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  display_name text not null,
  level_tag text check (level_tag is null or level_tag in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  objective text,
  interests text[] not null default '{}'::text[],
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hub_educator_learners_account_idx
  on public.hub_educator_learners(account_id, created_at desc);

create table if not exists public.hub_conversion_events (
  id bigint generated always as identity primary key,
  account_id uuid references public.hub_accounts(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  event_name text not null,
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists hub_conversion_events_created_idx
  on public.hub_conversion_events(created_at desc, event_name);

create table if not exists public.hub_settings (
  settings_key text primary key,
  brand_name text not null default 'Wise Wolf Hub',
  headline text not null,
  subheadline text,
  saas_video_url text,
  saas_cta_url text not null default '/new-saas',
  support_url text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.hub_settings (
  settings_key,
  headline,
  subheadline,
  saas_cta_url
) values (
  'default',
  'Materiais, inteligência e operação em um só ecossistema.',
  'Comece com as ferramentas que você precisa e evolua para o sistema escolar completo quando estiver pronto.',
  '/new-saas'
) on conflict (settings_key) do nothing;

insert into public.hub_plans (
  code, name, description, audience, price_monthly, price_yearly,
  trial_days, display_order, features, metadata
) values
  (
    'DISCOVERY', 'Descoberta', 'Teste gratuito para conhecer o ecossistema.',
    'ALL', 0, 0, 7, 10,
    '["5 prévias da biblioteca", "2 gerações com IA", "3 interações com o Wolfie", "Apresentação do SaaS escolar"]'::jsonb,
    '{"badge":"Teste grátis"}'::jsonb
  ),
  (
    'LIBRARY_SOLO', 'Biblioteca Solo', 'Acervo licenciado para professor autônomo.',
    'EDUCATOR', 59, 590, 0, 20,
    '["Biblioteca licenciada", "Atualizações do acervo", "Uso individual"]'::jsonb,
    '{}'::jsonb
  ),
  (
    'EDUCATOR_PRO', 'Educador Pro', 'Biblioteca e inteligência para preparar aulas.',
    'EDUCATOR', 119, 1190, 0, 30,
    '["Biblioteca completa", "Planner e gerador de atividades", "40 gerações mensais", "Perfis de aprendizes"]'::jsonb,
    '{"popular":true}'::jsonb
  ),
  (
    'HUB_COMPLETE', 'Hub Completo', 'A experiência completa para o professor independente.',
    'EDUCATOR', 169, 1690, 0, 40,
    '["Tudo do Educador Pro", "Wolfie", "Academia Wise Wolf", "Cotas ampliadas"]'::jsonb,
    '{}'::jsonb
  ),
  (
    'WOLFIE_PERSONAL', 'Wolfie Personal', 'Prática individual de inglês com IA.',
    'LEARNER', 49, 490, 0, 50,
    '["Prática personalizada", "Histórico", "Texto e voz", "Correções inteligentes"]'::jsonb,
    '{}'::jsonb
  ),
  (
    'INSTITUTIONAL', 'Institucional', 'Licença para equipes e instituições.',
    'INSTITUTION', 397, 3970, 0, 60,
    '["10 usuários", "Biblioteca completa", "IA para equipe", "Gestão de consumo", "Caminho para o SaaS completo"]'::jsonb,
    '{"sales_assisted":true}'::jsonb
  )
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  audience = excluded.audience,
  price_monthly = excluded.price_monthly,
  price_yearly = excluded.price_yearly,
  trial_days = excluded.trial_days,
  display_order = excluded.display_order,
  features = excluded.features,
  metadata = excluded.metadata,
  is_active = true;

insert into public.hub_plan_entitlements (plan_id, feature_key, limit_value, reset_period)
select plan.id, entitlement.feature_key, entitlement.limit_value, entitlement.reset_period
from public.hub_plans plan
cross join lateral (
  values
    ('saas.presentation', null::integer, 'SUBSCRIPTION'),
    ('library.preview', case plan.code when 'DISCOVERY' then 5 else null end, case when plan.code = 'DISCOVERY' then 'SUBSCRIPTION' else 'MONTH' end),
    ('library.full_access', case when plan.code in ('LIBRARY_SOLO','EDUCATOR_PRO','HUB_COMPLETE','INSTITUTIONAL') then null else 0 end, 'MONTH'),
    ('educator_ai.generate', case plan.code when 'DISCOVERY' then 2 when 'EDUCATOR_PRO' then 40 when 'HUB_COMPLETE' then 120 when 'INSTITUTIONAL' then 400 else 0 end, case when plan.code = 'DISCOVERY' then 'SUBSCRIPTION' else 'MONTH' end),
    ('wolfie.turn', case plan.code when 'DISCOVERY' then 3 when 'HUB_COMPLETE' then 60 when 'WOLFIE_PERSONAL' then 120 when 'INSTITUTIONAL' then 250 else 0 end, case when plan.code = 'DISCOVERY' then 'SUBSCRIPTION' else 'MONTH' end),
    ('academy.access', case when plan.code in ('HUB_COMPLETE','INSTITUTIONAL') then null else 0 end, 'MONTH'),
    ('team.seats', case plan.code when 'INSTITUTIONAL' then 10 else 1 end, 'SUBSCRIPTION')
) as entitlement(feature_key, limit_value, reset_period)
on conflict (plan_id, feature_key) do update set
  limit_value = excluded.limit_value,
  reset_period = excluded.reset_period;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'hub-library',
  'hub-library',
  false,
  524288000,
  array['application/pdf', 'audio/mpeg', 'audio/wav', 'video/mp4', 'image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.hub_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hub_accounts_set_updated_at on public.hub_accounts;
create trigger hub_accounts_set_updated_at
before update on public.hub_accounts
for each row execute function private.hub_set_updated_at();
drop trigger if exists hub_memberships_set_updated_at on public.hub_memberships;
create trigger hub_memberships_set_updated_at
before update on public.hub_memberships
for each row execute function private.hub_set_updated_at();
drop trigger if exists hub_plans_set_updated_at on public.hub_plans;
create trigger hub_plans_set_updated_at
before update on public.hub_plans
for each row execute function private.hub_set_updated_at();
drop trigger if exists hub_subscriptions_set_updated_at on public.hub_subscriptions;
create trigger hub_subscriptions_set_updated_at
before update on public.hub_subscriptions
for each row execute function private.hub_set_updated_at();
drop trigger if exists hub_checkout_sessions_set_updated_at on public.hub_checkout_sessions;
create trigger hub_checkout_sessions_set_updated_at
before update on public.hub_checkout_sessions
for each row execute function private.hub_set_updated_at();
drop trigger if exists hub_content_items_set_updated_at on public.hub_content_items;
create trigger hub_content_items_set_updated_at
before update on public.hub_content_items
for each row execute function private.hub_set_updated_at();
drop trigger if exists hub_educator_learners_set_updated_at on public.hub_educator_learners;
create trigger hub_educator_learners_set_updated_at
before update on public.hub_educator_learners
for each row execute function private.hub_set_updated_at();

create or replace function private.hub_has_account_access(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.hub_memberships membership
    where membership.account_id = p_account_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'ACTIVE'
  );
$$;

create or replace function private.hub_is_account_manager(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.hub_memberships membership
    where membership.account_id = p_account_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'ACTIVE'
      and membership.membership_role in ('OWNER', 'ADMIN')
  );
$$;

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
  v_account_created boolean := false;
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
      account_type, audience, name, owner_user_id, status, trial_claimed_at
    ) values (
      case when v_audience = 'INSTITUTION' then 'ORGANIZATION' else 'PERSONAL' end,
      v_audience,
      left(v_name, 160),
      v_user_id,
      'ACTIVE',
      now()
    ) returning * into v_account;
    v_account_created := true;

    insert into public.hub_memberships (account_id, user_id, membership_role, status)
    values (v_account.id, v_user_id, 'OWNER', 'ACTIVE');

    -- Public sign-ups start in enrollment quarantine as STUDENT with no tenant.
    -- Promote only that quarantined state; existing school roles remain intact.
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

  if not found then
    if not v_account_created then
      raise exception 'trial_already_claimed' using errcode = 'P0001';
    end if;
    select * into v_plan from public.hub_plans
    where code = 'DISCOVERY' and is_active = true;
    if not found then
      raise exception 'discovery_plan_unavailable' using errcode = 'P0001';
    end if;

    insert into public.hub_subscriptions (
      account_id, plan_id, status, trial_starts_at, trial_ends_at,
      current_period_starts_at, current_period_ends_at
    ) values (
      v_account.id, v_plan.id, 'TRIALING', now(),
      now() + make_interval(days => greatest(v_plan.trial_days, 1)),
      now(), now() + make_interval(days => greatest(v_plan.trial_days, 1))
    ) returning * into v_subscription;
  end if;

  return jsonb_build_object(
    'accountId', v_account.id,
    'subscriptionId', v_subscription.id,
    'status', v_subscription.status,
    'trialEndsAt', v_subscription.trial_ends_at
  );
end;
$$;

create or replace function private.hub_bootstrap_internal(p_account_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_account_id uuid;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;

  select membership.account_id into v_account_id
  from public.hub_memberships membership
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
    and (p_account_id is null or membership.account_id = p_account_id)
  order by (membership.membership_role = 'OWNER') desc, membership.created_at
  limit 1;

  if v_account_id is null then
    return null;
  end if;

  select jsonb_build_object(
    'account', to_jsonb(account),
    'membership', to_jsonb(membership),
    'subscription', to_jsonb(subscription),
    'plan', to_jsonb(plan),
    'entitlements', coalesce((
      select jsonb_object_agg(entitlement.feature_key, jsonb_build_object(
        'limit', entitlement.limit_value,
        'resetPeriod', entitlement.reset_period,
        'used', coalesce(usage.used_units, 0)
      ))
      from public.hub_plan_entitlements entitlement
      left join lateral (
        select counter.used_units
        from public.hub_usage_counters counter
        where counter.subscription_id = subscription.id
          and counter.feature_key = entitlement.feature_key
          and now() >= counter.period_start
          and now() < counter.period_end
        order by counter.period_start desc
        limit 1
      ) usage on true
      where entitlement.plan_id = plan.id
    ), '{}'::jsonb),
    'settings', coalesce((select to_jsonb(settings) from public.hub_settings settings where settings_key = 'default'), '{}'::jsonb)
  ) into v_result
  from public.hub_accounts account
  join public.hub_memberships membership
    on membership.account_id = account.id and membership.user_id = v_user_id
  left join lateral (
    select candidate.*
    from public.hub_subscriptions candidate
    where candidate.account_id = account.id
    order by (
      candidate.status in ('ACTIVE', 'TRIALING')
      and coalesce(candidate.trial_ends_at, candidate.current_period_ends_at, 'infinity'::timestamptz) > now()
    ) desc, candidate.created_at desc
    limit 1
  ) subscription on true
  left join public.hub_plans plan on plan.id = subscription.plan_id
  where account.id = v_account_id;

  return v_result;
end;
$$;

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
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_account_id uuid;
  v_subscription public.hub_subscriptions%rowtype;
  v_limit integer;
  v_reset text;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_used integer := 0;
  v_existing_event bigint;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if p_feature_key is null or length(trim(p_feature_key)) < 3 or p_units < 0 or p_units > 1000 then
    raise exception 'invalid_usage_request' using errcode = '22023';
  end if;

  select membership.account_id into v_account_id
  from public.hub_memberships membership
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
    and (p_account_id is null or membership.account_id = p_account_id)
  order by (membership.membership_role = 'OWNER') desc, membership.created_at
  limit 1;
  if v_account_id is null then
    return jsonb_build_object('allowed', false, 'code', 'HUB_ACCOUNT_REQUIRED');
  end if;

  select subscription.* into v_subscription
  from public.hub_subscriptions subscription
  where subscription.account_id = v_account_id
    and (
      (subscription.status = 'TRIALING' and subscription.trial_ends_at > now())
      or (subscription.status = 'ACTIVE' and coalesce(subscription.current_period_ends_at, 'infinity'::timestamptz) > now())
    )
  order by (subscription.status = 'ACTIVE') desc, subscription.created_at desc
  limit 1
  for update;
  if not found then
    return jsonb_build_object('allowed', false, 'code', 'SUBSCRIPTION_REQUIRED');
  end if;

  select entitlement.limit_value, entitlement.reset_period
    into v_limit, v_reset
  from public.hub_plan_entitlements entitlement
  where entitlement.plan_id = v_subscription.plan_id
    and entitlement.feature_key = trim(p_feature_key);
  if not found or v_limit = 0 then
    return jsonb_build_object('allowed', false, 'code', 'FEATURE_NOT_INCLUDED');
  end if;

  if p_request_key is not null then
    select event.id into v_existing_event
    from public.hub_usage_events event
    where event.subscription_id = v_subscription.id
      and event.feature_key = trim(p_feature_key)
      and event.request_key = p_request_key;
    if found then
      select coalesce(counter.used_units, 0) into v_used
      from public.hub_usage_counters counter
      where counter.subscription_id = v_subscription.id
        and counter.feature_key = trim(p_feature_key)
        and now() >= counter.period_start and now() < counter.period_end
      order by counter.period_start desc limit 1;
      return jsonb_build_object(
        'allowed', true,
        'idempotent', true,
        'used', coalesce(v_used, 0),
        'limit', v_limit,
        'remaining', case when v_limit is null then null else greatest(v_limit - coalesce(v_used, 0), 0) end
      );
    end if;
  end if;

  if v_reset = 'DAY' then
    v_period_start := date_trunc('day', now());
    v_period_end := v_period_start + interval '1 day';
  elsif v_reset = 'SUBSCRIPTION' then
    v_period_start := coalesce(v_subscription.trial_starts_at, v_subscription.current_period_starts_at, v_subscription.created_at);
    v_period_end := coalesce(v_subscription.trial_ends_at, v_subscription.current_period_ends_at, 'infinity'::timestamptz);
  else
    v_period_start := date_trunc('month', now());
    v_period_end := v_period_start + interval '1 month';
  end if;

  select counter.used_units into v_used
  from public.hub_usage_counters counter
  where counter.subscription_id = v_subscription.id
    and counter.feature_key = trim(p_feature_key)
    and counter.period_start = v_period_start
  for update;
  v_used := coalesce(v_used, 0);

  if v_limit is not null and v_used + p_units > v_limit then
    return jsonb_build_object(
      'allowed', false,
      'code', 'USAGE_LIMIT_REACHED',
      'used', v_used,
      'limit', v_limit,
      'remaining', greatest(v_limit - v_used, 0),
      'periodEndsAt', v_period_end
    );
  end if;

  if p_units > 0 then
    insert into public.hub_usage_counters (
      account_id, subscription_id, feature_key, period_start, period_end, used_units
    ) values (
      v_account_id, v_subscription.id, trim(p_feature_key), v_period_start, v_period_end, p_units
    ) on conflict (subscription_id, feature_key, period_start)
      do update set used_units = public.hub_usage_counters.used_units + excluded.used_units,
                    updated_at = now()
    returning used_units into v_used;

    insert into public.hub_usage_events (
      account_id, subscription_id, user_id, feature_key, units, request_key, metadata
    ) values (
      v_account_id, v_subscription.id, v_user_id, trim(p_feature_key), p_units,
      p_request_key, coalesce(p_metadata, '{}'::jsonb)
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'idempotent', false,
    'accountId', v_account_id,
    'subscriptionId', v_subscription.id,
    'used', v_used,
    'limit', v_limit,
    'remaining', case when v_limit is null then null else greatest(v_limit - v_used, 0) end,
    'periodEndsAt', v_period_end
  );
end;
$$;

create or replace function private.hub_track_event_internal(
  p_event_name text,
  p_source text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_account_id uuid;
begin
  if v_user_id is null then return; end if;
  if p_event_name is null or length(trim(p_event_name)) < 3 then return; end if;
  select account_id into v_account_id
  from public.hub_memberships
  where user_id = v_user_id and status = 'ACTIVE'
  order by created_at limit 1;
  insert into public.hub_conversion_events(account_id, user_id, event_name, source, metadata)
  values (v_account_id, v_user_id, left(trim(p_event_name), 100), left(trim(p_source), 100), coalesce(p_metadata, '{}'::jsonb));
end;
$$;

create or replace function public.hub_activate_paid_checkout(
  p_checkout_id uuid,
  p_payment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_checkout public.hub_checkout_sessions%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_period_end timestamptz;
begin
  select * into v_checkout
  from public.hub_checkout_sessions
  where id = p_checkout_id
  for update;
  if not found then
    raise exception 'hub_checkout_not_found' using errcode = 'P0002';
  end if;
  if v_checkout.status = 'CANCELLED' then
    raise exception 'hub_checkout_cancelled' using errcode = 'P0001';
  end if;

  v_period_end := case
    when v_checkout.billing_cycle = 'YEARLY' then now() + interval '1 year'
    else now() + interval '1 month'
  end;

  select * into v_subscription
  from public.hub_subscriptions
  where provider = 'ASAAS'
    and provider_subscription_id = v_checkout.asaas_subscription_id
  order by created_at desc
  limit 1
  for update;

  if found then
    update public.hub_subscriptions
       set status = 'ACTIVE',
           plan_id = v_checkout.plan_id,
           provider_payment_id = coalesce(nullif(p_payment_id, ''), provider_payment_id),
           current_period_starts_at = coalesce(current_period_starts_at, now()),
           current_period_ends_at = greatest(coalesce(current_period_ends_at, now()), v_period_end)
     where id = v_subscription.id
     returning * into v_subscription;
  else
    update public.hub_subscriptions
       set status = 'EXPIRED',
           current_period_ends_at = least(coalesce(current_period_ends_at, now()), now())
     where account_id = v_checkout.account_id
       and status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE');

    insert into public.hub_subscriptions (
      account_id, plan_id, status, billing_cycle,
      current_period_starts_at, current_period_ends_at,
      provider, provider_subscription_id, provider_payment_id,
      metadata
    ) values (
      v_checkout.account_id, v_checkout.plan_id, 'ACTIVE', v_checkout.billing_cycle,
      now(), v_period_end,
      'ASAAS', v_checkout.asaas_subscription_id, nullif(p_payment_id, ''),
      jsonb_build_object('checkoutId', v_checkout.id)
    ) returning * into v_subscription;
  end if;

  update public.hub_checkout_sessions
     set status = 'PAID',
         asaas_payment_id = coalesce(nullif(p_payment_id, ''), asaas_payment_id)
   where id = v_checkout.id;

  if v_checkout.status <> 'PAID' then
    insert into public.hub_conversion_events(account_id, user_id, event_name, source, metadata)
    values (
      v_checkout.account_id,
      v_checkout.requested_by,
      'hub_subscription_paid',
      'asaas_webhook',
      jsonb_build_object('checkoutId', v_checkout.id, 'planId', v_checkout.plan_id)
    );
  end if;

  return jsonb_build_object(
    'accountId', v_checkout.account_id,
    'subscriptionId', v_subscription.id,
    'status', v_subscription.status
  );
end;
$$;

-- Public Data API wrappers remain SECURITY INVOKER. Privileged work stays in
-- the non-exposed private schema and every private function verifies auth.uid().
create or replace function public.hub_claim_trial(
  p_audience text default 'EDUCATOR',
  p_account_name text default null
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog, public, private
as $$ select private.hub_claim_trial_internal(p_audience, p_account_name); $$;

create or replace function public.hub_bootstrap(p_account_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public, private
as $$ select private.hub_bootstrap_internal(p_account_id); $$;

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
set search_path = pg_catalog, public, private
as $$ select private.hub_consume_feature_internal(p_feature_key, p_units, p_request_key, p_account_id, p_metadata); $$;

create or replace function public.hub_track_event(
  p_event_name text,
  p_source text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security invoker
set search_path = pg_catalog, public, private
as $$ select private.hub_track_event_internal(p_event_name, p_source, p_metadata); $$;

alter table public.hub_accounts enable row level security;
alter table public.hub_memberships enable row level security;
alter table public.hub_plans enable row level security;
alter table public.hub_plan_entitlements enable row level security;
alter table public.hub_subscriptions enable row level security;
alter table public.hub_checkout_sessions enable row level security;
alter table public.hub_usage_counters enable row level security;
alter table public.hub_usage_events enable row level security;
alter table public.hub_content_items enable row level security;
alter table public.hub_content_assets enable row level security;
alter table public.hub_content_access_events enable row level security;
alter table public.hub_educator_learners enable row level security;
alter table public.hub_conversion_events enable row level security;
alter table public.hub_settings enable row level security;

create policy hub_accounts_select_members
  on public.hub_accounts for select to authenticated
  using ((select private.hub_has_account_access(id)));
create policy hub_accounts_update_managers
  on public.hub_accounts for update to authenticated
  using ((select private.hub_is_account_manager(id)))
  with check ((select private.hub_is_account_manager(id)));

create policy hub_memberships_select_members
  on public.hub_memberships for select to authenticated
  using ((select private.hub_has_account_access(account_id)));

create policy hub_plans_public_read
  on public.hub_plans for select to anon, authenticated
  using (is_public = true and is_active = true);

create policy hub_subscriptions_select_members
  on public.hub_subscriptions for select to authenticated
  using ((select private.hub_has_account_access(account_id)));
create policy hub_checkout_sessions_select_members
  on public.hub_checkout_sessions for select to authenticated
  using ((select private.hub_has_account_access(account_id)));
create policy hub_usage_counters_select_members
  on public.hub_usage_counters for select to authenticated
  using ((select private.hub_has_account_access(account_id)));
create policy hub_usage_events_select_members
  on public.hub_usage_events for select to authenticated
  using ((select private.hub_has_account_access(account_id)));

create policy hub_content_items_public_catalog
  on public.hub_content_items for select to anon, authenticated
  using (is_active = true and published_at is not null and published_at <= now());

create policy hub_content_access_select_members
  on public.hub_content_access_events for select to authenticated
  using ((select private.hub_has_account_access(account_id)));

create policy hub_educator_learners_select_members
  on public.hub_educator_learners for select to authenticated
  using ((select private.hub_has_account_access(account_id)));
create policy hub_educator_learners_insert_members
  on public.hub_educator_learners for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.hub_has_account_access(account_id))
  );
create policy hub_educator_learners_update_members
  on public.hub_educator_learners for update to authenticated
  using ((select private.hub_has_account_access(account_id)))
  with check ((select private.hub_has_account_access(account_id)));
create policy hub_educator_learners_delete_managers
  on public.hub_educator_learners for delete to authenticated
  using ((select private.hub_is_account_manager(account_id)) or created_by = (select auth.uid()));

create policy hub_conversion_events_select_members
  on public.hub_conversion_events for select to authenticated
  using (account_id is not null and (select private.hub_has_account_access(account_id)));

create policy hub_settings_public_read
  on public.hub_settings for select to anon, authenticated
  using (true);

-- No authenticated storage.objects SELECT policy is created intentionally.
-- The signed URL Edge Function is the only reader of paid Hub assets.

revoke all on public.hub_accounts, public.hub_memberships, public.hub_plans,
  public.hub_plan_entitlements, public.hub_subscriptions,
  public.hub_checkout_sessions,
  public.hub_usage_counters, public.hub_usage_events,
  public.hub_content_items, public.hub_content_assets,
  public.hub_content_access_events, public.hub_educator_learners,
  public.hub_conversion_events, public.hub_settings
  from anon, authenticated;
grant select on public.hub_plans, public.hub_content_items, public.hub_settings to anon, authenticated;
grant select on public.hub_accounts to authenticated;
grant update(name, audience, metadata) on public.hub_accounts to authenticated;
grant select on public.hub_memberships, public.hub_subscriptions,
  public.hub_checkout_sessions,
  public.hub_usage_counters, public.hub_usage_events,
  public.hub_content_access_events, public.hub_conversion_events to authenticated;
grant select, insert, update, delete on public.hub_educator_learners to authenticated;

revoke all on function private.hub_has_account_access(uuid) from public;
revoke all on function private.hub_is_account_manager(uuid) from public;
revoke all on function private.hub_claim_trial_internal(text,text) from public;
revoke all on function private.hub_bootstrap_internal(uuid) from public;
revoke all on function private.hub_consume_feature_internal(text,integer,uuid,uuid,jsonb) from public;
revoke all on function private.hub_track_event_internal(text,text,jsonb) from public;
grant usage on schema private to authenticated;
grant execute on function private.hub_has_account_access(uuid) to authenticated;
grant execute on function private.hub_is_account_manager(uuid) to authenticated;
grant execute on function private.hub_claim_trial_internal(text,text) to authenticated;
grant execute on function private.hub_bootstrap_internal(uuid) to authenticated;
grant execute on function private.hub_consume_feature_internal(text,integer,uuid,uuid,jsonb) to authenticated;
grant execute on function private.hub_track_event_internal(text,text,jsonb) to authenticated;

revoke all on function public.hub_claim_trial(text,text) from public;
revoke all on function public.hub_bootstrap(uuid) from public;
revoke all on function public.hub_consume_feature(text,integer,uuid,uuid,jsonb) from public;
revoke all on function public.hub_track_event(text,text,jsonb) from public;
revoke all on function public.hub_activate_paid_checkout(uuid,text) from public;
grant execute on function public.hub_claim_trial(text,text) to authenticated;
grant execute on function public.hub_bootstrap(uuid) to authenticated;
grant execute on function public.hub_consume_feature(text,integer,uuid,uuid,jsonb) to authenticated;
grant execute on function public.hub_track_event(text,text,jsonb) to authenticated;
grant execute on function public.hub_activate_paid_checkout(uuid,text) to service_role;

comment on table public.hub_accounts is
  'Commercial Hub accounts, independent from school tenants.';
comment on table public.hub_content_assets is
  'Private storage paths. Read only by trusted server-side Hub functions.';
comment on function public.hub_consume_feature(text,integer,uuid,uuid,jsonb) is
  'Atomically authorizes and meters a Hub feature for the authenticated member.';
