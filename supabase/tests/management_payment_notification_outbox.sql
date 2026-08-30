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
grant execute on function pg_temp.assert_true(boolean, text)
  to anon, authenticated, service_role;

select pg_temp.assert_true(
  pg_catalog.to_regclass(
    'public.management_payment_notification_outbox'
  ) is not null
  and pg_catalog.to_regprocedure(
    'public.management_payment_notification_pending(integer)'
  ) is not null
  and pg_catalog.to_regprocedure(
    'public.claim_management_payment_notification(text,uuid,uuid,integer)'
  ) is not null
  and pg_catalog.to_regprocedure(
    'public.begin_management_payment_notification_submission(uuid,uuid,text,text,text,uuid,bigint,jsonb,text)'
  ) is not null
  and pg_catalog.to_regprocedure(
    'public.management_payment_notification_source_snapshot(text,uuid,text)'
  ) is not null
  and pg_catalog.to_regprocedure(
    'public.authorize_management_payment_notification_submission(uuid,uuid,uuid,bigint,text,text)'
  ) is not null
  and pg_catalog.to_regprocedure(
    'public.finish_management_payment_notification(uuid,uuid,text,text,integer,text)'
  ) is not null
  and pg_catalog.to_regprocedure(
    'public.management_payment_notification_attention(integer)'
  ) is not null,
  'management payment notification outbox contract is incomplete'
);

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'anon',
    'public.management_payment_notification_outbox',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.management_payment_notification_outbox',
    'SELECT'
  )
  and pg_catalog.has_table_privilege(
    'service_role',
    'public.management_payment_notification_outbox',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.management_payment_notification_outbox',
    'INSERT'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.claim_management_payment_notification(text,uuid,uuid,integer)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.finish_management_payment_notification(uuid,uuid,text,text,integer,text)',
    'EXECUTE'
  ),
  'management payment outbox privileges are unsafe'
);

select pg_temp.assert_true(
  (
    select pg_catalog.count(*)
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid = 'public.student_payments'::pg_catalog.regclass
      and not trigger.tgisinternal
      and trigger.tgname in (
        'trg_notify_payment_split',
        'trg_notify_management_payment_confirmation'
      )
  ) = 1
  and exists (
    select 1
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid = 'public.student_payments'::pg_catalog.regclass
      and not trigger.tgisinternal
      and trigger.tgname = 'trg_notify_payment_split'
  ),
  'split and simple payment messages still have competing triggers'
);

insert into public.tenants (
  id, name, slug, saas_status, whatsapp_enabled
) values (
  'management-payment-outbox-school',
  'Management Payment Outbox School',
  'management-payment-outbox-school',
  'active',
  true
);

insert into public.dre_report_settings (
  tenant_id, destino, cadencia, dia_semana, is_active
) values (
  'management-payment-outbox-school',
  '120363000000000701@g.us',
  'diaria',
  1,
  true
);

insert into public.payment_split_settings (
  tenant_id,
  dizimo_pct,
  investimento_pct,
  escola_pct,
  prof_dizimo_pct,
  prof_investimento_pct,
  prof_prolabore_pct,
  is_active
) values (
  'management-payment-outbox-school',
  10,
  10,
  0,
  10,
  70,
  20,
  false
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '71000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated',
    'management-outbox-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Management Outbox Admin"}',
    pg_catalog.now(), pg_catalog.now()
  ),
  (
    '71000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated',
    'management-outbox-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Management Outbox Student"}',
    pg_catalog.now(), pg_catalog.now()
  ),
  (
    '71000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated',
    'management-outbox-fixture@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Management Outbox Fixture"}',
    pg_catalog.now(), pg_catalog.now()
  );

set local app.enrollment_claim = '1';
update public.profiles
set tenant_id = 'management-payment-outbox-school',
    role = 'SCHOOL_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Management Outbox Admin',
    phone = '5511999990701'
where id = '71000000-0000-4000-8000-000000000001';
update public.profiles
set tenant_id = 'management-payment-outbox-school',
    role = 'STUDENT',
    lifecycle_status = 'active',
    full_name = 'Management Outbox Student',
    is_test_account = false,
    test_fixture_key = null
where id = '71000000-0000-4000-8000-000000000002';
update public.profiles
set tenant_id = 'management-payment-outbox-school',
    role = 'STUDENT',
    lifecycle_status = 'active',
    full_name = 'Management Outbox Fixture',
    is_test_account = true,
    test_fixture_key = 'management-payment-outbox-sql'
where id = '71000000-0000-4000-8000-000000000003';
set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  (
    '71000000-0000-4000-8000-000000000001',
    'management-payment-outbox-school',
    'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    '71000000-0000-4000-8000-000000000002',
    'management-payment-outbox-school',
    'STUDENT', 'ACTIVE', true
  ),
  (
    '71000000-0000-4000-8000-000000000003',
    'management-payment-outbox-school',
    'STUDENT', 'ACTIVE', true
  )
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values (
  '71000000-0000-4000-8000-000000000001',
  'management-payment-outbox-school'
)
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = pg_catalog.now();

insert into public.whatsapp_instances (
  user_id,
  tenant_id,
  instance_name,
  instance_id,
  status,
  inbox_enabled,
  inbox_enabled_at,
  webhook_auth_version
) values (
  '71000000-0000-4000-8000-000000000001',
  'management-payment-outbox-school',
  'management-outbox-instance',
  'management-outbox-provider-instance',
  'connected',
  true,
  pg_catalog.now(),
  3
);

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, status, due_date,
  raw_payload
) values
  (
    '71000000-0000-4000-8000-000000000011',
    '71000000-0000-4000-8000-000000000002',
    'management-payment-outbox-school',
    'pay_management_outbox_fallback',
    169,
    'PENDING',
    current_date,
    '{}'::jsonb
  ),
  (
    '71000000-0000-4000-8000-000000000012',
    '71000000-0000-4000-8000-000000000002',
    'management-payment-outbox-school',
    'pay_management_outbox_split',
    279,
    'PENDING',
    current_date,
    '{}'::jsonb
  ),
  (
    '71000000-0000-4000-8000-000000000013',
    '71000000-0000-4000-8000-000000000003',
    'management-payment-outbox-school',
    'pay_management_outbox_fixture',
    99,
    'PENDING',
    current_date,
    '{}'::jsonb
  ),
  (
    '71000000-0000-4000-8000-000000000014',
    '71000000-0000-4000-8000-000000000002',
    'management-payment-outbox-school',
    'pay_management_outbox_test_mode',
    49,
    'PENDING',
    current_date,
    '{"testMode":true}'::jsonb
  ),
  (
    '71000000-0000-4000-8000-000000000016',
    '71000000-0000-4000-8000-000000000002',
    'management-payment-outbox-school',
    'pay_management_outbox_test_fixture_payload',
    59,
    'PENDING',
    current_date,
    '{"test_fixture":true}'::jsonb
  ),
  (
    '71000000-0000-4000-8000-000000000017',
    '71000000-0000-4000-8000-000000000002',
    'management-payment-outbox-school',
    'pay_management_outbox_receipt',
    199,
    'PENDING',
    current_date,
    '{}'::jsonb
  ),
  (
    '71000000-0000-4000-8000-000000000018',
    '71000000-0000-4000-8000-000000000002',
    'management-payment-outbox-school',
    'pay_management_outbox_stale_source',
    209,
    'PENDING',
    current_date,
    '{}'::jsonb
  ),
  (
    '71000000-0000-4000-8000-000000000019',
    '71000000-0000-4000-8000-000000000002',
    'management-payment-outbox-school',
    'pay_management_outbox_final_route_fence',
    219,
    'PENDING',
    current_date,
    '{}'::jsonb
  );

update public.student_payments
set status = 'RECEIVED',
    provider_status = 'RECEIVED',
    payment_date = current_date,
    paid_at = pg_catalog.now(),
    credited_at = pg_catalog.now()
where id = '71000000-0000-4000-8000-000000000011';

update public.student_payments
set status = 'RECEIVED',
    provider_status = 'RECEIVED',
    payment_date = current_date,
    paid_at = pg_catalog.now(),
    credited_at = pg_catalog.now()
where id in (
  '71000000-0000-4000-8000-000000000017',
  '71000000-0000-4000-8000-000000000018',
  '71000000-0000-4000-8000-000000000019'
);

select pg_temp.assert_true(
  (
    select status = 'PENDING'
      and notification_kind = 'PAYMENT_RECEIVED'
      and submit_attempt_count = 0
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000011'
  ),
  'settlement and fallback outbox intent were not written atomically'
);

-- A repeated provider transition cannot create a second flavor/message.
update public.student_payments
set status = 'PENDING'
where id = '71000000-0000-4000-8000-000000000011';
update public.student_payments
set status = 'RECEIVED'
where id = '71000000-0000-4000-8000-000000000011';

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 1
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000011'
  ),
  'one payment produced duplicate management notification intents'
);

-- The sweep is driven by durable status, never by a recent-time heuristic.
update public.management_payment_notification_outbox
set created_at = '2020-01-01 00:00:00+00'
where payment_id = '71000000-0000-4000-8000-000000000011';

select pg_temp.assert_true(
  exists (
    select 1
    from public.management_payment_notification_pending(100) as pending
    where pending.payment_id = '71000000-0000-4000-8000-000000000011'
      and pending.notification_kind = 'PAYMENT_RECEIVED'
  ),
  'old durable pending intent fell outside the sweep'
);

create temporary table management_payment_outbox_results (
  label text primary key,
  payload jsonb not null
);

insert into management_payment_outbox_results values (
  'fallback-claim',
  public.claim_management_payment_notification(
    'management-payment-outbox-school',
    '71000000-0000-4000-8000-000000000011',
    '71000000-0000-4000-8000-000000000101',
    300
  )
);

insert into management_payment_outbox_results
select
  'fallback-begin',
  public.begin_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'fallback-claim'),
    '71000000-0000-4000-8000-000000000101',
    '120363000000000701@g.us',
    '120363000000000701@g.us',
    instance.instance_name,
    instance.integration_id,
    instance.integration_version,
    public.management_payment_notification_source_snapshot(
      'management-payment-outbox-school',
      '71000000-0000-4000-8000-000000000011',
      'PAYMENT_RECEIVED'
    ),
    'Pagamento recebido e selado para o grupo de gestao.'
  )
from public.whatsapp_instances as instance
where instance.tenant_id = 'management-payment-outbox-school'
  and instance.instance_name = 'management-outbox-instance';

insert into management_payment_outbox_results values (
  'fallback-authorize',
  public.authorize_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'fallback-claim'),
    '71000000-0000-4000-8000-000000000101',
    (select integration_id
       from public.whatsapp_instances
      where tenant_id = 'management-payment-outbox-school'
        and instance_name = 'management-outbox-instance'),
    (select integration_version
       from public.whatsapp_instances
      where tenant_id = 'management-payment-outbox-school'
        and instance_name = 'management-outbox-instance'),
    repeat('a', 64),
    repeat('b', 64)
  )
);

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PREPARED'
      and payload ->> 'provider_destination' =
        '120363000000000701@g.us'
      and payload ->> 'provider_instance_name' =
        'management-outbox-instance'
      and payload ->> 'source_snapshot_hash' ~ '^[0-9a-f]{64}$'
    from management_payment_outbox_results
    where label = 'fallback-begin'
  )
  and (
    select payload ->> 'action' = 'SUBMITTING'
      and payload ->> 'provider_endpoint_hash' = repeat('a', 64)
      and payload ->> 'provider_credential_hash' = repeat('b', 64)
      and payload ->> 'snapshot_hash' ~ '^[0-9a-f]{64}$'
    from management_payment_outbox_results
    where label = 'fallback-authorize'
  )
  and (
    select status = 'SUBMITTING'
      and submit_attempt_count = 1
      and message_body =
        'Pagamento recebido e selado para o grupo de gestao.'
      and provider_integration_id is not null
      and provider_integration_version > 0
      and provider_endpoint_hash = repeat('a', 64)
      and provider_credential_hash = repeat('b', 64)
      and pg_catalog.jsonb_typeof(source_snapshot) = 'object'
      and source_snapshot_hash ~ '^[0-9a-f]{64}$'
      and snapshot_hash ~ '^[0-9a-f]{64}$'
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000011'
  ),
  'final pre-submit fence did not seal the immutable provider snapshot'
);

insert into management_payment_outbox_results values (
  'fallback-unknown',
  public.finish_management_payment_notification(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'fallback-claim'),
    '71000000-0000-4000-8000-000000000101',
    'SENT',
    null,
    200,
    null
  )
);

insert into management_payment_outbox_results values (
  'fallback-after-unknown',
  public.claim_management_payment_notification(
    'management-payment-outbox-school',
    '71000000-0000-4000-8000-000000000011',
    '71000000-0000-4000-8000-000000000102',
    300
  )
);

select pg_temp.assert_true(
  (
    select payload ->> 'status' = 'UNKNOWN'
      and payload ->> 'provider_delivery_status' = 'uncertain'
    from management_payment_outbox_results
    where label = 'fallback-unknown'
  )
  and (
    select payload ->> 'action' = 'ALREADY_FINAL'
      and payload ->> 'status' = 'UNKNOWN'
    from management_payment_outbox_results
    where label = 'fallback-after-unknown'
  )
  and exists (
    select 1
    from public.management_payment_notification_attention(100) as attention
    where attention.payment_id = '71000000-0000-4000-8000-000000000011'
      and attention.status = 'UNKNOWN'
      and attention.submit_attempt_count = 1
      and attention.provider_message_id is null
      and attention.provider_delivery_status = 'uncertain'
  ),
  'unidentifiable 2xx was retried or disappeared from operational attention'
);

insert into management_payment_outbox_results values (
  'stale-source-before',
  public.management_payment_notification_source_snapshot(
    'management-payment-outbox-school',
    '71000000-0000-4000-8000-000000000018',
    'PAYMENT_RECEIVED'
  )
);

insert into management_payment_outbox_results values (
  'stale-source-claim',
  public.claim_management_payment_notification(
    'management-payment-outbox-school',
    '71000000-0000-4000-8000-000000000018',
    '71000000-0000-4000-8000-000000000104',
    300
  )
);

update public.student_payments
set value = 210
where id = '71000000-0000-4000-8000-000000000018';

insert into management_payment_outbox_results
select
  'stale-source-begin',
  public.begin_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'stale-source-claim'),
    '71000000-0000-4000-8000-000000000104',
    '120363000000000701@g.us',
    '120363000000000701@g.us',
    instance.instance_name,
    instance.integration_id,
    instance.integration_version,
    (select payload from management_payment_outbox_results
      where label = 'stale-source-before'),
    'Este corpo usa o valor antigo e nao pode ser enviado.'
  )
from public.whatsapp_instances as instance
where instance.tenant_id = 'management-payment-outbox-school'
  and instance.instance_name = 'management-outbox-instance';

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'RETRY'
      and payload ->> 'reason' =
        'management_payment_source_changed_before_send'
    from management_payment_outbox_results
    where label = 'stale-source-begin'
  )
  and (
    select status = 'CLAIMED'
      and submit_attempt_count = 0
      and source_snapshot is null
      and snapshot_hash is null
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000018'
  ),
  'stale financial source crossed the final snapshot fence'
);

insert into management_payment_outbox_results values (
  'final-route-fence-claim',
  public.claim_management_payment_notification(
    'management-payment-outbox-school',
    '71000000-0000-4000-8000-000000000019',
    '71000000-0000-4000-8000-000000000107',
    300
  )
);

insert into management_payment_outbox_results
select
  'final-route-fence-begin',
  public.begin_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'final-route-fence-claim'),
    '71000000-0000-4000-8000-000000000107',
    '120363000000000701@g.us',
    '120363000000000701@g.us',
    instance.instance_name,
    instance.integration_id,
    instance.integration_version,
    public.management_payment_notification_source_snapshot(
      'management-payment-outbox-school',
      '71000000-0000-4000-8000-000000000019',
      'PAYMENT_RECEIVED'
    ),
    'Esta mensagem deve parar se o canal de receipt mudar.'
  )
from public.whatsapp_instances as instance
where instance.tenant_id = 'management-payment-outbox-school'
  and instance.instance_name = 'management-outbox-instance';

update public.whatsapp_instances
set inbox_enabled = false,
    inbox_enabled_at = null,
    inbox_enabled_by = null,
    webhook_auth_version = 2
where tenant_id = 'management-payment-outbox-school'
  and instance_name = 'management-outbox-instance';

insert into management_payment_outbox_results values (
  'final-route-fence-authorize',
  public.authorize_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'final-route-fence-claim'),
    '71000000-0000-4000-8000-000000000107',
    (select integration_id
       from public.whatsapp_instances
      where tenant_id = 'management-payment-outbox-school'
        and instance_name = 'management-outbox-instance'),
    (select integration_version
       from public.whatsapp_instances
      where tenant_id = 'management-payment-outbox-school'
        and instance_name = 'management-outbox-instance'),
    repeat('8', 64),
    repeat('9', 64)
  )
);

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PREPARED'
    from management_payment_outbox_results
    where label = 'final-route-fence-begin'
  )
  and (
    select payload ->> 'action' = 'RETRY'
      and payload ->> 'reason' =
        'management_provider_binding_changed_at_final_fence'
    from management_payment_outbox_results
    where label = 'final-route-fence-authorize'
  )
  and (
    select status = 'PENDING'
      and submit_attempt_count = 0
      and provider_endpoint_hash is null
      and provider_credential_hash is null
      and snapshot_hash is null
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000019'
  ),
  'receipt capability change crossed the immediate pre-POST fence'
);

update public.whatsapp_instances
set inbox_enabled = true,
    inbox_enabled_at = pg_catalog.now(),
    webhook_auth_version = 3
where tenant_id = 'management-payment-outbox-school'
  and instance_name = 'management-outbox-instance';

insert into management_payment_outbox_results values (
  'receipt-claim',
  public.claim_management_payment_notification(
    'management-payment-outbox-school',
    '71000000-0000-4000-8000-000000000017',
    '71000000-0000-4000-8000-000000000105',
    300
  )
);

-- A connected admin instance without the v3 receipt webhook is not a valid
-- route: HTTP acceptance could never be reconciled to delivery.
update public.whatsapp_instances
set inbox_enabled = false,
    inbox_enabled_at = null,
    inbox_enabled_by = null,
    webhook_auth_version = 2
where tenant_id = 'management-payment-outbox-school'
  and instance_name = 'management-outbox-instance';

insert into management_payment_outbox_results
select
  'receipt-begin-without-receipts',
  public.begin_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'receipt-claim'),
    '71000000-0000-4000-8000-000000000105',
    '120363000000000701@g.us',
    '120363000000000701@g.us',
    instance.instance_name,
    instance.integration_id,
    instance.integration_version,
    public.management_payment_notification_source_snapshot(
      'management-payment-outbox-school',
      '71000000-0000-4000-8000-000000000017',
      'PAYMENT_RECEIVED'
    ),
    'Pagamento aguardando recibo verificavel do provedor.'
  )
from public.whatsapp_instances as instance
where instance.tenant_id = 'management-payment-outbox-school'
  and instance.instance_name = 'management-outbox-instance';

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'RETRY'
      and payload ->> 'reason' = 'management_provider_binding_changed'
    from management_payment_outbox_results
    where label = 'receipt-begin-without-receipts'
  )
  and (
    select status = 'CLAIMED' and submit_attempt_count = 0
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000017'
  ),
  'instance without inbox v3 crossed the provider fence'
);

update public.whatsapp_instances
set inbox_enabled = true,
    inbox_enabled_at = pg_catalog.now(),
    webhook_auth_version = 3
where tenant_id = 'management-payment-outbox-school'
  and instance_name = 'management-outbox-instance';

insert into management_payment_outbox_results
select
  'receipt-begin',
  public.begin_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'receipt-claim'),
    '71000000-0000-4000-8000-000000000105',
    '120363000000000701@g.us',
    '120363000000000701@g.us',
    instance.instance_name,
    instance.integration_id,
    instance.integration_version,
    public.management_payment_notification_source_snapshot(
      'management-payment-outbox-school',
      '71000000-0000-4000-8000-000000000017',
      'PAYMENT_RECEIVED'
    ),
    'Pagamento aguardando recibo verificavel do provedor.'
  )
from public.whatsapp_instances as instance
where instance.tenant_id = 'management-payment-outbox-school'
  and instance.instance_name = 'management-outbox-instance';

insert into management_payment_outbox_results values (
  'receipt-authorize',
  public.authorize_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'receipt-claim'),
    '71000000-0000-4000-8000-000000000105',
    (select integration_id
       from public.whatsapp_instances
      where tenant_id = 'management-payment-outbox-school'
        and instance_name = 'management-outbox-instance'),
    (select integration_version
       from public.whatsapp_instances
      where tenant_id = 'management-payment-outbox-school'
        and instance_name = 'management-outbox-instance'),
    repeat('c', 64),
    repeat('d', 64)
  )
);

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PREPARED'
    from management_payment_outbox_results
    where label = 'receipt-begin'
  )
  and (
    select payload ->> 'action' = 'SUBMITTING'
    from management_payment_outbox_results
    where label = 'receipt-authorize'
  ),
  'receipt-capable route did not pass both provider fences'
);

insert into management_payment_outbox_results values (
  'receipt-accepted',
  public.finish_management_payment_notification(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'receipt-claim'),
    '71000000-0000-4000-8000-000000000105',
    'SENT',
    'provider-management-receipt-17',
    200,
    null
  )
);

select pg_temp.assert_true(
  (
    select status = 'SUBMITTING'
      and provider_message_id = 'provider-management-receipt-17'
      and provider_delivery_status = 'accepted'
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000017'
  )
  and exists (
    select 1
    from public.management_payment_notification_attention(100) as attention
    where attention.payment_id = '71000000-0000-4000-8000-000000000017'
      and attention.status = 'SUBMITTING'
      and attention.provider_delivery_status = 'accepted'
  ),
  'HTTP acceptance was incorrectly treated as verified provider delivery'
);

insert into private.whatsapp_provider_delivery_receipts (
  tenant_id,
  provider_instance_name,
  provider_message_id,
  delivery_status,
  accepted_at,
  sent_at
) values (
  'management-payment-outbox-school',
  'management-outbox-instance',
  'provider-management-receipt-17',
  'sent',
  pg_catalog.now(),
  pg_catalog.now()
);

select pg_temp.assert_true(
  (
    select status = 'SUBMITTING'
      and provider_delivery_status = 'sent'
      and accepted_at is not null
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000017'
  )
  and exists (
    select 1
    from public.management_payment_notification_attention(100) as attention
    where attention.payment_id = '71000000-0000-4000-8000-000000000017'
      and attention.status = 'SUBMITTING'
      and attention.provider_delivery_status = 'sent'
  ),
  'SERVER_ACK was incorrectly treated as group delivery'
);

update private.whatsapp_provider_delivery_receipts
set delivery_status = 'delivered',
    delivered_at = pg_catalog.now(),
    last_seen_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
where tenant_id = 'management-payment-outbox-school'
  and provider_instance_name = 'management-outbox-instance'
  and provider_message_id = 'provider-management-receipt-17';

select pg_temp.assert_true(
  (
    select status = 'SENT'
      and provider_delivery_status = 'delivered'
      and delivered_at is not null
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000017'
  )
  and not exists (
    select 1
    from public.management_payment_notification_attention(100) as attention
    where attention.payment_id = '71000000-0000-4000-8000-000000000017'
  ),
  'DELIVERY_ACK did not finalize the management-group delivery'
);

update public.payment_split_settings
set is_active = true
where tenant_id = 'management-payment-outbox-school';

update public.student_payments
set status = 'RECEIVED',
    provider_status = 'RECEIVED',
    payment_date = current_date,
    paid_at = pg_catalog.now(),
    credited_at = pg_catalog.now()
where id = '71000000-0000-4000-8000-000000000012';

update public.student_payments
set status = 'RECEIVED',
    provider_status = 'RECEIVED',
    payment_date = current_date,
    paid_at = pg_catalog.now(),
    credited_at = pg_catalog.now()
where id = '71000000-0000-4000-8000-000000000013';

update public.student_payments
set status = 'RECEIVED',
    provider_status = 'RECEIVED',
    payment_date = current_date,
    paid_at = pg_catalog.now(),
    credited_at = pg_catalog.now()
where id = '71000000-0000-4000-8000-000000000014';

update public.student_payments
set status = 'RECEIVED',
    provider_status = 'RECEIVED',
    payment_date = current_date,
    paid_at = pg_catalog.now(),
    credited_at = pg_catalog.now()
where id = '71000000-0000-4000-8000-000000000016';

select pg_temp.assert_true(
  (
    select status = 'PENDING'
      and notification_kind = 'PAYMENT_SPLIT'
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000012'
  )
  and (
    select status = 'SUPPRESSED'
      and submit_attempt_count = 0
      and last_error = 'test_fixture_suppressed'
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000013'
  )
  and not exists (
    select 1
    from public.management_payment_notification_pending(100) as pending
    where pending.payment_id = '71000000-0000-4000-8000-000000000013'
  ),
  'canonical split selection or profile fixture suppression failed'
);

select pg_temp.assert_true(
  (
    select status = 'SUPPRESSED'
      and submit_attempt_count = 0
      and last_error = 'test_fixture_suppressed'
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000014'
  )
  and not exists (
    select 1
    from public.management_payment_notification_pending(100) as pending
    where pending.payment_id = '71000000-0000-4000-8000-000000000014'
  )
  and (
    select status = 'SUPPRESSED'
      and submit_attempt_count = 0
      and last_error = 'test_fixture_suppressed'
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000016'
  )
  and not exists (
    select 1
    from public.management_payment_notification_pending(100) as pending
    where pending.payment_id = '71000000-0000-4000-8000-000000000016'
  ),
  'testMode/test_fixture payment crossed the external-delivery suppression gate'
);

-- A fixture may settle while the management destination is disabled.  The
-- suppression row must still carry a canonical kind instead of aborting the
-- payment write on the outbox NOT NULL invariant.
update public.dre_report_settings
set is_active = false
where tenant_id = 'management-payment-outbox-school';

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, status, due_date,
  provider_status, payment_date, paid_at, credited_at, raw_payload
) values (
  '71000000-0000-4000-8000-000000000015',
  '71000000-0000-4000-8000-000000000002',
  'management-payment-outbox-school',
  'pay_management_outbox_disabled_fixture',
  39,
  'RECEIVED',
  current_date,
  'RECEIVED',
  current_date,
  pg_catalog.now(),
  pg_catalog.now(),
  '{"testMode":true}'::jsonb
);

select pg_temp.assert_true(
  (
    select status = 'SUPPRESSED'
      and notification_kind = 'PAYMENT_RECEIVED'
      and submit_attempt_count = 0
      and last_error = 'test_fixture_suppressed'
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000015'
  ),
  'disabled management destination aborted or misclassified fixture suppression'
);

update public.dre_report_settings
set is_active = true
where tenant_id = 'management-payment-outbox-school';

-- A legacy payment without tenant cannot truthfully target any management
-- group.  Its settlement must succeed without creating an orphan outbox row.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, status, due_date,
  raw_payload
) values (
  '71000000-0000-4000-8000-000000000021',
  '71000000-0000-4000-8000-000000000002',
  null,
  'pay_management_outbox_unbound_legacy',
  29,
  'PENDING',
  current_date,
  '{"testMode":true}'::jsonb
);

update public.student_payments
set status = 'RECEIVED',
    provider_status = 'RECEIVED',
    payment_date = current_date,
    paid_at = pg_catalog.now(),
    credited_at = pg_catalog.now()
where id = '71000000-0000-4000-8000-000000000021';

select pg_temp.assert_true(
  (
    select status = 'RECEIVED'
    from public.student_payments
    where id = '71000000-0000-4000-8000-000000000021'
  )
  and not exists (
    select 1
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000021'
  ),
  'unbound legacy settlement was aborted or produced an orphan notification'
);

insert into management_payment_outbox_results values (
  'split-claim',
  public.claim_management_payment_notification(
    'management-payment-outbox-school',
    '71000000-0000-4000-8000-000000000012',
    '71000000-0000-4000-8000-000000000103',
    300
  )
);

-- Revalidation happens after claim and immediately before the provider call.
-- Changing the canonical kind regenerates the one durable row as fallback;
-- it never creates a competing split/simple attempt and never goes silent.
update public.payment_split_settings
set is_active = false
where tenant_id = 'management-payment-outbox-school';

insert into management_payment_outbox_results
select
  'split-regenerated-at-fence',
  public.begin_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'split-claim'),
    '71000000-0000-4000-8000-000000000103',
    '120363000000000701@g.us',
    '120363000000000701@g.us',
    instance.instance_name,
    instance.integration_id,
    instance.integration_version,
    public.management_payment_notification_source_snapshot(
      'management-payment-outbox-school',
      '71000000-0000-4000-8000-000000000012',
      'PAYMENT_SPLIT'
    ),
    'Este corpo nunca pode cruzar o limite do provedor.'
  )
from public.whatsapp_instances as instance
where instance.tenant_id = 'management-payment-outbox-school'
  and instance.instance_name = 'management-outbox-instance';

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'RETRY'
      and payload ->> 'notification_kind' = 'PAYMENT_RECEIVED'
    from management_payment_outbox_results
    where label = 'split-regenerated-at-fence'
  )
  and (
    select status = 'PENDING'
      and notification_kind = 'PAYMENT_RECEIVED'
      and submit_attempt_count = 0
      and snapshot_hash is null
    from public.management_payment_notification_outbox
    where payment_id = '71000000-0000-4000-8000-000000000012'
  ),
  'changed split configuration did not regenerate the simple fallback'
);

insert into management_payment_outbox_results values (
  'regenerated-fallback-claim',
  public.claim_management_payment_notification(
    'management-payment-outbox-school',
    '71000000-0000-4000-8000-000000000012',
    '71000000-0000-4000-8000-000000000106',
    300
  )
);

insert into management_payment_outbox_results
select
  'regenerated-fallback-begin',
  public.begin_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'regenerated-fallback-claim'),
    '71000000-0000-4000-8000-000000000106',
    '120363000000000701@g.us',
    '120363000000000701@g.us',
    instance.instance_name,
    instance.integration_id,
    instance.integration_version,
    public.management_payment_notification_source_snapshot(
      'management-payment-outbox-school',
      '71000000-0000-4000-8000-000000000012',
      'PAYMENT_RECEIVED'
    ),
    'Fallback simples regenerado sem duplicidade.'
  )
from public.whatsapp_instances as instance
where instance.tenant_id = 'management-payment-outbox-school'
  and instance.instance_name = 'management-outbox-instance';

insert into management_payment_outbox_results values (
  'regenerated-fallback-authorize',
  public.authorize_management_payment_notification_submission(
    (select (payload ->> 'attempt_id')::uuid
       from management_payment_outbox_results
      where label = 'regenerated-fallback-claim'),
    '71000000-0000-4000-8000-000000000106',
    (select integration_id
       from public.whatsapp_instances
      where tenant_id = 'management-payment-outbox-school'
        and instance_name = 'management-outbox-instance'),
    (select integration_version
       from public.whatsapp_instances
      where tenant_id = 'management-payment-outbox-school'
        and instance_name = 'management-outbox-instance'),
    repeat('e', 64),
    repeat('f', 64)
  )
);

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PREPARED'
      and payload ->> 'notification_kind' = 'PAYMENT_RECEIVED'
    from management_payment_outbox_results
    where label = 'regenerated-fallback-begin'
  )
  and (
    select payload ->> 'action' = 'SUBMITTING'
      and payload ->> 'notification_kind' = 'PAYMENT_RECEIVED'
    from management_payment_outbox_results
    where label = 'regenerated-fallback-authorize'
  ),
  'regenerated fallback did not reach the single final submit fence'
);

rollback;
