-- Rateio do pagamento no grupo da direção — dízimo e investimento sobre o líquido.
--
-- O diretor separa, de cada pagamento que entra, 10% de dízimo e 10% para o
-- investimento (a "caixinha" da escola). Mas NÃO sobre o valor cheio: sobre o
-- que sobra depois do custo do professor daquele aluno. Até aqui isso era conta
-- de cabeça, feita depois, sem registro — e portanto sem como conferir.
--
-- ⚠️ O QUE ESTE ARQUIVO **NÃO** FAZ, de propósito:
--   • Não lança nada em financial_transactions, não cria conta no plano do DRE e
--     não mexe em get_cashflow. É AVISO, não contabilidade. Postar o rateio como
--     saída faria o lucro cair duas vezes (o custo do professor já entra por
--     competência em v_teacher_cost_competencia) — é exatamente a dupla contagem
--     que 20260612210100 e 20260802130000 já mataram neste projeto. Quando/se
--     virar lançamento, é decisão separada e consciente.
--   • Não recalcula tarifa de professor. A tarifa sai de teacher_student_rate(),
--     que lê teacher_pay_tiers. Nada de percentual ou valor de aula chumbado:
--     o diretor mexe na faixa e o aviso acompanha sozinho.
--
-- ⚠️ O LIMITE HONESTO DA CONTA (está escrito na própria mensagem):
-- quando o pagamento cai, o mês AINDA NÃO ACONTECEU. O custo real do professor
-- só existe depois que as aulas são lançadas. Então o custo aqui é PREVISTO: a
-- agenda vigente expandida sobre os dias do mês de referência — que é o que faz
-- agosto com 5 segundas custar mais que julho com 4, exatamente o efeito de
-- calendário que motivou o pedido.
-- Medido contra julho/2026: para aluno de agenda estável a previsão bate exata
-- (7 de 12 com diferença R$ 0,00); quem mudou de agenda no meio do mês diverge
-- (um caso de 4 aulas previstas contra 13 reais). A mensagem diz "previsto",
-- nunca "pago", para ninguém tomar o número por fechamento.

-- 1. Configuração por escola --------------------------------------------------
-- Nasce DESLIGADA e sem linha nenhuma: automação que já nasce ligada manda
-- mensagem para o grupo errado no primeiro deploy (mesma disciplina de
-- dre_report_settings e dre_report_targets).
CREATE TABLE IF NOT EXISTS public.payment_split_settings (
  tenant_id      text PRIMARY KEY,
  dizimo_pct     numeric(5,2) NOT NULL DEFAULT 10.00 CHECK (dizimo_pct   >= 0 AND dizimo_pct   <= 100),
  investimento_pct   numeric(5,2) NOT NULL DEFAULT 10.00 CHECK (investimento_pct >= 0 AND investimento_pct <= 100),
  is_active      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Soma acima de 100% do líquido não é erro de digitação a ser adivinhado —
  -- é conta que não fecha. Barra na origem.
  CONSTRAINT ck_payment_split_total CHECK (dizimo_pct + investimento_pct <= 100)
);

COMMENT ON TABLE public.payment_split_settings IS
  'Percentuais de dízimo e investimento (caixinha da escola) aplicados sobre o líquido de cada pagamento (valor - custo previsto do professor). Sem linha ativa, nenhum aviso é enviado. NÃO é lançamento contábil.';

-- O destino é o MESMO grupo do relatório gerencial (dre_report_settings.destino),
-- nunca uma segunda lista: duas listas de grupo saem de sincronia e o aviso passa
-- a ir para um grupo que o diretor achou que tinha desligado.

ALTER TABLE public.payment_split_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_split_settings_read ON public.payment_split_settings;
CREATE POLICY payment_split_settings_read ON public.payment_split_settings
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = auth.uid()
                    AND p.role IN ('SCHOOL_ADMIN','SUPER_ADMIN')
                    AND (p.role = 'SUPER_ADMIN'
                         OR p.tenant_id = payment_split_settings.tenant_id)));
GRANT SELECT ON public.payment_split_settings TO authenticated, service_role;

-- 2. A conta ------------------------------------------------------------------
-- Uma função só, chamada pela edge (envio) e pelo painel (prévia). Duas cópias
-- da regra em lugares diferentes foi como o lançamento de aula divergiu entre
-- duas telas e deixou de pagar reposição de falta do professor por meses.
CREATE OR REPLACE FUNCTION public.payment_split_breakdown(p_payment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_caller_tenant text;
  v_pay record; v_tenant text; v_mes text; v_ini date; v_fim date;
  v_dizimo_pct numeric; v_investimento_pct numeric; v_ativo boolean;
  v_custo numeric; v_aulas int; v_liquido numeric;
  v_professores jsonb; v_aluno text;
  v_na_base boolean; v_dizimo numeric; v_investimento numeric;
BEGIN
  SELECT COALESCE(current_setting('request.jwt.claims', true)::json->>'role','')
    INTO v_jwt_role;

  SELECT sp.id, sp.student_id, sp.value, sp.tenant_id, sp.description, sp.payment_type,
         COALESCE(sp.paid_at, sp.payment_date, sp.due_date) AS quando,
         sp.created_at
    INTO v_pay
    FROM student_payments sp WHERE sp.id = p_payment_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','pagamento_nao_encontrado'); END IF;

  v_tenant := COALESCE(v_pay.tenant_id,
                       (SELECT p.tenant_id FROM profiles p WHERE p.id = v_pay.student_id));
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('error','escola_nao_identificada'); END IF;

  -- Chamada pelo navegador passa por checagem de papel e de escola; chamada pelo
  -- cron/edge (service_role) não tem auth.uid() e já é confiável.
  IF v_jwt_role IN ('anon','authenticated') THEN
    SELECT role, tenant_id INTO v_caller_role, v_caller_tenant
      FROM profiles WHERE id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
    IF v_caller_role <> 'SUPER_ADMIN' AND v_caller_tenant IS DISTINCT FROM v_tenant THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
  END IF;

  SELECT s.dizimo_pct, s.investimento_pct, s.is_active
    INTO v_dizimo_pct, v_investimento_pct, v_ativo
    FROM payment_split_settings s WHERE s.tenant_id = v_tenant;
  IF NOT FOUND THEN
    v_dizimo_pct := 10.00; v_investimento_pct := 10.00; v_ativo := false;
  END IF;

  -- Mês de referência = mês em que o dinheiro entrou. É ele que define quantas
  -- vezes cada dia da semana cai no calendário.
  v_mes := to_char(COALESCE(v_pay.quando, now()), 'YYYY-MM');
  v_ini := (v_mes || '-01')::date;
  v_fim := (date_trunc('month', v_ini) + INTERVAL '1 month - 1 day')::date;

  SELECT btrim(p.full_name) INTO v_aluno FROM profiles p WHERE p.id = v_pay.student_id;

  -- Custo PREVISTO: a agenda vigente do aluno expandida sobre os dias do mês.
  -- Mesmo padrão de teacher_pay_projection — e a tarifa vem de
  -- teacher_student_rate (faixa de antiguidade + turbo), nunca de valor fixo.
  WITH aulas AS (
    SELECT b.teacher_id,
           d::date AS dia,
           teacher_student_rate(b.teacher_id, b.student_id, d::date) AS rate
      FROM bookings b
      CROSS JOIN generate_series(v_ini, v_fim, '1 day') d
     WHERE b.student_id = v_pay.student_id
       AND COALESCE(b.status,'SCHEDULED') = 'SCHEDULED'
       AND dow_name_to_int(b.day_of_week) = EXTRACT(dow FROM d)::int
       AND (b.start_date IS NULL OR d >= b.start_date)
  )
  SELECT COALESCE(count(*),0)::int, COALESCE(sum(a.rate),0)
    INTO v_aulas, v_custo
    FROM aulas a;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'teacher_id', z.teacher_id,
           'teacher_name', COALESCE(btrim(t.full_name), 'Professor não identificado'),
           'aulas', z.n, 'custo', round(z.custo,2)) ORDER BY z.custo DESC), '[]'::jsonb)
    INTO v_professores
    FROM (
      SELECT b.teacher_id, count(*)::int AS n,
             sum(teacher_student_rate(b.teacher_id, b.student_id, d::date)) AS custo
        FROM bookings b
        CROSS JOIN generate_series(v_ini, v_fim, '1 day') d
       WHERE b.student_id = v_pay.student_id
         AND COALESCE(b.status,'SCHEDULED') = 'SCHEDULED'
         AND dow_name_to_int(b.day_of_week) = EXTRACT(dow FROM d)::int
         AND (b.start_date IS NULL OR d >= b.start_date)
       GROUP BY b.teacher_id) z
    LEFT JOIN profiles t ON t.id = z.teacher_id;

  -- Pagamento sem aluno vinculado (9 nos últimos 60 dias) e taxa/matrícula não
  -- têm professor atrelado: o líquido é o valor cheio. O aviso DIZ isso, em vez
  -- de mostrar custo zero como se fosse aula de graça.
  v_liquido := GREATEST(COALESCE(v_pay.value,0) - COALESCE(v_custo,0), 0);

  -- FORA DA BASE: pagamento sem aluno vinculado não gera dízimo nem investimento.
  --
  -- Decisão da direção em 08/08/2026, e ela tem uma razão concreta: boa parte do
  -- que entra sem aluno é APORTE DA DONA, dinheiro dela entrando na escola. Tirar
  -- dízimo em cima disso seria dizimar o mesmo dinheiro duas vezes. Some-se a
  -- isso que, sem aluno, não há professor a descontar — então a base seria o
  -- valor cheio, e o dízimo sairia MAIOR justamente onde a conta é menos confiável.
  --
  -- ⚠️ O pagamento continua aparecendo, com o valor cheio. Ele não some do
  -- relatório nem do aviso: some da BASE. Esconder dinheiro que entrou seria
  -- trocar um erro por outro pior.
  v_na_base := (v_pay.student_id IS NOT NULL);
  IF NOT v_na_base THEN
    v_dizimo := 0; v_investimento := 0;
  ELSE
    v_dizimo       := round(v_liquido * v_dizimo_pct       / 100.0, 2);
    v_investimento := round(v_liquido * v_investimento_pct / 100.0, 2);
  END IF;

  RETURN jsonb_build_object(
    'payment_id',   v_pay.id,
    'tenant_id',    v_tenant,
    'is_active',    COALESCE(v_ativo,false),
    'month',        v_mes,
    'paid_at',      v_pay.quando,
    -- Chave do dedupe, NÃO a data do pagamento. A Asaas manda PAYMENT_CONFIRMED e
    -- depois PAYMENT_RECEIVED para a mesma cobrança, e paid_at muda entre os dois
    -- (22 pagamentos nos últimos 60 dias têm created_at ≠ data de pagamento).
    -- Com ref_date variável, o índice único (kind, subject_id, ref_date) deixaria
    -- passar a segunda mensagem e o grupo receberia o mesmo aviso duas vezes.
    -- created_at é imutável na linha, então a claim vira atômica de verdade.
    'ref_date',     COALESCE(v_pay.created_at, now())::date,
    'student_id',   v_pay.student_id,
    'student_name', COALESCE(v_aluno, 'sem aluno vinculado'),
    'sem_aluno',    (v_pay.student_id IS NULL),
    'sem_agenda',   (v_aulas = 0),
    'na_base',      v_na_base,
    'description',  v_pay.description,
    'valor',        round(COALESCE(v_pay.value,0),2),
    'aulas_previstas', v_aulas,
    'custo_professor', round(COALESCE(v_custo,0),2),
    'professores',  v_professores,
    'liquido',      round(v_liquido,2),
    'dizimo_pct',   v_dizimo_pct,
    'investimento_pct', v_investimento_pct,
    'dizimo',       v_dizimo,
    'investimento', v_investimento,
    'sobra',        round(v_liquido - v_dizimo - v_investimento, 2));
END;
$function$;

ALTER FUNCTION public.payment_split_breakdown(uuid) OWNER TO postgres;
COMMENT ON FUNCTION public.payment_split_breakdown(uuid) IS
  'Rateio de um pagamento: valor - custo PREVISTO do professor (agenda do mês × teacher_student_rate) = líquido, sobre o qual incidem dízimo e investimento. Não lança nada: é a base do aviso no grupo e do relatório do mês.';

REVOKE ALL ON FUNCTION public.payment_split_breakdown(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_split_breakdown(uuid) TO authenticated, service_role;

-- 2b. Relatório do mês -------------------------------------------------------
-- O total bruto que o diretor abre no Financeiro: cada pagamento do mês com o
-- seu rateio, e a soma. É o número que ele usa para efetivamente separar o
-- dízimo e o investimento — a mensagem no grupo avisa um por um, mas ninguém
-- soma WhatsApp no fim do mês.
--
-- ⚠️ Chama payment_split_breakdown por pagamento em vez de reescrever a conta.
-- Relatório e mensagem TÊM de dar o mesmo número: duas cópias da mesma regra em
-- lugares diferentes foi como o lançamento de aula divergiu entre duas telas
-- neste projeto e deixou de pagar reposição por meses.
CREATE OR REPLACE FUNCTION public.payment_split_report(
  p_month text DEFAULT NULL, p_tenant text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text;
BEGIN
  v_jwt_role := COALESCE(current_setting('request.jwt.claims', true)::json->>'role','');
  SELECT role, tenant_id INTO v_caller_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_jwt_role IN ('anon','authenticated') THEN
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
    IF v_caller_role = 'SUPER_ADMIN' THEN v_tenant := COALESCE(p_tenant, v_tenant); END IF;
  ELSE
    v_tenant := COALESCE(p_tenant, v_tenant);
  END IF;
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('error','escola_nao_identificada'); END IF;

  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RETURN jsonb_build_object('error','mes_invalido'); END IF;

  RETURN (
  WITH pagos AS (
    SELECT sp.id, COALESCE(sp.paid_at, sp.payment_date, sp.due_date) AS quando
      FROM student_payments sp
     WHERE sp.tenant_id = v_tenant
       -- Mesma expressão de receita de dre_gerencial e balancete_professores.
       -- Aceitar CONFIRMED/PAID aqui faria o rateio somar um faturamento que os
       -- outros dois relatórios não enxergam.
       AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
       AND COALESCE(sp.value,0) > 0
       AND to_char(COALESCE(sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
  ), rateado AS (
    SELECT p.quando, payment_split_breakdown(p.id) AS b FROM pagos p
  )
  SELECT jsonb_build_object(
    'month', v_month,
    'pagamentos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'payment_id',      r.b->>'payment_id',
               'aluno',           r.b->>'student_name',
               'quando',          r.quando,
               'valor',           (r.b->>'valor')::numeric,
               'custo_professor', (r.b->>'custo_professor')::numeric,
               'professores',     r.b->'professores',
               'liquido',         (r.b->>'liquido')::numeric,
               'dizimo',          (r.b->>'dizimo')::numeric,
               'investimento',    (r.b->>'investimento')::numeric,
               'sobra',           (r.b->>'sobra')::numeric,
               'sem_aluno',       (r.b->>'sem_aluno')::boolean,
               'na_base',         (r.b->>'na_base')::boolean)
             ORDER BY r.quando DESC)
        FROM rateado r), '[]'::jsonb),
    'totais', (SELECT jsonb_build_object(
        'pagamentos',      count(*)::int,
        -- 'recebido' é TUDO que entrou, na base ou não. É o número que tem de
        -- bater com o DRE; separar sem dizer o total esconderia faturamento.
        'recebido',        round(COALESCE(sum((r.b->>'valor')::numeric),0),2),
        'custo_professor', round(COALESCE(sum((r.b->>'custo_professor')::numeric),0),2),
        'liquido',         round(COALESCE(sum((r.b->>'liquido')::numeric)
                                   FILTER (WHERE (r.b->>'na_base')::boolean),0),2),
        'dizimo',          round(COALESCE(sum((r.b->>'dizimo')::numeric),0),2),
        'investimento',    round(COALESCE(sum((r.b->>'investimento')::numeric),0),2),
        'sobra',           round(COALESCE(sum((r.b->>'sobra')::numeric),0),2),
        -- Quanto entrou e NÃO gerou dízimo. Sem essa linha, a diferença entre o
        -- recebido e a base viraria um buraco que ninguém sabe explicar.
        'fora_da_base',    round(COALESCE(sum((r.b->>'valor')::numeric)
                                   FILTER (WHERE NOT (r.b->>'na_base')::boolean),0),2),
        'fora_da_base_n',  count(*) FILTER (WHERE NOT (r.b->>'na_base')::boolean)::int
      ) FROM rateado r),
    'sem_aluno', (SELECT count(*)::int FROM rateado r WHERE (r.b->>'sem_aluno')::boolean)));
END;
$function$;

ALTER FUNCTION public.payment_split_report(text, text) OWNER TO postgres;
COMMENT ON FUNCTION public.payment_split_report(text, text) IS
  'Rateio de todos os pagamentos do mês com os totais de dízimo e investimento. Usa payment_split_breakdown por pagamento para não haver duas versões da mesma conta.';

REVOKE ALL ON FUNCTION public.payment_split_report(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_split_report(text, text) TO authenticated, service_role;

-- 3. Leitura e escrita da configuração pela direção ---------------------------
CREATE OR REPLACE FUNCTION public.get_payment_split_settings()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; r record; v_destino text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;

  -- O destino não é editável aqui de propósito: é o grupo do relatório
  -- gerencial. Mostrado só para o diretor saber para onde o aviso vai.
  SELECT d.destino INTO v_destino FROM dre_report_settings d WHERE d.tenant_id = v_tenant;

  SELECT * INTO r FROM payment_split_settings WHERE tenant_id = v_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('configurado', false, 'is_active', false,
      'dizimo_pct', 10.00, 'investimento_pct', 10.00,
      'destino', COALESCE(v_destino,''), 'destino_configurado', v_destino IS NOT NULL);
  END IF;
  RETURN jsonb_build_object('configurado', true, 'is_active', r.is_active,
    'dizimo_pct', r.dizimo_pct, 'investimento_pct', r.investimento_pct,
    'destino', COALESCE(v_destino,''), 'destino_configurado', v_destino IS NOT NULL,
    'updated_at', r.updated_at);
END;
$function$;

ALTER FUNCTION public.get_payment_split_settings() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_payment_split_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payment_split_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.save_payment_split_settings(
  p_dizimo_pct numeric, p_investimento_pct numeric, p_is_active boolean DEFAULT true)
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
  IF p_dizimo_pct IS NULL OR p_investimento_pct IS NULL
     OR p_dizimo_pct < 0 OR p_investimento_pct < 0 THEN
    RETURN jsonb_build_object('error','percentual_invalido');
  END IF;
  IF p_dizimo_pct + p_investimento_pct > 100 THEN
    RETURN jsonb_build_object('error','percentual_acima_de_100');
  END IF;
  -- Ligar sem destino deixaria o aviso morrendo em silêncio a cada pagamento.
  IF COALESCE(p_is_active,true)
     AND NOT EXISTS (SELECT 1 FROM dre_report_settings d
                      WHERE d.tenant_id = v_tenant AND COALESCE(d.destino,'') <> '') THEN
    RETURN jsonb_build_object('error','sem_grupo_configurado');
  END IF;

  INSERT INTO payment_split_settings (tenant_id, dizimo_pct, investimento_pct, is_active)
  VALUES (v_tenant, p_dizimo_pct, p_investimento_pct, COALESCE(p_is_active,true))
  ON CONFLICT (tenant_id) DO UPDATE
    SET dizimo_pct = EXCLUDED.dizimo_pct, investimento_pct = EXCLUDED.investimento_pct,
        is_active = EXCLUDED.is_active, updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$function$;

ALTER FUNCTION public.save_payment_split_settings(numeric,numeric,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_payment_split_settings(numeric,numeric,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_payment_split_settings(numeric,numeric,boolean) TO authenticated;

-- 4. Quem ainda não foi avisado ----------------------------------------------
-- Rede de segurança do cron: pagamento que entrou e cujo aviso não saiu (pg_net
-- fora do ar, edge reiniciando, pagamento em dinheiro lançado direto no banco).
-- Janela de 2 dias: avisar pagamento de duas semanas atrás como se fosse agora
-- confunde mais do que ajuda.
CREATE OR REPLACE FUNCTION public.payment_split_pending()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('payment_id', z.id, 'tenant_id', z.tenant_id))
      FROM (
        SELECT sp.id, sp.tenant_id
          FROM student_payments sp
          JOIN payment_split_settings s
            ON s.tenant_id = sp.tenant_id AND s.is_active
         WHERE sp.status IN ('RECEIVED','RECEIVED_IN_CASH','CONFIRMED','PAGO',
                             'PAYMENT_RECEIVED','PAYMENT_CONFIRMED')
           AND COALESCE(sp.value,0) > 0
           AND COALESCE(sp.paid_at, sp.payment_date, sp.due_date) >= (now() - INTERVAL '2 days')
           AND NOT EXISTS (SELECT 1 FROM automation_sent a
                            WHERE a.kind = 'PAYMENT_SPLIT' AND a.subject_id = sp.id::text)
         ORDER BY COALESCE(sp.paid_at, sp.payment_date, sp.due_date) DESC
         LIMIT 30) z), '[]'::jsonb);
END;
$function$;

ALTER FUNCTION public.payment_split_pending() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.payment_split_pending() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_split_pending() TO service_role;

-- 5. Disparo no ato do pagamento ---------------------------------------------
-- Pendura no student_payments, NÃO dentro do webhook da Asaas: assim pagamento
-- em dinheiro (RECEIVED_IN_CASH, lançado pela tela) também avisa. Mesma escolha
-- que fez ledger_on_payment_received virar a fonte única do caixa.
--
-- ⚠️ O corpo inteiro é à prova de exceção. Um aviso de WhatsApp NUNCA pode
-- derrubar o registro de um pagamento: o trigger roda dentro da transação do
-- webhook, e um erro aqui faria a Asaas confirmar dinheiro que o banco não
-- guardou. Na dúvida, o aviso morre e o cron da rede de segurança pega depois.
CREATE OR REPLACE FUNCTION public.notify_payment_split()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE service_key text; req bigint;
BEGIN
  IF NOT (NEW.status IN ('RECEIVED','RECEIVED_IN_CASH','CONFIRMED','PAGO',
                         'PAYMENT_RECEIVED','PAYMENT_CONFIRMED')
          AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
          AND COALESCE(NEW.value,0) > 0) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM payment_split_settings s
                  WHERE s.tenant_id = NEW.tenant_id AND s.is_active) THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'wisewolf_service_role_key' LIMIT 1;
  IF service_key IS NULL OR service_key = '' THEN
    RAISE WARNING 'notify_payment_split: service key ausente';
    RETURN NEW;
  END IF;

  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/payment-split-notify',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'Authorization','Bearer ' || service_key),
    body := jsonb_build_object('payment_id', NEW.id),
    timeout_milliseconds := 20000) INTO req;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_payment_split falhou (pagamento preservado): %', SQLERRM;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.notify_payment_split() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_notify_payment_split ON public.student_payments;
CREATE TRIGGER trg_notify_payment_split
AFTER INSERT OR UPDATE ON public.student_payments
FOR EACH ROW EXECUTE FUNCTION public.notify_payment_split();

-- 6. Rede de segurança --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_payment_split_sweep()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE request_id bigint; service_key text;
BEGIN
  SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'wisewolf_service_role_key' LIMIT 1;
  IF service_key IS NULL OR service_key = '' THEN
    RAISE WARNING 'service key ausente'; RETURN -1;
  END IF;
  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/payment-split-notify',
    headers := jsonb_build_object('Content-Type','application/json',
                                  'Authorization','Bearer ' || service_key),
    body := '{"sweep":true}'::jsonb, timeout_milliseconds := 120000
  ) INTO request_id;
  RETURN request_id;
END;
$function$;

ALTER FUNCTION public.trigger_payment_split_sweep() OWNER TO postgres;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('wisewolf-payment-split-sweep')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wisewolf-payment-split-sweep');
    PERFORM cron.schedule('wisewolf-payment-split-sweep', '*/15 * * * *',
                          'SELECT trigger_payment_split_sweep();');
  END IF;
END
$cron$;
