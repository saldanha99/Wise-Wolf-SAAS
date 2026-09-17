-- Cobertura do DIA de um professor ausente: uma oportunidade por aula,
-- oferecida a TODOS os professores livres naquele horário; o primeiro que
-- aceita leva, e a aula já nasce contabilizada para quem aceitou.
--
-- Pedido da direção (16/09/2026): "Flávio não dá aula hoje — dispara cobertura
-- para quem tem os horários dos alunos dele". O modelo existente
-- (`class_coverages`) é UM convite para UM professor, e o trigger de
-- integridade proíbe dois convites vivos para a mesma aula — de propósito. Por
-- isso a oportunidade é outro objeto (como o leilão da experimental): ela
-- carrega um link POR PROFESSOR (`coverage_opportunity_invites`), e só no
-- aceite nasce a `class_coverages`, passando pelo mesmo trigger, que garante
-- um vencedor só.
--
-- Duas portas, um motor: o grupo da Gestão (`source='group'`, com o aval das
-- outras ações do grupo) e o próprio professor avisando a instância da escola
-- (`source='teacher'`: ele atesta a própria ausência).
-- Re-executável: roda a cada release.

create table if not exists public.coverage_opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  original_teacher_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid references public.profiles(id) on delete set null,
  absence_id uuid references public.teacher_absences(id) on delete set null,
  class_date date not null,
  class_time text not null,
  reason text,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLAIMED', 'EXPIRED', 'CANCELLED')),
  source text not null default 'group' check (source in ('group', 'teacher')),
  winner_teacher_id uuid references public.profiles(id) on delete set null,
  coverage_id uuid references public.class_coverages(id) on delete set null,
  request_id text,
  created_by uuid,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  expires_at timestamptz not null
);
create unique index if not exists uq_coverage_opportunity_open
  on public.coverage_opportunities (booking_id, class_date) where status = 'OPEN';
create index if not exists ix_coverage_opportunities_request
  on public.coverage_opportunities (tenant_id, request_id);

create table if not exists public.coverage_opportunity_invites (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.coverage_opportunities(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  phone text,
  status text not null default 'SENT' check (status in ('SENT', 'ACCEPTED', 'LOST', 'DECLINED', 'FAILED')),
  sent_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (opportunity_id, teacher_id)
);

alter table public.coverage_opportunities enable row level security;
alter table public.coverage_opportunity_invites enable row level security;
-- Escrita só pelas RPCs (service_role); leitura da direção pela tela vem depois.
grant all on table public.coverage_opportunities, public.coverage_opportunity_invites to service_role;

comment on table public.coverage_opportunities is
  'Aula de professor ausente oferecida a vários professores; o primeiro aceite vira class_coverages.';

-- ---------------------------------------------------------------------------
-- Candidatos a cobrir uma aula: grade declarada no horário, sem conflito, com
-- WhatsApp, na mesma escola. Mesmas barreiras do convite individual.
-- ---------------------------------------------------------------------------
create or replace function private.coverage_candidates(
  p_tenant text, p_booking_id uuid, p_class_date date
) returns table (teacher_id uuid, full_name text, phone text)
language sql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  with booking as (
    select b.* , left(coalesce(b.time_slot, ''), 5) as slot
      from public.bookings b where b.id = p_booking_id and b.tenant_id = p_tenant
  ),
  dow as (
    select extract(dow from p_class_date)::int as n,
           (array['Domingo','Segunda','Terca','Quarta','Quinta','Sexta','Sabado'])[extract(dow from p_class_date)::int + 1] as name
  ),
  class_start as (
    select (p_class_date::text || ' ' || (select slot from booking) || ':00-03')::timestamptz as at
  )
  select t.id, t.full_name,
         case
           when length(regexp_replace(coalesce(t.attendance_phone, ''), '[^0-9]', '', 'g')) between 10 and 15 then t.attendance_phone
           when length(regexp_replace(coalesce(t.phone, ''), '[^0-9]', '', 'g')) between 10 and 15 then t.phone
         end as phone
    from public.profiles t
    join public.tenant_memberships m
      on m.user_id = t.id and m.tenant_id = p_tenant and m.role = 'TEACHER' and m.status = 'ACTIVE'
   where t.role = 'TEACHER'
     and t.tenant_id = p_tenant
     and lower(coalesce(t.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
     and coalesce(t.is_test_account, false) = false
     and t.id <> (select b.teacher_id from booking b)
     and 1 = (select count(distinct am.tenant_id) from public.tenant_memberships am
               where am.user_id = t.id and am.role = 'TEACHER' and am.status = 'ACTIVE')
     and private.can_access_teacher_projection(t.id, to_char(p_class_date, 'YYYY-MM'))
     and exists (
       select 1 from public.teacher_availability av
        where av.tenant_id = p_tenant and av.teacher_id = t.id
          and av.day_of_week = (select n from dow)
          and (av.start_time = (select slot from booking)::time
               or (av.end_time is not null and av.start_time <= (select slot from booking)::time
                   and av.end_time > (select slot from booking)::time))
     )
     and not exists (
       select 1 from public.bookings c
        where c.tenant_id = p_tenant and c.teacher_id = t.id
          and upper(coalesce(c.status, '')) <> 'CANCELLED'
          and left(coalesce(c.time_slot, ''), 5) = (select slot from booking)
          and (c.date = p_class_date
               or (c.date is null and public.fold_accents(c.day_of_week) = lower((select name from dow))
                   and (c.start_date is null or c.start_date <= p_class_date)))
     )
     and not exists (
       select 1 from public.reschedules r
        where r.tenant_id = p_tenant and r.teacher_id = t.id and r.used_at is null
          and public.parse_lesson_date(r.date) = p_class_date
          and left(r.time::text, 5) = (select slot from booking)
     )
     and not exists (
       select 1 from public.appointments a
        where a.tenant_id = p_tenant and (a.teacher_id = t.id or a.professor_id = t.id)
          and lower(coalesce(a.status, '')) in ('scheduled', 'confirmed')
          and abs(extract(epoch from (a.start_time - (select at from class_start)))) < 1800
     )
     and not exists (
       select 1 from public.teacher_absences ab
        where ab.tenant_id = p_tenant and ab.teacher_id = t.id
          and lower(coalesce(ab.status, '')) = 'active'
          and ab.starts_at::date <= p_class_date and ab.ends_at::date >= p_class_date
     )
     and not exists (
       select 1 from public.class_coverages cc
        where cc.tenant_id = p_tenant and cc.cover_teacher_id = t.id
          and cc.class_date = p_class_date and left(cc.class_time, 5) = (select slot from booking)
          and (lower(cc.status) = 'confirmed'
               or (lower(cc.status) = 'pending' and now() < coalesce(cc.invite_expires_at, (select at from class_start))))
     )
   order by t.full_name
$function$;

-- ---------------------------------------------------------------------------
-- Abre as oportunidades do dia. Idempotente por request_id.
-- ---------------------------------------------------------------------------
create or replace function public.gestao_open_coverage_day(
  p_tenant text,
  p_actor_id uuid,
  p_request_id text,
  p_teacher_id uuid,
  p_date date,
  p_reason text,
  p_source text default 'group'
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor_role text;
  v_teacher record;
  v_absence public.teacher_absences%rowtype;
  v_booking record;
  v_opp public.coverage_opportunities%rowtype;
  v_start timestamptz;
  v_dow_name text;
  v_items jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_invites jsonb;
  v_cand record;
  v_inv public.coverage_opportunity_invites%rowtype;
  v_student_name text;
  v_attester uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  -- p_actor_id pode ser NULL (participante @lid do grupo; ver
  -- private.management_group_default_actor).
  if p_tenant is null or p_teacher_id is null or p_date is null then
    return jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  end if;
  if coalesce(length(btrim(p_request_id)), 0) not between 8 and 200 then
    return jsonb_build_object('ok', false, 'error', 'request_id_invalido');
  end if;
  if p_source not in ('group', 'teacher') then
    return jsonb_build_object('ok', false, 'error', 'origem_invalida');
  end if;
  if p_date < (now() at time zone 'America/Sao_Paulo')::date
     or p_date > (now() at time zone 'America/Sao_Paulo')::date + 14 then
    return jsonb_build_object('ok', false, 'error', 'data_fora_da_janela');
  end if;
  if coalesce(length(btrim(p_reason)), 0) not between 3 and 200 then
    return jsonb_build_object('ok', false, 'error', 'motivo_invalido');
  end if;

  v_attester := coalesce(p_actor_id, private.management_group_default_actor(p_tenant));

  select t.id, t.full_name into v_teacher
    from public.profiles t
    join public.tenant_memberships m on m.user_id = t.id and m.tenant_id = p_tenant and m.role = 'TEACHER' and m.status = 'ACTIVE'
   where t.id = p_teacher_id and t.role = 'TEACHER' and t.tenant_id = p_tenant
     and lower(coalesce(t.lifecycle_status, 'active')) not in ('suspended', 'offboarded');
  if v_teacher.id is null then
    return jsonb_build_object('ok', false, 'error', 'professor_invalido');
  end if;

  -- Aval: direção/coordenação, ação confirmada no grupo, ou o próprio professor
  -- atestando a própria ausência (porta da instância da escola).
  select membership.role into v_actor_role
    from public.tenant_memberships membership
    join public.profiles actor on actor.id = membership.user_id
   where membership.user_id = p_actor_id and membership.tenant_id = p_tenant
     and membership.status = 'ACTIVE' and membership.role in ('SCHOOL_ADMIN', 'COORDINATOR')
     and lower(coalesce(actor.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
   limit 1;
  if v_actor_role is null and p_source = 'teacher' and p_actor_id = p_teacher_id then
    v_actor_role := 'TEACHER';
  end if;
  if v_actor_role is null and not private.management_group_execution_authorized(
       p_tenant, p_actor_id, p_request_id,
       jsonb_build_object('tipo', 'cobertura_dia', 'teacher_id', p_teacher_id, 'data', p_date::text)
     ) then
    raise exception using errcode = '42501', message = 'actor_not_allowed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('coverage-day:' || p_tenant || ':' || left(btrim(p_request_id), 200), 0));

  -- Reprocessamento da mesma confirmação: devolve o que já existe, sem reenviar.
  if exists (select 1 from public.coverage_opportunities o where o.tenant_id = p_tenant and o.request_id = left(btrim(p_request_id), 200)) then
    select jsonb_agg(jsonb_build_object(
             'opportunity_id', o.id, 'status', o.status, 'class_time', o.class_time,
             'student_name', s.full_name, 'invites', '[]'::jsonb))
      into v_items
      from public.coverage_opportunities o left join public.profiles s on s.id = o.student_id
     where o.tenant_id = p_tenant and o.request_id = left(btrim(p_request_id), 200);
    return jsonb_build_object('ok', true, 'idempotent', true, 'teacher_name', v_teacher.full_name,
                              'opportunities', coalesce(v_items, '[]'::jsonb), 'skipped', '[]'::jsonb);
  end if;

  -- Ausência do dia (mesmo formato dos outros escritores: enum + MAIÚSCULA).
  select * into v_absence from public.teacher_absences a
   where a.tenant_id = p_tenant and a.teacher_id = p_teacher_id and lower(a.status) = 'active'
     and a.starts_at::date <= p_date and a.ends_at::date >= p_date
   order by a.created_at limit 1 for update;
  if not found then
    insert into public.teacher_absences (tenant_id, teacher_id, starts_at, ends_at, reason, notes, status)
    values (p_tenant, p_teacher_id, p_date, p_date,
            case when btrim(p_reason) ~* '(doen|garganta|febre|gripe|sa[uú]de|m[eé]dic|hospital|enferm|covid|sick|dor )' then 'SICK' else 'OTHER' end,
            btrim(p_reason), 'ACTIVE')
    returning * into v_absence;
  end if;

  v_dow_name := (array['Domingo','Segunda','Terca','Quarta','Quinta','Sexta','Sabado'])[extract(dow from p_date)::int + 1];

  for v_booking in
    select b.id, b.student_id, left(coalesce(b.time_slot, ''), 5) as slot
      from public.bookings b
     where b.tenant_id = p_tenant and b.teacher_id = p_teacher_id and b.student_id is not null
       and upper(coalesce(b.status, '')) = 'SCHEDULED'
       and (b.date = p_date
            or (b.date is null and public.fold_accents(b.day_of_week) = lower(v_dow_name)
                and (b.start_date is null or b.start_date <= p_date)))
     order by left(coalesce(b.time_slot, ''), 5)
  loop
    select full_name into v_student_name from public.profiles where id = v_booking.student_id;
    v_start := (p_date::text || ' ' || v_booking.slot || ':00-03')::timestamptz;
    if v_booking.slot !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' or v_start <= now() + interval '5 minutes' then
      v_skipped := v_skipped || jsonb_build_object('student_name', v_student_name, 'class_time', v_booking.slot, 'motivo', 'ja_comecou');
      continue;
    end if;
    if exists (select 1 from public.class_coverages cc where cc.tenant_id = p_tenant and cc.booking_id = v_booking.id and cc.class_date = p_date
                 and (lower(cc.status) = 'confirmed' or (lower(cc.status) = 'pending' and now() < coalesce(cc.invite_expires_at, v_start))))
       or exists (select 1 from public.coverage_opportunities o where o.booking_id = v_booking.id and o.class_date = p_date and o.status = 'OPEN') then
      v_skipped := v_skipped || jsonb_build_object('student_name', v_student_name, 'class_time', v_booking.slot, 'motivo', 'ja_tem_cobertura');
      continue;
    end if;

    insert into public.coverage_opportunities (
      tenant_id, booking_id, original_teacher_id, student_id, absence_id, class_date, class_time,
      reason, source, request_id, created_by, expires_at
    ) values (
      p_tenant, v_booking.id, p_teacher_id, v_booking.student_id, v_absence.id, p_date, v_booking.slot,
      btrim(p_reason), p_source, left(btrim(p_request_id), 200), v_attester, v_start - interval '5 minutes'
    ) returning * into v_opp;

    v_invites := '[]'::jsonb;
    for v_cand in select * from private.coverage_candidates(p_tenant, v_booking.id, p_date) where phone is not null loop
      insert into public.coverage_opportunity_invites (opportunity_id, teacher_id, phone)
      values (v_opp.id, v_cand.teacher_id, v_cand.phone)
      returning * into v_inv;
      v_invites := v_invites || jsonb_build_object(
        'invite_id', v_inv.id, 'token', v_inv.token, 'teacher_id', v_cand.teacher_id,
        'teacher_name', v_cand.full_name, 'phone', v_cand.phone);
    end loop;
    if jsonb_array_length(v_invites) = 0 then
      update public.coverage_opportunities set status = 'EXPIRED' where id = v_opp.id;
    end if;

    v_items := v_items || jsonb_build_object(
      'opportunity_id', v_opp.id, 'status', case when jsonb_array_length(v_invites) = 0 then 'EXPIRED' else 'OPEN' end,
      'class_time', v_booking.slot, 'student_name', v_student_name, 'invites', v_invites);
  end loop;

  insert into public.audit_logs (tenant_id, user_id, user_role, action, resource_type, resource_id, new_values)
  values (p_tenant, p_actor_id, v_actor_role, 'coverage_day_opened', 'teacher_absence', v_absence.id::text,
          jsonb_build_object('teacher_id', p_teacher_id, 'date', p_date, 'source', p_source,
                             'attested_by', v_attester, 'requested_by_group_member', p_actor_id is null,
                             'opportunities', jsonb_array_length(v_items), 'request_id', left(btrim(p_request_id), 200)));

  return jsonb_build_object('ok', true, 'teacher_name', v_teacher.full_name, 'absence_id', v_absence.id,
                            'opportunities', v_items, 'skipped', v_skipped);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Aceite pelo link: o primeiro vence. Nasce a class_coverages (pending →
-- confirmed, pelo trigger de integridade) e o financeiro é aplicado.
-- ---------------------------------------------------------------------------
create or replace function public.claim_coverage_opportunity(p_token text, p_accept boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_inv public.coverage_opportunity_invites%rowtype;
  v_opp public.coverage_opportunities%rowtype;
  v_cov public.class_coverages%rowtype;
  v_start timestamptz;
  v_apply jsonb;
  v_names record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_token !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('ok', false, 'error', 'token_invalido');
  end if;

  select * into v_inv from public.coverage_opportunity_invites where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'convite_inexistente'); end if;
  select * into v_opp from public.coverage_opportunities where id = v_inv.opportunity_id for update;

  select s.full_name as student_name, o.full_name as original_name, c.full_name as cover_name
    into v_names
    from public.profiles c
    left join public.profiles s on s.id = v_opp.student_id
    left join public.profiles o on o.id = v_opp.original_teacher_id
   where c.id = v_inv.teacher_id;

  if v_inv.status = 'ACCEPTED' then
    return jsonb_build_object('ok', true, 'already', true, 'status', 'ACCEPTED',
      'class_date', v_opp.class_date, 'class_time', v_opp.class_time, 'student_name', v_names.student_name);
  end if;
  if v_inv.status <> 'SENT' then
    return jsonb_build_object('ok', false, 'error', 'convite_encerrado', 'status', v_inv.status);
  end if;
  if not p_accept then
    update public.coverage_opportunity_invites set status = 'DECLINED', responded_at = now() where id = v_inv.id;
    return jsonb_build_object('ok', true, 'status', 'DECLINED');
  end if;
  if v_opp.status = 'CLAIMED' then
    update public.coverage_opportunity_invites set status = 'LOST', responded_at = now() where id = v_inv.id;
    return jsonb_build_object('ok', false, 'error', 'ja_coberta');
  end if;
  v_start := (v_opp.class_date::text || ' ' || left(v_opp.class_time, 5) || ':00-03')::timestamptz;
  if v_opp.status <> 'OPEN' or now() >= v_opp.expires_at or v_start <= now() then
    update public.coverage_opportunities set status = 'EXPIRED' where id = v_opp.id and status = 'OPEN';
    update public.coverage_opportunity_invites set status = 'LOST', responded_at = now() where id = v_inv.id;
    return jsonb_build_object('ok', false, 'error', 'expirada');
  end if;

  -- A class_coverages passa pelo trigger de integridade (grade, conflito,
  -- vencedor único). Falha ali = este professor não pode mais cobrir.
  begin
    insert into public.class_coverages (
      tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id, absence_id,
      class_date, class_time, status, token, notes, request_id, invite_expires_at
    ) values (
      v_opp.tenant_id, v_opp.original_teacher_id, v_inv.teacher_id, v_opp.student_id, v_opp.booking_id, v_opp.absence_id,
      v_opp.class_date, left(v_opp.class_time, 5), 'pending', encode(extensions.gen_random_bytes(16), 'hex'),
      coalesce(v_opp.reason, 'cobertura do dia'), 'opp:' || v_inv.id::text, least(v_start, now() + interval '1 hour')
    ) returning * into v_cov;
    -- `confirmed_by` fica NULL de propósito: quem aceitou foi o substituto,
    -- pelo link — é a cobertura atestada pela direção que usa esse campo.
    update public.class_coverages set status = 'confirmed', confirmed_at = now()
     where id = v_cov.id and lower(status) = 'pending';
  exception when others then
    update public.coverage_opportunity_invites set status = 'FAILED', responded_at = now() where id = v_inv.id;
    return jsonb_build_object('ok', false, 'error', 'conflito', 'detail', sqlerrm);
  end;

  v_apply := public.apply_coverage_acceptance(v_cov.id);
  if coalesce((v_apply ->> 'ok')::boolean, false) is not true then
    raise exception 'coverage_financial_application_failed';
  end if;

  update public.coverage_opportunities
     set status = 'CLAIMED', winner_teacher_id = v_inv.teacher_id, coverage_id = v_cov.id, claimed_at = now()
   where id = v_opp.id;
  update public.coverage_opportunity_invites set status = 'ACCEPTED', responded_at = now() where id = v_inv.id;
  update public.coverage_opportunity_invites set status = 'LOST', responded_at = now()
   where opportunity_id = v_opp.id and id <> v_inv.id and status = 'SENT';

  return jsonb_build_object(
    'ok', true, 'status', 'ACCEPTED', 'coverage_id', v_cov.id, 'tenant_id', v_opp.tenant_id,
    'class_date', v_opp.class_date, 'class_time', left(v_opp.class_time, 5),
    'student_name', v_names.student_name, 'cover_teacher_name', v_names.cover_name,
    'original_teacher_name', v_names.original_name, 'original_teacher_id', v_opp.original_teacher_id,
    'application', v_apply
  );
end;
$function$;

revoke all on function public.gestao_open_coverage_day(text, uuid, text, uuid, date, text, text) from public, anon, authenticated;
grant execute on function public.gestao_open_coverage_day(text, uuid, text, uuid, date, text, text) to service_role;
revoke all on function public.claim_coverage_opportunity(text, boolean) from public, anon, authenticated;
grant execute on function public.claim_coverage_opportunity(text, boolean) to service_role;
revoke all on function private.coverage_candidates(text, uuid, date) from public, anon, authenticated;
