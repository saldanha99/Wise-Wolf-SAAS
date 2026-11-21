-- Aviso à escola quando o aluno/responsável abre a cobrança (21/11/2026).
--
-- Fonte confiável: eventos do Asaas PAYMENT_CHECKOUT_VIEWED (fatura vista) e
-- PAYMENT_BANK_SLIP_VIEWED (boleto visto), recebidos pelo asaas-webhook com o
-- token `asaas-access-token`. Valem para link aberto do WhatsApp ou do e-mail,
-- porque o link é do Asaas.
-- Sinal fraco: abertura/clique do e-mail pelo Resend (`email.opened` /
-- `email.clicked`, webhook assinado pelo Svix). Abertura é "provável": a
-- Proteção de Privacidade do Apple Mail baixa as imagens sozinha. Abertura de
-- e-mail só aparece no painel; não gera aviso no WhatsApp.
--
-- Cerca durável: uma linha por fatura por dia de Brasília em
-- payment_view_alerts; a chave única impede um segundo aviso no mesmo dia.
-- Re-executável.

alter table public.student_payments
  add column if not exists provider_viewed_at timestamptz,
  add column if not exists email_opened_at timestamptz,
  add column if not exists email_clicked_at timestamptz;

comment on column public.student_payments.provider_viewed_at is
  'Última visualização da fatura/boleto informada pelo Asaas (PAYMENT_CHECKOUT_VIEWED/PAYMENT_BANK_SLIP_VIEWED).';
comment on column public.student_payments.email_opened_at is
  'Última abertura PROVÁVEL de e-mail de cobrança (Resend email.opened; Apple Mail pode abrir sozinho).';
comment on column public.student_payments.email_clicked_at is
  'Último clique em link de e-mail de cobrança (Resend email.clicked).';

alter table public.payment_notification_email_attempts
  add column if not exists opened_at timestamptz,
  add column if not exists clicked_at timestamptz;
alter table public.daily_payment_email_attempts
  add column if not exists opened_at timestamptz,
  add column if not exists clicked_at timestamptz;
alter table public.payment_overdue_email_attempts
  add column if not exists opened_at timestamptz,
  add column if not exists clicked_at timestamptz;

create index if not exists payment_notification_email_attempts_message_idx
  on public.payment_notification_email_attempts (provider_message_id)
  where provider_message_id is not null;
create index if not exists daily_payment_email_attempts_message_idx
  on public.daily_payment_email_attempts (provider_message_id)
  where provider_message_id is not null;
create index if not exists payment_overdue_email_attempts_message_idx
  on public.payment_overdue_email_attempts (provider_message_id)
  where provider_message_id is not null;

create table if not exists public.payment_view_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  payment_id uuid not null references public.student_payments (id) on delete cascade,
  alert_date date not null,
  source text not null check (source in (
    'PAYMENT_CHECKOUT_VIEWED', 'PAYMENT_BANK_SLIP_VIEWED'
  )),
  provider_event_id text not null,
  viewed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (payment_id, alert_date)
);
alter table public.payment_view_alerts owner to postgres;
alter table public.payment_view_alerts enable row level security;
revoke all on public.payment_view_alerts from public, anon, authenticated;
grant select, insert on public.payment_view_alerts to service_role;
