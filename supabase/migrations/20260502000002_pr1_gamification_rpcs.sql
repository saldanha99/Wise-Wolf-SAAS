-- ============================================================================
-- PR1 Part C: Gamification RPCs (SM-2 algorithm, XP recording, streak logic)
-- Idempotent, reversible. Safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. RPC: record_xp_event — Idempotent XP recording via dedupe_key
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_xp_event(
    p_student_id    UUID,
    p_tenant_id     TEXT,
    p_source        TEXT,
    p_amount        INTEGER,
    p_ref_id        TEXT DEFAULT NULL,
    p_dedupe_key    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_config RECORD;
    v_event_id UUID;
    v_actual_amount INTEGER;
    v_daily_xp INTEGER;
    v_goal RECORD;
    v_streak RECORD;
BEGIN
    -- 1. Check gamification is enabled for tenant
    SELECT * INTO v_config FROM public.tenant_xp_config
    WHERE tenant_id = p_tenant_id;

    IF v_config IS NULL OR NOT v_config.gamification_enabled THEN
        RETURN jsonb_build_object('success', false, 'error', 'GAMIFICATION_DISABLED');
    END IF;

    -- 2. Resolve actual amount from config if available
    v_actual_amount := CASE p_source
        WHEN 'ATTENDANCE' THEN COALESCE(v_config.xp_attendance, p_amount)
        WHEN 'HOMEWORK' THEN COALESCE(v_config.xp_homework, p_amount)
        WHEN 'SRS_CORRECT' THEN COALESCE(v_config.xp_srs_correct, p_amount)
        WHEN 'SRS_STREAK' THEN COALESCE(v_config.xp_srs_streak_5, p_amount)
        WHEN 'WARMUP' THEN COALESCE(v_config.xp_warmup, p_amount)
        WHEN 'TRIAL_CONVERTED' THEN COALESCE(v_config.xp_trial_converted, p_amount)
        WHEN 'REFERRAL' THEN COALESCE(v_config.xp_referral_converted, p_amount)
        ELSE p_amount
    END;

    -- 3. Idempotent insert
    INSERT INTO public.xp_events (student_id, tenant_id, source, amount, ref_id, dedupe_key)
    VALUES (p_student_id, p_tenant_id, p_source, v_actual_amount, p_ref_id,
            COALESCE(p_dedupe_key, p_source || ':' || COALESCE(p_ref_id, gen_random_uuid()::text)))
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_event_id;

    IF v_event_id IS NULL THEN
        -- Already recorded (idempotent)
        RETURN jsonb_build_object('success', true, 'deduplicated', true);
    END IF;

    -- 4. Check daily goal progress
    SELECT SUM(amount) INTO v_daily_xp
    FROM public.xp_events
    WHERE student_id = p_student_id
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo');

    SELECT * INTO v_goal FROM public.student_daily_goals
    WHERE student_id = p_student_id;

    -- 5. Update streak if daily goal met
    IF v_goal IS NOT NULL AND v_daily_xp >= v_goal.target_xp THEN
        SELECT * INTO v_streak FROM public.student_streaks
        WHERE student_id = p_student_id FOR UPDATE;

        IF v_streak IS NULL THEN
            INSERT INTO public.student_streaks (student_id, tenant_id, current_streak, longest_streak, last_activity_date)
            VALUES (p_student_id, p_tenant_id, 1, 1, CURRENT_DATE)
            ON CONFLICT (student_id) DO NOTHING;
        ELSIF v_streak.last_activity_date IS NULL OR v_streak.last_activity_date < CURRENT_DATE THEN
            -- Only increment if not already counted today
            IF v_streak.last_activity_date = CURRENT_DATE - 1 THEN
                -- Consecutive day
                UPDATE public.student_streaks SET
                    current_streak = current_streak + 1,
                    longest_streak = GREATEST(longest_streak, current_streak + 1),
                    last_activity_date = CURRENT_DATE,
                    updated_at = now()
                WHERE student_id = p_student_id;
            ELSIF v_streak.last_activity_date < CURRENT_DATE - 1 THEN
                -- Streak broken (freeze logic handled by cron)
                UPDATE public.student_streaks SET
                    current_streak = 1,
                    last_activity_date = CURRENT_DATE,
                    updated_at = now()
                WHERE student_id = p_student_id;
            END IF;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'event_id', v_event_id,
        'amount', v_actual_amount,
        'daily_xp', v_daily_xp,
        'goal_met', (v_goal IS NOT NULL AND v_daily_xp >= v_goal.target_xp)
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. RPC: review_srs_card — SM-2 algorithm simplified
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.review_srs_card(
    p_card_id       UUID,
    p_student_id    UUID,
    p_quality       INTEGER  -- 0=Errei, 3=Difícil, 4=Bom, 5=Fácil
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_card RECORD;
    v_new_ef NUMERIC(4,2);
    v_new_interval INTEGER;
    v_new_reps INTEGER;
    v_new_lapses INTEGER;
    v_new_status TEXT;
    v_tenant_id TEXT;
BEGIN
    -- 1. Fetch and lock card
    SELECT * INTO v_card FROM public.student_srs_cards
    WHERE id = p_card_id AND student_id = p_student_id
    FOR UPDATE;

    IF v_card IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_FOUND');
    END IF;

    -- Get tenant for XP
    SELECT tenant_id INTO v_tenant_id FROM public.profiles WHERE id = p_student_id;

    -- 2. SM-2 Algorithm
    IF p_quality < 3 THEN
        -- Failed: reset
        v_new_reps := 0;
        v_new_interval := 0;
        v_new_lapses := v_card.lapses + 1;
        v_new_ef := GREATEST(1.30, v_card.ease_factor - 0.20);
        v_new_status := 'LEARNING';
    ELSE
        -- Passed
        v_new_lapses := v_card.lapses;
        v_new_reps := v_card.repetitions + 1;

        -- Calculate new ease factor
        v_new_ef := v_card.ease_factor + (0.1 - (5 - p_quality) * (0.08 + (5 - p_quality) * 0.02));
        v_new_ef := GREATEST(1.30, v_new_ef);

        -- Calculate interval
        IF v_new_reps = 1 THEN
            v_new_interval := 1;
        ELSIF v_new_reps = 2 THEN
            v_new_interval := 6;
        ELSE
            v_new_interval := CEIL(v_card.interval_days * v_new_ef);
        END IF;

        -- Status
        IF v_new_interval > 21 AND v_new_reps >= 5 THEN
            v_new_status := 'MASTERED';
        ELSE
            v_new_status := 'REVIEWING';
        END IF;
    END IF;

    -- 3. Update card
    UPDATE public.student_srs_cards SET
        ease_factor = v_new_ef,
        interval_days = v_new_interval,
        repetitions = v_new_reps,
        lapses = v_new_lapses,
        status = v_new_status,
        next_review_at = now() + make_interval(days => v_new_interval),
        last_reviewed_at = now()
    WHERE id = p_card_id;

    -- 4. Award XP if correct
    IF p_quality >= 3 AND v_tenant_id IS NOT NULL THEN
        PERFORM public.record_xp_event(
            p_student_id,
            v_tenant_id,
            'SRS_CORRECT',
            5,
            v_card.vocab_item_id::text,
            'srs:' || p_card_id || ':' || CURRENT_DATE
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'new_interval', v_new_interval,
        'new_ease', v_new_ef,
        'new_status', v_new_status,
        'next_review', (now() + make_interval(days => v_new_interval))
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RPC: check_and_unlock_achievements — Called after XP events
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_and_unlock_achievements(
    p_student_id UUID,
    p_tenant_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_streak RECORD;
    v_mastered_count INTEGER;
    v_referral_count INTEGER;
    v_attendance_streak INTEGER;
    v_unlocked TEXT[] := '{}';
BEGIN
    -- Get streak
    SELECT * INTO v_streak FROM public.student_streaks WHERE student_id = p_student_id;

    -- Check FIRST_WEEK (7-day streak)
    IF v_streak IS NOT NULL AND v_streak.current_streak >= 7 THEN
        INSERT INTO public.student_achievements (student_id, achievement_code)
        VALUES (p_student_id, 'FIRST_WEEK')
        ON CONFLICT (student_id, achievement_code) DO NOTHING;
        IF FOUND THEN v_unlocked := array_append(v_unlocked, 'FIRST_WEEK'); END IF;
    END IF;

    -- Check FULL_MONTH (30-day streak)
    IF v_streak IS NOT NULL AND v_streak.current_streak >= 30 THEN
        INSERT INTO public.student_achievements (student_id, achievement_code)
        VALUES (p_student_id, 'FULL_MONTH')
        ON CONFLICT (student_id, achievement_code) DO NOTHING;
        IF FOUND THEN v_unlocked := array_append(v_unlocked, 'FULL_MONTH'); END IF;
    END IF;

    -- Check CENTURY (100 mastered SRS cards)
    SELECT COUNT(*) INTO v_mastered_count
    FROM public.student_srs_cards
    WHERE student_id = p_student_id AND status = 'MASTERED';

    IF v_mastered_count >= 100 THEN
        INSERT INTO public.student_achievements (student_id, achievement_code)
        VALUES (p_student_id, 'CENTURY')
        ON CONFLICT (student_id, achievement_code) DO NOTHING;
        IF FOUND THEN v_unlocked := array_append(v_unlocked, 'CENTURY'); END IF;
    END IF;

    -- Check FIRST_REFERRAL and AMBASSADOR
    SELECT COUNT(*) INTO v_referral_count
    FROM public.affiliate_conversions
    WHERE referrer_id = p_student_id AND status = 'REWARD_RELEASED';

    IF v_referral_count >= 1 THEN
        INSERT INTO public.student_achievements (student_id, achievement_code)
        VALUES (p_student_id, 'FIRST_REFERRAL')
        ON CONFLICT (student_id, achievement_code) DO NOTHING;
        IF FOUND THEN v_unlocked := array_append(v_unlocked, 'FIRST_REFERRAL'); END IF;
    END IF;

    IF v_referral_count >= 5 THEN
        INSERT INTO public.student_achievements (student_id, achievement_code)
        VALUES (p_student_id, 'AMBASSADOR')
        ON CONFLICT (student_id, achievement_code) DO NOTHING;
        IF FOUND THEN v_unlocked := array_append(v_unlocked, 'AMBASSADOR'); END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'newly_unlocked', to_jsonb(v_unlocked),
        'total_checked', 5
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. RPC: verify_signature_public — Public verification endpoint (no PII)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_signature_public(p_signature_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sig RECORD;
BEGIN
    SELECT id, contract_hash, signed_at, status, evidence_hmac, pdf_hash,
           is_guardian_signature
    INTO v_sig
    FROM public.enrollment_signatures
    WHERE id = p_signature_id;

    IF v_sig IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'SIGNATURE_NOT_FOUND');
    END IF;

    RETURN jsonb_build_object(
        'valid', true,
        'signature_id', v_sig.id,
        'contract_hash', v_sig.contract_hash,
        'signed_at', v_sig.signed_at,
        'status', v_sig.status,
        'evidence_hmac', v_sig.evidence_hmac,
        'pdf_hash', v_sig.pdf_hash,
        'is_guardian', v_sig.is_guardian_signature
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. GRANTS
-- ────────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.record_xp_event TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_srs_card TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_and_unlock_achievements TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_signature_public TO anon, authenticated, service_role;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION (Rollback)
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.verify_signature_public CASCADE;
-- DROP FUNCTION IF EXISTS public.check_and_unlock_achievements CASCADE;
-- DROP FUNCTION IF EXISTS public.review_srs_card CASCADE;
-- DROP FUNCTION IF EXISTS public.record_xp_event CASCADE;
