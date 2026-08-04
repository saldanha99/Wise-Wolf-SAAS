-- Cobertura de professor funcionando de ponta a ponta.
--
-- Estado encontrado em 02/08/2026: o fluxo NUNCA funcionou. A constraint de
-- class_coverages.status só aceitava SCHEDULED/COMPLETED/CANCELLED, enquanto as
-- edges coverage-admin e accept-coverage gravam 'pending'/'confirmed'/'declined'.
-- Toda tentativa de organizar cobertura estourava na inserção — daí a tabela com
-- zero linhas. E, mesmo se passasse, o aceite só marcava a linha como confirmada:
-- não movia a aula nem o pagamento, que é o ponto todo.
--
-- Esta migration: (1) abre a constraint para os valores realmente usados;
-- (2) cria apply_coverage_acceptance, que faz o pagamento seguir a aula tanto
-- para aula JÁ lançada quanto para aula futura.

-- 1) Constraint alinhada ao que o código grava --------------------------------
ALTER TABLE public.class_coverages DROP CONSTRAINT IF EXISTS class_coverages_status_check;
ALTER TABLE public.class_coverages ADD CONSTRAINT class_coverages_status_check
  CHECK (status = ANY (ARRAY[
    'pending',    -- convite enviado ao substituto, aguardando aceite
    'confirmed',  -- substituto aceitou (ou coordenação forçou)
    'declined',   -- substituto recusou
    'cancelled',
    -- valores herdados do desenho original, mantidos para não quebrar histórico
    'SCHEDULED', 'COMPLETED', 'CANCELLED'
  ]));

-- 2) Aceite da cobertura move a aula E o pagamento -----------------------------
-- Aula já lançada  → transfere o class_log (desconta de um, credita no outro).
-- Aula ainda futura → a linha confirmada em class_coverages passa a valer para o
--                     lançamento: o professor original não vê mais essa aula e o
--                     substituto passa a vê-la (ver coverage_for_booking abaixo).
CREATE OR REPLACE FUNCTION public.apply_coverage_acceptance(p_coverage_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cov class_coverages%ROWTYPE; v_log_id uuid; v_month text;
BEGIN
  SELECT * INTO v_cov FROM class_coverages WHERE id = p_coverage_id;
  IF v_cov.id IS NULL THEN RAISE EXCEPTION 'Cobertura não encontrada'; END IF;
  IF v_cov.cover_teacher_id IS NULL THEN RAISE EXCEPTION 'Cobertura sem professor substituto'; END IF;

  v_month := to_char(v_cov.class_date, 'YYYY-MM');

  -- A aula já foi lançada pelo professor original? Então é só movê-la.
  SELECT cl.id INTO v_log_id
  FROM class_logs cl
  WHERE cl.teacher_id = v_cov.original_teacher_id
    AND cl.class_date = v_cov.class_date
    AND (cl.booking_id = v_cov.booking_id::text
         OR (v_cov.student_id IS NOT NULL AND cl.student_id = v_cov.student_id))
  ORDER BY cl.created_at LIMIT 1;

  IF v_log_id IS NOT NULL THEN
    UPDATE class_logs SET teacher_id = v_cov.cover_teacher_id WHERE id = v_log_id;
    UPDATE class_coverages SET class_log_id = v_log_id, moved_at = now() WHERE id = p_coverage_id;

    -- Recalcula os dois fechamentos pendentes do mês.
    UPDATE teacher_closings tc SET
      total_lessons = sub.paid, total_amount = sub.amount, updated_at = now(),
      teacher_confirmation_status = CASE WHEN tc.teacher_confirmation_status='OK' THEN 'PENDENTE' ELSE tc.teacher_confirmation_status END,
      teacher_confirmation_date   = CASE WHEN tc.teacher_confirmation_status='OK' THEN NULL ELSE tc.teacher_confirmation_date END
    FROM (
      SELECT v.teacher_id, count(*) AS paid, round(COALESCE(sum(v.rate_efetivo),0),2) AS amount
      FROM v_payable_class_logs v
      WHERE v.teacher_id IN (v_cov.original_teacher_id, v_cov.cover_teacher_id)
        AND to_char(v.class_date,'YYYY-MM') = v_month
      GROUP BY v.teacher_id
    ) sub
    WHERE tc.teacher_id = sub.teacher_id AND tc.month_year = v_month AND tc.status = 'PENDENTE';

    UPDATE teacher_closings SET total_lessons = 0, total_amount = 0, updated_at = now()
     WHERE teacher_id IN (v_cov.original_teacher_id, v_cov.cover_teacher_id)
       AND month_year = v_month AND status = 'PENDENTE'
       AND NOT EXISTS (SELECT 1 FROM v_payable_class_logs v
                        WHERE v.teacher_id = teacher_closings.teacher_id
                          AND to_char(v.class_date,'YYYY-MM') = v_month);

    RETURN jsonb_build_object('ok', true, 'modo', 'aula_movida', 'class_log_id', v_log_id);
  END IF;

  -- Ainda não lançada: a própria linha confirmada redireciona o lançamento.
  RETURN jsonb_build_object('ok', true, 'modo', 'lancamento_redirecionado',
    'booking_id', v_cov.booking_id, 'data', v_cov.class_date);
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_coverage_acceptance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_coverage_acceptance(uuid) TO authenticated, service_role;

-- 3) Quem deve lançar esta aula? ----------------------------------------------
-- Consultada pelo LessonLauncher: com cobertura confirmada, a aula sai da lista
-- do professor original e entra na do substituto. Sem isso o original lançaria
-- (e receberia) uma aula que não deu.
CREATE OR REPLACE FUNCTION public.coverages_for_teacher(p_teacher uuid, p_from date, p_to date)
RETURNS TABLE(
  coverage_id uuid, booking_id uuid, student_id uuid, class_date date, class_time text,
  papel text, outro_professor text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.id, c.booking_id, c.student_id, c.class_date, c.class_time,
         CASE WHEN c.original_teacher_id = p_teacher THEN 'cedida' ELSE 'assumida' END,
         COALESCE(p.full_name, '')
  FROM class_coverages c
  LEFT JOIN profiles p ON p.id = CASE WHEN c.original_teacher_id = p_teacher
                                      THEN c.cover_teacher_id ELSE c.original_teacher_id END
  WHERE c.status = 'confirmed'
    AND c.class_date BETWEEN p_from AND p_to
    AND (c.original_teacher_id = p_teacher OR c.cover_teacher_id = p_teacher);
$function$;

GRANT EXECUTE ON FUNCTION public.coverages_for_teacher(uuid, date, date) TO authenticated;
