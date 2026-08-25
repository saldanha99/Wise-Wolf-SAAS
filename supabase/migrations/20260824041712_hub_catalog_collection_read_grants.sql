begin;

grant select (collection_id, part_number)
  on public.hub_content_items
  to anon, authenticated;

revoke all on table public.hub_collections from anon, authenticated;
grant select (
  id,
  title,
  niche,
  level_tag,
  cover_url,
  display_order,
  is_active
) on public.hub_collections to anon, authenticated;

drop policy if exists hub_collections_public_read
  on public.hub_collections;
create policy hub_collections_public_read
  on public.hub_collections
  for select
  to anon, authenticated
  using (is_active is true);

commit;
