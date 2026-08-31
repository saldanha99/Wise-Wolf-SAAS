-- Professores recebem somente o diretório pedagógico dos próprios alunos.
-- PII, cobrança, dados bancários e contratos permanecem em RPCs explícitas.

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

create or replace function pg_temp.assert_denied(command text, message text)
returns void
language plpgsql
as $$
begin
  begin
    execute command;
  exception
    when insufficient_privilege then return;
  end;
  raise exception 'assertion failed: %', message;
end;
$$;

grant execute on function pg_temp.assert_denied(text, text) to public;

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'authenticated', 'public.profiles', 'SELECT'
  )
  and pg_catalog.has_column_privilege(
    'authenticated', 'public.profiles', 'full_name', 'SELECT'
  )
  and pg_catalog.has_column_privilege(
    'authenticated', 'public.profiles', 'module', 'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated', 'public.profiles', 'cpf', 'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated', 'public.profiles', 'bank_name', 'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated', 'public.profiles', 'private_notes', 'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated', 'public.profiles', 'asaas_customer_id', 'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated', 'public.profiles', 'address', 'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated', 'public.profiles', 'guardian_cpf', 'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated', 'public.profiles', 'contract_url', 'SELECT'
  ),
  'profiles grants expose a protected column or lost the directory projection'
);

select pg_temp.assert_true(
  not pg_catalog.has_column_privilege(
    'anon', 'public.profiles', 'full_name', 'SELECT'
  ),
  'anonymous role retained direct profile access'
);

select pg_temp.assert_true(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_authorized_profile_private(uuid)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_authorized_guardian_directory(text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_student_overview_internal_20260824(uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.get_authorized_profile_private(uuid)',
    'EXECUTE'
  ),
  'private function grants are broader than the reviewed surface'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(policyname::text order by policyname)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and cmd = 'SELECT'
  ) = array['profiles_scoped_read_p1']::text[],
  'profiles retained a permissive SELECT policy'
);

insert into public.tenants (id, name, saas_status)
values
  ('profile-pii-a', 'Profile PII A', 'active'),
  ('profile-pii-b', 'Profile PII B', 'active');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'profile-pii-admin-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Direcao PII A"}', now(), now()),
  ('f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'profile-pii-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professor PII A"}', now(), now()),
  ('f1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'profile-pii-assigned-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Vinculado A"}', now(), now()),
  ('f1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'profile-pii-unassigned-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Nao Vinculado A"}', now(), now()),
  ('f1000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'profile-pii-admin-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Direcao PII B"}', now(), now()),
  ('f1000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'profile-pii-student-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno PII B"}', now(), now());

set local app.enrollment_claim = '1';
update public.profiles
set tenant_id = 'profile-pii-a', role = 'SCHOOL_ADMIN',
    full_name = 'Direcao PII A', cpf = '00000000001'
where id = 'f1000000-0000-4000-8000-000000000001';
update public.profiles
set tenant_id = 'profile-pii-a', role = 'TEACHER',
    full_name = 'Professor PII A', cpf = '00000000002',
    bank_name = 'Banco Professor', agency = '0001', account_number = '12345'
where id = 'f1000000-0000-4000-8000-000000000002';
update public.profiles
set tenant_id = 'profile-pii-a', role = 'STUDENT',
    full_name = 'Aluno Vinculado A', cpf = '00000000003',
    address = 'Rua Privada', address_number = '10', postal_code = '01001000',
    guardian_name = 'Responsavel Privado', guardian_phone = '5511999990001',
    private_notes = 'nota privada', asaas_customer_id = 'cus_private_a',
    monthly_fee = 499, due_day = 10, status_financial = 'ACTIVE'
where id = 'f1000000-0000-4000-8000-000000000003';
update public.profiles
set tenant_id = 'profile-pii-a', role = 'STUDENT',
    full_name = 'Aluno Nao Vinculado A', cpf = '00000000004',
    address = 'Outra Rua Privada', lifecycle_status = 'offboarded',
    status_financial = 'SUSPENDED'
where id = 'f1000000-0000-4000-8000-000000000004';
update public.profiles
set tenant_id = 'profile-pii-b', role = 'SCHOOL_ADMIN',
    full_name = 'Direcao PII B'
where id = 'f1000000-0000-4000-8000-000000000005';
update public.profiles
set tenant_id = 'profile-pii-b', role = 'STUDENT',
    full_name = 'Aluno PII B', cpf = '00000000006'
where id = 'f1000000-0000-4000-8000-000000000006';
set local app.enrollment_claim = '';

update public.profiles
   set status_financial = 'ACTIVE'
 where id = 'f1000000-0000-4000-8000-000000000004';
select pg_temp.assert_true(
  (
    select status_financial = 'SUSPENDED'
      from public.profiles
     where id = 'f1000000-0000-4000-8000-000000000004'
  ),
  'offboarded student became financially active'
);

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  ('f1000000-0000-4000-8000-000000000001', 'profile-pii-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('f1000000-0000-4000-8000-000000000002', 'profile-pii-a', 'TEACHER', 'ACTIVE', true),
  ('f1000000-0000-4000-8000-000000000003', 'profile-pii-a', 'STUDENT', 'ACTIVE', true),
  ('f1000000-0000-4000-8000-000000000004', 'profile-pii-a', 'STUDENT', 'ACTIVE', true),
  ('f1000000-0000-4000-8000-000000000005', 'profile-pii-b', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('f1000000-0000-4000-8000-000000000006', 'profile-pii-b', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('f1000000-0000-4000-8000-000000000001', 'profile-pii-a'),
  ('f1000000-0000-4000-8000-000000000002', 'profile-pii-a'),
  ('f1000000-0000-4000-8000-000000000003', 'profile-pii-a'),
  ('f1000000-0000-4000-8000-000000000004', 'profile-pii-a'),
  ('f1000000-0000-4000-8000-000000000005', 'profile-pii-b'),
  ('f1000000-0000-4000-8000-000000000006', 'profile-pii-b')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

-- O vínculo é deliberadamente só pela agenda: a política não pode depender de
-- um filtro construído pelo navegador.
insert into public.bookings (
  id, tenant_id, teacher_id, student_id, day_of_week, time_slot, status
)
values (
  'f2000000-0000-4000-8000-000000000001',
  'profile-pii-a',
  'f1000000-0000-4000-8000-000000000002',
  'f1000000-0000-4000-8000-000000000003',
  'Monday', '09:00', 'SCHEDULED'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(id order by id)
    from public.profiles
    where role = 'STUDENT'
  ) = array['f1000000-0000-4000-8000-000000000003'::uuid],
  'teacher read an unassigned or cross-tenant student'
);

select pg_temp.assert_denied(
  $$select cpf from public.profiles
    where id = 'f1000000-0000-4000-8000-000000000003'$$,
  'teacher selected CPF directly'
);

select pg_temp.assert_true(
  public.get_authorized_profile_private(
    'f1000000-0000-4000-8000-000000000002'
  ) ->> 'bank_name' = 'Banco Professor',
  'teacher could not read their own private profile'
);

select pg_temp.assert_denied(
  $$select public.get_authorized_profile_private(
      'f1000000-0000-4000-8000-000000000003'
    )$$,
  'teacher read assigned student private fields'
);

select pg_temp.assert_denied(
  $$select * from public.get_authorized_guardian_directory('profile-pii-a')$$,
  'teacher listed the tenant guardian directory'
);

select pg_temp.assert_denied(
  $$select public.find_authorized_profile_by_cpf(
      'profile-pii-a', '000.000.000-03'
    )$$,
  'teacher probed a CPF through the lookup function'
);

select pg_temp.assert_true(
  not ((
    public.get_student_overview(
      'f1000000-0000-4000-8000-000000000003'
    ) -> 'profile'
  ) ?| array['guardian_name', 'guardian_phone', 'status_financial'])
  and not (public.get_student_overview(
    'f1000000-0000-4000-8000-000000000003'
  ) ?| array['financial', 'payments', 'audit']),
  'teacher overview leaked guardian or financial data'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert_true(
  public.get_authorized_profile_private(
    'f1000000-0000-4000-8000-000000000003'
  ) ->> 'cpf' = '00000000003'
  and public.get_authorized_profile_private(
    'f1000000-0000-4000-8000-000000000003'
  ) ->> 'private_notes' = 'nota privada'
  and public.get_authorized_profile_private(
    'f1000000-0000-4000-8000-000000000003'
  ) ->> 'asaas_customer_id' = 'cus_private_a',
  'tenant admin lost authorized private profile access'
);

select pg_temp.assert_true(
  public.find_authorized_profile_by_cpf(
    'profile-pii-a', '000.000.000-03'
  ) = 'f1000000-0000-4000-8000-000000000003'::uuid,
  'tenant admin could not resolve a tenant CPF'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.get_authorized_guardian_directory('profile-pii-a')
    where id = 'f1000000-0000-4000-8000-000000000006'
  ),
  'guardian directory crossed the active tenant'
);

select pg_temp.assert_true(
  (
    select count(*)
    from public.get_authorized_student_billing_summary('profile-pii-a')
  ) = 1,
  'tenant billing summary included an offboarded or cross-tenant student'
);

select pg_temp.assert_denied(
  $$select public.find_authorized_profile_by_cpf(
      'profile-pii-b', '00000000006'
    )$$,
  'tenant admin probed CPF in another tenant'
);

select pg_temp.assert_true(
  (
    public.get_student_overview(
      'f1000000-0000-4000-8000-000000000003'
    ) -> 'profile'
  ) ?| array['guardian_name', 'guardian_phone', 'status_financial']
  and public.get_student_overview(
    'f1000000-0000-4000-8000-000000000003'
  ) ? 'financial',
  'tenant admin lost the authorized financial overview'
);

rollback;
