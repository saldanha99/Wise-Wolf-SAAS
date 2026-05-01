-- DIAGNOSTIC SCRIPT
-- Run this to check why features might be failing in Production

-- 1. Check if 'teacher_availability' table exists (Required for Agenda Sync)
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name = 'teacher_availability';

-- 2. Check RLS Policies on 'teacher_availability'
-- If this returns empty, RLS is active but no policies exist (meaning NO ONE can access it)
SELECT policyname, cmd, roles, qual, with_check 
FROM pg_policies 
WHERE tablename = 'teacher_availability';

-- 3. Check Constraints on 'teacher_closings'
-- We verify if there is a UNIQUE constraint on (teacher_id, month_year)
-- This is required for the "Fechamento Mensal" fix (onConflict) to work
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'teacher_closings'::regclass;
