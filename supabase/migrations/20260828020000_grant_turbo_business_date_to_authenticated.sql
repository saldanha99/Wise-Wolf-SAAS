-- Permite que o endpoint de status do Turbo calcule data de negócio no contexto
-- autenticado sem depender de privilégio implícito do caller de testes.

GRANT EXECUTE ON FUNCTION public.teacher_turbo_business_date() TO authenticated, service_role;
