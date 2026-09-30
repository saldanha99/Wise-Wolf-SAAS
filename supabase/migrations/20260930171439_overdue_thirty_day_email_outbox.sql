-- One durable attempt per invoice and 30-day milestone. A network timeout
-- stays UNKNOWN for reconciliation; it never causes an automatic second POST.
create table if not exists public.payment_overdue_email_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  payment_id uuid not null,
  student_id uuid not null,
  milestone integer not null check (milestone = 30),
  due_date date not null,
  recipient_email text not null,
  provider_idempotency_key text not null,
  status text not null default 'SUBMITTING'
    check (status in ('SUBMITTING', 'SENT', 'REJECTED', 'UNKNOWN')),
  provider_message_id text,
  provider_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, payment_id, milestone),
  unique (provider_idempotency_key)
);

alter table public.payment_overdue_email_attempts owner to postgres;
alter table public.payment_overdue_email_attempts enable row level security;
revoke all on public.payment_overdue_email_attempts from public, anon, authenticated;
grant select, insert, update on public.payment_overdue_email_attempts to service_role;

create index if not exists payment_overdue_email_attempts_status_idx
  on public.payment_overdue_email_attempts (status, created_at);

-- The legacy outbound guard knows only the 3/10/20-day names. Fence the new
-- name at the same irreversible SUBMITTING transition, even if another caller
-- bypasses the edge function's earlier eligibility checks.
create or replace function private.guard_thirty_day_payment_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.notification_kind <> 'PAYMENT_OVERDUE_30'
     or new.status <> 'SUBMITTING'
     or old.status = 'SUBMITTING' then
    return new;
  end if;
  if not exists (
    select 1
      from public.student_payments as payment
      join public.profiles as profile
        on profile.id = payment.student_id
       and profile.tenant_id = payment.tenant_id
      join public.tenant_memberships as membership
        on membership.user_id = profile.id
       and membership.tenant_id = profile.tenant_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
      join public.tenants as tenant on tenant.id = payment.tenant_id
      left join public.tenant_admin_settings as settings
        on settings.tenant_id = tenant.id
     where payment.id::text = new.provider_entity_id
       and payment.tenant_id = new.tenant_id
       and payment.student_id = new.student_id
       and payment.status = 'OVERDUE'
       and payment.provider_status = 'OVERDUE'
       and payment.due_date <= (current_date - 30)
       and payment.due_date >= (current_date - 45)
       and payment.exclusion_reason is null
       and coalesce(payment.refunded_amount, 0) = 0
       and profile.role = 'STUDENT'
       and profile.status = 'Ativo'
       and profile.lifecycle_status = 'active'
       and profile.contract_accepted is true
       and profile.subscription_id = payment.authoritative_subscription_id
       and profile.is_test_account is distinct from true
       and coalesce(tenant.whatsapp_enabled, false)
       and coalesce(settings.student_notifications_enabled, false)
  ) then
    raise exception 'thirty_day_payment_notification_blocked'
      using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

alter function private.guard_thirty_day_payment_message() owner to postgres;
revoke all on function private.guard_thirty_day_payment_message()
  from public, anon, authenticated;
drop trigger if exists guard_thirty_day_payment_message
  on public.asaas_outbound_message_attempts;
create trigger guard_thirty_day_payment_message
before update of status on public.asaas_outbound_message_attempts
for each row execute function private.guard_thirty_day_payment_message();
