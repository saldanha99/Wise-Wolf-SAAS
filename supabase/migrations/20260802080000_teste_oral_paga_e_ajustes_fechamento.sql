-- Teste oral paga como aula + ajustes manuais no fechamento.
--
-- 1) TESTE ORAL — a regra antiga excluía `subtype='Teste Oral'` do pagamento por
--    completo. Está errado: o teste oral É a aula daquele horário, só que em
--    formato de avaliação, e vale os mesmos R$ 8,00. O que não pode é virar um
--    lançamento A MAIS, empilhado sobre a aula normal do mesmo aluno no mesmo dia
--    — é disso que a exclusão tentava proteger, mas com um martelo grande demais.
--    (O teste oral da Sara, em julho/2026, só estava pagando porque foi lançado
--    como AULA EXPERIMENTAL por acidente.)
--
-- 2) AJUSTES DE FECHAMENTO — a escola faz acordos pontuais que não são aula:
--    a Lais recebeu R$ 30,00 para segurar um horário até a aluna começar
--    ("reserva de agenda"). Não cabe criar um tipo chumbado para cada acordo:
--    da próxima vez é outro valor e outro motivo. Vira uma linha de ajuste com
--    descrição e valor, lançada pela direção, que entra no total e aparece na
--    folha do professor com o motivo escrito.

-- 1) Teste oral volta a pagar --------------------------------------------------
CREATE OR REPLACE VIEW public.v_payable_class_logs AS
SELECT
  cl.*,
  COALESCE(
    cl.rate_override,
    CASE WHEN cl.subtype = 'TREINAMENTO'
              AND COALESCE(tp.is_trainer, false)
              AND NOT EXISTS (
                SELECT 1 FROM opportunities o
                WHERE o.kind = 'TRAINING'
                  AND o.winner_teacher_id = cl.teacher_id
                  AND o.trial_appointment_id::text = cl.appointment_id)
         THEN 16.00 END,
    teacher_student_rate(cl.teacher_id, cl.student_id, cl.class_date)
  ) AS rate_efetivo,
  (cl.subtype IN ('REPOSIÇÃO','REPOSIÇÃO_PROF') AND r.id IS NULL) AS reposicao_sem_origem,
  (cl.subtype = 'TREINAMENTO' AND COALESCE(tp.is_trainer, false)
     AND NOT EXISTS (SELECT 1 FROM opportunities o2 WHERE o2.kind = 'TRAINING'
                       AND o2.winner_teacher_id = cl.teacher_id
                       AND o2.trial_appointment_id::text = cl.appointment_id)) AS treinamento_ministrado
FROM class_logs cl
LEFT JOIN reschedules r ON r.id::text = cl.reschedule_id
LEFT JOIN profiles tp ON tp.id = cl.teacher_id
LEFT JOIN appointments ap ON ap.id::text = cl.appointment_id
LEFT JOIN opportunities op ON op.trial_appointment_id = ap.id
WHERE cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
  AND COALESCE(cl.payment_hold, false) = false
  AND is_billable_student(cl.student_id)
  -- TESTE ORAL: paga como aula, mas nunca empilhado sobre outra aula paga do
  -- mesmo aluno no mesmo dia (aí seria pagar duas vezes o mesmo horário).
  -- COALESCE obrigatório: `cl.subtype = 'Teste Oral'` devolve NULL quando o
  -- subtype é nulo (a maioria das aulas), o NOT vira NULL e a aula normal SOME
  -- da folha. Mesmo tropeço da cláusula de reposição — sempre feche o predicado.
  AND NOT COALESCE((
    cl.subtype = 'Teste Oral'
    AND cl.student_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM class_logs c5
      WHERE c5.teacher_id = cl.teacher_id
        AND c5.student_id = cl.student_id
        AND c5.class_date = cl.class_date
        AND c5.id <> cl.id
        AND c5.subtype IS DISTINCT FROM 'Teste Oral'
        AND c5.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
        AND COALESCE(c5.payment_hold, false) = false
    )
  ), false)
  AND NOT COALESCE(cl.subtype IN ('REPOSIÇÃO','REPOSIÇÃO_PROF') AND r.fault_type = 'STUDENT', false)
  AND (
    cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'
    OR cl.appointment_id IS NULL
    OR (
      COALESCE(ap.status, '') <> 'no_show'
      AND COALESCE(op.trial_status, '') <> 'NO_SHOW_STUDENT'
      AND (COALESCE(ap.status, '') = 'completed' OR COALESCE(op.trial_status, '') = 'DONE')
    )
  )
  AND (
    cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'
    OR cl.appointment_id IS NULL
    OR cl.id = (SELECT c2.id FROM class_logs c2
                WHERE c2.subtype = 'AULA EXPERIMENTAL' AND c2.appointment_id = cl.appointment_id
                ORDER BY c2.created_at, c2.id LIMIT 1)
  )
  AND (
    cl.subtype IS DISTINCT FROM 'TREINAMENTO'
    OR cl.appointment_id IS NULL
    OR cl.id = (SELECT c4.id FROM class_logs c4
                WHERE c4.subtype = 'TREINAMENTO' AND c4.appointment_id = cl.appointment_id
                ORDER BY c4.created_at, c4.id LIMIT 1)
  )
  AND NOT (
    cl.booking_id IS NULL
    AND cl.student_id IS NOT NULL
    AND cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'
    AND cl.subtype IS DISTINCT FROM 'TREINAMENTO'
    AND EXISTS (
      SELECT 1 FROM class_logs c3
      WHERE c3.booking_id IS NOT NULL
        AND c3.teacher_id = cl.teacher_id AND c3.student_id = cl.student_id
        AND c3.class_date = cl.class_date
        AND c3.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
        AND COALESCE(c3.payment_hold, false) = false
    )
  );

GRANT SELECT ON public.v_payable_class_logs TO authenticated, service_role;

-- 2) Ajustes manuais do fechamento --------------------------------------------
CREATE TABLE IF NOT EXISTS public.closing_adjustments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  teacher_id  uuid NOT NULL,
  month_year  text NOT NULL,
  description text NOT NULL,
  amount      numeric NOT NULL,           -- pode ser negativo (desconto)
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closing_adjustments_teacher
  ON public.closing_adjustments (teacher_id, month_year);

COMMENT ON TABLE public.closing_adjustments IS
  'Acordos pontuais que não são aula: reserva de agenda, bônus, desconto. Entram no total do fechamento com o motivo escrito, em vez de a direção editar valor de aula na mão para "encaixar" o combinado.';

ALTER TABLE public.closing_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS adjustments_read ON public.closing_adjustments;
CREATE POLICY adjustments_read ON public.closing_adjustments FOR SELECT TO authenticated
  USING (
    teacher_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                 AND p.role IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR')
                 AND p.tenant_id = closing_adjustments.tenant_id)
  );

CREATE OR REPLACE FUNCTION public.set_closing_adjustment(
  p_teacher_id uuid, p_month text, p_description text, p_amount numeric,
  p_delete_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_caller_tenant text; v_tenant text; v_id uuid;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  IF v_jwt_role IN ('anon','authenticated') THEN
    SELECT role, tenant_id INTO v_caller_role, v_caller_tenant FROM profiles WHERE id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RAISE EXCEPTION 'Apenas a direção pode lançar ajustes no fechamento';
    END IF;
  END IF;

  IF p_delete_id IS NOT NULL THEN
    DELETE FROM closing_adjustments WHERE id = p_delete_id
      AND (v_caller_role = 'SUPER_ADMIN' OR tenant_id = v_caller_tenant);
    RETURN jsonb_build_object('ok', true, 'removido', p_delete_id);
  END IF;

  SELECT tenant_id INTO v_tenant FROM profiles WHERE id = p_teacher_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Professor não encontrado'; END IF;
  IF v_caller_role IN ('SCHOOL_ADMIN','COORDINATOR') AND v_caller_tenant IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'Sem permissão para ajustar professor de outra escola';
  END IF;
  IF p_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Mês inválido (use YYYY-MM)'; END IF;
  IF COALESCE(trim(p_description),'') = '' THEN RAISE EXCEPTION 'Descreva o motivo do ajuste'; END IF;

  INSERT INTO closing_adjustments (tenant_id, teacher_id, month_year, description, amount, created_by)
  VALUES (v_tenant, p_teacher_id, p_month, trim(p_description), p_amount, auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_closing_adjustment(uuid, text, text, numeric, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_closing_adjustment(uuid, text, text, numeric, uuid) TO authenticated;

-- Relatório passa a devolver os ajustes e o total COM eles ---------------------
CREATE OR REPLACE FUNCTION public.teacher_closing_adjustments(p_teacher_id uuid, p_month text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', a.id, 'description', a.description, 'amount', a.amount, 'created_at', a.created_at
  ) ORDER BY a.created_at), '[]'::jsonb)
  FROM closing_adjustments a
  WHERE a.teacher_id = p_teacher_id AND a.month_year = p_month;
$function$;

GRANT EXECUTE ON FUNCTION public.teacher_closing_adjustments(uuid, text) TO authenticated;
