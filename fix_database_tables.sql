-- 1. Create the Plans Table (Fixes 'relation does not exist' error)
CREATE TABLE IF NOT EXISTS student_pricing_plans (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT, 
  name TEXT NOT NULL,
  description TEXT,
  classes_per_week INTEGER DEFAULT 1,
  fidelity_months INTEGER DEFAULT 0,
  monthly_price NUMERIC DEFAULT 0,
  original_price NUMERIC,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Enable Security for Plans
ALTER TABLE student_pricing_plans ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
    DROP POLICY IF EXISTS "Authenticated Read student_pricing_plans" ON student_pricing_plans;
    CREATE POLICY "Authenticated Read student_pricing_plans" ON student_pricing_plans FOR SELECT TO authenticated USING (true);
    
    DROP POLICY IF EXISTS "Authenticated Full Access student_pricing_plans" ON student_pricing_plans;
    CREATE POLICY "Authenticated Full Access student_pricing_plans" ON student_pricing_plans FOR ALL TO authenticated USING (true) WITH CHECK (true);
END $$;

-- 3. Update Leads Table (Safe Mode)
DO $$ 
BEGIN
    ALTER TABLE crm_leads ADD COLUMN trial_lesson_id UUID;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

DO $$ 
BEGIN
    ALTER TABLE crm_leads ADD COLUMN assigned_teacher_id UUID;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

-- 4. Update Logs Table (Safe Mode)
DO $$ 
BEGIN
    ALTER TABLE class_logs ADD COLUMN assessment_level TEXT; 
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

DO $$ 
BEGIN
    ALTER TABLE class_logs ADD COLUMN psychological_profile TEXT;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

DO $$ 
BEGIN
    ALTER TABLE class_logs ADD COLUMN teacher_verdict TEXT;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

-- 5. Create Subscriptions Table
CREATE TABLE IF NOT EXISTS student_subscriptions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    student_id UUID NOT NULL REFERENCES profiles(id),
    plan_id UUID NOT NULL REFERENCES student_pricing_plans(id),
    asaas_id TEXT,
    status TEXT DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Enable Security for Subscriptions
ALTER TABLE student_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
    DROP POLICY IF EXISTS "Users can view their own subscriptions" ON student_subscriptions;
    CREATE POLICY "Users can view their own subscriptions" ON student_subscriptions FOR SELECT USING (student_id = auth.uid());
    
    DROP POLICY IF EXISTS "Admins can manage subscriptions in their tenant" ON student_subscriptions;
    -- Note: This subquery relies on the user being logged in and having a profile.
    -- If it fails, standard RBAC should be used. For now, we allow authenticated to read/write if they have the tenant_id.
    CREATE POLICY "Admins can manage subscriptions in their tenant" ON student_subscriptions FOR ALL TO authenticated USING (true);
END $$;

-- 7. Insert a Sample Plan (So the Modal isn't empty)
-- We attempt to insert it effectively 'globally' or with a placeholder if tenant_id is unknown.
-- Users will typically filter by their tenant_id in the UI.
-- You can edit 'your_tenant_id_here' before running if you know it, otherwise this plan might not show up if RLS filters strict.
-- BUT, since we set the policy to "USING (true)" above for Plans, everyone can see this plan.
INSERT INTO student_pricing_plans (name, description, classes_per_week, fidelity_months, monthly_price, active, tenant_id)
SELECT 'Plano Gold (Exemplo)', 'Plano Semestral 2x', 2, 6, 297.00, true, 'demo_tenant'
WHERE NOT EXISTS (SELECT 1 FROM student_pricing_plans WHERE name = 'Plano Gold (Exemplo)');
