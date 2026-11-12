-- Falta lançada de um mês já encerrado não gera reposição (12/11/2026).
-- A trava vive dentro de private.log_teacher_classes_engine, junto da regra
-- que cria a reposição: se alguém recriar a função sem ela, este teste reprova.
do $test$
declare
  v_def text := pg_catalog.pg_get_functiondef('private.log_teacher_classes_engine(jsonb)'::regprocedure);
begin
  if pg_catalog.strpos(v_def, 'falta_de_mes_anterior_nao_gera_reposicao') = 0 then
    raise exception 'falta_de_mes_anterior: marcador ausente no motor de lançamento';
  end if;
  if pg_catalog.strpos(v_def,
       'and v_class_date >= pg_catalog.date_trunc(''month'', (pg_catalog.now() at time zone ''America/Sao_Paulo'')::date)::date') = 0 then
    raise exception 'falta_de_mes_anterior: condição do mês corrente ausente';
  end if;
  -- A trava precisa estar ANTES dos dois inserts de reposição (professor e aluno).
  if pg_catalog.strpos(v_def, 'falta_de_mes_anterior_nao_gera_reposicao')
       > pg_catalog.strpos(v_def, 'insert into public.reschedules') then
    raise exception 'falta_de_mes_anterior: condição depois do insert da reposição';
  end if;
end;
$test$;
