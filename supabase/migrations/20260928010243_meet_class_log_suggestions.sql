-- Read-only suggestions for the actual occurrence. Attendance/payroll remain
-- explicit log_teacher_classes commands; this RPC never writes class_logs.
create or replace function public.get_class_log_meet_drafts(p_entries jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor public.profiles%rowtype; e jsonb; result jsonb := '{}';
  matches uuid[]; session public.lesson_sessions%rowtype;
  summary private.lesson_summary_versions%rowtype;
  source_kind text; v_source_id text;
begin
  select * into actor from public.profiles where id=auth.uid();
  if actor.id is null or actor.role <> 'TEACHER'
    or lower(coalesce(actor.lifecycle_status,'')) <> 'active'
    or actor.tenant_id is distinct from public._my_tenant_id()
    or not coalesce(public._my_tenant_is_operational(),false) then
    raise exception 'teacher_profile_required' using errcode='42501';
  end if;
  if jsonb_typeof(p_entries) is distinct from 'array'
    or jsonb_array_length(p_entries) not between 1 and 100 then
    raise exception 'invalid_entries' using errcode='22023';
  end if;
  for e in select value from jsonb_array_elements(p_entries) loop
    source_kind := e->>'source_type'; v_source_id := e->>'source_id';
    if source_kind='advance' then
      select a.booking_id::text into v_source_id from public.lesson_advances a
        where a.id::text=v_source_id and a.tenant_id=actor.tenant_id
          and a.teacher_id=actor.id and a.advance_date::text=e->>'class_date'
          and a.status<>'CANCELLED';
      source_kind := 'booking';
    end if;
    if source_kind not in ('booking','reschedule','appointment')
      or v_source_id is null or nullif(e->>'ref','') is null then continue; end if;
    select array_agg(x.session_id) into matches from (
      select distinct o.session_id from public.lesson_occurrences o
        join public.lesson_sessions s on s.id=o.session_id and s.tenant_id=o.tenant_id
        where o.tenant_id=actor.tenant_id and s.teacher_id=actor.id
          and o.source_type=source_kind and o.source_id=v_source_id
          and o.class_date::text=e->>'class_date'
          and o.status<>'SUPERSEDED' and s.status<>'SUPERSEDED'
        limit 2
    ) x;
    if coalesce(cardinality(matches),0)<>1 then continue; end if;
    select * into session from public.lesson_sessions where id=matches[1];
    if session.scheduled_end_at > now() or not session.documentation_consent
      or private.lesson_session_documentation_blocked(session.id)
      or private.google_meet_session_records_erased(session.id) then continue; end if;
    select * into summary from private.lesson_summary_versions sv
      where sv.tenant_id=actor.tenant_id and sv.lesson_session_id=session.id
        and sv.status in ('PROPOSED','VERIFIED')
        and sv.version > coalesce((select max(r.version) from private.lesson_summary_versions r
          where r.lesson_session_id=session.id and r.tenant_id=actor.tenant_id and r.status='REJECTED'),0)
        and (sv.status='VERIFIED' or (cardinality(sv.source_artifact_ids)>0 and not exists (
          select 1 from unnest(sv.source_artifact_ids) source(id) where not exists (
            select 1 from private.meeting_artifact_revisions ar where ar.id=source.id
              and ar.lesson_session_id=session.id and ar.tenant_id=actor.tenant_id and ar.expires_at>now()
          )
        )))
      order by sv.version desc limit 1;
    if summary.id is null then continue; end if;
    result := result || jsonb_build_object(e->>'ref',jsonb_build_object(
      'sessionId',session.id,'summaryId',summary.id,'status',summary.status,
      'content',jsonb_build_object(
        'lesson_objective',summary.content->'lesson_objective',
        'content_practiced',summary.content->'content_practiced',
        'recurring_errors',summary.content->'recurring_errors',
        'homework_assigned',summary.content->'homework_assigned',
        'recommended_next_step',summary.content->'recommended_next_step',
        'uncertainties',summary.content->'uncertainties'
      )
    ));
    insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
      values(actor.tenant_id,actor.id,session.id,'READ_CLASS_LOG_MEET_DRAFT');
  end loop;
  return result;
end;
$$;
alter function public.get_class_log_meet_drafts(jsonb) owner to postgres;
revoke all on function public.get_class_log_meet_drafts(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_class_log_meet_drafts(jsonb) to authenticated;
