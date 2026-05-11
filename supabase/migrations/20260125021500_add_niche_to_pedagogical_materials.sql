-- Adicionar coluna de nicho para pedagogical_materials (para garantir consistência com o frontend)
ALTER TABLE public.pedagogical_materials 
ADD COLUMN IF NOT EXISTS niche text DEFAULT 'GENERAL';

-- Adicionar constraint de validação
ALTER TABLE public.pedagogical_materials DROP CONSTRAINT IF EXISTS check_pedagogical_niche;

ALTER TABLE public.pedagogical_materials
ADD CONSTRAINT check_pedagogical_niche CHECK (niche IN ('GENERAL', 'MEDICINE', 'TECH', 'TRAVEL', 'BUSINESS'));
