-- Permite que chamadas autenticadas executem as funções de cálculo internas utilizadas
-- pelo RPC `teacher_turbo_status` sem depender de permissões de `service_role`.
GRANT EXECUTE ON FUNCTION public.teacher_turbo_status_at(uuid, date) TO authenticated, service_role;
