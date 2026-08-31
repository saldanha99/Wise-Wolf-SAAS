begin;

-- Harden the last mile between a completed trial and enrollment. Existing
-- opportunities keep their historical behavior; newly created opportunities
-- require pedagogical feedback unless their producer explicitly opts out.
do $dependencies$
begin
  if pg_catalog.to_regclass('public.opportunities') is null
     or pg_catalog.to_regclass('public.offers') is null
     or pg_catalog.to_regclass('public.enrollment_links') is null
     or pg_catalog.to_regclass('public.notification_queue') is null
     or pg_catalog.to_regclass('private.vendor_trial_teacher_requests') is null
     or pg_catalog.to_regprocedure(
       'public.create_enrollment_offer(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.update_trial_outcome_secure(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.complete_enrollment_offer(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.confirm_vendor_trial_interest_atomic(text,uuid,boolean)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.claim_opportunity_atomic(uuid,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.active_tenant_id(uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.tenant_is_operational(text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.normalize_notification_phone(text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.normalize_notification_destination(text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.notification_phones_same_recipient(text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.safe_notification_text(text,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.secure_trial_portal_origin(text)'
     ) is null then
    raise exception 'trial_conversion_lifecycle_dependencies_are_required';
  end if;
end
$dependencies$;

alter table public.opportunities
  add column if not exists feedback_required boolean,
  add column if not exists is_test_fixture boolean;

-- Compatibility backfill: historical DONE rows were allowed to proceed without
-- a structured feedback record. Only future opportunities opt into the guard by
-- default. Existing test students remain suppressed when they can be identified
-- authoritatively through profiles.is_test_account.
update public.opportunities as opportunity
set feedback_required = false
where opportunity.feedback_required is null;

update public.opportunities as opportunity
set is_test_fixture = coalesce((
  select profile.is_test_account
  from public.profiles as profile
  where profile.id = opportunity.student_id
), false)
where opportunity.is_test_fixture is null;

alter table public.opportunities
  alter column feedback_required set default true,
  alter column feedback_required set not null,
  alter column is_test_fixture set default false,
  alter column is_test_fixture set not null;

-- Repair legacy PENDING enrollment links from authoritative offer evidence.
-- Consumption is stronger evidence than expiry/revocation and therefore runs
-- first; all remaining unusable links converge to EXPIRED idempotently.
update public.enrollment_links as link
set status = 'USED',
    used_at = coalesce(link.used_at, offer.consumed_at, pg_catalog.now())
from public.offers as offer
where link.offer_id = offer.id
  and link.status = 'PENDING'
  and link.purpose = 'ENROLLMENT'
  and offer.kind = 'ENROLLMENT'
  and offer.tenant_id = link.tenant_id
  and offer.opportunity_id is not distinct from link.opportunity_id
  and offer.consumed_at is not null;

update public.enrollment_links as link
set status = 'EXPIRED'
where link.status = 'PENDING'
  and link.purpose = 'ENROLLMENT'
  and (
    link.expires_at <= pg_catalog.now()
    or link.offer_id is null
    or not exists (
      select 1
      from public.offers as offer
      where offer.id = link.offer_id
        and offer.kind = 'ENROLLMENT'
        and offer.tenant_id = link.tenant_id
        and offer.opportunity_id is not distinct from link.opportunity_id
        and offer.revoked_at is null
        and offer.consumed_at is null
        and offer.expires_at > pg_catalog.now()
    )
  );

create index if not exists opportunities_pending_trial_feedback_idx
  on public.opportunities (tenant_id, winner_teacher_id, trial_appointment_id)
  where kind = 'TRIAL'
    and status = 'CLAIMED'
    and conversion_status = 'OPEN'
    and feedback_required is true;

-- Every lifecycle writer uses the same order. Locks are deliberately acquired
-- even for rows the caller will only read so a concurrent replacement, loss or
-- completion cannot pass between validation and mutation.
create or replace function private.lock_trial_conversion_graph(
  p_opportunity_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform opportunity.id
  from public.opportunities as opportunity
  where opportunity.id = p_opportunity_id
  for update;

  if not found then
    raise exception 'trial_opportunity_not_found' using errcode = 'P0002';
  end if;

  perform offer.id
  from public.offers as offer
  where offer.opportunity_id = p_opportunity_id
  order by offer.id
  for update;

  perform link.id
  from public.enrollment_links as link
  where link.opportunity_id = p_opportunity_id
  order by link.id
  for update;

  perform request.id
  from private.vendor_trial_teacher_requests as request
  where request.opportunity_id = p_opportunity_id
  order by request.id
  for update;
end;
$function$;

alter function private.lock_trial_conversion_graph(uuid) owner to postgres;
revoke all on function private.lock_trial_conversion_graph(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.lock_trial_conversion_graph(uuid)
  to postgres;

create or replace function private.trial_feedback_is_complete(
  p_opportunity_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.opportunities as opportunity
    join public.trial_feedback as feedback
      on feedback.opportunity_id = opportunity.id
     and feedback.tenant_id = opportunity.tenant_id
     and feedback.booking_id = opportunity.trial_appointment_id
     and feedback.teacher_id = coalesce(
       opportunity.winner_teacher_id,
       opportunity.professor_id
     )
    where opportunity.id = p_opportunity_id
      and opportunity.trial_appointment_id is not null
  );
$function$;

alter function private.trial_feedback_is_complete(uuid) owner to postgres;
revoke all on function private.trial_feedback_is_complete(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.trial_feedback_is_complete(uuid)
  to postgres;

-- The teacher dashboard cannot read opportunities directly under the hardened
-- RLS. This projection exposes only the minimum pedagogical work queue.
create or replace function public.get_teacher_pending_trial_feedback_secure()
returns table (
  opportunity_id uuid,
  appointment_id uuid,
  student_name text,
  completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := (select auth.uid());
  v_tenant_id text := private.active_tenant_id(v_actor_id);
begin
  if v_actor_id is null
     or v_tenant_id is null
     or not private.tenant_is_operational(v_tenant_id)
     or not exists (
       select 1
       from public.profiles as profile
       join public.tenant_memberships as membership
         on membership.user_id = profile.id
        and membership.tenant_id = v_tenant_id
        and membership.role = 'TEACHER'
        and membership.status = 'ACTIVE'
       where profile.id = v_actor_id
         and profile.tenant_id = v_tenant_id
         and profile.role = 'TEACHER'
         and lower(pg_catalog.btrim(coalesce(
           profile.lifecycle_status,
           ''
         ))) = 'active'
     ) then
    return;
  end if;

  return query
  select
    opportunity.id,
    appointment.id,
    pg_catalog.left(
      pg_catalog.regexp_replace(
        coalesce(opportunity.student_name, ''),
        '[[:cntrl:]<>*_`~]+',
        ' ',
        'g'
      ),
      160
    ),
    class_log.created_at
  from public.opportunities as opportunity
  join public.appointments as appointment
    on appointment.id = opportunity.trial_appointment_id
   and appointment.tenant_id = opportunity.tenant_id
   and coalesce(appointment.teacher_id, appointment.professor_id) = v_actor_id
   and (
     appointment.teacher_id is null
     or appointment.teacher_id = v_actor_id
   )
   and (
     appointment.professor_id is null
     or appointment.professor_id = v_actor_id
   )
   and lower(coalesce(appointment.type, '')) = 'experimental'
  join lateral (
    select log.created_at
    from public.class_logs as log
    where log.appointment_id = appointment.id::text
      and log.tenant_id = v_tenant_id
      and log.teacher_id = v_actor_id
      and log.presence = 'COMPLETED'
    order by log.created_at desc, log.id desc
    limit 1
  ) as class_log on true
  where opportunity.tenant_id = v_tenant_id
    and opportunity.kind = 'TRIAL'
    and opportunity.status = 'CLAIMED'
    and opportunity.conversion_status = 'OPEN'
    and opportunity.feedback_required is true
    and opportunity.is_test_fixture is false
    and coalesce(
      opportunity.winner_teacher_id,
      opportunity.professor_id
    ) = v_actor_id
    and (
      opportunity.winner_teacher_id is null
      or opportunity.winner_teacher_id = v_actor_id
    )
    and (
      opportunity.professor_id is null
      or opportunity.professor_id = v_actor_id
    )
    and not exists (
      select 1
      from public.trial_feedback as feedback
      where feedback.opportunity_id = opportunity.id
    )
  order by class_log.created_at, opportunity.id;
end;
$function$;

alter function public.get_teacher_pending_trial_feedback_secure()
  owner to postgres;
revoke all on function public.get_teacher_pending_trial_feedback_secure()
  from public, anon, authenticated, service_role;
grant execute on function public.get_teacher_pending_trial_feedback_secure()
  to authenticated;

-- Wrap offer creation instead of copying the long pricing/schedule pipeline.
-- The existing implementation remains the single source of validation and
-- persistence after this lifecycle gate has locked the graph.
do $wrap_create_offer$
begin
  if pg_catalog.to_regprocedure(
    'public.create_enrollment_offer_pre_trial_lifecycle_impl(jsonb)'
  ) is null then
    alter function public.create_enrollment_offer(jsonb)
      rename to create_enrollment_offer_pre_trial_lifecycle_impl;
  end if;
end
$wrap_create_offer$;

revoke all on function
  public.create_enrollment_offer_pre_trial_lifecycle_impl(jsonb)
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
  v_opportunity_id uuid;
  v_opportunity public.opportunities%rowtype;
  v_offer_id uuid;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_payload, '{}'::jsonb))
       is distinct from 'object' then
    return public.create_enrollment_offer_pre_trial_lifecycle_impl(p_payload);
  end if;

  begin
    v_opportunity_id := nullif(
      pg_catalog.btrim(coalesce(p_payload ->> 'opportunityId', '')),
      ''
    )::uuid;
  exception when invalid_text_representation then
    return public.create_enrollment_offer_pre_trial_lifecycle_impl(p_payload);
  end;

  if v_opportunity_id is null then
    return public.create_enrollment_offer_pre_trial_lifecycle_impl(p_payload);
  end if;
  if v_actor_id is null or v_tenant_id is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  perform private.lock_trial_conversion_graph(v_opportunity_id);
  select opportunity.*
  into v_opportunity
  from public.opportunities as opportunity
  where opportunity.id = v_opportunity_id;

  if v_opportunity.tenant_id is distinct from v_tenant_id
     or v_opportunity.kind is distinct from 'TRIAL'
     or v_opportunity.status is distinct from 'CLAIMED'
     or v_opportunity.conversion_status is distinct from 'OPEN'
     or v_opportunity.trial_status is distinct from 'DONE' then
    raise exception 'trial_opportunity_not_eligible'
      using errcode = '23514';
  end if;
  if v_opportunity.feedback_required
     and not private.trial_feedback_is_complete(v_opportunity_id) then
    raise exception 'trial_feedback_required' using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.offers as offer
    where offer.opportunity_id = v_opportunity_id
      and offer.kind = 'ENROLLMENT'
      and offer.revoked_at is null
      and offer.consumed_at is null
      and (
        offer.processing_by is not null
        or offer.processing_state <> 'NOT_STARTED'
      )
  ) or exists (
    select 1
    from public.enrollment_links as link
    where link.opportunity_id = v_opportunity_id
      and link.status = 'PROCESSING'
  ) then
    raise exception 'enrollment_in_progress' using errcode = '55000';
  end if;

  v_offer_id := public.create_enrollment_offer_pre_trial_lifecycle_impl(
    p_payload
  );
  if not exists (
    select 1
    from public.offers as offer
    where offer.id = v_offer_id
      and offer.opportunity_id = v_opportunity_id
      and offer.tenant_id = v_tenant_id
      and offer.kind = 'ENROLLMENT'
      and offer.revoked_at is null
  ) then
    raise exception 'enrollment_offer_scope_mismatch' using errcode = '23514';
  end if;
  return v_offer_id;
end;
$function$;

alter function public.create_enrollment_offer_pre_trial_lifecycle_impl(jsonb)
  owner to postgres;
alter function public.create_enrollment_offer(jsonb) owner to postgres;
revoke all on function public.create_enrollment_offer(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_enrollment_offer(jsonb)
  to authenticated;

-- MARK_LOST converges every unused enrollment artifact in the same transaction.
-- A started enrollment wins: the director must finish or explicitly unwind it
-- instead of revoking a link while the student/payment pipeline is running.
do $wrap_trial_outcome$
begin
  if pg_catalog.to_regprocedure(
    'public.update_trial_outcome_secure_pre_trial_lifecycle_impl(jsonb)'
  ) is null then
    alter function public.update_trial_outcome_secure(jsonb)
      rename to update_trial_outcome_secure_pre_trial_lifecycle_impl;
  end if;
end
$wrap_trial_outcome$;

revoke all on function
  public.update_trial_outcome_secure_pre_trial_lifecycle_impl(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.update_trial_outcome_secure(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_tenant_id text;
  v_actor_role text;
  v_opportunity_id uuid;
  v_result jsonb;
begin
  if pg_catalog.upper(pg_catalog.btrim(coalesce(
    p_payload ->> 'action',
    ''
  ))) <> 'MARK_LOST' then
    return public.update_trial_outcome_secure_pre_trial_lifecycle_impl(
      p_payload
    );
  end if;

  begin
    v_opportunity_id := (p_payload ->> 'opportunityId')::uuid;
  exception when invalid_text_representation or null_value_not_allowed then
    return public.update_trial_outcome_secure_pre_trial_lifecycle_impl(
      p_payload
    );
  end;
  if v_opportunity_id is null then
    return public.update_trial_outcome_secure_pre_trial_lifecycle_impl(
      p_payload
    );
  end if;

  select actor.actor_id, actor.tenant_id, actor.actor_role
  into v_actor_id, v_tenant_id, v_actor_role
  from private.secure_trial_actor_context() as actor;
  if v_actor_id is null
     or v_actor_role not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    return public.update_trial_outcome_secure_pre_trial_lifecycle_impl(
      p_payload
    );
  end if;

  perform private.lock_trial_conversion_graph(v_opportunity_id);
  if not exists (
    select 1
    from public.opportunities as opportunity
    where opportunity.id = v_opportunity_id
      and opportunity.tenant_id = v_tenant_id
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'opportunity_not_found'
    );
  end if;

  if exists (
    select 1
    from public.offers as offer
    where offer.opportunity_id = v_opportunity_id
      and offer.kind = 'ENROLLMENT'
      and offer.revoked_at is null
      and offer.consumed_at is null
      and (
        offer.processing_by is not null
        or offer.processing_state <> 'NOT_STARTED'
      )
  ) or exists (
    select 1
    from public.enrollment_links as link
    where link.opportunity_id = v_opportunity_id
      and link.status = 'PROCESSING'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'enrollment_in_progress'
    );
  end if;

  v_result := public.update_trial_outcome_secure_pre_trial_lifecycle_impl(
    p_payload
  );
  if coalesce((v_result ->> 'ok')::boolean, false) is not true then
    return v_result;
  end if;

  -- The wrapped command owns the opportunity lock and must have persisted LOST
  -- before dependent artifacts are invalidated.
  if not exists (
    select 1
    from public.opportunities as opportunity
    where opportunity.id = v_opportunity_id
      and opportunity.tenant_id = v_tenant_id
      and opportunity.conversion_status = 'LOST'
  ) then
    raise exception 'trial_loss_state_not_persisted' using errcode = '40001';
  end if;

  update public.offers as offer
  set revoked_at = coalesce(offer.revoked_at, pg_catalog.now()),
      revoked_by = coalesce(offer.revoked_by, v_actor_id)
  where offer.opportunity_id = v_opportunity_id
    and offer.kind = 'ENROLLMENT'
    and offer.revoked_at is null
    and offer.consumed_at is null
    and offer.processing_by is null
    and offer.processing_state = 'NOT_STARTED';

  update public.enrollment_links as link
  set status = 'EXPIRED'
  where link.opportunity_id = v_opportunity_id
    and link.status = 'PENDING';

  update private.vendor_trial_teacher_requests as request
  set status = 'CANCELED',
      updated_at = pg_catalog.now()
  where request.opportunity_id = v_opportunity_id
    and request.status in ('AWAITING_STUDENT', 'AWAITING_TEACHER');

  return v_result;
end;
$function$;

alter function
  public.update_trial_outcome_secure_pre_trial_lifecycle_impl(jsonb)
  owner to postgres;
alter function public.update_trial_outcome_secure(jsonb) owner to postgres;
revoke all on function public.update_trial_outcome_secure(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_trial_outcome_secure(jsonb)
  to authenticated;

-- Completion takes the same graph lock and rechecks OPEN/feedback immediately
-- before the existing financial/schedule completion implementation marks WON.
do $wrap_complete_offer$
begin
  if pg_catalog.to_regprocedure(
    'public.complete_enrollment_offer_pre_trial_lifecycle_impl(uuid,uuid)'
  ) is null then
    alter function public.complete_enrollment_offer(uuid,uuid)
      rename to complete_enrollment_offer_pre_trial_lifecycle_impl;
  end if;
end
$wrap_complete_offer$;

revoke all on function
  public.complete_enrollment_offer_pre_trial_lifecycle_impl(uuid,uuid)
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
  v_opportunity_id uuid;
  v_opportunity public.opportunities%rowtype;
  v_offer public.offers%rowtype;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'success', false, 'error', 'FORBIDDEN'
    );
  end if;

  select offer.opportunity_id
  into v_opportunity_id
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.kind = 'ENROLLMENT';
  if not found then
    return pg_catalog.jsonb_build_object(
      'success', false, 'error', 'OFFER_NOT_FOUND'
    );
  end if;
  if v_opportunity_id is null then
    return public.complete_enrollment_offer_pre_trial_lifecycle_impl(
      p_offer_id,
      p_user_id
    );
  end if;

  perform private.lock_trial_conversion_graph(v_opportunity_id);
  select opportunity.*
  into v_opportunity
  from public.opportunities as opportunity
  where opportunity.id = v_opportunity_id;
  select offer.*
  into v_offer
  from public.offers as offer
  where offer.id = p_offer_id
    and offer.opportunity_id = v_opportunity_id
    and offer.kind = 'ENROLLMENT';

  if v_offer.id is null then
    return pg_catalog.jsonb_build_object(
      'success', false, 'error', 'OFFER_NOT_FOUND'
    );
  end if;
  if v_offer.processing_state = 'COMPLETED'
     and v_offer.consumed_by = p_user_id
     and v_opportunity.conversion_status = 'WON'
     and v_opportunity.student_id = p_user_id then
    return public.complete_enrollment_offer_pre_trial_lifecycle_impl(
      p_offer_id,
      p_user_id
    );
  end if;
  if v_opportunity.conversion_status <> 'OPEN' then
    return pg_catalog.jsonb_build_object(
      'success', false, 'error', 'OPPORTUNITY_CLOSED'
    );
  end if;
  if v_opportunity.feedback_required
     and not private.trial_feedback_is_complete(v_opportunity_id) then
    return pg_catalog.jsonb_build_object(
      'success', false, 'error', 'TRIAL_FEEDBACK_REQUIRED'
    );
  end if;
  if v_offer.revoked_at is not null
     or exists (
       select 1
       from public.enrollment_links as link
       where link.offer_id = p_offer_id
         and link.opportunity_id = v_opportunity_id
         and link.status = 'EXPIRED'
     ) then
    return pg_catalog.jsonb_build_object(
      'success', false, 'error', 'OFFER_REVOKED'
    );
  end if;

  return public.complete_enrollment_offer_pre_trial_lifecycle_impl(
    p_offer_id,
    p_user_id
  );
end;
$function$;

alter function
  public.complete_enrollment_offer_pre_trial_lifecycle_impl(uuid,uuid)
  owner to postgres;
alter function public.complete_enrollment_offer(uuid,uuid)
  owner to postgres;
revoke all on function public.complete_enrollment_offer(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_enrollment_offer(uuid,uuid)
  to service_role;

create or replace function private.trial_management_destination(
  p_tenant_id text
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (
      select pg_catalog.btrim(profile.directors_group_id)
      from public.tenant_memberships as membership
      join public.profiles as profile
        on profile.id = membership.user_id
       and profile.tenant_id = membership.tenant_id
      where membership.tenant_id = p_tenant_id
        and membership.role = 'SCHOOL_ADMIN'
        and membership.status = 'ACTIVE'
        and lower(pg_catalog.btrim(coalesce(
          profile.lifecycle_status,
          ''
        ))) = 'active'
        and pg_catalog.btrim(coalesce(profile.directors_group_id, ''))
          ~ '^[0-9]{10,25}@g[.]us$'
      order by membership.is_primary desc nulls last,
        membership.created_at,
        membership.user_id
      limit 1
    ),
    (
      select private.normalize_notification_phone(profile.phone)
      from public.tenant_memberships as membership
      join public.profiles as profile
        on profile.id = membership.user_id
       and profile.tenant_id = membership.tenant_id
      where membership.tenant_id = p_tenant_id
        and membership.role = 'SCHOOL_ADMIN'
        and membership.status = 'ACTIVE'
        and lower(pg_catalog.btrim(coalesce(
          profile.lifecycle_status,
          ''
        ))) = 'active'
        and private.normalize_notification_phone(profile.phone) is not null
      order by membership.is_primary desc nulls last,
        membership.created_at,
        membership.user_id
      limit 1
    )
  );
$function$;

alter function private.trial_management_destination(text) owner to postgres;
revoke all on function private.trial_management_destination(text)
  from public, anon, authenticated, service_role;
grant execute on function private.trial_management_destination(text)
  to postgres;

-- Service-only canonical snapshot used both by the Edge worker and by the
-- provider-boundary wrapper below. No phone/name is exposed to browser roles.
create or replace function public.get_trial_notification_delivery_snapshot(
  p_tenant_id text,
  p_opportunity_id uuid,
  p_notification_kind text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(
    p_notification_kind,
    ''
  )));
  v_opportunity public.opportunities%rowtype;
  v_request private.vendor_trial_teacher_requests%rowtype;
  v_link public.enrollment_links%rowtype;
  v_appointment public.appointments%rowtype;
  v_teacher public.profiles%rowtype;
  v_destination text;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'forbidden'
    );
  end if;
  if v_kind not in (
    'TRIAL_TEACHER_REQUESTED',
    'TRIAL_MANAGEMENT_ACCEPTED'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'unsupported_trial_notification'
    );
  end if;

  select opportunity.*
  into v_opportunity
  from public.opportunities as opportunity
  where opportunity.id = p_opportunity_id
    and opportunity.tenant_id = p_tenant_id;
  if not found
     or v_opportunity.kind <> 'TRIAL'
     or not private.tenant_is_operational(p_tenant_id) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'trial_notification_source_unavailable'
    );
  end if;
  if v_opportunity.is_test_fixture then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'test_fixture_suppressed'
    );
  end if;

  select request.*
  into v_request
  from private.vendor_trial_teacher_requests as request
  where request.opportunity_id = v_opportunity.id
    and request.tenant_id = v_opportunity.tenant_id;

  if v_kind = 'TRIAL_TEACHER_REQUESTED' then
    if v_request.id is null
       or v_request.status <> 'AWAITING_TEACHER'
       or v_opportunity.status <> 'OPEN'
       or v_opportunity.conversion_status <> 'OPEN'
       or v_opportunity.winner_teacher_id is not null
       or v_opportunity.professor_id is not null
       or v_opportunity.trial_appointment_id is not null then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'trial_teacher_request_no_longer_pending'
      );
    end if;

    select link.*
    into v_link
    from public.enrollment_links as link
    where link.id = v_request.enrollment_link_id
      and link.opportunity_id = v_opportunity.id
      and link.tenant_id = v_opportunity.tenant_id;
    select profile.*
    into v_teacher
    from public.profiles as profile
    where profile.id = v_request.target_teacher_id
      and profile.tenant_id = v_opportunity.tenant_id;

    if v_link.id is null
       or v_link.status <> 'USED'
       or v_link.purpose <> 'TRIAL_CONFIRMATION'
       or v_link.student_confirmed_at is null
       or v_request.slot_start <= pg_catalog.now() + interval '5 minutes'
       or v_teacher.id is null
       or v_teacher.role <> 'TEACHER'
       or lower(pg_catalog.btrim(coalesce(
         v_teacher.lifecycle_status,
         ''
       ))) <> 'active'
       or v_teacher.is_test_account is distinct from false
       or not exists (
         select 1
         from public.tenant_memberships as membership
         where membership.tenant_id = v_opportunity.tenant_id
           and membership.user_id = v_teacher.id
           and membership.role = 'TEACHER'
           and membership.status = 'ACTIVE'
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'reason', 'trial_teacher_request_binding_changed'
      );
    end if;

    v_destination := private.normalize_notification_phone(v_teacher.phone);
    if v_destination is null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'retryable', true,
        'reason', 'trial_teacher_destination_unavailable'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'teacherId', v_teacher.id,
      'destination', v_destination
    );
  end if;

  if v_opportunity.status <> 'CLAIMED'
     or v_opportunity.conversion_status <> 'OPEN'
     or v_opportunity.trial_appointment_id is null
     or v_opportunity.winner_teacher_id is null
     or v_opportunity.professor_id is distinct from
       v_opportunity.winner_teacher_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'trial_acceptance_no_longer_valid'
    );
  end if;
  select appointment.*
  into v_appointment
  from public.appointments as appointment
  where appointment.id = v_opportunity.trial_appointment_id
    and appointment.tenant_id = v_opportunity.tenant_id
    and appointment.teacher_id = v_opportunity.winner_teacher_id
    and appointment.professor_id = v_opportunity.winner_teacher_id;
  select profile.*
  into v_teacher
  from public.profiles as profile
  where profile.id = v_opportunity.winner_teacher_id
    and profile.tenant_id = v_opportunity.tenant_id;
  if v_appointment.id is null
     or lower(coalesce(v_appointment.status, '')) not in (
       'scheduled', 'confirmed'
     )
     or v_appointment.start_time <= pg_catalog.now()
     or v_teacher.id is null
     or v_teacher.is_test_account is distinct from false
     or lower(pg_catalog.btrim(coalesce(
       v_teacher.lifecycle_status,
       ''
     ))) <> 'active'
     or not exists (
       select 1
       from public.tenant_memberships as membership
       where membership.tenant_id = v_opportunity.tenant_id
         and membership.user_id = v_teacher.id
         and membership.role = 'TEACHER'
         and membership.status = 'ACTIVE'
     )
     or (
       v_request.id is not null
       and (
         v_request.status <> 'ACCEPTED'
         or v_request.target_teacher_id <> v_teacher.id
         or v_request.accepted_appointment_id <> v_appointment.id
       )
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'trial_acceptance_binding_changed'
    );
  end if;

  v_destination := private.trial_management_destination(
    v_opportunity.tenant_id
  );
  if v_destination is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'retryable', true,
      'reason', 'trial_management_destination_unavailable'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'teacherId', null,
    'destination', v_destination
  );
end;
$function$;

alter function public.get_trial_notification_delivery_snapshot(
  text,uuid,text
) owner to postgres;
revoke all on function public.get_trial_notification_delivery_snapshot(
  text,uuid,text
) from public, anon, authenticated, service_role;
grant execute on function public.get_trial_notification_delivery_snapshot(
  text,uuid,text
) to service_role;

-- Student confirmation and the teacher notification outbox are one commit.
do $wrap_confirm_vendor_trial$
begin
  if pg_catalog.to_regprocedure(
    'public.confirm_vendor_trial_interest_pre_outbox_impl(text,uuid,boolean)'
  ) is null then
    alter function public.confirm_vendor_trial_interest_atomic(
      text,uuid,boolean
    ) rename to confirm_vendor_trial_interest_pre_outbox_impl;
  end if;
end
$wrap_confirm_vendor_trial$;

revoke all on function
  public.confirm_vendor_trial_interest_pre_outbox_impl(text,uuid,boolean)
  from public, anon, authenticated, service_role;

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
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_result jsonb;
  v_opportunity_id uuid;
  v_opportunity public.opportunities%rowtype;
  v_request private.vendor_trial_teacher_requests%rowtype;
  v_teacher public.profiles%rowtype;
  v_tenant public.tenants%rowtype;
  v_destination text;
  v_message text;
  v_claim_url text;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'forbidden'
    );
  end if;
  v_result := public.confirm_vendor_trial_interest_pre_outbox_impl(
    p_link_token,
    p_legacy_opportunity_id,
    p_confirm
  );
  if coalesce((v_result ->> 'ok')::boolean, false) is not true
     or coalesce((v_result ->> 'newlyRequested')::boolean, false) is not true
     or p_confirm is not true then
    return v_result;
  end if;

  v_opportunity_id := (v_result ->> 'opportunityId')::uuid;
  select opportunity.*
  into v_opportunity
  from public.opportunities as opportunity
  where opportunity.id = v_opportunity_id
  for update;
  select request.*
  into v_request
  from private.vendor_trial_teacher_requests as request
  where request.opportunity_id = v_opportunity.id
  for update;
  select profile.*
  into v_teacher
  from public.profiles as profile
  where profile.id = v_request.target_teacher_id;
  select tenant.*
  into v_tenant
  from public.tenants as tenant
  where tenant.id = v_opportunity.tenant_id;

  if v_request.status <> 'AWAITING_TEACHER'
     or v_request.tenant_id <> v_opportunity.tenant_id
     or v_teacher.tenant_id <> v_opportunity.tenant_id
     or v_tenant.id <> v_opportunity.tenant_id then
    raise exception 'trial_teacher_outbox_binding_changed'
      using errcode = '40001';
  end if;

  v_destination := coalesce(
    private.normalize_notification_phone(v_teacher.phone),
    ''
  );
  v_claim_url := private.secure_trial_portal_origin(v_opportunity.tenant_id)
    || '/claim-opportunity?id=' || v_opportunity.id::text
    || '&g=' || v_opportunity.claim_generation::text;
  v_message := 'Nova solicitação individual de aula experimental — '
    || private.safe_notification_text(v_tenant.name, 120) || '.' || E'\n'
    || 'Horário pedido: '
    || pg_catalog.to_char(
      v_request.slot_start at time zone 'America/Sao_Paulo',
      'DD/MM/YYYY "às" HH24:MI'
    ) || '.' || E'\n'
    || 'Confirme somente se puder atender. Nenhuma aula foi agendada ainda:'
    || E'\n' || v_claim_url;

  insert into public.notification_queue (
    tenant_id,
    teacher_id,
    student_name,
    student_phone,
    message_body,
    scheduled_for,
    status,
    delivery_status,
    next_attempt_at,
    notification_kind,
    source_id,
    source_type,
    class_date,
    idempotency_key
  ) values (
    v_opportunity.tenant_id,
    v_teacher.id,
    v_opportunity.student_name,
    v_destination,
    v_message,
    pg_catalog.now(),
    'pending',
    'queued',
    pg_catalog.now(),
    'TRIAL_TEACHER_REQUESTED',
    v_opportunity.id,
    'TRIAL_OPPORTUNITY',
    (v_request.slot_start at time zone 'America/Sao_Paulo')::date,
    'trial-teacher-requested:' || v_opportunity.id::text || ':'
      || v_opportunity.claim_generation::text
  )
  on conflict (tenant_id, idempotency_key)
    where idempotency_key is not null
  do nothing;

  return v_result;
end;
$function$;

alter function public.confirm_vendor_trial_interest_pre_outbox_impl(
  text,uuid,boolean
) owner to postgres;
alter function public.confirm_vendor_trial_interest_atomic(
  text,uuid,boolean
) owner to postgres;
revoke all on function public.confirm_vendor_trial_interest_atomic(
  text,uuid,boolean
) from public, anon, authenticated, service_role;
grant execute on function public.confirm_vendor_trial_interest_atomic(
  text,uuid,boolean
) to service_role;

-- Teacher claim and the management notification outbox are one commit.
do $wrap_claim_opportunity$
begin
  if pg_catalog.to_regprocedure(
    'public.claim_opportunity_atomic_pre_outbox_impl(uuid,uuid,integer)'
  ) is null then
    alter function public.claim_opportunity_atomic(uuid,uuid,integer)
      rename to claim_opportunity_atomic_pre_outbox_impl;
  end if;
end
$wrap_claim_opportunity$;

revoke all on function
  public.claim_opportunity_atomic_pre_outbox_impl(uuid,uuid,integer)
  from public, anon, authenticated, service_role;

create or replace function public.claim_opportunity_atomic(
  p_opportunity_id uuid,
  p_teacher_id uuid,
  p_claim_generation integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_result jsonb;
  v_opportunity public.opportunities%rowtype;
  v_appointment public.appointments%rowtype;
  v_teacher public.profiles%rowtype;
  v_tenant public.tenants%rowtype;
  v_destination text;
  v_message text;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'forbidden'
    );
  end if;
  v_result := public.claim_opportunity_atomic_pre_outbox_impl(
    p_opportunity_id,
    p_teacher_id,
    p_claim_generation
  );
  if coalesce((v_result ->> 'ok')::boolean, false) is not true
     or coalesce((v_result ->> 'idempotent')::boolean, false) is true then
    return v_result;
  end if;

  select opportunity.*
  into v_opportunity
  from public.opportunities as opportunity
  where opportunity.id = p_opportunity_id
  for update;
  if not found then
    raise exception 'trial_management_outbox_source_missing'
      using errcode = '40001';
  end if;

  -- The underlying claim RPC also schedules internal TRAINING opportunities.
  -- This outbox belongs only to the public trial funnel; preserve the existing
  -- training behavior without manufacturing a misleading trial notification.
  if v_opportunity.kind is distinct from 'TRIAL' then
    return v_result;
  end if;

  select appointment.*
  into v_appointment
  from public.appointments as appointment
  where appointment.id = v_opportunity.trial_appointment_id;
  select profile.*
  into v_teacher
  from public.profiles as profile
  where profile.id = p_teacher_id;
  select tenant.*
  into v_tenant
  from public.tenants as tenant
  where tenant.id = v_opportunity.tenant_id;

  if v_opportunity.status <> 'CLAIMED'
     or v_opportunity.winner_teacher_id <> p_teacher_id
     or v_opportunity.professor_id <> p_teacher_id
     or v_appointment.tenant_id <> v_opportunity.tenant_id
     or v_teacher.tenant_id <> v_opportunity.tenant_id
     or v_tenant.id <> v_opportunity.tenant_id then
    raise exception 'trial_management_outbox_binding_changed'
      using errcode = '40001';
  end if;

  v_destination := coalesce(
    private.trial_management_destination(v_opportunity.tenant_id),
    ''
  );
  v_message := '🔔 *AULA EXPERIMENTAL ACEITA — '
    || private.safe_notification_text(v_tenant.name, 120) || '*' || E'\n\n'
    || '👨🏫 *Professor:* '
    || private.safe_notification_text(v_teacher.full_name, 120) || E'\n'
    || '🎓 *Aluno:* '
    || private.safe_notification_text(v_opportunity.student_name, 120)
    || E'\n'
    || '📅 *Data:* '
    || pg_catalog.to_char(
      v_appointment.start_time at time zone 'America/Sao_Paulo',
      'DD/MM/YYYY HH24:MI'
    ) || E'\n\n'
    || '✅ Agendamento confirmado no sistema.';

  insert into public.notification_queue (
    tenant_id,
    student_name,
    student_phone,
    message_body,
    scheduled_for,
    status,
    delivery_status,
    next_attempt_at,
    notification_kind,
    source_id,
    source_type,
    class_date,
    idempotency_key
  ) values (
    v_opportunity.tenant_id,
    v_opportunity.student_name,
    v_destination,
    v_message,
    pg_catalog.now(),
    'pending',
    'queued',
    pg_catalog.now(),
    'TRIAL_MANAGEMENT_ACCEPTED',
    v_opportunity.id,
    'TRIAL_OPPORTUNITY',
    (v_appointment.start_time at time zone 'America/Sao_Paulo')::date,
    'trial-management-accepted:' || v_opportunity.id::text || ':'
      || p_claim_generation::text
  )
  on conflict (tenant_id, idempotency_key)
    where idempotency_key is not null
  do nothing;

  return v_result;
end;
$function$;

alter function public.claim_opportunity_atomic_pre_outbox_impl(
  uuid,uuid,integer
) owner to postgres;
alter function public.claim_opportunity_atomic(uuid,uuid,integer)
  owner to postgres;
revoke all on function public.claim_opportunity_atomic(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_opportunity_atomic(uuid,uuid,integer)
  to service_role;

-- Funnel expiry is a state transition, not three unrelated REST updates. It
-- expires a directed request/link and closes the opportunity under one lock.
create or replace function public.expire_trial_opportunity_atomic(
  p_tenant_id text,
  p_opportunity_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_opportunity public.opportunities%rowtype;
  v_request private.vendor_trial_teacher_requests%rowtype;
  v_slot_date date;
  v_slot_time time without time zone;
  v_slot_start timestamptz;
  v_due boolean := false;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'forbidden'
    );
  end if;
  if nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '') is null
     or p_opportunity_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'invalid_request'
    );
  end if;

  begin
    perform private.lock_trial_conversion_graph(p_opportunity_id);
  exception when no_data_found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'opportunity_not_found'
    );
  end;
  select opportunity.*
  into v_opportunity
  from public.opportunities as opportunity
  where opportunity.id = p_opportunity_id;

  if v_opportunity.tenant_id is distinct from p_tenant_id
     or v_opportunity.kind <> 'TRIAL' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'opportunity_not_found'
    );
  end if;
  if v_opportunity.status = 'EXPIRED'
     and v_opportunity.conversion_status = 'LOST' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'expired', false,
      'idempotent', true,
      'state', 'EXPIRED'
    );
  end if;
  if v_opportunity.status <> 'OPEN'
     or v_opportunity.conversion_status <> 'OPEN' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'opportunity_not_expirable',
      'state', v_opportunity.status
    );
  end if;

  select request.*
  into v_request
  from private.vendor_trial_teacher_requests as request
  where request.opportunity_id = p_opportunity_id;

  v_due := coalesce(v_opportunity.opened_at, v_opportunity.created_at)
    <= pg_catalog.now() - interval '48 hours';
  if v_request.id is not null
     and v_request.status in ('AWAITING_STUDENT', 'AWAITING_TEACHER')
     and v_request.slot_start <= pg_catalog.now() + interval '5 minutes' then
    v_due := true;
  end if;
  if exists (
    select 1
    from public.enrollment_links as link
    where link.opportunity_id = p_opportunity_id
      and link.purpose = 'TRIAL_CONFIRMATION'
      and link.status = 'PENDING'
      and link.expires_at <= pg_catalog.now()
  ) then
    v_due := true;
  end if;

  if pg_catalog.jsonb_typeof(v_opportunity.slots_proposed) = 'array'
     and pg_catalog.jsonb_array_length(v_opportunity.slots_proposed) > 0
     and coalesce(v_opportunity.slots_proposed #>> '{0,date}', '')
       ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     and coalesce(v_opportunity.slots_proposed #>> '{0,time}', '')
       ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
    begin
      v_slot_date := (v_opportunity.slots_proposed #>> '{0,date}')::date;
      v_slot_time := (v_opportunity.slots_proposed #>> '{0,time}')::time;
      v_slot_start := (v_slot_date + v_slot_time)
        at time zone 'America/Sao_Paulo';
      if v_slot_start <= pg_catalog.now() then
        v_due := true;
      end if;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        null;
    end;
  end if;

  if not v_due then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'expired', false,
      'idempotent', false,
      'state', 'NOT_DUE'
    );
  end if;

  update public.enrollment_links as link
  set status = 'EXPIRED'
  where link.opportunity_id = p_opportunity_id
    and link.purpose = 'TRIAL_CONFIRMATION'
    and link.status = 'PENDING';

  update private.vendor_trial_teacher_requests as request
  set status = 'EXPIRED',
      updated_at = pg_catalog.now()
  where request.opportunity_id = p_opportunity_id
    and request.status in ('AWAITING_STUDENT', 'AWAITING_TEACHER');

  update public.opportunities as opportunity
  set status = 'EXPIRED',
      conversion_status = 'LOST',
      lost_reason = case
        when v_request.status = 'AWAITING_STUDENT' then coalesce(
          nullif(pg_catalog.btrim(opportunity.lost_reason), ''),
          'STUDENT_CONFIRMATION_EXPIRED'
        )
        else null
      end
  where opportunity.id = p_opportunity_id
    and opportunity.tenant_id = p_tenant_id
    and opportunity.status = 'OPEN'
    and opportunity.conversion_status = 'OPEN';
  if not found then
    raise exception 'trial_expiration_lost_lock' using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'expired', true,
    'idempotent', false,
    'state', 'EXPIRED'
  );
end;
$function$;

alter function public.expire_trial_opportunity_atomic(text,uuid)
  owner to postgres;
revoke all on function public.expire_trial_opportunity_atomic(text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.expire_trial_opportunity_atomic(text,uuid)
  to service_role;

-- The generic notification fence remains authoritative. This wrapper adds a
-- source lock and canonical trial snapshot before delegating to it, keeping the
-- source rows locked until the queue reaches SUBMITTING.
do $wrap_notification_submission$
begin
  if pg_catalog.to_regprocedure(
    'public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(uuid,uuid,text,text,text,text,uuid,bigint)'
  ) is null then
    alter function public.begin_notification_delivery_submission(
      uuid,uuid,text,text,text,text,uuid,bigint
    ) rename to begin_notification_delivery_submission_pre_trial_lifecycle_impl;
  end if;
end
$wrap_notification_submission$;

revoke all on function
  public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(
    uuid,uuid,text,text,text,text,uuid,bigint
  ) from public, anon, authenticated, service_role;

create or replace function public.begin_notification_delivery_submission(
  p_notification_id uuid,
  p_claim_token uuid,
  p_provider_instance_name text,
  p_expected_destination text,
  p_provider_destination text,
  p_expected_message_body text,
  p_integration_id uuid,
  p_integration_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_notification public.notification_queue%rowtype;
  v_kind text;
  v_snapshot jsonb;
  v_current_destination text;
  v_current_teacher_id uuid;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'forbidden'
    );
  end if;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id;
  v_kind := pg_catalog.upper(pg_catalog.btrim(coalesce(
    v_notification.notification_kind,
    ''
  )));

  if v_kind not in (
    'TRIAL_TEACHER_REQUESTED',
    'TRIAL_MANAGEMENT_ACCEPTED'
  ) then
    return public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(
      p_notification_id,
      p_claim_token,
      p_provider_instance_name,
      p_expected_destination,
      p_provider_destination,
      p_expected_message_body,
      p_integration_id,
      p_integration_version
    );
  end if;

  if v_notification.id is null
     or v_notification.source_id is null
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
       v_notification.source_type,
       ''
     ))) <> 'TRIAL_OPPORTUNITY'
     or v_notification.tenant_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'invalid_trial_notification_identity'
    );
  end if;

  begin
    perform opportunity.id
    from public.opportunities as opportunity
    where opportunity.id = v_notification.source_id
      and opportunity.tenant_id = v_notification.tenant_id
    for share nowait;
    if not found then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'trial_notification_source_unavailable'
      );
    end if;

    perform link.id
    from public.enrollment_links as link
    where link.opportunity_id = v_notification.source_id
    order by link.id
    for share nowait;

    perform request.id
    from private.vendor_trial_teacher_requests as request
    where request.opportunity_id = v_notification.source_id
    order by request.id
    for share nowait;
  exception when lock_not_available then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'trial_notification_revalidation_busy'
    );
  end;

  v_snapshot := public.get_trial_notification_delivery_snapshot(
    v_notification.tenant_id,
    v_notification.source_id,
    v_kind
  );
  if coalesce((v_snapshot ->> 'ok')::boolean, false) is not true then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', case
        when coalesce((v_snapshot ->> 'retryable')::boolean, false)
          then 'RETRY'
        else 'REVIEW_REQUIRED'
      end,
      'reason', coalesce(
        v_snapshot ->> 'reason',
        'trial_notification_revalidation_failed'
      )
    );
  end if;

  v_current_destination := private.normalize_notification_destination(
    v_snapshot ->> 'destination'
  );
  begin
    v_current_teacher_id := nullif(v_snapshot ->> 'teacherId', '')::uuid;
  exception when invalid_text_representation then
    v_current_teacher_id := null;
  end;
  if v_current_destination is null
     or v_current_destination is distinct from
       private.normalize_notification_destination(p_expected_destination)
     or (
       v_current_destination like '%@g.us'
       and private.normalize_notification_destination(p_provider_destination)
         is distinct from v_current_destination
     )
     or (
       v_current_destination not like '%@g.us'
       and not private.notification_phones_same_recipient(
         v_current_destination,
         private.normalize_notification_destination(p_provider_destination)
       )
     )
     or (
       v_kind = 'TRIAL_TEACHER_REQUESTED'
       and v_notification.teacher_id is distinct from v_current_teacher_id
     )
     or (
       v_kind = 'TRIAL_MANAGEMENT_ACCEPTED'
       and v_notification.teacher_id is not null
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'trial_notification_authorized_snapshot_changed'
    );
  end if;

  return public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(
    p_notification_id,
    p_claim_token,
    p_provider_instance_name,
    p_expected_destination,
    p_provider_destination,
    p_expected_message_body,
    p_integration_id,
    p_integration_version
  );
end;
$function$;

alter function
  public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(
    uuid,uuid,text,text,text,text,uuid,bigint
  ) owner to postgres;
alter function public.begin_notification_delivery_submission(
  uuid,uuid,text,text,text,text,uuid,bigint
) owner to postgres;
revoke all on function public.begin_notification_delivery_submission(
  uuid,uuid,text,text,text,text,uuid,bigint
) from public, anon, authenticated, service_role;
grant execute on function public.begin_notification_delivery_submission(
  uuid,uuid,text,text,text,text,uuid,bigint
) to service_role;

do $postconditions$
begin
  if pg_catalog.to_regprocedure(
    'public.get_teacher_pending_trial_feedback_secure()'
  ) is null
     or pg_catalog.to_regprocedure(
       'public.expire_trial_opportunity_atomic(text,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.get_trial_notification_delivery_snapshot(text,uuid,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.create_enrollment_offer_pre_trial_lifecycle_impl(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.update_trial_outcome_secure_pre_trial_lifecycle_impl(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.complete_enrollment_offer_pre_trial_lifecycle_impl(uuid,uuid)'
     ) is null then
    raise exception 'trial_conversion_lifecycle_installation_failed';
  end if;
end
$postconditions$;

commit;
