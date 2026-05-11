-- Migration to add missing student administrative fields
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS start_date DATE,
ADD COLUMN IF NOT EXISTS class_frequency INTEGER;

-- Comment for documentation
COMMENT ON COLUMN public.profiles.start_date IS 'Data oficial de início das aulas para fins de contrato';
COMMENT ON COLUMN public.profiles.class_frequency IS 'Frequência semanal de aulas (ex: 2, 3)';
