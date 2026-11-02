-- Uma pessoa pode ser aluna e afiliada sem perder o portal acadêmico. O vínculo
-- é explícito e privado: telefone/nome iguais nunca concedem acesso por si só.
create table if not exists private.affiliate_identity_links (
  student_user_id uuid primary key references public.profiles(id) on delete restrict,
  affiliate_user_id uuid not null unique references public.profiles(id) on delete restrict,
  tenant_id text not null references public.tenants(id) on delete restrict,
  approved_at timestamptz not null default pg_catalog.now(),
  approval_note text not null
);

revoke all on private.affiliate_identity_links from public, anon, authenticated, service_role;

create or replace function private.my_affiliate_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select affiliate.id
    from public.profiles as caller
    left join private.affiliate_identity_links as link
      on link.student_user_id = caller.id
     and link.tenant_id = caller.tenant_id
     and caller.role = 'STUDENT'
    join public.profiles as affiliate
      on affiliate.id = case
           when caller.role = 'SALESPERSON' then caller.id
           else link.affiliate_user_id
         end
     and affiliate.role = 'SALESPERSON'
     and affiliate.tenant_id = caller.tenant_id
   where caller.id = (select auth.uid())
     and caller.role in ('SALESPERSON', 'STUDENT');
$function$;

alter function private.my_affiliate_user_id() owner to postgres;
revoke all on function private.my_affiliate_user_id() from public, anon, authenticated, service_role;

-- A Direção confirmou em 30/09/2026 que estas duas contas são da mesma pessoa.
-- Esta inserção não roda em ambientes sem as duas contas e só aceita o mesmo
-- tenant/telefone; uma conta diferente não ganha acesso por coincidência de nome.
insert into private.affiliate_identity_links (
  student_user_id, affiliate_user_id, tenant_id, approval_note
)
select student.id, affiliate.id, student.tenant_id,
       'Direção confirmou identidade e login único em 2026-09-30'
  from public.profiles as student
  join public.profiles as affiliate
    on affiliate.id = '146bb14c-fe88-4011-9a20-79791874bfe3'::uuid
   and affiliate.role = 'SALESPERSON'
   and affiliate.tenant_id = student.tenant_id
 where student.id = 'a908688f-b0cb-42cc-ad01-72fd3711bc0f'::uuid
   and student.role = 'STUDENT'
   and nullif(pg_catalog.regexp_replace(coalesce(student.phone, ''), '[^0-9]', '', 'g'), '')
       = nullif(pg_catalog.regexp_replace(coalesce(affiliate.phone, ''), '[^0-9]', '', 'g'), '')
on conflict (student_user_id) do nothing;

create or replace function public.get_my_affiliate_panel()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := private.my_affiliate_user_id();
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
grant execute on function public.get_my_affiliate_panel() to authenticated, service_role;

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
  v_user_id uuid := private.my_affiliate_user_id();
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

create or replace function public.request_vendor_withdrawal()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := private.my_affiliate_user_id();
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
revoke all on function public.request_vendor_withdrawal() from public, anon;
grant execute on function public.request_vendor_withdrawal()
  to authenticated, service_role;
