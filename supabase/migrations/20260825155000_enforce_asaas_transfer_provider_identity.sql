-- A persisted Asaas transfer id is the immutable provider identity. Once it
-- exists, reconciliation may update status but must never adopt another id
-- discovered through externalReference or a malformed provider response.

create or replace function public.record_asaas_teacher_transfer_state(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_transfer_id text default null,
  p_provider_status text default null,
  p_http_status integer default null,
  p_error text default null,
  p_provider_response jsonb default null,
  p_destination_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_teacher_transfer_attempts%rowtype;
  attempt_closing_id uuid;
  normalized_status text := upper(trim(coalesce(p_status, '')));
  normalized_provider_transfer_id text := nullif(
    trim(coalesce(p_provider_transfer_id, '')),
    ''
  );
  attempt_provider_transfer_id text;
  closing_provider_transfer_id text;
  persisted_provider_transfer_id text;
  effective_provider_transfer_id text;
  closing_status text;
  closing_update_count integer := 0;
  teacher_nf_exempt boolean := false;
begin
  if normalized_status not in ('SUBMITTED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'BLOCKED') then
    raise exception using errcode = '22023', message = 'invalid_transfer_attempt_status';
  end if;

  if p_provider_transfer_id is not null
     and normalized_provider_transfer_id is null
  then
    return jsonb_build_object('ok', false, 'reason', 'provider_transfer_id_invalid');
  end if;

  select attempt.closing_id into attempt_closing_id
    from public.asaas_teacher_transfer_attempts as attempt
   where attempt.id = p_attempt_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  -- The claim RPC locks the closing before the attempt. Keep the same lock
  -- order here so reconciliation cannot deadlock against a concurrent claim.
  select
    nullif(trim(coalesce(closing.asaas_transfer_id, '')), ''),
    coalesce(teacher.nf_exempt, false)
    into closing_provider_transfer_id, teacher_nf_exempt
    from public.teacher_closings as closing
    join public.profiles as teacher on teacher.id = closing.teacher_id
   where closing.id = attempt_closing_id
   for update of closing;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'closing_not_found');
  end if;

  select attempt.* into attempt_row
    from public.asaas_teacher_transfer_attempts as attempt
   where attempt.id = p_attempt_id
     and attempt.closing_id = attempt_closing_id
   for update;
  if not found or attempt_row.claim_token is distinct from p_claim_token then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  attempt_provider_transfer_id := nullif(
    trim(coalesce(attempt_row.provider_transfer_id, '')),
    ''
  );

  if attempt_provider_transfer_id is not null
     and closing_provider_transfer_id is not null
     and attempt_provider_transfer_id is distinct from closing_provider_transfer_id
  then
    insert into public.asaas_reconciliation_issues (
      tenant_id, source, kind, severity, provider_entity_id,
      local_entity_id, fingerprint, details
    ) values (
      attempt_row.tenant_id,
      'TRANSFER',
      'TEACHER_TRANSFER_PROVIDER_ID_MISMATCH',
      'CRITICAL',
      attempt_provider_transfer_id,
      attempt_row.closing_id::text,
      'teacher-transfer:' || attempt_row.id::text || ':provider-id-mismatch',
      jsonb_build_object(
        'attemptId', attempt_row.id,
        'externalReference', attempt_row.external_reference,
        'attemptProviderTransferId', attempt_provider_transfer_id,
        'closingProviderTransferId', closing_provider_transfer_id,
        'incomingProviderTransferId', normalized_provider_transfer_id
      )
    ) on conflict do nothing;

    return jsonb_build_object(
      'ok', false,
      'reason', 'closing_provider_transfer_id_mismatch',
      'status', attempt_row.status
    );
  end if;

  persisted_provider_transfer_id := coalesce(
    attempt_provider_transfer_id,
    closing_provider_transfer_id
  );
  if persisted_provider_transfer_id is not null
     and normalized_provider_transfer_id is not null
     and normalized_provider_transfer_id is distinct from persisted_provider_transfer_id
  then
    return jsonb_build_object(
      'ok', false,
      'reason', 'provider_transfer_id_mismatch',
      'status', attempt_row.status
    );
  end if;
  effective_provider_transfer_id := coalesce(
    persisted_provider_transfer_id,
    normalized_provider_transfer_id
  );

  if normalized_status in ('SUBMITTED', 'COMPLETED')
     and effective_provider_transfer_id is null
  then
    return jsonb_build_object(
      'ok', false,
      'reason', 'provider_transfer_id_required',
      'status', attempt_row.status
    );
  end if;

  if attempt_row.status = 'COMPLETED' and normalized_status <> 'COMPLETED' then
    return jsonb_build_object('ok', true, 'status', 'COMPLETED', 'ignored_regression', true);
  end if;

  if normalized_status in ('SUBMITTED', 'COMPLETED')
     and p_destination_fingerprint is null
  then
    return jsonb_build_object(
      'ok', false,
      'reason', 'provider_destination_fingerprint_required',
      'status', attempt_row.status
    );
  end if;

  if p_destination_fingerprint is not null
     and attempt_row.destination_fingerprint is distinct from p_destination_fingerprint
  then
    return jsonb_build_object('ok', false, 'reason', 'destination_snapshot_mismatch');
  end if;

  update public.asaas_teacher_transfer_attempts
     set status = normalized_status,
         provider_transfer_id = effective_provider_transfer_id,
         provider_status = coalesce(p_provider_status, provider_status),
         last_http_status = p_http_status,
         last_error = nullif(left(coalesce(p_error, ''), 500), ''),
         provider_response = coalesce(p_provider_response, provider_response),
         submit_attempt_count = case
           when attempt_row.status = 'CLAIMED' and normalized_status in ('SUBMITTED', 'COMPLETED', 'UNKNOWN', 'FAILED')
             then 1
           else submit_attempt_count
         end,
         reconciliation_count = reconciliation_count + case
           when attempt_row.status in ('SUBMITTED', 'UNKNOWN') then 1 else 0 end,
         submitted_at = case
           when normalized_status in ('SUBMITTED', 'COMPLETED') then coalesce(submitted_at, now())
           else submitted_at
         end,
         reconciled_at = case
           when attempt_row.status in ('SUBMITTED', 'UNKNOWN') then now()
           else reconciled_at
         end,
         completed_at = case when normalized_status = 'COMPLETED' then now() else completed_at end,
         updated_at = now()
   where id = p_attempt_id;

  if normalized_status in ('SUBMITTED', 'COMPLETED')
     and effective_provider_transfer_id is not null
  then
    closing_status := case
      when normalized_status = 'COMPLETED' then
        case when teacher_nf_exempt
          then 'PAGO' else 'PAID_WAITING_NF' end
      else 'UNDER_REVIEW'
    end;

    update public.teacher_closings as closing
       set asaas_transfer_id = effective_provider_transfer_id,
           transfer_status = coalesce(p_provider_status, normalized_status),
           status = closing_status,
           paid_at = case when normalized_status = 'COMPLETED' then coalesce(closing.paid_at, now()) else closing.paid_at end,
           updated_at = now()
     where closing.id = attempt_row.closing_id
       and (
         closing.asaas_transfer_id is null
         or closing.asaas_transfer_id = effective_provider_transfer_id
       );

    get diagnostics closing_update_count = row_count;
    if closing_update_count <> 1 then
      raise exception 'teacher_closing_transfer_update_failed';
    end if;
  end if;

  if normalized_status in ('UNKNOWN', 'FAILED', 'BLOCKED') then
    insert into public.asaas_reconciliation_issues (
      tenant_id, source, kind, severity, provider_entity_id,
      local_entity_id, fingerprint, details
    ) values (
      attempt_row.tenant_id,
      'TRANSFER',
      'TEACHER_TRANSFER_' || normalized_status,
      case when normalized_status = 'UNKNOWN' then 'CRITICAL' else 'HIGH' end,
      effective_provider_transfer_id,
      attempt_row.closing_id::text,
      'teacher-transfer:' || attempt_row.id::text || ':' || normalized_status,
      jsonb_build_object(
        'attemptId', attempt_row.id,
        'externalReference', attempt_row.external_reference,
        'httpStatus', p_http_status,
        'error', left(coalesce(p_error, 'unknown'), 500)
      )
    ) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', normalized_status,
    'provider_transfer_id', effective_provider_transfer_id
  );
end;
$function$;

revoke all on function public.record_asaas_teacher_transfer_state(
  uuid, uuid, text, text, text, integer, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_asaas_teacher_transfer_state(
  uuid, uuid, text, text, text, integer, text, jsonb, text
) to service_role;

do $postcheck$
declare
  definition text := pg_get_functiondef(
    'public.record_asaas_teacher_transfer_state(uuid,uuid,text,text,text,integer,text,jsonb,text)'::regprocedure
  );
begin
  if position('provider_transfer_id_mismatch' in definition) = 0
     or position('closing_provider_transfer_id_mismatch' in definition) = 0
     or position('TEACHER_TRANSFER_PROVIDER_ID_MISMATCH' in definition) = 0
     or position('provider_transfer_id_required' in definition) = 0
     or position('effective_provider_transfer_id' in definition) = 0
  then
    raise exception 'asaas_transfer_provider_identity_guard_missing';
  end if;
end
$postcheck$;
