-- Aceite de contrato PJ para professor JÁ logado (conta criada sem passar pelo onboarding/quiz).
-- Origem: contas criadas pelo bypass create-teacher-account nascem com contract_accepted=false
-- e não havia NENHUM caminho de regularização. Ex.: Mateus (120 aulas/jun) operava sem aceite.
-- SECURITY DEFINER: o próprio professor (auth.uid()) registra seu aceite com trilha (IP + assinatura digitada).
-- UI: components/TeacherContractAccept.tsx (modal) + banner no TeacherDashboard.
CREATE OR REPLACE FUNCTION public.accept_teacher_contract(p_typed_signature text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_accepted boolean;
  v_ip text;
  v_sig text := btrim(coalesce(p_typed_signature, ''));
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nao_autenticado');
  END IF;

  SELECT role, contract_accepted INTO v_role, v_accepted
  FROM profiles WHERE id = v_uid;

  IF v_role IS DISTINCT FROM 'TEACHER' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'apenas_professor');
  END IF;

  IF coalesce(v_accepted, false) = true THEN
    RETURN jsonb_build_object('ok', true, 'already', true);
  END IF;

  IF length(v_sig) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'assinatura_invalida');
  END IF;

  -- IP real do cliente via headers propagados pelo PostgREST (x-forwarded-for cai no primeiro IP).
  BEGIN
    v_ip := split_part(coalesce(
      current_setting('request.headers', true)::json->>'x-forwarded-for',
      current_setting('request.headers', true)::json->>'x-real-ip',
      ''), ',', 1);
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  UPDATE profiles SET
    contract_accepted = true,
    accepted_at = now(),
    typed_signature = v_sig,
    signature_ip = nullif(v_ip, ''),
    signature_hash = encode(digest(v_uid::text || '|' || v_sig || '|' || now()::text, 'sha256'), 'hex')
  WHERE id = v_uid;

  RETURN jsonb_build_object('ok', true, 'accepted_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.accept_teacher_contract(text) FROM public;
GRANT EXECUTE ON FUNCTION public.accept_teacher_contract(text) TO authenticated;
