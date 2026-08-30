begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.bind_legacy_student_payment_from_webhook(text,uuid,uuid,text,text,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.requeue_legacy_student_payment_binding_event(text,uuid,text)',
    'EXECUTE'
  ),
  'legacy binding repair privileges are unsafe'
);

insert into public.tenants (
  id, name, slug, saas_status, whatsapp_enabled
) values (
  'legacy-payment-repair-school',
  'Legacy Payment Repair School',
  'legacy-payment-repair-school',
  'active',
  true
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '57000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'legacy-payment-student@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Legacy Payment Student"}',
  pg_catalog.now(),
  pg_catalog.now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'legacy-payment-repair-school',
       role = 'STUDENT',
       lifecycle_status = 'active',
       status = 'Ativo',
       is_test_account = false,
       monthly_fee = 229,
       asaas_customer_id = null,
       subscription_id = 'sub_legacy_repair'
 where id = '57000000-0000-4000-8000-000000000001';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id = '57000000-0000-4000-8000-000000000001';
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '57000000-0000-4000-8000-000000000001',
  'legacy-payment-repair-school',
  'STUDENT',
  'ACTIVE',
  true
);

insert into public.offers (
  id, kind, tenant_id, payload, expires_at, consumed_at, created_by,
  consumed_by, processing_state, processing_completed_at
) values (
  '57000000-0000-4000-8000-000000000010',
  'ENROLLMENT',
  'legacy-payment-repair-school',
  '{}',
  pg_catalog.now() + interval '30 days',
  pg_catalog.now(),
  '57000000-0000-4000-8000-000000000001',
  '57000000-0000-4000-8000-000000000001',
  'COMPLETED',
  pg_catalog.now()
);

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_type, billing_type
) values (
  '57000000-0000-4000-8000-000000000020',
  '57000000-0000-4000-8000-000000000001',
  'legacy-payment-repair-school',
  'pay_legacy_repair',
  229,
  22900,
  'PENDING',
  'PENDING',
  '2026-08-30',
  'SUBSCRIPTION',
  'PIX'
);

set local app.enrollment_claim = '1';
update public.profiles
   set asaas_customer_id = 'cus_legacy_repair'
 where id = '57000000-0000-4000-8000-000000000001';
set local app.enrollment_claim = '';

insert into public.asaas_webhook_inbox (
  provider_event_id, event_name, provider_entity_id, event_created_at,
  payload, payload_hash, status, last_error, processed_at
) values (
  'evt_legacy_repair',
  'PAYMENT_RECEIVED',
  'pay_legacy_repair',
  '2026-08-29 12:00:00+00',
  jsonb_build_object(
    'id', 'evt_legacy_repair',
    'event', 'PAYMENT_RECEIVED',
    'payment', jsonb_build_object(
      'id', 'pay_legacy_repair',
      'customer', 'cus_legacy_repair',
      'subscription', 'sub_legacy_repair',
      'externalReference',
        'enrollment:57000000-0000-4000-8000-000000000010:subscription',
      'value', 229,
      'dueDate', '2026-08-30',
      'paymentDate', '2026-08-29',
      'creditDate', '2026-08-29',
      'status', 'RECEIVED'
    )
  ),
  'test-hash',
  'TRIAGE',
  'inactive_settlement_local_binding_incomplete',
  pg_catalog.now()
);

select pg_temp.assert_true(
  (
    public.requeue_legacy_student_payment_binding_event(
      'evt_legacy_repair',
      '57000000-0000-4000-8000-000000000020',
      'pay_legacy_repair'
    ) ->> 'action'
  ) = 'REQUEUED',
  'exact TRIAGE event was not requeued'
);

update public.asaas_webhook_inbox
   set status = 'PROCESSING'
 where provider_event_id = 'evt_legacy_repair';

create temporary table legacy_binding_results (
  payload jsonb not null
);
insert into legacy_binding_results
select public.bind_legacy_student_payment_from_webhook(
  'evt_legacy_repair',
  '57000000-0000-4000-8000-000000000020',
  '57000000-0000-4000-8000-000000000001',
  'legacy-payment-repair-school',
  'cus_legacy_repair',
  (select payload from public.asaas_webhook_inbox
    where provider_event_id = 'evt_legacy_repair')
);

select pg_temp.assert_true(
  (
    select payload ->> 'action' from legacy_binding_results
  ) = 'BOUND'
  and (
    select provider_customer_id = 'cus_legacy_repair'
      from public.student_payments
     where id = '57000000-0000-4000-8000-000000000020'
  ),
  'trusted legacy payment evidence was not bound'
);

select pg_temp.assert_true(
  (
    public.bind_legacy_student_payment_from_webhook(
      'evt_legacy_repair',
      '57000000-0000-4000-8000-000000000020',
      '57000000-0000-4000-8000-000000000001',
      'legacy-payment-repair-school',
      'cus_attacker',
      jsonb_build_object('event', 'PAYMENT_RECEIVED')
    ) ->> 'reason'
  ) = 'trusted_webhook_evidence_missing',
  'spoofed webhook evidence was accepted'
);

insert into public.asaas_reconciliation_issues (
  tenant_id, source, kind, severity, provider_entity_id,
  local_entity_id, fingerprint, details
) values (
  'legacy-payment-repair-school',
  'WEBHOOK',
  'WEBHOOK_TRIAGE',
  'HIGH',
  'pay_legacy_repair',
  '57000000-0000-4000-8000-000000000020',
  'triage:evt_legacy_repair',
  '{}'
);
update public.asaas_webhook_inbox
   set status = 'PROCESSED'
 where provider_event_id = 'evt_legacy_repair';

select public.resolve_repaired_asaas_webhook_issue('evt_legacy_repair');
select pg_temp.assert_true(
  exists (
    select 1
      from public.asaas_reconciliation_issues
     where fingerprint = 'triage:evt_legacy_repair'
       and resolved_at is not null
  ),
  'processed repair issue was not resolved'
);

rollback;
