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

select pg_temp.assert_true(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'private.hub_material_storage_repair_audit'::regclass
  )
  and not has_table_privilege(
    'anon',
    'private.hub_material_storage_repair_audit',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'private.hub_material_storage_repair_audit',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'private.hub_material_storage_repair_audit',
    'SELECT'
  ),
  'material repair audit is exposed to a client role'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from private.hub_material_storage_repair_audit as audit
    join public.pedagogical_materials as material
      on material.id = audit.material_id
    join storage.objects as object
      on object.id = audit.storage_object_id
    join private.hub_material_storage_quarantine as quarantine
      on quarantine.id = audit.quarantine_id
    where material.storage_object_path is distinct from audit.object_name
      or object.bucket_id <> 'materials'
      or object.name is distinct from audit.object_name
      or object.owner is distinct from audit.uploader_id
      or object.owner_id is distinct from audit.uploader_id::text
      or quarantine.resolution is distinct from
        'VERIFIED_LEGACY_OWNER_RESTORED'
      or quarantine.resolved_at is null
      or not private.hub_material_object_has_provenance(
        audit.object_name,
        audit.tenant_id,
        audit.uploader_id
      )
  ),
  'an audited material repair is incomplete'
);

select pg_temp.assert_true(
  (
    select public is false
    from storage.buckets
    where id = 'materials'
  ),
  'materials bucket became public during reconciliation'
);

rollback;
