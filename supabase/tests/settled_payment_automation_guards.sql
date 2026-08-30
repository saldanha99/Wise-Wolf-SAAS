-- Automacoes dependentes de caixa so podem reagir a saldo efetivamente
-- recebido. Confirmacao da operadora nao provisiona minutos nem rateio.

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
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

select pg_temp.assert_true(
  position(
    'PAYMENT_CONFIRMED' in pg_get_functiondef(
      'public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric)'::regprocedure
    )
  ) = 0
  and position(
    'PAYMENT_RECEIVED_IN_CASH' in pg_get_functiondef(
      'public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric)'::regprocedure
    )
  ) > 0,
  'top-up aceita confirmacao sem saldo ou rejeita recebimento em dinheiro'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.apply_verified_wolfie_topup_payment(uuid,text,text,numeric,numeric,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.apply_verified_wolfie_topup_payment(uuid,text,text,numeric,numeric,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.apply_verified_wolfie_topup_payment(uuid,text,text,numeric,numeric,text,text,text)',
    'EXECUTE'
  ),
  'RPC de top-up vazou para o navegador ou deixou de aceitar o worker'
);

insert into public.tenants (id, name)
values ('settled-automation-test', 'Settled Automation Test');

-- Insira primeiro os pagamentos para que o trigger de aviso permaneça inerte;
-- a configuracao ativa nasce depois e exercita exclusivamente a varredura.
insert into public.student_payments (
  asaas_payment_id,
  tenant_id,
  value,
  status,
  due_date,
  payment_date,
  credited_at
) values
  (
    'pay_settled_guard_confirmed',
    'settled-automation-test',
    10.00,
    'CONFIRMED',
    current_date,
    current_date,
    null
  ),
  (
    'pay_settled_guard_received',
    'settled-automation-test',
    20.00,
    'RECEIVED',
    current_date,
    current_date,
    pg_catalog.now() - interval '5 minutes'
  ),
  (
    'pay_settled_guard_cash',
    'settled-automation-test',
    30.00,
    'RECEIVED_IN_CASH',
    current_date,
    current_date,
    pg_catalog.now() - interval '4 minutes'
  );

insert into public.payment_split_settings (
  tenant_id,
  dizimo_pct,
  investimento_pct,
  escola_pct,
  is_active
) values (
  'settled-automation-test',
  10,
  10,
  10,
  true
);

select pg_temp.assert_true(
  (
    select count(*) = 2
       and count(*) filter (
         where item ->> 'payment_id' = received.id::text
       ) = 1
       and count(*) filter (
         where item ->> 'payment_id' = cash.id::text
       ) = 1
       and count(*) filter (
         where item ->> 'payment_id' = confirmed.id::text
       ) = 0
      from jsonb_array_elements(public.payment_split_pending()) as item
      cross join lateral (
        select id
          from public.student_payments
         where asaas_payment_id = 'pay_settled_guard_confirmed'
      ) as confirmed
      cross join lateral (
        select id
          from public.student_payments
         where asaas_payment_id = 'pay_settled_guard_received'
      ) as received
      cross join lateral (
        select id
          from public.student_payments
         where asaas_payment_id = 'pay_settled_guard_cash'
      ) as cash
     where item ->> 'tenant_id' = 'settled-automation-test'
  ),
  'varredura de rateio nao selecionou exatamente os dois recebimentos reais'
);

select pg_temp.assert_true(
  position(
    'PAYMENT_CONFIRMED' in pg_get_functiondef(
      'public.payment_split_pending()'::regprocedure
    )
  ) = 0
  and position(
    '''CONFIRMED''' in pg_get_functiondef(
      'public.payment_split_pending()'::regprocedure
    )
  ) = 0,
  'varredura de rateio voltou a aceitar confirmacao sem saldo'
);

rollback;
