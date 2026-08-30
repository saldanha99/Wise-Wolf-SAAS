-- An existing ambiguous billing-period claim remains reconcilable while its
-- matching provider creation lifecycle is active. New billing claims remain
-- fenced by the lifecycle trigger.

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

select pg_temp.assert_true(
  has_function_privilege(
    'service_role',
    'public.claim_asaas_student_billing_period(text,uuid,date,text,text,text,uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.claim_asaas_student_billing_period_exact_impl(text,uuid,date,text,text,text,uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_asaas_student_billing_period(text,uuid,date,text,text,text,uuid,integer)',
    'EXECUTE'
  ),
  'student billing period RPC boundary is unsafe'
);

insert into public.tenants (
  id,
  name,
  slug,
  saas_status,
  whatsapp_enabled
) values (
  'billing-period-reconciliation',
  'Billing Period Reconciliation',
  'billing-period-reconciliation',
  'active',
  false
);

insert into auth.users (
  id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '00000000-0000-4000-8000-00000000c901',
  'authenticated',
  'authenticated',
  'billing-period-reconciliation@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Billing Period Reconciliation"}',
  now(),
  now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'billing-period-reconciliation',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Billing Period Reconciliation',
       cpf = null,
       asaas_customer_id = 'cus_billing_period_reconciliation'
 where id = '00000000-0000-4000-8000-00000000c901';
set local app.enrollment_claim = '';

select pg_temp.assert_true(
  exists (
    select 1
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000c901'
       and profile.tenant_id = 'billing-period-reconciliation'
       and profile.role = 'STUDENT'
       and profile.lifecycle_status = 'active'
  ),
  'student fixture was not created'
);

-- This claim predates the active lifecycle attempt, matching an ambiguous
-- provider response that must be resolved with GET-only reconciliation.
insert into public.asaas_student_billing_period_claims (
  id,
  tenant_id,
  student_id,
  due_date,
  source,
  source_key,
  request_fingerprint,
  status,
  claim_token,
  lease_expires_at,
  submit_attempt_count,
  last_error
) values (
  '10000000-0000-4000-8000-00000000c901',
  'billing-period-reconciliation',
  '00000000-0000-4000-8000-00000000c901',
  date '2035-01-10',
  'SUBSCRIPTION',
  'subscription:billing-period-reconciliation',
  repeat('a', 64),
  'UNKNOWN',
  '20000000-0000-4000-8000-00000000c901',
  now() - interval '1 minute',
  1,
  'provider_response_ambiguous'
);

insert into public.asaas_provider_creation_attempts (
  id,
  tenant_id,
  operation,
  logical_key,
  external_reference,
  request_fingerprint,
  status,
  claim_token,
  lease_expires_at,
  submit_attempt_count,
  lifecycle_student_id,
  lifecycle_binding_kind,
  lifecycle_expected_customer_id,
  lifecycle_bound_at
) values (
  '30000000-0000-4000-8000-00000000c901',
  'billing-period-reconciliation',
  'SUBSCRIPTION_CREATE',
  'subscription:billing-period-reconciliation',
  'billing-period-reconciliation-fixture',
  repeat('b', 64),
  'UNKNOWN',
  '40000000-0000-4000-8000-00000000c901',
  now() - interval '1 minute',
  1,
  '00000000-0000-4000-8000-00000000c901',
  'SUBSCRIPTION',
  'cus_billing_period_reconciliation',
  now() - interval '2 minutes'
);

create temporary table billing_period_reconciliation_results (
  label text primary key,
  payload jsonb not null
);

insert into billing_period_reconciliation_results values (
  'reconcile-existing',
  public.claim_asaas_student_billing_period(
    'billing-period-reconciliation',
    '00000000-0000-4000-8000-00000000c901',
    date '2035-01-10',
    'SUBSCRIPTION',
    'subscription:billing-period-reconciliation',
    repeat('a', 64),
    '50000000-0000-4000-8000-00000000c901',
    300
  )
);

insert into billing_period_reconciliation_results values (
  'concurrent-retry',
  public.claim_asaas_student_billing_period(
    'billing-period-reconciliation',
    '00000000-0000-4000-8000-00000000c901',
    date '2035-01-10',
    'SUBSCRIPTION',
    'subscription:billing-period-reconciliation',
    repeat('a', 64),
    '60000000-0000-4000-8000-00000000c901',
    300
  )
);

select pg_temp.assert_true(
  (
    select payload->>'action' = 'RECONCILE_REQUIRED'
       and payload->>'attempt_id' =
         '10000000-0000-4000-8000-00000000c901'
      from billing_period_reconciliation_results
     where label = 'reconcile-existing'
  )
  and (
    select payload->>'action' = 'IN_PROGRESS'
      from billing_period_reconciliation_results
     where label = 'concurrent-retry'
  )
  and (
    select count(*) = 1
      from public.asaas_student_billing_period_claims as billing_claim
     where billing_claim.tenant_id = 'billing-period-reconciliation'
       and billing_claim.student_id =
         '00000000-0000-4000-8000-00000000c901'
       and billing_claim.due_date = date '2035-01-10'
       and billing_claim.status = 'UNKNOWN'
       and billing_claim.claim_token =
         '50000000-0000-4000-8000-00000000c901'
       and billing_claim.submit_attempt_count = 1
  ),
  'existing UNKNOWN billing claim could not enter GET-only reconciliation'
);

do $new_claim_remains_lifecycle_fenced$
begin
  begin
    perform public.claim_asaas_student_billing_period(
      'billing-period-reconciliation',
      '00000000-0000-4000-8000-00000000c901',
      date '2035-02-10',
      'SUBSCRIPTION',
      'subscription:new-while-provider-creation-active',
      repeat('c', 64),
      '70000000-0000-4000-8000-00000000c901',
      300
    );
    raise exception 'new billing claim bypassed the lifecycle fence';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'student_billing_lifecycle_inactive' then
        raise;
      end if;
  end;
end;
$new_claim_remains_lifecycle_fenced$;

select pg_temp.assert_true(
  not exists (
    select 1
      from public.asaas_student_billing_period_claims as billing_claim
     where billing_claim.tenant_id = 'billing-period-reconciliation'
       and billing_claim.student_id =
         '00000000-0000-4000-8000-00000000c901'
       and billing_claim.due_date = date '2035-02-10'
  ),
  'lifecycle-fenced new billing claim was persisted'
);

rollback;
