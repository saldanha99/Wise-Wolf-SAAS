-- Notificações de reposição pela data real da aula (direção, 12/11/2026).
--
-- 1. A cota de reposições do aluno não conta reposição encerrada pela direção
--    (ex.: as faltas de meses anteriores lançadas fora do prazo).
-- 2. O motor de lançamento também ignora reposição encerrada ao contar as 4
--    do mês.
-- 3. O "faltou" ao aluno só sai para falta do mês corrente (data da aula, não
--    data do lançamento) — mês anterior nunca gera aviso.
-- Remendos por âncora, re-executáveis.

create or replace function public.care_student_makeup_quota(p_tenant text, p_student uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'limit', 4,
    'used', (
      select count(*) from public.reschedules r
       where r.tenant_id = p_tenant and r.student_id = p_student and r.fault_type = 'STUDENT'
         and r.closed_reason is null
         and r.created_at >= pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'America/Sao_Paulo')
    ),
    'pending_without_date', (
      select count(*) from public.reschedules r
       where r.tenant_id = p_tenant and r.student_id = p_student and r.fault_type = 'STUDENT'
         and r.closed_reason is null
         and r.used_at is null and (r.date is null or r.date = 'Pendente')
    )
  );
$function$;

do $migration$
declare
  v_def text;
  v_anchor text;
begin
  -- 2. motor de lançamento
  v_def := pg_catalog.pg_get_functiondef('private.log_teacher_classes_engine(jsonb)'::regprocedure);
  if pg_catalog.strpos(v_def, 'cota_ignora_reposicao_encerrada') = 0 then
    v_anchor := E'and r.fault_type = \'STUDENT\'\n             and r.created_at >= pg_catalog.date_trunc(\'month\', pg_catalog.now());';
    if pg_catalog.strpos(v_def, v_anchor) = 0 then
      raise exception 'notificacao_de_reposicao: âncora do motor não encontrada';
    end if;
    execute pg_catalog.replace(v_def, v_anchor,
      E'and r.fault_type = \'STUDENT\'\n             -- cota_ignora_reposicao_encerrada\n             and r.closed_reason is null\n             and r.created_at >= pg_catalog.date_trunc(\'month\', pg_catalog.now());');
  end if;

  -- 3. aviso "faltou" só para falta do mês corrente
  v_def := pg_catalog.pg_get_functiondef('public.care_due_absence_followups(integer)'::regprocedure);
  if pg_catalog.strpos(v_def, 'falta_do_mes_corrente') = 0 then
    v_anchor := E'and l.created_at >= pg_catalog.now() - interval \'3 days\'';
    if pg_catalog.strpos(v_def, v_anchor) = 0 then
      raise exception 'notificacao_de_reposicao: âncora do aviso de falta não encontrada';
    end if;
    execute pg_catalog.replace(v_def, v_anchor,
      v_anchor || E'\n     -- falta_do_mes_corrente\n     and l.class_date >= pg_catalog.date_trunc(\'month\', (pg_catalog.now() at time zone \'America/Sao_Paulo\')::date)::date');
  end if;
end;
$migration$;
