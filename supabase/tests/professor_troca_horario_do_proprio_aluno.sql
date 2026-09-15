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

rollback;
