-- Persistent Asaas creation claims: concurrency, leases and ambiguous outcomes.

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
    'anon',
    'public.asaas_provider_creation_attempts',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.asaas_provider_creation_attempts',
    'SELECT'
  )
  and has_table_privilege(
    'service_role',
    'public.asaas_provider_creation_attempts',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'public.asaas_provider_creation_attempts',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.asaas_provider_creation_attempts',
    'UPDATE'
  ),
  'creation attempts table can bypass the claim RPCs'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.claim_asaas_provider_creation(text,text,text,text,text,uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.record_asaas_provider_creation_state(uuid,uuid,text,text,text,integer,text,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.mark_asaas_provider_creation_submitting(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.freeze_asaas_enrollment_payment_request(uuid,uuid,date,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.freeze_asaas_enrollment_payment_request(uuid,uuid,date,text)',
    'EXECUTE'
  ),
  'creation guard RPC privileges are unsafe'
);

select pg_temp.assert_true(
  pg_catalog.to_regprocedure(
    'public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'
  ) is null
  and not has_function_privilege(
    'service_role',
    'public.apply_saas_checkout_billing_event_pre_settlement_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'private.apply_saas_checkout_billing_event_unordered_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.apply_saas_checkout_billing_event(uuid,text,text,timestamptz,text,numeric,text,text,text,text,timestamptz,date,text,text)',
    'EXECUTE'
  ),
  'service_role can bypass the settlement-only SaaS wrapper'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from pg_catalog.pg_proc as procedure
     where procedure.oid in (
       'public.claim_asaas_provider_creation(text,text,text,text,text,uuid,integer)'::regprocedure,
       'public.freeze_asaas_enrollment_payment_request(uuid,uuid,date,text)'::regprocedure,
       'public.mark_asaas_provider_creation_submitting(uuid,uuid)'::regprocedure,
       'public.record_asaas_provider_creation_state(uuid,uuid,text,text,text,integer,text,jsonb)'::regprocedure,
       'public.reopen_enrollment_offer_for_unsettled_payment(uuid,uuid,text,text)'::regprocedure,
       'public.apply_saas_checkout_billing_event_pre_settlement_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'::regprocedure,
       'private.apply_saas_checkout_billing_event_unordered_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'::regprocedure,
       'public.apply_saas_checkout_billing_event(uuid,text,text,timestamptz,text,numeric,text,text,text,text,timestamptz,date,text,text)'::regprocedure
     )
       and pg_catalog.pg_get_userbyid(procedure.proowner) <> 'postgres'
  ),
  'security definer functions are not owned by postgres'
);

-- Execute as the API service role. The expected P0002 is raised inside the
-- renamed implementation, proving that the postgres-owned wrapper can still
-- call it even though service_role has no direct EXECUTE privilege on it.
set local role service_role;
do $wrapper_executes_as_service_role$
begin
  perform public.apply_saas_checkout_billing_event(
    '00000000-0000-4000-8000-00000000c999',
    'PAYMENT_CONFIRMED',
    'evt_missing_checkout_ordered',
    timestamptz '2026-08-25 12:00:00+00',
    'pay_missing_checkout',
    1,
    'PIX',
    'cus_missing_checkout',
    'sub_missing_checkout'
  );
  raise exception 'assertion failed: missing checkout was unexpectedly accepted';
exception
  when no_data_found then null;
end;
$wrapper_executes_as_service_role$;
reset role;

create temporary table creation_claims (
  label text primary key,
  payload jsonb not null
);

insert into creation_claims values (
  'customer-first',
  public.claim_asaas_provider_creation(
    'school-wise-wolf',
    'CUSTOMER_CREATE',
    'student:test-concurrency',
    'test-concurrency',
    repeat('a', 64),
    '00000000-0000-4000-8000-00000000c101',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'SUBMIT_ONCE'
     from creation_claims where label = 'customer-first'),
  'first logical customer creation did not own the single submit'
);

insert into creation_claims values (
  'customer-concurrent',
  public.claim_asaas_provider_creation(
    'school-wise-wolf',
    'CUSTOMER_CREATE',
    'student:test-concurrency',
    'test-concurrency',
    repeat('a', 64),
    '00000000-0000-4000-8000-00000000c102',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'IN_PROGRESS'
     from creation_claims where label = 'customer-concurrent'),
  'concurrent request obtained a second provider submit'
);

insert into creation_claims values (
  'customer-submitting',
  public.mark_asaas_provider_creation_submitting(
    (select (payload->>'attempt_id')::uuid
       from creation_claims where label = 'customer-first'),
    '00000000-0000-4000-8000-00000000c101'
  )
);

select pg_temp.assert_true(
  (select payload->>'status' = 'SUBMITTING'
     from creation_claims where label = 'customer-submitting')
  and (
    select submit_attempt_count = 1
      from public.asaas_provider_creation_attempts
     where logical_key = 'student:test-concurrency'
  ),
  'provider submit was not durably fenced before the POST'
);

insert into creation_claims values (
  'customer-unknown',
  public.record_asaas_provider_creation_state(
    (select (payload->>'attempt_id')::uuid
       from creation_claims where label = 'customer-first'),
    '00000000-0000-4000-8000-00000000c101',
    'UNKNOWN',
    null,
    null,
    504,
    'timeout-test',
    null
  )
);

update public.asaas_provider_creation_attempts
   set next_attempt_at = now() - interval '1 second',
       lease_expires_at = now() - interval '1 second'
 where logical_key = 'student:test-concurrency';

insert into creation_claims values (
  'customer-reconcile',
  public.claim_asaas_provider_creation(
    'school-wise-wolf',
    'CUSTOMER_CREATE',
    'student:test-concurrency',
    'test-concurrency',
    repeat('a', 64),
    '00000000-0000-4000-8000-00000000c103',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'RECONCILE_REQUIRED'
     from creation_claims where label = 'customer-reconcile'),
  'ambiguous POST was allowed to submit again instead of GET reconciliation'
);

insert into creation_claims values (
  'customer-second-submit-rejected',
  public.mark_asaas_provider_creation_submitting(
    (select (payload->>'attempt_id')::uuid
       from creation_claims where label = 'customer-reconcile'),
    '00000000-0000-4000-8000-00000000c103'
  )
);

select pg_temp.assert_true(
  (select payload->>'reason' = 'claim_lost'
     from creation_claims where label = 'customer-second-submit-rejected')
  and (
    select submit_attempt_count = 1
      from public.asaas_provider_creation_attempts
     where logical_key = 'student:test-concurrency'
  ),
  'ambiguous creation could exceed one POST'
);

insert into creation_claims values (
  'customer-recovered',
  public.record_asaas_provider_creation_state(
    (select (payload->>'attempt_id')::uuid
       from creation_claims where label = 'customer-reconcile'),
    '00000000-0000-4000-8000-00000000c103',
    'SUCCEEDED',
    'cus_recovered_test',
    'ACTIVE',
    200,
    null,
    '{"id":"cus_recovered_test","status":"ACTIVE"}'::jsonb
  )
);

insert into creation_claims values (
  'customer-final',
  public.claim_asaas_provider_creation(
    'school-wise-wolf',
    'CUSTOMER_CREATE',
    'student:test-concurrency',
    'test-concurrency',
    repeat('a', 64),
    '00000000-0000-4000-8000-00000000c104',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'ALREADY_SUCCEEDED'
          and payload->>'provider_entity_id' = 'cus_recovered_test'
     from creation_claims where label = 'customer-final'),
  'provider entity recovered after timeout was not reused'
);

-- A lease that expires before mark-submitting is safe to reclaim because no
-- provider request can have started yet.
insert into creation_claims values (
  'payment-first',
  public.claim_asaas_provider_creation(
    'school-wise-wolf',
    'PAYMENT_CREATE',
    'enrollment-fee:test-safe-reclaim',
    'enrollment:test-safe-reclaim:fee',
    repeat('b', 64),
    '00000000-0000-4000-8000-00000000c201',
    300
  )
);
update public.asaas_provider_creation_attempts
   set lease_expires_at = now() - interval '1 second'
 where logical_key = 'enrollment-fee:test-safe-reclaim';
insert into creation_claims values (
  'payment-reclaimed',
  public.claim_asaas_provider_creation(
    'school-wise-wolf',
    'PAYMENT_CREATE',
    'enrollment-fee:test-safe-reclaim',
    'enrollment:test-safe-reclaim:fee',
    repeat('b', 64),
    '00000000-0000-4000-8000-00000000c202',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'SUBMIT_ONCE'
     from creation_claims where label = 'payment-reclaimed')
  and (
    select submit_attempt_count = 0
      from public.asaas_provider_creation_attempts
     where logical_key = 'enrollment-fee:test-safe-reclaim'
  ),
  'pre-submit expired lease was not safely reclaimed'
);

insert into creation_claims values (
  'payment-request-frozen',
  public.freeze_asaas_enrollment_payment_request(
    (select (payload->>'attempt_id')::uuid
       from creation_claims where label = 'payment-reclaimed'),
    '00000000-0000-4000-8000-00000000c202',
    date '2026-08-25',
    'Taxa de Matricula Wise Wolf School'
  )
);

insert into creation_claims values (
  'payment-request-retry',
  public.freeze_asaas_enrollment_payment_request(
    (select (payload->>'attempt_id')::uuid
       from creation_claims where label = 'payment-reclaimed'),
    '00000000-0000-4000-8000-00000000c202',
    date '2026-08-26',
    'Taxa de Matricula Wise Wolf School'
  )
);

select pg_temp.assert_true(
  (select payload->>'due_date' = '2026-08-25'
     from creation_claims where label = 'payment-request-frozen')
  and (select payload->>'due_date' = '2026-08-25'
     from creation_claims where label = 'payment-request-retry')
  and (
    select request_snapshot ->> 'kind' = 'ENROLLMENT_PAYMENT'
       and request_snapshot ->> 'description' =
         'Taxa de Matricula Wise Wolf School'
       and request_snapshot ->> 'dueDate' = '2026-08-25'
       and request_snapshot ? 'subscription'
       and jsonb_typeof(request_snapshot -> 'subscription') = 'null'
      from public.asaas_provider_creation_attempts
     where logical_key = 'enrollment-fee:test-safe-reclaim'
  ),
  'enrollment payment request identity was not frozen across retries'
);

-- A legacy/provider lookup can recover an entity before any POST.
insert into creation_claims values (
  'payment-recovered-before-submit',
  public.record_asaas_provider_creation_state(
    (select (payload->>'attempt_id')::uuid
       from creation_claims where label = 'payment-reclaimed'),
    '00000000-0000-4000-8000-00000000c202',
    'SUCCEEDED',
    'pay_recovered_test',
    'PENDING',
    200,
    null,
    '{"id":"pay_recovered_test","status":"PENDING"}'::jsonb
  )
);

select pg_temp.assert_true(
  (select status = 'SUCCEEDED' and submit_attempt_count = 0
     from public.asaas_provider_creation_attempts
    where logical_key = 'enrollment-fee:test-safe-reclaim'),
  'GET recovery before POST was not persisted safely'
);

insert into creation_claims values (
  'payment-input-mismatch',
  public.claim_asaas_provider_creation(
    'school-wise-wolf',
    'PAYMENT_CREATE',
    'enrollment-fee:test-safe-reclaim',
    'enrollment:test-safe-reclaim:fee',
    repeat('c', 64),
    '00000000-0000-4000-8000-00000000c203',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'REVIEW_REQUIRED'
          and payload->>'reason' = 'creation_input_mismatch'
     from creation_claims where label = 'payment-input-mismatch'),
  'changed logical creation input was silently accepted'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_constraint
     where conrelid = 'public.asaas_provider_creation_attempts'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%submit_attempt_count%'
       and pg_get_constraintdef(oid) ilike '%<= 1%'
  ),
  'database no longer enforces a single provider POST'
);

select pg_temp.assert_true(
  position(
    'commercialSideEffectsPreserved' in
    pg_get_functiondef(
      'public.reopen_enrollment_offer_for_unsettled_payment(uuid,uuid,text,text)'::regprocedure
    )
  ) > 0,
  'refund reopening lost its auditable commercial-side-effect policy'
);

select pg_temp.assert_true(
  position(
    'subscription_activation_payment_id' in
    pg_get_functiondef(
      'public.reopen_enrollment_offer_for_unsettled_payment(uuid,uuid,text,text)'::regprocedure
    )
  ) > 0,
  'refund reopening does not recognize a recurring activation payment'
);

select pg_temp.assert_true(
  position(
    $$when normalized_event = 'payment_confirmed' then 'payment_updated'$$ in
    lower(pg_get_functiondef(
      'private.apply_saas_checkout_billing_event_unordered_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    $$when normalized_event = 'payment_received_in_cash' then 'payment_received'$$ in
    lower(pg_get_functiondef(
      'private.apply_saas_checkout_billing_event_unordered_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'::regprocedure
    ))
  ) > 0,
  'SaaS billing can still provision before provider settlement'
);

rollback;
