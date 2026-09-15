-- New, corroborated card failures only. Never seed historical notifications.
-- This queue cannot change a payment, retry a charge, or veto financial truth.
create table if not exists private.student_card_notification_settings (
  singleton boolean primary key default true check(singleton),
  enabled_since timestamptz not null default clock_timestamp()
);
insert into private.student_card_notification_settings(singleton) values(true) on conflict do nothing;

create table if not exists public.student_card_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null,
  payment_id uuid not null references public.student_payments(id) on delete restrict,
  subscription_id text not null,
  competence date not null check(extract(day from competence)=1),
  event_id text not null,
  event_hash text not null,
  event_at timestamptz not null,
  status text not null default 'PENDING' check(status in
    ('PENDING','CLAIMED','PREPARED','SUBMITTING','SENT','UNKNOWN','FAILED','SUPPRESSED')),
  claim_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  submit_attempt_count integer not null default 0 check(submit_attempt_count between 0 and 1),
  source_snapshot jsonb,
  message_body text,
  source_frozen_at timestamptz,
  provider_instance_name text,
  provider_destination text,
  provider_integration_id uuid,
  provider_integration_version bigint,
  provider_endpoint_hash text,
  provider_credential_hash text,
  asaas_integration_id uuid,
  asaas_integration_version bigint,
  asaas_environment text,
  asaas_mode text,
  provider_payment_snapshot jsonb,
  provider_subscription_snapshot jsonb,
  provider_message_id text,
  provider_delivery_status text,
  provider_http_status integer,
  accepted_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  submitted_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,student_id,subscription_id,competence)
);
create index if not exists student_card_notification_due_idx on public.student_card_notification_outbox(next_attempt_at,created_at)
  where status='PENDING';
create index if not exists student_card_notification_student_attempt_idx on public.student_card_notification_outbox(tenant_id,student_id,submitted_at)
  where submit_attempt_count=1;
create unique index if not exists student_card_notification_receipt_idx
  on public.student_card_notification_outbox(tenant_id,lower(provider_instance_name),provider_message_id) where provider_message_id is not null;
create index if not exists student_card_failure_inbox_idx on public.asaas_webhook_inbox(event_created_at,provider_entity_id)
  where event_name in ('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED','PAYMENT_REPROVED_BY_RISK_ANALYSIS');
create table if not exists private.student_card_notification_events (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  outbox_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.student_card_notification_settings owner to postgres;
alter table public.student_card_notification_outbox owner to postgres;
alter table private.student_card_notification_events owner to postgres;
alter table private.student_card_notification_settings enable row level security;
alter table public.student_card_notification_outbox enable row level security;
alter table private.student_card_notification_events enable row level security;
revoke all on private.student_card_notification_settings,public.student_card_notification_outbox,private.student_card_notification_events
  from public,anon,authenticated,service_role;
drop trigger if exists student_card_events_immutable on private.student_card_notification_events;
create trigger student_card_events_immutable before update or delete or truncate on private.student_card_notification_events
  for each statement execute function private.guard_prepayment_audit_immutable();

create or replace function private.student_card_notification_now() returns timestamptz
language sql volatile set search_path='' as $$ select clock_timestamp() $$;
create or replace function private.student_card_send_window(p_now timestamptz) returns boolean
language sql immutable set search_path='' as $$
  select (p_now at time zone 'America/Sao_Paulo')::time>=time '09:00'
    and (p_now at time zone 'America/Sao_Paulo')::time<time '18:00'
$$;

-- Returns only the delivery minimum; no document, card token or raw payload.
create or replace function private.student_card_failure_source(p_payment uuid,p_event text,p_now timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare p public.student_payments%rowtype; s public.profiles%rowtype; e public.asaas_webhook_inbox%rowtype;
  v_phone text; v_name text; v_last4 text; v_cutover timestamptz;
begin
  select * into p from public.student_payments where id=p_payment;
  if not found or coalesce(p.status,'') not in ('PENDING','OVERDUE') or p.billing_type is distinct from 'CREDIT_CARD'
    or not private.payment_is_tuition(p.payment_type,p.description)
    or coalesce(p.provider_status,'PENDING') not in ('PENDING','OVERDUE') or p.value is null or p.value<=0
    or p.due_date is null or p.paid_at is not null or p.credited_at is not null
    or private.bound_payment_has_reversal_evidence(p.id)
    or private.student_payment_provider_block_reason(p.id) is not null
    or private.student_payment_prepayment_state(p.id) is not null
    or private.management_payment_is_test_fixture(p.tenant_id,p.id) then return null; end if;
  select * into s from public.profiles where id=p.student_id and tenant_id=p.tenant_id;
  if not found or nullif(btrim(s.subscription_id),'') is null or nullif(btrim(s.asaas_customer_id),'') is null
    or not private.student_subscription_mutation_scope_valid(p.tenant_id,p.student_id,s.asaas_customer_id,s.subscription_id)
    or coalesce(s.is_test_account,false) or s.test_fixture_key is not null
    or nullif(btrim(p.provider_customer_id),'') is distinct from s.asaas_customer_id
    or not exists(select 1 from public.tenants t where t.id=p.tenant_id and t.whatsapp_enabled
      and private.tenant_is_operational(t.id))
    or not exists(select 1 from public.tenant_admin_settings cfg where cfg.tenant_id=p.tenant_id and cfg.student_notifications_enabled)
    -- The current broker grants Asaas read capability only to this ROOT mode.
    -- Other tenants/modes stay closed until their broker capability exists.
    or not exists(select 1 from private.tenant_integration_connections c where c.tenant_id=p.tenant_id
      and c.tenant_id='school-wise-wolf' and c.provider='asaas' and c.mode='PLATFORM_MANAGED_ROOT'
      and c.status in ('healthy','configured'))
    or exists(select 1 from private.prepayment_financial_recompute_queue q
      where q.tenant_id=p.tenant_id and q.student_id=p.student_id and q.processed_version<q.version)
    or exists(select 1 from public.asaas_subscription_mutation_operations o where o.tenant_id=p.tenant_id
      and o.student_id=p.student_id and o.status in ('CLAIMED','SUBMITTING','UNKNOWN','BLOCKED'))
    then return null; end if;
  select enabled_since into v_cutover from private.student_card_notification_settings where singleton;
  select * into e from public.asaas_webhook_inbox where provider_event_id=p_event;
  if not found or e.event_name not in ('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED','PAYMENT_REPROVED_BY_RISK_ANALYSIS')
    or e.event_created_at is null or e.event_created_at<v_cutover or e.received_at<v_cutover
    or e.event_created_at<p_now-interval '35 days' or e.event_created_at>p_now
    or nullif(e.payload_hash,'') is null or e.provider_entity_id is distinct from p.asaas_payment_id
    or e.payload->>'event' is distinct from e.event_name or e.payload->>'id' is distinct from e.provider_event_id
    or e.payload#>>'{payment,id}' is distinct from p.asaas_payment_id
    or e.payload#>>'{payment,customer}' is distinct from s.asaas_customer_id
    or e.payload#>>'{payment,subscription}' is distinct from s.subscription_id
    or e.payload#>>'{payment,billingType}' is distinct from 'CREDIT_CARD'
    or e.payload#>>'{payment,dueDate}' is distinct from p.due_date::text
    or (e.payload#>>'{payment,value}')::numeric is distinct from p.value
    or coalesce(e.payload#>>'{payment,status}','') not in ('PENDING','OVERDUE')
    or coalesce(e.payload#>>'{payment,deleted}','false')<>'false'
    or (select count(*) from public.student_payments x where e.provider_entity_id in (x.asaas_payment_id,x.asaas_id))<>1
    or (nullif(p.asaas_id,'') is not null and p.asaas_id<>p.asaas_payment_id)
    or (nullif(p.raw_payload#>>'{payment,subscription}','') is not null
      and p.raw_payload#>>'{payment,subscription}'<>s.subscription_id)
    or exists(select 1 from public.asaas_webhook_inbox newer where newer.provider_entity_id=e.provider_entity_id
      and newer.event_name in ('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED','PAYMENT_REPROVED_BY_RISK_ANALYSIS')
      and (newer.event_created_at,newer.received_at,newer.provider_event_id)>(e.event_created_at,e.received_at,e.provider_event_id))
    or exists(select 1 from public.student_billing_method_operations o where o.tenant_id=p.tenant_id
      and o.student_id=p.student_id and o.status='COMPLETED' and o.completed_at>=e.event_created_at)
    then return null; end if;
  if s.guardian_id is not null or nullif(btrim(s.guardian_cpf),'') is not null then
    v_phone:=s.guardian_phone; v_name:=s.guardian_name;
  else v_phone:=s.phone; v_name:=s.full_name; end if;
  v_phone:=regexp_replace(coalesce(v_phone,''),'[^0-9]','','g');
  if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;
  if v_phone !~ '^[1-9][0-9]{11,14}$' or nullif(btrim(v_name),'') is null then return null; end if;
  v_last4:=e.payload#>>'{payment,creditCard,creditCardNumber}';
  if v_last4 !~ '^[0-9]{4}$' then v_last4:=null; end if;
  return jsonb_build_object('tenant_id',p.tenant_id,'student_id',p.student_id,'payment_id',p.id,
    'provider_payment_id',p.asaas_payment_id,'customer_id',s.asaas_customer_id,'subscription_id',s.subscription_id,
    'value',p.value,'due_date',p.due_date,'event_id',e.provider_event_id,'event_hash',e.payload_hash,
    'event_at',e.event_created_at,'billing_type','CREDIT_CARD','recipient_phone',v_phone,
    'recipient_name',btrim(v_name),'student_name',s.full_name,'card_last4',v_last4);
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $fn$;

create or replace function private.materialize_student_card_notifications(p_now timestamptz)
returns void language plpgsql security definer set search_path='' as $fn$
begin
  update public.student_card_notification_outbox set status='PENDING',claim_token=null,lease_expires_at=null,
    last_error='pre_submission_lease_expired',updated_at=p_now
    where status in ('CLAIMED','PREPARED') and submit_attempt_count=0 and lease_expires_at<p_now;
  update public.student_card_notification_outbox set status='UNKNOWN',last_error='provider_result_or_receipt_missing',updated_at=p_now
    where status='SUBMITTING' and lease_expires_at<p_now;
  insert into public.student_card_notification_outbox as o
    (tenant_id,student_id,payment_id,subscription_id,competence,event_id,event_hash,event_at)
  select distinct on (p.tenant_id,p.student_id,src.j->>'subscription_id',date_trunc('month',p.due_date)::date)
    p.tenant_id,p.student_id,p.id,src.j->>'subscription_id',date_trunc('month',p.due_date)::date,
    e.provider_event_id,e.payload_hash,e.event_created_at
  from public.asaas_webhook_inbox e
  join public.student_payments p on p.asaas_payment_id=e.provider_entity_id
  cross join lateral (select private.student_card_failure_source(p.id,e.provider_event_id,p_now) j) src
  where e.event_name in ('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED','PAYMENT_REPROVED_BY_RISK_ANALYSIS')
    and e.event_created_at>=greatest(p_now-interval '35 days',
      (select enabled_since from private.student_card_notification_settings where singleton))
    and src.j is not null
  order by p.tenant_id,p.student_id,src.j->>'subscription_id',date_trunc('month',p.due_date)::date,
    e.event_created_at desc,e.received_at desc,e.provider_event_id desc
  on conflict(tenant_id,student_id,subscription_id,competence) do update
    set event_id=excluded.event_id,event_hash=excluded.event_hash,
      event_at=excluded.event_at,updated_at=p_now
    where o.status='PENDING' and o.submit_attempt_count=0 and o.payment_id=excluded.payment_id
      and excluded.event_at>o.event_at;
end $fn$;

create or replace function public.student_card_notification_pending(p_limit integer default 25)
returns table(id uuid,tenant_id text) language plpgsql security definer set search_path='' as $fn$
declare v_now timestamptz:=private.student_card_notification_now();
begin
  perform private.materialize_student_card_notifications(v_now);
  if not private.student_card_send_window(v_now) then return; end if;
  return query select o.id,o.tenant_id from public.student_card_notification_outbox o
    where o.status='PENDING' and o.next_attempt_at<=v_now
    order by o.created_at,o.id limit greatest(1,least(coalesce(p_limit,25),100));
end $fn$;
create or replace function public.student_card_notification_source(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o public.student_card_notification_outbox%rowtype; v_now timestamptz:=private.student_card_notification_now(); v_source jsonb;
begin
  select * into o from public.student_card_notification_outbox where id=p_id;
  if not found or not private.student_card_send_window(v_now) then return null; end if;
  v_source:=private.student_card_failure_source(o.payment_id,o.event_id,v_now);
  if v_source->>'event_hash' is distinct from o.event_hash or (v_source->>'event_at')::timestamptz is distinct from o.event_at
    or v_source->>'tenant_id' is distinct from o.tenant_id or v_source->>'student_id' is distinct from o.student_id::text
    or v_source->>'subscription_id' is distinct from o.subscription_id then return null; end if;
  return v_source;
end $fn$;

-- Consistent order with lifecycle/provider mutation workers. Never lock an
-- outbox first and then wait for financial/profile authority.
create or replace function private.lock_student_card_notification(p_id uuid)
returns void language plpgsql security definer set search_path='' as $fn$
declare o public.student_card_notification_outbox%rowtype;
begin
  select * into o from public.student_card_notification_outbox where id=p_id;
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('student-billing-lifecycle:'||o.tenant_id||':'||o.student_id::text,0));
  perform 1 from public.profiles where id=o.student_id for share;
  perform 1 from public.student_payments where id=o.payment_id for share;
  perform pg_advisory_xact_lock(hashtextextended('student-payment-allocation:'||o.student_id::text,0));
  perform 1 from public.student_card_notification_outbox where id=p_id for update;
end $fn$;
create or replace function public.claim_student_card_notification(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o public.student_card_notification_outbox%rowtype; v_now timestamptz:=private.student_card_notification_now();
begin
  perform private.lock_student_card_notification(p_id);
  select * into o from public.student_card_notification_outbox where id=p_id;
  if not found or o.status<>'PENDING' or o.submit_attempt_count<>0 or o.next_attempt_at>v_now then
    return jsonb_build_object('ok',false,'reason','not_pending'); end if;
  if public.student_card_notification_source(p_id) is null or exists(select 1 from public.student_card_notification_outbox x
    where x.tenant_id=o.tenant_id and x.student_id=o.student_id and x.submit_attempt_count=1 and x.submitted_at>v_now-interval '24 hours') then
    update public.student_card_notification_outbox set next_attempt_at=v_now+interval '15 minutes',last_error='source_unavailable' where id=p_id;
    return jsonb_build_object('ok',false,'reason','source_unavailable'); end if;
  update public.student_card_notification_outbox set status='CLAIMED',claim_token=gen_random_uuid(),
    lease_expires_at=v_now+interval '5 minutes',updated_at=v_now where id=p_id returning * into o;
  return jsonb_build_object('ok',true,'id',o.id,'tenant_id',o.tenant_id,'claim_token',o.claim_token);
end $fn$;

create or replace function public.prepare_student_card_notification(
  p_id uuid,p_claim_token uuid,p_source_snapshot jsonb,p_message_body text,p_instance_name text,p_destination text,
  p_integration_id uuid,p_integration_version bigint,p_asaas_integration_id uuid,p_asaas_integration_version bigint,
  p_asaas_environment text,p_asaas_mode text
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o public.student_card_notification_outbox%rowtype; v_now timestamptz:=private.student_card_notification_now();
begin
  perform private.lock_student_card_notification(p_id);
  select * into o from public.student_card_notification_outbox where id=p_id;
  if not found or o.status<>'CLAIMED' or o.claim_token is distinct from p_claim_token or o.lease_expires_at<v_now
    or p_source_snapshot is null or public.student_card_notification_source(p_id) is distinct from p_source_snapshot
    or p_message_body is null or length(p_message_body) not between 1 and 8000
    or p_destination is distinct from p_source_snapshot->>'recipient_phone'
    or p_instance_name is null or btrim(p_instance_name)='' or p_integration_id is null or p_integration_version is null
    or p_integration_version<1 or p_asaas_integration_id is null or p_asaas_integration_version is null or p_asaas_integration_version<1
    or p_asaas_environment is distinct from 'platform' or p_asaas_mode is distinct from 'PLATFORM_MANAGED_ROOT'
    then return jsonb_build_object('ok',false,'reason','preparation_changed_or_invalid'); end if;
  update public.student_card_notification_outbox set status='PREPARED',source_snapshot=p_source_snapshot,message_body=p_message_body,
    source_frozen_at=v_now,provider_instance_name=btrim(p_instance_name),provider_destination=p_destination,
    provider_integration_id=p_integration_id,provider_integration_version=p_integration_version,
    asaas_integration_id=p_asaas_integration_id,asaas_integration_version=p_asaas_integration_version,
    asaas_environment=p_asaas_environment,asaas_mode=p_asaas_mode,updated_at=v_now where id=p_id;
  return jsonb_build_object('ok',true);
end $fn$;

create or replace function private.student_card_provider_snapshot(p_value jsonb,p_subscription boolean)
returns jsonb language sql immutable set search_path='' as $fn$
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p_value)
  where key=any(case when p_subscription then array['id','customer','status','billingType','deleted','creditCardLast4']
    else array['id','customer','subscription','status','billingType','value','dueDate','deleted','creditCardLast4'] end)
$fn$;
create or replace function public.authorize_student_card_notification(
  p_id uuid,p_claim_token uuid,p_integration_id uuid,p_integration_version bigint,
  p_provider_endpoint_hash text,p_provider_credential_hash text,p_source_snapshot jsonb,
  p_provider_payment_snapshot jsonb,p_provider_subscription_snapshot jsonb
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o public.student_card_notification_outbox%rowtype; i public.whatsapp_instances%rowtype;
  c private.tenant_integration_connections%rowtype; a private.tenant_integration_connections%rowtype;
  v_now timestamptz; v_secret text; v_endpoint text; v_credential text; q jsonb:=p_provider_payment_snapshot; s jsonb:=p_provider_subscription_snapshot;
begin
  perform private.lock_student_card_notification(p_id);
  v_now:=private.student_card_notification_now();
  select * into o from public.student_card_notification_outbox where id=p_id;
  if not found or o.status<>'PREPARED' or o.claim_token is distinct from p_claim_token or o.submit_attempt_count<>0
    or o.lease_expires_at<v_now or o.source_frozen_at<v_now-interval '5 minutes'
    then return jsonb_build_object('ok',false,'reason','not_prepared'); end if;
  perform 1 from public.tenants where id=o.tenant_id for share;
  perform 1 from public.tenant_admin_settings where tenant_id=o.tenant_id for share;
  perform 1 from public.tenant_memberships where user_id=o.student_id for share;
  select * into i from public.whatsapp_instances where tenant_id=o.tenant_id and lower(instance_name)=lower(o.provider_instance_name)
    and lower(btrim(coalesce(status,''))) in ('connected','open') and inbox_enabled and webhook_auth_version=3
    and integration_id=p_integration_id and integration_version=p_integration_version for share;
  select * into c from private.tenant_integration_connections where id=p_integration_id and id=o.provider_integration_id
    and tenant_id=o.tenant_id and version=p_integration_version and version=o.provider_integration_version
    and provider='evolution' and status='healthy' and mode in ('TENANT_BYOK','PLATFORM_MANAGED') for share;
  select * into a from private.tenant_integration_connections where id=o.asaas_integration_id and tenant_id=o.tenant_id
    and version=o.asaas_integration_version and provider='asaas' and status in ('healthy','configured')
    and mode=o.asaas_mode and mode='PLATFORM_MANAGED_ROOT' and tenant_id='school-wise-wolf' for share;
  perform 1 from public.tenant_memberships m join public.profiles admin on admin.id=m.user_id and admin.tenant_id=m.tenant_id
    where m.tenant_id=o.tenant_id and m.user_id=i.user_id and m.role='SCHOOL_ADMIN' and m.status='ACTIVE'
      and admin.role='SCHOOL_ADMIN' and lower(admin.lifecycle_status)='active' for share of m,admin;
  if not found or i.id is null or c.id is null or a.id is null or o.asaas_environment is distinct from 'platform'
    or p_provider_endpoint_hash is null or p_provider_endpoint_hash !~ '^[a-f0-9]{64}$'
    or p_provider_credential_hash is null or p_provider_credential_hash !~ '^[a-f0-9]{64}$'
    then return jsonb_build_object('ok',false,'reason','provider_authority_changed'); end if;
  if c.mode='TENANT_BYOK' then
    v_endpoint:=encode(extensions.digest(convert_to(regexp_replace(btrim(c.connection_config->>'baseUrl'),'/+$','','g'),'UTF8'),'sha256'),'hex');
    select sec.decrypted_secret into v_secret from private.tenant_secret_registry r join vault.decrypted_secrets sec on sec.id=r.vault_secret_id
      where r.tenant_id=o.tenant_id and r.provider='evolution' and r.status='healthy' and r.last_validated_at is not null for share of r;
    v_credential:=encode(extensions.digest(convert_to(btrim(v_secret),'UTF8'),'sha256'),'hex');
    if v_endpoint is distinct from p_provider_endpoint_hash or v_credential is distinct from p_provider_credential_hash then
      return jsonb_build_object('ok',false,'reason','provider_secret_changed'); end if;
  end if;
  if p_source_snapshot is null or p_source_snapshot is distinct from o.source_snapshot
    or public.student_card_notification_source(p_id) is distinct from o.source_snapshot
    or exists(select 1 from public.student_card_notification_outbox x where x.id<>p_id and x.tenant_id=o.tenant_id
      and x.student_id=o.student_id and x.submit_attempt_count=1 and x.submitted_at>v_now-interval '24 hours')
    then return jsonb_build_object('ok',false,'reason','source_changed'); end if;
  if q is null or s is null or jsonb_typeof(q)<>'object' or jsonb_typeof(s)<>'object'
    or q->>'id' is distinct from o.source_snapshot->>'provider_payment_id'
    or q->>'customer' is distinct from o.source_snapshot->>'customer_id'
    or q->>'subscription' is distinct from o.subscription_id or q->>'billingType' is distinct from 'CREDIT_CARD'
    or q->>'dueDate' is distinct from o.source_snapshot->>'due_date'
    or (q->>'value')::numeric is distinct from (o.source_snapshot->>'value')::numeric
    or coalesce(q->>'status','') not in ('PENDING','OVERDUE') or coalesce(q->>'deleted','false')<>'false'
    or s->>'id' is distinct from o.subscription_id or s->>'customer' is distinct from o.source_snapshot->>'customer_id'
    or s->>'status' is distinct from 'ACTIVE' or s->>'billingType' is distinct from 'CREDIT_CARD'
    or coalesce(s->>'deleted','false')<>'false'
    or (q->>'creditCardLast4' is not null and q->>'creditCardLast4' !~ '^[0-9]{4}$')
    or (s->>'creditCardLast4' is not null and s->>'creditCardLast4' !~ '^[0-9]{4}$')
    or (q->>'creditCardLast4' is not null and s->>'creditCardLast4' is not null
      and q->>'creditCardLast4' is distinct from s->>'creditCardLast4')
    or (o.source_snapshot->>'card_last4' is not null and
      (q->>'creditCardLast4' is distinct from o.source_snapshot->>'card_last4'
        or s->>'creditCardLast4' is distinct from o.source_snapshot->>'card_last4'))
    then return jsonb_build_object('ok',false,'reason','provider_snapshot_changed'); end if;
  update public.student_card_notification_outbox set status='SUBMITTING',submit_attempt_count=1,
    submitted_at=v_now,lease_expires_at=v_now+interval '30 minutes',updated_at=v_now,
    provider_endpoint_hash=p_provider_endpoint_hash,provider_credential_hash=p_provider_credential_hash,
    provider_payment_snapshot=private.student_card_provider_snapshot(q,false),
    provider_subscription_snapshot=private.student_card_provider_snapshot(s,true) where id=p_id;
  return jsonb_build_object('ok',true,'id',p_id,'destination',o.provider_destination,'instance_name',o.provider_instance_name,'message_body',o.message_body);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok',false,'reason','provider_snapshot_invalid');
end $fn$;

create or replace function public.defer_student_card_notification(p_id uuid,p_claim_token uuid,p_reason text,p_suppress boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $fn$
begin
  if p_reason is null or p_reason not in ('source_unavailable','source_changed','identity_mismatch','provider_settled','provider_reversal',
    'provider_deleted','provider_not_eligible','provider_unavailable','integration_changed','route_unavailable','snapshot_changed',
    'prepare_denied','authorization_denied','worker_unavailable') then return jsonb_build_object('ok',false,'reason','invalid_reason'); end if;
  update public.student_card_notification_outbox set status=case when p_suppress then 'SUPPRESSED' else 'PENDING' end,
    claim_token=null,lease_expires_at=null,next_attempt_at=private.student_card_notification_now()+interval '15 minutes',
    last_error=p_reason,updated_at=private.student_card_notification_now()
    where id=p_id and claim_token=p_claim_token and submit_attempt_count=0 and status in ('CLAIMED','PREPARED');
  return jsonb_build_object('ok',found);
end $fn$;

create or replace function private.audit_student_card_notification() returns trigger
language plpgsql security definer set search_path='' as $fn$
begin
  insert into private.student_card_notification_events(tenant_id,outbox_id,event_type,payload)
    values(new.tenant_id,new.id,case when tg_op='INSERT' then 'ENQUEUED' else new.status end,
      jsonb_build_object('event_id',new.event_id,'event_hash',new.event_hash,'attempt',new.submit_attempt_count,
        'delivery_status',new.provider_delivery_status,'provider_message_id',new.provider_message_id,'reason',new.last_error));
  return new;
end $fn$;
drop trigger if exists student_card_notification_audit on public.student_card_notification_outbox;
create trigger student_card_notification_audit after insert or update of status,provider_delivery_status,event_id
  on public.student_card_notification_outbox for each row execute function private.audit_student_card_notification();

-- Reuse the authenticated receipt ledger. HTTP acceptance alone never is SENT.
create or replace function private.apply_student_card_receipt(
  p_tenant_id text,p_instance_name text,p_message_id text,p_status text,
  p_accepted_at timestamptz,p_delivered_at timestamptz,p_read_at timestamptz
) returns void language plpgsql security definer set search_path='' as $fn$
begin
  update public.student_card_notification_outbox o set
    status=case when p_status in ('delivered','read') then 'SENT' when o.status='SENT' then 'SENT'
      when p_status='failed' then 'FAILED' when p_status='uncertain' then 'UNKNOWN' else o.status end,
    provider_delivery_status=case when o.read_at is not null or p_status='read' then 'read'
      when o.delivered_at is not null or p_status='delivered' then 'delivered' else p_status end,
    accepted_at=least(o.accepted_at,p_accepted_at),delivered_at=least(o.delivered_at,p_delivered_at),
    read_at=least(o.read_at,p_read_at),updated_at=private.student_card_notification_now()
  where o.tenant_id=p_tenant_id and lower(o.provider_instance_name)=lower(p_instance_name)
    and o.provider_message_id=p_message_id and o.submit_attempt_count=1 and o.status in ('SUBMITTING','UNKNOWN','FAILED','SENT');
end $fn$;
create or replace function private.bridge_student_card_receipt() returns trigger
language plpgsql security definer set search_path='' as $fn$
begin
  perform private.apply_student_card_receipt(new.tenant_id,new.provider_instance_name,new.provider_message_id,
    new.delivery_status,new.accepted_at,new.delivered_at,new.read_at); return new;
end $fn$;
drop trigger if exists student_card_delivery_receipt on private.whatsapp_provider_delivery_receipts;
create trigger student_card_delivery_receipt after insert or update of delivery_status,accepted_at,delivered_at,read_at
  on private.whatsapp_provider_delivery_receipts for each row execute function private.bridge_student_card_receipt();

create or replace function public.finish_student_card_notification(
  p_id uuid,p_claim_token uuid,p_outcome text,p_provider_message_id text default null,p_http_status integer default null
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o public.student_card_notification_outbox%rowtype; r private.whatsapp_provider_delivery_receipts%rowtype;
begin
  select * into o from public.student_card_notification_outbox where id=p_id for update;
  if not found or o.claim_token is distinct from p_claim_token or o.submit_attempt_count<>1
    or o.status not in ('SUBMITTING','UNKNOWN','SENT','FAILED') or p_outcome is null or p_outcome not in ('accepted','rejected','ambiguous') then
    return jsonb_build_object('ok',false,'reason','result_not_applicable'); end if;
  if o.provider_message_id is not null or o.status in ('SENT','FAILED') then
    return jsonb_build_object('ok',true,'status',o.status,'delivery_status',o.provider_delivery_status); end if;
  if p_provider_message_id is not null and (length(p_provider_message_id) not between 1 and 320
    or p_provider_message_id<>btrim(p_provider_message_id) or p_provider_message_id~'[[:cntrl:]]') then p_provider_message_id:=null; end if;
  update public.student_card_notification_outbox set
    status=case when p_outcome='accepted' and p_provider_message_id is not null then 'SUBMITTING'
      when p_outcome='rejected' then 'FAILED' else 'UNKNOWN' end,
    provider_message_id=p_provider_message_id,provider_http_status=p_http_status,
    provider_delivery_status=case when p_outcome='accepted' then 'accepted' when p_outcome='rejected' then 'failed' else 'uncertain' end,
    accepted_at=case when p_outcome='accepted' then private.student_card_notification_now() end,
    last_error=case when p_outcome='ambiguous' then 'provider_outcome_ambiguous' when p_outcome='rejected' then 'provider_rejected'
      when p_provider_message_id is null then 'provider_message_id_missing' end,updated_at=private.student_card_notification_now() where id=p_id;
  select * into r from private.whatsapp_provider_delivery_receipts where tenant_id=o.tenant_id
    and lower(provider_instance_name)=lower(o.provider_instance_name) and provider_message_id=p_provider_message_id;
  if found then perform private.apply_student_card_receipt(r.tenant_id,r.provider_instance_name,r.provider_message_id,
    r.delivery_status,r.accepted_at,r.delivered_at,r.read_at); end if;
  select * into o from public.student_card_notification_outbox where id=p_id;
  return jsonb_build_object('ok',true,'status',o.status,'delivery_status',o.provider_delivery_status);
end $fn$;

create or replace function public.trigger_student_card_notifications() returns bigint
language plpgsql security definer set search_path='' as $fn$
declare v_key text; v_request bigint;
begin
  if not exists(select 1 from public.student_card_notification_pending(1)) then return 0; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name='wisewolf_service_role_key' limit 1;
  if nullif(v_key,'') is null then return -1; end if;
  select net.http_post(url:='http://kong:8000/functions/v1/student-card-notify',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),
    body:='{"sweep":true}'::jsonb,timeout_milliseconds:=120000) into v_request;
  return v_request;
end $fn$;
do $permissions$
declare f regprocedure; n text;
begin
  for f,n in select p.oid::regprocedure,s.nspname from pg_proc p join pg_namespace s on s.oid=p.pronamespace
    where s.nspname in ('public','private') and (p.proname like '%student_card_notification%'
      or p.proname in ('student_card_send_window','student_card_failure_source','student_card_provider_snapshot','apply_student_card_receipt','bridge_student_card_receipt'))
  loop
    execute format('alter function %s owner to postgres',f);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
    if n='public' then execute format('grant execute on function %s to service_role',f); end if;
  end loop;
end $permissions$;
do $cron$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('wisewolf-student-card-notify','*/5 * * * *','select public.trigger_student_card_notifications();');
  end if;
end $cron$;
