-- Inteligência financeira (2/3): precificação por plano e ponto de equilíbrio.
--
-- Aditiva e re-executável. Base: os 3 últimos meses FECHADOS (o corrente é parcial).
--
-- Custo de um plano = aulas previstas (aulas/semana × 52/12) × custo médio por aula
--                   + IA média por aluno + taxa Asaas por cobrança
-- Imposto: % sobre o preço (PERCENT_REVENUE) ou DAS fixo rateado (FIXED_MONTHLY).
-- Preço mínimo (lucro zero), divisor de markup do MotoFix:
--     (custo variável + DAS rateado) ÷ (1 − imposto%)
-- Ponto de equilíbrio = custos fixos do mês ÷ margem de contribuição média por aluno.
--     custos fixos = média das despesas lançadas no caixa (DESPESA, fora comissões/
--     indicações, que são variáveis) + custos fixos extras configurados + DAS fixo.

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
     and coalesce(ft.occurred_at, ft.created_at) >= v_start
     and coalesce(ft.occurred_at, ft.created_at) < v_end;

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

revoke all on function public.finance_pricing_overview(text) from public, anon;
grant execute on function public.finance_pricing_overview(text) to authenticated, service_role;
