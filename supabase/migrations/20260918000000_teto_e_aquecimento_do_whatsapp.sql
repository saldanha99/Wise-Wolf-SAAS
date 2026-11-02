-- ─────────────────────────────────────────────────────────────────────────────
-- TETO E AQUECIMENTO DO WHATSAPP (direção, 17/09/2026)
--
-- O número da escola foi RESTRINGIDO pelo WhatsApp por 21 h às 14:15 depois de
-- ~130 mensagens automáticas em 7 h (pico de 37 numa hora), boa parte para
-- contato frio. Aqui nasce a régua que todo envio automático consulta ANTES do
-- POST (via `_shared/evolution-send.ts`): por instância, por tipo de contato,
-- com espaçamento aleatório e aquecimento gradual depois de uma restrição.
--
-- Tipos, decididos pelo destino (o chamador não escolhe):
--   group          grupo (@g.us) — sem espaçamento
--   reply          quem escreveu para o número nas últimas 72 h — sem espaçamento
--   staff          professor/direção/coordenação (perfil da equipe) — sem espaçamento
--   transactional  aluno/responsável conhecido (perfil) — espaçado
--   outreach       todo o resto (lead frio, follow-up) — espaçado e teto baixo
-- Migration re-executável.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.whatsapp_outbound_policy (
  instance_name text primary key,
  tenant_id text,
  enabled boolean not null default true,
  outreach_hourly int not null default 10,
  outreach_daily int not null default 50,
  transactional_hourly int not null default 30,
  transactional_daily int not null default 150,
  staff_hourly int not null default 60,
  reply_hourly int not null default 80,
  group_hourly int not null default 60,
  total_hourly int not null default 45,
  total_daily int not null default 200,
  outreach_gap_min_seconds int not null default 60,
  outreach_gap_max_seconds int not null default 120,
  transactional_gap_min_seconds int not null default 20,
  transactional_gap_max_seconds int not null default 40,
  -- Aquecimento: dia 0 depois da volta = 40 % dos tetos, dia 1 = 70 %, depois 100 %.
  warmup_started_at timestamptz,
  notes text,
  updated_at timestamptz not null default now()
);
alter table public.whatsapp_outbound_policy enable row level security;
alter table public.whatsapp_outbound_policy owner to postgres;

create table if not exists public.whatsapp_outbound_ledger (
  id uuid primary key default gen_random_uuid(),
  instance_name text not null,
  destination text not null,
  kind text not null,
  slot_at timestamptz not null default now(),
  reserved_at timestamptz not null default now(),
  delivered boolean,
  created_at timestamptz not null default now()
);
create index if not exists idx_wa_outbound_ledger_instance_slot on public.whatsapp_outbound_ledger (instance_name, slot_at desc);
alter table public.whatsapp_outbound_ledger enable row level security;
alter table public.whatsapp_outbound_ledger owner to postgres;
create index if not exists idx_ai_wa_messages_created on public.ai_wa_messages (created_at desc);

-- Tipo do destino: decidido aqui, pelo que o banco sabe da pessoa.
create or replace function private.whatsapp_outbound_kind(p_destination text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_digits text := pg_catalog.regexp_replace(coalesce(p_destination, ''), '\D', '', 'g');
  v_tail text;
begin
  if p_destination like '%@g.us' then return 'group'; end if;
  if length(v_digits) < 8 then return 'outreach'; end if;
  v_tail := right(v_digits, 8);
  if exists (
       select 1 from public.ai_wa_messages m
        where m.direction = 'in' and m.created_at > pg_catalog.now() - interval '72 hours'
          and right(pg_catalog.regexp_replace(coalesce(m.phone, ''), '\D', '', 'g'), 8) = v_tail)
     or exists (
       select 1 from public.whatsapp_messages wm
         join public.whatsapp_conversations c on c.id = wm.conversation_id
        where wm.direction = 'in' and wm.occurred_at > pg_catalog.now() - interval '72 hours'
          and right(pg_catalog.regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 8) = v_tail)
  then return 'reply'; end if;
  if exists (
       select 1 from public.profiles p
        where upper(coalesce(p.role, '')) in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'SALESPERSON', 'SUPER_ADMIN')
          and (right(pg_catalog.regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 8) = v_tail
            or right(pg_catalog.regexp_replace(coalesce(p.attendance_phone, ''), '\D', '', 'g'), 8) = v_tail))
  then return 'staff'; end if;
  if exists (
       select 1 from public.profiles p
        where right(pg_catalog.regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 8) = v_tail
           or right(pg_catalog.regexp_replace(coalesce(p.attendance_phone, ''), '\D', '', 'g'), 8) = v_tail
           or right(pg_catalog.regexp_replace(coalesce(p.guardian_phone, ''), '\D', '', 'g'), 8) = v_tail)
  then return 'transactional'; end if;
  return 'outreach';
end $$;

-- Fator do aquecimento: 0,4 no dia da volta, 0,7 no seguinte, 1 depois.
create or replace function private.whatsapp_warmup_factor(p_started timestamptz)
returns numeric language sql stable set search_path = '' as $$
  select case
    when p_started is null then 1.0
    when pg_catalog.now() < p_started + interval '1 day' then 0.4
    when pg_catalog.now() < p_started + interval '2 days' then 0.7
    else 1.0 end;
$$;

-- A pergunta que todo envio faz: posso mandar agora? (p_reserve=false só espia)
create or replace function public.whatsapp_outbound_permit(p_instance text, p_destination text, p_reserve boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  pol public.whatsapp_outbound_policy%rowtype;
  v_kind text;
  v_factor numeric;
  v_hour_start timestamptz := pg_catalog.now() - interval '1 hour';
  v_day_start timestamptz := (pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo';
  v_kind_hour int; v_kind_day int; v_total_hour int; v_total_day int;
  v_cap_hour int; v_cap_day int;
  v_last_slot timestamptz;
  v_gap int;
  v_next timestamptz;
  v_wait_ms int := 0;
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if coalesce(btrim(p_instance), '') = '' or coalesce(btrim(p_destination), '') = '' then
    return pg_catalog.jsonb_build_object('allowed', true, 'kind', 'unknown', 'wait_ms', 0, 'reason', 'sem_instancia_ou_destino');
  end if;
  insert into public.whatsapp_outbound_policy (instance_name) values (p_instance) on conflict (instance_name) do nothing;
  select * into pol from public.whatsapp_outbound_policy where instance_name = p_instance;
  if not pol.enabled then
    return pg_catalog.jsonb_build_object('allowed', true, 'kind', 'unlimited', 'wait_ms', 0, 'reason', 'politica_desligada');
  end if;

  v_kind := private.whatsapp_outbound_kind(p_destination);
  v_factor := private.whatsapp_warmup_factor(pol.warmup_started_at);

  -- Conta o que saiu (ou está em voo há menos de 3 min) — reserva de envio
  -- que falhou não ocupa vaga para sempre.
  select count(*) filter (where l.kind = v_kind and l.slot_at > v_hour_start),
         count(*) filter (where l.kind = v_kind and l.slot_at >= v_day_start),
         count(*) filter (where l.kind not in ('reply', 'group') and l.slot_at > v_hour_start),
         count(*) filter (where l.kind not in ('reply', 'group') and l.slot_at >= v_day_start),
         max(l.slot_at) filter (where l.kind in ('outreach', 'transactional'))
    into v_kind_hour, v_kind_day, v_total_hour, v_total_day, v_last_slot
    from public.whatsapp_outbound_ledger l
   where l.instance_name = p_instance
     and l.slot_at >= least(v_day_start, v_hour_start)
     and (l.delivered is true or (l.delivered is null and l.reserved_at > pg_catalog.now() - interval '3 minutes'));

  v_cap_hour := case v_kind
    when 'group' then pol.group_hourly
    when 'reply' then pol.reply_hourly
    when 'staff' then pol.staff_hourly
    when 'transactional' then greatest(1, floor(pol.transactional_hourly * v_factor))::int
    else greatest(1, floor(pol.outreach_hourly * v_factor))::int end;
  v_cap_day := case v_kind
    when 'transactional' then greatest(1, floor(pol.transactional_daily * v_factor))::int
    when 'outreach' then greatest(1, floor(pol.outreach_daily * v_factor))::int
    else null end;

  if v_kind_hour >= v_cap_hour then
    return pg_catalog.jsonb_build_object('allowed', false, 'kind', v_kind, 'wait_ms', 15 * 60 * 1000,
      'reason', 'teto_por_hora', 'used_hour', v_kind_hour, 'cap_hour', v_cap_hour);
  end if;
  if v_cap_day is not null and v_kind_day >= v_cap_day then
    return pg_catalog.jsonb_build_object('allowed', false, 'kind', v_kind, 'wait_ms', 60 * 60 * 1000,
      'reason', 'teto_por_dia', 'used_day', v_kind_day, 'cap_day', v_cap_day);
  end if;
  if v_kind not in ('reply', 'group') then
    if v_total_hour >= greatest(1, floor(pol.total_hourly * v_factor))::int then
      return pg_catalog.jsonb_build_object('allowed', false, 'kind', v_kind, 'wait_ms', 15 * 60 * 1000,
        'reason', 'teto_total_por_hora', 'used_hour', v_total_hour);
    end if;
    if v_total_day >= greatest(1, floor(pol.total_daily * v_factor))::int then
      return pg_catalog.jsonb_build_object('allowed', false, 'kind', v_kind, 'wait_ms', 60 * 60 * 1000,
        'reason', 'teto_total_por_dia', 'used_day', v_total_day);
    end if;
  end if;

  -- Espaçamento aleatório entre envios frios/transacionais.
  v_next := pg_catalog.now();
  if v_kind in ('outreach', 'transactional') and v_last_slot is not null then
    v_gap := case when v_kind = 'outreach'
      then pol.outreach_gap_min_seconds + floor(random() * greatest(0, pol.outreach_gap_max_seconds - pol.outreach_gap_min_seconds + 1))::int
      else pol.transactional_gap_min_seconds + floor(random() * greatest(0, pol.transactional_gap_max_seconds - pol.transactional_gap_min_seconds + 1))::int end;
    v_next := greatest(pg_catalog.now(), v_last_slot + pg_catalog.make_interval(secs => v_gap));
    v_wait_ms := greatest(0, (extract(epoch from (v_next - pg_catalog.now())) * 1000)::int);
    -- Mais de 12 s de espera não cabe dentro de uma request: o chamador adia.
    if v_wait_ms > 12000 then
      return pg_catalog.jsonb_build_object('allowed', false, 'kind', v_kind, 'wait_ms', v_wait_ms, 'reason', 'espacamento');
    end if;
  end if;

  if p_reserve then
    insert into public.whatsapp_outbound_ledger (instance_name, destination, kind, slot_at)
    values (p_instance, left(p_destination, 80), v_kind, v_next) returning id into v_id;
  end if;
  return pg_catalog.jsonb_build_object('allowed', true, 'kind', v_kind, 'wait_ms', v_wait_ms, 'ledger_id', v_id,
    'warmup_factor', v_factor, 'used_hour', v_kind_hour, 'cap_hour', v_cap_hour);
end $$;

create or replace function public.whatsapp_outbound_settle(p_ledger_id uuid, p_delivered boolean)
returns void language sql security definer set search_path = '' as $$
  update public.whatsapp_outbound_ledger set delivered = p_delivered where id = p_ledger_id;
$$;

-- Fila: adiar sem gastar tentativa (o claim já somou 1).
create or replace function public.defer_notification_delivery(p_notification_id uuid, p_claim_token uuid, p_delay_seconds integer, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.notification_queue%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  update public.notification_queue n
     set status = 'pending', delivery_status = 'queued',
         next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(secs => greatest(5, least(coalesce(p_delay_seconds, 60), 3600))),
         attempts = greatest(n.attempts - 1, 0),
         claim_token = null, lease_expires_at = null,
         last_error = left(coalesce(p_reason, 'deferred'), 200), updated_at = pg_catalog.now()
   where n.id = p_notification_id and n.claim_token = p_claim_token
     and n.status = 'processing' and n.delivery_status = 'preparing'
  returning * into v_row;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_nao_encontrado'); end if;
  return pg_catalog.jsonb_build_object('ok', true, 'next_attempt_at', v_row.next_attempt_at);
end $$;

-- Limpeza: o livro só precisa de 2 dias.
create or replace function public.whatsapp_outbound_ledger_prune()
returns integer language sql security definer set search_path = '' as $$
  with d as (delete from public.whatsapp_outbound_ledger where slot_at < pg_catalog.now() - interval '2 days' returning 1)
  select count(*)::int from d;
$$;

do $owners$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where (s.nspname = 'public' and p.proname in ('whatsapp_outbound_permit', 'whatsapp_outbound_settle', 'defer_notification_delivery', 'whatsapp_outbound_ledger_prune'))
              or (s.nspname = 'private' and p.proname in ('whatsapp_outbound_kind', 'whatsapp_warmup_factor'))
  loop
    execute format('alter function %s owner to postgres', f);
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $owners$;

-- Estado de hoje: o número da escola volta ~11:15 BRT de 18/09 — o aquecimento começa aí.
insert into public.whatsapp_outbound_policy (instance_name, tenant_id, warmup_started_at, outreach_daily, notes)
values ('prof-diretorww-d6bg', 'school-wise-wolf', '2026-09-18 14:15:00+00', 30, 'Restrição de 21 h em 17/09/2026 14:15 BRT; aquecimento a partir da volta.')
on conflict (instance_name) do nothing;

-- Poda diária do livro (04:15 UTC).
do $cron$ begin
  if not exists (select 1 from cron.job where jobname = 'wisewolf-wa-ledger-prune') then
    perform cron.schedule('wisewolf-wa-ledger-prune', '15 4 * * *', 'select public.whatsapp_outbound_ledger_prune();');
  end if;
end $cron$;
