-- Idade do lead e contato do responsável antes da experimental.
-- Regra da direção (11/11/2026): a atendente sempre pergunta a idade; menor de
-- 18 anos só tem a experimental pedida aos professores com o contato de um
-- responsável ciente. Quem decide é o código da atendente (lead-age.ts); aqui
-- só os campos. Reexecutável.

alter table public.crm_leads add column if not exists age smallint;
alter table public.crm_leads add column if not exists guardian_name text;
alter table public.crm_leads add column if not exists guardian_phone text;

alter table public.crm_leads drop constraint if exists crm_leads_age_plausible;
alter table public.crm_leads add constraint crm_leads_age_plausible
  check (age is null or age between 3 and 99);

comment on column public.crm_leads.age is
  'Idade informada pelo lead na conversa com a atendente. Menor de 18 exige guardian_phone antes da experimental.';
comment on column public.crm_leads.guardian_phone is
  'WhatsApp do responsável (só dígitos, com 55) informado pelo lead menor de idade.';
