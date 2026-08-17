-- Contas a pagar pelo grupo de gestao, sempre com confirmacao em dois passos.
--
-- A Edge Function guarda a intencao em gestao_acao_pendente e repete valor,
-- vencimento e classificacao no WhatsApp. Somente o "sim" seguinte chega a
-- esta RPC. O request_id da mensagem original torna a execucao idempotente:
-- retry do webhook nao pode duplicar uma despesa.

CREATE TABLE IF NOT EXISTS public.gestao_finance_action_receipts (
  tenant_id   text NOT NULL,
  request_id  text NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('conta_avulsa','conta_recorrente')),
  requested_by text,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id),
  CONSTRAINT gestao_finance_request_id_size
    CHECK (length(request_id) BETWEEN 8 AND 200)
);

COMMENT ON TABLE public.gestao_finance_action_receipts IS
  'Recibo idempotente de lancamentos financeiros confirmados no grupo de gestao.';

ALTER TABLE public.gestao_finance_action_receipts ENABLE ROW LEVEL SECURITY;
-- Sem policy: apenas a Edge Function, via service_role, usa os recibos.
GRANT SELECT, INSERT, UPDATE ON public.gestao_finance_action_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.gestao_lanca_conta(
  p_tenant text,
  p_request_id text,
  p_recorrente boolean,
  p_descricao text,
  p_valor numeric,
  p_account_code text,
  p_due_date date,
  p_start_month text DEFAULT NULL,
  p_pedido_por text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_claim_role text;
  v_allowed boolean;
  v_kind text;
  v_inserted int;
  v_start_month text;
  v_current_month text := to_char(current_date, 'YYYY-MM');
  v_day int;
  v_recurring_id uuid;
  v_transaction_id uuid;
  v_result jsonb;
  v_teto numeric := 10000;
BEGIN
  v_claim_role := COALESCE(
    current_setting('request.jwt.claims', true)::json->>'role', ''
  );
  IF v_claim_role <> 'service_role' THEN
    RETURN jsonb_build_object('error','somente_pelo_assistente');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN
    RETURN jsonb_build_object('error','escola_invalida');
  END IF;
  IF length(COALESCE(p_request_id,'')) NOT BETWEEN 8 AND 200 THEN
    RETURN jsonb_build_object('error','request_id_invalido');
  END IF;
  IF COALESCE(btrim(p_descricao),'') = '' THEN
    RETURN jsonb_build_object('error','descricao_obrigatoria');
  END IF;
  IF p_valor IS NULL OR p_valor <= 0 THEN
    RETURN jsonb_build_object('error','valor_invalido');
  END IF;
  IF p_valor > v_teto THEN
    RETURN jsonb_build_object('error','acima_do_teto','teto',v_teto);
  END IF;
  IF p_due_date IS NULL THEN
    RETURN jsonb_build_object('error','vencimento_obrigatorio');
  END IF;

  SELECT ledger_allowed, kind INTO v_allowed, v_kind
    FROM dre_accounts
   WHERE code = p_account_code AND is_active;
  IF v_allowed IS NULL OR v_kind NOT IN ('CUSTO','DESPESA','DEDUCAO') THEN
    RETURN jsonb_build_object('error','conta_invalida');
  END IF;
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('error','conta_de_fonte_automatica');
  END IF;

  IF COALESCE(p_recorrente, false) THEN
    v_day := extract(day from p_due_date)::int;
    IF v_day NOT BETWEEN 1 AND 28 THEN
      RETURN jsonb_build_object('error','dia_invalido');
    END IF;
    v_start_month := COALESCE(p_start_month, to_char(p_due_date,'YYYY-MM'));
    IF v_start_month !~ '^\d{4}-\d{2}$' THEN
      RETURN jsonb_build_object('error','mes_inicial_invalido');
    END IF;
  END IF;

  -- Reserva o request_id antes de escrever dinheiro. Em duas confirmacoes
  -- simultaneas, a PK faz uma esperar a outra e somente uma cria lancamento.
  INSERT INTO gestao_finance_action_receipts
    (tenant_id, request_id, action_type, requested_by, result)
  VALUES
    (p_tenant, p_request_id,
     CASE WHEN COALESCE(p_recorrente,false) THEN 'conta_recorrente' ELSE 'conta_avulsa' END,
     NULLIF(left(btrim(COALESCE(p_pedido_por,'')), 80), ''),
     '{"processing":true}'::jsonb)
  ON CONFLICT (tenant_id, request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT result INTO v_result
      FROM gestao_finance_action_receipts
     WHERE tenant_id = p_tenant AND request_id = p_request_id;
    RETURN COALESCE(v_result, '{}'::jsonb) || jsonb_build_object('ok',true,'duplicado',true);
  END IF;

  IF COALESCE(p_recorrente, false) THEN
    INSERT INTO recurring_expenses
      (tenant_id, label, amount, account_code, day_of_month, start_month,
       is_active, notes)
    VALUES
      (p_tenant, btrim(p_descricao), p_valor, p_account_code, v_day,
       v_start_month, true,
       'Cadastrada pelo grupo de gestao' ||
         CASE WHEN NULLIF(btrim(COALESCE(p_pedido_por,'')), '') IS NOT NULL
           THEN ' por ' || left(btrim(p_pedido_por),80) ELSE '' END)
    RETURNING id INTO v_recurring_id;

    -- Se ja vigora, materializa o mes atual agora. Nos meses seguintes o cron
    -- idempotente run_recurring_expenses assume o trabalho.
    IF v_start_month <= v_current_month THEN
      INSERT INTO financial_transactions
        (tenant_id, type, category, amount, amount_cents, description,
         occurred_at, account_code, recurring_expense_id, recurring_month)
      VALUES
        (p_tenant, 'SAIDA', 'despesa_recorrente', p_valor,
         round(p_valor * 100), btrim(p_descricao),
         make_date(extract(year from current_date)::int,
                   extract(month from current_date)::int, v_day)::timestamptz,
         p_account_code, v_recurring_id, v_current_month)
      RETURNING id INTO v_transaction_id;
    END IF;

    v_result := jsonb_build_object(
      'ok', true, 'tipo', 'conta_recorrente',
      'recurring_expense_id', v_recurring_id,
      'transaction_id', v_transaction_id,
      'mes_lancado', CASE WHEN v_transaction_id IS NOT NULL THEN v_current_month ELSE NULL END
    );
  ELSE
    INSERT INTO financial_transactions
      (tenant_id, type, category, amount, amount_cents, description,
       occurred_at, account_code)
    VALUES
      (p_tenant, 'SAIDA', 'conta_pagar_avulsa', p_valor,
       round(p_valor * 100), btrim(p_descricao),
       p_due_date::timestamptz, p_account_code)
    RETURNING id INTO v_transaction_id;

    v_result := jsonb_build_object(
      'ok', true, 'tipo', 'conta_avulsa',
      'transaction_id', v_transaction_id
    );
  END IF;

  UPDATE gestao_finance_action_receipts
     SET result = v_result
   WHERE tenant_id = p_tenant AND request_id = p_request_id;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.gestao_lanca_conta(text,text,boolean,text,numeric,text,date,text,text) IS
  'Lanca conta avulsa ou recorrente confirmada no grupo de gestao; service_role, tenant-scoped e idempotente por request_id.';

REVOKE ALL ON FUNCTION public.gestao_lanca_conta(text,text,boolean,text,numeric,text,date,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gestao_lanca_conta(text,text,boolean,text,numeric,text,date,text,text) TO service_role;
