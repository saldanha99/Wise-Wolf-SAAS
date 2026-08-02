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

select id as student_id
from public.profiles
where role = 'STUDENT'
limit 1
\gset

select id as admin_id
from public.profiles
where role = 'SCHOOL_ADMIN' and tenant_id = 'school-wise-wolf'
limit 1
\gset

select id as super_id
from public.profiles
where role = 'SUPER_ADMIN'
limit 1
\gset

select count(*) as total_crm_leads from public.crm_leads
\gset

select pg_temp.assert_true(
  (
    select array_agg(policyname::text order by policyname::text)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'crm_leads'
  ) = array[
    'crm_leads_public_insert',
    'crm_leads_service_role',
    'crm_leads_tenant_staff'
  ]::text[],
  'crm_leads must have only the three reviewed policies'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'crm_leads'
      and policyname in (
        'Unblock Insert',
        'Unblock Select',
        'Unblock Update',
        'Enable insert for authenticated users',
        'Enable select for users based on tenant',
        'Enable update for authenticated users'
      )
  ),
  'legacy permissive crm_leads policies must be absent'
);

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege('anon', 'public.crm_leads', 'SELECT')
    and not pg_catalog.has_table_privilege('anon', 'public.crm_leads', 'UPDATE')
    and not pg_catalog.has_any_column_privilege(
      'anon',
      'public.crm_leads',
      'SELECT'
    )
    and not pg_catalog.has_any_column_privilege(
      'anon',
      'public.crm_leads',
      'UPDATE'
    )
    and (
      select array_agg(attribute.attname::text order by attribute.attname)
      from pg_catalog.pg_attribute as attribute
      where attribute.attrelid = 'public.crm_leads'::pg_catalog.regclass
        and attribute.attnum > 0
        and not attribute.attisdropped
        and pg_catalog.has_column_privilege(
          'anon',
          'public.crm_leads',
          attribute.attname,
          'INSERT'
        )
    ) = array[
      'email',
      'goal',
      'name',
      'notes',
      'phone',
      'public_intake_idempotency_key',
      'source',
      'status',
      'tenant_id'
    ]::text[],
  'anon must have only the reviewed public intake column grants'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.crm_leads'::pg_catalog.regclass
      and conname = 'crm_leads_public_intake_idempotency_uniq'
      and contype = 'u'
      and pg_catalog.pg_get_constraintdef(oid, true) =
        'UNIQUE (tenant_id, public_intake_idempotency_key)'
  ),
  'Wolfie public intake idempotency constraint must be installed'
);

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.headers', '{"x-real-ip":"203.0.113.77"}', true);

savepoint allowed_public_lead;
insert into public.crm_leads (
  tenant_id, name, email, phone, status, source, goal
)
values (
  'school-wise-wolf', 'E2E Rollback', 'e2e@example.invalid',
  '11999999999', 'NEW', 'migration_test', 'test'
);
rollback to savepoint allowed_public_lead;

savepoint wolfie_key_required;
\set wolfie_key_required_failed false
\set wolfie_key_required_sqlstate ''
\set ON_ERROR_STOP off
insert into public.crm_leads (
  tenant_id, name, email, phone, status, source, goal
)
values (
  'school-wise-wolf', 'Missing Quiz Key', 'missing-key@example.invalid',
  '11999999991', 'NEW', 'wolfie_quiz', 'test'
);
\if :ERROR
  \set wolfie_key_required_failed true
  \set wolfie_key_required_sqlstate :SQLSTATE
\endif
\set ON_ERROR_STOP on
rollback to savepoint wolfie_key_required;
select pg_temp.assert_true(
  :'wolfie_key_required_failed'::boolean
    and :'wolfie_key_required_sqlstate' = '22023',
  'wolfie quiz lead without an idempotency key must fail validation'
);

savepoint wolfie_duplicate_key;
insert into public.crm_leads (
  tenant_id,
  name,
  email,
  phone,
  status,
  source,
  goal,
  public_intake_idempotency_key
)
values (
  'school-wise-wolf',
  'Idempotent Quiz Lead',
  'idempotent@example.invalid',
  '11999999992',
  'NEW',
  'wolfie_quiz',
  'test',
  '00000000-0000-4000-8000-000000000101'
);
\set wolfie_duplicate_key_failed false
\set wolfie_duplicate_key_sqlstate ''
\set ON_ERROR_STOP off
insert into public.crm_leads (
  tenant_id,
  name,
  email,
  phone,
  status,
  source,
  goal,
  public_intake_idempotency_key
)
values (
  'school-wise-wolf',
  'Idempotent Quiz Lead Retry',
  'idempotent-retry@example.invalid',
  '11999999993',
  'NEW',
  'wolfie_quiz',
  'test',
  '00000000-0000-4000-8000-000000000101'
);
\if :ERROR
  \set wolfie_duplicate_key_failed true
  \set wolfie_duplicate_key_sqlstate :SQLSTATE
\endif
\set ON_ERROR_STOP on
rollback to savepoint wolfie_duplicate_key;
select pg_temp.assert_true(
  :'wolfie_duplicate_key_failed'::boolean
    and :'wolfie_duplicate_key_sqlstate' = '23505',
  'retrying a Wolfie quiz key must hit the unique idempotency constraint'
);

savepoint invalid_lead_tenant;
\set invalid_lead_tenant_failed false
\set ON_ERROR_STOP off
insert into public.crm_leads (
  tenant_id, name, email, phone, status, source
)
values (
  'master', 'Blocked Tenant', 'blocked@example.invalid',
  '11999999998', 'NEW', 'migration_test'
);
\if :ERROR
  \set invalid_lead_tenant_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint invalid_lead_tenant;
select pg_temp.assert_true(
  :'invalid_lead_tenant_failed'::boolean,
  'anon insert for another tenant must fail'
);

savepoint privileged_lead_column;
\set privileged_lead_column_failed false
\set ON_ERROR_STOP off
insert into public.crm_leads (
  tenant_id, name, phone, status, source, ai_handled
)
values (
  'school-wise-wolf', 'Blocked Columns', '11999999997',
  'NEW', 'migration_test', true
);
\if :ERROR
  \set privileged_lead_column_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint privileged_lead_column;
select pg_temp.assert_true(
  :'privileged_lead_column_failed'::boolean,
  'anon insert into privileged lead columns must fail'
);

savepoint allowed_public_application;
insert into public.job_applications (
  tenant_id, name, whatsapp, resume_url, status, source, role
)
values (
  'school-wise-wolf', 'E2E Rollback', '11999999996',
  'https://api.wisewolflanguage.com.br/storage/v1/object/public/resumes/school-wise-wolf/00000000-0000-4000-8000-000000000001.pdf',
  'Novo', 'migration_test', 'professor'
);
rollback to savepoint allowed_public_application;

savepoint traversal_resume_url;
\set traversal_resume_url_failed false
\set ON_ERROR_STOP off
insert into public.job_applications (
  tenant_id, name, whatsapp, resume_url, status, source, role
)
values (
  'school-wise-wolf', 'Blocked Traversal', '11999999994',
  'https://api.wisewolflanguage.com.br/storage/v1/object/public/resumes/school-wise-wolf/../../contracts/private.pdf',
  'Novo', 'migration_test', 'professor'
);
\if :ERROR
  \set traversal_resume_url_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint traversal_resume_url;
select pg_temp.assert_true(
  :'traversal_resume_url_failed'::boolean,
  'resume path traversal must fail'
);

savepoint invalid_resume_url;
\set invalid_resume_url_failed false
\set ON_ERROR_STOP off
insert into public.job_applications (
  tenant_id, name, whatsapp, resume_url, status, source, role
)
values (
  'school-wise-wolf', 'Blocked SSRF', '11999999995',
  'http://127.0.0.1:8000/private', 'Novo', 'migration_test', 'professor'
);
\if :ERROR
  \set invalid_resume_url_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint invalid_resume_url;
select pg_temp.assert_true(
  :'invalid_resume_url_failed'::boolean,
  'arbitrary resume URL must fail'
);

savepoint direct_resume_upload;
\set direct_resume_upload_failed false
\set ON_ERROR_STOP off
insert into storage.objects (bucket_id, name, metadata)
values ('resumes', 'school-wise-wolf/direct-anon.pdf', '{"mimetype":"application/pdf","size":10}');
\if :ERROR
  \set direct_resume_upload_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint direct_resume_upload;
select pg_temp.assert_true(
  :'direct_resume_upload_failed'::boolean,
  'direct anonymous resume upload must fail'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', :'student_id')::text,
  true
);
select pg_temp.assert_true(
  (select count(*) = 0 from public.crm_leads),
  'student must not read CRM leads'
);
select pg_temp.assert_true(
  (select count(*) = 0 from public.job_applications),
  'student must not read job applications'
);

savepoint student_lead_insert;
\set student_lead_insert_failed false
\set ON_ERROR_STOP off
insert into public.crm_leads (
  tenant_id, name, email, phone, status, source
)
values (
  'school-wise-wolf', 'Blocked Student', 'student@example.invalid',
  '11999999989', 'NEW', 'migration_test'
);
\if :ERROR
  \set student_lead_insert_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint student_lead_insert;
select pg_temp.assert_true(
  :'student_lead_insert_failed'::boolean,
  'authenticated students must not insert CRM leads'
);

savepoint student_guard_bypass;
\set student_guard_bypass_failed false
\set student_guard_bypass_sqlstate ''
\set ON_ERROR_STOP off
insert into public.crm_leads (
  tenant_id, name, phone, status, source
)
values (
  'school-wise-wolf', 'X', '11999999988', 'NEW', 'migration_test'
);
\if :ERROR
  \set student_guard_bypass_failed true
  \set student_guard_bypass_sqlstate :SQLSTATE
\endif
\set ON_ERROR_STOP on
rollback to savepoint student_guard_bypass;
select pg_temp.assert_true(
  :'student_guard_bypass_failed'::boolean
    and :'student_guard_bypass_sqlstate' = '22023',
  'authenticated students must not bypass public payload validation'
);

savepoint student_resume_upload;
\set student_resume_upload_failed false
\set ON_ERROR_STOP off
insert into storage.objects (bucket_id, name, metadata)
values (
  'resumes',
  'school-wise-wolf/00000000-0000-4000-8000-000000000002.pdf',
  '{"mimetype":"application/pdf","size":10}'
);
\if :ERROR
  \set student_resume_upload_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint student_resume_upload;
select pg_temp.assert_true(
  :'student_resume_upload_failed'::boolean,
  'student direct resume upload must fail'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', :'admin_id')::text,
  true
);
select pg_temp.assert_true(
  not exists (
    select 1 from public.crm_leads where tenant_id <> 'school-wise-wolf'
  ),
  'school admin must not read another tenant CRM leads'
);
select pg_temp.assert_true(
  not exists (
    select 1 from public.job_applications where tenant_id <> 'school-wise-wolf'
  ),
  'school admin must not read another tenant applications'
);

savepoint authorized_staff_guard_bypass;
insert into public.crm_leads (
  tenant_id, name, phone, status, source, ai_handled
)
values (
  'school-wise-wolf', 'X', '11999999987',
  'CONTACTED', 'migration_test', true
);
rollback to savepoint authorized_staff_guard_bypass;

savepoint cross_tenant_staff_guard_bypass;
\set cross_tenant_staff_guard_bypass_failed false
\set cross_tenant_staff_guard_bypass_sqlstate ''
\set ON_ERROR_STOP off
insert into public.crm_leads (
  tenant_id, name, phone, status, source
)
values (
  'not-the-admin-tenant', 'Cross Tenant', '11999999986',
  'NEW', 'migration_test'
);
\if :ERROR
  \set cross_tenant_staff_guard_bypass_failed true
  \set cross_tenant_staff_guard_bypass_sqlstate :SQLSTATE
\endif
\set ON_ERROR_STOP on
rollback to savepoint cross_tenant_staff_guard_bypass;
select pg_temp.assert_true(
  :'cross_tenant_staff_guard_bypass_failed'::boolean
    and :'cross_tenant_staff_guard_bypass_sqlstate' = '22023',
  'staff must not bypass the guard for another tenant'
);

savepoint admin_resume_upload;
insert into storage.objects (bucket_id, name, metadata)
values (
  'resumes',
  'school-wise-wolf/00000000-0000-4000-8000-000000000003.pdf',
  '{"mimetype":"application/pdf","size":10}'
);
rollback to savepoint admin_resume_upload;

savepoint admin_cross_tenant_resume_upload;
\set admin_cross_tenant_resume_upload_failed false
\set ON_ERROR_STOP off
insert into storage.objects (bucket_id, name, metadata)
values (
  'resumes',
  'other-tenant/00000000-0000-4000-8000-000000000004.pdf',
  '{"mimetype":"application/pdf","size":10}'
);
\if :ERROR
  \set admin_cross_tenant_resume_upload_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint admin_cross_tenant_resume_upload;
select pg_temp.assert_true(
  :'admin_cross_tenant_resume_upload_failed'::boolean,
  'school admin direct upload for another tenant must fail'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', :'super_id')::text,
  true
);
select pg_temp.assert_true(
  (select count(*) from public.crm_leads) = :'total_crm_leads'::bigint,
  'super admin CRM access must remain available'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
savepoint service_role_guard_bypass;
insert into public.crm_leads (
  tenant_id, name, phone, status, source, ai_handled
)
values (
  'school-wise-wolf', 'X', '11999999985',
  'CONTACTED', 'migration_test', true
);
rollback to savepoint service_role_guard_bypass;

reset role;
select 'public_intake_rls_tests_passed' as result;
rollback;
