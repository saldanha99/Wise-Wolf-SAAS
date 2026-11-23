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

select public.hub_material_share_create('7a000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000010', repeat('a', 64));

-- 1. Modo do gabarito: só o autor muda; valor inválido recusado.
select pg_temp.assert_true((public.hub_material_share_set_mode('7a000000-0000-4000-8000-000000000001', repeat('a', 64), 'never') ->> 'ok')::boolean, 'autor muda o modo');
select pg_temp.assert_true(not (public.hub_material_share_set_mode('7a000000-0000-4000-8000-000000000002', repeat('a', 64), 'after_submit') ->> 'ok')::boolean, 'estranho não muda');

-- 2. Para corrigir, o servidor recebe o material COMPLETO e a cota de IA do plano (Pro no teste: 600).
create temp table g as select public.hub_material_share_for_grading(repeat('a', 64)) as r;
select pg_temp.assert_true((select (r ->> 'ok')::boolean and r ->> 'answerKeyMode' = 'never' from g), 'contexto ok');
select pg_temp.assert_true((select (r -> 'material')::text ~ '"correct"' from g), 'material com gabarito só no servidor');
select pg_temp.assert_true((select (r ->> 'aiRemaining')::int = 600 from g), 'cota do Pro');

-- 3. Grava a resposta, gasta a cota de IA e aparece só para o autor.
select public.hub_material_share_record((select (r ->> 'linkId')::uuid from g), 'Ana', '{"questions":[0]}'::jsonb,
  '{"right":1,"total":1}'::jsonb, 1, 1, true);
select pg_temp.assert_true((select (public.hub_material_share_for_grading(repeat('a', 64)) ->> 'aiRemaining')::int = 599), 'cota desce');
select pg_temp.assert_true((select jsonb_array_length(public.hub_material_share_results('7a000000-0000-4000-8000-000000000001',
  '7a000000-0000-4000-8000-000000000010') -> 'submissions') = 1), 'autor vê a resposta');
select pg_temp.assert_true((public.hub_material_share_results('7a000000-0000-4000-8000-000000000002',
  '7a000000-0000-4000-8000-000000000010') ->> 'code') = 'MATERIAL_ACCESS_DENIED', 'estranho não vê');

-- 4. Cotas por plano e nada exposto.
select pg_temp.assert_true((select count(*) = 4 from public.hub_plan_entitlements where feature_key = 'educator_ai.correct'), 'cotas por plano');
select pg_temp.assert_true(not has_function_privilege('anon', 'public.hub_material_share_for_grading(text)', 'execute')
  and not has_table_privilege('authenticated', 'public.hub_material_share_submissions', 'select'), 'só service_role');
rollback;
