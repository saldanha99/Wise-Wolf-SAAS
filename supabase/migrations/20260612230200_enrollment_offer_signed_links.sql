-- LINK DE MATRÍCULA ADULTERÁVEL.
-- O gerador colocava preço/cobrança em base64 no URL (?data=) e o PublicRegistration
-- usava monthly_fee = payload.value direto → o aluno editava o base64 e pagava menos.
-- Fix: o gerador grava o payload AUTORITATIVO num offer server-side e o link carrega
-- só o offer_id (UUID aleatório, não forjável); o PublicRegistration lê o preço do
-- servidor via get_offer_public. (Frontend: RegistrationLinkGenerator + PublicRegistration.)

-- Cria a oferta de matrícula (apenas staff). SECURITY DEFINER → ignora RLS de offers.
CREATE OR REPLACE FUNCTION public.create_enrollment_offer(p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_role   text := _my_role();
  v_tenant text := COALESCE(NULLIF(p_payload->>'unitId',''), _my_tenant_id());
  v_id     uuid;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR','TEACHER') THEN
    RAISE EXCEPTION 'forbidden: role % cannot create enrollment offers', v_role;
  END IF;
  INSERT INTO offers (kind, tenant_id, payload, expires_at, created_by, requires_enrollment, enrollment_fee)
  VALUES ('ENROLLMENT', v_tenant, p_payload, now() + interval '30 days', auth.uid(),
          COALESCE((p_payload->>'requiresEnrollment')::boolean, true),
          COALESCE((p_payload->>'enrollmentFee')::numeric, 0))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_enrollment_offer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_enrollment_offer(jsonb) TO authenticated;

-- Leitura pública do payload autoritativo (aluno deslogado abre o link).
-- NÃO consome a oferta — isso ocorre no submit via consume_offer.
CREATE OR REPLACE FUNCTION public.get_offer_public(p_offer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE o offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM offers WHERE id = p_offer_id AND kind = 'ENROLLMENT';
  IF NOT FOUND               THEN RETURN jsonb_build_object('error','OFFER_NOT_FOUND'); END IF;
  IF o.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('error','OFFER_CONSUMED'); END IF;
  IF o.revoked_at  IS NOT NULL THEN RETURN jsonb_build_object('error','OFFER_REVOKED'); END IF;
  IF o.expires_at <= now()     THEN RETURN jsonb_build_object('error','OFFER_EXPIRED'); END IF;
  RETURN COALESCE(o.payload,'{}'::jsonb) || jsonb_build_object('_offerId', o.id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_offer_public(uuid) TO anon, authenticated;
