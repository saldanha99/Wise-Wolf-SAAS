-- Migration: Fix All Missing ON DELETE CASCADE constraints
-- This ensures deleting a student or teacher doesn't fail due to FK violations

-- 1. class_logs (Student and Teacher)
ALTER TABLE class_logs DROP CONSTRAINT IF EXISTS class_logs_student_id_fkey;
ALTER TABLE class_logs 
  ADD CONSTRAINT class_logs_student_id_fkey 
  FOREIGN KEY (student_id) 
  REFERENCES profiles(id) 
  ON DELETE CASCADE;

ALTER TABLE class_logs DROP CONSTRAINT IF EXISTS class_logs_teacher_id_fkey;
ALTER TABLE class_logs 
  ADD CONSTRAINT class_logs_teacher_id_fkey 
  FOREIGN KEY (teacher_id) 
  REFERENCES profiles(id) 
  ON DELETE CASCADE;

-- 2. bookings (Teacher)
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_teacher_id_fkey;
ALTER TABLE bookings 
  ADD CONSTRAINT bookings_teacher_id_fkey 
  FOREIGN KEY (teacher_id) 
  REFERENCES profiles(id) 
  ON DELETE CASCADE;

-- 3. reschedules (Student and Teacher)
ALTER TABLE reschedules DROP CONSTRAINT IF EXISTS reschedules_student_id_fkey;
ALTER TABLE reschedules 
  ADD CONSTRAINT reschedules_student_id_fkey 
  FOREIGN KEY (student_id) 
  REFERENCES profiles(id) 
  ON DELETE CASCADE;

ALTER TABLE reschedules DROP CONSTRAINT IF EXISTS reschedules_teacher_id_fkey;
ALTER TABLE reschedules 
  ADD CONSTRAINT reschedules_teacher_id_fkey 
  FOREIGN KEY (teacher_id) 
  REFERENCES profiles(id) 
  ON DELETE CASCADE;

-- 4. student_quiz_attempts
ALTER TABLE student_quiz_attempts DROP CONSTRAINT IF EXISTS student_quiz_attempts_student_id_fkey;
ALTER TABLE student_quiz_attempts 
  ADD CONSTRAINT student_quiz_attempts_student_id_fkey 
  FOREIGN KEY (student_id) 
  REFERENCES auth.users(id) 
  ON DELETE CASCADE;

-- 5. profiles (professor_id / self-reference)
-- Ensure column exists first
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS professor_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_professor_id_fkey;
ALTER TABLE profiles 
  ADD CONSTRAINT profiles_professor_id_fkey 
  FOREIGN KEY (professor_id) 
  REFERENCES profiles(id) 
  ON DELETE SET NULL; -- If a teacher is deleted, students just become unassigned

-- 6. student_payments (Ensure it's there)
ALTER TABLE student_payments DROP CONSTRAINT IF EXISTS student_payments_student_id_fkey;
ALTER TABLE student_payments 
  ADD CONSTRAINT student_payments_student_id_fkey 
  FOREIGN KEY (student_id) 
  REFERENCES profiles(id) 
  ON DELETE CASCADE;

-- 7. Ensure profiles itself cascades from auth.users (CRITICAL)
-- Note: Some systems use id as PK referencing auth.users(id). 
-- Let's ensure this is cascading if it's the FK.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'profiles_id_fkey' AND table_name = 'profiles'
    ) THEN
        ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
    END IF;
    
    -- Re-add it with CASCADE just in case it wasn't
    ALTER TABLE profiles 
      ADD CONSTRAINT profiles_id_fkey 
      FOREIGN KEY (id) 
      REFERENCES auth.users(id) 
      ON DELETE CASCADE;
EXCEPTION
    WHEN others THEN
        RAISE NOTICE 'Could not set profiles_id_fkey to cascade. It might not be defined as a standard FK or named differently.';
END $$;
