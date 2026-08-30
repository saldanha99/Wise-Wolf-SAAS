-- Garante que os RPCs críticos de Turbo continuem acessíveis para usuários
-- autenticados e service_role, mesmo que versões futuras de migration reajam
-- grants no meio do caminho.

DO $$
BEGIN
  IF to_regprocedure('public.teacher_turbo_status(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.teacher_turbo_status(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.teacher_turbo_status(uuid)
      TO authenticated, service_role, PUBLIC;
  END IF;

  IF to_regprocedure('public.teacher_turbo_status_at(uuid,date)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.teacher_turbo_status_at(uuid, date) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.teacher_turbo_status_at(uuid, date)
      TO authenticated, service_role, PUBLIC;
  END IF;

  IF to_regprocedure('public.teacher_turbo_student_count(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.teacher_turbo_student_count(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.teacher_turbo_student_count(uuid)
      TO authenticated, service_role, PUBLIC;
  END IF;

  IF to_regprocedure('public.teacher_turbo_business_date()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.teacher_turbo_business_date() FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.teacher_turbo_business_date()
      TO authenticated, service_role, PUBLIC;
  END IF;

  NOTIFY pgrst, 'reload schema';
END;
$$;
