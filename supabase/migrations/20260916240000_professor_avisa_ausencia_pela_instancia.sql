-- Professor avisando a instância da escola que não vai dar aula.
--
-- O bot reconhece a intenção (`whatsapp-inbound/teacher-absence.ts`), lista as
-- aulas do dia e PERGUNTA "confirma?". Esta tabela guarda a pergunta em aberto
-- para a resposta seguinte fechar o ciclo: confirmou → `gestao_open_coverage_day`
-- com `p_source='teacher'` (o professor atesta a própria ausência), aviso no
-- grupo da Gestão e links de cobertura para os professores livres.
--
-- Uma pergunta aberta por professor: a nova substitui a anterior. Expira em
-- 2 horas — "sim" no dia seguinte não pode abrir a ausência de ontem.
-- Re-executável: roda a cada release.

create table if not exists public.teacher_absence_prompts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  phone text not null,
  absence_date date not null,
  reason text not null,
  classes jsonb not null default '[]'::jsonb,
  status text not null default 'PENDING' check (status in ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  request_id text not null default encode(extensions.gen_random_bytes(12), 'hex'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours',
  resolved_at timestamptz
);
create unique index if not exists uq_teacher_absence_prompt_open
  on public.teacher_absence_prompts (teacher_id) where status = 'PENDING';

alter table public.teacher_absence_prompts enable row level security;
grant all on table public.teacher_absence_prompts to service_role;
comment on table public.teacher_absence_prompts is
  'Pergunta "confirma que não dá aula em X?" feita ao professor pela instância da escola, aguardando sim/não.';
