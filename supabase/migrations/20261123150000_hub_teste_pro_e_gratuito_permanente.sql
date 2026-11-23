-- Hub Fase 1 (23/11/2026): teste Pro de 7 dias sem cartão + Gratuito permanente depois.
--
-- Antes: o "teste" era o plano DISCOVERY (Gratuito) em TRIALING por 7 dias e, ao vencer, a conta
-- ficava SEM plano (EXPIRED) — o Gratuito de 5 gerações/mês prometido na venda sumia. Agora:
-- 1. hub_claim_trial_internal dá o PROFESSOR_PRO em TRIALING por 7 dias (sem Pro ativo, o Gratuito);
-- 2. expire_hub_trials_internal, depois de vencer os testes, põe o Gratuito ATIVO (sem cobrança,
--    período até 2099) em toda conta pessoal de professor, ativa, sem plano vivo — inclusive as que
--    já tinham perdido o acesso (3 em 23/11) e quem cancelar um plano pago.
-- A compra de um plano pago já expira as outras assinaturas vivas (hub_activate_paid_checkout_apply).
-- Desfazer: recriar as duas funções a partir do backup da publicação; as assinaturas Gratuito
-- criadas ficam marcadas com metadata.source = 'hub_free_after_trial'.

create or replace function private.hub_claim_trial_internal(p_audience text default 'EDUCATOR'::text, p_account_name text default null::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- Fase 1 (23/11/2026): o teste do professor é o PRO por 7 dias, sem cartão. Sem Pro ativo,
  -- cai no Gratuito como antes. Depois do teste, expire_hub_trials_internal põe o Gratuito.
  select plan.* into v_plan
  from public.hub_plans as plan
  where plan.code = 'PROFESSOR_PRO'
    and plan.product_family = 'HUB_CORE'
    and plan.is_active = true;
  if not found then
    select plan.* into v_plan
    from public.hub_plans as plan
    where plan.code = 'DISCOVERY'
      and plan.product_family = 'HUB_CORE'
      and plan.is_active = true;
  end if;
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
    pg_catalog.now() + interval '7 days',
    pg_catalog.now(),
    pg_catalog.now() + interval '7 days',
    'HUB_CORE',
    pg_catalog.jsonb_build_object(
      'source', 'hub_onboarding',
      'product_family', 'HUB_CORE',
      'trialPlan', v_plan.code
    )
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

create or replace function private.expire_hub_trials_internal()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_expired integer := 0;
  v_free_plan_id uuid;
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

  -- Gratuito permanente para o professor sem plano vivo (fail-safe: sem catálogo pronto, espera).
  select plan.id into v_free_plan_id
  from public.hub_plans as plan
  where plan.code = 'DISCOVERY'
    and plan.product_family = 'HUB_CORE'
    and plan.is_active = true;
  if v_free_plan_id is not null and private.hub_catalog_is_ready() and private.hub_is_enabled() then
    insert into public.hub_subscriptions (
      account_id, plan_id, status, billing_cycle,
      current_period_starts_at, current_period_ends_at,
      provider, product_family, metadata
    )
    select account.id, v_free_plan_id, 'ACTIVE', 'MONTHLY',
           pg_catalog.now(), '2099-12-31 00:00:00+00'::timestamptz,
           'internal', 'HUB_CORE',
           pg_catalog.jsonb_build_object('source', 'hub_free_after_trial', 'grantedAt', pg_catalog.now())
    from public.hub_accounts as account
    join public.profiles as owner on owner.id = account.owner_user_id
    where account.account_type = 'PERSONAL'
      and account.audience = 'EDUCATOR'
      and account.status = 'ACTIVE'
      and pg_catalog.lower(pg_catalog.btrim(owner.lifecycle_status)) = 'active'
      and coalesce(owner.tenant_id, '') <> 'wolfie-direct'
      and not coalesce((account.metadata ->> 'internal')::boolean, false)
      and exists (
        select 1 from public.hub_subscriptions as history
        where history.account_id = account.id and history.product_family = 'HUB_CORE'
      )
      and not exists (
        select 1 from public.hub_subscriptions as live
        where live.account_id = account.id
          and live.product_family = 'HUB_CORE'
          and live.status in ('TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE')
      );
  end if;

  return v_expired;
end;
$function$;
