-- Correção por IA da atividade do link (migration 20261123180000). Tudo desfeito.
begin;
create or replace function pg_temp.assert_true(p_ok boolean, p_message text) returns void
language plpgsql as $$ begin if p_ok is not true then raise exception 'assertion failed: %', p_message; end if; end $$;

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('7a000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'link-prof@exemplo.invalid', '{}', now(), now()),
       ('7a000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'link-outro@exemplo.invalid', '{}', now(), now());
update public.profiles set lifecycle_status = 'active', status = 'Ativo'
 where id in ('7a000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000002');
select set_config('request.jwt.claims', '{"sub":"7a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table c as select private.hub_claim_trial_internal('EDUCATOR', 'Prof Link') as r;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.hub_educator_materials (id, account_id, created_by, subscription_id, request_key, request_fingerprint,
  kind, niche, level_tag, topic, item_count, title, material, model_id, prompt_version)
select '7a000000-0000-4000-8000-000000000010', (r ->> 'accountId')::uuid, '7a000000-0000-4000-8000-000000000001',
  (r ->> 'subscriptionId')::uuid, gen_random_uuid(), repeat('0', 64), 'quiz', 'TRAVEL', 'A2', 'airport check-in', 8,
  'Quiz do aeroporto', '{"questions":[{"question":"I ___ my passport.","options":["have","has"],"correct":0,"explanation_pt":"have com I"}]}'::jsonb,
  'm', 'v'
from c;
insert into public.hub_account_branding (account_id, logo_data_url, display_name, updated_by)
select (r ->> 'accountId')::uuid, 'data:image/png;base64,iVBORw0KGgo=', 'Prof Link', '7a000000-0000-4000-8000-000000000001' from c;

-- 1. O modo do gabarito nasce com o link, na mesma transação; modo inválido é recusado.
select pg_temp.assert_true((public.hub_material_share_create('7a000000-0000-4000-8000-000000000001',
  '7a000000-0000-4000-8000-000000000010', repeat('a', 64), 'never') ->> 'answerKeyMode') = 'never', 'link nasce never');
select pg_temp.assert_true((select answer_key_mode = 'never' from public.hub_material_share_links where token_sha256 = repeat('a', 64)), 'gravado never');
select pg_temp.assert_true(not (public.hub_material_share_create('7a000000-0000-4000-8000-000000000002',
  '7a000000-0000-4000-8000-000000000010', repeat('b', 64), 'after_submit') ->> 'ok')::boolean, 'estranho não cria');
do $t$ begin
  perform public.hub_material_share_create('7a000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000010', repeat('c', 64), 'sempre');
  raise exception 'modo inválido passou';
exception when sqlstate '22023' then null; end $t$;

-- 2. Para corrigir, o servidor recebe o material COMPLETO.
create temp table g as select public.hub_material_share_for_grading(repeat('a', 64)) as r;
select pg_temp.assert_true((select (r ->> 'ok')::boolean and r ->> 'answerKeyMode' = 'never' from g), 'contexto ok');
select pg_temp.assert_true((select (r -> 'material')::text ~ '"correct"' from g), 'material com gabarito só no servidor');

-- 3. Cota reservada ANTES da IA, sob trava: limite 2 no teste (desfeito no rollback).
update public.hub_plan_entitlements e set limit_value = 2
  from public.hub_subscriptions s
 where s.id = (select (r ->> 'subscriptionId')::uuid from c) and e.plan_id = s.plan_id and e.feature_key = 'educator_ai.correct';
create temp table rs (n int, r jsonb);
insert into rs select 1, public.hub_material_share_reserve_ai((select (r ->> 'linkId')::uuid from g));
insert into rs select 2, public.hub_material_share_reserve_ai((select (r ->> 'linkId')::uuid from g));
insert into rs select 3, public.hub_material_share_reserve_ai((select (r ->> 'linkId')::uuid from g));
select pg_temp.assert_true((select bool_and((r ->> 'ok')::boolean) from rs where n in (1, 2)), 'duas reservas');
select pg_temp.assert_true((select r ->> 'code' = 'AI_QUOTA_EXHAUSTED' from rs where n = 3), 'terceira recusada');
select public.hub_material_share_release_ai((select (r ->> 'reservationId')::uuid from rs where n = 2));
insert into rs select 4, public.hub_material_share_reserve_ai((select (r ->> 'linkId')::uuid from g));
select pg_temp.assert_true((select (r ->> 'ok')::boolean from rs where n = 4), 'liberada volta à cota');

-- Grava a resposta com a reserva 1: vira uso; a 4 ainda segura a outra vaga.
select public.hub_material_share_record((select (r ->> 'linkId')::uuid from g), 'Ana', '{"questions":[0]}'::jsonb,
  '{"right":1,"total":1}'::jsonb, 1, 1, true, (select (r ->> 'reservationId')::uuid from rs where n = 1));
select pg_temp.assert_true((public.hub_material_share_reserve_ai((select (r ->> 'linkId')::uuid from g)) ->> 'code') = 'AI_QUOTA_EXHAUSTED', 'uso + reserva = limite');
select public.hub_material_share_release_ai((select (r ->> 'reservationId')::uuid from rs where n = 4));
select pg_temp.assert_true((public.hub_material_share_reserve_ai((select (r ->> 'linkId')::uuid from g)) ->> 'ok')::boolean, 'sobrou 1');
select pg_temp.assert_true((select jsonb_array_length(public.hub_material_share_results('7a000000-0000-4000-8000-000000000001',
  '7a000000-0000-4000-8000-000000000010') -> 'submissions') = 1), 'autor vê a resposta');
select pg_temp.assert_true((public.hub_material_share_results('7a000000-0000-4000-8000-000000000002',
  '7a000000-0000-4000-8000-000000000010') ->> 'code') = 'MATERIAL_ACCESS_DENIED', 'estranho não vê');

-- Rajada: 20 envios no mesmo minuto fecham o link por 1 minuto.
insert into public.hub_material_share_submissions (link_id, account_id, material_id, answers, result)
select l.id, l.account_id, l.material_id, '{}'::jsonb, '{}'::jsonb
  from public.hub_material_share_links l, generate_series(1, 19) where l.token_sha256 = repeat('a', 64);
select pg_temp.assert_true((public.hub_material_share_for_grading(repeat('a', 64)) ->> 'code') = 'SUBMISSION_LIMIT_REACHED', 'rajada barrada');

-- 4. Cotas por plano e nada exposto.
select pg_temp.assert_true((select count(*) = 4 from public.hub_plan_entitlements where feature_key = 'educator_ai.correct'), 'cotas por plano');
select pg_temp.assert_true(not has_function_privilege('anon', 'public.hub_material_share_for_grading(text)', 'execute')
  and not has_function_privilege('anon', 'public.hub_material_share_reserve_ai(uuid)', 'execute')
  and not has_table_privilege('authenticated', 'public.hub_material_share_ai_reservations', 'select')
  and not has_table_privilege('authenticated', 'public.hub_material_share_submissions', 'select'), 'só service_role');
rollback;
