-- Fix Student Deletion Constraints
-- We drop existing constraints and re-add them with ON DELETE CASCADE

-- 1. class_logs
ALTER TABLE class_logs DROP CONSTRAINT IF EXISTS class_logs_student_id_fkey;
ALTER TABLE class_logs 
  ADD CONSTRAINT class_logs_student_id_fkey 
  FOREIGN KEY (student_id) 
  REFERENCES profiles(id) 
  ON DELETE CASCADE;

-- 2. bookings
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_student_id_fkey;
ALTER TABLE bookings 
  ADD CONSTRAINT bookings_student_id_fkey 
  FOREIGN KEY (student_id) 
  REFERENCES profiles(id) 
  ON DELETE CASCADE;

-- 3. reschedules
ALTER TABLE reschedules DROP CONSTRAINT IF EXISTS reschedules_student_id_fkey;
ALTER TABLE reschedules 
  ADD CONSTRAINT reschedules_student_id_fkey 
  FOREIGN KEY (student_id) 
  REFERENCES profiles(id) 
  ON DELETE CASCADE;

-- 4. financial_records (if exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'financial_records') THEN
        ALTER TABLE financial_records DROP CONSTRAINT IF EXISTS financial_records_student_id_fkey;
        ALTER TABLE financial_records 
          ADD CONSTRAINT financial_records_student_id_fkey 
          FOREIGN KEY (student_id) 
          REFERENCES profiles(id) 
          ON DELETE CASCADE;
    END IF;
END $$;

-- 5. pedagogical_books (if uploaded_by is a student? unlikely, but check tenant_id)
-- Usually books are tenant based, not student based.

-- 6. Ensure RLS allows deletion if cascade doesn't bypass it (Cascade usually bypasses RLS for the dependent rows if done by system, but if done via API...)
-- Actually, ON DELETE CASCADE at DB level happens automatically when the parent is deleted. 
-- The user only needs permission to delete the PARENT (profile).
