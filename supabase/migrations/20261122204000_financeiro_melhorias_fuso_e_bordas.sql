-- Inteligência financeira — melhorias da revisão (22/11/2026).
--
-- Aditiva: só "create or replace" das 3 funções das migrations 20261122200000 e
-- 20261122201000 (já aplicadas; não se editam). Mudanças:
--   * finance_student_economics: recebimento corta o mês em America/Sao_Paulo
--     (antes UTC: pagamento das 21h às 23h59 do último dia caía no mês seguinte);
--     netValue vazio ("") não derruba a função.
--   * finance_unit_economics: totais com coalesce (escola sem aluno no mês = 0).
--   * finance_pricing_overview: despesas com corte em America/Sao_Paulo e sem
--     DAS/imposto lançado no caixa (já vem do tax_fixed_monthly).

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
                 when nullif(sp.raw_payload -> 'payment' ->> 'netValue', '')::numeric < sp.value
                 then sp.value - nullif(sp.raw_payload -> 'payment' ->> 'netValue', '')::numeric
                 when coalesce(sp.billing_type, '') = 'CASH' or sp.status = 'RECEIVED_IN_CASH' then 0
                 else v_fee
               end) as taxa
      from public.student_payments sp
     where sp.tenant_id = p_tenant
       and sp.status in ('RECEIVED', 'RECEIVED_IN_CASH')
       and coalesce((sp.credited_at at time zone 'America/Sao_Paulo')::date, (sp.paid_at at time zone 'America/Sao_Paulo')::date, sp.payment_date, sp.due_date) >= v_start
       and coalesce((sp.credited_at at time zone 'America/Sao_Paulo')::date, (sp.paid_at at time zone 'America/Sao_Paulo')::date, sp.payment_date, sp.due_date) < v_end
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
      'mensalidades', coalesce(round(sum(e.mensalidade), 2), 0),
      'recebido', coalesce(round(sum(e.recebido), 2), 0),
      'repasse', coalesce(round(sum(e.repasse), 2), 0),
      'ia', coalesce(round(sum(e.ia), 2), 0),
      'asaas', coalesce(round(sum(e.asaas), 2), 0),
      'imposto', coalesce(round(sum(e.imposto), 2), 0),
      'margem', coalesce(round(sum(e.margem), 2), 0),
      'margem_pct', round(100 * sum(e.margem) / nullif(sum(e.mensalidade), 0), 1),
      -- Mesma conta, mas sobre o dinheiro que entrou (o que o DRE usa).
      'margem_sobre_recebido', coalesce(round(sum(e.recebido) - sum(e.repasse + e.ia + e.asaas + e.imposto), 2), 0),
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


create or replace function public.finance_pricing_overview(p_tenant text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_tenant text := coalesce(nullif(btrim(p_tenant), ''), private.active_tenant_id(auth.uid()));
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_end date;
  v_start date;
  v_cfg jsonb;
  v_fee numeric;
  v_tax_mode text;
  v_tax_pct numeric;
  v_tax_fixed numeric;
  v_extra numeric;
  v_aulas numeric;
  v_custo numeric;
  v_custo_aula numeric;
  v_ia_aluno numeric;
  v_aluno_meses numeric;
  v_aproveitamento numeric;
  v_despesas_mes numeric;
  v_fixos numeric;
  v_ativos int;
  v_receita_media numeric;
  v_contrib_media numeric;
  v_das_rateado numeric;
  v_last_month text;
  v_meses jsonb;
  v_planos jsonb;
  v_alertas jsonb := '[]'::jsonb;
begin
  if not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Sem permissão para consultar o financeiro' using errcode = '42501';
  end if;

  v_end := date_trunc('month', v_today)::date;          -- 1º dia do mês corrente
  v_start := (v_end - interval '3 months')::date;
  v_last_month := to_char(v_end - 1, 'YYYY-MM');
  v_cfg := private.finance_settings_effective(v_tenant);
  v_fee := (v_cfg ->> 'asaas_fee_per_charge')::numeric;
  v_tax_mode := v_cfg ->> 'tax_mode';
  v_tax_pct := case when v_tax_mode = 'PERCENT_REVENUE' then (v_cfg ->> 'tax_percent')::numeric else 0 end;
  v_tax_fixed := case when v_tax_mode = 'FIXED_MONTHLY' then (v_cfg ->> 'tax_fixed_monthly')::numeric else 0 end;
  v_extra := (v_cfg ->> 'extra_fixed_costs_monthly')::numeric;

  -- Custo médio por aula (3 meses fechados), mesma view que paga o professor.
  select count(*), coalesce(sum(coalesce(v.rate_efetivo, 0)), 0)
    into v_aulas, v_custo
    from public.v_payable_class_logs v
    join public.profiles t on t.id = v.teacher_id
   where t.tenant_id = v_tenant
     and v.class_date >= v_start and v.class_date < v_end;
  v_custo_aula := round(v_custo / nullif(v_aulas, 0), 2);

  -- Por aluno-mês nos 3 meses: IA média e aproveitamento (aulas dadas ÷ previstas).
  with m as (
    select to_char(d, 'YYYY-MM') as mes
      from generate_series(v_start, v_end - 1, interval '1 month') d
  ), e as (
    select m.mes, x.*
      from m cross join lateral private.finance_student_economics(v_tenant, m.mes) x
  ), mes as (
    select e.mes,
           count(*) filter (where e.mensalidade > 0) as pagantes,
           sum(e.mensalidade) as mensalidades,
           sum(e.mensalidade - e.repasse - e.ia - e.asaas
               - case when v_tax_mode = 'PERCENT_REVENUE' then e.imposto else 0 end)
             filter (where e.mensalidade > 0) as contrib
      from e group by e.mes
  )
  select
    (select round(sum(e.ia) / nullif(count(*) filter (where e.mensalidade > 0), 0), 2) from e),
    (select count(*) filter (where e.mensalidade > 0) from e),
    (select round(sum(e.aulas)::numeric
              / nullif(sum(e.classes_per_week * 52.0 / 12) filter (where e.classes_per_week > 0 and e.aulas > 0), 0), 3)
       from e where e.classes_per_week > 0 and e.aulas > 0),
    (select coalesce(jsonb_agg(jsonb_build_object(
        'mes', mes.mes, 'alunos_pagantes', mes.pagantes,
        'mensalidades', round(mes.mensalidades, 2),
        'margem_contribuicao', round(mes.contrib, 2)) order by mes.mes), '[]'::jsonb) from mes)
    into v_ia_aluno, v_aluno_meses, v_aproveitamento, v_meses;

  -- Despesas fixas lançadas no caixa (média mensal dos 3 meses fechados).
  select coalesce(sum(ft.amount), 0) / 3.0
    into v_despesas_mes
    from public.financial_transactions ft
    left join public.dre_category_map cm on cm.tenant_id = ft.tenant_id and cm.category = ft.category
    left join public.dre_accounts a on a.code = coalesce(ft.account_code, cm.account_code)
   where ft.tenant_id = v_tenant and ft.type = 'SAIDA'
     and ft.category is distinct from 'teacher_payout'
     and ft.refund_student_payment_id is null
     and coalesce(a.ledger_allowed, true)
     and coalesce(a.kind, 'DESPESA') = 'DESPESA'
     and coalesce(a.code, '6.9.99') not in ('6.1.01', '6.1.02', '6.3.02')
     -- DAS/imposto lançado no caixa não entra aqui: o imposto já vem de
     -- finance_settings (tax_fixed_monthly) e contaria duas vezes.
     and coalesce(a.code, '') <> '4.1.01'
     and lower(coalesce(ft.category, '')) !~ '(^|[^a-z])(das|simples|imposto|impostos)([^a-z]|$)'
     and lower(coalesce(ft.description, '')) !~ '(^|[^a-z])(guia (do )?das|das[ /-]?(mei|mensal|simples|[0-9])|simples nacional|imposto)([^a-z]|$)'
     and (coalesce(ft.occurred_at, ft.created_at) at time zone 'America/Sao_Paulo')::date >= v_start
     and (coalesce(ft.occurred_at, ft.created_at) at time zone 'America/Sao_Paulo')::date < v_end;

  v_fixos := round(v_despesas_mes + v_extra + v_tax_fixed, 2);

  -- Alunos pagantes e margem de contribuição do último mês fechado.
  select count(*) filter (where e.mensalidade > 0),
         round(avg(e.mensalidade) filter (where e.mensalidade > 0), 2),
         round(avg(e.mensalidade - e.repasse - e.ia - e.asaas
                   - case when v_tax_mode = 'PERCENT_REVENUE' then e.imposto else 0 end)
               filter (where e.mensalidade > 0), 2)
    into v_ativos, v_receita_media, v_contrib_media
    from private.finance_student_economics(v_tenant, v_last_month) e;

  v_das_rateado := case when v_tax_fixed > 0 and coalesce(v_ativos, 0) > 0
                        then round(v_tax_fixed / v_ativos, 2) else 0 end;

  -- Planos do catálogo com custo previsto e preço mínimo.
  with cur as (
    select e.classes_per_week, e.fidelity_months, count(*) as n
      from private.finance_student_economics(v_tenant, v_last_month) e
     where e.mensalidade > 0
     group by 1, 2
  ), p as (
    select sp.id, sp.name, sp.classes_per_week, sp.fidelity_months, sp.monthly_price,
           round(sp.classes_per_week * 52.0 / 12 * coalesce(v_aproveitamento, 1), 1) as aulas_mes,
           round(sp.classes_per_week * 52.0 / 12 * coalesce(v_aproveitamento, 1) * coalesce(v_custo_aula, 0), 2) as repasse
      from public.student_pricing_plans sp
     where sp.tenant_id = v_tenant and sp.active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'plan_id', p.id, 'plano', p.name,
      'aulas_semana', p.classes_per_week, 'fidelidade_meses', p.fidelity_months,
      'preco', p.monthly_price,
      'aulas_mes', p.aulas_mes,
      'repasse', p.repasse,
      'ia', coalesce(v_ia_aluno, 0),
      'asaas', v_fee,
      'imposto', round(p.monthly_price * v_tax_pct / 100.0 + v_das_rateado, 2),
      'margem', round(p.monthly_price - p.repasse - coalesce(v_ia_aluno, 0) - v_fee
                      - p.monthly_price * v_tax_pct / 100.0 - v_das_rateado, 2),
      'margem_pct', round(100 * (p.monthly_price - p.repasse - coalesce(v_ia_aluno, 0) - v_fee
                      - p.monthly_price * v_tax_pct / 100.0 - v_das_rateado) / nullif(p.monthly_price, 0), 1),
      'preco_minimo', round((p.repasse + coalesce(v_ia_aluno, 0) + v_fee + v_das_rateado)
                      / (1 - v_tax_pct / 100.0), 2),
      'alunos_no_plano', coalesce(c.n, 0)
    ) order by p.classes_per_week, p.fidelity_months desc), '[]'::jsonb)
    into v_planos
    from p
    left join cur c on c.classes_per_week = p.classes_per_week and c.fidelity_months = p.fidelity_months;

  if v_tax_mode = 'UNSET' then
    v_alertas := v_alertas || jsonb_build_object('nivel', 'atencao',
      'texto', 'Imposto ainda não configurado: preços mínimos e ponto de equilíbrio estão SEM imposto.');
  end if;
  if v_despesas_mes < 500 and v_extra = 0 then
    v_alertas := v_alertas || jsonb_build_object('nivel', 'critico',
      'texto', 'Poucas despesas fixas lançadas no caixa (média de R$ ' ||
        translate(to_char(v_despesas_mes, 'FM999G990D00'), ',.', '.,') ||
        '/mês). Sem aluguel, pró-labore, ferramentas e marketing, o ponto de equilíbrio fica baixo demais. Lance as despesas ou informe os custos fixos extras em Configurar.');
  end if;

  return jsonb_build_object(
    'base', jsonb_build_object('de', to_char(v_start, 'YYYY-MM'), 'ate', v_last_month),
    'config', v_cfg,
    'custo_por_aula', v_custo_aula,
    'aulas_base', v_aulas,
    'aproveitamento', v_aproveitamento,
    'ia_por_aluno', coalesce(v_ia_aluno, 0),
    'asaas_por_cobranca', v_fee,
    'imposto_pct', v_tax_pct,
    'das_rateado', v_das_rateado,
    'meses', v_meses,
    'planos', v_planos,
    'equilibrio', jsonb_build_object(
      'despesas_lancadas_mes', round(v_despesas_mes, 2),
      'custos_fixos_extras', v_extra,
      'das_fixo', v_tax_fixed,
      'custos_fixos_mes', v_fixos,
      'alunos_pagantes', coalesce(v_ativos, 0),
      'mensalidade_media', v_receita_media,
      'margem_contribuicao_media', v_contrib_media,
      'alunos_para_empatar', case when coalesce(v_contrib_media, 0) > 0
                                  then ceil(v_fixos / v_contrib_media)::int end,
      'receita_para_empatar', case when coalesce(v_contrib_media, 0) > 0
                                   then round(ceil(v_fixos / v_contrib_media) * v_receita_media, 2) end,
      'folga_alunos', case when coalesce(v_contrib_media, 0) > 0
                           then coalesce(v_ativos, 0) - ceil(v_fixos / v_contrib_media)::int end,
      'resultado_estimado', round(coalesce(v_ativos, 0) * coalesce(v_contrib_media, 0) - v_fixos, 2)
    ),
    'alertas', v_alertas
  );
end;
$$;


revoke all on function private.finance_student_economics(text, text) from public, anon, authenticated;
revoke all on function public.finance_unit_economics(text, text) from public, anon;
revoke all on function public.finance_pricing_overview(text) from public, anon;
grant execute on function public.finance_unit_economics(text, text) to authenticated, service_role;
grant execute on function public.finance_pricing_overview(text) to authenticated, service_role;
