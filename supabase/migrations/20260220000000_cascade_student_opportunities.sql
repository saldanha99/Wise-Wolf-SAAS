-- Drop existing constraint
ALTER TABLE public.opportunities DROP CONSTRAINT IF EXISTS opportunities_student_id_fkey;

-- Re-add with CASCADE
ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_student_id_fkey 
  FOREIGN KEY (student_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
