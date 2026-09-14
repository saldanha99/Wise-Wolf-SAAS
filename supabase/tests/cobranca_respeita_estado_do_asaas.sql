-- Cobrança e suspensão respeitam o último estado que o Asaas informou
-- (migration 20260914020000). Regressão do caso de 13/09/2026: evento de
-- pagamento parado em TRIAGE, linha local PENDING — e mesmo assim a régua de
-- vencidas cobrou e a suspensão diária bloqueou o aluno que já tinha pago.

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

-- Só a edge (service_role) consulta a trava; aluno e anônimo não.
select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'public.student_payment_collection_blocks(uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.student_payment_collection_blocks(uuid[])', 'EXECUTE')
  and has_function_privilege('service_role', 'public.student_payment_collection_blocks(uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.suspend_overdue_students(integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.suspend_overdue_students(integer)', 'EXECUTE'),
  'permissões da trava de cobrança'
);

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values ('cobranca-asaas-school', 'Cobranca Asaas School', 'cobranca-asaas-school', 'active', false);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-0000000c0b01', 'authenticated', 'authenticated', 'cobranca-pagou@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Pagou"}', now(), now()),
  ('00000000-0000-4000-8000-0000000c0b02', 'authenticated', 'authenticated', 'cobranca-suspenso@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Suspenso Que Pagou"}', now(), now()),
  ('00000000-0000-4000-8000-0000000c0b03', 'authenticated', 'authenticated', 'cobranca-devedor@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Devedor"}', now(), now());

update public.profiles
   set tenant_id = 'cobranca-asaas-school', role = 'STUDENT',
       lifecycle_status = 'active', status_financial = 'ACTIVE'
 where id in ('00000000-0000-4000-8000-0000000c0b01', '00000000-0000-4000-8000-0000000c0b03');
update public.profiles
   set tenant_id = 'cobranca-asaas-school', role = 'STUDENT',
       lifecycle_status = 'active', status_financial = 'SUSPENDED',
       suspended_at = now() - interval '3 days',
       suspended_reason = 'Inadimplência superior a 15 dias'
 where id = '00000000-0000-4000-8000-0000000c0b02';

insert into public.student_payments (asaas_payment_id, tenant_id, student_id, value, status, due_date)
values
  ('pay_cob_recebido',   'cobranca-asaas-school', '00000000-0000-4000-8000-0000000c0b01', 187.00, 'PENDING', current_date - 30),
  ('pay_cob_suspenso',   'cobranca-asaas-school', '00000000-0000-4000-8000-0000000c0b02', 169.00, 'OVERDUE', current_date - 30),
  ('pay_cob_devedor',    'cobranca-asaas-school', '00000000-0000-4000-8000-0000000c0b03', 229.00, 'PENDING', current_date - 30),
  ('pay_cob_confirmado', 'cobranca-asaas-school', null, 296.00, 'PENDING', current_date - 5),
  ('pay_cob_vencimento', 'cobranca-asaas-school', null, 229.00, 'PENDING', current_date - 5),
  ('pay_cob_estorno',    'cobranca-asaas-school', null, 261.00, 'PENDING', current_date - 5),
  ('pay_cob_sem_evento', 'cobranca-asaas-school', null, 149.00, 'PENDING', current_date - 5),
  ('pay_cob_lixo',       'cobranca-asaas-school', null, 100.00, 'PENDING', current_date - 5);

create or replace function pg_temp.evento(
  p_event text, p_entity text, p_provider_status text, p_due text,
  p_inbox_status text, p_at timestamptz
)
returns void
language sql
as $$
  insert into public.asaas_webhook_inbox (
    provider_event_id, event_name, provider_entity_id, payload, payload_hash,
    status, event_created_at, received_at
  )
  values (
    'evt_' || p_entity || '_' || p_event || '_' || extract(epoch from p_at)::bigint,
    p_event, p_entity,
    jsonb_build_object('event', p_event, 'payment', jsonb_build_object(
      'id', p_entity, 'status', p_provider_status, 'dueDate', p_due)),
    md5(p_entity || p_event || p_at::text), p_inbox_status, p_at, p_at
  );
$$;

-- O último evento vence; TRIAGE conta (a dúvida da triagem é de vínculo).
select pg_temp.evento('PAYMENT_CREATED',  'pay_cob_recebido', 'PENDING',  to_char(current_date - 30, 'YYYY-MM-DD'), 'PROCESSED', now() - interval '40 days');
select pg_temp.evento('PAYMENT_RECEIVED', 'pay_cob_recebido', 'RECEIVED', to_char(current_date - 30, 'YYYY-MM-DD'), 'TRIAGE',    now() - interval '2 days');
select pg_temp.evento('PAYMENT_RECEIVED', 'pay_cob_suspenso', 'RECEIVED_IN_CASH', to_char(current_date - 30, 'YYYY-MM-DD'), 'TRIAGE', now() - interval '2 days');
select pg_temp.evento('PAYMENT_OVERDUE',  'pay_cob_devedor',  'OVERDUE',  to_char(current_date - 30, 'YYYY-MM-DD'), 'TRIAGE',    now() - interval '29 days');
select pg_temp.evento('PAYMENT_CONFIRMED','pay_cob_confirmado','CONFIRMED',to_char(current_date - 5, 'YYYY-MM-DD'),  'TRIAGE',    now() - interval '1 day');
select pg_temp.evento('PAYMENT_UPDATED',  'pay_cob_vencimento','PENDING', to_char(current_date + 20, 'YYYY-MM-DD'), 'TRIAGE',    now() - interval '1 day');
select pg_temp.evento('PAYMENT_RECEIVED', 'pay_cob_estorno',  'RECEIVED', to_char(current_date - 5, 'YYYY-MM-DD'),  'PROCESSED', now() - interval '3 days');
select pg_temp.evento('PAYMENT_REFUNDED', 'pay_cob_estorno',  'REFUNDED', to_char(current_date - 5, 'YYYY-MM-DD'),  'TRIAGE',    now() - interval '1 day');
-- Payload torto não pode derrubar a régua inteira com erro de cast.
select pg_temp.evento('PAYMENT_UPDATED',  'pay_cob_lixo',     'PENDING',  'ontem', 'TRIAGE', now() - interval '1 day');

create temporary table cobranca_motivos as
select sp.asaas_payment_id as pagamento,
       private.student_payment_provider_block_reason(sp.id) as motivo
  from public.student_payments sp
 where sp.tenant_id = 'cobranca-asaas-school';

select pg_temp.assert_true(
  (select motivo from cobranca_motivos where pagamento = 'pay_cob_recebido') = 'asaas_ja_recebeu',
  'pagamento recebido no Asaas (evento em TRIAGE) continuou cobrável');
select pg_temp.assert_true(
  (select motivo from cobranca_motivos where pagamento = 'pay_cob_suspenso') = 'asaas_ja_recebeu',
  'recebido em dinheiro no Asaas continuou cobrável');
select pg_temp.assert_true(
  (select motivo from cobranca_motivos where pagamento = 'pay_cob_confirmado') = 'asaas_ja_recebeu',
  'cartão CONFIRMED continuou cobrável');
select pg_temp.assert_true(
  (select motivo from cobranca_motivos where pagamento = 'pay_cob_vencimento') = 'asaas_vencimento_mudou',
  'vencimento movido no Asaas continuou sendo tratado como atraso');
select pg_temp.assert_true(
  (select motivo from cobranca_motivos where pagamento = 'pay_cob_estorno') = 'asaas_estorno_ou_exclusao',
  'o evento mais recente (estorno) não venceu o recebimento anterior');
select pg_temp.assert_true(
  (select motivo from cobranca_motivos where pagamento = 'pay_cob_devedor') is null
  and (select motivo from cobranca_motivos where pagamento = 'pay_cob_sem_evento') is null
  and (select motivo from cobranca_motivos where pagamento = 'pay_cob_lixo') is null,
  'cobrança realmente em aberto deixou de ser cobrada');

select pg_temp.assert_true(
  (select count(*) from public.student_payment_collection_blocks(
     array(select id from public.student_payments where tenant_id = 'cobranca-asaas-school'))
    where reason is not null) = 5,
  'a porta da edge não devolveu os 5 bloqueios');

select * from public.suspend_overdue_students(15);

select pg_temp.assert_true(
  (select status_financial from public.profiles where id = '00000000-0000-4000-8000-0000000c0b01') = 'ACTIVE',
  'aluno que pagou no Asaas foi suspenso');
select pg_temp.assert_true(
  (select status_financial from public.profiles where id = '00000000-0000-4000-8000-0000000c0b02') = 'ACTIVE',
  'aluno suspenso que pagou no Asaas continuou bloqueado');
select pg_temp.assert_true(
  (select status_financial from public.profiles where id = '00000000-0000-4000-8000-0000000c0b03') = 'SUSPENDED',
  'aluno realmente inadimplente deixou de ser suspenso');

rollback;
