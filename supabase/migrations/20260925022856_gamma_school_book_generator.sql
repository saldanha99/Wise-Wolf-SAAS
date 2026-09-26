-- Gamma school book generator.
--
-- The API credential never reaches Postgres or the browser. This table keeps
-- only the tenant-scoped job lifecycle and the final library linkage. Provider
-- writes are performed by the authenticated Edge Function through service_role;
-- school users receive read-only access through RLS.

create table if not exists public.school_book_generations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  creator_role text not null
    check (creator_role in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')),
  request_key uuid not null,
  status text not null default 'STARTING'
    check (status in ('STARTING', 'GENERATING', 'FINALIZING', 'COMPLETED', 'FAILED')),
  title text not null check (pg_catalog.char_length(title) between 3 and 160),
  level_tag text not null
    check (level_tag in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  niche text not null default 'GENERAL'
    check (pg_catalog.char_length(niche) between 2 and 80),
  audience text not null
    check (audience in ('kids', 'teens', 'adults')),
  book_language text not null
    check (book_language in ('bilingual', 'english')),
  page_count smallint not null check (page_count between 12 and 60),
  objective text not null check (pg_catalog.char_length(objective) between 3 and 1200),
  topics text[] not null default '{}'::text[],
  gamma_generation_id text,
  gamma_url text,
  provider_request_id text,
  provider_warnings jsonb not null default '[]'::jsonb
    check (pg_catalog.jsonb_typeof(provider_warnings) = 'array'),
  provider_credits jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(provider_credits) = 'object'),
  collection_id uuid references public.pedagogical_collections(id) on delete set null,
  material_id uuid references public.pedagogical_materials(id) on delete set null,
  error_code text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  unique (created_by, request_key)
);

comment on table public.school_book_generations is
  'Tenant-scoped Gamma book jobs. Secrets and temporary export URLs are never persisted.';

create index if not exists school_book_generations_tenant_created_idx
  on public.school_book_generations (tenant_id, created_at desc);
create index if not exists school_book_generations_creator_created_idx
  on public.school_book_generations (created_by, created_at desc);
create unique index if not exists school_book_generations_gamma_id_idx
  on public.school_book_generations (gamma_generation_id)
  where gamma_generation_id is not null;
create index if not exists school_book_generations_collection_id_idx
  on public.school_book_generations (collection_id)
  where collection_id is not null;
create index if not exists school_book_generations_material_id_idx
  on public.school_book_generations (material_id)
  where material_id is not null;

alter table public.school_book_generations enable row level security;
alter table public.school_book_generations force row level security;

revoke all on table public.school_book_generations
  from public, anon, authenticated;
grant select on table public.school_book_generations to authenticated;
grant all on table public.school_book_generations to service_role;

drop policy if exists school_book_generations_select_scoped
  on public.school_book_generations;
create policy school_book_generations_select_scoped
on public.school_book_generations
for select
to authenticated
using (
  tenant_id = (select public._my_tenant_id())
  and (select public._my_tenant_is_operational())
  and (
    created_by = (select auth.uid())
    or (select public._my_role()) in (
      'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
    )
  )
);
