-- Gerador de material do Hub: `hub_educator_materials` é escrita só pelo
-- service_role (a edge), lida pelo criador ou por OWNER/ADMIN da conta, e nunca
-- atravessa conta. Tudo sintético, tudo desfeito no rollback.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

create or replace function pg_temp.assert_sqlstate(statement text, expected_sqlstate text, message text)
returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate = expected_sqlstate then return; end if;
    raise exception 'assertion failed: % (expected %, received %)', message, expected_sqlstate, sqlstate;
  end;
  raise exception 'assertion failed: % (statement did not fail)', message;
end;
$$;
grant execute on function pg_temp.assert_sqlstate(text, text, text) to public;

update public.hub_settings
   set metadata = coalesce(metadata, '{}'::jsonb) || '{"hubEnabled":true}'::jsonb
 where settings_key = 'default';

-- Dois donos, dois membros, duas contas — o mesmo desenho do teste do planner.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('7b000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'material-owner-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Material Owner A"}', now(), now()),
  ('7b000000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'material-member-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Material Member A"}', now(), now()),
  ('7b000000-0000-4000-8000-000000000103', 'authenticated', 'authenticated', 'material-member-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Material Member B"}', now(), now()),
  ('7b000000-0000-4000-8000-000000000104', 'authenticated', 'authenticated', 'material-owner-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Material Owner B"}', now(), now());

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
   set tenant_id = null, lifecycle_status = 'active', role = 'NON_STUDENT'
 where id in (
  '7b000000-0000-4000-8000-000000000101', '7b000000-0000-4000-8000-000000000102',
  '7b000000-0000-4000-8000-000000000103', '7b000000-0000-4000-8000-000000000104');
select pg_catalog.set_config('app.enrollment_claim', '', true);

insert into public.hub_plans (id, code, name, description, audience, price_monthly, price_yearly, currency, trial_days, display_order, is_public, is_active, features, metadata, product_family)
values ('7b000000-0000-4000-8000-000000000201', 'HUB_MATERIAL_FIXTURE', 'Hub Material Fixture', 'teste', 'ALL', 1, 10, 'BRL', 0, 999, false, true, '[]'::jsonb, '{"test_fixture":true,"product_family":"HUB_CORE"}'::jsonb, 'HUB_CORE');
insert into public.hub_plan_entitlements (plan_id, feature_key, limit_value, reset_period, metadata)
values ('7b000000-0000-4000-8000-000000000201', 'educator_ai.generate', 100, 'MONTH', '{"test_fixture":true}'::jsonb);

insert into public.hub_accounts (id, account_type, audience, name, owner_user_id, status, metadata)
values
  ('7b000000-0000-4000-8000-000000000301', 'ORGANIZATION', 'INSTITUTION', 'Material Account A', '7b000000-0000-4000-8000-000000000101', 'ACTIVE', '{"test_fixture":true}'::jsonb),
  ('7b000000-0000-4000-8000-000000000302', 'PERSONAL', 'EDUCATOR', 'Material Account B', '7b000000-0000-4000-8000-000000000104', 'ACTIVE', '{"test_fixture":true}'::jsonb);

insert into public.hub_memberships (account_id, user_id, membership_role, subject_role, status)
values
  ('7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000101', 'OWNER', 'EDUCATOR', 'ACTIVE'),
  ('7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000102', 'MEMBER', 'EDUCATOR', 'ACTIVE'),
  ('7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000103', 'MEMBER', 'EDUCATOR', 'ACTIVE'),
  ('7b000000-0000-4000-8000-000000000302', '7b000000-0000-4000-8000-000000000104', 'OWNER', 'EDUCATOR', 'ACTIVE');

insert into public.hub_subscriptions (id, account_id, plan_id, status, billing_cycle, current_period_starts_at, current_period_ends_at, provider, provider_subscription_id, product_family, metadata)
values
  ('7b000000-0000-4000-8000-000000000401', '7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000201', 'ACTIVE', 'MONTHLY', now() - interval '1 day', now() + interval '1 month', 'ASAAS', 'sub_material_fixture_a', 'HUB_CORE', '{"test_fixture":true}'::jsonb),
  ('7b000000-0000-4000-8000-000000000402', '7b000000-0000-4000-8000-000000000302', '7b000000-0000-4000-8000-000000000201', 'ACTIVE', 'MONTHLY', now() - interval '1 day', now() + interval '1 month', 'ASAAS', 'sub_material_fixture_b', 'HUB_CORE', '{"test_fixture":true}'::jsonb);

-- A edge grava como service_role.
set local role service_role;
insert into public.hub_educator_materials (id, account_id, created_by, subscription_id, request_key, request_fingerprint, kind, niche, level_tag, topic, item_count, bilingual, title, material, model_id, prompt_version)
values
  ('7b000000-0000-4000-8000-000000000601', '7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000102', '7b000000-0000-4000-8000-000000000401', gen_random_uuid(), repeat('a', 64), 'quiz', 'TECH', 'B1', 'Daily stand-up', 5, true, 'Stand-up quiz', '{"title":"Stand-up quiz","questions":[]}'::jsonb, 'openai/gpt-4o-mini', 'hub-material-2026-09-18'),
  ('7b000000-0000-4000-8000-000000000602', '7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000103', '7b000000-0000-4000-8000-000000000401', gen_random_uuid(), repeat('b', 64), 'worksheet', 'TRAVEL', 'A2', 'Hotel check-in', 8, true, 'Hotel worksheet', '{"title":"Hotel worksheet"}'::jsonb, 'openai/gpt-4o-mini', 'hub-material-2026-09-18'),
  ('7b000000-0000-4000-8000-000000000603', '7b000000-0000-4000-8000-000000000302', '7b000000-0000-4000-8000-000000000104', '7b000000-0000-4000-8000-000000000402', gen_random_uuid(), repeat('c', 64), 'reading', 'MEDICINE', 'B2', 'Patient intake', 6, false, 'Intake reading', '{"title":"Intake reading"}'::jsonb, 'openai/gpt-4o-mini', 'hub-material-2026-09-18');

-- Constraints do próprio tipo: tipo e nível fora do catálogo não entram.
select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_materials (account_id, created_by, subscription_id, request_key, request_fingerprint, kind, niche, level_tag, topic, item_count, title, material, model_id, prompt_version)
    values ('7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000102', '7b000000-0000-4000-8000-000000000401', gen_random_uuid(), repeat('d', 64), 'poem', 'TECH', 'B1', 'x y z', 5, 't', '{}'::jsonb, 'm', 'v')
  $statement$,
  '23514', 'tipo de material fora do catálogo foi aceito');
select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_materials (account_id, created_by, subscription_id, request_key, request_fingerprint, kind, niche, level_tag, topic, item_count, title, material, model_id, prompt_version)
    values ('7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000102', '7b000000-0000-4000-8000-000000000401', gen_random_uuid(), repeat('e', 64), 'quiz', 'TECH', 'D1', 'x y z', 5, 't', '{}'::jsonb, 'm', 'v')
  $statement$,
  '23514', 'nível fora do CEFR foi aceito');
reset role;

-- MEMBER A: vê só o que criou; não apaga o do colega; não insere pelo cliente.
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"7b000000-0000-4000-8000-000000000102","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select count(*) = 1 and bool_and(id = '7b000000-0000-4000-8000-000000000601') from public.hub_educator_materials),
  'MEMBER A deveria ver exatamente o próprio material');
delete from public.hub_educator_materials where id = '7b000000-0000-4000-8000-000000000602';
select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_materials (account_id, created_by, subscription_id, request_key, request_fingerprint, kind, niche, level_tag, topic, item_count, title, material, model_id, prompt_version)
    values ('7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000102', '7b000000-0000-4000-8000-000000000401', gen_random_uuid(), repeat('f', 64), 'quiz', 'TECH', 'B1', 'spoof', 5, 't', '{}'::jsonb, 'm', 'v')
  $statement$,
  '42501', 'cliente autenticado conseguiu inserir material direto (só a edge pode)');
reset role;

-- OWNER A: vê os dois da conta A, nada da conta B.
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"7b000000-0000-4000-8000-000000000101","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select count(*) = 2 and bool_and(account_id = '7b000000-0000-4000-8000-000000000301') from public.hub_educator_materials),
  'OWNER A deveria ver os 2 materiais da conta A e nenhum da B (o delete do MEMBER A no material alheio não pode ter valido)');
reset role;

-- anon: nada.
set local role anon;
select pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.assert_sqlstate(
  $statement$ select count(*) from public.hub_educator_materials $statement$,
  '42501', 'anon leu a tabela de materiais');
reset role;

-- MEMBER B apaga o próprio.
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"7b000000-0000-4000-8000-000000000103","role":"authenticated"}', true);
delete from public.hub_educator_materials where id = '7b000000-0000-4000-8000-000000000602';
reset role;
select pg_temp.assert_true(
  (select count(*) = 2 from public.hub_educator_materials where account_id in ('7b000000-0000-4000-8000-000000000301', '7b000000-0000-4000-8000-000000000302')),
  'MEMBER B não conseguiu apagar o próprio material');

rollback;
