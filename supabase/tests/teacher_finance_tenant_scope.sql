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

insert into public.tenants (id, name, saas_status)
values
  ('finance-scope-school-a', 'Finance Scope School A', 'active'),
  ('finance-scope-school-b', 'Finance Scope School B', 'active');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-000000000f01', 'authenticated', 'authenticated', 'finance-admin-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Admin A"}', now(), now()),
  ('00000000-0000-4000-8000-000000000f02', 'authenticated', 'authenticated', 'finance-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher A"}', now(), now()),
  ('00000000-0000-4000-8000-000000000f03', 'authenticated', 'authenticated', 'finance-student-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Student A"}', now(), now()),
  ('00000000-0000-4000-8000-000000000f04', 'authenticated', 'authenticated', 'finance-admin-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Admin B"}', now(), now()),
  ('00000000-0000-4000-8000-000000000f05', 'authenticated', 'authenticated', 'finance-teacher-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher B"}', now(), now()),
  ('00000000-0000-4000-8000-000000000f06', 'authenticated', 'authenticated', 'finance-former-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Former Teacher A"}', now(), now());

update public.profiles
set tenant_id = 'finance-scope-school-a', role = 'SCHOOL_ADMIN', lifecycle_status = 'active'
where id = '00000000-0000-4000-8000-000000000f01';

update public.profiles
set tenant_id = 'finance-scope-school-a', role = 'TEACHER', lifecycle_status = 'active'
where id = '00000000-0000-4000-8000-000000000f02';

update public.profiles
set tenant_id = 'finance-scope-school-a', role = 'STUDENT', lifecycle_status = 'active'
where id = '00000000-0000-4000-8000-000000000f03';

update public.profiles
set tenant_id = 'finance-scope-school-b', role = 'SCHOOL_ADMIN', lifecycle_status = 'active'
where id = '00000000-0000-4000-8000-000000000f04';

update public.profiles
set tenant_id = 'finance-scope-school-b', role = 'TEACHER', lifecycle_status = 'active'
where id = '00000000-0000-4000-8000-000000000f05';

update public.profiles
set tenant_id = 'finance-scope-school-a', role = 'TEACHER', lifecycle_status = 'offboarded'
where id = '00000000-0000-4000-8000-000000000f06';

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
values
  ('00000000-0000-4000-8000-000000000f01', 'finance-scope-school-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000f02', 'finance-scope-school-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000f03', 'finance-scope-school-a', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000f04', 'finance-scope-school-b', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000f05', 'finance-scope-school-b', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000f06', 'finance-scope-school-a', 'TEACHER', 'REVOKED', false)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('00000000-0000-4000-8000-000000000f01', 'finance-scope-school-a'),
  ('00000000-0000-4000-8000-000000000f02', 'finance-scope-school-a'),
  ('00000000-0000-4000-8000-000000000f03', 'finance-scope-school-a'),
  ('00000000-0000-4000-8000-000000000f04', 'finance-scope-school-b'),
  ('00000000-0000-4000-8000-000000000f05', 'finance-scope-school-b')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

insert into public.teacher_closings (
  id,
  tenant_id,
  teacher_id,
  month_year,
  total_lessons,
  total_amount,
  status
)
values (
  '00000000-0000-4000-8000-000000000f60',
  'finance-scope-school-a',
  '00000000-0000-4000-8000-000000000f06',
  '2026-07',
  10,
  100,
  'PENDENTE'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.teacher_pay_projection_unchecked(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_teacher_closing_report_unchecked(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.create_teacher_transfer_unchecked(uuid,uuid,jsonb,date,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.teacher_closing_adjustments_unchecked(uuid,text)',
    'EXECUTE'
  ),
  'authenticated ainda executa implementacoes financeiras sem escopo'
);

select pg_temp.assert_true(
  has_function_privilege(
    'authenticated',
    'public.teacher_pay_projection(uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.get_teacher_closing_report(uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.create_teacher_transfer(uuid,uuid,jsonb,date,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.teacher_closing_adjustments(uuid,text)',
    'EXECUTE'
  ),
  'fachadas tenant-aware nao ficaram disponiveis para usuarios autenticados'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'v_school_cashflow_summary',
        'v_student_receivables',
        'v_teacher_payables'
      )
      and coalesce(relation.reloptions, array[]::text[])
        @> array['security_invoker=true']::text[]
    group by namespace.nspname
    having count(*) = 3
  ),
  'views financeiras nao executam com as permissoes do chamador'
);

select pg_temp.assert_true(
  not has_table_privilege('authenticated', 'public.v_school_cashflow_summary', 'SELECT')
  and not has_table_privilege('authenticated', 'public.v_student_receivables', 'SELECT')
  and not has_table_privilege('authenticated', 'public.v_teacher_payables', 'SELECT')
  and has_table_privilege('service_role', 'public.v_school_cashflow_summary', 'SELECT'),
  'views financeiras internas continuam expostas aos papeis da API'
);

select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'public.apply_teacher_transfer(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.apply_due_teacher_transfers()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._enqueue_school_whatsapp(text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.run_monthly_teacher_closing(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.teacher_carteira(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.teacher_pending_carryover(uuid)', 'EXECUTE'),
  'helpers privilegiados de folha ou transferencia continuam publicos'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000f01","role":"authenticated"}';

select public.teacher_pay_projection(
  '00000000-0000-4000-8000-000000000f02',
  '2026-08'
);

select public.get_teacher_closing_report(
  '00000000-0000-4000-8000-000000000f02',
  '2026-08'
);

select public.teacher_closing_adjustments(
  '00000000-0000-4000-8000-000000000f02',
  '2026-08'
);

select public.get_teacher_closing_report(
  '00000000-0000-4000-8000-000000000f06',
  '2026-07'
);

select pg_temp.assert_true(
  (public.create_teacher_transfer(
    '00000000-0000-4000-8000-000000000f03',
    '00000000-0000-4000-8000-000000000f02',
    '[{"day_of_week":"Segunda","time_slot":"10:00"}]'::jsonb,
    current_date + 7,
    'same-tenant test'
  )->>'ok')::boolean,
  'transferencia valida dentro do tenant foi bloqueada'
);

do $$
begin
  perform public.teacher_pay_projection(
    '00000000-0000-4000-8000-000000000f05',
    '2026-08'
  );
  raise exception 'assertion failed: admin A consultou projecao do tenant B';
exception
  when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.get_teacher_closing_report(
    '00000000-0000-4000-8000-000000000f05',
    '2026-08'
  );
  raise exception 'assertion failed: admin A consultou fechamento do tenant B';
exception
  when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.create_teacher_transfer(
    '00000000-0000-4000-8000-000000000f03',
    '00000000-0000-4000-8000-000000000f05',
    '[{"day_of_week":"Segunda","time_slot":"10:00"}]'::jsonb,
    current_date + 7,
    'cross-tenant test'
  );
  raise exception 'assertion failed: admin A transferiu aluno para professor do tenant B';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;

insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
)
values (
  '00000000-0000-4000-8000-000000000f02',
  'finance-scope-school-b',
  'TEACHER',
  'ACTIVE',
  false
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000f02","role":"authenticated"}';

do $$
begin
  perform public.teacher_pay_projection(
    '00000000-0000-4000-8000-000000000f02',
    '2026-08'
  );
  raise exception 'assertion failed: projecao aceitou professor com dois tenants ativos';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;

update public.tenant_memberships
set status = 'SUSPENDED'
where user_id = '00000000-0000-4000-8000-000000000f02'
  and tenant_id = 'finance-scope-school-b';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000f02","role":"authenticated"}';

select public.teacher_pay_projection(
  '00000000-0000-4000-8000-000000000f02',
  '2026-08'
);

do $$
begin
  perform public.get_teacher_closing_report(
    '00000000-0000-4000-8000-000000000f05',
    '2026-08'
  );
  raise exception 'assertion failed: professor A consultou fechamento do tenant B';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;

rollback;
