-- Explicit lesson commands, audited advances and preserved financial engines.
-- Replayed after the original migrations by release.sh; copies are refreshed
-- from those authoritative engines, never recursively from our wrappers.
alter table public.class_logs
  add column if not exists lesson_objective text,
  add column if not exists student_difficulties text,
  add column if not exists homework_assigned text,
  add column if not exists recommended_next_step text,
  add column if not exists late_logging_reason text;

create index if not exists lesson_advances_real_occurrence_idx
  on public.lesson_advances(tenant_id, booking_id, advance_date)
  where status <> 'CANCELLED';

-- One financial booking represents one 30-minute occurrence per actual date.
-- Preserve this pre-existing class_logs invariant when creating an advance.
create or replace function private.validate_lesson_advance_integrity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype;
begin
  if new.status = 'CANCELLED' then return new; end if;
  select * into b from public.bookings where id = new.booking_id for update;
  if not found or b.tenant_id is distinct from new.tenant_id
     or b.student_id is distinct from new.student_id
     or b.teacher_id is distinct from new.teacher_id then
    raise exception using errcode='23514', message='lesson_advance_identity_mismatch';
  end if;
  if tg_op = 'UPDATE' and old.status = 'COMPLETED' and
     (new.booking_id, new.teacher_id, new.student_id, new.original_date, new.advance_date, new.advance_time)
       is distinct from (old.booking_id, old.teacher_id, old.student_id, old.original_date, old.advance_date, old.advance_time) then
    raise exception using errcode='23514', message='completed_lesson_advance_immutable';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'lesson-advance:' || new.tenant_id || ':' || new.teacher_id || ':' || new.advance_date, 0));
  if tg_op='INSERT' and coalesce((public.booking_schedule_on_date(new.booking_id,new.advance_date)->>'valid')::boolean,false) then
    raise exception using errcode='23514',message='lesson_advance_actual_date_has_regular_occurrence';
  end if;
  if exists (select 1 from public.lesson_advances a where a.id <> new.id
      and a.tenant_id=new.tenant_id and a.status <> 'CANCELLED'
      and a.advance_date=new.advance_date
      and ((a.booking_id=new.booking_id) or
           ((a.teacher_id=new.teacher_id or a.student_id=new.student_id)
             and (a.advance_date+a.advance_time) < (new.advance_date+new.advance_time) + interval '30 minutes'
             and (a.advance_date+a.advance_time) + interval '30 minutes' > (new.advance_date+new.advance_time)))) then
    raise exception using errcode='23505', message='lesson_advance_actual_slot_conflict';
  end if;
  if tg_op='INSERT' and exists(select 1 from public.bookings other_booking
      cross join lateral(select public.booking_schedule_on_date(other_booking.id,new.advance_date) as slot) s
      where other_booking.tenant_id=new.tenant_id and other_booking.id<>new.booking_id
        and (other_booking.teacher_id=new.teacher_id or other_booking.student_id=new.student_id)
        and coalesce((s.slot->>'valid')::boolean,false)
        and (new.advance_date+(s.slot->>'time_slot')::time) < (new.advance_date+new.advance_time)+interval '30 minutes'
        and (new.advance_date+(s.slot->>'time_slot')::time)+interval '30 minutes' > (new.advance_date+new.advance_time)) then
    raise exception using errcode='23514',message='lesson_advance_actual_slot_conflict';
  end if;
  if tg_op='INSERT' and exists(select 1 from public.class_logs cl
      where cl.tenant_id=new.tenant_id and cl.booking_id=new.booking_id::text
        and cl.class_date in(new.original_date,new.advance_date)) then
    raise exception using errcode='23505', message='lesson_advance_occurrence_already_logged';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_lesson_advance_integrity() from public, anon, authenticated, service_role;
drop trigger if exists validate_lesson_advance_integrity on public.lesson_advances;
create trigger validate_lesson_advance_integrity before insert or update on public.lesson_advances
for each row execute function private.validate_lesson_advance_integrity();

-- Keep all pre-existing origin validation; add the distinct authorized source.
do $patch_origin$
declare d text; addition text := $body$
  -- Advance identity is independent of the recurring booking's weekday/time.
  if new.lesson_advance_id is not null then
    if new.reschedule_id is not null or new.appointment_id is not null then
      raise exception using errcode='23514', message='class_log_must_have_exactly_one_source';
    end if;
    select a.advance_time into v_authoritative_time
      from public.lesson_advances a
     where a.id=new.lesson_advance_id and a.tenant_id=new.tenant_id
       and a.teacher_id=new.teacher_id and a.student_id=new.student_id
       and a.booking_id::text=new.booking_id and a.advance_date=new.class_date
       and a.status <> 'CANCELLED'
       and (a.class_log_id is null or a.class_log_id=new.id)
     for update;
    if not found then
      raise exception using errcode='23514', message='class_log_advance_origin_invalid';
    end if;
    if new.start_time is not null and new.start_time is distinct from v_authoritative_time then
      raise exception using errcode='23514', message='class_log_occurrence_time_mismatch';
    end if;
    new.start_time := v_authoritative_time;
    new.date := new.class_date;
    return new;
  end if;
  if exists(select 1 from public.lesson_advances a
      where a.tenant_id=new.tenant_id and a.booking_id::text=new.booking_id
        and a.original_date=new.class_date and a.status <> 'CANCELLED') then
    raise exception using errcode='23514', message='ocorrencia_antecipada';
  end if;
$body$;
begin
  select pg_get_functiondef('public.fill_class_log_occurrence_time()'::regprocedure) into d;
  if strpos(d,'Advance identity is independent')=0 then
    if strpos(d,'  v_source_count :=')=0 then raise exception 'unexpected occurrence trigger'; end if;
    d:=replace(d,'  v_source_count :=',addition || E'\n  v_source_count :=');
    -- The schedule helper owns historical versions and approved one-off moves.
    d:=replace(d,'b.time_slot', '(public.booking_schedule_on_date(b.id, new.class_date)->>''time_slot'')');
    d:=replace(d,'b.day_of_week', '(public.booking_schedule_on_date(b.id, new.class_date)->>''day_of_week'')');
    d:=replace(d,$find$and b.status = 'SCHEDULED'$find$, $replace$and b.status = 'SCHEDULED' and coalesce((public.booking_schedule_on_date(b.id, new.class_date)->>'valid')::boolean,false)$replace$);
    execute d;
  end if;
end;
$patch_origin$;

-- Administrative settlement of independently confirmed attendance follows the
-- same exact authorization, even when its legacy payload only has booking/date.
do $infer_advance$
declare d text; addition text:=$body$
  -- Resolve only an exact authorized advance, never merely student/date.
  if new.lesson_advance_id is null and new.booking_id is not null then
    select a.id into new.lesson_advance_id from public.lesson_advances a
     where a.tenant_id=new.tenant_id and a.booking_id::text=new.booking_id
       and a.teacher_id=new.teacher_id and a.student_id=new.student_id
       and a.advance_date=new.class_date and a.status <> 'CANCELLED'
       and (new.start_time is null or a.advance_time=new.start_time)
       and (a.class_log_id is null or a.class_log_id=new.id);
  end if;
$body$;
begin
  select pg_get_functiondef('public.fill_class_log_occurrence_time()'::regprocedure) into d;
  if strpos(d,'Resolve only an exact authorized advance')=0 then
    execute replace(d,'  -- Advance identity is independent',addition || E'\n  -- Advance identity is independent');
  end if;
end;
$infer_advance$;
drop trigger if exists trg_fill_class_log_occurrence_time on public.class_logs;
create trigger trg_fill_class_log_occurrence_time before insert or update of
 booking_id,reschedule_id,appointment_id,lesson_advance_id,start_time,class_date,teacher_id,student_id
 on public.class_logs for each row execute function public.fill_class_log_occurrence_time();

create or replace function private.complete_logged_lesson_advance()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.lesson_advance_id is not null then
    update public.lesson_advances set status='COMPLETED',class_log_id=new.id,completed_at=now()
     where id=new.lesson_advance_id and tenant_id=new.tenant_id and status='SCHEDULED';
  end if;
  return new;
end;
$$;
revoke all on function private.complete_logged_lesson_advance() from public,anon,authenticated,service_role;
drop trigger if exists complete_logged_lesson_advance on public.class_logs;
create trigger complete_logged_lesson_advance after insert on public.class_logs
for each row execute function private.complete_logged_lesson_advance();

-- A new command cannot finish a future slot, including a same-day slot. This
-- protects other privileged command paths too, not just the React screen.
create or replace function private.require_finished_lesson_slot()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Directed training has its own stricter attendance/end-time guard.
  if new.subtype='TREINAMENTO' then return new; end if;
  if new.class_date is not null and new.start_time is not null
     and ((new.class_date + new.start_time) at time zone 'America/Sao_Paulo')
           + interval '30 minutes' > now() then
    raise exception using errcode='23514', message='aula_ainda_nao_terminou';
  end if;
  return new;
end;
$$;
revoke all on function private.require_finished_lesson_slot() from public, anon, authenticated, service_role;
drop trigger if exists trg_zy_require_finished_lesson_slot on public.class_logs;
create trigger trg_zy_require_finished_lesson_slot before insert on public.class_logs
for each row execute function private.require_finished_lesson_slot();

do $preserve_engines$
declare d text;
begin
  select pg_get_functiondef('public.log_teacher_classes(jsonb)'::regprocedure) into d;
  if strpos(d,'private.log_explicit_teacher_classes')=0 then
    d:=replace(d,'public.log_teacher_classes(', 'private.log_teacher_classes_engine(');
    d:=replace(d,'b.time_slot', '(public.booking_schedule_on_date(b.id, v_class_date)->>''time_slot'')');
    d:=replace(d,'b.day_of_week', '(public.booking_schedule_on_date(b.id, v_class_date)->>''day_of_week'')');
    d:=replace(d,$find$and b.status = 'SCHEDULED'$find$, $replace$and b.status = 'SCHEDULED' and coalesce((public.booking_schedule_on_date(b.id, v_class_date)->>'valid')::boolean,false)$replace$);
    execute d;
  end if;
  select pg_get_functiondef('public.log_advanced_teacher_classes(jsonb)'::regprocedure) into d;
  if strpos(d,'private.log_explicit_teacher_classes')=0 then
    d:=replace(d,'public.log_advanced_teacher_classes(', 'private.log_advanced_teacher_classes_engine(');
    execute d;
  end if;
end;
$preserve_engines$;
revoke all on function private.log_teacher_classes_engine(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.log_advanced_teacher_classes_engine(jsonb) from public, anon, authenticated, service_role;

create or replace function private.log_explicit_teacher_classes(p_entries jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  entry jsonb; result jsonb; item jsonb; results jsonb:='[]'; projection jsonb;
  inserted int:=0; skipped int:=0; rescheduled int:=0; delta numeric:=0; paid int:=0;
  field text; reason text; log_id uuid; day date;
begin
  if auth.uid() is null or public._my_tenant_id() is null
     or not coalesce(public._my_role() in('TEACHER','SCHOOL_ADMIN','SUPER_ADMIN'),false)
     or not coalesce(public._my_tenant_is_operational(),false) then
    raise exception using errcode='42501',message='teacher_profile_required';
  end if;
  if p_entries is null or jsonb_typeof(p_entries)<>'array'
     or jsonb_array_length(p_entries) not between 1 and 100 then
    raise exception using errcode='22023',message='invalid_entries';
  end if;
  for entry in select value from jsonb_array_elements(p_entries) loop
    -- Each row is a subtransaction: a failed enrichment cannot commit its
    -- financial log, and a failed row cannot erase an unrelated valid one.
    begin
      reason:=null;
      day:=nullif(entry->>'class_date','')::date;
      if nullif(btrim(entry->>'presence'),'') is null then
        reason:='presenca_invalida';
      elsif entry->>'presence'='COMPLETED' then
        foreach field in array array['lesson_objective','content_covered','student_difficulties','homework_assigned','recommended_next_step'] loop
          if nullif(btrim(entry->>field),'') is null then reason:='registro_pedagogico_incompleto'; end if;
        end loop;
      end if;
      if day < (now() at time zone 'America/Sao_Paulo')::date
         and nullif(btrim(entry->>'late_logging_reason'),'') is null then
        reason:='motivo_retroativo_obrigatorio';
      end if;
      if nullif(entry->>'lesson_advance_id','') is null and exists(select 1 from public.lesson_advances a
          where a.tenant_id=public._my_tenant_id() and a.teacher_id=auth.uid()
            and a.booking_id::text=entry->>'booking_id' and a.original_date=day and a.status <> 'CANCELLED') then
        reason:='ocorrencia_antecipada';
      end if;
      if reason is not null then raise exception using errcode='22023',message=reason; end if;
      if nullif(entry->>'lesson_advance_id','') is not null then
        result:=private.log_advanced_teacher_classes_engine(jsonb_build_array(entry));
      else
        result:=private.log_teacher_classes_engine(jsonb_build_array(entry));
      end if;
      item:=result->'entries'->0;
      if item->>'status'='lancada' then
        log_id:=(item->>'id')::uuid;
        update public.class_logs set
          lesson_objective=nullif(left(btrim(entry->>'lesson_objective'),4000),''),
          student_difficulties=nullif(left(btrim(entry->>'student_difficulties'),4000),''),
          homework_assigned=nullif(left(btrim(entry->>'homework_assigned'),4000),''),
          recommended_next_step=nullif(left(btrim(entry->>'recommended_next_step'),4000),''),
          late_logging_reason=nullif(left(btrim(entry->>'late_logging_reason'),2000),'')
        where id=log_id and teacher_id=auth.uid() and tenant_id=public._my_tenant_id();
      end if;
      inserted:=inserted+coalesce((result->>'inserted')::int,0);
      skipped:=skipped+coalesce((result->>'skipped')::int,0);
      rescheduled:=rescheduled+coalesce((result->>'reschedules_created')::int,0);
      delta:=delta+coalesce((result->>'delta_amount')::numeric,0);
      paid:=paid+coalesce((result->>'delta_lessons')::int,0);
      results:=results || coalesce(result->'entries','[]');
    exception when others then
      -- Expose only known product messages, never raw SQL/private data.
      reason:=case when sqlerrm in('registro_pedagogico_incompleto','motivo_retroativo_obrigatorio',
        'presenca_invalida','aula_ainda_nao_terminou','ocorrencia_antecipada','lesson_advance_date_mismatch',
        'class_log_advance_origin_invalid','class_log_occurrence_time_mismatch') then sqlerrm
        when sqlstate='23505' then 'ja_lancada' else 'falha_no_lancamento' end;
      skipped:=skipped+1;
      results:=results || jsonb_build_array(jsonb_build_object('ref',entry->>'ref','id',null,
        'status','ignorada','reason',reason,'amount',0,'paid',false));
    end;
  end loop;
  projection:=public.teacher_pay_projection(auth.uid());
  return jsonb_build_object('inserted',inserted,'skipped',skipped,'reschedules_created',rescheduled,
    'delta_amount',delta,'delta_lessons',paid,'month_amount',coalesce((projection->>'amount_logged')::numeric,0),
    'month_lessons',coalesce((projection->>'lessons_logged')::int,0),
    'turbo_active',coalesce((projection->'turbo'->>'active')::boolean,false),'entries',results);
end;
$$;
revoke all on function private.log_explicit_teacher_classes(jsonb) from public, anon, authenticated, service_role;
create or replace function public.log_teacher_classes(p_entries jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select private.log_explicit_teacher_classes(p_entries)
$$;
create or replace function public.log_advanced_teacher_classes(p_entries jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select private.log_explicit_teacher_classes(p_entries)
$$;
revoke all on function public.log_teacher_classes(jsonb), public.log_advanced_teacher_classes(jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.log_teacher_classes(jsonb), public.log_advanced_teacher_classes(jsonb) to authenticated;

-- The audit retains the existing booking/date contract. The actual advance
-- replaces that date's occurrence; the consumed future occurrence disappears.
create or replace view public.upcoming_classes as
with days as (
  select generate_series(((now() at time zone 'America/Sao_Paulo')::date-1)::timestamp,
    ((now() at time zone 'America/Sao_Paulo')::date+45)::timestamp,interval '1 day')::date as class_date
), regular as (
  select b.id as source_id,'booking'::text as source_type,b.tenant_id,b.teacher_id,b.student_id,
    null::text as student_name_override,null::text as student_phone_override,d.class_date,
    s.slot->>'time_slot' as time_text,
    (d.class_date+(s.slot->>'time_slot')::time) at time zone 'America/Sao_Paulo' as start_at
  from public.bookings b cross join days d
  cross join lateral(select public.booking_schedule_on_date(b.id,d.class_date) as slot) s
  where b.status='SCHEDULED' and b.student_id is not null
    and coalesce((s.slot->>'valid')::boolean,false)
    and not exists(select 1 from public.lesson_advances a where a.tenant_id=b.tenant_id
      and a.booking_id=b.id and a.status <> 'CANCELLED' and a.original_date=d.class_date)
    and not exists(select 1 from public.lesson_advances a where a.tenant_id=b.tenant_id
      and a.booking_id=b.id and a.status <> 'CANCELLED' and a.advance_date=d.class_date)
), advanced as (
  select a.booking_id,'booking'::text,a.tenant_id,a.teacher_id,a.student_id,null::text,null::text,
    a.advance_date,to_char(a.advance_time,'HH24:MI'),
    (a.advance_date+a.advance_time) at time zone 'America/Sao_Paulo'
  from public.lesson_advances a where a.status <> 'CANCELLED'
), rescheduled as (
  select r.id,'reschedule'::text,r.tenant_id,r.teacher_id,r.student_id,null::text,null::text,
    public.parse_lesson_date(r.date),r.time,
    (public.parse_lesson_date(r.date)+r.time::time) at time zone 'America/Sao_Paulo'
  from public.reschedules r where r.time ~ '^[0-9]{2}:[0-9]{2}$'
    and public.parse_lesson_date(r.date) is not null
), appointments as (
  select a.id,'appointment'::text,a.tenant_id,coalesce(a.teacher_id,a.professor_id),null::uuid,
    a.student_name,a.student_phone,(a.start_time at time zone 'America/Sao_Paulo')::date,
    to_char(a.start_time at time zone 'America/Sao_Paulo','HH24:MI'),a.start_time
  from public.appointments a where a.start_time is not null
    and lower(coalesce(a.status,'scheduled')) not in('cancelled','no_show')
)
select * from regular union all select * from advanced union all select * from rescheduled union all select * from appointments;
revoke all on public.upcoming_classes from public, anon, authenticated;
grant select on public.upcoming_classes to service_role;

-- Independent family feedback can arrive before the teacher logs. An advance
-- is authoritative proof of booking/date/time in that case too.
do $patch_audit$
declare d text; old_part text:= $old$
      elsif not coalesce(v_source_matches_snapshot, false)
            and not exists (
$old$; new_part text:=$new$
      elsif not coalesce(v_source_matches_snapshot, false)
            and not exists (select 1 from public.lesson_advances a
              where a.tenant_id=member.tenant_id and a.booking_id::text=member.source_id
                and a.teacher_id=member.teacher_id and a.student_id=member.student_id
                and a.advance_date=member.class_date and a.advance_time=v_member_time
                and a.status <> 'CANCELLED')
            and not exists (
$new$;
begin
  select pg_get_functiondef('private.attendance_session_is_consistent(uuid)'::regprocedure) into d;
  if strpos(d,'a.advance_date=member.class_date')=0 then
    if strpos(d,old_part)=0 then raise exception 'unexpected attendance consistency validator'; end if;
    execute replace(d,old_part,new_part);
  end if;
end;
$patch_audit$;

create or replace function public.list_teacher_lesson_booking_occurrences(p_from date,p_to date)
returns table(booking_id uuid,class_date date,start_time text,lesson_advance_id uuid)
language sql stable security definer set search_path='' as $$
  with dates as (
    select generate_series(greatest(p_from,(now() at time zone 'America/Sao_Paulo')::date-120)::timestamp,
      least(p_to,(now() at time zone 'America/Sao_Paulo')::date+90)::timestamp,interval '1 day')::date as day
  )
  select b.id,d.day,s.slot->>'time_slot',null::uuid
    from public.bookings b cross join dates d
    cross join lateral(select public.booking_schedule_on_date(b.id,d.day) as slot) s
   where b.tenant_id=public._my_tenant_id() and b.teacher_id=auth.uid()
     and coalesce((s.slot->>'valid')::boolean,false)
     and not exists(select 1 from public.lesson_advances a where a.tenant_id=b.tenant_id
       and a.booking_id=b.id and a.status <> 'CANCELLED' and d.day in(a.original_date,a.advance_date))
  union all
  select a.booking_id,a.advance_date,to_char(a.advance_time,'HH24:MI'),a.id
    from public.lesson_advances a
   where a.tenant_id=public._my_tenant_id() and a.teacher_id=auth.uid()
     and a.status<>'CANCELLED' and a.advance_date between p_from and p_to
     and a.advance_date between (now() at time zone 'America/Sao_Paulo')::date-120
       and (now() at time zone 'America/Sao_Paulo')::date+90
$$;
revoke all on function public.list_teacher_lesson_booking_occurrences(date,date) from public,anon,authenticated,service_role;
grant execute on function public.list_teacher_lesson_booking_occurrences(date,date) to authenticated;

alter function private.validate_lesson_advance_integrity() owner to postgres;
alter function private.complete_logged_lesson_advance() owner to postgres;
alter function private.require_finished_lesson_slot() owner to postgres;
alter function private.log_teacher_classes_engine(jsonb) owner to postgres;
alter function private.log_advanced_teacher_classes_engine(jsonb) owner to postgres;
alter function private.log_explicit_teacher_classes(jsonb) owner to postgres;
alter function public.log_teacher_classes(jsonb) owner to postgres;
alter function public.log_advanced_teacher_classes(jsonb) owner to postgres;
alter function public.list_teacher_lesson_booking_occurrences(date,date) owner to postgres;
alter view public.upcoming_classes owner to postgres;

create or replace function public.list_student_scheduled_lesson_occurrences(p_from date,p_to date)
returns table(booking_id uuid,class_date date,start_time text,teacher_id uuid,teacher_name text,teacher_avatar text,lesson_advance_id uuid)
language sql stable security definer set search_path='' as $$
 select u.source_id,u.class_date,u.time_text,u.teacher_id,p.full_name,p.avatar_url,a.id
 from public.upcoming_classes u
 join public.profiles p on p.id=u.teacher_id and p.tenant_id=u.tenant_id and p.role='TEACHER'
 left join public.lesson_advances a on a.booking_id=u.source_id and a.tenant_id=u.tenant_id
   and a.advance_date=u.class_date and a.status <> 'CANCELLED'
 where u.source_type='booking' and u.student_id=auth.uid() and u.tenant_id=public._my_tenant_id()
   and u.class_date between greatest(p_from,(now() at time zone 'America/Sao_Paulo')::date)
     and least(p_to,(now() at time zone 'America/Sao_Paulo')::date+45)
 order by u.class_date,u.time_text
$$;
alter function public.list_student_scheduled_lesson_occurrences(date,date) owner to postgres;
revoke all on function public.list_student_scheduled_lesson_occurrences(date,date) from public,anon,authenticated,service_role;
grant execute on function public.list_student_scheduled_lesson_occurrences(date,date) to authenticated;

notify pgrst,'reload schema';
