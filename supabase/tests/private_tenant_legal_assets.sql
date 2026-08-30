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

select pg_temp.assert_true(
  (select not public from storage.buckets where id = 'tenant-branding')
  and (select public from storage.buckets where id = 'tenant-public-branding')
  and (select not public and file_size_limit = 1048576
       from storage.buckets where id = 'tenant-legal-assets'),
  'bucket legado ou juridico permaneceu publico'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname in (
        'tenant_branding_admin_read',
        'tenant_branding_admin_delete'
      )
  )
  and not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname in (
        'tenant_branding_admin_insert',
        'tenant_branding_admin_update'
      )
  ),
  'bucket legado aceita novo upload ou nao preserva backup administrativo'
);

select pg_temp.assert_true(
  (
    select count(*) = 4
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname like 'tenant_legal_assets_admin_%'
      and roles::text = '{authenticated}'
      and position(
        '_my_tenant_id' in coalesce(qual, '') || coalesce(with_check, '')
      ) > 0
      and position(
        'legal-representative-signature' in
        coalesce(qual, '') || coalesce(with_check, '')
      ) > 0
  ),
  'policy do bucket juridico nao esta isolada por tenant/pasta'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.get_offer_public(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_invite_offer_public(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_contract_public(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.get_offer_public(uuid)',
    'EXECUTE'
  ),
  'resolver SQL ainda entrega snapshot juridico direto ao cliente'
);

select pg_temp.assert_true(
  private.legal_snapshot_is_private(
    jsonb_build_object(
      'legalRepresentativeSignaturePath',
      'legal-school-a/legal-representative-signature/00000000-0000-4000-8000-000000000021.png'
    ),
    'legal-school-a'
  )
  and not private.legal_snapshot_is_private(
    jsonb_build_object(
      'legalRepresentativeSignaturePath',
      'legal-school-b/legal-representative-signature/00000000-0000-4000-8000-000000000021.png'
    ),
    'legal-school-a'
  )
  and not private.legal_snapshot_is_private(
    jsonb_build_object(
      'legalRepresentativeSignaturePath',
      'legal-school-a/signature/00000000-0000-4000-8000-000000000021.png'
    ),
    'legal-school-a'
  )
  and not private.legal_snapshot_is_private(
    jsonb_build_object(
      'legalRepresentativeSignatureUrl',
      'https://cdn.example.invalid/signature.png'
    ),
    'legal-school-a'
  ),
  'validador aceitou URL publica, legado ou caminho cross-tenant'
);

insert into public.tenants (id, name, slug, saas_status, school_info)
values (
  'legal-school-a',
  'Legal School A',
  'legal-school-a',
  'active',
  jsonb_build_object(
    'legalName', 'Legal School A LTDA',
    'cnpj', '04.252.011/0001-10',
    'address', 'Rua Segura, 100',
    'email', 'legal@example.invalid',
    'phone', '11999999999',
    'city', 'Sao Paulo',
    'state', 'SP',
    'legalRepresentativeName', 'Representante A',
    'legalRepresentativeSignaturePath',
      'legal-school-a/legal-representative-signature/00000000-0000-4000-8000-000000000021.png'
  )
);

select pg_temp.assert_true(
  private.contract_school_info('legal-school-a')
    ->> 'legalRepresentativeSignaturePath'
      = 'legal-school-a/legal-representative-signature/00000000-0000-4000-8000-000000000021.png'
  and not (
    private.contract_school_info('legal-school-a') ?|
      array[
        'legalRepresentativeSignatureUrl',
        'directorSignatureUrl',
        'signatureUrl'
      ]
  ),
  'snapshot contratual nao manteve somente o path privado'
);

do $$
begin
  update public.tenants
  set school_info = school_info || jsonb_build_object(
    'legalRepresentativeSignatureUrl',
    'https://api.example.invalid/storage/v1/object/public/tenant-branding/legal-school-a/signature/00000000-0000-4000-8000-000000000021.png'
  )
  where id = 'legal-school-a';
  raise exception 'assertion failed: URL publica foi persistida no tenant';
exception when check_violation then null;
end;
$$;

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.tenants'::regclass
      and conname = 'tenants_legal_signature_must_be_private'
      and convalidated
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.offers'::regclass
      and conname = 'offers_legal_signature_private'
      and convalidated
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.tenant_contract_records'::regclass
      and conname = 'tenant_contract_records_legal_signature_private'
      and convalidated
  ),
  'constraints de assinatura privada nao foram validadas'
);

rollback;
