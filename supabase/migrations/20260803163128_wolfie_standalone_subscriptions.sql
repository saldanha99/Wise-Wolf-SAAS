begin;

-- Wolfie standalone commercial boundary.
--
-- The buyer is provisioned into a tenant that contains only Wolfie data. This
-- deliberately reuses the hardened Wolfie session/minute ledger without
-- attaching the buyer to a real school, class, opportunity or student payment.
-- Paid authority remains the Hub subscription; role alone never unlocks a
-- standalone account in Edge Functions or the Wolfie frontend.

create schema if not exists private;

insert into public.tenants (
  id,
  name,
  domain,
  branding,
  student_limit,
  teacher_limit,
  whatsapp_enabled
)
values (
  'wolfie-direct',
  'Wolfie AI Tutor',
  'wolfie-direct-internal',
  '{"primaryColor":"#e72d3d","secondaryColor":"#ffbf69","logoUrl":"","faviconUrl":""}'::jsonb,
  1000000,
  0,
  false
)
on conflict (id) do update
set name = excluded.name,
    branding = excluded.branding,
    whatsapp_enabled = false;

alter table public.hub_plans
  add column if not exists product_family text not null default 'HUB_CORE';
alter table public.hub_subscriptions
  add column if not exists product_family text not null default 'HUB_CORE';
alter table public.hub_checkout_sessions
  add column if not exists product_family text not null default 'HUB_CORE';

update public.hub_plans
set product_family = case
  when code like 'WOLFIE_%' then 'WOLFIE_STANDALONE'
  else coalesce(nullif(metadata ->> 'product_family', ''), 'HUB_CORE')
end;

update public.hub_subscriptions as subscription
set product_family = plan.product_family
from public.hub_plans as plan
where plan.id = subscription.plan_id
  and subscription.product_family is distinct from plan.product_family;

update public.hub_checkout_sessions as checkout
set product_family = plan.product_family
from public.hub_plans as plan
where plan.id = checkout.plan_id
  and checkout.product_family is distinct from plan.product_family;

drop index if exists public.hub_one_live_subscription_per_account;
create unique index if not exists hub_one_live_subscription_per_product
  on public.hub_subscriptions(account_id, product_family)
  where status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE');

create index if not exists hub_plans_product_family_idx
  on public.hub_plans(product_family, is_active, is_public, display_order);
create index if not exists hub_checkout_account_product_idx
  on public.hub_checkout_sessions(account_id, product_family, status, created_at desc);

-- A request key prevents a browser retry from duplicating one intent, while
-- this index prevents two different request keys from opening competing
-- checkouts for the same product. Keep the newest legacy intent and close the
-- others before adding the concurrency guarantee. Provider-backed duplicates
-- are never guessed at: cancelling either side could leave a live Asaas charge
-- detached from the local subscription, so those groups stop the migration
-- for explicit financial reconciliation.
do $provider_checkout_reconciliation$
begin
  if exists (
    select 1
    from public.hub_checkout_sessions as checkout
    where checkout.status in ('CREATED', 'PENDING', 'OVERDUE')
    group by checkout.account_id, checkout.product_family
    having pg_catalog.count(*) > 1
      and pg_catalog.bool_or(
        nullif(checkout.asaas_subscription_id, '') is not null
        or nullif(checkout.asaas_payment_id, '') is not null
      )
  ) then
    raise exception using
      errcode = '23505',
      message = 'duplicate_provider_backed_hub_checkouts_require_reconciliation';
  end if;
end;
$provider_checkout_reconciliation$;

with ranked_open_checkouts as (
  select
    checkout.id,
    row_number() over (
      partition by checkout.account_id, checkout.product_family
      order by checkout.created_at desc, checkout.id desc
    ) as open_rank
  from public.hub_checkout_sessions as checkout
  where checkout.status in ('CREATED', 'PENDING', 'OVERDUE')
    and nullif(checkout.asaas_subscription_id, '') is null
    and nullif(checkout.asaas_payment_id, '') is null
)
update public.hub_checkout_sessions as checkout
set status = 'CANCELLED',
    metadata = checkout.metadata || jsonb_build_object(
      'cancelledByMigration', true,
      'cancelledReason', 'duplicate_open_product_checkout'
    ),
    updated_at = now()
from ranked_open_checkouts as ranked
where ranked.id = checkout.id
  and ranked.open_rank > 1;

create unique index if not exists hub_one_open_checkout_per_product
  on public.hub_checkout_sessions(account_id, product_family)
  where status in ('CREATED', 'PENDING', 'OVERDUE');

alter table public.hub_checkout_sessions
  drop constraint if exists hub_checkout_sessions_status_check;
alter table public.hub_checkout_sessions
  add constraint hub_checkout_sessions_status_check check (
    status in (
      'CREATED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'OVERDUE',
      'REVERSED'
    )
  );

insert into public.hub_plans (
  code,
  name,
  description,
  audience,
  price_monthly,
  price_yearly,
  currency,
  trial_days,
  display_order,
  is_public,
  is_active,
  features,
  metadata,
  product_family
)
values
  (
    'WOLFIE_FOCO',
    'Foco',
    'Para começar, destravar e manter o inglês em movimento.',
    'LEARNER',
    49.90,
    null,
    'BRL',
    0,
    110,
    true,
    true,
    '["Texto ilimitado","45 minutos de voz ao vivo","Todos os cenários","Feedback e memória de aprendizagem"]'::jsonb,
    '{"product_family":"WOLFIE_STANDALONE","version":1,"live_minutes":45,"student_plan_name":"Wolfie Foco","checkout_enabled":true}'::jsonb,
    'WOLFIE_STANDALONE'
  ),
  (
    'WOLFIE_RITMO',
    'Ritmo',
    'Para transformar prática em rotina e perceber evolução toda semana.',
    'LEARNER',
    99.90,
    null,
    'BRL',
    0,
    120,
    true,
    true,
    '["Texto ilimitado","120 minutos de voz ao vivo","Todos os cenários","Feedback e memória de aprendizagem"]'::jsonb,
    '{"product_family":"WOLFIE_STANDALONE","version":1,"live_minutes":120,"student_plan_name":"Wolfie Ritmo","checkout_enabled":true,"recommended":true}'::jsonb,
    'WOLFIE_STANDALONE'
  ),
  (
    'WOLFIE_PERFORMANCE',
    'Performance',
    'Para reuniões, entrevistas e apresentações com uma meta próxima.',
    'LEARNER',
    179.90,
    null,
    'BRL',
    0,
    130,
    true,
    true,
    '["Texto ilimitado","240 minutos de voz ao vivo","Todos os cenários","Feedback e memória de aprendizagem"]'::jsonb,
    '{"product_family":"WOLFIE_STANDALONE","version":1,"live_minutes":240,"student_plan_name":"Wolfie Performance","checkout_enabled":true}'::jsonb,
    'WOLFIE_STANDALONE'
  )
on conflict (code) do update
set name = excluded.name,
    description = excluded.description,
    audience = excluded.audience,
    price_monthly = excluded.price_monthly,
    price_yearly = excluded.price_yearly,
    currency = excluded.currency,
    trial_days = excluded.trial_days,
    display_order = excluded.display_order,
    is_public = excluded.is_public,
    is_active = excluded.is_active,
    features = excluded.features,
    metadata = excluded.metadata,
    product_family = excluded.product_family,
    updated_at = now();

update public.hub_plans as legacy
set is_public = false,
    is_active = exists (
      select 1
      from public.hub_subscriptions as subscription
      where subscription.plan_id = legacy.id
        and subscription.status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
    ),
    metadata = legacy.metadata || '{"replaced_by":"WOLFIE_FOCO","product_family":"WOLFIE_STANDALONE","student_plan_name":"Wolfie Foco","live_minutes":45,"checkout_enabled":false}'::jsonb,
    product_family = 'WOLFIE_STANDALONE',
    updated_at = now()
where legacy.code = 'WOLFIE_PERSONAL';

insert into public.hub_plan_entitlements (
  plan_id,
  feature_key,
  limit_value,
  reset_period,
  metadata
)
select
  plan.id,
  entitlement.feature_key,
  entitlement.limit_value,
  'MONTH',
  '{"product_family":"WOLFIE_STANDALONE"}'::jsonb
from public.hub_plans as plan
cross join lateral (
  values
    ('wolfie.turn'::text, null::integer),
    ('wolfie.live_minutes'::text, (plan.metadata ->> 'live_minutes')::integer),
    ('wolfie.speech_analysis'::text, null::integer)
) as entitlement(feature_key, limit_value)
where plan.code in ('WOLFIE_FOCO', 'WOLFIE_RITMO', 'WOLFIE_PERFORMANCE')
on conflict (plan_id, feature_key) do update
set limit_value = excluded.limit_value,
    reset_period = excluded.reset_period,
    metadata = excluded.metadata;

-- The academic plan rows are only an adapter for the existing, hardened live
-- minute ledger. They do not contain classes and are never offered by school
-- enrollment screens outside the isolated tenant.
update public.student_pricing_plans
set description = 'Acesso pendente de confirmação de assinatura Wolfie.',
    classes_per_week = 0,
    fidelity_months = 1,
    monthly_price = 0,
    original_price = null,
    active = false
where tenant_id = 'wolfie-direct' and name = 'Wolfie Pendente';
insert into public.student_pricing_plans (
  tenant_id, name, description, classes_per_week, fidelity_months,
  monthly_price, original_price, active
)
select
  'wolfie-direct', 'Wolfie Pendente',
  'Acesso pendente de confirmação de assinatura Wolfie.',
  0, 1, 0, null, false
where not exists (
  select 1 from public.student_pricing_plans
  where tenant_id = 'wolfie-direct' and name = 'Wolfie Pendente'
);

update public.student_pricing_plans as pricing
set description = source.description,
    classes_per_week = 0,
    fidelity_months = 1,
    monthly_price = source.monthly_price,
    original_price = null,
    active = true
from (
  values
    ('Wolfie Foco'::text, '45 minutos mensais de voz ao vivo e texto ilimitado.'::text, 49.90::numeric),
    ('Wolfie Ritmo'::text, '120 minutos mensais de voz ao vivo e texto ilimitado.'::text, 99.90::numeric),
    ('Wolfie Performance'::text, '240 minutos mensais de voz ao vivo e texto ilimitado.'::text, 179.90::numeric)
) as source(name, description, monthly_price)
where pricing.tenant_id = 'wolfie-direct'
  and pricing.name = source.name;

insert into public.student_pricing_plans (
  tenant_id, name, description, classes_per_week, fidelity_months,
  monthly_price, original_price, active
)
select
  'wolfie-direct', source.name, source.description, 0, 1,
  source.monthly_price, null, true
from (
  values
    ('Wolfie Foco'::text, '45 minutos mensais de voz ao vivo e texto ilimitado.'::text, 49.90::numeric),
    ('Wolfie Ritmo'::text, '120 minutos mensais de voz ao vivo e texto ilimitado.'::text, 99.90::numeric),
    ('Wolfie Performance'::text, '240 minutos mensais de voz ao vivo e texto ilimitado.'::text, 179.90::numeric)
) as source(name, description, monthly_price)
where not exists (
  select 1
  from public.student_pricing_plans as existing
  where existing.tenant_id = 'wolfie-direct'
    and existing.name = source.name
);

insert into public.student_plan_entitlements (
  tenant_id,
  plan_id,
  feature_key,
  limit_value,
  reset_period,
  access_mode
)
select
  'wolfie-direct',
  pricing.id,
  'wolfie.live_minutes',
  source.live_minutes,
  'MONTH',
  'LIMITED'
from public.student_pricing_plans as pricing
join (
  values
    ('Wolfie Pendente'::text, 0::integer),
    ('Wolfie Foco'::text, 45::integer),
    ('Wolfie Ritmo'::text, 120::integer),
    ('Wolfie Performance'::text, 240::integer)
) as source(name, live_minutes)
  on source.name = pricing.name
where pricing.tenant_id = 'wolfie-direct'
on conflict on constraint student_plan_entitlements_unique do update
set limit_value = excluded.limit_value,
    reset_period = excluded.reset_period,
    access_mode = excluded.access_mode;

update public.wolfie_topup_packages as package
set name = source.name,
    price_brl = source.price_brl,
    active = true
from (
  values
    (60::integer, '60 minutos extras'::text, 39.90::numeric),
    (180::integer, '180 minutos extras'::text, 99.90::numeric)
) as source(minutes, name, price_brl)
where package.tenant_id = 'wolfie-direct'
  and package.minutes = source.minutes;

insert into public.wolfie_topup_packages (
  tenant_id,
  name,
  minutes,
  price_brl,
  active
)
select
  'wolfie-direct',
  source.name,
  source.minutes,
  source.price_brl,
  true
from (
  values
    (60::integer, '60 minutos extras'::text, 39.90::numeric),
    (180::integer, '180 minutos extras'::text, 99.90::numeric)
) as source(minutes, name, price_brl)
where not exists (
  select 1
  from public.wolfie_topup_packages as existing
  where existing.tenant_id = 'wolfie-direct'
    and existing.minutes = source.minutes
);

create table if not exists public.wolfie_standalone_acceptances (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  terms_version text not null check (char_length(terms_version) between 3 and 80),
  quiz_snapshot jsonb not null default '{}'::jsonb,
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (
    jsonb_typeof(quiz_snapshot) = 'object'
    and pg_column_size(quiz_snapshot) <= 16000
  ),
  unique(account_id, user_id, terms_version)
);
create index if not exists wolfie_acceptances_user_idx
  on public.wolfie_standalone_acceptances(user_id, accepted_at desc);
alter table public.wolfie_standalone_acceptances enable row level security;
revoke all on table public.wolfie_standalone_acceptances
  from public, anon, authenticated;
grant select on table public.wolfie_standalone_acceptances to authenticated;
grant all on table public.wolfie_standalone_acceptances to service_role;
drop policy if exists wolfie_acceptances_read_own
  on public.wolfie_standalone_acceptances;
create policy wolfie_acceptances_read_own
  on public.wolfie_standalone_acceptances
  for select to authenticated
  using (user_id = (select auth.uid()));

create table if not exists public.hub_payment_event_inbox (
  id bigint generated always as identity primary key,
  event_key text not null unique check (char_length(event_key) between 3 and 200),
  event_name text not null check (char_length(event_name) between 3 and 100),
  payment_id text not null check (char_length(payment_id) between 1 and 200),
  checkout_id uuid references public.hub_checkout_sessions(id) on delete set null,
  status text not null default 'PROCESSING'
    check (status in ('PROCESSING', 'PROCESSED', 'FAILED')),
  attempt_count integer not null default 1 check (attempt_count between 1 and 100),
  lease_expires_at timestamptz not null default (now() + interval '2 minutes'),
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hub_payment_event_retry_idx
  on public.hub_payment_event_inbox(status, lease_expires_at)
  where status in ('PROCESSING', 'FAILED');
alter table public.hub_payment_event_inbox enable row level security;
revoke all on table public.hub_payment_event_inbox
  from public, anon, authenticated;
grant all on table public.hub_payment_event_inbox to service_role;
revoke all on sequence public.hub_payment_event_inbox_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.hub_payment_event_inbox_id_seq
  to service_role;

-- One provider payment buys at most one subscription period, even when Asaas
-- emits PAYMENT_CONFIRMED and PAYMENT_RECEIVED for the same payment. OVERDUE
-- is kept here too so a later settlement can transition the same row to
-- APPLIED without creating a second period.
create table if not exists public.hub_subscription_payments (
  id bigint generated always as identity primary key,
  provider text not null default 'ASAAS'
    check (char_length(provider) between 2 and 40),
  provider_payment_id text not null
    check (char_length(provider_payment_id) between 1 and 200),
  checkout_id uuid not null
    references public.hub_checkout_sessions(id) on delete restrict,
  subscription_id uuid
    references public.hub_subscriptions(id) on delete restrict,
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  product_family text not null,
  status text not null
    check (status in ('OVERDUE', 'APPLIED', 'REVERSED')),
  period_starts_at timestamptz,
  period_ends_at timestamptz,
  applied_at timestamptz,
  reversed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_payment_id)
);
create index if not exists hub_subscription_payments_subscription_idx
  on public.hub_subscription_payments(subscription_id, created_at desc);
create index if not exists hub_subscription_payments_checkout_idx
  on public.hub_subscription_payments(checkout_id, created_at desc);
alter table public.hub_subscription_payments enable row level security;
revoke all on table public.hub_subscription_payments
  from public, anon, authenticated;
grant all on table public.hub_subscription_payments to service_role;
revoke all on sequence public.hub_subscription_payments_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.hub_subscription_payments_id_seq
  to service_role;

-- Preserve exactly-once semantics for payments that were already applied
-- before this ledger existed. A later duplicate webhook is recognized as an
-- old payment and never extends the period again.
insert into public.hub_subscription_payments (
  provider,
  provider_payment_id,
  checkout_id,
  subscription_id,
  account_id,
  product_family,
  status,
  period_starts_at,
  period_ends_at,
  applied_at,
  metadata
)
select
  'ASAAS',
  checkout.asaas_payment_id,
  checkout.id,
  subscription.id,
  checkout.account_id,
  checkout.product_family,
  'APPLIED',
  subscription.current_period_starts_at,
  subscription.current_period_ends_at,
  coalesce(checkout.updated_at, checkout.created_at),
  '{"source":"standalone_migration_backfill"}'::jsonb
from public.hub_checkout_sessions as checkout
join lateral (
  select candidate.*
  from public.hub_subscriptions as candidate
  where candidate.account_id = checkout.account_id
    and candidate.product_family = checkout.product_family
    and (
      (
        checkout.asaas_subscription_id is not null
        and candidate.provider = 'ASAAS'
        and candidate.provider_subscription_id = checkout.asaas_subscription_id
      )
      or candidate.metadata ->> 'checkoutId' = checkout.id::text
    )
  order by
    (candidate.provider_payment_id = checkout.asaas_payment_id) desc,
    candidate.created_at desc,
    candidate.id desc
  limit 1
) as subscription on true
where checkout.status = 'PAID'
  and nullif(checkout.asaas_payment_id, '') is not null
on conflict (provider, provider_payment_id) do nothing;

create or replace function private.wolfie_prepare_checkout_account_internal(
  p_full_name text,
  p_terms_version text,
  p_quiz jsonb default '{}'::jsonb
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
  v_pending_plan_id uuid;
  v_existing_school_tenant text;
  v_full_name text := pg_catalog.left(
    nullif(pg_catalog.btrim(p_full_name), ''),
    160
  );
  v_terms_version text := pg_catalog.left(
    nullif(pg_catalog.btrim(p_terms_version), ''),
    80
  );
  v_quiz jsonb := coalesce(p_quiz, '{}'::jsonb);
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if v_full_name is null or pg_catalog.char_length(v_full_name) < 3 then
    raise exception using errcode = '22023', message = 'full_name_required';
  end if;
  if v_terms_version is null
     or pg_catalog.char_length(v_terms_version) < 3 then
    raise exception using errcode = '22023', message = 'terms_acceptance_required';
  end if;
  if pg_catalog.jsonb_typeof(v_quiz) <> 'object'
     or pg_catalog.pg_column_size(v_quiz) > 16000 then
    raise exception using errcode = '22023', message = 'invalid_quiz_snapshot';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'profile_required';
  end if;

  select membership.tenant_id into v_existing_school_tenant
  from public.tenant_memberships as membership
  where membership.user_id = v_user_id
    and membership.tenant_id <> 'wolfie-direct'
    and membership.status = 'ACTIVE'
    and membership.role = 'STUDENT'
  order by membership.is_primary desc, membership.created_at, membership.id
  limit 1;
  if found then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'alreadyIncluded', true,
      'accessKind', 'SCHOOL',
      'tenantId', v_existing_school_tenant
    );
  end if;

  if v_profile.tenant_id is null
     and v_profile.role not in ('STUDENT', 'NON_STUDENT') then
    raise exception using errcode = '42501',
      message = 'profile_not_eligible_for_standalone';
  elsif v_profile.tenant_id = 'wolfie-direct'
        and v_profile.role <> 'STUDENT' then
    raise exception using errcode = '42501',
      message = 'invalid_wolfie_profile_role';
  elsif v_profile.tenant_id is not null
        and v_profile.tenant_id <> 'wolfie-direct' then
    raise exception using errcode = '42501',
      message = 'existing_school_profile_not_eligible_for_standalone';
  end if;

  select account.* into v_account
  from public.hub_accounts as account
  where account.owner_user_id = v_user_id
    and account.account_type = 'PERSONAL'
  order by account.created_at
  limit 1
  for update;

  if not found then
    insert into public.hub_accounts (
      account_type, audience, name, owner_user_id, status, metadata
    ) values (
      'PERSONAL', 'LEARNER', v_full_name, v_user_id, 'ACTIVE',
      pg_catalog.jsonb_build_object(
        'product_family', 'WOLFIE_STANDALONE',
        'wolfie_onboarding_started_at', pg_catalog.now()
      )
    ) returning * into v_account;
  else
    update public.hub_accounts
    set audience = 'LEARNER',
        name = v_full_name,
        status = 'ACTIVE',
        metadata = metadata || pg_catalog.jsonb_build_object(
          'wolfie_onboarding_started_at', pg_catalog.now()
        )
    where id = v_account.id
    returning * into v_account;
  end if;

  insert into public.hub_memberships (
    account_id, user_id, membership_role, status
  ) values (
    v_account.id, v_user_id, 'OWNER', 'ACTIVE'
  )
  on conflict (account_id, user_id) do update
  set membership_role = 'OWNER',
      status = 'ACTIVE',
      updated_at = pg_catalog.now();

  select id into v_pending_plan_id
  from public.student_pricing_plans
  where tenant_id = 'wolfie-direct' and name = 'Wolfie Pendente'
  order by id
  limit 1;
  if v_pending_plan_id is null then
    raise exception using errcode = '55000', message = 'wolfie_pending_plan_missing';
  end if;

  perform pg_catalog.set_config('app.enrollment_claim', '1', true);
  update public.profiles
  set full_name = v_full_name,
      role = 'STUDENT',
      tenant_id = 'wolfie-direct',
      status_financial = 'PENDING',
      fidelity_plan = 'Wolfie Pendente'
  where id = v_user_id;

  insert into public.tenant_memberships (
    user_id, tenant_id, role, status, is_primary, student_plan_id
  ) values (
    v_user_id, 'wolfie-direct', 'STUDENT', 'ACTIVE', true, v_pending_plan_id
  )
  on conflict (user_id, tenant_id) do update
  set role = 'STUDENT',
      status = 'ACTIVE',
      is_primary = true,
      student_plan_id = v_pending_plan_id,
      updated_at = pg_catalog.now();

  insert into public.tenant_user_contexts(user_id, tenant_id)
  values (v_user_id, 'wolfie-direct')
  on conflict (user_id) do update
  set tenant_id = excluded.tenant_id,
      updated_at = pg_catalog.now();

  insert into public.wolfie_standalone_acceptances (
    account_id, user_id, terms_version, quiz_snapshot
  ) values (
    v_account.id, v_user_id, v_terms_version, v_quiz
  )
  on conflict (account_id, user_id, terms_version) do update
  set quiz_snapshot = excluded.quiz_snapshot,
      accepted_at = pg_catalog.now();

  insert into public.hub_conversion_events (
    account_id, user_id, event_name, source, metadata
  ) values (
    v_account.id,
    v_user_id,
    'wolfie_checkout_account_prepared',
    'wolfie_funnel',
    pg_catalog.jsonb_build_object('termsVersion', v_terms_version)
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'alreadyIncluded', false,
    'accountId', v_account.id,
    'tenantId', 'wolfie-direct',
    'accessKind', 'STANDALONE'
  );
end;
$function$;

create or replace function public.wolfie_prepare_checkout_account(
  p_full_name text,
  p_terms_version text,
  p_quiz jsonb default '{}'::jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select private.wolfie_prepare_checkout_account_internal(
    p_full_name,
    p_terms_version,
    p_quiz
  );
$function$;

create or replace function private.wolfie_access_snapshot(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_profile public.profiles%rowtype;
  v_school_membership public.tenant_memberships%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_plan public.hub_plans%rowtype;
  v_account_id uuid;
begin
  if p_user_id is null then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'AUTHENTICATION_REQUIRED'
    );
  end if;

  select * into v_profile
  from public.profiles
  where id = p_user_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'PROFILE_REQUIRED'
    );
  end if;

  select membership.* into v_school_membership
  from public.tenant_memberships as membership
  where membership.user_id = p_user_id
    and membership.status = 'ACTIVE'
    and membership.role = 'STUDENT'
    and membership.tenant_id <> 'wolfie-direct'
  order by membership.is_primary desc, membership.created_at
  limit 1;
  if found then
    return pg_catalog.jsonb_build_object(
      'allowed', true,
      'accessKind', 'SCHOOL',
      'tenantId', v_school_membership.tenant_id,
      'planCode', null,
      'planName', 'Acesso pela escola'
    );
  end if;

  if not exists (
    select 1
    from public.tenant_memberships as membership
    where membership.user_id = p_user_id
      and membership.tenant_id = 'wolfie-direct'
      and membership.status = 'ACTIVE'
      and membership.role = 'STUDENT'
  ) then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'WOLFIE_ACCOUNT_REQUIRED'
    );
  end if;

  select account.id into v_account_id
  from public.hub_accounts as account
  join public.hub_memberships as membership
    on membership.account_id = account.id
  where account.owner_user_id = p_user_id
    and account.account_type = 'PERSONAL'
    and account.status = 'ACTIVE'
    and membership.user_id = p_user_id
    and membership.status = 'ACTIVE'
    and membership.membership_role = 'OWNER'
  order by account.created_at, account.id
  limit 1;
  if v_account_id is null then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'WOLFIE_ACCOUNT_REQUIRED'
    );
  end if;

  select subscription.*
  into v_subscription
  from public.hub_subscriptions as subscription
  join public.hub_plans as plan on plan.id = subscription.plan_id
  where subscription.account_id = v_account_id
    and subscription.product_family = 'WOLFIE_STANDALONE'
    and plan.product_family = 'WOLFIE_STANDALONE'
    and subscription.status = 'ACTIVE'
    and coalesce(
      subscription.current_period_ends_at,
      '-infinity'::timestamptz
    ) > pg_catalog.now()
  order by subscription.created_at desc
  limit 1;

  if not found then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'WOLFIE_SUBSCRIPTION_REQUIRED',
      'accessKind', 'STANDALONE',
      'tenantId', 'wolfie-direct'
    );
  end if;

  select * into v_plan
  from public.hub_plans
  where id = v_subscription.plan_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'WOLFIE_PLAN_REQUIRED',
      'accessKind', 'STANDALONE',
      'tenantId', 'wolfie-direct'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'accessKind', 'STANDALONE',
    'tenantId', 'wolfie-direct',
    'accountId', v_account_id,
    'subscriptionId', v_subscription.id,
    'subscriptionStatus', v_subscription.status,
    'periodEndsAt', v_subscription.current_period_ends_at,
    'planCode', v_plan.code,
    'planName', v_plan.name,
    'liveMinutes', coalesce(
      (v_plan.metadata ->> 'live_minutes')::integer,
      0
    )
  );
end;
$function$;

create or replace function public.wolfie_access_for_user(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_user_id is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.wolfie_access_snapshot(p_user_id);
end;
$function$;

create or replace function public.my_wolfie_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  return private.wolfie_access_snapshot(auth.uid());
end;
$function$;

-- Legacy Hub RPCs predate product families and used to pick whichever
-- subscription was newest. Keep their public signatures, but make them
-- explicitly HUB_CORE so a Wolfie-only buyer cannot acquire or consume Hub
-- entitlements and a Wolfie subscription cannot hide a valid Hub plan.
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
  if v_audience not in ('LEARNER', 'EDUCATOR', 'INSTITUTION') then
    raise exception 'invalid_audience' using errcode = '22023';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id;
  if not found then
    raise exception 'profile_required' using errcode = 'P0001';
  end if;
  if v_profile.tenant_id = 'wolfie-direct' then
    raise exception 'wolfie_direct_hub_restricted' using errcode = 'P0001';
  end if;

  select account.* into v_account
  from public.hub_accounts as account
  join public.hub_memberships as membership
    on membership.account_id = account.id
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
  order by
    (membership.membership_role = 'OWNER') desc,
    account.created_at,
    account.id
  limit 1;

  if not found then
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
      account_type, audience, name, owner_user_id, status
    ) values (
      case when v_audience = 'INSTITUTION'
        then 'ORGANIZATION'
        else 'PERSONAL'
      end,
      v_audience,
      pg_catalog.left(v_name, 160),
      v_user_id,
      'ACTIVE'
    ) returning * into v_account;

    insert into public.hub_memberships (
      account_id, user_id, membership_role, status
    ) values (
      v_account.id, v_user_id, 'OWNER', 'ACTIVE'
    );

    perform pg_catalog.set_config('app.enrollment_claim', '1', true);
    update public.profiles
    set role = 'NON_STUDENT'
    where id = v_user_id
      and role = 'STUDENT'
      and tenant_id is null;
  end if;

  select * into v_subscription
  from public.hub_subscriptions
  where account_id = v_account.id
    and product_family = 'HUB_CORE'
    and status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
  order by created_at desc, id desc
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

  select * into v_plan
  from public.hub_plans
  where code = 'DISCOVERY'
    and product_family = 'HUB_CORE'
    and is_active = true;
  if not found then
    raise exception 'discovery_plan_unavailable' using errcode = 'P0001';
  end if;

  insert into public.hub_subscriptions (
    account_id, plan_id, status, trial_starts_at, trial_ends_at,
    current_period_starts_at, current_period_ends_at,
    product_family, metadata
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

  update public.hub_accounts
  set trial_claimed_at = coalesce(trial_claimed_at, pg_catalog.now()),
      audience = v_audience,
      account_type = case when v_audience = 'INSTITUTION'
        then 'ORGANIZATION'
        else account_type
      end,
      updated_at = pg_catalog.now()
  where id = v_account.id
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
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from public.profiles as profile
    where profile.id = v_user_id
      and profile.tenant_id = 'wolfie-direct'
  ) then
    return null;
  end if;

  select membership.account_id into v_account_id
  from public.hub_memberships as membership
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
    and (p_account_id is null or membership.account_id = p_account_id)
  order by
    (membership.membership_role = 'OWNER') desc,
    membership.created_at,
    membership.id
  limit 1;
  if v_account_id is null then
    return null;
  end if;

  select pg_catalog.jsonb_build_object(
    'account', pg_catalog.to_jsonb(account),
    'membership', pg_catalog.to_jsonb(membership),
    'subscription', pg_catalog.to_jsonb(subscription),
    'plan', pg_catalog.to_jsonb(plan),
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
    'settings', coalesce((
      select pg_catalog.to_jsonb(settings)
      from public.hub_settings as settings
      where settings.settings_key = 'default'
    ), '{}'::jsonb)
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
    order by (
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
    ) desc,
    candidate.created_at desc,
    candidate.id desc
    limit 1
  ) as subscription on true
  left join public.hub_plans as plan
    on plan.id = subscription.plan_id
   and plan.product_family = 'HUB_CORE'
  where account.id = v_account_id;

  return v_result;
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
  if v_feature_key is null
     or pg_catalog.char_length(v_feature_key) < 3
     or p_units is null
     or p_units < 0
     or p_units > 1000 then
    raise exception 'invalid_usage_request' using errcode = '22023';
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
  where membership.user_id = v_user_id
    and membership.status = 'ACTIVE'
    and (p_account_id is null or membership.account_id = p_account_id)
  order by
    (membership.membership_role = 'OWNER') desc,
    membership.created_at,
    membership.id
  limit 1;
  if v_account_id is null then
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
  for update;
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
    select event.id into v_existing_event
    from public.hub_usage_events as event
    where event.subscription_id = v_subscription.id
      and event.feature_key = v_feature_key
      and event.request_key = p_request_key;
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

  select counter.used_units into v_used
  from public.hub_usage_counters as counter
  where counter.subscription_id = v_subscription.id
    and counter.feature_key = v_feature_key
    and counter.period_start = v_period_start
  for update;
  v_used := coalesce(v_used, 0);

  if v_limit is not null and v_used + p_units > v_limit then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'USAGE_LIMIT_REACHED',
      'subscriptionId', v_subscription.id,
      'productFamily', 'HUB_CORE',
      'used', v_used,
      'limit', v_limit,
      'remaining', greatest(v_limit - v_used, 0),
      'periodEndsAt', v_period_end
    );
  end if;

  if p_units > 0 then
    insert into public.hub_usage_counters (
      account_id, subscription_id, feature_key, period_start, period_end,
      used_units
    ) values (
      v_account_id, v_subscription.id, v_feature_key, v_period_start,
      v_period_end, p_units
    )
    on conflict (subscription_id, feature_key, period_start) do update
    set used_units = public.hub_usage_counters.used_units + excluded.used_units,
        updated_at = pg_catalog.now()
    returning used_units into v_used;

    insert into public.hub_usage_events (
      account_id, subscription_id, user_id, feature_key, units, request_key,
      metadata
    ) values (
      v_account_id, v_subscription.id, v_user_id, v_feature_key, p_units,
      p_request_key, coalesce(p_metadata, '{}'::jsonb)
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'idempotent', false,
    'accountId', v_account_id,
    'subscriptionId', v_subscription.id,
    'productFamily', 'HUB_CORE',
    'used', v_used,
    'limit', v_limit,
    'remaining', case when v_limit is null then null
      else greatest(v_limit - v_used, 0)
    end,
    'periodEndsAt', v_period_end
  );
end;
$function$;

create or replace function public.hub_activate_paid_checkout(
  p_checkout_id uuid,
  p_payment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_checkout public.hub_checkout_sessions%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_plan public.hub_plans%rowtype;
  v_payment public.hub_subscription_payments%rowtype;
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_period_interval interval;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_student_plan_id uuid;
  v_student_plan_name text;
  v_is_renewal boolean := false;
begin
  if p_checkout_id is null
     or v_payment_id is null
     or pg_catalog.char_length(v_payment_id) > 200 then
    raise exception 'invalid_hub_payment' using errcode = '22023';
  end if;

  -- The provider can emit distinct event names for one payment. Serialize by
  -- payment id before consulting the ledger so only one transaction can buy a
  -- period.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hub-payment:ASAAS:' || v_payment_id, 0)
  );

  select * into v_checkout
  from public.hub_checkout_sessions
  where id = p_checkout_id
  for update;
  if not found then
    raise exception 'hub_checkout_not_found' using errcode = 'P0002';
  end if;
  if v_checkout.status in ('CANCELLED', 'REVERSED') then
    raise exception 'hub_checkout_cancelled' using errcode = 'P0001';
  end if;

  select * into v_payment
  from public.hub_subscription_payments
  where provider = 'ASAAS'
    and provider_payment_id = v_payment_id
  for update;
  if found and v_payment.checkout_id <> v_checkout.id then
    raise exception 'hub_checkout_payment_mismatch' using errcode = '42501';
  end if;
  if found and v_payment.status = 'REVERSED' then
    return pg_catalog.jsonb_build_object(
      'accountId', v_checkout.account_id,
      'subscriptionId', v_payment.subscription_id,
      'status', 'REVERSED',
      'idempotent', true,
      'applied', false
    );
  end if;
  if found and v_payment.status = 'APPLIED' then
    if v_payment.subscription_id is not null then
      select * into v_subscription
      from public.hub_subscriptions
      where id = v_payment.subscription_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'accountId', v_checkout.account_id,
      'subscriptionId', v_payment.subscription_id,
      'status', coalesce(v_subscription.status, 'ACTIVE'),
      'idempotent', true,
      'applied', true
    );
  end if;

  select * into v_plan
  from public.hub_plans
  where id = v_checkout.plan_id;
  if not found then
    raise exception 'hub_plan_required' using errcode = '55000';
  end if;
  if v_plan.product_family is distinct from v_checkout.product_family then
    raise exception 'hub_checkout_product_mismatch' using errcode = '23514';
  end if;
  if not v_plan.is_active
     and v_checkout.status in ('CREATED', 'PENDING') then
    raise exception 'active_hub_plan_required' using errcode = '55000';
  end if;
  if v_checkout.product_family = 'WOLFIE_STANDALONE'
     and v_checkout.billing_cycle <> 'MONTHLY' then
    raise exception 'wolfie_monthly_billing_required' using errcode = '23514';
  end if;

  -- Resolve the subscription before deciding whether this is an initial
  -- settlement or a recurring payment. The provider subscription id is the
  -- stable link; checkout payment id intentionally remains the first payment.
  if v_payment.subscription_id is not null then
    select * into v_subscription
    from public.hub_subscriptions
    where id = v_payment.subscription_id
      and account_id = v_checkout.account_id
      and product_family = v_checkout.product_family
    for update;
  else
    select * into v_subscription
    from public.hub_subscriptions as subscription
    where subscription.account_id = v_checkout.account_id
      and subscription.product_family = v_checkout.product_family
      and subscription.provider = 'ASAAS'
      and (
        (
          v_checkout.asaas_subscription_id is not null
          and subscription.provider_subscription_id =
            v_checkout.asaas_subscription_id
        )
        or subscription.metadata ->> 'checkoutId' = v_checkout.id::text
      )
    order by
      (subscription.provider_subscription_id =
        v_checkout.asaas_subscription_id) desc,
      subscription.created_at desc,
      subscription.id desc
    limit 1
    for update;
  end if;

  if v_subscription.id is null
     and v_checkout.asaas_payment_id is not null
     and v_checkout.asaas_payment_id is distinct from v_payment_id then
    raise exception 'hub_checkout_payment_mismatch' using errcode = '42501';
  end if;

  -- Compatibility for a payment applied before the ledger migration. The
  -- original checkout payment is recorded, never charged as a renewal.
  if v_checkout.status = 'PAID'
     and v_checkout.asaas_payment_id = v_payment_id
     and v_payment.id is null
     and v_subscription.id is not null then
    insert into public.hub_subscription_payments (
      provider, provider_payment_id, checkout_id, subscription_id,
      account_id, product_family, status, period_starts_at, period_ends_at,
      applied_at, metadata
    ) values (
      'ASAAS', v_payment_id, v_checkout.id, v_subscription.id,
      v_checkout.account_id, v_checkout.product_family, 'APPLIED',
      v_subscription.current_period_starts_at,
      v_subscription.current_period_ends_at,
      pg_catalog.now(),
      '{"source":"legacy_paid_checkout"}'::jsonb
    );
    return pg_catalog.jsonb_build_object(
      'accountId', v_checkout.account_id,
      'subscriptionId', v_subscription.id,
      'status', v_subscription.status,
      'idempotent', true,
      'applied', true
    );
  end if;

  v_period_interval := case
    when v_checkout.billing_cycle = 'YEARLY' then interval '1 year'
    else interval '1 month'
  end;
  v_is_renewal := v_subscription.id is not null
    and v_checkout.status in ('PAID', 'OVERDUE');
  v_period_start := case
    when v_is_renewal then greatest(
      coalesce(v_subscription.current_period_ends_at, pg_catalog.now()),
      pg_catalog.now()
    )
    else pg_catalog.now()
  end;
  v_period_end := v_period_start + v_period_interval;

  if v_subscription.id is not null then
    update public.hub_subscriptions
    set status = 'EXPIRED',
        current_period_ends_at = least(
          coalesce(current_period_ends_at, pg_catalog.now()),
          pg_catalog.now()
        ),
        updated_at = pg_catalog.now()
    where account_id = v_checkout.account_id
      and product_family = v_checkout.product_family
      and id <> v_subscription.id
      and status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE');

    update public.hub_subscriptions
    set status = 'ACTIVE',
        plan_id = v_checkout.plan_id,
        billing_cycle = v_checkout.billing_cycle,
        product_family = v_checkout.product_family,
        provider_payment_id = v_payment_id,
        current_period_starts_at = v_period_start,
        current_period_ends_at = v_period_end,
        cancelled_at = null,
        updated_at = pg_catalog.now()
    where id = v_subscription.id
    returning * into v_subscription;
  else
    update public.hub_subscriptions
    set status = 'EXPIRED',
        current_period_ends_at = least(
          coalesce(current_period_ends_at, pg_catalog.now()),
          pg_catalog.now()
        ),
        updated_at = pg_catalog.now()
    where account_id = v_checkout.account_id
      and product_family = v_checkout.product_family
      and status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE');

    insert into public.hub_subscriptions (
      account_id, plan_id, status, billing_cycle,
      current_period_starts_at, current_period_ends_at,
      provider, provider_subscription_id, provider_payment_id,
      product_family, metadata
    ) values (
      v_checkout.account_id, v_checkout.plan_id, 'ACTIVE', v_checkout.billing_cycle,
      v_period_start, v_period_end,
      'ASAAS', v_checkout.asaas_subscription_id, v_payment_id,
      v_checkout.product_family,
      pg_catalog.jsonb_build_object('checkoutId', v_checkout.id)
    ) returning * into v_subscription;
  end if;

  if v_payment.id is null then
    insert into public.hub_subscription_payments (
      provider, provider_payment_id, checkout_id, subscription_id,
      account_id, product_family, status, period_starts_at, period_ends_at,
      applied_at, metadata
    ) values (
      'ASAAS', v_payment_id, v_checkout.id, v_subscription.id,
      v_checkout.account_id, v_checkout.product_family, 'APPLIED',
      v_period_start, v_period_end, pg_catalog.now(),
      pg_catalog.jsonb_build_object(
        'billingCycle', v_checkout.billing_cycle,
        'renewal', v_is_renewal
      )
    );
  else
    update public.hub_subscription_payments
    set subscription_id = v_subscription.id,
        status = 'APPLIED',
        period_starts_at = v_period_start,
        period_ends_at = v_period_end,
        applied_at = coalesce(applied_at, pg_catalog.now()),
        reversed_at = null,
        metadata = metadata || pg_catalog.jsonb_build_object(
          'billingCycle', v_checkout.billing_cycle,
          'renewal', v_is_renewal
        ),
        updated_at = pg_catalog.now()
    where id = v_payment.id
      and status = 'OVERDUE';
  end if;

  update public.hub_checkout_sessions
  set status = 'PAID',
      -- Keep the first payment on the checkout. The latest recurring payment
      -- lives on hub_subscriptions and every payment lives in the ledger.
      asaas_payment_id = coalesce(asaas_payment_id, v_payment_id),
      updated_at = pg_catalog.now()
  where id = v_checkout.id;

  if v_checkout.product_family = 'WOLFIE_STANDALONE' then
    v_student_plan_name := nullif(v_plan.metadata ->> 'student_plan_name', '');
    select id into v_student_plan_id
    from public.student_pricing_plans
    where tenant_id = 'wolfie-direct'
      and name = v_student_plan_name
      and active = true
    order by id
    limit 1;
    if v_student_plan_id is null then
      raise exception 'wolfie_student_plan_missing' using errcode = '55000';
    end if;
    if not exists (
      select 1
      from public.tenant_memberships
      where user_id = v_checkout.requested_by
        and tenant_id = 'wolfie-direct'
        and role = 'STUDENT'
        and status = 'ACTIVE'
    ) then
      raise exception 'wolfie_account_not_prepared' using errcode = '55000';
    end if;

    update public.tenant_memberships
    set student_plan_id = v_student_plan_id,
        updated_at = pg_catalog.now()
    where user_id = v_checkout.requested_by
      and tenant_id = 'wolfie-direct'
      and role = 'STUDENT'
      and status = 'ACTIVE';

    perform pg_catalog.set_config('app.enrollment_claim', '1', true);
    update public.profiles
    set fidelity_plan = v_student_plan_name,
        status_financial = 'ACTIVE'
    where id = v_checkout.requested_by
      and tenant_id = 'wolfie-direct'
      and role = 'STUDENT';
  end if;

  insert into public.hub_conversion_events(
    account_id, user_id, event_name, source, metadata
  ) values (
    v_checkout.account_id,
    v_checkout.requested_by,
    case
      when v_checkout.product_family = 'WOLFIE_STANDALONE'
           and v_is_renewal then 'wolfie_subscription_renewed'
      when v_checkout.product_family = 'WOLFIE_STANDALONE'
        then 'wolfie_subscription_paid'
      when v_is_renewal then 'hub_subscription_renewed'
      else 'hub_subscription_paid'
    end,
    'asaas_webhook',
    pg_catalog.jsonb_build_object(
      'checkoutId', v_checkout.id,
      'planId', v_checkout.plan_id,
      'providerPaymentId', v_payment_id,
      'renewal', v_is_renewal
    )
  );

  return pg_catalog.jsonb_build_object(
    'accountId', v_checkout.account_id,
    'subscriptionId', v_subscription.id,
    'status', v_subscription.status,
    'idempotent', false,
    'renewal', v_is_renewal,
    'periodStartsAt', v_period_start,
    'periodEndsAt', v_period_end
  );
end;
$function$;

create or replace function public.hub_reverse_paid_checkout(
  p_checkout_id uuid,
  p_payment_id text,
  p_event_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_checkout public.hub_checkout_sessions%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_payment public.hub_subscription_payments%rowtype;
  v_pending_plan_id uuid;
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_event_name text := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(p_event_name), ''), 'UNKNOWN'),
    100
  );
begin
  if p_checkout_id is null
     or v_payment_id is null
     or pg_catalog.char_length(v_payment_id) > 200 then
    raise exception 'invalid_hub_payment_reversal' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hub-payment:ASAAS:' || v_payment_id, 0)
  );

  select * into v_checkout
  from public.hub_checkout_sessions
  where id = p_checkout_id
  for update;
  if not found then
    raise exception 'hub_checkout_not_found' using errcode = 'P0002';
  end if;

  select * into v_payment
  from public.hub_subscription_payments
  where provider = 'ASAAS'
    and provider_payment_id = v_payment_id
  for update;
  if found and v_payment.checkout_id <> v_checkout.id then
    raise exception 'hub_checkout_payment_mismatch' using errcode = '42501';
  end if;
  if v_checkout.status = 'REVERSED' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'subscriptionId', v_payment.subscription_id
    );
  end if;
  if v_payment.id is not null and v_payment.status = 'REVERSED' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'subscriptionId', v_payment.subscription_id
    );
  end if;

  if v_payment.subscription_id is not null then
    select * into v_subscription
    from public.hub_subscriptions
    where id = v_payment.subscription_id
      and account_id = v_checkout.account_id
      and product_family = v_checkout.product_family
    for update;
  else
    select * into v_subscription
    from public.hub_subscriptions as subscription
    where subscription.account_id = v_checkout.account_id
      and subscription.product_family = v_checkout.product_family
      and subscription.provider = 'ASAAS'
      and (
        subscription.provider_payment_id = v_payment_id
        or (
          v_checkout.asaas_subscription_id is not null
          and subscription.provider_subscription_id =
            v_checkout.asaas_subscription_id
        )
        or subscription.metadata ->> 'checkoutId' = v_checkout.id::text
      )
    order by
      (subscription.provider_payment_id = v_payment_id) desc,
      subscription.created_at desc,
      subscription.id desc
    limit 1
    for update;
  end if;

  -- Reversals may reference the original checkout payment or the latest
  -- recurring payment. A ledger row is also authoritative for older applied
  -- payments. Anything else is rejected instead of revoking a random account.
  if v_payment.id is null
     and v_checkout.asaas_payment_id is distinct from v_payment_id
     and v_subscription.provider_payment_id is distinct from v_payment_id then
    raise exception 'hub_checkout_payment_mismatch' using errcode = '42501';
  end if;

  update public.hub_checkout_sessions
  set status = 'REVERSED',
      asaas_payment_id = coalesce(asaas_payment_id, v_payment_id),
      metadata = metadata || pg_catalog.jsonb_build_object(
        'reversalEvent', v_event_name,
        'reversedAt', pg_catalog.now(),
        'reversedPaymentId', v_payment_id
      ),
      updated_at = pg_catalog.now()
  where id = v_checkout.id;

  if v_subscription.id is not null then
    update public.hub_subscriptions
    set status = 'CANCELLED',
        cancelled_at = coalesce(cancelled_at, pg_catalog.now()),
        current_period_ends_at = least(
          coalesce(current_period_ends_at, pg_catalog.now()),
          pg_catalog.now()
        ),
        metadata = metadata || pg_catalog.jsonb_build_object(
          'reversalEvent', v_event_name,
          'checkoutId', v_checkout.id,
          'reversedPaymentId', v_payment_id
        ),
        updated_at = pg_catalog.now()
    where id = v_subscription.id
    returning * into v_subscription;
  end if;

  if v_payment.id is null then
    insert into public.hub_subscription_payments (
      provider, provider_payment_id, checkout_id, subscription_id,
      account_id, product_family, status, period_starts_at, period_ends_at,
      reversed_at, metadata
    ) values (
      'ASAAS', v_payment_id, v_checkout.id, v_subscription.id,
      v_checkout.account_id, v_checkout.product_family, 'REVERSED',
      v_subscription.current_period_starts_at,
      v_subscription.current_period_ends_at,
      pg_catalog.now(),
      pg_catalog.jsonb_build_object('event', v_event_name)
    );
  else
    update public.hub_subscription_payments
    set subscription_id = coalesce(subscription_id, v_subscription.id),
        status = 'REVERSED',
        reversed_at = coalesce(reversed_at, pg_catalog.now()),
        metadata = metadata || pg_catalog.jsonb_build_object(
          'event', v_event_name
        ),
        updated_at = pg_catalog.now()
    where id = v_payment.id;
  end if;

  if v_checkout.product_family = 'WOLFIE_STANDALONE' then
    select id into v_pending_plan_id
    from public.student_pricing_plans
    where tenant_id = 'wolfie-direct' and name = 'Wolfie Pendente'
    order by id
    limit 1;

    update public.tenant_memberships
    set student_plan_id = v_pending_plan_id,
        updated_at = pg_catalog.now()
    where user_id = v_checkout.requested_by
      and tenant_id = 'wolfie-direct'
      and role = 'STUDENT';

    perform pg_catalog.set_config('app.enrollment_claim', '1', true);
    update public.profiles
    set fidelity_plan = 'Wolfie Pendente',
        status_financial = 'SUSPENDED'
    where id = v_checkout.requested_by
      and tenant_id = 'wolfie-direct';
  end if;

  insert into public.hub_conversion_events(
    account_id, user_id, event_name, source, metadata
  ) values (
    v_checkout.account_id,
    v_checkout.requested_by,
    case when v_checkout.product_family = 'WOLFIE_STANDALONE'
      then 'wolfie_subscription_reversed'
      else 'hub_subscription_reversed'
    end,
    'asaas_webhook',
    pg_catalog.jsonb_build_object(
      'checkoutId', v_checkout.id,
      'paymentId', v_payment_id,
      'event', v_event_name
    )
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'subscriptionId', v_subscription.id
  );
end;
$function$;

create or replace function public.hub_mark_checkout_overdue(
  p_checkout_id uuid,
  p_payment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_checkout public.hub_checkout_sessions%rowtype;
  v_subscription public.hub_subscriptions%rowtype;
  v_payment public.hub_subscription_payments%rowtype;
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_new_event boolean := false;
begin
  if p_checkout_id is null
     or v_payment_id is null
     or pg_catalog.char_length(v_payment_id) > 200 then
    raise exception 'invalid_hub_overdue_payment' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hub-payment:ASAAS:' || v_payment_id, 0)
  );

  select * into v_checkout
  from public.hub_checkout_sessions
  where id = p_checkout_id
  for update;
  if not found then
    raise exception 'hub_checkout_not_found' using errcode = 'P0002';
  end if;
  if v_checkout.status in ('CANCELLED', 'REVERSED') then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'ignored', true,
      'status', v_checkout.status
    );
  end if;

  select * into v_payment
  from public.hub_subscription_payments
  where provider = 'ASAAS'
    and provider_payment_id = v_payment_id
  for update;
  if found and v_payment.checkout_id <> v_checkout.id then
    raise exception 'hub_checkout_payment_mismatch' using errcode = '42501';
  end if;
  if found and v_payment.status in ('APPLIED', 'REVERSED') then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'ignored', true,
      'paymentStatus', v_payment.status,
      'subscriptionId', v_payment.subscription_id
    );
  end if;

  if v_payment.subscription_id is not null then
    select * into v_subscription
    from public.hub_subscriptions
    where id = v_payment.subscription_id
      and account_id = v_checkout.account_id
      and product_family = v_checkout.product_family
    for update;
  else
    select * into v_subscription
    from public.hub_subscriptions as subscription
    where subscription.account_id = v_checkout.account_id
      and subscription.product_family = v_checkout.product_family
      and subscription.provider = 'ASAAS'
      and (
        (
          v_checkout.asaas_subscription_id is not null
          and subscription.provider_subscription_id =
            v_checkout.asaas_subscription_id
        )
        or subscription.metadata ->> 'checkoutId' = v_checkout.id::text
      )
    order by
      (subscription.provider_subscription_id =
        v_checkout.asaas_subscription_id) desc,
      subscription.created_at desc,
      subscription.id desc
    limit 1
    for update;
  end if;

  -- Before the first settlement, the provider payment must be the checkout's
  -- own payment. Once a provider subscription exists, a different payment id
  -- is a normal recurring installment and is linked through that subscription.
  if v_subscription.id is null
     and v_checkout.asaas_payment_id is distinct from v_payment_id then
    raise exception 'hub_checkout_payment_mismatch' using errcode = '42501';
  end if;

  if v_payment.id is null then
    insert into public.hub_subscription_payments (
      provider, provider_payment_id, checkout_id, subscription_id,
      account_id, product_family, status, metadata
    ) values (
      'ASAAS', v_payment_id, v_checkout.id, v_subscription.id,
      v_checkout.account_id, v_checkout.product_family, 'OVERDUE',
      '{"source":"asaas_webhook"}'::jsonb
    )
    returning * into v_payment;
    v_new_event := true;
  end if;

  update public.hub_checkout_sessions
  set status = 'OVERDUE',
      asaas_payment_id = coalesce(asaas_payment_id, v_payment_id),
      metadata = metadata || pg_catalog.jsonb_build_object(
        'overduePaymentId', v_payment_id,
        'overdueAt', pg_catalog.now()
      ),
      updated_at = pg_catalog.now()
  where id = v_checkout.id;

  if v_subscription.id is not null
     and v_subscription.status in (
       'TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE'
     ) then
    update public.hub_subscriptions
    set status = 'PAST_DUE',
        metadata = metadata || pg_catalog.jsonb_build_object(
          'overduePaymentId', v_payment_id,
          'overdueAt', pg_catalog.now()
        ),
        updated_at = pg_catalog.now()
    where id = v_subscription.id
    returning * into v_subscription;
  end if;

  if v_checkout.product_family = 'WOLFIE_STANDALONE'
     and v_subscription.id is not null then
    perform pg_catalog.set_config('app.enrollment_claim', '1', true);
    update public.profiles
    set status_financial = 'SUSPENDED'
    where id = v_checkout.requested_by
      and tenant_id = 'wolfie-direct'
      and role = 'STUDENT';
  end if;

  if v_new_event then
    insert into public.hub_conversion_events(
      account_id, user_id, event_name, source, metadata
    ) values (
      v_checkout.account_id,
      v_checkout.requested_by,
      case when v_checkout.product_family = 'WOLFIE_STANDALONE'
        then 'wolfie_subscription_overdue'
        else 'hub_subscription_overdue'
      end,
      'asaas_webhook',
      pg_catalog.jsonb_build_object(
        'checkoutId', v_checkout.id,
        'paymentId', v_payment_id,
        'subscriptionId', v_subscription.id
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'idempotent', not v_new_event,
    'checkoutId', v_checkout.id,
    'subscriptionId', v_subscription.id,
    'status', case when v_subscription.id is null
      then 'OVERDUE'
      else v_subscription.status
    end
  );
end;
$function$;

revoke all on function private.wolfie_prepare_checkout_account_internal(text,text,jsonb)
  from public, anon, authenticated;
grant execute on function private.wolfie_prepare_checkout_account_internal(text,text,jsonb)
  to authenticated;
revoke all on function private.wolfie_access_snapshot(uuid)
  from public, anon, authenticated;
revoke all on function private.hub_claim_trial_internal(text,text)
  from public, anon, authenticated;
grant execute on function private.hub_claim_trial_internal(text,text)
  to authenticated;
revoke all on function private.hub_bootstrap_internal(uuid)
  from public, anon, authenticated;
grant execute on function private.hub_bootstrap_internal(uuid)
  to authenticated;
revoke all on function private.hub_consume_feature_internal(
  text,integer,uuid,uuid,jsonb
) from public, anon, authenticated;
grant execute on function private.hub_consume_feature_internal(
  text,integer,uuid,uuid,jsonb
) to authenticated;

revoke all on function public.wolfie_prepare_checkout_account(text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.wolfie_prepare_checkout_account(text,text,jsonb)
  to authenticated;
revoke all on function public.wolfie_access_for_user(uuid)
  from public, anon, authenticated;
grant execute on function public.wolfie_access_for_user(uuid)
  to authenticated, service_role;
revoke all on function public.my_wolfie_access()
  from public, anon, authenticated;
grant execute on function public.my_wolfie_access()
  to authenticated;
revoke all on function public.hub_activate_paid_checkout(uuid,text)
  from public, anon, authenticated;
grant execute on function public.hub_activate_paid_checkout(uuid,text)
  to service_role;
revoke all on function public.hub_reverse_paid_checkout(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.hub_reverse_paid_checkout(uuid,text,text)
  to service_role;
revoke all on function public.hub_mark_checkout_overdue(uuid,text)
  from public, anon, authenticated;
grant execute on function public.hub_mark_checkout_overdue(uuid,text)
  to service_role;

comment on table public.wolfie_standalone_acceptances is
  'Versioned terms acceptance and bounded quiz context for direct Wolfie buyers.';
comment on table public.hub_payment_event_inbox is
  'Idempotent, retryable inbox for commercial Hub and Wolfie Asaas events.';
comment on table public.hub_subscription_payments is
  'Exactly-once payment ledger for initial and recurring Hub/Wolfie periods.';
comment on function public.my_wolfie_access() is
  'Returns school or paid standalone Wolfie access for the authenticated user.';
comment on function public.hub_mark_checkout_overdue(uuid,text) is
  'Marks one provider payment and its subscription past due without revoking membership.';

commit;
