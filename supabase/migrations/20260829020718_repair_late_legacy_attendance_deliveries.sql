-- Repair attempts produced by the legacy Edge sender after the atomic delivery
-- migration was committed but before the new Edge bundle became active.
--
-- The legacy worker increments send_attempts without creating a claim. Its
-- provider outcome is therefore unknowable: retrying can duplicate a WhatsApp
-- message that was already accepted. Modern retries always have
-- delivery_claimed_at populated by claim_attendance_confirmation_deliveries.

-- Keep the anti-ghost sweep scoped to deliveries that have never reached an
-- uncertain provider outcome. Without this guard it can overwrite AMBIGUOUS
-- rows as CANCELLED merely because the source occurrence is no longer in the
-- rolling upcoming_classes view, making the data repair below non-durable.
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

  -- Transactional anti-ghost check. A missing occurrence still cancels the
  -- business audit, but AMBIGUOUS means the provider outcome is unknown and its
  -- delivery state/error must remain terminal. PROCESSING is left untouched.
  update public.attendance_confirmations ac
     set status = 'CANCELLED',
         delivery_status = case
           when ac.delivery_status = 'PENDING' then 'CANCELLED'
           else ac.delivery_status
         end,
         last_delivery_error = case
           when ac.delivery_status = 'PENDING' then 'occurrence_not_found'
           else ac.last_delivery_error
         end
   where ac.class_date between v_today - 1 and v_today
     and ac.sent_at is null
     and ac.student_response is null
     and ac.status = 'PENDING'
     and ac.delivery_status in ('PENDING', 'AMBIGUOUS')
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

alter function public.claim_attendance_confirmation_deliveries(integer)
  owner to postgres;
revoke all on function public.claim_attendance_confirmation_deliveries(integer)
  from public, anon, authenticated;
grant execute on function public.claim_attendance_confirmation_deliveries(integer)
  to service_role;

do $repair_late_legacy_attendance_deliveries$
declare
  v_affected_dates date[];
  v_class_date date;
begin
  with repaired as (
    update public.attendance_confirmations ac
       set delivery_status = 'AMBIGUOUS',
           last_delivery_error = 'legacy_delivery_attempt_outcome_unknown',
           delivery_claim_expires_at = null
     where ac.sent_at is null
       and ac.send_attempts > 0
       and ac.delivery_claimed_at is null
       and (
         ac.delivery_status is distinct from 'AMBIGUOUS'
         or ac.last_delivery_error is distinct from
              'legacy_delivery_attempt_outcome_unknown'
       )
    returning ac.class_date
  )
  select pg_catalog.array_agg(distinct repaired.class_date)
    into v_affected_dates
    from repaired
   where repaired.class_date is not null;

  foreach v_class_date in array coalesce(v_affected_dates, array[]::date[])
  loop
    -- One uncertain member makes the whole unsent logical session terminal.
    -- The canonicalization helper also covers rows inserted without session
    -- metadata by the legacy Edge bundle.
    perform private.refresh_attendance_confirmation_sessions(
      v_class_date,
      v_class_date
    );
  end loop;
end;
$repair_late_legacy_attendance_deliveries$;
