-- Máquina de agendamento de entrevista (funil de professores)
--
-- A Rita aprovava candidatos (ai_recommendation=ENTREVISTAR) e o funil morria:
-- nenhum código escrevia interview_slot. Este migration dá a cada candidatura um
-- token de agendamento (link público da edge book-interview) e garante que dois
-- candidatos não reservem o mesmo horário.

ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS booking_token uuid DEFAULT gen_random_uuid();

UPDATE public.job_applications
   SET booking_token = gen_random_uuid()
 WHERE booking_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS job_applications_booking_token_uniq
  ON public.job_applications (booking_token);

-- Corrida de horário: o segundo candidato que tentar o mesmo slot recebe 23505
-- e a edge devolve a lista atualizada.
CREATE UNIQUE INDEX IF NOT EXISTS job_applications_interview_slot_uniq
  ON public.job_applications (tenant_id, interview_slot)
  WHERE interview_slot IS NOT NULL;

-- Segurança: a policy permissiva deixava QUALQUER autenticado (aluno, professor)
-- ler todas as candidaturas — PII de candidato e, agora, o token de agendamento.
-- A leitura de admin continua coberta por job_apps_admin; o formulário público
-- insere via RPC apply_teacher_candidate (SECURITY DEFINER) e as edges usam
-- service_role. Nenhum caminho legítimo dependia desta policy.
DROP POLICY IF EXISTS "Enable select access for authenticated users" ON public.job_applications;
