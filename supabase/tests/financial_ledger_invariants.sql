-- Regressao dos invariantes financeiros introduzidos em
-- 20260825150734_enforce_financial_ledger_invariants.sql.

begin;

set local timezone = 'UTC';

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
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

insert into public.tenants (id, name)
values ('financial-ledger-test', 'Financial Ledger Test');

set local app.enrollment_claim = '1';

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-4000-8000-00000000f101',
    'authenticated', 'authenticated', 'financial-ledger-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Financial Ledger Admin"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000f102',
    'authenticated', 'authenticated', 'financial-ledger-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Financial Ledger Student"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000f103',
    'authenticated', 'authenticated', 'financial-ledger-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Financial Ledger Teacher"}', now(), now()
  );

update public.profiles
   set tenant_id = 'financial-ledger-test',
       role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active',
       full_name = 'Financial Ledger Admin'
 where id = '00000000-0000-4000-8000-00000000f101';

update public.profiles
   set tenant_id = 'financial-ledger-test',
       role = 'STUDENT',
       lifecycle_status = 'active',
       status = 'ACTIVE',
       monthly_fee = 20.00,
       full_name = 'Financial Ledger Student'
 where id = '00000000-0000-4000-8000-00000000f102';

update public.profiles
   set tenant_id = 'financial-ledger-test',
       role = 'TEACHER',
       lifecycle_status = 'active',
       full_name = 'Financial Ledger Teacher'
 where id = '00000000-0000-4000-8000-00000000f103';

-- Uma aula antiga define a competencia do fechamento; outra recente faz a
-- reconciliacao considerar o aluno ativo. Nao ha aula em maio, de modo que o
-- balancete de receita sem aula tambem consegue provar o valor liquido.
insert into public.class_logs (
  id, tenant_id, teacher_id, student_id, presence, date, class_date
) values
  (
    '00000000-0000-4000-8000-00000000f111',
    'financial-ledger-test',
    '00000000-0000-4000-8000-00000000f103',
    '00000000-0000-4000-8000-00000000f102',
    'COMPLETED', date '2026-01-05', date '2026-01-05'
  ),
  (
    '00000000-0000-4000-8000-00000000f112',
    'financial-ledger-test',
    '00000000-0000-4000-8000-00000000f103',
    '00000000-0000-4000-8000-00000000f102',
    'COMPLETED', current_date - 10, current_date - 10
  );

insert into public.teacher_closings (
  id, tenant_id, teacher_id, month_year,
  total_lessons, total_amount, status, paid_at
) values (
  '00000000-0000-4000-8000-00000000f113',
  'financial-ledger-test',
  '00000000-0000-4000-8000-00000000f103',
  '2026-01', 1, 8.00, 'PAGO', timestamptz '2026-02-01 12:00:00+00'
);

-- -------------------------------------------------------------------------
-- [1] creditDate e a data do caixa, mesmo quando cruza o mes de paymentDate
-- -------------------------------------------------------------------------

insert into public.student_payments (
  asaas_payment_id,
  tenant_id,
  value,
  status,
  due_date,
  payment_date,
  credited_at
) values (
  'pay_financial_invariant_credit_date',
  'financial-ledger-test',
  100.00,
  'RECEIVED',
  date '2026-01-31',
  date '2026-01-31',
  timestamptz '2026-02-01 12:00:00+00'
);

select pg_temp.assert_true(
  (
    select sp.paid_at = timestamptz '2026-02-01 12:00:00+00'
       and ft.occurred_at = timestamptz '2026-02-01 12:00:00+00'
      from public.student_payments sp
      join public.financial_transactions ft on ft.student_payment_id = sp.id
     where sp.asaas_payment_id = 'pay_financial_invariant_credit_date'
  ),
  'credited_at nao prevaleceu sobre payment_date no caixa'
);

select pg_temp.assert_true(
  (
    select sp.amount_cents = 10000
      from public.student_payments sp
     where sp.asaas_payment_id = 'pay_financial_invariant_credit_date'
  ),
  'amount_cents do pagamento nao foi derivado de value'
);

-- -------------------------------------------------------------------------
-- [2] CONFIRMED nunca e caixa; RECEIVED cria uma unica linha ao liquidar
-- -------------------------------------------------------------------------

insert into public.student_payments (
  asaas_payment_id,
  tenant_id,
  value,
  status,
  due_date,
  payment_date,
  paid_at
) values (
  'pay_financial_invariant_confirmed',
  'financial-ledger-test',
  220.00,
  'CONFIRMED',
  date '2026-03-10',
  date '2026-03-10',
  timestamptz '2026-03-10 12:00:00+00'
);

select pg_temp.assert_true(
  (
    select sp.paid_at is null
       and not exists (
         select 1
           from public.financial_transactions ft
          where ft.student_payment_id = sp.id
       )
      from public.student_payments sp
     where sp.asaas_payment_id = 'pay_financial_invariant_confirmed'
  ),
  'CONFIRMED ganhou paid_at ou lancamento de caixa'
);

update public.student_payments
   set status = 'RECEIVED',
       credited_at = timestamptz '2026-04-02 12:00:00+00'
 where asaas_payment_id = 'pay_financial_invariant_confirmed';

select pg_temp.assert_true(
  (
    select count(*) = 1
       and min(ft.occurred_at) = timestamptz '2026-04-02 12:00:00+00'
      from public.financial_transactions ft
      join public.student_payments sp on sp.id = ft.student_payment_id
     where sp.asaas_payment_id = 'pay_financial_invariant_confirmed'
  ),
  'CONFIRMED -> RECEIVED nao criou exatamente um lancamento na data de credito'
);

insert into public.student_payments (
  asaas_payment_id, tenant_id, value, status, due_date, payment_date
) values (
  'pay_financial_invariant_confirmed_refunded_before_credit',
  'financial-ledger-test',
  25.00,
  'CONFIRMED',
  date '2026-03-20',
  date '2026-03-20'
);

update public.student_payments
   set status = 'REFUNDED',
       refunded_amount = 25.00,
       last_provider_event_id = 'evt_financial_refund_before_credit',
       last_provider_event_at = timestamptz '2026-03-21 10:00:00+00'
 where asaas_payment_id = 'pay_financial_invariant_confirmed_refunded_before_credit';

select pg_temp.assert_true(
  (
    select not coalesce(sp.ledger_entry_created, false)
       and not exists (
         select 1
           from public.financial_transactions ft
          where ft.student_payment_id = sp.id
             or ft.refund_student_payment_id = sp.id
       )
       and exists (
         select 1
           from public.reconciliation_issues ri
          where ri.student_payment_id = sp.id
            and ri.kind = 'REFUND_WITHOUT_RECEIPT_LEDGER'
       )
      from public.student_payments sp
     where sp.asaas_payment_id =
       'pay_financial_invariant_confirmed_refunded_before_credit'
  ),
  'CONFIRMED -> REFUNDED antes do credito criou caixa negativo'
);

-- -------------------------------------------------------------------------
-- [3] NAO_RECEITA preserva a linha e apenas recategoriza o dinheiro
-- -------------------------------------------------------------------------

create temporary table ledger_test_ids (
  name text primary key,
  id uuid not null
) on commit drop;

insert into ledger_test_ids (name, id)
select 'not_revenue', ft.id
  from public.financial_transactions ft
  join public.student_payments sp on sp.id = ft.student_payment_id
 where sp.asaas_payment_id = 'pay_financial_invariant_credit_date';

update public.student_payments
   set status = 'NAO_RECEITA'
 where asaas_payment_id = 'pay_financial_invariant_credit_date';

select pg_temp.assert_true(
  (
    select count(*) = 1
       and bool_and(ft.id = (select id from ledger_test_ids where name = 'not_revenue'))
       and bool_and(ft.category = 'aporte_ou_movimentacao')
      from public.financial_transactions ft
      join public.student_payments sp on sp.id = ft.student_payment_id
     where sp.asaas_payment_id = 'pay_financial_invariant_credit_date'
  ),
  'RECEIVED -> NAO_RECEITA apagou/duplicou o caixa ou nao recategorizou'
);

update public.student_payments
   set status = 'RECEIVED'
 where asaas_payment_id = 'pay_financial_invariant_credit_date';

select pg_temp.assert_true(
  (
    select count(*) = 1
       and bool_and(ft.id = (select id from ledger_test_ids where name = 'not_revenue'))
       and bool_and(ft.category = 'MENSALIDADE')
      from public.financial_transactions ft
      join public.student_payments sp on sp.id = ft.student_payment_id
     where sp.asaas_payment_id = 'pay_financial_invariant_credit_date'
  ),
  'NAO_RECEITA -> RECEIVED nao restaurou a mesma linha canonica'
);

-- -------------------------------------------------------------------------
-- [4] Estornos sao SAIDAS idempotentes na data real; a ENTRADA fica bruta
-- -------------------------------------------------------------------------

-- Prova explicita do corte mensal: credito em janeiro, devolucao em fevereiro.
insert into public.student_payments (
  asaas_payment_id, tenant_id, value, status, due_date, payment_date, credited_at
) values (
  'pay_financial_invariant_cross_month_refund',
  'financial-ledger-test',
  30.00,
  'RECEIVED',
  date '2026-01-20',
  date '2026-01-20',
  timestamptz '2026-01-20 12:00:00+00'
);

update public.student_payments
   set refunded_amount = 10.00,
       last_provider_event_id = 'evt_financial_refund_cross_month',
       last_provider_event_at = timestamptz '2026-02-03 09:30:00+00'
 where asaas_payment_id = 'pay_financial_invariant_cross_month_refund';

select pg_temp.assert_true(
  (
    select count(*) = 2
       and sum(ft.amount) filter (where ft.type = 'ENTRADA') = 30.00
       and min(ft.occurred_at) filter (where ft.type = 'ENTRADA') =
             timestamptz '2026-01-20 12:00:00+00'
       and sum(ft.amount) filter (where ft.type = 'SAIDA') = 10.00
       and min(ft.occurred_at) filter (where ft.type = 'SAIDA') =
             timestamptz '2026-02-03 09:30:00+00'
      from public.student_payments sp
      join public.financial_transactions ft
        on ft.student_payment_id = sp.id
        or ft.refund_student_payment_id = sp.id
     where sp.asaas_payment_id = 'pay_financial_invariant_cross_month_refund'
  ),
  'recebimento de janeiro/estorno de fevereiro nao gerou +jan e -fev'
);

insert into public.student_payments (
  asaas_payment_id,
  tenant_id,
  student_id,
  value,
  status,
  due_date,
  payment_date,
  credited_at
) values (
  'pay_financial_invariant_partial_refund',
  'financial-ledger-test',
  '00000000-0000-4000-8000-00000000f102',
  100.00,
  'RECEIVED',
  date '2026-01-05',
  date '2026-05-05',
  timestamptz '2026-05-06 12:00:00+00'
);

update public.student_payments
   set refunded_amount = 35.25,
       last_provider_event_id = 'evt_financial_refund_partial',
       last_provider_event_at = timestamptz '2026-06-03 14:15:00+00'
 where asaas_payment_id = 'pay_financial_invariant_partial_refund';

select pg_temp.assert_true(
  (
    select sp.value = 100.00
       and sp.refunded_amount = 35.25
       and ft.amount = 100.00
       and ft.amount_cents = 10000
       and ft.occurred_at = sp.credited_at
      from public.student_payments sp
      join public.financial_transactions ft on ft.student_payment_id = sp.id
     where sp.asaas_payment_id = 'pay_financial_invariant_partial_refund'
  ),
  'estorno parcial alterou ou apagou a ENTRADA bruta'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
       and min(ft.type) = 'SAIDA'
       and min(ft.category) = 'ESTORNO_MENSALIDADE'
       and min(ft.amount) = 35.25
       and min(ft.amount_cents) = 3525
       and min(ft.provider_event_id) = 'evt_financial_refund_partial'
       and min(ft.occurred_at) = timestamptz '2026-06-03 14:15:00+00'
      from public.student_payments sp
      join public.financial_transactions ft on ft.refund_student_payment_id = sp.id
     where sp.asaas_payment_id = 'pay_financial_invariant_partial_refund'
  ),
  'estorno parcial nao criou uma unica SAIDA pelo ID/data reais do evento'
);

-- Retry do mesmo snapshot/evento nao pode duplicar a SAIDA.
update public.student_payments
   set refunded_amount = 35.25,
       last_provider_event_id = 'evt_financial_refund_partial',
       last_provider_event_at = timestamptz '2026-06-03 14:15:00+00',
       updated_at = now()
 where asaas_payment_id = 'pay_financial_invariant_partial_refund';

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.student_payments sp
      join public.financial_transactions ft on ft.refund_student_payment_id = sp.id
     where sp.asaas_payment_id = 'pay_financial_invariant_partial_refund'
       and ft.provider_event_id = 'evt_financial_refund_partial'
  ),
  'retry do mesmo evento duplicou a SAIDA de estorno'
);

select pg_temp.assert_true(
  exists (
    select 1
      from public.reconciliation_issues ri
      join public.student_payments sp on sp.id = ri.student_payment_id
     where sp.asaas_payment_id = 'pay_financial_invariant_partial_refund'
       and ri.kind = 'PAYMENT_PARTIALLY_REFUNDED'
       and (ri.details ->> 'delta_estornado')::numeric = 35.25
       and ri.details ->> 'provider_event_id' = 'evt_financial_refund_partial'
  ),
  'estorno parcial nao deixou rastro de conciliacao'
);

select pg_temp.assert_true(
  exists (
    select 1
      from public.reconciliation_issues ri
      join public.student_payments sp on sp.id = ri.student_payment_id
     where sp.asaas_payment_id = 'pay_financial_invariant_partial_refund'
       and ri.kind = 'REFUND_REQUIRES_TEACHER_PAYOUT_REVIEW'
       and ri.details -> 'fechamentos_pagos'
             @> '["00000000-0000-4000-8000-00000000f113"]'::jsonb
       and (ri.details ->> 'acao_automatica')::boolean = false
  ),
  'estorno de competencia ja paga nao abriu revisao explicita do repasse'
);

select pg_temp.assert_true(
  (
    select tc.status = 'PAGO'
       and tc.total_amount = 8.00
      from public.teacher_closings tc
     where tc.id = '00000000-0000-4000-8000-00000000f113'
  ),
  'estorno alterou/debitou fechamento pago sem regra de negocio'
);

do $refund_guard$
declare
  v_blocked boolean := false;
begin
  begin
    update public.student_payments
       set refunded_amount = 100.01
     where asaas_payment_id = 'pay_financial_invariant_partial_refund';
  exception
    when check_violation then
      v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'assertion failed: refunded_amount maior que value foi aceito';
  end if;
end
$refund_guard$;

insert into public.student_payments (
  asaas_payment_id,
  tenant_id,
  value,
  status,
  due_date,
  payment_date,
  credited_at
) values (
  'pay_financial_invariant_full_refund',
  'financial-ledger-test',
  55.00,
  'RECEIVED',
  date '2026-05-10',
  date '2026-05-10',
  timestamptz '2026-05-11 12:00:00+00'
);

update public.student_payments
   set status = 'REFUNDED',
       refunded_amount = 55.00,
       last_provider_event_id = 'evt_financial_refund_full',
       last_provider_event_at = timestamptz '2026-06-06 18:45:00+00'
 where asaas_payment_id = 'pay_financial_invariant_full_refund';

select pg_temp.assert_true(
  (
    select coalesce(sp.ledger_entry_created, false)
       and receipt.amount = 55.00
       and receipt.occurred_at = sp.credited_at
       and refund.amount = 55.00
       and refund.provider_event_id = 'evt_financial_refund_full'
       and refund.occurred_at = timestamptz '2026-06-06 18:45:00+00'
      from public.student_payments sp
      join public.financial_transactions receipt on receipt.student_payment_id = sp.id
      join public.financial_transactions refund on refund.refund_student_payment_id = sp.id
     where sp.asaas_payment_id = 'pay_financial_invariant_full_refund'
  ),
  'estorno integral apagou a entrada bruta ou nao criou a SAIDA integral'
);

select pg_temp.assert_true(
  exists (
    select 1
      from public.reconciliation_issues ri
      join public.student_payments sp on sp.id = ri.student_payment_id
     where sp.asaas_payment_id = 'pay_financial_invariant_full_refund'
       and ri.kind = 'PAYMENT_FULLY_REFUNDED'
       and (ri.details ->> 'delta_estornado')::numeric = 55.00
       and ri.details ->> 'provider_event_id' = 'evt_financial_refund_full'
  ),
  'estorno integral nao deixou rastro de conciliacao'
);

-- Sem um ID/data novos no mesmo UPDATE, nao existe base para inventar a SAIDA.
insert into public.student_payments (
  asaas_payment_id, tenant_id, value, status, due_date, payment_date, credited_at
) values (
  'pay_financial_invariant_refund_without_context',
  'financial-ledger-test',
  20.00,
  'RECEIVED',
  date '2026-09-01',
  date '2026-09-01',
  timestamptz '2026-09-02 12:00:00+00'
);

update public.student_payments
   set refunded_amount = 5.00
 where asaas_payment_id = 'pay_financial_invariant_refund_without_context';

select pg_temp.assert_true(
  (
    select receipt.amount = 20.00
       and not exists (
         select 1
           from public.financial_transactions refund
          where refund.refund_student_payment_id = sp.id
       )
       and exists (
         select 1
           from public.reconciliation_issues ri
          where ri.student_payment_id = sp.id
            and ri.kind = 'REFUND_LEDGER_EVENT_CONTEXT_MISSING'
            and (ri.details ->> 'delta_sem_lancamento')::numeric = 5.00
            and not (ri.details ->> 'data_sintetizada')::boolean
       )
      from public.student_payments sp
      join public.financial_transactions receipt on receipt.student_payment_id = sp.id
     where sp.asaas_payment_id = 'pay_financial_invariant_refund_without_context'
  ),
  'estorno sem ID/data criou data falsa ou nao abriu issue de conciliacao'
);

-- -------------------------------------------------------------------------
-- [5] Caixa, DRE, margens e balancetes fecham no mesmo liquido
-- -------------------------------------------------------------------------

insert into public.student_payments (
  asaas_payment_id, tenant_id, student_id, value, status, due_date
) values (
  'pay_financial_invariant_pending_gross',
  'financial-ledger-test',
  '00000000-0000-4000-8000-00000000f102',
  40.00,
  'PENDING',
  date '2026-05-20'
);

-- Simula o segundo escritor legado. O fechamento continua sendo a fonte do
-- repasse e esta SAIDA paralela nao pode contaminar caixa/DRE.
insert into public.financial_transactions (
  tenant_id, type, category, amount, occurred_at, description
) values (
  'financial-ledger-test', 'SAIDA', 'teacher_payout', 8.00,
  timestamptz '2026-05-15 12:00:00+00',
  'financial_invariant_parallel_teacher_payout'
);

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000f101","role":"authenticated"}';

select pg_temp.assert_true(
  (public.get_cashflow_unchecked('2026-05') ->> 'entradas')::numeric = 155.00
  and (public.get_cashflow_unchecked('2026-05') ->> 'a_receber')::numeric = 40.00
  and (public.get_cashflow_unchecked('2026-05')
    -> 'saidas' ->> 'despesas')::numeric = 0,
  'caixa de maio nao preservou entradas brutas ou duplicou repasse'
);

select pg_temp.assert_true(
  (public.get_cashflow_unchecked('2026-06') ->> 'entradas')::numeric = 0
  and (public.get_cashflow_unchecked('2026-06')
    -> 'saidas' ->> 'despesas')::numeric = 90.25,
  'caixa de junho nao reconheceu os estornos parcial e integral como SAIDAS'
);

select pg_temp.assert_true(
  (public.dre_gerencial('2026-05', 'financial-ledger-test')
     ->> 'receita_bruta')::numeric = 64.75
  and (public.dre_gerencial('2026-05', 'financial-ledger-test')
     ->> 'despesas_operacionais')::numeric = 0,
  'DRE nao reconheceu receita liquida ou duplicou repasse legado'
);

select pg_temp.assert_true(
  (public.director_teacher_margin('2026-05')
     -> 'total' ->> 'receita')::numeric = 64.75,
  'margem da direcao nao reconheceu receita liquida'
);

select pg_temp.assert_true(
  (public.balancete_professores('2026-05', 'financial-ledger-test')
     ->> 'receita_total')::numeric = 64.75
  and (public.balancete_professores('2026-05', 'financial-ledger-test')
     ->> 'receita_aluno_sem_aula')::numeric = 64.75,
  'balancete de professores nao fechou no valor liquido'
);

select pg_temp.assert_true(
  (public.balancete_receita_sem_aula('2026-05', 'financial-ledger-test')
     ->> 'total')::numeric = 64.75,
  'balancete de receita sem aula nao fechou no valor liquido'
);

select pg_temp.assert_true(
  exists (
    select 1
      from jsonb_array_elements(
        public.financial_reconciliation('financial-ledger-test')
          -> 'sem_cobertura' -> 'itens'
      ) item
     where item ->> 'student_id' = '00000000-0000-4000-8000-00000000f102'
       and (item ->> 'total_recebido')::numeric = 64.75
  ),
  'reconciliacao financeira calculou cobertura pelo bruto estornado'
);

-- -------------------------------------------------------------------------
-- [6] Reconciliacao usa NOT EXISTS, pagina e nao confia na flag
-- -------------------------------------------------------------------------

insert into public.student_payments (
  asaas_payment_id, tenant_id, value, status, due_date, payment_date
) values
  (
    'pay_financial_invariant_reconcile_a', 'financial-ledger-test',
    80.00, 'RECEIVED', date '2026-06-01', date '2026-06-01'
  ),
  (
    'pay_financial_invariant_reconcile_b', 'financial-ledger-test',
    90.00, 'RECEIVED', date '2026-06-02', date '2026-06-02'
  );

-- Simula o defeito real: a flag diz true, mas a linha sumiu. O RPC antigo
-- filtrava pela flag e nunca repararia estas duas linhas.
delete from public.financial_transactions ft
using public.student_payments sp
where sp.id = ft.student_payment_id
  and sp.asaas_payment_id in (
    'pay_financial_invariant_reconcile_a',
    'pay_financial_invariant_reconcile_b'
  );

select pg_temp.assert_true(
  (
    select bool_and(sp.ledger_entry_created)
      from public.student_payments sp
     where sp.asaas_payment_id in (
       'pay_financial_invariant_reconcile_a',
       'pay_financial_invariant_reconcile_b'
     )
  ),
  'pre-condicao: exclusao direta alterou a flag e nao simula o drift real'
);

create temporary table reconcile_test_results (
  seq integer primary key,
  result jsonb not null
) on commit drop;

insert into reconcile_test_results (seq, result)
select 1, public.reconcile_student_payment_ledger(1, null);

insert into reconcile_test_results (seq, result)
select 2, public.reconcile_student_payment_ledger(
  1,
  (select (result ->> 'next_after_id')::uuid from reconcile_test_results where seq = 1)
);

select pg_temp.assert_true(
  (
    select (result ->> 'processed')::integer = 1
       and (result ->> 'inserted')::integer = 1
       and (result ->> 'has_more')::boolean
       and result ->> 'next_after_id' is not null
      from reconcile_test_results
     where seq = 1
  ),
  'primeira pagina da reconciliacao nao retornou cursor/has_more corretos'
);

select pg_temp.assert_true(
  (
    select (result ->> 'processed')::integer = 1
       and (result ->> 'inserted')::integer = 1
       and not (result ->> 'has_more')::boolean
      from reconcile_test_results
     where seq = 2
  ),
  'segunda pagina da reconciliacao nao encerrou corretamente'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.financial_transactions ft
      join public.student_payments sp on sp.id = ft.student_payment_id
     where sp.asaas_payment_id in (
       'pay_financial_invariant_reconcile_a',
       'pay_financial_invariant_reconcile_b'
     )
  ),
  'reconciliacao por NOT EXISTS nao restaurou as duas linhas'
);

select pg_temp.assert_true(
  (
    select bool_and(sp.ledger_entry_created)
      from public.student_payments sp
     where sp.asaas_payment_id in (
       'pay_financial_invariant_reconcile_a',
       'pay_financial_invariant_reconcile_b'
     )
  ),
  'reconciliacao nao corrigiu as flags derivadas'
);

insert into reconcile_test_results (seq, result)
select 3, public.reconcile_student_payment_ledger(10, null);

select pg_temp.assert_true(
  (
    select (result ->> 'processed')::integer = 0
       and (result ->> 'inserted')::integer = 0
       and not (result ->> 'has_more')::boolean
      from reconcile_test_results
     where seq = 3
  ),
  'reexecucao da conciliacao deixou de ser idempotente'
);

do $unique_guard$
declare
  v_payment_id uuid;
  v_blocked boolean := false;
begin
  select sp.id into v_payment_id
    from public.student_payments sp
   where sp.asaas_payment_id = 'pay_financial_invariant_reconcile_a';

  begin
    insert into public.financial_transactions (
      tenant_id, type, category, amount, student_payment_id, occurred_at
    ) values (
      'financial-ledger-test', 'ENTRADA', 'MENSALIDADE', 80.00,
      v_payment_id, now()
    );
  exception
    when unique_violation then
      v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'assertion failed: indice unico aceitou segundo ledger do pagamento';
  end if;
end
$unique_guard$;

do $refund_event_unique_guard$
declare
  v_payment_id uuid;
  v_blocked boolean := false;
begin
  select sp.id into v_payment_id
    from public.student_payments sp
   where sp.asaas_payment_id = 'pay_financial_invariant_partial_refund';

  begin
    insert into public.financial_transactions (
      tenant_id,
      type,
      category,
      amount,
      refund_student_payment_id,
      provider_event_id,
      occurred_at
    ) values (
      'financial-ledger-test',
      'SAIDA',
      'ESTORNO_MENSALIDADE',
      35.25,
      v_payment_id,
      'evt_financial_refund_partial',
      timestamptz '2026-06-03 14:15:00+00'
    );
  exception
    when unique_violation then
      v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'assertion failed: indice unico aceitou segundo lancamento do mesmo evento de estorno';
  end if;
end
$refund_event_unique_guard$;

-- -------------------------------------------------------------------------
-- [7] amount e amount_cents ficam equivalentes em INSERT e nos dois UPDATEs
-- -------------------------------------------------------------------------

insert into public.financial_transactions (
  tenant_id, type, category, amount_cents, description, occurred_at
) values (
  'financial-ledger-test', 'SAIDA', 'teste_amounts', 12345,
  'financial_invariant_amounts', now()
);

select pg_temp.assert_true(
  (
    select amount = 123.45 and amount_cents = 12345
      from public.financial_transactions
     where description = 'financial_invariant_amounts'
  ),
  'insert apenas com amount_cents nao derivou amount'
);

update public.financial_transactions
   set amount = 77.77
 where description = 'financial_invariant_amounts';

select pg_temp.assert_true(
  (
    select amount = 77.77 and amount_cents = 7777
      from public.financial_transactions
     where description = 'financial_invariant_amounts'
  ),
  'update de amount nao sincronizou amount_cents'
);

update public.financial_transactions
   set amount_cents = 8888
 where description = 'financial_invariant_amounts';

select pg_temp.assert_true(
  (
    select amount = 88.88 and amount_cents = 8888
      from public.financial_transactions
     where description = 'financial_invariant_amounts'
  ),
  'update de amount_cents nao sincronizou amount'
);

do $amount_guard$
declare
  v_blocked boolean := false;
begin
  begin
    update public.financial_transactions
       set amount = 10.00,
           amount_cents = 999
     where description = 'financial_invariant_amounts';
  exception
    when check_violation then
      v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'assertion failed: update divergente de amount/amount_cents foi aceito';
  end if;
end
$amount_guard$;

insert into public.student_payments (
  asaas_payment_id, tenant_id, value, status, due_date
) values (
  'pay_financial_invariant_student_amounts',
  'financial-ledger-test',
  12.34,
  'PENDING',
  date '2026-07-01'
);

update public.student_payments
   set amount_cents = 5678
 where asaas_payment_id = 'pay_financial_invariant_student_amounts';

select pg_temp.assert_true(
  (
    select value = 56.78 and amount_cents = 5678
      from public.student_payments
     where asaas_payment_id = 'pay_financial_invariant_student_amounts'
  ),
  'update de student_payments.amount_cents nao sincronizou value'
);

update public.student_payments
   set value = 9.87
 where asaas_payment_id = 'pay_financial_invariant_student_amounts';

select pg_temp.assert_true(
  (
    select value = 9.87 and amount_cents = 987
      from public.student_payments
     where asaas_payment_id = 'pay_financial_invariant_student_amounts'
  ),
  'update de student_payments.value nao sincronizou amount_cents'
);

do $student_amount_guard$
declare
  v_blocked boolean := false;
begin
  begin
    update public.student_payments
       set value = 10.00,
           amount_cents = 999
     where asaas_payment_id = 'pay_financial_invariant_student_amounts';
  exception
    when check_violation then
      v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'assertion failed: value/amount_cents divergentes foram aceitos';
  end if;
end
$student_amount_guard$;

-- -------------------------------------------------------------------------
-- [8] Superficie da RPC e pos-condicoes estruturais
-- -------------------------------------------------------------------------

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.reconcile_student_payment_ledger(integer,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.reconcile_student_payment_ledger(integer,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.reconcile_student_payment_ledger(integer,uuid)',
    'EXECUTE'
  ),
  'RPC de conciliacao nao esta restrita ao service_role'
);

select pg_temp.assert_true(
  (
    select pg_get_functiondef(p.oid) like '%pg_try_advisory_xact_lock%'
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'reconcile_student_payment_ledger'
       and pg_get_function_identity_arguments(p.oid) = 'p_limit integer, p_after_id uuid'
  ),
  'RPC perdeu a trava transacional contra reconciliacoes concorrentes'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_constraint
     where conrelid = 'public.financial_transactions'::regclass
       and conname = 'financial_transactions_amount_equivalence'
       and convalidated
  ),
  'constraint de equivalencia do ledger ausente ou nao validada'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_index i on i.indexrelid = c.oid
     where n.nspname = 'public'
       and c.relname = 'uq_financial_transactions_student_payment'
       and i.indisunique
       and i.indrelid = 'public.financial_transactions'::regclass
       and i.indnkeyatts = 1
       and i.indkey[0] = (
         select a.attnum
           from pg_attribute a
          where a.attrelid = 'public.financial_transactions'::regclass
            and a.attname = 'student_payment_id'
            and not a.attisdropped
       )
       and pg_get_expr(i.indpred, i.indrelid) = '(student_payment_id IS NOT NULL)'
  ),
  'indice unico parcial por student_payment ausente'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_index i on i.indexrelid = c.oid
     where n.nspname = 'public'
       and c.relname = 'uq_financial_transactions_refund_event'
       and i.indisunique
       and i.indrelid = 'public.financial_transactions'::regclass
       and i.indnkeyatts = 1
       and i.indkey[0] = (
         select a.attnum
           from pg_attribute a
          where a.attrelid = 'public.financial_transactions'::regclass
            and a.attname = 'provider_event_id'
            and not a.attisdropped
       )
       and pg_get_expr(i.indpred, i.indrelid) =
         '((refund_student_payment_id IS NOT NULL) AND (provider_event_id IS NOT NULL))'
  ),
  'indice unico parcial por evento de estorno ausente'
);

select pg_temp.assert_true(
  (
    select position('refund_student_payment_id IS NULL' in pg_get_functiondef(
      'public.dre_gerencial(text,text)'::regprocedure
    )) > 0
    and position(
      $$SELECT COALESCE(sum(value),0) INTO v_receita$$
      in pg_get_functiondef('public.dre_gerencial(text,text)'::regprocedure)
    ) = 0
  ),
  'patch reexecutavel dos relatorios nao terminou no estado NEW esperado'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from public.student_payments sp
      join public.financial_transactions ft on ft.student_payment_id = sp.id
     where sp.status = 'CONFIRMED'
  ),
  'CONFIRMED voltou a aparecer no caixa'
);

select pg_temp.assert_true(
  position(
    $$new.status not in ('RECEIVED', 'RECEIVED_IN_CASH')$$
    in pg_get_functiondef('public.notify_payment_split()'::regprocedure)
  ) > 0
  and position(
    'CONFIRMED'
    in pg_get_functiondef('public.notify_payment_split()'::regprocedure)
  ) = 0
  and not has_function_privilege(
    'authenticated',
    'public.notify_payment_split()',
    'EXECUTE'
  ),
  'rateio voltou a disparar antes de o saldo estar disponivel'
);

rollback;
