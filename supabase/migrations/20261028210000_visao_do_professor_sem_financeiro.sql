-- Tela de alunos: o professor vê o pedagógico dos alunos DELE, nunca o dinheiro.
--
-- Antes, list_students_overview entregava ao professor mensalidade, status
-- financeiro, quantidade e valor em atraso (e "Pagamento em atraso" como motivo
-- de risco) — o card mostrava "2 em atraso" para o professor. E o escopo dele
-- era "qualquer agendamento, de qualquer época": aluno de outro titular,
-- inativo ou encerrado continuava entrando. Agora o professor usa a MESMA régua
-- da leitura de perfis (public._teacher_can_access_student) e recebe o
-- financeiro zerado; o risco dele só pesa faltas, inatividade e frequência.
-- Direção e SUPER_ADMIN não mudam.

CREATE OR REPLACE FUNCTION public.list_students_overview()
 RETURNS TABLE(student_id uuid, full_name text, avatar_url text, module text, professor_id uuid, professor_name text, monthly_fee numeric, status_financial text, phone text, is_kids boolean, attended_90 integer, absent_90 integer, attendance_rate integer, last_class_date date, days_since_last integer, overdue_count integer, overdue_value numeric, xp integer, streak_count integer, last_activity timestamp with time zone, risk_level text, risk_score integer, risk_reasons text[], has_activity boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant text; v_money boolean;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = v_uid;
  IF v_role IS NULL OR NOT private.can_execute_legacy_role_rpc(ARRAY['SCHOOL_ADMIN','SUPER_ADMIN','TEACHER']::text[]) THEN RETURN; END IF;
  -- Dinheiro é da direção: professor recebe o financeiro zerado.
  v_money := v_role IN ('SCHOOL_ADMIN','SUPER_ADMIN');
  RETURN QUERY
  WITH students AS (
    SELECT p.* FROM profiles p WHERE p.role = 'STUDENT'
      AND (v_role='SUPER_ADMIN'
        OR (v_role='SCHOOL_ADMIN' AND p.tenant_id=v_tenant)
        OR (v_role='TEACHER' AND public._teacher_can_access_student(p.id, v_tenant)))
  ),
  freq AS (
    SELECT cl.student_id,
      count(*) FILTER (WHERE cl.presence='COMPLETED' AND cl.class_date>=current_date-90) AS att90,
      count(*) FILTER (WHERE cl.presence='STUDENT_ABSENCE' AND cl.class_date>=current_date-90) AS abs90,
      count(*) FILTER (WHERE cl.presence='STUDENT_ABSENCE' AND cl.class_date>=current_date-45) AS abs45,
      max(cl.class_date) FILTER (WHERE cl.presence IN ('COMPLETED','STUDENT_ABSENCE')) AS last_cd
    FROM class_logs cl WHERE cl.student_id IN (SELECT id FROM students) GROUP BY cl.student_id
  ),
  pay AS (
    SELECT sp.student_id, count(*) FILTER (WHERE sp.status='OVERDUE') AS od_count,
      coalesce(sum(sp.value) FILTER (WHERE sp.status='OVERDUE'),0) AS od_value
    FROM student_payments sp WHERE sp.student_id IN (SELECT id FROM students)
      AND NOT private.student_payment_is_covered(sp.id)
      AND private.student_payment_prepayment_state(sp.id) IS DISTINCT FROM 'REVIEW'
    GROUP BY sp.student_id
  ),
  base AS (
    SELECT s.id, s.full_name, s.avatar_url, s.module, s.professor_id,
      CASE WHEN v_money THEN s.monthly_fee END AS monthly_fee,
      CASE WHEN v_money THEN s.status_financial END AS status_financial, s.phone, coalesce(s.is_kids,false) AS is_kids,
      coalesce(f.att90,0) AS att90, coalesce(f.abs90,0) AS abs90, coalesce(f.abs45,0) AS abs45,
      CASE WHEN coalesce(f.att90,0)+coalesce(f.abs90,0)>0 THEN round(100.0*f.att90/(f.att90+f.abs90))::int END AS rate,
      f.last_cd,
      CASE WHEN f.last_cd IS NOT NULL THEN (current_date-f.last_cd) END AS dsl,
      CASE WHEN v_money THEN coalesce(pp.od_count,0) ELSE 0 END AS od_count,
      CASE WHEN v_money THEN coalesce(pp.od_value,0) ELSE 0 END AS od_value,
      coalesce(s.xp,0) AS xp, coalesce(s.streak_count,0) AS streak, s.last_activity, s.offboarding_status,
      (EXISTS (SELECT 1 FROM bookings b WHERE b.student_id=s.id)
        OR EXISTS (SELECT 1 FROM student_payments sp2 WHERE sp2.student_id=s.id)) AS has_activity
    FROM students s LEFT JOIN freq f ON f.student_id=s.id LEFT JOIN pay pp ON pp.student_id=s.id
  ),
  scored AS (
    SELECT b.*,
      ((b.od_count>0)::int + (b.abs45>=2)::int + (b.offboarding_status IS NOT NULL AND b.offboarding_status<>'')::int) AS strong,
      ((b.dsl>30)::int + ((b.att90+b.abs90)>=4 AND b.rate<60)::int) AS weak,
      array_remove(ARRAY[
        CASE WHEN b.od_count>0 THEN 'Pagamento em atraso' END,
        CASE WHEN b.abs45>=2 THEN b.abs45||' faltas recentes' END,
        CASE WHEN b.offboarding_status IS NOT NULL AND b.offboarding_status<>'' THEN 'Saída solicitada' END,
        CASE WHEN b.dsl>30 THEN 'Inativo há '||b.dsl||' dias' END,
        CASE WHEN (b.att90+b.abs90)>=4 AND b.rate<60 THEN 'Frequência baixa ('||b.rate||'%)' END
      ], NULL) AS reasons
    FROM base b
  )
  SELECT sc.id, sc.full_name, sc.avatar_url, sc.module, sc.professor_id,
    (SELECT pr.full_name FROM profiles pr WHERE pr.id=sc.professor_id),
    sc.monthly_fee, CASE
      WHEN NOT v_money THEN NULL
      WHEN private.student_month_prepayment_review(sc.id, current_date) THEN 'PENDING'
      WHEN sc.od_count = 0 AND private.student_month_covered(sc.id, current_date) THEN 'ACTIVE'
      ELSE sc.status_financial END, sc.phone, sc.is_kids,
    sc.att90::int, sc.abs90::int, sc.rate, sc.last_cd, sc.dsl::int,
    sc.od_count::int, sc.od_value, sc.xp::int, sc.streak::int, sc.last_activity,
    CASE WHEN sc.strong>=2 OR (sc.strong>=1 AND sc.weak>=1) THEN 'HIGH'
         WHEN sc.strong=1 OR sc.weak>=2 THEN 'MEDIUM' ELSE 'LOW' END,
    (sc.strong*2+sc.weak)::int,
    CASE WHEN (sc.strong>=1 OR sc.weak>=2) THEN sc.reasons ELSE ARRAY[]::text[] END,
    sc.has_activity
  FROM scored sc
  ORDER BY (sc.strong*2+sc.weak) DESC, sc.full_name;
END;
$function$;


alter function public.list_students_overview() owner to postgres;
revoke all on function public.list_students_overview() from public, anon;
grant execute on function public.list_students_overview() to authenticated;
