-- ============================================================================
-- PR1 Part D: Prospect Promotion + Credit Engine RPCs
-- Idempotent, reversible. Safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. RPC: promote_prospect_to_student — Atomic prospect→profile conversion
--    Called ONLY by Asaas webhook on PAYMENT_CONFIRMED of first invoice.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.promote_prospect_to_student(
    p_prospect_id   UUID,
    p_payment_id    TEXT,
    p_auth_user_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prospect RECORD;
    v_tent_enroll RECORD;
    v_signature RECORD;
    v_profile_id UUID;
    v_enrollment_id UUID;
    v_affiliate_code RECORD;
    v_conversion_id UUID;
    v_settings RECORD;
BEGIN
    -- 1. Lock and fetch prospect
    SELECT * INTO v_prospect FROM public.prospects
    WHERE id = p_prospect_id FOR UPDATE;

    IF v_prospect IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'PROSPECT_NOT_FOUND');
    END IF;

    -- Idempotency: already promoted
    IF v_prospect.promoted_at IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', true,
            'already_promoted', true,
            'profile_id', v_prospect.promoted_to_id
        );
    END IF;

    -- 2. Fetch tentative enrollment
    SELECT * INTO v_tent_enroll FROM public.tentative_enrollments
    WHERE prospect_id = p_prospect_id
      AND status IN ('SIGNED', 'PAYMENT_PENDING')
    ORDER BY created_at DESC LIMIT 1
    FOR UPDATE;

    IF v_tent_enroll IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'NO_TENTATIVE_ENROLLMENT');
    END IF;

    -- 3. Fetch signature
    SELECT * INTO v_signature FROM public.enrollment_signatures
    WHERE prospect_id = p_prospect_id
    ORDER BY signed_at DESC LIMIT 1;

    -- 4. Set profile_id from auth user
    v_profile_id := p_auth_user_id;

    INSERT INTO public.profiles (
        id, full_name, email, phone, role, tenant_id,
        monthly_fee, due_day, class_frequency,
        status_financial, guardian_id,
        created_at
    ) VALUES (
        v_profile_id,
        v_prospect.full_name,
        v_prospect.email,
        v_prospect.phone,
        'STUDENT',
        v_prospect.tenant_id,
        v_tent_enroll.monthly_fee,
        v_tent_enroll.due_day,
        v_tent_enroll.classes_per_week,
        'ACTIVE',
        CASE WHEN v_prospect.guardian_id IS NOT NULL THEN v_prospect.guardian_id ELSE NULL END,
        now()
    );

    -- 5. Update tentative enrollment
    UPDATE public.tentative_enrollments SET
        status = 'ENROLLED',
        converted_to_enrollment_id = v_profile_id,
        updated_at = now()
    WHERE id = v_tent_enroll.id;

    -- 6. Handle affiliate conversion
    IF v_prospect.referrer_code IS NOT NULL THEN
        SELECT * INTO v_affiliate_code FROM public.affiliate_codes
        WHERE code = v_prospect.referrer_code AND active = true;

        IF v_affiliate_code IS NOT NULL THEN
            -- Get tenant settings
            SELECT * INTO v_settings FROM public.tenant_referral_settings
            WHERE tenant_id = v_prospect.tenant_id;

            -- Anti-fraud: self-referral check
            IF v_affiliate_code.owner_id::text != v_profile_id::text THEN
                INSERT INTO public.affiliate_conversions (
                    affiliate_code_id, referrer_id, referred_id,
                    tenant_id, status, payment_id,
                    reward_amount_brl
                ) VALUES (
                    v_affiliate_code.id,
                    v_affiliate_code.owner_id,
                    v_profile_id,
                    v_prospect.tenant_id,
                    'PAYMENT_CONFIRMED',
                    p_payment_id,
                    COALESCE(v_settings.reward_amount_brl, 25.00)
                )
                ON CONFLICT (referred_id, tenant_id) DO NOTHING
                RETURNING id INTO v_conversion_id;

                -- Release reward if conversion was created
                IF v_conversion_id IS NOT NULL THEN
                    PERFORM public.release_affiliate_reward(v_conversion_id);
                END IF;
            END IF;
        END IF;
    END IF;

    -- 7. Mark prospect as promoted
    UPDATE public.prospects SET
        promoted_at = now(),
        promoted_to_id = v_profile_id,
        status = 'ENROLLED',
        updated_at = now()
    WHERE id = p_prospect_id;

    RETURN jsonb_build_object(
        'success', true,
        'profile_id', v_profile_id,
        'enrollment_id', v_tent_enroll.id,
        'conversion_id', v_conversion_id
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. RPC: apply_credits_to_invoice — Consume available credits for a bill
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_credits_to_invoice(
    p_student_id    UUID,
    p_invoice_id    TEXT,
    p_invoice_amount NUMERIC(10,2)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_credit RECORD;
    v_remaining NUMERIC(10,2) := p_invoice_amount;
    v_total_applied NUMERIC(10,2) := 0;
    v_credits_applied INTEGER := 0;
BEGIN
    -- Idempotency: check if already applied
    IF EXISTS (
        SELECT 1 FROM public.student_credits
        WHERE applied_to_invoice_id = p_invoice_id
    ) THEN
        SELECT COALESCE(SUM(amount), 0) INTO v_total_applied
        FROM public.student_credits
        WHERE applied_to_invoice_id = p_invoice_id;

        RETURN jsonb_build_object(
            'success', true,
            'already_applied', true,
            'discount', v_total_applied
        );
    END IF;

    -- Consume credits oldest-first, up to invoice amount
    FOR v_credit IN
        SELECT id, amount FROM public.student_credits
        WHERE student_id = p_student_id
          AND applied_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;

        IF v_credit.amount <= v_remaining THEN
            -- Fully consume this credit
            UPDATE public.student_credits SET
                applied_to_invoice_id = p_invoice_id,
                applied_at = now()
            WHERE id = v_credit.id;

            v_remaining := v_remaining - v_credit.amount;
            v_total_applied := v_total_applied + v_credit.amount;
        ELSE
            -- Partially consume: split the credit
            -- Mark original as applied with partial amount
            UPDATE public.student_credits SET
                amount = v_remaining,
                applied_to_invoice_id = p_invoice_id,
                applied_at = now()
            WHERE id = v_credit.id;

            -- Create remainder credit
            INSERT INTO public.student_credits (
                student_id, tenant_id, amount, source, source_ref, expires_at
            )
            SELECT student_id, tenant_id, v_credit.amount - v_remaining,
                   source, source_ref || ':remainder:' || gen_random_uuid(),
                   expires_at
            FROM public.student_credits WHERE id = v_credit.id;

            v_total_applied := v_total_applied + v_remaining;
            v_remaining := 0;
        END IF;

        v_credits_applied := v_credits_applied + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'discount', v_total_applied,
        'credits_consumed', v_credits_applied,
        'remaining_invoice', v_remaining
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RPC: expire_stale_conversions — Called by daily cron
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.expire_stale_conversions()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_expired_count INTEGER := 0;
    v_prospect RECORD;
    v_settings RECORD;
BEGIN
    FOR v_prospect IN
        SELECT p.id, p.tenant_id, p.referrer_code, p.created_at
        FROM public.prospects p
        WHERE p.status IN ('VERIFIED', 'TRIAL_SCHEDULED', 'TRIAL_DONE')
          AND p.promoted_at IS NULL
    LOOP
        SELECT * INTO v_settings FROM public.tenant_referral_settings
        WHERE tenant_id = v_prospect.tenant_id;

        IF v_settings IS NOT NULL AND
           v_prospect.created_at < now() - make_interval(
               days => COALESCE(v_settings.trial_to_signup_window_days, 30)
           )
        THEN
            UPDATE public.prospects SET
                status = 'EXPIRED',
                updated_at = now()
            WHERE id = v_prospect.id;

            v_expired_count := v_expired_count + 1;

            -- Notify referrer via outbox if they have a code
            IF v_prospect.referrer_code IS NOT NULL THEN
                INSERT INTO public.outbox_messages (
                    channel, destination, payload, status,
                    tenant_id, correlation_id
                )
                SELECT
                    'whatsapp',
                    prof.phone,
                    jsonb_build_object(
                        'type', 'REFERRAL_EXPIRED',
                        'prospect_name', (SELECT full_name FROM public.prospects WHERE id = v_prospect.id),
                        'text', '⏳ Sua indicação expirou. Convide-o novamente!'
                    ),
                    'PENDING',
                    v_prospect.tenant_id,
                    v_prospect.id
                FROM public.affiliate_codes ac
                JOIN public.profiles prof ON prof.id = ac.owner_id
                WHERE ac.code = v_prospect.referrer_code
                LIMIT 1;
            END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'expired_count', v_expired_count);
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. GRANTS
-- ────────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.promote_prospect_to_student TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_credits_to_invoice TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_stale_conversions TO service_role;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION (Rollback)
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.expire_stale_conversions CASCADE;
-- DROP FUNCTION IF EXISTS public.apply_credits_to_invoice CASCADE;
-- DROP FUNCTION IF EXISTS public.promote_prospect_to_student CASCADE;
