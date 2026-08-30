-- Student offboarding freezes the current-competence decision, converges local
-- invoices/forecasts, preserves cash, and makes suspension safely reversible.

\set ON_ERROR_STOP on

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

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  false
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.begin_student_offboarding_with_billing_policy(text,uuid,uuid,text,text,text,date,uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.begin_student_reactivation(text,uuid,uuid,uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.abort_student_lifecycle_operation(uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.student_lifecycle_operation_attention()',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finalize_student_offboarding_with_billing_policy(uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finalize_student_reactivation(uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.abort_student_lifecycle_operation(uuid,uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.student_lifecycle_operation_attention()',
    'EXECUTE'
  )
  and not has_table_privilege(
    'authenticated', 'public.student_billing_exemptions', 'SELECT'
  ),
  'offboarding policy server boundary is exposed to a browser role'
);

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values (
  'student-offboarding-policy-school',
  'Student Offboarding Policy School',
  'student-offboarding-policy-school',
  'active',
  false
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '59000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'waive-policy@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Waive Policy"}', now(), now()
  ),
  (
    '59000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'charge-policy@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Charge Policy"}', now(), now()
  ),
  (
    '59000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'pause-policy@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Pause Policy"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'student-offboarding-policy-school',
       role = 'STUDENT',
       status = 'Ativo',
       lifecycle_status = 'active',
       monthly_fee = 279,
       due_day = 15,
       asaas_customer_id = case id
         when '59000000-0000-4000-8000-000000000001'::uuid
           then 'cus_policy_waive'
         when '59000000-0000-4000-8000-000000000002'::uuid
           then 'cus_policy_charge'
         else 'cus_policy_pause'
       end,
       subscription_id = case id
         when '59000000-0000-4000-8000-000000000001'::uuid
           then 'sub_policy_waive'
         when '59000000-0000-4000-8000-000000000002'::uuid
           then 'sub_policy_charge'
         else 'sub_policy_pause'
       end,
       enrollment_payment_id = case
         when id = '59000000-0000-4000-8000-000000000003'::uuid
           then 'pay_policy_enrollment_paid'
         else null
       end
 where id in (
   '59000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002',
   '59000000-0000-4000-8000-000000000003'
 );
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id in (
   '59000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002',
   '59000000-0000-4000-8000-000000000003'
 );
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  (
    '59000000-0000-4000-8000-000000000001',
    'student-offboarding-policy-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '59000000-0000-4000-8000-000000000002',
    'student-offboarding-policy-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '59000000-0000-4000-8000-000000000003',
    'student-offboarding-policy-school', 'STUDENT', 'ACTIVE', true
  );

create temporary table policy_clock as
select
  (pg_catalog.now() at time zone 'America/Sao_Paulo')::date as today,
  pg_catalog.date_trunc(
    'month', pg_catalog.now() at time zone 'America/Sao_Paulo'
  )::date as period_start;

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_type, billing_type
)
select
  fixture.id,
  fixture.student_id,
  'student-offboarding-policy-school',
  fixture.provider_id,
  279,
  27900,
  fixture.status,
  fixture.status,
  clock.period_start + fixture.month_offset * interval '1 month' +
    interval '14 days',
  'SUBSCRIPTION',
  'PIX'
from policy_clock as clock
cross join lateral (
  values
    (
      '59000000-0000-4000-8000-000000000011'::uuid,
      '59000000-0000-4000-8000-000000000001'::uuid,
      'pay_policy_waive_current', 'OVERDUE', 0
    ),
    (
      '59000000-0000-4000-8000-000000000012'::uuid,
      '59000000-0000-4000-8000-000000000001'::uuid,
      'pay_policy_waive_future', 'PENDING', 1
    ),
    (
      '59000000-0000-4000-8000-000000000021'::uuid,
      '59000000-0000-4000-8000-000000000002'::uuid,
      'pay_policy_charge_current', 'CONFIRMED', 0
    ),
    (
      '59000000-0000-4000-8000-000000000022'::uuid,
      '59000000-0000-4000-8000-000000000002'::uuid,
      'pay_policy_charge_future', 'PENDING', 1
    ),
    (
      '59000000-0000-4000-8000-000000000031'::uuid,
      '59000000-0000-4000-8000-000000000003'::uuid,
      'pay_policy_pause_current', 'PENDING', 0
    )
) as fixture(id, student_id, provider_id, status, month_offset);

insert into public.monthly_payment_obligations (
  tenant_id, period_start, student_id, roster_source,
  expected_amount, billed_amount, status,
  payment_ids
)
select
  'student-offboarding-policy-school',
  clock.period_start,
  '59000000-0000-4000-8000-000000000001',
  'RECORDED_INVOICE',
  279,
  279,
  'OPEN',
  array['59000000-0000-4000-8000-000000000011'::uuid]
from policy_clock as clock;

-- Forecast sem fatura: um desligamento retroativo/assinatura já ausente também
-- precisa retirar a competência, não apenas as cobranças do snapshot.
insert into public.monthly_payment_obligations (
  tenant_id, period_start, student_id, roster_source,
  expected_amount, billed_amount, settled_amount, status, payment_ids
)
select
  'student-offboarding-policy-school',
  clock.period_start + interval '2 months',
  '59000000-0000-4000-8000-000000000002',
  'RECORDED_INVOICE',
  279,
  0,
  0,
  'MISSING_BILL',
  '{}'
from policy_clock as clock;

create temporary table policy_results (
  label text primary key,
  payload jsonb not null
);

insert into policy_results (label, payload)
select 'waive_begin', public.begin_student_offboarding_with_billing_policy(
  'student-offboarding-policy-school',
  '59000000-0000-4000-8000-000000000001',
  null,
  'offboarded',
  'Fixture waiver',
  'WAIVE_CURRENT_MONTH',
  clock.today,
  '59000000-0000-4000-8000-000000000101',
  300
)
from policy_clock as clock;

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PROCEED'
       and payload ->> 'billing_policy' = 'WAIVE_CURRENT_MONTH'
       and pg_catalog.jsonb_array_length(payload -> 'payment_snapshot') = 2
      from policy_results where label = 'waive_begin'
  ),
  'waiver did not freeze current and future unpaid invoices'
);

update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE'
 where id = (
   select (payload ->> 'operation_id')::uuid
     from policy_results where label = 'waive_begin'
 );

insert into policy_results (label, payload)
select 'waive_finalize',
       public.finalize_student_offboarding_with_billing_policy(
         (payload ->> 'operation_id')::uuid,
         '59000000-0000-4000-8000-000000000101'
       )
  from policy_results
 where label = 'waive_begin';

select pg_temp.assert_true(
  (
    select lifecycle_status = 'offboarded'
       and status = 'Inativo'
       and subscription_id is null
       and asaas_subscription_status = 'NOT_FOUND'
       and asaas_subscription_synced_at is not null
      from public.profiles
     where id = '59000000-0000-4000-8000-000000000001'
  )
  and (
    select subscription_id = 'sub_policy_waive'
       and provider_subscription_final_status = 'NOT_FOUND'
      from public.student_offboarding_operations
     where id = (
       select (payload ->> 'operation_id')::uuid
         from policy_results where label = 'waive_begin'
     )
  )
  and (
    select pg_catalog.count(*) = 2
      from public.student_payments
     where student_id = '59000000-0000-4000-8000-000000000001'
       and status = 'CANCELLED'
  )
  and (
    select pg_catalog.count(*) = 2
      from public.student_billing_exemptions
     where student_id = '59000000-0000-4000-8000-000000000001'
  )
  and (
    select status = 'EXCLUDED'
       and billed_amount = 0
       and settled_amount = 0
      from public.monthly_payment_obligations
     where tenant_id = 'student-offboarding-policy-school'
       and student_id = '59000000-0000-4000-8000-000000000001'
       and period_start = (select period_start from policy_clock)
  ),
  'waiver left a local charge, forecast, or active roster state behind'
);

insert into public.monthly_payment_obligations (
  tenant_id, period_start, student_id, roster_source, expected_amount
)
select
  'student-offboarding-policy-school',
  clock.period_start + interval '1 month',
  '59000000-0000-4000-8000-000000000001',
  'RECORDED_INVOICE',
  279
from policy_clock as clock;

select pg_temp.assert_true(
  not exists (
    select 1 from public.monthly_payment_obligations
     where tenant_id = 'student-offboarding-policy-school'
       and student_id = '59000000-0000-4000-8000-000000000001'
       and period_start = (
         select period_start + interval '1 month' from policy_clock
       )
  ),
  'an exempt future competence was reintroduced into the forecast'
);

-- A confirmed current charge cannot be waived and must not create a blocked
-- operation. The coordinator can immediately choose to charge the month.
insert into policy_results (label, payload)
select 'confirmed_waive_rejected',
       public.begin_student_offboarding_with_billing_policy(
         'student-offboarding-policy-school',
         '59000000-0000-4000-8000-000000000002',
         null,
         'offboarded',
         'Fixture confirmed charge',
         'WAIVE_CURRENT_MONTH',
         clock.today,
         '59000000-0000-4000-8000-000000000102',
         300
       )
  from policy_clock as clock;

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'REVIEW_REQUIRED'
       and payload ->> 'reason' = 'current_period_not_waivable'
      from policy_results where label = 'confirmed_waive_rejected'
  )
  and not exists (
    select 1 from public.student_offboarding_operations
     where student_id = '59000000-0000-4000-8000-000000000002'
  ),
  'confirmed cash path created an irreversible waiver operation'
);

insert into policy_results (label, payload)
select 'charge_begin', public.begin_student_offboarding_with_billing_policy(
  'student-offboarding-policy-school',
  '59000000-0000-4000-8000-000000000002',
  null,
  'offboarded',
  'Fixture charge month',
  'CHARGE_CURRENT_MONTH',
  clock.today,
  '59000000-0000-4000-8000-000000000103',
  300
)
from policy_clock as clock;

select pg_temp.assert_true(
  (
    select pg_catalog.jsonb_array_length(payload -> 'payment_snapshot') = 1
       and pg_catalog.jsonb_array_length(
         payload -> 'preserved_payment_snapshot'
       ) = 1
       and (payload -> 'preserved_payment_snapshot' -> 0 ->> 'id')::uuid =
         '59000000-0000-4000-8000-000000000021'::uuid
       and payload ->> 'provider_subscription_final_status' = 'INACTIVE'
      from policy_results where label = 'charge_begin'
  ),
  'charge-current policy did not isolate future invoices'
);

update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE'
 where id = (
   select (payload ->> 'operation_id')::uuid
     from policy_results where label = 'charge_begin'
 );

-- The current competence is a separate PRESERVE snapshot. It must fail closed
-- if that charge disappears and must never be routed into cancellation logic.
update public.student_payments
   set status = 'CANCELLED', provider_status = 'DELETED'
 where id = '59000000-0000-4000-8000-000000000021';
insert into policy_results (label, payload)
select 'charge_finalize_preserved_race',
       public.finalize_student_offboarding_with_billing_policy(
         (payload ->> 'operation_id')::uuid,
         '59000000-0000-4000-8000-000000000103'
       )
  from policy_results
 where label = 'charge_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'reason' = 'preserved_payment_snapshot_changed'
      from policy_results where label = 'charge_finalize_preserved_race'
  )
  and (
    select lifecycle_status = 'active'
      from public.profiles
     where id = '59000000-0000-4000-8000-000000000002'
  )
  and not exists (
    select 1 from public.student_billing_exemptions
     where student_id = '59000000-0000-4000-8000-000000000002'
  ),
  'a changed current PRESERVE charge reached local cancellation/finalization'
);

update public.student_payments
   set status = 'CONFIRMED', provider_status = 'CONFIRMED'
 where id = '59000000-0000-4000-8000-000000000021';
update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE', last_error = null
 where id = (
   select (payload ->> 'operation_id')::uuid
     from policy_results where label = 'charge_begin'
 );

-- Uma liquidação que vence a corrida depois do preflight nunca pode virar
-- isenção nem zerar caixa/previsão real.
update public.student_payments
   set status = 'CONFIRMED', provider_status = 'CONFIRMED'
 where id = '59000000-0000-4000-8000-000000000022';
insert into policy_results (label, payload)
select 'charge_finalize_settlement_race',
       public.finalize_student_offboarding_with_billing_policy(
         (payload ->> 'operation_id')::uuid,
         '59000000-0000-4000-8000-000000000103'
       )
  from policy_results
 where label = 'charge_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'reason' = 'payment_snapshot_changed'
      from policy_results where label = 'charge_finalize_settlement_race'
  )
  and (
    select lifecycle_status = 'active'
      from public.profiles
     where id = '59000000-0000-4000-8000-000000000002'
  )
  and not exists (
    select 1 from public.student_billing_exemptions
     where student_id = '59000000-0000-4000-8000-000000000002'
  ),
  'a future settlement race was converted into an exemption'
);

insert into policy_results (label, payload)
values (
  'blocked_financial_recompute',
  public.recompute_student_financial_status(
    'student-offboarding-policy-school',
    '59000000-0000-4000-8000-000000000002'
  )
);
select pg_temp.assert_true(
  (
    select payload ->> 'action' <> 'PRESERVED'
      from policy_results where label = 'blocked_financial_recompute'
  ),
  'a BLOCKED lifecycle operation froze financial truth indefinitely'
);

update public.student_payments
   set status = 'PENDING', provider_status = 'PENDING'
 where id = '59000000-0000-4000-8000-000000000022';
update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE', last_error = null
 where id = (
   select (payload ->> 'operation_id')::uuid
     from policy_results where label = 'charge_begin'
 );

insert into policy_results (label, payload)
select 'charge_finalize',
       public.finalize_student_offboarding_with_billing_policy(
         (payload ->> 'operation_id')::uuid,
         '59000000-0000-4000-8000-000000000103'
       )
  from policy_results
 where label = 'charge_begin';

select pg_temp.assert_true(
  (
    select status = 'CONFIRMED'
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000021'
  )
  and (
    select lifecycle_status = 'offboarded'
       and subscription_id = 'sub_policy_charge'
       and asaas_subscription_status = 'INACTIVE'
       and asaas_subscription_synced_at is not null
      from public.profiles
     where id = '59000000-0000-4000-8000-000000000002'
  )
  and (
    select status = 'CANCELLED'
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000022'
  )
  and (
    select status = 'EXCLUDED'
       and billed_amount = 0
       and settled_amount = 0
      from public.monthly_payment_obligations
     where tenant_id = 'student-offboarding-policy-school'
       and student_id = '59000000-0000-4000-8000-000000000002'
       and period_start = (
         select period_start + interval '2 months' from policy_clock
       )
  )
  and exists (
    select 1 from public.student_billing_exemptions
     where tenant_id = 'student-offboarding-policy-school'
       and student_id = '59000000-0000-4000-8000-000000000002'
       and period_start = (
         select period_start + interval '2 months' from policy_clock
       )
  ),
  'charge-current policy changed cash or kept an invoice-free future forecast'
);

-- Suspension keeps existing invoices, and reactivation returns both lifecycle
-- and the legacy status field to the active state after the provider fence.
insert into policy_results (label, payload)
select 'pause_begin', public.begin_student_offboarding_with_billing_policy(
  'student-offboarding-policy-school',
  '59000000-0000-4000-8000-000000000003',
  null,
  'suspended',
  'Fixture pause',
  'KEEP_OPEN_INVOICES',
  clock.today,
  '59000000-0000-4000-8000-000000000104',
  300
)
from policy_clock as clock;

update public.student_offboarding_operations
   set lease_expires_at = pg_catalog.now() - interval '1 second'
 where id = (
   select (payload ->> 'operation_id')::uuid
     from policy_results where label = 'pause_begin'
 );
insert into policy_results (label, payload)
select 'pause_reason_drift', public.begin_student_offboarding_with_billing_policy(
  'student-offboarding-policy-school',
  '59000000-0000-4000-8000-000000000003',
  null,
  'suspended',
  'Different retry reason',
  'KEEP_OPEN_INVOICES',
  clock.today,
  '59000000-0000-4000-8000-000000000109',
  300
)
from policy_clock as clock;

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'REVIEW_REQUIRED'
       and payload ->> 'reason' = 'offboarding_reason_snapshot_mismatch'
      from policy_results where label = 'pause_reason_drift'
  ),
  'a retry changed the frozen offboarding reason'
);

insert into policy_results (label, payload)
select 'pause_recovered_begin',
       public.begin_student_offboarding_with_billing_policy(
         'student-offboarding-policy-school',
         '59000000-0000-4000-8000-000000000003',
         null,
         'suspended',
         'Fixture pause',
         'KEEP_OPEN_INVOICES',
         (select today from policy_clock),
         '59000000-0000-4000-8000-000000000104',
         300
       );

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PROCEED'
      from policy_results where label = 'pause_recovered_begin'
  ) and exists (
    select 1
      from public.student_offboarding_operations
     where id = (
       select (payload ->> 'operation_id')::uuid
         from policy_results where label = 'pause_reason_drift'
     )
       and status = 'ABORTED'
       and snapshot ? 'pre_provider_block_released_at'
       and snapshot ->> 'pre_provider_block_last_error' =
         'offboarding_reason_snapshot_mismatch'
  ),
  'offboarding begin did not atomically recover a pre-provider BLOCKED claim'
);

update policy_results
   set payload = (
     select recovered.payload
       from policy_results as recovered
      where recovered.label = 'pause_recovered_begin'
   )
 where label = 'pause_begin';

insert into policy_results (label, payload)
select 'pause_bind', public.bind_student_offboarding_integrations(
  (payload ->> 'operation_id')::uuid,
  '59000000-0000-4000-8000-000000000104',
  'integration_policy_subscription',
  1,
  'production',
  'TENANT_BYOK',
  null,
  null,
  null,
  null
)
from policy_results
where label = 'pause_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'BOUND'
      from policy_results where label = 'pause_bind'
  ),
  'one-time enrollment charge incorrectly required a payment integration'
);

update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE'
 where id = (
   select (payload ->> 'operation_id')::uuid
     from policy_results where label = 'pause_begin'
 );
insert into policy_results (label, payload)
select 'pause_finalize',
       public.finalize_student_offboarding_with_billing_policy(
         (payload ->> 'operation_id')::uuid,
         '59000000-0000-4000-8000-000000000104'
       )
  from policy_results
 where label = 'pause_begin';

select pg_temp.assert_true(
  (
    select lifecycle_status = 'suspended'
       and status = 'Inativo'
       and subscription_id = 'sub_policy_pause'
       and asaas_subscription_status = 'INACTIVE'
       and asaas_subscription_synced_at is not null
      from public.profiles
     where id = '59000000-0000-4000-8000-000000000003'
  )
  and (
    select status = 'PENDING'
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000031'
  ),
  'suspension cancelled an existing invoice or left the roster active'
);

insert into policy_results (label, payload)
select 'reactivate_preblocked_begin', public.begin_student_reactivation(
  'student-offboarding-policy-school',
  '59000000-0000-4000-8000-000000000003',
  null,
  '59000000-0000-4000-8000-000000000107',
  300
);
update public.student_offboarding_operations
   set status = 'BLOCKED',
       provider_started_at = null,
       last_error = 'fixture_pre_provider_reactivation_block'
 where id = (
   select (payload ->> 'operation_id')::uuid
     from policy_results where label = 'reactivate_preblocked_begin'
 );

insert into policy_results (label, payload)
select 'reactivate_recovered_begin', public.begin_student_reactivation(
  'student-offboarding-policy-school',
  '59000000-0000-4000-8000-000000000003',
  null,
  '59000000-0000-4000-8000-000000000108',
  300
);

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PROCEED'
       and payload ->> 'provider_subscription_final_status' = 'ACTIVE'
      from policy_results where label = 'reactivate_recovered_begin'
  ) and exists (
    select 1
      from public.student_offboarding_operations
     where id = (
       select (payload ->> 'operation_id')::uuid
         from policy_results where label = 'reactivate_preblocked_begin'
     )
       and status = 'ABORTED'
       and snapshot ? 'pre_provider_block_released_at'
       and snapshot ->> 'pre_provider_block_last_error' =
         'fixture_pre_provider_reactivation_block'
  ),
  'reactivation begin did not atomically recover a pre-provider BLOCKED claim'
);

insert into policy_results (label, payload)
select 'reactivate_recovered_abort',
       public.abort_student_lifecycle_operation(
         (payload ->> 'operation_id')::uuid,
         '59000000-0000-4000-8000-000000000108',
         'fixture_reactivation_recovery_cleanup'
       )
  from policy_results
 where label = 'reactivate_recovered_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'ABORTED'
      from policy_results where label = 'reactivate_recovered_abort'
  ),
  'reactivation recovery fixture did not release its replacement claim'
);

insert into policy_results (label, payload)
select 'reactivate_unknown_begin', public.begin_student_reactivation(
  'student-offboarding-policy-school',
  '59000000-0000-4000-8000-000000000003',
  null,
  '59000000-0000-4000-8000-000000000105',
  300
);

update public.student_offboarding_operations
   set status = 'UNKNOWN', provider_started_at = pg_catalog.now()
 where id = (
   select (payload ->> 'operation_id')::uuid
     from policy_results where label = 'reactivate_unknown_begin'
 );
insert into policy_results (label, payload)
select 'reactivate_unknown_abort', public.abort_student_lifecycle_operation(
  (payload ->> 'operation_id')::uuid,
  '59000000-0000-4000-8000-000000000105',
  'subscription_absent_new_enrollment_required'
)
from policy_results
where label = 'reactivate_unknown_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'ABORTED'
      from policy_results where label = 'reactivate_unknown_abort'
  ) and exists (
    select 1 from public.student_offboarding_operations
     where id = (
       select (payload ->> 'operation_id')::uuid
         from policy_results where label = 'reactivate_unknown_begin'
     )
       and status = 'ABORTED'
  ),
  'a proven-absent reactivation could not release its durable operation fence'
);

insert into policy_results (label, payload)
select 'reactivate_begin', public.begin_student_reactivation(
  'student-offboarding-policy-school',
  '59000000-0000-4000-8000-000000000003',
  null,
  '59000000-0000-4000-8000-000000000106',
  300
);

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PROCEED'
       and (payload ->> 'due_day')::integer = 15
       and (payload ->> 'monthly_fee')::numeric = 279
       and payload ->> 'provider_subscription_final_status' = 'ACTIVE'
      from policy_results where label = 'reactivate_begin'
  ),
  'reactivation did not freeze the canonical billing terms'
);

-- Existing-row authority and billing-term edits serialize on their row lock;
-- after the begin commits they must fail closed while Asaas is in flight.
do $profile_guard$
begin
  begin
    update public.profiles
       set due_day = 16
     where id = '59000000-0000-4000-8000-000000000003';
    raise exception 'profile lifecycle guard did not reject due-day drift';
  exception when sqlstate '55000' then
    null;
  end;
end;
$profile_guard$;

do $membership_guard$
begin
  begin
    update public.tenant_memberships
       set status = 'INACTIVE'
     where user_id = '59000000-0000-4000-8000-000000000003';
    raise exception 'membership lifecycle guard did not freeze authority';
  exception when sqlstate '55000' then
    null;
  end;
end;
$membership_guard$;

update public.student_payments
   set status = 'RECEIVED', provider_status = 'RECEIVED',
       payment_date = (select today from policy_clock)
 where id = '59000000-0000-4000-8000-000000000031';
update public.profiles
   set status_financial = 'OVERDUE'
 where id = '59000000-0000-4000-8000-000000000003';

update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE'
 where id = (
   select (payload ->> 'operation_id')::uuid
     from policy_results where label = 'reactivate_begin'
 );
insert into policy_results (label, payload)
select 'reactivate_finalize', public.finalize_student_reactivation(
  (payload ->> 'operation_id')::uuid,
  '59000000-0000-4000-8000-000000000106'
)
from policy_results
where label = 'reactivate_begin';

select pg_temp.assert_true(
  (
    select lifecycle_status = 'active'
       and status = 'Ativo'
       and due_day = 15
       and status_financial = 'ACTIVE'
       and subscription_id = 'sub_policy_pause'
       and asaas_subscription_status = 'ACTIVE'
       and asaas_subscription_synced_at is not null
      from public.profiles
     where id = '59000000-0000-4000-8000-000000000003'
  ),
  'reactivation did not restore the canonical and legacy roster states'
);

rollback;
