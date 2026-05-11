-- Add tenant_id to student_payments
ALTER TABLE student_payments 
ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) DEFAULT 'school-wise-wolf'; -- Adjusted to TEXT and known tenant ID

-- Update existing records
UPDATE student_payments SET tenant_id = 'school-wise-wolf' WHERE tenant_id IS NULL;

-- Make it not null after update
-- ALTER TABLE student_payments ALTER COLUMN tenant_id SET NOT NULL;
