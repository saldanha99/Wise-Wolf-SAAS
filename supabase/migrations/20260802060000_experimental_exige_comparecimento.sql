-- Experimental só paga com COMPARECIMENTO REGISTRADO.
--
-- O buraco: o professor lançava a experimental direto no Lançamento de Aulas e
-- ela entrava na folha na hora, sem ninguém ter confirmado que o aluno apareceu.
-- Em julho/2026 isso pagou aula que não aconteceu — inclusive experimental
-- explicitamente marcada como `no_show` no agendamento (a ANDREIA do Flávio) e
-- experimental que nunca saiu de `scheduled` (a Diva Medeiros, que faltou).
--
-- Regra nova, aplicada só à AULA EXPERIMENTAL (a aula regular continua no
-- veredito do professor, conforme cláusula 3.6 do contrato):
--   * PAGA quando há sinal POSITIVO de comparecimento —
--       appointments.status = 'completed'  OU  opportunities.trial_status = 'DONE';
--   * NÃO PAGA quando há falta explícita —
--       appointments.status = 'no_show'    OU  trial_status = 'NO_SHOW_STUDENT',
--     mesmo que o outro lado diga DONE (falta registrada vence);
--   * NÃO PAGA enquanto ninguém confirmou (fica em 'scheduled'). Não some: aparece
--     em "Experimentais/Treinos" para a direção liquidar, e passa a pagar assim
--     que o comparecimento for registrado.
--
-- Experimental sem appointment vinculado continua pagando — não há como aferir,
-- e barrar às cegas puniria lançamento antigo. As 28 de julho/2026 têm vínculo.

CREATE OR REPLACE VIEW public.v_payable_class_logs AS
SELECT
  cl.*,
  COALESCE(
    cl.rate_override,
    -- R$ 16,00 só para quem MINISTRA o treinamento; quem recebe fica nos R$ 8,00
    -- (o participante é o winner_teacher_id da oportunidade).
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
  AND cl.subtype IS DISTINCT FROM 'Teste Oral'
  AND COALESCE(cl.payment_hold, false) = false
  AND is_billable_student(cl.student_id)
  -- Reposição de falta do ALUNO: a original já foi paga → não paga de novo.
  -- COALESCE obrigatório: a maioria das aulas tem subtype NULL, e `NULL IN (...)`
  -- devolve NULL — sem isso o NOT vira NULL e a aula normal some da folha.
  AND NOT COALESCE(cl.subtype IN ('REPOSIÇÃO','REPOSIÇÃO_PROF') AND r.fault_type = 'STUDENT', false)
  -- EXPERIMENTAL: exige comparecimento registrado (regra de 02/08/2026).
  AND (
    cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'
    OR cl.appointment_id IS NULL
    OR (
      -- falta registrada em qualquer um dos dois lados barra o pagamento
      COALESCE(ap.status, '') <> 'no_show'
      AND COALESCE(op.trial_status, '') <> 'NO_SHOW_STUDENT'
      -- e é preciso um sinal positivo de que aconteceu
      AND (COALESCE(ap.status, '') = 'completed' OR COALESCE(op.trial_status, '') = 'DONE')
    )
  )
  -- Experimental: só o primeiro lançamento de cada appointment.
  AND (
    cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'
    OR cl.appointment_id IS NULL
    OR cl.id = (
      SELECT c2.id FROM class_logs c2
      WHERE c2.subtype = 'AULA EXPERIMENTAL'
        AND c2.appointment_id = cl.appointment_id
      ORDER BY c2.created_at, c2.id
      LIMIT 1
    )
  )
  -- Treinamento: um lançamento por appointment.
  AND (
    cl.subtype IS DISTINCT FROM 'TREINAMENTO'
    OR cl.appointment_id IS NULL
    OR cl.id = (
      SELECT c4.id FROM class_logs c4
      WHERE c4.subtype = 'TREINAMENTO'
        AND c4.appointment_id = cl.appointment_id
      ORDER BY c4.created_at, c4.id
      LIMIT 1
    )
  )
  -- Lançamento solto que espelha um lançamento da agenda no mesmo dia.
  AND NOT (
    cl.booking_id IS NULL
    AND cl.student_id IS NOT NULL
    AND cl.subtype IS DISTINCT FROM 'AULA EXPERIMENTAL'
    AND cl.subtype IS DISTINCT FROM 'TREINAMENTO'
    AND EXISTS (
      SELECT 1 FROM class_logs c3
      WHERE c3.booking_id IS NOT NULL
        AND c3.teacher_id = cl.teacher_id
        AND c3.student_id = cl.student_id
        AND c3.class_date = cl.class_date
        AND c3.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
        AND COALESCE(c3.payment_hold, false) = false
    )
  );

COMMENT ON VIEW public.v_payable_class_logs IS
  'Fonte ÚNICA de "esta aula paga o professor" e de quanto paga. R$ 8,00 por aula (turbo por mês pode elevar); R$ 16,00 no TREINAMENTO ministrado por is_trainer; rate_override da direção vence tudo. AULA EXPERIMENTAL só paga com comparecimento registrado (appointments.status=completed ou trial_status=DONE) e nunca paga com no_show.';

GRANT SELECT ON public.v_payable_class_logs TO authenticated, service_role;

-- Experimentais aguardando confirmação: é o que a direção precisa liquidar para
-- o professor receber. Some da folha, mas não some da tela.
CREATE OR REPLACE FUNCTION public.experimentais_sem_confirmacao(p_month text DEFAULT NULL)
RETURNS TABLE(
  class_log_id uuid, teacher_id uuid, teacher_name text, aluno text,
  class_date date, appointment_status text, trial_status text, situacao text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT cl.id, cl.teacher_id, p.full_name,
         COALESCE(ap.student_name, 'Sem nome'), cl.class_date,
         COALESCE(ap.status,'(sem agendamento)'), COALESCE(op.trial_status,'(nulo)'),
         CASE
           WHEN COALESCE(ap.status,'') = 'no_show' OR COALESCE(op.trial_status,'') = 'NO_SHOW_STUDENT'
             THEN 'aluno faltou'
           ELSE 'comparecimento não registrado'
         END
  FROM class_logs cl
  JOIN profiles p ON p.id = cl.teacher_id
  LEFT JOIN appointments ap ON ap.id::text = cl.appointment_id
  LEFT JOIN opportunities op ON op.trial_appointment_id = ap.id
  WHERE cl.subtype = 'AULA EXPERIMENTAL'
    AND cl.appointment_id IS NOT NULL
    AND to_char(cl.class_date,'YYYY-MM') = COALESCE(p_month, to_char(current_date,'YYYY-MM'))
    AND NOT EXISTS (SELECT 1 FROM v_payable_class_logs v WHERE v.id = cl.id)
  ORDER BY p.full_name, cl.class_date;
$function$;

GRANT EXECUTE ON FUNCTION public.experimentais_sem_confirmacao(text) TO authenticated;
