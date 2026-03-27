-- Adicionar controle de permissão para Instrutores (Teacher Trainers)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_trainer BOOLEAN DEFAULT false;

-- Adicionar registro de Auditoria e Autoria aos módulos
ALTER TABLE public.training_modules ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id) DEFAULT NULL;
