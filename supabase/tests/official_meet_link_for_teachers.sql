\set ON_ERROR_STOP on
begin;
-- All identities are isolated fixtures. The positive eligibility case switches
-- profile flags only INSIDE this rollback; no queue row becomes externally visible.
do $test$
declare t uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); q uuid; claim uuid:=gen_random_uuid();
  start_at timestamptz:=date_trunc('minute',now()+interval '30 minutes'); day date; tm time; result jsonb; denied boolean:=false;
begin
  day:=(start_at at time zone 'America/Sao_Paulo')::date; tm:=(start_at at time zone 'America/Sao_Paulo')::time;
  if has_function_privilege('anon','public.get_teacher_meet_room_notice_snapshot(uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.get_teacher_meet_room_notice_snapshot(uuid)','EXECUTE') then raise exception 'Room notice API exposed'; end if;
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.tenants(id,name) values('teacher-room-fixture','Teacher room fixture');
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
    (t,'teacher-room-teacher@example.invalid','{"provider":"email"}','{"test_fixture":true}'),
    (a,'teacher-room-student@example.invalid','{"provider":"email"}','{"test_fixture":true}');
  update public.profiles set tenant_id='teacher-room-fixture',lifecycle_status='active',is_test_account=true,
    date_automation_enabled=true,full_name='Fixture Room Teacher',phone='11900000001',attendance_phone=null,role='TEACHER' where id=t;
  update public.profiles set tenant_id='teacher-room-fixture',lifecycle_status='active',is_test_account=true,full_name='Fixture Room Student',role='STUDENT' where id=a;
  insert into public.tenant_memberships(tenant_id,user_id,role,status)
    select tenant_id,id,role,'ACTIVE' from public.profiles where id in(t,a)
    on conflict(tenant_id,user_id) do update set role=excluded.role,status='ACTIVE';
  insert into private.lesson_recording_authorization_modes(tenant_id,mode,effective_from,decided_by_name,decided_on,reason,legal_basis,source)
    values('teacher-room-fixture','SCHOOL_DEFAULT',now()-interval '2 days','Fixture',day,'Fixture authorized recording','SCHOOL_CONTRACT_OR_DECISION_WITH_OPT_OUT','APP');
  insert into private.teacher_google_identities(teacher_id,tenant_id,google_sub,google_email,email_verified)
    values(t,'teacher-room-fixture','fixture-sub','fixture-google@example.invalid',true);
  insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,date,start_date,status)
    values(b,'teacher-room-fixture',t,a,(array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from day)::int+1],to_char(tm,'HH24:MI'),day,day,'SCHEDULED');
  insert into public.lesson_sessions(id,tenant_id,student_id,teacher_id,class_date,scheduled_start_at,scheduled_end_at,source_key,documentation_consent)
    values(s,'teacher-room-fixture',a,t,day,start_at,start_at+interval '30 minutes','fixture-room',true);
  insert into public.lesson_occurrences(tenant_id,session_id,source_type,source_id,class_date,start_time,scheduled_start_at,scheduled_end_at,entitlement_date)
    values('teacher-room-fixture',s,'booking',b::text,day,tm,start_at,start_at+interval '30 minutes',day);
  insert into private.google_meet_rooms(lesson_session_id,tenant_id,space_name,meeting_uri,organizer_sub,cohost_email,state,created_by)
    values(s,'teacher-room-fixture','spaces/fixtureRoom','https://meet.google.com/abc-defg-hij','fixture-organizer','fixture-google@example.invalid','READY',t);
  if private.queue_teacher_meet_room_notices('teacher-room-fixture')<>0 then raise exception 'Fixture sent notice'; end if;
  update public.profiles set is_test_account=false where id in(t,a);
  if private.queue_teacher_meet_room_notices('teacher-room-fixture')<>1 then raise exception 'Teacher notice not queued'; end if;
  if private.queue_teacher_meet_room_notices('teacher-room-fixture')<>0 then raise exception 'Duplicate notice'; end if;
  select id into q from public.notification_queue where tenant_id='teacher-room-fixture' and source_id=s and notification_kind='TEACHER_MEET_ROOM';
  result:=public.get_teacher_meet_room_notice_snapshot(q);
  if result->>'ok'<>'true' or result->>'destination'<>'5511900000001' or result->>'message' not like '%https://meet.google.com/abc-defg-hij%'
    or result->>'message' not like '%fixture-google@example.invalid%' or result->>'message' not like '%Fixture Room Student%' then raise exception 'Wrong teacher/link/identity snapshot'; end if;
  update public.notification_queue set status='processing',delivery_status='preparing',claim_token=claim,lease_expires_at=now()+interval '5 minutes' where id=q;
  result:=public.begin_notification_delivery_submission(q,claim,'fixture-instance','5511900000001','5511900000001','WRONG LINK',gen_random_uuid(),1);
  if result->>'reason'<>'teacher_room_snapshot_changed' then raise exception 'Fence accepted wrong link: %',result->>'reason'; end if;
  update private.google_meet_rooms set state='COHOST_PENDING' where lesson_session_id=s;
  if public.get_teacher_meet_room_notice_snapshot(q)->>'ok'='true' then raise exception 'Unready room sent'; end if;
  update private.google_meet_rooms set state='READY' where lesson_session_id=s;
  update public.lesson_sessions set documentation_consent=false where id=s;
  if public.get_teacher_meet_room_notice_snapshot(q)->>'ok'='true' then raise exception 'Blocked lesson sent'; end if;
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  begin perform public.get_teacher_meet_room_notice_snapshot(q); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Authenticated user read teacher destination'; end if;
end; $test$;
rollback;
