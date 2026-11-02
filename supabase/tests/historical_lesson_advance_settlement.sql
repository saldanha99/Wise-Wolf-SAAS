\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$ begin
 if not coalesce(v,false) then raise exception 'assertion: %',m; end if; end $$;
grant execute on function pg_temp.assert_true(boolean,text) to public;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants(id,name) values('historical-advance-fixture','Historical advance fixture');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
 ('e9100000-0000-4000-8000-000000000001','authenticated','authenticated','historic-teacher@example.invalid','{"provider":"email"}','{"test_fixture":true}',now(),now()),
 ('e9100000-0000-4000-8000-000000000002','authenticated','authenticated','historic-student@example.invalid','{"provider":"email"}','{"test_fixture":true}',now(),now()),
 ('e9100000-0000-4000-8000-000000000003','authenticated','authenticated','historic-admin@example.invalid','{"provider":"email"}','{"test_fixture":true}',now(),now());
update public.profiles set tenant_id='historical-advance-fixture',lifecycle_status='active',is_test_account=true,
 full_name='Historical advance fixture',role=case right(id::text,1) when '1' then 'TEACHER' when '2' then 'STUDENT' else 'SCHOOL_ADMIN' end
 where id in('e9100000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000002','e9100000-0000-4000-8000-000000000003');
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
 select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id='historical-advance-fixture'
 on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE',is_primary=true;
insert into public.tenant_user_contexts(user_id,tenant_id)
 select id,tenant_id from public.profiles where tenant_id='historical-advance-fixture'
 on conflict(user_id) do update set tenant_id=excluded.tenant_id;
create temp table historical_dates as select
 (now() at time zone 'America/Sao_Paulo')::date-1 as actual,
 (date_trunc('month',now() at time zone 'America/Sao_Paulo')+interval '1 month 2 days')::date as original;
update historical_dates set original=original+1 where extract(dow from original)=extract(dow from actual);
grant select on historical_dates to authenticated,service_role;
insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,status,start_date)
 select 'e9200000-0000-4000-8000-000000000001','historical-advance-fixture',
 'e9100000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000002',
 case extract(dow from original)::int when 0 then 'Domingo' when 1 then 'Segunda' when 2 then 'Terça' when 3 then 'Quarta' when 4 then 'Quinta' when 5 then 'Sexta' else 'Sábado' end,
 '08:00','SCHEDULED',actual-120 from historical_dates;
select set_config('request.jwt.claims','{"sub":"e9100000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
do $$ declare d record;r jsonb; entries jsonb; begin
 select * into d from historical_dates;
 entries:=jsonb_build_array(jsonb_build_object('booking_id','e9200000-0000-4000-8000-000000000001','original_date',d.original,'advance_date',d.actual));
 r:=public.settle_historical_lesson_advances('e9100000-0000-4000-8000-000000000002',entries,'Realização confirmada em teste isolado');
 perform pg_temp.assert_true((r->>'created')::int=1,'creates one historical log');
 r:=public.settle_historical_lesson_advances('e9100000-0000-4000-8000-000000000002',entries,'Realização confirmada em teste isolado');
 perform pg_temp.assert_true((r->>'skipped')::int=1 and (r->>'created')::int=0,'retry is idempotent');
 perform public.exclude_booking_occurrence('e9200000-0000-4000-8000-000000000001',d.original+7,'Feriado sem aula autorizado pela direção');
 perform public.exclude_booking_occurrence('e9200000-0000-4000-8000-000000000001',d.original+7,'Feriado sem aula autorizado pela direção');
end $$;
reset role;
set constraints all immediate;
select pg_temp.assert_true(exists(select 1 from public.class_logs l join public.lesson_advances a on a.id=l.lesson_advance_id
 where a.tenant_id='historical-advance-fixture' and a.status='COMPLETED' and l.presence='COMPLETED' and l.start_time is null and a.advance_time is null),'no fabricated time, settled atomically');
select pg_temp.assert_true(not exists(select 1 from public.upcoming_classes where tenant_id='historical-advance-fixture'
 and class_date in(select actual from historical_dates)),'no time-based notification for unknown time');
select pg_temp.assert_true(not (public.booking_schedule_on_date('e9200000-0000-4000-8000-000000000001',original)->>'valid')::boolean
 and not (public.booking_schedule_on_date('e9200000-0000-4000-8000-000000000001',original+7)->>'valid')::boolean,'origin and holiday excluded') from historical_dates;
select pg_temp.assert_true((select count(*)=1 from public.booking_occurrence_exclusions where tenant_id='historical-advance-fixture'),'holiday retry no duplicate');
select pg_temp.assert_true(not has_function_privilege('anon','public.settle_historical_lesson_advances(uuid,jsonb,text)','EXECUTE'),'anonymous denied');
select pg_temp.assert_true(has_table_privilege('service_role','public.booking_occurrence_exclusions','SELECT')
 and not has_table_privilege('anon','public.booking_occurrence_exclusions','SELECT'),'schedule reader has service grant without anonymous grant');
set local role service_role;
select pg_temp.assert_true(not (public.booking_schedule_on_date('e9200000-0000-4000-8000-000000000001',original+7)->>'valid')::boolean,
 'service reader observes excluded date') from historical_dates;
reset role;
select set_config('request.jwt.claims','{"sub":"e9100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
 begin perform public.settle_historical_lesson_advances('e9100000-0000-4000-8000-000000000002','[]','Teacher must not settle');
 raise exception 'teacher unexpectedly authorized'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
