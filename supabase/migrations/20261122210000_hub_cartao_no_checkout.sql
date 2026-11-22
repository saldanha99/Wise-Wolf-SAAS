-- Cartão no checkout do Hub e do Wolfie (decisão do Vinícius, 22/11/2026).
--
-- 1) Anual do Wolfie: 2 meses grátis, só à vista (PIX ou cartão em 1x), aprovado pelo Chefe de
--    Gabinete em 22/11/2026 (msg 12b1a60a): Foco R$ 499, Ritmo R$ 999, Performance R$ 1.799.
-- 2) Controle de tentativas de cartão (anti "card testing") para a edge function
--    hub-card-payment, que é a ÚNICA que recebe dados de cartão. Aqui não entra
--    número, validade nem CVV: só os 4 últimos dígitos e a bandeira devolvidos pelo
--    Asaas depois da tentativa, e o IP do comprador em hash (sha256 com sal na edge).
--    Tetos: por conta 5 tentativas/hora e 10/dia; por IP 8/hora; por cobrança 3 recusas.
-- Tudo aditivo e re-executável. Só service_role.

update public.hub_plans
   set price_yearly = v.yearly, updated_at = pg_catalog.now()
  from (values ('WOLFIE_FOCO', 499.00::numeric), ('WOLFIE_RITMO', 999.00), ('WOLFIE_PERFORMANCE', 1799.00)) as v(code, yearly)
 where hub_plans.code = v.code
   and hub_plans.price_yearly is distinct from v.yearly;

create table if not exists public.hub_card_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  checkout_id uuid not null references public.hub_checkout_sessions(id) on delete cascade,
  user_id uuid not null,
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  outcome text not null default 'STARTED'
    check (outcome in ('STARTED', 'APPROVED', 'DECLINED', 'ERROR', 'BLOCKED')),
  reason text check (reason is null or pg_catalog.length(reason) <= 80),
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_brand text check (card_brand is null or card_brand ~ '^[A-Z_]{2,20}$'),
  created_at timestamptz not null default pg_catalog.now(),
  finished_at timestamptz
);

create index if not exists hub_card_payment_attempts_user_idx on public.hub_card_payment_attempts (user_id, created_at desc);
create index if not exists hub_card_payment_attempts_ip_idx on public.hub_card_payment_attempts (ip_hash, created_at desc);
create index if not exists hub_card_payment_attempts_checkout_idx on public.hub_card_payment_attempts (checkout_id, created_at desc);

alter table public.hub_card_payment_attempts enable row level security;
revoke all on public.hub_card_payment_attempts from public, anon, authenticated;
grant select, insert, update on public.hub_card_payment_attempts to service_role;

-- Porta de entrada: confere os tetos e já reserva a tentativa (STARTED) na mesma transação.
create or replace function public.hub_card_payment_gate(p_checkout uuid, p_user uuid, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_id uuid;
  v_user_hour integer;
  v_user_day integer;
  v_ip_hour integer;
  v_declines integer;
  v_open integer;
  v_approved integer;
  v_unknown integer;
begin
  if p_checkout is null or p_user is null or coalesce(p_ip_hash, '') !~ '^[a-f0-9]{64}$' then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'invalid');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hub-card:' || p_user::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hub-card-ip:' || p_ip_hash, 0));

  select count(*) filter (where created_at > pg_catalog.now() - interval '1 hour'),
         count(*) filter (where created_at > pg_catalog.now() - interval '1 day')
    into v_user_hour, v_user_day
    from public.hub_card_payment_attempts where user_id = p_user and created_at > pg_catalog.now() - interval '1 day';
  select count(*) into v_ip_hour from public.hub_card_payment_attempts
   where ip_hash = p_ip_hash and created_at > pg_catalog.now() - interval '1 hour';
  select count(*) filter (where outcome = 'DECLINED'),
         count(*) filter (where outcome = 'STARTED' and created_at > pg_catalog.now() - interval '2 minutes'),
         count(*) filter (where outcome = 'APPROVED'),
         count(*) filter (where outcome = 'ERROR' and reason = 'provider_no_response'
                            and coalesce(finished_at, created_at) > pg_catalog.now() - interval '60 seconds')
    into v_declines, v_open, v_approved, v_unknown
    from public.hub_card_payment_attempts where checkout_id = p_checkout;

  -- Aprovado nesta cobrança: nada de 2ª tentativa enquanto o webhook não marca PAID.
  if v_approved > 0 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'already_approved');
  end if;
  -- O Asaas não respondeu há menos de 60 s: pode estar processando; segura nova tentativa.
  if v_open > 0 or v_unknown > 0 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'in_progress');
  end if;
  if v_declines >= 3 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'checkout_declines');
  end if;
  if v_user_hour >= 5 or v_user_day >= 10 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'user_rate');
  end if;
  if v_ip_hour >= 8 then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'ip_rate');
  end if;

  insert into public.hub_card_payment_attempts (checkout_id, user_id, ip_hash)
  values (p_checkout, p_user, p_ip_hash)
  returning id into v_id;
  return pg_catalog.jsonb_build_object('allowed', true, 'attempt_id', v_id);
end;
$$;

create or replace function public.hub_card_payment_finish(
  p_attempt uuid, p_outcome text, p_reason text default null, p_last4 text default null, p_brand text default null)
returns void
language sql
security definer
set search_path to ''
as $$
  update public.hub_card_payment_attempts
     set outcome = p_outcome,
         reason = pg_catalog.left(p_reason, 80),
         card_last4 = case when p_last4 ~ '^[0-9]{4}$' then p_last4 end,
         card_brand = case when pg_catalog.upper(p_brand) ~ '^[A-Z_]{2,20}$' then pg_catalog.upper(p_brand) end,
         finished_at = pg_catalog.now()
   where id = p_attempt and outcome = 'STARTED'
     and p_outcome in ('APPROVED', 'DECLINED', 'ERROR', 'BLOCKED');
$$;

revoke all on function public.hub_card_payment_gate(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.hub_card_payment_finish(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.hub_card_payment_gate(uuid, uuid, text) to service_role;
grant execute on function public.hub_card_payment_finish(uuid, text, text, text, text) to service_role;
