-- O professor troca o horário do PRÓPRIO aluno e a Gestão fica sabendo.
--
-- Decisão da direção em 15/09/2026. O que este teste segura:
-- [1] a troca aplica, preserva o horário antigo nas datas passadas e registra;
-- [2] toda troca enfileira aviso no grupo da Gestão;
-- [3] professor não troca aluno de outro professor;
-- [4] choque de agenda continua barrado;
-- [5] vigência precisa ser futura;
-- [6] a cerca contra edição direta continua de pé (RPC antiga barrada).

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

grant execute on function pg_temp.assert_true(boolean, text) to public;

insert into public.tenants (id, name) values ('teacher-schedule-autonomy', 'Teacher Schedule Autonomy');

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000971', 'authenticated', 'authenticated', 'autonomy-teacher-1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professora Autonomia"}', now(), now()),
  ('00000000-0000-4000-8000-000000000972', 'authenticated', 'authenticated', 'autonomy-teacher-2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professor Outro"}', now(), now()),
  ('00000000-0000-4000-8000-000000000973', 'authenticated', 'authenticated', 'autonomy-student-1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Autonomia"}', now(), now()),
  ('00000000-0000-4000-8000-000000000974', 'authenticated', 'authenticated', 'autonomy-student-2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluna Vizinha"}', now(), now());

update public.profiles set tenant_id = 'teacher-schedule-autonomy', role = 'TEACHER', full_name = 'Professora Autonomia', lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-000000000971';
update public.profiles set tenant_id = 'teacher-schedule-autonomy', role = 'TEACHER', full_name = 'Professor Outro', lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-000000000972';
update public.profiles set tenant_id = 'teacher-schedule-autonomy', role = 'STUDENT', full_name = 'Aluno Autonomia', lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-000000000973';
update public.profiles set tenant_id = 'teacher-schedule-autonomy', role = 'STUDENT', full_name = 'Aluna Vizinha', lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-000000000974';

insert into public.dre_report_settings (tenant_id, destino, is_active)
values ('teacher-schedule-autonomy', '120363400000000971@g.us', true);

-- Disponibilidade só para o caso [6]: a RPC antiga exige a grade cadastrada e,
-- sem ela, recusaria por outro motivo antes de chegar à cerca.
insert into public.teacher_availability (teacher_id, tenant_id, day_of_week, start_time)
values ('00000000-0000-4000-8000-000000000971', 'teacher-schedule-autonomy', 5, '10:00');

insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, status)
values
  ('00000000-0000-4000-8000-00000000097a', 'teacher-schedule-autonomy', '00000000-0000-4000-8000-000000000971', '00000000-0000-4000-8000-000000000973', 'Segunda', '17:30', 'SCHEDULED'),
  ('00000000-0000-4000-8000-00000000097b', 'teacher-schedule-autonomy', '00000000-0000-4000-8000-000000000971', '00000000-0000-4000-8000-000000000973', 'Terça', '17:30', 'SCHEDULED'),
  ('00000000-0000-4000-8000-00000000097c', 'teacher-schedule-autonomy', '00000000-0000-4000-8000-000000000971', '00000000-0000-4000-8000-000000000973', 'Quinta', '17:30', 'SCHEDULED'),
  ('00000000-0000-4000-8000-00000000097d', 'teacher-schedule-autonomy', '00000000-0000-4000-8000-000000000971', '00000000-0000-4000-8000-000000000974', 'Quarta', '09:30', 'SCHEDULED');

-- Regressão: aula materializada da matrícula mantém a origem, mas pode mudar
-- pela porta auditada. Identidades/oferta/reservas existem só até ROLLBACK.
insert into public.offers(id,kind,tenant_id,payload,metadata,expires_at,created_by)
values ('00000000-0000-4000-8000-000000000980','ENROLLMENT','teacher-schedule-autonomy',
  '{}','{"test_fixture":true}',now()+interval '1 day','00000000-0000-4000-8000-000000000971');
insert into private.enrollment_offer_schedule_slots
  (id,offer_id,tenant_id,slot_index,teacher_id,day_of_week,day_name,class_time,start_date,
   status,reserved_by,reserved_at,materialized_booking_id)
values ('00000000-0000-4000-8000-000000000981','00000000-0000-4000-8000-000000000980',
  'teacher-schedule-autonomy',1,'00000000-0000-4000-8000-000000000971',1,'Segunda','17:30',
  (now() at time zone 'America/Sao_Paulo')::date - 14,'MATERIALIZED',
  '00000000-0000-4000-8000-000000000973',now(),'00000000-0000-4000-8000-00000000097a');
update public.bookings set start_date=(now() at time zone 'America/Sao_Paulo')::date - 14,
  enrollment_offer_id='00000000-0000-4000-8000-000000000980',
  enrollment_offer_slot_id='00000000-0000-4000-8000-000000000981'
where id='00000000-0000-4000-8000-00000000097a';

-- [1] A professora move segunda e terça para 09:30.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';
select pg_temp.assert_true(
  (public.teacher_apply_student_schedule_change(
    '00000000-0000-4000-8000-000000000973',
    '[{"booking_id":"00000000-0000-4000-8000-00000000097a","new_day":"Segunda","new_time":"09:30"},
      {"booking_id":"00000000-0000-4000-8000-00000000097b","new_day":"Terça","new_time":"09:30"}]'::jsonb,
    (now() at time zone 'America/Sao_Paulo')::date + 1,
    'Aluno pediu para estudar de manhã') ->> 'changed')::int = 2,
  'a troca da professora não foi aplicada nas duas aulas');
reset role;

select pg_temp.assert_true(
  (select count(*) = 2 from public.bookings
    where id in ('00000000-0000-4000-8000-00000000097a', '00000000-0000-4000-8000-00000000097b')
      and time_slot = '09:30'),
  'agenda não ficou em 09:30');
select pg_temp.assert_true(
  (select public.booking_schedule_on_date('00000000-0000-4000-8000-00000000097a',
     (now() at time zone 'America/Sao_Paulo')::date - 7) ->> 'time_slot') = '17:30',
  'data passada perdeu o horário antigo (aula já dada mudaria de lugar)');
select pg_temp.assert_true(
  (select count(*) = 2 from public.schedule_change_requests
    where student_id = '00000000-0000-4000-8000-000000000973' and status = 'APPLIED'
      and history @> '[{"action":"TEACHER_APPLIED"}]'::jsonb),
  'troca sem trilha em schedule_change_requests');
select pg_temp.assert_true(
  (select count(*) = 2 from public.audit_logs
    where action = 'booking_schedule_changed'
      and resource_id in ('00000000-0000-4000-8000-00000000097a', '00000000-0000-4000-8000-00000000097b')),
  'troca sem auditoria');

-- A origem comercial permanece intacta; updates sem mudança continuam válidos.
select pg_temp.assert_true(
  exists(select 1 from public.bookings where id='00000000-0000-4000-8000-00000000097a'
    and enrollment_offer_slot_id='00000000-0000-4000-8000-000000000981')
  and exists(select 1 from private.enrollment_offer_schedule_slots
    where id='00000000-0000-4000-8000-000000000981' and class_time='17:30' and status='MATERIALIZED'),
  'troca apagou ou reescreveu a origem da matrícula');
update public.bookings set time_slot=time_slot where id='00000000-0000-4000-8000-00000000097a';
do $$ begin
  update public.bookings set time_slot='18:00' where id='00000000-0000-4000-8000-00000000097a';
  raise exception 'assertion failed: troca sem versão passou pela trava da matrícula';
exception when insufficient_privilege then
  if sqlerrm <> 'invalid_enrollment_booking_link'
    and sqlerrm <> 'A agenda possui vigência e histórico. Registre uma nova proposta para preservar as aulas anteriores.' then raise; end if;
end $$;

-- [2] Um único aviso, no grupo da Gestão, com o horário novo.
select pg_temp.assert_true(
  (select count(*) = 1 from public.notification_queue
    where tenant_id = 'teacher-schedule-autonomy' and notification_kind = 'SCHEDULE_CHANGE_GROUP'
      and student_phone = '120363400000000971@g.us' and status = 'pending'
      and message_body like '%09:30%' and message_body like '%Aluno Autonomia%'),
  'aviso da troca não foi enfileirado para o grupo da Gestão');

-- [3] Outro professor não mexe no aluno dela.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000972","role":"authenticated"}';
do $$ begin
  perform public.teacher_apply_student_schedule_change(
    '00000000-0000-4000-8000-000000000973',
    '[{"booking_id":"00000000-0000-4000-8000-00000000097c","new_day":"Quinta","new_time":"10:00"}]'::jsonb,
    (now() at time zone 'America/Sao_Paulo')::date + 1, 'Tentativa de outro professor');
  raise exception 'assertion failed: professor trocou aluno de outro professor';
exception when insufficient_privilege then null;
end $$;
reset role;

-- [4] Choque: quarta 09:30 já é da aluna vizinha com a mesma professora.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';
do $$ begin
  perform public.teacher_apply_student_schedule_change(
    '00000000-0000-4000-8000-000000000973',
    '[{"booking_id":"00000000-0000-4000-8000-00000000097c","new_day":"Quarta","new_time":"09:30"}]'::jsonb,
    (now() at time zone 'America/Sao_Paulo')::date + 1, 'Tentativa com choque de agenda');
  raise exception 'assertion failed: choque de agenda foi aceito';
exception when exclusion_violation then null;
end $$;

-- [5] Vigência precisa ser futura.
do $$ begin
  perform public.teacher_apply_student_schedule_change(
    '00000000-0000-4000-8000-000000000973',
    '[{"booking_id":"00000000-0000-4000-8000-00000000097c","new_day":"Quinta","new_time":"10:00"}]'::jsonb,
    (now() at time zone 'America/Sao_Paulo')::date, 'Tentativa com vigência hoje');
  raise exception 'assertion failed: vigência no passado/hoje foi aceita';
exception when invalid_parameter_value then null;
end $$;

-- [6] A RPC antiga continua barrada para o professor (a cerca não abriu).
do $$ begin
  perform public.change_booking_schedule('00000000-0000-4000-8000-00000000097c', 'Sexta', '10:00');
  raise exception 'assertion failed: professor alterou agenda pela RPC antiga';
exception when insufficient_privilege then null;
end $$;
reset role;

select pg_temp.assert_true(
  (select day_of_week = 'Quinta' and time_slot = '17:30' from public.bookings
    where id = '00000000-0000-4000-8000-00000000097c'),
  'aula recusada mudou mesmo assim');

set local request.jwt.claims = '{"role":"service_role"}';

-- [7] Direção usa a mesma porta numa agenda que JÁ tem histórico.
-- A identidade e todas as alterações existem somente nesta transação revertida.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000975', 'authenticated', 'authenticated',
  'autonomy-director@example.invalid', '{"provider":"email","providers":["email"]}',
  '{"full_name":"Direção Teste","test_fixture":true}', now(), now());
update public.profiles set tenant_id = 'teacher-schedule-autonomy', role = 'SCHOOL_ADMIN',
  full_name = 'Direção Teste', lifecycle_status = 'active', is_test_account = true
where id = '00000000-0000-4000-8000-000000000975';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000975","role":"authenticated"}';
do $$ begin
  perform public.change_booking_schedule('00000000-0000-4000-8000-00000000097a', 'Sexta', '10:00');
  raise exception 'assertion failed: RPC antiga reescreveu agenda com histórico';
exception when insufficient_privilege then null;
end $$;
reset role;
insert into private.enrollment_offer_schedule_slots
  (id,offer_id,tenant_id,slot_index,teacher_id,day_of_week,day_name,class_time,start_date,
   status,reserved_by,reserved_at,reservation_expires_at)
values ('00000000-0000-4000-8000-000000000982','00000000-0000-4000-8000-000000000980',
  'teacher-schedule-autonomy',2,'00000000-0000-4000-8000-000000000971',1,'Segunda','16:30',
  (now() at time zone 'America/Sao_Paulo')::date + 2,'RESERVED',
  '00000000-0000-4000-8000-000000000974',now(),now()+interval '1 hour');
set local role authenticated;
do $$ begin
  perform public.teacher_apply_student_schedule_change(
    '00000000-0000-4000-8000-000000000973',
    '[{"booking_id":"00000000-0000-4000-8000-00000000097a","new_day":"Segunda","new_time":"16:30"}]',
    (now() at time zone 'America/Sao_Paulo')::date + 2, 'solicitação do aluno para escola');
  raise exception 'assertion failed: troca ocupou reserva de matrícula viva';
exception when exclusion_violation then
  if sqlerrm <> 'booking_conflicts_with_enrollment_reservation' then raise; end if;
end $$;
reset role;
update private.enrollment_offer_schedule_slots set status='RELEASED'
where id='00000000-0000-4000-8000-000000000982';
set local role authenticated;
select pg_temp.assert_true(
  (public.teacher_apply_student_schedule_change(
    '00000000-0000-4000-8000-000000000973',
    '[{"booking_id":"00000000-0000-4000-8000-00000000097a","new_day":"Segunda","new_time":"16:30"}]'::jsonb,
    (now() at time zone 'America/Sao_Paulo')::date + 2,
    'Horário combinado pela direção') ->> 'changed')::int = 1,
  'direção não conseguiu trocar agenda com histórico para 16:30');
reset role;
select pg_temp.assert_true(
  public.booking_schedule_on_date('00000000-0000-4000-8000-00000000097a',
    (now() at time zone 'America/Sao_Paulo')::date - 7)->>'time_slot' = '17:30'
  and public.booking_schedule_on_date('00000000-0000-4000-8000-00000000097a',
    (now() at time zone 'America/Sao_Paulo')::date + 1)->>'time_slot' = '09:30'
  and public.booking_schedule_on_date('00000000-0000-4000-8000-00000000097a',
    (now() at time zone 'America/Sao_Paulo')::date + 2)->>'time_slot' = '16:30',
  'direção perdeu a vigência de uma das três versões');
select pg_temp.assert_true(
  exists(select 1 from public.schedule_change_requests where booking_id='00000000-0000-4000-8000-00000000097a'
    and new_time='16:30' and initiated_by='SCHOOL' and status='APPLIED'
    and reviewed_by='00000000-0000-4000-8000-000000000975'),
  'troca da direção não foi registrada em nome da escola');

set local request.jwt.claims = '{"role":"service_role"}';

-- [8] Diretor de outra escola não alcança a agenda.
insert into public.tenants(id,name) values ('director-schedule-other', 'Outra Escola Teste');
update public.profiles set tenant_id='director-schedule-other'
where id='00000000-0000-4000-8000-000000000975';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000975","role":"authenticated"}';
do $$ begin
  perform public.teacher_apply_student_schedule_change(
    '00000000-0000-4000-8000-000000000973',
    '[{"booking_id":"00000000-0000-4000-8000-00000000097c","new_day":"Quinta","new_time":"16:30"}]'::jsonb,
    (now() at time zone 'America/Sao_Paulo')::date + 2, 'Direção de outra escola');
  raise exception 'assertion failed: diretor alterou agenda de outra escola';
exception when insufficient_privilege then null;
end $$;
reset role;

rollback;
