begin;

-- Canonical enrollment/student externalReference handling remains owned by
-- bind_legacy_student_payment_from_webhook. This separate function exists only
-- for provider-generated recurring installments from old subscriptions where
-- both the installment and parent subscription have no externalReference.
-- The Edge Function must freshly GET both provider objects before calling it.
create or replace function public.bind_legacy_recurring_student_payment_from_webhook(
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
  normalized_event_id text := nullif(pg_catalog.btrim(coalesce(p_provider_event_id, '')), '');
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_expected_tenant_id, '')), '');
  normalized_customer text := nullif(pg_catalog.btrim(coalesce(p_expected_provider_customer_id, '')), '');
  normalized_subscription text := nullif(pg_catalog.btrim(coalesce(p_expected_provider_subscription_id, '')), '');
  inbox_row public.asaas_webhook_inbox%rowtype;
  payment_row public.student_payments%rowtype;
  profile_row public.profiles%rowtype;
  event_payment_id text;
  event_customer_id text;
  event_subscription_id text;
  event_reference text;
  event_status text;
  event_value numeric;
  event_due_date date;
  authoritative_payment_id text;
  authoritative_customer_id text;
  authoritative_subscription_id text;
  authoritative_payment_reference text;
  authoritative_payment_status text;
  authoritative_payment_value numeric;
  authoritative_due_date date;
  authoritative_parent_id text;
  authoritative_parent_customer_id text;
  authoritative_parent_reference text;
  authoritative_parent_status text;
  authoritative_parent_value numeric;
  expected_settled_status text;
  payment_binding_count integer;
  provider_profile_count integer;
begin
  if normalized_event_id is null
     or pg_catalog.length(normalized_event_id) > 240
     or p_expected_local_payment_id is null
     or p_expected_student_id is null
     or normalized_tenant is null
     or normalized_customer is null
     or normalized_subscription is null
     or pg_catalog.length(normalized_customer) > 240
     or pg_catalog.length(normalized_subscription) > 240
     or p_authoritative_payment is null
     or pg_catalog.jsonb_typeof(p_authoritative_payment) <> 'object'
     or p_authoritative_subscription is null
     or pg_catalog.jsonb_typeof(p_authoritative_subscription) <> 'object'
  then
    raise exception using
      errcode = '22023',
      message = 'legacy_recurring_binding_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' ||
        p_expected_student_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'legacy-recurring-payment-binding:' || normalized_tenant || ':' ||
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
     or inbox_row.status <> 'PROCESSING'
     or inbox_row.lease_owner is null
     or inbox_row.lease_expires_at is null
     or inbox_row.lease_expires_at <= pg_catalog.now()
     or inbox_row.event_name not in (
       'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH'
     )
     or nullif(pg_catalog.btrim(inbox_row.payload_hash), '') is null
     or nullif(pg_catalog.btrim(inbox_row.payload ->> 'id'), '')
          is distinct from normalized_event_id
     or nullif(pg_catalog.btrim(inbox_row.payload ->> 'event'), '')
          is distinct from inbox_row.event_name
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'legacy_recurring_trusted_webhook_evidence_missing'
    );
  end if;

  expected_settled_status := case inbox_row.event_name
    when 'PAYMENT_RECEIVED' then 'RECEIVED'
    when 'PAYMENT_RECEIVED_IN_CASH' then 'RECEIVED_IN_CASH'
    else null
  end;
  event_payment_id := nullif(pg_catalog.btrim(inbox_row.payload #>> '{payment,id}'), '');
  event_customer_id := nullif(pg_catalog.btrim(inbox_row.payload #>> '{payment,customer}'), '');
  event_subscription_id := nullif(pg_catalog.btrim(inbox_row.payload #>> '{payment,subscription}'), '');
  event_reference := nullif(pg_catalog.btrim(inbox_row.payload #>> '{payment,externalReference}'), '');
  event_status := upper(nullif(pg_catalog.btrim(inbox_row.payload #>> '{payment,status}'), ''));

  authoritative_payment_id := nullif(pg_catalog.btrim(p_authoritative_payment ->> 'id'), '');
  authoritative_customer_id := nullif(pg_catalog.btrim(p_authoritative_payment ->> 'customer'), '');
  authoritative_subscription_id := nullif(pg_catalog.btrim(p_authoritative_payment ->> 'subscription'), '');
  authoritative_payment_reference := nullif(pg_catalog.btrim(p_authoritative_payment ->> 'externalReference'), '');
  authoritative_payment_status := upper(nullif(pg_catalog.btrim(p_authoritative_payment ->> 'status'), ''));

  authoritative_parent_id := nullif(pg_catalog.btrim(p_authoritative_subscription ->> 'id'), '');
  authoritative_parent_customer_id := nullif(pg_catalog.btrim(p_authoritative_subscription ->> 'customer'), '');
  authoritative_parent_reference := nullif(pg_catalog.btrim(p_authoritative_subscription ->> 'externalReference'), '');
  authoritative_parent_status := upper(nullif(pg_catalog.btrim(p_authoritative_subscription ->> 'status'), ''));

  begin
    event_value := (inbox_row.payload #>> '{payment,value}')::numeric;
    event_due_date := (inbox_row.payload #>> '{payment,dueDate}')::date;
    authoritative_payment_value := (p_authoritative_payment ->> 'value')::numeric;
    authoritative_due_date := (p_authoritative_payment ->> 'dueDate')::date;
    authoritative_parent_value := (p_authoritative_subscription ->> 'value')::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'legacy_recurring_provider_evidence_invalid'
      );
  end;

  if event_payment_id is distinct from inbox_row.provider_entity_id
     or event_customer_id is distinct from normalized_customer
     or event_subscription_id is distinct from normalized_subscription
     or event_reference is not null
     or event_status is distinct from expected_settled_status
     or authoritative_payment_id is distinct from event_payment_id
     or authoritative_customer_id is distinct from event_customer_id
     or authoritative_subscription_id is distinct from event_subscription_id
     or authoritative_payment_reference is not null
     or authoritative_payment_status is distinct from event_status
     or authoritative_parent_id is distinct from event_subscription_id
     or authoritative_parent_customer_id is distinct from event_customer_id
     or authoritative_parent_reference is not null
     or authoritative_parent_status is null
     or p_authoritative_payment @> '{"deleted":true}'::jsonb
     or event_value is null
     or event_value::text in ('NaN', 'Infinity', '-Infinity')
     or event_value <= 0
     or authoritative_payment_value is null
     or authoritative_payment_value::text in ('NaN', 'Infinity', '-Infinity')
     or authoritative_payment_value <= 0
     or authoritative_parent_value is null
     or authoritative_parent_value::text in ('NaN', 'Infinity', '-Infinity')
     or authoritative_parent_value <= 0
     or pg_catalog.round(event_value, 2)
          is distinct from pg_catalog.round(authoritative_payment_value, 2)
     or pg_catalog.round(event_value, 2)
          is distinct from pg_catalog.round(authoritative_parent_value, 2)
     or event_due_date is null
     or authoritative_due_date is distinct from event_due_date
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'legacy_recurring_provider_evidence_mismatch'
    );
  end if;

  select pg_catalog.count(*)::integer
    into payment_binding_count
    from public.student_payments as payment
   where nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = event_payment_id
      or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = event_payment_id;

  if payment_binding_count <> 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'legacy_recurring_local_payment_not_unique'
    );
  end if;

  select payment.*
    into payment_row
    from public.student_payments as payment
   where payment.id = p_expected_local_payment_id
     and (
       nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = event_payment_id
       or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = event_payment_id
     )
   for update;

  if not found
     or payment_row.student_id is distinct from p_expected_student_id
     or payment_row.tenant_id is distinct from normalized_tenant
     or payment_row.provider_customer_id is not null
     or (
       nullif(pg_catalog.btrim(coalesce(payment_row.asaas_payment_id, '')), '') is not null
       and nullif(pg_catalog.btrim(coalesce(payment_row.asaas_id, '')), '') is not null
       and pg_catalog.btrim(payment_row.asaas_payment_id) <>
         pg_catalog.btrim(payment_row.asaas_id)
     )
     or pg_catalog.round(coalesce(payment_row.value, 0), 2)
          is distinct from pg_catalog.round(event_value, 2)
     or (
       payment_row.amount_cents is not null
       and payment_row.amount_cents is distinct from
         pg_catalog.round(event_value * 100)::integer
     )
     or payment_row.due_date is distinct from event_due_date
     or upper(pg_catalog.btrim(coalesce(payment_row.status, ''))) not in (
       'PENDING', 'OVERDUE', 'CONFIRMED'
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'legacy_recurring_local_payment_not_repairable'
    );
  end if;

  select profile.*
    into profile_row
    from public.profiles as profile
   where profile.id = p_expected_student_id
     and profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) in (
       'active', 'suspended', 'offboarded'
     )
     and coalesce(profile.is_test_account, false) is false
     and nullif(pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')), '') =
       normalized_customer
     and nullif(pg_catalog.btrim(coalesce(profile.subscription_id, '')), '') =
       normalized_subscription
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'legacy_recurring_student_scope_not_corroborated'
    );
  end if;

  select pg_catalog.count(*)::integer
    into provider_profile_count
    from public.profiles as profile
   where profile.role = 'STUDENT'
     and (
       nullif(pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')), '') =
         normalized_customer
       or nullif(pg_catalog.btrim(coalesce(profile.subscription_id, '')), '') =
         normalized_subscription
     );

  if provider_profile_count <> 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'legacy_recurring_provider_profile_not_unique'
    );
  end if;

  if (
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
      'reason', 'legacy_recurring_membership_not_corroborated'
    );
  end if;

  -- Do not rewrite status, dates, payload or updated_at here. The ordinary
  -- serialized payment event RPC applies the settlement immediately after
  -- this immutable identity gap is repaired.
  update public.student_payments as target
     set provider_customer_id = normalized_customer
   where target.id = payment_row.id
     and target.provider_customer_id is null;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'legacy_recurring_binding_changed_concurrently'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'BOUND',
    'evidence_mode', 'AUTHORITATIVE_RECURRING_GET',
    'payment_id', payment_row.id,
    'tenant_id', normalized_tenant,
    'student_id', p_expected_student_id
  );
end;
$function$;

alter function public.bind_legacy_recurring_student_payment_from_webhook(
  text, uuid, uuid, text, text, text, jsonb, jsonb
) owner to postgres;
revoke all on function public.bind_legacy_recurring_student_payment_from_webhook(
  text, uuid, uuid, text, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.bind_legacy_recurring_student_payment_from_webhook(
  text, uuid, uuid, text, text, text, jsonb, jsonb
) to service_role;

-- PAYMENT_DELETED is authoritative only for a charge that never became cash.
-- The webhook payload and a fresh GET must describe the same deleted provider
-- object; received rows and rows with any gross ledger evidence are immutable
-- here and continue through the manual financial-review path.
create or replace function public.apply_verified_unsettled_asaas_payment_deletion(
  p_provider_event_id text,
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_expected_provider_customer_id text,
  p_expected_provider_subscription_id text,
  p_event_created_at timestamptz,
  p_event_rank integer,
  p_payload jsonb,
  p_authoritative_payment jsonb
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
  normalized_subscription text := nullif(pg_catalog.btrim(coalesce(p_expected_provider_subscription_id, '')), '');
  inbox_row public.asaas_webhook_inbox%rowtype;
  payment_row public.student_payments%rowtype;
  profile_row public.profiles%rowtype;
  event_payment_id text;
  event_customer_id text;
  event_subscription_id text;
  event_reference text;
  event_status text;
  event_value numeric;
  event_due_date date;
  authoritative_payment_id text;
  authoritative_customer_id text;
  authoritative_subscription_id text;
  authoritative_reference text;
  authoritative_status text;
  authoritative_value numeric;
  authoritative_due_date date;
  payment_binding_count integer;
  provider_profile_count integer;
  previous_status text;
begin
  if normalized_event_id is null
     or pg_catalog.length(normalized_event_id) > 240
     or p_expected_local_payment_id is null
     or p_expected_student_id is null
     or normalized_tenant is null
     or normalized_customer is null
     or normalized_subscription is null
     or pg_catalog.length(normalized_customer) > 240
     or pg_catalog.length(normalized_subscription) > 240
     or p_event_created_at is null
     or p_event_rank is distinct from 100
     or p_payload is null
     or pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or p_authoritative_payment is null
     or pg_catalog.jsonb_typeof(p_authoritative_payment) <> 'object'
  then
    raise exception using
      errcode = '22023',
      message = 'deleted_payment_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' ||
        p_expected_student_id::text,
      0
    )
  );

  select inbox.*
    into inbox_row
    from public.asaas_webhook_inbox as inbox
   where inbox.provider_event_id = normalized_event_id
   for update;

  if not found
     or inbox_row.status <> 'PROCESSING'
     or inbox_row.lease_owner is null
     or inbox_row.lease_expires_at is null
     or inbox_row.lease_expires_at <= pg_catalog.now()
     or inbox_row.event_name <> 'PAYMENT_DELETED'
     or inbox_row.event_created_at is distinct from p_event_created_at
     or inbox_row.payload is distinct from p_payload
     or nullif(pg_catalog.btrim(inbox_row.payload_hash), '') is null
     or nullif(pg_catalog.btrim(p_payload ->> 'id'), '')
          is distinct from normalized_event_id
     or upper(pg_catalog.btrim(coalesce(p_payload ->> 'event', ''))) <>
       'PAYMENT_DELETED'
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'deleted_payment_trusted_webhook_evidence_missing'
    );
  end if;

  event_payment_id := nullif(pg_catalog.btrim(p_payload #>> '{payment,id}'), '');
  event_customer_id := nullif(pg_catalog.btrim(p_payload #>> '{payment,customer}'), '');
  event_subscription_id := nullif(pg_catalog.btrim(p_payload #>> '{payment,subscription}'), '');
  event_reference := nullif(pg_catalog.btrim(p_payload #>> '{payment,externalReference}'), '');
  event_status := upper(nullif(pg_catalog.btrim(p_payload #>> '{payment,status}'), ''));
  authoritative_payment_id := nullif(pg_catalog.btrim(p_authoritative_payment ->> 'id'), '');
  authoritative_customer_id := nullif(pg_catalog.btrim(p_authoritative_payment ->> 'customer'), '');
  authoritative_subscription_id := nullif(pg_catalog.btrim(p_authoritative_payment ->> 'subscription'), '');
  authoritative_reference := nullif(pg_catalog.btrim(p_authoritative_payment ->> 'externalReference'), '');
  authoritative_status := upper(nullif(pg_catalog.btrim(p_authoritative_payment ->> 'status'), ''));

  begin
    event_value := (p_payload #>> '{payment,value}')::numeric;
    event_due_date := (p_payload #>> '{payment,dueDate}')::date;
    authoritative_value := (p_authoritative_payment ->> 'value')::numeric;
    authoritative_due_date := (p_authoritative_payment ->> 'dueDate')::date;
  exception
    when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'deleted_payment_provider_evidence_invalid'
      );
  end;

  if event_payment_id is distinct from inbox_row.provider_entity_id
     or event_customer_id is distinct from normalized_customer
     or event_subscription_id is distinct from normalized_subscription
     or event_status is null
     or authoritative_payment_id is distinct from event_payment_id
     or authoritative_customer_id is distinct from event_customer_id
     or authoritative_subscription_id is distinct from event_subscription_id
     or authoritative_reference is distinct from event_reference
     or authoritative_status is distinct from event_status
     or not (p_authoritative_payment @> '{"deleted":true}'::jsonb)
     or nullif(pg_catalog.btrim(p_authoritative_payment ->> 'creditDate'), '') is not null
     or event_value is null
     or event_value::text in ('NaN', 'Infinity', '-Infinity')
     or event_value <= 0
     or authoritative_value is null
     or authoritative_value::text in ('NaN', 'Infinity', '-Infinity')
     or authoritative_value <= 0
     or pg_catalog.round(authoritative_value, 2)
          is distinct from pg_catalog.round(event_value, 2)
     or event_due_date is null
     or authoritative_due_date is distinct from event_due_date
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'deleted_payment_provider_evidence_mismatch'
    );
  end if;

  select pg_catalog.count(*)::integer
    into payment_binding_count
    from public.student_payments as payment
   where nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = event_payment_id
      or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = event_payment_id;
  if payment_binding_count <> 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'deleted_payment_local_binding_not_unique'
    );
  end if;

  select payment.*
    into payment_row
    from public.student_payments as payment
   where payment.id = p_expected_local_payment_id
     and (
       nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = event_payment_id
       or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = event_payment_id
     )
   for update;
  if not found
     or payment_row.student_id is distinct from p_expected_student_id
     or payment_row.tenant_id is distinct from normalized_tenant
     or (
       nullif(pg_catalog.btrim(coalesce(payment_row.provider_customer_id, '')), '') is not null
       and nullif(pg_catalog.btrim(payment_row.provider_customer_id), '')
         is distinct from normalized_customer
     )
     or pg_catalog.round(coalesce(payment_row.value, 0), 2)
          is distinct from pg_catalog.round(event_value, 2)
     or (
       payment_row.amount_cents is not null
       and payment_row.amount_cents is distinct from
         pg_catalog.round(event_value * 100)::integer
     )
     or payment_row.due_date is distinct from event_due_date
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'deleted_payment_local_binding_mismatch'
    );
  end if;

  select profile.*
    into profile_row
    from public.profiles as profile
   where profile.id = p_expected_student_id
     and profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) in (
       'active', 'suspended', 'offboarded'
     )
     and coalesce(profile.is_test_account, false) is false
     and nullif(pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')), '') =
       normalized_customer
     and nullif(pg_catalog.btrim(coalesce(profile.subscription_id, '')), '') =
       normalized_subscription
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'deleted_payment_student_scope_not_corroborated'
    );
  end if;

  select pg_catalog.count(*)::integer
    into provider_profile_count
    from public.profiles as profile
   where profile.role = 'STUDENT'
     and (
       nullif(pg_catalog.btrim(coalesce(profile.asaas_customer_id, '')), '') =
         normalized_customer
       or nullif(pg_catalog.btrim(coalesce(profile.subscription_id, '')), '') =
         normalized_subscription
     );
  if provider_profile_count <> 1 then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'deleted_payment_provider_profile_not_unique'
    );
  end if;
  if (
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
      'reason', 'deleted_payment_membership_not_corroborated'
    );
  end if;

  if nullif(pg_catalog.btrim(coalesce(payment_row.last_provider_event_id, '')), '')
       is not distinct from normalized_event_id
     and upper(pg_catalog.btrim(coalesce(payment_row.status, ''))) = 'CANCELLED'
     and upper(pg_catalog.btrim(coalesce(payment_row.provider_status, ''))) = 'DELETED'
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'REPLAY',
      'id', payment_row.id,
      'due_date', payment_row.due_date,
      'previous_status', payment_row.status
    );
  end if;
  if payment_row.last_provider_event_at is not null and (
    p_event_created_at < payment_row.last_provider_event_at
    or (
      p_event_created_at = payment_row.last_provider_event_at
      and p_event_rank <= coalesce(payment_row.last_provider_event_rank, 0)
    )
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IGNORED',
      'id', payment_row.id,
      'due_date', payment_row.due_date,
      'previous_status', payment_row.status
    );
  end if;

  previous_status := upper(pg_catalog.btrim(coalesce(payment_row.status, '')));
  if previous_status not in ('PENDING', 'OVERDUE', 'CONFIRMED')
     or upper(pg_catalog.btrim(coalesce(payment_row.provider_status, ''))) in (
       'RECEIVED', 'RECEIVED_IN_CASH', 'PAGO', 'REFUNDED'
     )
     or payment_row.credited_at is not null
     or payment_row.paid_at is not null
     or coalesce(payment_row.refunded_amount, 0) <> 0
     or coalesce(payment_row.ledger_entry_created, false)
     or exists (
       select 1
         from public.financial_transactions as financial_transaction
        where financial_transaction.student_payment_id = payment_row.id
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'deleted_payment_not_proven_unsettled'
    );
  end if;

  update public.student_payments as payment
     set status = 'CANCELLED',
         provider_status = 'DELETED',
         raw_payload = p_payload,
         last_provider_event_id = normalized_event_id,
         last_provider_event_at = p_event_created_at,
         last_provider_event_rank = p_event_rank,
         updated_at = pg_catalog.clock_timestamp()
   where payment.id = payment_row.id
   returning payment.* into payment_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'CANCELLED',
    'id', payment_row.id,
    'due_date', payment_row.due_date,
    'previous_status', previous_status,
    'provider_reason', 'provider_deleted'
  );
end;
$function$;

alter function public.apply_verified_unsettled_asaas_payment_deletion(
  text, uuid, uuid, text, text, text, timestamptz, integer, jsonb, jsonb
) owner to postgres;
revoke all on function public.apply_verified_unsettled_asaas_payment_deletion(
  text, uuid, uuid, text, text, text, timestamptz, integer, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.apply_verified_unsettled_asaas_payment_deletion(
  text, uuid, uuid, text, text, text, timestamptz, integer, jsonb, jsonb
) to service_role;

-- Preserve the original repair reason and admit only the explicit, observable
-- reasons emitted by the new strict path. Requeue still requires an exact
-- TRIAGE event and an exact still-unbound local provider payment.
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
     or inbox_row.last_error not in (
       'inactive_settlement_local_binding_incomplete',
       'legacy_recurring_authoritative_payment_not_found',
       'legacy_recurring_authoritative_subscription_not_found',
       'legacy_recurring_provider_lookup_rejected',
       'legacy_recurring_provider_identity_mismatch',
       'legacy_recurring_local_evidence_incomplete',
       'legacy_recurring_binding_database_rejected',
       'legacy_recurring_trusted_webhook_evidence_missing',
       'legacy_recurring_provider_evidence_invalid',
       'legacy_recurring_provider_evidence_mismatch',
       'legacy_recurring_local_payment_not_unique',
       'legacy_recurring_local_payment_not_repairable',
       'legacy_recurring_student_scope_not_corroborated',
       'legacy_recurring_provider_profile_not_unique',
       'legacy_recurring_membership_not_corroborated',
       'legacy_recurring_binding_changed_concurrently',
       'legacy_recurring_binding_not_applied'
     )
     or inbox_row.provider_entity_id <> normalized_payment_id
     or inbox_row.event_name not in (
       'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH'
     )
     or not exists (
       select 1
         from public.student_payments as payment
        where payment.id = p_expected_local_payment_id
          and (
            nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
            or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id
          )
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
) from public, anon, authenticated, service_role;
grant execute on function public.requeue_legacy_student_payment_binding_event(
  text, uuid, text
) to service_role;

do $postcheck$
begin
  if pg_catalog.to_regprocedure(
       'public.bind_legacy_student_payment_from_webhook(text,uuid,uuid,text,text,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.bind_legacy_recurring_student_payment_from_webhook(text,uuid,uuid,text,text,text,jsonb,jsonb)'
     ) is null
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.bind_legacy_recurring_student_payment_from_webhook(text,uuid,uuid,text,text,text,jsonb,jsonb)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.bind_legacy_recurring_student_payment_from_webhook(text,uuid,uuid,text,text,text,jsonb,jsonb)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.apply_verified_unsettled_asaas_payment_deletion(text,uuid,uuid,text,text,text,timestamp with time zone,integer,jsonb,jsonb)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.apply_verified_unsettled_asaas_payment_deletion(text,uuid,uuid,text,text,text,timestamp with time zone,integer,jsonb,jsonb)',
       'EXECUTE'
     )
  then
    raise exception 'legacy recurring payment binding repair was not installed safely';
  end if;
end;
$postcheck$;

commit;
