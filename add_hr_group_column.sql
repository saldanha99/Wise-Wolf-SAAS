-- Adiciona coluna hr_group_id para configuração de grupo de WhatsApp de RH
-- Separado do teachers_group_id que é usado para professores

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hr_group_id TEXT;

COMMENT ON COLUMN profiles.hr_group_id IS 'WhatsApp group JID for HR notifications (job applications, leads). Falls back to teachers_group_id if null.';
