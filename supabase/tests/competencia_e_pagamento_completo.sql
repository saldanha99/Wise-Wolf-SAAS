-- Financeiro por competência e pagamento completo (migration 20260914100000).
--
-- Regressões cobertas:
--   * fatura de vencimento em agosto paga no cartão e creditada em setembro
--     usava a agenda de SETEMBRO na caixinha — agora usa agosto;
--   * taxa de matrícula no mesmo mês da mensalidade descontava o mês duas vezes;
--   * pagamento de vários meses rateava tudo na hora e deixava os meses
--     seguintes sem caixinha e "pendentes" na cobrança e no fechamento;
--   * o painel Caixinha × Folha recalculava a caixinha em vez de ler o aviso.
--
-- Todos os nomes e valores são fictícios.

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
grant execute on function pg_temp.assert_true(boolean, text) to authenticated;

-------------------------------------------------------------------------------
-- Escola, equipe, alunos, agenda e aulas lançadas
-------------------------------------------------------------------------------
insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values
  ('fin-competencia-school', 'Fin Competencia School', 'fin-competencia-school', 'active', false),
  ('fin-competencia-other', 'Fin Competencia Other', 'fin-competencia-other', 'active', false);

insert into public.payment_split_settings (
  tenant_id, dizimo_pct, investimento_pct, escola_pct,
  prof_dizimo_pct, prof_investimento_pct, prof_prolabore_pct, is_active
) values ('fin-competencia-school', 10, 10, 0, 10, 70, 20, true);

insert into public.teacher_pay_tiers (tenant_id, min_students, rate)
values ('fin-competencia-school', 1, 8)
on conflict (tenant_id, min_students) do update set rate = 8;

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('5e000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'fincomp-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora Competencia"}', now(), now()),
  ('5e000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'fincomp-other-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretor Outra Escola"}', now(), now()),
  ('5e000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'fincomp-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professor Competencia"}', now(), now()),
  ('5e000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated', 'fincomp-s1@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Competencia Um"}', now(), now()),
  ('5e000000-0000-4000-8000-000000000012', 'authenticated', 'authenticated', 'fincomp-s2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Competencia Dois"}', now(), now()),
  ('5e000000-0000-4000-8000-000000000013', 'authenticated', 'authenticated', 'fincomp-s3@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Competencia Tres"}', now(), now()),
  ('5e000000-0000-4000-8000-000000000014', 'authenticated', 'authenticated', 'fincomp-s4@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Competencia Quatro"}', now(), now()),
  ('5e000000-0000-4000-8000-000000000015', 'authenticated', 'authenticated', 'fincomp-s5@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Competencia Cinco"}', now(), now()),
  ('5e000000-0000-4000-8000-000000000016', 'authenticated', 'authenticated', 'fincomp-s6@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Competencia Seis"}', now(), now());

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'fin-competencia-school', role = 'SCHOOL_ADMIN',
       status = 'Ativo', lifecycle_status = 'active'
 where id = '5e000000-0000-4000-8000-000000000001';
update public.profiles
   set tenant_id = 'fin-competencia-other', role = 'SCHOOL_ADMIN',
       status = 'Ativo', lifecycle_status = 'active'
 where id = '5e000000-0000-4000-8000-000000000002';
update public.profiles
   set tenant_id = 'fin-competencia-school', role = 'TEACHER',
       status = 'Ativo', lifecycle_status = 'active'
 where id = '5e000000-0000-4000-8000-000000000003';
update public.profiles
   set tenant_id = 'fin-competencia-school', role = 'STUDENT',
       status = 'Ativo', lifecycle_status = 'active',
       is_test_account = false, test_fixture_key = null, subscription_id = null,
       created_at = '2026-01-01 12:00:00+00',
       monthly_fee = case id
         when '5e000000-0000-4000-8000-000000000011'::uuid then 100
         when '5e000000-0000-4000-8000-000000000014'::uuid then 200
         when '5e000000-0000-4000-8000-000000000015'::uuid then 187
         when '5e000000-0000-4000-8000-000000000016'::uuid then 187
         else 0
       end
 where id in (
   '5e000000-0000-4000-8000-000000000011', '5e000000-0000-4000-8000-000000000012',
   '5e000000-0000-4000-8000-000000000013', '5e000000-0000-4000-8000-000000000014',
   '5e000000-0000-4000-8000-000000000015', '5e000000-0000-4000-8000-000000000016'
 );
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id in (
   '5e000000-0000-4000-8000-000000000001', '5e000000-0000-4000-8000-000000000002',
   '5e000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000011',
   '5e000000-0000-4000-8000-000000000012', '5e000000-0000-4000-8000-000000000013',
   '5e000000-0000-4000-8000-000000000014', '5e000000-0000-4000-8000-000000000015',
   '5e000000-0000-4000-8000-000000000016'
 );
insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
values
  ('5e000000-0000-4000-8000-000000000001', 'fin-competencia-school', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('5e000000-0000-4000-8000-000000000002', 'fin-competencia-other', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('5e000000-0000-4000-8000-000000000003', 'fin-competencia-school', 'TEACHER', 'ACTIVE', true),
  ('5e000000-0000-4000-8000-000000000011', 'fin-competencia-school', 'STUDENT', 'ACTIVE', true),
  ('5e000000-0000-4000-8000-000000000012', 'fin-competencia-school', 'STUDENT', 'ACTIVE', true),
  ('5e000000-0000-4000-8000-000000000013', 'fin-competencia-school', 'STUDENT', 'ACTIVE', true),
  ('5e000000-0000-4000-8000-000000000014', 'fin-competencia-school', 'STUDENT', 'ACTIVE', true),
  ('5e000000-0000-4000-8000-000000000015', 'fin-competencia-school', 'STUDENT', 'ACTIVE', true),
  ('5e000000-0000-4000-8000-000000000016', 'fin-competencia-school', 'STUDENT', 'ACTIVE', true);

-- Um dia fixo por aluno: em 2026 agosto tem 5 segundas e 4 de cada outro dia
-- útil; setembro tem 4 quintas; outubro tem 5 quintas; julho tem 5 sextas.
insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, status)
values
  ('5e000000-0000-4000-8000-0000000000b1', 'fin-competencia-school', '5e000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000011', 'Segunda', '10:00', 'SCHEDULED'),
  ('5e000000-0000-4000-8000-0000000000b2', 'fin-competencia-school', '5e000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000012', 'Quinta',  '11:00', 'SCHEDULED'),
  ('5e000000-0000-4000-8000-0000000000b3', 'fin-competencia-school', '5e000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000013', 'Terça',   '12:00', 'SCHEDULED'),
  ('5e000000-0000-4000-8000-0000000000b4', 'fin-competencia-school', '5e000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000014', 'Sexta',   '13:00', 'SCHEDULED'),
  ('5e000000-0000-4000-8000-0000000000b5', 'fin-competencia-school', '5e000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000015', 'Quarta',  '14:00', 'SCHEDULED');

-- Folha de agosto: aula lançada em todo dia da agenda (R$ 8 cada).
insert into public.class_logs (id, tenant_id, teacher_id, student_id, presence, date, class_date)
select gen_random_uuid(), 'fin-competencia-school', '5e000000-0000-4000-8000-000000000003',
       s.student_id, 'COMPLETED', d::date, d::date
  from (values
          ('5e000000-0000-4000-8000-000000000011'::uuid, 1),
          ('5e000000-0000-4000-8000-000000000013'::uuid, 2),
          ('5e000000-0000-4000-8000-000000000014'::uuid, 5),
          ('5e000000-0000-4000-8000-000000000015'::uuid, 3)
       ) as s(student_id, dow)
  cross join generate_series(date '2026-08-01', date '2026-08-31', interval '1 day') as d
 where extract(dow from d)::int = s.dow;

-- Aulas recentes (nunca em agosto/2026) e uma aula antiga que abre o relógio
-- do serviço do aluno Seis.
insert into public.class_logs (id, tenant_id, teacher_id, student_id, presence, date, class_date)
values
  (gen_random_uuid(), 'fin-competencia-school', '5e000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000011', 'COMPLETED',
   greatest(current_date - 3, date '2026-09-02'), greatest(current_date - 3, date '2026-09-02')),
  (gen_random_uuid(), 'fin-competencia-school', '5e000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000016', 'COMPLETED',
   greatest(current_date - 3, date '2026-09-02'), greatest(current_date - 3, date '2026-09-02')),
  (gen_random_uuid(), 'fin-competencia-school', '5e000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000016', 'COMPLETED',
   date '2026-01-05', date '2026-01-05');

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, status,
  due_date, payment_date, paid_at, payment_type, billing_type, description
) values
  -- P1: vence em agosto, cartão creditado em setembro.
  ('5e000000-0000-4000-8000-0000000000a1', '5e000000-0000-4000-8000-000000000011', 'fin-competencia-school', 'pay_fincomp_p1', 100.00, 'RECEIVED',
   '2026-08-05', '2026-09-08', '2026-09-08 12:00:00+00', 'SUBSCRIPTION', 'CREDIT_CARD', 'Mensalidade'),
  -- P2: vence e é pago em setembro.
  ('5e000000-0000-4000-8000-0000000000a2', '5e000000-0000-4000-8000-000000000011', 'fin-competencia-school', 'pay_fincomp_p2', 100.00, 'RECEIVED',
   '2026-09-10', '2026-09-09', '2026-09-09 12:00:00+00', 'SUBSCRIPTION', 'PIX', 'Mensalidade'),
  -- P3: taxa de matrícula no mesmo mês de competência de P1.
  ('5e000000-0000-4000-8000-0000000000a3', '5e000000-0000-4000-8000-000000000011', 'fin-competencia-school', 'pay_fincomp_p3', 59.90, 'RECEIVED',
   '2026-08-05', '2026-08-05', '2026-08-05 12:00:00+00', 'ENROLLMENT', 'PIX', 'Taxa de Matrícula'),
  -- P4: seis meses de uma vez.
  ('5e000000-0000-4000-8000-0000000000a4', '5e000000-0000-4000-8000-000000000012', 'fin-competencia-school', 'pay_fincomp_p4', 1300.00, 'RECEIVED',
   '2026-09-08', '2026-09-08', '2026-09-08 12:00:00+00', 'SUBSCRIPTION', 'PIX', 'Pagamento de seis meses'),
  -- P5: três meses, já rateado inteiro no aviso de julho.
  ('5e000000-0000-4000-8000-0000000000a5', '5e000000-0000-4000-8000-000000000014', 'fin-competencia-school', 'pay_fincomp_p5', 600.00, 'RECEIVED',
   '2026-07-10', '2026-07-10', '2026-07-10 12:00:00+00', 'SUBSCRIPTION', 'PIX', 'Pagamento de tres meses'),
  -- P7: mensalidade de agosto cujo aviso nunca saiu.
  ('5e000000-0000-4000-8000-0000000000a7', '5e000000-0000-4000-8000-000000000015', 'fin-competencia-school', 'pay_fincomp_p7', 187.00, 'RECEIVED',
   '2026-08-10', '2026-08-10', '2026-08-10 12:00:00+00', 'SUBSCRIPTION', 'PIX', 'Mensalidade'),
  -- P8: boleto velho de setembro de quem já pagou setembro no pacote.
  ('5e000000-0000-4000-8000-0000000000a8', '5e000000-0000-4000-8000-000000000014', 'fin-competencia-school', 'pay_fincomp_p8', 200.00, 'PENDING',
   '2026-09-10', null, null, 'SUBSCRIPTION', 'BOLETO', 'Mensalidade');

-- Os avisos que o grupo LEU (snapshot congelado). O de P1 saiu com a agenda
-- de setembro (4 segundas = R$ 32): é esse número que foi separado.
insert into public.management_payment_notification_outbox (
  tenant_id, payment_id, notification_kind, status, claim_token, lease_expires_at,
  submit_attempt_count, configured_destination_snapshot, provider_destination,
  provider_instance_name, provider_integration_id, provider_integration_version,
  provider_endpoint_hash, provider_credential_hash, message_body,
  source_snapshot, source_snapshot_hash, snapshot_hash, last_error,
  provider_message_id, provider_delivery_status, delivered_at
)
select 'fin-competencia-school', s.payment_id, 'PAYMENT_SPLIT', 'SENT', gen_random_uuid(),
       now() + interval '5 minutes', 1, '120363000000000001@g.us', '120363000000000001@g.us',
       'fincomp-test', gen_random_uuid(), 1, repeat('a', 64), repeat('b', 64), 'aviso de teste',
       s.snap, repeat('c', 64), repeat('d', 64), null,
       'fixture_' || s.payment_id::text, 'delivered', now()
  from (values
          ('5e000000-0000-4000-8000-0000000000a1'::uuid,
           jsonb_build_object('tenant_id', 'fin-competencia-school', 'month', '2026-09',
             'professores', jsonb_build_array(jsonb_build_object(
               'teacher_id', '5e000000-0000-4000-8000-000000000003', 'aulas', 4,
               'custo', 32.00, 'descontado', true)))),
          ('5e000000-0000-4000-8000-0000000000a5'::uuid,
           jsonb_build_object('tenant_id', 'fin-competencia-school', 'month', '2026-07',
             'professores', jsonb_build_array(jsonb_build_object(
               'teacher_id', '5e000000-0000-4000-8000-000000000003', 'aulas', 5,
               'custo', 40.00, 'descontado', true))))
       ) as s(payment_id, snap)
on conflict (tenant_id, payment_id) do update
   set notification_kind = excluded.notification_kind,
       status = excluded.status,
       claim_token = excluded.claim_token,
       lease_expires_at = excluded.lease_expires_at,
       submit_attempt_count = excluded.submit_attempt_count,
       configured_destination_snapshot = excluded.configured_destination_snapshot,
       provider_destination = excluded.provider_destination,
       provider_instance_name = excluded.provider_instance_name,
       provider_integration_id = excluded.provider_integration_id,
       provider_integration_version = excluded.provider_integration_version,
       provider_endpoint_hash = excluded.provider_endpoint_hash,
       provider_credential_hash = excluded.provider_credential_hash,
       message_body = excluded.message_body,
       source_snapshot = excluded.source_snapshot,
       source_snapshot_hash = excluded.source_snapshot_hash,
       snapshot_hash = excluded.snapshot_hash,
       provider_message_id = excluded.provider_message_id,
       provider_delivery_status = excluded.provider_delivery_status,
       delivered_at = excluded.delivered_at,
       last_error = null;

create temporary table fincomp_b (k text primary key, b jsonb not null);

-------------------------------------------------------------------------------
-- 1. Competência pelo vencimento
-------------------------------------------------------------------------------
select pg_temp.assert_true(
  private.payment_competencia('5e000000-0000-4000-8000-0000000000a1') = date '2026-08-01'
  and private.payment_competencia('5e000000-0000-4000-8000-0000000000a2') = date '2026-09-01',
  'competência não seguiu o vencimento');

insert into fincomp_b values
  ('p1', public.payment_split_breakdown('5e000000-0000-4000-8000-0000000000a1')),
  ('p2', public.payment_split_breakdown('5e000000-0000-4000-8000-0000000000a2')),
  ('p3', public.payment_split_breakdown('5e000000-0000-4000-8000-0000000000a3')),
  ('p4_antes', public.payment_split_breakdown('5e000000-0000-4000-8000-0000000000a4'));

select pg_temp.assert_true(
  (select b ->> 'month' = '2026-08'
      and b ->> 'competencia' = '2026-08'
      and b ->> 'vencimento' = '2026-08-05'
      and (b ->> 'aulas_previstas')::int = 5
      and (b ->> 'custo_professor')::numeric = 40.00
      and (b ->> 'meses')::int = 1
      and (b ->> 'reservado')::numeric = 0
      and (b ->> 'recebido_total')::numeric = 100.00
     from fincomp_b where k = 'p1'),
  'cartão de agosto creditado em setembro não usou a agenda de agosto');
select pg_temp.assert_true(
  (select b ->> 'month' = '2026-09'
      and (b ->> 'aulas_previstas')::int = 4
      and (b ->> 'custo_professor')::numeric = 32.00
     from fincomp_b where k = 'p2'),
  'pagamento de setembro mudou de agenda');

-------------------------------------------------------------------------------
-- 2. Taxa de matrícula não gera caixinha
-------------------------------------------------------------------------------
select pg_temp.assert_true(
  (select (b ->> 'eh_matricula')::boolean
      and (b ->> 'custo_professor')::numeric = 0
      and jsonb_array_length(b -> 'professores') = 0
      and (b ->> 'liquido')::numeric = 59.90
      and (b ->> 'dizimo')::numeric + (b ->> 'investimento')::numeric
          + (b ->> 'pro_labore')::numeric + (b ->> 'sobra')::numeric = 59.90
      and b ->> 'regra' = 'professor'
     from fincomp_b where k = 'p3'),
  'taxa de matrícula descontou caixinha');
select pg_temp.assert_true(
  private.payment_is_enrollment_fee('SUBSCRIPTION', 'Taxa de Matrícula - turma A')
  and private.payment_is_enrollment_fee('SUBSCRIPTION', '  MATRICULA')
  and private.payment_is_enrollment_fee('ENROLLMENT', null)
  and not private.payment_is_enrollment_fee('SUBSCRIPTION', 'Taxa de cancelamento')
  and not private.payment_is_enrollment_fee('SUBSCRIPTION', 'Mensalidade de agosto'),
  'classificação de matrícula');

-------------------------------------------------------------------------------
-- 3. Pagamento completo MENSAL
-------------------------------------------------------------------------------
select pg_temp.assert_true(
  (select (b ->> 'valor')::numeric = 1300.00 and b ->> 'modo' is null
     from fincomp_b where k = 'p4_antes'),
  'pagamento sem parcelas deixou de ratear o valor cheio');

insert into fincomp_b values
  ('reg_p4', public.register_prepayment('5e000000-0000-4000-8000-0000000000a4', date '2026-09-01', 6, 'MENSAL'));
select pg_temp.assert_true(
  (select (b ->> 'ok')::boolean and not (b ->> 'already_registered')::boolean
      and b ->> 'ultima_competencia' = '2027-02'
     from fincomp_b where k = 'reg_p4'),
  'register_prepayment MENSAL falhou');
select pg_temp.assert_true(
  (select count(*) = 6 and sum(valor) = 1300.00
          and array_agg(valor order by sequencia)
              = array[216.67, 216.67, 216.67, 216.67, 216.66, 216.66]::numeric[]
          and bool_and(origem = 'ASAAS' and modo = 'MENSAL' and grupo_id = payment_id)
     from public.student_payment_allocations
    where payment_id = '5e000000-0000-4000-8000-0000000000a4' and status = 'ACTIVE'),
  'parcelas não somam o total ao centavo');

-- Idempotência e recusa de parâmetros diferentes.
select pg_temp.assert_true(
  (public.register_prepayment('5e000000-0000-4000-8000-0000000000a4', date '2026-09-01', 6, 'MENSAL')
     ->> 'already_registered')::boolean
  and (select count(*) from public.student_payment_allocations
        where payment_id = '5e000000-0000-4000-8000-0000000000a4') = 6
  and public.register_prepayment('5e000000-0000-4000-8000-0000000000a4', date '2026-09-01', 5, 'MENSAL')
        ->> 'error' = 'pagamento_ja_tem_parcelas',
  'repetir o registro duplicou ou aceitou outro parcelamento');

-- Cancelar preserva o ciclo antigo; recadastrar cria novas linhas auditáveis.
-- ⚠️ Cada passo num statement próprio: um SELECT não enxerga o que as funções
-- chamadas por ele gravaram (o snapshot é o do início do statement). Juntar
-- cancelar + registrar + contar numa asserção só falha mesmo com a função certa.
insert into fincomp_b values
  ('cancel_p4', public.cancel_prepayment('5e000000-0000-4000-8000-0000000000a4'));
select pg_temp.assert_true(
  (select (b ->> 'ok')::boolean and (b ->> 'cancelled')::int = 6
     from fincomp_b where k = 'cancel_p4')
  and (select paid_through is null and prepaid_months is null
         from public.profiles where id = '5e000000-0000-4000-8000-000000000012')
  and (select count(*) = 6 and bool_and(status = 'CANCELLED' and cancelled_at is not null)
         from public.student_payment_allocations
        where payment_id = '5e000000-0000-4000-8000-0000000000a4'),
  'cancelar não desfez as parcelas nem o perfil');
select pg_temp.assert_true(
  (public.cancel_prepayment('5e000000-0000-4000-8000-0000000000a4') ->> 'already_cancelled')::boolean,
  'cancelar duas vezes não foi idempotente');

-- Registrar de novo com OUTRO parcelamento: cinco meses no mês do recebimento.
-- O ciclo antigo não é sobrescrito, e o índice de mês ativo não reclama.
insert into fincomp_b values
  ('reg_p4_5m', public.register_prepayment('5e000000-0000-4000-8000-0000000000a4', date '2026-09-01', 5, 'MENSAL'));
select pg_temp.assert_true(
  (select (b ->> 'ok')::boolean and not (b ->> 'already_registered')::boolean
     from fincomp_b where k = 'reg_p4_5m')
  and (select count(*) = 11 from public.student_payment_allocations
        where payment_id = '5e000000-0000-4000-8000-0000000000a4')
  and (select count(*) = 5 and sum(valor) = 1300.00 and min(competencia) = date '2026-09-01'
              and array_agg(sequencia order by competencia) = array[1, 2, 3, 4, 5]
         from public.student_payment_allocations
        where payment_id = '5e000000-0000-4000-8000-0000000000a4' and status = 'ACTIVE')
  and (select count(*) = 6 from public.student_payment_allocations
        where payment_id = '5e000000-0000-4000-8000-0000000000a4'
          and status = 'CANCELLED'),
  'recadastro não preservou as linhas do ciclo cancelado');
insert into fincomp_b values
  ('cancel_p4_5m', public.cancel_prepayment('5e000000-0000-4000-8000-0000000000a4'));

-- E de volta ao parcelamento original.
insert into fincomp_b values
  ('reg_p4_de_novo', public.register_prepayment('5e000000-0000-4000-8000-0000000000a4', date '2026-09-01', 6, 'MENSAL'));
select pg_temp.assert_true(
  (select (b ->> 'cancelled')::int = 5 from fincomp_b where k = 'cancel_p4_5m')
  and (select (b ->> 'ok')::boolean and not (b ->> 'already_registered')::boolean
         from fincomp_b where k = 'reg_p4_de_novo')
  and (select count(*) from public.student_payment_allocations
        where payment_id = '5e000000-0000-4000-8000-0000000000a4') = 17
  and (select count(*) from public.student_payment_allocations
        where payment_id = '5e000000-0000-4000-8000-0000000000a4' and status = 'ACTIVE') = 6
  and (select array_agg(valor order by sequencia)
              = array[216.67, 216.67, 216.67, 216.67, 216.66, 216.66]::numeric[]
              and bool_and(cancelled_at is null and cancelled_by is null)
         from public.student_payment_allocations
        where payment_id = '5e000000-0000-4000-8000-0000000000a4' and status = 'ACTIVE'),
  'cancelar e registrar de novo perdeu o histórico ou duplicou parcelas ativas');

select pg_temp.assert_true(
  (select paid_through is null and prepaid_months is null and monthly_fee = 0
     from public.profiles where id = '5e000000-0000-4000-8000-000000000012'),
  'o parcelamento alterou o perfil ou inferiu uma mensalidade contratada');

insert into fincomp_b values
  ('p4', public.payment_split_breakdown('5e000000-0000-4000-8000-0000000000a4')),
  ('p4_out', public.payment_split_installment(
     (select id from public.student_payment_allocations
       where payment_id = '5e000000-0000-4000-8000-0000000000a4'
         and competencia = date '2026-10-01' and status = 'ACTIVE'))),
  ('p4_fev', public.payment_split_installment(
     (select id from public.student_payment_allocations
       where payment_id = '5e000000-0000-4000-8000-0000000000a4'
         and competencia = date '2027-02-01' and status = 'ACTIVE')));

-- O aviso do recebimento rateia a 1ª parcela e diz que o resto está guardado.
select pg_temp.assert_true(
  (select (b ->> 'valor')::numeric = 216.67
      and (b ->> 'parcela')::numeric = 216.67
      and (b ->> 'recebido_total')::numeric = 1300.00
      and (b ->> 'reservado')::numeric = 1083.33
      and (b ->> 'meses')::int = 6
      and (b ->> 'sequencia')::int = 1
      and b ->> 'modo' = 'MENSAL'
      and b ->> 'month' = '2026-09'
      and b ->> 'cobertura_fim' = '2027-02'
      and (b ->> 'aulas_previstas')::int = 4
      and (b ->> 'custo_professor')::numeric = 32.00
      and (b ->> 'liquido')::numeric = 184.67
      and (b ->> 'dizimo')::numeric + (b ->> 'investimento')::numeric
          + (b ->> 'pro_labore')::numeric + (b ->> 'sobra')::numeric = 184.67
     from fincomp_b where k = 'p4'),
  'o aviso do pagamento completo não rateou só a 1ª parcela');

-- Parcela de outubro: agenda de OUTUBRO (5 quintas), dinheiro recebido em setembro.
select pg_temp.assert_true(
  (select b ->> 'month' = '2026-10'
      and (b ->> 'aulas_previstas')::int = 5
      and (b ->> 'custo_professor')::numeric = 40.00
      and (b ->> 'valor')::numeric = 216.67
      and (b ->> 'recebido_total')::numeric = 1300.00
      and b ->> 'recebido_em' = '2026-09-08'
      and (b ->> 'sequencia')::int = 2
      and (b ->> 'reservado')::numeric = 866.66
     from fincomp_b where k = 'p4_out'),
  'parcela do mês 2 não usou a agenda do mês 2');
select pg_temp.assert_true(
  (select (b ->> 'valor')::numeric = 216.66 and (b ->> 'reservado')::numeric = 0
     from fincomp_b where k = 'p4_fev'),
  'a última parcela não zerou a reserva');

-- Relatório: caixa pelo valor cheio, rateio pela parcela.
insert into fincomp_b values
  ('rel_set', public.payment_split_report('2026-09', 'fin-competencia-school')),
  ('rel_out', public.payment_split_report('2026-10', 'fin-competencia-school'));
select pg_temp.assert_true(
  (select (b #>> '{totais,recebido}')::numeric = 1500.00
      and (b #>> '{totais,reservado}')::numeric = 1083.33
      and (b #>> '{totais,pagamentos}')::int = 3
     from fincomp_b where k = 'rel_set'),
  'relatório de setembro não contou o valor cheio no caixa');
select pg_temp.assert_true(
  (select (r.b #>> '{totais,recebido}')::numeric = 0
      and (r.b #>> '{totais,parcelas}')::int = 1
      and (r.b #>> '{totais,liberado_de_reserva}')::numeric = 216.67
      and (r.b #>> '{totais,dizimo}')::numeric = (i.b ->> 'dizimo')::numeric
     from fincomp_b r, fincomp_b i where r.k = 'rel_out' and i.k = 'p4_out'),
  'relatório de outubro não rateou a parcela do mês');

-------------------------------------------------------------------------------
-- 4. LEGADO: pagamento completo já rateado no aviso
-------------------------------------------------------------------------------
select pg_temp.assert_true(
  public.register_prepayment('5e000000-0000-4000-8000-0000000000a5', date '2026-07-01', 3, 'MENSAL')
    ->> 'error' = 'aviso_do_rateio_ja_saiu'
  and not exists (select 1 from public.student_payment_allocations
                   where payment_id = '5e000000-0000-4000-8000-0000000000a5'),
  'MENSAL aceito depois de o grupo ler o rateio do valor cheio');
select pg_temp.assert_true(
  (public.register_prepayment('5e000000-0000-4000-8000-0000000000a5', date '2026-07-01', 3, 'LEGADO') ->> 'ok')::boolean,
  'LEGADO recusado');
insert into fincomp_b values
  ('p5', public.payment_split_breakdown('5e000000-0000-4000-8000-0000000000a5'));
select pg_temp.assert_true(
  (select (b ->> 'valor')::numeric = 600.00
      and (b ->> 'parcela')::numeric = 600.00
      and (b ->> 'reservado')::numeric = 0
      and (b ->> 'meses')::int = 3
      and b ->> 'modo' = 'LEGADO'
      and b ->> 'month' = '2026-07'
      and (b ->> 'custo_professor')::numeric = 40.00
     from fincomp_b where k = 'p5')
  and public.payment_split_installment(
        (select id from public.student_payment_allocations
          where payment_id = '5e000000-0000-4000-8000-0000000000a5'
            and competencia = date '2026-08-01'))
      ->> 'error' = 'parcela_legado_sem_rateio',
  'LEGADO mudou o rateio do recebimento ou rateou de novo');

-- Recebido fora do Asaas: só parcelas, sem caixa.
create temporary table fincomp_caixa as
select count(*) as n from public.financial_transactions where tenant_id = 'fin-competencia-school';
insert into fincomp_b values
  ('ext_s3', public.register_external_prepayment(
     '5e000000-0000-4000-8000-000000000013', 2244.00, date '2026-02-17',
     date '2026-02-01', 12, 'LEGADO', 'recebido por fora'));
select pg_temp.assert_true(
  (select (b ->> 'ok')::boolean from fincomp_b where k = 'ext_s3')
  and (select count(*) = 12 and sum(valor) = 2244.00 and bool_and(valor = 187.00)
              and bool_and(payment_id is null and origem = 'EXTERNO' and modo = 'LEGADO')
         from public.student_payment_allocations
        where student_id = '5e000000-0000-4000-8000-000000000013' and status = 'ACTIVE')
  and (select n from fincomp_caixa) =
      (select count(*) from public.financial_transactions where tenant_id = 'fin-competencia-school')
  and (public.register_external_prepayment(
         '5e000000-0000-4000-8000-000000000013', 2244.00, date '2026-02-17',
         date '2026-02-01', 12, 'LEGADO', 'recebido por fora') ->> 'grupo_id')
      = (select b ->> 'grupo_id' from fincomp_b where k = 'ext_s3')
  and (select count(*) from public.student_payment_allocations
        where student_id = '5e000000-0000-4000-8000-000000000013') = 12,
  'pagamento externo não ficou só nas parcelas ou duplicou');

-- Aluno com mensalidade zerada e mês coberto: precisa entrar no rol.
set local app.enrollment_claim = '1';
update public.profiles set monthly_fee = 0 where id = '5e000000-0000-4000-8000-000000000013';
set local app.enrollment_claim = '';

-------------------------------------------------------------------------------
-- 5. Um mês não pode ser coberto duas vezes
-------------------------------------------------------------------------------
select pg_temp.assert_true(
  public.register_external_prepayment(
    '5e000000-0000-4000-8000-000000000012', 400.00, date '2026-09-01',
    date '2026-10-01', 2, 'LEGADO', null) ->> 'error' = 'mes_ja_coberto',
  'RPC aceitou cobrir um mês já coberto');
do $$
begin
  begin
    insert into public.student_payment_allocations (
      tenant_id, grupo_id, payment_id, student_id, competencia, sequencia,
      meses, valor, modo, origem
    ) values (
      'fin-competencia-school', gen_random_uuid(), null,
      '5e000000-0000-4000-8000-000000000012', date '2026-10-01', 1, 2, 10.00,
      'LEGADO', 'EXTERNO'
    );
    raise exception 'o índice deixou o mesmo mês ser coberto duas vezes';
  exception when unique_violation then
    null;
  end;
end;
$$;

-------------------------------------------------------------------------------
-- 6. Fechamento da caixinha: avisado × folha
-------------------------------------------------------------------------------
insert into fincomp_b values
  ('cx_ago', public.caixinha_fechamento('2026-08', 'fin-competencia-school')),
  ('cx_out', public.caixinha_fechamento('2026-10', 'fin-competencia-school'));

-- Professor: folha 40+32+32+32 = 136. Caixinha confirmada: P1 (32).
-- P7 é somente previsão (32), separada; LEGADO não reserva em agosto.
select pg_temp.assert_true(
  (select b ->> 'tenant' = 'fin-competencia-school'
      and (b #>> '{totais,folha}')::numeric = 136.00
      and (b #>> '{totais,caixinha}')::numeric = 32.00
      and (b #>> '{totais,caixinha_sem_aviso}')::numeric = 32.00
      and (b #>> '{totais,diferenca}')::numeric = 104.00
      and (b #>> '{totais,completar}')::numeric = 104.00
      and (b #>> '{totais,devolver}')::numeric = 0
      and b #>> '{professores,0,acao}' = 'COMPLETAR'
     from fincomp_b where k = 'cx_ago'),
  'totais do fechamento de agosto');

create temporary table fincomp_itens as
select item ->> 'aluno' as aluno, item ->> 'motivo' as motivo,
       (item ->> 'folha')::numeric as folha, (item ->> 'caixinha')::numeric as caixinha,
       (item ->> 'diferenca')::numeric as diferenca, (item ->> 'avisos')::int as avisos,
       (item ->> 'sem_aviso')::boolean as sem_aviso
  from fincomp_b
  cross join lateral jsonb_array_elements(b #> '{professores,0,itens}') as item
 where k = 'cx_ago';

select pg_temp.assert_true(
  (select count(*) = 4 from fincomp_itens)
  -- Avisado (32, agenda de SETEMBRO — regra antiga), não recalculado (40); o
  -- motivo diz que o aviso usou outro mês; e a matrícula não virou 2º aviso.
  and exists (select 1 from fincomp_itens where aluno = 'Aluno Competencia Um'
                and motivo = 'AVISO_DE_OUTRO_MES' and caixinha = 32.00
                and folha = 40.00 and diferenca = 8.00 and avisos = 1)
  and exists (select 1 from fincomp_itens where aluno = 'Aluno Competencia Tres'
                and motivo = 'PREPAGO_SEM_RESERVA' and caixinha = 0 and diferenca = 32.00)
  and exists (select 1 from fincomp_itens where aluno = 'Aluno Competencia Quatro'
                and motivo = 'PREPAGO_SEM_RESERVA' and caixinha = 0 and diferenca = 32.00)
  and exists (select 1 from fincomp_itens where aluno = 'Aluno Competencia Cinco'
                and motivo = 'SEM_AVISO' and sem_aviso and caixinha = 0 and diferenca = 32),
  'motivos do fechamento de agosto');

-- Outubro: sem entrega confirmada, a parcela 2 é somente previsão.
select pg_temp.assert_true(
  exists (
    select 1
      from fincomp_b
      cross join lateral jsonb_array_elements(b #> '{professores,0,itens}') as item
     where k = 'cx_out'
       and item ->> 'aluno' = 'Aluno Competencia Dois'
       and (item ->> 'caixinha')::numeric = 0
       and (item ->> 'caixinha_sem_aviso')::numeric = 40.00
       and (item ->> 'sem_aviso')::boolean
  ),
  'parcela MENSAL sem aviso foi tratada como reserva confirmada');

-------------------------------------------------------------------------------
-- 7. Mês coberto não é pendência
-------------------------------------------------------------------------------
select public.refresh_monthly_payment_closure('fin-competencia-school', date '2026-08-01');
select public.refresh_monthly_payment_closure('fin-competencia-school', date '2026-09-01');

select pg_temp.assert_true(
  (select status = 'SETTLED' and roster_source = 'ACTIVE_ROSTER' and expected_amount = 187.00
      and settled_amount = 187.00
      and details #>> '{prepaid_coverage,reason}' = 'PREPAID_COVERAGE'
     from public.monthly_payment_obligations
    where tenant_id = 'fin-competencia-school' and period_start = date '2026-08-01'
      and student_id = '5e000000-0000-4000-8000-000000000013'),
  'aluno com mensalidade zerada e mês coberto ficou fora do rol ou pendente');
select pg_temp.assert_true(
  (select status = 'SETTLED' from public.monthly_payment_obligations
    where tenant_id = 'fin-competencia-school' and period_start = date '2026-08-01'
      and student_id = '5e000000-0000-4000-8000-000000000014')
  and (select status = 'SETTLED' from public.monthly_payment_obligations
        where tenant_id = 'fin-competencia-school' and period_start = date '2026-08-01'
          and student_id = '5e000000-0000-4000-8000-000000000011'),
  'mês coberto por LEGADO continuou pendente');
select pg_temp.assert_true(
  (select status = 'SETTLED' and settled_amount = 216.67
     from public.monthly_payment_obligations
    where tenant_id = 'fin-competencia-school' and period_start = date '2026-09-01'
      and student_id = '5e000000-0000-4000-8000-000000000012'),
  'o pagamento completo contou como 1 mês de R$ 1.300 em vez da parcela');
select pg_temp.assert_true(
  (select status = 'REVIEW'
      and details #>> '{prepaid_coverage,reason}' = 'PREPAID_COVERAGE_WITH_LIVE_INVOICE'
     from public.monthly_payment_obligations
    where tenant_id = 'fin-competencia-school' and period_start = date '2026-09-01'
      and student_id = '5e000000-0000-4000-8000-000000000014'),
  'cobrança em dobro de mês coberto não foi para revisão');

-- Cobrança e inadimplência não contam o boleto de mês já pago.
-- P9: boleto VENCIDO de agosto de quem pagou jul..set no pacote (coberto).
-- P10: boleto vencido de julho de quem NÃO tem cobertura — tem de continuar
-- contando, senão o filtro passaria sem provar nada.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, value, status,
  due_date, payment_type, billing_type, description
) values
  ('5e000000-0000-4000-8000-0000000000a9', '5e000000-0000-4000-8000-000000000014', 'fin-competencia-school', 'pay_fincomp_p9', 200.00, 'OVERDUE',
   '2026-08-10', 'SUBSCRIPTION', 'BOLETO', 'Mensalidade'),
  ('5e000000-0000-4000-8000-0000000000aa', '5e000000-0000-4000-8000-000000000011', 'fin-competencia-school', 'pay_fincomp_p10', 100.00, 'OVERDUE',
   '2026-07-10', 'SUBSCRIPTION', 'BOLETO', 'Mensalidade');

select pg_temp.assert_true(
  private.student_payment_provider_block_reason('5e000000-0000-4000-8000-0000000000a8')
    = 'mes_coberto_por_pagamento_completo'
  and private.student_payment_provider_block_reason('5e000000-0000-4000-8000-0000000000a9')
    = 'mes_coberto_por_pagamento_completo'
  and private.student_payment_provider_block_reason('5e000000-0000-4000-8000-0000000000aa') is null,
  'régua de cobrança continuaria cobrando mês coberto (ou parou de cobrar o descoberto)');
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  (public.gestao_financial_context('fin-competencia-school', '2026-09') ->> 'a_receber_no_mes')::numeric = 0
  and (public.gestao_financial_context('fin-competencia-school', '2026-09') #>> '{inadimplencia,count}')::int = 1
  and (public.gestao_financial_context('fin-competencia-school', '2026-09') #>> '{inadimplencia,total}')::numeric = 100.00,
  'mês coberto apareceu como a receber ou como inadimplência');
set local request.jwt.claims = '';
select pg_temp.assert_true(
  (select (d ->> 'overdue_count')::int = 1 and (d ->> 'overdue_amount')::numeric = 100.00
     from jsonb_array_elements(public.weekly_digest_rows()) as d
    where d ->> 'tenant_id' = 'fin-competencia-school'),
  'resumo semanal contou como vencido o boleto de mês coberto');

-- Aluno Seis: mês corrente coberto por pagamento externo.
insert into fincomp_b values
  ('ext_s6', public.register_external_prepayment(
     '5e000000-0000-4000-8000-000000000016', 374.00,
     (now() at time zone 'America/Sao_Paulo')::date,
     date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date,
     2, 'LEGADO', null));
select pg_temp.assert_true(
  (select (b ->> 'ok')::boolean from fincomp_b where k = 'ext_s6')
  and exists (
    select 1 from jsonb_array_elements(public.alunos_sem_assinatura('fin-competencia-school') -> 'detalhe') as d
     where d ->> 'aluno' = 'Aluno Competencia Um')
  and not exists (
    select 1 from jsonb_array_elements(public.alunos_sem_assinatura('fin-competencia-school') -> 'detalhe') as d
     where d ->> 'aluno' = 'Aluno Competencia Seis')
  and not exists (
    select 1 from jsonb_array_elements(public.financial_reconciliation('fin-competencia-school') #> '{sem_cobertura,itens}') as d
     where d ->> 'student_id' = '5e000000-0000-4000-8000-000000000016'),
  'aluno com o mês coberto apareceu como sem assinatura ou sem cobertura');
-- Cancelar num statement e conferir no seguinte (ver o aviso da seção 3).
insert into fincomp_b values
  ('cancel_s6', public.cancel_prepayment(
     (select (b ->> 'grupo_id')::uuid from fincomp_b where k = 'ext_s6')));
select pg_temp.assert_true(
  (select (b ->> 'cancelled')::int = 2 from fincomp_b where k = 'cancel_s6')
  and (select paid_through is null from public.profiles where id = '5e000000-0000-4000-8000-000000000016')
  and exists (
    select 1 from jsonb_array_elements(public.alunos_sem_assinatura('fin-competencia-school') -> 'detalhe') as d
     where d ->> 'aluno' = 'Aluno Competencia Seis')
  and exists (
    select 1 from jsonb_array_elements(public.financial_reconciliation('fin-competencia-school') #> '{sem_cobertura,itens}') as d
     where d ->> 'student_id' = '5e000000-0000-4000-8000-000000000016'),
  'cancelar a cobertura não devolveu o aluno aos alertas');

-------------------------------------------------------------------------------
-- 8. Permissões
-------------------------------------------------------------------------------
select pg_temp.assert_true(
  not has_table_privilege('authenticated', 'public.student_payment_allocations', 'INSERT')
  and not has_table_privilege('authenticated', 'public.student_payment_allocations', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.student_payment_allocations', 'DELETE')
  and has_table_privilege('authenticated', 'public.student_payment_allocations', 'SELECT')
  and not has_table_privilege('anon', 'public.student_payment_allocations', 'SELECT')
  and not has_function_privilege('anon', 'public.register_prepayment(uuid,date,integer,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.payment_split_rateio(text,uuid,numeric,text,boolean)', 'EXECUTE'),
  'privilégios da tabela de parcelas ou das funções');

select set_config(
  'fincomp.parcela_outubro',
  (select id::text from public.student_payment_allocations
    where payment_id = '5e000000-0000-4000-8000-0000000000a4'
      and competencia = date '2026-10-01' and status = 'ACTIVE'),
  true
);

set local role authenticated;

-- Diretora da escola: lê as parcelas, não grava direto, e o painel bate com o fechamento.
set local request.jwt.claims =
  '{"sub":"5e000000-0000-4000-8000-000000000001","role":"authenticated"}';
select pg_temp.assert_true(
  (select count(*) from public.student_payment_allocations) > 0,
  'a diretora não lê as parcelas da própria escola');
do $$
begin
  begin
    insert into public.student_payment_allocations (
      tenant_id, grupo_id, payment_id, student_id, competencia, sequencia,
      meses, valor, modo, origem
    ) values (
      'fin-competencia-school', gen_random_uuid(), null,
      '5e000000-0000-4000-8000-000000000011', date '2027-06-01', 1, 2, 10.00,
      'LEGADO', 'EXTERNO'
    );
    raise exception 'authenticated gravou direto na tabela de parcelas';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;
select pg_temp.assert_true(
  (public.teacher_payroll_reconciliation('2026-08') #>> '{totais,caixinha}')::numeric = 32.00
  and (public.teacher_payroll_reconciliation('2026-08') #>> '{totais,folha}')::numeric = 136.00
  and (public.teacher_payroll_reconciliation('2026-08') #> '{professores,0}') ?& array[
        'teacher_id', 'teacher_name', 'previsto', 'previsto_aulas', 'folha', 'folha_aulas',
        'status', 'pro_labore', 'caixinha', 'diferenca', 'sobras', 'ajustes', 'turbo', 'itens']
  and (public.teacher_payroll_reconciliation('2026-08') #>> '{professores,0,previsto}')::numeric = 168.00
  and (public.payment_split_installment(current_setting('fincomp.parcela_outubro')::uuid)
        ->> 'custo_professor')::numeric = 40.00,
  'painel Caixinha × Folha divergiu do fechamento ou perdeu chaves');
-- Fluxo de Caixa do diretor: mesma régua do assistente da gestão.
select pg_temp.assert_true(
  (public.get_cashflow('2026-09') ->> 'a_receber')::numeric = 0
  and (public.get_cashflow('2026-09') #>> '{inadimplencia,count}')::int = 1
  and (public.get_cashflow('2026-09') #>> '{inadimplencia,total}')::numeric = 100.00,
  'Fluxo de Caixa contou mês coberto como a receber ou inadimplência');

-- Diretor de outra escola: nada vaza e nada grava.
set local request.jwt.claims =
  '{"sub":"5e000000-0000-4000-8000-000000000002","role":"authenticated"}';
select pg_temp.assert_true(
  (select count(*) from public.student_payment_allocations) = 0
  and public.register_prepayment('5e000000-0000-4000-8000-0000000000a2', date '2026-09-01', 2, 'MENSAL')
        ->> 'error' = 'sem_permissao'
  and public.register_external_prepayment(
        '5e000000-0000-4000-8000-000000000011', 100.00, date '2026-09-01',
        date '2027-06-01', 2, 'LEGADO', null) ->> 'error' = 'sem_permissao'
  and public.cancel_prepayment('5e000000-0000-4000-8000-0000000000a4') ->> 'error' = 'sem_permissao'
  and public.payment_split_installment(current_setting('fincomp.parcela_outubro')::uuid)
        ->> 'error' = 'sem_permissao'
  and public.payment_split_breakdown('5e000000-0000-4000-8000-0000000000a1')
        ->> 'error' = 'sem_permissao'
  and public.caixinha_fechamento('2026-08', 'fin-competencia-school') ->> 'tenant'
        = 'fin-competencia-other',
  'RPC atendeu diretor de outra escola');

-- Aluno: sem acesso.
set local request.jwt.claims =
  '{"sub":"5e000000-0000-4000-8000-000000000011","role":"authenticated"}';
select pg_temp.assert_true(
  public.register_prepayment('5e000000-0000-4000-8000-0000000000a2', date '2026-09-01', 2, 'MENSAL')
    ->> 'error' = 'sem_permissao'
  and public.caixinha_fechamento('2026-08') ->> 'error' = 'sem_permissao'
  and (select count(*) from public.student_payment_allocations) = 0,
  'aluno registrou pagamento completo ou leu a caixinha');

reset role;
set local request.jwt.claims = '';

select pg_temp.assert_true(
  (select count(*) from public.student_payment_allocations
    where payment_id = '5e000000-0000-4000-8000-0000000000a2') = 0
  and not exists (select 1 from public.student_payment_allocations
                   where competencia = date '2027-06-01'),
  'uma chamada recusada gravou parcelas');

rollback;
