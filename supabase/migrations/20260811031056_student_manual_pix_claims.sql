-- Trava curta e persistente para a emissão de Pix manual.
--
-- A chamada ao Asaas acontece fora de uma transação Postgres. Uma UNIQUE por
-- aluno/vencimento impede dois diretores (ou duas abas) de criarem cobranças
-- duplicadas durante essa janela. A tabela não é exposta ao navegador: somente
-- a Edge Function, via service_role, pode gravar ou consultar as claims.

create table if not exists public.student_manual_pix_issuances (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  due_date date not null,
  status text not null default 'PROCESSING'
    check (status in ('PROCESSING', 'READY', 'FAILED')),
  asaas_payment_id text,
  requested_by uuid references public.profiles(id) on delete set null,
  processing_started_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_manual_pix_issuances_student_due_key
    unique (student_id, due_date)
);

create index if not exists student_manual_pix_issuances_tenant_due_idx
  on public.student_manual_pix_issuances (tenant_id, due_date desc);

create index if not exists student_manual_pix_issuances_requested_by_idx
  on public.student_manual_pix_issuances (requested_by)
  where requested_by is not null;

alter table public.student_manual_pix_issuances enable row level security;
alter table public.student_manual_pix_issuances force row level security;

revoke all on table public.student_manual_pix_issuances
  from public, anon, authenticated;
grant select, insert, update on table public.student_manual_pix_issuances
  to service_role;

comment on table public.student_manual_pix_issuances is
  'Claim server-side que impede emissão duplicada de Pix manual para o mesmo aluno e vencimento. Não contém o payload Pix.';
