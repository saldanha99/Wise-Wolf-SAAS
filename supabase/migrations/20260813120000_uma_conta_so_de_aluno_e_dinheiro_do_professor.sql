-- Uma conta só: quantos alunos o professor tem, e quanto ele já ganhou no mês.
--
-- Caso do Flávio (13/08/2026). Três telas, três respostas para as MESMAS duas
-- perguntas — e nenhuma delas era a que decide o pagamento:
--
--   Alunos    | Dashboard do professor: 11 | Ficha (diretor): 11 | Turbo: 10
--   Ganho ago | Dashboard: R$ 392,00       | Ficha: R$ 368,00    | Financeiro: R$ 375,50
--
-- O "11" é o perfil TREINAMENTO (lifecycle offboarded, não faturável) que tem
-- agendamento com ele. A carteira que destrava o turbo (`teacher_carteira`) o
-- exclui e dá 10 — exatamente o mínimo da regra. O professor via 11 e achava que
-- tinha folga; se um aluno saísse, o turbo desligava sem ele entender por quê.
--
-- Os dois valores errados vinham da mesma causa: `aulas × hourly_rate` calculado
-- fora de `v_payable_class_logs`. Isso ignora a faixa por antiguidade (10º aluno
-- em diante é R$ 10,50), ignora override do diretor e conta aula que não paga
-- (perfil não faturável, experimental sem comparecimento, duplicata). É a mesma
-- estimativa local que já gerou contestação em série no TeacherFinancials.
--
-- Reproduzido em produção: até 12/08 o Financeiro mostrava R$ 301,00 (37 aulas
-- pagáveis) e o Dashboard R$ 304,00 (38 × R$ 8,00). Foi o print do professor.

-- 1) Ficha do professor (diretor) ---------------------------------------------
CREATE OR REPLACE FUNCTION public.get_teacher_overview(p_teacher_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_role text; v_tenant text; t profiles%ROWTYPE;
  v_c30 int; v_a30 int; v_cmonth int; v_conf int; v_avg numeric; v_rc int;
  v_students int; v_linked int; v_earned numeric;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id=v_uid;
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN RETURN jsonb_build_object('error','sem_permissao'); END IF;
  SELECT * INTO t FROM profiles WHERE id=p_teacher_id AND role='TEACHER';
  IF NOT FOUND THEN RETURN jsonb_build_object('error','nao_encontrado'); END IF;
  IF v_role='SCHOOL_ADMIN' AND t.tenant_id <> v_tenant THEN RETURN jsonb_build_object('error','sem_permissao'); END IF;

  SELECT count(*) FILTER (WHERE presence='COMPLETED' AND class_date>=current_date-30),
         count(*) FILTER (WHERE presence='TEACHER_ABSENCE' AND class_date>=current_date-30),
         count(*) FILTER (WHERE presence='COMPLETED' AND class_date>=date_trunc('month',current_date))
    INTO v_c30, v_a30, v_cmonth FROM class_logs WHERE teacher_id=p_teacher_id;
  SELECT count(*) FILTER (WHERE status='CONFLICT'), avg(student_rating) FILTER (WHERE student_rating IS NOT NULL), count(student_rating)
    INTO v_conf, v_avg, v_rc FROM attendance_confirmations WHERE teacher_id=p_teacher_id;

  -- Carteira = a MESMA função que decide o turbo e a tarifa. Contar `bookings`
  -- direto trazia perfil de treinamento, aluno desligado e agendamento cancelado.
  SELECT count(*) INTO v_students FROM teacher_carteira(p_teacher_id);
  -- Vinculados = tudo que aparece na agenda dele. Fica exposto ao lado para o
  -- diretor entender a diferença em vez de achar que sumiu aluno da ficha.
  SELECT count(DISTINCT student_id) INTO v_linked FROM bookings WHERE teacher_id=p_teacher_id;

  -- Ganho do mês: a fonte do pagamento, não uma estimativa por tarifa média.
  SELECT round(coalesce(sum(v.rate_efetivo),0),2) INTO v_earned
    FROM v_payable_class_logs v
   WHERE v.teacher_id=p_teacher_id AND v.class_date>=date_trunc('month',current_date)::date;

  RETURN jsonb_build_object(
    'profile', jsonb_build_object('id',t.id,'full_name',t.full_name,'avatar_url',t.avatar_url,'email',t.email,'phone',t.phone,
       'status',t.status,'hourly_rate',t.hourly_rate,'commission_rate',t.commission_rate,'specializations',t.specializations,
       'pix_ok',(t.pix_key IS NOT NULL AND t.pix_key<>''),
       'contract_ok',(coalesce(t.contract_accepted,false) OR t.accepted_at IS NOT NULL OR t.documentation_status='APPROVED')),
    'metrics', jsonb_build_object('active_students',v_students,'linked_students',v_linked,
       'classes_30',v_c30,'teacher_absence_30',v_a30,
       'absence_rate', CASE WHEN v_c30+v_a30>0 THEN round(100.0*v_a30/(v_c30+v_a30))::int ELSE 0 END,
       'conflicts_open',coalesce(v_conf,0),'avg_rating',round(v_avg,1),'rating_count',coalesce(v_rc,0),
       'earnings_est', v_earned),
    'students', coalesce((SELECT jsonb_agg(jsonb_build_object('id',sp.id,'name',sp.full_name,'module',sp.module,
         'na_carteira', EXISTS (SELECT 1 FROM teacher_carteira(p_teacher_id) c WHERE c.student_id=sp.id)) ORDER BY sp.full_name)
       FROM (SELECT DISTINCT b.student_id FROM bookings b WHERE b.teacher_id=p_teacher_id) bb
       JOIN profiles sp ON sp.id=bb.student_id), '[]'::jsonb),
    'recent_classes', coalesce((SELECT jsonb_agg(jsonb_build_object('date',cl.class_date,'presence',cl.presence,
       'student',(SELECT full_name FROM profiles WHERE id=cl.student_id)) ORDER BY cl.class_date DESC NULLS LAST)
       FROM (SELECT * FROM class_logs WHERE teacher_id=p_teacher_id ORDER BY class_date DESC NULLS LAST LIMIT 20) cl), '[]'::jsonb),
    'closings', coalesce((SELECT jsonb_agg(jsonb_build_object('month',c.month_year,'amount',c.total_amount,'status',c.status,
       'confirmation',c.teacher_confirmation_status) ORDER BY c.month_year DESC)
       FROM (SELECT * FROM teacher_closings WHERE teacher_id=p_teacher_id ORDER BY month_year DESC LIMIT 6) c), '[]'::jsonb),
    'absences', coalesce((SELECT jsonb_agg(jsonb_build_object('starts_at',a.starts_at,'ends_at',a.ends_at,'reason',a.reason,'status',a.status) ORDER BY a.starts_at DESC)
       FROM teacher_absences a WHERE a.teacher_id=p_teacher_id), '[]'::jsonb),
    'audit', coalesce((SELECT jsonb_agg(jsonb_build_object('field',al.field,'old_value',al.old_value,'new_value',al.new_value,'changed_at',al.changed_at,
       'changed_by',(SELECT full_name FROM profiles WHERE id=al.changed_by)) ORDER BY al.changed_at DESC)
       FROM (SELECT * FROM profile_audit_log WHERE profile_id=p_teacher_id ORDER BY changed_at DESC LIMIT 20) al), '[]'::jsonb)
  );
END;
$function$;

ALTER FUNCTION public.get_teacher_overview(uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.get_teacher_overview(uuid) IS
  'Ficha 360 do professor. active_students = teacher_carteira (a mesma que destrava o turbo); linked_students = tudo que aparece na agenda. earnings_est vem de v_payable_class_logs — nunca aulas × hourly_rate.';

-- 2) Lista de professores (painel "Gestão Profs") ------------------------------
CREATE OR REPLACE FUNCTION public.list_teachers_overview()
RETURNS TABLE(teacher_id uuid, full_name text, avatar_url text, status text, hourly_rate numeric,
  commission_rate numeric, specializations text[], active_students integer, classes_30 integer,
  teacher_absence_30 integer, absence_rate integer, conflicts_open integer, avg_rating numeric,
  rating_count integer, earnings_est numeric, nf_pending boolean, pix_ok boolean, contract_ok boolean,
  alert_level text, alert_score integer, alert_reasons text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = v_uid;
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN RETURN; END IF;
  RETURN QUERY
  WITH teachers AS (SELECT p.* FROM profiles p WHERE p.role='TEACHER' AND (v_role='SUPER_ADMIN' OR p.tenant_id=v_tenant)),
  cl AS (
    SELECT lg.teacher_id AS tid,
      count(*) FILTER (WHERE lg.presence='COMPLETED' AND lg.class_date>=current_date-30) AS c30,
      count(*) FILTER (WHERE lg.presence='TEACHER_ABSENCE' AND lg.class_date>=current_date-30) AS a30
    FROM class_logs lg WHERE lg.teacher_id IN (SELECT id FROM teachers) GROUP BY lg.teacher_id
  ),
  -- Carteira, não `count(distinct bookings.student_id)`: o segundo conta perfil
  -- de treinamento, aluno desligado e agendamento cancelado.
  stu AS (SELECT t.id AS tid, (SELECT count(*) FROM teacher_carteira(t.id)) AS n FROM teachers t),
  -- Ganho do mês pela fonte do pagamento.
  earn AS (
    SELECT v.teacher_id AS tid, round(coalesce(sum(v.rate_efetivo),0),2) AS valor
    FROM v_payable_class_logs v
    WHERE v.teacher_id IN (SELECT id FROM teachers)
      AND v.class_date >= date_trunc('month', current_date)::date
    GROUP BY v.teacher_id
  ),
  conf AS (SELECT ac.teacher_id AS tid, count(*) FILTER (WHERE ac.status='CONFLICT') AS conflicts,
      avg(ac.student_rating) FILTER (WHERE ac.student_rating IS NOT NULL) AS avg_r, count(ac.student_rating) AS rc
    FROM attendance_confirmations ac WHERE ac.teacher_id IN (SELECT id FROM teachers) GROUP BY ac.teacher_id),
  closings AS (SELECT tc.teacher_id AS tid, bool_or(tc.status='PENDENTE') AS nf_pending FROM teacher_closings tc WHERE tc.teacher_id IN (SELECT id FROM teachers) GROUP BY tc.teacher_id),
  base AS (
    SELECT t.id, t.full_name, t.avatar_url, t.status, t.hourly_rate, t.commission_rate, t.specializations,
      coalesce(s.n,0) AS students, coalesce(c.c30,0) AS c30, coalesce(c.a30,0) AS a30,
      coalesce(e.valor,0) AS earn_month,
      coalesce(cf.conflicts,0) AS conflicts, round(cf.avg_r,1) AS avg_r, coalesce(cf.rc,0) AS rc,
      coalesce(cl2.nf_pending,false) AS nf_pending,
      (t.pix_key IS NOT NULL AND t.pix_key<>'') AS pix_ok,
      (coalesce(t.contract_accepted,false) OR t.accepted_at IS NOT NULL OR t.documentation_status='APPROVED') AS contract_ok
    FROM teachers t
    LEFT JOIN cl c ON c.tid=t.id
    LEFT JOIN stu s ON s.tid=t.id
    LEFT JOIN earn e ON e.tid=t.id
    LEFT JOIN conf cf ON cf.tid=t.id
    LEFT JOIN closings cl2 ON cl2.tid=t.id
  ),
  scored AS (
    SELECT b.*,
      ((b.a30>=2)::int + (b.conflicts>0)::int + (b.nf_pending)::int) AS strong,
      ((b.rc>=3 AND b.avg_r<3.5)::int + (NOT b.pix_ok OR NOT b.contract_ok)::int) AS weak,
      CASE WHEN b.c30+b.a30>0 THEN round(100.0*b.a30/(b.c30+b.a30))::int ELSE 0 END AS abs_rate,
      array_remove(ARRAY[
        CASE WHEN b.a30>=2 THEN b.a30||' faltas do professor (30d)' END,
        CASE WHEN b.conflicts>0 THEN b.conflicts||' conflito(s) de presença' END,
        CASE WHEN b.nf_pending THEN 'Fechamento/NF pendente' END,
        CASE WHEN b.rc>=3 AND b.avg_r<3.5 THEN 'Avaliação baixa ('||b.avg_r||')' END,
        CASE WHEN NOT b.pix_ok THEN 'PIX não cadastrado' END,
        CASE WHEN NOT b.contract_ok THEN 'Contrato pendente' END
      ], NULL) AS reasons
    FROM base b
  )
  SELECT sc.id, sc.full_name, sc.avatar_url, sc.status, sc.hourly_rate::numeric, sc.commission_rate::numeric, sc.specializations,
    sc.students::int, sc.c30::int, sc.a30::int, sc.abs_rate, sc.conflicts::int, sc.avg_r::numeric, sc.rc::int,
    sc.earn_month::numeric, sc.nf_pending, sc.pix_ok, sc.contract_ok,
    CASE WHEN sc.strong>=2 OR (sc.strong>=1 AND sc.weak>=1) THEN 'HIGH' WHEN sc.strong=1 OR sc.weak>=2 THEN 'MEDIUM' ELSE 'LOW' END,
    (sc.strong*2+sc.weak)::int, sc.reasons
  FROM scored sc ORDER BY (sc.strong*2+sc.weak) DESC, sc.full_name;
END;
$function$;

ALTER FUNCTION public.list_teachers_overview() OWNER TO postgres;

-- 3) Projeção: devolver a TABELA DE FAIXAS junto -------------------------------
-- O card do turbo, os nudges e o onboarding escreviam "5º ao 9º: R$ 9,50 · 10º+:
-- R$ 10,50" em texto fixo. `teacher_pay_tiers` da escola tem só duas faixas
-- (1 → R$ 8,00 e 10 → R$ 10,50): a faixa de R$ 9,50 NÃO existe, e o professor lia
-- na tela uma promessa que a folha não cumpre. Agora a tela monta a frase a
-- partir daqui — mexer na tabela muda o texto junto, sem passar por deploy.
CREATE OR REPLACE FUNCTION public.teacher_pay_projection(p_teacher uuid, p_month text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_month text; v_start date; v_end date; v_tenant text;
        v_logged_n int; v_logged numeric; v_pot_base numeric; v_pot_turbo numeric;
        v_active int; v_next int; v_next_rate numeric; v_base numeric; v_tiers jsonb;
BEGIN
  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  v_start := (v_month||'-01')::date;
  v_end   := (date_trunc('month', v_start) + INTERVAL '1 month - 1 day')::date;

  SELECT tenant_id INTO v_tenant FROM profiles WHERE id = p_teacher;
  SELECT rate INTO v_base FROM teacher_pay_tiers WHERE tenant_id = v_tenant AND min_students = 1;
  v_base := COALESCE(v_base, 0);

  SELECT count(*), COALESCE(sum(v.rate_efetivo),0) INTO v_logged_n, v_logged
  FROM v_payable_class_logs v
  WHERE v.teacher_id = p_teacher AND to_char(v.class_date,'YYYY-MM') = v_month;

  SELECT count(*) INTO v_active FROM teacher_carteira(p_teacher);

  WITH aulas_previstas AS (
    SELECT b.student_id
    FROM bookings b
    CROSS JOIN generate_series(v_start, v_end, '1 day') d
    WHERE b.teacher_id = p_teacher AND b.student_id IS NOT NULL
      AND COALESCE(b.status,'SCHEDULED') = 'SCHEDULED'
      AND dow_name_to_int(b.day_of_week) = EXTRACT(dow FROM d)::int
      AND (b.start_date IS NULL OR d >= b.start_date)
  )
  SELECT COALESCE(count(*),0) * v_base,
         COALESCE(sum(COALESCE(
           (SELECT t.rate FROM teacher_pay_tiers t
             WHERE t.tenant_id = v_tenant AND t.min_students <= c.rnk
             ORDER BY t.min_students DESC LIMIT 1), v_base)), 0)
    INTO v_pot_base, v_pot_turbo
  FROM aulas_previstas a
  LEFT JOIN teacher_carteira(p_teacher) c ON c.student_id = a.student_id;

  IF v_active < 10 THEN v_pot_turbo := v_pot_base; END IF;

  SELECT min_students, rate INTO v_next, v_next_rate FROM teacher_pay_tiers
   WHERE tenant_id = v_tenant AND min_students > v_active ORDER BY min_students ASC LIMIT 1;

  -- Faixas reais da escola, em ordem — a fonte do texto mostrado ao professor.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('min_students', t.min_students, 'rate', t.rate)
                            ORDER BY t.min_students), '[]'::jsonb)
    INTO v_tiers FROM teacher_pay_tiers t WHERE t.tenant_id = v_tenant;

  RETURN jsonb_build_object(
    'month', v_month, 'turbo', teacher_turbo_status(p_teacher),
    'lessons_logged', v_logged_n, 'amount_logged', round(v_logged,2),
    'amount_potential_base', round(v_pot_base,2), 'amount_potential_turbo', round(v_pot_turbo,2),
    'active_students', v_active, 'next_tier_at', v_next, 'next_tier_rate', v_next_rate,
    'students_to_next', CASE WHEN v_next IS NULL THEN NULL ELSE v_next - v_active END,
    'base_rate', v_base, 'tiers', v_tiers
  );
END; $function$;

ALTER FUNCTION public.teacher_pay_projection(uuid, text) OWNER TO postgres;

COMMENT ON FUNCTION public.teacher_pay_projection(uuid, text) IS
  'Projeção do mês do professor + status do turbo + as faixas REAIS de teacher_pay_tiers. Nenhuma tela deve chumbar valor de aula: o que a escola paga está em tiers.';
