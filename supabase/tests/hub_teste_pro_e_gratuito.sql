-- Fase 1: teste Pro de 7 dias e Gratuito permanente depois (migration 20261123150000). Tudo desfeito.
begin;
create or replace function pg_temp.assert_true(p_ok boolean, p_message text) returns void
language plpgsql as $$ begin if p_ok is not true then raise exception 'assertion failed: %', p_message; end if; end $$;

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('7e000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'teste-fase1-prof@exemplo.invalid', '{"full_name":"Prof Fase 1"}'::jsonb, now(), now());
update public.profiles set lifecycle_status = 'active', status = 'Ativo' where id = '7e000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claims', '{"sub":"7e000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table claim as select private.hub_claim_trial_internal('EDUCATOR', 'Prof Fase 1') as r;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1. O teste é o Pro, por 7 dias.
select pg_temp.assert_true(
  (select p.code = 'PROFESSOR_PRO' and s.status = 'TRIALING'
          and s.trial_ends_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour'
          and s.metadata ->> 'trialPlan' = 'PROFESSOR_PRO'
     from claim c join public.hub_subscriptions s on s.id = (c.r ->> 'subscriptionId')::uuid
     join public.hub_plans p on p.id = s.plan_id), 'teste Pro de 7 dias');

-- 2. Enquanto o teste vale, a rotina não mexe.
select private.expire_hub_trials_internal();
select pg_temp.assert_true(
  (select count(*) = 1 from public.hub_subscriptions s join claim c on s.account_id = (c.r ->> 'accountId')::uuid), 'sem Gratuito durante o teste');

-- 3. Venceu: o Pro expira e entra o Gratuito ativo, sem cobrança.
update public.hub_subscriptions s set trial_ends_at = now() - interval '1 minute'
  from claim c where s.id = (c.r ->> 'subscriptionId')::uuid;
select private.expire_hub_trials_internal();
select pg_temp.assert_true(
  (select s.status = 'EXPIRED' from public.hub_subscriptions s join claim c on s.id = (c.r ->> 'subscriptionId')::uuid), 'Pro expirou');
select pg_temp.assert_true(
  (select count(*) = 1 from public.hub_subscriptions s join claim c on s.account_id = (c.r ->> 'accountId')::uuid
     join public.hub_plans p on p.id = s.plan_id
    where s.status = 'ACTIVE' and p.code = 'DISCOVERY' and s.provider = 'internal'
      and s.current_period_ends_at > now() + interval '50 years'
      and s.metadata ->> 'source' = 'hub_free_after_trial'), 'Gratuito ativo depois do teste');

-- 4. Rodar de novo não duplica; o Gratuito dá acesso à geração (cota do Gratuito).
select private.expire_hub_trials_internal();
select pg_temp.assert_true(
  (select count(*) = 1 from public.hub_subscriptions s join claim c on s.account_id = (c.r ->> 'accountId')::uuid
    where s.status = 'ACTIVE'), 'sem duplicar');
select pg_temp.assert_true(
  (select (public.hub_reserve_feature('7e000000-0000-4000-8000-000000000001', 'educator_ai.generate', 1, gen_random_uuid(),
          repeat('0', 64), (c.r ->> 'accountId')::uuid, '{"source":"pedagogical-content"}'::jsonb) ->> 'allowed')::boolean
     from claim c), 'Gratuito reserva geração');

-- 5. Conta interna (acervo do agente) e conta de aluno não recebem Gratuito.
select pg_temp.assert_true(
  not exists (select 1 from public.hub_subscriptions s join public.hub_accounts a on a.id = s.account_id
               where s.metadata ->> 'source' = 'hub_free_after_trial'
                 and (a.audience <> 'EDUCATOR' or coalesce((a.metadata ->> 'internal')::boolean, false))),
  'só professor, nunca conta interna');

rollback;
