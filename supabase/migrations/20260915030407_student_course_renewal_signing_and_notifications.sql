-- Signed, auditable renewal offers and exactly-once WhatsApp reminders.
-- A signature authorizes the agreed renewal, but provider billing remains a
-- separately observable state. HTTP acceptance is not called delivery.

create table if not exists private.student_course_renewal_offers (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null unique references private.student_course_renewal_proposals(id) on delete restrict,
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  token text not null unique check(length(token)=64 and token~'^[a-f0-9]+$'),
  contract_start date not null,
  first_due_date date not null,
  last_due_date date not null,
  service_end_date date not null,
  previous_service_end_date date,
  term_months smallint not null check(term_months=6),
  monthly_fee_cents bigint not null check(monthly_fee_cents>0),
  classes_per_week smallint not null check(classes_per_week between 1 and 7),
  billing_strategy text not null check(billing_strategy in ('CREATE_NEW','REUSE_EXISTING')),
  provider_customer_id text not null check(length(btrim(provider_customer_id)) between 1 and 200),
  provider_subscription_id text,
  billing_type text not null check(billing_type in ('PIX','BOLETO','CREDIT_CARD')),
  status text not null default 'PENDING_SIGNATURE' check(status in ('PENDING_SIGNATURE','SIGNED','CANCELLED')),
  billing_status text not null default 'NOT_AUTHORIZED' check(billing_status in ('NOT_AUTHORIZED','PENDING','PROCESSING','SYNCED','FAILED','REVIEW')),
  typed_signature text,
  signature_ip text,
  signed_at timestamptz,
  billing_synced_at timestamptz,
  billing_error text,
  billing_claim_token uuid,
  billing_lease_expires_at timestamptz,
  provider_created_subscription_id text,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check(first_due_date>=contract_start),
  check(last_due_date=public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(first_due_date)))))),
  check(service_end_date=public.fim_do_servico(last_due_date)),
  check((billing_strategy='CREATE_NEW' and provider_subscription_id is null) or
        (billing_strategy='REUSE_EXISTING' and nullif(btrim(provider_subscription_id),'') is not null))
);
create index if not exists student_course_renewal_offers_due_idx
  on private.student_course_renewal_offers(tenant_id,contract_start,status);
alter table private.student_course_renewal_offers owner to postgres;
alter table private.student_course_renewal_offers enable row level security;
revoke all on private.student_course_renewal_offers from public,anon,authenticated,service_role;

create table if not exists public.student_course_renewal_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references private.student_course_renewal_offers(id) on delete restrict,
  tenant_id text not null,
  student_id uuid not null,
  milestone text not null check(milestone in ('INITIAL','D15','D0')),
  scheduled_at timestamptz not null,
  status text not null default 'PENDING' check(status in ('PENDING','CLAIMED','SUBMITTING','ACCEPTED','DELIVERED','READ','FAILED','UNKNOWN','SUPPRESSED')),
  claim_token uuid,
  lease_expires_at timestamptz,
  submit_attempt_count smallint not null default 0 check(submit_attempt_count between 0 and 1),
  provider_instance_name text,
  provider_destination text,
  provider_message_id text,
  provider_http_status integer,
  accepted_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(offer_id,milestone)
);
create index if not exists student_course_renewal_notification_pending_idx
  on public.student_course_renewal_notification_outbox(scheduled_at,id) where status='PENDING';
create unique index if not exists student_course_renewal_notification_receipt_idx
  on public.student_course_renewal_notification_outbox(tenant_id,lower(provider_instance_name),provider_message_id)
  where provider_message_id is not null;
alter table public.student_course_renewal_notification_outbox owner to postgres;
alter table public.student_course_renewal_notification_outbox enable row level security;
revoke all on public.student_course_renewal_notification_outbox from public,anon,authenticated,service_role;

create table if not exists private.student_course_renewal_events(
  id bigint generated always as identity primary key, tenant_id text not null,
  offer_id uuid not null, event_type text not null, payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.student_course_renewal_events owner to postgres;
alter table private.student_course_renewal_events enable row level security;
revoke all on private.student_course_renewal_events from public,anon,authenticated,service_role;
drop trigger if exists student_course_renewal_events_immutable on private.student_course_renewal_events;
create trigger student_course_renewal_events_immutable before update or delete or truncate
  on private.student_course_renewal_events for each statement execute function private.guard_prepayment_audit_immutable();

create or replace function private.issue_student_course_renewal_offer(
  p_proposal uuid,p_contract_start date,p_previous_service_end date,p_strategy text,
  p_customer text,p_subscription text,p_billing_type text,p_expires_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r private.student_course_renewal_proposals%rowtype; o private.student_course_renewal_offers%rowtype; v_token text;
begin
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-issue:'||p_proposal::text,0));
  select * into r from private.student_course_renewal_proposals where id=p_proposal for share;
  if not found or r.status<>'DRAFT' or r.signature_status<>'NOT_REQUESTED' or r.billing_status<>'NOT_AUTHORIZED'
    or p_contract_start is null or p_strategy not in ('CREATE_NEW','REUSE_EXISTING')
    or p_billing_type not in ('PIX','BOLETO','CREDIT_CARD') or nullif(btrim(p_customer),'') is null
    or (p_strategy='CREATE_NEW' and nullif(btrim(coalesce(p_subscription,'')),'') is not null)
    or (p_strategy='REUSE_EXISTING' and nullif(btrim(coalesce(p_subscription,'')),'') is null)
    or not private.tenant_is_operational(r.tenant_id) then raise exception 'renewal_offer_invalid'; end if;
  select * into o from private.student_course_renewal_offers where proposal_id=p_proposal;
  if found then return jsonb_build_object('id',o.id,'token',o.token,'already',true); end if;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into private.student_course_renewal_offers(proposal_id,tenant_id,student_id,token,contract_start,
    first_due_date,last_due_date,service_end_date,previous_service_end_date,term_months,monthly_fee_cents,
    classes_per_week,billing_strategy,provider_customer_id,provider_subscription_id,billing_type,expires_at)
  values(r.id,r.tenant_id,r.student_id,v_token,p_contract_start,p_contract_start,
    (p_contract_start+interval '5 months')::date,(p_contract_start+interval '6 months')::date,
    p_previous_service_end,r.term_months,r.monthly_fee_cents,r.classes_per_week,p_strategy,btrim(p_customer),
    nullif(btrim(coalesce(p_subscription,'')),''),p_billing_type,coalesce(p_expires_at,p_contract_start+interval '30 days')) returning * into o;
  insert into private.student_course_renewal_events(tenant_id,offer_id,event_type,payload)
    values(o.tenant_id,o.id,'ISSUED',jsonb_build_object('contract_start',o.contract_start,'last_due_date',o.last_due_date,
      'service_end_date',o.service_end_date,'strategy',o.billing_strategy,'proposal_id',o.proposal_id));
  return jsonb_build_object('id',o.id,'token',o.token,'already',false);
end $fn$;

create or replace function public.get_student_course_renewal_public(p_token text)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare o private.student_course_renewal_offers%rowtype; r private.student_course_renewal_proposals%rowtype; p public.profiles%rowtype; v_school text;
begin
  if p_token is null or p_token!~'^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'error','Link inválido.'); end if;
  select * into o from private.student_course_renewal_offers where token=p_token;
  if not found then return jsonb_build_object('ok',false,'error','Link inválido.'); end if;
  select * into r from private.student_course_renewal_proposals where id=o.proposal_id;
  select * into p from public.profiles where id=o.student_id and tenant_id=o.tenant_id;
  select coalesce(nullif(btrim(name),''),'Wise Wolf') into v_school from public.tenants where id=o.tenant_id;
  if p.id is null or r.id is null or r.monthly_fee_cents<>o.monthly_fee_cents or r.classes_per_week<>o.classes_per_week
    or r.term_months<>o.term_months or o.status='CANCELLED' then return jsonb_build_object('ok',false,'error','Esta proposta não está disponível.'); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('student_name',p.full_name,'school_name',v_school,
    'term_months',o.term_months,'monthly_fee_cents',o.monthly_fee_cents,'classes_per_week',o.classes_per_week,
    'contract_start',o.contract_start,'first_due_date',o.first_due_date,'last_due_date',o.last_due_date,
    'service_end_date',o.service_end_date,'status',o.status,'billing_status',o.billing_status,
    'signed_at',o.signed_at,'expired',(o.expires_at<clock_timestamp() and o.status='PENDING_SIGNATURE')));
end $fn$;

create or replace function public.sign_student_course_renewal(p_token text,p_typed_signature text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o private.student_course_renewal_offers%rowtype; p public.profiles%rowtype; v_ip text;
begin
  if p_token is null or p_token!~'^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'error','Link inválido.'); end if;
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-sign:'||p_token,0));
  select * into o from private.student_course_renewal_offers where token=p_token for update;
  if not found then return jsonb_build_object('ok',false,'error','Link inválido.'); end if;
  if o.status='SIGNED' then return jsonb_build_object('ok',true,'already',true,'billing_status',o.billing_status); end if;
  if o.status<>'PENDING_SIGNATURE' or o.expires_at<clock_timestamp() then return jsonb_build_object('ok',false,'error','Esta proposta expirou. Fale com a escola.'); end if;
  select * into p from public.profiles where id=o.student_id and tenant_id=o.tenant_id for share;
  if p.id is null or public.normalize_signature_name(p_typed_signature) is distinct from public.normalize_signature_name(p.full_name)
    or nullif(btrim(p_typed_signature),'') is null then return jsonb_build_object('ok',false,'error','Digite exatamente o nome completo do aluno.'); end if;
  v_ip:=coalesce(nullif(btrim(split_part(current_setting('request.headers',true)::json->>'x-forwarded-for',',',1)),''),'Via Web (Digital)');
  update private.student_course_renewal_offers set status='SIGNED',billing_status='PENDING',typed_signature=btrim(p_typed_signature),
    signature_ip=v_ip,signed_at=clock_timestamp() where id=o.id;
  update public.student_course_renewal_notification_outbox set status='SUPPRESSED',last_error='renewal_signed',updated_at=clock_timestamp()
    where offer_id=o.id and submit_attempt_count=0 and status in ('PENDING','CLAIMED');
  insert into private.student_course_renewal_events(tenant_id,offer_id,event_type,payload)
    values(o.tenant_id,o.id,'SIGNED',jsonb_build_object('signed_at',clock_timestamp(),'signature_ip',v_ip));
  return jsonb_build_object('ok',true,'already',false,'billing_status','PENDING');
end $fn$;

create or replace function public.claim_student_course_renewal_billing(p_limit integer default 10)
returns table(id uuid,claim_token uuid) language plpgsql security definer set search_path='' as $fn$
declare v_id uuid; v_claim uuid;
begin
  for v_id in select o.id from private.student_course_renewal_offers o where o.status='SIGNED' and o.billing_status='PENDING'
    order by o.signed_at,o.id for update skip locked limit greatest(1,least(coalesce(p_limit,10),25)) loop
    perform pg_advisory_xact_lock(hashtextextended('student-billing-lifecycle:'||(select tenant_id from private.student_course_renewal_offers where id=v_id)||':'||(select student_id from private.student_course_renewal_offers where id=v_id)::text,0));
    v_claim:=gen_random_uuid();
    update private.student_course_renewal_offers set billing_status='PROCESSING',billing_claim_token=v_claim,
      billing_lease_expires_at=clock_timestamp()+interval '30 minutes',billing_error=null where private.student_course_renewal_offers.id=v_id;
    insert into private.student_course_renewal_events(tenant_id,offer_id,event_type,payload)
      select tenant_id,id,'BILLING_CLAIMED',jsonb_build_object('strategy',billing_strategy) from private.student_course_renewal_offers where id=v_id;
    id:=v_id; claim_token:=v_claim; return next;
  end loop;
end $fn$;

create or replace function public.student_course_renewal_billing_source(p_id uuid,p_claim uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare o private.student_course_renewal_offers%rowtype; p public.profiles%rowtype; r private.student_course_renewal_proposals%rowtype;
begin
  select * into o from private.student_course_renewal_offers where id=p_id;
  select * into p from public.profiles where id=o.student_id and tenant_id=o.tenant_id;
  select * into r from private.student_course_renewal_proposals where id=o.proposal_id;
  if o.id is null or p.id is null or o.status<>'SIGNED' or o.billing_status<>'PROCESSING' or o.billing_claim_token is distinct from p_claim
    or o.billing_lease_expires_at<clock_timestamp() or nullif(btrim(p.asaas_customer_id),'') is distinct from o.provider_customer_id
    or coalesce(p.is_test_account,false) or p.test_fixture_key is not null or not private.tenant_is_operational(o.tenant_id)
    then return null; end if;
  return jsonb_build_object('id',o.id,'tenant_id',o.tenant_id,'student_id',o.student_id,'strategy',o.billing_strategy,
    'customer_id',o.provider_customer_id,'subscription_id',o.provider_subscription_id,'billing_type',o.billing_type,
    'source_subscription_id',nullif(btrim(coalesce(r.source_snapshot->>'subscription_id','')),''),
    'monthly_fee_cents',o.monthly_fee_cents,'first_due_date',o.first_due_date,'last_due_date',o.last_due_date,
    'service_end_date',o.service_end_date,'external_reference','renewal:'||o.id::text||':subscription');
end $fn$;

create or replace function public.finish_student_course_renewal_billing(p_id uuid,p_claim uuid,p_status text,
  p_provider_subscription text default null,p_error text default null)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare o private.student_course_renewal_offers%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-billing:'||p_id::text,0));
  select * into o from private.student_course_renewal_offers where id=p_id for update;
  if not found or o.billing_status<>'PROCESSING' or o.billing_claim_token is distinct from p_claim
    or p_status not in('SYNCED','FAILED','REVIEW') then return jsonb_build_object('ok',false); end if;
  if p_status='SYNCED' and nullif(btrim(coalesce(p_provider_subscription,'')),'') is null then return jsonb_build_object('ok',false); end if;
  update private.student_course_renewal_offers set billing_status=p_status,
    provider_created_subscription_id=case when p_status='SYNCED' then btrim(p_provider_subscription) else provider_created_subscription_id end,
    billing_synced_at=case when p_status='SYNCED' then clock_timestamp() else billing_synced_at end,
    billing_error=case when p_status='SYNCED' then null else left(coalesce(p_error,'provider_operation_failed'),500) end,
    billing_claim_token=null,billing_lease_expires_at=null where id=p_id;
  if p_status='SYNCED' then
    update public.profiles set subscription_id=btrim(p_provider_subscription),asaas_subscription_status='ACTIVE',
      asaas_subscription_end_date=o.last_due_date,asaas_subscription_synced_at=clock_timestamp() where id=o.student_id and tenant_id=o.tenant_id;
  end if;
  insert into private.student_course_renewal_events(tenant_id,offer_id,event_type,payload)
    values(o.tenant_id,o.id,'BILLING_'||p_status,jsonb_build_object('provider_subscription_id',case when p_status='SYNCED' then btrim(p_provider_subscription) end,'error',case when p_status<>'SYNCED' then left(coalesce(p_error,''),200) end));
  return jsonb_build_object('ok',true,'status',p_status);
end $fn$;

create or replace function private.materialize_student_course_renewal_reminders(p_now timestamptz) returns void
language plpgsql security definer set search_path='' as $fn$
begin
  insert into public.student_course_renewal_notification_outbox(offer_id,tenant_id,student_id,milestone,scheduled_at)
  select o.id,o.tenant_id,o.student_id,m.milestone,
    ((o.contract_start-m.days_before)::text||' 06:00 America/Sao_Paulo')::timestamptz
  from private.student_course_renewal_offers o cross join (values('D15',15),('D0',0)) m(milestone,days_before)
  where o.status='PENDING_SIGNATURE' and o.expires_at>=p_now
    and not (m.milestone='D0' and exists(select 1 from public.student_course_renewal_notification_outbox i
      where i.offer_id=o.id and i.milestone='INITIAL'
        and (i.scheduled_at at time zone 'America/Sao_Paulo')::date=o.contract_start))
  on conflict(offer_id,milestone) do nothing;
  update public.student_course_renewal_notification_outbox set status='PENDING',claim_token=null,lease_expires_at=null,
    last_error='lease_expired',updated_at=p_now where status='CLAIMED' and submit_attempt_count=0 and lease_expires_at<p_now;
  update public.student_course_renewal_notification_outbox set status='UNKNOWN',last_error='provider_result_unknown',updated_at=p_now
    where status='SUBMITTING' and lease_expires_at<p_now;
end $fn$;

create or replace function public.student_course_renewal_notifications_pending(p_limit integer default 25)
returns table(id uuid,tenant_id text) language plpgsql security definer set search_path='' as $fn$
declare v_now timestamptz:=clock_timestamp();
begin
  perform private.materialize_student_course_renewal_reminders(v_now);
  if (v_now at time zone 'America/Sao_Paulo')::time<time '06:00' or (v_now at time zone 'America/Sao_Paulo')::time>=time '18:00' then return; end if;
  return query select n.id,n.tenant_id from public.student_course_renewal_notification_outbox n
    join private.student_course_renewal_offers o on o.id=n.offer_id
    where n.status='PENDING' and n.submit_attempt_count=0 and n.scheduled_at<=v_now and o.status='PENDING_SIGNATURE'
    order by n.scheduled_at,n.id limit greatest(1,least(coalesce(p_limit,25),100));
end $fn$;

create or replace function public.claim_student_course_renewal_notification(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $fn$
declare n public.student_course_renewal_notification_outbox%rowtype; v_now timestamptz:=clock_timestamp();
begin
  select * into n from public.student_course_renewal_notification_outbox where id=p_id for update;
  if not found or n.status<>'PENDING' or n.submit_attempt_count<>0 or n.scheduled_at>v_now then return jsonb_build_object('ok',false); end if;
  update public.student_course_renewal_notification_outbox set status='CLAIMED',claim_token=gen_random_uuid(),lease_expires_at=v_now+interval '5 minutes',updated_at=v_now
    where id=p_id returning * into n;
  return jsonb_build_object('ok',true,'id',n.id,'tenant_id',n.tenant_id,'claim_token',n.claim_token);
end $fn$;

create or replace function public.student_course_renewal_notification_source(p_id uuid,p_claim uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $fn$
declare n public.student_course_renewal_notification_outbox%rowtype; o private.student_course_renewal_offers%rowtype; p public.profiles%rowtype; v_phone text; v_name text;
begin
  select * into n from public.student_course_renewal_notification_outbox where id=p_id;
  select * into o from private.student_course_renewal_offers where id=n.offer_id;
  select * into p from public.profiles where id=n.student_id and tenant_id=n.tenant_id;
  if n.id is null or o.id is null or p.id is null or n.status<>'CLAIMED' or n.claim_token is distinct from p_claim
    or n.submit_attempt_count<>0 or n.lease_expires_at<clock_timestamp() or o.status<>'PENDING_SIGNATURE'
    or coalesce(p.is_test_account,false) or p.test_fixture_key is not null or not public.is_student_notifiable(p.id)
    or not exists(select 1 from public.tenants t where t.id=o.tenant_id and t.whatsapp_enabled and private.tenant_is_operational(t.id)) then return null; end if;
  if p.guardian_id is not null or nullif(btrim(p.guardian_cpf),'') is not null then v_phone:=p.guardian_phone; v_name:=p.guardian_name;
  else v_phone:=p.phone; v_name:=p.full_name; end if;
  v_phone:=regexp_replace(coalesce(v_phone,''),'[^0-9]','','g'); if length(v_phone) in(10,11) then v_phone:='55'||v_phone; end if;
  if v_phone!~'^[1-9][0-9]{11,14}$' or nullif(btrim(v_name),'') is null then return null; end if;
  return jsonb_build_object('id',n.id,'offer_id',o.id,'tenant_id',o.tenant_id,'student_id',o.student_id,'milestone',n.milestone,
    'token',o.token,'recipient_phone',v_phone,'recipient_name',btrim(v_name),'student_name',p.full_name,
    'term_months',o.term_months,'monthly_fee_cents',o.monthly_fee_cents,'classes_per_week',o.classes_per_week,
    'contract_start',o.contract_start,'service_end_date',o.service_end_date);
end $fn$;

create or replace function public.prepare_student_course_renewal_notification(p_id uuid,p_claim uuid,p_instance text,p_destination text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare n public.student_course_renewal_notification_outbox%rowtype; s jsonb;
begin
  select * into n from public.student_course_renewal_notification_outbox where id=p_id for update;
  s:=public.student_course_renewal_notification_source(p_id,p_claim);
  if n.id is null or s is null or p_destination is distinct from s->>'recipient_phone' or nullif(btrim(p_instance),'') is null then return jsonb_build_object('ok',false); end if;
  update public.student_course_renewal_notification_outbox set status='SUBMITTING',submit_attempt_count=1,
    provider_instance_name=btrim(p_instance),provider_destination=p_destination,lease_expires_at=clock_timestamp()+interval '30 minutes',updated_at=clock_timestamp() where id=p_id;
  return jsonb_build_object('ok',true);
end $fn$;

create or replace function public.finish_student_course_renewal_notification(p_id uuid,p_claim uuid,p_outcome text,p_message_id text,p_http integer)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare n public.student_course_renewal_notification_outbox%rowtype;
begin
  select * into n from public.student_course_renewal_notification_outbox where id=p_id for update;
  if not found or n.claim_token is distinct from p_claim or n.status<>'SUBMITTING' or n.submit_attempt_count<>1 or p_outcome not in('accepted','rejected','ambiguous') then return jsonb_build_object('ok',false); end if;
  update public.student_course_renewal_notification_outbox set status=case when p_outcome='accepted' and nullif(btrim(coalesce(p_message_id,'')),'') is not null then 'ACCEPTED'
    when p_outcome='rejected' then 'FAILED' else 'UNKNOWN' end,provider_message_id=nullif(btrim(coalesce(p_message_id,'')),''),provider_http_status=p_http,
    accepted_at=case when p_outcome='accepted' then clock_timestamp() end,last_error=case when p_outcome='rejected' then 'provider_rejected' when p_outcome='ambiguous' then 'provider_outcome_ambiguous' else null end,
    lease_expires_at=null,updated_at=clock_timestamp() where id=p_id returning * into n;
  insert into private.student_course_renewal_events(tenant_id,offer_id,event_type,payload) select n.tenant_id,n.offer_id,'WHATSAPP_'||n.status,
    jsonb_build_object('milestone',n.milestone,'message_id',n.provider_message_id,'http_status',n.provider_http_status);
  return jsonb_build_object('ok',true,'status',n.status);
end $fn$;

create or replace function private.apply_student_course_renewal_receipt() returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  update public.student_course_renewal_notification_outbox set status=case when new.delivery_status='read' then 'READ' when new.delivery_status='delivered' then 'DELIVERED'
    when new.delivery_status='failed' then 'FAILED' else status end,delivered_at=least(delivered_at,new.delivered_at),read_at=least(read_at,new.read_at),updated_at=clock_timestamp()
  where tenant_id=new.tenant_id and lower(provider_instance_name)=lower(new.provider_instance_name) and provider_message_id=new.provider_message_id;
  return new;
end $fn$;
drop trigger if exists student_course_renewal_delivery_receipt on private.whatsapp_provider_delivery_receipts;
create trigger student_course_renewal_delivery_receipt after insert or update of delivery_status,delivered_at,read_at
  on private.whatsapp_provider_delivery_receipts for each row execute function private.apply_student_course_renewal_receipt();

create or replace function public.trigger_student_course_renewal_notifications() returns bigint language plpgsql security definer set search_path='' as $fn$
declare v_key text; v_request bigint;
begin
  if not exists(select 1 from public.student_course_renewal_notifications_pending(1)) then return 0; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name='wisewolf_service_role_key' limit 1;
  if nullif(v_key,'') is null then return -1; end if;
  select net.http_post(url:='http://kong:8000/functions/v1/student-renewal-notify',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),
    body:='{"sweep":true}'::jsonb,timeout_milliseconds:=120000) into v_request; return v_request;
end $fn$;

create or replace function public.trigger_student_course_renewal_billing() returns bigint language plpgsql security definer set search_path='' as $fn$
declare v_key text; v_request bigint;
begin
  if not exists(select 1 from private.student_course_renewal_offers where status='SIGNED' and billing_status='PENDING') then return 0; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name='wisewolf_service_role_key' limit 1;
  if nullif(v_key,'') is null then return -1; end if;
  select net.http_post(url:='http://kong:8000/functions/v1/student-renewal-billing',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),
    body:='{"sweep":true}'::jsonb,timeout_milliseconds:=120000) into v_request; return v_request;
end $fn$;

do $permissions$ declare f regprocedure; n text; begin
  for f,n in select p.oid::regprocedure,s.nspname from pg_proc p join pg_namespace s on s.oid=p.pronamespace where p.proname like '%student_course_renewal%'
  loop execute format('alter function %s owner to postgres',f); execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
    if n='public' then execute format('grant execute on function %s to service_role',f); end if; end loop;
  grant execute on function public.get_student_course_renewal_public(text) to anon,authenticated;
  grant execute on function public.sign_student_course_renewal(text,text) to anon,authenticated;
  grant execute on function public.list_student_course_renewal_proposals(text) to authenticated;
end $permissions$;
do $cron$ begin if exists(select 1 from pg_extension where extname='pg_cron') then
  perform cron.schedule('wisewolf-student-renewal-notify','* * * * *','select public.trigger_student_course_renewal_notifications();');
  perform cron.schedule('wisewolf-student-renewal-billing','* * * * *','select public.trigger_student_course_renewal_billing();'); end if; end $cron$;
