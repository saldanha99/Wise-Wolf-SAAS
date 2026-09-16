-- Cobertura de aula que JÁ aconteceu, pelo grupo da Gestão.
--
-- O caso (16/09/2026): o professor acordou com a garganta inflamada e a
-- Débora deu a aula. À tarde, no grupo, a direção pediu a cobertura e ouviu
-- "precisa ser para uma aula que ainda não começou". A aula ficou no
-- financeiro de quem não a deu, e a diferença só apareceria se alguém
-- lembrasse dela no fechamento.
--
-- A regra: quem atesta é a direção. Para aula futura, nada muda (convite ao
-- substituto, aceite pelo link). Para aula que já começou, a cobertura nasce
-- CONFIRMADA em nome de quem pediu (`confirmed_by`) e `apply_coverage_acceptance`
-- — a MESMA rotina do aceite — move o lançamento existente para o substituto
-- ou deixa o lançamento futuro com ele, recalculando o fechamento dos dois.
-- Aula por aula, o realizado do mês vai se afastando do previsto pela agenda
-- exatamente pelo que foi coberto — que é o que o fechamento no grupo mostra.
--
-- Limites: 31 dias para trás; mês já fechado (`teacher_closings.status <>
-- 'PENDENTE'`) recusa com `mes_fechado`. Grade declarada do substituto só é
-- exigida no convite: para aula dada, o fato vale mais que o cadastro.
-- Achado no caminho (16/09/2026): `teacher_absences` tem CHECKs criados fora do
-- repositório (reason enum, status maiúsculo) e a RPC gravava texto livre +
-- 'active' — ou seja, nenhuma cobertura pelo grupo jamais passou do insert da
-- ausência (0 linhas em `teacher_absences`, 0 coberturas com `request_id`).
-- Corrigido aqui e nos dois escritores do painel (`coverage-admin`,
-- `AbsenceCoverageManager`).
-- Re-executável: roda a cada release.

alter table public.class_coverages
  add column if not exists confirmed_by uuid references auth.users(id) on delete set null;
comment on column public.class_coverages.confirmed_by is
  'Quem atestou a cobertura sem convite (direção, aula já dada). NULL = o substituto aceitou pelo link.';

CREATE OR REPLACE FUNCTION public.gestao_create_coverage_invite(p_tenant text, p_actor_id uuid, p_booking_id uuid, p_cover_teacher_id uuid, p_class_date date, p_class_time text, p_reason text, p_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
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
  v_retroactive boolean := false;
  v_apply jsonb;
  v_original_phone text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service_role_required';
  END IF;

  IF p_tenant IS NULL OR p_booking_id IS NULL
     OR p_cover_teacher_id IS NULL OR p_class_date IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  END IF;
  -- Janela: 31 dias para trás (aula que JÁ aconteceu e foi coberta) e 90 para
  -- a frente (convite). Antes, "hoje" era o mínimo e a hora de início tinha de
  -- ser futura — a cobertura de uma aula dada de manhã pela substituta era
  -- recusada à tarde, e a aula seguia no financeiro de quem não a deu.
  IF p_class_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date - 31
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
  IF v_actor_role IS NULL AND NOT private.management_group_execution_authorized(p_tenant, p_actor_id, p_request_id,
    jsonb_build_object('tipo','cobertura_aula','booking_id',p_booking_id,'cover_teacher_id',p_cover_teacher_id,'class_date',p_class_date,'class_time',p_class_time,'motivo',p_reason)) THEN
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
  -- Aula que já começou: a direção ATESTA que o substituto deu a aula. Não há
  -- convite a aceitar — a cobertura nasce confirmada e o financeiro é aplicado
  -- na hora (lançamento existente muda de professor; futuro lançamento é do
  -- substituto). O aviso aos dois professores fica com quem chamou.
  v_retroactive := v_class_start <= now();
  IF v_retroactive AND EXISTS (
    SELECT 1
      FROM public.teacher_closings AS closing
     WHERE closing.tenant_id = p_tenant
       AND closing.month_year = to_char(p_class_date, 'YYYY-MM')
       AND closing.teacher_id IN (
         (SELECT booking.teacher_id FROM public.bookings AS booking WHERE booking.id = p_booking_id),
         p_cover_teacher_id
       )
       AND closing.status <> 'PENDENTE'
  ) THEN
    -- Mês já fechado/pago: mover a aula agora criaria diferença que nenhum
    -- relatório mostraria. Ajuste manual no fechamento, com rastro.
    RETURN jsonb_build_object('ok', false, 'error', 'mes_fechado');
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

  -- Grade declarada só vale para convite: para aula que já aconteceu, o fato
  -- de a substituta ter dado a aula vale mais do que a disponibilidade
  -- cadastrada (mesma regra da remarcação de experimental).
  IF NOT v_retroactive AND NOT EXISTS (
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

  -- "Substituto ocupado" protege o CONVITE (não mandar alguém para um horário
  -- tomado). Para aula já dada, a direção atesta o fato: a substituta pode ter
  -- dado a própria aula às 09:30 e a coberta às 10:00 — a cobertura fica
  -- amarrada ao booking (é o que identifica a aula para o pagamento) e o
  -- horário real vai no motivo.
  IF NOT v_retroactive AND (EXISTS (
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
  )) THEN
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
    -- `teacher_absences` tem CHECK: reason IN (SICK, VACATION, PERSONAL, OTHER)
    -- e status em MAIÚSCULA (constraints criadas direto no banco, fora do
    -- repositório). A versão anterior gravava texto livre e 'active' — todo
    -- pedido de cobertura pelo grupo morria aqui, no primeiro uso. O texto
    -- livre vai para `notes`; o enum é derivado dele.
    INSERT INTO public.teacher_absences (
      tenant_id, teacher_id, starts_at, ends_at, reason, notes, status
    ) VALUES (
      p_tenant, v_booking.teacher_id, p_class_date, p_class_date,
      CASE WHEN btrim(p_reason) ~* '(doen|garganta|febre|gripe|sa[uú]de|m[eé]dic|hospital|enferm|covid|sick|dor )'
           THEN 'SICK' ELSE 'OTHER' END,
      btrim(p_reason), 'ACTIVE'
    )
    RETURNING * INTO v_absence;
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.class_coverages (
    tenant_id, original_teacher_id, cover_teacher_id, student_id,
    booking_id, absence_id, class_date, class_time, status, token,
    notes, dispatched_at, request_id, invite_expires_at,
    confirmed_at, confirmed_by
  ) VALUES (
    p_tenant, v_booking.teacher_id, p_cover_teacher_id, v_booking.student_id,
    p_booking_id, v_absence.id, p_class_date, v_time,
    CASE WHEN v_retroactive THEN 'confirmed' ELSE 'pending' END,
    CASE WHEN v_retroactive THEN NULL ELSE v_token END,
    btrim(p_reason), NULL, left(btrim(p_request_id), 200),
    CASE WHEN v_retroactive THEN NULL
         ELSE least(v_class_start, now() + interval '48 hours') END,
    CASE WHEN v_retroactive THEN now() END,
    CASE WHEN v_retroactive THEN p_actor_id END
  )
  RETURNING * INTO v_coverage;

  IF v_retroactive THEN
    v_apply := public.apply_coverage_acceptance(v_coverage.id);
    IF coalesce((v_apply ->> 'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'coverage_financial_application_failed';
    END IF;
    SELECT CASE
             WHEN length(regexp_replace(
               coalesce(profile.attendance_phone, ''), '[^0-9]', '', 'g'
             )) BETWEEN 10 AND 15 THEN profile.attendance_phone
             WHEN length(regexp_replace(
               coalesce(profile.phone, ''), '[^0-9]', '', 'g'
             )) BETWEEN 10 AND 15 THEN profile.phone
             ELSE NULL
           END
      INTO v_original_phone
      FROM public.profiles AS profile
     WHERE profile.id = v_booking.teacher_id;
  END IF;

  INSERT INTO public.audit_logs (
    tenant_id, user_id, user_role, action, resource_type, resource_id,
    new_values
  ) VALUES (
    p_tenant, p_actor_id, v_actor_role,
    CASE WHEN v_retroactive
         THEN 'coverage_registered_retroactively_via_management_group'
         ELSE 'coverage_requested_via_management_group' END,
    'class_coverage',
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
    'retroactive', v_retroactive,
    'application', v_apply,
    'original_teacher_phone', v_original_phone,
    'token', CASE WHEN v_retroactive THEN NULL ELSE v_token END,
    'class_date', p_class_date,
    'class_time', v_time,
    'student_name', btrim(v_student_name),
    'original_teacher_name', btrim(v_original_name),
    'cover_teacher_name', btrim(v_cover_name),
    'cover_teacher_phone', v_cover_phone
  );
END;
$function$
;

-- Trigger de integridade da cobertura: mesma função de produção, com o ramo
-- atestado. Os marcadores que `gestao_management_agent_hardening.sql` procura
-- (active_coverage_slot_conflict etc.) continuam aqui.
CREATE OR REPLACE FUNCTION public.enforce_active_class_coverage_slot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_time text;
  v_day_number integer;
  v_day_name text;
  v_class_start timestamptz;
  -- Cobertura ATESTADA pela direção (aula já dada, sem convite): nasce
  -- confirmada com `confirmed_by`. Para ela valem as regras inversas — a aula
  -- tem de já ter começado — e não valem grade nem conflito de agenda do
  -- substituto: o fato de ele ter dado a aula vale mais que o cadastro.
  v_retroactive boolean;
BEGIN
  IF pg_catalog.lower(coalesce(NEW.status, ''))
       NOT IN ('pending', 'confirmed') THEN
    RETURN NEW;
  END IF;
  v_retroactive := NEW.confirmed_by IS NOT NULL
    AND pg_catalog.lower(NEW.status) = 'confirmed';
  IF TG_OP = 'INSERT' AND NEW.confirmed_by IS NOT NULL
     AND pg_catalog.lower(NEW.status) <> 'confirmed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'retroactive_coverage_must_be_confirmed';
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
  IF v_retroactive THEN
    IF v_class_start > pg_catalog.now()
       OR NEW.class_date <
          (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date - 31 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'retroactive_coverage_window';
    END IF;
  ELSIF v_class_start <= pg_catalog.now() THEN
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
  ) OR (NOT v_retroactive AND NOT EXISTS (
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
  )) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'active_coverage_member_unavailable';
  END IF;

  IF NOT v_retroactive AND (EXISTS (
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
  )) THEN
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
