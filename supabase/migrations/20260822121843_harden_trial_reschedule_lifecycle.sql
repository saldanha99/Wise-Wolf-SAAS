-- Evolução aditiva da confirmação de reagendamento experimental.
-- Preserva a migration histórica 20260821220943 e amplia somente os estados
-- recuperáveis, os conflitos ativos e a normalização após o aceite do professor.

create or replace function public.create_trial_reschedule_confirmation(
  p_tenant_id text,
  p_opportunity_id uuid,
  p_appointment_id uuid,
  p_teacher_id uuid,
  p_lead_id uuid,
  p_requested_start_time timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_appointment public.appointments%rowtype;
  v_pending public.trial_reschedule_requests%rowtype;
  v_request public.trial_reschedule_requests%rowtype;
begin
  select appointment.*
    into v_appointment
    from public.appointments as appointment
   where appointment.id = p_appointment_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'appointment_not_found');
  end if;
  if v_appointment.tenant_id is distinct from p_tenant_id
     or coalesce(v_appointment.teacher_id, v_appointment.professor_id) is distinct from p_teacher_id then
    return jsonb_build_object('ok', false, 'error', 'appointment_owner_mismatch');
  end if;
  if lower(coalesce(v_appointment.status, '')) not in (
    'scheduled', 'confirmed', 'no_show'
  ) then
    return jsonb_build_object('ok', false, 'error', 'appointment_not_scheduled');
  end if;
  if p_requested_start_time is null or p_requested_start_time <= now() then
    return jsonb_build_object('ok', false, 'error', 'requested_time_not_future');
  end if;
  if p_requested_start_time = v_appointment.start_time then
    return jsonb_build_object('ok', true, 'created', false, 'same_time', true);
  end if;
  if not exists (
    select 1
      from public.opportunities as opportunity
     where opportunity.id = p_opportunity_id
       and opportunity.tenant_id = p_tenant_id
       and opportunity.trial_appointment_id = p_appointment_id
       and coalesce(opportunity.winner_teacher_id, opportunity.professor_id) = p_teacher_id
       and upper(coalesce(opportunity.trial_status, 'SCHEDULED')) not in (
         'DONE', 'COMPLETED', 'CANCELLED', 'CANCELED'
       )
       and not exists (
         select 1
           from public.class_logs as class_log
          where class_log.appointment_id = p_appointment_id::text
       )
  ) then
    return jsonb_build_object('ok', false, 'error', 'opportunity_mismatch');
  end if;

  select request.*
    into v_pending
    from public.trial_reschedule_requests as request
   where request.appointment_id = p_appointment_id
     and request.status = 'PENDING'
   for update;

  if found
     and v_pending.requested_start_time = p_requested_start_time
     and v_pending.from_start_time = v_appointment.start_time
     and v_pending.expires_at > now() then
    return jsonb_build_object(
      'ok', true,
      'created', false,
      'request_id', v_pending.id,
      'reply_code', v_pending.reply_code
    );
  end if;

  update public.trial_reschedule_requests
     set status = 'SUPERSEDED', responded_at = now()
   where appointment_id = p_appointment_id
     and status = 'PENDING';

  insert into public.trial_reschedule_requests (
    tenant_id,
    opportunity_id,
    appointment_id,
    teacher_id,
    lead_id,
    from_start_time,
    requested_start_time,
    expires_at
  ) values (
    p_tenant_id,
    p_opportunity_id,
    p_appointment_id,
    p_teacher_id,
    p_lead_id,
    v_appointment.start_time,
    p_requested_start_time,
    least(now() + interval '24 hours', p_requested_start_time)
  )
  returning * into v_request;

  return jsonb_build_object(
    'ok', true,
    'created', true,
    'request_id', v_request.id,
    'reply_code', v_request.reply_code
  );
end;
$function$;

create or replace function public.respond_trial_reschedule_confirmation(
  p_request_id uuid,
  p_teacher_id uuid,
  p_accept boolean,
  p_response_text text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_request public.trial_reschedule_requests%rowtype;
  v_appointment public.appointments%rowtype;
  v_local timestamp;
  v_date text;
  v_time text;
  v_day_number integer;
  v_day_name text;
begin
  select request.*
    into v_request
    from public.trial_reschedule_requests as request
   where request.id = p_request_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'request_not_found');
  end if;
  if v_request.teacher_id is distinct from p_teacher_id then
    return jsonb_build_object('ok', false, 'error', 'teacher_mismatch');
  end if;

  select appointment.*
    into v_appointment
    from public.appointments as appointment
   where appointment.id = v_request.appointment_id
   for update;

  select request.*
    into v_request
    from public.trial_reschedule_requests as request
   where request.id = p_request_id
   for update;

  if v_request.status <> 'PENDING' then
    return jsonb_build_object(
      'ok', true,
      'already_answered', true,
      'status', v_request.status
    );
  end if;
  if v_request.expires_at <= now() or v_request.requested_start_time <= now() then
    update public.trial_reschedule_requests
       set status = 'EXPIRED', response_text = left(p_response_text, 500), responded_at = now()
     where id = v_request.id;
    return jsonb_build_object('ok', false, 'error', 'request_expired');
  end if;
  if not coalesce(p_accept, false) then
    update public.trial_reschedule_requests
       set status = 'DECLINED', response_text = left(p_response_text, 500), responded_at = now()
     where id = v_request.id;
    return jsonb_build_object('ok', true, 'accepted', false, 'status', 'DECLINED');
  end if;
  if v_appointment.id is null
     or lower(coalesce(v_appointment.status, '')) not in (
       'scheduled', 'confirmed', 'no_show'
     )
     or coalesce(v_appointment.teacher_id, v_appointment.professor_id) is distinct from p_teacher_id
     or v_appointment.start_time is distinct from v_request.from_start_time
     or not exists (
       select 1
         from public.opportunities as opportunity
        where opportunity.id = v_request.opportunity_id
          and opportunity.trial_appointment_id = v_request.appointment_id
          and coalesce(opportunity.winner_teacher_id, opportunity.professor_id) = p_teacher_id
          and upper(coalesce(opportunity.trial_status, 'SCHEDULED')) not in (
            'DONE', 'COMPLETED', 'CANCELLED', 'CANCELED'
          )
     )
     or exists (
       select 1
         from public.class_logs as class_log
        where class_log.appointment_id = v_request.appointment_id::text
     ) then
    update public.trial_reschedule_requests
       set status = 'SUPERSEDED', response_text = left(p_response_text, 500), responded_at = now()
     where id = v_request.id;
    return jsonb_build_object('ok', false, 'error', 'appointment_changed');
  end if;

  v_local := timezone('America/Sao_Paulo', v_request.requested_start_time);
  v_date := to_char(v_local, 'YYYY-MM-DD');
  v_time := to_char(v_local, 'HH24:MI');
  v_day_number := extract(dow from v_local)::integer;
  v_day_name := case v_day_number
    when 0 then 'domingo'
    when 1 then 'segunda'
    when 2 then 'terca'
    when 3 then 'quarta'
    when 4 then 'quinta'
    when 5 then 'sexta'
    when 6 then 'sabado'
  end;

  if exists (
    select 1
      from public.appointments as conflict
     where conflict.id <> v_appointment.id
       and coalesce(conflict.teacher_id, conflict.professor_id) = p_teacher_id
       and lower(coalesce(conflict.status, '')) in ('scheduled', 'confirmed')
       and abs(extract(epoch from (conflict.start_time - v_request.requested_start_time))) < 1800
  ) or exists (
    select 1
      from public.bookings as conflict
     where conflict.teacher_id = p_teacher_id
       and upper(coalesce(conflict.status, '')) <> 'CANCELLED'
       and left(coalesce(conflict.time_slot, ''), 5) ~ '^[0-2][0-9]:[0-5][0-9]$'
       and (
         conflict.date::text = v_date
         or (
           lower(translate(coalesce(conflict.day_of_week, ''), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')) = v_day_name
         )
       )
       and abs(extract(epoch from (
         (v_date || ' ' || left(conflict.time_slot, 5))::timestamp - v_local
       ))) < 1800
  ) then
    update public.trial_reschedule_requests
       set status = 'CONFLICT', response_text = left(p_response_text, 500), responded_at = now()
     where id = v_request.id;
    return jsonb_build_object('ok', false, 'error', 'teacher_conflict');
  end if;

  update public.appointments
     set start_time = v_request.requested_start_time,
         status = 'scheduled'
   where id = v_appointment.id;

  update public.opportunities
     set slots_proposed = jsonb_build_array(jsonb_build_object(
       'day', v_day_number,
       'date', v_date,
       'time', v_time,
       'formatted', to_char(v_local, 'DD/MM/YYYY') || ' (' ||
         case v_day_number
           when 0 then 'Domingo'
           when 1 then 'Segunda'
           when 2 then 'Terça'
           when 3 then 'Quarta'
           when 4 then 'Quinta'
           when 5 then 'Sexta'
           when 6 then 'Sábado'
         end || ')'
     )),
         status = 'CLAIMED',
         trial_status = 'SCHEDULED',
         conversion_status = 'OPEN',
         lost_reason = null
   where id = v_request.opportunity_id
     and trial_appointment_id = v_request.appointment_id;

  update public.trial_reschedule_requests
     set status = 'ACCEPTED', response_text = left(p_response_text, 500), responded_at = now()
   where id = v_request.id;

  return jsonb_build_object('ok', true, 'accepted', true, 'status', 'ACCEPTED');
end;
$function$;

alter function public.create_trial_reschedule_confirmation(text, uuid, uuid, uuid, uuid, timestamptz) owner to postgres;
alter function public.respond_trial_reschedule_confirmation(uuid, uuid, boolean, text) owner to postgres;

revoke all on function public.create_trial_reschedule_confirmation(text, uuid, uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.respond_trial_reschedule_confirmation(uuid, uuid, boolean, text)
  from public, anon, authenticated;

grant execute on function public.create_trial_reschedule_confirmation(text, uuid, uuid, uuid, uuid, timestamptz)
  to service_role;
grant execute on function public.respond_trial_reschedule_confirmation(uuid, uuid, boolean, text)
  to service_role;
