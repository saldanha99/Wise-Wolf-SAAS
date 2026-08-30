-- A configuracao da landing page e publica para leitura, mas somente a direcao
-- ativa do proprio tenant pode cria-la ou altera-la. Uma linha por tenant evita
-- que clientes que esperam zero-ou-uma configuracao recebam respostas ambiguas.

DO $preflight$
BEGIN
  IF to_regclass('public.landing_page_configs') IS NULL THEN
    RAISE EXCEPTION 'landing_page_configs_table_missing';
  END IF;

  IF to_regprocedure('public._my_tenant_id()') IS NULL
    OR to_regprocedure('public._my_role()') IS NULL
    OR to_regprocedure('public._my_tenant_is_operational()') IS NULL
  THEN
    RAISE EXCEPTION 'landing_page_configs_requires_tenant_helpers';
  END IF;
END
$preflight$;

-- Nao escolhemos silenciosamente qual conteudo preservar. Se algum ambiente
-- legado tiver duplicatas, a migracao para antes de apagar ou mesclar dados.
DO $deduplication_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.landing_page_configs AS config
    GROUP BY config.tenant_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'landing_page_configs_duplicate_tenant_rows'
      USING ERRCODE = '23505';
  END IF;
END
$deduplication_guard$;

ALTER TABLE public.landing_page_configs
  ADD COLUMN IF NOT EXISTS cta_text text;

UPDATE public.landing_page_configs
SET cta_text = 'Começar Agora'
WHERE cta_text IS NULL;

ALTER TABLE public.landing_page_configs
  ALTER COLUMN cta_text SET DEFAULT 'Começar Agora',
  ALTER COLUMN cta_text SET NOT NULL;

DO $unique_constraint$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_definition
    WHERE constraint_definition.conrelid =
      'public.landing_page_configs'::regclass
      AND constraint_definition.conname =
        'landing_page_configs_tenant_id_key'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_definition
    WHERE constraint_definition.conrelid =
      'public.landing_page_configs'::regclass
      AND constraint_definition.conname =
        'landing_page_configs_tenant_id_key'
      AND constraint_definition.contype = 'u'
      AND pg_catalog.pg_get_constraintdef(constraint_definition.oid) =
        'UNIQUE (tenant_id)'
  ) THEN
    RAISE EXCEPTION 'landing_page_configs_tenant_constraint_invalid';
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_definition
    WHERE constraint_definition.conrelid =
      'public.landing_page_configs'::regclass
      AND constraint_definition.conname =
        'landing_page_configs_tenant_id_key'
  ) THEN
    ALTER TABLE public.landing_page_configs
      ADD CONSTRAINT landing_page_configs_tenant_id_key
      UNIQUE (tenant_id);
  END IF;
END
$unique_constraint$;

ALTER TABLE public.landing_page_configs ENABLE ROW LEVEL SECURITY;

DO $drop_stale_policies$
DECLARE
  stale_policy record;
BEGIN
  FOR stale_policy IN
    SELECT policy.policyname
    FROM pg_catalog.pg_policies AS policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'landing_page_configs'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.landing_page_configs',
      stale_policy.policyname
    );
  END LOOP;
END
$drop_stale_policies$;

REVOKE ALL ON TABLE public.landing_page_configs
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.landing_page_configs
  TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.landing_page_configs
  TO authenticated;
GRANT ALL ON TABLE public.landing_page_configs TO service_role;

-- O conteudo desta tabela e material de marketing deliberadamente publico.
-- Escritas continuam isoladas e condicionadas ao estado operacional abaixo.
CREATE POLICY landing_page_configs_public_select
ON public.landing_page_configs
FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY landing_page_configs_admin_insert
ON public.landing_page_configs
FOR INSERT
TO authenticated
WITH CHECK (
  landing_page_configs.tenant_id = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

CREATE POLICY landing_page_configs_admin_update
ON public.landing_page_configs
FOR UPDATE
TO authenticated
USING (
  landing_page_configs.tenant_id = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
)
WITH CHECK (
  landing_page_configs.tenant_id = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

CREATE POLICY landing_page_configs_admin_delete
ON public.landing_page_configs
FOR DELETE
TO authenticated
USING (
  landing_page_configs.tenant_id = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);
