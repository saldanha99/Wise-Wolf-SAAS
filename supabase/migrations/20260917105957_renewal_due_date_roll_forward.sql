-- A renovacao pode continuar sendo assinada depois do inicio das aulas, mas
-- nunca pode enviar ao Asaas uma primeira cobranca no passado. As datas
-- ajustadas sao exibidas antes do aceite e a data exibida faz parte do pedido
-- de assinatura, evitando alteracao silenciosa se a pagina atravessar a
-- meia-noite.

create or replace function private.student_course_renewal_effective_first_due_date(
  p_first_due_date date,
  p_now timestamptz default clock_timestamp()
) returns date
language sql
stable
security invoker
set search_path = ''
as $$
  select greatest(
    p_first_due_date,
    (p_now at time zone 'America/Sao_Paulo')::date + 1
  );
$$;

create or replace function private.issue_student_course_renewal_offer(
  p_proposal uuid,
  p_contract_start date,
  p_first_due_date date,
  p_previous_service_end date,
  p_strategy text,
  p_customer text,
  p_subscription text,
  p_billing_type text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r private.student_course_renewal_proposals%rowtype;
  o private.student_course_renewal_offers%rowtype;
  v_token text;
  v_last_due date;
  v_service_end date;
begin
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-issue:' || p_proposal::text, 0));
  select * into r from private.student_course_renewal_proposals where id = p_proposal for share;
  if not found or r.status <> 'DRAFT' or r.signature_status <> 'NOT_REQUESTED'
    or r.billing_status <> 'NOT_AUTHORIZED' or p_contract_start is null
    or p_first_due_date is null or p_first_due_date < p_contract_start
    or p_strategy not in ('CREATE_NEW', 'REUSE_EXISTING')
    or p_billing_type not in ('PIX', 'BOLETO', 'CREDIT_CARD')
    or nullif(btrim(p_customer), '') is null
    or (p_strategy = 'CREATE_NEW' and nullif(btrim(coalesce(p_subscription, '')), '') is not null)
    or (p_strategy = 'REUSE_EXISTING' and nullif(btrim(coalesce(p_subscription, '')), '') is null)
    or not private.tenant_is_operational(r.tenant_id) then
    raise exception 'renewal_offer_invalid';
  end if;

  select * into o from private.student_course_renewal_offers where proposal_id = p_proposal;
  if found then
    if o.contract_start is distinct from p_contract_start
      or o.first_due_date is distinct from p_first_due_date
      or o.previous_service_end_date is distinct from p_previous_service_end
      or o.billing_strategy is distinct from p_strategy
      or o.provider_customer_id is distinct from btrim(p_customer)
      or o.provider_subscription_id is distinct from nullif(btrim(coalesce(p_subscription, '')), '')
      or o.billing_type is distinct from p_billing_type then
      raise exception 'renewal_offer_replay_conflict';
    end if;
    return jsonb_build_object('id', o.id, 'token', o.token, 'already', true);
  end if;

  v_last_due := public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(
    public.fim_do_servico(public.fim_do_servico(p_first_due_date)))));
  v_service_end := public.fim_do_servico(v_last_due);
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into private.student_course_renewal_offers(
    proposal_id, tenant_id, student_id, token, contract_start, first_due_date,
    last_due_date, service_end_date, previous_service_end_date, term_months,
    monthly_fee_cents, classes_per_week, billing_strategy, provider_customer_id,
    provider_subscription_id, billing_type, expires_at
  ) values (
    r.id, r.tenant_id, r.student_id, v_token, p_contract_start, p_first_due_date,
    v_last_due, v_service_end, p_previous_service_end, r.term_months,
    r.monthly_fee_cents, r.classes_per_week, p_strategy, btrim(p_customer),
    nullif(btrim(coalesce(p_subscription, '')), ''), p_billing_type,
    coalesce(p_expires_at, clock_timestamp() + interval '30 days')
  ) returning * into o;

  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'ISSUED', jsonb_build_object(
    'contract_start', o.contract_start,
    'first_due_date', o.first_due_date,
    'last_due_date', o.last_due_date,
    'service_end_date', o.service_end_date,
    'strategy', o.billing_strategy,
    'proposal_id', o.proposal_id
  ));
  return jsonb_build_object('id', o.id, 'token', o.token, 'already', false);
end;
$fn$;

create or replace function public.get_student_course_renewal_public(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
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
  v_last_due := public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(
    public.fim_do_servico(public.fim_do_servico(v_first_due)))));
  v_service_end := public.fim_do_servico(v_last_due);

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'student_name', p.full_name,
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
    'schedule', case when o.schedule_plan is null then null else jsonb_build_object(
      'teacher_first_name', split_part(btrim(coalesce(o.schedule_plan ->> 'teacher_name', '')), ' ', 1),
      'slots', o.schedule_plan -> 'slots') end,
    'school_logo_url', case when v_branding ->> 'logoUrl' ~ '^https://[^\s"<>]+$' then v_branding ->> 'logoUrl' end,
    'brand_primary', case when v_branding ->> 'primaryColor' ~ '^#[0-9a-fA-F]{6}$' then v_branding ->> 'primaryColor' end,
    'brand_secondary', case when v_branding ->> 'secondaryColor' ~ '^#[0-9a-fA-F]{6}$' then v_branding ->> 'secondaryColor' end
  ));
end;
$fn$;

-- A assinatura antiga falha fechada para clientes com JavaScript em cache.
-- O contrato precisa reenviar a data que foi exibida na pagina.
create or replace function public.sign_student_course_renewal(
  p_token text,
  p_typed_signature text
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', false,
    'error', 'Atualize esta página para confirmar as datas antes de assinar.'
  );
$$;

create or replace function public.sign_student_course_renewal(
  p_token text,
  p_typed_signature text,
  p_expected_first_due_date date
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  o private.student_course_renewal_offers%rowtype;
  p public.profiles%rowtype;
  v_ip text;
  v_first_due date;
  v_last_due date;
  v_service_end date;
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
  v_last_due := public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(
    public.fim_do_servico(public.fim_do_servico(v_first_due)))));
  v_service_end := public.fim_do_servico(v_last_due);
  v_ip := coalesce(
    nullif(btrim(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)), ''),
    'Via Web (Digital)'
  );

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
         status = 'SIGNED',
         billing_status = 'PENDING',
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
  return jsonb_build_object('ok', true, 'already', false, 'billing_status', 'PENDING');
end;
$fn$;

create or replace function public.student_course_renewal_billing_source(p_id uuid, p_claim uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  o private.student_course_renewal_offers%rowtype;
  p public.profiles%rowtype;
  r private.student_course_renewal_proposals%rowtype;
begin
  select * into o from private.student_course_renewal_offers where id = p_id;
  select * into p from public.profiles where id = o.student_id and tenant_id = o.tenant_id;
  select * into r from private.student_course_renewal_proposals where id = o.proposal_id;
  if o.id is null or p.id is null or o.status <> 'SIGNED' or o.billing_status <> 'PROCESSING'
    or o.billing_claim_token is distinct from p_claim or o.billing_lease_expires_at < clock_timestamp()
    or o.first_due_date < (clock_timestamp() at time zone 'America/Sao_Paulo')::date
    or nullif(btrim(p.asaas_customer_id), '') is distinct from o.provider_customer_id
    or coalesce(p.is_test_account, false) or p.test_fixture_key is not null
    or not private.tenant_is_operational(o.tenant_id) then
    return null;
  end if;
  return jsonb_build_object(
    'id', o.id, 'tenant_id', o.tenant_id, 'student_id', o.student_id,
    'strategy', o.billing_strategy, 'customer_id', o.provider_customer_id,
    'subscription_id', o.provider_subscription_id, 'billing_type', o.billing_type,
    'source_subscription_id', nullif(btrim(coalesce(r.source_snapshot ->> 'subscription_id', '')), ''),
    'monthly_fee_cents', o.monthly_fee_cents, 'first_due_date', o.first_due_date,
    'last_due_date', o.last_due_date, 'service_end_date', o.service_end_date,
    'external_reference', 'renewal:' || o.id::text || ':subscription'
  );
end;
$fn$;

alter function private.student_course_renewal_effective_first_due_date(date, timestamptz) owner to postgres;
alter function private.issue_student_course_renewal_offer(uuid, date, date, date, text, text, text, text, timestamptz) owner to postgres;
alter function public.get_student_course_renewal_public(text) owner to postgres;
alter function public.sign_student_course_renewal(text, text) owner to postgres;
alter function public.sign_student_course_renewal(text, text, date) owner to postgres;
alter function public.student_course_renewal_billing_source(uuid, uuid) owner to postgres;

revoke all on function private.student_course_renewal_effective_first_due_date(date, timestamptz),
  private.issue_student_course_renewal_offer(uuid, date, date, date, text, text, text, text, timestamptz),
  public.get_student_course_renewal_public(text),
  public.sign_student_course_renewal(text, text),
  public.sign_student_course_renewal(text, text, date),
  public.student_course_renewal_billing_source(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function public.get_student_course_renewal_public(text) to anon, authenticated, service_role;
grant execute on function public.sign_student_course_renewal(text, text, date) to anon, authenticated;
grant execute on function public.student_course_renewal_billing_source(uuid, uuid) to service_role;
