-- Preserve real cash while leaving explicitly unassigned operator imports
-- outside school revenue until their nature is established. Existing receipts
-- and ledger totals are unchanged. Definitions verified against the active VPS.
create or replace function private.is_unclassified_operator_receipt(p_type text,p_student uuid,p_payload jsonb)
returns boolean language sql immutable set search_path='' as $fn$
  select p_student is null and coalesce(p_type,'')='UNASSIGNED_RECEIPT'
    and coalesce(p_payload->>'source','')='OPERATOR_ADJUDICATION';
$fn$;
alter function private.is_unclassified_operator_receipt(text,uuid,jsonb) owner to postgres;
revoke all on function private.is_unclassified_operator_receipt(text,uuid,jsonb) from public,anon,authenticated,service_role;

create or replace function private.unclassified_receipt_total(p_tenant text,p_month text)
returns numeric language sql stable security definer set search_path='' as $fn$
  select coalesce(sum(greatest(round(coalesce(p.value,0)-coalesce(p.refunded_amount,0),2),0)),0)
  from public.student_payments p where p.tenant_id=p_tenant
    and p.status in ('RECEIVED','RECEIVED_IN_CASH')
    and private.is_unclassified_operator_receipt(p.payment_type,p.student_id,p.raw_payload)
    and to_char(coalesce(p.credited_at,p.paid_at,p.payment_date,p.due_date),'YYYY-MM')=p_month;
$fn$;
alter function private.unclassified_receipt_total(text,text) owner to postgres;
revoke all on function private.unclassified_receipt_total(text,text) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.dre_gerencial(p_month text DEFAULT NULL::text, p_tenant text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text;
  v_receita numeric; v_deducoes numeric; v_nao_classificado numeric;
  v_custo_aulas numeric; v_custo_ajustes numeric; v_custo_outros numeric;
  v_desp_vendedor numeric; v_desp_indicacao numeric; v_desp_ledger numeric;
  v_barrado numeric;
  v_aulas int; v_alunos int;
  v_receita_liq numeric; v_custo numeric; v_lucro_bruto numeric;
  v_despesas numeric; v_resultado numeric;
  v_linhas jsonb; v_linhas_ledger jsonb; v_alertas jsonb := '[]'::jsonb;
begin
  v_tenant := coalesce(nullif(btrim(p_tenant),''),private.active_tenant_id(auth.uid()));
  if not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Sem permissão para consultar o relatório financeiro' using errcode='42501';
  end if;

  v_month := coalesce(p_month, to_char(current_date,'YYYY-MM'));
  if v_month !~ '^\d{4}-\d{2}$' then raise exception 'Mês inválido (use YYYY-MM)'; end if;

  SELECT COALESCE(sum(greatest(round(coalesce(value, 0) - coalesce(refunded_amount, 0), 2), 0)),0) INTO v_receita
  FROM student_payments
  WHERE tenant_id = v_tenant AND status IN ('RECEIVED','RECEIVED_IN_CASH')
    AND NOT private.is_unclassified_operator_receipt(payment_type,student_id,raw_payload)
    AND to_char(COALESCE(credited_at, paid_at, payment_date, due_date),'YYYY-MM') = v_month;

  v_nao_classificado := private.unclassified_receipt_total(v_tenant,v_month);

  select coalesce(sum(custo_aulas),0), coalesce(sum(aulas),0)
    into v_custo_aulas, v_aulas
  from v_teacher_cost_competencia
  where tenant_id = v_tenant and month_year = v_month;

  select coalesce(sum(amount),0) into v_custo_ajustes
  from closing_adjustments
  where tenant_id = v_tenant and month_year = v_month;

  select count(distinct v.student_id) into v_alunos
  from v_payable_class_logs v join profiles t on t.id = v.teacher_id
  where t.tenant_id = v_tenant and to_char(v.class_date,'YYYY-MM') = v_month
    and v.student_id is not null;

  select coalesce(sum(amount_brl),0) into v_desp_vendedor
  from vendor_commissions
  where tenant_id = v_tenant and status='PAID' and to_char(paid_at,'YYYY-MM') = v_month;

  select coalesce(sum(amount_brl),0) into v_desp_indicacao
  from referral_rewards
  where tenant_id = v_tenant and status='PAID' and to_char(paid_at,'YYYY-MM') = v_month;

  select
    coalesce(sum(t.valor) filter (where not t.barrado and t.kind = 'DEDUCAO'), 0),
    coalesce(sum(t.valor) filter (where not t.barrado and t.kind = 'CUSTO'),   0),
    coalesce(sum(t.valor) filter (where not t.barrado and t.kind = 'DESPESA'), 0),
    coalesce(sum(t.valor) filter (where t.barrado), 0),
    coalesce(jsonb_agg(jsonb_build_object(
        'code', t.code, 'label', t.label, 'kind', t.kind,
        'valor', round(t.valor,2), 'fonte','caixa (saídas classificadas)',
        'sort', t.sort_order) order by t.sort_order)
      filter (where not t.barrado), '[]'::jsonb)
    into v_deducoes, v_custo_outros, v_desp_ledger, v_barrado, v_linhas_ledger
  from (
    select
      coalesce(a.code,       '6.9.99') as code,
      coalesce(a.label,      'Outras despesas') as label,
      coalesce(a.kind,       'DESPESA') as kind,
      coalesce(a.sort_order, 990) as sort_order,
      not coalesce(a.ledger_allowed, true) as barrado,
      sum(ft.amount) as valor
    from financial_transactions ft
    left join dre_category_map m on m.tenant_id = ft.tenant_id and m.category = ft.category
    left join dre_accounts a on a.code = coalesce(ft.account_code, m.account_code)
    WHERE ft.tenant_id = v_tenant AND ft.type = 'SAIDA'
      AND ft.category IS DISTINCT FROM 'teacher_payout'
      AND ft.refund_student_payment_id IS NULL
      AND to_char(COALESCE(ft.occurred_at, ft.created_at),'YYYY-MM') = v_month
    group by 1,2,3,4,5
  ) t;

  v_receita_liq := v_receita - v_deducoes;
  v_custo       := v_custo_aulas + v_custo_ajustes + v_custo_outros;
  v_lucro_bruto := v_receita_liq - v_custo;
  v_despesas    := v_desp_vendedor + v_desp_indicacao + v_desp_ledger;
  v_resultado   := v_lucro_bruto - v_despesas;

  with fixas as (
    select unnest(array[
      jsonb_build_object('code','3.1.01','label','Mensalidades',           'kind','RECEITA','valor',round(v_receita,2),        'fonte','student_payments recebidos',        'sort',110),
      jsonb_build_object('code','5.1.01','label','Repasse a professores',  'kind','CUSTO',  'valor',round(v_custo_aulas,2),    'fonte','v_payable_class_logs (competência)','sort',310),
      jsonb_build_object('code','5.1.02','label','Ajustes de fechamento',  'kind','CUSTO',  'valor',round(v_custo_ajustes,2),  'fonte','closing_adjustments',               'sort',320),
      jsonb_build_object('code','6.1.01','label','Comissões de vendedores','kind','DESPESA','valor',round(v_desp_vendedor,2),  'fonte','vendor_commissions pagas',          'sort',410),
      jsonb_build_object('code','6.1.02','label','Programa de indicações', 'kind','DESPESA','valor',round(v_desp_indicacao,2), 'fonte','referral_rewards pagas',            'sort',420)
    ]) as l
  ), ledger as (
    select e.value as l from jsonb_array_elements(v_linhas_ledger) e
  )
  select coalesce(jsonb_agg((t.l - 'sort') order by (t.l->>'sort')::int), '[]'::jsonb)
    into v_linhas
  from (select l from fixas union all select l from ledger) t;

  if v_nao_classificado > 0 then
    v_alertas := v_alertas || jsonb_build_object('nivel','atencao',
      'texto','Há R$ ' || translate(to_char(v_nao_classificado,'FM999,999,990.00'), ',.', '.,') ||
      ' recebidos e ainda sem classificação. Estão no caixa, mas fora da receita e do resultado deste DRE; não foram presumidos como mensalidade nem aporte.');
  end if;

  if v_desp_ledger = 0 and v_deducoes = 0 and v_custo_outros = 0 then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','critico',
      'texto','Nenhuma despesa operacional lançada no mês (ferramentas, internet, impostos, aluguel). O resultado abaixo está SUPERESTIMADO — ele desconta só o custo com professor.');
  end if;
  if v_barrado > 0 then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','atencao',
      'texto','R$ ' || translate(to_char(v_barrado,'FM999,999,990.00'), ',.', '.,') || ' em saídas do caixa foram lançadas em contas que já vêm por competência (repasse, ajustes, comissões, indicações). O valor foi IGNORADO no resultado para não contar duas vezes — reclassifique a categoria.');
  end if;
  if v_custo_aulas = 0 and v_receita > 0 then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','atencao',
      'texto','Houve receita mas nenhuma aula pagável lançada no mês. Verifique lançamentos pendentes de professor.');
  end if;
  if exists (select 1 from teacher_closings tc
              where tc.tenant_id = v_tenant and tc.month_year = v_month
                and tc.status <> 'PAGO') then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','info',
      'texto','O fechamento deste mês ainda não foi pago. O custo já está reconhecido aqui por competência, mas ainda não saiu do caixa.');
  end if;

  return jsonb_build_object(
    'month', v_month,
    'regime','competencia',
    'recebimentos_a_classificar', round(v_nao_classificado,2),
    'receita_bruta',   round(v_receita,2),
    'deducoes',        round(v_deducoes,2),
    'receita_liquida', round(v_receita_liq,2),
    'custo_servicos',  round(v_custo,2),
    'lucro_bruto',     round(v_lucro_bruto,2),
    'margem_bruta_pct', round(100 * v_lucro_bruto / nullif(v_receita_liq,0), 1),
    'despesas_operacionais', round(v_despesas,2),
    'resultado',       round(v_resultado,2),
    'margem_liquida_pct', round(100 * v_resultado / nullif(v_receita_liq,0), 1),
    'indicadores', jsonb_build_object(
      'aulas', v_aulas,
      'alunos_atendidos', v_alunos,
      'receita_por_aluno', round(v_receita / nullif(v_alunos,0), 2),
      'custo_por_aula', round((v_custo_aulas + v_custo_ajustes) / nullif(v_aulas,0), 2)
    ),
    'linhas', v_linhas,
    'alertas', v_alertas
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.balancete_professores(p_month text DEFAULT NULL::text, p_tenant text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text; v_base numeric;
BEGIN
  v_tenant := coalesce(nullif(btrim(p_tenant),''),private.active_tenant_id(auth.uid()));
  if not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Sem permissão para consultar o relatório financeiro' using errcode='42501';
  end if;

  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Mês inválido (use YYYY-MM)'; END IF;

  SELECT rate INTO v_base FROM teacher_pay_tiers
   WHERE tenant_id = v_tenant AND min_students = 1;
  v_base := COALESCE(v_base, 0);

  RETURN (
  WITH aulas AS (
    SELECT v.id, v.teacher_id, v.student_id, v.rate_efetivo, v.rate_override, v.subtype
      FROM v_payable_class_logs v
      JOIN profiles t ON t.id = v.teacher_id
     WHERE to_char(v.class_date,'YYYY-MM') = v_month AND t.tenant_id = v_tenant
  ), classificado AS (
    SELECT a.*,
           CASE
             WHEN a.rate_override IS NOT NULL                           THEN 'ajuste'
             WHEN a.subtype = 'TREINAMENTO' AND a.rate_efetivo > v_base THEN 'treinamento'
             WHEN a.rate_efetivo > v_base                               THEN 'turbo'
             ELSE 'base'
           END AS motivo
      FROM aulas a
  ), aulas_aluno_prof AS (
    SELECT c.student_id, c.teacher_id, count(*)::int AS n
      FROM classificado c WHERE c.student_id IS NOT NULL
     GROUP BY 1,2
  ), aulas_aluno AS (
    SELECT ap.student_id, sum(ap.n) AS total FROM aulas_aluno_prof ap GROUP BY 1
  ), receita_aluno AS (
    SELECT sp.student_id, sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)) AS receita
      FROM student_payments sp
     WHERE sp.tenant_id = v_tenant
       AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
       AND to_char(COALESCE(sp.credited_at, sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
       AND sp.student_id IS NOT NULL
     GROUP BY 1
  ), rateio AS (
    SELECT ap.teacher_id, ap.student_id,
           ra.receita * ap.n / NULLIF(aa.total,0) AS receita
      FROM aulas_aluno_prof ap
      JOIN aulas_aluno   aa ON aa.student_id = ap.student_id
      JOIN receita_aluno ra ON ra.student_id = ap.student_id
  ), rateio_contratado AS (
    -- Mesmo rateio da faturada, para os dois números serem comparáveis.
    SELECT ap.teacher_id, ap.student_id,
           COALESCE(pf.monthly_fee,0) * ap.n / NULLIF(aa.total,0) AS receita
      FROM aulas_aluno_prof ap
      JOIN aulas_aluno aa ON aa.student_id = ap.student_id
      JOIN profiles    pf ON pf.id = ap.student_id
  ), por_aluno AS (
    SELECT c.teacher_id, c.student_id,
           max(COALESCE(sp.full_name,'Aluno não cadastrado')) AS student_name,
           count(*)::int                          AS aulas,
           sum(c.rate_efetivo)                    AS custo,
           count(*) FILTER (WHERE c.motivo = 'turbo')::int AS aulas_turbo,
           COALESCE(max(r.receita), 0)            AS receita,
           COALESCE(max(rc.receita), 0)           AS receita_contratada
      FROM classificado c
      LEFT JOIN profiles sp ON sp.id = c.student_id
      LEFT JOIN rateio   r  ON r.teacher_id = c.teacher_id AND r.student_id = c.student_id
      LEFT JOIN rateio_contratado rc ON rc.teacher_id = c.teacher_id AND rc.student_id = c.student_id
     WHERE c.student_id IS NOT NULL
     GROUP BY c.teacher_id, c.student_id
  ), ajustes AS (
    SELECT ca.teacher_id, sum(ca.amount) AS valor
      FROM closing_adjustments ca
     WHERE ca.tenant_id = v_tenant AND ca.month_year = v_month
     GROUP BY 1
  ), por_prof AS (
    SELECT c.teacher_id,
           count(*)::int                                              AS aulas,
           count(DISTINCT c.student_id) FILTER (WHERE c.student_id IS NOT NULL)::int AS alunos,
           (count(*) * v_base)                                        AS custo_base,
           sum(CASE WHEN c.motivo='turbo'       THEN c.rate_efetivo - v_base ELSE 0 END) AS comissao_turbo,
           sum(CASE WHEN c.motivo='treinamento' THEN c.rate_efetivo - v_base ELSE 0 END) AS bonus_treinamento,
           sum(CASE WHEN c.motivo='ajuste'      THEN c.rate_efetivo - v_base ELSE 0 END) AS ajuste_valor_base,
           count(*) FILTER (WHERE c.motivo='turbo')::int              AS aulas_turbo,
           count(*) FILTER (WHERE c.motivo='treinamento')::int        AS aulas_treinamento,
           count(*) FILTER (WHERE c.motivo='ajuste')::int             AS aulas_ajustadas,
           sum(c.rate_efetivo)                                        AS custo_aulas
      FROM classificado c
     GROUP BY c.teacher_id
  ), consolidado AS (
    SELECT p.*,
           COALESCE(aj.valor, 0)                          AS ajustes_fechamento,
           p.custo_aulas + COALESCE(aj.valor, 0)          AS custo_total,
           COALESCE((SELECT sum(r.receita) FROM rateio r WHERE r.teacher_id = p.teacher_id), 0) AS receita,
           COALESCE((SELECT sum(rc.receita) FROM rateio_contratado rc WHERE rc.teacher_id = p.teacher_id), 0) AS receita_contratada,
           trim(t.full_name)                              AS teacher_name
      FROM por_prof p
      JOIN profiles t   ON t.id = p.teacher_id
      LEFT JOIN ajustes aj ON aj.teacher_id = p.teacher_id
  )
  SELECT jsonb_build_object(
    'month', v_month,
    'base_rate', v_base,
    'recebimentos_a_classificar', round(private.unclassified_receipt_total(v_tenant,v_month),2),
    'como_ler',
      'Para COMPARAR PROFESSORES use lucro_contratado: ele mede o que o professor entregou, sem a interferência de a escola ter conseguido cobrar ou não. Para saber quanto SOBROU no mês use lucro (faturado) — é ele que fecha com o DRE e com o caixa. nao_faturado positivo = mensalidade que não foi cobrada (responsabilidade da secretaria, não do professor); nao_faturado NEGATIVO = o aluno pagou mais que a mensalidade no mês, quase sempre atrasado de mês anterior caindo agora.',
    'professores', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'teacher_id', k.teacher_id, 'teacher_name', k.teacher_name,
        'aulas', k.aulas, 'alunos', k.alunos,
        'custo_base',         round(k.custo_base,2),
        'comissao_turbo',     round(k.comissao_turbo,2),
        'bonus_treinamento',  round(k.bonus_treinamento,2),
        'ajuste_valor_base',  round(k.ajuste_valor_base,2),
        'ajustes_fechamento', round(k.ajustes_fechamento,2),
        'custo_total',        round(k.custo_total,2),
        'aulas_turbo', k.aulas_turbo, 'aulas_treinamento', k.aulas_treinamento,
        'aulas_ajustadas', k.aulas_ajustadas,
        'receita',            round(k.receita,2),
        'receita_contratada', round(k.receita_contratada,2),
        'nao_faturado',       round(k.receita_contratada - k.receita,2),
        'lucro',              round(k.receita - k.custo_total,2),
        'lucro_contratado',   round(k.receita_contratada - k.custo_total,2),
        'margem_pct',         round(100 * (k.receita - k.custo_total) / NULLIF(k.receita,0),1),
        'margem_contratada_pct', round(100 * (k.receita_contratada - k.custo_total) / NULLIF(k.receita_contratada,0),1),
        'custo_por_aula', round(k.custo_total / NULLIF(k.aulas,0),2),
        'alunos_detalhe', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'student_id', pa.student_id, 'student_name', pa.student_name,
                    'aulas', pa.aulas, 'aulas_turbo', pa.aulas_turbo,
                    'custo', round(pa.custo,2), 'receita', round(pa.receita,2),
                    'receita_contratada', round(pa.receita_contratada,2),
                    'nao_faturado', round(pa.receita_contratada - pa.receita,2),
                    'lucro', round(pa.receita - pa.custo,2))
                  ORDER BY pa.receita_contratada - pa.custo DESC)
             FROM por_aluno pa WHERE pa.teacher_id = k.teacher_id), '[]'::jsonb)
      ) ORDER BY k.receita_contratada - k.custo_total DESC)   -- ← ordena pelo justo
      FROM consolidado k), '[]'::jsonb),
    'totais', (SELECT jsonb_build_object(
        'aulas',              COALESCE(sum(k.aulas),0),
        'custo_base',         round(COALESCE(sum(k.custo_base),0),2),
        'comissao_turbo',     round(COALESCE(sum(k.comissao_turbo),0),2),
        'bonus_treinamento',  round(COALESCE(sum(k.bonus_treinamento),0),2),
        'ajuste_valor_base',  round(COALESCE(sum(k.ajuste_valor_base),0),2),
        'ajustes_fechamento', round(COALESCE(sum(k.ajustes_fechamento),0),2),
        'custo_total',        round(COALESCE(sum(k.custo_total),0),2),
        'receita_alocada',    round(COALESCE(sum(k.receita),0),2),
        'receita_contratada', round(COALESCE(sum(k.receita_contratada),0),2),
        'nao_faturado',       round(COALESCE(sum(k.receita_contratada),0) - COALESCE(sum(k.receita),0),2),
        'lucro',              round(COALESCE(sum(k.receita),0) - COALESCE(sum(k.custo_total),0),2),
        'lucro_contratado',   round(COALESCE(sum(k.receita_contratada),0) - COALESCE(sum(k.custo_total),0),2)
      ) FROM consolidado k),
    'receita_total', round((SELECT COALESCE(sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)),0) FROM student_payments sp
        WHERE sp.tenant_id = v_tenant AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
          AND NOT private.is_unclassified_operator_receipt(sp.payment_type,sp.student_id,sp.raw_payload)
          AND to_char(COALESCE(sp.credited_at, sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month),2),
    'receita_sem_aluno', round((SELECT COALESCE(sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)),0) FROM student_payments sp
        WHERE sp.tenant_id = v_tenant AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
          AND NOT private.is_unclassified_operator_receipt(sp.payment_type,sp.student_id,sp.raw_payload)
          AND to_char(COALESCE(sp.credited_at, sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
          AND sp.student_id IS NULL),2),
    'receita_aluno_sem_aula', round(
        (SELECT COALESCE(sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)),0) FROM student_payments sp
          WHERE sp.tenant_id = v_tenant AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
          AND NOT private.is_unclassified_operator_receipt(sp.payment_type,sp.student_id,sp.raw_payload)
            AND to_char(COALESCE(sp.credited_at, sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
            AND sp.student_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM aulas_aluno aa WHERE aa.student_id = sp.student_id)),2),
    'alunos_multi_professor', (SELECT count(*)::int FROM (
        SELECT ap.student_id FROM aulas_aluno_prof ap
         GROUP BY ap.student_id HAVING count(DISTINCT ap.teacher_id) > 1) z)
  ));
END;
$function$;


alter function public.dre_gerencial(text,text) owner to postgres;
alter function public.balancete_professores(text,text) owner to postgres;
revoke all on function public.dre_gerencial(text,text) from public,anon;
revoke all on function public.balancete_professores(text,text) from public,anon;
grant execute on function public.dre_gerencial(text,text) to authenticated,service_role;
grant execute on function public.balancete_professores(text,text) to authenticated,service_role;
notify pgrst,'reload schema';
