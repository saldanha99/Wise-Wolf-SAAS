-- Regressao: professor nao reclassifica reposicao de falta do aluno como paga.
-- Todos os fixtures ficam dentro da transacao e sao revertidos ao final.

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

insert into public.tenants (id, name)
values ('reschedule-authority-school', 'Reschedule Authority School');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    'a1000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated',
    'reschedule-authority-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Professor Autoridade"}', now(), now()
  ),
  (
    'a1000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated',
    'reschedule-authority-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Aluno Autoridade"}', now(), now()
  ),
  (
    'a1000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated',
    'reschedule-authority-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Diretora Autoridade"}', now(), now()
  );

update public.profiles
   set tenant_id = 'reschedule-authority-school',
       role = 'TEACHER',
       lifecycle_status = 'active',
       full_name = 'Professor Autoridade'
 where id = 'a1000000-0000-4000-8000-000000000001';

update public.profiles
   set tenant_id = 'reschedule-authority-school',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Aluno Autoridade'
 where id = 'a1000000-0000-4000-8000-000000000002';

update public.profiles
   set tenant_id = 'reschedule-authority-school',
       role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active',
       full_name = 'Diretora Autoridade'
 where id = 'a1000000-0000-4000-8000-000000000003';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  (
    'a1000000-0000-4000-8000-000000000001',
    'reschedule-authority-school', 'TEACHER', 'ACTIVE', true
  ),
  (
    'a1000000-0000-4000-8000-000000000002',
    'reschedule-authority-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    'a1000000-0000-4000-8000-000000000003',
    'reschedule-authority-school', 'SCHOOL_ADMIN', 'ACTIVE', true
  )
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  (
    'a1000000-0000-4000-8000-000000000001',
    'reschedule-authority-school'
  ),
  (
    'a1000000-0000-4000-8000-000000000002',
    'reschedule-authority-school'
  ),
  (
    'a1000000-0000-4000-8000-000000000003',
    'reschedule-authority-school'
  )
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = pg_catalog.now();

-- Dois bookings distintos: so o segundo possui falta do professor comprovada.
insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
values
  (
    'a2000000-0000-4000-8000-000000000001',
    'reschedule-authority-school',
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    case extract(dow from (
      (now() at time zone 'America/Sao_Paulo')::date - 2
    ))::integer
      when 0 then 'Domingo' when 1 then 'Segunda' when 2 then 'Terça'
      when 3 then 'Quarta' when 4 then 'Quinta' when 5 then 'Sexta'
      when 6 then 'Sábado'
    end,
    '08:00', 'SCHEDULED',
    (now() at time zone 'America/Sao_Paulo')::date - 30
  ),
  (
    'a2000000-0000-4000-8000-000000000002',
    'reschedule-authority-school',
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    case extract(dow from (
      (now() at time zone 'America/Sao_Paulo')::date - 2
    ))::integer
      when 0 then 'Domingo' when 1 then 'Segunda' when 2 then 'Terça'
      when 3 then 'Quarta' when 4 then 'Quinta' when 5 then 'Sexta'
      when 6 then 'Sábado'
    end,
    '08:30', 'SCHEDULED',
    (now() at time zone 'America/Sao_Paulo')::date - 30
  );

insert into public.class_logs (
  id, tenant_id, teacher_id, student_id, booking_id,
  presence, date, class_date
)
values (
  'a3000000-0000-4000-8000-000000000001',
  'reschedule-authority-school',
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'a2000000-0000-4000-8000-000000000002',
  'TEACHER_ABSENCE',
  (now() at time zone 'America/Sao_Paulo')::date - 2,
  (now() at time zone 'America/Sao_Paulo')::date - 2
);

insert into public.reschedules (
  id, tenant_id, teacher_id, student_id, original_booking_id,
  date, time, fault_type
)
values
  (
    'a4000000-0000-4000-8000-000000000001',
    'reschedule-authority-school',
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    null,
    pg_catalog.to_char(
      (now() at time zone 'America/Sao_Paulo')::date - 1,
      'YYYY-MM-DD'
    ),
    '12:00', 'STUDENT'
  ),
  (
    'a4000000-0000-4000-8000-000000000002',
    'reschedule-authority-school',
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    'a2000000-0000-4000-8000-000000000001',
    pg_catalog.to_char(
      (now() at time zone 'America/Sao_Paulo')::date - 1,
      'YYYY-MM-DD'
    ),
    '10:00', 'TEACHER'
  ),
  (
    'a4000000-0000-4000-8000-000000000003',
    'reschedule-authority-school',
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    'a2000000-0000-4000-8000-000000000002',
    pg_catalog.to_char(
      (now() at time zone 'America/Sao_Paulo')::date - 1,
      'YYYY-MM-DD'
    ),
    '11:00', 'TEACHER'
  ),
  (
    'a4000000-0000-4000-8000-000000000004',
    'reschedule-authority-school',
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    null,
    pg_catalog.to_char(
      (now() at time zone 'America/Sao_Paulo')::date - 1,
      'YYYY-MM-DD'
    ),
    '12:00', 'STUDENT'
  ),
  (
    'a4000000-0000-4000-8000-000000000005',
    'reschedule-authority-school',
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    null,
    'Pendente',
    'Pendente', 'STUDENT'
  );

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'reschedules'
       and policyname = 'reschedules_select'
       and cmd = 'SELECT'
  )
  and exists (
    select 1
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'reschedules'
       and policyname = 'reschedules_admin_write'
       and cmd = 'ALL'
  )
  and not exists (
    select 1
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'reschedules'
       and cmd <> 'SELECT'
       and policyname <> 'reschedules_admin_write'
  ),
  'reschedules ainda possui escrita ampla ou perdeu a leitura existente'
);

select pg_temp.assert_true(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.schedule_reschedule(uuid,date,time without time zone)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.schedule_reschedule(uuid,date,time without time zone)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'private.teacher_reschedule_financial_origin_is_proven(uuid,text,uuid,uuid)',
    'EXECUTE'
  ),
  'privilegios das RPCs de reposicao ficaram amplos'
);

select pg_temp.assert_true(
  (
    select procedure.proargnames = array[
      'p_reschedule_id', 'p_date', 'p_time'
    ]::text[]
      from pg_catalog.pg_proc as procedure
     where procedure.oid = pg_catalog.to_regprocedure(
       'public.schedule_reschedule(uuid,date,time without time zone)'
     )
  ),
  'RPC de agenda aceita identidade ou origem financeira como parametro'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) = 5 from public.reschedules),
  'professor perdeu a leitura das proprias reposicoes'
);

do $teacher_cannot_reclassify$
declare
  affected integer;
begin
  update public.reschedules
     set fault_type = 'TEACHER'
   where id = 'a4000000-0000-4000-8000-000000000001';
  get diagnostics affected = row_count;
  perform pg_temp.assert_true(
    affected = 0,
    'professor ainda consegue reclassificar fault_type'
  );
end;
$teacher_cannot_reclassify$;

do $teacher_cannot_create$
begin
  insert into public.reschedules (
    tenant_id, teacher_id, student_id, date, time, fault_type
  ) values (
    'reschedule-authority-school',
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    'Pendente', 'Pendente', 'TEACHER'
  );
  raise exception 'assertion failed: professor criou reposicao arbitraria';
exception
  when insufficient_privilege then null;
end;
$teacher_cannot_create$;

do $teacher_cannot_schedule_in_the_past$
begin
  perform public.schedule_reschedule(
    'a4000000-0000-4000-8000-000000000001',
    (now() at time zone 'America/Sao_Paulo')::date - 1,
    '09:00'::time
  );
  raise exception 'assertion failed: professor agendou reposicao retroativa';
exception
  when sqlstate '22023' then null;
end;
$teacher_cannot_schedule_in_the_past$;

select pg_temp.assert_true(
  public.schedule_reschedule(
    'a4000000-0000-4000-8000-000000000005',
    (now() at time zone 'America/Sao_Paulo')::date + 2,
    '09:00'::time
  ) @> pg_catalog.jsonb_build_object(
    'id', 'a4000000-0000-4000-8000-000000000005'::uuid,
    'date', pg_catalog.to_char(
      (now() at time zone 'America/Sao_Paulo')::date + 2,
      'YYYY-MM-DD'
    ),
    'time', '09:00'
  ),
  'RPC estreita nao agendou horario futuro do credito existente'
);

select pg_temp.assert_true(
  (
    select fault_type = 'STUDENT'
       and teacher_id = 'a1000000-0000-4000-8000-000000000001'
       and student_id = 'a1000000-0000-4000-8000-000000000002'
       and original_booking_id is null
      from public.reschedules
     where id = 'a4000000-0000-4000-8000-000000000005'
  ),
  'RPC estreita alterou origem ou participantes da reposicao'
);

select pg_temp.assert_true(
  (
    select fault_type = 'STUDENT'
       and teacher_id = 'a1000000-0000-4000-8000-000000000001'
       and student_id = 'a1000000-0000-4000-8000-000000000002'
       and original_booking_id is null
      from public.reschedules
     where id = 'a4000000-0000-4000-8000-000000000001'
  ),
  'reposicao de falta do aluno foi reclassificada'
);

select pg_temp.assert_true(
  (result ->> 'inserted')::integer = 2
  and (result ->> 'skipped')::integer = 1
  and result -> 'entries' @> '[{
    "ref":"student-fault",
    "status":"lancada",
    "subtype":"REPOSIÇÃO"
  }]'::jsonb
  and result -> 'entries' @> '[{
    "ref":"unproven-teacher-fault",
    "status":"ignorada",
    "reason":"reposicao_professor_sem_origem_comprovada"
  }]'::jsonb
  and result -> 'entries' @> '[{
    "ref":"proven-teacher-fault",
    "status":"lancada",
    "subtype":"REPOSIÇÃO_PROF"
  }]'::jsonb,
  'lancador nao separou reposicao paga por prova autoritativa'
)
from (
  select public.log_teacher_classes(
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ref', 'student-fault',
        'reschedule_id', 'a4000000-0000-4000-8000-000000000001',
        'class_date', pg_catalog.to_char(
          (now() at time zone 'America/Sao_Paulo')::date - 1,
          'YYYY-MM-DD'
        ),
        'presence', 'COMPLETED'
      ),
      pg_catalog.jsonb_build_object(
        'ref', 'unproven-teacher-fault',
        'reschedule_id', 'a4000000-0000-4000-8000-000000000002',
        'class_date', pg_catalog.to_char(
          (now() at time zone 'America/Sao_Paulo')::date - 1,
          'YYYY-MM-DD'
        ),
        'presence', 'COMPLETED'
      ),
      pg_catalog.jsonb_build_object(
        'ref', 'proven-teacher-fault',
        'reschedule_id', 'a4000000-0000-4000-8000-000000000003',
        'class_date', pg_catalog.to_char(
          (now() at time zone 'America/Sao_Paulo')::date - 1,
          'YYYY-MM-DD'
        ),
        'presence', 'COMPLETED'
      )
    )
  ) as result
) as logged;

reset role;

select pg_temp.assert_true(
  (select subtype = 'REPOSIÇÃO'
     from public.class_logs
    where reschedule_id = 'a4000000-0000-4000-8000-000000000001')
  and not exists (
    select 1
      from public.class_logs
     where reschedule_id = 'a4000000-0000-4000-8000-000000000002'
  )
  and (select subtype = 'REPOSIÇÃO_PROF'
     from public.class_logs
    where reschedule_id = 'a4000000-0000-4000-8000-000000000003'),
  'class_logs persistiu classificacao financeira incorreta'
);

-- Lifecycle: um aluno suspenso nao pode receber novo horario nem ter o credito
-- consumido silenciosamente por um lancamento tardio.
update public.tenant_memberships
   set status = 'SUSPENDED'
 where user_id = 'a1000000-0000-4000-8000-000000000002'
   and tenant_id = 'reschedule-authority-school';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

do $inactive_student_cannot_be_scheduled$
begin
  perform public.schedule_reschedule(
    'a4000000-0000-4000-8000-000000000004',
    (now() at time zone 'America/Sao_Paulo')::date + 3,
    '12:30'::time
  );
  raise exception 'assertion failed: reposicao de aluno inativo foi agendada';
exception
  when sqlstate '55000' then null;
end;
$inactive_student_cannot_be_scheduled$;

select pg_temp.assert_true(
  (result ->> 'inserted')::integer = 0
  and (result ->> 'skipped')::integer = 1
  and result -> 'entries' @> '[{
    "status":"ignorada",
    "reason":"participante_inativo"
  }]'::jsonb,
  'lancador consumiu reposicao pendente/inativa sem slot valido'
)
from (
  select public.log_teacher_classes(
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'reschedule_id', 'a4000000-0000-4000-8000-000000000004',
        'class_date', pg_catalog.to_char(
          (now() at time zone 'America/Sao_Paulo')::date - 1,
          'YYYY-MM-DD'
        ),
        'presence', 'COMPLETED'
      )
    )
  ) as result
) as inactive_log;

reset role;

-- A gestao continua com autoridade direta para corrigir o documento dentro
-- do proprio tenant; a remarcacao cotidiana do professor segue pela RPC.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}';

do $admin_keeps_authority$
declare
  affected integer;
begin
  update public.reschedules
     set fault_type = 'STUDENT'
   where id = 'a4000000-0000-4000-8000-000000000002';
  get diagnostics affected = row_count;
  perform pg_temp.assert_true(
    affected = 1,
    'gestao perdeu autoridade de correcao no tenant'
  );
end;
$admin_keeps_authority$;

reset role;

rollback;
