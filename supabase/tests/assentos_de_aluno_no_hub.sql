-- Assentos de aluno no Hub: convite por link ocupa assento, aceite vira membro
-- LEARNER da conta do professor, material atribuído chega ao aluno SEM gabarito,
-- e ninguém enxerga o que não é seu. Tudo sintético, tudo desfeito no rollback.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

update public.hub_settings
   set metadata = coalesce(metadata, '{}'::jsonb) || '{"hubEnabled":true}'::jsonb
 where settings_key = 'default';

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('7c000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'seat-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Seat"}', now(), now()),
  ('7c000000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'seat-student@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Student Seat"}', now(), now()),
  ('7c000000-0000-4000-8000-000000000103', 'authenticated', 'authenticated', 'seat-stranger@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Stranger Seat"}', now(), now());

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
   set tenant_id = null, lifecycle_status = 'active', role = 'NON_STUDENT'
 where id in ('7c000000-0000-4000-8000-000000000101', '7c000000-0000-4000-8000-000000000102', '7c000000-0000-4000-8000-000000000103');
select pg_catalog.set_config('app.enrollment_claim', '', true);

insert into public.hub_plans (id, code, name, description, audience, price_monthly, price_yearly, currency, trial_days, display_order, is_public, is_active, features, metadata, product_family)
values ('7c000000-0000-4000-8000-000000000201', 'HUB_SEATS_FIXTURE', 'Hub Seats Fixture', 'teste', 'ALL', 1, 10, 'BRL', 0, 999, false, true, '[]'::jsonb, '{"test_fixture":true,"product_family":"HUB_CORE"}'::jsonb, 'HUB_CORE');
insert into public.hub_plan_entitlements (plan_id, feature_key, limit_value, reset_period, metadata)
values
  ('7c000000-0000-4000-8000-000000000201', 'educator_ai.generate', 100, 'MONTH', '{"test_fixture":true}'::jsonb),
  ('7c000000-0000-4000-8000-000000000201', 'team.seats', 1, 'SUBSCRIPTION', '{"test_fixture":true}'::jsonb);

insert into public.hub_accounts (id, account_type, audience, name, owner_user_id, status, metadata)
values ('7c000000-0000-4000-8000-000000000301', 'PERSONAL', 'EDUCATOR', 'Teacher Seat Studio', '7c000000-0000-4000-8000-000000000101', 'ACTIVE', '{"test_fixture":true}'::jsonb);
insert into public.hub_memberships (account_id, user_id, membership_role, subject_role, status)
values ('7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000101', 'OWNER', 'EDUCATOR', 'ACTIVE');
insert into public.hub_subscriptions (id, account_id, plan_id, status, billing_cycle, current_period_starts_at, current_period_ends_at, provider, provider_subscription_id, product_family, metadata)
values ('7c000000-0000-4000-8000-000000000401', '7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000201', 'ACTIVE', 'MONTHLY', now() - interval '1 day', now() + interval '1 month', 'ASAAS', 'sub_seats_fixture', 'HUB_CORE', '{"test_fixture":true}'::jsonb);

-- Dois perfis de aluno do professor e um material com gabarito.
insert into public.hub_educator_learners (id, account_id, created_by, display_name, level_tag, objective)
values
  ('7c000000-0000-4000-8000-000000000501', '7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000101', 'Aluno Um', 'A2', 'Check-in no hotel'),
  ('7c000000-0000-4000-8000-000000000502', '7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000101', 'Aluno Dois', 'B1', 'Reuniões');
set local role service_role;
insert into public.hub_educator_materials (id, account_id, created_by, subscription_id, request_key, request_fingerprint, kind, niche, level_tag, topic, item_count, title, material, model_id, prompt_version)
values ('7c000000-0000-4000-8000-000000000601', '7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000101', '7c000000-0000-4000-8000-000000000401', gen_random_uuid(), repeat('a', 64), 'quiz', 'TRAVEL', 'A2', 'Hotel check-in', 4, 'Hotel quiz',
  '{"title":"Hotel quiz","grammar_focus":{"point":"Can for requests","watch_out_pt":["segredo do professor"],"patterns":[]},"questions":[{"prompt":"Can I ___ my key?","options":["have","has"],"correct":0,"explanation_pt":"segredo"}],"ai_homework":[{"task_pt":"t","prompt_en":"p","tip_pt":"segredo"}]}'::jsonb,
  'openai/gpt-4o-mini', 'hub-material-2026-09-18.v2');
reset role;

-- 1) Professor convida: 1 assento no plano → o 2º convite é barrado.
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"7c000000-0000-4000-8000-000000000101","role":"authenticated"}', true);
create temporary table seat_invite as
select public.hub_invite_learner('7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000501') as r;
select pg_temp.assert_true(
  (select (r ->> 'ok')::boolean and (r ->> 'token') ~ '^[0-9a-f]{64}$' and (r -> 'seats' ->> 'used') = '1' and (r -> 'seats' ->> 'limit') = '1' from seat_invite),
  'convite do 1º aluno deveria ocupar o único assento');
select pg_temp.assert_true(
  (select r ->> 'code' from public.hub_invite_learner('7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000502') as r) = 'SEATS_EXHAUSTED',
  'segundo convite deveria esbarrar no limite de assentos');
-- Reconvidar o mesmo aluno renova o link sem contar assento novo.
create temporary table seat_reinvite as
select public.hub_invite_learner('7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000501') as r;
grant select on seat_reinvite to public;
select pg_temp.assert_true(
  (select (r ->> 'ok')::boolean and (r -> 'seats' ->> 'used') = '1' from seat_reinvite),
  'reconvite do mesmo aluno não pode contar dois assentos');
-- O painel do professor mostra o assento como convidado, com o link.
select pg_temp.assert_true(
  (select jsonb_array_length(r) = 2
      and (select e ->> 'seat' from jsonb_array_elements(r) e where e ->> 'id' = '7c000000-0000-4000-8000-000000000501') = 'INVITED'
      and (select e ->> 'invite_token' from jsonb_array_elements(r) e where e ->> 'id' = '7c000000-0000-4000-8000-000000000501') = (select r ->> 'token' from seat_reinvite)
      and (select e ->> 'seat' from jsonb_array_elements(r) e where e ->> 'id' = '7c000000-0000-4000-8000-000000000502') = 'NONE'
     from public.hub_list_learner_seats('7c000000-0000-4000-8000-000000000301') as r),
  'listagem de assentos do professor errada');
-- O próprio professor não aceita o convite.
select pg_temp.assert_true(
  (select r ->> 'code' from public.hub_accept_learner_invite((select r ->> 'token' from seat_reinvite)) as r) = 'CANNOT_ACCEPT_OWN_INVITE',
  'professor aceitou o próprio convite');
select pg_temp.assert_true(
  (select (r ->> 'ok')::boolean and (r ->> 'assignment_id') is not null from public.hub_assign_material('7c000000-0000-4000-8000-000000000301', '7c000000-0000-4000-8000-000000000501', '7c000000-0000-4000-8000-000000000601', 'Faça até quinta') as r),
  'atribuição do material falhou');
reset role;

-- Prévia pública do convite mostra só nomes.
set local role anon;
select pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.assert_true(
  (select (r ->> 'ok')::boolean and (r ->> 'learner_name') = 'Aluno Um' and (r ->> 'account_name') = 'Teacher Seat Studio'
     from public.hub_learner_invite_preview((select r ->> 'token' from seat_reinvite)) as r),
  'prévia do convite errada');
select pg_temp.assert_true(
  (select r ->> 'code' from public.hub_learner_invite_preview(repeat('f', 64)) as r) = 'INVITE_INVALID',
  'token inexistente deveria ser inválido');
reset role;

-- 2) Aluno aceita: vira MEMBER/LEARNER com perfil de membro; o link morre.
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"7c000000-0000-4000-8000-000000000102","role":"authenticated"}', true);
create temporary table seat_accept as
select public.hub_accept_learner_invite((select r ->> 'token' from seat_reinvite)) as r;
select pg_temp.assert_true(
  (select (r ->> 'ok')::boolean and (r ->> 'account_id') = '7c000000-0000-4000-8000-000000000301' from seat_accept),
  'aceite do convite falhou');
reset role;
select pg_temp.assert_true(
  (select count(*) = 1 from public.hub_memberships m where m.account_id = '7c000000-0000-4000-8000-000000000301' and m.user_id = '7c000000-0000-4000-8000-000000000102' and m.membership_role = 'MEMBER' and m.subject_role = 'LEARNER' and m.status = 'ACTIVE')
  and (select p.display_name = 'Aluno Um' and p.level = 'A2' from public.hub_member_profiles p where p.account_id = '7c000000-0000-4000-8000-000000000301' and p.user_id = '7c000000-0000-4000-8000-000000000102')
  and (select l.member_user_id = '7c000000-0000-4000-8000-000000000102' and l.invite_token is null from public.hub_educator_learners l where l.id = '7c000000-0000-4000-8000-000000000501'),
  'membership/perfil/assento do aluno não ficaram como esperado');
-- O trigger da membership cria o perfil antes do aceite; o aceite tem de completar
-- o que o trigger não sabe (objetivo do professor, onboarding feito) — senão o
-- aluno cai no formulário genérico do Wolfie em vez da mesa (produção, 18/09/2026).
select pg_temp.assert_true(
  (select p.goal = 'Check-in no hotel' and p.onboarding_completed and p.personalized_at is not null
     from public.hub_member_profiles p
    where p.account_id = '7c000000-0000-4000-8000-000000000301' and p.user_id = '7c000000-0000-4000-8000-000000000102'),
  'aceite não completou o perfil do aluno (objetivo/onboarding) por cima do trigger');
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"7c000000-0000-4000-8000-000000000102","role":"authenticated"}', true);

-- A mesa do aluno traz o material sem gabarito.
create temporary table seat_desk as
select public.hub_learner_desk('7c000000-0000-4000-8000-000000000301') as r;
grant select on seat_desk to public;
select pg_temp.assert_true(
  (select (r ->> 'ok')::boolean and jsonb_array_length(r -> 'assignments') = 1
     and (r -> 'assignments' -> 0 -> 'material' ->> 'title') = 'Hotel quiz'
     and (r -> 'assignments' -> 0 ->> 'note') = 'Faça até quinta'
     and (r -> 'assignments' -> 0 -> 'material' -> 'material')::text not like '%segredo%'
     and (r -> 'assignments' -> 0 -> 'material' -> 'material' -> 'questions' -> 0) ? 'options'
     and not ((r -> 'assignments' -> 0 -> 'material' -> 'material' -> 'questions' -> 0) ? 'correct')
   from seat_desk),
  'mesa do aluno vazou gabarito ou perdeu o material');
-- Direto na tabela o aluno não lê nada (nem material, nem atribuição).
select pg_temp.assert_true(
  (select count(*) = 0 from public.hub_educator_materials) and (select count(*) = 0 from public.hub_learner_assignments),
  'aluno leu material/atribuição por select direto');
select pg_temp.assert_true(
  (select (r ->> 'ok')::boolean from public.hub_complete_assignment((select (r -> 'assignments' -> 0 ->> 'id')::uuid from seat_desk), 'Fiz tudo, dúvida na 3') as r),
  'aluno não conseguiu marcar como feito');
reset role;

-- 3) Estranho com o token já usado não entra; o professor vê o status.
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"7c000000-0000-4000-8000-000000000103","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select r ->> 'code' from public.hub_accept_learner_invite(repeat('a', 64)) as r) = 'INVITE_INVALID',
  'token falso foi aceito');
select pg_temp.assert_true(
  (select r ->> 'code' from public.hub_learner_desk('7c000000-0000-4000-8000-000000000301') as r) = 'NOT_A_LEARNER_HERE',
  'estranho abriu a mesa de aluno da conta');
reset role;
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"7c000000-0000-4000-8000-000000000101","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select a.status = 'DONE' and a.student_note = 'Fiz tudo, dúvida na 3' from public.hub_learner_assignments a where a.learner_id = '7c000000-0000-4000-8000-000000000501'),
  'professor não vê a conclusão do aluno');
select pg_temp.assert_true(
  (select (e ->> 'seat') = 'ACTIVE' and (e -> 'assignments' -> 0 ->> 'status') = 'DONE' and (e ->> 'invite_token') is null
     from public.hub_list_learner_seats('7c000000-0000-4000-8000-000000000301') as r, jsonb_array_elements(r) e
    where e ->> 'id' = '7c000000-0000-4000-8000-000000000501'),
  'painel do professor não mostra o assento ativo com a atribuição feita');
select pg_temp.assert_true(
  (select (r ->> 'used') = '1' and (r ->> 'limit') = '1' from public.hub_learner_seats('7c000000-0000-4000-8000-000000000301') as r),
  'contagem de assentos depois do aceite errada');
reset role;

rollback;
