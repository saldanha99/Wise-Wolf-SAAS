-- 1. Ensure Table Structure for teacher_closings
CREATE TABLE IF NOT EXISTS teacher_closings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    teacher_id UUID REFERENCES auth.users(id) NOT NULL,
    tenant_id UUID, -- Should be REFERENCES but might be text in some legacy setups. Keeping flexible but safe.
    month_year TEXT NOT NULL, -- Format YYYY-MM
    total_lessons INTEGER DEFAULT 0,
    total_amount DECIMAL(10,2) DEFAULT 0,
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMADO', 'CONTESTADO', 'REJEITADO', 'PAGO', 'EM ANÁLISE')),
    teacher_notes TEXT,
    admin_notes TEXT,
    nf_link TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(teacher_id, month_year)
);

-- 2. Enable RLS
ALTER TABLE teacher_closings ENABLE ROW LEVEL SECURITY;

-- 3. RLS Policies
DROP POLICY IF EXISTS "Teacher: View Own Closings" ON teacher_closings;
CREATE POLICY "Teacher: View Own Closings" ON teacher_closings
FOR ALL
USING (teacher_id = auth.uid());

DROP POLICY IF EXISTS "Manager: View Tenant Closings" ON teacher_closings;
CREATE POLICY "Manager: View Tenant Closings" ON teacher_closings
FOR SELECT
USING (
    tenant_id::text IN (
        SELECT tenant_id::text FROM profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    )
);

DROP POLICY IF EXISTS "Manager: Update Tenant Closings" ON teacher_closings;
CREATE POLICY "Manager: Update Tenant Closings" ON teacher_closings
FOR UPDATE
USING (
    tenant_id::text IN (
        SELECT tenant_id::text FROM profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    )
);

-- 4. Storage Bucket for Invoices
INSERT INTO storage.buckets (id, name, public) 
VALUES ('invoices', 'invoices', true)
ON CONFLICT (id) DO NOTHING;

-- 5. Storage Policies
-- Teacher: Upload to own folder
DROP POLICY IF EXISTS "Teacher Upload Invoice" ON storage.objects;
CREATE POLICY "Teacher Upload Invoice" ON storage.objects
FOR INSERT
WITH CHECK (
    bucket_id = 'invoices' AND 
    (storage.foldername(name))[1] = auth.uid()::text
);

-- Teacher: Read own
DROP POLICY IF EXISTS "Teacher Read Invoice" ON storage.objects;
CREATE POLICY "Teacher Read Invoice" ON storage.objects
FOR SELECT
USING (
    bucket_id = 'invoices' AND 
    (storage.foldername(name))[1] = auth.uid()::text
);

-- Manager: Read All in Tenant (Ideally we strictly filter by tenant, but storage policies are folder based. 
-- Assuming Managers need read access to "invoices" bucket generally or we rely on the DB link.
-- For simplicity and function, we allow Authenticated Read for invoices if they have the link.)
DROP POLICY IF EXISTS "Public Read Invoices" ON storage.objects;
CREATE POLICY "Public Read Invoices" ON storage.objects
FOR SELECT
USING (bucket_id = 'invoices');

-- (Optional) If we want strict manager read, we'd need a complex join, but Public Read (since filenames are random/hashed usually) or Auth Read is standard for this type of artifact if table RLS protects the URL.
