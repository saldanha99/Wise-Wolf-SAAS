-- FIX: Add Missing Foreign Keys to Bookings
-- This fixes the "Could not find relationship" error (400) in Supabase
-- Run this in Supabase SQL Editor

-- 1. Add Foreign Key for Student
ALTER TABLE bookings
DROP CONSTRAINT IF EXISTS bookings_student_id_fkey;

ALTER TABLE bookings
ADD CONSTRAINT bookings_student_id_fkey
FOREIGN KEY (student_id)
REFERENCES profiles(id)
ON DELETE CASCADE;

-- 2. Add Foreign Key for Teacher
ALTER TABLE bookings
DROP CONSTRAINT IF EXISTS bookings_teacher_id_fkey;

ALTER TABLE bookings
ADD CONSTRAINT bookings_teacher_id_fkey
FOREIGN KEY (teacher_id)
REFERENCES profiles(id)
ON DELETE CASCADE;

-- 3. Verify
SELECT 
    tc.table_schema, 
    tc.constraint_name, 
    tc.table_name, 
    kcu.column_name, 
    ccu.table_name AS foreign_table_name
FROM 
    information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu 
      ON tc.constraint_name = kcu.constraint_name 
      AND tc.table_schema = kcu.table_schema 
    JOIN information_schema.constraint_column_usage AS ccu 
      ON ccu.constraint_name = tc.constraint_name 
      AND ccu.table_schema = tc.table_schema 
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name='bookings';
