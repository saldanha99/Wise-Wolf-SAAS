-- Histórico operacional independente do dossiê pedagógico e da folha.
-- Nenhuma cópia de transcrição, telefone, documento ou dado financeiro.
create table if not exists private.lesson_history_events (
 id uuid primary key default gen_random_uuid(), tenant_id text not null,
 source_type text not null, source_id text not null,
 before_value jsonb, after_value jsonb,
 action text not null check(action in ('BASELINE','INSERT','UPDATE','DELETE','CORRECTION','DISPUTE','RESOLUTION')),
 actor_id uuid, actor_name text, reason text,
 created_at timestamptz not null default clock_timestamp()
);
create index if not exists lesson_history_events_source_idx on private.lesson_history_events(tenant_id,source_type,source_id,created_at,id);
create index if not exists lesson_history_events_teacher_idx on private.lesson_history_events(tenant_id,((after_value->>'teacher_id')),created_at);
alter table private.lesson_history_events enable row level security;
revoke all on private.lesson_history_events from public,anon,authenticated,service_role;
grant select,insert on private.lesson_history_events to postgres;

create table if not exists private.lesson_history_corrections (
 tenant_id text not null, source_type text not null, source_id text not null, class_date date not null,
 teacher_id uuid not null, student_id uuid, classification text,
 notes text not null, reason text not null, version integer not null default 1,
 updated_by uuid not null, updated_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,source_type,source_id,class_date),
 check(classification is null or classification in ('HOLIDAY','TEACHER_CANCELLED'))
);
alter table private.lesson_history_corrections enable row level security;
revoke all on private.lesson_history_corrections from public,anon,authenticated,service_role;
grant select,insert,update on private.lesson_history_corrections to postgres;
create table if not exists private.lesson_history_disputes (
 id uuid primary key default gen_random_uuid(),tenant_id text not null,
 source_type text not null,source_id text not null,class_date date not null,
 teacher_id uuid not null,student_id uuid,opened_by uuid not null,
 description text not null check(length(btrim(description)) between 10 and 1000),
 opened_at timestamptz not null default clock_timestamp(),
 resolved_by uuid,resolved_at timestamptz,resolution text,
 check((resolved_at is null and resolved_by is null and resolution is null)
 or (resolved_at is not null and resolved_by is not null and length(btrim(resolution)) between 10 and 1000))
);
create unique index if not exists lesson_history_one_open_dispute on private.lesson_history_disputes(tenant_id,source_type,source_id,class_date) where resolved_at is null;
alter table private.lesson_history_disputes enable row level security;
revoke all on private.lesson_history_disputes from public,anon,authenticated,service_role;
grant select,insert,update on private.lesson_history_disputes to postgres;

create or replace function private.lesson_history_immutable() returns trigger
language plpgsql set search_path='' as $$ begin raise exception 'history_is_append_only'; end $$;
alter function private.lesson_history_immutable() owner to postgres;
revoke all on function private.lesson_history_immutable() from public,anon,authenticated,service_role;
drop trigger if exists history_is_append_only on private.lesson_history_events;
create trigger history_is_append_only before update or delete on private.lesson_history_events for each row execute function private.lesson_history_immutable();

-- A projeção fechada evita congelar dados sensíveis em uma auditoria permanente.
create or replace function private.lesson_history_snapshot(p jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) from jsonb_each(p) e where e.key=any(array[
 'id','tenant_id','teacher_id','student_id','booking_id','reschedule_id','appointment_id','lesson_advance_id',
 'original_booking_id','class_date','date','time','time_slot','day_of_week','start_date','start_time','end_time',
 'presence','subtype','observations','status','fault_type','used_at','closed_reason','attestation_reason',
 'reason','created_by','created_at','valid_from','valid_until','classification','notes','version','description','resolution']);
$$;
alter function private.lesson_history_snapshot(jsonb) owner to postgres;
revoke all on function private.lesson_history_snapshot(jsonb) from public,anon,authenticated,service_role;

create or replace function private.capture_lesson_history() returns trigger
language plpgsql security definer set search_path='' as $$
declare b jsonb; a jsonb; v jsonb; t text; sid text; actor text; begin
 if tg_op<>'INSERT' then b:=private.lesson_history_snapshot(to_jsonb(old)); end if;
 if tg_op<>'DELETE' then a:=private.lesson_history_snapshot(to_jsonb(new)); end if;
 if a is not distinct from b then return null; end if;
 v:=coalesce(a,b);t:=v->>'tenant_id';sid:=v->>'id';
 if tg_table_name in ('booking_occurrence_exclusions','booking_schedule_versions') then
  select v||jsonb_build_object('teacher_id',bk.teacher_id,'student_id',bk.student_id) into v
   from public.bookings bk where bk.id=(v->>'booking_id')::uuid;
  if tg_op='DELETE' then b:=v; else a:=v; end if;
  sid:=v->>'booking_id';
 end if;
 if t is null then return null; end if;
 select full_name into actor from public.profiles where id=auth.uid();
 insert into private.lesson_history_events(tenant_id,source_type,source_id,before_value,after_value,action,actor_id,actor_name,reason)
 values(t,tg_table_name,sid,b,a,tg_op,auth.uid(),actor,
 coalesce(nullif(current_setting('app.lesson_history_reason',true),''),
 nullif(current_setting('app.reschedule_reason',true),''),v->>'reason',v->>'attestation_reason'));
 return null;
end $$;
alter function private.capture_lesson_history() owner to postgres;
revoke all on function private.capture_lesson_history() from public,anon,authenticated,service_role;
do $$ declare tab text; begin
 foreach tab in array array['class_logs','bookings','reschedules','appointments','booking_occurrence_exclusions','booking_schedule_versions'] loop
  execute format('drop trigger if exists zz_lesson_history_capture on public.%I',tab);
  execute format('create trigger zz_lesson_history_capture after insert or update or delete on public.%I for each row execute function private.capture_lesson_history()',tab);
 end loop;
end $$;
-- O registro inicial informa honestamente que não se conhece o lançador antigo.
do $$ begin
 if not exists(select 1 from public.schema_one_shots where key='lesson_history_baseline_20261010') then
  insert into private.lesson_history_events(tenant_id,source_type,source_id,after_value,action,reason)
   select l.tenant_id,'class_logs',l.id::text,private.lesson_history_snapshot(to_jsonb(l)), 'BASELINE',
    'Registro anterior à implantação da trilha; lançador e alterações anteriores não disponíveis.' from public.class_logs l;
  insert into public.schema_one_shots(key) values('lesson_history_baseline_20261010');
 end if;
end $$;

-- Autoriza SOMENTE o extrato próprio após desligamento. Não amplia RLS de perfis/dossiê.
create or replace function private.lesson_history_authorize(p_teacher uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare t text; p public.profiles%rowtype; begin
 if auth.uid() is null or p_teacher is null then raise exception 'history_not_authorized' using errcode='42501'; end if;
 select * into p from public.profiles where id=auth.uid();
 if p.id=p_teacher and p.role='TEACHER' and lower(coalesce(p.lifecycle_status,'')) in ('active','offboarded') then
  t:=case when lower(p.lifecycle_status)='active' then public._my_tenant_id() else p.tenant_id end;
  if exists(select 1 from public.tenant_memberships m where m.user_id=p.id and m.tenant_id=t and m.role='TEACHER'
   and (m.status='ACTIVE' or (lower(p.lifecycle_status)='offboarded' and m.status='REVOKED'))) then return t; end if;
 elsif coalesce(public._my_role(),'') in ('SCHOOL_ADMIN','COORDINATOR') then
  t:=public._my_tenant_id();
  if exists(select 1 from public.profiles s where s.id=p_teacher and s.tenant_id=t and s.role='TEACHER') then return t; end if;
 end if;
 raise exception 'history_not_authorized' using errcode='42501';
end $$;
alter function private.lesson_history_authorize(uuid) owner to postgres;
revoke all on function private.lesson_history_authorize(uuid) from public,anon,authenticated,service_role;

create or replace function public.list_lesson_history_teachers() returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 if auth.uid() is null or coalesce(public._my_role(),'') not in ('SCHOOL_ADMIN','COORDINATOR') then raise exception 'history_not_authorized' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'lifecycle',p.lifecycle_status) order by p.full_name,p.id)
 from public.profiles p where p.tenant_id=public._my_tenant_id() and p.role='TEACHER'),'[]');
end $$;

create or replace function private.lesson_history_rows(p_tenant text,p_teacher uuid,p_from date,p_to date)
returns table(row_value jsonb) language sql stable security definer set search_path='' as $$
 with logs as (
  select l.id::text id,l.student_id,l.class_date,l.start_time,l.presence,l.subtype,l.observations,l.created_at,
   l.booking_id,l.reschedule_id,l.appointment_id from public.class_logs l
  where l.tenant_id=p_tenant and l.teacher_id=p_teacher and l.class_date between p_from and p_to
 ), archived_bookings as (
  select e.*,e.before_value v from private.lesson_history_events e
  where e.tenant_id=p_tenant and e.source_type='bookings' and e.before_value->>'teacher_id'=p_teacher::text
   and (e.action='DELETE' or (e.action='UPDATE' and (e.after_value->>'teacher_id' is distinct from e.before_value->>'teacher_id'
     or (e.after_value->>'status'='CANCELLED' and e.before_value->>'status' is distinct from 'CANCELLED'))))
 ), archived_slots as (
  select distinct on (e.source_id,d.day) e.source_id,(e.v->>'student_id')::uuid student_id,d.day::date class_date,
   (coalesce(public.booking_schedule_on_date(e.source_id::uuid,d.day::date)->>'time_slot',e.v->>'time_slot'))::time start_time,
   case when (e.action='DELETE' or e.after_value->>'status'='CANCELLED') and d.day::date>=(e.created_at at time zone 'America/Sao_Paulo')::date then 'CANCELLED' else 'UNFINALIZED' end category,
   e.reason,(e.v->>'created_at')::timestamptz created_at
  from archived_bookings e cross join lateral generate_series(
   greatest(p_from,coalesce((e.v->>'start_date')::date,(e.v->>'created_at')::timestamptz::date),
    coalesce((select max((a.created_at at time zone 'America/Sao_Paulo')::date) from private.lesson_history_events a
     where a.tenant_id=p_tenant and a.source_type='bookings' and a.source_id=e.source_id and a.created_at<e.created_at
     and a.action='UPDATE' and a.before_value is not null and a.after_value->>'teacher_id'=p_teacher::text and a.before_value->>'teacher_id' is distinct from p_teacher::text),p_from))::timestamp,
   least(p_to,case when e.action='DELETE' or e.after_value->>'status'='CANCELLED' then p_to else (e.created_at at time zone 'America/Sao_Paulo')::date end)::timestamp,
   interval '1 day') d(day)
  where (e.action='DELETE' or e.after_value->>'status'='CANCELLED' or ((d.day::date + (coalesce(public.booking_schedule_on_date(e.source_id::uuid,d.day::date)->>'time_slot',e.v->>'time_slot'))::time) at time zone 'America/Sao_Paulo')<e.created_at)
   and ((e.v->>'date' is not null and d.day::date=(e.v->>'date')::date)
    or (e.v->>'date' is null and extract(dow from d.day)::int=public.dow_name_to_int(coalesce(public.booking_schedule_on_date(e.source_id::uuid,d.day::date)->>'day_of_week',e.v->>'day_of_week'))))
   and not exists(select 1 from public.class_logs l where l.tenant_id=p_tenant and l.booking_id=e.source_id and l.class_date=d.day::date)
   and not exists(select 1 from private.lesson_history_events dl where dl.tenant_id=p_tenant and dl.source_type='class_logs' and dl.action='DELETE'
     and dl.before_value->>'booking_id'=e.source_id and dl.before_value->>'class_date'=d.day::date::text)
   and not exists(select 1 from public.booking_occurrence_exclusions x where x.tenant_id=p_tenant and x.booking_id=e.source_id::uuid and x.class_date=d.day::date)
   and not exists(select 1 from public.lesson_advances la where la.tenant_id=p_tenant and la.booking_id=e.source_id::uuid and la.original_date=d.day::date and la.status<>'CANCELLED')
   and not exists(select 1 from public.class_coverages cc where cc.tenant_id=p_tenant and cc.booking_id=e.source_id::uuid and cc.class_date=d.day::date and lower(cc.status)='confirmed' and cc.cover_teacher_id<>p_teacher)
  order by e.source_id,d.day,e.created_at desc
 ), base as (
  select 'class_logs'::text source_type,l.id source_id,l.student_id,l.class_date,l.start_time,
   case when l.presence in ('COMPLETED','PRESENÇA') then case when l.reschedule_id is not null then 'MAKEUP_COMPLETED' else 'COMPLETED' end
    when l.presence='STUDENT_ABSENCE' then 'STUDENT_ABSENCE'
    when l.presence='TEACHER_ABSENCE' then 'TEACHER_ABSENCE'
    else 'UNFINALIZED' end category,l.subtype reason,l.observations notes,l.created_at,
   l.id class_log_id,l.booking_id,l.reschedule_id,l.appointment_id,false removed
  from logs l
  union all
  select case s.source_type when 'booking' then 'bookings' when 'reschedule' then 'reschedules' else 'appointments' end,
   s.source_id,s.student_id,s.class_date,s.start_time,
   case when s.class_date::timestamp+s.start_time+interval '30 minutes' <= now() at time zone 'America/Sao_Paulo' then 'UNFINALIZED' else 'SCHEDULED' end,
   null,null,case s.source_type
    when 'booking' then (select b.created_at from public.bookings b where b.id::text=s.source_id and b.tenant_id=p_tenant)
    when 'reschedule' then (select r.created_at from public.reschedules r where r.id::text=s.source_id and r.tenant_id=p_tenant)
    else (select a.created_at from public.appointments a where a.id::text=s.source_id and a.tenant_id=p_tenant) end,null,
   case when s.source_type='booking' then s.source_id end,
   case when s.source_type='reschedule' then s.source_id end,
   case when s.source_type='appointment' then s.source_id end,false
  from private.lesson_quality_sources(p_tenant,p_from,p_to,null) s where s.teacher_id=p_teacher
   and (s.source_type<>'booking' or not exists(select 1 from private.lesson_history_events ev
    where ev.tenant_id=p_tenant and ev.source_type='bookings' and ev.source_id=s.source_id and ev.action='UPDATE'
    and ev.after_value->>'teacher_id'=p_teacher::text and ev.before_value->>'teacher_id' is distinct from p_teacher::text
    and ((s.class_date+s.start_time) at time zone 'America/Sao_Paulo')<ev.created_at))
   and not exists(select 1 from private.lesson_history_events ev where ev.tenant_id=p_tenant and ev.source_type='class_logs' and ev.action='DELETE'
    and ev.before_value->>'class_date'=s.class_date::text and (
     (s.source_type='booking' and ev.before_value->>'booking_id'=s.source_id)
     or (s.source_type='reschedule' and ev.before_value->>'reschedule_id'=s.source_id)
     or (s.source_type='appointment' and ev.before_value->>'appointment_id'=s.source_id)))
   and not exists(select 1 from public.class_logs l where l.tenant_id=p_tenant and l.class_date=s.class_date
    and ((s.source_type='booking' and l.booking_id=s.source_id)
     or (s.source_type='reschedule' and l.reschedule_id=s.source_id) or (s.source_type='appointment' and l.appointment_id=s.source_id)))
  union all
  select 'bookings',a.source_id,a.student_id,a.class_date,a.start_time,a.category,a.reason,null,a.created_at,null,a.source_id,null,null,false
  from archived_slots a
  union all
  select 'bookings',b.id::text,b.student_id,x.class_date,(public.booking_schedule_on_date(b.id,x.class_date)->>'time_slot')::time,
   'EXCLUDED',x.reason,null,x.created_at,null,b.id::text,null,null,false
  from public.booking_occurrence_exclusions x join public.bookings b on b.id=x.booking_id and b.tenant_id=x.tenant_id
  where x.tenant_id=p_tenant and coalesce(
    (select c.teacher_id from private.lesson_history_corrections c where c.tenant_id=p_tenant and c.source_type='bookings' and c.source_id=b.id::text and c.class_date=x.class_date),
    (select (ev.after_value->>'teacher_id')::uuid from private.lesson_history_events ev where ev.tenant_id=p_tenant and ev.source_type='booking_occurrence_exclusions' and ev.source_id=b.id::text and ev.after_value->>'class_date'=x.class_date::text order by ev.created_at limit 1),b.teacher_id)=p_teacher and x.class_date between p_from and p_to
  union all
  select 'appointments',a.id::text,null,(a.start_time at time zone 'America/Sao_Paulo')::date,
   (a.start_time at time zone 'America/Sao_Paulo')::time,
   case when lower(a.status)='cancelled' then 'CANCELLED' when lower(a.status)='no_show' then 'UNFINALIZED' else
    case when a.start_time+interval '30 minutes'<=now() then 'UNFINALIZED' else 'SCHEDULED' end end,
   null,null,a.created_at,null,null,null,a.id::text,false
  from public.appointments a where a.tenant_id=p_tenant and coalesce(a.teacher_id,a.professor_id)=p_teacher
   and a.type in ('experimental','training') and (a.start_time at time zone 'America/Sao_Paulo')::date between p_from and p_to
   and not exists(select 1 from public.class_logs l where l.tenant_id=p_tenant and l.appointment_id=a.id::text)
  union all
  -- Um lançamento apagado permanece visível como removido, sem contar como realizado.
  select 'class_logs',e.source_id,(e.before_value->>'student_id')::uuid,(e.before_value->>'class_date')::date,
   (e.before_value->>'start_time')::time,'REMOVED',e.reason,e.before_value->>'observations',e.created_at,
   e.source_id,e.before_value->>'booking_id',e.before_value->>'reschedule_id',e.before_value->>'appointment_id',true
  from private.lesson_history_events e where e.tenant_id=p_tenant and e.source_type='class_logs' and e.action='DELETE'
   and e.before_value->>'teacher_id'=p_teacher::text and (e.before_value->>'class_date')::date between p_from and p_to
   and not exists(select 1 from public.class_logs l where l.id::text=e.source_id)
  union all
  select 'class_logs',e.source_id,(e.before_value->>'student_id')::uuid,(e.before_value->>'class_date')::date,
   (e.before_value->>'start_time')::time,'REASSIGNED',e.reason,e.before_value->>'observations',
   (e.before_value->>'created_at')::timestamptz,e.source_id,e.before_value->>'booking_id',e.before_value->>'reschedule_id',e.before_value->>'appointment_id',false
  from (select distinct on (ev.source_id) ev.* from private.lesson_history_events ev
   where ev.tenant_id=p_tenant and ev.source_type='class_logs' and ev.action='UPDATE'
    and ev.before_value->>'teacher_id'=p_teacher::text and ev.after_value->>'teacher_id' is distinct from p_teacher::text
    and (ev.before_value->>'class_date')::date between p_from and p_to
    and exists(select 1 from public.class_logs l where l.id::text=ev.source_id and l.tenant_id=p_tenant and l.teacher_id<>p_teacher)
   order by ev.source_id,ev.created_at desc,ev.id desc) e
 ), enriched as (
  select b.*,c.classification,c.notes correction_notes,c.reason correction_reason,c.version,c.updated_at,c.updated_by,
   p.full_name student_name,ev.created_at last_changed_at,ev.actor_name last_changed_by
  from base b left join public.profiles p on p.id=b.student_id and p.tenant_id=p_tenant
  left join private.lesson_history_corrections c on c.tenant_id=p_tenant and c.source_type=b.source_type and c.source_id=b.source_id and c.class_date=b.class_date
  left join lateral(select e.created_at,e.actor_name from private.lesson_history_events e
   where e.tenant_id=p_tenant and ((e.source_type=b.source_type and e.source_id=b.source_id)
    or (e.source_type='bookings' and e.source_id=b.booking_id) or (e.source_type='reschedules' and e.source_id=b.reschedule_id)
    or (e.source_type='appointments' and e.source_id=b.appointment_id)
    or (e.source_type in ('booking_schedule_versions','booking_occurrence_exclusions') and e.source_id=b.booking_id))
   order by e.created_at desc,e.id desc limit 1) ev on true
 ) select jsonb_build_object(
  'key',e.source_type||':'||e.source_id||':'||e.class_date,'source_type',e.source_type,'source_id',e.source_id,
  'student_id',e.student_id,'student_name',coalesce(e.student_name,'Sem aluno vinculado'),
  'class_date',e.class_date,'start_time',e.start_time,'category',coalesce(e.classification,e.category),
  'reason',coalesce(e.correction_reason,e.reason),'notes',coalesce(e.correction_notes,e.notes),
  'created_at',e.created_at,'created_by',(select ev.actor_name from private.lesson_history_events ev where ev.tenant_id=p_tenant and ev.source_type=e.source_type and ev.source_id=e.source_id and ev.action='INSERT' order by ev.created_at,ev.id limit 1),'last_changed_at',greatest(e.updated_at,e.last_changed_at),'last_changed_by',
  case when e.updated_at is not null and (e.last_changed_at is null or e.updated_at>=e.last_changed_at) then (select full_name from public.profiles where id=e.updated_by) else e.last_changed_by end,
  'version',coalesce(e.version,0),'class_log_id',e.class_log_id,
  'booking_id',e.booking_id,'reschedule_id',e.reschedule_id,'appointment_id',e.appointment_id,
  'disputes',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'description',d.description,'opened_at',d.opened_at,
   'opened_by',(select full_name from public.profiles where id=d.opened_by),'resolution',d.resolution,'resolved_at',d.resolved_at,
   'resolved_by',(select full_name from public.profiles where id=d.resolved_by)) order by d.opened_at)
   from private.lesson_history_disputes d where d.tenant_id=p_tenant and d.source_type=e.source_type and d.source_id=e.source_id and d.class_date=e.class_date),'[]'))
 from enriched e;
$$;
alter function private.lesson_history_rows(text,uuid,date,date) owner to postgres;
revoke all on function private.lesson_history_rows(text,uuid,date,date) from public,anon,authenticated,service_role;

create or replace function public.get_teacher_lesson_history(p_teacher uuid,p_from date default null,p_to date default null,p_student uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t text; f date:=p_from; until_date date:=p_to; rows jsonb; backlog jsonb; events jsonb; students jsonb; begin
 t:=private.lesson_history_authorize(p_teacher);
 -- Ambos nulos = conferência de toda a prestação, inclusive pendências antigas.
 if (f is null)<>(until_date is null) then raise exception 'history_invalid_period'; end if;
 if f is null then
  select coalesce(min(d),(now() at time zone 'America/Sao_Paulo')::date) into f from (
   select l.class_date d from public.class_logs l where l.tenant_id=t and l.teacher_id=p_teacher
   union all select coalesce(b.start_date,(b.created_at at time zone 'America/Sao_Paulo')::date) from public.bookings b where b.tenant_id=t and b.teacher_id=p_teacher
   union all select (r.created_at at time zone 'America/Sao_Paulo')::date from public.reschedules r where r.tenant_id=t and r.teacher_id=p_teacher
   union all select coalesce((e.before_value->>'start_date')::date,(e.before_value->>'created_at')::timestamptz::date) from private.lesson_history_events e where e.tenant_id=t and e.source_type='bookings' and e.before_value->>'teacher_id'=p_teacher::text
   union all select (e.before_value->>'class_date')::date from private.lesson_history_events e where e.tenant_id=t and e.source_type='class_logs' and e.before_value->>'teacher_id'=p_teacher::text
  ) dates;
  until_date:=(now() at time zone 'America/Sao_Paulo')::date+90;
 end if;
 if until_date<f or until_date-f>3660 then raise exception 'history_invalid_period'; end if;
 select coalesce(jsonb_agg(r.row_value order by r.row_value->>'class_date',r.row_value->>'start_time',r.row_value->>'key'),'[]') into rows
 from private.lesson_history_rows(t,p_teacher,f,until_date) r where p_student is null or r.row_value->>'student_id'=p_student::text;
 -- Passivo é explicitamente da carteira toda; não é somado aos eventos do período.
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'student_id',r.student_id,'student_name',p.full_name,
 'date',public.parse_lesson_date(r.date),'time',r.time,'fault_type',r.fault_type,'created_at',r.created_at) order by r.created_at,r.id),'[]') into backlog
 from public.reschedules r left join public.profiles p on p.id=r.student_id and p.tenant_id=t
 where r.tenant_id=t and r.teacher_id=p_teacher and r.used_at is null and r.closed_reason is null
  and (p_student is null or r.student_id=p_student)
  and not exists(select 1 from public.class_logs l where l.tenant_id=t and l.reschedule_id=r.id::text);
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.full_name,
 'currently_linked',s.professor_id=p_teacher or s.professor_id2=p_teacher or exists(select 1 from public.bookings b where b.tenant_id=t and b.teacher_id=p_teacher and b.student_id=s.id and b.status='SCHEDULED'),
 'last_activity',(select max(l.class_date) from public.class_logs l where l.tenant_id=t and l.teacher_id=p_teacher and l.student_id=s.id)) order by s.full_name,s.id),'[]') into students
 from public.profiles s where s.tenant_id=t and s.role='STUDENT' and (p_student is null or s.id=p_student) and (
  s.professor_id=p_teacher or s.professor_id2=p_teacher or exists(select 1 from public.class_logs l where l.tenant_id=t and l.teacher_id=p_teacher and l.student_id=s.id)
  or exists(select 1 from public.bookings b where b.tenant_id=t and b.teacher_id=p_teacher and b.student_id=s.id)
  or exists(select 1 from public.reschedules r where r.tenant_id=t and r.teacher_id=p_teacher and r.student_id=s.id)
  or exists(select 1 from private.lesson_history_events ev where ev.tenant_id=t
   and ((ev.after_value->>'teacher_id'=p_teacher::text and ev.after_value->>'student_id'=s.id::text)
    or (ev.before_value->>'teacher_id'=p_teacher::text and ev.before_value->>'student_id'=s.id::text))));
 with candidates as (
  select ev.id::text id,ev.source_type,ev.source_id,ev.action,ev.before_value,ev.after_value,ev.actor_name,ev.created_at,ev.reason
  from private.lesson_history_events ev where ev.tenant_id=t
   and (ev.after_value->>'teacher_id'=p_teacher::text or ev.before_value->>'teacher_id'=p_teacher::text)
  union all
  select 'reschedule-event:'||re.id,'reschedules',re.reschedule_id::text,re.action,
   jsonb_build_object('date',re.from_date,'time',re.from_time),
   jsonb_build_object('teacher_id',re.teacher_id,'student_id',re.student_id,'date',re.to_date,'time',re.to_time,'source',re.source),
   (select full_name from public.profiles where id=re.actor_id),re.created_at,re.reason
  from public.reschedule_events re where re.tenant_id=t and re.teacher_id=p_teacher
 ) select coalesce(jsonb_agg(jsonb_build_object('id',ev.id,'source_type',ev.source_type,'source_id',ev.source_id,
 'action',ev.action,'before',ev.before_value,'after',ev.after_value,'actor',ev.actor_name,'created_at',ev.created_at,'reason',ev.reason) order by ev.created_at,ev.id),'[]') into events
 from candidates ev where exists(select 1 from jsonb_array_elements(rows) r where
  (ev.source_type=r->>'source_type' and ev.source_id=r->>'source_id')
  or (ev.source_type in ('bookings','booking_schedule_versions','booking_occurrence_exclusions') and ev.source_id=r->>'booking_id')
  or (ev.source_type='reschedules' and ev.source_id=r->>'reschedule_id')
  or (ev.source_type='appointments' and ev.source_id=r->>'appointment_id'))
  or (ev.source_type='reschedules' and exists(select 1 from jsonb_array_elements(backlog) br where br->>'id'=ev.source_id))
  or (ev.action='DELETE' and (ev.created_at at time zone 'America/Sao_Paulo')::date between f and until_date
   and (p_student is null or ev.before_value->>'student_id'=p_student::text));

 return jsonb_build_object('teacher_id',p_teacher,'teacher_name',(select full_name from public.profiles where id=p_teacher),
 'from',f,'to',until_date,'all_service',p_from is null,'generated_at',clock_timestamp(),'rows',rows,'backlog',backlog,'students',students,'events',events,
 'totals',coalesce((select jsonb_object_agg(category,n) from(select r->>'category' category,count(*) n from jsonb_array_elements(rows) r group by r->>'category') counts),'{}'::jsonb));
end $$;

create or replace function public.correct_lesson_history(p_teacher uuid,p_source_type text,p_source_id text,p_date date,p_expected_version integer,p_notes text,p_reason text,p_classification text default null)
returns void language plpgsql security definer set search_path='' as $$
declare t text; r jsonb; old_value jsonb; new_value jsonb; current_version integer; b public.bookings%rowtype; begin
 t:=private.lesson_history_authorize(p_teacher);
 if coalesce(public._my_role(),'') not in ('SCHOOL_ADMIN','COORDINATOR') then raise exception 'history_manager_required' using errcode='42501'; end if;
 if length(btrim(coalesce(p_reason,''))) not between 10 and 1000 or length(coalesce(p_notes,''))>1000
 or p_expected_version is null or (p_classification is not null and p_classification not in ('HOLIDAY','TEACHER_CANCELLED')) then raise exception 'history_invalid_correction'; end if;
 perform pg_advisory_xact_lock(hashtextextended(t||':'||p_source_type||':'||p_source_id||':'||p_date,0));
 select row_value into r from private.lesson_history_rows(t,p_teacher,p_date,p_date) where row_value->>'source_type'=p_source_type and row_value->>'source_id'=p_source_id;
 if r is null then raise exception 'history_record_not_found'; end if;
 select to_jsonb(c),c.version into old_value,current_version from private.lesson_history_corrections c
 where c.tenant_id=t and c.source_type=p_source_type and c.source_id=p_source_id and c.class_date=p_date for update;
 if coalesce(current_version,0)<>p_expected_version then raise exception 'history_version_conflict'; end if;
 if p_classification is not null or r->>'category' in ('HOLIDAY','TEACHER_CANCELLED') then
  if p_source_type<>'bookings' or r->>'class_log_id' is not null or r->>'category' not in ('SCHEDULED','UNFINALIZED','EXCLUDED','HOLIDAY','TEACHER_CANCELLED') then raise exception 'history_classification_not_allowed'; end if;
  select * into strict b from public.bookings where id=p_source_id::uuid and tenant_id=t for update;
  if b.teacher_id<>p_teacher or exists(select 1 from public.class_logs l where l.tenant_id=t and l.booking_id=p_source_id and l.class_date=p_date)
   or exists(select 1 from public.lesson_advances a where a.tenant_id=t and a.booking_id=b.id and a.original_date=p_date and a.status<>'CANCELLED') then raise exception 'history_occurrence_consumed'; end if;
  if p_classification is null then
   delete from public.booking_occurrence_exclusions where tenant_id=t and booking_id=b.id and class_date=p_date;
  elsif not exists(select 1 from public.booking_occurrence_exclusions x where x.tenant_id=t and x.booking_id=b.id and x.class_date=p_date) then
   if not coalesce((public.booking_schedule_on_date(b.id,p_date)->>'valid')::boolean,false) then raise exception 'history_invalid_occurrence'; end if;
   insert into public.booking_occurrence_exclusions(tenant_id,booking_id,class_date,reason,created_by) values(t,b.id,p_date,left(btrim(p_reason),500),auth.uid());
  end if;
 end if;
 insert into private.lesson_history_corrections(tenant_id,source_type,source_id,class_date,teacher_id,student_id,classification,notes,reason,version,updated_by)
 values(t,p_source_type,p_source_id,p_date,p_teacher,(r->>'student_id')::uuid,p_classification,coalesce(p_notes,''),btrim(p_reason),1,auth.uid())
 on conflict(tenant_id,source_type,source_id,class_date) do update set classification=excluded.classification,notes=excluded.notes,reason=excluded.reason,
 version=lesson_history_corrections.version+1,updated_by=auth.uid(),updated_at=clock_timestamp()
 returning to_jsonb(lesson_history_corrections.*) into new_value;
 insert into private.lesson_history_events(tenant_id,source_type,source_id,before_value,after_value,action,actor_id,actor_name,reason)
 values(t,p_source_type,p_source_id,coalesce(old_value,jsonb_build_object('teacher_id',p_teacher,'student_id',r->'student_id','class_date',p_date,'notes',r->'notes','classification',r->'category','reason',r->'reason','version',0)),new_value,'CORRECTION',auth.uid(),(select full_name from public.profiles where id=auth.uid()),btrim(p_reason));
end $$;

create or replace function public.open_lesson_history_dispute(p_teacher uuid,p_source_type text,p_source_id text,p_date date,p_description text)
returns uuid language plpgsql security definer set search_path='' as $$
declare t text; r jsonb; d private.lesson_history_disputes; begin
 t:=private.lesson_history_authorize(p_teacher);
 select row_value into r from private.lesson_history_rows(t,p_teacher,p_date,p_date) where row_value->>'source_type'=p_source_type and row_value->>'source_id'=p_source_id;
 if r is null then raise exception 'history_record_not_found'; end if;
 insert into private.lesson_history_disputes(tenant_id,source_type,source_id,class_date,teacher_id,student_id,opened_by,description)
 values(t,p_source_type,p_source_id,p_date,p_teacher,(r->>'student_id')::uuid,auth.uid(),btrim(p_description)) returning * into d;
 insert into private.lesson_history_events(tenant_id,source_type,source_id,after_value,action,actor_id,actor_name,reason)
 values(t,p_source_type,p_source_id,to_jsonb(d),'DISPUTE',auth.uid(),(select full_name from public.profiles where id=auth.uid()),btrim(p_description));
 return d.id;
end $$;
create or replace function public.resolve_lesson_history_dispute(p_id uuid,p_resolution text)
returns void language plpgsql security definer set search_path='' as $$
declare d private.lesson_history_disputes; t text; old_value jsonb; begin
 select * into strict d from private.lesson_history_disputes where id=p_id for update;
 t:=private.lesson_history_authorize(d.teacher_id);
 if t<>d.tenant_id or coalesce(public._my_role(),'') not in ('SCHOOL_ADMIN','COORDINATOR') then raise exception 'history_manager_required' using errcode='42501'; end if;
 if d.resolved_at is not null then raise exception 'history_dispute_already_resolved'; end if;
 old_value:=to_jsonb(d);
 update private.lesson_history_disputes set resolution=btrim(p_resolution),resolved_by=auth.uid(),resolved_at=clock_timestamp() where id=p_id returning * into d;
 insert into private.lesson_history_events(tenant_id,source_type,source_id,before_value,after_value,action,actor_id,actor_name,reason)
 values(t,d.source_type,d.source_id,old_value,to_jsonb(d),'RESOLUTION',auth.uid(),(select full_name from public.profiles where id=auth.uid()),btrim(p_resolution));
end $$;

alter function public.list_lesson_history_teachers() owner to postgres;
alter function public.get_teacher_lesson_history(uuid,date,date,uuid) owner to postgres;
alter function public.correct_lesson_history(uuid,text,text,date,integer,text,text,text) owner to postgres;
alter function public.open_lesson_history_dispute(uuid,text,text,date,text) owner to postgres;
alter function public.resolve_lesson_history_dispute(uuid,text) owner to postgres;
revoke all on function public.list_lesson_history_teachers(),public.get_teacher_lesson_history(uuid,date,date,uuid),
 public.correct_lesson_history(uuid,text,text,date,integer,text,text,text),public.open_lesson_history_dispute(uuid,text,text,date,text),
 public.resolve_lesson_history_dispute(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.list_lesson_history_teachers(),public.get_teacher_lesson_history(uuid,date,date,uuid),
 public.correct_lesson_history(uuid,text,text,date,integer,text,text,text),public.open_lesson_history_dispute(uuid,text,text,date,text),
 public.resolve_lesson_history_dispute(uuid,text) to authenticated;
