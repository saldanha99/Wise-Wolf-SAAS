-- upcoming_classes e uma view SECURITY DEFINER (roda com privilegio do dono, ignora
-- RLS das tabelas-base). anon/authenticated tinham SELECT nela -> qualquer cliente
-- (ate deslogado) podia "SELECT * FROM upcoming_classes" e ler nome + telefone de
-- alunos de TODOS os tenants. So os crons (service_role) e a funcao
-- enqueue_attendance_confirmations (SECURITY DEFINER, dona=postgres) precisam ler.
-- Nenhum componente do frontend le essa view direto (so a edge prepare-daily-reminders).
REVOKE ALL ON public.upcoming_classes FROM anon, authenticated;
