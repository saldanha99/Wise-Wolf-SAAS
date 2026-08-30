-- Different billing flows share one monthly competence, and an ambiguous
-- outbound WhatsApp attempt can never be submitted twice.

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

grant execute on all functions in schema pg_temp
  to anon, authenticated, service_role;

select pg_temp.assert_true(
  not has_table_privilege(
    'anon', 'public.asaas_student_billing_period_claims', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.asaas_outbound_message_attempts', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'public.asaas_student_billing_period_claims', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'public.asaas_student_billing_period_claims', 'INSERT'
  ),
  'billing fences expose unsafe direct table access'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.claim_asaas_student_billing_period(text,uuid,date,text,text,text,uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_asaas_outbound_message(text,uuid,text,text,uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.record_asaas_student_billing_period_state(uuid,uuid,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finish_asaas_outbound_message(uuid,uuid,text,integer,text)',
    'EXECUTE'
  ),
  'billing fence RPC privileges are unsafe'
);

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values (
  'billing-fence-school',
  'Billing Fence School',
  'billing-fence-school',
  'active',
  true
);
insert into public.tenant_admin_settings (
  tenant_id, student_notifications_enabled, teacher_notifications_enabled
) values ('billing-fence-school', true, true)
on conflict (tenant_id) do update
set student_notifications_enabled = excluded.student_notifications_enabled,
    teacher_notifications_enabled = excluded.teacher_notifications_enabled;

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f301',
  'authenticated',
  'authenticated',
  'billing-fence@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Billing Fence Student"}',
  now(),
  now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'billing-fence-school',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Billing Fence Student'
 where id = '00000000-0000-4000-8000-00000000f301';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id = '00000000-0000-4000-8000-00000000f301';
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '00000000-0000-4000-8000-00000000f301',
  'billing-fence-school',
  'STUDENT',
  'ACTIVE',
  true
);

create temporary table fence_results (
  label text primary key,
  payload jsonb not null
);

insert into fence_results values (
  'manual-first',
  public.claim_asaas_student_billing_period(
    'billing-fence-school',
    '00000000-0000-4000-8000-00000000f301',
    '2026-09-10',
    'MANUAL_PIX',
    'manual-pix:test-fixture',
    repeat('a', 64),
    '00000000-0000-4000-8000-00000000f311',
    300
  )
);

insert into fence_results values (
  'subscription-conflict',
  public.claim_asaas_student_billing_period(
    'billing-fence-school',
    '00000000-0000-4000-8000-00000000f301',
    '2026-09-10',
    'SUBSCRIPTION',
    'subscription:test-fixture',
    repeat('b', 64),
    '00000000-0000-4000-8000-00000000f312',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'SUBMIT_ONCE'
     from fence_results where label = 'manual-first')
  and (select payload->>'action' = 'CONFLICT'
         from fence_results where label = 'subscription-conflict'),
  'manual Pix and recurring subscription both acquired the same competence'
);

insert into fence_results values (
  'manual-submitting',
  public.mark_asaas_student_billing_period_submitting(
    (select (payload->>'attempt_id')::uuid
       from fence_results where label = 'manual-first'),
    '00000000-0000-4000-8000-00000000f311'
  )
);

insert into fence_results values (
  'manual-unknown',
  public.record_asaas_student_billing_period_state(
    (select (payload->>'attempt_id')::uuid
       from fence_results where label = 'manual-first'),
    '00000000-0000-4000-8000-00000000f311',
    'UNKNOWN',
    null,
    'timeout-test'
  )
);

insert into fence_results values (
  'manual-reconcile',
  public.claim_asaas_student_billing_period(
    'billing-fence-school',
    '00000000-0000-4000-8000-00000000f301',
    '2026-09-10',
    'MANUAL_PIX',
    'manual-pix:test-fixture',
    repeat('a', 64),
    '00000000-0000-4000-8000-00000000f313',
    300
  )
);

insert into fence_results values (
  'manual-second-submit-rejected',
  public.mark_asaas_student_billing_period_submitting(
    (select (payload->>'attempt_id')::uuid
       from fence_results where label = 'manual-reconcile'),
    '00000000-0000-4000-8000-00000000f313'
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'RECONCILE_REQUIRED'
     from fence_results where label = 'manual-reconcile')
  and (select payload->>'reason' = 'claim_lost'
         from fence_results where label = 'manual-second-submit-rejected')
  and (select submit_attempt_count = 1
         from public.asaas_student_billing_period_claims
        where tenant_id = 'billing-fence-school'
          and student_id = '00000000-0000-4000-8000-00000000f301'
          and due_date = '2026-09-10'),
  'ambiguous competence was allowed a second provider submit'
);

insert into fence_results values (
  'manual-bound',
  public.record_asaas_student_billing_period_state(
    (select (payload->>'attempt_id')::uuid
       from fence_results where label = 'manual-reconcile'),
    '00000000-0000-4000-8000-00000000f313',
    'BOUND',
    'pay_billing_fence',
    null
  )
);

insert into fence_results values (
  'manual-final',
  public.claim_asaas_student_billing_period(
    'billing-fence-school',
    '00000000-0000-4000-8000-00000000f301',
    '2026-09-10',
    'MANUAL_PIX',
    'manual-pix:test-fixture',
    repeat('a', 64),
    '00000000-0000-4000-8000-00000000f314',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'ALREADY_BOUND'
          and payload->>'provider_entity_id' = 'pay_billing_fence'
     from fence_results where label = 'manual-final'),
  'recovered provider identity was not monotonic'
);

insert into fence_results values (
  'message-first',
  public.claim_asaas_outbound_message(
    'billing-fence-school',
    '00000000-0000-4000-8000-00000000f301',
    'pay_billing_fence',
    'MANUAL_PIX_CREATED',
    '00000000-0000-4000-8000-00000000f321',
    300
  )
);

insert into fence_results values (
  'message-submitting',
  public.mark_asaas_outbound_message_submitting(
    (select (payload->>'attempt_id')::uuid
       from fence_results where label = 'message-first'),
    '00000000-0000-4000-8000-00000000f321'
  )
);

insert into fence_results values (
  'message-unknown',
  public.finish_asaas_outbound_message(
    (select (payload->>'attempt_id')::uuid
       from fence_results where label = 'message-first'),
    '00000000-0000-4000-8000-00000000f321',
    'UNKNOWN',
    null,
    'delivery-timeout-test'
  )
);

insert into fence_results values (
  'message-final',
  public.claim_asaas_outbound_message(
    'billing-fence-school',
    '00000000-0000-4000-8000-00000000f301',
    'pay_billing_fence',
    'MANUAL_PIX_CREATED',
    '00000000-0000-4000-8000-00000000f322',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'ALREADY_FINAL'
          and payload->>'status' = 'UNKNOWN'
     from fence_results where label = 'message-final')
  and (select submit_attempt_count = 1
         from public.asaas_outbound_message_attempts
        where tenant_id = 'billing-fence-school'
          and provider_entity_id = 'pay_billing_fence'),
  'ambiguous WhatsApp delivery was allowed a second send'
);

insert into fence_results values (
  'message-opt-out-claim',
  public.claim_asaas_outbound_message(
    'billing-fence-school',
    '00000000-0000-4000-8000-00000000f301',
    'pay_billing_fence_opt_out',
    'MANUAL_PIX_CREATED',
    '00000000-0000-4000-8000-00000000f323',
    300
  )
);

update public.tenant_admin_settings
   set student_notifications_enabled = false,
       updated_at = pg_catalog.now()
 where tenant_id = 'billing-fence-school';

insert into fence_results values (
  'message-opt-out-mark',
  public.mark_asaas_outbound_message_submitting(
    (select (payload->>'attempt_id')::uuid
       from fence_results where label = 'message-opt-out-claim'),
    '00000000-0000-4000-8000-00000000f323'
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'SUPPRESSED'
          and payload->>'reason' = 'student_notifications_disabled_before_send'
     from fence_results where label = 'message-opt-out-mark')
  and (select status = 'SUPPRESSED' and submit_attempt_count = 0
         from public.asaas_outbound_message_attempts
        where tenant_id = 'billing-fence-school'
          and provider_entity_id = 'pay_billing_fence_opt_out'
          and notification_kind = 'MANUAL_PIX_CREATED'),
  'student opt-out changed after claim still reached the provider boundary'
);

rollback;
