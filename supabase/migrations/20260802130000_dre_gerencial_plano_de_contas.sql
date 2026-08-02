-- DRE gerencial — plano de contas + resultado por COMPETÊNCIA.
--
-- Por que não bastava "lançar o repasse a professores como SAIDA no caixa":
--   1. get_cashflow JÁ conta o repasse, direto de teacher_closings. Postar a
--      mesma despesa em financial_transactions faria a conta dobrar. É o bug que
--      20260612210100_fix_cashflow_double_count.sql já tinha matado na receita.
--   2. O problema real nunca foi falta de lançamento, foi REGIME. get_cashflow
--      só reconhece o custo quando o fechamento vira 'PAGO'. Julho/2026 tem
--      R$ 2.150,00 de custo real e aparece como R$ 0,00 lá. No histórico, só
--      R$ 3.519,50 de R$ 7.799,50 em fechamentos chegaram a PAGO — 55% do custo
--      com professor nunca entrou em relatório nenhum.
--
-- A saída é a mesma disciplina que v_payable_class_logs trouxe para a folha:
-- UMA camada que lê as fontes autoritativas, em vez de espelhar movimento.
-- Caixa e competência passam a conviver, cada um no seu caminho:
--   get_cashflow(mes)   → quanto dinheiro entrou e saiu (regime de CAIXA)
--   dre_gerencial(mes)  → qual foi o resultado do mês  (regime de COMPETÊNCIA)
--
-- ⚠️ Nenhum trigger novo, nenhuma escrita no ledger. Se um dia a escola quiser um
-- ledger clássico com toda movimentação postada, é dre_gerencial que define
-- exatamente o que postar — mas aí get_cashflow tem de parar de ler
-- teacher_closings no mesmo commit, senão dobra.

-- 1. Plano de contas gerencial ------------------------------------------------
-- Estrutura contábil é padrão, não é específica de escola → tabela global.
-- O que varia por escola é o mapeamento de categoria (tabela seguinte).
CREATE TABLE IF NOT EXISTS public.dre_accounts (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  -- RECEITA e DEDUCAO formam a receita líquida; CUSTO é o que varia com a aula
  -- entregue (CSP); DESPESA é estrutura, não varia com o volume de aula.
  kind        text NOT NULL CHECK (kind IN ('RECEITA','DEDUCAO','CUSTO','DESPESA')),
  sort_order  int  NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  -- false = o valor desta conta vem de fonte autoritativa (competência), NUNCA do
  -- ledger. Sem essa trava, bastaria alguém lançar uma saída com categoria
  -- 'teacher_payout' para o repasse ser contado duas vezes: uma por competência,
  -- outra pelo caixa. Blindar a conta é mais seguro do que confiar na disciplina
  -- de quem lança — ainda mais com um categorizador por IA vindo por cima.
  ledger_allowed boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.dre_accounts
  ADD COLUMN IF NOT EXISTS ledger_allowed boolean NOT NULL DEFAULT true;

INSERT INTO public.dre_accounts (code, label, kind, sort_order, ledger_allowed) VALUES
  ('3.1.01','Mensalidades',                  'RECEITA', 110, true),
  ('3.1.02','Matrículas e taxas',            'RECEITA', 120, true),
  ('3.1.99','Outras receitas',               'RECEITA', 190, true),
  ('4.1.01','Impostos sobre a receita',      'DEDUCAO', 210, true),
  ('5.1.01','Repasse a professores',         'CUSTO',   310, false),
  ('5.1.02','Ajustes de fechamento',         'CUSTO',   320, false),
  ('5.1.03','Material e outros custos diretos','CUSTO', 330, true),
  -- Comissões e indicações também têm fonte própria (vendor_commissions e
  -- referral_rewards) → mesma trava, mesmo motivo.
  ('6.1.01','Comissões de vendedores',       'DESPESA', 410, false),
  ('6.1.02','Programa de indicações',        'DESPESA', 420, false),
  ('6.1.03','Marketing e publicidade',       'DESPESA', 430, true),
  ('6.2.01','Ferramentas e software',        'DESPESA', 510, true),
  ('6.2.02','Infraestrutura e internet',     'DESPESA', 520, true),
  ('6.3.01','Despesas administrativas',      'DESPESA', 610, true),
  ('6.3.02','Despesas financeiras',          'DESPESA', 620, true),
  ('6.9.99','Outras despesas',               'DESPESA', 990, true)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label, ledger_allowed = EXCLUDED.ledger_allowed;

-- 2. Mapa categoria → conta ---------------------------------------------------
-- financial_transactions.category é texto livre e já nasceu com duas eras para a
-- MESMA coisa: 'student_tuition' (83 lançamentos, caminho antigo) e 'MENSALIDADE'
-- (76, trigger atual). O mapa reconcilia sem reescrever dado histórico — mexer no
-- ledger para "arrumar" categoria é justamente o tipo de edição que já produziu
-- caixa dobrado aqui. É também onde o categorizador por IA vai escrever.
CREATE TABLE IF NOT EXISTS public.dre_category_map (
  tenant_id    text NOT NULL,
  category     text NOT NULL,
  account_code text NOT NULL REFERENCES public.dre_accounts(code),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, category)
);

INSERT INTO public.dre_category_map (tenant_id, category, account_code)
SELECT t.id, m.category, m.account_code
FROM (SELECT DISTINCT id FROM public.tenants WHERE id <> 'master') t
CROSS JOIN (VALUES
  ('student_tuition',  '3.1.01'),   -- mesma coisa que MENSALIDADE, era antiga
  ('MENSALIDADE',      '3.1.01'),
  ('operational_cost', '6.9.99'),
  ('fee',              '6.3.02'),
  ('other',            '6.9.99')
  -- 'teacher_payout' de propósito FORA daqui: o repasse entra por competência,
  -- via v_teacher_cost_competencia. Mapeá-lo para 5.1.01 abriria a porta da
  -- dupla contagem — e a conta 5.1.01 tem ledger_allowed=false justamente para
  -- que, se alguém mapear mesmo assim, o valor seja barrado e vire alerta.
) AS m(category, account_code)
ON CONFLICT (tenant_id, category) DO NOTHING;

-- 2b. Conta direto no lançamento ----------------------------------------------
-- O mapa acima resolve o passivo (categoria em texto livre, com duas eras para a
-- mesma coisa). Para lançamento NOVO ele é frágil: duas despesas de naturezas
-- diferentes podem nascer com a mesma categoria, e renomear categoria
-- reclassificaria o histórico junto. Então quem já sabe a conta grava a conta.
-- É também onde o categorizador por IA escreve — sugestão por lançamento, não
-- uma regra global que muda o passado.
-- Precedência: account_code do lançamento > mapa da categoria > Outras despesas.
ALTER TABLE public.financial_transactions
  ADD COLUMN IF NOT EXISTS account_code text REFERENCES public.dre_accounts(code);

COMMENT ON COLUMN public.financial_transactions.account_code IS
  'Conta do plano gerencial deste lançamento. Tem precedência sobre dre_category_map. NULL = classifica pela categoria.';

ALTER TABLE public.dre_accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dre_category_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dre_accounts_read ON public.dre_accounts;
DROP POLICY IF EXISTS dre_map_read      ON public.dre_category_map;
CREATE POLICY dre_accounts_read ON public.dre_accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY dre_map_read ON public.dre_category_map FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                   AND p.role IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR')
                   AND (p.role = 'SUPER_ADMIN' OR p.tenant_id = dre_category_map.tenant_id)));
GRANT SELECT ON public.dre_accounts, public.dre_category_map TO authenticated, service_role;

-- 3. Custo com professor por COMPETÊNCIA --------------------------------------
-- Lê v_payable_class_logs por class_date: o custo pertence ao mês em que a aula
-- aconteceu, não ao mês em que o repasse foi pago. Mesma view que a folha usa,
-- então DRE e contracheque não podem divergir.
--
-- director_teacher_margin já fazia isso e continua válida — a diferença é que
-- aqui os ajustes de fechamento entram. Em julho ela reporta R$ 2.120,00 e o
-- custo real é R$ 2.150,00; os R$ 30,00 vivem em closing_adjustments.
CREATE OR REPLACE VIEW public.v_teacher_cost_competencia AS
SELECT
  t.tenant_id,
  to_char(v.class_date,'YYYY-MM') AS month_year,
  v.teacher_id,
  count(*)::int          AS aulas,
  sum(v.rate_efetivo)    AS custo_aulas
FROM public.v_payable_class_logs v
JOIN public.profiles t ON t.id = v.teacher_id
WHERE v.class_date IS NOT NULL
GROUP BY t.tenant_id, to_char(v.class_date,'YYYY-MM'), v.teacher_id;

COMMENT ON VIEW public.v_teacher_cost_competencia IS
  'Custo com professor pelo mês da AULA (competência), derivado de v_payable_class_logs. Não inclui closing_adjustments — dre_gerencial soma os ajustes por cima.';

GRANT SELECT ON public.v_teacher_cost_competencia TO authenticated, service_role;

-- 4. DRE gerencial ------------------------------------------------------------
-- p_tenant existe para o cron: sem JWT de usuário, auth.uid() é nulo e a função
-- não teria como saber de qual escola é o resultado. Quem está logado NÃO usa
-- esse parâmetro para espiar outra escola — só SUPER_ADMIN pode escolher; para
-- os demais o tenant continua vindo do próprio perfil.
CREATE OR REPLACE FUNCTION public.dre_gerencial(
  p_month text DEFAULT NULL, p_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text;
  v_receita numeric; v_deducoes numeric;
  v_custo_aulas numeric; v_custo_ajustes numeric; v_custo_outros numeric;
  v_desp_vendedor numeric; v_desp_indicacao numeric; v_desp_ledger numeric;
  v_barrado numeric;
  v_aulas int; v_alunos int;
  v_receita_liq numeric; v_custo numeric; v_lucro_bruto numeric;
  v_despesas numeric; v_resultado numeric;
  v_linhas jsonb; v_linhas_ledger jsonb; v_alertas jsonb := '[]'::jsonb;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role', '');
  SELECT role, tenant_id INTO v_caller_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt_role IN ('anon','authenticated') THEN
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR') THEN
      RAISE EXCEPTION 'Apenas a direção pode ver o resultado da escola';
    END IF;
    -- p_tenant só vale para SUPER_ADMIN; diretor e coordenador ficam no seu.
    IF v_caller_role = 'SUPER_ADMIN' THEN v_tenant := COALESCE(p_tenant, v_tenant); END IF;
  ELSE
    -- service_role / cron: o tenant tem de vir por parâmetro.
    v_tenant := COALESCE(p_tenant, v_tenant);
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Escola não identificada'; END IF;

  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Mês inválido (use YYYY-MM)'; END IF;

  -- RECEITA — student_payments é a fonte, a mesma de get_cashflow e
  -- director_teacher_margin. O ledger (financial_transactions) NÃO é usado aqui:
  -- ele diverge (o trigger aceita 'CONFIRMED', get_cashflow não; e occurred_at
  -- cai em now() quando paid_at é nulo), o que em julho/2026 dá ~R$ 155 de
  -- diferença. Duas definições de receita seria o mesmo erro de novo.
  SELECT COALESCE(sum(value),0) INTO v_receita
  FROM student_payments
  WHERE tenant_id = v_tenant AND status IN ('RECEIVED','RECEIVED_IN_CASH')
    AND to_char(COALESCE(paid_at, payment_date, due_date),'YYYY-MM') = v_month;

  -- CUSTO DOS SERVIÇOS — competência
  SELECT COALESCE(sum(custo_aulas),0), COALESCE(sum(aulas),0)
    INTO v_custo_aulas, v_aulas
  FROM v_teacher_cost_competencia
  WHERE tenant_id = v_tenant AND month_year = v_month;

  SELECT COALESCE(sum(amount),0) INTO v_custo_ajustes
  FROM closing_adjustments
  WHERE tenant_id = v_tenant AND month_year = v_month;

  SELECT count(DISTINCT v.student_id) INTO v_alunos
  FROM v_payable_class_logs v JOIN profiles t ON t.id = v.teacher_id
  WHERE t.tenant_id = v_tenant AND to_char(v.class_date,'YYYY-MM') = v_month
    AND v.student_id IS NOT NULL;

  -- DESPESAS — comissões e indicações pelo pagamento (é quando o direito vira
  -- obrigação da escola); demais despesas vêm do ledger, classificadas pelo mapa.
  SELECT COALESCE(sum(amount_brl),0) INTO v_desp_vendedor
  FROM vendor_commissions
  WHERE tenant_id = v_tenant AND status='PAID' AND to_char(paid_at,'YYYY-MM') = v_month;

  SELECT COALESCE(sum(amount_brl),0) INTO v_desp_indicacao
  FROM referral_rewards
  WHERE tenant_id = v_tenant AND status='PAID' AND to_char(paid_at,'YYYY-MM') = v_month;

  -- Saídas do ledger agregadas POR CONTA, não por natureza. Uma linha só de
  -- "despesas operacionais" tornaria invisível o trabalho de classificar: o
  -- diretor classifica marketing, ferramentas e contabilidade e continuaria
  -- vendo um total único. O plano de contas só serve se o relatório o mostra.
  -- Duas defesas seguem valendo:
  --   * categoria não mapeada cai em 'Outras despesas' (COALESCE), em vez de
  --     sumir do resultado — despesa esquecida infla o lucro;
  --   * saída que caia numa conta de fonte autoritativa (ledger_allowed=false) é
  --     BARRADA da soma e vira alerta. É a trava contra a dupla contagem.
  -- Os COALESCE não são decorativos: o LEFT JOIN devolve NULL para categoria sem
  -- mapa, e `NULL = 'DESPESA'` é NULL, o que faria o FILTER descartar a linha.
  SELECT
    COALESCE(sum(t.valor) FILTER (WHERE NOT t.barrado AND t.kind = 'DEDUCAO'), 0),
    COALESCE(sum(t.valor) FILTER (WHERE NOT t.barrado AND t.kind = 'CUSTO'),   0),
    COALESCE(sum(t.valor) FILTER (WHERE NOT t.barrado AND t.kind = 'DESPESA'), 0),
    COALESCE(sum(t.valor) FILTER (WHERE t.barrado), 0),
    COALESCE(jsonb_agg(jsonb_build_object(
        'code', t.code, 'label', t.label, 'kind', t.kind,
        'valor', round(t.valor,2), 'fonte','caixa (saídas classificadas)',
        'sort', t.sort_order) ORDER BY t.sort_order)
      FILTER (WHERE NOT t.barrado), '[]'::jsonb)
    INTO v_deducoes, v_custo_outros, v_desp_ledger, v_barrado, v_linhas_ledger
  FROM (
    SELECT
      COALESCE(a.code,       '6.9.99')          AS code,
      COALESCE(a.label,      'Outras despesas') AS label,
      COALESCE(a.kind,       'DESPESA')         AS kind,
      COALESCE(a.sort_order, 990)               AS sort_order,
      NOT COALESCE(a.ledger_allowed, true)      AS barrado,
      sum(ft.amount)                            AS valor
    FROM financial_transactions ft
    LEFT JOIN dre_category_map m ON m.tenant_id = ft.tenant_id AND m.category = ft.category
    LEFT JOIN dre_accounts a     ON a.code = COALESCE(ft.account_code, m.account_code)
    WHERE ft.tenant_id = v_tenant AND ft.type = 'SAIDA'
      AND to_char(COALESCE(ft.occurred_at, ft.created_at),'YYYY-MM') = v_month
    GROUP BY 1,2,3,4,5
  ) t;

  v_receita_liq := v_receita - v_deducoes;
  v_custo       := v_custo_aulas + v_custo_ajustes + v_custo_outros;
  v_lucro_bruto := v_receita_liq - v_custo;
  v_despesas    := v_desp_vendedor + v_desp_indicacao + v_desp_ledger;
  v_resultado   := v_lucro_bruto - v_despesas;

  -- Linhas de fonte autoritativa + as do caixa, ordenadas pelo plano de contas.
  -- 'sort' é andaime de ordenação e sai do payload (o `- 'sort'`).
  WITH fixas AS (
    SELECT unnest(ARRAY[
      jsonb_build_object('code','3.1.01','label','Mensalidades',           'kind','RECEITA','valor',round(v_receita,2),        'fonte','student_payments recebidos',        'sort',110),
      jsonb_build_object('code','5.1.01','label','Repasse a professores',  'kind','CUSTO',  'valor',round(v_custo_aulas,2),    'fonte','v_payable_class_logs (competência)','sort',310),
      jsonb_build_object('code','5.1.02','label','Ajustes de fechamento',  'kind','CUSTO',  'valor',round(v_custo_ajustes,2),  'fonte','closing_adjustments',               'sort',320),
      jsonb_build_object('code','6.1.01','label','Comissões de vendedores','kind','DESPESA','valor',round(v_desp_vendedor,2),  'fonte','vendor_commissions pagas',          'sort',410),
      jsonb_build_object('code','6.1.02','label','Programa de indicações', 'kind','DESPESA','valor',round(v_desp_indicacao,2), 'fonte','referral_rewards pagas',            'sort',420)
    ]) AS l
  ), ledger AS (
    SELECT e.value AS l FROM jsonb_array_elements(v_linhas_ledger) e
  )
  SELECT COALESCE(jsonb_agg((t.l - 'sort') ORDER BY (t.l->>'sort')::int), '[]'::jsonb)
    INTO v_linhas
  FROM (SELECT l FROM fixas UNION ALL SELECT l FROM ledger) t;

  -- Alertas: o resultado só é confiável se o lado do custo estiver completo.
  -- Sem isso o diretor lê lucro de 76% e toma decisão em cima de número irreal.
  IF v_desp_ledger = 0 AND v_deducoes = 0 AND v_custo_outros = 0 THEN
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','critico',
      'texto','Nenhuma despesa operacional lançada no mês (ferramentas, internet, impostos, aluguel). O resultado abaixo está SUPERESTIMADO — ele desconta só o custo com professor.');
  END IF;
  IF v_barrado > 0 THEN
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','atencao',
      -- G e D seguem o lc_numeric do servidor (que aqui devolve 5,000.00). Os
      -- separadores literais , e . não seguem, então formata em US e troca.
      'texto','R$ ' || translate(to_char(v_barrado,'FM999,999,990.00'), ',.', '.,') || ' em saídas do caixa foram lançadas em contas que já vêm por competência (repasse, ajustes, comissões, indicações). O valor foi IGNORADO no resultado para não contar duas vezes — reclassifique a categoria.');
  END IF;
  IF v_custo_aulas = 0 AND v_receita > 0 THEN
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','atencao',
      'texto','Houve receita mas nenhuma aula pagável lançada no mês. Verifique lançamentos pendentes de professor.');
  END IF;
  IF EXISTS (SELECT 1 FROM teacher_closings tc
              WHERE tc.tenant_id = v_tenant AND tc.month_year = v_month
                AND tc.status <> 'PAGO') THEN
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','info',
      'texto','O fechamento deste mês ainda não foi pago. O custo já está reconhecido aqui por competência, mas ainda não saiu do caixa.');
  END IF;

  RETURN jsonb_build_object(
    'month', v_month,
    'regime','competencia',
    'receita_bruta',   round(v_receita,2),
    'deducoes',        round(v_deducoes,2),
    'receita_liquida', round(v_receita_liq,2),
    'custo_servicos',  round(v_custo,2),
    'lucro_bruto',     round(v_lucro_bruto,2),
    'margem_bruta_pct',   round(100 * v_lucro_bruto / NULLIF(v_receita_liq,0), 1),
    'despesas_operacionais', round(v_despesas,2),
    'resultado',       round(v_resultado,2),
    'margem_liquida_pct', round(100 * v_resultado / NULLIF(v_receita_liq,0), 1),
    'indicadores', jsonb_build_object(
      'aulas', v_aulas,
      'alunos_atendidos', v_alunos,
      'receita_por_aluno', round(v_receita / NULLIF(v_alunos,0), 2),
      'custo_por_aula',    round((v_custo_aulas + v_custo_ajustes) / NULLIF(v_aulas,0), 2)
    ),
    'linhas', v_linhas,
    'alertas', v_alertas
  );
END;
$function$;

COMMENT ON FUNCTION public.dre_gerencial(text, text) IS
  'Resultado gerencial do mês por COMPETÊNCIA (custo da aula no mês em que ela aconteceu). Fonte única: student_payments + v_payable_class_logs + closing_adjustments + caixa classificado pelo plano de contas. Para regime de caixa use get_cashflow(text).';

REVOKE ALL ON FUNCTION public.dre_gerencial(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dre_gerencial(text, text) TO authenticated, service_role;

-- 5. Manutenção do mapa pela direção ------------------------------------------
-- Escrita só por RPC (mesma disciplina de tenant_niches: RLS deixa ler, não escrever).
CREATE OR REPLACE FUNCTION public.set_dre_category_account(p_category text, p_account_code text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM dre_accounts WHERE code = p_account_code AND is_active) THEN
    RETURN jsonb_build_object('error','conta_invalida');
  END IF;

  INSERT INTO dre_category_map (tenant_id, category, account_code)
  VALUES (v_tenant, p_category, p_account_code)
  ON CONFLICT (tenant_id, category) DO UPDATE SET account_code = EXCLUDED.account_code;

  RETURN jsonb_build_object('ok', true, 'category', p_category, 'account_code', p_account_code);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_dre_category_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_dre_category_account(text, text) TO authenticated;
