-- Dinheiro que entrou pela conta e NÃO é receita da escola.
--
-- Caso concreto (julho/2026): seis pagamentos, R$ 1.819,00, da própria Debora
-- Alves Fernandes — professora e contratante — em duas contas do Asaas (CPF e
-- CNPJ). Confirmado com a direção em 02/08/2026: é movimentação dela, não
-- mensalidade. Enquanto contava como receita, o DRE de julho reportava
-- R$ 8.920,69 em vez de R$ 7.101,69 e a margem saía inflada.
--
-- COMO a exclusão é feita, e por quê assim:
--
-- Nove funções calculam receita a partir de student_payments (dre_gerencial,
-- get_cashflow, balancete_professores, balancete_receita_sem_aula,
-- director_teacher_margin, get_mei_radar, weekly_digest_rows,
-- list_unlinked_payments, process_referral_reward). Todas filtram por
-- `status IN ('RECEIVED','RECEIVED_IN_CASH')`.
--
-- Colocar uma flag nova exigiria editar as NOVE, e cada edição é uma chance de
-- repetir o erro que já custou caro duas vezes neste banco (o `NOT` sobre NULL
-- que sumiu com aula da folha). Tirar o pagamento do conjunto de status faz as
-- nove pararem de contá-lo de uma vez — e, principalmente, faz a DÉCIMA função,
-- a que ainda não foi escrita, já nascer certa.
--
-- Nada é apagado: valor, data, asaas_payment_id e o status original ficam. O
-- que muda é a classificação.
--
-- Seguro porque: `status` não tem CHECK constraint, e toda função que age sobre
-- pendência (suspend_overdue_students, dunning, crédito, painéis de aluno) é
-- escopada por aluno — estes pagamentos têm student_id NULO e não alcançam
-- ninguém.

ALTER TABLE public.student_payments
  ADD COLUMN IF NOT EXISTS exclusion_reason text;

COMMENT ON COLUMN public.student_payments.exclusion_reason IS
  'Preenchido quando o pagamento sai da receita (status NAO_RECEITA): guarda o motivo e o status original.';

-- Marcar / desmarcar --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_payment_not_revenue(
  p_payment_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; v_status text; v_n int;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;

  SELECT sp.status INTO v_status FROM student_payments sp
   WHERE sp.id = p_payment_id AND sp.tenant_id = v_tenant;
  IF v_status IS NULL THEN RETURN jsonb_build_object('error','pagamento_nao_encontrado'); END IF;
  IF v_status = 'NAO_RECEITA' THEN RETURN jsonb_build_object('error','ja_excluido'); END IF;

  UPDATE student_payments
     SET status = 'NAO_RECEITA',
         -- O status original vai no motivo: é o que permite desfazer.
         exclusion_reason = COALESCE(NULLIF(btrim(p_reason),''), 'Não é receita da escola')
                            || ' [status anterior: ' || v_status || ']',
         updated_at = now()
   WHERE id = p_payment_id AND tenant_id = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN jsonb_build_object('error','pagamento_nao_encontrado'); END IF;

  -- O lançamento no caixa continua existindo (o dinheiro entrou de verdade),
  -- mas deixa de se chamar mensalidade. Só a etiqueta muda.
  UPDATE financial_transactions
     SET category = 'aporte_ou_movimentacao'
   WHERE student_payment_id = p_payment_id AND type = 'ENTRADA';

  RETURN jsonb_build_object('ok', true, 'status_anterior', v_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_payment_not_revenue(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_payment_not_revenue(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.undo_payment_not_revenue(p_payment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; v_reason text; v_anterior text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;

  SELECT sp.exclusion_reason INTO v_reason FROM student_payments sp
   WHERE sp.id = p_payment_id AND sp.tenant_id = v_tenant AND sp.status = 'NAO_RECEITA';
  IF v_reason IS NULL THEN RETURN jsonb_build_object('error','nao_esta_excluido'); END IF;

  v_anterior := substring(v_reason from '\[status anterior: ([^\]]+)\]');
  IF v_anterior IS NULL THEN v_anterior := 'RECEIVED'; END IF;

  UPDATE student_payments
     SET status = v_anterior, exclusion_reason = NULL, updated_at = now()
   WHERE id = p_payment_id AND tenant_id = v_tenant;
  UPDATE financial_transactions
     SET category = 'MENSALIDADE'
   WHERE student_payment_id = p_payment_id AND type = 'ENTRADA';

  RETURN jsonb_build_object('ok', true, 'status_restaurado', v_anterior);
END;
$function$;

REVOKE ALL ON FUNCTION public.undo_payment_not_revenue(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.undo_payment_not_revenue(uuid) TO authenticated;

-- Visibilidade: o que foi tirado da receita não pode virar buraco silencioso.
CREATE OR REPLACE FUNCTION public.list_payments_not_revenue(p_month text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; v_month text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;
  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RETURN jsonb_build_object('error','mes_invalido'); END IF;

  RETURN jsonb_build_object(
    'month', v_month,
    'total', round(COALESCE((SELECT sum(sp.value) FROM student_payments sp
        WHERE sp.tenant_id = v_tenant AND sp.status = 'NAO_RECEITA'
          AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month),0),2),
    'pagamentos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', sp.id, 'value', sp.value, 'due_date', sp.due_date,
               'motivo', sp.exclusion_reason,
               'asaas', COALESCE(sp.asaas_payment_id, sp.asaas_id))
             ORDER BY sp.value DESC)
        FROM student_payments sp
       WHERE sp.tenant_id = v_tenant AND sp.status = 'NAO_RECEITA'
         AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_payments_not_revenue(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_payments_not_revenue(text) TO authenticated;
