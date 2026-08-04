-- Cobertura: a aula muda de professor, o pagamento vai junto.
--
-- Faltava a peça final. O AbsenceCoverageManager organiza a cobertura ANTES
-- (avisa o substituto, acha quem tem horário livre), mas nada movia a aula depois
-- de lançada. Quando a cobertura é de última hora — o caso comum — o professor
-- original lança a aula como se tivesse dado, e a folha paga quem não deu.
-- Aconteceu em julho/2026: uma aula do João Pedro ficou no Mateus, tendo sido
-- outro professor que cobriu.
--
-- Agora o diretor move o lançamento em um clique: sai da folha de quem não deu,
-- entra na de quem deu, e fica registrado quem trocou, quando e por quê.

-- A tabela class_coverages JÁ EXISTE (fluxo planejado do AbsenceCoverageManager,
-- com token/handshake — nunca usado, 0 linhas). Em vez de criar uma segunda
-- tabela e partir o histórico em dois, ela ganha as colunas do movimento
-- retroativo. Assim a direção vê cobertura planejada e cobertura corrigida
-- depois no mesmo lugar.
ALTER TABLE public.class_coverages
  ADD COLUMN IF NOT EXISTS class_log_id uuid REFERENCES class_logs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS moved_by uuid,
  ADD COLUMN IF NOT EXISTS moved_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_class_coverages_log ON public.class_coverages (class_log_id);

-- A cobertura aplicada retroativamente é uma aula que JÁ ACONTECEU — status
-- COMPLETED. É o que o CHECK existente permite (SCHEDULED/COMPLETED/CANCELLED);
-- o que distingue este registro do fluxo planejado é ter class_log_id/moved_at.

COMMENT ON COLUMN public.class_coverages.class_log_id IS
  'Lançamento de aula que foi movido de um professor para outro (status COMPLETED + moved_at preenchido). NULL nas coberturas combinadas antes da aula, que ainda não têm lançamento.';

-- Move a aula para o professor que cobriu -------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_class_coverage(
  p_log_id uuid,
  p_to_teacher uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_caller_tenant text;
  v_from uuid; v_tenant text; v_date date; v_month text;
  v_to_tenant text; v_to_role text;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  IF v_jwt_role IN ('anon','authenticated') THEN
    SELECT role, tenant_id INTO v_caller_role, v_caller_tenant FROM profiles WHERE id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RAISE EXCEPTION 'Apenas a direção pode transferir uma aula entre professores';
    END IF;
  END IF;

  SELECT teacher_id, tenant_id, class_date INTO v_from, v_tenant, v_date
  FROM class_logs WHERE id = p_log_id;
  IF v_from IS NULL THEN RAISE EXCEPTION 'Lançamento não encontrado'; END IF;

  IF v_caller_role IN ('SCHOOL_ADMIN','COORDINATOR') AND v_caller_tenant IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'Sem permissão para mexer em aula de outra escola';
  END IF;

  IF p_to_teacher = v_from THEN
    RAISE EXCEPTION 'A aula já está com este professor';
  END IF;

  SELECT tenant_id, role INTO v_to_tenant, v_to_role FROM profiles WHERE id = p_to_teacher;
  IF v_to_role IS DISTINCT FROM 'TEACHER' THEN
    RAISE EXCEPTION 'O destino precisa ser um professor';
  END IF;
  IF v_to_tenant IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'O professor de destino é de outra escola';
  END IF;

  v_month := to_char(v_date,'YYYY-MM');

  UPDATE class_logs SET teacher_id = p_to_teacher WHERE id = p_log_id;

  INSERT INTO class_coverages (class_log_id, tenant_id, original_teacher_id, cover_teacher_id,
                               student_id, class_date, status, notes, moved_by, moved_at)
  SELECT p_log_id, v_tenant, v_from, p_to_teacher, cl.student_id, v_date, 'COMPLETED',
         p_reason, auth.uid(), now()
  FROM class_logs cl WHERE cl.id = p_log_id;

  -- Recalcula o fechamento PENDENTE dos DOIS professores (o congelado não se mexe).
  UPDATE teacher_closings tc SET
    total_lessons = sub.paid, total_amount = sub.amount, updated_at = now(),
    teacher_confirmation_status = CASE WHEN tc.teacher_confirmation_status='OK' THEN 'PENDENTE' ELSE tc.teacher_confirmation_status END,
    teacher_confirmation_date   = CASE WHEN tc.teacher_confirmation_status='OK' THEN NULL ELSE tc.teacher_confirmation_date END
  FROM (
    SELECT v.teacher_id, count(*) AS paid, round(COALESCE(sum(v.rate_efetivo),0),2) AS amount
    FROM v_payable_class_logs v
    WHERE v.teacher_id IN (v_from, p_to_teacher) AND to_char(v.class_date,'YYYY-MM') = v_month
    GROUP BY v.teacher_id
  ) sub
  WHERE tc.teacher_id = sub.teacher_id AND tc.month_year = v_month AND tc.status = 'PENDENTE';

  -- Professor que ficou sem NENHUMA aula no mês zera o fechamento pendente
  -- (o UPDATE acima não alcança quem sumiu do agregado).
  UPDATE teacher_closings SET total_lessons = 0, total_amount = 0, updated_at = now()
   WHERE teacher_id IN (v_from, p_to_teacher) AND month_year = v_month AND status = 'PENDENTE'
     AND NOT EXISTS (SELECT 1 FROM v_payable_class_logs v
                      WHERE v.teacher_id = teacher_closings.teacher_id
                        AND to_char(v.class_date,'YYYY-MM') = v_month);

  RETURN jsonb_build_object('ok', true, 'log_id', p_log_id, 'de', v_from, 'para', p_to_teacher,
    'data', v_date, 'mes', v_month);
END;
$function$;

COMMENT ON FUNCTION public.transfer_class_coverage(uuid, uuid, text) IS
  'Move um lançamento de aula para o professor que cobriu: desconta de quem não deu, credita em quem deu, registra em class_coverages e recalcula os dois fechamentos pendentes.';

REVOKE ALL ON FUNCTION public.transfer_class_coverage(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_class_coverage(uuid, uuid, text) TO authenticated;

-- Professores do tenant, para o seletor de destino ----------------------------
CREATE OR REPLACE FUNCTION public.list_tenant_teachers_for_transfer()
RETURNS TABLE(id uuid, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p.id, p.full_name FROM profiles p
  WHERE p.role = 'TEACHER'
    AND p.tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid())
    AND COALESCE(p.lifecycle_status,'active') <> 'offboarded'
  ORDER BY p.full_name;
$function$;

GRANT EXECUTE ON FUNCTION public.list_tenant_teachers_for_transfer() TO authenticated;
