-- Avisos de cobrança da própria escola no lugar das notificações pagas do Asaas.
--
-- 19/11/2026: a escola desligou todas as notificações do Asaas ao cliente
-- (e-mail/SMS cobrados). O sistema passa a enviar, por WhatsApp (instância
-- central) e e-mail (Resend):
--   PAYMENT_CREATED_WHATSAPP            nova cobrança (uma por fatura)
--   PAYMENT_UPDATED_WHATSAPP_YYYYMMDD   vencimento alterado (uma por data)
--   PAYMENT_DUE_REMINDER_D10_YYYYMMDD   10 dias antes do vencimento
--   PAYMENT_DUE_REMINDER_D0_YYYYMMDD    no dia do vencimento
-- e e-mails com intenção durável em payment_notification_email_attempts.
-- A data no nome é o VENCIMENTO: vencimento novo gera aviso novo; o mesmo
-- vencimento nunca gera dois. PAYMENT_CONFIRMED_WHATSAPP não muda.
--
-- Esta migration só (1) redefine a cerca canônica do WhatsApp com os novos
-- nomes e (2) cria a tabela de e-mails com sua cerca de inserção.
-- Re-executável.

-- 1) Cerca canônica: cópia da definição vigente
--    (20260825194716_fence_student_lifecycle_mutations.sql) + novos avisos.
--    Os novos exigem fatura local PENDING, sem bloqueio do último estado do
--    Asaas, sem exclusão/estorno, aluno fora de fixture, data do nome igual ao
--    vencimento local e, para D-10/D0, o calendário de Brasília.
create or replace function public.mark_asaas_outbound_message_submitting(
  p_attempt_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_outbound_message_attempts%rowtype;
  lifecycle_blocked boolean;
  payment_notification_invalid boolean := false;
  communication_disabled boolean := false;
  source_payment_status text;
  -- Avisos que substituem o Asaas (19/11/2026).
  payment_notice_kind boolean := false;
  source_payment public.student_payments%rowtype;
  school_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  -- Read immutable scope first, then take the advisory lock, then lock/re-read
  -- the row. This keeps lock ordering aligned with begin_* and avoids a
  -- row-lock/advisory-lock deadlock.
  select message_attempt.* into attempt_row
    from public.asaas_outbound_message_attempts as message_attempt
   where message_attempt.id = p_attempt_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || attempt_row.tenant_id || ':' || attempt_row.student_id::text,
      0
    )
  );

  select message_attempt.* into attempt_row
    from public.asaas_outbound_message_attempts as message_attempt
   where message_attempt.id = p_attempt_id
   for update;
  if not found or attempt_row.status <> 'CLAIMED'
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.lease_expires_at <= now()
     or attempt_row.submit_attempt_count <> 0
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  lifecycle_blocked := not exists (
    select 1 from public.profiles as profile
     where profile.id = attempt_row.student_id
       and profile.tenant_id = attempt_row.tenant_id
       and profile.role = 'STUDENT'
       and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
  ) or (
    select count(*) from public.tenant_memberships as membership
     where membership.user_id = attempt_row.student_id
  ) <> 1 or not exists (
    select 1 from public.tenant_memberships as membership
     where membership.user_id = attempt_row.student_id
       and membership.tenant_id = attempt_row.tenant_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) or exists (
    select 1 from public.student_offboarding_operations as operation
     where operation.tenant_id = attempt_row.tenant_id
       and operation.student_id = attempt_row.student_id
       and operation.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  ) or exists (
    select 1 from public.student_account_deletion_claims as deletion
     where deletion.tenant_id = attempt_row.tenant_id
       and deletion.student_id = attempt_row.student_id
       and deletion.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  );

  payment_notice_kind :=
    attempt_row.notification_kind = 'PAYMENT_CREATED_WHATSAPP'
    or attempt_row.notification_kind ~ '^PAYMENT_UPDATED_WHATSAPP_[0-9]{8}$'
    or attempt_row.notification_kind ~ '^PAYMENT_DUE_REMINDER_D(10|0)_[0-9]{8}$';

  if attempt_row.notification_kind in (
    'PAYMENT_CONFIRMED_CAPI', 'PAYMENT_CONFIRMED_WHATSAPP',
    'PAYMENT_DUE_REMINDER', 'PAYMENT_OVERDUE_3',
    'PAYMENT_OVERDUE_10', 'PAYMENT_OVERDUE_20'
  ) then
    select upper(pg_catalog.btrim(coalesce(payment.status, '')))
      into source_payment_status
      from public.student_payments as payment
     where payment.id::text = attempt_row.provider_entity_id
       and payment.tenant_id = attempt_row.tenant_id
       and payment.student_id = attempt_row.student_id
     for update;
    payment_notification_invalid := not found
      or case
        when attempt_row.notification_kind in (
          'PAYMENT_CONFIRMED_CAPI', 'PAYMENT_CONFIRMED_WHATSAPP'
        ) then source_payment_status not in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
        when attempt_row.notification_kind = 'PAYMENT_DUE_REMINDER'
          then source_payment_status <> 'PENDING'
        else source_payment_status not in ('PENDING', 'OVERDUE')
      end;
  end if;

  if payment_notice_kind then
    select payment.* into source_payment
      from public.student_payments as payment
     where payment.id::text = attempt_row.provider_entity_id
       and payment.tenant_id = attempt_row.tenant_id
       and payment.student_id = attempt_row.student_id
     for update;
    payment_notification_invalid := not found
      or upper(pg_catalog.btrim(coalesce(source_payment.status, ''))) <> 'PENDING'
      or source_payment.due_date is null
      or source_payment.due_date < school_today
      or coalesce(source_payment.value, 0) <= 0
      or source_payment.exclusion_reason is not null
      or coalesce(source_payment.refunded_amount, 0) <> 0
      or private.student_payment_provider_block_reason(source_payment.id) is not null
      or exists (
        select 1 from public.profiles as profile
         where profile.id = attempt_row.student_id
           and profile.is_test_account is true
      )
      or (
        attempt_row.notification_kind ~ '_[0-9]{8}$'
        and pg_catalog.to_char(source_payment.due_date, 'YYYYMMDD')
          <> pg_catalog.right(attempt_row.notification_kind, 8)
      )
      or (
        attempt_row.notification_kind like 'PAYMENT_DUE_REMINDER_D10_%'
        and source_payment.due_date <> school_today + 10
      )
      or (
        attempt_row.notification_kind like 'PAYMENT_DUE_REMINDER_D0_%'
        and source_payment.due_date <> school_today
      );
    -- Qualquer NULL inesperado falha fechado.
    payment_notification_invalid := coalesce(payment_notification_invalid, true);
  end if;

  if attempt_row.notification_kind in (
    'MANUAL_PIX_CREATED', 'PAYMENT_CONFIRMED_WHATSAPP',
    'PAYMENT_DUE_REMINDER', 'PAYMENT_OVERDUE_3',
    'PAYMENT_OVERDUE_10', 'PAYMENT_OVERDUE_20'
  ) or payment_notice_kind then
    communication_disabled := true;
    select not (
      coalesce(tenant.whatsapp_enabled, false)
      and coalesce(settings.student_notifications_enabled, false)
    )
      into communication_disabled
      from public.tenants as tenant
      left join public.tenant_admin_settings as settings
        on settings.tenant_id = tenant.id
     where tenant.id = attempt_row.tenant_id;
  end if;

  if lifecycle_blocked or payment_notification_invalid
     or communication_disabled
  then
    update public.asaas_outbound_message_attempts
       set status = 'SUPPRESSED',
           lease_expires_at = now(),
           last_error = case
             when lifecycle_blocked then 'student_lifecycle_inactive_before_send'
             when payment_notification_invalid
               then 'payment_state_changed_before_notification_send'
             else 'student_notifications_disabled_before_send'
           end,
           updated_at = now()
     where id = attempt_row.id
       and status = 'CLAIMED'
       and submit_attempt_count = 0;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'SUPPRESSED',
      'status', 'SUPPRESSED', 'reason', case
        when lifecycle_blocked then 'student_lifecycle_inactive'
        when payment_notification_invalid
          then 'payment_state_changed_before_notification_send'
        else 'student_notifications_disabled_before_send'
      end
    );
  end if;

  update public.asaas_outbound_message_attempts
     set status = 'SUBMITTING', submit_attempt_count = 1,
         lease_expires_at = now() + interval '10 minutes', updated_at = now()
   where id = attempt_row.id;
  return pg_catalog.jsonb_build_object('ok', true, 'status', 'SUBMITTING');
end;
$function$;

alter function public.mark_asaas_outbound_message_submitting(uuid, uuid) owner to postgres;
revoke all on function public.mark_asaas_outbound_message_submitting(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_asaas_outbound_message_submitting(uuid, uuid) to service_role;

-- 2) E-mails dos avisos: uma intenção por escola/fatura/tipo/data de referência
--    (vencimento). Timeout fica UNKNOWN e nunca gera um segundo POST.
create table if not exists public.payment_notification_email_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  payment_id uuid not null,
  student_id uuid not null,
  kind text not null check (kind in (
    'PAYMENT_CREATED_EMAIL', 'PAYMENT_UPDATED_EMAIL',
    'PAYMENT_DUE_REMINDER_D10_EMAIL', 'PAYMENT_DUE_REMINDER_D0_EMAIL',
    'PAYMENT_RECEIVED_EMAIL'
  )),
  ref_date date not null,
  recipient_email text not null,
  provider_idempotency_key text not null unique,
  status text not null default 'SUBMITTING'
    check (status in ('SUBMITTING', 'SENT', 'REJECTED', 'UNKNOWN')),
  provider_message_id text,
  provider_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, payment_id, kind, ref_date)
);
alter table public.payment_notification_email_attempts owner to postgres;
alter table public.payment_notification_email_attempts enable row level security;
revoke all on public.payment_notification_email_attempts from public, anon, authenticated;
grant select, insert, update on public.payment_notification_email_attempts to service_role;
create index if not exists payment_notification_email_attempts_status_idx
  on public.payment_notification_email_attempts (tenant_id, status, created_at);

-- Cerca de inserção: mesmo destinatário verificado do fluxo diário
-- (guard_daily_payment_email) e estado da fatura coerente com o tipo.
create or replace function private.guard_payment_notification_email()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  pay public.student_payments%rowtype;
  p public.profiles%rowtype;
  payer public.profiles%rowtype;
  v_email text;
  school_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if new.status <> 'SUBMITTING' then
    raise exception 'payment_notification_email_blocked' using errcode = 'P0001';
  end if;
  select * into pay from public.student_payments
   where id = new.payment_id and tenant_id = new.tenant_id
     and student_id = new.student_id
   for share;
  if not found or pay.due_date is distinct from new.ref_date
     or pay.exclusion_reason is not null
     or coalesce(pay.value, 0) <= 0 then
    raise exception 'payment_notification_email_blocked' using errcode = 'P0001';
  end if;
  if new.kind = 'PAYMENT_RECEIVED_EMAIL' then
    if upper(btrim(coalesce(pay.status, ''))) not in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO') then
      raise exception 'payment_notification_email_blocked' using errcode = 'P0001';
    end if;
  elsif upper(btrim(coalesce(pay.status, ''))) <> 'PENDING'
     or coalesce(pay.refunded_amount, 0) <> 0
     or pay.due_date < school_today
     or private.student_payment_provider_block_reason(pay.id) is not null
     or (new.kind = 'PAYMENT_DUE_REMINDER_D10_EMAIL' and pay.due_date <> school_today + 10)
     or (new.kind = 'PAYMENT_DUE_REMINDER_D0_EMAIL' and pay.due_date <> school_today) then
    raise exception 'payment_notification_email_blocked' using errcode = 'P0001';
  end if;

  select * into p from public.profiles
   where id = new.student_id and tenant_id = new.tenant_id for share;
  if not found or p.role <> 'STUDENT' or p.lifecycle_status <> 'active'
     or p.is_test_account is true
     or not public.is_student_notifiable(p.id)
     or not exists (
       select 1 from public.tenant_memberships m
        where m.user_id = p.id and m.tenant_id = p.tenant_id
          and m.role = 'STUDENT' and m.status = 'ACTIVE')
     or not exists (
       select 1 from public.tenant_admin_settings s
        where s.tenant_id = new.tenant_id and s.student_notifications_enabled)
     or exists (
       select 1 from auth.users u where u.id = p.id
         and (u.raw_user_meta_data @> '{"test_fixture":true}'
           or u.raw_user_meta_data @> '{"testMode":true}')) then
    raise exception 'payment_notification_email_blocked' using errcode = 'P0001';
  end if;

  if p.guardian_id is not null or nullif(btrim(p.guardian_cpf), '') is not null then
    select * into payer from public.profiles
     where id = p.guardian_id and tenant_id = p.tenant_id for share;
    if not found or payer.is_test_account is true
       or lower(btrim(coalesce(p.guardian_email, '')))
          is distinct from lower(btrim(coalesce(payer.email, ''))) then
      raise exception 'payment_notification_guardian_email_unverified' using errcode = 'P0001';
    end if;
  else
    payer := p;
  end if;
  v_email := lower(btrim(coalesce(payer.email, '')));
  if v_email = '' or v_email like '%@accounts.invalid'
     or v_email is distinct from lower(btrim(new.recipient_email))
     or not exists (
       select 1 from auth.users u where u.id = payer.id
         and lower(u.email) = v_email and u.email_confirmed_at is not null) then
    raise exception 'payment_notification_recipient_email_unverified' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
alter function private.guard_payment_notification_email() owner to postgres;
revoke all on function private.guard_payment_notification_email()
  from public, anon, authenticated, service_role;
drop trigger if exists guard_payment_notification_email
  on public.payment_notification_email_attempts;
create trigger guard_payment_notification_email
before insert on public.payment_notification_email_attempts
for each row execute function private.guard_payment_notification_email();

notify pgrst, 'reload schema';
