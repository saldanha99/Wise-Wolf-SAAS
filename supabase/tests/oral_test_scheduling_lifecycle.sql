\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(value boolean,message text) returns void language plpgsql as $$
begin if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if; end; $$;
insert into public.tenants(id,name,slug,saas_status) values('oral-lifecycle-fixture','Oral Fixture','oral-lifecycle-fixture','active');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('00000000-0000-4000-8000-00000000da0'||i)::uuid,'authenticated','authenticated','oral-fixture-'||i||'@example.invalid',
 '{"provider":"email","providers":["email"]}'::jsonb,'{"test_fixture":true}'::jsonb,now(),now() from generate_series(1,4) i;
set local app.enrollment_claim='1';
update public.profiles set tenant_id='oral-lifecycle-fixture',role=case right(id::text,1) when '1' then 'SCHOOL_ADMIN' when '4' then 'STUDENT' else 'TEACHER' end,
 full_name='Oral fixture '||right(id::text,1),status='Ativo',lifecycle_status='active',phone='1199999999'||right(id::text,1),
 can_oral_test=right(id::text,1) in('2','3'),is_test_account=false,
 meeting_link='https://meet.google.com/aaa-bbbb-ccc'
 where id::text like '00000000-0000-4000-8000-00000000da0%';
update public.profiles set professor_id='00000000-0000-4000-8000-00000000da03' where id='00000000-0000-4000-8000-00000000da04';
insert into public.oral_tests(id,tenant_id,student_id,native_teacher_id,cycle_start,due_date)
values('00000000-0000-4000-8000-00000000da10','oral-lifecycle-fixture','00000000-0000-4000-8000-00000000da04','00000000-0000-4000-8000-00000000da03',current_date,current_date+45);
-- Reproduz o agendamento legado que tinha data, mas nenhuma reserva.
alter table public.oral_tests disable trigger oral_test_reservation;
update public.oral_tests set examiner_id='00000000-0000-4000-8000-00000000da02',status='SCHEDULED',scheduled_at=((current_date+4)::text||' 19:00:00-03')::timestamptz where id='00000000-0000-4000-8000-00000000da10';
alter table public.oral_tests enable trigger oral_test_reservation;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000da01","role":"authenticated"}',true);
select public.schedule_oral_test('00000000-0000-4000-8000-00000000da10','00000000-0000-4000-8000-00000000da02',((current_date+4)::text||' 19:00:00-03')::timestamptz);
select pg_temp.assert_true((select count(*)=1 from public.appointments where tenant_id='oral-lifecycle-fixture' and type='oral_test' and status='scheduled'),'one dated reservation');
select pg_temp.assert_true((select count(*)=0 from public.notification_queue where tenant_id='oral-lifecycle-fixture'),'fixture suppressed');
-- As mensagens abaixo existem apenas nesta transação, nunca ficam visíveis ao worker.
update auth.users set raw_user_meta_data='{}' where id::text like '00000000-0000-4000-8000-00000000da0%';
select private.enqueue_oral_test_notices('00000000-0000-4000-8000-00000000da10');
select private.enqueue_oral_test_notices('00000000-0000-4000-8000-00000000da10');
select pg_temp.assert_true((select count(*)=4 from public.notification_queue where tenant_id='oral-lifecycle-fixture'),'two notices plus two reminders, deduplicated');
select pg_temp.assert_true((select count(*)=2 from public.notification_queue where tenant_id='oral-lifecycle-fixture' and notification_kind like 'ORAL_TEST_REMINDER_%' and scheduled_for=((current_date+4)::text||' 18:30:00-03')::timestamptz),'reminders thirty minutes before');
select public.schedule_oral_test('00000000-0000-4000-8000-00000000da10','00000000-0000-4000-8000-00000000da02',((current_date+4)::text||' 19:00:00-03')::timestamptz);
select pg_temp.assert_true((select schedule_version=1 from public.oral_tests where id='00000000-0000-4000-8000-00000000da10'),'exact retry keeps version');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000da04","role":"authenticated"}',true);
select pg_temp.assert_true(jsonb_array_length(public.my_oral_test_agenda())=1,'student sees own test');
select pg_temp.assert_true(jsonb_array_length(public.oral_test_panel_context())=0,'student does not see other panel data');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000da02","role":"authenticated"}',true);
select pg_temp.assert_true(jsonb_array_length(public.oral_test_panel_context())=1,'examiner gets name without permanent student access');
do $$ begin
 begin perform public.unschedule_oral_test('00000000-0000-4000-8000-00000000da10'); raise exception 'teacher bypass'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.assert_true(bool_and((public.get_oral_test_notice_snapshot(id)->>'ok')::boolean),'valid snapshots') from public.notification_queue where tenant_id='oral-lifecycle-fixture';
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000da01","role":"authenticated"}',true);
do $$ begin
 begin perform public.schedule_oral_test('00000000-0000-4000-8000-00000000da10','00000000-0000-4000-8000-00000000da03',((current_date+4)::text||' 19:00:00-03')::timestamptz); raise exception 'native teacher bypass';
 exception when raise_exception then if sqlerrm='native teacher bypass' then raise; end if; end;
 begin perform public.schedule_oral_test('00000000-0000-4000-8000-00000000da10','00000000-0000-4000-8000-00000000da02',now()-interval '1 hour'); raise exception 'past bypass';
 exception when raise_exception then if sqlerrm='past bypass' then raise; end if; end;
end $$;
-- Qualquer agendamento posterior também respeita a reserva oral.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$ begin
 begin insert into public.appointments(tenant_id,teacher_id,professor_id,student_name,start_time,type,status)
 values('oral-lifecycle-fixture','00000000-0000-4000-8000-00000000da02','00000000-0000-4000-8000-00000000da02','Conflict',((current_date+4)::text||' 19:00:00-03')::timestamptz,'experimental','scheduled');
 raise exception 'appointment bypass'; exception when exclusion_violation then null; end;
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000da01","role":"authenticated"}',true);
select public.schedule_oral_test('00000000-0000-4000-8000-00000000da10','00000000-0000-4000-8000-00000000da02',((current_date+4)::text||' 20:00:00-03')::timestamptz);
select pg_temp.assert_true((select count(*)=4 from public.notification_queue where tenant_id='oral-lifecycle-fixture' and status='skipped'),'old notices cancelled');
select pg_temp.assert_true((select count(*)=1 from public.appointments where tenant_id='oral-lifecycle-fixture' and type='oral_test' and start_time=((current_date+4)::text||' 20:00:00-03')::timestamptz),'remap moves same reservation');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update public.profiles set phone='11999999988' where id='00000000-0000-4000-8000-00000000da04';
select pg_temp.assert_true(not bool_or((public.get_oral_test_notice_snapshot(id)->>'ok')::boolean),'changed destination blocked') from public.notification_queue where tenant_id='oral-lifecycle-fixture' and notification_kind like '%STUDENT';
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-00000000da01","role":"authenticated"}',true);
select public.unschedule_oral_test('00000000-0000-4000-8000-00000000da10');
select pg_temp.assert_true((select count(*)=0 from public.appointments where tenant_id='oral-lifecycle-fixture' and status='scheduled'),'cancel releases slot');
select pg_temp.assert_true((select count(*)=0 from public.notification_queue where tenant_id='oral-lifecycle-fixture' and status='pending'),'cancel removes pending messages');
select pg_temp.assert_true((select count(*)=0 from public.class_logs where tenant_id='oral-lifecycle-fixture'),'scheduling never creates payment or presence');
select pg_temp.assert_true(not has_function_privilege('anon','public.my_oral_test_agenda()','execute'),'no anonymous agenda');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.get_oral_test_notice_snapshot(uuid)','execute'),'delivery snapshot closed to clients');
rollback;
