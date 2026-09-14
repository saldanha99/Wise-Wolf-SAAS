-- Fresh provider GET may update a uniquely bound invoice, never discover/create
-- revenue or assign ownership. CONFIRMED is deliberately not settled cash.
alter table public.student_payments add column if not exists authoritative_subscription_id text;
alter table public.student_payments add column if not exists last_authoritative_observed_at timestamptz;

create table if not exists private.bound_payment_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  payment_id uuid not null references public.student_payments(id) on delete restrict,
  integration_id uuid not null,
  integration_version bigint not null,
  provider_payment_id text not null,
  source_event_id text,
  proof_hash text not null,
  provider_snapshot jsonb not null,
  parent_snapshot jsonb,
  before_state jsonb not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(payment_id,proof_hash)
);
alter table private.bound_payment_observations owner to postgres;
alter table private.bound_payment_observations enable row level security;
revoke all on private.bound_payment_observations from public,anon,authenticated,service_role;
drop trigger if exists bound_payment_observations_immutable on private.bound_payment_observations;
create trigger bound_payment_observations_immutable before update or delete or truncate
  on private.bound_payment_observations for each statement execute function private.guard_prepayment_audit_immutable();

create or replace function private.bound_payment_reference_matches(p_reference text,p_student uuid,p_tenant text,p_parent boolean)
returns boolean language plpgsql stable security definer set search_path='' as $fn$
declare v_ref text:=btrim(coalesce(p_reference,'')); v_match text[];
begin
  if v_ref='' or v_ref=p_student::text then return true; end if;
  if not p_parent and v_ref in ('student:'||p_student::text||':one-time','student:'||p_student::text||':pro-rata') then return true; end if;
  v_match:=regexp_match(v_ref,'^enrollment:([0-9a-f-]{36}):(subscription|one-time|pro-rata|fee)$','i');
  if v_match is null or (p_parent and v_match[2]<>'subscription') then return false; end if;
  return exists(select 1 from public.offers o where o.id::text=lower(v_match[1])
    and o.tenant_id=p_tenant and o.kind='ENROLLMENT' and p_student in (o.processing_by,o.consumed_by));
end $fn$;

create or replace function private.minimal_bound_provider_snapshot(p_value jsonb,p_parent boolean)
returns jsonb language plpgsql immutable set search_path='' as $fn$
declare v_fields text[]; v_result jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) is distinct from 'object' then return p_value; end if;
  v_fields:=case when p_parent then array['id','customer','status','deleted','externalReference']
    else array['id','customer','subscription','externalReference','value','status','dueDate','paymentDate',
      'creditDate','estimatedCreditDate','deleted','refundedValue'] end;
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_result from jsonb_each(p_value) where key=any(v_fields);
  if not p_parent and jsonb_typeof(p_value->'refunds')='array' then
    v_result:=v_result||jsonb_build_object('refunds',(select coalesce(jsonb_agg(jsonb_strip_nulls(
      jsonb_build_object('id',r->'id','status',r->'status','value',r->'value'))),'[]'::jsonb)
      from jsonb_array_elements(p_value->'refunds') r));
  end if;
  if not p_parent and p_value ? 'chargeback' and p_value->'chargeback'<>'null'::jsonb then
    v_result:=v_result||jsonb_build_object('chargeback',jsonb_build_object('status',
      coalesce(nullif(p_value#>>'{chargeback,status}',''),'UNKNOWN')));
  end if;
  return v_result;
end $fn$;
alter function private.minimal_bound_provider_snapshot(jsonb,boolean) owner to postgres;
revoke all on function private.minimal_bound_provider_snapshot(jsonb,boolean) from public,anon,authenticated,service_role;

-- Provider-only counterpart of prepayment_payment_review_reason. Its tuition
-- and local RECEIVED requirements cannot gate a pending invoice correction.
create or replace function private.bound_payment_has_reversal_evidence(p_payment uuid)
returns boolean language sql stable security definer set search_path='' as $fn$
  select coalesce((select coalesce(p.refunded_amount,0)>0
    or coalesce(p.raw_payload#>'{payment,chargeback}','null'::jsonb)<>'null'::jsonb
    or upper(btrim(coalesce(p.provider_status,''))) in ('REFUNDED','REFUND_REQUESTED','REFUND_IN_PROGRESS',
      'CHARGEBACK_REQUESTED','CHARGEBACK_DISPUTE','AWAITING_CHARGEBACK_REVERSAL','DELETED','CANCELLED')
    or exists(select 1 from public.asaas_reconciliation_issues issue
      where issue.provider_entity_id in (p.asaas_payment_id,p.asaas_id)
        and (issue.tenant_id=p.tenant_id or issue.tenant_id is null) and issue.resolved_at is null
        and issue.kind='NON_FINAL_FINANCIAL_EVENT')
    or exists(select 1 from public.asaas_webhook_inbox i
      where i.provider_entity_id in (p.asaas_payment_id,p.asaas_id)
        and (i.status<>'PROCESSED' or i.provider_event_id=(select latest.provider_event_id
          from public.asaas_webhook_inbox latest where latest.provider_entity_id in (p.asaas_payment_id,p.asaas_id)
          order by latest.event_created_at desc nulls last,latest.received_at desc nulls last,latest.provider_event_id desc limit 1))
        and (coalesce(i.payload#>'{payment,chargeback}','null'::jsonb)<>'null'::jsonb
          or coalesce(i.payload#>>'{payment,refundedValue}','0') !~ '^0(\.0+)?$'
          or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(i.payload#>'{payment,refunds}')='array'
            then i.payload#>'{payment,refunds}' else '[]'::jsonb end) refund
            where upper(coalesce(refund->>'status','')) in ('DONE','REQUESTED','IN_PROGRESS'))
          or i.event_name in ('PAYMENT_REFUNDED','PAYMENT_PARTIALLY_REFUNDED','PAYMENT_REFUND_IN_PROGRESS',
          'PAYMENT_CHARGEBACK_REQUESTED','PAYMENT_CHARGEBACK_DISPUTE','PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
          'PAYMENT_DELETED','PAYMENT_RECEIVED_IN_CASH_UNDONE')
          or upper(coalesce(i.payload#>>'{payment,status}','')) in ('REFUNDED','REFUND_REQUESTED','REFUND_IN_PROGRESS',
            'CHARGEBACK_REQUESTED','CHARGEBACK_DISPUTE','AWAITING_CHARGEBACK_REVERSAL','DELETED','CANCELLED')))
    from public.student_payments p where p.id=p_payment),true);
$fn$;
alter function private.bound_payment_has_reversal_evidence(uuid) owner to postgres;
revoke all on function private.bound_payment_has_reversal_evidence(uuid) from public,anon,authenticated,service_role;

create or replace function public.apply_authoritative_bound_student_payment(
  p_expected_local_snapshot jsonb,p_integration_id uuid,p_integration_version bigint,p_integration_mode text,
  p_authoritative_payment jsonb,p_authoritative_subscription jsonb,p_observed_at timestamptz,
  p_source_event_id text default null
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_p public.student_payments%rowtype; v_profile public.profiles%rowtype;
  v_conn private.tenant_integration_connections%rowtype;
  v_id uuid; v_student uuid; v_tenant text; v_provider text; v_customer text; v_subscription text; v_known_sub text;
  v_status text; v_value numeric; v_due date; v_payment_date date; v_credit date; v_estimate date;
  v_hash text; v_observation uuid; v_prior_status text; v_payload jsonb; v_event public.asaas_webhook_inbox%rowtype;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if jsonb_typeof(p_expected_local_snapshot) is distinct from 'object'
    or jsonb_typeof(p_authoritative_payment) is distinct from 'object'
    or p_observed_at is null or p_observed_at<clock_timestamp()-interval '45 seconds'
    or p_observed_at>clock_timestamp()+interval '5 seconds' then
    return jsonb_build_object('ok',false,'reason','bound_observation_invalid_or_stale'); end if;
  p_authoritative_payment:=private.minimal_bound_provider_snapshot(p_authoritative_payment,false);
  p_authoritative_subscription:=private.minimal_bound_provider_snapshot(p_authoritative_subscription,true);
  begin
    v_id:=(p_expected_local_snapshot->>'id')::uuid; v_student:=(p_expected_local_snapshot->>'student_id')::uuid;
    v_tenant:=nullif(btrim(p_expected_local_snapshot->>'tenant_id'),'');
    v_provider:=nullif(btrim(p_authoritative_payment->>'id'),'');
    v_customer:=nullif(btrim(p_authoritative_payment->>'customer'),'');
    v_subscription:=nullif(btrim(p_authoritative_payment->>'subscription'),'');
    v_status:=upper(btrim(p_authoritative_payment->>'status'));
    v_value:=(p_authoritative_payment->>'value')::numeric;
    v_due:=(p_authoritative_payment->>'dueDate')::date;
    v_payment_date:=nullif(p_authoritative_payment->>'paymentDate','')::date;
    v_credit:=nullif(p_authoritative_payment->>'creditDate','')::date;
    v_estimate:=nullif(p_authoritative_payment->>'estimatedCreditDate','')::date;
  exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
    return jsonb_build_object('ok',false,'reason','bound_observation_fields_invalid'); end;
  if v_id is null or v_student is null or v_tenant is null or v_provider !~ '^pay_[A-Za-z0-9]+$'
    or v_provider is null or v_customer !~ '^cus_[A-Za-z0-9]+$' or v_customer is null
    or v_status not in ('CONFIRMED','RECEIVED','RECEIVED_IN_CASH') or v_status is null
    or v_value is null or v_value::text in ('NaN','Infinity','-Infinity') or v_value<=0 or v_due is null
    or coalesce(p_authoritative_payment->>'deleted','false')<>'false'
    or coalesce(p_authoritative_payment->'chargeback','null'::jsonb)<>'null'::jsonb
    or coalesce((p_authoritative_payment->>'refundedValue')::numeric,0)>0
    or exists(select 1 from jsonb_array_elements(coalesce(p_authoritative_payment->'refunds','[]')) r
      where upper(coalesce(r->>'status','')) in ('DONE','REQUESTED','IN_PROGRESS'))
    or (v_status='RECEIVED' and v_credit is null)
    or (v_status='RECEIVED_IN_CASH' and v_payment_date is null)
  then return jsonb_build_object('ok',false,'reason','bound_observation_not_positive_payment_proof'); end if;
  perform pg_advisory_xact_lock(hashtextextended('student-billing-lifecycle:'||v_tenant||':'||v_student::text,0));
  perform pg_advisory_xact_lock(hashtextextended('management-payment-notification:'||v_tenant||':'||v_id::text,0));
  select * into v_profile from public.profiles where id=v_student and tenant_id=v_tenant and role='STUDENT' for share;
  if not found or nullif(btrim(v_profile.asaas_customer_id),'') is distinct from v_customer then
    return jsonb_build_object('ok',false,'reason','bound_student_customer_mismatch'); end if;
  select * into v_p from public.student_payments where id=v_id for update;
  if not found or v_p.student_id is distinct from v_student or v_p.tenant_id is distinct from v_tenant
    or not (to_jsonb(v_p) @> p_expected_local_snapshot)
    or v_p.value is distinct from v_value or coalesce(v_p.refunded_amount,0)>0
    or upper(coalesce(v_p.status,'')) not in ('PENDING','OVERDUE','CONFIRMED','RECEIVED','RECEIVED_IN_CASH')
    or (nullif(btrim(v_p.provider_customer_id),'') is not null and btrim(v_p.provider_customer_id)<>v_customer)
    or (v_provider is distinct from v_p.asaas_payment_id and v_provider is distinct from v_p.asaas_id)
    or (nullif(btrim(v_p.asaas_payment_id),'') is not null and btrim(v_p.asaas_payment_id)<>v_provider)
    or (nullif(btrim(v_p.asaas_id),'') is not null and btrim(v_p.asaas_id)<>v_provider)
    or (select count(*) from public.student_payments p where v_provider in (p.asaas_payment_id,p.asaas_id))<>1
  then return jsonb_build_object('ok',false,'reason','bound_local_snapshot_changed_or_ambiguous'); end if;
  if private.bound_payment_has_reversal_evidence(v_p.id) then
    return jsonb_build_object('ok',false,'reason','bound_local_financial_review_required'); end if;
  if nullif(btrim(v_p.provider_customer_id),'') is null and (select count(*) from public.profiles p
    where p.role='STUDENT' and p.asaas_customer_id=v_customer)<>1 then
    return jsonb_build_object('ok',false,'reason','bound_customer_identity_ambiguous'); end if;
  v_known_sub:=coalesce(nullif(v_p.authoritative_subscription_id,''),nullif(v_p.raw_payload#>>'{payment,subscription}',''),
    nullif(v_p.raw_payload->>'subscription',''));
  if (v_known_sub is not null and v_known_sub is distinct from v_subscription)
    or (v_known_sub is null and v_subscription is not null and nullif(v_profile.subscription_id,'') is not null
      and v_profile.subscription_id<>v_subscription)
    or not private.bound_payment_reference_matches(p_authoritative_payment->>'externalReference',v_student,v_tenant,false)
  then return jsonb_build_object('ok',false,'reason','bound_subscription_or_reference_changed'); end if;
  if v_subscription is not null then
    if v_subscription !~ '^sub_[A-Za-z0-9]+$' or jsonb_typeof(p_authoritative_subscription) is distinct from 'object'
      or p_authoritative_subscription->>'id' is distinct from v_subscription
      or p_authoritative_subscription->>'customer' is distinct from v_customer
      or coalesce(p_authoritative_subscription->>'deleted','false')<>'false'
      or upper(coalesce(p_authoritative_subscription->>'status','')) not in ('ACTIVE','INACTIVE','EXPIRED')
      or not private.bound_payment_reference_matches(p_authoritative_subscription->>'externalReference',v_student,v_tenant,true)
    then return jsonb_build_object('ok',false,'reason','bound_parent_not_corroborated'); end if;
  elsif p_authoritative_subscription is not null and p_authoritative_subscription<>'null'::jsonb then
    return jsonb_build_object('ok',false,'reason','bound_parent_unexpected'); end if;
  perform 1 from public.tenants where id=v_tenant for share;
  if not private.tenant_is_operational(v_tenant) then return jsonb_build_object('ok',false,'reason','bound_tenant_inactive'); end if;
  select * into v_conn from private.tenant_integration_connections where id=p_integration_id and tenant_id=v_tenant
    and provider='asaas' and version=p_integration_version and mode=p_integration_mode
    and mode='PLATFORM_MANAGED_ROOT' and v_tenant='school-wise-wolf' and status in ('configured','healthy') for share;
  if not found then return jsonb_build_object('ok',false,'reason','bound_integration_changed'); end if;
  if p_source_event_id is not null then
    select * into v_event from public.asaas_webhook_inbox where provider_event_id=p_source_event_id;
    if not found or v_event.status<>'PROCESSING' or v_event.provider_entity_id<>v_provider
      or v_event.event_name not in ('PAYMENT_CONFIRMED','PAYMENT_RECEIVED','PAYMENT_RECEIVED_IN_CASH')
      or v_event.payload#>>'{payment,customer}' is distinct from v_customer
      or nullif(v_event.payload#>>'{payment,subscription}','') is distinct from v_subscription
      or (v_event.payload#>>'{payment,value}')::numeric is distinct from v_value
      or v_event.payload#>>'{payment,status}' is distinct from v_status
    then return jsonb_build_object('ok',false,'reason','bound_event_not_corroborated'); end if;
    if v_p.last_provider_event_at>v_event.event_created_at then
      return jsonb_build_object('ok',true,'action','IGNORED','id',v_p.id,'status',v_p.status); end if;
  end if;
  if v_p.status in ('RECEIVED','RECEIVED_IN_CASH') and v_status='CONFIRMED' then
    return jsonb_build_object('ok',false,'reason','bound_settlement_cannot_regress'); end if;
  -- Lock waits count towards freshness too; never authorize an old GET after
  -- waiting behind a financial mutation or an integration rotation.
  if p_observed_at<clock_timestamp()-interval '45 seconds' then
    return jsonb_build_object('ok',false,'reason','bound_observation_invalid_or_stale'); end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('payment',p_authoritative_payment,
    'parent',p_authoritative_subscription)::text,'UTF8'),'sha256'),'hex');
  v_prior_status:=v_p.status;
  select id into v_observation from private.bound_payment_observations where payment_id=v_id and proof_hash=v_hash;
  if v_observation is not null then
    if v_p.status is distinct from v_status or v_p.provider_status is distinct from v_status
      or v_p.due_date is distinct from v_due or v_p.provider_customer_id is distinct from v_customer
      or v_p.authoritative_subscription_id is distinct from v_subscription
      or v_p.payment_date is distinct from (case when v_status='CONFIRMED' then null else v_payment_date end)
      or (v_p.credited_at at time zone 'America/Sao_Paulo')::date is distinct from (case when v_status='RECEIVED' then v_credit else null end)
      or (v_p.paid_at at time zone 'America/Sao_Paulo')::date is distinct from (case when v_status='CONFIRMED' then null when v_status='RECEIVED' then v_credit else v_payment_date end)
      or (v_estimate is not null and (v_p.estimated_credit_at at time zone 'America/Sao_Paulo')::date is distinct from v_estimate) then
      return jsonb_build_object('ok',false,'reason','bound_previous_proof_local_state_diverged'); end if;
    -- A repeat GET is new freshness evidence, but not a new cash movement or
    -- another copy of the immutable provider snapshot.
    update public.student_payments set last_authoritative_observed_at=p_observed_at,
      last_provider_event_id=coalesce(p_source_event_id,last_provider_event_id),
      last_provider_event_at=case when p_source_event_id is null then last_provider_event_at else v_event.event_created_at end,
      last_provider_event_rank=case when p_source_event_id is null then last_provider_event_rank
        when v_event.event_name='PAYMENT_CONFIRMED' then 60 else 80 end,
      updated_at=clock_timestamp() where id=v_id;
    return jsonb_build_object('ok',true,'action','ALREADY_APPLIED','id',v_p.id,'status',v_p.status,'due_date',v_p.due_date); end if;
  insert into private.bound_payment_observations(tenant_id,payment_id,integration_id,integration_version,
    provider_payment_id,source_event_id,proof_hash,provider_snapshot,parent_snapshot,before_state,observed_at)
  values(v_tenant,v_id,p_integration_id,p_integration_version,v_provider,p_source_event_id,v_hash,
    p_authoritative_payment,p_authoritative_subscription,
    jsonb_build_object('id',v_p.id,'tenant_id',v_p.tenant_id,'student_id',v_p.student_id,
      'asaas_payment_id',v_p.asaas_payment_id,'asaas_id',v_p.asaas_id,'provider_customer_id',v_p.provider_customer_id,
      'value',v_p.value,'status',v_p.status,'provider_status',v_p.provider_status,'due_date',v_p.due_date,
      'payment_date',v_p.payment_date,'paid_at',v_p.paid_at,'credited_at',v_p.credited_at,
      'refunded_amount',v_p.refunded_amount,'authoritative_subscription_id',v_p.authoritative_subscription_id,
      'last_provider_event_id',v_p.last_provider_event_id,'last_provider_event_at',v_p.last_provider_event_at,
      'last_authoritative_observed_at',v_p.last_authoritative_observed_at),p_observed_at) returning id into v_observation;
  v_payload:=case when p_source_event_id is null then
    jsonb_build_object('source','AUTHORITATIVE_BOUND_GET','observation_id',v_observation,'payment',p_authoritative_payment)
    else jsonb_build_object('id',v_event.provider_event_id,'event',v_event.event_name,
      'dateCreated',v_event.payload->'dateCreated','payment',private.minimal_bound_provider_snapshot(v_event.payload->'payment',false),
      'authoritative_observation_id',v_observation,'authoritative_payment',p_authoritative_payment) end;
  update public.student_payments set status=v_status,provider_status=v_status,provider_customer_id=v_customer,
    due_date=v_due,authoritative_subscription_id=v_subscription,last_authoritative_observed_at=p_observed_at,
    payment_date=case when v_status='CONFIRMED' then null else v_payment_date end,
    credited_at=case when v_status<>'RECEIVED' then null
      when (credited_at at time zone 'America/Sao_Paulo')::date=v_credit then credited_at
      else (v_credit::timestamp+interval '12 hours') at time zone 'UTC' end,
    paid_at=case when v_status='CONFIRMED' then null
      when (paid_at at time zone 'America/Sao_Paulo')::date=case when v_status='RECEIVED' then v_credit else v_payment_date end then paid_at
      else ((case when v_status='RECEIVED' then v_credit else v_payment_date end)::timestamp+interval '12 hours') at time zone 'UTC' end,
    estimated_credit_at=case when v_estimate is null then estimated_credit_at else (v_estimate::timestamp+interval '12 hours') at time zone 'UTC' end,
    last_provider_event_id=coalesce(p_source_event_id,last_provider_event_id),
    last_provider_event_at=case when p_source_event_id is null then last_provider_event_at else v_event.event_created_at end,
    last_provider_event_rank=case when p_source_event_id is null then last_provider_event_rank
      when v_event.event_name='PAYMENT_CONFIRMED' then 60 else 80 end,
    raw_payload=v_payload,updated_at=clock_timestamp() where id=v_id;
  update public.asaas_reconciliation_issues set resolved_at=now(),resolution_note='Resolved by corroborated bound payment observation '||v_observation::text
    where provider_entity_id=v_provider and (tenant_id=v_tenant or tenant_id is null) and resolved_at is null
      and (kind in ('PAYMENT_STATUS_MISMATCH','PAYMENT_DUE_DATE_MISMATCH')
        or (kind='WEBHOOK_TRIAGE' and details->>'error' in ('subscription_binding_unresolved',
          'legacy_recurring_student_scope_not_corroborated','legacy_recurring_provider_identity_mismatch','provider_subscription_identity_mismatch')));
  return jsonb_build_object('ok',true,'action','UPDATED','id',v_id,'status',v_status,'previous_status',v_prior_status,
    'due_date',v_due,'observation_id',v_observation);
end $fn$;
create or replace function private.guard_bound_payment_observation_order()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if old.last_authoritative_observed_at is not null
    and new.last_authoritative_observed_at is not distinct from old.last_authoritative_observed_at
    and new.last_provider_event_at<=old.last_authoritative_observed_at
    and (new.raw_payload is distinct from old.raw_payload
      or new.last_provider_event_id is distinct from old.last_provider_event_id
      or new.last_provider_event_at is distinct from old.last_provider_event_at
      or new.last_provider_event_rank is distinct from old.last_provider_event_rank)
    and upper(coalesce(new.status,'')) in ('PENDING','OVERDUE','CONFIRMED','RECEIVED','RECEIVED_IN_CASH')
    and upper(coalesce(new.raw_payload->>'event','')) in ('PAYMENT_CONFIRMED','PAYMENT_OVERDUE','PAYMENT_CREATED',
      'PAYMENT_UPDATED','PAYMENT_RECEIVED','PAYMENT_RECEIVED_IN_CASH')
    and coalesce(new.refunded_amount,0)<=coalesce(old.refunded_amount,0)
  then return old; end if;
  return new;
end $fn$;
alter function private.guard_bound_payment_observation_order() owner to postgres;
revoke all on function private.guard_bound_payment_observation_order() from public,anon,authenticated,service_role;
drop trigger if exists guard_bound_payment_observation_order on public.student_payments;
create trigger guard_bound_payment_observation_order before update of raw_payload,last_provider_event_id,last_provider_event_at,last_provider_event_rank
  on public.student_payments
  for each row execute function private.guard_bound_payment_observation_order();
alter function private.bound_payment_reference_matches(text,uuid,text,boolean) owner to postgres;
revoke all on function private.bound_payment_reference_matches(text,uuid,text,boolean) from public,anon,authenticated,service_role;
alter function public.apply_authoritative_bound_student_payment(jsonb,uuid,bigint,text,jsonb,jsonb,timestamptz,text) owner to postgres;
revoke all on function public.apply_authoritative_bound_student_payment(jsonb,uuid,bigint,text,jsonb,jsonb,timestamptz,text) from public,anon,authenticated;
grant execute on function public.apply_authoritative_bound_student_payment(jsonb,uuid,bigint,text,jsonb,jsonb,timestamptz,text) to service_role;
notify pgrst,'reload schema';
