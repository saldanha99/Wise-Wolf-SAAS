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
  pg_catalog.to_regprocedure(
    'public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'
  ) is null
  and not pg_catalog.has_function_privilege(
    'service_role',
    'private.apply_saas_checkout_billing_event_unordered_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.apply_saas_checkout_billing_event(uuid,text,text,timestamptz,text,numeric,text,text,text,text,timestamptz,date,text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.apply_saas_checkout_billing_event(uuid,text,text,timestamptz,text,numeric,text,text,text,text,timestamptz,date,text,text)',
    'EXECUTE'
  ),
  'unordered SaaS provider event entry point is still reachable'
);

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'anon', 'public.saas_checkout_event_watermarks', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.saas_provider_entity_watermarks', 'SELECT'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.saas_checkout_event_watermarks', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.saas_checkout_event_watermarks', 'UPDATE'
  ),
  'SaaS provider watermarks are writable outside their RPC'
);

insert into public.saas_plans (
  id,
  name,
  description,
  price,
  price_yearly,
  max_students,
  max_users,
  max_teachers,
  max_storage_gb,
  active,
  features,
  plan_type
) values (
  '00000000-0000-4000-8000-00000000f551',
  'SaaS Provider Ordering Test',
  'Fixture isolada de ordenacao do provedor SaaS',
  199,
  1999,
  20,
  4,
  4,
  5,
  true,
  '[]'::jsonb,
  'school'
);

insert into public.tenants (
  id, name, slug, saas_status, current_period_end, plan_id, tenant_type
) values (
  'saas-provider-ordering',
  'SaaS Provider Ordering',
  'saas-provider-ordering',
  'active',
  pg_catalog.now() + interval '1 month',
  '00000000-0000-4000-8000-00000000f551',
  'school'
);

insert into public.tenants (
  id, name, slug, saas_status, current_period_end, plan_id, tenant_type
) values (
  'saas-provider-ordering-other',
  'SaaS Provider Ordering Other',
  'saas-provider-ordering-other',
  'active',
  pg_catalog.now() + interval '1 month',
  '00000000-0000-4000-8000-00000000f551',
  'school'
);

insert into public.saas_checkout_intents (
  id,
  idempotency_key,
  status,
  school_name,
  tenant_slug,
  owner_name,
  owner_email,
  owner_phone,
  owner_cpf_cnpj,
  plan_id,
  billing_cycle,
  billing_type,
  amount,
  tenant_id,
  asaas_customer_id,
  asaas_subscription_id,
  asaas_payment_id,
  paid_at,
  provisioned_at,
  metadata
) values (
  '00000000-0000-4000-8000-00000000f552',
  '00000000-0000-4000-8000-00000000f553',
  'PROVISIONED',
  'SaaS Provider Ordering',
  'saas-provider-ordering-checkout',
  'Ordering Owner',
  'ordering-owner@example.invalid',
  '5511999999999',
  '00000000000',
  '00000000-0000-4000-8000-00000000f551',
  'MONTHLY',
  'PIX',
  199,
  'saas-provider-ordering',
  'cus_saas_ordering',
  'sub_saas_ordering',
  'pay_saas_ordering_a',
  timestamptz '2026-08-25 10:00:00+00',
  timestamptz '2026-08-25 10:05:00+00',
  '{"testMode":true,"test_fixture":true}'::jsonb
);

insert into public.saas_checkout_intents (
  id,
  idempotency_key,
  status,
  school_name,
  tenant_slug,
  owner_name,
  owner_email,
  owner_phone,
  owner_cpf_cnpj,
  plan_id,
  billing_cycle,
  billing_type,
  amount,
  tenant_id,
  asaas_customer_id,
  asaas_subscription_id,
  asaas_payment_id,
  paid_at,
  provisioned_at,
  metadata
) values (
  '00000000-0000-4000-8000-00000000f558',
  '00000000-0000-4000-8000-00000000f559',
  'PROVISIONED',
  'SaaS Provider Ordering Cross Tenant',
  'saas-provider-ordering-cross-tenant',
  'Ordering Cross Tenant Owner',
  'ordering-cross-tenant-owner@example.invalid',
  '5511977777777',
  '22222222222',
  '00000000-0000-4000-8000-00000000f551',
  'MONTHLY',
  'PIX',
  199,
  'saas-provider-ordering',
  'cus_saas_ordering_h',
  'sub_saas_ordering_h',
  'pay_saas_ordering_h',
  timestamptz '2026-08-25 10:00:00+00',
  timestamptz '2026-08-25 10:05:00+00',
  '{"testMode":true,"test_fixture":true}'::jsonb
);

insert into public.saas_checkout_intents (
  id,
  idempotency_key,
  status,
  school_name,
  tenant_slug,
  owner_name,
  owner_email,
  owner_phone,
  owner_cpf_cnpj,
  plan_id,
  billing_cycle,
  billing_type,
  amount,
  asaas_customer_id,
  asaas_subscription_id,
  metadata
) values (
  '00000000-0000-4000-8000-00000000f554',
  '00000000-0000-4000-8000-00000000f555',
  'PAYMENT_PENDING',
  'SaaS Provider Ordering Crash',
  'saas-provider-ordering-crash',
  'Ordering Crash Owner',
  'ordering-crash-owner@example.invalid',
  '5511988888888',
  '11111111111',
  '00000000-0000-4000-8000-00000000f551',
  'MONTHLY',
  'PIX',
  199,
  'cus_saas_ordering_crash',
  'sub_saas_ordering_crash',
  '{"testMode":true,"test_fixture":true}'::jsonb
);

-- The ordered state commit and tenant provisioning are separate transactions.
-- If the worker crashes between them, the exact provider replay must request
-- the same idempotent provision step again without advancing either watermark.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f554',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_provision_crash',
    p_event_created_at => timestamptz '2026-08-25 10:00:00+00',
    p_payment_id => 'pay_saas_ordering_crash',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering_crash',
    p_subscription_id => 'sub_saas_ordering_crash',
    p_paid_at => timestamptz '2026-08-25 10:00:00+00',
    p_due_date => date '2026-08-25'
  ) ->> 'action' = 'PROVISION_REQUIRED',
  'initial settlement did not request SaaS provisioning'
);

select pg_temp.assert_true(
  (select status = 'PAID'
          and tenant_id is null
          and provisioned_at is null
          and asaas_payment_id = 'pay_saas_ordering_crash'
     from public.saas_checkout_intents
    where id = '00000000-0000-4000-8000-00000000f554')
  and (select count(*) = 1
         from public.saas_checkout_event_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f554')
  and (select count(*) = 1
         from public.saas_provider_entity_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f554'),
  'pre-provision crash fixture did not persist one exact ordered settlement'
);

select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f554',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_provision_crash',
    p_event_created_at => timestamptz '2026-08-25 10:00:00+00',
    p_payment_id => 'pay_saas_ordering_crash',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering_crash',
    p_subscription_id => 'sub_saas_ordering_crash',
    p_paid_at => timestamptz '2026-08-25 10:00:00+00',
    p_due_date => date '2026-08-25'
  ) ->> 'action' = 'PROVISION_REQUIRED',
  'exact settlement replay did not resume SaaS provisioning'
);

select pg_temp.assert_true(
  (select count(*) = 1
     from public.saas_checkout_event_watermarks
    where checkout_id = '00000000-0000-4000-8000-00000000f554')
  and (select count(*) = 1
         from public.saas_provider_entity_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f554'),
  'provisioning replay duplicated an ordered SaaS watermark'
);

insert into public.saas_invoices (
  tenant_id,
  amount,
  status,
  due_date,
  paid_at,
  asaas_payment_id,
  invoice_number,
  plan_snapshot,
  billing_period_start,
  billing_period_end,
  period_month
) values (
  'saas-provider-ordering',
  199,
  'PAID',
  timestamptz '2026-08-25 10:00:00+00',
  timestamptz '2026-08-25 10:00:00+00',
  'pay_saas_ordering_a',
  'WW-ORDER-A',
  '{}'::jsonb,
  date '2026-04-01',
  date '2026-04-30',
  '2026-04'
);

-- A deployed legacy checkout has no provider watermark yet. A restrictive
-- event that predates its durable recorded-payment anchor cannot suspend the
-- newer access grant or regress the already settled invoice.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_OVERDUE',
    p_provider_event_id => 'evt_saas_ordering_legacy_old_overdue_a',
    p_event_created_at => timestamptz '2026-08-25 09:50:00+00',
    p_payment_id => 'pay_saas_ordering_a',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering'
  ) ->> 'action' = 'STALE_IGNORED',
  'historical first event regressed a legacy provisioned checkout'
);

select pg_temp.assert_true(
  (select saas_status = 'active'
     from public.tenants
    where id = 'saas-provider-ordering')
  and (select status = 'PROVISIONED'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select status = 'PAID'
         from public.saas_invoices
        where asaas_payment_id = 'pay_saas_ordering_a')
  and not exists (
    select 1
      from public.saas_checkout_event_watermarks
     where checkout_id = '00000000-0000-4000-8000-00000000f552'
  ),
  'legacy stale bootstrap event changed access, invoice, or checkout order'
);

select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_OVERDUE',
    p_provider_event_id => 'evt_saas_ordering_legacy_ambiguous_overdue_a',
    p_event_created_at => timestamptz '2026-08-25 10:10:00+00',
    p_payment_id => 'pay_saas_ordering_a',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering'
  ) ->> 'action' = 'REVIEW_REQUIRED',
  'unanchored legacy restriction was applied by guessing provider order'
);

select pg_temp.assert_true(
  (select saas_status = 'active'
     from public.tenants
    where id = 'saas-provider-ordering')
  and (select status = 'PROVISIONED'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select status = 'PAID'
         from public.saas_invoices
        where asaas_payment_id = 'pay_saas_ordering_a')
  and not exists (
    select 1
      from public.saas_checkout_event_watermarks
     where checkout_id = '00000000-0000-4000-8000-00000000f552'
  ),
  'legacy ambiguous restriction changed access before review'
);

-- A newer payment B becomes the checkout watermark and extends access.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_paid_b',
    p_event_created_at => timestamptz '2026-08-25 11:20:00+00',
    p_payment_id => 'pay_saas_ordering_b',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 11:20:00+00',
    p_due_date => date '2026-08-25'
  ) ->> 'action' in ('RENEWED', 'RESTORED'),
  'newer payment B did not establish the checkout watermark'
);

insert into public.saas_invoices (
  tenant_id,
  amount,
  status,
  due_date,
  paid_at,
  asaas_payment_id,
  invoice_number,
  plan_snapshot,
  billing_period_start,
  billing_period_end,
  period_month
) values (
  'saas-provider-ordering',
  199,
  'OVERDUE',
  timestamptz '2026-08-25 09:00:00+00',
  null,
  'pay_saas_ordering_e',
  'WW-ORDER-E',
  '{}'::jsonb,
  date '2026-06-01',
  date '2026-06-30',
  '2026-06'
);

-- Historical payment E settles after the newer current payment B. Because its
-- invoice already exists, it must reconcile that entity without rebinding or
-- extending the checkout that B currently backs.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_old_paid_e',
    p_event_created_at => timestamptz '2026-08-25 11:24:00+00',
    p_payment_id => 'pay_saas_ordering_e',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 11:24:00+00'
  ) ->> 'action' = 'STALE_ENTITY_APPLIED',
  'stale checkout settlement was not reconciled on its own invoice'
);

select pg_temp.assert_true(
  (select status = 'PAID' and paid_at is not null
     from public.saas_invoices
    where asaas_payment_id = 'pay_saas_ordering_e')
  and (select last_provider_event_id = 'evt_saas_ordering_paid_b'
         from public.saas_checkout_event_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552')
  and (select asaas_payment_id = 'pay_saas_ordering_b'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select not terminal_event
         from public.saas_provider_entity_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552'
          and provider_entity_kind = 'PAYMENT'
          and provider_entity_id = 'pay_saas_ordering_e'),
  'entity-only settlement changed checkout order or was not durable'
);

-- A refund for older payment A can arrive late, but its provider timestamp is
-- older than payment B and therefore cannot revoke B's current access.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_REFUNDED',
    p_provider_event_id => 'evt_saas_ordering_old_refund_a',
    p_event_created_at => timestamptz '2026-08-25 11:10:00+00',
    p_payment_id => 'pay_saas_ordering_a',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering'
  ) ->> 'action' = 'STALE_ENTITY_APPLIED',
  'old refund A did not preserve access while recording its own reversal'
);

select pg_temp.assert_true(
  (select saas_status = 'active'
     from public.tenants
    where id = 'saas-provider-ordering')
  and (select status = 'PROVISIONED'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select status = 'REFUNDED'
         from public.saas_invoices
        where asaas_payment_id = 'pay_saas_ordering_a')
  and (select terminal_event
         from public.saas_provider_entity_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552'
          and provider_entity_kind = 'PAYMENT'
          and provider_entity_id = 'pay_saas_ordering_a'),
  'stale refund A did not isolate invoice reversal from current SaaS access'
);

insert into public.saas_invoices (
  tenant_id,
  amount,
  status,
  due_date,
  paid_at,
  asaas_payment_id,
  invoice_number,
  plan_snapshot,
  billing_period_start,
  billing_period_end,
  period_month
) values
  (
    'saas-provider-ordering',
    199,
    'PAID',
    timestamptz '2026-01-01 09:00:00+00',
    timestamptz '2026-01-01 09:00:00+00',
    'pay_saas_ordering_i',
    'WW-ORDER-I',
    '{}'::jsonb,
    date '2026-01-01',
    date '2026-01-31',
    '2026-01'
  ),
  (
    'saas-provider-ordering-other',
    199,
    'OVERDUE',
    timestamptz '2026-02-01 09:00:00+00',
    null,
    'pay_saas_ordering_h',
    'WW-ORDER-H',
    '{}'::jsonb,
    date '2026-02-01',
    date '2026-02-28',
    '2026-02'
  );

-- A reversal created after B still belongs only to historical payment I. The
-- exact current-payment binding prevents its newer timestamp from revoking B.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_REFUNDED',
    p_provider_event_id => 'evt_saas_ordering_new_refund_i',
    p_event_created_at => timestamptz '2026-08-25 11:25:00+00',
    p_payment_id => 'pay_saas_ordering_i',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering'
  ) ->> 'action' = 'STALE_ENTITY_APPLIED',
  'newer reversal of historical payment revoked current payment B access'
);

select pg_temp.assert_true(
  (select status = 'REFUNDED'
     from public.saas_invoices
    where asaas_payment_id = 'pay_saas_ordering_i')
  and (select last_provider_event_id = 'evt_saas_ordering_paid_b'
         from public.saas_checkout_event_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552')
  and (select status = 'PROVISIONED'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select saas_status = 'active'
         from public.tenants
        where id = 'saas-provider-ordering'),
  'historical newer reversal changed current checkout order or access'
);

-- An invoice already owned by another tenant is never adopted by the normal
-- path, even when the provider payload matches every checkout-level field.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f558',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_cross_tenant_h',
    p_event_created_at => timestamptz '2026-08-25 11:26:00+00',
    p_payment_id => 'pay_saas_ordering_h',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering_h',
    p_subscription_id => 'sub_saas_ordering_h',
    p_paid_at => timestamptz '2026-08-25 11:26:00+00'
  ) ->> 'action' = 'REVIEW_REQUIRED',
  'normal SaaS apply adopted a payment invoice from another tenant'
);

select pg_temp.assert_true(
  (select tenant_id = 'saas-provider-ordering-other' and status = 'OVERDUE'
     from public.saas_invoices
    where asaas_payment_id = 'pay_saas_ordering_h')
  and not exists (
    select 1
      from public.saas_checkout_event_watermarks
     where checkout_id = '00000000-0000-4000-8000-00000000f558'
  )
  and (select status = 'PROVISIONED'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f558')
  and (select saas_status = 'active'
         from public.tenants
        where id = 'saas-provider-ordering'),
  'cross-tenant invoice mismatch mutated either tenant or checkout order'
);

-- A reversal/chargeback for an unbound payment cannot inaugurate a recurring
-- installment. Without an exact local invoice it is ambiguous and must be
-- triaged, even when its provider timestamp is newer than current payment B.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_REFUNDED',
    p_provider_event_id => 'evt_saas_ordering_unknown_refund_k',
    p_event_created_at => timestamptz '2026-08-25 11:27:00+00',
    p_payment_id => 'pay_saas_ordering_unknown_k',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering'
  ) ->> 'action' = 'REVIEW_REQUIRED',
  'unbound refund without invoice was adopted as a current installment'
);

select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_CHARGEBACK_REQUESTED',
    p_provider_event_id => 'evt_saas_ordering_unknown_chargeback_l',
    p_event_created_at => timestamptz '2026-08-25 11:28:00+00',
    p_payment_id => 'pay_saas_ordering_unknown_l',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering'
  ) ->> 'action' = 'REVIEW_REQUIRED',
  'unbound chargeback without invoice was adopted as a current installment'
);

select pg_temp.assert_true(
  (select saas_status = 'active'
     from public.tenants
    where id = 'saas-provider-ordering')
  and (select status = 'PROVISIONED'
              and asaas_payment_id = 'pay_saas_ordering_b'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select last_provider_event_id = 'evt_saas_ordering_paid_b'
         from public.saas_checkout_event_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552')
  and not exists (
    select 1
      from public.saas_provider_entity_watermarks
     where checkout_id = '00000000-0000-4000-8000-00000000f552'
       and provider_entity_kind = 'PAYMENT'
       and provider_entity_id in (
         'pay_saas_ordering_unknown_k',
         'pay_saas_ordering_unknown_l'
       )
  ),
  'unknown cross-payment reversal changed current access or watermarks'
);

-- A newer recurring installment J may first appear as OVERDUE, before any
-- local invoice exists. Its exact tuple and advancing provider watermark make
-- it the current payment and suspend access without adopting a foreign invoice.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_OVERDUE',
    p_provider_event_id => 'evt_saas_ordering_overdue_j',
    p_event_created_at => timestamptz '2026-08-25 11:30:00+00',
    p_payment_id => 'pay_saas_ordering_j',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering'
  ) ->> 'action' = 'SUSPENDED',
  'new exact overdue installment without invoice did not suspend access'
);

-- Payment B is older than the new installment watermark. Its entity may still
-- reconcile idempotently, but it cannot restore current access.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_late_paid_b',
    p_event_created_at => timestamptz '2026-08-25 11:25:00+00',
    p_payment_id => 'pay_saas_ordering_b',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 11:25:00+00'
  ) ->> 'action' = 'STALE_ENTITY_APPLIED',
  'late older paid event B bypassed the checkout watermark'
);

select pg_temp.assert_true(
  (select saas_status = 'past_due'
     from public.tenants
    where id = 'saas-provider-ordering')
  and (select status = 'OVERDUE'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select asaas_payment_id = 'pay_saas_ordering_j'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and not exists (
    select 1 from public.saas_invoices
     where asaas_payment_id = 'pay_saas_ordering_j'
  ),
  'stale paid event restored an overdue SaaS tenant'
);

-- A genuinely newer settlement of the same installment J restores OVERDUE and
-- creates its invoice. An equal-time/equal-rank event for another payment is
-- ambiguous and must not create a second period.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_restored_j',
    p_event_created_at => timestamptz '2026-08-25 11:40:00+00',
    p_payment_id => 'pay_saas_ordering_j',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 11:40:00+00'
  ) ->> 'action' in ('RENEWED', 'RESTORED'),
  'settlement of the exact overdue installment did not restore access'
);

select pg_temp.assert_true(
  (select saas_status = 'active'
     from public.tenants
    where id = 'saas-provider-ordering')
  and (select status = 'PROVISIONED'
              and asaas_payment_id = 'pay_saas_ordering_j'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select status = 'PAID' and paid_at is not null
         from public.saas_invoices
        where asaas_payment_id = 'pay_saas_ordering_j'),
  'settled overdue installment did not restore the exact tenant/invoice tuple'
);

select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_ambiguous_c',
    p_event_created_at => timestamptz '2026-08-25 11:40:00+00',
    p_payment_id => 'pay_saas_ordering_c',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 11:40:00+00'
  ) ->> 'action' = 'REVIEW_REQUIRED',
  'equal timestamp/rank events were ordered arbitrarily'
);

select pg_temp.assert_true(
  not exists (
    select 1 from public.saas_invoices
     where asaas_payment_id = 'pay_saas_ordering_c'
  ),
  'ambiguous equal-order event created a billing period'
);

-- At the same provider timestamp, the terminal rank wins over settlement.
-- Once applied, both the exact payment entity and the checkout lifecycle stay
-- terminal; neither the same nor a different payment can reactivate it.
select public.apply_saas_checkout_billing_event(
  p_checkout_id => '00000000-0000-4000-8000-00000000f552',
  p_event_name => 'PAYMENT_REFUNDED',
  p_provider_event_id => 'evt_saas_ordering_refunded_j',
  p_event_created_at => timestamptz '2026-08-25 11:40:00+00',
  p_payment_id => 'pay_saas_ordering_j',
  p_payment_value => 199,
  p_billing_type => 'PIX',
  p_customer_id => 'cus_saas_ordering',
  p_subscription_id => 'sub_saas_ordering'
);

select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_REFUNDED',
    p_provider_event_id => 'evt_saas_ordering_refunded_j',
    p_event_created_at => timestamptz '2026-08-25 11:40:00+00',
    p_payment_id => 'pay_saas_ordering_j',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering'
  ) ->> 'action' = 'TERMINAL_REPLAY_IGNORED',
  'exact terminal replay was allowed to resume owner activation'
);

insert into public.saas_invoices (
  tenant_id,
  amount,
  status,
  due_date,
  paid_at,
  asaas_payment_id,
  invoice_number,
  plan_snapshot,
  billing_period_start,
  billing_period_end,
  period_month
) values (
  'saas-provider-ordering',
  199,
  'OVERDUE',
  timestamptz '2026-08-01 09:00:00+00',
  null,
  'pay_saas_ordering_f',
  'WW-ORDER-F',
  '{}'::jsonb,
  date '2026-05-01',
  date '2026-05-31',
  '2026-05'
);

-- Terminal checkout dominance blocks access restoration, not accounting for
-- a distinct payment whose settlement predates that terminal checkout event.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_old_paid_f_after_terminal',
    p_event_created_at => timestamptz '2026-08-25 11:35:00+00',
    p_payment_id => 'pay_saas_ordering_f',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 11:35:00+00'
  ) ->> 'action' = 'STALE_ENTITY_APPLIED',
  'terminal checkout discarded an older distinct payment settlement'
);

select pg_temp.assert_true(
  (select saas_status = 'blocked'
     from public.tenants
    where id = 'saas-provider-ordering')
  and (select status = 'CANCELLED'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select status = 'PAID' and paid_at is not null
         from public.saas_invoices
        where asaas_payment_id = 'pay_saas_ordering_f')
  and (select last_provider_event_id = 'evt_saas_ordering_refunded_j'
              and terminal_event
         from public.saas_checkout_event_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552')
  and (select not terminal_event
         from public.saas_provider_entity_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552'
          and provider_entity_kind = 'PAYMENT'
          and provider_entity_id = 'pay_saas_ordering_f'),
  'entity-only settlement reactivated or reordered a terminal checkout'
);

insert into public.saas_invoices (
  tenant_id,
  amount,
  status,
  due_date,
  paid_at,
  asaas_payment_id,
  invoice_number,
  plan_snapshot,
  billing_period_start,
  billing_period_end,
  period_month
) values (
  'saas-provider-ordering',
  199,
  'OVERDUE',
  timestamptz '2026-03-01 09:00:00+00',
  null,
  'pay_saas_ordering_g',
  'WW-ORDER-G',
  '{}'::jsonb,
  date '2026-03-01',
  date '2026-03-31',
  '2026-03'
);

-- Money settled after terminal access is also real accounting data. It is
-- reconciled on the exact existing invoice, but cannot reopen the checkout.
select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_new_paid_g_after_terminal',
    p_event_created_at => timestamptz '2026-08-25 12:05:00+00',
    p_payment_id => 'pay_saas_ordering_g',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 12:05:00+00'
  ) ->> 'action' = 'REVIEW_REQUIRED',
  'newer settlement on terminal checkout was not reconciled and triaged'
);

-- A crash after the entity observation commit but before outer-inbox TRIAGE
-- must not downgrade the exact replay to PROCESSED/STALE_IGNORED.
select pg_temp.assert_true(
  replay.result ->> 'action' = 'REVIEW_REQUIRED'
  and replay.result ->> 'reason' =
    'terminal_saas_checkout_payment_reconciled_for_review'
  and replay.result ->> 'entity_observation_applied' = 'true',
  'exact terminal-blocked settlement replay lost its durable triage decision'
)
from (
  select public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_new_paid_g_after_terminal',
    p_event_created_at => timestamptz '2026-08-25 12:05:00+00',
    p_payment_id => 'pay_saas_ordering_g',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 12:05:00+00'
  ) as result
) as replay;

select pg_temp.assert_true(
  (select saas_status = 'blocked'
     from public.tenants
    where id = 'saas-provider-ordering')
  and (select status = 'CANCELLED'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select status = 'PAID' and paid_at is not null
         from public.saas_invoices
        where asaas_payment_id = 'pay_saas_ordering_g')
  and (select last_provider_event_id = 'evt_saas_ordering_refunded_j'
              and terminal_event
         from public.saas_checkout_event_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552')
  and (select last_provider_event_id =
                'evt_saas_ordering_new_paid_g_after_terminal'
              and not terminal_event
         from public.saas_provider_entity_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552'
          and provider_entity_kind = 'PAYMENT'
          and provider_entity_id = 'pay_saas_ordering_g'),
  'new terminal entity-only settlement changed global SaaS access/order'
);

select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_paid_after_refund_j',
    p_event_created_at => timestamptz '2026-08-25 12:00:00+00',
    p_payment_id => 'pay_saas_ordering_j',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 12:00:00+00'
  ) ->> 'action' = 'TERMINAL_IGNORED',
  'same terminal payment entity became paid again'
);

select pg_temp.assert_true(
  public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-00000000f552',
    p_event_name => 'PAYMENT_RECEIVED',
    p_provider_event_id => 'evt_saas_ordering_new_payment_after_terminal',
    p_event_created_at => timestamptz '2026-08-25 12:10:00+00',
    p_payment_id => 'pay_saas_ordering_d',
    p_payment_value => 199,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_saas_ordering',
    p_subscription_id => 'sub_saas_ordering',
    p_paid_at => timestamptz '2026-08-25 12:10:00+00'
  ) ->> 'action' = 'REVIEW_REQUIRED',
  'unbound payment after terminal checkout was not triaged'
);

select pg_temp.assert_true(
  (select saas_status = 'blocked'
     from public.tenants
    where id = 'saas-provider-ordering')
  and (select status = 'CANCELLED'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f552')
  and (select terminal_event
         from public.saas_checkout_event_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552')
  and (select terminal_event
         from public.saas_provider_entity_watermarks
        where checkout_id = '00000000-0000-4000-8000-00000000f552'
          and provider_entity_kind = 'PAYMENT'
          and provider_entity_id = 'pay_saas_ordering_j'),
  'terminal SaaS watermark was not durable at checkout and entity scope'
);

rollback;
