-- Endurece o assistente do grupo de gestao antes de ampliar seu catalogo.
--
-- A versao original guardava uma unica intencao por grupo, mas nao registrava
-- qual usuario autenticado havia pedido/confirmado. Assim, qualquer participante
-- podia responder "sim". Estes metadados permitem vincular pedido e confirmacao
-- ao mesmo gestor, fazer claim atomico e manter trilha append-only mesmo depois
-- que a pendencia curta for removida.

DO $guard$
BEGIN
  IF to_regclass('public.gestao_acao_pendente') IS NULL THEN
    RAISE EXCEPTION 'gestao_acao_pendente_is_required';
  END IF;
END
$guard$;

ALTER TABLE public.gestao_acao_pendente
  ADD COLUMN IF NOT EXISTS action_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS tool_name text,
  ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'high',
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS requested_by_jid text,
  ADD COLUMN IF NOT EXISTS requested_by_user_id uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_by_jid text,
  ADD COLUMN IF NOT EXISTS confirmed_by_user_id uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.gestao_acao_pendente'::regclass
      AND conname = 'gestao_acao_pendente_status_check'
  ) THEN
    ALTER TABLE public.gestao_acao_pendente
      ADD CONSTRAINT gestao_acao_pendente_status_check
      CHECK (status IN ('pending', 'executing', 'cancelled', 'succeeded', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.gestao_acao_pendente'::regclass
      AND conname = 'gestao_acao_pendente_risk_check'
  ) THEN
    ALTER TABLE public.gestao_acao_pendente
      ADD CONSTRAINT gestao_acao_pendente_risk_check
      CHECK (risk_level IN ('medium', 'high', 'critical'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.gestao_acao_pendente'::regclass
      AND conname = 'gestao_acao_pendente_schema_version_check'
  ) THEN
    ALTER TABLE public.gestao_acao_pendente
      ADD CONSTRAINT gestao_acao_pendente_schema_version_check
      CHECK (schema_version BETWEEN 1 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.gestao_acao_pendente'::regclass
      AND conname = 'gestao_acao_pendente_request_id_size_check'
  ) THEN
    ALTER TABLE public.gestao_acao_pendente
      ADD CONSTRAINT gestao_acao_pendente_request_id_size_check
      CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 200);
  END IF;
END
$constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS gestao_acao_pendente_action_id_uidx
  ON public.gestao_acao_pendente (action_id);
CREATE INDEX IF NOT EXISTS gestao_acao_pendente_tenant_status_expiry_idx
  ON public.gestao_acao_pendente (tenant_id, status, expires_at);

CREATE TABLE IF NOT EXISTS public.gestao_action_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id uuid NOT NULL,
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  group_jid text NOT NULL,
  request_id text,
  tool_name text NOT NULL,
  risk_level text NOT NULL,
  phase text NOT NULL,
  actor_jid text,
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_role text,
  summary text NOT NULL,
  action_payload jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gestao_action_audit_risk_check
    CHECK (risk_level IN ('medium', 'high', 'critical')),
  CONSTRAINT gestao_action_audit_phase_check
    CHECK (phase IN (
      'requested', 'denied', 'confirmed', 'cancelled',
      'succeeded', 'failed', 'expired'
    )),
  CONSTRAINT gestao_action_audit_request_id_size_check
    CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 200)
);

COMMENT ON TABLE public.gestao_action_audit IS
  'Trilha append-only das acoes preparadas e executadas pelo assistente de gestao; sem acesso pelo Data API de clientes.';
COMMENT ON COLUMN public.gestao_action_audit.actor_user_id IS
  'Perfil ativo resolvido pelo telefone real do participante do grupo; pushName nunca e usado como identidade.';

CREATE INDEX IF NOT EXISTS gestao_action_audit_tenant_created_idx
  ON public.gestao_action_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gestao_action_audit_action_created_idx
  ON public.gestao_action_audit (action_id, created_at);

ALTER TABLE public.gestao_action_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gestao_action_audit
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.gestao_action_audit TO service_role;

REVOKE ALL ON TABLE public.gestao_acao_pendente
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.gestao_acao_pendente
  TO service_role;

-- Uma nova intenção nunca pode substituir uma ferramenta que já foi
-- confirmada e está em execução. O Edge pode apenas renovar o lease da mesma
-- ação ou encerrá-la como sucesso/falha; depois disso a linha pode ser removida.
CREATE OR REPLACE FUNCTION public.protect_management_action_execution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'executing' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55006', MESSAGE = 'management_action_in_progress';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'executing' THEN
    IF NEW.action_id IS DISTINCT FROM OLD.action_id
       OR NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.group_jid IS DISTINCT FROM OLD.group_jid
       OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
       OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
       OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.acao IS DISTINCT FROM OLD.acao
       OR NEW.requested_by_jid IS DISTINCT FROM OLD.requested_by_jid
       OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
       OR NEW.confirmed_by_jid IS DISTINCT FROM OLD.confirmed_by_jid
       OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.status NOT IN ('executing', 'succeeded', 'failed') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55006', MESSAGE = 'management_action_in_progress';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_management_action_execution
  ON public.gestao_acao_pendente;
CREATE TRIGGER trg_protect_management_action_execution
BEFORE UPDATE OR DELETE ON public.gestao_acao_pendente
FOR EACH ROW EXECUTE FUNCTION public.protect_management_action_execution();

-- Cada convite criado pelo agente recebe a mesma chave idempotente da mensagem
-- que originou a acao. Reentrega do webhook ou retry depois de timeout devolve
-- o mesmo convite em vez de duplicar ausencia/cobertura.
ALTER TABLE public.class_coverages
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS class_log_match_kind text;

DO $coverage_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.class_coverages'::regclass
       AND conname = 'class_coverages_request_id_size_check'
  ) THEN
    ALTER TABLE public.class_coverages
      ADD CONSTRAINT class_coverages_request_id_size_check
      CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 200);
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.class_coverages'::regclass
       AND conname = 'class_coverages_log_match_kind_check'
  ) THEN
    ALTER TABLE public.class_coverages
      ADD CONSTRAINT class_coverages_log_match_kind_check
      CHECK (
        class_log_match_kind IS NULL OR class_log_match_kind IN (
          'booking_time', 'booking_no_time',
          'student_time', 'student_no_time'
        )
      );
  END IF;
END
$coverage_constraints$;

-- Classifica vínculos legados já aplicados para que retries também validem a
-- mesma identidade usada na movimentação original. Casos incoerentes ficam
-- NULL e, portanto, falham fechados no executor abaixo.
UPDATE public.class_coverages AS coverage
   SET class_log_match_kind = CASE
     WHEN class_log.booking_id = coverage.booking_id::text
          AND class_log.student_id IS NOT DISTINCT FROM coverage.student_id
          AND class_log.start_time =
                CASE
                  WHEN coalesce(coverage.class_time, '') ~
                         '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                    THEN left(coverage.class_time, 5)::time
                END
       THEN 'booking_time'
     WHEN class_log.booking_id = coverage.booking_id::text
          AND class_log.student_id IS NOT DISTINCT FROM coverage.student_id
          AND class_log.start_time IS NULL
       THEN 'booking_no_time'
     WHEN class_log.student_id IS NOT DISTINCT FROM coverage.student_id
          AND class_log.start_time =
                CASE
                  WHEN coalesce(coverage.class_time, '') ~
                         '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                    THEN left(coverage.class_time, 5)::time
                END
       THEN 'student_time'
     WHEN class_log.student_id IS NOT DISTINCT FROM coverage.student_id
          AND class_log.start_time IS NULL
       THEN 'student_no_time'
     ELSE NULL
   END
  FROM public.class_logs AS class_log
 WHERE coverage.class_log_id = class_log.id
   AND coverage.class_log_match_kind IS NULL
   AND coalesce(coverage.class_time, '') ~
         '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$';

-- Coberturas aceitas antes da aula geram o class_log diretamente no
-- substituto. Versões anteriores não ligavam esse log de volta ao convite;
-- faça o backfill somente quando há uma correspondência exata e única.
WITH exact_matches AS (
  SELECT coverage.id AS coverage_id,
         (array_agg(class_log.id ORDER BY class_log.id))[1] AS class_log_id,
         count(*) AS match_count
    FROM public.class_coverages AS coverage
    JOIN public.class_logs AS class_log
      ON class_log.tenant_id = coverage.tenant_id
     AND class_log.teacher_id = coverage.cover_teacher_id
     AND class_log.student_id IS NOT DISTINCT FROM coverage.student_id
     AND class_log.booking_id = coverage.booking_id::text
     AND class_log.class_date = coverage.class_date
     AND class_log.start_time =
           CASE
             WHEN coalesce(coverage.class_time, '') ~
                    '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
               THEN left(coverage.class_time, 5)::time
           END
   WHERE lower(coalesce(coverage.status, '')) = 'confirmed'
     AND coverage.class_log_id IS NULL
     AND coalesce(coverage.class_time, '') ~
           '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
   GROUP BY coverage.id
)
UPDATE public.class_coverages AS coverage
   SET class_log_id = exact_matches.class_log_id,
       class_log_match_kind = 'booking_time',
       moved_at = coalesce(coverage.moved_at, now())
  FROM exact_matches
 WHERE coverage.id = exact_matches.coverage_id
   AND exact_matches.match_count = 1
   AND coverage.class_log_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS class_coverages_tenant_request_uidx
  ON public.class_coverages (tenant_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS class_coverages_token_uidx
  ON public.class_coverages (token)
  WHERE token IS NOT NULL;
CREATE INDEX IF NOT EXISTS class_coverages_booking_date_status_idx
  ON public.class_coverages (booking_id, class_date, status);

-- Toda rota que relaciona professor ausente e substituto toma o mesmo par de
-- locks em ordem lexical. Isso impede o ciclo A->B / B->A em criações
-- simultâneas, inclusive quando a própria RPC precisa inserir a ausência fonte.
CREATE OR REPLACE FUNCTION private.lock_coverage_absence_pair(
  p_original_teacher uuid,
  p_cover_teacher uuid,
  p_class_date date
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  v_first text;
  v_second text;
BEGIN
  IF p_original_teacher IS NULL OR p_cover_teacher IS NULL
     OR p_class_date IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004', MESSAGE = 'coverage_absence_lock_invalid';
  END IF;

  v_first := least(p_original_teacher::text, p_cover_teacher::text);
  v_second := greatest(p_original_teacher::text, p_cover_teacher::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage-absence:' || v_first || ':' || p_class_date::text,
      0
    )
  );
  IF v_second <> v_first THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'coverage-absence:' || v_second || ':' || p_class_date::text,
        0
      )
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION private.lock_coverage_absence_pair(uuid, uuid, date)
  FROM PUBLIC, anon, authenticated;

-- Ultima barreira comum aos dois canais de cobertura (grupo e painel). A Edge
-- pode fazer uma boa pre-validacao para UX, mas somente o trigger consegue
-- fechar a corrida entre validacao e INSERT/confirmacao para todos os escritores.
CREATE OR REPLACE FUNCTION public.enforce_active_class_coverage_slot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_time text;
  v_day_number integer;
  v_day_name text;
  v_class_start timestamptz;
BEGIN
  IF pg_catalog.lower(coalesce(NEW.status, ''))
       NOT IN ('pending', 'confirmed') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND pg_catalog.lower(NEW.status) <> 'pending' THEN
    IF pg_catalog.lower(NEW.status) <> 'confirmed'
       OR coalesce(auth.role(), '') <> 'service_role'
       OR NEW.token IS NOT NULL
       OR NEW.invite_expires_at IS NOT NULL
       OR NEW.confirmed_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501', MESSAGE = 'active_coverage_must_start_pending';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
    OR NEW.original_teacher_id IS DISTINCT FROM OLD.original_teacher_id
    OR NEW.cover_teacher_id IS DISTINCT FROM OLD.cover_teacher_id
    OR NEW.student_id IS DISTINCT FROM OLD.student_id
    OR NEW.absence_id IS DISTINCT FROM OLD.absence_id
    OR NEW.class_date IS DISTINCT FROM OLD.class_date
    OR pg_catalog.left(coalesce(NEW.class_time, ''), 5)
       IS DISTINCT FROM pg_catalog.left(coalesce(OLD.class_time, ''), 5)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'active_coverage_identity_immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND pg_catalog.lower(NEW.status) = 'confirmed'
     AND pg_catalog.lower(coalesce(OLD.status, '')) <> 'confirmed'
     AND coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'coverage_confirmation_requires_service';
  END IF;
  IF NEW.tenant_id IS NULL OR NEW.booking_id IS NULL
     OR NEW.original_teacher_id IS NULL OR NEW.cover_teacher_id IS NULL
     OR NEW.student_id IS NULL OR NEW.absence_id IS NULL
     OR NEW.class_date IS NULL
     OR NEW.original_teacher_id = NEW.cover_teacher_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'active_coverage_invalid';
  END IF;

  v_time := pg_catalog.left(
    pg_catalog.btrim(coalesce(NEW.class_time, '')),
    5
  );
  IF v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'active_coverage_time_invalid';
  END IF;
  NEW.class_time := v_time;
  v_class_start := (
    NEW.class_date::text || ' ' || v_time || ':00-03'
  )::timestamptz;
  IF v_class_start <= pg_catalog.now() THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'active_coverage_already_started';
  END IF;
  IF pg_catalog.lower(NEW.status) = 'pending' THEN
    IF coalesce(NEW.token, '') !~ '^[0-9a-fA-F]{32}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'active_coverage_invite_invalid';
    END IF;
    NEW.invite_expires_at := coalesce(
      NEW.invite_expires_at,
      least(v_class_start, pg_catalog.now() + interval '48 hours')
    );
    IF NEW.invite_expires_at IS NULL
       OR NEW.invite_expires_at <= pg_catalog.now()
       OR NEW.invite_expires_at > v_class_start THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'active_coverage_invite_invalid';
    END IF;
    NEW.token := pg_catalog.lower(NEW.token);
  ELSIF pg_catalog.lower(NEW.status) = 'confirmed' AND TG_OP = 'UPDATE' THEN
    IF pg_catalog.lower(coalesce(OLD.status, '')) <> 'pending'
       OR OLD.invite_expires_at IS NULL
       OR OLD.invite_expires_at <= pg_catalog.now()
       OR coalesce(OLD.token, '') !~ '^[0-9a-fA-F]{32}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'coverage_confirmation_invalid';
    END IF;
  END IF;

  v_day_number := extract(dow FROM NEW.class_date)::integer;
  v_day_name := CASE v_day_number
    WHEN 0 THEN 'Domingo' WHEN 1 THEN 'Segunda' WHEN 2 THEN 'Terça'
    WHEN 3 THEN 'Quarta' WHEN 4 THEN 'Quinta' WHEN 5 THEN 'Sexta'
    WHEN 6 THEN 'Sábado'
  END;

  -- Ordem global: booking row -> occurrence -> teacher -> schedule.
  -- O SELECT detalhado abaixo revalida os campos depois que todos os locks
  -- foram adquiridos, mas a linha precisa ser tomada primeiro para nao inverter
  -- a ordem usada pela RPC do grupo.
  PERFORM 1
    FROM public.bookings AS booking
   WHERE booking.id = NEW.booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'active_coverage_booking_invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage:' || NEW.booking_id::text || ':' || NEW.class_date::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage-teacher:' || NEW.cover_teacher_id::text || ':' ||
      NEW.class_date::text || ':' || v_time,
      0
    )
  );
  PERFORM private.lock_coverage_absence_pair(
    NEW.original_teacher_id,
    NEW.cover_teacher_id,
    NEW.class_date
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'schedule:teacher:' || NEW.cover_teacher_id::text || ':' ||
      public.fold_accents(v_day_name) || ':' || v_time,
      0
    )
  );

  SELECT booking.*
    INTO v_booking
    FROM public.bookings AS booking
   WHERE booking.id = NEW.booking_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_booking.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_booking.teacher_id IS DISTINCT FROM NEW.original_teacher_id
     OR v_booking.student_id IS DISTINCT FROM NEW.student_id
     OR pg_catalog.upper(coalesce(v_booking.status, '')) <>
          'SCHEDULED'
     OR pg_catalog.left(coalesce(v_booking.time_slot, ''), 5) <>
          v_time
     OR (
       v_booking.date IS NOT NULL
       AND v_booking.date IS DISTINCT FROM NEW.class_date
     )
     OR (
       v_booking.date IS NULL
       AND public.fold_accents(v_booking.day_of_week) <>
           public.fold_accents(v_day_name)
     )
     OR (
       v_booking.date IS NULL
       AND v_booking.start_date IS NOT NULL
       AND NEW.class_date < v_booking.start_date
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'active_coverage_booking_invalid';
  END IF;

  PERFORM 1
    FROM public.teacher_absences AS absence
   WHERE absence.id = NEW.absence_id
     AND absence.tenant_id = NEW.tenant_id
     AND absence.teacher_id = NEW.original_teacher_id
     AND pg_catalog.lower(coalesce(absence.status, '')) = 'active'
     AND absence.starts_at::date <= NEW.class_date
     AND absence.ends_at::date >= NEW.class_date
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'active_coverage_absence_invalid';
  END IF;

  IF NOT private.can_access_teacher_projection(
       NEW.original_teacher_id,
       pg_catalog.to_char(NEW.class_date, 'YYYY-MM')
     )
     OR NOT private.can_access_teacher_projection(
       NEW.cover_teacher_id,
       pg_catalog.to_char(NEW.class_date, 'YYYY-MM')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active_coverage_finance_scope_ambiguous';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS teacher
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = teacher.id
       AND membership.tenant_id = NEW.tenant_id
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE teacher.id = NEW.original_teacher_id
       AND teacher.tenant_id = NEW.tenant_id
       AND teacher.role = 'TEACHER'
       AND pg_catalog.lower(coalesce(
             teacher.lifecycle_status, 'active'
           )) NOT IN ('suspended', 'offboarded')
       AND 1 = (
         SELECT count(DISTINCT active_membership.tenant_id)
           FROM public.tenant_memberships AS active_membership
          WHERE active_membership.user_id = teacher.id
            AND active_membership.role = 'TEACHER'
            AND active_membership.status = 'ACTIVE'
       )
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.profiles AS teacher
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = teacher.id
       AND membership.tenant_id = NEW.tenant_id
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE teacher.id = NEW.cover_teacher_id
       AND teacher.tenant_id = NEW.tenant_id
       AND teacher.role = 'TEACHER'
       AND pg_catalog.lower(coalesce(
             teacher.lifecycle_status, 'active'
           )) NOT IN ('suspended', 'offboarded')
       AND 1 = (
         SELECT count(DISTINCT active_membership.tenant_id)
           FROM public.tenant_memberships AS active_membership
          WHERE active_membership.user_id = teacher.id
            AND active_membership.role = 'TEACHER'
            AND active_membership.status = 'ACTIVE'
       )
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.profiles AS student
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = student.id
       AND membership.tenant_id = NEW.tenant_id
       AND membership.role = 'STUDENT'
       AND membership.status = 'ACTIVE'
     WHERE student.id = NEW.student_id
       AND student.role = 'STUDENT'
       AND pg_catalog.lower(coalesce(
             student.lifecycle_status, 'active'
           )) NOT IN ('suspended', 'offboarded')
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.teacher_availability AS availability
     WHERE availability.tenant_id = NEW.tenant_id
       AND availability.teacher_id = NEW.cover_teacher_id
       AND availability.day_of_week = v_day_number
       AND (
         availability.start_time = v_time::time
         OR (
           availability.end_time IS NOT NULL
           AND availability.start_time <= v_time::time
           AND availability.end_time > v_time::time
         )
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'active_coverage_member_unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.teacher_absences AS absence
     WHERE absence.tenant_id = NEW.tenant_id
       AND absence.teacher_id = NEW.cover_teacher_id
       AND pg_catalog.lower(coalesce(absence.status, '')) = 'active'
       AND absence.starts_at::date <= NEW.class_date
       AND absence.ends_at::date >= NEW.class_date
  ) OR EXISTS (
    SELECT 1
      FROM public.bookings AS conflict
     WHERE conflict.tenant_id = NEW.tenant_id
       AND conflict.teacher_id = NEW.cover_teacher_id
       AND pg_catalog.upper(coalesce(conflict.status, '')) <>
           'CANCELLED'
       AND pg_catalog.left(coalesce(conflict.time_slot, ''), 5) =
           v_time
       AND (
         conflict.date = NEW.class_date
         OR (
           conflict.date IS NULL
           AND public.fold_accents(conflict.day_of_week) =
               public.fold_accents(v_day_name)
           AND (
             conflict.start_date IS NULL
             OR conflict.start_date <= NEW.class_date
           )
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.reschedules AS reschedule
     WHERE reschedule.tenant_id = NEW.tenant_id
       AND reschedule.teacher_id = NEW.cover_teacher_id
       AND public.parse_lesson_date(reschedule.date) = NEW.class_date
       AND pg_catalog.left(reschedule.time::text, 5) = v_time
       AND reschedule.used_at IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.appointments AS appointment
     WHERE appointment.tenant_id = NEW.tenant_id
       AND (
         appointment.teacher_id = NEW.cover_teacher_id
         OR appointment.professor_id = NEW.cover_teacher_id
       )
       AND pg_catalog.lower(coalesce(appointment.status, ''))
           IN ('scheduled', 'confirmed')
       AND pg_catalog.abs(extract(
             epoch FROM (appointment.start_time - v_class_start)
           )) < 1800
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01', MESSAGE = 'active_coverage_schedule_conflict';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.class_coverages AS coverage
     WHERE coverage.id IS DISTINCT FROM NEW.id
       AND coverage.tenant_id = NEW.tenant_id
       AND (
         (
           coverage.booking_id = NEW.booking_id
           AND coverage.class_date = NEW.class_date
         )
         OR (
           coverage.cover_teacher_id = NEW.cover_teacher_id
           AND coverage.class_date = NEW.class_date
           AND pg_catalog.left(coverage.class_time, 5) = v_time
         )
       )
       AND (
         pg_catalog.lower(coverage.status) = 'confirmed'
         OR (
           pg_catalog.lower(coverage.status) = 'pending'
           AND pg_catalog.now() < coalesce(
             coverage.invite_expires_at,
             (
               coverage.class_date::text || ' ' ||
               pg_catalog.left(coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505', MESSAGE = 'active_coverage_slot_conflict';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_active_class_coverage_slot
  ON public.class_coverages;
CREATE TRIGGER trg_enforce_active_class_coverage_slot
BEFORE INSERT OR UPDATE OF
  tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  absence_id, class_date, class_time, status, token, invite_expires_at
ON public.class_coverages
FOR EACH ROW EXECUTE FUNCTION public.enforce_active_class_coverage_slot();
REVOKE ALL ON FUNCTION public.enforce_active_class_coverage_slot()
  FROM PUBLIC, anon, authenticated;

-- Fecha o ciclo da aula futura: assim que o substituto lança a ocorrência, o
-- vínculo é persistido atomicamente. Isso libera booking/ausência para mudanças
-- posteriores sem depender de uma nova visita ao link de aceite.
CREATE OR REPLACE FUNCTION public.link_class_log_to_confirmed_coverage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_coverage_id uuid;
  v_match_count integer := 0;
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.teacher_id IS NULL
     OR NEW.student_id IS NULL OR NEW.booking_id IS NULL
     OR NEW.class_date IS NULL OR NEW.start_time IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*), (array_agg(coverage.id ORDER BY coverage.id))[1]
    INTO v_match_count, v_coverage_id
    FROM public.class_coverages AS coverage
   WHERE coverage.tenant_id = NEW.tenant_id
     AND pg_catalog.lower(coalesce(coverage.status, '')) = 'confirmed'
     AND coverage.class_log_id IS NULL
     AND coverage.cover_teacher_id = NEW.teacher_id
     AND coverage.student_id IS NOT DISTINCT FROM NEW.student_id
     AND coverage.booking_id::text = NEW.booking_id
     AND coverage.class_date = NEW.class_date
     AND coalesce(coverage.class_time, '') ~
           '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
     AND CASE
           WHEN coalesce(coverage.class_time, '') ~
                  '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
             THEN pg_catalog.left(coverage.class_time, 5)::time
         END = NEW.start_time;

  IF v_match_count > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '21000', MESSAGE = 'coverage_log_link_ambiguous';
  END IF;
  IF v_match_count = 0 OR v_coverage_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM public.class_coverages AS coverage
   WHERE coverage.id = v_coverage_id
   FOR UPDATE;
  UPDATE public.class_coverages
     SET class_log_id = NEW.id,
         class_log_match_kind = 'booking_time',
         moved_at = pg_catalog.now()
   WHERE id = v_coverage_id
     AND tenant_id = NEW.tenant_id
     AND pg_catalog.lower(coalesce(status, '')) = 'confirmed'
     AND class_log_id IS NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_link_class_log_to_confirmed_coverage
  ON public.class_logs;
CREATE TRIGGER trg_link_class_log_to_confirmed_coverage
AFTER INSERT ON public.class_logs
FOR EACH ROW EXECUTE FUNCTION public.link_class_log_to_confirmed_coverage();

REVOKE ALL ON FUNCTION public.link_class_log_to_confirmed_coverage()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.protect_absence_active_coverages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_day record;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
    OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' AND EXISTS (
    SELECT 1
      FROM public.class_coverages AS coverage
     WHERE coverage.absence_id = OLD.id
       AND coverage.tenant_id = OLD.tenant_id
       AND (
         (
           pg_catalog.lower(coverage.status) = 'confirmed'
           AND coverage.class_log_id IS NULL
         )
         OR (
           pg_catalog.lower(coverage.status) = 'pending'
           AND pg_catalog.now() < coalesce(
             coverage.invite_expires_at,
             (
               coverage.class_date::text || ' ' ||
               pg_catalog.left(coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01', MESSAGE = 'absence_has_active_coverages';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF pg_catalog.lower(coalesce(NEW.status, '')) <> 'active' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS NULL OR NEW.teacher_id IS NULL
     OR NEW.starts_at IS NULL OR NEW.ends_at IS NULL
     OR NEW.ends_at::date < NEW.starts_at::date
     OR NEW.ends_at::date > NEW.starts_at::date + 366 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'active_absence_period_invalid';
  END IF;

  FOR v_day IN
    SELECT day_value::date AS absence_date
      FROM pg_catalog.generate_series(
        NEW.starts_at::date,
        NEW.ends_at::date,
        interval '1 day'
      ) AS day_value
     ORDER BY day_value
  LOOP
    IF NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'coverage-absence:' || NEW.teacher_id::text || ':' ||
        v_day.absence_date::text,
        0
      )
    ) THEN
      -- O UPDATE/DELETE já possui row lock quando o BEFORE ROW executa. Nunca
      -- espere por uma cobertura que pode estar esperando essa mesma linha:
      -- aborte como serialização e deixe o chamador tentar novamente.
      RAISE EXCEPTION USING
        ERRCODE = '40001', MESSAGE = 'coverage_absence_concurrent_change';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM public.class_coverages AS coverage
     WHERE coverage.tenant_id = NEW.tenant_id
       AND coverage.cover_teacher_id = NEW.teacher_id
       AND coverage.class_date BETWEEN NEW.starts_at::date AND NEW.ends_at::date
       AND (
         coverage.class_date::text || ' ' ||
         pg_catalog.left(coverage.class_time, 5) || ':00-03'
       )::timestamptz > pg_catalog.now()
       AND (
         pg_catalog.lower(coverage.status) = 'confirmed'
         OR (
           pg_catalog.lower(coverage.status) = 'pending'
           AND pg_catalog.now() < coalesce(
             coverage.invite_expires_at,
             (
               coverage.class_date::text || ' ' ||
               pg_catalog.left(coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01', MESSAGE = 'absence_conflicts_with_active_coverage';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_00_protect_absence_active_coverages_insert
  ON public.teacher_absences;
CREATE TRIGGER trg_00_protect_absence_active_coverages_insert
BEFORE INSERT ON public.teacher_absences
FOR EACH ROW EXECUTE FUNCTION public.protect_absence_active_coverages();

DROP TRIGGER IF EXISTS trg_00_protect_absence_active_coverages_update
  ON public.teacher_absences;
CREATE TRIGGER trg_00_protect_absence_active_coverages_update
BEFORE UPDATE OF tenant_id, teacher_id, starts_at, ends_at, status
ON public.teacher_absences
FOR EACH ROW EXECUTE FUNCTION public.protect_absence_active_coverages();

DROP TRIGGER IF EXISTS trg_00_protect_absence_active_coverages_delete
  ON public.teacher_absences;
CREATE TRIGGER trg_00_protect_absence_active_coverages_delete
BEFORE DELETE ON public.teacher_absences
FOR EACH ROW EXECUTE FUNCTION public.protect_absence_active_coverages();

REVOKE ALL ON FUNCTION public.protect_absence_active_coverages()
  FROM PUBLIC, anon, authenticated;

-- Professores consultam suas coberturas pela RPC tenant-aware; nenhuma escrita
-- cliente pode contornar o aceite por token e a revalidacao transacional.
DROP POLICY IF EXISTS cc_write ON public.class_coverages;
DROP POLICY IF EXISTS class_coverages_scoped_select ON public.class_coverages;
CREATE POLICY class_coverages_scoped_select ON public.class_coverages
  FOR SELECT TO authenticated
  USING (
    tenant_id = public._my_tenant_id()
    AND (
      original_teacher_id = (SELECT auth.uid())
      OR cover_teacher_id = (SELECT auth.uid())
      OR public._my_role() = ANY (
        ARRAY['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN']
      )
    )
  );

ALTER TABLE public.teacher_transfers
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

DO $transfer_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.teacher_transfers'::regclass
       AND conname = 'teacher_transfers_request_id_size_check'
  ) THEN
    ALTER TABLE public.teacher_transfers
      ADD CONSTRAINT teacher_transfers_request_id_size_check
      CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 200);
  END IF;
END
$transfer_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS teacher_transfers_tenant_request_uidx
  ON public.teacher_transfers (tenant_id, request_id)
  WHERE request_id IS NOT NULL;

-- A transferência altera os vínculos globais do perfil do aluno. Por isso ela
-- só é permitida no tenant principal dos envolvidos e apenas uma proposta
-- PENDING/ACCEPTED pode existir por aluno. O advisory lock fecha a corrida entre
-- o painel e o assistente sem exigir que dados legados já estejam perfeitos.
CREATE OR REPLACE FUNCTION public.protect_active_teacher_transfer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF upper(coalesce(NEW.status, '')) NOT IN ('PENDING', 'ACCEPTED') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'teacher-transfer:' || NEW.tenant_id || ':' || NEW.student_id::text,
      0
    )
  );

  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS student
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = student.id
       AND membership.tenant_id = NEW.tenant_id
       AND membership.role = 'STUDENT'
       AND membership.status = 'ACTIVE'
     WHERE student.id = NEW.student_id
       AND student.role = 'STUDENT'
       AND student.tenant_id = NEW.tenant_id
       AND lower(coalesce(student.lifecycle_status, 'active'))
             NOT IN ('suspended', 'offboarded')
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.profiles AS teacher
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = teacher.id
       AND membership.tenant_id = NEW.tenant_id
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE teacher.id = NEW.to_teacher_id
       AND teacher.role = 'TEACHER'
       AND teacher.tenant_id = NEW.tenant_id
       AND lower(coalesce(teacher.lifecycle_status, 'active'))
             NOT IN ('suspended', 'offboarded')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'teacher_transfer_primary_tenant_required';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.teacher_transfers AS competing
     WHERE competing.tenant_id = NEW.tenant_id
       AND competing.student_id = NEW.student_id
       AND competing.id IS DISTINCT FROM NEW.id
       AND upper(coalesce(competing.status, '')) IN ('PENDING', 'ACCEPTED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505', MESSAGE = 'active_teacher_transfer_exists';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_active_teacher_transfer
  ON public.teacher_transfers;
CREATE TRIGGER trg_protect_active_teacher_transfer
BEFORE INSERT OR UPDATE OF tenant_id, student_id, to_teacher_id, status
ON public.teacher_transfers
FOR EACH ROW EXECUTE FUNCTION public.protect_active_teacher_transfer();

REVOKE ALL ON FUNCTION public.protect_active_teacher_transfer()
  FROM PUBLIC, anon, authenticated;

-- Ajustes financeiros precisam da mesma protecao contra reentrega do webhook.
-- A chave fica no proprio lancamento para que a insercao e a atualizacao de um
-- fechamento PENDENTE acontecam uma unica vez, na mesma transacao.
ALTER TABLE public.closing_adjustments
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS closing_synced boolean NOT NULL DEFAULT false;

DO $adjustment_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.closing_adjustments'::regclass
       AND conname = 'closing_adjustments_request_id_size_check'
  ) THEN
    ALTER TABLE public.closing_adjustments
      ADD CONSTRAINT closing_adjustments_request_id_size_check
      CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 200);
  END IF;
END
$adjustment_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS closing_adjustments_tenant_request_uidx
  ON public.closing_adjustments (tenant_id, request_id)
  WHERE request_id IS NOT NULL;

-- Ajustes e coberturas recalculam o mesmo fechamento. Todos tomam esta chave
-- antes de ler/somar para que um UPDATE que ficou esperando nunca use um
-- snapshot anterior e sobrescreva um ajuste recém-confirmado.
CREATE OR REPLACE FUNCTION private.lock_teacher_closing_pair(
  p_tenant text,
  p_month text,
  p_teacher_a uuid,
  p_teacher_b uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  v_first text;
  v_second text;
BEGIN
  IF p_tenant IS NULL OR p_month IS NULL OR p_teacher_a IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004', MESSAGE = 'teacher_closing_lock_invalid';
  END IF;

  v_first := least(p_teacher_a::text, coalesce(p_teacher_b, p_teacher_a)::text);
  v_second := greatest(p_teacher_a::text, coalesce(p_teacher_b, p_teacher_a)::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'teacher-closing:' || p_tenant || ':' || v_first || ':' || p_month,
      0
    )
  );
  IF v_second <> v_first THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'teacher-closing:' || p_tenant || ':' || v_second || ':' || p_month,
        0
      )
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION private.lock_teacher_closing_pair(
  text, text, uuid, uuid
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.refresh_teacher_closing_snapshot(
  p_tenant text,
  p_teacher uuid,
  p_month text,
  p_allow_create boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_existing public.teacher_closings%ROWTYPE;
  v_paid_count integer := 0;
  v_paid_amount numeric := 0;
  v_carry_count integer := 0;
  v_carry_amount numeric := 0;
  v_adjustment_count integer := 0;
  v_adjustment_amount numeric := 0;
  v_lessons integer;
  v_total numeric;
  v_closing_id uuid;
BEGIN
  IF p_tenant IS NULL OR p_teacher IS NULL
     OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023', MESSAGE = 'teacher_closing_refresh_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS teacher
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = teacher.id
       AND membership.tenant_id = p_tenant
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE teacher.id = p_teacher
       AND teacher.role = 'TEACHER'
       AND teacher.tenant_id = p_tenant
       AND lower(coalesce(teacher.lifecycle_status, 'active'))
             NOT IN ('suspended', 'offboarded')
  ) THEN
    RETURN jsonb_build_object(
      'ok', false, 'state', 'invalid_scope', 'synced', false
    );
  END IF;

  PERFORM private.lock_teacher_closing_pair(
    p_tenant,
    p_month,
    p_teacher,
    NULL
  );

  SELECT count(*), round(coalesce(sum(payable.rate_efetivo), 0), 2)
    INTO v_paid_count, v_paid_amount
    FROM public.v_payable_class_logs AS payable
   WHERE payable.tenant_id = p_tenant
     AND payable.teacher_id = p_teacher
     AND to_char(payable.class_date, 'YYYY-MM') = p_month;

  SELECT count(*), round(coalesce(sum(carryover.amount), 0), 2)
    INTO v_carry_count, v_carry_amount
    FROM public.closing_carryovers AS carryover
    JOIN public.class_logs AS source_log
      ON source_log.id = carryover.class_log_id
     AND source_log.tenant_id = p_tenant
   WHERE carryover.teacher_id = p_teacher
     AND carryover.absorbed_month = p_month;

  SELECT count(*), round(coalesce(sum(adjustment.amount), 0), 2)
    INTO v_adjustment_count, v_adjustment_amount
    FROM public.closing_adjustments AS adjustment
   WHERE adjustment.tenant_id = p_tenant
     AND adjustment.teacher_id = p_teacher
     AND adjustment.month_year = p_month;

  v_lessons := v_paid_count + v_carry_count;
  v_total := round(
    v_paid_amount + v_carry_amount + v_adjustment_amount,
    2
  );

  SELECT closing.*
    INTO v_existing
    FROM public.teacher_closings AS closing
   WHERE closing.tenant_id = p_tenant
     AND closing.teacher_id = p_teacher
     AND closing.month_year = p_month
   ORDER BY closing.created_at
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    IF NOT p_allow_create OR (
      v_paid_count = 0 AND v_carry_count = 0 AND v_adjustment_count = 0
    ) THEN
      RETURN jsonb_build_object(
        'ok', true, 'state', 'absent', 'synced', false,
        'total_lessons', v_lessons, 'total_amount', v_total
      );
    END IF;

    INSERT INTO public.teacher_closings (
      teacher_id, tenant_id, month_year, total_lessons, total_amount,
      status, period_start, period_end, created_at
    ) VALUES (
      p_teacher, p_tenant, p_month, v_lessons, v_total,
      'PENDENTE', (p_month || '-01')::date,
      (
        date_trunc('month', (p_month || '-01')::date) +
        interval '1 month - 1 day'
      )::date,
      now()
    )
    RETURNING id INTO v_closing_id;

    UPDATE public.closing_adjustments
       SET closing_synced = true
     WHERE tenant_id = p_tenant
       AND teacher_id = p_teacher
       AND month_year = p_month;
    RETURN jsonb_build_object(
      'ok', true, 'state', 'created', 'synced', true,
      'closing_id', v_closing_id,
      'total_lessons', v_lessons, 'total_amount', v_total
    );
  END IF;

  IF v_existing.status <> 'PENDENTE' THEN
    RETURN jsonb_build_object(
      'ok', true, 'state', 'frozen', 'synced', false,
      'closing_id', v_existing.id,
      'total_lessons', v_existing.total_lessons,
      'total_amount', v_existing.total_amount
    );
  END IF;

  IF v_existing.total_lessons IS NOT DISTINCT FROM v_lessons
     AND v_existing.total_amount IS NOT DISTINCT FROM v_total THEN
    UPDATE public.closing_adjustments
       SET closing_synced = true
     WHERE tenant_id = p_tenant
       AND teacher_id = p_teacher
       AND month_year = p_month
       AND closing_synced IS DISTINCT FROM true;
    RETURN jsonb_build_object(
      'ok', true, 'state', 'unchanged', 'synced', true,
      'closing_id', v_existing.id,
      'total_lessons', v_lessons, 'total_amount', v_total
    );
  END IF;

  UPDATE public.teacher_closings
     SET total_lessons = v_lessons,
         total_amount = v_total,
         updated_at = now(),
         teacher_confirmation_status = CASE
           WHEN teacher_confirmation_status = 'OK' THEN 'PENDENTE'
           ELSE teacher_confirmation_status
         END,
         teacher_confirmation_date = CASE
           WHEN teacher_confirmation_status = 'OK' THEN NULL
           ELSE teacher_confirmation_date
         END
   WHERE id = v_existing.id
     AND tenant_id = p_tenant
     AND teacher_id = p_teacher
     AND status = 'PENDENTE';

  UPDATE public.closing_adjustments
     SET closing_synced = true
   WHERE tenant_id = p_tenant
     AND teacher_id = p_teacher
     AND month_year = p_month;
  DELETE FROM public.automation_sent
   WHERE kind = 'MONTHLY_CLOSING'
     AND subject_id = p_teacher::text || ':' || p_month;

  RETURN jsonb_build_object(
    'ok', true, 'state', 'updated', 'synced', true,
    'closing_id', v_existing.id,
    'total_lessons', v_lessons, 'total_amount', v_total
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.refresh_teacher_closing_snapshot(
  text, uuid, text, boolean
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.teacher_pending_carryover_in_tenant(
  p_tenant text,
  p_teacher uuid
)
RETURNS TABLE(
  class_log_id uuid,
  origin_month text,
  class_date date,
  amount numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT payable.id,
         to_char(payable.class_date, 'YYYY-MM'),
         payable.class_date,
         payable.rate_efetivo
    FROM public.v_payable_class_logs AS payable
    JOIN public.teacher_closings AS closing
      ON closing.tenant_id = p_tenant
     AND closing.teacher_id = payable.teacher_id
     AND closing.month_year = to_char(payable.class_date, 'YYYY-MM')
   WHERE payable.tenant_id = p_tenant
     AND payable.teacher_id = p_teacher
     AND closing.status <> 'PENDENTE'
     AND payable.created_at > closing.updated_at
     AND payable.created_at >= date '2026-08-02'
     AND EXISTS (
       SELECT 1
         FROM public.profiles AS teacher
         JOIN public.tenant_memberships AS membership
           ON membership.user_id = teacher.id
          AND membership.tenant_id = p_tenant
          AND membership.role = 'TEACHER'
          AND membership.status = 'ACTIVE'
        WHERE teacher.id = p_teacher
          AND teacher.role = 'TEACHER'
          AND teacher.tenant_id = p_tenant
          AND lower(coalesce(teacher.lifecycle_status, 'active'))
                NOT IN ('suspended', 'offboarded')
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.closing_carryovers AS absorbed
        WHERE absorbed.class_log_id = payable.id
     );
$function$;

REVOKE ALL ON FUNCTION private.teacher_pending_carryover_in_tenant(text, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.teacher_pending_carryover_in_tenant(
  p_tenant text,
  p_teacher uuid
)
RETURNS TABLE(
  class_log_id uuid,
  origin_month text,
  class_date date,
  amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  RETURN QUERY
  SELECT pending.class_log_id,
         pending.origin_month,
         pending.class_date,
         pending.amount
    FROM private.teacher_pending_carryover_in_tenant(
      p_tenant,
      p_teacher
    ) AS pending;
END;
$function$;

REVOKE ALL ON FUNCTION public.teacher_pending_carryover_in_tenant(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.teacher_pending_carryover_in_tenant(text, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_teacher_closing_snapshot(
  p_tenant text,
  p_teacher uuid,
  p_month text,
  p_allow_create boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  RETURN private.refresh_teacher_closing_snapshot(
    p_tenant,
    p_teacher,
    p_month,
    p_allow_create
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_teacher_closing_snapshot(
  text, uuid, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_teacher_closing_snapshot(
  text, uuid, text, boolean
) TO service_role;

-- O editor financeiro legado usa a mesma serialização e a mesma fórmula
-- canônica. Incrementar/decrementar o snapshot diretamente concorria com o job
-- mensal e podia perder ajustes já confirmados.
CREATE OR REPLACE FUNCTION public.set_closing_adjustment(
  p_teacher_id uuid,
  p_month text,
  p_description text,
  p_amount numeric,
  p_delete_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_tenant text;
  v_old public.closing_adjustments%ROWTYPE;
  v_id uuid;
  v_refresh jsonb;
  v_sync boolean := false;
  v_closing_status text;
  v_expected_teacher uuid;
  v_expected_month text;
BEGIN
  IF p_delete_id IS NOT NULL THEN
    SELECT adjustment.*
      INTO v_old
      FROM public.closing_adjustments AS adjustment
     WHERE adjustment.id = p_delete_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', true, 'removido', p_delete_id);
    END IF;
    v_tenant := v_old.tenant_id;
    v_expected_teacher := v_old.teacher_id;
    v_expected_month := v_old.month_year;

    IF NOT v_is_service AND NOT (
      EXISTS (
        SELECT 1 FROM public.profiles AS actor
         WHERE actor.id = v_actor_id
           AND actor.role = 'SUPER_ADMIN'
           AND lower(coalesce(actor.lifecycle_status, 'active'))
                 NOT IN ('suspended', 'offboarded')
      ) OR EXISTS (
        SELECT 1
          FROM public.tenant_memberships AS membership
          JOIN public.profiles AS actor
            ON actor.id = membership.user_id
         WHERE membership.user_id = v_actor_id
           AND membership.tenant_id = v_tenant
           AND membership.status = 'ACTIVE'
           AND membership.role IN (
             'SCHOOL_ADMIN', 'COORDINATOR'
           )
           AND lower(coalesce(actor.lifecycle_status, 'active'))
                 NOT IN ('suspended', 'offboarded')
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'sem_permissao';
    END IF;

    PERFORM private.lock_teacher_closing_pair(
      v_tenant,
      v_old.month_year,
      v_old.teacher_id,
      NULL
    );
    SELECT adjustment.*
      INTO v_old
      FROM public.closing_adjustments AS adjustment
     WHERE adjustment.id = p_delete_id
       AND adjustment.tenant_id = v_tenant
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', true, 'removido', p_delete_id);
    END IF;
    IF v_old.teacher_id IS DISTINCT FROM v_expected_teacher
       OR v_old.month_year IS DISTINCT FROM v_expected_month THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001', MESSAGE = 'closing_adjustment_changed';
    END IF;

    SELECT closing.status
      INTO v_closing_status
      FROM public.teacher_closings AS closing
     WHERE closing.tenant_id = v_tenant
       AND closing.teacher_id = v_old.teacher_id
       AND closing.month_year = v_old.month_year
     ORDER BY closing.created_at
     LIMIT 1
     FOR UPDATE;
    IF v_closing_status IS NOT NULL AND v_closing_status <> 'PENDENTE' THEN
      RETURN jsonb_build_object(
        'ok', false, 'error', 'fechamento_nao_pendente'
      );
    END IF;

    DELETE FROM public.closing_adjustments
     WHERE id = v_old.id
       AND tenant_id = v_tenant;
    v_refresh := private.refresh_teacher_closing_snapshot(
      v_tenant,
      v_old.teacher_id,
      v_old.month_year,
      false
    );
    v_sync := coalesce((v_refresh ->> 'synced')::boolean, false);
    RETURN jsonb_build_object(
      'ok', true,
      'removido', p_delete_id,
      'repasse_atualizado', v_sync
    );
  END IF;

  SELECT teacher.tenant_id
    INTO v_tenant
    FROM public.profiles AS teacher
   WHERE teacher.id = p_teacher_id
     AND teacher.role = 'TEACHER'
     AND teacher.tenant_id IS NOT NULL
     AND lower(coalesce(teacher.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND EXISTS (
       SELECT 1
         FROM public.tenant_memberships AS membership
        WHERE membership.user_id = teacher.id
          AND membership.tenant_id = teacher.tenant_id
          AND membership.role = 'TEACHER'
          AND membership.status = 'ACTIVE'
     );
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'professor_nao_encontrado';
  END IF;

  IF NOT v_is_service AND NOT (
    EXISTS (
      SELECT 1 FROM public.profiles AS actor
       WHERE actor.id = v_actor_id
         AND actor.role = 'SUPER_ADMIN'
         AND lower(coalesce(actor.lifecycle_status, 'active'))
               NOT IN ('suspended', 'offboarded')
    ) OR EXISTS (
      SELECT 1
        FROM public.tenant_memberships AS membership
        JOIN public.profiles AS actor
          ON actor.id = membership.user_id
       WHERE membership.user_id = v_actor_id
         AND membership.tenant_id = v_tenant
         AND membership.status = 'ACTIVE'
         AND membership.role IN ('SCHOOL_ADMIN', 'COORDINATOR')
         AND lower(coalesce(actor.lifecycle_status, 'active'))
               NOT IN ('suspended', 'offboarded')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'sem_permissao';
  END IF;
  IF p_month IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'mes_invalido';
  END IF;
  IF length(btrim(coalesce(p_description, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'motivo_invalido';
  END IF;
  IF p_amount IS NULL OR p_amount = 0 OR p_amount = 'NaN'::numeric THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'valor_invalido';
  END IF;

  PERFORM private.lock_teacher_closing_pair(
    v_tenant,
    p_month,
    p_teacher_id,
    NULL
  );
  SELECT closing.status
    INTO v_closing_status
    FROM public.teacher_closings AS closing
   WHERE closing.tenant_id = v_tenant
     AND closing.teacher_id = p_teacher_id
     AND closing.month_year = p_month
   ORDER BY closing.created_at
   LIMIT 1
   FOR UPDATE;
  IF v_closing_status IS NOT NULL AND v_closing_status <> 'PENDENTE' THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'fechamento_nao_pendente'
    );
  END IF;

  INSERT INTO public.closing_adjustments (
    tenant_id, teacher_id, month_year, description, amount, created_by,
    closing_synced
  ) VALUES (
    v_tenant, p_teacher_id, p_month, btrim(p_description), p_amount,
    v_actor_id, false
  )
  RETURNING id INTO v_id;
  v_refresh := private.refresh_teacher_closing_snapshot(
    v_tenant,
    p_teacher_id,
    p_month,
    false
  );
  v_sync := coalesce((v_refresh ->> 'synced')::boolean, false);
  UPDATE public.closing_adjustments
     SET closing_synced = v_sync
   WHERE id = v_id;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_id,
    'valor', p_amount,
    'repasse_atualizado', v_sync,
    'aviso', CASE WHEN v_sync THEN NULL
      ELSE 'O ajuste foi registrado; o fechamento ainda não existe.' END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.set_closing_adjustment(
  uuid, text, text, numeric, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_closing_adjustment(
  uuid, text, text, numeric, uuid
) TO authenticated, service_role;

-- O job global também converge pelo refresher canônico. Primeiro materializa
-- sobras sob o mesmo lock; depois calcula aulas + sobras + ajustes a partir do
-- estado já confirmado no banco.
CREATE OR REPLACE FUNCTION public.run_monthly_teacher_closing(
  p_month text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_month text;
  v_created integer := 0;
  v_updated integer := 0;
  v_carried integer := 0;
  v_inserted integer := 0;
  v_updated_ids uuid[] := '{}';
  v_refresh jsonb;
  v_state text;
  v_teacher record;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  v_month := coalesce(
    p_month,
    to_char(current_date - interval '1 month', 'YYYY-MM')
  );
  IF v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_month';
  END IF;

  FOR v_teacher IN
    SELECT teacher.id AS teacher_id, teacher.tenant_id
      FROM public.profiles AS teacher
     WHERE teacher.role = 'TEACHER'
       AND teacher.tenant_id IS NOT NULL
       AND lower(coalesce(teacher.lifecycle_status, 'active'))
             NOT IN ('suspended', 'offboarded')
       AND EXISTS (
         SELECT 1
           FROM public.tenant_memberships AS membership
          WHERE membership.user_id = teacher.id
            AND membership.tenant_id = teacher.tenant_id
            AND membership.role = 'TEACHER'
            AND membership.status = 'ACTIVE'
       )
       AND (
         EXISTS (
           SELECT 1 FROM public.class_logs AS class_log
            WHERE class_log.tenant_id = teacher.tenant_id
              AND class_log.teacher_id = teacher.id
              AND to_char(class_log.class_date, 'YYYY-MM') = v_month
         ) OR EXISTS (
           SELECT 1 FROM public.teacher_closings AS closing
            WHERE closing.tenant_id = teacher.tenant_id
              AND closing.teacher_id = teacher.id
              AND closing.month_year = v_month
              AND closing.status = 'PENDENTE'
         ) OR EXISTS (
           SELECT 1 FROM public.closing_adjustments AS adjustment
            WHERE adjustment.tenant_id = teacher.tenant_id
              AND adjustment.teacher_id = teacher.id
              AND adjustment.month_year = v_month
         ) OR EXISTS (
           SELECT 1
             FROM private.teacher_pending_carryover_in_tenant(
               teacher.tenant_id,
               teacher.id
             )
         )
       )
     ORDER BY teacher.tenant_id, teacher.id
  LOOP
    PERFORM private.lock_teacher_closing_pair(
      v_teacher.tenant_id,
      v_month,
      v_teacher.teacher_id,
      NULL
    );

    INSERT INTO public.closing_carryovers (
      class_log_id, teacher_id, origin_month, absorbed_month, amount
    )
    SELECT carryover.class_log_id,
           v_teacher.teacher_id,
           carryover.origin_month,
           v_month,
           carryover.amount
      FROM private.teacher_pending_carryover_in_tenant(
        v_teacher.tenant_id,
        v_teacher.teacher_id
      ) AS carryover
    ON CONFLICT (class_log_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_carried := v_carried + v_inserted;

    v_refresh := private.refresh_teacher_closing_snapshot(
      v_teacher.tenant_id,
      v_teacher.teacher_id,
      v_month,
      true
    );
    v_state := coalesce(v_refresh ->> 'state', '');
    IF v_state = 'created' THEN
      v_created := v_created + 1;
    ELSIF v_state = 'updated' THEN
      v_updated := v_updated + 1;
      v_updated_ids := v_updated_ids || v_teacher.teacher_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'month', v_month,
    'created', v_created,
    'updated', v_updated,
    'carried_over', v_carried,
    'updated_teacher_ids', to_jsonb(v_updated_ids)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.run_monthly_teacher_closing(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_monthly_teacher_closing(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.gestao_lanca_ajuste_idempotente(
  p_tenant text,
  p_request_id text,
  p_actor_id uuid,
  p_teacher_id uuid,
  p_month text,
  p_descricao text,
  p_valor numeric,
  p_pedido_por text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_existing public.closing_adjustments%ROWTYPE;
  v_id uuid;
  v_sync boolean := false;
  v_refresh jsonb;
  v_actor_role text;
  v_actor_profile_role text;
  v_teto numeric := 500;
  v_request_id text := left(btrim(coalesce(p_request_id, '')), 200);
  v_closing_status text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_tenant IS NULL OR p_actor_id IS NULL OR p_teacher_id IS NULL
     OR length(v_request_id) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  END IF;

  SELECT membership.role, actor.role
    INTO v_actor_role, v_actor_profile_role
    FROM public.tenant_memberships AS membership
    JOIN public.profiles AS actor ON actor.id = membership.user_id
   WHERE membership.user_id = p_actor_id
     AND membership.tenant_id = p_tenant
     AND membership.status = 'ACTIVE'
     AND membership.role IN ('SCHOOL_ADMIN', 'COORDINATOR')
     AND lower(coalesce(actor.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
   LIMIT 1;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role = 'SCHOOL_ADMIN' OR v_actor_profile_role = 'SUPER_ADMIN'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'actor_not_allowed';
  END IF;

  IF p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mes_invalido');
  END IF;
  IF p_valor IS NULL OR p_valor = 0 OR p_valor = 'NaN'::numeric THEN
    RETURN jsonb_build_object('ok', false, 'error', 'valor_invalido');
  END IF;
  IF abs(p_valor) > v_teto THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'acima_do_teto', 'teto', v_teto
    );
  END IF;
  IF length(btrim(coalesce(p_descricao, ''))) NOT BETWEEN 3 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'motivo_invalido');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS teacher
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = teacher.id
       AND membership.tenant_id = p_tenant
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE teacher.id = p_teacher_id
       AND teacher.role = 'TEACHER'
       AND lower(coalesce(teacher.lifecycle_status, '')) = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'professor_invalido');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'management-adjustment:' || p_tenant || ':' || v_request_id,
      0
    )
  );
  PERFORM private.lock_teacher_closing_pair(
    p_tenant,
    p_month,
    p_teacher_id,
    NULL
  );
  SELECT adjustment.*
    INTO v_existing
    FROM public.closing_adjustments AS adjustment
   WHERE adjustment.tenant_id = p_tenant
     AND adjustment.request_id = v_request_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.teacher_id IS DISTINCT FROM p_teacher_id
       OR v_existing.month_year IS DISTINCT FROM p_month
       OR v_existing.amount IS DISTINCT FROM p_valor THEN
      RETURN jsonb_build_object('ok', false, 'error', 'request_id_em_conflito');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'id', v_existing.id,
      'idempotent', true,
      'repasse_atualizado', v_existing.closing_synced
    );
  END IF;

  SELECT closing.status
    INTO v_closing_status
    FROM public.teacher_closings AS closing
   WHERE closing.tenant_id = p_tenant
     AND closing.teacher_id = p_teacher_id
     AND closing.month_year = p_month
   ORDER BY closing.created_at
   LIMIT 1
   FOR UPDATE;
  IF v_closing_status IS NOT NULL AND v_closing_status <> 'PENDENTE' THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'fechamento_nao_pendente'
    );
  END IF;

  INSERT INTO public.closing_adjustments (
    tenant_id, teacher_id, month_year, description, amount, created_by,
    request_id, closing_synced
  ) VALUES (
    p_tenant,
    p_teacher_id,
    p_month,
    btrim(p_descricao) || ' [via WhatsApp: ' ||
      left(btrim(coalesce(p_pedido_por, 'gestor')), 80) || ']',
    p_valor,
    p_actor_id,
    v_request_id,
    false
  )
  RETURNING id INTO v_id;

  v_refresh := private.refresh_teacher_closing_snapshot(
    p_tenant,
    p_teacher_id,
    p_month,
    false
  );
  v_sync := coalesce((v_refresh ->> 'synced')::boolean, false);

  UPDATE public.closing_adjustments
     SET closing_synced = v_sync
   WHERE id = v_id;

  INSERT INTO public.audit_logs (
    tenant_id, user_id, user_role, action, resource_type, resource_id,
    new_values
  ) VALUES (
    p_tenant, p_actor_id, v_actor_role,
    'teacher_payout_adjusted_via_management_group', 'closing_adjustment',
    v_id::text,
    jsonb_build_object(
      'teacher_id', p_teacher_id,
      'month', p_month,
      'amount', p_valor,
      'request_id', v_request_id,
      'closing_synced', v_sync
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_id,
    'idempotent', false,
    'repasse_atualizado', v_sync
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.gestao_lanca_ajuste_idempotente(
  text, text, uuid, uuid, text, text, numeric, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestao_lanca_ajuste_idempotente(
  text, text, uuid, uuid, text, text, numeric, text
) TO service_role;

REVOKE ALL ON FUNCTION public.gestao_lanca_ajuste(
  text, uuid, text, text, numeric, text
) FROM PUBLIC, anon, authenticated, service_role;

-- Resolvedores do agente usam membership como autoridade de tenant. O
-- profiles.tenant_id e apenas o tenant primario legado e esconderia pessoas
-- validamente vinculadas a uma segunda escola.
CREATE OR REPLACE FUNCTION public.gestao_resolve_professor(
  p_tenant text,
  p_nome text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_termo text := public.fold_accents(btrim(coalesce(p_nome, '')));
  v_count integer;
  v_id uuid;
  v_nome text;
  v_candidates jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF length(v_termo) NOT BETWEEN 2 AND 100 THEN
    RETURN jsonb_build_object('error', 'nome_vazio');
  END IF;

  SELECT count(*), min(profile.full_name),
         jsonb_agg(btrim(profile.full_name) ORDER BY profile.full_name)
    INTO v_count, v_nome, v_candidates
    FROM public.profiles AS profile
    JOIN public.tenant_memberships AS membership
      ON membership.user_id = profile.id
     AND membership.tenant_id = p_tenant
     AND membership.role = 'TEACHER'
     AND membership.status = 'ACTIVE'
   WHERE profile.role = 'TEACHER'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND strpos(public.fold_accents(profile.full_name), v_termo) > 0;
  IF v_count = 0 THEN
    RETURN jsonb_build_object('error', 'professor_nao_encontrado');
  END IF;
  IF v_count > 1 THEN
    RETURN jsonb_build_object(
      'error', 'nome_ambiguo', 'candidatos', v_candidates
    );
  END IF;

  SELECT profile.id, btrim(profile.full_name)
    INTO v_id, v_nome
    FROM public.profiles AS profile
    JOIN public.tenant_memberships AS membership
      ON membership.user_id = profile.id
     AND membership.tenant_id = p_tenant
     AND membership.role = 'TEACHER'
     AND membership.status = 'ACTIVE'
   WHERE profile.role = 'TEACHER'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND strpos(public.fold_accents(profile.full_name), v_termo) > 0
   LIMIT 1;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'nome', v_nome);
END;
$function$;

CREATE OR REPLACE FUNCTION public.gestao_resolve_aluno(
  p_tenant text,
  p_nome text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_termo text := public.fold_accents(btrim(coalesce(p_nome, '')));
  v_count integer;
  v_id uuid;
  v_nome text;
  v_candidates jsonb;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF length(v_termo) NOT BETWEEN 2 AND 100 THEN
    RETURN jsonb_build_object('error', 'nome_vazio');
  END IF;

  SELECT count(*), min(profile.full_name),
         jsonb_agg(btrim(profile.full_name) ORDER BY profile.full_name)
    INTO v_count, v_nome, v_candidates
    FROM public.profiles AS profile
    JOIN public.tenant_memberships AS membership
      ON membership.user_id = profile.id
     AND membership.tenant_id = p_tenant
     AND membership.role = 'STUDENT'
     AND membership.status = 'ACTIVE'
   WHERE profile.role = 'STUDENT'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND strpos(public.fold_accents(profile.full_name), v_termo) > 0;
  IF v_count = 0 THEN
    RETURN jsonb_build_object('error', 'aluno_nao_encontrado');
  END IF;
  IF v_count > 1 THEN
    RETURN jsonb_build_object(
      'error', 'aluno_ambiguo', 'candidatos', v_candidates
    );
  END IF;

  SELECT profile.id, btrim(profile.full_name)
    INTO v_id, v_nome
    FROM public.profiles AS profile
    JOIN public.tenant_memberships AS membership
      ON membership.user_id = profile.id
     AND membership.tenant_id = p_tenant
     AND membership.role = 'STUDENT'
     AND membership.status = 'ACTIVE'
   WHERE profile.role = 'STUDENT'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND strpos(public.fold_accents(profile.full_name), v_termo) > 0
   LIMIT 1;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'nome', v_nome);
END;
$function$;

REVOKE ALL ON FUNCTION public.gestao_resolve_professor(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestao_resolve_professor(text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.gestao_resolve_aluno(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestao_resolve_aluno(text, text)
  TO service_role;

-- Todos os escritores de bookings (tela, transferencia, agente e jobs) passam
-- por este trigger. O lock canonico fecha a corrida com o aceite de cobertura,
-- mesmo quando cada fluxo usa uma RPC diferente.
CREATE OR REPLACE FUNCTION public.normalize_booking_occurrence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_day text;
  v_time text;
BEGIN
  v_day := public.canonical_weekday_name(NEW.day_of_week);
  IF v_day IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'invalid_booking_weekday';
  END IF;

  v_time := pg_catalog.btrim(NEW.time_slot);
  IF v_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'invalid_booking_time';
  END IF;

  NEW.day_of_week := v_day;
  NEW.time_slot := pg_catalog.to_char(v_time::time, 'HH24:MI');

  IF NEW.teacher_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'schedule:teacher:' || NEW.teacher_id::text || ':' ||
        public.fold_accents(v_day) || ':' || NEW.time_slot,
        0
      )
    );
  END IF;
  IF NEW.student_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'schedule:student:' || NEW.student_id::text || ':' ||
        public.fold_accents(v_day) || ':' || NEW.time_slot,
        0
      )
    );
  END IF;
  IF upper(coalesce(NEW.status, 'SCHEDULED')) = 'SCHEDULED'
     AND NEW.teacher_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.class_coverages AS coverage
        WHERE coverage.tenant_id = NEW.tenant_id
          AND coverage.cover_teacher_id = NEW.teacher_id
          AND (
            coverage.class_date::text || ' ' ||
            left(coverage.class_time, 5) || ':00-03'
          )::timestamptz > now()
          AND (
            lower(coverage.status) = 'confirmed'
            OR (
              lower(coverage.status) = 'pending'
              AND now() < coalesce(
                coverage.invite_expires_at,
                (
                  coverage.class_date::text || ' ' ||
                  left(coverage.class_time, 5) || ':00-03'
                )::timestamptz
              )
            )
          )
          AND left(coverage.class_time, 5) = NEW.time_slot
          AND (
            (NEW.date IS NOT NULL AND coverage.class_date = NEW.date)
            OR (
              NEW.date IS NULL
              AND public.dow_name_to_int(v_day) =
                  extract(dow FROM coverage.class_date)::integer
              AND (NEW.start_date IS NULL OR coverage.class_date >= NEW.start_date)
            )
          )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01',
      MESSAGE = 'booking_conflicts_with_active_coverage';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_normalize_booking_occurrence ON public.bookings;
CREATE TRIGGER trg_normalize_booking_occurrence
BEFORE INSERT OR UPDATE OF
  tenant_id, teacher_id, student_id, day_of_week, time_slot,
  date, start_date, status
ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.normalize_booking_occurrence();

CREATE OR REPLACE FUNCTION public.protect_booking_source_coverage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
    OR NEW.student_id IS DISTINCT FROM OLD.student_id
    OR NEW.day_of_week IS DISTINCT FROM OLD.day_of_week
    OR NEW.time_slot IS DISTINCT FROM OLD.time_slot
    OR NEW.date IS DISTINCT FROM OLD.date
    OR NEW.start_date IS DISTINCT FROM OLD.start_date
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
     FROM public.class_coverages AS coverage
     WHERE coverage.booking_id = OLD.id
       AND coverage.tenant_id = OLD.tenant_id
       AND (
         (
           pg_catalog.lower(coverage.status) = 'confirmed'
           AND coverage.class_log_id IS NULL
         )
         OR (
           pg_catalog.lower(coverage.status) = 'pending'
           AND pg_catalog.now() < coalesce(
             coverage.invite_expires_at,
             (
               coverage.class_date::text || ' ' ||
               pg_catalog.left(coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01', MESSAGE = 'booking_has_active_coverage';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_00_protect_booking_source_coverage_update
  ON public.bookings;
CREATE TRIGGER trg_00_protect_booking_source_coverage_update
BEFORE UPDATE OF
  tenant_id, teacher_id, student_id, day_of_week, time_slot,
  date, start_date, status
ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.protect_booking_source_coverage();

DROP TRIGGER IF EXISTS trg_00_protect_booking_source_coverage_delete
  ON public.bookings;
CREATE TRIGGER trg_00_protect_booking_source_coverage_delete
BEFORE DELETE ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.protect_booking_source_coverage();

REVOKE ALL ON FUNCTION public.protect_booking_source_coverage()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.protect_reschedule_coverage_slot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_date date;
  v_time text;
  v_day text;
BEGIN
  IF NEW.teacher_id IS NULL OR NEW.tenant_id IS NULL OR NEW.used_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  v_date := public.parse_lesson_date(NEW.date);
  v_time := pg_catalog.left(pg_catalog.btrim(NEW.time::text), 5);
  IF v_date IS NULL
     OR v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$' THEN
    RETURN NEW;
  END IF;
  v_day := CASE extract(dow FROM v_date)::integer
    WHEN 0 THEN 'Domingo' WHEN 1 THEN 'Segunda' WHEN 2 THEN 'Terça'
    WHEN 3 THEN 'Quarta' WHEN 4 THEN 'Quinta' WHEN 5 THEN 'Sexta'
    WHEN 6 THEN 'Sábado'
  END;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'schedule:teacher:' || NEW.teacher_id::text || ':' ||
      public.fold_accents(v_day) || ':' || v_time,
      0
    )
  );

  IF EXISTS (
    SELECT 1
      FROM public.class_coverages AS coverage
     WHERE coverage.tenant_id = NEW.tenant_id
       AND coverage.cover_teacher_id = NEW.teacher_id
       AND coverage.class_date = v_date
       AND pg_catalog.left(coverage.class_time, 5) = v_time
       AND (
         coverage.class_date::text || ' ' ||
         pg_catalog.left(coverage.class_time, 5) || ':00-03'
       )::timestamptz > pg_catalog.now()
       AND (
         pg_catalog.lower(coverage.status) = 'confirmed'
         OR (
           pg_catalog.lower(coverage.status) = 'pending'
           AND pg_catalog.now() < coalesce(
             coverage.invite_expires_at,
             (
               coverage.class_date::text || ' ' ||
               pg_catalog.left(coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01', MESSAGE = 'reschedule_conflicts_with_active_coverage';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_reschedule_coverage_slot
  ON public.reschedules;
CREATE TRIGGER trg_protect_reschedule_coverage_slot
BEFORE INSERT OR UPDATE OF tenant_id, teacher_id, date, time, used_at
ON public.reschedules
FOR EACH ROW EXECUTE FUNCTION public.protect_reschedule_coverage_slot();

REVOKE ALL ON FUNCTION public.protect_reschedule_coverage_slot()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.protect_appointment_coverage_slot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_local_start timestamp;
  v_floor_slot timestamp;
  v_lock record;
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.start_time IS NULL
     OR pg_catalog.lower(coalesce(NEW.status, ''))
          NOT IN ('scheduled', 'confirmed') THEN
    RETURN NEW;
  END IF;

  v_local_start := NEW.start_time AT TIME ZONE 'America/Sao_Paulo';
  v_floor_slot := pg_catalog.date_trunc('hour', v_local_start) +
    (pg_catalog.floor(extract(minute FROM v_local_start) / 30) * 30) *
      interval '1 minute';

  FOR v_lock IN
    SELECT DISTINCT teacher_id, slot
      FROM unnest(ARRAY[NEW.teacher_id, NEW.professor_id]) AS teacher(teacher_id)
      CROSS JOIN unnest(ARRAY[v_floor_slot, v_floor_slot + interval '30 minutes'])
        AS candidate(slot)
     WHERE teacher_id IS NOT NULL
     ORDER BY teacher_id, slot
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'schedule:teacher:' || v_lock.teacher_id::text || ':' ||
        public.fold_accents(CASE extract(dow FROM v_lock.slot)::integer
          WHEN 0 THEN 'Domingo' WHEN 1 THEN 'Segunda' WHEN 2 THEN 'Terça'
          WHEN 3 THEN 'Quarta' WHEN 4 THEN 'Quinta' WHEN 5 THEN 'Sexta'
          WHEN 6 THEN 'Sábado'
        END) || ':' || pg_catalog.to_char(v_lock.slot, 'HH24:MI'),
        0
      )
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM public.class_coverages AS coverage
     WHERE coverage.tenant_id = NEW.tenant_id
       AND coverage.cover_teacher_id IN (NEW.teacher_id, NEW.professor_id)
       AND pg_catalog.lower(coverage.status) IN ('pending', 'confirmed')
       AND (
         coverage.class_date::text || ' ' ||
         pg_catalog.left(coverage.class_time, 5) || ':00-03'
       )::timestamptz > pg_catalog.now()
       AND (
         pg_catalog.lower(coverage.status) = 'confirmed'
         OR pg_catalog.now() < coalesce(
           coverage.invite_expires_at,
           (
             coverage.class_date::text || ' ' ||
             pg_catalog.left(coverage.class_time, 5) || ':00-03'
           )::timestamptz
         )
       )
       AND pg_catalog.abs(extract(
             epoch FROM (
               NEW.start_time - (
                 coverage.class_date::text || ' ' ||
                 pg_catalog.left(coverage.class_time, 5) || ':00-03'
               )::timestamptz
             )
           )) < 1800
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01', MESSAGE = 'appointment_conflicts_with_active_coverage';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_appointment_coverage_slot
  ON public.appointments;
CREATE TRIGGER trg_protect_appointment_coverage_slot
BEFORE INSERT OR UPDATE OF
  tenant_id, teacher_id, professor_id, start_time, status
ON public.appointments
FOR EACH ROW EXECUTE FUNCTION public.protect_appointment_coverage_slot();

REVOKE ALL ON FUNCTION public.protect_appointment_coverage_slot()
  FROM PUBLIC, anon, authenticated;

-- Variante service-only do executor de agenda usada pelo grupo. Mantem as
-- mesmas garantias da RPC da tela, acrescentando ator explicito e vínculo
-- aluno/booking para que IDs produzidos pelo modelo nunca sejam confiados.
CREATE OR REPLACE FUNCTION public.gestao_change_booking_schedule(
  p_tenant text,
  p_actor_id uuid,
  p_booking_id uuid,
  p_expected_student_id uuid,
  p_day_of_week text,
  p_time_slot text,
  p_group_jid text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_actor_role text;
  v_actor_name text;
  v_teacher_name text;
  v_student_name text;
  v_day text;
  v_day_number integer;
  v_time text;
  v_notification_id uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF p_tenant IS NULL OR p_actor_id IS NULL OR p_booking_id IS NULL
     OR p_expected_student_id IS NULL
     OR coalesce(length(btrim(p_request_id)), 0) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  END IF;

  SELECT membership.role, actor.full_name
    INTO v_actor_role, v_actor_name
    FROM public.tenant_memberships AS membership
    JOIN public.profiles AS actor ON actor.id = membership.user_id
   WHERE membership.user_id = p_actor_id
     AND membership.tenant_id = p_tenant
     AND membership.status = 'ACTIVE'
     AND membership.role IN ('SCHOOL_ADMIN', 'COORDINATOR')
     AND lower(coalesce(actor.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
   LIMIT 1;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'actor_not_allowed';
  END IF;

  SELECT booking.*
    INTO v_booking
    FROM public.bookings AS booking
   WHERE booking.id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND OR v_booking.tenant_id IS DISTINCT FROM p_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_nao_encontrada');
  END IF;
  IF v_booking.student_id IS DISTINCT FROM p_expected_student_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_nao_pertence_ao_aluno');
  END IF;
  IF upper(coalesce(v_booking.status, '')) <> 'SCHEDULED' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_nao_ativa');
  END IF;
  IF v_booking.date IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'ocorrencia_pontual_exige_remarcacao_por_data'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS teacher
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = teacher.id
       AND membership.tenant_id = p_tenant
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE teacher.id = v_booking.teacher_id
       AND teacher.role = 'TEACHER'
       AND lower(coalesce(teacher.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.profiles AS student
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = student.id
       AND membership.tenant_id = p_tenant
       AND membership.role = 'STUDENT'
       AND membership.status = 'ACTIVE'
     WHERE student.id = v_booking.student_id
       AND student.role = 'STUDENT'
       AND lower(coalesce(student.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vinculos_da_aula_invalidos');
  END IF;

  v_day := CASE public.fold_accents(btrim(coalesce(p_day_of_week, '')))
    WHEN 'domingo' THEN 'Domingo'
    WHEN 'segunda' THEN 'Segunda'
    WHEN 'terca' THEN 'Terça'
    WHEN 'quarta' THEN 'Quarta'
    WHEN 'quinta' THEN 'Quinta'
    WHEN 'sexta' THEN 'Sexta'
    WHEN 'sabado' THEN 'Sábado'
    ELSE NULL
  END;
  v_day_number := CASE v_day
    WHEN 'Domingo' THEN 0 WHEN 'Segunda' THEN 1 WHEN 'Terça' THEN 2
    WHEN 'Quarta' THEN 3 WHEN 'Quinta' THEN 4 WHEN 'Sexta' THEN 5
    WHEN 'Sábado' THEN 6 ELSE NULL
  END;
  v_time := left(btrim(coalesce(p_time_slot, '')), 5);
  IF v_day IS NULL OR v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'novo_horario_invalido');
  END IF;

  IF public.fold_accents(v_booking.day_of_week) = public.fold_accents(v_day)
     AND left(v_booking.time_slot, 5) = v_time THEN
    RETURN jsonb_build_object(
      'ok', true, 'changed', false, 'booking_id', v_booking.id,
      'day_of_week', v_day, 'time_slot', v_time
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'schedule:teacher:' || v_booking.teacher_id::text || ':' ||
      public.fold_accents(v_day) || ':' || v_time,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'schedule:student:' || v_booking.student_id::text || ':' ||
      public.fold_accents(v_day) || ':' || v_time,
      0
    )
  );

  IF NOT EXISTS (
    SELECT 1
      FROM public.teacher_availability AS availability
     WHERE availability.tenant_id = p_tenant
       AND availability.teacher_id = v_booking.teacher_id
       AND availability.day_of_week = v_day_number
       AND (
         availability.start_time = v_time::time
         OR (
           availability.end_time IS NOT NULL
           AND availability.start_time <= v_time::time
           AND availability.end_time > v_time::time
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'professor_sem_disponibilidade');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.bookings AS conflict
     WHERE conflict.id <> v_booking.id
       AND conflict.tenant_id = p_tenant
       AND conflict.teacher_id = v_booking.teacher_id
       AND upper(coalesce(conflict.status, '')) = 'SCHEDULED'
       AND public.fold_accents(conflict.day_of_week) = public.fold_accents(v_day)
       AND left(conflict.time_slot, 5) = v_time
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflito_professor');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.bookings AS conflict
     WHERE conflict.id <> v_booking.id
       AND conflict.tenant_id = p_tenant
       AND conflict.student_id = v_booking.student_id
       AND upper(coalesce(conflict.status, '')) = 'SCHEDULED'
       AND public.fold_accents(conflict.day_of_week) = public.fold_accents(v_day)
       AND left(conflict.time_slot, 5) = v_time
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflito_aluno');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.class_coverages AS coverage
     WHERE coverage.tenant_id = p_tenant
       AND coverage.cover_teacher_id = v_booking.teacher_id
       AND left(coverage.class_time, 5) = v_time
       AND extract(dow FROM coverage.class_date)::integer = v_day_number
       AND (
         coverage.class_date::text || ' ' ||
         left(coverage.class_time, 5) || ':00-03'
       )::timestamptz > now()
       AND (
         v_booking.start_date IS NULL
         OR coverage.class_date >= v_booking.start_date
       )
       AND (
         lower(coverage.status) = 'confirmed'
         OR (
           lower(coverage.status) = 'pending'
           AND now() < coalesce(
             coverage.invite_expires_at,
             (
               coverage.class_date::text || ' ' ||
               left(coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflito_cobertura_ativa');
  END IF;

  SELECT profile.full_name INTO v_teacher_name
    FROM public.profiles AS profile
   WHERE profile.id = v_booking.teacher_id;
  SELECT profile.full_name INTO v_student_name
    FROM public.profiles AS profile
   WHERE profile.id = v_booking.student_id;
  IF v_teacher_name IS NULL OR v_student_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vinculos_da_aula_invalidos');
  END IF;

  UPDATE public.bookings
     SET day_of_week = v_day,
         time_slot = v_time
   WHERE id = v_booking.id
     AND tenant_id = p_tenant
     AND student_id = p_expected_student_id;

  INSERT INTO public.audit_logs (
    tenant_id, user_id, user_role, action, resource_type, resource_id,
    old_values, new_values, diff
  ) VALUES (
    p_tenant, p_actor_id, v_actor_role,
    'booking_schedule_changed_via_management_group', 'booking',
    v_booking.id::text,
    jsonb_build_object(
      'day_of_week', v_booking.day_of_week,
      'time_slot', left(v_booking.time_slot, 5),
      'teacher_id', v_booking.teacher_id,
      'student_id', v_booking.student_id
    ),
    jsonb_build_object(
      'day_of_week', v_day,
      'time_slot', v_time,
      'teacher_id', v_booking.teacher_id,
      'student_id', v_booking.student_id,
      'request_id', left(btrim(p_request_id), 200)
    ),
    jsonb_build_object(
      'day_of_week', jsonb_build_array(v_booking.day_of_week, v_day),
      'time_slot', jsonb_build_array(left(v_booking.time_slot, 5), v_time)
    )
  );

  IF coalesce(p_group_jid, '') ~ '^[0-9]{8,25}@g[.]us$' THEN
    INSERT INTO public.notification_queue (
      tenant_id, teacher_id, student_id, student_name, student_phone,
      message_body, scheduled_for, status, source_id, source_type,
      notification_kind
    ) VALUES (
      p_tenant, v_booking.teacher_id, v_booking.student_id, v_student_name,
      p_group_jid,
      format(
        E'🔄 *ALTERAÇÃO DE AULA*\n\n👨‍🏫 Professor: *%s*\n👤 Aluno: *%s*\n\nAntes: %s às %s\nAgora: *%s às %s*\n\nAlterado por: %s',
        v_teacher_name, v_student_name, v_booking.day_of_week,
        left(v_booking.time_slot, 5), v_day, v_time,
        coalesce(v_actor_name, v_actor_role)
      ),
      now(), 'pending', v_booking.id, 'BOOKING_SCHEDULE',
      'SCHEDULE_CHANGE_GROUP'
    )
    RETURNING id INTO v_notification_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'changed', true,
    'booking_id', v_booking.id,
    'old_day', v_booking.day_of_week,
    'old_time', left(v_booking.time_slot, 5),
    'day_of_week', v_day,
    'time_slot', v_time,
    'notification_queued', v_notification_id IS NOT NULL
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.gestao_change_booking_schedule(
  text, uuid, uuid, uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestao_change_booking_schedule(
  text, uuid, uuid, uuid, text, text, text, text
) TO service_role;

-- Executor canonico da cobertura pedida no grupo. Toda validacao sensivel e o
-- INSERT ficam na mesma transacao, com locks por aula/data para fechar corridas.
-- O token volta somente para a Edge Function service-role que enviara o convite.
CREATE OR REPLACE FUNCTION public.gestao_create_coverage_invite(
  p_tenant text,
  p_actor_id uuid,
  p_booking_id uuid,
  p_cover_teacher_id uuid,
  p_class_date date,
  p_class_time text,
  p_reason text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_absence public.teacher_absences%ROWTYPE;
  v_coverage public.class_coverages%ROWTYPE;
  v_time text;
  v_day_number integer;
  v_day_name text;
  v_actor_role text;
  v_original_name text;
  v_cover_name text;
  v_cover_phone text;
  v_student_name text;
  v_token text;
  v_class_start timestamptz;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;

  IF p_tenant IS NULL OR p_actor_id IS NULL OR p_booking_id IS NULL
     OR p_cover_teacher_id IS NULL OR p_class_date IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  END IF;
  IF p_class_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
     OR p_class_date >
          (now() AT TIME ZONE 'America/Sao_Paulo')::date + 90 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'data_fora_da_janela');
  END IF;
  IF coalesce(length(btrim(p_reason)), 0) NOT BETWEEN 3 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'motivo_invalido');
  END IF;
  IF coalesce(length(btrim(p_request_id)), 0) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'request_id_invalido');
  END IF;
  v_time := left(btrim(coalesce(p_class_time, '')), 5);
  IF v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'horario_invalido');
  END IF;

  SELECT membership.role
    INTO v_actor_role
    FROM public.tenant_memberships AS membership
    JOIN public.profiles AS actor
      ON actor.id = membership.user_id
   WHERE membership.user_id = p_actor_id
     AND membership.tenant_id = p_tenant
     AND membership.status = 'ACTIVE'
     AND membership.role IN ('SCHOOL_ADMIN', 'COORDINATOR')
     AND lower(coalesce(actor.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
   LIMIT 1;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'actor_not_allowed';
  END IF;

  -- Idempotencia vem antes de criar qualquer artefato novo. A restricao UNIQUE
  -- continua como ultima barreira, mas o lock transforma chamadas simultaneas
  -- com a mesma chave em retry deterministico, sem erro 500 na perdedora.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage-request:' || p_tenant || ':' ||
      left(btrim(p_request_id), 200),
      0
    )
  );
  SELECT coverage.*
    INTO v_coverage
    FROM public.class_coverages AS coverage
   WHERE coverage.tenant_id = p_tenant
     AND coverage.request_id = left(btrim(p_request_id), 200)
   FOR UPDATE;
  IF FOUND THEN
    IF v_coverage.booking_id IS DISTINCT FROM p_booking_id
       OR v_coverage.cover_teacher_id IS DISTINCT FROM p_cover_teacher_id
       OR v_coverage.class_date IS DISTINCT FROM p_class_date
       OR left(coalesce(v_coverage.class_time, ''), 5) IS DISTINCT FROM v_time THEN
      RETURN jsonb_build_object(
        'ok', false, 'error', 'request_id_em_conflito'
      );
    END IF;
    IF lower(coalesce(v_coverage.status, '')) = 'pending'
       AND now() >= coalesce(
         v_coverage.invite_expires_at,
         (
           v_coverage.class_date::text || ' ' ||
           left(v_coverage.class_time, 5) || ':00-03'
         )::timestamptz
       ) THEN
      UPDATE public.class_coverages
         SET status = 'cancelled'
       WHERE id = v_coverage.id
         AND tenant_id = p_tenant
         AND lower(status) = 'pending';
      RETURN jsonb_build_object(
        'ok', true, 'idempotent', true,
        'coverage_id', v_coverage.id, 'status', 'cancelled'
      );
    END IF;
    SELECT profile.full_name
      INTO v_original_name
      FROM public.profiles AS profile
     WHERE profile.id = v_coverage.original_teacher_id;
    SELECT profile.full_name,
           CASE
             WHEN length(regexp_replace(
               coalesce(profile.attendance_phone, ''), '[^0-9]', '', 'g'
             )) BETWEEN 10 AND 15 THEN profile.attendance_phone
             WHEN length(regexp_replace(
               coalesce(profile.phone, ''), '[^0-9]', '', 'g'
             )) BETWEEN 10 AND 15 THEN profile.phone
             ELSE NULL
           END
      INTO v_cover_name, v_cover_phone
      FROM public.profiles AS profile
     WHERE profile.id = v_coverage.cover_teacher_id;
    SELECT profile.full_name
      INTO v_student_name
      FROM public.profiles AS profile
     WHERE profile.id = v_coverage.student_id;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'coverage_id', v_coverage.id,
      'status', v_coverage.status,
      'token', v_coverage.token,
      'dispatched_at', v_coverage.dispatched_at,
      'class_date', v_coverage.class_date,
      'class_time', v_coverage.class_time,
      'student_name', btrim(coalesce(v_student_name, 'Aluno')),
      'original_teacher_name', btrim(coalesce(v_original_name, 'Professor')),
      'cover_teacher_name', btrim(coalesce(v_cover_name, 'Professor')),
      'cover_teacher_phone', v_cover_phone
    );
  END IF;

  SELECT booking.*
    INTO v_booking
    FROM public.bookings AS booking
   WHERE booking.id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND OR v_booking.tenant_id IS DISTINCT FROM p_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_nao_encontrada');
  END IF;
  IF upper(coalesce(v_booking.status, '')) <> 'SCHEDULED' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_inativa');
  END IF;
  IF v_booking.teacher_id IS NULL OR v_booking.student_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_sem_vinculos');
  END IF;
  IF v_booking.teacher_id = p_cover_teacher_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mesmo_professor');
  END IF;

  IF left(coalesce(v_booking.time_slot, ''), 5) <> v_time THEN
    RETURN jsonb_build_object('ok', false, 'error', 'horario_nao_corresponde_aula');
  END IF;
  v_class_start := (
    p_class_date::text || ' ' || v_time || ':00-03'
  )::timestamptz;
  IF v_class_start <= now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_no_passado');
  END IF;

  v_day_number := extract(dow FROM p_class_date)::integer;
  v_day_name := CASE v_day_number
    WHEN 0 THEN 'Domingo' WHEN 1 THEN 'Segunda' WHEN 2 THEN 'Terca'
    WHEN 3 THEN 'Quarta' WHEN 4 THEN 'Quinta' WHEN 5 THEN 'Sexta'
    WHEN 6 THEN 'Sabado'
  END;
  IF v_booking.date IS NOT NULL THEN
    IF v_booking.date <> p_class_date THEN
      RETURN jsonb_build_object('ok', false, 'error', 'data_nao_corresponde_aula');
    END IF;
  ELSIF public.fold_accents(v_booking.day_of_week) <> lower(v_day_name) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'dia_nao_corresponde_aula');
  END IF;
  IF v_booking.date IS NULL
     AND v_booking.start_date IS NOT NULL
     AND p_class_date < v_booking.start_date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aula_antes_do_inicio');
  END IF;

  SELECT profile.full_name
    INTO v_original_name
   FROM public.profiles AS profile
   WHERE profile.id = v_booking.teacher_id
     AND profile.tenant_id = p_tenant
     AND profile.role = 'TEACHER'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND EXISTS (
       SELECT 1
         FROM public.tenant_memberships AS membership
        WHERE membership.user_id = profile.id
          AND membership.tenant_id = p_tenant
          AND membership.role = 'TEACHER'
          AND membership.status = 'ACTIVE'
     );
  IF v_original_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'professor_ausente_invalido');
  END IF;

  SELECT profile.full_name,
         CASE
           WHEN length(regexp_replace(
             coalesce(profile.attendance_phone, ''), '[^0-9]', '', 'g'
           )) BETWEEN 10 AND 15 THEN profile.attendance_phone
           WHEN length(regexp_replace(
             coalesce(profile.phone, ''), '[^0-9]', '', 'g'
           )) BETWEEN 10 AND 15 THEN profile.phone
           ELSE NULL
         END
    INTO v_cover_name, v_cover_phone
    FROM public.profiles AS profile
   WHERE profile.id = p_cover_teacher_id
     AND profile.tenant_id = p_tenant
     AND profile.role = 'TEACHER'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND EXISTS (
       SELECT 1
         FROM public.tenant_memberships AS membership
        WHERE membership.user_id = profile.id
          AND membership.tenant_id = p_tenant
          AND membership.role = 'TEACHER'
          AND membership.status = 'ACTIVE'
     );
  IF v_cover_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'substituto_invalido');
  END IF;
  IF EXISTS (
    SELECT membership.user_id
      FROM public.tenant_memberships AS membership
     WHERE membership.user_id IN (v_booking.teacher_id, p_cover_teacher_id)
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     GROUP BY membership.user_id
    HAVING count(DISTINCT membership.tenant_id) <> 1
  ) THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'cobertura_multiescola_nao_suportada'
    );
  END IF;
  IF NOT private.can_access_teacher_projection(v_booking.teacher_id, to_char(
       p_class_date, 'YYYY-MM'
     ))
     OR NOT private.can_access_teacher_projection(p_cover_teacher_id, to_char(
       p_class_date, 'YYYY-MM'
     )) THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'cobertura_multiescola_nao_suportada'
    );
  END IF;
  IF coalesce(regexp_replace(v_cover_phone, '[^0-9]', '', 'g'), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'substituto_sem_whatsapp');
  END IF;

  SELECT profile.full_name
    INTO v_student_name
    FROM public.profiles AS profile
   WHERE profile.id = v_booking.student_id
     AND profile.role = 'STUDENT'
     AND lower(coalesce(profile.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
     AND EXISTS (
       SELECT 1
         FROM public.tenant_memberships AS membership
        WHERE membership.user_id = profile.id
          AND membership.tenant_id = p_tenant
          AND membership.role = 'STUDENT'
          AND membership.status = 'ACTIVE'
     );
  IF v_student_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'aluno_invalido');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.teacher_availability AS availability
     WHERE availability.tenant_id = p_tenant
       AND availability.teacher_id = p_cover_teacher_id
       AND availability.day_of_week = v_day_number
       AND (
         availability.start_time = v_time::time
         OR (
           availability.end_time IS NOT NULL
           AND availability.start_time <= v_time::time
           AND availability.end_time > v_time::time
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'substituto_sem_disponibilidade');
  END IF;

  -- Um lock deterministico fecha a janela entre consultar conflitos e inserir.
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage:' || p_booking_id::text || ':' || p_class_date::text,
      0
    )
  );
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage-teacher:' || p_cover_teacher_id::text || ':' ||
      p_class_date::text || ':' || v_time,
      0
    )
  );
  PERFORM private.lock_coverage_absence_pair(
    v_booking.teacher_id,
    p_cover_teacher_id,
    p_class_date
  );

  IF EXISTS (
    SELECT 1
      FROM public.bookings AS conflict
     WHERE conflict.tenant_id = p_tenant
       AND conflict.teacher_id = p_cover_teacher_id
       AND upper(coalesce(conflict.status, '')) <> 'CANCELLED'
       AND left(coalesce(conflict.time_slot, ''), 5) = v_time
       AND (
         conflict.date = p_class_date
         OR (
           conflict.date IS NULL
           AND public.fold_accents(conflict.day_of_week) = lower(v_day_name)
           AND (
             conflict.start_date IS NULL
             OR conflict.start_date <= p_class_date
           )
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.reschedules AS reschedule
     WHERE reschedule.tenant_id = p_tenant
       AND reschedule.teacher_id = p_cover_teacher_id
       AND public.parse_lesson_date(reschedule.date) = p_class_date
       AND left(reschedule.time::text, 5) = v_time
       AND reschedule.used_at IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.appointments AS appointment
     WHERE appointment.tenant_id = p_tenant
       AND (
         appointment.teacher_id = p_cover_teacher_id
         OR appointment.professor_id = p_cover_teacher_id
       )
       AND lower(coalesce(appointment.status, '')) IN ('scheduled', 'confirmed')
       AND abs(extract(epoch FROM (appointment.start_time - v_class_start))) < 1800
  ) OR EXISTS (
    SELECT 1
      FROM public.teacher_absences AS substitute_absence
     WHERE substitute_absence.tenant_id = p_tenant
       AND substitute_absence.teacher_id = p_cover_teacher_id
       AND lower(coalesce(substitute_absence.status, '')) = 'active'
       AND substitute_absence.starts_at::date <= p_class_date
       AND substitute_absence.ends_at::date >= p_class_date
  ) OR EXISTS (
    SELECT 1
      FROM public.class_coverages AS teacher_coverage
     WHERE teacher_coverage.tenant_id = p_tenant
       AND teacher_coverage.cover_teacher_id = p_cover_teacher_id
       AND teacher_coverage.class_date = p_class_date
       AND left(teacher_coverage.class_time, 5) = v_time
       AND (
         lower(teacher_coverage.status) = 'confirmed'
         OR (
           lower(teacher_coverage.status) = 'pending'
           AND now() < coalesce(
             teacher_coverage.invite_expires_at,
             (
               teacher_coverage.class_date::text || ' ' ||
               left(teacher_coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'substituto_ocupado');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.class_coverages AS coverage
     WHERE coverage.tenant_id = p_tenant
       AND coverage.booking_id = p_booking_id
       AND coverage.class_date = p_class_date
       AND (
         lower(coverage.status) = 'confirmed'
         OR (
           lower(coverage.status) = 'pending'
           AND now() < coalesce(
             coverage.invite_expires_at,
             (
               coverage.class_date::text || ' ' ||
               left(coverage.class_time, 5) || ':00-03'
             )::timestamptz
           )
         )
       )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cobertura_ja_existente');
  END IF;

  SELECT absence.*
    INTO v_absence
    FROM public.teacher_absences AS absence
   WHERE absence.tenant_id = p_tenant
     AND absence.teacher_id = v_booking.teacher_id
     AND lower(absence.status) = 'active'
     AND absence.starts_at::date <= p_class_date
     AND absence.ends_at::date >= p_class_date
   ORDER BY absence.created_at
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.teacher_absences (
      tenant_id, teacher_id, starts_at, ends_at, reason, status
    ) VALUES (
      p_tenant, v_booking.teacher_id, p_class_date, p_class_date,
      btrim(p_reason), 'active'
    )
    RETURNING * INTO v_absence;
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.class_coverages (
    tenant_id, original_teacher_id, cover_teacher_id, student_id,
    booking_id, absence_id, class_date, class_time, status, token,
    notes, dispatched_at, request_id, invite_expires_at
  ) VALUES (
    p_tenant, v_booking.teacher_id, p_cover_teacher_id, v_booking.student_id,
    p_booking_id, v_absence.id, p_class_date, v_time, 'pending', v_token,
    btrim(p_reason), NULL, left(btrim(p_request_id), 200),
    least(v_class_start, now() + interval '48 hours')
  )
  RETURNING * INTO v_coverage;

  INSERT INTO public.audit_logs (
    tenant_id, user_id, user_role, action, resource_type, resource_id,
    new_values
  ) VALUES (
    p_tenant, p_actor_id, v_actor_role,
    'coverage_requested_via_management_group', 'class_coverage',
    v_coverage.id::text,
    jsonb_build_object(
      'booking_id', p_booking_id,
      'student_id', v_booking.student_id,
      'original_teacher_id', v_booking.teacher_id,
      'cover_teacher_id', p_cover_teacher_id,
      'class_date', p_class_date,
      'class_time', v_time,
      'request_id', left(btrim(p_request_id), 200)
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'coverage_id', v_coverage.id,
    'absence_id', v_absence.id,
    'status', v_coverage.status,
    'token', v_token,
    'class_date', p_class_date,
    'class_time', v_time,
    'student_name', btrim(v_student_name),
    'original_teacher_name', btrim(v_original_name),
    'cover_teacher_name', btrim(v_cover_name),
    'cover_teacher_phone', v_cover_phone
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.gestao_create_coverage_invite(
  text, uuid, uuid, uuid, date, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestao_create_coverage_invite(
  text, uuid, uuid, uuid, date, text, text, text
) TO service_role;

-- O executor legado procurava qualquer aula do mesmo aluno no mesmo dia e
-- podia mover o lancamento de outro horario. O casamento abaixo privilegia a
-- origem exata e exige tenant + data + horario; fallbacks legados so valem se
-- houver uma unica possibilidade.
CREATE OR REPLACE FUNCTION public.apply_coverage_acceptance(
  p_coverage_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_cov public.class_coverages%ROWTYPE;
  v_log public.class_logs%ROWTYPE;
  v_log_id uuid;
  v_match_kind text;
  v_match_count integer := 0;
  v_updated integer := 0;
  v_month text;
  v_time time;
  v_target_time time;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;

  SELECT coverage.*
    INTO v_cov
    FROM public.class_coverages AS coverage
   WHERE coverage.id = p_coverage_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'coverage_not_found';
  END IF;
  IF lower(coalesce(v_cov.status, '')) <> 'confirmed'
     OR v_cov.cover_teacher_id IS NULL
     OR v_cov.original_teacher_id IS NULL
     OR v_cov.booking_id IS NULL
     OR v_cov.class_date IS NULL
     OR coalesce(v_cov.class_time, '') !~
          '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'coverage_invalid';
  END IF;
  IF NOT private.can_access_teacher_projection(
       v_cov.original_teacher_id,
       to_char(v_cov.class_date, 'YYYY-MM')
     )
     OR NOT private.can_access_teacher_projection(
       v_cov.cover_teacher_id,
       to_char(v_cov.class_date, 'YYYY-MM')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'coverage_finance_scope_ambiguous';
  END IF;
  v_time := left(v_cov.class_time, 5)::time;
  v_month := to_char(v_cov.class_date, 'YYYY-MM');
  PERFORM private.lock_teacher_closing_pair(
    v_cov.tenant_id,
    v_month,
    v_cov.original_teacher_id,
    v_cov.cover_teacher_id
  );

  IF v_cov.class_log_id IS NOT NULL THEN
    SELECT class_log.*
      INTO v_log
      FROM public.class_logs AS class_log
     WHERE class_log.id = v_cov.class_log_id
     FOR UPDATE;
    IF FOUND
       AND v_log.tenant_id = v_cov.tenant_id
       AND v_log.teacher_id = v_cov.cover_teacher_id
       AND v_log.student_id IS NOT DISTINCT FROM v_cov.student_id
       AND v_log.class_date = v_cov.class_date
       AND (
         (
           coalesce(v_cov.class_log_match_kind, 'booking_time') =
             'booking_time'
           AND v_log.booking_id = v_cov.booking_id::text
           AND v_log.start_time = v_time
         ) OR (
           v_cov.class_log_match_kind = 'booking_no_time'
           AND v_log.booking_id = v_cov.booking_id::text
           AND v_log.start_time IS NULL
         ) OR (
           v_cov.class_log_match_kind = 'student_time'
           AND num_nonnulls(
             v_log.booking_id,
             v_log.reschedule_id,
             v_log.appointment_id
           ) = 0
           AND v_log.start_time = v_time
         ) OR (
           v_cov.class_log_match_kind = 'student_no_time'
           AND num_nonnulls(
             v_log.booking_id,
             v_log.reschedule_id,
             v_log.appointment_id
           ) = 0
           AND v_log.start_time IS NULL
         )
       ) THEN
      RETURN jsonb_build_object(
        'ok', true, 'already', true, 'modo', 'aula_movida',
        'class_log_id', v_cov.class_log_id
      );
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'coverage_log_inconsistent';
  END IF;

  -- 1. Origem e horario exatos.
  SELECT count(*), (array_agg(class_log.id ORDER BY class_log.id))[1]
    INTO v_match_count, v_log_id
    FROM public.class_logs AS class_log
   WHERE class_log.tenant_id = v_cov.tenant_id
     AND class_log.teacher_id = v_cov.original_teacher_id
     AND class_log.class_date = v_cov.class_date
     AND class_log.booking_id = v_cov.booking_id::text
     AND class_log.student_id IS NOT DISTINCT FROM v_cov.student_id
     AND class_log.start_time = v_time;
  IF v_match_count > 0 THEN
    v_match_kind := 'booking_time';
  END IF;

  -- 2. Mesmo booking legado, ainda sem snapshot de horario.
  IF v_match_count = 0 THEN
    SELECT count(*), (array_agg(class_log.id ORDER BY class_log.id))[1]
      INTO v_match_count, v_log_id
      FROM public.class_logs AS class_log
     WHERE class_log.tenant_id = v_cov.tenant_id
       AND class_log.teacher_id = v_cov.original_teacher_id
       AND class_log.class_date = v_cov.class_date
       AND class_log.booking_id = v_cov.booking_id::text
       AND class_log.student_id IS NOT DISTINCT FROM v_cov.student_id
       AND class_log.start_time IS NULL;
    IF v_match_count > 0 THEN
      v_match_kind := 'booking_no_time';
    END IF;
  END IF;

  IF v_match_count = 0 AND EXISTS (
    SELECT 1
      FROM public.class_logs AS class_log
     WHERE class_log.tenant_id = v_cov.tenant_id
       AND class_log.teacher_id = v_cov.original_teacher_id
       AND class_log.class_date = v_cov.class_date
       AND class_log.booking_id = v_cov.booking_id::text
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'coverage_class_log_time_mismatch';
  END IF;

  -- 3. Booking recriado: aluno/data/horario somente se a ocorrencia for unica.
  IF v_match_count = 0 AND v_cov.student_id IS NOT NULL THEN
    SELECT count(*), (array_agg(class_log.id ORDER BY class_log.id))[1]
      INTO v_match_count, v_log_id
      FROM public.class_logs AS class_log
     WHERE class_log.tenant_id = v_cov.tenant_id
       AND class_log.teacher_id = v_cov.original_teacher_id
       AND class_log.student_id = v_cov.student_id
       AND class_log.class_date = v_cov.class_date
       AND num_nonnulls(
         class_log.booking_id,
         class_log.reschedule_id,
         class_log.appointment_id
       ) = 0
       AND class_log.start_time = v_time;
    IF v_match_count > 0 THEN
      v_match_kind := 'student_time';
    END IF;
  END IF;

  -- 4. Ultimo fallback para historico sem horario, ainda assim univoco.
  IF v_match_count = 0 AND v_cov.student_id IS NOT NULL THEN
    SELECT count(*), (array_agg(class_log.id ORDER BY class_log.id))[1]
      INTO v_match_count, v_log_id
      FROM public.class_logs AS class_log
     WHERE class_log.tenant_id = v_cov.tenant_id
       AND class_log.teacher_id = v_cov.original_teacher_id
       AND class_log.student_id = v_cov.student_id
       AND class_log.class_date = v_cov.class_date
       AND num_nonnulls(
         class_log.booking_id,
         class_log.reschedule_id,
         class_log.appointment_id
       ) = 0
       AND class_log.start_time IS NULL;
    IF v_match_count > 0 THEN
      v_match_kind := 'student_no_time';
    END IF;
  END IF;

  IF v_match_count > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '21000', MESSAGE = 'coverage_class_log_ambiguous';
  END IF;

  IF v_match_count = 1 AND v_log_id IS NOT NULL THEN
    SELECT class_log.*
      INTO v_log
      FROM public.class_logs AS class_log
     WHERE class_log.id = v_log_id
     FOR UPDATE;
    IF NOT FOUND
       OR v_log.tenant_id IS DISTINCT FROM v_cov.tenant_id
       OR v_log.teacher_id IS DISTINCT FROM v_cov.original_teacher_id
       OR v_log.class_date IS DISTINCT FROM v_cov.class_date
       OR NOT (
         (
           v_match_kind = 'booking_time'
           AND v_log.booking_id = v_cov.booking_id::text
           AND v_log.student_id IS NOT DISTINCT FROM v_cov.student_id
           AND v_log.start_time = v_time
         ) OR (
           v_match_kind = 'booking_no_time'
           AND v_log.booking_id = v_cov.booking_id::text
           AND v_log.student_id IS NOT DISTINCT FROM v_cov.student_id
           AND v_log.start_time IS NULL
         ) OR (
           v_match_kind = 'student_time'
           AND v_log.student_id IS NOT DISTINCT FROM v_cov.student_id
           AND num_nonnulls(
             v_log.booking_id,
             v_log.reschedule_id,
             v_log.appointment_id
           ) = 0
           AND v_log.start_time = v_time
         ) OR (
           v_match_kind = 'student_no_time'
           AND v_log.student_id IS NOT DISTINCT FROM v_cov.student_id
           AND num_nonnulls(
             v_log.booking_id,
             v_log.reschedule_id,
             v_log.appointment_id
           ) = 0
           AND v_log.start_time IS NULL
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001', MESSAGE = 'coverage_class_log_changed';
    END IF;

    v_target_time := CASE
      WHEN v_match_kind IN ('booking_no_time', 'student_no_time') THEN NULL
      ELSE v_time
    END;
    IF EXISTS (
      SELECT 1
        FROM public.class_logs AS class_log
       WHERE class_log.id <> v_log_id
         AND class_log.tenant_id = v_cov.tenant_id
         AND class_log.teacher_id = v_cov.cover_teacher_id
         AND class_log.student_id IS NOT DISTINCT FROM v_cov.student_id
         AND class_log.class_date = v_cov.class_date
         AND class_log.start_time IS NOT DISTINCT FROM v_target_time
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505', MESSAGE = 'coverage_target_log_conflict';
    END IF;

    UPDATE public.class_logs
       SET teacher_id = v_cov.cover_teacher_id
     WHERE id = v_log_id
       AND tenant_id = v_cov.tenant_id
       AND teacher_id = v_cov.original_teacher_id
       AND class_date = v_cov.class_date
       AND (
         (
           v_match_kind = 'booking_time'
           AND booking_id = v_cov.booking_id::text
           AND student_id IS NOT DISTINCT FROM v_cov.student_id
           AND start_time = v_time
         ) OR (
           v_match_kind = 'booking_no_time'
           AND booking_id = v_cov.booking_id::text
           AND student_id IS NOT DISTINCT FROM v_cov.student_id
           AND start_time IS NULL
         ) OR (
           v_match_kind = 'student_time'
           AND student_id IS NOT DISTINCT FROM v_cov.student_id
           AND num_nonnulls(booking_id, reschedule_id, appointment_id) = 0
           AND start_time = v_time
         ) OR (
           v_match_kind = 'student_no_time'
           AND student_id IS NOT DISTINCT FROM v_cov.student_id
           AND num_nonnulls(booking_id, reschedule_id, appointment_id) = 0
           AND start_time IS NULL
         )
       );
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001', MESSAGE = 'coverage_class_log_changed';
    END IF;

    UPDATE public.class_coverages
       SET class_log_id = v_log_id,
           class_log_match_kind = v_match_kind,
           moved_at = now()
     WHERE id = v_cov.id
       AND tenant_id = v_cov.tenant_id
       AND lower(status) = 'confirmed';

    -- A mesma rotina canônica é usada por ajuste, cobertura e fechamento
    -- mensal; ela preserva ajustes/sobras e reseta a confirmação se o total muda.
    PERFORM private.refresh_teacher_closing_snapshot(
      v_cov.tenant_id,
      v_cov.original_teacher_id,
      v_month,
      false
    );
    PERFORM private.refresh_teacher_closing_snapshot(
      v_cov.tenant_id,
      v_cov.cover_teacher_id,
      v_month,
      false
    );

    RETURN jsonb_build_object(
      'ok', true, 'modo', 'aula_movida', 'class_log_id', v_log_id
    );
  END IF;

  -- Aula futura: a cobertura confirmada passa a ser a fonte do lancamento.
  RETURN jsonb_build_object(
    'ok', true,
    'modo', 'lancamento_redirecionado',
    'booking_id', v_cov.booking_id,
    'data', v_cov.class_date,
    'horario', left(v_cov.class_time, 5)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_coverage_acceptance(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_coverage_acceptance(uuid)
  TO service_role;

-- GET do link publico nunca muda estado. O POST chama esta funcao, que trava a
-- linha e confirma + redireciona pagamento na mesma transacao; se a aplicacao
-- financeira falhar, o status tambem volta para pending.
CREATE OR REPLACE FUNCTION public.resolve_coverage_invite(
  p_token text,
  p_accept boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_coverage public.class_coverages%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_apply jsonb;
  v_time text;
  v_day_number integer;
  v_day_name text;
  v_class_start timestamptz;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;
  IF coalesce(p_token, '') !~ '^[0-9a-fA-F]{32}$' OR p_accept IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token_invalido');
  END IF;

  SELECT coverage.*
    INTO v_coverage
    FROM public.class_coverages AS coverage
   WHERE coverage.token = lower(p_token);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrada');
  END IF;

  IF lower(v_coverage.status) = 'confirmed' THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true, 'status', 'confirmed',
      'class_date', v_coverage.class_date, 'class_time', v_coverage.class_time
    );
  END IF;
  IF lower(v_coverage.status) = 'declined' THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true, 'status', 'declined',
      'class_date', v_coverage.class_date, 'class_time', v_coverage.class_time
    );
  END IF;
  IF lower(v_coverage.status) <> 'pending' THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'indisponivel', 'status', v_coverage.status
    );
  END IF;
  IF now() >= coalesce(
    v_coverage.invite_expires_at,
    (
      v_coverage.class_date::text || ' ' ||
      left(v_coverage.class_time, 5) || ':00-03'
    )::timestamptz
  ) THEN
    UPDATE public.class_coverages
       SET status = 'cancelled'
     WHERE id = v_coverage.id AND lower(status) = 'pending'
     RETURNING * INTO v_coverage;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', false, 'error', 'expirado', 'status', 'cancelled'
      );
    END IF;
    SELECT coverage.* INTO v_coverage
      FROM public.class_coverages AS coverage
     WHERE coverage.token = lower(p_token);
    RETURN jsonb_build_object(
      'ok', lower(coalesce(v_coverage.status, '')) IN ('confirmed', 'declined'),
      'already', true, 'status', v_coverage.status,
      'class_date', v_coverage.class_date, 'class_time', v_coverage.class_time
    );
  END IF;

  IF NOT p_accept THEN
    UPDATE public.class_coverages
       SET status = 'declined', declined_at = now()
     WHERE id = v_coverage.id AND lower(status) = 'pending'
     RETURNING * INTO v_coverage;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true, 'status', 'declined',
        'class_date', v_coverage.class_date,
        'class_time', v_coverage.class_time
      );
    END IF;
    SELECT coverage.* INTO v_coverage
      FROM public.class_coverages AS coverage
     WHERE coverage.token = lower(p_token);
    RETURN jsonb_build_object(
      'ok', lower(coalesce(v_coverage.status, '')) IN ('confirmed', 'declined'),
      'already', true, 'status', v_coverage.status,
      'class_date', v_coverage.class_date, 'class_time', v_coverage.class_time
    );
  END IF;

  -- O convite e apenas uma proposta. Entre o envio e o clique, vinculos,
  -- disponibilidade e agenda podem mudar; tudo e revalidado sob lock.
  v_time := left(btrim(coalesce(v_coverage.class_time, '')), 5);
  IF v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' THEN
    UPDATE public.class_coverages
       SET status = 'cancelled'
     WHERE id = v_coverage.id AND lower(status) = 'pending';
    RETURN jsonb_build_object(
      'ok', false, 'error', 'convite_inconsistente', 'status', 'cancelled'
    );
  END IF;
  v_class_start := (
    v_coverage.class_date::text || ' ' || v_time || ':00-03'
  )::timestamptz;
  v_day_number := extract(dow FROM v_coverage.class_date)::integer;
  v_day_name := CASE v_day_number
    WHEN 0 THEN 'Domingo' WHEN 1 THEN 'Segunda' WHEN 2 THEN 'Terça'
    WHEN 3 THEN 'Quarta' WHEN 4 THEN 'Quinta' WHEN 5 THEN 'Sexta'
    WHEN 6 THEN 'Sábado'
  END;

  -- Mesma ordem global do trigger e da criacao: booking antes dos advisory
  -- locks. A segunda leitura abaixo faz a revalidacao completa.
  SELECT booking.*
    INTO v_booking
    FROM public.bookings AS booking
   WHERE booking.id = v_coverage.booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.class_coverages
       SET status = 'cancelled'
     WHERE id = v_coverage.id AND lower(status) = 'pending';
    RETURN jsonb_build_object(
      'ok', false, 'error', 'aula_nao_esta_mais_disponivel',
      'status', 'cancelled'
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage:' || v_coverage.booking_id::text || ':' ||
      v_coverage.class_date::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'coverage-teacher:' || v_coverage.cover_teacher_id::text || ':' ||
      v_coverage.class_date::text || ':' || v_time,
      0
    )
  );
  PERFORM private.lock_coverage_absence_pair(
    v_coverage.original_teacher_id,
    v_coverage.cover_teacher_id,
    v_coverage.class_date
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'schedule:teacher:' || v_coverage.cover_teacher_id::text || ':' ||
      public.fold_accents(v_day_name) || ':' || v_time,
      0
    )
  );

  -- A linha do convite vem depois dos locks compartilhados. Assim dois
  -- convites diferentes para o mesmo substituto/horario nao seguram a linha um
  -- do outro enquanto esperam o advisory, evitando um ciclo de deadlock.
  SELECT coverage.*
    INTO v_coverage
    FROM public.class_coverages AS coverage
   WHERE coverage.token = lower(p_token)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrada');
  END IF;
  IF lower(v_coverage.status) = 'confirmed' THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true, 'status', 'confirmed',
      'class_date', v_coverage.class_date, 'class_time', v_coverage.class_time
    );
  END IF;
  IF lower(v_coverage.status) = 'declined' THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true, 'status', 'declined',
      'class_date', v_coverage.class_date, 'class_time', v_coverage.class_time
    );
  END IF;
  IF lower(v_coverage.status) <> 'pending' THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'indisponivel', 'status', v_coverage.status
    );
  END IF;
  IF now() >= coalesce(
    v_coverage.invite_expires_at,
    (
      v_coverage.class_date::text || ' ' ||
      left(v_coverage.class_time, 5) || ':00-03'
    )::timestamptz
  ) THEN
    UPDATE public.class_coverages
       SET status = 'cancelled'
     WHERE id = v_coverage.id AND lower(status) = 'pending';
    RETURN jsonb_build_object(
      'ok', false, 'error', 'expirado', 'status', 'cancelled'
    );
  END IF;

  SELECT booking.*
    INTO v_booking
    FROM public.bookings AS booking
   WHERE booking.id = v_coverage.booking_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_booking.tenant_id IS DISTINCT FROM v_coverage.tenant_id
     OR v_booking.teacher_id IS DISTINCT FROM v_coverage.original_teacher_id
     OR v_booking.student_id IS DISTINCT FROM v_coverage.student_id
     OR upper(coalesce(v_booking.status, '')) <> 'SCHEDULED'
     OR left(coalesce(v_booking.time_slot, ''), 5) <> v_time
     OR (
       v_booking.date IS NOT NULL
       AND v_booking.date IS DISTINCT FROM v_coverage.class_date
     )
     OR (
       v_booking.date IS NULL
       AND public.fold_accents(v_booking.day_of_week) <>
           public.fold_accents(v_day_name)
     )
     OR (
       v_booking.date IS NULL
       AND v_booking.start_date IS NOT NULL
       AND v_coverage.class_date < v_booking.start_date
     ) THEN
    UPDATE public.class_coverages
       SET status = 'cancelled'
     WHERE id = v_coverage.id AND lower(status) = 'pending';
    RETURN jsonb_build_object(
      'ok', false, 'error', 'aula_nao_esta_mais_disponivel',
      'status', 'cancelled'
    );
  END IF;

  PERFORM 1
    FROM public.teacher_absences AS absence
   WHERE absence.id = v_coverage.absence_id
     AND absence.tenant_id = v_coverage.tenant_id
     AND absence.teacher_id = v_coverage.original_teacher_id
     AND lower(coalesce(absence.status, '')) = 'active'
     AND absence.starts_at::date <= v_coverage.class_date
     AND absence.ends_at::date >= v_coverage.class_date
   FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.class_coverages
       SET status = 'cancelled'
     WHERE id = v_coverage.id AND lower(status) = 'pending';
    RETURN jsonb_build_object(
      'ok', false, 'error', 'falta_original_nao_esta_mais_ativa',
      'status', 'cancelled'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS teacher
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = teacher.id
       AND membership.tenant_id = v_coverage.tenant_id
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE teacher.id = v_coverage.cover_teacher_id
       AND teacher.role = 'TEACHER'
       AND lower(coalesce(teacher.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.profiles AS student
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = student.id
       AND membership.tenant_id = v_coverage.tenant_id
       AND membership.role = 'STUDENT'
       AND membership.status = 'ACTIVE'
     WHERE student.id = v_coverage.student_id
       AND student.role = 'STUDENT'
       AND lower(coalesce(student.lifecycle_status, 'active'))
           NOT IN ('suspended', 'offboarded')
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.teacher_availability AS availability
     WHERE availability.tenant_id = v_coverage.tenant_id
       AND availability.teacher_id = v_coverage.cover_teacher_id
       AND availability.day_of_week = v_day_number
       AND (
         availability.start_time = v_time::time
         OR (
           availability.end_time IS NOT NULL
           AND availability.start_time <= v_time::time
           AND availability.end_time > v_time::time
         )
       )
  ) THEN
    UPDATE public.class_coverages
       SET status = 'cancelled'
     WHERE id = v_coverage.id AND lower(status) = 'pending';
    RETURN jsonb_build_object(
      'ok', false, 'error', 'substituto_nao_esta_mais_disponivel',
      'status', 'cancelled'
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.teacher_absences AS absence
     WHERE absence.tenant_id = v_coverage.tenant_id
       AND absence.teacher_id = v_coverage.cover_teacher_id
       AND lower(coalesce(absence.status, '')) = 'active'
       AND absence.starts_at::date <= v_coverage.class_date
       AND absence.ends_at::date >= v_coverage.class_date
  ) OR EXISTS (
    SELECT 1
      FROM public.bookings AS conflict
     WHERE conflict.tenant_id = v_coverage.tenant_id
       AND conflict.teacher_id = v_coverage.cover_teacher_id
       AND upper(coalesce(conflict.status, '')) <> 'CANCELLED'
       AND left(coalesce(conflict.time_slot, ''), 5) = v_time
       AND (
         conflict.date = v_coverage.class_date
         OR (
           conflict.date IS NULL
           AND public.fold_accents(conflict.day_of_week) =
               public.fold_accents(v_day_name)
           AND (
             conflict.start_date IS NULL
             OR conflict.start_date <= v_coverage.class_date
           )
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.reschedules AS reschedule
     WHERE reschedule.tenant_id = v_coverage.tenant_id
       AND reschedule.teacher_id = v_coverage.cover_teacher_id
       AND public.parse_lesson_date(reschedule.date) = v_coverage.class_date
       AND left(reschedule.time::text, 5) = v_time
       AND reschedule.used_at IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.appointments AS appointment
     WHERE appointment.tenant_id = v_coverage.tenant_id
       AND (
         appointment.teacher_id = v_coverage.cover_teacher_id
         OR appointment.professor_id = v_coverage.cover_teacher_id
       )
       AND lower(coalesce(appointment.status, '')) IN ('scheduled', 'confirmed')
       AND abs(extract(epoch FROM (appointment.start_time - v_class_start))) < 1800
  ) OR EXISTS (
    SELECT 1
      FROM public.class_coverages AS other_coverage
     WHERE other_coverage.id <> v_coverage.id
       AND other_coverage.tenant_id = v_coverage.tenant_id
       AND other_coverage.cover_teacher_id = v_coverage.cover_teacher_id
       AND other_coverage.class_date = v_coverage.class_date
       AND left(other_coverage.class_time, 5) = v_time
       AND lower(other_coverage.status) = 'confirmed'
  ) OR EXISTS (
    SELECT 1
      FROM public.class_coverages AS other_coverage
     WHERE other_coverage.id <> v_coverage.id
       AND other_coverage.tenant_id = v_coverage.tenant_id
       AND other_coverage.booking_id = v_coverage.booking_id
       AND other_coverage.class_date = v_coverage.class_date
       AND lower(other_coverage.status) = 'confirmed'
  ) THEN
    UPDATE public.class_coverages
       SET status = 'cancelled'
     WHERE id = v_coverage.id AND lower(status) = 'pending';
    RETURN jsonb_build_object(
      'ok', false, 'error', 'conflito_criado_apos_o_convite',
      'status', 'cancelled'
    );
  END IF;

  -- Se dois convites legados chegaram ao mesmo substituto/horario, o primeiro
  -- aceite valido vence e invalida os demais links ainda pendentes.
  UPDATE public.class_coverages
     SET status = 'cancelled'
   WHERE id <> v_coverage.id
     AND tenant_id = v_coverage.tenant_id
     AND (
       (
         cover_teacher_id = v_coverage.cover_teacher_id
         AND class_date = v_coverage.class_date
         AND left(class_time, 5) = v_time
       )
       OR (
         booking_id = v_coverage.booking_id
         AND class_date = v_coverage.class_date
       )
     )
     AND lower(status) = 'pending';

  UPDATE public.class_coverages
     SET status = 'confirmed', confirmed_at = now()
   WHERE id = v_coverage.id AND lower(status) = 'pending';

  SELECT public.apply_coverage_acceptance(v_coverage.id) INTO v_apply;
  IF coalesce((v_apply ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'coverage_financial_application_failed';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'status', 'confirmed', 'application', v_apply,
    'class_date', v_coverage.class_date, 'class_time', v_coverage.class_time
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_coverage_invite(text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_coverage_invite(text, boolean)
  TO service_role;

-- `apply_coverage_acceptance` e os relatorios internos do agente eram
-- SECURITY DEFINER acessiveis diretamente a qualquer usuario autenticado.
-- As Edges service-role seguem funcionando; o Data API deixa de aceitar tenant
-- ou cobertura arbitrarios informados pelo cliente.
REVOKE ALL ON FUNCTION public.apply_coverage_acceptance(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_coverage_acceptance(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.gestao_resolve_professor(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestao_resolve_professor(text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.gestao_faltas(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestao_faltas(text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.gestao_alunos_sem_cobranca(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gestao_alunos_sem_cobranca(text, text)
  TO service_role;

-- A tela envia o tenant efetivo, pois um professor pode atuar em mais de uma
-- escola. O perfil global nao e fonte suficiente para escolher esse contexto.
CREATE OR REPLACE FUNCTION public.coverages_for_teacher_in_tenant(
  p_tenant text,
  p_teacher uuid,
  p_from date,
  p_to date
)
RETURNS TABLE(
  coverage_id uuid,
  booking_id uuid,
  student_id uuid,
  class_date date,
  class_time text,
  papel text,
  outro_professor text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  IF p_tenant IS NULL OR p_teacher IS NULL OR p_from IS NULL OR p_to IS NULL
     OR p_to < p_from OR p_to > p_from + 366 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'intervalo_invalido';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS profile
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = profile.id
       AND membership.tenant_id = p_tenant
       AND membership.role = 'TEACHER'
       AND membership.status = 'ACTIVE'
     WHERE profile.id = p_teacher
       AND profile.role = 'TEACHER'
       AND lower(coalesce(profile.lifecycle_status, '')) = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'professor_nao_encontrado';
  END IF;

  IF coalesce(auth.role(), '') <> 'service_role' THEN
    IF v_actor_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication_required';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.tenant_memberships AS membership
       WHERE membership.user_id = v_actor_id
         AND membership.tenant_id = p_tenant
         AND membership.status = 'ACTIVE'
         AND (
           (v_actor_id = p_teacher AND membership.role = 'TEACHER')
           OR (
             v_actor_id <> p_teacher
             AND membership.role IN ('SCHOOL_ADMIN', 'COORDINATOR')
           )
         )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'forbidden';
    END IF;
  END IF;

  RETURN QUERY
  SELECT coverage.id,
         coverage.booking_id,
         coverage.student_id,
         coverage.class_date,
         coverage.class_time,
         CASE WHEN coverage.original_teacher_id = p_teacher
              THEN 'cedida' ELSE 'assumida' END,
         coalesce(other_profile.full_name, '')
    FROM public.class_coverages AS coverage
    LEFT JOIN public.profiles AS other_profile
      ON other_profile.id = CASE
        WHEN coverage.original_teacher_id = p_teacher
          THEN coverage.cover_teacher_id
        ELSE coverage.original_teacher_id
      END
   WHERE coverage.tenant_id = p_tenant
     AND lower(coverage.status) = 'confirmed'
     AND coverage.class_date BETWEEN p_from AND p_to
     AND (
       coverage.original_teacher_id = p_teacher
       OR coverage.cover_teacher_id = p_teacher
     );
END;
$function$;

REVOKE ALL ON FUNCTION public.coverages_for_teacher_in_tenant(
  text, uuid, date, date
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coverages_for_teacher_in_tenant(
  text, uuid, date, date
) TO authenticated, service_role;

-- Compatibilidade com clientes antigos: devolve somente escolas em que o alvo
-- e o ator possuem memberships ativas compativeis, nunca o tenant do perfil.
CREATE OR REPLACE FUNCTION public.coverages_for_teacher(
  p_teacher uuid,
  p_from date,
  p_to date
)
RETURNS TABLE(
  coverage_id uuid,
  booking_id uuid,
  student_id uuid,
  class_date date,
  class_time text,
  papel text,
  outro_professor text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  IF p_teacher IS NULL OR p_from IS NULL OR p_to IS NULL
     OR p_to < p_from OR p_to > p_from + 366 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'intervalo_invalido';
  END IF;
  IF coalesce(auth.role(), '') <> 'service_role' AND v_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication_required';
  END IF;

  RETURN QUERY
  SELECT coverage.id,
         coverage.booking_id,
         coverage.student_id,
         coverage.class_date,
         coverage.class_time,
         CASE WHEN coverage.original_teacher_id = p_teacher
              THEN 'cedida' ELSE 'assumida' END,
         coalesce(other_profile.full_name, '')
    FROM public.class_coverages AS coverage
    LEFT JOIN public.profiles AS other_profile
      ON other_profile.id = CASE
        WHEN coverage.original_teacher_id = p_teacher
          THEN coverage.cover_teacher_id
        ELSE coverage.original_teacher_id
      END
   WHERE lower(coverage.status) = 'confirmed'
     AND coverage.class_date BETWEEN p_from AND p_to
     AND (
       coverage.original_teacher_id = p_teacher
       OR coverage.cover_teacher_id = p_teacher
     )
     AND EXISTS (
       SELECT 1
         FROM public.tenant_memberships AS teacher_membership
        WHERE teacher_membership.user_id = p_teacher
          AND teacher_membership.tenant_id = coverage.tenant_id
          AND teacher_membership.role = 'TEACHER'
          AND teacher_membership.status = 'ACTIVE'
     )
     AND (
       coalesce(auth.role(), '') = 'service_role'
       OR EXISTS (
         SELECT 1
           FROM public.tenant_memberships AS actor_membership
          WHERE actor_membership.user_id = v_actor_id
            AND actor_membership.tenant_id = coverage.tenant_id
            AND actor_membership.status = 'ACTIVE'
            AND (
              (v_actor_id = p_teacher AND actor_membership.role = 'TEACHER')
              OR (
                v_actor_id <> p_teacher
                AND actor_membership.role IN ('SCHOOL_ADMIN', 'COORDINATOR')
              )
            )
       )
     );
END;
$function$;

REVOKE ALL ON FUNCTION public.coverages_for_teacher(uuid, date, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coverages_for_teacher(uuid, date, date)
  TO authenticated, service_role;
