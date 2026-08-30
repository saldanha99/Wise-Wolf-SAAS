begin;

-- A grade acadêmica deixa de existir apenas como JSON mutável. Cada slot da
-- oferta ganha identidade própria para que validação, reserva e materialização
-- sejam serializadas no banco antes de qualquer chamada ao provedor financeiro.
create table if not exists private.enrollment_offer_schedule_slots (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  offer_id uuid not null references public.offers(id) on delete cascade,
  tenant_id text not null references public.tenants(id) on delete cascade,
  slot_index smallint not null check (slot_index > 0),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  day_name text not null,
  class_time time without time zone not null,
  start_date date not null,
  status text not null default 'OFFERED' check (
    status in ('OFFERED', 'RESERVED', 'MATERIALIZED', 'RELEASED')
  ),
  reserved_by uuid references auth.users(id) on delete set null,
  reserved_at timestamptz,
  reservation_expires_at timestamptz,
  materialized_booking_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (offer_id, slot_index),
  unique (offer_id, teacher_id, day_of_week, class_time),
  unique (id, offer_id),
  check (day_name = public.canonical_weekday_name(day_name)),
  check (
    (status = 'OFFERED' and reserved_by is null and reserved_at is null)
    or (status = 'RELEASED')
    or (
      status in ('RESERVED', 'MATERIALIZED')
      and reserved_by is not null
      and reserved_at is not null
    )
  ),
  check (
    (status = 'MATERIALIZED' and materialized_booking_id is not null)
    or (status <> 'MATERIALIZED' and materialized_booking_id is null)
  )
);

alter table private.enrollment_offer_schedule_slots enable row level security;
alter table private.enrollment_offer_schedule_slots force row level security;

revoke all on table private.enrollment_offer_schedule_slots
  from public, anon, authenticated, service_role;

create index if not exists enrollment_offer_schedule_slots_offer_state_idx
  on private.enrollment_offer_schedule_slots (offer_id, status, slot_index);
create index if not exists enrollment_offer_schedule_slots_teacher_key_idx
  on private.enrollment_offer_schedule_slots (
    tenant_id, teacher_id, day_of_week, class_time, status
  );
create index if not exists enrollment_offer_schedule_slots_reserved_by_idx
  on private.enrollment_offer_schedule_slots (reserved_by, status)
  where reserved_by is not null;
create unique index if not exists enrollment_offer_schedule_slots_active_key_uidx
  on private.enrollment_offer_schedule_slots (
    tenant_id, teacher_id, day_of_week, class_time
  )
  where status in ('RESERVED', 'MATERIALIZED');

alter table public.bookings
  add column if not exists enrollment_offer_id uuid,
  add column if not exists enrollment_offer_slot_id uuid;

do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_enrollment_offer_pair_check'
  ) then
    alter table public.bookings
      add constraint bookings_enrollment_offer_pair_check
      check (
        (enrollment_offer_id is null and enrollment_offer_slot_id is null)
        or (enrollment_offer_id is not null and enrollment_offer_slot_id is not null)
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_enrollment_offer_slot_fkey'
  ) then
    alter table public.bookings
      add constraint bookings_enrollment_offer_slot_fkey
      foreign key (enrollment_offer_slot_id, enrollment_offer_id)
      references private.enrollment_offer_schedule_slots (id, offer_id)
      on delete set null
      not valid;
  end if;
end
$constraints$;

create index if not exists bookings_enrollment_offer_idx
  on public.bookings (enrollment_offer_id)
  where enrollment_offer_id is not null;
create unique index if not exists bookings_enrollment_offer_slot_uidx
  on public.bookings (enrollment_offer_slot_id)
  where enrollment_offer_slot_id is not null;

-- Normaliza integralmente o payload comercial. Valores de pro-rata enviados
-- pelo navegador são removidos e recalculados a partir da grade validada.
create or replace function private.prepare_enrollment_offer_payload(
  p_payload jsonb,
  p_tenant_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_schedule jsonb;
  v_normalized_schedule jsonb := '[]'::jsonb;
  v_slot jsonb;
  v_slot_index integer;
  v_raw_teacher text;
  v_teacher_id uuid;
  v_teacher_ids uuid[] := array[]::uuid[];
  v_raw_primary_teacher text;
  v_raw_secondary_teacher text;
  v_primary_teacher_id uuid;
  v_secondary_teacher_id uuid;
  v_other_teacher_id uuid;
  v_raw_day text;
  v_day smallint;
  v_raw_time text;
  v_time time without time zone;
  v_time_text text;
  v_day_en text;
  v_frequency_numeric numeric;
  v_frequency integer;
  v_due_numeric numeric;
  v_due_day integer;
  v_duration_numeric numeric;
  v_duration integer := 1;
  v_value numeric;
  v_start_text text;
  v_start_date date;
  v_billing_month text;
  v_billing_year integer;
  v_billing_month_number integer;
  v_month_first date;
  v_first_billing_date date;
  v_today date := (pg_catalog.clock_timestamp()
    at time zone 'America/Sao_Paulo')::date;
  v_enable_pro_rata boolean := false;
  v_is_dependent boolean := false;
  v_student_phone text;
  v_local_student_phone text;
  v_guardian_id uuid;
  v_guardian record;
  v_guardian_found boolean := false;
  v_guardian_cpf text;
  v_guardian_phone text;
  v_local_guardian_phone text;
  v_class_count integer := 0;
  v_price_per_class numeric;
  v_pro_rata_value numeric;
  v_result jsonb;
begin
  if p_payload is null
    or pg_catalog.jsonb_typeof(p_payload) is distinct from 'object'
    or p_tenant_id is null
  then
    raise exception 'invalid_enrollment_offer' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_payload -> 'classesPerWeek')
       is distinct from 'number'
    or pg_catalog.jsonb_typeof(v_payload -> 'dueDay')
       is distinct from 'number'
    or pg_catalog.jsonb_typeof(v_payload -> 'value')
       is distinct from 'number'
  then
    raise exception 'invalid_enrollment_commercial_terms'
      using errcode = '22023';
  end if;

  begin
    v_frequency_numeric := (v_payload ->> 'classesPerWeek')::numeric;
    v_due_numeric := (v_payload ->> 'dueDay')::numeric;
    v_value := (v_payload ->> 'value')::numeric;
  exception when others then
    raise exception 'invalid_enrollment_commercial_terms'
      using errcode = '22023';
  end;

  if v_frequency_numeric <> pg_catalog.trunc(v_frequency_numeric)
    or v_frequency_numeric not between 1 and 7
    or v_due_numeric <> pg_catalog.trunc(v_due_numeric)
    or v_due_numeric not between 1 and 31
    or v_value <= 0
  then
    raise exception 'invalid_enrollment_commercial_terms'
      using errcode = '22023';
  end if;
  v_frequency := v_frequency_numeric::integer;
  v_due_day := v_due_numeric::integer;

  if v_payload ? 'planDuration' then
    if pg_catalog.jsonb_typeof(v_payload -> 'planDuration')
         is distinct from 'number'
    then
      raise exception 'invalid_enrollment_commercial_terms'
        using errcode = '22023';
    end if;
    begin
      v_duration_numeric := (v_payload ->> 'planDuration')::numeric;
    exception when others then
      raise exception 'invalid_enrollment_commercial_terms'
        using errcode = '22023';
    end;
    if v_duration_numeric <> pg_catalog.trunc(v_duration_numeric)
      or v_duration_numeric not in (0, 1, 6, 12)
    then
      raise exception 'invalid_enrollment_commercial_terms'
        using errcode = '22023';
    end if;
    v_duration := v_duration_numeric::integer;
  end if;

  v_schedule := v_payload -> 'schedule';
  if pg_catalog.jsonb_typeof(v_schedule) is distinct from 'array'
    or pg_catalog.jsonb_array_length(v_schedule) = 0
  then
    raise exception 'enrollment_schedule_required' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(v_schedule) <> v_frequency then
    raise exception 'enrollment_schedule_cardinality_mismatch'
      using errcode = '22023';
  end if;

  v_start_text := pg_catalog.btrim(coalesce(v_payload ->> 'startDate', ''));
  if v_start_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'invalid_enrollment_billing_period' using errcode = '22023';
  end if;
  begin
    v_start_date := v_start_text::date;
  exception when others then
    raise exception 'invalid_enrollment_billing_period' using errcode = '22023';
  end;
  if pg_catalog.to_char(v_start_date, 'YYYY-MM-DD') <> v_start_text then
    raise exception 'invalid_enrollment_billing_period' using errcode = '22023';
  end if;
  if v_start_date < v_today then
    raise exception 'invalid_enrollment_billing_period' using errcode = '22023';
  end if;

  v_billing_month := pg_catalog.btrim(
    coalesce(v_payload ->> 'billingStartMonth', '')
  );
  if v_billing_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid_enrollment_billing_period' using errcode = '22023';
  end if;
  begin
    v_billing_year := pg_catalog.substr(v_billing_month, 1, 4)::integer;
    v_billing_month_number := pg_catalog.substr(v_billing_month, 6, 2)::integer;
    v_month_first := pg_catalog.make_date(
      v_billing_year,
      v_billing_month_number,
      1
    );
    v_first_billing_date := pg_catalog.make_date(
      v_billing_year,
      v_billing_month_number,
      least(
        v_due_day,
        extract(
          day from (v_month_first + interval '1 month - 1 day')
        )::integer
      )
    );
  exception when others then
    raise exception 'invalid_enrollment_billing_period' using errcode = '22023';
  end;
  while v_first_billing_date < v_today loop
    v_month_first := (v_month_first + interval '1 month')::date;
    v_first_billing_date := v_month_first + least(
      v_due_day,
      extract(
        day from (v_month_first + interval '1 month - 1 day')
      )::integer
    ) - 1;
  end loop;
  if v_first_billing_date < v_start_date then
    raise exception 'invalid_enrollment_billing_period' using errcode = '22023';
  end if;

  if v_payload ? 'enableProRata' then
    if pg_catalog.jsonb_typeof(v_payload -> 'enableProRata')
         is distinct from 'boolean'
    then
      raise exception 'invalid_enrollment_billing_period' using errcode = '22023';
    end if;
    v_enable_pro_rata := (v_payload ->> 'enableProRata')::boolean;
  end if;
  if v_payload ? 'isDependent' then
    if pg_catalog.jsonb_typeof(v_payload -> 'isDependent')
         is distinct from 'boolean'
    then
      raise exception 'invalid_enrollment_offer' using errcode = '22023';
    end if;
    v_is_dependent := (v_payload ->> 'isDependent')::boolean;
  end if;
  if v_duration = 0 and v_enable_pro_rata then
    raise exception 'pro_rata_not_applicable' using errcode = '22023';
  end if;

  for v_slot, v_slot_index in
    select item.value, item.ordinality::integer
    from pg_catalog.jsonb_array_elements(v_schedule)
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if pg_catalog.jsonb_typeof(v_slot) is distinct from 'object' then
      raise exception 'invalid_enrollment_schedule' using errcode = '22023';
    end if;

    v_raw_teacher := coalesce(
      nullif(pg_catalog.btrim(v_slot ->> 'teacherId'), ''),
      nullif(pg_catalog.btrim(v_slot ->> 'professorId'), ''),
      nullif(pg_catalog.btrim(v_payload ->> 'professorId'), '')
    );
    if v_raw_teacher is null
      or v_raw_teacher !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then
      raise exception 'invalid_enrollment_schedule' using errcode = '22023';
    end if;
    v_teacher_id := v_raw_teacher::uuid;

    v_raw_day := pg_catalog.btrim(
      coalesce(v_slot ->> 'day', v_slot ->> 'weekday', '')
    );
    if v_raw_day ~ '^[0-6]$' then
      v_day := v_raw_day::smallint;
    else
      v_day := public.dow_name_to_int(v_raw_day)::smallint;
    end if;
    if v_day is null or v_day not between 0 and 6 then
      raise exception 'invalid_enrollment_schedule' using errcode = '22023';
    end if;

    v_raw_time := pg_catalog.btrim(coalesce(v_slot ->> 'time', ''));
    if v_raw_time !~ '^(?:[0-9]|[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$' then
      raise exception 'invalid_enrollment_schedule' using errcode = '22023';
    end if;
    v_time := v_raw_time::time;
    v_time_text := pg_catalog.to_char(v_time, 'HH24:MI');

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_normalized_schedule) as prior(slot)
      where public.dow_name_to_int(prior.slot ->> 'day') = v_day
        and prior.slot ->> 'time' = v_time_text
    ) then
      raise exception 'duplicate_enrollment_schedule_slot'
        using errcode = '22023';
    end if;

    if pg_catalog.array_position(v_teacher_ids, v_teacher_id) is null then
      v_teacher_ids := pg_catalog.array_append(v_teacher_ids, v_teacher_id);
    end if;
    if pg_catalog.array_length(v_teacher_ids, 1) > 2 then
      raise exception 'invalid_enrollment_schedule' using errcode = '22023';
    end if;

    v_day_en := case v_day
      when 0 then 'Sunday'
      when 1 then 'Monday'
      when 2 then 'Tuesday'
      when 3 then 'Wednesday'
      when 4 then 'Thursday'
      when 5 then 'Friday'
      when 6 then 'Saturday'
    end;
    v_normalized_schedule := v_normalized_schedule || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'day', v_day_en,
        'weekday', v_day_en,
        'time', v_time_text,
        'teacherId', v_teacher_id,
        'professorId', v_teacher_id
      )
    );
  end loop;

  if coalesce(pg_catalog.array_length(v_teacher_ids, 1), 0) not between 1 and 2 then
    raise exception 'invalid_enrollment_schedule' using errcode = '22023';
  end if;

  v_raw_primary_teacher := nullif(
    pg_catalog.btrim(v_payload ->> 'professorId'),
    ''
  );
  v_raw_secondary_teacher := nullif(
    pg_catalog.btrim(v_payload ->> 'professorId2'),
    ''
  );
  if v_raw_primary_teacher is not null then
    if v_raw_primary_teacher !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then
      raise exception 'invalid_enrollment_schedule' using errcode = '22023';
    end if;
    v_primary_teacher_id := v_raw_primary_teacher::uuid;
    if pg_catalog.array_position(v_teacher_ids, v_primary_teacher_id) is null then
      raise exception 'invalid_enrollment_schedule' using errcode = '22023';
    end if;

    if pg_catalog.array_length(v_teacher_ids, 1) = 2 then
      v_other_teacher_id := case
        when v_teacher_ids[1] = v_primary_teacher_id then v_teacher_ids[2]
        else v_teacher_ids[1]
      end;
      v_teacher_ids := array[v_primary_teacher_id, v_other_teacher_id];
    else
      v_teacher_ids := array[v_primary_teacher_id];
    end if;
  else
    v_primary_teacher_id := v_teacher_ids[1];
  end if;

  if v_raw_secondary_teacher is not null then
    if v_raw_primary_teacher is null
      or v_raw_secondary_teacher !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then
      raise exception 'invalid_enrollment_schedule' using errcode = '22023';
    end if;
    v_secondary_teacher_id := v_raw_secondary_teacher::uuid;
    if pg_catalog.array_length(v_teacher_ids, 1) <> 2
      or v_secondary_teacher_id is distinct from v_teacher_ids[2]
    then
      raise exception 'invalid_enrollment_schedule' using errcode = '22023';
    end if;
  elsif pg_catalog.array_length(v_teacher_ids, 1) = 2 then
    v_secondary_teacher_id := v_teacher_ids[2];
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(v_teacher_ids) as requested(teacher_id)
    where not exists (
      select 1
      from public.profiles as teacher
      join public.tenant_memberships as membership
        on membership.user_id = teacher.id
       and membership.tenant_id = teacher.tenant_id
       and membership.role = 'TEACHER'
       and membership.status = 'ACTIVE'
      where teacher.id = requested.teacher_id
        and teacher.tenant_id = p_tenant_id
        and teacher.role = 'TEACHER'
        and pg_catalog.lower(pg_catalog.btrim(teacher.lifecycle_status)) = 'active'
    )
  ) then
    raise exception 'inactive_enrollment_teacher' using errcode = '42501';
  end if;

  v_student_phone := pg_catalog.regexp_replace(
    coalesce(v_payload ->> 'studentPhone', ''),
    '[^0-9]',
    '',
    'g'
  );
  v_local_student_phone := case
    when pg_catalog.length(v_student_phone) = 13
      and pg_catalog.left(v_student_phone, 2) = '55'
    then pg_catalog.substr(v_student_phone, 3)
    else v_student_phone
  end;
  if v_is_dependent and (
    v_local_student_phone !~ '^[1-9]{2}9[0-9]{8}$'
    or pg_catalog.substr(v_local_student_phone, 3)
       = pg_catalog.repeat(pg_catalog.substr(v_local_student_phone, 3, 1), 9)
  ) then
    raise exception 'dependent_student_phone_invalid' using errcode = '22023';
  end if;

  if v_is_dependent then
    begin
      v_guardian_id := nullif(
        pg_catalog.btrim(v_payload ->> 'guardianId'),
        ''
      )::uuid;
    exception when others then
      raise exception 'dependent_guardian_contact_invalid'
        using errcode = '22023';
    end;

    select
      guardian.full_name,
      guardian.email,
      guardian.cpf,
      guardian.phone,
      guardian.postal_code,
      guardian.address,
      guardian.address_number,
      guardian.lifecycle_status
    into v_guardian
    from public.profiles as guardian
    join public.tenant_memberships as membership
      on membership.user_id = guardian.id
     and membership.tenant_id = guardian.tenant_id
     and membership.status = 'ACTIVE'
    where guardian.id = v_guardian_id
      and guardian.tenant_id = p_tenant_id
    for update of guardian, membership;
    v_guardian_found := found;

    v_guardian_cpf := pg_catalog.regexp_replace(
      coalesce(v_guardian.cpf, ''),
      '[^0-9]',
      '',
      'g'
    );
    v_guardian_phone := pg_catalog.regexp_replace(
      coalesce(v_guardian.phone, ''),
      '[^0-9]',
      '',
      'g'
    );
    v_local_guardian_phone := case
      when pg_catalog.length(v_guardian_phone) = 13
        and pg_catalog.left(v_guardian_phone, 2) = '55'
      then pg_catalog.substr(v_guardian_phone, 3)
      else v_guardian_phone
    end;
    if not v_guardian_found
      or pg_catalog.lower(
           pg_catalog.btrim(coalesce(v_guardian.lifecycle_status, ''))
         ) <> 'active'
      or pg_catalog.length(pg_catalog.btrim(coalesce(v_guardian.full_name, ''))) < 3
      or pg_catalog.btrim(coalesce(v_guardian.email, ''))
         !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      or not public.is_valid_cpf(v_guardian_cpf)
      or v_local_guardian_phone !~ '^[1-9]{2}9[0-9]{8}$'
      or pg_catalog.substr(v_local_guardian_phone, 3)
         = pg_catalog.repeat(
           pg_catalog.substr(v_local_guardian_phone, 3, 1),
           9
         )
      or pg_catalog.regexp_replace(
           coalesce(v_guardian.postal_code, ''),
           '[^0-9]',
           '',
           'g'
         ) !~ '^[0-9]{8}$'
      or pg_catalog.length(
           pg_catalog.btrim(coalesce(v_guardian.address, ''))
         ) < 5
      or pg_catalog.length(
           pg_catalog.btrim(coalesce(v_guardian.address_number, ''))
         ) < 1
    then
      raise exception 'dependent_guardian_contact_invalid'
        using errcode = '22023';
    end if;
  end if;

  select pg_catalog.count(*)::integer
  into v_class_count
  from pg_catalog.generate_series(
    v_start_date,
    v_first_billing_date - 1,
    interval '1 day'
  ) as occurrence(class_date)
  join lateral pg_catalog.jsonb_array_elements(v_normalized_schedule) as scheduled(slot)
    on public.dow_name_to_int(scheduled.slot ->> 'day')
       = extract(dow from occurrence.class_date)::integer;

  -- Em planos recorrentes, toda aula anterior a primeira mensalidade deve ser
  -- cobrada. O navegador pode pedir o preview, mas nao pode desligar o pro-rata
  -- e criar um intervalo academico sem cobertura financeira.
  v_enable_pro_rata := v_duration <> 0 and v_class_count > 0;

  v_price_per_class := pg_catalog.round(
    v_value / (v_frequency * 4)::numeric,
    2
  );
  v_pro_rata_value := case
    when v_enable_pro_rata then pg_catalog.round(
      v_price_per_class * v_class_count,
      2
    )
    else 0::numeric
  end;

  -- Nenhum snapshot de responsavel vindo do navegador atravessa a barreira.
  -- Remove inclusive chaves guardian* futuras/desconhecidas antes de regravar
  -- apenas o conjunto validado no perfil do tenant.
  select coalesce(
    pg_catalog.jsonb_object_agg(entry.key, entry.value),
    '{}'::jsonb
  )
  into v_payload
  from pg_catalog.jsonb_each(v_payload) as entry(key, value)
  where entry.key !~* '^guardian';

  v_result := (
    v_payload
      - 'schedule'
      - 'professorId'
      - 'professorId2'
      - 'classesPerWeek'
      - 'dueDay'
      - 'value'
      - 'planDuration'
      - 'startDate'
      - 'billingStartMonth'
      - 'firstBillingDate'
      - 'proRataClassCount'
      - 'pricePerClass'
      - 'proRataValue'
      - 'proRataFormulaVersion'
      - 'proRataIntervalStartInclusive'
      - 'proRataIntervalEndExclusive'
      - 'enableProRata'
      - 'isDependent'
      - 'studentPhone'
  ) || pg_catalog.jsonb_build_object(
    'schedule', v_normalized_schedule,
    'professorId', v_teacher_ids[1],
    'professorId2', case
      when pg_catalog.array_length(v_teacher_ids, 1) = 2 then v_teacher_ids[2]
      else null
    end,
    'classesPerWeek', v_frequency,
    'dueDay', v_due_day,
    'value', v_value,
    'planDuration', v_duration,
    'startDate', pg_catalog.to_char(v_start_date, 'YYYY-MM-DD'),
    'billingStartMonth', pg_catalog.to_char(v_first_billing_date, 'YYYY-MM'),
    'firstBillingDate', pg_catalog.to_char(v_first_billing_date, 'YYYY-MM-DD'),
    'proRataClassCount', v_class_count,
    'pricePerClass', v_price_per_class,
    'proRataValue', v_pro_rata_value,
    'proRataFormulaVersion', 'weekly-frequency-times-4-v1',
    'proRataIntervalStartInclusive',
      pg_catalog.to_char(v_start_date, 'YYYY-MM-DD'),
    'proRataIntervalEndExclusive',
      pg_catalog.to_char(v_first_billing_date, 'YYYY-MM-DD'),
    'enableProRata', v_enable_pro_rata,
    'isDependent', v_is_dependent
  );
  if v_is_dependent then
    v_result := v_result || pg_catalog.jsonb_build_object(
      'studentPhone', v_local_student_phone,
      'guardianId', v_guardian_id,
      'guardianCpf', v_guardian.cpf,
      'guardianName', v_guardian.full_name,
      'guardianEmail', v_guardian.email,
      'guardianPhone', v_guardian.phone,
      'guardianPostalCode', v_guardian.postal_code,
      'guardianAddress', v_guardian.address,
      'guardianAddressNumber', v_guardian.address_number
    );
  end if;

  return v_result;
end;
$function$;

revoke all on function private.prepare_enrollment_offer_payload(jsonb,text)
  from public, anon, authenticated, service_role;

-- A ordem global é opportunity -> offer -> chaves de professor -> chaves de
-- aluno. Ela coincide com a máquina de matrícula existente e com o trigger
-- canônico de bookings, eliminando inversões de lock entre escritores.
create or replace function private.lock_and_validate_enrollment_schedule(
  p_offer_id uuid,
  p_student_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_initial_opportunity_id uuid;
  v_offer record;
  v_expected_count integer;
  v_actual_count integer;
  v_relational_schedule jsonb;
  v_teacher_ids uuid[];
  v_primary_teacher_id uuid;
  v_secondary_teacher_id uuid;
  v_teacher record;
  v_teacher_profile record;
  v_membership record;
  v_slot record;
begin
  select offer.opportunity_id
  into v_initial_opportunity_id
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT';
  if not found then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end if;

  if v_initial_opportunity_id is not null then
    perform 1
    from public.opportunities as opportunity
    where opportunity.id = v_initial_opportunity_id
    for update;
  end if;

  select
    offer.id,
    offer.tenant_id,
    offer.payload,
    offer.opportunity_id,
    offer.processing_by,
    offer.processing_state,
    offer.revoked_at,
    offer.consumed_at,
    offer.expires_at,
    offer.invite_security_version
  into v_offer
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT'
  for update;
  if not found
    or v_offer.opportunity_id is distinct from v_initial_opportunity_id
    or v_offer.invite_security_version < 1
    or v_offer.revoked_at is not null
  then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end if;

  begin
    v_expected_count := (v_offer.payload ->> 'classesPerWeek')::integer;
  exception when others then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end;
  select pg_catalog.count(*)::integer
  into v_actual_count
  from private.enrollment_offer_schedule_slots as slot
  where slot.offer_id = p_offer_id;
  if v_expected_count not between 1 and 7
    or v_actual_count <> v_expected_count
  then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'day', case slot.day_of_week
        when 0 then 'Sunday'
        when 1 then 'Monday'
        when 2 then 'Tuesday'
        when 3 then 'Wednesday'
        when 4 then 'Thursday'
        when 5 then 'Friday'
        when 6 then 'Saturday'
      end,
      'weekday', case slot.day_of_week
        when 0 then 'Sunday'
        when 1 then 'Monday'
        when 2 then 'Tuesday'
        when 3 then 'Wednesday'
        when 4 then 'Thursday'
        when 5 then 'Friday'
        when 6 then 'Saturday'
      end,
      'time', pg_catalog.to_char(slot.class_time, 'HH24:MI'),
      'teacherId', slot.teacher_id,
      'professorId', slot.teacher_id
    ) order by slot.slot_index
  )
  into v_relational_schedule
  from private.enrollment_offer_schedule_slots as slot
  where slot.offer_id = p_offer_id;

  select pg_catalog.array_agg(
    requested.teacher_id order by requested.first_slot_index
  )
  into v_teacher_ids
  from (
    select slot.teacher_id, pg_catalog.min(slot.slot_index) as first_slot_index
    from private.enrollment_offer_schedule_slots as slot
    where slot.offer_id = p_offer_id
    group by slot.teacher_id
  ) as requested;

  begin
    v_primary_teacher_id := nullif(
      v_offer.payload ->> 'professorId',
      ''
    )::uuid;
    v_secondary_teacher_id := nullif(
      v_offer.payload ->> 'professorId2',
      ''
    )::uuid;
  exception when others then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end;

  if v_offer.payload -> 'schedule' is distinct from v_relational_schedule
    or exists (
      select 1
      from private.enrollment_offer_schedule_slots as slot
      where slot.offer_id = p_offer_id
        and pg_catalog.to_char(slot.start_date, 'YYYY-MM-DD')
            is distinct from v_offer.payload ->> 'startDate'
    )
    or v_primary_teacher_id is null
    or pg_catalog.array_position(v_teacher_ids, v_primary_teacher_id) is null
    or (
      pg_catalog.array_length(v_teacher_ids, 1) = 1
      and v_secondary_teacher_id is not null
    )
    or (
      pg_catalog.array_length(v_teacher_ids, 1) = 2
      and (
        v_secondary_teacher_id is null
        or v_secondary_teacher_id = v_primary_teacher_id
        or pg_catalog.array_position(v_teacher_ids, v_secondary_teacher_id)
           is null
      )
    )
  then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end if;

  -- Professores sempre são bloqueados na mesma ordem lexicográfica.
  for v_slot in
    select distinct
      slot.teacher_id,
      slot.day_of_week,
      slot.day_name,
      slot.class_time
    from private.enrollment_offer_schedule_slots as slot
    where slot.offer_id = p_offer_id
    order by slot.teacher_id, slot.day_of_week, slot.class_time
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'schedule:teacher:' || v_slot.teacher_id::text || ':' ||
        public.fold_accents(v_slot.day_name) || ':' ||
        pg_catalog.to_char(v_slot.class_time, 'HH24:MI'),
        0
      )
    );
  end loop;

  if p_student_id is not null then
    for v_slot in
      select distinct slot.day_of_week, slot.day_name, slot.class_time
      from private.enrollment_offer_schedule_slots as slot
      where slot.offer_id = p_offer_id
      order by slot.day_of_week, slot.class_time
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'schedule:student:' || p_student_id::text || ':' ||
          public.fold_accents(v_slot.day_name) || ':' ||
          pg_catalog.to_char(v_slot.class_time, 'HH24:MI'),
          0
        )
      );
    end loop;
  end if;

  -- Status/lifecycle e membership nao podem mudar depois da validacao e antes
  -- do commit. FOR UPDATE tambem espera writers anteriores e reavalia a linha.
  for v_teacher in
    select distinct slot.teacher_id
    from private.enrollment_offer_schedule_slots as slot
    where slot.offer_id = p_offer_id
    order by slot.teacher_id
  loop
    select
      teacher.id,
      teacher.tenant_id,
      teacher.role,
      teacher.lifecycle_status
    into v_teacher_profile
    from public.profiles as teacher
    where teacher.id = v_teacher.teacher_id
    for update;
    if not found
      or v_teacher_profile.tenant_id is distinct from v_offer.tenant_id
      or v_teacher_profile.role is distinct from 'TEACHER'
      or pg_catalog.lower(
           pg_catalog.btrim(
             coalesce(v_teacher_profile.lifecycle_status, '')
           )
         ) <> 'active'
    then
      raise exception 'inactive_enrollment_teacher' using errcode = '42501';
    end if;

    select membership.user_id, membership.role, membership.status
    into v_membership
    from public.tenant_memberships as membership
    where membership.user_id = v_teacher.teacher_id
      and membership.tenant_id = v_offer.tenant_id
    for update;
    if not found
      or v_membership.role is distinct from 'TEACHER'
      or v_membership.status is distinct from 'ACTIVE'
    then
      raise exception 'inactive_enrollment_teacher' using errcode = '42501';
    end if;
  end loop;

  -- Libera leases vencidos/revogados somente para as chaves já protegidas.
  update private.enrollment_offer_schedule_slots as reserved
  set status = 'RELEASED',
      reserved_by = null,
      reserved_at = null,
      reservation_expires_at = null,
      materialized_booking_id = null,
      updated_at = now()
  where reserved.status = 'RESERVED'
    and exists (
      select 1
      from private.enrollment_offer_schedule_slots as requested
      where requested.offer_id = p_offer_id
        and requested.tenant_id = reserved.tenant_id
        and requested.teacher_id = reserved.teacher_id
        and requested.day_of_week = reserved.day_of_week
        and requested.class_time = reserved.class_time
    )
    and (
      reserved.reservation_expires_at is null
      or reserved.reservation_expires_at <= now()
      or exists (
        select 1
        from public.offers as owner_offer
        where owner_offer.id = reserved.offer_id
          and (
            owner_offer.revoked_at is not null
            or (
              owner_offer.consumed_at is null
              and owner_offer.expires_at <= now()
            )
          )
      )
    );

  -- Compatibilidade defensiva para bookings removidos antes do trigger abaixo.
  update private.enrollment_offer_schedule_slots as materialized
  set status = 'RELEASED',
      reserved_by = null,
      reserved_at = null,
      reservation_expires_at = null,
      materialized_booking_id = null,
      updated_at = now()
  where materialized.status = 'MATERIALIZED'
    and exists (
      select 1
      from private.enrollment_offer_schedule_slots as requested
      where requested.offer_id = p_offer_id
        and requested.tenant_id = materialized.tenant_id
        and requested.teacher_id = materialized.teacher_id
        and requested.day_of_week = materialized.day_of_week
        and requested.class_time = materialized.class_time
    )
    and not exists (
      select 1
      from public.bookings as booking
      where booking.id = materialized.materialized_booking_id
        and booking.enrollment_offer_slot_id = materialized.id
        and pg_catalog.upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED'
    );

  for v_slot in
    select slot.*
    from private.enrollment_offer_schedule_slots as slot
    where slot.offer_id = p_offer_id
    order by slot.teacher_id, slot.day_of_week, slot.class_time, slot.slot_index
  loop
    if v_slot.tenant_id is distinct from v_offer.tenant_id
      or v_slot.day_name is distinct from public.canonical_weekday_name(v_slot.day_name)
      or public.dow_name_to_int(v_slot.day_name) <> v_slot.day_of_week
    then
      raise exception 'enrollment_schedule_changed' using errcode = '23P01';
    end if;

    perform availability.id
      from public.teacher_availability as availability
      where availability.tenant_id = v_offer.tenant_id
        and availability.teacher_id = v_slot.teacher_id
        and availability.day_of_week = v_slot.day_of_week
        and (
          availability.start_time = v_slot.class_time
          or (
            availability.end_time is not null
            and availability.start_time <= v_slot.class_time
            and availability.end_time > v_slot.class_time
          )
        )
      order by availability.id
      for update;
    if not found then
      raise exception 'teacher_slot_unavailable' using errcode = '23P01';
    end if;

    if exists (
      select 1
      from public.bookings as booking
      where booking.tenant_id = v_offer.tenant_id
        and pg_catalog.upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED'
        and booking.time_slot ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
        and pg_catalog.left(pg_catalog.btrim(booking.time_slot), 5)
            = pg_catalog.to_char(v_slot.class_time, 'HH24:MI')
        and public.dow_name_to_int(booking.day_of_week) = v_slot.day_of_week
        and booking.enrollment_offer_slot_id is distinct from v_slot.id
        and (
          booking.teacher_id = v_slot.teacher_id
          or (p_student_id is not null and booking.student_id = p_student_id)
        )
    ) then
      raise exception 'teacher_slot_occupied' using errcode = '23P01';
    end if;

    if exists (
      select 1
      from private.enrollment_offer_schedule_slots as occupied
      where occupied.offer_id <> p_offer_id
        and occupied.tenant_id = v_offer.tenant_id
        and (
          occupied.teacher_id = v_slot.teacher_id
          or (
            p_student_id is not null
            and occupied.reserved_by = p_student_id
          )
        )
        and occupied.day_of_week = v_slot.day_of_week
        and occupied.class_time = v_slot.class_time
        and (
          occupied.status = 'RESERVED'
          and occupied.reservation_expires_at > now()
          or occupied.status = 'MATERIALIZED'
          and exists (
            select 1
            from public.bookings as occupied_booking
            where occupied_booking.id = occupied.materialized_booking_id
              and occupied_booking.enrollment_offer_slot_id = occupied.id
              and pg_catalog.upper(
                coalesce(occupied_booking.status, 'SCHEDULED')
              ) = 'SCHEDULED'
          )
        )
    ) then
      raise exception 'enrollment_schedule_reserved' using errcode = '23P01';
    end if;
  end loop;
end;
$function$;

revoke all on function private.lock_and_validate_enrollment_schedule(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function private.reserve_enrollment_offer_schedule(
  p_offer_id uuid,
  p_student_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer record;
  v_count integer;
  v_first_billing_date date;
  v_today date := (pg_catalog.clock_timestamp()
    at time zone 'America/Sao_Paulo')::date;
begin
  if p_student_id is null then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end if;

  perform private.lock_and_validate_enrollment_schedule(
    p_offer_id,
    p_student_id
  );

  select
    offer.processing_by,
    offer.processing_state,
    offer.consumed_at,
    offer.consumed_by,
    offer.revoked_at,
    offer.expires_at,
    offer.payload
  into v_offer
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT'
  for update;

  if v_offer.revoked_at is not null
    or (v_offer.consumed_at is null and v_offer.expires_at <= now())
  then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end if;
  begin
    v_first_billing_date := (v_offer.payload ->> 'firstBillingDate')::date;
  exception when others then
    raise exception 'invalid_enrollment_billing_period' using errcode = '22023';
  end;
  if v_first_billing_date < v_today then
    raise exception 'enrollment_first_billing_date_passed'
      using errcode = '22023';
  end if;
  if v_offer.processing_by is not null
    and v_offer.processing_by is distinct from p_student_id
    and v_offer.processing_state <> 'COMPLETED'
  then
    raise exception 'enrollment_schedule_reserved' using errcode = '23P01';
  end if;

  if exists (
    select 1
    from private.enrollment_offer_schedule_slots as slot
    where slot.offer_id = p_offer_id
      and (
        slot.status = 'MATERIALIZED'
        and slot.reserved_by is distinct from p_student_id
        or slot.status = 'RESERVED'
        and slot.reserved_by is distinct from p_student_id
      )
  ) then
    raise exception 'enrollment_schedule_reserved' using errcode = '23P01';
  end if;

  update private.enrollment_offer_schedule_slots as slot
  set status = 'RESERVED',
      reserved_by = p_student_id,
      reserved_at = case
        when slot.status = 'RESERVED' and slot.reserved_by = p_student_id
          then coalesce(slot.reserved_at, now())
        else now()
      end,
      reservation_expires_at = least(
        v_offer.expires_at,
        now() + interval '30 minutes'
      ),
      materialized_booking_id = null,
      updated_at = now()
  where slot.offer_id = p_offer_id
    and slot.status in ('OFFERED', 'RELEASED', 'RESERVED');

  select pg_catalog.count(*)::integer
  into v_count
  from private.enrollment_offer_schedule_slots as slot
  where slot.offer_id = p_offer_id
    and slot.reserved_by = p_student_id
    and slot.status in ('RESERVED', 'MATERIALIZED');
  if v_count <> (
    select (offer.payload ->> 'classesPerWeek')::integer
    from public.offers as offer
    where offer.id = p_offer_id
  ) then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end if;
end;
$function$;

revoke all on function private.reserve_enrollment_offer_schedule(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Identificadores do Asaas pertencem à tentativa/oferta, não ao UUID global do
-- perfil. Nunca apagamos um vínculo remoto antigo: uma oferta diferente falha
-- fechada para que suporte reconcilie/cancele a cobrança antes de prosseguir.
create or replace function private.prepare_enrollment_finance_scope(
  p_offer_id uuid,
  p_student_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer record;
  v_profile record;
  v_profile_exists boolean := false;
  v_is_same_offer boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'enrollment:finance:student:' || p_student_id::text,
      0
    )
  );

  select
    offer.tenant_id,
    offer.metadata,
    offer.enrollment_fee,
    offer.processing_by
  into v_offer
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT'
  for update;
  if not found then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end if;

  select
    profile.tenant_id,
    profile.asaas_customer_id,
    profile.subscription_id,
    profile.enrollment_payment_id
  into v_profile
  from public.profiles as profile
  where profile.id = p_student_id
  for update;
  v_profile_exists := found;

  v_is_same_offer := coalesce(
    v_offer.metadata ->> 'financial_profile_offer_id',
    ''
  ) = p_offer_id::text
    and v_profile.tenant_id is not distinct from v_offer.tenant_id
    and (
      nullif(v_profile.asaas_customer_id, '') is null
      or v_profile.asaas_customer_id
         = nullif(v_offer.metadata ->> 'asaas_customer_id', '')
    )
    and (
      nullif(v_profile.subscription_id, '') is null
      or v_profile.subscription_id
         = nullif(v_offer.metadata ->> 'subscription_id', '')
    )
    and (
      nullif(v_profile.enrollment_payment_id, '') is null
      or v_profile.enrollment_payment_id
         = nullif(v_offer.metadata ->> 'enrollment_payment_id', '')
    );

  if v_profile_exists and not v_is_same_offer then
    if nullif(v_profile.asaas_customer_id, '') is not null
      or nullif(v_profile.subscription_id, '') is not null
      or nullif(v_profile.enrollment_payment_id, '') is not null
    then
      raise exception 'enrollment_financial_scope_conflict'
        using errcode = '23P01';
    end if;
  end if;

  if exists (
    select 1
    from public.offers as competing_offer
    where competing_offer.id <> p_offer_id
      and competing_offer.kind = 'ENROLLMENT'
      and competing_offer.processing_by = p_student_id
      and competing_offer.processing_state not in ('NOT_STARTED', 'COMPLETED')
      and competing_offer.revoked_at is null
      and competing_offer.metadata ->> 'financial_profile_offer_id'
          = competing_offer.id::text
  ) then
    raise exception 'enrollment_financial_scope_conflict'
      using errcode = '23P01';
  end if;

  update public.offers as offer
  set metadata = coalesce(offer.metadata, '{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'financial_profile_offer_id', p_offer_id,
        'financial_profile_scoped_at', now()
      )
  where offer.id = p_offer_id;
end;
$function$;

revoke all on function private.prepare_enrollment_finance_scope(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Todo INSERT/UPDATE comum de booking participa do mesmo lock da reserva. Se a
-- reserva vencer primeiro, o booking espera e é recusado; se o booking vencer,
-- o begin revalida e recusa a matrícula.
create or replace function private.protect_enrollment_schedule_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_day text;
  v_day_number integer;
  v_time text;
  v_slot record;
begin
  if (new.enrollment_offer_id is null)
     <> (new.enrollment_offer_slot_id is null)
  then
    raise exception 'invalid_enrollment_booking_link' using errcode = '23514';
  end if;

  if pg_catalog.upper(coalesce(new.status, 'SCHEDULED')) <> 'SCHEDULED' then
    return new;
  end if;

  v_day := public.canonical_weekday_name(new.day_of_week);
  v_day_number := public.dow_name_to_int(v_day);
  v_time := pg_catalog.btrim(new.time_slot);
  if v_day is null
    or v_day_number not between 0 and 6
    or v_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
  then
    raise exception 'invalid_enrollment_booking_slot' using errcode = '23514';
  end if;
  v_time := pg_catalog.to_char(v_time::time, 'HH24:MI');

  if new.teacher_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'schedule:teacher:' || new.teacher_id::text || ':' ||
        public.fold_accents(v_day) || ':' || v_time,
        0
      )
    );
  end if;
  if new.student_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'schedule:student:' || new.student_id::text || ':' ||
        public.fold_accents(v_day) || ':' || v_time,
        0
      )
    );
  end if;

  if new.enrollment_offer_slot_id is not null then
    select slot.*
    into v_slot
    from private.enrollment_offer_schedule_slots as slot
    where slot.id = new.enrollment_offer_slot_id
      and slot.offer_id = new.enrollment_offer_id
    for update;
    if not found
      or v_slot.tenant_id is distinct from new.tenant_id
      or v_slot.teacher_id is distinct from new.teacher_id
      or v_slot.day_of_week is distinct from v_day_number
      or pg_catalog.to_char(v_slot.class_time, 'HH24:MI') is distinct from v_time
      or v_slot.start_date is distinct from new.start_date
      or v_slot.reserved_by is distinct from new.student_id
      or v_slot.status not in ('RESERVED', 'MATERIALIZED')
    then
      raise exception 'invalid_enrollment_booking_link' using errcode = '42501';
    end if;
    return new;
  end if;

  if (new.teacher_id is not null or new.student_id is not null) and exists (
    select 1
    from private.enrollment_offer_schedule_slots as reserved
    where reserved.tenant_id = new.tenant_id
      and (
        reserved.teacher_id = new.teacher_id
        or reserved.reserved_by = new.student_id
      )
      and reserved.day_of_week = v_day_number
      and pg_catalog.to_char(reserved.class_time, 'HH24:MI') = v_time
      and (
        reserved.status = 'RESERVED'
        and reserved.reservation_expires_at > now()
        or reserved.status = 'MATERIALIZED'
        and exists (
          select 1
          from public.bookings as linked_booking
          where linked_booking.id = reserved.materialized_booking_id
            and linked_booking.enrollment_offer_slot_id = reserved.id
            and pg_catalog.upper(
              coalesce(linked_booking.status, 'SCHEDULED')
            ) = 'SCHEDULED'
        )
      )
  ) then
    raise exception 'booking_conflicts_with_enrollment_reservation'
      using errcode = '23P01';
  end if;

  return new;
end;
$function$;

revoke all on function private.protect_enrollment_schedule_reservation()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_protect_booking_enrollment_reservation
  on public.bookings;
create trigger trg_protect_booking_enrollment_reservation
before insert or update of
  tenant_id, teacher_id, student_id, day_of_week, time_slot,
  date, start_date, status, enrollment_offer_id, enrollment_offer_slot_id
on public.bookings
for each row execute function private.protect_enrollment_schedule_reservation();

create or replace function private.release_enrollment_slot_after_booking_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.enrollment_offer_slot_id is null
    or pg_catalog.upper(coalesce(old.status, 'SCHEDULED')) <> 'SCHEDULED'
  then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    update private.enrollment_offer_schedule_slots as slot
    set status = 'RELEASED',
        reserved_by = null,
        reserved_at = null,
        reservation_expires_at = null,
        materialized_booking_id = null,
        updated_at = now()
    where slot.id = old.enrollment_offer_slot_id
      and slot.offer_id = old.enrollment_offer_id
      and slot.materialized_booking_id = old.id;
    return old;
  end if;

  if pg_catalog.upper(coalesce(new.status, 'SCHEDULED')) <> 'SCHEDULED'
    or new.enrollment_offer_slot_id is distinct from old.enrollment_offer_slot_id
    or new.enrollment_offer_id is distinct from old.enrollment_offer_id
  then
    update private.enrollment_offer_schedule_slots as slot
    set status = 'RELEASED',
        reserved_by = null,
        reserved_at = null,
        reservation_expires_at = null,
        materialized_booking_id = null,
        updated_at = now()
    where slot.id = old.enrollment_offer_slot_id
      and slot.offer_id = old.enrollment_offer_id
      and slot.materialized_booking_id = old.id;
  end if;
  return new;
end;
$function$;

revoke all on function private.release_enrollment_slot_after_booking_end()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_release_enrollment_slot_after_booking_end
  on public.bookings;
create trigger trg_release_enrollment_slot_after_booking_end
after delete or update of
  status, enrollment_offer_id, enrollment_offer_slot_id
on public.bookings
for each row execute function private.release_enrollment_slot_after_booking_end();

-- Chamado pela Edge Function depois de begin e antes de criar customer,
-- assinatura ou pagamento no Asaas. O ON CONFLICT usa a identidade relacional
-- do slot e transforma retries em leitura idempotente.
create or replace function public.materialize_enrollment_offer_schedule(
  p_offer_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_offer record;
  v_expected_count integer;
  v_booking_count integer;
  v_inserted_count integer := 0;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'FORBIDDEN'
    );
  end if;

  begin
    perform private.lock_and_validate_enrollment_schedule(
      p_offer_id,
      p_user_id
    );
  exception
    when exclusion_violation or check_violation
      or insufficient_privilege or unique_violation or deadlock_detected
  then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'SCHEDULE_UNAVAILABLE'
    );
  end;

  select
    offer.tenant_id,
    offer.payload,
    offer.processing_by,
    offer.processing_state,
    offer.revoked_at,
    offer.consumed_at
  into v_offer
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT'
  for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'OFFER_NOT_FOUND'
    );
  end if;
  if v_offer.processing_by is distinct from p_user_id then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'ATTEMPT_OWNER_MISMATCH'
    );
  end if;
  if v_offer.revoked_at is not null then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'OFFER_REVOKED'
    );
  end if;
  if not private.tenant_is_operational(v_offer.tenant_id) then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'TENANT_UNAVAILABLE'
    );
  end if;

  begin
    v_expected_count := (v_offer.payload ->> 'classesPerWeek')::integer;
  exception when others then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'SCHEDULE_INVALID'
    );
  end;

  if not exists (
    select 1
    from public.profiles as student
    join public.tenant_memberships as membership
      on membership.user_id = student.id
     and membership.tenant_id = student.tenant_id
     and membership.role = 'STUDENT'
     and membership.status = 'ACTIVE'
    where student.id = p_user_id
      and student.tenant_id = v_offer.tenant_id
      and student.role = 'STUDENT'
      and pg_catalog.lower(pg_catalog.btrim(student.lifecycle_status)) = 'active'
  ) then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'PROFILE_INVALID'
    );
  end if;

  if exists (
    select 1
    from private.enrollment_offer_schedule_slots as slot
    where slot.offer_id = p_offer_id
      and (
        slot.reserved_by is distinct from p_user_id
        or slot.status not in ('RESERVED', 'MATERIALIZED')
        or (
          slot.status = 'RESERVED'
          and slot.reservation_expires_at <= now()
        )
      )
  ) then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'SCHEDULE_RESERVATION_REQUIRED'
    );
  end if;

  with inserted as (
    insert into public.bookings (
      tenant_id,
      teacher_id,
      student_id,
      day_of_week,
      time_slot,
      start_date,
      status,
      enrollment_offer_id,
      enrollment_offer_slot_id
    )
    select
      slot.tenant_id,
      slot.teacher_id,
      p_user_id,
      slot.day_name,
      pg_catalog.to_char(slot.class_time, 'HH24:MI'),
      slot.start_date,
      'SCHEDULED',
      slot.offer_id,
      slot.id
    from private.enrollment_offer_schedule_slots as slot
    where slot.offer_id = p_offer_id
      and slot.status = 'RESERVED'
    order by slot.teacher_id, slot.day_of_week, slot.class_time, slot.slot_index
    on conflict (enrollment_offer_slot_id)
      where enrollment_offer_slot_id is not null
      do nothing
    returning id
  )
  select pg_catalog.count(*)::integer
  into v_inserted_count
  from inserted;

  update private.enrollment_offer_schedule_slots as slot
  set status = 'MATERIALIZED',
      reservation_expires_at = null,
      materialized_booking_id = booking.id,
      updated_at = now()
  from public.bookings as booking
  where slot.offer_id = p_offer_id
    and booking.enrollment_offer_slot_id = slot.id
    and booking.enrollment_offer_id = slot.offer_id
    and booking.tenant_id = slot.tenant_id
    and booking.teacher_id = slot.teacher_id
    and booking.student_id = p_user_id
    and public.dow_name_to_int(booking.day_of_week) = slot.day_of_week
    and pg_catalog.left(pg_catalog.btrim(booking.time_slot), 5)
        = pg_catalog.to_char(slot.class_time, 'HH24:MI')
    and booking.start_date is not distinct from slot.start_date
    and pg_catalog.upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED';

  select pg_catalog.count(*)::integer
  into v_booking_count
  from private.enrollment_offer_schedule_slots as slot
  join public.bookings as booking
    on booking.id = slot.materialized_booking_id
   and booking.enrollment_offer_slot_id = slot.id
   and booking.enrollment_offer_id = slot.offer_id
   and booking.student_id = p_user_id
   and pg_catalog.upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED'
  where slot.offer_id = p_offer_id
    and slot.status = 'MATERIALIZED'
    and slot.reserved_by = p_user_id;
  if v_booking_count <> v_expected_count then
    raise exception 'enrollment_schedule_materialization_incomplete'
      using errcode = '23P01';
  end if;

  update public.offers as offer
  set metadata = coalesce(offer.metadata, '{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'schedule_materialized_at', now(),
        'schedule_booking_count', v_booking_count
      )
  where offer.id = p_offer_id;

  return pg_catalog.jsonb_build_object(
    'success', true,
    'booking_count', v_booking_count,
    'idempotent', v_inserted_count = 0
  );
end;
$function$;

revoke all on function public.materialize_enrollment_offer_schedule(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.materialize_enrollment_offer_schedule(uuid,uuid)
  to service_role;

create or replace function private.assert_materialized_enrollment_schedule(
  p_offer_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_offer record;
  v_expected_count integer;
  v_actual_count integer;
begin
  perform private.lock_and_validate_enrollment_schedule(
    p_offer_id,
    p_user_id
  );

  -- DELETE/CANCEL de booking nao passa pelo trigger BEFORE de INSERT/UPDATE.
  -- Bloquear as linhas vinculadas fecha a janela MVCC entre a revalidacao da
  -- grade e a conclusao: um cancelamento em curso termina primeiro e e visto
  -- pela contagem abaixo; depois deste lock, ele espera o complete finalizar.
  perform booking.id
  from public.bookings as booking
  join private.enrollment_offer_schedule_slots as slot
    on slot.id = booking.enrollment_offer_slot_id
   and slot.offer_id = booking.enrollment_offer_id
  where slot.offer_id = p_offer_id
    and booking.student_id = p_user_id
    and pg_catalog.upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED'
  order by booking.id
  for update of booking;

  select offer.tenant_id, offer.payload, offer.processing_by
  into v_offer
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT'
  for update;
  if not found or v_offer.processing_by is distinct from p_user_id then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end if;
  begin
    v_expected_count := (v_offer.payload ->> 'classesPerWeek')::integer;
  exception when others then
    raise exception 'enrollment_schedule_changed' using errcode = '23P01';
  end;

  select pg_catalog.count(*)::integer
  into v_actual_count
  from private.enrollment_offer_schedule_slots as slot
  join public.bookings as booking
    on booking.id = slot.materialized_booking_id
   and booking.enrollment_offer_slot_id = slot.id
   and booking.enrollment_offer_id = slot.offer_id
   and booking.tenant_id = slot.tenant_id
   and booking.teacher_id = slot.teacher_id
   and booking.student_id = p_user_id
   and public.dow_name_to_int(booking.day_of_week) = slot.day_of_week
   and pg_catalog.left(pg_catalog.btrim(booking.time_slot), 5)
       = pg_catalog.to_char(slot.class_time, 'HH24:MI')
   and booking.start_date is not distinct from slot.start_date
   and pg_catalog.upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED'
  where slot.offer_id = p_offer_id
    and slot.tenant_id = v_offer.tenant_id
    and slot.status = 'MATERIALIZED'
    and slot.reserved_by = p_user_id;
  if v_actual_count <> v_expected_count then
    raise exception 'enrollment_schedule_materialization_incomplete'
      using errcode = '23P01';
  end if;
end;
$function$;

revoke all on function private.assert_materialized_enrollment_schedule(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Encapsula os wrappers de segurança já existentes. O create interno continua
-- sendo o único lugar que chama private.contract_school_info; esta migration
-- não duplica, substitui nem relaxa esse snapshot jurídico.
do $wrap_create$
begin
  if pg_catalog.to_regprocedure(
    'public.create_enrollment_offer_pre_schedule_impl(jsonb)'
  ) is null then
    alter function public.create_enrollment_offer(jsonb)
      rename to create_enrollment_offer_pre_schedule_impl;
  end if;
end
$wrap_create$;

revoke all on function public.create_enrollment_offer_pre_schedule_impl(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.create_enrollment_offer(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := (select auth.uid());
  v_tenant_id text := private.active_tenant_id(v_actor_id);
  v_safe_payload jsonb;
  v_offer_id uuid;
begin
  if v_actor_id is null or v_tenant_id is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  v_safe_payload := private.prepare_enrollment_offer_payload(
    p_payload,
    v_tenant_id
  );
  v_offer_id := public.create_enrollment_offer_pre_schedule_impl(
    v_safe_payload
  );

  insert into private.enrollment_offer_schedule_slots (
    offer_id,
    tenant_id,
    slot_index,
    teacher_id,
    day_of_week,
    day_name,
    class_time,
    start_date
  )
  select
    v_offer_id,
    v_tenant_id,
    item.ordinality::smallint,
    (item.slot ->> 'teacherId')::uuid,
    public.dow_name_to_int(item.slot ->> 'day')::smallint,
    public.canonical_weekday_name(item.slot ->> 'day'),
    (item.slot ->> 'time')::time,
    (v_safe_payload ->> 'startDate')::date
  from pg_catalog.jsonb_array_elements(v_safe_payload -> 'schedule')
    with ordinality as item(slot, ordinality)
  order by item.ordinality;

  update public.offers as offer
  set metadata = coalesce(offer.metadata, '{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'pro_rata_formula_version', 'weekly-frequency-times-4-v1',
        'pro_rata_interval_start_inclusive',
          v_safe_payload ->> 'proRataIntervalStartInclusive',
        'pro_rata_interval_end_exclusive',
          v_safe_payload ->> 'proRataIntervalEndExclusive',
        'pro_rata_class_count', v_safe_payload -> 'proRataClassCount',
        'price_per_class', v_safe_payload -> 'pricePerClass',
        'pro_rata_value', v_safe_payload -> 'proRataValue'
      )
  where offer.id = v_offer_id;

  perform private.lock_and_validate_enrollment_schedule(v_offer_id, null);
  return v_offer_id;
end;
$function$;

revoke all on function public.create_enrollment_offer(jsonb)
  from public, anon, service_role;
grant execute on function public.create_enrollment_offer(jsonb)
  to authenticated;

do $wrap_begin$
begin
  if pg_catalog.to_regprocedure(
    'public.begin_enrollment_offer_pre_schedule_impl(uuid,jsonb)'
  ) is null then
    alter function public.begin_enrollment_offer(uuid,jsonb)
      rename to begin_enrollment_offer_pre_schedule_impl;
  end if;
end
$wrap_begin$;

revoke all on function public.begin_enrollment_offer_pre_schedule_impl(uuid,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.begin_enrollment_offer(
  p_offer_id uuid,
  p_profile jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_offer record;
  v_safe_profile jsonb;
  v_student_phone text;
  v_result jsonb;
  v_error_state text;
  v_error_message text;
  v_error_detail text;
begin
  select
    offer.tenant_id,
    offer.payload,
    offer.invite_security_version,
    offer.processing_by,
    offer.processing_state,
    offer.consumed_at,
    offer.consumed_by,
    offer.revoked_at,
    offer.expires_at
  into v_offer
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT';
  if not found then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'OFFER_NOT_FOUND'
    );
  end if;
  if v_offer.invite_security_version < 1 or v_offer.revoked_at is not null then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'OFFER_REVOKED'
    );
  end if;
  if not private.tenant_is_operational(v_offer.tenant_id) then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'TENANT_UNAVAILABLE'
    );
  end if;
  if v_user_id is null then
    return public.begin_enrollment_offer_pre_schedule_impl(
      p_offer_id,
      p_profile
    );
  end if;
  if v_offer.processing_state = 'COMPLETED'
    or (
      v_offer.consumed_at is not null
      and v_offer.consumed_by = v_user_id
    )
    or (
      v_offer.processing_by is not null
      and v_offer.processing_by is distinct from v_user_id
    )
  then
    return public.begin_enrollment_offer_pre_schedule_impl(
      p_offer_id,
      p_profile
    );
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_profile, '{}'::jsonb))
       is distinct from 'object'
  then
    return public.begin_enrollment_offer_pre_schedule_impl(
      p_offer_id,
      p_profile
    );
  end if;

  v_safe_profile := coalesce(p_profile, '{}'::jsonb);

  begin
    perform private.reserve_enrollment_offer_schedule(
      p_offer_id,
      v_user_id
    );

    -- reserve ja detem o lock da oferta. Rele o snapshot sob esse lock para
    -- nao usar telefone/endereco antigo enquanto outro writer altera a oferta.
    select offer.payload
    into v_offer
    from public.offers as offer
    where offer.id = p_offer_id
      and offer.kind = 'ENROLLMENT'
    for update;
    if not found then
      raise exception 'enrollment_schedule_changed' using errcode = '23P01';
    end if;

    if coalesce((v_offer.payload ->> 'isDependent')::boolean, false) then
      v_student_phone := pg_catalog.regexp_replace(
        coalesce(v_offer.payload ->> 'studentPhone', ''),
        '[^0-9]',
        '',
        'g'
      );
      if v_student_phone !~ '^[1-9]{2}9[0-9]{8}$' then
        raise exception 'dependent_student_phone_invalid'
          using errcode = '22023';
      end if;
      v_safe_profile := v_safe_profile || pg_catalog.jsonb_build_object(
        'phone', v_student_phone,
        'postal_code', pg_catalog.regexp_replace(
          coalesce(v_offer.payload ->> 'guardianPostalCode', ''),
          '[^0-9]',
          '',
          'g'
        ),
        'address', pg_catalog.btrim(
          coalesce(v_offer.payload ->> 'guardianAddress', '')
        ),
        'address_number', pg_catalog.btrim(
          coalesce(v_offer.payload ->> 'guardianAddressNumber', '')
        )
      );
    end if;

    perform private.prepare_enrollment_finance_scope(
      p_offer_id,
      v_user_id
    );

    v_result := public.begin_enrollment_offer_pre_schedule_impl(
      p_offer_id,
      v_safe_profile
    );
    if coalesce((v_result ->> 'success')::boolean, false) is false then
      raise exception using
        errcode = 'PZ001',
        message = 'enrollment_begin_rejected',
        detail = v_result::text;
    end if;
    return v_result;
  exception
    when sqlstate 'PZ001' then
      get stacked diagnostics v_error_detail = pg_exception_detail;
      return v_error_detail::jsonb;
    when exclusion_violation or check_violation
      or insufficient_privilege or unique_violation
      or invalid_parameter_value or deadlock_detected
    then
      get stacked diagnostics
        v_error_state = returned_sqlstate,
        v_error_message = message_text;
      if v_error_message = 'enrollment_financial_scope_conflict' then
        return pg_catalog.jsonb_build_object(
          'success', false,
          'error', 'FINANCIAL_SCOPE_CONFLICT'
        );
      end if;
      if v_error_message = 'enrollment_first_billing_date_passed' then
        return pg_catalog.jsonb_build_object(
          'success', false,
          'error', 'BILLING_PERIOD_EXPIRED'
        );
      end if;
      if v_error_message = 'dependent_student_phone_invalid' then
        return pg_catalog.jsonb_build_object(
          'success', false,
          'error', 'INVALID_STUDENT_PHONE'
        );
      end if;
      if v_error_state = '40P01' or v_error_message in (
        'enrollment_schedule_changed',
        'enrollment_schedule_reserved',
        'inactive_enrollment_teacher',
        'teacher_slot_unavailable',
        'teacher_slot_occupied'
      ) then
        return pg_catalog.jsonb_build_object(
          'success', false,
          'error', 'SCHEDULE_UNAVAILABLE'
        );
      end if;
      raise;
  end;
end;
$function$;

revoke all on function public.begin_enrollment_offer(uuid,jsonb)
  from public, anon, service_role;
grant execute on function public.begin_enrollment_offer(uuid,jsonb)
  to authenticated;

do $wrap_complete$
begin
  if pg_catalog.to_regprocedure(
    'public.complete_enrollment_offer_pre_schedule_impl(uuid,uuid)'
  ) is null then
    alter function public.complete_enrollment_offer(uuid,uuid)
      rename to complete_enrollment_offer_pre_schedule_impl;
  end if;
end
$wrap_complete$;

revoke all on function public.complete_enrollment_offer_pre_schedule_impl(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.complete_enrollment_offer(
  p_offer_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_offer record;
  v_profile record;
  v_duration integer;
  v_pro_rata_value numeric;
  v_error_message text;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'FORBIDDEN'
    );
  end if;

  select
    offer.tenant_id,
    offer.payload,
    offer.metadata,
    offer.enrollment_fee,
    offer.processing_by,
    offer.processing_state,
    offer.consumed_by,
    offer.invite_security_version,
    offer.revoked_at
  into v_offer
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT';
  if not found then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'OFFER_NOT_FOUND'
    );
  end if;
  if v_offer.invite_security_version < 1
    or v_offer.revoked_at is not null
    or not private.tenant_is_operational(v_offer.tenant_id)
  then
    return public.complete_enrollment_offer_pre_schedule_impl(
      p_offer_id,
      p_user_id
    );
  end if;
  if v_offer.processing_state = 'COMPLETED'
    and v_offer.consumed_by = p_user_id
  then
    return public.complete_enrollment_offer_pre_schedule_impl(
      p_offer_id,
      p_user_id
    );
  end if;

  begin
    perform private.assert_materialized_enrollment_schedule(
      p_offer_id,
      p_user_id
    );
  exception
    when exclusion_violation or check_violation
      or insufficient_privilege or unique_violation or deadlock_detected
  then
    get stacked diagnostics v_error_message = message_text;
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'SCHEDULE_UNAVAILABLE',
      'reason', v_error_message
    );
  end;

  -- A assercao acima bloqueia a oferta. Recarrega payload/metadata depois de
  -- qualquer writer anterior terminar para que IDs financeiros antigos nunca
  -- sejam usados na decisao de conclusao.
  select
    offer.tenant_id,
    offer.payload,
    offer.metadata,
    offer.enrollment_fee,
    offer.processing_by,
    offer.processing_state,
    offer.consumed_by,
    offer.invite_security_version,
    offer.revoked_at
  into v_offer
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT'
  for update;
  if not found
    or v_offer.processing_by is distinct from p_user_id
    or v_offer.invite_security_version < 1
    or v_offer.revoked_at is not null
  then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'SCHEDULE_UNAVAILABLE'
    );
  end if;
  if not private.tenant_is_operational(v_offer.tenant_id) then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'TENANT_UNAVAILABLE'
    );
  end if;

  select
    profile.tenant_id,
    profile.asaas_customer_id,
    profile.subscription_id,
    profile.enrollment_payment_id,
    profile.enrollment_fee_paid
  into v_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;
  if not found or v_profile.tenant_id is distinct from v_offer.tenant_id then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'PROFILE_INVALID'
    );
  end if;

  begin
    v_duration := coalesce(
      nullif(v_offer.payload ->> 'planDuration', '')::integer,
      1
    );
    v_pro_rata_value := coalesce(
      nullif(v_offer.payload ->> 'proRataValue', '')::numeric,
      0
    );
  exception when others then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'BILLING_SCOPE_INVALID'
    );
  end;

  if v_offer.payload ->> 'proRataFormulaVersion'
       is distinct from 'weekly-frequency-times-4-v1'
    or v_offer.payload ->> 'proRataIntervalStartInclusive'
       is distinct from v_offer.payload ->> 'startDate'
    or v_offer.payload ->> 'proRataIntervalEndExclusive'
       is distinct from v_offer.payload ->> 'firstBillingDate'
    or v_offer.metadata ->> 'pro_rata_formula_version'
       is distinct from 'weekly-frequency-times-4-v1'
    or v_offer.metadata ->> 'pro_rata_interval_start_inclusive'
       is distinct from v_offer.payload ->> 'proRataIntervalStartInclusive'
    or v_offer.metadata ->> 'pro_rata_interval_end_exclusive'
       is distinct from v_offer.payload ->> 'proRataIntervalEndExclusive'
    or v_offer.metadata -> 'pro_rata_class_count'
       is distinct from v_offer.payload -> 'proRataClassCount'
    or v_offer.metadata -> 'price_per_class'
       is distinct from v_offer.payload -> 'pricePerClass'
    or v_offer.metadata -> 'pro_rata_value'
       is distinct from v_offer.payload -> 'proRataValue'
  then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'BILLING_SCOPE_INVALID'
    );
  end if;

  if v_offer.processing_by is distinct from p_user_id
    or v_offer.metadata ->> 'financial_profile_offer_id'
       is distinct from p_offer_id::text
    or nullif(v_profile.asaas_customer_id, '') is null
    or v_profile.asaas_customer_id
       is distinct from nullif(v_offer.metadata ->> 'asaas_customer_id', '')
  then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'CUSTOMER_SCOPE_PENDING'
    );
  end if;

  if nullif(v_profile.subscription_id, '')
       is distinct from nullif(v_offer.metadata ->> 'subscription_id', '')
  then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'SUBSCRIPTION_SCOPE_PENDING'
    );
  end if;

  if nullif(v_profile.enrollment_payment_id, '')
       is distinct from nullif(
         v_offer.metadata ->> 'enrollment_payment_id',
         ''
       )
  then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'ENROLLMENT_FEE_SCOPE_PENDING'
    );
  end if;

  if v_duration <> 0 and nullif(v_profile.subscription_id, '') is null then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'SUBSCRIPTION_SCOPE_PENDING'
    );
  end if;

  if coalesce(v_offer.enrollment_fee, 0) > 0 and (
    coalesce(v_profile.enrollment_fee_paid, false) is false
    or nullif(v_profile.enrollment_payment_id, '') is null
  ) then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'ENROLLMENT_FEE_SCOPE_PENDING'
    );
  end if;

  if v_pro_rata_value > 0
    and nullif(v_offer.metadata ->> 'pro_rata_charge_id', '') is null
  then
    return pg_catalog.jsonb_build_object(
      'success', false,
      'error', 'PRO_RATA_CHARGE_PENDING'
    );
  end if;

  return public.complete_enrollment_offer_pre_schedule_impl(
    p_offer_id,
    p_user_id
  );
end;
$function$;

revoke all on function public.complete_enrollment_offer(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.complete_enrollment_offer(uuid,uuid)
  to service_role;

-- Every privileged enrollment boundary must execute under the same stable
-- database owner. Leaving newly created functions owned by the migration role
-- would make wrapper-to-implementation access depend on deployment identity.
alter table private.enrollment_offer_schedule_slots owner to postgres;

alter function private.prepare_enrollment_offer_payload(jsonb,text)
  owner to postgres;
alter function private.lock_and_validate_enrollment_schedule(uuid,uuid)
  owner to postgres;
alter function private.reserve_enrollment_offer_schedule(uuid,uuid)
  owner to postgres;
alter function private.prepare_enrollment_finance_scope(uuid,uuid)
  owner to postgres;
alter function private.protect_enrollment_schedule_reservation()
  owner to postgres;
alter function private.release_enrollment_slot_after_booking_end()
  owner to postgres;
alter function public.materialize_enrollment_offer_schedule(uuid,uuid)
  owner to postgres;
alter function private.assert_materialized_enrollment_schedule(uuid,uuid)
  owner to postgres;
alter function public.create_enrollment_offer_pre_schedule_impl(jsonb)
  owner to postgres;
alter function public.create_enrollment_offer(jsonb)
  owner to postgres;
alter function public.begin_enrollment_offer_pre_schedule_impl(uuid,jsonb)
  owner to postgres;
alter function public.begin_enrollment_offer(uuid,jsonb)
  owner to postgres;
alter function public.complete_enrollment_offer_pre_schedule_impl(uuid,uuid)
  owner to postgres;
alter function public.complete_enrollment_offer(uuid,uuid)
  owner to postgres;

comment on function public.materialize_enrollment_offer_schedule(uuid,uuid) is
  'Materializa idempotentemente a grade reservada antes de qualquer side effect no Asaas; uso exclusivo service_role.';
comment on table private.enrollment_offer_schedule_slots is
  'Snapshot relacional e reserva autoritativa dos slots de cada oferta de matricula.';

commit;
