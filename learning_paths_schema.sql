-- =====================================================================
-- LEARNING PATHS / TRILHAS DIDATICAS
-- Estrutura curricular sequencial para os alunos.
-- =====================================================================

-- 1. PATHS: caminhos curriculares (ex: "Business B1", "TOEFL Prep", "Conversation A2")
CREATE TABLE IF NOT EXISTS learning_paths (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,                       -- NULL = global (disponivel para todos os tenants)
  name TEXT NOT NULL,
  description TEXT,
  target_level TEXT,                    -- 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'
  category TEXT,                        -- 'BUSINESS' | 'TOEFL_IELTS' | 'TRAVEL' | 'KIDS' | 'TECH' | 'GENERAL' | 'CONVERSATION'
  cover_image_url TEXT,
  estimated_hours INTEGER,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_learning_paths_tenant ON learning_paths(tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_learning_paths_category ON learning_paths(category, target_level);

-- 2. UNITS: unidades sequenciais dentro de um path
CREATE TABLE IF NOT EXISTS learning_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path_id UUID NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,         -- sequenciamento dentro do path
  title TEXT NOT NULL,
  description TEXT,
  estimated_minutes INTEGER,
  skill_focus TEXT[],                   -- ['grammar', 'vocabulary'] etc
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(path_id, order_index)
);

CREATE INDEX IF NOT EXISTS idx_learning_units_path ON learning_units(path_id, order_index);

-- 3. ACTIVITIES: atividades concretas dentro de uma unit
CREATE TABLE IF NOT EXISTS unit_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id UUID NOT NULL REFERENCES learning_units(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('vocab_cards', 'reading', 'grammar_drill', 'quiz', 'speaking_wolfie', 'listening', 'writing')),
  title TEXT NOT NULL,
  description TEXT,
  content JSONB NOT NULL DEFAULT '{}',  -- payload estruturado conforme o tipo
  xp_reward INTEGER DEFAULT 30,
  estimated_minutes INTEGER DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(unit_id, order_index)
);

CREATE INDEX IF NOT EXISTS idx_unit_activities_unit ON unit_activities(unit_id, order_index);

-- 4. ENROLLMENT: aluno matriculado em um path
CREATE TABLE IF NOT EXISTS student_path_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  path_id UUID NOT NULL REFERENCES learning_paths(id) ON DELETE CASCADE,
  tenant_id TEXT,
  current_unit_id UUID REFERENCES learning_units(id),
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  assigned_by UUID REFERENCES profiles(id),  -- professor que atribuiu (NULL = self-enrolled)
  UNIQUE(student_id, path_id)
);

CREATE INDEX IF NOT EXISTS idx_student_enroll ON student_path_enrollments(student_id);

-- 5. PROGRESS: status de cada atividade por aluno
CREATE TABLE IF NOT EXISTS student_activity_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  activity_id UUID NOT NULL REFERENCES unit_activities(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES learning_units(id),
  status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
  score NUMERIC,                        -- 0-100
  attempts INTEGER DEFAULT 0,
  time_spent_seconds INTEGER DEFAULT 0,
  completed_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(student_id, activity_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_progress_student ON student_activity_progress(student_id, unit_id);

-- 6. SKILL SCORES: snapshot agregado por habilidade
CREATE TABLE IF NOT EXISTS student_skill_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  skill TEXT NOT NULL CHECK (skill IN ('grammar','vocabulary','listening','speaking','reading','writing','pronunciation')),
  current_score NUMERIC DEFAULT 0,      -- 0-100, EMA dos ultimos scores
  total_activities INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT now(),
  UNIQUE(student_id, skill)
);

CREATE INDEX IF NOT EXISTS idx_skill_scores_student ON student_skill_scores(student_id);

-- =====================================================================
-- RLS BASICA
-- =====================================================================
ALTER TABLE learning_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_path_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_activity_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_skill_scores ENABLE ROW LEVEL SECURITY;

-- Todos autenticados leem o conteudo dos paths (sao "templates")
DROP POLICY IF EXISTS lp_read ON learning_paths;
CREATE POLICY lp_read ON learning_paths FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS lu_read ON learning_units;
CREATE POLICY lu_read ON learning_units FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ua_read ON unit_activities;
CREATE POLICY ua_read ON unit_activities FOR SELECT TO authenticated USING (true);

-- Enrollments: aluno ve so o seu, professor/admin ve do tenant
DROP POLICY IF EXISTS spe_self ON student_path_enrollments;
CREATE POLICY spe_self ON student_path_enrollments FOR ALL TO authenticated
USING (
    student_id = auth.uid()
    OR tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid())
);

-- Progress: aluno ve/edita o seu, professor/admin ve do tenant
DROP POLICY IF EXISTS sap_self ON student_activity_progress;
CREATE POLICY sap_self ON student_activity_progress FOR ALL TO authenticated
USING (
    student_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('TEACHER','SCHOOL_ADMIN','SUPER_ADMIN'))
);

-- Skill scores: aluno ve o seu, professor/admin ve dos alunos do tenant
DROP POLICY IF EXISTS sss_self ON student_skill_scores;
CREATE POLICY sss_self ON student_skill_scores FOR ALL TO authenticated
USING (
    student_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('TEACHER','SCHOOL_ADMIN','SUPER_ADMIN'))
);
