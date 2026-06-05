-- =====================================================================
-- Contadores de pendências do diretor (fonte única para badges do menu
-- e para a Central de Pendências do Dashboard).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.director_pending_counts()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN RETURN '{}'::jsonb; END IF;

  RETURN jsonb_build_object(
    -- Documentação/contrato de aluno aguardando aprovação ("Acolhimento")
    'acolhimento', (SELECT count(*) FROM profiles
        WHERE tenant_id = v_tenant AND role='STUDENT' AND documentation_status='PENDING'),
    -- Conflitos de presença a resolver ("Verificar Presença")
    'presenca', (SELECT count(*) FROM attendance_confirmations ac
        JOIN class_logs cl ON cl.id = ac.class_log_id
        WHERE cl.tenant_id = v_tenant AND ac.status='CONFLICT'),
    -- Materiais do professor aguardando aprovação ("Aprovar Materiais")
    'materiais', (SELECT count(*) FROM pedagogical_materials
        WHERE tenant_id = v_tenant AND approval_status='PENDING'),
    -- Experimentais/treinos realizados aguardando liquidação ("Experimentais/Treinos")
    'trials', (SELECT count(*) FROM appointments a
        WHERE a.tenant_id = v_tenant AND a.type IN ('experimental','training')
          AND a.status='scheduled' AND a.start_time <= now()
          AND a.start_time >= '2026-06-01'::timestamptz
          AND NOT EXISTS (SELECT 1 FROM class_logs cl WHERE cl.appointment_id = a.id::text)),
    -- Pagamentos retidos por conflito (não badge de menu; usado na Central)
    'pagamentos_retidos', (SELECT count(*) FROM class_logs
        WHERE tenant_id = v_tenant AND COALESCE(payment_hold,false)=true),
    -- Fechamentos mensais de professor pendentes
    'fechamentos', (SELECT count(*) FROM teacher_closings
        WHERE tenant_id = v_tenant AND status='PENDENTE')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.director_pending_counts() TO authenticated;
