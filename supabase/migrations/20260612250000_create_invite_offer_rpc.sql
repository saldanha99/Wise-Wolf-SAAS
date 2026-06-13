-- Convites de professor/vendedor eram base64 cru com hourlyRate/commissionRate
-- confiados server-side (register-teacher/register-vendor) → o convidado editava o
-- payload e se cadastrava com a taxa/comissão que quisesse. Fix: o gerador grava o
-- payload AUTORITATIVO num offer server-side (esta RPC) e o link leva só o offer_id;
-- as edges leem a taxa do offer (service_role), não do payload do cliente.
-- As edges register-teacher/register-vendor aceitam offer_id (UUID) OU base64 legado.
CREATE OR REPLACE FUNCTION public.create_invite_offer(p_kind text, p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_role   text := _my_role();
  v_tenant text := COALESCE(NULLIF(p_payload->>'tenantId',''), _my_tenant_id());
  v_id     uuid;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
    RAISE EXCEPTION 'forbidden: role % cannot create invites', v_role;
  END IF;
  IF p_kind NOT IN ('VENDOR_INVITE','TEACHER_INVITE') THEN
    RAISE EXCEPTION 'invalid invite kind %', p_kind;
  END IF;
  INSERT INTO offers (kind, tenant_id, payload, expires_at, created_by)
  VALUES (p_kind, v_tenant, p_payload, now() + interval '7 days', auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_invite_offer(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invite_offer(text, jsonb) TO authenticated;
