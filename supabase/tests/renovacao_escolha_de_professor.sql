-- Renovação: a pergunta "quer seguir com a professora?" só existe quando há
-- outro professor livre nos horários do aluno, e o prazo de 24h avisa a Gestão.
--
-- [1] pediu horário novo com professor livre → pergunta antes de consultar a atual;
-- [2] "outro professor" → consulta o professor livre (não a atual);
-- [3] pediu horário novo SEM professor livre → nem pergunta: consulta a atual;
-- [4] renovação sem mudança, com alternativa → pergunta uma vez; "sim" mantém tudo;
-- [5] renovação sem mudança, sem alternativa → não pergunta;
-- [6] pedido ao professor vencido → EXPIRED + alerta no grupo da Gestão.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;

insert into public.tenants(id, name, slug, saas_status, whatsapp_enabled)
values ('renewal-choice-qa', 'Renewal Choice QA', 'renewal-choice-qa', 'active', true);
insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('7e180000-0000-4000-8000-000000000041', 'authenticated', 'authenticated', 'choice-student-1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluna Escolha Um"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000042', 'authenticated', 'authenticated', 'choice-student-2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Escolha Dois"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000043', 'authenticated', 'authenticated', 'choice-student-3@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluna Escolha Tres"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000044', 'authenticated', 'authenticated', 'choice-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Atual Escolha"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000045', 'authenticated', 'authenticated', 'choice-teacher-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Livre Escolha"}', now(), now());
set local app.enrollment_claim = '1';
update public.profiles set tenant_id = 'renewal-choice-qa', role = 'STUDENT', full_name = 'Aluna Escolha Um', status = 'Ativo',
  lifecycle_status = 'active', monthly_fee = 261, class_frequency = '3x', due_day = 10, contract_accepted = true,
  asaas_customer_id = 'cus_choice_1', phone = '5511900000041'
 where id = '7e180000-0000-4000-8000-000000000041';
update public.profiles set tenant_id = 'renewal-choice-qa', role = 'STUDENT', full_name = 'Aluno Escolha Dois', status = 'Ativo',
  lifecycle_status = 'active', monthly_fee = 261, class_frequency = '3x', due_day = 10, contract_accepted = true,
  asaas_customer_id = 'cus_choice_2', phone = '5511900000042'
 where id = '7e180000-0000-4000-8000-000000000042';
update public.profiles set tenant_id = 'renewal-choice-qa', role = 'STUDENT', full_name = 'Aluna Escolha Tres', status = 'Ativo',
  lifecycle_status = 'active', monthly_fee = 150, class_frequency = '1x', due_day = 10, contract_accepted = true,
  asaas_customer_id = 'cus_choice_3', phone = '5511900000043'
 where id = '7e180000-0000-4000-8000-000000000043';
update public.profiles set tenant_id = 'renewal-choice-qa', role = 'TEACHER', full_name = 'Teacher Atual Escolha', lifecycle_status = 'active', phone = '5511900000044'
 where id = '7e180000-0000-4000-8000-000000000044';
update public.profiles set tenant_id = 'renewal-choice-qa', role = 'TEACHER', full_name = 'Teacher Livre Escolha', lifecycle_status = 'active', phone = '5511900000045'
 where id = '7e180000-0000-4000-8000-000000000045';
set local app.enrollment_claim = '';
insert into public.dre_report_settings(tenant_id, destino, is_active) values ('renewal-choice-qa', '120363400000000041@g.us', true);

-- Todos os alunos têm aula com a Teacher Atual; a Teacher Livre só tem grade às 16:00.
insert into public.bookings(tenant_id, teacher_id, student_id, day_of_week, time_slot, status)
values
  ('renewal-choice-qa', '7e180000-0000-4000-8000-000000000044', '7e180000-0000-4000-8000-000000000041', 'Segunda', '10:00', 'SCHEDULED'),
  ('renewal-choice-qa', '7e180000-0000-4000-8000-000000000044', '7e180000-0000-4000-8000-000000000042', 'Terça', '10:00', 'SCHEDULED'),
  ('renewal-choice-qa', '7e180000-0000-4000-8000-000000000044', '7e180000-0000-4000-8000-000000000043', 'Quarta', '16:00', 'SCHEDULED');
insert into public.teacher_availability(teacher_id, tenant_id, day_of_week, start_time)
values
  ('7e180000-0000-4000-8000-000000000045', 'renewal-choice-qa', 1, '16:00'),
  ('7e180000-0000-4000-8000-000000000045', 'renewal-choice-qa', 3, '16:00'),
  ('7e180000-0000-4000-8000-000000000045', 'renewal-choice-qa', 5, '16:00');

create temporary table ch(k text primary key, v jsonb);
insert into ch select 'offer1', private.issue_student_course_renewal_offer(
  private.register_student_course_renewal_proposal('renewal-choice-qa', '7e180000-0000-4000-8000-000000000041',
    26100, 3::smallint, 10::smallint, 'Renovação sintética — escolha um', repeat('f', 64)),
  (now() at time zone 'America/Sao_Paulo')::date + 5, (now() at time zone 'America/Sao_Paulo')::date, 'CREATE_NEW', 'cus_choice_1', null, 'PIX');
insert into ch select 'offer2', private.issue_student_course_renewal_offer(
  private.register_student_course_renewal_proposal('renewal-choice-qa', '7e180000-0000-4000-8000-000000000042',
    26100, 3::smallint, 10::smallint, 'Renovação sintética — escolha dois', repeat('1', 64)),
  (now() at time zone 'America/Sao_Paulo')::date + 5, (now() at time zone 'America/Sao_Paulo')::date, 'CREATE_NEW', 'cus_choice_2', null, 'PIX');
insert into ch select 'offer3', private.issue_student_course_renewal_offer(
  private.register_student_course_renewal_proposal('renewal-choice-qa', '7e180000-0000-4000-8000-000000000043',
    15000, 1::smallint, 10::smallint, 'Renovação sintética — escolha tres', repeat('2', 64)),
  (now() at time zone 'America/Sao_Paulo')::date + 5, (now() at time zone 'America/Sao_Paulo')::date, 'CREATE_NEW', 'cus_choice_3', null, 'PIX');

-- [1] Pediu 16:00 seg/qua/sex e a Teacher Livre cobre: pergunta primeiro.
insert into ch select 'open1', public.open_renewal_negotiation('renewal-choice-qa', '7e180000-0000-4000-8000-000000000041',
  3::smallint, '[{"day":"Segunda","time":"16:00"},{"day":"Quarta","time":"16:00"},{"day":"Sexta","time":"16:00"}]', 'Pediu 16h');
select pg_temp.assert_true((select v->>'action' = 'ask_student_teacher_choice' and v->>'teacher_name' = 'Teacher Atual Escolha'
  from ch where k = 'open1'), 'com alternativa real, o aluno deveria ser perguntado antes');
select pg_temp.assert_true(not exists (select 1 from private.course_renewal_teacher_requests r
  join private.course_renewal_negotiations n on n.id = r.negotiation_id
  where n.student_id = '7e180000-0000-4000-8000-000000000041' and r.status = 'PENDING'),
  'nenhum professor deveria ser consultado antes da resposta do aluno');

-- [2] "outro professor": consulta a Teacher Livre.
insert into ch select 'choose1', public.student_choose_renewal_teacher('renewal-choice-qa', '7e180000-0000-4000-8000-000000000041', false);
select pg_temp.assert_true((select v->>'action' = 'ask_other_teacher' and v->>'teacher_id' = '7e180000-0000-4000-8000-000000000045'
  from ch where k = 'choose1'), 'a escolha por outro professor deveria consultar o professor livre');

-- [3] Pediu 18:00 (ninguém livre): nem pergunta, consulta a atual.
insert into ch select 'open2', public.open_renewal_negotiation('renewal-choice-qa', '7e180000-0000-4000-8000-000000000042',
  3::smallint, '[{"day":"Segunda","time":"18:00"},{"day":"Quarta","time":"18:00"},{"day":"Sexta","time":"18:00"}]', 'Pediu 18h');
select pg_temp.assert_true((select v->>'action' = 'ask_teacher' and v->>'teacher_id' = '7e180000-0000-4000-8000-000000000044'
  from ch where k = 'open2'), 'sem alternativa, não deveria perguntar e sim consultar a atual');

-- [4] Renovação sem mudança (qua 16:00, 1x) com alternativa: pergunta uma vez; "sim" mantém.
select pg_temp.assert_true((public.renewal_negotiation_context('renewal-choice-qa', '7e180000-0000-4000-8000-000000000043')->>'alternative_for_current')::boolean,
  'o contexto deveria indicar alternativa real nos horários atuais');
insert into ch select 'offer_choice3', public.offer_renewal_teacher_choice('renewal-choice-qa', '7e180000-0000-4000-8000-000000000043');
select pg_temp.assert_true((select v->>'action' = 'ask_student_teacher_choice' from ch where k = 'offer_choice3'),
  'a pergunta da renovação sem mudança não foi feita');
select pg_temp.assert_true((public.offer_renewal_teacher_choice('renewal-choice-qa', '7e180000-0000-4000-8000-000000000043')->>'ok')::boolean is false,
  'a pergunta não pode ser feita duas vezes');
insert into ch select 'keep3', public.student_choose_renewal_teacher('renewal-choice-qa', '7e180000-0000-4000-8000-000000000043', true);
select pg_temp.assert_true((select v->>'action' = 'kept' from ch where k = 'keep3'), '"sim" deveria manter a professora');
select pg_temp.assert_true(not (public.renewal_negotiation_context('renewal-choice-qa', '7e180000-0000-4000-8000-000000000043')->>'alternative_for_current')::boolean,
  'depois de respondida, a pergunta não pode voltar');
select pg_temp.assert_true((select status = 'PENDING_SIGNATURE' from private.student_course_renewal_offers
  where id = (select (v->>'id')::uuid from ch where k = 'offer3')), 'manter a professora não pode mexer na oferta');

-- [5] Sem alternativa nos horários atuais (ter 10:00): não pergunta.
update public.teacher_availability set start_time = '17:00' where teacher_id = '7e180000-0000-4000-8000-000000000045' and tenant_id = 'renewal-choice-qa';
select pg_temp.assert_true((public.offer_renewal_teacher_choice('renewal-choice-qa', '7e180000-0000-4000-8000-000000000042')->>'ok')::boolean is false,
  'sem alternativa real a pergunta não pode ser feita');

-- [6] Pedido vencido: EXPIRED + alerta no grupo.
update private.course_renewal_teacher_requests set expires_at = clock_timestamp() - interval '1 minute'
 where status = 'PENDING' and tenant_id = 'renewal-choice-qa';
select pg_temp.assert_true(private.expire_renewal_teacher_requests() >= 1, 'nenhum pedido vencido foi expirado');
select pg_temp.assert_true(not exists (select 1 from private.course_renewal_teacher_requests
  where tenant_id = 'renewal-choice-qa' and status = 'PENDING'), 'pedido vencido continua pendente');
select pg_temp.assert_true(exists (select 1 from public.notification_queue
  where tenant_id = 'renewal-choice-qa' and student_phone = '120363400000000041@g.us'
    and message_body like '%RENOVAÇÃO SEM RESPOSTA%'), 'a Gestão não foi alertada do prazo vencido');

rollback;
