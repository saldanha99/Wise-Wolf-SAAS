-- get_cashflow vivia SÓ no banco de produção: CashflowPanel.tsx a chama, mas não
-- havia migration nenhuma criando a função. É o mesmo drift que já tinha
-- acontecido com o catálogo de nichos pedagógicos — quem clonasse o repo e
-- rodasse as migrations do zero ficava com o painel de Fluxo de Caixa quebrado.
--
-- Esta migration é uma CAPTURA FIEL do que roda em produção hoje (extraída com
-- pg_get_functiondef em 02/08/2026). Nada de comportamento muda aqui de
-- propósito — a intenção é só parar o drift antes de o DRE construir em cima.
--
-- Vale registrar o que a captura revelou, porque o DRE depende disso:
--   * o repasse a professores JÁ é contado aqui, direto de teacher_closings.
--     Postar o mesmo repasse como SAIDA em financial_transactions faria a conta
--     dobrar (uma vez em v_teacher, outra em v_expense) — exatamente o bug que
--     20260612210100_fix_cashflow_double_count.sql matou do lado da receita.
--   * o custo do professor só é reconhecido quando o fechamento vira 'PAGO'.
--     Isso é regime de CAIXA. Julho/2026 tem R$ 2.150,00 de custo real e reporta
--     R$ 0,00 aqui, porque o fechamento está PENDENTE. No histórico, só
--     R$ 3.519,50 de R$ 7.799,50 em fechamentos chegaram a PAGO.
--     O DRE gerencial resolve isso por COMPETÊNCIA, em outro caminho
--     (dre_gerencial), sem alterar esta função.

CREATE OR REPLACE FUNCTION public.get_cashflow(p_month text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text; v_tenant text; v_month text; r jsonb;
  v_in numeric; v_teacher numeric; v_vendor numeric; v_referral numeric; v_expense numeric;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN RETURN jsonb_build_object('error','sem_permissao'); END IF;
  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));

  -- Entradas: pagamentos recebidos no mês (fonte: student_payments, sem dupla contagem)
  SELECT COALESCE(sum(value),0) INTO v_in FROM student_payments
   WHERE tenant_id=v_tenant AND status IN ('RECEIVED','RECEIVED_IN_CASH')
     AND to_char(COALESCE(paid_at, payment_date, due_date),'YYYY-MM')=v_month;

  -- Saídas: repasses a professores (fechamentos PAGOS) + comissões de vendedor + recompensas de indicação
  SELECT COALESCE(sum(total_amount),0) INTO v_teacher FROM teacher_closings
   WHERE tenant_id=v_tenant AND status='PAGO'
     AND to_char(COALESCE(paid_at, (month_year||'-01')::date),'YYYY-MM')=v_month;
  SELECT COALESCE(sum(amount_brl),0) INTO v_vendor FROM vendor_commissions
   WHERE tenant_id=v_tenant AND status='PAID' AND to_char(paid_at,'YYYY-MM')=v_month;
  SELECT COALESCE(sum(amount_brl),0) INTO v_referral FROM referral_rewards
   WHERE tenant_id=v_tenant AND status='PAID' AND to_char(paid_at,'YYYY-MM')=v_month;
  -- Despesas avulsas (saídas manuais no caixa)
  SELECT COALESCE(sum(amount),0) INTO v_expense FROM financial_transactions
   WHERE tenant_id=v_tenant AND type='SAIDA' AND to_char(COALESCE(occurred_at,created_at),'YYYY-MM')=v_month;

  r := jsonb_build_object(
    'month', v_month,
    'entradas', v_in,
    'saidas', jsonb_build_object('professores', v_teacher, 'vendedores', v_vendor, 'indicacoes', v_referral, 'despesas', v_expense,
       'total', v_teacher + v_vendor + v_referral + v_expense),
    'saldo', v_in - (v_teacher + v_vendor + v_referral + v_expense),
    -- Inadimplência (aging) — em aberto e vencido
    'inadimplencia', (SELECT jsonb_build_object(
        'total', COALESCE(sum(value),0),
        'd1_30', COALESCE(sum(value) FILTER (WHERE current_date - due_date BETWEEN 1 AND 30),0),
        'd31_60', COALESCE(sum(value) FILTER (WHERE current_date - due_date BETWEEN 31 AND 60),0),
        'd60plus', COALESCE(sum(value) FILTER (WHERE current_date - due_date > 60),0),
        'count', count(*))
      FROM student_payments WHERE tenant_id=v_tenant AND status IN ('OVERDUE','DUNNING_REQUESTED')),
    -- a receber este mês (pendente que vence no mês)
    'a_receber', (SELECT COALESCE(sum(value),0) FROM student_payments
        WHERE tenant_id=v_tenant AND status='PENDING' AND to_char(due_date,'YYYY-MM')=v_month),
    -- série dos últimos 6 meses (entradas)
    'serie', (SELECT jsonb_agg(jsonb_build_object('mes', m, 'entradas', ent) ORDER BY m)
        FROM (
          SELECT to_char(d,'YYYY-MM') AS m,
            (SELECT COALESCE(sum(value),0) FROM student_payments
              WHERE tenant_id=v_tenant AND status IN ('RECEIVED','RECEIVED_IN_CASH')
                AND to_char(COALESCE(paid_at,payment_date,due_date),'YYYY-MM')=to_char(d,'YYYY-MM')) AS ent
          FROM generate_series(date_trunc('month',current_date) - interval '5 months', date_trunc('month',current_date), interval '1 month') d
        ) s)
  );
  RETURN r;
END;
$function$;

COMMENT ON FUNCTION public.get_cashflow(text) IS
  'Fluxo de CAIXA do mês (reconhece custo de professor só quando o fechamento vira PAGO). Para resultado por COMPETÊNCIA use dre_gerencial(text). Captura do estado de produção em 02/08/2026 — a função existia sem migration.';

REVOKE ALL ON FUNCTION public.get_cashflow(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cashflow(text) TO authenticated;
