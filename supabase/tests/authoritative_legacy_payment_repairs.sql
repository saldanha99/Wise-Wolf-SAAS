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
  not has_function_privilege(
    'service_role',
    'public.repair_authoritative_unlinked_student_payment(uuid,uuid,text,jsonb,jsonb,jsonb,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.repair_authoritative_unlinked_student_payment(uuid,uuid,text,jsonb,jsonb,jsonb,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.repair_authoritative_unlinked_student_payment_fenced(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,jsonb,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.repair_authoritative_unlinked_student_payment_fenced(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,jsonb,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.repair_authoritative_legacy_payment_credit(uuid,text,jsonb,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.repair_authoritative_deleted_legacy_payment(uuid,uuid,text,jsonb,jsonb,text)',
    'EXECUTE'
  ),
  'authoritative legacy repair privileges are unsafe'
);

set local request.jwt.claims = '{"role":"service_role"}';

insert into public.tenants (
  id, name, slug, saas_status, whatsapp_enabled
) values
  (
    'authoritative-legacy-repair-school',
    'Authoritative Legacy Repair School',
    'authoritative-legacy-repair-school',
    'active', false
  ),
  (
    'authoritative-legacy-other-school',
    'Authoritative Legacy Other School',
    'authoritative-legacy-other-school',
    'active', false
  );

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '59000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'binding@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Binding Student"}', now(), now()
  ),
  (
    '59000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'deletion@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Deletion Student"}', now(), now()
  ),
  (
    '59000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'credit@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Credit Student"}', now(), now()
  ),
  (
    '59000000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated', 'sibling@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Sibling Student"}', now(), now()
  ),
  (
    '59000000-0000-4000-8000-000000000005',
    'authenticated', 'authenticated', 'director@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Test Director"}', now(), now()
  ),
  (
    '59000000-0000-4000-8000-000000000006',
    'authenticated', 'authenticated', 'other-director@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Other Test Director"}', now(), now()
  );

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
   set tenant_id = 'authoritative-legacy-repair-school',
       role = 'STUDENT',
       lifecycle_status = 'active',
       status = 'Ativo',
       status_financial = 'ACTIVE',
       is_test_account = false,
       monthly_fee = case id
         when '59000000-0000-4000-8000-000000000001'::uuid then 169
         when '59000000-0000-4000-8000-000000000002'::uuid then 261
         else 208.05
       end,
       due_day = 10,
       cpf = case id
         when '59000000-0000-4000-8000-000000000001'::uuid then '111.222.333-44'
         when '59000000-0000-4000-8000-000000000002'::uuid then '222.333.444-55'
         else '333.444.555-66'
       end,
       phone = case id
         when '59000000-0000-4000-8000-000000000001'::uuid then '(11) 99999-0001'
         when '59000000-0000-4000-8000-000000000002'::uuid then '(11) 99999-0002'
         else '(11) 99999-0003'
       end,
       asaas_customer_id = case id
         when '59000000-0000-4000-8000-000000000002'::uuid then 'cus_deleted_repair'
         when '59000000-0000-4000-8000-000000000003'::uuid then 'cus_credit_repair'
         else null
       end,
       subscription_id = null
 where id in (
   '59000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002',
   '59000000-0000-4000-8000-000000000003'
 );
update public.profiles
   set tenant_id = 'authoritative-legacy-repair-school',
       role = 'STUDENT',
       lifecycle_status = 'active',
       status = 'Ativo',
       status_financial = 'ACTIVE',
       is_test_account = false,
       cpf = '999.888.777-66',
       phone = '(11) 99999-0999',
       guardian_cpf = '111.222.333-44',
       guardian_phone = '(11) 99999-0001'
 where id = '59000000-0000-4000-8000-000000000004';
update public.profiles
   set tenant_id = 'authoritative-legacy-repair-school',
       role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active',
       status = 'Ativo',
       is_test_account = false
 where id = '59000000-0000-4000-8000-000000000005';
update public.profiles
   set tenant_id = 'authoritative-legacy-other-school',
       role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active',
       status = 'Ativo',
       is_test_account = false
 where id = '59000000-0000-4000-8000-000000000006';
select pg_catalog.set_config('app.enrollment_claim', '', true);

delete from public.tenant_memberships
 where user_id in (
   '59000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000002',
   '59000000-0000-4000-8000-000000000003',
   '59000000-0000-4000-8000-000000000004',
   '59000000-0000-4000-8000-000000000005',
   '59000000-0000-4000-8000-000000000006'
 );
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  (
    '59000000-0000-4000-8000-000000000001',
    'authoritative-legacy-repair-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '59000000-0000-4000-8000-000000000002',
    'authoritative-legacy-repair-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '59000000-0000-4000-8000-000000000003',
    'authoritative-legacy-repair-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '59000000-0000-4000-8000-000000000004',
    'authoritative-legacy-repair-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '59000000-0000-4000-8000-000000000005',
    'authoritative-legacy-repair-school', 'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    '59000000-0000-4000-8000-000000000006',
    'authoritative-legacy-other-school', 'SCHOOL_ADMIN', 'ACTIVE', true
  );

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_date, payment_type, billing_type
) values
  (
    '59000000-0000-4000-8000-000000000011', null,
    'authoritative-legacy-repair-school', 'pay_unlinked_repair',
    169, 16900, 'RECEIVED', 'RECEIVED', '2026-08-10', '2026-08-10',
    'SUBSCRIPTION', 'PIX'
  ),
  (
    '59000000-0000-4000-8000-000000000012',
    '59000000-0000-4000-8000-000000000002',
    'authoritative-legacy-repair-school', 'pay_deleted_repair',
    261, 26100, 'OVERDUE', 'OVERDUE', '2026-08-15', null,
    'SUBSCRIPTION', 'BOLETO'
  ),
  (
    '59000000-0000-4000-8000-000000000013', null,
    'authoritative-legacy-repair-school', 'pay_deleted_orphan_repair',
    169, 16900, 'PENDING', 'PENDING', '2026-08-20', null,
    'SUBSCRIPTION', 'BOLETO'
  ),
  (
    '59000000-0000-4000-8000-000000000014',
    '59000000-0000-4000-8000-000000000003',
    'authoritative-legacy-repair-school', 'pay_credit_repair',
    208.05, 20805, 'RECEIVED', 'RECEIVED', '2026-08-10', '2026-08-10',
    'SUBSCRIPTION', 'BOLETO'
  ),
  (
    '59000000-0000-4000-8000-000000000015', null,
    'authoritative-legacy-repair-school', 'pay_attention_repair',
    99, 9900, 'PENDING', 'PENDING', '2026-08-25', null,
    'SUBSCRIPTION', 'PIX'
  );

create temporary table authoritative_repair_results (
  kind text primary key,
  payload jsonb not null
);

select pg_temp.assert_true(
  (
    public.repair_authoritative_unlinked_student_payment(
      '59000000-0000-4000-8000-000000000011',
      '59000000-0000-4000-8000-000000000001',
      'authoritative-legacy-repair-school',
      jsonb_build_object(
        'id', 'pay_unlinked_repair', 'customer', 'cus_unlinked_repair',
        'subscription', null, 'status', 'RECEIVED', 'value', 169,
        'dueDate', '2026-08-10', 'paymentDate', '2026-08-10',
        'creditDate', '2026-08-10', 'billingType', 'PIX', 'deleted', false
      ),
      null,
      jsonb_build_object(
        'id', 'cus_different', 'cpfCnpj', '11122233344',
        'email', 'binding@example.invalid', 'mobilePhone', '11999990001'
      ),
      false,
      'Teste negativo de cliente diferente da cobrança'
    ) ->> 'reason'
  ) = 'authoritative_payment_not_repairable',
  'customer evidence was not coupled to the payment customer'
);

select pg_temp.assert_true(
  (
    public.repair_authoritative_unlinked_student_payment(
      '59000000-0000-4000-8000-000000000011',
      '59000000-0000-4000-8000-000000000001',
      'authoritative-legacy-repair-school',
      jsonb_build_object(
        'id', 'pay_unlinked_repair', 'customer', 'cus_unlinked_repair',
        'subscription', null, 'status', 'RECEIVED', 'value', 169,
        'dueDate', '2026-08-10', 'paymentDate', '2026-08-10',
        'creditDate', '2026-08-10', 'estimatedCreditDate', '2026-08-10',
        'billingType', 'PIX', 'deleted', false
      ),
      null,
      jsonb_build_object(
        'id', 'cus_unlinked_repair', 'cpfCnpj', '00000000000',
        'email', 'binding@example.invalid', 'mobilePhone', '11999990001'
      ),
      false,
      'Teste negativo de CPF divergente com contatos iguais'
    ) ->> 'reason'
  ) = 'provider_customer_identity_not_corroborated'
  and (
    select student_id is null
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000011'
  ),
  'wrong CPF was allowed to bind an unlinked payment'
);

select pg_temp.assert_true(
  (
    public.repair_authoritative_unlinked_student_payment(
      '59000000-0000-4000-8000-000000000011',
      '59000000-0000-4000-8000-000000000001',
      'authoritative-legacy-repair-school',
      jsonb_build_object(
        'id', 'pay_unlinked_repair', 'customer', 'cus_unlinked_repair',
        'subscription', null, 'status', 'RECEIVED', 'value', 169,
        'dueDate', '2026-08-10', 'paymentDate', '2026-08-10',
        'creditDate', '2026-08-10', 'estimatedCreditDate', '2026-08-10',
        'billingType', 'PIX', 'deleted', false
      ),
      null,
      jsonb_build_object(
        'id', 'cus_unlinked_repair', 'cpfCnpj', '11122233344',
        'email', null, 'mobilePhone', '11999990001'
      ),
      false,
      'Teste negativo de identidade compartilhada entre irmãos'
    ) ->> 'reason'
  ) = 'provider_customer_identity_not_unique',
  'shared guardian identity was allowed to choose a sibling arbitrarily'
);

update public.profiles
   set lifecycle_status = 'offboarded'
 where id = '59000000-0000-4000-8000-000000000004';

insert into authoritative_repair_results values (
  'binding',
  public.repair_authoritative_unlinked_student_payment(
    '59000000-0000-4000-8000-000000000011',
    '59000000-0000-4000-8000-000000000001',
    'authoritative-legacy-repair-school',
    jsonb_build_object(
      'id', 'pay_unlinked_repair', 'customer', 'cus_unlinked_repair',
      'subscription', null, 'status', 'RECEIVED', 'value', 169,
      'dueDate', '2026-08-10', 'paymentDate', '2026-08-10',
      'creditDate', '2026-08-10', 'estimatedCreditDate', '2026-08-10',
      'billingType', 'PIX', 'deleted', false
    ),
    null,
    jsonb_build_object(
      'id', 'cus_unlinked_repair', 'cpfCnpj', '11122233344',
      'email', 'binding@example.invalid', 'mobilePhone', '11999990001'
    ),
    false,
    'Teste de vínculo legado com identidade autoritativa'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' from authoritative_repair_results
    where kind = 'binding') = 'BOUND'
  and (
    select student_id = '59000000-0000-4000-8000-000000000001'
       and provider_customer_id = 'cus_unlinked_repair'
       and credited_at is null
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000011'
  )
  and (
    select asaas_customer_id = 'cus_unlinked_repair'
      from public.profiles
     where id = '59000000-0000-4000-8000-000000000001'
  )
  and (
    select reference_id = '59000000-0000-4000-8000-000000000001'
      from public.financial_transactions
     where student_payment_id = '59000000-0000-4000-8000-000000000011'
  ),
  'authoritative unlinked payment was not repaired atomically'
);

select pg_temp.assert_true(
  (
    public.repair_authoritative_unlinked_student_payment(
      '59000000-0000-4000-8000-000000000011',
      '59000000-0000-4000-8000-000000000001',
      'authoritative-legacy-repair-school',
      jsonb_build_object(
        'id', 'pay_unlinked_repair', 'customer', 'cus_unlinked_repair',
        'subscription', null, 'status', 'RECEIVED', 'value', 169,
        'dueDate', '2026-08-10', 'paymentDate', '2026-08-10',
        'creditDate', '2026-08-10', 'estimatedCreditDate', '2026-08-10',
        'billingType', 'PIX', 'deleted', false
      ),
      null,
      jsonb_build_object(
        'id', 'cus_unlinked_repair', 'cpfCnpj', '11122233344',
        'email', 'binding@example.invalid', 'mobilePhone', '11999990001'
      ),
      false,
      'Teste idempotente do vínculo legado autoritativo'
    ) ->> 'action'
  ) = 'ALREADY_BOUND',
  'authoritative unlinked repair is not idempotent'
);

select pg_temp.assert_true(
  (
    public.repair_authoritative_deleted_legacy_payment(
      '59000000-0000-4000-8000-000000000012',
      '59000000-0000-4000-8000-000000000002',
      'authoritative-legacy-repair-school',
      jsonb_build_object(
        'id', 'pay_deleted_repair', 'customer', 'cus_deleted_repair',
        'subscription', 'sub_deleted_repair', 'status', 'OVERDUE',
        'value', 261, 'dueDate', '2026-08-15', 'deleted', true,
        'paymentDate', '2026-08-15'
      ),
      jsonb_build_object(
        'id', 'sub_deleted_repair', 'customer', 'cus_deleted_repair',
        'status', 'ACTIVE', 'deleted', false
      ),
      'Teste negativo de exclusão com evidência contraditória de caixa'
    ) ->> 'reason'
  ) = 'authoritative_deleted_payment_not_repairable'
  and (
    select status = 'OVERDUE'
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000012'
  ),
  'deleted repair accepted provider cash evidence'
);

insert into authoritative_repair_results values (
  'deleted',
  public.repair_authoritative_deleted_legacy_payment(
    '59000000-0000-4000-8000-000000000012',
    '59000000-0000-4000-8000-000000000002',
    'authoritative-legacy-repair-school',
    jsonb_build_object(
      'id', 'pay_deleted_repair', 'customer', 'cus_deleted_repair',
      'subscription', 'sub_deleted_repair', 'status', 'OVERDUE',
      'value', 261, 'dueDate', '2026-08-15', 'deleted', true
    ),
    jsonb_build_object(
      'id', 'sub_deleted_repair', 'customer', 'cus_deleted_repair',
      'status', 'ACTIVE', 'deleted', false
    ),
    'Teste de exclusão legada comprovada no Asaas'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' from authoritative_repair_results
    where kind = 'deleted') = 'CANCELLED'
  and (
    select status = 'CANCELLED' and provider_status = 'DELETED'
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000012'
  )
  and (
    select subscription_id is null
      from public.profiles
     where id = '59000000-0000-4000-8000-000000000002'
  )
  and not exists (
    select 1 from public.financial_transactions
     where student_payment_id = '59000000-0000-4000-8000-000000000012'
        or refund_student_payment_id = '59000000-0000-4000-8000-000000000012'
  ),
  'deleted provider charge did not converge without inventing cash'
);

select pg_temp.assert_true(
  (
    public.repair_authoritative_deleted_legacy_payment(
      '59000000-0000-4000-8000-000000000012',
      '59000000-0000-4000-8000-000000000002',
      'authoritative-legacy-repair-school',
      jsonb_build_object(
        'id', 'pay_deleted_repair', 'customer', 'cus_deleted_repair',
        'subscription', 'sub_deleted_repair', 'status', 'OVERDUE',
        'value', 261, 'dueDate', '2026-08-15', 'deleted', true
      ),
      jsonb_build_object(
        'id', 'sub_deleted_repair', 'customer', 'cus_deleted_repair',
        'status', 'ACTIVE', 'deleted', false
      ),
      'Teste idempotente da exclusão legada comprovada'
    ) ->> 'action'
  ) = 'ALREADY_CANCELLED'
  and (
    select exclusion_reason = 'provider_deleted_legacy_reconciled'
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000012'
  ),
  'deleted repair did not preserve its idempotent accounting exclusion'
);

select public.repair_authoritative_deleted_legacy_payment(
  '59000000-0000-4000-8000-000000000013',
  null,
  'authoritative-legacy-repair-school',
  jsonb_build_object(
    'id', 'pay_deleted_orphan_repair', 'customer', 'cus_orphan_repair',
    'subscription', 'sub_orphan_repair', 'status', 'PENDING',
    'value', 169, 'dueDate', '2026-08-20', 'deleted', true
  ),
  jsonb_build_object(
    'id', 'sub_orphan_repair', 'customer', 'cus_orphan_repair',
    'status', 'ACTIVE', 'deleted', false
  ),
  'Teste de exclusão órfã sem inventar vínculo de aluno'
);
select pg_temp.assert_true(
  (
    select status = 'CANCELLED' and provider_status = 'DELETED'
       and student_id is null
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000013'
  ),
  'deleted orphan charge was not safely cancelled'
);

insert into authoritative_repair_results values (
  'credit',
  public.repair_authoritative_legacy_payment_credit(
    '59000000-0000-4000-8000-000000000014',
    'authoritative-legacy-repair-school',
    jsonb_build_object(
      'id', 'pay_credit_repair', 'customer', 'cus_credit_repair',
      'status', 'RECEIVED', 'value', 208.05,
      'dueDate', '2026-08-10', 'paymentDate', '2026-08-10',
      'creditDate', '2026-08-11', 'deleted', false
    ),
    jsonb_build_object(
      'id', 'ftn_credit_repair', 'type', 'PAYMENT_RECEIVED',
      'paymentId', 'pay_credit_repair', 'value', 208.05,
      'date', '2026-08-11'
    ),
    'Teste de data de crédito comprovada por GET e extrato'
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' from authoritative_repair_results
    where kind = 'credit') = 'CREDIT_DATE_REPAIRED'
  and (
    select credited_at::date = '2026-08-11'
       and paid_at::date = '2026-08-11'
       and estimated_credit_at is null
      from public.student_payments
     where id = '59000000-0000-4000-8000-000000000014'
  )
  and (
    select occurred_at::date = '2026-08-11'
      from public.financial_transactions
     where student_payment_id = '59000000-0000-4000-8000-000000000014'
  ),
  'authoritative credit date did not update payment and ledger together'
);

select pg_temp.assert_true(
  (
    public.repair_authoritative_legacy_payment_credit(
      '59000000-0000-4000-8000-000000000014',
      'authoritative-legacy-repair-school',
      jsonb_build_object(
        'id', 'pay_credit_repair', 'customer', 'cus_credit_repair',
        'status', 'RECEIVED', 'value', 208.05,
        'dueDate', '2026-08-10', 'paymentDate', '2026-08-10',
        'creditDate', '2026-08-11', 'deleted', false
      ),
      jsonb_build_object(
        'id', 'ftn_credit_repair', 'type', 'PAYMENT_RECEIVED',
        'paymentId', 'pay_credit_repair', 'value', 208.05,
        'date', '2026-08-11'
      ),
      'Teste idempotente de reparo da data de crédito'
    ) ->> 'action'
  ) = 'ALREADY_REPAIRED',
  'authoritative credit repair is not idempotent'
);

set local request.jwt.claims =
  '{"sub":"59000000-0000-4000-8000-000000000005","role":"authenticated"}';

-- Isolate freshness assertions from any real reconciliation run already
-- present in the target database. The whole test is rolled back.
update public.asaas_reconciliation_runs
   set finished_at = pg_catalog.now() - interval '3 days'
 where status = 'COMPLETED'
   and finished_at >= pg_catalog.now() - interval '36 hours';

insert into public.asaas_reconciliation_runs (
  id, status, window_start, window_end, metrics, started_at, finished_at
) values (
  '59000000-0000-4000-8000-000000000021', 'COMPLETED',
  pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now())::date - 120,
  pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now())::date - 60,
  '{"tenantId":"authoritative-legacy-repair-school"}',
  now() - interval '2 minutes', now()
);

select pg_temp.assert_true(
  coalesce(
    (public.director_pending_counts() ->> 'pagamentos_sem_aluno')::integer,
    0
  ) = 1
  and public.director_pending_counts() ? 'conciliacao_asaas',
  'director pending facade did not expose the current unlinked queue'
);

select pg_temp.assert_true(
  public.asaas_reconciliation_attention() ? 'audit_available'
  and not (
    public.asaas_reconciliation_attention() ->> 'audit_available'
  )::boolean
  and coalesce(
    (public.asaas_reconciliation_attention() ->> 'qtd')::integer,
    0
  ) >= 1
  and (public.asaas_reconciliation_attention() -> 'itens') @>
    '[{"problema":"Pagamento sem aluno identificado"}]'::jsonb,
  'historical audit hid freshness or current unlinked payment'
);

insert into public.asaas_reconciliation_runs (
  id, status, window_start, window_end, metrics, started_at, finished_at
) values (
  '59000000-0000-4000-8000-000000000022', 'COMPLETED',
  pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now())::date - 45,
  pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now())::date,
  '{"tenantId":"authoritative-legacy-repair-school"}',
  now() - interval '1 minute', now()
);

insert into public.asaas_reconciliation_issues (
  run_id, tenant_id, source, kind, severity, provider_entity_id,
  local_entity_id, fingerprint, details
) values (
  '59000000-0000-4000-8000-000000000022',
  'authoritative-legacy-repair-school', 'PAYMENT',
  'PAYMENT_STATUS_MISMATCH', 'HIGH', 'pay_operational_attention',
  null, 'test-operational-attention',
  '{"value":42,"dueDate":"2026-08-29","providerStatus":"RECEIVED"}'
);

select pg_temp.assert_true(
  (public.asaas_reconciliation_attention() ->> 'audit_available')::boolean
  and public.asaas_reconciliation_attention() ->> 'run_id' =
    '59000000-0000-4000-8000-000000000022'
  and coalesce(
    (public.asaas_reconciliation_attention() ->> 'qtd')::integer,
    0
  ) = 2,
  'current broad audit was not selected for director attention'
);

set local request.jwt.claims =
  '{"sub":"59000000-0000-4000-8000-000000000006","role":"authenticated"}';

select pg_temp.assert_true(
  not (
    public.asaas_reconciliation_attention() ->> 'audit_available'
  )::boolean
  and coalesce(
    (public.asaas_reconciliation_attention() ->> 'qtd')::integer,
    0
  ) = 0
  and coalesce(
    (public.director_pending_counts() ->> 'conciliacao_asaas')::integer,
    0
  ) = 1,
  'one tenant inherited another tenant reconciliation truth'
);

rollback;
