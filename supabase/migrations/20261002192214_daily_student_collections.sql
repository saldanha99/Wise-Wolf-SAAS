-- Opt-in por escola; o cron diário existente passa a usar os dois canais.
create table if not exists public.daily_payment_collection_settings (
  tenant_id text primary key references public.tenants(id),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.daily_payment_collection_settings owner to postgres;
alter table public.daily_payment_collection_settings enable row level security;
revoke all on public.daily_payment_collection_settings from public,anon,authenticated;
grant select,insert,update on public.daily_payment_collection_settings to service_role;

create table if not exists public.daily_payment_email_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  payment_id uuid not null,
  student_id uuid not null,
  campaign_date date not null,
  recipient_email text not null,
  provider_idempotency_key text not null unique,
  status text not null check(status in ('SUBMITTING','SENT','REJECTED','UNKNOWN')),
  provider_message_id text,
  provider_http_status integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,payment_id,campaign_date)
);
alter table public.daily_payment_email_attempts owner to postgres;
alter table public.daily_payment_email_attempts enable row level security;
revoke all on public.daily_payment_email_attempts from public,anon,authenticated;
grant select,insert,update on public.daily_payment_email_attempts to service_role;
create index if not exists daily_payment_email_attempts_day_idx
  on public.daily_payment_email_attempts(tenant_id,campaign_date,status);

create or replace function private.daily_collection_allowed(p_payment uuid,p_tenant text,p_student uuid)
returns boolean language sql stable security definer set search_path='' as $function$
 select exists(
   select 1 from public.student_payments pay
   join public.profiles p on p.id=pay.student_id and p.tenant_id=pay.tenant_id
   join public.daily_payment_collection_settings s on s.tenant_id=pay.tenant_id and s.enabled
   join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p.tenant_id
     and m.role='STUDENT' and m.status='ACTIVE'
   where pay.id=p_payment and pay.tenant_id=p_tenant and pay.student_id=p_student
     and pay.status in ('PENDING','OVERDUE') and pay.value>0
     and pay.due_date<(now() at time zone 'America/Sao_Paulo')::date
     and pay.exclusion_reason is null and coalesce(pay.refunded_amount,0)=0
     and p.role='STUDENT' and p.status='Ativo' and p.lifecycle_status='active'
     and p.is_test_account is distinct from true and p.contract_accepted
     and nullif(p.asaas_customer_id,'') is not null and nullif(p.subscription_id,'') is not null
     and private.student_payment_provider_block_reason(pay.id) is null
     and not exists(select 1 from auth.users u where u.id=p.id
       and (u.raw_user_meta_data @> '{"test_fixture":true}' or u.raw_user_meta_data @> '{"testMode":true}'))
     and (exists(select 1 from public.bookings b where b.tenant_id=p.tenant_id
       and b.student_id=p.id and b.status='SCHEDULED')
       or exists(select 1 from public.class_logs l where l.tenant_id=p.tenant_id
         and l.student_id=p.id and l.class_date>=(now() at time zone 'America/Sao_Paulo')::date-30))
     and not exists(select 1 from public.student_offboarding_operations o
       where o.tenant_id=p.tenant_id and o.student_id=p.id
       and o.status in ('CLAIMED','PROVIDER_MUTATING','PROVIDER_COMPLETE','UNKNOWN','BLOCKED'))
     and not exists(select 1 from public.student_account_deletion_claims d
       where d.tenant_id=p.tenant_id and d.student_id=p.id
       and d.status in ('CLAIMED','PROVIDER_MUTATING','PROVIDER_COMPLETE','UNKNOWN','BLOCKED'))
 );
$function$;
alter function private.daily_collection_allowed(uuid,text,uuid) owner to postgres;
revoke all on function private.daily_collection_allowed(uuid,text,uuid) from public,anon,authenticated,service_role;

create or replace function private.guard_daily_payment_email()
returns trigger language plpgsql security definer set search_path='' as $function$
declare p public.profiles%rowtype; payer public.profiles%rowtype; v_email text; guardian boolean;
begin
  if new.campaign_date is distinct from (now() at time zone 'America/Sao_Paulo')::date
    or new.status<>'SUBMITTING'
    or not private.daily_collection_allowed(new.payment_id,new.tenant_id,new.student_id) then
    raise exception 'daily_collection_email_blocked' using errcode='P0001';
  end if;
  select * into p from public.profiles where id=new.student_id and tenant_id=new.tenant_id for share;
  guardian:=p.guardian_id is not null or nullif(btrim(p.guardian_cpf),'') is not null;
  if guardian then
    select * into payer from public.profiles where id=p.guardian_id and tenant_id=p.tenant_id for share;
    if not found or payer.is_test_account is true
      or lower(btrim(coalesce(p.guardian_email,''))) is distinct from lower(btrim(coalesce(payer.email,''))) then
      raise exception 'daily_collection_guardian_email_unverified' using errcode='P0001';
    end if;
  else payer:=p; end if;
  v_email:=lower(btrim(coalesce(payer.email,'')));
  if v_email='' or v_email like '%@accounts.invalid'
    or v_email is distinct from lower(btrim(new.recipient_email))
    or not exists(select 1 from auth.users u where u.id=payer.id
      and lower(u.email)=v_email and u.email_confirmed_at is not null) then
    raise exception 'daily_collection_recipient_email_unverified' using errcode='P0001';
  end if;
  return new;
end;
$function$;
alter function private.guard_daily_payment_email() owner to postgres;
revoke all on function private.guard_daily_payment_email() from public,anon,authenticated,service_role;
drop trigger if exists guard_daily_payment_email on public.daily_payment_email_attempts;
create trigger guard_daily_payment_email before insert on public.daily_payment_email_attempts
 for each row execute function private.guard_daily_payment_email();

-- A cerca canônica de WhatsApp mantém sua trava de lifecycle. Esta cerca
-- adicional impede usar o novo nome para contornar fonte, opt-in ou calendário.
create or replace function private.guard_daily_payment_whatsapp()
returns trigger language plpgsql security definer set search_path='' as $function$
declare pay public.student_payments%rowtype;
begin
  if new.notification_kind not like 'PAYMENT_OVERDUE_DAILY_%'
    or new.status<>'SUBMITTING' then return new; end if;
  if tg_op='UPDATE' and old.status='SUBMITTING' then return new; end if;
  select * into pay from public.student_payments where id::text=new.provider_entity_id
    and tenant_id=new.tenant_id and student_id=new.student_id for share;
  if not found or new.notification_kind is distinct from
      'PAYMENT_OVERDUE_DAILY_'||to_char(now() at time zone 'America/Sao_Paulo','YYYYMMDD')
    or not private.daily_collection_allowed(pay.id,new.tenant_id,new.student_id)
    or not exists(select 1 from public.tenants t join public.tenant_admin_settings s on s.tenant_id=t.id
      where t.id=new.tenant_id and t.whatsapp_enabled and s.student_notifications_enabled) then
    raise exception 'daily_collection_whatsapp_blocked' using errcode='P0001';
  end if;
  return new;
end;
$function$;
alter function private.guard_daily_payment_whatsapp() owner to postgres;
revoke all on function private.guard_daily_payment_whatsapp() from public,anon,authenticated,service_role;
drop trigger if exists guard_daily_payment_whatsapp on public.asaas_outbound_message_attempts;
create trigger guard_daily_payment_whatsapp before insert or update of status on public.asaas_outbound_message_attempts
 for each row execute function private.guard_daily_payment_whatsapp();
notify pgrst,'reload schema';
