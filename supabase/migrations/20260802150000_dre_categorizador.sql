-- Apoio ao categorizador de despesa por IA.
--
-- Duas coisas: o que ainda não tem conta (para a IA olhar) e um endurecimento
-- na gravação do mapa.
--
-- O endurecimento é o ponto delicado. set_dre_category_account aceitava qualquer
-- conta ativa, inclusive as de fonte autoritativa (repasse, comissão, indicação).
-- Isso era tolerável quando só o diretor escrevia: o DRE barra o valor e avisa.
-- Com uma IA sugerindo em lote, "barra e avisa" vira ruído recorrente — a
-- sugestão errada seria aplicada, o alerta apareceria todo mês e alguém acabaria
-- ignorando o alerta. Melhor a gravação simplesmente recusar.

CREATE OR REPLACE FUNCTION public.set_dre_category_account(p_category text, p_account_code text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; v_allowed boolean;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;
  IF COALESCE(btrim(p_category),'') = '' THEN
    RETURN jsonb_build_object('error','categoria_obrigatoria');
  END IF;

  SELECT ledger_allowed INTO v_allowed
    FROM dre_accounts WHERE code = p_account_code AND is_active;
  IF v_allowed IS NULL THEN RETURN jsonb_build_object('error','conta_invalida'); END IF;
  -- Conta alimentada por competência não recebe lançamento do caixa. Deixar
  -- mapear aqui é abrir a porta da dupla contagem.
  IF NOT v_allowed THEN RETURN jsonb_build_object('error','conta_de_fonte_automatica'); END IF;

  INSERT INTO dre_category_map (tenant_id, category, account_code)
  VALUES (v_tenant, btrim(p_category), p_account_code)
  ON CONFLICT (tenant_id, category) DO UPDATE SET account_code = EXCLUDED.account_code;

  RETURN jsonb_build_object('ok', true, 'category', btrim(p_category), 'account_code', p_account_code);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_dre_category_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_dre_category_account(text, text) TO authenticated;

-- O que a IA precisa ver ------------------------------------------------------
-- Categoria pendente = saída sem account_code no lançamento E sem linha no mapa.
-- Devolve exemplos de descrição porque 'other' e 'fee' não dizem nada sozinhas —
-- o que classifica é o texto que o humano escreveu ao lançar.
CREATE OR REPLACE FUNCTION public.dre_uncategorized_expenses()
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

  RETURN jsonb_build_object(
    'contas', (SELECT jsonb_agg(jsonb_build_object('code',code,'label',label,'kind',kind) ORDER BY sort_order)
                 FROM dre_accounts WHERE is_active AND ledger_allowed),
    'pendentes', COALESCE((
      SELECT jsonb_agg(p ORDER BY p->>'category')
        FROM (
          SELECT jsonb_build_object(
                   'category', ft.category,
                   'lancamentos', count(*)::int,
                   'total', round(sum(ft.amount),2),
                   'exemplos', (array_agg(DISTINCT ft.description)
                                FILTER (WHERE COALESCE(btrim(ft.description),'') <> ''))[1:4]
                 ) AS p
            FROM financial_transactions ft
            LEFT JOIN dre_category_map m
              ON m.tenant_id = ft.tenant_id AND m.category = ft.category
           WHERE ft.tenant_id = v_tenant
             AND ft.type = 'SAIDA'
             AND ft.account_code IS NULL
             AND m.account_code IS NULL
             AND COALESCE(btrim(ft.category),'') <> ''
           GROUP BY ft.category
        ) s), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.dre_uncategorized_expenses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dre_uncategorized_expenses() TO authenticated;
