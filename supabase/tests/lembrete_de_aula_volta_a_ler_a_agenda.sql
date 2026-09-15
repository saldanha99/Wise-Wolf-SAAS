-- A service_role precisa conseguir ler `upcoming_classes`.
--
-- É dela que `prepare-daily-reminders` monta o lembrete de 30 min antes da aula.
-- Em 12/09/2026 a view passou a chamar uma função que a service_role não podia
-- executar, e o lembrete ficou quatro dias sem sair — sem erro em tela nenhuma,
-- só no log das edge functions. Se uma função nova entrar na view sem EXECUTE
-- para a service_role, este teste derruba o deploy.

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

grant execute on function pg_temp.assert_true(boolean, text) to public;

select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.parse_lesson_date(text)', 'EXECUTE'),
  'service_role sem EXECUTE em parse_lesson_date (upcoming_classes falha)'
);

-- Lê a view inteira como a edge function lê: qualquer função sem permissão
-- dentro dela falha aqui, não só a de hoje.
set local role service_role;
select pg_temp.assert_true(
  (select count(*) >= 0 from public.upcoming_classes),
  'service_role não consegue ler upcoming_classes'
);
reset role;

rollback;
