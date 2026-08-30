\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

insert into public.tenants (id, name)
values ('gestao-contas-test', 'Gestao Contas Test');

-- Sem service_role, a RPC nao pode escrever dinheiro.
set local request.jwt.claims = '{"role":"authenticated"}';
select pg_temp.assert_true(
  (public.gestao_lanca_conta(
    'gestao-contas-test','wa-request-denied',false,'Conta negada',10,'6.3.01',
    current_date,null,'Teste'
  )->>'error') = 'somente_pelo_assistente',
  'caller sem service_role conseguiu lancar conta'
);

set local request.jwt.claims = '{"role":"service_role"}';

-- Conta avulsa: grava saida classificada e retry nao duplica.
select pg_temp.assert_true(
  (public.gestao_lanca_conta(
    'gestao-contas-test','wa-request-once-001',false,'Taxa bancaria',25.90,
    '6.3.02',current_date,null,'Direcao'
  )->>'ok')::boolean,
  'conta avulsa nao foi criada'
);
select public.gestao_lanca_conta(
  'gestao-contas-test','wa-request-once-001',false,'Taxa bancaria',25.90,
  '6.3.02',current_date,null,'Direcao'
);
select pg_temp.assert_true(
  (select count(*) = 1 from financial_transactions
    where tenant_id='gestao-contas-test' and description='Taxa bancaria'
      and type='SAIDA' and account_code='6.3.02' and amount=25.90),
  'retry duplicou ou classificou errado a conta avulsa'
);

-- Recorrente: cria molde e materializa o mes vigente uma unica vez.
select pg_temp.assert_true(
  (public.gestao_lanca_conta(
    'gestao-contas-test','wa-request-rec-001',true,'Plano da operadora',50,
    '6.2.02',make_date(extract(year from current_date)::int,
                       extract(month from current_date)::int,17),
    to_char(current_date,'YYYY-MM'),'Direcao'
  )->>'ok')::boolean,
  'conta recorrente nao foi criada'
);
select public.gestao_lanca_conta(
  'gestao-contas-test','wa-request-rec-001',true,'Plano da operadora',50,
  '6.2.02',make_date(extract(year from current_date)::int,
                     extract(month from current_date)::int,17),
  to_char(current_date,'YYYY-MM'),'Direcao'
);
select pg_temp.assert_true(
  (select count(*) = 1 from recurring_expenses
    where tenant_id='gestao-contas-test' and label='Plano da operadora'
      and day_of_month=17 and amount=50),
  'retry duplicou o molde recorrente'
);
select pg_temp.assert_true(
  (select count(*) = 1 from financial_transactions
    where tenant_id='gestao-contas-test' and description='Plano da operadora'
      and recurring_expense_id is not null and recurring_month=to_char(current_date,'YYYY-MM')),
  'conta recorrente vigente nao foi materializada exatamente uma vez'
);

-- Conta automatica (repasse) e valor acima do teto sao recusados.
select pg_temp.assert_true(
  (public.gestao_lanca_conta(
    'gestao-contas-test','wa-request-auto-001',false,'Repasse indevido',100,
    '5.1.01',current_date,null,'Direcao'
  )->>'error') = 'conta_de_fonte_automatica',
  'conta de fonte automatica aceitou lancamento manual'
);
select pg_temp.assert_true(
  (public.gestao_lanca_conta(
    'gestao-contas-test','wa-request-high-001',false,'Valor alto',10000.01,
    '6.9.99',current_date,null,'Direcao'
  )->>'error') = 'acima_do_teto',
  'valor acima do teto foi aceito'
);

rollback;
