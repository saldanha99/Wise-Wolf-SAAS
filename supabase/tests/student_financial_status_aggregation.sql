-- A webhook for an old charge must never override the newest matured billing
-- competence. All fixtures are rolled back.

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
  not has_function_privilege(
    'anon',
    'public.recompute_student_financial_status(text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.recompute_student_financial_status(text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.recompute_student_financial_status(text,uuid)',
    'EXECUTE'
  )
  and not has_table_privilege(
    'service_role',
    'public.student_financial_status_audit',
    'INSERT'
  ),
  'financial aggregate privileges are unsafe'
);

insert into public.tenants (id, name, slug, saas_status)
values (
  'student-financial-aggregate',
  'Student Financial Aggregate',
  'student-financial-aggregate',
  'active'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f701',
  'authenticated',
  'authenticated',
  'student-financial-aggregate@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Aggregate Test Student"}',
  now(),
  now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'student-financial-aggregate',
       role = 'STUDENT',
       lifecycle_status = 'active',
       status_financial = 'PENDING',
       full_name = 'Aggregate Test Student',
       asaas_customer_id = 'cus_financial_aggregate',
       is_test_account = true
 where id = '00000000-0000-4000-8000-00000000f701';
set local app.enrollment_claim = '';

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, status, provider_status, due_date
) values
  (
    '10000000-0000-4000-8000-00000000f701',
    '00000000-0000-4000-8000-00000000f701',
    'student-financial-aggregate',
    'pay_financial_older',
    'cus_financial_aggregate',
    100,
    'PENDING',
    'PENDING',
    current_date - 31
  ),
  (
    '10000000-0000-4000-8000-00000000f702',
    '00000000-0000-4000-8000-00000000f701',
    'student-financial-aggregate',
    'pay_financial_current',
    'cus_financial_aggregate',
    100,
    'OVERDUE',
    'OVERDUE',
    current_date - 1
  );

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

select public.recompute_student_financial_status(
  'student-financial-aggregate',
  '00000000-0000-4000-8000-00000000f701'
);
select pg_temp.assert_true(
  (
    select status_financial = 'OVERDUE'
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f701'
  ),
  'newest overdue competence did not win'
);

-- A late settlement for the older charge cannot clear the current overdue.
update public.student_payments
   set status = 'RECEIVED', provider_status = 'RECEIVED'
 where id = '10000000-0000-4000-8000-00000000f701';
select public.recompute_student_financial_status(
  'student-financial-aggregate',
  '00000000-0000-4000-8000-00000000f701'
);
select pg_temp.assert_true(
  (
    select status_financial = 'OVERDUE'
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f701'
  ),
  'late older settlement cleared a newer overdue charge'
);

-- Once the newest competence settles, it becomes active.
update public.student_payments
   set status = 'RECEIVED', provider_status = 'RECEIVED'
 where id = '10000000-0000-4000-8000-00000000f702';
select public.recompute_student_financial_status(
  'student-financial-aggregate',
  '00000000-0000-4000-8000-00000000f701'
);
select pg_temp.assert_true(
  (
    select status_financial = 'ACTIVE'
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f701'
  ),
  'newest settled competence did not reactivate the student'
);

-- A late overdue event from an older charge cannot block current access.
update public.student_payments
   set status = 'OVERDUE', provider_status = 'OVERDUE'
 where id = '10000000-0000-4000-8000-00000000f701';
select public.recompute_student_financial_status(
  'student-financial-aggregate',
  '00000000-0000-4000-8000-00000000f701'
);
select pg_temp.assert_true(
  (
    select status_financial = 'ACTIVE'
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f701'
  ),
  'late older overdue event blocked a newer settled charge'
);

-- Future invoices are not matured and cannot change today's state.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, status, provider_status, due_date
) values (
  '10000000-0000-4000-8000-00000000f703',
  '00000000-0000-4000-8000-00000000f701',
  'student-financial-aggregate',
  'pay_financial_future',
  'cus_financial_aggregate',
  100,
  'OVERDUE',
  'OVERDUE',
  current_date + 10
);
select public.recompute_student_financial_status(
  'student-financial-aggregate',
  '00000000-0000-4000-8000-00000000f701'
);
select pg_temp.assert_true(
  (
    select status_financial = 'ACTIVE'
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f701'
  ),
  'future invoice changed the current financial state'
);

-- A manual non-revenue ledger classification is not proof of tuition access
-- and cannot clear an existing overdue state.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, status, provider_status, due_date
) values
  (
    '10000000-0000-4000-8000-00000000f704',
    '00000000-0000-4000-8000-00000000f701',
    'student-financial-aggregate',
    'pay_financial_non_revenue',
    'cus_financial_aggregate',
    100,
    'NAO_RECEITA',
    'RECEIVED',
    current_date
  ),
  (
    '10000000-0000-4000-8000-00000000f705',
    '00000000-0000-4000-8000-00000000f701',
    'student-financial-aggregate',
    'pay_financial_actual_overdue',
    'cus_financial_aggregate',
    100,
    'OVERDUE',
    'OVERDUE',
    current_date - 1
  );
select public.recompute_student_financial_status(
  'student-financial-aggregate',
  '00000000-0000-4000-8000-00000000f701'
);
select pg_temp.assert_true(
  (
    select status_financial = 'OVERDUE'
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f701'
  ),
  'NAO_RECEITA cleared a real overdue financial state'
);

-- An archived or lifecycle-inactive profile is a manual terminal state.
set local app.enrollment_claim = '1';
update public.profiles
   set status_financial = 'ARCHIVED'
 where id = '00000000-0000-4000-8000-00000000f701';
set local app.enrollment_claim = '';
select public.recompute_student_financial_status(
  'student-financial-aggregate',
  '00000000-0000-4000-8000-00000000f701'
);
select pg_temp.assert_true(
  (
    select status_financial = 'ARCHIVED'
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f701'
  ),
  'aggregate overwrote an archived profile'
);

select pg_temp.assert_true(
  (
    select count(*) = 3
      from public.student_financial_status_audit
     where tenant_id = 'student-financial-aggregate'
       and student_id = '00000000-0000-4000-8000-00000000f701'
  ),
  'financial status transitions were not audited exactly once'
);

do $scope_mismatch$
begin
  perform public.recompute_student_financial_status(
    'school-wise-wolf',
    '00000000-0000-4000-8000-00000000f701'
  );
  raise exception 'cross_tenant_scope_was_accepted';
exception
  when insufficient_privilege then null;
end;
$scope_mismatch$;

rollback;
