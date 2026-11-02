\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$ begin
 if not coalesce(v,false) then raise exception 'assertion: %',m; end if; end $$;
grant execute on function pg_temp.assert_true(boolean,text) to public;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants(id,name) values('advance-origin-fixture','Historical advance fixture');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
 ('ea100000-0000-4000-8000-000000000001','authenticated','authenticated','origins-teacher@example.invalid','{"provider":"email"}','{"test_fixture":true}',now(),now()),
 ('ea100000-0000-4000-8000-000000000002','authenticated','authenticated','origins-student@example.invalid','{"provider":"email"}','{"test_fixture":true}',now(),now()),
 ('ea100000-0000-4000-8000-000000000003','authenticated','authenticated','origins-admin@example.invalid','{"provider":"email"}','{"test_fixture":true}',now(),now());
update public.profiles set tenant_id='advance-origin-fixture',lifecycle_status='active',is_test_account=true,
 full_name='Historical advance fixture',role=case right(id::text,1) when '1' then 'TEACHER' when '2' then 'STUDENT' else 'SCHOOL_ADMIN' end
 where id in('ea100000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000002','ea100000-0000-4000-8000-000000000003');
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
 select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id='advance-origin-fixture'
 on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE',is_primary=true;
insert into public.tenant_user_contexts(user_id,tenant_id)
 select id,tenant_id from public.profiles where tenant_id='advance-origin-fixture'
 on conflict(user_id) do update set tenant_id=excluded.tenant_id;

create temp table origin_dates as select
 (now() at time zone 'America/Sao_Paulo')::date as today,
 (date_trunc('month',now() at time zone 'America/Sao_Paulo')+interval '1 month')::date as original,
 (now() at time zone 'America/Sao_Paulo')::date-1 as actual;
-- A versão futura é domingo; a base antiga é quinta.
update origin_dates set original=original+(7-extract(dow from original)::int)%7;
update origin_dates set actual=actual-1 where extract(dow from actual) in(0,4);
grant select on origin_dates to authenticated;
insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,status,start_date)
select 'ea200000-0000-4000-8000-000000000001','advance-origin-fixture',
 'ea100000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000002',
 'Quinta','08:00','SCHEDULED',today-120 from origin_dates;
insert into public.booking_schedule_versions(booking_id,tenant_id,day_of_week,time_slot,valid_from)
select b.id,b.tenant_id,'Domingo','14:30',d.original
from public.bookings b cross join origin_dates d where b.tenant_id='advance-origin-fixture';
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
do $$ declare d record;r jsonb;begin
 select * into d from origin_dates;
 perform pg_temp.assert_true(not exists(select 1 from public.list_lesson_advance_candidates('ea100000-0000-4000-8000-000000000002',d.today) where original_date<=d.today),'past and today never offered');
 perform pg_temp.assert_true(exists(select 1 from public.list_lesson_advance_candidates('ea100000-0000-4000-8000-000000000002',d.original) where original_date=d.original and start_time='14:30'),'versioned Sunday offered with effective time');
 perform pg_temp.assert_true(not exists(select 1 from public.list_lesson_advance_candidates('ea100000-0000-4000-8000-000000000002',d.original) where original_date=d.original+4),'old Thursday not invented');
 perform public.exclude_booking_occurrence('ea200000-0000-4000-8000-000000000001',d.original+7,'Exclusão de ocorrência de teste');
 perform pg_temp.assert_true(not exists(select 1 from public.list_lesson_advance_candidates('ea100000-0000-4000-8000-000000000002',d.original) where original_date=d.original+7),'excluded occurrence hidden');
 perform pg_temp.assert_true(not exists(select 1 from public.list_lesson_advance_candidates('e9100000-0000-4000-8000-000000000002',d.original)),'student outside tenant returns nothing');
 begin
  perform public.create_lesson_advances('ea100000-0000-4000-8000-000000000002',jsonb_build_array(jsonb_build_object('booking_id','ea200000-0000-4000-8000-000000000001','original_date',d.today,'advance_date',d.actual,'advance_time','12:00')));
  raise exception 'past accepted';
 exception when sqlstate '22023' then perform pg_temp.assert_true(sqlerrm='lesson_advance_origin_must_be_future','past error precise'); end;
 begin
  perform public.create_lesson_advances('ea100000-0000-4000-8000-000000000002',jsonb_build_array(jsonb_build_object('booking_id','ea200000-0000-4000-8000-000000000001','original_date',d.original+7,'advance_date',d.original,'advance_time','12:00')));
  raise exception 'same month accepted';
 exception when sqlstate '22023' then perform pg_temp.assert_true(sqlerrm='lesson_advance_requires_previous_month','same month error precise'); end;
 r:=public.create_lesson_advances('ea100000-0000-4000-8000-000000000002',jsonb_build_array(jsonb_build_object('booking_id','ea200000-0000-4000-8000-000000000001','original_date',d.original,'advance_date',d.actual)),'Teste isolado de agenda efetiva');
 perform pg_temp.assert_true((r->>'created')::int=1,'creation honors version instead of base weekday');
 perform pg_temp.assert_true(not exists(select 1 from public.list_lesson_advance_candidates('ea100000-0000-4000-8000-000000000002',d.original) where original_date=d.original),'consumed origin hidden');
end $$;
reset role;
select pg_temp.assert_true(exists(select 1 from public.lesson_advances where tenant_id='advance-origin-fixture' and advance_time='14:30'),'effective time used when omitted');
select pg_temp.assert_true(not has_function_privilege('anon','public.list_lesson_advance_candidates(uuid,date)','execute'),'anonymous cannot read');
select set_config('request.jwt.claims','{"sub":"ea100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
 begin perform public.list_lesson_advance_candidates('ea100000-0000-4000-8000-000000000002',current_date);
 raise exception 'teacher authorized'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
