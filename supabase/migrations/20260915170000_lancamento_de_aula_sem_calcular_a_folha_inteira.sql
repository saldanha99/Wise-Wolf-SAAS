-- ─────────────────────────────────────────────────────────────────────────────
-- Lançamento de aula estourava o limite de 8 s do PostgREST (15/09/2026)
--
-- Relato: uma professora marcou 7 aulas e recebeu "Não foi possível confirmar o
-- resultado". Nada foi gravado — o banco cancelou a chamada por timeout
-- (resposta 500 de exatamente 100 bytes = 57014). Desde 14/09 houve outras
-- falhas iguais; a média de `log_teacher_classes` era 3,6 s por chamada.
--
-- Causa: para devolver o valor de cada aula lançada, o engine fazia
--   left join public.v_payable_class_logs pay on pay.id::text = (r ->> 'id')
-- O cast para texto impede o filtro de chegar ao índice de `class_logs`, e o
-- planejador calcula a VIEW INTEIRA — `teacher_student_rate` para as ~2.000
-- aulas da base, com turbo, carteira e `is_billable_student` por linha (4,5 s).
-- Desde 12/09 o wrapper `log_explicit_teacher_classes` chama o engine UMA VEZ
-- POR AULA (savepoint por linha), então o custo passou a ser multiplicado pelo
-- número de aulas enviadas: 3 ou mais estouram os 8 s.
--
-- Conserto: o mesmo JOIN, restrito aos ids desta resposta por uuid. O
-- resultado é idêntico (todo id não nulo em `v_results` está na lista; id nulo
-- não casava antes nem casa agora) e a view passa a calcular só essas linhas.
--
-- Por que patch por âncora e não `create or replace` do corpo: o engine é
-- derivado a cada release — as migrations de 04/08 e 20/08 recriam
-- `public.log_teacher_classes` com o corpo completo e a de 12/09 o converte em
-- `private.log_teacher_classes_engine`. Esta migration roda depois dela e
-- reaplica o patch sobre o que acabou de ser derivado. Re-executável.
--
-- O engine de aula antecipada já junta por uuid (`pay.id = log.id`) e não
-- precisa do patch.
-- ─────────────────────────────────────────────────────────────────────────────

do $lancamento_sem_folha_inteira$
declare
  d text;
  anchor text := $anchor$      left join public.v_payable_class_logs pay on pay.id::text = (r ->> 'id');$anchor$;
  replacement text := $replacement$      -- Só as aulas desta resposta: o filtro por uuid chega ao índice de
      -- class_logs e a view calcula o valor de poucas linhas, não da base inteira.
      left join public.v_payable_class_logs pay
        on pay.id::text = (r ->> 'id')
       and pay.id = any(array(
             select (x ->> 'id')::uuid
               from pg_catalog.jsonb_array_elements(v_results) x
              where x ->> 'id' is not null));$replacement$;
begin
  select pg_get_functiondef('private.log_teacher_classes_engine(jsonb)'::regprocedure) into d;
  if strpos(d, 'Só as aulas desta resposta') = 0 then
    if strpos(d, anchor) = 0 then
      raise exception 'engine de lançamento inesperado: âncora do JOIN com v_payable_class_logs não encontrada';
    end if;
    execute replace(d, anchor, replacement);
  end if;
end;
$lancamento_sem_folha_inteira$;

revoke all on function private.log_teacher_classes_engine(jsonb) from public, anon, authenticated, service_role;
