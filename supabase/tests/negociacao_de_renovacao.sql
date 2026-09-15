-- Negociação de renovação pelo WhatsApp: o banco faz valer a ordem da direção.
--
-- [1] o professor atual é perguntado primeiro;
-- [2] ele propõe outro horário e o pedido volta ao aluno;
-- [3] o aluno aceita e a negociação espera a Gestão, com código;
-- [4] quem não é diretor/coordenação não aprova;
-- [5] a Gestão aprova com valor: oferta antiga cancelada, nova com horário, aviso oficial na fila;
-- [6] se o professor atual recusa, o pedido vai para outro professor livre.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;

insert into public.tenants(id, name, slug, saas_status, whatsapp_enabled)
values ('renewal-negotiation-qa', 'Renewal Negotiation QA', 'renewal-negotiation-qa', 'active', true);
insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('7e180000-0000-4000-8000-000000000031', 'authenticated', 'authenticated', 'neg-student-1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluna Negociacao Um"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000032', 'authenticated', 'authenticated', 'neg-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Atual Sintetica"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000033', 'authenticated', 'authenticated', 'neg-teacher-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Livre Sintetica"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000034', 'authenticated', 'authenticated', 'neg-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora Negociacao"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000035', 'authenticated', 'authenticated', 'neg-student-2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Negociacao Dois"}', now(), now());
set local app.enrollment_claim = '1';
update public.profiles set tenant_id = 'renewal-negotiation-qa', role = 'STUDENT', full_name = 'Aluna Negociacao Um',
  status = 'Ativo', lifecycle_status = 'active', monthly_fee = 377, class_frequency = '5x', due_day = 12,
  contract_accepted = true, asaas_customer_id = 'cus_neg_1', phone = '5511900000031'
 where id = '7e180000-0000-4000-8000-000000000031';
update public.profiles set tenant_id = 'renewal-negotiation-qa', role = 'STUDENT', full_name = 'Aluno Negociacao Dois',
  status = 'Ativo', lifecycle_status = 'active', monthly_fee = 261, class_frequency = '3x', due_day = 10,
  contract_accepted = true, asaas_customer_id = 'cus_neg_2', phone = '5511900000035'
 where id = '7e180000-0000-4000-8000-000000000035';
update public.profiles set tenant_id = 'renewal-negotiation-qa', role = 'TEACHER', full_name = 'Teacher Atual Sintetica', lifecycle_status = 'active', phone = '5511900000032'
 where id = '7e180000-0000-4000-8000-000000000032';
update public.profiles set tenant_id = 'renewal-negotiation-qa', role = 'TEACHER', full_name = 'Teacher Livre Sintetica', lifecycle_status = 'active', phone = '5511900000033'
 where id = '7e180000-0000-4000-8000-000000000033';
update public.profiles set tenant_id = 'renewal-negotiation-qa', role = 'SCHOOL_ADMIN', full_name = 'Diretora Negociacao', lifecycle_status = 'active'
 where id = '7e180000-0000-4000-8000-000000000034';
set local app.enrollment_claim = '';

-- Aula atual das duas alunas é com a Teacher Atual; a Teacher Livre tem grade às 16:00.
insert into public.bookings(tenant_id, teacher_id, student_id, day_of_week, time_slot, status)
values
  ('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000032', '7e180000-0000-4000-8000-000000000031', 'Segunda', '10:00', 'SCHEDULED'),
  ('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000032', '7e180000-0000-4000-8000-000000000035', 'Terça', '10:00', 'SCHEDULED');
insert into public.teacher_availability(teacher_id, tenant_id, day_of_week, start_time)
values
  ('7e180000-0000-4000-8000-000000000033', 'renewal-negotiation-qa', 1, '16:00'),
  ('7e180000-0000-4000-8000-000000000033', 'renewal-negotiation-qa', 3, '16:00'),
  ('7e180000-0000-4000-8000-000000000033', 'renewal-negotiation-qa', 5, '16:00');

create temporary table neg(k text primary key, v jsonb);
insert into neg select 'offer1', private.issue_student_course_renewal_offer(
  private.register_student_course_renewal_proposal('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000031',
    37700, 5::smallint, 12::smallint, 'Renovação nas condições atuais (sintético)', repeat('d', 64)),
  (now() at time zone 'America/Sao_Paulo')::date + 5, (now() at time zone 'America/Sao_Paulo')::date,
  'CREATE_NEW', 'cus_neg_1', null, 'PIX');
insert into neg select 'offer2', private.issue_student_course_renewal_offer(
  private.register_student_course_renewal_proposal('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000035',
    26100, 3::smallint, 10::smallint, 'Renovação nas condições atuais (sintético 2)', repeat('e', 64)),
  (now() at time zone 'America/Sao_Paulo')::date + 5, (now() at time zone 'America/Sao_Paulo')::date,
  'CREATE_NEW', 'cus_neg_2', null, 'PIX');

select pg_temp.assert_true((public.renewal_negotiation_context('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000031')->>'active')::boolean,
  'contexto não enxerga a renovação pendente');

-- [1] Aluna pede 3x às 14:30: a Teacher Atual é perguntada primeiro.
insert into neg select 'open1', public.open_renewal_negotiation('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000031',
  3::smallint, '[{"day":"seg","time":"14:30"},{"day":"ter","time":"14:30"},{"day":"sex","time":"14:30"}]', 'Aluna pediu 3x às 14:30');
select pg_temp.assert_true((select v->>'action' = 'ask_teacher' and v->>'teacher_id' = '7e180000-0000-4000-8000-000000000032'
  and v->>'reply_code' ~ '^[A-F0-9]{8}$' from neg where k = 'open1'), 'o professor atual não foi o primeiro perguntado');

-- [2] Ela propõe outro horário: volta para a aluna.
insert into neg select 'counter1', public.respond_renewal_teacher_request('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000032',
  (select v->>'reply_code' from neg where k = 'open1'), 'COUNTER',
  '[{"day":"Segunda","time":"15:00"},{"day":"Terça","time":"15:00"},{"day":"Sexta","time":"15:00"}]', 'Posso às 15h');
select pg_temp.assert_true((select v->>'action' = 'ask_student' from neg where k = 'counter1'), 'contraproposta não voltou para a aluna');

-- [3] A aluna aceita: espera a Gestão, com código.
insert into neg select 'accept1', public.student_accept_renewal_proposal('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000031');
select pg_temp.assert_true((select v->>'action' = 'await_management' and v->>'approval_code' ~ '^[A-F0-9]{8}$' from neg where k = 'accept1'),
  'aceite da aluna não levou à aprovação da Gestão');

-- [4] Professor não aprova renovação.
select pg_temp.assert_true((select public.approve_renewal_negotiation('renewal-negotiation-qa', v->>'approval_code',
  '7e180000-0000-4000-8000-000000000032', 26100)->>'error' = 'forbidden' from neg where k = 'accept1'),
  'professor conseguiu aprovar renovação');

-- [5] A diretora aprova por R$ 261.
insert into neg select 'approve1', public.approve_renewal_negotiation('renewal-negotiation-qa',
  (select v->>'approval_code' from neg where k = 'accept1'), '7e180000-0000-4000-8000-000000000034', 26100);
select pg_temp.assert_true((select (v->>'ok')::boolean and (v->>'fee_cents')::bigint = 26100 from neg where k = 'approve1'), 'aprovação falhou');
select pg_temp.assert_true((select status = 'CANCELLED' from private.student_course_renewal_offers
  where id = (select (v->>'id')::uuid from neg where k = 'offer1')), 'oferta antiga continua viva');
select pg_temp.assert_true((select o.status = 'PENDING_SIGNATURE' and o.monthly_fee_cents = 26100 and o.classes_per_week = 3
  and o.schedule_plan->>'teacher_id' = '7e180000-0000-4000-8000-000000000032'
  and o.schedule_plan->'slots'->0->>'time' = '15:00'
  from private.student_course_renewal_offers o where o.id = (select (v->>'new_offer_id')::uuid from neg where k = 'approve1')),
  'oferta nova não saiu com as condições aprovadas');
select pg_temp.assert_true(exists (select 1 from public.student_course_renewal_notification_outbox
  where offer_id = (select (v->>'new_offer_id')::uuid from neg where k = 'approve1') and milestone = 'INITIAL' and status = 'PENDING'),
  'o link não entrou no canal oficial de avisos');
select pg_temp.assert_true((select public.approve_renewal_negotiation('renewal-negotiation-qa', v->>'approval_code',
  '7e180000-0000-4000-8000-000000000034', 26100)->>'already' = 'true' from neg where k = 'accept1'),
  'segunda aprovação não foi idempotente');

-- [6] Recusa do professor atual → pergunta à Teacher Livre (grade às 16:00, sem choque).
insert into neg select 'open2', public.open_renewal_negotiation('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000035',
  3::smallint, '[{"day":"Segunda","time":"16:00"},{"day":"Quarta","time":"16:00"},{"day":"Sexta","time":"16:00"}]', 'Aluno pediu 16h');
insert into neg select 'decline2', public.respond_renewal_teacher_request('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000032',
  null, 'DECLINE', null, 'Não consigo');
select pg_temp.assert_true((select v->>'action' = 'ask_other_teacher' and v->>'teacher_id' = '7e180000-0000-4000-8000-000000000033'
  from neg where k = 'decline2'), 'recusa não levou a outro professor livre');
select pg_temp.assert_true((select count(*) >= 6 from private.student_course_renewal_events where event_type like 'NEGOTIATION_%'
  and tenant_id = 'renewal-negotiation-qa'), 'negociação sem trilha de auditoria');

-- O webhook só desvia mensagem de professor com pedido aberto.
select pg_temp.assert_true(public.renewal_teacher_has_pending('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000033'),
  'professor livre perguntado não aparece com pedido aberto');
select pg_temp.assert_true(not public.renewal_teacher_has_pending('renewal-negotiation-qa', '7e180000-0000-4000-8000-000000000032'),
  'professor que já respondeu continua com pedido aberto');

-- Aluno em renovação é reconhecido pelo telefone (sem DDI), e DDD diferente não casa.
select pg_temp.assert_true((select count(*) = 1 from public.renewal_student_for_phone('renewal-negotiation-qa', '11900000035')
  where student_id = '7e180000-0000-4000-8000-000000000035'), 'aluno em renovação não reconhecido pelo telefone');
select pg_temp.assert_true((select count(*) = 0 from public.renewal_student_for_phone('renewal-negotiation-qa', '5521900000035')),
  'telefone de outro DDD foi confundido com o aluno');

rollback;
