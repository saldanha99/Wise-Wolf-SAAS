-- Agenda canonica e unicidade por ocorrencia, sem limitar um aluno a uma aula
-- por dia. Todos os dados de teste sao revertidos ao final.

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
values
  ('lesson-occurrence-school', 'Lesson Occurrence School'),
  ('lesson-occurrence-other', 'Lesson Occurrence Other School');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-000000000961', 'authenticated', 'authenticated', 'occurrence-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professor Ocorrencia"}', now(), now()),
  ('00000000-0000-4000-8000-000000000962', 'authenticated', 'authenticated', 'occurrence-student@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Ocorrencia"}', now(), now()),
  ('00000000-0000-4000-8000-000000000963', 'authenticated', 'authenticated', 'occurrence-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora Ocorrencia"}', now(), now()),
  ('00000000-0000-4000-8000-000000000964', 'authenticated', 'authenticated', 'occurrence-other-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora Outra Escola"}', now(), now()),
  ('00000000-0000-4000-8000-000000000965', 'authenticated', 'authenticated', 'occurrence-other-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professor Outra Escola"}', now(), now()),
  ('00000000-0000-4000-8000-000000000966', 'authenticated', 'authenticated', 'occurrence-other-student@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Outra Escola"}', now(), now()),
  ('00000000-0000-4000-8000-000000000967', 'authenticated', 'authenticated', 'occurrence-second-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Segundo Professor"}', now(), now());

update public.profiles
   set tenant_id='lesson-occurrence-school', role='TEACHER', full_name='Professor Ocorrencia'
 where id='00000000-0000-4000-8000-000000000961';
update public.profiles
   set tenant_id='lesson-occurrence-school', role='STUDENT', full_name='Aluno Ocorrencia'
 where id='00000000-0000-4000-8000-000000000962';
update public.profiles
   set tenant_id='lesson-occurrence-school', role='SCHOOL_ADMIN', full_name='Diretora Ocorrencia'
 where id='00000000-0000-4000-8000-000000000963';
update public.profiles
   set tenant_id='lesson-occurrence-other', role='SCHOOL_ADMIN', full_name='Diretora Outra Escola'
 where id='00000000-0000-4000-8000-000000000964';
update public.profiles
   set tenant_id='lesson-occurrence-other', role='TEACHER', full_name='Professor Outra Escola'
 where id='00000000-0000-4000-8000-000000000965';
update public.profiles
   set tenant_id='lesson-occurrence-other', role='STUDENT', full_name='Aluno Outra Escola'
 where id='00000000-0000-4000-8000-000000000966';
update public.profiles
   set tenant_id='lesson-occurrence-school', role='TEACHER', full_name='Segundo Professor'
 where id='00000000-0000-4000-8000-000000000967';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  ('00000000-0000-4000-8000-000000000961', 'lesson-occurrence-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000962', 'lesson-occurrence-school', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000963', 'lesson-occurrence-school', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000964', 'lesson-occurrence-other', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000965', 'lesson-occurrence-other', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000966', 'lesson-occurrence-other', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000967', 'lesson-occurrence-school', 'TEACHER', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('00000000-0000-4000-8000-000000000961', 'lesson-occurrence-school'),
  ('00000000-0000-4000-8000-000000000962', 'lesson-occurrence-school'),
  ('00000000-0000-4000-8000-000000000963', 'lesson-occurrence-school'),
  ('00000000-0000-4000-8000-000000000964', 'lesson-occurrence-other'),
  ('00000000-0000-4000-8000-000000000965', 'lesson-occurrence-other'),
  ('00000000-0000-4000-8000-000000000966', 'lesson-occurrence-other'),
  ('00000000-0000-4000-8000-000000000967', 'lesson-occurrence-school')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = pg_catalog.now();

-- Booking antigo cancelado e dois horarios atuais no mesmo dia.
insert into public.bookings (
  id, tenant_id, teacher_id, student_id, day_of_week, time_slot, status, start_date
)
values
  ('00000000-0000-4000-8000-00000000096a', 'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962', 'Terca', '16:30', 'CANCELLED', '2026-08-01'),
  ('00000000-0000-4000-8000-00000000096b', 'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962', 'Tuesday', '17:00', 'SCHEDULED', '2026-08-01'),
  ('00000000-0000-4000-8000-00000000096c', 'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962', 'Terça', '16:30', 'SCHEDULED', '2026-08-01'),
  ('00000000-0000-4000-8000-000000000970', 'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962', 'Terça', '18:00', 'SCHEDULED', '2026-08-01'),
  ('00000000-0000-4000-8000-000000000971', 'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962', 'Terça', '18:30', 'SCHEDULED', '2026-08-01'),
  ('00000000-0000-4000-8000-000000000972', 'lesson-occurrence-other', '00000000-0000-4000-8000-000000000965', '00000000-0000-4000-8000-000000000966', 'Terça', '09:00', 'SCHEDULED', '2026-08-01');

select pg_temp.assert_true(
  public.parse_lesson_date('2026-08-11') = '2026-08-11'::date
  and public.parse_lesson_date('11/08/2026') = '2026-08-11'::date
  and public.parse_lesson_date('Pendente') is null
  and public.parse_lesson_date('31/02/2026') is null,
  'parser de data aceitou Pendente/calendario invalido ou recusou formato legado'
);

select pg_temp.assert_true(
  not exists (
    select 1 from public.bookings
     where id in ('00000000-0000-4000-8000-00000000096a', '00000000-0000-4000-8000-00000000096b')
       and day_of_week <> 'Terça'
  ),
  'nomes de dia sem acento/ingles nao foram normalizados'
);

do $$
begin
  insert into public.bookings (
    tenant_id, teacher_id, student_id, day_of_week, time_slot, status
  ) values (
    'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961',
    '00000000-0000-4000-8000-000000000962', 'Terca-feira', '16:30', 'SCHEDULED'
  );
  raise exception 'assertion failed: duplicata ativa com outra grafia foi aceita';
exception when unique_violation then null;
end;
$$;

do $$
begin
  insert into public.bookings (
    tenant_id, teacher_id, student_id, day_of_week, time_slot, status
  ) values (
    'lesson-occurrence-school', '00000000-0000-4000-8000-000000000967',
    '00000000-0000-4000-8000-000000000962', 'Terça', '18:00', 'SCHEDULED'
  );
  raise exception 'assertion failed: aluno ocupou o mesmo slot com dois professores';
exception when unique_violation then null;
end;
$$;

do $$
begin
  insert into public.bookings (
    tenant_id, teacher_id, student_id, day_of_week, time_slot, status
  ) values (
    'lesson-occurrence-school', '00000000-0000-4000-8000-000000000967',
    '00000000-0000-4000-8000-000000000962', 'Quarta', '19:00', null
  );
  raise exception 'assertion failed: booking com status nulo foi aceito';
exception when not_null_violation then null;
end;
$$;

insert into public.class_logs (
  id, tenant_id, teacher_id, student_id, booking_id,
  presence, class_date
)
values
  ('00000000-0000-4000-8000-00000000096d', 'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962', '00000000-0000-4000-8000-00000000096c', 'COMPLETED', '2026-08-18'),
  ('00000000-0000-4000-8000-00000000096e', 'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962', '00000000-0000-4000-8000-00000000096b', 'COMPLETED', '2026-08-18');

select pg_temp.assert_true(
  (select start_time='16:30'::time from public.class_logs where id='00000000-0000-4000-8000-00000000096d')
  and
  (select start_time='17:00'::time from public.class_logs where id='00000000-0000-4000-8000-00000000096e'),
  'horario da ocorrencia nao foi copiado do booking'
);

select pg_temp.assert_true(
  (select count(*)=2 from public.class_logs
    where tenant_id='lesson-occurrence-school' and class_date='2026-08-18'),
  'dois horarios diferentes no mesmo dia nao foram aceitos'
);

-- Regressao Gabriel: informar uma hora falsa nao pode reabrir a mesma origem
-- nem escapar da identidade da ocorrencia.
do $$
begin
  insert into public.class_logs (
    tenant_id, teacher_id, student_id, booking_id,
    presence, class_date, start_time
  ) values (
    'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961',
    '00000000-0000-4000-8000-000000000962', '00000000-0000-4000-8000-00000000096c',
    'COMPLETED', '2026-08-18', '19:00'
  );
  raise exception 'assertion failed: hora falsa reabriu a ocorrencia do Gabriel';
exception when check_violation then null;
end;
$$;

do $$
begin
  insert into public.class_logs (
    tenant_id, teacher_id, student_id, booking_id, presence, class_date
  ) values (
    'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961',
    '00000000-0000-4000-8000-000000000962', '00000000-0000-4000-8000-000000000999',
    'COMPLETED', '2026-08-18'
  );
  raise exception 'assertion failed: origem nova sem horario foi aceita';
exception when check_violation then null;
end;
$$;

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'authenticated', 'public.normalize_booking_occurrence()', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated', 'public.fill_class_log_occurrence_time()', 'EXECUTE'
  ),
  'funcoes internas de trigger ficaram expostas como RPC'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000961","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select pg_catalog.jsonb_array_length(result -> 'classes') = 2
       and result -> 'classes' @> '[{"class_time":"16:30","origin_type":"BOOKING"}]'::jsonb
       and result -> 'classes' @> '[{"class_time":"17:00","origin_type":"BOOKING"}]'::jsonb
      from (select public.get_student_overview('00000000-0000-4000-8000-000000000962') result) q
  ),
  'Ficha 360 nao distinguiu as duas aulas pelos horarios'
);

reset role;

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'anon', 'public.get_student_overview(uuid)', 'EXECUTE'
  ),
  'anon recebeu EXECUTE na Ficha 360'
);

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';

select pg_temp.assert_true(
  public.get_student_overview('00000000-0000-4000-8000-000000000962') ->> 'error' = 'sem_permissao'
  and public.list_unlogged_confirmed_classes() ->> 'error' = 'sem_permissao',
  'authenticated sem identidade/perfil atravessou RPC privilegiada'
);

reset role;

insert into public.reschedules (
  id, tenant_id, teacher_id, student_id, original_booking_id,
  date, time, fault_type
) values (
  '00000000-0000-4000-8000-000000000975', 'lesson-occurrence-school',
  '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962',
  '00000000-0000-4000-8000-00000000096c', '2026-08-11', '18:30', 'STUDENT'
);

-- Appointment real: o horario/data/status sao derivados da linha autoritativa,
-- inclusive para registros antigos que so preencheram professor_id.
insert into public.appointments (
  id, professor_id, teacher_id, tenant_id, student_name, student_phone,
  start_time, status, type
) values (
  '00000000-0000-4000-8000-00000000097b',
  '00000000-0000-4000-8000-000000000961', null,
  'lesson-occurrence-school', 'Lead Appointment Real', '5500000000000',
  '2026-08-12 14:00:00-03', 'scheduled', 'experimental'
);

-- Appointment sintetico usado por TrialsToContracts quando a oportunidade
-- historica nao possui trial_appointment_id. O trigger deve aceitar apenas o
-- formato trial_<uuid> comprovado e gravar o slot proposto, nao a data/hora do
-- cliente.
insert into public.opportunities (
  id, student_name, student_phone, slots_proposed, status,
  winner_teacher_id, tenant_id, trial_appointment_id, trial_status, kind
) values (
  '00000000-0000-4000-8000-00000000097d',
  'Lead Appointment Sintetico', '5511111111111',
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'day', extract(dow from ((pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 1))::int,
    'date', pg_catalog.to_char((pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 1, 'YYYY-MM-DD'),
    'time', '15:15'
  )),
  'CLAIMED', '00000000-0000-4000-8000-000000000961',
  'lesson-occurrence-school', null, 'DONE', 'TRIAL'
);

insert into public.class_logs (
  id, tenant_id, teacher_id, student_id, appointment_id,
  presence, subtype, date, class_date
) values (
  '00000000-0000-4000-8000-00000000097f',
  'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961', null,
  'trial_00000000-0000-4000-8000-00000000097d',
  'COMPLETED', 'AULA EXPERIMENTAL',
  (pg_catalog.now() at time zone 'America/Sao_Paulo')::date,
  (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
);

select pg_temp.assert_true(
  (
    select start_time = '15:15'::time
       and class_date = (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 1
       and date = class_date
      from public.class_logs
     where id = '00000000-0000-4000-8000-00000000097f'
  ),
  'appointment sintetico nao recebeu data/hora autoritativas da oportunidade'
);

do $$
begin
  insert into public.class_logs (
    tenant_id, teacher_id, appointment_id, presence, subtype, date, class_date
  ) values (
    'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961',
    'trial_00000000-0000-4000-8000-000000000999',
    'COMPLETED', 'AULA EXPERIMENTAL', current_date, current_date
  );
  raise exception 'assertion failed: appointment sintetico sem oportunidade foi aceito';
exception when check_violation then null;
end;
$$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000961","role":"authenticated"}';

select pg_temp.assert_true(
  (result ->> 'inserted')::int = 4
  and (result ->> 'skipped')::int = 0,
  'lancador nao aceitou dois bookings, reposicao e appointment real validos'
)
from (
  select public.log_teacher_classes(
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ref', 'victor-1630', 'booking_id', '00000000-0000-4000-8000-00000000096c',
        'student_id', '00000000-0000-4000-8000-000000000962',
        'class_date', '2026-08-11', 'presence', 'COMPLETED'
      ),
      pg_catalog.jsonb_build_object(
        'ref', 'victor-1700', 'booking_id', '00000000-0000-4000-8000-00000000096b',
        'student_id', '00000000-0000-4000-8000-000000000962',
        'class_date', '2026-08-11', 'presence', 'COMPLETED'
      ),
      pg_catalog.jsonb_build_object(
        'ref', 'victor-1830', 'reschedule_id', '00000000-0000-4000-8000-000000000975',
        'student_id', '00000000-0000-4000-8000-000000000962',
        'class_date', '2026-08-11', 'presence', 'COMPLETED'
      ),
      pg_catalog.jsonb_build_object(
        'ref', 'trial-real', 'appointment_id', '00000000-0000-4000-8000-00000000097b',
        'class_date', '2026-08-12', 'presence', 'COMPLETED'
      )
    )
  ) result
) q;

select pg_temp.assert_true(
  (select count(*) = 3
     from public.class_logs
    where tenant_id = 'lesson-occurrence-school'
      and teacher_id = '00000000-0000-4000-8000-000000000961'
      and student_id = '00000000-0000-4000-8000-000000000962'
      and class_date = '2026-08-11'
      and start_time in ('16:30'::time, '17:00'::time, '18:30'::time))
  and (select used_at is not null from public.reschedules
        where id = '00000000-0000-4000-8000-000000000975'),
  'lancador nao persistiu a identidade completa das tres ocorrencias'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.class_logs
     where tenant_id = 'lesson-occurrence-school'
       and appointment_id = '00000000-0000-4000-8000-00000000097b'
       and student_id is null
       and class_date = '2026-08-12'
       and start_time = '14:00'::time
       and subtype = 'AULA EXPERIMENTAL'
  ),
  'appointment real nao foi vinculado a status/data/hora autoritativos'
);

select pg_temp.assert_true(
  (result ->> 'inserted')::int = 0
  and (result ->> 'skipped')::int = 3,
  'reenvio do mesmo lote nao foi idempotente'
)
from (
  select public.log_teacher_classes(
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('booking_id', '00000000-0000-4000-8000-00000000096c', 'class_date', '2026-08-11'),
      pg_catalog.jsonb_build_object('booking_id', '00000000-0000-4000-8000-00000000096b', 'class_date', '2026-08-11'),
      pg_catalog.jsonb_build_object('reschedule_id', '00000000-0000-4000-8000-000000000975', 'class_date', '2026-08-11')
    )
  ) result
) q;

reset role;

insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name,
  class_date, class_time, teacher_name, token,
  student_response, status, source_id, source_type
)
values
  (
    '00000000-0000-4000-8000-00000000096f', 'lesson-occurrence-school',
    '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962',
    'Aluno Ocorrencia', '2026-08-18', '16:30', 'Professor Ocorrencia',
    'lesson-occurrence-token-duplicate', 'STUDENT_SELF_ABSENT', 'AWAITING_TEACHER',
    '00000000-0000-4000-8000-000000000971', 'booking'
  ),
  (
    '00000000-0000-4000-8000-000000000976', 'lesson-occurrence-school',
    '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962',
    'Aluno Ocorrencia', '2026-08-04', '18:00', 'Professor Ocorrencia',
    'lesson-occurrence-token-null-response', null, 'AWAITING_TEACHER',
    '00000000-0000-4000-8000-000000000970', 'booking'
  ),
  (
    '00000000-0000-4000-8000-000000000977', 'lesson-occurrence-school',
    '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962',
    'Aluno Ocorrencia', '2026-07-28', '18:00', 'Professor Ocorrencia',
    'lesson-occurrence-token-status', 'STUDENT_PRESENT', 'PENDING',
    '00000000-0000-4000-8000-000000000970', 'booking'
  ),
  (
    '00000000-0000-4000-8000-000000000978', 'lesson-occurrence-school',
    '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962',
    'Aluno Ocorrencia', '2026-08-18', '09:00', 'Professor Ocorrencia',
    'lesson-occurrence-token-cross-origin', 'STUDENT_PRESENT', 'AWAITING_TEACHER',
    '00000000-0000-4000-8000-000000000972', 'booking'
  ),
  (
    '00000000-0000-4000-8000-000000000979', 'lesson-occurrence-school',
    '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962',
    'Aluno Ocorrencia', '2026-08-18', '18:00', 'Professor Ocorrencia',
    'lesson-occurrence-token-paid', 'STUDENT_PRESENT', 'AWAITING_TEACHER',
    '00000000-0000-4000-8000-000000000970', 'booking'
  ),
  (
    '00000000-0000-4000-8000-00000000097a', 'lesson-occurrence-school',
    '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000962',
    'Aluno Ocorrencia', '2026-07-21', '18:00', 'Professor Ocorrencia',
    'lesson-occurrence-token-unpaid', 'STUDENT_PRESENT', 'AWAITING_TEACHER',
    '00000000-0000-4000-8000-000000000970', 'booking'
  );

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000963","role":"authenticated"}';

select pg_temp.assert_true(
  (public.settle_confirmed_class('00000000-0000-4000-8000-00000000096f', true) ->> 'duplicate_occurrence')::boolean,
  'direcao nao reconheceu a mesma ocorrencia vinda de outro booking'
);

reset role;

select pg_temp.assert_true(
  (select count(*)=2 from public.class_logs
    where tenant_id='lesson-occurrence-school' and class_date='2026-08-18')
  and
  (select status='RESOLVED_UNPAID' from public.attendance_confirmations
    where id='00000000-0000-4000-8000-00000000096f'),
  'regularizacao da direcao criou ou manteve uma duplicata pagavel'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000999","role":"authenticated"}';

select pg_temp.assert_true(
  public.settle_confirmed_class('00000000-0000-4000-8000-000000000979', true) ->> 'error' = 'sem_permissao',
  'authenticated sem profile atravessou a liquidacao privilegiada'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000964","role":"authenticated"}';

select pg_temp.assert_true(
  public.settle_confirmed_class('00000000-0000-4000-8000-000000000979', true) ->> 'error' = 'nao_encontrado'
  and (public.list_unlogged_confirmed_classes() ->> 'total')::int = 0,
  'diretora de outro tenant enxergou ou liquidou confirmacao alheia'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000963","role":"authenticated"}';

select pg_temp.assert_true(
  public.settle_confirmed_class('00000000-0000-4000-8000-000000000976', null) ->> 'error' = 'decisao_obrigatoria'
  and public.settle_confirmed_class('00000000-0000-4000-8000-000000000976', true) ->> 'error' = 'resposta_do_aluno_nao_permite'
  and public.settle_confirmed_class('00000000-0000-4000-8000-000000000977', true) ->> 'error' = 'status_invalido'
  and public.settle_confirmed_class('00000000-0000-4000-8000-000000000978', true) ->> 'error' = 'origem_invalida',
  'NULL/status/origem malformada nao foram recusados antes da escrita'
);

select pg_temp.assert_true(
  coalesce((public.settle_confirmed_class('00000000-0000-4000-8000-00000000097a', false) ->> 'paid')::boolean, false) = false,
  'decisao de nao pagar nao foi respeitada'
);

select pg_temp.assert_true(
  coalesce((result ->> 'paid')::boolean, false)
  and result ->> 'presence' = 'COMPLETED',
  'liquidacao valida nao criou a aula paga'
)
from (
  select public.settle_confirmed_class(
    '00000000-0000-4000-8000-000000000979', true
  ) result
) q;

select pg_temp.assert_true(
  (select status = 'RESOLVED_PAID' and class_log_id is not null
     from public.attendance_confirmations
    where id = '00000000-0000-4000-8000-000000000979')
  and (select count(*) = 1
         from public.class_logs
        where tenant_id = 'lesson-occurrence-school'
          and booking_id = '00000000-0000-4000-8000-000000000970'
          and class_date = '2026-08-18'
          and start_time = '18:00'::time),
  'liquidacao paga nao vinculou status/log/horario de forma consistente'
);

select pg_temp.assert_true(
  coalesce((public.settle_confirmed_class(
    '00000000-0000-4000-8000-000000000979', true
  ) ->> 'already')::boolean, false)
  and (select count(*) = 1
         from public.class_logs
        where tenant_id = 'lesson-occurrence-school'
          and booking_id = '00000000-0000-4000-8000-000000000970'
          and class_date = '2026-08-18'),
  'segunda decisao sobre a mesma confirmacao nao foi idempotente'
);

reset role;

do $$
begin
  insert into public.class_logs (
    tenant_id, teacher_id, student_id, booking_id,
    presence, class_date
  ) values (
    'lesson-occurrence-school', '00000000-0000-4000-8000-000000000961',
    '00000000-0000-4000-8000-000000000962', '00000000-0000-4000-8000-00000000096c',
    'COMPLETED', '2026-08-18'
  );
  raise exception 'assertion failed: mesma ocorrencia com booking recriado foi aceita';
exception when unique_violation then null;
end;
$$;

rollback;
