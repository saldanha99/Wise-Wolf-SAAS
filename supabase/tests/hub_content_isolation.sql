\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $function$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$function$;

grant execute on function pg_temp.assert_true(boolean, text) to public;
do $$
begin
  if to_regprocedure('pg_temp.assert_sqlstate(text, text, text)') is not null then
    execute 'grant execute on function pg_temp.assert_sqlstate(text, text, text) to public';
  end if;
end
$$;

select pg_temp.assert_true(
  (
    select public is false
      and 'application/pdf' = any(allowed_mime_types)
      and not ('text/html' = any(allowed_mime_types))
    from storage.buckets
    where id = 'materials'
  ),
  'materials bucket is public or accepts unsafe HTML'
);

select pg_temp.assert_true(
  (
    select count(*) = 4
      and bool_and(permissive = 'PERMISSIVE')
      and bool_and(roles @> array['authenticated'::name])
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname in (
        'materials_tenant_read',
        'materials_tenant_insert',
        'materials_tenant_update',
        'materials_tenant_delete'
      )
  )
  and (
    select count(*) = 4
      and bool_and(permissive = 'RESTRICTIVE')
      and bool_and(roles = array['authenticated'::name])
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname in (
        'materials_private_read_guard',
        'materials_private_insert_guard',
        'materials_private_update_guard',
        'materials_private_delete_guard'
      )
  )
  and (
    select count(*) = 4
      and bool_and(permissive = 'RESTRICTIVE')
      and bool_and(roles = array['anon'::name])
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname in (
        'materials_private_anon_read_guard',
        'materials_private_anon_insert_guard',
        'materials_private_anon_update_guard',
        'materials_private_anon_delete_guard'
      )
  ),
  'materials policies are not restricted to authenticated tenant access'
);

select pg_temp.assert_true(
  has_column_privilege(
    'anon', 'public.hub_content_items', 'title', 'SELECT'
  )
  and has_column_privilege(
    'authenticated', 'public.hub_content_items', 'published_at', 'SELECT'
  )
  and has_column_privilege(
    'anon', 'public.hub_content_items', 'collection_id', 'SELECT'
  )
  and has_column_privilege(
    'authenticated', 'public.hub_content_items', 'part_number', 'SELECT'
  )
  and not has_column_privilege(
    'anon', 'public.hub_content_items', 'metadata', 'SELECT'
  )
  and not has_column_privilege(
    'anon', 'public.hub_content_items', 'source_material_id', 'SELECT'
  )
  and not has_column_privilege(
    'authenticated', 'public.hub_content_items', 'rights_basis', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.hub_content_assets', 'SELECT'
  ),
  'public catalog exposes internal metadata, rights, source or asset paths'
);

select pg_temp.assert_true(
  has_column_privilege(
    'anon', 'public.hub_collections', 'title', 'SELECT'
  )
  and has_column_privilege(
    'authenticated', 'public.hub_collections', 'display_order', 'SELECT'
  )
  and not has_table_privilege(
    'anon', 'public.hub_collections', 'INSERT'
  )
  and not has_table_privilege(
    'authenticated', 'public.hub_collections', 'UPDATE'
  ),
  'Hub collection catalog is unreadable or grants client-side writes'
);

select pg_temp.assert_true(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'private.hub_content_isolation_archive'::regclass
  )
  and not has_table_privilege(
    'anon', 'private.hub_content_isolation_archive', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'private.hub_content_isolation_archive', 'SELECT'
  )
  and (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'private.hub_material_storage_quarantine'::regclass
  )
  and not has_table_privilege(
    'authenticated', 'private.hub_material_storage_quarantine', 'SELECT'
  ),
  'recovery archives are not private and force-RLS protected'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'private.hub_guard_material_publication_consent()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.hub_actor_owns_namespaced_material_object(text,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.hub_material_object_has_provenance(text,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'private.hub_material_object_is_readable(text)',
    'EXECUTE'
  ),
  'private trigger functions are callable or storage predicate is unavailable'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.hub_validate_material_publication_sources(uuid,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_validate_material_publication_sources(uuid,text,text)',
    'EXECUTE'
  ),
  'publication source validator is not restricted to service role'
);

select pg_temp.assert_true(
  has_function_privilege(
    'authenticated', 'public.list_material_approvals()', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.review_material(uuid,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.list_material_approvals()', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.review_material(uuid,boolean,text)',
    'EXECUTE'
  ),
  'material review RPC privileges are broader than authenticated callers'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.hub_content_items
    where metadata ?| array[
      'tenantId',
      'tenant_id',
      'scope',
      'uploadedBy',
      'uploaded_by',
      'sourceMaterialId',
      'source_material_id'
    ]
  )
  and not exists (
    select 1
    from public.hub_content_assets as preview
    join public.hub_content_assets as full_asset
      on full_asset.content_id = preview.content_id
     and full_asset.asset_kind = 'FULL'
    where preview.asset_kind = 'PREVIEW'
      and (
        (
          preview.bucket_id = full_asset.bucket_id
          and preview.object_path = full_asset.object_path
        )
        or (
          preview.external_url is not null
          and preview.external_url = full_asset.external_url
        )
      )
  ),
  'sanitation left tenant metadata or a preview equal to FULL'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.pedagogical_materials as material
    where material.storage_object_path is not null
      and not private.hub_material_object_has_provenance(
        material.storage_object_path,
        material.tenant_id,
        material.uploaded_by
      )
  )
  and not exists (
    select 1
    from public.pedagogical_materials as material
    where material.hub_preview_source_path is not null
      and not private.hub_material_object_has_provenance(
        material.hub_preview_source_path,
        material.tenant_id,
        null
      )
  ),
  'sanitation authorized an object without proven owner and tenant provenance'
);

-- Simulate an unrelated legacy/dashboard policy that grants every storage
-- command. The restrictive materials guards must still enforce isolation.
create policy hub_content_test_overbroad_storage_access
on storage.objects
for all
to authenticated
using (true)
with check (true);

create policy hub_content_test_overbroad_anon_storage_read
on storage.objects
for select
to anon
using (true);

insert into public.tenants (id, name, slug, saas_status)
values
  ('hub-content-test-a', 'Hub Content Test A', 'hub-content-test-a', 'active'),
  ('hub-content-test-b', 'Hub Content Test B', 'hub-content-test-b', 'active');

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
  ('00000000-0000-4000-8000-00000000ca01', 'authenticated', 'authenticated', 'hub-admin-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Hub Admin A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000ca02', 'authenticated', 'authenticated', 'hub-teacher-a1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Hub Teacher A1"}', now(), now()),
  ('00000000-0000-4000-8000-00000000ca03', 'authenticated', 'authenticated', 'hub-teacher-a2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Hub Teacher A2"}', now(), now()),
  ('00000000-0000-4000-8000-00000000ca04', 'authenticated', 'authenticated', 'hub-student-assigned-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Hub Student Assigned A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000ca05', 'authenticated', 'authenticated', 'hub-student-unassigned-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Hub Student Unassigned A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cb01', 'authenticated', 'authenticated', 'hub-admin-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Hub Admin B"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cb02', 'authenticated', 'authenticated', 'hub-student-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Hub Student B"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cc01', 'authenticated', 'authenticated', 'hub-super-approver@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Hub Super Approver"}', now(), now());

set local app.enrollment_claim = '1';
update public.profiles
set tenant_id = 'hub-content-test-a',
    lifecycle_status = 'active',
    role = case id
      when '00000000-0000-4000-8000-00000000ca01' then 'SCHOOL_ADMIN'
      when '00000000-0000-4000-8000-00000000ca02' then 'TEACHER'
      when '00000000-0000-4000-8000-00000000ca03' then 'TEACHER'
      when '00000000-0000-4000-8000-00000000ca04' then 'STUDENT'
      when '00000000-0000-4000-8000-00000000ca05' then 'STUDENT'
      else role
    end
where id in (
  '00000000-0000-4000-8000-00000000ca01',
  '00000000-0000-4000-8000-00000000ca02',
  '00000000-0000-4000-8000-00000000ca03',
  '00000000-0000-4000-8000-00000000ca04',
  '00000000-0000-4000-8000-00000000ca05'
);
update public.profiles
set tenant_id = 'hub-content-test-b',
    lifecycle_status = 'active',
    role = case id
      when '00000000-0000-4000-8000-00000000cb01' then 'SCHOOL_ADMIN'
      else 'STUDENT'
    end
where id in (
  '00000000-0000-4000-8000-00000000cb01',
  '00000000-0000-4000-8000-00000000cb02'
);
update public.profiles
set tenant_id = 'hub-content-test-a',
    lifecycle_status = 'active',
    role = 'SUPER_ADMIN'
where id = '00000000-0000-4000-8000-00000000cc01';
set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
)
values
  ('00000000-0000-4000-8000-00000000ca01', 'hub-content-test-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000ca02', 'hub-content-test-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000ca03', 'hub-content-test-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000ca04', 'hub-content-test-a', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000ca05', 'hub-content-test-a', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cb01', 'hub-content-test-b', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cb02', 'hub-content-test-b', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cc01', 'hub-content-test-a', 'SCHOOL_ADMIN', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('00000000-0000-4000-8000-00000000ca01', 'hub-content-test-a'),
  ('00000000-0000-4000-8000-00000000ca02', 'hub-content-test-a'),
  ('00000000-0000-4000-8000-00000000ca03', 'hub-content-test-a'),
  ('00000000-0000-4000-8000-00000000ca04', 'hub-content-test-a'),
  ('00000000-0000-4000-8000-00000000ca05', 'hub-content-test-a'),
  ('00000000-0000-4000-8000-00000000cb01', 'hub-content-test-b'),
  ('00000000-0000-4000-8000-00000000cb02', 'hub-content-test-b'),
  ('00000000-0000-4000-8000-00000000cc01', 'hub-content-test-a')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

insert into storage.objects (bucket_id, name, owner_id, metadata)
values
  ('materials', '1711111111111.pdf', '00000000-0000-4000-8000-00000000ca02', '{"mimetype":"application/pdf"}'),
  ('materials', '1722222222222.pdf', '00000000-0000-4000-8000-00000000ca03', '{"mimetype":"application/pdf"}'),
  ('materials', 'materials/9999999999999.pdf', '00000000-0000-4000-8000-00000000ca02', '{"mimetype":"application/pdf"}'),
  ('materials', 'materials/1234567890123.html', '00000000-0000-4000-8000-00000000ca02', '{"mimetype":"text/html"}'),
  ('materials', 'materials/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf', '00000000-0000-4000-8000-00000000cb01', '{"mimetype":"application/pdf"}'),
  ('materials', 'hub-content-test-a/00000000-0000-4000-8000-00000000ca01/11111111-1111-4111-8111-111111111111.pdf', '00000000-0000-4000-8000-00000000ca01', '{"mimetype":"application/pdf"}'),
  ('materials', 'hub-content-test-a/00000000-0000-4000-8000-00000000ca01/22222222-2222-4222-8222-222222222222.pdf', '00000000-0000-4000-8000-00000000ca01', '{"mimetype":"application/pdf"}'),
  ('materials', 'hub-content-test-a/00000000-0000-4000-8000-00000000ca02/33333333-3333-4333-8333-333333333333.pdf', '00000000-0000-4000-8000-00000000ca02', '{"mimetype":"application/pdf"}'),
  ('materials', 'hub-content-test-a/00000000-0000-4000-8000-00000000ca02/44444444-4444-4444-8444-444444444444.pdf', '00000000-0000-4000-8000-00000000ca02', '{"mimetype":"application/pdf"}'),
  ('materials', 'hub-content-test-a/00000000-0000-4000-8000-00000000ca05/88888888-8888-4888-8888-888888888888.pdf', '00000000-0000-4000-8000-00000000ca05', '{"mimetype":"application/pdf"}'),
  ('materials', 'hub-content-test-b/00000000-0000-4000-8000-00000000cb01/55555555-5555-4555-8555-555555555555.pdf', '00000000-0000-4000-8000-00000000cb01', '{"mimetype":"application/pdf"}');

insert into public.pedagogical_materials (
  id,
  tenant_id,
  title,
  file_url,
  type,
  scope,
  uploaded_by,
  approval_status,
  storage_object_path
)
values
  ('30000000-0000-4000-8000-00000000da01', 'hub-content-test-a', 'Private Teacher A1', 'https://example.invalid/materials/1711111111111.pdf', 'PDF', 'PRIVATE', '00000000-0000-4000-8000-00000000ca02', 'APPROVED', '1711111111111.pdf'),
  ('30000000-0000-4000-8000-00000000da02', 'hub-content-test-a', 'Private Teacher A2', 'https://example.invalid/materials/1722222222222.pdf', 'PDF', 'PRIVATE', '00000000-0000-4000-8000-00000000ca03', 'APPROVED', '1722222222222.pdf'),
  ('30000000-0000-4000-8000-00000000da03', 'hub-content-test-a', 'Tenant A Commercial Candidate', 'https://example.invalid/materials/tenant-a-full.pdf', 'PDF', 'TENANT', '00000000-0000-4000-8000-00000000ca01', 'APPROVED', 'hub-content-test-a/00000000-0000-4000-8000-00000000ca01/11111111-1111-4111-8111-111111111111.pdf'),
  ('30000000-0000-4000-8000-00000000da04', 'hub-content-test-a', 'Pending Teacher A1', 'https://example.invalid/materials/pending-a1.pdf', 'PDF', 'PRIVATE', '00000000-0000-4000-8000-00000000ca02', 'PENDING', 'hub-content-test-a/00000000-0000-4000-8000-00000000ca02/33333333-3333-4333-8333-333333333333.pdf'),
  ('30000000-0000-4000-8000-00000000da05', 'hub-content-test-a', 'Forged Tenant B Reference', 'https://example.invalid/materials/forged-b.pdf', 'PDF', 'TENANT', '00000000-0000-4000-8000-00000000ca01', 'APPROVED', 'hub-content-test-b/00000000-0000-4000-8000-00000000cb01/55555555-5555-4555-8555-555555555555.pdf'),
  ('30000000-0000-4000-8000-00000000da06', 'hub-content-test-a', 'Legacy Student-Owned Material', 'https://example.invalid/materials/student-owned.pdf', 'PDF', 'PRIVATE', '00000000-0000-4000-8000-00000000ca05', 'APPROVED', 'hub-content-test-a/00000000-0000-4000-8000-00000000ca05/88888888-8888-4888-8888-888888888888.pdf'),
  ('30000000-0000-4000-8000-00000000da07', 'hub-content-test-a', 'Owned One-Folder Legacy Material', 'https://example.invalid/materials/9999999999999.pdf', 'PDF', 'PRIVATE', '00000000-0000-4000-8000-00000000ca02', 'APPROVED', 'materials/9999999999999.pdf'),
  ('30000000-0000-4000-8000-00000000da08', 'hub-content-test-a', 'Forged One-Folder Tenant B Reference', 'https://example.invalid/materials/forged-one-folder-b.pdf', 'PDF', 'TENANT', '00000000-0000-4000-8000-00000000ca01', 'APPROVED', 'materials/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf'),
  ('30000000-0000-4000-8000-00000000db01', 'hub-content-test-b', 'Tenant B Material', 'https://example.invalid/materials/tenant-b.pdf', 'PDF', 'TENANT', '00000000-0000-4000-8000-00000000cb01', 'APPROVED', 'hub-content-test-b/00000000-0000-4000-8000-00000000cb01/55555555-5555-4555-8555-555555555555.pdf'),
  ('30000000-0000-4000-8000-00000000db02', 'hub-content-test-b', 'Tenant B One-Folder Legacy Material', 'https://example.invalid/materials/tenant-b-one-folder.pdf', 'PDF', 'TENANT', '00000000-0000-4000-8000-00000000cb01', 'APPROVED', 'materials/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf'),
  ('30000000-0000-4000-8000-00000000db03', 'hub-content-test-b', 'Pending Tenant B Review', 'https://example.invalid/materials/pending-tenant-b.pdf', 'PDF', 'PRIVATE', '00000000-0000-4000-8000-00000000cb01', 'PENDING', null);

insert into public.student_assignments (student_id, material_id, assigned_by)
values (
  '00000000-0000-4000-8000-00000000ca04',
  '30000000-0000-4000-8000-00000000da01',
  '00000000-0000-4000-8000-00000000ca01'
);

select pg_temp.assert_true(
  private.hub_material_object_has_provenance(
    'materials/9999999999999.pdf',
    'hub-content-test-a',
    '00000000-0000-4000-8000-00000000ca02'
  )
  and not private.hub_material_object_has_provenance(
    'materials/1234567890123.html',
    'hub-content-test-a',
    '00000000-0000-4000-8000-00000000ca02'
  )
  and not private.hub_material_object_has_provenance(
    'materials/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf',
    'hub-content-test-a',
    '00000000-0000-4000-8000-00000000ca01'
  ),
  'one-folder legacy provenance did not bind owner and tenant'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ca02","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select count(*) = 1
    from storage.objects
    where bucket_id = 'materials'
      and name = '1711111111111.pdf'
  ),
  'legacy material owner cannot read the linked object'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
    from storage.objects
    where bucket_id = 'materials'
      and name = 'materials/9999999999999.pdf'
  ),
  'proven one-folder legacy material was unnecessarily quarantined'
);

do $teacher_cannot_publish$
begin
  update public.pedagogical_materials
  set hub_catalog_opt_in = true,
      hub_rights_basis = 'OWNED',
      hub_rights_declaration = 'The teacher claims commercial distribution rights.',
      hub_preview_source_path = 'hub-content-test-a/00000000-0000-4000-8000-00000000ca02/44444444-4444-4444-8444-444444444444.pdf'
  where id = '30000000-0000-4000-8000-00000000da04';
  raise exception 'assertion failed: teacher authorized commercial publication';
exception
  when insufficient_privilege then null;
end;
$teacher_cannot_publish$;

do $owned_material_cannot_be_remapped$
begin
  update public.pedagogical_materials
  set storage_object_path = 'hub-content-test-b/00000000-0000-4000-8000-00000000cb01/55555555-5555-4555-8555-555555555555.pdf'
  where id = '30000000-0000-4000-8000-00000000da04';
  raise exception 'assertion failed: material was remapped to a foreign object';
exception
  when insufficient_privilege then null;
end;
$owned_material_cannot_be_remapped$;

insert into storage.objects (bucket_id, name, owner_id, metadata)
values (
  'materials',
  'hub-content-test-a/00000000-0000-4000-8000-00000000ca02/66666666-6666-4666-8666-666666666666.pdf',
  '00000000-0000-4000-8000-00000000ca02',
  '{"mimetype":"application/pdf"}'
);

do $cross_tenant_upload_denied$
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values (
    'materials',
    'hub-content-test-b/00000000-0000-4000-8000-00000000ca02/77777777-7777-4777-8777-777777777777.pdf',
    '00000000-0000-4000-8000-00000000ca02',
    '{"mimetype":"application/pdf"}'
  );
  raise exception 'assertion failed: cross-tenant object upload succeeded';
exception
  when insufficient_privilege then null;
end;
$cross_tenant_upload_denied$;

reset role;
set local request.jwt.claims = '{}';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ca03","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select count(*) = 0
    from storage.objects
    where bucket_id = 'materials'
      and name = '1711111111111.pdf'
  )
  and (
    select count(*) = 1
    from storage.objects
    where bucket_id = 'materials'
      and name = '1722222222222.pdf'
  )
  and (
    select count(*) = 1
    from storage.objects
    where bucket_id = 'materials'
      and name = 'hub-content-test-a/00000000-0000-4000-8000-00000000ca01/11111111-1111-4111-8111-111111111111.pdf'
  )
  and (
    select count(*) = 0
    from storage.objects
    where bucket_id = 'materials'
      and name = 'materials/9999999999999.pdf'
  ),
  'teacher read another teacher private material or lost shared TENANT access'
);

reset role;
set local request.jwt.claims = '{}';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ca04","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select count(*) = 1
    from storage.objects
    where bucket_id = 'materials'
      and name = '1711111111111.pdf'
  ),
  'assigned student cannot read the approved legacy object'
);

reset role;
set local request.jwt.claims = '{}';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ca05","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select count(*) = 0
    from storage.objects
    where bucket_id = 'materials'
      and name = '1711111111111.pdf'
  ),
  'unassigned same-tenant student read a private material'
);

do $legacy_student_cannot_delete$
begin
  delete from storage.objects
  where bucket_id = 'materials'
    and name = 'hub-content-test-a/00000000-0000-4000-8000-00000000ca05/88888888-8888-4888-8888-888888888888.pdf';
exception
  when insufficient_privilege or raise_exception then null;
end;
$legacy_student_cannot_delete$;

select pg_temp.assert_true(
  (
    select count(*) = 1
    from storage.objects
    where bucket_id = 'materials'
      and name = 'hub-content-test-a/00000000-0000-4000-8000-00000000ca05/88888888-8888-4888-8888-888888888888.pdf'
  ),
  'legacy student uploader deleted a protected material object'
);

reset role;
set local request.jwt.claims = '{}';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000cb02","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select count(*) = 0
    from storage.objects
    where bucket_id = 'materials'
      and name in (
        '1711111111111.pdf',
        'hub-content-test-a/00000000-0000-4000-8000-00000000ca01/11111111-1111-4111-8111-111111111111.pdf'
      )
  ),
  'student from another tenant read tenant A objects'
);

reset role;
set local request.jwt.claims = '{}';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ca01","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select count(*) = 0
    from storage.objects
    where bucket_id = 'materials'
      and name in (
        'hub-content-test-b/00000000-0000-4000-8000-00000000cb01/55555555-5555-4555-8555-555555555555.pdf',
        'materials/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf'
      )
  ),
  'tenant A gained access by forging a tenant B storage_object_path'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from jsonb_array_elements(
      public.list_material_approvals() -> 'items'
    ) as item
    where item ->> 'id' = '30000000-0000-4000-8000-00000000db03'
  )
  and coalesce(
    (public.review_material(
      '30000000-0000-4000-8000-00000000db03',
      true,
      null
    ) ->> 'ok')::boolean,
    false
  ) is false,
  'tenant A listed or reviewed a tenant B material through RPC'
);

reset role;
set local request.jwt.claims = '{}';

update public.tenant_memberships
set status = 'SUSPENDED'
where user_id = '00000000-0000-4000-8000-00000000ca01'
  and tenant_id = 'hub-content-test-a';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ca01","role":"authenticated"}';

select pg_temp.assert_true(
  public.list_material_approvals() ->> 'error' = 'sem_permissao'
  and coalesce(
    (public.review_material(
      '30000000-0000-4000-8000-00000000da04',
      true,
      null
    ) ->> 'ok')::boolean,
    false
  ) is false,
  'suspended school admin retained material review privileges'
);

reset role;
set local request.jwt.claims = '{}';

update public.tenant_memberships
set status = 'ACTIVE'
where user_id = '00000000-0000-4000-8000-00000000ca01'
  and tenant_id = 'hub-content-test-a';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ca01","role":"authenticated"}';

update public.pedagogical_materials
set hub_catalog_opt_in = true,
    hub_rights_basis = 'OWNED',
    hub_rights_declaration = 'Wise Wolf School A created this content and owns distribution rights.',
    hub_preview_source_path = 'hub-content-test-a/00000000-0000-4000-8000-00000000ca01/22222222-2222-4222-8222-222222222222.pdf'
where id = '30000000-0000-4000-8000-00000000da03';

select pg_temp.assert_true(
  (
    select hub_catalog_opt_in
      and not hub_commercial_approved
      and hub_sync_status = 'RIGHTS_REVIEW_REQUIRED'
      and hub_publication_requested_by = '00000000-0000-4000-8000-00000000ca01'
    from public.pedagogical_materials
    where id = '30000000-0000-4000-8000-00000000da03'
  )
  and not exists (
    select 1
    from public.hub_content_items
    where slug = 'material-30000000-0000-4000-8000-00000000da03'
  ),
  'opt-in without central approval activated the commercial catalog'
);

do $preview_source_must_differ$
begin
  update public.pedagogical_materials
  set hub_preview_source_path = storage_object_path
  where id = '30000000-0000-4000-8000-00000000da03';
  raise exception 'assertion failed: preview source equals FULL source';
exception
  when check_violation then null;
end;
$preview_source_must_differ$;

do $school_admin_cannot_approve$
begin
  update public.pedagogical_materials
  set hub_commercial_approved = true
  where id = '30000000-0000-4000-8000-00000000da03';
  raise exception 'assertion failed: SCHOOL_ADMIN centrally approved material';
exception
  when insufficient_privilege then null;
end;
$school_admin_cannot_approve$;

reset role;
set local request.jwt.claims = '{}';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000cc01","role":"authenticated"}';

update public.pedagogical_materials
set hub_commercial_approved = true
where id = '30000000-0000-4000-8000-00000000da03';

select pg_temp.assert_true(
  (
    select hub_commercial_approved
      and hub_rights_verified_by = '00000000-0000-4000-8000-00000000cc01'
      and hub_rights_verified_by <> hub_publication_requested_by
      and hub_sync_status = 'PENDING'
    from public.pedagogical_materials
    where id = '30000000-0000-4000-8000-00000000da03'
  ),
  'second SUPER_ADMIN approval did not create an audited sync candidate'
);

reset role;
set local request.jwt.claims = '{}';

set local role service_role;

select pg_temp.assert_true(
  public.hub_validate_material_publication_sources(
    '30000000-0000-4000-8000-00000000da03',
    'hub-content-test-a/00000000-0000-4000-8000-00000000ca01/11111111-1111-4111-8111-111111111111.pdf',
    'hub-content-test-a/00000000-0000-4000-8000-00000000ca01/22222222-2222-4222-8222-222222222222.pdf'
  )
  and not public.hub_validate_material_publication_sources(
    '30000000-0000-4000-8000-00000000da05',
    'hub-content-test-b/00000000-0000-4000-8000-00000000cb01/55555555-5555-4555-8555-555555555555.pdf',
    'hub-content-test-a/00000000-0000-4000-8000-00000000ca01/22222222-2222-4222-8222-222222222222.pdf'
  ),
  'service source validator accepted a cross-tenant or unauthorized source'
);

reset role;

update public.pedagogical_materials
set hub_object_path = 'pedagogical/30000000-0000-4000-8000-00000000da03/full.pdf',
    hub_preview_object_path = 'pedagogical/30000000-0000-4000-8000-00000000da03/preview.pdf',
    hub_sync_status = 'SYNCED',
    hub_sync_error = null,
    hub_synced_at = now()
where id = '30000000-0000-4000-8000-00000000da03';

set constraints all immediate;

select pg_temp.assert_true(
  (
    select is_active
      and preview_enabled
      and catalog_scope = 'COMMERCIAL_GLOBAL'
      and rights_basis = 'OWNED'
      and not metadata ?| array[
        'tenantId',
        'tenant_id',
        'scope',
        'uploadedBy',
        'uploaded_by',
        'sourceMaterialId',
        'source_material_id'
      ]
    from public.hub_content_items
    where source_material_id = '30000000-0000-4000-8000-00000000da03'
  )
  and (
    select count(*) = 2
    from public.hub_content_assets as asset
    join public.hub_content_items as item on item.id = asset.content_id
    where item.source_material_id = '30000000-0000-4000-8000-00000000da03'
      and asset.asset_kind in ('FULL', 'PREVIEW')
  ),
  'approved material did not publish with an isolated asset pair'
);

do $catalog_preview_must_differ$
begin
  update public.hub_content_assets as preview
  set object_path = full_asset.object_path,
      bucket_id = full_asset.bucket_id
  from public.hub_content_assets as full_asset
  where preview.content_id = full_asset.content_id
    and preview.asset_kind = 'PREVIEW'
    and full_asset.asset_kind = 'FULL'
    and preview.content_id = (
      select id
      from public.hub_content_items
      where source_material_id = '30000000-0000-4000-8000-00000000da03'
    );
  raise exception 'assertion failed: catalog PREVIEW equals FULL';
exception
  when check_violation then null;
end;
$catalog_preview_must_differ$;

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select pg_temp.assert_true(
  (
    select count(*) = 0
    from storage.objects
    where bucket_id = 'materials'
  ),
  'anonymous broad policy bypassed the private materials guard'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.hub_content_items
    where id = (
      select id
      from public.hub_content_items
      where slug = 'material-30000000-0000-4000-8000-00000000da03'
    )
  ),
  'anon cannot read the safe published catalog row'
);

do $anon_cannot_read_metadata$
begin
  perform metadata
  from public.hub_content_items
  limit 1;
  raise exception 'assertion failed: anon read catalog metadata';
exception
  when insufficient_privilege then null;
end;
$anon_cannot_read_metadata$;

reset role;
set local request.jwt.claims = '{}';

rollback;
