-- Professor troca somente o dia/horário de um aluno próprio. A função precisa
-- validar disponibilidade/conflito, auditar e enfileirar o aviso ao grupo.

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
do $$
begin
  if to_regprocedure('pg_temp.assert_sqlstate(text, text, text)') is not null then
    execute 'grant execute on function pg_temp.assert_sqlstate(text, text, text) to public';
  end if;
end
$$;

insert into public.tenants (id, name)
values ('schedule-change-school', 'Schedule Change School');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-000000000951', 'authenticated', 'authenticated', 'schedule-teacher-1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professora Agenda"}', now(), now()),
  ('00000000-0000-4000-8000-000000000952', 'authenticated', 'authenticated', 'schedule-teacher-2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professor Vizinho"}', now(), now()),
  ('00000000-0000-4000-8000-000000000953', 'authenticated', 'authenticated', 'schedule-student-1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Agenda"}', now(), now()),
  ('00000000-0000-4000-8000-000000000954', 'authenticated', 'authenticated', 'schedule-student-2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Vizinho"}', now(), now()),
  ('00000000-0000-4000-8000-000000000955', 'authenticated', 'authenticated', 'schedule-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora Agenda"}', now(), now());

update public.profiles set tenant_id='schedule-change-school', role='TEACHER', full_name='Professora Agenda'
 where id='00000000-0000-4000-8000-000000000951';
update public.profiles set tenant_id='schedule-change-school', role='TEACHER', full_name='Professor Vizinho'
 where id='00000000-0000-4000-8000-000000000952';
update public.profiles set tenant_id='schedule-change-school', role='STUDENT', full_name='Aluno Agenda'
 where id='00000000-0000-4000-8000-000000000953';
update public.profiles set tenant_id='schedule-change-school', role='STUDENT', full_name='Aluno Vizinho'
 where id='00000000-0000-4000-8000-000000000954';
update public.profiles
   set tenant_id='schedule-change-school', role='SCHOOL_ADMIN', full_name='Diretora Agenda',
       teachers_group_id='120363400000000951@g.us', whatsapp_instance='wise-wolf-test'
 where id='00000000-0000-4000-8000-000000000955';

insert into public.teacher_availability (teacher_id, tenant_id, day_of_week, start_time)
values
  ('00000000-0000-4000-8000-000000000951', 'schedule-change-school', 1, '08:00'),
  ('00000000-0000-4000-8000-000000000951', 'schedule-change-school', 2, '09:00'),
  ('00000000-0000-4000-8000-000000000951', 'schedule-change-school', 3, '10:00'),
  ('00000000-0000-4000-8000-000000000952', 'schedule-change-school', 4, '11:00'),
  ('00000000-0000-4000-8000-000000000952', 'schedule-change-school', 5, '11:30');

insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, status)
values
  ('00000000-0000-4000-8000-00000000095a', 'schedule-change-school', '00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000953', 'Segunda', '08:00', 'SCHEDULED'),
  ('00000000-0000-4000-8000-00000000095b', 'schedule-change-school', '00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000954', 'Quarta', '10:00', 'SCHEDULED'),
  ('00000000-0000-4000-8000-00000000095c', 'schedule-change-school', '00000000-0000-4000-8000-000000000952', '00000000-0000-4000-8000-000000000954', 'Quinta', '11:00', 'SCHEDULED');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000951","role":"authenticated"}';

select public.change_booking_schedule(
  '00000000-0000-4000-8000-00000000095a', 'Terça', '09:00'
);

reset role;
select pg_temp.assert_true(
  (select day_of_week='Terça' and time_slot='09:00' from public.bookings where id='00000000-0000-4000-8000-00000000095a'),
  'professor nao alterou booking proprio'
);
select pg_temp.assert_true(
  exists (select 1 from public.audit_logs where action='booking_schedule_changed' and resource_id='00000000-0000-4000-8000-00000000095a'),
  'auditoria da troca nao foi criada'
);
select pg_temp.assert_true(
  exists (
    select 1 from public.notification_queue
     where source_id='00000000-0000-4000-8000-00000000095a'
       and notification_kind='SCHEDULE_CHANGE_GROUP'
       and student_phone='120363400000000951@g.us'
       and status='pending'
  ),
  'aviso ao grupo configurado nao foi enfileirado'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000951","role":"authenticated"}';

do $$
begin
  perform public.change_booking_schedule('00000000-0000-4000-8000-00000000095c', 'Sexta', '11:30');
  raise exception 'assertion failed: professor alterou booking de outro professor';
exception when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.change_booking_schedule('00000000-0000-4000-8000-00000000095a', 'Quarta', '10:00');
  raise exception 'assertion failed: conflito de agenda do professor foi aceito';
exception when exclusion_violation then null;
end;
$$;

do $$
begin
  perform public.change_booking_schedule('00000000-0000-4000-8000-00000000095a', 'Sexta', '15:00');
  raise exception 'assertion failed: horario fora da disponibilidade foi aceito';
exception when check_violation then null;
end;
$$;

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000955","role":"authenticated"}';

select public.change_booking_schedule(
  '00000000-0000-4000-8000-00000000095c', 'Sexta', '11:30'
);

reset role;
select pg_temp.assert_true(
  (select day_of_week='Sexta' and time_slot='11:30' from public.bookings where id='00000000-0000-4000-8000-00000000095c'),
  'direcao nao conseguiu alterar booking do tenant'
);

rollback;
