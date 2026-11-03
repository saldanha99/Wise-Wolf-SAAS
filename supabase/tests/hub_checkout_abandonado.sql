-- Checkout do Hub abandonado: PIX/boleto sem o 1º pagamento em 5 dias é
-- cancelado pela operação durável (DELETE no máximo uma vez, cerca contra o
-- webhook), as entregas fecham sem envio, e o pagamento tardio nunca libera
-- acesso em silêncio. Tudo sintético, tudo desfeito no rollback.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

-- 0) Permissões: só o serviço executa; internas fechadas; donos e search_path.
select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.hub_list_abandoned_checkouts(integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.hub_begin_abandoned_checkout_cancellation(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.hub_mark_abandoned_checkout_subscription_submitting(uuid,uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.hub_mark_abandoned_checkout_payment_submitting(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.hub_complete_abandoned_checkout_payment(uuid,uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.hub_abort_abandoned_checkout_cancellation(uuid,uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.hub_finalize_abandoned_checkout_cancellation(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.hub_begin_abandoned_checkout_cancellation(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.hub_list_abandoned_checkouts(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.hub_finalize_abandoned_checkout_cancellation(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.trigger_hub_abandoned_checkout_cleanup()', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.hub_abort_abandoned_checkout_internal(uuid,text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.hub_abandoned_checkout_operation_drift(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.hub_abandoned_checkout_block_reason(uuid)', 'EXECUTE')
  and not has_table_privilege('service_role', 'private.hub_abandoned_checkout_payment_targets', 'UPDATE')
  and not has_table_privilege('authenticated', 'private.hub_abandoned_checkout_payment_targets', 'SELECT')
  and not has_function_privilege('authenticated', 'public.hub_activate_paid_checkout(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.hub_reverse_paid_checkout(uuid,text,text)', 'EXECUTE'),
  'permissões da rotina de checkout abandonado inseguras'
);
select pg_temp.assert_true(
  (
    select count(*) = 13
      and bool_and(pg_get_userbyid(p.proowner) = 'postgres')
      and bool_and(p.proconfig @> array['search_path=""']::text[])
    from pg_proc p
    where p.oid in (
      'private.hub_abandoned_checkout_block_reason(uuid)'::regprocedure,
      'public.hub_list_abandoned_checkouts(integer)'::regprocedure,
      'public.hub_begin_abandoned_checkout_cancellation(uuid)'::regprocedure,
      'private.hub_abandoned_checkout_operation_drift(uuid,uuid)'::regprocedure,
      'private.hub_abort_abandoned_checkout_internal(uuid,text)'::regprocedure,
      'public.hub_abort_abandoned_checkout_cancellation(uuid,uuid,text)'::regprocedure,
      'public.hub_mark_abandoned_checkout_subscription_submitting(uuid,uuid,text)'::regprocedure,
      'public.hub_mark_abandoned_checkout_payment_submitting(uuid,uuid)'::regprocedure,
      'public.hub_complete_abandoned_checkout_payment(uuid,uuid,text)'::regprocedure,
      'public.hub_finalize_abandoned_checkout_cancellation(uuid,uuid)'::regprocedure,
      'private.hub_checkout_is_abandoned_unpaid(uuid)'::regprocedure,
      'public.hub_activate_paid_checkout(uuid,text)'::regprocedure,
      'public.hub_reverse_paid_checkout(uuid,text,text)'::regprocedure
    )
  )
  and strpos(pg_get_functiondef('public.hub_activate_paid_checkout(uuid,text)'::regprocedure), 'hub_lock_provider_event_writer') > 0
  and strpos(pg_get_functiondef('public.hub_reverse_paid_checkout(uuid,text,text)'::regprocedure), 'hub_lock_provider_event_writer') > 0
  and strpos(pg_get_functiondef('public.hub_mark_abandoned_checkout_subscription_submitting(uuid,uuid,text)'::regprocedure), 'hub_mark_provider_cancellation_submitting') > 0,
  'funções do checkout abandonado sem dono/search_path seguros ou fora da cerca'
);
select pg_temp.assert_true(
  exists (
    select 1 from cron.job
    where jobname = 'wisewolf-hub-abandoned-checkouts'
      and schedule = '17 * * * *'
      and command = 'select public.trigger_hub_abandoned_checkout_cleanup();'
  )
  and strpos(pg_get_functiondef('public.trigger_hub_abandoned_checkout_cleanup()'::regprocedure), 'wisewolf_service_role_key') > 0
  and strpos(pg_get_functiondef('public.trigger_hub_abandoned_checkout_cleanup()'::regprocedure), 'expire-hub-abandoned-checkouts') > 0,
  'cron horário do checkout abandonado ausente'
);

-- 1) Fixtures: uma conta por cenário (uma operação aberta por conta).
update public.hub_settings
   set metadata = coalesce(metadata, '{}'::jsonb) || '{"hubEnabled":true}'::jsonb
 where settings_key = 'default';

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('7e000000-0000-4000-8000-00000000010' || n)::uuid, 'authenticated', 'authenticated',
       'abandoned-' || n || '@example.invalid',
       '{"provider":"email","providers":["email"],"test_fixture":true}', '{"test_fixture":true}', now(), now()
from generate_series(1, 9) as n;

insert into public.hub_plans (id, code, name, audience, price_monthly, price_yearly, is_public, is_active, metadata, product_family)
values
  ('7e000000-0000-4000-8000-000000000201', 'HUB_ABANDONED_CORE_FIXTURE', 'Hub abandoned Core fixture', 'ALL', 1, 10, false, true, '{"test_fixture":true}', 'HUB_CORE'),
  ('7e000000-0000-4000-8000-000000000202', 'HUB_ABANDONED_WOLFIE_FIXTURE', 'Hub abandoned Wolfie fixture', 'ALL', 1, 10, false, true, '{"test_fixture":true}', 'WOLFIE_STANDALONE');

insert into public.hub_accounts (id, account_type, audience, name, owner_user_id, status, asaas_customer_id, metadata)
select ('7e000000-0000-4000-8000-00000000030' || n)::uuid, 'PERSONAL', 'EDUCATOR', 'Abandoned fixture ' || n,
       ('7e000000-0000-4000-8000-00000000010' || n)::uuid, 'ACTIVE', 'cus_abandoned_' || n, '{"test_fixture":true}'
from generate_series(1, 9) as n;

-- C1 (conta 1): Wolfie PIX PENDING de 6 dias, com assinatura e 1ª cobrança.
-- C2 (conta 2): Core PIX PENDING de 6 dias (pagamento confirmado no provedor).
-- C3 (conta 3): Wolfie boleto PENDING de 6 dias (DELETE já submetido).
-- C4 (conta 4): Wolfie PIX PENDING de 6 dias (pagamento aplicado no meio).
-- C5 (conta 5): Wolfie PIX CREATED de 6 dias sem nada no provedor.
-- Contas 6 a 9: os que não podem entrar (recente, cartão, pago antes, criação
-- ambígua) — um checkout aberto por conta e produto (hub_one_open_checkout_per_product).
insert into public.hub_checkout_sessions (id, account_id, plan_id, requested_by, billing_cycle, billing_type, amount, status, asaas_subscription_id, asaas_payment_id, metadata, product_family, created_at)
values
  ('7e000000-0000-4000-8000-000000000401', '7e000000-0000-4000-8000-000000000301', '7e000000-0000-4000-8000-000000000202', '7e000000-0000-4000-8000-000000000101', 'MONTHLY', 'PIX', 1, 'PENDING', 'sub_abandoned_1', 'pay_abandoned_1', '{"test_fixture":true}', 'WOLFIE_STANDALONE', now() - interval '6 days'),
  ('7e000000-0000-4000-8000-000000000402', '7e000000-0000-4000-8000-000000000302', '7e000000-0000-4000-8000-000000000201', '7e000000-0000-4000-8000-000000000102', 'MONTHLY', 'PIX', 1, 'PENDING', 'sub_abandoned_2', 'pay_abandoned_2', '{"test_fixture":true}', 'HUB_CORE', now() - interval '6 days'),
  ('7e000000-0000-4000-8000-000000000403', '7e000000-0000-4000-8000-000000000303', '7e000000-0000-4000-8000-000000000202', '7e000000-0000-4000-8000-000000000103', 'MONTHLY', 'BOLETO', 1, 'PENDING', 'sub_abandoned_3', 'pay_abandoned_3', '{"test_fixture":true}', 'WOLFIE_STANDALONE', now() - interval '9 days'),
  ('7e000000-0000-4000-8000-000000000404', '7e000000-0000-4000-8000-000000000304', '7e000000-0000-4000-8000-000000000202', '7e000000-0000-4000-8000-000000000104', 'MONTHLY', 'PIX', 1, 'PENDING', 'sub_abandoned_4', 'pay_abandoned_4', '{"test_fixture":true}', 'WOLFIE_STANDALONE', now() - interval '6 days'),
  ('7e000000-0000-4000-8000-000000000405', '7e000000-0000-4000-8000-000000000305', '7e000000-0000-4000-8000-000000000202', '7e000000-0000-4000-8000-000000000105', 'MONTHLY', 'PIX', 1, 'CREATED', null, null, '{"test_fixture":true}', 'WOLFIE_STANDALONE', now() - interval '6 days'),
  ('7e000000-0000-4000-8000-000000000406', '7e000000-0000-4000-8000-000000000306', '7e000000-0000-4000-8000-000000000202', '7e000000-0000-4000-8000-000000000106', 'MONTHLY', 'PIX', 1, 'PENDING', 'sub_abandoned_recent', 'pay_abandoned_recent', '{"test_fixture":true}', 'WOLFIE_STANDALONE', now() - interval '4 days'),
  ('7e000000-0000-4000-8000-000000000407', '7e000000-0000-4000-8000-000000000307', '7e000000-0000-4000-8000-000000000202', '7e000000-0000-4000-8000-000000000107', 'MONTHLY', 'CREDIT_CARD', 1, 'PENDING', 'sub_abandoned_card', 'pay_abandoned_card', '{"test_fixture":true}', 'WOLFIE_STANDALONE', now() - interval '6 days'),
  ('7e000000-0000-4000-8000-000000000408', '7e000000-0000-4000-8000-000000000308', '7e000000-0000-4000-8000-000000000202', '7e000000-0000-4000-8000-000000000108', 'MONTHLY', 'PIX', 1, 'OVERDUE', 'sub_abandoned_paid', 'pay_abandoned_paid', '{"test_fixture":true}', 'WOLFIE_STANDALONE', now() - interval '40 days'),
  ('7e000000-0000-4000-8000-000000000409', '7e000000-0000-4000-8000-000000000309', '7e000000-0000-4000-8000-000000000202', '7e000000-0000-4000-8000-000000000109', 'MONTHLY', 'PIX', 1, 'CREATED', null, null, '{"test_fixture":true}', 'WOLFIE_STANDALONE', now() - interval '6 days');

-- C8: renovação vencida de um checkout que já foi pago (OVERDUE com APPLIED).
insert into public.hub_subscription_payments (provider, provider_payment_id, checkout_id, account_id, product_family, status, applied_at, metadata)
values ('ASAAS', 'pay_abandoned_paid', '7e000000-0000-4000-8000-000000000408', '7e000000-0000-4000-8000-000000000308', 'WOLFIE_STANDALONE', 'APPLIED', now() - interval '40 days', '{"test_fixture":true}');

-- C1 tem as entregas do onboarding esperando o pagamento.
insert into public.hub_fulfillment_outbox (checkout_id, account_id, user_id, product_family, plan_code, plan_name, channel, recipient, recipient_name, metadata)
values
  ('7e000000-0000-4000-8000-000000000401', '7e000000-0000-4000-8000-000000000301', '7e000000-0000-4000-8000-000000000101', 'WOLFIE_STANDALONE', 'HUB_ABANDONED_WOLFIE_FIXTURE', 'Fixture', 'EMAIL', 'abandoned-1@example.invalid', 'Fixture', '{"test_fixture":true}'),
  ('7e000000-0000-4000-8000-000000000401', '7e000000-0000-4000-8000-000000000301', '7e000000-0000-4000-8000-000000000101', 'WOLFIE_STANDALONE', 'HUB_ABANDONED_WOLFIE_FIXTURE', 'Fixture', 'WHATSAPP', '5511900000000', 'Fixture', '{"test_fixture":true}');

-- A lista é global e o release roda este teste no banco de produção: os
-- elegíveis sintéticos ganham data bem antiga para virem primeiro na
-- ordenação; os bloqueados são conferidos direto pela regra (abaixo), sem
-- depender de quantos checkouts reais existam.
update public.hub_checkout_sessions
   set created_at = now() - interval '3650 days'
 where id in (
   '7e000000-0000-4000-8000-000000000401', '7e000000-0000-4000-8000-000000000402',
   '7e000000-0000-4000-8000-000000000403', '7e000000-0000-4000-8000-000000000404',
   '7e000000-0000-4000-8000-000000000405'
 );

create temporary table abandoned_results (step text primary key, payload jsonb) on commit drop;
grant all on table abandoned_results to service_role;

select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

-- C9: criação de assinatura reservada e nunca concluída (ambígua).
insert into abandoned_results values ('c9_claim', public.claim_asaas_provider_creation(
  'school-wise-wolf', 'SUBSCRIPTION_CREATE',
  'hub-checkout:7e000000-0000-4000-8000-000000000409',
  'hub:7e000000-0000-4000-8000-000000000409',
  repeat('c', 64), '7e000000-0000-4000-8000-000000000999', 300
));

-- 2) A lista: elegíveis entram, recentes e cartão nem aparecem, os bloqueados
--    aparecem com o motivo.
insert into abandoned_results
select 'list', coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
from public.hub_list_abandoned_checkouts(25) as row_data
where row_data.checkout_id::text like '7e000000-%';
reset role;
select pg_temp.assert_true(
  (select payload @> '[{"checkout_id":"7e000000-0000-4000-8000-000000000401","block_reason":null}]'::jsonb
     and payload @> '[{"checkout_id":"7e000000-0000-4000-8000-000000000405","block_reason":null}]'::jsonb
     and not payload @> '[{"checkout_id":"7e000000-0000-4000-8000-000000000406"}]'::jsonb
     and not payload @> '[{"checkout_id":"7e000000-0000-4000-8000-000000000407"}]'::jsonb
   from abandoned_results where step = 'list'),
  'lista de checkouts abandonados com elegibilidade errada'
);
select pg_temp.assert_true(
  private.hub_abandoned_checkout_block_reason('7e000000-0000-4000-8000-000000000401') is null
  and private.hub_abandoned_checkout_block_reason('7e000000-0000-4000-8000-000000000406') = 'ABANDONMENT_WINDOW_NOT_REACHED'
  and private.hub_abandoned_checkout_block_reason('7e000000-0000-4000-8000-000000000407') = 'BILLING_TYPE_NOT_COVERED'
  and private.hub_abandoned_checkout_block_reason('7e000000-0000-4000-8000-000000000408') = 'PAYMENT_APPLIED'
  and private.hub_abandoned_checkout_block_reason('7e000000-0000-4000-8000-000000000409') = 'PROVIDER_CREATION_RECONCILIATION_REQUIRED',
  'regra de elegibilidade do abandono errada'
);

-- Boleto pago continua PENDING até compensar: com 6 dias ainda espera; com 9 entra.
update public.hub_checkout_sessions
   set created_at = now() - interval '6 days'
 where id = '7e000000-0000-4000-8000-000000000403';
select pg_temp.assert_true(
  private.hub_abandoned_checkout_block_reason('7e000000-0000-4000-8000-000000000403') = 'ABANDONMENT_WINDOW_NOT_REACHED',
  'boleto com 6 dias deveria esperar a compensação (8 dias)'
);
update public.hub_checkout_sessions
   set created_at = now() - interval '9 days'
 where id = '7e000000-0000-4000-8000-000000000403';
select pg_temp.assert_true(
  private.hub_abandoned_checkout_block_reason('7e000000-0000-4000-8000-000000000403') is null,
  'boleto com 9 dias deveria entrar na rotina'
);

-- 3) Início recusado para quem não pode entrar.
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into abandoned_results values
  ('begin_recent', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000406')),
  ('begin_card', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000407')),
  ('begin_paid', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000408')),
  ('begin_ambiguous', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000409'));
reset role;
select pg_temp.assert_true(
  (select payload ->> 'reason' = 'ABANDONMENT_WINDOW_NOT_REACHED' from abandoned_results where step = 'begin_recent')
  and (select payload ->> 'reason' = 'BILLING_TYPE_NOT_COVERED' from abandoned_results where step = 'begin_card')
  and (select payload ->> 'reason' = 'PAYMENT_APPLIED' from abandoned_results where step = 'begin_paid')
  and (select payload ->> 'reason' = 'PROVIDER_CREATION_RECONCILIATION_REQUIRED' from abandoned_results where step = 'begin_ambiguous')
  and not exists (
    select 1 from private.hub_provider_operations
    where account_id in (
      '7e000000-0000-4000-8000-000000000306', '7e000000-0000-4000-8000-000000000307',
      '7e000000-0000-4000-8000-000000000308', '7e000000-0000-4000-8000-000000000309'
    )
  )
  and (select count(*) = 4 from public.hub_checkout_sessions
       where id in ('7e000000-0000-4000-8000-000000000406', '7e000000-0000-4000-8000-000000000407',
                    '7e000000-0000-4000-8000-000000000408', '7e000000-0000-4000-8000-000000000409')
         and status in ('PENDING', 'OVERDUE', 'CREATED')),
  'checkout não elegível abriu operação ou mudou de estado'
);

-- 4) Caminho completo do C1.
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into abandoned_results values ('c1_begin', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000401'));
reset role;
select pg_temp.assert_true(
  (select payload ->> 'action' = 'STARTED'
     and payload -> 'snapshot' -> 'targets' @> '[{"providerSubscriptionId":"sub_abandoned_1","providerCustomerId":"cus_abandoned_1"}]'::jsonb
     and payload -> 'snapshot' -> 'payment' ->> 'providerPaymentId' = 'pay_abandoned_1'
   from abandoned_results where step = 'c1_begin')
  and exists (
    select 1 from private.hub_provider_operations
    where logical_key = 'ABANDONED_CHECKOUT:7e000000-0000-4000-8000-000000000401'
      and operation_kind = 'ABANDONED_CHECKOUT' and status = 'READY' and reason = 'ABANDONED_UNPAID'
  )
  and exists (
    select 1 from private.hub_abandoned_checkout_payment_targets
    where checkout_id = '7e000000-0000-4000-8000-000000000401' and state = 'READY'
  ),
  'início do C1 não gravou a operação imutável com assinatura e cobrança'
);

-- 4a) Corrida: pagamento chegando com a operação aberta espera (cerca).
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $paid_while_open$
begin
  perform public.hub_activate_paid_checkout('7e000000-0000-4000-8000-000000000401', 'pay_abandoned_1');
  raise exception 'assertion failed: pagamento foi aplicado com a operação de abandono aberta';
exception
  when object_not_in_prerequisite_state then null;
end;
$paid_while_open$;
-- Retomar devolve a mesma operação e o mesmo lease.
insert into abandoned_results values ('c1_resume', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000401'));
insert into abandoned_results values ('c1_bind', public.hub_bind_provider_operation_integration(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid,
  '7e000000-0000-4000-8000-000000000990', 1
));
insert into abandoned_results values ('c1_claim', public.hub_claim_provider_cancellation_target(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid,
  'sub_abandoned_1'
));
-- A cobrança não pode ser apagada antes da assinatura.
do $payment_before_subscription$
begin
  perform public.hub_mark_abandoned_checkout_payment_submitting(
    (select (payload ->> 'operationId')::uuid from abandoned_results where step = 'c1_begin'),
    (select (payload ->> 'leaseToken')::uuid from abandoned_results where step = 'c1_begin')
  );
  raise exception 'assertion failed: DELETE da cobrança liberado antes da assinatura';
exception
  when object_not_in_prerequisite_state then null;
end;
$payment_before_subscription$;
insert into abandoned_results values ('c1_sub_submit', public.hub_mark_abandoned_checkout_subscription_submitting(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid,
  'sub_abandoned_1'
));
insert into abandoned_results values ('c1_sub_submit_again', public.hub_mark_abandoned_checkout_subscription_submitting(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid,
  'sub_abandoned_1'
));
insert into abandoned_results values ('c1_sub_complete', public.hub_complete_provider_cancellation_target(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid,
  'sub_abandoned_1', 'CONFIRMED'
));
-- Finalizar sem a cobrança comprovada é recusado.
do $finalize_before_payment$
begin
  perform public.hub_finalize_abandoned_checkout_cancellation(
    (select (payload ->> 'operationId')::uuid from abandoned_results where step = 'c1_begin'),
    (select (payload ->> 'leaseToken')::uuid from abandoned_results where step = 'c1_begin')
  );
  raise exception 'assertion failed: checkout cancelado com a 1ª cobrança ainda aberta';
exception
  when object_not_in_prerequisite_state then null;
end;
$finalize_before_payment$;
insert into abandoned_results values ('c1_pay_submit', public.hub_mark_abandoned_checkout_payment_submitting(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid
));
insert into abandoned_results values ('c1_pay_submit_again', public.hub_mark_abandoned_checkout_payment_submitting(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid
));
insert into abandoned_results values ('c1_pay_complete', public.hub_complete_abandoned_checkout_payment(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid,
  'CONFIRMED'
));
insert into abandoned_results values ('c1_finalize', public.hub_finalize_abandoned_checkout_cancellation(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid
));
insert into abandoned_results values ('c1_finalize_again', public.hub_finalize_abandoned_checkout_cancellation(
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c1_begin') ->> 'leaseToken')::uuid
));
insert into abandoned_results values ('c1_begin_after', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000401'));
reset role;

select pg_temp.assert_true(
  (select payload ->> 'action' = 'RESUME'
     and payload ->> 'leaseToken' = (select payload ->> 'leaseToken' from abandoned_results where step = 'c1_begin')
   from abandoned_results where step = 'c1_resume')
  and (select payload ->> 'action' = 'VERIFY_REQUIRED' from abandoned_results where step = 'c1_claim')
  and (select payload ->> 'action' = 'SUBMIT_ALLOWED' from abandoned_results where step = 'c1_sub_submit')
  and (select payload ->> 'action' = 'RECONCILE_ONLY' from abandoned_results where step = 'c1_sub_submit_again')
  and (select payload ->> 'action' = 'SUBMIT_ALLOWED' from abandoned_results where step = 'c1_pay_submit')
  and (select payload ->> 'action' = 'RECONCILE_ONLY' from abandoned_results where step = 'c1_pay_submit_again')
  and (select (payload ->> 'ok')::boolean and (payload ->> 'closedDeliveries')::integer = 2
       from abandoned_results where step = 'c1_finalize')
  and (select (payload ->> 'idempotent')::boolean from abandoned_results where step = 'c1_finalize_again')
  and (select payload ->> 'action' = 'ALREADY_SUCCEEDED' from abandoned_results where step = 'c1_begin_after'),
  'limite de DELETE único, ordem assinatura→cobrança ou idempotência quebrados no C1'
);
select pg_temp.assert_true(
  (select status = 'CANCELLED'
     and metadata ->> 'cancellationReason' = 'ABANDONED_UNPAID'
     and metadata ->> 'abandonedPreviousStatus' = 'PENDING'
     and (metadata ->> 'providerSubscriptionCancelled')::boolean
     and (metadata ->> 'providerPaymentRemoved')::boolean
   from public.hub_checkout_sessions where id = '7e000000-0000-4000-8000-000000000401')
  and (select count(*) = 2 from public.hub_fulfillment_outbox
       where checkout_id = '7e000000-0000-4000-8000-000000000401'
         and status = 'SKIPPED' and last_error = 'checkout_abandoned_unpaid'
         and provider_message_id is null)
  and exists (select 1 from private.hub_provider_operations
              where logical_key = 'ABANDONED_CHECKOUT:7e000000-0000-4000-8000-000000000401' and status = 'SUCCEEDED')
  and (select count(*) = 1 from public.hub_conversion_events
       where event_name = 'wolfie_checkout_abandoned'
         and metadata ->> 'checkoutId' = '7e000000-0000-4000-8000-000000000401'),
  'C1 não foi cancelado com o motivo, as entregas não fecharam ou faltou o evento'
);

-- 4b) Pagamento tardio depois do cancelamento: nunca libera acesso, fica
--     registrado para conciliação manual, e o estorno da cobrança removida
--     não vira REVERSED nem suspende o aluno.
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into abandoned_results values ('c1_late_paid', public.hub_activate_paid_checkout('7e000000-0000-4000-8000-000000000401', 'pay_abandoned_1'));
insert into abandoned_results values ('c1_late_paid_replay', public.hub_activate_paid_checkout('7e000000-0000-4000-8000-000000000401', 'pay_abandoned_1'));
insert into abandoned_results values ('c1_deleted_event', public.hub_reverse_paid_checkout('7e000000-0000-4000-8000-000000000401', 'pay_abandoned_1', 'PAYMENT_DELETED'));
insert into abandoned_results values ('c1_overdue_event', public.hub_mark_checkout_overdue('7e000000-0000-4000-8000-000000000401', 'pay_abandoned_1'));
insert into abandoned_results
select 'list_after', coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
from public.hub_list_abandoned_checkouts(25) as row_data
where row_data.checkout_id::text like '7e000000-%';
reset role;
select pg_temp.assert_true(
  (select payload ->> 'status' = 'CANCELLED' and not (payload ->> 'applied')::boolean
     and (payload ->> 'requiresManualReconciliation')::boolean
   from abandoned_results where step = 'c1_late_paid')
  and (select (payload ->> 'idempotent')::boolean from abandoned_results where step = 'c1_late_paid_replay')
  and (select (payload ->> 'ignored')::boolean from abandoned_results where step = 'c1_deleted_event')
  and (select (payload ->> 'ignored')::boolean from abandoned_results where step = 'c1_overdue_event')
  and (select status = 'CANCELLED'
         and metadata ->> 'paymentAfterAbandonmentId' = 'pay_abandoned_1'
         and (metadata ->> 'requiresManualReconciliation')::boolean
       from public.hub_checkout_sessions where id = '7e000000-0000-4000-8000-000000000401')
  and not exists (select 1 from public.hub_subscriptions where account_id = '7e000000-0000-4000-8000-000000000301')
  and not exists (select 1 from public.hub_subscription_payments where checkout_id = '7e000000-0000-4000-8000-000000000401')
  and (select count(*) = 1 from public.hub_conversion_events
       where event_name = 'wolfie_payment_after_abandonment'
         and metadata ->> 'checkoutId' = '7e000000-0000-4000-8000-000000000401')
  and not (select payload @> '[{"checkout_id":"7e000000-0000-4000-8000-000000000401"}]'::jsonb
           from abandoned_results where step = 'list_after'),
  'pagamento tardio liberou acesso, sumiu sem registro, ou o estorno reabriu o checkout'
);

-- 5) C2: pagamento confirmado no provedor antes de qualquer DELETE. A
--    operação termina ABORTED, a cerca sai e o pagamento ativa normalmente.
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into abandoned_results values ('c2_begin', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000402'));
insert into abandoned_results values ('c2_abort', public.hub_abort_abandoned_checkout_cancellation(
  ((select payload from abandoned_results where step = 'c2_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c2_begin') ->> 'leaseToken')::uuid,
  'PAYMENT_SETTLED_AT_PROVIDER'
));
insert into abandoned_results values ('c2_paid', public.hub_activate_paid_checkout('7e000000-0000-4000-8000-000000000402', 'pay_abandoned_2'));
insert into abandoned_results values ('c2_begin_again', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000402'));
reset role;
select pg_temp.assert_true(
  (select payload ->> 'action' = 'ABORTED' from abandoned_results where step = 'c2_abort')
  and exists (select 1 from private.hub_provider_operations
              where logical_key = 'ABANDONED_CHECKOUT:7e000000-0000-4000-8000-000000000402' and status = 'ABORTED')
  and (select payload ->> 'status' = 'ACTIVE' from abandoned_results where step = 'c2_paid')
  and (select status = 'PAID' and (metadata ->> 'requiresManualReconciliation')::boolean
         and metadata ->> 'abandonedCancellationAbortReason' = 'PAYMENT_SETTLED_AT_PROVIDER'
       from public.hub_checkout_sessions where id = '7e000000-0000-4000-8000-000000000402')
  and (select payload ->> 'reason' = 'PREVIOUSLY_ABORTED' from abandoned_results where step = 'c2_begin_again'),
  'abandono abortado não liberou a cerca, ou bloqueou o pagamento de quem pagou'
);

-- 6) C3: DELETE da assinatura já submetido (resposta perdida): abortar é
--    recusado; só um GET encerra o alvo.
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into abandoned_results values ('c3_begin', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000403'));
insert into abandoned_results values ('c3_bind', public.hub_bind_provider_operation_integration(
  ((select payload from abandoned_results where step = 'c3_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c3_begin') ->> 'leaseToken')::uuid,
  '7e000000-0000-4000-8000-000000000990', 1
));
insert into abandoned_results values ('c3_sub_submit', public.hub_mark_abandoned_checkout_subscription_submitting(
  ((select payload from abandoned_results where step = 'c3_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c3_begin') ->> 'leaseToken')::uuid,
  'sub_abandoned_3'
));
do $abort_after_submit$
begin
  perform public.hub_abort_abandoned_checkout_cancellation(
    (select (payload ->> 'operationId')::uuid from abandoned_results where step = 'c3_begin'),
    (select (payload ->> 'leaseToken')::uuid from abandoned_results where step = 'c3_begin'),
    'PROVIDER_SUBSCRIPTION_REVIEW'
  );
  raise exception 'assertion failed: operação abortada com DELETE de resultado desconhecido';
exception
  when object_not_in_prerequisite_state then null;
end;
$abort_after_submit$;
insert into abandoned_results values ('c3_claim_again', public.hub_claim_provider_cancellation_target(
  ((select payload from abandoned_results where step = 'c3_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c3_begin') ->> 'leaseToken')::uuid,
  'sub_abandoned_3'
));
reset role;
select pg_temp.assert_true(
  (select payload ->> 'action' = 'SUBMIT_ALLOWED' from abandoned_results where step = 'c3_sub_submit')
  and (select payload ->> 'action' = 'RECONCILE_ONLY' from abandoned_results where step = 'c3_claim_again')
  and (select status = 'PENDING' from public.hub_checkout_sessions where id = '7e000000-0000-4000-8000-000000000403'),
  'retentativa depois do DELETE submetido não ficou só com GET'
);

-- 7) C4: um pagamento aplicado aparece antes do DELETE (prova de deriva):
--    o limite de DELETE devolve ABORTED e nada é cancelado.
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into abandoned_results values ('c4_begin', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000404'));
reset role;
insert into public.hub_subscription_payments (provider, provider_payment_id, checkout_id, account_id, product_family, status, applied_at, metadata)
values ('ASAAS', 'pay_abandoned_4', '7e000000-0000-4000-8000-000000000404', '7e000000-0000-4000-8000-000000000304', 'WOLFIE_STANDALONE', 'APPLIED', now(), '{"test_fixture":true}');
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into abandoned_results values ('c4_bind', public.hub_bind_provider_operation_integration(
  ((select payload from abandoned_results where step = 'c4_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c4_begin') ->> 'leaseToken')::uuid,
  '7e000000-0000-4000-8000-000000000990', 1
));
insert into abandoned_results values ('c4_sub_submit', public.hub_mark_abandoned_checkout_subscription_submitting(
  ((select payload from abandoned_results where step = 'c4_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c4_begin') ->> 'leaseToken')::uuid,
  'sub_abandoned_4'
));
reset role;
select pg_temp.assert_true(
  (select payload ->> 'action' = 'ABORTED' and payload ->> 'reason' = 'PAYMENT_APPLIED'
   from abandoned_results where step = 'c4_sub_submit')
  and exists (select 1 from private.hub_provider_operation_targets t
              join private.hub_provider_operations o on o.id = t.operation_id
              where o.logical_key = 'ABANDONED_CHECKOUT:7e000000-0000-4000-8000-000000000404'
                and o.status = 'ABORTED' and t.state = 'READY')
  and (select status = 'PENDING' from public.hub_checkout_sessions where id = '7e000000-0000-4000-8000-000000000404'),
  'checkout com pagamento aplicado chegou ao DELETE ou foi cancelado'
);

-- 8) C5: CREATED sem nada no provedor fecha só localmente.
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into abandoned_results values ('c5_begin', public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000405'));
insert into abandoned_results values ('c5_finalize', public.hub_finalize_abandoned_checkout_cancellation(
  ((select payload from abandoned_results where step = 'c5_begin') ->> 'operationId')::uuid,
  ((select payload from abandoned_results where step = 'c5_begin') ->> 'leaseToken')::uuid
));
reset role;
select pg_temp.assert_true(
  (select payload -> 'snapshot' -> 'targets' = '[]'::jsonb and payload -> 'snapshot' -> 'payment' = 'null'::jsonb
   from abandoned_results where step = 'c5_begin')
  and (select status = 'CANCELLED' and metadata ->> 'cancellationReason' = 'ABANDONED_UNPAID'
         and not (metadata ->> 'providerSubscriptionCancelled')::boolean
       from public.hub_checkout_sessions where id = '7e000000-0000-4000-8000-000000000405'),
  'checkout CREATED abandonado sem provedor não foi fechado localmente'
);

-- 9) Só o serviço inicia.
select pg_catalog.set_config('request.jwt.claims', '{"role":"authenticated","sub":"7e000000-0000-4000-8000-000000000101"}', true);
do $only_service$
begin
  perform public.hub_begin_abandoned_checkout_cancellation('7e000000-0000-4000-8000-000000000403');
  raise exception 'assertion failed: início aceito sem a chave de serviço';
exception
  when insufficient_privilege then null;
end;
$only_service$;

-- O release roda os testes em savepoints da mesma transação: não deixar
-- claims nem papel para o próximo teste.
select pg_catalog.set_config('request.jwt.claims', '', true);
reset role;

rollback;
