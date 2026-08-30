-- Garante que o turbo_status possa ser consultado pelo cliente autenticado
-- com validação explícita de papel e escopo do tenant, evitando 403s no
-- painel de professores e mantendo isolamento de escola.

CREATE OR REPLACE FUNCTION public.teacher_turbo_status(p_teacher uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_jwt_role text;
  v_tenant text;
  v_teacher_tenant text;
BEGIN
  v_jwt_role := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    ''
  );

  IF v_jwt_role = 'service_role' THEN
    v_role := 'SUPER_ADMIN';
  ELSE
    v_role := public._my_role();
    v_tenant := public._my_tenant_id();
  END IF;

  IF NOT COALESCE(v_role IN ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'), false) THEN
    RETURN jsonb_build_object('active', false, 'status', 'UNKNOWN', 'blocked_by', 'sem_permissao');
  END IF;

  SELECT p.tenant_id INTO v_teacher_tenant
  FROM public.profiles p
  WHERE p.id = p_teacher;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('active', false, 'status', 'UNKNOWN', 'blocked_by', 'professor_invalido');
  END IF;

  IF v_role <> 'SUPER_ADMIN' AND v_teacher_tenant IS DISTINCT FROM v_tenant THEN
    RETURN jsonb_build_object('active', false, 'status', 'UNKNOWN', 'blocked_by', 'sem_permissao');
  END IF;

  RETURN public.teacher_turbo_status_at(p_teacher, public.teacher_turbo_business_date());
END;
$function$;

GRANT EXECUTE ON FUNCTION public.teacher_turbo_status(uuid) TO authenticated, service_role;
