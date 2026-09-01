-- Internal renewal tracking is tenant-scoped, idempotent and never mutates
-- contracts, payments or provider bindings.

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
grant execute on function pg_temp.assert_true(boolean, text)
  to anon, authenticated, service_role;

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'anon', 'public.student_renewal_cases', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.student_renewal_cases', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.student_renewal_cases', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.student_renewal_case_events', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.student_renewal_case_events', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.student_renewal_case_event_notes', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.student_renewal_case_event_notes', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.student_renewal_case_event_notes', 'DELETE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.record_student_renewal_action(uuid,date,text,integer,uuid,text,timestamptz,timestamptz,integer,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'public.record_student_renewal_action(uuid,date,text,integer,uuid,text,timestamptz,timestamptz,integer,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.record_student_renewal_action(uuid,date,text,integer,uuid,text,timestamptz,timestamptz,integer,text)',
    'EXECUTE'
  ),
  'renewal tracking exposes unsafe direct privileges'
);

insert into public.tenants (id, name, slug, saas_status)
values
  (
    'renewal-case-school-a',
    'Renewal Case School A',
    'renewal-case-school-a',
    'active'
  ),
  (
    'renewal-case-school-b',
    'Renewal Case School B',
    'renewal-case-school-b',
    'active'
  );

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '91000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'renewal-admin-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Renewal Admin A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '91000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'renewal-student-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Renewal Student A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '91000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'renewal-admin-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Renewal Admin B"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '91000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'renewal-student-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Renewal Student B"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '91000000-0000-4000-8000-000000000005',
    'authenticated',
    'authenticated',
    'renewal-admin-a2@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Renewal Admin A2"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '91000000-0000-4000-8000-000000000006',
    'authenticated',
    'authenticated',
    'renewal-ghost-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Renewal Ghost Student"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '91000000-0000-4000-8000-000000000007',
    'authenticated',
    'authenticated',
    'renewal-delete-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Renewal Delete Student"}',
    pg_catalog.now(),
    pg_catalog.now()
  );

set local app.enrollment_claim = '1';
insert into public.profiles (id, email, full_name)
values
  (
    '91000000-0000-4000-8000-000000000001',
    'renewal-admin-a@example.invalid',
    'Renewal Admin A'
  ),
  (
    '91000000-0000-4000-8000-000000000002',
    'renewal-student-a@example.invalid',
    'Renewal Student A'
  ),
  (
    '91000000-0000-4000-8000-000000000003',
    'renewal-admin-b@example.invalid',
    'Renewal Admin B'
  ),
  (
    '91000000-0000-4000-8000-000000000004',
    'renewal-student-b@example.invalid',
    'Renewal Student B'
  ),
  (
    '91000000-0000-4000-8000-000000000005',
    'renewal-admin-a2@example.invalid',
    'Renewal Admin A2'
  ),
  (
    '91000000-0000-4000-8000-000000000006',
    'renewal-ghost-student@example.invalid',
    'Renewal Ghost Student'
  ),
  (
    '91000000-0000-4000-8000-000000000007',
    'renewal-delete-student@example.invalid',
    'Renewal Delete Student'
  )
on conflict (id) do nothing;

update public.profiles
   set tenant_id = 'renewal-case-school-a',
       role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active',
       full_name = 'Renewal Admin A'
 where id = '91000000-0000-4000-8000-000000000001';
update public.profiles
   set tenant_id = 'renewal-case-school-a',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Renewal Student A',
       monthly_fee = 250,
       due_day = 10,
       class_frequency = '3x',
       asaas_customer_id = 'cus_renewal_a',
       subscription_id = 'sub_renewal_a',
       asaas_subscription_status = 'ACTIVE',
       asaas_subscription_end_date = date '2026-10-10',
       asaas_subscription_synced_at = pg_catalog.now()
 where id = '91000000-0000-4000-8000-000000000002';
update public.profiles
   set tenant_id = 'renewal-case-school-b',
       role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active',
       full_name = 'Renewal Admin B'
 where id = '91000000-0000-4000-8000-000000000003';
update public.profiles
   set tenant_id = 'renewal-case-school-b',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Renewal Student B',
       monthly_fee = 300,
       due_day = 5,
       class_frequency = '2x',
       asaas_customer_id = 'cus_renewal_b',
       subscription_id = 'sub_renewal_b',
       asaas_subscription_status = 'ACTIVE',
       asaas_subscription_end_date = date '2026-10-05',
       asaas_subscription_synced_at = pg_catalog.now()
 where id = '91000000-0000-4000-8000-000000000004';
update public.profiles
   set tenant_id = 'renewal-case-school-a',
       role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active',
       full_name = 'Renewal Admin A2'
 where id = '91000000-0000-4000-8000-000000000005';
update public.profiles
   set tenant_id = 'renewal-case-school-a',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Renewal Ghost Student',
       monthly_fee = 180,
       due_day = 15,
       class_frequency = '2x',
       asaas_customer_id = 'cus_renewal_ghost',
       subscription_id = 'sub_renewal_ghost',
       asaas_subscription_status = 'ACTIVE',
       asaas_subscription_end_date = date '2027-01-31',
       asaas_subscription_synced_at = pg_catalog.now()
 where id = '91000000-0000-4000-8000-000000000006';
update public.profiles
   set tenant_id = 'renewal-case-school-a',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Renewal Delete Student',
       monthly_fee = 190,
       due_day = 20,
       class_frequency = '1x',
       asaas_customer_id = 'cus_renewal_delete',
       subscription_id = 'sub_renewal_delete',
       asaas_subscription_status = 'ACTIVE',
       asaas_subscription_end_date = date '2027-01-31',
       asaas_subscription_synced_at = pg_catalog.now()
 where id = '91000000-0000-4000-8000-000000000007';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id in (
   '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000002',
   '91000000-0000-4000-8000-000000000003',
   '91000000-0000-4000-8000-000000000004',
   '91000000-0000-4000-8000-000000000005',
   '91000000-0000-4000-8000-000000000006',
   '91000000-0000-4000-8000-000000000007'
 );
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  (
    '91000000-0000-4000-8000-000000000001',
    'renewal-case-school-a',
    'SCHOOL_ADMIN',
    'ACTIVE',
    true
  ),
  (
    '91000000-0000-4000-8000-000000000002',
    'renewal-case-school-a',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '91000000-0000-4000-8000-000000000003',
    'renewal-case-school-b',
    'SCHOOL_ADMIN',
    'ACTIVE',
    true
  ),
  (
    '91000000-0000-4000-8000-000000000004',
    'renewal-case-school-b',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '91000000-0000-4000-8000-000000000005',
    'renewal-case-school-a',
    'SCHOOL_ADMIN',
    'ACTIVE',
    true
  ),
  (
    '91000000-0000-4000-8000-000000000006',
    'renewal-case-school-a',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '91000000-0000-4000-8000-000000000007',
    'renewal-case-school-a',
    'STUDENT',
    'ACTIVE',
    true
  );

create temporary table renewal_results (
  label text primary key,
  payload jsonb not null
);
create temporary table renewal_inputs as
select
  pg_catalog.now() - interval '1 minute' as contact_at,
  pg_catalog.now() + interval '1 day' as follow_up_at,
  pg_catalog.now() + interval '3 days' as formalization_at;
grant select, insert on table pg_temp.renewal_results to authenticated;
grant select on table pg_temp.renewal_inputs to authenticated;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';

insert into pg_temp.renewal_results values (
  'initial-list',
  public.list_student_renewal_cases('renewal-case-school-a')
);
insert into pg_temp.renewal_results values (
  'ghost-invalid-transition',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000006',
    date '2027-02-28',
    'RECORD_INTEREST',
    0,
    '92000000-0000-4000-8000-000000000008',
    null, null, null, 6, null
  )
);
insert into pg_temp.renewal_results values (
  'ghost-invalid-payload',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000006',
    date '2027-02-28',
    'RECORD_INTEREST',
    0,
    '92000000-0000-4000-8000-000000000009',
    null, null, null, null, null
  )
);
insert into pg_temp.renewal_results values (
  'ghost-version-conflict',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000006',
    date '2027-02-28',
    'CONTACTED',
    1,
    '92000000-0000-4000-8000-000000000010',
    'WHATSAPP',
    (select contact_at from pg_temp.renewal_inputs),
    (select follow_up_at from pg_temp.renewal_inputs),
    null,
    null
  )
);
insert into pg_temp.renewal_results values (
  'contact',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'CONTACTED',
    0,
    '92000000-0000-4000-8000-000000000001',
    'WHATSAPP',
    (select contact_at from pg_temp.renewal_inputs),
    (select follow_up_at from pg_temp.renewal_inputs),
    null,
    'Mensagem enviada; sem dados sensíveis.'
  )
);
set local timezone to 'America/Sao_Paulo';
insert into pg_temp.renewal_results values (
  'contact-replay',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'CONTACTED',
    0,
    '92000000-0000-4000-8000-000000000001',
    'WHATSAPP',
    (select contact_at from pg_temp.renewal_inputs),
    (select follow_up_at from pg_temp.renewal_inputs),
    null,
    'Mensagem enviada; sem dados sensíveis.'
  )
);
set local timezone to 'UTC';
insert into pg_temp.renewal_results values (
  'contact-request-conflict',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'CONTACTED',
    0,
    '92000000-0000-4000-8000-000000000001',
    'WHATSAPP',
    (select contact_at from pg_temp.renewal_inputs),
    (select follow_up_at from pg_temp.renewal_inputs),
    null,
    'Nota divergente'
  )
);
insert into pg_temp.renewal_results values (
  'contact-version-conflict',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'CONTACTED',
    1,
    '92000000-0000-4000-8000-000000000001',
    'WHATSAPP',
    (select contact_at from pg_temp.renewal_inputs),
    (select follow_up_at from pg_temp.renewal_inputs),
    null,
    'Mensagem enviada; sem dados sensíveis.'
  )
);
insert into pg_temp.renewal_results values (
  'stale-version',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'SCHEDULE_FOLLOW_UP',
    0,
    '92000000-0000-4000-8000-000000000003',
    null,
    null,
    (select formalization_at from pg_temp.renewal_inputs),
    null,
    null
  )
);

set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000005","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'contact-actor-conflict',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'CONTACTED',
    0,
    '92000000-0000-4000-8000-000000000001',
    'WHATSAPP',
    (select contact_at from pg_temp.renewal_inputs),
    (select follow_up_at from pg_temp.renewal_inputs),
    null,
    'Mensagem enviada; sem dados sensíveis.'
  )
);

set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'interest',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'RECORD_INTEREST',
    1,
    '92000000-0000-4000-8000-000000000004',
    null, null, null, 6,
    'Interesse relatado pela equipe; não é aceite.'
  )
);
insert into pg_temp.renewal_results values (
  'formalization',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'AWAIT_FORMALIZATION',
    2,
    '92000000-0000-4000-8000-000000000005',
    null,
    null,
    (select formalization_at from pg_temp.renewal_inputs),
    null,
    null
  )
);
insert into pg_temp.renewal_results values (
  'admin-list',
  public.list_student_renewal_cases('renewal-case-school-a')
);
insert into pg_temp.renewal_results values (
  'not-continuing',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'RECORD_NOT_CONTINUING',
    3,
    '92000000-0000-4000-8000-000000000006',
    null, null, null, null,
    'Aluno informou que não continuará.'
  )
);
insert into pg_temp.renewal_results values (
  'not-continuing-replay',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'RECORD_NOT_CONTINUING',
    3,
    '92000000-0000-4000-8000-000000000006',
    null, null, null, null,
    'Aluno informou que não continuará.'
  )
);
insert into pg_temp.renewal_results values (
  'after-not-list',
  public.list_student_renewal_cases('renewal-case-school-a')
);
reset role;

select pg_temp.assert_true(
  (select payload->>'ok' = 'true'
     and pg_catalog.jsonb_array_length(payload->'items') = 0
     from pg_temp.renewal_results where label = 'initial-list')
  and (select payload->>'error' = 'invalid_transition'
         from pg_temp.renewal_results
        where label = 'ghost-invalid-transition')
  and (select payload->>'error' = 'invalid_action_payload'
         from pg_temp.renewal_results
        where label = 'ghost-invalid-payload')
  and (select payload->>'error' = 'version_conflict'
         and payload->>'current_version' = '0'
         from pg_temp.renewal_results
        where label = 'ghost-version-conflict')
  and not exists (
    select 1
      from public.student_renewal_cases
     where student_id_snapshot = '91000000-0000-4000-8000-000000000006'
  )
  and not exists (
    select 1
      from public.student_renewal_case_events
     where student_id_snapshot = '91000000-0000-4000-8000-000000000006'
  ),
  'an invalid first action left a ghost case or event'
);

select pg_temp.assert_true(
  (select payload->>'status' = 'FOLLOW_UP_SCHEDULED'
         and payload->>'version' = '1'
         and payload->>'replayed' = 'false'
         and payload->>'updated_by_name' = 'Renewal Admin A'
     from pg_temp.renewal_results where label = 'contact')
  and (select payload->>'status' = 'FOLLOW_UP_SCHEDULED'
         and payload->>'version' = '1'
         and payload->>'replayed' = 'true'
         and payload->>'updated_by_name' = 'Renewal Admin A'
     from pg_temp.renewal_results where label = 'contact-replay')
  and (select payload->>'error' = 'request_id_conflict'
         from pg_temp.renewal_results
        where label = 'contact-request-conflict')
  and (select payload->>'error' = 'request_id_conflict'
         from pg_temp.renewal_results
        where label = 'contact-version-conflict')
  and (select payload->>'error' = 'request_id_conflict'
         from pg_temp.renewal_results
        where label = 'contact-actor-conflict')
  and (select payload->>'error' = 'version_conflict'
         and payload->>'current_version' = '1'
         from pg_temp.renewal_results where label = 'stale-version')
  and (select payload->>'status' = 'INTEREST_RECORDED'
         and payload->>'interest_term_months' = '6'
         and payload->>'version' = '2'
         from pg_temp.renewal_results where label = 'interest')
  and (select payload->>'status' = 'FORMALIZATION_PENDING'
         and payload->>'version' = '3'
         from pg_temp.renewal_results where label = 'formalization')
  and (select payload->>'status' = 'NOT_CONTINUING_RECORDED'
         and payload->>'version' = '4'
         and payload->'interest_term_months' = 'null'::jsonb
         and payload->>'updated_by_name' = 'Renewal Admin A'
         from pg_temp.renewal_results where label = 'not-continuing')
  and (select payload->>'replayed' = 'true'
         and payload->>'version' = '4'
         and payload->'interest_term_months' = 'null'::jsonb
         from pg_temp.renewal_results
        where label = 'not-continuing-replay'),
  'state transition, exact replay or actor/version conflict handling failed'
);

select pg_temp.assert_true(
  (select exists (
     select 1
       from pg_catalog.jsonb_array_elements(payload->'items') as item
      where item->>'student_id' =
              '91000000-0000-4000-8000-000000000002'
        and item->>'student_name' = 'Renewal Student A'
        and (item->>'monthly_fee_snapshot')::numeric = 250
        and item->>'cycle_current' = 'true'
        and item->>'event_count' = '3'
        and item->>'latest_note' =
              'Interesse relatado pela equipe; não é aceite.'
        and nullif(item->>'latest_action_at', '') is not null
        and item->>'updated_by_name' = 'Renewal Admin A'
   ) from pg_temp.renewal_results where label = 'admin-list')
  and (select exists (
     select 1
       from pg_catalog.jsonb_array_elements(payload->'items') as item
      where item->>'student_id' =
              '91000000-0000-4000-8000-000000000002'
        and item->>'event_count' = '4'
        and item->>'latest_note' = 'Aluno informou que não continuará.'
        and item->>'interest_term_months' is null
   ) from pg_temp.renewal_results where label = 'after-not-list'),
  'the work queue omitted the name, snapshot, cycle or latest note'
);

select pg_temp.assert_true(
  (select pg_catalog.count(*) = 1
     from public.student_renewal_cases
    where tenant_id = 'renewal-case-school-a'
      and student_id_snapshot = '91000000-0000-4000-8000-000000000002')
  and (select pg_catalog.count(*) = 4
         from public.student_renewal_case_events
        where tenant_id = 'renewal-case-school-a'
          and student_id_snapshot =
              '91000000-0000-4000-8000-000000000002')
  and (select source_subscription_id = 'sub_renewal_a'
         and source_customer_id = 'cus_renewal_a'
         and source_asaas_end_date = date '2026-10-10'
         and monthly_fee_snapshot = 250
         and due_day_snapshot = 10
         and class_frequency_snapshot = '3x'
         and interest_term_months is null
         and version = 4
       from public.student_renewal_cases
       where tenant_id = 'renewal-case-school-a'
         and student_id_snapshot =
             '91000000-0000-4000-8000-000000000002')
  and (select pg_catalog.bool_and(
         pg_catalog.char_length(request_fingerprint) = 64
         and request_fingerprint = pg_catalog.encode(
           extensions.digest(
             pg_catalog.convert_to(request_envelope::text, 'UTF8'),
             'sha256'
           ),
           'hex'
         )
         and request_envelope->>'envelope_version' = '1'
         and request_envelope->>'actor_id' = actor_id::text
       )
       from public.student_renewal_case_events
       where tenant_id = 'renewal-case-school-a')
  and not exists (
    select 1
      from public.student_renewal_case_events
     where request_envelope::text like '%Mensagem enviada%'
        or request_envelope::text like '%Interesse relatado%'
        or request_envelope::text like '%não continuará%'
  )
  and exists (
    select 1
      from public.student_renewal_case_event_notes
     where student_id = '91000000-0000-4000-8000-000000000002'
       and note = 'Mensagem enviada; sem dados sensíveis.'
  ),
  'canonical fingerprints, snapshots or note separation are wrong'
);

-- Revoking the membership must win over the compatibility tenant/role fields
-- still present on profiles.
update public.tenant_memberships
   set status = 'REVOKED', is_primary = false
 where user_id = '91000000-0000-4000-8000-000000000001'
   and tenant_id = 'renewal-case-school-a';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'revoked-list',
  public.list_student_renewal_cases('renewal-case-school-a')
);
insert into pg_temp.renewal_results values (
  'revoked-action',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'REOPEN', 4,
    '92000000-0000-4000-8000-000000000011',
    null, null, null, null, null
  )
);
reset role;
update public.tenant_memberships
   set status = 'ACTIVE', is_primary = true
 where user_id = '91000000-0000-4000-8000-000000000001'
   and tenant_id = 'renewal-case-school-a';

update public.tenants
   set saas_status = 'blocked'
 where id = 'renewal-case-school-a';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'inactive-tenant-list',
  public.list_student_renewal_cases('renewal-case-school-a')
);
insert into pg_temp.renewal_results values (
  'inactive-tenant-action',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'REOPEN', 4,
    '92000000-0000-4000-8000-000000000012',
    null, null, null, null, null
  )
);
reset role;
update public.tenants
   set saas_status = 'active'
 where id = 'renewal-case-school-a';

select pg_temp.assert_true(
  (select payload->>'error' = 'forbidden'
     from pg_temp.renewal_results where label = 'revoked-list')
  and (select payload->>'error' = 'forbidden'
         from pg_temp.renewal_results where label = 'revoked-action')
  and (select payload->>'error' = 'tenant_not_operational'
         from pg_temp.renewal_results where label = 'inactive-tenant-list')
  and (select payload->>'error' = 'tenant_not_operational'
         from pg_temp.renewal_results where label = 'inactive-tenant-action')
  and (select pg_catalog.count(*) = 4
         from public.student_renewal_case_events
        where student_id_snapshot =
              '91000000-0000-4000-8000-000000000002'),
  'canonical actor authority or the operational-tenant fence failed'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'cross-tenant',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'REOPEN', 4,
    '92000000-0000-4000-8000-000000000013',
    null, null, null, null, null
  )
);
reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'student-forbidden',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'REOPEN', 4,
    '92000000-0000-4000-8000-000000000014',
    null, null, null, null, null
  )
);
reset role;

select pg_temp.assert_true(
  (select payload->>'error' = 'tenant_mismatch'
     from pg_temp.renewal_results where label = 'cross-tenant')
  and (select payload->>'error' = 'forbidden'
         from pg_temp.renewal_results where label = 'student-forbidden')
  and not exists (
    select 1 from public.student_renewal_cases
     where tenant_id = 'renewal-case-school-b'
  ),
  'tenant or role isolation failed'
);

-- An exact retry is answered from the event ledger even after the live source
-- moved on. A new request is rejected because the paid-service cycle changed.
update public.profiles
   set asaas_subscription_end_date = date '2026-11-10'
 where id = '91000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'replay-after-cycle-change',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'CONTACTED', 0,
    '92000000-0000-4000-8000-000000000001',
    'WHATSAPP',
    (select contact_at from pg_temp.renewal_inputs),
    (select follow_up_at from pg_temp.renewal_inputs),
    null,
    'Mensagem enviada; sem dados sensíveis.'
  )
);
insert into pg_temp.renewal_results values (
  'changed-cycle',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000002',
    date '2026-11-10',
    'REOPEN', 4,
    '92000000-0000-4000-8000-000000000015',
    null, null, null, null, null
  )
);
insert into pg_temp.renewal_results values (
  'changed-cycle-list',
  public.list_student_renewal_cases('renewal-case-school-a')
);
reset role;

select pg_temp.assert_true(
  (select payload->>'ok' = 'true'
         and payload->>'replayed' = 'true'
         and payload->>'version' = '1'
         and payload->>'updated_by_name' = 'Renewal Admin A'
     from pg_temp.renewal_results where label = 'replay-after-cycle-change')
  and (select payload->>'error' = 'renewal_cycle_changed'
         from pg_temp.renewal_results where label = 'changed-cycle')
  and (select exists (
    select 1
      from pg_catalog.jsonb_array_elements(payload->'items') as item
     where item->>'student_id' =
             '91000000-0000-4000-8000-000000000002'
       and item->>'cycle_current' = 'false'
  ) from pg_temp.renewal_results where label = 'changed-cycle-list')
  and (select pg_catalog.count(*) = 4
         from public.student_renewal_case_events
        where student_id_snapshot =
              '91000000-0000-4000-8000-000000000002'),
  'cycle drift or historical replay semantics failed'
);
update public.profiles
   set asaas_subscription_end_date = date '2026-10-10'
 where id = '91000000-0000-4000-8000-000000000002';

-- A provider-binding or raw end-date correction that preserves fim_do_servico
-- continues the same operational cycle. Opening snapshots remain unchanged.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'delete-student-contact',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000007',
    date '2027-02-28',
    'CONTACTED', 0,
    '92000000-0000-4000-8000-000000000016',
    'EMAIL',
    (select contact_at from pg_temp.renewal_inputs),
    (select follow_up_at from pg_temp.renewal_inputs),
    null,
    'Nota pessoal que deve ser apagada com a conta.'
  )
);
reset role;

update public.profiles
   set asaas_subscription_end_date = date '2027-01-30',
       asaas_customer_id = 'cus_renewal_delete_v2',
       subscription_id = 'sub_renewal_delete_v2'
 where id = '91000000-0000-4000-8000-000000000007';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'same-service-source-correction',
  public.record_student_renewal_action(
    '91000000-0000-4000-8000-000000000007',
    date '2027-02-28',
    'SCHEDULE_FOLLOW_UP', 1,
    '92000000-0000-4000-8000-000000000017',
    null, null,
    (select formalization_at from pg_temp.renewal_inputs),
    null, null
  )
);
insert into pg_temp.renewal_results values (
  'same-service-list',
  public.list_student_renewal_cases('renewal-case-school-a')
);
reset role;

select pg_temp.assert_true(
  (select payload->>'status' = 'FOLLOW_UP_SCHEDULED'
         and payload->>'version' = '2'
     from pg_temp.renewal_results
    where label = 'same-service-source-correction')
  and (select exists (
    select 1
      from pg_catalog.jsonb_array_elements(payload->'items') as item
     where item->>'student_id' =
             '91000000-0000-4000-8000-000000000007'
       and item->>'cycle_current' = 'true'
       and item->>'event_count' = '2'
  ) from pg_temp.renewal_results where label = 'same-service-list')
  and (select pg_catalog.count(*) = 1
         from public.student_renewal_cases
        where student_id_snapshot =
              '91000000-0000-4000-8000-000000000007')
  and (select source_asaas_end_date = date '2027-01-31'
              and source_customer_id = 'cus_renewal_delete'
              and source_subscription_id = 'sub_renewal_delete'
         from public.student_renewal_cases
        where student_id_snapshot =
              '91000000-0000-4000-8000-000000000007'),
  'a same-service source correction froze or rewrote the operational cycle'
);

-- The target-student references are nullable and notes are an erasable annex:
-- deleting the profile preserves the non-PII ledger without retaining notes.
delete from public.profiles
 where id = '91000000-0000-4000-8000-000000000007';
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into pg_temp.renewal_results values (
  'after-student-delete-list',
  public.list_student_renewal_cases('renewal-case-school-a')
);
reset role;

select pg_temp.assert_true(
  (select student_id is null
          and student_id_snapshot =
              '91000000-0000-4000-8000-000000000007'
     from public.student_renewal_cases
    where student_id_snapshot =
          '91000000-0000-4000-8000-000000000007')
  and (select pg_catalog.bool_and(
         student_id is null
         and student_id_snapshot =
             '91000000-0000-4000-8000-000000000007'
       )
       from public.student_renewal_case_events
       where student_id_snapshot =
             '91000000-0000-4000-8000-000000000007')
  and not exists (
    select 1
      from public.student_renewal_case_event_notes
     where student_id = '91000000-0000-4000-8000-000000000007'
  )
  and (select exists (
    select 1
      from pg_catalog.jsonb_array_elements(payload->'items') as item
     where item->>'student_id' =
             '91000000-0000-4000-8000-000000000007'
       and item->>'student_name' = 'Aluno removido'
       and item->>'cycle_current' = 'false'
       and item->>'latest_note' is null
  ) from pg_temp.renewal_results where label = 'after-student-delete-list'),
  'profile deletion blocked or retained the student note/live foreign keys'
);

-- The source row is read only after both advisory locks and held FOR UPDATE.
select pg_temp.assert_true(
  (
    with definition as (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        'public.record_student_renewal_action(uuid,date,text,integer,uuid,text,timestamptz,timestamptz,integer,text)'::regprocedure
      )) as body
    )
    select pg_catalog.strpos(body, 'student-renewal-request:') > 0
       and pg_catalog.strpos(body, 'student-renewal:') >
           pg_catalog.strpos(body, 'student-renewal-request:')
       and pg_catalog.strpos(body, 'into student') >
           pg_catalog.strpos(body, 'student-renewal:')
       and pg_catalog.strpos(body, 'for update') >
           pg_catalog.strpos(body, 'into student')
       and pg_catalog.strpos(body, 'renewal_source_changed') = 0
       and pg_catalog.strpos(body, 'actor_profile.role') = 0
       and pg_catalog.strpos(body, 'profile.role = ''student''') = 0
      from definition
  ),
  'source validation is not fenced by the required lock order'
);

set local role authenticated;
do $direct_write_denied$
declare
  denied boolean := false;
begin
  begin
    insert into public.student_renewal_case_events (
      tenant_id, renewal_case_id, student_id, actor_id, request_id,
      action, from_status, to_status
    ) values (
      'renewal-case-school-a',
      (select id from public.student_renewal_cases
        where student_id_snapshot =
              '91000000-0000-4000-8000-000000000002'),
      '91000000-0000-4000-8000-000000000002',
      '91000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000018',
      'CONTACTED',
      'PENDING_CONTACT',
      'AWAITING_REPLY'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'authenticated direct event insert was allowed';
  end if;
end;
$direct_write_denied$;
reset role;

do $immutable_events$
declare
  blocked boolean := false;
begin
  begin
    update public.student_renewal_case_events
       set action = 'REOPEN'
     where tenant_id = 'renewal-case-school-a';
  exception when sqlstate '55000' then
    blocked := true;
  end;
  if not blocked then
    raise exception 'renewal audit events are mutable';
  end if;
end;
$immutable_events$;

select pg_temp.assert_true(
  (select subscription_id = 'sub_renewal_a'
          and asaas_customer_id = 'cus_renewal_a'
          and asaas_subscription_end_date = date '2026-10-10'
     from public.profiles
    where id = '91000000-0000-4000-8000-000000000002')
  and not exists (
    select 1 from public.student_payments
     where student_id in (
       '91000000-0000-4000-8000-000000000002',
       '91000000-0000-4000-8000-000000000006',
       '91000000-0000-4000-8000-000000000007'
     )
  )
  and not exists (
    select 1 from public.student_contracts
     where student_id in (
       '91000000-0000-4000-8000-000000000002',
       '91000000-0000-4000-8000-000000000006',
       '91000000-0000-4000-8000-000000000007'
     )
  ),
  'internal tracking mutated billing or contract state'
);

rollback;
