-- ─────────────────────────────────────────────────────────────────────────────
-- PROFESSOR TROCA HORÁRIO DO ALUNO PELO WHATSAPP DA ESCOLA (direção, 17/09/2026)
--
-- "O aluno Felipe trocou pra 14:30 e a Isabella para as 14" — o Teacher Mateus
-- escreveu isso para o número da escola e a coordenação teve de fazer na mão.
-- Agora o bot lê, mostra o que entendeu (aluno, dia, horário atual → novo),
-- pergunta "confirma?" e, no SIM, aplica pela MESMA RPC da tela do professor
-- (`teacher_apply_student_schedule_change`: vigência a partir de amanhã,
-- choque de agenda checado, aviso ao grupo da Gestão) agindo como o professor.
--
-- Uma proposta pendente por professor, 2 h de validade. Migration re-executável.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.teacher_schedule_change_prompts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  teacher_id uuid not null,
  phone text not null,
  proposal jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPLIED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  result jsonb,
  expires_at timestamptz not null default now() + interval '2 hours',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists uq_teacher_schedule_change_prompt_pending
  on public.teacher_schedule_change_prompts (tenant_id, teacher_id) where status = 'PENDING';
alter table public.teacher_schedule_change_prompts enable row level security;
alter table public.teacher_schedule_change_prompts owner to postgres;

-- Alunos do professor cujo nome bate com o que ele escreveu, com as aulas fixas
-- atuais. "Felipe" casa com "Felipe de Souza Ramos" (prefixo do primeiro nome ou
-- de qualquer nome); dois Felipes voltam os dois e o bot pergunta qual.
create or replace function public.teacher_schedule_change_candidates(p_tenant text, p_teacher uuid, p_names jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  with pedidos as (
    select ordinality as idx, public.fold_accents(btrim(value #>> '{}')) as nome
      from pg_catalog.jsonb_array_elements(coalesce(p_names, '[]'::jsonb)) with ordinality
  ),
  alunos as (
    select distinct s.id, s.full_name, public.fold_accents(s.full_name) as nome_norm
      from public.bookings b
      join public.profiles s on s.id = b.student_id
     where b.tenant_id = p_tenant and b.teacher_id = p_teacher
       and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null
       and lower(coalesce(s.lifecycle_status, 'active')) = 'active'
  ),
  casamentos as (
    select p.idx, p.nome, a.id, a.full_name
      from pedidos p
      join alunos a on (
        a.nome_norm = p.nome
        or a.nome_norm like p.nome || '%'
        or a.nome_norm like '% ' || p.nome || '%'
      )
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'idx', p.idx, 'name', p.nome,
    'matches', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'student_id', c.id, 'student_name', c.full_name,
        'slots', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'booking_id', b.id, 'day', public.canonical_weekday_name(b.day_of_week), 'time', left(b.time_slot, 5))
                    order by public.dow_name_to_int(b.day_of_week), b.time_slot), '[]'::jsonb)
                   from public.bookings b
                  where b.tenant_id = p_tenant and b.teacher_id = p_teacher and b.student_id = c.id
                    and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null)
      ) order by c.full_name)
      from casamentos c where c.idx = p.idx), '[]'::jsonb)
  ) order by p.idx), '[]'::jsonb)
  from pedidos p;
$$;

-- Agenda fixa do professor, para o bot dizer o choque ANTES de perguntar
-- "confirma?" ("Quarta 14:30 já é da Ana Clara — essa fica como está").
create or replace function public.teacher_schedule_change_busy(p_tenant text, p_teacher uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'booking_id', b.id, 'day', public.canonical_weekday_name(b.day_of_week),
           'time', left(b.time_slot, 5), 'student_name', coalesce(s.full_name, 'aluno'))
           order by public.dow_name_to_int(b.day_of_week), b.time_slot), '[]'::jsonb)
    from public.bookings b
    left join public.profiles s on s.id = b.student_id
   where b.tenant_id = p_tenant and b.teacher_id = p_teacher
     and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null;
$$;

create or replace function public.teacher_schedule_change_prompt_open(p_tenant text, p_teacher uuid, p_phone text, p_proposal jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.teacher_schedule_change_prompts
     set status = 'CANCELLED', resolved_at = pg_catalog.now()
   where tenant_id = p_tenant and teacher_id = p_teacher and status = 'PENDING';
  insert into public.teacher_schedule_change_prompts (tenant_id, teacher_id, phone, proposal)
  values (p_tenant, p_teacher, p_phone, p_proposal)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.teacher_schedule_change_prompt_pending(p_tenant text, p_teacher uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('id', t.id, 'proposal', t.proposal, 'expires_at', t.expires_at)
    from public.teacher_schedule_change_prompts t
   where t.tenant_id = p_tenant and t.teacher_id = p_teacher and t.status = 'PENDING'
     and t.expires_at > pg_catalog.now()
   order by t.created_at desc limit 1;
$$;

create or replace function public.teacher_schedule_change_prompt_cancel(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.teacher_schedule_change_prompts
     set status = 'CANCELLED', resolved_at = pg_catalog.now()
   where id = p_id and status = 'PENDING';
  return found;
end $$;

-- Aplica agindo como o professor: a RPC da tela lê auth.uid(), então o bot
-- assume a identidade dele só dentro desta transação (mesmo truque do
-- fechamento da experimental) e devolve as credenciais em seguida.
create or replace function public.teacher_schedule_change_prompt_apply(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.teacher_schedule_change_prompts%rowtype;
  v_sub text := pg_catalog.current_setting('request.jwt.claim.sub', true);
  v_claims text := pg_catalog.current_setting('request.jwt.claims', true);
  v_student jsonb;
  v_change jsonb;
  v_result jsonb;
  v_occupant text;
  v_queue jsonb := '[]'::jsonb;
  v_retry jsonb := '[]'::jsonb;
  v_round int;
  v_results jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_tomorrow date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date + 1;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  select * into t from public.teacher_schedule_change_prompts where id = p_id and status = 'PENDING' for update;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'error', 'proposta_nao_encontrada'); end if;
  if t.expires_at <= pg_catalog.now() then
    update public.teacher_schedule_change_prompts set status = 'EXPIRED', resolved_at = pg_catalog.now() where id = t.id;
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'proposta_expirada');
  end if;
  if not exists (select 1 from public.tenant_memberships m join public.profiles p on p.id = m.user_id
                  where m.user_id = t.teacher_id and m.tenant_id = t.tenant_id and m.role = 'TEACHER' and m.status = 'ACTIVE'
                    and lower(coalesce(p.lifecycle_status, 'active')) = 'active') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'professor_inativo');
  end if;

  -- Achata a proposta em uma lista de aulas (aluno + mudança).
  for v_student in select value from pg_catalog.jsonb_array_elements(t.proposal -> 'students') loop
    for v_change in select value from pg_catalog.jsonb_array_elements(v_student -> 'changes') loop
      v_queue := v_queue || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'student_id', v_student ->> 'student_id', 'student_name', v_student ->> 'student_name',
        'booking_id', v_change ->> 'booking_id', 'day', v_change ->> 'day', 'old_time', v_change ->> 'old_time',
        'new_day', v_change ->> 'new_day', 'new_time', v_change ->> 'new_time'));
    end loop;
  end loop;

  perform private.trial_closing_act_as(t.teacher_id);
  -- Uma aula por chamada: a RPC da tela recusa o lote inteiro se UMA aula
  -- choca (Felipe: quarta 14:30 é da Ana Clara; quinta e sexta estavam livres).
  -- Assim o que pode mudar muda, e o choque é dito aula a aula, com quem ocupa.
  -- Duas rodadas: um choque pode ser com aula que a PRÓPRIA proposta tira do
  -- lugar (Isabella vai para quinta 14:00, de onde o Felipe sai para 14:30) —
  -- a segunda rodada tenta de novo o que chocou depois que o resto mudou.
  for v_round in 1..2 loop
    v_retry := '[]'::jsonb;
    for v_change in select value from pg_catalog.jsonb_array_elements(v_queue) loop
      begin
        v_result := public.teacher_apply_student_schedule_change(
          (v_change ->> 'student_id')::uuid,
          pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'booking_id', v_change ->> 'booking_id', 'new_day', v_change ->> 'new_day', 'new_time', v_change ->> 'new_time')),
          v_tomorrow, 'Pedido do professor pelo WhatsApp da escola'
        );
        v_results := v_results || pg_catalog.jsonb_build_array(v_change || pg_catalog.jsonb_build_object('result', v_result));
      exception when others then
        if v_round = 1 and sqlerrm like 'Choque de agenda%' then
          v_retry := v_retry || pg_catalog.jsonb_build_array(v_change);
        else
          select s.full_name into v_occupant
            from public.bookings b join public.profiles s on s.id = b.student_id
           where b.tenant_id = t.tenant_id and b.teacher_id = t.teacher_id
             and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null
             and public.canonical_weekday_name(b.day_of_week) = (v_change ->> 'new_day')
             and left(b.time_slot, 5) = (v_change ->> 'new_time')
           limit 1;
          v_errors := v_errors || pg_catalog.jsonb_build_array(v_change || pg_catalog.jsonb_build_object(
            'occupant', v_occupant, 'error', left(sqlerrm, 200)));
          v_occupant := null;
        end if;
      end;
    end loop;
    exit when pg_catalog.jsonb_array_length(v_retry) = 0;
    v_queue := v_retry;
  end loop;
  perform private.trial_closing_restore(v_sub, v_claims);

  update public.teacher_schedule_change_prompts
     set status = case when pg_catalog.jsonb_array_length(v_results) > 0 then 'APPLIED' else 'FAILED' end,
         result = pg_catalog.jsonb_build_object('applied', v_results, 'errors', v_errors, 'effective_from', v_tomorrow),
         resolved_at = pg_catalog.now()
   where id = t.id;
  return pg_catalog.jsonb_build_object('ok', pg_catalog.jsonb_array_length(v_results) > 0,
    'applied', v_results, 'errors', v_errors, 'effective_from', v_tomorrow);
end $$;

do $owners$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname like 'teacher_schedule_change_%'
  loop
    execute format('alter function %s owner to postgres', f);
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $owners$;
