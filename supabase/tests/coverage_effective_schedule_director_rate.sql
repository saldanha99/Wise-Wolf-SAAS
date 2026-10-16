\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$begin
 if not coalesce(v,false) then raise exception 'assertion: %',m;end if;end $$;
grant execute on function pg_temp.assert_true(boolean,text) to public;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants(id,name) values('coverage-effective-fixture','Coverage effective fixture'),('coverage-foreign-fixture','Other fixture');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('cf160000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated',
 'coverage-effective-'||n||'@example.invalid','{"provider":"email"}'::jsonb,'{"test_fixture":true}'::jsonb,now(),now() from generate_series(1,7) n;
update public.profiles set tenant_id=case right(id::text,1) when '7' then 'coverage-foreign-fixture' else 'coverage-effective-fixture' end,
 role=case right(id::text,1) when '1' then 'SCHOOL_ADMIN' when '2' then 'COORDINATOR' when '3' then 'TEACHER' when '4' then 'TEACHER' when '7' then 'SCHOOL_ADMIN' else 'STUDENT' end,
 lifecycle_status='active',status='Ativo',hourly_rate=20,is_test_account=false,full_name='Coverage fixture',phone=null
 where id::text like 'cf160000-0000-4000-8000-%';
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
 select id,tenant_id,role,'ACTIVE',true from public.profiles where id::text like 'cf160000-0000-4000-8000-%'
 on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE',is_primary=true;
insert into public.tenant_user_contexts(user_id,tenant_id)
 select id,tenant_id from public.profiles where id::text like 'cf160000-0000-4000-8000-%'
 on conflict(user_id) do update set tenant_id=excluded.tenant_id;
create temp table coverage_dates as select
 (now() at time zone 'America/Sao_Paulo')::date+1+(8-extract(dow from (now() at time zone 'America/Sao_Paulo')::date+1)::integer)%7 as monday;
grant select on coverage_dates to public;
-- Segunda + quarta, mesmo quando a base legada ainda diz terça; vigência preservada.
insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date,status) values
 ('cf161000-0000-4000-8000-000000000001','coverage-effective-fixture','cf160000-0000-4000-8000-000000000003','cf160000-0000-4000-8000-000000000005','Terça','09:30',current_date-120,'SCHEDULED'),
 ('cf161000-0000-4000-8000-000000000002','coverage-effective-fixture','cf160000-0000-4000-8000-000000000003','cf160000-0000-4000-8000-000000000005','Quarta','09:30',current_date-120,'SCHEDULED'),
 ('cf161000-0000-4000-8000-000000000003','coverage-effective-fixture','cf160000-0000-4000-8000-000000000004','cf160000-0000-4000-8000-000000000006','Segunda','09:30',current_date-120,'SCHEDULED'),
 ('cf161000-0000-4000-8000-000000000004','coverage-effective-fixture','cf160000-0000-4000-8000-000000000003','cf160000-0000-4000-8000-000000000006','Sexta','11:00',current_date+120,'SCHEDULED');
insert into public.booking_schedule_versions(booking_id,tenant_id,valid_from,day_of_week,time_slot) values
 ('cf161000-0000-4000-8000-000000000001','coverage-effective-fixture',current_date-60,'Segunda','09:30'),
 ('cf161000-0000-4000-8000-000000000003','coverage-effective-fixture',current_date-60,'Segunda','10:30');
insert into public.teacher_availability(tenant_id,teacher_id,day_of_week,start_time)
 values('coverage-effective-fixture','cf160000-0000-4000-8000-000000000004',1,'09:30');
select pg_temp.assert_true((select count(*)=2 from public.coverage_booking_occurrences('coverage-effective-fixture',array['cf160000-0000-4000-8000-000000000003']::uuid[],(select monday from coverage_dates),(select monday+4 from coverage_dates))), 'exactly monday and wednesday, no future enrollment');
select pg_temp.assert_true(not exists(select 1 from public.coverage_booking_occurrences('coverage-effective-fixture',array['cf160000-0000-4000-8000-000000000003']::uuid[],(select monday from coverage_dates),(select monday+4 from coverage_dates)) where dow=2), 'no phantom tuesday');
select pg_temp.assert_true(exists(select 1 from public.coverage_candidates_for_booking('coverage-effective-fixture','cf161000-0000-4000-8000-000000000001',(select monday from coverage_dates),'09:30') where teacher_id='cf160000-0000-4000-8000-000000000004'), 'substitute moved to 10:30 is free at 09:30');
insert into public.booking_occurrence_exclusions(tenant_id,booking_id,class_date,reason,created_by)
 select 'coverage-effective-fixture','cf161000-0000-4000-8000-000000000002',monday+2,'fixture exclusion','cf160000-0000-4000-8000-000000000001' from coverage_dates;
select pg_temp.assert_true((select count(*)=1 from public.coverage_booking_occurrences('coverage-effective-fixture',array['cf160000-0000-4000-8000-000000000003']::uuid[],(select monday from coverage_dates),(select monday+4 from coverage_dates))), 'exclusion omitted');
insert into public.teacher_absences(id,tenant_id,teacher_id,starts_at,ends_at,reason,status)
 select 'cf162000-0000-4000-8000-000000000001','coverage-effective-fixture','cf160000-0000-4000-8000-000000000003',monday-14,monday+4,'OTHER','ACTIVE' from coverage_dates;
-- Tentativas financeiras fora do papel/tenant são recusadas, inclusive pela edge service_role.
do $$ declare actor uuid;begin
 foreach actor in array array['cf160000-0000-4000-8000-000000000002','cf160000-0000-4000-8000-000000000004','cf160000-0000-4000-8000-000000000007']::uuid[] loop
  begin
   insert into public.class_coverages(original_teacher_id,cover_teacher_id,student_id,booking_id,absence_id,tenant_id,class_date,class_time,status,token,offered_rate,offered_rate_set_by)
   select 'cf160000-0000-4000-8000-000000000003','cf160000-0000-4000-8000-000000000004','cf160000-0000-4000-8000-000000000005','cf161000-0000-4000-8000-000000000001','cf162000-0000-4000-8000-000000000001','coverage-effective-fixture',monday,'09:30','pending',repeat('a',32),12.50,actor from coverage_dates;
   raise exception 'unauthorized rate accepted';
  exception when insufficient_privilege then null;end;
 end loop;
end $$;
insert into public.class_coverages(id,original_teacher_id,cover_teacher_id,student_id,booking_id,absence_id,tenant_id,class_date,class_time,status,token,offered_rate,offered_rate_set_by)
 select 'cf163000-0000-4000-8000-000000000001','cf160000-0000-4000-8000-000000000003','cf160000-0000-4000-8000-000000000004','cf160000-0000-4000-8000-000000000005','cf161000-0000-4000-8000-000000000001','cf162000-0000-4000-8000-000000000001','coverage-effective-fixture',monday,'09:30','pending',repeat('b',32),12.50,'cf160000-0000-4000-8000-000000000001' from coverage_dates;
select pg_temp.assert_true((select count(*)=0 from public.coverage_booking_occurrences('coverage-effective-fixture',array['cf160000-0000-4000-8000-000000000003']::uuid[],(select monday from coverage_dates),(select monday+4 from coverage_dates))), 'pending coverage omitted from next preview');
select pg_temp.assert_true((public.resolve_coverage_invite(repeat('b',32),true)->>'ok')::boolean,'accept versioned booking');
select pg_temp.assert_true((public.resolve_coverage_invite(repeat('b',32),true)->>'already')::boolean,'accept retry idempotent');
do $$begin
 begin update public.class_coverages set offered_rate=99 where id='cf163000-0000-4000-8000-000000000001';raise exception 'changed accepted price';exception when insufficient_privilege then null;end;
end $$;
-- Um horário legado na terça não pode mais ser gravado como cobertura.
do $$begin
 begin
  insert into public.class_coverages(original_teacher_id,cover_teacher_id,student_id,booking_id,absence_id,tenant_id,class_date,class_time,status,token)
  select 'cf160000-0000-4000-8000-000000000003','cf160000-0000-4000-8000-000000000004','cf160000-0000-4000-8000-000000000005','cf161000-0000-4000-8000-000000000001','cf162000-0000-4000-8000-000000000001','coverage-effective-fixture',monday+1,'09:30','pending',repeat('d',32) from coverage_dates;
  raise exception 'legacy weekday accepted';exception when check_violation then null;end;
end $$;
-- Aula passada atestada, depois lançada pelo substituto: só ela recebe a oferta.
insert into public.class_coverages(id,original_teacher_id,cover_teacher_id,student_id,booking_id,absence_id,tenant_id,class_date,class_time,status,confirmed_by,confirmed_at,offered_rate,offered_rate_set_by)
 select 'cf163000-0000-4000-8000-000000000002','cf160000-0000-4000-8000-000000000003','cf160000-0000-4000-8000-000000000004','cf160000-0000-4000-8000-000000000005','cf161000-0000-4000-8000-000000000001','cf162000-0000-4000-8000-000000000001','coverage-effective-fixture',monday-14,'09:30','confirmed','cf160000-0000-4000-8000-000000000001',now(),12.50,'cf160000-0000-4000-8000-000000000001' from coverage_dates;
select set_config('request.jwt.claims','{"sub":"cf160000-0000-4000-8000-000000000004","role":"authenticated"}',true);
set local role authenticated;
do $$declare result jsonb;begin
 result:=public.log_teacher_classes(jsonb_build_array(jsonb_build_object(
  'ref','coverage-fixture','booking_id','cf161000-0000-4000-8000-000000000001','class_date',(select monday-14 from coverage_dates),
  'presence','COMPLETED','lesson_objective','Objetivo da fixture','content_covered','Prática em inglês',
  'student_difficulties','Nenhuma observada','homework_assigned','Sem tarefa','recommended_next_step','Retomar prática',
  'late_logging_reason','Regularização autorizada de fixture histórica')));
 perform pg_temp.assert_true((result->>'inserted')::integer=1,'substitute logs accepted versioned class: '||result::text);
 perform pg_temp.assert_true((result->>'delta_amount')::numeric=12.50,'class reward uses offered rate: '||result::text);
end $$;
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create temp table coverage_fixture_log as select id from public.class_logs where tenant_id='coverage-effective-fixture'
 and booking_id='cf161000-0000-4000-8000-000000000001' and teacher_id='cf160000-0000-4000-8000-000000000004';
select pg_temp.assert_true((select count(*)=1 from coverage_fixture_log),'one real class log only');
select pg_temp.assert_true((select rate_efetivo=12.50 from public.v_payable_class_logs where id=(select id from coverage_fixture_log)),'offered rate reaches actual payroll');
update public.class_logs set payment_hold=true where id=(select id from coverage_fixture_log);
select pg_temp.assert_true(not exists(select 1 from public.v_payable_class_logs where id=(select id from coverage_fixture_log)),'offered rate never bypasses payment hold');
update public.class_logs set payment_hold=false where id=(select id from coverage_fixture_log);
update public.class_coverages set status='cancelled' where id='cf163000-0000-4000-8000-000000000002';
select pg_temp.assert_true((select rate_efetivo=public.teacher_student_rate(teacher_id,student_id,class_date) from public.v_payable_class_logs where id=(select id from coverage_fixture_log)),'cancelled coverage cannot retain offered rate');
-- As famílias mantêm a leitura operacional; a remuneração nova não vaza pela API.
select set_config('request.jwt.claims','{"sub":"cf160000-0000-4000-8000-000000000005","role":"authenticated"}',true);
set local role authenticated;
select pg_temp.assert_true(exists(select 1 from public.class_coverages where id='cf163000-0000-4000-8000-000000000001'),'student keeps operational coverage access');
do $$begin
 begin perform offered_rate from public.class_coverages where id='cf163000-0000-4000-8000-000000000001';raise exception 'student saw remuneration';exception when insufficient_privilege then null;end;
end $$;
reset role;
select pg_temp.assert_true(not has_function_privilege('authenticated','public.coverage_booking_occurrences(text,uuid[],date,date,boolean)','execute') and not has_function_privilege('anon','public.coverage_candidates_for_booking(text,uuid,date,text)','execute'),'service-only reads');
rollback;
