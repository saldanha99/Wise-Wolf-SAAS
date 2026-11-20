\set ON_ERROR_STOP on
-- Comissão retroativa da direção: libera só quando a PRIMEIRA mensalidade marcada é liquidada.
begin;
create function pg_temp.assert_true(value boolean,message text) returns void language plpgsql as $$
begin if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if; end; $$;

insert into public.tenants (id, name, slug, saas_status)
values ('retro-affiliate-test', 'Retro Affiliate Test', 'retro-affiliate-test', 'active');

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000ae001','authenticated','authenticated','retro-affiliate@example.invalid',
   '{"provider":"email","providers":["email"]}','{"full_name":"Retro Affiliate"}',now(),now()),
  ('00000000-0000-4000-8000-0000000ae002','authenticated','authenticated','retro-student@example.invalid',
   '{"provider":"email","providers":["email"]}','{"full_name":"Retro Student"}',now(),now()),
  ('00000000-0000-4000-8000-0000000ae003','authenticated','authenticated','retro-director@example.invalid',
   '{"provider":"email","providers":["email"]}','{"full_name":"Retro Director"}',now(),now()),
  ('00000000-0000-4000-8000-0000000ae004','authenticated','authenticated','retro-other@example.invalid',
   '{"provider":"email","providers":["email"]}','{"full_name":"Other Affiliate"}',now(),now());

set local app.enrollment_claim = '1';
update public.profiles set role='SALESPERSON', tenant_id='retro-affiliate-test', full_name='Retro Affiliate',
  status='Ativo', lifecycle_status='active', commission_rate=10900
 where id='00000000-0000-4000-8000-0000000ae001';
update public.profiles set role='STUDENT', tenant_id='retro-affiliate-test', full_name='Retro Student',
  status='Ativo', lifecycle_status='active'
 where id='00000000-0000-4000-8000-0000000ae002';
update public.profiles set role='SCHOOL_ADMIN', tenant_id='retro-affiliate-test', full_name='Retro Director',
  status='Ativo', lifecycle_status='active'
 where id='00000000-0000-4000-8000-0000000ae003';
update public.profiles set role='SALESPERSON', tenant_id='retro-affiliate-test', full_name='Other Affiliate',
  status='Ativo', lifecycle_status='active', commission_rate=4900
 where id='00000000-0000-4000-8000-0000000ae004';
set local app.enrollment_claim = '';

-- Oferta concluída SEM vendor_id (atribuição retroativa) e comissão PENDING, como em produção.
insert into public.offers(id,kind,tenant_id,payload,metadata,expires_at,created_by,
  processing_by,processing_started_at,requires_enrollment,enrollment_fee,processing_state,invite_security_version,vendor_id)
values
 ('10000000-0000-4000-8000-0000000ae001','ENROLLMENT','retro-affiliate-test','{"value":100}',
  jsonb_build_object('affiliate_attribution','DIRECTOR_RETROACTIVE',
    'affiliate_retroactive_vendor_id','00000000-0000-4000-8000-0000000ae001',
    'affiliate_first_monthly_payment_id','pay_retro_first'),
  now()+interval '1 day','00000000-0000-4000-8000-0000000ae003','00000000-0000-4000-8000-0000000ae002',now(),
  true,0,'NOT_STARTED',1,null);
insert into public.vendor_commissions(id,vendor_id,student_id,tenant_id,offer_id,amount_brl,status)
values('30000000-0000-4000-8000-0000000ae001','00000000-0000-4000-8000-0000000ae001',
 '00000000-0000-4000-8000-0000000ae002','retro-affiliate-test','10000000-0000-4000-8000-0000000ae001',10900,'PENDING');

-- 1) A taxa de matrícula liquidada não libera nada.
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,due_date,description)
values('40000000-0000-4000-8000-0000000ae001','retro-affiliate-test','00000000-0000-4000-8000-0000000ae002',
 'pay_retro_fee',49.9,'RECEIVED','2026-10-01','Taxa de matrícula');
select pg_temp.assert_true(
  (select status from public.vendor_commissions where id='30000000-0000-4000-8000-0000000ae001')='PENDING',
  'taxa de matrícula não libera comissão retroativa');

-- 2) A primeira mensalidade ainda pendente não libera.
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,due_date,description)
values('40000000-0000-4000-8000-0000000ae002','retro-affiliate-test','00000000-0000-4000-8000-0000000ae002',
 'pay_retro_first',198,'PENDING','2026-10-30','Mensalidade');
select pg_temp.assert_true(
  (select status from public.vendor_commissions where id='30000000-0000-4000-8000-0000000ae001')='PENDING',
  'mensalidade não liquidada não libera');

-- 3) Liquidada: libera uma vez, com a data do crédito.
update public.student_payments set status='RECEIVED', credited_at='2026-10-30 15:00:00-03'
 where id='40000000-0000-4000-8000-0000000ae002';
select pg_temp.assert_true(
  (select status='CONFIRMED' and confirmed_at='2026-10-30 15:00:00-03'
     from public.vendor_commissions where id='30000000-0000-4000-8000-0000000ae001'),
  'primeira mensalidade liquidada libera a comissão com a data do crédito');

-- 4) Comissão de outro afiliado na mesma oferta não é tocada; reservada para saque também não.
insert into public.offers(id,kind,tenant_id,payload,metadata,expires_at,created_by,
  processing_by,processing_started_at,requires_enrollment,enrollment_fee,processing_state,invite_security_version,vendor_id)
values
 ('10000000-0000-4000-8000-0000000ae002','ENROLLMENT','retro-affiliate-test','{"value":100}',
  jsonb_build_object('affiliate_attribution','DIRECTOR_RETROACTIVE',
    'affiliate_retroactive_vendor_id','00000000-0000-4000-8000-0000000ae001',
    'affiliate_first_monthly_payment_id','pay_retro_second'),
  now()+interval '1 day','00000000-0000-4000-8000-0000000ae003','00000000-0000-4000-8000-0000000ae002',now(),
  true,0,'NOT_STARTED',1,null);
insert into public.vendor_commissions(id,vendor_id,student_id,tenant_id,offer_id,amount_brl,status)
values('30000000-0000-4000-8000-0000000ae002','00000000-0000-4000-8000-0000000ae004',
 '00000000-0000-4000-8000-0000000ae002','retro-affiliate-test','10000000-0000-4000-8000-0000000ae002',4900,'PENDING');
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,due_date,description)
values('40000000-0000-4000-8000-0000000ae003','retro-affiliate-test','00000000-0000-4000-8000-0000000ae002',
 'pay_retro_second',198,'RECEIVED','2026-11-30','Mensalidade');
select pg_temp.assert_true(
  (select status from public.vendor_commissions where id='30000000-0000-4000-8000-0000000ae002')='PENDING',
  'comissão de outro afiliado não é liberada');

rollback;
