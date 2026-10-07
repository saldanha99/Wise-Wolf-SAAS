-- Corrige troca auditada de aulas originadas na matrícula sem alterar a oferta
-- nem suas reservas. Reexecutável; mantém a função privada e o dono sem superuser.
create or replace function private.protect_enrollment_schedule_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_day text;
  v_day_number integer;
  v_time text;
  v_slot record;
  v_versioned_schedule boolean := false;
begin
  if (new.enrollment_offer_id is null)
     <> (new.enrollment_offer_slot_id is null)
  then
    raise exception 'invalid_enrollment_booking_link' using errcode = '23514';
  end if;

  if pg_catalog.upper(coalesce(new.status, 'SCHEDULED')) <> 'SCHEDULED' then
    return new;
  end if;

  v_day := public.canonical_weekday_name(new.day_of_week);
  v_day_number := public.dow_name_to_int(v_day);
  v_time := pg_catalog.btrim(new.time_slot);
  if v_day is null
    or v_day_number not between 0 and 6
    or v_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
  then
    raise exception 'invalid_enrollment_booking_slot' using errcode = '23514';
  end if;
  v_time := pg_catalog.to_char(v_time::time, 'HH24:MI');

  if new.teacher_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'schedule:teacher:' || new.teacher_id::text || ':' ||
        public.fold_accents(v_day) || ':' || v_time,
        0
      )
    );
  end if;
  if new.student_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'schedule:student:' || new.student_id::text || ':' ||
        public.fold_accents(v_day) || ':' || v_time,
        0
      )
    );
  end if;

  if new.enrollment_offer_slot_id is not null then
    select slot.*
    into v_slot
    from private.enrollment_offer_schedule_slots as slot
    where slot.id = new.enrollment_offer_slot_id
      and slot.offer_id = new.enrollment_offer_id
    for update;
    if not found then
      raise exception 'invalid_enrollment_booking_link' using errcode = '42501';
    end if;

    -- O slot materializado é a origem da matrícula, não a agenda para sempre.
    -- Só uma versão APPLIED pode divergir dele, sem mudar vínculo/participantes.
    if tg_op = 'UPDATE'
      and v_slot.status = 'MATERIALIZED'
      and v_slot.materialized_booking_id = old.id
      and new.enrollment_offer_id is not distinct from old.enrollment_offer_id
      and new.enrollment_offer_slot_id is not distinct from old.enrollment_offer_slot_id
      and new.tenant_id is not distinct from old.tenant_id
      and new.student_id is not distinct from old.student_id
      and new.teacher_id is not distinct from old.teacher_id
      and new.start_date is not distinct from old.start_date
      and new.date is not distinct from old.date
      and new.status is not distinct from old.status
    then
      select exists (
        select 1 from public.booking_schedule_versions version
        join public.schedule_change_requests request on request.id = version.request_id
        where version.booking_id = old.id
          and version.tenant_id = new.tenant_id
          and version.day_of_week = v_day
          and left(version.time_slot, 5) = v_time
          and version.valid_until is null
          and version.valid_from = request.effective_from
          and request.booking_id = old.id
          and request.tenant_id = new.tenant_id
          and request.student_id = new.student_id
          and request.teacher_id = new.teacher_id
          and request.scope = 'PERMANENT'
          and request.status = 'APPLIED'
          and request.new_day = v_day
          and request.new_time = v_time
          and (
            (new.day_of_week is not distinct from old.day_of_week
              and new.time_slot is not distinct from old.time_slot)
            or (request.reviewed_by = auth.uid() and request.reviewed_at = now()
              and version.valid_from > (now() at time zone 'America/Sao_Paulo')::date)
          )
      ) into v_versioned_schedule;
    end if;

    if v_slot.tenant_id is distinct from new.tenant_id
      or v_slot.teacher_id is distinct from new.teacher_id
      or (not v_versioned_schedule and (
        v_slot.day_of_week is distinct from v_day_number
        or pg_catalog.to_char(v_slot.class_time, 'HH24:MI') is distinct from v_time
      ))
      or v_slot.start_date is distinct from new.start_date
      or v_slot.reserved_by is distinct from new.student_id
      or v_slot.status not in ('RESERVED', 'MATERIALIZED')
    then
      raise exception 'invalid_enrollment_booking_link' using errcode = '42501';
    end if;
    -- A prova da troca não autoriza ocupar uma reserva de matrícula viva.
    if v_versioned_schedule and exists (
      select 1 from private.enrollment_offer_schedule_slots reserved
      where reserved.id <> v_slot.id and reserved.tenant_id = new.tenant_id
        and (reserved.teacher_id = new.teacher_id or reserved.reserved_by = new.student_id)
        and reserved.day_of_week = v_day_number
        and pg_catalog.to_char(reserved.class_time, 'HH24:MI') = v_time
        and reserved.status = 'RESERVED' and reserved.reservation_expires_at > now()
    ) then
      raise exception 'booking_conflicts_with_enrollment_reservation' using errcode = '23P01';
    end if;
    return new;
  end if;

  if (new.teacher_id is not null or new.student_id is not null) and exists (
    select 1
    from private.enrollment_offer_schedule_slots as reserved
    where reserved.tenant_id = new.tenant_id
      and (
        reserved.teacher_id = new.teacher_id
        or reserved.reserved_by = new.student_id
      )
      and reserved.day_of_week = v_day_number
      and pg_catalog.to_char(reserved.class_time, 'HH24:MI') = v_time
      and (
        reserved.status = 'RESERVED'
        and reserved.reservation_expires_at > now()
        or reserved.status = 'MATERIALIZED'
        and exists (
          select 1
          from public.bookings as linked_booking
          where linked_booking.id = reserved.materialized_booking_id
            and linked_booking.enrollment_offer_slot_id = reserved.id
            and pg_catalog.upper(
              coalesce(linked_booking.status, 'SCHEDULED')
            ) = 'SCHEDULED'
        )
      )
  ) then
    raise exception 'booking_conflicts_with_enrollment_reservation'
      using errcode = '23P01';
  end if;

  return new;
end;
$function$;

revoke all on function private.protect_enrollment_schedule_reservation()
  from public, anon, authenticated, service_role;


alter function private.protect_enrollment_schedule_reservation() owner to postgres;
