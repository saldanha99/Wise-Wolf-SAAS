-- Superseded by:
-- supabase/migrations/20260718034023_harden_public_intake_rls.sql
--
-- The active implementation dispatches only the inserted lead UUID to the
-- internal Edge Functions gateway and reads the service credential from Vault.
-- No project or provider credential belongs in this source file.

select 'Apply the versioned harden_public_intake_rls migration instead.' as notice;
