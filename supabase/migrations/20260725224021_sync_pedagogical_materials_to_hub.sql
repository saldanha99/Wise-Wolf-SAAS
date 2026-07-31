-- Every approved pedagogical material becomes part of the commercial Hub.
-- Files are copied asynchronously to the private hub-library bucket; catalog
-- metadata is synchronized transactionally by triggers.

alter table public.pedagogical_materials
  add column if not exists hub_object_path text,
  add column if not exists hub_sync_status text not null default 'PENDING',
  add column if not exists hub_sync_error text,
  add column if not exists hub_synced_at timestamptz;

alter table public.pedagogical_materials
  drop constraint if exists pedagogical_materials_hub_sync_status_check;
alter table public.pedagogical_materials
  add constraint pedagogical_materials_hub_sync_status_check
  check (hub_sync_status in ('PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'NOT_APPLICABLE'));

alter table public.hub_content_items
  add column if not exists source_material_id uuid
  references public.pedagogical_materials(id) on delete set null;

create unique index if not exists hub_content_source_material_unique
  on public.hub_content_items(source_material_id)
  where source_material_id is not null;

alter table public.hub_content_assets
  add column if not exists external_url text;

update storage.buckets
set file_size_limit = 3221225472
where id = 'hub-library';

create or replace function private.hub_mark_pedagogical_material_for_sync()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.type = 'LINK' then
      new.hub_sync_status := 'NOT_APPLICABLE';
    elsif new.approval_status = 'APPROVED' then
      new.hub_sync_status := 'PENDING';
    end if;
  elsif new.file_url is distinct from old.file_url
     or new.approval_status is distinct from old.approval_status
     or new.type is distinct from old.type then
    new.hub_object_path := case
      when new.type = 'LINK' then null
      when new.file_url = old.file_url and old.type <> 'LINK' then old.hub_object_path
      else null
    end;
    new.hub_sync_error := null;
    new.hub_synced_at := null;
    new.hub_sync_status := case
      when new.type = 'LINK' then 'NOT_APPLICABLE'
      when new.approval_status = 'APPROVED' and new.file_url = old.file_url and old.hub_object_path is not null then 'SYNCED'
      when new.approval_status = 'APPROVED' then 'PENDING'
      else 'PENDING'
    end;
  end if;
  return new;
end;
$$;

create or replace function private.hub_sync_pedagogical_material_catalog()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item_id uuid;
  v_collection_name text;
  v_author_name text;
  v_content_type text;
  v_description text;
begin
  if tg_op = 'DELETE' then
    update public.hub_content_items
       set is_active = false,
           published_at = null,
           updated_at = now()
     where source_material_id = old.id;
    return old;
  end if;

  if new.approval_status <> 'APPROVED' then
    update public.hub_content_items
       set is_active = false,
           published_at = null,
           updated_at = now()
     where source_material_id = new.id;
    return new;
  end if;

  select collection.title into v_collection_name
  from public.pedagogical_collections collection
  where collection.id = new.collection_id;

  select profile.full_name into v_author_name
  from public.profiles profile
  where profile.id = new.uploaded_by;

  v_content_type := case upper(coalesce(new.type, 'PDF'))
    when 'PDF' then 'PDF'
    when 'VIDEO' then 'VIDEO'
    when 'AUDIO' then 'AUDIO'
    when 'LINK' then 'LINK'
    else 'ACTIVITY'
  end;
  v_description := concat_ws(' · ',
    nullif(trim(coalesce(new.category, '')), ''),
    case when new.part_number is not null then 'Parte ' || new.part_number::text else null end
  );

  insert into public.hub_content_items (
    slug, title, description, content_type, level_tag, niche,
    collection_name, preview_enabled, license_summary, author_name,
    rights_verified_at, published_at, is_active, source_material_id, metadata
  ) values (
    'material-' || new.id::text,
    new.title,
    nullif(v_description, ''),
    v_content_type,
    case when new.level_tag in ('A1','A2','B1','B2','C1','C2') then new.level_tag else null end,
    coalesce(nullif(new.niche, ''), 'GENERAL'),
    v_collection_name,
    true,
    'Uso incluído na assinatura Wise Wolf Hub. Redistribuição e revenda não autorizadas.',
    v_author_name,
    now(),
    coalesce((select item.published_at from public.hub_content_items item where item.source_material_id = new.id), now()),
    true,
    new.id,
    jsonb_build_object(
      'source', 'pedagogical_materials',
      'tenantId', new.tenant_id,
      'scope', new.scope,
      'partNumber', new.part_number
    )
  ) on conflict (source_material_id) where source_material_id is not null
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
    published_at = coalesce(public.hub_content_items.published_at, now()),
    is_active = true,
    metadata = excluded.metadata,
    updated_at = now()
  returning id into v_item_id;

  if v_content_type = 'LINK' or new.hub_sync_status = 'NOT_APPLICABLE' then
    insert into public.hub_content_assets (
      content_id, asset_kind, bucket_id, object_path, external_url
    ) values
      (v_item_id, 'PREVIEW', 'hub-library', 'external/' || new.id::text, new.file_url),
      (v_item_id, 'FULL', 'hub-library', 'external/' || new.id::text, new.file_url)
    on conflict (content_id, asset_kind) do update set
      bucket_id = excluded.bucket_id,
      object_path = excluded.object_path,
      external_url = excluded.external_url;
  elsif new.hub_object_path is not null then
    insert into public.hub_content_assets (
      content_id, asset_kind, bucket_id, object_path, external_url
    ) values
      (v_item_id, 'PREVIEW', 'hub-library', new.hub_object_path, null),
      (v_item_id, 'FULL', 'hub-library', new.hub_object_path, null)
    on conflict (content_id, asset_kind) do update set
      bucket_id = excluded.bucket_id,
      object_path = excluded.object_path,
      external_url = null;
  else
    delete from public.hub_content_assets
    where content_id = v_item_id and asset_kind in ('PREVIEW', 'FULL');
  end if;

  return new;
end;
$$;

drop trigger if exists hub_mark_pedagogical_material_for_sync on public.pedagogical_materials;
create trigger hub_mark_pedagogical_material_for_sync
before insert or update of file_url, approval_status, type
on public.pedagogical_materials
for each row execute function private.hub_mark_pedagogical_material_for_sync();

drop trigger if exists hub_sync_pedagogical_material_catalog on public.pedagogical_materials;
create trigger hub_sync_pedagogical_material_catalog
after insert or update of title, file_url, type, level_tag, category, niche,
  approval_status, collection_id, part_number, hub_object_path, hub_sync_status
on public.pedagogical_materials
for each row execute function private.hub_sync_pedagogical_material_catalog();

drop trigger if exists hub_remove_pedagogical_material_catalog on public.pedagogical_materials;
create trigger hub_remove_pedagogical_material_catalog
after delete on public.pedagogical_materials
for each row execute function private.hub_sync_pedagogical_material_catalog();

create or replace function private.hub_refresh_collection_catalog()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.title is distinct from old.title then
    update public.pedagogical_materials
       set title = title
     where collection_id = new.id
       and approval_status = 'APPROVED';
  end if;
  return new;
end;
$$;

drop trigger if exists hub_refresh_collection_catalog on public.pedagogical_collections;
create trigger hub_refresh_collection_catalog
after update of title on public.pedagogical_collections
for each row execute function private.hub_refresh_collection_catalog();

-- Seed the catalog and queue all existing approved files for private copying.
update public.pedagogical_materials
set hub_sync_status = case when type = 'LINK' then 'NOT_APPLICABLE' else 'PENDING' end,
    hub_sync_error = null,
    hub_object_path = hub_object_path
where approval_status = 'APPROVED';

revoke all on function private.hub_mark_pedagogical_material_for_sync() from public;
revoke all on function private.hub_sync_pedagogical_material_catalog() from public;
revoke all on function private.hub_refresh_collection_catalog() from public;

comment on column public.pedagogical_materials.hub_sync_status is
  'Private Hub copy lifecycle. Approved uploads are PENDING until sync-hub-material completes.';
