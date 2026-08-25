begin;

create table if not exists public.hub_core_legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.hub_accounts(id) on delete restrict,
  user_id uuid not null
    references auth.users(id) on delete restrict,
  terms_version text not null
    check (char_length(terms_version) between 10 and 80),
  terms_snapshot text not null
    check (octet_length(terms_snapshot) between 512 and 65536),
  terms_sha256 text not null
    check (terms_sha256 ~ '^[a-f0-9]{64}$'),
  privacy_version text not null
    check (char_length(privacy_version) between 10 and 80),
  privacy_snapshot text not null
    check (octet_length(privacy_snapshot) between 512 and 65536),
  privacy_sha256 text not null
    check (privacy_sha256 ~ '^[a-f0-9]{64}$'),
  source text not null default 'HUB_CORE_CHECKOUT'
    check (source = 'HUB_CORE_CHECKOUT'),
  request_key uuid not null,
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint hub_core_legal_acceptances_terms_digest_check check (
    terms_sha256 = pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(terms_snapshot, 'UTF8'), 'sha256'),
      'hex'
    )
  ),
  constraint hub_core_legal_acceptances_privacy_digest_check check (
    privacy_sha256 = pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(privacy_snapshot, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ),
  unique (account_id, user_id, terms_version, privacy_version)
);

create index if not exists hub_core_legal_acceptances_user_account_idx
  on public.hub_core_legal_acceptances(user_id, account_id, accepted_at desc);

alter table public.hub_core_legal_acceptances enable row level security;

revoke all on table public.hub_core_legal_acceptances
  from public, anon, authenticated;
grant select on table public.hub_core_legal_acceptances to authenticated;
grant select, insert on table public.hub_core_legal_acceptances to service_role;

drop policy if exists hub_core_legal_acceptances_read_own
  on public.hub_core_legal_acceptances;
create policy hub_core_legal_acceptances_read_own
  on public.hub_core_legal_acceptances
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and (select private.hub_has_account_access(account_id))
  );

create or replace function private.prevent_hub_core_legal_acceptance_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'hub_core_legal_acceptance_immutable' using errcode = '55000';
end;
$function$;

alter function private.prevent_hub_core_legal_acceptance_mutation()
  owner to postgres;
revoke all on function private.prevent_hub_core_legal_acceptance_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists hub_core_legal_acceptances_immutable
  on public.hub_core_legal_acceptances;
create trigger hub_core_legal_acceptances_immutable
before update or delete on public.hub_core_legal_acceptances
for each row execute function private.prevent_hub_core_legal_acceptance_mutation();

create or replace function public.hub_catalog_checkout_is_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.hub_catalog_is_ready();
$function$;

alter function public.hub_catalog_checkout_is_ready() owner to postgres;
revoke all on function public.hub_catalog_checkout_is_ready()
  from public, anon, authenticated, service_role;
grant execute on function public.hub_catalog_checkout_is_ready()
  to service_role;

comment on table public.hub_core_legal_acceptances is
  'Immutable Hub Core legal evidence with exact canonical snapshots and SHA-256 digests, retained across account closure. Hard deletion requires a separate audited retention/anonymization process. Marketing consent is intentionally out of scope.';
comment on function private.prevent_hub_core_legal_acceptance_mutation() is
  'Makes legal acceptance evidence append-only outside an explicit audited retention migration.';
comment on function public.hub_catalog_checkout_is_ready() is
  'Service-role-only checkout guard backed by the private commercial catalog readiness policy.';

commit;
