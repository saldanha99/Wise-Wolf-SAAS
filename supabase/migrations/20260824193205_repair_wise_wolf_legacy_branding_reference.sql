begin;

create schema if not exists private;

create table if not exists private.tenant_branding_asset_repair_audit (
  tenant_id text not null,
  asset_kind text not null check (asset_kind in ('logo', 'favicon')),
  source_bucket text not null,
  source_object_name text not null,
  destination_bucket text not null,
  destination_object_name text not null,
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  tenant_before jsonb not null,
  source_object_before jsonb not null,
  destination_object_after jsonb not null,
  repaired_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, asset_kind)
);

alter table private.tenant_branding_asset_repair_audit enable row level security;
alter table private.tenant_branding_asset_repair_audit force row level security;
revoke all on table private.tenant_branding_asset_repair_audit
  from public, anon, authenticated, service_role;

do $copy_precondition$
begin
  if exists (
    select 1
    from public.tenants
    where id = 'school-wise-wolf'
      and split_part(
        split_part(
          branding ->> 'logoUrl',
          '/storage/v1/object/public/materials/',
          2
        ),
        '?',
        1
      ) = 'branding/school-wise-wolf/logo_1771521140668.png'
  ) and not exists (
    select 1
    from storage.objects
    where bucket_id = 'tenant-public-branding'
      and name =
        'school-wise-wolf/logo/09223c79-68b1-4e52-8961-ae3e924b9416.png'
      and metadata ->> 'mimetype' = 'image/png'
  ) then
    raise exception 'wise_wolf_branding_copy_required_before_reference_repair';
  end if;
end;
$copy_precondition$;

insert into private.tenant_branding_asset_repair_audit (
  tenant_id,
  asset_kind,
  source_bucket,
  source_object_name,
  destination_bucket,
  destination_object_name,
  source_sha256,
  tenant_before,
  source_object_before,
  destination_object_after
)
select
  tenant.id,
  'logo',
  'materials',
  source_object.name,
  'tenant-public-branding',
  destination_object.name,
  '319f94129f411ee39470901efb5548cc3ac83670ccbdb2771baa7865e6fc52f8',
  to_jsonb(tenant),
  to_jsonb(source_object),
  to_jsonb(destination_object)
from public.tenants as tenant
join storage.objects as source_object
  on source_object.bucket_id = 'materials'
 and source_object.name =
   'branding/school-wise-wolf/logo_1771521140668.png'
join storage.objects as destination_object
  on destination_object.bucket_id = 'tenant-public-branding'
 and destination_object.name =
   'school-wise-wolf/logo/09223c79-68b1-4e52-8961-ae3e924b9416.png'
where tenant.id = 'school-wise-wolf'
  and split_part(
    split_part(
      tenant.branding ->> 'logoUrl',
      '/storage/v1/object/public/materials/',
      2
    ),
    '?',
    1
  ) = source_object.name
  and source_object.metadata ->> 'mimetype' = 'image/png'
  and destination_object.metadata ->> 'mimetype' = 'image/png'
  and destination_object.metadata ->> 'size' =
    source_object.metadata ->> 'size'
on conflict (tenant_id, asset_kind) do nothing;

update public.tenants as tenant
set branding = jsonb_set(
  jsonb_set(
    coalesce(tenant.branding, '{}'::jsonb),
    '{logoPath}',
    to_jsonb(
      'school-wise-wolf/logo/09223c79-68b1-4e52-8961-ae3e924b9416.png'::text
    ),
    true
  ),
  '{logoUrl}',
  to_jsonb(
    'https://api.wisewolflanguage.com.br/storage/v1/object/public/tenant-public-branding/school-wise-wolf/logo/09223c79-68b1-4e52-8961-ae3e924b9416.png'::text
  ),
  true
)
where tenant.id = 'school-wise-wolf'
  and split_part(
    split_part(
      tenant.branding ->> 'logoUrl',
      '/storage/v1/object/public/materials/',
      2
    ),
    '?',
    1
  ) = 'branding/school-wise-wolf/logo_1771521140668.png'
  and exists (
    select 1
    from private.tenant_branding_asset_repair_audit as audit
    where audit.tenant_id = tenant.id
      and audit.asset_kind = 'logo'
      and audit.destination_object_name =
        'school-wise-wolf/logo/09223c79-68b1-4e52-8961-ae3e924b9416.png'
  );

comment on table private.tenant_branding_asset_repair_audit is
  'Private before/after snapshots for verified tenant branding asset repairs.';

commit;
