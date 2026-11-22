-- Teto mensal da Anthropic (migration 20261122260000): contador por provedor e mês UTC.
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;

-- Só o servidor (service_role) lê e soma; o app nunca.
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.ai_provider_spend_add(text, numeric)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.ai_provider_spend_add(text, numeric)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.ai_provider_spend_month(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.ai_provider_spend_add(text, numeric)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.ai_provider_spend_month(text)', 'EXECUTE'),
  'spend counter grants');

-- Soma no mês UTC corrente, por provedor, sem misturar.
-- Um passo por comando: o Postgres não garante a ordem das condições de um mesmo select.
select pg_temp.assert_true(public.ai_provider_spend_add('zz-teste', 0.25) = 0.25, 'first add');
select pg_temp.assert_true(public.ai_provider_spend_add('zz-teste', 0.50) = 0.75, 'second add');
select pg_temp.assert_true(public.ai_provider_spend_month('zz-teste') = 0.75, 'monthly sum');
select pg_temp.assert_true(public.ai_provider_spend_month('zz-outro') = 0, 'providers do not mix');
select pg_temp.assert_true(
  (select calls from private.ai_provider_monthly_spend where provider = 'zz-teste') = 2,
  'call count');

-- Valor absurdo ou provedor inválido é recusado.
do $$
begin
  begin
    perform public.ai_provider_spend_add('zz-teste', 101);
    raise exception 'assertion failed: accepted 101 USD';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.ai_provider_spend_add('Bad Provider!', 0.01);
    raise exception 'assertion failed: accepted invalid provider';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
rollback;
