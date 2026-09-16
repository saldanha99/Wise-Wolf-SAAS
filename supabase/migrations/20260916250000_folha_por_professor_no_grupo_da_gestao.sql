-- Folha do mês por professor, para o grupo da Gestão.
--
-- Pedido da direção (16/09/2026): no fim do mês, aparecer no grupo quanto
-- cada professor ganhou — e as coberturas linha a linha, porque a folha se
-- afasta do previsto pela agenda exatamente pelo que foi coberto.
--
-- Fonte: `teacher_closings` (a folha oficial; o mesmo número que o professor
-- recebe no fechamento). As coberturas confirmadas do mês entram pelo
-- `class_log_id` (a aula que mudou de dono) e pelo `rate_efetivo` de
-- `v_payable_class_logs` — o valor pago a quem cobriu. Para quem cedeu, só a
-- contagem: o valor "que ele teria recebido" depende da faixa dele e não é
-- um fato, é uma conta hipotética.
--
-- "Previsto pela agenda" = folha − recebidas + cedidas (na tarifa de quem
-- cobriu, única medida que existe da aula). Serve para a diferença ficar
-- visível, não para contestar a folha.
-- Re-executável: roda a cada release.

create or replace function public.gestao_payroll_summary(p_tenant text, p_month text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_month text := left(btrim(coalesce(p_month, '')), 7);
  v_start date;
  v_end date;
  v_rows jsonb;
  v_total numeric := 0;
  v_lessons int := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if v_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    return jsonb_build_object('ok', false, 'error', 'mes_invalido');
  end if;
  v_start := (v_month || '-01')::date;
  v_end := (v_start + interval '1 month')::date;

  with closings as (
    select distinct on (c.teacher_id)
           c.teacher_id, c.total_lessons, c.total_amount, c.status
      from public.teacher_closings c
     where c.tenant_id = p_tenant and c.month_year = v_month
     order by c.teacher_id, c.created_at desc
  ),
  cov as (
    select cc.cover_teacher_id, cc.original_teacher_id, cc.class_date, cc.class_time, cc.student_id,
           v.rate_efetivo, s.full_name as student_name, o.full_name as original_name, k.full_name as cover_name
      from public.class_coverages cc
      left join public.v_payable_class_logs v on v.id = cc.class_log_id
      left join public.profiles s on s.id = cc.student_id
      left join public.profiles o on o.id = cc.original_teacher_id
      left join public.profiles k on k.id = cc.cover_teacher_id
     where cc.tenant_id = p_tenant and lower(cc.status) = 'confirmed'
       and cc.class_date >= v_start and cc.class_date < v_end
  ),
  teachers as (
    select t.id, t.full_name
      from public.profiles t
      join public.tenant_memberships m on m.user_id = t.id and m.tenant_id = p_tenant and m.role = 'TEACHER' and m.status = 'ACTIVE'
     where t.role = 'TEACHER' and t.tenant_id = p_tenant
       and coalesce(t.is_test_account, false) = false
       and (exists (select 1 from closings c where c.teacher_id = t.id)
            or exists (select 1 from cov where cov.cover_teacher_id = t.id or cov.original_teacher_id = t.id))
  )
  select jsonb_agg(jsonb_build_object(
           'teacher_id', t.id,
           'name', t.full_name,
           'lessons', coalesce(c.total_lessons, 0),
           'amount', coalesce(c.total_amount, 0),
           'status', coalesce(c.status, 'SEM_FECHAMENTO'),
           'received', (select jsonb_build_object(
                          'count', count(*), 'amount', coalesce(sum(rate_efetivo), 0),
                          'items', coalesce(jsonb_agg(jsonb_build_object('date', class_date, 'time', left(class_time, 5), 'student', student_name, 'from', original_name, 'amount', rate_efetivo) order by class_date, class_time), '[]'::jsonb))
                          from cov where cov.cover_teacher_id = t.id),
           'ceded', (select jsonb_build_object(
                          'count', count(*),
                          'items', coalesce(jsonb_agg(jsonb_build_object('date', class_date, 'time', left(class_time, 5), 'student', student_name, 'to', cover_name) order by class_date, class_time), '[]'::jsonb))
                          from cov where cov.original_teacher_id = t.id),
           'projected', coalesce(c.total_amount, 0)
                        - coalesce((select sum(rate_efetivo) from cov where cov.cover_teacher_id = t.id), 0)
                        + coalesce((select sum(rate_efetivo) from cov where cov.original_teacher_id = t.id), 0)
         ) order by t.full_name),
         coalesce(sum(c.total_amount), 0), coalesce(sum(c.total_lessons), 0)
    into v_rows, v_total, v_lessons
    from teachers t
    left join closings c on c.teacher_id = t.id;

  return jsonb_build_object(
    'ok', true, 'month', v_month,
    'teachers', coalesce(v_rows, '[]'::jsonb),
    'total_amount', v_total, 'total_lessons', v_lessons
  );
end;
$function$;

revoke all on function public.gestao_payroll_summary(text, text) from public, anon, authenticated;
grant execute on function public.gestao_payroll_summary(text, text) to service_role;
