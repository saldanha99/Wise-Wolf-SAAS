-- 1. Add Signature Columns to Profiles
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS typed_signature TEXT,
ADD COLUMN IF NOT EXISTS signature_hash TEXT;

-- 2. Create Function to Prevent Tampering
CREATE OR REPLACE FUNCTION prevent_contract_tampering()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if contract was already accepted
    IF OLD.contract_accepted = true THEN
        -- Allow updates to *other* columns, but NOT the signature ones
        IF (NEW.contract_accepted IS DISTINCT FROM OLD.contract_accepted) OR
           (NEW.typed_signature IS DISTINCT FROM OLD.typed_signature) OR
           (NEW.signature_hash IS DISTINCT FROM OLD.signature_hash) THEN
               RAISE EXCEPTION 'Integrity Error: Signed contract data cannot be modified.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Create Trigger (Drop first if exists to allow rerunning)
DROP TRIGGER IF EXISTS check_contract_immutability ON profiles;

CREATE TRIGGER check_contract_immutability
BEFORE UPDATE ON profiles
FOR EACH ROW
EXECUTE FUNCTION prevent_contract_tampering();

-- 4. Update View to include new columns
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
    p.audit_status,
    p.validated_by,
    p.validation_date,
    p.rejection_reason,
    p.tenant_id,
    v.full_name AS validator_name,
    -- New Columns
    p.typed_signature,
    p.signature_hash
FROM profiles p
LEFT JOIN profiles v ON p.validated_by = v.id
WHERE p.role = 'STUDENT';

GRANT SELECT ON vw_student_contracts TO authenticated;
GRANT SELECT ON vw_student_contracts TO service_role;
