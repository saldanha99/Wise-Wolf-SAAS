-- ============================================================
-- MIGRATION: campos extras em job_applications
-- Permite o formulário institucional gravar origem, vaga,
-- e-mail e as respostas do questionário (professor × vendedor).
-- Execute no Supabase SQL Editor.
-- ============================================================

ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS source TEXT;        -- 'SITE' | 'ADS'
ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS role   TEXT;         -- 'professor' | 'vendedor'
ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS email  TEXT;
ALTER TABLE public.job_applications ADD COLUMN IF NOT EXISTS answers JSONB DEFAULT '{}'::jsonb; -- respostas do step-by-step

-- Filtro rápido por vaga no painel de RH
CREATE INDEX IF NOT EXISTS idx_job_applications_role ON public.job_applications(role);
