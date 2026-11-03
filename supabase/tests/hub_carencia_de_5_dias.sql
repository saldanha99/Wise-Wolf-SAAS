-- Carência de 5 dias no atraso do Hub: o helper único decide o acesso pago e
-- os pontos de acesso (Planner, reserva de recurso, bootstrap) obedecem a ele;
-- a renovação paga na carência não ganha dias em dobro. Tudo sintético, tudo
-- desfeito no rollback.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

-- 1) O helper, caso a caso.
select pg_temp.assert_true(
  private.hub_subscription_grants_access('ACTIVE', null, now() + interval '1 day'),
  'ACTIVE dentro do período deve dar acesso'
);
select pg_temp.assert_true(
  private.hub_subscription_grants_access('ACTIVE', null, now() - interval '2 days'),
  'ACTIVE vencido há 2 dias está na carência e deve dar acesso'
);
select pg_temp.assert_true(
  not private.hub_subscription_grants_access('ACTIVE', null, now() - interval '6 days'),
  'ACTIVE vencido há 6 dias saiu da carência'
);
select pg_temp.assert_true(
  private.hub_subscription_grants_access('PAST_DUE', null, now() - interval '2 days'),
  'PAST_DUE dentro da carência deve dar acesso'
);
select pg_temp.assert_true(
  private.hub_subscription_grants_access('PAST_DUE', null, now() + interval '3 days'),
  'PAST_DUE com período ainda vigente deve dar acesso'
);
select pg_temp.assert_true(
  not private.hub_subscription_grants_access('PAST_DUE', null, now() - interval '6 days'),
  'PAST_DUE fora da carência não dá acesso'
);
select pg_temp.assert_true(
  private.hub_subscription_grants_access('TRIALING', now() + interval '1 day', null),
  'trial vigente dá acesso'
);
select pg_temp.assert_true(
  not private.hub_subscription_grants_access('TRIALING', now() - interval '1 hour', now() + interval '1 month'),
  'trial vencido não tem carência'
);
select pg_temp.assert_true(
  not private.hub_subscription_grants_access('EXPIRED', null, now() + interval '1 month')
  and not private.hub_subscription_grants_access('CANCELLED', null, now() + interval '1 month')
  and not private.hub_subscription_grants_access('INCOMPLETE', null, now() + interval '1 month')
  and not private.hub_subscription_grants_access('ACTIVE', null, null)
  and not private.hub_subscription_grants_access(null, null, now() + interval '1 month'),
  'EXPIRED, CANCELLED, INCOMPLETE, período nulo e status nulo nunca dão acesso'
);
select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'private.hub_subscription_grants_access(text,timestamptz,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.hub_subscription_grants_access(text,timestamptz,timestamptz)', 'EXECUTE')
  and exists (
    select 1 from pg_proc
    where oid = 'private.hub_subscription_grants_access(text,timestamptz,timestamptz)'::regprocedure
      and pg_get_userbyid(proowner) = 'postgres'
      and proconfig @> array['search_path=""']::text[]
  ),
  'helper da carência exposto ou sem dono/search_path seguros'
);

-- 2) Cada ponto de acesso pago chama o helper, com dono e grants preservados.
select pg_temp.assert_true(
  (
    select count(*) = 6
      and bool_and(strpos(pg_get_functiondef(p.oid), 'private.hub_subscription_grants_access(') > 0)
      and bool_and(p.prosecdef)
      and bool_and(p.proconfig @> array['search_path=""']::text[])
    from pg_proc p
    where p.oid in (
      'private.hub_reserve_feature_internal(uuid,text,integer,uuid,text,uuid,jsonb)'::regprocedure,
      'private.hub_consume_feature_internal(text,integer,uuid,uuid,jsonb)'::regprocedure,
      'private.hub_bootstrap_internal(uuid)'::regprocedure,
      'private.hub_user_has_educator_planner_access(uuid,uuid)'::regprocedure,
      'private.hub_commit_feature_internal(uuid,uuid,uuid,uuid)'::regprocedure,
      'private.hub_activate_paid_checkout_apply(uuid,text)'::regprocedure
    )
  ),
  'algum ponto de acesso pago do Hub ainda usa a regra copiada'
);
select pg_temp.assert_true(
  pg_get_userbyid((select proowner from pg_proc where oid = 'private.hub_reserve_feature_internal(uuid,text,integer,uuid,text,uuid,jsonb)'::regprocedure)) = 'supabase_admin'
  and pg_get_userbyid((select proowner from pg_proc where oid = 'private.hub_bootstrap_internal(uuid)'::regprocedure)) = 'supabase_admin'
  and pg_get_userbyid((select proowner from pg_proc where oid = 'private.hub_user_has_educator_planner_access(uuid,uuid)'::regprocedure)) = 'postgres'
  and pg_get_userbyid((select proowner from pg_proc where oid = 'private.hub_activate_paid_checkout_apply(uuid,text)'::regprocedure)) = 'postgres'
  and has_function_privilege('authenticated', 'private.hub_bootstrap_internal(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'private.hub_reserve_feature_internal(uuid,text,integer,uuid,text,uuid,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.hub_reserve_feature_internal(uuid,text,integer,uuid,text,uuid,jsonb)', 'EXECUTE'),
  'o remendo mudou dono ou grants das funções de acesso'
);
-- O aluno convidado é outra frente: hub_learner_seats não foi tocada aqui.
select pg_temp.assert_true(
  strpos(pg_get_functiondef('private.hub_learner_seats(uuid)'::regprocedure), 'hub_subscription_grants_access') = 0,
  'hub_learner_seats foi alterada por esta frente'
);

-- 3) Fixtures: educador com plano do Hub que inclui o Educador IA.
update public.hub_settings
   set metadata = coalesce(metadata, '{}'::jsonb) || '{"hubEnabled":true}'::jsonb
 where settings_key = 'default';

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('7d000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'grace-teacher@example.invalid',
        '{"provider":"email","providers":["email"],"test_fixture":true}', '{"full_name":"Grace Teacher","test_fixture":true}', now(), now());

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
   set tenant_id = null, lifecycle_status = 'active', role = 'NON_STUDENT'
 where id = '7d000000-0000-4000-8000-000000000101';
select pg_catalog.set_config('app.enrollment_claim', '', true);

insert into public.hub_plans (id, code, name, description, audience, price_monthly, price_yearly, currency, trial_days, display_order, is_public, is_active, features, metadata, product_family)
values ('7d000000-0000-4000-8000-000000000201', 'HUB_GRACE_FIXTURE', 'Hub Grace Fixture', 'teste', 'ALL', 1, 10, 'BRL', 0, 999, false, true, '[]'::jsonb, '{"test_fixture":true}'::jsonb, 'HUB_CORE');
insert into public.hub_plan_entitlements (plan_id, feature_key, limit_value, reset_period, metadata)
values ('7d000000-0000-4000-8000-000000000201', 'educator_ai.generate', 100, 'MONTH', '{"test_fixture":true}'::jsonb);

insert into public.hub_accounts (id, account_type, audience, name, owner_user_id, status, asaas_customer_id, metadata)
values ('7d000000-0000-4000-8000-000000000301', 'PERSONAL', 'EDUCATOR', 'Grace Studio', '7d000000-0000-4000-8000-000000000101', 'ACTIVE', 'cus_grace_fixture', '{"test_fixture":true}'::jsonb);
insert into public.hub_memberships (account_id, user_id, membership_role, subject_role, status)
values ('7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000101', 'OWNER', 'EDUCATOR', 'ACTIVE');
insert into public.hub_subscriptions (id, account_id, plan_id, status, billing_cycle, current_period_starts_at, current_period_ends_at, provider, provider_subscription_id, product_family, metadata)
values ('7d000000-0000-4000-8000-000000000401', '7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000201', 'ACTIVE', 'MONTHLY', now() - interval '1 month', now() + interval '1 day', 'ASAAS', 'sub_grace_fixture', 'HUB_CORE', '{"test_fixture":true}'::jsonb);

create temporary table grace_results (step text primary key, payload jsonb) on commit drop;
grant all on table grace_results to service_role, authenticated;

-- Muda status/período da mesma assinatura e mede os três pontos de acesso.
create or replace function pg_temp.grace_set(p_status text, p_ends_at timestamptz)
returns void language sql as $$
  update public.hub_subscriptions
     set status = p_status, current_period_ends_at = p_ends_at
   where id = '7d000000-0000-4000-8000-000000000401';
$$;

-- 3a) ACTIVE no prazo.
select pg_temp.grace_set('ACTIVE', now() + interval '1 day');
select pg_temp.assert_true(
  private.hub_user_has_educator_planner_access('7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000101'),
  'Planner: ACTIVE no prazo tem acesso'
);

-- 3b) ACTIVE vencido há 2 dias: Planner, reserva e bootstrap liberam.
select pg_temp.grace_set('ACTIVE', now() - interval '2 days');
select pg_temp.assert_true(
  private.hub_user_has_educator_planner_access('7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000101'),
  'Planner: ACTIVE vencido há 2 dias está na carência'
);
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into grace_results values ('reserve_active_2d', public.hub_reserve_feature(
  '7d000000-0000-4000-8000-000000000101', 'educator_ai.generate', 1,
  '7d000000-0000-4000-8000-000000000901', repeat('a', 64),
  '7d000000-0000-4000-8000-000000000301', '{"source":"pedagogical-content"}'::jsonb
));
insert into grace_results values ('commit_active_2d', public.hub_commit_feature(
  '7d000000-0000-4000-8000-000000000101',
  ((select payload from grace_results where step = 'reserve_active_2d') ->> 'reservationId')::uuid,
  ((select payload from grace_results where step = 'reserve_active_2d') ->> 'leaseToken')::uuid,
  '7d000000-0000-4000-8000-000000000901'
));
reset role;
select pg_temp.assert_true(
  (select (payload ->> 'allowed')::boolean from grace_results where step = 'reserve_active_2d'),
  'reserva de recurso: ACTIVE vencido há 2 dias deveria ser permitida'
);
select pg_temp.assert_true(
  (select payload ->> 'code' is distinct from 'SUBSCRIPTION_REQUIRED' and coalesce((payload ->> 'allowed')::boolean, true)
   from grace_results where step = 'commit_active_2d'),
  'confirmação da reserva: a carência vale também no commit'
);
select pg_catalog.set_config('request.jwt.claims', '{"role":"authenticated","sub":"7d000000-0000-4000-8000-000000000101"}', true);
set local role authenticated;
insert into grace_results values ('bootstrap_active_2d', public.hub_bootstrap('7d000000-0000-4000-8000-000000000301'));
reset role;
select pg_temp.assert_true(
  (select payload -> 'subscription' ->> 'id' from grace_results where step = 'bootstrap_active_2d')
    = '7d000000-0000-4000-8000-000000000401',
  'bootstrap: a assinatura na carência continua sendo a vigente'
);

-- 3c) ACTIVE vencido há 6 dias: nada libera, nada é apagado.
select pg_temp.grace_set('ACTIVE', now() - interval '6 days');
select pg_temp.assert_true(
  not private.hub_user_has_educator_planner_access('7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000101'),
  'Planner: ACTIVE vencido há 6 dias saiu da carência'
);
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into grace_results values ('reserve_active_6d', public.hub_reserve_feature(
  '7d000000-0000-4000-8000-000000000101', 'educator_ai.generate', 1,
  '7d000000-0000-4000-8000-000000000902', repeat('b', 64),
  '7d000000-0000-4000-8000-000000000301', '{"source":"pedagogical-content"}'::jsonb
));
reset role;
select pg_temp.assert_true(
  (select payload ->> 'code' = 'SUBSCRIPTION_REQUIRED' and not (payload ->> 'allowed')::boolean
   from grace_results where step = 'reserve_active_6d'),
  'reserva de recurso: fora da carência exige assinatura'
);
select pg_catalog.set_config('request.jwt.claims', '{"role":"authenticated","sub":"7d000000-0000-4000-8000-000000000101"}', true);
set local role authenticated;
insert into grace_results values ('bootstrap_active_6d', public.hub_bootstrap('7d000000-0000-4000-8000-000000000301'));
reset role;
select pg_temp.assert_true(
  (select payload -> 'subscription' = 'null'::jsonb or payload -> 'subscription' is null
   from grace_results where step = 'bootstrap_active_6d')
  and exists (select 1 from public.hub_subscriptions where id = '7d000000-0000-4000-8000-000000000401'),
  'bootstrap: fora da carência a assinatura não é vigente, mas continua gravada'
);

-- 3d) PAST_DUE dentro e fora da carência.
select pg_temp.grace_set('PAST_DUE', now() - interval '3 days');
select pg_temp.assert_true(
  private.hub_user_has_educator_planner_access('7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000101'),
  'Planner: PAST_DUE dentro da carência tem acesso'
);
select pg_temp.grace_set('PAST_DUE', now() - interval '5 days 1 hour');
select pg_temp.assert_true(
  not private.hub_user_has_educator_planner_access('7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000101'),
  'Planner: PAST_DUE fora da carência não tem acesso'
);

-- 3e) TRIALING vencido, EXPIRED e CANCELLED: sem acesso.
update public.hub_subscriptions
   set status = 'TRIALING', trial_starts_at = now() - interval '7 days', trial_ends_at = now() - interval '1 hour',
       current_period_ends_at = now() + interval '1 month'
 where id = '7d000000-0000-4000-8000-000000000401';
select pg_temp.assert_true(
  not private.hub_user_has_educator_planner_access('7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000101'),
  'Planner: trial vencido não tem carência'
);
select pg_temp.grace_set('EXPIRED', now() + interval '1 month');
select pg_temp.assert_true(
  not private.hub_user_has_educator_planner_access('7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000101'),
  'Planner: EXPIRED não tem acesso'
);
select pg_temp.grace_set('CANCELLED', now() + interval '1 month');
select pg_temp.assert_true(
  not private.hub_user_has_educator_planner_access('7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000101'),
  'Planner: CANCELLED não tem acesso'
);

-- 4) Renovação paga na carência: o período novo começa no fim do anterior
--    (só no Hub; o Wolfie avulso não tem carência de acesso).
select pg_temp.assert_true(
  strpos(
    pg_get_functiondef('private.hub_activate_paid_checkout_apply(uuid,text)'::regprocedure),
    'and v_checkout.product_family = ''HUB_CORE'''
  ) > 0,
  'ancoragem da renovação na carência vazou para o Wolfie avulso'
);
insert into public.hub_checkout_sessions (id, account_id, plan_id, requested_by, billing_cycle, billing_type, amount, status, asaas_subscription_id, asaas_payment_id, metadata, product_family, created_at)
values ('7d000000-0000-4000-8000-000000000501', '7d000000-0000-4000-8000-000000000301', '7d000000-0000-4000-8000-000000000201',
        '7d000000-0000-4000-8000-000000000101', 'MONTHLY', 'PIX', 1, 'OVERDUE', 'sub_grace_fixture', 'pay_grace_first',
        '{"test_fixture":true}'::jsonb, 'HUB_CORE', now() - interval '40 days');
update public.hub_subscriptions
   set status = 'PAST_DUE', trial_starts_at = null, trial_ends_at = null,
       current_period_starts_at = date_trunc('second', now()) - interval '1 month 2 days',
       current_period_ends_at = date_trunc('second', now()) - interval '2 days',
       metadata = '{"test_fixture":true,"checkoutId":"7d000000-0000-4000-8000-000000000501"}'::jsonb
 where id = '7d000000-0000-4000-8000-000000000401';
insert into grace_results
select 'renew_in_grace', private.hub_activate_paid_checkout_apply('7d000000-0000-4000-8000-000000000501', 'pay_grace_renewal_1');
select pg_temp.assert_true(
  (select (payload ->> 'renewal')::boolean
     and (payload ->> 'periodStartsAt')::timestamptz = date_trunc('second', now()) - interval '2 days'
     and (payload ->> 'periodEndsAt')::timestamptz = date_trunc('second', now()) - interval '2 days' + interval '1 month'
   from grace_results where step = 'renew_in_grace'),
  'renovação na carência deu dias a mais: o período deveria começar no fim do anterior'
);
select pg_temp.assert_true(
  (select status = 'ACTIVE' and current_period_ends_at = date_trunc('second', now()) - interval '2 days' + interval '1 month'
   from public.hub_subscriptions where id = '7d000000-0000-4000-8000-000000000401')
  and (select count(*) = 1 from public.hub_subscription_payments where provider_payment_id = 'pay_grace_renewal_1' and status = 'APPLIED'),
  'renovação na carência não ficou registrada uma única vez'
);
-- O mesmo pagamento de novo não compra outro mês.
insert into grace_results
select 'renew_in_grace_replay', private.hub_activate_paid_checkout_apply('7d000000-0000-4000-8000-000000000501', 'pay_grace_renewal_1');
select pg_temp.assert_true(
  (select (payload ->> 'idempotent')::boolean from grace_results where step = 'renew_in_grace_replay')
  and (select current_period_ends_at = date_trunc('second', now()) - interval '2 days' + interval '1 month'
       from public.hub_subscriptions where id = '7d000000-0000-4000-8000-000000000401'),
  'pagamento repetido na carência estendeu o período em dobro'
);

-- 4b) Fora da carência (6 dias), a renovação começa no pagamento.
update public.hub_subscriptions
   set status = 'PAST_DUE',
       current_period_ends_at = date_trunc('second', now()) - interval '6 days'
 where id = '7d000000-0000-4000-8000-000000000401';
update public.hub_checkout_sessions set status = 'OVERDUE' where id = '7d000000-0000-4000-8000-000000000501';
insert into grace_results
select 'renew_after_grace', private.hub_activate_paid_checkout_apply('7d000000-0000-4000-8000-000000000501', 'pay_grace_renewal_2');
select pg_temp.assert_true(
  (select (payload ->> 'renewal')::boolean
     and (payload ->> 'periodStartsAt')::timestamptz >= now() - interval '1 minute'
   from grace_results where step = 'renew_after_grace'),
  'renovação depois da carência deveria começar no pagamento'
);

-- O release roda os testes em savepoints da mesma transação: não deixar
-- claims nem papel para o próximo teste.
select pg_catalog.set_config('request.jwt.claims', '', true);
reset role;

rollback;
