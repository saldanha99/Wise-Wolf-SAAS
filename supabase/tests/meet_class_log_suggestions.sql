\set ON_ERROR_STOP on
begin;
do $test$
declare
  teacher uuid := gen_random_uuid(); student uuid := gen_random_uuid(); other_teacher uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid(); artifact_id uuid := gen_random_uuid(); summary_id uuid := gen_random_uuid();
  foreign_session uuid := gen_random_uuid(); request jsonb; result jsonb; denied boolean;
  day date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if has_function_privilege('anon','public.get_class_log_meet_drafts(jsonb)','EXECUTE')
    or not has_function_privilege('authenticated','public.get_class_log_meet_drafts(jsonb)','EXECUTE') then
    raise exception 'Meet log suggestions privileges incorrect'; end if;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.tenants(id,name) values ('meet-log-fixture','Meet log fixture'), ('meet-log-foreign','Foreign fixture');
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
    (teacher,'meet-log-teacher@example.invalid','{"provider":"email"}','{"test_fixture":true}'),
    (student,'meet-log-student@example.invalid','{"provider":"email"}','{"test_fixture":true}'),
    (other_teacher,'meet-log-other@example.invalid','{"provider":"email"}','{"test_fixture":true}');
  update public.profiles set tenant_id='meet-log-fixture',lifecycle_status='active',is_test_account=true,
    role=case when id=student then 'STUDENT' else 'TEACHER' end where id in (teacher,student,other_teacher);
  insert into public.tenant_memberships(tenant_id,user_id,role,status)
    select tenant_id,id,role,'ACTIVE' from public.profiles where id in (teacher,student,other_teacher)
    on conflict(tenant_id,user_id) do update set role=excluded.role,status='ACTIVE';
  insert into private.lesson_recording_authorization_modes(tenant_id,mode,effective_from,decided_by_name,decided_on,reason,legal_basis,source)
    values ('meet-log-fixture','SCHOOL_DEFAULT',now()-interval '2 days','Fixture',day,'Fixture authorized recording','SCHOOL_CONTRACT_OR_DECISION_WITH_OPT_OUT','APP');
  insert into public.lesson_sessions(id,tenant_id,student_id,teacher_id,class_date,scheduled_start_at,scheduled_end_at,source_key,documentation_consent)
    values (session_id,'meet-log-fixture',student,teacher,day,now()-interval '2 hours',now()-interval '1 hour','fixture',true),
      (foreign_session,'meet-log-foreign',student,teacher,day,now()-interval '2 hours',now()-interval '1 hour','foreign',true);
  insert into public.lesson_occurrences(tenant_id,session_id,source_type,source_id,class_date,start_time,scheduled_start_at,scheduled_end_at,entitlement_date)
    values ('meet-log-fixture',session_id,'booking','fixture-booking',day,'10:00',now()-interval '2 hours',now()-interval '1 hour',day),
      ('meet-log-foreign',foreign_session,'booking','foreign-booking',day,'10:00',now()-interval '2 hours',now()-interval '1 hour',day);
  insert into private.meeting_artifact_revisions(id,tenant_id,lesson_session_id,provider_name,kind,document_id,content_sha256,source_text,expires_at)
    values (artifact_id,'meet-log-fixture',session_id,'GOOGLE_MEET','TRANSCRIPT','fixture_doc',repeat('a',64),'Fixture lesson transcript',now()+interval '1 day');
  insert into private.lesson_summary_versions(id,tenant_id,lesson_session_id,version,status,origin,content,source_artifact_ids)
    values(summary_id,'meet-log-fixture',session_id,1,'PROPOSED','GEMINI_API',
      '{"lesson_objective":"Interview","content_practiced":["Past tense"],"recurring_errors":[],"homework_assigned":"","recommended_next_step":"Role play","narrative":"MUST NOT LEAK","evidence":["MUST NOT LEAK"]}',array[artifact_id]);
  request := jsonb_build_array(jsonb_build_object('ref','own','source_type','booking','source_id','fixture-booking','class_date',day),
    jsonb_build_object('ref','foreign','source_type','booking','source_id','foreign-booking','class_date',day),
    jsonb_build_object('ref','wrong-date','source_type','booking','source_id','fixture-booking','class_date',day-1));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
  result := public.get_class_log_meet_drafts(request);
  if result->'own'->>'summaryId' is distinct from summary_id::text or result ? 'foreign' or result ? 'wrong-date'
    or result::text like '%MUST NOT LEAK%' or result->'own'->'content'->>'homework_assigned'<>'' then
    raise exception 'Suggestion source/scope/unknown fields incorrect: %',result; end if;
  if exists(select 1 from public.class_logs where teacher_id=teacher) then raise exception 'Suggestion invented attendance'; end if;
  update private.meeting_artifact_revisions set expires_at=now()-interval '1 minute' where id=artifact_id;
  if public.get_class_log_meet_drafts(request)<>'{}'::jsonb then raise exception 'Expired draft exposed'; end if;
  update private.meeting_artifact_revisions set expires_at=now()+interval '1 day' where id=artifact_id;
  insert into private.lesson_summary_versions(tenant_id,lesson_session_id,version,status,origin,content)
    values('meet-log-fixture',session_id,2,'REJECTED','HUMAN_REVIEW','{}');
  if public.get_class_log_meet_drafts(request)<>'{}'::jsonb then raise exception 'Rejected summary reused'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other_teacher,'role','authenticated')::text,true);
  if public.get_class_log_meet_drafts(request)<>'{}'::jsonb then raise exception 'Other teacher read draft'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',student,'role','authenticated')::text,true);
  denied:=false;
  begin perform public.get_class_log_meet_drafts(request); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Student read draft'; end if;
end;
$test$;
rollback;
