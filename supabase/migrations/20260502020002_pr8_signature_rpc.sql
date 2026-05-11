-- ============================================================================
-- Migration: PR8 Signature RPCs
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────────────────────
-- RPC: submit_enrollment_signature
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_enrollment_signature(
    p_tenant_id UUID,
    p_prospect_id UUID,
    p_tentative_enrollment_id UUID,
    p_contract_text TEXT,
    p_contract_hash TEXT,
    p_signer_full_name TEXT,
    p_signer_cpf TEXT,
    p_signer_email TEXT,
    p_signer_phone TEXT,
    p_signer_ip INET,
    p_signer_user_agent TEXT,
    p_signer_geo JSONB,
    p_otp_method TEXT,
    p_otp_code TEXT,
    p_acceptance_text TEXT,
    p_visual_signature_data TEXT,
    p_evidence_payload JSONB,
    p_evidence_hmac TEXT,
    p_is_guardian_signature BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_otp_valid BOOLEAN := false;
    v_otp_token RECORD;
    v_signature_id UUID;
    v_cpf_hash TEXT;
    v_cpf_encrypted BYTEA;
BEGIN
    -- 1. Validate OTP
    SELECT * INTO v_otp_token
    FROM public.otp_tokens
    WHERE target_id = p_prospect_id
      AND target_type = 'PROSPECT_VERIFY'
      AND verified_at IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1;

    -- If no verified token found or it was verified more than 2 hours ago, reject
    IF v_otp_token IS NULL OR v_otp_token.verified_at < now() - INTERVAL '2 hours' THEN
        RETURN jsonb_build_object('success', false, 'error', 'OTP_NOT_VERIFIED_OR_EXPIRED');
    END IF;

    -- 2. Hash & Encrypt CPF
    v_cpf_hash := encode(digest(p_signer_cpf, 'sha256'), 'hex');
    -- A simple symmetric encryption for CPF (in a real scenario, use a specific KMS key)
    v_cpf_encrypted := pgp_sym_encrypt(p_signer_cpf, current_setting('app.settings.encryption_key', true));

    -- 3. Insert Signature
    INSERT INTO public.enrollment_signatures (
        tenant_id,
        prospect_id,
        tentative_enrollment_id,
        contract_text,
        contract_hash,
        signer_full_name,
        signer_cpf_hash,
        signer_cpf_encrypted,
        signer_email,
        signer_phone,
        signer_ip,
        signer_user_agent,
        signer_geo,
        otp_method,
        otp_verified_at,
        acceptance_text,
        visual_signature_data,
        evidence_payload,
        evidence_hmac,
        is_guardian_signature,
        status
    ) VALUES (
        p_tenant_id,
        p_prospect_id,
        p_tentative_enrollment_id,
        p_contract_text,
        p_contract_hash,
        p_signer_full_name,
        v_cpf_hash,
        v_cpf_encrypted,
        p_signer_email,
        p_signer_phone,
        p_signer_ip,
        p_signer_user_agent,
        p_signer_geo,
        p_otp_method,
        v_otp_token.verified_at,
        p_acceptance_text,
        p_visual_signature_data,
        p_evidence_payload,
        p_evidence_hmac,
        p_is_guardian_signature,
        'SIGNED'
    ) RETURNING id INTO v_signature_id;

    -- 4. Audit Log
    INSERT INTO public.signature_audit_log (signature_id, event, payload, ip_hash)
    VALUES (
        v_signature_id,
        'SIGNATURE_CONFIRMED',
        jsonb_build_object(
            'signer_ip', p_signer_ip,
            'user_agent', p_signer_user_agent,
            'geo', p_signer_geo
        ),
        encode(digest(p_signer_ip::text, 'sha256'), 'hex')
    );

    -- 5. Update Tentative Enrollment
    UPDATE public.tentative_enrollments
    SET status = 'SIGNED'
    WHERE id = p_tentative_enrollment_id;

    RETURN jsonb_build_object('success', true, 'signature_id', v_signature_id);
END;
$$;

COMMIT;
