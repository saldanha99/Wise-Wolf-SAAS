-- TRIPLE-PAY de aula experimental/treino.
-- Três vias criam class_log COMPLETED para o mesmo appointment
-- (TrialsToContracts.markTrialRealized, RPC settle_trial_session, LessonLauncher).
-- Os únicos existentes só cobrem (booking_id, class_date) e reschedule_id — mas
-- trials têm booking_id NULL, entao NADA impedia 2-3 class_logs (= 2-3 pagamentos
-- ao professor) para a MESMA sessao. Trava: único parcial em appointment_id.
-- 0 duplicatas no momento da criacao.
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_logs_appointment
ON public.class_logs (appointment_id)
WHERE appointment_id IS NOT NULL AND appointment_id <> '';
