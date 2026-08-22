-- O aceite de oportunidade e uma unica transacao. O cliente informa somente o
-- ID opaco e a geracao do link; tenant, horario, tipo e dados do lead sao
-- sempre derivados do banco.

do $guard$
begin
  if to_regclass('public.opportunities') is null
     or to_regclass('public.appointments') is null
     or to_regclass('public.bookings') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.tenant_memberships') is null
     or to_regclass('public.tenants') is null
     or to_regprocedure('public.dow_name_to_int(text)') is null then
    raise exception 'atomic_opportunity_claim_dependencies_are_required';
  end if;
end
$guard$;

drop function if exists public.claim_opportunity_atomic(uuid, uuid);
drop function if exists public.claim_opportunity_atomic(uuid, uuid, jsonb);
drop function if exists public.claim_opportunity_atomic(uuid, uuid, text);

create or replace function public.claim_opportunity_atomic(
  p_opportunity_id uuid,
  p_teacher_id uuid,
  p_claim_generation integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_opportunity public.opportunities%rowtype;
  v_existing_appointment public.appointments%rowtype;
  v_appointment_id uuid;
  v_slot jsonb;
  v_slot_date date;
  v_slot_time time without time zone;
  v_start_time timestamptz;
  v_kind text;
  v_teacher_name text;
begin
  if p_opportunity_id is null or p_teacher_id is null
     or p_claim_generation is null or p_claim_generation < 1 then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  select opportunity.*
    into v_opportunity
    from public.opportunities as opportunity
   where opportunity.id = p_opportunity_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'opportunity_not_found');
  end if;
  if v_opportunity.tenant_id is null then
    return jsonb_build_object('ok', false, 'error', 'opportunity_inconsistent');
  end if;
  if v_opportunity.claim_generation is distinct from p_claim_generation then
    return jsonb_build_object('ok', false, 'error', 'claim_link_expired');
  end if;

  if not exists (
    select 1
      from public.tenants as tenant
     where tenant.id = v_opportunity.tenant_id
       and lower(trim(coalesce(tenant.saas_status, ''))) in (
         'active', 'trial', 'trialing'
       )
  ) then
    return jsonb_build_object('ok', false, 'error', 'tenant_not_operational');
  end if;

  select profile.full_name
    into v_teacher_name
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = v_opportunity.tenant_id
     and membership.role = 'TEACHER'
     and membership.status = 'ACTIVE'
   where profile.id = p_teacher_id
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active';

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'teacher_not_active_for_tenant'
    );
  end if;

  v_kind := upper(coalesce(v_opportunity.kind, 'TRIAL'));
  if v_kind not in ('TRIAL', 'TRAINING') then
    return jsonb_build_object('ok', false, 'error', 'invalid_opportunity_kind');
  end if;

  -- Serializa tambem claims de oportunidades diferentes pelo mesmo professor.
  -- Sem isto, duas transacoes poderiam enxergar a agenda livre ao mesmo tempo.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_teacher_id::text, 0)
  );

  -- Retry do vencedor devolve exatamente o vinculo ja persistido e nao cria
  -- outro appointment nem repete efeitos externos.
  if v_opportunity.winner_teacher_id = p_teacher_id
     and v_opportunity.trial_appointment_id is not null then
    select appointment.*
      into v_existing_appointment
      from public.appointments as appointment
     where appointment.id = v_opportunity.trial_appointment_id
       and appointment.tenant_id = v_opportunity.tenant_id
       and (
         appointment.teacher_id = p_teacher_id
         or appointment.professor_id = p_teacher_id
       );

    if not found then
      return jsonb_build_object('ok', false, 'error', 'opportunity_inconsistent');
    end if;

    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'opportunityId', v_opportunity.id,
      'appointmentId', v_existing_appointment.id,
      'tenantId', v_opportunity.tenant_id,
      'kind', v_kind,
      'studentName', v_opportunity.student_name,
      'studentPhone', v_opportunity.student_phone,
      'startTime', v_existing_appointment.start_time,
      'teacherName', coalesce(nullif(trim(v_teacher_name), ''), 'Professor(a)')
    );
  end if;

  if upper(coalesce(v_opportunity.status, '')) <> 'OPEN' then
    return jsonb_build_object(
      'ok', false,
      'error', case
        when v_opportunity.winner_teacher_id is not null
          then 'opportunity_already_claimed'
        else 'opportunity_not_open'
      end
    );
  end if;
  if v_opportunity.winner_teacher_id is not null
     or v_opportunity.professor_id is not null
     or v_opportunity.trial_appointment_id is not null then
    return jsonb_build_object('ok', false, 'error', 'opportunity_inconsistent');
  end if;

  if jsonb_typeof(v_opportunity.slots_proposed) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'invalid_opportunity_slot');
  end if;
  if jsonb_array_length(v_opportunity.slots_proposed) <> 1 then
    return jsonb_build_object('ok', false, 'error', 'invalid_opportunity_slot');
  end if;
  v_slot := v_opportunity.slots_proposed -> 0;
  if coalesce(v_slot ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or coalesce(v_slot ->> 'time', '') !~ '^(?:[01]\d|2[0-3]):[0-5]\d$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_opportunity_slot');
  end if;

  begin
    v_slot_date := (v_slot ->> 'date')::date;
    v_slot_time := (v_slot ->> 'time')::time;
  exception
    when datetime_field_overflow or invalid_datetime_format then
      return jsonb_build_object('ok', false, 'error', 'invalid_opportunity_slot');
  end;

  v_start_time := (v_slot_date + v_slot_time) at time zone 'America/Sao_Paulo';
  if v_start_time <= pg_catalog.now() then
    return jsonb_build_object('ok', false, 'error', 'opportunity_slot_expired');
  end if;
  if v_start_time > pg_catalog.now() + interval '366 days' then
    return jsonb_build_object('ok', false, 'error', 'opportunity_slot_too_far');
  end if;

  if exists (
    select 1
      from public.appointments as appointment
     where appointment.tenant_id = v_opportunity.tenant_id
       and (
         appointment.teacher_id = p_teacher_id
         or appointment.professor_id = p_teacher_id
       )
       and lower(coalesce(appointment.status, '')) in ('scheduled', 'confirmed')
       and appointment.start_time > v_start_time - interval '30 minutes'
       and appointment.start_time < v_start_time + interval '30 minutes'
  ) or exists (
    select 1
      from public.bookings as booking
     where booking.tenant_id = v_opportunity.tenant_id
       and booking.teacher_id = p_teacher_id
       and lower(coalesce(booking.status, 'scheduled')) not in (
         'cancelled', 'canceled', 'inactive'
       )
       and public.dow_name_to_int(booking.day_of_week) =
         extract(dow from v_slot_date)::integer
       and (booking.date is null or booking.date = v_slot_date)
       and case
         when trim(coalesce(booking.time_slot, '')) ~
              '^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$'
         then abs(extract(epoch from (
           left(trim(booking.time_slot), 5)::time - v_slot_time
         ))) < 1800
         else false
       end
  ) then
    return jsonb_build_object('ok', false, 'error', 'teacher_schedule_conflict');
  end if;

  insert into public.appointments (
    tenant_id,
    teacher_id,
    professor_id,
    student_name,
    student_phone,
    start_time,
    status,
    type
  ) values (
    v_opportunity.tenant_id,
    p_teacher_id,
    p_teacher_id,
    v_opportunity.student_name,
    v_opportunity.student_phone,
    v_start_time,
    'scheduled',
    case when v_kind = 'TRAINING' then 'training' else 'experimental' end
  )
  returning id into v_appointment_id;

  update public.opportunities
     set status = 'CLAIMED',
         winner_teacher_id = p_teacher_id,
         professor_id = p_teacher_id,
         accepted_slot = v_slot,
         trial_appointment_id = v_appointment_id,
         trial_status = 'SCHEDULED',
         conversion_status = 'OPEN'
   where id = v_opportunity.id
     and upper(coalesce(status, '')) = 'OPEN';

  if not found then
    raise exception 'atomic_opportunity_claim_lost_lock'
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'opportunityId', v_opportunity.id,
    'appointmentId', v_appointment_id,
    'tenantId', v_opportunity.tenant_id,
    'kind', v_kind,
    'studentName', v_opportunity.student_name,
    'studentPhone', v_opportunity.student_phone,
    'startTime', v_start_time,
    'teacherName', coalesce(nullif(trim(v_teacher_name), ''), 'Professor(a)')
  );
end;
$function$;

alter function public.claim_opportunity_atomic(uuid, uuid, integer) owner to postgres;

revoke all on function public.claim_opportunity_atomic(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_opportunity_atomic(uuid, uuid, integer)
  to service_role;
