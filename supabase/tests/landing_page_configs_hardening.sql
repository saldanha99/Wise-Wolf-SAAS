-- Landing pages aceitam zero-ou-uma configuracao por tenant. O conteudo e
-- publico para leitura; somente a direcao ativa escreve no proprio tenant.

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT coalesce(value, false) THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO PUBLIC;

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'landing_page_configs'
      AND column_name = 'cta_text'
      AND is_nullable = 'NO'
  ),
  'cta_text nao foi criada como obrigatoria'
);

SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_definition
    WHERE constraint_definition.conrelid =
      'public.landing_page_configs'::regclass
      AND constraint_definition.conname =
        'landing_page_configs_tenant_id_key'
      AND constraint_definition.contype = 'u'
      AND pg_catalog.pg_get_constraintdef(constraint_definition.oid) =
        'UNIQUE (tenant_id)'
  ),
  'tenant_id nao possui restricao unica'
);

SELECT pg_temp.assert_true(
  (
    SELECT array_agg(policy.policyname::text ORDER BY policy.policyname)
    FROM pg_catalog.pg_policies AS policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'landing_page_configs'
  ) = ARRAY[
    'landing_page_configs_admin_delete',
    'landing_page_configs_admin_insert',
    'landing_page_configs_admin_update',
    'landing_page_configs_public_select'
  ]::text[],
  'landing_page_configs manteve politicas sobrepostas ou perdeu uma politica'
);

SELECT pg_temp.assert_true(
  pg_catalog.has_table_privilege(
    'anon', 'public.landing_page_configs', 'SELECT'
  )
  AND NOT pg_catalog.has_table_privilege(
    'anon', 'public.landing_page_configs', 'INSERT'
  )
  AND NOT pg_catalog.has_table_privilege(
    'anon', 'public.landing_page_configs', 'UPDATE'
  )
  AND NOT pg_catalog.has_table_privilege(
    'anon', 'public.landing_page_configs', 'DELETE'
  )
  AND pg_catalog.has_table_privilege(
    'authenticated', 'public.landing_page_configs', 'SELECT'
  )
  AND pg_catalog.has_table_privilege(
    'authenticated', 'public.landing_page_configs', 'INSERT'
  )
  AND pg_catalog.has_table_privilege(
    'authenticated', 'public.landing_page_configs', 'UPDATE'
  )
  AND pg_catalog.has_table_privilege(
    'authenticated', 'public.landing_page_configs', 'DELETE'
  )
  AND NOT pg_catalog.has_table_privilege(
    'authenticated', 'public.landing_page_configs', 'TRUNCATE'
  )
  AND NOT pg_catalog.has_table_privilege(
    'authenticated', 'public.landing_page_configs', 'REFERENCES'
  )
  AND NOT pg_catalog.has_table_privilege(
    'authenticated', 'public.landing_page_configs', 'TRIGGER'
  ),
  'privilegios da landing page estao mais amplos ou mais estreitos que o contrato'
);

INSERT INTO public.tenants (id, name, saas_status)
VALUES
  ('landing-config-a', 'Landing Config A', 'active'),
  ('landing-config-b', 'Landing Config B', 'active'),
  ('landing-config-suspended', 'Landing Config Suspended', 'suspended');

INSERT INTO auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  (
    'b7000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'landing-admin-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Direcao Landing A"}', now(), now()
  ),
  (
    'b7000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'landing-admin-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Direcao Landing B"}', now(), now()
  ),
  (
    'b7000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'landing-teacher-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Professor Landing A"}', now(), now()
  ),
  (
    'b7000000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'landing-admin-suspended@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Direcao Landing Suspensa"}', now(), now()
  );

SET LOCAL app.enrollment_claim = '1';
UPDATE public.profiles
SET tenant_id = 'landing-config-a', role = 'SCHOOL_ADMIN',
    full_name = 'Direcao Landing A', lifecycle_status = 'active'
WHERE id = 'b7000000-0000-4000-8000-000000000001';
UPDATE public.profiles
SET tenant_id = 'landing-config-b', role = 'SCHOOL_ADMIN',
    full_name = 'Direcao Landing B', lifecycle_status = 'active'
WHERE id = 'b7000000-0000-4000-8000-000000000002';
UPDATE public.profiles
SET tenant_id = 'landing-config-a', role = 'TEACHER',
    full_name = 'Professor Landing A', lifecycle_status = 'active'
WHERE id = 'b7000000-0000-4000-8000-000000000003';
UPDATE public.profiles
SET tenant_id = 'landing-config-suspended', role = 'SCHOOL_ADMIN',
    full_name = 'Direcao Landing Suspensa', lifecycle_status = 'active'
WHERE id = 'b7000000-0000-4000-8000-000000000004';
SET LOCAL app.enrollment_claim = '';

INSERT INTO public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
VALUES
  (
    'b7000000-0000-4000-8000-000000000001',
    'landing-config-a', 'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    'b7000000-0000-4000-8000-000000000002',
    'landing-config-b', 'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    'b7000000-0000-4000-8000-000000000003',
    'landing-config-a', 'TEACHER', 'ACTIVE', true
  ),
  (
    'b7000000-0000-4000-8000-000000000004',
    'landing-config-suspended', 'SCHOOL_ADMIN', 'ACTIVE', true
  )
ON CONFLICT (user_id, tenant_id) DO UPDATE
SET role = EXCLUDED.role,
    status = EXCLUDED.status,
    is_primary = EXCLUDED.is_primary;

INSERT INTO public.tenant_user_contexts (user_id, tenant_id)
VALUES
  (
    'b7000000-0000-4000-8000-000000000001',
    'landing-config-a'
  ),
  (
    'b7000000-0000-4000-8000-000000000002',
    'landing-config-b'
  ),
  (
    'b7000000-0000-4000-8000-000000000003',
    'landing-config-a'
  ),
  (
    'b7000000-0000-4000-8000-000000000004',
    'landing-config-suspended'
  );

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims =
  '{"sub":"b7000000-0000-4000-8000-000000000001","role":"authenticated"}';

INSERT INTO public.landing_page_configs (tenant_id, headline)
VALUES ('landing-config-a', 'Landing A');

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT config.cta_text = 'Começar Agora'
    FROM public.landing_page_configs AS config
    WHERE config.tenant_id = 'landing-config-a'
  ),
  'cta_text nao aplicou o valor padrao'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims =
  '{"sub":"b7000000-0000-4000-8000-000000000001","role":"authenticated"}';

DO $$
BEGIN
  INSERT INTO public.landing_page_configs (tenant_id, headline)
  VALUES ('landing-config-a', 'Landing A duplicada');
  RAISE EXCEPTION 'assertion failed: duplicata por tenant foi aceita';
EXCEPTION WHEN unique_violation THEN
  NULL;
END;
$$;

DO $$
BEGIN
  INSERT INTO public.landing_page_configs (tenant_id, headline)
  VALUES ('landing-config-b', 'Landing B cruzada');
  RAISE EXCEPTION 'assertion failed: admin inseriu landing em outro tenant';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;

UPDATE public.landing_page_configs
SET cta_text = 'Matricule-se'
WHERE tenant_id = 'landing-config-a';

DO $$
BEGIN
  UPDATE public.landing_page_configs
  SET tenant_id = 'landing-config-forged'
  WHERE tenant_id = 'landing-config-a';
  RAISE EXCEPTION 'assertion failed: admin moveu landing para outro tenant';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;

RESET ROLE;

SELECT pg_temp.assert_true(
  (
    SELECT config.tenant_id = 'landing-config-a'
      AND config.cta_text = 'Matricule-se'
    FROM public.landing_page_configs AS config
    WHERE config.tenant_id = 'landing-config-a'
  ),
  'update legitimo falhou ou update cruzado alterou a linha'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims =
  '{"sub":"b7000000-0000-4000-8000-000000000002","role":"authenticated"}';

INSERT INTO public.landing_page_configs (tenant_id, headline)
VALUES ('landing-config-b', 'Landing B');

DO $$
DECLARE
  affected_rows integer;
BEGIN
  UPDATE public.landing_page_configs
  SET headline = 'Landing A adulterada'
  WHERE tenant_id = 'landing-config-a';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'assertion failed: admin alterou landing de outro tenant';
  END IF;
END;
$$;

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims =
  '{"sub":"b7000000-0000-4000-8000-000000000003","role":"authenticated"}';

DO $$
DECLARE
  affected_rows integer;
BEGIN
  UPDATE public.landing_page_configs
  SET headline = 'Landing adulterada pelo professor'
  WHERE tenant_id = 'landing-config-a';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'assertion failed: professor alterou landing page';
  END IF;
END;
$$;

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims =
  '{"sub":"b7000000-0000-4000-8000-000000000004","role":"authenticated"}';

DO $$
BEGIN
  INSERT INTO public.landing_page_configs (tenant_id, headline)
  VALUES ('landing-config-suspended', 'Landing suspensa');
  RAISE EXCEPTION 'assertion failed: tenant inoperante criou landing page';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;

RESET ROLE;

SET LOCAL ROLE anon;

SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 2
    FROM public.landing_page_configs AS config
    WHERE config.tenant_id IN ('landing-config-a', 'landing-config-b')
  ),
  'leitura publica nao retornou as landings publicadas'
);

DO $$
BEGIN
  INSERT INTO public.landing_page_configs (tenant_id, headline)
  VALUES ('landing-config-suspended', 'Landing anonima');
  RAISE EXCEPTION 'assertion failed: anonimo escreveu landing page';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$$;

RESET ROLE;

ROLLBACK;
