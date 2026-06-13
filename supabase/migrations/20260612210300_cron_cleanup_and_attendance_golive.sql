-- Higiene de crons + go-live controlado do anti-fraude de presenca.
--
-- 1) wisewolf-suspend-overdue chamava suspend_overdue_tenants() (inexistente) -> 7/7
--    falhas. A suspensao B2B de tenant inadimplente ja e coberta por run_saas_billing()
--    (past_due -> blocked). Desagendado.
--
-- 2) Apos religar a view (migration 20260612210200), o cron de presenca (job 10) passa
--    a disparar WhatsApp REAL aos alunos. Para evitar um cold-start fora de hora, o job
--    foi pausado (cron.alter_job(10, active:=false), feito operacionalmente) e religa
--    sozinho na segunda 06:00 BRT via a funcao abaixo (auto-desagendavel).
--
-- NOTA: comandos cron.* sao especificos do ambiente (job 10 = wisewolf-send-attendance-
-- confirmations). Guardados em DO block idempotente para reproducibilidade.

-- Desagenda o cron quebrado, se existir.
DO $$
BEGIN
  PERFORM cron.unschedule('wisewolf-suspend-overdue');
EXCEPTION WHEN OTHERS THEN
  NULL; -- ja desagendado
END $$;

-- Funcao de go-live de uso unico: religa o cron de presenca e se remove.
CREATE OR REPLACE FUNCTION public.golive_attendance_cron()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'wisewolf-send-attendance-confirmations';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, active := true);
  END IF;
  PERFORM cron.unschedule('wisewolf-attendance-golive');
END;
$$;

-- Agenda o go-live para segunda 09:00 UTC (06:00 BRT). A funcao se desagenda na 1a
-- execucao -> disparo efetivamente unico.
-- (Executar manualmente apos aplicar:)
--   SELECT cron.schedule('wisewolf-attendance-golive', '0 9 * * 1', 'SELECT public.golive_attendance_cron();');
