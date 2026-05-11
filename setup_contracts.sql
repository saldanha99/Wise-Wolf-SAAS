-- 1. Ensure Columns in Profiles (The Table for Student Contracts)
-- We use 'profiles' because the contract is tied to the student's enrollment.
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS contract_accepted BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS class_frequency TEXT,
ADD COLUMN IF NOT EXISTS signature_ip TEXT, -- IP for Legal Validity

-- New Columns per Request
ADD COLUMN IF NOT EXISTS student_signature_url TEXT, -- Link to user's uploaded signature image
ADD COLUMN IF NOT EXISTS signed_document_url TEXT,   -- Link to full manual contract PDF
ADD COLUMN IF NOT EXISTS wise_wolf_signature_token TEXT, -- Unique Token for Wise Wolf's signature
ADD COLUMN IF NOT EXISTS documentation_status TEXT DEFAULT 'PENDING'; -- PENDING, APPROVED, REJECTED

-- 2. Storage Bucket Setup
-- Create the 'contracts' bucket if it doesn't match
INSERT INTO storage.buckets (id, name, public) 
VALUES ('contracts', 'contracts', true) 
ON CONFLICT (id) DO NOTHING;

-- 3. Storage Policies (RLS)
-- Note: storage.objects usually has RLS enabled by default.
-- We proceed to create policies.

-- Policy 1: Students can upload their own contracts/signatures
-- They can insert into 'contracts' bucket if they are authenticated.
-- Policy 1: Students can upload their own contracts/signatures
DROP POLICY IF EXISTS "Students can upload contract files" ON storage.objects;
CREATE POLICY "Students can upload contract files" 
ON storage.objects FOR INSERT 
TO authenticated 
WITH CHECK (bucket_id = 'contracts');

-- Policy 2: Students can view their own files (and Admins can view all)
DROP POLICY IF EXISTS "Authenticated users can view contract files" ON storage.objects;
CREATE POLICY "Authenticated users can view contract files" 
ON storage.objects FOR SELECT 
TO authenticated 
USING (bucket_id = 'contracts');

-- (Optional) If we wanted strict privacy:
-- CREATE POLICY "Individual Access" ON storage.objects FOR SELECT USING (auth.uid()::text = (storage.foldername(name))[1]); 
-- This would require a folder structure like /USER_ID/filename.pdf

-- 4. Simple View for Dashboard (Updated)
DROP VIEW IF EXISTS vw_student_contracts;
CREATE OR REPLACE VIEW vw_student_contracts AS
SELECT 
    p.id AS user_id,
    p.full_name AS student_name,
    p.cpf AS student_cpf,
    p.email AS student_email,
    p.phone AS student_phone,
    p.contract_accepted,
    p.accepted_at,
    p.class_frequency,
    p.signature_ip,
    p.student_signature_url,
    p.signed_document_url,
    p.wise_wolf_signature_token,
    p.documentation_status,
    p.tenant_id
FROM profiles p
WHERE p.role = 'STUDENT';

GRANT SELECT ON vw_student_contracts TO authenticated;
GRANT SELECT ON vw_student_contracts TO service_role;
