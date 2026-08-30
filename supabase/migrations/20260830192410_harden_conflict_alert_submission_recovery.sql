begin;

-- A previously applied migration defines the durable notification recovery
-- fence. Keep its checksum immutable and add this conflict-alert retry
-- hardening as a new migration.
create or replace function public.recover_notification_delivery_submission(
  p_notification_id uuid,
  p_notification_claim_token uuid,
  p_outbound_attempt_id uuid,
  p_outbound_claim_token uuid,
  p_provider_instance_name text,
  p_integration_id uuid,
  p_integration_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.notification_queue%rowtype;
  v_outbound public.asaas_outbound_message_attempts%rowtype;
  v_instance_name text := pg_catalog.btrim(coalesce(
    p_provider_instance_name,
    ''
  ));
  v_is_payment boolean;
begin
  if p_notification_id is null
     or p_notification_claim_token is null
     or p_integration_id is null
     or coalesce(p_integration_version, 0) < 1
     or char_length(v_instance_name) not between 3 and 120 then
    raise exception 'invalid_notification_submission_recovery'
      using errcode = '22023';
  end if;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'notification_not_found'
    );
  end if;

  v_is_payment := private.canonical_payment_notification_kind(
    v_notification.notification_kind
  ) = 'PAYMENT_CONFIRMED_WHATSAPP';

  if v_notification.claim_token is null
     and v_notification.status = 'skipped'
     and v_notification.last_error = 'occurrence_already_notified' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'ALREADY_NOTIFIED',
      'reason', v_notification.last_error
    );
  end if;

  if v_is_payment and p_outbound_attempt_id is not null then
    select outbound.*
    into v_outbound
    from public.asaas_outbound_message_attempts as outbound
    where outbound.id = p_outbound_attempt_id
      and outbound.claim_token = p_outbound_claim_token;

    if found
       and v_notification.claim_token is null
       and v_notification.status = 'skipped'
       and v_outbound.status = 'SUPPRESSED'
       and v_outbound.notification_queue_id = v_notification.id then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'SUPPRESSED',
        'reason', coalesce(
          v_notification.last_error,
          v_outbound.last_error,
          'payment_confirmation_suppressed'
        )
      );
    end if;
  end if;

  if v_notification.claim_token is distinct from
       p_notification_claim_token
     or v_notification.status <> 'processing' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'notification_claim_changed'
    );
  end if;

  if v_notification.delivery_status = 'preparing' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY_BEGIN',
      'reason', 'notification_begin_not_committed'
    );
  end if;

  if v_notification.delivery_status <> 'submitting'
     or v_notification.lease_expires_at <= now()
     or lower(coalesce(v_notification.provider_instance_name, '')) <>
       lower(v_instance_name)
     or v_notification.provider_destination is null
     or v_notification.provider_integration_id <> p_integration_id
     or v_notification.provider_integration_version <>
       p_integration_version then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'notification_submission_snapshot_changed'
    );
  end if;


  -- Reuse the exact idempotent begin authorization after all begin responses
  -- are lost. Its stored destination/message arguments force the conflict
  -- branch to lock and revalidate the current source before any provider POST.
  if upper(pg_catalog.btrim(coalesce(
       v_notification.notification_kind,
       ''
     ))) = 'CONFLICT_TEACHER_ALERT' then
    return public.begin_notification_delivery_submission(
      v_notification.id,
      p_notification_claim_token,
      v_instance_name,
      v_notification.student_phone,
      v_notification.provider_destination,
      v_notification.message_body,
      p_integration_id,
      p_integration_version
    );
  end if;

  if v_is_payment then
    if p_outbound_attempt_id is null or p_outbound_claim_token is null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'payment_submission_claim_missing'
      );
    end if;

    select outbound.*
    into v_outbound
    from public.asaas_outbound_message_attempts as outbound
    where outbound.id = p_outbound_attempt_id
      and outbound.claim_token = p_outbound_claim_token
      and outbound.notification_queue_id = v_notification.id;

    if not found
       or v_outbound.status <> 'SUBMITTING'
       or v_outbound.submit_attempt_count <> 1
       or v_outbound.lease_expires_at <= now()
       or lower(coalesce(v_outbound.provider_instance_name, '')) <>
         lower(v_instance_name)
       or v_outbound.provider_destination is distinct from
         v_notification.provider_destination then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'payment_submission_snapshot_changed'
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'SUBMITTING',
      'providerDestination', v_notification.provider_destination,
      'messageBody', v_notification.message_body
    );
  end if;

  if p_outbound_attempt_id is not null
     or p_outbound_claim_token is not null
     or (
       upper(pg_catalog.btrim(coalesce(
         v_notification.notification_kind,
         ''
       ))) = 'LESSON_REMINDER'
       and not exists (
         select 1
         from public.automation_sent as receipt
         where receipt.notification_id = v_notification.id
           and receipt.notification_claim_token =
             p_notification_claim_token
           and receipt.receipt_state = 'SEALED'
       )
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'generic_submission_receipt_changed'
    );
  end if;

  if upper(pg_catalog.btrim(coalesce(
       v_notification.notification_kind,
       ''
     ))) = 'CONFLICT_TEACHER_ALERT' then
    -- Reuse the exact locked authorization path. The begin RPC recognizes the
    -- sealed snapshot as an idempotent replay and does not mutate it, but it
    -- does re-lock and revalidate the conflict before authorizing the POST.
    return public.begin_notification_delivery_submission(
      v_notification.id,
      p_notification_claim_token,
      v_instance_name,
      v_notification.student_phone,
      v_notification.provider_destination,
      v_notification.message_body,
      p_integration_id,
      p_integration_version
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_AUTHORIZED',
    'providerDestination', v_notification.provider_destination,
    'messageBody', v_notification.message_body
  );
end;
$function$;

alter function public.recover_notification_delivery_submission(
  uuid,uuid,uuid,uuid,text,uuid,bigint
) owner to postgres;
revoke all on function public.recover_notification_delivery_submission(
  uuid,uuid,uuid,uuid,text,uuid,bigint
) from public, anon, authenticated, service_role;
grant execute on function public.recover_notification_delivery_submission(
  uuid,uuid,uuid,uuid,text,uuid,bigint
) to service_role;

commit;
