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

insert into public.tenants (id, name, slug, saas_status)
values (
  'public-intake-test',
  'Public Intake Test',
  'public-intake-test',
  'active'
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
  '56000000-0000-4000-8000-000000000101',
  'authenticated',
  'authenticated',
  'public-intake-referrer@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Public Intake Referrer"}',
  now(),
  now()
);

select set_config('app.enrollment_claim', '1', true);
update public.profiles
set tenant_id = 'public-intake-test',
    lifecycle_status = 'active',
    role = 'TEACHER'
where id = '56000000-0000-4000-8000-000000000101';
select set_config('app.enrollment_claim', '', true);

insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
)
values (
  '56000000-0000-4000-8000-000000000101',
  'public-intake-test',
  'TEACHER',
  'ACTIVE',
  true
)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

select pg_temp.assert_true(
  (
    select array_agg(policyname::text order by policyname::text)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'saas_leads'
  ) = array[
    'saas_leads_public_intake',
    'saas_leads_super_admin'
  ]::text[],
  'saas_leads must have only the reviewed intake and admin policies'
);

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege('anon', 'public.saas_leads', 'SELECT')
    and not pg_catalog.has_table_privilege('anon', 'public.saas_leads', 'UPDATE')
    and not pg_catalog.has_table_privilege('anon', 'public.saas_leads', 'DELETE')
    and not pg_catalog.has_any_column_privilege('anon', 'public.saas_leads', 'SELECT')
    and not pg_catalog.has_any_column_privilege('anon', 'public.saas_leads', 'UPDATE')
    and not pg_catalog.has_column_privilege('anon', 'public.saas_leads', 'converted_tenant_id', 'INSERT')
    and not pg_catalog.has_column_privilege('anon', 'public.saas_leads', 'owner_cpf_cnpj', 'INSERT')
    and not pg_catalog.has_column_privilege('anon', 'public.saas_leads', 'created_at', 'INSERT')
    and pg_catalog.has_column_privilege('anon', 'public.saas_leads', 'name', 'INSERT')
    and pg_catalog.has_column_privilege('anon', 'public.saas_leads', 'lead_type', 'INSERT'),
  'anonymous SaaS intake grants must expose only reviewed insert columns'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.saas_leads'::pg_catalog.regclass
      and tgname = 'aaa_guard_public_saas_leads'
      and not tgisinternal
  ),
  'public SaaS lead validation trigger must be installed'
);

select pg_temp.assert_true(
  position(
    'x-forwarded-for' in lower(
      pg_catalog.pg_get_functiondef(
        'private.guard_public_saas_lead_intake()'::pg_catalog.regprocedure
      )
    )
  ) = 0
  and position(
    'new.email' in lower(
      pg_catalog.pg_get_functiondef(
        'private.guard_public_saas_lead_intake()'::pg_catalog.regprocedure
      )
    )
  ) > 0
  and position(
    'current_user' in lower(
      pg_catalog.pg_get_functiondef(
        'private.guard_public_saas_lead_intake()'::pg_catalog.regprocedure
      )
    )
  ) = 0,
  'anonymous intake must use normalized lead identity and the caller JWT, not spoofable headers or the definer role'
);

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.headers', '{"x-real-ip":"203.0.113.144"}', true);

savepoint valid_teacher_diagnosis;
insert into public.saas_leads (
  name,
  email,
  phone,
  school_name,
  status,
  owner_name,
  owner_email,
  owner_phone,
  estimated_students,
  estimated_teachers,
  source,
  plan_interest,
  lead_type,
  notes
)
values (
  'Lead de teste rollback',
  'teacher-diagnosis@example.invalid',
  '11999999999',
  'Operação de teste rollback',
  'new',
  'Lead de teste rollback',
  'teacher-diagnosis@example.invalid',
  '11999999999',
  12,
  1,
  'teacher_signup',
  'Professor Negócio',
  'teacher',
  'Principal gargalo informado: teste transacional.'
);
rollback to savepoint valid_teacher_diagnosis;

savepoint valid_school_diagnosis;
insert into public.saas_leads (
  name,
  email,
  phone,
  school_name,
  status,
  owner_name,
  owner_email,
  owner_phone,
  estimated_students,
  estimated_teachers,
  source,
  plan_interest,
  lead_type,
  notes
)
values (
  'Direção de teste rollback',
  'school-diagnosis@example.invalid',
  '11999999995',
  'Escola de teste rollback',
  'LEAD',
  'Direção de teste rollback',
  'school-diagnosis@example.invalid',
  '11999999995',
  80,
  6,
  'public_school_diagnosis',
  'Wise Wolf para Escolas — diagnóstico assistido',
  'school',
  'Diagnóstico escolar transacional.'
);
rollback to savepoint valid_school_diagnosis;

savepoint valid_teacher_referral;
insert into public.saas_leads (
  name,
  email,
  phone,
  school_name,
  status,
  owner_name,
  owner_email,
  owner_phone,
  estimated_teachers,
  source,
  plan_interest,
  lead_type,
  parent_tenant_id,
  referrer_teacher_id
)
values (
  'Indicação válida',
  'valid-referral@example.invalid',
  '11999999992',
  'Operação indicada rollback',
  'new',
  'Indicação válida',
  'valid-referral@example.invalid',
  '11999999992',
  1,
  'teacher_to_teacher_referral',
  'Professor Negócio',
  'teacher',
  'public-intake-test',
  '56000000-0000-4000-8000-000000000101'
);
rollback to savepoint valid_teacher_referral;

reset role;
update public.tenant_memberships
set status = 'REVOKED',
    updated_at = now()
where user_id = '56000000-0000-4000-8000-000000000101'
  and tenant_id = 'public-intake-test';
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

savepoint revoked_teacher_referral;
\set revoked_teacher_referral_failed false
\set ON_ERROR_STOP off
insert into public.saas_leads (
  name, email, phone, school_name, status, owner_name, owner_email,
  owner_phone, estimated_teachers, source, plan_interest, lead_type,
  parent_tenant_id, referrer_teacher_id
)
values (
  'Indicação revogada', 'revoked-referral@example.invalid', '11999999991',
  'Operação indicada rollback', 'new', 'Indicação revogada',
  'revoked-referral@example.invalid', '11999999991', 1,
  'teacher_to_teacher_referral', 'Professor Negócio', 'teacher',
  'public-intake-test', '56000000-0000-4000-8000-000000000101'
);
\if :ERROR
  \set revoked_teacher_referral_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint revoked_teacher_referral;
select pg_temp.assert_true(
  :'revoked_teacher_referral_failed'::boolean,
  'a stale profile tenant must not authorize referral attribution after membership revocation'
);

savepoint spoofed_teacher_source;
\set spoofed_teacher_source_failed false
\set ON_ERROR_STOP off
insert into public.saas_leads (
  name, email, phone, school_name, status, owner_name, owner_email,
  owner_phone, estimated_teachers, source, plan_interest, lead_type
)
values (
  'Origem adulterada', 'spoofed-source@example.invalid', '11999999994',
  'Operação rollback', 'new', 'Origem adulterada',
  'spoofed-source@example.invalid', '11999999994', 1,
  'teacher_referral', 'Professor Negócio', 'teacher'
);
\if :ERROR
  \set spoofed_teacher_source_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint spoofed_teacher_source;
select pg_temp.assert_true(
  :'spoofed_teacher_source_failed'::boolean,
  'public teacher intake must not forge referral attribution'
);

savepoint public_document_column;
\set public_document_column_failed false
\set ON_ERROR_STOP off
insert into public.saas_leads (
  name, email, phone, school_name, status, source, lead_type, owner_cpf_cnpj
)
values (
  'Documento público', 'document@example.invalid', '11999999993',
  'Escola rollback', 'LEAD', 'public_school_diagnosis', 'school', '12345678901'
);
\if :ERROR
  \set public_document_column_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint public_document_column;
select pg_temp.assert_true(
  :'public_document_column_failed'::boolean,
  'public diagnosis intake must not accept identity documents'
);

savepoint privileged_status;
\set privileged_status_failed false
\set ON_ERROR_STOP off
insert into public.saas_leads (
  name, email, phone, school_name, status, source, lead_type
)
values (
  'Status privilegiado', 'privileged@example.invalid', '11999999998',
  'Escola rollback', 'CLOSED_WON', 'migration_test', 'school'
);
\if :ERROR
  \set privileged_status_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint privileged_status;
select pg_temp.assert_true(
  :'privileged_status_failed'::boolean,
  'public SaaS intake must not create a converted or won workflow state'
);

savepoint privileged_column;
\set privileged_column_failed false
\set ON_ERROR_STOP off
insert into public.saas_leads (
  name, email, phone, school_name, status, source, lead_type, converted_tenant_id
)
values (
  'Tenant privilegiado', 'tenant@example.invalid', '11999999997',
  'Escola rollback', 'LEAD', 'migration_test', 'school', 'school-wise-wolf'
);
\if :ERROR
  \set privileged_column_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint privileged_column;
select pg_temp.assert_true(
  :'privileged_column_failed'::boolean,
  'anonymous SaaS intake must not write conversion fields'
);

savepoint anonymous_read;
\set anonymous_read_failed false
\set ON_ERROR_STOP off
select id from public.saas_leads limit 1;
\if :ERROR
  \set anonymous_read_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint anonymous_read;
select pg_temp.assert_true(
  :'anonymous_read_failed'::boolean,
  'anonymous visitors must not enumerate SaaS leads'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', :'student_id')::text,
  true
);

select pg_temp.assert_true(
  (select count(*) = 0 from public.saas_leads),
  'authenticated non-admin users must not read SaaS leads'
);

savepoint student_privileged_insert;
\set student_privileged_insert_failed false
\set ON_ERROR_STOP off
insert into public.saas_leads (
  name, email, phone, school_name, status, source, lead_type
)
values (
  'Usuário autenticado', 'student@example.invalid', '11999999996',
  'Escola rollback', 'TRIAL', 'migration_test', 'school'
);
\if :ERROR
  \set student_privileged_insert_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint student_privileged_insert;
select pg_temp.assert_true(
  :'student_privileged_insert_failed'::boolean,
  'authenticated non-admin users must not bypass the public intake workflow'
);

rollback;
