\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(value boolean,message text) returns void language plpgsql as $$
begin if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if; end; $$;
insert into public.tenants (id, name, slug, saas_status, school_info)
values (
  'daily-collection-test',
  'Daily Collection Test',
  'daily-collection-test',
  'active',
  jsonb_build_object(
    'legalName', 'Daily Collection Test Ltda',
    'cnpj', '04252011000110',
    'address', 'Rua do Afiliado, 100',
    'email', 'legal-affiliate@example.invalid',
    'phone', '11999999999',
    'city', 'Sao Paulo',
    'state', 'SP',
    'legalRepresentativeName', 'Representante Afiliados',
    'legalRepresentativeSignaturePath',
      'daily-collection-test/legal-representative-signature/00000000-0000-4000-8000-00000000dce1.png'
  )
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '00000000-0000-4000-8000-00000000dc01',
    'authenticated', 'authenticated', 'affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000dc02',
    'authenticated', 'authenticated', 'student-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Student Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000dc03',
    'authenticated', 'authenticated', 'director-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Director Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000dc04',
    'authenticated', 'authenticated', 'gabriela-souza@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Gabriela Souza"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000dc05',
    'authenticated', 'authenticated', 'gabriela-lima@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Gabriéla Lima"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000dc06',
    'authenticated', 'authenticated', 'teacher-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Teacher Affiliate Test"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'daily-collection-test',
       full_name = 'Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 10900,
       affiliate_code = 'PARCEIRO109',
       pix_key = 'affiliate@example.invalid',
       pix_key_type = 'EMAIL'
 where id = '00000000-0000-4000-8000-00000000dc01';
update public.profiles
   set role = 'STUDENT',
       tenant_id = 'daily-collection-test',
       full_name = 'Student Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000dc02';
update public.profiles
   set role = 'SCHOOL_ADMIN',
       tenant_id = 'daily-collection-test',
       full_name = 'Director Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000dc03';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'daily-collection-test',
       full_name = 'Gabriela Souza',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 4900,
       affiliate_code = 'afiliada10'
 where id = '00000000-0000-4000-8000-00000000dc04';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'daily-collection-test',
       full_name = 'Gabriéla Lima',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 4900,
       affiliate_code = 'GABI20'
 where id = '00000000-0000-4000-8000-00000000dc05';
update public.profiles
   set role = 'TEACHER',
       tenant_id = 'daily-collection-test',
       full_name = 'Teacher Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000dc06';
set local app.enrollment_claim = '';

insert into public.teacher_pay_tiers(tenant_id,min_students,rate)
values('daily-collection-test',1,8) on conflict(tenant_id,min_students) do update set rate=excluded.rate;
insert into public.bookings(id,tenant_id,student_id,teacher_id,day_of_week,time_slot,status,start_date)
values('20000000-0000-4000-8000-00000000dc01','daily-collection-test',
  '00000000-0000-4000-8000-00000000dc02','00000000-0000-4000-8000-00000000dc06',
  'Segunda','10:00','SCHEDULED','2026-10-01');

update public.profiles set phone='11999990001',is_test_account=false where id='00000000-0000-4000-8000-00000000dc06';
update public.profiles set phone='11999990002',is_test_account=false where id='00000000-0000-4000-8000-00000000dc01';

set local request.jwt.claims='{"role":"service_role"}';
set local app.enrollment_claim='1';
update public.profiles set contract_accepted=true,asaas_customer_id='cus_daily_fixture',subscription_id='sub_daily_fixture',is_test_account=false where id='00000000-0000-4000-8000-00000000dc02';
set local app.enrollment_claim='';
update auth.users set email_confirmed_at=now() where id in ('00000000-0000-4000-8000-00000000dc02','00000000-0000-4000-8000-00000000dc06');
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,provider_status,due_date,provider_customer_id,authoritative_subscription_id,payment_type)
values('30000000-0000-4000-8000-00000000dc01','daily-collection-test','00000000-0000-4000-8000-00000000dc02','pay_daily_fixture',187,'OVERDUE','OVERDUE',(now() at time zone 'America/Sao_Paulo')::date-22,'cus_daily_fixture','sub_daily_fixture','SUBSCRIPTION');
select pg_temp.assert_true(not private.daily_collection_allowed('30000000-0000-4000-8000-00000000dc01','daily-collection-test','00000000-0000-4000-8000-00000000dc02'),'sem opt-in não cobra');
insert into public.daily_payment_collection_settings(tenant_id,enabled) values('daily-collection-test',true);
select pg_temp.assert_true(private.daily_collection_allowed('30000000-0000-4000-8000-00000000dc01','daily-collection-test','00000000-0000-4000-8000-00000000dc02'),'aluno ativo com agenda e fatura vencida elegível');
select pg_temp.assert_true(not private.daily_collection_allowed('30000000-0000-4000-8000-00000000dc01','other-tenant','00000000-0000-4000-8000-00000000dc02'),'outro tenant bloqueado');
insert into public.daily_payment_email_attempts(tenant_id,payment_id,student_id,campaign_date,recipient_email,provider_idempotency_key,status)
select 'daily-collection-test','30000000-0000-4000-8000-00000000dc01',id,(now() at time zone 'America/Sao_Paulo')::date,email,'fixture-mail-daily','SUBMITTING' from public.profiles where id='00000000-0000-4000-8000-00000000dc02';
do $$ begin
  begin
    insert into public.daily_payment_email_attempts(tenant_id,payment_id,student_id,campaign_date,recipient_email,provider_idempotency_key,status)
    select 'daily-collection-test','30000000-0000-4000-8000-00000000dc01',id,(now() at time zone 'America/Sao_Paulo')::date,email,'fixture-mail-duplicate','SUBMITTING' from public.profiles where id='00000000-0000-4000-8000-00000000dc02';
    raise exception 'duplicate daily email allowed';
  exception when unique_violation then null; end;
end $$;
update public.student_payments set status='RECEIVED',provider_status='RECEIVED' where id='30000000-0000-4000-8000-00000000dc01';
select pg_temp.assert_true(not private.daily_collection_allowed('30000000-0000-4000-8000-00000000dc01','daily-collection-test','00000000-0000-4000-8000-00000000dc02'),'pagou sai da cobrança');
update public.student_payments set status='OVERDUE',provider_status='OVERDUE',exclusion_reason='PROVIDER_DELETED' where id='30000000-0000-4000-8000-00000000dc01';
select pg_temp.assert_true(not private.daily_collection_allowed('30000000-0000-4000-8000-00000000dc01','daily-collection-test','00000000-0000-4000-8000-00000000dc02'),'cobrança excluída sai');
update public.student_payments set exclusion_reason=null where id='30000000-0000-4000-8000-00000000dc01';
update public.profiles set is_test_account=true where id='00000000-0000-4000-8000-00000000dc02';
select pg_temp.assert_true(not private.daily_collection_allowed('30000000-0000-4000-8000-00000000dc01','daily-collection-test','00000000-0000-4000-8000-00000000dc02'),'conta teste suprimida');
update public.profiles set is_test_account=false where id='00000000-0000-4000-8000-00000000dc02';
-- Dependente: e-mail pessoal não substitui o destinatário financeiro.
delete from public.daily_payment_email_attempts where tenant_id='daily-collection-test';
update public.profiles set guardian_id='00000000-0000-4000-8000-00000000dc06',guardian_email=(select email from public.profiles where id='00000000-0000-4000-8000-00000000dc06') where id='00000000-0000-4000-8000-00000000dc02';
do $$ begin
  begin
    insert into public.daily_payment_email_attempts(tenant_id,payment_id,student_id,campaign_date,recipient_email,provider_idempotency_key,status)
    select 'daily-collection-test','30000000-0000-4000-8000-00000000dc01',id,(now() at time zone 'America/Sao_Paulo')::date,email,'fixture-mail-child','SUBMITTING' from public.profiles where id='00000000-0000-4000-8000-00000000dc02';
    raise exception 'child email bypassed financial guardian';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'daily_collection_recipient_email_unverified' then raise; end if;
  end;
end $$;
insert into public.daily_payment_email_attempts(tenant_id,payment_id,student_id,campaign_date,recipient_email,provider_idempotency_key,status)
select 'daily-collection-test','30000000-0000-4000-8000-00000000dc01','00000000-0000-4000-8000-00000000dc02',(now() at time zone 'America/Sao_Paulo')::date,email,'fixture-mail-guardian','SUBMITTING' from public.profiles where id='00000000-0000-4000-8000-00000000dc06';
-- WhatsApp: somente o dia atual e a fonte ativa passam à fase irreversível.
insert into public.asaas_outbound_message_attempts(tenant_id,student_id,provider_entity_id,notification_kind,status,claim_token,lease_expires_at)
values('daily-collection-test','00000000-0000-4000-8000-00000000dc02','30000000-0000-4000-8000-00000000dc01',
 'PAYMENT_OVERDUE_DAILY_'||to_char(now() at time zone 'America/Sao_Paulo','YYYYMMDD'),'CLAIMED',gen_random_uuid(),now()+interval '5 minutes');
update public.tenants set whatsapp_enabled=true where id='daily-collection-test';
insert into public.tenant_admin_settings(tenant_id,student_notifications_enabled) values('daily-collection-test',true)
 on conflict(tenant_id) do update set student_notifications_enabled=true;
update public.asaas_outbound_message_attempts set status='SUBMITTING' where tenant_id='daily-collection-test';
select pg_temp.assert_true((select count(*)=1 from public.asaas_outbound_message_attempts where tenant_id='daily-collection-test' and status='SUBMITTING'),'aviso de hoje pode ser submetido');
do $$ begin
 begin
  insert into public.asaas_outbound_message_attempts(tenant_id,student_id,provider_entity_id,notification_kind,status,claim_token,lease_expires_at)
  values('daily-collection-test','00000000-0000-4000-8000-00000000dc02','30000000-0000-4000-8000-00000000dc01',
   'PAYMENT_OVERDUE_DAILY_'||to_char((now() at time zone 'America/Sao_Paulo')::date-1,'YYYYMMDD'),'SUBMITTING',gen_random_uuid(),now());
  raise exception 'wrong daily WhatsApp date allowed';
 exception when sqlstate 'P0001' then if sqlerrm<>'daily_collection_whatsapp_blocked' then raise; end if; end;
end $$;
select pg_temp.assert_true(not has_table_privilege('authenticated','public.daily_payment_email_attempts','SELECT'),'e-mail não exposto ao aluno');
select pg_temp.assert_true(not has_table_privilege('anon','public.daily_payment_collection_settings','INSERT'),'anônimo não habilita cobrança');
rollback;
