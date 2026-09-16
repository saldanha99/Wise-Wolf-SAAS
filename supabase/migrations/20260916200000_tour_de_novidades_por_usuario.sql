-- Tour de novidades: cada funcionalidade nova sobe com um tutorial guiado, e a
-- plataforma mostra esse tutorial UMA vez por pessoa — em qualquer aparelho.
--
-- Guardar "já vi" só no navegador (localStorage) faria o mesmo tour reaparecer
-- no celular, no notebook e depois de limpar o cache. E `profiles.onboarded`
-- é um booleano: serve para o primeiro acesso, não para uma lista que cresce
-- a cada release. Por isso uma tabela própria, chaveada por (usuário, tour).
--
-- O catálogo dos tours vive no frontend (`lib/featureTours.ts`); o banco só
-- registra o que cada pessoa já viu. Re-executável: roda a cada release.

create table if not exists public.feature_tour_views (
  user_id uuid not null references auth.users(id) on delete cascade,
  tour_id text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, tour_id)
);

comment on table public.feature_tour_views is
  'Tours de novidade já vistos por usuário (id do tour vem de lib/featureTours.ts).';

alter table public.feature_tour_views enable row level security;

-- Cada pessoa lê e grava só as próprias linhas. `with check` repete o `using`
-- de propósito: sem ele daria para inserir "visto" em nome de outro usuário.
drop policy if exists feature_tour_views_own on public.feature_tour_views;
create policy feature_tour_views_own
  on public.feature_tour_views
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on table public.feature_tour_views to authenticated;
grant all on table public.feature_tour_views to service_role;
