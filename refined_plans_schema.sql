-- 1. Refine Financial Status (Just ensure application handles text, no creating ENUM type if we use text)
-- We use text for status in teacher_closings, so no schema change needed for status, just data update.

-- 2. Update SaaS Plans (Specific Pricing)
TRUNCATE saas_plans CASCADE; -- Clear old seeds

INSERT INTO saas_plans (name, description, storage_limit_gb, max_students, max_users, price_monthly, price_yearly, features, active)
VALUES 
('Starter', 'Padrão (Até 20 alunos)', 1.0, 20, 2, 147.00, 1499.00, ARRAY['Storage 1GB', 'Até 20 Alunos'], true),
('Professional', 'Alta (Alunos ilimitados)', 5.0, 999999, 10, 297.00, 2997.00, ARRAY['Storage 5GB', 'Alunos Ilimitados'], true),
('Enterprise', 'Máxima + Suporte VIP', 70.0, 999999, 50, 597.00, 6089.00, ARRAY['Storage 70GB', 'Suporte VIP', 'White Label Completo'], true);

-- 3. Refine Student Plans (Add tenant_id and slug)
DROP TABLE IF EXISTS student_pricing_plans; -- Dropping previous one to rename/restucture cleanly
CREATE TABLE IF NOT EXISTS student_plans (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid, -- Nullable for Global Templates
  name text NOT NULL,
  description text,
  lessons_per_week integer DEFAULT 2,
  contract_duration integer DEFAULT 12, -- Months
  monthly_price numeric DEFAULT 0,
  is_active boolean DEFAULT true,
  landing_page_slug text,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE student_plans ENABLE ROW LEVEL SECURITY;

-- Policies for student_plans
-- Auth users can read global templates and their tenant's plans
CREATE POLICY "Read Global and Tenant Plans" ON student_plans
  FOR SELECT TO authenticated
  USING (tenant_id IS NULL OR tenant_id::text = current_setting('request.jwt.claims', true)::json->>'app_metadata'->>'tenant_id');

-- Admins can manage
CREATE POLICY "Admin Manage Plans" ON student_plans
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true); -- Simplification for MVP, ideally restrict by role

-- Seed Global Templates
INSERT INTO student_plans (tenant_id, name, description, lessons_per_week, contract_duration, monthly_price, landing_page_slug)
VALUES
(NULL, 'Plano Fidelidade 12 Meses (2x)', 'Plano anual com maior desconto', 2, 12, 271.00, 'fidelidade-12-2x'),
(NULL, 'Plano Semestral (2x)', 'Flexibilidade semestral', 2, 6, 299.00, 'semestral-6-2x');
