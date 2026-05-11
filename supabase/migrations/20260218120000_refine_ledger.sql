-- Migration: Refine Ledger & Financial Architecture

-- 1. Teacher Contracts (New Table)
CREATE TABLE IF NOT EXISTS teacher_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL DEFAULT 'school-wise-wolf',
    teacher_id UUID NOT NULL REFERENCES auth.users(id),
    hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
    rules_json JSONB DEFAULT '{}'::jsonb, -- Store rules like "pay_absence": true
    effective_from TIMESTAMPTZ DEFAULT NOW(),
    effective_to TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Refine student_payments
ALTER TABLE student_payments 
ADD COLUMN IF NOT EXISTS amount_cents INTEGER,
ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS raw_payload JSONB,
ADD COLUMN IF NOT EXISTS payment_method TEXT,
ADD COLUMN IF NOT EXISTS ledger_entry_created BOOLEAN DEFAULT FALSE;

-- Data Migration (Safe Update for existing float values)
-- Assuming 'value' is float like 150.00 -> 15000 cents
UPDATE student_payments 
SET amount_cents = (value * 100)::INTEGER 
WHERE amount_cents IS NULL AND value IS NOT NULL;

-- 3. Refine financial_transactions (The Ledger)
ALTER TABLE financial_transactions
ADD COLUMN IF NOT EXISTS amount_cents INTEGER,
ADD COLUMN IF NOT EXISTS category TEXT, -- 'student_tuition', 'teacher_payout', 'fee', 'other'
ADD COLUMN IF NOT EXISTS student_payment_id UUID REFERENCES student_payments(id), -- Fixed: UUID
ADD COLUMN IF NOT EXISTS teacher_closing_id UUID, -- Will link to teacher_closings later
ADD COLUMN IF NOT EXISTS parent_transaction_id UUID REFERENCES financial_transactions(id);

-- Data Migration for Ledger
UPDATE financial_transactions
SET amount_cents = (amount * 100)::INTEGER
WHERE amount_cents IS NULL AND amount IS NOT NULL;

UPDATE financial_transactions
SET category = 'student_tuition'
WHERE type = 'ENTRADA' AND category IS NULL;

UPDATE financial_transactions
SET category = 'operational_cost'
WHERE type = 'SAIDA' AND category IS NULL;

-- 4. Reconciliation Issues (New Table)
CREATE TABLE IF NOT EXISTS reconciliation_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL DEFAULT 'school-wise-wolf',
    kind TEXT NOT NULL, -- 'MISSING_LEDGER_ENTRY', 'DUPLICATE'
    student_payment_id UUID REFERENCES student_payments(id), -- Fixed: UUID
    details JSONB,
    resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Views for Analytics

-- V_SCHOOL_CASHFLOW_SUMMARY
CREATE OR REPLACE VIEW v_school_cashflow_summary AS
SELECT 
    tenant_id,
    date_trunc('month', occurred_at) as month,
    SUM(CASE WHEN type = 'ENTRADA' THEN amount_cents ELSE 0 END) as total_entry_cents,
    SUM(CASE WHEN type = 'SAIDA' THEN amount_cents ELSE 0 END) as total_exit_cents,
    (SUM(CASE WHEN type = 'ENTRADA' THEN amount_cents ELSE 0 END) - SUM(CASE WHEN type = 'SAIDA' THEN amount_cents ELSE 0 END)) as balance_cents
FROM financial_transactions
WHERE amount_cents IS NOT NULL
GROUP BY tenant_id, date_trunc('month', occurred_at);

-- V_STUDENT_RECEIVABLES
CREATE OR REPLACE VIEW v_student_receivables AS
SELECT 
    sp.tenant_id,
    sp.student_id,
    p.full_name as student_name,
    COUNT(*) as total_overdue,
    SUM(sp.amount_cents) as total_overdue_cents
FROM student_payments sp
JOIN profiles p ON sp.student_id = p.id
WHERE sp.status = 'OVERDUE'
GROUP BY sp.tenant_id, sp.student_id, p.full_name;

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_financial_transactions_category ON financial_transactions(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_student_payments_status ON student_payments(status);
CREATE INDEX IF NOT EXISTS idx_student_payments_ledger ON student_payments(ledger_entry_created);

-- Security (RLS)
ALTER TABLE teacher_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_issues ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to allow re-run
DROP POLICY IF EXISTS "Admins manage contracts" ON teacher_contracts;
DROP POLICY IF EXISTS "Admins view issues" ON reconciliation_issues;

CREATE POLICY "Admins manage contracts" ON teacher_contracts FOR ALL TO authenticated USING (auth.jwt() ->> 'email' LIKE '%admin%'); -- Placeholder logic, refine later using proper roles
CREATE POLICY "Admins view issues" ON reconciliation_issues FOR ALL TO authenticated USING (auth.jwt() ->> 'email' LIKE '%admin%');
