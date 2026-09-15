-- O lançamento de aula não pode calcular a folha inteira para achar o valor
-- de uma aula.
--
-- Em 15/09/2026 o engine juntava `v_payable_class_logs` por `pay.id::text`: a
-- view era calculada para as ~2.000 aulas da base a cada aula enviada (4,5 s
-- cada) e quem lançava 3 aulas de uma vez batia no limite de 8 s do PostgREST.
--
-- Se uma migration anterior mudar o corpo do engine e a âncora do patch sumir,
-- a própria migration falha no release. Este teste cobre o outro lado: alguém
-- derivar o engine de novo DEPOIS do patch e a junção por texto voltar.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

select pg_temp.assert_true(
  strpos(pg_get_functiondef('private.log_teacher_classes_engine(jsonb)'::regprocedure),
         'Só as aulas desta resposta') > 0,
  'engine de lançamento sem o filtro por uuid na junção com v_payable_class_logs'
);

select pg_temp.assert_true(
  strpos(pg_get_functiondef('private.log_teacher_classes_engine(jsonb)'::regprocedure),
         $anchor$left join public.v_payable_class_logs pay on pay.id::text = (r ->> 'id');$anchor$) = 0,
  'engine de lançamento voltou a juntar v_payable_class_logs só por texto (calcula a folha inteira)'
);

-- O wrapper chama o engine uma vez por aula; é ele que o frontend usa.
select pg_temp.assert_true(
  strpos(pg_get_functiondef('public.log_teacher_classes(jsonb)'::regprocedure),
         'private.log_explicit_teacher_classes') > 0,
  'public.log_teacher_classes deixou de ser o wrapper explícito'
);

rollback;
