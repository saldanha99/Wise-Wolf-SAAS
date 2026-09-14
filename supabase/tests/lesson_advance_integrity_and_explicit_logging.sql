\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$ begin
  if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if;
end $$;
grant execute on function pg_temp.assert_true(boolean,text) to public;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

insert into public.tenants(id,name) values('lesson-integrity-fixture','Lesson integrity fixture');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
 ('ed100000-0000-4000-8000-000000000001','authenticated','authenticated','lesson-teacher@example.invalid','{"provider":"email"}','{}',now(),now()),
 ('ed100000-0000-4000-8000-000000000002','authenticated','authenticated','lesson-student@example.invalid','{"provider":"email"}','{}',now(),now()),
 ('ed100000-0000-4000-8000-000000000003','authenticated','authenticated','lesson-admin@example.invalid','{"provider":"email"}','{}',now(),now());
update public.profiles set tenant_id='lesson-integrity-fixture',lifecycle_status='active',is_test_account=true,
 full_name='Lesson integrity fixture',role=case right(id::text,1) when '1' then 'TEACHER' when '2' then 'STUDENT' else 'SCHOOL_ADMIN' end
 where id in('ed100000-0000-4000-8000-000000000001','ed100000-0000-4000-8000-000000000002','ed100000-0000-4000-8000-000000000003');
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id='lesson-integrity-fixture'
on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE',is_primary=true;
insert into public.tenant_user_contexts(user_id,tenant_id)
select id,tenant_id from public.profiles where tenant_id='lesson-integrity-fixture'
on conflict(user_id) do update set tenant_id=excluded.tenant_id;

create temp table fixture_dates as select
 (now() at time zone 'America/Sao_Paulo')::date as today,
 (now() at time zone 'America/Sao_Paulo')::date-1 as actual,
 (date_trunc('month',now() at time zone 'America/Sao_Paulo')+interval '1 month 2 days')::date as original;
update fixture_dates set original=original+1 where extract(dow from original)=extract(dow from actual);
grant select on fixture_dates to authenticated;
insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,status,start_date)
select 'ed200000-0000-4000-8000-000000000001'::uuid,'lesson-integrity-fixture',
 'ed100000-0000-4000-8000-000000000001'::uuid,'ed100000-0000-4000-8000-000000000002'::uuid,
 case extract(dow from original)::int when 0 then 'Domingo' when 1 then 'Segunda' when 2 then 'Terça'
 when 3 then 'Quarta' when 4 then 'Quinta' when 5 then 'Sexta' else 'Sábado' end,'08:00','SCHEDULED',today-120 from fixture_dates
union all select 'ed200000-0000-4000-8000-000000000002','lesson-integrity-fixture',
 'ed100000-0000-4000-8000-000000000001','ed100000-0000-4000-8000-000000000002',
 case extract(dow from actual)::int when 0 then 'Domingo' when 1 then 'Segunda' when 2 then 'Terça'
 when 3 then 'Quarta' when 4 then 'Quinta' when 5 then 'Sexta' else 'Sábado' end,'14:00','SCHEDULED',today-120 from fixture_dates
union all select 'ed200000-0000-4000-8000-000000000003','lesson-integrity-fixture',
 'ed100000-0000-4000-8000-000000000001','ed100000-0000-4000-8000-000000000002',
 case extract(dow from today)::int when 0 then 'Domingo' when 1 then 'Segunda' when 2 then 'Terça'
 when 3 then 'Quarta' when 4 then 'Quinta' when 5 then 'Sexta' else 'Sábado' end,'23:30','SCHEDULED',today-120 from fixture_dates;

select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
select public.create_lesson_advances('ed100000-0000-4000-8000-000000000002',
 jsonb_build_array(jsonb_build_object('booking_id','ed200000-0000-4000-8000-000000000001',
  'original_date',original,'advance_date',actual,'advance_time','12:00')),'Viagem de teste') from fixture_dates;
reset role;

select pg_temp.assert_true(exists(select 1 from public.upcoming_classes u join fixture_dates d on u.class_date=d.actual
 where u.source_id='ed200000-0000-4000-8000-000000000001' and u.time_text='12:00'),
 'advance enters independent attendance source with actual time');
select pg_temp.assert_true(not exists(select 1 from public.upcoming_classes u join fixture_dates d on u.class_date=d.original
 where u.source_id='ed200000-0000-4000-8000-000000000001'), 'consumed future occurrence is absent from attendance source');

insert into public.attendance_confirmations(id,tenant_id,source_id,source_type,teacher_id,student_id,
 class_date,class_time,student_name,teacher_name,token,status)
select 'ed300000-0000-4000-8000-000000000001','lesson-integrity-fixture','ed200000-0000-4000-8000-000000000001',
 'booking','ed100000-0000-4000-8000-000000000001','ed100000-0000-4000-8000-000000000002',actual,'12:00',
 'Aluno fixture','Professor fixture','fixture-advance-audit-token','PENDING' from fixture_dates;
select private.refresh_attendance_confirmation_sessions(actual,actual) from fixture_dates;
select pg_temp.assert_true(private.attendance_session_is_consistent('ed300000-0000-4000-8000-000000000001'),
 'independent advance attendance is valid before the teacher logs');

create or replace function pg_temp.lesson_payload(ref text,book text,day date)
returns jsonb language sql as $$ select jsonb_build_object('ref',ref,'booking_id',book,'class_date',day,
 'presence','COMPLETED','lesson_objective','Praticar viagem','content_covered','Pedidos em inglês, página 3',
 'student_difficulties','Nenhuma observada','homework_assigned','Sem tarefa','recommended_next_step','Praticar aeroporto',
 'late_logging_reason','Regularização autorizada de fixture') $$;
grant execute on function pg_temp.lesson_payload(text,text,date) to public;
select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$ declare result jsonb; advance_id uuid; d record; begin
 select * into d from fixture_dates;
 select id into advance_id from public.lesson_advances where tenant_id='lesson-integrity-fixture';
 result:=public.log_teacher_classes(jsonb_build_array(
   (pg_temp.lesson_payload('advanced',null,d.actual) || jsonb_build_object('lesson_advance_id',advance_id)),
   pg_temp.lesson_payload('regular','ed200000-0000-4000-8000-000000000002',d.actual),
   pg_temp.lesson_payload('incomplete','ed200000-0000-4000-8000-000000000003',d.today)-'lesson_objective',
   pg_temp.lesson_payload('unfinished','ed200000-0000-4000-8000-000000000003',d.today)
 ));
 perform pg_temp.assert_true((result->>'inserted')::int=2,'mixed batch commits regular and different-time advance: '||result::text);
 perform pg_temp.assert_true((result->>'skipped')::int=2,'mixed batch reports failed rows: '||result::text);
 perform pg_temp.assert_true(result->'entries'->2->>'reason'='registro_pedagogico_incompleto','required content checked server-side');
 perform pg_temp.assert_true(result->'entries'->3->>'reason'='aula_ainda_nao_terminou','today slot cannot finish before its end');
 result:=public.log_teacher_classes(jsonb_build_array(pg_temp.lesson_payload('retry',null,d.actual) || jsonb_build_object('lesson_advance_id',advance_id)));
 perform pg_temp.assert_true((result->>'inserted')::int=0,'advance retry does not duplicate');
 perform pg_temp.assert_true(exists(select 1 from public.list_teacher_lesson_booking_occurrences(d.actual,d.actual)
   where lesson_advance_id=advance_id),'completed advance remains in authoritative daily total; logs remove it from pending');
 perform pg_temp.assert_true(not exists(select 1 from public.list_teacher_lesson_booking_occurrences(d.original,d.original)
   where booking_id='ed200000-0000-4000-8000-000000000001'),'teacher reader excludes consumed origin');
end $$;
reset role;

select pg_temp.assert_true(exists(select 1 from public.class_logs where teacher_id='ed100000-0000-4000-8000-000000000001'
 and lesson_advance_id is not null and start_time='12:00' and lesson_objective='Praticar viagem'
 and student_difficulties='Nenhuma observada' and homework_assigned='Sem tarefa'
 and recommended_next_step='Praticar aeroporto' and late_logging_reason is not null),
 'authorized actual time and structured teaching history survive all real triggers');

-- Cross-migration integration: the AFTER linker preserves the actual meeting
-- date separately from its consumed entitlement, without a screen read.
select pg_temp.assert_true(exists(select 1 from public.class_logs cl
 join public.lesson_occurrences o on o.class_log_id=cl.id and o.session_id=cl.lesson_session_id
 join public.lesson_sessions s on s.id=o.session_id and s.tenant_id=cl.tenant_id
 join fixture_dates d on o.class_date=d.actual and o.entitlement_date=d.original
 where cl.tenant_id='lesson-integrity-fixture' and cl.lesson_advance_id is not null
   and s.teacher_id=cl.teacher_id and s.student_id=cl.student_id and o.start_time='12:00'),
 'advance log immediately links actual session and original entitlement with matching actors');
select private.sync_lesson_quality_sessions('lesson-integrity-fixture',original,original,null) from fixture_dates;
select pg_temp.assert_true(not exists(select 1 from public.lesson_occurrences o join fixture_dates d on o.class_date=d.original
 where o.tenant_id='lesson-integrity-fixture' and o.source_id='ed200000-0000-4000-8000-000000000001'),
 'canonical quality source cannot rematerialize consumed future entitlement');

-- Insert a past-origin authorized fixture to exercise the future-origin guard
-- after the original date has arrived (the creation RPC rightly requires a future origin).
-- The advance date only needs to be a past date of the previous month that is
-- NOT a regular occurrence of booking ...0003 (weekday of today). Without the
-- one-day shift this failed whenever the last day of the previous month minus 7
-- fell on today's weekday (Monday 14/09/2026 → Monday 24/08), and the whole
-- release rolled back.
insert into public.lesson_advances(tenant_id,booking_id,teacher_id,student_id,original_date,advance_date,advance_time,created_by)
select 'lesson-integrity-fixture','ed200000-0000-4000-8000-000000000003','ed100000-0000-4000-8000-000000000001',
 'ed100000-0000-4000-8000-000000000002',today-7,
 (date_trunc('month',today)-interval '1 day')::date-7
   - case when extract(dow from (date_trunc('month',today)-interval '1 day')::date-7) = extract(dow from today)
          then 1 else 0 end,
 '11:00',
 'ed100000-0000-4000-8000-000000000003' from fixture_dates;
set local role authenticated;
do $$ declare result jsonb; d date; begin
 select today-7 into d from fixture_dates;
 result:=public.log_teacher_classes(jsonb_build_array(pg_temp.lesson_payload('consumed','ed200000-0000-4000-8000-000000000003',d)));
 perform pg_temp.assert_true(result->'entries'->0->>'reason'='ocorrencia_antecipada','server blocks consumed origin after its date arrives: '||result::text);
end $$;
reset role;
select pg_temp.assert_true(not has_function_privilege('authenticated','private.log_teacher_classes_engine(jsonb)','execute'), 'financial engine is not a public bypass');

insert into public.lesson_advances(id,tenant_id,booking_id,teacher_id,student_id,original_date,advance_date,advance_time,created_by)
select 'ed400000-0000-4000-8000-000000000001','lesson-integrity-fixture','ed200000-0000-4000-8000-000000000003',
 'ed100000-0000-4000-8000-000000000001','ed100000-0000-4000-8000-000000000002',original+28,actual-1,'13:00',
 'ed100000-0000-4000-8000-000000000003' from fixture_dates;
insert into public.attendance_confirmations(id,tenant_id,source_id,source_type,teacher_id,student_id,
 class_date,class_time,student_name,teacher_name,token,status,student_response)
select 'ed300000-0000-4000-8000-000000000002','lesson-integrity-fixture','ed200000-0000-4000-8000-000000000003',
 'booking','ed100000-0000-4000-8000-000000000001','ed100000-0000-4000-8000-000000000002',actual-1,'13:00',
 'Aluno fixture','Professor fixture','fixture-advance-settlement-token','AWAITING_TEACHER','STUDENT_PRESENT' from fixture_dates;
select set_config('request.jwt.claims','{"sub":"ed100000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
select pg_temp.assert_true((public.settle_confirmed_class('ed300000-0000-4000-8000-000000000002',true)->>'ok')::boolean,
 'school can settle independently confirmed advanced attendance');
reset role;
select pg_temp.assert_true(exists(select 1 from public.lesson_advances a join public.class_logs cl on cl.id=a.class_log_id
 where a.id='ed400000-0000-4000-8000-000000000001' and a.status='COMPLETED' and cl.lesson_advance_id=a.id
 and cl.start_time='13:00'),'administrative settlement links and consumes exact authorized advance');
rollback;
