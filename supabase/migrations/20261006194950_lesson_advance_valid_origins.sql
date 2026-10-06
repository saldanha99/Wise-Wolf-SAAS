-- A tela lê a mesma agenda efetiva usada para validar a antecipação.
create or replace function public.list_lesson_advance_candidates(p_student_id uuid,p_month date)
returns table(booking_id uuid,original_date date,start_time text,teacher_name text)
language plpgsql stable security definer set search_path='' as $$
declare v_tenant text:=public._my_tenant_id(); v_today date:=(now() at time zone 'America/Sao_Paulo')::date;
begin
 if auth.uid() is null or v_tenant is null or coalesce(public._my_role(),'') not in ('SCHOOL_ADMIN','COORDINATOR','SUPER_ADMIN')
 or not coalesce(public._my_tenant_is_operational(),false) then
  raise exception using errcode='42501',message='lesson_advance_not_authorized';
 end if;
 if p_month is null or p_student_id is null then
  raise exception using errcode='22023',message='invalid_lesson_advance_entries';
 end if;
 return query
 select b.id,d.day::date,s.slot->>'time_slot',t.full_name::text
 from public.bookings b join public.profiles t on t.id=b.teacher_id and t.tenant_id=b.tenant_id
 cross join lateral generate_series(date_trunc('month',p_month::timestamp),
  date_trunc('month',p_month::timestamp)+interval '1 month'-interval '1 day',interval '1 day') d(day)
 cross join lateral (select public.booking_schedule_on_date(b.id,d.day::date) as slot) s
 where b.tenant_id=v_tenant and b.student_id=p_student_id and b.status in ('SCHEDULED','scheduled')
 and d.day::date>v_today and coalesce((s.slot->>'valid')::boolean,false)
 and not exists(select 1 from public.class_logs l where l.tenant_id=b.tenant_id and l.booking_id=b.id::text and l.class_date=d.day::date)
 order by d.day,s.slot->>'time_slot',b.id;
end $$;
alter function public.list_lesson_advance_candidates(uuid,date) owner to postgres;
revoke all on function public.list_lesson_advance_candidates(uuid,date) from public,anon,authenticated,service_role;
grant execute on function public.list_lesson_advance_candidates(uuid,date) to authenticated;

create or replace function public.create_lesson_advances(
  p_student_id uuid,
  p_entries jsonb,
  p_reason text default 'Viagem'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
  v_entry jsonb;
  v_booking public.bookings%rowtype;
  v_original date;
  v_advance date;
  v_time time without time zone;
  v_schedule jsonb;
  v_id uuid;
  v_ids uuid[] := array[]::uuid[];
begin
  if v_actor is null or v_tenant is null
     or coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
     or not coalesce(public._my_tenant_is_operational(), false) then
    raise exception using errcode = '42501', message = 'lesson_advance_not_authorized';
  end if;
  if p_student_id is null or p_entries is null
     or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) < 1
     or jsonb_array_length(p_entries) > 31 then
    raise exception using errcode = '22023', message = 'invalid_lesson_advance_entries';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries) loop
    begin
      select booking.* into strict v_booking
        from public.bookings as booking
       where booking.id = (v_entry ->> 'booking_id')::uuid
         and booking.tenant_id = v_tenant
         and booking.student_id = p_student_id
         and booking.status in ('SCHEDULED', 'scheduled') for update;
      v_original := (v_entry ->> 'original_date')::date;
      v_advance := (v_entry ->> 'advance_date')::date;
      v_schedule := public.booking_schedule_on_date(v_booking.id, v_original);
      v_time := coalesce(nullif(v_entry ->> 'advance_time', '')::time, (v_schedule->>'time_slot')::time);
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_lesson_advance_entry';
    end;

    if v_original is null or v_advance is null or v_time is null then
      raise exception using errcode = '22023', message = 'invalid_lesson_advance_entry';
    end if;
    if v_original <= (now() at time zone 'America/Sao_Paulo')::date then
      raise exception using errcode = '22023', message = 'lesson_advance_origin_must_be_future';
    end if;
    if v_advance >= v_original or date_trunc('month', v_advance::timestamp) >= date_trunc('month', v_original::timestamp) then
      raise exception using errcode = '22023', message = 'lesson_advance_requires_previous_month';
    end if;
    if exists(select 1 from public.lesson_advances a where a.tenant_id=v_tenant
      and a.booking_id=v_booking.id and a.original_date=v_original and a.status<>'CANCELLED') then
      raise exception using errcode = '23505', message = 'lesson_advance_origin_already_used';
    end if;
    if not coalesce((v_schedule->>'valid')::boolean, false) then
      raise exception using errcode = '22023', message = 'lesson_advance_origin_not_a_booking_occurrence';
    end if;

    insert into public.lesson_advances (
      tenant_id, booking_id, teacher_id, student_id, original_date,
      advance_date, advance_time, reason, created_by
    ) values (
      v_tenant, v_booking.id, v_booking.teacher_id, p_student_id, v_original,
      v_advance, v_time, left(coalesce(nullif(btrim(p_reason), ''), 'Viagem'), 500), v_actor
    ) returning id into v_id;
    v_ids := array_append(v_ids, v_id);
  end loop;

  return jsonb_build_object('created', cardinality(v_ids), 'ids', to_jsonb(v_ids));
exception when unique_violation then
  raise exception using errcode = '23505', message = 'lesson_advance_origin_already_used';
end;
$function$;

alter function public.create_lesson_advances(uuid,jsonb,text) owner to postgres;
revoke all on function public.create_lesson_advances(uuid,jsonb,text) from public,anon,service_role;
grant execute on function public.create_lesson_advances(uuid,jsonb,text) to authenticated;
