\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(value boolean,message text) returns void language plpgsql as $$
begin if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if; end; $$;
insert into public.tenants (id, name, slug, saas_status, school_info)
values (
  'affiliate-rateio-test',
  'Affiliate Coupon Test',
  'affiliate-rateio-test',
  'active',
  jsonb_build_object(
    'legalName', 'Affiliate Coupon Test Ltda',
    'cnpj', '04252011000110',
    'address', 'Rua do Afiliado, 100',
    'email', 'legal-affiliate@example.invalid',
    'phone', '11999999999',
    'city', 'Sao Paulo',
    'state', 'SP',
    'legalRepresentativeName', 'Representante Afiliados',
    'legalRepresentativeSignaturePath',
      'affiliate-rateio-test/legal-representative-signature/00000000-0000-4000-8000-00000000bfe1.png'
  )
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '00000000-0000-4000-8000-00000000bf01',
    'authenticated', 'authenticated', 'affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000bf02',
    'authenticated', 'authenticated', 'student-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Student Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000bf03',
    'authenticated', 'authenticated', 'director-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Director Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000bf04',
    'authenticated', 'authenticated', 'gabriela-souza@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Gabriela Souza"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000bf05',
    'authenticated', 'authenticated', 'gabriela-lima@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Gabriéla Lima"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000bf06',
    'authenticated', 'authenticated', 'teacher-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Teacher Affiliate Test"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'affiliate-rateio-test',
       full_name = 'Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 10900,
       affiliate_code = 'PARCEIRO109',
       pix_key = 'affiliate@example.invalid',
       pix_key_type = 'EMAIL'
 where id = '00000000-0000-4000-8000-00000000bf01';
update public.profiles
   set role = 'STUDENT',
       tenant_id = 'affiliate-rateio-test',
       full_name = 'Student Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000bf02';
update public.profiles
   set role = 'SCHOOL_ADMIN',
       tenant_id = 'affiliate-rateio-test',
       full_name = 'Director Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000bf03';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'affiliate-rateio-test',
       full_name = 'Gabriela Souza',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 4900,
       affiliate_code = 'afiliada10'
 where id = '00000000-0000-4000-8000-00000000bf04';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'affiliate-rateio-test',
       full_name = 'Gabriéla Lima',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 4900,
       affiliate_code = 'GABI20'
 where id = '00000000-0000-4000-8000-00000000bf05';
update public.profiles
   set role = 'TEACHER',
       tenant_id = 'affiliate-rateio-test',
       full_name = 'Teacher Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000bf06';
set local app.enrollment_claim = '';

insert into public.teacher_pay_tiers(tenant_id,min_students,rate)
values('affiliate-rateio-test',1,8) on conflict(tenant_id,min_students) do update set rate=excluded.rate;
insert into public.bookings(id,tenant_id,student_id,teacher_id,day_of_week,time_slot,status,start_date)
values('20000000-0000-4000-8000-00000000bf01','affiliate-rateio-test',
  '00000000-0000-4000-8000-00000000bf02','00000000-0000-4000-8000-00000000bf06',
  'Segunda','10:00','SCHEDULED','2026-10-01');
insert into public.offers(id,kind,tenant_id,payload,metadata,expires_at,created_by,
  processing_by,processing_started_at,requires_enrollment,enrollment_fee,processing_state,invite_security_version,vendor_id)
values('10000000-0000-4000-8000-00000000bf01','ENROLLMENT','affiliate-rateio-test',
  '{"value":100}', '{"activation_payment_id":"pay_net_fixture_1"}',now()+interval '1 day',
  '00000000-0000-4000-8000-00000000bf03','00000000-0000-4000-8000-00000000bf02',now(),true,0,
  'NOT_STARTED',1,'00000000-0000-4000-8000-00000000bf01');
insert into public.vendor_commissions(id,vendor_id,student_id,tenant_id,offer_id,amount_brl,status)
values('30000000-0000-4000-8000-00000000bf01','00000000-0000-4000-8000-00000000bf01',
 '00000000-0000-4000-8000-00000000bf02','affiliate-rateio-test',
 '10000000-0000-4000-8000-00000000bf01',10900,'CONFIRMED');
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,due_date,description)
values('40000000-0000-4000-8000-00000000bf01','affiliate-rateio-test','00000000-0000-4000-8000-00000000bf02',
 'pay_net_fixture_1',100,'RECEIVED','2026-10-30','Mensalidade'),
 ('40000000-0000-4000-8000-00000000bf02','affiliate-rateio-test','00000000-0000-4000-8000-00000000bf02',
 'pay_net_fixture_2',100,'RECEIVED','2026-11-30','Mensalidade'),
 ('40000000-0000-4000-8000-00000000bf03','affiliate-rateio-test','00000000-0000-4000-8000-00000000bf02',
 'pay_net_fixture_fee',39.9,'RECEIVED','2026-10-01','Taxa de Matricula');

select pg_temp.assert_true(
  (private.payment_split_breakdown_unchecked('40000000-0000-4000-8000-00000000bf01')->>'custo_afiliado')::numeric=109
  and (private.payment_split_breakdown_unchecked('40000000-0000-4000-8000-00000000bf01')->>'custo_professor')::numeric=32
  and (private.payment_split_breakdown_unchecked('40000000-0000-4000-8000-00000000bf01')->>'resultado_antes_rateio')::numeric=-41
  and (private.payment_split_breakdown_unchecked('40000000-0000-4000-8000-00000000bf01')->>'dizimo')::numeric=0,
  'salário e comissão devem zerar o dízimo quando os custos excedem o pagamento');
select pg_temp.assert_true(
  (private.payment_affiliate_cost('40000000-0000-4000-8000-00000000bf02')->>'custo_afiliado')::numeric=0
  and (private.payment_affiliate_cost('40000000-0000-4000-8000-00000000bf03')->>'custo_afiliado')::numeric=0,
  'comissão não se repete e não cai na taxa de matrícula');
update public.student_payments set value=198 where id='40000000-0000-4000-8000-00000000bf01';
select pg_temp.assert_true(
  (private.payment_split_breakdown_unchecked('40000000-0000-4000-8000-00000000bf01')->>'liquido')::numeric=57
  and (private.payment_split_breakdown_unchecked('40000000-0000-4000-8000-00000000bf01')->>'dizimo')::numeric=5.70,
  'sobra positiva desconta centavos de comissão antes dos percentuais');
update public.offers set vendor_id=null,metadata=metadata||jsonb_build_object(
  'affiliate_retroactive_vendor_id','00000000-0000-4000-8000-00000000bf01',
  'affiliate_retroactive_authorization','Direção: atribuição do fixture',
  'affiliate_first_monthly_payment_id','pay_net_fixture_1')
  where id='10000000-0000-4000-8000-00000000bf01';
select pg_temp.assert_true(
  (private.payment_affiliate_cost('40000000-0000-4000-8000-00000000bf01')->>'custo_afiliado')::numeric=109,
  'atribuição retroativa autorizada e registrada no ledger também desconta a comissão');
update public.vendor_commissions set status='PAID',paid_at=now() where id='30000000-0000-4000-8000-00000000bf01';
select pg_temp.assert_true(
  (private.payment_affiliate_cost('40000000-0000-4000-8000-00000000bf01')->>'custo_afiliado')::numeric=109,
  'pagar a comissão não faz o custo desaparecer da base');

-- Canal isolado e fila transacional: nenhum worker pode ver o fixture.
insert into public.tenant_notice_channels(tenant_id,channel,group_jid)
values('affiliate-rateio-test','financeiro','120363000000000001@g.us');
update public.vendor_commissions set status='CONFIRMED',paid_at=null where id='30000000-0000-4000-8000-00000000bf01';
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000bf01"}';
select pg_temp.assert_true((public.request_vendor_withdrawal()->>'ok')::boolean,'saque deve reservar comissões');
select pg_temp.assert_true((select count(*)=1 from public.notification_queue
  where tenant_id='affiliate-rateio-test' and notification_kind='AFFILIATE_WITHDRAWAL_REQUESTED'),
  'novo saque deve entrar na fila financeira uma vez');
select pg_temp.assert_true(not (public.request_vendor_withdrawal()->>'ok')::boolean,
  'reserva do primeiro saque impede solicitar o mesmo saldo duas vezes');
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_true((select (public.get_affiliate_withdrawal_notice_snapshot(id)->>'ok')::boolean
  from public.notification_queue where tenant_id='affiliate-rateio-test' and notification_kind='AFFILIATE_WITHDRAWAL_REQUESTED'),
  'snapshot canônico deve validar pedido e destino');
select pg_temp.assert_true((select public.get_affiliate_withdrawal_notice_snapshot(id)->>'message'=message_body
  from public.notification_queue where tenant_id='affiliate-rateio-test' and notification_kind='AFFILIATE_WITHDRAWAL_REQUESTED'),
  'trigger e revalidação devem montar o mesmo texto sem expor a chave PIX');
update public.tenant_notice_channels set group_jid='120363000000000002@g.us'
 where tenant_id='affiliate-rateio-test' and channel='financeiro';
select pg_temp.assert_true((select not (public.get_affiliate_withdrawal_notice_snapshot(id)->>'ok')::boolean
  from public.notification_queue where tenant_id='affiliate-rateio-test' and notification_kind='AFFILIATE_WITHDRAWAL_REQUESTED'),
  'troca do destino financeiro bloqueia envio ao grupo antigo');
update public.tenant_notice_channels set group_jid='120363000000000001@g.us'
 where tenant_id='affiliate-rateio-test' and channel='financeiro';
update public.vendor_withdrawal_requests set status='CANCELLED' where tenant_id='affiliate-rateio-test';
select pg_temp.assert_true((select not (public.get_affiliate_withdrawal_notice_snapshot(id)->>'ok')::boolean
  from public.notification_queue where tenant_id='affiliate-rateio-test' and notification_kind='AFFILIATE_WITHDRAWAL_REQUESTED'),
  'pedido cancelado não deve ser enviado');
select pg_temp.assert_true((select not (public.begin_notification_delivery_submission(id,
  gen_random_uuid(),'fixture-instance',student_phone,student_phone,message_body,null,null)->>'ok')::boolean
  from public.notification_queue where tenant_id='affiliate-rateio-test' and notification_kind='AFFILIATE_WITHDRAWAL_REQUESTED'),
  'cerca final também recusa pedido cancelado antes de qualquer envio');
select pg_temp.assert_true(
  not has_function_privilege('authenticated','public.gestao_affiliate_turbo_context(text)','EXECUTE')
  and not has_function_privilege('anon','public.get_affiliate_withdrawal_notice_snapshot(uuid)','EXECUTE')
  and not has_function_privilege('authenticated','private.payment_affiliate_cost(uuid)','EXECUTE'),
  'dados financeiros privados não devem abrir nova API pública');
-- Fixtures jamais geram intenção de WhatsApp, mesmo com canal configurado.
update public.profiles set is_test_account=true where id='00000000-0000-4000-8000-00000000bf01';
insert into public.vendor_withdrawal_requests(tenant_id,vendor_id,amount_brl,commission_count,pix_key_snapshot)
values('affiliate-rateio-test','00000000-0000-4000-8000-00000000bf01',10900,1,'fixture@example.invalid');
select pg_temp.assert_true((select count(*)=1 from public.notification_queue
  where tenant_id='affiliate-rateio-test' and notification_kind='AFFILIATE_WITHDRAWAL_REQUESTED'),
  'pedido fixture não deve criar aviso externo');
rollback;
