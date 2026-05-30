-- Gamificação: vidas (hearts) estilo Duolingo
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS hearts INTEGER DEFAULT 5,
  ADD COLUMN IF NOT EXISTS hearts_updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

COMMENT ON COLUMN public.profiles.hearts IS 'Vidas/corações do aluno (estilo Duolingo). Máx 5. Regenera com o tempo.';
COMMENT ON COLUMN public.profiles.hearts_updated_at IS 'Última atualização das vidas — base para regeneração temporal.';
