begin;

-- Affiliate coupons share the existing SALESPERSON commission ledger.  Money in
-- vendor_commissions is stored in integer cents, despite the legacy column name.
alter table public.profiles
  add column if not exists affiliate_code text;

alter table public.profiles
  alter column commission_rate set default 4900;

create or replace function private.normalize_affiliate_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.upper(
    pg_catalog.regexp_replace(
      pg_catalog.btrim(coalesce(p_code, '')),
      '[^A-Za-z0-9_-]+',
      '',
      'g'
    )
  );
$function$;

alter function private.normalize_affiliate_code(text) owner to postgres;
revoke all on function private.normalize_affiliate_code(text)
  from public, anon, authenticated, service_role;

create unique index if not exists profiles_affiliate_code_tenant_unique_idx
  on public.profiles (tenant_id, pg_catalog.lower(affiliate_code))
  where role = 'SALESPERSON' and affiliate_code is not null;

do $constraint$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.profiles'::pg_catalog.regclass
       and conname = 'profiles_affiliate_code_shape_check'
  ) then
    alter table public.profiles
      add constraint profiles_affiliate_code_shape_check
      check (
        affiliate_code is null
        or affiliate_code ~ '^[A-Z0-9][A-Z0-9_-]{3,31}$'
      ) not valid;
  end if;
end;
$constraint$;

create or replace function private.ensure_salesperson_affiliate_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate text;
begin
  if new.role is distinct from 'SALESPERSON' then
    new.affiliate_code := null;
    return new;
  end if;

  new.commission_rate := coalesce(nullif(new.commission_rate, 0), 4900);
  v_candidate := private.normalize_affiliate_code(new.affiliate_code);
  if v_candidate = '' then
    -- substr com vírgulas: a forma "substring(x from 1 for 10)" é sintaxe
    -- especial do SQL e não existe com o prefixo pg_catalog.
    v_candidate := 'WW-' || pg_catalog.upper(pg_catalog.substr(
      pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
      1, 10
    ));
  end if;
  if v_candidate !~ '^[A-Z0-9][A-Z0-9_-]{3,31}$' then
    raise exception 'invalid_affiliate_code' using errcode = '22023';
  end if;
  new.affiliate_code := v_candidate;
  return new;
end;
$function$;

alter function private.ensure_salesperson_affiliate_code() owner to postgres;
revoke all on function private.ensure_salesperson_affiliate_code()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_ensure_salesperson_affiliate_code
  on public.profiles;
create trigger trg_ensure_salesperson_affiliate_code
before insert or update of role, affiliate_code, commission_rate
on public.profiles
for each row execute function private.ensure_salesperson_affiliate_code();

update public.profiles as profile
   set affiliate_code = 'WW-' || pg_catalog.upper(pg_catalog.substr(
         pg_catalog.replace(profile.id::text, '-', ''), 1, 10
       ))
 where profile.role = 'SALESPERSON'
   and private.normalize_affiliate_code(profile.affiliate_code) = '';

alter table public.profiles
  validate constraint profiles_affiliate_code_shape_check;

-- Failed guesses are limited per offer.  The table is private and is never
-- reachable through the Data API.
create table if not exists private.affiliate_coupon_attempts (
  offer_id uuid primary key references public.offers(id) on delete cascade,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  window_started_at timestamptz not null default pg_catalog.now(),
  last_attempt_at timestamptz not null default pg_catalog.now()
);
alter table private.affiliate_coupon_attempts owner to postgres;
revoke all on table private.affiliate_coupon_attempts
  from public, anon, authenticated, service_role;

-- Afiliado ativo dono do cupom, sempre dentro da escola da oferta.
create or replace function private.active_affiliate_by_code(
  p_tenant_id text,
  p_code text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select profile.id
    from public.profiles as profile
   where profile.tenant_id = p_tenant_id
     and profile.role = 'SALESPERSON'
     and profile.affiliate_code is not null
     and pg_catalog.lower(profile.affiliate_code)
       = pg_catalog.lower(private.normalize_affiliate_code(p_code))
     and pg_catalog.lower(coalesce(profile.lifecycle_status, 'active')) = 'active'
     and pg_catalog.lower(coalesce(profile.status, 'ativo')) not in (
       'inativo', 'inactive', 'suspended', 'offboarded'
     )
   limit 1;
$function$;

alter function private.active_affiliate_by_code(text,text) owner to postgres;
revoke all on function private.active_affiliate_by_code(text,text)
  from public, anon, authenticated, service_role;

-- O benefício da indicação é um só, venha de onde vier — cupom digitado pelo
-- aluno, cupom posto pela escola no link manual, experimental aberta por um
-- afiliado: taxa de matrícula zerada e comissão congelada na oferta. Só vale
-- para plano (aula avulsa não tem matrícula) e só antes de o aluno começar.
create or replace function private.grant_affiliate_benefit(
  p_offer_id uuid,
  p_vendor_id uuid,
  p_attribution text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer public.offers%rowtype;
  v_vendor public.profiles%rowtype;
  v_commission integer;
begin
  select offer.* into v_offer
    from public.offers as offer
   where offer.id = p_offer_id
     and offer.kind = 'ENROLLMENT'
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'OFFER_NOT_ELIGIBLE');
  end if;

  select profile.* into v_vendor
    from public.profiles as profile
   where profile.id = p_vendor_id
     and profile.tenant_id = v_offer.tenant_id
     and profile.role = 'SALESPERSON';
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'INVALID_COUPON');
  end if;

  -- Reaplicar o mesmo afiliado é no-op (retentativa, ou o aluno digitando o
  -- cupom que a escola já pôs no link): a comissão congelada não muda.
  if v_offer.vendor_id = v_vendor.id
     and v_offer.metadata ? 'affiliate_commission_cents'
     and coalesce(v_offer.enrollment_fee, 0) = 0
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'already_applied', true,
      'coupon_code', coalesce(
        v_offer.metadata ->> 'affiliate_coupon_code',
        v_vendor.affiliate_code
      ),
      'enrollment_fee', 0,
      'commission_cents', (v_offer.metadata ->> 'affiliate_commission_cents')::integer
    );
  end if;

  if v_offer.vendor_id is not null and v_offer.vendor_id <> v_vendor.id then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'AFFILIATE_ALREADY_ATTRIBUTED'
    );
  end if;

  if v_offer.revoked_at is not null
     or v_offer.expires_at is null
     or v_offer.expires_at <= pg_catalog.now()
     or v_offer.consumed_at is not null
     or v_offer.processing_by is not null
     or coalesce(v_offer.processing_state, 'NOT_STARTED') <> 'NOT_STARTED'
     or coalesce(v_offer.requires_enrollment, false) is false
     or not private.tenant_is_operational(v_offer.tenant_id)
  then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'OFFER_NOT_ELIGIBLE');
  end if;

  v_commission := greatest(coalesce(v_vendor.commission_rate, 4900), 1);
  update public.offers as offer
     set vendor_id = v_vendor.id,
         enrollment_fee = 0,
         payload = coalesce(offer.payload, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
                'enrollmentFee', 0,
                'affiliateCouponApplied', true,
                'affiliateCouponCode', v_vendor.affiliate_code,
                'vendorId', v_vendor.id
              ),
         metadata = coalesce(offer.metadata, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
                'affiliate_attribution', p_attribution,
                'affiliate_coupon_code', v_vendor.affiliate_code,
                'affiliate_commission_cents', v_commission,
                'affiliate_applied_at', pg_catalog.now()
              )
   where offer.id = p_offer_id;

  update public.enrollment_links as link
     set created_by_vendor_id = v_vendor.id,
         enrollment_fee = 0
   where link.offer_id = p_offer_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'coupon_code', v_vendor.affiliate_code,
    'enrollment_fee', 0,
    'commission_cents', v_commission
  );
end;
$function$;

alter function private.grant_affiliate_benefit(uuid,uuid,text) owner to postgres;
revoke all on function private.grant_affiliate_benefit(uuid,uuid,text)
  from public, anon, authenticated, service_role;

-- Cupom digitado pelo próprio aluno na página de matrícula (tenant-legal-assets,
-- service role). Chute errado é limitado por oferta.
create or replace function public.apply_affiliate_coupon(
  p_offer_id uuid,
  p_coupon_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer public.offers%rowtype;
  v_code text := private.normalize_affiliate_code(p_coupon_code);
  v_attempts integer := 0;
  v_vendor_id uuid;
  v_result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;
  if p_offer_id is null or v_code !~ '^[A-Z0-9][A-Z0-9_-]{3,31}$' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'INVALID_COUPON');
  end if;

  select offer.* into v_offer
    from public.offers as offer
   where offer.id = p_offer_id
     and offer.kind = 'ENROLLMENT'
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'OFFER_NOT_ELIGIBLE');
  end if;

  -- Link que já nasceu com afiliado (a escola pôs o cupom): o mesmo cupom
  -- confirma, outro cupom não troca o dono da indicação.
  if v_offer.vendor_id is not null then
    v_vendor_id := private.active_affiliate_by_code(v_offer.tenant_id, v_code);
    if v_vendor_id is not distinct from v_offer.vendor_id then
      return private.grant_affiliate_benefit(p_offer_id, v_vendor_id, 'COUPON');
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'AFFILIATE_ALREADY_ATTRIBUTED'
    );
  end if;

  if v_offer.revoked_at is not null
     or v_offer.expires_at is null
     or v_offer.expires_at <= pg_catalog.now()
     or v_offer.consumed_at is not null
     or v_offer.processing_by is not null
     or coalesce(v_offer.processing_state, 'NOT_STARTED') <> 'NOT_STARTED'
     or coalesce(v_offer.requires_enrollment, false) is false
     or not private.tenant_is_operational(v_offer.tenant_id)
  then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'OFFER_NOT_ELIGIBLE');
  end if;

  insert into private.affiliate_coupon_attempts as attempt (
    offer_id, failed_attempts, window_started_at, last_attempt_at
  ) values (
    p_offer_id, 0, pg_catalog.now(), pg_catalog.now()
  )
  on conflict (offer_id) do update
     set failed_attempts = case
           when attempt.window_started_at < pg_catalog.now() - interval '1 hour'
             then 0
           else attempt.failed_attempts
         end,
         window_started_at = case
           when attempt.window_started_at < pg_catalog.now() - interval '1 hour'
             then pg_catalog.now()
           else attempt.window_started_at
         end,
         last_attempt_at = pg_catalog.now()
  returning failed_attempts into v_attempts;

  if v_attempts >= 10 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'TOO_MANY_ATTEMPTS');
  end if;

  v_vendor_id := private.active_affiliate_by_code(v_offer.tenant_id, v_code);
  if v_vendor_id is null then
    update private.affiliate_coupon_attempts as attempt
       set failed_attempts = attempt.failed_attempts + 1,
           last_attempt_at = pg_catalog.now()
     where attempt.offer_id = p_offer_id;
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'INVALID_COUPON');
  end if;

  v_result := private.grant_affiliate_benefit(p_offer_id, v_vendor_id, 'COUPON');
  if coalesce((v_result ->> 'ok')::boolean, false) then
    delete from private.affiliate_coupon_attempts as attempt
     where attempt.offer_id = p_offer_id;
  end if;
  return v_result;
end;
$function$;

alter function public.apply_affiliate_coupon(uuid,text) owner to postgres;
revoke all on function public.apply_affiliate_coupon(uuid,text)
  from public, anon, authenticated;
grant execute on function public.apply_affiliate_coupon(uuid,text)
  to service_role;

-- A commission is reserved when the student claims the offer and becomes
-- withdrawable only when the authoritative enrollment reaches COMPLETED.  That
-- transition is driven exclusively by a settled Asaas webhook observation.
create or replace function private.sync_offer_affiliate_commission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_vendor public.profiles%rowtype;
  v_link_id uuid;
  v_amount integer;
  v_request_id uuid;
begin
  if new.kind <> 'ENROLLMENT' or new.vendor_id is null then
    return new;
  end if;

  -- Comissão é por matrícula (plano). Aula avulsa não tem matrícula e não
  -- gera comissão, mesmo que a oferta tenha nascido de um afiliado.
  if coalesce(new.requires_enrollment, false) is false then
    return new;
  end if;

  if coalesce(new.processing_state, 'NOT_STARTED') <> 'COMPLETED'
     and new.processing_by is null
  then
    return new;
  end if;

  select profile.* into v_vendor
    from public.profiles as profile
   where profile.id = new.vendor_id
     and profile.tenant_id = new.tenant_id
     and profile.role = 'SALESPERSON';
  if not found then return new; end if;

  begin
    v_amount := nullif(new.metadata ->> 'affiliate_commission_cents', '')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    v_amount := null;
  end;
  v_amount := greatest(coalesce(v_amount, v_vendor.commission_rate, 4900), 1);

  select link.id into v_link_id
    from public.enrollment_links as link
   where link.offer_id = new.id
   order by link.created_at
   limit 1;

  if old.processing_state = 'COMPLETED'
     and new.processing_state is distinct from 'COMPLETED'
  then
    select commission.withdrawal_request_id into v_request_id
      from public.vendor_commissions as commission
     where commission.offer_id = new.id
       and commission.vendor_id = new.vendor_id
       and commission.status <> 'PAID'
     for update;

    if v_request_id is not null then
      update public.vendor_withdrawal_requests as request
         set status = 'CANCELLED',
             reviewed_at = pg_catalog.now(),
             review_note = 'Pagamento da matrícula estornado antes do repasse.'
       where request.id = v_request_id
         and request.status in ('PENDING', 'APPROVED');
    end if;

    update public.vendor_commissions as commission
       set status = 'PENDING',
           confirmed_at = null,
           withdrawal_request_id = null
     where commission.offer_id = new.id
       and commission.vendor_id = new.vendor_id
       and commission.status <> 'PAID';
    return new;
  end if;

  insert into public.vendor_commissions (
    vendor_id, student_id, enrollment_link_id, offer_id,
    amount_brl, status, confirmed_at, tenant_id
  ) values (
    new.vendor_id,
    coalesce(new.processing_by, new.consumed_by),
    v_link_id,
    new.id,
    v_amount,
    case when new.processing_state = 'COMPLETED' then 'CONFIRMED' else 'PENDING' end,
    case when new.processing_state = 'COMPLETED' then pg_catalog.now() else null end,
    new.tenant_id
  )
  on conflict (offer_id) where offer_id is not null do update
     set student_id = coalesce(
           public.vendor_commissions.student_id,
           excluded.student_id
         ),
         enrollment_link_id = coalesce(
           public.vendor_commissions.enrollment_link_id,
           excluded.enrollment_link_id
         ),
         status = case
           when public.vendor_commissions.status = 'PAID'
             then public.vendor_commissions.status
           when new.processing_state = 'COMPLETED' then 'CONFIRMED'
           else public.vendor_commissions.status
         end,
         confirmed_at = case
           when new.processing_state = 'COMPLETED'
             then coalesce(
               public.vendor_commissions.confirmed_at,
               pg_catalog.now()
             )
           else public.vendor_commissions.confirmed_at
         end;
  return new;
end;
$function$;

alter function private.sync_offer_affiliate_commission() owner to postgres;
revoke all on function private.sync_offer_affiliate_commission()
  from public, anon, authenticated, service_role;

-- Withdrawal requests reserve exact commission rows, preventing the same
-- confirmed balance from being requested twice.
create table if not exists public.vendor_withdrawal_requests (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  vendor_id uuid not null references public.profiles(id) on delete restrict,
  amount_brl integer not null check (amount_brl > 0),
  commission_count integer not null check (commission_count > 0),
  pix_key_snapshot text not null,
  pix_key_type_snapshot text,
  status text not null default 'PENDING' check (
    status in ('PENDING', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED')
  ),
  requested_at timestamptz not null default pg_catalog.now(),
  reviewed_at timestamptz,
  paid_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_note text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

alter table public.vendor_withdrawal_requests enable row level security;
revoke all on table public.vendor_withdrawal_requests from anon, authenticated;
grant all on table public.vendor_withdrawal_requests to service_role;

create index if not exists vendor_withdrawal_requests_vendor_status_idx
  on public.vendor_withdrawal_requests (vendor_id, status, requested_at desc);
create index if not exists vendor_withdrawal_requests_tenant_status_idx
  on public.vendor_withdrawal_requests (tenant_id, status, requested_at desc);

alter table public.vendor_commissions
  add column if not exists withdrawal_request_id uuid;

do $constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.vendor_commissions'::pg_catalog.regclass
       and conname = 'vendor_commissions_withdrawal_request_id_fkey'
  ) then
    alter table public.vendor_commissions
      add constraint vendor_commissions_withdrawal_request_id_fkey
      foreign key (withdrawal_request_id)
      references public.vendor_withdrawal_requests(id)
      on delete set null;
  end if;
end;
$constraint$;

create index if not exists vendor_commissions_withdrawal_request_idx
  on public.vendor_commissions (withdrawal_request_id)
  where withdrawal_request_id is not null;
create index if not exists vendor_commissions_withdrawable_idx
  on public.vendor_commissions (vendor_id, created_at)
  where status = 'CONFIRMED' and withdrawal_request_id is null;

-- The legacy trigger confirmed every pending commission for a student after
-- any received payment. The offer state machine below is stricter: it releases
-- only the commission for the enrollment whose Asaas settlement was proven.
drop trigger if exists trg_confirm_commission_on_payment
  on public.student_payments;

drop trigger if exists trg_sync_offer_affiliate_commission
  on public.offers;
create trigger trg_sync_offer_affiliate_commission
after update of vendor_id, processing_by, consumed_by, processing_state
on public.offers
for each row execute function private.sync_offer_affiliate_commission();

-- Repair the old gap: COMPLETED already means that the serialized webhook path
-- proved a settled payment, so legacy PENDING rows can safely become available.
update public.vendor_commissions as commission
   set status = 'CONFIRMED',
       confirmed_at = coalesce(
         commission.confirmed_at,
         offer.processing_completed_at,
         pg_catalog.now()
       )
  from public.offers as offer
 where offer.id = commission.offer_id
   and offer.processing_state = 'COMPLETED'
   and commission.status = 'PENDING';

create or replace function public.get_my_pay()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'hourly_rate', profile.hourly_rate,
    'pix_key', profile.pix_key,
    'pix_key_type', profile.pix_key_type,
    'commission_rate', profile.commission_rate,
    'affiliate_code', profile.affiliate_code
  )
  from public.profiles as profile
  where profile.id = (select auth.uid());
$function$;

alter function public.get_my_pay() owner to postgres;
revoke all on function public.get_my_pay() from public, anon;
grant execute on function public.get_my_pay() to authenticated, service_role;

create or replace function public.get_my_affiliate_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_profile public.profiles%rowtype;
begin
  select profile.* into v_profile
    from public.profiles as profile
   where profile.id = v_user_id
     and profile.role = 'SALESPERSON';
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'affiliate_code', v_profile.affiliate_code,
    'commission_rate', v_profile.commission_rate,
    'pix_ready', nullif(pg_catalog.btrim(coalesce(v_profile.pix_key, '')), '') is not null,
    'pending_cents', coalesce((
      select pg_catalog.sum(commission.amount_brl)
        from public.vendor_commissions as commission
       where commission.vendor_id = v_user_id
         and commission.status = 'PENDING'
    ), 0),
    'available_cents', coalesce((
      select pg_catalog.sum(commission.amount_brl)
        from public.vendor_commissions as commission
       where commission.vendor_id = v_user_id
         and commission.status = 'CONFIRMED'
         and commission.withdrawal_request_id is null
    ), 0),
    'requested_cents', coalesce((
      select pg_catalog.sum(request.amount_brl)
        from public.vendor_withdrawal_requests as request
       where request.vendor_id = v_user_id
         and request.status in ('PENDING', 'APPROVED')
    ), 0),
    'paid_cents', coalesce((
      select pg_catalog.sum(commission.amount_brl)
        from public.vendor_commissions as commission
       where commission.vendor_id = v_user_id
         and commission.status = 'PAID'
    ), 0)
  );
end;
$function$;

alter function public.get_my_affiliate_summary() owner to postgres;
revoke all on function public.get_my_affiliate_summary()
  from public, anon;
grant execute on function public.get_my_affiliate_summary()
  to authenticated, service_role;

create or replace function public.request_vendor_withdrawal()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_profile public.profiles%rowtype;
  v_request_id uuid;
  v_commission_ids uuid[];
  v_amount integer;
  v_count integer;
begin
  select profile.* into v_profile
    from public.profiles as profile
   where profile.id = v_user_id
     and profile.role = 'SALESPERSON'
     and pg_catalog.lower(coalesce(profile.lifecycle_status, 'active')) = 'active'
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;
  if nullif(pg_catalog.btrim(coalesce(v_profile.pix_key, '')), '') is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'PIX_REQUIRED');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vendor-withdrawal:' || v_user_id::text, 0)
  );
  select pg_catalog.array_agg(locked.id order by locked.created_at, locked.id),
         coalesce(pg_catalog.sum(locked.amount_brl), 0),
         pg_catalog.count(*)::integer
    into v_commission_ids, v_amount, v_count
    from (
      select commission.id, commission.amount_brl, commission.created_at
        from public.vendor_commissions as commission
       where commission.vendor_id = v_user_id
         and commission.tenant_id = v_profile.tenant_id
         and commission.status = 'CONFIRMED'
         and commission.withdrawal_request_id is null
       order by commission.created_at, commission.id
       for update
    ) as locked;
  if v_amount <= 0 or v_count <= 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'NO_AVAILABLE_BALANCE');
  end if;

  insert into public.vendor_withdrawal_requests (
    tenant_id, vendor_id, amount_brl, commission_count,
    pix_key_snapshot, pix_key_type_snapshot
  ) values (
    v_profile.tenant_id, v_user_id, v_amount, v_count,
    v_profile.pix_key, v_profile.pix_key_type
  ) returning id into v_request_id;

  update public.vendor_commissions as commission
     set withdrawal_request_id = v_request_id
   where commission.id = any(v_commission_ids)
     and commission.status = 'CONFIRMED'
     and commission.withdrawal_request_id is null;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'request_id', v_request_id,
    'amount_cents', v_amount,
    'commission_count', v_count,
    'status', 'PENDING'
  );
end;
$function$;

alter function public.request_vendor_withdrawal() owner to postgres;
revoke all on function public.request_vendor_withdrawal()
  from public, anon;
grant execute on function public.request_vendor_withdrawal()
  to authenticated, service_role;

create or replace function public.get_vendor_withdrawals(
  p_vendor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_vendor_id uuid := coalesce(p_vendor_id, v_actor_id);
  v_vendor public.profiles%rowtype;
begin
  select profile.* into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;
  select profile.* into v_vendor
    from public.profiles as profile
   where profile.id = v_vendor_id
     and profile.role = 'SALESPERSON';
  if v_actor.id is null or not found or (
    v_actor_id <> v_vendor_id
    and (
      coalesce(v_actor.role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
      or (v_actor.role <> 'SUPER_ADMIN' and v_actor.tenant_id <> v_vendor.tenant_id)
    )
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'requests', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', request.id,
          'amount_cents', request.amount_brl,
          'commission_count', request.commission_count,
          'status', request.status,
          'requested_at', request.requested_at,
          'reviewed_at', request.reviewed_at,
          'paid_at', request.paid_at,
          'review_note', request.review_note
        ) order by request.requested_at desc
      )
      from public.vendor_withdrawal_requests as request
      where request.vendor_id = v_vendor_id
    ), '[]'::jsonb)
  );
end;
$function$;

alter function public.get_vendor_withdrawals(uuid) owner to postgres;
revoke all on function public.get_vendor_withdrawals(uuid)
  from public, anon;
grant execute on function public.get_vendor_withdrawals(uuid)
  to authenticated, service_role;

create or replace function public.set_vendor_withdrawal_status(
  p_request_id uuid,
  p_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_request public.vendor_withdrawal_requests%rowtype;
  v_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_status, '')));
begin
  select profile.* into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;
  if not found or coalesce(v_actor.role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  select request.* into v_request
    from public.vendor_withdrawal_requests as request
   where request.id = p_request_id
   for update;
  if v_actor.id is null
     or not found
     or (v_actor.role <> 'SUPER_ADMIN' and v_actor.tenant_id <> v_request.tenant_id)
  then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;

  if not (
    (v_request.status = 'PENDING' and v_status in ('APPROVED', 'REJECTED'))
    or (v_request.status = 'APPROVED' and v_status in ('PAID', 'CANCELLED'))
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'INVALID_TRANSITION');
  end if;

  update public.vendor_withdrawal_requests as request
     set status = v_status,
         reviewed_at = coalesce(request.reviewed_at, pg_catalog.now()),
         paid_at = case when v_status = 'PAID' then pg_catalog.now() else request.paid_at end,
         reviewed_by = v_actor_id,
         review_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
         updated_at = pg_catalog.now()
   where request.id = p_request_id;

  if v_status = 'PAID' then
    update public.vendor_commissions as commission
       set status = 'PAID',
           paid_at = coalesce(commission.paid_at, pg_catalog.now())
     where commission.withdrawal_request_id = p_request_id
       and commission.status = 'CONFIRMED';
  elsif v_status in ('REJECTED', 'CANCELLED') then
    update public.vendor_commissions as commission
       set withdrawal_request_id = null
     where commission.withdrawal_request_id = p_request_id
       and commission.status = 'CONFIRMED';
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'status', v_status);
end;
$function$;

alter function public.set_vendor_withdrawal_status(uuid,text,text)
  owner to postgres;
revoke all on function public.set_vendor_withdrawal_status(uuid,text,text)
  from public, anon;
grant execute on function public.set_vendor_withdrawal_status(uuid,text,text)
  to authenticated, service_role;

create or replace function public.list_vendor_affiliate_terms()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
begin
  select profile.* into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;
  if not found or coalesce(v_actor.role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'vendor_id', profile.id,
        'affiliate_code', profile.affiliate_code,
        'commission_rate', profile.commission_rate
      ) order by profile.full_name
    )
    from public.profiles as profile
    where profile.role = 'SALESPERSON'
      and (
        v_actor.role = 'SUPER_ADMIN'
        or profile.tenant_id = v_actor.tenant_id
      )
  ), '[]'::jsonb);
end;
$function$;

alter function public.list_vendor_affiliate_terms() owner to postgres;
revoke all on function public.list_vendor_affiliate_terms()
  from public, anon;
grant execute on function public.list_vendor_affiliate_terms()
  to authenticated, service_role;

create or replace function public.update_vendor_affiliate_terms(
  p_vendor_id uuid,
  p_commission_cents integer,
  p_affiliate_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_vendor public.profiles%rowtype;
  v_code text := private.normalize_affiliate_code(p_affiliate_code);
begin
  select profile.* into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;
  select profile.* into v_vendor
    from public.profiles as profile
   where profile.id = p_vendor_id
     and profile.role = 'SALESPERSON'
   for update;
  if v_actor.id is null
     or not found
     or coalesce(v_actor.role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
     or (v_actor.role <> 'SUPER_ADMIN' and v_actor.tenant_id <> v_vendor.tenant_id)
  then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;
  if p_commission_cents is null or p_commission_cents not between 1 and 1000000 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'INVALID_COMMISSION');
  end if;
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{3,31}$' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;

  begin
    update public.profiles as profile
       set commission_rate = p_commission_cents,
           affiliate_code = v_code
     where profile.id = p_vendor_id;
  exception when unique_violation then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'CODE_IN_USE');
  end;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'vendor_id', p_vendor_id,
    'commission_rate', p_commission_cents,
    'affiliate_code', v_code
  );
end;
$function$;

alter function public.update_vendor_affiliate_terms(uuid,integer,text)
  owner to postgres;
revoke all on function public.update_vendor_affiliate_terms(uuid,integer,text)
  from public, anon;
grant execute on function public.update_vendor_affiliate_terms(uuid,integer,text)
  to authenticated, service_role;

-- vendor_commissions.amount_brl is integer cents. Financial statements use
-- BRL numerics, so normalize only this ledger at the report boundary.
create or replace function public.get_cashflow_unchecked(p_month text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_tenant text;
  v_month text;
  v_month_start date;
  v_month_end date;
  v_in numeric;
  v_teacher numeric;
  v_vendor numeric;
  v_referral numeric;
  v_expense numeric;
begin
  select p.tenant_id
    into v_tenant
    from public.profiles p
   where p.id = auth.uid();

  v_month := coalesce(p_month, to_char(current_date, 'YYYY-MM'));
  if v_month !~ '^\d{4}-\d{2}$' then
    raise exception 'Mes invalido (use YYYY-MM)';
  end if;
  v_month_start := to_date(v_month || '-01', 'YYYY-MM-DD');
  if to_char(v_month_start, 'YYYY-MM') <> v_month then
    raise exception 'Mes invalido (use YYYY-MM)';
  end if;
  v_month_end := (v_month_start + interval '1 month')::date;

  select coalesce(sum(ft.amount), 0)
    into v_in
    from public.financial_transactions ft
   where ft.tenant_id = v_tenant
     and ft.type = 'ENTRADA'
     and ft.category is distinct from 'aporte_ou_movimentacao'
     and ft.occurred_at >= v_month_start
     and ft.occurred_at < v_month_end;

  select coalesce(sum(tc.total_amount), 0)
    into v_teacher
    from public.teacher_closings tc
   where tc.tenant_id = v_tenant
     and tc.status = 'PAGO'
     and coalesce(tc.paid_at, (tc.month_year || '-01')::date) >= v_month_start
     and coalesce(tc.paid_at, (tc.month_year || '-01')::date) < v_month_end;

  select coalesce(sum(vc.amount_brl), 0) / 100.0
    into v_vendor
    from public.vendor_commissions vc
   where vc.tenant_id = v_tenant
     and vc.status = 'PAID'
     and vc.paid_at >= v_month_start
     and vc.paid_at < v_month_end;

  select coalesce(sum(rr.amount_brl), 0)
    into v_referral
    from public.referral_rewards rr
   where rr.tenant_id = v_tenant
     and rr.status = 'PAID'
     and rr.paid_at >= v_month_start
     and rr.paid_at < v_month_end;

  select coalesce(sum(ft.amount), 0)
    into v_expense
    from public.financial_transactions ft
   where ft.tenant_id = v_tenant
     and ft.type = 'SAIDA'
     and ft.category is distinct from 'teacher_payout'
     and ft.category is distinct from 'estorno_aporte_ou_movimentacao'
     and ft.account_code is distinct from '5.1.01'
     and ft.occurred_at >= v_month_start
     and ft.occurred_at < v_month_end;

  return jsonb_build_object(
    'month', v_month,
    'entradas', v_in,
    'saidas', jsonb_build_object(
      'professores', v_teacher,
      'vendedores', v_vendor,
      'indicacoes', v_referral,
      'despesas', v_expense,
      'total', v_teacher + v_vendor + v_referral + v_expense
    ),
    'saldo', v_in - (v_teacher + v_vendor + v_referral + v_expense),
    -- Valores ainda devidos permanecem brutos: estorno de dinheiro ja
    -- realizado nao reduz o principal de outra fatura em aberto.
    'inadimplencia', (
      select jsonb_build_object(
        'total', coalesce(sum(sp.value), 0),
        'd1_30', coalesce(sum(sp.value) filter (
          where current_date - sp.due_date between 1 and 30
        ), 0),
        'd31_60', coalesce(sum(sp.value) filter (
          where current_date - sp.due_date between 31 and 60
        ), 0),
        'd60plus', coalesce(sum(sp.value) filter (
          where current_date - sp.due_date > 60
        ), 0),
        'count', count(*)
      )
      from public.student_payments sp
      where sp.tenant_id = v_tenant
        and sp.status in ('OVERDUE', 'DUNNING_REQUESTED')
        -- cobertura: cobrança de mês já pago num pagamento completo é
        -- cobrança em dobro a cancelar, não inadimplência.
        and not private.student_payment_is_covered(sp.id)
    ),
    'a_receber', (
      select coalesce(sum(sp.value), 0)
        from public.student_payments sp
       where sp.tenant_id = v_tenant
         and sp.status = 'PENDING'
         and sp.due_date >= v_month_start
         and sp.due_date < v_month_end
         -- cobertura: mês coberto não é dinheiro a receber.
         and not private.student_payment_is_covered(sp.id)
    ),
    'serie', (
      select jsonb_agg(
        jsonb_build_object('mes', series.month_year, 'entradas', series.amount)
        order by series.month_year
      )
      from (
        select
          to_char(months.month_start, 'YYYY-MM') as month_year,
          coalesce((
            select sum(ft.amount)
              from public.financial_transactions ft
             where ft.tenant_id = v_tenant
               and ft.type = 'ENTRADA'
               and ft.category is distinct from 'aporte_ou_movimentacao'
               and ft.occurred_at >= months.month_start
               and ft.occurred_at < months.month_start + interval '1 month'
          ), 0) as amount
        from generate_series(
          date_trunc('month', current_date) - interval '5 months',
          date_trunc('month', current_date),
          interval '1 month'
        ) as months(month_start)
      ) series
    )
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.dre_gerencial(p_month text DEFAULT NULL::text, p_tenant text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text;
  v_receita numeric; v_deducoes numeric; v_nao_classificado numeric;
  v_custo_aulas numeric; v_custo_ajustes numeric; v_custo_outros numeric;
  v_desp_vendedor numeric; v_desp_indicacao numeric; v_desp_ledger numeric;
  v_barrado numeric;
  v_aulas int; v_alunos int;
  v_receita_liq numeric; v_custo numeric; v_lucro_bruto numeric;
  v_despesas numeric; v_resultado numeric;
  v_linhas jsonb; v_linhas_ledger jsonb; v_alertas jsonb := '[]'::jsonb;
begin
  v_tenant := coalesce(nullif(btrim(p_tenant),''),private.active_tenant_id(auth.uid()));
  if not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Sem permissão para consultar o relatório financeiro' using errcode='42501';
  end if;

  v_month := coalesce(p_month, to_char(current_date,'YYYY-MM'));
  if v_month !~ '^\d{4}-\d{2}$' then raise exception 'Mês inválido (use YYYY-MM)'; end if;

  SELECT COALESCE(sum(greatest(round(coalesce(value, 0) - coalesce(refunded_amount, 0), 2), 0)),0) INTO v_receita
  FROM student_payments
  WHERE tenant_id = v_tenant AND status IN ('RECEIVED','RECEIVED_IN_CASH')
    AND NOT private.is_unclassified_operator_receipt(payment_type,student_id,raw_payload)
    AND to_char(COALESCE(credited_at, paid_at, payment_date, due_date),'YYYY-MM') = v_month;

  v_nao_classificado := private.unclassified_receipt_total(v_tenant,v_month);

  select coalesce(sum(custo_aulas),0), coalesce(sum(aulas),0)
    into v_custo_aulas, v_aulas
  from v_teacher_cost_competencia
  where tenant_id = v_tenant and month_year = v_month;

  select coalesce(sum(amount),0) into v_custo_ajustes
  from closing_adjustments
  where tenant_id = v_tenant and month_year = v_month;

  select count(distinct v.student_id) into v_alunos
  from v_payable_class_logs v join profiles t on t.id = v.teacher_id
  where t.tenant_id = v_tenant and to_char(v.class_date,'YYYY-MM') = v_month
    and v.student_id is not null;

  select coalesce(sum(amount_brl),0) / 100.0 into v_desp_vendedor
  from vendor_commissions
  where tenant_id = v_tenant and status='PAID' and to_char(paid_at,'YYYY-MM') = v_month;

  select coalesce(sum(amount_brl),0) into v_desp_indicacao
  from referral_rewards
  where tenant_id = v_tenant and status='PAID' and to_char(paid_at,'YYYY-MM') = v_month;

  select
    coalesce(sum(t.valor) filter (where not t.barrado and t.kind = 'DEDUCAO'), 0),
    coalesce(sum(t.valor) filter (where not t.barrado and t.kind = 'CUSTO'),   0),
    coalesce(sum(t.valor) filter (where not t.barrado and t.kind = 'DESPESA'), 0),
    coalesce(sum(t.valor) filter (where t.barrado), 0),
    coalesce(jsonb_agg(jsonb_build_object(
        'code', t.code, 'label', t.label, 'kind', t.kind,
        'valor', round(t.valor,2), 'fonte','caixa (saídas classificadas)',
        'sort', t.sort_order) order by t.sort_order)
      filter (where not t.barrado), '[]'::jsonb)
    into v_deducoes, v_custo_outros, v_desp_ledger, v_barrado, v_linhas_ledger
  from (
    select
      coalesce(a.code,       '6.9.99') as code,
      coalesce(a.label,      'Outras despesas') as label,
      coalesce(a.kind,       'DESPESA') as kind,
      coalesce(a.sort_order, 990) as sort_order,
      not coalesce(a.ledger_allowed, true) as barrado,
      sum(ft.amount) as valor
    from financial_transactions ft
    left join dre_category_map m on m.tenant_id = ft.tenant_id and m.category = ft.category
    left join dre_accounts a on a.code = coalesce(ft.account_code, m.account_code)
    WHERE ft.tenant_id = v_tenant AND ft.type = 'SAIDA'
      AND ft.category IS DISTINCT FROM 'teacher_payout'
      AND ft.refund_student_payment_id IS NULL
      AND to_char(COALESCE(ft.occurred_at, ft.created_at),'YYYY-MM') = v_month
    group by 1,2,3,4,5
  ) t;

  v_receita_liq := v_receita - v_deducoes;
  v_custo       := v_custo_aulas + v_custo_ajustes + v_custo_outros;
  v_lucro_bruto := v_receita_liq - v_custo;
  v_despesas    := v_desp_vendedor + v_desp_indicacao + v_desp_ledger;
  v_resultado   := v_lucro_bruto - v_despesas;

  with fixas as (
    select unnest(array[
      jsonb_build_object('code','3.1.01','label','Mensalidades',           'kind','RECEITA','valor',round(v_receita,2),        'fonte','student_payments recebidos',        'sort',110),
      jsonb_build_object('code','5.1.01','label','Repasse a professores',  'kind','CUSTO',  'valor',round(v_custo_aulas,2),    'fonte','v_payable_class_logs (competência)','sort',310),
      jsonb_build_object('code','5.1.02','label','Ajustes de fechamento',  'kind','CUSTO',  'valor',round(v_custo_ajustes,2),  'fonte','closing_adjustments',               'sort',320),
      jsonb_build_object('code','6.1.01','label','Comissões de vendedores','kind','DESPESA','valor',round(v_desp_vendedor,2),  'fonte','vendor_commissions pagas',          'sort',410),
      jsonb_build_object('code','6.1.02','label','Programa de indicações', 'kind','DESPESA','valor',round(v_desp_indicacao,2), 'fonte','referral_rewards pagas',            'sort',420)
    ]) as l
  ), ledger as (
    select e.value as l from jsonb_array_elements(v_linhas_ledger) e
  )
  select coalesce(jsonb_agg((t.l - 'sort') order by (t.l->>'sort')::int), '[]'::jsonb)
    into v_linhas
  from (select l from fixas union all select l from ledger) t;

  if v_nao_classificado > 0 then
    v_alertas := v_alertas || jsonb_build_object('nivel','atencao',
      'texto','Há R$ ' || translate(to_char(v_nao_classificado,'FM999,999,990.00'), ',.', '.,') ||
      ' recebidos e ainda sem classificação. Estão no caixa, mas fora da receita e do resultado deste DRE; não foram presumidos como mensalidade nem aporte.');
  end if;

  if v_desp_ledger = 0 and v_deducoes = 0 and v_custo_outros = 0 then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','critico',
      'texto','Nenhuma despesa operacional lançada no mês (ferramentas, internet, impostos, aluguel). O resultado abaixo está SUPERESTIMADO — ele desconta só o custo com professor.');
  end if;
  if v_barrado > 0 then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','atencao',
      'texto','R$ ' || translate(to_char(v_barrado,'FM999,999,990.00'), ',.', '.,') || ' em saídas do caixa foram lançadas em contas que já vêm por competência (repasse, ajustes, comissões, indicações). O valor foi IGNORADO no resultado para não contar duas vezes — reclassifique a categoria.');
  end if;
  if v_custo_aulas = 0 and v_receita > 0 then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','atencao',
      'texto','Houve receita mas nenhuma aula pagável lançada no mês. Verifique lançamentos pendentes de professor.');
  end if;
  if exists (select 1 from teacher_closings tc
              where tc.tenant_id = v_tenant and tc.month_year = v_month
                and tc.status <> 'PAGO') then
    v_alertas := v_alertas || jsonb_build_object(
      'nivel','info',
      'texto','O fechamento deste mês ainda não foi pago. O custo já está reconhecido aqui por competência, mas ainda não saiu do caixa.');
  end if;

  return jsonb_build_object(
    'month', v_month,
    'regime','competencia',
    'recebimentos_a_classificar', round(v_nao_classificado,2),
    'receita_bruta',   round(v_receita,2),
    'deducoes',        round(v_deducoes,2),
    'receita_liquida', round(v_receita_liq,2),
    'custo_servicos',  round(v_custo,2),
    'lucro_bruto',     round(v_lucro_bruto,2),
    'margem_bruta_pct', round(100 * v_lucro_bruto / nullif(v_receita_liq,0), 1),
    'despesas_operacionais', round(v_despesas,2),
    'resultado',       round(v_resultado,2),
    'margem_liquida_pct', round(100 * v_resultado / nullif(v_receita_liq,0), 1),
    'indicadores', jsonb_build_object(
      'aulas', v_aulas,
      'alunos_atendidos', v_alunos,
      'receita_por_aluno', round(v_receita / nullif(v_alunos,0), 2),
      'custo_por_aula', round((v_custo_aulas + v_custo_ajustes) / nullif(v_aulas,0), 2)
    ),
    'linhas', v_linhas,
    'alertas', v_alertas
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.balancete_professores(p_month text DEFAULT NULL::text, p_tenant text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_tenant text; v_month text; v_base numeric;
BEGIN
  v_tenant := coalesce(nullif(btrim(p_tenant),''),private.active_tenant_id(auth.uid()));
  if not private.prepayment_caller_can_read(v_tenant) then
    raise exception 'Sem permissão para consultar o relatório financeiro' using errcode='42501';
  end if;

  v_month := COALESCE(p_month, to_char(current_date,'YYYY-MM'));
  IF v_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Mês inválido (use YYYY-MM)'; END IF;

  SELECT rate INTO v_base FROM teacher_pay_tiers
   WHERE tenant_id = v_tenant AND min_students = 1;
  v_base := COALESCE(v_base, 0);

  RETURN (
  WITH aulas AS (
    SELECT v.id, v.teacher_id, v.student_id, v.rate_efetivo, v.rate_override, v.subtype
      FROM v_payable_class_logs v
      JOIN profiles t ON t.id = v.teacher_id
     WHERE to_char(v.class_date,'YYYY-MM') = v_month AND t.tenant_id = v_tenant
  ), classificado AS (
    SELECT a.*,
           CASE
             WHEN a.rate_override IS NOT NULL                           THEN 'ajuste'
             WHEN a.subtype = 'TREINAMENTO' AND a.rate_efetivo > v_base THEN 'treinamento'
             WHEN a.rate_efetivo > v_base                               THEN 'turbo'
             ELSE 'base'
           END AS motivo
      FROM aulas a
  ), aulas_aluno_prof AS (
    SELECT c.student_id, c.teacher_id, count(*)::int AS n
      FROM classificado c WHERE c.student_id IS NOT NULL
     GROUP BY 1,2
  ), aulas_aluno AS (
    SELECT ap.student_id, sum(ap.n) AS total FROM aulas_aluno_prof ap GROUP BY 1
  ), receita_aluno AS (
    SELECT sp.student_id, sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)) AS receita
      FROM student_payments sp
     WHERE sp.tenant_id = v_tenant
       AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
       AND to_char(COALESCE(sp.credited_at, sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
       AND sp.student_id IS NOT NULL
     GROUP BY 1
  ), rateio AS (
    SELECT ap.teacher_id, ap.student_id,
           ra.receita * ap.n / NULLIF(aa.total,0) AS receita
      FROM aulas_aluno_prof ap
      JOIN aulas_aluno   aa ON aa.student_id = ap.student_id
      JOIN receita_aluno ra ON ra.student_id = ap.student_id
  ), rateio_contratado AS (
    -- Mesmo rateio da faturada, para os dois números serem comparáveis.
    SELECT ap.teacher_id, ap.student_id,
           COALESCE(pf.monthly_fee,0) * ap.n / NULLIF(aa.total,0) AS receita
      FROM aulas_aluno_prof ap
      JOIN aulas_aluno aa ON aa.student_id = ap.student_id
      JOIN profiles    pf ON pf.id = ap.student_id
  ), por_aluno AS (
    SELECT c.teacher_id, c.student_id,
           max(COALESCE(sp.full_name,'Aluno não cadastrado')) AS student_name,
           count(*)::int                          AS aulas,
           sum(c.rate_efetivo)                    AS custo,
           count(*) FILTER (WHERE c.motivo = 'turbo')::int AS aulas_turbo,
           COALESCE(max(r.receita), 0)            AS receita,
           COALESCE(max(rc.receita), 0)           AS receita_contratada
      FROM classificado c
      LEFT JOIN profiles sp ON sp.id = c.student_id
      LEFT JOIN rateio   r  ON r.teacher_id = c.teacher_id AND r.student_id = c.student_id
      LEFT JOIN rateio_contratado rc ON rc.teacher_id = c.teacher_id AND rc.student_id = c.student_id
     WHERE c.student_id IS NOT NULL
     GROUP BY c.teacher_id, c.student_id
  ), ajustes AS (
    SELECT ca.teacher_id, sum(ca.amount) AS valor
      FROM closing_adjustments ca
     WHERE ca.tenant_id = v_tenant AND ca.month_year = v_month
     GROUP BY 1
  ), por_prof AS (
    SELECT c.teacher_id,
           count(*)::int                                              AS aulas,
           count(DISTINCT c.student_id) FILTER (WHERE c.student_id IS NOT NULL)::int AS alunos,
           (count(*) * v_base)                                        AS custo_base,
           sum(CASE WHEN c.motivo='turbo'       THEN c.rate_efetivo - v_base ELSE 0 END) AS comissao_turbo,
           sum(CASE WHEN c.motivo='treinamento' THEN c.rate_efetivo - v_base ELSE 0 END) AS bonus_treinamento,
           sum(CASE WHEN c.motivo='ajuste'      THEN c.rate_efetivo - v_base ELSE 0 END) AS ajuste_valor_base,
           count(*) FILTER (WHERE c.motivo='turbo')::int              AS aulas_turbo,
           count(*) FILTER (WHERE c.motivo='treinamento')::int        AS aulas_treinamento,
           count(*) FILTER (WHERE c.motivo='ajuste')::int             AS aulas_ajustadas,
           sum(c.rate_efetivo)                                        AS custo_aulas
      FROM classificado c
     GROUP BY c.teacher_id
  ), consolidado AS (
    SELECT p.*,
           COALESCE(aj.valor, 0)                          AS ajustes_fechamento,
           p.custo_aulas + COALESCE(aj.valor, 0)          AS custo_total,
           COALESCE((SELECT sum(r.receita) FROM rateio r WHERE r.teacher_id = p.teacher_id), 0) AS receita,
           COALESCE((SELECT sum(rc.receita) FROM rateio_contratado rc WHERE rc.teacher_id = p.teacher_id), 0) AS receita_contratada,
           trim(t.full_name)                              AS teacher_name
      FROM por_prof p
      JOIN profiles t   ON t.id = p.teacher_id
      LEFT JOIN ajustes aj ON aj.teacher_id = p.teacher_id
  )
  SELECT jsonb_build_object(
    'month', v_month,
    'base_rate', v_base,
    'recebimentos_a_classificar', round(private.unclassified_receipt_total(v_tenant,v_month),2),
    'como_ler',
      'Para COMPARAR PROFESSORES use lucro_contratado: ele mede o que o professor entregou, sem a interferência de a escola ter conseguido cobrar ou não. Para saber quanto SOBROU no mês use lucro (faturado) — é ele que fecha com o DRE e com o caixa. nao_faturado positivo = mensalidade que não foi cobrada (responsabilidade da secretaria, não do professor); nao_faturado NEGATIVO = o aluno pagou mais que a mensalidade no mês, quase sempre atrasado de mês anterior caindo agora.',
    'professores', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'teacher_id', k.teacher_id, 'teacher_name', k.teacher_name,
        'aulas', k.aulas, 'alunos', k.alunos,
        'custo_base',         round(k.custo_base,2),
        'comissao_turbo',     round(k.comissao_turbo,2),
        'bonus_treinamento',  round(k.bonus_treinamento,2),
        'ajuste_valor_base',  round(k.ajuste_valor_base,2),
        'ajustes_fechamento', round(k.ajustes_fechamento,2),
        'custo_total',        round(k.custo_total,2),
        'aulas_turbo', k.aulas_turbo, 'aulas_treinamento', k.aulas_treinamento,
        'aulas_ajustadas', k.aulas_ajustadas,
        'receita',            round(k.receita,2),
        'receita_contratada', round(k.receita_contratada,2),
        'nao_faturado',       round(k.receita_contratada - k.receita,2),
        'lucro',              round(k.receita - k.custo_total,2),
        'lucro_contratado',   round(k.receita_contratada - k.custo_total,2),
        'margem_pct',         round(100 * (k.receita - k.custo_total) / NULLIF(k.receita,0),1),
        'margem_contratada_pct', round(100 * (k.receita_contratada - k.custo_total) / NULLIF(k.receita_contratada,0),1),
        'custo_por_aula', round(k.custo_total / NULLIF(k.aulas,0),2),
        'alunos_detalhe', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'student_id', pa.student_id, 'student_name', pa.student_name,
                    'aulas', pa.aulas, 'aulas_turbo', pa.aulas_turbo,
                    'custo', round(pa.custo,2), 'receita', round(pa.receita,2),
                    'receita_contratada', round(pa.receita_contratada,2),
                    'nao_faturado', round(pa.receita_contratada - pa.receita,2),
                    'lucro', round(pa.receita - pa.custo,2))
                  ORDER BY pa.receita_contratada - pa.custo DESC)
             FROM por_aluno pa WHERE pa.teacher_id = k.teacher_id), '[]'::jsonb)
      ) ORDER BY k.receita_contratada - k.custo_total DESC)   -- ← ordena pelo justo
      FROM consolidado k), '[]'::jsonb),
    'totais', (SELECT jsonb_build_object(
        'aulas',              COALESCE(sum(k.aulas),0),
        'custo_base',         round(COALESCE(sum(k.custo_base),0),2),
        'comissao_turbo',     round(COALESCE(sum(k.comissao_turbo),0),2),
        'bonus_treinamento',  round(COALESCE(sum(k.bonus_treinamento),0),2),
        'ajuste_valor_base',  round(COALESCE(sum(k.ajuste_valor_base),0),2),
        'ajustes_fechamento', round(COALESCE(sum(k.ajustes_fechamento),0),2),
        'custo_total',        round(COALESCE(sum(k.custo_total),0),2),
        'receita_alocada',    round(COALESCE(sum(k.receita),0),2),
        'receita_contratada', round(COALESCE(sum(k.receita_contratada),0),2),
        'nao_faturado',       round(COALESCE(sum(k.receita_contratada),0) - COALESCE(sum(k.receita),0),2),
        'lucro',              round(COALESCE(sum(k.receita),0) - COALESCE(sum(k.custo_total),0),2),
        'lucro_contratado',   round(COALESCE(sum(k.receita_contratada),0) - COALESCE(sum(k.custo_total),0),2)
      ) FROM consolidado k),
    'receita_total', round((SELECT COALESCE(sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)),0) FROM student_payments sp
        WHERE sp.tenant_id = v_tenant AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
          AND NOT private.is_unclassified_operator_receipt(sp.payment_type,sp.student_id,sp.raw_payload)
          AND to_char(COALESCE(sp.credited_at, sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month),2),
    'receita_sem_aluno', round((SELECT COALESCE(sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)),0) FROM student_payments sp
        WHERE sp.tenant_id = v_tenant AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
          AND NOT private.is_unclassified_operator_receipt(sp.payment_type,sp.student_id,sp.raw_payload)
          AND to_char(COALESCE(sp.credited_at, sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
          AND sp.student_id IS NULL),2),
    'receita_aluno_sem_aula', round(
        (SELECT COALESCE(sum(greatest(round(coalesce(sp.value, 0) - coalesce(sp.refunded_amount, 0), 2), 0)),0) FROM student_payments sp
          WHERE sp.tenant_id = v_tenant AND sp.status IN ('RECEIVED','RECEIVED_IN_CASH')
          AND NOT private.is_unclassified_operator_receipt(sp.payment_type,sp.student_id,sp.raw_payload)
            AND to_char(COALESCE(sp.credited_at, sp.paid_at, sp.payment_date, sp.due_date),'YYYY-MM') = v_month
            AND sp.student_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM aulas_aluno aa WHERE aa.student_id = sp.student_id)),2),
    'alunos_multi_professor', (SELECT count(*)::int FROM (
        SELECT ap.student_id FROM aulas_aluno_prof ap
         GROUP BY ap.student_id HAVING count(DISTINCT ap.teacher_id) > 1) z)
  ));
END;
$function$;





-- Keep the legacy manual adjustment RPC compatible, but do not let it bypass
-- an in-flight withdrawal reservation.
create or replace function public.set_vendor_commission_status(
  p_commission_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
  v_tenant text;
  v_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_status, '')));
  v_commission public.vendor_commissions%rowtype;
begin
  select profile.role, profile.tenant_id
    into v_role, v_tenant
    from public.profiles as profile
   where profile.id = (select auth.uid());
  -- coalesce: papel nulo não pode passar pela guarda ("NULL not in" é NULL).
  if coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  if v_status not in ('PENDING', 'CONFIRMED', 'PAID', 'CANCELLED') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'status_invalido');
  end if;

  -- Mesma resposta para "não existe" e "não é sua": responder diferente
  -- contaria a um diretor quais ids existem na outra escola.
  select commission.* into v_commission
    from public.vendor_commissions as commission
   where commission.id = p_commission_id
     and (v_role = 'SUPER_ADMIN' or commission.tenant_id = v_tenant)
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;
  -- Comissão reservada num saque só muda pelo saque (aprovar, pagar, recusar).
  if v_commission.withdrawal_request_id is not null
     and v_status is distinct from v_commission.status
  then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'saque_em_andamento');
  end if;

  update public.vendor_commissions as commission
     set status = v_status,
         confirmed_at = case
           when v_status in ('CONFIRMED', 'PAID')
             then coalesce(commission.confirmed_at, pg_catalog.now())
           else commission.confirmed_at
         end,
         paid_at = case
           when v_status = 'PAID'
             then coalesce(commission.paid_at, pg_catalog.now())
           else commission.paid_at
         end
   where commission.id = p_commission_id;
  return pg_catalog.jsonb_build_object('ok', true);
end;
$function$;

alter function public.set_vendor_commission_status(uuid,text)
  owner to postgres;
revoke all on function public.set_vendor_commission_status(uuid,text)
  from public, anon;
grant execute on function public.set_vendor_commission_status(uuid,text)
  to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Modelo híbrido (decisão da direção, 25/09/2026): o afiliado NÃO gera link.
-- A indicação é identificada pelo cupom dele — que o aluno digita na página de
-- matrícula ou a escola põe no link manual (pelo cupom ou pelo nome, quando só
-- existe um afiliado com aquele nome). A comissão fica reservada quando o aluno
-- começa a matrícula e é liberada quando a PRIMEIRA mensalidade é liquidada na
-- Asaas (Pix na hora, boleto na compensação, cartão quando o valor cai na conta).
-- ─────────────────────────────────────────────────────────────────────────────

-- Uma indicação como o afiliado e a escola a enxergam: em que etapa está e o
-- que falta. A etapa é derivada — nunca gravada — para não divergir do dinheiro.
create or replace function private.affiliate_referral_view(p_commission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_commission public.vendor_commissions%rowtype;
  v_offer public.offers%rowtype;
  v_payment public.student_payments%rowtype;
  v_request public.vendor_withdrawal_requests%rowtype;
  v_activation text;
  v_name text;
  v_parts text[];
  v_payment_status text;
  v_stage text;
begin
  select commission.* into v_commission
    from public.vendor_commissions as commission
   where commission.id = p_commission_id;
  if not found then
    return null;
  end if;

  if v_commission.offer_id is not null then
    select offer.* into v_offer
      from public.offers as offer
     where offer.id = v_commission.offer_id;
  end if;

  -- A primeira mensalidade é a cobrança que ativa a assinatura. Oferta antiga
  -- não guarda esse id: vale a primeira cobrança não-taxa depois da matrícula.
  v_activation := nullif(coalesce(
    v_offer.metadata ->> 'subscription_activation_payment_id',
    v_offer.metadata ->> 'activation_payment_id'
  ), '');
  if v_commission.student_id is not null then
    select payment.* into v_payment
      from public.student_payments as payment
     where payment.student_id = v_commission.student_id
       and not private.payment_is_enrollment_fee(
         payment.payment_type,
         payment.description
       )
       and (
         payment.asaas_payment_id = v_activation
         or (
           pg_catalog.upper(coalesce(payment.status, ''))
             not in ('CANCELLED', 'DELETED', 'NAO_RECEITA')
           and payment.created_at >= coalesce(
             v_offer.processing_started_at,
             v_commission.created_at
           ) - interval '1 day'
         )
       )
     order by (payment.asaas_payment_id = v_activation) desc nulls last,
              payment.due_date nulls last,
              payment.created_at
     limit 1;
  end if;

  if v_commission.withdrawal_request_id is not null then
    select request.* into v_request
      from public.vendor_withdrawal_requests as request
     where request.id = v_commission.withdrawal_request_id;
  end if;

  v_payment_status := pg_catalog.upper(coalesce(v_payment.status, ''));
  v_stage := case
    when v_commission.status = 'PAID' then 'PAGA'
    when v_commission.status = 'CANCELLED' then 'CANCELADA'
    when v_commission.status = 'CONFIRMED' and v_request.id is not null
      then 'EM_SAQUE'
    when v_commission.status = 'CONFIRMED' then 'DISPONIVEL'
    when v_offer.revoked_at is not null then 'NAO_CONCLUIDA'
    -- Pago, mas o dinheiro ainda não caiu (cartão aprovado, ou o webhook de
    -- liquidação ainda processando): a comissão está a caminho.
    when v_payment_status in ('CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH')
      then 'EM_LIQUIDACAO'
    else 'AGUARDANDO_PAGAMENTO'
  end;

  select profile.full_name into v_name
    from public.profiles as profile
   where profile.id = v_commission.student_id;
  v_parts := pg_catalog.regexp_split_to_array(
    pg_catalog.btrim(coalesce(v_name, '')),
    '\s+'
  );

  return pg_catalog.jsonb_build_object(
    'id', v_commission.id,
    'stage', v_stage,
    'status', v_commission.status,
    'amount_cents', v_commission.amount_brl,
    -- O afiliado vê primeiro nome + inicial: ele sabe quem indicou, e a
    -- ficha completa do aluno é da escola.
    'student_display', case
      when coalesce(v_parts[1], '') = '' then 'Aluno'
      when pg_catalog.array_length(v_parts, 1) > 1 then
        v_parts[1] || ' ' || pg_catalog.left(
          v_parts[pg_catalog.array_length(v_parts, 1)], 1
        ) || '.'
      else v_parts[1]
    end,
    'referred_at', v_commission.created_at,
    'confirmed_at', v_commission.confirmed_at,
    'paid_at', v_commission.paid_at,
    'attribution', v_offer.metadata ->> 'affiliate_attribution',
    'coupon_code', v_offer.metadata ->> 'affiliate_coupon_code',
    'first_payment', case when v_payment.id is null then null else
      pg_catalog.jsonb_build_object(
        'billing_type', pg_catalog.upper(coalesce(
          nullif(v_payment.billing_type, ''),
          nullif(v_payment.payment_method, ''),
          'UNDEFINED'
        )),
        'status', v_payment_status,
        'due_date', v_payment.due_date,
        'paid_on', coalesce(
          v_payment.payment_date,
          (v_payment.paid_at at time zone 'America/Sao_Paulo')::date
        ),
        'estimated_credit_on',
          (v_payment.estimated_credit_at at time zone 'America/Sao_Paulo')::date,
        'credited_at', v_payment.credited_at
      )
    end,
    'withdrawal', case when v_request.id is null then null else
      pg_catalog.jsonb_build_object(
        'id', v_request.id,
        'status', v_request.status,
        'requested_at', v_request.requested_at
      )
    end
  );
end;
$function$;

alter function private.affiliate_referral_view(uuid) owner to postgres;
revoke all on function private.affiliate_referral_view(uuid)
  from public, anon, authenticated, service_role;

-- O painel do afiliado numa chamada só: cupom, PIX, indicações por etapa,
-- saldo e saques.
create or replace function public.get_my_affiliate_panel()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_profile public.profiles%rowtype;
  v_referrals jsonb;
  v_withdrawals jsonb;
begin
  select profile.* into v_profile
    from public.profiles as profile
   where profile.id = v_user_id
     and profile.role = 'SALESPERSON';
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  select coalesce(pg_catalog.jsonb_agg(
           private.affiliate_referral_view(commission.id)
           order by commission.created_at desc
         ), '[]'::jsonb)
    into v_referrals
    from public.vendor_commissions as commission
   where commission.vendor_id = v_user_id;

  select coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'id', request.id,
             'amount_cents', request.amount_brl,
             'commission_count', request.commission_count,
             'status', request.status,
             'requested_at', request.requested_at,
             'reviewed_at', request.reviewed_at,
             'paid_at', request.paid_at,
             'review_note', request.review_note
           ) order by request.requested_at desc
         ), '[]'::jsonb)
    into v_withdrawals
    from public.vendor_withdrawal_requests as request
   where request.vendor_id = v_user_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'affiliate', pg_catalog.jsonb_build_object(
      'full_name', v_profile.full_name,
      'affiliate_code', v_profile.affiliate_code,
      'commission_cents', v_profile.commission_rate,
      'active',
        pg_catalog.lower(coalesce(v_profile.lifecycle_status, 'active')) = 'active'
        and pg_catalog.lower(coalesce(v_profile.status, 'ativo')) not in (
          'inativo', 'inactive', 'suspended', 'offboarded'
        ),
      'pix_key', v_profile.pix_key,
      'pix_key_type', v_profile.pix_key_type,
      'school_name', (
        select tenant.name
          from public.tenants as tenant
         where tenant.id = v_profile.tenant_id
      )
    ),
    'totals', (
      select pg_catalog.jsonb_build_object(
        'referrals',
          pg_catalog.count(*) filter (where item ->> 'stage' <> 'CANCELADA'),
        'waiting_payment',
          pg_catalog.count(*) filter (where item ->> 'stage' = 'AGUARDANDO_PAGAMENTO'),
        'settling',
          pg_catalog.count(*) filter (where item ->> 'stage' = 'EM_LIQUIDACAO'),
        'released',
          pg_catalog.count(*) filter (
            where item ->> 'stage' in ('DISPONIVEL', 'EM_SAQUE', 'PAGA')
          ),
        'pending_cents', coalesce(pg_catalog.sum((item ->> 'amount_cents')::integer)
          filter (where item ->> 'stage' in ('AGUARDANDO_PAGAMENTO', 'EM_LIQUIDACAO')), 0),
        'available_cents', coalesce(pg_catalog.sum((item ->> 'amount_cents')::integer)
          filter (where item ->> 'stage' = 'DISPONIVEL'), 0),
        'requested_cents', coalesce(pg_catalog.sum((item ->> 'amount_cents')::integer)
          filter (where item ->> 'stage' = 'EM_SAQUE'), 0),
        'paid_cents', coalesce(pg_catalog.sum((item ->> 'amount_cents')::integer)
          filter (where item ->> 'stage' = 'PAGA'), 0)
      )
      from pg_catalog.jsonb_array_elements(v_referrals) as element(item)
    ),
    'referrals', v_referrals,
    'withdrawals', v_withdrawals
  );
end;
$function$;

alter function public.get_my_affiliate_panel() owner to postgres;
revoke all on function public.get_my_affiliate_panel() from public, anon;
grant execute on function public.get_my_affiliate_panel()
  to authenticated, service_role;

-- O afiliado cadastra a própria chave PIX no painel. O "Meu Perfil" só mostra
-- dados de recebimento para professor — sem esta porta o saque ficava travado
-- em PIX_REQUIRED para sempre.
create or replace function public.set_my_affiliate_pix(
  p_pix_key text,
  p_pix_key_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_type text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_pix_key_type, '')));
  v_raw text := pg_catalog.btrim(coalesce(p_pix_key, ''));
  v_digits text := pg_catalog.regexp_replace(
    pg_catalog.btrim(coalesce(p_pix_key, '')), '\D', '', 'g'
  );
  v_key text;
begin
  if not exists (
    select 1
      from public.profiles as profile
     where profile.id = v_user_id
       and profile.role = 'SALESPERSON'
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  v_key := case v_type
    when 'CPF' then
      case when pg_catalog.length(v_digits) = 11 then v_digits end
    when 'CNPJ' then
      case when pg_catalog.length(v_digits) = 14 then v_digits end
    when 'PHONE' then
      case
        when pg_catalog.length(v_digits) in (10, 11) then '+55' || v_digits
        when pg_catalog.length(v_digits) in (12, 13)
             and pg_catalog.left(v_digits, 2) = '55' then '+' || v_digits
      end
    when 'EMAIL' then
      case
        when pg_catalog.length(v_raw) <= 254
             and pg_catalog.lower(v_raw) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
          then pg_catalog.lower(v_raw)
      end
    when 'EVP' then
      case
        when pg_catalog.lower(v_raw)
             ~ '^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$'
          then pg_catalog.lower(v_raw)
      end
  end;
  if v_key is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'INVALID_PIX');
  end if;

  update public.profiles as profile
     set pix_key = v_key,
         pix_key_type = v_type::public.pix_key_type
   where profile.id = v_user_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'pix_key', v_key,
    'pix_key_type', v_type
  );
end;
$function$;

alter function public.set_my_affiliate_pix(text,text) owner to postgres;
revoke all on function public.set_my_affiliate_pix(text,text) from public, anon;
grant execute on function public.set_my_affiliate_pix(text,text)
  to authenticated, service_role;

-- A escola identifica o afiliado pelo cupom OU pelo nome dito na conversa
-- ("foi a Gabriela que indicou"). Cupom exato vem primeiro; com dois ou mais
-- nomes parecidos, quem gera o link escolhe pelo cupom.
create or replace function public.find_affiliates(
  p_query text,
  p_tenant_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := public._my_role();
  v_tenant text := public._my_tenant_id();
  v_query text := pg_catalog.btrim(coalesce(p_query, ''));
  v_code text := private.normalize_affiliate_code(p_query);
  v_pattern text;
begin
  if coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') then
    return '[]'::jsonb;
  end if;
  if v_role = 'SUPER_ADMIN'
     and nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '') is not null
  then
    v_tenant := pg_catalog.btrim(p_tenant_id);
  end if;
  if v_tenant is null or pg_catalog.length(v_query) < 2 then
    return '[]'::jsonb;
  end if;

  v_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    public.fold_accents(v_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return coalesce((
    select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'vendor_id', found.id,
               'full_name', found.full_name,
               'affiliate_code', found.affiliate_code,
               'commission_cents', found.commission_rate,
               'match', found.match_kind
             ) order by found.match_rank, found.full_name
           )
      from (
        select profile.id,
               profile.full_name,
               profile.affiliate_code,
               profile.commission_rate,
               case
                 when pg_catalog.lower(profile.affiliate_code) = pg_catalog.lower(v_code)
                   then 'CODE'
                 else 'NAME'
               end as match_kind,
               case
                 when pg_catalog.lower(profile.affiliate_code) = pg_catalog.lower(v_code)
                   then 0
                 else 1
               end as match_rank
          from public.profiles as profile
         where profile.tenant_id = v_tenant
           and profile.role = 'SALESPERSON'
           and profile.affiliate_code is not null
           and pg_catalog.lower(coalesce(profile.lifecycle_status, 'active')) = 'active'
           and pg_catalog.lower(coalesce(profile.status, 'ativo')) not in (
             'inativo', 'inactive', 'suspended', 'offboarded'
           )
           and (
             (v_code <> ''
              and pg_catalog.lower(profile.affiliate_code) = pg_catalog.lower(v_code))
             or public.fold_accents(profile.full_name) like v_pattern
           )
         order by match_rank, profile.full_name
         limit 10
      ) as found
  ), '[]'::jsonb);
end;
$function$;

alter function public.find_affiliates(text,text) owner to postgres;
revoke all on function public.find_affiliates(text,text) from public, anon;
grant execute on function public.find_affiliates(text,text) to authenticated;

-- Convite com o cupom já escolhido ("AFILIADA10"). Papel, escola ativa e
-- comissão continuam validados pela porta de sempre (create_invite_offer);
-- aqui entra só o cupom, reservado até o convite ser usado ou vencer.
create or replace function public.create_affiliate_invite(
  p_commission_cents integer,
  p_suggested_name text,
  p_affiliate_code text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_code text := private.normalize_affiliate_code(p_affiliate_code);
  v_name text := nullif(pg_catalog.btrim(coalesce(p_suggested_name, '')), '');
  v_offer_id uuid;
  v_tenant_id text;
begin
  if v_code <> '' and v_code !~ '^[A-Z0-9][A-Z0-9_-]{3,31}$' then
    raise exception 'invalid_affiliate_code' using errcode = '22023';
  end if;

  v_offer_id := public.create_invite_offer(
    'VENDOR_INVITE',
    pg_catalog.jsonb_build_object(
      'commissionRate', p_commission_cents,
      'suggestedName', v_name
    )
  );

  select offer.tenant_id into v_tenant_id
    from public.offers as offer
   where offer.id = v_offer_id;

  if v_code <> '' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'affiliate-code:' || v_tenant_id || ':' || pg_catalog.lower(v_code), 0
    ));
    if exists (
      select 1
        from public.profiles as profile
       where profile.tenant_id = v_tenant_id
         and profile.role = 'SALESPERSON'
         and pg_catalog.lower(profile.affiliate_code) = pg_catalog.lower(v_code)
    ) or exists (
      select 1
        from public.offers as invite
       where invite.tenant_id = v_tenant_id
         and invite.kind = 'VENDOR_INVITE'
         and invite.id <> v_offer_id
         and invite.consumed_at is null
         and invite.revoked_at is null
         and invite.expires_at > pg_catalog.now()
         and pg_catalog.lower(coalesce(invite.payload ->> 'affiliateCode', ''))
           = pg_catalog.lower(v_code)
    ) then
      raise exception 'affiliate_code_in_use' using errcode = '23505';
    end if;
  end if;

  update public.offers as offer
     set payload = offer.payload || pg_catalog.jsonb_build_object(
           'affiliateCode', nullif(v_code, ''),
           'schoolName', (
             select tenant.name
               from public.tenants as tenant
              where tenant.id = v_tenant_id
           )
         )
   where offer.id = v_offer_id;

  return v_offer_id;
end;
$function$;

alter function public.create_affiliate_invite(integer,text,text) owner to postgres;
revoke all on function public.create_affiliate_invite(integer,text,text)
  from public, anon;
grant execute on function public.create_affiliate_invite(integer,text,text)
  to authenticated;

-- Link manual de matrícula com cupom. Porta PRÓPRIA, ao lado da cadeia de
-- create_enrollment_offer — não dentro dela: as auditorias
-- (crm_trial_conversion_hardening, harden_trial_offer_authority_and_idempotency,
-- enrollment_without_trial_feedback) leem o texto-fonte de cada camada da cadeia,
-- e uma camada nova no meio quebraria todas. Esta porta chama a porta pública
-- (com todas as travas dela, como quem chamou) e aplica o benefício da indicação
-- no MESMO commit: cupom inválido desfaz o link inteiro.
create or replace function public.create_enrollment_offer_with_affiliate(
  p_payload jsonb,
  p_affiliate_code text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_code text := private.normalize_affiliate_code(p_affiliate_code);
  v_offer_id uuid;
  v_tenant_id text;
  v_vendor_id uuid;
  v_result jsonb;
begin
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{3,31}$' then
    raise exception 'cupom de afiliado invalido' using errcode = '22023';
  end if;

  v_offer_id := public.create_enrollment_offer(p_payload);

  select offer.tenant_id into v_tenant_id
    from public.offers as offer
   where offer.id = v_offer_id;

  v_vendor_id := private.active_affiliate_by_code(v_tenant_id, v_code);
  if v_vendor_id is null then
    raise exception 'cupom de afiliado invalido' using errcode = '22023';
  end if;

  v_result := private.grant_affiliate_benefit(v_offer_id, v_vendor_id, 'COUPON_STAFF');
  if coalesce((v_result ->> 'ok')::boolean, false) is false then
    raise exception 'cupom de afiliado nao se aplica a esta matricula: %',
      coalesce(v_result ->> 'error', 'OFFER_NOT_ELIGIBLE')
      using errcode = '22023';
  end if;

  return v_offer_id;
end;
$function$;

alter function public.create_enrollment_offer_with_affiliate(jsonb,text)
  owner to postgres;
revoke all on function public.create_enrollment_offer_with_affiliate(jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_enrollment_offer_with_affiliate(jsonb,text)
  to authenticated;

-- Afiliado não cria oferta de matrícula: a indicação dele é o cupom, e a porta
-- aceitava a mensalidade que ele quisesse. A trava fica na tabela — vale para
-- qualquer caminho — e só pega quem chama como SALESPERSON (service role e a
-- escola seguem livres).
create or replace function private.block_salesperson_enrollment_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.kind = 'ENROLLMENT'
     and coalesce(public._my_role(), '') = 'SALESPERSON'
  then
    raise exception 'forbidden: afiliado nao gera link de matricula'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

alter function private.block_salesperson_enrollment_offer() owner to postgres;
revoke all on function private.block_salesperson_enrollment_offer()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_block_salesperson_enrollment_offer on public.offers;
create trigger trg_block_salesperson_enrollment_offer
before insert on public.offers
for each row execute function private.block_salesperson_enrollment_offer();

-- Ficha do afiliado para a direção: mesma forma de antes, agora com o cupom e
-- a etapa de cada indicação (aguardando pagamento, em liquidação, liberada…).
create or replace function public.get_vendor_overview(p_vendor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor public.profiles%rowtype;
  v_vendor public.profiles%rowtype;
begin
  select profile.* into v_actor
    from public.profiles as profile
   where profile.id = (select auth.uid());
  if not found or coalesce(v_actor.role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    return pg_catalog.jsonb_build_object('error', 'sem_permissao');
  end if;

  select profile.* into v_vendor
    from public.profiles as profile
   where profile.id = p_vendor_id
     and profile.role = 'SALESPERSON';
  if not found then
    return pg_catalog.jsonb_build_object('error', 'nao_encontrado');
  end if;
  if v_actor.role = 'SCHOOL_ADMIN'
     and v_vendor.tenant_id is distinct from v_actor.tenant_id
  then
    return pg_catalog.jsonb_build_object('error', 'sem_permissao');
  end if;

  return pg_catalog.jsonb_build_object(
    'profile', pg_catalog.jsonb_build_object(
      'id', v_vendor.id,
      'full_name', v_vendor.full_name,
      'avatar_url', v_vendor.avatar_url,
      'email', v_vendor.email,
      'phone', v_vendor.phone,
      'status', v_vendor.status,
      'commission_rate', v_vendor.commission_rate,
      'affiliate_code', v_vendor.affiliate_code,
      'pix_ok', nullif(pg_catalog.btrim(coalesce(v_vendor.pix_key, '')), '') is not null,
      'pix_key', v_vendor.pix_key,
      'pix_key_type', v_vendor.pix_key_type
    ),
    'commissions', coalesce((
      select pg_catalog.jsonb_agg(
               private.affiliate_referral_view(commission.id)
                 || pg_catalog.jsonb_build_object(
                      'amount', commission.amount_brl,
                      'created_at', commission.created_at,
                      'student', (
                        select student.full_name
                          from public.profiles as student
                         where student.id = commission.student_id
                      )
                    )
               order by commission.created_at desc
             )
        from public.vendor_commissions as commission
       where commission.vendor_id = p_vendor_id
    ), '[]'::jsonb),
    'audit', coalesce((
      select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'field', entry.field,
                 'old_value', entry.old_value,
                 'new_value', entry.new_value,
                 'changed_at', entry.changed_at,
                 'changed_by', (
                   select author.full_name
                     from public.profiles as author
                    where author.id = entry.changed_by
                 )
               ) order by entry.changed_at desc
             )
        from (
          select audit.*
            from public.profile_audit_log as audit
           where audit.profile_id = p_vendor_id
           order by audit.changed_at desc
           limit 20
        ) as entry
    ), '[]'::jsonb)
  );
end;
$function$;

alter function public.get_vendor_overview(uuid) owner to postgres;
revoke all on function public.get_vendor_overview(uuid) from public, anon;
grant execute on function public.get_vendor_overview(uuid)
  to authenticated, service_role;

-- A lista da direção formatava centavos como reais no alerta ("A pagar: R$
-- 4,900.00" para R$ 49). Mesma função do ar, só o alerta convertido.
CREATE OR REPLACE FUNCTION public.list_vendors_overview()
 RETURNS TABLE(vendor_id uuid, full_name text, avatar_url text, status text, commission_rate numeric, pix_ok boolean, matriculas integer, revenue_brought numeric, pending_count integer, pending_amount numeric, confirmed_unpaid numeric, paid_amount numeric, last_sale timestamp with time zone, alert_level text, alert_reasons text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id=v_uid;
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN RETURN; END IF;
  RETURN QUERY
  WITH v AS (SELECT * FROM profiles WHERE role='SALESPERSON' AND (v_role='SUPER_ADMIN' OR tenant_id=v_tenant)),
  c AS (
    SELECT vc.vendor_id AS vid, count(DISTINCT vc.student_id) AS matriculas, coalesce(sum(vc.amount_brl),0) AS revenue,
      count(*) FILTER (WHERE vc.status='PENDING') AS pend_c,
      coalesce(sum(vc.amount_brl) FILTER (WHERE vc.status='PENDING'),0) AS pend_a,
      coalesce(sum(vc.amount_brl) FILTER (WHERE vc.status='CONFIRMED'),0) AS conf_unpaid,
      coalesce(sum(vc.amount_brl) FILTER (WHERE vc.status='PAID'),0) AS paid_a, max(vc.created_at) AS last_sale
    FROM vendor_commissions vc WHERE vc.vendor_id IN (SELECT id FROM v) GROUP BY vc.vendor_id
  ),
  base AS (
    SELECT v.id, v.full_name, v.avatar_url, v.status, v.commission_rate,
      (v.pix_key IS NOT NULL AND v.pix_key<>'') AS pix_ok,
      coalesce(c.matriculas,0) AS matriculas, coalesce(c.revenue,0) AS revenue,
      coalesce(c.pend_c,0) AS pend_c, coalesce(c.pend_a,0) AS pend_a, coalesce(c.conf_unpaid,0) AS conf_unpaid, coalesce(c.paid_a,0) AS paid_a, c.last_sale
    FROM v LEFT JOIN c ON c.vid=v.id
  )
  SELECT b.id, b.full_name, b.avatar_url, b.status, b.commission_rate::numeric, b.pix_ok,
    b.matriculas::int, b.revenue::numeric, b.pend_c::int, b.pend_a::numeric, b.conf_unpaid::numeric, b.paid_a::numeric, b.last_sale,
    CASE WHEN b.conf_unpaid>0 AND NOT b.pix_ok THEN 'HIGH' WHEN b.conf_unpaid>0 OR NOT b.pix_ok THEN 'MEDIUM' ELSE 'LOW' END,
    array_remove(ARRAY[
      CASE WHEN b.conf_unpaid>0 THEN 'A pagar: R$ '||to_char(b.conf_unpaid / 100.0,'FM999G990D00') END,
      CASE WHEN NOT b.pix_ok THEN 'PIX não cadastrado' END,
      CASE WHEN b.matriculas>0 AND b.last_sale < now()-interval '30 days' THEN 'Sem vendas há 30+ dias' END
    ], NULL)
  FROM base b ORDER BY b.conf_unpaid DESC, b.revenue DESC, b.full_name;
END;
$function$;

alter function public.list_vendors_overview() owner to postgres;

comment on column public.profiles.affiliate_code is
  'Codigo compartilhavel do afiliado; a validacao sempre e vinculada ao tenant da oferta.';
comment on table public.vendor_withdrawal_requests is
  'Solicitacoes de saque que reservam comissoes CONFIRMED ate aprovacao, pagamento ou rejeicao.';
comment on function public.apply_affiliate_coupon(uuid,text) is
  'Aplica cupom antes do claim, zera apenas a taxa de matricula e congela a comissao por oferta.';

comment on function public.create_enrollment_offer_with_affiliate(jsonb,text) is
  'Link manual de matricula com cupom de afiliado: cria pela porta publica e aplica o beneficio no mesmo commit.';
comment on function public.find_affiliates(text,text) is
  'Busca afiliado ativo da escola pelo cupom exato ou pelo nome (sem acento).';
comment on function public.get_my_affiliate_panel() is
  'Painel do afiliado: cupom, PIX, indicacoes por etapa, saldo e saques.';

commit;
