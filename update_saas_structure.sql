-- update_saas_structure.sql
-- System 4: SaaS Management (Super Admin)

-- 1. SaaS Plans Table (Subscription Tiers)
-- Drop table to ensure clean schema (since we changed it recently)
DROP TABLE IF EXISTS saas_plans CASCADE;

CREATE TABLE saas_plans (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL, 
    description TEXT,
    price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    price_yearly DECIMAL(10, 2),
    max_students INTEGER DEFAULT 50,
    max_users INTEGER DEFAULT 1,
    max_storage_gb INTEGER DEFAULT 5,
    active BOOLEAN DEFAULT true,
    features JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. SaaS Leads (B2B CRM Pipeline)
CREATE TABLE IF NOT EXISTS saas_leads (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL, -- Contact Person
    email TEXT,
    phone TEXT,
    school_name TEXT NOT NULL,
    status TEXT DEFAULT 'LEAD', -- 'LEAD', 'DEMO_SCHEDULED', 'TRIAL', 'CLOSED_WON', 'CLOSED_LOST'
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Update Tenants Table (Subscription Status)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES saas_plans(id);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS saas_status TEXT DEFAULT 'active'; 
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP WITH TIME ZONE;

-- 4. SaaS Invoices (Billing)
CREATE TABLE IF NOT EXISTS saas_invoices (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    status TEXT DEFAULT 'pending',
    due_date TIMESTAMP WITH TIME ZONE NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE,
    pdf_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- RLS Policies
ALTER TABLE saas_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_invoices ENABLE ROW LEVEL SECURITY;

-- 5. Policies

-- PLANS: Read-only for everyone, Write for Super Admin
DROP POLICY IF EXISTS "Public read access for plans" ON saas_plans;
CREATE POLICY "Public read access for plans" ON saas_plans
    FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "Super Admin write access for plans" ON saas_plans;
CREATE POLICY "Super Admin write access for plans" ON saas_plans
    FOR ALL
    USING (
        auth.uid() IN (SELECT id FROM profiles WHERE role = 'SUPER_ADMIN')
    );

-- LEADS: Only Super Admin can access SaaS Leads
DROP POLICY IF EXISTS "Super Admin access saas_leads" ON saas_leads;
CREATE POLICY "Super Admin access saas_leads" ON saas_leads
    FOR ALL
    USING (
        auth.uid() IN (SELECT id FROM profiles WHERE role = 'SUPER_ADMIN')
    );

-- INVOICES: Super Admin can manage all. Tenants can view their own.
DROP POLICY IF EXISTS "Super Admin manage invoices" ON saas_invoices;
CREATE POLICY "Super Admin manage invoices" ON saas_invoices
    FOR ALL
    USING (
        auth.uid() IN (SELECT id FROM profiles WHERE role = 'SUPER_ADMIN')
    );

DROP POLICY IF EXISTS "Tenants view own invoices" ON saas_invoices;
CREATE POLICY "Tenants view own invoices" ON saas_invoices
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE profiles.id = auth.uid() 
            AND profiles.tenant_id = saas_invoices.tenant_id 
            AND profiles.role = 'SCHOOL_ADMIN'
        )
    );

-- SEED DATA: Default Plans
INSERT INTO saas_plans (name, description, price, price_yearly, max_students, max_users, max_storage_gb, features, active)
VALUES 
    ('Starter', 'Para quem está começando', 197.00, 1997.00, 100, 1, 10, '["CRM Básico", "Gestão Financeira", "Portal do Aluno"]'::jsonb, true),
    ('Pro', 'Ideal para escolas em crescimento', 397.00, 3997.00, 500, 3, 50, '["CRM Avançado", "Automações", "Landing Pages", "Treinamento Professores"]'::jsonb, true),
    ('Enterprise', 'Escolas grandes e redes', 997.00, 9997.00, 99999, 10, 500, '["White Label Completo", "API Access", "Suporte Prioritário"]'::jsonb, true);
