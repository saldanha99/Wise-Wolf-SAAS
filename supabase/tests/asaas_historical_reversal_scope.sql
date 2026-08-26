-- Proven historical reversals remain auditable after customer rotation and
-- integration offboarding, while every operational capability stays blocked.

begin;

set local timezone = 'UTC';

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $function$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$function$;
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

grant execute on all functions in schema pg_temp
  to anon, authenticated, service_role;

set local app.enrollment_claim = '1';

update public.tenants
   set saas_status = 'active'
 where id = 'school-wise-wolf';

select pg_temp.assert_true(
  private.tenant_is_operational('school-wise-wolf'),
  'fixture tenant was not operational before connection-state tests'
);

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000a621',
  'authenticated',
  'authenticated',
  'asaas-historical-reversal@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Historical Reversal Student"}',
  now(),
  now()
);

update public.profiles
   set tenant_id = 'school-wise-wolf',
       role = 'STUDENT',
       lifecycle_status = 'active',
       status = 'ACTIVE',
       full_name = 'Historical Reversal Student',
       asaas_customer_id = 'cus_historical_original'
 where id = '00000000-0000-4000-8000-00000000a621';

insert into public.student_payments (
  asaas_payment_id,
  student_id,
  tenant_id,
  value,
  status,
  provider_status,
  due_date,
  payment_date,
  credited_at,
  raw_payload,
  last_provider_event_id,
  last_provider_event_at,
  last_provider_event_rank
) values (
  'pay_historical_reversal_binding',
  '00000000-0000-4000-8000-00000000a621',
  'school-wise-wolf',
  10.00,
  'RECEIVED',
  'RECEIVED',
  date '2026-07-10',
  date '2026-07-09',
  timestamptz '2026-07-11 14:30:00+00',
  jsonb_build_object(
    'id', 'evt_historical_original_receipt',
    'event', 'PAYMENT_RECEIVED',
    'dateCreated', '2026-07-11T14:30:00Z',
    'payment', jsonb_build_object(
      'id', 'pay_historical_reversal_binding',
      'customer', 'cus_historical_original',
      'value', 10.00,
      'dueDate', '2026-07-10',
      'paymentDate', '2026-07-09',
      'creditDate', '2026-07-11'
    )
  ),
  'evt_historical_original_receipt',
  timestamptz '2026-07-11 14:30:00+00',
  80
);

select pg_temp.assert_true(
  (
    select payment.provider_customer_id = 'cus_historical_original'
      from public.student_payments as payment
     where payment.asaas_payment_id = 'pay_historical_reversal_binding'
  ),
  'insert did not capture the immutable provider customer'
);

create temporary table historical_payment_snapshot
on commit drop
as
select
  payment.id,
  payment.student_id,
  payment.tenant_id,
  payment.asaas_payment_id,
  payment.provider_customer_id,
  payment.value,
  payment.amount_cents,
  payment.due_date,
  payment.payment_date,
  payment.credited_at,
  payment.paid_at,
  payment.raw_payload
from public.student_payments as payment
where payment.asaas_payment_id = 'pay_historical_reversal_binding';
grant select on historical_payment_snapshot to service_role;

-- Rotate the current profile customer. The old payment remains owned by the
-- provider customer captured at issuance and must not adopt the new profile.
update public.profiles
   set asaas_customer_id = 'cus_historical_rotated'
 where id = '00000000-0000-4000-8000-00000000a621';

do $provider_customer_is_immutable$
begin
  begin
    update public.student_payments
       set provider_customer_id = 'cus_historical_rotated'
     where asaas_payment_id = 'pay_historical_reversal_binding';
    raise exception 'assertion failed: provider customer was mutable';
  exception
    when check_violation then null;
  end;
end
$provider_customer_is_immutable$;

-- Disabled connection: only the secret-free reversal authorization survives.
update private.tenant_integration_connections
   set mode = 'DISABLED',
       status = 'disabled',
       last_verified_at = null,
       last_error_code = null
 where tenant_id = 'school-wise-wolf'
   and provider = 'asaas';

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  (
    with resolved as (
      select public.resolve_tenant_integration_for_service(
        'school-wise-wolf',
        'asaas',
        'webhook.consume',
        'payment.reversal'
      ) as value
    )
    select value ->> 'mode' = 'HISTORICAL_WEBHOOK'
       and value ->> 'tenantId' = 'school-wise-wolf'
       and value ->> 'provider' = 'asaas'
       and value ->> 'apiKey' is null
       and value ->> 'baseUrl' is null
      from resolved
  ),
  'disabled connection could not issue a secret-free reversal authorization'
);

do $disabled_connection_blocks_ordinary_event$
begin
  begin
    perform public.resolve_tenant_integration_for_service(
      'school-wise-wolf',
      'asaas',
      'webhook.consume',
      'payment.event'
    );
    raise exception 'assertion failed: disabled connection accepted ordinary event';
  exception
    when sqlstate '55000' then null;
  end;
end
$disabled_connection_blocks_ordinary_event$;

reset role;

-- An offboarded/error credential state has the same narrow exception. No
-- operational endpoint or API key is recovered by this resolution.
update private.tenant_integration_connections
   set mode = 'PLATFORM_MANAGED_ROOT',
       status = 'error',
       last_verified_at = null,
       last_error_code = 'credential_offboarded'
 where tenant_id = 'school-wise-wolf'
   and provider = 'asaas';

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  (
    public.resolve_tenant_integration_for_service(
      'school-wise-wolf',
      'asaas',
      'webhook.consume',
      'payment.reversal'
    ) ->> 'mode'
  ) = 'HISTORICAL_WEBHOOK',
  'error/offboarded connection blocked a historical reversal'
);

do $error_connection_blocks_billing$
begin
  begin
    perform public.resolve_tenant_integration_for_service(
      'school-wise-wolf',
      'asaas',
      'billing.school',
      'payment.read'
    );
    raise exception 'assertion failed: error connection accepted provider GET';
  exception
    when sqlstate '55000' then null;
  end;
end
$error_connection_blocks_billing$;

-- The successful correction uses the payment's original customer after the
-- profile was rotated. Contradictory provider status remains raw evidence, but
-- the canonical local status is forced to REFUNDED by full-refund proof.
select pg_temp.assert_true(
  (
    public.apply_historical_asaas_payment_reversal(
      'pay_historical_reversal_binding',
      (
        select id
          from public.student_payments
         where asaas_payment_id = 'pay_historical_reversal_binding'
      ),
      '00000000-0000-4000-8000-00000000a621',
      'school-wise-wolf',
      'cus_historical_original',
      'evt_historical_full_refund',
      'PAYMENT_REFUNDED',
      timestamptz '2026-08-20 18:45:00+00',
      100,
      'RECEIVED',
      10.00,
      jsonb_build_object(
        'id', 'evt_historical_full_refund',
        'event', 'PAYMENT_REFUNDED',
        'dateCreated', '2026-08-20T18:45:00Z',
        'payment', jsonb_build_object(
          'id', 'pay_historical_reversal_binding',
          'customer', 'cus_historical_original',
          'status', 'RECEIVED',
          'value', 10.00
        )
      )
    ) ->> 'action'
  ) = 'UPDATED',
  'bound historical reversal was not atomically updated'
);

select pg_temp.assert_true(
  (
    select payment.status = 'REFUNDED'
       and payment.provider_status = 'RECEIVED'
       and payment.refunded_amount = 10.00
       and payment.last_provider_event_id = 'evt_historical_full_refund'
       and payment.last_provider_event_at =
             timestamptz '2026-08-20 18:45:00+00'
       and payment.student_id is not distinct from snapshot.student_id
       and payment.tenant_id is not distinct from snapshot.tenant_id
       and payment.asaas_payment_id is not distinct from snapshot.asaas_payment_id
       and payment.provider_customer_id is not distinct from
             snapshot.provider_customer_id
       and payment.value is not distinct from snapshot.value
       and payment.amount_cents is not distinct from snapshot.amount_cents
       and payment.due_date is not distinct from snapshot.due_date
       and payment.payment_date is not distinct from snapshot.payment_date
       and payment.credited_at is not distinct from snapshot.credited_at
       and payment.paid_at is not distinct from snapshot.paid_at
       and payment.raw_payload is not distinct from snapshot.raw_payload
      from public.student_payments as payment
      cross join historical_payment_snapshot as snapshot
     where payment.asaas_payment_id = 'pay_historical_reversal_binding'
  ),
  'historical reversal changed gross value, identity, raw snapshot, or dates'
);

select pg_temp.assert_true(
  (
    select count(*) filter (
             where transaction.type = 'ENTRADA'
               and transaction.amount = 10.00
           ) = 1
       and count(*) filter (
             where transaction.type = 'SAIDA'
               and transaction.amount = 10.00
               and transaction.provider_event_id =
                     'evt_historical_full_refund'
               and transaction.occurred_at =
                     timestamptz '2026-08-20 18:45:00+00'
           ) = 1
      from public.financial_transactions as transaction
      join public.student_payments as payment
        on payment.id in (
          transaction.student_payment_id,
          transaction.refund_student_payment_id
        )
     where payment.asaas_payment_id = 'pay_historical_reversal_binding'
  ),
  'historical reversal did not preserve gross receipt plus exact refund entry'
);

-- Missing local provider IDs return an explicit no-op and never recreate a
-- payment from the webhook snapshot.
select pg_temp.assert_true(
  (
    public.apply_historical_asaas_payment_reversal(
      'pay_historical_missing',
      '00000000-0000-4000-8000-00000000a622',
      '00000000-0000-4000-8000-00000000a621',
      'school-wise-wolf',
      'cus_historical_original',
      'evt_historical_missing',
      'PAYMENT_REFUNDED',
      timestamptz '2026-08-21 18:45:00+00',
      100,
      'REFUNDED',
      10.00,
      jsonb_build_object(
        'id', 'evt_historical_missing',
        'event', 'PAYMENT_REFUNDED',
        'payment', jsonb_build_object(
          'id', 'pay_historical_missing',
          'customer', 'cus_historical_original',
          'value', 10.00
        )
      )
    ) ->> 'reason'
  ) = 'payment_not_found'
  and not exists (
    select 1
      from public.student_payments
     where asaas_payment_id = 'pay_historical_missing'
  ),
  'missing historical payment was recreated from provider payload'
);

do $rotated_payload_cannot_adopt_payment$
begin
  begin
    perform public.apply_historical_asaas_payment_reversal(
      'pay_historical_reversal_binding',
      (
        select id
          from public.student_payments
         where asaas_payment_id = 'pay_historical_reversal_binding'
      ),
      '00000000-0000-4000-8000-00000000a621',
      'school-wise-wolf',
      'cus_historical_original',
      'evt_historical_wrong_customer',
      'PAYMENT_REFUNDED',
      timestamptz '2026-08-22 18:45:00+00',
      100,
      'REFUNDED',
      10.00,
      jsonb_build_object(
        'id', 'evt_historical_wrong_customer',
        'event', 'PAYMENT_REFUNDED',
        'payment', jsonb_build_object(
          'id', 'pay_historical_reversal_binding',
          'customer', 'cus_historical_rotated',
          'value', 10.00
        )
      )
    );
    raise exception 'assertion failed: rotated payload adopted old payment';
  exception
    when check_violation then null;
  end;
end
$rotated_payload_cannot_adopt_payment$;

reset role;

-- Tenant suspension is independently bypassed for the same narrow receipt.
update public.tenants
   set saas_status = 'suspended'
 where id = 'school-wise-wolf';

select pg_temp.assert_true(
  not private.tenant_is_operational('school-wise-wolf'),
  'fixture tenant did not become non-operational'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  (
    public.resolve_tenant_integration_for_service(
      'school-wise-wolf',
      'asaas',
      'webhook.consume',
      'payment.reversal'
    ) ->> 'mode'
  ) = 'HISTORICAL_WEBHOOK',
  'suspended tenant could not authorize historical reversal'
);

do $ordinary_event_stays_blocked$
begin
  begin
    perform public.resolve_tenant_integration_for_service(
      'school-wise-wolf',
      'asaas',
      'webhook.consume',
      'payment.event'
    );
    raise exception 'assertion failed: inactive tenant accepted ordinary webhook';
  exception
    when insufficient_privilege then null;
  end;
end
$ordinary_event_stays_blocked$;

do $crossed_capability_stays_blocked$
begin
  begin
    perform public.resolve_tenant_integration_for_service(
      'school-wise-wolf',
      'asaas',
      'billing.school',
      'payment.reversal'
    );
    raise exception 'assertion failed: reversal accepted the wrong capability';
  exception
    when insufficient_privilege then null;
  end;
end
$crossed_capability_stays_blocked$;

reset role;

rollback;
