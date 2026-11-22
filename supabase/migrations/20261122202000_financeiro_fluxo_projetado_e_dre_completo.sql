-- Inteligência financeira (3/3): fluxo de caixa projetado e DRE mensal completo.
--
-- Aditiva e re-executável. Não altera get_cashflow nem dre_gerencial: lê deles.
--
-- Fluxo projetado (mês corrente + N meses):
--   entradas = cobranças já geradas no mês (PENDING/OVERDUE do mês, não cobertas)
--              + mensalidade dos alunos ativos que ainda não têm cobrança no mês
--              (assinatura que o Asaas vai gerar); no mês corrente soma o já recebido.
--   saídas   = repasse previsto (média dos 3 meses fechados) + fechamentos de
--              professor ainda não pagos (no mês corrente) + despesas fixas médias
--              + custos fixos extras + imposto + taxa Asaas + IA média.
--   Sem saldo bancário no sistema: o acumulado parte de zero.
--
-- DRE completo (12 meses): dre_gerencial de cada mês + linhas que ele não tem:
--   4.1.90 Taxas do Asaas (value − netValue dos recebidos)
--   4.1.91 Imposto estimado (só se não houver imposto lançado em 4.1.01 no mês)
--   5.1.90 IA / Wolfie (uso medido × preço)

create or replace function public.finance_cashflow_projection(
  p_months int default 6,
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
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_cur date := date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date;
  v_base_start date;
  v_cfg jsonb;
  v_fee numeric;
  v_tax_mode text;
  v_tax_pct numeric;
  v_tax_fixed numeric;
  v_extra numeric;
  v_repasse_mes numeric;
  v_despesas_mes numeric;
  v_ia_mes numeric;
  v_fech_pendente numeric;
  v_fech_antigo numeric;
  v_n int := least(greatest(coalesce(p_months, 6), 1), 12);
  v_rows jsonb := '[]'::jsonb;
  v_acum numeric := 0;
  m date;
  v_recebido numeric;
  v_geradas numeric;
  v_n_geradas int;
  v_assinaturas numeric;
  v_n_assin int;
  v_entradas numeric;
  v_imposto numeric;
  v_asaas numeric;
  v_saidas numeric;
  v_saidas_feitas numeric;
  v_cash jsonb;
begin
  if not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Sem permissão para consultar o financeiro' using errcode = '42501';
  end if;

  v_base_start := (v_cur - interval '3 months')::date;
  v_cfg := private.finance_settings_effective(v_tenant);
  v_fee := (v_cfg ->> 'asaas_fee_per_charge')::numeric;
  v_tax_mode := v_cfg ->> 'tax_mode';
  v_tax_pct := case when v_tax_mode = 'PERCENT_REVENUE' then (v_cfg ->> 'tax_percent')::numeric else 0 end;
  v_tax_fixed := case when v_tax_mode = 'FIXED_MONTHLY' then (v_cfg ->> 'tax_fixed_monthly')::numeric else 0 end;
  v_extra := (v_cfg ->> 'extra_fixed_costs_monthly')::numeric;

  select coalesce(sum(coalesce(v.rate_efetivo, 0)), 0) / 3.0
    into v_repasse_mes
    from public.v_payable_class_logs v
    join public.profiles t on t.id = v.teacher_id
   where t.tenant_id = v_tenant and v.class_date >= v_base_start and v.class_date < v_cur;

  select coalesce(sum(ft.amount), 0) / 3.0
    into v_despesas_mes
    from public.financial_transactions ft
    left join public.dre_category_map cm on cm.tenant_id = ft.tenant_id and cm.category = ft.category
    left join public.dre_accounts a on a.code = coalesce(ft.account_code, cm.account_code)
   where ft.tenant_id = v_tenant and ft.type = 'SAIDA'
     and ft.category is distinct from 'teacher_payout'
     and ft.category is distinct from 'estorno_aporte_ou_movimentacao'
     and ft.refund_student_payment_id is null
     and coalesce(a.code, '6.9.99') <> '5.1.01'
     and coalesce(ft.occurred_at, ft.created_at) >= v_base_start
     and coalesce(ft.occurred_at, ft.created_at) < v_cur;

  select coalesce(sum(e.ia), 0) / 3.0
    into v_ia_mes
    from generate_series(v_base_start, v_cur - 1, interval '1 month') d
    cross join lateral private.finance_student_economics(v_tenant, to_char(d, 'YYYY-MM')) e;

  -- Folha dos 2 meses anteriores ainda sem pagamento: sai no mês corrente.
  -- Fechamento mais antigo em aberto é pendência de cadastro (pago por fora),
  -- não dinheiro a sair: vai para o alerta, não para a projeção.
  select coalesce(sum(tc.total_amount) filter (
           where tc.month_year >= to_char(v_cur - interval '2 months', 'YYYY-MM')), 0),
         coalesce(sum(tc.total_amount) filter (
           where tc.month_year < to_char(v_cur - interval '2 months', 'YYYY-MM')), 0)
    into v_fech_pendente, v_fech_antigo
    from public.teacher_closings tc
   where tc.tenant_id = v_tenant
     and tc.status in ('PENDENTE', 'UNDER_REVIEW')
     and tc.paid_at is null
     and tc.month_year < to_char(v_cur, 'YYYY-MM');

  -- get_cashflow_unchecked deriva a escola do auth.uid(): só serve quando a
  -- escola pedida é a de quem consulta (super admin olhando outra escola não
  -- pode receber o caixa da própria).
  if v_tenant is not distinct from (select p.tenant_id from public.profiles p where p.id = auth.uid()) then
    v_cash := public.get_cashflow_unchecked(to_char(v_cur, 'YYYY-MM'));
  else
    v_cash := jsonb_build_object('entradas', null, 'saidas', jsonb_build_object('total', null, 'professores', null, 'despesas', null), 'inadimplencia', null);
  end if;

  for i in 0 .. v_n - 1 loop
    m := (v_cur + make_interval(months => i))::date;

    select coalesce(sum(sp.value), 0), count(*)
      into v_geradas, v_n_geradas
      from public.student_payments sp
     where sp.tenant_id = v_tenant
       and sp.status in ('PENDING', 'OVERDUE', 'CONFIRMED')
       and sp.due_date >= m and sp.due_date < (m + interval '1 month')::date
       and not private.student_payment_is_covered(sp.id);

    -- Meses seguintes: aluno ativo pagante sem cobrança com vencimento no mês
    -- (a assinatura vai gerar). Não entra no mês corrente (a cobrança do mês já
    -- existiria) nem quem pagou o plano adiantado (recebimento ≥ 3 mensalidades
    -- nos últimos 12 meses).
    select coalesce(sum(p.monthly_fee), 0), count(*)
      into v_assinaturas, v_n_assin
      from public.profiles p
     where i > 0
       and p.tenant_id = v_tenant and p.role = 'STUDENT'
       and not coalesce(p.is_test_account, false)
       and p.status = 'Ativo' and lower(coalesce(p.lifecycle_status, '')) = 'active'
       and coalesce(p.monthly_fee, 0) > 0
       and not exists (
         select 1 from public.student_payments sp
          where sp.student_id = p.id and sp.tenant_id = v_tenant
            and sp.due_date >= m and sp.due_date < (m + interval '1 month')::date
            and sp.status not in ('DELETED', 'CANCELLED', 'REFUNDED'))
       and not exists (
         select 1 from public.student_payments sp
          where sp.student_id = p.id and sp.tenant_id = v_tenant
            and sp.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'CONFIRMED')
            and sp.value >= 3 * p.monthly_fee
            and coalesce(sp.paid_at::date, sp.payment_date, sp.due_date) > (m - interval '12 months')::date);

    if i = 0 then
      v_recebido := coalesce((v_cash ->> 'entradas')::numeric, 0);
      -- get_cashflow só conta repasse com status PAGO; fechamento com paid_at em
      -- PAID_WAITING_NF/UNDER_REVIEW/COMPLETED também já saiu do caixa.
      v_saidas_feitas := coalesce((v_cash -> 'saidas' ->> 'total')::numeric, 0)
        - coalesce((v_cash -> 'saidas' ->> 'professores')::numeric, 0)
        + coalesce((select sum(tc.total_amount)
                      from public.teacher_closings tc
                     where tc.tenant_id = v_tenant
                       and tc.status <> 'REJECTED'
                       and tc.paid_at is not null
                       and (tc.paid_at at time zone 'America/Sao_Paulo')::date >= v_cur
                       and (tc.paid_at at time zone 'America/Sao_Paulo')::date < (v_cur + interval '1 month')::date), 0);
    else
      v_recebido := 0;
      v_saidas_feitas := 0;
    end if;

    v_entradas := round(v_recebido + v_geradas + v_assinaturas, 2);
    v_imposto := round((v_geradas + v_assinaturas) * v_tax_pct / 100.0 + v_tax_fixed, 2);
    v_asaas := round((v_n_geradas + v_n_assin) * v_fee, 2);
    -- No mês corrente, o que já saiu (get_cashflow) entra como realizado e o
    -- previsto do mês só completa o que falta (nunca negativo).
    v_saidas := round(
      case when i = 0
        then v_saidas_feitas + v_fech_pendente
             + greatest(v_despesas_mes + v_extra - coalesce((v_cash -> 'saidas' ->> 'despesas')::numeric, 0), 0)
        else v_repasse_mes + v_despesas_mes + v_extra
      end + v_imposto + v_asaas + v_ia_mes, 2);
    v_acum := v_acum + v_entradas - v_saidas;

    v_rows := v_rows || jsonb_build_object(
      'mes', to_char(m, 'YYYY-MM'),
      'corrente', i = 0,
      'entradas', v_entradas,
      'entradas_recebidas', round(v_recebido, 2),
      'cobrancas_geradas', round(v_geradas, 2),
      'cobrancas_geradas_qtd', v_n_geradas,
      'assinaturas_previstas', round(v_assinaturas, 2),
      'assinaturas_previstas_qtd', v_n_assin,
      'saidas', v_saidas,
      'saidas_realizadas', round(v_saidas_feitas, 2),
      'repasse', round(case when i = 0 then v_fech_pendente else v_repasse_mes end, 2),
      'despesas_fixas', round(v_despesas_mes + v_extra, 2),
      'imposto', v_imposto,
      'asaas', v_asaas,
      'ia', round(v_ia_mes, 2),
      'saldo_mes', round(v_entradas - v_saidas, 2),
      'saldo_acumulado', round(v_acum, 2)
    );
  end loop;

  return jsonb_build_object(
    'gerado_em', v_today,
    'base', jsonb_build_object('de', to_char(v_base_start, 'YYYY-MM'), 'ate', to_char(v_cur - 1, 'YYYY-MM')),
    'premissas', jsonb_build_object(
      'repasse_medio_mes', round(v_repasse_mes, 2),
      'despesas_fixas_media_mes', round(v_despesas_mes, 2),
      'custos_fixos_extras', v_extra,
      'ia_media_mes', round(v_ia_mes, 2),
      'fechamentos_pendentes', round(v_fech_pendente, 2),
      'fechamentos_antigos_em_aberto', round(v_fech_antigo, 2),
      'imposto_modo', v_tax_mode
    ),
    'inadimplencia', v_cash -> 'inadimplencia',
    'meses', v_rows,
    'alertas', case when v_tax_mode = 'UNSET'
      then jsonb_build_array(jsonb_build_object('nivel', 'atencao',
        'texto', 'Imposto não configurado: a projeção não reserva dinheiro para imposto.'))
      else '[]'::jsonb end
      || case when v_fech_antigo > 0
      then jsonb_build_array(jsonb_build_object('nivel', 'atencao',
        'texto', 'Há R$ ' || translate(to_char(v_fech_antigo, 'FM999G990D00'), ',.', '.,') ||
          ' em fechamentos de professor de mais de 2 meses ainda sem pagamento registrado. Ficaram fora da projeção: confira se já foram pagos e registre.'))
      else '[]'::jsonb end
      || jsonb_build_array(jsonb_build_object('nivel', 'info',
        'texto', 'Inadimplência vencida (' || coalesce(v_cash -> 'inadimplencia' ->> 'count', '0') ||
          ' cobranças) não entra como entrada prevista. O saldo acumulado parte de zero: o sistema não conhece o saldo do banco.'))
  );
end;
$$;

-- ── DRE completo, 12 meses ──────────────────────────────────────────────────
create or replace function public.finance_dre_completo(
  p_end_month text default null,
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
  v_end text;
  v_end_date date;
  v_cfg jsonb;
  v_tax_mode text;
  v_tax_pct numeric;
  v_tax_fixed numeric;
  v_rows jsonb := '[]'::jsonb;
  v_d jsonb;
  m date;
  v_mes text;
  v_asaas numeric;
  v_ia numeric;
  v_imp_lancado numeric;
  v_imp_est numeric;
  v_rec_liq numeric;
  v_lucro_bruto numeric;
  v_resultado numeric;
begin
  if not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Sem permissão para consultar o financeiro' using errcode = '42501';
  end if;
  v_end := coalesce(nullif(btrim(p_end_month), ''), to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM'));
  if v_end !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Mês inválido (use AAAA-MM)'; end if;
  v_end_date := to_date(v_end || '-01', 'YYYY-MM-DD');

  v_cfg := private.finance_settings_effective(v_tenant);
  v_tax_mode := v_cfg ->> 'tax_mode';
  v_tax_pct := case when v_tax_mode = 'PERCENT_REVENUE' then (v_cfg ->> 'tax_percent')::numeric else 0 end;
  v_tax_fixed := case when v_tax_mode = 'FIXED_MONTHLY' then (v_cfg ->> 'tax_fixed_monthly')::numeric else 0 end;

  for i in reverse 11 .. 0 loop
    m := (v_end_date - make_interval(months => i))::date;
    v_mes := to_char(m, 'YYYY-MM');
    v_d := public.dre_gerencial(v_mes, v_tenant);

    -- Mesmo corte de mês e mesmos status da receita do dre_gerencial.
    select coalesce(sum(case
             when sp.raw_payload -> 'payment' ? 'netValue'
              and (sp.raw_payload -> 'payment' ->> 'netValue')::numeric < sp.value
             then sp.value - (sp.raw_payload -> 'payment' ->> 'netValue')::numeric
             when sp.status = 'RECEIVED_IN_CASH' then 0
             else (v_cfg ->> 'asaas_fee_per_charge')::numeric
           end), 0)
      into v_asaas
      from public.student_payments sp
     where sp.tenant_id = v_tenant and sp.status in ('RECEIVED', 'RECEIVED_IN_CASH')
       and not private.is_unclassified_operator_receipt(sp.payment_type, sp.student_id, sp.raw_payload)
       and to_char(coalesce(sp.credited_at, sp.paid_at, sp.payment_date, sp.due_date), 'YYYY-MM') = v_mes;

    select coalesce(sum(e.ia), 0) into v_ia
      from private.finance_student_economics(v_tenant, v_mes) e;
    -- IA sem aluno (crons, gestão) também é custo da escola.
    select v_ia + coalesce(sum((greatest(ev.input_tokens - coalesce(ev.cached_tokens, 0), 0) * coalesce(pr.input_usd_per_1m, 0)
              + coalesce(ev.cached_tokens, 0) * coalesce(pr.cached_usd_per_1m, 0)
              + ev.output_tokens * coalesce(pr.output_usd_per_1m, 0)) / 1000000.0), 0) * (v_cfg ->> 'usd_brl')::numeric
      into v_ia
      from public.ai_usage_events ev
      left join public.ai_model_pricing pr on pr.model = ev.model
     where ev.tenant_id = v_tenant and ev.user_id is null
       and to_char(ev.created_at at time zone 'America/Sao_Paulo', 'YYYY-MM') = v_mes;

    v_imp_lancado := coalesce((
      select sum((l ->> 'valor')::numeric) from jsonb_array_elements(v_d -> 'linhas') l
       where l ->> 'code' = '4.1.01'), 0);
    v_imp_est := case when v_imp_lancado > 0 then 0
                      else round((v_d ->> 'receita_bruta')::numeric * v_tax_pct / 100.0
                                 + case when (v_d ->> 'receita_bruta')::numeric > 0 then v_tax_fixed else 0 end, 2) end;

    v_rec_liq := (v_d ->> 'receita_liquida')::numeric - v_asaas - v_imp_est;
    v_lucro_bruto := v_rec_liq - (v_d ->> 'custo_servicos')::numeric - v_ia;
    v_resultado := v_lucro_bruto - (v_d ->> 'despesas_operacionais')::numeric;

    v_rows := v_rows || jsonb_build_object(
      'mes', v_mes,
      'receita_bruta', (v_d ->> 'receita_bruta')::numeric,
      'deducoes_lancadas', (v_d ->> 'deducoes')::numeric,
      'taxas_asaas', round(v_asaas, 2),
      'imposto_estimado', v_imp_est,
      'receita_liquida', round(v_rec_liq, 2),
      'custo_professores', (v_d ->> 'custo_servicos')::numeric,
      'custo_ia', round(v_ia, 2),
      'lucro_bruto', round(v_lucro_bruto, 2),
      'margem_bruta_pct', round(100 * v_lucro_bruto / nullif(v_rec_liq, 0), 1),
      'despesas_operacionais', (v_d ->> 'despesas_operacionais')::numeric,
      'resultado', round(v_resultado, 2),
      'margem_liquida_pct', round(100 * v_resultado / nullif(v_rec_liq, 0), 1),
      'resultado_dre_gerencial', (v_d ->> 'resultado')::numeric,
      'recebimentos_a_classificar', (v_d ->> 'recebimentos_a_classificar')::numeric,
      'aulas', (v_d -> 'indicadores' ->> 'aulas')::int,
      'alunos_atendidos', (v_d -> 'indicadores' ->> 'alunos_atendidos')::int
    );
  end loop;

  return jsonb_build_object(
    'ate', v_end,
    'imposto_modo', v_tax_mode,
    'meses', v_rows,
    'total', (
      select jsonb_build_object(
        'receita_bruta', round(sum((r ->> 'receita_bruta')::numeric), 2),
        'taxas_asaas', round(sum((r ->> 'taxas_asaas')::numeric), 2),
        'imposto_estimado', round(sum((r ->> 'imposto_estimado')::numeric), 2),
        'custo_professores', round(sum((r ->> 'custo_professores')::numeric), 2),
        'custo_ia', round(sum((r ->> 'custo_ia')::numeric), 2),
        'despesas_operacionais', round(sum((r ->> 'despesas_operacionais')::numeric), 2),
        'resultado', round(sum((r ->> 'resultado')::numeric), 2))
      from jsonb_array_elements(v_rows) r),
    'alertas', case when v_tax_mode = 'UNSET'
      then jsonb_build_array(jsonb_build_object('nivel', 'atencao',
        'texto', 'Imposto não configurado e não lançado: o resultado está sem imposto.'))
      else '[]'::jsonb end
  );
end;
$$;

revoke all on function public.finance_cashflow_projection(int, text) from public, anon;
revoke all on function public.finance_dre_completo(text, text) from public, anon;
grant execute on function public.finance_cashflow_projection(int, text) to authenticated, service_role;
grant execute on function public.finance_dre_completo(text, text) to authenticated, service_role;
