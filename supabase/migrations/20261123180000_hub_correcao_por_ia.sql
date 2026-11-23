-- Hub Fase 1 (23/11/2026): o aluno responde a atividade do link e recebe a correção.
--
-- Fechadas (múltipla escolha e lacunas) são corrigidas por código com o gabarito, que nunca vai ao
-- navegador. Abertas recebem retorno em português da IA, dentro de uma cota mensal por plano
-- (`educator_ai.correct`, contada pelas respostas corrigidas por IA na conta do professor).
-- O professor escolhe, no link, quando o gabarito aparece: 'after_submit' (depois de enviar) ou
-- 'never' (só certo/errado e o retorno). As respostas ficam para o professor (nome opcional).
-- A cota é RESERVADA antes de chamar a IA (trava por conta + linha de reserva de 5 min) e a reserva
-- é usada ou liberada depois; por link, no máximo 20 envios por minuto e 300 por dia.
-- Aditiva (a criação do link ganha o modo na mesma transação: nova assinatura de 4 argumentos).
-- Desfazer: drop das funções novas (hub_material_share_create(uuid, uuid, text, text),
-- hub_material_share_reserve_ai, hub_material_share_release_ai, for_grading, record, results) e das
-- tabelas hub_material_share_ai_reservations e hub_material_share_submissions;
-- alter table public.hub_material_share_links drop column answer_key_mode;
-- delete from public.hub_plan_entitlements where feature_key = 'educator_ai.correct';

alter table public.hub_material_share_links
  add column if not exists answer_key_mode text not null default 'after_submit';
do $c$ begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'hub_material_share_links_key_mode_check') then
    alter table public.hub_material_share_links add constraint hub_material_share_links_key_mode_check
      check (answer_key_mode in ('after_submit', 'never'));
  end if;
end $c$;

create table if not exists public.hub_material_share_submissions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.hub_material_share_links (id) on delete cascade,
  account_id uuid not null references public.hub_accounts (id) on delete cascade,
  material_id uuid not null references public.hub_educator_materials (id) on delete cascade,
  student_name text check (student_name is null or char_length(student_name) between 1 and 80),
  answers jsonb not null check (jsonb_typeof(answers) = 'object'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  closed_right integer not null default 0,
  closed_total integer not null default 0,
  ai_corrected boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists hub_material_share_submissions_material_idx
  on public.hub_material_share_submissions (material_id, created_at desc);
create index if not exists hub_material_share_submissions_account_ai_idx
  on public.hub_material_share_submissions (account_id, created_at) where ai_corrected;
create index if not exists hub_material_share_submissions_link_idx
  on public.hub_material_share_submissions (link_id, created_at);

-- Reserva da cota de correção por IA enquanto a chamada está em andamento (vale 5 min).
create table if not exists public.hub_material_share_ai_reservations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.hub_accounts (id) on delete cascade,
  link_id uuid not null references public.hub_material_share_links (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists hub_material_share_ai_reservations_account_idx
  on public.hub_material_share_ai_reservations (account_id, created_at);
alter table public.hub_material_share_ai_reservations enable row level security;
revoke all on table public.hub_material_share_ai_reservations from public, anon, authenticated;
grant all on table public.hub_material_share_ai_reservations to service_role;
alter table public.hub_material_share_submissions enable row level security;
revoke all on table public.hub_material_share_submissions from public, anon, authenticated;
grant all on table public.hub_material_share_submissions to service_role;

-- Cota mensal de correções por IA (respostas abertas), por plano.
insert into public.hub_plan_entitlements (plan_id, feature_key, limit_value, reset_period, metadata)
select p.id, 'educator_ai.correct', v.limit_value, 'MONTH', '{"source":"hub_fase1_correcao"}'::jsonb
  from public.hub_plans p
  join (values ('DISCOVERY', 30), ('PROFESSOR_PRO', 600), ('PROFESSOR_ESCOLA', 2000), ('INSTITUTIONAL', 5000)) as v(code, limit_value)
    on v.code = p.code
on conflict (plan_id, feature_key) do nothing;

-- Criação do link com o modo do gabarito na MESMA transação (a de 3 argumentos sai: link nunca nasce
-- com 'after_submit' quando o professor pediu 'never').
create or replace function public.hub_material_share_create(
  p_user_id uuid,
  p_material_id uuid,
  p_token_sha256 text,
  p_answer_key_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_answer_key_mode is null or p_answer_key_mode not in ('after_submit', 'never') then
    raise exception 'invalid_mode' using errcode = '22023';
  end if;
  v_result := public.hub_material_share_create(p_user_id, p_material_id, p_token_sha256);
  if coalesce((v_result ->> 'ok')::boolean, false) then
    update public.hub_material_share_links set answer_key_mode = p_answer_key_mode
     where id = (v_result ->> 'linkId')::uuid;
    if not found then raise exception 'share_link_missing' using errcode = 'P0002'; end if;
  end if;
  return v_result || jsonb_build_object('answerKeyMode', p_answer_key_mode);
end;
$$;

-- Material COMPLETO (com gabarito) para a correção no servidor + cota de IA da conta.
create or replace function public.hub_material_share_for_grading(p_token_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.hub_material_share_links%rowtype;
  v_material public.hub_educator_materials%rowtype;
  v_today integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_link from public.hub_material_share_links where token_sha256 = p_token_sha256;
  if not found or v_link.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'LINK_INVALID');
  end if;
  if v_link.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'LINK_EXPIRED');
  end if;
  select count(*) into v_today from public.hub_material_share_submissions
   where link_id = v_link.id and created_at > now() - interval '1 day';
  if v_today >= 300 or (select count(*) from public.hub_material_share_submissions
       where link_id = v_link.id and created_at > now() - interval '1 minute') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'SUBMISSION_LIMIT_REACHED');
  end if;
  select * into v_material from public.hub_educator_materials where id = v_link.material_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'LINK_INVALID');
  end if;
  return jsonb_build_object(
    'ok', true,
    'linkId', v_link.id,
    'accountId', v_link.account_id,
    'materialId', v_material.id,
    'ownerUserId', v_link.created_by,
    'kind', v_material.kind,
    'level', v_material.level_tag,
    'material', v_material.material,
    'answerKeyMode', v_link.answer_key_mode
  );
end;
$$;

-- Reserva 1 correção por IA da cota do mês, sob trava da conta: usadas + reservas vivas < limite.
-- Sem plano vivo = 0 (só as fechadas são corrigidas). Devolve o id da reserva ou null.
create or replace function public.hub_material_share_reserve_ai(p_link_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.hub_material_share_links%rowtype;
  v_limit integer;
  v_used integer;
  v_held integer;
  v_id uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_link from public.hub_material_share_links where id = p_link_id;
  if not found or v_link.revoked_at is not null or v_link.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'LINK_INVALID');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hub_share_ai:' || v_link.account_id::text, 0));
  select e.limit_value into v_limit
    from public.hub_subscriptions s
    join public.hub_plan_entitlements e on e.plan_id = s.plan_id and e.feature_key = 'educator_ai.correct'
   where s.account_id = v_link.account_id and s.product_family = 'HUB_CORE'
     and private.hub_subscription_grants_access(s.status, s.trial_ends_at, s.current_period_ends_at)
   order by (s.status = 'ACTIVE') desc, s.created_at desc
   limit 1;
  select count(*) into v_used from public.hub_material_share_submissions
   where account_id = v_link.account_id and ai_corrected
     and created_at >= date_trunc('month', now());
  select count(*) into v_held from public.hub_material_share_ai_reservations
   where account_id = v_link.account_id and created_at > now() - interval '5 minutes';
  if coalesce(v_limit, 0) - v_used - v_held <= 0 then
    return jsonb_build_object('ok', false, 'code', 'AI_QUOTA_EXHAUSTED');
  end if;
  delete from public.hub_material_share_ai_reservations
   where account_id = v_link.account_id and created_at <= now() - interval '5 minutes';
  insert into public.hub_material_share_ai_reservations (account_id, link_id)
  values (v_link.account_id, v_link.id) returning id into v_id;
  return jsonb_build_object('ok', true, 'reservationId', v_id);
end;
$$;

-- Libera a reserva quando a IA falhou (a correção não conta).
create or replace function public.hub_material_share_release_ai(p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  delete from public.hub_material_share_ai_reservations where id = p_reservation_id;
end;
$$;

create or replace function public.hub_material_share_record(
  p_link_id uuid,
  p_student_name text,
  p_answers jsonb,
  p_result jsonb,
  p_closed_right integer,
  p_closed_total integer,
  p_ai_corrected boolean,
  p_reservation_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.hub_material_share_links%rowtype;
  v_id uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_link from public.hub_material_share_links where id = p_link_id;
  if not found then raise exception 'link_not_found' using errcode = 'P0002'; end if;
  -- A reserva vira a correção gravada (conta pelo ai_corrected) ou some (falha da IA).
  if p_reservation_id is not null then
    delete from public.hub_material_share_ai_reservations
     where id = p_reservation_id and link_id = v_link.id;
  end if;
  insert into public.hub_material_share_submissions (link_id, account_id, material_id, student_name, answers,
    result, closed_right, closed_total, ai_corrected)
  values (v_link.id, v_link.account_id, v_link.material_id, nullif(btrim(left(coalesce(p_student_name, ''), 80)), ''),
    p_answers, p_result, greatest(p_closed_right, 0), greatest(p_closed_total, 0), coalesce(p_ai_corrected, false))
  returning id into v_id;
  return v_id;
end;
$$;

-- Respostas recebidas para o professor (autor do material ou quem administra a conta).
create or replace function public.hub_material_share_results(p_user_id uuid, p_material_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material public.hub_educator_materials%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_material from public.hub_educator_materials where id = p_material_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'MATERIAL_NOT_FOUND'); end if;
  if v_material.created_by <> p_user_id and not exists (
    select 1 from public.hub_memberships m
     where m.account_id = v_material.account_id and m.user_id = p_user_id
       and m.status = 'ACTIVE' and m.membership_role in ('OWNER', 'ADMIN')
  ) then
    return jsonb_build_object('ok', false, 'code', 'MATERIAL_ACCESS_DENIED');
  end if;
  return jsonb_build_object('ok', true, 'submissions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'studentName', s.student_name, 'createdAt', s.created_at,
      'closedRight', s.closed_right, 'closedTotal', s.closed_total, 'result', s.result
    ) order by s.created_at desc)
    from (select * from public.hub_material_share_submissions
           where material_id = p_material_id order by created_at desc limit 100) s
  ), '[]'::jsonb));
end;
$$;

revoke all on function public.hub_material_share_create(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.hub_material_share_reserve_ai(uuid) from public, anon, authenticated;
revoke all on function public.hub_material_share_release_ai(uuid) from public, anon, authenticated;
revoke all on function public.hub_material_share_for_grading(text) from public, anon, authenticated;
revoke all on function public.hub_material_share_record(uuid, text, jsonb, jsonb, integer, integer, boolean, uuid) from public, anon, authenticated;
revoke all on function public.hub_material_share_results(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hub_material_share_create(uuid, uuid, text, text) to service_role;
grant execute on function public.hub_material_share_reserve_ai(uuid) to service_role;
grant execute on function public.hub_material_share_release_ai(uuid) to service_role;
grant execute on function public.hub_material_share_for_grading(text) to service_role;
grant execute on function public.hub_material_share_record(uuid, text, jsonb, jsonb, integer, integer, boolean, uuid) to service_role;
grant execute on function public.hub_material_share_results(uuid, uuid) to service_role;
