-- A assinatura do representante legal e dado juridico privado. O bucket legado
-- inteiro deixa de ser publico para invalidar imediatamente URLs antigas. A
-- pasta signature/ e preservada somente como backup administrativo e nunca e
-- assinada/servida; o diretor precisa reuploadar o arquivo no bucket privado.
-- Logo e favicon novos usam um bucket publico separado; os objetos visuais
-- legados continuam acessiveis somente pelo proxy com allowlist de kind/path.

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES
  (
    'tenant-public-branding',
    'tenant-public-branding',
    true,
    2097152,
    ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/x-icon']::text[]
  ),
  (
    'tenant-legal-assets',
    'tenant-legal-assets',
    false,
    1048576,
    ARRAY['image/png', 'image/jpeg', 'image/webp']::text[]
  )
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types,
    updated_at = now();

UPDATE storage.buckets
SET public = false,
    updated_at = now()
WHERE id = 'tenant-branding';

-- O bucket legado fica somente leitura/exclusao para administradores do tenant.
-- Nenhum upload novo deve voltar a misturar marca e documento juridico.
DROP POLICY IF EXISTS tenant_branding_public_read ON storage.objects;
DROP POLICY IF EXISTS tenant_branding_admin_read ON storage.objects;
CREATE POLICY tenant_branding_admin_read
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'tenant-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_branding_admin_insert ON storage.objects;
DROP POLICY IF EXISTS tenant_branding_admin_update ON storage.objects;
DROP POLICY IF EXISTS tenant_branding_admin_delete ON storage.objects;
CREATE POLICY tenant_branding_admin_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'tenant-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_public_branding_admin_read ON storage.objects;
CREATE POLICY tenant_public_branding_admin_read
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'tenant-public-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] IN ('logo', 'favicon')
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_public_branding_admin_insert ON storage.objects;
CREATE POLICY tenant_public_branding_admin_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'tenant-public-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] IN ('logo', 'favicon')
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_public_branding_admin_update ON storage.objects;
CREATE POLICY tenant_public_branding_admin_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'tenant-public-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] IN ('logo', 'favicon')
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
)
WITH CHECK (
  bucket_id = 'tenant-public-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] IN ('logo', 'favicon')
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_public_branding_admin_delete ON storage.objects;
CREATE POLICY tenant_public_branding_admin_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'tenant-public-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] IN ('logo', 'favicon')
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_legal_assets_admin_read ON storage.objects;
CREATE POLICY tenant_legal_assets_admin_read
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'tenant-legal-assets'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] = 'legal-representative-signature'
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_legal_assets_admin_insert ON storage.objects;
CREATE POLICY tenant_legal_assets_admin_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'tenant-legal-assets'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] = 'legal-representative-signature'
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_legal_assets_admin_update ON storage.objects;
CREATE POLICY tenant_legal_assets_admin_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'tenant-legal-assets'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] = 'legal-representative-signature'
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
)
WITH CHECK (
  bucket_id = 'tenant-legal-assets'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] = 'legal-representative-signature'
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_legal_assets_admin_delete ON storage.objects;
CREATE POLICY tenant_legal_assets_admin_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'tenant-legal-assets'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (storage.foldername(name))[2] = 'legal-representative-signature'
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

CREATE OR REPLACE FUNCTION private.legal_snapshot_is_private(
  p_snapshot jsonb,
  p_tenant_id text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  signature_path text;
  private_prefix text := p_tenant_id || '/legal-representative-signature/';
BEGIN
  IF p_snapshot IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR p_snapshot ?| ARRAY[
      'legalRepresentativeSignatureUrl',
      'directorSignatureUrl',
      'signatureUrl'
    ]
  THEN
    RETURN false;
  END IF;
  signature_path := nullif(trim(p_snapshot ->> 'legalRepresentativeSignaturePath'), '');
  IF signature_path IS NULL THEN
    RETURN true;
  END IF;
  RETURN
    left(signature_path, length(private_prefix)) = private_prefix
    AND substring(signature_path FROM length(private_prefix) + 1)
      ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89ab][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\.(png|jpg|jpeg|webp)$';
END;
$function$;
REVOKE ALL ON FUNCTION private.legal_snapshot_is_private(jsonb,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.legal_snapshot_is_private(jsonb,text)
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION private.normalize_private_legal_snapshot(
  p_snapshot jsonb,
  p_tenant_id text
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  normalized jsonb;
  signature_path text;
BEGIN
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' THEN
    RETURN p_snapshot;
  END IF;
  normalized := p_snapshot
    - 'legalRepresentativeSignatureUrl'
    - 'directorSignatureUrl'
    - 'signatureUrl'
    - 'legalRepresentativeSignaturePath';
  signature_path := nullif(trim(p_snapshot ->> 'legalRepresentativeSignaturePath'), '');
  IF NOT private.legal_snapshot_is_private(
    jsonb_build_object('legalRepresentativeSignaturePath', signature_path),
    p_tenant_id
  ) THEN
    signature_path := NULL;
  END IF;
  IF private.legal_snapshot_is_private(
    jsonb_build_object('legalRepresentativeSignaturePath', signature_path),
    p_tenant_id
  ) AND signature_path IS NOT NULL THEN
    normalized := normalized || jsonb_build_object(
      'legalRepresentativeSignaturePath',
      signature_path
    );
  END IF;
  RETURN normalized;
END;
$function$;
REVOKE ALL ON FUNCTION private.normalize_private_legal_snapshot(jsonb,text)
  FROM PUBLIC, anon, authenticated;

-- Convites e ofertas abertos com assinatura publica nao podem continuar. O
-- administrador deve primeiro reuploadar a assinatura privada e emitir um novo
-- link; o registro revogado permanece para auditoria.
UPDATE public.offers AS offer
SET revoked_at = coalesce(offer.revoked_at, now())
WHERE offer.consumed_at IS NULL
  AND offer.revoked_at IS NULL
  AND (
    coalesce(offer.payload -> 'schoolInfo', '{}'::jsonb) ?| ARRAY[
      'legalRepresentativeSignatureUrl',
      'directorSignatureUrl',
      'signatureUrl'
    ]
    OR coalesce(offer.payload -> '_schoolInfo', '{}'::jsonb) ?| ARRAY[
      'legalRepresentativeSignatureUrl',
      'directorSignatureUrl',
      'signatureUrl'
    ]
    OR coalesce(
      offer.payload #>> '{schoolInfo,legalRepresentativeSignaturePath}',
      ''
    ) LIKE offer.tenant_id || '/signature/%'
    OR coalesce(
      offer.payload #>> '{_schoolInfo,legalRepresentativeSignaturePath}',
      ''
    ) LIKE offer.tenant_id || '/signature/%'
  );

UPDATE public.tenants AS tenant
SET school_info = private.normalize_private_legal_snapshot(
  tenant.school_info,
  tenant.id
)
WHERE tenant.school_info IS NOT NULL;

UPDATE public.offers AS offer
SET payload = jsonb_set(
  offer.payload,
  '{schoolInfo}',
  private.normalize_private_legal_snapshot(
    offer.payload -> 'schoolInfo',
    offer.tenant_id
  ),
  true
)
WHERE jsonb_typeof(offer.payload -> 'schoolInfo') = 'object';

UPDATE public.offers AS offer
SET payload = jsonb_set(
  offer.payload,
  '{_schoolInfo}',
  private.normalize_private_legal_snapshot(
    offer.payload -> '_schoolInfo',
    offer.tenant_id
  ),
  true
)
WHERE jsonb_typeof(offer.payload -> '_schoolInfo') = 'object';

UPDATE public.tenant_contract_records AS contract
SET legal_snapshot = private.normalize_private_legal_snapshot(
  contract.legal_snapshot,
  contract.tenant_id
);

-- Mantem logos/favicon legados publicos sem reabrir o bucket. O proxy le
-- somente o path visual persistido e nunca aceita a pasta signature.
CREATE OR REPLACE FUNCTION private.legacy_branding_path(
  p_value text,
  p_tenant_id text,
  p_kind text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  marker text := '/storage/v1/object/public/tenant-branding/';
  candidate text := nullif(trim(p_value), '');
  expected_prefix text := p_tenant_id || '/' || p_kind || '/';
  file_name text;
BEGIN
  IF p_kind NOT IN ('logo', 'favicon') OR candidate IS NULL THEN
    RETURN NULL;
  END IF;
  IF position(marker IN candidate) > 0 THEN
    candidate := split_part(
      substring(candidate FROM position(marker IN candidate) + length(marker)),
      '?',
      1
    );
  END IF;
  IF left(candidate, length(expected_prefix)) <> expected_prefix THEN
    RETURN NULL;
  END IF;
  file_name := substring(candidate FROM length(expected_prefix) + 1);
  IF p_kind = 'logo'
    AND file_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$'
  THEN
    RETURN NULL;
  END IF;
  IF p_kind = 'favicon'
    AND file_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|ico)$'
  THEN
    RETURN NULL;
  END IF;
  RETURN candidate;
END;
$function$;
REVOKE ALL ON FUNCTION private.legacy_branding_path(text,text,text)
  FROM PUBLIC, anon, authenticated;

WITH runtime AS (
  SELECT regexp_replace(
    rtrim(
      coalesce(
        nullif(current_setting('app.settings.api_external_url', true), ''),
        'https://api.wisewolflanguage.com.br'
      ),
      '/'
    ),
    '/auth/v1$',
    ''
  ) AS origin
), branding_paths AS (
  SELECT
    tenant.id,
    tenant.branding,
    runtime.origin,
    coalesce(
      private.legacy_branding_path(
        tenant.branding ->> 'logoPath', tenant.id, 'logo'
      ),
      private.legacy_branding_path(
        tenant.branding ->> 'logoUrl', tenant.id, 'logo'
      )
    ) AS logo_path,
    coalesce(
      private.legacy_branding_path(
        tenant.branding ->> 'faviconPath', tenant.id, 'favicon'
      ),
      private.legacy_branding_path(
        tenant.branding ->> 'faviconUrl', tenant.id, 'favicon'
      )
    ) AS favicon_path
  FROM public.tenants AS tenant
  CROSS JOIN runtime
  WHERE tenant.branding IS NOT NULL
)
UPDATE public.tenants AS tenant
SET branding = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        coalesce(tenant.branding, '{}'::jsonb),
        '{logoPath}',
        to_jsonb(coalesce(branding_paths.logo_path, '')),
        true
      ),
      '{faviconPath}',
      to_jsonb(coalesce(branding_paths.favicon_path, '')),
      true
    ),
    '{logoUrl}',
    to_jsonb(CASE
      WHEN branding_paths.logo_path IS NOT NULL
        AND (
          coalesce(tenant.branding ->> 'logoUrl', '') LIKE
            '%/storage/v1/object/public/tenant-branding/%'
          OR coalesce(tenant.branding ->> 'logoUrl', '') = ''
        )
      THEN branding_paths.origin
        || '/functions/v1/public-tenant-branding?tenant='
        || tenant.id || '&kind=logo'
      ELSE coalesce(tenant.branding ->> 'logoUrl', '')
    END),
    true
  ),
  '{faviconUrl}',
  to_jsonb(CASE
    WHEN branding_paths.favicon_path IS NOT NULL
      AND (
        coalesce(tenant.branding ->> 'faviconUrl', '') LIKE
          '%/storage/v1/object/public/tenant-branding/%'
        OR coalesce(tenant.branding ->> 'faviconUrl', '') = ''
      )
    THEN branding_paths.origin
      || '/functions/v1/public-tenant-branding?tenant='
        || tenant.id || '&kind=favicon'
    ELSE coalesce(tenant.branding ->> 'faviconUrl', '')
  END),
  true
)
FROM branding_paths
WHERE tenant.id = branding_paths.id;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_legal_signature_must_be_private;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_legal_signature_must_be_private
  CHECK (private.legal_snapshot_is_private(school_info, id))
  NOT VALID;
ALTER TABLE public.tenants
  VALIDATE CONSTRAINT tenants_legal_signature_must_be_private;

ALTER TABLE public.tenant_contract_records
  DROP CONSTRAINT IF EXISTS tenant_contract_records_legal_signature_private;
ALTER TABLE public.tenant_contract_records
  ADD CONSTRAINT tenant_contract_records_legal_signature_private
  CHECK (private.legal_snapshot_is_private(legal_snapshot, tenant_id))
  NOT VALID;
ALTER TABLE public.tenant_contract_records
  VALIDATE CONSTRAINT tenant_contract_records_legal_signature_private;

ALTER TABLE public.offers
  DROP CONSTRAINT IF EXISTS offers_legal_signature_private;
ALTER TABLE public.offers
  ADD CONSTRAINT offers_legal_signature_private
  CHECK (
    private.legal_snapshot_is_private(payload -> 'schoolInfo', tenant_id)
    AND private.legal_snapshot_is_private(payload -> '_schoolInfo', tenant_id)
  )
  NOT VALID;
ALTER TABLE public.offers
  VALIDATE CONSTRAINT offers_legal_signature_private;

CREATE OR REPLACE FUNCTION private.contract_school_info(p_tenant_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  source_info jsonb;
  canonical_info jsonb;
  signature_path text;
BEGIN
  SELECT tenant.school_info
  INTO source_info
  FROM public.tenants AS tenant
  WHERE tenant.id = p_tenant_id;

  IF source_info IS NULL OR jsonb_typeof(source_info) <> 'object' THEN
    RAISE EXCEPTION 'tenant_legal_identity_incomplete' USING ERRCODE = '22023';
  END IF;

  canonical_info := jsonb_build_object(
    'legalName', coalesce(
      nullif(trim(source_info ->> 'legalName'), ''),
      nullif(trim(source_info ->> 'name'), '')
    ),
    'cnpj', nullif(trim(source_info ->> 'cnpj'), ''),
    'address', nullif(trim(source_info ->> 'address'), ''),
    'email', nullif(trim(source_info ->> 'email'), ''),
    'phone', nullif(trim(source_info ->> 'phone'), ''),
    'city', nullif(trim(source_info ->> 'city'), ''),
    'state', upper(nullif(trim(source_info ->> 'state'), '')),
    'legalRepresentativeName', coalesce(
      nullif(trim(source_info ->> 'legalRepresentativeName'), ''),
      nullif(trim(source_info ->> 'directorName'), '')
    ),
    'legalRepresentativeSignaturePath',
      nullif(trim(source_info ->> 'legalRepresentativeSignaturePath'), '')
  );
  signature_path := canonical_info ->> 'legalRepresentativeSignaturePath';

  IF length(coalesce(canonical_info ->> 'legalName', '')) < 2
    OR NOT private.valid_cnpj(canonical_info ->> 'cnpj')
    OR length(coalesce(canonical_info ->> 'address', '')) < 5
    OR position('@' IN coalesce(canonical_info ->> 'email', '')) < 2
    OR length(regexp_replace(coalesce(canonical_info ->> 'phone', ''), '\D', '', 'g')) < 10
    OR length(coalesce(canonical_info ->> 'city', '')) < 2
    OR coalesce(canonical_info ->> 'state', '') !~ '^[A-Z]{2}$'
    OR length(coalesce(canonical_info ->> 'legalRepresentativeName', '')) < 2
    OR signature_path IS NULL
    OR NOT private.legal_snapshot_is_private(canonical_info, p_tenant_id)
  THEN
    RAISE EXCEPTION 'tenant_legal_identity_incomplete' USING ERRCODE = '22023';
  END IF;

  RETURN canonical_info;
END;
$function$;
REVOKE ALL ON FUNCTION private.contract_school_info(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.contract_school_info(text)
  TO postgres;

-- Os resolvers SQL agora sao APIs internas. Somente a Edge Function valida o
-- bearer offer/usuario e materializa uma URL assinada de 15 minutos.
REVOKE ALL ON FUNCTION public.get_offer_public(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_offer_public(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_invite_offer_public(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_invite_offer_public(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_contract_public(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_contract_public(uuid) TO service_role;

DROP FUNCTION private.normalize_private_legal_snapshot(jsonb,text);
DROP FUNCTION private.legacy_branding_path(text,text,text);
