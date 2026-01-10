
-- Remove a restrição de "CHECK" que está bloqueando o salvamento com acentos/minúsculas
ALTER TABLE public.class_logs DROP CONSTRAINT IF EXISTS class_logs_presence_check;

-- Opcional: Re-adicionar a restrição de forma mais flexível se desejar, 
-- mas geralmente é melhor deixar o TEXT livre e validar no front ou apenas aceitar o que vem.
-- ALTER TABLE public.class_logs ADD CONSTRAINT class_logs_presence_check 
-- CHECK (presence IN ('Presença', 'Falta', 'Falta Justificada', 'PRESENÇA', 'FALTA', 'FALTA_JUSTIFICADA'));

-- Aviso para o Supabase atualizar o cache
NOTIFY pgrst, 'reload schema';
