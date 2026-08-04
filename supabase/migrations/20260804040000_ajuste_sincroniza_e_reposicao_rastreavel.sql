-- Duas correções que andam juntas: o ajuste chega ao repasse, e a reposição
-- para de perder a origem.
--
-- 1) AJUSTE QUE NÃO CHEGAVA NO REPASSE
--    `set_closing_adjustment` grava em closing_adjustments e para por aí. O
--    fechamento (teacher_closings) é snapshot e não se atualiza sozinho — foi
--    por isso que os R$ 30,00 da Lais ficaram invisíveis por dias e eu tive de
--    somar na mão. Botão novo na tela sem esta correção recriaria o mesmo bug,
--    agora com mais gente usando.
--
--    Só mexe em fechamento PENDENTE. Fechamento pago, em revisão ou rejeitado
--    tem decisão humana em cima; mudar valor por baixo seria pior que não somar.
--
-- 2) REPOSIÇÃO PERDIA A ORIGEM
--    O LessonLauncher APAGA a linha de `reschedules` logo depois de criar o
--    class_log que a referencia:
--        await supabase.from('reschedules').delete().in('id', completedReschedules)
--    Resultado: 12 dos 13 class_logs com reschedule_id apontam para nada, e a
--    regra que dependia de `fault_type` nunca disparava.
--
--    A exclusão era desnecessária: a lista de pendentes já filtra por "existe
--    class_log apontando para esta reposição?". Trocar DELETE por marcar
--    `used_at` mantém o mesmo comportamento na tela e preserva a prova de quem
--    faltou — que é o que decide se a reposição paga.

-- ── 1. Ajuste sincroniza o fechamento ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_closing_adjustment(
  p_teacher_id uuid, p_month text, p_description text, p_amount numeric,
  p_delete_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_caller_tenant text; v_tenant text; v_id uuid;
  v_old record; v_sync boolean;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  IF v_jwt_role IN ('anon','authenticated') THEN
    SELECT role, tenant_id INTO v_caller_role, v_caller_tenant FROM profiles WHERE id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RAISE EXCEPTION 'Apenas a direção pode lançar ajustes no fechamento';
    END IF;
  END IF;

  IF p_delete_id IS NOT NULL THEN
    SELECT * INTO v_old FROM closing_adjustments WHERE id = p_delete_id;
    IF v_old.id IS NULL THEN RETURN jsonb_build_object('ok', true, 'removido', p_delete_id); END IF;

    DELETE FROM closing_adjustments WHERE id = p_delete_id
      AND (v_caller_role = 'SUPER_ADMIN' OR tenant_id = v_caller_tenant);
    IF NOT FOUND THEN RETURN jsonb_build_object('error','sem_permissao'); END IF;

    -- Tira do repasse o que acabou de sair do ajuste.
    UPDATE teacher_closings SET total_amount = total_amount - v_old.amount, updated_at = now()
     WHERE teacher_id = v_old.teacher_id AND month_year = v_old.month_year AND status = 'PENDENTE';
    v_sync := FOUND;
    RETURN jsonb_build_object('ok', true, 'removido', p_delete_id, 'repasse_atualizado', v_sync);
  END IF;

  SELECT tenant_id INTO v_tenant FROM profiles WHERE id = p_teacher_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Professor não encontrado'; END IF;
  IF v_caller_role IN ('SCHOOL_ADMIN','COORDINATOR') AND v_caller_tenant IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'Sem permissão para ajustar professor de outra escola';
  END IF;
  IF p_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Mês inválido (use YYYY-MM)'; END IF;
  IF COALESCE(trim(p_description),'') = '' THEN RAISE EXCEPTION 'Descreva o motivo do ajuste'; END IF;
  IF p_amount IS NULL OR p_amount = 0 THEN RAISE EXCEPTION 'Informe um valor diferente de zero'; END IF;

  INSERT INTO closing_adjustments (tenant_id, teacher_id, month_year, description, amount, created_by)
  VALUES (v_tenant, p_teacher_id, p_month, trim(p_description), p_amount, auth.uid())
  RETURNING id INTO v_id;

  -- ⚠️ O que faltava: o ajuste tem de chegar ao valor que o professor recebe.
  UPDATE teacher_closings SET total_amount = total_amount + p_amount, updated_at = now()
   WHERE teacher_id = p_teacher_id AND month_year = p_month AND status = 'PENDENTE';
  v_sync := FOUND;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'valor', p_amount,
    'repasse_atualizado', v_sync,
    'aviso', CASE WHEN v_sync THEN NULL
      ELSE 'O ajuste foi registrado, mas o fechamento deste mês não está PENDENTE — o valor NÃO entrou no repasse automaticamente.' END);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_closing_adjustment(uuid,text,text,numeric,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_closing_adjustment(uuid,text,text,numeric,uuid) TO authenticated, service_role;

-- ── 2. Reposição rastreável ──────────────────────────────────────────────────
ALTER TABLE public.reschedules ADD COLUMN IF NOT EXISTS used_at timestamptz;

COMMENT ON COLUMN public.reschedules.used_at IS
  'Quando a reposição foi lançada como aula. Substitui o DELETE que o LessonLauncher fazia e que apagava a prova de quem faltou (fault_type).';

CREATE INDEX IF NOT EXISTS idx_reschedules_pendentes
  ON public.reschedules (teacher_id) WHERE used_at IS NULL;
