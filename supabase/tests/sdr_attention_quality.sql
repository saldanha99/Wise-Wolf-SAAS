\set ON_ERROR_STOP on
begin;
set local request.jwt.claims='{"role":"service_role"}';
create or replace function pg_temp.assert_true(value boolean,message text) returns void language plpgsql as $$
begin if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if; end; $$;
grant execute on function pg_temp.assert_true(boolean,text) to public;
insert into public.tenants(id,name) values ('sdr-quality-fixture-a','SDR Quality Fixture A'),('sdr-quality-fixture-b','SDR Quality Fixture B');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('00000000-0000-4000-8000-00000000098'||n)::uuid,'authenticated','authenticated',
  'sdr-quality-'||n||'@example.invalid','{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now() from generate_series(1,4)n;
update public.profiles set tenant_id='sdr-quality-fixture-a',role=case when right(id::text,1)='3' then 'TEACHER' else 'SCHOOL_ADMIN' end,lifecycle_status='active',phone='55119999999'||right(id::text,2),full_name='SDR Fixture'
  where id::text like '00000000-0000-4000-8000-00000000098%';
insert into public.tenant_memberships(user_id,tenant_id,role,status)
select id,'sdr-quality-fixture-a',role,'ACTIVE' from public.profiles where id::text like '00000000-0000-4000-8000-00000000098%' and right(id::text,1)<>'4'
on conflict do nothing;
update public.tenant_memberships set status='SUSPENDED' where user_id='00000000-0000-4000-8000-000000000984';
insert into public.crm_leads(id,tenant_id,name,phone,status,ai_handled,last_inbound_at,created_at)
values ('00000000-0000-4000-8000-000000000991','sdr-quality-fixture-a','Review Fixture','5511999999991','CONTACTED',true,now()-interval '30 minutes',now()-interval '1 day'),
('00000000-0000-4000-8000-000000000992','sdr-quality-fixture-a','Waiting Fixture','5511999999992','CONTACTED',true,now()-interval '20 minutes',now()-interval '1 day'),
('00000000-0000-4000-8000-000000000993','sdr-quality-fixture-b','Other School Fixture','5511999999993','CONTACTED',true,now(),now());
insert into public.sdr_conversation_work(tenant_id,phone,payload,latest_msg_id,completed_msg_id,phase,updated_at)
values('sdr-quality-fixture-a','5511999999991','{}','m2','m1','REVIEW',now()-interval '30 minutes'),
('sdr-quality-fixture-a','5511999999992','{}','m3','m2','IDLE',now()-interval '20 minutes');
insert into public.ai_wa_messages(tenant_id,phone,agent,direction,content,meta,created_at) values
('sdr-quality-fixture-a','5511999999991','sdr','out','Mensagem de teste','{"entregue":true}',now()-interval '2 minutes'),
('sdr-quality-fixture-a','5511999999991','sdr','out','Mensagem de teste!','{"entregue":true}',now()-interval '1 minute'),
('sdr-quality-fixture-a','5511999999991','sdr','out','Mensagem de teste','{"entregue":false,"delivery_outcome":"rejected"}',now());
set local role authenticated;
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000981"}';
do $$ declare r jsonb; begin
  r:=public.sdr_operations_dashboard('sdr-quality-fixture-a',7);
  perform pg_temp.assert_true((r#>>'{metrics,attention}')::integer=2,'all real issues surfaced');
  perform pg_temp.assert_true((r#>>'{metrics,suspected_duplicates}')::integer=1,'only accepted repeated messages counted');
  perform pg_temp.assert_true((r#>>'{metrics,delivery_failures}')::integer=1,'delivery failures visible');
  perform pg_temp.assert_true((r#>>'{metrics,leads}')::integer=2,'tenant isolated cohort');
  perform pg_temp.assert_true((r#>>'{metrics,unanswered}')::integer=1,'overdue queue visible');
  begin perform public.sdr_operations_dashboard('sdr-quality-fixture-b',7); raise exception 'cross tenant read allowed'; exception when insufficient_privilege then null; end;
  begin perform public.manage_sdr_attention('sdr-quality-fixture-b','00000000-0000-4000-8000-000000000993','take'); raise exception 'cross tenant write allowed'; exception when insufficient_privilege then null; end;
  perform pg_temp.assert_true((public.manage_sdr_attention('sdr-quality-fixture-a','00000000-0000-4000-8000-000000000991','take')->>'ok')::boolean,'manager can take');
end $$;
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000982"}';
select pg_temp.assert_true(public.manage_sdr_attention('sdr-quality-fixture-a','00000000-0000-4000-8000-000000000991','take')->>'error'='already_assigned','cannot steal active ownership');
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000984"}';
do $$ begin
  begin perform public.sdr_operations_dashboard('sdr-quality-fixture-a',7); raise exception 'inactive membership allowed'; exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000981"}';
reset role;
update public.sdr_conversation_work set lease_until=now()+interval '1 minute' where phone='5511999999991' and tenant_id='sdr-quality-fixture-a';
set local role authenticated;
select pg_temp.assert_true(public.manage_sdr_attention('sdr-quality-fixture-a','00000000-0000-4000-8000-000000000991','release')->>'error'='send_in_progress','cannot release live effects');
reset role;
update public.sdr_conversation_work set lease_until=null where phone='5511999999991' and tenant_id='sdr-quality-fixture-a';
set local role authenticated;
select pg_temp.assert_true((public.manage_sdr_attention('sdr-quality-fixture-a','00000000-0000-4000-8000-000000000991','release')->>'ok')::boolean,'owner releases reviewed case');
select pg_temp.assert_true((public.sdr_operations_dashboard('sdr-quality-fixture-a',7)#>>'{metrics,attention}')::integer=1,'resolved issue leaves attention queue');
reset role;
select pg_temp.assert_true((select phase='IDLE' and completed_msg_id=latest_msg_id from public.sdr_conversation_work where phone='5511999999991' and tenant_id='sdr-quality-fixture-a'),'old uncertain effects never replay');
update public.sdr_conversation_work set phase='APPLYING',lease_until=now()+interval '1 minute',lease_token='00000000-0000-4000-8000-000000000999' where tenant_id='sdr-quality-fixture-a' and phone='5511999999992';
set local role authenticated;
select pg_temp.assert_true(public.manage_sdr_attention('sdr-quality-fixture-a','00000000-0000-4000-8000-000000000992','take')->>'error'='send_in_progress','cannot take over an active external send');
reset role;
update public.sdr_conversation_work set phase='GENERATING',claimed_msg_id=latest_msg_id where tenant_id='sdr-quality-fixture-a' and phone='5511999999992';
set local role authenticated;
select pg_temp.assert_true((public.manage_sdr_attention('sdr-quality-fixture-a','00000000-0000-4000-8000-000000000992','take')->>'ok')::boolean,'can take over generation before effects');
reset role;
select pg_temp.assert_true(not public.begin_sdr_effects('sdr-quality-fixture-a','5511999999992','00000000-0000-4000-8000-000000000999'),'human takeover fences the old generation');

-- Real occupied appointment removes only that date/time; tenant and role isolation remain enforced.
insert into public.teacher_availability(teacher_id,tenant_id,day_of_week,start_time,end_time)
values('00000000-0000-4000-8000-000000000983','sdr-quality-fixture-a',2,'16:00','16:30'),
('00000000-0000-4000-8000-000000000983','sdr-quality-fixture-a',2,'17:00','17:30');
insert into public.appointments(teacher_id,professor_id,tenant_id,student_name,start_time,status,type)
values('00000000-0000-4000-8000-000000000983','00000000-0000-4000-8000-000000000983','sdr-quality-fixture-a','Agenda Fixture',
  (date_trunc('week',now() at time zone 'America/Sao_Paulo')+interval '8 days 16 hours') at time zone 'America/Sao_Paulo','scheduled','experimental');
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
do $$ declare d date:=(date_trunc('week',now() at time zone 'America/Sao_Paulo')+interval '8 days')::date; begin
  perform pg_temp.assert_true((select count(*) from public.sdr_available_trial_slots('sdr-quality-fixture-a',d,1,null))=1,'occupied teacher slot not offered');
  perform pg_temp.assert_true((select time from public.sdr_available_trial_slots('sdr-quality-fixture-a',d,1,null))='17:00','free exact dated slot offered');
  perform pg_temp.assert_true((select count(*) from public.sdr_available_trial_slots('sdr-quality-fixture-b',d,1,null))=0,'no teacher leak across schools');
end $$;
reset role;
select pg_temp.assert_true(not has_function_privilege('anon','public.sdr_operations_dashboard(text,integer)','execute'),'anon denied report');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.sdr_available_trial_slots(text,date,integer,uuid)','execute'),'client denied raw teacher slots');
select pg_temp.assert_true(not has_table_privilege('authenticated','private.sdr_attention_assignments','select'),'private assignments not exposed');
rollback;
