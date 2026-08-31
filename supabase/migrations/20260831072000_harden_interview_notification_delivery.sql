begin;

-- Interview notifications used to call the provider inline and then write one
-- shared automation_sent marker for two recipients. Persist one durable queue
-- item per audience instead. The stable tenant/idempotency key makes retries
-- safe and the booking RPC commits the slot and its outbox atomically.

create or replace function private.enqueue_interview_notification_internal(
  p_application_id uuid,
  p_expected_slot timestamptz,
  p_event text,
  p_audience text,
  p_destination text,
  p_message_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_application public.job_applications%rowtype;
  v_event text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_event, '')));
  v_audience text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_audience, '')));
  v_destination text := pg_catalog.regexp_replace(
    coalesce(p_destination, ''),
    '[^0-9]',
    '',
    'g'
  );
  v_message text := pg_catalog.btrim(coalesce(p_message_body, ''));
  v_kind text;
  v_ref_date date;
  v_idempotency_key text;
  v_queue_id uuid;
begin
  if p_application_id is null or p_expected_slot is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'queued', false,
      'duplicate', false,
      'reason', 'notification_binding_missing'
    );
  end if;
  if v_event not in ('BOOKED', 'REMINDER') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'queued', false,
      'duplicate', false,
      'reason', 'invalid_event'
    );
  end if;
  if v_audience not in ('CANDIDATE', 'MANAGEMENT') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'queued', false,
      'duplicate', false,
      'reason', 'invalid_audience'
    );
  end if;
  -- Public candidate intake historically accepted BR numbers with DDD only.
  -- Normalize that persisted format at the durable database boundary so an
  -- otherwise valid booking cannot be rolled back merely for lacking +55.
  if pg_catalog.char_length(v_destination) in (10, 11) then
    v_destination := '55' || v_destination;
  end if;
  if v_destination !~ '^[0-9]{12,15}$' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'queued', false,
      'duplicate', false,
      'reason', 'invalid_destination'
    );
  end if;
  if pg_catalog.char_length(v_message) not between 1 and 4096 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'queued', false,
      'duplicate', false,
      'reason', 'invalid_message'
    );
  end if;

  select application.*
    into v_application
    from public.job_applications as application
   where application.id = p_application_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'queued', false,
      'duplicate', false,
      'reason', 'application_not_found'
    );
  end if;
  if v_application.interview_slot is null
     or v_application.interview_slot is distinct from p_expected_slot then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'queued', false,
      'duplicate', false,
      'reason', 'interview_slot_changed'
    );
  end if;

  v_kind := 'INTERVIEW_' || v_event || '_' || v_audience;
  v_ref_date := (p_expected_slot at time zone 'America/Sao_Paulo')::date;
  v_idempotency_key := pg_catalog.lower(
    'interview:' || v_event || ':' || v_audience || ':' ||
    v_application.id::text || ':' ||
    pg_catalog.floor(extract(epoch from p_expected_slot))::bigint::text
  );

  insert into public.notification_queue (
    tenant_id,
    teacher_id,
    student_id,
    student_name,
    student_phone,
    message_body,
    scheduled_for,
    status,
    attempts,
    next_attempt_at,
    delivery_status,
    notification_kind,
    source_id,
    source_type,
    class_date,
    idempotency_key
  ) values (
    v_application.tenant_id,
    null,
    null,
    case
      when v_audience = 'MANAGEMENT'
        then 'Direção — ' || v_application.name
      else v_application.name
    end,
    v_destination,
    v_message,
    pg_catalog.now(),
    'pending',
    0,
    pg_catalog.now(),
    'queued',
    v_kind,
    v_application.id,
    'job_application',
    v_ref_date,
    v_idempotency_key
  )
  on conflict (tenant_id, idempotency_key)
    where idempotency_key is not null
  do nothing
  returning id into v_queue_id;

  if v_queue_id is null then
    select queue.id
      into v_queue_id
      from public.notification_queue as queue
     where queue.tenant_id = v_application.tenant_id
       and queue.idempotency_key = v_idempotency_key
     limit 1;
    return pg_catalog.jsonb_build_object(
      'ok', v_queue_id is not null,
      'queued', false,
      'duplicate', v_queue_id is not null,
      'reason', case when v_queue_id is null then 'queue_conflict' else 'already_queued' end,
      'queue_id', v_queue_id,
      'notification_kind', v_kind
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'queued', true,
    'duplicate', false,
    'queue_id', v_queue_id,
    'notification_kind', v_kind
  );
end;
$function$;

revoke all on function private.enqueue_interview_notification_internal(
  uuid, timestamptz, text, text, text, text
) from public, anon, authenticated, service_role;

create or replace function public.enqueue_interview_notification(
  p_application_id uuid,
  p_expected_slot timestamptz,
  p_event text,
  p_audience text,
  p_destination text,
  p_message_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  return private.enqueue_interview_notification_internal(
    p_application_id,
    p_expected_slot,
    p_event,
    p_audience,
    p_destination,
    p_message_body
  );
end;
$function$;

revoke all on function public.enqueue_interview_notification(
  uuid, timestamptz, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_interview_notification(
  uuid, timestamptz, text, text, text, text
) to service_role;

create or replace function public.book_interview_slot_with_notifications(
  p_booking_token uuid,
  p_chosen_slot timestamptz,
  p_candidate_message text,
  p_management_phone text default null,
  p_management_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_application public.job_applications%rowtype;
  v_candidate_result jsonb;
  v_management_result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_booking_token is null or p_chosen_slot is null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if p_chosen_slot < pg_catalog.now() + interval '3 hours'
     or p_chosen_slot > pg_catalog.now() + interval '8 days' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'invalid_slot');
  end if;

  select application.*
    into v_application
    from public.job_applications as application
   where application.booking_token = p_booking_token
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_application.interview_slot is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'already_booked',
      'booked', v_application.interview_slot
    );
  end if;

  begin
    update public.job_applications as application
       set interview_slot = p_chosen_slot
     where application.id = v_application.id
       and application.interview_slot is null;
  exception when unique_violation then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'taken');
  end;
  v_application.interview_slot := p_chosen_slot;

  v_candidate_result := private.enqueue_interview_notification_internal(
    v_application.id,
    p_chosen_slot,
    'BOOKED',
    'CANDIDATE',
    v_application.whatsapp,
    p_candidate_message
  );
  v_management_result := private.enqueue_interview_notification_internal(
    v_application.id,
    p_chosen_slot,
    'BOOKED',
    'MANAGEMENT',
    p_management_phone,
    p_management_message
  );

  -- A confirmação só existe se candidato e gestão forem avisados. Retornar
  -- sucesso parcial criava uma entrevista invisível para uma das partes. Uma
  -- falha aqui aborta também o UPDATE do slot, pois tudo vive nesta transação.
  if not coalesce((v_candidate_result ->> 'ok')::boolean, false)
     or not coalesce((v_management_result ->> 'ok')::boolean, false) then
    raise exception using
      errcode = '23514',
      message = 'interview_notification_outbox_required',
      detail = pg_catalog.jsonb_build_object(
        'candidate', v_candidate_result,
        'management', v_management_result
      )::text;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'booked', p_chosen_slot,
    'candidate_notification', v_candidate_result,
    'management_notification', v_management_result
  );
end;
$function$;

revoke all on function public.book_interview_slot_with_notifications(
  uuid, timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.book_interview_slot_with_notifications(
  uuid, timestamptz, text, text, text
) to service_role;

notify pgrst, 'reload schema';

commit;
