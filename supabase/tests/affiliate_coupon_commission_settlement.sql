-- Modelo híbrido de afiliados: o cupom é a atribuição (o aluno digita na
-- página de matrícula ou a escola põe no link manual, pelo cupom ou pelo
-- nome), a comissão só é liberada na liquidação da primeira mensalidade, e
-- reserva, painel, PIX e saque dividem um livro de comissões idempotente.

\set ON_ERROR_STOP on

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
grant execute on function pg_temp.assert_true(boolean, text)
  to anon, authenticated, service_role;

-- ── Fronteiras ──────────────────────────────────────────────────────────────

select pg_temp.assert_true(
  not has_function_privilege(
    'anon', 'public.apply_affiliate_coupon(uuid,text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.apply_affiliate_coupon(uuid,text)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.apply_affiliate_coupon(uuid,text)', 'EXECUTE'
  ),
  'coupon mutation escaped the server-only boundary'
);

select pg_temp.assert_true(
  not has_table_privilege(
    'anon', 'public.vendor_withdrawal_requests', 'SELECT,INSERT,UPDATE,DELETE'
  )
  and not has_table_privilege(
    'authenticated', 'public.vendor_withdrawal_requests', 'SELECT,INSERT,UPDATE,DELETE'
  ),
  'withdrawal rows are directly exposed through the Data API'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from pg_catalog.pg_trigger as trigger
     where trigger.tgrelid = 'public.student_payments'::pg_catalog.regclass
       and trigger.tgname = 'trg_confirm_commission_on_payment'
       and not trigger.tgisinternal
  ),
  'legacy student-wide commission confirmation trigger is still active'
);

select pg_temp.assert_true(
  has_function_privilege('authenticated', 'public.get_my_affiliate_panel()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_my_affiliate_pix(text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.find_affiliates(text,text)', 'EXECUTE')
  and has_function_privilege(
    'authenticated', 'public.create_affiliate_invite(integer,text,text)', 'EXECUTE'
  )
  and not has_function_privilege('anon', 'public.get_my_affiliate_panel()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_my_affiliate_pix(text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.find_affiliates(text,text)', 'EXECUTE')
  and not has_function_privilege(
    'anon', 'public.create_affiliate_invite(integer,text,text)', 'EXECUTE'
  ),
  'affiliate RPCs have the wrong audience'
);

-- A porta com cupom fica ao lado da cadeia de create_enrollment_offer (as
-- auditorias leem o texto-fonte de cada camada da cadeia).
select pg_temp.assert_true(
  has_function_privilege(
    'authenticated', 'public.create_enrollment_offer_with_affiliate(jsonb,text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.create_enrollment_offer_with_affiliate(jsonb,text)', 'EXECUTE'
  )
  and exists (
    select 1
      from pg_catalog.pg_trigger as trigger
     where trigger.tgrelid = 'public.offers'::pg_catalog.regclass
       and trigger.tgname = 'trg_block_salesperson_enrollment_offer'
       and not trigger.tgisinternal
  )
  and not has_function_privilege(
    'authenticated', 'private.grant_affiliate_benefit(uuid,uuid,text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'private.affiliate_referral_view(uuid)', 'EXECUTE'
  ),
  'the affiliate guard on enrollment offers can be bypassed'
);

-- ── Escola, afiliados, aluno, diretor e professora ──────────────────────────

insert into public.tenants (id, name, slug, saas_status, school_info)
values (
  'affiliate-coupon-test',
  'Affiliate Coupon Test',
  'affiliate-coupon-test',
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
      'affiliate-coupon-test/legal-representative-signature/00000000-0000-4000-8000-00000000afe1.png'
  )
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '00000000-0000-4000-8000-00000000af01',
    'authenticated', 'authenticated', 'affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000af02',
    'authenticated', 'authenticated', 'student-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Student Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000af03',
    'authenticated', 'authenticated', 'director-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Director Affiliate Test"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000af04',
    'authenticated', 'authenticated', 'gabriela-souza@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Gabriela Souza"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000af05',
    'authenticated', 'authenticated', 'gabriela-lima@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Gabriéla Lima"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000af06',
    'authenticated', 'authenticated', 'teacher-affiliate@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Teacher Affiliate Test"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'affiliate-coupon-test',
       full_name = 'Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 10900,
       affiliate_code = 'PARCEIRO109',
       pix_key = 'affiliate@example.invalid',
       pix_key_type = 'EMAIL'
 where id = '00000000-0000-4000-8000-00000000af01';
update public.profiles
   set role = 'STUDENT',
       tenant_id = 'affiliate-coupon-test',
       full_name = 'Student Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000af02';
update public.profiles
   set role = 'SCHOOL_ADMIN',
       tenant_id = 'affiliate-coupon-test',
       full_name = 'Director Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000af03';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'affiliate-coupon-test',
       full_name = 'Gabriela Souza',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 4900,
       affiliate_code = 'afiliada10'
 where id = '00000000-0000-4000-8000-00000000af04';
update public.profiles
   set role = 'SALESPERSON',
       tenant_id = 'affiliate-coupon-test',
       full_name = 'Gabriéla Lima',
       status = 'Ativo',
       lifecycle_status = 'active',
       commission_rate = 4900,
       affiliate_code = 'GABI20'
 where id = '00000000-0000-4000-8000-00000000af05';
update public.profiles
   set role = 'TEACHER',
       tenant_id = 'affiliate-coupon-test',
       full_name = 'Teacher Affiliate Test',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000af06';
set local app.enrollment_claim = '';

select pg_temp.assert_true(
  (
    select profile.affiliate_code = 'AFILIADA10'
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000af04'
  ),
  'affiliate code was not normalized to upper case'
);

insert into public.teacher_availability (
  id, teacher_id, day_of_week, start_time, tenant_id
) values
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000af06', 1, '10:00', 'affiliate-coupon-test'),
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000af06', 3, '10:00', 'affiliate-coupon-test');

-- ── Cupom digitado pelo aluno ───────────────────────────────────────────────

insert into public.offers (
  id, kind, tenant_id, payload, metadata, expires_at, created_by,
  requires_enrollment, enrollment_fee, processing_state,
  invite_security_version
) values (
  '10000000-0000-4000-8000-00000000af01',
  'ENROLLMENT',
  'affiliate-coupon-test',
  '{"value":499,"planDuration":12,"classesPerWeek":2,"dueDay":10,"enrollmentFee":49}'::jsonb,
  '{}'::jsonb,
  now() + interval '1 day',
  '00000000-0000-4000-8000-00000000af03',
  true,
  49,
  'NOT_STARTED',
  1
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  public.apply_affiliate_coupon(
    '10000000-0000-4000-8000-00000000af01',
    'parceiro109'
  ) ->> 'ok' = 'true',
  'valid affiliate coupon was rejected'
);
select pg_temp.assert_true(
  (
    public.apply_affiliate_coupon(
      '10000000-0000-4000-8000-00000000af01',
      'PARCEIRO109'
    ) ->> 'already_applied'
  ) = 'true',
  'retyping the same coupon was not idempotent'
);
select pg_temp.assert_true(
  public.apply_affiliate_coupon(
    '10000000-0000-4000-8000-00000000af01',
    'AFILIADA10'
  ) ->> 'error' = 'AFFILIATE_ALREADY_ATTRIBUTED',
  'a second coupon took over an attributed enrollment'
);
reset role;

select pg_temp.assert_true(
  (
    select offer.vendor_id = '00000000-0000-4000-8000-00000000af01'
       and offer.enrollment_fee = 0
       and (offer.payload ->> 'enrollmentFee')::numeric = 0
       and (offer.metadata ->> 'affiliate_commission_cents')::integer = 10900
       and offer.metadata ->> 'affiliate_attribution' = 'COUPON'
      from public.offers as offer
     where offer.id = '10000000-0000-4000-8000-00000000af01'
  ),
  'coupon did not atomically waive the fee and snapshot the commission'
);

update public.offers
   set processing_by = '00000000-0000-4000-8000-00000000af02',
       processing_state = 'AWAITING_PAYMENT',
       processing_started_at = now()
 where id = '10000000-0000-4000-8000-00000000af01';

select pg_temp.assert_true(
  (
    select commission.status = 'PENDING'
       and commission.amount_brl = 10900
      from public.vendor_commissions as commission
     where commission.offer_id = '10000000-0000-4000-8000-00000000af01'
  ),
  'commission was not reserved as pending when the offer was claimed'
);

-- Painel: matrícula começada, mensalidade ainda não paga.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af01","role":"authenticated"}';
select pg_temp.assert_true(
  (
    select panel -> 'referrals' -> 0 ->> 'stage' = 'AGUARDANDO_PAGAMENTO'
       and panel -> 'referrals' -> 0 ->> 'student_display' = 'Student T.'
       and (panel -> 'totals' ->> 'waiting_payment')::integer = 1
       and (panel -> 'totals' ->> 'pending_cents')::integer = 10900
       and (panel -> 'totals' ->> 'available_cents')::integer = 0
       and panel -> 'affiliate' ->> 'affiliate_code' = 'PARCEIRO109'
      from (select public.get_my_affiliate_panel() as panel) as snapshot
  ),
  'panel did not show the referral waiting for the first payment'
);
reset role;

-- Cartão aprovado, dinheiro ainda não caiu: em liquidação, com data prevista.
insert into public.student_payments (
  student_id, tenant_id, asaas_payment_id, value, status, due_date,
  billing_type, payment_type, description, estimated_credit_at
) values (
  '00000000-0000-4000-8000-00000000af02',
  'affiliate-coupon-test',
  'pay_affiliate_test_first_month',
  499,
  'CONFIRMED',
  current_date + 3,
  'CREDIT_CARD',
  'SUBSCRIPTION',
  'Mensalidade',
  now() + interval '30 days'
);
update public.offers
   set metadata = metadata || '{"subscription_activation_payment_id":"pay_affiliate_test_first_month"}'::jsonb
 where id = '10000000-0000-4000-8000-00000000af01';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af01","role":"authenticated"}';
select pg_temp.assert_true(
  (
    select panel -> 'referrals' -> 0 ->> 'stage' = 'EM_LIQUIDACAO'
       and panel -> 'referrals' -> 0 -> 'first_payment' ->> 'billing_type' = 'CREDIT_CARD'
       and panel -> 'referrals' -> 0 -> 'first_payment' ->> 'estimated_credit_on' is not null
       and (panel -> 'totals' ->> 'settling')::integer = 1
       and (panel -> 'totals' ->> 'available_cents')::integer = 0
      from (select public.get_my_affiliate_panel() as panel) as snapshot
  ),
  'an approved card that has not settled was not shown as settling'
);
reset role;

-- In production only complete_enrollment_offer can make this transition, and
-- that RPC first proves a persisted PAYMENT_RECEIVED/RECEIVED_IN_CASH event.
update public.offers
   set processing_state = 'COMPLETED',
       consumed_by = '00000000-0000-4000-8000-00000000af02',
       consumed_at = now(),
       processing_completed_at = now()
 where id = '10000000-0000-4000-8000-00000000af01';

select pg_temp.assert_true(
  (
    select commission.status = 'CONFIRMED'
       and commission.confirmed_at is not null
      from public.vendor_commissions as commission
     where commission.offer_id = '10000000-0000-4000-8000-00000000af01'
  ),
  'settled enrollment did not release the commission'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af01","role":"authenticated"}';
select pg_temp.assert_true(
  (
    select panel -> 'referrals' -> 0 ->> 'stage' = 'DISPONIVEL'
       and (panel -> 'totals' ->> 'available_cents')::integer = 10900
       and (panel -> 'totals' ->> 'pending_cents')::integer = 0
      from (select public.get_my_affiliate_panel() as panel) as snapshot
  ),
  'released commission is not available in the panel'
);
reset role;

-- Commission ledgers store cents, while the finance RPC returns BRL.
update public.vendor_commissions
   set status = 'PAID', paid_at = now()
 where offer_id = '10000000-0000-4000-8000-00000000af01';
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af01","role":"authenticated"}';
select pg_temp.assert_true(
  (
    public.get_cashflow_unchecked(to_char(current_date, 'YYYY-MM'))
      -> 'saidas' ->> 'vendedores'
  )::numeric = 109,
  'cashflow exposed commission cents as BRL'
);
update public.vendor_commissions
   set status = 'CONFIRMED', paid_at = null
 where offer_id = '10000000-0000-4000-8000-00000000af01';

-- A direção vê reais no alerta e a etapa de cada indicação na ficha.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af03","role":"authenticated"}';
select pg_temp.assert_true(
  exists (
    select 1
      from public.list_vendors_overview() as vendor
     where vendor.vendor_id = '00000000-0000-4000-8000-00000000af01'
       and pg_catalog.array_to_string(vendor.alert_reasons, ' | ')
         ~ 'A pagar: R\$ 109[.,]00'
  ),
  'director alert formatted commission cents as BRL'
);
select pg_temp.assert_true(
  (
    select overview -> 'profile' ->> 'affiliate_code' = 'PARCEIRO109'
       and overview -> 'commissions' -> 0 ->> 'stage' = 'DISPONIVEL'
       and overview -> 'commissions' -> 0 ->> 'student' = 'Student Affiliate Test'
      from (
        select public.get_vendor_overview('00000000-0000-4000-8000-00000000af01')
          as overview
      ) as snapshot
  ),
  'director record lacks the coupon or the referral stage'
);
reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af01","role":"authenticated"}';
select pg_temp.assert_true(
  public.request_vendor_withdrawal() ->> 'ok' = 'true',
  'affiliate could not request the available balance'
);
select pg_temp.assert_true(
  (
    select panel -> 'referrals' -> 0 ->> 'stage' = 'EM_SAQUE'
       and (panel -> 'totals' ->> 'requested_cents')::integer = 10900
       and jsonb_array_length(panel -> 'withdrawals') = 1
      from (select public.get_my_affiliate_panel() as panel) as snapshot
  ),
  'requested withdrawal is not reflected in the panel'
);
reset role;

select pg_temp.assert_true(
  (
    select commission.withdrawal_request_id is not null
      from public.vendor_commissions as commission
     where commission.offer_id = '10000000-0000-4000-8000-00000000af01'
  ) and (
    select request.amount_brl = 10900 and request.status = 'PENDING'
      from public.vendor_withdrawal_requests as request
     where request.vendor_id = '00000000-0000-4000-8000-00000000af01'
  ),
  'withdrawal did not reserve the exact confirmed commission'
);

-- A provider refund reopens the offer.  An unpaid request must be cancelled
-- and the commission must leave the withdrawable balance.
update public.offers
   set processing_state = 'AWAITING_PAYMENT',
       processing_completed_at = null
 where id = '10000000-0000-4000-8000-00000000af01';

select pg_temp.assert_true(
  (
    select commission.status = 'PENDING'
       and commission.withdrawal_request_id is null
      from public.vendor_commissions as commission
     where commission.offer_id = '10000000-0000-4000-8000-00000000af01'
  ) and (
    select request.status = 'CANCELLED'
      from public.vendor_withdrawal_requests as request
     where request.vendor_id = '00000000-0000-4000-8000-00000000af01'
  ),
  'refund left the affiliate balance withdrawable'
);

-- ── Aula avulsa não gera comissão ───────────────────────────────────────────

-- Inserção direta como serviço: a sessão ainda carrega a identidade da
-- afiliada, e trg_block_salesperson_enrollment_offer (corretamente) barraria.
set local request.jwt.claims = '{"role":"service_role"}';
insert into public.offers (
  id, kind, tenant_id, payload, metadata, expires_at, created_by,
  requires_enrollment, enrollment_fee, processing_state, vendor_id,
  invite_security_version
) values (
  '10000000-0000-4000-8000-00000000af02',
  'ENROLLMENT',
  'affiliate-coupon-test',
  '{"value":80,"planDuration":0,"classesPerWeek":1,"dueDay":10}'::jsonb,
  '{}'::jsonb,
  now() + interval '1 day',
  '00000000-0000-4000-8000-00000000af03',
  false,
  0,
  'NOT_STARTED',
  '00000000-0000-4000-8000-00000000af04',
  1
);
update public.offers
   set processing_by = '00000000-0000-4000-8000-00000000af02',
       processing_state = 'AWAITING_PAYMENT'
 where id = '10000000-0000-4000-8000-00000000af02';
select pg_temp.assert_true(
  not exists (
    select 1
      from public.vendor_commissions as commission
     where commission.offer_id = '10000000-0000-4000-8000-00000000af02'
  ),
  'a single-class purchase created an affiliate commission'
);

-- ── PIX do afiliado ─────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af01","role":"authenticated"}';
select pg_temp.assert_true(
  public.set_my_affiliate_pix('123.456.789-09', 'cpf') ->> 'pix_key' = '12345678909',
  'affiliate could not register a CPF PIX key'
);
select pg_temp.assert_true(
  public.set_my_affiliate_pix('123', 'CPF') ->> 'error' = 'INVALID_PIX',
  'a malformed PIX key was accepted'
);
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af02","role":"authenticated"}';
select pg_temp.assert_true(
  public.set_my_affiliate_pix('123.456.789-09', 'CPF') ->> 'error' = 'FORBIDDEN',
  'a non-affiliate used the affiliate PIX door'
);
reset role;

select pg_temp.assert_true(
  (
    select profile.pix_key = '12345678909'
       and profile.pix_key_type::text = 'CPF'
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000af01'
  ),
  'affiliate PIX key was not stored'
);

-- ── A escola acha o afiliado pelo cupom ou pelo nome ────────────────────────

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af03","role":"authenticated"}';
select pg_temp.assert_true(
  jsonb_array_length(public.find_affiliates('gabriela')) = 2
  and jsonb_array_length(public.find_affiliates('Gabriéla')) = 2,
  'two affiliates with the same first name were not both listed'
);
select pg_temp.assert_true(
  (
    select found -> 0 ->> 'vendor_id' = '00000000-0000-4000-8000-00000000af04'
       and jsonb_array_length(found) = 1
      from (select public.find_affiliates('gabriela souza') as found) as snapshot
  ),
  'a unique affiliate name did not resolve to one affiliate'
);
select pg_temp.assert_true(
  (
    select found -> 0 ->> 'vendor_id' = '00000000-0000-4000-8000-00000000af04'
       and found -> 0 ->> 'match' = 'CODE'
       and (found -> 0 ->> 'commission_cents')::integer = 4900
      from (select public.find_affiliates(' afiliada10 ') as found) as snapshot
  ),
  'an exact coupon did not come first'
);
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af01","role":"authenticated"}';
select pg_temp.assert_true(
  public.find_affiliates('gabriela') = '[]'::jsonb,
  'an affiliate could list other affiliates'
);
reset role;

-- ── Convite de afiliado com o cupom já escolhido ────────────────────────────

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af03","role":"authenticated"}';
select set_config(
  'affiliate_test.invite_id',
  public.create_affiliate_invite(4900, 'Nova Parceira', 'nova-parceira')::text,
  true
);
do $invite_checks$
begin
  begin
    perform public.create_affiliate_invite(4900, 'Outra Pessoa', 'NOVA-PARCEIRA');
    raise exception 'assertion failed: a reserved coupon was offered again';
  exception when unique_violation then
    null;
  end;
  begin
    perform public.create_affiliate_invite(4900, 'Outra Pessoa', 'AFILIADA10');
    raise exception 'assertion failed: an affiliate coupon was offered again';
  exception when unique_violation then
    null;
  end;
  begin
    perform public.create_affiliate_invite(4900, 'Outra Pessoa', 'x!');
    raise exception 'assertion failed: a malformed coupon was accepted';
  exception when sqlstate '22023' then
    null;
  end;
end;
$invite_checks$;
reset role;

select pg_temp.assert_true(
  (
    select invite.payload ->> 'affiliateCode' = 'NOVA-PARCEIRA'
       and invite.payload ->> 'schoolName' = 'Affiliate Coupon Test'
       and (invite.payload ->> 'commissionRate')::integer = 4900
       and invite.kind = 'VENDOR_INVITE'
      from public.offers as invite
     where invite.id = current_setting('affiliate_test.invite_id')::uuid
  ),
  'invite did not carry the chosen coupon'
);

-- ── Link manual da escola com cupom ─────────────────────────────────────────

select set_config(
  'affiliate_test.start_date',
  to_char((now() at time zone 'America/Sao_Paulo')::date + 7, 'YYYY-MM-DD'),
  true
);
select set_config(
  'affiliate_test.billing_month',
  to_char(
    date_trunc('month', (now() at time zone 'America/Sao_Paulo')::date + 7)
      + interval '1 month',
    'YYYY-MM'
  ),
  true
);

create or replace function pg_temp.affiliate_test_payload(
  p_request_id text,
  p_duration integer default 12
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'unitId', 'affiliate-coupon-test',
    'value', 299,
    'dueDay', 10,
    'planDuration', p_duration,
    'classesPerWeek', 2,
    'enrollmentFee', 49,
    'professorId', '00000000-0000-4000-8000-00000000af06',
    'startDate', current_setting('affiliate_test.start_date'),
    'billingStartMonth', current_setting('affiliate_test.billing_month'),
    'schedule', jsonb_build_array(
      jsonb_build_object(
        'day', 'Monday', 'time', '10:00',
        'teacherId', '00000000-0000-4000-8000-00000000af06'
      ),
      jsonb_build_object(
        'day', 'Wednesday', 'time', '10:00',
        'teacherId', '00000000-0000-4000-8000-00000000af06'
      )
    ),
    'requestId', p_request_id
  );
$$;
grant execute on function pg_temp.affiliate_test_payload(text, integer)
  to authenticated;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af03","role":"authenticated"}';
do $staff_link_checks$
begin
  -- Cupom inexistente desfaz o link inteiro (nenhuma oferta sobra).
  begin
    perform public.create_enrollment_offer_with_affiliate(
      pg_temp.affiliate_test_payload('6c1a4d2e-0b7f-4e6a-9c3d-1a2b3c4d5e01'),
      'NAOEXISTE'
    );
    raise exception 'assertion failed: an unknown coupon created a link';
  exception when sqlstate '22023' then
    if sqlerrm not like 'cupom de afiliado invalido%' then
      raise exception 'assertion failed: unknown coupon failed for another reason: %', sqlerrm;
    end if;
  end;
end;
$staff_link_checks$;
select set_config(
  'affiliate_test.staff_offer_id',
  public.create_enrollment_offer_with_affiliate(
    pg_temp.affiliate_test_payload('6c1a4d2e-0b7f-4e6a-9c3d-1a2b3c4d5e02'),
    ' afiliada10 '
  )::text,
  true
);
reset role;

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.offers as offer
     where offer.tenant_id = 'affiliate-coupon-test'
       and offer.kind = 'ENROLLMENT'
       and offer.created_by = '00000000-0000-4000-8000-00000000af03'
       and offer.id not in (
         '10000000-0000-4000-8000-00000000af01',
         '10000000-0000-4000-8000-00000000af02'
       )
  ),
  'a rejected coupon left an orphan enrollment link behind'
);
select pg_temp.assert_true(
  (
    select offer.vendor_id = '00000000-0000-4000-8000-00000000af04'
       and offer.enrollment_fee = 0
       and (offer.payload ->> 'enrollmentFee')::numeric = 0
       and (offer.payload ->> 'affiliateCouponApplied')::boolean
       and offer.metadata ->> 'affiliate_attribution' = 'COUPON_STAFF'
       and (offer.metadata ->> 'affiliate_commission_cents')::integer = 4900
      from public.offers as offer
     where offer.id = current_setting('affiliate_test.staff_offer_id')::uuid
  ),
  'the manual link did not carry the affiliate benefit'
);

-- O aluno repetindo o cupom no link que já veio com ele: confirma, não troca.
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  public.apply_affiliate_coupon(
    current_setting('affiliate_test.staff_offer_id')::uuid,
    'AFILIADA10'
  ) ->> 'ok' = 'true'
  and public.apply_affiliate_coupon(
    current_setting('affiliate_test.staff_offer_id')::uuid,
    'PARCEIRO109'
  ) ->> 'error' = 'AFFILIATE_ALREADY_ATTRIBUTED',
  'the student could swap the affiliate of a manual link'
);
reset role;

-- ── Afiliado não gera link de matrícula ─────────────────────────────────────

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000af01","role":"authenticated"}';
do $affiliate_link_check$
begin
  begin
    perform public.create_enrollment_offer(
      pg_temp.affiliate_test_payload('6c1a4d2e-0b7f-4e6a-9c3d-1a2b3c4d5e03')
    );
    raise exception 'assertion failed: an affiliate created an enrollment link';
  exception when insufficient_privilege then
    null;
  end;
end;
$affiliate_link_check$;
reset role;

rollback;
