-- Hub provider mutation snapshots, GET-only recovery and atomic payment CAS.

\set ON_ERROR_STOP on

begin;

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

select pg_temp.assert_true(
  not has_table_privilege('anon', 'private.hub_provider_operations', 'SELECT')
  and not has_table_privilege(
    'authenticated', 'private.hub_provider_operations', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'private.hub_provider_operations', 'UPDATE'
  )
  and not has_table_privilege(
    'service_role', 'private.hub_provider_operation_targets', 'UPDATE'
  ),
  'provider operation snapshots can be bypassed through direct table access'
);

select pg_temp.assert_true(
  pg_catalog.to_regclass(
    'private.hub_provider_targets_provider_state_idx'
  ) is not null,
  'global provider DELETE fencing lacks its provider/state lookup index'
);

select pg_temp.assert_true(
  has_function_privilege(
    'service_role',
    'public.hub_begin_provider_cancellation(text,uuid,uuid,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_claim_provider_cancellation_target(uuid,uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_finalize_provider_cancellation(uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_mark_provider_cancellation_submitting(uuid,uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_bind_checkout_provider_subscription(uuid,text,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_mark_provider_creation_submitting(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_mark_account_provider_creation_submitting(uuid,uuid,uuid,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_activate_paid_checkout(uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_reverse_paid_checkout(uuid,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_mark_checkout_overdue(uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_adopt_provider_creation_binding(uuid,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.hub_adopt_provider_creation_binding(uuid,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.hub_claim_provider_cancellation_target(uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.hub_activate_paid_checkout(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.hub_reverse_paid_checkout(uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.hub_mark_checkout_overdue(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.hub_merge_checkout_provider_state(uuid,jsonb,text,text,text,text,text,text[])',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'private.hub_provider_operation_scope_is_current(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'private.hub_lock_provider_event_writer(uuid)',
    'EXECUTE'
  ),
  'Hub provider RPC privileges are unsafe'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'private.hub_provider_operation_scope_is_current(uuid,uuid)'::regprocedure
      and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
      and procedure.proconfig @> array['search_path=""']::text[]
  ),
  'full provider scope recheck is not safely owned or search-path pinned'
);

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 4
      and pg_catalog.bool_and(
        pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
      )
      and pg_catalog.bool_and(
        procedure.proconfig @> array['search_path=""']::text[]
      )
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where (namespace.nspname, procedure.proname) in (
      ('private', 'hub_lock_provider_event_writer'),
      ('public', 'hub_activate_paid_checkout'),
      ('public', 'hub_reverse_paid_checkout'),
      ('public', 'hub_mark_checkout_overdue')
    )
  ),
  'Hub payment writers are not safely owned or search-path pinned'
);

select pg_temp.assert_true(
  pg_catalog.pg_get_functiondef(
    'public.hub_claim_provider_cancellation_target(uuid,uuid,text)'::regprocedure
  ) like '%RECONCILE_ONLY%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_claim_provider_cancellation_target(uuid,uuid,text)'::regprocedure
  ) like '%state = ''SUBMITTING''%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_begin_provider_cancellation(text,uuid,uuid,text,text)'::regprocedure
  ) like '%for update%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_mark_provider_cancellation_submitting(uuid,uuid,text)'::regprocedure
  ) like '%state = ''SUBMITTING''%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_mark_provider_cancellation_submitting(uuid,uuid,text)'::regprocedure
  ) like '%hub-provider-delete:%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_mark_provider_cancellation_submitting(uuid,uuid,text)'::regprocedure
  ) like '%other_target.state = ''SUBMITTING''%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_mark_provider_cancellation_submitting(uuid,uuid,text)'::regprocedure
  ) like '%hub_provider_operation_scope_is_current%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_provider_operation_scope_is_current(uuid,uuid)'::regprocedure
  ) like '%accountUpdatedAt%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_provider_operation_scope_is_current(uuid,uuid)'::regprocedure
  ) like '%accountRowVersion%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_provider_operation_scope_is_current(uuid,uuid)'::regprocedure
  ) like '%localSubscriptions%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_provider_operation_scope_is_current(uuid,uuid)'::regprocedure
  ) like '%checkoutStatus%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_lock_provider_event_writer(uuid)'::regprocedure
  ) like '%hub-provider-operation:%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_lock_provider_event_writer(uuid)'::regprocedure
  ) like '%''READY'', ''IN_PROGRESS'', ''BLOCKED''%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_activate_paid_checkout(uuid,text)'::regprocedure
  ) like '%hub_lock_provider_event_writer%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_reverse_paid_checkout(uuid,text,text)'::regprocedure
  ) like '%hub_lock_provider_event_writer%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_mark_checkout_overdue(uuid,text)'::regprocedure
  ) like '%hub_lock_provider_event_writer%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_complete_provider_cancellation_target(uuid,uuid,text,text)'::regprocedure
  ) like '%hub-provider-delete:%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_assert_provider_operation_complete(uuid,uuid)'::regprocedure
  ) like '%localSubscriptions%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_assert_provider_operation_complete(uuid,uuid)'::regprocedure
  ) like '%accountUpdatedAt%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_assert_provider_operation_complete(uuid,uuid)'::regprocedure
  ) like '%accountRowVersion%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_mark_account_provider_creation_submitting(uuid,uuid,uuid,text,uuid)'::regprocedure
  ) like '%WOLFIE_TOPUP_ORDER%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_adopt_provider_creation_binding(uuid,uuid,uuid,uuid,text,text)'::regprocedure
  ) like '%pg_advisory_xact_lock%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_adopt_provider_creation_binding(uuid,uuid,uuid,uuid,text,text)'::regprocedure
  ) like '%record_asaas_provider_creation_state%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_adopt_provider_creation_binding(uuid,uuid,uuid,uuid,text,text)'::regprocedure
  ) like '%asaas_subscription_id = coalesce%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_begin_provider_cancellation(text,uuid,uuid,text,text)'::regprocedure
  ) like '%wolfie-topup-order:%'
  and pg_catalog.pg_get_functiondef(
    'public.hub_merge_checkout_provider_state(uuid,jsonb,text,text,text,text,text,text[])'::regprocedure
  ) like '%asaas_payment_id is distinct from v_payment_id%',
  'durable operation or null-or-same payment fencing is missing'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_trigger as trigger_definition
    where trigger_definition.tgrelid =
      'private.hub_provider_operations'::pg_catalog.regclass
      and trigger_definition.tgname =
        'trg_hub_provider_operation_snapshot_immutable'
      and not trigger_definition.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger as trigger_definition
    where trigger_definition.tgrelid =
      'private.hub_provider_operation_targets'::pg_catalog.regclass
      and trigger_definition.tgname =
        'trg_hub_provider_target_identity_immutable'
      and not trigger_definition.tgisinternal
  ),
  'immutable provider operation snapshot or target trigger is missing'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  'f8100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'hub-provider-cas@example.invalid',
  '{"provider":"email","providers":["email"],"test_fixture":true}',
  '{"test_fixture":true}', pg_catalog.now(), pg_catalog.now()
);

insert into public.hub_accounts (
  id, account_type, audience, name, owner_user_id, status,
  asaas_customer_id, metadata
) values (
  'f8100000-0000-4000-8000-000000000010',
  'PERSONAL', 'EDUCATOR', 'Hub provider CAS fixture',
  'f8100000-0000-4000-8000-000000000001', 'ACTIVE',
  'cus_hub_cas', '{"test_fixture":true}'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  'f8100000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated', 'hub-provider-cycle@example.invalid',
  '{"provider":"email","providers":["email"],"test_fixture":true}',
  '{"test_fixture":true}', pg_catalog.now(), pg_catalog.now()
);

insert into public.hub_accounts (
  id, account_type, audience, name, owner_user_id, status,
  asaas_customer_id, metadata
) values (
  'f8100000-0000-4000-8000-000000000011',
  'PERSONAL', 'EDUCATOR', 'Hub provider cycle fixture',
  'f8100000-0000-4000-8000-000000000002', 'ACTIVE',
  'cus_hub_cycle', '{"test_fixture":true}'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
(
  'f8100000-0000-4000-8000-000000000003',
  'authenticated', 'authenticated', 'hub-provider-submit-first@example.invalid',
  '{"provider":"email","providers":["email"],"test_fixture":true}',
  '{"test_fixture":true}', pg_catalog.now(), pg_catalog.now()
),
(
  'f8100000-0000-4000-8000-000000000004',
  'authenticated', 'authenticated', 'hub-provider-cancel-first@example.invalid',
  '{"provider":"email","providers":["email"],"test_fixture":true}',
  '{"test_fixture":true}', pg_catalog.now(), pg_catalog.now()
);

insert into public.hub_accounts (
  id, account_type, audience, name, owner_user_id, status,
  asaas_customer_id, metadata
) values
(
  'f8100000-0000-4000-8000-000000000012',
  'PERSONAL', 'EDUCATOR', 'Hub provider submit-first fixture',
  'f8100000-0000-4000-8000-000000000003', 'ACTIVE',
  'cus_hub_submit_first', '{"test_fixture":true}'
),
(
  'f8100000-0000-4000-8000-000000000013',
  'PERSONAL', 'EDUCATOR', 'Hub provider cancel-first fixture',
  'f8100000-0000-4000-8000-000000000004', 'ACTIVE',
  'cus_hub_cancel_first', '{"test_fixture":true}'
),
(
  'f8100000-0000-4000-8000-000000000014',
  'ORGANIZATION', 'EDUCATOR', 'Hub provider account-core fence fixture',
  'f8100000-0000-4000-8000-000000000003', 'ACTIVE',
  'cus_hub_account_core', '{"test_fixture":true}'
),
(
  'f8100000-0000-4000-8000-000000000015',
  'ORGANIZATION', 'EDUCATOR', 'Hub provider webhook-account fence fixture',
  'f8100000-0000-4000-8000-000000000004', 'ACTIVE',
  'cus_hub_webhook_account', '{"test_fixture":true}'
);

insert into public.hub_plans (
  id, code, name, audience, price_monthly, price_yearly,
  is_public, is_active, metadata, product_family
) values
(
  'f8100000-0000-4000-8000-000000000020',
  'HUB_PROVIDER_CAS_FIXTURE', 'Hub provider CAS fixture', 'EDUCATOR',
  1, 12, false, true, '{"test_fixture":true}', 'WOLFIE_STANDALONE'
),
(
  'f8100000-0000-4000-8000-000000000021',
  'HUB_PROVIDER_CORE_FIXTURE', 'Hub provider Core fixture', 'EDUCATOR',
  1, 12, false, true, '{"test_fixture":true}', 'HUB_CORE'
);

insert into public.hub_checkout_sessions (
  id, account_id, plan_id, requested_by, billing_cycle, billing_type,
  amount, status, asaas_subscription_id, metadata, product_family
) values
(
  'f8100000-0000-4000-8000-000000000030',
  'f8100000-0000-4000-8000-000000000010',
  'f8100000-0000-4000-8000-000000000020',
  'f8100000-0000-4000-8000-000000000001',
  'MONTHLY', 'PIX', 1, 'CREATED', 'sub_hub_cas',
  '{"test_fixture":true}', 'WOLFIE_STANDALONE'
),
(
  'f8100000-0000-4000-8000-000000000031',
  'f8100000-0000-4000-8000-000000000012',
  'f8100000-0000-4000-8000-000000000020',
  'f8100000-0000-4000-8000-000000000003',
  'MONTHLY', 'PIX', 1, 'CREATED', null,
  '{"test_fixture":true}', 'WOLFIE_STANDALONE'
),
(
  'f8100000-0000-4000-8000-000000000032',
  'f8100000-0000-4000-8000-000000000013',
  'f8100000-0000-4000-8000-000000000020',
  'f8100000-0000-4000-8000-000000000004',
  'MONTHLY', 'PIX', 1, 'CREATED', null,
  '{"test_fixture":true}', 'WOLFIE_STANDALONE'
),
(
  'f8100000-0000-4000-8000-000000000033',
  'f8100000-0000-4000-8000-000000000014',
  'f8100000-0000-4000-8000-000000000021',
  'f8100000-0000-4000-8000-000000000003',
  'MONTHLY', 'PIX', 1, 'PAID', 'sub_hub_account_core',
  '{"test_fixture":true}', 'HUB_CORE'
),
(
  'f8100000-0000-4000-8000-000000000034',
  'f8100000-0000-4000-8000-000000000015',
  'f8100000-0000-4000-8000-000000000020',
  'f8100000-0000-4000-8000-000000000004',
  'MONTHLY', 'PIX', 1, 'CREATED', 'sub_hub_webhook_account',
  '{"test_fixture":true}', 'WOLFIE_STANDALONE'
);

-- Build two distinct operation pairs over the same exact provider targets.
-- These rollback-only rows isolate the global at-most-once DELETE boundary
-- from the business finalizers exercised elsewhere in this test.
with operation_fixture as (
  select *
  from (values
    (
      'f8100000-0000-4000-8000-000000000201'::uuid,
      'TEST_ACCOUNT_CORE_ACCOUNT'::text,
      'ACCOUNT_STATUS'::text,
      'f8100000-0000-4000-8000-000000000014'::uuid,
      'f8100000-0000-4000-8000-000000000301'::uuid,
      'cus_hub_account_core'::text,
      'sub_hub_account_core'::text,
      'f8100000-0000-4000-8000-000000000033'::uuid
    ),
    (
      'f8100000-0000-4000-8000-000000000202'::uuid,
      'TEST_ACCOUNT_CORE_CORE'::text,
      'CORE_CANCELLATION'::text,
      'f8100000-0000-4000-8000-000000000014'::uuid,
      'f8100000-0000-4000-8000-000000000302'::uuid,
      'cus_hub_account_core'::text,
      'sub_hub_account_core'::text,
      'f8100000-0000-4000-8000-000000000033'::uuid
    ),
    (
      'f8100000-0000-4000-8000-000000000203'::uuid,
      'WEBHOOK_CANCELLATION:sub_hub_webhook_account'::text,
      'WEBHOOK_CANCELLATION'::text,
      'f8100000-0000-4000-8000-000000000015'::uuid,
      'f8100000-0000-4000-8000-000000000303'::uuid,
      'cus_hub_webhook_account'::text,
      'sub_hub_webhook_account'::text,
      'f8100000-0000-4000-8000-000000000034'::uuid
    ),
      (
        'f8100000-0000-4000-8000-000000000204'::uuid,
        'TEST_WEBHOOK_ACCOUNT_ACCOUNT'::text,
        'ACCOUNT_STATUS'::text,
        'f8100000-0000-4000-8000-000000000015'::uuid,
        'f8100000-0000-4000-8000-000000000304'::uuid,
        'cus_hub_webhook_account'::text,
        'sub_hub_webhook_account'::text,
        'f8100000-0000-4000-8000-000000000034'::uuid
      )
  ) as fixture(
    operation_id, logical_key, operation_kind, account_id, lease_token,
    provider_customer_id, provider_subscription_id, checkout_id
  )
), snapshot_fixture as (
  select fixture.*,
    pg_catalog.jsonb_build_object(
      'accountId', fixture.account_id,
      'accountStatus', account.status,
      'accountUpdatedAt', account.updated_at,
      'accountRowVersion',
        account.xmin::text || ':' || account.cmin::text,
      'operationKind', fixture.operation_kind,
      'providerCustomerId', fixture.provider_customer_id,
      'localSubscriptions', pg_catalog.jsonb_build_array(),
      'targets', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'providerSubscriptionId', fixture.provider_subscription_id,
          'providerCustomerId', fixture.provider_customer_id,
          'checkoutId', fixture.checkout_id,
          'productFamily', checkout.product_family,
          'checkoutStatus', checkout.status
        )
      )
    ) as snapshot
  from operation_fixture fixture
  join public.hub_accounts account on account.id = fixture.account_id
  join public.hub_checkout_sessions checkout
    on checkout.id = fixture.checkout_id
)
insert into private.hub_provider_operations (
  id, logical_key, operation_kind, account_id, snapshot, snapshot_hash,
  lease_token, integration_id, integration_version
)
select fixture.operation_id, fixture.logical_key, fixture.operation_kind,
  fixture.account_id, fixture.snapshot,
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(fixture.snapshot::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  ),
  fixture.lease_token,
  'f8100000-0000-4000-8000-000000000901',
  1
from snapshot_fixture fixture;

insert into private.hub_provider_operation_targets (
  operation_id, provider_subscription_id, provider_customer_id, checkout_id
)
values
  (
    'f8100000-0000-4000-8000-000000000201',
    'sub_hub_account_core', 'cus_hub_account_core',
    'f8100000-0000-4000-8000-000000000033'
  ),
  (
    'f8100000-0000-4000-8000-000000000202',
    'sub_hub_account_core', 'cus_hub_account_core',
    'f8100000-0000-4000-8000-000000000033'
  ),
  (
    'f8100000-0000-4000-8000-000000000203',
    'sub_hub_webhook_account', 'cus_hub_webhook_account',
    'f8100000-0000-4000-8000-000000000034'
  ),
  (
    'f8100000-0000-4000-8000-000000000204',
    'sub_hub_webhook_account', 'cus_hub_webhook_account',
    'f8100000-0000-4000-8000-000000000034'
  );

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
create temporary table hub_provider_cycle_operations (
  cycle text primary key,
  payload jsonb not null
);
grant all on table hub_provider_cycle_operations to service_role;
create temporary table hub_provider_fence_results (
  step text primary key,
  payload jsonb not null
);
grant all on table hub_provider_fence_results to service_role;
set local role service_role;

-- Interleaving A: once a provider creation crosses SUBMITTING, cancellation
-- cannot take an incomplete snapshot that omits the future provider object.
insert into hub_provider_fence_results values (
  'submit_claim',
  public.claim_asaas_provider_creation(
    'school-wise-wolf',
    'SUBSCRIPTION_CREATE',
    'hub-checkout:f8100000-0000-4000-8000-000000000031',
    'hub:f8100000-0000-4000-8000-000000000031',
    pg_catalog.repeat('a', 64),
    'f8100000-0000-4000-8000-000000000101',
    300
  )
);
insert into hub_provider_fence_results values (
  'submit_boundary',
  public.hub_mark_provider_creation_submitting(
    (select (payload ->> 'attempt_id')::uuid
     from hub_provider_fence_results where step = 'submit_claim'),
    'f8100000-0000-4000-8000-000000000101',
    'f8100000-0000-4000-8000-000000000012',
    'f8100000-0000-4000-8000-000000000031'
  )
);
select pg_temp.assert_true(
  (select (payload ->> 'ok')::boolean
   from hub_provider_fence_results where step = 'submit_boundary'),
  'provider creation did not cross the shared lifecycle fence'
);
do $submit_first_blocks_cancellation$
begin
  perform public.hub_begin_provider_cancellation(
    'ACCOUNT_STATUS',
    'f8100000-0000-4000-8000-000000000012',
    null,
    'SUSPENDED',
    'SUBMIT_FIRST_RACE'
  );
  raise exception 'assertion failed: cancellation omitted SUBMITTING creation';
exception
  when object_not_in_prerequisite_state then null;
end;
$submit_first_blocks_cancellation$;

-- Once the provider result is known, adoption records SUCCEEDED and links the
-- exact provider id in the same advisory-fenced transaction. Cancellation may
-- then start, but its immutable snapshot must contain the adopted scheduler.
insert into hub_provider_fence_results values (
  'submit_adoption',
  public.hub_adopt_provider_creation_binding(
    (select (payload ->> 'attempt_id')::uuid
     from hub_provider_fence_results where step = 'submit_claim'),
    'f8100000-0000-4000-8000-000000000101',
    'f8100000-0000-4000-8000-000000000012',
    'f8100000-0000-4000-8000-000000000031',
    'sub_hub_submit_first',
    'ACTIVE'
  )
);
select pg_temp.assert_true(
  (select (payload ->> 'ok')::boolean
   from hub_provider_fence_results where step = 'submit_adoption'),
  'provider result could not be atomically adopted under the lifecycle fence'
);
insert into hub_provider_fence_results values (
  'submit_after_adoption_cancel',
  public.hub_begin_provider_cancellation(
    'ACCOUNT_STATUS',
    'f8100000-0000-4000-8000-000000000012',
    null,
    'SUSPENDED',
    'SUBMIT_ADOPTED_RACE'
  )
);
select pg_temp.assert_true(
  (select payload -> 'snapshot' -> 'targets'
   from hub_provider_fence_results
   where step = 'submit_after_adoption_cancel') @>
    '[{"providerSubscriptionId":"sub_hub_submit_first"}]'::jsonb,
  'cancellation snapshot omitted an atomically adopted provider scheduler'
);

-- Interleaving B: once cancellation owns the lifecycle fence, a later generic
-- creation claim may exist for recovery, but it cannot authorize a POST.
insert into hub_provider_fence_results values (
  'cancel_boundary',
  public.hub_begin_provider_cancellation(
    'ACCOUNT_STATUS',
    'f8100000-0000-4000-8000-000000000013',
    null,
    'SUSPENDED',
    'CANCEL_FIRST_RACE'
  )
);
insert into hub_provider_fence_results values (
  'cancel_first_claim',
  public.claim_asaas_provider_creation(
    'school-wise-wolf',
    'SUBSCRIPTION_CREATE',
    'hub-checkout:f8100000-0000-4000-8000-000000000032',
    'hub:f8100000-0000-4000-8000-000000000032',
    pg_catalog.repeat('b', 64),
    'f8100000-0000-4000-8000-000000000102',
    300
  )
);
insert into hub_provider_fence_results values (
  'cancel_first_submit',
  public.hub_mark_provider_creation_submitting(
    (select (payload ->> 'attempt_id')::uuid
     from hub_provider_fence_results where step = 'cancel_first_claim'),
    'f8100000-0000-4000-8000-000000000102',
    'f8100000-0000-4000-8000-000000000013',
    'f8100000-0000-4000-8000-000000000032'
  )
);
select pg_temp.assert_true(
  not (select (payload ->> 'ok')::boolean
       from hub_provider_fence_results where step = 'cancel_first_submit')
  and (select payload ->> 'reason'
       from hub_provider_fence_results where step = 'cancel_first_submit') =
    'account_lifecycle_fenced',
  'a provider POST crossed an already-owned cancellation fence'
);
insert into hub_provider_fence_results values (
  'cancel_first_adoption',
  public.hub_adopt_provider_creation_binding(
    (select (payload ->> 'attempt_id')::uuid
     from hub_provider_fence_results where step = 'cancel_first_claim'),
    'f8100000-0000-4000-8000-000000000102',
    'f8100000-0000-4000-8000-000000000013',
    'f8100000-0000-4000-8000-000000000032',
    'sub_hub_cancel_first',
    'ACTIVE'
  )
);
select pg_temp.assert_true(
  not (select (payload ->> 'ok')::boolean
       from hub_provider_fence_results where step = 'cancel_first_adoption')
  and (select payload ->> 'reason'
       from hub_provider_fence_results where step = 'cancel_first_adoption') =
    'account_lifecycle_fenced',
  'a recovered provider object linked after cancellation owned the fence'
);
select public.hub_finalize_provider_cancellation(
  (select (payload ->> 'operationId')::uuid
   from hub_provider_fence_results where step = 'cancel_boundary'),
  (select (payload ->> 'leaseToken')::uuid
   from hub_provider_fence_results where step = 'cancel_boundary')
);

-- Distinct ACCOUNT_STATUS and CORE operations may both prove the provider
-- object ACTIVE, but their second boundary check is global by provider id.
insert into hub_provider_fence_results values (
  'account_core_account_submit',
  public.hub_mark_provider_cancellation_submitting(
    'f8100000-0000-4000-8000-000000000201',
    'f8100000-0000-4000-8000-000000000301',
    'sub_hub_account_core'
  )
);
insert into hub_provider_fence_results values (
  'account_core_core_submit',
  public.hub_mark_provider_cancellation_submitting(
    'f8100000-0000-4000-8000-000000000202',
    'f8100000-0000-4000-8000-000000000302',
    'sub_hub_account_core'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'action' from hub_provider_fence_results
   where step = 'account_core_account_submit') = 'SUBMIT_ALLOWED'
  and (select payload ->> 'action' from hub_provider_fence_results
       where step = 'account_core_core_submit') = 'RECONCILE_ONLY',
  'ACCOUNT_STATUS and CORE both crossed DELETE for one provider scheduler'
);

-- Once cancellation owns READY/IN_PROGRESS, none of the Hub payment writers
-- may invalidate its snapshot between SUBMITTING and the provider DELETE.
do $paid_writer_blocked$
begin
  perform public.hub_activate_paid_checkout(
    'f8100000-0000-4000-8000-000000000033',
    'pay_hub_provider_paid_race'
  );
  raise exception 'assertion failed: paid writer crossed provider operation';
exception
  when object_not_in_prerequisite_state then null;
end;
$paid_writer_blocked$;
do $reverse_writer_blocked$
begin
  perform public.hub_reverse_paid_checkout(
    'f8100000-0000-4000-8000-000000000033',
    'pay_hub_provider_reverse_race',
    'PAYMENT_REFUNDED'
  );
  raise exception 'assertion failed: reverse writer crossed provider operation';
exception
  when object_not_in_prerequisite_state then null;
end;
$reverse_writer_blocked$;
do $overdue_writer_blocked$
begin
  perform public.hub_mark_checkout_overdue(
    'f8100000-0000-4000-8000-000000000033',
    'pay_hub_provider_overdue_race'
  );
  raise exception 'assertion failed: overdue writer crossed provider operation';
exception
  when object_not_in_prerequisite_state then null;
end;
$overdue_writer_blocked$;
select pg_temp.assert_true(
  exists (
    select 1
    from public.hub_checkout_sessions checkout
    where checkout.id = 'f8100000-0000-4000-8000-000000000033'
      and checkout.status = 'PAID'
      and checkout.asaas_payment_id is null
  ),
  'blocked Hub payment writer changed checkout state'
);
select public.hub_complete_provider_cancellation_target(
  'f8100000-0000-4000-8000-000000000201',
  'f8100000-0000-4000-8000-000000000301',
  'sub_hub_account_core',
  'CONFIRMED'
);
insert into hub_provider_fence_results values (
  'account_core_terminal_propagation',
  public.hub_mark_provider_cancellation_submitting(
    'f8100000-0000-4000-8000-000000000202',
    'f8100000-0000-4000-8000-000000000302',
    'sub_hub_account_core'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'action' from hub_provider_fence_results
   where step = 'account_core_terminal_propagation') = 'ALREADY_SUCCEEDED'
  and (select payload ->> 'state' from hub_provider_fence_results
       where step = 'account_core_terminal_propagation') = 'CONFIRMED',
  'terminal ACCOUNT_STATUS proof was not propagated into CORE atomically'
);

-- The same global mutation boundary applies when a webhook cleanup races an
-- account-status operation for the exact same local/provider tuple.
insert into hub_provider_fence_results values (
  'webhook_account_webhook_submit',
  public.hub_mark_provider_cancellation_submitting(
    'f8100000-0000-4000-8000-000000000203',
    'f8100000-0000-4000-8000-000000000303',
    'sub_hub_webhook_account'
  )
);
insert into hub_provider_fence_results values (
  'webhook_account_account_submit',
  public.hub_mark_provider_cancellation_submitting(
    'f8100000-0000-4000-8000-000000000204',
    'f8100000-0000-4000-8000-000000000304',
    'sub_hub_webhook_account'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'action' from hub_provider_fence_results
   where step = 'webhook_account_webhook_submit') = 'SUBMIT_ALLOWED'
  and (select payload ->> 'action' from hub_provider_fence_results
       where step = 'webhook_account_account_submit') = 'RECONCILE_ONLY',
  'WEBHOOK and ACCOUNT_STATUS both crossed DELETE for one provider scheduler'
);
select public.hub_complete_provider_cancellation_target(
  'f8100000-0000-4000-8000-000000000203',
  'f8100000-0000-4000-8000-000000000303',
  'sub_hub_webhook_account',
  'ABSENT'
);
insert into hub_provider_fence_results values (
  'webhook_account_terminal_propagation',
  public.hub_mark_provider_cancellation_submitting(
    'f8100000-0000-4000-8000-000000000204',
    'f8100000-0000-4000-8000-000000000304',
    'sub_hub_webhook_account'
  )
);
select pg_temp.assert_true(
  (select payload ->> 'action' from hub_provider_fence_results
   where step = 'webhook_account_terminal_propagation') =
    'ALREADY_SUCCEEDED'
  and (select payload ->> 'state' from hub_provider_fence_results
       where step = 'webhook_account_terminal_propagation') = 'ABSENT',
  'terminal webhook proof was not propagated into ACCOUNT_STATUS atomically'
);

-- Model a paid/activation webhook changing the immutable checkout scope after
-- begin but before the irreversible provider boundary. The mark RPC must fail
-- closed even though customer, checkout and provider ids still match.
 reset role;
 update public.hub_checkout_sessions
  set status = 'OVERDUE'
  where id = 'f8100000-0000-4000-8000-000000000033';
insert into private.hub_provider_operations (
  id, logical_key, operation_kind, account_id, target_status, snapshot,
  snapshot_hash, lease_token, status, integration_id, integration_version
)
select
  'f8100000-0000-4000-8000-000000000205'::uuid,
  'TEST_SCOPE_RECHECK'::text,
  'ACCOUNT_STATUS'::text,
  account.id,
  'SUSPENDED'::text,
  pg_catalog.jsonb_build_object(
    'accountId', account.id,
    'accountStatus', account.status,
    'accountUpdatedAt', account.updated_at,
    'accountRowVersion',
      account.xmin::text || ':' || account.cmin::text,
    'operationKind', 'ACCOUNT_STATUS'::text,
    'providerCustomerId', 'cus_hub_account_core'::text,
    'localSubscriptions', pg_catalog.jsonb_build_array(),
    'targets', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'providerSubscriptionId', 'sub_hub_account_core'::text,
        'providerCustomerId', 'cus_hub_account_core'::text,
        'checkoutId', 'f8100000-0000-4000-8000-000000000033'::uuid,
        'productFamily', 'HUB_CORE'::text,
        'checkoutStatus', 'PAID'::text
      )
    )
  ),
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'accountId', account.id,
          'accountStatus', account.status,
          'accountUpdatedAt', account.updated_at,
          'accountRowVersion',
            account.xmin::text || ':' || account.cmin::text,
          'operationKind', 'ACCOUNT_STATUS'::text,
          'providerCustomerId', 'cus_hub_account_core'::text,
          'localSubscriptions', pg_catalog.jsonb_build_array(),
          'targets', pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'providerSubscriptionId', 'sub_hub_account_core'::text,
              'providerCustomerId', 'cus_hub_account_core'::text,
              'checkoutId', 'f8100000-0000-4000-8000-000000000033'::uuid,
              'productFamily', 'HUB_CORE'::text,
              'checkoutStatus', 'PAID'::text
            )
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ),
  'f8100000-0000-4000-8000-000000000305'::uuid,
  'BLOCKED'::text,
  'f8100000-0000-4000-8000-000000000901'::uuid,
  1
from public.hub_accounts account
join public.hub_checkout_sessions checkout
  on checkout.id = 'f8100000-0000-4000-8000-000000000033'::uuid
where account.id = 'f8100000-0000-4000-8000-000000000014'::uuid;

insert into private.hub_provider_operation_targets (
  operation_id, provider_subscription_id, provider_customer_id, checkout_id
) values (
  'f8100000-0000-4000-8000-000000000205',
  'sub_hub_account_core',
  'cus_hub_account_core',
  'f8100000-0000-4000-8000-000000000033'
);
insert into hub_provider_fence_results values (
  'scope_changed_before_submit',
  public.hub_mark_provider_cancellation_submitting(
    'f8100000-0000-4000-8000-000000000205',
    'f8100000-0000-4000-8000-000000000305',
    'sub_hub_account_core'
  )
);
reset role;
select pg_temp.assert_true(
  not (select (payload ->> 'ok')::boolean
       from hub_provider_fence_results
       where step = 'scope_changed_before_submit')
  and (select payload ->> 'action'
       from hub_provider_fence_results
       where step = 'scope_changed_before_submit') = 'REVIEW_REQUIRED'
  and (select payload ->> 'reason'
       from hub_provider_fence_results
       where step = 'scope_changed_before_submit') = 'LOCAL_SCOPE_CHANGED'
  and exists (
    select 1
    from private.hub_provider_operation_targets target
    where target.operation_id =
      'f8100000-0000-4000-8000-000000000205'
      and target.provider_subscription_id = 'sub_hub_account_core'
      and target.state = 'REVIEW_REQUIRED'
  ),
  'changed immutable scope crossed the provider DELETE boundary'
);
set local role service_role;

insert into hub_provider_cycle_operations values (
  'first',
  public.hub_begin_provider_cancellation(
    'ACCOUNT_STATUS',
    'f8100000-0000-4000-8000-000000000011',
    null,
    'SUSPENDED',
    'FIRST_CYCLE'
  )
);
select public.hub_finalize_provider_cancellation(
  (select (payload ->> 'operationId')::uuid
   from hub_provider_cycle_operations where cycle = 'first'),
  (select (payload ->> 'leaseToken')::uuid
   from hub_provider_cycle_operations where cycle = 'first')
);

reset role;
update public.hub_accounts
set status = 'ACTIVE', updated_at = updated_at + interval '1 second'
where id = 'f8100000-0000-4000-8000-000000000011';
set local role service_role;

insert into hub_provider_cycle_operations values (
  'second',
  public.hub_begin_provider_cancellation(
    'ACCOUNT_STATUS',
    'f8100000-0000-4000-8000-000000000011',
    null,
    'SUSPENDED',
    'SECOND_CYCLE'
  )
);
select public.hub_finalize_provider_cancellation(
  (select (payload ->> 'operationId')::uuid
   from hub_provider_cycle_operations where cycle = 'second'),
  (select (payload ->> 'leaseToken')::uuid
   from hub_provider_cycle_operations where cycle = 'second')
);

select pg_temp.assert_true(
  (select payload ->> 'operationId'
   from hub_provider_cycle_operations where cycle = 'first') <>
  (select payload ->> 'operationId'
   from hub_provider_cycle_operations where cycle = 'second'),
  'reactivation must create a new immutable suspension operation cycle'
);

select public.hub_bind_checkout_provider_subscription(
  'f8100000-0000-4000-8000-000000000030',
  'sub_hub_cas',
  '{"subscriptionBinding":"preserved"}'
);

select public.hub_merge_checkout_provider_state(
  'f8100000-0000-4000-8000-000000000030',
  '{"first":"preserved"}',
  'pay_hub_cas',
  'sub_hub_cas',
  'PENDING',
  null,
  null,
  array['CREATED']::text[]
);
select public.hub_merge_checkout_provider_state(
  'f8100000-0000-4000-8000-000000000030',
  '{"second":"merged"}',
  'pay_hub_cas',
  'sub_hub_cas',
  null,
  null,
  null,
  array['PENDING']::text[]
);

do $payment_conflict$
begin
  perform public.hub_merge_checkout_provider_state(
    'f8100000-0000-4000-8000-000000000030',
    '{}'::jsonb,
    'pay_hub_conflict',
    'sub_hub_cas'
  );
  raise exception 'assertion failed: conflicting payment id was accepted';
exception
  when insufficient_privilege then null;
end;
$payment_conflict$;

reset role;

select pg_temp.assert_true(
  exists (
    select 1 from public.hub_checkout_sessions as checkout
    where checkout.id = 'f8100000-0000-4000-8000-000000000030'
      and checkout.asaas_payment_id = 'pay_hub_cas'
      and checkout.status = 'PENDING'
      and checkout.metadata ->> 'first' = 'preserved'
      and checkout.metadata ->> 'second' = 'merged'
      and checkout.metadata ->> 'subscriptionBinding' = 'preserved'
  ),
  'atomic metadata merge or payment CAS did not preserve the canonical state'
);

-- If account finalization wins after the webhook's initial read, the fenced
-- paid wrapper must recheck ACTIVE under the account advisory and refuse to
-- resurrect local entitlement after the durable operation has closed.
set local role service_role;
select public.hub_finalize_account_status_change(
  'f8100000-0000-4000-8000-000000000010'::uuid,
  'SUSPENDED',
  ARRAY['sub_hub_cas']::text[],
  null,
  'WEBHOOK_RACE_SIMULATION'
);
set local role service_role;
do $inactive_paid_writer_blocked$
begin
  perform public.hub_activate_paid_checkout(
    'f8100000-0000-4000-8000-000000000030',
    'pay_hub_cas'
  );
  raise exception 'assertion failed: inactive account was reactivated by paid writer';
exception
  when object_not_in_prerequisite_state then null;
  when SQLSTATE '55000' then
    if sqlerrm !~ 'hub_account_inactive' then
      raise;
    end if;
end;
$inactive_paid_writer_blocked$;
select pg_temp.assert_true(
  not exists (
    select 1
    from public.hub_subscriptions subscription
    where subscription.account_id =
      'f8100000-0000-4000-8000-000000000010'
      and subscription.status in (
        'TRIALING', 'INCOMPLETE', 'ACTIVE', 'PAST_DUE'
      )
  ),
  'paid webhook resurrected entitlement after account suspension won the race'
);

rollback;
