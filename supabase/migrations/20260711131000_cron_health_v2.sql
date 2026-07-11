-- HEALTHCHECK v2 — o v1 (20260612240200) só alertava job ATIVO que falhou 24h sem sucesso.
-- Era CEGO para o modo de falha real dos lembretes de aula: cron DESATIVADO (silêncio total
-- por 3 semanas sem ninguém perceber). O v2 adiciona:
--   1. WATCHLIST: crons que DEVEM estar ativos — alerta se alguém os desativar;
--   2. Falhas na notification_queue nas últimas 24h;
--   3. IA caindo (ai_down em ai_wa_messages >= 3 em 24h) — leads ficando sem resposta.
-- Alertas via notification_queue (flush a cada 1 min) com dedupe diário em automation_sent.
-- Passa a rodar 2x/dia (08:30 e 18:30 BRT).

CREATE OR REPLACE FUNCTION public.notify_cron_failures()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_admin record;
  v_sent int := 0;
  v_msg text;
  v_watch text[] := ARRAY[
    'wisewolf-prepare-reminders',
    'wisewolf-process-queue',
    'wisewolf-send-attendance-confirmations',
    'wisewolf-sdr-followups',
    'wisewolf-funnel-sweeper',
    'wisewolf-daily-automations',
    'wisewolf-notify-payment-due'
  ];
  v_job text;
  v_n int;
BEGIN
  -- destinatário: SCHOOL_ADMIN com instância+telefone (o diretor operador)
  SELECT id, phone, tenant_id, whatsapp_instance INTO v_admin
  FROM profiles
  WHERE role='SCHOOL_ADMIN' AND whatsapp_instance IS NOT NULL AND phone IS NOT NULL
  ORDER BY tenant_id LIMIT 1;
  IF v_admin.id IS NULL THEN RETURN 0; END IF;

  -- 1) Jobs ativos que falharam 24h sem nenhum sucesso (herdado do v1)
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
    INSERT INTO notification_queue (tenant_id, teacher_id, student_phone, message_body, scheduled_for, status, notification_kind)
    VALUES (v_admin.tenant_id, v_admin.id, v_admin.phone, v_msg, now(), 'pending', 'CRON_ALERT');
    INSERT INTO automation_sent (kind, subject_id, ref_date) VALUES ('CRON_ALERT', r.jobname, current_date);
    v_sent := v_sent + 1;
  END LOOP;

  -- 2) WATCHLIST: cron essencial DESATIVADO (o modo de falha dos lembretes, jun/2026)
  FOREACH v_job IN ARRAY v_watch LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job AND active = false)
       AND NOT EXISTS (SELECT 1 FROM automation_sent WHERE kind='CRON_DISABLED' AND subject_id=v_job AND ref_date=current_date)
    THEN
      v_msg := '🔴 *Automação DESLIGADA — Wise Wolf*' || E'\n\n' ||
               'O processo *' || v_job || '* está DESATIVADO no agendador. ' ||
               'Enquanto estiver assim, essa automação simplesmente não roda (foi exatamente ' ||
               'assim que os lembretes de aula ficaram mudos por 3 semanas em junho).' || E'\n\n' ||
               'Se foi intencional, ok — senão, reative no banco (cron.alter_job).';
      INSERT INTO notification_queue (tenant_id, teacher_id, student_phone, message_body, scheduled_for, status, notification_kind)
      VALUES (v_admin.tenant_id, v_admin.id, v_admin.phone, v_msg, now(), 'pending', 'CRON_ALERT');
      INSERT INTO automation_sent (kind, subject_id, ref_date) VALUES ('CRON_DISABLED', v_job, current_date);
      v_sent := v_sent + 1;
    END IF;
  END LOOP;

  -- 3) Falhas de envio na fila nas últimas 24h
  SELECT count(*) INTO v_n FROM notification_queue
  WHERE status='failed' AND updated_at > now() - interval '24 hours';
  IF v_n > 0 AND NOT EXISTS (SELECT 1 FROM automation_sent WHERE kind='QUEUE_FAILURES' AND subject_id='queue' AND ref_date=current_date) THEN
    v_msg := '⚠️ *Fila de WhatsApp com falhas — Wise Wolf*' || E'\n\n' ||
             v_n || ' notificação(ões) falharam nas últimas 24h (lembretes/avisos que NÃO chegaram). ' ||
             'Confira a conexão do WhatsApp e a tabela notification_queue.';
    INSERT INTO notification_queue (tenant_id, teacher_id, student_phone, message_body, scheduled_for, status, notification_kind)
    VALUES (v_admin.tenant_id, v_admin.id, v_admin.phone, v_msg, now(), 'pending', 'CRON_ALERT');
    INSERT INTO automation_sent (kind, subject_id, ref_date) VALUES ('QUEUE_FAILURES', 'queue', current_date);
    v_sent := v_sent + 1;
  END IF;

  -- 4) IA do atendimento caindo (lead fica sem resposta e o CAC do ads evapora)
  SELECT count(*) INTO v_n FROM ai_wa_messages
  WHERE meta->>'kind' = 'ai_down' AND created_at > now() - interval '24 hours';
  IF v_n >= 3 AND NOT EXISTS (SELECT 1 FROM automation_sent WHERE kind='AI_DOWN' AND subject_id='ai' AND ref_date=current_date) THEN
    v_msg := '🤖⚠️ *IA de atendimento instável — Wise Wolf*' || E'\n\n' ||
             'A atendente IA não conseguiu responder ' || v_n || ' mensagem(ns) nas últimas 24h ' ||
             '(quota/crédito dos modelos). Leads podem estar ficando sem resposta. ' ||
             'Confira o crédito do OpenRouter/Gemini.';
    INSERT INTO notification_queue (tenant_id, teacher_id, student_phone, message_body, scheduled_for, status, notification_kind)
    VALUES (v_admin.tenant_id, v_admin.id, v_admin.phone, v_msg, now(), 'pending', 'CRON_ALERT');
    INSERT INTO automation_sent (kind, subject_id, ref_date) VALUES ('AI_DOWN', 'ai', current_date);
    v_sent := v_sent + 1;
  END IF;

  RETURN v_sent;
END;
$$;

-- 2x/dia: 08:30 e 18:30 BRT (11:30 e 21:30 UTC)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wisewolf-cron-health') THEN
        PERFORM cron.unschedule('wisewolf-cron-health');
    END IF;
    PERFORM cron.schedule('wisewolf-cron-health', '30 11,21 * * *', 'SELECT public.notify_cron_failures();');
END;
$$;
