-- =============================================
-- SISTEMA DE INDICAÇÃO / AFILIAÇÃO
-- Wise Wolf Language School SaaS
-- Execute no Supabase SQL Editor
-- =============================================

-- 1. Adiciona campo de indicação por ALUNO (teacher já existe)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referrer_student_id uuid REFERENCES profiles(id) ON DELETE SET NULL;

-- 2. Índices para performance
CREATE INDEX IF NOT EXISTS idx_profiles_referrer_student ON profiles(referrer_student_id);
CREATE INDEX IF NOT EXISTS idx_profiles_referrer_teacher ON profiles(referrer_teacher_id);

-- 3. View consolidada de estatísticas de indicação
CREATE OR REPLACE VIEW referral_stats AS
SELECT
  r.id AS referrer_id,
  r.full_name AS referrer_name,
  r.role AS referrer_role,
  r.tenant_id,
  COUNT(p.id) AS total_referrals,
  COUNT(p.id) * 45 AS total_bonus_brl,
  MAX(p.created_at) AS last_referral_at
FROM profiles r
LEFT JOIN profiles p ON (
  p.referrer_teacher_id = r.id
  OR p.referrer_student_id = r.id
)
WHERE r.role IN ('TEACHER', 'STUDENT')
GROUP BY r.id, r.full_name, r.role, r.tenant_id;

-- 4. RLS: Permite que o dono leia seus próprios dados de indicação
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles'
    AND policyname = 'Allow read referrer_student_id'
  ) THEN
    -- Já coberto pela política existente de leitura do próprio perfil
    RAISE NOTICE 'RLS já configurado para profiles.';
  END IF;
END $$;

-- Confirmação
SELECT 'Migração de indicação concluída com sucesso!' AS status;
