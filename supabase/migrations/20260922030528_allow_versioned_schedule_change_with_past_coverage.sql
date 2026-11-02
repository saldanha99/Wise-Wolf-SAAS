-- Cobertura histórica confirmada sem class_log continua protegida, mas não
-- deve bloquear uma troca FUTURA feita pela RPC oficial quando a grade antiga
-- já foi preservada em booking_schedule_versions.
create or replace function public.protect_booking_source_coverage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_audited_direct_transfer boolean := false;
  v_audited_versioned_change boolean := false;
begin
  if tg_op = 'UPDATE'
     and new.teacher_id is distinct from old.teacher_id
     and new.tenant_id is not distinct from old.tenant_id
     and new.student_id is not distinct from old.student_id
     and new.day_of_week is not distinct from old.day_of_week
     and new.time_slot is not distinct from old.time_slot
     and new.date is not distinct from old.date
     and new.start_date is not distinct from old.start_date
     and new.status is not distinct from old.status then
    v_audited_direct_transfer := exists (
      select 1 from public.teacher_transfers transfer
      where transfer.tenant_id = old.tenant_id
        and transfer.student_id = old.student_id
        and transfer.from_teacher_id = old.teacher_id
        and transfer.to_teacher_id = new.teacher_id
        and upper(transfer.status) = 'APPLIED'
        and transfer.created_by = auth.uid()
        and transfer.applied_at = now()
    );
  end if;
  if v_audited_direct_transfer then return new; end if;

  if tg_op = 'UPDATE'
     and new.tenant_id is not distinct from old.tenant_id
     and new.teacher_id is not distinct from old.teacher_id
     and new.student_id is not distinct from old.student_id
     and new.date is not distinct from old.date
     and new.start_date is not distinct from old.start_date
     and new.status is not distinct from old.status
     and (new.day_of_week is distinct from old.day_of_week or new.time_slot is distinct from old.time_slot) then
    v_audited_versioned_change := exists (
      select 1
      from public.booking_schedule_versions version
      join public.schedule_change_requests request on request.id = version.request_id
      where version.booking_id = old.id
        and version.valid_from > (now() at time zone 'America/Sao_Paulo')::date
        and version.day_of_week = new.day_of_week
        and left(version.time_slot, 5) = left(new.time_slot, 5)
        and request.booking_id = old.id
        and request.status = 'APPLIED'
        and request.reviewed_by = auth.uid()
        and request.reviewed_at = now()
        and not exists (
          select 1 from public.class_coverages coverage
          where coverage.booking_id = old.id
            and coverage.tenant_id = old.tenant_id
            and coverage.class_date >= version.valid_from
            and (
              (lower(coverage.status) = 'confirmed' and coverage.class_log_id is null)
              or (lower(coverage.status) = 'pending' and now() < coalesce(
                coverage.invite_expires_at,
                (coverage.class_date::text || ' ' || left(coverage.class_time, 5) || ':00-03')::timestamptz
              ))
            )
        )
    );
  end if;
  if v_audited_versioned_change then return new; end if;

  if tg_op = 'UPDATE' and not (
    new.tenant_id is distinct from old.tenant_id
    or new.teacher_id is distinct from old.teacher_id
    or new.student_id is distinct from old.student_id
    or new.day_of_week is distinct from old.day_of_week
    or new.time_slot is distinct from old.time_slot
    or new.date is distinct from old.date
    or new.start_date is distinct from old.start_date
    or new.status is distinct from old.status
  ) then return new; end if;

  if exists (
    select 1 from public.class_coverages coverage
    where coverage.booking_id = old.id and coverage.tenant_id = old.tenant_id
      and (
        (lower(coverage.status) = 'confirmed' and coverage.class_log_id is null)
        or (lower(coverage.status) = 'pending' and now() < coalesce(
          coverage.invite_expires_at,
          (coverage.class_date::text || ' ' || left(coverage.class_time, 5) || ':00-03')::timestamptz
        ))
      )
  ) then
    raise exception using errcode = '23P01', message = 'booking_has_active_coverage';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

alter function public.protect_booking_source_coverage() owner to postgres;
revoke all on function public.protect_booking_source_coverage()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
