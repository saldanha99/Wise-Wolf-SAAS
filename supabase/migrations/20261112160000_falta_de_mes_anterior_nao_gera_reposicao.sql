-- Falta lançada retroativamente de um mês já encerrado NÃO gera reposição.
--
-- Pedido da direção (12/11/2026): ao lançar agora as faltas de outubro, cada
-- uma criava uma reposição "Pendente" — o mês 12 acumularia aulas que não têm
-- mais como ser dadas. Aula do mês passado que não foi lançada a tempo fica
-- registrada (presença e pagamento seguem as regras de sempre), mas não vira
-- reposição. Vale para falta do aluno e do professor.
--
-- Remendo por âncora em private.log_teacher_classes_engine (definição viva),
-- re-executável: se o marcador já existe, não faz nada.

do $migration$
declare
  v_def text;
  v_anchor constant text :=
    E'and coalesce(v_subtype, \'\') not in (\'REPOSIÇÃO\', \'REPOSIÇÃO_PROF\')\n      then';
  v_patch constant text :=
    E'and coalesce(v_subtype, \'\') not in (\'REPOSIÇÃO\', \'REPOSIÇÃO_PROF\')\n'
    || E'         -- falta_de_mes_anterior_nao_gera_reposicao\n'
    || E'         and v_class_date >= pg_catalog.date_trunc(\'month\', (pg_catalog.now() at time zone \'America/Sao_Paulo\')::date)::date\n'
    || E'      then';
begin
  v_def := pg_catalog.pg_get_functiondef('private.log_teacher_classes_engine(jsonb)'::regprocedure);
  if pg_catalog.strpos(v_def, 'falta_de_mes_anterior_nao_gera_reposicao') > 0 then
    return;
  end if;
  if (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, v_anchor, '')))
       / pg_catalog.length(v_anchor) <> 1 then
    raise exception 'falta_de_mes_anterior: âncora não encontrada exatamente uma vez';
  end if;
  execute pg_catalog.replace(v_def, v_anchor, v_patch);
end;
$migration$;
