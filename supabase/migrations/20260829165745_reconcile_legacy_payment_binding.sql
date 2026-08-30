begin;

-- Legacy rows created before provider_customer_id was captured must remain
-- fail-closed unless one exact, already-authenticated Asaas event proves the
-- same payment/customer/value and the current tenant binding corroborates it.
create or replace function public.bind_legacy_student_payment_from_webhook(
  p_provider_event_id text,
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_expected_provider_customer_id text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_event_id text := nullif(pg_catalog.btrim(coalesce(p_provider_event_id, '')), '');
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_expected_tenant_id, '')), '');
  normalized_customer text := nullif(pg_catalog.btrim(coalesce(p_expected_provider_customer_id, '')), '');
  inbox_row public.asaas_webhook_inbox%rowtype;
  payment_row public.student_payments%rowtype;
  profile_row public.profiles%rowtype;
  provider_payment_id text;
  provider_customer_id text;
  provider_subscription_id text;
  provider_external_reference text;
  provider_event_name text;
  payload_event_id text;
  provider_payment_status text;
  provider_value numeric;
  provider_due_date date;
  enrollment_offer_id uuid;
begin
  if normalized_event_id is null
     or pg_catalog.length(normalized_event_id) > 240
     or p_expected_local_payment_id is null
     or p_expected_student_id is null
     or normalized_tenant is null
     or normalized_customer is null
     or pg_catalog.length(normalized_customer) > 240
     or p_payload is null
     or pg_catalog.jsonb_typeof(p_payload) <> 'object'
  then
    raise exception using
      errcode = '22023',
      message = 'legacy_payment_binding_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legacy-payment-binding:' || normalized_tenant || ':' ||
        p_expected_local_payment_id::text,
      0
    )
  );

  select inbox.*
    into inbox_row
    from public.asaas_webhook_inbox as inbox
   where inbox.provider_event_id = normalized_event_id
   for update;

  if not found
     or inbox_row.status not in ('PROCESSING', 'TRIAGE', 'RETRY')
     or inbox_row.event_name not in (
       'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH'
     )
     or inbox_row.payload is distinct from p_payload
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'trusted_webhook_evidence_missing'
    );
  end if;

  provider_event_name := nullif(pg_catalog.btrim(p_payload ->> 'event'), '');
  payload_event_id := nullif(pg_catalog.btrim(p_payload ->> 'id'), '');
  provider_payment_id := nullif(
    pg_catalog.btrim(p_payload #>> '{payment,id}'),
    ''
  );
  provider_customer_id := nullif(
    pg_catalog.btrim(p_payload #>> '{payment,customer}'),
    ''
  );
  provider_subscription_id := nullif(
    pg_catalog.btrim(p_payload #>> '{payment,subscription}'),
    ''
  );
  provider_external_reference := nullif(
    pg_catalog.btrim(p_payload #>> '{payment,externalReference}'),
    ''
  );
  provider_payment_status := upper(nullif(
    pg_catalog.btrim(p_payload #>> '{payment,status}'),
    ''
  ));

  begin
    provider_value := (p_payload #>> '{payment,value}')::numeric;
    provider_due_date := (p_payload #>> '{payment,dueDate}')::date;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'provider_payment_evidence_invalid'
      );
  end;

  if payload_event_id is distinct from normalized_event_id
     or provider_event_name is distinct from inbox_row.event_name
     or provider_payment_id is distinct from inbox_row.provider_entity_id
     or provider_customer_id is distinct from normalized_customer
     or provider_payment_status is distinct from (
       case inbox_row.event_name
         when 'PAYMENT_RECEIVED' then 'RECEIVED'
         when 'PAYMENT_RECEIVED_IN_CASH' then 'RECEIVED_IN_CASH'
         else null
       end
     )
     or provider_value is null
     or provider_value::text in ('NaN', 'Infinity', '-Infinity')
     or provider_value <= 0
     or provider_due_date is null
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'provider_payment_evidence_mismatch'
    );
  end if;

  select payment.*
    into payment_row
    from public.student_payments as payment
   where payment.id = p_expected_local_payment_id
     and payment.asaas_payment_id = provider_payment_id
   for update;

  if not found
     or payment_row.student_id is distinct from p_expected_student_id
     or payment_row.tenant_id is distinct from normalized_tenant
     or payment_row.provider_customer_id is not null
     or pg_catalog.round(coalesce(payment_row.value, 0), 2)
          is distinct from pg_catalog.round(provider_value, 2)
     or payment_row.due_date is distinct from provider_due_date
     or upper(pg_catalog.btrim(coalesce(payment_row.status, ''))) not in (
       'PENDING', 'OVERDUE', 'CONFIRMED'
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'local_payment_binding_not_repairable'
    );
  end if;

  select profile.*
    into profile_row
    from public.profiles as profile
   where profile.id = p_expected_student_id
     and profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
     and coalesce(profile.is_test_account, false) is false
     and nullif(pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')), '') =
           normalized_customer
   for update;

  if not found
     or (
       provider_subscription_id is not null
       and nullif(pg_catalog.btrim(coalesce(profile_row.subscription_id, '')), '')
            is distinct from provider_subscription_id
     )
     or (
       select pg_catalog.count(*)
         from public.tenant_memberships as membership
        where membership.user_id = p_expected_student_id
     ) <> 1
     or not exists (
       select 1
         from public.tenant_memberships as membership
        where membership.user_id = p_expected_student_id
          and membership.tenant_id = normalized_tenant
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'current_student_binding_not_corroborated'
    );
  end if;

  -- New enrollment references are independently tied to the consumed offer.
  -- Unknown reference formats remain fail-closed instead of being guessed.
  if provider_external_reference is null
     or provider_external_reference !~
       '^enrollment:[0-9a-fA-F-]{36}:subscription$'
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'provider_reference_not_repairable'
    );
  end if;

  begin
    enrollment_offer_id := pg_catalog.split_part(
      provider_external_reference,
      ':',
      2
    )::uuid;
  exception
    when invalid_text_representation then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'provider_reference_invalid'
      );
  end;

  if not exists (
    select 1
      from public.offers as offer
     where offer.id = enrollment_offer_id
       and offer.tenant_id = normalized_tenant
       and offer.kind = 'ENROLLMENT'
       and offer.consumed_by = p_expected_student_id
       and offer.processing_state = 'COMPLETED'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'enrollment_reference_not_corroborated'
    );
  end if;

  update public.student_payments as target
     set provider_customer_id = normalized_customer,
         updated_at = pg_catalog.now()
   where target.id = payment_row.id
     and target.provider_customer_id is null;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'payment_binding_changed_concurrently'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'BOUND',
    'payment_id', payment_row.id,
    'tenant_id', normalized_tenant,
    'student_id', p_expected_student_id
  );
end;
$function$;

alter function public.bind_legacy_student_payment_from_webhook(
  text, uuid, uuid, text, text, jsonb
) owner to postgres;
revoke all on function public.bind_legacy_student_payment_from_webhook(
  text, uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.bind_legacy_student_payment_from_webhook(
  text, uuid, uuid, text, text, jsonb
) to service_role;

-- A TRIAGE row never reopens merely because Asaas redelivers it. Requeue is a
-- separate, exact service-only act, after an operator has re-read the provider
-- payment and confirmed the identifiers used above.
create or replace function public.requeue_legacy_student_payment_binding_event(
  p_provider_event_id text,
  p_expected_local_payment_id uuid,
  p_expected_provider_payment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_event_id text := nullif(pg_catalog.btrim(coalesce(p_provider_event_id, '')), '');
  normalized_payment_id text := nullif(pg_catalog.btrim(coalesce(p_expected_provider_payment_id, '')), '');
  inbox_row public.asaas_webhook_inbox%rowtype;
begin
  if normalized_event_id is null
     or normalized_payment_id is null
     or p_expected_local_payment_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'legacy_payment_requeue_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legacy-payment-requeue:' || normalized_event_id,
      0
    )
  );

  select inbox.*
    into inbox_row
    from public.asaas_webhook_inbox as inbox
   where inbox.provider_event_id = normalized_event_id
   for update;

  if not found
     or inbox_row.status <> 'TRIAGE'
     or inbox_row.last_error <> 'inactive_settlement_local_binding_incomplete'
     or inbox_row.provider_entity_id <> normalized_payment_id
     or inbox_row.event_name not in (
       'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH'
     )
     or not exists (
       select 1
         from public.student_payments as payment
        where payment.id = p_expected_local_payment_id
          and payment.asaas_payment_id = normalized_payment_id
          and payment.provider_customer_id is null
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'triage_event_not_requeueable'
    );
  end if;

  update public.asaas_webhook_inbox
     set status = 'RETRY',
         lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = pg_catalog.now(),
         processed_at = null,
         last_error = 'authorized_legacy_binding_repair',
         updated_at = pg_catalog.now()
   where provider_event_id = normalized_event_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'REQUEUED',
    'provider_event_id', normalized_event_id
  );
end;
$function$;

alter function public.requeue_legacy_student_payment_binding_event(
  text, uuid, text
) owner to postgres;
revoke all on function public.requeue_legacy_student_payment_binding_event(
  text, uuid, text
) from public, anon, authenticated;
grant execute on function public.requeue_legacy_student_payment_binding_event(
  text, uuid, text
) to service_role;

create or replace function public.resolve_repaired_asaas_webhook_issue(
  p_provider_event_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_event_id text := nullif(pg_catalog.btrim(coalesce(p_provider_event_id, '')), '');
begin
  if normalized_event_id is null
     or not exists (
       select 1
         from public.asaas_webhook_inbox as inbox
        where inbox.provider_event_id = normalized_event_id
          and inbox.status = 'PROCESSED'
     )
  then
    return false;
  end if;

  update public.asaas_reconciliation_issues
     set resolved_at = coalesce(resolved_at, pg_catalog.now()),
         resolution_note = coalesce(
           resolution_note,
           'legacy provider binding repaired and webhook processed'
         )
   where source = 'WEBHOOK'
     and fingerprint = 'triage:' || normalized_event_id
     and resolved_at is null;
  return true;
end;
$function$;

alter function public.resolve_repaired_asaas_webhook_issue(text)
  owner to postgres;
revoke all on function public.resolve_repaired_asaas_webhook_issue(text)
  from public, anon, authenticated;
grant execute on function public.resolve_repaired_asaas_webhook_issue(text)
  to service_role;

do $postcheck$
begin
  if pg_catalog.to_regprocedure(
       'public.bind_legacy_student_payment_from_webhook(text,uuid,uuid,text,text,jsonb)'
     ) is null
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.bind_legacy_student_payment_from_webhook(text,uuid,uuid,text,text,jsonb)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.requeue_legacy_student_payment_binding_event(text,uuid,text)',
       'EXECUTE'
     )
  then
    raise exception 'legacy payment binding repair was not installed safely';
  end if;
end;
$postcheck$;

commit;
