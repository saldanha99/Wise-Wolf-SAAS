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
  '00000000-0000-4000-8000-000000000c01',
  'Lifecycle Test',
  'Fixture isolada do ciclo SaaS',
  197,
  1997,
  50,
  5,
  5,
  10,
  true,
  '[]'::jsonb,
  'school'
);

insert into public.tenants (
  id,
  name,
  slug,
  saas_status,
  current_period_end,
  plan_id,
  tenant_type
) values
  (
    'saas-lifecycle-legacy',
    'Legacy Lifecycle Fixture',
    'saas-lifecycle-legacy',
    'active',
    null,
    '00000000-0000-4000-8000-000000000c01',
    'school'
  ),
  (
    'saas-lifecycle-paid',
    'Paid Lifecycle Fixture',
    'saas-lifecycle-paid',
    'active',
    now() + interval '1 month',
    '00000000-0000-4000-8000-000000000c01',
    'school'
  ),
  (
    'saas-lifecycle-partial',
    'Partial Lifecycle Fixture',
    'saas-lifecycle-partial',
    'active',
    now() + interval '1 month',
    '00000000-0000-4000-8000-000000000c01',
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
) values
  (
    '00000000-0000-4000-8000-000000000c02',
    '00000000-0000-4000-8000-000000000c03',
    'PROVISIONED',
    'Paid Lifecycle Fixture',
    'saas-lifecycle-paid-checkout',
    'Lifecycle Owner',
    'lifecycle-owner@example.invalid',
    '5511999999999',
    '00000000000',
    '00000000-0000-4000-8000-000000000c01',
    'MONTHLY',
    'PIX',
    197,
    'saas-lifecycle-paid',
    'cus_lifecycle',
    'sub_lifecycle',
    'pay_initial',
    now(),
    now(),
    '{"test_fixture":true,"testMode":true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000c04',
    '00000000-0000-4000-8000-000000000c05',
    'PROVISIONING_FAILED',
    'Partial Lifecycle Fixture',
    'saas-lifecycle-partial-checkout',
    'Partial Lifecycle Owner',
    'lifecycle-partial@example.invalid',
    '5511888888888',
    '00000000000',
    '00000000-0000-4000-8000-000000000c01',
    'MONTHLY',
    'PIX',
    197,
    'saas-lifecycle-partial',
    'cus_lifecycle_partial',
    'sub_lifecycle_partial',
    'pay_initial_partial',
    now(),
    null,
    '{"test_fixture":true,"testMode":true}'::jsonb
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
  'saas-lifecycle-paid',
  197,
  'PAID',
  now(),
  now(),
  'pay_initial',
  'WW-TEST-INITIAL',
  '{}'::jsonb,
  (current_date - interval '1 month')::date,
  current_date,
  to_char(current_date - interval '1 month', 'YYYY-MM')
);

select pg_temp.assert_true(
  private.tenant_is_operational('saas-lifecycle-legacy'),
  'tenant legado explicitamente ativo deixou de operar sem checkout pago'
);
select pg_temp.assert_true(
  private.tenant_is_operational('saas-lifecycle-paid'),
  'tenant pago provisionado e dentro do periodo nao ficou operacional'
);
select pg_temp.assert_true(
  not private.tenant_is_operational('saas-lifecycle-partial'),
  'tenant de checkout pago com provisionamento parcial ficou operacional'
);

update public.tenants
set current_period_end = now() - interval '1 second'
where id = 'saas-lifecycle-paid';

select pg_temp.assert_true(
  not private.tenant_is_operational('saas-lifecycle-paid'),
  'tenant pago com periodo expirado permaneceu operacional'
);

update public.tenants
set current_period_end = now() + interval '1 month'
where id = 'saas-lifecycle-paid';

select public.apply_saas_checkout_billing_event(
  p_checkout_id => '00000000-0000-4000-8000-000000000c02',
  p_event_name => 'PAYMENT_OVERDUE',
  p_payment_id => 'pay_renewal',
  p_payment_value => 197,
  p_billing_type => 'PIX',
  p_customer_id => 'cus_lifecycle',
  p_subscription_id => 'sub_lifecycle',
  p_due_date => current_date
);

select pg_temp.assert_true(
  (select saas_status = 'past_due' and current_period_end <= now()
     from public.tenants where id = 'saas-lifecycle-paid')
  and (select status = 'OVERDUE'
       from public.saas_checkout_intents
       where id = '00000000-0000-4000-8000-000000000c02')
  and not private.tenant_is_operational('saas-lifecycle-paid'),
  'overdue nao suspendeu tenant e checkout atomicamente'
);

select public.apply_saas_checkout_billing_event(
  p_checkout_id => '00000000-0000-4000-8000-000000000c02',
  p_event_name => 'PAYMENT_RECEIVED',
  p_payment_id => 'pay_renewal',
  p_payment_value => 197,
  p_billing_type => 'PIX',
  p_customer_id => 'cus_lifecycle',
  p_subscription_id => 'sub_lifecycle',
  p_paid_at => now(),
  p_due_date => current_date
);

create temporary table lifecycle_period_snapshot as
select current_period_end
from public.tenants
where id = 'saas-lifecycle-paid';

select pg_temp.assert_true(
  (select saas_status = 'active' and current_period_end > now()
     from public.tenants where id = 'saas-lifecycle-paid')
  and (select status = 'PROVISIONED'
       from public.saas_checkout_intents
       where id = '00000000-0000-4000-8000-000000000c02')
  and (select count(*) = 1 and bool_and(status = 'PAID')
       from public.saas_invoices where asaas_payment_id = 'pay_renewal')
  and private.tenant_is_operational('saas-lifecycle-paid'),
  'pagamento da renovacao nao restaurou um unico periodo valido'
);

select public.apply_saas_checkout_billing_event(
  p_checkout_id => '00000000-0000-4000-8000-000000000c02',
  p_event_name => 'PAYMENT_RECEIVED',
  p_payment_id => 'pay_renewal',
  p_payment_value => 197,
  p_billing_type => 'PIX',
  p_customer_id => 'cus_lifecycle',
  p_subscription_id => 'sub_lifecycle',
  p_paid_at => now(),
  p_due_date => current_date
);

select pg_temp.assert_true(
  (select tenant.current_period_end = snapshot.current_period_end
     from public.tenants as tenant
     cross join lifecycle_period_snapshot as snapshot
     where tenant.id = 'saas-lifecycle-paid')
  and (select count(*) = 1
       from public.saas_invoices where asaas_payment_id = 'pay_renewal'),
  'replay do mesmo payment_id estendeu ou duplicou o periodo'
);

select public.apply_saas_checkout_billing_event(
  p_checkout_id => '00000000-0000-4000-8000-000000000c02',
  p_event_name => 'PAYMENT_REFUNDED',
  p_payment_id => 'pay_renewal',
  p_payment_value => 197,
  p_billing_type => 'PIX',
  p_customer_id => 'cus_lifecycle',
  p_subscription_id => 'sub_lifecycle'
);

select pg_temp.assert_true(
  (select saas_status = 'blocked' and current_period_end <= now()
     from public.tenants where id = 'saas-lifecycle-paid')
  and (select status = 'CANCELLED'
       from public.saas_checkout_intents
       where id = '00000000-0000-4000-8000-000000000c02')
  and (select status = 'REFUNDED'
       from public.saas_invoices where asaas_payment_id = 'pay_renewal')
  and not private.tenant_is_operational('saas-lifecycle-paid'),
  'refund nao revogou o acesso e a fatura no mesmo passo'
);

select public.apply_saas_checkout_billing_event(
  p_checkout_id => '00000000-0000-4000-8000-000000000c02',
  p_event_name => 'PAYMENT_RECEIVED',
  p_payment_id => 'pay_renewal',
  p_payment_value => 197,
  p_billing_type => 'PIX',
  p_customer_id => 'cus_lifecycle',
  p_subscription_id => 'sub_lifecycle',
  p_paid_at => now()
);

select pg_temp.assert_true(
  private.tenant_is_operational('saas-lifecycle-paid')
  and (select status = 'PAID'
       from public.saas_invoices where asaas_payment_id = 'pay_renewal'),
  'evento pago autoritativo nao restaurou o mesmo periodo revertido'
);

select public.apply_saas_checkout_billing_event(
  p_checkout_id => '00000000-0000-4000-8000-000000000c02',
  p_event_name => 'SUBSCRIPTION_DELETED',
  p_payment_value => 197,
  p_billing_type => 'PIX',
  p_customer_id => 'cus_lifecycle',
  p_subscription_id => 'sub_lifecycle',
  p_billing_cycle => 'MONTHLY'
);

select pg_temp.assert_true(
  (select saas_status = 'blocked'
     from public.tenants where id = 'saas-lifecycle-paid')
  and (select status = 'CANCELLED'
       from public.saas_checkout_intents
       where id = '00000000-0000-4000-8000-000000000c02')
  and not private.tenant_is_operational('saas-lifecycle-paid'),
  'exclusao da assinatura no provedor nao bloqueou o tenant'
);

do $$
begin
  perform public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-000000000c02',
    p_event_name => 'PAYMENT_RECEIVED',
    p_payment_id => 'pay_after_terminal_cancel',
    p_payment_value => 197,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_lifecycle',
    p_subscription_id => 'sub_lifecycle',
    p_paid_at => now()
  );
  raise exception 'assertion failed: nova cobranca reativou assinatura removida';
exception when object_not_in_prerequisite_state then null;
end;
$$;

do $$
begin
  perform public.apply_saas_checkout_billing_event(
    p_checkout_id => '00000000-0000-4000-8000-000000000c02',
    p_event_name => 'PAYMENT_RECEIVED',
    p_payment_id => 'pay_wrong_amount',
    p_payment_value => 1,
    p_billing_type => 'PIX',
    p_customer_id => 'cus_lifecycle',
    p_subscription_id => 'sub_lifecycle'
  );
  raise exception 'assertion failed: valor divergente foi aceito';
exception when insufficient_privilege then null;
end;
$$;

select pg_temp.assert_true(
  not has_table_privilege(
    'authenticated',
    'public.saas_billing_event_inbox',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'public.saas_billing_event_inbox',
    'INSERT'
  )
  and has_table_privilege(
    'service_role',
    'public.saas_billing_event_inbox',
    'INSERT'
  )
  and not has_function_privilege(
    'authenticated',
    'public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)',
    'EXECUTE'
  ),
  'inbox ou RPC financeira ficou exposta ao cliente'
);

rollback;
