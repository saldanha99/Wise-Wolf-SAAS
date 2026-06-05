-- =====================================================================
-- Liquidação de aulas experimentais e treinamentos pelo diretor.
-- O pagamento ao professor depende de um class_log COMPLETED. Estas RPCs
-- permitem ao diretor marcar "compareceu -> pagar" (gera o class_log) ou
-- "não compareceu" (marca no_show, não paga), a partir dos appointments
-- type experimental/training já realizados.
-- =====================================================================

-- Lista as sessões (experimental/treino) já realizadas, ainda não liquidadas.
-- Corte fixo a partir de 2026-06-01 = ativação do painel (ignora pendências
-- históricas anteriores, conforme decisão de negócio).
CREATE OR REPLACE FUNCTION public.list_pending_trial_sessions()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN RETURN '[]'::jsonb; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'appointment_id', a.id,
      'type',           a.type,
      'start_time',     a.start_time,
      'student_name',   a.student_name,
      'teacher_id',     tch.id,
      'teacher_name',   tch.full_name,
      'hourly_rate',    COALESCE(tch.hourly_rate, 0)
    ) ORDER BY a.start_time DESC)
    FROM appointments a
    LEFT JOIN opportunities o ON o.trial_appointment_id = a.id
    LEFT JOIN profiles tch ON tch.id = COALESCE(a.teacher_id, o.winner_teacher_id)
    WHERE a.type IN ('experimental','training')
      AND a.tenant_id = v_tenant
      AND a.status = 'scheduled'                      -- ainda não liquidada
      AND a.start_time <= now()                       -- a hora já passou (realizada)
      AND a.start_time >= '2026-06-01'::timestamptz   -- ignora o passado histórico
      AND tch.id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM class_logs cl WHERE cl.appointment_id = a.id::text)
  ), '[]'::jsonb);
END;
$$;

-- Liquida uma sessão: se compareceu, gera class_log COMPLETED (paga ao professor);
-- senão, marca o appointment como no_show (não paga). Idempotente.
CREATE OR REPLACE FUNCTION public.settle_trial_session(p_appointment_id uuid, p_attended boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text; a_tenant text; a_type text; a_start timestamptz;
        v_teacher uuid; v_subtype text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;

  SELECT ap.tenant_id, ap.type, ap.start_time, COALESCE(ap.teacher_id, o.winner_teacher_id)
    INTO a_tenant, a_type, a_start, v_teacher
    FROM appointments ap
    LEFT JOIN opportunities o ON o.trial_appointment_id = ap.id
    WHERE ap.id = p_appointment_id;

  IF a_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrado'); END IF;
  IF v_role = 'SCHOOL_ADMIN' AND a_tenant <> v_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  IF EXISTS (SELECT 1 FROM class_logs cl WHERE cl.appointment_id = p_appointment_id::text) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ja_lancado');
  END IF;
  IF v_teacher IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'sem_professor'); END IF;

  v_subtype := CASE WHEN a_type = 'training' THEN 'TREINAMENTO' ELSE 'AULA EXPERIMENTAL' END;

  IF p_attended THEN
    INSERT INTO class_logs (tenant_id, teacher_id, appointment_id, presence, subtype, date, class_date, created_at)
    VALUES (a_tenant, v_teacher, p_appointment_id::text, 'COMPLETED', v_subtype,
            (a_start AT TIME ZONE 'America/Sao_Paulo')::date,
            (a_start AT TIME ZONE 'America/Sao_Paulo')::date, now());
    UPDATE appointments SET status = 'completed' WHERE id = p_appointment_id;
    RETURN jsonb_build_object('ok', true, 'paid', true);
  ELSE
    UPDATE appointments SET status = 'no_show' WHERE id = p_appointment_id;
    RETURN jsonb_build_object('ok', true, 'paid', false);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pending_trial_sessions()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_trial_session(uuid, boolean) TO authenticated;
