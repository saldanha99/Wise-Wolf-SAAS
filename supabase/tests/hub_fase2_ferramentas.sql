-- Hub Fase 2 (migration 20261123100000): tipos novos aceitos, ferramenta com
-- id válido, gabarito dos tipos novos fora da mesa do aluno, cotas novas por
-- plano e reserva das cotas novas com a mesma regra da geração.
-- Tudo sintético, tudo desfeito no rollback.

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

-- 1. Cotas novas por plano (valores da migration; mudar = migration nova)
select pg_temp.assert_true(
  (select count(*) = 6
     from public.hub_plan_entitlements as entitlement
     join public.hub_plans as plan on plan.id = entitlement.plan_id
    where (plan.code, entitlement.feature_key, entitlement.limit_value) in (
      ('DISCOVERY', 'educator_ai.cefr_check', 10), ('DISCOVERY', 'educator_ai.adapt', 2),
      ('PROFESSOR_PRO', 'educator_ai.cefr_check', 150), ('PROFESSOR_PRO', 'educator_ai.adapt', 20),
      ('PROFESSOR_ESCOLA', 'educator_ai.cefr_check', 450), ('PROFESSOR_ESCOLA', 'educator_ai.adapt', 60))),
  'cotas de CEFR e adaptação por plano ausentes ou diferentes');

-- 2. Gabarito dos tipos novos não chega ao aluno
select pg_temp.assert_true(
  (
    with stripped as (
      select private.hub_strip_answer_keys($json${
        "left_items": ["a", "b"], "right_items": ["y", "x"], "answer_key": [1, 0],
        "model_answer": "Dear Ana",
        "gaps": [{"prompt": "The ___", "answer": "key", "explanation_pt": "x"}],
        "statements": [{"statement": "s", "correct": true, "explanation_pt": "x"}],
        "sentences": [{"sentence": "She work.", "answer": "She works.", "explanation_pt": "x"}],
        "items": [{"original": "o", "instruction": "i", "answer": "a", "explanation_pt": "x"}],
        "word_bank": ["key", "gym"],
        "rubric": [{"criterion_pt": "c", "descriptor_pt": "d"}]
      }$json$::jsonb) as v
    )
    select not (v ? 'answer_key') and not (v ? 'model_answer')
       and v -> 'left_items' = '["a","b"]'::jsonb and v -> 'right_items' = '["y","x"]'::jsonb
       and v -> 'word_bank' = '["key","gym"]'::jsonb and v ? 'rubric'
       and not (v -> 'gaps' -> 0 ? 'answer') and v -> 'gaps' -> 0 ->> 'prompt' = 'The ___'
       and not (v -> 'statements' -> 0 ? 'correct') and not (v -> 'statements' -> 0 ? 'explanation_pt')
       and not (v -> 'sentences' -> 0 ? 'answer') and v -> 'sentences' -> 0 ->> 'sentence' = 'She work.'
       and not (v -> 'items' -> 0 ? 'answer') and v -> 'items' -> 0 ->> 'instruction' = 'i'
    from stripped
  ),
  'gabarito de tipo novo vazou para a mesa do aluno');

-- Os tipos antigos continuam como antes
select pg_temp.assert_true(
  (select not (private.hub_strip_answer_keys('{"questions":[{"prompt":"p","options":["a","b"],"correct":0}],"teacher_notes_pt":"n"}'::jsonb) -> 'questions' -> 0 ? 'correct')
      and not (private.hub_strip_answer_keys('{"teacher_notes_pt":"n"}'::jsonb) ? 'teacher_notes_pt')),
  'tipos antigos perderam a proteção do gabarito');

-- 3. A reserva conhece as cotas novas
select pg_temp.assert_true(
  pg_catalog.strpos(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
    'private.hub_reserve_feature_internal(uuid,text,integer,uuid,text,uuid,jsonb)')), 'educator_ai.adapt') > 0,
  'reserva sem as cotas novas');

update public.hub_settings
   set metadata = coalesce(metadata, '{}'::jsonb) || '{"hubEnabled":true}'::jsonb
 where settings_key = 'default';

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('7c000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'fase2-owner@example.invalid',
        '{"provider":"email","providers":["email"]}', '{"full_name":"Fase 2 Owner"}', now(), now());

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
   set tenant_id = null, lifecycle_status = 'active', role = 'NON_STUDENT'
 where id = '7c000000-0000-4000-8000-000000000101';
select pg_catalog.set_config('app.enrollment_claim', '', true);

insert into public.hub_plans (id, code, name, description, audience, price_monthly, price_yearly, currency, trial_days, display_order, is_public, is_active, features, metadata, product_family)
values ('7c000000-0000-4000-8000-000000000201', 'HUB_FASE2_FIXTURE', 'Hub Fase 2 Fixture', 'teste', 'ALL', 1, 10, 'BRL', 0, 999, false, true, '[]'::jsonb, '{"test_fixture":true,"product_family":"HUB_CORE"}'::jsonb, 'HUB_CORE');
insert into public.hub_plan_entitlements (plan_id, feature_key, limit_value, reset_period, metadata)
values
  ('7c000000-0000-4000-8000-000000000201', 'educator_ai.generate', 10, 'MONTH', '{"test_fixture":true}'::jsonb),
  ('7c000000-0000-4000-8000-000000000201', 'educator_ai.cefr_check', 1, 'MONTH', '{"test_fixture":true}'::jsonb),
  ('7c000000-0000-4000-8000-000000000201', 'educator_ai.adapt', 0, 'MONTH', '{"test_fixture":true}'::jsonb);

insert into public.hub_accounts (id, account_type, audience, name, owner_user_id, status, metadata)
values ('7c000000-0000-4000-8000-000000000301', 'PERSONAL', 'EDUCATOR', 'Fase 2 Account', '7c000000-0000-4000-8000-000000000101', 'ACTIVE', '{"test_fixture":true}'::jsonb);
insert into public.hub_memberships (account_id, user_id, membership_role, subject_role, status)
values ('7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000101', 'OWNER', 'EDUCATOR', 'ACTIVE')
on conflict do nothing;
insert into public.hub_subscriptions (id, account_id, plan_id, status, billing_cycle, current_period_starts_at, current_period_ends_at, provider, provider_subscription_id, product_family, metadata)
values ('7c000000-0000-4000-8000-000000000401', '7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000201', 'ACTIVE', 'MONTHLY', now() - interval '1 day', now() + interval '1 month', 'ASAAS', 'sub_fase2_fixture', 'HUB_CORE', '{"test_fixture":true}'::jsonb);

create temporary table fase2_results(result_key text primary key, payload jsonb) on commit drop;
grant all on fase2_results to service_role;

set local role service_role;
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into fase2_results values ('cefr_first', public.hub_reserve_feature(
  '7c000000-0000-4000-8000-000000000101', 'educator_ai.cefr_check', 1,
  '7c000000-0000-4000-8000-000000000501', pg_catalog.repeat('a', 64),
  '7c000000-0000-4000-8000-000000000301', '{"source":"pedagogical-content"}'::jsonb));
select pg_temp.assert_true(
  (select (payload ->> 'allowed')::boolean from fase2_results where result_key = 'cefr_first'),
  'reserva do CEFR dentro da cota foi recusada');

insert into fase2_results values ('cefr_second', public.hub_reserve_feature(
  '7c000000-0000-4000-8000-000000000101', 'educator_ai.cefr_check', 1,
  '7c000000-0000-4000-8000-000000000502', pg_catalog.repeat('b', 64),
  '7c000000-0000-4000-8000-000000000301', '{"source":"pedagogical-content"}'::jsonb));
select pg_temp.assert_true(
  (select not (payload ->> 'allowed')::boolean from fase2_results where result_key = 'cefr_second'),
  'segunda reserva do CEFR passou do teto de 1');

insert into fase2_results values ('adapt_zero', public.hub_reserve_feature(
  '7c000000-0000-4000-8000-000000000101', 'educator_ai.adapt', 1,
  '7c000000-0000-4000-8000-000000000503', pg_catalog.repeat('c', 64),
  '7c000000-0000-4000-8000-000000000301', '{"source":"pedagogical-content"}'::jsonb));
select pg_temp.assert_true(
  (select not (payload ->> 'allowed')::boolean from fase2_results where result_key = 'adapt_zero'),
  'adaptação com cota 0 foi reservada');

-- Metadado fora da allowlist continua recusado nas cotas novas
select pg_temp.assert_sqlstate(
  $statement$ select public.hub_reserve_feature(
    '7c000000-0000-4000-8000-000000000101', 'educator_ai.cefr_check', 1,
    '7c000000-0000-4000-8000-000000000504', pg_catalog.repeat('d', 64),
    '7c000000-0000-4000-8000-000000000301', '{"source":"pedagogical-content","extra":"x"}'::jsonb) $statement$,
  '22023', 'metadado extra aceito na cota de CEFR');

-- 4. Tipos novos e ferramenta na tabela
insert into public.hub_educator_materials (account_id, created_by, subscription_id, request_key, request_fingerprint, kind, niche, level_tag, topic, item_count, title, material, model_id, prompt_version, tool_id)
values ('7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000101', '7c000000-0000-4000-8000-000000000401', gen_random_uuid(), repeat('e', 64), 'matching', 'TRAVEL', 'A2', 'Hotel words', 6, 'Hotel words', '{"title":"Hotel words"}'::jsonb, 'm', 'v', 'vocab-matching');
select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_materials (account_id, created_by, subscription_id, request_key, request_fingerprint, kind, niche, level_tag, topic, item_count, title, material, model_id, prompt_version, tool_id)
    values ('7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000101', '7c000000-0000-4000-8000-000000000401', gen_random_uuid(), repeat('f', 64), 'gap_fill', 'TRAVEL', 'A2', 'x y z', 6, 't', '{}'::jsonb, 'm', 'v', 'Tool With Spaces')
  $statement$,
  '23514', 'tool_id fora do padrão foi aceito');
select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_materials (account_id, created_by, subscription_id, request_key, request_fingerprint, kind, niche, level_tag, topic, item_count, title, material, model_id, prompt_version)
    values ('7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000101', '7c000000-0000-4000-8000-000000000401', gen_random_uuid(), repeat('0', 64), 'poem', 'TRAVEL', 'A2', 'x y z', 6, 't', '{}'::jsonb, 'm', 'v')
  $statement$,
  '23514', 'tipo fora do catálogo foi aceito');
reset role;

rollback;
