-- Sala oficial: lembrete para quem dá a aula, pela conta central da escola.
create or replace function private.teacher_meet_room_notice(p_session uuid, p_teacher uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.lesson_sessions; t public.profiles; a public.profiles; r private.google_meet_rooms;
  destination text; identity_email text; message text;
begin
  select * into s from public.lesson_sessions where id=p_session;
  if s.id is null or s.teacher_id is distinct from p_teacher or s.status='SUPERSEDED'
    or not s.documentation_consent or private.lesson_session_documentation_blocked(s.id)
    or private.lesson_session_taught_by_other(s.id) then
    return jsonb_build_object('ok',false,'reason','teacher_room_lesson_changed'); end if;
  select * into t from public.profiles where id=s.teacher_id and tenant_id=s.tenant_id;
  select * into a from public.profiles where id=s.student_id and tenant_id=s.tenant_id;
  select * into r from private.google_meet_rooms where lesson_session_id=s.id and tenant_id=s.tenant_id;
  select google_email into identity_email from private.teacher_google_identities
    where teacher_id=s.teacher_id and tenant_id=s.tenant_id and verified_at is not null;
  destination := coalesce(private.normalize_notification_phone(t.attendance_phone),private.normalize_notification_phone(t.phone));
  if t.id is null or t.role<>'TEACHER' or lower(coalesce(t.lifecycle_status,''))<>'active'
    or t.is_test_account is distinct from false
    or a.id is null or a.role<>'STUDENT' or lower(coalesce(a.lifecycle_status,''))<>'active'
    or a.is_test_account is distinct from false or destination is null
    or not exists(select 1 from public.tenant_memberships m where m.tenant_id=s.tenant_id and m.user_id=t.id and m.role='TEACHER' and m.status='ACTIVE')
    or not exists(select 1 from public.tenant_memberships m where m.tenant_id=s.tenant_id and m.user_id=a.id and m.role='STUDENT' and m.status='ACTIVE')
    or r.state is distinct from 'READY' or r.teacher_handover_pending
    or r.cohost_email is distinct from identity_email or identity_email is null
    or r.meeting_uri !~ '^https://meet[.]google[.]com/[a-z-]+$'
    or not exists(select 1 from public.lesson_occurrences o where o.session_id=s.id and o.tenant_id=s.tenant_id
      and o.status<>'SUPERSEDED' and public.official_lesson_link(o.tenant_id,o.source_type,o.source_id,o.class_date,s.teacher_id,o.start_time,s.student_id)=r.meeting_uri) then
    return jsonb_build_object('ok',false,'reason','teacher_room_not_available'); end if;
  message := 'Oi, '||split_part(private.safe_notification_text(t.full_name,120),' ',1)||'! 🐺'||E'\n\n'
    ||'Sua aula com *'||private.safe_notification_text(a.full_name,180)||'* é em '
    ||to_char(s.scheduled_start_at at time zone 'America/Sao_Paulo','DD/MM')||' às *'
    ||to_char(s.scheduled_start_at at time zone 'America/Sao_Paulo','HH24:MI')||'*.'||E'\n\n'
    ||'*Sala oficial desta aula no Google Meet:*'||E'\n'||r.meeting_uri||E'\n\n'
    ||'Professor e aluno devem entrar neste mesmo link. Use a conta Google confirmada no portal: '
    ||identity_email||'. Este link é exclusivo desta aula; confira o link de cada próxima aula na plataforma ou no lembrete.';
  return jsonb_build_object('ok',true,'destination',destination,'message',message,'teacher_id',t.id,
    'tenant_id',s.tenant_id,'student_id',a.id,'class_date',s.class_date,'start_at',s.scheduled_start_at);
end; $$;
alter function private.teacher_meet_room_notice(uuid,uuid) owner to postgres;
revoke all on function private.teacher_meet_room_notice(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.get_teacher_meet_room_notice_snapshot(p_notification_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.notification_queue; snapshot jsonb; start_at timestamptz;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'forbidden' using errcode='42501'; end if;
  select * into q from public.notification_queue where id=p_notification_id;
  if q.id is null or q.notification_kind<>'TEACHER_MEET_ROOM' or q.source_type is distinct from 'MEET_ROOM:'||q.teacher_id::text
    then return jsonb_build_object('ok',false,'reason','teacher_room_binding_invalid'); end if;
  snapshot:=private.teacher_meet_room_notice(q.source_id,q.teacher_id);
  if snapshot->>'tenant_id' is distinct from q.tenant_id or snapshot->>'class_date' is distinct from q.class_date::text
    or snapshot->>'student_id' is distinct from q.student_id::text then
    return jsonb_build_object('ok',false,'reason','teacher_room_binding_changed'); end if;
  if coalesce((snapshot->>'ok')::boolean,false) is not true then return snapshot; end if;
  start_at:=(snapshot->>'start_at')::timestamptz;
  if start_at<=now() then return jsonb_build_object('ok',false,'reason','teacher_room_notice_expired'); end if;
  if start_at>now()+interval '45 minutes' then
    return jsonb_build_object('ok',false,'reason','teacher_room_notice_too_early','defer_seconds',300); end if;
  return snapshot;
end; $$;
alter function public.get_teacher_meet_room_notice_snapshot(uuid) owner to postgres;
revoke all on function public.get_teacher_meet_room_notice_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.get_teacher_meet_room_notice_snapshot(uuid) to service_role;

create or replace function private.queue_teacher_meet_room_notices(p_tenant text default null)
returns integer language plpgsql security definer set search_path='' as $$
declare lesson record; snapshot jsonb; n integer:=0; changed integer;
begin
  for lesson in select s.id,s.teacher_id from public.lesson_sessions s
    join private.google_meet_rooms r on r.lesson_session_id=s.id and r.tenant_id=s.tenant_id
    where s.status<>'SUPERSEDED' and s.scheduled_start_at>now()
      and s.scheduled_start_at<=now()+interval '24 hours' and r.state='READY'
      and (p_tenant is null or s.tenant_id=p_tenant) loop
    snapshot:=private.teacher_meet_room_notice(lesson.id,lesson.teacher_id);
    if coalesce((snapshot->>'ok')::boolean,false) is not true then continue; end if;
    insert into public.notification_queue(tenant_id,teacher_id,student_id,student_phone,message_body,
      scheduled_for,next_attempt_at,status,delivery_status,notification_kind,source_id,source_type,class_date,idempotency_key)
    values(snapshot->>'tenant_id',lesson.teacher_id,(snapshot->>'student_id')::uuid,snapshot->>'destination',snapshot->>'message',
      greatest(now(),(snapshot->>'start_at')::timestamptz-interval '30 minutes'),
      greatest(now(),(snapshot->>'start_at')::timestamptz-interval '30 minutes'),
      'pending','queued','TEACHER_MEET_ROOM',lesson.id,'MEET_ROOM:'||lesson.teacher_id::text,
      (snapshot->>'class_date')::date,'meet-room:'||lesson.id::text||':'||lesson.teacher_id::text)
    on conflict do nothing;
    get diagnostics changed=row_count; n:=n+changed;
  end loop;
  return n;
end; $$;
alter function private.queue_teacher_meet_room_notices(text) owner to postgres;
revoke all on function private.queue_teacher_meet_room_notices(text) from public,anon,authenticated,service_role;

-- A cerca existente continua validando claim, integração e replay; acrescenta
-- revalidação de sala/destinatário/texto ANTES de qualquer autorização ou replay.
do $patch$
declare fn regprocedure:='public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure;
  body text:=pg_get_functiondef(fn); anchor text:=E'  -- Payment confirmations are always paired with the financial outbound'; replacement text;
begin
  if strpos(body,'teacher_meet_room_submission_guard')>0 then return; end if;
  if strpos(body,anchor)=0 then raise exception 'teacher_room_submission_anchor_missing'; end if;
  replacement:=$guard$
  -- teacher_meet_room_submission_guard
  if v_kind='TEACHER_MEET_ROOM' then
    declare snapshot jsonb;
    begin
      begin
        perform 1 from public.lesson_sessions where id=v_notification.source_id for share nowait;
        perform 1 from private.google_meet_rooms where lesson_session_id=v_notification.source_id for share nowait;
        perform 1 from public.profiles where id in(v_notification.teacher_id,v_notification.student_id) order by id for share nowait;
      exception when lock_not_available then
        return jsonb_build_object('ok',false,'action','RETRY','reason','teacher_room_source_busy');
      end;
      snapshot:=public.get_teacher_meet_room_notice_snapshot(v_notification.id);
      if coalesce((snapshot->>'ok')::boolean,false) is not true then
        return jsonb_build_object('ok',false,'action','REVIEW_REQUIRED','reason',coalesce(snapshot->>'reason','teacher_room_not_available'));
      end if;
      if snapshot->>'destination' is distinct from v_expected_destination or snapshot->>'message' is distinct from v_expected_message then
        return jsonb_build_object('ok',false,'action','RETRY','reason','teacher_room_snapshot_changed');
      end if;
    end;
  end if;
$guard$||anchor;
  execute replace(body,anchor,replacement);
end; $patch$;

-- Modos de envio permanecem na fila existente, com recibo e conta central.
select cron.schedule('wisewolf-teacher-meet-room-notices','*/5 * * * *','select private.queue_teacher_meet_room_notices();');
