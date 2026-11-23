-- Agente de conteúdo gera fichas na conta do acervo do Hub (migration 20261123130000).
-- Tudo sintético e desfeito no rollback: usuário técnico, credencial com hash conhecido,
-- conta do Hub, assinatura do plano interno.
begin;

create or replace function pg_temp.assert_true(p_ok boolean, p_message text) returns void
language plpgsql as $$ begin if p_ok is not true then raise exception 'assertion failed: %', p_message; end if; end $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Usuários sintéticos: a conta técnica da escola (credencial) e a do Hub (acervo).
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('7d000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'teste-bot-escola@exemplo.invalid', '{}'::jsonb, now(), now()),
       ('7d000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'teste-bot-acervo@exemplo.invalid', '{}'::jsonb, now(), now());
update public.profiles set role = 'TEACHER', tenant_id = 'school-wise-wolf', is_test_account = true,
       test_fixture_key = 'conteudo-bot-fichas-teste', lifecycle_status = 'offboarded'
 where id = '7d000000-0000-4000-8000-000000000001';
update public.profiles set role = 'NON_STUDENT', tenant_id = null, lifecycle_status = 'active', status = 'Ativo',
       is_test_account = false
 where id = '7d000000-0000-4000-8000-000000000002';
insert into private.content_bot_credentials (user_id, tenant_id, label, token_sha256)
values ('7d000000-0000-4000-8000-000000000001', 'school-wise-wolf', 'teste', repeat('a', 64));

insert into public.hub_accounts (id, account_type, audience, name, owner_user_id, status, metadata)
values ('7d000000-0000-4000-8000-000000000003', 'PERSONAL', 'EDUCATOR', 'Acervo teste',
        '7d000000-0000-4000-8000-000000000002', 'ACTIVE', '{"internal": true}'::jsonb);
insert into public.hub_memberships (account_id, user_id, membership_role, status, subject_role)
values ('7d000000-0000-4000-8000-000000000003', '7d000000-0000-4000-8000-000000000002', 'OWNER', 'ACTIVE', 'EDUCATOR')
on conflict (account_id, user_id) do update set membership_role = 'OWNER', status = 'ACTIVE', subject_role = 'EDUCATOR';
insert into public.hub_subscriptions (account_id, plan_id, status, billing_cycle, current_period_starts_at,
                                      current_period_ends_at, provider, metadata)
select '7d000000-0000-4000-8000-000000000003', plan.id, 'ACTIVE', 'MONTHLY', now(), '2099-12-31', 'internal', '{}'
  from public.hub_plans plan where plan.code = 'CONTENT_BOT_INTERNAL';

-- 1. Plano interno: fora da vitrine, cota de 350 gerações por mês.
select pg_temp.assert_true(
  (select not is_public and not is_active and coalesce(price_monthly, 0) = 0
     from public.hub_plans where code = 'CONTENT_BOT_INTERNAL'), 'plano interno fora da venda');
select pg_temp.assert_true(
  (select e.limit_value = 350 and e.reset_period = 'MONTH'
     from public.hub_plan_entitlements e join public.hub_plans p on p.id = e.plan_id
    where p.code = 'CONTENT_BOT_INTERNAL' and e.feature_key = 'educator_ai.generate'), 'cota 350/mês');

-- 2. Sem vínculo, o token não abre o Hub.
select pg_temp.assert_true(
  not exists (select 1 from public.content_bot_hub_identity(repeat('a', 64))), 'sem vínculo nega');

insert into private.content_bot_hub_identities (credential_user_id, hub_user_id, hub_account_id)
values ('7d000000-0000-4000-8000-000000000001', '7d000000-0000-4000-8000-000000000002',
        '7d000000-0000-4000-8000-000000000003');

-- 3. Com vínculo: devolve a conta do acervo; token errado não.
select pg_temp.assert_true(
  (select hub_user_id = '7d000000-0000-4000-8000-000000000002' and hub_account_id = '7d000000-0000-4000-8000-000000000003'
     from public.content_bot_hub_identity(repeat('a', 64))), 'token resolve a conta do acervo');
select pg_temp.assert_true(
  not exists (select 1 from public.content_bot_hub_identity(repeat('b', 64))), 'token errado nega');

-- 4. A reserva de geração passa pela cota do plano interno (o perfil do acervo é ativo e não de teste).
select pg_temp.assert_true(
  (select (r ->> 'allowed')::boolean and (r ->> 'accountId') = '7d000000-0000-4000-8000-000000000003'
     from public.hub_reserve_feature('7d000000-0000-4000-8000-000000000002', 'educator_ai.generate', 1,
          gen_random_uuid(), repeat('0', 64), '7d000000-0000-4000-8000-000000000003',
          '{"source":"pedagogical-content"}'::jsonb) as r), 'reserva liberada pela cota interna');

-- 5. A conta técnica da ESCOLA continua sem Hub (a trava das contas de teste não muda).
select pg_temp.assert_true(
  (select not (r ->> 'allowed')::boolean
     from public.hub_reserve_feature('7d000000-0000-4000-8000-000000000001', 'educator_ai.generate', 1,
          gen_random_uuid(), repeat('0', 64), '7d000000-0000-4000-8000-000000000003',
          '{"source":"pedagogical-content"}'::jsonb) as r), 'conta da escola não reserva no acervo');

-- 6. Acervo marcado como teste, credencial revogada ou conta suspensa: nega.
update public.profiles set is_test_account = true, test_fixture_key = 'conteudo-bot-acervo-teste'
 where id = '7d000000-0000-4000-8000-000000000002';
select pg_temp.assert_true(
  not exists (select 1 from public.content_bot_hub_identity(repeat('a', 64))), 'acervo de teste nega');
update public.profiles set is_test_account = false, test_fixture_key = null
 where id = '7d000000-0000-4000-8000-000000000002';
update public.profiles set lifecycle_status = 'offboarded' where id = '7d000000-0000-4000-8000-000000000002';
select pg_temp.assert_true(
  not exists (select 1 from public.content_bot_hub_identity(repeat('a', 64))), 'acervo inativo nega');
update public.profiles set lifecycle_status = 'active' where id = '7d000000-0000-4000-8000-000000000002';
update private.content_bot_credentials set revoked_at = now() where token_sha256 = repeat('a', 64);
select pg_temp.assert_true(
  not exists (select 1 from public.content_bot_hub_identity(repeat('a', 64))), 'credencial revogada nega');

-- 7. Só service_role executa.
select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'public.content_bot_hub_identity(text)', 'execute')
  and not has_function_privilege('anon', 'public.content_bot_hub_identity(text)', 'execute')
  and has_function_privilege('service_role', 'public.content_bot_hub_identity(text)', 'execute'),
  'só service_role');

rollback;
