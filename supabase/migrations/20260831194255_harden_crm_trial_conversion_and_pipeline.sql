begin;

-- CRM trials must share the same authoritative graph used by the experimental
-- funnel.  A lead can reference at most one opportunity, and an opportunity
-- can belong to at most one CRM lead.
alter table public.crm_leads
  add column if not exists opportunity_id uuid,
  add column if not exists scheduled_at timestamptz;

do $crm_trial_fk$
begin
  if exists (
    select 1
      from pg_catalog.pg_constraint as constraint_row
     where constraint_row.conrelid =
             'public.crm_leads'::pg_catalog.regclass
       and constraint_row.conname = 'crm_leads_opportunity_id_fkey'
       and (
         constraint_row.contype <> 'f'
         or constraint_row.confrelid <>
              'public.opportunities'::pg_catalog.regclass
         or constraint_row.confdeltype <> 'r'
       )
  ) then
    alter table public.crm_leads
      drop constraint crm_leads_opportunity_id_fkey;
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint as constraint_row
     where constraint_row.conrelid = 'public.crm_leads'::pg_catalog.regclass
       and constraint_row.conname = 'crm_leads_opportunity_id_fkey'
       and constraint_row.contype = 'f'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_opportunity_id_fkey
      foreign key (opportunity_id)
      references public.opportunities(id)
      on delete restrict
      not valid;
  end if;
end;
$crm_trial_fk$;

alter table public.crm_leads
  validate constraint crm_leads_opportunity_id_fkey;

create unique index if not exists crm_leads_opportunity_id_unique_idx
  on public.crm_leads (opportunity_id)
  where opportunity_id is not null;

create table if not exists private.trial_temporal_override_receipts (
  tenant_id text not null,
  actor_id uuid not null,
  request_id uuid not null,
  opportunity_id uuid not null,
  payload_fingerprint text not null,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (tenant_id, actor_id, request_id)
);
alter table private.trial_temporal_override_receipts owner to postgres;
alter table private.trial_temporal_override_receipts enable row level security;
alter table private.trial_temporal_override_receipts force row level security;
revoke all on table private.trial_temporal_override_receipts
  from public, anon, authenticated, service_role;

create or replace function private.guard_crm_lead_trial_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding_lead text := nullif(
    pg_catalog.current_setting('app.crm_trial_binding_lead', true),
    ''
  );
  v_binding_opportunity text := nullif(
    pg_catalog.current_setting('app.crm_trial_binding_opportunity', true),
    ''
  );
  v_binding_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    v_binding_changed := new.opportunity_id is not null;
  else
    v_binding_changed := new.opportunity_id is distinct from
      old.opportunity_id;
  end if;

  if v_binding_changed
     and (
       v_binding_lead is distinct from new.id::text
       or v_binding_opportunity is distinct from new.opportunity_id::text
     ) then
    raise exception 'crm lead trial binding requires the secure command'
      using errcode = '42501';
  end if;
  if new.opportunity_id is not null
     and not exists (
       select 1
         from public.opportunities as opportunity
        where opportunity.id = new.opportunity_id
          and opportunity.tenant_id = new.tenant_id
          and opportunity.kind = 'TRIAL'
     ) then
    raise exception 'crm lead trial opportunity tenant mismatch'
      using errcode = '23503';
  end if;
  return new;
end;
$function$;

alter function private.guard_crm_lead_trial_scope() owner to postgres;
revoke all on function private.guard_crm_lead_trial_scope()
  from public, anon, authenticated, service_role;
drop trigger if exists guard_crm_lead_trial_scope_insert
  on public.crm_leads;
create trigger guard_crm_lead_trial_scope_insert
before insert on public.crm_leads
for each row execute function private.guard_crm_lead_trial_scope();
drop trigger if exists guard_crm_lead_trial_scope_update
  on public.crm_leads;
create trigger guard_crm_lead_trial_scope_update
before update of tenant_id, opportunity_id on public.crm_leads
for each row execute function private.guard_crm_lead_trial_scope();

create or replace function private.guard_crm_lead_trial_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.opportunity_id is not null then
    raise exception 'linked crm trial leads cannot be deleted'
      using errcode = '23503';
  end if;
  return old;
end;
$function$;

alter function private.guard_crm_lead_trial_delete() owner to postgres;
revoke all on function private.guard_crm_lead_trial_delete()
  from public, anon, authenticated, service_role;
drop trigger if exists guard_crm_lead_trial_delete on public.crm_leads;
create trigger guard_crm_lead_trial_delete
before delete on public.crm_leads
for each row execute function private.guard_crm_lead_trial_delete();

-- Legacy attendance code used a phone match to set TRIAL_DONE.  Silently keep
-- that class-log transaction intact, but ignore the denormalized CRM mutation;
-- only the exact opportunity command below may advance a linked lead.
create or replace function private.guard_crm_trial_status_authority()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_authoritative_opportunity text := nullif(
    pg_catalog.current_setting('app.crm_trial_outcome_opportunity', true),
    ''
  );
  v_binding_lead text := nullif(
    pg_catalog.current_setting('app.crm_trial_binding_lead', true),
    ''
  );
  v_binding_opportunity text := nullif(
    pg_catalog.current_setting('app.crm_trial_binding_opportunity', true),
    ''
  );
  v_linked_opportunity uuid := coalesce(
    new.opportunity_id,
    old.opportunity_id
  );
  v_authoritative_change boolean := false;
begin
  if new.status is distinct from old.status then
    v_authoritative_change := (
      v_linked_opportunity is not null
      and v_authoritative_opportunity is not distinct from
        v_linked_opportunity::text
    ) or (
      new.opportunity_id is not null
      and v_binding_lead is not distinct from new.id::text
      and v_binding_opportunity is not distinct from
        new.opportunity_id::text
    );

    if (
      pg_catalog.upper(pg_catalog.btrim(coalesce(old.status, ''))) = 'WON'
      and pg_catalog.upper(pg_catalog.btrim(coalesce(new.status, ''))) <>
        'WON'
    ) or (
      pg_catalog.upper(pg_catalog.btrim(coalesce(new.status, ''))) in (
        'SCHEDULED', 'TRIAL_DONE'
      )
      and not v_authoritative_change
    ) or (
      old.opportunity_id is not null
      and not v_authoritative_change
    ) then
      new.status := old.status;
    end if;
  end if;
  return new;
end;
$function$;

alter function private.guard_crm_trial_status_authority()
  owner to postgres;
revoke all on function private.guard_crm_trial_status_authority()
  from public, anon, authenticated, service_role;
drop trigger if exists guard_crm_trial_status_authority on public.crm_leads;
create trigger guard_crm_trial_status_authority
before update of status on public.crm_leads
for each row execute function private.guard_crm_trial_status_authority();

do $required_trial_contracts$
begin
  if pg_catalog.to_regprocedure(
       'public.schedule_manual_trial_secure(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.create_enrollment_offer(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.update_trial_outcome_secure(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.secure_trial_actor_context()'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.lock_trial_conversion_graph(uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.notification_phones_same_recipient(text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.normalize_notification_phone(text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.claim_opportunity_atomic(uuid,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.complete_enrollment_offer(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.secure_trial_payload_fingerprint(jsonb)'
     ) is null
  then
    raise exception 'required secure trial predecessor is missing';
  end if;
end;
$required_trial_contracts$;

-- The Edge precheck improves errors, but the authoritative lead binding must
-- be revalidated under the same transaction and graph lock as offer creation.
-- Calls without leadId preserve the legacy contract.
do $preserve_create_enrollment_offer$
begin
  if pg_catalog.to_regprocedure(
       'public.create_enrollment_offer_pre_crm_lead_lock_impl(jsonb)'
     ) is null
  then
    alter function public.create_enrollment_offer(jsonb)
      rename to create_enrollment_offer_pre_crm_lead_lock_impl;
  end if;
end;
$preserve_create_enrollment_offer$;

create or replace function public.create_enrollment_offer(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_tenant_id text;
  v_actor_role text;
  v_lead_id uuid;
  v_opportunity_id uuid;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_payload, '{}'::jsonb))
       is distinct from 'object'
     or not p_payload ? 'leadId' then
    return public.create_enrollment_offer_pre_crm_lead_lock_impl(p_payload);
  end if;

  begin
    v_lead_id := (p_payload ->> 'leadId')::uuid;
    v_opportunity_id := (p_payload ->> 'opportunityId')::uuid;
  exception when invalid_text_representation then
    raise exception 'invalid_trial_lead_binding' using errcode = '22023';
  end;
  if v_lead_id is null or v_opportunity_id is null then
    raise exception 'invalid_trial_lead_binding' using errcode = '22023';
  end if;

  select actor.actor_id, actor.tenant_id, actor.actor_role
    into v_actor_id, v_tenant_id, v_actor_role
    from private.secure_trial_actor_context() as actor;
  if v_actor_id is null
     or v_actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.opportunities as opportunity
     where opportunity.id = v_opportunity_id
       and opportunity.tenant_id = v_tenant_id
  ) then
    raise exception 'trial_lead_link_required' using errcode = '23514';
  end if;
  begin
    perform private.lock_trial_conversion_graph(v_opportunity_id);
  exception when no_data_found then
    raise exception 'trial_lead_link_required' using errcode = '23514';
  end;

  perform lead.id
    from public.crm_leads as lead
   where lead.id = v_lead_id
     and lead.tenant_id = v_tenant_id
     and lead.opportunity_id = v_opportunity_id
     and pg_catalog.upper(pg_catalog.btrim(coalesce(lead.status, ''))) =
       'TRIAL_DONE'
   for update;
  if not found then
    raise exception 'trial_lead_link_required' using errcode = '23514';
  end if;

  return public.create_enrollment_offer_pre_crm_lead_lock_impl(
    p_payload - 'leadId'
  );
end;
$function$;

alter function
  public.create_enrollment_offer_pre_crm_lead_lock_impl(jsonb)
  owner to postgres;
alter function public.create_enrollment_offer(jsonb) owner to postgres;
revoke all on function
  public.create_enrollment_offer_pre_crm_lead_lock_impl(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.create_enrollment_offer(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_enrollment_offer(jsonb)
  to authenticated;

-- Preserve the reviewed command as a forward-only implementation.  The public
-- wrapper adds an optional leadId while keeping the legacy five-key contract
-- unchanged for ManualTrialScheduler.
do $preserve_manual_trial$
begin
  if pg_catalog.to_regprocedure(
       'public.schedule_manual_trial_secure_pre_crm_binding_impl(jsonb)'
     ) is null
  then
    alter function public.schedule_manual_trial_secure(jsonb)
      rename to schedule_manual_trial_secure_pre_crm_binding_impl;
  end if;
end;
$preserve_manual_trial$;

create or replace function public.schedule_manual_trial_secure(p_payload jsonb)
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
  v_lead_id uuid;
  v_lead public.crm_leads%rowtype;
  v_receipt_fingerprint text;
  v_receipt_response jsonb;
  v_has_receipt boolean := false;
  v_response jsonb;
  v_opportunity_id uuid;
  v_payload_phone text;
  v_lead_phone text;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_payload, '{}'::jsonb))
       is distinct from 'object' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'invalid_payload'
    );
  end if;

  if not p_payload ? 'leadId' then
    return public.schedule_manual_trial_secure_pre_crm_binding_impl(
      p_payload
    );
  end if;

  if not p_payload ?& array[
       'requestId', 'leadId', 'teacherId', 'studentName',
       'studentPhone', 'startsAt'
     ]
     or (select pg_catalog.count(*)
           from pg_catalog.jsonb_object_keys(p_payload)) <> 6 then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'invalid_payload'
    );
  end if;

  begin
    v_request_id := (p_payload ->> 'requestId')::uuid;
    v_lead_id := (p_payload ->> 'leadId')::uuid;
  exception when invalid_text_representation then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'invalid_payload'
    );
  end;

  select actor.actor_id, actor.tenant_id, actor.actor_role
    into v_actor_id, v_tenant_id, v_actor_role
    from private.secure_trial_actor_context() as actor;
  if v_actor_id is null
     or v_actor_role not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  -- The legacy five-key scheduler remains available to coordinators.  Binding
  -- a CRM row follows the narrower CRM authority and is director-only here;
  -- do not let SECURITY DEFINER bypass the crm_leads RLS role boundary.
  if v_actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select lead.*
    into v_lead
    from public.crm_leads as lead
   where lead.id = v_lead_id
     and lead.tenant_id = v_tenant_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'lead_not_found'
    );
  end if;

  select receipt.payload_fingerprint, receipt.response
    into v_receipt_fingerprint, v_receipt_response
    from private.secure_trial_command_receipts as receipt
   where receipt.tenant_id = v_tenant_id
     and receipt.actor_id = v_actor_id
     and receipt.command = 'MANUAL_SCHEDULE'
     and receipt.request_id = v_request_id;
  v_has_receipt := found;

  -- A retry may reuse only the receipt that originally bound this exact lead.
  -- A new request for an already-linked lead must never create a second trial.
  if v_lead.opportunity_id is not null then
    if not v_has_receipt then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'error', 'lead_already_has_trial',
        'opportunityId', v_lead.opportunity_id
      );
    end if;
    if v_receipt_fingerprint is distinct from
         private.secure_trial_payload_fingerprint(p_payload - 'leadId') then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    begin
      v_opportunity_id := (v_receipt_response ->> 'opportunityId')::uuid;
    exception when invalid_text_representation then
      v_opportunity_id := null;
    end;
    if v_opportunity_id is distinct from v_lead.opportunity_id then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'idempotency_key_reused'
      );
    end if;
    return coalesce(v_receipt_response, '{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'idempotent', true,
        'leadId', v_lead_id
      );
  end if;

  -- A receipt with no matching lead binding belongs to the legacy five-key
  -- command (or to another lead) and cannot be adopted retroactively.
  if v_has_receipt then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'idempotency_key_reused'
    );
  end if;

  if pg_catalog.upper(pg_catalog.btrim(coalesce(v_lead.status, 'NEW')))
       not in ('NEW', 'CONTACTED', 'SCHEDULED') then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'lead_not_schedulable'
    );
  end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(v_lead.name, '')))
       is distinct from
       pg_catalog.lower(pg_catalog.btrim(coalesce(
         p_payload ->> 'studentName', ''
       ))) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'lead_identity_mismatch'
    );
  end if;

  v_payload_phone := private.normalize_notification_phone(
    p_payload ->> 'studentPhone'
  );
  v_lead_phone := private.normalize_notification_phone(v_lead.phone);
  if (v_payload_phone is null) is distinct from (v_lead_phone is null)
     or (
       v_payload_phone is not null
       and not private.notification_phones_same_recipient(
         v_payload_phone,
         v_lead_phone
       )
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'lead_identity_mismatch'
    );
  end if;

  v_response := public.schedule_manual_trial_secure_pre_crm_binding_impl(
    p_payload - 'leadId'
  );
  if coalesce((v_response ->> 'ok')::boolean, false) is not true then
    return v_response;
  end if;
  begin
    v_opportunity_id := (v_response ->> 'opportunityId')::uuid;
  exception when invalid_text_representation then
    raise exception 'manual trial returned an invalid opportunity'
      using errcode = 'XX000';
  end;
  if v_opportunity_id is null then
    raise exception 'manual trial returned no opportunity'
      using errcode = 'XX000';
  end if;

  perform pg_catalog.set_config(
    'app.crm_trial_binding_lead',
    v_lead_id::text,
    true
  );
  perform pg_catalog.set_config(
    'app.crm_trial_binding_opportunity',
    v_opportunity_id::text,
    true
  );
  update public.crm_leads as lead
     set opportunity_id = v_opportunity_id,
         status = 'CONTACTED',
         scheduled_at = null
   where lead.id = v_lead_id
     and lead.tenant_id = v_tenant_id
     and lead.opportunity_id is null;
  if not found then
    raise exception 'crm lead binding lost its row lock'
      using errcode = '40001';
  end if;
  perform pg_catalog.set_config('app.crm_trial_binding_lead', '', true);
  perform pg_catalog.set_config(
    'app.crm_trial_binding_opportunity',
    '',
    true
  );

  return v_response || pg_catalog.jsonb_build_object('leadId', v_lead_id);
exception
  when unique_violation then
    raise exception 'trial opportunity is already bound to another lead'
      using errcode = '23505';
end;
$function$;

alter function
  public.schedule_manual_trial_secure_pre_crm_binding_impl(jsonb)
  owner to postgres;
alter function public.schedule_manual_trial_secure(jsonb) owner to postgres;
revoke all on function
  public.schedule_manual_trial_secure_pre_crm_binding_impl(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.schedule_manual_trial_secure(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.schedule_manual_trial_secure(jsonb)
  to authenticated;

-- The manual command creates an AWAITING_TEACHER request, not an appointment.
-- Promote the CRM lead to SCHEDULED only when the service-role claim command
-- has atomically created and validated the canonical appointment.
do $preserve_claim_opportunity$
begin
  if pg_catalog.to_regprocedure(
       'public.claim_opportunity_atomic_pre_crm_status_impl(uuid,uuid,integer)'
     ) is null
  then
    alter function public.claim_opportunity_atomic(uuid,uuid,integer)
      rename to claim_opportunity_atomic_pre_crm_status_impl;
  end if;
end;
$preserve_claim_opportunity$;

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
  v_result jsonb;
  v_appointment public.appointments%rowtype;
begin
  v_result := public.claim_opportunity_atomic_pre_crm_status_impl(
    p_opportunity_id,
    p_teacher_id,
    p_claim_generation
  );
  if coalesce((v_result ->> 'ok')::boolean, false) is not true then
    return v_result;
  end if;

  select appointment.*
    into v_appointment
    from public.appointments as appointment
    join public.opportunities as opportunity
      on opportunity.trial_appointment_id = appointment.id
     and opportunity.tenant_id = appointment.tenant_id
   where opportunity.id = p_opportunity_id
     and opportunity.status = 'CLAIMED'
     and opportunity.winner_teacher_id = p_teacher_id
     and opportunity.professor_id = p_teacher_id;
  if found then
    perform pg_catalog.set_config(
      'app.crm_trial_outcome_opportunity',
      p_opportunity_id::text,
      true
    );
    update public.crm_leads as lead
       set status = 'SCHEDULED',
           scheduled_at = v_appointment.start_time
     where lead.opportunity_id = p_opportunity_id
       and lead.tenant_id = v_appointment.tenant_id
       and lead.status not in ('TRIAL_DONE', 'WON', 'LOST');
    perform pg_catalog.set_config(
      'app.crm_trial_outcome_opportunity',
      '',
      true
    );
  end if;

  return v_result;
end;
$function$;

alter function
  public.claim_opportunity_atomic_pre_crm_status_impl(uuid,uuid,integer)
  owner to postgres;
alter function public.claim_opportunity_atomic(uuid,uuid,integer)
  owner to postgres;
revoke all on function
  public.claim_opportunity_atomic_pre_crm_status_impl(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_opportunity_atomic(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_opportunity_atomic(uuid,uuid,integer)
  to service_role;

-- Enrollment completion is the only authority that may promote a linked CRM
-- trial to WON.  Legacy unlinked leads retain their historical reconciliation,
-- while linked leads are synchronized by the exact opportunity FK.
do $preserve_complete_enrollment$
begin
  if pg_catalog.to_regprocedure(
       'public.complete_enrollment_offer_pre_crm_won_impl(uuid,uuid)'
     ) is null
  then
    alter function public.complete_enrollment_offer(uuid,uuid)
      rename to complete_enrollment_offer_pre_crm_won_impl;
  end if;
end;
$preserve_complete_enrollment$;

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
  v_result jsonb;
  v_opportunity_id uuid;
  v_tenant_id text;
begin
  v_result := public.complete_enrollment_offer_pre_crm_won_impl(
    p_offer_id,
    p_user_id
  );
  if coalesce((v_result ->> 'success')::boolean, false) is not true then
    return v_result;
  end if;

  select opportunity.id, opportunity.tenant_id
    into v_opportunity_id, v_tenant_id
    from public.offers as offer
    join public.opportunities as opportunity
      on opportunity.id = offer.opportunity_id
     and opportunity.tenant_id = offer.tenant_id
   where offer.id = p_offer_id
     and offer.kind = 'ENROLLMENT'
     and opportunity.kind = 'TRIAL'
     and opportunity.conversion_status = 'WON'
     and opportunity.student_id = p_user_id;
  if found then
    perform pg_catalog.set_config(
      'app.crm_trial_outcome_opportunity',
      v_opportunity_id::text,
      true
    );
    update public.crm_leads as lead
       set status = 'WON',
           student_id = p_user_id,
           last_status_change = pg_catalog.clock_timestamp()
     where lead.opportunity_id = v_opportunity_id
       and lead.tenant_id = v_tenant_id;
    perform pg_catalog.set_config(
      'app.crm_trial_outcome_opportunity',
      '',
      true
    );
  end if;

  return v_result;
end;
$function$;

alter function
  public.complete_enrollment_offer_pre_crm_won_impl(uuid,uuid)
  owner to postgres;
alter function public.complete_enrollment_offer(uuid,uuid)
  owner to postgres;
revoke all on function
  public.complete_enrollment_offer_pre_crm_won_impl(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_enrollment_offer(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_enrollment_offer(uuid,uuid)
  to service_role;

-- Preserve the current reviewed trial-outcome implementation.  The public
-- wrapper blocks early settlement and synchronizes CRM state by opportunity FK.
do $preserve_trial_outcome$
begin
  if pg_catalog.to_regprocedure(
       'public.update_trial_outcome_secure_pre_crm_temporal_guard_impl(jsonb)'
     ) is null
  then
    alter function public.update_trial_outcome_secure(jsonb)
      rename to update_trial_outcome_secure_pre_crm_temporal_guard_impl;
  end if;
end;
$preserve_trial_outcome$;

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
  v_trial_status text;
  v_request_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_request_id uuid;
  v_opportunity_id uuid;
  v_opportunity public.opportunities%rowtype;
  v_appointment public.appointments%rowtype;
  v_override_requested boolean := false;
  v_override_reason text;
  v_override_fingerprint text;
  v_existing_override_fingerprint text;
  v_override_receipt_exists boolean := false;
  v_override_receipt_inserted boolean := false;
  v_response jsonb;
  v_crm_status text;
begin
  if pg_catalog.jsonb_typeof(v_request_payload) is distinct from 'object' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'invalid_payload'
    );
  end if;
  v_action := pg_catalog.upper(pg_catalog.btrim(coalesce(
    v_request_payload ->> 'action', ''
  )));
  v_trial_status := pg_catalog.upper(pg_catalog.btrim(coalesce(
    v_request_payload ->> 'trialStatus', ''
  )));

  if v_action = 'SET_TRIAL_STATUS' then
    if v_request_payload ? 'overrideBeforeEnd'
       or v_request_payload ? 'overrideReason' then
      if not v_request_payload ?& array[
           'requestId', 'opportunityId', 'action', 'trialStatus',
           'overrideBeforeEnd', 'overrideReason'
         ]
         or (select pg_catalog.count(*)
               from pg_catalog.jsonb_object_keys(v_request_payload)) <> 6
         or pg_catalog.jsonb_typeof(
              v_request_payload -> 'overrideBeforeEnd'
            ) is distinct from 'boolean' then
        return pg_catalog.jsonb_build_object(
          'ok', false, 'error', 'invalid_payload'
        );
      end if;
      v_override_requested := coalesce(
        (v_request_payload ->> 'overrideBeforeEnd')::boolean,
        false
      );
      v_override_reason := nullif(pg_catalog.btrim(coalesce(
        v_request_payload ->> 'overrideReason', ''
      )), '');
      if not v_override_requested
         or pg_catalog.char_length(coalesce(v_override_reason, ''))
              not between 10 and 500 then
        return pg_catalog.jsonb_build_object(
          'ok', false, 'error', 'invalid_override_reason'
        );
      end if;
      v_override_fingerprint := private.secure_trial_payload_fingerprint(
        v_request_payload
      );
      v_request_payload := v_request_payload
        - 'overrideBeforeEnd' - 'overrideReason';
    elsif not v_request_payload ?& array[
            'requestId', 'opportunityId', 'action', 'trialStatus'
          ]
          or (select pg_catalog.count(*)
                from pg_catalog.jsonb_object_keys(v_request_payload)) <> 4 then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_payload'
      );
    end if;

    begin
      v_request_id := (v_request_payload ->> 'requestId')::uuid;
      v_opportunity_id := (v_request_payload ->> 'opportunityId')::uuid;
    exception when invalid_text_representation then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_payload'
      );
    end;
    if v_request_id is null or v_opportunity_id is null then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_payload'
      );
    end if;
    if v_trial_status not in (
      'DONE', 'NO_SHOW_STUDENT', 'NO_SHOW_TEACHER'
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'invalid_trial_status'
      );
    end if;

    select actor.actor_id, actor.tenant_id, actor.actor_role
      into v_actor_id, v_tenant_id, v_actor_role
      from private.secure_trial_actor_context() as actor;
    if v_actor_id is null then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;
    if v_actor_role not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;

    -- Preserve the JSON contract for missing/cross-tenant UUIDs.  The shared
    -- graph lock raises P0002 for a missing row, so check the scoped identity
    -- first and still catch a concurrent delete before the lock.
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
    begin
      perform private.lock_trial_conversion_graph(v_opportunity_id);
    exception when no_data_found then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'opportunity_not_found'
      );
    end;
    select opportunity.*
      into v_opportunity
      from public.opportunities as opportunity
     where opportunity.id = v_opportunity_id
       and opportunity.tenant_id = v_tenant_id;
    if not found or v_opportunity.trial_appointment_id is null then
      return public.update_trial_outcome_secure_pre_crm_temporal_guard_impl(
        v_request_payload
      );
    end if;

    select appointment.*
      into v_appointment
      from public.appointments as appointment
     where appointment.id = v_opportunity.trial_appointment_id
       and appointment.tenant_id = v_tenant_id
     for update;
    if not found then
      return public.update_trial_outcome_secure_pre_crm_temporal_guard_impl(
        v_request_payload
      );
    end if;
    if v_appointment.start_time is null then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'appointment_time_missing'
      );
    end if;
    if v_override_requested then
      select receipt.payload_fingerprint
        into v_existing_override_fingerprint
        from private.trial_temporal_override_receipts as receipt
       where receipt.tenant_id = v_tenant_id
         and receipt.actor_id = v_actor_id
         and receipt.request_id = v_request_id;
      v_override_receipt_exists := found;
      if v_override_receipt_exists
         and v_existing_override_fingerprint is distinct from
           v_override_fingerprint then
        return pg_catalog.jsonb_build_object(
          'ok', false, 'error', 'idempotency_key_reused'
        );
      end if;
    end if;
    if v_appointment.start_time + interval '30 minutes' >
         pg_catalog.now() then
      if not v_override_requested then
        return pg_catalog.jsonb_build_object(
          'ok', false, 'error', 'appointment_not_ended'
        );
      end if;
      if v_actor_role <> 'SUPER_ADMIN' then
        return pg_catalog.jsonb_build_object(
          'ok', false, 'error', 'forbidden_temporal_override'
        );
      end if;
      if not v_override_receipt_exists then
        insert into private.trial_temporal_override_receipts (
          tenant_id,
          actor_id,
          request_id,
          opportunity_id,
          payload_fingerprint
        ) values (
          v_tenant_id,
          v_actor_id,
          v_request_id,
          v_opportunity_id,
          v_override_fingerprint
        )
        on conflict do nothing;
        v_override_receipt_inserted := found;
        if not found then
          select receipt.payload_fingerprint
            into v_existing_override_fingerprint
            from private.trial_temporal_override_receipts as receipt
           where receipt.tenant_id = v_tenant_id
             and receipt.actor_id = v_actor_id
             and receipt.request_id = v_request_id;
          if v_existing_override_fingerprint is distinct from
               v_override_fingerprint then
            return pg_catalog.jsonb_build_object(
              'ok', false, 'error', 'idempotency_key_reused'
            );
          end if;
          v_override_receipt_exists := true;
        end if;
      end if;
    elsif v_override_requested and not v_override_receipt_exists then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'override_not_required'
      );
    end if;
  end if;

  v_response :=
    public.update_trial_outcome_secure_pre_crm_temporal_guard_impl(
      v_request_payload
    );
  if coalesce((v_response ->> 'ok')::boolean, false) is not true then
    if v_override_receipt_inserted then
      delete from private.trial_temporal_override_receipts as receipt
       where receipt.tenant_id = v_tenant_id
         and receipt.actor_id = v_actor_id
         and receipt.request_id = v_request_id
         and receipt.payload_fingerprint = v_override_fingerprint;
    end if;
    return v_response;
  end if;

  if v_opportunity_id is null then
    begin
      v_opportunity_id := (v_request_payload ->> 'opportunityId')::uuid;
    exception when invalid_text_representation then
      v_opportunity_id := null;
    end;
  end if;
  v_crm_status := case
    when v_action = 'MARK_LOST' then 'LOST'
    when v_action = 'SAVE_FEEDBACK' then 'TRIAL_DONE'
    when v_action = 'SET_TRIAL_STATUS' and v_trial_status = 'DONE'
      then 'TRIAL_DONE'
    else null
  end;
  if v_crm_status is not null and v_opportunity_id is not null then
    perform pg_catalog.set_config(
      'app.crm_trial_outcome_opportunity',
      v_opportunity_id::text,
      true
    );
    update public.crm_leads as lead
       set status = v_crm_status
     where lead.opportunity_id = v_opportunity_id
       and lead.tenant_id = (
         select opportunity.tenant_id
           from public.opportunities as opportunity
          where opportunity.id = v_opportunity_id
       )
       and lead.status not in ('WON', 'LOST');
    perform pg_catalog.set_config(
      'app.crm_trial_outcome_opportunity',
      '',
      true
    );
  end if;

  if v_override_receipt_inserted
     and coalesce(v_response ->> 'idempotent', 'false') <> 'true' then
    insert into public.audit_logs (
      tenant_id,
      user_id,
      user_role,
      action,
      resource_type,
      resource_id,
      old_values,
      new_values,
      diff
    ) values (
      v_tenant_id,
      v_actor_id,
      v_actor_role,
      'trial_status_override_before_appointment_end',
      'opportunity',
      v_opportunity_id::text,
      pg_catalog.jsonb_build_object(
        'trial_status', v_opportunity.trial_status,
        'appointment_start_time', v_appointment.start_time
      ),
      pg_catalog.jsonb_build_object(
        'trial_status', v_trial_status,
        'override_reason', v_override_reason
      ),
      pg_catalog.jsonb_build_object(
        'trial_status', pg_catalog.jsonb_build_array(
          v_opportunity.trial_status,
          v_trial_status
        ),
        'override_reason', v_override_reason
      )
    );
  end if;

  return v_response;
end;
$function$;

alter function
  public.update_trial_outcome_secure_pre_crm_temporal_guard_impl(jsonb)
  owner to postgres;
alter function public.update_trial_outcome_secure(jsonb) owner to postgres;
revoke all on function
  public.update_trial_outcome_secure_pre_crm_temporal_guard_impl(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.update_trial_outcome_secure(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_trial_outcome_secure(jsonb)
  to authenticated;

comment on column public.crm_leads.opportunity_id is
  'Authoritative one-to-one link to the trial opportunity used for outcome and enrollment conversion.';
comment on function public.schedule_manual_trial_secure(jsonb) is
  'Schedules a secure manual trial; optional leadId atomically binds the CRM lead to the authoritative opportunity.';
comment on function public.update_trial_outcome_secure(jsonb) is
  'Settles trial outcomes only after the appointment window; early SUPER_ADMIN overrides require an audited reason.';

commit;
