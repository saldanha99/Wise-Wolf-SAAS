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
  not has_table_privilege(
    'authenticated', 'public.monthly_payment_closures', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.management_group_message_attempts', 'SELECT'
  )
  and has_function_privilege(
    'service_role',
    'public.claim_management_group_message(text,text,text,date,uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.apply_monthly_payment_closure_delivery_result(text,date,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.apply_monthly_payment_closure_delivery_result(text,date,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.refresh_monthly_payment_closure_financial(text,date)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.refresh_monthly_payment_closure_financial(text,date)',
    'EXECUTE'
  ),
  'monthly close privileges are unsafe'
);

insert into public.tenants (
  id, name, slug, saas_status, whatsapp_enabled
) values (
  'monthly-close-school',
  'Monthly Close School',
  'monthly-close-school',
  'active',
  true
);
insert into public.dre_report_settings (
  tenant_id, destino, cadencia, dia_semana, is_active
) values (
  'monthly-close-school',
  '120363000000000000@g.us',
  'mensal',
  1,
  true
);
insert into public.payment_split_settings (
  tenant_id, dizimo_pct, investimento_pct, escola_pct,
  prof_dizimo_pct, prof_investimento_pct, prof_prolabore_pct, is_active
) values (
  'monthly-close-school', 10, 10, 0, 10, 70, 20, true
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '58000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'monthly-one@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Monthly One"}', now(), now()
  ),
  (
    '58000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'monthly-two@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Monthly Two"}', now(), now()
  ),
  (
    '58000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated', 'monthly-three@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Monthly Three"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'monthly-close-school',
       role = 'STUDENT',
       status = 'Ativo',
       lifecycle_status = 'active',
       is_test_account = false,
       test_fixture_key = null,
       monthly_fee = 100,
       due_day = 10,
       created_at = '2026-07-01 12:00:00+00'
 where id in (
   '58000000-0000-4000-8000-000000000001',
   '58000000-0000-4000-8000-000000000002',
   '58000000-0000-4000-8000-000000000003'
 );
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id in (
   '58000000-0000-4000-8000-000000000001',
   '58000000-0000-4000-8000-000000000002',
   '58000000-0000-4000-8000-000000000003'
 );
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  ('58000000-0000-4000-8000-000000000001', 'monthly-close-school', 'STUDENT', 'ACTIVE', true),
  ('58000000-0000-4000-8000-000000000002', 'monthly-close-school', 'STUDENT', 'ACTIVE', true),
  ('58000000-0000-4000-8000-000000000003', 'monthly-close-school', 'STUDENT', 'ACTIVE', true);

alter table public.student_payments
  disable trigger trg_notify_payment_split;
alter table public.student_payments
  disable trigger trg_notify_management_payment_confirmation;

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_date, paid_at,
  payment_type, billing_type
) values
  (
    '58000000-0000-4000-8000-000000000011',
    '58000000-0000-4000-8000-000000000001',
    'monthly-close-school', 'pay_monthly_one', 100, 10000,
    'RECEIVED', 'RECEIVED', '2026-07-10', '2026-07-10',
    '2026-07-10 12:00:00+00', 'SUBSCRIPTION', 'PIX'
  ),
  (
    '58000000-0000-4000-8000-000000000012',
    '58000000-0000-4000-8000-000000000002',
    'monthly-close-school', 'pay_monthly_two', 100, 10000,
    'CONFIRMED', 'CONFIRMED', '2026-07-10', null,
    null, 'SUBSCRIPTION', 'CREDIT_CARD'
  );

insert into public.financial_transactions (
  id, tenant_id, type, category, amount, amount_cents, description,
  occurred_at, account_code
) values
  (
    '58000000-0000-4000-8000-000000000021',
    'monthly-close-school', 'SAIDA', 'direct_material', 25, 2500,
    'Material operacional do teste', '2026-07-15 12:00:00+00', '5.1.03'
  ),
  (
    '58000000-0000-4000-8000-000000000022',
    'monthly-close-school', 'SAIDA', 'software', 40, 4000,
    'Software operacional do teste', '2026-07-15 12:00:00+00', '6.2.01'
  );

-- RESET de custom GUC pode deixar uma string vazia em conexoes internas. O
-- fechamento deve tratar isso como ausencia de claims, sem tentar converter
-- uma string vazia em JSON.
set local request.jwt.claims = '';

select public.refresh_monthly_payment_closure_financial(
  'monthly-close-school', '2026-07-01'
);
select pg_temp.assert_true(
  (
    select expected_students = 3
       and settled_students = 1
       and blocked_students = 2
       and status = 'BLOCKED'
      from public.monthly_payment_closures
     where tenant_id = 'monthly-close-school'
       and period_start = '2026-07-01'
  ),
  'missing invoice or CONFIRMED card did not block close'
);

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_date, paid_at,
  payment_type, billing_type
) values (
  '58000000-0000-4000-8000-000000000013',
  '58000000-0000-4000-8000-000000000003',
  'monthly-close-school', 'pay_monthly_three', 100, 10000,
  'RECEIVED', 'RECEIVED', '2026-07-10', '2026-07-10',
  '2026-07-10 12:00:00+00', 'SUBSCRIPTION', 'PIX'
);
update public.student_payments
   set status = 'RECEIVED',
       provider_status = 'RECEIVED',
       payment_date = '2026-07-10',
       paid_at = '2026-07-10 12:00:00+00'
 where id = '58000000-0000-4000-8000-000000000012';

select pg_temp.assert_true(
  (public.refresh_monthly_payment_closure_financial(
    'monthly-close-school', '2026-07-01'
  ) ->> 'status') = 'READY',
  'all settled obligations did not make close ready'
);
select pg_temp.assert_true(
  (
    select (snapshot #>> '{dre,custo_servicos}')::numeric = 25
       and (snapshot #>> '{dre,despesas_operacionais}')::numeric = 40
       and (snapshot #>> '{dre,resultado}')::numeric = 235
       and jsonb_array_length(snapshot #> '{dre,linhas}') >= 3
      from public.monthly_payment_closures
     where tenant_id = 'monthly-close-school'
       and period_start = '2026-07-01'
  ),
  'operating costs, expenses or DRE result were not frozen in the close'
);

create temporary table monthly_close_claims (
  label text primary key,
  payload jsonb not null
);
insert into monthly_close_claims values (
  'first',
  public.claim_management_group_message(
    'monthly-close-school',
    'MONTHLY_PAYMENT_CLOSE',
    'monthly-close-school',
    '2026-07-01',
    '58000000-0000-4000-8000-000000000101',
    300
  )
);
insert into monthly_close_claims values (
  'concurrent',
  public.claim_management_group_message(
    'monthly-close-school',
    'MONTHLY_PAYMENT_CLOSE',
    'monthly-close-school',
    '2026-07-01',
    '58000000-0000-4000-8000-000000000102',
    300
  )
);

select pg_temp.assert_true(
  (select payload ->> 'action' = 'SUBMIT_ONCE'
     from monthly_close_claims where label = 'first')
  and (select payload ->> 'action' = 'IN_PROGRESS'
     from monthly_close_claims where label = 'concurrent'),
  'concurrent close could acquire two provider submissions'
);

insert into monthly_close_claims values (
  'submitting',
  public.mark_management_group_message_submitting(
    (select (payload ->> 'attempt_id')::uuid
       from monthly_close_claims where label = 'first'),
    '58000000-0000-4000-8000-000000000101'
  )
);
insert into monthly_close_claims values (
  'sent',
  public.finish_management_group_message(
    (select (payload ->> 'attempt_id')::uuid
       from monthly_close_claims where label = 'first'),
    '58000000-0000-4000-8000-000000000101',
    'SENT',
    201,
    null
  )
);

select public.apply_monthly_payment_closure_delivery_result(
  'monthly-close-school',
  '2026-07-01',
  (select (payload ->> 'attempt_id')::uuid
     from monthly_close_claims where label = 'first')
);
select pg_temp.assert_true(
  (
    select status = 'SENT' and sent_at is not null
      from public.monthly_payment_closures
     where tenant_id = 'monthly-close-school'
       and period_start = '2026-07-01'
  ),
  'sent provider result did not close the competence'
);

-- A late operating expense changes only the DRE, not the tuition roster. The
-- frozen close must still move to review without opening a second POST.
insert into public.financial_transactions (
  id, tenant_id, type, category, amount, amount_cents, description,
  occurred_at, account_code
) values (
  '58000000-0000-4000-8000-000000000023',
  'monthly-close-school', 'SAIDA', 'late_software', 5, 500,
  'Despesa operacional tardia', '2026-07-20 12:00:00+00', '6.2.01'
);
select public.refresh_monthly_payment_closure_financial(
  'monthly-close-school', '2026-07-01'
);
select pg_temp.assert_true(
  (
    select status = 'REVIEW'
       and review_reason = 'dre_changed_after_monthly_close'
      from public.monthly_payment_closures
     where tenant_id = 'monthly-close-school'
       and period_start = '2026-07-01'
  )
  and (
    select count(*) = 1
      from public.management_group_message_attempts
     where tenant_id = 'monthly-close-school'
       and notification_kind = 'MONTHLY_PAYMENT_CLOSE'
       and ref_date = '2026-07-01'
  ),
  'late operating expense rewrote or duplicated the sent close'
);

-- Restore only the disposable fixture so the next assertion continues to test
-- a payment-source change independently of the DRE-only change above.
delete from public.financial_transactions
 where id = '58000000-0000-4000-8000-000000000023';
update public.monthly_payment_closures
   set status = 'SENT',
       review_reason = null
 where tenant_id = 'monthly-close-school'
   and period_start = '2026-07-01';

-- A late duplicate invoice changes the source after delivery. The original
-- message remains single-shot and the close moves to review.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_date, paid_at,
  payment_type, billing_type
) values (
  '58000000-0000-4000-8000-000000000014',
  '58000000-0000-4000-8000-000000000001',
  'monthly-close-school', 'pay_monthly_duplicate', 100, 10000,
  'RECEIVED', 'RECEIVED', '2026-07-10', '2026-07-10',
  '2026-07-10 12:00:00+00', 'SUBSCRIPTION', 'PIX'
);
select public.refresh_monthly_payment_closure_financial(
  'monthly-close-school', '2026-07-01'
);
select pg_temp.assert_true(
  (
    select status = 'REVIEW'
       and review_reason = 'source_changed_after_monthly_close'
      from public.monthly_payment_closures
     where tenant_id = 'monthly-close-school'
       and period_start = '2026-07-01'
  )
  and (
    select count(*) = 1
      from public.management_group_message_attempts
     where tenant_id = 'monthly-close-school'
       and notification_kind = 'MONTHLY_PAYMENT_CLOSE'
       and ref_date = '2026-07-01'
  ),
  'late source change duplicated or silently rewrote close'
);

-- Rejected and ambiguous provider outcomes have consumed the single allowed
-- POST. Both must leave the competence under durable review, never READY for a
-- second send on the next sweep.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, amount_cents,
  status, provider_status, due_date, payment_date, paid_at,
  payment_type, billing_type
) values
  (
    '58000000-0000-4000-8000-000000000015',
    '58000000-0000-4000-8000-000000000001',
    'monthly-close-school', 'pay_monthly_failed', 100, 10000,
    'RECEIVED', 'RECEIVED', '2026-05-10', '2026-05-10',
    '2026-05-10 12:00:00+00', 'SUBSCRIPTION', 'PIX'
  ),
  (
    '58000000-0000-4000-8000-000000000016',
    '58000000-0000-4000-8000-000000000001',
    'monthly-close-school', 'pay_monthly_unknown', 100, 10000,
    'RECEIVED', 'RECEIVED', '2026-06-10', '2026-06-10',
    '2026-06-10 12:00:00+00', 'SUBSCRIPTION', 'PIX'
  );

select public.refresh_monthly_payment_closure_financial(
  'monthly-close-school', '2026-05-01'
);
select public.refresh_monthly_payment_closure_financial(
  'monthly-close-school', '2026-06-01'
);
select pg_temp.assert_true(
  (
    select status = 'READY'
      from public.monthly_payment_closures
     where tenant_id = 'monthly-close-school'
       and period_start = '2026-05-01'
  )
  and (
    select status = 'READY'
      from public.monthly_payment_closures
     where tenant_id = 'monthly-close-school'
       and period_start = '2026-06-01'
  ),
  'delivery failure fixtures were not ready before their single attempt'
);

insert into monthly_close_claims values (
  'failed_claim',
  public.claim_management_group_message(
    'monthly-close-school',
    'MONTHLY_PAYMENT_CLOSE',
    'monthly-close-school',
    '2026-05-01',
    '58000000-0000-4000-8000-000000000201',
    300
  )
);
insert into monthly_close_claims values (
  'unknown_claim',
  public.claim_management_group_message(
    'monthly-close-school',
    'MONTHLY_PAYMENT_CLOSE',
    'monthly-close-school',
    '2026-06-01',
    '58000000-0000-4000-8000-000000000202',
    300
  )
);

select public.mark_management_group_message_submitting(
  (select (payload ->> 'attempt_id')::uuid
     from monthly_close_claims where label = 'failed_claim'),
  '58000000-0000-4000-8000-000000000201'
);
select public.mark_management_group_message_submitting(
  (select (payload ->> 'attempt_id')::uuid
     from monthly_close_claims where label = 'unknown_claim'),
  '58000000-0000-4000-8000-000000000202'
);
select public.finish_management_group_message(
  (select (payload ->> 'attempt_id')::uuid
     from monthly_close_claims where label = 'failed_claim'),
  '58000000-0000-4000-8000-000000000201',
  'FAILED',
  400,
  'provider rejected fixture'
);
select public.finish_management_group_message(
  (select (payload ->> 'attempt_id')::uuid
     from monthly_close_claims where label = 'unknown_claim'),
  '58000000-0000-4000-8000-000000000202',
  'UNKNOWN',
  504,
  'provider timeout fixture'
);

select pg_temp.assert_true(
  public.apply_monthly_payment_closure_delivery_result(
    'monthly-close-school',
    '2026-05-01',
    (select (payload ->> 'attempt_id')::uuid
       from monthly_close_claims where label = 'failed_claim')
  )
  and public.apply_monthly_payment_closure_delivery_result(
    'monthly-close-school',
    '2026-06-01',
    (select (payload ->> 'attempt_id')::uuid
       from monthly_close_claims where label = 'unknown_claim')
  ),
  'terminal delivery results were not applied to the monthly source'
);

-- Simulate the next cron sweep. REVIEW must survive a full recalculation.
select public.refresh_monthly_payment_closure_financial(
  'monthly-close-school', '2026-05-01'
);
select public.refresh_monthly_payment_closure_financial(
  'monthly-close-school', '2026-06-01'
);
select pg_temp.assert_true(
  (
    select status = 'REVIEW'
       and review_reason = 'monthly_message_failed'
      from public.monthly_payment_closures
     where tenant_id = 'monthly-close-school'
       and period_start = '2026-05-01'
  )
  and (
    select status = 'REVIEW'
       and review_reason = 'monthly_message_unknown'
      from public.monthly_payment_closures
     where tenant_id = 'monthly-close-school'
       and period_start = '2026-06-01'
  )
  and (
    select count(*) = 2
      from public.management_group_message_attempts
     where tenant_id = 'monthly-close-school'
       and notification_kind = 'MONTHLY_PAYMENT_CLOSE'
       and ref_date in ('2026-05-01', '2026-06-01')
       and submit_attempt_count = 1
  ),
  'FAILED or UNKNOWN returned to READY or created a second submission'
);

rollback;
