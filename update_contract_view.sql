-- Update View to include ALL Contract Details
DROP VIEW IF EXISTS vw_student_contracts;

CREATE OR REPLACE VIEW vw_student_contracts AS
SELECT 
    p.id AS user_id,
    p.full_name AS student_name,
    p.cpf AS student_cpf,
    p.email AS student_email,
    p.phone AS student_phone,
    
    -- Address Details
    p.postal_code AS student_postal_code,
    p.address AS student_address,
    p.address_number AS student_address_number,
    
    -- Financial Details
    p.monthly_fee AS plan_value,
    p.due_day,
    p.class_frequency,
    
    -- Contract Details
    p.contract_accepted,
    p.accepted_at,
    p.signature_ip,
    p.typed_signature,
    p.signature_hash,
    p.student_signature_url,
    p.signed_document_url,
    p.wise_wolf_signature_token,
    p.documentation_status,
    p.audit_status,
    p.rejection_reason,
    p.tenant_id
FROM profiles p
WHERE p.role = 'STUDENT';

GRANT SELECT ON vw_student_contracts TO authenticated;
GRANT SELECT ON vw_student_contracts TO service_role;
