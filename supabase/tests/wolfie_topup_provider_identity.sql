-- Exact provider identity is mandatory before a top-up webhook can bind a
-- payment or credit minutes.

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

grant execute on all functions in schema pg_temp
  to anon, authenticated, service_role;

select pg_temp.assert_true(
  not has_function_privilege(
    'service_role',
    'public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.apply_verified_wolfie_topup_payment(uuid,text,text,numeric,numeric,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.apply_verified_wolfie_topup_payment(uuid,text,text,numeric,numeric,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_adopt_wolfie_topup_provider_binding(uuid,uuid,uuid,uuid,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.hub_adopt_wolfie_topup_provider_binding(uuid,uuid,uuid,uuid,text,text,text)',
    'EXECUTE'
  ),
  'only the verified worker entry point may apply a top-up webhook'
);

insert into public.tenants (id, name)
values ('topup-identity-test', 'Top-up Identity Test')
on conflict (id) do update
set name = excluded.name;

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f151',
  'authenticated',
  'authenticated',
  'topup-identity@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Topup Identity Fixture"}',
  pg_catalog.now(),
  pg_catalog.now()
)
on conflict (id) do update
set
  aud = excluded.aud,
  role = excluded.role,
  email = excluded.email,
  raw_app_meta_data = excluded.raw_app_meta_data,
  raw_user_meta_data = excluded.raw_user_meta_data,
  updated_at = excluded.updated_at;

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'topup-identity-test',
       role = 'STUDENT',
       lifecycle_status = 'active',
       asaas_customer_id = 'cus_topup_exact',
       is_test_account = true,
       test_fixture_key = 'topup-provider-identity-sql'
 where id = '00000000-0000-4000-8000-00000000f151';
set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '00000000-0000-4000-8000-00000000f151',
  'topup-identity-test',
  'STUDENT',
  'ACTIVE',
  true
)
on conflict (user_id, tenant_id) do update
set
  role = excluded.role,
  status = excluded.status,
  is_primary = excluded.is_primary;

insert into public.wolfie_topup_packages (
  id, tenant_id, name, minutes, price_brl, active
) values (
  '00000000-0000-4000-8000-00000000f152',
  'topup-identity-test',
  'Fixture 5 minutes',
  5,
  5.00,
  true
)
on conflict (id) do update
set
  tenant_id = excluded.tenant_id,
  name = excluded.name,
  minutes = excluded.minutes,
  price_brl = excluded.price_brl,
  active = excluded.active;

insert into public.wolfie_topup_orders (
  id, tenant_id, student_id, package_id, package_name, minutes, amount_brl,
  request_key, status, provider_customer_id
) values (
  '00000000-0000-4000-8000-00000000f153',
  'topup-identity-test',
  '00000000-0000-4000-8000-00000000f151',
  '00000000-0000-4000-8000-00000000f152',
  'Fixture 5 minutes',
  5,
  5.00,
  '00000000-0000-4000-8000-00000000f154',
  'AWAITING_PAYMENT',
  'cus_topup_exact'
)
on conflict (id) do update
set
  tenant_id = excluded.tenant_id,
  student_id = excluded.student_id,
  package_id = excluded.package_id,
  package_name = excluded.package_name,
  minutes = excluded.minutes,
  amount_brl = excluded.amount_brl,
  request_key = excluded.request_key,
  status = excluded.status,
  provider_customer_id = excluded.provider_customer_id;

do $unproven_payment$
begin
  perform public.apply_verified_wolfie_topup_payment(
    '00000000-0000-4000-8000-00000000f153',
    'pay_topup_exact',
    'PAYMENT_RECEIVED',
    5.00,
    null,
    'cus_topup_exact',
    'wolfie-topup-order:00000000-0000-4000-8000-00000000f153',
    'PIX'
  );
  raise exception 'assertion failed: unproven payment was adopted';
exception when others then
  if sqlerrm <> 'wolfie_topup_provider_creation_unproven' then
    raise;
  end if;
end;
$unproven_payment$;

insert into public.asaas_provider_creation_attempts (
  tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at,
  submit_attempt_count, provider_entity_id, completed_at
) values (
  'topup-identity-test',
  'PAYMENT_CREATE',
  '00000000-0000-4000-8000-00000000f153',
  'wolfie-topup-order:00000000-0000-4000-8000-00000000f153',
  repeat('a', 64),
  'SUCCEEDED',
  '00000000-0000-4000-8000-00000000f155',
  pg_catalog.now(),
  1,
  'pay_topup_exact',
  pg_catalog.now()
)
on conflict (tenant_id, operation, logical_key) do update
set
  external_reference = excluded.external_reference,
  request_fingerprint = excluded.request_fingerprint,
  status = excluded.status,
  claim_token = excluded.claim_token,
  lease_expires_at = excluded.lease_expires_at,
  submit_attempt_count = excluded.submit_attempt_count,
  provider_entity_id = excluded.provider_entity_id,
  completed_at = excluded.completed_at;

do $unsettled_confirmation$
begin
  perform public.apply_verified_wolfie_topup_payment(
    '00000000-0000-4000-8000-00000000f153',
    'pay_topup_exact',
    ' payment_confirmed ',
    5.00,
    null,
    'cus_topup_exact',
    'wolfie-topup-order:00000000-0000-4000-8000-00000000f153',
    'PIX'
  );
  raise exception 'assertion failed: unsettled confirmation credited minutes';
exception when others then
  if sqlerrm <> 'invalid_wolfie_topup_event' then
    raise;
  end if;
end;
$unsettled_confirmation$;

do $cross_customer$
begin
  perform public.apply_verified_wolfie_topup_payment(
    '00000000-0000-4000-8000-00000000f153',
    'pay_topup_exact',
    'PAYMENT_RECEIVED',
    5.00,
    null,
    'cus_other_tenant',
    'wolfie-topup-order:00000000-0000-4000-8000-00000000f153',
    'PIX'
  );
  raise exception 'assertion failed: cross-customer payment was accepted';
exception when others then
  if sqlerrm <> 'wolfie_topup_provider_identity_mismatch' then
    raise;
  end if;
end;
$cross_customer$;

do $cross_reference$
begin
  perform public.apply_verified_wolfie_topup_payment(
    '00000000-0000-4000-8000-00000000f153',
    'pay_topup_exact',
    'PAYMENT_RECEIVED',
    5.00,
    null,
    'cus_topup_exact',
    'wolfie-topup-order:00000000-0000-4000-8000-00000000ffff',
    'PIX'
  );
  raise exception 'assertion failed: cross-reference payment was accepted';
exception when others then
  if sqlerrm <> 'wolfie_topup_provider_identity_mismatch' then
    raise;
  end if;
end;
$cross_reference$;

set local role service_role;
select public.apply_verified_wolfie_topup_payment(
  '00000000-0000-4000-8000-00000000f153',
  'pay_topup_exact',
  ' payment_received ',
  5.00,
  null,
  'cus_topup_exact',
  'wolfie-topup-order:00000000-0000-4000-8000-00000000f153',
  'PIX'
);
reset role;

set local role service_role;
select pg_temp.assert_true(
  (
    public.apply_verified_wolfie_topup_payment(
      '00000000-0000-4000-8000-00000000f153',
      'pay_topup_exact',
      ' payment_received_in_cash ',
      5.00,
      null,
      'cus_topup_exact',
      'wolfie-topup-order:00000000-0000-4000-8000-00000000f153',
      'PIX'
    ) ->> 'paid'
  )::boolean,
  'settled cash event must remain accepted after normalization'
);
reset role;

select pg_temp.assert_true(
  (
    select status = 'PAID'
       and provider_payment_id = 'pay_topup_exact'
      from public.wolfie_topup_orders
     where id = '00000000-0000-4000-8000-00000000f153'
  )
  and (
    select count(*) = 1 and min(minutes) = 5 and min(status) = 'PAID'
      from public.student_minute_credits
     where order_id = '00000000-0000-4000-8000-00000000f153'
  ),
  'an exact durable provider identity must credit exactly once'
);

do $immutable_customer_snapshot$
begin
  update public.wolfie_topup_orders
     set provider_customer_id = 'cus_rebound'
   where id = '00000000-0000-4000-8000-00000000f153';
  raise exception 'assertion failed: customer snapshot changed';
exception when others then
  if sqlerrm <> 'wolfie_topup_customer_snapshot_immutable' then
    raise;
  end if;
end;
$immutable_customer_snapshot$;

rollback;
