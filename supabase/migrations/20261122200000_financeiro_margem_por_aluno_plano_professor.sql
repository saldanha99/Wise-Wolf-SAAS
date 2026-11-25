-- Inteligência financeira (1/3): margem por aluno, por plano e por professor.
--
-- margem = mensalidade − repasse ao professor − IA/Wolfie − taxa Asaas − imposto
--
-- Aditiva e re-executável: só cria a tabela de configuração e funções novas.
-- dre_gerencial, director_teacher_margin e ai_cost_por_aluno ficam como estão.
--
-- Fontes:
--   repasse  → v_payable_class_logs.rate_efetivo (a mesma view que paga o professor)
--   voz      → wolfie_live_grants.consumed_seconds × R$/min configurado
--   texto IA → ai_usage_events × ai_model_pricing × câmbio configurado
--   Asaas    → value − raw_payload.payment.netValue do pagamento recebido no mês;
--              sem pagamento no mês, a taxa padrão por cobrança
--   imposto  → finance_settings (regime ainda NÃO cadastrado = 0 + alerta)
-- Mês corrente: valores realizados até hoje + projeção linear pelos dias do mês.

create table if not exists public.finance_settings (
  tenant_id text primary key references public.tenants(id) on delete cascade,
  tax_mode text not null default 'UNSET'
    check (tax_mode in ('UNSET', 'PERCENT_REVENUE', 'FIXED_MONTHLY')),
  tax_percent numeric(5,2) not null default 0
    check (tax_percent >= 0 and tax_percent < 50),
  tax_fixed_monthly numeric(10,2) not null default 0
    check (tax_fixed_monthly >= 0),
  voice_brl_per_minute numeric(8,4) not null default 0.42
    check (voice_brl_per_minute >= 0),
  asaas_fee_per_charge numeric(8,2) not null default 1.99
    check (asaas_fee_per_charge >= 0),
  usd_brl numeric(8,4) not null default 5.50
    check (usd_brl > 0),
  -- Custos fixos que não passam pelo caixa do sistema (pró-labore, aluguel pago
  -- por fora). Somados à média das despesas lançadas no ponto de equilíbrio.
  extra_fixed_costs_monthly numeric(10,2) not null default 0
    check (extra_fixed_costs_monthly >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.finance_settings enable row level security;
revoke all on table public.finance_settings from anon, authenticated;
grant select, insert, update, delete on table public.finance_settings to service_role;

comment on table public.finance_settings is
  'Parâmetros da inteligência financeira por escola (imposto, R$/min da voz, taxa Asaas, câmbio). Lida e gravada só pelas RPCs finance_*.';

-- ── Configuração efetiva (linha ou padrão) ──────────────────────────────────
create or replace function private.finance_settings_effective(p_tenant text)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object(
    'tax_mode',                 coalesce(s.tax_mode, 'UNSET'),
    'tax_percent',              coalesce(s.tax_percent, 0),
    'tax_fixed_monthly',        coalesce(s.tax_fixed_monthly, 0),
    'voice_brl_per_minute',     coalesce(s.voice_brl_per_minute, 0.42),
    'asaas_fee_per_charge',     coalesce(s.asaas_fee_per_charge, 1.99),
    'usd_brl',                  coalesce(s.usd_brl, 5.50),
    'extra_fixed_costs_monthly', coalesce(s.extra_fixed_costs_monthly, 0),
    'saved',                    s.tenant_id is not null,
    'updated_at',               s.updated_at
  )
  from (select 1) one
  left join public.finance_settings s on s.tenant_id = p_tenant;
$$;
revoke all on function private.finance_settings_effective(text) from public, anon, authenticated;

-- ── Leitura/gravação da configuração pela direção ───────────────────────────
create or replace function public.finance_settings_get(p_tenant text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_tenant text := coalesce(nullif(btrim(p_tenant), ''), private.active_tenant_id(auth.uid()));
begin
  if not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Sem permissão para consultar o financeiro' using errcode = '42501';
  end if;
  return private.finance_settings_effective(v_tenant);
end;
$$;

create or replace function public.finance_settings_save(
  p_settings jsonb,
  p_tenant text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_tenant text := coalesce(nullif(btrim(p_tenant), ''), private.active_tenant_id(auth.uid()));
  v_cur jsonb;
begin
  -- Coordenação lê; só direção grava.
  if not private.can_execute_legacy_role_rpc(array['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[])
     or not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Só a direção altera a configuração financeira' using errcode = '42501';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Configuração inválida';
  end if;

  v_cur := private.finance_settings_effective(v_tenant);

  insert into public.finance_settings as s (
    tenant_id, tax_mode, tax_percent, tax_fixed_monthly, voice_brl_per_minute,
    asaas_fee_per_charge, usd_brl, extra_fixed_costs_monthly, updated_at, updated_by
  ) values (
    v_tenant,
    coalesce(p_settings ->> 'tax_mode', v_cur ->> 'tax_mode'),
    coalesce((p_settings ->> 'tax_percent')::numeric, (v_cur ->> 'tax_percent')::numeric),
    coalesce((p_settings ->> 'tax_fixed_monthly')::numeric, (v_cur ->> 'tax_fixed_monthly')::numeric),
    coalesce((p_settings ->> 'voice_brl_per_minute')::numeric, (v_cur ->> 'voice_brl_per_minute')::numeric),
    coalesce((p_settings ->> 'asaas_fee_per_charge')::numeric, (v_cur ->> 'asaas_fee_per_charge')::numeric),
    coalesce((p_settings ->> 'usd_brl')::numeric, (v_cur ->> 'usd_brl')::numeric),
    coalesce((p_settings ->> 'extra_fixed_costs_monthly')::numeric, (v_cur ->> 'extra_fixed_costs_monthly')::numeric),
    now(),
    auth.uid()
  )
  on conflict (tenant_id) do update set
    tax_mode = excluded.tax_mode,
    tax_percent = excluded.tax_percent,
    tax_fixed_monthly = excluded.tax_fixed_monthly,
    voice_brl_per_minute = excluded.voice_brl_per_minute,
    asaas_fee_per_charge = excluded.asaas_fee_per_charge,
    usd_brl = excluded.usd_brl,
    extra_fixed_costs_monthly = excluded.extra_fixed_costs_monthly,
    updated_at = now(),
    updated_by = auth.uid();

  return private.finance_settings_effective(v_tenant);
end;
$$;

-- ── Plano do aluno: frequência + fidelidade → chave legível ─────────────────
create or replace function private.finance_student_plan(
  p_class_frequency text,
  p_fidelity_plan text
)
returns table (classes_per_week int, fidelity_months int, plan_key text)
language sql
immutable
set search_path to ''
as $$
  with x as (
    select
      nullif(regexp_replace(coalesce(p_class_frequency, ''), '\D', '', 'g'), '')::int as cpw,
      case upper(btrim(coalesce(p_fidelity_plan, '')))
        when 'ANNUAL' then 12
        when 'SEMESTER' then 6
        when 'RECURRENT' then 1
        else null
      end as fid
  )
  select
    x.cpw,
    x.fid,
    case
      when x.cpw is null then 'Personalizado'
      else x.cpw::text || 'x/semana · ' ||
        case x.fid when 12 then 'anual' when 6 then 'semestral' when 1 then 'mensal' else 'sem fidelidade' end
    end
  from x;
$$;

-- ── Núcleo: uma linha por aluno, sem checagem de permissão ──────────────────
create or replace function private.finance_student_economics(p_tenant text, p_month text)
returns table (
  student_id uuid,
  student_name text,
  plan_key text,
  classes_per_week int,
  fidelity_months int,
  list_price numeric,
  mensalidade numeric,
  recebido numeric,
  aulas int,
  repasse numeric,
  voz_minutos numeric,
  ia numeric,
  asaas numeric,
  imposto numeric,
  margem numeric
)
language plpgsql
stable
security definer
set search_path to ''
as $$
#variable_conflict use_column
declare
  v_start date := to_date(p_month || '-01', 'YYYY-MM-DD');
  v_end date := (to_date(p_month || '-01', 'YYYY-MM-DD') + interval '1 month')::date;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_factor numeric := 1;
  v_cfg jsonb := private.finance_settings_effective(p_tenant);
  v_voice numeric := (v_cfg ->> 'voice_brl_per_minute')::numeric;
  v_fee numeric := (v_cfg ->> 'asaas_fee_per_charge')::numeric;
  v_usd numeric := (v_cfg ->> 'usd_brl')::numeric;
  v_tax_mode text := v_cfg ->> 'tax_mode';
  v_tax_pct numeric := (v_cfg ->> 'tax_percent')::numeric;
  v_tax_fixed numeric := (v_cfg ->> 'tax_fixed_monthly')::numeric;
begin
  -- Mês corrente: projeta pelo ritmo (dias do mês ÷ dias decorridos).
  if v_today >= v_start and v_today < v_end then
    v_factor := (v_end - v_start)::numeric / greatest((v_today - v_start) + 1, 1);
  end if;

  return query
  with base as (
    select p.id, trim(p.full_name) as nome, coalesce(p.monthly_fee, 0) as fee,
           p.class_frequency, p.fidelity_plan,
           (lower(coalesce(p.lifecycle_status, '')) = 'active' and p.status = 'Ativo') as ativo
      from public.profiles p
     where p.tenant_id = p_tenant
       and p.role = 'STUDENT'
       and not coalesce(p.is_test_account, false)
  ), aulas as (
    select v.student_id, count(*)::int as n, sum(coalesce(v.rate_efetivo, 0)) as custo
      from public.v_payable_class_logs v
      join public.profiles t on t.id = v.teacher_id
     where t.tenant_id = p_tenant
       and v.student_id is not null
       and v.class_date >= v_start and v.class_date < v_end
     group by 1
  ), voz as (
    select g.student_id, sum(coalesce(g.consumed_seconds, 0)) / 60.0 as minutos
      from public.wolfie_live_grants g
     where g.tenant_id = p_tenant
       and (g.created_at at time zone 'America/Sao_Paulo')::date >= v_start
       and (g.created_at at time zone 'America/Sao_Paulo')::date < v_end
     group by 1
  ), texto as (
    select e.user_id as student_id,
           sum((greatest(e.input_tokens - coalesce(e.cached_tokens, 0), 0) * coalesce(pr.input_usd_per_1m, 0)
              + coalesce(e.cached_tokens, 0) * coalesce(pr.cached_usd_per_1m, 0)
              + e.output_tokens * coalesce(pr.output_usd_per_1m, 0)) / 1000000.0) as usd
      from public.ai_usage_events e
      left join public.ai_model_pricing pr on pr.model = e.model
     where e.tenant_id = p_tenant and e.user_id is not null
       and (e.created_at at time zone 'America/Sao_Paulo')::date >= v_start
       and (e.created_at at time zone 'America/Sao_Paulo')::date < v_end
     group by 1
  ), pagos as (
    select sp.student_id,
           sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)) as recebido,
           sum(case
                 when sp.raw_payload -> 'payment' ? 'netValue'
                  and (sp.raw_payload -> 'payment' ->> 'netValue')::numeric < sp.value
                 then sp.value - (sp.raw_payload -> 'payment' ->> 'netValue')::numeric
                 when coalesce(sp.billing_type, '') = 'CASH' or sp.status = 'RECEIVED_IN_CASH' then 0
                 else v_fee
               end) as taxa
      from public.student_payments sp
     where sp.tenant_id = p_tenant
       and sp.status in ('RECEIVED', 'RECEIVED_IN_CASH')
       and coalesce(sp.credited_at::date, sp.paid_at::date, sp.payment_date, sp.due_date) >= v_start
       and coalesce(sp.credited_at::date, sp.paid_at::date, sp.payment_date, sp.due_date) < v_end
     group by 1
  ), linhas as (
    select b.id, b.nome, pl.plan_key, pl.classes_per_week, pl.fidelity_months, b.fee,
           coalesce(pg.recebido, 0) as recebido,
           coalesce(a.n, 0) as n_aulas,
           round(coalesce(a.custo, 0) * v_factor, 2) as repasse,
           round(coalesce(vz.minutos, 0) * v_factor, 1) as minutos,
           round((coalesce(vz.minutos, 0) * v_voice + coalesce(tx.usd, 0) * v_usd) * v_factor, 2) as ia,
           round(case when pg.student_id is not null then pg.taxa
                      when b.fee > 0 then v_fee else 0 end, 2) as asaas,
           (select sp2.monthly_price
              from public.student_pricing_plans sp2
             where sp2.tenant_id = p_tenant and sp2.active
               and sp2.classes_per_week = pl.classes_per_week
               and (sp2.fidelity_months = pl.fidelity_months
                    or (pl.fidelity_months is null and sp2.monthly_price = b.fee))
             order by (sp2.fidelity_months = pl.fidelity_months) desc nulls last
             limit 1) as list_price
      from base b
      cross join lateral private.finance_student_plan(b.class_frequency, b.fidelity_plan) pl
      left join aulas a on a.student_id = b.id
      left join voz vz on vz.student_id = b.id
      left join texto tx on tx.student_id = b.id
      left join pagos pg on pg.student_id = b.id
     -- Entra quem está ativo, teve aula ou pagou no mês.
     where b.ativo or a.student_id is not null or pg.student_id is not null
  ), com_imposto as (
    select l.*,
           round(case v_tax_mode
                   when 'PERCENT_REVENUE' then l.fee * v_tax_pct / 100.0
                   when 'FIXED_MONTHLY' then
                     case when l.fee > 0
                          then v_tax_fixed / nullif((select count(*) from linhas l2 where l2.fee > 0), 0)
                          else 0 end
                   else 0
                 end, 2) as imposto
      from linhas l
  )
  select c.id, c.nome, c.plan_key, c.classes_per_week, c.fidelity_months, c.list_price,
         c.fee, c.recebido,
         round(c.n_aulas * v_factor)::int,
         c.repasse, c.minutos, c.ia, c.asaas, c.imposto,
         round(c.fee - c.repasse - c.ia - c.asaas - c.imposto, 2)
    from com_imposto c;
end;
$$;
revoke all on function private.finance_student_economics(text, text) from public, anon, authenticated;

-- ── RPC da tela: aluno, plano e professor ───────────────────────────────────
create or replace function public.finance_unit_economics(
  p_month text default null,
  p_tenant text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_tenant text := coalesce(nullif(btrim(p_tenant), ''), private.active_tenant_id(auth.uid()));
  v_month text;
  v_start date;
  v_end date;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_factor numeric := 1;
  v_cfg jsonb;
  v_alertas jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Sem permissão para consultar o financeiro' using errcode = '42501';
  end if;

  v_month := coalesce(nullif(btrim(p_month), ''), to_char(v_today, 'YYYY-MM'));
  if v_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Mês inválido (use AAAA-MM)';
  end if;
  v_start := to_date(v_month || '-01', 'YYYY-MM-DD');
  v_end := (v_start + interval '1 month')::date;
  if v_today >= v_start and v_today < v_end then
    v_factor := (v_end - v_start)::numeric / greatest((v_today - v_start) + 1, 1);
  end if;
  v_cfg := private.finance_settings_effective(v_tenant);

  if v_cfg ->> 'tax_mode' = 'UNSET' then
    v_alertas := v_alertas || jsonb_build_object('nivel', 'atencao',
      'texto', 'Imposto ainda não configurado: a margem abaixo NÃO desconta imposto. Informe o regime (DAS fixo ou % da receita) em Configurar.');
  end if;
  if v_factor > 1 then
    v_alertas := v_alertas || jsonb_build_object('nivel', 'info',
      'texto', 'Mês em andamento: repasse, aulas e IA estão projetados pelo ritmo dos ' ||
        ((v_today - v_start) + 1)::text || ' primeiros dias (×' || round(v_factor, 2)::text || ').');
  end if;

  with e as (
    select * from private.finance_student_economics(v_tenant, v_month)
  ), alunos as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'student_id', e.student_id, 'aluno', e.student_name, 'plano', e.plan_key,
      'preco_lista', e.list_price, 'mensalidade', e.mensalidade, 'recebido', e.recebido,
      'aulas', e.aulas, 'repasse', e.repasse, 'voz_minutos', e.voz_minutos, 'ia', e.ia,
      'asaas', e.asaas, 'imposto', e.imposto, 'margem', e.margem,
      'margem_pct', case when e.mensalidade > 0 then round(100 * e.margem / e.mensalidade, 1) end
    ) order by e.margem), '[]'::jsonb) as j
    from e
  ), planos as (
    select coalesce(jsonb_agg(x order by (x ->> 'margem_media')::numeric), '[]'::jsonb) as j
    from (
      select jsonb_build_object(
        'plano', e.plan_key,
        'aulas_semana', max(e.classes_per_week),
        'fidelidade_meses', max(e.fidelity_months),
        'preco_lista', max(e.list_price),
        'alunos', count(*),
        'alunos_com_prejuizo', count(*) filter (where e.margem < 0),
        'alunos_sem_aula', count(*) filter (where e.aulas = 0),
        'mensalidade_media', round(avg(e.mensalidade), 2),
        'aulas_media', round(avg(e.aulas), 1),
        'repasse_medio', round(avg(e.repasse), 2),
        'ia_media', round(avg(e.ia), 2),
        'asaas_media', round(avg(e.asaas), 2),
        'imposto_medio', round(avg(e.imposto), 2),
        'margem_media', round(avg(e.margem), 2),
        'margem_total', round(sum(e.margem), 2),
        'margem_pct', round(100 * sum(e.margem) / nullif(sum(e.mensalidade), 0), 1)
      ) as x
      from e
      group by e.plan_key
    ) z
  ), fora as (
    select count(*) as n, sum(coalesce(v.rate_efetivo, 0)) as custo
      from public.v_payable_class_logs v
      join public.profiles t on t.id = v.teacher_id
     where t.tenant_id = v_tenant
       and v.class_date >= v_start and v.class_date < v_end
       and (v.student_id is null or not exists (select 1 from e where e.student_id = v.student_id))
  ), aulas_prof as (
    -- Rateio: receita e custos não-docentes do aluno vão para cada professor
    -- na proporção das aulas que ele deu ao aluno no mês.
    select t.id as teacher_id, trim(t.full_name) as teacher_name, v.student_id,
           count(*) as n, sum(coalesce(v.rate_efetivo, 0)) as custo
      from public.v_payable_class_logs v
      join public.profiles t on t.id = v.teacher_id
     where t.tenant_id = v_tenant and v.student_id is not null
       and v.class_date >= v_start and v.class_date < v_end
     group by 1, 2, 3
  ), share as (
    select ap.*, ap.n::numeric / sum(ap.n) over (partition by ap.student_id) as w
      from aulas_prof ap
  ), professores as (
    select coalesce(jsonb_agg(x order by (x ->> 'margem')::numeric), '[]'::jsonb) as j
    from (
      select jsonb_build_object(
        'teacher_id', s.teacher_id,
        'professor', s.teacher_name,
        'alunos', count(distinct s.student_id),
        'aulas', round(sum(s.n) * v_factor)::int,
        'receita', round(sum(e.mensalidade * s.w), 2),
        'repasse', round(sum(s.custo) * v_factor, 2),
        'outros_custos', round(sum((e.ia + e.asaas + e.imposto) * s.w), 2),
        'margem', round(sum(e.mensalidade * s.w) - sum(s.custo) * v_factor
                        - sum((e.ia + e.asaas + e.imposto) * s.w), 2),
        'margem_pct', round(100 * (sum(e.mensalidade * s.w) - sum(s.custo) * v_factor
                        - sum((e.ia + e.asaas + e.imposto) * s.w)) / nullif(sum(e.mensalidade * s.w), 0), 1)
      ) as x
      from share s
      join e on e.student_id = s.student_id
      group by s.teacher_id, s.teacher_name
    ) z
  ), total as (
    select jsonb_build_object(
      'alunos', count(*),
      'alunos_com_prejuizo', count(*) filter (where e.margem < 0),
      'alunos_sem_aula', count(*) filter (where e.aulas = 0),
      'mensalidades', round(sum(e.mensalidade), 2),
      'recebido', round(sum(e.recebido), 2),
      'repasse', round(sum(e.repasse), 2),
      'ia', round(sum(e.ia), 2),
      'asaas', round(sum(e.asaas), 2),
      'imposto', round(sum(e.imposto), 2),
      'margem', round(sum(e.margem), 2),
      'margem_pct', round(100 * sum(e.margem) / nullif(sum(e.mensalidade), 0), 1),
      -- Mesma conta, mas sobre o dinheiro que entrou (o que o DRE usa).
      'margem_sobre_recebido', round(sum(e.recebido) - sum(e.repasse + e.ia + e.asaas + e.imposto), 2),
      -- Aulas pagáveis sem aluno da lista (experimental, treinamento, aluno de teste).
      'repasse_fora_de_aluno', (select round(coalesce(sum(o.custo), 0) * v_factor, 2) from fora o),
      'aulas_fora_de_aluno', (select round(coalesce(sum(o.n), 0) * v_factor)::int from fora o)
    ) as j
    from e
  )
  select jsonb_build_object(
    'month', v_month,
    'projetado', v_factor > 1,
    'fator_projecao', round(v_factor, 4),
    'config', v_cfg,
    'total', (select j from total),
    'planos', (select j from planos),
    'professores', (select j from professores),
    'alunos', (select j from alunos),
    'alertas', v_alertas
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.finance_settings_get(text) from public, anon;
revoke all on function public.finance_settings_save(jsonb, text) from public, anon;
revoke all on function public.finance_unit_economics(text, text) from public, anon;
grant execute on function public.finance_settings_get(text) to authenticated, service_role;
grant execute on function public.finance_settings_save(jsonb, text) to authenticated, service_role;
grant execute on function public.finance_unit_economics(text, text) to authenticated, service_role;
