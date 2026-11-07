-- Renovação pela ficha: 12 meses, pagamento integral e cobertura dos meses.
-- Roda em savepoint: nenhuma linha fica e nenhuma fila real é reivindicada.
begin;

create function pg_temp.assert_rf(ok boolean, message text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'renovação pela ficha: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_rf(boolean, text) to authenticated;

-- O calendário é o da escola: entre 21h e 24h em Brasília o UTC já está no dia seguinte.
create function pg_temp.hoje() returns date language sql stable as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;
grant execute on function pg_temp.hoje() to authenticated;

create function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;
create function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.as_owner() to authenticated;

insert into public.tenants(id, name, slug, saas_status, whatsapp_enabled) values
  ('renovacao-ficha-qa', 'Renovacao Ficha QA', 'renovacao-ficha-qa', 'active', true),
  ('renovacao-ficha-outra', 'Outra QA', 'renovacao-ficha-outra', 'active', true);
insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select id, 'authenticated', 'authenticated', email, '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', name), now(), now()
from (values
  ('7e1b0000-0000-4000-8000-000000000001'::uuid, 'rf-admin@example.invalid', 'Direcao Sintetica'),
  ('7e1b0000-0000-4000-8000-000000000002'::uuid, 'rf-other@example.invalid', 'Direcao Outra'),
  ('7e1b0000-0000-4000-8000-000000000003'::uuid, 'rf-coord@example.invalid', 'Coordenacao Sintetica'),
  ('7e1b0000-0000-4000-8000-000000000011'::uuid, 'rf-sem-contrato@example.invalid', 'Aluno  Sem Contrato'),
  ('7e1b0000-0000-4000-8000-000000000012'::uuid, 'rf-por-fora@example.invalid', 'Aluno Por Fora'),
  ('7e1b0000-0000-4000-8000-000000000013'::uuid, 'rf-assinatura@example.invalid', 'Aluno Com Assinatura'),
  ('7e1b0000-0000-4000-8000-000000000014'::uuid, 'rf-parcelado@example.invalid', 'Aluno Parcelado')
) f(id, email, name);

set local app.enrollment_claim = '1';
update public.profiles set
  tenant_id = case when id = '7e1b0000-0000-4000-8000-000000000002' then 'renovacao-ficha-outra' else 'renovacao-ficha-qa' end,
  role = case
    when id in ('7e1b0000-0000-4000-8000-000000000001', '7e1b0000-0000-4000-8000-000000000002') then 'SCHOOL_ADMIN'
    when id = '7e1b0000-0000-4000-8000-000000000003' then 'COORDINATOR'
    else 'STUDENT' end,
  status = 'Ativo', lifecycle_status = 'active'
where id in (select id from auth.users where email like 'rf-%@example.invalid');
update public.profiles set
  full_name = ' Aluno  Sem Contrato', monthly_fee = 187, class_frequency = null, due_day = 17,
  contract_accepted = false, paid_through = (pg_temp.hoje() + 100), prepaid_months = 12,
  asaas_customer_id = null, subscription_id = null, cpf = '11122233344', phone = '11999990001'
where id = '7e1b0000-0000-4000-8000-000000000011';
update public.profiles set
  monthly_fee = 229, class_frequency = '3x', due_day = 10, contract_accepted = true,
  cpf = '11122233345', phone = '11999990002'
where id = '7e1b0000-0000-4000-8000-000000000012';
update public.profiles set
  monthly_fee = 229, class_frequency = '3x', due_day = 10, contract_accepted = true,
  asaas_customer_id = 'cus_qa_rf_assinatura', subscription_id = 'sub_qa_rf_assinatura',
  asaas_subscription_status = 'ACTIVE', asaas_subscription_end_date = pg_temp.hoje() + 200,
  cpf = '11122233346', phone = '11999990003'
where id = '7e1b0000-0000-4000-8000-000000000013';
update public.profiles set
  monthly_fee = 229, class_frequency = '3x', due_day = 10, contract_accepted = true,
  asaas_customer_id = null, cpf = '11122233347', phone = '11999990004'
where id = '7e1b0000-0000-4000-8000-000000000014';
set local app.enrollment_claim = '';
insert into public.tenant_memberships(user_id, tenant_id, role, status)
select id, tenant_id, role, 'ACTIVE' from public.profiles
 where id in (select id from auth.users where email like 'rf-%@example.invalid')
on conflict do nothing;
update public.tenant_memberships set role = p.role, tenant_id = p.tenant_id, status = 'ACTIVE'
  from public.profiles p
 where p.id = tenant_memberships.user_id
   and p.id in (select id from auth.users where email like 'rf-%@example.invalid');
insert into public.student_pricing_plans(tenant_id, name, classes_per_week, fidelity_months, monthly_price, active)
values ('renovacao-ficha-qa', 'Anual 3x QA', 3, 12, 229, true);

-- ─── Quem pode ───────────────────────────────────────────────────────────────
select pg_temp.as_user('7e1b0000-0000-4000-8000-000000000002');
select pg_temp.assert_rf(public.get_student_renewal_context('7e1b0000-0000-4000-8000-000000000011') ->> 'error' = 'sem_permissao',
  'direção de outra escola leu a ficha');
select pg_temp.as_owner();
select pg_temp.as_user('7e1b0000-0000-4000-8000-000000000003');
select pg_temp.assert_rf(public.get_student_renewal_context('7e1b0000-0000-4000-8000-000000000011') ->> 'error' = 'sem_permissao',
  'coordenação não decide renovação');
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 12, 187, 3, 17,
  (pg_temp.hoje() + 100), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() + 3) ->> 'error' = 'sem_permissao', 'coordenação criou renovação');
select pg_temp.as_owner();
select pg_temp.assert_rf(not has_function_privilege('anon', 'public.create_student_renewal_offer(uuid,integer,numeric,integer,integer,date,text,text,date,date,text,text,text,boolean,uuid)', 'EXECUTE'),
  'anon pode criar renovação');
select pg_temp.assert_rf(not has_function_privilege('anon', 'public.finish_student_course_renewal_upfront_billing(uuid,uuid,text,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.finish_student_course_renewal_upfront_billing(uuid,uuid,text,text,text,text,text)', 'EXECUTE'),
  'finalização da cobrança aberta além do serviço');

-- ─── Ficha: o período atual vem do pagamento antigo ──────────────────────────
select pg_temp.as_user('7e1b0000-0000-4000-8000-000000000001');
create temporary table rf_ctx on commit drop as
  select public.get_student_renewal_context('7e1b0000-0000-4000-8000-000000000011') as j;
grant select on rf_ctx to authenticated;
select pg_temp.assert_rf((select j -> 'student' ->> 'full_name' = 'Aluno Sem Contrato' from rf_ctx), 'nome não normalizado');
select pg_temp.assert_rf((select (j -> 'period' ->> 'current_end')::date = pg_temp.hoje() + 100 and j -> 'period' ->> 'source' = 'PAID_THROUGH' from rf_ctx),
  'período atual errado');
select pg_temp.assert_rf((select (j -> 'period' ->> 'suggested_start')::date = pg_temp.hoje() + 100 from rf_ctx), 'início sugerido errado');

-- ─── Recusas do pagamento integral ───────────────────────────────────────────
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 9, 187, 3, 17,
  (pg_temp.hoje() + 100), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() + 3) ->> 'error' = 'prazo_invalido', 'prazo inválido aceito');
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 12, 187, 3, 17,
  (pg_temp.hoje() + 100), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() + 3) ->> 'error' = 'contrato_anterior_nao_informado',
  'sem contrato no sistema e sem documento passou');
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 12, 187, 3, 17,
  (pg_temp.hoje() + 100), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() + 3, null, null, 'Contrato em PDF sintetico') ->> 'error' = 'motivo_do_preco_obrigatorio',
  'preço fora do catálogo sem motivo passou');
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 12, 187, 3, 17,
  (pg_temp.hoje() + 50), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() + 3, null, null, 'Contrato em PDF sintetico', 'Direção manteve o valor') ->> 'error' = 'periodo_ja_pago',
  'renovação sobrepôs o período já pago');
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 12, 187, 3, 17,
  (pg_temp.hoje() + 100), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() - 1, null, null, 'Contrato em PDF sintetico', 'Direção manteve o valor') ->> 'error' = 'vencimento_da_cobranca_invalido',
  'cobrança vencida aceita');
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000013', 12, 229, 3, 10,
  (pg_temp.hoje() + 300), 'UPFRONT_EXTERNAL', null, null, pg_temp.hoje(), 'Comprovante sintetico') is not null, 'assinatura encerrada antes do início deve passar');
select pg_temp.as_owner();
update private.student_course_renewal_offers set status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'limpeza do teste'
 where student_id = '7e1b0000-0000-4000-8000-000000000013';
select pg_temp.as_user('7e1b0000-0000-4000-8000-000000000001');
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000013', 12, 229, 3, 10,
  (pg_temp.hoje() + 20), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() + 3) ->> 'error' = 'assinatura_ativa_no_periodo',
  'assinatura viva cobraria os mesmos meses');
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000014', 12, 229, 3, 10,
  (pg_temp.hoje() + 20), 'INSTALLMENTS', 'PIX') ->> 'error' = 'parcelada_exige_cliente_asaas',
  'parcelada sem cliente passou');

-- ─── Cobrança única: emissão, assinatura, faturamento e cobertura ────────────
create temporary table rf_offer on commit drop as
  select public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 12, 187, 3, 17,
    (pg_temp.hoje() + 100), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() + 3, null, null,
    'Contrato em PDF sintetico', 'Direção manteve o valor', true,
    '7e1b0000-0000-4000-8000-0000000000f1') as j;
grant select on rf_offer to authenticated;
select pg_temp.assert_rf((select j ->> 'ok' = 'true' and j ->> 'strategy' = 'UPFRONT_CHARGE' and (j ->> 'total_cents')::bigint = 224400 from rf_offer),
  'oferta não emitida com o total');
-- Repetir o clique devolve a mesma oferta.
select pg_temp.assert_rf((select public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 12, 187, 3, 17,
    (pg_temp.hoje() + 100), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() + 3, null, null,
    'Contrato em PDF sintetico', 'Direção manteve o valor', true,
    '7e1b0000-0000-4000-8000-0000000000f1') ->> 'offer_id' = j ->> 'offer_id' from rf_offer), 'clique repetido criou outra oferta');
-- Só uma renovação aberta por aluno.
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 6, 187, 3, 17,
    (pg_temp.hoje() + 100), 'UPFRONT_CHARGE', 'PIX', pg_temp.hoje() + 3, null, null,
    'Contrato em PDF sintetico', 'Direção manteve o valor') ->> 'error' = 'renovacao_em_aberto', 'duas renovações abertas');
select pg_temp.as_owner();

select pg_temp.assert_rf((select term_months = 12
    and last_due_date = private.renewal_last_due_date(first_due_date, 12::smallint)
    and service_end_date = public.fim_do_servico(last_due_date)
    and service_end_date = (first_due_date + interval '12 months')::date
    and upfront_total_cents = 224400 and provider_customer_id is null
    and contract_basis = 'EXTERNAL_DOCUMENT' and contract_reference = 'Contrato em PDF sintetico'
    and catalog_monthly_price = 229 and created_by = '7e1b0000-0000-4000-8000-000000000001'
    from private.student_course_renewal_offers where id = (select (j ->> 'offer_id')::uuid from rf_offer)),
  'datas ou campos congelados errados');
select pg_temp.assert_rf((select count(*) = 1 from public.student_course_renewal_notification_outbox n
   where n.offer_id = (select (j ->> 'offer_id')::uuid from rf_offer) and n.milestone = 'INITIAL' and n.status = 'PENDING'),
  'link não entrou na fila oficial');

-- Assinatura vem antes da cobrança: sem assinar, a fila de faturamento não enxerga a oferta.
select pg_temp.assert_rf((select status = 'PENDING_SIGNATURE' and billing_status = 'NOT_AUTHORIZED'
    and provider_payment_id is null and provider_customer_id is null
    from private.student_course_renewal_offers where id = (select (j ->> 'offer_id')::uuid from rf_offer)),
  'renovação sem assinatura já está liberada para cobrar');
select pg_temp.assert_rf(strpos(pg_get_functiondef('public.claim_student_course_renewal_billing(integer)'::regprocedure),
    'o.status=''SIGNED'' and o.billing_status=''PENDING''') > 0, 'a fila de faturamento deixou de exigir assinatura');
select pg_temp.assert_rf(public.retry_student_renewal_billing((select (j ->> 'offer_id')::uuid from rf_offer)) ->> 'error' = 'cobranca_sem_nova_tentativa',
  'nova tentativa de cobrança antes da assinatura');

-- A página pública mostra o que o aluno assina, com o nome limpo e sem cobrança ainda.
create temporary table rf_public on commit drop as
  select public.get_student_course_renewal_public((select j ->> 'token' from rf_offer)) as j;
select pg_temp.assert_rf((select j ->> 'ok' = 'true' and j -> 'data' ->> 'student_name' = 'Aluno Sem Contrato'
    and (j -> 'data' ->> 'term_months')::int = 12 and j -> 'data' ->> 'payment_plan' = 'UPFRONT_CHARGE'
    and (j -> 'data' ->> 'upfront_total_cents')::bigint = 224400 and j -> 'data' ->> 'invoice_url' is null from rf_public),
  'página pública errada');

-- O valor não muda antes de assinar; o perfil segue como está.
select pg_temp.assert_rf((select class_frequency is null and paid_through = pg_temp.hoje() + 100
    from public.profiles where id = '7e1b0000-0000-4000-8000-000000000011'), 'perfil mudou antes da assinatura');

select pg_temp.assert_rf(public.sign_student_course_renewal((select j ->> 'token' from rf_offer), 'Outra Pessoa',
    (select (j -> 'data' ->> 'first_due_date')::date from rf_public)) ->> 'ok' = 'false', 'assinatura com nome errado passou');
select pg_temp.assert_rf(public.sign_student_course_renewal((select j ->> 'token' from rf_offer), 'Aluno Sem Contrato',
    (select (j -> 'data' ->> 'first_due_date')::date from rf_public)) ->> 'billing_status' = 'PENDING', 'assinatura não liberou a cobrança');
select pg_temp.assert_rf((select monthly_fee = 187 and class_frequency = '3x' and contract_accepted = false
    from public.profiles where id = '7e1b0000-0000-4000-8000-000000000011'),
  'assinar a renovação não pode inventar aceite do contrato');
select pg_temp.assert_rf((select count(*) = 1 from public.notification_queue q
   where q.tenant_id = 'renovacao-ficha-qa' and q.idempotency_key = 'renewal-signed:' || (select j ->> 'offer_id' from rf_offer)), 'grupo não foi avisado')
  where private.management_group_destination('renovacao-ficha-qa') is not null;

-- Sem o dinheiro, nenhum mês está coberto.
select pg_temp.assert_rf(not exists (select 1 from public.student_payment_allocations
   where student_id = '7e1b0000-0000-4000-8000-000000000011'), 'cobertura antes do pagamento');

-- Faturamento: a fonte da cobrança traz o titular; cliente é vinculado sob a mesma trava.
update private.student_course_renewal_offers
   set billing_status = 'PROCESSING', billing_claim_token = '7e1b0000-0000-4000-8000-0000000000c1',
       billing_lease_expires_at = now() + interval '10 minutes'
 where id = (select (j ->> 'offer_id')::uuid from rf_offer);
create temporary table rf_source on commit drop as
  select public.student_course_renewal_billing_source((select (j ->> 'offer_id')::uuid from rf_offer), '7e1b0000-0000-4000-8000-0000000000c1') as j;
select pg_temp.assert_rf((select j ->> 'strategy' = 'UPFRONT_CHARGE' and j -> 'upfront' ->> 'billing_cpf' = '11122233344'
    and (j -> 'upfront' ->> 'total_cents')::bigint = 224400 and j ->> 'customer_id' is null from rf_source), 'fonte da cobrança errada');
select pg_temp.assert_rf(public.bind_student_course_renewal_customer((select (j ->> 'offer_id')::uuid from rf_offer),
    '7e1b0000-0000-4000-8000-0000000000ff', 'cus_qa_rf') ->> 'ok' = 'false', 'vínculo aceito com claim errado');
select pg_temp.assert_rf(public.bind_student_course_renewal_customer((select (j ->> 'offer_id')::uuid from rf_offer),
    '7e1b0000-0000-4000-8000-0000000000c1', 'cus_qa_rf') ->> 'ok' = 'true', 'cliente não vinculado');
select pg_temp.assert_rf(public.finish_student_course_renewal_upfront_billing((select (j ->> 'offer_id')::uuid from rf_offer),
    '7e1b0000-0000-4000-8000-0000000000c1', 'SYNCED', 'cus_qa_rf', 'pay_qa_rf_total', 'https://pay.example.invalid/i/x') ->> 'status' = 'SYNCED', 'cobrança não registrada');
select pg_temp.assert_rf((select count(*) = 1 from public.notification_queue q
   where q.tenant_id = 'renovacao-ficha-qa' and q.idempotency_key = 'renewal-invoice:' || (select j ->> 'offer_id' from rf_offer)
     and q.message_body like '%https://pay.example.invalid/i/x%' and q.message_body like '%2.244,00%'),
  'link da cobrança não foi para o aluno');

-- Webhook chegou: linha criada PENDING não cobre; RECEIVED cobre, com o rateio por parcela.
insert into public.student_payments(student_id, tenant_id, asaas_payment_id, provider_customer_id, value, status, due_date,
    billing_type, payment_type, description)
values ('7e1b0000-0000-4000-8000-000000000011', 'renovacao-ficha-qa', 'pay_qa_rf_total', 'cus_qa_rf', 2244, 'PENDING', pg_temp.hoje() + 3,
    'PIX', 'SUBSCRIPTION', 'Renovação do curso - 12 meses - ref sintetica');
select pg_temp.assert_rf(not exists (select 1 from public.student_payment_allocations
   where student_id = '7e1b0000-0000-4000-8000-000000000011'), 'cobrança pendente não cobre mês');
select pg_temp.assert_rf((select private.payment_is_tuition(p.payment_type, p.description) from public.student_payments p
   where p.asaas_payment_id = 'pay_qa_rf_total'), 'a descrição da cobrança deixou de ser mensalidade');
update public.student_payments set status = 'RECEIVED', provider_status = 'RECEIVED', payment_date = pg_temp.hoje()
 where asaas_payment_id = 'pay_qa_rf_total';
select pg_temp.assert_rf((select count(*) = 12 and sum(valor) = 2244 and bool_and(modo = 'MENSAL' and origem = 'ASAAS' and status = 'ACTIVE')
    and min(competencia) = date_trunc('month', (select first_due_date from private.student_course_renewal_offers where id = (select (j ->> 'offer_id')::uuid from rf_offer)))::date
    from public.student_payment_allocations where student_id = '7e1b0000-0000-4000-8000-000000000011'),
  'cobertura diferente de 12 parcelas pelo total');
select pg_temp.assert_rf((select private.student_month_covered('7e1b0000-0000-4000-8000-000000000011', first_due_date)
    and private.student_month_covered('7e1b0000-0000-4000-8000-000000000011', last_due_date)
    and not private.student_month_covered('7e1b0000-0000-4000-8000-000000000011', service_end_date)
    from private.student_course_renewal_offers where id = (select (j ->> 'offer_id')::uuid from rf_offer)),
  'meses cobertos errados');
select pg_temp.assert_rf((select paid_through = (select service_end_date from private.student_course_renewal_offers where id = (select (j ->> 'offer_id')::uuid from rf_offer))
    and prepaid_months = 12 from public.profiles where id = '7e1b0000-0000-4000-8000-000000000011'), 'vigência não avançou');
-- Rateio: o aviso do recebimento trata a 1ª parcela, com o resto reservado.
create temporary table rf_split on commit drop as
  select private.payment_split_breakdown_unchecked((select id from public.student_payments where asaas_payment_id = 'pay_qa_rf_total')) as j;
select pg_temp.assert_rf((select j ->> 'modo' = 'MENSAL' and (j ->> 'sequencia')::int = 1 and (j ->> 'meses')::int = 12
    and (j ->> 'parcela')::numeric = 187 and (j ->> 'reservado')::numeric = 2057 and (j ->> 'recebido_total')::numeric = 2244 from rf_split),
  'rateio não é por parcela');
-- Evento repetido não duplica nada.
update public.student_payments set status = 'RECEIVED' where asaas_payment_id = 'pay_qa_rf_total';
select pg_temp.assert_rf((select count(*) = 12 from public.student_payment_allocations where student_id = '7e1b0000-0000-4000-8000-000000000011'), 'cobertura duplicou');
-- Mês coberto não cabe em outra renovação.
create temporary table rf_inside on commit drop as
  select first_due_date + 30 as start_on from private.student_course_renewal_offers
   where id = (select (j ->> 'offer_id')::uuid from rf_offer);
grant select on rf_inside to authenticated;
select pg_temp.as_user('7e1b0000-0000-4000-8000-000000000001');
select pg_temp.assert_rf(public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000011', 6, 229, 3, 17,
    (select start_on from rf_inside),
    'UPFRONT_EXTERNAL', null, null, pg_temp.hoje(), 'Comprovante sintetico', 'Contrato em PDF sintetico', 'Direção manteve o valor') ->> 'error' in ('periodo_ja_pago', 'periodo_ja_renovado'),
  'período já renovado aceitou outra renovação');
select pg_temp.as_owner();

-- ─── Já recebido por fora: cobre na assinatura, sem caixa e sem rateio ───────
select pg_temp.as_user('7e1b0000-0000-4000-8000-000000000001');
create temporary table rf_ext on commit drop as
  select public.create_student_renewal_offer('7e1b0000-0000-4000-8000-000000000012', 12, 229, 3, 10,
    (pg_temp.hoje() + 20), 'UPFRONT_EXTERNAL', null, null, pg_temp.hoje(), 'Comprovante sintetico de Pix') as j;
grant select on rf_ext to authenticated;
select pg_temp.assert_rf((select j ->> 'ok' = 'true' and j ->> 'strategy' = 'UPFRONT_EXTERNAL' from rf_ext), 'recebido por fora não emitiu');
select pg_temp.as_owner();
select pg_temp.assert_rf(not exists (select 1 from public.student_payment_allocations where student_id = '7e1b0000-0000-4000-8000-000000000012'),
  'recebido por fora cobriu antes da assinatura');
select pg_temp.assert_rf(public.sign_student_course_renewal((select j ->> 'token' from rf_ext), 'Aluno Por Fora',
    (select first_due_date from private.student_course_renewal_offers where id = (select (j ->> 'offer_id')::uuid from rf_ext))) ->> 'billing_status' = 'SYNCED',
  'recebido por fora ficou esperando cobrança');
select pg_temp.assert_rf((select count(*) = 12 and sum(valor) = 2748 and bool_and(modo = 'LEGADO' and origem = 'EXTERNO' and payment_id is null)
    from public.student_payment_allocations where student_id = '7e1b0000-0000-4000-8000-000000000012'),
  'cobertura externa errada');
select pg_temp.assert_rf(not exists (select 1 from public.student_payments where student_id = '7e1b0000-0000-4000-8000-000000000012'),
  'recebido por fora criou cobrança');
select pg_temp.assert_rf(not exists (select 1 from private.student_course_renewal_offers o
   where o.id = (select (j ->> 'offer_id')::uuid from rf_ext) and o.billing_status = 'PENDING'), 'fila de faturamento pegaria o recebido por fora');

-- ─── 6 meses continuam iguais ────────────────────────────────────────────────
select pg_temp.assert_rf(private.renewal_last_due_date('2027-01-31'::date, 6::smallint)
    = public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico('2027-01-31'::date))))),
  'progressão de 6 meses mudou');

-- ─── Cancelar e tentar de novo ───────────────────────────────────────────────
select pg_temp.as_user('7e1b0000-0000-4000-8000-000000000001');
select pg_temp.assert_rf(public.cancel_student_renewal_offer((select (j ->> 'offer_id')::uuid from rf_offer), 'assinada não cancela') ->> 'error' = 'renovacao_ja_assinada',
  'cancelou renovação assinada');
select pg_temp.assert_rf(public.retry_student_renewal_billing((select (j ->> 'offer_id')::uuid from rf_ext)) ->> 'error' = 'cobranca_sem_nova_tentativa',
  'tentou cobrar quem já pagou por fora');
select pg_temp.as_owner();

-- ─── Bot da renovação fica fora de 12 meses ──────────────────────────────────
update private.student_course_renewal_offers set status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'limpeza do teste'
 where student_id = '7e1b0000-0000-4000-8000-000000000014';
select pg_temp.assert_rf(strpos(pg_get_functiondef('public.renewal_negotiation_context(text,uuid)'::regprocedure), 'term_months = 6') > 0
    and strpos(pg_get_functiondef('public.open_renewal_negotiation(text,uuid,smallint,jsonb,text)'::regprocedure), 'term_months = 6') > 0
    and strpos(pg_get_functiondef('public.renewal_student_for_phone(text,text)'::regprocedure), 'o.term_months = 6') > 0,
  'bot da renovação ainda negocia oferta de 12 meses');

rollback;
