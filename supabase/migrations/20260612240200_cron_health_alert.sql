-- OBSERVABILIDADE: fim das falhas silenciosas de automação (o anti-fraude de presença
-- ficou MORTO 13 dias sem ninguém perceber). notify_cron_failures() detecta jobs ATIVOS
-- genuinamente quebrados (falhas>0 e 0 sucessos em 24h) e avisa o diretor por WhatsApp
-- via notification_queue → process-notification-queue, com dedup diário por job
-- (automation_sent kind='CRON_ALERT').
CREATE OR REPLACE FUNCTION public.notify_cron_failures()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','cron' AS $$
DECLARE
  r record;
  v_admin record;
  v_sent int := 0;
  v_msg text;
BEGIN
  SELECT id, phone, tenant_id, whatsapp_instance INTO v_admin
  FROM profiles
  WHERE role='SCHOOL_ADMIN' AND whatsapp_instance IS NOT NULL AND phone IS NOT NULL
  ORDER BY tenant_id LIMIT 1;
  IF v_admin.id IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT j.jobname,
           count(*) FILTER (WHERE d.status='failed') AS falhas,
           max(d.return_message) FILTER (WHERE d.status='failed') AS erro
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid=d.jobid
    WHERE d.start_time > now() - interval '24 hours' AND j.active = true
    GROUP BY j.jobname
    HAVING count(*) FILTER (WHERE d.status='failed') > 0
       AND count(*) FILTER (WHERE d.status='succeeded') = 0
  LOOP
    IF EXISTS (SELECT 1 FROM automation_sent WHERE kind='CRON_ALERT' AND subject_id=r.jobname AND ref_date=current_date) THEN
      CONTINUE;
    END IF;
    v_msg := '⚠️ *Alerta de automação Wise Wolf*' || E'\n\n' ||
             'O processo automático *' || r.jobname || '* falhou ' || r.falhas ||
             'x nas últimas 24h e não teve nenhum sucesso.' || E'\n\n' ||
             'Erro: ' || left(COALESCE(r.erro,'(sem detalhe)'), 220) || E'\n\n' ||
             'Vale checar antes que afete alunos/professores.';
    INSERT INTO notification_queue
      (tenant_id, teacher_id, student_phone, message_body, scheduled_for, status, notification_kind)
    VALUES
      (v_admin.tenant_id, v_admin.id, v_admin.phone, v_msg, now(), 'pending', 'CRON_ALERT');
    INSERT INTO automation_sent (kind, subject_id, ref_date) VALUES ('CRON_ALERT', r.jobname, current_date);
    v_sent := v_sent + 1;
  END LOOP;
  RETURN v_sent;
END;
$$;

-- Agendar (executar uma vez no ambiente):
--   SELECT cron.schedule('wisewolf-cron-health', '30 11 * * *', 'SELECT public.notify_cron_failures();');
