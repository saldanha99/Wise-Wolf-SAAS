-- Fronteira entre o Wolfie gratuito e o Wolfie premium.
--
-- Até aqui a separação existia só na tela: dois blocos ("Prática livre" e
-- "Chamada ao vivo · premium"). No servidor não havia fronteira nenhuma — o
-- modo clássico gerava voz paga da OpenAI para qualquer aluno, sem limite e
-- sem registro de consumo.
--
-- Regra do produto:
--   GRATUITO  → aluno fala (speech-to-text) e escreve; o Wolfie responde POR
--               ESCRITO. Ilimitado.
--   PREMIUM   → o Wolfie fala: conversa ao vivo (speech-to-speech) e resposta
--               falada no modo clássico.
--
-- Esta migration NÃO altera quem pode entrar na chamada ao vivo. Aquela regra
-- (`wolfie_live_balance`) é fail-open de propósito: escola sem franquia
-- configurada hoje libera o ao vivo, e cortar isso de surpresa tiraria do ar um
-- recurso em uso. O tier informa `live_enforced` para o painel do diretor
-- mostrar que a franquia está aberta, em vez de esconder o fato.

-- ---------------------------------------------------------------------------
-- Snapshot interno. Nunca é exposto direto: as duas funções públicas abaixo é
-- que decidem quem pode perguntar por quem.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.wolfie_tier_snapshot(p_student_id uuid)
RETURNS jsonb
-- Sem STABLE: `wolfie_live_balance` é volátil, e prometer estabilidade aqui
-- seria mentir para o planejador.
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tenant     text;
  v_access     jsonb;
  v_balance    jsonb;
  v_enforced   boolean;
  v_remaining  integer;
  v_credits    integer;
  v_plan_limit integer;
  v_premium    boolean;
  v_live       boolean;
  v_reason     text;
BEGIN
  IF p_student_id IS NULL THEN
    RETURN jsonb_build_object(
      'tier', 'FREE', 'voice_replies', false, 'live_allowed', false,
      'live_enforced', false, 'remaining_minutes', 0, 'reason', 'sem_aluno');
  END IF;

  SELECT p.tenant_id INTO v_tenant
  FROM public.profiles p
  WHERE p.id = p_student_id;

  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object(
      'tier', 'FREE', 'voice_replies', false, 'live_allowed', false,
      'live_enforced', false, 'remaining_minutes', 0, 'reason', 'perfil_ausente');
  END IF;

  -- Assinante direto: a assinatura viva é a única fonte, e ela já é fail-closed.
  IF v_tenant = 'wolfie-direct' THEN
    v_access := private.wolfie_access_snapshot(p_student_id);
    v_premium := COALESCE((v_access ->> 'allowed')::boolean, false);
    RETURN jsonb_build_object(
      'tier',              CASE WHEN v_premium THEN 'PREMIUM' ELSE 'FREE' END,
      'source',            'SUBSCRIPTION',
      'voice_replies',     v_premium,
      'live_allowed',      v_premium,
      'live_enforced',     true,
      'remaining_minutes', 0,
      'plan_code',         v_access ->> 'planCode',
      'reason',            CASE WHEN v_premium THEN 'assinatura_ativa'
                                ELSE COALESCE(v_access ->> 'code', 'sem_assinatura') END);
  END IF;

  -- Aluno de escola: premium é a franquia de minutos que a escola vendeu —
  -- por plano (`student_plan_entitlements`) ou por crédito comprado.
  v_balance    := public.wolfie_live_balance(v_tenant, p_student_id);
  v_enforced   := COALESCE((v_balance ->> 'enforced')::boolean, false);
  v_remaining  := COALESCE((v_balance ->> 'remaining')::integer, 0);
  v_credits    := COALESCE((v_balance ->> 'credits')::integer, 0);
  v_plan_limit := COALESCE((v_balance ->> 'plan_limit')::integer, 0);
  v_live       := COALESCE((v_balance ->> 'allowed')::boolean, true);

  -- Franquia não configurada NÃO é premium: é ausência de decisão comercial.
  -- Tratar como premium daria voz paga a toda a escola de graça, que é
  -- exatamente o custo invisível que esta mudança veio fechar.
  v_premium := v_enforced AND v_remaining > 0;

  v_reason := CASE
    WHEN NOT v_enforced THEN 'franquia_nao_configurada'
    WHEN v_remaining > 0 THEN 'franquia_disponivel'
    ELSE 'franquia_esgotada'
  END;

  RETURN jsonb_build_object(
    'tier',              CASE WHEN v_premium THEN 'PREMIUM' ELSE 'FREE' END,
    'source',            CASE WHEN v_credits > 0 AND v_plan_limit = 0
                              THEN 'CREDITS' ELSE 'SCHOOL_PLAN' END,
    'voice_replies',     v_premium,
    'live_allowed',      v_live,
    'live_enforced',     v_enforced,
    'remaining_minutes', v_remaining,
    'credit_minutes',    v_credits,
    'reason',            v_reason);
EXCEPTION WHEN others THEN
  -- Falhar para GRATUITO: sem certeza de que é premium, não se gasta voz paga.
  RETURN jsonb_build_object(
    'tier', 'FREE', 'voice_replies', false, 'live_allowed', true,
    'live_enforced', false, 'remaining_minutes', 0, 'reason', 'tier_indisponivel');
END;
$$;

COMMENT ON FUNCTION private.wolfie_tier_snapshot(uuid) IS
  'Decide gratuito x premium do Wolfie. voice_replies=false significa que o '
  'Wolfie responde por escrito: a voz paga é do tier premium.';

-- ---------------------------------------------------------------------------
-- Superfície do servidor: as edge functions perguntam pelo aluno.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wolfie_tier_for_student(p_student_id uuid)
RETURNS jsonb
-- Sem STABLE: `wolfie_live_balance` é volátil, e prometer estabilidade aqui
-- seria mentir para o planejador.
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Chamada autenticada só pode perguntar por si mesma; service_role (auth.uid()
  -- nulo) é a edge function e pode perguntar por qualquer aluno.
  IF auth.uid() IS NOT NULL AND p_student_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'sem_permissao';
  END IF;
  RETURN private.wolfie_tier_snapshot(p_student_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Superfície do navegador: o aluno pergunta pelo próprio tier.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_wolfie_tier()
RETURNS jsonb
-- Sem STABLE: `wolfie_live_balance` é volátil, e prometer estabilidade aqui
-- seria mentir para o planejador.
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'nao_autenticado';
  END IF;
  RETURN private.wolfie_tier_snapshot(auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION private.wolfie_tier_snapshot(uuid)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.wolfie_tier_for_student(uuid)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_wolfie_tier()
  FROM public, anon, authenticated;
-- Mesmo desenho de `wolfie_access_for_user`: a função é exposta ao aluno, e a
-- checagem de `auth.uid()` dentro dela é que impede perguntar por outro.
GRANT EXECUTE ON FUNCTION public.wolfie_tier_for_student(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_wolfie_tier() TO authenticated;
