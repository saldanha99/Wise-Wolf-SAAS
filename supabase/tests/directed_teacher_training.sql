-- Transaction-only integration fixture: never commit, no external invitations.
set local request.jwt.claims = '{"role":"service_role"}';
insert into auth.users(id,email,raw_user_meta_data) values
 ('00000000-0000-4000-8000-000000000081','training-trainer-20260909@example.invalid','{"full_name":"Training fixture trainer"}'),
 ('00000000-0000-4000-8000-000000000082','training-trainee-20260909@example.invalid','{"full_name":"Training fixture trainee"}');
update public.profiles set role='TEACHER',tenant_id='school-wise-wolf',is_test_account=true,test_fixture_key='directed-training-20260909-'||id::text,phone='5511999999981',meeting_link='https://example.invalid/training',is_trainer=true where id in ('00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000082');
do $$
declare r jsonb; r2 jsonb; s public.teacher_training_sessions%rowtype; v_start timestamptz:=((now() at time zone 'America/Sao_Paulo')::date+2)::text||'T16:30:00-03:00'; v_token text:=repeat('a',64);
begin
 update public.dre_report_settings set destino='120363000000000081@g.us',allow_group_member_actions=true,is_active=true where tenant_id='school-wise-wolf';
 insert into public.gestao_acao_pendente(group_jid,tenant_id,acao,resumo,request_id,tool_name,status,requested_by_jid,confirmed_by_jid,confirmed_at,expires_at)
 values('120363000000000081@g.us','school-wise-wolf',jsonb_build_object('tipo','agendar_treinamento','trainer_id','00000000-0000-4000-8000-000000000081','trainee_id','00000000-0000-4000-8000-000000000082','starts_at',to_char(v_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'Training fixture','fixture-training-01','academics.schedule_teacher_training','executing','123456789012345@lid','123456789012345@lid',now(),now()+interval '5 minutes');
 r:=public.gestao_schedule_teacher_training('school-wise-wolf',null,'fixture-training-01','00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000082',v_start);
 assert r->>'ok'='true';
 select * into s from public.teacher_training_sessions where id=(r->>'id')::uuid;
 assert s.status='PENDING' and s.appointment_id is null and s.test_fixture;
 assert not exists(select 1 from public.notification_queue where source_id=s.id), 'Test identities must never receive notifications';
 r2:=private.schedule_teacher_training('school-wise-wolf',null,'fixture-training-01',s.trainer_id,s.trainee_id,v_start);
 assert r2->>'id'=s.id::text and r2->>'idempotent'='true';
 begin
   perform private.schedule_teacher_training('school-wise-wolf',null,'fixture-training-02',s.trainer_id,s.trainee_id,v_start);
   raise exception 'Conflicting training was allowed';
 exception when others then assert sqlerrm='Um dos teachers já possui compromisso ou ausência nesse horário.',sqlerrm; end;
 update private.teacher_training_invite_tokens set token_hash=encode(extensions.digest(v_token,'sha256'),'hex') where session_id=s.id;
 r:=public.teacher_training_invite(v_token,null);
 assert r->>'status'='PENDING' and r->>'meeting_link' is null;
 assert not exists(select 1 from public.appointments where id=s.appointment_id);
 r:=public.teacher_training_invite(v_token,'accept');
 assert r->>'status'='CONFIRMED' and r->>'meeting_link'='https://example.invalid/training';
 r:=public.teacher_training_invite(v_token,'accept');
 assert r->>'status'='CONFIRMED';
 select * into s from public.teacher_training_sessions where id=s.id;
 assert s.appointment_id is not null and s.class_log_id is null;
 assert (select count(*) from public.appointments where id=s.appointment_id)=1;
 begin
  insert into public.appointments(tenant_id,teacher_id,professor_id,student_name,start_time,status,type) values(s.tenant_id,s.trainee_id,s.trainee_id,'Training conflict fixture',v_start,'scheduled','training');
  raise exception 'Trainee double booking was allowed';
 exception when others then assert sqlerrm='Este teacher já tem um treinamento confirmado nesse horário.',sqlerrm; end;
 begin
  insert into public.class_logs(tenant_id,teacher_id,appointment_id,subtype,presence,class_date,date,start_time) values(s.tenant_id,s.trainer_id,s.appointment_id::text,'TREINAMENTO','COMPLETED',(v_start at time zone 'America/Sao_Paulo')::date,(v_start at time zone 'America/Sao_Paulo')::date,'16:30');
  raise exception 'Premature training payment was allowed';
 exception when others then assert sqlerrm='O treinamento precisa ter aceite e estar concluído para entrar no fechamento.',sqlerrm; end;
 -- Move only isolated fixtures into the past to exercise completed payroll.
 v_start:=((now() at time zone 'America/Sao_Paulo')::date-1)::text||'T16:30:00-03:00';
 update public.teacher_training_sessions set starts_at=v_start,ends_at=v_start+interval '30 minutes' where id=s.id;
 update public.appointments set start_time=v_start where id=s.appointment_id;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',s.trainer_id)::text,true);
 r:=public.log_teacher_classes(jsonb_build_array(jsonb_build_object('appointment_id',s.appointment_id::text,'class_date',(v_start at time zone 'America/Sao_Paulo')::date,'presence','COMPLETED','content_covered','Training fixture completed')));
 assert (select status from public.teacher_training_sessions where id=s.id)='COMPLETED',r::text;
 assert (select rate_override from public.class_logs where appointment_id=s.appointment_id::text)=16;
 r:=public.log_teacher_classes(jsonb_build_array(jsonb_build_object('appointment_id',s.appointment_id::text,'class_date',(v_start at time zone 'America/Sao_Paulo')::date,'presence','COMPLETED','content_covered','Training fixture duplicate')));
 assert (select count(*) from public.class_logs where appointment_id=s.appointment_id::text)=1;
 assert (select rate_efetivo from public.v_payable_class_logs where appointment_id=s.appointment_id::text)=16;
 -- The invitation must remain usable when the trainer has not set a room yet.
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 update public.profiles set meeting_link=null where id=s.trainer_id;
 v_start:=((now() at time zone 'America/Sao_Paulo')::date+3)::text||'T16:30:00-03:00';
 r:=private.schedule_teacher_training('school-wise-wolf',null,'fixture-training-no-room',s.trainer_id,s.trainee_id,v_start);
 select * into s from public.teacher_training_sessions where id=(r->>'id')::uuid;
 assert s.meeting_link='';
 update private.teacher_training_invite_tokens set token_hash=encode(extensions.digest(repeat('b',64),'sha256'),'hex') where session_id=s.id;
 r:=public.teacher_training_invite(repeat('b',64),'accept');
 assert r->>'status'='CONFIRMED' and r->>'meeting_link' is null;

end;
$$;
