begin;

create table if not exists private.hub_material_storage_repair_audit (
  material_id uuid primary key,
  storage_object_id uuid not null unique,
  object_name text not null,
  tenant_id text not null,
  uploader_id uuid not null,
  previous_owner_id text,
  material_before jsonb not null,
  storage_object_before jsonb not null,
  quarantine_id bigint not null,
  repair_reason text not null check (
    repair_reason = 'VERIFIED_LEGACY_OWNER_RESTORED'
  ),
  repaired_at timestamptz not null default clock_timestamp()
);

alter table private.hub_material_storage_repair_audit enable row level security;
alter table private.hub_material_storage_repair_audit force row level security;
revoke all on table private.hub_material_storage_repair_audit
  from public, anon, authenticated, service_role;

alter table private.hub_material_storage_quarantine
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution text,
  add column if not exists resolved_by_migration text;

do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'private.hub_material_storage_quarantine'::regclass
      and conname = 'hub_material_storage_quarantine_resolution_check'
  ) then
    alter table private.hub_material_storage_quarantine
      add constraint hub_material_storage_quarantine_resolution_check
      check (
        resolution is null
        or resolution = 'VERIFIED_LEGACY_OWNER_RESTORED'
      );
  end if;
end;
$constraints$;

drop table if exists pg_temp.hub_material_storage_repair_candidates;
create temporary table hub_material_storage_repair_candidates
on commit drop
as
select
  material.id as material_id,
  material.tenant_id,
  material.uploaded_by,
  object.id as storage_object_id,
  object.name as object_name,
  object.owner_id as previous_owner_id,
  to_jsonb(material) as material_before,
  to_jsonb(object) as storage_object_before,
  quarantine.id as quarantine_id
from public.pedagogical_materials as material
join public.profiles as uploader
  on uploader.id = material.uploaded_by
 and uploader.tenant_id = material.tenant_id
 and uploader.role in (
   'TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
 )
join storage.objects as object
  on object.bucket_id = 'materials'
 and object.name = private.hub_material_url_object_name(material.file_url)
join private.hub_material_storage_quarantine as quarantine
  on quarantine.material_id = material.id
 and quarantine.reference_kind = 'FULL_URL'
 and quarantine.object_name = object.name
 and quarantine.reason = 'OBJECT_OWNERSHIP_OR_TENANT_UNPROVEN'
where material.storage_object_path is null
  and material.tenant_id is not null
  and material.uploaded_by is not null
  and object.owner is null
  and object.owner_id is null
  and coalesce(object.metadata ->> 'size', '') ~ '^[1-9][0-9]*$'
  and quarantine.resolved_at is null
  and octet_length(object.name) between 3 and 1024
  and object.name !~ '(^|/)[.][.]?(/|$)'
  and object.name !~ '^/'
  and (
    (
      coalesce(cardinality(storage.foldername(object.name)), 0) = 0
      and storage.filename(object.name) ~
        '^[0-9]{10,20}[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
    )
    or (
      cardinality(storage.foldername(object.name)) = 1
      and (storage.foldername(object.name))[1] = 'materials'
      and storage.filename(object.name) ~
        '^([0-9]{10,20}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})[.](pdf|jpe?g|png|webp|mp4|mp3|wav)$'
    )
  )
  and 1 = (
    select count(*)
    from storage.objects as duplicate_guard
    where duplicate_guard.bucket_id = object.bucket_id
      and duplicate_guard.name = object.name
  );

do $verified_cohort$
declare
  candidate_count bigint;
  cohort_fingerprint text;
begin
  select
    count(*),
    md5(string_agg(
      concat_ws(
        chr(31),
        material_id::text,
        storage_object_id::text,
        object_name,
        tenant_id,
        uploaded_by::text
      ),
      chr(30) order by material_id
    ))
  into candidate_count, cohort_fingerprint
  from pg_temp.hub_material_storage_repair_candidates;

  if candidate_count > 0 and (
    candidate_count <> 19
    or cohort_fingerprint <> '24887673a760c7e12ca863f432446e9f'
  ) then
    raise exception 'legacy_material_storage_repair_cohort_mismatch';
  end if;
end;
$verified_cohort$;

insert into private.hub_material_storage_repair_audit (
  material_id,
  storage_object_id,
  object_name,
  tenant_id,
  uploader_id,
  previous_owner_id,
  material_before,
  storage_object_before,
  quarantine_id,
  repair_reason
)
select
  material_id,
  storage_object_id,
  object_name,
  tenant_id,
  uploaded_by,
  previous_owner_id,
  material_before,
  storage_object_before,
  quarantine_id,
  'VERIFIED_LEGACY_OWNER_RESTORED'
from pg_temp.hub_material_storage_repair_candidates
on conflict (material_id) do nothing;

update storage.objects as object
set owner = audit.uploader_id,
    owner_id = audit.uploader_id::text
from private.hub_material_storage_repair_audit as audit
where object.id = audit.storage_object_id
  and object.bucket_id = 'materials'
  and object.name = audit.object_name
  and object.owner is null
  and object.owner_id is null;

update public.pedagogical_materials as material
set storage_object_path = audit.object_name
from private.hub_material_storage_repair_audit as audit
where material.id = audit.material_id
  and material.tenant_id = audit.tenant_id
  and material.uploaded_by = audit.uploader_id
  and material.storage_object_path is null
  and private.hub_material_object_has_provenance(
    audit.object_name,
    material.tenant_id,
    material.uploaded_by
  );

update private.hub_material_storage_quarantine as quarantine
set resolved_at = coalesce(quarantine.resolved_at, clock_timestamp()),
    resolution = 'VERIFIED_LEGACY_OWNER_RESTORED',
    resolved_by_migration =
      '20260824183059_reconcile_legacy_material_storage_ownership'
from private.hub_material_storage_repair_audit as audit
join public.pedagogical_materials as material
  on material.id = audit.material_id
 and material.storage_object_path = audit.object_name
where quarantine.id = audit.quarantine_id
  and quarantine.material_id = audit.material_id
  and quarantine.object_name = audit.object_name
  and (
    quarantine.resolved_at is null
    or quarantine.resolution is distinct from
      'VERIFIED_LEGACY_OWNER_RESTORED'
    or quarantine.resolved_by_migration is distinct from
      '20260824183059_reconcile_legacy_material_storage_ownership'
  );

do $validation$
begin
  if exists (
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
  ) then
    raise exception 'legacy_material_storage_repair_incomplete';
  end if;

  if not exists (
    select 1
    from storage.buckets
    where id = 'materials'
      and public is false
  ) then
    raise exception 'materials_bucket_must_remain_private';
  end if;
end;
$validation$;

comment on table private.hub_material_storage_repair_audit is
  'Append-only snapshots for legacy material ownership repairs. Never exposed to client roles.';
comment on column private.hub_material_storage_quarantine.resolution is
  'Audited resolution; the quarantine row is retained instead of deleted.';

commit;
