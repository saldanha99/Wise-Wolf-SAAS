-- Regularização de aula que o ALUNO confirmou e o professor nunca lançou.
--
-- Buraco real encontrado em 31/07/2026: professor que não tem o hábito de lançar
-- (caso Debora — 269 aulas sem lançamento desde 11/06) simplesmente não recebe,
-- porque pagamento = class_logs. Só que a trava anti-fraude JÁ tem a prova
-- independente de que a aula aconteceu: o aluno respondeu a confirmação de
-- presença. Essas linhas ficam em `attendance_confirmations.status =
-- 'AWAITING_TEACHER'` para sempre — o lançador do professor só enxerga 45 dias,
-- o "Aulas Pendentes" 60, e o diretor não tinha NENHUMA tela para lançar por ele.
--
-- Mesmo padrão de rede de segurança já usado em experimental/treino
-- (list_pending_trial_sessions / settle_trial_session): o diretor vê e decide.
-- Nada aqui paga sozinho.

-- 1) O que está órfão: aluno respondeu, ninguém lançou.
CREATE OR REPLACE FUNCTION public.list_unlogged_confirmed_classes(p_days integer DEFAULT 180)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text; v_tenant text; v_out jsonb;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;

  WITH orfas AS (
    SELECT
      ac.id, ac.teacher_id, ac.student_id, ac.student_name, ac.class_date,
      ac.class_time, ac.student_response, ac.source_type,
      COALESCE(p.full_name, ac.teacher_name, 'Professor') AS teacher_name,
      COALESCE(teacher_student_rate(ac.teacher_id, ac.student_id, ac.class_date), 0) AS rate
    FROM attendance_confirmations ac
    LEFT JOIN profiles p ON p.id = ac.teacher_id
    WHERE ac.status = 'AWAITING_TEACHER'
      -- TEACHER_NO_SHOW fica de fora: já tem alerta próprio e NÃO se paga.
      AND ac.student_response IN ('STUDENT_PRESENT','STUDENT_SELF_ABSENT')
      AND ac.class_log_id IS NULL
      AND ac.teacher_id IS NOT NULL
      AND ac.class_date >= current_date - p_days
      AND (v_role = 'SUPER_ADMIN' OR ac.tenant_id = v_tenant)
      -- defesa: se já existe lançamento para a mesma ocorrência, não é órfã
      AND NOT EXISTS (
        SELECT 1 FROM class_logs cl
         WHERE cl.class_date = ac.class_date
           AND ( (ac.source_type = 'booking'    AND cl.booking_id    = ac.source_id)
              OR (ac.source_type = 'reschedule' AND cl.reschedule_id = ac.source_id) )
      )
  )
  SELECT jsonb_build_object(
    'ok', true,
    'total', (SELECT count(*) FROM orfas),
    'valor_total', (SELECT COALESCE(sum(rate), 0) FROM orfas),
    'teachers', COALESCE((
      SELECT jsonb_agg(t ORDER BY (t->>'aulas')::int DESC)
      FROM (
        SELECT jsonb_build_object(
          'teacher_id', o.teacher_id,
          'teacher_name', o.teacher_name,
          'aulas', count(*)::int,
          'valor', COALESCE(sum(o.rate), 0),
          'mais_antiga', min(o.class_date),
          'classes', jsonb_agg(jsonb_build_object(
             'id', o.id,
             'student_name', o.student_name,
             'class_date', o.class_date,
             'class_time', o.class_time,
             'student_response', o.student_response,
             'valor', o.rate
          ) ORDER BY o.class_date)
        ) AS t
        FROM orfas o
        GROUP BY o.teacher_id, o.teacher_name
      ) grp
    ), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$$;

-- 2) A decisão do diretor, uma aula por vez (idempotente).
CREATE OR REPLACE FUNCTION public.settle_confirmed_class(
  p_confirmation_id uuid,
  p_pay boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text; v_tenant text; c attendance_confirmations%ROWTYPE;
  v_presence text; v_log_id uuid;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;

  SELECT * INTO c FROM attendance_confirmations WHERE id = p_confirmation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrado'); END IF;
  IF v_role = 'SCHOOL_ADMIN' AND c.tenant_id IS DISTINCT FROM v_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  IF c.teacher_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'sem_professor'); END IF;
  IF c.student_response NOT IN ('STUDENT_PRESENT','STUDENT_SELF_ABSENT') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'resposta_do_aluno_nao_permite');
  END IF;

  -- Idempotência: aula já lançada (pelo professor ou por um clique anterior).
  IF EXISTS (
    SELECT 1 FROM class_logs cl
     WHERE cl.class_date = c.class_date
       AND ( (c.source_type = 'booking'    AND cl.booking_id    = c.source_id)
          OR (c.source_type = 'reschedule' AND cl.reschedule_id = c.source_id) )
  ) THEN
    PERFORM reconcile_attendance_confirmation(c.id);
    RETURN jsonb_build_object('ok', true, 'already', true, 'error', 'ja_lancado');
  END IF;

  IF NOT p_pay THEN
    UPDATE attendance_confirmations
       SET status = 'RESOLVED_UNPAID',
           admin_resolution = 'Diretor decidiu não lançar/pagar esta aula',
           resolved_by = auth.uid(),
           resolved_at = now()
     WHERE id = c.id;
    RETURN jsonb_build_object('ok', true, 'paid', false);
  END IF;

  -- Lança exatamente o que o ALUNO relatou. Falta do aluno também é paga
  -- (regra canônica: o professor estava disponível e entregou a aula).
  v_presence := CASE WHEN c.student_response = 'STUDENT_PRESENT'
                     THEN 'COMPLETED' ELSE 'STUDENT_ABSENCE' END;

  INSERT INTO class_logs (
    tenant_id, teacher_id, student_id,
    booking_id, reschedule_id,
    presence, date, class_date, observations, created_at
  ) VALUES (
    c.tenant_id, c.teacher_id, c.student_id,
    CASE WHEN c.source_type = 'booking'    THEN c.source_id END,
    CASE WHEN c.source_type = 'reschedule' THEN c.source_id END,
    v_presence, c.class_date, c.class_date,
    'Regularizada pela direção a partir da confirmação do aluno', now()
  )
  RETURNING id INTO v_log_id;

  -- O trigger trg_class_log_reconcile já reconcilia a confirmação (vira CONFIRMED,
  -- porque o lançamento nasce igual à resposta do aluno). Só amarramos o vínculo.
  UPDATE attendance_confirmations
     SET class_log_id = v_log_id,
         admin_resolution = 'Lançada pela direção a partir da confirmação do aluno',
         resolved_by = auth.uid(),
         resolved_at = now()
   WHERE id = c.id;

  RETURN jsonb_build_object('ok', true, 'paid', true, 'class_log_id', v_log_id, 'presence', v_presence);
END;
$$;

REVOKE ALL ON FUNCTION public.list_unlogged_confirmed_classes(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_confirmed_class(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_unlogged_confirmed_classes(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_confirmed_class(uuid, boolean) TO authenticated;
