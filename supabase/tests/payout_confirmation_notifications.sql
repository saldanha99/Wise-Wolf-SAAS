\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(value boolean,message text) returns void language plpgsql as $$
begin if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if; end; $$;
insert into public.tenants (id, name, slug, saas_status, school_info)
values (
  'payout-notice-test',
  'Payout Notice Test',
  'payout-notice-test',
  'active',
  jsonb_build_object(
    'legalName', 'Payout Notice Test Ltda',
    'cnpj', '04252011000110',
    'address', 'Rua do Afiliado, 100',
    'email', 'legal-affiliate@example.invalid',
    'phone', '11999999999',
    'city', 'Sao Paulo',
    'state', 'SP',
    'legalRepresentativeName', 'Representante Afiliados',
    'legalRepresentativeSignaturePath',
      'payout-notice-test/legal-representative-signature/00000000-0000-4000-8000-00000000cfe1.png'
  )
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '00000000-0000-4000-8000-00000000cf01',
    'authenticated', 'authenticated', 'affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000cf02',
    'authenticated', 'authenticated', 'student-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Student Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000cf03',
    'authenticated', 'authenticated', 'director-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Director Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000cf04',
    'authenticated', 'authenticated', 'gabriela-souza@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Gabriela Souza"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000cf05',
    'authenticated', 'authenticated', 'gabriela-lima@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Gabriéla Lima"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000cf06',
    'authenticated', 'authenticated', 'teacher-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Teacher Affiliate Test"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'payout-notice-test',
       full_name = 'Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 10900,
       affiliate_code = 'PARCEIRO109',
       pix_key = 'affiliate@example.invalid',
       pix_key_type = 'EMAIL'
 where id = '00000000-0000-4000-8000-00000000cf01';
update public.profiles
   set role = 'STUDENT',
       tenant_id = 'payout-notice-test',
       full_name = 'Student Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000cf02';
update public.profiles
   set role = 'SCHOOL_ADMIN',
       tenant_id = 'payout-notice-test',
       full_name = 'Director Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000cf03';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'payout-notice-test',
       full_name = 'Gabriela Souza',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 4900,
       affiliate_code = 'afiliada10'
 where id = '00000000-0000-4000-8000-00000000cf04';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'payout-notice-test',
       full_name = 'Gabriéla Lima',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 4900,
       affiliate_code = 'GABI20'
 where id = '00000000-0000-4000-8000-00000000cf05';
update public.profiles
   set role = 'TEACHER',
       tenant_id = 'payout-notice-test',
       full_name = 'Teacher Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000cf06';
set local app.enrollment_claim = '';

insert into public.teacher_pay_tiers(tenant_id,min_students,rate)
values('payout-notice-test',1,8) on conflict(tenant_id,min_students) do update set rate=excluded.rate;
insert into public.bookings(id,tenant_id,student_id,teacher_id,day_of_week,time_slot,status,start_date)
values('20000000-0000-4000-8000-00000000cf01','payout-notice-test',
  '00000000-0000-4000-8000-00000000cf02','00000000-0000-4000-8000-00000000cf06',
  'Segunda','10:00','SCHEDULED','2026-10-01');

update public.profiles set phone='11999990001',is_test_account=false where id='00000000-0000-4000-8000-00000000cf06';
update public.profiles set phone='11999990002',is_test_account=false where id='00000000-0000-4000-8000-00000000cf01';
insert into public.teacher_closings(id,tenant_id,teacher_id,month_year,total_lessons,total_amount,status)
values('60000000-0000-4000-8000-00000000cf01','payout-notice-test','00000000-0000-4000-8000-00000000cf06','2026-09',12,126,'PENDENTE'),
 ('60000000-0000-4000-8000-00000000cf02','payout-notice-test','00000000-0000-4000-8000-00000000cf06','2026-08',10,105,'PENDENTE'),
 ('60000000-0000-4000-8000-00000000cf03','payout-notice-test','00000000-0000-4000-8000-00000000cf06','2026-07',10,105,'PENDENTE');
select pg_temp.assert_true(not exists(select 1 from public.notification_queue where tenant_id='payout-notice-test'),
 'fechamento criado sozinho não confirma pagamento');
insert into public.tenants(id,name) values('payout-other-test','Outro tenant fixture');
set local app.enrollment_claim='1';
update public.profiles set role='SCHOOL_ADMIN',tenant_id='payout-other-test'
 where id='00000000-0000-4000-8000-00000000cf04';
set local app.enrollment_claim='';
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000cf04"}';
select pg_temp.assert_true(public.confirm_teacher_payout('60000000-0000-4000-8000-00000000cf01')->>'error'='NOT_FOUND',
 'direção de outro tenant não registra pagamento');
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000cf06"}';
select pg_temp.assert_true(not (public.confirm_teacher_payout('60000000-0000-4000-8000-00000000cf01')->>'ok')::boolean,
 'professor não confirma o próprio pagamento');
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000cf03"}';
update public.teacher_closings set total_amount=null where id='60000000-0000-4000-8000-00000000cf02';
select pg_temp.assert_true(public.confirm_teacher_payout('60000000-0000-4000-8000-00000000cf02')->>'error'='INVALID_STATE',
 'fechamento sem valor não permite baixa');
update public.teacher_closings set total_amount=105,status=null where id='60000000-0000-4000-8000-00000000cf02';
select pg_temp.assert_true(public.confirm_teacher_payout('60000000-0000-4000-8000-00000000cf02')->>'error'='INVALID_STATE',
 'fechamento sem situação não permite baixa');
select pg_temp.assert_true((select paid_at is null from public.teacher_closings
 where id='60000000-0000-4000-8000-00000000cf02'),'recusa de fechamento incompleto não grava pagamento');
update public.teacher_closings set status='PENDENTE' where id='60000000-0000-4000-8000-00000000cf02';
select pg_temp.assert_true((public.confirm_teacher_payout('60000000-0000-4000-8000-00000000cf01')->>'ok')::boolean,
 'direção registra PIX já efetuado');
select pg_temp.assert_true((select paid_at is not null and status='PAID_WAITING_NF' and payment_method='PIX_MANUAL'
 from public.teacher_closings where id='60000000-0000-4000-8000-00000000cf01'),'baixa registra data e preserva fluxo NF');
select public.confirm_teacher_payout('60000000-0000-4000-8000-00000000cf01');
update public.teacher_closings set status='UNDER_REVIEW' where id='60000000-0000-4000-8000-00000000cf01';
update public.teacher_closings set status='COMPLETED' where id='60000000-0000-4000-8000-00000000cf01';
select pg_temp.assert_true((select count(*)=1 from public.notification_queue where tenant_id='payout-notice-test'
 and notification_kind='TEACHER_PAYOUT_CONFIRMED'),'clique repetido e aprovação de NF não repetem aviso');
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_true((select (public.get_payout_confirmation_notice_snapshot(id)->>'ok')::boolean
 from public.notification_queue where tenant_id='payout-notice-test' and notification_kind='TEACHER_PAYOUT_CONFIRMED'),
 'NF aprovada preserva confirmação de pagamento já registrada');
select pg_temp.assert_true((select message_body like '%R$ 126,00%' and message_body like '%09/2026%'
 and student_phone='5511999990001' and teacher_id='00000000-0000-4000-8000-00000000cf06'
 from public.notification_queue where tenant_id='payout-notice-test' and notification_kind='TEACHER_PAYOUT_CONFIRMED'),
 'mensagem contém valor/competência e destinatário canônico');
update public.profiles set phone='11999990003' where id='00000000-0000-4000-8000-00000000cf06';
select pg_temp.assert_true((select not (public.get_payout_confirmation_notice_snapshot(id)->>'ok')::boolean
 from public.notification_queue where tenant_id='payout-notice-test' and notification_kind='TEACHER_PAYOUT_CONFIRMED'),
 'troca do telefone impede envio do financeiro ao contato antigo');
select pg_temp.assert_true((select not (public.begin_notification_delivery_submission(id,gen_random_uuid(),
 'fixture-instance',student_phone,student_phone,message_body,null,null)->>'ok')::boolean
 from public.notification_queue where tenant_id='payout-notice-test' and notification_kind='TEACHER_PAYOUT_CONFIRMED'),
 'cerca imediatamente anterior ao envio também rejeita contato alterado');
update public.profiles set phone='11999990001',is_test_account=true where id='00000000-0000-4000-8000-00000000cf06';
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000cf03"}';
select public.confirm_teacher_payout('60000000-0000-4000-8000-00000000cf02');
select pg_temp.assert_true((select count(*)=1 from public.notification_queue where tenant_id='payout-notice-test'
 and notification_kind='TEACHER_PAYOUT_CONFIRMED'),'professor fixture não gera aviso');
set local request.jwt.claims='{"role":"service_role"}';
update public.profiles set is_test_account=false where id='00000000-0000-4000-8000-00000000cf06';
set local request.jwt.claims='{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000cf03"}';
insert into public.asaas_teacher_transfer_attempts(id,tenant_id,closing_id,requested_by,status,claim_token,expected_amount,
 external_reference,destination_fingerprint,destination_pix_key,destination_pix_key_type,transfer_description,lease_expires_at)
values('70000000-0000-4000-8000-00000000cf01','payout-notice-test','60000000-0000-4000-8000-00000000cf03',
 '00000000-0000-4000-8000-00000000cf03','SUBMITTED',gen_random_uuid(),105,'fixture-payout-attempt',repeat('a',64),'fixture@example.invalid','EMAIL','Pagamento fixture',now()+interval '5 minutes');
select pg_temp.assert_true(public.confirm_teacher_payout('60000000-0000-4000-8000-00000000cf03')->>'error'='PROVIDER_RECONCILIATION_REQUIRED',
 'não permite registrar outro PIX em cima de transferência integrada');
update public.teacher_closings set status='UNDER_REVIEW',asaas_transfer_id='fixture-transfer'
 where id='60000000-0000-4000-8000-00000000cf03';
select pg_temp.assert_true((select count(*)=1 from public.notification_queue where tenant_id='payout-notice-test'
 and notification_kind='TEACHER_PAYOUT_CONFIRMED'),'transferência submetida ainda não confirma pagamento');
update public.asaas_teacher_transfer_attempts set status='COMPLETED',provider_transfer_id='fixture-transfer'
 where id='70000000-0000-4000-8000-00000000cf01';
update public.teacher_closings set status='PAID_WAITING_NF',paid_at=now()
 where id='60000000-0000-4000-8000-00000000cf03';
select pg_temp.assert_true((select count(*)=2 from public.notification_queue where tenant_id='payout-notice-test'
 and notification_kind='TEACHER_PAYOUT_CONFIRMED'),'transferência concluída produz confirmação');
insert into public.vendor_withdrawal_requests(id,tenant_id,vendor_id,amount_brl,commission_count,pix_key_snapshot)
values('80000000-0000-4000-8000-00000000cf01','payout-notice-test','00000000-0000-4000-8000-00000000cf01',21800,2,'fixture@example.invalid');
select public.set_vendor_withdrawal_status('80000000-0000-4000-8000-00000000cf01','APPROVED',null);
select pg_temp.assert_true(not exists(select 1 from public.notification_queue where tenant_id='payout-notice-test'
 and notification_kind='AFFILIATE_PAYOUT_CONFIRMED'),'aprovar saque não confirma dinheiro');
select public.set_vendor_withdrawal_status('80000000-0000-4000-8000-00000000cf01','PAID',null);
update public.vendor_withdrawal_requests set updated_at=now() where id='80000000-0000-4000-8000-00000000cf01';
select pg_temp.assert_true((select count(*)=1 from public.notification_queue where tenant_id='payout-notice-test'
 and notification_kind='AFFILIATE_PAYOUT_CONFIRMED'),'pagamento do saque produz só um aviso');
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_true((select (public.get_payout_confirmation_notice_snapshot(id)->>'ok')::boolean
 and message_body like '%R$ 218,00%' and message_body like '%2 comissão%'
 and student_phone='5511999990002' and teacher_id is null
 from public.notification_queue where tenant_id='payout-notice-test' and notification_kind='AFFILIATE_PAYOUT_CONFIRMED'),
 'confirmação privada do afiliado usa valor e telefone próprios');
update public.vendor_withdrawal_requests set status='CANCELLED' where id='80000000-0000-4000-8000-00000000cf01';
select pg_temp.assert_true((select not (public.get_payout_confirmation_notice_snapshot(id)->>'ok')::boolean
 from public.notification_queue where tenant_id='payout-notice-test' and notification_kind='AFFILIATE_PAYOUT_CONFIRMED'),
 'reversão impede confirmação de saque que deixou de estar pago');
select pg_temp.assert_true(not has_function_privilege('anon','public.confirm_teacher_payout(uuid)','EXECUTE')
 and not has_function_privilege('authenticated','public.get_payout_confirmation_notice_snapshot(uuid)','EXECUTE')
 and not has_function_privilege('service_role','private.payout_confirmation_snapshot(text,uuid)','EXECUTE'),
 'nenhuma leitura financeira privada vira API pública');
rollback;
