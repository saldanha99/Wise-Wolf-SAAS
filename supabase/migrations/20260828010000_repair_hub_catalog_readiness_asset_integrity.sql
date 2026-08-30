begin;

create table if not exists private.hub_catalog_readiness_repair_log (
  id bigint generated always as identity primary key,
  content_id uuid not null references public.hub_content_items(id) on delete cascade,
  source_material_id uuid,
  reason text not null,
  repaired_at timestamptz not null default now(),
  item_snapshot jsonb not null,
  assets_snapshot jsonb not null default '[]'::jsonb,
  unique (content_id, reason)
);

alter table private.hub_catalog_readiness_repair_log enable row level security;
alter table private.hub_catalog_readiness_repair_log force row level security;
revoke all on table private.hub_catalog_readiness_repair_log
  from public, anon, authenticated;
revoke all on sequence private.hub_catalog_readiness_repair_log_id_seq
  from public, anon, authenticated;

create index if not exists hub_catalog_readiness_repair_log_content_idx
  on private.hub_catalog_readiness_repair_log(content_id, repaired_at desc);

drop table if exists stale_catalog_repair_snapshot;
create temporary table stale_catalog_repair_snapshot as
with stale_catalog as (
  select
    item.id as content_id,
    item.source_material_id,
    item.slug,
    item.title,
    item.published_at,
    item.rights_verified_at,
    item.catalog_scope,
    item.rights_basis,
    item.license_summary,
    full_asset.bucket_id as full_bucket_id,
    full_asset.object_path as full_object_path,
    preview_asset.bucket_id as preview_bucket_id,
    preview_asset.object_path as preview_object_path
  from public.hub_content_items as item
  left join lateral (
    select a.bucket_id, a.object_path
    from public.hub_content_assets as a
    where a.content_id = item.id
      and a.asset_kind = 'FULL'
      and btrim(coalesce(a.object_path, '')) <> ''
    limit 1
  ) as full_asset on true
  left join lateral (
    select a.bucket_id, a.object_path
    from public.hub_content_assets as a
    where a.content_id = item.id
      and a.asset_kind = 'PREVIEW'
      and btrim(coalesce(a.object_path, '')) <> ''
    limit 1
  ) as preview_asset on true
  where item.catalog_scope = 'COMMERCIAL_GLOBAL'
    and item.is_active is true
    and (
      item.rights_basis not in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
      or item.published_at is null
      or item.published_at > now()
      or not item.preview_enabled
      or item.rights_verified_at is null
      or nullif(btrim(coalesce(item.license_summary, '')), '') is null
      or full_asset.bucket_id is null
      or full_asset.object_path is null
      or not exists (
        select 1
        from storage.objects as full_object
        where full_object.bucket_id = full_asset.bucket_id
          and full_object.name = full_asset.object_path
      )
      or preview_asset.bucket_id is null
      or preview_asset.object_path is null
      or (
        full_asset.bucket_id = preview_asset.bucket_id
        and full_asset.object_path = preview_asset.object_path
      )
      or not exists (
        select 1
        from storage.objects as preview_object
        where preview_object.bucket_id = preview_asset.bucket_id
          and preview_object.name = preview_asset.object_path
      )
    )
)
select * from stale_catalog;

insert into private.hub_catalog_readiness_repair_log (
  content_id,
  source_material_id,
  reason,
  item_snapshot,
  assets_snapshot
)
select
  stale.content_id,
  stale.source_material_id,
  'commercial_catalog_asset_integrity_drift',
  to_jsonb(item),
  coalesce(
    (
      select jsonb_agg(to_jsonb(asset) order by asset.asset_kind)
      from public.hub_content_assets as asset
      where asset.content_id = stale.content_id
    ),
    '[]'::jsonb
  )
from stale_catalog_repair_snapshot as stale
join public.hub_content_items as item
  on item.id = stale.content_id
on conflict do nothing;

update public.hub_content_items as item
set
  is_active = false,
  preview_enabled = false,
  published_at = null,
  updated_at = now()
from stale_catalog_repair_snapshot as stale
where item.id = stale.content_id;

drop table stale_catalog_repair_snapshot;

comment on table private.hub_catalog_readiness_repair_log is
  'Audits catalog rows deactivated during catalog readiness repair for missing or invalid commercial asset paths.';
comment on column private.hub_catalog_readiness_repair_log.reason is
  'Repair reason for why a commercial catalog item was deactivated.';

commit;
