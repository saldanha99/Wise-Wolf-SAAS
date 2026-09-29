-- School-confirmed historical advances: retain unknown time as NULL, not a
-- fabricated appointment. Their logs pay by actual date; origins remain blocked.
create table if not exists public.booking_occurrence_exclusions (
 tenant_id text not null references public.tenants(id),
 booking_id uuid not null references public.bookings(id),
 class_date date not null,
 reason text not null check(length(btrim(reason)) between 10 and 500),
 created_by uuid not null references public.profiles(id),
 created_at timestamptz not null default now(),
 primary key(tenant_id,booking_id,class_date)
);
alter table public.booking_occurrence_exclusions enable row level security;
revoke all on public.booking_occurrence_exclusions from public,anon,authenticated,service_role;
grant select on public.booking_occurrence_exclusions to authenticated,service_role;
drop policy if exists occurrence_exclusions_read on public.booking_occurrence_exclusions;
create policy occurrence_exclusions_read on public.booking_occurrence_exclusions for select to authenticated
 using(tenant_id=(select public._my_tenant_id()) and ((select public._my_role()) in ('SCHOOL_ADMIN','COORDINATOR','SUPER_ADMIN')
 or exists(select 1 from public.bookings b where b.id=booking_id and (b.teacher_id=(select auth.uid()) or b.student_id=(select auth.uid())))));
create or replace function public.exclude_booking_occurrence(p_booking_id uuid,p_date date,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare b public.bookings%rowtype; begin
 if auth.uid() is null or coalesce(public._my_role(),'') not in('SCHOOL_ADMIN','SUPER_ADMIN')
 or not coalesce(public._my_tenant_is_operational(),false) then raise exception 'occurrence_exclusion_not_authorized'; end if;
 select * into strict b from public.bookings where id=p_booking_id and tenant_id=public._my_tenant_id() for update;
 if p_date is null or p_date<=(now() at time zone 'America/Sao_Paulo')::date or length(btrim(coalesce(p_reason,''))) not between 10 and 500
 then raise exception 'invalid_occurrence_exclusion'; end if;
 if exists(select 1 from public.class_logs where booking_id=b.id::text and class_date=p_date)
 or exists(select 1 from public.lesson_advances where booking_id=b.id and original_date=p_date and status<>'CANCELLED')
 then raise exception 'occurrence_already_consumed'; end if;
 if exists(select 1 from public.booking_occurrence_exclusions where tenant_id=b.tenant_id and booking_id=b.id and class_date=p_date) then return; end if;
 if not coalesce((public.booking_schedule_on_date(b.id,p_date)->>'valid')::boolean,false) then raise exception 'invalid_booking_occurrence'; end if;
 insert into public.booking_occurrence_exclusions values(b.tenant_id,b.id,p_date,btrim(p_reason),auth.uid(),now());
end $$;
alter function public.exclude_booking_occurrence(uuid,date,text) owner to postgres;
revoke all on function public.exclude_booking_occurrence(uuid,date,text) from public,anon,service_role;
grant execute on function public.exclude_booking_occurrence(uuid,date,text) to authenticated;
do $$ declare d text; begin
 select pg_get_functiondef('public.booking_schedule_on_date(uuid,date)'::regprocedure) into d;
 if strpos(d,'booking_occurrence_exclusions')=0 then
  if strpos(d,' if exists(select 1 from public.lesson_advances')=0 then raise exception 'unexpected_booking_schedule_definition'; end if;
  execute replace(d,' if exists(select 1 from public.lesson_advances',
   E' if exists(select 1 from public.booking_occurrence_exclusions x where x.tenant_id=b.tenant_id and x.booking_id=b.id and x.class_date=p_date) then\n return jsonb_build_object(''valid'',false,''excluded'',true,''day_of_week'',d,''time_slot'',t);\n end if;\n if exists(select 1 from public.lesson_advances');
 end if;
end $$;

alter table public.lesson_advances add column if not exists historical_settlement boolean not null default false;
alter table public.lesson_advances alter column advance_time drop not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.lesson_advances'::regclass and conname='lesson_advance_known_time_or_historical') then
  alter table public.lesson_advances add constraint lesson_advance_known_time_or_historical check(advance_time is not null or historical_settlement);
 end if;
end $$;

-- No historical advance may escape the transaction as an open launchable row.
create or replace function private.check_historical_advance_settled()
returns trigger language plpgsql security definer set search_path='' as $$
declare a public.lesson_advances%rowtype;
begin
 if tg_table_name='class_logs' then
  if tg_op='UPDATE' and new.lesson_advance_id is distinct from old.lesson_advance_id
   and exists(select 1 from public.lesson_advances where id=old.lesson_advance_id and historical_settlement) then
   raise exception 'historical_advance_log_link_immutable';
  end if;
  if tg_op='DELETE' then
   select * into a from public.lesson_advances where id=old.lesson_advance_id;
  else
   select * into a from public.lesson_advances where id=coalesce(new.lesson_advance_id,old.lesson_advance_id);
  end if;
 else
  select * into a from public.lesson_advances where id=new.id;
 end if;
 if a.historical_settlement and (a.status<>'COMPLETED' or not exists(
  select 1 from public.class_logs l where l.id=a.class_log_id
   and l.lesson_advance_id=a.id and l.tenant_id=a.tenant_id
   and l.teacher_id=a.teacher_id and l.student_id=a.student_id
   and l.class_date=a.advance_date and l.presence='COMPLETED'
   and l.start_time is not distinct from a.advance_time)) then
  raise exception 'historical_advance_must_be_settled';
 end if;
 return null;
end $$;
alter function private.check_historical_advance_settled() owner to postgres;
revoke all on function private.check_historical_advance_settled() from public,anon,authenticated,service_role;
drop trigger if exists historical_advance_must_be_settled on public.lesson_advances;
create constraint trigger historical_advance_must_be_settled after insert or update on public.lesson_advances
 deferrable initially deferred for each row when (new.historical_settlement) execute function private.check_historical_advance_settled();
drop trigger if exists historical_advance_log_must_be_settled on public.class_logs;
create trigger historical_advance_log_must_be_settled after update or delete on public.class_logs
 for each row execute function private.check_historical_advance_settled();

-- Keep unknown-time historical records out of time-based rooms, reminders,
-- attendance requests and quality sessions. The payroll still reads class_logs.
do $patch$
declare d text;
begin
 select pg_get_viewdef('public.upcoming_classes'::regclass,true) into d;
 if strpos(d,'a.advance_time IS NOT NULL')=0 then
  if strpos(d,'a.status <> ''CANCELLED''::text')=0 then raise exception 'unexpected_upcoming_advances_definition'; end if;
  d:=replace(d,'a.status <> ''CANCELLED''::text','a.status <> ''CANCELLED''::text AND a.advance_time IS NOT NULL');
  execute 'create or replace view public.upcoming_classes as '||d;
 end if;
 select pg_get_functiondef('private.lesson_quality_sources(text,date,date,uuid)'::regprocedure) into d;
 if strpos(d,'a.advance_time is not null')=0 then
  if strpos(d,'and a.status<>''CANCELLED''')=0 then raise exception 'unexpected_quality_advances_definition'; end if;
  execute replace(d,'and a.status<>''CANCELLED''','and a.status<>''CANCELLED'' and a.advance_time is not null');
 end if;
end $patch$;

create or replace function public.settle_historical_lesson_advances(p_student_id uuid,p_entries jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=auth.uid(); tenant text:=public._my_tenant_id();
 e jsonb; b public.bookings%rowtype; a public.lesson_advances%rowtype;
 actual date; original date; aid uuid; lid uuid; ids uuid[]:=array[]::uuid[];
 created integer:=0; skipped integer:=0;
begin
 if actor is null or tenant is null or coalesce(public._my_role(),'') not in ('SCHOOL_ADMIN','SUPER_ADMIN')
  or not coalesce(public._my_tenant_is_operational(),false) then raise exception using errcode='42501',message='historical_advance_not_authorized'; end if;
 if p_entries is null or jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries) not between 1 and 31
  or length(btrim(coalesce(p_reason,'')))<10 or length(p_reason)>500 then raise exception 'invalid_historical_advance_entries'; end if;
 perform pg_advisory_xact_lock(hashtextextended('historical-advance:'||tenant||':'||p_student_id,0));
 for e in select value from jsonb_array_elements(p_entries) order by value->>'booking_id',value->>'original_date' loop
  select * into strict b from public.bookings where id=(e->>'booking_id')::uuid
   and tenant_id=tenant and student_id=p_student_id and status='SCHEDULED' for update;
  actual:=(e->>'advance_date')::date; original:=(e->>'original_date')::date;
  if actual is null or original is null or actual>=(now() at time zone 'America/Sao_Paulo')::date
   or actual<(now() at time zone 'America/Sao_Paulo')::date-120
   or original<=(now() at time zone 'America/Sao_Paulo')::date
   or date_trunc('month',actual::timestamp)>=date_trunc('month',original::timestamp) then raise exception 'invalid_historical_advance_dates'; end if;
  select * into a from public.lesson_advances where tenant_id=tenant and booking_id=b.id and original_date=original and status<>'CANCELLED' for update;
  if found then
   if a.historical_settlement and a.status='COMPLETED' and a.advance_date=actual and a.student_id=p_student_id
    and a.teacher_id=b.teacher_id and exists(select 1 from public.class_logs where id=a.class_log_id and lesson_advance_id=a.id and presence='COMPLETED') then
    skipped:=skipped+1; ids:=array_append(ids,a.class_log_id); continue;
   end if;
   raise exception 'lesson_advance_origin_already_used';
  end if;
  if not coalesce((public.booking_schedule_on_date(b.id,original)->>'valid')::boolean,false) then raise exception 'lesson_advance_origin_not_a_booking_occurrence'; end if;
  if exists(select 1 from public.teacher_closings c where c.tenant_id=tenant and c.teacher_id=b.teacher_id
   and c.month_year=to_char(actual,'YYYY-MM') and coalesce(c.status,'') not in ('PENDENTE')) then raise exception 'historical_advance_month_locked'; end if;
  -- Date-only import cannot distinguish two real slots for the same student.
  if exists(select 1 from public.class_logs l where l.tenant_id=tenant and l.student_id=p_student_id and l.class_date=actual)
   or exists(select 1 from public.lesson_advances x where x.tenant_id=tenant and x.student_id=p_student_id and x.advance_date=actual and x.status<>'CANCELLED') then raise exception 'historical_advance_actual_date_already_used'; end if;
  insert into public.lesson_advances(tenant_id,booking_id,teacher_id,student_id,original_date,advance_date,advance_time,reason,created_by,historical_settlement)
   values(tenant,b.id,b.teacher_id,p_student_id,original,actual,null,btrim(p_reason),actor,true) returning id into aid;
  insert into public.class_logs(tenant_id,teacher_id,student_id,booking_id,lesson_advance_id,class_date,date,presence,subtype,start_time,observations,late_logging_reason)
   values(tenant,b.teacher_id,p_student_id,b.id::text,aid,actual,actual,'COMPLETED','ANTECIPAÇÃO',null,
    'Realização confirmada pela direção. Horário não informado. '||btrim(p_reason),'Registro administrativo de antecipação já realizada') returning id into lid;
  ids:=array_append(ids,lid); created:=created+1;
 end loop;
 return jsonb_build_object('created',created,'skipped',skipped,'class_log_ids',to_jsonb(ids));
end $$;
alter function public.settle_historical_lesson_advances(uuid,jsonb,text) owner to postgres;
revoke all on function public.settle_historical_lesson_advances(uuid,jsonb,text) from public,anon,service_role;
grant execute on function public.settle_historical_lesson_advances(uuid,jsonb,text) to authenticated;
