-- Frequência pretendida do lead (sondagem antes da experimental, 12/11/2026).
-- É intenção, não plano: serve para oferecer horário de experimental que
-- comporte a continuidade e para o convite ao professor. Nada é reservado.
alter table public.crm_leads
  add column if not exists weekly_frequency smallint;

alter table public.crm_leads
  drop constraint if exists crm_leads_weekly_frequency_range;
alter table public.crm_leads
  add constraint crm_leads_weekly_frequency_range
  check (weekly_frequency is null or weekly_frequency between 1 and 6);

comment on column public.crm_leads.weekly_frequency is
  'Quantas vezes por semana o lead pensa em estudar (sondagem da atendente; não reserva agenda).';
