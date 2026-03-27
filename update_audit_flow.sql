-- Add Audit/Validation Columns to Profiles Table
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS audit_status TEXT DEFAULT 'PENDING',
ADD COLUMN IF NOT EXISTS validated_by UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS validation_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Update the View to include these new columns
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
    p.documentation_status, -- Keeping existing one for backward compatibility or UI usage
    p.audit_status,         -- New requested column
    p.validated_by,
    p.validation_date,
    p.rejection_reason,
    p.tenant_id,
    -- Join with validator info if needed
    v.full_name AS validator_name
FROM profiles p
LEFT JOIN profiles v ON p.validated_by = v.id
WHERE p.role = 'STUDENT';

GRANT SELECT ON vw_student_contracts TO authenticated;
GRANT SELECT ON vw_student_contracts TO service_role;
