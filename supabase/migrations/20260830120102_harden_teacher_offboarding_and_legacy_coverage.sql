-- Fecha o bypass de cobertura anterior ao fluxo com aceite e revalidação.
-- O bloco cobre qualquer overload que ainda exista em ambientes antigos sem
-- tornar o replay da cadeia de migrations dependente daquele RPC legado.
DO $revoke_legacy_coverage$
DECLARE
  function_signature regprocedure;
BEGIN
  FOR function_signature IN
    SELECT procedure.oid::regprocedure
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'assign_class_coverage'
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      function_signature
    );
  END LOOP;
END
$revoke_legacy_coverage$;

-- A conclusão é a fronteira transacional do desligamento. Além da
-- membership, ela fecha o estado canônico, suprime mensagens ainda enfileiradas
-- e remove as sessões de refresh do GoTrue. Um access token já emitido continua
-- válido até expirar; por isso toda autorização permanece baseada na membership
-- ativa/lifecycle, e o cliente também recusa contexto ativo ausente.
CREATE OR REPLACE FUNCTION public.complete_teacher_offboarding(p_teacher_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  caller_tenant text;
  caller_role text;
  remaining_count integer;
  active_membership_count integer;
  cancelled_notification_count integer := 0;
  invalidated_session_count integer := 0;
BEGIN
  caller_tenant := private.active_tenant_id(caller_id);
  caller_role := private.active_tenant_role(caller_id);

  IF caller_id IS NULL
    OR caller_tenant IS NULL
    OR caller_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  -- Serializa duas tentativas administrativas para o mesmo professor e mantém
  -- a verificação abaixo coerente com a transição de lifecycle.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('teacher-offboarding:' || p_teacher_id::text, 0)
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_memberships AS membership
    WHERE membership.user_id = p_teacher_id
      AND membership.tenant_id = caller_tenant
      AND membership.role = 'TEACHER'
      AND membership.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'teacher_scope_denied' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)
  INTO remaining_count
  FROM public.bookings AS booking
  WHERE booking.teacher_id = p_teacher_id
    AND booking.tenant_id = caller_tenant
    AND booking.status IS DISTINCT FROM 'CANCELLED';

  IF remaining_count > 0 THEN
    RETURN jsonb_build_object(
      'status', 'PENDING_REASSIGN',
      'remaining', remaining_count,
      'message', 'Ainda ha aulas ativas para reatribuir.'
    );
  END IF;

  UPDATE public.tenant_memberships
  SET status = 'REVOKED',
      is_primary = false,
      updated_at = now()
  WHERE user_id = p_teacher_id
    AND tenant_id = caller_tenant
    AND role = 'TEACHER'
    AND status = 'ACTIVE';

  -- Uma mensagem já aceita pelo provedor não pode ser recolhida. As que ainda
  -- pertencem à fila local, inclusive leases em processamento, deixam de ser
  -- elegíveis para retry e ficam observáveis como suprimidas pelo desligamento.
  UPDATE public.notification_queue
  SET status = 'skipped',
      last_error = 'teacher_offboarded',
      updated_at = now()
  WHERE tenant_id = caller_tenant
    AND teacher_id = p_teacher_id
    AND status IN ('pending', 'processing');
  GET DIAGNOSTICS cancelled_notification_count = ROW_COUNT;

  SELECT count(*)
  INTO active_membership_count
  FROM public.tenant_memberships AS membership
  WHERE membership.user_id = p_teacher_id
    AND membership.status = 'ACTIVE';

  IF active_membership_count = 0 THEN
    DELETE FROM public.tenant_user_contexts
    WHERE user_id = p_teacher_id;

    UPDATE public.profiles
    SET status = 'Inativo',
        lifecycle_status = 'offboarded',
        offboarding_status = 'COMPLETED',
        offboarding_completed_at = now(),
        date_automation_enabled = false
    WHERE id = p_teacher_id;
  ELSE
    -- lifecycle_status é global ao usuário. Se ele ainda trabalha em outra
    -- escola, preservamos o estado ativo e apenas trocamos o contexto revogado.
    UPDATE public.tenant_user_contexts AS context
    SET tenant_id = replacement.tenant_id,
        updated_at = now()
    FROM (
      SELECT membership.tenant_id
      FROM public.tenant_memberships AS membership
      WHERE membership.user_id = p_teacher_id
        AND membership.status = 'ACTIVE'
      ORDER BY membership.is_primary DESC, membership.created_at, membership.id
      LIMIT 1
    ) AS replacement
    WHERE context.user_id = p_teacher_id
      AND context.tenant_id = caller_tenant;
  END IF;

  -- Equivale ao sign-out global no lado persistido do GoTrue: refresh tokens
  -- ligados às sessões são removidos por cascata. O SQL dinâmico mantém a
  -- migration reaplicável em ambientes de validação sem o schema Auth.
  IF active_membership_count = 0
     AND pg_catalog.to_regclass('auth.sessions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM auth.sessions WHERE user_id = $1'
      USING p_teacher_id;
    GET DIAGNOSTICS invalidated_session_count = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'status', 'COMPLETED',
    'remainingActiveMemberships', active_membership_count,
    'notificationsCancelled', cancelled_notification_count,
    'sessionsInvalidated', invalidated_session_count,
    'accountAccessRevoked', active_membership_count = 0
  );
END;
$function$;

ALTER FUNCTION public.complete_teacher_offboarding(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_teacher_offboarding(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_teacher_offboarding(uuid)
  TO authenticated;
