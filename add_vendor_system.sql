-- ============================================================
-- MIGRATION: Sistema de Vendedores e Comissões
-- Execute no Supabase SQL Editor
-- ============================================================

-- 1. Adicionar campos ao profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS commission_rate INTEGER DEFAULT 3000; -- centavos (R$30,00)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS specializations TEXT[] DEFAULT '{}';

-- 2. Adicionar vendor_id ao enrollment_links
ALTER TABLE enrollment_links ADD COLUMN IF NOT EXISTS created_by_vendor_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

-- 3. Criar tabela de comissões
CREATE TABLE IF NOT EXISTS vendor_commissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    student_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    enrollment_link_id UUID REFERENCES enrollment_links(id) ON DELETE SET NULL,
    amount_brl INTEGER NOT NULL DEFAULT 3000,  -- centavos
    status TEXT NOT NULL DEFAULT 'PENDING',    -- PENDING | CONFIRMED | PAID
    confirmed_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    tenant_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. RLS para vendor_commissions
ALTER TABLE vendor_commissions ENABLE ROW LEVEL SECURITY;

-- Vendedor vê próprias comissões
CREATE POLICY "vendor_sees_own_commissions" ON vendor_commissions
    FOR SELECT USING (vendor_id = auth.uid());

-- Admin vê e gerencia comissões do tenant
CREATE POLICY "admin_manages_commissions" ON vendor_commissions
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE id = auth.uid()
            AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
            AND tenant_id = vendor_commissions.tenant_id
        )
    );

-- 5. Índices de performance
CREATE INDEX IF NOT EXISTS idx_vendor_commissions_vendor ON vendor_commissions(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_commissions_tenant ON vendor_commissions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vendor_commissions_status ON vendor_commissions(status);
CREATE INDEX IF NOT EXISTS idx_profiles_specializations ON profiles USING GIN(specializations);
CREATE INDEX IF NOT EXISTS idx_enrollment_links_vendor ON enrollment_links(created_by_vendor_id);

-- ============================================================
-- CAMPOS WOLF INTELLIGENCE (executa junto se preferir)
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS english_for TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS student_category TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS learning_objective TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS personality TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferred_topics TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avoided_topics TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS short_term_goal TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS long_term_goal TEXT;

CREATE TABLE IF NOT EXISTS wolf_intelligence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID UNIQUE NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    accumulated_context TEXT,
    strong_points TEXT[],
    weak_points TEXT[],
    recommended_approach TEXT,
    vocabulary_level TEXT,
    grammar_level TEXT,
    total_classes_analyzed INTEGER DEFAULT 0,
    last_updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE wolf_intelligence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teacher_reads_wolf_intel" ON wolf_intelligence
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM bookings b
            WHERE b.student_id = wolf_intelligence.student_id
            AND b.teacher_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.id = auth.uid()
            AND p.role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
            AND p.tenant_id = wolf_intelligence.tenant_id
        )
    );

CREATE POLICY "system_writes_wolf_intel" ON wolf_intelligence
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.id = auth.uid()
            AND p.role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'TEACHER')
        )
    );

CREATE INDEX IF NOT EXISTS idx_wolf_intelligence_student ON wolf_intelligence(student_id);
CREATE INDEX IF NOT EXISTS idx_wolf_intelligence_tenant ON wolf_intelligence(tenant_id);
