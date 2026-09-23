begin;

-- A oferta assinada é a fonte autoritativa do prazo. O perfil é mantido em
-- sincronia para que a segunda via do contrato nunca caia no prazo-padrão.
-- A conclusão também cria dois avisos duráveis: Gestão e professor(es), com
-- dedupe por oferta/destinatário. Fixtures continuam completamente suprimidas.
create or replace function private.enqueue_enrollment_completion_notifications(
  p_offer_id uuid,
  p_student_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer public.offers%rowtype;
  v_student public.profiles%rowtype;
  v_duration integer;
  v_start_date date;
  v_group_destination text;
  v_schedule text;
  v_teacher record;
  v_teacher_schedule text;
  v_first_name text;
begin
  select offer.* into v_offer
    from public.offers as offer
   where offer.id = p_offer_id
     and offer.kind = 'ENROLLMENT'
     and offer.processing_state = 'COMPLETED'
     and coalesce(offer.consumed_by, offer.processing_by) = p_student_id;
  if not found then return; end if;

  select profile.* into v_student
    from public.profiles as profile
   where profile.id = p_student_id
     and profile.tenant_id = v_offer.tenant_id
     and profile.role = 'STUDENT'
     and profile.lifecycle_status = 'active'
     and profile.is_test_account is false;
  if not found then return; end if;
  if exists (
    select 1 from public.opportunities as opportunity
     where opportunity.id = v_offer.opportunity_id
       and opportunity.is_test_fixture is true
  ) then return; end if;

  v_duration := coalesce(nullif(v_offer.payload ->> 'planDuration', '')::integer, 1);
  v_start_date := coalesce(
    nullif(v_offer.payload ->> 'startDate', '')::date,
    v_student.start_date
  );

  update public.profiles as profile
     set fidelity_plan = case v_duration
       when 12 then 'ANNUAL'
       when 6 then 'SEMESTER'
       when 0 then 'ONE_TIME'
       else 'RECURRENT'
     end
   where profile.id = v_student.id
     and profile.tenant_id = v_offer.tenant_id
     and profile.fidelity_plan is distinct from case v_duration
       when 12 then 'ANNUAL'
       when 6 then 'SEMESTER'
       when 0 then 'ONE_TIME'
       else 'RECURRENT'
     end;

  select pg_catalog.string_agg(
           case lower(pg_catalog.btrim(booking.day_of_week))
             when 'monday' then 'segunda'
             when 'tuesday' then 'terça'
             when 'wednesday' then 'quarta'
             when 'thursday' then 'quinta'
             when 'friday' then 'sexta'
             when 'saturday' then 'sábado'
             when 'sunday' then 'domingo'
             else lower(pg_catalog.btrim(booking.day_of_week))
           end || ' ' || left(booking.time_slot, 5),
           ', ' order by extract(isodow from case lower(pg_catalog.btrim(booking.day_of_week))
             when 'monday' then date '2026-09-21'
             when 'tuesday' then date '2026-09-22'
             when 'wednesday' then date '2026-09-23'
             when 'thursday' then date '2026-09-24'
             when 'friday' then date '2026-09-25'
             when 'saturday' then date '2026-09-26'
             else date '2026-09-27'
           end), left(booking.time_slot, 5)
         )
    into v_schedule
    from public.bookings as booking
   where booking.tenant_id = v_offer.tenant_id
     and booking.student_id = v_student.id
     and booking.enrollment_offer_id = v_offer.id
     and upper(coalesce(booking.status, '')) = 'SCHEDULED';
  v_schedule := coalesce(nullif(v_schedule, ''), 'agenda a confirmar');

  select settings.destino into v_group_destination
    from public.dre_report_settings as settings
   where settings.tenant_id = v_offer.tenant_id
     and settings.is_active is true
     and settings.destino ~ '^[0-9]{10,25}@g[.]us$';

  if v_group_destination is not null then
    insert into public.notification_queue (
      tenant_id, student_id, student_name, student_phone, message_body,
      scheduled_for, status, source_id, source_type, notification_kind,
      idempotency_key
    ) values (
      v_offer.tenant_id, v_student.id, v_student.full_name,
      v_group_destination,
      format(
        E'🎉 *Mais uma matrícula fechada!*\n\n👤 %s\n📅 Início: %s\n🗓️ Aulas: %s\n📋 Plano: %s meses',
        btrim(v_student.full_name),
        coalesce(to_char(v_start_date, 'DD/MM/YYYY'), 'a confirmar'),
        v_schedule,
        v_duration
      ),
      pg_catalog.now(), 'pending', v_offer.id, 'ENROLLMENT_COMPLETION',
      'ENROLLMENT_MANAGEMENT_CLOSED',
      format('enrollment:%s:management', v_offer.id)
    )
    on conflict (tenant_id, idempotency_key)
      where idempotency_key is not null do nothing;
  end if;

  for v_teacher in
    select distinct profile.id, profile.full_name,
           coalesce(nullif(profile.attendance_phone, ''), nullif(profile.phone, '')) as phone
      from public.bookings as booking
      join public.profiles as profile
        on profile.id = booking.teacher_id
       and profile.tenant_id = booking.tenant_id
       and profile.role = 'TEACHER'
       and profile.lifecycle_status = 'active'
       and profile.is_test_account is false
     where booking.tenant_id = v_offer.tenant_id
       and booking.student_id = v_student.id
       and booking.enrollment_offer_id = v_offer.id
       and upper(coalesce(booking.status, '')) = 'SCHEDULED'
  loop
    if v_teacher.phone is null then continue; end if;
    select pg_catalog.string_agg(
             case lower(pg_catalog.btrim(booking.day_of_week))
               when 'monday' then 'segunda'
               when 'tuesday' then 'terça'
               when 'wednesday' then 'quarta'
               when 'thursday' then 'quinta'
               when 'friday' then 'sexta'
               when 'saturday' then 'sábado'
               when 'sunday' then 'domingo'
               else lower(pg_catalog.btrim(booking.day_of_week))
             end || ' ' || left(booking.time_slot, 5),
             ', ' order by booking.day_of_week, left(booking.time_slot, 5)
           )
      into v_teacher_schedule
      from public.bookings as booking
     where booking.tenant_id = v_offer.tenant_id
       and booking.student_id = v_student.id
       and booking.teacher_id = v_teacher.id
       and booking.enrollment_offer_id = v_offer.id
       and upper(coalesce(booking.status, '')) = 'SCHEDULED';
    v_first_name := split_part(btrim(coalesce(v_teacher.full_name, 'Professor(a)')), ' ', 1);

    insert into public.notification_queue (
      tenant_id, teacher_id, student_id, student_name, student_phone,
      message_body, scheduled_for, status, source_id, source_type,
      notification_kind, idempotency_key
    ) values (
      v_offer.tenant_id, v_teacher.id, v_student.id, v_student.full_name,
      v_teacher.phone,
      format(
        E'Oi, %s! 🐺 Matrícula fechada: *%s*.\n\nAs aulas começam em *%s*. Atualize sua agenda com: *%s*.',
        v_first_name, btrim(v_student.full_name),
        coalesce(to_char(v_start_date, 'DD/MM/YYYY'), 'data a confirmar'),
        coalesce(nullif(v_teacher_schedule, ''), 'horários a confirmar')
      ),
      pg_catalog.now(), 'pending', v_offer.id, 'ENROLLMENT_COMPLETION',
      'ENROLLMENT_TEACHER_CLOSED',
      format('enrollment:%s:teacher:%s', v_offer.id, v_teacher.id)
    )
    on conflict (tenant_id, idempotency_key)
      where idempotency_key is not null do nothing;
  end loop;
end;
$function$;

alter function private.enqueue_enrollment_completion_notifications(uuid, uuid)
  owner to postgres;
revoke all on function private.enqueue_enrollment_completion_notifications(uuid, uuid)
  from public, anon, authenticated, service_role;

do $preserve_completion$
begin
  if pg_catalog.to_regprocedure(
       'public.complete_enrollment_offer_pre_completion_notifications_impl(uuid,uuid)'
     ) is null
  then
    alter function public.complete_enrollment_offer(uuid,uuid)
      rename to complete_enrollment_offer_pre_completion_notifications_impl;
  end if;
end;
$preserve_completion$;

create or replace function public.complete_enrollment_offer(
  p_offer_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  v_result := public.complete_enrollment_offer_pre_completion_notifications_impl(
    p_offer_id,
    p_user_id
  );
  if coalesce((v_result ->> 'success')::boolean, false) is true then
    begin
      perform private.enqueue_enrollment_completion_notifications(
        p_offer_id,
        p_user_id
      );
    exception when others then
      raise warning '[enrollment-completion] notification enqueue failed for offer %: %',
        p_offer_id, sqlerrm;
    end;
  end if;
  return v_result;
end;
$function$;

alter function
  public.complete_enrollment_offer_pre_completion_notifications_impl(uuid,uuid)
  owner to postgres;
alter function public.complete_enrollment_offer(uuid,uuid) owner to postgres;
revoke all on function
  public.complete_enrollment_offer_pre_completion_notifications_impl(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_enrollment_offer(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.complete_enrollment_offer(uuid,uuid)
  to service_role;

commit;
