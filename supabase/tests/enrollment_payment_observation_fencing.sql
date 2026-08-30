-- Enrollment payment observations may consume only the durable, ordered local
-- payment event, and monthly generation must share lifecycle/period fences.

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
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.apply_enrollment_payment_observation(text,uuid,uuid,text,text,text,text,text,numeric,text,text,date,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.apply_enrollment_payment_observation(text,uuid,uuid,text,text,text,text,text,numeric,text,text,date,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.apply_enrollment_payment_observation(text,uuid,uuid,text,text,text,text,text,numeric,text,text,date,text,text)',
    'EXECUTE'
  ),
  'enrollment observation RPC privileges are unsafe'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.resolve_enrollment_payment_observation_binding(text,uuid,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.resolve_enrollment_payment_observation_binding(text,uuid,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.resolve_enrollment_payment_observation_binding(text,uuid,text,text,text)',
    'EXECUTE'
  ),
  'enrollment binding resolver RPC privileges are unsafe'
);

select pg_temp.assert_true(
  position(
    'student-billing-lifecycle:' in pg_get_functiondef(
      'public.generate_monthly_student_payments(text,date)'::regprocedure
    )
  ) > 0
  and position(
    'MONTHLY_LEDGER' in pg_get_functiondef(
      'public.generate_monthly_student_payments(text,date)'::regprocedure
    )
  ) > 0,
  'monthly generation lost lifecycle or billing-period serialization'
);

insert into public.tenants (id, name, slug, saas_status)
values (
  'enrollment-observation-fence',
  'Enrollment Observation Fence',
  'enrollment-observation-fence',
  'active'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000e501',
  'authenticated',
  'authenticated',
  'enrollment-observation@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Enrollment Observation"}',
  now(),
  now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'enrollment-observation-fence',
       role = 'STUDENT',
       status = 'Ativo',
       lifecycle_status = 'active',
       full_name = 'Enrollment Observation',
       asaas_customer_id = 'cus_enrollment_observation',
       enrollment_payment_id = 'pay_enrollment_fee_observation',
       enrollment_fee_paid = false,
       monthly_fee = 100,
       due_day = 10
 where id = '00000000-0000-4000-8000-00000000e501';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id = '00000000-0000-4000-8000-00000000e501';
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '00000000-0000-4000-8000-00000000e501',
  'enrollment-observation-fence',
  'STUDENT',
  'ACTIVE',
  true
);

insert into public.offers (
  id,
  kind,
  tenant_id,
  payload,
  expires_at,
  created_by,
  requires_enrollment,
  enrollment_fee,
  processing_by,
  processing_state,
  metadata,
  invite_security_version
) values (
  '10000000-0000-4000-8000-00000000e501',
  'ENROLLMENT',
  'enrollment-observation-fence',
  '{"planDuration":0,"value":100}'::jsonb,
  now() + interval '1 day',
  '00000000-0000-4000-8000-00000000e501',
  true,
  25,
  '00000000-0000-4000-8000-00000000e501',
  'AWAITING_PAYMENT',
  '{"enrollment_payment_id":"pay_enrollment_fee_observation"}'::jsonb,
  1
);

create temporary table observation_results (
  label text primary key,
  payload jsonb not null
);

-- A legacy snapshot may carry a stale proportional value even though the
-- school explicitly opted out. The flag is authoritative at every boundary:
-- resolver, observation, refund reopening and enrollment completion.
insert into public.offers (
  id, kind, tenant_id, payload, expires_at, created_by,
  requires_enrollment, enrollment_fee, processing_by, processing_state,
  metadata, invite_security_version
) values (
  '10000000-0000-4000-8000-00000000e50f',
  'ENROLLMENT',
  'enrollment-observation-fence',
  jsonb_build_object(
    'planDuration', 12,
    'value', 100,
    'enableProRata', false,
    'proRataValue', 84.52,
    'proRataFormulaVersion', 'weekly-frequency-times-4-v1',
    'proRataIntervalStartInclusive', '2031-08-01',
    'proRataIntervalEndExclusive', '2031-09-10',
    'proRataClassCount', 4,
    'pricePerClass', 21.13,
    'startDate', '2031-08-01',
    'firstBillingDate', '2031-09-10'
  ),
  now() + interval '1 day',
  '00000000-0000-4000-8000-00000000e501',
  true,
  0,
  '00000000-0000-4000-8000-00000000e501',
  'AWAITING_PAYMENT',
  jsonb_build_object(
    'asaas_customer_id', 'cus_enrollment_observation',
    'subscription_id', 'sub_disabled_prorata',
    'financial_profile_offer_id',
      '10000000-0000-4000-8000-00000000e50f',
    'pro_rata_charge_id', 'pay_legacy_disabled_prorata',
    'pro_rata_formula_version', 'weekly-frequency-times-4-v1',
    'pro_rata_interval_start_inclusive', '2031-08-01',
    'pro_rata_interval_end_exclusive', '2031-09-10',
    'pro_rata_class_count', 4,
    'price_per_class', 21.13,
    'pro_rata_value', 84.52
  ),
  1
);

insert into observation_results values (
  'disabled-prorata-resolver-explicit',
  public.resolve_enrollment_payment_observation_binding(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    'pay_legacy_disabled_prorata',
    'enrollment:10000000-0000-4000-8000-00000000e50f:pro-rata',
    'SETTLED'
  )
);
insert into observation_results values (
  'disabled-prorata-resolver-without-reference',
  public.resolve_enrollment_payment_observation_binding(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    'pay_legacy_disabled_prorata',
    null,
    'SETTLED'
  )
);
insert into observation_results values (
  'disabled-prorata-observation',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e50f',
    'pay_legacy_disabled_prorata',
    'cus_enrollment_observation',
    -- Subscription identity belongs only to SUBSCRIPTION_ACTIVATION events;
    -- the stale binding under test remains confined to the offer metadata.
    null,
    'PRO_RATA',
    'SETTLED',
    84.52,
    'enrollment:10000000-0000-4000-8000-00000000e50f:pro-rata',
    'RECEIVED',
    date '2031-08-10',
    'PIX',
    'Valor proporcional legado'
  )
);
insert into observation_results values (
  'disabled-prorata-reopen',
  public.reopen_enrollment_offer_for_unsettled_payment(
    '10000000-0000-4000-8000-00000000e50f',
    '00000000-0000-4000-8000-00000000e501',
    'pay_legacy_disabled_prorata',
    'payment_refunded'
  )
);

update public.profiles
   set subscription_id = 'sub_disabled_prorata',
       enrollment_payment_id = null
 where id = '00000000-0000-4000-8000-00000000e501';
insert into observation_results values (
  'disabled-prorata-complete-with-stale-binding',
  public.complete_enrollment_offer(
    '10000000-0000-4000-8000-00000000e50f',
    '00000000-0000-4000-8000-00000000e501'
  )
);
update public.offers
   set metadata = metadata - 'pro_rata_charge_id'
 where id = '10000000-0000-4000-8000-00000000e50f';
insert into observation_results values (
  'disabled-prorata-complete-without-binding',
  public.complete_enrollment_offer(
    '10000000-0000-4000-8000-00000000e50f',
    '00000000-0000-4000-8000-00000000e501'
  )
);
update public.profiles
   set subscription_id = null,
       enrollment_payment_id = 'pay_enrollment_fee_observation'
 where id = '00000000-0000-4000-8000-00000000e501';

select pg_temp.assert_true(
  (select payload ->> 'reason' = 'pro_rata_scope_invalid'
     from observation_results
    where label = 'disabled-prorata-resolver-explicit')
  and (select payload ->> 'action' = 'NONE'
     from observation_results
    where label = 'disabled-prorata-resolver-without-reference')
  and (select payload ->> 'reason' = 'pro_rata_scope_invalid'
     from observation_results
    where label = 'disabled-prorata-observation')
  and (select payload ->> 'reason' = 'payment_not_bound'
     from observation_results
    where label = 'disabled-prorata-reopen')
  and (select payload ->> 'error' = 'PAYMENT_EVENT_NOT_SETTLED'
     from observation_results
    where label = 'disabled-prorata-complete-with-stale-binding')
  and (select payload ->> 'error' = 'PAYMENT_EVENT_NOT_SETTLED'
     from observation_results
    where label = 'disabled-prorata-complete-without-binding'),
  'opt-out legado foi reinterpretado como obrigacao ou pagamento pro-rata'
);

-- A non-settling provider read may establish only a pending local binding.
insert into observation_results values (
  'fee-pending',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e501',
    'pay_enrollment_fee_observation',
    'cus_enrollment_observation',
    null,
    'ENROLLMENT_FEE',
    'PENDING',
    25,
    'enrollment:10000000-0000-4000-8000-00000000e501:fee',
    'PENDING',
    date '2031-08-10',
    'PIX',
    'Taxa de Matricula Wise Wolf School'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'AWAITING_PAYMENT'
     from observation_results where label = 'fee-pending')
  and exists (
    select 1 from public.student_payments
     where asaas_payment_id = 'pay_enrollment_fee_observation'
       and tenant_id = 'enrollment-observation-fence'
       and student_id = '00000000-0000-4000-8000-00000000e501'
       and status = 'PENDING'
  )
  and not (
    select coalesce(enrollment_fee_paid, false)
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000e501'
  ),
  'pending provider observation granted enrollment access'
);

-- A GET claiming settlement cannot outrun the durable signed webhook event.
insert into observation_results values (
  'fee-stale-settlement',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e501',
    'pay_enrollment_fee_observation',
    'cus_enrollment_observation',
    null,
    'ENROLLMENT_FEE',
    'SETTLED',
    25,
    'enrollment:10000000-0000-4000-8000-00000000e501:fee',
    'RECEIVED',
    date '2031-08-10',
    'PIX',
    'Taxa de Matricula Wise Wolf School'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'reason' = 'provider_observation_stale'
     from observation_results where label = 'fee-stale-settlement')
  and not (
    select coalesce(enrollment_fee_paid, false)
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000e501'
  ),
  'stale provider settlement bypassed the durable payment event'
);

update public.student_payments
   set status = 'RECEIVED', provider_status = 'RECEIVED'
 where asaas_payment_id = 'pay_enrollment_fee_observation';

set local request.jwt.claims = '{"role":"service_role"}';
insert into observation_results values (
  'fee-settled',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e501',
    'pay_enrollment_fee_observation',
    'cus_enrollment_observation',
    null,
    'ENROLLMENT_FEE',
    'SETTLED',
    25,
    'enrollment:10000000-0000-4000-8000-00000000e501:fee',
    'RECEIVED',
    date '2031-08-10',
    'PIX',
    'Taxa de Matricula Wise Wolf School'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'BILLING_RECORDED'
     from observation_results where label = 'fee-settled')
  and (
    select enrollment_fee_paid is true
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000e501'
  ),
  'durable enrollment-fee settlement was not recorded'
);

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, amount_cents, status, provider_status, due_date, billing_type,
  payment_method, description, payment_type
) values (
  '20000000-0000-4000-8000-00000000e501',
  '00000000-0000-4000-8000-00000000e501',
  'enrollment-observation-fence',
  'pay_one_time_observation',
  'cus_enrollment_observation',
  100,
  10000,
  'RECEIVED',
  'RECEIVED',
  date '2031-08-10',
  'PIX',
  'PIX',
  'Plano integral',
  'SUBSCRIPTION'
);

insert into observation_results values (
  'one-time-settled',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e501',
    'pay_one_time_observation',
    'cus_enrollment_observation',
    null,
    'ONE_TIME',
    'SETTLED',
    100,
    'enrollment:10000000-0000-4000-8000-00000000e501:one-time',
    'RECEIVED',
    date '2031-08-10',
    'PIX',
    'Plano integral'
  )
);

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'BILLING_RECORDED'
      and payload ->> 'processing_state' = 'BILLING_READY'
      and payload ->> 'completion_error' = 'SCHEDULE_UNAVAILABLE'
    from observation_results where label = 'one-time-settled'
  )
  and (
    select processing_state = 'BILLING_READY'
      and metadata ->> 'one_time_payment_id' = 'pay_one_time_observation'
      from public.offers
     where id = '10000000-0000-4000-8000-00000000e501'
  ),
  'settlement bypassed the authoritative academic schedule barrier'
);

update public.student_payments
   set status = 'REFUNDED', provider_status = 'REFUNDED'
 where asaas_payment_id = 'pay_one_time_observation';

insert into observation_results values (
  'one-time-stale-settled',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e501',
    'pay_one_time_observation',
    'cus_enrollment_observation',
    null,
    'ONE_TIME',
    'SETTLED',
    100,
    'enrollment:10000000-0000-4000-8000-00000000e501:one-time',
    'RECEIVED',
    date '2031-08-10',
    'PIX',
    'Plano integral'
  )
);

insert into observation_results values (
  'one-time-refunded',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e501',
    'pay_one_time_observation',
    'cus_enrollment_observation',
    null,
    'ONE_TIME',
    'UNSETTLED',
    100,
    'enrollment:10000000-0000-4000-8000-00000000e501:one-time',
    'REFUNDED',
    date '2031-08-10',
    'PIX',
    'Plano integral'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'reason' = 'provider_observation_stale'
     from observation_results where label = 'one-time-stale-settled')
  and (select payload ->> 'action' = 'REOPENED'
     from observation_results where label = 'one-time-refunded')
  and (
    select processing_state = 'AWAITING_PAYMENT'
      from public.offers
     where id = '10000000-0000-4000-8000-00000000e501'
  ),
  'refund ordering did not reject stale settlement and reopen enrollment'
);

update public.student_payments
   set status = 'RECEIVED', provider_status = 'RECEIVED'
 where asaas_payment_id = 'pay_one_time_observation';
insert into public.student_offboarding_operations (
  tenant_id, student_id, requested_by, source_lifecycle_status,
  target_lifecycle_status, reason, status, claim_token, lease_expires_at,
  snapshot
) values (
  'enrollment-observation-fence',
  '00000000-0000-4000-8000-00000000e501',
  '00000000-0000-4000-8000-00000000e501',
  'active',
  'suspended',
  'observation fixture',
  'CLAIMED',
  '30000000-0000-4000-8000-00000000e501',
  now() + interval '5 minutes',
  '{}'::jsonb
);

insert into observation_results values (
  'settlement-during-offboarding',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e501',
    'pay_one_time_observation',
    'cus_enrollment_observation',
    null,
    'ONE_TIME',
    'SETTLED',
    100,
    'enrollment:10000000-0000-4000-8000-00000000e501:one-time',
    'RECEIVED',
    date '2031-08-10',
    'PIX',
    'Plano integral'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'reason' = 'student_lifecycle_inactive'
     from observation_results where label = 'settlement-during-offboarding'),
  'offboarding did not fence enrollment settlement side effects'
);

select public.generate_monthly_student_payments(
  'enrollment-observation-fence',
  date '2031-10-01'
);
select pg_temp.assert_true(
  not exists (
    select 1 from public.student_payments
     where tenant_id = 'enrollment-observation-fence'
       and student_id = '00000000-0000-4000-8000-00000000e501'
       and due_date >= date '2031-10-01'
       and due_date < date '2031-11-01'
  ),
  'monthly generator inserted after offboarding had claimed the student'
);

update public.student_offboarding_operations
   set status = 'COMPLETED', completed_at = now()
 where tenant_id = 'enrollment-observation-fence'
   and student_id = '00000000-0000-4000-8000-00000000e501';

select public.generate_monthly_student_payments(
  'enrollment-observation-fence',
  date '2031-10-01'
);
select public.generate_monthly_student_payments(
  'enrollment-observation-fence',
  date '2031-10-01'
);
select pg_temp.assert_true(
  (select count(*) = 1
     from public.student_payments
    where tenant_id = 'enrollment-observation-fence'
      and student_id = '00000000-0000-4000-8000-00000000e501'
      and due_date >= date '2031-10-01'
      and due_date < date '2031-11-01')
  and exists (
    select 1 from public.asaas_student_billing_period_claims
     where tenant_id = 'enrollment-observation-fence'
       and student_id = '00000000-0000-4000-8000-00000000e501'
       and due_date = date '2031-10-10'
       and source = 'MONTHLY_LEDGER'
       and status = 'BOUND'
  ),
  'monthly ledger generation is not period-idempotent'
);

insert into public.asaas_student_billing_period_claims (
  tenant_id, student_id, due_date, source, source_key,
  request_fingerprint, status, claim_token, lease_expires_at
) values (
  'enrollment-observation-fence',
  '00000000-0000-4000-8000-00000000e501',
  date '2031-11-05',
  'MANUAL_PIX',
  'manual-pix:observation-fixture',
  repeat('a', 64),
  'CLAIMED',
  '40000000-0000-4000-8000-00000000e501',
  now() + interval '5 minutes'
);

insert into observation_results values (
  'changed-due-day-period-claim',
  public.claim_asaas_student_billing_period(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    date '2031-11-10',
    'SUBSCRIPTION',
    'subscription:changed-due-day-fixture',
    repeat('b', 64),
    '50000000-0000-4000-8000-00000000e501',
    300
  )
);
select pg_temp.assert_true(
  (select payload ->> 'reason' =
      'billing_period_month_owned_by_another_flow'
     from observation_results
    where label = 'changed-due-day-period-claim'),
  'billing-period claim fence is still keyed only by exact due date'
);

select public.generate_monthly_student_payments(
  'enrollment-observation-fence',
  date '2031-11-01'
);
select pg_temp.assert_true(
  not exists (
    select 1 from public.student_payments
     where tenant_id = 'enrollment-observation-fence'
       and student_id = '00000000-0000-4000-8000-00000000e501'
       and due_date >= date '2031-11-01'
       and due_date < date '2031-12-01'
  ),
  'monthly generator ignored an existing provider period claim'
);

-- Subscription activation is offer- and subscription-exact. A plan change
-- between provider GET and apply cannot complete the replacement contract.
update public.profiles
   set subscription_id = 'sub_activation_old'
 where id = '00000000-0000-4000-8000-00000000e501';
insert into public.offers (
  id, kind, tenant_id, payload, expires_at, created_by,
  requires_enrollment, enrollment_fee, processing_by, processing_state,
  metadata, invite_security_version
) values (
  '10000000-0000-4000-8000-00000000e502',
  'ENROLLMENT',
  'enrollment-observation-fence',
  '{"planDuration":12,"value":100}'::jsonb,
  now() + interval '1 day',
  '00000000-0000-4000-8000-00000000e501',
  true,
  0,
  '00000000-0000-4000-8000-00000000e501',
  'AWAITING_PAYMENT',
  '{"subscription_id":"sub_activation_old"}'::jsonb,
  1
);
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, amount_cents, status, provider_status, due_date, billing_type,
  payment_method, description, payment_type
) values (
  '20000000-0000-4000-8000-00000000e502',
  '00000000-0000-4000-8000-00000000e501',
  'enrollment-observation-fence',
  'pay_subscription_activation',
  'cus_enrollment_observation',
  100,
  10000,
  'RECEIVED',
  'RECEIVED',
  date '2031-12-10',
  'PIX',
  'PIX',
  'Ativacao assinatura',
  'SUBSCRIPTION'
);
insert into observation_results values (
  'activation-resolved-canonical',
  public.resolve_enrollment_payment_observation_binding(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    'pay_subscription_activation',
    'enrollment:10000000-0000-4000-8000-00000000e502:subscription',
    'SETTLED'
  )
);
insert into observation_results values (
  'activation-settled',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e502',
    'pay_subscription_activation',
    'cus_enrollment_observation',
    'sub_activation_old',
    'SUBSCRIPTION_ACTIVATION',
    'SETTLED',
    100,
    'enrollment:10000000-0000-4000-8000-00000000e502:subscription',
    'RECEIVED',
    date '2031-12-10',
    'PIX',
    'Ativacao assinatura'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'payment_kind' = 'SUBSCRIPTION_ACTIVATION'
     and payload ->> 'offer_id' = '10000000-0000-4000-8000-00000000e502'
     from observation_results where label = 'activation-resolved-canonical')
  and (
    select payload ->> 'processing_state' = 'BILLING_READY'
      and payload ->> 'completion_error' = 'SCHEDULE_UNAVAILABLE'
    from observation_results where label = 'activation-settled'
  ),
  'subscription activation bypassed the authoritative schedule barrier'
);

update public.profiles
   set subscription_id = 'sub_activation_new'
 where id = '00000000-0000-4000-8000-00000000e501';
update public.offers
   set metadata = metadata || '{"subscription_id":"sub_activation_new"}'::jsonb
 where id = '10000000-0000-4000-8000-00000000e502';
insert into observation_results values (
  'activation-stale-after-plan-change',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e502',
    'pay_subscription_activation',
    'cus_enrollment_observation',
    'sub_activation_old',
    'SUBSCRIPTION_ACTIVATION',
    'SETTLED',
    100,
    'enrollment:10000000-0000-4000-8000-00000000e502:subscription',
    'RECEIVED',
    date '2031-12-10',
    'PIX',
    'Ativacao assinatura'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'reason' =
      'subscription_activation_payment_binding_mismatch'
     from observation_results where label = 'activation-stale-after-plan-change'),
  'old provider subscription activated a replacement contract'
);

update public.profiles
   set subscription_id = 'sub_activation_old'
 where id = '00000000-0000-4000-8000-00000000e501';
update public.offers
   set metadata = metadata || '{"subscription_id":"sub_activation_old"}'::jsonb
 where id = '10000000-0000-4000-8000-00000000e502';
update public.student_payments
   set status = 'REFUNDED', provider_status = 'REFUNDED'
 where id = '20000000-0000-4000-8000-00000000e502';
insert into observation_results values (
  'activation-resolved-without-reference',
  public.resolve_enrollment_payment_observation_binding(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    'pay_subscription_activation',
    null,
    'UNSETTLED'
  )
);
insert into observation_results values (
  'activation-refunded',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e502',
    'pay_subscription_activation',
    'cus_enrollment_observation',
    'sub_activation_old',
    'SUBSCRIPTION_ACTIVATION',
    'UNSETTLED',
    100,
    'enrollment:10000000-0000-4000-8000-00000000e502:subscription',
    'REFUNDED',
    date '2031-12-10',
    'PIX',
    'Ativacao assinatura'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'offer_id' = '10000000-0000-4000-8000-00000000e502'
     from observation_results where label = 'activation-resolved-without-reference')
  and (select payload ->> 'action' = 'REOPENED'
     from observation_results where label = 'activation-refunded'),
  'reference-less activation reversal did not use exact persisted binding'
);

-- Cross-offer fee identity is fail-closed, including the legacy profile
-- fallback. A historical refund reopens only the old offer and preserves the
-- current profile contract.
insert into public.offers (
  id, kind, tenant_id, payload, expires_at, created_by,
  requires_enrollment, enrollment_fee, processing_by, processing_state,
  metadata, invite_security_version
) values
(
  '10000000-0000-4000-8000-00000000e503', 'ENROLLMENT',
  'enrollment-observation-fence', '{"planDuration":0,"value":100}'::jsonb,
  now() + interval '1 day', '00000000-0000-4000-8000-00000000e501',
  true, 25, '00000000-0000-4000-8000-00000000e501', 'BILLING_READY',
  '{"enrollment_payment_id":"pay_offer_a_fee","one_time_payment_id":"pay_offer_a_one"}'::jsonb,
  1
),
(
  '10000000-0000-4000-8000-00000000e504', 'ENROLLMENT',
  'enrollment-observation-fence', '{"planDuration":0,"value":100}'::jsonb,
  now() + interval '1 day', '00000000-0000-4000-8000-00000000e501',
  true, 25, '00000000-0000-4000-8000-00000000e501', 'BILLING_READY',
  '{"enrollment_payment_id":"pay_offer_b_fee"}'::jsonb,
  1
);
insert into public.student_payments (
  student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, amount_cents, status, provider_status, due_date, billing_type,
  payment_method, description, payment_type, raw_payload
) values
(
  '00000000-0000-4000-8000-00000000e501', 'enrollment-observation-fence',
  'pay_offer_a_fee', 'cus_enrollment_observation', 25, 2500, 'RECEIVED',
  'RECEIVED', date '2032-01-10', 'PIX', 'PIX', 'Taxa A', 'ENROLLMENT',
  '{"payment":{"id":"pay_offer_a_fee","customer":"cus_enrollment_observation","externalReference":"enrollment:10000000-0000-4000-8000-00000000e503:fee"}}'::jsonb
),
(
  '00000000-0000-4000-8000-00000000e501', 'enrollment-observation-fence',
  'pay_offer_b_fee', 'cus_enrollment_observation', 25, 2500, 'RECEIVED',
  'RECEIVED', date '2032-01-10', 'PIX', 'PIX', 'Taxa B', 'ENROLLMENT',
  '{"payment":{"id":"pay_offer_b_fee","customer":"cus_enrollment_observation","externalReference":"enrollment:10000000-0000-4000-8000-00000000e504:fee"}}'::jsonb
),
(
  '00000000-0000-4000-8000-00000000e501', 'enrollment-observation-fence',
  'pay_offer_a_one', 'cus_enrollment_observation', 100, 10000, 'RECEIVED',
  'RECEIVED', date '2032-01-10', 'PIX', 'PIX', 'Plano A', 'SUBSCRIPTION',
  '{"payment":{"id":"pay_offer_a_one","customer":"cus_enrollment_observation","externalReference":"enrollment:10000000-0000-4000-8000-00000000e503:one-time"}}'::jsonb
);
update public.profiles
   set enrollment_payment_id = 'pay_offer_b_fee',
       enrollment_fee_paid = true
 where id = '00000000-0000-4000-8000-00000000e501';
insert into observation_results values (
  'cross-offer-fee-divergence',
  public.complete_enrollment_offer(
    '10000000-0000-4000-8000-00000000e503',
    '00000000-0000-4000-8000-00000000e501'
  )
);
update public.offers
   set metadata = metadata - 'enrollment_payment_id'
 where id = '10000000-0000-4000-8000-00000000e503';
insert into observation_results values (
  'cross-offer-resolver-fallback',
  public.resolve_enrollment_payment_observation_binding(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    'pay_offer_b_fee',
    'enrollment:10000000-0000-4000-8000-00000000e503:fee',
    'SETTLED'
  )
);
insert into observation_results values (
  'cross-offer-apply-fallback',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e503',
    'pay_offer_b_fee',
    'cus_enrollment_observation',
    null,
    'ENROLLMENT_FEE',
    'SETTLED',
    25,
    'enrollment:10000000-0000-4000-8000-00000000e503:fee',
    'RECEIVED',
    date '2032-01-10',
    'PIX',
    'Taxa B'
  )
);
insert into observation_results values (
  'cross-offer-profile-fallback',
  public.complete_enrollment_offer(
    '10000000-0000-4000-8000-00000000e503',
    '00000000-0000-4000-8000-00000000e501'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'error' = 'SCHEDULE_UNAVAILABLE'
     from observation_results where label = 'cross-offer-fee-divergence')
  and (select payload ->> 'reason' = 'enrollment_payment_binding_mismatch'
     from observation_results where label = 'cross-offer-resolver-fallback')
  and (select payload ->> 'reason' = 'enrollment_payment_binding_mismatch'
     from observation_results where label = 'cross-offer-apply-fallback')
  and (select payload ->> 'error' = 'SCHEDULE_UNAVAILABLE'
     from observation_results where label = 'cross-offer-profile-fallback'),
  'cross-offer binding or academic schedule barrier was bypassed'
);

update public.offers
   set metadata = metadata || '{"enrollment_payment_id":"pay_offer_a_fee"}'::jsonb,
       processing_state = 'COMPLETED'
 where id = '10000000-0000-4000-8000-00000000e503';
insert into observation_results values (
  'historical-fee-refund-preserves-current-profile',
  public.reopen_enrollment_offer_for_unsettled_payment(
    '10000000-0000-4000-8000-00000000e503',
    '00000000-0000-4000-8000-00000000e501',
    'pay_offer_a_fee',
    'payment_refunded'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'action' = 'HISTORICAL_OFFER_REOPENED'
     and payload ->> 'current_profile_access_preserved' = 'true'
     from observation_results
    where label = 'historical-fee-refund-preserves-current-profile')
  and (select enrollment_payment_id = 'pay_offer_b_fee'
       and enrollment_fee_paid is true
       from public.profiles
      where id = '00000000-0000-4000-8000-00000000e501')
  and (select processing_state = 'AWAITING_PAYMENT'
       from public.offers
      where id = '10000000-0000-4000-8000-00000000e503'),
  'historical offer refund revoked or hid the current contract'
);

-- Simulate a pre-constraint legacy row: both aliases exist but disagree. The
-- runtime guard must still refuse to choose either identity.
select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_constraint as constraint_row
     where constraint_row.conrelid = 'public.student_payments'::regclass
       and constraint_row.conname =
         'student_payments_provider_alias_consistency_chk'
       and constraint_row.convalidated
  ),
  'provider alias consistency constraint is absent or unvalidated'
);
do $provider_alias_constraint_rejects_divergence$
begin
  begin
    update public.student_payments
       set asaas_id = 'pay_constraint_must_reject'
     where asaas_payment_id = 'pay_one_time_observation';
    raise exception 'provider alias divergence bypassed the validated constraint';
  exception
    when check_violation then null;
  end;
end;
$provider_alias_constraint_rejects_divergence$;
alter table public.student_payments
  drop constraint student_payments_provider_alias_consistency_chk;
update public.student_payments
   set asaas_id = 'pay_one_time_legacy_alias'
 where asaas_payment_id = 'pay_one_time_observation';
insert into observation_results values (
  'legacy-provider-alias-divergence',
  public.apply_enrollment_payment_observation(
    'enrollment-observation-fence',
    '00000000-0000-4000-8000-00000000e501',
    '10000000-0000-4000-8000-00000000e501',
    'pay_one_time_observation',
    'cus_enrollment_observation',
    null,
    'ONE_TIME',
    'SETTLED',
    100,
    'enrollment:10000000-0000-4000-8000-00000000e501:one-time',
    'RECEIVED',
    date '2031-08-10',
    'PIX',
    'Plano integral'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'reason' = 'local_payment_provider_alias_divergence'
     from observation_results
    where label = 'legacy-provider-alias-divergence'),
  'legacy divergent provider aliases were silently adopted'
);

rollback;
