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

create or replace function pg_temp.assert_access_denied(command text, message text)
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

create or replace function pg_temp.assert_no_visible_rows(command text, message text)
returns void
language plpgsql
as $$
declare
  visible_rows bigint;
begin
  begin
    execute command into visible_rows;
  exception
    when insufficient_privilege then return;
  end;

  if coalesce(visible_rows, 0) <> 0 then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

select pg_temp.assert_true(
  exists (
    select 1
    from storage.buckets
    where id = 'invoices'
      and public = false
      and file_size_limit = 5 * 1024 * 1024
      and allowed_mime_types = array['application/pdf']::text[]
  ),
  'invoices bucket is missing, public, oversized or accepts non-PDF MIME types'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.get_teacher_activity_report(uuid,text)',
    'EXECUTE'
  ),
  'anonymous role can execute the teacher activity report'
);

insert into public.tenants (id, name, saas_status)
values
  ('teacher-invoice-isolation-a', 'Teacher Invoice Isolation A', 'active'),
  ('teacher-invoice-isolation-b', 'Teacher Invoice Isolation B', 'active');

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
values
  ('e1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'invoice-admin-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Invoice Admin A"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'invoice-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Invoice Teacher A"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'invoice-teacher-peer@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Invoice Teacher Peer"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'invoice-admin-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Invoice Admin B"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'invoice-teacher-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Invoice Teacher B"}', now(), now());

set local app.enrollment_claim = '1';

update public.profiles
set tenant_id = 'teacher-invoice-isolation-a',
    role = 'SCHOOL_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Invoice Admin A'
where id = 'e1000000-0000-4000-8000-000000000001';

update public.profiles
set tenant_id = 'teacher-invoice-isolation-a',
    role = 'TEACHER',
    lifecycle_status = 'active',
    full_name = 'Invoice Teacher A'
where id = 'e1000000-0000-4000-8000-000000000002';

update public.profiles
set tenant_id = 'teacher-invoice-isolation-a',
    role = 'TEACHER',
    lifecycle_status = 'active',
    full_name = 'Invoice Teacher Peer'
where id = 'e1000000-0000-4000-8000-000000000003';

update public.profiles
set tenant_id = 'teacher-invoice-isolation-b',
    role = 'SCHOOL_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Invoice Admin B'
where id = 'e1000000-0000-4000-8000-000000000004';

update public.profiles
set tenant_id = 'teacher-invoice-isolation-b',
    role = 'TEACHER',
    lifecycle_status = 'active',
    full_name = 'Invoice Teacher B'
where id = 'e1000000-0000-4000-8000-000000000005';

set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
)
values
  ('e1000000-0000-4000-8000-000000000001', 'teacher-invoice-isolation-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('e1000000-0000-4000-8000-000000000002', 'teacher-invoice-isolation-a', 'TEACHER', 'ACTIVE', true),
  ('e1000000-0000-4000-8000-000000000003', 'teacher-invoice-isolation-a', 'TEACHER', 'ACTIVE', true),
  ('e1000000-0000-4000-8000-000000000004', 'teacher-invoice-isolation-b', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('e1000000-0000-4000-8000-000000000005', 'teacher-invoice-isolation-b', 'TEACHER', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('e1000000-0000-4000-8000-000000000001', 'teacher-invoice-isolation-a'),
  ('e1000000-0000-4000-8000-000000000002', 'teacher-invoice-isolation-a'),
  ('e1000000-0000-4000-8000-000000000003', 'teacher-invoice-isolation-a'),
  ('e1000000-0000-4000-8000-000000000004', 'teacher-invoice-isolation-b'),
  ('e1000000-0000-4000-8000-000000000005', 'teacher-invoice-isolation-b')
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
  status,
  nf_link
)
values
  ('e2000000-0000-4000-8000-000000000001', 'teacher-invoice-isolation-a', 'e1000000-0000-4000-8000-000000000002', '2026-09', 20, 200, 'UNDER_REVIEW', null),
  ('e2000000-0000-4000-8000-000000000002', 'teacher-invoice-isolation-a', 'e1000000-0000-4000-8000-000000000003', '2026-09', 30, 300, 'UNDER_REVIEW', 'closings/e2000000-0000-4000-8000-000000000002/e3000000-0000-4000-8000-000000000002.pdf'),
  ('e2000000-0000-4000-8000-000000000003', 'teacher-invoice-isolation-b', 'e1000000-0000-4000-8000-000000000005', '2026-09', 40, 400, 'UNDER_REVIEW', 'closings/e2000000-0000-4000-8000-000000000003/e3000000-0000-4000-8000-000000000003.pdf');

insert into storage.objects (bucket_id, name, owner_id, metadata)
values
  ('invoices', 'closings/e2000000-0000-4000-8000-000000000002/e3000000-0000-4000-8000-000000000002.pdf', 'e1000000-0000-4000-8000-000000000003', '{"mimetype":"application/pdf","fixture":"peer"}'),
  ('invoices', 'closings/e2000000-0000-4000-8000-000000000003/e3000000-0000-4000-8000-000000000003.pdf', 'e1000000-0000-4000-8000-000000000005', '{"mimetype":"application/pdf","fixture":"foreign"}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}';

reset role;
update public.teacher_closings
set status = 'PENDENTE'
where id = 'e2000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select pg_temp.assert_access_denied(
  $command$insert into storage.objects (bucket_id, name, owner_id, metadata)
    values (
      'invoices',
      'closings/e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000004.pdf',
      'e1000000-0000-4000-8000-000000000002',
      '{"mimetype":"application/pdf","fixture":"unpaid"}'
    )$command$,
  'teacher uploaded invoice before the payout was available'
);

reset role;
update public.teacher_closings
set status = 'UNDER_REVIEW'
where id = 'e2000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}';

insert into storage.objects (bucket_id, name, owner_id, metadata)
values (
  'invoices',
  'closings/e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000001.pdf',
  'e1000000-0000-4000-8000-000000000002',
  '{"mimetype":"application/pdf","fixture":"own"}'
);

select public.teacher_attach_invoice(
  'e2000000-0000-4000-8000-000000000001',
  'closings/e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000001.pdf'
);

select pg_temp.assert_true(
  (select count(*) = 1 from public.teacher_closings)
  and (select count(*) = 1 from public.teacher_closings where teacher_id = 'e1000000-0000-4000-8000-000000000002')
  and (select count(*) = 0 from public.teacher_closings where teacher_id in ('e1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000005')),
  'teacher A saw a same-tenant or cross-tenant closing'
);

select pg_temp.assert_true(
  (select count(*) = 1 from public.teacher_closings where nf_link = 'closings/e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000001.pdf')
  and (select count(*) = 0 from public.teacher_closings where nf_link like '%e3000000-0000-4000-8000-000000000002.pdf' or nf_link like '%e3000000-0000-4000-8000-000000000003.pdf')
  and (select count(*) = 0 from public.teacher_closings where nf_link ~* '^https?://' or nf_link like '%token=%'),
  'teacher A received another teacher invoice URL'
);

select pg_temp.assert_true(
  (select count(*) = 1 from storage.objects where bucket_id = 'invoices' and name like '%e3000000-0000-4000-8000-000000000001.pdf')
  and (select count(*) = 0 from storage.objects where bucket_id = 'invoices' and name like '%e3000000-0000-4000-8000-000000000002.pdf')
  and (select count(*) = 0 from storage.objects where bucket_id = 'invoices' and name like '%e3000000-0000-4000-8000-000000000003.pdf'),
  'teacher A could authorize download of another teacher invoice object'
);

insert into storage.objects (bucket_id, name, owner_id, metadata)
values (
  'invoices',
  'closings/e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000005.pdf',
  'e1000000-0000-4000-8000-000000000002',
  '{"mimetype":"application/pdf","fixture":"unlinked-version"}'
);

select pg_temp.assert_true(
  (select count(*) = 0
   from storage.objects
   where bucket_id = 'invoices'
     and name = 'closings/e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000005.pdf'),
  'teacher A could read an unlinked or superseded invoice object'
);

do $$
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values (
    'invoices',
    'closings/e2000000-0000-4000-8000-000000000002/e3000000-0000-4000-8000-000000000004.pdf',
    'e1000000-0000-4000-8000-000000000002',
    '{"mimetype":"application/pdf","fixture":"forged-peer"}'
  );
  raise exception 'assertion failed: teacher A uploaded into a same-tenant peer closing';
exception
  when insufficient_privilege then null;
end;
$$;

select pg_temp.assert_true(
  (public.get_teacher_closing_report('e1000000-0000-4000-8000-000000000002', '2026-09')->'teacher'->>'id') = 'e1000000-0000-4000-8000-000000000002',
  'teacher A could not read the own payment report'
);

select pg_temp.assert_true(
  (public.get_teacher_activity_report('e1000000-0000-4000-8000-000000000002', '2026-09')->'teacher'->>'name') = 'Invoice Teacher A',
  'teacher A could not read the own activity report'
);

select pg_temp.assert_access_denied(
  $command$select public.get_teacher_closing_report('e1000000-0000-4000-8000-000000000003', '2026-09')$command$,
  'teacher A read a same-tenant peer payment report'
);

select pg_temp.assert_access_denied(
  $command$select public.get_teacher_activity_report('e1000000-0000-4000-8000-000000000003', '2026-09')$command$,
  'teacher A read a same-tenant peer activity report'
);

select pg_temp.assert_access_denied(
  $command$select public.get_teacher_closing_report('e1000000-0000-4000-8000-000000000005', '2026-09')$command$,
  'teacher A read a cross-tenant payment report'
);

select pg_temp.assert_access_denied(
  $command$select public.get_teacher_activity_report('e1000000-0000-4000-8000-000000000005', '2026-09')$command$,
  'teacher A read a cross-tenant activity report'
);

select pg_temp.assert_access_denied(
  $command$select public.teacher_attach_invoice('e2000000-0000-4000-8000-000000000002', 'closings/e2000000-0000-4000-8000-000000000002/e3000000-0000-4000-8000-000000000002.pdf')$command$,
  'teacher A attached an invoice to a same-tenant peer closing'
);

do $$
begin
  update public.teacher_closings
  set total_amount = 99999,
      nf_link = 'https://storage.invalid/tampered-peer.pdf'
  where id = 'e2000000-0000-4000-8000-000000000002';
exception
  when insufficient_privilege then null;
end;
$$;

do $$
begin
  update storage.objects
  set metadata = coalesce(metadata, '{}'::jsonb) || '{"tampered":true}'::jsonb
  where bucket_id = 'invoices'
    and name = 'closings/e2000000-0000-4000-8000-000000000002/e3000000-0000-4000-8000-000000000002.pdf';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;
set local request.jwt.claims = '{}';

select pg_temp.assert_true(
  (select total_amount = 300 and nf_link = 'closings/e2000000-0000-4000-8000-000000000002/e3000000-0000-4000-8000-000000000002.pdf'
   from public.teacher_closings
   where id = 'e2000000-0000-4000-8000-000000000002'),
  'teacher A changed a same-tenant peer closing'
);

select pg_temp.assert_true(
  not (select metadata ? 'tampered'
       from storage.objects
       where bucket_id = 'invoices'
         and name = 'closings/e2000000-0000-4000-8000-000000000002/e3000000-0000-4000-8000-000000000002.pdf'),
  'teacher A changed a same-tenant peer invoice object'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) = 2 from public.teacher_closings)
  and (select count(*) = 0 from public.teacher_closings where tenant_id = 'teacher-invoice-isolation-b')
  and (select count(*) = 2 from storage.objects where bucket_id = 'invoices')
  and (select count(*) = 0 from storage.objects where bucket_id = 'invoices' and name like '%foreign-invoice.pdf'),
  'tenant A admin lost same-tenant access or gained cross-tenant access'
);

select pg_temp.assert_true(
  (public.get_teacher_closing_report('e1000000-0000-4000-8000-000000000003', '2026-09')->'teacher'->>'id') = 'e1000000-0000-4000-8000-000000000003',
  'tenant A admin could not read a same-tenant teacher report'
);

select pg_temp.assert_true(
  (public.get_teacher_activity_report('e1000000-0000-4000-8000-000000000003', '2026-09')->'teacher'->>'name') = 'Invoice Teacher Peer',
  'tenant A admin could not read a same-tenant teacher activity report'
);

select pg_temp.assert_access_denied(
  $command$select public.get_teacher_closing_report('e1000000-0000-4000-8000-000000000005', '2026-09')$command$,
  'tenant A admin read a cross-tenant payment report'
);

select pg_temp.assert_access_denied(
  $command$select public.get_teacher_activity_report('e1000000-0000-4000-8000-000000000005', '2026-09')$command$,
  'tenant A admin read a cross-tenant activity report'
);

update public.teacher_closings
set admin_notes = 'reviewed by tenant A admin'
where id = 'e2000000-0000-4000-8000-000000000002';

select pg_temp.assert_true(
  (select admin_notes = 'reviewed by tenant A admin'
   from public.teacher_closings
   where id = 'e2000000-0000-4000-8000-000000000002'),
  'tenant A admin could not update a same-tenant closing'
);

reset role;
set local request.jwt.claims = '{}';
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select pg_temp.assert_no_visible_rows(
  $command$select count(*) from public.teacher_closings where id in ('e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000003')$command$,
  'anonymous user read invoice rows or signed URLs'
);

select pg_temp.assert_no_visible_rows(
  $command$select count(*) from storage.objects where bucket_id = 'invoices' and name like 'closings/e2000000-%'$command$,
  'anonymous user could authorize an invoice download'
);

select pg_temp.assert_access_denied(
  $command$select public.get_teacher_activity_report('e1000000-0000-4000-8000-000000000002', '2026-09')$command$,
  'anonymous user executed the teacher activity report'
);

select pg_temp.assert_access_denied(
  $command$insert into storage.objects (bucket_id, name, owner_id, metadata)
    values (
      'invoices',
      'closings/e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000006.pdf',
      null,
      '{"mimetype":"application/pdf","fixture":"anon"}'
    )$command$,
  'anonymous user inserted an invoice object'
);

update storage.objects
set metadata = coalesce(metadata, '{}'::jsonb) || '{"anon_tampered":true}'::jsonb
where bucket_id = 'invoices'
  and name = 'closings/e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000001.pdf';

reset role;
set local request.jwt.claims = '{}';

select pg_temp.assert_true(
  not (select metadata ? 'anon_tampered'
       from storage.objects
       where bucket_id = 'invoices'
         and name = 'closings/e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000001.pdf')
  and exists (
    select 1
    from storage.objects
    where bucket_id = 'invoices'
      and name = 'closings/e2000000-0000-4000-8000-000000000002/e3000000-0000-4000-8000-000000000002.pdf'
  ),
  'anonymous user updated or hid an invoice object'
);

select pg_temp.assert_true(
  (select total_amount = 400
          and nf_link = 'closings/e2000000-0000-4000-8000-000000000003/e3000000-0000-4000-8000-000000000003.pdf'
          and admin_notes is null
   from public.teacher_closings
   where id = 'e2000000-0000-4000-8000-000000000003'),
  'cross-tenant closing changed during isolation tests'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.teacher_closings
    where id in (
      'e2000000-0000-4000-8000-000000000001',
      'e2000000-0000-4000-8000-000000000002',
      'e2000000-0000-4000-8000-000000000003'
    )
      and (nf_link ~* '^https?://' or nf_link like '%token=%')
  ),
  'invoice rows persisted bearer URLs instead of private object paths'
);

rollback;
