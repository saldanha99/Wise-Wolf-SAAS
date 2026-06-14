-- Leitura pública do offer de convite (vendedor/professor) para exibição na
-- onboarding (convidado ainda não autenticado). NÃO consome — o consumo ocorre na
-- edge register-* no sucesso do cadastro. Espelha get_offer_public, mas p/ convites.
CREATE OR REPLACE FUNCTION public.get_invite_offer_public(p_offer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE o offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM offers WHERE id = p_offer_id AND kind IN ('VENDOR_INVITE','TEACHER_INVITE');
  IF NOT FOUND               THEN RETURN jsonb_build_object('error','OFFER_NOT_FOUND'); END IF;
  IF o.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('error','OFFER_CONSUMED'); END IF;
  IF o.revoked_at  IS NOT NULL THEN RETURN jsonb_build_object('error','OFFER_REVOKED'); END IF;
  IF o.expires_at <= now()     THEN RETURN jsonb_build_object('error','OFFER_EXPIRED'); END IF;
  RETURN COALESCE(o.payload,'{}'::jsonb) || jsonb_build_object('kind', o.kind, '_offerId', o.id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_invite_offer_public(uuid) TO anon, authenticated;
