\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.quality_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin if not coalesce(p_ok,false) then raise exception 'quality assertion: %',p_message; end if; end $$;
do $test$
declare
  tid text:='quality-session-fixture'; teacher uuid:=gen_random_uuid(); teacher2 uuid:=gen_random_uuid(); student uuid:=gen_random_uuid();
  admin_id uuid:=gen_random_uuid(); coordinator uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
  b1 uuid:=gen_random_uuid(); b2 uuid:=gen_random_uuid(); b3 uuid:=gen_random_uuid(); b4 uuid:=gen_random_uuid(); aid uuid:=gen_random_uuid(); aid2 uuid:=gen_random_uuid();
  sid uuid; sid2 uuid; logid uuid; mismatch_aid uuid:=gen_random_uuid(); cid uuid; contact uuid; r jsonb; blocked boolean; day date:=(now() at time zone 'America/Sao_Paulo')::date-7;
  future_sid uuid; new_sid uuid; reviewed_sid uuid; b5 uuid:=gen_random_uuid(); future_aid uuid:=gen_random_uuid();
  dayname text; token text:=encode(extensions.gen_random_bytes(12),'hex');
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  dayname:=(array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from day)::int+1];
  insert into public.tenants(id,name) values(tid,'Quality fixture'),('quality-session-other','Other fixture');
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
    (teacher,'qs-teacher@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}'),
    (teacher2,'qs-teacher2@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}'),
    (student,'qs-student@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}'),
    (admin_id,'qs-admin@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}'),
    (coordinator,'qs-coord@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}'),
    (outsider,'qs-other@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}');
  update public.profiles set tenant_id=case when id=outsider then 'quality-session-other' else tid end,
    role=case when id in(teacher,teacher2) then 'TEACHER' when id=student then 'STUDENT' when id=coordinator then 'COORDINATOR' else 'SCHOOL_ADMIN' end,
    lifecycle_status='active',is_test_account=true where id in(teacher,teacher2,student,admin_id,coordinator,outsider);
  update public.profiles set professor_id=teacher,phone='5500000000001' where id=student;
  insert into public.tenant_memberships(tenant_id,user_id,role,status)
    select tenant_id,id,role,'ACTIVE' from public.profiles where id in(teacher,teacher2,student,admin_id,coordinator,outsider)
    on conflict(tenant_id,user_id) do update set role=excluded.role,status=excluded.status;
  insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,status,start_date)
    values(b1,tid,teacher,student,dayname,'09:00','SCHEDULED',day-10),(b2,tid,teacher,student,dayname,'09:30','SCHEDULED',day-10);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  r:=public.get_lesson_sessions(student,day,day);
  perform pg_temp.quality_assert(r->>'ok'='true' and jsonb_array_length(r->'sessions')=1,'contiguous blocks must form one session');
  sid:=(r->'sessions'->0->>'id')::uuid;
  perform pg_temp.quality_assert((select count(*)=2 from public.lesson_occurrences where session_id=sid),'financial occurrences must remain separate');
  perform pg_temp.quality_assert((select scheduled_end_at-scheduled_start_at=interval '1 hour' from public.lesson_sessions where id=sid),'session duration');
  perform public.get_lesson_sessions(student,day,day);
  perform pg_temp.quality_assert((select count(*)=1 from public.lesson_sessions where tenant_id=tid),'session replay duplicates');
  perform public.set_lesson_documentation_consent(sid,true,'Autorização fictícia do responsável documentada para teste');
  perform pg_temp.quality_assert((select count(*)=1 from private.lesson_documentation_consent_events where session_id=sid),'consent history missing');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
  blocked:=false; begin perform public.set_lesson_documentation_consent(sid,false,'Teacher cannot self authorize'); exception when others then blocked:=true; end;
  perform pg_temp.quality_assert(blocked,'teacher changes consent');
  blocked:=false; begin perform public.get_lesson_quality_dashboard(day,day); exception when others then blocked:=true; end;
  perform pg_temp.quality_assert(blocked,'teacher reads family complaints');
  r:=public.get_student_handover(student,true);
  perform pg_temp.quality_assert(r->>'ok'='true' and (select count(*)=1 from private.student_handover_reads where student_id=student),'handover read snapshot');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  blocked:=false; begin perform public.get_student_handover(student); exception when others then blocked:=true; end;
  perform pg_temp.quality_assert(blocked,'cross tenant handover');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.attendance_confirmations(id,tenant_id,source_type,source_id,student_id,teacher_id,class_date,class_time,token,token_expires_at,status,lesson_session_id)
    values(aid,tid,'booking',b1::text,student,teacher,day,'09:00',token,now()+interval '7 days','PENDING',sid);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  r:=public.submit_lesson_quality_feedback('invalid','{}');
  perform pg_temp.quality_assert(r->>'ok'='false','invalid public token accepted');
  r:=public.submit_lesson_quality_feedback(token,'{"happened":"UNKNOWN"}');
  perform pg_temp.quality_assert(r->>'ok'='true','unknown response rejected');
  perform pg_temp.quality_assert((select student_response is null from public.attendance_confirmations where id=aid),'unknown became financial attendance');
  perform pg_temp.quality_assert(not exists(select 1 from public.lesson_quality_cases where confirmation_id=aid),'unknown creates misconduct case');
  r:=public.submit_lesson_quality_feedback(token,'{"happened":"YES","punctuality":"LATE","reschedule_by":"TEACHER","comment":"Relato de teste"}');
  perform pg_temp.quality_assert(r->>'ok'='true','family report rejected');
  perform pg_temp.quality_assert((select count(*)=3 from public.lesson_quality_cases where confirmation_id=aid),'quality categories missing');
  r:=public.submit_lesson_quality_feedback(token,'{"happened":"YES","punctuality":"LATE","reschedule_by":"TEACHER","comment":"Relato de teste"}');
  perform pg_temp.quality_assert(r->>'already'='true' and (select count(*)=2 from private.lesson_quality_feedback where confirmation_id=aid),
    'retry must not duplicate report: '||r::text||'; feedback_count='||(select count(*) from private.lesson_quality_feedback where confirmation_id=aid));
  perform set_config('request.jwt.claims',jsonb_build_object('sub',coordinator,'role','authenticated')::text,true);
  select id into cid from public.lesson_quality_cases where confirmation_id=aid and category='LATE_START';
  perform public.review_lesson_quality_case(cid,'IN_REVIEW','Equipe conferindo relato com envolvidos',coordinator);
  perform pg_temp.quality_assert((select assigned_to=coordinator from public.lesson_quality_cases where id=cid),'coordinator review');
  r:=public.get_lesson_quality_dashboard(day,day);
  perform pg_temp.quality_assert(r->>'ok'='true' and r->'counts'->>'responded'='1','dashboard excludes quality-only reply');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  -- No network worker connects to this isolated test database. These flags
  -- exercise the inbound eligibility gate and are rolled back with all rows.
  update public.profiles set is_test_account=false where id=student;
  insert into public.student_quality_contacts(tenant_id,student_id,name,phone,relationship,verified_at,verified_by,active)
    values(tid,student,'Guardian fixture','5500000000001','GUARDIAN',now(),admin_id,true) returning id into contact;
  update public.attendance_confirmations set delivery_status='SENT',sent_at=now(),provider_instance_name='quality-fixture',provider_message_id='quality-out-1',quality_recipient_phone='5500000000001',quality_recipient_verified=true where id=aid;
  insert into private.whatsapp_provider_delivery_receipts(tenant_id,provider_instance_name,provider_message_id,delivery_status,delivered_at,read_at)
    values(tid,'quality-fixture','quality-out-1','read',now(),now());
  perform pg_temp.quality_assert((select read_at is not null and delivered_at is not null from public.attendance_confirmations where id=aid),'receipt not linked');
  r:=public.ingest_lesson_quality_whatsapp(tid,'wrong-instance','5500000000001','in-1','quality-out-1','LATE_START','Aula atrasou');
  perform pg_temp.quality_assert(r->>'handled'='false','wrong instance accepted');
  r:=public.ingest_lesson_quality_whatsapp(tid,'quality-fixture','5500000000001','in-1','quality-out-1','LATE_START','Aula atrasou');
  perform pg_temp.quality_assert(r->>'ok'='true','quoted feedback not handled');
  r:=public.ingest_lesson_quality_whatsapp(tid,'quality-fixture','5500000000001','in-1','quality-out-1','LATE_START','Aula atrasou');
  perform pg_temp.quality_assert(r->>'already'='true','inbound replay duplicates');
  insert into public.attendance_confirmations(id,tenant_id,source_type,source_id,student_id,teacher_id,class_date,class_time,token,token_expires_at,status,sent_at,delivery_status,provider_instance_name,provider_message_id,quality_recipient_phone,quality_recipient_verified)
    values(aid2,tid,'booking',b2::text,student,teacher,day+1,'10:00',encode(extensions.gen_random_bytes(12),'hex'),now()+interval '7 days','PENDING',now(),'SENT','quality-fixture','quality-out-2','5500000000001',true);
  r:=public.ingest_lesson_quality_whatsapp(tid,'quality-fixture','5500000000001','in-2',null,'LATE_START','Aula atrasou');
  perform pg_temp.quality_assert(r->>'needs_context'='true','ambiguous lesson arbitrarily selected');
  update public.student_quality_contacts set active=false where id=contact;
  r:=public.ingest_lesson_quality_whatsapp(tid,'quality-fixture','5500000000001','in-3','quality-out-1','LATE_START','Aula atrasou');
  perform pg_temp.quality_assert(r->>'handled'='false','revoked contact still accepted');
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  r:=public.submit_lesson_quality_feedback(token,'{"happened":"NO"}');
  perform pg_temp.quality_assert(r->>'ok'='false','revoked quality link still accepted');
  r:=public.apply_student_response(token,'TEACHER_NO_SHOW');
  perform pg_temp.quality_assert(r->>'ok'='false','revoked presence link still accepted');
  r:=public.get_confirmation_public(token);
  perform pg_temp.quality_assert(r->>'found'='false','revoked link still exposes lesson');
  perform pg_temp.quality_assert(not has_table_privilege('authenticated','private.lesson_quality_feedback','select'),'private family reports exposed');
  perform pg_temp.quality_assert(not has_table_privilege('authenticated','public.lesson_quality_cases','update'),'direct case rewrite allowed');
  perform pg_temp.quality_assert(not has_function_privilege('anon','public.get_student_handover(uuid,boolean)','execute'),'public handover token bypass');

  -- Extending a recurring grade cannot silently broaden an already consented
  -- session. New financial slots get a separate, unconsented session.
  insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,status,start_date)
    values(b3,tid,teacher,student,dayname,'10:00','SCHEDULED',day-10);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  perform public.get_lesson_sessions(student,day,day);
  perform pg_temp.quality_assert((select documentation_consent and scheduled_end_at-scheduled_start_at=interval '1 hour' and status<>'SUPERSEDED'
    from public.lesson_sessions where id=sid),'new contiguous block rewrote consented snapshot');
  perform pg_temp.quality_assert((select count(*)=2 from public.lesson_occurrences where session_id=sid),'new block inherited previous consent');
  select session_id into sid2 from public.lesson_occurrences where tenant_id=tid and source_type='booking' and source_id=b3::text and class_date=day;
  perform pg_temp.quality_assert(sid2<>sid and (select not documentation_consent and scheduled_end_at-scheduled_start_at=interval '30 minutes'
    from public.lesson_sessions where id=sid2),'extension must have its own session');
  perform public.set_lesson_documentation_consent(sid,false,'Revogação fictícia preserva o histórico e a janela original');
  perform public.get_lesson_sessions(student,day,day);
  perform pg_temp.quality_assert((select count(*)=2 from public.lesson_occurrences where session_id=sid),'revocation made historical snapshot mutable');
  perform pg_temp.quality_assert((select count(*)=1 from private.lesson_session_revisions where session_id=sid and previous_snapshot->>'documentation_consent'='true'
    and next_snapshot->>'documentation_consent'='false'),'consent revision must remain auditable');

  -- The real teacher RPC must link its new log immediately (AFTER INSERT),
  -- independently of whether a quality screen is subsequently opened.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
  r:=public.log_teacher_classes(jsonb_build_array(jsonb_build_object('ref','quality-log','booking_id',b1,'class_date',day,'presence','COMPLETED',
    'lesson_objective','Praticar apresentação pessoal','content_covered','Apresentação pessoal e perguntas de rotina',
    'student_difficulties','Nenhuma dificuldade observada','homework_assigned','Sem tarefa nesta aula',
    'recommended_next_step','Revisar rotina na próxima aula','late_logging_reason','Regularização de fixture de qualidade')));
  perform pg_temp.quality_assert(r->>'inserted'='1','real logging RPC failed: '||r::text);
  select id into logid from public.class_logs where tenant_id=tid and booking_id=b1::text and class_date=day;
  perform pg_temp.quality_assert((select lesson_session_id=sid from public.class_logs where id=logid),'AFTER log trigger did not link canonical session');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.bookings set teacher_id=teacher2 where id=b1;
  perform private.sync_lesson_quality_sessions(tid,day,day,student);
  perform pg_temp.quality_assert((select cl.lesson_session_id=sid and s.teacher_id=cl.teacher_id and s.student_id=cl.student_id
    from public.class_logs cl join public.lesson_sessions s on s.id=cl.lesson_session_id where cl.id=logid),'booking reassignment moved old teacher log');
  perform pg_temp.quality_assert((select ac.lesson_session_id=sid and s.teacher_id=ac.teacher_id and s.student_id=ac.student_id
    from public.attendance_confirmations ac join public.lesson_sessions s on s.id=ac.lesson_session_id where ac.id=aid),'booking reassignment moved family evidence');
  perform pg_temp.quality_assert(not exists(select 1 from public.lesson_occurrences o join public.lesson_sessions s on s.id=o.session_id
    where o.tenant_id=tid and o.source_id=b1::text and o.class_date=day and s.teacher_id<>teacher),'historical occurrence changed teacher');
  perform pg_temp.quality_assert(not exists(select 1 from public.lesson_sessions where tenant_id=tid and class_date=day and teacher_id=teacher2 and status<>'SUPERSEDED'),
    'frozen source created ghost replacement session');

  insert into public.attendance_confirmations(id,tenant_id,source_type,source_id,student_id,teacher_id,class_date,class_time,token,token_expires_at,status)
    values(mismatch_aid,tid,'booking',b3::text,student,teacher2,day,'10:00',encode(extensions.gen_random_bytes(12),'hex'),now()+interval '7 days','PENDING');
  perform pg_temp.quality_assert((select lesson_session_id is null from public.attendance_confirmations where id=mismatch_aid),
    'attendance from another teacher linked only by booking/date/time');

  -- A created Google room is also immutable evidence, even if consent is off
  -- and no class log exists yet. The core quality test remains runnable before
  -- the optional Google migration; the integrated suite executes this branch.
  if to_regclass('private.google_meet_rooms') is not null then
    execute 'insert into private.google_meet_rooms(lesson_session_id,tenant_id,organizer_sub,cohost_email,state,created_by) values($1,$2,$3,$4,$5,$6)'
      using sid2,tid,'quality-fixture-organizer','qs-teacher@example.invalid','CREATING',admin_id;
    insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,status,start_date)
      values(b4,tid,teacher,student,dayname,'10:30','SCHEDULED',day-10);
    perform private.sync_lesson_quality_sessions(tid,day,day,student);
    perform private.sync_lesson_quality_sessions(tid,day,day,student);
    perform pg_temp.quality_assert((select scheduled_end_at-scheduled_start_at=interval '30 minutes' and status='SCHEDULED'
      from public.lesson_sessions where id=sid2),'existing Google room snapshot was extended or superseded');
    perform pg_temp.quality_assert((select count(*)=1 from public.lesson_occurrences where session_id=sid2),'new slot inherited existing Google room');
    perform pg_temp.quality_assert((select count(*)=3 from public.lesson_sessions where tenant_id=tid and class_date=day and status<>'SUPERSEDED'),
      'Google room extension replay created duplicate/ghost sessions');
  end if;

  -- A school command explicitly archives a future room after transfer. It
  -- preserves every historical identity and makes a NEW, unconsented session.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  perform public.get_lesson_sessions(student,day+14,day+14);
  select session_id into future_sid from public.lesson_occurrences where tenant_id=tid and source_id=b1::text and class_date=day+14 and status<>'SUPERSEDED';
  perform public.set_lesson_documentation_consent(future_sid,true,'Autorização fictícia para futura sala antes da transferência');
  if to_regclass('private.google_meet_rooms') is not null then
    execute 'insert into private.google_meet_rooms(lesson_session_id,tenant_id,organizer_sub,cohost_email,state,created_by) values($1,$2,$3,$4,$5,$6)'
      using future_sid,tid,'quality-fixture-organizer','qs-teacher2@example.invalid','CREATING',admin_id;
  end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher2,'role','authenticated')::text,true);
  blocked:=false; begin perform public.supersede_future_lesson_session(future_sid,'Professor não pode replanejar unilateralmente'); exception when others then blocked:=sqlerrm='sem_permissao'; end;
  perform pg_temp.quality_assert(blocked,'teacher superseded room without school');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  blocked:=false; begin perform public.supersede_future_lesson_session(future_sid,'Gestão de outra escola não pode replanejar'); exception when others then blocked:=sqlerrm='sem_permissao'; end;
  perform pg_temp.quality_assert(blocked,'other tenant superseded room');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.bookings set teacher_id=teacher where id=b1;
  perform private.sync_lesson_quality_sessions(tid,day+14,day+14,student);
  perform pg_temp.quality_assert((select s.teacher_id=teacher2 from public.lesson_occurrences o join public.lesson_sessions s on s.id=o.session_id
    where o.tenant_id=tid and o.source_id=b1::text and o.class_date=day+14 and o.status<>'SUPERSEDED'),'future room moved before explicit approval');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  blocked:=false; begin perform public.supersede_future_lesson_session(future_sid,''); exception when others then blocked:=sqlerrm='informe_motivo_replanejamento'; end;
  perform pg_temp.quality_assert(blocked,'room replan reason was optional');
  blocked:=false; begin perform public.supersede_future_lesson_session(sid,'Não pode reescrever aula histórica já realizada'); exception when others then blocked:=sqlerrm='somente_sessao_futura_pode_ser_replanejada'; end;
  perform pg_temp.quality_assert(blocked,'past session could be replanned');
  r:=public.supersede_future_lesson_session(future_sid,'Transferência autorizada da turma para novo professor');
  perform pg_temp.quality_assert(r->>'ok'='true' and r->>'external_meet_link_revoked'='false' and jsonb_array_length(r->'new_session_ids')=1,
    'explicit replan did not return replacement or falsely claimed Google revocation: '||r::text);
  new_sid:=(r->'new_session_ids'->>0)::uuid;
  perform pg_temp.quality_assert(new_sid<>future_sid and (select status='SUPERSEDED' and not documentation_consent and teacher_id=teacher2
    from public.lesson_sessions where id=future_sid),'archived session lost its teacher/history or consent stayed enabled');
  perform pg_temp.quality_assert((select teacher_id=teacher and not documentation_consent from public.lesson_sessions where id=new_sid),
    'replacement inherited teacher/consent from archived room');
  perform pg_temp.quality_assert((select count(*)=2 from public.lesson_occurrences where tenant_id=tid and source_id=b1::text and class_date=day+14),
    'replan deleted or moved archived occurrence');
  perform pg_temp.quality_assert((select count(*)=1 from public.lesson_occurrences where tenant_id=tid and source_id=b1::text and class_date=day+14 and status<>'SUPERSEDED'),
    'replan created duplicate active financial identity');
  perform pg_temp.quality_assert((select count(*)=1 from private.lesson_session_revisions where session_id=future_sid and action='SUPERSEDE_FUTURE_SESSION'
    and reason='Transferência autorizada da turma para novo professor'),'explicit replan audit reason missing');
  r:=public.ensure_lesson_session('booking',b1::text,day+14);
  perform pg_temp.quality_assert(r->>'session_id'=new_sid::text,'ensure returned archived occurrence');
  r:=public.supersede_future_lesson_session(future_sid,'Reenvio idempotente da mesma transferência autorizada');
  perform pg_temp.quality_assert(r->>'already'='true' and (select count(*)=1 from private.lesson_session_revisions where session_id=future_sid and action='SUPERSEDE_FUTURE_SESSION'),
    'retry duplicated replan audit');
  if to_regclass('private.google_meet_rooms') is not null then
    execute 'select exists(select 1 from private.google_meet_rooms where lesson_session_id=$1 and cohost_email=$2)'
      into blocked using future_sid,'qs-teacher2@example.invalid';
    perform pg_temp.quality_assert(blocked,'external room reference was deleted/moved during replan');
  end if;
  -- Replanning again at the SAME teacher/time still creates a new identity;
  -- an archived internal grouping key must never reactivate an old room.
  r:=public.supersede_future_lesson_session(new_sid,'Novo planejamento explícito no mesmo professor e horário');
  perform pg_temp.quality_assert((r->'new_session_ids'->>0)::uuid<>new_sid,'repeat replan reactivated archived session');
  new_sid:=(r->'new_session_ids'->>0)::uuid;
  perform pg_temp.quality_assert((select count(*)=1 from public.lesson_occurrences where tenant_id=tid and source_id=b1::text and class_date=day+14 and status<>'SUPERSEDED'),
    'repeat replan broke active source uniqueness');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.attendance_confirmations(id,tenant_id,source_type,source_id,student_id,teacher_id,class_date,class_time,token,token_expires_at,status)
    values(future_aid,tid,'booking',b1::text,student,teacher,day+14,'09:00',encode(extensions.gen_random_bytes(12),'hex'),now()+interval '14 days','PENDING');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  blocked:=false; begin perform public.supersede_future_lesson_session(new_sid,'Não pode alterar identidade da auditoria já criada'); exception when others then blocked:=sqlerrm='audit_already_created_contact_school'; end;
  perform pg_temp.quality_assert(blocked and (select token_expires_at>now() from public.attendance_confirmations where id=future_aid),
    'pending audit was replanned or token mutated');

  if to_regclass('private.lesson_summary_versions') is not null then
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,status,start_date)
      values(b5,tid,teacher,student,dayname,'12:00','SCHEDULED',day-10);
    perform private.sync_lesson_quality_sessions(tid,day+14,day+14,student);
    select session_id into reviewed_sid from public.lesson_occurrences where tenant_id=tid and source_id=b5::text and class_date=day+14 and status<>'SUPERSEDED';
    execute 'insert into private.lesson_summary_versions(tenant_id,lesson_session_id,version,status,origin,content,created_by) values($1,$2,1,''VERIFIED'',''HUMAN_REVIEW'',''{}''::jsonb,$3)'
      using tid,reviewed_sid,admin_id;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
    blocked:=false; begin perform public.supersede_future_lesson_session(reviewed_sid,'Documentação revisada não pode perder identidade'); exception when others then blocked:=sqlerrm='sessao_com_documentacao_revisada_nao_pode_ser_replanejada'; end;
    perform pg_temp.quality_assert(blocked,'reviewed documentation could be superseded');
  end if;
end $test$;
rollback;
