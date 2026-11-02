-- Escrita no Storage voltava "permission denied for function active_tenant_role"
-- para QUALQUER bucket: as barreiras de `invoices` chamavam
-- private.active_tenant_role() direto, e `authenticated` não tem EXECUTE nela
-- (de propósito — ela aceita um uuid arbitrário e diria o papel de qualquer um).
--
-- O `bucket_id <> 'invoices'` não salvava: o Postgres cobra o EXECUTE na
-- INICIALIZAÇÃO da expressão, antes de qualquer curto-circuito do OR. Como as
-- barreiras de UPDATE/DELETE são RESTRICTIVE (valem para todo bucket), todo
-- upsert, update e delete de arquivo morria — upload de treinamento
-- (`upsert: true`), remoção de material da biblioteca, tudo.
--
-- Conserto: usar public._my_role(), que é exatamente
-- private.active_tenant_role((select auth.uid())) embrulhado num SECURITY
-- DEFINER com EXECUTE para authenticated. Mesma regra, mesma resposta — a
-- função interna continua fechada.

DROP POLICY IF EXISTS invoices_closing_scoped_update ON storage.objects;
CREATE POLICY invoices_closing_scoped_update
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'invoices'
  AND private.can_access_invoice_object(name, true)
  AND (
    owner_id = (SELECT auth.uid())::text
    OR (SELECT public._my_role()) IN (
      'SCHOOL_ADMIN',
      'COORDINATOR',
      'SUPER_ADMIN'
    )
  )
)
WITH CHECK (
  bucket_id = 'invoices'
  AND private.can_access_invoice_object(name, true)
  AND (
    owner_id = (SELECT auth.uid())::text
    OR (SELECT public._my_role()) IN (
      'SCHOOL_ADMIN',
      'COORDINATOR',
      'SUPER_ADMIN'
    )
  )
);

DROP POLICY IF EXISTS invoices_closing_scoped_delete ON storage.objects;
CREATE POLICY invoices_closing_scoped_delete
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'invoices'
  AND private.can_access_invoice_object(name, true)
  AND (
    owner_id = (SELECT auth.uid())::text
    OR (SELECT public._my_role()) IN (
      'SCHOOL_ADMIN',
      'COORDINATOR',
      'SUPER_ADMIN'
    )
  )
);

DROP POLICY IF EXISTS invoices_authenticated_update_guard ON storage.objects;
CREATE POLICY invoices_authenticated_update_guard
ON storage.objects
AS RESTRICTIVE
FOR UPDATE
TO authenticated
USING (
  bucket_id <> 'invoices'
  OR (
    private.can_access_invoice_object(name, true)
    AND (
      owner_id = (SELECT auth.uid())::text
      OR (SELECT public._my_role()) IN (
        'SCHOOL_ADMIN',
        'COORDINATOR',
        'SUPER_ADMIN'
      )
    )
  )
)
WITH CHECK (
  bucket_id <> 'invoices'
  OR (
    private.can_access_invoice_object(name, true)
    AND (
      owner_id = (SELECT auth.uid())::text
      OR (SELECT public._my_role()) IN (
        'SCHOOL_ADMIN',
        'COORDINATOR',
        'SUPER_ADMIN'
      )
    )
  )
);

DROP POLICY IF EXISTS invoices_authenticated_delete_guard ON storage.objects;
CREATE POLICY invoices_authenticated_delete_guard
ON storage.objects
AS RESTRICTIVE
FOR DELETE
TO authenticated
USING (
  bucket_id <> 'invoices'
  OR (
    private.can_access_invoice_object(name, true)
    AND (
      owner_id = (SELECT auth.uid())::text
      OR (SELECT public._my_role()) IN (
        'SCHOOL_ADMIN',
        'COORDINATOR',
        'SUPER_ADMIN'
      )
    )
  )
);

-- Trava contra reincidência: policy de storage para anon/authenticated que
-- chame função `private` sem EXECUTE derruba a migration aqui, e não na tela
-- do diretor às 23h.
DO $guard$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT policy.polname || ' -> private.' || fn.proname, ', ')
  INTO offenders
  FROM pg_policy AS policy
  JOIN pg_class AS tbl ON tbl.oid = policy.polrelid
  JOIN pg_namespace AS ns ON ns.oid = tbl.relnamespace
  JOIN pg_proc AS fn ON TRUE
  JOIN pg_namespace AS fn_ns ON fn_ns.oid = fn.pronamespace
  WHERE ns.nspname = 'storage'
    AND tbl.relname = 'objects'
    AND fn_ns.nspname = 'private'
    AND NOT has_function_privilege('authenticated', fn.oid, 'EXECUTE')
    AND (
      coalesce(pg_get_expr(policy.polqual, policy.polrelid), '')
      || ' '
      || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
    ) ILIKE '%private.' || fn.proname || '(%'
    AND (
      policy.polroles = '{}'::oid[]
      OR EXISTS (
        SELECT 1 FROM pg_roles AS r
        WHERE r.oid = ANY (policy.polroles)
          AND r.rolname IN ('authenticated', 'anon')
      )
    );

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'storage_policy_calls_unexecutable_private_function: %', offenders;
  END IF;
END
$guard$;
