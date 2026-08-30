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
  to_regprocedure(
    'public.bind_legacy_student_payment_from_webhook(text,uuid,uuid,text,text,jsonb)'
  ) is not null
  and not has_function_privilege(
    'authenticated',
    'public.bind_legacy_recurring_student_payment_from_webhook(text,uuid,uuid,text,text,text,jsonb,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.bind_legacy_recurring_student_payment_from_webhook(text,uuid,uuid,text,text,text,jsonb,jsonb)',
    'EXECUTE'
  ),
  'legacy recurring binding privileges or canonical path changed'
);

insert into public.tenants (
  id, name, slug, saas_status, whatsapp_enabled
) values (
  'legacy-recurring-repair-school',
  'Legacy Recurring Repair School',
  'legacy-recurring-repair-school',
  'active',
  true
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '58000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated',
    'legacy-recurring-active@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Legacy Recurring Active"}',
    pg_catalog.now(), pg_catalog.now()
  ),
  (
    '58000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated',
    'legacy-recurring-suspended@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Legacy Recurring Suspended"}',
    pg_catalog.now(), pg_catalog.now()
  ),
  (
    '58000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated',
    'legacy-recurring-offboarded@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Legacy Recurring Offboarded"}',
    pg_catalog.now(), pg_catalog.now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'legacy-recurring-repair-school',
       role = 'STUDENT',
       lifecycle_status = case id
         when '58000000-0000-4000-8000-000000000001'::uuid then 'active'
         when '58000000-0000-4000-8000-000000000002'::uuid then 'suspended'
         else 'offboarded'
       end,
       status = 'Ativo',
       is_test_account = false,
       monthly_fee = 350.10,
       asaas_customer_id = null,
       subscription_id = case id
         when '58000000-0000-4000-8000-000000000001'::uuid then 'sub_legacy_active'
         when '58000000-0000-4000-8000-000000000002'::uuid then 'sub_legacy_suspended'
         else 'sub_legacy_offboarded'
       end
 where id in (
   '58000000-0000-4000-8000-000000000001',
   '58000000-0000-4000-8000-000000000002',
   '58000000-0000-4000-8000-000000000003'
 );
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id in (
   '58000000-0000-4000-8000-000000000001',
   '58000000-0000-4000-8000-000000000002',
   '58000000-0000-4000-8000-000000000003'
 );
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  (
    '58000000-0000-4000-8000-000000000001',
    'legacy-recurring-repair-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '58000000-0000-4000-8000-000000000002',
    'legacy-recurring-repair-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '58000000-0000-4000-8000-000000000003',
    'legacy-recurring-repair-school', 'STUDENT', 'ACTIVE', true
  );

-- Insert before the profile customer is populated so these faithfully model
-- the legacy gap being repaired.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_type, billing_type
) values
  (
    '58000000-0000-4000-8000-000000000011',
    '58000000-0000-4000-8000-000000000001',
    'legacy-recurring-repair-school', 'pay_legacy_active',
    350.10, 35010, 'PENDING', 'PENDING', '2026-08-30',
    'SUBSCRIPTION', 'PIX'
  ),
  (
    '58000000-0000-4000-8000-000000000012',
    '58000000-0000-4000-8000-000000000002',
    'legacy-recurring-repair-school', 'pay_legacy_suspended',
    350.10, 35010, 'OVERDUE', 'OVERDUE', '2026-08-30',
    'SUBSCRIPTION', 'PIX'
  ),
  (
    '58000000-0000-4000-8000-000000000013',
    '58000000-0000-4000-8000-000000000003',
    'legacy-recurring-repair-school', 'pay_legacy_offboarded',
    350.10, 35010, 'CONFIRMED', 'CONFIRMED', '2026-08-30',
    'SUBSCRIPTION', 'PIX'
  );

set local app.enrollment_claim = '1';
update public.profiles
   set asaas_customer_id = case id
     when '58000000-0000-4000-8000-000000000001'::uuid then 'cus_legacy_active'
     when '58000000-0000-4000-8000-000000000002'::uuid then 'cus_legacy_suspended'
     else 'cus_legacy_offboarded'
   end
 where id in (
   '58000000-0000-4000-8000-000000000001',
   '58000000-0000-4000-8000-000000000002',
   '58000000-0000-4000-8000-000000000003'
 );
set local app.enrollment_claim = '';

insert into public.asaas_webhook_inbox (
  provider_event_id, event_name, provider_entity_id, event_created_at,
  payload, payload_hash, status, lease_owner, lease_expires_at, last_error
) values
  (
    'evt_legacy_active', 'PAYMENT_RECEIVED', 'pay_legacy_active',
    '2026-08-29 12:00:00+00',
    jsonb_build_object(
      'id', 'evt_legacy_active', 'event', 'PAYMENT_RECEIVED',
      'payment', jsonb_build_object(
        'id', 'pay_legacy_active', 'customer', 'cus_legacy_active',
        'subscription', 'sub_legacy_active', 'externalReference', null,
        'value', 350.10, 'dueDate', '2026-08-30', 'status', 'RECEIVED'
      )
    ),
    'active-hash', 'PROCESSING',
    '58000000-0000-4000-8000-000000000100',
    pg_catalog.now() + interval '10 minutes', null
  ),
  (
    'evt_legacy_suspended', 'PAYMENT_RECEIVED', 'pay_legacy_suspended',
    '2026-08-29 12:01:00+00',
    jsonb_build_object(
      'id', 'evt_legacy_suspended', 'event', 'PAYMENT_RECEIVED',
      'payment', jsonb_build_object(
        'id', 'pay_legacy_suspended', 'customer', 'cus_legacy_suspended',
        'subscription', 'sub_legacy_suspended', 'externalReference', null,
        'value', 350.10, 'dueDate', '2026-08-30', 'status', 'RECEIVED'
      )
    ),
    'suspended-hash', 'TRIAGE', null, null,
    'legacy_recurring_provider_identity_mismatch'
  ),
  (
    'evt_legacy_offboarded', 'PAYMENT_RECEIVED_IN_CASH',
    'pay_legacy_offboarded', '2026-08-29 12:02:00+00',
    jsonb_build_object(
      'id', 'evt_legacy_offboarded', 'event', 'PAYMENT_RECEIVED_IN_CASH',
      'payment', jsonb_build_object(
        'id', 'pay_legacy_offboarded', 'customer', 'cus_legacy_offboarded',
        'subscription', 'sub_legacy_offboarded', 'externalReference', null,
        'value', 350.10, 'dueDate', '2026-08-30',
        'status', 'RECEIVED_IN_CASH'
      )
    ),
    'offboarded-hash', 'PROCESSING',
    '58000000-0000-4000-8000-000000000100',
    pg_catalog.now() + interval '10 minutes', null
  );

create temporary table recurring_payment_before as
select to_jsonb(payment) as snapshot
  from public.student_payments as payment
 where payment.id = '58000000-0000-4000-8000-000000000011';

create temporary table recurring_binding_results (
  lifecycle text primary key,
  payload jsonb not null
);

insert into recurring_binding_results values (
  'active',
  public.bind_legacy_recurring_student_payment_from_webhook(
    'evt_legacy_active',
    '58000000-0000-4000-8000-000000000011',
    '58000000-0000-4000-8000-000000000001',
    'legacy-recurring-repair-school',
    'cus_legacy_active', 'sub_legacy_active',
    jsonb_build_object(
      'id', 'pay_legacy_active', 'customer', 'cus_legacy_active',
      'subscription', 'sub_legacy_active', 'externalReference', null,
      'value', 350.10, 'dueDate', '2026-08-30', 'status', 'RECEIVED',
      'deleted', false
    ),
    jsonb_build_object(
      'id', 'sub_legacy_active', 'customer', 'cus_legacy_active',
      'externalReference', null, 'value', 350.10, 'status', 'ACTIVE'
    )
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' from recurring_binding_results
    where lifecycle = 'active') = 'BOUND'
  and (
    select (to_jsonb(payment) - 'provider_customer_id') =
           (before.snapshot - 'provider_customer_id')
           and payment.provider_customer_id = 'cus_legacy_active'
      from public.student_payments as payment
      cross join recurring_payment_before as before
     where payment.id = '58000000-0000-4000-8000-000000000011'
  ),
  'active repair changed more than provider_customer_id'
);

select pg_temp.assert_true(
  (
    public.requeue_legacy_student_payment_binding_event(
      'evt_legacy_suspended',
      '58000000-0000-4000-8000-000000000012',
      'pay_legacy_suspended'
    ) ->> 'action'
  ) = 'REQUEUED',
  'specific legacy recurring triage reason was not requeueable'
);
update public.asaas_webhook_inbox
   set status = 'PROCESSING',
       lease_owner = '58000000-0000-4000-8000-000000000100',
       lease_expires_at = pg_catalog.now() + interval '10 minutes'
 where provider_event_id = 'evt_legacy_suspended';

insert into recurring_binding_results values (
  'suspended',
  public.bind_legacy_recurring_student_payment_from_webhook(
    'evt_legacy_suspended',
    '58000000-0000-4000-8000-000000000012',
    '58000000-0000-4000-8000-000000000002',
    'legacy-recurring-repair-school',
    'cus_legacy_suspended', 'sub_legacy_suspended',
    jsonb_build_object(
      'id', 'pay_legacy_suspended', 'customer', 'cus_legacy_suspended',
      'subscription', 'sub_legacy_suspended', 'externalReference', null,
      'value', 350.10, 'dueDate', '2026-08-30', 'status', 'RECEIVED'
    ),
    jsonb_build_object(
      'id', 'sub_legacy_suspended', 'customer', 'cus_legacy_suspended',
      'externalReference', null, 'value', 350.10, 'status', 'INACTIVE'
    )
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' from recurring_binding_results
    where lifecycle = 'suspended') = 'BOUND',
  'suspended student update-only repair was rejected'
);

select pg_temp.assert_true(
  (
    public.bind_legacy_recurring_student_payment_from_webhook(
      'evt_legacy_offboarded',
      '58000000-0000-4000-8000-000000000013',
      '58000000-0000-4000-8000-000000000003',
      'legacy-recurring-repair-school',
      'cus_legacy_offboarded', 'sub_legacy_offboarded',
      jsonb_build_object(
        'id', 'pay_legacy_offboarded', 'customer', 'cus_legacy_offboarded',
        'subscription', 'sub_legacy_offboarded', 'externalReference', null,
        'value', 350.10, 'dueDate', '2026-08-30',
        'status', 'RECEIVED_IN_CASH'
      ),
      jsonb_build_object(
        'id', 'sub_legacy_offboarded', 'customer', 'cus_legacy_offboarded',
        'externalReference', 'unsafe-reference',
        'value', 350.10, 'status', 'INACTIVE'
      )
    ) ->> 'reason'
  ) = 'legacy_recurring_provider_evidence_mismatch'
  and (
    select provider_customer_id is null
      from public.student_payments
     where id = '58000000-0000-4000-8000-000000000013'
  ),
  'provider parent reference mismatch changed the local payment'
);

insert into recurring_binding_results values (
  'offboarded',
  public.bind_legacy_recurring_student_payment_from_webhook(
    'evt_legacy_offboarded',
    '58000000-0000-4000-8000-000000000013',
    '58000000-0000-4000-8000-000000000003',
    'legacy-recurring-repair-school',
    'cus_legacy_offboarded', 'sub_legacy_offboarded',
    jsonb_build_object(
      'id', 'pay_legacy_offboarded', 'customer', 'cus_legacy_offboarded',
      'subscription', 'sub_legacy_offboarded', 'externalReference', null,
      'value', 350.10, 'dueDate', '2026-08-30',
      'status', 'RECEIVED_IN_CASH'
    ),
    jsonb_build_object(
      'id', 'sub_legacy_offboarded', 'customer', 'cus_legacy_offboarded',
      'externalReference', null, 'value', 350.10, 'status', 'INACTIVE'
    )
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' from recurring_binding_results
    where lifecycle = 'offboarded') = 'BOUND',
  'offboarded student update-only repair was rejected'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '58000000-0000-4000-8000-000000000004',
  'authenticated', 'authenticated',
  'verified-deleted-payment@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Verified Deleted Payment"}',
  pg_catalog.now(), pg_catalog.now()
);
set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'legacy-recurring-repair-school',
       role = 'STUDENT', lifecycle_status = 'active', status = 'Ativo',
       is_test_account = false, monthly_fee = 279,
       asaas_customer_id = null,
       subscription_id = 'sub_verified_deleted'
 where id = '58000000-0000-4000-8000-000000000004';
set local app.enrollment_claim = '';
delete from public.tenant_memberships
 where user_id = '58000000-0000-4000-8000-000000000004';
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '58000000-0000-4000-8000-000000000004',
  'legacy-recurring-repair-school', 'STUDENT', 'ACTIVE', true
);
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_type, billing_type
) values
  (
    '58000000-0000-4000-8000-000000000014',
    '58000000-0000-4000-8000-000000000004',
    'legacy-recurring-repair-school', 'pay_verified_deleted_open',
    279, 27900, 'PENDING', 'PENDING', '2026-08-15',
    'SUBSCRIPTION', 'PIX'
  ),
  (
    '58000000-0000-4000-8000-000000000015',
    '58000000-0000-4000-8000-000000000004',
    'legacy-recurring-repair-school', 'pay_verified_deleted_paid',
    279, 27900, 'RECEIVED', 'RECEIVED', '2026-07-15',
    'SUBSCRIPTION', 'PIX'
  );
set local app.enrollment_claim = '1';
update public.profiles
   set asaas_customer_id = 'cus_verified_deleted'
 where id = '58000000-0000-4000-8000-000000000004';
set local app.enrollment_claim = '';

insert into public.asaas_webhook_inbox (
  provider_event_id, event_name, provider_entity_id, event_created_at,
  payload, payload_hash, status, lease_owner, lease_expires_at
) values
  (
    'evt_verified_deleted_open', 'PAYMENT_DELETED',
    'pay_verified_deleted_open', '2026-08-29 13:00:00+00',
    jsonb_build_object(
      'id', 'evt_verified_deleted_open', 'event', 'PAYMENT_DELETED',
      'dateCreated', '2026-08-29 13:00:00',
      'payment', jsonb_build_object(
        'id', 'pay_verified_deleted_open',
        'customer', 'cus_verified_deleted',
        'subscription', 'sub_verified_deleted',
        'externalReference', null, 'value', 279,
        'dueDate', '2026-08-15', 'status', 'PENDING'
      )
    ),
    'deleted-open-hash', 'PROCESSING',
    '58000000-0000-4000-8000-000000000100',
    pg_catalog.now() + interval '10 minutes'
  ),
  (
    'evt_verified_deleted_paid', 'PAYMENT_DELETED',
    'pay_verified_deleted_paid', '2026-08-29 13:01:00+00',
    jsonb_build_object(
      'id', 'evt_verified_deleted_paid', 'event', 'PAYMENT_DELETED',
      'dateCreated', '2026-08-29 13:01:00',
      'payment', jsonb_build_object(
        'id', 'pay_verified_deleted_paid',
        'customer', 'cus_verified_deleted',
        'subscription', 'sub_verified_deleted',
        'externalReference', null, 'value', 279,
        'dueDate', '2026-07-15', 'status', 'PENDING'
      )
    ),
    'deleted-paid-hash', 'PROCESSING',
    '58000000-0000-4000-8000-000000000100',
    pg_catalog.now() + interval '10 minutes'
  );

select pg_temp.assert_true(
  (
    public.apply_verified_unsettled_asaas_payment_deletion(
      'evt_verified_deleted_open',
      '58000000-0000-4000-8000-000000000014',
      '58000000-0000-4000-8000-000000000004',
      'legacy-recurring-repair-school',
      'cus_verified_deleted', 'sub_verified_deleted',
      '2026-08-29 13:00:00+00', 100,
      (select payload from public.asaas_webhook_inbox
        where provider_event_id = 'evt_verified_deleted_open'),
      jsonb_build_object(
        'id', 'pay_verified_deleted_open',
        'customer', 'cus_verified_deleted',
        'subscription', 'sub_verified_deleted',
        'externalReference', null, 'value', 279,
        'dueDate', '2026-08-15', 'status', 'PENDING',
        'deleted', false
      )
    ) ->> 'reason'
  ) = 'deleted_payment_provider_evidence_mismatch'
  and (
    select status = 'PENDING'
      from public.student_payments
     where id = '58000000-0000-4000-8000-000000000014'
  ),
  'an unverified deletion changed an open local payment'
);

create temporary table verified_deletion_results (
  label text primary key,
  payload jsonb not null
);

insert into verified_deletion_results (label, payload)
select
  'open',
  public.apply_verified_unsettled_asaas_payment_deletion(
      'evt_verified_deleted_open',
      '58000000-0000-4000-8000-000000000014',
      '58000000-0000-4000-8000-000000000004',
      'legacy-recurring-repair-school',
      'cus_verified_deleted', 'sub_verified_deleted',
      '2026-08-29 13:00:00+00', 100,
      (select payload from public.asaas_webhook_inbox
        where provider_event_id = 'evt_verified_deleted_open'),
      jsonb_build_object(
        'id', 'pay_verified_deleted_open',
        'customer', 'cus_verified_deleted',
        'subscription', 'sub_verified_deleted',
        'externalReference', null, 'value', 279,
        'dueDate', '2026-08-15', 'status', 'PENDING',
        'creditDate', null, 'deleted', true
      )
    );

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'CANCELLED'
      from verified_deletion_results
     where label = 'open'
  )
  and (
    select status = 'CANCELLED'
           and provider_status = 'DELETED'
           and last_provider_event_id = 'evt_verified_deleted_open'
           and last_provider_event_rank = 100
      from public.student_payments
     where id = '58000000-0000-4000-8000-000000000014'
  ),
  'exact provider deletion did not close the never-settled payment'
);

select pg_temp.assert_true(
  (
    public.apply_verified_unsettled_asaas_payment_deletion(
      'evt_verified_deleted_paid',
      '58000000-0000-4000-8000-000000000015',
      '58000000-0000-4000-8000-000000000004',
      'legacy-recurring-repair-school',
      'cus_verified_deleted', 'sub_verified_deleted',
      '2026-08-29 13:01:00+00', 100,
      (select payload from public.asaas_webhook_inbox
        where provider_event_id = 'evt_verified_deleted_paid'),
      jsonb_build_object(
        'id', 'pay_verified_deleted_paid',
        'customer', 'cus_verified_deleted',
        'subscription', 'sub_verified_deleted',
        'externalReference', null, 'value', 279,
        'dueDate', '2026-07-15', 'status', 'PENDING',
        'creditDate', null, 'deleted', true
      )
    ) ->> 'reason'
  ) = 'deleted_payment_not_proven_unsettled'
  and (
    select status = 'RECEIVED'
      from public.student_payments
     where id = '58000000-0000-4000-8000-000000000015'
  ),
  'a historically received payment was cancelled by PAYMENT_DELETED'
);

rollback;
