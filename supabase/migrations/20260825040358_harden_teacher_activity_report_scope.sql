-- Fecha o vazamento entre professores no relatório financeiro e vincula cada
-- arquivo de nota fiscal ao fechamento que autoriza o acesso. Esta migration é
-- deliberadamente reexecutável: o release aplica toda a lista a cada entrega.

DO $guard$
BEGIN
  IF to_regclass('public.profiles') IS NULL
    OR to_regclass('public.tenants') IS NULL
    OR to_regclass('public.tenant_memberships') IS NULL
    OR to_regclass('public.class_logs') IS NULL
    OR to_regclass('public.teacher_closings') IS NULL
    OR to_regclass('storage.objects') IS NULL
    OR to_regprocedure('private.active_tenant_id(uuid)') IS NULL
    OR to_regprocedure('private.active_tenant_role(uuid)') IS NULL
    OR to_regprocedure('private.tenant_is_operational(text)') IS NULL
  THEN
    RAISE EXCEPTION 'teacher_invoice_tenant_foundation_is_required';
  END IF;

  IF to_regprocedure('public.get_teacher_activity_report(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'get_teacher_activity_report_is_required';
  END IF;

  IF to_regprocedure('public.teacher_attach_invoice(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'teacher_attach_invoice_is_required';
  END IF;
END
$guard$;

UPDATE storage.buckets
SET public = false,
    file_size_limit = 5 * 1024 * 1024,
    allowed_mime_types = ARRAY['application/pdf']::text[]
WHERE id = 'invoices';

-- -------------------------------------------------------------------------
-- 1. Relatório: autenticação e tenant ativo são obrigatórios.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_teacher_activity_report(
  p_teacher_id uuid,
  p_month text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  actor_tenant_id text;
  target_teacher public.profiles%ROWTYPE;
  report_month text := coalesce(p_month, pg_catalog.to_char(current_date, 'YYYY-MM'));
  month_start date;
  hourly_rate numeric;
  report jsonb;
BEGIN
  IF actor_id IS NULL OR coalesce(auth.role(), '') <> 'authenticated' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'authentication_required';
  END IF;

  IF p_teacher_id IS NULL
    OR report_month !~ '^\d{4}-(0[1-9]|1[0-2])$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_teacher_report_scope';
  END IF;

  actor_tenant_id := private.active_tenant_id(actor_id);
  actor_role := private.active_tenant_role(actor_id);

  IF actor_tenant_id IS NULL
    OR actor_role IS NULL
    OR NOT private.tenant_is_operational(actor_tenant_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active_tenant_required';
  END IF;

  IF NOT (
    (actor_role = 'TEACHER' AND actor_id = p_teacher_id)
    OR actor_role IN ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'teacher_report_access_denied';
  END IF;

  SELECT profile.*
  INTO target_teacher
  FROM public.profiles AS profile
  WHERE profile.id = p_teacher_id
    AND profile.role = 'TEACHER'
    AND lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.tenant_memberships AS membership
      WHERE membership.user_id = profile.id
        AND membership.tenant_id = actor_tenant_id
        AND membership.role = 'TEACHER'
        AND membership.status = 'ACTIVE'
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'teacher_report_access_denied';
  END IF;

  month_start := (report_month || '-01')::date;
  hourly_rate := coalesce(target_teacher.hourly_rate, 0);

  WITH lessons AS (
    SELECT
      class_log.class_date,
      class_log.presence,
      class_log.subtype,
      class_log.content_covered,
      student.full_name AS student,
      (
        class_log.presence NOT IN ('TEACHER_ABSENCE', 'Falta do Professor')
        AND class_log.subtype IS DISTINCT FROM 'REPOSIÇÃO'
        AND class_log.subtype IS DISTINCT FROM 'Teste Oral'
        AND coalesce(class_log.payment_hold, false) IS FALSE
      ) AS paid
    FROM public.class_logs AS class_log
    LEFT JOIN public.profiles AS student
      ON student.id = class_log.student_id
     AND (
       student.tenant_id = actor_tenant_id
       OR EXISTS (
         SELECT 1
         FROM public.tenant_memberships AS student_membership
         WHERE student_membership.user_id = student.id
           AND student_membership.tenant_id = actor_tenant_id
       )
     )
    WHERE class_log.teacher_id = p_teacher_id
      AND class_log.tenant_id = actor_tenant_id
      AND class_log.class_date >= month_start
      AND class_log.class_date < (month_start + INTERVAL '1 month')
    ORDER BY class_log.class_date, class_log.id
  )
  SELECT pg_catalog.jsonb_build_object(
    'teacher', pg_catalog.jsonb_build_object(
      'name', target_teacher.full_name,
      'email', target_teacher.email,
      'pix', target_teacher.pix_key,
      'hourly_rate', hourly_rate,
      'specializations', target_teacher.specializations
    ),
    'school', (
      SELECT tenant.name
      FROM public.tenants AS tenant
      WHERE tenant.id = actor_tenant_id
      LIMIT 1
    ),
    'month', report_month,
    'lessons', coalesce((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'date', lesson.class_date,
          'student', lesson.student,
          'presence', lesson.presence,
          'subtype', lesson.subtype,
          'content', lesson.content_covered,
          'paid', lesson.paid,
          'value', CASE WHEN lesson.paid THEN hourly_rate ELSE 0 END
        )
        ORDER BY lesson.class_date
      )
      FROM lessons AS lesson
    ), '[]'::jsonb),
    'totals', (
      SELECT pg_catalog.jsonb_build_object(
        'total_lessons', count(*),
        'paid_lessons', count(*) FILTER (WHERE lesson.paid),
        'completed', count(*) FILTER (WHERE lesson.presence = 'COMPLETED'),
        'student_absences', count(*) FILTER (WHERE lesson.presence = 'STUDENT_ABSENCE'),
        'teacher_absences', count(*) FILTER (
          WHERE lesson.presence IN ('TEACHER_ABSENCE', 'Falta do Professor')
        ),
        'amount', coalesce(
          sum(CASE WHEN lesson.paid THEN hourly_rate ELSE 0 END),
          0
        )
      )
      FROM lessons AS lesson
    ),
    'closing', (
      SELECT pg_catalog.jsonb_build_object(
        'status', closing.status,
        'total_amount', closing.total_amount,
        'paid_at', closing.paid_at,
        'confirmation', closing.teacher_confirmation_status,
        'admin_notes', closing.admin_notes
      )
      FROM public.teacher_closings AS closing
      WHERE closing.teacher_id = p_teacher_id
        AND closing.tenant_id = actor_tenant_id
        AND closing.month_year = report_month
      ORDER BY closing.updated_at DESC NULLS LAST, closing.id
      LIMIT 1
    )
  )
  INTO report;

  RETURN report;
END;
$function$;

ALTER FUNCTION public.get_teacher_activity_report(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_teacher_activity_report(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_teacher_activity_report(uuid, text)
  TO authenticated;

-- -------------------------------------------------------------------------
-- 2. Links assinados antigos viram somente o object path do bucket privado.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.decode_invoice_storage_url(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  input_value text := pg_catalog.btrim(p_value);
  marker text;
  encoded_path text;
  decoded_bytes bytea := pg_catalog.decode('', 'hex');
  current_character text;
  encoded_octet text;
  cursor_position integer := 1;
BEGIN
  IF input_value !~* '^https?://' THEN
    RETURN NULL;
  END IF;

  FOREACH marker IN ARRAY ARRAY[
    '/storage/v1/object/sign/invoices/',
    '/storage/v1/object/public/invoices/',
    '/storage/v1/object/authenticated/invoices/'
  ]::text[]
  LOOP
    IF pg_catalog.strpos(input_value, marker) > 0 THEN
      encoded_path := pg_catalog.split_part(input_value, marker, 2);
      EXIT;
    END IF;
  END LOOP;

  IF encoded_path IS NULL THEN
    RETURN NULL;
  END IF;

  encoded_path := pg_catalog.split_part(
    pg_catalog.split_part(encoded_path, '?', 1),
    '#',
    1
  );

  IF encoded_path = '' THEN
    RETURN NULL;
  END IF;

  WHILE cursor_position <= pg_catalog.char_length(encoded_path) LOOP
    current_character := pg_catalog.substr(
      encoded_path,
      cursor_position,
      1
    );

    IF current_character = '%' THEN
      encoded_octet := pg_catalog.substr(
        encoded_path,
        cursor_position + 1,
        2
      );
      IF pg_catalog.char_length(encoded_octet) <> 2
        OR encoded_octet !~ '^[0-9A-Fa-f]{2}$'
      THEN
        RETURN NULL;
      END IF;
      decoded_bytes := decoded_bytes || pg_catalog.decode(encoded_octet, 'hex');
      cursor_position := cursor_position + 3;
    ELSE
      decoded_bytes := decoded_bytes || pg_catalog.convert_to(
        current_character,
        'UTF8'
      );
      cursor_position := cursor_position + 1;
    END IF;
  END LOOP;

  RETURN pg_catalog.convert_from(decoded_bytes, 'UTF8');
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$function$;

WITH normalized_links AS (
  SELECT
    closing.id,
    private.decode_invoice_storage_url(closing.nf_link) AS object_path
  FROM public.teacher_closings AS closing
  WHERE closing.nf_link ~* '^https?://'
)
UPDATE public.teacher_closings AS closing
SET nf_link = normalized.object_path
FROM normalized_links AS normalized
WHERE normalized.id = closing.id
  AND normalized.object_path IS NOT NULL
  AND closing.nf_link IS DISTINCT FROM normalized.object_path;

DO $normalization_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.teacher_closings AS closing
    WHERE private.decode_invoice_storage_url(closing.nf_link) IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invoice_signed_url_normalization_failed';
  END IF;
END
$normalization_guard$;

DROP FUNCTION private.decode_invoice_storage_url(text);

-- -------------------------------------------------------------------------
-- 3. Uma policy precisa enxergar fechamentos mesmo quando o coordenador não
--    possui SELECT direto na tabela. A função é privada, fail-closed e contém
--    toda a decisão de tenant; ela não confia em pasta do uploader.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.can_access_invoice_object(
  p_object_name text,
  p_write boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  actor_tenant_id text;
  canonical_path boolean;
BEGIN
  IF actor_id IS NULL
    OR coalesce(auth.role(), '') <> 'authenticated'
    OR p_object_name IS NULL
    OR pg_catalog.length(p_object_name) > 512
  THEN
    RETURN false;
  END IF;

  actor_tenant_id := private.active_tenant_id(actor_id);
  actor_role := private.active_tenant_role(actor_id);

  IF actor_tenant_id IS NULL
    OR actor_role NOT IN ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
    OR NOT private.tenant_is_operational(actor_tenant_id)
  THEN
    RETURN false;
  END IF;

  canonical_path := p_object_name ~* (
    '^closings/'
    || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    || '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]pdf$'
  );

  -- O namespace novo nunca cai na compatibilidade legada. Assim um nome
  -- malformado em closings/ não ganha acesso só porque apareceu em nf_link.
  IF p_object_name ~* '^closings/' AND NOT canonical_path THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.teacher_closings AS closing
    WHERE closing.tenant_id = actor_tenant_id
      AND (
        (
          canonical_path
          AND pg_catalog.lower(closing.id::text) = pg_catalog.lower(
            pg_catalog.split_part(p_object_name, '/', 2)
          )
          AND (
            p_write
            OR nullif(pg_catalog.btrim(closing.nf_link), '') = p_object_name
          )
        )
        OR (
          NOT canonical_path
          AND p_object_name !~* '^closings/'
          AND nullif(pg_catalog.btrim(closing.nf_link), '') = p_object_name
        )
      )
      AND (
        (actor_role = 'TEACHER' AND closing.teacher_id = actor_id)
        OR actor_role IN ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
      )
      AND (
        NOT p_write
        OR actor_role IN ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
        OR (
          actor_role = 'TEACHER'
          AND coalesce(closing.total_amount, 0) > 0
          AND upper(coalesce(closing.status, '')) IN (
            'PAID_WAITING_NF',
            'PAGO',
            'PAID',
            'REJECTED',
            'REJEITADO',
            'UNDER_REVIEW'
          )
        )
      )
  );
END;
$function$;

ALTER FUNCTION private.can_access_invoice_object(text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.can_access_invoice_object(text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.can_access_invoice_object(text, boolean)
  TO authenticated;

DROP POLICY IF EXISTS "Public Read Invoices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Update Invoices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Upload Invoices" ON storage.objects;
DROP POLICY IF EXISTS "Owner Delete Invoices" ON storage.objects;
DROP POLICY IF EXISTS invoices_owner_insert ON storage.objects;
DROP POLICY IF EXISTS invoices_owner_select ON storage.objects;
DROP POLICY IF EXISTS invoices_scoped_select ON storage.objects;
DROP POLICY IF EXISTS invoices_scoped_insert ON storage.objects;
DROP POLICY IF EXISTS invoices_scoped_update ON storage.objects;
DROP POLICY IF EXISTS invoices_scoped_delete ON storage.objects;
DROP POLICY IF EXISTS invoices_closing_scoped_select ON storage.objects;
DROP POLICY IF EXISTS invoices_closing_scoped_insert ON storage.objects;
DROP POLICY IF EXISTS invoices_closing_scoped_update ON storage.objects;
DROP POLICY IF EXISTS invoices_closing_scoped_delete ON storage.objects;
DROP POLICY IF EXISTS invoices_authenticated_select_guard ON storage.objects;
DROP POLICY IF EXISTS invoices_authenticated_insert_guard ON storage.objects;
DROP POLICY IF EXISTS invoices_authenticated_update_guard ON storage.objects;
DROP POLICY IF EXISTS invoices_authenticated_delete_guard ON storage.objects;
DROP POLICY IF EXISTS invoices_anon_boundary_guard ON storage.objects;

CREATE POLICY invoices_closing_scoped_select
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'invoices'
  AND private.can_access_invoice_object(name, false)
);

CREATE POLICY invoices_closing_scoped_insert
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'invoices'
  AND owner_id = (SELECT auth.uid())::text
  AND private.can_access_invoice_object(name, true)
);

CREATE POLICY invoices_closing_scoped_update
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'invoices'
  AND private.can_access_invoice_object(name, true)
  AND (
    owner_id = (SELECT auth.uid())::text
    OR private.active_tenant_role((SELECT auth.uid())) IN (
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
    OR private.active_tenant_role((SELECT auth.uid())) IN (
      'SCHOOL_ADMIN',
      'COORDINATOR',
      'SUPER_ADMIN'
    )
  )
);

CREATE POLICY invoices_closing_scoped_delete
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'invoices'
  AND private.can_access_invoice_object(name, true)
  AND (
    owner_id = (SELECT auth.uid())::text
    OR private.active_tenant_role((SELECT auth.uid())) IN (
      'SCHOOL_ADMIN',
      'COORDINATOR',
      'SUPER_ADMIN'
    )
  )
);

-- Políticas permissivas são somadas por OR. Estas barreiras restritivas fazem
-- com que uma policy ampla criada no futuro não consiga reabrir `invoices`.
CREATE POLICY invoices_authenticated_select_guard
ON storage.objects
AS RESTRICTIVE
FOR SELECT
TO authenticated
USING (
  bucket_id <> 'invoices'
  OR private.can_access_invoice_object(name, false)
);

CREATE POLICY invoices_authenticated_insert_guard
ON storage.objects
AS RESTRICTIVE
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id <> 'invoices'
  OR (
    owner_id = (SELECT auth.uid())::text
    AND private.can_access_invoice_object(name, true)
  )
);

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
      OR private.active_tenant_role((SELECT auth.uid())) IN (
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
      OR private.active_tenant_role((SELECT auth.uid())) IN (
        'SCHOOL_ADMIN',
        'COORDINATOR',
        'SUPER_ADMIN'
      )
    )
  )
);

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
      OR private.active_tenant_role((SELECT auth.uid())) IN (
        'SCHOOL_ADMIN',
        'COORDINATOR',
        'SUPER_ADMIN'
      )
    )
  )
);

CREATE POLICY invoices_anon_boundary_guard
ON storage.objects
AS RESTRICTIVE
FOR ALL
TO anon
USING (bucket_id <> 'invoices')
WITH CHECK (bucket_id <> 'invoices');

-- -------------------------------------------------------------------------
-- 4. A RPC só aceita o caminho canônico de um PDF já criado pelo professor.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.teacher_attach_invoice(
  p_closing_id uuid,
  p_nf_link text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_teacher_id uuid := auth.uid();
  v_active_tenant_id text;
  v_active_role text;
  closing_row public.teacher_closings%ROWTYPE;
  object_path text;
  current_status text;
  next_status text;
BEGIN
  IF v_teacher_id IS NULL OR coalesce(auth.role(), '') <> 'authenticated' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'authentication_required';
  END IF;

  v_active_tenant_id := private.active_tenant_id(v_teacher_id);
  v_active_role := private.active_tenant_role(v_teacher_id);

  IF v_active_tenant_id IS NULL
    OR v_active_role <> 'TEACHER'
    OR NOT private.tenant_is_operational(v_active_tenant_id)
    OR NOT EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = profile.id
       AND membership.tenant_id = v_active_tenant_id
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
      WHERE profile.id = v_teacher_id
        AND profile.role = 'TEACHER'
        AND lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'teacher_profile_required';
  END IF;

  object_path := nullif(pg_catalog.btrim(coalesce(p_nf_link, '')), '');
  IF p_closing_id IS NULL
    OR object_path IS NULL
    OR pg_catalog.length(object_path) > 512
    OR object_path !~* (
      '^closings/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]pdf$'
    )
    OR pg_catalog.lower(pg_catalog.split_part(object_path, '/', 2))
       <> pg_catalog.lower(p_closing_id::text)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'nf_link_invalido';
  END IF;

  SELECT closing.*
  INTO closing_row
  FROM public.teacher_closings AS closing
  WHERE closing.id = p_closing_id
    AND closing.teacher_id = v_teacher_id
    AND closing.tenant_id = v_active_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'fechamento_nao_encontrado';
  END IF;

  current_status := upper(coalesce(closing_row.status, ''));
  IF coalesce(closing_row.total_amount, 0) <= 0
    OR current_status NOT IN (
      'PAID_WAITING_NF',
      'PAGO',
      'PAID',
      'REJECTED',
      'REJEITADO',
      'UNDER_REVIEW'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'invoice_submission_not_available';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM storage.objects AS invoice_object
    WHERE invoice_object.bucket_id = 'invoices'
      AND invoice_object.name = object_path
      AND invoice_object.owner_id = v_teacher_id::text
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'invoice_object_not_owned';
  END IF;

  next_status := 'UNDER_REVIEW';

  UPDATE public.teacher_closings AS closing
  SET nf_link = object_path,
      status = next_status,
      rejection_reason = CASE
        WHEN next_status = 'UNDER_REVIEW' THEN NULL
        ELSE closing.rejection_reason
      END,
      updated_at = now()
  WHERE closing.id = closing_row.id
    AND closing.teacher_id = v_teacher_id
    AND closing.tenant_id = v_active_tenant_id
  RETURNING closing.* INTO closing_row;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'id', closing_row.id,
    'status', closing_row.status,
    'nf_link', closing_row.nf_link
  );
END;
$function$;

ALTER FUNCTION public.teacher_attach_invoice(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.teacher_attach_invoice(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.teacher_attach_invoice(uuid, text)
  TO authenticated;

-- -------------------------------------------------------------------------
-- 5. Travas de regressão. Se uma policy antiga reaparecer, o deploy para.
-- -------------------------------------------------------------------------

DO $verification$
DECLARE
  unexpected_policies text;
BEGIN
  IF EXISTS (
      SELECT 1
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid = 'public.get_teacher_activity_report(uuid,text)'::regprocedure
        AND privilege.grantee = 0
        AND privilege.privilege_type = 'EXECUTE'
    )
    OR has_function_privilege(
      'anon',
      'public.get_teacher_activity_report(uuid,text)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'authenticated',
      'public.get_teacher_activity_report(uuid,text)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'get_teacher_activity_report_execute_grants_are_unsafe';
  END IF;

  IF EXISTS (
      SELECT 1
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid = 'public.teacher_attach_invoice(uuid,text)'::regprocedure
        AND privilege.grantee = 0
        AND privilege.privilege_type = 'EXECUTE'
    )
    OR has_function_privilege(
      'anon',
      'public.teacher_attach_invoice(uuid,text)',
      'EXECUTE'
    )
    OR has_function_privilege(
      'service_role',
      'public.teacher_attach_invoice(uuid,text)',
      'EXECUTE'
    )
    OR NOT has_function_privilege(
      'authenticated',
      'public.teacher_attach_invoice(uuid,text)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'teacher_attach_invoice_execute_grants_are_unsafe';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets AS bucket
    WHERE bucket.id = 'invoices'
      AND bucket.public IS false
      AND bucket.file_size_limit = 5 * 1024 * 1024
      AND bucket.allowed_mime_types = ARRAY['application/pdf']::text[]
  ) THEN
    RAISE EXCEPTION 'invoice_bucket_constraints_are_unsafe';
  END IF;

  SELECT pg_catalog.string_agg(policy.policyname, ', ' ORDER BY policy.policyname)
  INTO unexpected_policies
  FROM pg_policies AS policy
  WHERE policy.schemaname = 'storage'
    AND policy.tablename = 'objects'
    AND (
      policy.policyname ILIKE '%invoice%'
      OR
      coalesce(policy.qual, '') ILIKE '%invoices%'
      OR coalesce(policy.with_check, '') ILIKE '%invoices%'
    )
    AND policy.policyname NOT IN (
      'invoices_closing_scoped_select',
      'invoices_closing_scoped_insert',
      'invoices_closing_scoped_update',
      'invoices_closing_scoped_delete',
      'invoices_authenticated_select_guard',
      'invoices_authenticated_insert_guard',
      'invoices_authenticated_update_guard',
      'invoices_authenticated_delete_guard',
      'invoices_anon_boundary_guard'
    );

  IF unexpected_policies IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected_invoice_storage_policies: %', unexpected_policies;
  END IF;

  IF (
    SELECT count(*)
    FROM pg_policies AS policy
    WHERE policy.schemaname = 'storage'
      AND policy.tablename = 'objects'
      AND policy.policyname IN (
        'invoices_closing_scoped_select',
        'invoices_closing_scoped_insert',
        'invoices_closing_scoped_update',
        'invoices_closing_scoped_delete',
        'invoices_authenticated_select_guard',
        'invoices_authenticated_insert_guard',
        'invoices_authenticated_update_guard',
        'invoices_authenticated_delete_guard',
        'invoices_anon_boundary_guard'
      )
  ) <> 9
    OR EXISTS (
      SELECT 1
      FROM pg_policies AS policy
      WHERE policy.schemaname = 'storage'
        AND policy.tablename = 'objects'
        AND (
          (
            policy.policyname LIKE 'invoices_closing_scoped_%'
            AND policy.permissive <> 'PERMISSIVE'
          )
          OR (
            policy.policyname IN (
              'invoices_authenticated_select_guard',
              'invoices_authenticated_insert_guard',
              'invoices_authenticated_update_guard',
              'invoices_authenticated_delete_guard',
              'invoices_anon_boundary_guard'
            )
            AND policy.permissive <> 'RESTRICTIVE'
          )
        )
    )
  THEN
    RAISE EXCEPTION 'invoice_storage_policies_are_incomplete';
  END IF;
END
$verification$;
