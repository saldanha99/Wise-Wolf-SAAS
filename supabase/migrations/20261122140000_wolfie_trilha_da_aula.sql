-- Wolfie: trilha da aula + revisões espaçadas (22/11/2026).
--
-- Cada aula lançada e aprovada (class_logs.approval_status = 'APPROVED',
-- presença COMPLETED) vira, para o próprio aluno, uma sessão de 10–15 min com
-- o tema da aula: recuperação, foco na forma, prática que cresce, correção dos
-- erros que o professor registrou, vocabulário e roleplay com o Wolfie.
-- A fonte é o que o PROFESSOR confirmou ao lançar a aula (conteúdo,
-- dificuldades, objetivo, próximo passo) e, quando existe, o resumo da aula
-- APROVADO (VERIFIED). Rascunho de IA (PROPOSED) nunca entra.
--
-- Geração: 1 vez por aula (class_log_id único), pela função wolfie-lesson-track
-- com a ponte de IA (_shared/ai-gateway.ts). Releitura não gera de novo.
-- Revisões D+1, D+3, D+7, D+14 e D+30 nascem ao concluir a trilha (D+14 e
-- D+30 só abrem se o aluno foi bem nas anteriores), mais o CHECKIN na véspera
-- da próxima aula, que vira um resumo só de leitura para o professor.
-- Revisões, com os itens errados e
-- os principais da aula, intercalados com itens de trilhas anteriores.
--
-- LGPD: tudo é do próprio aluno. RLS só deixa o aluno LER as linhas dele;
-- escrita só pela função (service_role). Aditiva e re-executável.

create table if not exists public.wolfie_lesson_tracks (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  student_id uuid not null references public.profiles (id) on delete cascade,
  -- Nulo só em trilha de teste (test_fixture), para QA sem lançar aula falsa:
  -- class_logs mexe em repasse do professor.
  class_log_id uuid references public.class_logs (id) on delete cascade,
  test_fixture boolean not null default false,
  lesson_session_id uuid,
  class_date date not null,
  topic text not null default '',
  -- Entrada estruturada da aula (tema gramatical, vocabulário, frases erradas
  -- do aluno, objetivo, rotina). Pensada para o professor editar no futuro:
  -- editar = gravar teacher_edited_at e gerar de novo.
  lesson_input jsonb,
  teacher_edited_at timestamptz,
  status text not null default 'GENERATING'
    check (status in ('GENERATING', 'READY', 'FAILED')),
  content jsonb,
  source_sha256 text,
  model_id text,
  input_tokens integer,
  output_tokens integer,
  generation_attempts smallint not null default 0,
  lease_expires_at timestamptz,
  error_code text,
  progress jsonb not null default '{}'::jsonb,
  score smallint,
  started_at timestamptz,
  completed_at timestamptz,
  roleplay_feedback jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_log_id),
  check (class_log_id is not null or test_fixture)
);

create index if not exists wolfie_lesson_tracks_student_idx
  on public.wolfie_lesson_tracks (student_id, class_date desc);

comment on table public.wolfie_lesson_tracks is
  'Trilha da aula do Wolfie: 1 por aula aprovada (class_log), gerada 1 vez e servida do cache. Só o próprio aluno lê.';

create table if not exists public.wolfie_lesson_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  student_id uuid not null references public.profiles (id) on delete cascade,
  track_id uuid not null references public.wolfie_lesson_tracks (id) on delete cascade,
  step text not null check (step in ('D1', 'D3', 'D7', 'D14', 'D30', 'CHECKIN')),
  due_on date not null,
  items jsonb not null default '[]'::jsonb,
  status text not null default 'PENDING' check (status in ('PENDING', 'DONE')),
  answers jsonb,
  score smallint,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (track_id, step)
);

create index if not exists wolfie_lesson_reviews_due_idx
  on public.wolfie_lesson_reviews (student_id, status, due_on);

comment on table public.wolfie_lesson_reviews is
  'Revisões espaçadas (D+1, D+3, D+7, D+14, D+30) e check-in pré-aula da trilha da aula. Itens já com gabarito: corrigir não chama IA.';

alter table public.wolfie_lesson_tracks enable row level security;
alter table public.wolfie_lesson_reviews enable row level security;

drop policy if exists wolfie_lesson_tracks_own_read on public.wolfie_lesson_tracks;
create policy wolfie_lesson_tracks_own_read on public.wolfie_lesson_tracks
  for select to authenticated
  using (student_id = (select auth.uid()));

drop policy if exists wolfie_lesson_reviews_own_read on public.wolfie_lesson_reviews;
create policy wolfie_lesson_reviews_own_read on public.wolfie_lesson_reviews
  for select to authenticated
  using (student_id = (select auth.uid()));

revoke all on public.wolfie_lesson_tracks from anon;
revoke all on public.wolfie_lesson_reviews from anon;
revoke insert, update, delete on public.wolfie_lesson_tracks from authenticated;
revoke insert, update, delete on public.wolfie_lesson_reviews from authenticated;
grant select on public.wolfie_lesson_tracks to authenticated;
grant select on public.wolfie_lesson_reviews to authenticated;
grant all on public.wolfie_lesson_tracks to service_role;
grant all on public.wolfie_lesson_reviews to service_role;
