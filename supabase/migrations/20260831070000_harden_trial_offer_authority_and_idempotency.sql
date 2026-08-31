begin;

-- The previous lifecycle wrapper deliberately allows non-trial enrollment
-- offers to keep working. This outer boundary adds an idempotency receipt for
-- callers that provide requestId and removes the historical TEACHER authority
-- to mint commercial terms.
create table if not exists private.enrollment_offer_command_receipts (
  tenant_id text not null references public.tenants(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  payload_fingerprint text not null,
  offer_id uuid references public.offers(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (tenant_id, actor_id, request_id)
);

alter table private.enrollment_offer_command_receipts enable row level security;
alter table private.enrollment_offer_command_receipts force row level security;
revoke all on table private.enrollment_offer_command_receipts
  from public, anon, authenticated, service_role;

create or replace function private.enrollment_offer_payload_fingerprint(
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

alter function private.enrollment_offer_payload_fingerprint(jsonb)
  owner to postgres;
revoke all on function private.enrollment_offer_payload_fingerprint(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.enrollment_offer_payload_fingerprint(jsonb)
  to postgres;

do $wrap_offer_creation$
begin
  if pg_catalog.to_regprocedure(
    'public.create_enrollment_offer_pre_trial_offer_authority_impl(jsonb)'
  ) is null then
    alter function public.create_enrollment_offer(jsonb)
      rename to create_enrollment_offer_pre_trial_offer_authority_impl;
  end if;
end
$wrap_offer_creation$;

revoke all on function
  public.create_enrollment_offer_pre_trial_offer_authority_impl(jsonb)
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
  v_role text := private.active_tenant_role(v_actor_id);
  v_request_id uuid;
  v_safe_payload jsonb;
  v_fingerprint text;
  v_offer_id uuid;
  v_existing_fingerprint text;
begin
  if v_actor_id is null or v_tenant_id is null
     or coalesce(v_role, '') not in (
       'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN', 'SALESPERSON'
     ) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  -- requestId is required only for the durable retry protocol. Calls from old
  -- integrations remain compatible but are intentionally not retry-safe.
  if pg_catalog.jsonb_typeof(coalesce(p_payload, '{}'::jsonb))
       is distinct from 'object'
     or not (p_payload ? 'requestId') then
    return public.create_enrollment_offer_pre_trial_offer_authority_impl(
      p_payload
    );
  end if;

  begin
    v_request_id := nullif(
      pg_catalog.btrim(coalesce(p_payload ->> 'requestId', '')),
      ''
    )::uuid;
  exception when invalid_text_representation then
    raise exception 'invalid_enrollment_offer_request_id'
      using errcode = '22023';
  end;
  if v_request_id is null then
    raise exception 'invalid_enrollment_offer_request_id'
      using errcode = '22023';
  end if;

  v_safe_payload := p_payload - 'requestId';
  v_fingerprint := private.enrollment_offer_payload_fingerprint(v_safe_payload);

  insert into private.enrollment_offer_command_receipts (
    tenant_id, actor_id, request_id, payload_fingerprint
  ) values (
    v_tenant_id, v_actor_id, v_request_id, v_fingerprint
  ) on conflict do nothing
  returning offer_id into v_offer_id;

  if not found then
    select receipt.payload_fingerprint, receipt.offer_id
      into v_existing_fingerprint, v_offer_id
      from private.enrollment_offer_command_receipts as receipt
     where receipt.tenant_id = v_tenant_id
       and receipt.actor_id = v_actor_id
       and receipt.request_id = v_request_id
     for update;
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception 'idempotency_key_reused' using errcode = '23505';
    end if;
    if v_offer_id is null then
      raise exception 'enrollment_offer_request_incomplete'
        using errcode = '40001';
    end if;
    return v_offer_id;
  end if;

  v_offer_id := public.create_enrollment_offer_pre_trial_offer_authority_impl(
    v_safe_payload
  );
  if not exists (
    select 1
      from public.offers as offer
     where offer.id = v_offer_id
       and offer.tenant_id = v_tenant_id
       and offer.kind = 'ENROLLMENT'
       and offer.revoked_at is null
  ) then
    raise exception 'enrollment_offer_scope_mismatch' using errcode = '23514';
  end if;

  update private.enrollment_offer_command_receipts
     set offer_id = v_offer_id,
         completed_at = pg_catalog.now()
   where tenant_id = v_tenant_id
     and actor_id = v_actor_id
     and request_id = v_request_id
     and payload_fingerprint = v_fingerprint;
  if not found then
    raise exception 'enrollment_offer_receipt_lost_lock' using errcode = '40001';
  end if;
  return v_offer_id;
end;
$function$;

alter function public.create_enrollment_offer_pre_trial_offer_authority_impl(jsonb)
  owner to postgres;
alter function public.create_enrollment_offer(jsonb) owner to postgres;
revoke all on function public.create_enrollment_offer(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_enrollment_offer(jsonb)
  to authenticated;

-- SAVE_FEEDBACK used to create the proof of attendance itself. That allowed a
-- teacher to settle a future lesson by writing feedback first. The feedback
-- command now accepts only a completed class log authored for the locked
-- appointment after its canonical 30-minute trial window has elapsed.
do $wrap_trial_outcome$
begin
  if pg_catalog.to_regprocedure(
    'public.update_trial_outcome_secure_pre_feedback_evidence_impl(jsonb)'
  ) is null then
    alter function public.update_trial_outcome_secure(jsonb)
      rename to update_trial_outcome_secure_pre_feedback_evidence_impl;
  end if;
end
$wrap_trial_outcome$;

revoke all on function
  public.update_trial_outcome_secure_pre_feedback_evidence_impl(jsonb)
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
  v_action text;
  v_opportunity_id uuid;
  v_opportunity public.opportunities%rowtype;
  v_appointment public.appointments%rowtype;
  v_teacher_id uuid;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_payload, '{}'::jsonb))
       is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end if;
  v_action := pg_catalog.upper(pg_catalog.btrim(coalesce(
    p_payload ->> 'action', ''
  )));
  if v_action <> 'SAVE_FEEDBACK' then
    return public.update_trial_outcome_secure_pre_feedback_evidence_impl(
      p_payload
    );
  end if;

  begin
    v_opportunity_id := nullif(
      pg_catalog.btrim(coalesce(p_payload ->> 'opportunityId', '')),
      ''
    )::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end;
  if v_opportunity_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload');
  end if;

  select actor.actor_id, actor.tenant_id, actor.actor_role
    into v_actor_id, v_tenant_id, v_actor_role
    from private.secure_trial_actor_context() as actor;
  if v_actor_id is null or v_actor_role <> 'TEACHER' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  perform private.lock_trial_conversion_graph(v_opportunity_id);
  select opportunity.* into v_opportunity
    from public.opportunities as opportunity
   where opportunity.id = v_opportunity_id
     and opportunity.tenant_id = v_tenant_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'opportunity_not_found');
  end if;
  v_teacher_id := coalesce(
    v_opportunity.winner_teacher_id, v_opportunity.professor_id
  );
  if v_teacher_id is null or v_teacher_id <> v_actor_id
     or v_opportunity.trial_appointment_id is null then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select appointment.* into v_appointment
    from public.appointments as appointment
   where appointment.id = v_opportunity.trial_appointment_id
     and appointment.tenant_id = v_tenant_id
   for update;
  if not found
     or coalesce(v_appointment.teacher_id, v_appointment.professor_id)
          is distinct from v_actor_id
     or pg_catalog.lower(coalesce(v_appointment.type, '')) <> 'experimental' then
    return jsonb_build_object('ok', false, 'error', 'appointment_tenant_mismatch');
  end if;
  if v_appointment.start_time + interval '30 minutes' > pg_catalog.now() then
    return jsonb_build_object('ok', false, 'error', 'appointment_not_ended');
  end if;
  if not exists (
    select 1
      from public.class_logs as class_log
     where class_log.tenant_id = v_tenant_id
       and class_log.appointment_id = v_appointment.id::text
       and class_log.teacher_id = v_actor_id
       and class_log.presence = 'COMPLETED'
       and class_log.subtype = 'AULA EXPERIMENTAL'
  ) then
    return jsonb_build_object(
      'ok', false, 'error', 'completed_class_log_required'
    );
  end if;

  return public.update_trial_outcome_secure_pre_feedback_evidence_impl(
    p_payload
  );
end;
$function$;

alter function public.update_trial_outcome_secure_pre_feedback_evidence_impl(jsonb)
  owner to postgres;
alter function public.update_trial_outcome_secure(jsonb) owner to postgres;
revoke all on function public.update_trial_outcome_secure(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_trial_outcome_secure(jsonb)
  to authenticated;

commit;
