-- Antecipacao de aulas entre competencias.
-- A data realizada define o fechamento do professor; original_date identifica
-- a ocorrencia futura consumida e a retira da agenda sem alterar o booking
-- recorrente dos meses seguintes.

create table if not exists public.lesson_advances (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  booking_id uuid not null references public.bookings(id),
  teacher_id uuid not null references public.profiles(id),
  student_id uuid not null references public.profiles(id),
  original_date date not null,
  advance_date date not null,
  advance_time time without time zone not null,
  reason text not null default 'Viagem',
  status text not null default 'SCHEDULED'
    check (status in ('SCHEDULED', 'COMPLETED', 'CANCELLED')),
  class_log_id uuid references public.class_logs(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  constraint lesson_advances_dates_check check (advance_date < original_date),
  constraint lesson_advances_cross_month_check check (
    date_trunc('month', advance_date::timestamp) < date_trunc('month', original_date::timestamp)
  ),
  constraint lesson_advances_completion_check check (
    (status = 'COMPLETED' and class_log_id is not null and completed_at is not null)
    or (status <> 'COMPLETED' and class_log_id is null and completed_at is null)
  )
);

comment on table public.lesson_advances is
  'Ocorrencias futuras trazidas para uma data anterior. A data real paga o professor; original_date bloqueia somente a ocorrencia consumida.';

create unique index if not exists lesson_advances_original_occurrence_uq
  on public.lesson_advances (tenant_id, booking_id, original_date)
  where status <> 'CANCELLED';
create unique index if not exists lesson_advances_class_log_uq
  on public.lesson_advances (class_log_id)
  where class_log_id is not null;
create index if not exists lesson_advances_teacher_date_idx
  on public.lesson_advances (tenant_id, teacher_id, advance_date)
  where status = 'SCHEDULED';
create index if not exists lesson_advances_student_origin_idx
  on public.lesson_advances (tenant_id, student_id, original_date)
  where status <> 'CANCELLED';

alter table public.lesson_advances enable row level security;
revoke all on table public.lesson_advances from anon, authenticated;
grant select on table public.lesson_advances to authenticated;

drop policy if exists lesson_advances_read on public.lesson_advances;
create policy lesson_advances_read on public.lesson_advances
for select to authenticated
using (
  tenant_id = (select public._my_tenant_id())
  and (
    teacher_id = (select auth.uid())
    or student_id = (select auth.uid())
    or (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
  )
);

alter table public.class_logs
  add column if not exists lesson_advance_id uuid references public.lesson_advances(id);
create unique index if not exists class_logs_lesson_advance_uq
  on public.class_logs (lesson_advance_id)
  where lesson_advance_id is not null;
comment on column public.class_logs.lesson_advance_id is
  'Origem da aula antecipada. A competencia consumida permanece em lesson_advances.original_date.';

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
  v_id uuid;
  v_ids uuid[] := array[]::uuid[];
begin
  if v_actor is null or v_tenant is null
     or v_role not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
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
         and booking.status in ('SCHEDULED', 'scheduled');
      v_original := (v_entry ->> 'original_date')::date;
      v_advance := (v_entry ->> 'advance_date')::date;
      v_time := coalesce(nullif(v_entry ->> 'advance_time', '')::time, v_booking.time_slot::time);
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_lesson_advance_entry';
    end;

    if v_original <= (now() at time zone 'America/Sao_Paulo')::date
       or v_advance >= v_original
       or date_trunc('month', v_advance::timestamp) >= date_trunc('month', v_original::timestamp)
       or (v_booking.start_date is not null and v_original < v_booking.start_date)
       or public.dow_name_to_int(v_booking.day_of_week) <> extract(dow from v_original)::int then
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

create or replace function public.cancel_lesson_advance(p_advance_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row public.lesson_advances%rowtype;
begin
  if auth.uid() is null
     or public._my_role() not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
     or not coalesce(public._my_tenant_is_operational(), false) then
    raise exception using errcode = '42501', message = 'lesson_advance_not_authorized';
  end if;
  update public.lesson_advances as advance
     set status = 'CANCELLED', cancelled_at = now()
   where advance.id = p_advance_id
     and advance.tenant_id = public._my_tenant_id()
     and advance.status = 'SCHEDULED'
  returning advance.* into v_row;
  if not found then
    raise exception using errcode = 'P0002', message = 'lesson_advance_not_found_or_completed';
  end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$function$;

create or replace function public.log_advanced_teacher_classes(p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_teacher uuid := auth.uid();
  v_tenant text := public._my_tenant_id();
  v_entry jsonb;
  v_advance public.lesson_advances%rowtype;
  v_presence text;
  v_new_id uuid;
  v_ids uuid[] := array[]::uuid[];
  v_results jsonb := '[]'::jsonb;
  v_inserted int := 0;
  v_skipped int := 0;
  v_reschedules int := 0;
  v_student_absence_count int := 0;
  v_delta numeric := 0;
  v_paid int := 0;
  v_projection jsonb;
begin
  if v_teacher is null or v_tenant is null
     or public._my_role() not in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
     or not coalesce(public._my_tenant_is_operational(), false) then
    raise exception using errcode = '42501', message = 'teacher_profile_required';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) < 1 or jsonb_array_length(p_entries) > 100 then
    raise exception using errcode = '22023', message = 'invalid_entries';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries) loop
    v_new_id := null;
    select advance.* into v_advance
      from public.lesson_advances as advance
     where advance.id::text = nullif(btrim(v_entry ->> 'lesson_advance_id'), '')
       and advance.tenant_id = v_tenant
       and advance.teacher_id = v_teacher
     for update of advance;
    v_presence := btrim(coalesce(v_entry ->> 'presence', 'COMPLETED'));

    if not found or v_advance.status <> 'SCHEDULED' then
      v_skipped := v_skipped + 1;
      v_results := v_results || jsonb_build_object('ref', v_entry ->> 'ref', 'status', 'ignorada', 'reason', 'antecipacao_inexistente_ou_consumida', 'kind', 'ADVANCE');
      continue;
    elsif v_advance.advance_date <> (v_entry ->> 'class_date')::date then
      raise exception using errcode = '22023', message = 'lesson_advance_date_mismatch';
    elsif v_advance.advance_date > (now() at time zone 'America/Sao_Paulo')::date then
      v_skipped := v_skipped + 1;
      v_results := v_results || jsonb_build_object('ref', v_entry ->> 'ref', 'status', 'ignorada', 'reason', 'aula_no_futuro', 'kind', 'ADVANCE');
      continue;
    elsif v_presence not in ('COMPLETED', 'STUDENT_ABSENCE', 'TEACHER_ABSENCE', 'Falta Justificada') then
      raise exception using errcode = '22023', message = 'presenca_invalida';
    end if;

    insert into public.class_logs (
      tenant_id, teacher_id, student_id, booking_id, lesson_advance_id,
      presence, subtype, content_covered, content, observations,
      date, class_date, start_time, created_at
    ) values (
      v_tenant, v_teacher, v_advance.student_id, v_advance.booking_id::text, v_advance.id,
      v_presence, 'ANTECIPAÇÃO',
      nullif(btrim(v_entry ->> 'content_covered'), ''),
      nullif(btrim(v_entry ->> 'content_covered'), ''),
      nullif(btrim(v_entry ->> 'observations'), ''),
      v_advance.advance_date, v_advance.advance_date, v_advance.advance_time, now()
    ) returning id into v_new_id;

    update public.lesson_advances as advance
       set status = 'COMPLETED', class_log_id = v_new_id, completed_at = now()
     where advance.id = v_advance.id;

    if v_presence = 'TEACHER_ABSENCE' then
      insert into public.reschedules (
        tenant_id, teacher_id, student_id, original_booking_id,
        date, time, fault_type, created_at
      ) values (
        v_tenant, v_teacher, v_advance.student_id, v_advance.booking_id,
        'Pendente', 'Pendente', 'TEACHER', now()
      );
      v_reschedules := v_reschedules + 1;
    elsif v_presence in ('STUDENT_ABSENCE', 'Falta Justificada') then
      select count(*)::int into v_student_absence_count
        from public.reschedules as reschedule
       where reschedule.tenant_id = v_tenant
         and reschedule.student_id = v_advance.student_id
         and reschedule.fault_type = 'STUDENT'
         and reschedule.created_at >= date_trunc('month', now());
      if v_student_absence_count < 5 then
        insert into public.reschedules (
          tenant_id, teacher_id, student_id, original_booking_id,
          date, time, fault_type, created_at
        ) values (
          v_tenant, v_teacher, v_advance.student_id, v_advance.booking_id,
          'Pendente', 'Pendente', 'STUDENT', now()
        );
        v_reschedules := v_reschedules + 1;
      end if;
    end if;

    v_inserted := v_inserted + 1;
    v_ids := array_append(v_ids, v_new_id);
    v_results := v_results || jsonb_build_object(
      'ref', v_entry ->> 'ref', 'id', v_new_id, 'status', 'lancada',
      'kind', 'ADVANCE', 'subtype', 'ANTECIPAÇÃO'
    );
  end loop;

  if cardinality(v_ids) > 0 then
    select coalesce(sum(pay.rate_efetivo), 0), count(*)::int
      into v_delta, v_paid
      from public.v_payable_class_logs as pay
     where pay.id = any(v_ids);
    select jsonb_agg(item || jsonb_build_object(
      'amount', coalesce(pay.rate_efetivo, 0), 'paid', pay.id is not null,
      'unpaid_reason', case
        when pay.id is not null then null
        when log.presence = 'TEACHER_ABSENCE' then 'falta_professor'
        else 'fora_da_folha'
      end
    )) into v_results
      from jsonb_array_elements(v_results) as item
      left join public.class_logs as log on log.id::text = item ->> 'id'
      left join public.v_payable_class_logs as pay on pay.id = log.id;
  end if;
  v_projection := public.teacher_pay_projection(v_teacher);
  return jsonb_build_object(
    'inserted', v_inserted, 'skipped', v_skipped,
    'reschedules_created', v_reschedules,
    'delta_amount', v_delta, 'delta_lessons', v_paid,
    'month_amount', coalesce((v_projection ->> 'amount_logged')::numeric, 0),
    'month_lessons', coalesce((v_projection ->> 'lessons_logged')::int, 0),
    'turbo_active', coalesce((v_projection -> 'turbo' ->> 'active')::boolean, false),
    'entries', coalesce(v_results, '[]'::jsonb)
  );
end;
$function$;

alter function public.create_lesson_advances(uuid, jsonb, text) owner to postgres;
alter function public.cancel_lesson_advance(uuid) owner to postgres;
alter function public.log_advanced_teacher_classes(jsonb) owner to postgres;
revoke all on function public.create_lesson_advances(uuid, jsonb, text) from public, anon;
revoke all on function public.cancel_lesson_advance(uuid) from public, anon;
revoke all on function public.log_advanced_teacher_classes(jsonb) from public, anon;
grant execute on function public.create_lesson_advances(uuid, jsonb, text) to authenticated;
grant execute on function public.cancel_lesson_advance(uuid) to authenticated;
grant execute on function public.log_advanced_teacher_classes(jsonb) to authenticated;

notify pgrst, 'reload schema';
