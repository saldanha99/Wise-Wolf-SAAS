begin;

-- Operational renewal tracking only.  This migration deliberately does not
-- create contracts, send messages or mutate Asaas.  It turns the existing
-- renewal radar into an auditable queue while the commercial/legal renewal
-- rule and provider tokenization capability are still being resolved.

do $guard$
begin
  if pg_catalog.to_regprocedure('private.active_tenant_id(uuid)') is null
     or pg_catalog.to_regprocedure('private.active_tenant_role(uuid)') is null
     or pg_catalog.to_regprocedure('private.tenant_is_operational(text)') is null
     or pg_catalog.to_regprocedure('public.fim_do_servico(date)') is null
     or pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is null
  then
    raise exception 'renewal_tracking_authority_foundation_is_required';
  end if;
end
$guard$;

create table if not exists public.student_renewal_cases (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  tenant_id text not null
    references public.tenants(id) on delete restrict,
  -- The live reference is nullable so the authorized fixture-account deletion
  -- flow can remove a profile without erasing the operational audit.  The
  -- immutable snapshot remains the cycle identity after that deletion.
  student_id uuid
    references public.profiles(id) on delete set null,
  student_id_snapshot uuid not null,
  service_end_date date not null,
  source_customer_id text,
  source_subscription_id text,
  source_asaas_end_date date not null,
  source_subscription_synced_at timestamptz,
  monthly_fee_snapshot numeric(12,2) not null default 0,
  due_day_snapshot smallint,
  class_frequency_snapshot text,
  status text not null default 'PENDING_CONTACT',
  last_contact_at timestamptz,
  last_channel text,
  next_action_at timestamptz,
  interest_term_months smallint,
  version integer not null default 0,
  created_by uuid not null
    references public.profiles(id) on delete restrict,
  updated_by uuid not null
    references public.profiles(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint student_renewal_cases_cycle_key
    unique (tenant_id, student_id_snapshot, service_end_date),
  constraint student_renewal_cases_tenant_id_id_key
    unique (tenant_id, id),
  constraint student_renewal_cases_status_check check (status in (
    'PENDING_CONTACT',
    'AWAITING_REPLY',
    'FOLLOW_UP_SCHEDULED',
    'INTEREST_RECORDED',
    'FORMALIZATION_PENDING',
    'NOT_CONTINUING_RECORDED'
  )),
  constraint student_renewal_cases_last_channel_check check (
    last_channel is null
    or last_channel in ('WHATSAPP', 'PHONE', 'EMAIL', 'OTHER')
  ),
  constraint student_renewal_cases_interest_term_check check (
    interest_term_months is null or interest_term_months in (6, 12)
  ),
  constraint student_renewal_cases_due_day_check check (
    due_day_snapshot is null or due_day_snapshot between 1 and 31
  ),
  constraint student_renewal_cases_monthly_fee_check check (
    monthly_fee_snapshot >= 0
  ),
  constraint student_renewal_cases_version_check check (version >= 0)
);

alter table public.student_renewal_cases owner to postgres;
alter table public.student_renewal_cases enable row level security;
alter table public.student_renewal_cases force row level security;
revoke all on table public.student_renewal_cases
  from public, anon, authenticated, service_role;
grant select on table public.student_renewal_cases to service_role;

create index if not exists student_renewal_cases_student_idx
  on public.student_renewal_cases (student_id, service_end_date desc);
create index if not exists student_renewal_cases_student_snapshot_idx
  on public.student_renewal_cases (
    student_id_snapshot, service_end_date desc
  );
create index if not exists student_renewal_cases_queue_idx
  on public.student_renewal_cases (
    tenant_id, status, next_action_at, service_end_date
  );
create index if not exists student_renewal_cases_created_by_idx
  on public.student_renewal_cases (created_by);
create index if not exists student_renewal_cases_updated_by_idx
  on public.student_renewal_cases (updated_by);

create table if not exists public.student_renewal_case_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  tenant_id text not null
    references public.tenants(id) on delete restrict,
  renewal_case_id uuid not null,
  student_id uuid
    references public.profiles(id) on delete set null,
  student_id_snapshot uuid not null,
  actor_id uuid not null
    references public.profiles(id) on delete restrict,
  actor_name_snapshot text not null,
  request_id uuid not null,
  action text not null,
  from_status text,
  to_status text not null,
  channel text,
  contact_at timestamptz,
  next_action_at timestamptz,
  interest_term_months smallint,
  request_envelope jsonb not null,
  request_fingerprint text not null,
  result_version integer not null,
  result_last_contact_at timestamptz,
  result_last_channel text,
  result_next_action_at timestamptz,
  result_interest_term_months smallint,
  created_at timestamptz not null default pg_catalog.now(),
  constraint student_renewal_case_events_case_fkey
    foreign key (tenant_id, renewal_case_id)
    references public.student_renewal_cases(tenant_id, id)
    on delete restrict,
  constraint student_renewal_case_events_tenant_id_id_case_key
    unique (tenant_id, id, renewal_case_id),
  constraint student_renewal_case_events_request_key
    unique (tenant_id, request_id),
  constraint student_renewal_case_events_action_check check (action in (
    'CONTACTED',
    'SCHEDULE_FOLLOW_UP',
    'RECORD_INTEREST',
    'AWAIT_FORMALIZATION',
    'RECORD_NOT_CONTINUING',
    'REOPEN'
  )),
  constraint student_renewal_case_events_from_status_check check (
    from_status is null or from_status in (
      'PENDING_CONTACT',
      'AWAITING_REPLY',
      'FOLLOW_UP_SCHEDULED',
      'INTEREST_RECORDED',
      'FORMALIZATION_PENDING',
      'NOT_CONTINUING_RECORDED'
    )
  ),
  constraint student_renewal_case_events_to_status_check check (to_status in (
    'PENDING_CONTACT',
    'AWAITING_REPLY',
    'FOLLOW_UP_SCHEDULED',
    'INTEREST_RECORDED',
    'FORMALIZATION_PENDING',
    'NOT_CONTINUING_RECORDED'
  )),
  constraint student_renewal_case_events_channel_check check (
    channel is null or channel in ('WHATSAPP', 'PHONE', 'EMAIL', 'OTHER')
  ),
  constraint student_renewal_case_events_interest_term_check check (
    interest_term_months is null or interest_term_months in (6, 12)
  ),
  constraint student_renewal_case_events_request_envelope_check check (
    pg_catalog.jsonb_typeof(request_envelope) = 'object'
  ),
  constraint student_renewal_case_events_request_fingerprint_check check (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint student_renewal_case_events_request_fingerprint_matches check (
    request_fingerprint = pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(request_envelope::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ),
  constraint student_renewal_case_events_result_version_check check (
    result_version > 0
  ),
  constraint student_renewal_case_events_result_channel_check check (
    result_last_channel is null
    or result_last_channel in ('WHATSAPP', 'PHONE', 'EMAIL', 'OTHER')
  ),
  constraint student_renewal_case_events_result_interest_check check (
    result_interest_term_months is null
    or result_interest_term_months in (6, 12)
  ),
  constraint student_renewal_case_events_actor_name_check check (
    pg_catalog.char_length(pg_catalog.btrim(actor_name_snapshot))
      between 1 and 200
  )
);

alter table public.student_renewal_case_events owner to postgres;
alter table public.student_renewal_case_events enable row level security;
alter table public.student_renewal_case_events force row level security;
revoke all on table public.student_renewal_case_events
  from public, anon, authenticated, service_role;
grant select on table public.student_renewal_case_events to service_role;

create index if not exists student_renewal_case_events_case_idx
  on public.student_renewal_case_events (
    renewal_case_id, result_version desc, created_at desc
  );
create index if not exists student_renewal_case_events_student_idx
  on public.student_renewal_case_events (student_id, created_at desc);
create index if not exists student_renewal_case_events_student_snapshot_idx
  on public.student_renewal_case_events (
    student_id_snapshot, created_at desc
  );
create index if not exists student_renewal_case_events_actor_idx
  on public.student_renewal_case_events (actor_id);

-- Notes are deliberately kept outside the immutable ledger.  They contain
-- operator-authored personal data and therefore cascade away when the
-- authorized fixture-account deletion removes the student.  The immutable
-- event retains only a SHA-256 payload fingerprint in request_envelope.
create table if not exists public.student_renewal_case_event_notes (
  event_id uuid primary key,
  tenant_id text not null
    references public.tenants(id) on delete restrict,
  renewal_case_id uuid not null,
  student_id uuid not null
    references public.profiles(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint student_renewal_case_event_notes_event_fkey
    foreign key (tenant_id, event_id, renewal_case_id)
    references public.student_renewal_case_events(
      tenant_id, id, renewal_case_id
    ) on delete cascade,
  constraint student_renewal_case_event_notes_note_check check (
    pg_catalog.char_length(note) between 1 and 500
  )
);

alter table public.student_renewal_case_event_notes owner to postgres;
alter table public.student_renewal_case_event_notes enable row level security;
alter table public.student_renewal_case_event_notes force row level security;
revoke all on table public.student_renewal_case_event_notes
  from public, anon, authenticated, service_role;
grant select on table public.student_renewal_case_event_notes to service_role;

create index if not exists student_renewal_case_event_notes_case_idx
  on public.student_renewal_case_event_notes (
    renewal_case_id, created_at desc
  );
create index if not exists student_renewal_case_event_notes_student_idx
  on public.student_renewal_case_event_notes (student_id);

create or replace function private.reject_student_renewal_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  -- The only permitted rewrite is PostgreSQL's nested ON DELETE SET NULL
  -- action for the erasable live student reference.  Every ledger/snapshot
  -- field must remain byte-for-byte equivalent, and a direct UPDATE still
  -- enters at trigger depth 1 and is rejected.
  if tg_op = 'UPDATE'
     and pg_catalog.pg_trigger_depth() > 1
     and old.student_id is not null
     and new.student_id is null
     and (pg_catalog.to_jsonb(new) - 'student_id')
           is not distinct from
         (pg_catalog.to_jsonb(old) - 'student_id')
  then
    return new;
  end if;

  raise exception using
    errcode = '55000',
    message = 'student_renewal_events_are_immutable';
end;
$function$;

alter function private.reject_student_renewal_event_mutation() owner to postgres;
revoke all on function private.reject_student_renewal_event_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists reject_student_renewal_event_mutation
  on public.student_renewal_case_events;
create trigger reject_student_renewal_event_mutation
before update or delete on public.student_renewal_case_events
for each row execute function private.reject_student_renewal_event_mutation();

create or replace function public.list_student_renewal_cases(
  p_tenant text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  actor_role text := private.active_tenant_role(actor_id);
  actor_tenant text := private.active_tenant_id(actor_id);
  requested_tenant text := nullif(
    pg_catalog.btrim(coalesce(p_tenant, '')),
    ''
  );
  target_tenant text := actor_tenant;
  items jsonb;
begin
  if actor_id is null
     or actor_tenant is null
     or actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR')
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'forbidden'
    );
  end if;

  if requested_tenant is not null
     and requested_tenant is distinct from target_tenant
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'tenant_mismatch'
    );
  end if;

  if not private.tenant_is_operational(target_tenant) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'tenant_not_operational'
    );
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(item)
      order by item.service_end_date, item.student_name, item.student_id
    ),
    '[]'::jsonb
  )
    into items
    from (
      select
        renewal.id,
        renewal.student_id_snapshot as student_id,
        coalesce(
          nullif(pg_catalog.btrim(student.full_name), ''),
          'Aluno removido'
        ) as student_name,
        renewal.service_end_date,
        renewal.monthly_fee_snapshot,
        renewal.status,
        renewal.last_contact_at,
        renewal.last_channel,
        renewal.next_action_at,
        renewal.interest_term_months,
        renewal.version,
        renewal.source_subscription_synced_at,
        renewal.updated_at,
        actor.full_name as updated_by_name,
        (
          student.id is not null
          and student.tenant_id = renewal.tenant_id
          and pg_catalog.lower(pg_catalog.btrim(coalesce(
            student.lifecycle_status,
            ''
          ))) = 'active'
          and private.active_tenant_id(student.id)
                is not distinct from renewal.tenant_id
          and private.active_tenant_role(student.id)
                is not distinct from 'STUDENT'
          and public.fim_do_servico(student.asaas_subscription_end_date)
                is not distinct from renewal.service_end_date
          and exists (
            select 1
              from public.tenant_memberships as membership
             where membership.user_id = student.id
               and membership.tenant_id = renewal.tenant_id
               and membership.role = 'STUDENT'
               and membership.status = 'ACTIVE'
          )
        ) as cycle_current,
        (
          select pg_catalog.count(*)::integer
            from public.student_renewal_case_events as event
           where event.tenant_id = renewal.tenant_id
             and event.renewal_case_id = renewal.id
        ) as event_count,
        (
          select event.created_at
            from public.student_renewal_case_events as event
           where event.tenant_id = renewal.tenant_id
             and event.renewal_case_id = renewal.id
           order by event.result_version desc, event.created_at desc, event.id desc
           limit 1
        ) as latest_action_at,
        (
          select event_note.note
            from public.student_renewal_case_events as event
            join public.student_renewal_case_event_notes as event_note
              on event_note.tenant_id = event.tenant_id
             and event_note.event_id = event.id
             and event_note.renewal_case_id = event.renewal_case_id
           where event.tenant_id = renewal.tenant_id
             and event.renewal_case_id = renewal.id
           order by event.result_version desc, event.created_at desc, event.id desc
           limit 1
        ) as latest_note
      from public.student_renewal_cases as renewal
      left join public.profiles as actor on actor.id = renewal.updated_by
      left join public.profiles as student on student.id = renewal.student_id
      where renewal.tenant_id = target_tenant
    ) as item;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'items', items
  );
end;
$function$;

alter function public.list_student_renewal_cases(text) owner to postgres;
revoke all on function public.list_student_renewal_cases(text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_student_renewal_cases(text)
  to authenticated, service_role;

create or replace function public.record_student_renewal_action(
  p_student_id uuid,
  p_service_end_date date,
  p_action text,
  p_expected_version integer,
  p_request_id uuid,
  p_channel text default null,
  p_contact_at timestamptz default null,
  p_next_action_at timestamptz default null,
  p_interest_term_months integer default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  actor_tenant text;
  actor_profile public.profiles%rowtype;
  actor_membership public.tenant_memberships%rowtype;
  student public.profiles%rowtype;
  student_membership public.tenant_memberships%rowtype;
  current_case public.student_renewal_cases%rowtype;
  replay_event public.student_renewal_case_events%rowtype;
  normalized_action text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_action, ''))
  );
  normalized_channel text := nullif(
    pg_catalog.upper(pg_catalog.btrim(coalesce(p_channel, ''))),
    ''
  );
  normalized_note text := nullif(
    pg_catalog.btrim(coalesce(p_note, '')),
    ''
  );
  normalized_note_hash text;
  request_envelope jsonb;
  request_fingerprint text;
  source_service_end date;
  case_found boolean := false;
  current_status text;
  current_version integer;
  current_last_contact timestamptz;
  current_channel text;
  current_follow_up timestamptz;
  current_interest smallint;
  previous_status text;
  next_status text;
  next_last_contact timestamptz;
  next_channel text;
  next_follow_up timestamptz;
  next_interest smallint;
  effective_contact timestamptz;
  new_event_id uuid := pg_catalog.gen_random_uuid();
  actor_name_snapshot text;
begin
  if actor_id is null
     or p_student_id is null
     or p_service_end_date is null
     or p_request_id is null
     or p_expected_version is null
     or p_expected_version < 0
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'invalid_request'
    );
  end if;

  if normalized_action not in (
    'CONTACTED',
    'SCHEDULE_FOLLOW_UP',
    'RECORD_INTEREST',
    'AWAIT_FORMALIZATION',
    'RECORD_NOT_CONTINUING',
    'REOPEN'
  ) or (normalized_note is not null and pg_catalog.char_length(normalized_note) > 500)
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'invalid_action_payload'
    );
  end if;

  -- Reject irrelevant fields instead of silently changing the canonical
  -- request.  This makes a request_id identify one exact semantic action.
  if (normalized_action = 'CONTACTED' and (
        normalized_channel is null
        or normalized_channel not in ('WHATSAPP', 'PHONE', 'EMAIL', 'OTHER')
        or p_interest_term_months is not null
      ))
     or (normalized_action = 'SCHEDULE_FOLLOW_UP' and (
        normalized_channel is not null
        or p_contact_at is not null
        or p_next_action_at is null
        or p_interest_term_months is not null
      ))
     or (normalized_action = 'RECORD_INTEREST' and (
        normalized_channel is not null
        or p_contact_at is not null
        or p_next_action_at is not null
        or p_interest_term_months is null
        or p_interest_term_months not in (6, 12)
      ))
     or (normalized_action = 'AWAIT_FORMALIZATION' and (
        normalized_channel is not null
        or p_contact_at is not null
        or p_interest_term_months is not null
      ))
     or (normalized_action in ('RECORD_NOT_CONTINUING', 'REOPEN') and (
        normalized_channel is not null
        or p_contact_at is not null
        or p_next_action_at is not null
        or p_interest_term_months is not null
      ))
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'invalid_action_payload'
    );
  end if;

  actor_tenant := private.active_tenant_id(actor_id);
  actor_role := private.active_tenant_role(actor_id);
  if actor_tenant is null
     or actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'forbidden'
    );
  end if;

  if not private.tenant_is_operational(actor_tenant) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'tenant_not_operational'
    );
  end if;

  -- Keep the authority used by this command stable until commit.  The helper
  -- values are revalidated after locking the canonical profile/membership.
  select profile.*
    into actor_profile
    from public.profiles as profile
   where profile.id = actor_id
     and pg_catalog.lower(pg_catalog.btrim(coalesce(
       profile.lifecycle_status,
       ''
     ))) = 'active'
   for no key update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'forbidden'
    );
  end if;

  select membership.*
    into actor_membership
    from public.tenant_memberships as membership
   where membership.user_id = actor_id
     and membership.tenant_id = actor_tenant
     and membership.status = 'ACTIVE'
   for no key update;
  if not found
     or (
       actor_role <> 'SUPER_ADMIN'
       and actor_membership.role is distinct from actor_role
     )
     or private.active_tenant_id(actor_id) is distinct from actor_tenant
     or private.active_tenant_role(actor_id) is distinct from actor_role
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'forbidden'
    );
  end if;

  actor_name_snapshot := pg_catalog.left(
    coalesce(
      nullif(pg_catalog.btrim(actor_profile.full_name), ''),
      'Operador'
    ),
    200
  );
  normalized_note_hash := case
    when normalized_note is null then null
    else pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(normalized_note, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  end;
  request_envelope := pg_catalog.jsonb_build_object(
    'envelope_version', 1,
    'tenant_id', actor_tenant,
    'actor_id', actor_id,
    'student_id', p_student_id,
    'service_end_date', p_service_end_date,
    'action', normalized_action,
    'expected_version', p_expected_version,
    'channel', normalized_channel,
    'contact_at', case
      when p_contact_at is null then null
      else pg_catalog.to_char(
        p_contact_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    end,
    'next_action_at', case
      when p_next_action_at is null then null
      else pg_catalog.to_char(
        p_next_action_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    end,
    'interest_term_months', p_interest_term_months,
    'note_sha256', normalized_note_hash
  );
  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(request_envelope::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- The request lock is tenant-wide for this idempotency key.  It is acquired
  -- before the cycle lock so even accidental reuse across two students is
  -- serialized and resolved as a deterministic conflict.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-renewal-request:' || actor_tenant || ':' ||
      p_request_id::text,
      0
    )
  );

  select event.*
    into replay_event
    from public.student_renewal_case_events as event
   where event.tenant_id = actor_tenant
     and event.request_id = p_request_id;

  if found then
    if replay_event.request_envelope is distinct from request_envelope
       or replay_event.request_fingerprint is distinct from request_fingerprint
    then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'request_id_conflict'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'replayed', true,
      'case_id', replay_event.renewal_case_id,
      'status', replay_event.to_status,
      'version', replay_event.result_version,
      'last_contact_at', replay_event.result_last_contact_at,
      'last_channel', replay_event.result_last_channel,
      'next_action_at', replay_event.result_next_action_at,
      'interest_term_months', replay_event.result_interest_term_months,
      'updated_by_name', replay_event.actor_name_snapshot
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-renewal:' || actor_tenant || ':' ||
      p_student_id::text || ':' || p_service_end_date::text,
      0
    )
  );

  -- Read the provider mirror only after taking the application lock, and keep
  -- the profile row locked through the ledger write.  A sync/correction cannot
  -- change subscription/end-date between validation and the event insert.
  select profile.*
   into student
    from public.profiles as profile
   where profile.id = p_student_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'student_not_found'
    );
  end if;

  if student.tenant_id is distinct from actor_tenant then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'tenant_mismatch'
    );
  end if;

  select membership.*
    into student_membership
    from public.tenant_memberships as membership
   where membership.user_id = student.id
     and membership.tenant_id = actor_tenant
     and membership.role = 'STUDENT'
     and membership.status = 'ACTIVE'
   for no key update;
  if not found
     or pg_catalog.lower(pg_catalog.btrim(coalesce(
       student.lifecycle_status,
       ''
     ))) <> 'active'
     or private.active_tenant_id(student.id) is distinct from actor_tenant
     or private.active_tenant_role(student.id) is distinct from 'STUDENT'
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'student_inactive'
    );
  end if;

  source_service_end := public.fim_do_servico(
    student.asaas_subscription_end_date
  );
  if source_service_end is null
     or source_service_end is distinct from p_service_end_date
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'renewal_cycle_changed',
      'current_service_end_date', source_service_end
    );
  end if;

  select renewal.*
    into current_case
    from public.student_renewal_cases as renewal
   where renewal.tenant_id = actor_tenant
     and renewal.student_id_snapshot = student.id
     and renewal.service_end_date = p_service_end_date
   for update;
  case_found := found;

  if case_found then
    -- Provider/customer fields are immutable opening snapshots, not the cycle
    -- identity.  A binding correction may continue this operational cycle as
    -- long as fim_do_servico still resolves to p_service_end_date.
    current_status := current_case.status;
    current_version := current_case.version;
    current_last_contact := current_case.last_contact_at;
    current_channel := current_case.last_channel;
    current_follow_up := current_case.next_action_at;
    current_interest := current_case.interest_term_months;
  else
    current_status := 'PENDING_CONTACT';
    current_version := 0;
    current_last_contact := null;
    current_channel := null;
    current_follow_up := null;
    current_interest := null;
  end if;

  if current_version is distinct from p_expected_version then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'version_conflict',
      'current_version', current_version
    );
  end if;

  next_status := current_status;
  next_last_contact := current_last_contact;
  next_channel := current_channel;
  next_follow_up := current_follow_up;
  next_interest := current_interest;

  if normalized_action = 'CONTACTED' then
    if current_status = 'NOT_CONTINUING_RECORDED'
    then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_transition'
      );
    end if;
    effective_contact := coalesce(p_contact_at, pg_catalog.now());
    if effective_contact > pg_catalog.now() + interval '5 minutes'
       or effective_contact < pg_catalog.now() - interval '365 days'
       or (
         p_next_action_at is not null
         and (
           p_next_action_at <= effective_contact
           or p_next_action_at > pg_catalog.now() + interval '365 days'
         )
       )
    then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_contact_timing'
      );
    end if;
    next_last_contact := effective_contact;
    next_channel := normalized_channel;
    next_follow_up := p_next_action_at;
    if current_status not in (
      'INTEREST_RECORDED', 'FORMALIZATION_PENDING'
    ) then
      next_status := case
        when p_next_action_at is null then 'AWAITING_REPLY'
        else 'FOLLOW_UP_SCHEDULED'
      end;
    end if;
  elsif normalized_action = 'SCHEDULE_FOLLOW_UP' then
    if current_status not in (
         'AWAITING_REPLY',
         'FOLLOW_UP_SCHEDULED',
         'INTEREST_RECORDED',
         'FORMALIZATION_PENDING'
       )
       or p_next_action_at is null
       or p_next_action_at <= pg_catalog.now()
       or p_next_action_at > pg_catalog.now() + interval '365 days'
    then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_transition'
      );
    end if;
    next_follow_up := p_next_action_at;
    if current_status in ('AWAITING_REPLY', 'FOLLOW_UP_SCHEDULED') then
      next_status := 'FOLLOW_UP_SCHEDULED';
    end if;
  elsif normalized_action = 'RECORD_INTEREST' then
    if current_status not in (
         'AWAITING_REPLY', 'FOLLOW_UP_SCHEDULED', 'INTEREST_RECORDED'
       )
    then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_transition'
      );
    end if;
    next_status := 'INTEREST_RECORDED';
    next_interest := p_interest_term_months::smallint;
    next_follow_up := null;
  elsif normalized_action = 'AWAIT_FORMALIZATION' then
    if current_status <> 'INTEREST_RECORDED'
       or current_interest not in (6, 12)
       or (
         p_next_action_at is not null
         and (
           p_next_action_at <= pg_catalog.now()
           or p_next_action_at > pg_catalog.now() + interval '365 days'
         )
       )
    then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_transition'
      );
    end if;
    next_status := 'FORMALIZATION_PENDING';
    next_follow_up := p_next_action_at;
  elsif normalized_action = 'RECORD_NOT_CONTINUING' then
    if current_status = 'NOT_CONTINUING_RECORDED' then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_transition'
      );
    end if;
    next_status := 'NOT_CONTINUING_RECORDED';
    next_follow_up := null;
    next_interest := null;
  elsif normalized_action = 'REOPEN' then
    if current_status not in (
      'NOT_CONTINUING_RECORDED', 'FORMALIZATION_PENDING'
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_transition'
      );
    end if;
    next_status := 'PENDING_CONTACT';
    next_follow_up := null;
    next_interest := null;
  end if;

  previous_status := current_status;
  if not case_found then
    insert into public.student_renewal_cases (
      tenant_id,
      student_id,
      student_id_snapshot,
      service_end_date,
      source_customer_id,
      source_subscription_id,
      source_asaas_end_date,
      source_subscription_synced_at,
      monthly_fee_snapshot,
      due_day_snapshot,
      class_frequency_snapshot,
      status,
      last_contact_at,
      last_channel,
      next_action_at,
      interest_term_months,
      version,
      created_by,
      updated_by
    ) values (
      actor_tenant,
      student.id,
      student.id,
      p_service_end_date,
      nullif(pg_catalog.btrim(coalesce(student.asaas_customer_id, '')), ''),
      nullif(pg_catalog.btrim(coalesce(student.subscription_id, '')), ''),
      student.asaas_subscription_end_date,
      student.asaas_subscription_synced_at,
      greatest(coalesce(student.monthly_fee, 0::numeric), 0::numeric),
      student.due_day,
      nullif(pg_catalog.btrim(coalesce(student.class_frequency, '')), ''),
      next_status,
      next_last_contact,
      next_channel,
      next_follow_up,
      next_interest,
      1,
      actor_id,
      actor_id
    )
    returning * into current_case;
  else
    update public.student_renewal_cases as renewal
       set status = next_status,
           last_contact_at = next_last_contact,
           last_channel = next_channel,
           next_action_at = next_follow_up,
           interest_term_months = next_interest,
           version = current_version + 1,
           updated_by = actor_id,
           updated_at = pg_catalog.now()
     where renewal.id = current_case.id
       and renewal.tenant_id = actor_tenant
       and renewal.version = current_version
     returning renewal.* into current_case;
    if not found then
      raise exception 'renewal_case_compare_and_swap_lost'
        using errcode = '40001';
    end if;
  end if;

  insert into public.student_renewal_case_events (
    id,
    tenant_id,
    renewal_case_id,
    student_id,
    student_id_snapshot,
    actor_id,
    actor_name_snapshot,
    request_id,
    action,
    from_status,
    to_status,
    channel,
    contact_at,
    next_action_at,
    interest_term_months,
    request_envelope,
    request_fingerprint,
    result_version,
    result_last_contact_at,
    result_last_channel,
    result_next_action_at,
    result_interest_term_months
  ) values (
    new_event_id,
    actor_tenant,
    current_case.id,
    student.id,
    student.id,
    actor_id,
    actor_name_snapshot,
    p_request_id,
    normalized_action,
    previous_status,
    current_case.status,
    normalized_channel,
    effective_contact,
    next_follow_up,
    next_interest,
    request_envelope,
    request_fingerprint,
    current_case.version,
    current_case.last_contact_at,
    current_case.last_channel,
    current_case.next_action_at,
    current_case.interest_term_months
  );

  if normalized_note is not null then
    insert into public.student_renewal_case_event_notes (
      event_id,
      tenant_id,
      renewal_case_id,
      student_id,
      note
    ) values (
      new_event_id,
      actor_tenant,
      current_case.id,
      student.id,
      normalized_note
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'replayed', false,
    'case_id', current_case.id,
    'status', current_case.status,
    'version', current_case.version,
    'last_contact_at', current_case.last_contact_at,
    'last_channel', current_case.last_channel,
    'next_action_at', current_case.next_action_at,
    'interest_term_months', current_case.interest_term_months,
    'updated_by_name', actor_name_snapshot
  );
end;
$function$;

alter function public.record_student_renewal_action(
  uuid, date, text, integer, uuid, text, timestamptz, timestamptz, integer, text
) owner to postgres;
revoke all on function public.record_student_renewal_action(
  uuid, date, text, integer, uuid, text, timestamptz, timestamptz, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_student_renewal_action(
  uuid, date, text, integer, uuid, text, timestamptz, timestamptz, integer, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
