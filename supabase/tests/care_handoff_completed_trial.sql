\set ON_ERROR_STOP on
begin;

-- All fixtures and their triggers roll back; no external sender is invoked.
do $$
declare
  tenant text;
  teacher uuid;
  instance public.whatsapp_instances%rowtype;
  lesson uuid:=gen_random_uuid();
  opportunity uuid:=gen_random_uuid();
  lead uuid:=gen_random_uuid();
  touchpoint uuid:=gen_random_uuid();
  conversation uuid:=gen_random_uuid();
  phone text:='5511999999876';
  first_result jsonb;
begin
  select * into instance from public.whatsapp_instances where inbox_enabled order by id limit 1;
  tenant:=instance.tenant_id;
  select id into teacher from public.profiles where tenant_id=tenant and role='TEACHER' limit 1;
  if teacher is null or instance.id is null then raise exception 'fixture source unavailable'; end if;
  insert into public.appointments(id,tenant_id,type,status,start_time,teacher_id,professor_id,student_name,student_phone)
    values(lesson,tenant,'experimental','completed',now()-interval '2 days',teacher,teacher,'test_fixture: finished trial',phone);
  insert into public.opportunities(id,tenant_id,kind,status,trial_status,conversion_status,student_name,student_phone,
    professor_id,winner_teacher_id,trial_appointment_id,is_test_fixture,slots_proposed)
    values(opportunity,tenant,'TRIAL','CLAIMED','DONE','OPEN','test_fixture: finished trial',phone,teacher,teacher,lesson,true,'[]'::jsonb);
  insert into public.crm_leads(id,tenant_id,name,phone,status,ai_handoff,ai_handoff_at)
    values(lead,tenant,'test_fixture: completed binding',phone,'CONTACTED',true,now());
  if (public.reconcile_completed_trial_lead(tenant,lead)->>'completed')::boolean then
    raise exception 'test fixture accepted as completed';
  end if;
  update public.opportunities set is_test_fixture=false where id=opportunity;
  first_result:=public.reconcile_completed_trial_lead(tenant,lead);
  if first_result->>'changed'<>'true' or not exists(select 1 from public.crm_leads where id=lead
    and opportunity_id=opportunity and trial_lesson_id=lesson and status='TRIAL_DONE' and ai_handoff) then
    raise exception 'completed binding failed or human handoff overwritten';
  end if;
  if public.reconcile_completed_trial_lead(tenant,lead)->>'changed'<>'false' then
    raise exception 'binding not idempotent';
  end if;
  if (select count(*) from public.audit_logs where resource_id=lead::text
    and action='reconcile_completed_trial_lead')<>1 then raise exception 'duplicate audit'; end if;
  if (public.reconcile_completed_trial_lead('wrong-tenant',lead)->>'completed')::boolean then
    raise exception 'cross-tenant reconciliation'; end if;

  insert into public.whatsapp_conversations(id,tenant_id,instance_id,instance_name,remote_jid,phone,contact_kind)
    values(conversation,tenant,instance.id,instance.instance_name,phone||'@s.whatsapp.net',phone,'student');
  insert into public.care_touchpoints(id,tenant_id,subject_role,subject_id,phone,kind,trigger_ref)
    values(touchpoint,tenant,'STUDENT',teacher,phone,'ABSENCE_FOLLOWUP','test_fixture:'||touchpoint);
  if not public.care_begin_handoff(touchpoint,null,'test_fixture: cancellation') then raise exception 'handoff not claimed'; end if;
  if public.care_begin_handoff(touchpoint,null,'duplicate') then raise exception 'double handoff send allowed'; end if;
  update public.whatsapp_conversations set human_handoff_until=now()-interval '1 day' where id=conversation;
  if not exists(select 1 from public.whatsapp_conversations where id=conversation
    and handoff_active and handoff_requires_release) then raise exception 'durable inbox fence missing'; end if;
  if public.care_touchpoint_open(tenant,'STUDENT',teacher,phone,'ABSENCE_FOLLOWUP',
    'test_fixture: blocked:'||touchpoint) is not null then
    raise exception 'proactive care bypassed durable handoff'; end if;
  update public.whatsapp_conversations set handoff_active=false where id=conversation;
  if (select handoff_requires_release from public.whatsapp_conversations where id=conversation) then
    raise exception 'explicit release did not clear durable fence'; end if;
end;
$$;
do $$ begin
  if has_function_privilege('anon','public.care_begin_handoff(uuid,text,text)','execute')
    or has_function_privilege('authenticated','public.care_begin_handoff(uuid,text,text)','execute')
    or has_function_privilege('anon','public.reconcile_completed_trial_lead(text,uuid)','execute')
    or has_function_privilege('authenticated','public.reconcile_completed_trial_lead(text,uuid)','execute') then
    raise exception 'privileged correction exposed publicly';
  end if;
end $$;
rollback;
