\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$ begin
 if not coalesce(v,false) then raise exception 'assertion: %',m; end if; end $$;
grant execute on function pg_temp.assert_true(boolean,text) to public;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('app.reschedule_silent','on',true);
insert into public.tenants(id,name) values('history-fixture','History fixture'),('history-other-fixture','Other history fixture');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('f8100000-0000-4000-8000-00000000000'||n)::uuid,'authenticated','authenticated',
 'history-'||n||'@example.invalid','{"provider":"email"}'::jsonb,'{"test_fixture":true}'::jsonb,now(),now() from generate_series(1,6) n;
update public.profiles set tenant_id=case when right(id::text,1)='6' then 'history-other-fixture' else 'history-fixture' end,
 lifecycle_status='active',is_test_account=true,full_name='History fixture '||right(id::text,1),
 role=case right(id::text,1) when '2' then 'STUDENT' when '3' then 'SCHOOL_ADMIN' when '4' then 'COORDINATOR' when '6' then 'SCHOOL_ADMIN' else 'TEACHER' end
 where id::text like 'f8100000-0000-4000-8000-00000000000%';
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
 select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id in ('history-fixture','history-other-fixture')
 on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE',is_primary=true;
insert into public.tenant_user_contexts(user_id,tenant_id)
 select id,tenant_id from public.profiles where tenant_id in ('history-fixture','history-other-fixture')
 on conflict(user_id) do update set tenant_id=excluded.tenant_id;
create temp table history_dates as select (now() at time zone 'America/Sao_Paulo')::date-7 as actual;
grant select on history_dates to authenticated;
insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date,status)
 select 'f8200000-0000-4000-8000-000000000001','history-fixture','f8100000-0000-4000-8000-000000000001',
 'f8100000-0000-4000-8000-000000000002',case extract(dow from actual)::int when 0 then 'Domingo' when 1 then 'Segunda' when 2 then 'Terça' when 3 then 'Quarta' when 4 then 'Quinta' when 5 then 'Sexta' else 'Sábado' end,
 '08:00',actual-28,'SCHEDULED' from history_dates;
insert into public.class_logs(id,tenant_id,teacher_id,student_id,booking_id,class_date,date,presence,subtype,observations)
 select 'f8300000-0000-4000-8000-000000000001','history-fixture','f8100000-0000-4000-8000-000000000001','f8100000-0000-4000-8000-000000000002',
 'f8200000-0000-4000-8000-000000000001',actual,actual,'COMPLETED',null,'Observação operacional de teste' from history_dates;
insert into public.reschedules(id,tenant_id,teacher_id,student_id,original_booking_id,date,fault_type)
 values('f8400000-0000-4000-8000-000000000001','history-fixture','f8100000-0000-4000-8000-000000000001','f8100000-0000-4000-8000-000000000002','f8200000-0000-4000-8000-000000000001','Pendente','TEACHER');
select pg_temp.assert_true(not has_table_privilege('authenticated','private.lesson_history_events','SELECT')
 and not has_table_privilege('service_role','private.lesson_history_events','UPDATE'),'audit not exposed or mutable');
select pg_temp.assert_true(not has_function_privilege('anon','public.get_teacher_lesson_history(uuid,date,date,uuid)','EXECUTE'),'anonymous cannot read');
select set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$ declare h jsonb;d date;dispute uuid; begin
 select actual into d from history_dates;
 h:=public.get_teacher_lesson_history('f8100000-0000-4000-8000-000000000001',d,d);
 perform pg_temp.assert_true((h->'totals'->>'COMPLETED')::int=1 and jsonb_array_length(h->'rows')=1,'logged occurrence counted once');
 perform pg_temp.assert_true(jsonb_array_length(h->'backlog')=1,'undated backlog survives period filter');
 perform pg_temp.assert_true(jsonb_array_length(h->'events')>=1,'creation audited');
 dispute:=public.open_lesson_history_dispute('f8100000-0000-4000-8000-000000000001','class_logs','f8300000-0000-4000-8000-000000000001',d,'Registro precisa de conferência pela coordenação');
 begin perform public.resolve_lesson_history_dispute(dispute,'Professor não pode decidir sozinho'); raise exception 'teacher resolved'; exception when insufficient_privilege then null; end;
 begin perform public.correct_lesson_history('f8100000-0000-4000-8000-000000000001','class_logs','f8300000-0000-4000-8000-000000000001',d,0,'Teste','Teacher não pode corrigir'); raise exception 'teacher corrected'; exception when insufficient_privilege then null; end;
 begin perform public.get_teacher_lesson_history('f8100000-0000-4000-8000-000000000005',d,d); raise exception 'other teacher read'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000004","role":"authenticated"}',true);
set local role authenticated;
do $$ declare d date;h jsonb;did uuid; begin
 select actual into d from history_dates;
 perform public.correct_lesson_history('f8100000-0000-4000-8000-000000000001','class_logs','f8300000-0000-4000-8000-000000000001',d,0,'Correção operacional','Justificativa obrigatória de teste');
 begin perform public.correct_lesson_history('f8100000-0000-4000-8000-000000000001','class_logs','f8300000-0000-4000-8000-000000000001',d,0,'Conflito','Tentativa de sobrescrever versão'); raise exception 'version guard absent'; exception when raise_exception then if sqlerrm<>'history_version_conflict' then raise; end if; end;
 h:=public.get_teacher_lesson_history('f8100000-0000-4000-8000-000000000001',d,d);
 did:=(h->'rows'->0->'disputes'->0->>'id')::uuid;
 perform public.resolve_lesson_history_dispute(did,'Conferência concluída sem alterar presença nem folha');
 perform public.correct_lesson_history('f8100000-0000-4000-8000-000000000001','bookings','f8200000-0000-4000-8000-000000000001',d+7,0,'Feriado autorizado','Feriado cadastrado pela coordenação','HOLIDAY');
 h:=public.get_teacher_lesson_history('f8100000-0000-4000-8000-000000000001',d+7,d+7);
 perform pg_temp.assert_true((h->'totals'->>'HOLIDAY')::int=1 and jsonb_array_length(h->'rows')=1,'holiday exclusive, not unfinalized');
 perform public.correct_lesson_history('f8100000-0000-4000-8000-000000000001','bookings','f8200000-0000-4000-8000-000000000001',d+7,1,'Reabertura atestada','Correção da classificação com justificativa',null);
 h:=public.get_teacher_lesson_history('f8100000-0000-4000-8000-000000000001',d+7,d+7);
 perform pg_temp.assert_true(h->'totals'->>'HOLIDAY' is null and jsonb_array_length(h->'rows')=1,'reopen restores occurrence without erasing correction trail');
 perform public.correct_lesson_history('f8100000-0000-4000-8000-000000000001','bookings','f8200000-0000-4000-8000-000000000001',d+7,2,'Feriado confirmado','Feriado confirmado após nova conferência','HOLIDAY');
end $$;
reset role;
select pg_temp.assert_true((select presence='COMPLETED' and not payment_hold and observations='Observação operacional de teste' from public.class_logs where id='f8300000-0000-4000-8000-000000000001'),'correction and dispute preserve original payroll log');
select set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000006","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
 begin perform public.get_teacher_lesson_history('f8100000-0000-4000-8000-000000000001');raise exception 'cross tenant read';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
-- Uma remoção administrativa nunca some do histórico nem reaparece como pendência.
update public.lesson_occurrences set class_log_id=null where class_log_id='f8300000-0000-4000-8000-000000000001';
delete from public.class_logs where id='f8300000-0000-4000-8000-000000000001';
update public.bookings set teacher_id='f8100000-0000-4000-8000-000000000005' where id='f8200000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000005","role":"authenticated"}',true);
set local role authenticated;
do $$ declare h jsonb;d date; begin
 select actual-7 into d from history_dates;
 h:=public.get_teacher_lesson_history('f8100000-0000-4000-8000-000000000005',d,d);
 perform pg_temp.assert_true(jsonb_array_length(h->'rows')=0,'new teacher does not inherit past unlogged occurrences');
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$ declare h jsonb;d date; begin
 select actual-7 into d from history_dates;
 h:=public.get_teacher_lesson_history('f8100000-0000-4000-8000-000000000001',d,d);
 perform pg_temp.assert_true((h->'totals'->>'UNFINALIZED')::int=1,'previous teacher retains unlogged past with archived assignment');
end $$;
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update public.profiles set lifecycle_status='offboarded' where id='f8100000-0000-4000-8000-000000000001';
update public.tenant_memberships set status='REVOKED' where user_id='f8100000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims','{"sub":"f8100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$ declare h jsonb;d date; begin
 select actual into d from history_dates;
 h:=public.get_teacher_lesson_history('f8100000-0000-4000-8000-000000000001',d,d);
 perform pg_temp.assert_true((h->'totals'->>'REMOVED')::int=1 and jsonb_array_length(h->'rows')=1,'own offboarded read preserves removal and suppresses duplicate pending');
 perform pg_temp.assert_true(h->'rows'->0->'disputes'->0->>'resolution' is not null,'resolution preserved');
 perform pg_temp.assert_true(public._my_role() is null,'ordinary access remains disabled');
end $$;
reset role;
do $$ begin
 begin update private.lesson_history_events set reason='silent edit' where tenant_id='history-fixture';raise exception 'audit mutable';exception when raise_exception then if sqlerrm<>'history_is_append_only' then raise;end if;end;
end $$;
rollback;
