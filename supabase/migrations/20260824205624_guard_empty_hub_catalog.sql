begin;

create or replace function private.hub_catalog_is_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.hub_content_items as content
    where content.is_active is true
      and content.catalog_scope = 'COMMERCIAL_GLOBAL'
      and content.rights_basis in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
      and content.published_at is not null
      and content.published_at <= pg_catalog.now()
      and content.rights_verified_at is not null
      and nullif(pg_catalog.btrim(content.license_summary), '') is not null
      and content.preview_enabled is true
  );
$function$;

alter function private.hub_catalog_is_ready() owner to postgres;
revoke all on function private.hub_catalog_is_ready()
  from public, anon, authenticated, service_role;

create or replace function private.hub_guard_discovery_catalog_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan_code text;
begin
  if new.product_family is distinct from 'HUB_CORE' then
    return new;
  end if;

  select plan.code into v_plan_code
  from public.hub_plans as plan
  where plan.id = new.plan_id;

  if v_plan_code = 'DISCOVERY'
     and not private.hub_catalog_is_ready() then
    raise exception 'hub_catalog_not_ready' using errcode = '55000';
  end if;

  return new;
end;
$function$;

alter function private.hub_guard_discovery_catalog_ready() owner to postgres;
revoke all on function private.hub_guard_discovery_catalog_ready()
  from public, anon, authenticated, service_role;

drop trigger if exists hub_guard_discovery_catalog_ready
  on public.hub_subscriptions;
create trigger hub_guard_discovery_catalog_ready
before insert on public.hub_subscriptions
for each row execute function private.hub_guard_discovery_catalog_ready();

comment on function private.hub_catalog_is_ready() is
  'Fail-closed commercial readiness check: at least one active, published and rights-verified Hub item must exist.';
comment on function private.hub_guard_discovery_catalog_ready() is
  'Prevents a free Hub trial from opening into an empty or unlicensed catalog.';

commit;
