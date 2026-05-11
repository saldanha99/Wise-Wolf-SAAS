-- Migration content temporarily removed to resolve "policy already exists" conflict during db push.
-- The policies seem to be already applied in the database.

ALTER TABLE financial_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_closings ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_issues ENABLE ROW LEVEL SECURITY;

-- Helper function to check for school admin
CREATE OR REPLACE FUNCTION is_school_admin()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN (auth.jwt() ->> 'email' LIKE '%admin%') OR 
           EXISTS (
               SELECT 1 FROM profiles 
               WHERE id = auth.uid() 
               AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR')
           );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1. Financial Transactions
DROP POLICY IF EXISTS "Admins view all transactions" ON financial_transactions;
DROP POLICY IF EXISTS "Admins manage transactions" ON financial_transactions;

CREATE POLICY "Admins view all transactions" ON financial_transactions
    FOR SELECT USING (is_school_admin());

CREATE POLICY "Admins manage transactions" ON financial_transactions
    FOR ALL USING (is_school_admin());

-- 2. Student Payments
DROP POLICY IF EXISTS "Admins view all payments" ON student_payments;
DROP POLICY IF EXISTS "Students view own payments" ON student_payments;

CREATE POLICY "Admins view all payments" ON student_payments
    FOR ALL USING (is_school_admin());

CREATE POLICY "Students view own payments" ON student_payments
    FOR SELECT USING (student_id = auth.uid());

-- 3. Teacher Closings
DROP POLICY IF EXISTS "Admins manage closings" ON teacher_closings;
DROP POLICY IF EXISTS "Teachers view own closings" ON teacher_closings;
DROP POLICY IF EXISTS "Teachers insert own closings" ON teacher_closings;
DROP POLICY IF EXISTS "Teachers update own closings" ON teacher_closings;

CREATE POLICY "Admins manage closings" ON teacher_closings
    FOR ALL USING (is_school_admin());

CREATE POLICY "Teachers view own closings" ON teacher_closings
    FOR SELECT USING (teacher_id = auth.uid());

CREATE POLICY "Teachers insert own closings" ON teacher_closings
    FOR INSERT WITH CHECK (teacher_id = auth.uid());

CREATE POLICY "Teachers update own closings" ON teacher_closings
    FOR UPDATE USING (teacher_id = auth.uid());

-- 4. Teacher Contracts
DROP POLICY IF EXISTS "Admins manage contracts" ON teacher_contracts;
DROP POLICY IF EXISTS "Teachers view own contracts" ON teacher_contracts;

CREATE POLICY "Admins manage contracts" ON teacher_contracts
    FOR ALL USING (is_school_admin());

CREATE POLICY "Teachers view own contracts" ON teacher_contracts
    FOR SELECT USING (teacher_id = auth.uid());

-- 5. Reconciliation Issues
DROP POLICY IF EXISTS "Admins manage issues" ON reconciliation_issues;

CREATE POLICY "Admins manage issues" ON reconciliation_issues
    FOR ALL USING (is_school_admin());
