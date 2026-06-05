-- =====================================================================
-- Prevenção de duplicação de agenda e de lançamento de aula.
-- Causa do bug: matrícula manual inseria os horários em lote sem trava de
-- unicidade; cliques repetidos no Salvar criavam bookings idênticos, que
-- viravam múltiplas aulas lançáveis (caso Anderson: 6x cada horário).
-- =====================================================================

-- 1. Um aluno não pode ter 2 agendamentos ATIVOS no mesmo dia da semana + horário
--    com o mesmo professor. Índice parcial (só SCHEDULED) — bloqueia o double-submit
--    na fonte, independentemente do frontend.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_no_dup_active
  ON public.bookings (tenant_id, student_id, teacher_id, day_of_week, time_slot)
  WHERE status = 'SCHEDULED' AND student_id IS NOT NULL;

-- 2. Defesa extra: a mesma aula recorrente (booking) não pode ser lançada duas
--    vezes na mesma data (mesmo class_log já era prevenido no app, agora no banco).
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_logs_booking_date
  ON public.class_logs (booking_id, class_date)
  WHERE booking_id IS NOT NULL;
