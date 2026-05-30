-- Gamificação: vidas (hearts) estilo Duolingo
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS hearts INTEGER DEFAULT 5,
  ADD COLUMN IF NOT EXISTS hearts_updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

COMMENT ON COLUMN public.profiles.hearts IS 'Vidas/corações do aluno (estilo Duolingo). Máx 5. Regenera com o tempo.';
COMMENT ON COLUMN public.profiles.hearts_updated_at IS 'Última atualização das vidas — base para regeneração temporal.';

-- Streak por dia de calendário (separado de last_activity, que o XP sobrescreve)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_streak_date DATE;
COMMENT ON COLUMN public.profiles.last_streak_date IS 'Último dia (calendário) em que o aluno praticou — base da ofensiva/streak.';

-- Garante o índice único usado pelo upsert de matrícula (onConflict student_id,path_id)
CREATE UNIQUE INDEX IF NOT EXISTS student_path_enrollments_student_path_uq
  ON public.student_path_enrollments (student_id, path_id);
