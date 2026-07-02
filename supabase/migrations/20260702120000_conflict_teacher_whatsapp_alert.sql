-- Antifraude: ao nascer um CONFLITO na reconciliação, enfileira aviso gentil ao PROFESSOR
-- via WhatsApp central da escola (notification_queue -> process-notification-queue, cron 1min).
-- Aplicada em produção em 02/07/2026 via MCP (migration: conflict_teacher_whatsapp_alert).
CREATE OR REPLACE FUNCTION public.reconcile_attendance_confirmation(p_conf_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c attendance_confirmations%ROWTYPE;
  lg class_logs%ROWTYPE;
  v_status text;
  v_hold boolean := false;
  v_reported text;
  v_msg text;
  v_lanc text;
  v_resp text;
BEGIN
  SELECT * INTO c FROM attendance_confirmations WHERE id = p_conf_id;
  IF NOT FOUND THEN RETURN; END IF;
  -- decisões do admin são finais
  IF c.status IN ('RESOLVED_PAID', 'RESOLVED_UNPAID') THEN RETURN; END IF;

  -- acha o lançamento do professor para ESTA ocorrência (por booking/reschedule/appointment + data)
  SELECT * INTO lg FROM class_logs
   WHERE class_date = c.class_date
     AND ( (c.source_type = 'booking'     AND booking_id     = c.source_id)
        OR (c.source_type = 'reschedule'  AND reschedule_id  = c.source_id)
        OR (c.source_type = 'appointment' AND appointment_id = c.source_id) )
   ORDER BY created_at DESC
   LIMIT 1;

  v_reported := lg.presence;  -- NULL se o professor ainda não lançou

  IF c.student_response IS NULL AND v_reported IS NULL THEN
    v_status := 'PENDING';                 -- esperando aluno e professor
  ELSIF c.student_response IS NOT NULL AND v_reported IS NULL THEN
    v_status := 'AWAITING_TEACHER';        -- aluno já respondeu; professor não lançou ainda
  ELSIF c.student_response IS NULL AND v_reported IS NOT NULL THEN
    v_status := 'PENDING';                 -- professor lançou; esperando aluno
  ELSE
    -- ambos presentes => reconcilia
    IF v_reported = 'COMPLETED' THEN
      IF c.student_response = 'STUDENT_PRESENT' THEN v_status := 'CONFIRMED';
      ELSE v_status := 'CONFLICT'; v_hold := true; END IF;
    ELSIF v_reported = 'STUDENT_ABSENCE' THEN
      IF c.student_response = 'STUDENT_SELF_ABSENT' THEN v_status := 'CONFIRMED';
      ELSE v_status := 'CONFLICT'; v_hold := true; END IF;
    ELSE
      v_status := 'CONFIRMED';  -- TEACHER_ABSENCE/outros: professor não recebe de qualquer forma
    END IF;
  END IF;

  UPDATE attendance_confirmations
     SET class_log_id     = COALESCE(lg.id, class_log_id),
         teacher_reported = COALESCE(v_reported, teacher_reported),
         status           = v_status
   WHERE id = c.id;

  IF lg.id IS NOT NULL THEN
    UPDATE class_logs
       SET verification_status = v_status,
           payment_hold        = v_hold,
           student_confirmed   = (c.student_response IS NOT NULL)
     WHERE id = lg.id;
  END IF;

  -- Conflito => avisa o professor por WhatsApp, 1x por confirmação (dedupe por source_id+kind).
  -- teacher_id fica NULL de propósito na fila: força o process-notification-queue a usar a
  -- instância CENTRAL da escola (a mensagem deve vir DA ESCOLA, não do WhatsApp do professor).
  -- Nunca pode quebrar a reconciliação: qualquer erro vira apenas WARNING.
  IF v_status = 'CONFLICT' AND c.teacher_id IS NOT NULL AND c.tenant_id IS NOT NULL THEN
    BEGIN
      v_lanc := CASE v_reported
        WHEN 'COMPLETED'       THEN 'Aula realizada'
        WHEN 'STUDENT_ABSENCE' THEN 'Aluno faltou'
        ELSE COALESCE(v_reported, '—') END;
      v_resp := CASE c.student_response
        WHEN 'STUDENT_PRESENT'     THEN 'Tive minha aula normalmente'
        WHEN 'TEACHER_NO_SHOW'     THEN 'O professor não apareceu'
        WHEN 'STUDENT_SELF_ABSENT' THEN 'Eu que não pude comparecer'
        ELSE COALESCE(c.student_response, '—') END;

      v_msg :=
        'Oi, ' || COALESCE(NULLIF(split_part(c.teacher_name, ' ', 1), ''), 'professor') || '! Tudo bem? Aqui é da coordenação da Wise Wolf 🐺' || E'\n\n' ||
        'Na checagem automática das aulas apareceu uma divergência e queremos entender melhor com você — sem stress, às vezes é só um mal-entendido. 😊' || E'\n\n' ||
        '📅 Aula de ' || to_char(c.class_date, 'DD/MM') || COALESCE(' às ' || left(c.class_time, 5), '') || ' com ' || COALESCE(c.student_name, 'aluno(a)') || E'\n' ||
        '📝 Seu lançamento: ' || v_lanc || E'\n' ||
        '💬 Resposta do aluno: "' || v_resp || '"' || E'\n\n' ||
        'Pode nos contar como foi essa aula? É só responder por aqui mesmo.' || E'\n\n' ||
        'Enquanto isso, ela fica como "em análise" no fechamento — assim que alinharmos, liberamos tudo certinho. Obrigado! 💜';

      INSERT INTO notification_queue
        (tenant_id, teacher_id, student_id, student_name, student_phone, message_body,
         scheduled_for, status, source_id, source_type, class_date, notification_kind)
      SELECT c.tenant_id, NULL, c.student_id, c.teacher_name, p.phone, v_msg,
             now(), 'pending', c.id, 'attendance_confirmation', c.class_date, 'CONFLICT_TEACHER_ALERT'
      FROM profiles p
      WHERE p.id = c.teacher_id
        AND COALESCE(p.phone, '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM notification_queue nq
          WHERE nq.source_id = c.id
            AND nq.notification_kind = 'CONFLICT_TEACHER_ALERT'
        );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'reconcile_attendance_confirmation: falha ao enfileirar aviso de conflito p/ conf %: %', c.id, SQLERRM;
    END;
  END IF;
END;
$function$;
