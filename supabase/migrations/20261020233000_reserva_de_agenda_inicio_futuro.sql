-- Reserva de agenda para aluno que começa numa data futura.
--
-- Caso real (20/10/2026): o Well fechou seg e qua 20h30 com o Teacher Mateus,
-- mas só começa em 05/11. Até lá o horário precisa ficar SEGURO na agenda do
-- professor, e a escola paga ao professor por segurar (R$ 30 combinados). Isso
-- já acontecia na mão — "Reserva de agenda — Mariana Pastro" para a Lais em
-- `closing_adjustments` — sem nada que impedisse outro aluno de pegar o horário.
--
-- Regras que esta migration grava no banco:
-- * É pagamento INTERNO da escola ao professor: entra na folha pelo mesmo
--   `set_closing_adjustment` da tela de repasse. O aluno não paga nada disso e a
--   taxa de matrícula não muda (isenção de matrícula é decisão separada).
-- * A reserva segura o horário RECORRENTE até a data de início da oferta. Aula
--   avulsa (reposição, experimental, cobertura) antes do início continua
--   possível: até lá o horário está livre de fato.
-- * O próprio aluno da oferta nunca é barrado pela reserva dele.
-- * A reserva deixa de valer sozinha na data de início (aí o agendamento do
--   aluno, criado na assinatura, é quem ocupa), se a oferta for revogada ou
--   vencer sem assinatura, ou quando a direção libera.

create table if not exists public.teacher_future_start_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  offer_id uuid not null references public.offers(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  student_label text not null,
  amount numeric(10,2) not null,
  month_year text not null,
  hold_until date not null,
  adjustment_id uuid references public.closing_adjustments(id) on delete set null,
  status text not null default 'ACTIVE',
  created_by uuid,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid,
  release_reason text,
  constraint teacher_future_start_holds_offer_teacher_key unique (offer_id, teacher_id),
  constraint teacher_future_start_holds_amount_check
    check (amount > 0 and amount <= 1000),
  constraint teacher_future_start_holds_month_check
    check (month_year ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint teacher_future_start_holds_label_check
    check (char_length(btrim(student_label)) between 1 and 120),
  constraint teacher_future_start_holds_status_check
    check (status in ('ACTIVE', 'RELEASED')),
  constraint teacher_future_start_holds_release_shape check (
    (status = 'ACTIVE' and released_at is null)
    or (status = 'RELEASED' and released_at is not null)
  ),
  constraint teacher_future_start_holds_reason_check
    check (release_reason is null or char_length(release_reason) <= 300)
);

create index if not exists teacher_future_start_holds_teacher_idx
  on public.teacher_future_start_holds (tenant_id, teacher_id, status, hold_until);

alter table public.teacher_future_start_holds owner to postgres;

-- Leitura e escrita só pelas RPCs abaixo (security definer).
alter table public.teacher_future_start_holds enable row level security;
revoke all on table public.teacher_future_start_holds from public, anon, authenticated;
grant all on table public.teacher_future_start_holds to service_role;

-- Quem administra reservas: super admin ativo, ou direção/coordenação com
-- vínculo ativo na escola. Mesma régua do `set_closing_adjustment`.
create or replace function private.future_start_hold_actor_can_manage(p_tenant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(auth.role(), '') = 'service_role'
    or exists (
      select 1 from public.profiles as actor
       where actor.id = auth.uid()
         and actor.role = 'SUPER_ADMIN'
         and lower(coalesce(actor.lifecycle_status, 'active'))
               not in ('suspended', 'offboarded')
    )
    or exists (
      select 1
        from public.tenant_memberships as membership
        join public.profiles as actor on actor.id = membership.user_id
       where membership.user_id = auth.uid()
         and membership.tenant_id = p_tenant
         and membership.status = 'ACTIVE'
         and membership.role in ('SCHOOL_ADMIN', 'COORDINATOR')
         and lower(coalesce(actor.lifecycle_status, 'active'))
               not in ('suspended', 'offboarded')
    );
$function$;

alter function private.future_start_hold_actor_can_manage(text) owner to postgres;
revoke all on function private.future_start_hold_actor_can_manage(text)
  from public, anon, authenticated;

-- O horário (professor, dia, hora) está segurado por uma reserva vigente de
-- OUTRA oferta? `p_time` é texto ('20:30' ou '20:30:00') para que chamadores
-- com hora digitada não quebrem num cast.
create or replace function private.future_start_hold_blocks(
  p_tenant text,
  p_teacher uuid,
  p_dow integer,
  p_time text,
  p_exclude_offer uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.teacher_future_start_holds as hold
      join public.offers as offer on offer.id = hold.offer_id
      join private.enrollment_offer_schedule_slots as slot
        on slot.offer_id = hold.offer_id
       and slot.teacher_id = hold.teacher_id
     where hold.tenant_id = p_tenant
       and hold.teacher_id = p_teacher
       and hold.status = 'ACTIVE'
       and hold.offer_id is distinct from p_exclude_offer
       and hold.hold_until
             >= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
       and offer.revoked_at is null
       and (offer.consumed_at is not null or offer.expires_at > pg_catalog.now())
       and slot.day_of_week = p_dow
       and pg_catalog.to_char(slot.class_time, 'HH24:MI')
             = pg_catalog.left(pg_catalog.btrim(coalesce(p_time, '')), 5)
  );
$function$;

alter function private.future_start_hold_blocks(text, uuid, integer, text, uuid) owner to postgres;
revoke all on function private.future_start_hold_blocks(text, uuid, integer, text, uuid)
  from public, anon, authenticated;

-- Cria a reserva de uma oferta: uma linha por professor da grade, cada uma com
-- o seu lançamento na folha. Idempotente para o mesmo valor/mês.
create or replace function private.hold_offer_slots_until_start_core(
  p_offer_id uuid,
  p_amount numeric,
  p_student_label text,
  p_month text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer record;
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_start date;
  v_amount numeric;
  v_month text;
  v_label text;
  v_teacher record;
  v_existing public.teacher_future_start_holds%rowtype;
  v_adjustment jsonb;
  v_adjustment_id uuid;
  v_hold_id uuid;
  v_out jsonb := '[]'::jsonb;
begin
  select offer.id, offer.tenant_id, offer.kind, offer.payload,
         offer.revoked_at, offer.consumed_at, offer.expires_at
    into v_offer
    from public.offers as offer
   where offer.id = p_offer_id
   for update;
  if not found or v_offer.kind is distinct from 'ENROLLMENT' then
    raise exception 'future_start_hold_offer_not_found' using errcode = 'P0002';
  end if;
  if not private.future_start_hold_actor_can_manage(v_offer.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if v_offer.revoked_at is not null
     or (v_offer.consumed_at is null and v_offer.expires_at <= pg_catalog.now()) then
    raise exception 'future_start_hold_offer_closed' using errcode = '22023';
  end if;

  begin
    v_start := (v_offer.payload ->> 'startDate')::date;
  exception when others then
    v_start := null;
  end;
  if v_start is null or v_start <= v_today then
    raise exception 'future_start_hold_requires_future_start' using errcode = '22023';
  end if;

  if p_amount is null or p_amount = 'NaN'::numeric or p_amount <= 0 or p_amount > 1000 then
    raise exception 'future_start_hold_invalid_amount' using errcode = '22023';
  end if;
  v_amount := round(p_amount, 2);

  v_month := coalesce(nullif(pg_catalog.btrim(p_month), ''),
                      pg_catalog.to_char(v_today, 'YYYY-MM'));
  if v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'mes_invalido' using errcode = '22023';
  end if;

  v_label := pg_catalog.left(pg_catalog.btrim(coalesce(
    nullif(pg_catalog.btrim(p_student_label), ''),
    nullif(pg_catalog.btrim(v_offer.payload ->> 'studentName'), ''),
    ''
  )), 120);
  if v_label = '' then
    raise exception 'future_start_hold_student_required' using errcode = '22023';
  end if;

  for v_teacher in
    select slot.teacher_id,
           pg_catalog.string_agg(
             (array['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'])[slot.day_of_week + 1]
               || ' ' || pg_catalog.to_char(slot.class_time, 'HH24:MI'),
             ', ' order by slot.day_of_week, slot.class_time
           ) as label
      from private.enrollment_offer_schedule_slots as slot
     where slot.offer_id = p_offer_id
     group by slot.teacher_id
     order by slot.teacher_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'teacher-future-start-hold:' || v_teacher.teacher_id::text, 0
    ));

    select hold.* into v_existing
      from public.teacher_future_start_holds as hold
     where hold.offer_id = p_offer_id
       and hold.teacher_id = v_teacher.teacher_id
     for update;
    if found then
      if v_existing.status = 'ACTIVE'
         and v_existing.amount = v_amount
         and v_existing.month_year = v_month then
        v_out := v_out || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'hold_id', v_existing.id, 'teacher_id', v_existing.teacher_id,
          'amount', v_existing.amount, 'month', v_existing.month_year,
          'adjustment_id', v_existing.adjustment_id, 'slots', v_teacher.label,
          'duplicate', true
        ));
        continue;
      end if;
      raise exception 'future_start_hold_already_exists' using errcode = '23505';
    end if;

    if exists (
      select 1
        from private.enrollment_offer_schedule_slots as slot
       where slot.offer_id = p_offer_id
         and slot.teacher_id = v_teacher.teacher_id
         and private.future_start_hold_blocks(
           v_offer.tenant_id, slot.teacher_id, slot.day_of_week,
           pg_catalog.to_char(slot.class_time, 'HH24:MI'), p_offer_id
         )
    ) then
      raise exception 'teacher_slot_held' using errcode = '23P01';
    end if;

    if exists (
      select 1
        from private.enrollment_offer_schedule_slots as slot
        join public.bookings as booking
          on booking.tenant_id = v_offer.tenant_id
         and booking.teacher_id = slot.teacher_id
         and public.dow_name_to_int(booking.day_of_week) = slot.day_of_week
         and pg_catalog.left(pg_catalog.btrim(coalesce(booking.time_slot, '')), 5)
               = pg_catalog.to_char(slot.class_time, 'HH24:MI')
       where slot.offer_id = p_offer_id
         and slot.teacher_id = v_teacher.teacher_id
         and pg_catalog.upper(coalesce(booking.status, '')) = 'SCHEDULED'
         and booking.date is null
         and booking.enrollment_offer_id is distinct from p_offer_id
         and booking.enrollment_offer_slot_id is distinct from slot.id
    ) then
      raise exception 'teacher_slot_occupied' using errcode = '23P01';
    end if;

    v_adjustment := public.set_closing_adjustment(
      v_teacher.teacher_id,
      v_month,
      pg_catalog.left(
        'Reserva de agenda — ' || v_label || ' (' || v_teacher.label
          || ', início ' || pg_catalog.to_char(v_start, 'DD/MM') || ')',
        200
      ),
      v_amount,
      null
    );
    if coalesce((v_adjustment ->> 'ok')::boolean, false) is not true then
      raise exception 'future_start_hold_closing_not_pending' using errcode = '55000';
    end if;
    v_adjustment_id := (v_adjustment ->> 'id')::uuid;

    insert into public.teacher_future_start_holds (
      tenant_id, offer_id, teacher_id, student_label, amount, month_year,
      hold_until, adjustment_id, created_by
    ) values (
      v_offer.tenant_id, p_offer_id, v_teacher.teacher_id, v_label, v_amount,
      v_month, v_start, v_adjustment_id, auth.uid()
    )
    returning id into v_hold_id;

    v_out := v_out || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'hold_id', v_hold_id, 'teacher_id', v_teacher.teacher_id,
      'amount', v_amount, 'month', v_month,
      'adjustment_id', v_adjustment_id, 'slots', v_teacher.label,
      'duplicate', false
    ));
  end loop;

  if pg_catalog.jsonb_array_length(v_out) = 0 then
    raise exception 'future_start_hold_without_slots' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'offer_id', p_offer_id,
    'hold_until', pg_catalog.to_char(v_start, 'YYYY-MM-DD'),
    'holds', v_out
  );
end;
$function$;

alter function private.hold_offer_slots_until_start_core(uuid, numeric, text, text) owner to postgres;
revoke all on function private.hold_offer_slots_until_start_core(uuid, numeric, text, text)
  from public, anon, authenticated;

-- Reserva numa oferta que já existe.
create or replace function public.hold_offer_slots_until_start(
  p_offer_id uuid,
  p_amount numeric,
  p_student_label text default null,
  p_month text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select private.hold_offer_slots_until_start_core(
    p_offer_id, p_amount, p_student_label, p_month
  );
$function$;

alter function public.hold_offer_slots_until_start(uuid, numeric, text, text) owner to postgres;
revoke all on function public.hold_offer_slots_until_start(uuid, numeric, text, text)
  from public, anon;
grant execute on function public.hold_offer_slots_until_start(uuid, numeric, text, text)
  to authenticated, service_role;

-- Link + reserva no MESMO commit: se a reserva falhar (horário já segurado,
-- fechamento do mês já pago…), o link também não nasce. Porta própria ao lado
-- das portas públicas — não entra na cadeia de `create_enrollment_offer`.
create or replace function public.create_enrollment_offer_with_future_hold(
  p_payload jsonb,
  p_hold_amount numeric,
  p_student_label text,
  p_affiliate_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer_id uuid;
  v_hold jsonb;
begin
  if nullif(pg_catalog.btrim(coalesce(p_affiliate_code, '')), '') is not null then
    v_offer_id := public.create_enrollment_offer_with_affiliate(p_payload, p_affiliate_code);
  else
    v_offer_id := public.create_enrollment_offer(p_payload);
  end if;
  if v_offer_id is null then
    raise exception 'future_start_hold_offer_not_found' using errcode = 'P0002';
  end if;

  v_hold := private.hold_offer_slots_until_start_core(
    v_offer_id, p_hold_amount, p_student_label, null
  );
  return pg_catalog.jsonb_build_object('ok', true, 'offer_id', v_offer_id, 'hold', v_hold);
end;
$function$;

alter function public.create_enrollment_offer_with_future_hold(jsonb, numeric, text, text) owner to postgres;
revoke all on function public.create_enrollment_offer_with_future_hold(jsonb, numeric, text, text)
  from public, anon;
grant execute on function public.create_enrollment_offer_with_future_hold(jsonb, numeric, text, text)
  to authenticated, service_role;

-- Libera o horário. O lançamento na folha fica: o professor segurou o horário
-- até aqui. Se a direção decidir não pagar, remove pela tela de repasse.
create or replace function public.release_future_start_hold(
  p_hold_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_hold public.teacher_future_start_holds%rowtype;
begin
  select hold.* into v_hold
    from public.teacher_future_start_holds as hold
   where hold.id = p_hold_id
   for update;
  if not found then
    raise exception 'future_start_hold_not_found' using errcode = 'P0002';
  end if;
  if not private.future_start_hold_actor_can_manage(v_hold.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if v_hold.status = 'RELEASED' then
    return pg_catalog.jsonb_build_object('ok', true, 'hold_id', p_hold_id, 'already_released', true);
  end if;

  update public.teacher_future_start_holds
     set status = 'RELEASED',
         released_at = pg_catalog.now(),
         released_by = auth.uid(),
         release_reason = nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_reason, '')), 300), '')
   where id = p_hold_id;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'hold_id', p_hold_id, 'adjustment_id', v_hold.adjustment_id
  );
end;
$function$;

alter function public.release_future_start_hold(uuid, text) owner to postgres;
revoke all on function public.release_future_start_hold(uuid, text) from public, anon;
grant execute on function public.release_future_start_hold(uuid, text)
  to authenticated, service_role;

-- Reservas por horário, para o gerador de link (direção) e para a agenda do
-- professor (só as dele). jsonb de propósito: nada de `RETURNS TABLE`.
create or replace function public.list_future_start_holds(
  p_tenant_id text,
  p_teacher_ids uuid[] default null,
  p_include_inactive boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'hold_id', item.hold_id,
           'offer_id', item.offer_id,
           'teacher_id', item.teacher_id,
           'teacher_name', item.teacher_name,
           'student_label', item.student_label,
           'day_of_week', item.day_of_week,
           'class_time', item.class_time,
           'hold_until', item.hold_until,
           'amount', item.amount,
           'month_year', item.month_year,
           'status', item.status,
           'blocking', item.blocking
         ) order by item.hold_until, item.day_of_week, item.class_time), '[]'::jsonb)
    from (
      select hold.id as hold_id,
             hold.offer_id,
             hold.teacher_id,
             teacher.full_name as teacher_name,
             hold.student_label,
             slot.day_of_week::integer as day_of_week,
             pg_catalog.to_char(slot.class_time, 'HH24:MI') as class_time,
             pg_catalog.to_char(hold.hold_until, 'YYYY-MM-DD') as hold_until,
             hold.amount,
             hold.month_year,
             hold.status,
             private.future_start_hold_blocks(
               hold.tenant_id, hold.teacher_id, slot.day_of_week::integer,
               pg_catalog.to_char(slot.class_time, 'HH24:MI'), null
             ) as blocking
        from public.teacher_future_start_holds as hold
        join private.enrollment_offer_schedule_slots as slot
          on slot.offer_id = hold.offer_id
         and slot.teacher_id = hold.teacher_id
        left join public.profiles as teacher on teacher.id = hold.teacher_id
       where hold.tenant_id = p_tenant_id
         and (p_teacher_ids is null or hold.teacher_id = any (p_teacher_ids))
         and (
           private.future_start_hold_actor_can_manage(p_tenant_id)
           or hold.teacher_id = auth.uid()
         )
    ) as item
   where p_include_inactive or item.blocking;
$function$;

alter function public.list_future_start_holds(text, uuid[], boolean) owner to postgres;
revoke all on function public.list_future_start_holds(text, uuid[], boolean) from public, anon;
grant execute on function public.list_future_start_holds(text, uuid[], boolean)
  to authenticated, service_role;

-- Trava de gravação: agendamento RECORRENTE no horário segurado é recusado,
-- venha de onde vier (matrícula, troca de horário, transferência, tela). O
-- agendamento criado pela própria oferta da reserva passa. Aula com data
-- (avulsa) não é barrada.
create or replace function private.protect_teacher_future_start_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant text;
  v_teacher uuid;
  v_offer uuid;
begin
  if tg_table_name = 'bookings' then
    if pg_catalog.upper(coalesce(new.status, '')) <> 'SCHEDULED'
       or new.date is not null
       or new.teacher_id is null then
      return new;
    end if;
    if tg_op = 'UPDATE'
       and pg_catalog.upper(coalesce(old.status, '')) = 'SCHEDULED'
       and old.date is null
       and old.teacher_id is not distinct from new.teacher_id
       and old.day_of_week is not distinct from new.day_of_week
       and old.time_slot is not distinct from new.time_slot then
      return new;
    end if;
    v_tenant := new.tenant_id;
    v_teacher := new.teacher_id;
    v_offer := coalesce(
      new.enrollment_offer_id,
      (select slot.offer_id
         from private.enrollment_offer_schedule_slots as slot
        where slot.id = new.enrollment_offer_slot_id)
    );
  elsif tg_table_name = 'booking_schedule_versions' then
    if new.valid_until is not null
       and new.valid_until < (pg_catalog.now() at time zone 'America/Sao_Paulo')::date then
      return new;
    end if;
    select booking.tenant_id, booking.teacher_id, booking.enrollment_offer_id
      into v_tenant, v_teacher, v_offer
      from public.bookings as booking
     where booking.id = new.booking_id;
    if v_teacher is null then
      return new;
    end if;
  else
    return new;
  end if;

  if private.future_start_hold_blocks(
       v_tenant, v_teacher, public.dow_name_to_int(new.day_of_week),
       new.time_slot, v_offer
     ) then
    raise exception 'teacher_slot_held' using errcode = '23P01';
  end if;
  return new;
end;
$function$;

alter function private.protect_teacher_future_start_hold() owner to postgres;
revoke all on function private.protect_teacher_future_start_hold()
  from public, anon, authenticated;

drop trigger if exists zz_protect_teacher_future_start_hold on public.bookings;
create trigger zz_protect_teacher_future_start_hold
  before insert or update on public.bookings
  for each row execute function private.protect_teacher_future_start_hold();

drop trigger if exists zz_protect_teacher_future_start_hold on public.booking_schedule_versions;
create trigger zz_protect_teacher_future_start_hold
  before insert or update on public.booking_schedule_versions
  for each row execute function private.protect_teacher_future_start_hold();

-- Leituras que oferecem horário recorrente passam a enxergar a reserva.
do $migration$
declare
  v_def text;
  -- validação autoritativa da oferta (matrícula, troca pelo link, etc.)
  c_validate_old text := $old$      raise exception 'teacher_slot_occupied' using errcode = '23P01';
    end if;
$old$;
  c_validate_new text := $new$      raise exception 'teacher_slot_occupied' using errcode = '23P01';
    end if;

    -- Reserva de agenda paga de OUTRA oferta (aluno com início futuro).
    if private.future_start_hold_blocks(
      v_offer.tenant_id,
      v_slot.teacher_id,
      v_slot.day_of_week,
      pg_catalog.to_char(v_slot.class_time, 'HH24:MI'),
      p_offer_id
    ) then
      raise exception 'teacher_slot_held' using errcode = '23P01';
    end if;
$new$;
  -- horários fixos que a atendente oferece no fechamento pós-experimental
  c_closing_old text := $old$        and not exists (
          select 1 from private.trial_closing_schedule_holds as held$old$;
  c_closing_new text := $new$        and not private.future_start_hold_blocks(
          p_tenant, p_teacher, availability.day_of_week,
          to_char(availability.start_time, 'HH24:MI'), null
        )
        and not exists (
          select 1 from private.trial_closing_schedule_holds as held$new$;
  -- professor que cobre o plano do lead (experimental por capacidade)
  c_match_old text := $old$          AND COALESCE(b.status,'') NOT IN ('CANCELLED','CANCELED')
      ) AS free$old$;
  c_match_new text := $new$          AND COALESCE(b.status,'') NOT IN ('CANCELLED','CANCELED')
      ) AND NOT private.future_start_hold_blocks(p_tenant, t.id, r.dow, r.tm, NULL) AS free$new$;
  -- horários recorrentes livres por professor
  c_free_old text := $old$        AND COALESCE(b.status,'') NOT IN ('CANCELLED','CANCELED')
    )
  ),
  per_teacher AS$old$;
  c_free_new text := $new$        AND COALESCE(b.status,'') NOT IN ('CANCELLED','CANCELED')
    )
      AND NOT private.future_start_hold_blocks(p_tenant, a.teacher_id, a.dow, a.tm, NULL)
  ),
  per_teacher AS$new$;
begin
  -- 1) lock_and_validate_enrollment_schedule ---------------------------------
  v_def := pg_catalog.pg_get_functiondef(
    'private.lock_and_validate_enrollment_schedule(uuid,uuid)'::regprocedure
  );
  if position('future_start_hold_blocks' in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, c_validate_old, ''))) / length(c_validate_old) <> 1 then
      raise exception 'estrutura de lock_and_validate_enrollment_schedule mudou — revise antes de aplicar';
    end if;
    execute replace(v_def, c_validate_old, c_validate_new);
    if position('future_start_hold_blocks' in pg_catalog.pg_get_functiondef(
      'private.lock_and_validate_enrollment_schedule(uuid,uuid)'::regprocedure
    )) = 0 then
      raise exception 'reserva não entrou em lock_and_validate_enrollment_schedule';
    end if;
  end if;

  -- 2) trial_closing_free_slots ----------------------------------------------
  v_def := pg_catalog.pg_get_functiondef('private.trial_closing_free_slots(text,uuid)'::regprocedure);
  if position('future_start_hold_blocks' in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, c_closing_old, ''))) / length(c_closing_old) <> 1 then
      raise exception 'estrutura de trial_closing_free_slots mudou — revise antes de aplicar';
    end if;
    execute replace(v_def, c_closing_old, c_closing_new);
  end if;

  -- 3) match_teachers_for_plan -----------------------------------------------
  v_def := pg_catalog.pg_get_functiondef('public.match_teachers_for_plan(text,jsonb)'::regprocedure);
  if position('future_start_hold_blocks' in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, c_match_old, ''))) / length(c_match_old) <> 1 then
      raise exception 'estrutura de match_teachers_for_plan mudou — revise antes de aplicar';
    end if;
    execute replace(v_def, c_match_old, c_match_new);
  end if;

  -- 4) teacher_free_recurring_slots ------------------------------------------
  v_def := pg_catalog.pg_get_functiondef('public.teacher_free_recurring_slots(text)'::regprocedure);
  if position('future_start_hold_blocks' in v_def) = 0 then
    if (length(v_def) - length(replace(v_def, c_free_old, ''))) / length(c_free_old) <> 1 then
      raise exception 'estrutura de teacher_free_recurring_slots mudou — revise antes de aplicar';
    end if;
    execute replace(v_def, c_free_old, c_free_new);
  end if;
end
$migration$;
