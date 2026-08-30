-- O caixa responde UM número, e a data do lançamento é a do pagamento.
--
-- O que importa provar aqui:
--
-- [1] `paid_at` não pode voltar a depender de quem escreve o pagamento. Ele
--     ficou NULL em 186 de 186 pagamentos pagos porque o webhook gravava só
--     `payment_date` — e o trigger do caixa caía em `now()`.
-- [2] O lançamento tem de cair no mês em que o aluno PAGOU, não no mês em que
--     o webhook chegou. Batia por sorte (mesmo dia em 152 de 166 casos) e já
--     tinha errado o mês 5 vezes.
-- [3] `amount` tem de ser derivado de `amount_cents`. O `reconcile-ledger`
--     inseria só os centavos e morria em NOT NULL — era o único caminho de
--     conserto dos 27 pagamentos sem lançamento (R$ 9.390,00), e estava morto.
-- [4] Nenhuma função SECURITY DEFINER com a guarda `role NOT IN (...)` pode
--     ficar acessível ao anon: `NULL NOT IN (...)` é NULL, `IF NULL THEN` não
--     executa, e quem não tem perfil ATRAVESSA a guarda.
-- [5] As duas RPCs que marcam dinheiro como pago têm de conhecer tenant.
--
-- Se alguém reverter qualquer um desses pontos, este teste derruba o deploy.

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

insert into public.tenants (id, name)
values ('caixa-test-school', 'Caixa Test School');

-- ---------------------------------------------------------------------------
-- [1] e [2] — pagamento de MARÇO lançado hoje cai em MARÇO
-- ---------------------------------------------------------------------------
insert into public.student_payments
  (asaas_payment_id, tenant_id, value, status, due_date, payment_date)
values
  ('pay_teste_conciliacao_1', 'caixa-test-school', 100.00, 'RECEIVED',
   date '2026-03-10', date '2026-03-15');

select pg_temp.assert_true(
  (select paid_at is not null
     from public.student_payments
    where asaas_payment_id = 'pay_teste_conciliacao_1'),
  'paid_at nao foi preenchido: o caixa volta a datar pelo dia em que o webhook chegou'
);

select pg_temp.assert_true(
  (select date_trunc('month', ft.occurred_at) = timestamptz '2026-03-01 00:00:00+00'
     from public.financial_transactions ft
     join public.student_payments sp on sp.id = ft.student_payment_id
    where sp.asaas_payment_id = 'pay_teste_conciliacao_1'),
  'lancamento do caixa nao caiu no mes do pagamento'
);

-- Meio-dia, não meia-noite: com o banco em UTC e a escola pensando em BRT,
-- meia-noite UTC é 21:00 do dia anterior em Brasília e um pagamento do dia 1º
-- trocaria de mês em qualquer leitura com fuso local.
select pg_temp.assert_true(
  (select paid_at = timestamptz '2026-03-15 12:00:00+00'
     from public.student_payments
    where asaas_payment_id = 'pay_teste_conciliacao_1'),
  'paid_at nao ficou ao meio-dia: pagamento do dia 1o pode trocar de mes entre UTC e BRT'
);

-- Pagamento sem `payment_date` cai no vencimento — a mesma cadeia de
-- competência de get_cashflow (`coalesce(paid_at, payment_date, due_date)`).
-- Existem 5 pagamentos assim na base.
insert into public.student_payments
  (asaas_payment_id, tenant_id, value, status, due_date)
values
  ('pay_teste_conciliacao_2', 'caixa-test-school', 50.00, 'RECEIVED', date '2026-01-20');

select pg_temp.assert_true(
  (select date_trunc('month', ft.occurred_at) = timestamptz '2026-01-01 00:00:00+00'
     from public.financial_transactions ft
     join public.student_payments sp on sp.id = ft.student_payment_id
    where sp.asaas_payment_id = 'pay_teste_conciliacao_2'),
  'pagamento sem payment_date nao caiu no mes do vencimento'
);

-- CONFIRMED não é caixa: o painel nunca o contou, e o ledger contava.
insert into public.student_payments
  (asaas_payment_id, tenant_id, value, status, due_date, payment_date)
values
  ('pay_teste_conciliacao_3', 'caixa-test-school', 77.00, 'CONFIRMED',
   date '2026-04-10', date '2026-04-10');

select pg_temp.assert_true(
  not exists (
    select 1
      from public.financial_transactions ft
      join public.student_payments sp on sp.id = ft.student_payment_id
     where sp.asaas_payment_id = 'pay_teste_conciliacao_3'),
  'CONFIRMED voltou a lancar no caixa e a divergir de get_cashflow'
);

-- ...e passa a lançar quando liquida.
update public.student_payments
   set status = 'RECEIVED'
 where asaas_payment_id = 'pay_teste_conciliacao_3';

select pg_temp.assert_true(
  exists (
    select 1
      from public.financial_transactions ft
      join public.student_payments sp on sp.id = ft.student_payment_id
     where sp.asaas_payment_id = 'pay_teste_conciliacao_3'),
  'pagamento que saiu de CONFIRMED para RECEIVED nao gerou lancamento'
);

-- Pagamento sem tenant não vira receita de ninguém em silêncio.
insert into public.student_payments
  (asaas_payment_id, tenant_id, value, status, due_date, payment_date)
values
  ('pay_teste_conciliacao_4', null, 33.00, 'RECEIVED',
   date '2026-05-10', date '2026-05-10');

select pg_temp.assert_true(
  not exists (
    select 1
      from public.financial_transactions ft
      join public.student_payments sp on sp.id = ft.student_payment_id
     where sp.asaas_payment_id = 'pay_teste_conciliacao_4'),
  'pagamento sem tenant gerou lancamento de caixa'
);

-- ---------------------------------------------------------------------------
-- [2b] — estorno preserva a entrada bruta e cria a saída na data do evento
-- ---------------------------------------------------------------------------
-- Latente até 25/08/2026 (nenhum estorno na história da base). O pagamento saía
-- de RECEIVED e sumia do get_cashflow, mas a ENTRADA continuava em
-- financial_transactions — que é o que o Dashboard soma. A correção contábil
-- não apaga história: mantém a ENTRADA e grava uma SAÍDA idempotente, de modo
-- que o líquido seja zero e os dois meses permaneçam auditáveis.
insert into public.student_payments
  (asaas_payment_id, tenant_id, value, status, due_date, payment_date)
values
  ('pay_teste_conciliacao_5', 'caixa-test-school', 250.00, 'RECEIVED',
   date '2026-06-10', date '2026-06-10');

select pg_temp.assert_true(
  exists (select 1 from public.financial_transactions ft
           join public.student_payments sp on sp.id = ft.student_payment_id
          where sp.asaas_payment_id = 'pay_teste_conciliacao_5'),
  'pagamento recebido nao gerou lancamento (pre-condicao do teste de estorno)'
);

update public.student_payments
   set status = 'REFUNDED',
       refunded_amount = 250.00,
       last_provider_event_id = 'evt_teste_conciliacao_5_refund',
       last_provider_event_at = timestamptz '2026-07-03 09:30:00+00'
 where asaas_payment_id = 'pay_teste_conciliacao_5';

select pg_temp.assert_true(
  (
    select count(*) = 2
       and count(*) filter (
             where ft.type = 'ENTRADA'
               and ft.amount = 250.00
               and date_trunc('month', ft.occurred_at) =
                     timestamptz '2026-06-01 00:00:00+00'
           ) = 1
       and count(*) filter (
             where ft.type = 'SAIDA'
               and ft.amount = 250.00
               and ft.provider_event_id = 'evt_teste_conciliacao_5_refund'
               and ft.occurred_at = timestamptz '2026-07-03 09:30:00+00'
           ) = 1
       and sum(case when ft.type = 'ENTRADA' then ft.amount else -ft.amount end) = 0
      from public.financial_transactions ft
      join public.student_payments sp
        on sp.id in (ft.student_payment_id, ft.refund_student_payment_id)
     where sp.asaas_payment_id = 'pay_teste_conciliacao_5'
  ),
  'estorno nao preservou a entrada bruta com uma saida exata e auditavel'
);

select pg_temp.assert_true(
  exists (select 1 from public.reconciliation_issues ri
           join public.student_payments sp on sp.id = ri.student_payment_id
          where sp.asaas_payment_id = 'pay_teste_conciliacao_5'
            and ri.kind = 'PAYMENT_FULLY_REFUNDED'
            and (ri.details->>'delta_estornado')::numeric = 250.00
            and ri.details->>'provider_event_id' =
                  'evt_teste_conciliacao_5_refund'),
  'estorno nao deixou rastro em reconciliation_issues'
);

-- Um evento RECEIVED tardio não pode apagar um estorno já comprovado nem criar
-- outra ENTRADA. O par bruto/estorno continua único e com líquido zero.
update public.student_payments
   set status = 'RECEIVED'
 where asaas_payment_id = 'pay_teste_conciliacao_5';

select pg_temp.assert_true(
  (
    select count(*) = 2
       and count(*) filter (where ft.type = 'ENTRADA') = 1
       and count(*) filter (where ft.type = 'SAIDA') = 1
       and sum(case when ft.type = 'ENTRADA' then ft.amount else -ft.amount end) = 0
      from public.financial_transactions ft
      join public.student_payments sp
        on sp.id in (ft.student_payment_id, ft.refund_student_payment_id)
     where sp.asaas_payment_id = 'pay_teste_conciliacao_5'
  ),
  'evento pago tardio duplicou a entrada ou apagou o estorno comprovado'
);

-- ---------------------------------------------------------------------------
-- [3] — `amount` derivado de `amount_cents` (o insert do reconcile-ledger)
-- ---------------------------------------------------------------------------
insert into public.financial_transactions
  (tenant_id, type, category, amount_cents, description, occurred_at)
values
  ('caixa-test-school', 'ENTRADA', 'MENSALIDADE', 12345,
   'teste conciliacao sem amount', now());

select pg_temp.assert_true(
  (select amount = 123.45
     from public.financial_transactions
    where description = 'teste conciliacao sem amount'),
  'amount nao foi derivado de amount_cents: o reconcile-ledger volta a morrer em NOT NULL'
);

insert into public.financial_transactions
  (tenant_id, type, category, amount, description, occurred_at)
values
  ('caixa-test-school', 'SAIDA', 'teste', 10.50,
   'teste conciliacao sem cents', now());

select pg_temp.assert_true(
  (select amount_cents = 1050
     from public.financial_transactions
    where description = 'teste conciliacao sem cents'),
  'amount_cents nao foi derivado de amount: soma por reais e por centavos volta a divergir'
);

select pg_temp.assert_true(
  (select attnotnull
     from pg_attribute
    where attrelid = 'public.financial_transactions'::regclass
      and attname = 'amount_cents'),
  'amount_cents deixou de ser NOT NULL'
);

-- ---------------------------------------------------------------------------
-- [4] — a guarda que não dispara com papel NULL não pode estar aberta ao anon
-- ---------------------------------------------------------------------------
-- Guarda estrutural, não de comportamento: uma função nova escrita nesse molde
-- e concedida ao anon derruba o deploy aqui, antes de chegar em produção.
select pg_temp.assert_true(
  not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and (p.proacl::text like '%anon=X%' or p.proacl is null)
       and pg_get_functiondef(p.oid) ~ 'NOT IN\s*\(\s*''(SCHOOL_ADMIN|SUPER_ADMIN)'
  ),
  'funcao SECURITY DEFINER com guarda que nao dispara em papel NULL voltou a ficar acessivel ao anon'
);

-- ---------------------------------------------------------------------------
-- [5] — as duas RPCs de dinheiro conhecem tenant e papel nulo
-- ---------------------------------------------------------------------------
select pg_temp.assert_true(
  (select pg_get_functiondef(oid) ~ 'coalesce\(v_role'
     from pg_proc where proname = 'set_vendor_commission_status'),
  'set_vendor_commission_status voltou a usar guarda que nao dispara com papel NULL'
);

select pg_temp.assert_true(
  (select pg_get_functiondef(oid) ~ 'tenant_id = v_tenant'
     from pg_proc where proname = 'set_vendor_commission_status'),
  'set_vendor_commission_status voltou a marcar comissao como paga sem checar tenant'
);

select pg_temp.assert_true(
  (select pg_get_functiondef(oid) ~ 'coalesce\(v_role'
     from pg_proc where proname = 'set_referral_reward_status'),
  'set_referral_reward_status voltou a usar guarda que nao dispara com papel NULL'
);

select pg_temp.assert_true(
  (select pg_get_functiondef(oid) ~ 'tenant_id = v_tenant'
     from pg_proc where proname = 'set_referral_reward_status'),
  'set_referral_reward_status voltou a marcar indicacao como paga sem checar tenant'
);

rollback;
