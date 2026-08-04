-- Gasto de conta de anúncio no caixa.
--
-- Diferente de despesa recorrente, gasto de anúncio do mês corrente é um valor
-- QUE CRESCE: reimportar dia 10 e dia 20 não é duplicata, é o mesmo gasto mais
-- alto. Por isso aqui não basta "não duplicar" — a segunda importação tem de
-- ATUALIZAR o lançamento, e não criar um segundo.
--
-- A chave é (tenant, origem, conta, período). Uma linha de controle por chave,
-- apontando para o lançamento no caixa; o valor do lançamento é sobrescrito.
--
-- ⚠️ Limite honesto de escopo: o MCP de anúncios roda na SESSÃO DO AGENTE, não
-- dentro do produto. A VPS não tem token do Meta nem chama MCP. Então esta RPC é
-- a porta de entrada — quem lê a conta e chama é um agente (ou um integrador
-- futuro com token próprio). Ela não busca nada sozinha, e não finge que busca.

CREATE TABLE IF NOT EXISTS public.ad_spend_imports (
  tenant_id   text NOT NULL,
  origem      text NOT NULL,           -- 'meta', 'google', …
  account_id  text NOT NULL,
  periodo     text NOT NULL CHECK (periodo ~ '^\d{4}-\d{2}$'),
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
  transaction_id uuid REFERENCES public.financial_transactions(id) ON DELETE SET NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by uuid,
  PRIMARY KEY (tenant_id, origem, account_id, periodo)
);

COMMENT ON TABLE public.ad_spend_imports IS
  'Controle de importação de gasto de anúncio. Uma linha por conta/mês; reimportar ATUALIZA o lançamento no caixa em vez de criar outro.';

ALTER TABLE public.ad_spend_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_spend_imports_read ON public.ad_spend_imports;
CREATE POLICY ad_spend_imports_read ON public.ad_spend_imports
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                   AND p.role IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR')
                   AND (p.role = 'SUPER_ADMIN' OR p.tenant_id = ad_spend_imports.tenant_id)));
GRANT SELECT ON public.ad_spend_imports TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.post_ad_spend(
  p_origem text, p_account_id text, p_periodo text, p_amount numeric,
  p_descricao text DEFAULT NULL, p_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_role text; v_tenant text; v_tx uuid; v_anterior numeric;
  v_desc text; v_data date; v_acao text;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt_role IN ('anon','authenticated') THEN
    IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
    IF v_role = 'SUPER_ADMIN' THEN v_tenant := COALESCE(p_tenant, v_tenant); END IF;
  ELSE
    v_tenant := COALESCE(p_tenant, v_tenant);
  END IF;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('error','escola_nao_identificada'); END IF;

  IF COALESCE(btrim(p_origem),'') = '' OR COALESCE(btrim(p_account_id),'') = '' THEN
    RETURN jsonb_build_object('error','origem_ou_conta_obrigatoria');
  END IF;
  IF p_periodo IS NULL OR p_periodo !~ '^\d{4}-\d{2}$' THEN
    RETURN jsonb_build_object('error','periodo_invalido');
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN
    RETURN jsonb_build_object('error','valor_invalido');
  END IF;

  v_desc := COALESCE(NULLIF(btrim(p_descricao),''),
                     'Anúncios ' || btrim(p_origem) || ' · conta ' || btrim(p_account_id));
  -- Último dia do período: o gasto do mês pertence ao mês, e datar no dia 1
  -- faria o lançamento parecer anterior às aulas que ele gerou.
  v_data := (date_trunc('month', (p_periodo || '-01')::date) + interval '1 month - 1 day')::date;

  SELECT i.transaction_id, i.amount INTO v_tx, v_anterior
    FROM ad_spend_imports i
   WHERE i.tenant_id = v_tenant AND i.origem = btrim(p_origem)
     AND i.account_id = btrim(p_account_id) AND i.periodo = p_periodo;

  IF v_tx IS NOT NULL THEN
    UPDATE financial_transactions
       SET amount = p_amount, amount_cents = round(p_amount * 100),
           description = v_desc, occurred_at = v_data::timestamptz,
           account_code = '6.1.03'
     WHERE id = v_tx;
    v_acao := CASE WHEN COALESCE(v_anterior,-1) = p_amount THEN 'inalterado' ELSE 'atualizado' END;
  ELSE
    INSERT INTO financial_transactions
      (tenant_id, type, category, amount, amount_cents, description, occurred_at, account_code)
    VALUES
      (v_tenant, 'SAIDA', 'anuncios', p_amount, round(p_amount * 100), v_desc,
       v_data::timestamptz, '6.1.03')
    RETURNING id INTO v_tx;
    v_acao := 'criado';
  END IF;

  INSERT INTO ad_spend_imports (tenant_id, origem, account_id, periodo, amount, transaction_id, imported_by)
  VALUES (v_tenant, btrim(p_origem), btrim(p_account_id), p_periodo, p_amount, v_tx, auth.uid())
  ON CONFLICT (tenant_id, origem, account_id, periodo) DO UPDATE
    SET amount = EXCLUDED.amount, transaction_id = EXCLUDED.transaction_id,
        imported_at = now(), imported_by = EXCLUDED.imported_by;

  RETURN jsonb_build_object('ok', true, 'acao', v_acao, 'periodo', p_periodo,
                            'valor', p_amount, 'valor_anterior', v_anterior,
                            'transaction_id', v_tx);
END;
$function$;

COMMENT ON FUNCTION public.post_ad_spend(text,text,text,numeric,text,text) IS
  'Lança (ou atualiza) o gasto de uma conta de anúncio no caixa como SAIDA em 6.1.03 Marketing. Reimportar o mesmo período sobrescreve o valor — gasto de mês em curso cresce, não duplica.';

REVOKE ALL ON FUNCTION public.post_ad_spend(text,text,text,numeric,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_ad_spend(text,text,text,numeric,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_ad_spend_imports()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'origem', i.origem, 'account_id', i.account_id, 'periodo', i.periodo,
             'amount', i.amount, 'imported_at', i.imported_at)
           ORDER BY i.periodo DESC, i.origem)
      FROM ad_spend_imports i WHERE i.tenant_id = v_tenant), '[]'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.list_ad_spend_imports() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_ad_spend_imports() TO authenticated;
