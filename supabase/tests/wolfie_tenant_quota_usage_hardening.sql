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

grant execute on function pg_temp.assert_true(boolean, text) to public;
do $$
begin
  if to_regprocedure('pg_temp.assert_sqlstate(text, text, text)') is not null then
    execute 'grant execute on function pg_temp.assert_sqlstate(text, text, text) to public';
  end if;
end
$$;

insert into public.tenants (id, name)
values
  ('wolfie-hardening-a', 'Wolfie Hardening A'),
  ('wolfie-hardening-b', 'Wolfie Hardening B');

insert into auth.users (
  id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-4000-8000-000000000910',
  'authenticated',
  'authenticated',
  'wolfie-hardening@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Wolfie Hardening"}',
  now(),
  now()
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
)
values (
  '00000000-0000-4000-8000-000000000909',
  'authenticated',
  'authenticated',
  'wolfie-hardening-admin@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Wolfie Hardening Admin"}',
  now(),
  now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'wolfie-hardening-a',
       role = 'STUDENT',
       lifecycle_status = 'active',
       is_test_account = false,
       test_fixture_key = 'wolfie-tenant-quota-sql'
 where id = '00000000-0000-4000-8000-000000000910';
set local app.enrollment_claim = '';

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'wolfie-hardening-a',
       role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active',
       is_test_account = false,
       test_fixture_key = 'wolfie-tenant-quota-admin-sql'
 where id = '00000000-0000-4000-8000-000000000909';
set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
)
values
  (
    '00000000-0000-4000-8000-000000000910',
    'wolfie-hardening-a',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-000000000910',
    'wolfie-hardening-b',
    'STUDENT',
    'ACTIVE',
    false
  ),
  (
    '00000000-0000-4000-8000-000000000909',
    'wolfie-hardening-a',
    'SCHOOL_ADMIN',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-000000000909',
    'wolfie-hardening-b',
    'SCHOOL_ADMIN',
    'ACTIVE',
    false
  )
on conflict (user_id, tenant_id) do update
  set role = excluded.role,
      status = excluded.status,
      is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values (
  '00000000-0000-4000-8000-000000000910',
  'wolfie-hardening-b'
)
on conflict (user_id) do update set tenant_id = excluded.tenant_id;

insert into public.tenant_user_contexts (user_id, tenant_id)
values (
  '00000000-0000-4000-8000-000000000909',
  'wolfie-hardening-b'
)
on conflict (user_id) do update set tenant_id = excluded.tenant_id;

insert into public.student_pricing_plans (id, tenant_id, name)
values
  (
    '50000000-0000-4000-8000-000000000910',
    'wolfie-hardening-a',
    'Tenant A Fixture Plan'
  ),
  (
    '50000000-0000-4000-8000-000000000911',
    'wolfie-hardening-b',
    'Tenant B Fixture Plan'
  );

-- The same request UUID is valid once per active tenant and the trigger must
-- preserve tenant B instead of overwriting it with profiles.tenant_id (A).
select public.create_wolfie_activity_session(
  'wolfie-hardening-a',
  '00000000-0000-4000-8000-000000000910',
  'writing',
  'B1',
  null,
  'standard',
  'text',
  null,
  '00000000-0000-4000-8000-000000000911',
  '{"prompt":"tenant A"}',
  '{}',
  '{}',
  '{}'
);
select public.create_wolfie_activity_session(
  'wolfie-hardening-b',
  '00000000-0000-4000-8000-000000000910',
  'writing',
  'B1',
  null,
  'standard',
  'text',
  null,
  '00000000-0000-4000-8000-000000000911',
  '{"prompt":"tenant B"}',
  '{}',
  '{}',
  '{}'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.wolfie_activity_sessions
     where student_id = '00000000-0000-4000-8000-000000000910'
       and request_key = '00000000-0000-4000-8000-000000000911'
  ),
  'activity idempotency must be tenant scoped'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.wolfie_activity_sessions
     where tenant_id = 'wolfie-hardening-b'
       and student_id = '00000000-0000-4000-8000-000000000910'
       and request_key = '00000000-0000-4000-8000-000000000911'
  ),
  'secondary active tenant must be preserved'
);

do $test$
declare
  claim_a jsonb;
  claim_b jsonb;
begin
  claim_a := public.claim_wolfie_ai_request(
    'wolfie-hardening-a',
    '00000000-0000-4000-8000-000000000910',
    '00000000-0000-4000-8000-000000000912',
    'GENERATE'
  );
  claim_b := public.claim_wolfie_ai_request(
    'wolfie-hardening-b',
    '00000000-0000-4000-8000-000000000910',
    '00000000-0000-4000-8000-000000000912',
    'GENERATE'
  );
  perform pg_temp.assert_true(
    (claim_a ->> 'claimed')::boolean
      and (claim_b ->> 'claimed')::boolean,
    'AI request key must be claimable independently in each tenant'
  );
  perform public.finish_wolfie_ai_request(
    'wolfie-hardening-a',
    '00000000-0000-4000-8000-000000000910',
    '00000000-0000-4000-8000-000000000912',
    (claim_a ->> 'leaseToken')::uuid,
    'COMPLETED',
    '{"tenant":"a"}',
    null
  );
  perform public.finish_wolfie_ai_request(
    'wolfie-hardening-b',
    '00000000-0000-4000-8000-000000000910',
    '00000000-0000-4000-8000-000000000912',
    (claim_b ->> 'leaseToken')::uuid,
    'COMPLETED',
    '{"tenant":"b"}',
    null
  );
end;
$test$;

insert into public.wolfie_sessions (
  id,
  tenant_id,
  student_id,
  topic,
  mode,
  student_level,
  experience_mode,
  correction_mode,
  language_mode,
  difficulty,
  current_stage,
  scenario_status,
  retry_count,
  config_snapshot,
  report_json,
  memory_summary
)
values
  (
    '10000000-0000-4000-8000-000000000910',
    'wolfie-hardening-a',
    '00000000-0000-4000-8000-000000000910',
    'Tenant A', 'fluency', 'B1', 'free_conversation', 'immediate',
    'bilingual', 'balanced', 'opening', 'active', 0, '{}', '{}', '{}'
  ),
  (
    '10000000-0000-4000-8000-000000000911',
    'wolfie-hardening-b',
    '00000000-0000-4000-8000-000000000910',
    'Tenant B 1', 'fluency', 'B1', 'free_conversation', 'immediate',
    'bilingual', 'balanced', 'opening', 'active', 0, '{}', '{}', '{}'
  ),
  (
    '10000000-0000-4000-8000-000000000912',
    'wolfie-hardening-b',
    '00000000-0000-4000-8000-000000000910',
    'Tenant B 2', 'fluency', 'B1', 'free_conversation', 'immediate',
    'bilingual', 'balanced', 'opening', 'active', 0, '{}', '{}', '{}'
  );

insert into public.wolfie_memory_items (
  tenant_id,
  student_id,
  kind,
  memory_key,
  content,
  status,
  confidence,
  occurrence_count,
  evidence,
  sensitive
)
values
  (
    'wolfie-hardening-a',
    '00000000-0000-4000-8000-000000000910',
    'recommended_strategy',
    'tenant-rls-fixture',
    'Tenant A memory',
    'active', 0.9, 1, '[{"basis":"session_assessment"}]', false
  ),
  (
    'wolfie-hardening-b',
    '00000000-0000-4000-8000-000000000910',
    'recommended_strategy',
    'tenant-rls-fixture',
    'Tenant B memory',
    'active', 0.9, 1, '[{"basis":"session_assessment"}]', false
  );

insert into public.student_plan_entitlements (
  tenant_id,
  plan_id,
  feature_key,
  limit_value,
  reset_period
)
values ('wolfie-hardening-b', null, 'wolfie.live_minutes', 1, 'MONTH');

insert into public.student_minute_credits (
  tenant_id,
  student_id,
  minutes,
  payment_id,
  status
)
values (
  'wolfie-hardening-b',
  '00000000-0000-4000-8000-000000000910',
  2,
  'wolfie-hardening-credit',
  'PAID'
);

insert into public.student_live_minutes (
  tenant_id,
  student_id,
  session_id,
  seconds,
  source,
  plan_seconds,
  credit_seconds,
  created_at
)
values (
  'wolfie-hardening-b',
  '00000000-0000-4000-8000-000000000910',
  '10000000-0000-4000-8000-000000000911',
  60,
  'sql_fixture_previous_month',
  0,
  60,
  date_trunc('month', now()) - interval '1 month'
);

select pg_temp.assert_true(
  (
    public.wolfie_live_balance(
      'wolfie-hardening-b',
      '00000000-0000-4000-8000-000000000910'
    ) ->> 'creditRemainingSeconds'
  )::integer = 60,
  'spent top-up seconds must not reappear after a month boundary'
);

do $test$
declare
  first_claim jsonb;
  blocked_claim jsonb;
  settlement jsonb;
begin
  first_claim := public.claim_wolfie_live_grant(
    'wolfie-hardening-b',
    '00000000-0000-4000-8000-000000000910',
    '10000000-0000-4000-8000-000000000911',
    60
  );
  perform pg_temp.assert_true(
    (first_claim ->> 'claimed')::boolean
      and (first_claim ->> 'maxSeconds')::integer = 40,
    'first live grant must reserve a twenty-second enforcement buffer'
  );
  perform public.activate_wolfie_live_grant(
    (first_claim ->> 'grantId')::uuid,
    'call_wolfie_hardening_fixture'
  );
  blocked_claim := public.claim_wolfie_live_grant(
    'wolfie-hardening-b',
    '00000000-0000-4000-8000-000000000910',
    '10000000-0000-4000-8000-000000000912',
    60
  );
  perform pg_temp.assert_true(
    blocked_claim ->> 'reason' = 'student_live_connection_exists',
    'an active provider call must block repeated/parallel grants'
  );
  perform public.request_wolfie_live_grant_close(
    'wolfie-hardening-b',
    '00000000-0000-4000-8000-000000000910',
    (first_claim ->> 'grantId')::uuid,
    '10000000-0000-4000-8000-000000000911',
    0,
    'CLIENT'
  );
  settlement := public.settle_wolfie_live_grant(
    'wolfie-hardening-b',
    '00000000-0000-4000-8000-000000000910',
    (first_claim ->> 'grantId')::uuid,
    0
  );
  perform pg_temp.assert_true(
    (settlement ->> 'ok')::boolean,
    'trusted service settlement must persist the live ledger'
  );
end;
$test$;

insert into public.wolfie_turns (
  id,
  session_id,
  speaker,
  content,
  turn_index,
  message_type,
  stage,
  structured_payload,
  requires_retry,
  speech_metrics,
  source_kind,
  client_turn_id
)
values (
  '20000000-0000-4000-8000-000000000910',
  '10000000-0000-4000-8000-000000000911',
  'wolfie',
  'Usage fixture',
  0,
  'feedback',
  'opening',
  '{}',
  false,
  '{}',
  'openai_realtime',
  '00000000-0000-4000-8000-000000000913'
);

select public.record_wolfie_realtime_usage(
  '10000000-0000-4000-8000-000000000911',
  '00000000-0000-4000-8000-000000000913',
  '{"totalTokens":21,"inputTextTokens":3,"inputAudioTokens":5,"outputTextTokens":6,"outputAudioTokens":7,"cachedTokens":2}'
);
select pg_temp.assert_true(
  (
    select tokens_used = 21
       and usage_input_audio_tokens = 5
       and usage_output_audio_tokens = 7
      from public.wolfie_turns
     where id = '20000000-0000-4000-8000-000000000910'
       and speaker = 'wolfie'
  ),
  'Realtime usage must attach to the persisted wolfie turn'
);

insert into public.wolfie_topup_packages (
  id,
  tenant_id,
  name,
  minutes,
  price_brl,
  active
)
values (
  '30000000-0000-4000-8000-000000000910',
  'wolfie-hardening-b',
  'Fixture 3 minutes',
  3,
  4.50,
  true
);
insert into public.wolfie_topup_orders (
  id,
  tenant_id,
  student_id,
  package_id,
  package_name,
  minutes,
  amount_brl,
  request_key,
  status
)
values (
  '40000000-0000-4000-8000-000000000910',
  'wolfie-hardening-b',
  '00000000-0000-4000-8000-000000000910',
  '30000000-0000-4000-8000-000000000910',
  'Fixture 3 minutes',
  3,
  4.50,
  '40000000-0000-4000-8000-000000000912',
  'AWAITING_PAYMENT'
);
select public.apply_wolfie_topup_payment(
  '40000000-0000-4000-8000-000000000910',
  'pay_wolfie_hardening',
  'PAYMENT_CONFIRMED',
  4.50
);
select pg_temp.assert_true(
  (
    select tenant_id = 'wolfie-hardening-b'
       and status = 'PAID'
       and minutes = 3
      from public.student_minute_credits
     where order_id = '40000000-0000-4000-8000-000000000910'
  ),
  'paid top-up must credit the order tenant, not profiles.tenant_id'
);
select public.apply_wolfie_topup_payment(
  '40000000-0000-4000-8000-000000000910',
  'pay_wolfie_hardening',
  'PAYMENT_REFUNDED',
  4.50
);
select pg_temp.assert_true(
  (
    select status = 'REVERSED' and reversed_at is not null
      from public.student_minute_credits
     where order_id = '40000000-0000-4000-8000-000000000910'
  ),
  'refund must reverse future credit without deleting usage history'
);
select pg_temp.assert_true(
  (
    public.wolfie_live_balance(
      'wolfie-hardening-b',
      '00000000-0000-4000-8000-000000000910'
    ) ->> 'creditRemainingSeconds'
  )::integer = 60,
  'reversed top-up must no longer contribute to live balance'
);

insert into public.wolfie_topup_orders (
  id,
  tenant_id,
  student_id,
  package_id,
  package_name,
  minutes,
  amount_brl,
  request_key,
  status
)
values (
  '40000000-0000-4000-8000-000000000911',
  'wolfie-hardening-b',
  '00000000-0000-4000-8000-000000000910',
  '30000000-0000-4000-8000-000000000910',
  'Fixture 3 minutes',
  3,
  4.50,
  '40000000-0000-4000-8000-000000000913',
  'AWAITING_PAYMENT'
);
select public.apply_wolfie_topup_payment(
  '40000000-0000-4000-8000-000000000911',
  'pay_wolfie_partial_refund',
  'PAYMENT_CONFIRMED',
  4.50
);
select public.apply_wolfie_topup_payment(
  '40000000-0000-4000-8000-000000000911',
  'pay_wolfie_partial_refund',
  'PAYMENT_PARTIALLY_REFUNDED',
  4.50,
  1.50
);
-- A late paid delivery must not reactivate frozen credit.
select public.apply_wolfie_topup_payment(
  '40000000-0000-4000-8000-000000000911',
  'pay_wolfie_partial_refund',
  'PAYMENT_RECEIVED',
  4.50
);
select pg_temp.assert_true(
  (
    select orders.status = 'SUSPENDED'
       and orders.reconciliation_required
       and credits.status = 'SUSPENDED'
      from public.wolfie_topup_orders as orders
      join public.student_minute_credits as credits
        on credits.order_id = orders.id
     where orders.id = '40000000-0000-4000-8000-000000000911'
  ),
  'partial refund must freeze credit and resist out-of-order paid events'
);
select pg_temp.assert_true(
  (
    public.wolfie_live_balance(
      'wolfie-hardening-b',
      '00000000-0000-4000-8000-000000000910'
    ) ->> 'creditRemainingSeconds'
  )::integer = 60,
  'suspended partial-refund credit must not enter the live balance'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.activate_wolfie_live_grant(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.settle_wolfie_live_grant(text,uuid,uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.activate_wolfie_live_grant(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_wolfie_topup_order_creation(text,uuid,uuid)',
    'EXECUTE'
  ),
  'browser roles must not activate or settle provider grants directly'
);

-- RLS must reveal only tenant B, the selected ACTIVE context, even though the
-- same learner owns rows in legacy/primary tenant A.
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000910","role":"authenticated"}',
  true
);
set local role authenticated;
select pg_temp.assert_true(
  (
    select count(*) = 1 and bool_and(tenant_id = 'wolfie-hardening-b')
      from public.wolfie_activity_sessions
     where request_key = '00000000-0000-4000-8000-000000000911'
  ),
  'activity RLS must isolate the selected active tenant'
);
select pg_temp.assert_true(
  (
    select count(*) = 2 and bool_and(tenant_id = 'wolfie-hardening-b')
      from public.wolfie_sessions
     where student_id = '00000000-0000-4000-8000-000000000910'
  ),
  'conversation RLS must isolate the selected active tenant'
);
select pg_temp.assert_true(
  (
    select count(*) = 1 and bool_and(content = 'Tenant B memory')
      from public.wolfie_memory_items
     where memory_key = 'tenant-rls-fixture'
  ),
  'memory RLS must isolate the selected active tenant'
);
reset role;

-- Tenant-administration RPCs must use the selected ACTIVE membership, reject
-- a plan from another school, keep one NULL/default row, and update both the
-- numeric limit and its explicit access mode.
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000909","role":"authenticated"}',
  true
);
set local role authenticated;
select public.save_realtime_settings(false, 321);
select public.set_student_plan_entitlement(
  null,
  'wolfie.live_minutes',
  0
);
select public.set_student_plan_entitlement(
  null,
  'wolfie.live_minutes',
  0
);
select public.set_student_plan_entitlement(
  '50000000-0000-4000-8000-000000000911',
  'wolfie.live_minutes',
  7
);

do $cross_tenant_plan_denied$
begin
  perform public.set_student_plan_entitlement(
    '50000000-0000-4000-8000-000000000910',
    'wolfie.live_minutes',
    7
  );
  raise exception 'cross-tenant student plan was accepted';
exception when foreign_key_violation then
  null;
end;
$cross_tenant_plan_denied$;
reset role;

select pg_temp.assert_true(
  (
    select count(*) = 1
       and bool_and(enabled is false)
       and max(monthly_token_quota) = 321
      from public.tenant_realtime_settings
     where tenant_id = 'wolfie-hardening-b'
  ) and not exists (
    select 1
      from public.tenant_realtime_settings
     where tenant_id = 'wolfie-hardening-a'
       and monthly_token_quota = 321
  ),
  'Realtime settings must follow the selected ACTIVE admin tenant'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
       and max(limit_value) = 0
       and bool_and(access_mode = 'UNLIMITED')
      from public.student_plan_entitlements
     where tenant_id = 'wolfie-hardening-b'
       and plan_id is null
       and feature_key = 'wolfie.live_minutes'
  ) and (
    select limit_value = 7 and access_mode = 'LIMITED'
      from public.student_plan_entitlements
     where tenant_id = 'wolfie-hardening-b'
       and plan_id = '50000000-0000-4000-8000-000000000911'
       and feature_key = 'wolfie.live_minutes'
  ),
  'plan entitlements must deduplicate defaults and keep access_mode coherent'
);

rollback;
