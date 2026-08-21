-- Modo Turbo por ofensiva diaria, auditavel e independente do fechamento mensal.
--
-- Regra canonica a partir desta migration:
--   * a carteira precisa ter pelo menos 10 alunos ativos/faturaveis;
--   * a ofensiva completa 30 dias corridos sem falta do professor;
--   * um relato TEACHER_NO_SHOW suspende o Turbo imediatamente, sem destruir o
--     ciclo, ate a direcao decidir;
--   * professor inocentado recupera o mesmo ciclo;
--   * falta confirmada reinicia a ofensiva na data da ocorrencia.
--
-- teacher_turbo_state e apenas o snapshot do ciclo atual;
-- teacher_turbo_events e teacher_turbo_disputes explicam como ele chegou ali.
-- Eventos com uma fonte canonica sao idempotentes: correcoes nessa fonte
-- atualizam tenant/data/metadata do mesmo evento, sem criar uma segunda falta.
-- O perfil de professor e mono-tenant. Uma troca de profiles.tenant_id inicia
-- outro ciclo, sem carregar carteira, faltas ou ofensiva da escola anterior.

-- -----------------------------------------------------------------------------
-- 1. Estado e trilha de auditoria
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.teacher_turbo_state (
  teacher_id                 uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id                  text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  initial_anchor_on          date NOT NULL,
  streak_anchor_on           date NOT NULL,
  students_active            integer NOT NULL DEFAULT 0 CHECK (students_active >= 0),
  students_eligible_since    date,
  last_confirmed_absence_on  date,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (streak_anchor_on >= initial_anchor_on),
  CHECK (last_confirmed_absence_on IS NULL OR last_confirmed_absence_on >= initial_anchor_on)
);

CREATE TABLE IF NOT EXISTS public.teacher_turbo_disputes (
  confirmation_id      uuid PRIMARY KEY REFERENCES public.attendance_confirmations(id) ON DELETE RESTRICT,
  teacher_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id            text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  reported_class_date  date NOT NULL,
  suspended_at         timestamptz NOT NULL,
  status               text NOT NULL CHECK (status IN ('OPEN', 'DISMISSED', 'CONFIRMED_ABSENCE')),
  verdict              text CHECK (verdict IS NULL OR verdict IN ('TEACHER_PRESENT', 'TEACHER_ABSENT', 'CANCELLED')),
  resolved_at          timestamptz,
  resolved_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolution_note      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'OPEN' AND resolved_at IS NULL AND verdict IS NULL)
    OR
    (status <> 'OPEN' AND resolved_at IS NOT NULL AND verdict IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.teacher_turbo_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id     text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_type    text NOT NULL CHECK (event_type IN (
    'STREAK_INITIALIZED',
    'STUDENT_THRESHOLD_REACHED',
    'STUDENT_THRESHOLD_LOST',
    'ABSENCE_RECORDED',
    'DISPUTE_REPORTED',
    'DISPUTE_DISMISSED',
    'ABSENCE_CONFIRMED'
  )),
  effective_on  date NOT NULL,
  happened_at   timestamptz NOT NULL DEFAULT now(),
  source_type   text,
  source_id     uuid,
  actor_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_teacher_turbo_state_tenant
  ON public.teacher_turbo_state (tenant_id, teacher_id);

CREATE INDEX IF NOT EXISTS idx_teacher_turbo_state_eligible
  ON public.teacher_turbo_state (tenant_id, students_eligible_since)
  WHERE students_eligible_since IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_teacher_turbo_events_teacher_date
  ON public.teacher_turbo_events (teacher_id, effective_on DESC, happened_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_turbo_event_source
  ON public.teacher_turbo_events (teacher_id, event_type, source_type, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_teacher_turbo_disputes_open
  ON public.teacher_turbo_disputes (teacher_id, suspended_at)
  WHERE status = 'OPEN';

-- teacher_turbo_status consulta exatamente este recorte. O indice anterior de
-- attendance_confirmations era apenas por status, obrigando o banco a combinar
-- muitos registros para cada professor.
CREATE INDEX IF NOT EXISTS idx_attconf_teacher_no_show_open
  ON public.attendance_confirmations (teacher_id, class_date)
  WHERE student_response = 'TEACHER_NO_SHOW'
    AND status IN ('PENDING', 'AWAITING_TEACHER', 'CONFLICT');

ALTER TABLE public.teacher_turbo_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_turbo_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_turbo_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teacher_turbo_state_read ON public.teacher_turbo_state;
CREATE POLICY teacher_turbo_state_read
  ON public.teacher_turbo_state FOR SELECT TO authenticated
  USING (
    (
      teacher_id = (SELECT auth.uid())
      AND teacher_turbo_state.tenant_id = (SELECT public._my_tenant_id())
      AND COALESCE((SELECT public._my_role()) = 'TEACHER', false)
    )
    OR COALESCE((SELECT public._my_role()) = 'SUPER_ADMIN', false)
    OR (
      COALESCE((SELECT public._my_role()) = 'SCHOOL_ADMIN', false)
      AND teacher_turbo_state.tenant_id = (SELECT public._my_tenant_id())
    )
  );

DROP POLICY IF EXISTS teacher_turbo_disputes_read ON public.teacher_turbo_disputes;
CREATE POLICY teacher_turbo_disputes_read
  ON public.teacher_turbo_disputes FOR SELECT TO authenticated
  USING (
    (
      teacher_id = (SELECT auth.uid())
      AND teacher_turbo_disputes.tenant_id = (SELECT public._my_tenant_id())
      AND COALESCE((SELECT public._my_role()) = 'TEACHER', false)
    )
    OR COALESCE((SELECT public._my_role()) = 'SUPER_ADMIN', false)
    OR (
      COALESCE((SELECT public._my_role()) = 'SCHOOL_ADMIN', false)
      AND teacher_turbo_disputes.tenant_id = (SELECT public._my_tenant_id())
    )
  );

DROP POLICY IF EXISTS teacher_turbo_events_read ON public.teacher_turbo_events;
CREATE POLICY teacher_turbo_events_read
  ON public.teacher_turbo_events FOR SELECT TO authenticated
  USING (
    (
      teacher_id = (SELECT auth.uid())
      AND teacher_turbo_events.tenant_id = (SELECT public._my_tenant_id())
      AND COALESCE((SELECT public._my_role()) = 'TEACHER', false)
    )
    OR COALESCE((SELECT public._my_role()) = 'SUPER_ADMIN', false)
    OR (
      COALESCE((SELECT public._my_role()) = 'SCHOOL_ADMIN', false)
      AND teacher_turbo_events.tenant_id = (SELECT public._my_tenant_id())
    )
  );

GRANT SELECT ON public.teacher_turbo_state, public.teacher_turbo_disputes, public.teacher_turbo_events
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Primitivas internas da maquina de estados
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.teacher_turbo_business_date()
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog'
AS $function$
  SELECT (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date;
$function$;

CREATE OR REPLACE FUNCTION public.teacher_turbo_add_event(
  p_teacher uuid,
  p_tenant text,
  p_event_type text,
  p_effective_on date,
  p_source_type text DEFAULT NULL,
  p_source_id uuid DEFAULT NULL,
  p_actor uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.teacher_turbo_events AS e (
    teacher_id, tenant_id, event_type, effective_on,
    source_type, source_id, actor_id, metadata
  ) VALUES (
    p_teacher, p_tenant, p_event_type, p_effective_on,
    p_source_type, p_source_id, p_actor, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (teacher_id, event_type, source_type, source_id)
    WHERE source_id IS NOT NULL
  DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    effective_on = EXCLUDED.effective_on,
    actor_id = COALESCE(EXCLUDED.actor_id, e.actor_id),
    metadata = EXCLUDED.metadata;
END;
$function$;

CREATE OR REPLACE FUNCTION public.teacher_turbo_ensure_state(p_teacher uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant text;
  v_anchor date;
  v_previous_tenant text;
  v_tenant_changed boolean := false;
BEGIN
  SELECT p.tenant_id,
         LEAST(
           public.teacher_turbo_business_date(),
           COALESCE(p.start_date, p.created_at::date, public.teacher_turbo_business_date())
         )
    INTO v_tenant, v_anchor
  FROM public.profiles p
  WHERE p.id = p_teacher
    AND p.role = 'TEACHER';

  IF v_tenant IS NULL THEN
    RETURN;
  END IF;

  -- profiles representa um unico tenant ativo por professor. Serializar pela
  -- linha de estado permite detectar a transferencia e reiniciar o ciclo uma
  -- unica vez, mesmo se outros gatilhos do mesmo UPDATE tambem fizerem refresh.
  SELECT s.tenant_id
    INTO v_previous_tenant
  FROM public.teacher_turbo_state s
  WHERE s.teacher_id = p_teacher
  FOR UPDATE;

  v_tenant_changed := FOUND AND v_previous_tenant IS DISTINCT FROM v_tenant;

  INSERT INTO public.teacher_turbo_state AS s (
    teacher_id, tenant_id, initial_anchor_on, streak_anchor_on
  ) VALUES (
    p_teacher, v_tenant, v_anchor, v_anchor
  )
  ON CONFLICT (teacher_id) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id,
    initial_anchor_on = CASE
      WHEN s.tenant_id IS DISTINCT FROM EXCLUDED.tenant_id
        THEN public.teacher_turbo_business_date()
      ELSE s.initial_anchor_on
    END,
    streak_anchor_on = CASE
      WHEN s.tenant_id IS DISTINCT FROM EXCLUDED.tenant_id
        THEN public.teacher_turbo_business_date()
      ELSE s.streak_anchor_on
    END,
    students_active = CASE
      WHEN s.tenant_id IS DISTINCT FROM EXCLUDED.tenant_id THEN 0
      ELSE s.students_active
    END,
    students_eligible_since = CASE
      WHEN s.tenant_id IS DISTINCT FROM EXCLUDED.tenant_id THEN NULL
      ELSE s.students_eligible_since
    END,
    last_confirmed_absence_on = CASE
      WHEN s.tenant_id IS DISTINCT FROM EXCLUDED.tenant_id THEN NULL
      ELSE s.last_confirmed_absence_on
    END,
    updated_at = now();

  IF v_tenant_changed THEN
    PERFORM public.teacher_turbo_add_event(
      p_teacher, v_tenant, 'STREAK_INITIALIZED',
      public.teacher_turbo_business_date(),
      'tenant_transfer', NULL, NULL,
      jsonb_build_object(
        'origin', 'tenant_transfer',
        'previous_tenant_id', v_previous_tenant,
        'tenant_id', v_tenant
      )
    );
  ELSE
    PERFORM public.teacher_turbo_add_event(
      p_teacher, v_tenant, 'STREAK_INITIALIZED', v_anchor,
      'teacher', p_teacher, NULL,
      jsonb_build_object('origin', 'profile_start')
    );
  END IF;
END;
$function$;

-- teacher_carteira preserva a regra financeira existente; esta camada adicional
-- impede que um booking inconsistente de outro tenant infle a elegibilidade.
CREATE OR REPLACE FUNCTION public.teacher_turbo_student_count(p_teacher uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT count(*)::integer
  FROM public.teacher_carteira(p_teacher) c
  JOIN public.profiles t
    ON t.id = p_teacher
   AND t.role = 'TEACHER'
  JOIN public.profiles s
    ON s.id = c.student_id
   AND s.tenant_id = t.tenant_id
  WHERE EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.teacher_id = t.id
      AND b.student_id = s.id
      AND b.tenant_id = t.tenant_id
      AND COALESCE(b.status, 'SCHEDULED') = 'SCHEDULED'
  );
$function$;

CREATE OR REPLACE FUNCTION public.teacher_turbo_refresh_eligibility(
  p_teacher uuid,
  p_effective_on date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_state public.teacher_turbo_state%ROWTYPE;
  v_students integer;
  v_on date := COALESCE(p_effective_on, public.teacher_turbo_business_date());
BEGIN
  PERFORM public.teacher_turbo_ensure_state(p_teacher);

  SELECT * INTO v_state
  FROM public.teacher_turbo_state
  WHERE teacher_id = p_teacher
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT public.teacher_turbo_student_count(p_teacher) INTO v_students;

  IF v_students >= 10 AND v_state.students_eligible_since IS NULL THEN
    UPDATE public.teacher_turbo_state
       SET students_active = v_students,
           students_eligible_since = v_on,
           updated_at = now()
     WHERE teacher_id = p_teacher;

    PERFORM public.teacher_turbo_add_event(
      p_teacher, v_state.tenant_id, 'STUDENT_THRESHOLD_REACHED', v_on,
      NULL, NULL, auth.uid(),
      jsonb_build_object('students_active', v_students, 'students_required', 10)
    );
  ELSIF v_students < 10 AND v_state.students_eligible_since IS NOT NULL THEN
    UPDATE public.teacher_turbo_state
       SET students_active = v_students,
           students_eligible_since = NULL,
           updated_at = now()
     WHERE teacher_id = p_teacher;

    PERFORM public.teacher_turbo_add_event(
      p_teacher, v_state.tenant_id, 'STUDENT_THRESHOLD_LOST', v_on,
      NULL, NULL, auth.uid(),
      jsonb_build_object('students_active', v_students, 'students_required', 10)
    );
  ELSE
    UPDATE public.teacher_turbo_state
       SET students_active = v_students,
           updated_at = now()
     WHERE teacher_id = p_teacher;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.teacher_turbo_reset(
  p_teacher uuid,
  p_absence_on date,
  p_event_type text,
  p_source_type text,
  p_source_id uuid,
  p_actor uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_state public.teacher_turbo_state%ROWTYPE;
BEGIN
  IF p_absence_on IS NULL OR p_event_type NOT IN ('ABSENCE_RECORDED', 'ABSENCE_CONFIRMED') THEN
    RETURN;
  END IF;

  PERFORM public.teacher_turbo_ensure_state(p_teacher);

  SELECT * INTO v_state
  FROM public.teacher_turbo_state
  WHERE teacher_id = p_teacher
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM public.teacher_turbo_add_event(
    p_teacher, v_state.tenant_id, p_event_type, p_absence_on,
    p_source_type, p_source_id, p_actor, p_metadata
  );

  -- Evento futuro fica auditado, mas so passa a compor o snapshot quando a data
  -- chegar. Evento antigo nunca anda o contador atual para tras.
  IF p_absence_on <= public.teacher_turbo_business_date() THEN
    UPDATE public.teacher_turbo_state
       SET initial_anchor_on = LEAST(initial_anchor_on, p_absence_on),
           streak_anchor_on = GREATEST(streak_anchor_on, p_absence_on),
           last_confirmed_absence_on = GREATEST(
             COALESCE(last_confirmed_absence_on, p_absence_on),
             p_absence_on
           ),
           updated_at = now()
     WHERE teacher_id = p_teacher;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.teacher_turbo_sync_attendance_dispute(p_confirmation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c public.attendance_confirmations%ROWTYPE;
  v_log_presence text;
  v_dispute_status text;
  v_verdict text;
  v_suspended_at timestamptz;
  v_resolution_at timestamptz;
  v_effective_on date;
  v_reported_class_date date;
  v_existing_dispute public.teacher_turbo_disputes%ROWTYPE;
BEGIN
  SELECT * INTO c
  FROM public.attendance_confirmations
  WHERE id = p_confirmation_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- A confirmacao nunca e uma autoridade para escolher o tenant do professor.
  -- O perfil mono-tenant e a fonte de verdade. Se houver class_log vinculado,
  -- ele tambem precisa representar exatamente a mesma aula/parte envolvida.
  IF c.teacher_id IS NULL
     OR c.tenant_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.profiles p
       WHERE p.id = c.teacher_id
         AND p.role = 'TEACHER'
         AND p.tenant_id = c.tenant_id
     ) THEN
    RETURN;
  END IF;

  IF c.class_log_id IS NOT NULL THEN
    SELECT cl.presence
      INTO v_log_presence
    FROM public.class_logs cl
    WHERE cl.id = c.class_log_id
      AND cl.tenant_id = c.tenant_id
      AND cl.teacher_id = c.teacher_id
      AND cl.student_id IS NOT DISTINCT FROM c.student_id;

    IF NOT FOUND THEN
      RETURN;
    END IF;
  END IF;

  -- Se o aluno corrigiu/removeu o relato, a suspensao preventiva nao pode ficar
  -- orfa. Fecha apenas um caso ainda OPEN; decisoes finais continuam imutaveis.
  IF c.student_response IS DISTINCT FROM 'TEACHER_NO_SHOW' THEN
    v_resolution_at := COALESCE(c.resolved_at, now());

    UPDATE public.teacher_turbo_disputes
       SET status = 'DISMISSED',
           verdict = 'CANCELLED',
           resolved_at = v_resolution_at,
           resolved_by = c.resolved_by,
           resolution_note = COALESCE(
             NULLIF(c.admin_resolution, ''),
             CASE WHEN c.status = 'CANCELLED'
               THEN 'Confirmacao cancelada'
               ELSE 'Relato TEACHER_NO_SHOW removido pelo aluno'
             END
           ),
           updated_at = now()
     WHERE confirmation_id = c.id
       AND teacher_id = c.teacher_id
       AND tenant_id = c.tenant_id
       AND status = 'OPEN'
    RETURNING * INTO v_existing_dispute;

    IF FOUND THEN
      PERFORM public.teacher_turbo_add_event(
        v_existing_dispute.teacher_id,
        v_existing_dispute.tenant_id,
        'DISPUTE_DISMISSED',
        (v_resolution_at AT TIME ZONE 'America/Sao_Paulo')::date,
        'attendance_confirmation',
        c.id,
        c.resolved_by,
        jsonb_build_object(
          'verdict', 'CANCELLED',
          'reason', CASE WHEN c.status = 'CANCELLED'
            THEN 'confirmation_cancelled'
            ELSE 'teacher_no_show_removed'
          END,
          'note', v_existing_dispute.resolution_note
        )
      );
    END IF;
    RETURN;
  END IF;

  PERFORM public.teacher_turbo_ensure_state(c.teacher_id);

  v_suspended_at := COALESCE(c.responded_at, now());
  v_effective_on := (v_suspended_at AT TIME ZONE 'America/Sao_Paulo')::date;
  v_reported_class_date := COALESCE(c.class_date, v_effective_on);

  IF c.status = 'RESOLVED_PAID' THEN
    v_dispute_status := 'DISMISSED';
    v_verdict := 'TEACHER_PRESENT';
    v_resolution_at := COALESCE(c.resolved_at, now());
  ELSIF c.status = 'CANCELLED' THEN
    v_dispute_status := 'DISMISSED';
    v_verdict := 'CANCELLED';
    v_resolution_at := COALESCE(c.resolved_at, now());
  ELSIF c.status = 'RESOLVED_UNPAID'
        OR c.teacher_reported IN ('TEACHER_ABSENCE', 'Falta do Professor')
        OR v_log_presence IN ('TEACHER_ABSENCE', 'Falta do Professor') THEN
    v_dispute_status := 'CONFIRMED_ABSENCE';
    v_verdict := 'TEACHER_ABSENT';
    v_resolution_at := COALESCE(c.resolved_at, c.responded_at, now());
  ELSE
    v_dispute_status := 'OPEN';
    v_verdict := NULL;
    v_resolution_at := NULL;
  END IF;

  INSERT INTO public.teacher_turbo_disputes AS d (
    confirmation_id, teacher_id, tenant_id, reported_class_date,
    suspended_at, status, verdict, resolved_at, resolved_by,
    resolution_note, updated_at
  ) VALUES (
    c.id, c.teacher_id, c.tenant_id, v_reported_class_date,
    v_suspended_at, v_dispute_status, v_verdict, v_resolution_at,
    CASE WHEN v_dispute_status = 'OPEN' THEN NULL ELSE c.resolved_by END,
    CASE WHEN v_dispute_status = 'OPEN' THEN NULL ELSE c.admin_resolution END,
    now()
  )
  ON CONFLICT (confirmation_id) DO UPDATE SET
    teacher_id = EXCLUDED.teacher_id,
    tenant_id = EXCLUDED.tenant_id,
    reported_class_date = EXCLUDED.reported_class_date,
    suspended_at = LEAST(d.suspended_at, EXCLUDED.suspended_at),
    status = EXCLUDED.status,
    verdict = EXCLUDED.verdict,
    resolved_at = EXCLUDED.resolved_at,
    resolved_by = EXCLUDED.resolved_by,
    resolution_note = EXCLUDED.resolution_note,
    updated_at = now();

  PERFORM public.teacher_turbo_add_event(
    c.teacher_id, c.tenant_id, 'DISPUTE_REPORTED', v_effective_on,
    'attendance_confirmation', c.id, NULL,
    jsonb_build_object(
      'class_date', v_reported_class_date,
      'student_response', c.student_response,
      'teacher_reported', c.teacher_reported
    )
  );

  IF v_dispute_status = 'DISMISSED' THEN
    PERFORM public.teacher_turbo_add_event(
      c.teacher_id, c.tenant_id, 'DISPUTE_DISMISSED',
      (v_resolution_at AT TIME ZONE 'America/Sao_Paulo')::date,
      'attendance_confirmation', c.id, c.resolved_by,
      jsonb_build_object('verdict', v_verdict, 'note', c.admin_resolution)
    );
  ELSIF v_dispute_status = 'CONFIRMED_ABSENCE' THEN
    PERFORM public.teacher_turbo_reset(
      c.teacher_id, v_reported_class_date, 'ABSENCE_CONFIRMED',
      'attendance_confirmation', c.id, c.resolved_by,
      jsonb_build_object('verdict', v_verdict, 'note', c.admin_resolution)
    );
  END IF;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Backfill conservador
-- -----------------------------------------------------------------------------

INSERT INTO public.teacher_turbo_state (
  teacher_id, tenant_id, initial_anchor_on, streak_anchor_on
)
SELECT p.id,
       p.tenant_id,
       LEAST(
         public.teacher_turbo_business_date(),
         COALESCE((SELECT min(cl.class_date) FROM public.class_logs cl WHERE cl.teacher_id = p.id AND cl.tenant_id = p.tenant_id), public.teacher_turbo_business_date()),
         COALESCE((SELECT min(ac.class_date) FROM public.attendance_confirmations ac WHERE ac.teacher_id = p.id AND ac.tenant_id = p.tenant_id), public.teacher_turbo_business_date()),
         COALESCE(p.start_date, public.teacher_turbo_business_date()),
         COALESCE(p.created_at::date, public.teacher_turbo_business_date())
       ),
       LEAST(
         public.teacher_turbo_business_date(),
         COALESCE((SELECT min(cl.class_date) FROM public.class_logs cl WHERE cl.teacher_id = p.id AND cl.tenant_id = p.tenant_id), public.teacher_turbo_business_date()),
         COALESCE((SELECT min(ac.class_date) FROM public.attendance_confirmations ac WHERE ac.teacher_id = p.id AND ac.tenant_id = p.tenant_id), public.teacher_turbo_business_date()),
         COALESCE(p.start_date, public.teacher_turbo_business_date()),
         COALESCE(p.created_at::date, public.teacher_turbo_business_date())
       )
FROM public.profiles p
WHERE p.role = 'TEACHER'
  AND p.tenant_id IS NOT NULL
ON CONFLICT (teacher_id) DO NOTHING;

INSERT INTO public.teacher_turbo_events (
  teacher_id, tenant_id, event_type, effective_on,
  source_type, source_id, metadata
)
SELECT s.teacher_id, s.tenant_id, 'STREAK_INITIALIZED', s.initial_anchor_on,
       'teacher', s.teacher_id, jsonb_build_object('origin', 'migration_backfill')
FROM public.teacher_turbo_state s
ON CONFLICT DO NOTHING;

-- Cada falta explicita vira um unico evento por fonte. Reexecutar o backfill
-- reflete eventual correcao de data/tenant/metadata feita no class_log.
INSERT INTO public.teacher_turbo_events AS e (
  teacher_id, tenant_id, event_type, effective_on,
  source_type, source_id, actor_id, metadata
)
SELECT cl.teacher_id, cl.tenant_id, 'ABSENCE_RECORDED', cl.class_date,
       'class_log', cl.id, cl.teacher_id,
       jsonb_build_object('presence', cl.presence, 'origin', 'migration_backfill')
FROM public.class_logs cl
JOIN public.profiles p
  ON p.id = cl.teacher_id
 AND p.role = 'TEACHER'
 AND p.tenant_id = cl.tenant_id
WHERE cl.presence IN ('TEACHER_ABSENCE', 'Falta do Professor')
ON CONFLICT (teacher_id, event_type, source_type, source_id)
  WHERE source_id IS NOT NULL
DO UPDATE SET
  tenant_id = EXCLUDED.tenant_id,
  effective_on = EXCLUDED.effective_on,
  actor_id = COALESCE(EXCLUDED.actor_id, e.actor_id),
  metadata = EXCLUDED.metadata;

UPDATE public.teacher_turbo_state s
SET streak_anchor_on = GREATEST(s.streak_anchor_on, x.last_absence),
    last_confirmed_absence_on = x.last_absence,
    updated_at = now()
FROM (
  SELECT e.teacher_id, e.tenant_id, max(e.effective_on) AS last_absence
  FROM public.teacher_turbo_events e
  WHERE e.event_type IN ('ABSENCE_RECORDED', 'ABSENCE_CONFIRMED')
    AND e.effective_on <= public.teacher_turbo_business_date()
  GROUP BY e.teacher_id, e.tenant_id
) x
WHERE x.teacher_id = s.teacher_id
  AND x.tenant_id = s.tenant_id;

-- A data historica exata em que a carteira chegou a dez nao existia antes desta
-- migration. Para o primeiro ciclo, usa-se a data do 10o vinculo ativo atual.
WITH student_since AS (
  SELECT t.id AS teacher_id,
         c.student_id,
         min(COALESCE(b.start_date, b.created_at::date, public.teacher_turbo_business_date())) AS linked_since
  FROM public.profiles t
  CROSS JOIN LATERAL public.teacher_carteira(t.id) c
  JOIN public.profiles sp
    ON sp.id = c.student_id
   AND sp.tenant_id = t.tenant_id
  JOIN public.bookings b
    ON b.teacher_id = t.id
   AND b.student_id = c.student_id
   AND b.tenant_id = t.tenant_id
   AND COALESCE(b.status, 'SCHEDULED') = 'SCHEDULED'
  WHERE t.role = 'TEACHER'
  GROUP BY t.id, c.student_id
), ranked AS (
  SELECT ss.*,
         row_number() OVER (PARTITION BY ss.teacher_id ORDER BY ss.linked_since, ss.student_id) AS rn,
         count(*) OVER (PARTITION BY ss.teacher_id) AS total_students
  FROM student_since ss
), threshold AS (
  SELECT r.teacher_id,
         LEAST(r.linked_since, public.teacher_turbo_business_date()) AS eligible_since,
         r.total_students::integer
  FROM ranked r
  WHERE r.rn = 10 AND r.total_students >= 10
)
UPDATE public.teacher_turbo_state s
SET students_active = th.total_students,
    students_eligible_since = th.eligible_since,
    updated_at = now()
FROM threshold th
WHERE th.teacher_id = s.teacher_id
  AND s.students_eligible_since IS NULL
  -- Torna o backfill idempotente: depois de perder e retomar o 10o aluno, os
  -- eventos de limiar registram que o ciclo ja foi inicializado em runtime e a
  -- data estimada do vinculo antigo nunca pode sobrescrever a retomada real.
  AND NOT EXISTS (
    SELECT 1
    FROM public.teacher_turbo_events e
    WHERE e.teacher_id = s.teacher_id
      AND e.tenant_id = s.tenant_id
      AND e.event_type IN ('STUDENT_THRESHOLD_REACHED', 'STUDENT_THRESHOLD_LOST')
  );

UPDATE public.teacher_turbo_state s
SET students_active = x.students_active,
    updated_at = now()
FROM (
  SELECT p.id AS teacher_id,
         p.tenant_id,
         public.teacher_turbo_student_count(p.id) AS students_active
  FROM public.profiles p
  WHERE p.role = 'TEACHER'
) x
WHERE x.teacher_id = s.teacher_id
  AND x.tenant_id = s.tenant_id;

INSERT INTO public.teacher_turbo_events (
  teacher_id, tenant_id, event_type, effective_on,
  source_type, source_id, metadata
)
SELECT s.teacher_id, s.tenant_id, 'STUDENT_THRESHOLD_REACHED', s.students_eligible_since,
       'migration_backfill', s.teacher_id,
       jsonb_build_object(
         'students_active', s.students_active,
         'students_required', 10,
         'origin', 'migration_backfill',
         'estimated', true
       )
FROM public.teacher_turbo_state s
WHERE s.students_eligible_since IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.teacher_turbo_events e
    WHERE e.teacher_id = s.teacher_id
      AND e.tenant_id = s.tenant_id
      AND e.event_type IN ('STUDENT_THRESHOLD_REACHED', 'STUDENT_THRESHOLD_LOST')
  )
ON CONFLICT DO NOTHING;

-- Importa relatos antigos. Resolvido a favor do professor restaura; ausencia
-- admitida ou RESOLVED_UNPAID reinicia; os demais ficam suspensos para decisao.
DO $function$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ac.id
    FROM public.attendance_confirmations ac
    WHERE ac.student_response = 'TEACHER_NO_SHOW'
      AND ac.status <> 'CANCELLED'
  LOOP
    PERFORM public.teacher_turbo_sync_attendance_dispute(r.id);
  END LOOP;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Status canonico e compatibilidade financeira
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.teacher_turbo_status_at(p_teacher uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_state public.teacher_turbo_state%ROWTYPE;
  v_students integer := 0;
  v_anchor date;
  v_last_absence date;
  v_threshold_event text;
  v_eligible_since date;
  v_students_eligible boolean := false;
  v_days_clean integer := 0;
  v_days_to_activate integer := 30;
  v_active_since date;
  v_active boolean := false;
  v_active_days integer := 0;
  v_suspensions integer := 0;
  v_suspended_at timestamptz;
  v_absences_this_month integer := 0;
  v_absences_last_month integer := 0;
  v_blocked_by text;
BEGIN
  IF p_date IS NULL THEN
    RETURN jsonb_build_object('active', false, 'blocked_by', 'data_invalida');
  END IF;

  SELECT * INTO v_state
  FROM public.teacher_turbo_state
  WHERE teacher_id = p_teacher;

  IF NOT FOUND THEN
    SELECT p.id, p.tenant_id,
           LEAST(p_date, COALESCE(p.start_date, p.created_at::date, p_date)),
           LEAST(p_date, COALESCE(p.start_date, p.created_at::date, p_date)),
           0, NULL::date, NULL::date, now(), now()
      INTO v_state
    FROM public.profiles p
    WHERE p.id = p_teacher AND p.role = 'TEACHER';

    IF NOT FOUND THEN
      RETURN jsonb_build_object('active', false, 'blocked_by', 'professor_invalido');
    END IF;
  END IF;

  SELECT public.teacher_turbo_student_count(p_teacher) INTO v_students;

  SELECT max(e.effective_on) INTO v_last_absence
  FROM public.teacher_turbo_events e
  WHERE e.teacher_id = p_teacher
    AND e.tenant_id = v_state.tenant_id
    AND e.event_type IN ('ABSENCE_RECORDED', 'ABSENCE_CONFIRMED')
    AND e.effective_on <= p_date;

  v_anchor := GREATEST(v_state.initial_anchor_on, COALESCE(v_last_absence, v_state.initial_anchor_on));
  v_days_clean := GREATEST(0, p_date - v_anchor);
  v_days_to_activate := GREATEST(0, 30 - v_days_clean);

  -- Para datas historicas, o ultimo evento de limiar e a fonte. Para hoje/futuro,
  -- a carteira atual e soberana e students_eligible_since marca o inicio do ciclo.
  IF p_date >= public.teacher_turbo_business_date() THEN
    v_students_eligible := v_students >= 10;
    v_eligible_since := CASE WHEN v_students_eligible THEN v_state.students_eligible_since END;
  ELSE
    SELECT e.event_type, e.effective_on
      INTO v_threshold_event, v_eligible_since
    FROM public.teacher_turbo_events e
    WHERE e.teacher_id = p_teacher
      AND e.tenant_id = v_state.tenant_id
      AND e.event_type IN ('STUDENT_THRESHOLD_REACHED', 'STUDENT_THRESHOLD_LOST')
      AND e.effective_on <= p_date
    ORDER BY e.effective_on DESC, e.happened_at DESC, e.id DESC
    LIMIT 1;

    v_students_eligible := COALESCE(
      v_threshold_event = 'STUDENT_THRESHOLD_REACHED',
      false
    );
    IF v_students_eligible IS NOT TRUE THEN
      v_eligible_since := NULL;
    END IF;
  END IF;

  -- Defesa para professor criado entre a migration e o primeiro refresh.
  IF v_students_eligible AND v_eligible_since IS NULL THEN
    v_eligible_since := p_date;
  END IF;

  SELECT count(*)::integer, min(d.suspended_at)
    INTO v_suspensions, v_suspended_at
  FROM public.teacher_turbo_disputes d
  WHERE d.teacher_id = p_teacher
    AND d.tenant_id = v_state.tenant_id
    AND d.status = 'OPEN'
    AND (d.suspended_at AT TIME ZONE 'America/Sao_Paulo')::date <= p_date;

  IF v_students_eligible AND v_days_clean >= 30 THEN
    v_active_since := GREATEST(v_anchor + 30, v_eligible_since);
  END IF;

  IF v_eligible_since IS NOT NULL THEN
    v_days_to_activate := GREATEST(
      v_days_to_activate,
      GREATEST(0, v_eligible_since - p_date)
    );
  END IF;

  v_active := v_active_since IS NOT NULL
              AND v_active_since <= p_date
              AND v_suspensions = 0;
  -- Uma inocentacao recompõe o ciclo como se a suspensao temporaria nunca o
  -- tivesse interrompido; por isso o tempo ativo continua visivel no intervalo.
  IF v_active_since IS NOT NULL AND v_active_since <= p_date THEN
    v_active_days := GREATEST(0, p_date - v_active_since);
  END IF;

  SELECT count(DISTINCT e.effective_on)::integer INTO v_absences_this_month
  FROM public.teacher_turbo_events e
  WHERE e.teacher_id = p_teacher
    AND e.tenant_id = v_state.tenant_id
    AND e.event_type IN ('ABSENCE_RECORDED', 'ABSENCE_CONFIRMED')
    AND e.effective_on >= date_trunc('month', p_date)::date
    AND e.effective_on < (date_trunc('month', p_date) + interval '1 month')::date;

  SELECT count(DISTINCT e.effective_on)::integer INTO v_absences_last_month
  FROM public.teacher_turbo_events e
  WHERE e.teacher_id = p_teacher
    AND e.tenant_id = v_state.tenant_id
    AND e.event_type IN ('ABSENCE_RECORDED', 'ABSENCE_CONFIRMED')
    AND e.effective_on >= (date_trunc('month', p_date) - interval '1 month')::date
    AND e.effective_on < date_trunc('month', p_date)::date;

  v_blocked_by := CASE
    WHEN v_suspensions > 0 THEN 'conflito'
    WHEN v_students_eligible IS NOT TRUE THEN 'carteira'
    WHEN v_days_clean < 30 OR v_active_since > p_date THEN 'ofensiva'
    ELSE NULL
  END;

  RETURN jsonb_build_object(
    'active', v_active,
    'status', CASE
      WHEN v_suspensions > 0 THEN 'SUSPENDED'
      WHEN v_students_eligible IS NOT TRUE THEN 'INELIGIBLE_STUDENTS'
      WHEN v_days_clean < 30 OR v_active_since > p_date THEN 'BUILDING'
      ELSE 'ACTIVE'
    END,
    'scope', 'rolling_30_days',
    'students_active', v_students,
    'students_required', 10,
    'students_missing', GREATEST(0, 10 - v_students),
    'students_eligible_since', v_eligible_since,
    'clean_since', v_anchor,
    'days_clean', v_days_clean,
    'days_to_activate', v_days_to_activate,
    'active_since', v_active_since,
    'active_days', v_active_days,
    'last_absence', v_last_absence,
    'last_confirmed_absence_on', v_last_absence,
    'suspensions_open', v_suspensions,
    'suspension_since', v_suspended_at,
    -- aliases mantidos para consumidores antigos
    'conflicts_open', v_suspensions,
    'absences_this_month', v_absences_this_month,
    'absences_last_month', v_absences_last_month,
    'blocked_by', v_blocked_by
  );
END;
$function$;

-- Congela a regra financeira que estava vigente antes desta mudanca. Folhas e
-- aulas historicas continuam recebendo exatamente a apuracao mensal anterior;
-- a ofensiva diaria e prospectiva a partir de 20/08/2026.
CREATE OR REPLACE FUNCTION public.teacher_turbo_on_legacy_monthly(
  p_teacher uuid,
  p_date date
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH janela AS (
    SELECT date_trunc('month', p_date)::date - INTERVAL '1 month' AS ini,
           (date_trunc('month', p_date) + INTERVAL '1 month')::date AS fim
  )
  SELECT
    (SELECT count(*) FROM teacher_carteira(p_teacher)) >= 10
    AND EXISTS (
      SELECT 1 FROM class_logs cl WHERE cl.teacher_id = p_teacher
        AND cl.class_date < date_trunc('month', p_date)::date
    )
    AND EXISTS (
      SELECT 1 FROM class_logs cl, janela j WHERE cl.teacher_id = p_teacher
        AND cl.class_date >= date_trunc('month', p_date)::date AND cl.class_date < j.fim
        AND cl.presence NOT IN ('TEACHER_ABSENCE','Falta do Professor')
    )
    AND NOT EXISTS (
      SELECT 1 FROM class_logs cl, janela j WHERE cl.teacher_id = p_teacher
        AND cl.class_date >= j.ini AND cl.class_date < j.fim
        AND cl.presence IN ('TEACHER_ABSENCE','Falta do Professor')
    )
    AND NOT EXISTS (
      SELECT 1 FROM class_logs cl, janela j WHERE cl.teacher_id = p_teacher
        AND cl.class_date >= j.ini AND cl.class_date < j.fim
        AND COALESCE(cl.payment_hold, false)
    )
    AND NOT EXISTS (
      SELECT 1 FROM attendance_confirmations ac, janela j WHERE ac.teacher_id = p_teacher
        AND ac.class_date >= j.ini AND ac.class_date < j.fim
        AND ac.status IN ('CONFLICT','RESOLVED_UNPAID')
    );
$function$;

CREATE OR REPLACE FUNCTION public.teacher_turbo_on(
  p_teacher uuid,
  p_date date DEFAULT public.teacher_turbo_business_date()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_date < DATE '2026-08-20'
      THEN public.teacher_turbo_on_legacy_monthly(p_teacher, p_date)
    ELSE COALESCE((public.teacher_turbo_status_at(p_teacher, p_date)->>'active')::boolean, false)
  END;
$function$;

CREATE OR REPLACE FUNCTION public.teacher_turbo_status(p_teacher uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.teacher_turbo_status_at(p_teacher, public.teacher_turbo_business_date());
$function$;

COMMENT ON FUNCTION public.teacher_turbo_on(uuid, date) IS
  'Antes de 20/08/2026 preserva a apuracao mensal historica; a partir da vigencia usa 10+ alunos, 30 dias corridos sem falta e nenhum TEACHER_NO_SHOW em aberto.';

COMMENT ON FUNCTION public.teacher_turbo_status(uuid) IS
  'Estado atual auditavel do Turbo: carteira, ofensiva, dias restantes/ativos, ultima falta e suspensoes.';

-- -----------------------------------------------------------------------------
-- 5. Decisao da diretoria, versionada e retrocompativel
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_attendance_conflict_v2(
  p_confirmation_id uuid,
  p_verdict text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c public.attendance_confirmations%ROWTYPE;
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant text;
  v_jwt_role text;
  v_verdict text := upper(trim(COALESCE(p_verdict, '')));
  v_pay boolean;
  v_final text;
  v_turbo jsonb;
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

  IF NOT COALESCE(v_role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'), false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;

  SELECT * INTO c
  FROM public.attendance_confirmations
  WHERE id = p_confirmation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  END IF;

  IF v_role = 'SCHOOL_ADMIN' AND c.tenant_id IS DISTINCT FROM v_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;

  IF v_verdict NOT IN ('TEACHER_PRESENT', 'TEACHER_ABSENT', 'PAY', 'DO_NOT_PAY') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'veredito_invalido');
  END IF;

  IF c.status IN ('RESOLVED_PAID', 'RESOLVED_UNPAID') THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', c.status);
  END IF;

  IF c.teacher_id IS NULL
     OR c.tenant_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.profiles p
       WHERE p.id = c.teacher_id
         AND p.role = 'TEACHER'
         AND p.tenant_id = c.tenant_id
     )
     OR (
       c.class_log_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.class_logs cl
         WHERE cl.id = c.class_log_id
           AND cl.tenant_id = c.tenant_id
           AND cl.teacher_id = c.teacher_id
           AND cl.student_id IS NOT DISTINCT FROM c.student_id
       )
     ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'dados_inconsistentes');
  END IF;

  IF NOT COALESCE(c.status IN ('PENDING', 'AWAITING_TEACHER', 'CONFLICT'), false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'estado_invalido',
      'status', c.status
    );
  END IF;

  IF v_verdict IN ('TEACHER_PRESENT', 'TEACHER_ABSENT')
     AND c.student_response IS DISTINCT FROM 'TEACHER_NO_SHOW' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'resposta_incompativel',
      'student_response', c.student_response
    );
  END IF;

  v_pay := v_verdict IN ('TEACHER_PRESENT', 'PAY');
  v_final := CASE WHEN v_pay THEN 'RESOLVED_PAID' ELSE 'RESOLVED_UNPAID' END;

  UPDATE public.attendance_confirmations
     SET status = v_final,
         admin_resolution = p_note,
         resolved_by = v_uid,
         resolved_at = now()
   WHERE id = c.id;

  UPDATE public.class_logs
     SET verification_status = v_final,
         payment_hold = NOT v_pay
   WHERE id = c.class_log_id
     AND tenant_id = c.tenant_id
     AND teacher_id = c.teacher_id
     AND student_id IS NOT DISTINCT FROM c.student_id;

  PERFORM public.teacher_turbo_sync_attendance_dispute(c.id);
  v_turbo := public.teacher_turbo_status(c.teacher_id);

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_final,
    'verdict', v_verdict,
    'turbo_status', v_turbo->>'status',
    'turbo_active', COALESCE((v_turbo->>'active')::boolean, false),
    'turbo_action', CASE
      WHEN c.student_response <> 'TEACHER_NO_SHOW' THEN 'NONE'
      WHEN NOT v_pay THEN 'RESET'
      WHEN v_turbo->>'status' = 'SUSPENDED' THEN 'SUSPENSION_REMAINS'
      WHEN COALESCE((v_turbo->>'active')::boolean, false) THEN 'RESTORED'
      ELSE 'DISPUTE_CLEARED'
    END
  );
END;
$function$;

-- Assinatura antiga mantida para AttendanceDisputes e demais clientes atuais.
-- Em relato TEACHER_NO_SHOW, Pagar = professor inocentado; Nao pagar = falta
-- confirmada. Nos outros conflitos, preserva a semantica financeira anterior.
CREATE OR REPLACE FUNCTION public.resolve_attendance_conflict(
  p_confirmation_id uuid,
  p_pay boolean,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_response text;
  v_verdict text;
BEGIN
  IF p_pay IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'p_pay_obrigatorio');
  END IF;

  SELECT ac.student_response INTO v_response
  FROM public.attendance_confirmations ac
  WHERE ac.id = p_confirmation_id;

  v_verdict := CASE
    WHEN v_response = 'TEACHER_NO_SHOW' AND p_pay THEN 'TEACHER_PRESENT'
    WHEN v_response = 'TEACHER_NO_SHOW' AND NOT p_pay THEN 'TEACHER_ABSENT'
    WHEN p_pay THEN 'PAY'
    ELSE 'DO_NOT_PAY'
  END;

  RETURN public.resolve_attendance_conflict_v2(p_confirmation_id, v_verdict, p_note);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 6. Visao em lote da diretoria
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_teacher_turbo_overview()
RETURNS TABLE(
  teacher_id uuid,
  full_name text,
  tenant_id text,
  turbo_status text,
  turbo_active boolean,
  students_active integer,
  students_required integer,
  students_missing integer,
  streak_days integer,
  days_to_activate integer,
  active_since date,
  active_days integer,
  suspensions_open integer,
  suspension_since timestamptz,
  last_absence_on date,
  blocked_by text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_tenant text;
  v_jwt_role text;
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

  IF NOT COALESCE(v_role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'), false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id,
         p.full_name,
         p.tenant_id,
         s.j->>'status',
         COALESCE((s.j->>'active')::boolean, false),
         COALESCE((s.j->>'students_active')::integer, 0),
         COALESCE((s.j->>'students_required')::integer, 10),
         COALESCE((s.j->>'students_missing')::integer, 10),
         COALESCE((s.j->>'days_clean')::integer, 0),
         COALESCE((s.j->>'days_to_activate')::integer, 30),
         NULLIF(s.j->>'active_since', '')::date,
         COALESCE((s.j->>'active_days')::integer, 0),
         COALESCE((s.j->>'suspensions_open')::integer, 0),
         NULLIF(s.j->>'suspension_since', '')::timestamptz,
         NULLIF(s.j->>'last_confirmed_absence_on', '')::date,
         s.j->>'blocked_by'
  FROM public.profiles p
  CROSS JOIN LATERAL (
    SELECT public.teacher_turbo_status(p.id) AS j
  ) s
  WHERE p.role = 'TEACHER'
    AND COALESCE(p.lifecycle_status, 'active') <> 'offboarded'
    AND (v_role = 'SUPER_ADMIN' OR p.tenant_id = v_tenant)
  ORDER BY p.full_name;
END;
$function$;

COMMENT ON FUNCTION public.list_teacher_turbo_overview() IS
  'Visao tenant-safe da diretoria: Turbo, carteira, dias de ofensiva/restantes/ativos, suspensoes e ultima falta de cada professor.';

-- -----------------------------------------------------------------------------
-- 7. Gatilhos: faltas, relatos e mudancas da carteira
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_teacher_turbo_class_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.teacher_id IS NOT NULL
     AND NEW.class_date IS NOT NULL
     AND NEW.presence IN ('TEACHER_ABSENCE', 'Falta do Professor')
     AND EXISTS (
       SELECT 1
       FROM public.profiles p
       WHERE p.id = NEW.teacher_id
         AND p.role = 'TEACHER'
         AND p.tenant_id = NEW.tenant_id
     )
     AND (
       TG_OP = 'INSERT'
       OR OLD.presence IS DISTINCT FROM NEW.presence
       OR OLD.teacher_id IS DISTINCT FROM NEW.teacher_id
       OR OLD.class_date IS DISTINCT FROM NEW.class_date
     ) THEN
    PERFORM public.teacher_turbo_reset(
      NEW.teacher_id, NEW.class_date, 'ABSENCE_RECORDED',
      'class_log', NEW.id, auth.uid(),
      jsonb_build_object('presence', NEW.presence)
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_teacher_turbo_class_log ON public.class_logs;
CREATE TRIGGER trg_teacher_turbo_class_log
AFTER INSERT OR UPDATE OF presence, tenant_id, teacher_id, class_date
ON public.class_logs
FOR EACH ROW
EXECUTE FUNCTION public.trg_teacher_turbo_class_log();

CREATE OR REPLACE FUNCTION public.trg_teacher_turbo_attendance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.teacher_turbo_sync_attendance_dispute(NEW.id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_teacher_turbo_attendance ON public.attendance_confirmations;
CREATE TRIGGER trg_teacher_turbo_attendance
AFTER INSERT OR UPDATE OF tenant_id, teacher_id, student_id, class_date,
  responded_at, student_response, status, teacher_reported, class_log_id,
  resolved_at, resolved_by, admin_resolution
ON public.attendance_confirmations
FOR EACH ROW
EXECUTE FUNCTION public.trg_teacher_turbo_attendance();

CREATE OR REPLACE FUNCTION public.trg_teacher_turbo_booking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  -- Uma transferencia A->B toca dois snapshots. Ordenar UUID impede que duas
  -- transferencias opostas adquiram os mesmos row locks em ordem inversa.
  FOR r IN
    SELECT DISTINCT x.teacher_id
    FROM (
      VALUES
        (CASE WHEN TG_OP <> 'INSERT' THEN OLD.teacher_id END),
        (CASE WHEN TG_OP <> 'DELETE' THEN NEW.teacher_id END)
    ) AS x(teacher_id)
    WHERE x.teacher_id IS NOT NULL
    ORDER BY x.teacher_id
  LOOP
    PERFORM public.teacher_turbo_refresh_eligibility(r.teacher_id);
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_teacher_turbo_booking ON public.bookings;
CREATE TRIGGER trg_teacher_turbo_booking
AFTER INSERT OR DELETE OR UPDATE OF teacher_id, student_id, status, start_date
ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.trg_teacher_turbo_booking();

CREATE OR REPLACE FUNCTION public.trg_teacher_turbo_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT affected.teacher_id
    FROM (
      SELECT CASE
        WHEN TG_OP <> 'INSERT' AND OLD.role = 'TEACHER' THEN OLD.id
      END AS teacher_id
      UNION ALL
      SELECT CASE
        WHEN TG_OP <> 'DELETE' AND NEW.role = 'TEACHER' THEN NEW.id
      END
      UNION ALL
      SELECT b.teacher_id
      FROM public.bookings b
      WHERE b.teacher_id IS NOT NULL
        AND b.student_id IN (
          CASE WHEN TG_OP <> 'INSERT' THEN OLD.id ELSE NULL END,
          CASE WHEN TG_OP <> 'DELETE' THEN NEW.id ELSE NULL END
        )
    ) affected
    WHERE affected.teacher_id IS NOT NULL
    ORDER BY affected.teacher_id
  LOOP
    IF TG_OP <> 'DELETE'
       AND NEW.role = 'TEACHER'
       AND r.teacher_id = NEW.id THEN
      PERFORM public.teacher_turbo_ensure_state(r.teacher_id);
    END IF;
    PERFORM public.teacher_turbo_refresh_eligibility(r.teacher_id);
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_teacher_turbo_profile ON public.profiles;
CREATE TRIGGER trg_teacher_turbo_profile
AFTER INSERT OR DELETE OR UPDATE OF role, lifecycle_status, full_name, start_date, tenant_id
ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.trg_teacher_turbo_profile();

CREATE OR REPLACE FUNCTION public.trg_teacher_turbo_non_billable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT b.teacher_id
    FROM public.bookings b
    WHERE b.teacher_id IS NOT NULL
      AND b.student_id IN (
        CASE WHEN TG_OP <> 'INSERT' THEN OLD.profile_id ELSE NULL END,
        CASE WHEN TG_OP <> 'DELETE' THEN NEW.profile_id ELSE NULL END
      )
    ORDER BY b.teacher_id
  LOOP
    PERFORM public.teacher_turbo_refresh_eligibility(r.teacher_id);
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_teacher_turbo_non_billable ON public.non_billable_profiles;
CREATE TRIGGER trg_teacher_turbo_non_billable
AFTER INSERT OR DELETE OR UPDATE OF profile_id
ON public.non_billable_profiles
FOR EACH ROW
EXECUTE FUNCTION public.trg_teacher_turbo_non_billable();

-- O release aplica migrations como supabase_admin. Fixar postgres como owner
-- impede que SECURITY DEFINER herde um owner operacional diferente entre
-- ambientes e mantém o mesmo boundary das demais RPCs críticas do projeto.
ALTER FUNCTION public.teacher_turbo_add_event(uuid, text, text, date, text, uuid, uuid, jsonb) OWNER TO postgres;
ALTER FUNCTION public.teacher_turbo_ensure_state(uuid) OWNER TO postgres;
ALTER FUNCTION public.teacher_turbo_student_count(uuid) OWNER TO postgres;
ALTER FUNCTION public.teacher_turbo_refresh_eligibility(uuid, date) OWNER TO postgres;
ALTER FUNCTION public.teacher_turbo_reset(uuid, date, text, text, uuid, uuid, jsonb) OWNER TO postgres;
ALTER FUNCTION public.teacher_turbo_sync_attendance_dispute(uuid) OWNER TO postgres;
ALTER FUNCTION public.teacher_turbo_status_at(uuid, date) OWNER TO postgres;
ALTER FUNCTION public.teacher_turbo_on_legacy_monthly(uuid, date) OWNER TO postgres;
ALTER FUNCTION public.teacher_turbo_on(uuid, date) OWNER TO postgres;
ALTER FUNCTION public.teacher_turbo_status(uuid) OWNER TO postgres;
ALTER FUNCTION public.resolve_attendance_conflict_v2(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.resolve_attendance_conflict(uuid, boolean, text) OWNER TO postgres;
ALTER FUNCTION public.list_teacher_turbo_overview() OWNER TO postgres;
ALTER FUNCTION public.trg_teacher_turbo_class_log() OWNER TO postgres;
ALTER FUNCTION public.trg_teacher_turbo_attendance() OWNER TO postgres;
ALTER FUNCTION public.trg_teacher_turbo_booking() OWNER TO postgres;
ALTER FUNCTION public.trg_teacher_turbo_profile() OWNER TO postgres;
ALTER FUNCTION public.trg_teacher_turbo_non_billable() OWNER TO postgres;

-- Funcoes internas nao sao endpoints. SECURITY DEFINER em public sem revoke
-- seria executavel por anon/authenticated por padrao.
REVOKE ALL ON FUNCTION public.teacher_turbo_business_date() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_add_event(uuid, text, text, date, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_ensure_state(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_student_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_refresh_eligibility(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_reset(uuid, date, text, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_sync_attendance_dispute(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_status_at(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_on_legacy_monthly(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_teacher_turbo_class_log() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_teacher_turbo_attendance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_teacher_turbo_booking() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_teacher_turbo_profile() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_teacher_turbo_non_billable() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.teacher_turbo_business_date() TO service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_add_event(uuid, text, text, date, text, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_ensure_state(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_student_count(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_refresh_eligibility(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_reset(uuid, date, text, text, uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_sync_attendance_dispute(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_status_at(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_on_legacy_monthly(uuid, date) TO service_role;

REVOKE ALL ON FUNCTION public.teacher_turbo_on(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.teacher_turbo_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_on(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.teacher_turbo_status(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.resolve_attendance_conflict_v2(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_attendance_conflict(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_teacher_turbo_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_conflict_v2(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_conflict(uuid, boolean, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_teacher_turbo_overview() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
