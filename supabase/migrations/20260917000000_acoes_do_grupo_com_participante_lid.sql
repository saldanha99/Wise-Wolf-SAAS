-- Ações do grupo da Gestão pedidas por participante `@lid` (16/09/2026, noite).
--
-- A Evolution entrega quem escreve no grupo como `99201044238394@lid`, sem
-- telefone: o servidor não acha o perfil e a ação segue com `p_actor_id` NULO.
-- A AUTORIZAÇÃO vem da ação pendente confirmada por código
-- (`private.management_group_execution_authorized`, por `request_id`) — mas as
-- três RPCs da véspera exigiam o uuid: a cobertura do Theo passou pela
-- autorização e morreu no INSERT (`confirmed_by` nulo é "cobertura futura" para
-- o trigger → `active_coverage_already_started`); troca de plano e cobertura do
-- dia recusavam na entrada (`parametros_invalidos`).
--
-- Regra: `v_attester := coalesce(p_actor_id, private.management_group_default_actor(p_tenant))`
-- — a conta do diretor ativo da escola assina a atribuição; a auditoria
-- (`gestao_action_audit`) guarda o jid real de quem pediu.
--
-- Migration nova porque o release recusa editar migration já aplicada
-- (checksum). Re-executável: só `create or replace`.
-- Reproduzido e provado em BEGIN…ROLLBACK na VPS com `p_actor_id := null` e
-- uma linha `executing` em `gestao_acao_pendente`.

create or replace function private.management_group_default_actor(p_tenant text)
returns uuid
language sql
stable
security definer
set search_path to ''
as $$
  select m.user_id
    from public.tenant_memberships m
    join public.profiles p on p.id = m.user_id
   where m.tenant_id = p_tenant
     and m.status = 'ACTIVE'
     and m.role in ('SCHOOL_ADMIN', 'COORDINATOR')
     and lower(coalesce(p.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
   order by case m.role when 'SCHOOL_ADMIN' then 0 else 1 end, m.created_at
   limit 1
$$;
revoke all on function private.management_group_default_actor(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1) Cobertura de aula (inclusive já dada)
-- ---------------------------------------------------------------------------
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
  v_attester uuid;
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
  -- Participante do grupo sem identidade (@lid): a direção assina.
  v_attester := coalesce(p_actor_id, private.management_group_default_actor(p_tenant));
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
    CASE WHEN v_retroactive THEN v_attester END
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
      'attested_by', v_attester,
      'requested_by_group_member', p_actor_id IS NULL,
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

-- ---------------------------------------------------------------------------
-- 2) Troca de plano pelo grupo
-- ---------------------------------------------------------------------------
create or replace function public.gestao_create_plan_change(
  p_tenant text,
  p_actor_id uuid,
  p_request_id text,
  p_tipo text,
  p_student_id uuid,
  p_to_frequency text,
  p_to_fee numeric,
  p_update_pending_payments boolean default true
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor_role text;
  v_student record;
  v_freq text;
  v_existing public.student_plan_changes%rowtype;
  v_row public.student_plan_changes%rowtype;
  v_phone text;
  v_attester uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  -- p_actor_id pode ser NULL (participante @lid do grupo): a autorização vem
  -- da ação pendente confirmada, e a proposta fica em nome da direção.
  if p_tenant is null or p_student_id is null then
    return jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  end if;
  if coalesce(length(btrim(p_request_id)), 0) not between 8 and 200 then
    return jsonb_build_object('ok', false, 'error', 'request_id_invalido');
  end if;
  if p_tipo not in ('mudanca_plano', 'transferencia_professor') then
    return jsonb_build_object('ok', false, 'error', 'tipo_invalido');
  end if;

  v_freq := lower(btrim(coalesce(p_to_frequency, '')));
  if v_freq !~ '^[1-9][0-9]?x$' then
    return jsonb_build_object('ok', false, 'error', 'frequencia_invalida');
  end if;
  if p_to_fee is null or p_to_fee <= 0 or p_to_fee > 100000 then
    return jsonb_build_object('ok', false, 'error', 'valor_invalido');
  end if;

  select membership.role
    into v_actor_role
    from public.tenant_memberships as membership
    join public.profiles as actor on actor.id = membership.user_id
   where membership.user_id = p_actor_id
     and membership.tenant_id = p_tenant
     and membership.status = 'ACTIVE'
     and membership.role in ('SCHOOL_ADMIN', 'COORDINATOR')
     and lower(coalesce(actor.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
   limit 1;
  if v_actor_role is null and not private.management_group_execution_authorized(
       p_tenant, p_actor_id, p_request_id,
       jsonb_build_object(
         'tipo', p_tipo, 'student_id', p_student_id,
         'nova_frequencia', v_freq, 'novo_valor', p_to_fee
       )
     ) then
    raise exception using errcode = '42501', message = 'actor_not_allowed';
  end if;

  -- Idempotência por request_id: o grupo pode reprocessar a mesma confirmação.
  perform pg_advisory_xact_lock(hashtextextended('plan-change-request:' || p_tenant || ':' || left(btrim(p_request_id), 200), 0));
  select * into v_existing
    from public.student_plan_changes
   where tenant_id = p_tenant and request_id = left(btrim(p_request_id), 200)
   for update;
  if found then
    if v_existing.student_id is distinct from p_student_id then
      return jsonb_build_object('ok', false, 'error', 'request_id_em_conflito');
    end if;
    select full_name, coalesce(nullif(attendance_phone, ''), phone) as phone into v_student
      from public.profiles where id = p_student_id;
    return jsonb_build_object(
      'ok', true, 'idempotent', true, 'token', v_existing.token, 'status', v_existing.status,
      'student_name', v_student.full_name, 'student_phone', v_student.phone,
      'from_frequency', v_existing.from_frequency, 'to_frequency', v_existing.to_frequency,
      'from_fee', v_existing.from_monthly_fee, 'to_fee', v_existing.to_monthly_fee
    );
  end if;

  select p.id, p.full_name, p.tenant_id, p.class_frequency, p.monthly_fee, p.fidelity_plan,
         coalesce(nullif(p.attendance_phone, ''), p.phone) as phone
    into v_student
    from public.profiles as p
   where p.id = p_student_id
     and p.role = 'STUDENT'
     and p.tenant_id = p_tenant
     and lower(coalesce(p.lifecycle_status, 'active')) not in ('suspended', 'offboarded');
  if v_student.id is null then
    return jsonb_build_object('ok', false, 'error', 'aluno_invalido');
  end if;
  if v_freq = lower(coalesce(v_student.class_frequency, '')) and p_to_fee = v_student.monthly_fee then
    return jsonb_build_object('ok', false, 'error', 'plano_igual_ao_atual');
  end if;

  -- Uma proposta aberta por aluno (índice uq_plan_change_one_pending): a nova
  -- substitui a anterior, como na tela.
  update public.student_plan_changes
     set status = 'CANCELLED', cancelled_at = now()
   where student_id = p_student_id and status = 'PENDING';

  v_attester := coalesce(p_actor_id, private.management_group_default_actor(p_tenant));

  insert into public.student_plan_changes (
    tenant_id, student_id, created_by,
    from_frequency, to_frequency, from_monthly_fee, to_monthly_fee, fidelity_plan,
    update_pending_payments, request_id
  ) values (
    p_tenant, p_student_id, v_attester,
    v_student.class_frequency, v_freq, v_student.monthly_fee, p_to_fee, v_student.fidelity_plan,
    coalesce(p_update_pending_payments, true), left(btrim(p_request_id), 200)
  )
  returning * into v_row;

  insert into public.audit_logs (tenant_id, user_id, user_role, action, resource_type, resource_id, new_values)
  values (
    p_tenant, p_actor_id, v_actor_role,
    'plan_change_proposed_via_management_group', 'student_plan_change', v_row.id::text,
    jsonb_build_object(
      'student_id', p_student_id, 'from_frequency', v_student.class_frequency, 'to_frequency', v_freq,
      'from_fee', v_student.monthly_fee, 'to_fee', p_to_fee, 'via', p_tipo,
      'attested_by', v_attester, 'requested_by_group_member', p_actor_id is null,
      'request_id', left(btrim(p_request_id), 200)
    )
  );

  return jsonb_build_object(
    'ok', true, 'token', v_row.token, 'status', v_row.status,
    'expires_at', v_row.expires_at,
    'student_name', v_student.full_name, 'student_phone', v_student.phone,
    'from_frequency', v_student.class_frequency, 'to_frequency', v_freq,
    'from_fee', v_student.monthly_fee, 'to_fee', p_to_fee
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3) Cobertura do dia (oportunidade para vários)
-- ---------------------------------------------------------------------------
create or replace function public.gestao_open_coverage_day(
  p_tenant text,
  p_actor_id uuid,
  p_request_id text,
  p_teacher_id uuid,
  p_date date,
  p_reason text,
  p_source text default 'group'
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor_role text;
  v_teacher record;
  v_absence public.teacher_absences%rowtype;
  v_booking record;
  v_opp public.coverage_opportunities%rowtype;
  v_start timestamptz;
  v_dow_name text;
  v_items jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_invites jsonb;
  v_cand record;
  v_inv public.coverage_opportunity_invites%rowtype;
  v_student_name text;
  v_attester uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  -- p_actor_id pode ser NULL (participante @lid do grupo; ver
  -- private.management_group_default_actor).
  if p_tenant is null or p_teacher_id is null or p_date is null then
    return jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  end if;
  if coalesce(length(btrim(p_request_id)), 0) not between 8 and 200 then
    return jsonb_build_object('ok', false, 'error', 'request_id_invalido');
  end if;
  if p_source not in ('group', 'teacher') then
    return jsonb_build_object('ok', false, 'error', 'origem_invalida');
  end if;
  if p_date < (now() at time zone 'America/Sao_Paulo')::date
     or p_date > (now() at time zone 'America/Sao_Paulo')::date + 14 then
    return jsonb_build_object('ok', false, 'error', 'data_fora_da_janela');
  end if;
  if coalesce(length(btrim(p_reason)), 0) not between 3 and 200 then
    return jsonb_build_object('ok', false, 'error', 'motivo_invalido');
  end if;

  v_attester := coalesce(p_actor_id, private.management_group_default_actor(p_tenant));

  select t.id, t.full_name into v_teacher
    from public.profiles t
    join public.tenant_memberships m on m.user_id = t.id and m.tenant_id = p_tenant and m.role = 'TEACHER' and m.status = 'ACTIVE'
   where t.id = p_teacher_id and t.role = 'TEACHER' and t.tenant_id = p_tenant
     and lower(coalesce(t.lifecycle_status, 'active')) not in ('suspended', 'offboarded');
  if v_teacher.id is null then
    return jsonb_build_object('ok', false, 'error', 'professor_invalido');
  end if;

  -- Aval: direção/coordenação, ação confirmada no grupo, ou o próprio professor
  -- atestando a própria ausência (porta da instância da escola).
  select membership.role into v_actor_role
    from public.tenant_memberships membership
    join public.profiles actor on actor.id = membership.user_id
   where membership.user_id = p_actor_id and membership.tenant_id = p_tenant
     and membership.status = 'ACTIVE' and membership.role in ('SCHOOL_ADMIN', 'COORDINATOR')
     and lower(coalesce(actor.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
   limit 1;
  if v_actor_role is null and p_source = 'teacher' and p_actor_id = p_teacher_id then
    v_actor_role := 'TEACHER';
  end if;
  if v_actor_role is null and not private.management_group_execution_authorized(
       p_tenant, p_actor_id, p_request_id,
       jsonb_build_object('tipo', 'cobertura_dia', 'teacher_id', p_teacher_id, 'data', p_date::text)
     ) then
    raise exception using errcode = '42501', message = 'actor_not_allowed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('coverage-day:' || p_tenant || ':' || left(btrim(p_request_id), 200), 0));

  -- Reprocessamento da mesma confirmação: devolve o que já existe, sem reenviar.
  if exists (select 1 from public.coverage_opportunities o where o.tenant_id = p_tenant and o.request_id = left(btrim(p_request_id), 200)) then
    select jsonb_agg(jsonb_build_object(
             'opportunity_id', o.id, 'status', o.status, 'class_time', o.class_time,
             'student_name', s.full_name, 'invites', '[]'::jsonb))
      into v_items
      from public.coverage_opportunities o left join public.profiles s on s.id = o.student_id
     where o.tenant_id = p_tenant and o.request_id = left(btrim(p_request_id), 200);
    return jsonb_build_object('ok', true, 'idempotent', true, 'teacher_name', v_teacher.full_name,
                              'opportunities', coalesce(v_items, '[]'::jsonb), 'skipped', '[]'::jsonb);
  end if;

  -- Ausência do dia (mesmo formato dos outros escritores: enum + MAIÚSCULA).
  select * into v_absence from public.teacher_absences a
   where a.tenant_id = p_tenant and a.teacher_id = p_teacher_id and lower(a.status) = 'active'
     and a.starts_at::date <= p_date and a.ends_at::date >= p_date
   order by a.created_at limit 1 for update;
  if not found then
    insert into public.teacher_absences (tenant_id, teacher_id, starts_at, ends_at, reason, notes, status)
    values (p_tenant, p_teacher_id, p_date, p_date,
            case when btrim(p_reason) ~* '(doen|garganta|febre|gripe|sa[uú]de|m[eé]dic|hospital|enferm|covid|sick|dor )' then 'SICK' else 'OTHER' end,
            btrim(p_reason), 'ACTIVE')
    returning * into v_absence;
  end if;

  v_dow_name := (array['Domingo','Segunda','Terca','Quarta','Quinta','Sexta','Sabado'])[extract(dow from p_date)::int + 1];

  for v_booking in
    select b.id, b.student_id, left(coalesce(b.time_slot, ''), 5) as slot
      from public.bookings b
     where b.tenant_id = p_tenant and b.teacher_id = p_teacher_id and b.student_id is not null
       and upper(coalesce(b.status, '')) = 'SCHEDULED'
       and (b.date = p_date
            or (b.date is null and public.fold_accents(b.day_of_week) = lower(v_dow_name)
                and (b.start_date is null or b.start_date <= p_date)))
     order by left(coalesce(b.time_slot, ''), 5)
  loop
    select full_name into v_student_name from public.profiles where id = v_booking.student_id;
    v_start := (p_date::text || ' ' || v_booking.slot || ':00-03')::timestamptz;
    if v_booking.slot !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' or v_start <= now() + interval '5 minutes' then
      v_skipped := v_skipped || jsonb_build_object('student_name', v_student_name, 'class_time', v_booking.slot, 'motivo', 'ja_comecou');
      continue;
    end if;
    if exists (select 1 from public.class_coverages cc where cc.tenant_id = p_tenant and cc.booking_id = v_booking.id and cc.class_date = p_date
                 and (lower(cc.status) = 'confirmed' or (lower(cc.status) = 'pending' and now() < coalesce(cc.invite_expires_at, v_start))))
       or exists (select 1 from public.coverage_opportunities o where o.booking_id = v_booking.id and o.class_date = p_date and o.status = 'OPEN') then
      v_skipped := v_skipped || jsonb_build_object('student_name', v_student_name, 'class_time', v_booking.slot, 'motivo', 'ja_tem_cobertura');
      continue;
    end if;

    insert into public.coverage_opportunities (
      tenant_id, booking_id, original_teacher_id, student_id, absence_id, class_date, class_time,
      reason, source, request_id, created_by, expires_at
    ) values (
      p_tenant, v_booking.id, p_teacher_id, v_booking.student_id, v_absence.id, p_date, v_booking.slot,
      btrim(p_reason), p_source, left(btrim(p_request_id), 200), v_attester, v_start - interval '5 minutes'
    ) returning * into v_opp;

    v_invites := '[]'::jsonb;
    for v_cand in select * from private.coverage_candidates(p_tenant, v_booking.id, p_date) where phone is not null loop
      insert into public.coverage_opportunity_invites (opportunity_id, teacher_id, phone)
      values (v_opp.id, v_cand.teacher_id, v_cand.phone)
      returning * into v_inv;
      v_invites := v_invites || jsonb_build_object(
        'invite_id', v_inv.id, 'token', v_inv.token, 'teacher_id', v_cand.teacher_id,
        'teacher_name', v_cand.full_name, 'phone', v_cand.phone);
    end loop;
    if jsonb_array_length(v_invites) = 0 then
      update public.coverage_opportunities set status = 'EXPIRED' where id = v_opp.id;
    end if;

    v_items := v_items || jsonb_build_object(
      'opportunity_id', v_opp.id, 'status', case when jsonb_array_length(v_invites) = 0 then 'EXPIRED' else 'OPEN' end,
      'class_time', v_booking.slot, 'student_name', v_student_name, 'invites', v_invites);
  end loop;

  insert into public.audit_logs (tenant_id, user_id, user_role, action, resource_type, resource_id, new_values)
  values (p_tenant, p_actor_id, v_actor_role, 'coverage_day_opened', 'teacher_absence', v_absence.id::text,
          jsonb_build_object('teacher_id', p_teacher_id, 'date', p_date, 'source', p_source,
                             'attested_by', v_attester, 'requested_by_group_member', p_actor_id is null,
                             'opportunities', jsonb_array_length(v_items), 'request_id', left(btrim(p_request_id), 200)));

  return jsonb_build_object('ok', true, 'teacher_name', v_teacher.full_name, 'absence_id', v_absence.id,
                            'opportunities', v_items, 'skipped', v_skipped);
end;
$function$;
