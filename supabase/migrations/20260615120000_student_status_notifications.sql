-- ============================================================
-- Status do aluno (Ativo/Inativo) controla NOTIFICAÇÕES automáticas
-- ============================================================
-- Problema: aluno inativo (sem professor / sem aulas) continuava recebendo
-- WhatsApp automático (aniversário, lembrete de vencimento). O diretor quer
-- MANTER os dados do aluno inativo, mas SEM notificá-lo, e poder reativar depois.
--
-- Fonte de verdade: profiles.status ('Ativo' default). O diretor alterna via
-- set_student_status(). status_financial='ARCHIVED' (archive_student) também silencia.
-- Valores atuais em produção: só 'Ativo' e 'ACTIVE' (ambos ativos) — o filtro
-- abaixo silencia APENAS valores explicitamente inativos, nunca um aluno ativo.

-- 1) Helper canônico: o aluno pode receber mensagens automáticas?
CREATE OR REPLACE FUNCTION public.is_student_notifiable(p_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((
    SELECT COALESCE(p.status,'Ativo') NOT IN ('Inativo','INACTIVE','Inactive','Arquivado','Cancelado','Trancado')
       AND COALESCE(p.status_financial,'ACTIVE') <> 'ARCHIVED'
    FROM profiles p WHERE p.id = p_id
  ), false);
$$;

-- 2) birthdays_today: professores sempre; alunos só quando notificáveis
CREATE OR REPLACE FUNCTION public.birthdays_today()
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',full_name,'phone',phone,'tenant_id',tenant_id,'role',role)), '[]'::jsonb)
  FROM profiles
  WHERE role IN ('STUDENT','TEACHER') AND birth_date IS NOT NULL
    AND to_char(birth_date,'MM-DD') = to_char(current_date,'MM-DD')
    AND phone IS NOT NULL AND phone <> ''
    AND (
      role = 'TEACHER'
      OR (
        COALESCE(status,'Ativo') NOT IN ('Inativo','INACTIVE','Inactive','Arquivado','Cancelado','Trancado')
        AND COALESCE(status_financial,'ACTIVE') <> 'ARCHIVED'
      )
    );
$$;

-- 3) RPC: diretor alterna status do aluno (Ativo/Inativo) — mantém os dados intactos
CREATE OR REPLACE FUNCTION public.set_student_status(p_student_id uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text; s_tenant text; v_new text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;

  v_new := CASE
    WHEN lower(trim(p_status)) IN ('ativo','active')   THEN 'Ativo'
    WHEN lower(trim(p_status)) IN ('inativo','inactive') THEN 'Inativo'
    ELSE NULL END;
  IF v_new IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'status_invalido'); END IF;

  SELECT tenant_id INTO s_tenant FROM profiles WHERE id = p_student_id AND role = 'STUDENT';
  IF s_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrado'); END IF;
  IF v_role IN ('SCHOOL_ADMIN','COORDINATOR') AND s_tenant <> v_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;

  UPDATE profiles SET status = v_new WHERE id = p_student_id;
  RETURN jsonb_build_object('ok', true, 'status', v_new);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_student_status(uuid, text) TO authenticated;
