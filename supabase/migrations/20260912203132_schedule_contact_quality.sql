-- Independent quality contacts and family-approved schedule changes.
-- Re-entrant: the VPS release validates the migration list twice in a transaction.
create schema if not exists private;

create or replace function private.quality_school_manager(p_tenant text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(coalesce(p.lifecycle_status,'active')) = 'active'
      and (p.role = 'SUPER_ADMIN' or (p.tenant_id = p_tenant
        and p.role in ('SCHOOL_ADMIN','COORDINATOR')
        and exists(select 1 from public.tenant_memberships m where m.user_id=p.id
          and m.tenant_id=p_tenant and m.status='ACTIVE' and m.role=p.role)))
  );
$$;
revoke all on function private.quality_school_manager(text) from public,anon;
grant execute on function private.quality_school_manager(text) to authenticated,service_role;

create table if not exists public.student_quality_contacts (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  student_id uuid not null references public.profiles(id),
  name text not null check (length(btrim(name)) between 2 and 120),
  phone text not null check (phone ~ '^[1-9][0-9]{10,14}$'),
  relationship text not null check (relationship in ('STUDENT','GUARDIAN')),
  verified_at timestamptz,
  verified_by uuid references public.profiles(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,student_id,phone)
);
create index if not exists student_quality_contacts_student_idx on public.student_quality_contacts(student_id);
create index if not exists student_quality_contacts_recipient_idx on public.student_quality_contacts(tenant_id,phone) where active and verified_at is not null;
create index if not exists student_quality_contacts_verifier_idx on public.student_quality_contacts(verified_by);

create table if not exists public.student_contact_change_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  student_id uuid not null references public.profiles(id),
  requested_by uuid not null references public.profiles(id),
  name text not null,
  phone text not null check (phone ~ '^[1-9][0-9]{10,14}$'),
  relationship text not null check (relationship in ('STUDENT','GUARDIAN')),
  reason text not null check(length(btrim(reason)) between 8 and 1000),
  status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  contact_id uuid references public.student_quality_contacts(id),
  created_at timestamptz not null default now()
);
create index if not exists student_contact_requests_student_idx on public.student_contact_change_requests(student_id,created_at desc);
create index if not exists student_contact_requests_tenant_status_idx on public.student_contact_change_requests(tenant_id,status,created_at);
create index if not exists student_contact_requests_requester_idx on public.student_contact_change_requests(requested_by);
create index if not exists student_contact_requests_reviewer_idx on public.student_contact_change_requests(reviewed_by);
create index if not exists student_contact_requests_contact_idx on public.student_contact_change_requests(contact_id);

create table if not exists public.quality_contact_events (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  contact_id uuid not null references public.student_quality_contacts(id),
  actor_id uuid not null references public.profiles(id),
  action text not null,
  before_data jsonb,
  after_data jsonb not null,
  note text not null,
  created_at timestamptz not null default now()
);
create index if not exists quality_contact_events_contact_idx on public.quality_contact_events(contact_id,created_at);
create index if not exists quality_contact_events_tenant_idx on public.quality_contact_events(tenant_id,created_at);
create index if not exists quality_contact_events_actor_idx on public.quality_contact_events(actor_id);

alter table public.student_quality_contacts enable row level security;
alter table public.student_contact_change_requests enable row level security;
alter table public.quality_contact_events enable row level security;
drop policy if exists quality_contacts_read on public.student_quality_contacts;
create policy quality_contacts_read on public.student_quality_contacts for select to authenticated
 using (private.quality_school_manager(tenant_id) or student_id=(select auth.uid()));
drop policy if exists quality_contact_requests_read on public.student_contact_change_requests;
create policy quality_contact_requests_read on public.student_contact_change_requests for select to authenticated
 using (private.quality_school_manager(tenant_id) or requested_by=(select auth.uid()));
drop policy if exists quality_contact_events_read on public.quality_contact_events;
create policy quality_contact_events_read on public.quality_contact_events for select to authenticated
 using (private.quality_school_manager(tenant_id));
revoke all on public.student_quality_contacts,public.student_contact_change_requests,public.quality_contact_events from public,anon,authenticated;
grant select on public.student_quality_contacts,public.student_contact_change_requests,public.quality_contact_events to authenticated;
grant all on public.student_quality_contacts,public.student_contact_change_requests,public.quality_contact_events to service_role;

create or replace function public.request_student_contact_change(p_student_id uuid,p_name text,p_phone text,p_relationship text,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.profiles%rowtype; v_phone text; v_id uuid;
begin
  select * into s from public.profiles where id=p_student_id and role='STUDENT';
  if not found or auth.uid() is null or not (
    private.quality_school_manager(s.tenant_id) or auth.uid()=s.id or
    (public._my_role()='TEACHER' and public._my_tenant_id()=s.tenant_id
      and public._teacher_can_access_student(s.id,s.tenant_id))
  ) then raise exception using errcode='42501',message='student_not_available'; end if;
  v_phone:=regexp_replace(coalesce(p_phone,''),'[^0-9]','','g');
  if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;
  if v_phone !~ '^[1-9][0-9]{10,14}$' or coalesce(length(btrim(p_name)),0) not between 2 and 120
    or coalesce(length(btrim(p_reason)),0) not between 8 and 1000
    or p_relationship is null or p_relationship not in ('STUDENT','GUARDIAN') then
    raise exception using errcode='22023',message='invalid_contact_request';
  end if;
  insert into public.student_contact_change_requests(tenant_id,student_id,requested_by,name,phone,relationship,reason)
    values(s.tenant_id,s.id,auth.uid(),btrim(p_name),v_phone,p_relationship,btrim(p_reason)) returning id into v_id;
  return jsonb_build_object('ok',true,'id',v_id,'status','PENDING');
end;
$$;

create or replace function public.review_student_contact_change(p_request_id uuid,p_approve boolean,p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.student_contact_change_requests%rowtype; c public.student_quality_contacts%rowtype; old_data jsonb;
begin
  select * into r from public.student_contact_change_requests where id=p_request_id for update;
  if not found or not private.quality_school_manager(r.tenant_id) then
    raise exception using errcode='42501',message='school_review_required'; end if;
  if coalesce(length(btrim(p_note)),0) not between 8 and 1000 or p_approve is null then
    raise exception using errcode='22023',message='verification_note_required'; end if;
  if r.status<>'PENDING' then return jsonb_build_object('ok',true,'already',true,'status',r.status); end if;
  if p_approve then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('quality-contact:'||r.tenant_id||':'||r.student_id::text||':'||r.phone,0));
    select * into c from public.student_quality_contacts where tenant_id=r.tenant_id and student_id=r.student_id and phone=r.phone for update;
    old_data:=case when found then to_jsonb(c) else null end;
    insert into public.student_quality_contacts(tenant_id,student_id,name,phone,relationship,verified_at,verified_by)
      values(r.tenant_id,r.student_id,r.name,r.phone,r.relationship,now(),auth.uid())
      on conflict(tenant_id,student_id,phone) do update set name=excluded.name,relationship=excluded.relationship,
        verified_at=now(),verified_by=auth.uid(),active=true,updated_at=now() returning * into c;
    insert into public.quality_contact_events(tenant_id,contact_id,actor_id,action,before_data,after_data,note)
      values(r.tenant_id,c.id,auth.uid(),'SCHOOL_VERIFIED',old_data,to_jsonb(c),btrim(p_note));
  end if;
  update public.student_contact_change_requests set status=case when p_approve then 'APPROVED' else 'REJECTED' end,
    reviewed_by=auth.uid(),reviewed_at=now(),review_note=btrim(p_note),contact_id=c.id where id=r.id;
  return jsonb_build_object('ok',true,'contact_id',c.id);
end;
$$;

create or replace function public.deactivate_student_quality_contact(p_contact_id uuid,p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.student_quality_contacts%rowtype; old_data jsonb;
begin
 select * into c from public.student_quality_contacts where id=p_contact_id for update;
 if not found or not private.quality_school_manager(c.tenant_id) then raise exception using errcode='42501',message='school_review_required'; end if;
 if coalesce(length(btrim(p_note)),0) not between 8 and 1000 then raise exception 'verification_note_required'; end if;
 if not c.active then return jsonb_build_object('ok',true,'already',true); end if;
 old_data:=to_jsonb(c);
 update public.student_quality_contacts set active=false,updated_at=now() where id=c.id returning * into c;
 insert into public.quality_contact_events(tenant_id,contact_id,actor_id,action,before_data,after_data,note)
 values(c.tenant_id,c.id,auth.uid(),'DEACTIVATED',old_data,to_jsonb(c),btrim(p_note));
 return jsonb_build_object('ok',true);
end;
$$;

create or replace function private.protect_independent_student_contact()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if old.role='STUDENT' and public._my_role()='TEACHER' and
   (new.phone is distinct from old.phone or new.attendance_phone is distinct from old.attendance_phone
    or new.meeting_link is distinct from old.meeting_link) then
   raise exception using errcode='42501',message='Contato de auditoria e sala oficial exigem revisão da escola. Solicite a correção.';
 end if;
 return new;
end;
$$;
drop trigger if exists protect_independent_student_contact on public.profiles;
create trigger protect_independent_student_contact before update of phone,attendance_phone,meeting_link on public.profiles
 for each row execute function private.protect_independent_student_contact();
revoke all on function private.protect_independent_student_contact() from public,anon,authenticated,service_role;

create table if not exists public.schedule_change_requests (
 id uuid primary key default extensions.gen_random_uuid(),
 tenant_id text not null references public.tenants(id),
 booking_id uuid not null references public.bookings(id),
 student_id uuid not null references public.profiles(id),
 teacher_id uuid not null references public.profiles(id),
 requested_by uuid not null references public.profiles(id),
 initiated_by text not null check(initiated_by in ('TEACHER','STUDENT','GUARDIAN','SCHOOL')),
 scope text not null check(scope in ('PERMANENT','ONE_OFF')),
 effective_from date not null,
 original_date date,
 proposed_date date,
 old_day text not null,
 old_time text not null,
 new_day text not null,
 new_time text not null check(new_time ~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$'),
 reason text not null check(length(btrim(reason)) between 8 and 1000),
 status text not null default 'PENDING_FAMILY' check(status in ('PENDING_FAMILY','ACCEPTED','REJECTED','APPLIED','CANCELLED')),
 contact_id uuid references public.student_quality_contacts(id),
 family_responded_at timestamptz,
 family_response_source text,
 reviewed_by uuid references public.profiles(id),
 reviewed_at timestamptz,
 review_note text,
 history jsonb not null default '[]',
 created_at timestamptz not null default now(),
 check((scope='PERMANENT' and original_date is null and proposed_date is null) or
   (scope='ONE_OFF' and original_date is not null and proposed_date is not null))
);
create index if not exists schedule_change_requests_student_idx on public.schedule_change_requests(student_id,created_at desc);
create index if not exists schedule_change_requests_teacher_idx on public.schedule_change_requests(teacher_id,created_at desc);
create index if not exists schedule_change_requests_tenant_idx on public.schedule_change_requests(tenant_id,status,created_at);
create index if not exists schedule_change_requests_booking_idx on public.schedule_change_requests(booking_id,status);
create index if not exists schedule_change_requests_requester_idx on public.schedule_change_requests(requested_by);
create index if not exists schedule_change_requests_reviewer_idx on public.schedule_change_requests(reviewed_by);
create index if not exists schedule_change_requests_contact_idx on public.schedule_change_requests(contact_id);
create unique index if not exists schedule_change_one_pending_idx on public.schedule_change_requests(booking_id)
 where status in ('PENDING_FAMILY','ACCEPTED');

create table if not exists public.booking_schedule_versions (
 id uuid primary key default extensions.gen_random_uuid(),
 tenant_id text not null references public.tenants(id),
 booking_id uuid not null references public.bookings(id),
 valid_from date not null,
 valid_until date,
 day_of_week text not null,
 time_slot text not null,
 request_id uuid references public.schedule_change_requests(id),
 created_at timestamptz not null default now(),
 unique(booking_id,valid_from),
 check(valid_until is null or valid_until>=valid_from)
);
create index if not exists booking_schedule_versions_request_idx on public.booking_schedule_versions(request_id);
create index if not exists booking_schedule_versions_tenant_idx on public.booking_schedule_versions(tenant_id);
create table if not exists private.schedule_change_tokens (
 request_id uuid primary key references public.schedule_change_requests(id),
 contact_id uuid not null references public.student_quality_contacts(id),
 token_hash text not null unique,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
alter table private.schedule_change_tokens add column if not exists delivery_body_hash text;
create index if not exists schedule_change_tokens_contact_idx on private.schedule_change_tokens(contact_id);
alter table private.schedule_change_tokens enable row level security;
revoke all on private.schedule_change_tokens from public,anon,authenticated,service_role;
alter table public.schedule_change_requests enable row level security;
alter table public.booking_schedule_versions enable row level security;
drop policy if exists schedule_change_requests_read on public.schedule_change_requests;
create policy schedule_change_requests_read on public.schedule_change_requests for select to authenticated
 using(private.quality_school_manager(tenant_id) or teacher_id=(select auth.uid()) or student_id=(select auth.uid()));
drop policy if exists booking_schedule_versions_read on public.booking_schedule_versions;
create policy booking_schedule_versions_read on public.booking_schedule_versions for select to authenticated
 using(exists(select 1 from public.bookings b where b.id=booking_id));
revoke all on public.schedule_change_requests,public.booking_schedule_versions from public,anon,authenticated;
grant select on public.schedule_change_requests,public.booking_schedule_versions to authenticated;
grant all on public.schedule_change_requests,public.booking_schedule_versions to service_role;

create or replace function public.booking_schedule_on_date(p_booking_id uuid,p_date date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare b public.bookings%rowtype; v public.booking_schedule_versions%rowtype; r public.schedule_change_requests%rowtype;
 d text; t text; v_valid boolean; v_request uuid;
begin
 select * into b from public.bookings where id=p_booking_id;
 if not found or p_date is null then return jsonb_build_object('valid',false,'excluded',false); end if;
 select * into v from public.booking_schedule_versions where booking_id=b.id
   and valid_from<=p_date and (valid_until is null or valid_until>=p_date) order by valid_from desc limit 1;
 d:=coalesce(v.day_of_week,b.day_of_week); t:=left(coalesce(v.time_slot,b.time_slot),5); v_request:=v.request_id;
 if exists(select 1 from public.lesson_advances a where a.booking_id=b.id and a.tenant_id=b.tenant_id and a.original_date=p_date and a.status<>'CANCELLED') then
   return jsonb_build_object('valid',false,'excluded',true,'day_of_week',d,'time_slot',t);
 end if;
 select * into r from public.schedule_change_requests where booking_id=b.id and status='APPLIED' and scope='ONE_OFF'
   and (original_date=p_date or proposed_date=p_date) order by created_at desc limit 1;
 if found then
   if r.original_date=p_date and r.proposed_date<>p_date then
     return jsonb_build_object('valid',false,'excluded',true,'day_of_week',d,'time_slot',t,'request_id',r.id);
   end if;
   d:=r.new_day; t:=r.new_time; v_request:=r.id;
   v_valid:=r.proposed_date=p_date;
 else
   v_valid:=extract(dow from p_date)::integer=case public.fold_accents(d)
     when 'domingo' then 0 when 'segunda' then 1 when 'terca' then 2 when 'quarta' then 3
     when 'quinta' then 4 when 'sexta' then 5 when 'sabado' then 6 else -1 end;
 end if;
 v_valid:=v_valid and upper(coalesce(b.status,''))='SCHEDULED'
   and (b.start_date is null or p_date>=b.start_date) and (b.date is null or p_date=b.date);
 return jsonb_build_object('valid',coalesce(v_valid,false),'excluded',false,'day_of_week',d,'time_slot',t,'request_id',v_request);
end;
$$;

create or replace function private.schedule_change_has_conflict(p_request_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 with request as (select * from public.schedule_change_requests where id=p_request_id),
 proposed_days as (
   select r.*,case when r.scope='ONE_OFF' then r.proposed_date else r.effective_from+n end as target_date
   from request r cross join pg_catalog.generate_series(0,370) n
   where (r.scope='ONE_OFF' and n=0) or (r.scope='PERMANENT' and
     extract(dow from r.effective_from+n)::integer=public.dow_name_to_int(r.new_day))
 )
 select exists(
   select 1 from proposed_days p join public.bookings b on b.tenant_id=p.tenant_id and b.id<>p.booking_id
     and (b.teacher_id=p.teacher_id or b.student_id=p.student_id) and upper(b.status)='SCHEDULED'
   cross join lateral (select public.booking_schedule_on_date(b.id,p.target_date) as value) s
   where coalesce((s.value->>'valid')::boolean,false) and s.value->>'time_slot'=p.new_time
 ) or exists(
   select 1 from proposed_days p join public.lesson_advances a on a.tenant_id=p.tenant_id and a.status='SCHEDULED'
    and (a.teacher_id=p.teacher_id or a.student_id=p.student_id) and a.advance_date=p.target_date and a.advance_time=p.new_time::time
 ) or exists(
   select 1 from proposed_days p join public.reschedules rs on rs.tenant_id=p.tenant_id and rs.used_at is null
     and (rs.teacher_id=p.teacher_id or rs.student_id=p.student_id) and public.parse_lesson_date(rs.date)=p.target_date
     and left(btrim(rs.time),5)=p.new_time
 ) or exists(
   select 1 from proposed_days p join public.class_coverages c on c.tenant_id=p.tenant_id and c.cover_teacher_id=p.teacher_id
    and c.class_date=p.target_date and left(c.class_time,5)=p.new_time
    and (lower(c.status)='confirmed' or (lower(c.status)='pending' and coalesce(c.invite_expires_at,
       (c.class_date+c.class_time::time) at time zone 'America/Sao_Paulo')>now()))
 ) or exists(
   select 1 from proposed_days p join public.appointments a on a.tenant_id=p.tenant_id
     and coalesce(a.teacher_id,a.professor_id)=p.teacher_id
     and lower(coalesce(a.status,'')) in ('scheduled','confirmed')
     and a.start_time < ((p.target_date+p.new_time::time) at time zone 'America/Sao_Paulo')+interval '30 minutes'
     and a.start_time+interval '30 minutes' > ((p.target_date+p.new_time::time) at time zone 'America/Sao_Paulo')
 );
$$;
revoke all on function private.schedule_change_has_conflict(uuid) from public,anon,authenticated,service_role;

create or replace function public.request_booking_schedule_change(p_booking_id uuid,p_new_day text,p_new_time text,
 p_effective_from date,p_reason text,p_scope text default 'PERMANENT',p_original_date date default null,
 p_proposed_date date default null,p_initiated_by text default 'TEACHER')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; s jsonb; v_id uuid; d text; v_today date:=(now() at time zone 'America/Sao_Paulo')::date;
begin
 select * into b from public.bookings where id=p_booking_id for update;
 if not found or auth.uid() is null or not (private.quality_school_manager(b.tenant_id)
  or (public._my_role()='TEACHER' and auth.uid()=b.teacher_id and public._my_tenant_id()=b.tenant_id)) then
  raise exception using errcode='42501',message='booking_not_available'; end if;
 if upper(b.status)<>'SCHEDULED' or b.date is not null then raise exception 'recurring_booking_required'; end if;
 if (select count(*) from public.profiles p where p.id in(b.student_id,b.teacher_id) and p.tenant_id=b.tenant_id
   and lower(coalesce(p.lifecycle_status,''))='active' and exists(select 1 from public.tenant_memberships m
    where m.user_id=p.id and m.tenant_id=b.tenant_id and m.status='ACTIVE' and m.role=p.role))<>2 then raise exception 'inactive_schedule_participant'; end if;
 if public._my_role()='TEACHER' and p_initiated_by='SCHOOL' then raise exception using errcode='42501',message='school_initiator_requires_school_actor'; end if;
 if coalesce(length(btrim(p_reason)),0) not between 8 and 1000 or p_effective_from is null
  or p_effective_from<=v_today or p_effective_from>v_today+366
  or p_scope is null or p_scope not in ('PERMANENT','ONE_OFF')
  or p_initiated_by is null or p_initiated_by not in ('TEACHER','STUDENT','GUARDIAN','SCHOOL')
  or coalesce(p_new_time,'') !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' then raise exception 'invalid_schedule_request'; end if;
 d:=case public.fold_accents(p_new_day) when 'segunda' then 'Segunda' when 'terca' then 'Terça'
   when 'quarta' then 'Quarta' when 'quinta' then 'Quinta' when 'sexta' then 'Sexta' when 'sabado' then 'Sábado' else null end;
 if d is null then raise exception 'invalid_schedule_day'; end if;
 if p_scope='ONE_OFF' and (p_original_date is null or p_proposed_date is null or p_original_date<=v_today
   or p_proposed_date<=v_today or p_proposed_date>v_today+366 or p_effective_from<>p_original_date
   or extract(dow from p_proposed_date)::integer<>case public.fold_accents(d)
      when 'segunda' then 1 when 'terca' then 2 when 'quarta' then 3 when 'quinta' then 4 when 'sexta' then 5 when 'sabado' then 6 end) then
   raise exception 'invalid_one_off_dates'; end if;
 if p_scope='PERMANENT' and (p_original_date is not null or p_proposed_date is not null) then raise exception 'invalid_permanent_dates'; end if;
 s:=public.booking_schedule_on_date(b.id,coalesce(p_original_date,p_effective_from));
 if p_scope='ONE_OFF' and not coalesce((s->>'valid')::boolean,false) then raise exception 'original_occurrence_not_available'; end if;
 if p_scope='ONE_OFF' and p_original_date<>p_proposed_date
   and coalesce((public.booking_schedule_on_date(b.id,p_proposed_date)->>'valid')::boolean,false) then
   raise exception 'target_date_already_has_this_lesson'; end if;
 if p_scope='PERMANENT' and exists(select 1 from public.booking_schedule_versions where booking_id=b.id and valid_from>=p_effective_from) then
   raise exception 'future_schedule_already_planned'; end if;
 if p_scope='ONE_OFF' and exists(select 1 from public.schedule_change_requests where booking_id=b.id and status='APPLIED'
   and scope='ONE_OFF' and (original_date in (p_original_date,p_proposed_date) or proposed_date in (p_original_date,p_proposed_date))) then
   raise exception 'occurrence_already_changed'; end if;
 insert into public.schedule_change_requests(tenant_id,booking_id,student_id,teacher_id,requested_by,initiated_by,
  scope,effective_from,original_date,proposed_date,old_day,old_time,new_day,new_time,reason,history)
 values(b.tenant_id,b.id,b.student_id,b.teacher_id,auth.uid(),p_initiated_by,p_scope,p_effective_from,p_original_date,p_proposed_date,
  s->>'day_of_week',s->>'time_slot',d,p_new_time,btrim(p_reason),jsonb_build_array(jsonb_build_object('action','REQUESTED','actor_id',auth.uid(),'actor_role',public._my_role(),'reported_initiator',p_initiated_by,'initiator_is_self_report',true,'at',now())))
 returning id into v_id;
 return jsonb_build_object('ok',true,'id',v_id,'status','PENDING_FAMILY');
end;
$$;

create or replace function public.issue_schedule_change_link(p_request_id uuid,p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.schedule_change_requests%rowtype; c public.student_quality_contacts%rowtype; v_token text;
begin
 select * into r from public.schedule_change_requests where id=p_request_id for update;
 if not found or not private.quality_school_manager(r.tenant_id) then raise exception using errcode='42501',message='school_review_required'; end if;
 if r.status<>'PENDING_FAMILY' then raise exception 'request_not_pending'; end if;
 select * into c from public.student_quality_contacts where id=p_contact_id and tenant_id=r.tenant_id and student_id=r.student_id
  and active and verified_at is not null;
 if not found then raise exception 'verified_family_contact_required'; end if;
 v_token:=encode(extensions.gen_random_bytes(32),'hex');
 insert into private.schedule_change_tokens(request_id,contact_id,token_hash,expires_at)
 values(r.id,c.id,encode(extensions.digest(v_token,'sha256'),'hex'),least(now()+interval '7 days',r.effective_from::timestamp at time zone 'America/Sao_Paulo'))
 on conflict(request_id) do update set contact_id=excluded.contact_id,token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=now(),delivery_body_hash=null;
 update public.schedule_change_requests set contact_id=c.id,
 history=history||jsonb_build_array(jsonb_build_object('action','FAMILY_LINK_ISSUED','actor_id',auth.uid(),'contact_id',c.id,'at',now())) where id=r.id;
 return jsonb_build_object('ok',true,'token',v_token,'contact_name',c.name,'phone',c.phone);
end;
$$;

create or replace function public.get_schedule_change_public(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.schedule_change_requests%rowtype;
begin
 if coalesce(p_token,'') !~ '^[a-f0-9]{64}$' then return jsonb_build_object('found',false); end if;
 select sr.* into r from private.schedule_change_tokens t join public.schedule_change_requests sr on sr.id=t.request_id
 join public.student_quality_contacts c on c.id=t.contact_id and c.student_id=sr.student_id and c.tenant_id=sr.tenant_id
 where t.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and t.expires_at>now() and c.active and c.verified_at is not null;
 if not found then return jsonb_build_object('found',false); end if;
 return jsonb_build_object('found',true,'status',r.status,'scope',r.scope,'old_day',r.old_day,'old_time',r.old_time,
  'new_day',r.new_day,'new_time',r.new_time,'original_date',r.original_date,'proposed_date',r.proposed_date,'effective_from',r.effective_from,
  'reason',r.reason,'reported_initiator',r.initiated_by,'recorded_by_role',(select role from public.profiles where id=r.requested_by),'student_name',(select full_name from public.profiles where id=r.student_id),
  'teacher_name',(select full_name from public.profiles where id=r.teacher_id));
end;
$$;

create or replace function public.respond_schedule_change_public(p_token text,p_accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.schedule_change_requests%rowtype; v_id uuid;
begin
 if p_accept is null or coalesce(p_token,'') !~ '^[a-f0-9]{64}$' then raise exception 'invalid_response'; end if;
 select t.request_id into v_id from private.schedule_change_tokens t where t.token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
 select * into r from public.schedule_change_requests where id=v_id for update;
 if not found or not coalesce((public.get_schedule_change_public(p_token)->>'found')::boolean,false) then raise exception 'expired_link'; end if;
 if r.status<>'PENDING_FAMILY' then return jsonb_build_object('ok',true,'already',true,'status',r.status); end if;
 update public.schedule_change_requests set status=case when p_accept then 'ACCEPTED' else 'REJECTED' end,
 family_responded_at=now(),family_response_source='VERIFIED_CONTACT_TOKEN',
 history=history||jsonb_build_array(jsonb_build_object('action',case when p_accept then 'FAMILY_ACCEPTED' else 'FAMILY_REJECTED' end,
  'contact_id',r.contact_id,'at',now())) where id=r.id;
 return jsonb_build_object('ok',true,'status',case when p_accept then 'ACCEPTED' else 'REJECTED' end);
end;
$$;

create or replace function public.enqueue_schedule_change_acceptance(p_request_id uuid,p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.schedule_change_requests%rowtype; c public.student_quality_contacts%rowtype;
 v_link jsonb; v_notification uuid; v_message text; v_student text; v_teacher text; v_brand text;
begin
 select * into r from public.schedule_change_requests where id=p_request_id for update;
 if not found or not private.quality_school_manager(r.tenant_id) then raise exception using errcode='42501',message='school_review_required'; end if;
 if r.status<>'PENDING_FAMILY' then raise exception 'request_not_pending'; end if;
 select * into c from public.student_quality_contacts where id=p_contact_id and tenant_id=r.tenant_id and student_id=r.student_id and active and verified_at is not null;
 if not found then raise exception 'verified_family_contact_required'; end if;
 select id into v_notification from public.notification_queue where tenant_id=r.tenant_id
   and idempotency_key='schedule-change-family:'||r.id::text;
 if found then return jsonb_build_object('ok',true,'already',true,'notification_id',v_notification); end if;
 if exists(select 1 from public.profiles where id in(r.student_id,r.teacher_id) and (is_test_account is true or lower(coalesce(lifecycle_status,''))<>'active')) then
   return jsonb_build_object('ok',true,'suppressed',true,'reason','test_or_inactive_participant'); end if;
 if exists(select 1 from public.tenant_admin_settings where tenant_id=r.tenant_id and student_notifications_enabled is false) then
   raise exception 'student_notifications_disabled'; end if;
 v_link:=public.issue_schedule_change_link(r.id,c.id);
 select private.safe_notification_text(full_name,120) into v_student from public.profiles where id=r.student_id;
 select private.safe_notification_text(full_name,120) into v_teacher from public.profiles where id=r.teacher_id;
 select private.safe_notification_text(name,120) into v_brand from public.tenants where id=r.tenant_id;
 v_message:=format(E'Olá, %s! A %s recebeu uma proposta de mudança para a aula de %s com %s.\n\nAtual: %s às %s.\nProposta: %s às %s, %s.\n\nVocê pode aceitar ou manter o horário atual. A escola revisará sua resposta antes de aplicar.\n\nhttps://system.wisewolflanguage.com.br/confirmar-alteracao?token=%s',
   private.safe_notification_text(c.name,120),v_brand,v_student,v_teacher,r.old_day,r.old_time,r.new_day,r.new_time,
   case when r.scope='ONE_OFF' then 'somente em '||to_char(r.proposed_date,'DD/MM/YYYY') else 'a partir de '||to_char(r.effective_from,'DD/MM/YYYY') end,v_link->>'token');
 update private.schedule_change_tokens set delivery_body_hash=encode(extensions.digest(v_message,'sha256'),'hex') where request_id=r.id;
 insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,status,
   source_id,source_type,notification_kind,idempotency_key,class_date)
 values(r.tenant_id,null,r.student_id,v_student,c.phone,v_message,now(),'pending',r.id,'SCHEDULE_CHANGE_REQUEST',
   'SCHEDULE_CHANGE_FAMILY_ACCEPTANCE','schedule-change-family:'||r.id::text,r.effective_from) returning id into v_notification;
 update public.schedule_change_requests set history=history||jsonb_build_array(jsonb_build_object('action','FAMILY_ACCEPTANCE_QUEUED','actor_id',auth.uid(),'contact_id',c.id,'notification_id',v_notification,'at',now())) where id=r.id;
 return jsonb_build_object('ok',true,'notification_id',v_notification,'queued',true);
end;
$$;

create or replace function public.get_schedule_change_delivery_snapshot(p_notification_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare q public.notification_queue%rowtype; r public.schedule_change_requests%rowtype; c public.student_quality_contacts%rowtype; t private.schedule_change_tokens%rowtype; v_token text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='service_role_required'; end if;
 select * into q from public.notification_queue where id=p_notification_id and notification_kind='SCHEDULE_CHANGE_FAMILY_ACCEPTANCE'
   and source_type='SCHEDULE_CHANGE_REQUEST' and teacher_id is null;
 if not found then return jsonb_build_object('ok',false,'reason','invalid_schedule_notification'); end if;
 select * into r from public.schedule_change_requests where id=q.source_id and tenant_id=q.tenant_id and student_id=q.student_id and status='PENDING_FAMILY';
 if not found then return jsonb_build_object('ok',false,'reason','schedule_request_no_longer_pending'); end if;
 select * into c from public.student_quality_contacts where id=r.contact_id and tenant_id=r.tenant_id and student_id=r.student_id and active and verified_at is not null;
 if not found or c.phone<>q.student_phone then return jsonb_build_object('ok',false,'reason','verified_contact_changed'); end if;
 if exists(select 1 from public.profiles where id in(r.student_id,r.teacher_id) and (is_test_account is true or lower(coalesce(lifecycle_status,''))<>'active')) then
   return jsonb_build_object('ok',false,'reason','test_or_inactive_participant'); end if;
 if exists(select 1 from public.tenant_admin_settings where tenant_id=r.tenant_id and student_notifications_enabled is false) then
   return jsonb_build_object('ok',false,'reason','student_notifications_disabled'); end if;
 select * into t from private.schedule_change_tokens where request_id=r.id and contact_id=c.id and expires_at>now();
 v_token:=substring(q.message_body from 'token=([a-f0-9]{64})');
 if not found or v_token is null or t.token_hash<>encode(extensions.digest(v_token,'sha256'),'hex')
   or t.delivery_body_hash is distinct from encode(extensions.digest(q.message_body,'sha256'),'hex') then
   return jsonb_build_object('ok',false,'reason','schedule_acceptance_link_replaced_or_expired'); end if;
 return jsonb_build_object('ok',true,'destination',c.phone,'message',q.message_body);
end;
$$;

create or replace function public.review_booking_schedule_change(p_request_id uuid,p_apply boolean,p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.schedule_change_requests%rowtype; b public.bookings%rowtype; s jsonb; d integer;
begin
 -- Same lock order as request creation: booking then request.
 select b1.* into b from public.bookings b1 join public.schedule_change_requests r1 on r1.booking_id=b1.id where r1.id=p_request_id for update of b1;
 select * into r from public.schedule_change_requests where id=p_request_id for update;
 if not found or not private.quality_school_manager(r.tenant_id) then raise exception using errcode='42501',message='school_review_required'; end if;
 if p_apply is null or coalesce(length(btrim(p_note)),0) not between 8 and 1000 then raise exception 'review_note_required'; end if;
 if r.status in ('APPLIED','REJECTED','CANCELLED') then return jsonb_build_object('ok',true,'already',true,'status',r.status); end if;
 if not p_apply then
  update public.schedule_change_requests set status='CANCELLED',reviewed_by=auth.uid(),reviewed_at=now(),review_note=btrim(p_note),
   history=history||jsonb_build_array(jsonb_build_object('action','SCHOOL_CANCELLED','actor_id',auth.uid(),'at',now(),'note',btrim(p_note))) where id=r.id;
  return jsonb_build_object('ok',true,'status','CANCELLED');
 end if;
 if r.status<>'ACCEPTED' or r.family_responded_at is null then raise exception 'family_acceptance_required'; end if;
 if r.effective_from<=(now() at time zone 'America/Sao_Paulo')::date or
   (r.scope='ONE_OFF' and r.proposed_date<=(now() at time zone 'America/Sao_Paulo')::date) then raise exception 'effective_date_expired'; end if;
 if b.student_id<>r.student_id or b.teacher_id<>r.teacher_id or b.tenant_id<>r.tenant_id or upper(b.status)<>'SCHEDULED' then raise exception 'booking_changed_since_request'; end if;
 if (select count(*) from public.profiles p where p.id in(b.student_id,b.teacher_id) and p.tenant_id=b.tenant_id
   and lower(coalesce(p.lifecycle_status,''))='active' and exists(select 1 from public.tenant_memberships m
    where m.user_id=p.id and m.tenant_id=b.tenant_id and m.status='ACTIVE' and m.role=p.role))<>2 then raise exception 'inactive_schedule_participant'; end if;
 if not exists(select 1 from public.student_quality_contacts where id=r.contact_id and active and verified_at is not null) then raise exception 'family_contact_no_longer_verified'; end if;
 s:=public.booking_schedule_on_date(b.id,r.effective_from);
 if s->>'day_of_week' is distinct from r.old_day or s->>'time_slot' is distinct from r.old_time then raise exception 'schedule_changed_since_request'; end if;
 if r.scope='ONE_OFF' and r.original_date<>r.proposed_date and
   coalesce((public.booking_schedule_on_date(b.id,r.proposed_date)->>'valid')::boolean,false) then raise exception 'target_date_already_has_this_lesson'; end if;
 d:=case public.fold_accents(r.new_day) when 'segunda' then 1 when 'terca' then 2 when 'quarta' then 3 when 'quinta' then 4 when 'sexta' then 5 when 'sabado' then 6 end;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:teacher:'||b.teacher_id::text||':'||public.fold_accents(r.new_day)||':'||r.new_time,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:student:'||b.student_id::text||':'||public.fold_accents(r.new_day)||':'||r.new_time,0));
 if not exists(select 1 from public.teacher_availability a where a.teacher_id=b.teacher_id and a.tenant_id=b.tenant_id and a.day_of_week=d
   and a.start_time<=r.new_time::time and (a.start_time=r.new_time::time or a.end_time>r.new_time::time)) then raise exception 'teacher_not_available'; end if;
 if private.schedule_change_has_conflict(r.id) then raise exception 'schedule_conflict'; end if;
 if r.scope='PERMANENT' then
  if exists(select 1 from public.booking_schedule_versions where booking_id=b.id and valid_from>=r.effective_from) then raise exception 'future_schedule_already_planned'; end if;
  if not exists(select 1 from public.booking_schedule_versions where booking_id=b.id) then
   insert into public.booking_schedule_versions(tenant_id,booking_id,valid_from,valid_until,day_of_week,time_slot)
   values(b.tenant_id,b.id,least(coalesce(b.start_date,'1970-01-01'::date),r.effective_from-1),r.effective_from-1,b.day_of_week,left(b.time_slot,5));
  else
   update public.booking_schedule_versions set valid_until=r.effective_from-1 where booking_id=b.id and valid_from<r.effective_from and (valid_until is null or valid_until>=r.effective_from);
  end if;
  insert into public.booking_schedule_versions(tenant_id,booking_id,valid_from,day_of_week,time_slot,request_id)
   values(b.tenant_id,b.id,r.effective_from,r.new_day,r.new_time,r.id);
  update public.bookings set day_of_week=r.new_day,time_slot=r.new_time where id=b.id;
 end if;
 update public.schedule_change_requests set status='APPLIED',reviewed_by=auth.uid(),reviewed_at=now(),review_note=btrim(p_note),
  history=history||jsonb_build_array(jsonb_build_object('action','SCHOOL_APPLIED','actor_id',auth.uid(),'at',now(),'note',btrim(p_note))) where id=r.id;
 return jsonb_build_object('ok',true,'status','APPLIED','effective_from',r.effective_from);
end;
$$;

-- Backend fence also covers direct PostgREST writes and legacy definer RPCs.
create or replace function private.protect_teacher_booking_schedule()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if tg_op='UPDATE' and (new.day_of_week is distinct from old.day_of_week or new.time_slot is distinct from old.time_slot)
  and exists(select 1 from public.booking_schedule_versions where booking_id=old.id)
  and not exists(select 1 from public.booking_schedule_versions v join public.schedule_change_requests r on r.id=v.request_id
    where v.booking_id=old.id and r.status='ACCEPTED' and v.day_of_week=new.day_of_week and v.time_slot=left(new.time_slot,5)
      and r.reviewed_at is null and private.quality_school_manager(old.tenant_id)) then
  raise exception using errcode='42501',message='A agenda possui vigência e histórico. Registre uma nova proposta para preservar as aulas anteriores.';
 end if;
 if public._my_role()='TEACHER' then
   if tg_op<>'UPDATE' or new.day_of_week is distinct from old.day_of_week or new.time_slot is distinct from old.time_slot
     or new.date is distinct from old.date or new.start_date is distinct from old.start_date
     or new.teacher_id is distinct from old.teacher_id or new.student_id is distinct from old.student_id
     or new.status is distinct from old.status then
    raise exception using errcode='42501',message='A alteração exige aceite da família e aprovação da escola. Solicite pela agenda.';
   end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
drop trigger if exists protect_teacher_booking_schedule on public.bookings;
create trigger protect_teacher_booking_schedule before insert or update or delete on public.bookings
 for each row execute function private.protect_teacher_booking_schedule();
revoke all on function private.protect_teacher_booking_schedule() from public,anon,authenticated,service_role;

-- Preserve the school RPC contract but close the service-role management-agent
-- exception that could previously impersonate a teacher's approved action.
do $copy_legacy$
declare v_def text;
begin
 if to_regprocedure('private.gestao_change_booking_schedule_before_quality(text,uuid,uuid,uuid,text,text,text,text)') is null then
  v_def:=pg_get_functiondef('public.gestao_change_booking_schedule(text,uuid,uuid,uuid,text,text,text,text)'::regprocedure);
  v_def:=replace(v_def,'FUNCTION public.gestao_change_booking_schedule(','FUNCTION private.gestao_change_booking_schedule_before_quality(');
  execute v_def;
 end if;
end;
$copy_legacy$;
revoke all on function private.gestao_change_booking_schedule_before_quality(text,uuid,uuid,uuid,text,text,text,text) from public,anon,authenticated,service_role;
create or replace function public.gestao_change_booking_schedule(p_tenant text,p_actor_id uuid,p_booking_id uuid,p_expected_student_id uuid,p_day_of_week text,p_time_slot text,p_group_jid text,p_request_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
 if coalesce(auth.role(),'')<>'service_role' or not exists(select 1 from public.tenant_memberships m join public.profiles p on p.id=m.user_id
  where m.user_id=p_actor_id and m.tenant_id=p_tenant and m.status='ACTIVE' and m.role in ('SCHOOL_ADMIN','COORDINATOR')
  and lower(coalesce(p.lifecycle_status,'active'))='active') then
  raise exception using errcode='42501',message='school_schedule_review_required'; end if;
 return private.gestao_change_booking_schedule_before_quality(p_tenant,p_actor_id,p_booking_id,p_expected_student_id,p_day_of_week,p_time_slot,p_group_jid,p_request_id);
end;
$$;
revoke all on function public.gestao_change_booking_schedule(text,uuid,uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.gestao_change_booking_schedule(text,uuid,uuid,uuid,text,text,text,text) to service_role;

revoke all on function public.request_student_contact_change(uuid,text,text,text,text),public.review_student_contact_change(uuid,boolean,text),
 public.deactivate_student_quality_contact(uuid,text),public.booking_schedule_on_date(uuid,date),
 public.request_booking_schedule_change(uuid,text,text,date,text,text,date,date,text),public.issue_schedule_change_link(uuid,uuid),
 public.review_booking_schedule_change(uuid,boolean,text),public.get_schedule_change_public(text),public.respond_schedule_change_public(text,boolean)
 from public,anon,authenticated;
grant execute on function public.request_student_contact_change(uuid,text,text,text,text),public.review_student_contact_change(uuid,boolean,text),
 public.deactivate_student_quality_contact(uuid,text),public.booking_schedule_on_date(uuid,date),
 public.request_booking_schedule_change(uuid,text,text,date,text,text,date,date,text),public.issue_schedule_change_link(uuid,uuid),
 public.review_booking_schedule_change(uuid,boolean,text) to authenticated,service_role;
grant execute on function public.get_schedule_change_public(text),public.respond_schedule_change_public(text,boolean) to anon,authenticated,service_role;
revoke all on function public.enqueue_schedule_change_acceptance(uuid,uuid),public.get_schedule_change_delivery_snapshot(uuid) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_schedule_change_acceptance(uuid,uuid) to authenticated;
grant execute on function public.get_schedule_change_delivery_snapshot(uuid) to service_role;
notify pgrst,'reload schema';
