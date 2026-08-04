-- Turbo apurado por MÊS FECHADO, não por janela móvel de 30 dias.
--
-- O problema (visto na folha de julho/2026 do Mateus): a assiduidade era medida
-- numa janela móvel de 30 dias a partir da DATA DE CADA AULA. Ele faltou em
-- 10/06, "limpou" em 10/07 e o turbo ligou no meio do mês — as aulas de 01 a 09/07
-- saíram a R$ 8,00 e as de 10 a 30/07 a R$ 9,50/R$ 10,50, no mesmo aluno. Isso
-- gerava três problemas:
--   1. o diretor precisava editar aula por aula na mão para achatar o mês;
--   2. o "valor base" do aluno virava média quebrada (9,04 · 8,96 · 9,39 · 9,67);
--   3. a regra do negócio é outra — "faltou, não tem turbo NESSE MÊS".
--
-- Regra nova: o turbo vale para o mês inteiro ou não vale para nenhuma aula dele.
-- Está ativo no mês M quando, cumulativamente:
--   (a) carteira de 10+ alunos ativos (contada pela agenda);
--   (b) ZERO falta do professor no mês M e no mês M-1 (o "1 mês consecutivo sem
--       falta" do contrato, medido em mês cheio);
--   (c) ZERO conflito de lançamento em M e M-1;
--   (d) pelo menos 1 mês de casa e atividade no mês.
--
-- Consequência imediata: julho/2026 do Mateus volta a R$ 1.024,00 (128 × R$ 8,00),
-- porque ele faltou em junho. Nenhum outro professor muda — só ele tinha aula
-- fora de R$ 8,00.

CREATE OR REPLACE FUNCTION public.teacher_turbo_on(p_teacher uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH janela AS (
    -- Mês da aula e o mês anterior: a apuração é sempre por mês cheio, para que
    -- todas as aulas do mesmo mês tenham a MESMA tarifa.
    SELECT date_trunc('month', p_date)::date - INTERVAL '1 month' AS ini,
           (date_trunc('month', p_date) + INTERVAL '1 month')::date AS fim
  )
  SELECT
    -- (a) carteira mínima de 10 alunos ativos, contada pela agenda
    (SELECT count(*) FROM teacher_carteira(p_teacher)) >= 10
    -- (d) pelo menos 1 mês de casa
    AND EXISTS (
      SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
        AND cl.class_date < date_trunc('month', p_date)::date
    )
    -- (d) atividade no mês apurado
    AND EXISTS (
      SELECT 1 FROM class_logs cl, janela j WHERE cl.teacher_id = p_teacher
        AND cl.class_date >= date_trunc('month', p_date)::date AND cl.class_date < j.fim
        AND cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
    )
    -- (b) zero falta do professor no mês e no mês anterior
    AND NOT EXISTS (
      SELECT 1 FROM class_logs cl, janela j WHERE cl.teacher_id = p_teacher
        AND cl.class_date >= j.ini AND cl.class_date < j.fim
        AND cl.presence IN ('TEACHER_ABSENCE','Falta do Professor')
    )
    -- (c) zero conflito de lançamento no mês e no mês anterior
    AND NOT EXISTS (
      SELECT 1 FROM class_logs cl, janela j WHERE cl.teacher_id = p_teacher
        AND cl.class_date >= j.ini AND cl.class_date < j.fim
        AND COALESCE(cl.payment_hold, false)
    )
    AND NOT EXISTS (
      SELECT 1 FROM attendance_confirmations ac, janela j WHERE ac.teacher_id = p_teacher
        AND ac.class_date >= j.ini AND ac.class_date < j.fim
        AND ac.status IN ('CONFLICT','RESOLVED_UNPAID')
    );
$function$;

COMMENT ON FUNCTION public.teacher_turbo_on(uuid, date) IS
  'Turbo do MÊS de p_date. Ou vale para o mês inteiro, ou não vale para nenhuma aula dele — nunca metade do mês numa tarifa e metade em outra. Exige 10+ alunos na carteira (pela agenda) e zero falta/conflito no mês e no mês anterior.';

-- Status do turbo: refletir a apuração mensal, não a janela móvel ---------------
CREATE OR REPLACE FUNCTION public.teacher_turbo_status(p_teacher uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_students int; v_faltas_mes int; v_faltas_ant int; v_conflitos int;
  v_ini date; v_fim date; v_ini_ant date;
BEGIN
  v_ini     := date_trunc('month', current_date)::date;
  v_fim     := (date_trunc('month', current_date) + INTERVAL '1 month')::date;
  v_ini_ant := (date_trunc('month', current_date) - INTERVAL '1 month')::date;

  SELECT count(*) INTO v_students FROM teacher_carteira(p_teacher);

  SELECT count(*) INTO v_faltas_mes FROM class_logs
   WHERE teacher_id = p_teacher AND presence IN ('TEACHER_ABSENCE','Falta do Professor')
     AND class_date >= v_ini AND class_date < v_fim;

  SELECT count(*) INTO v_faltas_ant FROM class_logs
   WHERE teacher_id = p_teacher AND presence IN ('TEACHER_ABSENCE','Falta do Professor')
     AND class_date >= v_ini_ant AND class_date < v_ini;

  SELECT count(*) INTO v_conflitos FROM class_logs
   WHERE teacher_id = p_teacher AND COALESCE(payment_hold, false)
     AND class_date >= v_ini_ant AND class_date < v_fim;

  RETURN jsonb_build_object(
    'active', teacher_turbo_on(p_teacher, current_date),
    'scope', 'month',
    'students_active', v_students,
    'students_required', 10,
    'students_missing', GREATEST(0, 10 - v_students),
    'absences_this_month', v_faltas_mes,
    'absences_last_month', v_faltas_ant,
    'conflicts_open', v_conflitos,
    -- Quando a trava é falta, o turbo só pode voltar no mês seguinte ao último
    -- mês com falta — não adianta "esperar 30 dias".
    'blocked_by', CASE
      WHEN v_students < 10 THEN 'carteira'
      WHEN v_faltas_mes > 0 THEN 'falta_neste_mes'
      WHEN v_faltas_ant > 0 THEN 'falta_mes_passado'
      WHEN v_conflitos > 0 THEN 'conflito'
      -- Sem aula lançada no mês o turbo não liga (e no dia 1º isso é o normal).
      -- Sem este ramo o card mostraria "nada bloqueando" com o turbo desligado.
      WHEN NOT EXISTS (
        SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
          AND cl.class_date >= v_ini AND cl.class_date < v_fim
          AND cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
      ) THEN 'sem_aula_lancada_no_mes'
      ELSE NULL END
  );
END; $function$;
