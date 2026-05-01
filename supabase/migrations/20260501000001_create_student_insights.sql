-- 1. Cria a tabela de Insights
create table if not exists public.student_insights (
  id uuid default gen_random_uuid() primary key,
  student_id uuid references public.profiles(id) not null,
  content text not null, -- O texto gerado pela IA
  created_at timestamp with time zone default now(),
  valid_until timestamp with time zone -- Data de validade (ex: 7 dias)
);

-- 2. Habilita Segurança (RLS)
alter table public.student_insights enable row level security;

-- 3. Cria Políticas de Acesso
-- Aluno pode LER seus próprios insights
drop policy if exists "Alunos veem seus insights" on public.student_insights;
create policy "Alunos veem seus insights"
on public.student_insights for select
using (auth.uid() = student_id);

-- (Nota: A inserção será feita pela Service Role da Edge Function, então não precisa de policy de insert pública)
