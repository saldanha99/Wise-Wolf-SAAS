-- Hub commercial catalog hardening.
--
-- Pedagogical approval is intentionally independent from commercial
-- publication. A school material remains tenant/private unless a current
-- SCHOOL_ADMIN (or SUPER_ADMIN) explicitly opts in, attests the distribution
-- rights and supplies a separate preview object.

begin;

create schema if not exists private;

-- Stop the legacy auto-publication path before any backfill can fire it. On a
-- replay this also suspends the hardened triggers until sanitation completes.
drop trigger if exists hub_mark_pedagogical_material_for_sync
  on public.pedagogical_materials;
drop trigger if exists hub_a_guard_material_sync_fields
  on public.pedagogical_materials;
drop trigger if exists hub_b_guard_material_publication_consent
  on public.pedagogical_materials;
drop trigger if exists hub_c_mark_pedagogical_material_for_sync
  on public.pedagogical_materials;
drop trigger if exists hub_sync_pedagogical_material_catalog
  on public.pedagogical_materials;
drop trigger if exists hub_content_assets_distinct_preview_full
  on public.hub_content_assets;
drop trigger if exists hub_content_items_require_asset_pair
  on public.hub_content_items;
drop trigger if exists hub_content_assets_preserve_asset_pair
  on public.hub_content_assets;

alter table public.pedagogical_materials
  add column if not exists storage_object_path text,
  add column if not exists hub_preview_source_path text,
  add column if not exists hub_preview_object_path text,
  add column if not exists hub_catalog_opt_in boolean not null default false,
  add column if not exists hub_commercial_approved boolean not null default false,
  add column if not exists hub_rights_basis text,
  add column if not exists hub_rights_declaration text,
  add column if not exists hub_publication_requested_by uuid
    references auth.users(id) on delete set null,
  add column if not exists hub_publication_requested_at timestamptz,
  add column if not exists hub_rights_verified_by uuid
    references auth.users(id) on delete set null,
  add column if not exists hub_rights_verified_at timestamptz,
  add column if not exists hub_publication_revoked_by uuid
    references auth.users(id) on delete set null,
  add column if not exists hub_publication_revoked_at timestamptz;

alter table public.hub_content_items
  add column if not exists catalog_scope text not null
    default 'COMMERCIAL_GLOBAL',
  add column if not exists rights_basis text;

create or replace function private.hub_material_url_object_name(
  source_url text
)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $function$
  select nullif(
    case
      when position(
        '/storage/v1/object/public/materials/' in source_url
      ) > 0 then split_part(
        split_part(
          source_url,
          '/storage/v1/object/public/materials/',
          2
        ),
        '?',
        1
      )
      when position(
        '/storage/v1/object/authenticated/materials/' in source_url
      ) > 0 then split_part(
        split_part(
          source_url,
          '/storage/v1/object/authenticated/materials/',
          2
        ),
        '?',
        1
      )
      else null
    end,
    ''
  );
$function$;

create or replace function private.hub_material_object_has_provenance(
  object_name text,
  material_tenant_id text,
  legacy_owner_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select object_name is not null
    and material_tenant_id is not null
    and exists (
      select 1
      from storage.objects as object
      join public.profiles as owner_profile
        on owner_profile.id::text = object.owner_id
       and owner_profile.tenant_id = material_tenant_id
      where object.bucket_id = 'materials'
        and object.name = object_name
        and (
          (
            coalesce(cardinality(storage.foldername(object_name)), 0) = 0
            and legacy_owner_id is not null
            and object.owner_id = legacy_owner_id::text
            and storage.filename(object_name) ~
              '^[0-9]{10,20}[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
          )
          or (
            cardinality(storage.foldername(object_name)) = 1
            and (storage.foldername(object_name))[1] = 'materials'
            and legacy_owner_id is not null
            and object.owner_id = legacy_owner_id::text
            and storage.filename(object_name) ~
              '^([0-9]{10,20}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
          )
          or (
            cardinality(storage.foldername(object_name)) = 2
            and (storage.foldername(object_name))[1] = material_tenant_id
            and (storage.foldername(object_name))[2] = object.owner_id
            and storage.filename(object_name) ~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
          )
        )
    );
$function$;

-- The synchronization Edge Function runs with service-role privileges, so it
-- cannot rely on Storage RLS while copying source objects. This service-only
-- predicate binds the requested material and both source paths to proven
-- objects in the same tenant before any bytes are copied to the Hub catalog.
create or replace function public.hub_validate_material_publication_sources(
  p_material_id uuid,
  p_full_source_path text,
  p_preview_source_path text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.pedagogical_materials as material
    where material.id = p_material_id
      and material.tenant_id is not null
      and material.approval_status = 'APPROVED'
      and upper(coalesce(material.type, '')) <> 'LINK'
      and material.hub_catalog_opt_in is true
      and material.hub_commercial_approved is true
      and material.hub_publication_requested_by is not null
      and material.hub_publication_requested_at is not null
      and material.hub_rights_verified_by is not null
      and material.hub_rights_verified_at is not null
      and material.hub_rights_verified_by
        <> material.hub_publication_requested_by
      and material.hub_rights_basis in (
        'OWNED', 'LICENSED', 'PUBLIC_DOMAIN'
      )
      and char_length(btrim(coalesce(
        material.hub_rights_declaration,
        ''
      ))) between 20 and 2000
      and material.storage_object_path = p_full_source_path
      and material.hub_preview_source_path = p_preview_source_path
      and p_full_source_path <> p_preview_source_path
      and private.hub_material_object_has_provenance(
        p_full_source_path,
        material.tenant_id,
        material.uploaded_by
      )
      and private.hub_material_object_has_provenance(
        p_preview_source_path,
        material.tenant_id,
        null
      )
  );
$function$;

create table if not exists private.hub_material_storage_quarantine (
  id bigint generated always as identity primary key,
  material_id uuid not null,
  reference_kind text not null check (
    reference_kind in ('FULL_CURRENT', 'FULL_URL', 'PREVIEW')
  ),
  object_name text not null,
  reason text not null,
  material_snapshot jsonb not null,
  quarantined_at timestamptz not null default now(),
  unique (material_id, reference_kind, object_name)
);

alter table private.hub_material_storage_quarantine enable row level security;
alter table private.hub_material_storage_quarantine force row level security;
revoke all on table private.hub_material_storage_quarantine
  from public, anon, authenticated;
revoke all on sequence private.hub_material_storage_quarantine_id_seq
  from public, anon, authenticated;

insert into private.hub_material_storage_quarantine (
  material_id,
  reference_kind,
  object_name,
  reason,
  material_snapshot
)
select
  material.id,
  reference.reference_kind,
  reference.object_name,
  'OBJECT_OWNERSHIP_OR_TENANT_UNPROVEN',
  to_jsonb(material)
from public.pedagogical_materials as material
cross join lateral (
  values
    ('FULL_CURRENT', material.storage_object_path, material.uploaded_by),
    (
      'FULL_URL',
      private.hub_material_url_object_name(material.file_url),
      material.uploaded_by
    ),
    ('PREVIEW', material.hub_preview_source_path, null::uuid)
) as reference(reference_kind, object_name, legacy_owner_id)
where reference.object_name is not null
  and not private.hub_material_object_has_provenance(
    reference.object_name,
    material.tenant_id,
    reference.legacy_owner_id
  )
on conflict (material_id, reference_kind, object_name) do nothing;

with candidates as (
  select
    material.id,
    case
      when private.hub_material_object_has_provenance(
        material.storage_object_path,
        material.tenant_id,
        material.uploaded_by
      ) then material.storage_object_path
      when private.hub_material_object_has_provenance(
        private.hub_material_url_object_name(material.file_url),
        material.tenant_id,
        material.uploaded_by
      ) then private.hub_material_url_object_name(material.file_url)
      else null
    end as full_object_path,
    case
      when private.hub_material_object_has_provenance(
        material.hub_preview_source_path,
        material.tenant_id,
        null
      ) then material.hub_preview_source_path
      else null
    end as preview_object_path
  from public.pedagogical_materials as material
), authorized_candidates as (
  select
    candidate.*,
    candidate.full_object_path is not null
      and candidate.preview_object_path is not null
      and candidate.full_object_path <> candidate.preview_object_path
      as publication_sources_are_valid
  from candidates as candidate
)
update public.pedagogical_materials as material
set storage_object_path = candidate.full_object_path,
    hub_preview_source_path = candidate.preview_object_path,
    hub_catalog_opt_in = material.hub_catalog_opt_in
      and candidate.publication_sources_are_valid,
    hub_commercial_approved = material.hub_commercial_approved
      and candidate.publication_sources_are_valid,
    hub_rights_verified_by = case
      when candidate.publication_sources_are_valid
        then material.hub_rights_verified_by
      else null
    end,
    hub_rights_verified_at = case
      when candidate.publication_sources_are_valid
        then material.hub_rights_verified_at
      else null
    end
from authorized_candidates as candidate
where candidate.id = material.id
  and (
    material.storage_object_path is distinct from candidate.full_object_path
    or material.hub_preview_source_path
      is distinct from candidate.preview_object_path
    or (
      not candidate.publication_sources_are_valid
      and (
        material.hub_catalog_opt_in
        or material.hub_commercial_approved
        or material.hub_rights_verified_by is not null
        or material.hub_rights_verified_at is not null
      )
    )
  );

create index if not exists pedagogical_materials_storage_object_path_idx
  on public.pedagogical_materials(storage_object_path)
  where storage_object_path is not null;

create index if not exists pedagogical_materials_hub_preview_source_path_idx
  on public.pedagogical_materials(hub_preview_source_path)
  where hub_preview_source_path is not null;

create index if not exists pedagogical_materials_hub_publication_queue_idx
  on public.pedagogical_materials(
    hub_catalog_opt_in,
    approval_status,
    hub_sync_status,
    created_at
  )
  where hub_catalog_opt_in is true;

-- Private, append-only recovery snapshot. This preserves the pre-hardening
-- rows before metadata, publication state or unsafe preview references change.
create table if not exists private.hub_content_isolation_archive (
  id bigint generated always as identity primary key,
  material_id uuid,
  content_id uuid not null,
  reason text not null,
  material_snapshot jsonb,
  item_snapshot jsonb not null,
  assets_snapshot jsonb not null default '[]'::jsonb,
  archived_at timestamptz not null default now(),
  unique (content_id, reason)
);

alter table private.hub_content_isolation_archive enable row level security;
alter table private.hub_content_isolation_archive force row level security;
revoke all on table private.hub_content_isolation_archive
  from public, anon, authenticated;
revoke all on sequence private.hub_content_isolation_archive_id_seq
  from public, anon, authenticated;

insert into private.hub_content_isolation_archive (
  material_id,
  content_id,
  reason,
  material_snapshot,
  item_snapshot,
  assets_snapshot
)
select
  item.source_material_id,
  item.id,
  'pre_secure_hub_content_isolation',
  case when material.id is null then null else to_jsonb(material) end,
  to_jsonb(item),
  coalesce(asset.assets_snapshot, '[]'::jsonb)
from public.hub_content_items as item
left join public.pedagogical_materials as material
  on material.id = item.source_material_id
left join lateral (
  select jsonb_agg(to_jsonb(content_asset) order by content_asset.asset_kind)
    as assets_snapshot
  from public.hub_content_assets as content_asset
  where content_asset.content_id = item.id
) as asset on true
where item.source_material_id is not null
   or item.metadata ?| array[
     'tenantId', 'tenant_id', 'scope', 'uploadedBy', 'uploaded_by'
   ]
   or item.rights_verified_at is null
   or nullif(btrim(item.license_summary), '') is null
   or not exists (
     select 1
     from public.hub_content_assets as full_asset
     where full_asset.content_id = item.id
       and full_asset.asset_kind = 'FULL'
   )
   or not exists (
     select 1
     from public.hub_content_assets as preview
     where preview.content_id = item.id
       and preview.asset_kind = 'PREVIEW'
   )
   or exists (
     select 1
     from public.hub_content_assets as preview
     join public.hub_content_assets as full_asset
       on full_asset.content_id = preview.content_id
      and full_asset.asset_kind = 'FULL'
     where preview.content_id = item.id
       and preview.asset_kind = 'PREVIEW'
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
   )
on conflict (content_id, reason) do nothing;

-- Tenant identifiers and school-library scope are not commercial catalog
-- metadata. The private archive above retains the original values for audit.
update public.hub_content_items
set metadata = metadata - array[
      'tenantId',
      'tenant_id',
      'scope',
      'uploadedBy',
      'uploaded_by',
      'sourceMaterialId',
      'source_material_id'
    ],
    updated_at = now()
where metadata ?| array[
  'tenantId',
  'tenant_id',
  'scope',
  'uploadedBy',
  'uploaded_by',
  'sourceMaterialId',
  'source_material_id'
];

-- A manually curated catalog row with a prior explicit rights verification may
-- retain its publication. Automated pedagogical rows never inherit the old,
-- synthetic rights timestamp.
update public.hub_content_items
set rights_basis = 'LICENSED',
    catalog_scope = 'COMMERCIAL_GLOBAL',
    updated_at = now()
where source_material_id is null
  and coalesce(metadata ->> 'source', '') not in (
    'pedagogical_materials',
    'curated_pedagogical_material'
  )
  and rights_basis is null
  and rights_verified_at is not null
  and nullif(btrim(license_summary), '') is not null;

update public.hub_content_items
set is_active = false,
    preview_enabled = false,
    published_at = null,
    rights_verified_at = null,
    rights_basis = null,
    license_summary = null,
    updated_at = now()
where source_material_id is not null
  and not exists (
    select 1
    from public.pedagogical_materials as authorized_material
    where authorized_material.id = hub_content_items.source_material_id
      and authorized_material.hub_catalog_opt_in is true
      and authorized_material.hub_commercial_approved is true
      and authorized_material.hub_rights_verified_at is not null
  );

-- Remove only the unsafe PREVIEW reference. The original object and FULL
-- reference remain untouched, and the deleted row is recoverable from archive.
delete from public.hub_content_assets as preview
using public.hub_content_assets as full_asset
where preview.content_id = full_asset.content_id
  and preview.asset_kind = 'PREVIEW'
  and full_asset.asset_kind = 'FULL'
  and (
    (
      preview.bucket_id = full_asset.bucket_id
      and preview.object_path = full_asset.object_path
    )
    or (
      preview.external_url is not null
      and preview.external_url = full_asset.external_url
    )
  );

update public.hub_content_items as item
set is_active = false,
    preview_enabled = false,
    published_at = null,
    updated_at = now()
where not exists (
    select 1
    from public.hub_content_assets as preview
    where preview.content_id = item.id
      and preview.asset_kind = 'PREVIEW'
  );

update public.hub_content_items as item
set is_active = false,
    preview_enabled = false,
    published_at = null,
    updated_at = now()
where item.catalog_scope <> 'COMMERCIAL_GLOBAL'
   or item.rights_basis not in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
   or item.rights_verified_at is null
   or nullif(btrim(item.license_summary), '') is null
   or not exists (
     select 1
     from public.hub_content_assets as full_asset
     where full_asset.content_id = item.id
       and full_asset.asset_kind = 'FULL'
	   );

-- A replay must also fail closed for partially populated consent rows created
-- by an interrupted or older rollout.
update public.pedagogical_materials
set hub_catalog_opt_in = false,
    hub_commercial_approved = false
where hub_catalog_opt_in is true
  and (
    approval_status <> 'APPROVED'
    or upper(coalesce(type, '')) = 'LINK'
    or storage_object_path is null
    or hub_preview_source_path is null
    or storage_object_path = hub_preview_source_path
    or hub_rights_basis not in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
    or char_length(btrim(coalesce(hub_rights_declaration, '')))
      not between 20 and 2000
    or hub_publication_requested_by is null
    or hub_publication_requested_at is null
  );

update public.pedagogical_materials
set hub_commercial_approved = false
where hub_commercial_approved is true
  and (
    hub_catalog_opt_in is false
    or hub_rights_verified_by is null
    or hub_rights_verified_at is null
    or hub_rights_verified_by = hub_publication_requested_by
  );

alter table public.pedagogical_materials
  alter column hub_sync_status set default 'CONSENT_REQUIRED';

alter table public.pedagogical_materials
  drop constraint if exists pedagogical_materials_hub_sync_status_check;
alter table public.pedagogical_materials
  add constraint pedagogical_materials_hub_sync_status_check
  check (
    hub_sync_status in (
      'CONSENT_REQUIRED',
      'RIGHTS_REVIEW_REQUIRED',
      'PENDING',
      'SYNCING',
      'SYNCED',
      'FAILED',
      'NOT_APPLICABLE'
    )
  );

update public.pedagogical_materials
set hub_sync_status = 'CONSENT_REQUIRED',
    hub_sync_error = null,
    hub_synced_at = null
where hub_catalog_opt_in is false
   or approval_status <> 'APPROVED';

alter table public.pedagogical_materials
  drop constraint if exists pedagogical_materials_hub_rights_basis_check;
alter table public.pedagogical_materials
  add constraint pedagogical_materials_hub_rights_basis_check
  check (
    hub_rights_basis is null
    or hub_rights_basis in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
  );

alter table public.pedagogical_materials
  drop constraint if exists pedagogical_materials_storage_object_path_check;
alter table public.pedagogical_materials
  add constraint pedagogical_materials_storage_object_path_check
  check (
    storage_object_path is null
    or (
      storage_object_path !~ '(^|/)[.][.]?(/|$)'
      and storage_object_path !~ '^/'
      and octet_length(storage_object_path) between 3 and 1024
    )
  );

alter table public.pedagogical_materials
  drop constraint if exists pedagogical_materials_hub_preview_source_path_check;
alter table public.pedagogical_materials
  add constraint pedagogical_materials_hub_preview_source_path_check
  check (
    hub_preview_source_path is null
    or (
      hub_preview_source_path !~ '(^|/)[.][.]?(/|$)'
      and hub_preview_source_path !~ '^/'
      and octet_length(hub_preview_source_path) between 3 and 1024
    )
  );

alter table public.pedagogical_materials
  drop constraint if exists pedagogical_materials_hub_publication_consent_check;
alter table public.pedagogical_materials
  add constraint pedagogical_materials_hub_publication_consent_check
  check (
    hub_catalog_opt_in is false
    or (
      approval_status = 'APPROVED'
      and upper(coalesce(type, '')) <> 'LINK'
      and storage_object_path is not null
      and hub_preview_source_path is not null
      and storage_object_path <> hub_preview_source_path
      and hub_rights_basis in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
      and char_length(btrim(coalesce(hub_rights_declaration, '')))
        between 20 and 2000
      and hub_publication_requested_by is not null
      and hub_publication_requested_at is not null
    )
  );

alter table public.pedagogical_materials
  drop constraint if exists pedagogical_materials_hub_commercial_approval_check;
alter table public.pedagogical_materials
  add constraint pedagogical_materials_hub_commercial_approval_check
  check (
    hub_commercial_approved is false
    or (
      hub_catalog_opt_in is true
      and hub_rights_verified_by is not null
      and hub_rights_verified_at is not null
      and hub_rights_verified_by <> hub_publication_requested_by
    )
  );

alter table public.hub_content_items
  drop constraint if exists hub_content_items_catalog_scope_check;
alter table public.hub_content_items
  add constraint hub_content_items_catalog_scope_check
  check (catalog_scope = 'COMMERCIAL_GLOBAL');

alter table public.hub_content_items
  drop constraint if exists hub_content_items_rights_basis_check;
alter table public.hub_content_items
  add constraint hub_content_items_rights_basis_check
  check (
    rights_basis is null
    or rights_basis in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
  );

alter table public.hub_content_items
  drop constraint if exists hub_content_items_publication_integrity_check;
alter table public.hub_content_items
  add constraint hub_content_items_publication_integrity_check
  check (
    (is_active is false and published_at is null)
    or (
      catalog_scope = 'COMMERCIAL_GLOBAL'
      and rights_basis in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
      and rights_verified_at is not null
      and nullif(btrim(license_summary), '') is not null
    )
  );

alter table public.hub_content_items
  drop constraint if exists hub_content_items_metadata_is_public_check;
alter table public.hub_content_items
  add constraint hub_content_items_metadata_is_public_check
  check (
    not metadata ?| array[
      'tenantId',
      'tenant_id',
      'scope',
      'uploadedBy',
      'uploaded_by',
      'sourceMaterialId',
      'source_material_id'
    ]
  );

create unique index if not exists hub_content_assets_delivery_object_unique
  on public.hub_content_assets(content_id, bucket_id, object_path)
  where asset_kind in ('PREVIEW', 'FULL');

create unique index if not exists hub_content_assets_delivery_external_unique
  on public.hub_content_assets(content_id, external_url)
  where asset_kind in ('PREVIEW', 'FULL')
    and external_url is not null;

create or replace function private.hub_actor_owns_namespaced_material_object(
  object_name text,
  actor_id uuid,
  actor_tenant_id text
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select actor_id is not null
    and actor_tenant_id is not null
    and cardinality(storage.foldername(object_name)) = 2
    and (storage.foldername(object_name))[1] = actor_tenant_id
    and (storage.foldername(object_name))[2] = actor_id::text
    and storage.filename(object_name) ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
    and exists (
      select 1
      from storage.objects as object
      where object.bucket_id = 'materials'
        and object.name = object_name
        and object.owner_id = actor_id::text
    );
$function$;

create or replace function private.hub_guard_material_sync_fields()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.hub_object_path := null;
    new.hub_preview_object_path := null;
    new.hub_sync_error := null;
    new.hub_synced_at := null;
    return new;
  end if;

  if new.hub_object_path is distinct from old.hub_object_path
     or new.hub_preview_object_path is distinct from old.hub_preview_object_path
     or new.hub_sync_status is distinct from old.hub_sync_status
     or new.hub_sync_error is distinct from old.hub_sync_error
     or new.hub_synced_at is distinct from old.hub_synced_at then
    raise exception 'hub_sync_fields_are_service_managed'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

create or replace function private.hub_guard_material_publication_consent()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  actor_id uuid := (select auth.uid());
  actor_role text;
  actor_tenant_id text;
  consent_changed boolean;
  authorization_changed boolean;
  source_changed boolean;
  storage_object_changed boolean;
  preview_source_changed boolean;
begin
  consent_changed := tg_op = 'INSERT'
    or new.hub_catalog_opt_in is distinct from old.hub_catalog_opt_in
    or new.hub_rights_basis is distinct from old.hub_rights_basis
    or new.hub_rights_declaration is distinct from old.hub_rights_declaration
    or new.hub_preview_source_path is distinct from old.hub_preview_source_path;

  authorization_changed := consent_changed
    or new.hub_commercial_approved
       is distinct from old.hub_commercial_approved
    or new.hub_rights_verified_by is distinct from old.hub_rights_verified_by
    or new.hub_rights_verified_at is distinct from old.hub_rights_verified_at;

  source_changed := tg_op = 'UPDATE' and (
    new.storage_object_path is distinct from old.storage_object_path
    or new.file_url is distinct from old.file_url
    or new.type is distinct from old.type
    or (
      old.approval_status = 'APPROVED'
      and new.approval_status <> 'APPROVED'
    )
  );

  storage_object_changed := new.storage_object_path is not null and (
    tg_op = 'INSERT'
    or new.storage_object_path is distinct from old.storage_object_path
  );
  preview_source_changed := new.hub_preview_source_path is not null and (
    tg_op = 'INSERT'
    or new.hub_preview_source_path is distinct from old.hub_preview_source_path
  );

  -- SQL migrations and service-role jobs may curate directly, but still have to
  -- satisfy the table integrity constraint. Browser callers always have uid().
  if actor_id is null then
    return new;
  end if;

  actor_role := public._my_role();
  actor_tenant_id := public._my_tenant_id();

  if storage_object_changed and not private.hub_actor_owns_namespaced_material_object(
    new.storage_object_path,
    actor_id,
    actor_tenant_id
  ) then
    raise exception 'material_storage_object_must_be_owned_and_namespaced'
      using errcode = '42501';
  end if;

  if preview_source_changed and not private.hub_actor_owns_namespaced_material_object(
    new.hub_preview_source_path,
    actor_id,
    actor_tenant_id
  ) then
    raise exception 'material_preview_object_must_be_owned_and_namespaced'
      using errcode = '42501';
  end if;

  if source_changed and old.hub_catalog_opt_in is true
     and not authorization_changed then
    new.hub_catalog_opt_in := false;
    new.hub_commercial_approved := false;
    new.hub_rights_verified_by := null;
    new.hub_rights_verified_at := null;
    new.hub_publication_revoked_by := actor_id;
    new.hub_publication_revoked_at := now();
    return new;
  end if;

  if not authorization_changed then
    return new;
  end if;

  if actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    if new.hub_catalog_opt_in is true
       or new.hub_commercial_approved is true
       or new.hub_rights_basis is not null
       or new.hub_rights_declaration is not null
       or new.hub_preview_source_path is not null then
      raise exception 'hub_publication_requires_school_admin'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if actor_role <> 'SUPER_ADMIN'
     and new.tenant_id is distinct from actor_tenant_id then
    raise exception 'hub_publication_cross_tenant_denied'
      using errcode = '42501';
  end if;

  if new.hub_catalog_opt_in is true then
    if new.approval_status <> 'APPROVED'
       or upper(coalesce(new.type, '')) = 'LINK'
       or new.storage_object_path is null
       or new.hub_preview_source_path is null
       or new.storage_object_path = new.hub_preview_source_path
       or not private.hub_material_object_has_provenance(
         new.storage_object_path,
         new.tenant_id,
         new.uploaded_by
       )
       or not private.hub_material_object_has_provenance(
         new.hub_preview_source_path,
         new.tenant_id,
         null
       )
       or new.hub_rights_basis not in (
         'OWNED', 'LICENSED', 'PUBLIC_DOMAIN'
       )
       or char_length(btrim(coalesce(new.hub_rights_declaration, '')))
          not between 20 and 2000 then
      raise exception 'hub_publication_requirements_incomplete'
        using errcode = '23514';
    end if;

    if consent_changed then
      new.hub_publication_requested_by := actor_id;
      new.hub_publication_requested_at := now();
      new.hub_commercial_approved := false;
      new.hub_rights_verified_by := null;
      new.hub_rights_verified_at := null;
    end if;
    new.hub_publication_revoked_by := null;
    new.hub_publication_revoked_at := null;

    if new.hub_commercial_approved is true then
      if actor_role <> 'SUPER_ADMIN' then
        raise exception 'hub_commercial_approval_requires_super_admin'
          using errcode = '42501';
      end if;
      if new.hub_publication_requested_by = actor_id then
        raise exception 'hub_commercial_approval_requires_second_actor'
          using errcode = '42501';
      end if;
      new.hub_rights_verified_by := actor_id;
      new.hub_rights_verified_at := now();
    elsif actor_role <> 'SUPER_ADMIN'
       and (
         new.hub_rights_verified_by is not null
         or new.hub_rights_verified_at is not null
       ) then
      raise exception 'hub_rights_verification_requires_super_admin'
        using errcode = '42501';
    else
      new.hub_rights_verified_by := null;
      new.hub_rights_verified_at := null;
    end if;
  elsif tg_op = 'UPDATE' and old.hub_catalog_opt_in is true then
    new.hub_commercial_approved := false;
    new.hub_rights_verified_by := null;
    new.hub_rights_verified_at := null;
    new.hub_publication_revoked_by := actor_id;
    new.hub_publication_revoked_at := now();
  end if;

  return new;
end;
$function$;

create or replace function private.hub_mark_pedagogical_material_for_sync()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
begin
  if new.hub_catalog_opt_in is false
     or new.approval_status <> 'APPROVED' then
    new.hub_sync_status := 'CONSENT_REQUIRED';
    new.hub_sync_error := null;
    new.hub_synced_at := null;
    return new;
  end if;

  if new.hub_commercial_approved is false
     or new.hub_rights_verified_by is null
     or new.hub_rights_verified_at is null then
    new.hub_sync_status := 'RIGHTS_REVIEW_REQUIRED';
    new.hub_sync_error := null;
    new.hub_synced_at := null;
    return new;
  end if;

  if upper(coalesce(new.type, '')) = 'LINK'
     or new.storage_object_path is null
     or new.hub_preview_source_path is null
     or new.storage_object_path = new.hub_preview_source_path then
    new.hub_sync_status := 'NOT_APPLICABLE';
    new.hub_sync_error := 'HUB_PUBLICATION_SOURCE_INVALID';
    new.hub_synced_at := null;
    return new;
  end if;

  if tg_op = 'INSERT'
     or new.file_url is distinct from old.file_url
     or new.storage_object_path is distinct from old.storage_object_path
     or new.hub_preview_source_path is distinct from old.hub_preview_source_path
     or new.approval_status is distinct from old.approval_status
     or new.type is distinct from old.type
     or new.hub_catalog_opt_in is distinct from old.hub_catalog_opt_in
     or new.hub_commercial_approved
        is distinct from old.hub_commercial_approved
     or new.hub_rights_basis is distinct from old.hub_rights_basis
     or new.hub_rights_declaration is distinct from old.hub_rights_declaration
     or new.hub_rights_verified_at is distinct from old.hub_rights_verified_at
     or new.title is distinct from old.title
     or new.level_tag is distinct from old.level_tag
     or new.category is distinct from old.category
     or new.niche is distinct from old.niche
     or new.collection_id is distinct from old.collection_id
     or new.part_number is distinct from old.part_number then
    if tg_op = 'INSERT'
       or new.storage_object_path is distinct from old.storage_object_path
       or new.file_url is distinct from old.file_url
       or new.type is distinct from old.type then
      new.hub_object_path := null;
    end if;
    if tg_op = 'INSERT'
       or new.hub_preview_source_path
          is distinct from old.hub_preview_source_path then
      new.hub_preview_object_path := null;
    end if;
    new.hub_sync_status := 'PENDING';
    new.hub_sync_error := null;
    new.hub_synced_at := null;
  end if;

  return new;
end;
$function$;

-- These RPCs previously trusted profiles.tenant_id directly. Binding them to
-- the active membership/context prevents a removed or suspended school admin
-- from listing or reviewing material through SECURITY DEFINER privileges.
create or replace function public.list_material_approvals()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_role text := public._my_role();
  actor_tenant_id text := public._my_tenant_id();
  result jsonb;
begin
  if actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
     or actor_tenant_id is null
     or not public._my_tenant_is_operational() then
    return jsonb_build_object(
      'error', 'sem_permissao',
      'pending_count', 0,
      'items', '[]'::jsonb
    );
  end if;

  select jsonb_build_object(
    'pending_count', (
      select count(*)
      from public.pedagogical_materials as pending_material
      where pending_material.tenant_id = actor_tenant_id
        and pending_material.approval_status = 'PENDING'
    ),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', material.id,
          'title', material.title,
          'type', material.type,
          'level_tag', material.level_tag,
          'category', material.category,
          'niche', material.niche,
          'file_url', material.file_url,
          'status', material.approval_status,
          'created_at', material.created_at,
          'author', (
            select profile.full_name
            from public.profiles as profile
            where profile.id = material.uploaded_by
          )
        )
        order by
          (material.approval_status = 'PENDING') desc,
          material.created_at desc
      )
      from (
        select scoped_material.*
        from public.pedagogical_materials as scoped_material
        where scoped_material.tenant_id = actor_tenant_id
          and scoped_material.approval_status in ('PENDING', 'REJECTED')
        order by scoped_material.created_at desc
        limit 80
      ) as material
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

create or replace function public.review_material(
  p_id uuid,
  p_approve boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_role text := public._my_role();
  actor_tenant_id text := public._my_tenant_id();
  affected_rows integer;
begin
  if p_id is null or p_approve is null then
    return jsonb_build_object('ok', false, 'error', 'entrada_invalida');
  end if;

  if actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
     or actor_tenant_id is null
     or not public._my_tenant_is_operational() then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  if p_approve then
    update public.pedagogical_materials as material
       set approval_status = 'APPROVED',
           scope = 'TENANT',
           reviewed_by = (select auth.uid()),
           reviewed_at = now(),
           rejection_reason = null
     where material.id = p_id
       and material.tenant_id = actor_tenant_id;
  else
    update public.pedagogical_materials as material
       set approval_status = 'REJECTED',
           reviewed_by = (select auth.uid()),
           reviewed_at = now(),
           rejection_reason = nullif(
             left(btrim(coalesce(p_reason, '')), 2000),
             ''
           )
     where material.id = p_id
       and material.tenant_id = actor_tenant_id;
  end if;

  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    return jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function private.hub_sync_pedagogical_material_catalog()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  item_id uuid;
  collection_title text;
  material_author text;
  commercial_type text;
  commercial_description text;
  public_license_summary text;
begin
  if tg_op = 'DELETE' then
    update public.hub_content_items
       set is_active = false,
           preview_enabled = false,
           published_at = null,
           updated_at = now()
     where source_material_id = old.id;
    return old;
  end if;

  if new.approval_status <> 'APPROVED'
     or new.hub_catalog_opt_in is false
     or new.hub_commercial_approved is false
     or new.hub_rights_basis not in (
       'OWNED', 'LICENSED', 'PUBLIC_DOMAIN'
     )
     or new.hub_rights_verified_at is null
     or nullif(btrim(new.hub_rights_declaration), '') is null
     or new.hub_sync_status <> 'SYNCED'
     or new.hub_object_path is null
     or new.hub_preview_object_path is null
     or new.hub_object_path = new.hub_preview_object_path then
    update public.hub_content_items
       set is_active = false,
           preview_enabled = false,
           published_at = null,
           updated_at = now()
     where source_material_id = new.id;
    return new;
  end if;

  select collection.title
    into collection_title
  from public.pedagogical_collections as collection
  where collection.id = new.collection_id
    and collection.tenant_id = new.tenant_id;

  select profile.full_name
    into material_author
  from public.profiles as profile
  where profile.id = new.uploaded_by;

  commercial_type := case upper(coalesce(new.type, 'PDF'))
    when 'PDF' then 'PDF'
    when 'VIDEO' then 'VIDEO'
    when 'AUDIO' then 'AUDIO'
    else 'ACTIVITY'
  end;
  commercial_description := concat_ws(
    ' · ',
    nullif(btrim(coalesce(new.category, '')), ''),
    case
      when new.part_number is not null
        then 'Parte ' || new.part_number::text
      else null
    end
  );
  public_license_summary := case new.hub_rights_basis
    when 'OWNED' then
      'Conteúdo próprio com distribuição autorizada no Wise Wolf Hub.'
    when 'PUBLIC_DOMAIN' then
      'Conteúdo de domínio público verificado para distribuição.'
    else
      'Conteúdo licenciado com distribuição autorizada no Wise Wolf Hub.'
  end;

  insert into public.hub_content_items (
    slug,
    title,
    description,
    content_type,
    level_tag,
    niche,
    collection_name,
    preview_enabled,
    license_summary,
    author_name,
    rights_verified_at,
    rights_basis,
    catalog_scope,
    published_at,
    is_active,
    source_material_id,
    metadata
  ) values (
    'material-' || new.id::text,
    new.title,
    nullif(commercial_description, ''),
    commercial_type,
    case
      when new.level_tag in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
        then new.level_tag
      else null
    end,
    coalesce(nullif(new.niche, ''), 'GENERAL'),
    collection_title,
    true,
    public_license_summary,
    material_author,
    new.hub_rights_verified_at,
    new.hub_rights_basis,
    'COMMERCIAL_GLOBAL',
    now(),
    true,
    new.id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'source', 'curated_pedagogical_material',
        'partNumber', new.part_number
      )
    )
  )
  on conflict (source_material_id) where source_material_id is not null
  do update set
    title = excluded.title,
    description = excluded.description,
    content_type = excluded.content_type,
    level_tag = excluded.level_tag,
    niche = excluded.niche,
    collection_name = excluded.collection_name,
    preview_enabled = true,
    license_summary = excluded.license_summary,
    author_name = excluded.author_name,
    rights_verified_at = excluded.rights_verified_at,
    rights_basis = excluded.rights_basis,
    catalog_scope = excluded.catalog_scope,
    published_at = now(),
    is_active = true,
    metadata = excluded.metadata,
    updated_at = now()
  returning id into item_id;

  insert into public.hub_content_assets (
    content_id,
    asset_kind,
    bucket_id,
    object_path,
    external_url
  ) values
    (
      item_id,
      'FULL',
      'hub-library',
      new.hub_object_path,
      null
    ),
    (
      item_id,
      'PREVIEW',
      'hub-library',
      new.hub_preview_object_path,
      null
    )
  on conflict (content_id, asset_kind) do update set
    bucket_id = excluded.bucket_id,
    object_path = excluded.object_path,
    external_url = null;

  return new;
end;
$function$;

create or replace function private.hub_enforce_distinct_content_assets()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.asset_kind not in ('PREVIEW', 'FULL') then
    return new;
  end if;

  if exists (
    select 1
    from public.hub_content_assets as sibling
    where sibling.content_id = new.content_id
      and sibling.asset_kind in ('PREVIEW', 'FULL')
      and sibling.asset_kind <> new.asset_kind
      and sibling.id <> new.id
      and (
        (
          sibling.bucket_id = new.bucket_id
          and sibling.object_path = new.object_path
        )
        or (
          sibling.external_url is not null
          and sibling.external_url = new.external_url
        )
      )
  ) then
    raise exception 'hub_preview_must_be_distinct_from_full_asset'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

create or replace function private.hub_content_has_isolated_asset_pair(
  item_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.hub_content_assets as full_asset
    join public.hub_content_assets as preview
      on preview.content_id = full_asset.content_id
     and preview.asset_kind = 'PREVIEW'
    where full_asset.content_id = item_id
      and full_asset.asset_kind = 'FULL'
      and (
        preview.bucket_id <> full_asset.bucket_id
        or preview.object_path <> full_asset.object_path
      )
      and (
        preview.external_url is null
        or full_asset.external_url is null
        or preview.external_url <> full_asset.external_url
      )
  );
$function$;

create or replace function private.hub_enforce_catalog_asset_pair()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item_id uuid;
begin
  if tg_table_name = 'hub_content_items' then
    item_id := new.id;
  else
    item_id := coalesce(new.content_id, old.content_id);
  end if;

  if exists (
    select 1
    from public.hub_content_items as item
    where item.id = item_id
      and item.is_active is true
      and item.preview_enabled is true
      and item.published_at is not null
  ) and not private.hub_content_has_isolated_asset_pair(item_id) then
    raise exception 'active_hub_content_requires_isolated_full_and_preview_assets'
      using errcode = '23514';
  end if;

  return null;
end;
$function$;

create trigger hub_a_guard_material_sync_fields
before insert or update of
  hub_object_path,
  hub_preview_object_path,
  hub_sync_status,
  hub_sync_error,
  hub_synced_at
on public.pedagogical_materials
for each row execute function private.hub_guard_material_sync_fields();

create trigger hub_b_guard_material_publication_consent
before insert or update of
  hub_catalog_opt_in,
  hub_commercial_approved,
  hub_rights_basis,
  hub_rights_declaration,
  hub_preview_source_path,
  storage_object_path,
  file_url,
  type,
  approval_status,
  hub_rights_verified_by,
  hub_rights_verified_at
on public.pedagogical_materials
for each row execute function private.hub_guard_material_publication_consent();

create trigger hub_c_mark_pedagogical_material_for_sync
before insert or update of
  title,
  file_url,
  storage_object_path,
  hub_preview_source_path,
  approval_status,
  type,
  level_tag,
  category,
  niche,
  collection_id,
  part_number,
  hub_catalog_opt_in,
  hub_commercial_approved,
  hub_rights_basis,
  hub_rights_declaration,
  hub_rights_verified_at
on public.pedagogical_materials
for each row execute function private.hub_mark_pedagogical_material_for_sync();

create trigger hub_sync_pedagogical_material_catalog
after insert or update of
  title,
  type,
  level_tag,
  category,
  niche,
  approval_status,
  collection_id,
  part_number,
  hub_catalog_opt_in,
  hub_commercial_approved,
  hub_rights_basis,
  hub_rights_declaration,
  hub_rights_verified_at,
  hub_object_path,
  hub_preview_object_path,
  hub_sync_status
on public.pedagogical_materials
for each row execute function private.hub_sync_pedagogical_material_catalog();

create trigger hub_content_assets_distinct_preview_full
before insert or update of
  content_id,
  asset_kind,
  bucket_id,
  object_path,
  external_url
on public.hub_content_assets
for each row execute function private.hub_enforce_distinct_content_assets();

create constraint trigger hub_content_items_require_asset_pair
after insert or update
on public.hub_content_items
deferrable initially deferred
for each row execute function private.hub_enforce_catalog_asset_pair();

create constraint trigger hub_content_assets_preserve_asset_pair
after insert or update or delete
on public.hub_content_assets
deferrable initially deferred
for each row execute function private.hub_enforce_catalog_asset_pair();

-- Public catalog reads only commercially authorized global rows. Direct asset
-- paths remain unavailable to anon/authenticated.
drop policy if exists hub_content_items_public_catalog
  on public.hub_content_items;
create policy hub_content_items_public_catalog
  on public.hub_content_items
  for select
  to anon, authenticated
  using (
    catalog_scope = 'COMMERCIAL_GLOBAL'
    and rights_basis in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
    and rights_verified_at is not null
    and nullif(btrim(license_summary), '') is not null
    and is_active is true
    and published_at is not null
    and published_at <= now()
    and preview_enabled is true
  );

revoke select on table public.hub_content_items from anon, authenticated;
grant select (
  id,
  slug,
  title,
  description,
  content_type,
  level_tag,
  niche,
  collection_name,
  cover_url,
  preview_enabled,
  license_summary,
  author_name,
  published_at,
  is_active
) on public.hub_content_items to anon, authenticated;

-- Private source bucket. Public buckets bypass download RLS, therefore the
-- bucket flag itself must be false in addition to the policies below.
insert into storage.buckets (
  id,
  name,
  public,
  allowed_mime_types
)
values (
  'materials',
  'materials',
  false,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'audio/mpeg',
    'audio/wav'
  ]::text[]
)
on conflict (id) do update set
  public = false,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.hub_material_object_is_readable(
  object_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.pedagogical_materials as material
      where material.storage_object_path = object_name
      and private.hub_material_object_has_provenance(
        object_name,
        material.tenant_id,
        material.uploaded_by
      )
      and (
        (
          (
            material.scope = 'GLOBAL'
            or material.is_global is true
          )
          and material.approval_status = 'APPROVED'
        )
        or (
          material.tenant_id = public._my_tenant_id()
          and public._my_tenant_is_operational()
          and (
            (
              public._my_role() = 'STUDENT'
              and material.approval_status = 'APPROVED'
              and exists (
                select 1
                from public.student_assignments as assignment
                where assignment.material_id = material.id
                  and assignment.student_id = (select auth.uid())
              )
            )
            or (
              public._my_role() <> 'STUDENT'
              and (
                material.uploaded_by = (select auth.uid())
                or public._my_role() in (
                  'SCHOOL_ADMIN',
                  'COORDINATOR',
                  'MANAGER',
                  'SUPER_ADMIN'
                )
                or (
                  public._my_role() = 'TEACHER'
                  and material.scope = 'TENANT'
                  and material.approval_status = 'APPROVED'
                )
              )
            )
          )
        )
      )
    );
$function$;

create or replace function private.hub_material_object_is_manageable(
  object_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and public._my_tenant_is_operational()
    and public._my_role() in (
      'TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
    )
    and exists (
      select 1
      from public.pedagogical_materials as material
      where material.tenant_id = public._my_tenant_id()
        and (
          (
            material.storage_object_path = object_name
            and private.hub_material_object_has_provenance(
              object_name,
              material.tenant_id,
              material.uploaded_by
            )
          )
          or (
            material.hub_preview_source_path = object_name
            and private.hub_material_object_has_provenance(
              object_name,
              material.tenant_id,
              null
            )
          )
        )
        and (
          material.uploaded_by = (select auth.uid())
          or public._my_role() in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
          )
        )
    );
$function$;

do $block$
declare
  policy_row record;
begin
  for policy_row in
    select policyname
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        policyname in (
          'Full Access Materials b9j0vg_0',
          'Full Access Materials b9j0vg_1',
          'Full Access Materials b9j0vg_2',
          'Full Access Materials b9j0vg_3',
          'Allow authenticated uploads',
          'Authenticated Upload to Materials',
          'Public Access to Materials',
          'Give public access to materials',
          'materials_admin_write',
          'materials_tenant_select',
          'materials_public_read',
          'materials_staff_insert',
          'materials_staff_update',
          'materials_staff_delete',
          'materials_tenant_read',
          'materials_tenant_insert',
          'materials_tenant_update',
          'materials_tenant_delete',
          'materials_private_read_guard',
          'materials_private_insert_guard',
          'materials_private_update_guard',
          'materials_private_delete_guard',
          'materials_private_anon_read_guard',
          'materials_private_anon_insert_guard',
          'materials_private_anon_update_guard',
          'materials_private_anon_delete_guard'
        )
        or position(
          '''materials''::text'
          in coalesce(qual, '') || ' ' || coalesce(with_check, '')
        ) > 0
      )
  loop
    execute format(
      'drop policy %I on storage.objects',
      policy_row.policyname
    );
  end loop;
end;
$block$;

create policy materials_tenant_read
on storage.objects
for select
to authenticated
using (
  bucket_id = 'materials'
  and (
    (
      cardinality(storage.foldername(name)) = 2
      and (storage.foldername(name))[1] = public._my_tenant_id()
      and (storage.foldername(name))[2] = (select auth.uid())::text
      and owner_id = (select auth.uid())::text
      and public._my_tenant_is_operational()
    )
    or private.hub_material_object_is_readable(name)
    or private.hub_material_object_is_manageable(name)
  )
);

create policy materials_tenant_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'materials'
  and cardinality(storage.foldername(name)) = 2
  and (storage.foldername(name))[1] = public._my_tenant_id()
  and (storage.foldername(name))[2] = (select auth.uid())::text
  and storage.filename(name) ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
  and owner_id = (select auth.uid())::text
  and public._my_role() in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
  and public._my_tenant_is_operational()
);

create policy materials_tenant_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'materials'
  and (
    (
      cardinality(storage.foldername(name)) = 2
      and (storage.foldername(name))[1] = public._my_tenant_id()
      and (storage.foldername(name))[2] = (select auth.uid())::text
      and owner_id = (select auth.uid())::text
      and public._my_role() in (
        'TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
      )
      and public._my_tenant_is_operational()
    )
    or private.hub_material_object_is_manageable(name)
  )
)
with check (
  bucket_id = 'materials'
  and cardinality(storage.foldername(name)) = 2
  and (storage.foldername(name))[1] = public._my_tenant_id()
  and (storage.foldername(name))[2] = (select auth.uid())::text
  and storage.filename(name) ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
  and owner_id = (select auth.uid())::text
  and public._my_role() in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
  and public._my_tenant_is_operational()
);

create policy materials_tenant_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'materials'
  and (
    (
      cardinality(storage.foldername(name)) = 2
      and (storage.foldername(name))[1] = public._my_tenant_id()
      and (storage.foldername(name))[2] = (select auth.uid())::text
      and owner_id = (select auth.uid())::text
      and public._my_role() in (
        'TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
      )
      and public._my_tenant_is_operational()
    )
    or private.hub_material_object_is_manageable(name)
  )
);

-- RLS policies for the same command are permissive (OR) by default. These
-- restrictive guards make the materials boundary survive an old or future
-- broad storage.objects policy without affecting rows from other buckets.
create policy materials_private_read_guard
on storage.objects
as restrictive
for select
to authenticated
using (
  bucket_id <> 'materials'
  or (
    (select auth.uid()) is not null
    and (
      (
        cardinality(storage.foldername(name)) = 2
        and (storage.foldername(name))[1] = public._my_tenant_id()
        and (storage.foldername(name))[2] = (select auth.uid())::text
        and owner_id = (select auth.uid())::text
        and public._my_tenant_is_operational()
      )
      or private.hub_material_object_is_readable(name)
      or private.hub_material_object_is_manageable(name)
    )
  )
);

create policy materials_private_insert_guard
on storage.objects
as restrictive
for insert
to authenticated
with check (
  bucket_id <> 'materials'
  or (
    cardinality(storage.foldername(name)) = 2
    and (storage.foldername(name))[1] = public._my_tenant_id()
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and storage.filename(name) ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
    and owner_id = (select auth.uid())::text
    and public._my_role() in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
    and public._my_tenant_is_operational()
  )
);

create policy materials_private_update_guard
on storage.objects
as restrictive
for update
to authenticated
using (
  bucket_id <> 'materials'
  or (
    (select auth.uid()) is not null
    and public._my_role() in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
    and (
      (
        cardinality(storage.foldername(name)) = 2
        and (storage.foldername(name))[1] = public._my_tenant_id()
        and (storage.foldername(name))[2] = (select auth.uid())::text
        and owner_id = (select auth.uid())::text
        and public._my_tenant_is_operational()
      )
      or private.hub_material_object_is_manageable(name)
    )
  )
)
with check (
  bucket_id <> 'materials'
  or (
    cardinality(storage.foldername(name)) = 2
    and (storage.foldername(name))[1] = public._my_tenant_id()
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and storage.filename(name) ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
    and owner_id = (select auth.uid())::text
    and public._my_role() in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
    and public._my_tenant_is_operational()
  )
);

create policy materials_private_delete_guard
on storage.objects
as restrictive
for delete
to authenticated
using (
  bucket_id <> 'materials'
  or (
    (select auth.uid()) is not null
    and public._my_role() in (
      'TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
    )
    and (
      (
        cardinality(storage.foldername(name)) = 2
        and (storage.foldername(name))[1] = public._my_tenant_id()
        and (storage.foldername(name))[2] = (select auth.uid())::text
        and owner_id = (select auth.uid())::text
        and public._my_tenant_is_operational()
      )
      or private.hub_material_object_is_manageable(name)
    )
  )
);

-- Anonymous callers never need to execute the private tenant predicates. The
-- dedicated guards deny every materials operation even if another anonymous
-- storage policy is accidentally made permissive.
create policy materials_private_anon_read_guard
on storage.objects
as restrictive
for select
to anon
using (bucket_id <> 'materials');

create policy materials_private_anon_insert_guard
on storage.objects
as restrictive
for insert
to anon
with check (bucket_id <> 'materials');

create policy materials_private_anon_update_guard
on storage.objects
as restrictive
for update
to anon
using (bucket_id <> 'materials')
with check (bucket_id <> 'materials');

create policy materials_private_anon_delete_guard
on storage.objects
as restrictive
for delete
to anon
using (bucket_id <> 'materials');

revoke all on function private.hub_guard_material_sync_fields()
  from public, anon, authenticated;
revoke all on function private.hub_material_url_object_name(text)
  from public, anon, authenticated;
revoke all on function private.hub_material_object_has_provenance(text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.hub_validate_material_publication_sources(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_actor_owns_namespaced_material_object(text, uuid, text)
  from public, anon, authenticated;
revoke all on function private.hub_guard_material_publication_consent()
  from public, anon, authenticated;
revoke all on function private.hub_mark_pedagogical_material_for_sync()
  from public, anon, authenticated;
revoke all on function public.list_material_approvals()
  from public, anon, authenticated, service_role;
revoke all on function public.review_material(uuid, boolean, text)
  from public, anon, authenticated, service_role;
revoke all on function private.hub_sync_pedagogical_material_catalog()
  from public, anon, authenticated;
revoke all on function private.hub_enforce_distinct_content_assets()
  from public, anon, authenticated;
revoke all on function private.hub_content_has_isolated_asset_pair(uuid)
  from public, anon, authenticated;
revoke all on function private.hub_enforce_catalog_asset_pair()
  from public, anon, authenticated;
revoke all on function private.hub_material_object_is_readable(text)
  from public, anon, authenticated;
revoke all on function private.hub_material_object_is_manageable(text)
  from public, anon, authenticated;

grant usage on schema private to authenticated;
grant execute on function public.list_material_approvals()
  to authenticated;
grant execute on function public.review_material(uuid, boolean, text)
  to authenticated;
grant execute on function public.hub_validate_material_publication_sources(uuid, text, text)
  to service_role;
grant execute on function private.hub_material_object_is_readable(text)
  to authenticated;
grant execute on function private.hub_material_object_is_manageable(text)
  to authenticated;

comment on column public.pedagogical_materials.storage_object_path is
  'Exact private materials bucket key. New keys use tenant_id/auth.uid()/uuid.ext.';
comment on column public.pedagogical_materials.hub_catalog_opt_in is
  'Explicit school-admin consent for commercial Hub distribution; false by default.';
comment on column public.pedagogical_materials.hub_commercial_approved is
  'Central commercial approval controlled exclusively by SUPER_ADMIN; false by default.';
comment on column public.pedagogical_materials.hub_rights_declaration is
  'Admin attestation of ownership/license; retained for audit and never copied to the public catalog.';
comment on column public.pedagogical_materials.hub_preview_source_path is
  'Separate private source object used to generate the commercial preview.';
comment on column public.hub_content_items.catalog_scope is
  'Public catalog scope. Commercial rows are global and carry no tenant identifier.';
comment on table private.hub_content_isolation_archive is
  'Private recovery snapshots captured before Hub content isolation sanitation.';
comment on table private.hub_material_storage_quarantine is
  'Untrusted legacy Storage references retained for audit without granting object access.';

commit;
