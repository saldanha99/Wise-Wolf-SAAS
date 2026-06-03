-- ─────────────────────────────────────────────────────────────────────────────
-- Transferência de aluno entre professores (com aceite do novo professor, via link)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.teacher_transfers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       text NOT NULL,
    student_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    from_teacher_id uuid REFERENCES public.profiles(id),
    to_teacher_id   uuid NOT NULL REFERENCES public.profiles(id),
    proposed_slots  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{day_of_week:"Segunda", time_slot:"18:00"}]
    cutover_date    date NOT NULL,
    reason          text,
    status          text NOT NULL DEFAULT 'PENDING',      -- PENDING/ACCEPTED/DECLINED/APPLIED/CANCELLED
    decline_reason  text,
    token           text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    decided_at      timestamptz,
    applied_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_teacher_transfers_due
    ON public.teacher_transfers (status, cutover_date)
    WHERE status = 'ACCEPTED';
CREATE INDEX IF NOT EXISTS idx_teacher_transfers_student ON public.teacher_transfers (student_id);

ALTER TABLE public.teacher_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tt_admin_all ON public.teacher_transfers;
CREATE POLICY tt_admin_all ON public.teacher_transfers
    FOR ALL
    USING (tenant_id = _my_tenant_id() AND _my_role() = ANY (ARRAY['SCHOOL_ADMIN','SUPER_ADMIN']))
    WITH CHECK (tenant_id = _my_tenant_id() AND _my_role() = ANY (ARRAY['SCHOOL_ADMIN','SUPER_ADMIN']));

-- Enfileira WhatsApp pela instância CENTRAL da escola (SCHOOL_ADMIN)
CREATE OR REPLACE FUNCTION public._enqueue_school_whatsapp(p_tenant text, p_to_phone text, p_name text, p_msg text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_admin uuid;
BEGIN
    IF p_to_phone IS NULL OR btrim(p_to_phone) = '' THEN RETURN; END IF;
    SELECT id INTO v_admin FROM public.profiles
      WHERE tenant_id = p_tenant AND role IN ('SCHOOL_ADMIN','SUPER_ADMIN')
      ORDER BY role DESC LIMIT 1;
    INSERT INTO public.notification_queue
        (tenant_id, teacher_id, student_name, student_phone, message_body, notification_kind, source_type, status, scheduled_for)
    VALUES (p_tenant, v_admin, p_name, p_to_phone, p_msg, 'TEACHER_TRANSFER', 'teacher_transfer', 'pending', now());
END;
$$;

-- Cria a proposta (admin)
CREATE OR REPLACE FUNCTION public.create_teacher_transfer(
    p_student_id uuid, p_to_teacher uuid, p_slots jsonb, p_cutover date, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_tenant text; v_from uuid; v_token text; v_conflict int;
BEGIN
    SELECT tenant_id, professor_id INTO v_tenant, v_from FROM public.profiles WHERE id = p_student_id;
    IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Aluno não encontrado'); END IF;
    IF NOT (v_tenant = _my_tenant_id() AND _my_role() = ANY (ARRAY['SCHOOL_ADMIN','SUPER_ADMIN'])) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sem permissão');
    END IF;
    IF p_to_teacher = v_from THEN
        RETURN jsonb_build_object('ok', false, 'error', 'O novo professor é o mesmo professor atual');
    END IF;
    IF jsonb_array_length(COALESCE(p_slots, '[]'::jsonb)) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Selecione ao menos um horário');
    END IF;
    SELECT count(*) INTO v_conflict
    FROM jsonb_array_elements(p_slots) s
    JOIN public.bookings b
      ON b.teacher_id = p_to_teacher AND b.day_of_week IS NOT NULL
     AND b.day_of_week = (s->>'day_of_week') AND b.time_slot = (s->>'time_slot');
    IF v_conflict > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'O novo professor já tem aula em um dos horários escolhidos');
    END IF;

    INSERT INTO public.teacher_transfers
        (tenant_id, student_id, from_teacher_id, to_teacher_id, proposed_slots, cutover_date, reason, created_by)
    VALUES (v_tenant, p_student_id, v_from, p_to_teacher, p_slots, p_cutover, p_reason, auth.uid())
    RETURNING token INTO v_token;
    RETURN jsonb_build_object('ok', true, 'token', v_token);
END;
$$;

-- Dados públicos da proposta (página de aceite, por token)
CREATE OR REPLACE FUNCTION public.get_transfer_public(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb;
BEGIN
    SELECT jsonb_build_object(
        'status', t.status, 'student_name', sp.full_name, 'class_frequency', sp.class_frequency,
        'from_teacher', fp.full_name, 'to_teacher', tp.full_name,
        'proposed_slots', t.proposed_slots, 'cutover_date', t.cutover_date, 'reason', t.reason
    ) INTO v
    FROM public.teacher_transfers t
    JOIN public.profiles sp ON sp.id = t.student_id
    LEFT JOIN public.profiles fp ON fp.id = t.from_teacher_id
    JOIN public.profiles tp ON tp.id = t.to_teacher_id
    WHERE t.token = p_token;
    IF v IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    RETURN v;
END;
$$;

-- Aplica a transição (interno)
CREATE OR REPLACE FUNCTION public.apply_teacher_transfer(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE t public.teacher_transfers; v_student RECORD; v_to_name text; v_dir_phone text; v_dir_name text;
BEGIN
    SELECT * INTO t FROM public.teacher_transfers WHERE id = p_id FOR UPDATE;
    IF t.id IS NULL OR t.status NOT IN ('ACCEPTED') THEN RETURN; END IF;

    DELETE FROM public.bookings
     WHERE tenant_id = t.tenant_id AND student_id = t.student_id
       AND teacher_id = t.from_teacher_id AND day_of_week IS NOT NULL;

    INSERT INTO public.bookings (tenant_id, teacher_id, student_id, day_of_week, time_slot, start_date)
    SELECT t.tenant_id, t.to_teacher_id, t.student_id, s->>'day_of_week', s->>'time_slot', t.cutover_date
    FROM jsonb_array_elements(t.proposed_slots) s;

    UPDATE public.profiles SET professor_id = t.to_teacher_id
      WHERE id = t.student_id AND professor_id = t.from_teacher_id;
    UPDATE public.profiles SET professor_id2 = t.to_teacher_id
      WHERE id = t.student_id AND professor_id2 = t.from_teacher_id;

    UPDATE public.teacher_transfers SET status = 'APPLIED', applied_at = now() WHERE id = t.id;

    SELECT full_name, phone INTO v_student FROM public.profiles WHERE id = t.student_id;
    SELECT full_name INTO v_to_name FROM public.profiles WHERE id = t.to_teacher_id;
    PERFORM public._enqueue_school_whatsapp(
        t.tenant_id, v_student.phone, v_student.full_name,
        'Olá ' || COALESCE(v_student.full_name,'') || '! Sua aula foi transferida para o(a) professor(a) ' ||
        COALESCE(v_to_name,'') || ' a partir de ' || to_char(t.cutover_date, 'DD/MM/YYYY') ||
        '. Seus valores e acesso continuam os mesmos. 🐺');
    SELECT phone, full_name INTO v_dir_phone, v_dir_name FROM public.profiles
      WHERE tenant_id = t.tenant_id AND role IN ('SCHOOL_ADMIN','SUPER_ADMIN') ORDER BY role DESC LIMIT 1;
    PERFORM public._enqueue_school_whatsapp(
        t.tenant_id, v_dir_phone, v_dir_name,
        'Transferência aplicada: ' || COALESCE(v_student.full_name,'') || ' agora é aluno(a) de ' ||
        COALESCE(v_to_name,'') || ' (início ' || to_char(t.cutover_date, 'DD/MM/YYYY') || ').');
END;
$$;

-- Resposta do professor (aceitar/recusar), por token
CREATE OR REPLACE FUNCTION public.respond_teacher_transfer(p_token text, p_accept boolean, p_decline_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE t public.teacher_transfers; v_student text; v_to_name text; v_dir_phone text; v_dir_name text;
BEGIN
    SELECT * INTO t FROM public.teacher_transfers WHERE token = p_token FOR UPDATE;
    IF t.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
    IF t.status <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'already_decided', 'status', t.status); END IF;

    IF p_accept THEN
        UPDATE public.teacher_transfers SET status = 'ACCEPTED', decided_at = now() WHERE id = t.id;
        IF t.cutover_date <= current_date THEN PERFORM public.apply_teacher_transfer(t.id); END IF;
        RETURN jsonb_build_object('ok', true, 'status', 'ACCEPTED');
    ELSE
        UPDATE public.teacher_transfers SET status = 'DECLINED', decided_at = now(), decline_reason = p_decline_reason WHERE id = t.id;
        SELECT full_name INTO v_student FROM public.profiles WHERE id = t.student_id;
        SELECT full_name INTO v_to_name FROM public.profiles WHERE id = t.to_teacher_id;
        SELECT phone, full_name INTO v_dir_phone, v_dir_name FROM public.profiles
          WHERE tenant_id = t.tenant_id AND role IN ('SCHOOL_ADMIN','SUPER_ADMIN') ORDER BY role DESC LIMIT 1;
        PERFORM public._enqueue_school_whatsapp(
            t.tenant_id, v_dir_phone, v_dir_name,
            'Transferência RECUSADA por ' || COALESCE(v_to_name,'') || ' (aluno ' || COALESCE(v_student,'') || ')' ||
            CASE WHEN p_decline_reason IS NOT NULL THEN '. Motivo: ' || p_decline_reason ELSE '' END ||
            '. Gere uma nova proposta com outro professor/horário.');
        RETURN jsonb_build_object('ok', true, 'status', 'DECLINED');
    END IF;
END;
$$;

-- Aplica todas as transferências aceitas cuja data já chegou (cron diário)
CREATE OR REPLACE FUNCTION public.apply_due_teacher_transfers()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r record; n int := 0;
BEGIN
    FOR r IN SELECT id FROM public.teacher_transfers WHERE status = 'ACCEPTED' AND cutover_date <= current_date LOOP
        PERFORM public.apply_teacher_transfer(r.id);
        n := n + 1;
    END LOOP;
    RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_transfer_public(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.respond_teacher_transfer(text, boolean, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_teacher_transfer(uuid, uuid, jsonb, date, text) TO authenticated;

-- Cron diário (06:00 BRT = 09:00 UTC) para aplicar as viradas do dia
SELECT cron.schedule('wisewolf-apply-teacher-transfers', '0 9 * * *', $cron$ SELECT public.apply_due_teacher_transfers(); $cron$);
