\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.meet_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin if not coalesce(p_ok,false) then raise exception 'meet assertion: %',p_message; end if; end; $$;
do $test$
declare
  admin_id uuid:=gen_random_uuid();teacher_id uuid:=gen_random_uuid();student_id uuid:=gen_random_uuid();
  outsider_id uuid:=gen_random_uuid();other_student uuid:=gen_random_uuid();session_id uuid:=gen_random_uuid();other_session uuid:=gen_random_uuid();future_session uuid:=gen_random_uuid();
  result jsonb;artifact_id uuid;summary_id uuid;blocked boolean;nonce jsonb;original_count bigint;claim_id text;
  today date:=(now() at time zone 'America/Sao_Paulo')::date;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.tenants(id,name) values('meet-docs-fixture','Meet docs fixture'),('meet-other-fixture','Meet other fixture');
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
    (admin_id,'meet-admin@example.invalid','{"provider":"email"}','{"test_fixture":true}'),
    (teacher_id,'meet-teacher@example.invalid','{"provider":"email"}','{"test_fixture":true}'),
    (student_id,'meet-student@example.invalid','{"provider":"email"}','{"test_fixture":true}'),
    (outsider_id,'meet-other-admin@example.invalid','{"provider":"email"}','{"test_fixture":true}'),
    (other_student,'meet-other-student@example.invalid','{"provider":"email"}','{"test_fixture":true}');
  update public.profiles set tenant_id='meet-docs-fixture',lifecycle_status='active',is_test_account=true,
    role=case when id=admin_id then 'SCHOOL_ADMIN' when id=teacher_id then 'TEACHER' else 'STUDENT' end
    where id in(admin_id,teacher_id,student_id);
  update public.profiles set tenant_id='meet-other-fixture',lifecycle_status='active',is_test_account=true,
    role=case when id=outsider_id then 'SCHOOL_ADMIN' else 'STUDENT' end where id in(outsider_id,other_student);
  update public.profiles set professor_id=teacher_id where id=student_id;
  -- Conta Google confirmada pelo professor (20260926180000): é ela o coanfitrião.
  insert into private.teacher_google_identities(teacher_id,tenant_id,google_sub,google_email,email_verified)
    values(teacher_id,'meet-docs-fixture','docs-teacher-sub','teacher@example.invalid',true);
  insert into public.tenant_memberships(tenant_id,user_id,role,status)
    select tenant_id,id,role,'ACTIVE' from public.profiles where id in(admin_id,teacher_id,student_id,outsider_id,other_student)
    on conflict(tenant_id,user_id) do update set role=excluded.role,status='ACTIVE';
  insert into public.lesson_sessions(id,tenant_id,student_id,teacher_id,class_date,scheduled_start_at,scheduled_end_at,source_key,documentation_consent)
    values(session_id,'meet-docs-fixture',student_id,teacher_id,today,now()-interval '1 hour',now()-interval '30 minutes','meet-fixture',true),
    (other_session,'meet-other-fixture',other_student,outsider_id,today,now()-interval '1 hour',now(),'other-fixture',true);
  select count(*) into original_count from public.class_logs;
  perform pg_temp.meet_assert(not has_function_privilege('authenticated','public.google_meet_backend(text,text,uuid,uuid,jsonb)','execute'),'browser can read private OAuth storage');
  perform pg_temp.meet_assert(not has_table_privilege('authenticated','private.google_workspace_connections','select'),'browser can read tokens');
  perform pg_temp.meet_assert(not has_table_privilege('authenticated','private.lesson_summary_versions','update'),'browser can rewrite review history');
  perform pg_temp.meet_assert(not has_table_privilege('authenticated','private.meeting_artifact_revisions','delete'),'browser can delete source evidence');

  perform public.google_meet_backend('nonce_create','meet-docs-fixture',admin_id,null,jsonb_build_object('state_hash',repeat('a',64),'verifier_ciphertext','synthetic-ciphertext'));
  nonce:=public.google_meet_backend('nonce_consume',null,null,null,jsonb_build_object('state_hash',repeat('a',64)));
  perform pg_temp.meet_assert(nonce->>'actor_id'=admin_id::text,'OAuth state lost actor binding');
  blocked:=false;begin perform public.google_meet_backend('nonce_consume',null,null,null,jsonb_build_object('state_hash',repeat('a',64)));exception when invalid_parameter_value then blocked:=true;end;
  perform pg_temp.meet_assert(blocked,'OAuth nonce replay allowed');
  blocked:=false;begin perform public.google_meet_backend('nonce_create','meet-docs-fixture',teacher_id,null,jsonb_build_object('state_hash',repeat('b',64),'verifier_ciphertext','synthetic'));exception when insufficient_privilege then blocked:=true;end;
  perform pg_temp.meet_assert(blocked,'teacher can connect central account');
  perform public.google_meet_backend('connection_save','meet-docs-fixture',admin_id,null,jsonb_build_object('organizer_sub','synthetic-sub','organizer_email','organizer@example.invalid','refresh_token_ciphertext','synthetic-protected-token','granted_scopes',jsonb_build_array('fixture')));
  result:=public.google_meet_backend('status','meet-docs-fixture',admin_id);
  perform pg_temp.meet_assert(not result::text like '%synthetic-protected-token%','status leaks OAuth token');
  blocked:=false;begin perform public.google_meet_backend('session_detail','meet-docs-fixture',outsider_id,session_id);exception when insufficient_privilege then blocked:=true;end;
  perform pg_temp.meet_assert(blocked,'cross tenant read accepted');

  result:=public.google_meet_backend('room_claim','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('organizer_sub','synthetic-sub','cohost_email','teacher@example.invalid'));
  perform pg_temp.meet_assert((result->>'claimed')::boolean,'first room reservation not acquired');
  claim_id:=result->'room'->>'claim_id';
  result:=public.google_meet_backend('room_claim','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('organizer_sub','synthetic-sub','cohost_email','teacher@example.invalid'));
  perform pg_temp.meet_assert(not (result->>'claimed')::boolean,'concurrent room creates duplicate');
  perform pg_temp.meet_assert(not (result->'room' ? 'claim_id'),'room reservation token leaks to a non-owner');
  -- Só quem tem a reserva grava o link (20260926170000).
  blocked:=false;begin perform public.google_meet_backend('room_save','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('space_name','spaces/fixture','meeting_uri','https://meet.google.com/abc-defg-hij','state','READY'));exception when object_not_in_prerequisite_state then blocked:=true;end;
  perform pg_temp.meet_assert(blocked,'room link saved without the creation reservation');
  perform public.google_meet_backend('room_save','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('space_name','spaces/fixture','meeting_uri','https://meet.google.com/abc-defg-hij','state','READY','claim_id',claim_id));
  insert into public.lesson_occurrences(tenant_id,session_id,source_type,source_id,class_date,start_time,scheduled_start_at,scheduled_end_at,entitlement_date,status)
    values('meet-docs-fixture',session_id,'booking','active-fixture',today,'14:00',now()-interval '1 hour',now()-interval '30 minutes',today,'SCHEDULED'),
    ('meet-docs-fixture',session_id,'booking','archived-fixture',today,'14:00',now()-interval '1 hour',now()-interval '30 minutes',today,'SUPERSEDED');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',student_id,'role','authenticated')::text,true);
  result:=public.get_my_lesson_rooms(today,today);
  perform pg_temp.meet_assert(jsonb_array_length(result)=1 and result->0->>'meeting_uri'='https://meet.google.com/abc-defg-hij','student official room missing');
  perform pg_temp.meet_assert(not result::text like '%organizer_sub%' and not result::text like '%source_text%','student room projection leaks private data');
  perform pg_temp.meet_assert(jsonb_array_length(result->0->'source_references')=1 and result->0->'source_references'->0->>'source_id'='active-fixture','archived occurrence attached to active room');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);

  result:=public.google_meet_backend('artifact_save','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('provider_name','conferenceRecords/c/smartNotes/n','kind','SMART_NOTES','document_id','test_doc','content_sha256',repeat('c',64),'source_text','O aluno praticou perguntas no aeroporto.','retention_days',90));artifact_id:=(result->>'id')::uuid;
  result:=public.google_meet_backend('artifact_save','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('provider_name','conferenceRecords/c/smartNotes/n','kind','SMART_NOTES','document_id','test_doc','content_sha256',repeat('c',64),'source_text','O aluno praticou perguntas no aeroporto.','retention_days',90));
  perform pg_temp.meet_assert(not (result->>'inserted')::boolean,'artifact retry duplicated source');
  result:=public.google_meet_backend('artifact_save','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('provider_name','conferenceRecords/c/smartNotes/n','kind','SMART_NOTES','document_id','test_doc','content_sha256',repeat('d',64),'source_text','Fonte revisada pelo Google.','retention_days',90));
  perform pg_temp.meet_assert((select count(*)=2 from private.meeting_artifact_revisions where lesson_session_id=session_id),'source revision overwrote original');
  result:=public.google_meet_backend('summary_save','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('status','PROPOSED','origin','GOOGLE_SMART_NOTES','content',jsonb_build_object('narrative','O aluno praticou perguntas no aeroporto.'),'source_artifact_ids',jsonb_build_array(artifact_id)));summary_id:=(result->>'id')::uuid;
  perform pg_temp.meet_assert(not exists(select 1 from public.student_learning_memories m where m.source_ref=session_id::text and m.source_type='MEET_SESSION'),'unreviewed summary promoted to student fact');
  result:=public.google_meet_backend('summary_save','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('status','VERIFIED','origin','HUMAN_REVIEW','parent_version_id',summary_id,'content',jsonb_build_object('lesson_objective','Fazer perguntas no aeroporto','recommended_next_step','Praticar pedido de informação','content_practiced',jsonb_build_array('Perguntas'),'recurring_errors','[]'::jsonb,'strengths_observed','[]'::jsonb),'source_artifact_ids',jsonb_build_array(artifact_id)));
  perform pg_temp.meet_assert((result->>'version')::int=2,'human review did not append new version');
  perform pg_temp.meet_assert(exists(select 1 from public.student_learning_memories m where m.source_ref=session_id::text and m.verification_status='VERIFIED' and m.metadata->>'summary_version_id'=result->>'id'),'approved summary not reflected in pedagogical memory');
  perform pg_temp.meet_assert((select count(*)=original_count from public.class_logs),'pedagogical review wrote attendance/payroll');
  blocked:=false;begin perform public.google_meet_backend('summary_save','meet-other-fixture',outsider_id,other_session,jsonb_build_object('status','PROPOSED','origin','GOOGLE_SMART_NOTES','content','{}'::jsonb,'source_artifact_ids',jsonb_build_array(artifact_id)));exception when insufficient_privilege then blocked:=true;end;
  perform pg_temp.meet_assert(blocked,'cross tenant artifact attached to summary');
  update private.meeting_artifact_revisions set expires_at=now()-interval '1 minute' where id=artifact_id;
  blocked:=false;begin perform public.google_meet_backend('summary_save','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('status','VERIFIED','origin','HUMAN_REVIEW','parent_version_id',summary_id,'content',jsonb_build_object('lesson_objective','Objetivo','recommended_next_step','Continuidade'),'source_artifact_ids',jsonb_build_array(artifact_id)));exception when insufficient_privilege then blocked:=true;end;
  perform pg_temp.meet_assert(blocked,'expired source accepted for new approval before daily purge');
  perform public.google_meet_backend('summary_claim','meet-docs-fixture',teacher_id,session_id);
  blocked:=false;begin perform public.google_meet_backend('summary_claim','meet-docs-fixture',teacher_id,session_id);exception when object_not_in_prerequisite_state then blocked:=true;end;
  perform pg_temp.meet_assert(blocked,'concurrent paid summary not blocked');
  insert into public.lesson_sessions(id,tenant_id,student_id,teacher_id,class_date,scheduled_start_at,scheduled_end_at,source_key,documentation_consent)
    values(future_session,'meet-docs-fixture',student_id,teacher_id,today+1,now()+interval '2 hours',now()+interval '3 hours','meet-future-fixture',false);
  result:=public.get_pending_google_meet_sync_sessions();
  perform pg_temp.meet_assert(not exists(select 1 from jsonb_array_elements(result) job where job->>'lesson_session_id'=future_session::text),'future room scheduled without documentation permission');
  -- Sem aceite e sem sala a sessão não volta: o app usa o link de sempre (o botão
  -- ficou vazio de 13/09 a 26/09/2026 porque toda sessão voltava com link nulo).
  perform set_config('request.jwt.claims',jsonb_build_object('sub',student_id,'role','authenticated')::text,true);
  perform pg_temp.meet_assert(public.get_my_lesson_rooms(today+1,today+1)='[]'::jsonb,'session without consent or room hides the usual lesson link');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.lesson_sessions set documentation_consent=true where id=future_session;
  -- Com aceite a sala da escola é esperada: volta sem link (não abre sala pessoal).
  perform set_config('request.jwt.claims',jsonb_build_object('sub',student_id,'role','authenticated')::text,true);
  result:=public.get_my_lesson_rooms(today+1,today+1);
  perform pg_temp.meet_assert(jsonb_array_length(result)=1 and result->0->>'meeting_uri' is null,'authorized session without ready room opens a personal room');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  result:=public.get_pending_google_meet_sync_sessions();
  perform pg_temp.meet_assert(exists(select 1 from jsonb_array_elements(result) job where job->>'lesson_session_id'=future_session::text and job->>'operation'='PREPARE_ROOM'),'authorized upcoming room not queued');
  perform pg_temp.meet_assert(result->0->>'lesson_session_id'=future_session::text,'past document backlog takes priority over upcoming room preparation');
  update public.lesson_sessions set status='SUPERSEDED' where id=session_id;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',student_id,'role','authenticated')::text,true);
  perform pg_temp.meet_assert(public.get_my_lesson_rooms(today,today)='[]'::jsonb,'archived session room still offered to student');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  blocked:=false;begin perform public.google_meet_backend('room_claim','meet-docs-fixture',teacher_id,session_id,jsonb_build_object('organizer_sub','synthetic-sub','cohost_email','teacher@example.invalid'));exception when invalid_parameter_value then blocked:=true;end;
  perform pg_temp.meet_assert(blocked,'archived session can be reprovisioned');
  result:=public.get_pending_google_meet_sync_sessions();
  perform pg_temp.meet_assert(not exists(select 1 from jsonb_array_elements(result) job where job->>'lesson_session_id'=session_id::text),'archived session queued for provider automation');
  perform public.google_meet_backend('disconnect','meet-docs-fixture',admin_id);
  perform pg_temp.meet_assert((select refresh_token_ciphertext is null and status='DISCONNECTED' from private.google_workspace_connections where tenant_id='meet-docs-fixture'),'disconnect retains reusable token');
end;
$test$;
rollback;
