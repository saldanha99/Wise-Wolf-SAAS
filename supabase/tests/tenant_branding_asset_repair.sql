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
    where oid = 'private.tenant_branding_asset_repair_audit'::regclass
  )
  and not has_table_privilege(
    'anon', 'private.tenant_branding_asset_repair_audit', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'private.tenant_branding_asset_repair_audit', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'private.tenant_branding_asset_repair_audit', 'SELECT'
  ),
  'tenant branding repair audit is exposed to a client role'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.tenants
    where coalesce(branding ->> 'logoUrl', '') like
      '%/storage/v1/object/public/materials/%'
  ),
  'a tenant logo still points to the private materials bucket'
);

select pg_temp.assert_true(
  (
    select public is true
    from storage.buckets
    where id = 'tenant-public-branding'
  ),
  'tenant public branding bucket is not public'
);

rollback;
