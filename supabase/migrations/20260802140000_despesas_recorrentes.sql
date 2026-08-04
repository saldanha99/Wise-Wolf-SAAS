-- Despesas recorrentes — o cadastro que preenche o lado do custo.
--
-- Estado que motiva esta migration: financial_transactions tem 159 lançamentos,
-- TODOS 'ENTRADA'. Zero saídas. Nenhuma internet, nenhuma assinatura, nenhum
-- imposto. Por isso o DRE de julho reporta 75,9% de margem líquida e dispara o
-- alerta crítico — o número é real para o que existe lançado, e irreal para a
-- escola de verdade.
--
-- Decisão de desenho: a despesa recorrente é um MOLDE, não um saldo. Rodar o
-- gerador materializa o molde como lançamento no caixa. Duas razões:
--   1. get_cashflow e dre_gerencial passam a enxergar a mesma despesa, cada um
--      no seu regime, sem nenhum dos dois precisar conhecer o cadastro.
--   2. O mês real diverge do molde (a internet veio R$ 480, não R$ 450). Com o
--      lançamento materializado o diretor corrige aquele mês sem mexer no molde
--      — que é como a coisa funciona na prática.
-- O DRE lê SÓ o caixa. Se um dia ele passar a ler o cadastro também, dobra.

CREATE TABLE IF NOT EXISTS public.recurring_expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  label        text NOT NULL,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  account_code text NOT NULL REFERENCES public.dre_accounts(code),
  -- Teto 28 de propósito: dia 29/30/31 não existe em todo mês e o gerador
  -- silenciosamente jogaria a despesa para o mês seguinte (ou estouraria em
  -- fevereiro). Vencimento real depois do dia 28 se ajusta no lançamento.
  day_of_month int  NOT NULL DEFAULT 5 CHECK (day_of_month BETWEEN 1 AND 28),
  start_month  text NOT NULL CHECK (start_month ~ '^\d{4}-\d{2}$'),
  -- NULL = vigente por prazo indeterminado.
  end_month    text CHECK (end_month ~ '^\d{4}-\d{2}$'),
  is_active    boolean NOT NULL DEFAULT true,
  notes        text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_expenses_periodo_valido
    CHECK (end_month IS NULL OR end_month >= start_month)
);

CREATE INDEX IF NOT EXISTS idx_recurring_expenses_tenant
  ON public.recurring_expenses (tenant_id) WHERE is_active;

COMMENT ON TABLE public.recurring_expenses IS
  'Molde de despesa mensal fixa. Materializado no caixa por run_recurring_expenses(mes) — o DRE lê o caixa, nunca este cadastro.';

-- Rastro do molde no lançamento -----------------------------------------------
-- ON DELETE SET NULL: apagar o molde não pode apagar (nem órfãos) a despesa que
-- de fato aconteceu — o histórico financeiro fica.
ALTER TABLE public.financial_transactions
  ADD COLUMN IF NOT EXISTS recurring_expense_id uuid
    REFERENCES public.recurring_expenses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recurring_month text;

-- A trava de idempotência é um índice, não um NOT EXISTS na função. O padrão
-- NOT EXISTS (que run_monthly_teacher_closing usa) perde a corrida em dois
-- cliques simultâneos, e despesa dobrada é exatamente o erro que este projeto
-- já cometeu do lado da receita. Aqui o banco recusa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_tx_recurring_mes
  ON public.financial_transactions (recurring_expense_id, recurring_month)
  WHERE recurring_expense_id IS NOT NULL;

ALTER TABLE public.recurring_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recurring_expenses_read ON public.recurring_expenses;
CREATE POLICY recurring_expenses_read ON public.recurring_expenses
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                   AND p.role IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR')
                   AND (p.role = 'SUPER_ADMIN' OR p.tenant_id = recurring_expenses.tenant_id)));
GRANT SELECT ON public.recurring_expenses TO authenticated, service_role;

-- 1. Leitura ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_recurring_expenses()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; v_mes text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;
  v_mes := to_char(current_date,'YYYY-MM');

  RETURN jsonb_build_object(
    'month', v_mes,
    'contas', (SELECT jsonb_agg(jsonb_build_object('code',code,'label',label,'kind',kind) ORDER BY sort_order)
                 FROM dre_accounts WHERE is_active AND ledger_allowed AND kind IN ('CUSTO','DESPESA','DEDUCAO')),
    'despesas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id, 'label', r.label, 'amount', r.amount,
               'account_code', r.account_code, 'account_label', a.label,
               'day_of_month', r.day_of_month,
               'start_month', r.start_month, 'end_month', r.end_month,
               'is_active', r.is_active, 'notes', r.notes,
               -- vigente = ativa E dentro da janela do mês corrente
               'vigente', r.is_active AND r.start_month <= v_mes
                          AND (r.end_month IS NULL OR r.end_month >= v_mes),
               -- já materializada neste mês?
               'lancada_no_mes', EXISTS (SELECT 1 FROM financial_transactions ft
                                          WHERE ft.recurring_expense_id = r.id
                                            AND ft.recurring_month = v_mes))
             ORDER BY a.sort_order, r.label)
        FROM recurring_expenses r JOIN dre_accounts a ON a.code = r.account_code
       WHERE r.tenant_id = v_tenant), '[]'::jsonb),
    'total_mensal', COALESCE((SELECT sum(amount) FROM recurring_expenses
                               WHERE tenant_id = v_tenant AND is_active
                                 AND start_month <= v_mes
                                 AND (end_month IS NULL OR end_month >= v_mes)), 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_recurring_expenses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_recurring_expenses() TO authenticated;

-- 2. Cadastro -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_recurring_expense(
  p_id uuid, p_label text, p_amount numeric, p_account_code text,
  p_day_of_month int DEFAULT 5, p_start_month text DEFAULT NULL,
  p_end_month text DEFAULT NULL, p_notes text DEFAULT NULL,
  p_is_active boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; v_id uuid; v_start text; v_allowed boolean;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;
  IF COALESCE(btrim(p_label),'') = '' THEN RETURN jsonb_build_object('error','label_obrigatorio'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('error','valor_invalido'); END IF;

  -- Conta de fonte autoritativa (repasse, comissão, indicação) não pode virar
  -- despesa recorrente: o valor já entra por competência e o DRE barraria o
  -- lançamento. Recusar aqui evita criar um molde que gera lixo todo mês.
  SELECT ledger_allowed INTO v_allowed FROM dre_accounts WHERE code = p_account_code AND is_active;
  IF v_allowed IS NULL THEN RETURN jsonb_build_object('error','conta_invalida'); END IF;
  IF NOT v_allowed THEN RETURN jsonb_build_object('error','conta_de_fonte_automatica'); END IF;

  v_start := COALESCE(p_start_month, to_char(current_date,'YYYY-MM'));
  IF v_start !~ '^\d{4}-\d{2}$' THEN RETURN jsonb_build_object('error','mes_inicial_invalido'); END IF;
  IF p_end_month IS NOT NULL AND p_end_month !~ '^\d{4}-\d{2}$' THEN
    RETURN jsonb_build_object('error','mes_final_invalido');
  END IF;
  IF p_day_of_month IS NULL OR p_day_of_month NOT BETWEEN 1 AND 28 THEN
    RETURN jsonb_build_object('error','dia_invalido');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO recurring_expenses (tenant_id, label, amount, account_code, day_of_month,
                                    start_month, end_month, notes, is_active, created_by)
    VALUES (v_tenant, btrim(p_label), p_amount, p_account_code, p_day_of_month,
            v_start, p_end_month, p_notes, COALESCE(p_is_active,true), auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE recurring_expenses
       SET label = btrim(p_label), amount = p_amount, account_code = p_account_code,
           day_of_month = p_day_of_month, start_month = v_start, end_month = p_end_month,
           notes = p_notes, is_active = COALESCE(p_is_active,true), updated_at = now()
     WHERE id = p_id AND tenant_id = v_tenant
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RETURN jsonb_build_object('error','nao_encontrada'); END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_recurring_expense(uuid,text,numeric,text,int,text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_recurring_expense(uuid,text,numeric,text,int,text,text,text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_recurring_expense(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; v_n int;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;
  -- Os lançamentos já materializados ficam (ON DELETE SET NULL): a despesa
  -- aconteceu, apagar o molde não desfaz o mês passado.
  DELETE FROM recurring_expenses WHERE id = p_id AND tenant_id = v_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN jsonb_build_object('error','nao_encontrada'); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_recurring_expense(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_recurring_expense(uuid) TO authenticated;

-- 3. Materialização no caixa --------------------------------------------------
-- Chamada de dois lugares com regras de escopo diferentes:
--   * diretor pelo painel  → só o próprio tenant (auth.uid() resolve o papel);
--   * cron (SQL puro, sem JWT) → todos os tenants.
-- Mesmo desenho de run_saas_billing, que o cron já chama direto.
CREATE OR REPLACE FUNCTION public.run_recurring_expenses(
  p_month text DEFAULT NULL, p_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text; v_tenant text; v_month text; v_scope text;
  v_criados int := 0; v_pulados int := 0; v_total numeric := 0;
  r record; v_data date;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();

  IF v_role IS NULL THEN
    -- Sem usuário = cron/service_role: roda para todos (ou o tenant pedido).
    v_scope := p_tenant;
  ELSIF v_role IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    v_scope := CASE WHEN v_role = 'SUPER_ADMIN' THEN COALESCE(p_tenant, v_tenant) ELSE v_tenant END;
  ELSE
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;

  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RETURN jsonb_build_object('error','mes_invalido'); END IF;

  FOR r IN
    SELECT re.* FROM recurring_expenses re
     WHERE re.is_active
       AND (v_scope IS NULL OR re.tenant_id = v_scope)
       AND re.start_month <= v_month
       AND (re.end_month IS NULL OR re.end_month >= v_month)
  LOOP
    v_data := make_date(split_part(v_month,'-',1)::int, split_part(v_month,'-',2)::int, r.day_of_month);

    -- ON CONFLICT no índice único: se já foi materializada, não duplica.
    -- Idempotência garantida pelo banco, não pela ordem das chamadas.
    -- ⚠️ O índice é PARCIAL, então o predicado tem de ser repetido aqui — sem o
    -- WHERE o Postgres não infere o índice e devolve "no unique or exclusion
    -- constraint matching the ON CONFLICT specification". É a mesma pedra em que
    -- uq_bookings_no_dup_active já fez tropeçar.
    INSERT INTO financial_transactions
      (tenant_id, type, category, amount, amount_cents, description,
       occurred_at, account_code, recurring_expense_id, recurring_month)
    VALUES
      (r.tenant_id, 'SAIDA', 'despesa_recorrente', r.amount, round(r.amount * 100),
       r.label, v_data::timestamptz, r.account_code, r.id, v_month)
    ON CONFLICT (recurring_expense_id, recurring_month)
      WHERE recurring_expense_id IS NOT NULL DO NOTHING;

    IF FOUND THEN
      v_criados := v_criados + 1; v_total := v_total + r.amount;
    ELSE
      v_pulados := v_pulados + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'month', v_month,
                            'criados', v_criados, 'ja_existiam', v_pulados,
                            'total_lancado', v_total);
END;
$function$;

COMMENT ON FUNCTION public.run_recurring_expenses(text,text) IS
  'Materializa as despesas recorrentes vigentes como SAIDA no caixa. Idempotente por índice único (recurring_expense_id, recurring_month) — pode rodar quantas vezes quiser.';

REVOKE ALL ON FUNCTION public.run_recurring_expenses(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_recurring_expenses(text,text) TO authenticated;

-- 4. Cron ---------------------------------------------------------------------
-- Dia 1 às 06:10 UTC (03:10 BRT), antes do fechamento do professor (06:30) para
-- que o mês já nasça com o custo estrutural lançado.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('wisewolf-recurring-expenses')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wisewolf-recurring-expenses');
    PERFORM cron.schedule('wisewolf-recurring-expenses', '10 6 1 * *',
                          'SELECT public.run_recurring_expenses();');
  END IF;
END
$cron$;
