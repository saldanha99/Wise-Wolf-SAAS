-- Teto mensal da API da Anthropic na Wise Wolf (22/11/2026, decisão do Vinícius).
--
-- A chave da Anthropic é compartilhada com o Lei Prova, que tem o próprio contador.
-- A Wise Wolf ganha o dela: o _shared/ai-gateway.ts mede cada chamada (usage da
-- resposta × preço do modelo) e soma aqui por provedor e mês UTC. Acima do teto
-- (ANTHROPIC_MONTHLY_BUDGET_USD, padrão US$ 50) o texto vai para o OpenRouter até
-- virar o mês. Aditiva: nenhuma tabela ou função existente muda.

create schema if not exists private;

create table if not exists private.ai_provider_monthly_spend (
  provider text not null,
  month date not null,
  usd numeric(14, 6) not null default 0,
  calls integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (provider, month),
  constraint ai_provider_monthly_spend_provider_check
    check (provider ~ '^[a-z0-9_-]{1,40}$'),
  constraint ai_provider_monthly_spend_usd_check check (usd >= 0),
  constraint ai_provider_monthly_spend_month_check
    check (month = date_trunc('month', month)::date)
);

alter table private.ai_provider_monthly_spend enable row level security;
revoke all on table private.ai_provider_monthly_spend from public, anon, authenticated;

create or replace function public.ai_provider_spend_add(p_provider text, p_usd numeric)
returns numeric
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_month date := pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'UTC')::date;
  v_total numeric;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{1,40}$' then
    raise exception 'ai_spend_invalid_provider' using errcode = '22023';
  end if;
  -- Uma chamada nunca custa US$ 100; acima disso é erro de medição.
  if p_usd is null or p_usd < 0 or p_usd > 100 then
    raise exception 'ai_spend_invalid_amount' using errcode = '22023';
  end if;

  insert into private.ai_provider_monthly_spend as s (provider, month, usd, calls)
  values (p_provider, v_month, p_usd, 1)
  on conflict (provider, month) do update
    set usd = s.usd + excluded.usd,
        calls = s.calls + 1,
        updated_at = pg_catalog.now()
  returning s.usd into v_total;

  return v_total;
end;
$$;

create or replace function public.ai_provider_spend_month(p_provider text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.usd
      from private.ai_provider_monthly_spend s
     where s.provider = p_provider
       and s.month = pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'UTC')::date
  ), 0);
$$;

revoke all on function public.ai_provider_spend_add(text, numeric) from public, anon, authenticated;
revoke all on function public.ai_provider_spend_month(text) from public, anon, authenticated;
grant execute on function public.ai_provider_spend_add(text, numeric) to service_role;
grant execute on function public.ai_provider_spend_month(text) to service_role;

comment on table private.ai_provider_monthly_spend is
  'Gasto de IA da Wise Wolf por provedor e mês UTC, medido no _shared/ai-gateway.ts (teto da Anthropic).';
