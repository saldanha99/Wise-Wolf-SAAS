-- Opt-in monthly reserves (installments 2..N) and prior-month reconciliation.
-- No settings are seeded. The versioned cron is inert until a director opts in.
-- Provider acceptance is NOT delivery. Ambiguous submissions are never retried.

create table if not exists public.monthly_reserve_notification_settings (
  tenant_id text primary key references public.tenants(id) on delete restrict,
  enabled boolean not null default false,
  starts_on date not null,
  enabled_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint monthly_reserve_starts_first check (extract(day from starts_on) = 1)
);

create table if not exists public.management_reserve_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  notification_kind text not null check (notification_kind in ('INSTALLMENT_SPLIT','CAIXINHA_CLOSE')),
  allocation_id uuid references public.student_payment_allocations(id) on delete restrict,
  period_start date not null check (extract(day from period_start) = 1),
  subject_key text not null,
  status text not null default 'PENDING' check (status in (
    'PENDING','CLAIMED','PREPARED','SUBMITTING','SENT','UNKNOWN','FAILED','SUPPRESSED')),
  claim_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  submit_attempt_count integer not null default 0 check (submit_attempt_count between 0 and 1),
  source_snapshot jsonb,
  message_body text,
  source_frozen_at timestamptz,
  provider_instance_name text,
  provider_destination text,
  provider_integration_id uuid,
  provider_integration_version bigint,
  provider_endpoint_hash text,
  provider_credential_hash text,
  provider_message_id text,
  provider_delivery_status text,
  provider_http_status integer,
  accepted_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  submitted_at timestamptz,
  reconciliation_required boolean not null default false,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reserve_notification_subject check (
    (notification_kind='INSTALLMENT_SPLIT' and allocation_id is not null and subject_key=allocation_id::text)
    or (notification_kind='CAIXINHA_CLOSE' and allocation_id is null and subject_key=period_start::text)),
  unique(tenant_id,notification_kind,subject_key)
);
alter table public.management_reserve_notification_outbox
  add column if not exists next_attempt_at timestamptz not null default now();
create index if not exists reserve_notification_pending_idx
  on public.management_reserve_notification_outbox(status,created_at)
  where status in ('PENDING','CLAIMED','PREPARED','SUBMITTING');
create index if not exists reserve_notification_due_idx
  on public.management_reserve_notification_outbox(next_attempt_at,created_at) where status='PENDING';
create index if not exists reserve_notification_allocation_idx
  on public.management_reserve_notification_outbox(allocation_id) where allocation_id is not null;
create unique index if not exists reserve_notification_provider_idx
  on public.management_reserve_notification_outbox(tenant_id,provider_instance_name,provider_message_id)
  where provider_message_id is not null;

create table if not exists private.monthly_reserve_notification_events (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  outbox_id uuid,
  event_type text not null,
  actor_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.monthly_reserve_notification_settings owner to postgres;
alter table public.management_reserve_notification_outbox owner to postgres;
alter table private.monthly_reserve_notification_events owner to postgres;
drop trigger if exists monthly_reserve_events_immutable on private.monthly_reserve_notification_events;
create trigger monthly_reserve_events_immutable before update or delete or truncate
  on private.monthly_reserve_notification_events for each statement
  execute function private.guard_prepayment_audit_immutable();
alter table public.monthly_reserve_notification_settings enable row level security;
alter table public.management_reserve_notification_outbox enable row level security;
alter table private.monthly_reserve_notification_events enable row level security;
revoke all on public.monthly_reserve_notification_settings,public.management_reserve_notification_outbox
  from public,anon,authenticated,service_role;
grant select on public.monthly_reserve_notification_settings,public.management_reserve_notification_outbox
  to authenticated;
revoke all on private.monthly_reserve_notification_events from public,anon,authenticated,service_role;
drop policy if exists monthly_reserve_settings_read on public.monthly_reserve_notification_settings;
create policy monthly_reserve_settings_read on public.monthly_reserve_notification_settings
  for select to authenticated using (private.prepayment_caller_can_read(tenant_id));
drop policy if exists reserve_notification_read on public.management_reserve_notification_outbox;
create policy reserve_notification_read on public.management_reserve_notification_outbox
  for select to authenticated using (private.prepayment_caller_can_read(tenant_id));

create or replace function public.configure_monthly_reserve_notifications(
  p_tenant_id text,p_enabled boolean,p_starts_on date default null
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_local timestamp := now() at time zone 'America/Sao_Paulo';
  v_min date;
  v_start date;
  v_settings public.monthly_reserve_notification_settings%rowtype;
begin
  if auth.uid() is null or not private.prepayment_caller_can_read(p_tenant_id)
     or not (public.is_super_admin() or exists (
       select 1 from public.tenant_memberships m where m.user_id=auth.uid()
         and m.tenant_id=p_tenant_id and m.role='SCHOOL_ADMIN' and m.status='ACTIVE'
     )) then return jsonb_build_object('ok',false,'error','sem_permissao'); end if;
  if p_enabled is null then return jsonb_build_object('ok',false,'error','enabled_obrigatorio'); end if;
  v_min := date_trunc('month',v_local)::date;
  if extract(day from v_local)<>1 or v_local::time>=time '09:00' then
    v_min := (v_min+interval '1 month')::date;
  end if;
  v_start := coalesce(p_starts_on,v_min);
  if p_enabled and (v_start<v_min or extract(day from v_start)<>1) then
    return jsonb_build_object('ok',false,'error','inicio_deve_ser_competencia_futura','minimum_starts_on',v_min);
  end if;
  insert into public.monthly_reserve_notification_settings as s
    (tenant_id,enabled,starts_on,enabled_at,updated_by)
  values(p_tenant_id,p_enabled,v_start,case when p_enabled then now() end,auth.uid())
  on conflict(tenant_id) do update set enabled=excluded.enabled,
    starts_on=case when excluded.enabled then excluded.starts_on else s.starts_on end,
    enabled_at=case when excluded.enabled then now() else s.enabled_at end,
    updated_at=now(),updated_by=auth.uid()
  returning * into v_settings;
  insert into private.monthly_reserve_notification_events(tenant_id,event_type,actor_id,payload)
    values(p_tenant_id,'SETTINGS_CHANGED',auth.uid(),to_jsonb(v_settings));
  return jsonb_build_object('ok',true,'settings',to_jsonb(v_settings));
end $fn$;

-- Current dispatch month only, after maturity at 09:00 São Paulo on day one.
-- Seven-day catch-up handles outages without sending a backlog of old months.
create or replace function private.monthly_reserve_dispatch_month(p_now timestamptz)
returns date language sql immutable set search_path='' as $fn$
  select case when extract(day from p_now at time zone 'America/Sao_Paulo') between 1 and 7
    and p_now at time zone 'America/Sao_Paulo' >=
      date_trunc('month',p_now at time zone 'America/Sao_Paulo')+interval '9 hours'
    then date_trunc('month',p_now at time zone 'America/Sao_Paulo')::date end
$fn$;

create or replace function private.materialize_monthly_reserve_notifications(p_now timestamptz)
returns void language plpgsql security definer set search_path='' as $fn$
declare v_month date := private.monthly_reserve_dispatch_month(p_now);
begin
  -- A crashed process may reclaim only BEFORE its irreversible submission.
  update public.management_reserve_notification_outbox set status='PENDING',claim_token=null,
    lease_expires_at=null,last_error='pre_submission_lease_expired',updated_at=now()
    where status in ('CLAIMED','PREPARED') and submit_attempt_count=0 and lease_expires_at<p_now;
  update public.management_reserve_notification_outbox set status='UNKNOWN',
    last_error='provider_result_or_receipt_missing',updated_at=now()
    where status='SUBMITTING' and lease_expires_at<p_now;
  if v_month is null then return; end if;
  insert into public.management_reserve_notification_outbox
    (tenant_id,notification_kind,allocation_id,period_start,subject_key)
  select a.tenant_id,'INSTALLMENT_SPLIT',a.id,a.competencia,a.id::text
  from public.student_payment_allocations a
  join public.monthly_reserve_notification_settings s on s.tenant_id=a.tenant_id
  join public.tenants t on t.id=a.tenant_id
  where s.enabled and s.starts_on<=v_month and a.competencia=v_month
    and a.modo='MENSAL' and a.sequencia>1
    and private.prepayment_allocation_is_valid(a.id)
    and not private.management_payment_is_test_fixture(a.tenant_id,a.payment_id)
    and t.whatsapp_enabled and lower(coalesce(t.saas_status,'')) in ('active','trial','trialing')
    and a.created_at < (v_month::timestamp+interval '9 hours') at time zone 'America/Sao_Paulo'
    and not exists (
      select 1 from public.management_reserve_notification_outbox previous
      join public.student_payment_allocations prior on prior.id=previous.allocation_id
      where prior.payment_id=a.payment_id and prior.competencia=a.competencia
        and previous.tenant_id=a.tenant_id and previous.submit_attempt_count=1)
  on conflict do nothing;
  insert into public.management_reserve_notification_outbox
    (tenant_id,notification_kind,period_start,subject_key)
  select s.tenant_id,'CAIXINHA_CLOSE',(v_month-interval '1 month')::date,
    ((v_month-interval '1 month')::date)::text
  from public.monthly_reserve_notification_settings s join public.tenants t on t.id=s.tenant_id
  where s.enabled and s.starts_on<=v_month and t.whatsapp_enabled
    and lower(coalesce(t.saas_status,'')) in ('active','trial','trialing')
  on conflict do nothing;
end $fn$;

create or replace function public.monthly_reserve_notification_pending(p_limit integer default 25)
returns table(id uuid,tenant_id text,notification_kind text) language plpgsql security definer set search_path='' as $fn$
begin
  perform private.materialize_monthly_reserve_notifications(now());
  return query select o.id,o.tenant_id,o.notification_kind
    from public.management_reserve_notification_outbox o
    join public.monthly_reserve_notification_settings s on s.tenant_id=o.tenant_id
    where o.status='PENDING' and o.next_attempt_at<=now() and s.enabled
      and case when o.notification_kind='INSTALLMENT_SPLIT' then o.period_start
        else (o.period_start+interval '1 month')::date end = private.monthly_reserve_dispatch_month(now())
    order by o.notification_kind desc,o.created_at,o.id limit greatest(1,least(coalesce(p_limit,25),100));
end $fn$;

create or replace function private.monthly_reserve_notification_source_at(p_id uuid,p_now timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare v_o public.management_reserve_notification_outbox%rowtype; v_source jsonb; v_dispatch date;
begin
  select * into v_o from public.management_reserve_notification_outbox where id=p_id;
  if not found then return null; end if;
  v_dispatch := case when v_o.notification_kind='INSTALLMENT_SPLIT' then v_o.period_start
    else (v_o.period_start+interval '1 month')::date end;
  if private.monthly_reserve_dispatch_month(p_now) is distinct from v_dispatch or not exists (
    select 1 from public.monthly_reserve_notification_settings s join public.tenants t on t.id=s.tenant_id
    join public.dre_report_settings d on d.tenant_id=s.tenant_id
    where s.tenant_id=v_o.tenant_id and s.enabled and s.starts_on<=v_dispatch
      and t.whatsapp_enabled and lower(coalesce(t.saas_status,'')) in ('active','trial','trialing')
      and d.is_active and d.destino ~ '^[0-9]{10,25}@g[.]us$'
  ) then return null; end if;
  if v_o.notification_kind='INSTALLMENT_SPLIT' then
    if not exists (select 1 from public.student_payment_allocations a
      where a.id=v_o.allocation_id and a.tenant_id=v_o.tenant_id and a.competencia=v_o.period_start
        and a.modo='MENSAL' and a.sequencia>1 and private.prepayment_allocation_is_valid(a.id)
        and not exists(select 1 from private.prepayment_financial_recompute_queue q
          where q.tenant_id=a.tenant_id and q.student_id=a.student_id and q.processed_version<q.version)
        and not private.management_payment_is_test_fixture(a.tenant_id,a.payment_id)
        and not exists(select 1 from public.management_reserve_notification_outbox previous
          join public.student_payment_allocations prior on prior.id=previous.allocation_id
          where previous.id<>p_id and previous.tenant_id=a.tenant_id and prior.payment_id=a.payment_id
            and prior.competencia=a.competencia and previous.submit_attempt_count=1)) then return null; end if;
    v_source := private.payment_split_installment_unchecked(v_o.allocation_id);
  else
    if exists(select 1 from private.prepayment_financial_recompute_queue q
      where q.tenant_id=v_o.tenant_id and q.processed_version<q.version) then return null; end if;
    v_source := public.caixinha_fechamento(to_char(v_o.period_start,'YYYY-MM'),v_o.tenant_id)-'gerado_em';
  end if;
  if v_source is null or v_source ? 'error' then return null; end if;
  return v_source;
end $fn$;

create or replace function public.monthly_reserve_notification_source(p_id uuid)
returns jsonb language sql stable security definer set search_path='' as $fn$
  select private.monthly_reserve_notification_source_at(p_id,now())
$fn$;

create or replace function public.claim_monthly_reserve_notification(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_o public.management_reserve_notification_outbox%rowtype;
begin
  select * into v_o from public.management_reserve_notification_outbox where id=p_id for update;
  if not found or v_o.status<>'PENDING' or v_o.submit_attempt_count<>0 or v_o.next_attempt_at>now() then
    return jsonb_build_object('ok',false,'reason','not_pending'); end if;
  if public.monthly_reserve_notification_source(p_id) is null then
    update public.management_reserve_notification_outbox set last_error='source_or_scope_unavailable',
      next_attempt_at=now()+interval '5 minutes',updated_at=now() where id=p_id;
    return jsonb_build_object('ok',false,'reason','source_or_scope_unavailable');
  end if;
  update public.management_reserve_notification_outbox set status='CLAIMED',claim_token=gen_random_uuid(),
    lease_expires_at=now()+interval '5 minutes',updated_at=now() where id=p_id returning * into v_o;
  return jsonb_build_object('ok',true,'id',v_o.id,'tenant_id',v_o.tenant_id,
    'notification_kind',v_o.notification_kind,'claim_token',v_o.claim_token);
end $fn$;

create or replace function public.prepare_monthly_reserve_notification(
  p_id uuid,p_claim_token uuid,p_source_snapshot jsonb,p_message_body text,
  p_instance_name text,p_destination text,p_integration_id uuid,p_integration_version bigint
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_o public.management_reserve_notification_outbox%rowtype;
begin
  select * into v_o from public.management_reserve_notification_outbox where id=p_id for update;
  if not found or v_o.status<>'CLAIMED' or v_o.claim_token is distinct from p_claim_token
    or v_o.lease_expires_at<now() or char_length(p_message_body) not between 1 and 8000
    or p_message_body is null or p_destination !~ '^[0-9]{10,25}@g[.]us$'
    or p_destination is null or p_instance_name is null or p_integration_id is null
    or p_integration_version is null or p_integration_version<1
    or p_source_snapshot is null or public.monthly_reserve_notification_source(p_id) is distinct from p_source_snapshot
    or not exists(select 1 from public.dre_report_settings d where d.tenant_id=v_o.tenant_id and d.is_active and d.destino=p_destination)
  then return jsonb_build_object('ok',false,'reason','preparation_changed_or_invalid'); end if;
  update public.management_reserve_notification_outbox set status='PREPARED',source_snapshot=p_source_snapshot,
    message_body=p_message_body,source_frozen_at=now(),provider_instance_name=lower(btrim(p_instance_name)),
    provider_destination=p_destination,provider_integration_id=p_integration_id,
    provider_integration_version=p_integration_version,updated_at=now() where id=p_id;
  return jsonb_build_object('ok',true);
end $fn$;

-- Last mutable read before a SINGLE provider POST. Payment -> allocation ->
-- outbox lock order matches cancellation/refund. No external truth is blocked.
create or replace function public.authorize_monthly_reserve_notification(
  p_id uuid,p_claim_token uuid,p_integration_id uuid,p_integration_version bigint,
  p_provider_endpoint_hash text,p_provider_credential_hash text
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_o public.management_reserve_notification_outbox%rowtype;
  v_a public.student_payment_allocations%rowtype;
  v_i public.whatsapp_instances%rowtype;
  v_c private.tenant_integration_connections%rowtype;
  v_destination text; v_secret text; v_endpoint text; v_credential text;
begin
  select * into v_o from public.management_reserve_notification_outbox where id=p_id;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('monthly-reserve:'||p_id::text,0));
  if v_o.allocation_id is not null then
    select * into v_a from public.student_payment_allocations where id=v_o.allocation_id;
    perform 1 from public.student_payments where id=v_a.payment_id for update;
    perform 1 from public.student_payment_allocations where id=v_o.allocation_id for update;
  end if;
  select * into v_o from public.management_reserve_notification_outbox where id=p_id for update;
  if v_o.status<>'PREPARED' or v_o.claim_token is distinct from p_claim_token
    or v_o.lease_expires_at<now() or v_o.submit_attempt_count<>0 then
    return jsonb_build_object('ok',false,'reason','not_prepared'); end if;
  perform 1 from public.monthly_reserve_notification_settings where tenant_id=v_o.tenant_id and enabled for share;
  select d.destino into v_destination from public.dre_report_settings d
    where d.tenant_id=v_o.tenant_id and d.is_active for share;
  select i.* into v_i from public.whatsapp_instances i
    where i.tenant_id=v_o.tenant_id and lower(i.instance_name)=v_o.provider_instance_name
      and lower(btrim(coalesce(i.status,''))) in ('connected','open') and i.inbox_enabled
      and i.webhook_auth_version=3 and i.integration_id=p_integration_id
      and i.integration_version=p_integration_version for share;
  select c.* into v_c from private.tenant_integration_connections c
    where c.id=p_integration_id and c.id=v_o.provider_integration_id and c.tenant_id=v_o.tenant_id
      and c.version=p_integration_version and c.version=v_o.provider_integration_version
      and c.provider='evolution' and c.status='healthy' and c.mode<>'DISABLED' for share;
  perform 1 from public.tenant_memberships m where m.tenant_id=v_o.tenant_id
    and m.user_id=v_i.user_id and m.role='SCHOOL_ADMIN' and m.status='ACTIVE' for share;
  if not found or v_i.id is null or v_c.id is null
    or v_destination is distinct from v_o.provider_destination
    or p_provider_endpoint_hash !~ '^[a-f0-9]{64}$' or p_provider_endpoint_hash is null
    or p_provider_credential_hash !~ '^[a-f0-9]{64}$' or p_provider_credential_hash is null then
    return jsonb_build_object('ok',false,'reason','provider_authority_changed'); end if;
  if v_c.mode='TENANT_BYOK' then
    v_endpoint := encode(extensions.digest(convert_to(regexp_replace(btrim(v_c.connection_config->>'baseUrl'),'/+$','','g'),'UTF8'),'sha256'),'hex');
    select s.decrypted_secret into v_secret from private.tenant_secret_registry r
      join vault.decrypted_secrets s on s.id=r.vault_secret_id where r.tenant_id=v_o.tenant_id
        and r.provider='evolution' and r.status='healthy' and r.last_validated_at is not null for share of r;
    v_credential := encode(extensions.digest(convert_to(btrim(v_secret),'UTF8'),'sha256'),'hex');
    if v_endpoint is distinct from p_provider_endpoint_hash or v_credential is distinct from p_provider_credential_hash then
      return jsonb_build_object('ok',false,'reason','provider_secret_changed'); end if;
  elsif v_c.mode<>'PLATFORM_MANAGED' then return jsonb_build_object('ok',false,'reason','provider_mode_invalid'); end if;
  if public.monthly_reserve_notification_source(p_id) is distinct from v_o.source_snapshot then
    return jsonb_build_object('ok',false,'reason','source_changed'); end if;
  update public.management_reserve_notification_outbox set status='SUBMITTING',submit_attempt_count=1,
    submitted_at=now(),lease_expires_at=now()+interval '30 minutes',updated_at=now(),
    provider_endpoint_hash=p_provider_endpoint_hash,provider_credential_hash=p_provider_credential_hash
    where id=p_id;
  insert into private.monthly_reserve_notification_events(tenant_id,outbox_id,event_type,payload)
    values(v_o.tenant_id,p_id,'SUBMISSION_AUTHORIZED',jsonb_build_object('source_snapshot',v_o.source_snapshot));
  return jsonb_build_object('ok',true,'id',p_id,'destination',v_o.provider_destination,
    'instance_name',v_o.provider_instance_name,'message_body',v_o.message_body);
end $fn$;

create or replace function private.apply_monthly_reserve_receipt(
  p_tenant_id text,p_instance_name text,p_message_id text,p_status text,
  p_accepted_at timestamptz,p_delivered_at timestamptz,p_read_at timestamptz
) returns void language plpgsql security definer set search_path='' as $fn$
begin
  update public.management_reserve_notification_outbox o set
    status=case when p_status in ('delivered','read') then 'SENT' when o.status='SENT' then 'SENT'
      when p_status='failed' then 'FAILED' when p_status='uncertain' then 'UNKNOWN' else o.status end,
    provider_delivery_status=case when o.read_at is not null or p_status='read' then 'read'
      when o.delivered_at is not null or p_status='delivered' then 'delivered' else p_status end,
    accepted_at=least(o.accepted_at,p_accepted_at),delivered_at=least(o.delivered_at,p_delivered_at),
    read_at=least(o.read_at,p_read_at),updated_at=now()
  where o.tenant_id=p_tenant_id and o.provider_instance_name=lower(p_instance_name)
    and o.provider_message_id=p_message_id and o.submit_attempt_count=1
    and o.status in ('SUBMITTING','UNKNOWN','FAILED','SENT');
end $fn$;
create or replace function private.bridge_monthly_reserve_receipt()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  perform private.apply_monthly_reserve_receipt(new.tenant_id,new.provider_instance_name,new.provider_message_id,
    new.delivery_status,new.accepted_at,new.delivered_at,new.read_at);
  return new;
end $fn$;
drop trigger if exists monthly_reserve_delivery_receipt on private.whatsapp_provider_delivery_receipts;
create trigger monthly_reserve_delivery_receipt after insert or update of delivery_status,accepted_at,delivered_at,read_at
  on private.whatsapp_provider_delivery_receipts for each row execute function private.bridge_monthly_reserve_receipt();

create or replace function public.finish_monthly_reserve_notification(
  p_id uuid,p_claim_token uuid,p_outcome text,p_provider_message_id text default null,
  p_http_status integer default null
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v_o public.management_reserve_notification_outbox%rowtype; v_r private.whatsapp_provider_delivery_receipts%rowtype;
begin
  select * into v_o from public.management_reserve_notification_outbox where id=p_id for update;
  if not found or v_o.claim_token is distinct from p_claim_token or v_o.submit_attempt_count<>1
    or v_o.status not in ('SUBMITTING','UNKNOWN','SENT','FAILED') or p_outcome not in ('accepted','rejected','ambiguous') then
    return jsonb_build_object('ok',false,'reason','result_not_applicable'); end if;
  if v_o.provider_message_id is not null or v_o.status in ('SENT','FAILED') then
    return jsonb_build_object('ok',true,'status',v_o.status,'delivery_status',v_o.provider_delivery_status);
  end if;
  if p_provider_message_id is not null and (char_length(p_provider_message_id) not between 1 and 320
    or p_provider_message_id<>btrim(p_provider_message_id) or p_provider_message_id~'[[:cntrl:]]') then
    p_provider_message_id:=null;
  end if;
  update public.management_reserve_notification_outbox set
    status=case when p_outcome='accepted' and p_provider_message_id is not null then 'SUBMITTING'
      when p_outcome='rejected' then 'FAILED' else 'UNKNOWN' end,
    provider_message_id=p_provider_message_id,provider_http_status=p_http_status,
    provider_delivery_status=case when p_outcome='accepted' then 'accepted' when p_outcome='rejected' then 'failed' else 'uncertain' end,
    accepted_at=case when p_outcome='accepted' then now() end,
    last_error=case when p_outcome='ambiguous' then 'provider_outcome_ambiguous'
      when p_outcome='rejected' then 'provider_rejected'
      when p_provider_message_id is null then 'provider_message_id_missing' end,updated_at=now() where id=p_id;
  -- A receipt can arrive before the HTTP response supplied the message id.
  select * into v_r from private.whatsapp_provider_delivery_receipts r where r.tenant_id=v_o.tenant_id
    and r.provider_instance_name=v_o.provider_instance_name and r.provider_message_id=p_provider_message_id;
  if found then perform private.apply_monthly_reserve_receipt(v_r.tenant_id,v_r.provider_instance_name,v_r.provider_message_id,
    v_r.delivery_status,v_r.accepted_at,v_r.delivered_at,v_r.read_at); end if;
  select * into v_o from public.management_reserve_notification_outbox where id=p_id;
  return jsonb_build_object('ok',true,'status',v_o.status,'delivery_status',v_o.provider_delivery_status);
end $fn$;

-- A refund/cancellation is financial truth, never vetoed by notifications.
-- Preserve the delivered snapshot; flag its reconciliation, suppress unsent work.
create or replace function private.flag_monthly_reserve_allocation_change()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if new.status is distinct from old.status then
    update public.management_reserve_notification_outbox set
      status=case when submit_attempt_count=0 then 'SUPPRESSED' else status end,
      reconciliation_required=submit_attempt_count=1,last_error='allocation_'||lower(new.status),updated_at=now()
      where allocation_id=new.id;
    insert into private.monthly_reserve_notification_events(tenant_id,outbox_id,event_type,payload)
      select tenant_id,id,'ALLOCATION_STATE_CHANGED',jsonb_build_object('old',old.status,'new',new.status)
      from public.management_reserve_notification_outbox where allocation_id=new.id;
  end if;
  return new;
end $fn$;
drop trigger if exists monthly_reserve_allocation_change on public.student_payment_allocations;
create trigger monthly_reserve_allocation_change after update of status on public.student_payment_allocations
  for each row execute function private.flag_monthly_reserve_allocation_change();

create or replace function public.trigger_monthly_reserve_notifications()
returns bigint language plpgsql security definer set search_path='' as $fn$
declare v_key text; v_request bigint; v_month date:=private.monthly_reserve_dispatch_month(now());
begin
  -- Access maturity is independent of notification opt-in and must enqueue
  -- BEFORE the early-return decision, otherwise no Edge worker would wake up
  -- for an already-ACKed, previously future external entitlement.
  perform private.enqueue_matured_prepayment_recomputations(clock_timestamp());
  -- Even outside the send window the watchdog resolves crashed submissions;
  -- this does not call the provider or create historical notification targets.
  perform private.materialize_monthly_reserve_notifications(now());
  if not exists(select 1 from private.prepayment_financial_recompute_queue q
      where q.processed_version<q.version and q.next_attempt_at<=clock_timestamp()
        and (q.claim_token is null or q.lease_expires_at<=clock_timestamp()))
    and (v_month is null or not exists(select 1 from public.management_reserve_notification_outbox o
      join public.monthly_reserve_notification_settings s on s.tenant_id=o.tenant_id
      where o.status='PENDING' and o.next_attempt_at<=now() and s.enabled and s.starts_on<=v_month
        and case when o.notification_kind='INSTALLMENT_SPLIT' then o.period_start
          else (o.period_start+interval '1 month')::date end=v_month)) then return 0; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets
    where name='wisewolf_service_role_key' limit 1;
  if nullif(v_key,'') is null then return -1; end if;
  select net.http_post(url:='http://kong:8000/functions/v1/monthly-reserve-notify',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),
    body:='{"sweep":true}'::jsonb,timeout_milliseconds:=120000) into v_request;
  return v_request;
end $fn$;

-- Explicit API grants; worker RPCs are not callable by browser/anonymous users.
do $permissions$
declare v_name text; v_schema text; v_signature regprocedure;
begin
  for v_signature in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname in ('configure_monthly_reserve_notifications',
      'monthly_reserve_notification_pending','monthly_reserve_notification_source','claim_monthly_reserve_notification',
      'prepare_monthly_reserve_notification','authorize_monthly_reserve_notification','finish_monthly_reserve_notification',
      'trigger_monthly_reserve_notifications'))
    or (n.nspname='private' and p.proname in ('monthly_reserve_dispatch_month','materialize_monthly_reserve_notifications','monthly_reserve_notification_source_at',
      'apply_monthly_reserve_receipt','bridge_monthly_reserve_receipt','flag_monthly_reserve_allocation_change'))
  loop
    execute format('alter function %s owner to postgres',v_signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_signature);
    select p.proname,n.nspname into v_name,v_schema from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where p.oid=v_signature;
    if v_name='configure_monthly_reserve_notifications' then
      execute format('grant execute on function %s to authenticated',v_signature);
    elsif v_schema='public' then
      execute format('grant execute on function %s to service_role',v_signature);
    end if;
  end loop;
end $permissions$;
do $cron$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('wisewolf-monthly-reserve-notify','* * * * *',
      'select public.trigger_monthly_reserve_notifications();');
  end if;
end $cron$;
