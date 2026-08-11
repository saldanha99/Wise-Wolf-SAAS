-- Claim persistente para a tentativa imediata de cobrança de mensalidades
-- vencidas ao cadastrar/trocar o cartão de uma assinatura.
--
-- O endpoint payWithCreditCard do Asaas não é idempotente. A UNIQUE por
-- cobrança impede duas abas ou dois usuários de dispararem a mesma operação
-- ao mesmo tempo. Nenhum dado do cartão é armazenado nesta tabela.

create table if not exists public.student_overdue_card_charge_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  asaas_subscription_id text not null,
  asaas_payment_id text not null,
  status text not null default 'PROCESSING'
    check (status in ('PROCESSING', 'SUCCEEDED', 'DECLINED', 'UNKNOWN')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  requested_by uuid references public.profiles(id) on delete set null,
  processing_started_at timestamptz not null default now(),
  provider_status text,
  provider_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_overdue_card_charge_claims_payment_key
    unique (asaas_payment_id)
);

create index if not exists student_overdue_card_charge_claims_student_idx
  on public.student_overdue_card_charge_claims (student_id, created_at desc);

create index if not exists student_overdue_card_charge_claims_tenant_idx
  on public.student_overdue_card_charge_claims (tenant_id, created_at desc);

create index if not exists student_overdue_card_charge_claims_requested_idx
  on public.student_overdue_card_charge_claims (requested_by)
  where requested_by is not null;

alter table public.student_overdue_card_charge_claims enable row level security;
alter table public.student_overdue_card_charge_claims force row level security;

revoke all on table public.student_overdue_card_charge_claims
  from public, anon, authenticated;
grant select, insert, update on table public.student_overdue_card_charge_claims
  to service_role;

comment on table public.student_overdue_card_charge_claims is
  'Trava server-side contra cobrança duplicada ao pagar fatura vencida com um novo cartão. Não armazena dados do cartão.';
