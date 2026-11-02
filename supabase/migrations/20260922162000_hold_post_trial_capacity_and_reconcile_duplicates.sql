-- Reserva temporaria da grade enquanto um lead decide o fechamento.
--
-- Uma experimental concluida nao pode devolver imediatamente ao SDR os mesmos
-- dias/horarios que o aluno acabou de pedir. A reserva dura sete dias (ou ate o
-- fluxo virar OFFER_SENT/NO_SHOW) e e substituida pela reserva da oferta quando
-- o link de matricula e criado.

create table if not exists private.trial_closing_schedule_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  flow_id uuid not null,
  opportunity_id uuid not null,
  teacher_id uuid not null,
  day_of_week smallint not null check (day_of_week between 1 and 6),
  class_time time not null,
  status text not null default 'HELD' check (status in ('HELD', 'RELEASED')),
  expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table private.trial_closing_schedule_holds owner to postgres;
alter table private.trial_closing_schedule_holds enable row level security;

create unique index if not exists uq_trial_closing_schedule_holds_active_slot
  on private.trial_closing_schedule_holds (flow_id, day_of_week, class_time)
  where status = 'HELD';

create index if not exists ix_trial_closing_schedule_holds_teacher_slot
  on private.trial_closing_schedule_holds
    (tenant_id, teacher_id, day_of_week, class_time, expires_at)
  where status = 'HELD';

create or replace function private.trial_closing_sync_schedule_holds(p_flow_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_frequency integer;
  v_time time;
  v_trial_day integer;
  v_has_explicit_slots boolean;
begin
  select * into v_flow
  from private.trial_closing_flows
  where id = p_flow_id;

  if not found then return; end if;

  update private.trial_closing_schedule_holds
     set status = 'RELEASED', released_at = now(),
         release_reason = case
           when v_flow.stage in ('OFFER_SENT', 'NO_SHOW') then lower(v_flow.stage)
           else 'plan_changed'
         end,
         updated_at = now()
   where flow_id = v_flow.id and status = 'HELD';

  if v_flow.stage <> 'ASK_STUDENT' then return; end if;

  begin
    v_frequency := nullif(v_flow.plan ->> 'frequency', '')::integer;
  exception when invalid_text_representation then
    v_frequency := null;
  end;
  if v_frequency not between 1 and 6 then return; end if;

  select
    extract(dow from appointment.start_time at time zone 'America/Sao_Paulo')::integer,
    (appointment.start_time at time zone 'America/Sao_Paulo')::time
    into v_trial_day, v_time
  from public.appointments as appointment
  where appointment.id = v_flow.appointment_id;

  v_time := to_char(v_time, 'HH24:MI')::time;
  v_has_explicit_slots := coalesce(
    jsonb_typeof(v_flow.plan -> 'slots') = 'array'
      and jsonb_array_length(v_flow.plan -> 'slots') > 0,
    false
  );

  perform pg_advisory_xact_lock(
    hashtextextended(v_flow.tenant_id || ':' || v_flow.teacher_id::text || ':' || v_time::text, 0)
  );

  insert into private.trial_closing_schedule_holds (
    tenant_id, flow_id, opportunity_id, teacher_id,
    day_of_week, class_time, status, expires_at
  )
  select v_flow.tenant_id, v_flow.id, v_flow.opportunity_id, v_flow.teacher_id,
         candidate.day_of_week, candidate.class_time, 'HELD', 'infinity'::timestamptz
  from (
    select available.day_of_week, available.class_time
    from (
      select distinct availability.day_of_week,
        case
          when v_has_explicit_slots then (slot.item ->> 'time')::time
          else v_time
        end as class_time,
        case
          when v_has_explicit_slots then slot.ordinality::integer
          when availability.day_of_week = v_trial_day then 0
          else availability.day_of_week + 10
        end as priority
      from public.teacher_availability as availability
      left join lateral jsonb_array_elements(
        case when v_has_explicit_slots then v_flow.plan -> 'slots' else '[]'::jsonb end
      ) with ordinality as slot(item, ordinality) on v_has_explicit_slots
      where availability.tenant_id = v_flow.tenant_id
        and availability.teacher_id = v_flow.teacher_id
        and availability.day_of_week between 1 and 6
        and (
          (v_has_explicit_slots
           and availability.day_of_week = public.dow_name_to_int(slot.item ->> 'day')
           and availability.start_time = (slot.item ->> 'time')::time)
          or
          (not v_has_explicit_slots and availability.start_time = v_time)
        )
    ) as available
    where not exists (
      select 1 from public.bookings as booking
      where booking.tenant_id = v_flow.tenant_id
        and booking.teacher_id = v_flow.teacher_id
        and upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED'
        and public.dow_name_to_int(booking.day_of_week) = available.day_of_week
        and left(trim(coalesce(booking.time_slot, '')), 5) = to_char(available.class_time, 'HH24:MI')
    )
    and not exists (
      select 1 from private.enrollment_offer_schedule_slots as reserved
      where reserved.tenant_id = v_flow.tenant_id
        and reserved.teacher_id = v_flow.teacher_id
        and reserved.status = 'RESERVED'
        and reserved.reservation_expires_at > now()
        and reserved.day_of_week = available.day_of_week
        and abs(extract(epoch from (reserved.class_time - available.class_time))) < 1800
    )
    and not exists (
      select 1 from private.trial_closing_schedule_holds as held
      where held.tenant_id = v_flow.tenant_id
        and held.teacher_id = v_flow.teacher_id
        and held.flow_id <> v_flow.id
        and held.status = 'HELD' and held.expires_at > now()
        and held.day_of_week = available.day_of_week
        and abs(extract(epoch from (held.class_time - available.class_time))) < 1800
    )
    -- Uma experimental futura ja aceita conserva o seu dia. Assim a reserva
    -- pos-experimental ocupa os outros dias, em vez de atropelar o proximo lead.
    and not exists (
      select 1
      from public.appointments as appointment
      join public.opportunities as opportunity
        on opportunity.trial_appointment_id = appointment.id
       and opportunity.tenant_id = appointment.tenant_id
      where appointment.tenant_id = v_flow.tenant_id
        and coalesce(appointment.teacher_id, appointment.professor_id) = v_flow.teacher_id
        and appointment.id <> v_flow.appointment_id
        and lower(coalesce(appointment.status, '')) in ('scheduled', 'confirmed')
        and appointment.start_time > now()
        and opportunity.kind = 'TRIAL'
        and opportunity.status = 'CLAIMED'
        and extract(dow from appointment.start_time at time zone 'America/Sao_Paulo')::integer
              = available.day_of_week
        and abs(extract(epoch from (
          (appointment.start_time at time zone 'America/Sao_Paulo')::time - available.class_time
        ))) < 1800
    )
    order by available.priority, available.day_of_week
    limit v_frequency
  ) as candidate;
end;
$function$;

alter function private.trial_closing_sync_schedule_holds(uuid) owner to postgres;
revoke all on function private.trial_closing_sync_schedule_holds(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.trial_closing_sync_schedule_holds(uuid) to postgres;

-- O fechamento de outros leads tambem deixa de oferecer os dias reservados.
create or replace function private.trial_closing_free_slots(p_tenant text, p_teacher uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('day', slot.day_name, 'time', slot.hhmm)
    order by slot.day_of_week, slot.hhmm
  ), '[]'::jsonb)
  from (
    select livre.day_of_week, livre.day_name, livre.hhmm
    from (
      select distinct availability.day_of_week,
        public.canonical_weekday_name(
          case availability.day_of_week
            when 1 then 'Segunda' when 2 then 'Terça' when 3 then 'Quarta'
            when 4 then 'Quinta' when 5 then 'Sexta' when 6 then 'Sábado'
            else 'Domingo' end
        ) as day_name,
        to_char(availability.start_time, 'HH24:MI') as hhmm
      from public.teacher_availability as availability
      where availability.tenant_id = p_tenant
        and availability.teacher_id = p_teacher
        and availability.day_of_week between 1 and 6
        and not exists (
          select 1 from public.bookings as booking
          where booking.tenant_id = p_tenant
            and booking.teacher_id = p_teacher
            and upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED'
            and public.dow_name_to_int(booking.day_of_week) = availability.day_of_week
            and left(trim(coalesce(booking.time_slot, '')), 5) =
                to_char(availability.start_time, 'HH24:MI')
        )
        and not exists (
          select 1 from private.trial_closing_schedule_holds as held
          where held.tenant_id = p_tenant and held.teacher_id = p_teacher
            and held.status = 'HELD' and held.expires_at > now()
            and held.day_of_week = availability.day_of_week
            and abs(extract(epoch from (held.class_time - availability.start_time))) < 1800
        )
    ) as livre
    where (
      select count(*)
      from (
        select distinct earlier.start_time
        from public.teacher_availability as earlier
        where earlier.tenant_id = p_tenant
          and earlier.teacher_id = p_teacher
          and earlier.day_of_week = livre.day_of_week
          and to_char(earlier.start_time, 'HH24:MI') < livre.hhmm
      ) as earlier_slots
    ) < 2
    order by livre.day_of_week, livre.hhmm
    limit 12
  ) as slot;
$$;

alter function private.trial_closing_free_slots(text, uuid) owner to postgres;
revoke all on function private.trial_closing_free_slots(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.trial_closing_free_slots(text, uuid) to postgres;

create or replace function private.trial_closing_schedule_holds_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.trial_closing_sync_schedule_holds(new.id);
  return new;
end;
$function$;

alter function private.trial_closing_schedule_holds_trigger() owner to postgres;

drop trigger if exists trg_trial_closing_schedule_holds
  on private.trial_closing_flows;
create trigger trg_trial_closing_schedule_holds
after insert or update of plan, stage on private.trial_closing_flows
for each row execute function private.trial_closing_schedule_holds_trigger();

-- A reserva termina pela decisao registrada, nao por um relogio arbitrario.
-- Ao ganhar/perder/cancelar a oportunidade, qualquer hold residual e liberado.
create or replace function private.release_trial_closing_holds_on_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if upper(coalesce(new.conversion_status, 'OPEN')) in ('LOST', 'WON', 'CONVERTED')
     or upper(coalesce(new.status, 'OPEN')) in ('CANCELED', 'CANCELLED', 'EXPIRED') then
    update private.trial_closing_schedule_holds
       set status = 'RELEASED', released_at = now(),
           release_reason = 'opportunity_' || lower(coalesce(new.conversion_status, new.status)),
           updated_at = now()
     where opportunity_id = new.id and status = 'HELD';
  end if;
  return new;
end;
$function$;

alter function private.release_trial_closing_holds_on_decision() owner to postgres;

drop trigger if exists trg_release_trial_closing_holds_on_decision
  on public.opportunities;
create trigger trg_release_trial_closing_holds_on_decision
after update of status, conversion_status on public.opportunities
for each row execute function private.release_trial_closing_holds_on_decision();

-- O caminho de listagem da IA e o caminho atomico de aceite consultam a mesma
-- reserva. Sem isto, uma chamada manual poderia passar entre a sugestao e o aceite.
create or replace function private.secure_trial_schedule_conflict(
  p_tenant_id text,
  p_teacher_id uuid,
  p_start_time timestamptz,
  p_exclude_appointment_id uuid default null,
  p_exclude_enrollment_link_id uuid default null
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    p_tenant_id is null or p_teacher_id is null or p_start_time is null
    or exists (
      select 1 from public.appointments as appointment
      where appointment.tenant_id = p_tenant_id
        and appointment.id is distinct from p_exclude_appointment_id
        and (appointment.teacher_id = p_teacher_id or appointment.professor_id = p_teacher_id)
        and lower(coalesce(appointment.status, '')) in ('scheduled', 'confirmed')
        and appointment.start_time > p_start_time - interval '30 minutes'
        and appointment.start_time < p_start_time + interval '30 minutes'
    )
    or exists (
      select 1 from public.bookings as booking
      where booking.tenant_id = p_tenant_id and booking.teacher_id = p_teacher_id
        and lower(coalesce(booking.status, 'scheduled')) not in ('cancelled', 'canceled', 'inactive')
        and public.dow_name_to_int(booking.day_of_week) =
          extract(dow from p_start_time at time zone 'America/Sao_Paulo')::integer
        and (booking.date is null or booking.date = (p_start_time at time zone 'America/Sao_Paulo')::date)
        and case when trim(coalesce(booking.time_slot, '')) ~
          '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
          then abs(extract(epoch from (
            left(trim(booking.time_slot), 5)::time -
            (p_start_time at time zone 'America/Sao_Paulo')::time
          ))) < 1800 else false end
    )
    or exists (
      select 1 from private.vendor_trial_teacher_requests as request
      where request.tenant_id = p_tenant_id
        and request.target_teacher_id = p_teacher_id
        and (p_exclude_enrollment_link_id is null
             or request.enrollment_link_id is distinct from p_exclude_enrollment_link_id)
        and request.status in ('AWAITING_STUDENT', 'AWAITING_TEACHER')
        and request.slot_start > p_start_time - interval '30 minutes'
        and request.slot_start < p_start_time + interval '30 minutes'
    )
    or exists (
      select 1 from private.trial_closing_schedule_holds as held
      where held.tenant_id = p_tenant_id and held.teacher_id = p_teacher_id
        and held.status = 'HELD' and held.expires_at > now()
        and held.day_of_week = extract(dow from p_start_time at time zone 'America/Sao_Paulo')::integer
        and abs(extract(epoch from (
          held.class_time - (p_start_time at time zone 'America/Sao_Paulo')::time
        ))) < 1800
    );
$function$;

alter function private.secure_trial_schedule_conflict(text, uuid, timestamptz, uuid, uuid)
  owner to postgres;
revoke all on function private.secure_trial_schedule_conflict(text, uuid, timestamptz, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.secure_trial_schedule_conflict(text, uuid, timestamptz, uuid, uuid)
  to postgres;

-- Visibilidade operacional sem expor a tabela privada.
create or replace function public.trial_closing_capacity_hold(p_flow_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'requested_frequency', nullif(flow.plan ->> 'frequency', '')::integer,
    'held_frequency', count(held.id),
    'slots', coalesce(jsonb_agg(
      jsonb_build_object(
        'day', public.canonical_weekday_name(case held.day_of_week
          when 1 then 'Segunda' when 2 then 'Terça' when 3 then 'Quarta'
          when 4 then 'Quinta' when 5 then 'Sexta' when 6 then 'Sábado' end),
        'time', to_char(held.class_time, 'HH24:MI'),
        'expires_at', held.expires_at
      ) order by held.day_of_week
    ) filter (where held.id is not null), '[]'::jsonb)
  )
  from private.trial_closing_flows as flow
  left join private.trial_closing_schedule_holds as held
    on held.flow_id = flow.id and held.status = 'HELD' and held.expires_at > now()
  where flow.id = p_flow_id
  group by flow.id, flow.plan;
$function$;

alter function public.trial_closing_capacity_hold(uuid) owner to postgres;
revoke all on function public.trial_closing_capacity_hold(uuid)
  from public, anon, authenticated;
grant execute on function public.trial_closing_capacity_hold(uuid) to service_role;

-- Auditoria antes de conciliar os registros historicos duplicados.
create table if not exists private.trial_duplicate_reconciliation_audit (
  opportunity_id uuid primary key,
  tenant_id text not null,
  reason text not null,
  snapshot jsonb not null,
  reconciled_at timestamptz not null default now()
);
alter table private.trial_duplicate_reconciliation_audit owner to postgres;
alter table private.trial_duplicate_reconciliation_audit enable row level security;

insert into private.trial_duplicate_reconciliation_audit (
  opportunity_id, tenant_id, reason, snapshot
)
select opportunity.id, opportunity.tenant_id, 'duplicate_trial_record',
  jsonb_build_object(
    'opportunity', to_jsonb(opportunity),
    'appointment', to_jsonb(appointment),
    'closing_flow', to_jsonb(flow)
  )
from public.opportunities as opportunity
left join public.appointments as appointment on appointment.id = opportunity.trial_appointment_id
left join private.trial_closing_flows as flow on flow.opportunity_id = opportunity.id
where opportunity.id in (
  '1171632c-73dc-4a2d-891b-4e400f251685'::uuid, -- Andre / Debora (cancelada)
  '1521aec1-2ee2-43f5-a71b-887146b1f4cf'::uuid, -- Naraci / Lais
  'a4994ee5-9a99-455f-a6ed-6e151da83692'::uuid, -- Matheus / Lais
  '51921592-1e30-4452-8433-f16f8cd715dc'::uuid  -- Clessio / Juliana
)
on conflict (opportunity_id) do nothing;

update public.appointments
set status = 'cancelled'
where id in (
  'cf0b3aa2-4f15-4c88-84e1-d1a9f43dd77f'::uuid,
  '21ede11c-cfb9-4225-a127-1a32bf01d644'::uuid,
  '52b273df-9bec-4c22-8eed-aec388a60f8e'::uuid,
  '161801ae-09e0-40c1-830c-a98b94e2e4cd'::uuid
);

update public.opportunities
set status = 'CANCELED', trial_status = 'CANCELLED', conversion_status = 'LOST',
    lost_reason = 'Registro duplicado conciliado em 22/09/2026; histórico preservado.'
where id in (
  '1171632c-73dc-4a2d-891b-4e400f251685'::uuid,
  '1521aec1-2ee2-43f5-a71b-887146b1f4cf'::uuid,
  'a4994ee5-9a99-455f-a6ed-6e151da83692'::uuid,
  '51921592-1e30-4452-8433-f16f8cd715dc'::uuid
);

update private.trial_closing_flows
set stage = 'NO_SHOW', outcome = 'DUPLICATE_CANCELLED',
    last_error = 'duplicate_record_reconciled', updated_at = now()
where opportunity_id in (
  '1521aec1-2ee2-43f5-a71b-887146b1f4cf'::uuid,
  'a4994ee5-9a99-455f-a6ed-6e151da83692'::uuid,
  '51921592-1e30-4452-8433-f16f8cd715dc'::uuid
);

-- A resposta "2x" do Andre existia no WhatsApp, mas nao tinha sido persistida
-- no plano do fluxo. O trigger reserva quinta (dia da experimental) e sexta;
-- quarta permanece para a experimental ja aceita da Ana Carolina.
update private.trial_closing_flows
set plan = plan || jsonb_build_object('frequency', 2), updated_at = now()
where id = '5acc03b5-a16b-44c2-8d03-0dcc9ad205ab'::uuid
  and stage = 'ASK_STUDENT'
  and coalesce(plan ->> 'frequency', '') = '';

-- Corrige uma eventual aplicacao anterior desta mesma migration, quando a
-- reserva ainda usava prazo. A partir daqui, somente a decisao a libera.
update private.trial_closing_schedule_holds
set expires_at = 'infinity'::timestamptz, updated_at = now()
where status = 'HELD';

notify pgrst, 'reload schema';
