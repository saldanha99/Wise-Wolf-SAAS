-- Abertura personalizada do tutor (pedido do Vinícius, 22/11/2026): uma frase por aula,
-- gerada 1x pela IA (Haiku) e guardada aqui. Só service_role (a edge wolfie-lesson-track).
-- cache_key = 'class:<class_log_id>' (aula real) ou 'track:<id da trilha de teste>'.
-- status PENDING = alguém reservou a geração (os outros usam o molde, sem gerar de novo).
-- Aditiva e re-executável.

create table if not exists public.wolfie_openers (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  student_id uuid not null,
  cache_key text not null check (cache_key ~ '^(class|track):[0-9a-f-]{36}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'READY', 'FAILED')),
  opener text check (opener is null or pg_catalog.length(opener) between 20 and 200),
  source text check (source is null or source in ('AI', 'TEMPLATE')),
  model_id text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (student_id, cache_key)
);

create index if not exists wolfie_openers_student_idx on public.wolfie_openers (student_id, created_at desc);

alter table public.wolfie_openers enable row level security;
revoke all on public.wolfie_openers from public, anon, authenticated;
grant select, insert, update on public.wolfie_openers to service_role;
