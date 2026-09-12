-- Institutional Meet documentation. Provider artifacts must never feed teacher
-- performance, attendance decisions or payroll. No participant telemetry exists.
create schema if not exists private;

create unique index if not exists lesson_sessions_id_tenant_google_uidx
  on public.lesson_sessions(id, tenant_id);

create table if not exists private.google_workspace_connections (
  tenant_id text primary key references public.tenants(id),
  organizer_sub text not null,
  organizer_email text not null,
  refresh_token_ciphertext text,
  granted_scopes text[] not null default '{}',
  status text not null check (status in ('CONNECTED','REAUTH_REQUIRED','DISCONNECTED')),
  connected_by uuid not null references public.profiles(id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_error_code text
);

create table if not exists private.google_meet_oauth_states (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  tenant_id text not null references public.tenants(id),
  actor_id uuid not null references public.profiles(id),
  verifier_ciphertext text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists google_meet_oauth_states_expiry_idx
  on private.google_meet_oauth_states(expires_at);

create table if not exists private.google_meet_rooms (
  lesson_session_id uuid primary key,
  tenant_id text not null,
  space_name text unique check (space_name ~ '^spaces/[A-Za-z0-9_-]+$'),
  meeting_uri text check (meeting_uri ~ '^https://meet[.]google[.]com/[a-z-]+$'),
  organizer_sub text not null,
  cohost_email text not null,
  state text not null check (state in ('CREATING','COHOST_PENDING','READY','NEEDS_RECONCILIATION')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error_code text,
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id)
);
create index if not exists google_meet_rooms_sync_idx
  on private.google_meet_rooms(tenant_id, last_synced_at) where state = 'READY';

create table if not exists private.meeting_artifact_revisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  lesson_session_id uuid not null,
  provider_name text not null,
  kind text not null check (kind in ('TRANSCRIPT','SMART_NOTES')),
  document_id text not null check (document_id ~ '^[A-Za-z0-9_-]+$'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  source_text text not null check (length(source_text) between 1 and 500000),
  imported_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id),
  unique (tenant_id, lesson_session_id, provider_name, content_sha256)
);
create index if not exists meeting_artifact_revisions_session_idx
  on private.meeting_artifact_revisions(tenant_id, lesson_session_id, imported_at desc);
create index if not exists meeting_artifact_revisions_expiry_idx
  on private.meeting_artifact_revisions(expires_at);

create table if not exists private.lesson_summary_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  lesson_session_id uuid not null,
  version integer not null check (version > 0),
  parent_version_id uuid references private.lesson_summary_versions(id),
  status text not null check (status in ('PROPOSED','VERIFIED','REJECTED')),
  origin text not null check (origin in ('GOOGLE_SMART_NOTES','GEMINI_API','HUMAN_REVIEW')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  source_artifact_ids uuid[] not null default '{}',
  model_id text,
  prompt_version text,
  review_reason text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id),
  unique (lesson_session_id, version)
);
create index if not exists lesson_summary_versions_tenant_session_idx
  on private.lesson_summary_versions(tenant_id, lesson_session_id, version desc);

create table if not exists private.google_meet_generation_leases (
  lesson_session_id uuid primary key,
  tenant_id text not null,
  acquired_at timestamptz not null,
  actor_id uuid not null,
  foreign key (lesson_session_id,tenant_id) references public.lesson_sessions(id,tenant_id)
);
alter table private.google_meet_generation_leases enable row level security;
revoke all on private.google_meet_generation_leases from public,anon,authenticated;

create table if not exists private.google_meet_access_events (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  actor_id uuid,
  lesson_session_id uuid,
  action text not null,
  created_at timestamptz not null default now()
);
create index if not exists google_meet_access_events_scope_idx
  on private.google_meet_access_events(tenant_id, lesson_session_id, created_at desc);

alter table private.google_workspace_connections enable row level security;
alter table private.google_meet_oauth_states enable row level security;
alter table private.google_meet_rooms enable row level security;
alter table private.meeting_artifact_revisions enable row level security;
alter table private.lesson_summary_versions enable row level security;
alter table private.google_meet_access_events enable row level security;
revoke all on private.google_workspace_connections, private.google_meet_oauth_states,
  private.google_meet_rooms, private.meeting_artifact_revisions,
  private.lesson_summary_versions, private.google_meet_access_events from public, anon, authenticated;

alter table public.student_learning_memories
  drop constraint if exists student_learning_memories_source_type_check;
alter table public.student_learning_memories
  add constraint student_learning_memories_source_type_check check (
    source_type in ('CLASS_LOG','WOLFIE_SESSION','PLANNER_AI','CHATGPT_IMPORT','MANUAL','MEET_SESSION')
  );

-- Only the authenticated Edge Function can call this API. Private schemas are
-- deliberately not exposed to PostgREST, and no token is returned to a browser.
create or replace function public.google_meet_backend(
  p_action text, p_tenant_id text default null, p_actor_id uuid default null,
  p_session_id uuid default null, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.profiles%rowtype;
  s public.lesson_sessions%rowtype;
  c private.google_workspace_connections%rowtype;
  r private.google_meet_rooms%rowtype;
  n private.google_meet_oauth_states%rowtype;
  v private.lesson_summary_versions%rowtype;
  v_id uuid; v_version integer; v_parent uuid; v_status text;
  v_sources uuid[]; v_content jsonb; v_admin boolean := false;
begin
  if p_action = 'nonce_consume' then
    update private.google_meet_oauth_states
       set consumed_at = now()
     where state_hash = p_payload->>'state_hash' and consumed_at is null and expires_at > now()
     returning * into n;
    if not found then raise exception 'oauth_state_invalid' using errcode = '22023'; end if;
    return to_jsonb(n);
  end if;

  select * into a from public.profiles where id = p_actor_id;
  if a.id is null or lower(coalesce(a.lifecycle_status,'')) <> 'active'
    or a.role not in ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR','TEACHER')
    or (a.role <> 'SUPER_ADMIN' and a.tenant_id is distinct from p_tenant_id) then
    raise exception 'google_meet_forbidden' using errcode = '42501';
  end if;
  v_admin := a.role in ('SCHOOL_ADMIN','SUPER_ADMIN');
  if p_action in ('nonce_create','connection_save','disconnect') and not v_admin then
    raise exception 'google_meet_admin_required' using errcode = '42501';
  end if;

  if p_action = 'nonce_create' then
    delete from private.google_meet_oauth_states where expires_at < now() - interval '1 day';
    insert into private.google_meet_oauth_states(state_hash,tenant_id,actor_id,verifier_ciphertext,expires_at)
    values (p_payload->>'state_hash',p_tenant_id,p_actor_id,p_payload->>'verifier_ciphertext',now()+interval '10 minutes');
    return jsonb_build_object('ok',true);
  elsif p_action = 'connection_save' then
    insert into private.google_workspace_connections(tenant_id,organizer_sub,organizer_email,refresh_token_ciphertext,granted_scopes,status,connected_by)
    values (p_tenant_id,p_payload->>'organizer_sub',p_payload->>'organizer_email',p_payload->>'refresh_token_ciphertext',
      array(select jsonb_array_elements_text(p_payload->'granted_scopes')),'CONNECTED',p_actor_id)
    on conflict (tenant_id) do update set organizer_sub=excluded.organizer_sub,organizer_email=excluded.organizer_email,
      refresh_token_ciphertext=excluded.refresh_token_ciphertext,granted_scopes=excluded.granted_scopes,status='CONNECTED',
      connected_by=p_actor_id,connected_at=now(),updated_at=now(),last_error_code=null;
  elsif p_action = 'disconnect' then
    update private.google_workspace_connections set refresh_token_ciphertext=null,status='DISCONNECTED',updated_at=now()
    where tenant_id=p_tenant_id;
    update private.google_meet_oauth_states set consumed_at=coalesce(consumed_at,now()) where tenant_id=p_tenant_id;
  elsif p_action = 'connection_error' then
    update private.google_workspace_connections set status='REAUTH_REQUIRED',last_error_code=left(p_payload->>'error_code',80),updated_at=now()
    where tenant_id=p_tenant_id;
  elsif p_action in ('connection_get','status') then
    select * into c from private.google_workspace_connections where tenant_id=p_tenant_id;
    if p_action='connection_get' then return coalesce(to_jsonb(c),'{}'::jsonb); end if;
    return jsonb_build_object('connection',case when c.tenant_id is null then null else
      jsonb_build_object('organizer_email',c.organizer_email,'status',c.status,'connected_at',c.connected_at,'last_error_code',c.last_error_code) end);
  elsif p_action = 'sync_due' then
    if not v_admin then raise exception 'google_meet_admin_required' using errcode='42501'; end if;
    return coalesce((select jsonb_agg(x) from (
      select room.lesson_session_id from private.google_meet_rooms room
      join public.lesson_sessions sess on sess.id=room.lesson_session_id and sess.tenant_id=room.tenant_id
      where room.tenant_id=p_tenant_id and room.state='READY' and sess.documentation_consent and sess.status<>'SUPERSEDED'
        and sess.scheduled_end_at < now() and sess.scheduled_end_at > now()-interval '28 days'
        and (room.last_synced_at is null or room.last_synced_at < now()-interval '30 minutes')
      order by room.last_synced_at nulls first limit 5
    ) x),'[]'::jsonb);
  else
    select * into s from public.lesson_sessions where id=p_session_id and tenant_id=p_tenant_id;
    if s.id is null then raise exception 'lesson_session_not_found' using errcode='22023'; end if;
    if a.role='TEACHER' and not exists (
      select 1 from public.profiles student where student.id=s.student_id and student.tenant_id=s.tenant_id
      and (student.professor_id=a.id or student.professor_id2=a.id or exists (
        select 1 from public.bookings b where b.student_id=student.id and b.tenant_id=s.tenant_id
        and b.teacher_id=a.id and b.status='SCHEDULED'
      ))
    ) then raise exception 'google_meet_student_scope_required' using errcode='42501'; end if;

    if p_action='room_claim' then
      if not s.documentation_consent then raise exception 'documentation_consent_required' using errcode='42501'; end if;
      if s.status='SUPERSEDED' then raise exception 'lesson_session_superseded' using errcode='22023'; end if;
      if a.role='TEACHER' and s.teacher_id<>a.id then raise exception 'session_teacher_required' using errcode='42501'; end if;
      insert into private.google_meet_rooms(lesson_session_id,tenant_id,organizer_sub,cohost_email,state,created_by)
      values(s.id,s.tenant_id,p_payload->>'organizer_sub',p_payload->>'cohost_email','CREATING',a.id)
      on conflict (lesson_session_id) do nothing returning * into r;
      if r.lesson_session_id is not null then
        insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'ROOM_CREATION_CLAIMED');
        return jsonb_build_object('claimed',true,'room',to_jsonb(r)); end if;
      select * into r from private.google_meet_rooms where lesson_session_id=s.id;
      return jsonb_build_object('claimed',false,'room',to_jsonb(r));
    elsif p_action='room_save' then
      update private.google_meet_rooms set space_name=coalesce(p_payload->>'space_name',space_name),
        meeting_uri=coalesce(p_payload->>'meeting_uri',meeting_uri),state=p_payload->>'state',
        last_error_code=p_payload->>'error_code',updated_at=now()
      where lesson_session_id=s.id and tenant_id=s.tenant_id returning * into r;
      insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'ROOM_'||r.state);
      return to_jsonb(r);
    elsif p_action='sync_complete' then
      update private.google_meet_rooms set last_synced_at=now(),last_error_code=p_payload->>'error_code',updated_at=now()
      where lesson_session_id=s.id and tenant_id=s.tenant_id;
    elsif p_action='artifact_save' then
      if not s.documentation_consent then raise exception 'documentation_consent_required' using errcode='42501'; end if;
      insert into private.meeting_artifact_revisions(tenant_id,lesson_session_id,provider_name,kind,document_id,content_sha256,source_text,expires_at)
      values(s.tenant_id,s.id,p_payload->>'provider_name',p_payload->>'kind',p_payload->>'document_id',p_payload->>'content_sha256',
        p_payload->>'source_text',now()+make_interval(days=>greatest(7,least(365,(p_payload->>'retention_days')::integer))))
      on conflict (tenant_id,lesson_session_id,provider_name,content_sha256) do nothing returning id into v_id;
      if v_id is null then
        select id into v_id from private.meeting_artifact_revisions where tenant_id=s.tenant_id and lesson_session_id=s.id
          and provider_name=p_payload->>'provider_name' and content_sha256=p_payload->>'content_sha256';
        return jsonb_build_object('id',v_id,'inserted',false);
      end if;
      return jsonb_build_object('id',v_id,'inserted',true);
    elsif p_action='summary_claim' then
      insert into private.google_meet_generation_leases(lesson_session_id,tenant_id,acquired_at,actor_id)
      values(s.id,s.tenant_id,now(),a.id)
      on conflict (lesson_session_id) do update set acquired_at=now(),actor_id=a.id
      where private.google_meet_generation_leases.acquired_at < now()-interval '2 minutes'
      returning lesson_session_id into v_id;
      if v_id is null then raise exception 'google_summary_generation_rate_limited' using errcode='55000'; end if;
    elsif p_action='summary_save' then
      perform pg_advisory_xact_lock(hashtextextended('google-meet-summary:'||s.id::text,0));
      v_status := p_payload->>'status';
      v_content := p_payload->'content';
      v_parent := nullif(p_payload->>'parent_version_id','')::uuid;
      v_sources := array(select jsonb_array_elements_text(coalesce(p_payload->'source_artifact_ids','[]'::jsonb)))::uuid[];
      if v_status not in ('PROPOSED','VERIFIED','REJECTED') or jsonb_typeof(v_content)<>'object'
        or octet_length(v_content::text)>150000 then raise exception 'invalid_summary' using errcode='22023'; end if;
      if exists(select 1 from unnest(v_sources) x where not exists(
        select 1 from private.meeting_artifact_revisions ar where ar.id=x and ar.tenant_id=s.tenant_id and ar.lesson_session_id=s.id and ar.expires_at>now()
      )) then raise exception 'summary_artifact_scope_mismatch' using errcode='42501'; end if;
      if v_parent is not null and not exists(select 1 from private.lesson_summary_versions sv
        where sv.id=v_parent and sv.tenant_id=s.tenant_id and sv.lesson_session_id=s.id) then
        raise exception 'summary_parent_scope_mismatch' using errcode='42501'; end if;
      if v_status in ('VERIFIED','REJECTED') and (v_parent is null or p_payload->>'origin'<>'HUMAN_REVIEW') then
        raise exception 'summary_review_required' using errcode='22023'; end if;
      if v_status='VERIFIED' and (length(btrim(coalesce(v_content->>'lesson_objective','')))=0
        or length(btrim(coalesce(v_content->>'recommended_next_step','')))=0) then
        raise exception 'summary_objective_and_next_step_required' using errcode='22023'; end if;
      select coalesce(max(version),0)+1 into v_version from private.lesson_summary_versions where lesson_session_id=s.id;
      insert into private.lesson_summary_versions(tenant_id,lesson_session_id,version,parent_version_id,status,origin,content,
        source_artifact_ids,model_id,prompt_version,review_reason,created_by)
      values(s.tenant_id,s.id,v_version,v_parent,v_status,p_payload->>'origin',v_content,v_sources,
        p_payload->>'model_id',p_payload->>'prompt_version',left(p_payload->>'review_reason',2000),a.id) returning * into v;
      if v_status='VERIFIED' then
        insert into public.student_learning_memories(tenant_id,student_id,source_type,source_ref,occurred_at,
          lesson_objective,content_practiced,recurring_errors,strengths_observed,homework_assigned,recommended_next_step,
          confidence_level,verification_status,metadata,created_by)
        values(s.tenant_id,s.student_id,'MEET_SESSION',s.id::text,s.scheduled_start_at,
          v_content->>'lesson_objective',array(select jsonb_array_elements_text(coalesce(v_content->'content_practiced','[]'::jsonb))),
          array(select jsonb_array_elements_text(coalesce(v_content->'recurring_errors','[]'::jsonb))),
          array(select jsonb_array_elements_text(coalesce(v_content->'strengths_observed','[]'::jsonb))),
          coalesce(v_content->>'homework_assigned',''),v_content->>'recommended_next_step','HIGH','VERIFIED',
          jsonb_build_object('summary_version_id',v.id,'pedagogical_documentation_only',true,'reviewed_by',a.id),a.id)
        on conflict (tenant_id,student_id,source_type,source_ref) do update set
          lesson_objective=excluded.lesson_objective,content_practiced=excluded.content_practiced,
          recurring_errors=excluded.recurring_errors,strengths_observed=excluded.strengths_observed,
          homework_assigned=excluded.homework_assigned,recommended_next_step=excluded.recommended_next_step,
          confidence_level=excluded.confidence_level,verification_status='VERIFIED',metadata=excluded.metadata,updated_at=now();
      end if;
      insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action) values(s.tenant_id,a.id,s.id,'SUMMARY_'||v_status);
      return to_jsonb(v);
    elsif p_action='session_detail' then
      insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
      values(s.tenant_id,a.id,s.id,'READ_PEDAGOGICAL_DOCUMENTATION');
      return jsonb_build_object('session',to_jsonb(s),
        'room',(select to_jsonb(room) from private.google_meet_rooms room where room.lesson_session_id=s.id),
        'artifacts',coalesce((select jsonb_agg(ar order by ar.imported_at desc) from private.meeting_artifact_revisions ar
          where ar.tenant_id=s.tenant_id and ar.lesson_session_id=s.id and ar.expires_at>now()),'[]'::jsonb),
        'summaries',coalesce((select jsonb_agg(sv order by sv.version desc) from private.lesson_summary_versions sv
          where sv.tenant_id=s.tenant_id and sv.lesson_session_id=s.id),'[]'::jsonb));
    else raise exception 'unknown_google_meet_action' using errcode='22023'; end if;
  end if;
  insert into private.google_meet_access_events(tenant_id,actor_id,lesson_session_id,action)
  values(p_tenant_id,p_actor_id,p_session_id,p_action);
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.google_meet_backend(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.google_meet_backend(text,text,uuid,uuid,jsonb) to service_role;

comment on table private.meeting_artifact_revisions is
  'Source-preserving pedagogical documentation only. Never use for teacher performance, attendance or payroll.';
comment on table private.lesson_summary_versions is
  'Append-only proposed and human-reviewed pedagogical summaries; approved version feeds student continuity.';

create or replace function public.get_my_lesson_rooms(
  p_from date default null, p_to date default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.profiles%rowtype;
begin
  select * into a from public.profiles where id=auth.uid();
  if a.id is null or lower(coalesce(a.lifecycle_status,''))<>'active' then
    raise exception 'authentication_required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(x order by x.scheduled_start_at) from (
    select s.id as session_id,s.class_date,s.scheduled_start_at,s.scheduled_end_at,
      case when r.state='READY' then r.meeting_uri else null end as meeting_uri,
      coalesce((select jsonb_agg(jsonb_build_object('source_type',o.source_type,'source_id',o.source_id))
        from public.lesson_occurrences o where o.session_id=s.id and o.tenant_id=s.tenant_id and o.status<>'SUPERSEDED'),'[]'::jsonb) as source_references
    from public.lesson_sessions s
    left join private.google_meet_rooms r on r.lesson_session_id=s.id and r.tenant_id=s.tenant_id
    where s.tenant_id=a.tenant_id and s.status<>'SUPERSEDED'
      and ((a.role='STUDENT' and s.student_id=a.id) or (a.role='TEACHER' and s.teacher_id=a.id)
        or a.role in ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR'))
      and s.class_date between coalesce(p_from,(now() at time zone 'America/Sao_Paulo')::date)
        and coalesce(p_to,coalesce(p_from,(now() at time zone 'America/Sao_Paulo')::date)+30)
    order by s.scheduled_start_at limit 300
  ) x),'[]'::jsonb);
end;
$$;
revoke all on function public.get_my_lesson_rooms(date,date) from public,anon;
grant execute on function public.get_my_lesson_rooms(date,date) to authenticated;

create or replace function public.get_pending_google_meet_sync_sessions()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(x),'[]'::jsonb) from (
    select r.tenant_id,c.connected_by as actor_id,r.lesson_session_id,'SYNC_ARTIFACTS'::text as operation,1 as priority_group,
      coalesce(r.last_synced_at,s.scheduled_end_at) as priority_at
    from private.google_meet_rooms r
    join public.lesson_sessions s on s.id=r.lesson_session_id and s.tenant_id=r.tenant_id
    join private.google_workspace_connections c on c.tenant_id=r.tenant_id and c.organizer_sub=r.organizer_sub
    join public.profiles a on a.id=c.connected_by
    where c.status='CONNECTED' and r.state='READY' and s.documentation_consent and s.status<>'SUPERSEDED'
      and s.scheduled_end_at<now() and s.scheduled_end_at>now()-interval '28 days'
      and (r.last_synced_at is null or r.last_synced_at<now()-interval '30 minutes')
      and lower(coalesce(a.lifecycle_status,''))='active' and a.role in ('SCHOOL_ADMIN','SUPER_ADMIN')
      and (a.tenant_id=c.tenant_id or a.role='SUPER_ADMIN')
    union all
    select s.tenant_id,c.connected_by,s.id,'PREPARE_ROOM',0,s.scheduled_start_at
    from public.lesson_sessions s
    join private.google_workspace_connections c on c.tenant_id=s.tenant_id and c.status='CONNECTED'
    join public.profiles a on a.id=c.connected_by
    left join private.google_meet_rooms r on r.lesson_session_id=s.id
    where s.documentation_consent and s.status='SCHEDULED'
      and s.scheduled_start_at between now() and now()+interval '24 hours'
      and (r.lesson_session_id is null or (r.state='COHOST_PENDING' and r.organizer_sub=c.organizer_sub
        and r.updated_at<now()-interval '1 hour'))
      and lower(coalesce(a.lifecycle_status,''))='active' and a.role in ('SCHOOL_ADMIN','SUPER_ADMIN')
      and (a.tenant_id=c.tenant_id or a.role='SUPER_ADMIN')
    order by priority_group,priority_at limit 3
  ) x;
$$;
revoke all on function public.get_pending_google_meet_sync_sessions() from public,anon,authenticated;
grant execute on function public.get_pending_google_meet_sync_sessions() to service_role;

create or replace function public.trigger_sync_google_meet_artifacts()
returns bigint language plpgsql security definer set search_path='' as $$
declare v_key text; v_request bigint;
begin
  if public.get_pending_google_meet_sync_sessions()='[]'::jsonb then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name='wisewolf_service_role_key' limit 1;
  if nullif(v_key,'') is null then return null; end if;
  select net.http_post(url:='http://kong:8000/functions/v1/google-meet',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),
    body:='{"action":"sync_due"}'::jsonb,timeout_milliseconds:=180000) into v_request;
  return v_request;
end;
$$;
revoke all on function public.trigger_sync_google_meet_artifacts() from public,anon,authenticated;
grant execute on function public.trigger_sync_google_meet_artifacts() to service_role;

-- Retention removes raw copies, not approved pedagogical continuity. Expired
-- sources are unavailable for new approvals even before this daily cleanup.
create or replace function public.purge_expired_meet_artifacts()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  delete from private.meeting_artifact_revisions where expires_at<now();
  get diagnostics v_count=row_count;
  delete from private.google_meet_oauth_states where expires_at<now()-interval '1 day';
  return v_count;
end;
$$;
revoke all on function public.purge_expired_meet_artifacts() from public,anon,authenticated;
grant execute on function public.purge_expired_meet_artifacts() to service_role;
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('wisewolf-meet-raw-retention','17 5 * * *','select public.purge_expired_meet_artifacts();');
    perform cron.schedule('wisewolf-meet-document-sync','*/15 * * * *','select public.trigger_sync_google_meet_artifacts();');
  end if;
end $$;
