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
  has_function_privilege(
    'service_role',
    'public.gestao_financial_context(text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.gestao_financial_context(text,text)',
    'EXECUTE'
  ),
  'management financial context privileges are unsafe'
);

insert into public.tenants (
  id, name, slug, saas_status, whatsapp_enabled
) values
  (
    'gestao-context-school-a',
    'Gestao Context School A',
    'gestao-context-school-a',
    'active',
    true
  ),
  (
    'gestao-context-school-b',
    'Gestao Context School B',
    'gestao-context-school-b',
    'active',
    true
  );

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_type, billing_type
) values
  (
    '59000000-0000-4000-8000-000000000001',
    null,
    'gestao-context-school-a',
    'pay_gestao_context_pending_a',
    123.45,
    12345,
    'PENDING',
    'PENDING',
    '2026-07-15',
    'SUBSCRIPTION',
    'PIX'
  ),
  (
    '59000000-0000-4000-8000-000000000002',
    null,
    'gestao-context-school-a',
    'pay_gestao_context_overdue_a',
    50.10,
    5010,
    'OVERDUE',
    'OVERDUE',
    '2026-06-15',
    'SUBSCRIPTION',
    'PIX'
  ),
  (
    '59000000-0000-4000-8000-000000000003',
    null,
    'gestao-context-school-b',
    'pay_gestao_context_pending_b',
    999.00,
    99900,
    'PENDING',
    'PENDING',
    '2026-07-15',
    'SUBSCRIPTION',
    'PIX'
  );

insert into public.monthly_payment_closures (
  tenant_id,
  period_start,
  status,
  expected_students,
  settled_students,
  blocked_students,
  snapshot,
  snapshot_hash,
  sent_at
) values
  (
    'gestao-context-school-a',
    '2026-07-01',
    'BLOCKED',
    2,
    1,
    1,
    jsonb_build_object(
      'blockers', jsonb_build_array('open_invoices'),
      'roster', jsonb_build_object(
        'expected_students', 2,
        'settled_students', 1,
        'blocked_students', 1,
        'missing_invoice_students', 0,
        'open_students', 1,
        'waiting_credit_students', 0,
        'review_students', 0,
        'items', jsonb_build_array(
          jsonb_build_object(
            'student_id', '59000000-0000-4000-8000-000000000011',
            'student_name', 'Aluno Pendente A',
            'status', 'OPEN',
            'billed_amount', 100
          ),
          jsonb_build_object(
            'student_id', '59000000-0000-4000-8000-000000000012',
            'student_name', 'Aluno Pago A',
            'status', 'SETTLED',
            'billed_amount', 100
          )
        )
      ),
      'competence', jsonb_build_object('billed', 200, 'settled', 100),
      'cash', jsonb_build_object(
        'recebido', 100,
        'dizimo', 10,
        'investimento', 10,
        'sobra', 80
      ),
      'rules', jsonb_build_object('is_active', true),
      'unclassified_cash_count', 0,
      'open_reconciliation_count', 0
    ),
    repeat('a', 64),
    null
  ),
  (
    'gestao-context-school-a',
    '2026-06-01',
    'SENT',
    2,
    2,
    0,
    jsonb_build_object(
      'blockers', '[]'::jsonb,
      'roster', jsonb_build_object(
        'expected_students', 2,
        'settled_students', 2,
        'blocked_students', 0,
        'items', '[]'::jsonb
      ),
      'competence', jsonb_build_object('billed', 200, 'settled', 200),
      'cash', jsonb_build_object('recebido', 200, 'dizimo', 20),
      'rules', jsonb_build_object('is_active', true)
    ),
    repeat('b', 64),
    '2026-07-01 12:00:00+00'
  ),
  (
    'gestao-context-school-b',
    '2026-07-01',
    'READY',
    1,
    1,
    0,
    jsonb_build_object(
      'blockers', '[]'::jsonb,
      'roster', jsonb_build_object(
        'expected_students', 1,
        'settled_students', 1,
        'blocked_students', 0,
        'items', jsonb_build_array(
          jsonb_build_object(
            'student_name', 'Aluno de Outra Escola',
            'status', 'SETTLED'
          )
        )
      ),
      'cash', jsonb_build_object('recebido', 999)
    ),
    repeat('c', 64),
    null
  );

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

create temporary table gestao_context_result as
select public.gestao_financial_context(
  'gestao-context-school-a',
  '2026-07'
) as payload;

select pg_temp.assert_true(
  (
    select (payload ->> 'a_receber_no_mes')::numeric = 123.45
       and (payload #>> '{inadimplencia,total}')::numeric = 50.10
       and (payload #>> '{inadimplencia,count}')::integer = 1
      from gestao_context_result
  ),
  'service_role receivables were zeroed or crossed tenant boundaries'
);

select pg_temp.assert_true(
  (
    select payload #>> '{fechamento_mensal,mes_consultado,status}' = 'BLOCKED'
       and payload #>> '{fechamento_mensal,mes_anterior,status}' = 'SENT'
       and (payload #>> '{fechamento_mensal,mes_consultado,caixa,recebido}')::numeric = 100
       and jsonb_array_length(
         payload #> '{fechamento_mensal,mes_consultado,alunos,pendentes}'
       ) = 1
       and payload #>> '{fechamento_mensal,mes_consultado,alunos,pendentes,0,student_name}' =
         'Aluno Pendente A'
      from gestao_context_result
  ),
  'monthly close context omitted canonical totals or unresolved students'
);

select pg_temp.assert_true(
  (
    select payload::text not like '%Aluno Pago A%'
       and payload::text not like '%Aluno de Outra Escola%'
      from gestao_context_result
  ),
  'management context leaked settled detail or another tenant data'
);

do $unauthorized_call$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"59000000-0000-4000-8000-000000000099"}',
    true
  );
  perform public.gestao_financial_context(
    'gestao-context-school-a',
    '2026-07'
  );
  raise exception 'authenticated caller unexpectedly reached financial context';
exception
  when insufficient_privilege then null;
end;
$unauthorized_call$;

rollback;
