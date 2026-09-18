-- =============================================================================
-- Gerador de material do Wise Wolf Hub — persistência.
--
-- Decisão da direção (17/09/2026): a Biblioteca é o produto de entrada e a dor
-- do professor autônomo é "não consigo ficar criando material para cada nicho e
-- nível". O Hub já tinha o Educador IA só como planner de aula (preso a um perfil
-- de aluno). Aqui nasce o material gerado por tipo × nicho × nível × tema, sem
-- aluno: worksheet, quiz, cards, drill, leitura e roteiro de conversação.
--
-- Cada geração consome 1 unidade de `educator_ai.generate` (mesma cota do
-- planner) e fica guardada aqui para o professor reabrir/imprimir. O gabarito
-- das questões de múltipla escolha passa pela auditoria determinística do
-- `wolfie-activity` antes de ser gravado (a IA propõe, o código veta).
--
-- Padrão idêntico ao de `hub_educator_plans`: escrita só pelo service_role (a
-- edge `pedagogical-content`, action=material), leitura pelo criador ou por
-- OWNER/ADMIN da conta, apagar pelo criador ou por manager.
-- ⚠️ Roda a cada release: tudo re-executável, sem begin/commit.
-- =============================================================================

create table if not exists public.hub_educator_materials (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  account_id uuid not null
    references public.hub_accounts(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  subscription_id uuid not null,
  request_key uuid not null,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  kind text not null
    check (kind in ('worksheet', 'quiz', 'vocab_cards', 'grammar_drill', 'reading', 'conversation')),
  niche text not null default 'GENERAL'
    check (niche in ('GENERAL', 'BUSINESS', 'TECH', 'TRAVEL', 'MEDICINE', 'KIDS', 'TOEFL_IELTS', 'CONVERSATION')),
  level_tag text not null
    check (level_tag in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  topic text not null
    check (pg_catalog.char_length(topic) between 3 and 200),
  item_count integer not null
    check (item_count between 4 and 15),
  bilingual boolean not null default true,
  extra_instructions text not null default ''
    check (pg_catalog.char_length(extra_instructions) <= 600),
  title text not null
    check (pg_catalog.char_length(title) between 1 and 140),
  material jsonb not null
    check (pg_catalog.jsonb_typeof(material) = 'object'),
  dropped_items integer not null default 0
    check (dropped_items >= 0),
  model_id text not null,
  prompt_version text not null,
  response_id text,
  provider_usage jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(provider_usage) = 'object'),
  created_at timestamptz not null default pg_catalog.now(),
  constraint hub_educator_materials_subscription_fkey
    foreign key (account_id, subscription_id)
    references public.hub_subscriptions(account_id, id)
    on delete restrict,
  unique (account_id, created_by, request_key)
);

comment on table public.hub_educator_materials is
  'Materiais gerados pelo Educador IA do Hub (tipo × nicho × nível × tema), sem perfil de aluno. Escrita só pela edge pedagogical-content; cada linha custou 1 unidade de educator_ai.generate.';

create index if not exists hub_educator_materials_account_created_idx
  on public.hub_educator_materials(account_id, created_at desc);

alter table public.hub_educator_materials enable row level security;
alter table public.hub_educator_materials force row level security;

revoke all on table public.hub_educator_materials from public, anon, authenticated;
grant select, delete on table public.hub_educator_materials to authenticated;
grant all on table public.hub_educator_materials to service_role;

drop policy if exists hub_educator_materials_select_scoped on public.hub_educator_materials;
create policy hub_educator_materials_select_scoped
on public.hub_educator_materials
for select
to authenticated
using (
  (select private.hub_has_educator_planner_access(account_id))
  and (
    (select private.hub_is_account_manager(account_id))
    or created_by = (select auth.uid())
  )
);

drop policy if exists hub_educator_materials_delete_scoped on public.hub_educator_materials;
create policy hub_educator_materials_delete_scoped
on public.hub_educator_materials
for delete
to authenticated
using (
  (select private.hub_has_educator_planner_access(account_id))
  and (
    (select private.hub_is_account_manager(account_id))
    or created_by = (select auth.uid())
  )
);
