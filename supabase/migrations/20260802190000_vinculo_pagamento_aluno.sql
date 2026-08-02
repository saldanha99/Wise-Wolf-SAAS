-- Vínculo de pagamento → aluno → professor.
--
-- Motivador (julho/2026): dos R$ 8.920,69 de receita, só R$ 5.265,10 tinham
-- professor identificável. O resto se dividia em dois problemas DIFERENTES, que
-- exigem tratamentos diferentes:
--
--   A) R$ 2.365,00 em 8 pagamentos SEM student_id. Investigados um a um pelo
--      Asaas: SEIS (R$ 1.819,00) são da própria Debora Alves Fernandes — que é
--      professora e contratante, não aluna. Não é "faltou vincular", é dinheiro
--      da dona entrando como mensalidade. Um era da mãe de uma aluna (vinculado)
--      e um provavelmente duplica um recebimento em dinheiro já lançado.
--      → Conclusão: isto NÃO se resolve por regra automática. Precisa de gente
--        olhando pagamento a pagamento. Daí a tela, não um matcher esperto.
--
--   B) R$ 1.290,59 de alunos que pagaram e não tiveram aula lançada no mês.
--      Aqui existe professor sim — na AGENDA. Seis dos sete alunos têm horário
--      marcado; ninguém lançou a aula. R$ 712,80 são da agenda da Debora.
--      → Isto é sinal de aula não lançada, não de receita sem dono.
--
-- ⚠️ A receita do balde B NÃO entra no lucro do professor. Receita sem aula é
-- receita sem custo: somar daria margem de 100% e premiaria justamente quem não
-- lançou. Ela aparece atribuída, num bloco à parte, como cobrança de conferência.

-- 1) Balancete: quebra a receita "sem aula" por professor da agenda ------------
CREATE OR REPLACE FUNCTION public.balancete_receita_sem_aula(
  p_month text DEFAULT NULL, p_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_jwt_role text; v_role text; v_tenant text; v_month text;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt_role IN ('anon','authenticated') THEN
    IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
    IF v_role = 'SUPER_ADMIN' THEN v_tenant := COALESCE(p_tenant, v_tenant); END IF;
  ELSE
    v_tenant := COALESCE(p_tenant, v_tenant);
  END IF;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('error','escola_nao_identificada'); END IF;

  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RETURN jsonb_build_object('error','mes_invalido'); END IF;

  RETURN COALESCE((
    WITH pagou AS (
      SELECT sp.student_id, sum(sp.value) AS receita
        FROM student_payments sp
       WHERE sp.tenant_id = v_tenant
         AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
         AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
         AND sp.student_id IS NOT NULL
       GROUP BY 1
    ), com_aula AS (
      SELECT DISTINCT v.student_id FROM v_payable_class_logs v
       WHERE to_char(v.class_date,'YYYY-MM') = v_month AND v.student_id IS NOT NULL
    ), sem_aula AS (
      SELECT pg.student_id, pg.receita, p.full_name AS student_name,
             -- Professor da AGENDA. Aluno em dois professores na agenda vira
             -- lista: não dá para escolher um sem inventar critério.
             (SELECT string_agg(DISTINCT trim(t.full_name), ', ')
                FROM bookings b JOIN profiles t ON t.id = b.teacher_id
               WHERE b.student_id = pg.student_id AND b.status = 'SCHEDULED') AS professor,
             (SELECT count(*) FROM bookings b
               WHERE b.student_id = pg.student_id AND b.status = 'SCHEDULED')::int AS slots
        FROM pagou pg JOIN profiles p ON p.id = pg.student_id
       WHERE NOT EXISTS (SELECT 1 FROM com_aula ca WHERE ca.student_id = pg.student_id)
    )
    SELECT jsonb_build_object(
      'total', round(COALESCE(sum(s.receita),0),2),
      'alunos', COALESCE(jsonb_agg(jsonb_build_object(
                  'student_id', s.student_id, 'student_name', s.student_name,
                  'receita', round(s.receita,2),
                  'professor', COALESCE(s.professor,'(sem agenda)'),
                  'slots', s.slots) ORDER BY s.receita DESC), '[]'::jsonb),
      'por_professor', COALESCE((
         SELECT jsonb_agg(x ORDER BY (x->>'receita')::numeric DESC) FROM (
           SELECT jsonb_build_object(
                    'professor', COALESCE(s2.professor,'(sem agenda)'),
                    'receita', round(sum(s2.receita),2),
                    'alunos', count(*)::int) AS x
             FROM sem_aula s2 GROUP BY COALESCE(s2.professor,'(sem agenda)')) y), '[]'::jsonb)
    ) FROM sem_aula s), jsonb_build_object('total',0,'alunos','[]'::jsonb,'por_professor','[]'::jsonb));
END;
$function$;

COMMENT ON FUNCTION public.balancete_receita_sem_aula(text, text) IS
  'Receita de aluno que pagou e não teve aula lançada no mês, atribuída ao professor da AGENDA. Não entra no lucro do professor — receita sem aula é receita sem custo.';

REVOKE ALL ON FUNCTION public.balancete_receita_sem_aula(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.balancete_receita_sem_aula(text, text) TO authenticated, service_role;

-- 2) Pagamentos órfãos: listar e vincular -------------------------------------
CREATE OR REPLACE FUNCTION public.list_unlinked_payments(p_month text DEFAULT NULL)
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
    'pagamentos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', sp.id, 'value', sp.value, 'status', sp.status,
               'due_date', sp.due_date,
               'pago_em', COALESCE(sp.paid_at::date, sp.payment_date),
               'billing_type', sp.billing_type,
               'asaas', COALESCE(sp.asaas_payment_id, sp.asaas_id),
               'descricao', sp.description,
               -- Pista barata contra duplicata: já existe pagamento do MESMO
               -- valor, no mesmo mês, com aluno? Foi assim que o recebimento em
               -- dinheiro da Ana Clara apareceu duas vezes.
               'mesmo_valor_ja_lancado', (
                  SELECT count(*)::int FROM student_payments o
                   WHERE o.tenant_id = sp.tenant_id AND o.student_id IS NOT NULL
                     AND o.value = sp.value
                     AND o.status IN ('RECEIVED','RECEIVED_IN_CASH')
                     AND to_char(COALESCE(o.paid_at, o.payment_date, o.due_date),'YYYY-MM')
                         = to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM')))
             ORDER BY sp.value DESC)
        FROM student_payments sp
       WHERE sp.tenant_id = v_tenant AND sp.student_id IS NULL
         AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
         AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
    ), '[]'::jsonb),
    'alunos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'nome', trim(p.full_name)) ORDER BY p.full_name)
        FROM profiles p
       WHERE p.tenant_id = v_tenant AND p.role = 'STUDENT'
         AND COALESCE(p.status_financial,'') <> 'ARCHIVED'), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_unlinked_payments(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_unlinked_payments(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.link_payment_to_student(p_payment_id uuid, p_student_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; v_n int;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles s
                  WHERE s.id = p_student_id AND s.role = 'STUDENT' AND s.tenant_id = v_tenant) THEN
    RETURN jsonb_build_object('error','aluno_invalido');
  END IF;

  -- Só pagamento REALMENTE órfão. Reatribuir um pagamento que já tem dono é
  -- outra operação, com outro risco (mover receita entre alunos), e não passa
  -- por aqui.
  UPDATE student_payments
     SET student_id = p_student_id, updated_at = now()
   WHERE id = p_payment_id AND tenant_id = v_tenant AND student_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN jsonb_build_object('error','pagamento_nao_encontrado_ou_ja_vinculado'); END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.link_payment_to_student(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_payment_to_student(uuid, uuid) TO authenticated;
