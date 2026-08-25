-- =============================================================================
-- Estrutura de livro no catálogo do Hub
--
-- O portal do Hub passou a usar o MESMO módulo da escola (`MaterialsLibrary`),
-- e o modo "Pastas" dele — Nicho › Nível › Livro › Partes — depende de
-- `collection_id` + `part_number`. O catálogo do Hub só tinha `collection_name`
-- como texto livre, então livro grande fracionado em partes (o caso dos ebooks)
-- não tinha como ser agrupado nem ordenado.
--
-- Espelha `pedagogical_collections` de propósito: os dois catálogos são
-- separados (a escola tem tenant; o Hub é por assinatura), mas a FORMA precisa
-- ser a mesma para o módulo funcionar nos dois lugares sem bifurcar o código.
--
-- ⚠️ Esta migration roda A CADA release: tudo aqui é re-executável.
-- =============================================================================

create table if not exists public.hub_collections (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  niche text not null default 'GENERAL',
  level_tag text check (level_tag is null or level_tag in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  cover_url text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.hub_collections is
  'Livros/ebooks do catálogo do Hub. Espelha pedagogical_collections em forma, não em dados: o acervo do Hub é por assinatura e não pertence a tenant nenhum.';

-- `on delete set null`: apagar o livro NÃO pode apagar o material. A parte vira
-- avulsa e continua no catálogo — foi assim que a biblioteca da escola resolveu,
-- e repetir a regra evita que o mesmo dado se comporte diferente nos dois lados.
alter table public.hub_content_items
  add column if not exists collection_id uuid references public.hub_collections(id) on delete set null;

alter table public.hub_content_items
  add column if not exists part_number integer;

alter table public.hub_content_items
  drop constraint if exists hub_content_items_part_number_positive;
alter table public.hub_content_items
  add constraint hub_content_items_part_number_positive
  check (part_number is null or part_number > 0);

create index if not exists hub_content_items_collection_idx
  on public.hub_content_items(collection_id, part_number)
  where collection_id is not null;

-- Duas partes com o mesmo número dentro do mesmo livro deixariam a ordem de
-- leitura indefinida — e "Parte 2 de 5" passaria a mentir na tela.
create unique index if not exists uq_hub_content_collection_part
  on public.hub_content_items(collection_id, part_number)
  where collection_id is not null and part_number is not null;

alter table public.hub_collections enable row level security;

-- Leitura pública só do que está ativo: o catálogo é vitrine e aparece antes do
-- login. Escrita não tem policy nenhuma — entra por RPC, como no catálogo da
-- escola, para o cliente nunca poder criar ou renomear livro.
drop policy if exists hub_collections_public_read on public.hub_collections;
create policy hub_collections_public_read
  on public.hub_collections
  for select
  using (is_active = true);

create or replace function public.hub_upsert_collection(
  p_id uuid,
  p_title text,
  p_niche text default 'GENERAL',
  p_level text default null,
  p_cover text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_title text;
begin
  if not private.hub_is_internal_manager() then
    raise exception 'sem_permissao';
  end if;

  -- `nullif` é forma especial do SQL: prefixar com pg_catalog quebra em runtime
  -- dentro de `set search_path = ''`. Mesma pedra da migration do Wolfie.
  v_title := nullif(btrim(coalesce(p_title, '')), '');
  if v_title is null then
    raise exception 'titulo_obrigatorio';
  end if;

  if p_id is null then
    insert into public.hub_collections (title, niche, level_tag, cover_url)
    values (v_title, coalesce(nullif(btrim(p_niche), ''), 'GENERAL'), p_level, p_cover)
    returning id into v_id;
  else
    update public.hub_collections
       set title = v_title,
           niche = coalesce(nullif(btrim(p_niche), ''), 'GENERAL'),
           level_tag = p_level,
           cover_url = p_cover,
           updated_at = now()
     where id = p_id
    returning id into v_id;

    if v_id is null then
      raise exception 'colecao_inexistente';
    end if;
  end if;

  return v_id;
end;
$$;

alter function public.hub_upsert_collection(uuid, text, text, text, text) owner to postgres;
revoke all on function public.hub_upsert_collection(uuid, text, text, text, text) from public;
grant execute on function public.hub_upsert_collection(uuid, text, text, text, text) to authenticated;

create or replace function public.hub_set_content_collection(
  p_content_id uuid,
  p_collection_id uuid,
  p_part_number integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.hub_is_internal_manager() then
    raise exception 'sem_permissao';
  end if;

  if p_part_number is not null and p_part_number <= 0 then
    raise exception 'parte_invalida';
  end if;

  -- Parte só existe dentro de um livro: número sem coleção viraria "Parte 3"
  -- de coisa nenhuma na tela.
  update public.hub_content_items
     set collection_id = p_collection_id,
         part_number = case when p_collection_id is null then null else p_part_number end,
         updated_at = now()
   where id = p_content_id;

  if not found then
    raise exception 'material_inexistente';
  end if;
end;
$$;

alter function public.hub_set_content_collection(uuid, uuid, integer) owner to postgres;
revoke all on function public.hub_set_content_collection(uuid, uuid, integer) from public;
grant execute on function public.hub_set_content_collection(uuid, uuid, integer) to authenticated;
