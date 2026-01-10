-- Landing Page Configuration Table
CREATE TABLE IF NOT EXISTS landing_page_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    headline TEXT NOT NULL DEFAULT 'Aprenda Inglês de Verdade',
    subheadline TEXT DEFAULT 'Metodologia exclusiva para você dominar o idioma.',
    hero_image TEXT,
    cta_text TEXT DEFAULT 'Começar Agora',
    plans JSONB DEFAULT '[]'::JSONB, -- Array of objects: { name, price, features[] }
    colors JSONB DEFAULT '{"primary": "#002366", "secondary": "#D32F2F"}'::JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- CRM Leads Table
CREATE TABLE IF NOT EXISTS crm_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'NEW', -- NEW, CONTACTED, CONVERTED, LOST
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE landing_page_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_leads ENABLE ROW LEVEL SECURITY;

-- Policies for landing_page_configs
CREATE POLICY "Tenants can manage their own LP config" ON landing_page_configs
    USING (tenant_id = (select auth.jwt() ->> 'tenant_id'))
    WITH CHECK (tenant_id = (select auth.jwt() ->> 'tenant_id'));

-- Public read access for LPs (so the public site can load them)
CREATE POLICY "Public read access for LP configs" ON landing_page_configs
    FOR SELECT USING (true);

-- Policies for crm_leads
CREATE POLICY "Tenants can view and manage their leads" ON crm_leads
    USING (tenant_id = (select auth.jwt() ->> 'tenant_id'))
    WITH CHECK (tenant_id = (select auth.jwt() ->> 'tenant_id'));

-- Allow public insertion of leads (for the contact form)
CREATE POLICY "Public can insert leads" ON crm_leads
    FOR INSERT WITH CHECK (true);
