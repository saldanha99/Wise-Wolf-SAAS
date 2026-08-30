-- Attendance audit hardening
--
-- Goals:
--   * the verification token is only accepted as an input to the public RPCs;
--     it is never readable through the Data API;
--   * lesson logs are command-only for browser clients;
--   * disagreements about student attendance never hold teacher payment;
--   * only a student report that the teacher did not attend can open a hard
--     payment conflict;
--   * contiguous 30-minute slots are one student-facing audit session;
--   * WhatsApp delivery uses an atomic claim/finalize protocol. An expired
--     in-flight lease is terminally AMBIGUOUS (at-most-once delivery), rather
--     than being retried and potentially duplicated.

create schema if not exists private;

alter table public.attendance_confirmations
  add column if not exists token_expires_at timestamptz,
  add column if not exists response_editable_until timestamptz,
  add column if not exists response_updated_at timestamptz,
  add column if not exists session_key text,
  add column if not exists canonical_confirmation_id uuid,
  add column if not exists session_end_at timestamptz,
  add column if not exists delivery_key text,
  add column if not exists delivery_status text not null default 'PENDING',
  add column if not exists delivery_claim_token uuid,
  add column if not exists delivery_claimed_at timestamptz,
  add column if not exists delivery_claim_expires_at timestamptz,
  add column if not exists provider_message_id text,
  add column if not exists last_delivery_error text,
  add column if not exists resolution_verdict text;

update public.attendance_confirmations
   set token_expires_at = coalesce(created_at, now()) + interval '7 days'
 where token_expires_at is null;

update public.attendance_confirmations
   set response_updated_at = coalesce(response_updated_at, responded_at),
       response_editable_until = coalesce(
         response_editable_until,
         responded_at + interval '30 minutes'
       )
 where responded_at is not null;

update public.attendance_confirmations
   set delivery_status = case
     when sent_at is not null then 'SENT'
     -- The legacy sender incremented send_attempts before the provider outcome
     -- was durably known. Retrying any such row could duplicate a message that
     -- WhatsApp already accepted, including rows at the former retry limit.
     when send_attempts > 0 then 'AMBIGUOUS'
     when status = 'CANCELLED' then 'CANCELLED'
     else 'PENDING'
   end,
       last_delivery_error = case
         when sent_at is null and send_attempts > 0
           then 'legacy_delivery_attempt_outcome_unknown'
         else last_delivery_error
       end;

alter table public.attendance_confirmations
  alter column token_expires_at set default (now() + interval '7 days'),
  alter column token_expires_at set not null;

do $constraints$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.attendance_confirmations'::regclass
       and conname = 'attendance_confirmations_canonical_fkey'
  ) then
    alter table public.attendance_confirmations
      add constraint attendance_confirmations_canonical_fkey
      foreign key (canonical_confirmation_id)
      references public.attendance_confirmations(id)
      on delete set null;
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.attendance_confirmations'::regclass
       and conname = 'attendance_confirmations_student_response_check'
  ) then
    alter table public.attendance_confirmations
      add constraint attendance_confirmations_student_response_check
      check (
        student_response is null
        or student_response in (
          'STUDENT_PRESENT',
          'TEACHER_NO_SHOW',
          'STUDENT_SELF_ABSENT',
          'CANCELLED_RESCHEDULED'
        )
      );
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.attendance_confirmations'::regclass
       and conname = 'attendance_confirmations_delivery_status_check'
  ) then
    alter table public.attendance_confirmations
      add constraint attendance_confirmations_delivery_status_check
      check (
        delivery_status in (
          'PENDING', 'PROCESSING', 'SENT', 'GROUPED',
          'FAILED', 'AMBIGUOUS', 'CANCELLED'
        )
      );
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.attendance_confirmations'::regclass
       and conname = 'attendance_confirmations_resolution_verdict_check'
  ) then
    alter table public.attendance_confirmations
      add constraint attendance_confirmations_resolution_verdict_check
      check (
        resolution_verdict is null
        or resolution_verdict in (
          'TEACHER_PRESENT', 'TEACHER_ABSENT', 'PAY', 'DO_NOT_PAY'
        )
      );
  end if;
end;
$constraints$;

alter table public.reschedules
  add column if not exists attendance_session_key text;

create unique index if not exists uq_reschedules_teacher_attendance_session
  on public.reschedules (attendance_session_key)
  where attendance_session_key is not null
    and fault_type = 'TEACHER';

create table if not exists private.attendance_response_audit (
  id bigint generated always as identity primary key,
  confirmation_id uuid not null
    references public.attendance_confirmations(id) on delete cascade,
  session_key text,
  previous_response text,
  new_response text not null,
  actor_id uuid,
  actor_kind text not null,
  changed_at timestamptz not null default now(),
  constraint attendance_response_audit_actor_kind_check
    check (actor_kind in ('PUBLIC_TOKEN', 'AUTHENTICATED_STUDENT'))
);

alter table private.attendance_response_audit enable row level security;
alter table private.attendance_response_audit force row level security;
drop policy if exists attendance_response_audit_internal_insert
  on private.attendance_response_audit;
create policy attendance_response_audit_internal_insert
  on private.attendance_response_audit
  for insert
  to postgres
  with check (true);
revoke all on table private.attendance_response_audit
  from public, anon, authenticated, service_role;
revoke all on sequence private.attendance_response_audit_id_seq
  from public, anon, authenticated, service_role;
grant usage on schema private to postgres;
grant insert on table private.attendance_response_audit to postgres;
grant usage, select on sequence private.attendance_response_audit_id_seq
  to postgres;

create index if not exists attendance_response_audit_confirmation_changed_idx
  on private.attendance_response_audit (confirmation_id, changed_at desc);

comment on table private.attendance_response_audit is
  'Append-only audit of a student attendance answer and any correction made in the 30-minute correction window. Tokens are never stored here.';

-- Rebuilds logical sessions without losing the individual financial slots.
-- Equal or contiguous (<=30 minute) slots for the same school/student/teacher
-- and date share one canonical confirmation and therefore one message/link.
create or replace function private.refresh_attendance_confirmation_sessions(
  p_min_date date,
  p_max_date date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  if p_min_date is null or p_max_date is null or p_min_date > p_max_date then
    return 0;
  end if;

  -- Clear first so that a canonical row can change without a transient unique
  -- collision on delivery_key in the second UPDATE.
  update public.attendance_confirmations
     set delivery_key = null
   where class_date between p_min_date and p_max_date
     and delivery_key is not null;

  with base as (
    select
      ac.id,
      ac.tenant_id,
      ac.teacher_id,
      ac.student_id,
      ac.class_date,
      ac.sent_at,
      ac.responded_at,
      ac.created_at,
      ac.delivery_status,
      ac.last_delivery_error,
      case
        when pg_catalog.btrim(coalesce(ac.class_time, ''))
             ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
        then pg_catalog.left(pg_catalog.btrim(ac.class_time), 5)::time
      end as slot_time,
      coalesce(
        ac.student_id::text,
        nullif(pg_catalog.regexp_replace(coalesce(ac.student_phone, ''), '\\D', '', 'g'), ''),
        ac.id::text
      ) as participant_key
    from public.attendance_confirmations ac
    where ac.class_date between p_min_date and p_max_date
  ), lagged as (
    select
      b.*,
      pg_catalog.lag(b.slot_time) over (
        partition by b.tenant_id, b.teacher_id, b.participant_key, b.class_date
        order by b.slot_time nulls last, b.created_at, b.id
      ) as previous_slot_time
    from base b
  ), marked as (
    select
      l.*,
      case
        when l.slot_time is null then 1
        when l.previous_slot_time is null then 1
        when l.slot_time - l.previous_slot_time > interval '30 minutes' then 1
        else 0
      end as starts_group
    from lagged l
  ), grouped as (
    select
      m.*,
      sum(m.starts_group) over (
        partition by m.tenant_id, m.teacher_id, m.participant_key, m.class_date
        order by m.slot_time nulls last, m.created_at, m.id
        rows between unbounded preceding and current row
      ) as group_number
    from marked m
  ), labeled as (
    select
      g.*,
      pg_catalog.min(g.slot_time) over (
        partition by g.tenant_id, g.teacher_id, g.participant_key,
                     g.class_date, g.group_number
      ) as first_slot_time,
      pg_catalog.max(g.slot_time) over (
        partition by g.tenant_id, g.teacher_id, g.participant_key,
                     g.class_date, g.group_number
      ) as last_slot_time,
      pg_catalog.bool_or(g.delivery_status = 'AMBIGUOUS') over (
        partition by g.tenant_id, g.teacher_id, g.participant_key,
                     g.class_date, g.group_number
      ) as session_has_ambiguous_delivery,
      pg_catalog.first_value(g.id) over (
        partition by g.tenant_id, g.teacher_id, g.participant_key,
                     g.class_date, g.group_number
        order by
          (g.sent_at is not null) desc,
          (g.responded_at is not null) desc,
          (g.delivery_status = 'PROCESSING') desc,
          g.slot_time nulls last,
          g.created_at,
          g.id
      ) as canonical_id
    from grouped g
  ), resolved as (
    select
      l.id,
      l.canonical_id,
      l.session_has_ambiguous_delivery,
      case when l.last_slot_time is not null then
        (
          (l.class_date::text || ' ' || l.last_slot_time::text)::timestamp
          at time zone 'America/Sao_Paulo'
        ) + interval '30 minutes'
      end as resolved_session_end_at,
      'attendance:' || pg_catalog.md5(
        coalesce(l.tenant_id, '-') || '|' ||
        coalesce(l.teacher_id::text, '-') || '|' ||
        l.participant_key || '|' ||
        l.class_date::text || '|' ||
        coalesce(l.first_slot_time::text, l.canonical_id::text)
      ) as resolved_session_key
    from labeled l
  )
  update public.attendance_confirmations ac
     set session_key = r.resolved_session_key,
         canonical_confirmation_id = r.canonical_id,
         session_end_at = r.resolved_session_end_at,
         delivery_key = case
           when ac.id = r.canonical_id
           then 'attendance-delivery:' || r.resolved_session_key
         end,
         delivery_status = case
           when ac.sent_at is not null then 'SENT'
           -- One uncertain legacy member makes the whole logical session
           -- terminal: selecting a different canonical slot must not resend it.
           when r.session_has_ambiguous_delivery then 'AMBIGUOUS'
           when ac.id <> r.canonical_id then 'GROUPED'
           when ac.delivery_status in ('PROCESSING', 'AMBIGUOUS', 'FAILED', 'CANCELLED')
             then ac.delivery_status
           when ac.send_attempts >= 8 then 'FAILED'
           else 'PENDING'
         end,
         last_delivery_error = case
           when ac.sent_at is null
                and r.session_has_ambiguous_delivery
             then coalesce(
               ac.last_delivery_error,
               'session_delivery_attempt_outcome_unknown'
             )
           else ac.last_delivery_error
         end
    from resolved r
   where ac.id = r.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

alter function private.refresh_attendance_confirmation_sessions(date, date)
  owner to postgres;
revoke all on function private.refresh_attendance_confirmation_sessions(date, date)
  from public, anon, authenticated, service_role;

-- Initial canonicalization is data-only; it never claims or sends a message.
select private.refresh_attendance_confirmation_sessions(
  coalesce((select min(class_date) from public.attendance_confirmations), current_date),
  coalesce((select max(class_date) from public.attendance_confirmations), current_date)
);

-- If only one member of a newly grouped historical session had already been
-- answered, carry that answer to the other financial slots. Conflicting
-- historical answers are deliberately left untouched for human audit.
with session_answers as (
  select
    coalesce(ac.canonical_confirmation_id, ac.id) as canonical_id,
    min(ac.student_response) filter (where ac.student_response is not null) as response,
    min(ac.responded_at) filter (where ac.student_response is not null) as responded_at,
    count(distinct ac.student_response) filter (where ac.student_response is not null) as response_count
  from public.attendance_confirmations ac
  group by coalesce(ac.canonical_confirmation_id, ac.id)
), unambiguous as (
  select * from session_answers where response_count = 1
)
update public.attendance_confirmations ac
   set student_response = u.response,
       responded_at = u.responded_at,
       response_updated_at = coalesce(ac.response_updated_at, u.responded_at),
       response_editable_until = coalesce(
         ac.response_editable_until,
         u.responded_at + interval '30 minutes'
       )
  from unambiguous u
 where coalesce(ac.canonical_confirmation_id, ac.id) = u.canonical_id
   and ac.student_response is null;

create unique index if not exists uq_attendance_confirmation_delivery_key
  on public.attendance_confirmations (delivery_key)
  where delivery_key is not null;

create index if not exists idx_attendance_confirmation_session
  on public.attendance_confirmations (canonical_confirmation_id, class_date);

create index if not exists idx_attendance_confirmation_delivery_claim
  on public.attendance_confirmations (delivery_status, class_date, created_at)
  where sent_at is null
    and delivery_key is not null;

comment on column public.attendance_confirmations.canonical_confirmation_id is
  'Canonical student-facing audit for a logical lesson session; member rows remain separate for financial reconciliation.';
comment on column public.attendance_confirmations.session_end_at is
  'End of the final contiguous 30-minute slot. Delivery is eligible only ten minutes after this instant.';
comment on column public.attendance_confirmations.delivery_status is
  'At-most-once delivery state. PROCESSING leases that expire become terminal AMBIGUOUS and are never automatically retried.';

-- Preserve the existing enqueue contract, but canonicalize every newly
-- created set before the delivery worker can claim it.
create or replace function public.enqueue_attendance_confirmations()
returns integer
language plpgsql
security definer
set search_path = 'public', 'extensions'
as $function$
declare
  v_count integer := 0;
  r record;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  with occurrence_base as (
    select
      uc.source_id,
      uc.source_type,
      uc.tenant_id,
      case
        when coalesce(confirmed_coverage.match_count, 0) = 1
          then confirmed_coverage.cover_teacher_id
        else uc.teacher_id
      end as teacher_id,
      uc.student_id,
      uc.student_name_override,
      uc.student_phone_override,
      uc.class_date,
      uc.time_text,
      uc.start_at
    from public.upcoming_classes uc
    left join lateral (
      select
        count(*)::integer as match_count,
        count(*) filter (
          where case
                  when btrim(coalesce(coverage.class_time, ''))
                       ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                       and btrim(coalesce(uc.time_text, ''))
                       ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                  then left(btrim(coverage.class_time), 5)::time =
                       left(btrim(uc.time_text), 5)::time
                  else false
                end
        )::integer as time_match_count,
        (array_agg(coverage.cover_teacher_id order by coverage.id))[1]
          as cover_teacher_id
      from public.class_coverages coverage
      where uc.source_type = 'booking'
        and coverage.booking_id::text = uc.source_id::text
        and coverage.tenant_id = uc.tenant_id
        and coverage.student_id is not distinct from uc.student_id
        and coverage.class_date = uc.class_date
        and lower(coalesce(coverage.status, '')) = 'confirmed'
    ) confirmed_coverage on true
    -- Ambiguous historical corruption must not address a confirmation to an
    -- arbitrary teacher. The coverage constraints normally keep this <= 1.
    where coalesce(confirmed_coverage.match_count, 0) = 0
       or (
         confirmed_coverage.match_count = 1
         and confirmed_coverage.time_match_count = 1
       )
  ), upcoming_base as (
    select
      uc.*,
      sp.full_name as profile_student_name,
      tp.full_name as profile_teacher_name,
      selected_phone.phone as selected_phone,
      coalesce(
        uc.student_id::text,
        nullif(regexp_replace(coalesce(selected_phone.phone, ''), '\D', '', 'g'), ''),
        uc.source_id::text
      ) as participant_key
    from occurrence_base uc
    left join public.profiles sp
      on sp.id = uc.student_id
     and sp.tenant_id = uc.tenant_id
     and sp.role = 'STUDENT'
     and sp.is_test_account is false
     and lower(btrim(sp.lifecycle_status)) = 'active'
     and exists (
       select 1
         from public.tenant_memberships membership
        where membership.user_id = sp.id
          and membership.tenant_id = uc.tenant_id
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
     )
    left join public.profiles tp
      on tp.id = uc.teacher_id
     and tp.tenant_id = uc.tenant_id
     and tp.role = 'TEACHER'
     and tp.is_test_account is false
     and lower(btrim(tp.lifecycle_status)) = 'active'
     and exists (
       select 1
         from public.tenant_memberships membership
        where membership.user_id = tp.id
          and membership.tenant_id = uc.tenant_id
          and membership.role = 'TEACHER'
          and membership.status = 'ACTIVE'
     )
    cross join lateral (
      select case
        when length(regexp_replace(coalesce(sp.attendance_phone, ''), '\D', '', 'g')) >= 10
          then sp.attendance_phone
        when length(regexp_replace(coalesce(sp.phone, ''), '\D', '', 'g')) >= 10
          then sp.phone
        when length(regexp_replace(coalesce(uc.student_phone_override, ''), '\D', '', 'g')) >= 10
          then uc.student_phone_override
      end as phone
    ) selected_phone
    where uc.class_date between v_today - 1 and v_today
      and tp.id is not null
      and sp.id is not null
  ), upcoming_lagged as (
    select
      u.*,
      lag(u.start_at) over (
        partition by u.tenant_id, u.teacher_id, u.participant_key, u.class_date
        order by u.start_at, u.source_id
      ) as previous_start_at
    from upcoming_base u
  ), upcoming_marked as (
    select
      u.*,
      case
        when u.previous_start_at is null then 1
        when u.start_at - u.previous_start_at > interval '30 minutes' then 1
        else 0
      end as starts_group
    from upcoming_lagged u
  ), upcoming_grouped as (
    select
      u.*,
      sum(u.starts_group) over (
        partition by u.tenant_id, u.teacher_id, u.participant_key, u.class_date
        order by u.start_at, u.source_id
        rows between unbounded preceding and current row
      ) as group_number
    from upcoming_marked u
  ), ready_sessions as (
    select
      u.*,
      max(u.start_at) over (
        partition by u.tenant_id, u.teacher_id, u.participant_key,
                     u.class_date, u.group_number
      ) as last_start_at
    from upcoming_grouped u
  )
  insert into public.attendance_confirmations (
    tenant_id, source_id, source_type, teacher_id, student_id,
    student_name, student_phone, class_date, class_time, teacher_name,
    token, token_expires_at, session_end_at, status
  )
  select
    ready.tenant_id,
    ready.source_id::text,
    ready.source_type,
    ready.teacher_id,
    ready.student_id,
    coalesce(ready.profile_student_name, ready.student_name_override),
    ready.selected_phone,
    ready.class_date,
    ready.time_text,
    ready.profile_teacher_name,
    encode(extensions.gen_random_bytes(12), 'hex'),
    now() + interval '7 days',
    ready.last_start_at + interval '30 minutes',
    'PENDING'
  from ready_sessions ready
  where ready.last_start_at <= now() - interval '40 minutes'
    and ready.last_start_at >= now() - interval '8 hours'
    and ready.selected_phone is not null
  on conflict (source_id, source_type, class_date) do nothing;

  get diagnostics v_count = row_count;

  perform private.refresh_attendance_confirmation_sessions(
    v_today - 2,
    v_today
  );

  for r in
    select ac.id
      from public.attendance_confirmations ac
     where ac.status in ('PENDING', 'AWAITING_TEACHER', 'ATTENDANCE_MISMATCH', 'CONFLICT')
       and ac.class_date >= v_today - 2
     order by ac.class_date, ac.class_time, ac.id
  loop
    perform public.reconcile_attendance_confirmation(r.id);
  end loop;

  return v_count;
end;
$function$;

alter function public.enqueue_attendance_confirmations() owner to postgres;
revoke all on function public.enqueue_attendance_confirmations()
  from public, anon, authenticated;
grant execute on function public.enqueue_attendance_confirmations()
  to service_role;

-- Five provider calls can exceed the old 60-second pg_net timeout. Keep the
-- existing internal auth/URL contract and give the worker a bounded 180s.
create or replace function public.trigger_send_attendance_confirmations()
returns bigint
language plpgsql
security definer
set search_path = 'public', 'vault'
as $function$
declare
  request_id bigint;
  service_key text;
begin
  perform public.enqueue_attendance_confirmations();

  select decrypted_secret
    into service_key
    from vault.decrypted_secrets
   where name = 'wisewolf_service_role_key'
   limit 1;

  if service_key is null or service_key = '' then
    raise warning 'Vault secret wisewolf_service_role_key not set';
    return -1;
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/send-attendance-confirmations',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  ) into request_id;

  return request_id;
end;
$function$;

alter function public.trigger_send_attendance_confirmations() owner to postgres;
revoke all on function public.trigger_send_attendance_confirmations()
  from public, anon, authenticated;
grant execute on function public.trigger_send_attendance_confirmations()
  to service_role;

-- Atomic, non-blocking claim. There is intentionally no automatic recovery
-- from an expired PROCESSING lease: the provider may have accepted the message
-- before the worker crashed. Marking it AMBIGUOUS is the only safe at-most-once
-- behavior without a provider-side idempotency key.
create or replace function public.claim_attendance_confirmation_deliveries(
  p_limit integer default 50
)
returns table (
  id uuid,
  tenant_id text,
  token text,
  student_id uuid,
  student_name text,
  attendance_phone text,
  teacher_id uuid,
  teacher_name text,
  class_date date,
  class_time text,
  source_id text,
  source_type text,
  send_attempts integer,
  claim_token uuid,
  delivery_key text,
  session_key text,
  session_end_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
begin
  perform private.refresh_attendance_confirmation_sessions(v_today - 1, v_today);

  -- A lost worker is not proof of a failed provider call. Keep it visible for
  -- manual review and never deliver it a second time automatically.
  update public.attendance_confirmations ac
     set delivery_status = 'AMBIGUOUS',
         last_delivery_error = 'claim_lease_expired_delivery_outcome_unknown',
         delivery_claim_expires_at = null
   where ac.delivery_status = 'PROCESSING'
     and ac.delivery_claim_expires_at is not null
     and ac.delivery_claim_expires_at <= pg_catalog.now();

  -- Transactional anti-ghost check. Only recent rows are touched; older
  -- backlog is deliberately left dormant rather than bulk-sent.
  update public.attendance_confirmations ac
     set status = 'CANCELLED',
         delivery_status = 'CANCELLED',
         last_delivery_error = 'occurrence_not_found'
   where ac.class_date between v_today - 1 and v_today
     and ac.sent_at is null
     and ac.student_response is null
     and ac.status = 'PENDING'
     and ac.delivery_key is not null
     and ac.source_id is not null
     and ac.source_type is not null
     and not exists (
       select 1
         from public.attendance_confirmations member
         join public.upcoming_classes uc
           on uc.source_id::text = member.source_id
          and uc.source_type = member.source_type
          and uc.class_date = member.class_date
        where coalesce(member.canonical_confirmation_id, member.id) = ac.id
     );

  return query
  with candidates as (
    select ac.id
      from public.attendance_confirmations ac
     where ac.class_date between v_today - 1 and v_today
       and ac.sent_at is null
       and ac.student_response is null
       and ac.status = 'PENDING'
       and ac.delivery_status = 'PENDING'
       and ac.delivery_key is not null
       and coalesce(ac.canonical_confirmation_id, ac.id) = ac.id
       and ac.send_attempts < 8
       and ac.token_expires_at > pg_catalog.now()
       and ac.session_end_at is not null
       and ac.session_end_at + interval '10 minutes' <= pg_catalog.now()
       and exists (
         select 1
           from public.profiles sp
          where sp.id = ac.student_id
            and sp.tenant_id = ac.tenant_id
            and sp.role = 'STUDENT'
            and sp.is_test_account is false
            and pg_catalog.lower(pg_catalog.btrim(sp.lifecycle_status)) = 'active'
            and exists (
              select 1
                from public.tenant_memberships membership
               where membership.user_id = sp.id
                 and membership.tenant_id = ac.tenant_id
                 and membership.role = 'STUDENT'
                 and membership.status = 'ACTIVE'
            )
       )
       and exists (
         select 1
           from public.profiles tp
          where tp.id = ac.teacher_id
            and tp.tenant_id = ac.tenant_id
            and tp.role = 'TEACHER'
            and tp.is_test_account is false
            and pg_catalog.lower(pg_catalog.btrim(tp.lifecycle_status)) = 'active'
            and exists (
              select 1
                from public.tenant_memberships membership
               where membership.user_id = tp.id
                 and membership.tenant_id = ac.tenant_id
                 and membership.role = 'TEACHER'
                 and membership.status = 'ACTIVE'
            )
       )
     order by ac.class_date, ac.class_time, ac.created_at, ac.id
     for update skip locked
     limit v_limit
  ), claimed as (
    update public.attendance_confirmations ac
       set delivery_status = 'PROCESSING',
           delivery_claim_token = extensions.gen_random_uuid(),
           delivery_claimed_at = pg_catalog.now(),
           delivery_claim_expires_at = pg_catalog.now() + interval '5 minutes',
           send_attempts = ac.send_attempts + 1,
           last_delivery_error = null
      from candidates c
     where ac.id = c.id
    returning ac.*
  )
  select
    c.id,
    c.tenant_id,
    c.token,
    c.student_id,
    c.student_name,
    (
      select case
        when pg_catalog.length(pg_catalog.regexp_replace(
               coalesce(sp.attendance_phone, ''), '[^0-9]', '', 'g'
             )) >= 10
          then sp.attendance_phone
        when pg_catalog.length(pg_catalog.regexp_replace(
               coalesce(sp.phone, ''), '[^0-9]', '', 'g'
             )) >= 10
          then sp.phone
      end
        from public.profiles sp
       where sp.id = c.student_id
         and sp.tenant_id = c.tenant_id
         and sp.role = 'STUDENT'
       limit 1
    ) as attendance_phone,
    c.teacher_id,
    c.teacher_name,
    c.class_date,
    c.class_time,
    c.source_id,
    c.source_type,
    c.send_attempts,
    c.delivery_claim_token as claim_token,
    c.delivery_key,
    c.session_key,
    c.session_end_at
  from claimed c
  order by c.class_date, c.class_time, c.created_at, c.id;
end;
$function$;

create or replace function public.complete_attendance_confirmation_delivery(
  p_confirmation_id uuid,
  p_claim_token uuid,
  p_provider_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  c public.attendance_confirmations%rowtype;
begin
  if p_confirmation_id is null or p_claim_token is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'claim_invalido');
  end if;

  if nullif(pg_catalog.btrim(coalesce(p_provider_message_id, '')), '') is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'provider_message_id_obrigatorio'
    );
  end if;

  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = p_confirmation_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;

  if c.delivery_status = 'SENT'
     and c.delivery_claim_token = p_claim_token then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'already', true,
      'sent_at', c.sent_at
    );
  end if;

  if c.delivery_status <> 'PROCESSING'
     or c.delivery_claim_token is distinct from p_claim_token then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'claim_obsoleto',
      'delivery_status', c.delivery_status
    );
  end if;

  update public.attendance_confirmations ac
     set delivery_status = 'SENT',
         sent_at = coalesce(ac.sent_at, pg_catalog.now()),
         delivery_claim_expires_at = null,
         provider_message_id = pg_catalog.left(pg_catalog.btrim(p_provider_message_id), 255),
         last_delivery_error = null
   where ac.id = c.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'sent_at', pg_catalog.now(),
    'delivery_key', c.delivery_key
  );
end;
$function$;

create or replace function public.fail_attendance_confirmation_delivery(
  p_confirmation_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_ambiguous boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  c public.attendance_confirmations%rowtype;
  v_error text := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(p_error_code), ''), 'delivery_failed'),
    500
  );
  v_status text;
  v_cancelled boolean := false;
  v_occurrence_missing boolean := false;
begin
  if p_confirmation_id is null or p_claim_token is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'claim_invalido');
  end if;

  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = p_confirmation_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;

  if c.delivery_status <> 'PROCESSING'
     or c.delivery_claim_token is distinct from p_claim_token then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'claim_obsoleto',
      'delivery_status', c.delivery_status
    );
  end if;

  if v_error in ('occurrence_not_found', 'occurrence_cancelled') then
    select not exists (
      select 1
        from public.attendance_confirmations member
        join public.upcoming_classes uc
          on uc.source_id::text = member.source_id
         and uc.source_type = member.source_type
         and uc.class_date = member.class_date
       where coalesce(member.canonical_confirmation_id, member.id) = c.id
    )
    into v_occurrence_missing;
  end if;

  if not coalesce(p_ambiguous, false)
     and v_error in ('occurrence_not_found', 'occurrence_cancelled')
     and v_occurrence_missing then
    v_status := 'CANCELLED';
    v_cancelled := true;
  elsif v_error = 'stale_delivery_suppressed' then
    -- A stale message must not go out, but delivery age says nothing about
    -- whether the lesson itself existed. Preserve the business audit status.
    v_status := 'FAILED';
  elsif not coalesce(p_ambiguous, false)
        and v_error in ('occurrence_not_found', 'occurrence_cancelled') then
    -- The worker's stale view disagreed with the authoritative agenda. Fail the
    -- delivery terminally without cancelling a real lesson.
    v_status := 'FAILED';
  elsif coalesce(p_ambiguous, false) then
    v_status := 'AMBIGUOUS';
  elsif c.send_attempts >= 8 then
    v_status := 'FAILED';
  else
    v_status := 'PENDING';
  end if;

  update public.attendance_confirmations ac
     set delivery_status = v_status,
         status = case when v_cancelled then 'CANCELLED' else ac.status end,
         delivery_claim_expires_at = null,
         last_delivery_error = v_error
   where ac.id = c.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'delivery_status', v_status,
    'retryable', v_status = 'PENDING',
    'ambiguous', v_status = 'AMBIGUOUS',
    'cancelled', v_cancelled
  );
end;
$function$;

alter function public.claim_attendance_confirmation_deliveries(integer) owner to postgres;
alter function public.complete_attendance_confirmation_delivery(uuid, uuid, text) owner to postgres;
alter function public.fail_attendance_confirmation_delivery(uuid, uuid, text, boolean) owner to postgres;

revoke all on function public.claim_attendance_confirmation_deliveries(integer)
  from public, anon, authenticated;
revoke all on function public.complete_attendance_confirmation_delivery(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.fail_attendance_confirmation_delivery(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_attendance_confirmation_deliveries(integer)
  to service_role;
grant execute on function public.complete_attendance_confirmation_delivery(uuid, uuid, text)
  to service_role;
grant execute on function public.fail_attendance_confirmation_delivery(uuid, uuid, text, boolean)
  to service_role;

-- One implementation for the public token route and the authenticated student
-- panel. The wrappers provide either a token or auth.uid(); this private helper
-- performs the authoritative ownership, expiry, correction-window and locking
-- checks and propagates the answer to every financial slot in the session.
create or replace function private.apply_attendance_response(
  p_confirmation_id uuid,
  p_token text,
  p_response text,
  p_actor_id uuid,
  p_actor_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_requested public.attendance_confirmations%rowtype;
  c public.attendance_confirmations%rowtype;
  v_canonical_id uuid;
  v_previous text;
  v_now timestamptz := pg_catalog.now();
  v_corrected boolean := false;
  v_status text;
begin
  if p_response not in (
    'STUDENT_PRESENT',
    'TEACHER_NO_SHOW',
    'STUDENT_SELF_ABSENT',
    'CANCELLED_RESCHEDULED'
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'resposta_invalida');
  end if;

  if p_actor_kind = 'PUBLIC_TOKEN' then
    if nullif(pg_catalog.btrim(coalesce(p_token, '')), '') is null then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'token_invalido');
    end if;

    select ac.*
      into v_requested
      from public.attendance_confirmations ac
     where ac.token = p_token
     for update;

    if not found then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'token_invalido');
    end if;
  elsif p_actor_kind = 'AUTHENTICATED_STUDENT' then
    if p_actor_id is null or p_confirmation_id is null then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
    end if;

    select ac.*
      into v_requested
      from public.attendance_confirmations ac
     where ac.id = p_confirmation_id
       and ac.student_id = p_actor_id
     for update;

    if not found then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
    end if;
  else
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'ator_invalido');
  end if;

  v_canonical_id := coalesce(v_requested.canonical_confirmation_id, v_requested.id);

  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = v_canonical_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'confirmacao_invalida');
  end if;

  -- Lock session members in a deterministic order so simultaneous answers via
  -- WhatsApp and the authenticated panel cannot overwrite one another.
  perform 1
    from public.attendance_confirmations ac
   where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
   order by ac.id
   for update;

  if p_actor_kind = 'AUTHENTICATED_STUDENT'
     and c.student_id is distinct from p_actor_id then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  if v_requested.token_expires_at is null
     or v_requested.token_expires_at <= v_now then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'token_expirado');
  end if;

  if c.status = 'CANCELLED' or c.delivery_status = 'CANCELLED' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'confirmacao_cancelada');
  end if;

  if c.status in ('RESOLVED_PAID', 'RESOLVED_UNPAID') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'decisao_finalizada');
  end if;

  v_previous := c.student_response;

  if v_previous is not null and v_previous = p_response then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'already', true,
      'teacher_name', c.teacher_name,
      'status', c.status,
      'student_response', c.student_response,
      'corrected', false,
      'editable_until', c.response_editable_until
    );
  end if;

  if v_previous is not null then
    if c.response_editable_until is null
       or c.response_editable_until <= v_now then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'janela_correcao_encerrada'
      );
    end if;
    v_corrected := true;
  end if;

  insert into private.attendance_response_audit (
    confirmation_id,
    session_key,
    previous_response,
    new_response,
    actor_id,
    actor_kind,
    changed_at
  ) values (
    c.id,
    c.session_key,
    v_previous,
    p_response,
    p_actor_id,
    p_actor_kind,
    v_now
  );

  update public.attendance_confirmations ac
     set student_response = p_response,
         responded_at = coalesce(ac.responded_at, v_now),
         response_updated_at = v_now,
         response_editable_until = coalesce(
           ac.response_editable_until,
           v_now + interval '30 minutes'
         ),
         student_rating = case
           when v_previous = 'STUDENT_PRESENT'
                and p_response <> 'STUDENT_PRESENT'
           then null
           else ac.student_rating
         end
   where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id;

  -- The reconciliation is session-aware and reverses a former hard conflict
  -- (hold, Turbo suspension and delayed alert) when a valid correction changes
  -- the answer during the edit window.
  perform public.reconcile_attendance_confirmation(v_canonical_id);

  select ac.status
    into v_status
    from public.attendance_confirmations ac
   where ac.id = v_canonical_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'teacher_name', c.teacher_name,
    'status', v_status,
    'student_response', p_response,
    'corrected', v_corrected,
    'editable_until', coalesce(c.response_editable_until, v_now + interval '30 minutes')
  );
end;
$function$;

alter function private.apply_attendance_response(uuid, text, text, uuid, text)
  owner to postgres;
revoke all on function private.apply_attendance_response(uuid, text, text, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.get_confirmation_public(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_requested public.attendance_confirmations%rowtype;
  c public.attendance_confirmations%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_expired boolean;
  v_cancelled boolean;
  v_can_correct boolean;
begin
  select ac.*
    into v_requested
    from public.attendance_confirmations ac
   where ac.token = p_token
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = coalesce(v_requested.canonical_confirmation_id, v_requested.id)
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  v_expired := v_requested.token_expires_at is null
    or v_requested.token_expires_at <= v_now;
  v_cancelled := c.status = 'CANCELLED' or c.delivery_status = 'CANCELLED';
  v_can_correct := not v_expired
    and not v_cancelled
    and c.status not in ('RESOLVED_PAID', 'RESOLVED_UNPAID')
    and (
      c.student_response is null
      or c.response_editable_until > v_now
    );

  if v_expired or v_cancelled then
    return pg_catalog.jsonb_build_object(
      'found', true,
      'already', c.student_response is not null,
      'status', c.status,
      'student_response', c.student_response,
      'allowed_responses', '[]'::jsonb,
      'can_correct', false,
      'editable_until', c.response_editable_until,
      'expired', v_expired,
      'cancelled', v_cancelled
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'teacher_name', c.teacher_name,
    'student_name', c.student_name,
    'class_date', c.class_date,
    'class_time', c.class_time,
    'already', c.student_response is not null,
    'status', c.status,
    'student_response', c.student_response,
    'allowed_responses', pg_catalog.jsonb_build_array(
      'STUDENT_PRESENT',
      'TEACHER_NO_SHOW',
      'STUDENT_SELF_ABSENT',
      'CANCELLED_RESCHEDULED'
    ),
    'can_correct', v_can_correct,
    'editable_until', c.response_editable_until,
    'expired', false,
    'cancelled', false
  );
end;
$function$;

create or replace function public.apply_student_response(
  p_token text,
  p_response text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return private.apply_attendance_response(
    null,
    p_token,
    p_response,
    null,
    'PUBLIC_TOKEN'
  );
end;
$function$;

create or replace function public.apply_my_attendance_response(
  p_confirmation_id uuid,
  p_response text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  return private.apply_attendance_response(
    p_confirmation_id,
    null,
    p_response,
    v_uid,
    'AUTHENTICATED_STUDENT'
  );
end;
$function$;

create or replace function public.rate_attendance(
  p_token text,
  p_stars integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_requested public.attendance_confirmations%rowtype;
  c public.attendance_confirmations%rowtype;
  v_canonical_id uuid;
begin
  if p_stars < 1 or p_stars > 5 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'estrelas_invalidas');
  end if;

  select ac.*
    into v_requested
    from public.attendance_confirmations ac
   where ac.token = p_token
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'token_invalido');
  end if;

  v_canonical_id := coalesce(v_requested.canonical_confirmation_id, v_requested.id);
  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = v_canonical_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'confirmacao_invalida');
  end if;

  perform 1
    from public.attendance_confirmations ac
   where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
   order by ac.id
   for update;

  if v_requested.token_expires_at is null
     or v_requested.token_expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'token_expirado');
  end if;

  if c.status = 'CANCELLED' or c.delivery_status = 'CANCELLED' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'confirmacao_cancelada');
  end if;

  if c.student_response is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'resposta_obrigatoria');
  end if;

  if c.student_response <> 'STUDENT_PRESENT' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'avaliacao_nao_permitida');
  end if;

  if c.student_rating is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'already', true);
  end if;

  update public.attendance_confirmations ac
     set student_rating = p_stars
   where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id;

  return pg_catalog.jsonb_build_object('ok', true, 'stars', p_stars);
end;
$function$;

create or replace function public.my_attendance_audits()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then
    return '[]'::jsonb;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', q.id,
        'teacher_name', q.teacher_name,
        'class_date', q.class_date,
        'class_time', q.class_time,
        'student_response', q.student_response,
        'status', q.status,
        'responded_at', q.responded_at,
        'student_rating', q.student_rating,
        'can_correct', q.can_correct,
        'editable_until', q.response_editable_until,
        'allowed_responses', case when q.can_correct then
          pg_catalog.jsonb_build_array(
            'STUDENT_PRESENT',
            'TEACHER_NO_SHOW',
            'STUDENT_SELF_ABSENT',
            'CANCELLED_RESCHEDULED'
          )
        else '[]'::jsonb end
      ) order by q.class_date desc, q.class_time desc, q.id
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      ac.id,
      ac.teacher_name,
      ac.class_date,
      ac.class_time,
      ac.student_response,
      ac.status,
      ac.responded_at,
      ac.student_rating,
      ac.response_editable_until,
      (
        ac.token_expires_at > pg_catalog.now()
        and ac.status not in ('CANCELLED', 'RESOLVED_PAID', 'RESOLVED_UNPAID')
        and (
          ac.student_response is null
          or ac.response_editable_until > pg_catalog.now()
        )
      ) as can_correct
    from public.attendance_confirmations ac
    where ac.student_id = v_uid
      and coalesce(ac.canonical_confirmation_id, ac.id) = ac.id
      and (
        ac.student_response is not null
        or (
          ac.token_expires_at > pg_catalog.now()
          and ac.status not in ('CANCELLED', 'RESOLVED_PAID', 'RESOLVED_UNPAID')
        )
      )
    order by ac.class_date desc, ac.class_time desc, ac.id
    limit 100
  ) q;

  return v_result;
end;
$function$;

create or replace function public.my_attendance_conflict_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_count integer := 0;
begin
  if v_uid is null or not exists (
    select 1
      from public.profiles p
     where p.id = v_uid
       and p.role = 'TEACHER'
  ) then
    return 0;
  end if;

  select count(*)::integer
    into v_count
    from public.attendance_confirmations ac
   where ac.teacher_id = v_uid
     and ac.status = 'CONFLICT'
     and coalesce(ac.canonical_confirmation_id, ac.id) = ac.id;

  return v_count;
end;
$function$;

create or replace function public.confirm_my_class_log(p_class_log_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  c public.class_logs%rowtype;
begin
  if v_uid is null or p_class_log_id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  select cl.*
    into c
    from public.class_logs cl
   where cl.id = p_class_log_id
     and cl.student_id = v_uid
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;

  if coalesce(c.student_confirmed, false) then
    return pg_catalog.jsonb_build_object('ok', true, 'already', true);
  end if;

  update public.class_logs cl
     set student_confirmed = true
   where cl.id = c.id;

  return pg_catalog.jsonb_build_object('ok', true, 'already', false);
end;
$function$;

alter function public.get_confirmation_public(text) owner to postgres;
alter function public.apply_student_response(text, text) owner to postgres;
alter function public.apply_my_attendance_response(uuid, text) owner to postgres;
alter function public.rate_attendance(text, integer) owner to postgres;
alter function public.my_attendance_audits() owner to postgres;
alter function public.my_attendance_conflict_count() owner to postgres;
alter function public.confirm_my_class_log(uuid) owner to postgres;

revoke all on function public.get_confirmation_public(text)
  from public, anon, authenticated;
revoke all on function public.apply_student_response(text, text)
  from public, anon, authenticated;
revoke all on function public.apply_my_attendance_response(uuid, text)
  from public, anon, authenticated;
revoke all on function public.rate_attendance(text, integer)
  from public, anon, authenticated;
revoke all on function public.my_attendance_audits()
  from public, anon, authenticated;
revoke all on function public.my_attendance_conflict_count()
  from public, anon, authenticated;
revoke all on function public.confirm_my_class_log(uuid)
  from public, anon, authenticated;

grant execute on function public.get_confirmation_public(text)
  to anon, authenticated, service_role;
grant execute on function public.apply_student_response(text, text)
  to anon, authenticated, service_role;
grant execute on function public.rate_attendance(text, integer)
  to anon, authenticated, service_role;
grant execute on function public.apply_my_attendance_response(uuid, text)
  to authenticated, service_role;
grant execute on function public.my_attendance_audits()
  to authenticated, service_role;
grant execute on function public.my_attendance_conflict_count()
  to authenticated, service_role;
grant execute on function public.confirm_my_class_log(uuid)
  to authenticated, service_role;

-- Applies an already-final director decision to every financial slot in the
-- logical session. It is also called after a late class_log insert, so a
-- teacher cannot turn a final TEACHER_ABSENT decision back into a payable log.
create or replace function private.apply_final_attendance_resolution(
  p_canonical_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  c public.attendance_confirmations%rowtype;
  v_session_key text;
  v_original_booking_id uuid;
  v_reschedule_id uuid;
begin
  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = p_canonical_id
   for update;

  if not found
     or c.status not in ('RESOLVED_PAID', 'RESOLVED_UNPAID')
     or c.resolution_verdict is null then
    return;
  end if;

  perform 1
    from public.attendance_confirmations ac
   where coalesce(ac.canonical_confirmation_id, ac.id) = c.id
   order by ac.id
   for update;

  with members as (
    select ac.*
      from public.attendance_confirmations ac
     where coalesce(ac.canonical_confirmation_id, ac.id) = c.id
  )
  update public.class_logs cl
     set presence = case
           when c.resolution_verdict = 'TEACHER_ABSENT'
             then 'TEACHER_ABSENCE'
           when c.resolution_verdict = 'TEACHER_PRESENT'
                and cl.presence in ('TEACHER_ABSENCE', 'Falta do Professor')
             then 'STUDENT_ABSENCE'
           else cl.presence
         end,
         verification_status = c.status,
         payment_hold = false,
         teacher_verdict = case
           when c.resolution_verdict in ('TEACHER_PRESENT', 'TEACHER_ABSENT')
             then c.resolution_verdict
           else cl.teacher_verdict
         end
   where cl.tenant_id = c.tenant_id
     and cl.teacher_id = c.teacher_id
     and cl.student_id is not distinct from c.student_id
     and cl.class_date = c.class_date
     and exists (
       select 1
         from members m
        where m.class_log_id = cl.id
           or (m.source_type = 'booking' and m.source_id = cl.booking_id)
           or (m.source_type = 'reschedule' and m.source_id = cl.reschedule_id)
           or (m.source_type = 'appointment' and m.source_id = cl.appointment_id)
     );

  -- Attach every member to its exact late/existing financial row and reflect
  -- the final, normalized report back into the audit row.
  update public.attendance_confirmations ac
     set class_log_id = coalesce((
           select cl.id
             from public.class_logs cl
            where cl.tenant_id = ac.tenant_id
              and cl.teacher_id = ac.teacher_id
              and cl.student_id is not distinct from ac.student_id
              and cl.class_date = ac.class_date
              and (
                cl.id = ac.class_log_id
                or (ac.source_type = 'booking' and ac.source_id = cl.booking_id)
                or (ac.source_type = 'reschedule' and ac.source_id = cl.reschedule_id)
                or (ac.source_type = 'appointment' and ac.source_id = cl.appointment_id)
              )
            order by (cl.id = ac.class_log_id) desc, cl.created_at desc, cl.id
            limit 1
         ), ac.class_log_id),
         teacher_reported = coalesce((
           select cl.presence
             from public.class_logs cl
            where cl.tenant_id = ac.tenant_id
              and cl.teacher_id = ac.teacher_id
              and cl.student_id is not distinct from ac.student_id
              and cl.class_date = ac.class_date
              and (
                cl.id = ac.class_log_id
                or (ac.source_type = 'booking' and ac.source_id = cl.booking_id)
                or (ac.source_type = 'reschedule' and ac.source_id = cl.reschedule_id)
                or (ac.source_type = 'appointment' and ac.source_id = cl.appointment_id)
              )
            order by (cl.id = ac.class_log_id) desc, cl.created_at desc, cl.id
            limit 1
         ), ac.teacher_reported)
   where coalesce(ac.canonical_confirmation_id, ac.id) = c.id;

  v_session_key := coalesce(c.session_key, 'attendance:legacy:' || c.id::text);

  select coalesce(
           case
             when ac.source_type = 'booking'
                  and ac.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             then ac.source_id::uuid
           end,
           case when ac.source_type = 'reschedule' then (
             select r.original_booking_id
               from public.reschedules r
              where r.id::text = ac.source_id
                and r.tenant_id = ac.tenant_id
                and r.teacher_id = ac.teacher_id
                and r.student_id is not distinct from ac.student_id
              limit 1
           ) end
         )
    into v_original_booking_id
    from public.attendance_confirmations ac
   where coalesce(ac.canonical_confirmation_id, ac.id) = c.id
   order by (ac.source_type = 'booking') desc, ac.class_time, ac.id
   limit 1;

  -- Prefer the reschedule emitted by the teacher logging RPC in the same
  -- transaction as a matching class_log. Otherwise create one session-level
  -- make-up. The unique attendance_session_key makes this idempotent.
  select r.id
    into v_reschedule_id
    from public.reschedules r
   where r.fault_type = 'TEACHER'
     and r.tenant_id = c.tenant_id
     and r.teacher_id = c.teacher_id
     and r.student_id is not distinct from c.student_id
     and (
       r.attendance_session_key = v_session_key
       or (
         r.attendance_session_key is null
         and exists (
           select 1
             from public.class_logs cl
             join public.attendance_confirmations ac
               on coalesce(ac.canonical_confirmation_id, ac.id) = c.id
              and ac.tenant_id = cl.tenant_id
              and ac.teacher_id = cl.teacher_id
              and ac.student_id is not distinct from cl.student_id
              and ac.class_date = cl.class_date
              and (
                ac.class_log_id = cl.id
                or (ac.source_type = 'booking' and ac.source_id = cl.booking_id)
                or (ac.source_type = 'reschedule' and ac.source_id = cl.reschedule_id)
              )
            where cl.created_at between r.created_at - interval '5 minutes'
                                    and r.created_at + interval '5 minutes'
              and r.original_booking_id is not distinct from v_original_booking_id
         )
       )
     )
   order by (r.attendance_session_key = v_session_key) desc,
            r.created_at desc,
            r.id
   limit 1
   for update;

  if c.resolution_verdict = 'TEACHER_ABSENT' and c.student_id is not null then
    if v_reschedule_id is not null then
      update public.reschedules r
         set attendance_session_key = v_session_key,
             used_at = null
       where r.id = v_reschedule_id;
    else
      insert into public.reschedules (
        tenant_id,
        original_booking_id,
        teacher_id,
        student_id,
        date,
        time,
        fault_type,
        attendance_session_key,
        created_at
      ) values (
        c.tenant_id,
        v_original_booking_id,
        c.teacher_id,
        c.student_id,
        'Pendente',
        'Pendente',
        'TEACHER',
        v_session_key,
        pg_catalog.now()
      )
      on conflict (attendance_session_key)
        where attendance_session_key is not null and fault_type = 'TEACHER'
      do update set used_at = null;
    end if;
  elsif c.resolution_verdict = 'TEACHER_PRESENT' and v_reschedule_id is not null then
    update public.reschedules r
       set attendance_session_key = coalesce(r.attendance_session_key, v_session_key),
           used_at = coalesce(r.used_at, pg_catalog.now())
     where r.id = v_reschedule_id;
  end if;
end;
$function$;

alter function private.apply_final_attendance_resolution(uuid) owner to postgres;
revoke all on function private.apply_final_attendance_resolution(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.reconcile_attendance_confirmation(p_conf_id uuid)
returns void
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  requested public.attendance_confirmations%rowtype;
  c public.attendance_confirmations%rowtype;
  v_canonical_id uuid;
  v_status text;
  v_hold boolean := false;
  v_has_log boolean := false;
  v_has_payable_log boolean := false;
  v_all_teacher_absence boolean := false;
  v_has_completed boolean := false;
  v_has_student_absence boolean := false;
  v_reported text;
  v_msg text;
  v_schedule_at timestamptz;
begin
  select ac.*
    into requested
    from public.attendance_confirmations ac
   where ac.id = p_conf_id
   for update;
  if not found then return; end if;

  v_canonical_id := coalesce(requested.canonical_confirmation_id, requested.id);
  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = v_canonical_id
   for update;
  if not found then return; end if;

  perform 1
    from public.attendance_confirmations ac
   where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
   order by ac.id
   for update;

  if c.status in ('RESOLVED_PAID', 'RESOLVED_UNPAID') then
    perform private.apply_final_attendance_resolution(v_canonical_id);
    return;
  end if;

  with members as (
    select ac.*
      from public.attendance_confirmations ac
     where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
  ), logs as (
    select distinct cl.*
      from public.class_logs cl
     where cl.tenant_id = c.tenant_id
       and cl.teacher_id = c.teacher_id
       and cl.student_id is not distinct from c.student_id
       and cl.class_date = c.class_date
       and exists (
         select 1
           from members m
          where m.class_log_id = cl.id
             or (m.source_type = 'booking' and m.source_id = cl.booking_id)
             or (m.source_type = 'reschedule' and m.source_id = cl.reschedule_id)
             or (m.source_type = 'appointment' and m.source_id = cl.appointment_id)
       )
  )
  select
    count(*) > 0,
    coalesce(bool_or(l.presence not in ('TEACHER_ABSENCE', 'Falta do Professor')), false),
    coalesce(bool_and(l.presence in ('TEACHER_ABSENCE', 'Falta do Professor')), false),
    coalesce(bool_or(l.presence = 'COMPLETED'), false),
    coalesce(bool_or(l.presence in ('STUDENT_ABSENCE', 'Falta Justificada')), false),
    (array_agg(l.presence order by
      case l.presence
        when 'COMPLETED' then 1
        when 'STUDENT_ABSENCE' then 2
        when 'Falta Justificada' then 3
        when 'TEACHER_ABSENCE' then 4
        else 5
      end,
      l.created_at desc
    ))[1]
  into
    v_has_log,
    v_has_payable_log,
    v_all_teacher_absence,
    v_has_completed,
    v_has_student_absence,
    v_reported
  from logs l;

  if c.student_response is null and not v_has_log then
    v_status := 'PENDING';
  elsif c.student_response is not null and not v_has_log then
    v_status := 'AWAITING_TEACHER';
  elsif c.student_response is null and v_has_log then
    v_status := 'PENDING';
  elsif c.student_response = 'TEACHER_NO_SHOW' and v_has_payable_log then
    v_status := 'CONFLICT';
    v_hold := true;
  elsif c.student_response = 'TEACHER_NO_SHOW' then
    v_status := 'CONFIRMED';
  elsif c.student_response = 'STUDENT_PRESENT'
        and v_has_completed
        and not v_has_student_absence
        and not v_all_teacher_absence then
    v_status := 'CONFIRMED';
  elsif c.student_response = 'STUDENT_SELF_ABSENT'
        and v_has_student_absence
        and not v_has_completed
        and not v_all_teacher_absence then
    v_status := 'CONFIRMED';
  elsif c.student_response = 'CANCELLED_RESCHEDULED'
        and v_all_teacher_absence then
    v_status := 'CONFIRMED';
  else
    v_status := 'ATTENDANCE_MISMATCH';
  end if;

  -- Link each member to its exact financial slot while assigning the same
  -- session-level outcome to every member.
  update public.attendance_confirmations ac
     set class_log_id = coalesce((
           select cl.id
             from public.class_logs cl
            where cl.tenant_id = ac.tenant_id
              and cl.teacher_id = ac.teacher_id
              and cl.student_id is not distinct from ac.student_id
              and cl.class_date = ac.class_date
              and (
                cl.id = ac.class_log_id
                or (ac.source_type = 'booking' and ac.source_id = cl.booking_id)
                or (ac.source_type = 'reschedule' and ac.source_id = cl.reschedule_id)
                or (ac.source_type = 'appointment' and ac.source_id = cl.appointment_id)
              )
            order by (cl.id = ac.class_log_id) desc, cl.created_at desc, cl.id
            limit 1
         ), ac.class_log_id),
         teacher_reported = coalesce((
           select cl.presence
             from public.class_logs cl
            where cl.tenant_id = ac.tenant_id
              and cl.teacher_id = ac.teacher_id
              and cl.student_id is not distinct from ac.student_id
              and cl.class_date = ac.class_date
              and (
                cl.id = ac.class_log_id
                or (ac.source_type = 'booking' and ac.source_id = cl.booking_id)
                or (ac.source_type = 'reschedule' and ac.source_id = cl.reschedule_id)
                or (ac.source_type = 'appointment' and ac.source_id = cl.appointment_id)
              )
            order by (cl.id = ac.class_log_id) desc, cl.created_at desc, cl.id
            limit 1
         ), v_reported, ac.teacher_reported),
         status = v_status
   where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id;

  with members as (
    select ac.*
      from public.attendance_confirmations ac
     where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
  )
  update public.class_logs cl
     set verification_status = v_status,
         payment_hold = v_hold,
         student_confirmed = c.student_response is not null
   where cl.tenant_id = c.tenant_id
     and cl.teacher_id = c.teacher_id
     and cl.student_id is not distinct from c.student_id
     and cl.class_date = c.class_date
     and exists (
       select 1
         from members m
        where m.class_log_id = cl.id
           or (m.source_type = 'booking' and m.source_id = cl.booking_id)
           or (m.source_type = 'reschedule' and m.source_id = cl.reschedule_id)
           or (m.source_type = 'appointment' and m.source_id = cl.appointment_id)
     );

  if v_status <> 'CONFLICT' then
    update public.notification_queue nq
       set status = 'skipped',
           updated_at = now(),
           last_error = 'attendance_conflict_withdrawn_before_send'
     where nq.notification_kind = 'CONFLICT_TEACHER_ALERT'
       and nq.status = 'pending'
       and nq.source_id in (
         select ac.id
           from public.attendance_confirmations ac
          where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
       );
  end if;

  -- A hard alert is delayed until the answer can no longer be corrected. This
  -- prevents a transient tap from notifying or penalizing the teacher twice.
  if v_status = 'CONFLICT'
     and c.teacher_id is not null
     and c.tenant_id is not null then
    v_schedule_at := greatest(
      now(),
      coalesce(c.response_editable_until, now() + interval '30 minutes')
    );
    v_msg :=
      'Oi, ' || coalesce(nullif(split_part(c.teacher_name, ' ', 1), ''), 'professor') ||
      '! Aqui e da coordenacao da escola.' || E'\n\n' ||
      'Recebemos uma divergencia sobre a aula de ' ||
      to_char(c.class_date, 'DD/MM') ||
      coalesce(' as ' || left(c.class_time, 5), '') ||
      ' com ' || coalesce(c.student_name, 'o(a) aluno(a)') || '.' || E'\n' ||
      'Pode nos contar como foi essa aula? Enquanto analisamos, somente esta aula fica em revisao.';

    update public.notification_queue nq
       set status = 'pending',
           scheduled_for = v_schedule_at,
           message_body = v_msg,
           attempts = 0,
           last_error = null,
           updated_at = now()
     where nq.notification_kind = 'CONFLICT_TEACHER_ALERT'
       and nq.status = 'skipped'
       and nq.last_error in (
         'attendance_conflict_withdrawn_before_send',
         'attendance_conflict_resolved_before_send'
       )
       and nq.source_id in (
         select ac.id
           from public.attendance_confirmations ac
          where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
       );

    insert into public.notification_queue (
      tenant_id, teacher_id, student_id, student_name, student_phone,
      message_body, scheduled_for, status, source_id, source_type,
      class_date, notification_kind
    )
    select
      c.tenant_id,
      null,
      c.student_id,
      c.teacher_name,
      p.phone,
      v_msg,
      v_schedule_at,
      'pending',
      v_canonical_id,
      'attendance_confirmation',
      c.class_date,
      'CONFLICT_TEACHER_ALERT'
    from public.profiles p
    where p.id = c.teacher_id
      and p.tenant_id = c.tenant_id
      and p.role = 'TEACHER'
      and lower(btrim(p.lifecycle_status)) = 'active'
      and exists (
        select 1
          from public.tenant_memberships membership
         where membership.user_id = p.id
           and membership.tenant_id = c.tenant_id
           and membership.role = 'TEACHER'
           and membership.status = 'ACTIVE'
      )
      and coalesce(p.phone, '') <> ''
      and not exists (
        select 1
          from public.notification_queue nq
         where nq.notification_kind = 'CONFLICT_TEACHER_ALERT'
           and nq.source_id in (
             select ac.id
               from public.attendance_confirmations ac
              where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
           )
      );
  end if;
end;
$function$;

alter function public.reconcile_attendance_confirmation(uuid) owner to postgres;
revoke all on function public.reconcile_attendance_confirmation(uuid)
  from public, anon, authenticated;
grant execute on function public.reconcile_attendance_confirmation(uuid)
  to service_role;

-- Turbo follows the reconciled, canonical hard conflict -- never the raw tap.
-- This avoids suspending a teacher while there is no payable class_log, during
-- the 30-minute correction window, or once per each 30-minute member slot.
create or replace function public.teacher_turbo_sync_attendance_dispute(
  p_confirmation_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  requested public.attendance_confirmations%rowtype;
  c public.attendance_confirmations%rowtype;
  v_canonical_id uuid;
  v_log_presence text;
  v_dispute_status text;
  v_verdict text;
  v_suspended_at timestamptz;
  v_resolution_at timestamptz;
  v_effective_on date;
  v_reported_class_date date;
  v_existing_dispute public.teacher_turbo_disputes%rowtype;
begin
  select ac.*
    into requested
    from public.attendance_confirmations ac
   where ac.id = p_confirmation_id;
  if not found then return; end if;

  v_canonical_id := coalesce(requested.canonical_confirmation_id, requested.id);
  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = v_canonical_id;
  if not found then return; end if;

  if c.teacher_id is null
     or c.tenant_id is null
     or not exists (
       select 1
         from public.profiles p
        where p.id = c.teacher_id
          and p.role = 'TEACHER'
          and p.tenant_id = c.tenant_id
     ) then
    return;
  end if;

  -- Close any legacy per-member OPEN rows. The canonical row below is the only
  -- row allowed to represent the logical session.
  update public.teacher_turbo_disputes d
     set status = 'DISMISSED',
         verdict = 'CANCELLED',
         resolved_at = coalesce(c.resolved_at, now()),
         resolved_by = c.resolved_by,
         resolution_note = 'Consolidada na confirmacao canonica da sessao',
         updated_at = now()
   where d.confirmation_id in (
     select ac.id
       from public.attendance_confirmations ac
      where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
        and ac.id <> v_canonical_id
   )
     and d.status = 'OPEN';

  if requested.id <> v_canonical_id then
    return;
  end if;

  if c.class_log_id is not null then
    select cl.presence
      into v_log_presence
      from public.class_logs cl
     where cl.id = c.class_log_id
       and cl.tenant_id = c.tenant_id
       and cl.teacher_id = c.teacher_id
       and cl.student_id is not distinct from c.student_id;
    if not found then return; end if;
  end if;

  -- A correction/removal, a non-hard status, or a conflict whose edit window
  -- is still open must leave no preventive suspension behind.
  if c.student_response is distinct from 'TEACHER_NO_SHOW'
     or (
       c.status not in ('CONFLICT', 'RESOLVED_PAID', 'RESOLVED_UNPAID', 'CANCELLED')
       and not (
         c.status = 'CONFIRMED'
         and coalesce(c.teacher_reported, v_log_presence)
             in ('TEACHER_ABSENCE', 'Falta do Professor')
       )
     )
     or (
       c.status = 'CONFLICT'
       and c.response_editable_until is not null
       and c.response_editable_until > now()
     ) then
    v_resolution_at := coalesce(c.resolved_at, now());

    update public.teacher_turbo_disputes d
       set status = 'DISMISSED',
           verdict = 'CANCELLED',
           resolved_at = v_resolution_at,
           resolved_by = c.resolved_by,
           resolution_note = coalesce(
             nullif(c.admin_resolution, ''),
             case
               when c.status = 'CONFLICT'
                 then 'Aguardando encerramento da janela de correcao'
               when c.status = 'CANCELLED'
                 then 'Confirmacao cancelada'
               else 'Relato sem conflito financeiro reconciliado'
             end
           ),
           updated_at = now()
     where d.confirmation_id = v_canonical_id
       and d.teacher_id = c.teacher_id
       and d.tenant_id = c.tenant_id
       and d.status = 'OPEN'
    returning d.* into v_existing_dispute;

    if found then
      perform public.teacher_turbo_add_event(
        c.teacher_id,
        c.tenant_id,
        'DISPUTE_DISMISSED',
        (v_resolution_at at time zone 'America/Sao_Paulo')::date,
        'attendance_confirmation',
        v_canonical_id,
        c.resolved_by,
        jsonb_build_object('verdict', 'CANCELLED', 'reason', 'not_a_mature_hard_conflict')
      );
    end if;
    return;
  end if;

  perform public.teacher_turbo_ensure_state(c.teacher_id);

  v_suspended_at := coalesce(c.response_editable_until, c.responded_at, now());
  v_effective_on := (v_suspended_at at time zone 'America/Sao_Paulo')::date;
  v_reported_class_date := coalesce(c.class_date, v_effective_on);

  if c.status = 'RESOLVED_PAID' then
    v_dispute_status := 'DISMISSED';
    v_verdict := 'TEACHER_PRESENT';
    v_resolution_at := coalesce(c.resolved_at, now());
  elsif c.status = 'CANCELLED' then
    v_dispute_status := 'DISMISSED';
    v_verdict := 'CANCELLED';
    v_resolution_at := coalesce(c.resolved_at, now());
  elsif c.status = 'RESOLVED_UNPAID'
        or c.teacher_reported in ('TEACHER_ABSENCE', 'Falta do Professor')
        or v_log_presence in ('TEACHER_ABSENCE', 'Falta do Professor') then
    v_dispute_status := 'CONFIRMED_ABSENCE';
    v_verdict := 'TEACHER_ABSENT';
    v_resolution_at := coalesce(c.resolved_at, c.responded_at, now());
  else
    -- The only remaining open path is a mature canonical CONFLICT.
    v_dispute_status := 'OPEN';
    v_verdict := null;
    v_resolution_at := null;
  end if;

  insert into public.teacher_turbo_disputes as d (
    confirmation_id, teacher_id, tenant_id, reported_class_date,
    suspended_at, status, verdict, resolved_at, resolved_by,
    resolution_note, updated_at
  ) values (
    v_canonical_id, c.teacher_id, c.tenant_id, v_reported_class_date,
    v_suspended_at, v_dispute_status, v_verdict, v_resolution_at,
    case when v_dispute_status = 'OPEN' then null else c.resolved_by end,
    case when v_dispute_status = 'OPEN' then null else c.admin_resolution end,
    now()
  )
  on conflict (confirmation_id) do update set
    teacher_id = excluded.teacher_id,
    tenant_id = excluded.tenant_id,
    reported_class_date = excluded.reported_class_date,
    suspended_at = least(d.suspended_at, excluded.suspended_at),
    status = excluded.status,
    verdict = excluded.verdict,
    resolved_at = excluded.resolved_at,
    resolved_by = excluded.resolved_by,
    resolution_note = excluded.resolution_note,
    updated_at = now();

  perform public.teacher_turbo_add_event(
    c.teacher_id, c.tenant_id, 'DISPUTE_REPORTED', v_effective_on,
    'attendance_confirmation', v_canonical_id, null,
    jsonb_build_object(
      'class_date', v_reported_class_date,
      'student_response', c.student_response,
      'teacher_reported', c.teacher_reported,
      'session_key', c.session_key
    )
  );

  if v_dispute_status = 'DISMISSED' then
    perform public.teacher_turbo_add_event(
      c.teacher_id, c.tenant_id, 'DISPUTE_DISMISSED',
      (v_resolution_at at time zone 'America/Sao_Paulo')::date,
      'attendance_confirmation', v_canonical_id, c.resolved_by,
      jsonb_build_object('verdict', v_verdict, 'note', c.admin_resolution)
    );
  elsif v_dispute_status = 'CONFIRMED_ABSENCE' then
    perform public.teacher_turbo_reset(
      c.teacher_id, v_reported_class_date, 'ABSENCE_CONFIRMED',
      'attendance_confirmation', v_canonical_id, c.resolved_by,
      jsonb_build_object('verdict', v_verdict, 'note', c.admin_resolution)
    );
  end if;
end;
$function$;

alter function public.teacher_turbo_sync_attendance_dispute(uuid) owner to postgres;
revoke all on function public.teacher_turbo_sync_attendance_dispute(uuid)
  from public, anon, authenticated;
grant execute on function public.teacher_turbo_sync_attendance_dispute(uuid)
  to service_role;

-- A director decision is financially authoritative, so every row in the
-- logical session must still prove its original occurrence. Historical rows
-- created before session grouping are accepted only as a single, ungrouped
-- member. No current lifecycle requirement is used: a historical dispute must
-- remain resolvable after a student or teacher is offboarded.
create or replace function private.attendance_session_is_consistent(
  p_canonical_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  c public.attendance_confirmations%rowtype;
  member public.attendance_confirmations%rowtype;
  v_member_count integer := 0;
  v_member_time time;
  v_member_phone text;
  v_original_booking_id uuid;
  v_coverage_count integer;
  v_cover_teacher_id uuid;
  v_first_time time;
  v_previous_time time;
  v_participant_key text;
  v_expected_session_key text;
  v_source_matches_snapshot boolean;
begin
  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = p_canonical_id;

  if not found
     or coalesce(c.canonical_confirmation_id, c.id) <> c.id
     or c.tenant_id is null
     or c.teacher_id is null
     or c.class_date is null then
    return false;
  end if;

  perform 1
    from public.profiles teacher
   where teacher.id = c.teacher_id
     and teacher.tenant_id = c.tenant_id
     and teacher.role = 'TEACHER'
   for key share;
  if not found then
    return false;
  end if;

  for member in
    select ac.*
      from public.attendance_confirmations ac
     where coalesce(ac.canonical_confirmation_id, ac.id) = c.id
     order by (
       case
         when pg_catalog.btrim(coalesce(ac.class_time, ''))
              ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
         then pg_catalog.left(pg_catalog.btrim(ac.class_time), 5)::time
       end
     ) nulls last, ac.id
  loop
    v_member_count := v_member_count + 1;

    if member.tenant_id is distinct from c.tenant_id
       or member.teacher_id is distinct from c.teacher_id
       or member.student_id is distinct from c.student_id
       or member.class_date is distinct from c.class_date then
      return false;
    end if;

    -- Current grouped sessions have an immutable shared key and every member
    -- points directly to the canonical row. A legacy NULL key is safe only for
    -- a true singleton, never as an umbrella for additional rows.
    if c.session_key is null then
      if member.id <> c.id
         or member.session_key is not null then
        return false;
      end if;
    elsif member.session_key is distinct from c.session_key
          or member.canonical_confirmation_id is distinct from c.id then
      return false;
    end if;

    v_member_time := case
      when pg_catalog.btrim(coalesce(member.class_time, ''))
           ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
      then pg_catalog.left(pg_catalog.btrim(member.class_time), 5)::time
      else null
    end;
    if v_member_time is null then
      return false;
    end if;

    v_first_time := coalesce(v_first_time, v_member_time);
    if v_previous_time is not null
       and v_member_time - v_previous_time > interval '30 minutes' then
      return false;
    end if;
    v_previous_time := v_member_time;

    if member.student_id is not null then
      perform 1
        from public.profiles student
       where student.id = member.student_id
         and student.tenant_id = member.tenant_id
         and student.role = 'STUDENT'
       for key share;
      if not found then
        return false;
      end if;
    end if;

    -- Prove that the snapshot still identifies a real source owned by the same
    -- school and participant. Date/time/teacher remain the immutable audit
    -- snapshot: booking and reschedule rows are mutable after the lesson.
    if member.source_type = 'booking' then
      if member.student_id is null then
        return false;
      end if;

      select (
        b.teacher_id = member.teacher_id
        and (b.start_date is null or member.class_date >= b.start_date)
        and public.dow_name_to_int(b.day_of_week) =
            extract(dow from member.class_date)::integer
        and case
              when pg_catalog.btrim(coalesce(b.time_slot, ''))
                   ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
              then pg_catalog.left(pg_catalog.btrim(b.time_slot), 5)::time
            end = v_member_time
      )
        into v_source_matches_snapshot
        from public.bookings b
       where b.id::text = member.source_id
         and b.tenant_id = member.tenant_id
         and b.student_id = member.student_id
       for key share;
      if not found then
        return false;
      end if;

      select
        count(*)::integer,
        (array_agg(coverage.cover_teacher_id order by coverage.id))[1]
        into v_coverage_count, v_cover_teacher_id
        from public.class_coverages coverage
       where coverage.booking_id::text = member.source_id
         and coverage.tenant_id = member.tenant_id
         and coverage.student_id = member.student_id
         and coverage.class_date = member.class_date
         and pg_catalog.lower(coalesce(coverage.status, '')) = 'confirmed';

      if v_coverage_count > 1 then
        return false;
      elsif v_coverage_count = 1 then
        if v_cover_teacher_id is distinct from member.teacher_id then
          return false;
        end if;
        perform 1
          from public.class_coverages coverage
         where coverage.booking_id::text = member.source_id
           and coverage.tenant_id = member.tenant_id
           and coverage.cover_teacher_id = v_cover_teacher_id
           and coverage.student_id = member.student_id
           and coverage.class_date = member.class_date
           and pg_catalog.lower(coalesce(coverage.status, '')) = 'confirmed'
           and case
                 when pg_catalog.btrim(coalesce(coverage.class_time, ''))
                      ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                 then pg_catalog.left(
                   pg_catalog.btrim(coverage.class_time),
                   5
                 )::time
               end = v_member_time
         for key share;
        if not found then
          return false;
        end if;
      elsif not coalesce(v_source_matches_snapshot, false)
            and not exists (
              select 1
                from public.class_logs historical_log
               where historical_log.id = member.class_log_id
                 and historical_log.tenant_id = member.tenant_id
                 and historical_log.teacher_id = member.teacher_id
                 and historical_log.student_id = member.student_id
                 and historical_log.class_date = member.class_date
                 and historical_log.start_time = v_member_time
                 and historical_log.booking_id = member.source_id
            ) then
        -- The live booking may legitimately change after class, but a mismatch
        -- then needs an exact immutable class-log proof. Otherwise this could
        -- simply be another booking of the same student.
        return false;
      end if;
    elsif member.source_type = 'reschedule' then
      if member.student_id is null then
        return false;
      end if;

      v_original_booking_id := null;
      select
        reschedule.original_booking_id,
        (
          reschedule.teacher_id = member.teacher_id
          and pg_catalog.btrim(coalesce(reschedule.date, '')) =
              pg_catalog.to_char(member.class_date, 'YYYY-MM-DD')
          and case
                when pg_catalog.btrim(coalesce(reschedule.time, ''))
                     ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
                then pg_catalog.left(
                  pg_catalog.btrim(reschedule.time),
                  5
                )::time
              end = v_member_time
        )
        into v_original_booking_id, v_source_matches_snapshot
        from public.reschedules reschedule
       where reschedule.id::text = member.source_id
         and reschedule.tenant_id = member.tenant_id
         and reschedule.student_id = member.student_id
         and (
           reschedule.original_booking_id is null
           or exists (
             select 1
               from public.bookings original_booking
              where original_booking.id = reschedule.original_booking_id
                and original_booking.tenant_id = reschedule.tenant_id
                and original_booking.student_id = reschedule.student_id
           )
         )
       for key share;
      if not found then
        return false;
      end if;
      if v_original_booking_id is not null then
        perform 1
          from public.bookings original_booking
         where original_booking.id = v_original_booking_id
           and original_booking.tenant_id = member.tenant_id
           and original_booking.student_id = member.student_id
         for key share;
        if not found then
          return false;
        end if;
      end if;
      if not coalesce(v_source_matches_snapshot, false)
         and not exists (
           select 1
             from public.class_logs historical_log
            where historical_log.id = member.class_log_id
              and historical_log.tenant_id = member.tenant_id
              and historical_log.teacher_id = member.teacher_id
              and historical_log.student_id = member.student_id
              and historical_log.class_date = member.class_date
              and historical_log.start_time = v_member_time
              and historical_log.reschedule_id = member.source_id
         ) then
        return false;
      end if;
    elsif member.source_type = 'appointment' then
      v_member_phone := pg_catalog.regexp_replace(
        coalesce(member.student_phone, ''),
        '\\D',
        '',
        'g'
      );
      if v_member_phone = '' then
        return false;
      end if;

      select (
        member.teacher_id in (
          appointment.teacher_id,
          appointment.professor_id
        )
        and pg_catalog.regexp_replace(
              coalesce(appointment.student_phone, ''),
              '\\D',
              '',
              'g'
            ) = v_member_phone
        and (
          (
            (appointment.start_time at time zone 'America/Sao_Paulo')::date =
              member.class_date
            and pg_catalog.date_trunc(
                  'minute',
                  appointment.start_time at time zone 'America/Sao_Paulo'
                )::time = v_member_time
          )
          or (
            (appointment.start_time at time zone 'UTC')::date = member.class_date
            and pg_catalog.date_trunc(
                  'minute',
                  appointment.start_time at time zone 'UTC'
                )::time = v_member_time
          )
        )
      )
        into v_source_matches_snapshot
        from public.appointments appointment
       where appointment.id::text = member.source_id
         and appointment.tenant_id = member.tenant_id
       for key share;
      if not found then
        return false;
      end if;
      if not coalesce(v_source_matches_snapshot, false)
         and not exists (
           select 1
             from public.class_logs historical_log
            where historical_log.id = member.class_log_id
              and historical_log.tenant_id = member.tenant_id
              and historical_log.teacher_id = member.teacher_id
              and historical_log.student_id is not distinct from member.student_id
              and historical_log.class_date = member.class_date
              and historical_log.start_time = v_member_time
              and historical_log.appointment_id = member.source_id
         ) then
        return false;
      end if;
    else
      return false;
    end if;

    if member.class_log_id is not null then
      perform 1
        from public.class_logs cl
       where cl.id = member.class_log_id
         and cl.tenant_id = member.tenant_id
         and cl.teacher_id = member.teacher_id
         and cl.student_id is not distinct from member.student_id
         and cl.class_date is not distinct from member.class_date
         and cl.start_time = v_member_time
         and (
           (member.source_type = 'booking' and cl.booking_id = member.source_id)
           or (
             member.source_type = 'reschedule'
             and cl.reschedule_id = member.source_id
           )
           or (
             member.source_type = 'appointment'
             and cl.appointment_id = member.source_id
           )
           or (
             cl.booking_id is null
             and cl.reschedule_id is null
             and cl.appointment_id is null
             and member.student_id is not null
             and cl.start_time = v_member_time
           )
         )
       for update;
      if not found then
        return false;
      end if;
    end if;
  end loop;

  if c.session_key is not null then
    v_participant_key := coalesce(
      c.student_id::text,
      nullif(
        pg_catalog.regexp_replace(
          coalesce(c.student_phone, ''),
          '\\D',
          '',
          'g'
        ),
        ''
      ),
      c.id::text
    );
    v_expected_session_key := 'attendance:' || pg_catalog.md5(
      coalesce(c.tenant_id, '-') || '|' ||
      coalesce(c.teacher_id::text, '-') || '|' ||
      v_participant_key || '|' ||
      c.class_date::text || '|' ||
      coalesce(v_first_time::text, c.id::text)
    );
    if c.session_key is distinct from v_expected_session_key then
      return false;
    end if;
  end if;

  return v_member_count > 0;
end;
$function$;

alter function private.attendance_session_is_consistent(uuid)
  owner to postgres;
revoke all on function private.attendance_session_is_consistent(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.resolve_attendance_conflict_v2(
  p_confirmation_id uuid,
  p_verdict text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  requested public.attendance_confirmations%rowtype;
  c public.attendance_confirmations%rowtype;
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant text;
  v_jwt_role text;
  v_canonical_id uuid;
  v_verdict text := upper(trim(coalesce(p_verdict, '')));
  v_pay boolean;
  v_final text;
  v_turbo jsonb;
  r record;
begin
  v_jwt_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    ''
  );

  if v_jwt_role = 'service_role' then
    v_role := 'SUPER_ADMIN';
  else
    v_role := public._my_role();
    v_tenant := public._my_tenant_id();
  end if;

  if not coalesce(v_role in ('SCHOOL_ADMIN', 'SUPER_ADMIN'), false) then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  select ac.*
    into requested
    from public.attendance_confirmations ac
   where ac.id = p_confirmation_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;

  v_canonical_id := coalesce(requested.canonical_confirmation_id, requested.id);
  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = v_canonical_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;

  perform 1
    from public.attendance_confirmations ac
   where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
   order by ac.id
   for update;

  if v_role = 'SCHOOL_ADMIN' and c.tenant_id is distinct from v_tenant then
    return jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  if v_verdict not in ('TEACHER_PRESENT', 'TEACHER_ABSENT', 'PAY', 'DO_NOT_PAY') then
    return jsonb_build_object('ok', false, 'error', 'veredito_invalido');
  end if;

  if c.status in ('RESOLVED_PAID', 'RESOLVED_UNPAID') then
    return jsonb_build_object('ok', true, 'already', true, 'status', c.status);
  end if;

  -- The director cannot make a final decision while the UI still promises the
  -- student that the answer is correctable.
  if c.response_editable_until is not null
     and c.response_editable_until > now() then
    return jsonb_build_object(
      'ok', false,
      'error', 'aguardando_janela_correcao',
      'editable_until', c.response_editable_until
    );
  end if;

  if c.teacher_id is null
     or c.tenant_id is null
     or not exists (
       select 1
         from public.profiles p
        where p.id = c.teacher_id
          and p.role = 'TEACHER'
          and p.tenant_id = c.tenant_id
     ) then
    return jsonb_build_object('ok', false, 'error', 'dados_inconsistentes');
  end if;

  -- A pending/light audit is not a financial dispute and therefore cannot be
  -- finalized by an administrator. Both resolvable states belong exclusively
  -- to the explicit teacher-no-show flow.
  if not coalesce(c.status in ('AWAITING_TEACHER', 'CONFLICT'), false) then
    return jsonb_build_object(
      'ok', false,
      'error', 'estado_invalido',
      'status', c.status
    );
  end if;

  if c.student_response is distinct from 'TEACHER_NO_SHOW' then
    return jsonb_build_object(
      'ok', false,
      'error', 'resposta_incompativel',
      'student_response', c.student_response
    );
  end if;

  -- This is the last gate before the authoritative multi-row UPDATE. It proves
  -- every source, participant, time, class log and grouping key without
  -- trusting browser-supplied or historically corrupted links.
  if not private.attendance_session_is_consistent(v_canonical_id) then
    return jsonb_build_object('ok', false, 'error', 'dados_inconsistentes');
  end if;

  -- PAY/DO_NOT_PAY remains an alias only after the same TEACHER_NO_SHOW guard,
  -- so an old client cannot turn an attendance mismatch into a penalty.
  if v_verdict in ('PAY', 'DO_NOT_PAY') then
    v_verdict := case when v_verdict = 'PAY'
                      then 'TEACHER_PRESENT'
                      else 'TEACHER_ABSENT' end;
  end if;

  v_pay := v_verdict in ('TEACHER_PRESENT', 'PAY');
  v_final := case when v_pay then 'RESOLVED_PAID' else 'RESOLVED_UNPAID' end;

  update public.attendance_confirmations ac
     set status = v_final,
         admin_resolution = nullif(left(coalesce(p_note, ''), 2000), ''),
         resolution_verdict = v_verdict,
         resolved_by = v_uid,
         resolved_at = now()
   where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id;

  perform private.apply_final_attendance_resolution(v_canonical_id);

  -- The scheduled alert has not left during the correction window. A final
  -- director decision makes it obsolete regardless of the verdict.
  update public.notification_queue nq
     set status = 'skipped',
         updated_at = now(),
         last_error = 'attendance_conflict_resolved_before_send'
   where nq.notification_kind = 'CONFLICT_TEACHER_ALERT'
     and nq.status = 'pending'
     and nq.source_id in (
       select ac.id
         from public.attendance_confirmations ac
        where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
     );

  for r in
    select ac.id
      from public.attendance_confirmations ac
     where coalesce(ac.canonical_confirmation_id, ac.id) = v_canonical_id
  loop
    perform public.teacher_turbo_sync_attendance_dispute(r.id);
  end loop;

  v_turbo := public.teacher_turbo_status(c.teacher_id);

  return jsonb_build_object(
    'ok', true,
    'status', v_final,
    'verdict', v_verdict,
    'session_key', c.session_key,
    'turbo_status', v_turbo->>'status',
    'turbo_active', coalesce((v_turbo->>'active')::boolean, false),
    'turbo_action', case
      when c.student_response <> 'TEACHER_NO_SHOW' then 'NONE'
      when not v_pay then 'RESET'
      when v_turbo->>'status' = 'SUSPENDED' then 'SUSPENSION_REMAINS'
      when coalesce((v_turbo->>'active')::boolean, false) then 'RESTORED'
      else 'DISPUTE_CLEARED'
    end
  );
end;
$function$;

create or replace function public.resolve_attendance_conflict(
  p_confirmation_id uuid,
  p_pay boolean,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_response text;
  v_verdict text;
begin
  if p_pay is null then
    return jsonb_build_object('ok', false, 'error', 'p_pay_obrigatorio');
  end if;

  select canonical.student_response
    into v_response
    from public.attendance_confirmations requested
    join public.attendance_confirmations canonical
      on canonical.id = coalesce(
        requested.canonical_confirmation_id,
        requested.id
      )
   where requested.id = p_confirmation_id;

  v_verdict := case
    when v_response = 'TEACHER_NO_SHOW' and p_pay then 'TEACHER_PRESENT'
    when v_response = 'TEACHER_NO_SHOW' and not p_pay then 'TEACHER_ABSENT'
    when p_pay then 'PAY'
    else 'DO_NOT_PAY'
  end;

  return public.resolve_attendance_conflict_v2(
    p_confirmation_id,
    v_verdict,
    p_note
  );
end;
$function$;

alter function public.resolve_attendance_conflict_v2(uuid, text, text)
  owner to postgres;
alter function public.resolve_attendance_conflict(uuid, boolean, text)
  owner to postgres;
revoke all on function public.resolve_attendance_conflict_v2(uuid, text, text)
  from public, anon;
revoke all on function public.resolve_attendance_conflict(uuid, boolean, text)
  from public, anon;
grant execute on function public.resolve_attendance_conflict_v2(uuid, text, text)
  to authenticated, service_role;
grant execute on function public.resolve_attendance_conflict(uuid, boolean, text)
  to authenticated, service_role;

-- Enforce final attendance decisions even if a privileged path inserts or
-- updates the financial log later. This runs after the occurrence-normalizing
-- trigger (trigger names are ordered alphabetically).
create or replace function private.enforce_final_attendance_resolution_on_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_verdict text;
  v_final text;
begin
  select ac.resolution_verdict, ac.status
    into v_verdict, v_final
    from public.attendance_confirmations ac
   where ac.tenant_id = new.tenant_id
     and ac.teacher_id = new.teacher_id
     and ac.student_id is not distinct from new.student_id
     and ac.class_date = new.class_date
     and ac.status in ('RESOLVED_PAID', 'RESOLVED_UNPAID')
     and ac.student_response = 'TEACHER_NO_SHOW'
     and (
       ac.class_log_id = new.id
       or (ac.source_type = 'booking' and ac.source_id = new.booking_id)
       or (ac.source_type = 'reschedule' and ac.source_id = new.reschedule_id)
       or (ac.source_type = 'appointment' and ac.source_id = new.appointment_id)
     )
   order by ac.resolved_at desc nulls last, ac.id
   limit 1;

  if not found then
    return new;
  end if;

  if v_verdict = 'TEACHER_ABSENT' then
    new.presence := 'TEACHER_ABSENCE';
    new.teacher_verdict := 'TEACHER_ABSENT';
  elsif v_verdict = 'TEACHER_PRESENT' then
    if new.presence in ('TEACHER_ABSENCE', 'Falta do Professor') then
      new.presence := 'STUDENT_ABSENCE';
    end if;
    new.teacher_verdict := 'TEACHER_PRESENT';
  end if;

  new.verification_status := v_final;
  new.payment_hold := false;
  return new;
end;
$function$;

alter function private.enforce_final_attendance_resolution_on_log()
  owner to postgres;
revoke all on function private.enforce_final_attendance_resolution_on_log()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_zz_attendance_final_resolution_guard
  on public.class_logs;
create trigger trg_zz_attendance_final_resolution_guard
before insert or update of
  presence, booking_id, reschedule_id, appointment_id,
  class_date, teacher_id, student_id
on public.class_logs
for each row
execute function private.enforce_final_attendance_resolution_on_log();

-- The legacy class-log trigger now resolves the whole logical session and uses
-- tenant/teacher/student identity, not only the globally-looking source text.
create or replace function public.on_class_log_reconcile()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_conf_id uuid;
  v_src text;
  v_stype text;
begin
  if new.booking_id is not null then
    v_src := new.booking_id;
    v_stype := 'booking';
  elsif new.reschedule_id is not null then
    v_src := new.reschedule_id;
    v_stype := 'reschedule';
  elsif new.appointment_id is not null then
    v_src := new.appointment_id;
    v_stype := 'appointment';
  else
    return new;
  end if;

  select ac.id
    into v_conf_id
    from public.attendance_confirmations ac
   where ac.source_id = v_src
     and ac.source_type = v_stype
     and ac.class_date = coalesce(new.class_date, new.date)
     and ac.tenant_id = new.tenant_id
     and ac.teacher_id = new.teacher_id
     and ac.student_id is not distinct from new.student_id
   order by ac.created_at desc, ac.id
   limit 1;

  if v_conf_id is not null then
    perform public.reconcile_attendance_confirmation(v_conf_id);
  end if;
  return new;
end;
$function$;

alter function public.on_class_log_reconcile() owner to postgres;
revoke all on function public.on_class_log_reconcile()
  from public, anon, authenticated;

-- Suppress the unkeyed duplicate that the legacy teacher logging RPC would
-- otherwise create immediately after a late log whose final session-level
-- make-up already exists.
create or replace function private.prevent_duplicate_final_attendance_reschedule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_session_key text;
begin
  if new.fault_type <> 'TEACHER'
     or new.attendance_session_key is not null
     or new.original_booking_id is null then
    return new;
  end if;

  select ac.session_key
    into v_session_key
    from public.attendance_confirmations ac
    join public.class_logs cl
      on cl.tenant_id = ac.tenant_id
     and cl.teacher_id = ac.teacher_id
     and cl.student_id is not distinct from ac.student_id
     and cl.class_date = ac.class_date
     and (
       ac.class_log_id = cl.id
       or (ac.source_type = 'booking' and ac.source_id = cl.booking_id)
       or (ac.source_type = 'reschedule' and ac.source_id = cl.reschedule_id)
     )
   where ac.status = 'RESOLVED_UNPAID'
     and ac.resolution_verdict = 'TEACHER_ABSENT'
     and ac.tenant_id = new.tenant_id
     and ac.teacher_id = new.teacher_id
     and ac.student_id is not distinct from new.student_id
     and (
       (ac.source_type = 'booking' and ac.source_id = new.original_booking_id::text)
       or (
         ac.source_type = 'reschedule'
         and exists (
           select 1
             from public.reschedules source_reschedule
            where source_reschedule.id::text = ac.source_id
              and source_reschedule.original_booking_id = new.original_booking_id
         )
       )
     )
     and cl.created_at >= now() - interval '10 minutes'
   order by cl.created_at desc, ac.id
   limit 1;

  if v_session_key is not null and exists (
    select 1
      from public.reschedules r
     where r.fault_type = 'TEACHER'
       and r.attendance_session_key = v_session_key
  ) then
    return null;
  end if;

  return new;
end;
$function$;

alter function private.prevent_duplicate_final_attendance_reschedule()
  owner to postgres;
revoke all on function private.prevent_duplicate_final_attendance_reschedule()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_attendance_final_reschedule_dedupe
  on public.reschedules;
create trigger trg_attendance_final_reschedule_dedupe
before insert on public.reschedules
for each row
execute function private.prevent_duplicate_final_attendance_reschedule();

-- Reconcile existing open answers with the new matrix. This releases any old
-- light-mismatch hold and cancels its unsent alert; final director decisions
-- remain immutable.
do $reconcile_existing$
declare
  r record;
begin
  for r in
    select distinct coalesce(ac.canonical_confirmation_id, ac.id) as id
      from public.attendance_confirmations ac
     where ac.student_response is not null
       and ac.status not in ('RESOLVED_PAID', 'RESOLVED_UNPAID', 'CANCELLED')
     order by 1
  loop
    perform public.reconcile_attendance_confirmation(r.id);
  end loop;
end;
$reconcile_existing$;

-- attendance_confirmations is no longer a browser-readable token table.
-- School admins retain canonical, tenant-scoped operational fields only;
-- teachers/students use the purpose-built RPC projections above.
alter table public.attendance_confirmations enable row level security;

do $drop_attendance_policies$
declare
  p record;
begin
  for p in
    select policyname
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'attendance_confirmations'
  loop
    execute format(
      'drop policy if exists %I on public.attendance_confirmations',
      p.policyname
    );
  end loop;
end;
$drop_attendance_policies$;

create policy attendance_confirmations_admin_canonical_read
on public.attendance_confirmations
for select
to authenticated
using (
  coalesce(canonical_confirmation_id, id) = id
  and (
    (select public._my_role()) = 'SUPER_ADMIN'
    or (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      and tenant_id = (select public._my_tenant_id())
    )
  )
);

revoke all on table public.attendance_confirmations
  from public, anon, authenticated;

grant select (
  id,
  tenant_id,
  class_log_id,
  teacher_id,
  student_id,
  student_name,
  class_date,
  class_time,
  teacher_name,
  teacher_reported,
  student_response,
  responded_at,
  sent_at,
  send_attempts,
  status,
  admin_resolution,
  resolved_by,
  resolved_at,
  created_at,
  source_id,
  source_type,
  student_rating,
  token_expires_at,
  response_editable_until,
  response_updated_at,
  session_key,
  canonical_confirmation_id,
  session_end_at,
  delivery_status,
  resolution_verdict
) on public.attendance_confirmations to authenticated;

grant all on table public.attendance_confirmations to service_role;

-- class_logs stays readable under its existing tenant/student/teacher SELECT
-- policy, but every browser write must go through a validated RPC.
do $drop_class_log_write_policies$
declare
  p record;
begin
  for p in
    select policyname
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'class_logs'
       and cmd <> 'SELECT'
  loop
    execute format('drop policy if exists %I on public.class_logs', p.policyname);
  end loop;
end;
$drop_class_log_write_policies$;

revoke all on table public.class_logs from public, anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.class_logs from authenticated;
grant select on table public.class_logs to authenticated;
grant all on table public.class_logs to service_role;

comment on policy attendance_confirmations_admin_canonical_read
on public.attendance_confirmations is
  'Only tenant-scoped school admins (or super admins) see canonical operational rows. Token, phone and delivery claim metadata have no client SELECT grant.';

notify pgrst, 'reload schema';
