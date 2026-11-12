-- Pop-up "Sugestão de plano para a próxima aula" (ideia da direção, 12/11/2026).
-- O professor pode desligar ("Não mostrar mais") e religar no Planner IA.
-- A escolha é por usuário no banco: não volta em outro aparelho nem depois de
-- limpar o cache. Não é dado de negócio — fica fora de `profiles`.
create table if not exists public.teacher_lesson_plan_prompt_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  disabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.teacher_lesson_plan_prompt_prefs enable row level security;

drop policy if exists teacher_lesson_plan_prompt_prefs_own_select on public.teacher_lesson_plan_prompt_prefs;
create policy teacher_lesson_plan_prompt_prefs_own_select
  on public.teacher_lesson_plan_prompt_prefs for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists teacher_lesson_plan_prompt_prefs_own_insert on public.teacher_lesson_plan_prompt_prefs;
create policy teacher_lesson_plan_prompt_prefs_own_insert
  on public.teacher_lesson_plan_prompt_prefs for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists teacher_lesson_plan_prompt_prefs_own_update on public.teacher_lesson_plan_prompt_prefs;
create policy teacher_lesson_plan_prompt_prefs_own_update
  on public.teacher_lesson_plan_prompt_prefs for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.teacher_lesson_plan_prompt_prefs from anon;
grant select, insert, update on public.teacher_lesson_plan_prompt_prefs to authenticated;
