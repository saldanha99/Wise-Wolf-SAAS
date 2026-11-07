-- ─────────────────────────────────────────────────────────────────────────────
-- Renovação de contrato pela ficha do aluno: 6 ou 12 meses, parcelada ou com
-- pagamento integral adiantado (06/11/2026)
--
-- O motor de renovação de 15/09 só conhecia 6 meses e só nascia por comando de
-- operador no banco. Esta migration NÃO cria fluxo paralelo: a oferta é a mesma
-- `private.student_course_renewal_offers`, o link e a assinatura são os mesmos
-- (`/renovar-curso`), a fila de faturamento é a mesma. O que entra:
--   • prazo 6 ou 12 meses;
--   • `create_student_renewal_offer`: a direção conduz pela ficha;
--   • duas estratégias novas de cobrança:
--       UPFRONT_CHARGE    cobrança única no Asaas pelo valor total;
--       UPFRONT_EXTERNAL  já recebido por fora, com data e referência;
--   • a cobertura dos meses entra na hora em que o dinheiro está provado:
--       UPFRONT_CHARGE    no RECEIVED da cobrança → MENSAL (rateio por parcela);
--       UPFRONT_EXTERNAL  na assinatura → LEGADO (sem caixa e sem rateio, a
--                         mesma regra de `register_external_prepayment`).
--
-- Regras que não mudam:
--   • o valor e a vigência só passam a valer quando o aluno assina;
--   • o registro não cancela nada no Asaas sozinho;
--   • sem contrato assinado no sistema, a direção precisa dizer qual documento
--     está sendo prorrogado. `contract_accepted` NÃO é marcado: a flag significa
--     "aceitou o contrato no sistema", e aqui esse aceite não houve.
-- Re-executável: o release roda as pendentes duas vezes antes de valer.
-- ─────────────────────────────────────────────────────────────────────────────

-- Mesma progressão dos cheques antigos: `fim_do_servico` mês a mês, nunca
-- `first + interval`. Em 31/01 os dois dão datas diferentes.
create or replace function private.renewal_last_due_date(p_first date, p_term smallint)
returns date language plpgsql immutable set search_path = '' as $$
declare v date := p_first; k integer;
begin
  if p_first is null or p_term is null or p_term < 1 then return null; end if;
  for k in 1 .. (p_term - 1) loop v := public.fim_do_servico(v); end loop;
  return v;
end;
$$;
alter function private.renewal_last_due_date(date, smallint) owner to postgres;
revoke all on function private.renewal_last_due_date(date, smallint) from public, anon, authenticated, service_role;

-- R$ 2.244,00: `to_char` com vírgula e ponto fixos, sem depender de locale.
create or replace function private.renewal_brl(p_value numeric)
returns text language sql immutable set search_path = '' as $$
  select translate(to_char(p_value, 'FM999,999,990.00'), ',.', '.,')
$$;
alter function private.renewal_brl(numeric) owner to postgres;
revoke all on function private.renewal_brl(numeric) from public, anon, authenticated, service_role;

alter table private.student_course_renewal_proposals
  drop constraint if exists student_course_renewal_proposals_term_months_check;
alter table private.student_course_renewal_proposals
  add constraint student_course_renewal_proposals_term_months_check check (term_months in (6, 12));

alter table private.student_course_renewal_offers
  add column if not exists upfront_total_cents bigint,
  add column if not exists upfront_due_date date,
  add column if not exists external_received_on date,
  add column if not exists external_reference_note text,
  add column if not exists provider_payment_id text,
  add column if not exists provider_invoice_url text,
  add column if not exists coverage_registered_at timestamptz,
  add column if not exists coverage_group_id uuid,
  add column if not exists contract_basis text not null default 'SIGNED_IN_SYSTEM',
  add column if not exists contract_reference text,
  add column if not exists created_by uuid,
  add column if not exists catalog_monthly_price numeric(12, 2);
alter table private.student_course_renewal_offers alter column provider_customer_id drop not null;

alter table private.student_course_renewal_offers
  drop constraint if exists student_course_renewal_offers_term_months_check,
  drop constraint if exists student_course_renewal_offers_billing_strategy_check,
  drop constraint if exists student_course_renewal_offers_billing_type_check,
  drop constraint if exists student_course_renewal_offers_check1,
  drop constraint if exists student_course_renewal_offers_check3,
  drop constraint if exists student_course_renewal_offers_last_due_matches_term,
  drop constraint if exists student_course_renewal_offers_strategy_shape,
  drop constraint if exists student_course_renewal_offers_contract_basis_shape;
alter table private.student_course_renewal_offers
  add constraint student_course_renewal_offers_term_months_check check (term_months in (6, 12)),
  add constraint student_course_renewal_offers_billing_strategy_check
    check (billing_strategy in ('CREATE_NEW', 'REUSE_EXISTING', 'UPFRONT_CHARGE', 'UPFRONT_EXTERNAL')),
  add constraint student_course_renewal_offers_billing_type_check
    check (billing_type in ('PIX', 'BOLETO', 'CREDIT_CARD', 'EXTERNO')),
  add constraint student_course_renewal_offers_last_due_matches_term
    check (last_due_date = private.renewal_last_due_date(first_due_date, term_months)),
  add constraint student_course_renewal_offers_strategy_shape check (
    case billing_strategy
      when 'CREATE_NEW' then provider_subscription_id is null
        and upfront_total_cents is null and billing_type <> 'EXTERNO'
        and nullif(btrim(provider_customer_id), '') is not null
      when 'REUSE_EXISTING' then nullif(btrim(provider_subscription_id), '') is not null
        and upfront_total_cents is null and billing_type <> 'EXTERNO'
        and nullif(btrim(provider_customer_id), '') is not null
      when 'UPFRONT_CHARGE' then provider_subscription_id is null
        and upfront_total_cents = monthly_fee_cents * term_months
        and upfront_due_date is not null and billing_type <> 'EXTERNO'
      when 'UPFRONT_EXTERNAL' then provider_subscription_id is null
        and upfront_total_cents = monthly_fee_cents * term_months
        and external_received_on is not null
        and nullif(btrim(external_reference_note), '') is not null
        and billing_type = 'EXTERNO'
      else false end),
  add constraint student_course_renewal_offers_contract_basis_shape check (
    contract_basis = 'SIGNED_IN_SYSTEM'
    or (contract_basis = 'EXTERNAL_DOCUMENT' and nullif(btrim(contract_reference), '') is not null));
create unique index if not exists student_course_renewal_offers_provider_payment_key
  on private.student_course_renewal_offers(provider_payment_id) where provider_payment_id is not null;

-- ─── Leitura da ficha ────────────────────────────────────────────────────────
-- O fim do período é o mais distante entre o pagamento antigo (`paid_through`),
-- a cobertura registrada, a assinatura do Asaas e uma renovação já assinada.
create or replace function private.student_renewal_current_end(p_student uuid)
returns table(current_end date, source text)
language sql stable security definer set search_path = '' as $$
  select c.ends, c.origin from (
    select p.paid_through as ends, 'PAID_THROUGH'::text as origin, 2 as priority
      from public.profiles p where p.id = p_student and p.paid_through is not null
    union all
    select (max(a.competencia) + interval '1 month')::date, 'COVERAGE', 1
      from public.student_payment_allocations a
     where a.student_id = p_student and a.status in ('ACTIVE', 'REVIEW')
    having max(a.competencia) is not null
    union all
    select public.fim_do_servico(p.asaas_subscription_end_date), 'SUBSCRIPTION', 3
      from public.profiles p
     where p.id = p_student and p.asaas_subscription_end_date is not null
       and upper(btrim(coalesce(p.asaas_subscription_status, ''))) = 'ACTIVE'
    union all
    select max(o.service_end_date), 'SIGNED_RENEWAL', 0
      from private.student_course_renewal_offers o
     where o.student_id = p_student and o.status = 'SIGNED'
    having max(o.service_end_date) is not null
  ) c
  order by c.ends desc, c.priority limit 1;
$$;
alter function private.student_renewal_current_end(uuid) owner to postgres;
revoke all on function private.student_renewal_current_end(uuid) from public, anon, authenticated, service_role;

create or replace function public.get_student_renewal_context(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.profiles%rowtype;
  v_today date := (clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_end date;
  v_source text;
begin
  select * into p from public.profiles where id = p_student and role = 'STUDENT';
  if not found then return jsonb_build_object('ok', false, 'error', 'aluno_nao_encontrado'); end if;
  if not private.prepayment_caller_can_write(p.tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  select e.current_end, e.source into v_end, v_source from private.student_renewal_current_end(p_student) e;
  return jsonb_build_object(
    'ok', true,
    'student', jsonb_build_object(
      'id', p.id,
      'full_name', regexp_replace(btrim(coalesce(p.full_name, '')), '\s+', ' ', 'g'),
      'lifecycle_status', p.lifecycle_status,
      'monthly_fee', p.monthly_fee,
      'class_frequency', p.class_frequency,
      'due_day', p.due_day,
      'contract_accepted', coalesce(p.contract_accepted, false),
      'has_asaas_customer', nullif(btrim(coalesce(p.asaas_customer_id, '')), '') is not null,
      'subscription_status', p.asaas_subscription_status,
      'subscription_end_date', p.asaas_subscription_end_date,
      'weekly_lessons', (select count(*)::int from public.bookings b
        where b.student_id = p.id and b.tenant_id = p.tenant_id
          and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null)),
    'period', jsonb_build_object(
      'current_end', v_end,
      'source', v_source,
      'suggested_start', greatest(coalesce(v_end, v_today + 1), v_today + 1)),
    'catalog', coalesce((select jsonb_agg(jsonb_build_object(
        'term_months', c.fidelity_months, 'classes_per_week', c.classes_per_week,
        'monthly_price', c.monthly_price) order by c.fidelity_months, c.classes_per_week)
      from public.student_pricing_plans c
      where c.tenant_id = p.tenant_id and c.active and c.fidelity_months in (6, 12)), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(row_data order by created_at desc) from (
      select o.created_at, jsonb_build_object(
        'id', o.id, 'status', o.status, 'billing_status', o.billing_status,
        'billing_strategy', o.billing_strategy, 'billing_type', o.billing_type,
        'term_months', o.term_months, 'monthly_fee_cents', o.monthly_fee_cents,
        'total_cents', o.monthly_fee_cents * o.term_months,
        'classes_per_week', o.classes_per_week, 'contract_start', o.contract_start,
        'first_due_date', o.first_due_date, 'last_due_date', o.last_due_date,
        'service_end_date', o.service_end_date, 'upfront_due_date', o.upfront_due_date,
        'expires_at', o.expires_at, 'signed_at', o.signed_at,
        'expired', (o.status = 'PENDING_SIGNATURE' and o.expires_at < clock_timestamp()),
        'billing_error', o.billing_error, 'invoice_url', o.provider_invoice_url,
        'coverage_registered_at', o.coverage_registered_at,
        'token', case when o.status = 'PENDING_SIGNATURE' then o.token end,
        'notice_status', (select n.status from public.student_course_renewal_notification_outbox n
          where n.offer_id = o.id and n.milestone = 'INITIAL')) as row_data
      from private.student_course_renewal_offers o
      where o.student_id = p.id and o.tenant_id = p.tenant_id
      order by o.created_at desc limit 5) recent), '[]'::jsonb));
end;
$$;
alter function public.get_student_renewal_context(uuid) owner to postgres;
revoke all on function public.get_student_renewal_context(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_student_renewal_context(uuid) to authenticated, service_role;

-- ─── A porta da direção ──────────────────────────────────────────────────────
create or replace function public.create_student_renewal_offer(
  p_student uuid,
  p_term_months integer,
  p_monthly_fee numeric,
  p_classes_per_week integer,
  p_due_day integer,
  p_contract_start date,
  p_payment_plan text,
  p_billing_type text default null,
  p_upfront_due_date date default null,
  p_external_received_on date default null,
  p_external_reference text default null,
  p_contract_reference text default null,
  p_note text default null,
  p_send_link boolean default true,
  p_request_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles%rowtype;
  o private.student_course_renewal_offers%rowtype;
  v_today date := (clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_plan text := upper(btrim(coalesce(p_payment_plan, '')));
  v_billing text := upper(btrim(coalesce(p_billing_type, '')));
  v_fee_cents bigint;
  v_term smallint;
  v_frequency smallint;
  v_due smallint;
  v_first_due date;
  v_last_due date;
  v_service_end date;
  v_first_month date;
  v_last_month date;
  v_strategy text;
  v_customer text;
  v_subscription text;
  v_catalog numeric;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_contract_reference text := nullif(btrim(coalesce(p_contract_reference, '')), '');
  v_external_reference text := nullif(btrim(coalesce(p_external_reference, '')), '');
  v_contract_basis text;
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_approval text;
  v_conflicts text[];
  v_proposal uuid;
  v_token text;
  v_phone text;
  v_cpf text;
begin
  if p_student is null then return jsonb_build_object('ok', false, 'error', 'aluno_obrigatorio'); end if;
  if p_term_months is null or p_term_months not in (6, 12) then
    return jsonb_build_object('ok', false, 'error', 'prazo_invalido');
  end if;
  if p_monthly_fee is null or p_monthly_fee::text in ('NaN', 'Infinity', '-Infinity')
     or p_monthly_fee <= 0 or p_monthly_fee > 1000000 or p_monthly_fee <> round(p_monthly_fee, 2) then
    return jsonb_build_object('ok', false, 'error', 'valor_invalido');
  end if;
  if p_classes_per_week is null or p_classes_per_week not between 1 and 7 then
    return jsonb_build_object('ok', false, 'error', 'frequencia_invalida');
  end if;
  if p_due_day is null or p_due_day not between 1 and 28 then
    return jsonb_build_object('ok', false, 'error', 'vencimento_invalido');
  end if;
  if p_contract_start is null or p_contract_start < v_today - 31 or p_contract_start > v_today + 400 then
    return jsonb_build_object('ok', false, 'error', 'inicio_invalido');
  end if;
  if v_plan not in ('INSTALLMENTS', 'UPFRONT_CHARGE', 'UPFRONT_EXTERNAL') then
    return jsonb_build_object('ok', false, 'error', 'forma_de_pagamento_invalida');
  end if;

  select tenant_id into p.tenant_id from public.profiles where id = p_student and role = 'STUDENT';
  if p.tenant_id is null then return jsonb_build_object('ok', false, 'error', 'aluno_nao_encontrado'); end if;
  if not private.prepayment_caller_can_write(p.tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  -- Mesma trava de ciclo de vida da cobrança: nada de renovar no meio de uma saída.
  perform pg_advisory_xact_lock(hashtextextended(
    'student-billing-lifecycle:' || p.tenant_id || ':' || p_student::text, 0));
  select * into p from public.profiles where id = p_student for share;
  if lower(btrim(coalesce(p.lifecycle_status, ''))) not in ('active', 'suspended')
     or not private.tenant_is_operational(p.tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'aluno_fora_de_escopo');
  end if;
  if exists (select 1 from public.student_offboarding_operations op
      where op.tenant_id = p.tenant_id and op.student_id = p.id
        and op.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')) then
    return jsonb_build_object('ok', false, 'error', 'saida_em_andamento');
  end if;

  v_term := p_term_months::smallint;
  v_frequency := p_classes_per_week::smallint;
  v_due := p_due_day::smallint;
  v_fee_cents := round(p_monthly_fee * 100)::bigint;

  -- 1º vencimento: o dia combinado, no início ou depois dele.
  v_first_due := make_date(extract(year from p_contract_start)::int, extract(month from p_contract_start)::int, p_due_day);
  if v_first_due < p_contract_start then v_first_due := (v_first_due + interval '1 month')::date; end if;
  v_first_due := private.student_course_renewal_effective_first_due_date(v_first_due);
  v_last_due := private.renewal_last_due_date(v_first_due, v_term);
  v_service_end := public.fim_do_servico(v_last_due);
  v_first_month := date_trunc('month', v_first_due::timestamp)::date;
  v_last_month := (v_first_month + make_interval(months => p_term_months - 1))::date;

  -- O que está sendo prorrogado. Sem aceite no sistema, a direção diz qual
  -- documento vale; sem documento nenhum, renovar não é o caminho.
  if p.contract_accepted is true then
    v_contract_basis := 'SIGNED_IN_SYSTEM';
    v_contract_reference := null;
  else
    if v_contract_reference is null or length(v_contract_reference) not between 10 and 500 then
      return jsonb_build_object('ok', false, 'error', 'contrato_anterior_nao_informado');
    end if;
    v_contract_basis := 'EXTERNAL_DOCUMENT';
  end if;

  -- Preço fora do catálogo é decisão da direção, e fica escrito.
  select c.monthly_price into v_catalog from public.student_pricing_plans c
   where c.tenant_id = p.tenant_id and c.active and c.fidelity_months = p_term_months
     and c.classes_per_week = p_classes_per_week
   order by c.created_at desc limit 1;
  if (v_catalog is null or round(v_catalog * 100)::bigint <> v_fee_cents)
     and (v_note is null or length(v_note) < 10) then
    return jsonb_build_object('ok', false, 'error', 'motivo_do_preco_obrigatorio', 'catalogo', v_catalog);
  end if;
  if length(coalesce(v_note, '')) > 800 then
    return jsonb_build_object('ok', false, 'error', 'observacao_longa');
  end if;

  -- Idempotência: repetir o clique devolve a mesma oferta.
  select full_name into v_actor_name from public.profiles where id = v_actor;
  v_actor_name := coalesce(nullif(btrim(v_actor_name), ''), 'direção');
  v_approval := encode(sha256(convert_to(concat_ws(':', 'renewal-file', p.id, v_term, v_fee_cents, v_frequency, v_due,
    p_contract_start, v_plan, v_billing, p_upfront_due_date, p_external_received_on,
    coalesce(p_request_id::text, gen_random_uuid()::text)), 'UTF8')), 'hex');
  select o2.* into o from private.student_course_renewal_proposals r
    join private.student_course_renewal_offers o2 on o2.proposal_id = r.id
   where r.tenant_id = p.tenant_id and r.student_id = p.id and r.approval_ref = v_approval;
  if found then
    return jsonb_build_object('ok', true, 'already', true, 'offer_id', o.id,
      'token', case when o.status = 'PENDING_SIGNATURE' then o.token end);
  end if;

  if exists (select 1 from private.student_course_renewal_offers x
      where x.student_id = p.id and x.tenant_id = p.tenant_id
        and x.status = 'PENDING_SIGNATURE' and x.expires_at > clock_timestamp()) then
    return jsonb_build_object('ok', false, 'error', 'renovacao_em_aberto');
  end if;
  if exists (select 1 from private.course_renewal_negotiations n
      where n.student_id = p.id and n.tenant_id = p.tenant_id
        and n.status in ('WAITING_TEACHER', 'WAITING_STUDENT', 'WAITING_MANAGEMENT')) then
    return jsonb_build_object('ok', false, 'error', 'negociacao_em_aberto');
  end if;
  if exists (select 1 from private.student_course_renewal_offers x
      where x.student_id = p.id and x.tenant_id = p.tenant_id and x.status = 'SIGNED'
        and x.service_end_date > v_first_due and x.first_due_date < v_service_end) then
    return jsonb_build_object('ok', false, 'error', 'periodo_ja_renovado');
  end if;
  if p.paid_through is not null and p.paid_through > v_first_due then
    return jsonb_build_object('ok', false, 'error', 'periodo_ja_pago', 'pago_ate', p.paid_through);
  end if;
  select array_agg(to_char(a.competencia, 'YYYY-MM') order by a.competencia) into v_conflicts
    from public.student_payment_allocations a
   where a.student_id = p.id and a.status in ('ACTIVE', 'REVIEW')
     and a.competencia between v_first_month and v_last_month;
  if v_conflicts is not null then
    return jsonb_build_object('ok', false, 'error', 'mes_ja_coberto', 'meses', to_jsonb(v_conflicts));
  end if;

  v_customer := nullif(btrim(coalesce(p.asaas_customer_id, '')), '');
  v_subscription := nullif(btrim(coalesce(p.subscription_id, '')), '');

  if v_plan = 'INSTALLMENTS' then
    if v_billing not in ('PIX', 'BOLETO', 'CREDIT_CARD') then
      return jsonb_build_object('ok', false, 'error', 'forma_de_cobranca_invalida');
    end if;
    if v_customer is null then
      return jsonb_build_object('ok', false, 'error', 'parcelada_exige_cliente_asaas');
    end if;
    if v_subscription is not null and upper(btrim(coalesce(p.asaas_subscription_status, ''))) = 'ACTIVE' then
      -- A assinatura viva só é reaproveitada no mesmo valor; valor novo com ela
      -- no ar cobraria em dobro ou no preço errado.
      if round(coalesce(p.monthly_fee, 0) * 100)::bigint <> v_fee_cents then
        return jsonb_build_object('ok', false, 'error', 'assinatura_ativa_com_valor_diferente');
      end if;
      v_strategy := 'REUSE_EXISTING';
    else
      v_strategy := 'CREATE_NEW';
      v_subscription := null;
    end if;
  else
    -- Pagamento integral: assinatura viva dentro do período cobraria de novo os
    -- mesmos meses.
    if upper(btrim(coalesce(p.asaas_subscription_status, ''))) = 'ACTIVE'
       and (p.asaas_subscription_end_date is null or p.asaas_subscription_end_date >= v_first_due) then
      return jsonb_build_object('ok', false, 'error', 'assinatura_ativa_no_periodo',
        'assinatura_ate', p.asaas_subscription_end_date);
    end if;
    v_subscription := null;
    if v_plan = 'UPFRONT_CHARGE' then
      v_strategy := 'UPFRONT_CHARGE';
      if v_billing not in ('PIX', 'BOLETO', 'CREDIT_CARD') then
        return jsonb_build_object('ok', false, 'error', 'forma_de_cobranca_invalida');
      end if;
      if p_upfront_due_date is null or p_upfront_due_date <= v_today or p_upfront_due_date > v_today + 60 then
        return jsonb_build_object('ok', false, 'error', 'vencimento_da_cobranca_invalido');
      end if;
      -- A cobrança sai no aluno ativo: o caixa recusa evento de cadastro suspenso.
      if lower(btrim(coalesce(p.lifecycle_status, ''))) <> 'active' then
        return jsonb_build_object('ok', false, 'error', 'aluno_suspenso_reative_antes');
      end if;
      if p.guardian_id is not null or nullif(btrim(coalesce(p.guardian_cpf, '')), '') is not null then
        v_cpf := regexp_replace(coalesce(p.guardian_cpf, ''), '[^0-9]', '', 'g');
        v_phone := regexp_replace(coalesce(p.guardian_phone, ''), '[^0-9]', '', 'g');
      else
        v_cpf := regexp_replace(coalesce(p.cpf, ''), '[^0-9]', '', 'g');
        v_phone := regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g');
      end if;
      if length(v_cpf) <> 11 or length(v_phone) < 10 then
        return jsonb_build_object('ok', false, 'error', 'cadastro_incompleto_para_cobranca');
      end if;
    else
      v_strategy := 'UPFRONT_EXTERNAL';
      v_billing := 'EXTERNO';
      if p_external_received_on is null or p_external_received_on > v_today or p_external_received_on < v_today - 400 then
        return jsonb_build_object('ok', false, 'error', 'data_de_recebimento_invalida');
      end if;
      if v_external_reference is null or length(v_external_reference) not between 5 and 500 then
        return jsonb_build_object('ok', false, 'error', 'referencia_do_recebimento_obrigatoria');
      end if;
    end if;
  end if;

  insert into private.student_course_renewal_proposals(
    tenant_id, student_id, term_months, monthly_fee_cents, classes_per_week, suggested_due_day,
    source_snapshot, source_note, approval_ref)
  values (p.tenant_id, p.id, v_term, v_fee_cents, v_frequency, v_due,
    jsonb_build_object('monthly_fee', p.monthly_fee, 'class_frequency', p.class_frequency,
      'due_day', p.due_day, 'fidelity_plan', p.fidelity_plan, 'contract_accepted', p.contract_accepted,
      'accepted_at', p.accepted_at, 'lifecycle_status', p.lifecycle_status,
      'subscription_id', p.subscription_id, 'subscription_end_date', p.asaas_subscription_end_date,
      'paid_through', p.paid_through, 'catalog_monthly_price', v_catalog,
      'conditions_changed', round(coalesce(p.monthly_fee, 0) * 100)::bigint <> v_fee_cents,
      'origin', 'student_file'),
    left(format('Renovação pela ficha, autorizada por %s: %s meses, R$ %s por mês, %sx por semana, %s.%s',
      btrim(v_actor_name), p_term_months, private.renewal_brl(p_monthly_fee),
      p_classes_per_week, v_plan, coalesce(' ' || v_note, '')), 1500),
    v_approval)
  returning id into v_proposal;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.student_course_renewal_offers(
    proposal_id, tenant_id, student_id, token, contract_start, first_due_date, last_due_date,
    service_end_date, previous_service_end_date, term_months, monthly_fee_cents, classes_per_week,
    billing_strategy, provider_customer_id, provider_subscription_id, billing_type, expires_at,
    upfront_total_cents, upfront_due_date, external_received_on, external_reference_note,
    contract_basis, contract_reference, created_by, catalog_monthly_price)
  values (
    v_proposal, p.tenant_id, p.id, v_token, p_contract_start, v_first_due, v_last_due,
    v_service_end, (select e.current_end from private.student_renewal_current_end(p.id) e),
    v_term, v_fee_cents, v_frequency, v_strategy, v_customer, v_subscription,
    case when v_plan = 'UPFRONT_EXTERNAL' then 'EXTERNO' else v_billing end,
    clock_timestamp() + interval '30 days',
    case when v_plan <> 'INSTALLMENTS' then v_fee_cents * p_term_months end,
    case when v_plan = 'UPFRONT_CHARGE' then p_upfront_due_date end,
    case when v_plan = 'UPFRONT_EXTERNAL' then p_external_received_on end,
    case when v_plan = 'UPFRONT_EXTERNAL' then v_external_reference end,
    v_contract_basis, v_contract_reference, v_actor, v_catalog)
  returning * into o;

  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'ISSUED', jsonb_build_object(
    'origin', 'student_file', 'actor', v_actor, 'term_months', o.term_months,
    'monthly_fee_cents', o.monthly_fee_cents, 'catalog_monthly_price', v_catalog,
    'strategy', o.billing_strategy, 'contract_basis', o.contract_basis,
    'contract_start', o.contract_start, 'first_due_date', o.first_due_date,
    'last_due_date', o.last_due_date, 'service_end_date', o.service_end_date,
    'upfront_total_cents', o.upfront_total_cents, 'proposal_id', o.proposal_id));

  if coalesce(p_send_link, true) then
    insert into public.student_course_renewal_notification_outbox(offer_id, tenant_id, student_id, milestone, scheduled_at)
    values (o.id, o.tenant_id, o.student_id, 'INITIAL', clock_timestamp())
    on conflict (offer_id, milestone) do nothing;
  end if;

  return jsonb_build_object('ok', true, 'already', false, 'offer_id', o.id, 'token', o.token,
    'first_due_date', o.first_due_date, 'last_due_date', o.last_due_date,
    'service_end_date', o.service_end_date, 'strategy', o.billing_strategy,
    'total_cents', o.monthly_fee_cents * o.term_months, 'link_sent', coalesce(p_send_link, true));
end;
$$;
alter function public.create_student_renewal_offer(uuid, integer, numeric, integer, integer, date, text, text, date, date, text, text, text, boolean, uuid) owner to postgres;
revoke all on function public.create_student_renewal_offer(uuid, integer, numeric, integer, integer, date, text, text, date, date, text, text, text, boolean, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_student_renewal_offer(uuid, integer, numeric, integer, integer, date, text, text, date, date, text, text, text, boolean, uuid)
  to authenticated;

create or replace function public.cancel_student_renewal_offer(p_offer uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o private.student_course_renewal_offers%rowtype;
begin
  select * into o from private.student_course_renewal_offers where id = p_offer;
  if not found then return jsonb_build_object('ok', false, 'error', 'renovacao_nao_encontrada'); end if;
  if not private.prepayment_caller_can_write(o.tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  if coalesce(length(btrim(p_reason)), 0) not between 8 and 500 then
    return jsonb_build_object('ok', false, 'error', 'motivo_obrigatorio');
  end if;
  if o.status = 'SIGNED' then return jsonb_build_object('ok', false, 'error', 'renovacao_ja_assinada'); end if;
  return private.cancel_student_course_renewal_offer(p_offer, p_reason);
end;
$$;
alter function public.cancel_student_renewal_offer(uuid, text) owner to postgres;
revoke all on function public.cancel_student_renewal_offer(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.cancel_student_renewal_offer(uuid, text) to authenticated;

-- ─── Cobertura dos meses ─────────────────────────────────────────────────────
-- Não usa `register_prepayment`: ele recusa MENSAL que comece depois do mês do
-- recebimento, e a renovação antecipada é exatamente isso. A 1ª parcela sai no
-- aviso do recebimento marcada com a competência dela; as demais saem mês a mês.
create or replace function private.renewal_register_coverage(p_offer uuid, p_payment uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o private.student_course_renewal_offers%rowtype;
  pay public.student_payments%rowtype;
  v_first date;
  v_last date;
  v_conflicts text[];
  v_group uuid;
  v_total numeric;
  v_received date;
  v_student text;
  v_reason text;
begin
  select * into o from private.student_course_renewal_offers where id = p_offer for update;
  if not found or o.status <> 'SIGNED' or o.billing_strategy not in ('UPFRONT_CHARGE', 'UPFRONT_EXTERNAL') then
    return jsonb_build_object('ok', false, 'error', 'renovacao_sem_cobertura');
  end if;
  if o.coverage_registered_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'grupo_id', o.coverage_group_id);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('student-payment-allocation:' || o.student_id::text, 0));

  v_first := date_trunc('month', o.first_due_date::timestamp)::date;
  v_last := (v_first + make_interval(months => o.term_months - 1))::date;
  v_total := (o.upfront_total_cents::numeric / 100)::numeric(12, 2);

  select array_agg(to_char(a.competencia, 'YYYY-MM') order by a.competencia) into v_conflicts
    from public.student_payment_allocations a
   where a.student_id = o.student_id and a.status in ('ACTIVE', 'REVIEW')
     and a.competencia between v_first and v_last;
  if v_conflicts is not null then
    v_reason := 'mes_ja_coberto';
  elsif o.billing_strategy = 'UPFRONT_CHARGE' then
    select * into pay from public.student_payments where id = p_payment;
    if pay.id is null or pay.student_id is distinct from o.student_id or pay.tenant_id is distinct from o.tenant_id
       or nullif(btrim(coalesce(pay.asaas_payment_id, pay.asaas_id, '')), '') is distinct from o.provider_payment_id
       or upper(btrim(coalesce(pay.status, ''))) not in ('RECEIVED', 'RECEIVED_IN_CASH') then
      v_reason := 'pagamento_nao_corresponde';
    elsif round(pay.value * 100)::bigint <> o.upfront_total_cents then
      v_reason := 'valor_recebido_diferente';
    elsif private.prepayment_payment_review_reason(pay.id) is not null then
      v_reason := 'pagamento_em_revisao';
    end if;
  end if;

  select regexp_replace(btrim(coalesce(full_name, 'Aluno')), '\s+', ' ', 'g') into v_student
    from public.profiles where id = o.student_id;

  if v_reason is not null then
    insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
    values (o.tenant_id, o.id, 'COVERAGE_BLOCKED', jsonb_build_object('reason', v_reason,
      'payment_id', p_payment, 'conflicts', to_jsonb(v_conflicts)));
    perform private.notify_management_group(o.tenant_id, o.student_id, null, o.id,
      'renewal-coverage-blocked:' || o.id::text,
      format(E'⚠️ *RENOVAÇÃO SEM COBERTURA*\n\n👤 Aluno(a): *%s*\nO pagamento integral não pôde cobrir os meses (%s). Confira na ficha do aluno; nenhuma parcela foi registrada.',
        v_student, v_reason));
    return jsonb_build_object('ok', false, 'error', v_reason);
  end if;

  if o.billing_strategy = 'UPFRONT_CHARGE' then
    v_group := pay.id;
    v_received := coalesce((pay.paid_at at time zone 'America/Sao_Paulo')::date, pay.payment_date, pay.due_date);
    perform private.prepayment_insert_parcelas(o.tenant_id, pay.id, pay.id, o.student_id, v_first,
      o.term_months::integer, v_total, 'MENSAL', 'ASAAS', v_received,
      format('Renovação de %s meses (oferta %s)', o.term_months, o.id));
  else
    v_group := gen_random_uuid();
    v_received := o.external_received_on;
    perform private.prepayment_insert_parcelas(o.tenant_id, v_group, null, o.student_id, v_first,
      o.term_months::integer, v_total, 'LEGADO', 'EXTERNO', v_received,
      left(format('Renovação de %s meses (oferta %s). Recebido por fora: %s',
        o.term_months, o.id, o.external_reference_note), 1000));
  end if;

  update public.profiles
     set paid_through = greatest(paid_through, o.service_end_date), prepaid_months = o.term_months
   where id = o.student_id and tenant_id = o.tenant_id;
  update private.student_course_renewal_offers
     set coverage_registered_at = clock_timestamp(), coverage_group_id = v_group
   where id = o.id;
  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'COVERAGE_REGISTERED', jsonb_build_object(
    'grupo_id', v_group, 'payment_id', p_payment, 'received_on', v_received,
    'first_month', v_first, 'last_month', v_last, 'total_cents', o.upfront_total_cents));
  perform private.notify_management_group(o.tenant_id, o.student_id, null, o.id,
    'renewal-coverage:' || o.id::text,
    format(E'💰 *RENOVAÇÃO PAGA*\n\n👤 Aluno(a): *%s*\n📄 %s meses · R$ %s %s\n🗓️ Meses cobertos: %s a %s\n📅 Vigência até %s',
      v_student, o.term_months, private.renewal_brl(v_total),
      case when o.billing_strategy = 'UPFRONT_CHARGE' then 'recebidos no Asaas' else 'recebidos por fora (sem caixa e sem rateio)' end,
      to_char(v_first, 'MM/YYYY'), to_char(v_last, 'MM/YYYY'), to_char(o.service_end_date, 'DD/MM/YYYY')));
  return jsonb_build_object('ok', true, 'already', false, 'grupo_id', v_group);
end;
$$;
alter function private.renewal_register_coverage(uuid, uuid) owner to postgres;
revoke all on function private.renewal_register_coverage(uuid, uuid) from public, anon, authenticated, service_role;

-- Roda dentro do evento do webhook: falhar aqui não pode travar o recebimento.
create or replace function private.renewal_upfront_payment_received()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_offer uuid; v_tenant text;
begin
  select o.id, o.tenant_id into v_offer, v_tenant from private.student_course_renewal_offers o
   where o.provider_payment_id = nullif(btrim(coalesce(new.asaas_payment_id, new.asaas_id, '')), '')
     and o.billing_strategy = 'UPFRONT_CHARGE' and o.coverage_registered_at is null;
  if v_offer is null then return null; end if;
  begin
    perform private.renewal_register_coverage(v_offer, new.id);
  exception when others then
    raise warning '[renovação] cobertura da oferta % não registrada: %', v_offer, sqlerrm;
    insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
    values (v_tenant, v_offer, 'COVERAGE_FAILED', jsonb_build_object('error', left(sqlerrm, 200), 'payment_id', new.id));
  end;
  return null;
end;
$$;
alter function private.renewal_upfront_payment_received() owner to postgres;
revoke all on function private.renewal_upfront_payment_received() from public, anon, authenticated, service_role;
drop trigger if exists trg_renewal_upfront_payment_received on public.student_payments;
create trigger trg_renewal_upfront_payment_received
  after insert or update of status on public.student_payments
  for each row when (upper(btrim(coalesce(new.status, ''))) in ('RECEIVED', 'RECEIVED_IN_CASH'))
  execute function private.renewal_upfront_payment_received();

-- ─── Página pública ──────────────────────────────────────────────────────────
create or replace function public.get_student_course_renewal_public(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  o private.student_course_renewal_offers%rowtype;
  r private.student_course_renewal_proposals%rowtype;
  p public.profiles%rowtype;
  v_school text;
  v_branding jsonb;
  v_first_due date;
  v_last_due date;
  v_service_end date;
  v_dates_adjusted boolean := false;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'Link inválido.');
  end if;
  select * into o from private.student_course_renewal_offers where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'error', 'Link inválido.'); end if;
  select * into r from private.student_course_renewal_proposals where id = o.proposal_id;
  select * into p from public.profiles where id = o.student_id and tenant_id = o.tenant_id;
  select coalesce(nullif(btrim(name), ''), 'Wise Wolf'), coalesce(branding, '{}'::jsonb)
    into v_school, v_branding from public.tenants where id = o.tenant_id;
  if p.id is null or r.id is null or r.monthly_fee_cents <> o.monthly_fee_cents
    or r.classes_per_week <> o.classes_per_week or r.term_months <> o.term_months
    or o.status = 'CANCELLED' then
    return jsonb_build_object('ok', false, 'error', 'Esta proposta não está disponível.');
  end if;

  v_first_due := case when o.status = 'PENDING_SIGNATURE'
    then private.student_course_renewal_effective_first_due_date(o.first_due_date)
    else o.first_due_date end;
  v_dates_adjusted := v_first_due is distinct from o.first_due_date;
  v_last_due := private.renewal_last_due_date(v_first_due, o.term_months);
  v_service_end := public.fim_do_servico(v_last_due);

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'student_name', regexp_replace(btrim(coalesce(p.full_name, '')), '\s+', ' ', 'g'),
    'school_name', v_school,
    'term_months', o.term_months,
    'monthly_fee_cents', o.monthly_fee_cents,
    'classes_per_week', o.classes_per_week,
    'contract_start', o.contract_start,
    'first_due_date', v_first_due,
    'last_due_date', v_last_due,
    'service_end_date', v_service_end,
    'status', o.status,
    'billing_status', o.billing_status,
    'signed_at', o.signed_at,
    'expired', (o.expires_at < clock_timestamp() and o.status = 'PENDING_SIGNATURE'),
    'dates_adjusted', v_dates_adjusted,
    'payment_plan', case when o.billing_strategy in ('UPFRONT_CHARGE', 'UPFRONT_EXTERNAL')
      then o.billing_strategy else 'INSTALLMENTS' end,
    'upfront_total_cents', o.upfront_total_cents,
    'upfront_due_date', case when o.billing_strategy = 'UPFRONT_CHARGE' and o.status = 'PENDING_SIGNATURE'
      then greatest(o.upfront_due_date, ((clock_timestamp() at time zone 'America/Sao_Paulo')::date + 1))
      else o.upfront_due_date end,
    'external_received_on', o.external_received_on,
    'invoice_url', case when o.status = 'SIGNED' then o.provider_invoice_url end,
    'schedule', case when o.schedule_plan is null then null else jsonb_build_object(
      'teacher_first_name', split_part(btrim(coalesce(o.schedule_plan ->> 'teacher_name', '')), ' ', 1),
      'slots', o.schedule_plan -> 'slots') end,
    'school_logo_url', case when v_branding ->> 'logoUrl' ~ '^https://[^\s"<>]+$' then v_branding ->> 'logoUrl' end,
    'brand_primary', case when v_branding ->> 'primaryColor' ~ '^#[0-9a-fA-F]{6}$' then v_branding ->> 'primaryColor' end,
    'brand_secondary', case when v_branding ->> 'secondaryColor' ~ '^#[0-9a-fA-F]{6}$' then v_branding ->> 'secondaryColor' end
  ));
end;
$fn$;

create or replace function public.sign_student_course_renewal(
  p_token text, p_typed_signature text, p_expected_first_due_date date
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  o private.student_course_renewal_offers%rowtype;
  p public.profiles%rowtype;
  v_ip text;
  v_first_due date;
  v_last_due date;
  v_service_end date;
  v_billing_status text;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' or p_expected_first_due_date is null then
    return jsonb_build_object('ok', false, 'error', 'Link inválido.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-sign:' || p_token, 0));
  select * into o from private.student_course_renewal_offers where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Link inválido.'); end if;
  if o.status = 'SIGNED' then
    return jsonb_build_object('ok', true, 'already', true, 'billing_status', o.billing_status);
  end if;
  if o.status <> 'PENDING_SIGNATURE' or o.expires_at < clock_timestamp() then
    return jsonb_build_object('ok', false, 'error', 'Esta proposta expirou. Fale com a escola.');
  end if;
  select * into p from public.profiles where id = o.student_id and tenant_id = o.tenant_id for share;
  if p.id is null
    or public.normalize_signature_name(p_typed_signature) is distinct from public.normalize_signature_name(p.full_name)
    or nullif(btrim(p_typed_signature), '') is null then
    return jsonb_build_object('ok', false, 'error', 'Digite exatamente o nome completo do aluno.');
  end if;

  v_first_due := private.student_course_renewal_effective_first_due_date(o.first_due_date);
  if p_expected_first_due_date is distinct from v_first_due then
    return jsonb_build_object('ok', false,
      'error', 'As datas foram atualizadas. Recarregue a página e confira antes de assinar.');
  end if;
  v_last_due := private.renewal_last_due_date(v_first_due, o.term_months);
  v_service_end := public.fim_do_servico(v_last_due);
  v_ip := coalesce(
    nullif(btrim(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)), ''),
    'Via Web (Digital)'
  );
  -- Já recebido por fora não passa pelo Asaas: a assinatura encerra a cobrança.
  v_billing_status := case when o.billing_strategy = 'UPFRONT_EXTERNAL' then 'SYNCED' else 'PENDING' end;

  if o.first_due_date is distinct from v_first_due then
    insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
    values (o.tenant_id, o.id, 'DUE_DATES_ROLLED_FORWARD', jsonb_build_object(
      'previous_first_due_date', o.first_due_date,
      'first_due_date', v_first_due,
      'previous_service_end_date', o.service_end_date,
      'service_end_date', v_service_end
    ));
  end if;

  update private.student_course_renewal_offers
     set first_due_date = v_first_due,
         last_due_date = v_last_due,
         service_end_date = v_service_end,
         upfront_due_date = case when billing_strategy = 'UPFRONT_CHARGE'
           then greatest(upfront_due_date, ((clock_timestamp() at time zone 'America/Sao_Paulo')::date + 1))
           else upfront_due_date end,
         status = 'SIGNED',
         billing_status = v_billing_status,
         billing_synced_at = case when v_billing_status = 'SYNCED' then clock_timestamp() else billing_synced_at end,
         typed_signature = btrim(p_typed_signature),
         signature_ip = v_ip,
         signed_at = clock_timestamp()
   where id = o.id;
  update public.student_course_renewal_notification_outbox
     set status = 'SUPPRESSED', last_error = 'renewal_signed', updated_at = clock_timestamp()
   where offer_id = o.id and submit_attempt_count = 0 and status in ('PENDING', 'CLAIMED');
  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'SIGNED', jsonb_build_object(
    'signed_at', clock_timestamp(),
    'signature_ip', v_ip,
    'first_due_date', v_first_due,
    'service_end_date', v_service_end
  ));
  return jsonb_build_object('ok', true, 'already', false, 'billing_status', v_billing_status);
end;
$fn$;

-- Avisos e fatos da assinatura: mesmo gatilho, agora com o prazo e a forma de pagamento.
create or replace function private.on_student_course_renewal_signed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_fee numeric := new.monthly_fee_cents / 100.0;
  v_frequency text := new.classes_per_week::text || 'x';
  v_due smallint := case when extract(day from new.first_due_date) <= 28 then extract(day from new.first_due_date)::smallint end;
  v_outcome text := 'no_schedule';
  v_profile_note text := '';
  v_student text;
  v_payment_line text := '';
begin
  -- Condições assinadas passam a valer no perfil (a cobrança vem da Asaas pela oferta).
  begin
    update public.profiles
       set monthly_fee = v_fee, class_frequency = v_frequency, due_day = coalesce(v_due, due_day)
     where id = new.student_id and tenant_id = new.tenant_id
       and (monthly_fee is distinct from v_fee or class_frequency is distinct from v_frequency
            or (v_due is not null and due_day is distinct from v_due));
  exception when others then
    v_profile_note := E'\n⚠️ Não foi possível atualizar valor/frequência no cadastro: ajuste manual.';
    insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
    values (new.tenant_id, new.id, 'PROFILE_UPDATE_FAILED', jsonb_build_object('error', left(sqlerrm, 200)));
  end;

  if new.schedule_plan is not null then
    begin
      v_outcome := private.apply_student_course_renewal_schedule(new.id);
    exception when others then
      v_outcome := 'apply_failed';
      insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
      values (new.tenant_id, new.id, 'SCHEDULE_APPLY_FAILED', jsonb_build_object('error', left(sqlerrm, 200)));
    end;
    if v_outcome in ('pending_reactivation', 'needs_review_existing_schedule') then
      insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
      values (new.tenant_id, new.id, 'SCHEDULE_' || upper(v_outcome), '{}'::jsonb);
    end if;
  end if;

  if new.billing_strategy = 'UPFRONT_CHARGE' then
    v_payment_line := format(E'\n💰 Pagamento integral: *R$ %s*, cobrança única no Asaas com vencimento em %s.',
      private.renewal_brl(new.upfront_total_cents / 100.0),
      to_char(new.upfront_due_date, 'DD/MM/YYYY'));
  elsif new.billing_strategy = 'UPFRONT_EXTERNAL' then
    v_payment_line := format(E'\n💰 Pagamento integral: *R$ %s*, recebido por fora em %s.',
      private.renewal_brl(new.upfront_total_cents / 100.0),
      to_char(new.external_received_on, 'DD/MM/YYYY'));
  end if;

  select regexp_replace(btrim(coalesce(full_name, 'Aluno')), '\s+', ' ', 'g') into v_student
    from public.profiles where id = new.student_id;
  perform private.notify_management_group(new.tenant_id, new.student_id,
    nullif(new.schedule_plan ->> 'teacher_id', '')::uuid, new.id, 'renewal-signed:' || new.id::text,
    format(E'✅ *RENOVAÇÃO ASSINADA*\n\n👤 Aluno(a): *%s*\n📄 %s meses · %sx por semana · *R$ %s*/mês\n📅 Início: %s · 1º vencimento: %s%s%s%s%s',
      coalesce(v_student, 'Aluno'), new.term_months, new.classes_per_week, private.renewal_brl(v_fee),
      to_char(new.contract_start, 'DD/MM/YYYY'), to_char(new.first_due_date, 'DD/MM/YYYY'),
      v_payment_line,
      coalesce(E'\n🕑 Horário: ' || private.renewal_schedule_text(new.schedule_plan), ''),
      case v_outcome
        when 'applied' then E'\n✔️ Agenda criada no sistema.'
        when 'pending_reactivation' then E'\n⚠️ Aluno(a) suspenso(a): reative o cadastro — a agenda é criada automaticamente na reativação.'
        when 'needs_review_existing_schedule' then E'\n⚠️ Aluno(a) já tem agenda ativa: ajuste manual necessário.'
        when 'apply_failed' then E'\n⚠️ Não foi possível criar a agenda (possível choque): ajuste manual necessário.'
        else '' end,
      v_profile_note));

  -- Dinheiro já recebido por fora: a assinatura é o que faltava para cobrir os meses.
  if new.billing_strategy = 'UPFRONT_EXTERNAL' then
    begin
      perform private.renewal_register_coverage(new.id, null);
    exception when others then
      raise warning '[renovação] cobertura da oferta % não registrada: %', new.id, sqlerrm;
      insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
      values (new.tenant_id, new.id, 'COVERAGE_FAILED', jsonb_build_object('error', left(sqlerrm, 200)));
    end;
  end if;
  return null;
end;
$$;

-- ─── Faturamento ─────────────────────────────────────────────────────────────
create or replace function public.student_course_renewal_billing_source(p_id uuid, p_claim uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  o private.student_course_renewal_offers%rowtype;
  p public.profiles%rowtype;
  r private.student_course_renewal_proposals%rowtype;
  v_dependent boolean;
begin
  select * into o from private.student_course_renewal_offers where id = p_id;
  select * into p from public.profiles where id = o.student_id and tenant_id = o.tenant_id;
  select * into r from private.student_course_renewal_proposals where id = o.proposal_id;
  if o.id is null or p.id is null or o.status <> 'SIGNED' or o.billing_status <> 'PROCESSING'
    or o.billing_claim_token is distinct from p_claim or o.billing_lease_expires_at < clock_timestamp()
    or o.first_due_date < (clock_timestamp() at time zone 'America/Sao_Paulo')::date
    -- Na cobrança única o cliente pode nascer agora; nas outras ele vem congelado.
    or (o.billing_strategy <> 'UPFRONT_CHARGE'
        and nullif(btrim(p.asaas_customer_id), '') is distinct from o.provider_customer_id)
    or coalesce(p.is_test_account, false) or p.test_fixture_key is not null
    or not private.tenant_is_operational(o.tenant_id) then
    return null;
  end if;
  v_dependent := p.guardian_id is not null or nullif(btrim(coalesce(p.guardian_cpf, '')), '') is not null;
  return jsonb_build_object(
    'id', o.id, 'tenant_id', o.tenant_id, 'student_id', o.student_id,
    'strategy', o.billing_strategy,
    'customer_id', case when o.billing_strategy = 'UPFRONT_CHARGE'
      then nullif(btrim(p.asaas_customer_id), '') else o.provider_customer_id end,
    'subscription_id', o.provider_subscription_id, 'billing_type', o.billing_type,
    'source_subscription_id', nullif(btrim(coalesce(r.source_snapshot ->> 'subscription_id', '')), ''),
    'monthly_fee_cents', o.monthly_fee_cents, 'first_due_date', o.first_due_date,
    'last_due_date', o.last_due_date, 'service_end_date', o.service_end_date,
    'term_months', o.term_months,
    'external_reference', 'renewal:' || o.id::text || ':subscription',
    'upfront', case when o.billing_strategy = 'UPFRONT_CHARGE' then jsonb_build_object(
      'total_cents', o.upfront_total_cents,
      'due_date', greatest(o.upfront_due_date, ((clock_timestamp() at time zone 'America/Sao_Paulo')::date + 1)),
      'billing_name', btrim(case when v_dependent then coalesce(p.guardian_name, '') else coalesce(p.full_name, '') end),
      'billing_cpf', regexp_replace(case when v_dependent then coalesce(p.guardian_cpf, '') else coalesce(p.cpf, '') end, '[^0-9]', '', 'g'),
      'billing_phone', regexp_replace(case when v_dependent then coalesce(p.guardian_phone, '') else coalesce(p.phone, '') end, '[^0-9]', '', 'g'),
      'billing_email', btrim(case when v_dependent then coalesce(p.guardian_email, '') else coalesce(p.email, '') end),
      'postal_code', btrim(coalesce(p.postal_code, '')),
      'address', btrim(coalesce(p.address, '')),
      'address_number', btrim(coalesce(p.address_number, ''))
    ) end
  );
end;
$fn$;

create or replace function public.finish_student_course_renewal_upfront_billing(
  p_id uuid, p_claim uuid, p_status text, p_customer text default null,
  p_payment text default null, p_invoice_url text default null, p_error text default null
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  o private.student_course_renewal_offers%rowtype;
  p public.profiles%rowtype;
  v_customer text := nullif(btrim(coalesce(p_customer, '')), '');
  v_payment text := nullif(btrim(coalesce(p_payment, '')), '');
  v_invoice text := nullif(btrim(coalesce(p_invoice_url, '')), '');
  v_status text := p_status;
  v_error text := p_error;
  v_phone text;
  v_name text;
  v_paid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-billing:' || p_id::text, 0));
  select * into o from private.student_course_renewal_offers where id = p_id for update;
  if not found or o.billing_status <> 'PROCESSING' or o.billing_claim_token is distinct from p_claim
    or o.billing_strategy <> 'UPFRONT_CHARGE' or p_status not in ('SYNCED', 'FAILED', 'REVIEW') then
    return jsonb_build_object('ok', false);
  end if;
  if v_status = 'SYNCED' and (v_customer is null or v_payment is null
       or (v_invoice is not null and v_invoice !~ '^https://[^\s"<>]+$')) then
    return jsonb_build_object('ok', false);
  end if;
  select * into p from public.profiles where id = o.student_id and tenant_id = o.tenant_id for update;
  if v_status = 'SYNCED' and nullif(btrim(coalesce(p.asaas_customer_id, '')), '') is distinct from v_customer then
    v_status := 'REVIEW';
    v_error := 'customer_binding_changed';
  end if;
  update private.student_course_renewal_offers
     set billing_status = v_status,
         provider_customer_id = coalesce(v_customer, provider_customer_id),
         provider_payment_id = case when v_status = 'SYNCED' then v_payment else provider_payment_id end,
         provider_invoice_url = case when v_status = 'SYNCED' then v_invoice else provider_invoice_url end,
         billing_synced_at = case when v_status = 'SYNCED' then clock_timestamp() else billing_synced_at end,
         billing_error = case when v_status = 'SYNCED' then null else left(coalesce(v_error, 'provider_operation_failed'), 500) end,
         billing_claim_token = null, billing_lease_expires_at = null
   where id = p_id;
  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'BILLING_' || v_status, jsonb_build_object(
    'provider_payment_id', case when v_status = 'SYNCED' then v_payment end,
    'error', case when v_status <> 'SYNCED' then left(coalesce(v_error, ''), 200) end));

  if v_status = 'SYNCED' then
    -- O link da cobrança vai pelo canal oficial; a página da assinatura também mostra.
    if p.guardian_id is not null or nullif(btrim(coalesce(p.guardian_cpf, '')), '') is not null then
      v_phone := p.guardian_phone; v_name := p.guardian_name;
    else
      v_phone := p.phone; v_name := p.full_name;
    end if;
    if v_invoice is not null and nullif(btrim(coalesce(v_phone, '')), '') is not null
       and not coalesce(p.is_test_account, false) and p.test_fixture_key is null then
      insert into public.notification_queue(tenant_id, student_id, student_name, student_phone, message_body,
        scheduled_for, status, source_id, source_type, notification_kind, idempotency_key)
      values (o.tenant_id, o.student_id, regexp_replace(btrim(coalesce(p.full_name, '')), '\s+', ' ', 'g'), v_phone,
        format(E'Olá, %s! Sua renovação de %s meses foi registrada. O pagamento integral é de R$ %s, com vencimento em %s.\n\nPague por este link:\n%s\n\nA cobertura dos meses entra assim que o pagamento for confirmado.',
          split_part(regexp_replace(btrim(coalesce(v_name, '')), '\s+', ' ', 'g'), ' ', 1), o.term_months,
          private.renewal_brl(o.upfront_total_cents / 100.0),
          to_char(greatest(o.upfront_due_date, ((clock_timestamp() at time zone 'America/Sao_Paulo')::date + 1)), 'DD/MM/YYYY'),
          v_invoice),
        now(), 'pending', o.id, 'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE', 'renewal-invoice:' || o.id::text)
      on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
    end if;
    -- Pagamento que chegou antes de o resultado ser gravado não pode ficar sem cobertura.
    select sp.id into v_paid from public.student_payments sp
     where nullif(btrim(coalesce(sp.asaas_payment_id, sp.asaas_id, '')), '') = v_payment
       and upper(btrim(coalesce(sp.status, ''))) in ('RECEIVED', 'RECEIVED_IN_CASH');
    if v_paid is not null then
      perform private.renewal_register_coverage(o.id, v_paid);
    end if;
  else
    perform private.notify_management_group(o.tenant_id, o.student_id, null, o.id,
      'renewal-billing-problem:' || o.id::text,
      format(E'⚠️ *COBRANÇA DA RENOVAÇÃO NÃO GERADA*\n\n👤 Aluno(a): *%s*\nA assinatura está registrada, mas a cobrança única não foi criada (%s). Confira a ficha do aluno antes de tentar de novo.',
        regexp_replace(btrim(coalesce(p.full_name, 'Aluno')), '\s+', ' ', 'g'), left(coalesce(v_error, 'erro'), 120)));
  end if;
  return jsonb_build_object('ok', true, 'status', v_status);
end;
$fn$;

-- O vínculo do cliente recém-criado sai pela mesma trava de ciclo de vida.
create or replace function public.bind_student_course_renewal_customer(p_id uuid, p_claim uuid, p_customer text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare o private.student_course_renewal_offers%rowtype; v_customer text := nullif(btrim(coalesce(p_customer, '')), ''); v_current text;
begin
  select * into o from private.student_course_renewal_offers where id = p_id;
  if not found or v_customer is null or o.billing_status <> 'PROCESSING'
    or o.billing_claim_token is distinct from p_claim or o.billing_strategy <> 'UPFRONT_CHARGE' then
    return jsonb_build_object('ok', false);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('student-billing-lifecycle:' || o.tenant_id || ':' || o.student_id::text, 0));
  select nullif(btrim(coalesce(asaas_customer_id, '')), '') into v_current
    from public.profiles where id = o.student_id and tenant_id = o.tenant_id for update;
  if v_current is not null then
    return jsonb_build_object('ok', v_current = v_customer, 'already', true);
  end if;
  update public.profiles set asaas_customer_id = v_customer where id = o.student_id and tenant_id = o.tenant_id;
  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'CUSTOMER_BOUND', jsonb_build_object('provider_customer_id', v_customer));
  return jsonb_build_object('ok', true, 'already', false);
end;
$fn$;

-- ─── WhatsApp com o link ─────────────────────────────────────────────────────
do $patch$
declare v_def text;
begin
  select pg_get_functiondef('public.student_course_renewal_notification_source(uuid,uuid)'::regprocedure) into v_def;
  if strpos(v_def, '''upfront_total_cents''') = 0 then
    if strpos(v_def, '''service_end_date'', o.service_end_date') = 0 then
      raise exception 'renewal_notification_source_anchor_missing';
    end if;
    v_def := replace(v_def, '''service_end_date'', o.service_end_date',
      '''service_end_date'', o.service_end_date,'
      || E'\n    ''billing_strategy'', o.billing_strategy,'
      || E'\n    ''upfront_total_cents'', o.upfront_total_cents');
    execute v_def;
  end if;
end;
$patch$;

-- O bot da renovação remonta a oferta com 6 meses e assinatura mensal. Prazo de
-- 12 meses e pagamento integral ficam fora dele: quem negocia é a escola.
do $patch$
declare v_def text; v_guard text := 'and term_months = 6 and billing_strategy in (''CREATE_NEW'', ''REUSE_EXISTING'')';
begin
  select pg_get_functiondef('public.renewal_negotiation_context(text,uuid)'::regprocedure) into v_def;
  if strpos(v_def, 'term_months = 6') = 0 then
    if strpos(v_def, 'where tenant_id = p_tenant and student_id = p_student and status = ''PENDING_SIGNATURE''') = 0 then
      raise exception 'renewal_negotiation_context_anchor_missing';
    end if;
    v_def := replace(v_def, 'where tenant_id = p_tenant and student_id = p_student and status = ''PENDING_SIGNATURE''',
      'where tenant_id = p_tenant and student_id = p_student and status = ''PENDING_SIGNATURE'' ' || v_guard);
    execute v_def;
  end if;
  select pg_get_functiondef('public.open_renewal_negotiation(text,uuid,smallint,jsonb,text)'::regprocedure) into v_def;
  if strpos(v_def, 'term_months = 6') = 0 then
    if strpos(v_def, 'where tenant_id = p_tenant and student_id = p_student and status = ''PENDING_SIGNATURE''') = 0 then
      raise exception 'open_renewal_negotiation_anchor_missing';
    end if;
    v_def := replace(v_def, 'where tenant_id = p_tenant and student_id = p_student and status = ''PENDING_SIGNATURE''',
      'where tenant_id = p_tenant and student_id = p_student and status = ''PENDING_SIGNATURE'' ' || v_guard);
    execute v_def;
  end if;
  select pg_get_functiondef('public.renewal_student_for_phone(text,text)'::regprocedure) into v_def;
  if strpos(v_def, 'o.term_months = 6') = 0 then
    if strpos(v_def, 'and o.status = ''PENDING_SIGNATURE'' and o.expires_at > clock_timestamp()') = 0 then
      raise exception 'renewal_student_for_phone_anchor_missing';
    end if;
    v_def := replace(v_def, 'and o.status = ''PENDING_SIGNATURE'' and o.expires_at > clock_timestamp()',
      'and o.status = ''PENDING_SIGNATURE'' and o.expires_at > clock_timestamp() and o.term_months = 6 and o.billing_strategy in (''CREATE_NEW'', ''REUSE_EXISTING'')');
    execute v_def;
  end if;
end;
$patch$;

-- "Condições de renovação" na conciliação são rascunhos de operador: oferta
-- emitida já tem situação própria e não pode aparecer como "sem link".
create or replace function public.list_student_course_renewal_proposals(p_tenant text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tenant text; v_role text; v_rows jsonb;
begin
  v_tenant:=private.active_tenant_id(auth.uid());
  v_role:=private.active_tenant_role(auth.uid());
  if auth.uid() is null or v_tenant is null or coalesce(v_role,'') not in ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR')
    or (p_tenant is not null and p_tenant is distinct from v_tenant)
    or not private.tenant_is_operational(v_tenant) then
    raise exception 'renewal_proposal_access_denied' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'student_name',p.full_name,'term_months',r.term_months,
    'monthly_fee_cents',r.monthly_fee_cents,'total_cents',r.monthly_fee_cents*r.term_months,
    'classes_per_week',r.classes_per_week,'suggested_due_day',r.suggested_due_day,
    'status',r.status,'signature_status',r.signature_status,'billing_status',r.billing_status
  ) order by r.created_at desc),'[]'::jsonb) into v_rows
  from private.student_course_renewal_proposals r
  join public.profiles p on p.id=r.student_id and p.tenant_id=r.tenant_id
  where r.tenant_id=v_tenant
    and r.term_months=6
    and not exists (select 1 from private.student_course_renewal_offers o where o.proposal_id=r.id);
  return jsonb_build_object('items',v_rows);
end;
$$;

do $owners$
begin
  alter function public.get_student_course_renewal_public(text) owner to postgres;
  alter function public.sign_student_course_renewal(text, text, date) owner to postgres;
  alter function private.on_student_course_renewal_signed() owner to postgres;
  alter function public.student_course_renewal_billing_source(uuid, uuid) owner to postgres;
  alter function public.finish_student_course_renewal_upfront_billing(uuid, uuid, text, text, text, text, text) owner to postgres;
  alter function public.bind_student_course_renewal_customer(uuid, uuid, text) owner to postgres;
  alter function public.list_student_course_renewal_proposals(text) owner to postgres;
end
$owners$;
revoke all on function public.get_student_course_renewal_public(text),
  public.sign_student_course_renewal(text, text, date),
  private.on_student_course_renewal_signed(),
  public.student_course_renewal_billing_source(uuid, uuid),
  public.finish_student_course_renewal_upfront_billing(uuid, uuid, text, text, text, text, text),
  public.bind_student_course_renewal_customer(uuid, uuid, text),
  public.list_student_course_renewal_proposals(text)
from public, anon, authenticated, service_role;
grant execute on function public.get_student_course_renewal_public(text) to anon, authenticated, service_role;
grant execute on function public.sign_student_course_renewal(text, text, date) to anon, authenticated;
grant execute on function public.student_course_renewal_billing_source(uuid, uuid) to service_role;
grant execute on function public.finish_student_course_renewal_upfront_billing(uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.bind_student_course_renewal_customer(uuid, uuid, text) to service_role;
grant execute on function public.list_student_course_renewal_proposals(text) to authenticated;

-- Cobrança que não saiu (Asaas fora, cadastro corrigido): a direção manda de
-- novo. O trilho durável do provedor reconcilia antes de qualquer POST, então
-- repetir não cria segunda cobrança. Só a cobrança única: assinatura em revisão
-- continua sendo caso de conferência no Asaas.
create or replace function public.retry_student_renewal_billing(p_offer uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o private.student_course_renewal_offers%rowtype;
begin
  select * into o from private.student_course_renewal_offers where id = p_offer for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'renovacao_nao_encontrada'); end if;
  if not private.prepayment_caller_can_write(o.tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  if o.status <> 'SIGNED' or o.billing_strategy <> 'UPFRONT_CHARGE' or not (
       o.billing_status in ('FAILED', 'REVIEW')
       or (o.billing_status = 'PROCESSING' and o.billing_lease_expires_at < clock_timestamp())) then
    return jsonb_build_object('ok', false, 'error', 'cobranca_sem_nova_tentativa');
  end if;
  update private.student_course_renewal_offers
     set billing_status = 'PENDING', billing_error = null,
         billing_claim_token = null, billing_lease_expires_at = null
   where id = o.id;
  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'BILLING_RETRY_REQUESTED', jsonb_build_object(
    'actor', auth.uid(), 'previous_status', o.billing_status, 'previous_error', o.billing_error));
  return jsonb_build_object('ok', true);
end;
$$;
alter function public.retry_student_renewal_billing(uuid) owner to postgres;
revoke all on function public.retry_student_renewal_billing(uuid) from public, anon, authenticated, service_role;
grant execute on function public.retry_student_renewal_billing(uuid) to authenticated;
