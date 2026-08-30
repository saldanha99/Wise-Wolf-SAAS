-- Atualiza validadores da função de reabertura de experimental sem depender de \d.

create or replace function public.reopen_trial_opportunity_for_broadcast(
  p_tenant_id text,
  p_opportunity_id uuid,
  p_slots_proposed jsonb,
  p_interests text,
  p_preferred_slots jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_opportunity public.opportunities%rowtype;
  v_appointment public.appointments%rowtype;
  v_requested_start timestamptz;
begin
  if jsonb_typeof(p_slots_proposed) <> 'array'
     or jsonb_array_length(p_slots_proposed) <> 1
     or coalesce(p_slots_proposed #>> '{0,date}', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or coalesce(p_slots_proposed #>> '{0,time}', '') !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
     or coalesce(p_slots_proposed #>> '{0,day}', '') !~ '^[0-6]$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_slots');
  end if;
  if p_preferred_slots is not null
     and jsonb_typeof(p_preferred_slots) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'invalid_preferred_slots');
  end if;
  if not private.tenant_is_operational(p_tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'tenant_not_operational');
  end if;

  begin
    v_requested_start := (
      (p_slots_proposed #>> '{0,date}') || ' ' ||
      (p_slots_proposed #>> '{0,time}')
    )::timestamp at time zone 'America/Sao_Paulo';
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'invalid_slots');
  end;
  if to_char(
       v_requested_start at time zone 'America/Sao_Paulo',
       'YYYY-MM-DD HH24:MI'
     ) <> (
       (p_slots_proposed #>> '{0,date}') || ' ' ||
       (p_slots_proposed #>> '{0,time}')
     )
     or v_requested_start <= now() + interval '5 minutes'
     or v_requested_start > now() + interval '366 days'
     or (p_slots_proposed #>> '{0,day}')::integer <>
       extract(dow from (v_requested_start at time zone 'America/Sao_Paulo'))::integer then
    return jsonb_build_object('ok', false, 'error', 'invalid_slots');
  end if;

  select opportunity.*
    into v_opportunity
    from public.opportunities as opportunity
   where opportunity.id = p_opportunity_id
     and opportunity.tenant_id = p_tenant_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'opportunity_not_found');
  end if;
  if v_opportunity.status = 'OPEN'
     and coalesce(v_opportunity.kind, 'TRIAL') = 'TRIAL'
     and v_opportunity.winner_teacher_id is null
     and v_opportunity.professor_id is null
     and v_opportunity.trial_appointment_id is null
     and coalesce(v_opportunity.conversion_status, 'OPEN') = 'OPEN'
     and v_opportunity.slots_proposed = p_slots_proposed then
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'opportunity_id', v_opportunity.id,
      'student_name', v_opportunity.student_name,
      'student_phone', v_opportunity.student_phone,
      'kind', coalesce(v_opportunity.kind, 'TRIAL'),
      'claim_generation', v_opportunity.claim_generation
    );
  end if;
  if v_opportunity.status <> 'CLAIMED'
     or coalesce(v_opportunity.kind, 'TRIAL') <> 'TRIAL'
     or v_opportunity.trial_status not in ('NO_SHOW_STUDENT', 'NO_SHOW_TEACHER')
     or v_opportunity.trial_appointment_id is null
     or coalesce(v_opportunity.conversion_status, 'OPEN') <> 'OPEN' then
    return jsonb_build_object('ok', false, 'error', 'opportunity_not_reopenable');
  end if;

  select appointment.*
    into v_appointment
    from public.appointments as appointment
   where appointment.id = v_opportunity.trial_appointment_id
     and appointment.tenant_id = p_tenant_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'appointment_not_found');
  end if;
  if lower(coalesce(v_appointment.status, '')) not in (
       'scheduled', 'no_show', 'cancelled', 'canceled'
     )
     or lower(coalesce(v_appointment.type, '')) <> 'experimental'
     or coalesce(v_appointment.teacher_id, v_appointment.professor_id)
       is distinct from coalesce(
         v_opportunity.winner_teacher_id,
         v_opportunity.professor_id
       )
     or exists (
       select 1
         from public.class_logs as class_log
        where class_log.appointment_id = v_appointment.id::text
     ) then
    return jsonb_build_object('ok', false, 'error', 'appointment_finalized');
  end if;

  update private.vendor_trial_teacher_requests
     set status = 'CANCELED',
         updated_at = now()
   where tenant_id = p_tenant_id
     and opportunity_id = p_opportunity_id
     and status in ('AWAITING_STUDENT', 'AWAITING_TEACHER');

  update public.appointments
     set status = 'cancelled'
   where id = v_appointment.id
     and lower(coalesce(status, '')) = 'scheduled';

  update public.trial_reschedule_requests
     set status = 'SUPERSEDED', responded_at = now()
   where appointment_id = v_appointment.id
     and status = 'PENDING';

  update public.opportunities
     set slots_proposed = p_slots_proposed,
         status = 'OPEN',
         winner_teacher_id = null,
         professor_id = null,
         accepted_slot = null,
         trial_appointment_id = null,
         trial_status = null,
         conversion_status = 'OPEN',
         opened_at = now(),
         claim_generation = v_opportunity.claim_generation + 1,
         interests = nullif(left(p_interests, 2000), ''),
         preferred_slots = p_preferred_slots
   where id = v_opportunity.id;

  return jsonb_build_object(
    'ok', true,
    'opportunity_id', v_opportunity.id,
    'student_name', v_opportunity.student_name,
    'student_phone', v_opportunity.student_phone,
    'kind', coalesce(v_opportunity.kind, 'TRIAL'),
    'claim_generation', v_opportunity.claim_generation + 1,
    'previous_appointment_id', v_appointment.id,
    'previous_appointment_status', v_appointment.status
  );
end;
$function$;

alter function public.reopen_trial_opportunity_for_broadcast(text, uuid, jsonb, text, jsonb)
  owner to postgres;

revoke all on function public.reopen_trial_opportunity_for_broadcast(text, uuid, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.reopen_trial_opportunity_for_broadcast(text, uuid, jsonb, text, jsonb)
  to service_role;
