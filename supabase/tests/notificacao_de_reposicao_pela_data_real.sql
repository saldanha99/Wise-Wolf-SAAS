begin;
-- Reposição: cota sem encerradas, motor sem encerradas, aviso só do mês corrente.
do $test$
begin
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.care_student_makeup_quota(text,uuid)'::regprocedure), 'r.closed_reason is null') = 0 then
    raise exception 'notificacao_de_reposicao: cota conta reposição encerrada';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('private.log_teacher_classes_engine(jsonb)'::regprocedure), 'cota_ignora_reposicao_encerrada') = 0 then
    raise exception 'notificacao_de_reposicao: motor conta reposição encerrada';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.care_due_absence_followups(integer)'::regprocedure), 'falta_do_mes_corrente') = 0 then
    raise exception 'notificacao_de_reposicao: aviso de falta sem trava do mês corrente';
  end if;
end;
$test$;
rollback;
