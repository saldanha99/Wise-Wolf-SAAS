-- Conciliação "caixinha × folha" do professor.
--
-- O diretor separa numa caixinha o custo do professor a cada aviso de pagamento
-- que chega no grupo da gestão (payment_split_breakdown). No fim do mês compara
-- com o fechamento e os números não batem — e reconstruir a diferença na mão
-- levava horas.
--
-- As duas contas respondem perguntas diferentes e NUNCA vão bater sozinhas:
--   caixinha = dinheiro que ENTROU  (agenda do aluno × dias do mês × tarifa)
--   folha    = aula que foi DADA    (class_logs lançados + sobras + ajustes)
--
-- Esta função decompõe a diferença por motivo, para o diretor ver de onde ela
-- vem em vez de desconfiar do fechamento. Causas medidas em agosto/2026:
--   AGENDA_DESATUALIZADA  o aluno tinha 3 aulas/semana e a agenda registrava 1,
--                         então o aviso mandou custo menor que o real
--   PAGAMENTO_REPETIDO    taxa de matrícula + mensalidade no mesmo mês fazem o
--                         aviso repetir o custo INTEIRO do mês (Ramiro, R$ 104)
--   ALUNO_SEM_PAGAMENTO   aula dada para quem não pagou
--   PAGAMENTO_NAO_LIQUIDADO  Asaas em CONFIRMED, dinheiro ainda não caiu
--   AULA_NAO_LANCADA      a agenda previa a aula e ela não foi lançada
--   AULA_MES_ANTERIOR     sobra absorvida (o pagamento foi rateado no mês da aula)
--   AULA_SEM_ALUNO        experimental e afins, sem pagamento a que se vincular
--
-- ⚠️ O "previsto" é calculado com a AGENDA DE HOJE, igual ao aviso. Agenda
-- alterada depois do envio muda o previsto de um mês já fechado — é justamente
-- o que o motivo AGENDA_DESATUALIZADA existe para revelar.

CREATE OR REPLACE FUNCTION public.teacher_payroll_reconciliation(
  p_month text DEFAULT NULL,
  p_tenant text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_month text;
  v_tenant text;
  v_ini date;
  v_fim date;
  v_professores jsonb;
  v_totais jsonb;
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
  ) THEN
    RETURN jsonb_build_object('error', 'sem_permissao');
  END IF;

  -- O tenant vem SEMPRE do perfil de quem chamou. Só o SUPER_ADMIN escolhe,
  -- senão um diretor leria a folha de outra escola passando o slug no corpo.
  v_tenant := CASE
    WHEN is_super_admin() AND nullif(btrim(coalesce(p_tenant, '')), '') IS NOT NULL
      THEN btrim(p_tenant)
    ELSE _my_tenant_id()
  END;
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('error', 'sem_tenant');
  END IF;

  v_month := coalesce(nullif(btrim(coalesce(p_month, '')), ''),
                      to_char(current_date, 'YYYY-MM'));
  IF v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RETURN jsonb_build_object('error', 'mes_invalido');
  END IF;
  v_ini := (v_month || '-01')::date;
  v_fim := (date_trunc('month', v_ini) + interval '1 month - 1 day')::date;

  WITH
  -- o que foi DADO: fonte única de "esta aula paga", por professor e aluno
  folha AS (
    SELECT v.teacher_id,
           v.student_id,
           count(*)::int AS aulas,
           round(sum(v.rate_efetivo), 2) AS valor
      FROM v_payable_class_logs AS v
     WHERE v.tenant_id = v_tenant
       AND to_char(v.class_date, 'YYYY-MM') = v_month
     GROUP BY 1, 2
  ),
  -- pagamentos que geraram aviso no grupo (mesmo conjunto de status do caixa)
  pagos AS (
    SELECT sp.id, sp.student_id, payment_split_breakdown(sp.id) AS b
      FROM student_payments AS sp
     WHERE sp.tenant_id = v_tenant
       AND sp.status IN ('RECEIVED', 'RECEIVED_IN_CASH')
       AND to_char(
             coalesce(sp.paid_at, sp.payment_date, sp.due_date), 'YYYY-MM'
           ) = v_month
  ),
  -- o que ENTROU na caixinha, por professor e aluno
  caixinha AS (
    SELECT (prof ->> 'teacher_id')::uuid AS teacher_id,
           p.student_id,
           round(sum((prof ->> 'custo')::numeric), 2) AS valor,
           count(DISTINCT p.id)::int AS avisos
      FROM pagos AS p
      CROSS JOIN LATERAL jsonb_array_elements(p.b -> 'professores') AS prof
     WHERE prof ->> 'custo' IS NOT NULL
       AND prof ->> 'teacher_id' IS NOT NULL
     GROUP BY 1, 2
  ),
  -- quantas cobranças cada aluno teve no mês, e se alguma ficou sem liquidar
  cobrancas AS (
    SELECT sp.student_id,
           count(*) FILTER (
             WHERE sp.status IN ('RECEIVED', 'RECEIVED_IN_CASH')
           )::int AS pagas,
           bool_or(sp.status = 'CONFIRMED') AS tem_confirmed
      FROM student_payments AS sp
     WHERE sp.tenant_id = v_tenant
       AND sp.student_id IS NOT NULL
       AND to_char(
             coalesce(sp.paid_at, sp.payment_date, sp.due_date), 'YYYY-MM'
           ) = v_month
     GROUP BY 1
  ),
  -- previsto pela agenda: é o MESMO cálculo do aviso (dias do mês × grade)
  previsto AS (
    SELECT b.teacher_id,
           count(*)::int AS aulas,
           round(sum(
             teacher_student_rate(b.teacher_id, b.student_id, d::date)
           ), 2) AS valor
      FROM bookings AS b
      CROSS JOIN generate_series(v_ini, v_fim, '1 day') AS d
     WHERE b.tenant_id = v_tenant
       AND coalesce(b.status, 'SCHEDULED') = 'SCHEDULED'
       AND b.student_id IS NOT NULL
       AND dow_name_to_int(b.day_of_week) = extract(dow FROM d)::int
       AND (b.start_date IS NULL OR d >= b.start_date)
     GROUP BY 1
  ),
  -- aula de mês anterior absorvida aqui: está na folha e não na caixinha do mês
  sobras AS (
    SELECT co.teacher_id,
           count(*)::int AS aulas,
           round(sum(co.amount), 2) AS valor
      FROM closing_carryovers AS co
      JOIN class_logs AS cl
        ON cl.id = co.class_log_id
       AND cl.tenant_id = v_tenant
     WHERE co.absorbed_month = v_month
     GROUP BY 1
  ),
  ajustes AS (
    SELECT a.teacher_id, round(sum(a.amount), 2) AS valor
      FROM closing_adjustments AS a
     WHERE a.tenant_id = v_tenant
       AND a.month_year = v_month
     GROUP BY 1
  ),
  fechamento AS (
    SELECT c.teacher_id, c.total_lessons, c.total_amount, c.status
      FROM teacher_closings AS c
     WHERE c.tenant_id = v_tenant
       AND c.month_year = v_month
  ),
  -- Professor da DIREÇÃO: o aviso manda 'custo': null de propósito, porque a
  -- régua dele é pró-labore (80%), não custo descontado do líquido. Ele não tem
  -- caixinha — mostrar "diferença = folha inteira" seria a tela mentindo.
  donos AS (
    SELECT o.teacher_id
      FROM payment_split_owner_teachers AS o
     WHERE o.tenant_id = v_tenant
  ),
  -- uma linha por professor×aluno, já classificada
  detalhe AS (
    SELECT coalesce(f.teacher_id, c.teacher_id) AS teacher_id,
           coalesce(f.student_id, c.student_id) AS student_id,
           coalesce(f.aulas, 0) AS aulas,
           coalesce(f.valor, 0) AS valor_folha,
           coalesce(c.valor, 0) AS valor_caixinha,
           coalesce(c.avisos, 0) AS avisos,
           coalesce(cb.pagas, 0) AS cobrancas_pagas,
           coalesce(cb.tem_confirmed, false) AS tem_confirmed
      FROM folha AS f
      FULL JOIN caixinha AS c
        ON c.teacher_id = f.teacher_id
       AND c.student_id IS NOT DISTINCT FROM f.student_id
      LEFT JOIN cobrancas AS cb
        ON cb.student_id = coalesce(f.student_id, c.student_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM donos AS o
        WHERE o.teacher_id = coalesce(f.teacher_id, c.teacher_id)
     )
  ),
  classificado AS (
    SELECT d.*,
           round(d.valor_folha - d.valor_caixinha, 2) AS diferenca,
           CASE
             WHEN d.student_id IS NULL THEN 'AULA_SEM_ALUNO'
             -- Pagou e mesmo assim não gerou caixinha: o aviso calcula o custo
             -- pela AGENDA, então aluno sem booking ativo sai com custo zero e
             -- o dinheiro entra sem nada ser separado para o professor.
             -- Chamar isso de "não pagou" seria a tela mentindo sobre o aluno.
             WHEN d.valor_caixinha = 0 AND d.cobrancas_pagas > 0
               THEN 'PAGOU_SEM_AGENDA'
             WHEN d.valor_caixinha = 0 AND d.tem_confirmed
               THEN 'PAGAMENTO_NAO_LIQUIDADO'
             WHEN d.valor_caixinha = 0 THEN 'ALUNO_SEM_PAGAMENTO'
             WHEN d.valor_caixinha > d.valor_folha AND d.avisos > 1
               THEN 'PAGAMENTO_REPETIDO'
             WHEN d.valor_caixinha > d.valor_folha THEN 'AULA_NAO_LANCADA'
             WHEN d.valor_folha > d.valor_caixinha THEN 'AGENDA_DESATUALIZADA'
             ELSE 'OK'
           END AS motivo
      FROM detalhe AS d
  ),
  por_professor AS (
    SELECT cl.teacher_id,
           jsonb_agg(
             jsonb_build_object(
               'motivo', cl.motivo,
               'aluno', coalesce(btrim(s.full_name), 'sem aluno vinculado'),
               'aulas', cl.aulas,
               'folha', cl.valor_folha,
               'caixinha', cl.valor_caixinha,
               'diferenca', cl.diferenca,
               'avisos', cl.avisos
             )
             ORDER BY abs(cl.diferenca) DESC, cl.valor_folha DESC
           ) FILTER (WHERE cl.motivo <> 'OK') AS itens,
           round(sum(cl.valor_folha), 2) AS folha_aulas,
           round(sum(cl.valor_caixinha), 2) AS caixinha
      FROM classificado AS cl
      LEFT JOIN profiles AS s ON s.id = cl.student_id
     GROUP BY 1
  )
  SELECT jsonb_agg(linha ORDER BY linha ->> 'teacher_name'), 
         jsonb_build_object(
           'previsto', round(coalesce(sum((linha ->> 'previsto')::numeric), 0), 2),
           'folha',    round(coalesce(sum((linha ->> 'folha')::numeric), 0), 2),
           'caixinha', round(coalesce(sum((linha ->> 'caixinha')::numeric), 0), 2),
           'diferenca',round(coalesce(sum((linha ->> 'diferenca')::numeric), 0), 2),
           'professores', count(*)::int,
           'pro_labore_fora', count(*) FILTER (
             WHERE (linha ->> 'pro_labore')::boolean)::int
         )
    INTO v_professores, v_totais
    FROM (
      SELECT jsonb_build_object(
               'teacher_id', t.id,
               'teacher_name', btrim(t.full_name),
               'previsto', coalesce(pv.valor, 0),
               'previsto_aulas', coalesce(pv.aulas, 0),
               'folha', coalesce(fc.total_amount, pp.folha_aulas, 0),
               'folha_aulas', coalesce(fc.total_lessons, 0),
               'status', coalesce(fc.status, 'SEM FECHAMENTO'),
               'pro_labore', (dn.teacher_id IS NOT NULL),
               'caixinha', CASE WHEN dn.teacher_id IS NULL
                                THEN coalesce(pp.caixinha, 0) END,
               'diferenca', CASE WHEN dn.teacher_id IS NULL THEN round(
                 coalesce(fc.total_amount, pp.folha_aulas, 0)
                 - coalesce(pp.caixinha, 0), 2) END,
               'sobras', jsonb_build_object(
                 'aulas', coalesce(sb.aulas, 0), 'valor', coalesce(sb.valor, 0)),
               'ajustes', coalesce(aj.valor, 0),
               'turbo', jsonb_build_object(
                 'ativo', teacher_turbo_on(t.id, v_fim),
                 'alunos', (SELECT count(*)::int FROM teacher_carteira(t.id)),
                 'detalhe', teacher_turbo_status_at(t.id, v_fim)),
               'itens', coalesce(pp.itens, '[]'::jsonb)
             ) AS linha
        FROM profiles AS t
        LEFT JOIN por_professor AS pp ON pp.teacher_id = t.id
        LEFT JOIN previsto AS pv ON pv.teacher_id = t.id
        LEFT JOIN sobras AS sb ON sb.teacher_id = t.id
        LEFT JOIN ajustes AS aj ON aj.teacher_id = t.id
        LEFT JOIN fechamento AS fc ON fc.teacher_id = t.id
        LEFT JOIN donos AS dn ON dn.teacher_id = t.id
       WHERE t.tenant_id = v_tenant
         AND t.role = 'TEACHER'
         AND (pp.teacher_id IS NOT NULL OR fc.teacher_id IS NOT NULL
              OR pv.teacher_id IS NOT NULL)
    ) AS x;

  RETURN jsonb_build_object(
    'month', v_month,
    'tenant', v_tenant,
    'totais', coalesce(v_totais, '{}'::jsonb),
    'professores', coalesce(v_professores, '[]'::jsonb)
  );
END;
$function$;

ALTER FUNCTION public.teacher_payroll_reconciliation(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.teacher_payroll_reconciliation(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teacher_payroll_reconciliation(text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.teacher_payroll_reconciliation(text, text) IS
  'Concilia a caixinha (custo avisado no grupo da gestão, calculado pela agenda) '
  'com a folha (aula efetivamente lançada), decompondo a diferença por motivo. '
  'Não recalcula pagamento: lê v_payable_class_logs e teacher_closings.';
