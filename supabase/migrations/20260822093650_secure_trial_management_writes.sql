begin;

-- Trial-management writes are commands, not table CRUD.  Browser clients keep
-- only the minimum tenant-scoped read surface and invoke reviewed RPCs for
-- every state transition.

do $guard$
begin
  if to_regclass('public.opportunities') is null
     or to_regclass('public.appointments') is null
     or to_regclass('public.bookings') is null
     or to_regclass('public.enrollment_links') is null
     or to_regclass('public.trial_feedback') is null
     or to_regclass('public.class_logs') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.tenant_memberships') is null
     or to_regclass('public.tenants') is null
     or to_regprocedure('private.active_tenant_id(uuid)') is null
     or to_regprocedure('private.tenant_is_operational(text)') is null
     or to_regprocedure('public.dow_name_to_int(text)') is null
     or to_regprocedure('extensions.digest(bytea,text)') is null
     or to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'secure_trial_management_dependencies_are_required';
  end if;
end
$guard$;

alter table public.enrollment_links
  add column if not exists purpose text default 'ENROLLMENT',
  add column if not exists expires_at timestamptz,
  add column if not exists student_confirmed_at timestamptz;

update public.enrollment_links
   set purpose = case
     when lower(coalesce(link_url, '')) like '%/experimental?%'
       then 'TRIAL_CONFIRMATION'
     else 'ENROLLMENT'
   end
 where purpose is null
    or purpose not in ('ENROLLMENT', 'TRIAL_CONFIRMATION')
    or lower(coalesce(link_url, '')) like '%/experimental?%';

update public.enrollment_links
   set expires_at = coalesce(created_at, now()) + interval '30 days'
 where expires_at is null;

alter table public.enrollment_links
  alter column purpose set default 'ENROLLMENT',
  alter column purpose set not null,
  alter column expires_at set default (now() + interval '30 days'),
  alter column expires_at set not null;

alter table public.enrollment_links
  drop constraint if exists enrollment_links_purpose_check;
alter table public.enrollment_links
  add constraint enrollment_links_purpose_check
  check (purpose in ('ENROLLMENT', 'TRIAL_CONFIRMATION'));

create index if not exists enrollment_links_trial_lookup_idx
  on public.enrollment_links (link_token, status, expires_at)
  where purpose = 'TRIAL_CONFIRMATION' and offer_id is null;

create table if not exists private.secure_trial_command_receipts (
  tenant_id text not null references public.tenants(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  command text not null check (command in (
    'MANUAL_SCHEDULE', 'VENDOR_TRIAL_LINK', 'TRIAL_OUTCOME'
  )),
  request_id uuid not null,
  payload_fingerprint text not null
    check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, actor_id, command, request_id)
);

revoke all on table private.secure_trial_command_receipts
  from public, anon, authenticated, service_role;
grant select, insert, update on table private.secure_trial_command_receipts
  to postgres;

create table if not exists private.vendor_trial_teacher_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  opportunity_id uuid not null unique
    references public.opportunities(id) on delete cascade,
  enrollment_link_id uuid unique
    references public.enrollment_links(id) on delete cascade,
  target_teacher_id uuid not null
    references public.profiles(id) on delete restrict,
  requested_by uuid references public.profiles(id) on delete set null,
  slot_start timestamptz not null,
  status text not null default 'AWAITING_STUDENT'
    check (status in (
      'AWAITING_STUDENT', 'AWAITING_TEACHER', 'ACCEPTED',
      'CANCELED', 'EXPIRED'
    )),
  student_confirmed_at timestamptz,
  accepted_at timestamptz,
  accepted_appointment_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendor_trial_teacher_requests_pending_idx
  on private.vendor_trial_teacher_requests (
    tenant_id, target_teacher_id, slot_start
  )
  where status in ('AWAITING_STUDENT', 'AWAITING_TEACHER');

revoke all on table private.vendor_trial_teacher_requests
  from public, anon, authenticated, service_role;
grant select, insert, update on table private.vendor_trial_teacher_requests
  to postgres;

create or replace function public.get_opportunity_teacher_dispatch_secure(
  p_tenant_id text,
  p_opportunity_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_request private.vendor_trial_teacher_requests%rowtype;
begin
  if nullif(trim(coalesce(p_tenant_id, '')), '') is null
     or p_opportunity_id is null
     or not exists (
       select 1
         from public.opportunities as opportunity
        where opportunity.id = p_opportunity_id
          and opportunity.tenant_id = p_tenant_id
     ) then
    return jsonb_build_object('ok', false, 'dispatchMode', 'NONE');
  end if;

  select request.*
    into v_request
    from private.vendor_trial_teacher_requests as request
   where request.tenant_id = p_tenant_id
     and request.opportunity_id = p_opportunity_id;

  if not found then
    return jsonb_build_object(
      'ok', true,
      'dispatchMode', 'GENERIC',
      'state', 'GENERIC'
    );
  end if;
  if v_request.status = 'AWAITING_TEACHER' then
    return jsonb_build_object(
      'ok', true,
      'dispatchMode', 'TARGETED',
      'state', v_request.status,
      'targetTeacherId', v_request.target_teacher_id
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'dispatchMode', 'NONE',
    'state', v_request.status
  );
end;
$function$;

alter function public.get_opportunity_teacher_dispatch_secure(text, uuid)
  owner to postgres;
revoke all on function public.get_opportunity_teacher_dispatch_secure(
  text, uuid
) from public, anon, authenticated;
grant execute on function public.get_opportunity_teacher_dispatch_secure(
  text, uuid
) to service_role;

comment on function public.get_opportunity_teacher_dispatch_secure(
  text, uuid
) is
  'Service-only fail-closed dispatch guard. Directed trials never enter generic teacher broadcasts.';

create or replace function private.secure_trial_payload_fingerprint(
  p_payload jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(coalesce(p_payload, 'null'::jsonb)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$function$;

alter function private.secure_trial_payload_fingerprint(jsonb)
  owner to postgres;
revoke all on function private.secure_trial_payload_fingerprint(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.secure_trial_payload_fingerprint(jsonb)
  to postgres;

create or replace function private.secure_trial_actor_context()
returns table (
  actor_id uuid,
  tenant_id text,
  actor_role text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    profile.id,
    membership.tenant_id,
    case
      when profile.role = 'SUPER_ADMIN' then 'SUPER_ADMIN'
      else membership.role
    end
  from public.profiles as profile
  join public.tenant_memberships as membership
    on membership.user_id = profile.id
   and membership.tenant_id = private.active_tenant_id(profile.id)
   and membership.status = 'ACTIVE'
  where profile.id = (select auth.uid())
    and lower(trim(coalesce(profile.lifecycle_status, 'active'))) = 'active'
  limit 1;
$function$;

alter function private.secure_trial_actor_context()
  owner to postgres;
revoke all on function private.secure_trial_actor_context()
  from public, anon, authenticated, service_role;
grant execute on function private.secure_trial_actor_context()
  to postgres;

create or replace function private.secure_trial_portal_origin(
  p_tenant_id text
)
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(
    case
      when tenant.custom_domain_verified is true
       and lower(trim(coalesce(tenant.custom_domain, ''))) ~
         '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
      then 'https://' || lower(trim(tenant.custom_domain))
    end,
    case
      when lower(trim(coalesce(tenant.domain, ''))) ~
         '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
      then 'https://' || lower(trim(tenant.domain))
    end,
    case
      when lower(trim(coalesce(tenant.slug, ''))) ~
         '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$'
      then 'https://' || lower(trim(tenant.slug)) ||
           '.wisewolflanguage.com.br'
    end,
    'https://system.wisewolflanguage.com.br'
  )
  from public.tenants as tenant
  where tenant.id = p_tenant_id;
$function$;

alter function private.secure_trial_portal_origin(text)
  owner to postgres;
revoke all on function private.secure_trial_portal_origin(text)
  from public, anon, authenticated, service_role;
grant execute on function private.secure_trial_portal_origin(text)
  to postgres;

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
    p_tenant_id is null
    or p_teacher_id is null
    or p_start_time is null
    or exists (
      select 1
        from public.appointments as appointment
       where appointment.tenant_id = p_tenant_id
         and appointment.id is distinct from p_exclude_appointment_id
         and (
           appointment.teacher_id = p_teacher_id
           or appointment.professor_id = p_teacher_id
         )
         and lower(coalesce(appointment.status, '')) in (
           'scheduled', 'confirmed'
         )
         and appointment.start_time > p_start_time - interval '30 minutes'
         and appointment.start_time < p_start_time + interval '30 minutes'
    )
    or exists (
      select 1
        from public.bookings as booking
       where booking.tenant_id = p_tenant_id
         and booking.teacher_id = p_teacher_id
         and lower(coalesce(booking.status, 'scheduled')) not in (
           'cancelled', 'canceled', 'inactive'
         )
         and public.dow_name_to_int(booking.day_of_week) = extract(
           dow from (p_start_time at time zone 'America/Sao_Paulo')::date
         )::integer
         and (
           booking.date is null
           or booking.date =
             (p_start_time at time zone 'America/Sao_Paulo')::date
         )
         and case
           when trim(coalesce(booking.time_slot, '')) ~
                '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
           then abs(extract(epoch from (
             left(trim(booking.time_slot), 5)::time -
             (p_start_time at time zone 'America/Sao_Paulo')::time
           ))) < 1800
           else false
         end
    )
    or exists (
      select 1
        from private.vendor_trial_teacher_requests as request
       where request.tenant_id = p_tenant_id
         and request.target_teacher_id = p_teacher_id
         and (
           p_exclude_enrollment_link_id is null
           or request.enrollment_link_id is distinct from
                p_exclude_enrollment_link_id
         )
         and request.status in ('AWAITING_STUDENT', 'AWAITING_TEACHER')
         and request.slot_start > p_start_time - interval '30 minutes'
         and request.slot_start < p_start_time + interval '30 minutes'
    );
$function$;

alter function private.secure_trial_schedule_conflict(
  text, uuid, timestamptz, uuid, uuid
) owner to postgres;
revoke all on function private.secure_trial_schedule_conflict(
  text, uuid, timestamptz, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function private.secure_trial_schedule_conflict(
  text, uuid, timestamptz, uuid, uuid
) to postgres;

-- Replace every accumulated permissive policy, including the historical
-- public enrollment-link lookup.
do $policies$
declare
  v_table text;
  v_policy record;
begin
  foreach v_table in array array[
    'opportunities', 'appointments', 'enrollment_links'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    for v_policy in
      select policyname
        from pg_catalog.pg_policies
       where schemaname = 'public'
         and tablename = v_table
    loop
      execute format(
        'drop policy if exists %I on public.%I',
        v_policy.policyname,
        v_table
      );
    end loop;
  end loop;
end
$policies$;

drop function if exists private.secure_trial_has_active_membership(text, text[]);

revoke all on table public.opportunities
  from public, anon, authenticated;
revoke all on table public.appointments
  from public, anon, authenticated;
revoke all on table public.enrollment_links
  from public, anon, authenticated;

grant select on table public.opportunities to authenticated;
grant select on table public.appointments to authenticated;
grant select on table public.enrollment_links to authenticated;

create policy secure_trial_opportunities_staff_select
on public.opportunities
for select
to authenticated
using (
  opportunities.tenant_id = (select public._my_tenant_id())
  and (select public._my_role()) in (
    'SCHOOL_ADMIN', 'COORDINATOR', 'COMMERCIAL',
    'SALESPERSON', 'SUPER_ADMIN'
  )
);

create policy secure_trial_appointments_select
on public.appointments
for select
to authenticated
using (
  appointments.tenant_id = (select public._my_tenant_id())
  and (
    (select public._my_role()) in (
      'SCHOOL_ADMIN', 'COORDINATOR', 'COMMERCIAL',
      'SALESPERSON', 'SUPER_ADMIN'
    )
    or (
      (select public._my_role()) = 'TEACHER'
      and (
        appointments.teacher_id = (select auth.uid())
        or appointments.professor_id = (select auth.uid())
      )
    )
  )
);

create policy secure_trial_enrollment_links_staff_select
on public.enrollment_links
for select
to authenticated
using (
  enrollment_links.tenant_id = (select public._my_tenant_id())
  and (select public._my_role()) in (
    'SCHOOL_ADMIN', 'COORDINATOR', 'COMMERCIAL',
    'SALESPERSON', 'SUPER_ADMIN'
  )
);

create or replace function public.get_teacher_opportunity_preview_secure(
  p_opportunity_id uuid,
  p_claim_generation integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_tenant_id text;
  v_actor_role text;
  v_opportunity public.opportunities%rowtype;
  v_request private.vendor_trial_teacher_requests%rowtype;
begin
  if p_opportunity_id is null
     or p_claim_generation is null
     or p_claim_generation < 1 then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  select actor.actor_id, actor.tenant_id, actor.actor_role
    into v_actor_id, v_tenant_id, v_actor_role
    from private.secure_trial_actor_context() as actor;

  if v_actor_id is null or v_actor_role <> 'TEACHER' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if not private.tenant_is_operational(v_tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'tenant_not_operational');
  end if;
  if not exists (
    select 1
      from public.profiles as profile
     where profile.id = v_actor_id
       and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
  ) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select opportunity.*
    into v_opportunity
    from public.opportunities as opportunity
   where opportunity.id = p_opportunity_id
     and opportunity.tenant_id = v_tenant_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'opportunity_not_found');
  end if;
  if v_opportunity.claim_generation is distinct from p_claim_generation then
    return jsonb_build_object('ok', false, 'error', 'claim_link_expired');
  end if;

  select request.*
    into v_request
    from private.vendor_trial_teacher_requests as request
   where request.opportunity_id = v_opportunity.id;

  if found and (
    v_request.target_teacher_id <> v_actor_id
    or v_request.status not in ('AWAITING_TEACHER', 'ACCEPTED')
  ) then
    return jsonb_build_object('ok', false, 'error', 'opportunity_not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_opportunity.id,
    'student_name', v_opportunity.student_name,
    'slots_proposed', v_opportunity.slots_proposed,
    'status', v_opportunity.status,
    'kind', coalesce(v_opportunity.kind, 'TRIAL'),
    'interests', v_opportunity.interests,
    'winner_teacher_id', v_opportunity.winner_teacher_id,
    'trial_appointment_id', v_opportunity.trial_appointment_id,
    'claim_generation', v_opportunity.claim_generation
  );
end;
$function$;

alter function public.get_teacher_opportunity_preview_secure(uuid, integer)
  owner to postgres;
revoke all on function public.get_teacher_opportunity_preview_secure(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_teacher_opportunity_preview_secure(uuid, integer)
  to authenticated;

create or replace function private.enforce_vendor_trial_teacher_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request private.vendor_trial_teacher_requests%rowtype;
begin
  if upper(coalesce(old.status, '')) = 'OPEN'
     and upper(coalesce(new.status, '')) = 'CLAIMED' then
    select request.*
      into v_request
      from private.vendor_trial_teacher_requests as request
     where request.opportunity_id = old.id
     for update;

    if found then
      if v_request.status <> 'AWAITING_TEACHER'
         or new.winner_teacher_id is distinct from
              v_request.target_teacher_id
         or new.professor_id is distinct from v_request.target_teacher_id
         or new.trial_appointment_id is null
         or not exists (
           select 1
             from public.appointments as appointment
            where appointment.id = new.trial_appointment_id
              and appointment.tenant_id = v_request.tenant_id
              and appointment.teacher_id = v_request.target_teacher_id
              and appointment.professor_id = v_request.target_teacher_id
              and appointment.start_time = v_request.slot_start
              and lower(coalesce(appointment.status, '')) in (
                'scheduled', 'confirmed'
              )
         ) then
        raise exception 'vendor_trial_teacher_acceptance_required'
          using errcode = '42501';
      end if;

      update private.vendor_trial_teacher_requests
         set status = 'ACCEPTED',
             accepted_at = now(),
             accepted_appointment_id = new.trial_appointment_id,
             updated_at = now()
       where id = v_request.id;
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists enforce_vendor_trial_teacher_acceptance
  on public.opportunities;
create trigger enforce_vendor_trial_teacher_acceptance
before update of status, winner_teacher_id, professor_id, trial_appointment_id
on public.opportunities
for each row
execute function private.enforce_vendor_trial_teacher_acceptance();

alter function private.enforce_vendor_trial_teacher_acceptance()
  owner to postgres;
revoke all on function private.enforce_vendor_trial_teacher_acceptance()
  from public, anon, authenticated, service_role;

create or replace function public.schedule_manual_trial_secure(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_tenant_id text;
  v_actor_role text;
  v_request_id uuid;
  v_teacher_id uuid;
  v_teacher_name text;
  v_student_name text;
  v_student_phone text;
  v_start_time timestamptz;
  v_local_date date;
  v_local_time time without time zone;
  v_slot jsonb;
  v_opportunity_id uuid;
  v_confirmation_url text;
  v_fingerprint text;
  v_existing_fingerprint text;
  v_existing_response jsonb;
  v_response jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object'
     or not p_payload ?& array[
       'requestId', 'teacherId', 'studentName', 'studentPhone', 'startsAt'
     ]
     or (select count(*) from jsonb_object_keys(p_payload)) <> 5 then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  begin
    v_request_id := (p_payload ->> 'requestId')::uuid;
    v_teacher_id := (p_payload ->> 'teacherId')::uuid;
    if coalesce(p_payload ->> 'startsAt', '') !~
       '(?:[zZ]|[+-][0-9]{2}:[0-9]{2})$' then
      return jsonb_build_object('ok', false, 'error', 'invalid_start_time');
    end if;
    v_start_time := (p_payload ->> 'startsAt')::timestamptz;
  exception
    when invalid_text_representation
       or invalid_datetime_format
       or datetime_field_overflow then
      return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end;

  v_student_name := trim(coalesce(p_payload ->> 'studentName', ''));
  v_student_phone := regexp_replace(
    coalesce(p_payload ->> 'studentPhone', ''), '[^0-9]', '', 'g'
  );
  if length(v_student_name) not between 2 and 160 then
    return jsonb_build_object('ok', false, 'error', 'invalid_student_name');
  end if;
  if v_student_phone = '' then
    v_student_phone := null;
  elsif length(v_student_phone) not between 10 and 15 then
    return jsonb_build_object('ok', false, 'error', 'invalid_student_phone');
  end if;
  if v_start_time <= now() + interval '5 minutes'
     or v_start_time > now() + interval '366 days' then
    return jsonb_build_object('ok', false, 'error', 'invalid_start_time');
  end if;

  select actor.actor_id, actor.tenant_id, actor.actor_role
    into v_actor_id, v_tenant_id, v_actor_role
    from private.secure_trial_actor_context() as actor;

  if v_actor_id is null
     or v_actor_role not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if not private.tenant_is_operational(v_tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'tenant_not_operational');
  end if;

  select profile.full_name
    into v_teacher_name
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = v_tenant_id
     and membership.role = 'TEACHER'
     and membership.status = 'ACTIVE'
   where profile.id = v_teacher_id
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
   for share of profile, membership;

  if not found then
    return jsonb_build_object(
      'ok', false, 'error', 'teacher_not_active_for_tenant'
    );
  end if;

  v_fingerprint := private.secure_trial_payload_fingerprint(p_payload);
  select receipt.payload_fingerprint, receipt.response
    into v_existing_fingerprint, v_existing_response
    from private.secure_trial_command_receipts as receipt
   where receipt.tenant_id = v_tenant_id
     and receipt.actor_id = v_actor_id
     and receipt.command = 'MANUAL_SCHEDULE'
     and receipt.request_id = v_request_id;
  if found then
    if v_existing_fingerprint <> v_fingerprint then
      return jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_existing_response, '{}'::jsonb)
      || jsonb_build_object('idempotent', true);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_teacher_id::text, 0)
  );

  select receipt.payload_fingerprint, receipt.response
    into v_existing_fingerprint, v_existing_response
    from private.secure_trial_command_receipts as receipt
   where receipt.tenant_id = v_tenant_id
     and receipt.actor_id = v_actor_id
     and receipt.command = 'MANUAL_SCHEDULE'
     and receipt.request_id = v_request_id;
  if found then
    if v_existing_fingerprint <> v_fingerprint then
      return jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_existing_response, '{}'::jsonb)
      || jsonb_build_object('idempotent', true);
  end if;

  if private.secure_trial_schedule_conflict(
    v_tenant_id, v_teacher_id, v_start_time, null, null
  ) then
    return jsonb_build_object(
      'ok', false, 'error', 'teacher_schedule_conflict'
    );
  end if;

  insert into private.secure_trial_command_receipts (
    tenant_id, actor_id, command, request_id, payload_fingerprint
  ) values (
    v_tenant_id, v_actor_id, 'MANUAL_SCHEDULE',
    v_request_id, v_fingerprint
  )
  on conflict do nothing;

  if not found then
    select receipt.payload_fingerprint, receipt.response
      into v_existing_fingerprint, v_existing_response
      from private.secure_trial_command_receipts as receipt
     where receipt.tenant_id = v_tenant_id
       and receipt.actor_id = v_actor_id
       and receipt.command = 'MANUAL_SCHEDULE'
       and receipt.request_id = v_request_id;
    if v_existing_fingerprint <> v_fingerprint then
      return jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_existing_response, '{}'::jsonb)
      || jsonb_build_object('idempotent', true);
  end if;

  v_local_date := (v_start_time at time zone 'America/Sao_Paulo')::date;
  v_local_time := (v_start_time at time zone 'America/Sao_Paulo')::time;
  v_slot := jsonb_build_object(
    'day', extract(dow from v_local_date)::integer,
    'date', to_char(v_local_date, 'YYYY-MM-DD'),
    'time', to_char(v_local_time, 'HH24:MI'),
    'formatted', to_char(v_local_date, 'DD/MM/YYYY') || ' às ' ||
      to_char(v_local_time, 'HH24:MI'),
    'start_time', v_start_time
  );

  insert into public.opportunities (
    tenant_id, student_name, student_phone, slots_proposed,
    status, kind, conversion_status, opened_at, claim_generation
  ) values (
    v_tenant_id, v_student_name, v_student_phone,
    jsonb_build_array(v_slot), 'OPEN', 'TRIAL', 'OPEN', now(), 1
  )
  returning id into v_opportunity_id;

  insert into private.vendor_trial_teacher_requests (
    tenant_id, opportunity_id, target_teacher_id,
    requested_by, slot_start, status, student_confirmed_at
  ) values (
    v_tenant_id, v_opportunity_id, v_teacher_id,
    v_actor_id, v_start_time, 'AWAITING_TEACHER', now()
  );

  v_confirmation_url := private.secure_trial_portal_origin(v_tenant_id)
    || '/claim-opportunity?id=' || v_opportunity_id::text || '&g=1';

  v_response := jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'opportunityId', v_opportunity_id,
    'teacherName', coalesce(nullif(trim(v_teacher_name), ''), 'Professor(a)'),
    'startsAt', v_start_time,
    'state', 'AWAITING_TEACHER',
    'teacherConfirmationUrl', v_confirmation_url
  );

  update private.secure_trial_command_receipts
     set response = v_response,
         completed_at = now()
   where tenant_id = v_tenant_id
     and actor_id = v_actor_id
     and command = 'MANUAL_SCHEDULE'
     and request_id = v_request_id;

  return v_response;
end;
$function$;

alter function public.schedule_manual_trial_secure(jsonb) owner to postgres;
revoke all on function public.schedule_manual_trial_secure(jsonb)
  from public, anon, authenticated;
grant execute on function public.schedule_manual_trial_secure(jsonb)
  to authenticated;

create or replace function public.create_vendor_trial_link_secure(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_tenant_id text;
  v_actor_role text;
  v_request_id uuid;
  v_teacher_id uuid;
  v_teacher_name text;
  v_student_name text;
  v_student_phone text;
  v_weekday integer;
  v_slot_time time without time zone;
  v_local_now timestamp without time zone;
  v_slot_date date;
  v_start_time timestamptz;
  v_slot jsonb;
  v_opportunity_id uuid;
  v_link_id uuid;
  v_link_token text;
  v_link_url text;
  v_fingerprint text;
  v_existing_fingerprint text;
  v_existing_response jsonb;
  v_response jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object'
     or not p_payload ?& array[
       'requestId', 'teacherId', 'studentName',
       'studentPhone', 'weekday', 'time'
     ]
     or (select count(*) from jsonb_object_keys(p_payload)) <> 6 then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  begin
    v_request_id := (p_payload ->> 'requestId')::uuid;
    v_teacher_id := (p_payload ->> 'teacherId')::uuid;
    v_weekday := (p_payload ->> 'weekday')::integer;
    v_slot_time := (p_payload ->> 'time')::time;
  exception
    when invalid_text_representation
       or invalid_datetime_format
       or datetime_field_overflow then
      return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end;

  if jsonb_typeof(p_payload -> 'weekday') <> 'number'
     or v_weekday not between 0 and 6
     or coalesce(p_payload ->> 'time', '') !~
        '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_slot');
  end if;

  v_student_name := trim(coalesce(p_payload ->> 'studentName', ''));
  v_student_phone := regexp_replace(
    coalesce(p_payload ->> 'studentPhone', ''), '[^0-9]', '', 'g'
  );
  if length(v_student_name) not between 2 and 160 then
    return jsonb_build_object('ok', false, 'error', 'invalid_student_name');
  end if;
  if length(v_student_phone) not between 10 and 15 then
    return jsonb_build_object('ok', false, 'error', 'invalid_student_phone');
  end if;

  select actor.actor_id, actor.tenant_id, actor.actor_role
    into v_actor_id, v_tenant_id, v_actor_role
    from private.secure_trial_actor_context() as actor;

  if v_actor_id is null or v_actor_role <> 'SALESPERSON' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if not private.tenant_is_operational(v_tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'tenant_not_operational');
  end if;

  select profile.full_name
    into v_teacher_name
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = v_tenant_id
     and membership.role = 'TEACHER'
     and membership.status = 'ACTIVE'
   where profile.id = v_teacher_id
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
   for share of profile, membership;

  if not found then
    return jsonb_build_object(
      'ok', false, 'error', 'teacher_not_active_for_tenant'
    );
  end if;

  v_local_now := now() at time zone 'America/Sao_Paulo';
  v_slot_date := v_local_now::date +
    ((v_weekday - extract(dow from v_local_now)::integer + 7) % 7);
  v_start_time := (v_slot_date + v_slot_time)
    at time zone 'America/Sao_Paulo';
  if v_start_time < now() + interval '1 hour' then
    v_slot_date := v_slot_date + 7;
    v_start_time := (v_slot_date + v_slot_time)
      at time zone 'America/Sao_Paulo';
  end if;
  if v_start_time > now() + interval '31 days' then
    return jsonb_build_object('ok', false, 'error', 'invalid_slot');
  end if;

  v_fingerprint := private.secure_trial_payload_fingerprint(p_payload);
  select receipt.payload_fingerprint, receipt.response
    into v_existing_fingerprint, v_existing_response
    from private.secure_trial_command_receipts as receipt
   where receipt.tenant_id = v_tenant_id
     and receipt.actor_id = v_actor_id
     and receipt.command = 'VENDOR_TRIAL_LINK'
     and receipt.request_id = v_request_id;
  if found then
    if v_existing_fingerprint <> v_fingerprint then
      return jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_existing_response, '{}'::jsonb)
      || jsonb_build_object('idempotent', true);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_teacher_id::text, 0)
  );

  select receipt.payload_fingerprint, receipt.response
    into v_existing_fingerprint, v_existing_response
    from private.secure_trial_command_receipts as receipt
   where receipt.tenant_id = v_tenant_id
     and receipt.actor_id = v_actor_id
     and receipt.command = 'VENDOR_TRIAL_LINK'
     and receipt.request_id = v_request_id;
  if found then
    if v_existing_fingerprint <> v_fingerprint then
      return jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_existing_response, '{}'::jsonb)
      || jsonb_build_object('idempotent', true);
  end if;

  if private.secure_trial_schedule_conflict(
    v_tenant_id, v_teacher_id, v_start_time, null, null
  ) then
    return jsonb_build_object(
      'ok', false, 'error', 'teacher_schedule_conflict'
    );
  end if;

  insert into private.secure_trial_command_receipts (
    tenant_id, actor_id, command, request_id, payload_fingerprint
  ) values (
    v_tenant_id, v_actor_id, 'VENDOR_TRIAL_LINK',
    v_request_id, v_fingerprint
  )
  on conflict do nothing;

  if not found then
    select receipt.payload_fingerprint, receipt.response
      into v_existing_fingerprint, v_existing_response
      from private.secure_trial_command_receipts as receipt
     where receipt.tenant_id = v_tenant_id
       and receipt.actor_id = v_actor_id
       and receipt.command = 'VENDOR_TRIAL_LINK'
       and receipt.request_id = v_request_id;
    if v_existing_fingerprint <> v_fingerprint then
      return jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_existing_response, '{}'::jsonb)
      || jsonb_build_object('idempotent', true);
  end if;

  v_slot := jsonb_build_object(
    'day', v_weekday,
    'date', to_char(v_slot_date, 'YYYY-MM-DD'),
    'time', to_char(v_slot_time, 'HH24:MI'),
    'formatted', to_char(v_slot_date, 'DD/MM/YYYY') || ' às ' ||
      to_char(v_slot_time, 'HH24:MI'),
    'start_time', v_start_time
  );
  v_link_token := pg_catalog.encode(
    extensions.gen_random_bytes(24), 'hex'
  );
  v_link_url := private.secure_trial_portal_origin(v_tenant_id)
    || '/experimental?token=' || v_link_token;

  insert into public.opportunities (
    tenant_id, student_name, student_phone, slots_proposed,
    status, kind, conversion_status, created_by_vendor_id,
    opened_at, claim_generation
  ) values (
    v_tenant_id, v_student_name, v_student_phone,
    jsonb_build_array(v_slot), 'OPEN', 'TRIAL', 'OPEN', v_actor_id,
    now(), 1
  )
  returning id into v_opportunity_id;

  insert into public.enrollment_links (
    tenant_id, opportunity_id, link_token, link_url,
    student_name, student_phone, professor_id,
    status, created_by_vendor_id, purpose, expires_at
  ) values (
    v_tenant_id, v_opportunity_id, v_link_token, v_link_url,
    v_student_name, v_student_phone, v_teacher_id,
    'PENDING', v_actor_id, 'TRIAL_CONFIRMATION', v_start_time
  )
  returning id into v_link_id;

  insert into private.vendor_trial_teacher_requests (
    tenant_id, opportunity_id, enrollment_link_id,
    target_teacher_id, requested_by, slot_start, status
  ) values (
    v_tenant_id, v_opportunity_id, v_link_id,
    v_teacher_id, v_actor_id, v_start_time, 'AWAITING_STUDENT'
  );

  v_response := jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'opportunityId', v_opportunity_id,
    'linkId', v_link_id,
    'confirmationUrl', v_link_url,
    'teacherName', coalesce(nullif(trim(v_teacher_name), ''), 'Professor(a)'),
    'startsAt', v_start_time,
    'state', 'AWAITING_STUDENT'
  );

  update private.secure_trial_command_receipts
     set response = v_response,
         completed_at = now()
   where tenant_id = v_tenant_id
     and actor_id = v_actor_id
     and command = 'VENDOR_TRIAL_LINK'
     and request_id = v_request_id;

  return v_response;
end;
$function$;

alter function public.create_vendor_trial_link_secure(jsonb)
  owner to postgres;
revoke all on function public.create_vendor_trial_link_secure(jsonb)
  from public, anon, authenticated;
grant execute on function public.create_vendor_trial_link_secure(jsonb)
  to authenticated;

create or replace function public.update_trial_outcome_secure(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_tenant_id text;
  v_actor_role text;
  v_request_id uuid;
  v_opportunity_id uuid;
  v_action text;
  v_trial_status text;
  v_lost_reason text;
  v_recommended_level text;
  v_recommended_plan text;
  v_interest_score integer;
  v_notes text;
  v_opportunity public.opportunities%rowtype;
  v_appointment public.appointments%rowtype;
  v_feedback public.trial_feedback%rowtype;
  v_teacher_id uuid;
  v_feedback_id uuid;
  v_class_log_id uuid;
  v_fingerprint text;
  v_existing_fingerprint text;
  v_existing_response jsonb;
  v_response jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object'
     or not p_payload ?& array['requestId', 'opportunityId', 'action'] then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  v_action := upper(trim(coalesce(p_payload ->> 'action', '')));
  if (
    v_action = 'SAVE_FEEDBACK'
    and (
      not p_payload ?& array[
        'recommendedLevel', 'recommendedPlan', 'interestScore', 'notes'
      ]
      or (select count(*) from jsonb_object_keys(p_payload)) <> 7
    )
  ) or (
    v_action = 'SET_TRIAL_STATUS'
    and (
      not p_payload ? 'trialStatus'
      or (select count(*) from jsonb_object_keys(p_payload)) <> 4
    )
  ) or (
    v_action = 'MARK_LOST'
    and (
      not p_payload ? 'lostReason'
      or (select count(*) from jsonb_object_keys(p_payload)) <> 4
    )
  ) or v_action not in (
    'SAVE_FEEDBACK', 'SET_TRIAL_STATUS', 'MARK_LOST'
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  begin
    v_request_id := (p_payload ->> 'requestId')::uuid;
    v_opportunity_id := (p_payload ->> 'opportunityId')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end;

  select actor.actor_id, actor.tenant_id, actor.actor_role
    into v_actor_id, v_tenant_id, v_actor_role
    from private.secure_trial_actor_context() as actor;

  if v_actor_id is null then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if v_action = 'SAVE_FEEDBACK' and v_actor_role <> 'TEACHER' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if v_action in ('SET_TRIAL_STATUS', 'MARK_LOST')
     and v_actor_role not in (
       'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'
     ) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if not private.tenant_is_operational(v_tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'tenant_not_operational');
  end if;

  if v_action = 'SAVE_FEEDBACK' then
    v_trial_status := 'DONE';
    v_recommended_level := upper(trim(coalesce(
      p_payload ->> 'recommendedLevel', ''
    )));
    v_recommended_plan := trim(coalesce(
      p_payload ->> 'recommendedPlan', ''
    ));
    v_notes := nullif(trim(coalesce(p_payload ->> 'notes', '')), '');
    begin
      v_interest_score := (p_payload ->> 'interestScore')::integer;
    exception when invalid_text_representation then
      return jsonb_build_object('ok', false, 'error', 'invalid_feedback');
    end;
    if v_recommended_level not in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
       or v_recommended_plan not in (
         '1x_semana', '2x_semana', '3x_semana', 'intensivo'
       )
       or v_interest_score not between 1 and 5
       or length(coalesce(v_notes, '')) > 4000 then
      return jsonb_build_object('ok', false, 'error', 'invalid_feedback');
    end if;
  elsif v_action = 'SET_TRIAL_STATUS' then
    v_trial_status := upper(trim(coalesce(
      p_payload ->> 'trialStatus', ''
    )));
    if v_trial_status not in (
      'DONE', 'NO_SHOW_STUDENT', 'NO_SHOW_TEACHER'
    ) then
      return jsonb_build_object('ok', false, 'error', 'invalid_trial_status');
    end if;
  else
    v_lost_reason := trim(coalesce(p_payload ->> 'lostReason', ''));
    if v_lost_reason = '' then
      v_lost_reason := 'Não especificado';
    end if;
    if length(v_lost_reason) > 500 then
      return jsonb_build_object('ok', false, 'error', 'invalid_lost_reason');
    end if;
  end if;

  v_fingerprint := private.secure_trial_payload_fingerprint(p_payload);
  select receipt.payload_fingerprint, receipt.response
    into v_existing_fingerprint, v_existing_response
    from private.secure_trial_command_receipts as receipt
   where receipt.tenant_id = v_tenant_id
     and receipt.actor_id = v_actor_id
     and receipt.command = 'TRIAL_OUTCOME'
     and receipt.request_id = v_request_id;
  if found then
    if v_existing_fingerprint <> v_fingerprint then
      return jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_existing_response, '{}'::jsonb)
      || jsonb_build_object('idempotent', true);
  end if;

  select opportunity.*
    into v_opportunity
    from public.opportunities as opportunity
   where opportunity.id = v_opportunity_id
     and opportunity.tenant_id = v_tenant_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'opportunity_not_found');
  end if;

  select receipt.payload_fingerprint, receipt.response
    into v_existing_fingerprint, v_existing_response
    from private.secure_trial_command_receipts as receipt
   where receipt.tenant_id = v_tenant_id
     and receipt.actor_id = v_actor_id
     and receipt.command = 'TRIAL_OUTCOME'
     and receipt.request_id = v_request_id;
  if found then
    if v_existing_fingerprint <> v_fingerprint then
      return jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_existing_response, '{}'::jsonb)
      || jsonb_build_object('idempotent', true);
  end if;

  if upper(coalesce(v_opportunity.status, '')) <> 'CLAIMED'
     or upper(coalesce(v_opportunity.kind, 'TRIAL')) <> 'TRIAL' then
    return jsonb_build_object(
      'ok', false, 'error', 'opportunity_not_claimed_trial'
    );
  end if;
  if coalesce(v_opportunity.conversion_status, 'OPEN') = 'WON' then
    return jsonb_build_object('ok', false, 'error', 'opportunity_already_won');
  end if;

  v_teacher_id := coalesce(
    v_opportunity.winner_teacher_id,
    v_opportunity.professor_id
  );
  if v_teacher_id is null
     or (
       v_opportunity.winner_teacher_id is not null
       and v_opportunity.winner_teacher_id <> v_teacher_id
     )
     or (
       v_opportunity.professor_id is not null
       and v_opportunity.professor_id <> v_teacher_id
     )
     or not exists (
       select 1
         from public.profiles as profile
         join public.tenant_memberships as membership
           on membership.user_id = profile.id
          and membership.tenant_id = v_tenant_id
          and membership.role = 'TEACHER'
          and membership.status = 'ACTIVE'
        where profile.id = v_teacher_id
          and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
     ) then
    return jsonb_build_object(
      'ok', false, 'error', 'teacher_not_active_for_tenant'
    );
  end if;

  if v_opportunity.created_by_vendor_id is not null
     and not exists (
       select 1
         from public.tenant_memberships as membership
        where membership.user_id = v_opportunity.created_by_vendor_id
          and membership.tenant_id = v_tenant_id
          and membership.role in ('SALESPERSON', 'COMMERCIAL')
     ) then
    return jsonb_build_object('ok', false, 'error', 'vendor_tenant_mismatch');
  end if;
  if v_opportunity.student_id is not null
     and not exists (
       select 1
         from public.tenant_memberships as membership
         join public.profiles as profile
           on profile.id = membership.user_id
        where membership.user_id = v_opportunity.student_id
          and membership.tenant_id = v_tenant_id
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
          and lower(trim(coalesce(profile.lifecycle_status, 'active'))) = 'active'
     ) then
    return jsonb_build_object('ok', false, 'error', 'student_tenant_mismatch');
  end if;

  if v_opportunity.trial_appointment_id is not null then
    select appointment.*
      into v_appointment
      from public.appointments as appointment
     where appointment.id = v_opportunity.trial_appointment_id
     for update;

    if not found
       or v_appointment.tenant_id <> v_tenant_id
       or coalesce(v_appointment.teacher_id, v_appointment.professor_id)
          is distinct from v_teacher_id
       or (
         v_appointment.teacher_id is not null
         and v_appointment.teacher_id <> v_teacher_id
       )
       or (
         v_appointment.professor_id is not null
         and v_appointment.professor_id <> v_teacher_id
       )
       or lower(coalesce(v_appointment.type, '')) <> 'experimental' then
      return jsonb_build_object(
        'ok', false, 'error', 'appointment_tenant_mismatch'
      );
    end if;
  elsif v_action <> 'MARK_LOST' then
    return jsonb_build_object('ok', false, 'error', 'appointment_required');
  end if;

  if v_action = 'SAVE_FEEDBACK' and v_teacher_id <> v_actor_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_action in ('SAVE_FEEDBACK', 'SET_TRIAL_STATUS') then
    if v_trial_status = 'DONE' then
      if lower(coalesce(v_appointment.status, '')) not in (
        'scheduled', 'confirmed', 'completed'
      ) then
        return jsonb_build_object(
          'ok', false, 'error', 'appointment_not_settleable'
        );
      end if;
      if exists (
        select 1
          from public.class_logs as class_log
         where class_log.appointment_id = v_appointment.id::text
           and (
             class_log.tenant_id <> v_tenant_id
             or class_log.teacher_id <> v_teacher_id
             or class_log.presence <> 'COMPLETED'
           )
      ) then
        return jsonb_build_object(
          'ok', false, 'error', 'class_log_tenant_mismatch'
        );
      end if;
    else
      if lower(coalesce(v_appointment.status, '')) not in (
        'scheduled', 'confirmed', 'no_show'
      ) then
        return jsonb_build_object(
          'ok', false, 'error', 'appointment_not_settleable'
        );
      end if;
      if exists (
        select 1
          from public.class_logs as class_log
         where class_log.appointment_id = v_appointment.id::text
      ) then
        return jsonb_build_object(
          'ok', false, 'error', 'trial_already_settled'
        );
      end if;
    end if;
  end if;

  if v_action = 'SAVE_FEEDBACK' then
    select feedback.*
      into v_feedback
      from public.trial_feedback as feedback
     where feedback.opportunity_id = v_opportunity.id
     for update;
    if found and (
      v_feedback.tenant_id <> v_tenant_id
      or v_feedback.teacher_id <> v_actor_id
      or v_feedback.booking_id is distinct from v_appointment.id
    ) then
      return jsonb_build_object(
        'ok', false, 'error', 'feedback_tenant_mismatch'
      );
    end if;
  end if;

  insert into private.secure_trial_command_receipts (
    tenant_id, actor_id, command, request_id, payload_fingerprint
  ) values (
    v_tenant_id, v_actor_id, 'TRIAL_OUTCOME',
    v_request_id, v_fingerprint
  )
  on conflict do nothing;

  if not found then
    select receipt.payload_fingerprint, receipt.response
      into v_existing_fingerprint, v_existing_response
      from private.secure_trial_command_receipts as receipt
     where receipt.tenant_id = v_tenant_id
       and receipt.actor_id = v_actor_id
       and receipt.command = 'TRIAL_OUTCOME'
       and receipt.request_id = v_request_id;
    if v_existing_fingerprint <> v_fingerprint then
      return jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_existing_response, '{}'::jsonb)
      || jsonb_build_object('idempotent', true);
  end if;

  if v_action = 'MARK_LOST' then
    update public.opportunities
       set conversion_status = 'LOST',
           lost_reason = v_lost_reason
     where id = v_opportunity.id
       and tenant_id = v_tenant_id;

    v_response := jsonb_build_object(
      'ok', true,
      'idempotent', false,
      'opportunityId', v_opportunity.id,
      'conversionStatus', 'LOST',
      'lostReason', v_lost_reason
    );
  else
    if v_action = 'SAVE_FEEDBACK' then
      insert into public.trial_feedback as feedback (
        tenant_id, opportunity_id, booking_id, teacher_id,
        recommended_level, recommended_plan, interest_score, notes
      ) values (
        v_tenant_id, v_opportunity.id, v_appointment.id, v_actor_id,
        v_recommended_level, v_recommended_plan, v_interest_score, v_notes
      )
      on conflict (opportunity_id) do update
        set booking_id = excluded.booking_id,
            recommended_level = excluded.recommended_level,
            recommended_plan = excluded.recommended_plan,
            interest_score = excluded.interest_score,
            notes = excluded.notes
      where feedback.tenant_id = excluded.tenant_id
        and feedback.teacher_id = excluded.teacher_id
      returning id into v_feedback_id;

      if v_feedback_id is null then
        raise exception 'secure_trial_feedback_lost_lock'
          using errcode = '40001';
      end if;
    end if;

    if v_trial_status = 'DONE' then
      insert into public.class_logs (
        tenant_id, teacher_id, appointment_id, presence, subtype,
        date, class_date, start_time, created_at
      ) values (
        v_tenant_id, v_teacher_id, v_appointment.id::text,
        'COMPLETED', 'AULA EXPERIMENTAL',
        (v_appointment.start_time at time zone 'America/Sao_Paulo')::date,
        (v_appointment.start_time at time zone 'America/Sao_Paulo')::date,
        (v_appointment.start_time at time zone 'America/Sao_Paulo')::time,
        now()
      )
      on conflict do nothing
      returning id into v_class_log_id;

      if v_class_log_id is null then
        select class_log.id
          into v_class_log_id
          from public.class_logs as class_log
         where class_log.appointment_id = v_appointment.id::text
           and class_log.tenant_id = v_tenant_id
           and class_log.teacher_id = v_teacher_id
           and class_log.presence = 'COMPLETED';
      end if;

      update public.appointments
         set status = 'completed'
       where id = v_appointment.id
         and tenant_id = v_tenant_id;
    else
      update public.appointments
         set status = 'no_show'
       where id = v_appointment.id
         and tenant_id = v_tenant_id;
    end if;

    update public.opportunities
       set trial_status = v_trial_status
     where id = v_opportunity.id
       and tenant_id = v_tenant_id;

    v_response := jsonb_build_object(
      'ok', true,
      'idempotent', false,
      'opportunityId', v_opportunity.id,
      'appointmentId', v_appointment.id,
      'trialStatus', v_trial_status,
      'appointmentStatus', case
        when v_trial_status = 'DONE' then 'completed'
        else 'no_show'
      end,
      'feedbackId', v_feedback_id,
      'classLogId', v_class_log_id
    );
  end if;

  update private.secure_trial_command_receipts
     set response = v_response,
         completed_at = now()
   where tenant_id = v_tenant_id
     and actor_id = v_actor_id
     and command = 'TRIAL_OUTCOME'
     and request_id = v_request_id;

  return v_response;
end;
$function$;

alter function public.update_trial_outcome_secure(jsonb) owner to postgres;
revoke all on function public.update_trial_outcome_secure(jsonb)
  from public, anon, authenticated;
grant execute on function public.update_trial_outcome_secure(jsonb)
  to authenticated;

-- Preserve only legacy experimental links that already contain an immutable,
-- explicit future timestamp.  Day/time-only links remain unusable instead of
-- silently rolling forward to another week.
do $legacy_vendor_requests$
declare
  v_link record;
  v_start_time timestamptz;
  v_status text;
begin
  for v_link in
    select
      link.id as link_id,
      link.tenant_id,
      link.opportunity_id,
      link.professor_id,
      link.created_by_vendor_id as link_vendor_id,
      opportunity.created_by_vendor_id as opportunity_vendor_id,
      opportunity.slots_proposed,
      opportunity.trial_appointment_id,
      link.status as link_status
    from public.enrollment_links as link
    join public.opportunities as opportunity
      on opportunity.id = link.opportunity_id
     and opportunity.tenant_id = link.tenant_id
    where link.purpose = 'TRIAL_CONFIRMATION'
      and link.offer_id is null
      and link.professor_id is not null
      and link.status in ('PENDING', 'USED')
      and not exists (
        select 1
          from private.vendor_trial_teacher_requests as request
         where request.opportunity_id = link.opportunity_id
            or request.enrollment_link_id = link.id
      )
  loop
    begin
      if coalesce(v_link.slots_proposed #>> '{0,start_time}', '') !~
         '(?:[zZ]|[+-][0-9]{2}:[0-9]{2})$' then
        continue;
      end if;
      v_start_time :=
        (v_link.slots_proposed #>> '{0,start_time}')::timestamptz;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        continue;
    end;

    if v_start_time <= now() then
      continue;
    end if;

    v_status := case
      when v_link.trial_appointment_id is not null then 'ACCEPTED'
      when v_link.link_status = 'USED' then 'AWAITING_TEACHER'
      else 'AWAITING_STUDENT'
    end;

    insert into private.vendor_trial_teacher_requests (
      tenant_id, opportunity_id, enrollment_link_id,
      target_teacher_id, requested_by, slot_start, status,
      student_confirmed_at, accepted_at, accepted_appointment_id
    ) values (
      v_link.tenant_id,
      v_link.opportunity_id,
      v_link.link_id,
      v_link.professor_id,
      case
        when v_link.link_vendor_id is not null
         and v_link.opportunity_vendor_id is not null
         and v_link.link_vendor_id <> v_link.opportunity_vendor_id then null
        else coalesce(
          v_link.link_vendor_id, v_link.opportunity_vendor_id
        )
      end,
      v_start_time,
      v_status,
      case when v_link.link_status = 'USED' then now() end,
      case when v_status = 'ACCEPTED' then now() end,
      case when v_status = 'ACCEPTED'
        then v_link.trial_appointment_id
      end
    )
    on conflict do nothing;

    update public.enrollment_links
       set expires_at = v_start_time,
           student_confirmed_at = case
             when status = 'USED'
               then coalesce(student_confirmed_at, used_at, now())
             else student_confirmed_at
           end
     where id = v_link.link_id;
  end loop;
end
$legacy_vendor_requests$;

create or replace function public.confirm_vendor_trial_interest_atomic(
  p_link_token text,
  p_legacy_opportunity_id uuid,
  p_confirm boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_link_id uuid;
  v_lookup_opportunity_id uuid;
  v_link public.enrollment_links%rowtype;
  v_opportunity public.opportunities%rowtype;
  v_request private.vendor_trial_teacher_requests%rowtype;
  v_appointment public.appointments%rowtype;
  v_teacher_name text;
  v_vendor_id uuid;
  v_slot_start timestamptz;
  v_conflict boolean;
  v_base jsonb;
begin
  if p_confirm is null
     or p_legacy_opportunity_id is not null
     or nullif(trim(coalesce(p_link_token, '')), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_lookup');
  end if;
  if p_link_token is not null
     and (
       length(trim(p_link_token)) not between 20 and 512
       or trim(p_link_token) !~ '^[A-Za-z0-9._~-]+$'
     ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_lookup');
  end if;

  select link.id, link.opportunity_id
    into v_link_id, v_lookup_opportunity_id
    from public.enrollment_links as link
   where link.link_token = trim(p_link_token)
     and link.purpose = 'TRIAL_CONFIRMATION'
     and link.offer_id is null
   limit 1;

  if v_link_id is null or v_lookup_opportunity_id is null then
    return jsonb_build_object('ok', false, 'error', 'link_not_found');
  end if;

  -- Match the canonical lock order: opportunity before dependent records.
  select opportunity.*
    into v_opportunity
    from public.opportunities as opportunity
   where opportunity.id = v_lookup_opportunity_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'link_not_found');
  end if;

  select link.*
    into v_link
    from public.enrollment_links as link
   where link.id = v_link_id
     and link.opportunity_id = v_opportunity.id
   for update;

  if not found
     or v_link.tenant_id is distinct from v_opportunity.tenant_id
     or v_link.purpose <> 'TRIAL_CONFIRMATION'
     or v_link.offer_id is not null then
    return jsonb_build_object('ok', false, 'error', 'link_inconsistent');
  end if;

  select request.*
    into v_request
    from private.vendor_trial_teacher_requests as request
   where request.opportunity_id = v_opportunity.id
     and request.enrollment_link_id = v_link.id
     and request.tenant_id = v_opportunity.tenant_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'link_inconsistent');
  end if;
  if not private.tenant_is_operational(v_opportunity.tenant_id) then
    return jsonb_build_object('ok', false, 'error', 'tenant_not_operational');
  end if;
  if v_link.status = 'EXPIRED'
     or v_request.status = 'EXPIRED'
     or v_link.expires_at <= now()
     or v_request.slot_start <= now() + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'error', 'link_expired');
  end if;
  if v_link.status = 'PROCESSING'
     or v_request.status = 'CANCELED' then
    return jsonb_build_object('ok', false, 'error', 'link_unavailable');
  end if;

  select profile.full_name
    into v_teacher_name
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = v_opportunity.tenant_id
     and membership.role = 'TEACHER'
     and membership.status = 'ACTIVE'
   where profile.id = v_request.target_teacher_id
     and v_link.professor_id = profile.id
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
   for share of profile, membership;

  if not found then
    return jsonb_build_object(
      'ok', false, 'error', 'teacher_not_active_for_tenant'
    );
  end if;

  v_vendor_id := coalesce(
    v_request.requested_by,
    v_link.created_by_vendor_id,
    v_opportunity.created_by_vendor_id
  );
  if (
    v_request.requested_by is not null
    and v_request.requested_by <> v_vendor_id
  ) or (
    v_link.created_by_vendor_id is not null
    and v_link.created_by_vendor_id <> v_vendor_id
  ) or (
    v_opportunity.created_by_vendor_id is not null
    and v_opportunity.created_by_vendor_id <> v_vendor_id
  ) or v_vendor_id is null
     or not exists (
       select 1
         from public.tenant_memberships as membership
         join public.profiles as profile
           on profile.id = membership.user_id
        where membership.user_id = v_vendor_id
          and membership.tenant_id = v_opportunity.tenant_id
          and membership.role in ('SALESPERSON', 'COMMERCIAL')
          and membership.status = 'ACTIVE'
          and lower(trim(coalesce(profile.lifecycle_status, 'active'))) = 'active'
     ) then
    return jsonb_build_object('ok', false, 'error', 'vendor_tenant_mismatch');
  end if;

  if v_opportunity.student_id is not null
     and not exists (
       select 1
         from public.tenant_memberships as membership
         join public.profiles as profile
           on profile.id = membership.user_id
        where membership.user_id = v_opportunity.student_id
          and membership.tenant_id = v_opportunity.tenant_id
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
          and lower(trim(coalesce(profile.lifecycle_status, 'active'))) = 'active'
     ) then
    return jsonb_build_object('ok', false, 'error', 'student_tenant_mismatch');
  end if;

  begin
    if coalesce(v_opportunity.slots_proposed #>> '{0,start_time}', '') !~
       '(?:[zZ]|[+-][0-9]{2}:[0-9]{2})$' then
      return jsonb_build_object('ok', false, 'error', 'link_inconsistent');
    end if;
    v_slot_start :=
      (v_opportunity.slots_proposed #>> '{0,start_time}')::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      return jsonb_build_object('ok', false, 'error', 'link_inconsistent');
  end;
  if v_slot_start is distinct from v_request.slot_start then
    return jsonb_build_object('ok', false, 'error', 'link_inconsistent');
  end if;

  v_base := jsonb_build_object(
    'ok', true,
    'tenantId', v_opportunity.tenant_id,
    'opportunityId', v_opportunity.id,
    'teacherId', v_request.target_teacher_id,
    'studentName', coalesce(v_link.student_name, v_opportunity.student_name),
    'teacherName', coalesce(nullif(trim(v_teacher_name), ''), 'Professor(a)'),
    'startsAt', v_request.slot_start,
    'claimGeneration', v_opportunity.claim_generation
  );

  if v_request.status = 'ACCEPTED' then
    select appointment.*
      into v_appointment
      from public.appointments as appointment
     where appointment.id = v_request.accepted_appointment_id
       and appointment.id = v_opportunity.trial_appointment_id
       and appointment.tenant_id = v_opportunity.tenant_id
       and appointment.teacher_id = v_request.target_teacher_id
       and appointment.professor_id = v_request.target_teacher_id
       and appointment.start_time = v_request.slot_start;

    if not found
       or upper(coalesce(v_opportunity.status, '')) <> 'CLAIMED'
       or v_opportunity.winner_teacher_id is distinct from
            v_request.target_teacher_id
       or v_opportunity.professor_id is distinct from
            v_request.target_teacher_id then
      return jsonb_build_object('ok', false, 'error', 'link_inconsistent');
    end if;

    return v_base || jsonb_build_object(
      'confirmed', true,
      'requested', true,
      'idempotent', true,
      'newlyRequested', false,
      'appointmentId', v_appointment.id,
      'state', 'CONFIRMED'
    );
  end if;

  if v_request.status = 'AWAITING_TEACHER' then
    if v_link.status <> 'USED'
       or v_link.student_confirmed_at is null
       or v_opportunity.trial_appointment_id is not null then
      return jsonb_build_object('ok', false, 'error', 'link_inconsistent');
    end if;
    return v_base || jsonb_build_object(
      'confirmed', false,
      'requested', true,
      'conflict', false,
      'idempotent', true,
      'newlyRequested', false,
      'state', 'AWAITING_TEACHER'
    );
  end if;

  if v_request.status <> 'AWAITING_STUDENT'
     or v_link.status <> 'PENDING'
     or upper(coalesce(v_opportunity.status, '')) <> 'OPEN'
     or v_opportunity.winner_teacher_id is not null
     or v_opportunity.professor_id is not null
     or v_opportunity.trial_appointment_id is not null then
    return jsonb_build_object('ok', false, 'error', 'link_inconsistent');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_request.target_teacher_id::text, 0)
  );

  v_conflict := private.secure_trial_schedule_conflict(
    v_opportunity.tenant_id,
    v_request.target_teacher_id,
    v_request.slot_start,
    null,
    v_link.id
  );

  if not p_confirm then
    return v_base || jsonb_build_object(
      'confirmed', false,
      'requested', false,
      'conflict', v_conflict,
      'idempotent', false,
      'newlyRequested', false,
      'state', 'AWAITING_STUDENT'
    );
  end if;
  if v_conflict then
    return v_base || jsonb_build_object(
      'ok', false,
      'error', 'teacher_schedule_conflict',
      'confirmed', false,
      'requested', false,
      'conflict', true,
      'state', 'AWAITING_STUDENT'
    );
  end if;

  update public.enrollment_links
     set status = 'USED',
         used_at = now(),
         student_confirmed_at = now()
   where id = v_link.id
     and status = 'PENDING'
     and purpose = 'TRIAL_CONFIRMATION';
  if not found then
    raise exception 'vendor_trial_interest_lost_lock'
      using errcode = '40001';
  end if;

  update private.vendor_trial_teacher_requests
     set status = 'AWAITING_TEACHER',
         student_confirmed_at = now(),
         updated_at = now()
   where id = v_request.id
     and status = 'AWAITING_STUDENT';
  if not found then
    raise exception 'vendor_trial_request_lost_lock'
      using errcode = '40001';
  end if;

  return v_base || jsonb_build_object(
    'confirmed', false,
    'requested', true,
    'conflict', false,
    'idempotent', false,
    'newlyRequested', true,
    'state', 'AWAITING_TEACHER'
  );
end;
$function$;

alter function public.confirm_vendor_trial_interest_atomic(text, uuid, boolean)
  owner to postgres;
revoke all on function public.confirm_vendor_trial_interest_atomic(
  text, uuid, boolean
) from public, anon, authenticated;
grant execute on function public.confirm_vendor_trial_interest_atomic(
  text, uuid, boolean
) to service_role;

comment on function public.confirm_vendor_trial_interest_atomic(
  text, uuid, boolean
) is
  'Service-only. Public confirmation records interest; only authenticated teacher claim creates an appointment.';

commit;
