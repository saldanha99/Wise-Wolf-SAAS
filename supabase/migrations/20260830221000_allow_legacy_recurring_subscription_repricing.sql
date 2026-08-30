begin;

-- Asaas preserves an installment's own value when the parent subscription is
-- repriced. The v1 repair compared the historical installment with the
-- subscription's current value, which quarantined legitimate old payments.
-- This wrapper changes only that one assumption: it still delegates every
-- webhook, payment, customer, subscription, date, status, tenant and local-row
-- proof to the original fail-closed binder.
create or replace function public.bind_legacy_recurring_student_payment_from_webhook_v2(
  p_provider_event_id text,
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_expected_provider_customer_id text,
  p_expected_provider_subscription_id text,
  p_authoritative_payment jsonb,
  p_authoritative_subscription jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  payment_value numeric;
  current_subscription_value numeric;
  normalized_subscription jsonb;
begin
  if pg_catalog.jsonb_typeof(p_authoritative_payment) <> 'object'
     or pg_catalog.jsonb_typeof(p_authoritative_subscription) <> 'object'
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'legacy_recurring_provider_evidence_invalid'
    );
  end if;

  begin
    payment_value := (p_authoritative_payment ->> 'value')::numeric;
    current_subscription_value :=
      (p_authoritative_subscription ->> 'value')::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'legacy_recurring_provider_evidence_invalid'
      );
  end;

  if payment_value is null
     or payment_value::text in ('NaN', 'Infinity', '-Infinity')
     or payment_value <= 0
     or current_subscription_value is null
     or current_subscription_value::text in (
       'NaN', 'Infinity', '-Infinity'
     )
     or current_subscription_value <= 0
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'legacy_recurring_provider_evidence_invalid'
    );
  end if;

  normalized_subscription := pg_catalog.jsonb_set(
    p_authoritative_subscription,
    '{value}',
    pg_catalog.to_jsonb(payment_value),
    true
  );

  return public.bind_legacy_recurring_student_payment_from_webhook(
    p_provider_event_id,
    p_expected_local_payment_id,
    p_expected_student_id,
    p_expected_tenant_id,
    p_expected_provider_customer_id,
    p_expected_provider_subscription_id,
    p_authoritative_payment,
    normalized_subscription
  );
end;
$function$;

alter function public.bind_legacy_recurring_student_payment_from_webhook_v2(
  text, uuid, uuid, text, text, text, jsonb, jsonb
) owner to postgres;
revoke all on function public.bind_legacy_recurring_student_payment_from_webhook_v2(
  text, uuid, uuid, text, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.bind_legacy_recurring_student_payment_from_webhook_v2(
  text, uuid, uuid, text, text, text, jsonb, jsonb
) to service_role;

-- PostgREST caches function signatures. Reload it in the same transaction so
-- the Edge Function can use the new, service-only RPC immediately after the
-- migration is committed.
notify pgrst, 'reload schema';

-- The v2 wrapper is now the only service entry point. The original remains an
-- owner-only implementation detail so its complete validation is reused
-- without exposing two competing repair contracts.
revoke all on function public.bind_legacy_recurring_student_payment_from_webhook(
  text, uuid, uuid, text, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;

do $postcheck$
begin
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.bind_legacy_recurring_student_payment_from_webhook_v2(text,uuid,uuid,text,text,text,jsonb,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.bind_legacy_recurring_student_payment_from_webhook_v2(text,uuid,uuid,text,text,text,jsonb,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.bind_legacy_recurring_student_payment_from_webhook(text,uuid,uuid,text,text,text,jsonb,jsonb)',
       'EXECUTE'
     )
  then
    raise exception 'legacy recurring repricing repair ACL is invalid';
  end if;
end;
$postcheck$;

commit;
