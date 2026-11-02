-- A régua financeira marca SUBMITTING antes do POST externo. Quando o teto
-- local barra o envio, porém, nenhum POST aconteceu: a claim deve ser adiada,
-- não finalizada como FAILED. Somente service_role pode liberar essa claim.
create or replace function public.defer_asaas_outbound_message_claim(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_retry_after_seconds integer,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attempt public.asaas_outbound_message_attempts%rowtype;
  v_retry integer := greatest(60, least(coalesce(p_retry_after_seconds, 60), 86400));
begin
  select attempt.* into v_attempt
    from public.asaas_outbound_message_attempts as attempt
   where attempt.id = p_attempt_id
   for update;

  if not found or v_attempt.claim_token is distinct from p_claim_token then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  if v_attempt.status <> 'CLAIMED' or v_attempt.submit_attempt_count <> 0 then
    return jsonb_build_object('ok', false, 'reason', 'submit_already_started');
  end if;

  update public.asaas_outbound_message_attempts
     set lease_expires_at = now() + pg_catalog.make_interval(secs => v_retry),
         provider_http_status = 429,
         last_error = nullif(pg_catalog.left(coalesce(p_reason, ''), 500), ''),
         updated_at = now()
   where id = p_attempt_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'CLAIMED',
    'retry_after_seconds', v_retry
  );
end;
$function$;

alter function public.defer_asaas_outbound_message_claim(uuid, uuid, integer, text)
  owner to postgres;
revoke all on function public.defer_asaas_outbound_message_claim(uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.defer_asaas_outbound_message_claim(uuid, uuid, integer, text)
  to service_role;

-- Reabre apenas rejeições 429 comprovadamente anteriores ao POST do provedor.
-- A versão que criou essas linhas usava 429 exclusivamente para o teto local;
-- uma resposta 429 do provedor era registrada como UNKNOWN, nunca FAILED.
create or replace function public.requeue_preflight_throttled_financial_message(
  p_attempt_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attempt public.asaas_outbound_message_attempts%rowtype;
begin
  select attempt.* into v_attempt
    from public.asaas_outbound_message_attempts as attempt
   where attempt.id = p_attempt_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'attempt_not_found');
  end if;
  if v_attempt.status <> 'FAILED'
     or v_attempt.provider_http_status <> 429
     or v_attempt.submit_attempt_count <> 1
     or v_attempt.provider_message_id is not null
     or v_attempt.last_error is distinct from 'provider_delivery_rejected'
  then
    return jsonb_build_object('ok', false, 'reason', 'not_proven_preflight_throttle');
  end if;
  if not exists (
    select 1
      from public.profiles as profile
     where profile.id = v_attempt.student_id
       and profile.tenant_id = v_attempt.tenant_id
       and profile.role = 'STUDENT'
       and profile.status not in ('Inativo','INACTIVE','Inactive','Arquivado','Cancelado','Trancado')
       and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
       and coalesce(profile.status_financial, '') <> 'ARCHIVED'
       and (
         exists (
           select 1 from public.bookings as booking
            where booking.tenant_id = profile.tenant_id
              and booking.student_id = profile.id
              and booking.status = 'SCHEDULED'
         )
         or exists (
           select 1 from public.class_logs as lesson
            where lesson.tenant_id = profile.tenant_id
              and lesson.student_id = profile.id
              and lesson.class_date >= current_date - 30
         )
       )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'student_not_current');
  end if;
  if not exists (
    select 1
      from public.student_payments as payment
     where payment.id::text = v_attempt.provider_entity_id
       and payment.tenant_id = v_attempt.tenant_id
       and payment.student_id = v_attempt.student_id
       and payment.status in ('PENDING','OVERDUE','DUNNING_REQUESTED')
       and payment.due_date < current_date
  ) then
    return jsonb_build_object('ok', false, 'reason', 'payment_not_open_overdue');
  end if;

  update public.asaas_outbound_message_attempts
     set status = 'CLAIMED',
         submit_attempt_count = 0,
         lease_expires_at = now() - interval '1 second',
         provider_http_status = null,
         last_error = nullif(pg_catalog.left(coalesce(p_reason, ''), 500), ''),
         updated_at = now()
   where id = p_attempt_id;

  return jsonb_build_object('ok', true, 'status', 'CLAIMED');
end;
$function$;

alter function public.requeue_preflight_throttled_financial_message(uuid, text)
  owner to postgres;
revoke all on function public.requeue_preflight_throttled_financial_message(uuid, text)
  from public, anon, authenticated;
grant execute on function public.requeue_preflight_throttled_financial_message(uuid, text)
  to service_role;
