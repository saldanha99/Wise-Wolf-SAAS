-- Fix student_insights foreign key to allow cascading delete
ALTER TABLE student_insights
DROP CONSTRAINT IF EXISTS student_insights_student_id_fkey;

ALTER TABLE student_insights
ADD CONSTRAINT student_insights_student_id_fkey
FOREIGN KEY (student_id)
REFERENCES profiles(id)
ON DELETE CASCADE;

-- Also fix student_payments just in case
ALTER TABLE student_payments
DROP CONSTRAINT IF EXISTS student_payments_student_id_fkey;

ALTER TABLE student_payments
ADD CONSTRAINT student_payments_student_id_fkey
FOREIGN KEY (student_id)
REFERENCES profiles(id)
ON DELETE CASCADE;

-- Also student_assignments (if exists)
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'student_assignments') THEN
        ALTER TABLE student_assignments DROP CONSTRAINT IF EXISTS student_assignments_student_id_fkey;
        ALTER TABLE student_assignments ADD CONSTRAINT student_assignments_student_id_fkey FOREIGN KEY (student_id) REFERENCES profiles(id) ON DELETE CASCADE;
    END IF;
END $$;
