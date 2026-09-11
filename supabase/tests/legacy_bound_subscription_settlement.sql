-- Local ledger fixture only: no provider request; always roll back.
begin;
set local request.jwt.claims = '{"role":"service_role"}';
insert into auth.users(id,email,raw_user_meta_data) values ('00000000-0000-4000-8000-000000000083','legacy-ledger-20260909@example.invalid','{"full_name":"Legacy ledger fixture"}');
update profiles set tenant_id='school-wise-wolf',asaas_customer_id='cus_legacy_test_fixture',subscription_id='sub_legacy_test_fixture',is_test_account=true,test_fixture_key='legacy-ledger-20260909',monthly_fee=229 where id='00000000-0000-4000-8000-000000000083';
do $$
declare r jsonb; v_id uuid; payload jsonb := '{"id":"evt_legacy_test_fixture","event":"PAYMENT_RECEIVED","dateCreated":"2026-09-09T12:00:00Z","testMode":true,"test_fixture":true,"payment":{"id":"pay_legacy_test_fixture","customer":"cus_legacy_test_fixture","subscription":"sub_legacy_test_fixture","externalReference":null,"status":"RECEIVED","value":229,"dueDate":"2026-09-10","paymentDate":"2026-09-09","billingType":"PIX"}}';
begin
 for i in 1..2 loop
  r:=public.apply_active_student_payment_event(
   p_provider_payment_id=>'pay_legacy_test_fixture',p_expected_local_payment_id=>v_id,p_expected_student_id=>'00000000-0000-4000-8000-000000000083',p_expected_tenant_id=>'school-wise-wolf',p_expected_provider_customer_id=>'cus_legacy_test_fixture',p_expected_provider_subscription_id=>'sub_legacy_test_fixture',p_canonical_reference=>'00000000-0000-4000-8000-000000000083',p_event_id=>'evt_legacy_test_fixture',p_event_name=>'PAYMENT_RECEIVED',p_event_created_at=>'2026-09-09T12:00:00Z',p_event_rank=>80,p_provider_status=>'RECEIVED',p_provider_value=>229,p_due_date=>'2026-09-10',p_payment_date=>'2026-09-09',p_billing_type=>'PIX',p_invoice_url=>null,p_description=>'Legacy fixture',p_payment_type=>'SUBSCRIPTION',p_credited_at=>'2026-09-09T12:00:00Z',p_estimated_credit_at=>null,p_payload=>payload);
  assert r->>'ok'='true',r::text;
  v_id:=(r->>'id')::uuid;
 end loop;
 assert (select count(*) from student_payments where asaas_payment_id='pay_legacy_test_fixture')=1;
 assert (select payment_date from student_payments where id=v_id)='2026-09-09'::date;
 assert (select value from student_payments where id=v_id)=229;
 assert not exists(select 1 from notification_queue where student_id='00000000-0000-4000-8000-000000000083' and status in ('pending','processing'));
end;
$$;
rollback;
