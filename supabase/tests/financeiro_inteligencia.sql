-- Inteligência financeira (migrations 20261122200000/201000/202000):
-- fronteiras de acesso das RPCs finance_* e da tabela finance_settings.
-- Só leitura de catálogo + chamadas que DEVEM falhar; não grava nada.

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
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;

-- anon não executa nada; authenticated executa (a checagem é dentro da função).
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.finance_unit_economics(text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.finance_pricing_overview(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.finance_cashflow_projection(integer,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.finance_dre_completo(text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.finance_settings_save(jsonb,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.finance_settings_get(text)', 'EXECUTE'),
  'finance RPC callable by anon'
);

select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'private.finance_student_economics(text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.finance_settings_effective(text)', 'EXECUTE'),
  'private finance core callable by authenticated'
);

select pg_temp.assert_true(
  not has_table_privilege('anon', 'public.finance_settings', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated', 'public.finance_settings', 'SELECT,INSERT,UPDATE,DELETE'),
  'finance_settings reachable directly by client roles'
);

select pg_temp.assert_true(
  (select relrowsecurity from pg_class where oid = 'public.finance_settings'::regclass),
  'finance_settings without RLS'
);

-- Usuário inexistente (sem tenant) pedindo a Wise Wolf: tem de ser recusado.
savepoint outsider;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000000","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.finance_unit_economics(null, 'school-wise-wolf');
    raise exception 'assertion failed: outsider read finance_unit_economics';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.finance_settings_save('{"tax_mode":"UNSET"}'::jsonb, 'school-wise-wolf');
    raise exception 'assertion failed: outsider wrote finance_settings';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback to savepoint outsider;

rollback;
