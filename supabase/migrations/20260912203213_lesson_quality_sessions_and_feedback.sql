-- Independent family quality feedback and pedagogical sessions. No Meet
-- participant telemetry, teacher score, automatic sanction or payroll write.
create table if not exists public.lesson_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  student_id uuid not null references public.profiles(id),
  teacher_id uuid not null references public.profiles(id),
  class_date date not null,
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  status text not null default 'SCHEDULED' check(status in ('SCHEDULED','LOGGED','SUPERSEDED')),
  source_key text not null,
  teaching_language text not null default 'pt-BR',
  documentation_consent boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,source_key), unique(id,tenant_id),
  check(scheduled_end_at>scheduled_start_at)
);
create index if not exists lesson_sessions_student_date_idx on public.lesson_sessions(tenant_id,student_id,class_date desc);
create index if not exists lesson_sessions_teacher_date_idx on public.lesson_sessions(tenant_id,teacher_id,class_date desc);
create table if not exists public.lesson_occurrences (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references public.tenants(id),
  session_id uuid not null, source_type text not null check(source_type in ('booking','reschedule','appointment')),
  source_id text not null, class_date date not null, start_time time not null,
  scheduled_start_at timestamptz not null, scheduled_end_at timestamptz not null,
  entitlement_date date not null, status text not null default 'SCHEDULED',
  class_log_id uuid references public.class_logs(id),
  created_at timestamptz not null default now(),
  foreign key(session_id,tenant_id) references public.lesson_sessions(id,tenant_id)
);
-- Preserve archived identities; only one active revision may own a source.
-- This is the verified PostgreSQL-generated name from the initial migration.
alter table public.lesson_occurrences drop constraint if exists lesson_occurrences_tenant_id_source_type_source_id_class_da_key;
create unique index if not exists lesson_occurrences_active_source_idx
  on public.lesson_occurrences(tenant_id,source_type,source_id,class_date,start_time) where status<>'SUPERSEDED';
create index if not exists lesson_occurrences_session_idx on public.lesson_occurrences(session_id);
create index if not exists lesson_occurrences_class_log_idx on public.lesson_occurrences(class_log_id);
alter table public.class_logs add column if not exists lesson_session_id uuid references public.lesson_sessions(id);
alter table public.attendance_confirmations
  add column if not exists lesson_session_id uuid references public.lesson_sessions(id),
  add column if not exists quality_recipient_phone text,
  add column if not exists quality_recipient_verified boolean not null default false,
  add column if not exists provider_instance_name text,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists provider_failed_at timestamptz;
create index if not exists class_logs_lesson_session_idx on public.class_logs(lesson_session_id);
create index if not exists attendance_lesson_session_idx on public.attendance_confirmations(lesson_session_id);
create index if not exists attendance_provider_receipt_idx on public.attendance_confirmations(tenant_id,provider_instance_name,provider_message_id);

create or replace function private.can_manage_lesson_quality(p_tenant text) returns boolean
language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and p_tenant=public._my_tenant_id()
    and private.quality_school_manager(p_tenant)
$$;
create or replace function private.can_read_student_pedagogy(p_tenant text,p_student uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and p_tenant=public._my_tenant_id()
    and exists(select 1 from public.profiles actor join public.tenant_memberships membership on membership.user_id=actor.id and membership.tenant_id=p_tenant
      where actor.id=auth.uid() and lower(actor.lifecycle_status)='active' and membership.status='ACTIVE')
    and exists(select 1 from public.profiles subject where subject.id=p_student and subject.tenant_id=p_tenant and subject.role='STUDENT') and (
    private.can_manage_lesson_quality(p_tenant) or exists (
      select 1 from public.profiles p where p.id=p_student and p.tenant_id=p_tenant
        and (p.professor_id=auth.uid() or p.professor_id2=auth.uid() or exists(select 1 from public.bookings b where b.tenant_id=p_tenant and b.student_id=p_student and b.teacher_id=auth.uid() and b.status='SCHEDULED')) and public._my_role()='TEACHER'
    ) or exists (
      select 1 from public.teacher_transfers t where t.tenant_id=p_tenant and t.student_id=p_student
        and t.to_teacher_id=auth.uid() and t.status in ('PENDING','ACCEPTED')
    )
  )
$$;

-- Materialize planned slots, including historical schedule versions. A
-- snapshot with evidence is never rewritten into a different planned time.
create or replace function private.lesson_quality_sources(p_tenant text,p_from date,p_to date,p_student uuid)
returns table(source_type text,source_id text,tenant_id text,teacher_id uuid,student_id uuid,class_date date,start_time time,entitlement_date date)
language sql stable security definer set search_path='' as $$
  with booking_dates as (
    select b.*,d::date as occurrence_date,public.booking_schedule_on_date(b.id,d::date) as schedule
    from public.bookings b cross join generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d
    where b.tenant_id=p_tenant and b.student_id is not null and (p_student is null or b.student_id=p_student)
      and coalesce(b.status,'SCHEDULED')='SCHEDULED' and (b.start_date is null or d::date>=b.start_date)
  ), base as (
    select 'booking'::text as source_type,b.id::text as source_id,b.tenant_id,b.teacher_id,b.student_id,
      b.occurrence_date as class_date,(b.schedule->>'time_slot')::time as start_time,b.occurrence_date as entitlement_date
    from booking_dates b where coalesce((b.schedule->>'valid')::boolean,false)
      and not coalesce((b.schedule->>'excluded')::boolean,false)
      and not exists(select 1 from public.lesson_advances la where la.booking_id=b.id and la.tenant_id=b.tenant_id
        and la.original_date=b.occurrence_date and la.status<>'CANCELLED')
    union all
    select 'booking',a.booking_id::text,a.tenant_id,a.teacher_id,a.student_id,a.advance_date,a.advance_time,a.original_date
      from public.lesson_advances a where a.tenant_id=p_tenant and a.advance_date between p_from and p_to
        and a.status<>'CANCELLED' and (p_student is null or a.student_id=p_student)
    union all
    select 'reschedule',r.id::text,r.tenant_id,r.teacher_id,r.student_id,public.parse_lesson_date(r.date),r.time::time,public.parse_lesson_date(r.date)
      from public.reschedules r where r.tenant_id=p_tenant and public.parse_lesson_date(r.date) between p_from and p_to
        and r.student_id is not null and r.time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and coalesce(upper(to_jsonb(r)->>'status'),'') not in ('CANCELLED','CANCELED')
        and (p_student is null or r.student_id=p_student)
    union all
    select 'appointment',a.id::text,a.tenant_id,a.teacher_id,(to_jsonb(a)->>'student_id')::uuid,
      (a.start_time at time zone 'America/Sao_Paulo')::date,(a.start_time at time zone 'America/Sao_Paulo')::time,
      (a.start_time at time zone 'America/Sao_Paulo')::date
      from public.appointments a where a.tenant_id=p_tenant and nullif(to_jsonb(a)->>'student_id','') is not null
        and (a.start_time at time zone 'America/Sao_Paulo')::date between p_from and p_to
        and lower(coalesce(a.status,'scheduled')) not in ('cancelled','no_show')
        and (p_student is null or (to_jsonb(a)->>'student_id')::uuid=p_student)
  ) select b.source_type,b.source_id,b.tenant_id,coalesce(c.cover_teacher_id,b.teacher_id),b.student_id,b.class_date,b.start_time,b.entitlement_date
      from base b left join lateral (
        select (array_agg(cc.cover_teacher_id order by cc.id))[1] as cover_teacher_id
          from public.class_coverages cc where b.source_type='booking' and cc.booking_id::text=b.source_id
            and cc.tenant_id=b.tenant_id and cc.class_date=b.class_date and lower(cc.status)='confirmed'
            and left(cc.class_time,5)=to_char(b.start_time,'HH24:MI') having count(*)=1
      ) c on true where b.teacher_id is not null
        and exists(select 1 from public.profiles sp where sp.id=b.student_id and sp.tenant_id=b.tenant_id and sp.role='STUDENT')
        and exists(select 1 from public.profiles tp where tp.id=coalesce(c.cover_teacher_id,b.teacher_id) and tp.tenant_id=b.tenant_id and tp.role='TEACHER')
$$;

-- Consent (including revocation), independent attendance and provisioned rooms
-- belong to a particular snapshot. An unlinked row still freezes its matching
-- occurrence while the AFTER INSERT linker is materializing that evidence.
create or replace function private.lesson_session_has_evidence(p_session uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare s public.lesson_sessions; has_room boolean:=false; begin
  select * into s from public.lesson_sessions where id=p_session;
  if not found then return false; end if;
  if s.status='LOGGED' or s.documentation_consent
    or exists(select 1 from private.lesson_documentation_consent_events e where e.session_id=s.id)
    or exists(select 1 from public.class_logs cl where cl.tenant_id=s.tenant_id and cl.student_id=s.student_id and cl.teacher_id=s.teacher_id
      and (cl.lesson_session_id=s.id or exists(select 1 from public.lesson_occurrences o where o.session_id=s.id
        and cl.class_date=o.class_date and cl.start_time=o.start_time
        and (o.class_log_id=cl.id or (o.source_type='booking' and cl.booking_id::text=o.source_id)
          or (o.source_type='reschedule' and cl.reschedule_id::text=o.source_id) or (o.source_type='appointment' and cl.appointment_id::text=o.source_id)))))
    or exists(select 1 from public.attendance_confirmations ac where ac.tenant_id=s.tenant_id and ac.student_id=s.student_id and ac.teacher_id=s.teacher_id
      and (ac.lesson_session_id=s.id or exists(select 1 from public.lesson_occurrences o where o.session_id=s.id
        and ac.source_type=o.source_type and ac.source_id::text=o.source_id and ac.class_date=o.class_date
        and left(ac.class_time,5)=to_char(o.start_time,'HH24:MI')))) then return true; end if;
  -- Google integration is a later, optional migration; do not resolve its
  -- relation during this migration or require it for the local quality flow.
  if to_regclass('private.google_meet_rooms') is not null then
    execute 'select exists(select 1 from private.google_meet_rooms where lesson_session_id=$1 and tenant_id=$2)'
      into has_room using s.id,s.tenant_id;
  end if;
  return has_room;
end $$;
revoke all on function private.lesson_session_has_evidence(uuid) from public,anon,authenticated,service_role;

create or replace function private.sync_lesson_quality_sessions(p_tenant text,p_from date,p_to date,p_student uuid default null)
returns integer language plpgsql security definer set search_path='' as $$
declare g record; e jsonb; sid uuid; session_key text; n integer:=0; begin
  if p_tenant is null or p_from is null or p_to is null or p_to<p_from or p_to-p_from>31 then raise exception 'intervalo_invalido'; end if;
  perform pg_advisory_xact_lock(hashtextextended('lesson-quality:'||p_tenant,0));
  update public.lesson_sessions s set status='SUPERSEDED',updated_at=now()
    where s.tenant_id=p_tenant and s.class_date between p_from and p_to
      and (p_student is null or s.student_id=p_student) and s.status='SCHEDULED'
      and not private.lesson_session_has_evidence(s.id);
  for g in
    with frozen as materialized (select s.id from public.lesson_sessions s
      where s.tenant_id=p_tenant and s.class_date between p_from and p_to
        and s.status<>'SUPERSEDED' and (p_student is null or s.student_id=p_student) and private.lesson_session_has_evidence(s.id)),
    src as (select q.* from private.lesson_quality_sources(p_tenant,p_from,p_to,p_student) q
      where not exists(select 1 from public.lesson_occurrences o join frozen f on f.id=o.session_id
        where o.status<>'SUPERSEDED' and o.tenant_id=q.tenant_id and o.source_type=q.source_type and o.source_id=q.source_id
          and o.class_date=q.class_date and o.start_time=q.start_time)),
    lagged as (select *,lag(start_time) over(partition by student_id,teacher_id,class_date order by start_time,source_type,source_id) as prev from src),
    grouped as (select *,sum(case when prev is null or start_time>prev+interval '30 minutes' then 1 else 0 end)
      over(partition by student_id,teacher_id,class_date order by start_time,source_type,source_id) as grp from lagged)
    select student_id,teacher_id,class_date,min(start_time) as first_time,max(start_time) as last_time,
      jsonb_agg(to_jsonb(grouped) order by start_time) as slots from grouped group by student_id,teacher_id,class_date,grp
  loop
    session_key:=g.student_id::text||':'||g.teacher_id::text||':'||g.class_date::text||':'||g.first_time::text;
    -- Distinct simultaneous sources must not inherit a frozen room/consent.
    if exists(select 1 from public.lesson_sessions s where s.tenant_id=p_tenant and s.source_key=session_key
      and private.lesson_session_has_evidence(s.id)) then
      session_key:=session_key||':revision:'||md5(g.slots::text);
    end if;
    insert into public.lesson_sessions(tenant_id,student_id,teacher_id,class_date,scheduled_start_at,scheduled_end_at,source_key)
      values(p_tenant,g.student_id,g.teacher_id,g.class_date,(g.class_date+g.first_time) at time zone 'America/Sao_Paulo',
        (g.class_date+g.last_time+interval '30 minutes') at time zone 'America/Sao_Paulo',
        session_key)
      on conflict(tenant_id,source_key) do update set status=case when lesson_sessions.status='LOGGED' then 'LOGGED' else 'SCHEDULED' end,
        scheduled_end_at=case when private.lesson_session_has_evidence(lesson_sessions.id) then lesson_sessions.scheduled_end_at else excluded.scheduled_end_at end,
        updated_at=now() returning id into sid;
    for e in select value from jsonb_array_elements(g.slots) loop
      insert into public.lesson_occurrences(tenant_id,session_id,source_type,source_id,class_date,start_time,scheduled_start_at,scheduled_end_at,entitlement_date)
        values(p_tenant,sid,e->>'source_type',e->>'source_id',g.class_date,(e->>'start_time')::time,
          (g.class_date+(e->>'start_time')::time) at time zone 'America/Sao_Paulo',
          (g.class_date+(e->>'start_time')::time+interval '30 minutes') at time zone 'America/Sao_Paulo',(e->>'entitlement_date')::date)
        on conflict(tenant_id,source_type,source_id,class_date,start_time) where status<>'SUPERSEDED' do update set session_id=excluded.session_id
          where lesson_occurrences.class_log_id is null and not private.lesson_session_has_evidence(lesson_occurrences.session_id);
    end loop;
    n:=n+1;
  end loop;
  -- Removed/changed no-evidence schedule slots must not remain active routing
  -- identities after their old grouping has been superseded.
  update public.lesson_occurrences o set status='SUPERSEDED' from public.lesson_sessions s
    where o.session_id=s.id and o.tenant_id=p_tenant and s.tenant_id=o.tenant_id and s.status='SUPERSEDED'
      and s.class_date between p_from and p_to and (p_student is null or s.student_id=p_student)
      and o.status<>'SUPERSEDED' and o.class_log_id is null;
  update public.lesson_occurrences o set class_log_id=cl.id,status='LOGGED' from public.class_logs cl,public.lesson_sessions s
    where o.tenant_id=p_tenant and cl.tenant_id=o.tenant_id and cl.student_id is not null and o.status<>'SUPERSEDED' and s.status<>'SUPERSEDED'
      and s.id=o.session_id and s.tenant_id=o.tenant_id and s.teacher_id=cl.teacher_id and s.student_id=cl.student_id
      and (o.class_log_id is null or o.class_log_id=cl.id) and (p_student is null or s.student_id=p_student)
      and cl.class_date=o.class_date and cl.start_time=o.start_time and o.class_date between p_from and p_to
      and ((o.source_type='booking' and cl.booking_id::text=o.source_id) or (o.source_type='reschedule' and cl.reschedule_id::text=o.source_id)
        or (o.source_type='appointment' and cl.appointment_id::text=o.source_id));
  update public.class_logs cl set lesson_session_id=o.session_id from public.lesson_occurrences o,public.lesson_sessions s
    where o.tenant_id=p_tenant and o.class_log_id=cl.id and cl.tenant_id=o.tenant_id and cl.lesson_session_id is null and o.status<>'SUPERSEDED' and s.status<>'SUPERSEDED'
      and s.id=o.session_id and s.tenant_id=o.tenant_id and s.teacher_id=cl.teacher_id and s.student_id=cl.student_id
      and (p_student is null or s.student_id=p_student);
  update public.lesson_sessions s set status='LOGGED' where s.tenant_id=p_tenant and s.class_date between p_from and p_to and s.status<>'SUPERSEDED'
    and exists(select 1 from public.lesson_occurrences o where o.session_id=s.id and o.class_log_id is not null and o.status<>'SUPERSEDED');
  update public.attendance_confirmations ac set lesson_session_id=o.session_id from public.lesson_occurrences o,public.lesson_sessions s
    where o.tenant_id=p_tenant and ac.tenant_id=o.tenant_id and ac.source_type=o.source_type and ac.source_id::text=o.source_id and o.status<>'SUPERSEDED' and s.status<>'SUPERSEDED'
      and s.id=o.session_id and s.tenant_id=o.tenant_id and s.teacher_id=ac.teacher_id and s.student_id=ac.student_id
      and (p_student is null or s.student_id=p_student)
      and ac.class_date=o.class_date and left(ac.class_time,5)=to_char(o.start_time,'HH24:MI')
      and ac.lesson_session_id is null;
  return n;
end $$;

create or replace function public.get_lesson_sessions(p_student_id uuid default null,p_from date default null,p_to date default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t text:=public._my_tenant_id(); f date:=coalesce(p_from,(now() at time zone 'America/Sao_Paulo')::date-7);
  d date:=coalesce(p_to,(now() at time zone 'America/Sao_Paulo')::date+7); result jsonb;
begin
  if auth.uid() is null or t is null or (p_student_id is null and public._my_role() not in ('TEACHER','COORDINATOR','SCHOOL_ADMIN','SUPER_ADMIN'))
    or (p_student_id is not null and not private.can_read_student_pedagogy(t,p_student_id)) then raise exception 'sem_permissao'; end if;
  perform private.sync_lesson_quality_sessions(t,f,d,p_student_id);
  select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('student_name',sp.full_name,'teacher_name',tp.full_name) order by s.scheduled_start_at desc),'[]'::jsonb)
    into result from public.lesson_sessions s join public.profiles sp on sp.id=s.student_id join public.profiles tp on tp.id=s.teacher_id
    where s.tenant_id=t and s.class_date between f and d and s.status<>'SUPERSEDED' and (p_student_id is null or s.student_id=p_student_id)
      and (private.can_manage_lesson_quality(t) or private.can_read_student_pedagogy(t,s.student_id));
  return jsonb_build_object('ok',true,'sessions',result);
end $$;
create or replace function public.ensure_lesson_session(p_source_type text,p_source_id text,p_class_date date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t text:=public._my_tenant_id(); r record; sid uuid; begin
  select * into r from private.lesson_quality_sources(t,p_class_date,p_class_date,null)
    where source_type=p_source_type and source_id=p_source_id limit 1;
  if not found or not private.can_read_student_pedagogy(t,r.student_id) then raise exception 'sem_permissao'; end if;
  perform private.sync_lesson_quality_sessions(t,p_class_date,p_class_date,r.student_id);
  select o.session_id into sid from public.lesson_occurrences o join public.lesson_sessions s on s.id=o.session_id and s.tenant_id=o.tenant_id
    where o.tenant_id=t and o.source_type=p_source_type and o.source_id=p_source_id and o.class_date=p_class_date
      and o.status<>'SUPERSEDED' and s.status<>'SUPERSEDED';
  return jsonb_build_object('ok',sid is not null,'session_id',sid);
end $$;

create table if not exists private.lesson_documentation_consent_events (
  id uuid primary key default gen_random_uuid(),session_id uuid not null references public.lesson_sessions(id),
  actor_id uuid not null references public.profiles(id),allowed boolean not null,reason text not null,created_at timestamptz not null default now()
);
create or replace function public.set_lesson_documentation_consent(p_session_id uuid,p_allowed boolean,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.lesson_sessions; begin
  select * into s from public.lesson_sessions where id=p_session_id for update;
  if not found or not private.can_manage_lesson_quality(s.tenant_id) then raise exception 'sem_permissao'; end if;
  if p_allowed is null or length(trim(coalesce(p_reason,'')))<10 then raise exception 'registre_a_base_e_o_comprovante_da_autorizacao'; end if;
  insert into private.lesson_documentation_consent_events(session_id,actor_id,allowed,reason) values(s.id,auth.uid(),p_allowed,left(trim(p_reason),2000));
  update public.lesson_sessions set documentation_consent=p_allowed,updated_at=now() where id=s.id;
  return jsonb_build_object('ok',true);
end $$;

create table if not exists public.lesson_quality_cases (
  id uuid primary key default gen_random_uuid(),tenant_id text not null references public.tenants(id),
  session_id uuid references public.lesson_sessions(id),confirmation_id uuid references public.attendance_confirmations(id),
  student_id uuid not null references public.profiles(id),teacher_id uuid references public.profiles(id),
  category text not null check(category in ('LATE_START','EARLY_END','SCHEDULE_CHANGE','DID_NOT_HAPPEN','OTHER','DELIVERY_FAILURE','MISSING_LOG')),
  source text not null check(source in ('FAMILY','WHATSAPP','SCHOOL','SYSTEM')),
  status text not null default 'OPEN' check(status in ('OPEN','IN_REVIEW','WAITING','RESOLVED','FOLLOWUP')),
  severity text not null default 'NORMAL' check(severity in ('LOW','NORMAL','HIGH')),
  description text not null,assigned_to uuid references public.profiles(id),resolution text,
  dedupe_key text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),resolved_at timestamptz,
  unique(tenant_id,dedupe_key)
);
create index if not exists lesson_quality_cases_queue_idx on public.lesson_quality_cases(tenant_id,status,created_at desc);
create index if not exists lesson_quality_cases_session_idx on public.lesson_quality_cases(session_id);
create index if not exists lesson_quality_cases_confirmation_idx on public.lesson_quality_cases(confirmation_id);
create index if not exists lesson_quality_cases_student_idx on public.lesson_quality_cases(student_id);
create index if not exists lesson_quality_cases_teacher_idx on public.lesson_quality_cases(teacher_id);
create index if not exists lesson_quality_cases_assigned_idx on public.lesson_quality_cases(assigned_to);
create table if not exists public.lesson_quality_case_events (
  id uuid primary key default gen_random_uuid(),tenant_id text not null references public.tenants(id),
  case_id uuid not null references public.lesson_quality_cases(id),actor_id uuid references public.profiles(id),
  event_type text not null,details jsonb not null,created_at timestamptz not null default now()
);
create index if not exists lesson_quality_events_case_idx on public.lesson_quality_case_events(case_id,created_at);
create table if not exists private.lesson_quality_feedback (
  id uuid primary key default gen_random_uuid(),tenant_id text not null references public.tenants(id),
  confirmation_id uuid not null references public.attendance_confirmations(id),session_id uuid references public.lesson_sessions(id),
  happened text not null check(happened in ('YES','NO','UNKNOWN')),
  punctuality text not null check(punctuality in ('ON_TIME','LATE','UNKNOWN')),
  ended_early text not null check(ended_early in ('NO','YES','UNKNOWN')),
  reschedule_by text not null check(reschedule_by in ('NONE','TEACHER','FAMILY','SCHOOL','UNKNOWN')),
  comment text not null default '',actor_id uuid,created_at timestamptz not null default now()
);
create index if not exists lesson_quality_feedback_confirmation_idx on private.lesson_quality_feedback(confirmation_id,created_at desc);
alter table private.lesson_quality_feedback add column if not exists revision bigint generated always as identity;
alter table private.lesson_quality_feedback alter column created_at set default clock_timestamp();
revoke all on sequence private.lesson_quality_feedback_revision_seq from public,anon,authenticated,service_role;

create or replace function private.record_lesson_quality_feedback(p_confirmation_id uuid,p_payload jsonb,p_actor_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.attendance_confirmations; previous private.lesson_quality_feedback; fid uuid; k text; cid uuid;
  happened text:=coalesce(p_payload->>'happened','UNKNOWN'); punctuality text:=coalesce(p_payload->>'punctuality','UNKNOWN');
  early text:=coalesce(p_payload->>'ended_early','UNKNOWN'); changed text:=coalesce(p_payload->>'reschedule_by','UNKNOWN');
  note text:=trim(coalesce(p_payload->>'comment',''));
begin
  select * into c from public.attendance_confirmations where id=p_confirmation_id for update;
  if not found or c.student_id is null or c.status='CANCELLED' or c.delivery_status='CANCELLED'
    then return jsonb_build_object('ok',false,'error','confirmacao_indisponivel'); end if;
  if happened not in ('YES','NO','UNKNOWN') or punctuality not in ('ON_TIME','LATE','UNKNOWN') or early not in ('NO','YES','UNKNOWN')
    or changed not in ('NONE','TEACHER','FAMILY','SCHOOL','UNKNOWN') or length(note)>2000 then return jsonb_build_object('ok',false,'error','resposta_invalida'); end if;
  select * into previous from private.lesson_quality_feedback where confirmation_id=c.id order by revision desc limit 1;
  if previous.id is not null then
    if previous.happened=happened and previous.punctuality=punctuality and previous.ended_early=early and previous.reschedule_by=changed and previous.comment=note
      then return jsonb_build_object('ok',true,'already',true); end if;
    if (select min(created_at)+interval '30 minutes' from private.lesson_quality_feedback where confirmation_id=c.id)<now()
      then return jsonb_build_object('ok',false,'error','prazo_correcao_encerrado'); end if;
  end if;
  insert into private.lesson_quality_feedback(tenant_id,confirmation_id,session_id,happened,punctuality,ended_early,reschedule_by,comment,actor_id)
    values(c.tenant_id,c.id,c.lesson_session_id,happened,punctuality,early,changed,note,p_actor_id) returning id into fid;
  foreach k in array array[
    case when punctuality='LATE' then 'LATE_START' end,case when early='YES' then 'EARLY_END' end,
    case when changed='TEACHER' then 'SCHEDULE_CHANGE' end,case when happened='NO' then 'DID_NOT_HAPPEN' end,
    case when note<>'' then 'OTHER' end] loop
    if k is null then continue; end if;
    insert into public.lesson_quality_cases(tenant_id,session_id,confirmation_id,student_id,teacher_id,category,source,description,dedupe_key)
      values(c.tenant_id,c.lesson_session_id,c.id,c.student_id,c.teacher_id,k,'FAMILY',coalesce(nullif(note,''),'Relato da família: '||k),c.id::text||':'||k)
      on conflict(tenant_id,dedupe_key) do update set updated_at=now(),status=case when lesson_quality_cases.status='RESOLVED' then 'FOLLOWUP' else lesson_quality_cases.status end
      returning id into cid;
    insert into public.lesson_quality_case_events(tenant_id,case_id,actor_id,event_type,details)
      values(c.tenant_id,cid,p_actor_id,'FAMILY_REPORT',jsonb_build_object('feedback_id',fid,'happened',happened,'punctuality',punctuality,'ended_early',early,'reschedule_by',changed,'comment',note));
  end loop;
  -- Corrections preserve evidence and notify the reviewer; never delete the
  -- original report or automatically close a case that is being investigated.
  if previous.id is not null then
    insert into public.lesson_quality_case_events(tenant_id,case_id,actor_id,event_type,details)
      select c.tenant_id,q.id,p_actor_id,'FEEDBACK_CORRECTED',jsonb_build_object('feedback_id',fid,'previous_feedback_id',previous.id,'response',p_payload)
        from public.lesson_quality_cases q where q.confirmation_id=c.id;
  end if;
  return jsonb_build_object('ok',true,'feedback_id',fid);
end $$;
create or replace function public.submit_lesson_quality_feedback(p_token text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.attendance_confirmations; begin
  select * into c from public.attendance_confirmations where token=p_token for update;
  if not found or c.token_expires_at<=now() or not private.attendance_quality_contact_is_current(c.id) then return jsonb_build_object('ok',false,'error','link_invalido_ou_expirado'); end if;
  return private.record_lesson_quality_feedback(coalesce(c.canonical_confirmation_id,c.id),p_payload,null);
end $$;

-- Public links and quoted WhatsApp replies share the same revocation rule.
-- Old pre-rollout deliveries without a bound recipient remain compatible;
-- their uncertainty is visible in the dashboard, never labelled verified.
create or replace function private.quality_delivery_phone(p_value text)
returns text language sql immutable set search_path='' as $$
  with digits as (select regexp_replace(coalesce(p_value,''),'[^0-9]','','g') as value),
  normalized as (select case when length(value) in (10,11) then '55'||value else value end as value from digits)
  select case when length(value) between 12 and 15 then value end from normalized
$$;
alter function private.quality_delivery_phone(text) owner to postgres;
revoke all on function private.quality_delivery_phone(text) from public,anon,authenticated,service_role;
create or replace function private.attendance_quality_contact_is_current(p_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select case when c.quality_recipient_phone is null then true
    when c.quality_recipient_verified then exists(select 1 from public.student_quality_contacts qc
      where qc.student_id=c.student_id and qc.tenant_id=c.tenant_id and qc.active and qc.verified_at is not null and qc.phone=c.quality_recipient_phone)
    else exists(select 1 from public.profiles p where p.id=c.student_id and p.tenant_id=c.tenant_id
      and lower(p.lifecycle_status)='active' and coalesce(private.quality_delivery_phone(p.attendance_phone),private.quality_delivery_phone(p.phone))=c.quality_recipient_phone) end
    from public.attendance_confirmations requested join public.attendance_confirmations c on c.id=coalesce(requested.canonical_confirmation_id,requested.id)
    where requested.id=p_id),false)
$$;
alter function private.attendance_quality_contact_is_current(uuid) owner to postgres;
revoke all on function private.attendance_quality_contact_is_current(uuid) from public,anon,authenticated,service_role;

do $capture_public_attendance$ declare definition text; begin
  definition:=pg_get_functiondef('public.get_confirmation_public(text)'::regprocedure);
  if position('attendance_quality_contact_is_current' in definition)=0 then
    definition:=replace(definition,'FUNCTION public.get_confirmation_public(', 'FUNCTION private.get_confirmation_before_quality_contact(');
    execute definition;
  end if;
  definition:=pg_get_functiondef('public.rate_attendance(text,integer)'::regprocedure);
  if position('attendance_quality_contact_is_current' in definition)=0 then
    definition:=replace(definition,'FUNCTION public.rate_attendance(', 'FUNCTION private.rate_attendance_before_quality_contact(');
    execute definition;
  end if;
end $capture_public_attendance$;
alter function private.get_confirmation_before_quality_contact(text) owner to postgres;
alter function private.rate_attendance_before_quality_contact(text,integer) owner to postgres;
revoke all on function private.get_confirmation_before_quality_contact(text),private.rate_attendance_before_quality_contact(text,integer) from public,anon,authenticated,service_role;
create or replace function public.get_confirmation_public(p_token text) returns jsonb language plpgsql security definer set search_path='' as $$
declare cid uuid; begin
  select id into cid from public.attendance_confirmations where token=p_token;
  if not private.attendance_quality_contact_is_current(cid) then return jsonb_build_object('found',false); end if;
  return private.get_confirmation_before_quality_contact(p_token);
end $$;
create or replace function public.apply_student_response(p_token text,p_response text) returns jsonb language plpgsql security definer set search_path='' as $$
declare cid uuid; begin
  select id into cid from public.attendance_confirmations where token=p_token;
  if not private.attendance_quality_contact_is_current(cid) then return jsonb_build_object('ok',false,'error','link_invalido_ou_expirado'); end if;
  return private.apply_attendance_response(null,p_token,p_response,null,'PUBLIC_TOKEN');
end $$;
create or replace function public.rate_attendance(p_token text,p_stars integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare cid uuid; begin
  select id into cid from public.attendance_confirmations where token=p_token;
  if not private.attendance_quality_contact_is_current(cid) then return jsonb_build_object('ok',false,'error','link_invalido_ou_expirado'); end if;
  return private.rate_attendance_before_quality_contact(p_token,p_stars);
end $$;
alter function public.get_confirmation_public(text) owner to postgres;
alter function public.apply_student_response(text,text) owner to postgres;
alter function public.rate_attendance(text,integer) owner to postgres;
revoke all on function public.get_confirmation_public(text),public.apply_student_response(text,text),public.rate_attendance(text,integer) from public;
grant execute on function public.get_confirmation_public(text),public.apply_student_response(text,text),public.rate_attendance(text,integer) to anon,authenticated;
create or replace function public.submit_my_lesson_quality_feedback(p_confirmation_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.attendance_confirmations; begin
  select * into c from public.attendance_confirmations where id=p_confirmation_id and student_id=auth.uid() and tenant_id=public._my_tenant_id();
  if not found or c.token_expires_at<=now() then return jsonb_build_object('ok',false,'error','sem_permissao'); end if;
  return private.record_lesson_quality_feedback(coalesce(c.canonical_confirmation_id,c.id),p_payload,auth.uid());
end $$;

create or replace function public.review_lesson_quality_case(p_case_id uuid,p_status text,p_note text,p_assigned_to uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.lesson_quality_cases; begin
  select * into c from public.lesson_quality_cases where id=p_case_id for update;
  if not found or not private.can_manage_lesson_quality(c.tenant_id) then raise exception 'sem_permissao'; end if;
  if p_status not in ('OPEN','IN_REVIEW','WAITING','RESOLVED','FOLLOWUP') or length(trim(coalesce(p_note,'')))<5 then raise exception 'status_ou_justificativa_invalida'; end if;
  if p_assigned_to is not null and not exists(select 1 from public.profiles p where p.id=p_assigned_to and p.tenant_id=c.tenant_id and p.role in ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') and lower(p.lifecycle_status)='active') then raise exception 'responsavel_invalido'; end if;
  update public.lesson_quality_cases set status=p_status,assigned_to=p_assigned_to,resolution=left(trim(p_note),4000),updated_at=now(),resolved_at=case when p_status='RESOLVED' then now() else null end where id=c.id;
  insert into public.lesson_quality_case_events(tenant_id,case_id,actor_id,event_type,details)
    values(c.tenant_id,c.id,auth.uid(),'REVIEW',jsonb_build_object('from',c.status,'to',p_status,'note',left(trim(p_note),4000),'assigned_to',p_assigned_to));
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.get_lesson_quality_dashboard(p_from date default null,p_to date default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t text:=public._my_tenant_id(); f date:=coalesce(p_from,(now() at time zone 'America/Sao_Paulo')::date-7);
  d date:=coalesce(p_to,(now() at time zone 'America/Sao_Paulo')::date); counts jsonb; cases jsonb; sessions jsonb;
begin
  if not private.can_manage_lesson_quality(t) then raise exception 'sem_permissao'; end if;
  perform private.sync_lesson_quality_sessions(t,f,d,null);
  select jsonb_build_object('eligible',count(*),'sent',count(*) filter(where a.sent_at is not null),
    'delivered',count(*) filter(where a.delivered_at is not null),'read',count(*) filter(where a.read_at is not null),
    'responded',count(*) filter(where a.student_response is not null or exists(select 1 from private.lesson_quality_feedback q where q.confirmation_id=a.id)),
    'failed',count(*) filter(where a.delivery_status in ('FAILED','AMBIGUOUS') or a.provider_failed_at is not null),
    'unverified_contact',count(*) filter(where not a.quality_recipient_verified),
    'unknown',count(*) filter(where (select q.happened from private.lesson_quality_feedback q where q.confirmation_id=a.id order by q.revision desc limit 1)='UNKNOWN'))
    into counts from public.attendance_confirmations a where a.tenant_id=t and a.class_date between f and d and coalesce(a.canonical_confirmation_id,a.id)=a.id and a.delivery_status<>'CANCELLED';
  select coalesce(jsonb_agg(to_jsonb(q)||jsonb_build_object('student_name',sp.full_name,'teacher_name',tp.full_name,
    'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at),'[]'::jsonb) from public.lesson_quality_case_events e where e.case_id=q.id)) order by q.created_at desc),'[]'::jsonb)
    into cases from (select * from public.lesson_quality_cases where tenant_id=t and (status<>'RESOLVED' or created_at::date between f and d) order by created_at desc limit 200) q
    join public.profiles sp on sp.id=q.student_id left join public.profiles tp on tp.id=q.teacher_id;
  sessions:=public.get_lesson_sessions(null,f,d)->'sessions';
  return jsonb_build_object('ok',true,'counts',counts||jsonb_build_object('planned',jsonb_array_length(sessions),
    'missing_log',(select count(*) from public.lesson_sessions s where s.tenant_id=t and s.class_date between f and d and s.status='SCHEDULED' and s.scheduled_end_at<now()-interval '24 hours')),
    'cases',cases,'sessions',sessions,'reviewers',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name)),'[]'::jsonb) from public.profiles p where p.tenant_id=t and p.role in ('SCHOOL_ADMIN','COORDINATOR') and lower(p.lifecycle_status)='active'));
end $$;

-- Delivery identity is bound BEFORE external send. If a webhook arrives
-- before finalization, finalization reconciles the previously stored receipt.
create or replace function public.bind_attendance_quality_delivery(p_confirmation_id uuid,p_claim_token uuid,p_instance text,p_phone text,p_verified boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role()<>'service_role' then raise exception 'sem_permissao'; end if;
  if p_instance is null or p_phone !~ '^[0-9]{10,15}$' then raise exception 'destinatario_invalido'; end if;
  update public.attendance_confirmations set provider_instance_name=lower(trim(p_instance)),quality_recipient_phone=p_phone,quality_recipient_verified=coalesce(p_verified,false)
    where id=p_confirmation_id and delivery_claim_token=p_claim_token and delivery_status='PROCESSING';
  return jsonb_build_object('ok',found);
end $$;
create or replace function private.link_attendance_quality_receipt() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='whatsapp_provider_delivery_receipts' then
    update public.attendance_confirmations a set delivered_at=coalesce(a.delivered_at,new.delivered_at),read_at=coalesce(a.read_at,new.read_at),
      provider_failed_at=case when new.delivery_status='failed' and a.delivered_at is null and new.delivered_at is null then coalesce(a.provider_failed_at,now()) else null end
      where a.tenant_id=new.tenant_id and a.provider_instance_name=new.provider_instance_name and a.provider_message_id=new.provider_message_id;
    return new;
  end if;
  select coalesce(new.delivered_at,r.delivered_at),coalesce(new.read_at,r.read_at),case when r.delivery_status='failed' and r.delivered_at is null then now() else null end
    into new.delivered_at,new.read_at,new.provider_failed_at from private.whatsapp_provider_delivery_receipts r
    where r.tenant_id=new.tenant_id and r.provider_instance_name=new.provider_instance_name and r.provider_message_id=new.provider_message_id;
  return new;
end $$;
drop trigger if exists attendance_quality_receipt on private.whatsapp_provider_delivery_receipts;
create trigger attendance_quality_receipt after insert or update on private.whatsapp_provider_delivery_receipts for each row execute function private.link_attendance_quality_receipt();
drop trigger if exists attendance_quality_receipt_finalize on public.attendance_confirmations;
create trigger attendance_quality_receipt_finalize before update of provider_message_id on public.attendance_confirmations for each row execute function private.link_attendance_quality_receipt();

-- Continuity dossier is authenticated. Public transfer tokens never expose it.
create table if not exists private.student_handover_reads (
  id uuid primary key default gen_random_uuid(),tenant_id text not null references public.tenants(id),student_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),snapshot jsonb not null,created_at timestamptz not null default now()
);
create or replace function public.get_student_handover(p_student_id uuid,p_acknowledge boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t text:=public._my_tenant_id(); result jsonb; begin
  if not private.can_read_student_pedagogy(t,p_student_id) then raise exception 'sem_permissao'; end if;
  select jsonb_build_object('ok',true,'student_name',p.full_name,
    'memories',(select coalesce(jsonb_agg(to_jsonb(m) order by m.occurred_at desc),'[]'::jsonb) from
      (select id,source_type,occurred_at,lesson_objective,content_practiced,recurring_errors,homework_assigned,recommended_next_step,verification_status
       from public.student_learning_memories where tenant_id=t and student_id=p_student_id and verification_status='VERIFIED' order by occurred_at desc limit 30) m),
    'logs',(select coalesce(jsonb_agg(to_jsonb(l) order by l.class_date desc,l.start_time desc),'[]'::jsonb) from
      (select id,class_date,start_time,lesson_objective,content_covered,student_difficulties,homework_assigned,recommended_next_step,lesson_session_id
       from public.class_logs where tenant_id=t and student_id=p_student_id order by class_date desc,start_time desc limit 30) l))
    into result from public.profiles p where p.id=p_student_id and p.tenant_id=t;
  if p_acknowledge then insert into private.student_handover_reads(tenant_id,student_id,actor_id,snapshot) values(t,p_student_id,auth.uid(),result); end if;
  return result;
end $$;

alter table public.lesson_sessions enable row level security;
alter table public.lesson_occurrences enable row level security;
alter table public.lesson_quality_cases enable row level security;
alter table public.lesson_quality_case_events enable row level security;
drop policy if exists lesson_sessions_read on public.lesson_sessions;
create policy lesson_sessions_read on public.lesson_sessions for select to authenticated using(private.can_read_student_pedagogy(tenant_id,student_id));
drop policy if exists lesson_occurrences_read on public.lesson_occurrences;
create policy lesson_occurrences_read on public.lesson_occurrences for select to authenticated using(exists(select 1 from public.lesson_sessions s where s.id=session_id and private.can_read_student_pedagogy(s.tenant_id,s.student_id)));
drop policy if exists lesson_quality_cases_read on public.lesson_quality_cases;
create policy lesson_quality_cases_read on public.lesson_quality_cases for select to authenticated using(private.can_manage_lesson_quality(tenant_id));
drop policy if exists lesson_quality_events_read on public.lesson_quality_case_events;
create policy lesson_quality_events_read on public.lesson_quality_case_events for select to authenticated using(private.can_manage_lesson_quality(tenant_id));
revoke all on public.lesson_sessions,public.lesson_occurrences,public.lesson_quality_cases,public.lesson_quality_case_events from public,anon,authenticated;
grant select on public.lesson_sessions,public.lesson_occurrences,public.lesson_quality_cases,public.lesson_quality_case_events to authenticated;
grant all on public.lesson_sessions,public.lesson_occurrences,public.lesson_quality_cases,public.lesson_quality_case_events to service_role;
alter table private.lesson_documentation_consent_events enable row level security;
alter table private.lesson_quality_feedback enable row level security;
alter table private.student_handover_reads enable row level security;
revoke all on private.lesson_documentation_consent_events,private.lesson_quality_feedback,private.student_handover_reads from public,anon,authenticated,service_role;
revoke all on function private.can_manage_lesson_quality(text),private.can_read_student_pedagogy(text,uuid) from public,anon;
grant execute on function private.can_manage_lesson_quality(text),private.can_read_student_pedagogy(text,uuid) to authenticated;
revoke all on function private.lesson_quality_sources(text,date,date,uuid),private.sync_lesson_quality_sessions(text,date,date,uuid),
  private.record_lesson_quality_feedback(uuid,jsonb,uuid),private.link_attendance_quality_receipt() from public,anon,authenticated,service_role;
revoke all on function public.get_lesson_sessions(uuid,date,date),public.ensure_lesson_session(text,text,date),
  public.set_lesson_documentation_consent(uuid,boolean,text),public.submit_my_lesson_quality_feedback(uuid,jsonb),
  public.review_lesson_quality_case(uuid,text,text,uuid),public.get_lesson_quality_dashboard(date,date),public.get_student_handover(uuid,boolean) from public,anon;
grant execute on function public.get_lesson_sessions(uuid,date,date),public.ensure_lesson_session(text,text,date),
  public.set_lesson_documentation_consent(uuid,boolean,text),public.submit_my_lesson_quality_feedback(uuid,jsonb),
  public.review_lesson_quality_case(uuid,text,text,uuid),public.get_lesson_quality_dashboard(date,date),public.get_student_handover(uuid,boolean) to authenticated;
revoke all on function public.submit_lesson_quality_feedback(text,jsonb) from public;
grant execute on function public.submit_lesson_quality_feedback(text,jsonb) to anon,authenticated;
revoke all on function public.bind_attendance_quality_delivery(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.bind_attendance_quality_delivery(uuid,uuid,text,text,boolean) to service_role;

create table if not exists private.lesson_quality_whatsapp_events (
  id uuid primary key default gen_random_uuid(),tenant_id text not null references public.tenants(id),
  instance_name text not null,message_id text not null,confirmation_id uuid not null references public.attendance_confirmations(id),
  category text not null,created_at timestamptz not null default now(),unique(tenant_id,instance_name,message_id)
);
alter table private.lesson_quality_whatsapp_events enable row level security;
revoke all on private.lesson_quality_whatsapp_events from public,anon,authenticated,service_role;
create or replace function public.ingest_lesson_quality_whatsapp(p_tenant text,p_instance text,p_phone text,p_message_id text,p_quoted_id text,p_category text,p_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.attendance_confirmations; ids uuid[]; fid uuid; cid uuid; payload jsonb; result jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'sem_permissao'; end if;
  if p_category not in ('OK','UNKNOWN','LATE_START','EARLY_END','SCHEDULE_CHANGE','DID_NOT_HAPPEN','OTHER')
    or coalesce(p_phone,'') !~ '^[0-9]{10,15}$' or length(coalesce(p_message_id,'')) not between 1 and 320 then return jsonb_build_object('handled',false); end if;
  select array_agg(a.id) into ids from public.attendance_confirmations a
    join public.profiles sp on sp.id=a.student_id and sp.tenant_id=a.tenant_id and sp.is_test_account=false and lower(sp.lifecycle_status)='active'
    where a.tenant_id=p_tenant and a.provider_instance_name=lower(trim(p_instance)) and a.sent_at>=now()-interval '48 hours'
      and a.token_expires_at>now() and a.delivery_status='SENT' and a.status<>'CANCELLED'
      and coalesce(a.canonical_confirmation_id,a.id)=a.id and a.quality_recipient_phone=p_phone
      and ((nullif(p_quoted_id,'') is not null and a.provider_message_id=p_quoted_id)
        or (nullif(p_quoted_id,'') is null and a.quality_recipient_verified))
      and (exists(select 1 from public.student_quality_contacts qc where qc.tenant_id=p_tenant and qc.student_id=a.student_id
        and qc.active and qc.verified_at is not null and qc.phone=p_phone)
        or (not a.quality_recipient_verified and nullif(p_quoted_id,'') is not null
          and coalesce(private.quality_delivery_phone(sp.attendance_phone),private.quality_delivery_phone(sp.phone))=p_phone));
  if coalesce(cardinality(ids),0)=0 then return jsonb_build_object('handled',false); end if;
  if cardinality(ids)<>1 then return jsonb_build_object('handled',true,'needs_context',true); end if;
  select * into c from public.attendance_confirmations where id=ids[1] for update;
  insert into private.lesson_quality_whatsapp_events(tenant_id,instance_name,message_id,confirmation_id,category)
    values(p_tenant,lower(trim(p_instance)),p_message_id,c.id,p_category)
    on conflict(tenant_id,instance_name,message_id) do nothing returning id into fid;
  if fid is null then return jsonb_build_object('handled',true,'already',true); end if;
  if p_category in ('OK','UNKNOWN') then
    payload:=jsonb_build_object('happened',case when p_category='OK' then 'YES' else 'UNKNOWN' end,
      'punctuality',case when p_category='OK' then 'ON_TIME' else 'UNKNOWN' end,'ended_early','UNKNOWN','reschedule_by','UNKNOWN');
    result:=private.record_lesson_quality_feedback(c.id,payload,null);
    if result->>'ok'<>'true' then
      return jsonb_build_object('handled',true,'needs_school',true);
    end if;
  else
    insert into public.lesson_quality_cases(tenant_id,session_id,confirmation_id,student_id,teacher_id,category,source,description,dedupe_key)
      values(p_tenant,c.lesson_session_id,c.id,c.student_id,c.teacher_id,p_category,'WHATSAPP',left(p_text,2000),c.id::text||':'||p_category)
      on conflict(tenant_id,dedupe_key) do update set updated_at=now(),status=case when lesson_quality_cases.status='RESOLVED' then 'FOLLOWUP' else lesson_quality_cases.status end returning id into cid;
    insert into public.lesson_quality_case_events(tenant_id,case_id,event_type,details)
      values(p_tenant,cid,'WHATSAPP_REPORT',jsonb_build_object('text',left(p_text,2000),'event_id',fid,'contact_verified',c.quality_recipient_verified));
  end if;
  return jsonb_build_object('handled',true,'ok',true);
end $$;
revoke all on function public.ingest_lesson_quality_whatsapp(text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.ingest_lesson_quality_whatsapp(text,text,text,text,text,text,text) to service_role;

create table if not exists private.lesson_session_revisions (
  id uuid primary key default gen_random_uuid(),session_id uuid not null references public.lesson_sessions(id),
  previous_snapshot jsonb not null,next_snapshot jsonb not null,actor_id uuid,created_at timestamptz not null default now()
);
alter table private.lesson_session_revisions add column if not exists action text not null default 'SNAPSHOT_UPDATE',
  add column if not exists reason text;
alter table private.lesson_session_revisions enable row level security;
revoke all on private.lesson_session_revisions from public,anon,authenticated,service_role;
create or replace function private.audit_lesson_session_revision() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (old.scheduled_start_at,old.scheduled_end_at,old.teacher_id,old.student_id,old.documentation_consent)
     is distinct from (new.scheduled_start_at,new.scheduled_end_at,new.teacher_id,new.student_id,new.documentation_consent) then
    insert into private.lesson_session_revisions(session_id,previous_snapshot,next_snapshot,actor_id)
      values(new.id,to_jsonb(old),to_jsonb(new),auth.uid());
  end if;
  return new;
end $$;
drop trigger if exists audit_lesson_session_revision on public.lesson_sessions;
create trigger audit_lesson_session_revision after update on public.lesson_sessions for each row execute function private.audit_lesson_session_revision();

-- School-only, explicit replacement of a future plan. No evidence is moved,
-- no Google API is called, and a previously issued external URL is not revoked.
create or replace function public.supersede_future_lesson_session(p_session_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.lesson_sessions; next_snapshot jsonb; reviewed boolean:=false; replacements jsonb; begin
  select * into s from public.lesson_sessions where id=p_session_id;
  if not found or not private.can_manage_lesson_quality(s.tenant_id) then raise exception 'sem_permissao' using errcode='42501'; end if;
  if length(btrim(coalesce(p_reason,'')))<10 or length(p_reason)>2000 then raise exception 'informe_motivo_replanejamento' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('lesson-quality:'||s.tenant_id,0));
  select * into s from public.lesson_sessions where id=p_session_id for update;
  if s.scheduled_start_at<=now() then raise exception 'somente_sessao_futura_pode_ser_replanejada' using errcode='55000'; end if;
  if s.status='SUPERSEDED' then return jsonb_build_object('ok',true,'already',true,'session_id',s.id); end if;
  if exists(select 1 from public.class_logs cl where cl.tenant_id=s.tenant_id and (cl.lesson_session_id=s.id
    or exists(select 1 from public.lesson_occurrences o where o.session_id=s.id and cl.class_date=o.class_date and cl.start_time=o.start_time
      and (o.class_log_id=cl.id or (o.source_type='booking' and cl.booking_id::text=o.source_id)
        or (o.source_type='reschedule' and cl.reschedule_id::text=o.source_id) or (o.source_type='appointment' and cl.appointment_id::text=o.source_id))))) then
    raise exception 'sessao_com_lancamento_nao_pode_ser_replanejada' using errcode='55000';
  end if;
  -- Even a pending audit owns a delivery/token identity. Do not expire it or
  -- bypass the existing attendance deduplication: school analysis is required.
  if exists(select 1 from public.attendance_confirmations ac where ac.tenant_id=s.tenant_id and (ac.lesson_session_id=s.id
    or exists(select 1 from public.lesson_occurrences o where o.session_id=s.id and ac.source_type=o.source_type
      and ac.source_id::text=o.source_id and ac.class_date=o.class_date and left(ac.class_time,5)=to_char(o.start_time,'HH24:MI')))) then
    raise exception 'audit_already_created_contact_school' using errcode='55000';
  end if;
  if to_regclass('private.lesson_summary_versions') is not null then
    execute 'select exists(select 1 from private.lesson_summary_versions where lesson_session_id=$1 and tenant_id=$2 and status in (''VERIFIED'',''REJECTED''))'
      into reviewed using s.id,s.tenant_id;
  end if;
  if reviewed then raise exception 'sessao_com_documentacao_revisada_nao_pode_ser_replanejada' using errcode='55000'; end if;
  insert into private.lesson_documentation_consent_events(session_id,actor_id,allowed,reason)
    values(s.id,auth.uid(),false,'Sessão arquivada por replanejamento: '||btrim(p_reason));
  update public.lesson_occurrences set status='SUPERSEDED' where session_id=s.id and tenant_id=s.tenant_id;
  update public.lesson_sessions set status='SUPERSEDED',documentation_consent=false,updated_at=now(),
    source_key=s.source_key||':archived:'||s.id::text where id=s.id returning to_jsonb(lesson_sessions.*) into next_snapshot;
  insert into private.lesson_session_revisions(session_id,previous_snapshot,next_snapshot,actor_id,action,reason)
    values(s.id,to_jsonb(s),next_snapshot,auth.uid(),'SUPERSEDE_FUTURE_SESSION',btrim(p_reason));
  perform private.sync_lesson_quality_sessions(s.tenant_id,s.class_date,s.class_date,s.student_id);
  select coalesce(jsonb_agg(distinct active.session_id),'[]'::jsonb) into replacements
    from public.lesson_occurrences previous join public.lesson_occurrences active
      on active.tenant_id=previous.tenant_id and active.source_type=previous.source_type and active.source_id=previous.source_id
        and active.class_date=previous.class_date and active.start_time=previous.start_time and active.status<>'SUPERSEDED'
    where previous.session_id=s.id;
  return jsonb_build_object('ok',true,'session_id',s.id,'new_session_ids',replacements,
    'external_meet_link_revoked',false,'requires_new_documentation_consent',true);
end $$;
alter function public.supersede_future_lesson_session(uuid,text) owner to postgres;
revoke all on function public.supersede_future_lesson_session(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.supersede_future_lesson_session(uuid,text) to authenticated;

create or replace function private.link_lesson_quality_session() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.student_id is not null and new.class_date is not null then
    perform private.sync_lesson_quality_sessions(new.tenant_id,new.class_date,new.class_date,new.student_id);
    update public.lesson_quality_cases q set session_id=a.lesson_session_id from public.attendance_confirmations a
      where q.confirmation_id=a.id and a.student_id=new.student_id and a.tenant_id=new.tenant_id and a.class_date=new.class_date and q.session_id is null;
  end if;
  return new;
end $$;
drop trigger if exists link_class_log_quality_session on public.class_logs;
create trigger link_class_log_quality_session after insert or update of class_date,start_time,teacher_id,student_id on public.class_logs for each row execute function private.link_lesson_quality_session();
drop trigger if exists link_attendance_quality_session on public.attendance_confirmations;
create trigger link_attendance_quality_session after insert on public.attendance_confirmations for each row execute function private.link_lesson_quality_session();
revoke all on function private.link_lesson_quality_session(),private.audit_lesson_session_revision() from public,anon,authenticated,service_role;

-- Explicit owners keep private audit writes working after a replay by the
-- deployment principal. Browser roles only invoke the narrow commands above.
do $ownership$ declare r record; begin
  for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='private' and p.proname in ('can_manage_lesson_quality','can_read_student_pedagogy','lesson_quality_sources','lesson_session_has_evidence','sync_lesson_quality_sessions','record_lesson_quality_feedback','link_attendance_quality_receipt','link_lesson_quality_session','audit_lesson_session_revision'))
      or (n.nspname='public' and p.proname in ('get_lesson_sessions','ensure_lesson_session','set_lesson_documentation_consent','submit_lesson_quality_feedback','submit_my_lesson_quality_feedback','review_lesson_quality_case','get_lesson_quality_dashboard','bind_attendance_quality_delivery','get_student_handover','ingest_lesson_quality_whatsapp'))
  loop execute format('alter function %s owner to postgres',r.signature); end loop;
  for r in select c.oid::regclass as relation from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and
    ((n.nspname='public' and c.relname in ('lesson_sessions','lesson_occurrences','lesson_quality_cases','lesson_quality_case_events'))
    or (n.nspname='private' and c.relname in ('lesson_documentation_consent_events','lesson_quality_feedback','student_handover_reads','lesson_quality_whatsapp_events','lesson_session_revisions')))
  loop execute format('alter table %s owner to postgres',r.relation); end loop;
end $ownership$;

create or replace function public.create_lesson_quality_case(p_session_id uuid,p_category text,p_description text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.lesson_sessions; cid uuid; begin
  select * into s from public.lesson_sessions where id=p_session_id;
  if not found or not private.can_manage_lesson_quality(s.tenant_id) then raise exception 'sem_permissao'; end if;
  if p_category not in ('LATE_START','EARLY_END','SCHEDULE_CHANGE','DID_NOT_HAPPEN','OTHER') or length(trim(coalesce(p_description,''))) not between 10 and 4000 then raise exception 'relato_invalido'; end if;
  insert into public.lesson_quality_cases(tenant_id,session_id,student_id,teacher_id,category,source,description,assigned_to)
    values(s.tenant_id,s.id,s.student_id,s.teacher_id,p_category,'SCHOOL',trim(p_description),auth.uid()) returning id into cid;
  insert into public.lesson_quality_case_events(tenant_id,case_id,actor_id,event_type,details)
    values(s.tenant_id,cid,auth.uid(),'SCHOOL_REPORT',jsonb_build_object('description',trim(p_description),'category',p_category));
  return jsonb_build_object('ok',true,'case_id',cid);
end $$;
alter function public.create_lesson_quality_case(uuid,text,text) owner to postgres;
revoke all on function public.create_lesson_quality_case(uuid,text,text) from public,anon;
grant execute on function public.create_lesson_quality_case(uuid,text,text) to authenticated;

create or replace function public.refresh_lesson_quality_queue()
returns jsonb language plpgsql security definer set search_path='' as $$
declare t record; s record; cid uuid; total integer:=0; today date:=(now() at time zone 'America/Sao_Paulo')::date; begin
  -- No messages or payments here: operational exceptions are routed to the
  -- existing human review queue. Test/suspended profiles never create cases.
  for t in select distinct b.tenant_id from public.bookings b join public.profiles p on p.id=b.student_id and p.tenant_id=b.tenant_id
    where b.status='SCHEDULED' and p.is_test_account=false and lower(p.lifecycle_status)='active' loop
    perform private.sync_lesson_quality_sessions(t.tenant_id,today-7,today+1,null);
    for s in select sess.* from public.lesson_sessions sess join public.profiles sp on sp.id=sess.student_id
      join public.profiles tp on tp.id=sess.teacher_id where sess.tenant_id=t.tenant_id and sess.class_date between today-7 and today
        and sess.status='SCHEDULED' and sess.scheduled_end_at<now()-interval '24 hours'
        and sp.is_test_account=false and tp.is_test_account=false and lower(sp.lifecycle_status)='active' and lower(tp.lifecycle_status)='active'
    loop
      insert into public.lesson_quality_cases(tenant_id,session_id,student_id,teacher_id,category,source,description,dedupe_key)
        values(s.tenant_id,s.id,s.student_id,s.teacher_id,'MISSING_LOG','SYSTEM','Aula prevista há mais de 24 horas sem lançamento. Conferir realização com os envolvidos.',s.id::text||':MISSING_LOG')
        on conflict(tenant_id,dedupe_key) do nothing returning id into cid;
      if cid is not null then
        insert into public.lesson_quality_case_events(tenant_id,case_id,event_type,details) values(s.tenant_id,cid,'SYSTEM_SIGNAL',jsonb_build_object('scheduled_end_at',s.scheduled_end_at));
        total:=total+1;
      end if;
    end loop;
  end loop;
  for s in select a.* from public.attendance_confirmations a join public.profiles p on p.id=a.student_id and p.is_test_account=false
    where a.class_date>=today-7 and coalesce(a.canonical_confirmation_id,a.id)=a.id
      and (a.delivery_status in ('FAILED','AMBIGUOUS') or a.provider_failed_at is not null)
  loop
    insert into public.lesson_quality_cases(tenant_id,session_id,confirmation_id,student_id,teacher_id,category,source,description,dedupe_key)
      values(s.tenant_id,s.lesson_session_id,s.id,s.student_id,s.teacher_id,'DELIVERY_FAILURE','SYSTEM','Não foi possível comprovar a entrega do pedido de retorno. Conferir contato e comunicação; não reenviar automaticamente entregas incertas.',s.id::text||':DELIVERY_FAILURE')
      on conflict(tenant_id,dedupe_key) do nothing returning id into cid;
    if cid is not null then
      insert into public.lesson_quality_case_events(tenant_id,case_id,event_type,details) values(s.tenant_id,cid,'SYSTEM_SIGNAL',jsonb_build_object('delivery_status',s.delivery_status,'error_code',s.last_delivery_error));
      total:=total+1;
    end if;
  end loop;
  return jsonb_build_object('ok',true,'created',total);
end $$;
alter function public.refresh_lesson_quality_queue() owner to postgres;
revoke all on function public.refresh_lesson_quality_queue() from public,anon,authenticated;
grant execute on function public.refresh_lesson_quality_queue() to service_role;
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('wisewolf-lesson-quality-queue','7,22,37,52 * * * *','select public.refresh_lesson_quality_queue();');
  end if;
end $$;
