-- Wolfie active-tenant, live-quota and usage hardening.
--
-- The Edge Functions resolve the selected ACTIVE tenant membership. Legacy
-- profiles.tenant_id remains the primary school and must not silently replace
-- that selected tenant inside privileged RPCs.

-- Request keys are idempotent inside a tenant, not globally across every
-- school to which the same learner belongs.
alter table public.wolfie_activity_sessions
  drop constraint if exists wolfie_activity_sessions_student_id_request_key_key;
alter table public.wolfie_activity_sessions
  add constraint wolfie_activity_sessions_tenant_request_key
  unique (tenant_id, student_id, request_key);

alter table public.wolfie_ai_requests
  drop constraint if exists wolfie_ai_requests_student_id_request_key_key;
alter table public.wolfie_ai_requests
  add constraint wolfie_ai_requests_tenant_request_key
  unique (tenant_id, student_id, request_key);

alter table public.wolfie_repertoire
  drop constraint if exists wolfie_repertoire_student_id_term_key_key;
alter table public.wolfie_repertoire
  add constraint wolfie_repertoire_tenant_term_key
  unique (tenant_id, student_id, term_key);

alter table public.wolf_intelligence
  drop constraint if exists wolf_intelligence_student_id_key;
alter table public.wolf_intelligence
  add constraint wolf_intelligence_tenant_student_key
  unique (tenant_id, student_id);

alter table public.wolfie_memory_items
  drop constraint if exists wolfie_memory_items_student_id_kind_memory_key_key;
alter table public.wolfie_memory_items
  add constraint wolfie_memory_items_tenant_memory_key
  unique (tenant_id, student_id, kind, memory_key);

alter table public.wolfie_facts
  drop constraint if exists wolfie_facts_student_id_fact_type_subject_key_version_key;
alter table public.wolfie_facts
  add constraint wolfie_facts_tenant_version_key
  unique (tenant_id, student_id, fact_type, subject_key, version);

drop index if exists public.idx_wolfie_facts_one_active_value;
create unique index idx_wolfie_facts_one_active_value
  on public.wolfie_facts (tenant_id, student_id, fact_type, subject_key)
  where status = 'active';

alter table public.wolfie_sessions
  drop constraint if exists wolfie_sessions_realtime_first_turn_unique;
alter table public.wolfie_sessions
  add constraint wolfie_sessions_realtime_first_turn_unique
  unique (tenant_id, student_id, realtime_first_client_turn_id);

-- Composite profile FKs encoded the primary/legacy school. Membership is the
-- tenant authority for a multi-school learner.
alter table public.wolfie_sessions
  drop constraint if exists wolfie_sessions_student_tenant_fkey;
alter table public.wolfie_sessions
  add constraint wolfie_sessions_membership_scope_fkey
  foreign key (student_id, tenant_id)
  references public.tenant_memberships (user_id, tenant_id)
  on delete cascade
  not valid;

alter table public.wolf_intelligence
  drop constraint if exists wolf_intelligence_student_tenant_fkey;
alter table public.wolf_intelligence
  add constraint wolf_intelligence_membership_scope_fkey
  foreign key (student_id, tenant_id)
  references public.tenant_memberships (user_id, tenant_id)
  on delete cascade
  not valid;

alter table public.wolfie_memory_items
  drop constraint if exists wolfie_memory_items_scope_fkey;
alter table public.wolfie_memory_items
  add constraint wolfie_memory_items_membership_scope_fkey
  foreign key (student_id, tenant_id)
  references public.tenant_memberships (user_id, tenant_id)
  on delete cascade
  not valid;

alter table public.wolfie_session_reports
  drop constraint if exists wolfie_session_reports_scope_fkey;
alter table public.wolfie_session_reports
  add constraint wolfie_session_reports_membership_scope_fkey
  foreign key (student_id, tenant_id)
  references public.tenant_memberships (user_id, tenant_id)
  on delete cascade
  not valid;

alter table public.wolfie_facts
  drop constraint if exists wolfie_facts_student_tenant_fkey;
alter table public.wolfie_facts
  add constraint wolfie_facts_membership_scope_fkey
  foreign key (student_id, tenant_id)
  references public.tenant_memberships (user_id, tenant_id)
  on delete cascade
  not valid;

alter table public.wolf_intelligence
  validate constraint wolf_intelligence_membership_scope_fkey;
alter table public.wolfie_sessions
  validate constraint wolfie_sessions_membership_scope_fkey;
alter table public.wolfie_memory_items
  validate constraint wolfie_memory_items_membership_scope_fkey;
alter table public.wolfie_session_reports
  validate constraint wolfie_session_reports_membership_scope_fkey;
alter table public.wolfie_facts
  validate constraint wolfie_facts_membership_scope_fkey;

drop index if exists public.idx_wolfie_learning_events_event_key_once;
create unique index idx_wolfie_learning_events_event_key_once
  on public.wolfie_learning_events (tenant_id, student_id, event_key)
  where event_key is not null;

drop index if exists public.idx_wolfie_ai_requests_rate_limit;
create index idx_wolfie_ai_requests_rate_limit
  on public.wolfie_ai_requests (
    tenant_id,
    student_id,
    operation,
    updated_at desc
  );

-- Keep the caller-supplied active tenant and validate it against an ACTIVE
-- STUDENT membership. The old trigger overwrote it with profiles.tenant_id.
create or replace function public.prepare_wolfie_activity_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile_test_fixture boolean;
  v_source_subject text;
  v_source_phase text;
  v_source_status text;
  v_source_rehearsal_count integer;
begin
  if new.tenant_id is null or pg_catalog.btrim(new.tenant_id) = '' then
    raise exception 'student_active_tenant_required';
  end if;

  select coalesce(profile.is_test_account, false)
    into v_profile_test_fixture
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = new.tenant_id
     and membership.status = 'ACTIVE'
     and membership.role = 'STUDENT'
   where profile.id = new.student_id
     and profile.role = 'STUDENT';

  if not found then
    raise exception 'student_active_tenant_membership_not_found';
  end if;

  new.test_fixture := v_profile_test_fixture;

  if new.phase = 'readaptation' then
    if new.subject <> 'global_meetings'
       or new.source_session_id is null
       or new.source_session_id = new.id then
      raise exception 'invalid_readaptation_source';
    end if;

    select
      source.subject,
      source.phase,
      source.status,
      case
        when pg_catalog.jsonb_typeof(
          source.learner_state #> '{memorization,rehearsalCount}'
        ) = 'number'
          then (
            source.learner_state #>> '{memorization,rehearsalCount}'
          )::integer
        else 0
      end
      into
        v_source_subject,
        v_source_phase,
        v_source_status,
        v_source_rehearsal_count
      from public.wolfie_activity_sessions as source
     where source.id = new.source_session_id
       and source.student_id = new.student_id
       and source.tenant_id = new.tenant_id;

    if not found
       or v_source_subject <> 'global_meetings'
       or v_source_phase <> 'construction'
       or v_source_status <> 'COMPLETED'
       or v_source_rehearsal_count < 1 then
      raise exception 'invalid_readaptation_source';
    end if;
  elsif new.source_session_id is not null then
    raise exception 'source_session_requires_readaptation';
  end if;

  return new;
end;
$function$;

-- Remove the legacy, tenant-implicit overload before exposing the scoped RPC.
drop function if exists public.claim_wolfie_ai_request(uuid, uuid, text);

create function public.claim_wolfie_ai_request(
  p_tenant_id text,
  p_student_id uuid,
  p_request_key uuid,
  p_operation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile_test_fixture boolean;
  v_request public.wolfie_ai_requests%rowtype;
  v_has_request boolean := false;
  v_lease_token uuid;
  v_rate_cap integer;
  v_recent_attempts integer;
begin
  if p_tenant_id is null
     or pg_catalog.btrim(p_tenant_id) = ''
     or p_student_id is null
     or p_request_key is null then
    raise exception 'invalid_ai_request_identity';
  end if;
  if p_operation is null
     or p_operation not in ('GENERATE', 'EVALUATE', 'SPEECH') then
    raise exception 'invalid_ai_operation';
  end if;

  select coalesce(profile.is_test_account, false)
    into v_profile_test_fixture
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = p_tenant_id
     and membership.status = 'ACTIVE'
     and membership.role = 'STUDENT'
   where profile.id = p_student_id
     and profile.role = 'STUDENT'
   for update of profile;

  if not found then
    raise exception 'student_active_tenant_membership_not_found';
  end if;

  select *
    into v_request
    from public.wolfie_ai_requests as request
   where request.tenant_id = p_tenant_id
     and request.student_id = p_student_id
     and request.request_key = p_request_key
   for update;
  v_has_request := found;

  if v_has_request and v_request.operation <> p_operation then
    raise exception 'ai_request_key_reused_for_another_operation';
  end if;

  if v_profile_test_fixture then
    if v_has_request then
      update public.wolfie_ai_requests
         set status = 'COMPLETED',
             response_payload = '{"skipped":"test_fixture"}'::jsonb,
             error_code = null,
             test_fixture = true,
             lease_expires_at = pg_catalog.now(),
             completed_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
       where id = v_request.id
       returning * into v_request;
    else
      insert into public.wolfie_ai_requests (
        tenant_id,
        student_id,
        request_key,
        operation,
        status,
        attempt_count,
        response_payload,
        test_fixture,
        completed_at
      ) values (
        p_tenant_id,
        p_student_id,
        p_request_key,
        p_operation,
        'COMPLETED',
        0,
        '{"skipped":"test_fixture"}'::jsonb,
        true,
        pg_catalog.now()
      )
      returning * into v_request;
    end if;

    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'status', v_request.status,
      'tenantId', v_request.tenant_id,
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'leaseToken', null,
      'leaseExpiresAt', v_request.lease_expires_at,
      'responsePayload', v_request.response_payload,
      'testFixture', true
    );
  end if;

  if v_has_request and v_request.status = 'COMPLETED' then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'status', v_request.status,
      'tenantId', v_request.tenant_id,
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'leaseToken', null,
      'leaseExpiresAt', v_request.lease_expires_at,
      'responsePayload', v_request.response_payload,
      'errorCode', v_request.error_code,
      'testFixture', v_request.test_fixture
    );
  end if;

  if v_has_request
     and v_request.status = 'PROCESSING'
     and v_request.lease_expires_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'status', v_request.status,
      'tenantId', v_request.tenant_id,
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'leaseToken', null,
      'leaseExpiresAt', v_request.lease_expires_at,
      'responsePayload', '{}'::jsonb,
      'errorCode', null,
      'testFixture', false
    );
  end if;

  if v_has_request and v_request.attempt_count >= 3 then
    if v_request.status = 'PROCESSING' then
      update public.wolfie_ai_requests
         set status = 'FAILED',
             error_code = 'AI_RETRY_LIMIT_EXCEEDED',
             completed_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
       where id = v_request.id
       returning * into v_request;
    end if;

    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'status', 'FAILED',
      'tenantId', v_request.tenant_id,
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'leaseToken', null,
      'leaseExpiresAt', v_request.lease_expires_at,
      'responsePayload', v_request.response_payload,
      'errorCode',
        coalesce(v_request.error_code, 'AI_RETRY_LIMIT_EXCEEDED'),
      'testFixture', false
    );
  end if;

  v_rate_cap := case p_operation when 'EVALUATE' then 40 else 20 end;
  select coalesce(pg_catalog.sum(request.attempt_count), 0)::integer
    into v_recent_attempts
    from public.wolfie_ai_requests as request
   where request.tenant_id = p_tenant_id
     and request.student_id = p_student_id
     and request.operation = p_operation
     and request.updated_at >= pg_catalog.now() - interval '1 hour';

  if v_recent_attempts >= v_rate_cap then
    raise exception using
      errcode = 'P0001',
      message = 'wolfie_ai_rate_limit_exceeded';
  end if;

  v_lease_token := gen_random_uuid();
  if v_has_request then
    update public.wolfie_ai_requests
       set status = 'PROCESSING',
           lease_token = v_lease_token,
           lease_expires_at = pg_catalog.now() + interval '45 seconds',
           attempt_count = attempt_count + 1,
           response_payload = '{}'::jsonb,
           error_code = null,
           completed_at = null,
           updated_at = pg_catalog.now()
     where id = v_request.id
     returning * into v_request;
  else
    insert into public.wolfie_ai_requests (
      tenant_id,
      student_id,
      request_key,
      operation,
      status,
      lease_token,
      lease_expires_at,
      attempt_count,
      test_fixture
    ) values (
      p_tenant_id,
      p_student_id,
      p_request_key,
      p_operation,
      'PROCESSING',
      v_lease_token,
      pg_catalog.now() + interval '45 seconds',
      1,
      false
    )
    returning * into v_request;
  end if;

  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'status', v_request.status,
    'tenantId', v_request.tenant_id,
    'requestKey', v_request.request_key,
    'operation', v_request.operation,
    'attemptCount', v_request.attempt_count,
    'leaseToken', v_request.lease_token,
    'leaseExpiresAt', v_request.lease_expires_at,
    'responsePayload', '{}'::jsonb,
    'errorCode', null,
    'testFixture', false
  );
end;
$function$;

drop function if exists public.finish_wolfie_ai_request(
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  text
);

create function public.finish_wolfie_ai_request(
  p_tenant_id text,
  p_student_id uuid,
  p_request_key uuid,
  p_lease_token uuid,
  p_status text,
  p_response_payload jsonb default '{}'::jsonb,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_request public.wolfie_ai_requests%rowtype;
begin
  if p_tenant_id is null
     or pg_catalog.btrim(p_tenant_id) = ''
     or p_student_id is null
     or p_request_key is null
     or p_lease_token is null then
    raise exception 'invalid_ai_request_identity';
  end if;
  if p_status is null or p_status not in ('COMPLETED', 'FAILED') then
    raise exception 'invalid_ai_final_status';
  end if;
  if pg_catalog.pg_column_size(
    coalesce(p_response_payload, '{}'::jsonb)
  ) > 1048576 then
    raise exception 'ai_response_payload_too_large';
  end if;

  if not exists (
    select 1
      from public.profiles as profile
      join public.tenant_memberships as membership
        on membership.user_id = profile.id
       and membership.tenant_id = p_tenant_id
       and membership.status = 'ACTIVE'
       and membership.role = 'STUDENT'
     where profile.id = p_student_id
       and profile.role = 'STUDENT'
  ) then
    raise exception 'student_active_tenant_membership_not_found';
  end if;

  select *
    into v_request
    from public.wolfie_ai_requests as request
   where request.tenant_id = p_tenant_id
     and request.student_id = p_student_id
     and request.request_key = p_request_key
   for update;

  if not found then
    raise exception 'ai_request_not_found';
  end if;

  if v_request.status = 'COMPLETED' then
    return pg_catalog.jsonb_build_object(
      'alreadyFinished', true,
      'status', v_request.status,
      'tenantId', v_request.tenant_id,
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'responsePayload', v_request.response_payload,
      'errorCode', v_request.error_code
    );
  end if;

  if v_request.status <> 'PROCESSING'
     or v_request.lease_token <> p_lease_token then
    raise exception 'ai_lease_not_owned';
  end if;

  update public.wolfie_ai_requests
     set status = p_status,
         response_payload = case
           when p_status = 'COMPLETED'
             then coalesce(p_response_payload, '{}'::jsonb)
           else '{}'::jsonb
         end,
         error_code = case
           when p_status = 'FAILED'
             then pg_catalog.left(
               coalesce(p_error_code, 'AI_PROVIDER_FAILED'),
               120
             )
           else null
         end,
         lease_expires_at = pg_catalog.now(),
         completed_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = v_request.id
   returning * into v_request;

  return pg_catalog.jsonb_build_object(
    'alreadyFinished', false,
    'status', v_request.status,
    'tenantId', v_request.tenant_id,
    'requestKey', v_request.request_key,
    'operation', v_request.operation,
    'attemptCount', v_request.attempt_count,
    'responsePayload', v_request.response_payload,
    'errorCode', v_request.error_code
  );
end;
$function$;

drop function if exists public.create_wolfie_activity_session(
  uuid,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  jsonb,
  jsonb,
  text[],
  text[]
);

create function public.create_wolfie_activity_session(
  p_tenant_id text,
  p_student_id uuid,
  p_subject text,
  p_cefr_level text,
  p_sector text,
  p_phase text,
  p_modality text,
  p_source_session_id uuid,
  p_request_key uuid,
  p_activity_content jsonb,
  p_answer_key jsonb,
  p_reused_terms text[],
  p_introduced_terms text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_session public.wolfie_activity_sessions%rowtype;
begin
  if p_tenant_id is null
     or pg_catalog.btrim(p_tenant_id) = ''
     or p_student_id is null
     or p_request_key is null then
    raise exception 'invalid_activity_request_identity';
  end if;

  if not exists (
    select 1
      from public.profiles as profile
      join public.tenant_memberships as membership
        on membership.user_id = profile.id
       and membership.tenant_id = p_tenant_id
       and membership.status = 'ACTIVE'
       and membership.role = 'STUDENT'
     where profile.id = p_student_id
       and profile.role = 'STUDENT'
  ) then
    raise exception 'student_active_tenant_membership_not_found';
  end if;

  begin
    insert into public.wolfie_activity_sessions (
      tenant_id,
      student_id,
      subject,
      cefr_level,
      sector,
      phase,
      modality,
      source_session_id,
      request_key,
      activity_content,
      reused_terms,
      introduced_terms
    ) values (
      p_tenant_id,
      p_student_id,
      p_subject,
      p_cefr_level,
      nullif(pg_catalog.btrim(p_sector), ''),
      p_phase,
      p_modality,
      p_source_session_id,
      p_request_key,
      coalesce(p_activity_content, '{}'::jsonb),
      coalesce(p_reused_terms, '{}'::text[]),
      coalesce(p_introduced_terms, '{}'::text[])
    )
    returning * into v_session;

    insert into public.wolfie_activity_keys (session_id, answer_key)
    values (v_session.id, coalesce(p_answer_key, '{}'::jsonb));
  exception
    when unique_violation then
      select session.*
        into v_session
        from public.wolfie_activity_sessions as session
       where session.tenant_id = p_tenant_id
         and session.student_id = p_student_id
         and session.request_key = p_request_key;
      if not found then
        raise;
      end if;
      if v_session.subject is distinct from p_subject
         or v_session.cefr_level is distinct from p_cefr_level
         or v_session.phase is distinct from p_phase
         or v_session.modality is distinct from p_modality
         or v_session.source_session_id is distinct from p_source_session_id then
        raise exception 'activity_request_key_reused';
      end if;
  end;

  return pg_catalog.to_jsonb(v_session);
end;
$function$;

revoke all on function public.claim_wolfie_ai_request(
  text,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.claim_wolfie_ai_request(
  text,
  uuid,
  uuid,
  text
) to service_role;

revoke all on function public.finish_wolfie_ai_request(
  text,
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.finish_wolfie_ai_request(
  text,
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  text
) to service_role;

revoke all on function public.create_wolfie_activity_session(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  jsonb,
  jsonb,
  text[],
  text[]
) from public, anon, authenticated;
grant execute on function public.create_wolfie_activity_session(
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  jsonb,
  jsonb,
  text[],
  text[]
) to service_role;

-- Keep the pre-tenant RPC contracts available to the previous Edge Function
-- during a rollback. Tenant scope is still resolved server-side from the
-- learner's selected ACTIVE membership; these overloads never trust a caller
-- supplied or legacy profiles.tenant_id value.
create or replace function public.claim_wolfie_ai_request(
  p_student_id uuid,
  p_request_key uuid,
  p_operation text
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select public.claim_wolfie_ai_request(
    private.active_tenant_id(p_student_id),
    p_student_id,
    p_request_key,
    p_operation
  );
$function$;

create or replace function public.finish_wolfie_ai_request(
  p_student_id uuid,
  p_request_key uuid,
  p_lease_token uuid,
  p_status text,
  p_response_payload jsonb default '{}'::jsonb,
  p_error_code text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select public.finish_wolfie_ai_request(
    private.active_tenant_id(p_student_id),
    p_student_id,
    p_request_key,
    p_lease_token,
    p_status,
    p_response_payload,
    p_error_code
  );
$function$;

create or replace function public.create_wolfie_activity_session(
  p_student_id uuid,
  p_subject text,
  p_cefr_level text,
  p_sector text,
  p_phase text,
  p_modality text,
  p_source_session_id uuid,
  p_request_key uuid,
  p_activity_content jsonb,
  p_answer_key jsonb,
  p_reused_terms text[],
  p_introduced_terms text[]
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select public.create_wolfie_activity_session(
    private.active_tenant_id(p_student_id),
    p_student_id,
    p_subject,
    p_cefr_level,
    p_sector,
    p_phase,
    p_modality,
    p_source_session_id,
    p_request_key,
    p_activity_content,
    p_answer_key,
    p_reused_terms,
    p_introduced_terms
  );
$function$;

revoke all on function public.claim_wolfie_ai_request(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_wolfie_ai_request(uuid, uuid, text)
  to service_role;
revoke all on function public.finish_wolfie_ai_request(
  uuid, uuid, uuid, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.finish_wolfie_ai_request(
  uuid, uuid, uuid, text, jsonb, text
) to service_role;
revoke all on function public.create_wolfie_activity_session(
  uuid, text, text, text, text, text, uuid, uuid, jsonb, jsonb, text[], text[]
) from public, anon, authenticated;
grant execute on function public.create_wolfie_activity_session(
  uuid, text, text, text, text, text, uuid, uuid, jsonb, jsonb, text[], text[]
) to service_role;

-- Repertoire and learning-event idempotency must not move a learner's term
-- from one school to another when the same term/event key is reused.
create or replace function public.apply_wolfie_repertoire_event(
  p_session_id uuid,
  p_term_key text,
  p_term text,
  p_translation text,
  p_definition_pt text,
  p_example_sentence text,
  p_event_type text,
  p_event_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_session public.wolfie_activity_sessions%rowtype;
  v_event_id uuid;
  v_repertoire_id uuid;
  v_term_key text;
  v_delta integer;
  v_mastery integer;
  v_review_days integer;
begin
  v_term_key := pg_catalog.left(
    pg_catalog.btrim(pg_catalog.lower(coalesce(p_term_key, ''))),
    160
  );
  if v_term_key = ''
     or pg_catalog.btrim(coalesce(p_term, '')) = ''
     or pg_catalog.char_length(coalesce(p_event_key, '')) not between 1 and 300
     or p_event_type not in (
       'EXPOSED',
       'ANSWERED_CORRECTLY',
       'ANSWERED_INCORRECTLY',
       'USED_WITH_GUIDANCE',
       'USED_INDEPENDENTLY',
       'PRONOUNCED_SUCCESSFULLY'
     ) then
    raise exception 'invalid_repertoire_event';
  end if;

  select session.*
    into v_session
    from public.wolfie_activity_sessions as session
   where session.id = p_session_id;
  if not found then
    raise exception 'wolfie_session_not_found';
  end if;

  insert into public.wolfie_learning_events (
    tenant_id,
    student_id,
    session_id,
    event_type,
    subject,
    cefr_level,
    event_key,
    metadata,
    test_fixture
  ) values (
    v_session.tenant_id,
    v_session.student_id,
    v_session.id,
    p_event_type,
    v_session.subject,
    v_session.cefr_level,
    p_event_key,
    pg_catalog.jsonb_build_object(
      'term', pg_catalog.left(pg_catalog.btrim(p_term), 120),
      'phase', v_session.phase
    ),
    v_session.test_fixture
  )
  on conflict (tenant_id, student_id, event_key)
    where event_key is not null
    do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'eventKey', p_event_key
    );
  end if;

  v_delta := case p_event_type
    when 'ANSWERED_CORRECTLY' then 12
    when 'ANSWERED_INCORRECTLY' then -8
    when 'USED_INDEPENDENTLY' then 18
    when 'PRONOUNCED_SUCCESSFULLY' then 15
    when 'USED_WITH_GUIDANCE' then 7
    else 2
  end;

  insert into public.wolfie_repertoire (
    tenant_id,
    student_id,
    term_key,
    term,
    translation,
    definition_pt,
    example_sentence,
    cefr_level,
    source_subject,
    source_session_id,
    sector,
    mastery_score,
    exposure_count,
    correct_count,
    incorrect_count,
    independent_use_count,
    pronunciation_success_count,
    last_seen_at,
    next_review_at
  ) values (
    v_session.tenant_id,
    v_session.student_id,
    v_term_key,
    pg_catalog.left(pg_catalog.btrim(p_term), 120),
    nullif(pg_catalog.left(pg_catalog.btrim(p_translation), 240), ''),
    nullif(pg_catalog.left(pg_catalog.btrim(p_definition_pt), 500), ''),
    nullif(pg_catalog.left(pg_catalog.btrim(p_example_sentence), 500), ''),
    v_session.cefr_level,
    v_session.subject,
    v_session.id,
    v_session.sector,
    greatest(0, least(100, v_delta)),
    1,
    case when p_event_type = 'ANSWERED_CORRECTLY' then 1 else 0 end,
    case when p_event_type = 'ANSWERED_INCORRECTLY' then 1 else 0 end,
    case when p_event_type = 'USED_INDEPENDENTLY' then 1 else 0 end,
    case when p_event_type = 'PRONOUNCED_SUCCESSFULLY' then 1 else 0 end,
    pg_catalog.now(),
    pg_catalog.now()
  )
  on conflict (tenant_id, student_id, term_key) do update
    set term = excluded.term,
        translation = coalesce(
          excluded.translation,
          public.wolfie_repertoire.translation
        ),
        definition_pt = coalesce(
          excluded.definition_pt,
          public.wolfie_repertoire.definition_pt
        ),
        example_sentence = coalesce(
          excluded.example_sentence,
          public.wolfie_repertoire.example_sentence
        ),
        cefr_level = excluded.cefr_level,
        source_subject = excluded.source_subject,
        source_session_id = excluded.source_session_id,
        sector = excluded.sector,
        mastery_score = greatest(
          0,
          least(100, public.wolfie_repertoire.mastery_score + v_delta)
        ),
        exposure_count = public.wolfie_repertoire.exposure_count + 1,
        correct_count = public.wolfie_repertoire.correct_count
          + case when p_event_type = 'ANSWERED_CORRECTLY' then 1 else 0 end,
        incorrect_count = public.wolfie_repertoire.incorrect_count
          + case when p_event_type = 'ANSWERED_INCORRECTLY' then 1 else 0 end,
        independent_use_count =
          public.wolfie_repertoire.independent_use_count
          + case when p_event_type = 'USED_INDEPENDENTLY' then 1 else 0 end,
        pronunciation_success_count =
          public.wolfie_repertoire.pronunciation_success_count
          + case
              when p_event_type = 'PRONOUNCED_SUCCESSFULLY' then 1
              else 0
            end,
        last_seen_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
  returning id, mastery_score into v_repertoire_id, v_mastery;

  v_review_days := case
    when v_mastery >= 85 then 21
    when v_mastery >= 65 then 10
    when v_mastery >= 40 then 5
    else 2
  end;

  update public.wolfie_repertoire
     set next_review_at = pg_catalog.now()
       + pg_catalog.make_interval(days => v_review_days)
   where id = v_repertoire_id;

  update public.wolfie_learning_events
     set repertoire_id = v_repertoire_id
   where id = v_event_id;

  return pg_catalog.jsonb_build_object(
    'applied', true,
    'eventKey', p_event_key,
    'repertoireId', v_repertoire_id,
    'masteryScore', v_mastery
  );
end;
$function$;

revoke all on function public.apply_wolfie_repertoire_event(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.apply_wolfie_repertoire_event(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to service_role;

-- A Realtime connection receives a server reservation before the paid call is
-- opened. Concurrent connections therefore see each other's reserved budget.
create table if not exists public.wolfie_live_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid not null references public.wolfie_sessions(id)
    on delete cascade,
  status text not null default 'RESERVED' check (
    status in (
      'RESERVED',
      'ACTIVE',
      'CLOSING',
      'SETTLED',
      'RELEASED',
      'EXPIRED'
    )
  ),
  enforced boolean not null default false,
  reserved_seconds integer not null check (reserved_seconds between 1 and 600),
  client_max_seconds integer not null check (
    client_max_seconds between 1 and 580
    and client_max_seconds < reserved_seconds
  ),
  reserved_plan_seconds integer not null default 0 check (
    reserved_plan_seconds between 0 and 600
  ),
  reserved_credit_seconds integer not null default 0 check (
    reserved_credit_seconds between 0 and 600
  ),
  consumed_seconds integer not null default 0 check (
    consumed_seconds between 0 and 600
  ),
  client_reported_seconds integer check (
    client_reported_seconds is null
    or client_reported_seconds between 0 and 3600
  ),
  provider_call_id text check (
    provider_call_id is null
    or char_length(provider_call_id) between 1 and 200
  ),
  reservation_expires_at timestamptz not null,
  started_at timestamptz,
  lease_expires_at timestamptz not null,
  close_requested_at timestamptz,
  close_reason text check (close_reason in ('CLIENT', 'LEASE_EXPIRED')),
  cleanup_lease_expires_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wolfie_live_grants_reservation_split_check check (
    reserved_plan_seconds + reserved_credit_seconds = reserved_seconds
  ),
  constraint wolfie_live_grants_scope_fkey
    foreign key (session_id, student_id, tenant_id)
    references public.wolfie_sessions (id, student_id, tenant_id)
    on delete cascade
);

alter table public.wolfie_live_grants
  add column if not exists provider_call_id text,
  add column if not exists client_max_seconds integer,
  add column if not exists close_requested_at timestamptz,
  add column if not exists close_reason text,
  add column if not exists cleanup_lease_expires_at timestamptz;
update public.wolfie_live_grants
   set client_max_seconds = greatest(1, least(reserved_seconds - 1, 580))
 where client_max_seconds is null;
alter table public.wolfie_live_grants
  alter column client_max_seconds set not null;
alter table public.wolfie_live_grants
  drop constraint if exists wolfie_live_grants_client_max_seconds_check;
alter table public.wolfie_live_grants
  add constraint wolfie_live_grants_client_max_seconds_check check (
    client_max_seconds between 1 and 580
    and client_max_seconds < reserved_seconds
  );
alter table public.wolfie_live_grants
  drop constraint if exists wolfie_live_grants_status_check;
alter table public.wolfie_live_grants
  add constraint wolfie_live_grants_status_check check (
    status in (
      'RESERVED',
      'ACTIVE',
      'CLOSING',
      'SETTLED',
      'RELEASED',
      'EXPIRED'
    )
  );
alter table public.wolfie_live_grants
  drop constraint if exists wolfie_live_grants_close_reason_check;
alter table public.wolfie_live_grants
  add constraint wolfie_live_grants_close_reason_check check (
    close_reason is null or close_reason in ('CLIENT', 'LEASE_EXPIRED')
  );
alter table public.wolfie_live_grants
  drop constraint if exists wolfie_live_grants_provider_call_id_check;
alter table public.wolfie_live_grants
  add constraint wolfie_live_grants_provider_call_id_check check (
    provider_call_id is null
    or char_length(provider_call_id) between 1 and 200
  );

drop index if exists public.idx_wolfie_live_grants_one_connection;
create unique index idx_wolfie_live_grants_one_connection
  on public.wolfie_live_grants (tenant_id, student_id)
  where status in ('RESERVED', 'ACTIVE', 'CLOSING');
create index if not exists idx_wolfie_live_grants_balance
  on public.wolfie_live_grants (tenant_id, student_id, status, lease_expires_at);
create unique index if not exists idx_wolfie_live_grants_provider_call
  on public.wolfie_live_grants (provider_call_id)
  where provider_call_id is not null;
create index if not exists idx_wolfie_live_grants_cleanup_active
  on public.wolfie_live_grants (lease_expires_at, id)
  where status = 'ACTIVE';
create index if not exists idx_wolfie_live_grants_cleanup_closing
  on public.wolfie_live_grants (
    cleanup_lease_expires_at,
    (coalesce(close_requested_at, lease_expires_at)),
    id
  )
  where status = 'CLOSING';

alter table public.wolfie_live_grants enable row level security;
revoke all on table public.wolfie_live_grants
  from public, anon, authenticated;
grant all on table public.wolfie_live_grants to service_role;

-- Plan assignment belongs to the learner's tenant membership. The legacy
-- profiles.fidelity_plan value is backfilled only for the legacy primary
-- tenant; it is never reused as authority for a secondary school.
create unique index if not exists idx_student_pricing_plans_scope
  on public.student_pricing_plans (id, tenant_id);
alter table public.tenant_memberships
  add column if not exists student_plan_id uuid;
update public.tenant_memberships as membership
   set student_plan_id = pricing_plan.id,
       updated_at = pg_catalog.now()
  from public.profiles as profile
  join public.student_pricing_plans as pricing_plan
    on pricing_plan.tenant_id = profile.tenant_id
   and pricing_plan.name = profile.fidelity_plan
 where membership.user_id = profile.id
   and membership.tenant_id = profile.tenant_id
   and membership.role = 'STUDENT'
   and membership.student_plan_id is null;
alter table public.tenant_memberships
  drop constraint if exists tenant_memberships_student_plan_scope_fkey;
alter table public.tenant_memberships
  add constraint tenant_memberships_student_plan_scope_fkey
  foreign key (student_plan_id, tenant_id)
  references public.student_pricing_plans (id, tenant_id)
  on delete restrict;

create or replace function private.sync_primary_membership_student_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile_tenant text;
  v_plan_name text;
begin
  if tg_table_name = 'profiles' then
    update public.tenant_memberships as membership
       set student_plan_id = (
             select pricing_plan.id
               from public.student_pricing_plans as pricing_plan
              where pricing_plan.tenant_id = new.tenant_id
                and pricing_plan.name = new.fidelity_plan
              order by pricing_plan.id
              limit 1
           ),
           updated_at = pg_catalog.now()
     where membership.user_id = new.id
       and membership.tenant_id = new.tenant_id
       and membership.role = 'STUDENT';
    return new;
  end if;

  if new.role <> 'STUDENT' or new.student_plan_id is not null then
    return new;
  end if;
  select profile.tenant_id, profile.fidelity_plan
    into v_profile_tenant, v_plan_name
    from public.profiles as profile
   where profile.id = new.user_id;
  if v_profile_tenant = new.tenant_id then
    select pricing_plan.id
      into new.student_plan_id
      from public.student_pricing_plans as pricing_plan
     where pricing_plan.tenant_id = new.tenant_id
       and pricing_plan.name = v_plan_name
     order by pricing_plan.id
     limit 1;
  end if;
  return new;
end;
$function$;

drop trigger if exists sync_profile_primary_student_plan
  on public.profiles;
create trigger sync_profile_primary_student_plan
after insert or update of tenant_id, fidelity_plan, role on public.profiles
for each row
when (new.role = 'STUDENT')
execute function private.sync_primary_membership_student_plan();

drop trigger if exists sync_membership_primary_student_plan
  on public.tenant_memberships;
create trigger sync_membership_primary_student_plan
before insert or update of tenant_id, role, student_plan_id
on public.tenant_memberships
for each row
execute function private.sync_primary_membership_student_plan();
revoke all on function private.sync_primary_membership_student_plan()
  from public, anon, authenticated;

-- Unlimited access is an explicit mode. A missing entitlement and a LIMITED
-- entitlement with zero minutes both fail closed for free plan capacity.
alter table public.student_plan_entitlements
  add column if not exists access_mode text not null default 'LIMITED';
-- Before this hardening migration, zero meant unlimited. Preserve existing
-- contracts once, converting that implicit legacy meaning into explicit data.
update public.student_plan_entitlements
   set access_mode = 'UNLIMITED'
 where limit_value <= 0
   and access_mode = 'LIMITED';
alter table public.student_plan_entitlements
  drop constraint if exists student_plan_entitlements_access_mode_check;
alter table public.student_plan_entitlements
  add constraint student_plan_entitlements_access_mode_check check (
    access_mode in ('LIMITED', 'UNLIMITED')
  );

-- NULL values do not conflict under the legacy three-column UNIQUE
-- constraint. Keep the newest tenant default deterministically, then make a
-- single default enforceable under concurrency.
with ranked_defaults as (
  select
    entitlement.id,
    pg_catalog.row_number() over (
      partition by entitlement.tenant_id, entitlement.feature_key
      order by entitlement.created_at desc, entitlement.id desc
    ) as default_rank
  from public.student_plan_entitlements as entitlement
  where entitlement.plan_id is null
)
delete from public.student_plan_entitlements as entitlement
using ranked_defaults as ranked
where entitlement.id = ranked.id
  and ranked.default_rank > 1;

create unique index if not exists idx_student_plan_entitlements_default_once
  on public.student_plan_entitlements (tenant_id, feature_key)
  where plan_id is null;

-- Replace the tenant-implicit administrative RPCs while preserving their
-- signatures for the current dashboard. Both resolve the selected tenant and
-- require an ACTIVE membership in that tenant, including SUPER_ADMIN callers.
create or replace function public.save_realtime_settings(
  p_enabled boolean,
  p_monthly_token_quota bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id text;
  v_role text;
begin
  v_tenant_id := private.active_tenant_id(v_user_id);
  v_role := private.active_tenant_role(v_user_id);

  if v_user_id is null
     or v_tenant_id is null
     or v_role is null
     or v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
     or not exists (
       select 1
         from public.tenant_memberships as membership
        where membership.user_id = v_user_id
          and membership.tenant_id = v_tenant_id
          and membership.status = 'ACTIVE'
     ) then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  if p_monthly_token_quota is null or p_monthly_token_quota < 0 then
    raise exception using errcode = '22023', message = 'cota_invalida';
  end if;

  insert into public.tenant_realtime_settings as settings (
    tenant_id,
    enabled,
    monthly_token_quota,
    updated_at,
    updated_by
  ) values (
    v_tenant_id,
    coalesce(p_enabled, false),
    p_monthly_token_quota,
    pg_catalog.now(),
    v_user_id
  )
  on conflict (tenant_id) do update
    set enabled = excluded.enabled,
        monthly_token_quota = excluded.monthly_token_quota,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'tenantId', v_tenant_id,
    'enabled', coalesce(p_enabled, false),
    'quota', p_monthly_token_quota
  );
end;
$function$;

create or replace function public.set_student_plan_entitlement(
  p_plan_id uuid,
  p_feature_key text,
  p_limit_value integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id text;
  v_role text;
  v_limit_value integer;
  v_access_mode text;
begin
  v_tenant_id := private.active_tenant_id(v_user_id);
  v_role := private.active_tenant_role(v_user_id);

  if v_user_id is null
     or v_tenant_id is null
     or v_role is null
     or v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
     or not exists (
       select 1
         from public.tenant_memberships as membership
        where membership.user_id = v_user_id
          and membership.tenant_id = v_tenant_id
          and membership.status = 'ACTIVE'
     ) then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  if p_feature_key is distinct from 'wolfie.live_minutes' then
    raise exception using
      errcode = '22023',
      message = 'apenas_voz_ao_vivo_pode_ter_limite';
  end if;
  if p_limit_value is null or p_limit_value < 0 then
    raise exception using errcode = '22023', message = 'limite_invalido';
  end if;
  if p_plan_id is not null and not exists (
    select 1
      from public.student_pricing_plans as pricing_plan
     where pricing_plan.id = p_plan_id
       and pricing_plan.tenant_id = v_tenant_id
  ) then
    raise exception using errcode = '23503', message = 'plano_fora_do_tenant';
  end if;

  v_limit_value := p_limit_value;
  v_access_mode := case
    when v_limit_value = 0 then 'UNLIMITED'
    else 'LIMITED'
  end;

  if p_plan_id is null then
    insert into public.student_plan_entitlements as entitlement (
      tenant_id,
      plan_id,
      feature_key,
      limit_value,
      reset_period,
      access_mode
    ) values (
      v_tenant_id,
      null,
      p_feature_key,
      v_limit_value,
      'MONTH',
      v_access_mode
    )
    on conflict (tenant_id, feature_key) where plan_id is null do update
      set limit_value = excluded.limit_value,
          reset_period = excluded.reset_period,
          access_mode = excluded.access_mode;
  else
    insert into public.student_plan_entitlements as entitlement (
      tenant_id,
      plan_id,
      feature_key,
      limit_value,
      reset_period,
      access_mode
    ) values (
      v_tenant_id,
      p_plan_id,
      p_feature_key,
      v_limit_value,
      'MONTH',
      v_access_mode
    )
    on conflict on constraint student_plan_entitlements_unique do update
      set limit_value = excluded.limit_value,
          reset_period = excluded.reset_period,
          access_mode = excluded.access_mode;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'tenantId', v_tenant_id,
    'planId', p_plan_id,
    'featureKey', p_feature_key,
    'limit', v_limit_value,
    'accessMode', v_access_mode
  );
end;
$function$;

revoke all on function public.save_realtime_settings(boolean, bigint)
  from public, anon, authenticated;
grant execute on function public.save_realtime_settings(boolean, bigint)
  to authenticated;
revoke all on function public.set_student_plan_entitlement(
  uuid, text, integer
) from public, anon, authenticated;
grant execute on function public.set_student_plan_entitlement(
  uuid, text, integer
) to authenticated;

-- Split every settled duration between monthly plan allowance and consumable
-- top-up credit. Top-up consumption is lifetime, so it cannot reappear next
-- month.
alter table public.student_live_minutes
  add column if not exists grant_id uuid,
  add column if not exists plan_seconds integer not null default 0,
  add column if not exists credit_seconds integer not null default 0;

update public.student_live_minutes
   set plan_seconds = greatest(coalesce(seconds, 0), 0),
       credit_seconds = 0
 where plan_seconds + credit_seconds is distinct from greatest(
   coalesce(seconds, 0),
   0
 );

-- Backfill legacy overage conservatively using the current tenant/plan
-- entitlement. Deployments that never shipped the old ledger simply update
-- zero rows; deployments with usage stop renewing already-spent top-ups.
with entitlement as (
  select
    membership.tenant_id,
    membership.user_id as student_id,
    entitlement.limit_value as limit_minutes,
    entitlement.access_mode
  from public.tenant_memberships as membership
  left join lateral (
    select candidate.limit_value, candidate.access_mode
      from public.student_plan_entitlements as candidate
     where candidate.tenant_id = membership.tenant_id
       and candidate.feature_key = 'wolfie.live_minutes'
       and (
         candidate.plan_id = membership.student_plan_id
         or candidate.plan_id is null
       )
     order by candidate.plan_id nulls last, candidate.created_at desc,
       candidate.id
     limit 1
  ) as entitlement on true
  where membership.status = 'ACTIVE'
    and membership.role = 'STUDENT'
), ordered_usage as (
  select
    minutes.id,
    minutes.seconds,
    case
      when entitlement.access_mode = 'UNLIMITED' then 2147483647
      else greatest(coalesce(entitlement.limit_minutes, 0), 0) * 60
    end as plan_limit_seconds,
    coalesce(
      sum(minutes.seconds) over (
        partition by
          minutes.tenant_id,
          minutes.student_id,
          date_trunc('month', minutes.created_at)
        order by minutes.created_at, minutes.id
        rows between unbounded preceding and 1 preceding
      ),
      0
    )::integer as prior_seconds
  from public.student_live_minutes as minutes
  left join entitlement
    on entitlement.tenant_id = minutes.tenant_id
   and entitlement.student_id = minutes.student_id
), allocation as (
  select
    id,
    case
      when plan_limit_seconds <= 0 then 0
      else greatest(
        0,
        least(seconds, prior_seconds + seconds - plan_limit_seconds)
      )
    end as credit_seconds
  from ordered_usage
)
update public.student_live_minutes as minutes
   set credit_seconds = allocation.credit_seconds,
       plan_seconds = minutes.seconds - allocation.credit_seconds
  from allocation
 where allocation.id = minutes.id;

alter table public.student_live_minutes
  drop constraint if exists student_live_minutes_allocation_check;
alter table public.student_live_minutes
  add constraint student_live_minutes_allocation_check check (
    plan_seconds >= 0
    and credit_seconds >= 0
    and plan_seconds + credit_seconds = seconds
  );
alter table public.student_live_minutes
  drop constraint if exists student_live_minutes_grant_fkey;
alter table public.student_live_minutes
  add constraint student_live_minutes_grant_fkey
  foreign key (grant_id) references public.wolfie_live_grants(id)
  on delete restrict;
create unique index if not exists idx_student_live_minutes_grant_once
  on public.student_live_minutes (grant_id)
  where grant_id is not null;

-- A paid top-up is anchored to a server-authored immutable order. The Asaas
-- reference contains only this UUID; tenant, learner, quantity and price are
-- never reconstructed from profiles or webhook-controlled text.
create table if not exists public.wolfie_topup_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  request_key uuid not null,
  package_id uuid not null references public.wolfie_topup_packages(id)
    on delete restrict,
  package_name text not null check (char_length(package_name) between 1 and 160),
  minutes integer not null check (minutes > 0),
  amount_brl numeric(10, 2) not null check (amount_brl >= 0),
  status text not null default 'PENDING' check (
    status in (
      'PENDING',
      'CREATING',
      'AWAITING_PAYMENT',
      'PAID',
      'SUSPENDED',
      'REVERSED',
      'FAILED',
      'RECONCILIATION_REQUIRED'
    )
  ),
  provider_payment_id text,
  creation_lease_expires_at timestamptz,
  creation_attempts integer not null default 0 check (
    creation_attempts between 0 and 20
  ),
  paid_at timestamptz,
  reversed_at timestamptz,
  reversal_event text,
  refunded_amount_brl numeric(10, 2),
  reconciliation_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wolfie_topup_orders_membership_scope_fkey
    foreign key (student_id, tenant_id)
    references public.tenant_memberships (user_id, tenant_id)
    on delete restrict,
  constraint wolfie_topup_orders_provider_payment_check check (
    provider_payment_id is null
    or char_length(provider_payment_id) between 1 and 200
  )
);

alter table public.wolfie_topup_orders
  add column if not exists request_key uuid,
  add column if not exists creation_lease_expires_at timestamptz,
  add column if not exists creation_attempts integer not null default 0,
  add column if not exists refunded_amount_brl numeric(10, 2),
  add column if not exists reconciliation_required boolean not null
    default false;
update public.wolfie_topup_orders
   set request_key = gen_random_uuid()
 where request_key is null;
alter table public.wolfie_topup_orders
  alter column request_key set not null;
alter table public.wolfie_topup_orders
  drop constraint if exists wolfie_topup_orders_status_check;
alter table public.wolfie_topup_orders
  add constraint wolfie_topup_orders_status_check check (
    status in (
      'PENDING',
      'CREATING',
      'AWAITING_PAYMENT',
      'PAID',
      'SUSPENDED',
      'REVERSED',
      'FAILED',
      'RECONCILIATION_REQUIRED'
    )
  );
alter table public.wolfie_topup_orders
  drop constraint if exists wolfie_topup_orders_creation_attempts_check;
alter table public.wolfie_topup_orders
  add constraint wolfie_topup_orders_creation_attempts_check check (
    creation_attempts between 0 and 20
  );
alter table public.wolfie_topup_orders
  drop constraint if exists wolfie_topup_orders_refunded_amount_check;
alter table public.wolfie_topup_orders
  add constraint wolfie_topup_orders_refunded_amount_check check (
    refunded_amount_brl is null or refunded_amount_brl >= 0
  );

create unique index if not exists idx_wolfie_topup_packages_scope
  on public.wolfie_topup_packages (id, tenant_id);
alter table public.wolfie_topup_orders
  drop constraint if exists wolfie_topup_orders_package_scope_fkey;
alter table public.wolfie_topup_orders
  add constraint wolfie_topup_orders_package_scope_fkey
  foreign key (package_id, tenant_id)
  references public.wolfie_topup_packages (id, tenant_id)
  on delete restrict;

create unique index if not exists idx_wolfie_topup_orders_provider_payment
  on public.wolfie_topup_orders (provider_payment_id)
  where provider_payment_id is not null;
create index if not exists idx_wolfie_topup_orders_student_created
  on public.wolfie_topup_orders (tenant_id, student_id, created_at desc);
create unique index if not exists idx_wolfie_topup_orders_request_once
  on public.wolfie_topup_orders (tenant_id, student_id, request_key);

alter table public.student_minute_credits
  add column if not exists order_id uuid,
  add column if not exists status text not null default 'PAID',
  add column if not exists reversed_at timestamptz,
  add column if not exists reversal_event text;
update public.student_minute_credits
   set status = 'PAID'
 where status is null;
alter table public.student_minute_credits
  drop constraint if exists student_minute_credits_status_check;
alter table public.student_minute_credits
  add constraint student_minute_credits_status_check check (
    status in ('PAID', 'SUSPENDED', 'REVERSED')
  );
alter table public.student_minute_credits
  drop constraint if exists student_minute_credits_order_fkey;
alter table public.student_minute_credits
  add constraint student_minute_credits_order_fkey
  foreign key (order_id) references public.wolfie_topup_orders(id)
  on delete restrict;
create unique index if not exists idx_student_minute_credits_order_once
  on public.student_minute_credits (order_id)
  where order_id is not null;

alter table public.wolfie_topup_orders enable row level security;
revoke all on table public.wolfie_topup_orders
  from public, anon, authenticated;
grant select on table public.wolfie_topup_orders to authenticated;
grant all on table public.wolfie_topup_orders to service_role;
drop policy if exists wolfie_topup_orders_read_own
  on public.wolfie_topup_orders;
create policy wolfie_topup_orders_read_own on public.wolfie_topup_orders
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and exists (
      select 1
        from public.tenant_memberships as membership
       where membership.user_id = (select auth.uid())
         and membership.tenant_id = wolfie_topup_orders.tenant_id
         and membership.status = 'ACTIVE'
         and membership.role = 'STUDENT'
    )
  );

create or replace function public.claim_wolfie_topup_order_creation(
  p_tenant_id text,
  p_student_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.wolfie_topup_orders%rowtype;
begin
  if p_tenant_id is null or p_student_id is null or p_order_id is null then
    raise exception 'invalid_wolfie_topup_creation_claim';
  end if;
  select *
    into v_order
    from public.wolfie_topup_orders
   where id = p_order_id
     and tenant_id = p_tenant_id
     and student_id = p_student_id
   for update;
  if not found then
    raise exception using errcode = '42501', message = 'topup_order_not_owned';
  end if;
  if v_order.provider_payment_id is not null then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'reason', 'payment_already_linked',
      'paymentId', v_order.provider_payment_id
    );
  end if;
  if v_order.status not in ('PENDING', 'CREATING') then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'reason', pg_catalog.lower(v_order.status)
    );
  end if;
  if v_order.status = 'CREATING'
     and v_order.creation_lease_expires_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'reason', 'creation_in_progress',
      'retryAfter', v_order.creation_lease_expires_at
    );
  end if;
  if v_order.creation_attempts >= 20 then
    update public.wolfie_topup_orders
       set status = 'RECONCILIATION_REQUIRED',
           reconciliation_required = true,
           updated_at = pg_catalog.now()
     where id = v_order.id;
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'reason', 'reconciliation_required'
    );
  end if;

  update public.wolfie_topup_orders
     set status = 'CREATING',
         creation_lease_expires_at = pg_catalog.now() + interval '90 seconds',
         creation_attempts = creation_attempts + 1,
         updated_at = pg_catalog.now()
   where id = v_order.id;
  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'orderId', v_order.id
  );
end;
$function$;

-- A durable, sanitized inbox prevents old tenant-less references from
-- poisoning the Asaas delivery queue. They are acknowledged only after this
-- row exists and remain visible for explicit manual reconciliation.
create table if not exists public.wolfie_topup_webhook_inbox (
  provider_event_id text primary key check (
    char_length(provider_event_id) between 1 and 240
  ),
  event_type text not null check (char_length(event_type) between 1 and 120),
  provider_payment_id text not null check (
    char_length(provider_payment_id) between 1 and 200
  ),
  external_reference text not null check (
    char_length(external_reference) between 1 and 300
  ),
  payment_amount_brl numeric(10, 2),
  refunded_amount_brl numeric(10, 2),
  billing_type text,
  processing_status text not null check (
    processing_status in (
      'RECEIVED',
      'APPLIED',
      'IGNORED',
      'LEGACY_REVIEW',
      'FAILED'
    )
  ),
  last_error text,
  delivery_count integer not null default 1 check (delivery_count > 0),
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint wolfie_topup_webhook_amount_check check (
    payment_amount_brl is null or payment_amount_brl >= 0
  ),
  constraint wolfie_topup_webhook_refund_check check (
    refunded_amount_brl is null or refunded_amount_brl >= 0
  )
);
alter table public.wolfie_topup_webhook_inbox enable row level security;
revoke all on table public.wolfie_topup_webhook_inbox
  from public, anon, authenticated;
grant all on table public.wolfie_topup_webhook_inbox to service_role;

drop function if exists public.credit_wolfie_minutes(uuid, integer, text);
drop function if exists public.apply_wolfie_topup_payment(
  uuid,
  text,
  text,
  numeric
);
create or replace function public.apply_wolfie_topup_payment(
  p_order_id uuid,
  p_payment_id text,
  p_event text,
  p_amount_brl numeric,
  p_refunded_amount_brl numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.wolfie_topup_orders%rowtype;
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_is_paid boolean := p_event in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED');
  v_is_reversal boolean := p_event in (
    'PAYMENT_DELETED',
    'PAYMENT_REFUNDED',
    'PAYMENT_CHARGEBACK_REQUESTED',
    'PAYMENT_RECEIVED_IN_CASH_UNDONE'
  );
  v_is_freeze boolean := p_event in (
    'PAYMENT_PARTIALLY_REFUNDED',
    'PAYMENT_REFUND_IN_PROGRESS'
  );
begin
  if p_order_id is null
     or v_payment_id is null
     or pg_catalog.char_length(v_payment_id) > 200
     or (not v_is_paid and not v_is_reversal and not v_is_freeze)
     or p_amount_brl is null
     or (
       p_refunded_amount_brl is not null
       and p_refunded_amount_brl < 0
     ) then
    raise exception 'invalid_wolfie_topup_event';
  end if;

  select *
    into v_order
    from public.wolfie_topup_orders
   where id = p_order_id
   for update;
  if not found then
    raise exception 'wolfie_topup_order_not_found';
  end if;
  if pg_catalog.round(v_order.amount_brl, 2)
       is distinct from pg_catalog.round(p_amount_brl, 2) then
    raise exception 'wolfie_topup_amount_mismatch';
  end if;
  if v_order.provider_payment_id is not null
     and v_order.provider_payment_id <> v_payment_id then
    raise exception 'wolfie_topup_payment_mismatch';
  end if;
  if p_refunded_amount_brl is not null
     and pg_catalog.round(p_refunded_amount_brl, 2)
       > pg_catalog.round(v_order.amount_brl, 2) then
    raise exception 'wolfie_topup_refund_amount_mismatch';
  end if;

  if v_is_freeze then
    update public.student_minute_credits
       set status = 'SUSPENDED',
           reversal_event = p_event
     where order_id = v_order.id
       and status = 'PAID';
    update public.wolfie_topup_orders
       set status = 'SUSPENDED',
           provider_payment_id = coalesce(provider_payment_id, v_payment_id),
           reversal_event = p_event,
           refunded_amount_brl = coalesce(
             p_refunded_amount_brl,
             refunded_amount_brl
           ),
           reconciliation_required = true,
           updated_at = pg_catalog.now()
     where id = v_order.id
       and status <> 'REVERSED';
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'suspended', true,
      'reconciliationRequired', true,
      'tenantId', v_order.tenant_id,
      'studentId', v_order.student_id
    );
  end if;

  if v_is_reversal then
    update public.student_minute_credits
       set status = 'REVERSED',
           reversed_at = coalesce(reversed_at, pg_catalog.now()),
           reversal_event = p_event
     where order_id = v_order.id
       and status <> 'REVERSED';
    update public.wolfie_topup_orders
       set status = 'REVERSED',
           provider_payment_id = coalesce(provider_payment_id, v_payment_id),
           reversed_at = coalesce(reversed_at, pg_catalog.now()),
           reversal_event = p_event,
           refunded_amount_brl = coalesce(
             p_refunded_amount_brl,
             refunded_amount_brl,
             amount_brl
           ),
           reconciliation_required = false,
           updated_at = pg_catalog.now()
     where id = v_order.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'reversed', true,
      'tenantId', v_order.tenant_id,
      'studentId', v_order.student_id
    );
  end if;

  -- A paid event arriving after a refund/chargeback must never recreate the
  -- lifetime credit, even if Asaas delivers events out of order.
  if v_order.status in (
    'SUSPENDED',
    'REVERSED',
    'RECONCILIATION_REQUIRED'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'suspended', v_order.status <> 'REVERSED',
      'reversed', v_order.status = 'REVERSED',
      'idempotent', true
    );
  end if;

  insert into public.student_minute_credits (
    tenant_id,
    student_id,
    minutes,
    payment_id,
    order_id,
    status
  ) values (
    v_order.tenant_id,
    v_order.student_id,
    v_order.minutes,
    v_payment_id,
    v_order.id,
    'PAID'
  )
  on conflict (order_id) where order_id is not null do nothing;

  update public.wolfie_topup_orders
     set status = 'PAID',
         provider_payment_id = coalesce(provider_payment_id, v_payment_id),
         paid_at = coalesce(paid_at, pg_catalog.now()),
         creation_lease_expires_at = null,
         updated_at = pg_catalog.now()
   where id = v_order.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'paid', true,
    'tenantId', v_order.tenant_id,
    'studentId', v_order.student_id,
    'minutes', v_order.minutes
  );
end;
$function$;

revoke all on function public.apply_wolfie_topup_payment(
  uuid,
  text,
  text,
  numeric,
  numeric
) from public, anon, authenticated;
grant execute on function public.apply_wolfie_topup_payment(
  uuid,
  text,
  text,
  numeric,
  numeric
) to service_role;
revoke all on function public.claim_wolfie_topup_order_creation(
  text,
  uuid,
  uuid
) from public, anon, authenticated;
grant execute on function public.claim_wolfie_topup_order_creation(
  text,
  uuid,
  uuid
) to service_role;

revoke all on table public.student_plan_entitlements
  from public, anon, authenticated;
revoke all on table public.student_live_minutes
  from public, anon, authenticated;
revoke all on table public.student_minute_credits
  from public, anon, authenticated;
revoke all on table public.wolfie_topup_packages
  from public, anon, authenticated;
grant select on table public.student_plan_entitlements to authenticated;
grant select on table public.student_live_minutes to authenticated;
grant select on table public.student_minute_credits to authenticated;
grant select on table public.wolfie_topup_packages to authenticated;
grant all on table public.student_plan_entitlements to service_role;
grant all on table public.student_live_minutes to service_role;
grant all on table public.student_minute_credits to service_role;
grant all on table public.wolfie_topup_packages to service_role;

drop policy if exists spe_read on public.student_plan_entitlements;
create policy spe_read on public.student_plan_entitlements
  for select to authenticated
  using (tenant_id = (select public._my_tenant_id()));
drop policy if exists slm_read_own on public.student_live_minutes;
create policy slm_read_own on public.student_live_minutes
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
  );
drop policy if exists smc_read_own on public.student_minute_credits;
create policy smc_read_own on public.student_minute_credits
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
  );
drop policy if exists wtp_read on public.wolfie_topup_packages;
create policy wtp_read on public.wolfie_topup_packages
  for select to authenticated
  using (active and tenant_id = (select public._my_tenant_id()));

create or replace function private.wolfie_live_balance_snapshot(
  p_tenant_id text,
  p_student_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit_minutes integer;
  v_plan uuid;
  v_access_mode text;
  v_entitlement_state text;
  v_start timestamptz := date_trunc('month', pg_catalog.now());
  v_plan_used_seconds bigint := 0;
  v_credit_used_seconds bigint := 0;
  v_credit_used_this_month bigint := 0;
  v_credit_total_seconds bigint := 0;
  v_reserved_plan_seconds bigint := 0;
  v_reserved_credit_seconds bigint := 0;
  v_plan_remaining_seconds bigint;
  v_credit_remaining_seconds bigint;
  v_remaining_seconds bigint;
  v_display_used_seconds bigint;
begin
  select membership.student_plan_id
    into v_plan
    from public.tenant_memberships as membership
   where membership.user_id = p_student_id
     and membership.tenant_id = p_tenant_id
     and membership.status = 'ACTIVE'
     and membership.role = 'STUDENT';
  if not found then
    return pg_catalog.jsonb_build_object(
      'enforced', true,
      'allowed', false,
      'entitlementState', 'MEMBERSHIP_MISSING',
      'remainingSeconds', 0,
      'planRemainingSeconds', 0,
      'creditRemainingSeconds', 0
    );
  end if;

  select entitlement.limit_value, entitlement.access_mode
    into v_limit_minutes, v_access_mode
    from public.student_plan_entitlements as entitlement
   where entitlement.tenant_id = p_tenant_id
     and entitlement.feature_key = 'wolfie.live_minutes'
     and (entitlement.plan_id = v_plan or entitlement.plan_id is null)
   order by entitlement.plan_id nulls last,
     entitlement.created_at desc,
     entitlement.id
   limit 1;

  if found and v_access_mode = 'UNLIMITED' then
    return pg_catalog.jsonb_build_object(
      'enforced', false,
      'allowed', true,
      'entitlementState', 'UNLIMITED',
      'remainingSeconds', null,
      'planRemainingSeconds', null,
      'creditRemainingSeconds', null
    );
  end if;
  if not found then
    v_limit_minutes := 0;
    v_entitlement_state := 'MISSING';
  elsif coalesce(v_limit_minutes, 0) <= 0 then
    v_limit_minutes := 0;
    v_entitlement_state := 'ZERO';
  else
    v_entitlement_state := 'LIMITED';
  end if;

  select
    coalesce(pg_catalog.sum(minutes.plan_seconds), 0),
    coalesce(
      pg_catalog.sum(minutes.credit_seconds)
        filter (where minutes.created_at >= v_start),
      0
    )
    into v_plan_used_seconds, v_credit_used_this_month
    from public.student_live_minutes as minutes
   where minutes.tenant_id = p_tenant_id
     and minutes.student_id = p_student_id
     and minutes.created_at >= v_start
     and minutes.created_at < v_start + interval '1 month';

  select coalesce(pg_catalog.sum(minutes.credit_seconds), 0)
    into v_credit_used_seconds
    from public.student_live_minutes as minutes
   where minutes.tenant_id = p_tenant_id
     and minutes.student_id = p_student_id;

  select coalesce(pg_catalog.sum(credit.minutes), 0) * 60
    into v_credit_total_seconds
    from public.student_minute_credits as credit
   where credit.tenant_id = p_tenant_id
     and credit.student_id = p_student_id
     and credit.status = 'PAID';

  select
    coalesce(pg_catalog.sum(grant_row.reserved_plan_seconds), 0),
    coalesce(pg_catalog.sum(grant_row.reserved_credit_seconds), 0)
    into v_reserved_plan_seconds, v_reserved_credit_seconds
    from public.wolfie_live_grants as grant_row
   where grant_row.tenant_id = p_tenant_id
     and grant_row.student_id = p_student_id
     and (
       grant_row.status in ('ACTIVE', 'CLOSING')
       or (
         grant_row.status = 'RESERVED'
         and grant_row.reservation_expires_at > pg_catalog.now()
       )
     );

  v_plan_remaining_seconds := greatest(
    0,
    v_limit_minutes::bigint * 60
      - v_plan_used_seconds
      - v_reserved_plan_seconds
  );
  v_credit_remaining_seconds := greatest(
    0,
    v_credit_total_seconds
      - v_credit_used_seconds
      - v_reserved_credit_seconds
  );
  v_remaining_seconds := v_plan_remaining_seconds
    + v_credit_remaining_seconds;
  v_display_used_seconds := v_plan_used_seconds
    + v_credit_used_this_month
    + v_reserved_plan_seconds
    + v_reserved_credit_seconds;

  return pg_catalog.jsonb_build_object(
    'enforced', true,
    'allowed', v_remaining_seconds > 0,
    'entitlementState', v_entitlement_state,
    'used', pg_catalog.ceil(v_display_used_seconds / 60.0)::integer,
    'limit', pg_catalog.ceil(
      (v_display_used_seconds + v_remaining_seconds) / 60.0
    )::integer,
    'remaining', pg_catalog.ceil(v_remaining_seconds / 60.0)::integer,
    'remainingSeconds', v_remaining_seconds,
    'planLimit', v_limit_minutes,
    'planRemainingSeconds', v_plan_remaining_seconds,
    'credits', pg_catalog.floor(
      v_credit_remaining_seconds / 60.0
    )::integer,
    'creditRemainingSeconds', v_credit_remaining_seconds,
    'reservedSeconds', v_reserved_plan_seconds + v_reserved_credit_seconds
  );
end;
$function$;

revoke all on function private.wolfie_live_balance_snapshot(text, uuid)
  from public, anon, authenticated;
grant execute on function private.wolfie_live_balance_snapshot(text, uuid)
  to service_role;

create or replace function public.wolfie_live_balance(
  p_tenant_id text,
  p_student_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_tenant_id is null
     or p_student_id is null
     or not exists (
       select 1
         from public.profiles as profile
         join public.tenant_memberships as membership
           on membership.user_id = profile.id
          and membership.tenant_id = p_tenant_id
          and membership.status = 'ACTIVE'
          and membership.role = 'STUDENT'
        where profile.id = p_student_id
          and profile.role = 'STUDENT'
     ) then
    raise exception using
      errcode = '42501',
      message = 'student_active_tenant_membership_not_found';
  end if;

  return private.wolfie_live_balance_snapshot(p_tenant_id, p_student_id);
end;
$function$;

create or replace function public.my_wolfie_live_balance()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := (select auth.uid());
  v_tenant_id text;
begin
  if v_student_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  v_tenant_id := private.active_tenant_id(v_student_id);
  if v_tenant_id is null then
    raise exception using errcode = '42501', message = 'active_tenant_required';
  end if;
  return public.wolfie_live_balance(v_tenant_id, v_student_id);
end;
$function$;

create or replace function public.claim_wolfie_live_grant(
  p_tenant_id text,
  p_student_id uuid,
  p_session_id uuid,
  p_max_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_balance jsonb;
  v_enforced boolean;
  v_remaining_seconds integer;
  v_plan_remaining_seconds integer;
  v_reserved_seconds integer;
  v_client_max_seconds integer;
  v_reserved_plan_seconds integer;
  v_reserved_credit_seconds integer;
  v_grant_id uuid;
  v_recent_grants integer;
  v_classic_handoff_at timestamptz;
begin
  if p_tenant_id is null
     or p_student_id is null
     or p_session_id is null
     or p_max_seconds is null
     or p_max_seconds not between 35 and 600 then
    raise exception 'invalid_live_grant_request';
  end if;

  select session.classic_handoff_at
    into v_classic_handoff_at
    from public.wolfie_sessions as session
    join public.tenant_memberships as membership
      on membership.user_id = session.student_id
     and membership.tenant_id = session.tenant_id
     and membership.status = 'ACTIVE'
     and membership.role = 'STUDENT'
   where session.id = p_session_id
     and session.student_id = p_student_id
     and session.tenant_id = p_tenant_id
     and session.finished_at is null
     and session.scenario_status not in ('completed', 'abandoned', 'failed')
   for update of session;
  if not found then
    raise exception 'live_grant_session_scope_not_found';
  end if;
  if v_classic_handoff_at is not null then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'allowed', false,
      'reason', 'classic_handoff'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'wolfie-live:' || p_tenant_id || ':' || p_student_id::text,
      0
    )
  );

  -- A setup that never reached OpenAI expires without charging the learner.
  update public.wolfie_live_grants
     set status = 'RELEASED',
         settled_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where tenant_id = p_tenant_id
     and student_id = p_student_id
     and status = 'RESERVED'
     and reservation_expires_at <= pg_catalog.now();

  -- ACTIVE leases are never released by SQL alone. The provider call must be
  -- hung up by the trusted Edge Function first; otherwise an old WebRTC call
  -- could keep running after a new grant is issued.

  select pg_catalog.count(*)::integer
    into v_recent_grants
    from public.wolfie_live_grants as grant_row
   where grant_row.tenant_id = p_tenant_id
     and grant_row.student_id = p_student_id
     and grant_row.created_at >= pg_catalog.now() - interval '1 hour'
     and grant_row.status <> 'RELEASED';
  if v_recent_grants >= 12 then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'allowed', false,
      'reason', 'live_rate_limited'
    );
  end if;

  if exists (
    select 1
      from public.wolfie_live_grants as grant_row
     where grant_row.tenant_id = p_tenant_id
       and grant_row.student_id = p_student_id
       and grant_row.status in ('RESERVED', 'ACTIVE', 'CLOSING')
  ) then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'allowed', false,
      'reason', 'student_live_connection_exists'
    );
  end if;

  v_balance := public.wolfie_live_balance(p_tenant_id, p_student_id);
  v_enforced := coalesce((v_balance ->> 'enforced')::boolean, false);
  if v_enforced then
    v_remaining_seconds := greatest(
      coalesce((v_balance ->> 'remainingSeconds')::integer, 0),
      0
    );
    -- Twenty seconds stay reserved beyond the client-visible deadline. This
    -- covers the ten-second scheduler cadence plus the bounded provider
    -- teardown request, so a modified client cannot consume unreserved time.
    if v_remaining_seconds < 35 then
      return pg_catalog.jsonb_build_object(
        'claimed', false,
        'allowed', false,
        'reason', 'insufficient_session_balance',
        'balance', v_balance
      );
    end if;
    v_reserved_seconds := least(p_max_seconds, v_remaining_seconds);
    v_plan_remaining_seconds := greatest(
      coalesce((v_balance ->> 'planRemainingSeconds')::integer, 0),
      0
    );
    v_reserved_plan_seconds := least(
      v_reserved_seconds,
      v_plan_remaining_seconds
    );
    v_reserved_credit_seconds := v_reserved_seconds
      - v_reserved_plan_seconds;
  else
    v_reserved_seconds := p_max_seconds;
    v_reserved_plan_seconds := p_max_seconds;
    v_reserved_credit_seconds := 0;
  end if;
  v_client_max_seconds := v_reserved_seconds - 20;
  if v_client_max_seconds < 15 then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'allowed', false,
      'reason', 'insufficient_session_balance',
      'balance', v_balance
    );
  end if;

  insert into public.wolfie_live_grants (
    tenant_id,
    student_id,
    session_id,
    status,
    enforced,
    reserved_seconds,
    client_max_seconds,
    reserved_plan_seconds,
    reserved_credit_seconds,
    reservation_expires_at,
    lease_expires_at
  ) values (
    p_tenant_id,
    p_student_id,
    p_session_id,
    'RESERVED',
    v_enforced,
    v_reserved_seconds,
    v_client_max_seconds,
    v_reserved_plan_seconds,
    v_reserved_credit_seconds,
    pg_catalog.now() + interval '60 seconds',
    pg_catalog.now() + interval '60 seconds'
  )
  returning id into v_grant_id;

  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'allowed', true,
    'grantId', v_grant_id,
    'maxSeconds', v_client_max_seconds,
    'enforced', v_enforced,
    'balance', v_balance
  );
exception
  when unique_violation then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'allowed', false,
      'reason', 'student_live_connection_exists'
    );
end;
$function$;

drop function if exists public.activate_wolfie_live_grant(uuid);
create function public.activate_wolfie_live_grant(
  p_grant_id uuid,
  p_provider_call_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_grant public.wolfie_live_grants%rowtype;
begin
  if p_grant_id is null
     or p_provider_call_id is null
     or p_provider_call_id !~ '^[A-Za-z0-9_-]{1,200}$' then
    raise exception 'invalid_live_provider_call';
  end if;

  select *
    into v_grant
    from public.wolfie_live_grants
   where id = p_grant_id
   for update;
  if not found or v_grant.status <> 'RESERVED' then
    return pg_catalog.jsonb_build_object('activated', false);
  end if;
  if v_grant.reservation_expires_at <= pg_catalog.now() then
    update public.wolfie_live_grants
       set status = 'RELEASED',
           settled_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     where id = p_grant_id;
    return pg_catalog.jsonb_build_object(
      'activated', false,
      'reason', 'reservation_expired'
    );
  end if;

  update public.wolfie_live_grants
     set status = 'ACTIVE',
         started_at = pg_catalog.now(),
         provider_call_id = p_provider_call_id,
         lease_expires_at = pg_catalog.now()
           + pg_catalog.make_interval(secs => client_max_seconds),
         updated_at = pg_catalog.now()
   where id = p_grant_id
   returning * into v_grant;

  return pg_catalog.jsonb_build_object(
    'activated', true,
    'grantId', v_grant.id,
    'maxSeconds', v_grant.client_max_seconds,
    'leaseExpiresAt', v_grant.lease_expires_at
  );
end;
$function$;

create or replace function public.release_wolfie_live_grant(
  p_grant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.wolfie_live_grants
     set status = 'RELEASED',
         settled_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = p_grant_id
     and status = 'RESERVED';
  return found;
end;
$function$;

-- Persist the trusted server timestamp before contacting the provider. If the
-- provider hangup succeeds and the following settlement write fails, cleanup
-- can resume from CLOSING without charging the learner until lease expiry.
create or replace function public.request_wolfie_live_grant_close(
  p_tenant_id text,
  p_student_id uuid,
  p_grant_id uuid,
  p_session_id uuid default null,
  p_client_seconds integer default null,
  p_reason text default 'CLIENT'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_grant public.wolfie_live_grants%rowtype;
  v_close_at timestamptz;
begin
  if p_tenant_id is null
     or p_student_id is null
     or p_grant_id is null
     or p_reason not in ('CLIENT', 'LEASE_EXPIRED')
     or (p_reason = 'CLIENT' and p_session_id is null)
     or (
       p_client_seconds is not null
       and p_client_seconds not between 0 and 3600
     ) then
    raise exception 'invalid_live_grant_close_request';
  end if;

  select *
    into v_grant
    from public.wolfie_live_grants
   where id = p_grant_id
     and student_id = p_student_id
     and tenant_id = p_tenant_id
     and (p_reason = 'LEASE_EXPIRED' or session_id = p_session_id)
   for update;
  if not found then
    raise exception using errcode = '42501', message = 'live_grant_not_owned';
  end if;

  if v_grant.status in ('SETTLED', 'EXPIRED', 'RELEASED') then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'alreadyClosed', true,
      'seconds', v_grant.consumed_seconds
    );
  end if;
  if v_grant.status = 'RESERVED' then
    update public.wolfie_live_grants
       set status = 'RELEASED',
           settled_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     where id = v_grant.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'alreadyClosed', true,
      'releasedReservation', true,
      'seconds', 0
    );
  end if;
  if v_grant.status not in ('ACTIVE', 'CLOSING')
     or v_grant.started_at is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'grant_not_active'
    );
  end if;

  if v_grant.status = 'ACTIVE' then
    if p_reason = 'LEASE_EXPIRED' then
      if v_grant.lease_expires_at > pg_catalog.now() then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'reason', 'lease_not_expired'
        );
      end if;
      v_close_at := v_grant.lease_expires_at;
    else
      v_close_at := least(pg_catalog.now(), v_grant.lease_expires_at);
    end if;

    update public.wolfie_live_grants
       set status = 'CLOSING',
           close_requested_at = v_close_at,
           close_reason = p_reason,
           client_reported_seconds = case
             when p_client_seconds is null then client_reported_seconds
             else p_client_seconds
           end,
           updated_at = pg_catalog.now()
     where id = v_grant.id
     returning * into v_grant;
  elsif p_client_seconds is not null
        and v_grant.client_reported_seconds is null then
    update public.wolfie_live_grants
       set client_reported_seconds = p_client_seconds,
           updated_at = pg_catalog.now()
     where id = v_grant.id
     returning * into v_grant;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'alreadyClosed', false,
    'grantId', v_grant.id,
    'providerCallId', v_grant.provider_call_id,
    'closeRequestedAt', v_grant.close_requested_at,
    'reason', v_grant.close_reason
  );
end;
$function$;

-- Multiple cleanup invocations can safely drain a backlog. SKIP LOCKED and a
-- short worker lease prevent the same grant from occupying every batch while
-- still allowing retry after provider/network failure.
create or replace function public.claim_wolfie_live_grants_for_cleanup(
  p_limit integer default 100
)
returns table (
  grant_id uuid,
  tenant_id text,
  student_id uuid,
  provider_call_id text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
begin
  return query
  with candidates as (
    select grant_row.id
      from public.wolfie_live_grants as grant_row
     where (
       grant_row.status = 'ACTIVE'
       and grant_row.lease_expires_at <= pg_catalog.now()
     ) or (
       grant_row.status = 'CLOSING'
       and (
         grant_row.cleanup_lease_expires_at is null
         or grant_row.cleanup_lease_expires_at <= pg_catalog.now()
       )
     )
     order by coalesce(
       grant_row.close_requested_at,
       grant_row.lease_expires_at
     ) asc
     for update skip locked
     limit v_limit
  ), claimed as (
    update public.wolfie_live_grants as grant_row
       set status = 'CLOSING',
           close_requested_at = coalesce(
             grant_row.close_requested_at,
             grant_row.lease_expires_at
           ),
           close_reason = coalesce(
             grant_row.close_reason,
             'LEASE_EXPIRED'
           ),
           cleanup_lease_expires_at = pg_catalog.now() + interval '9 seconds',
           updated_at = pg_catalog.now()
      from candidates
     where grant_row.id = candidates.id
     returning
       grant_row.id,
       grant_row.tenant_id,
       grant_row.student_id,
       grant_row.provider_call_id
  )
  select
    claimed.id,
    claimed.tenant_id,
    claimed.student_id,
    claimed.provider_call_id
  from claimed;
end;
$function$;

drop function if exists public.settle_wolfie_live_grant(uuid, integer);
create function public.settle_wolfie_live_grant(
  p_tenant_id text,
  p_student_id uuid,
  p_grant_id uuid,
  p_client_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_grant public.wolfie_live_grants%rowtype;
  v_consumed_seconds integer;
  v_plan_seconds integer;
  v_credit_seconds integer;
  v_close_at timestamptz;
  v_final_status text;
begin
  if p_tenant_id is null
     or p_student_id is null
     or p_grant_id is null then
    raise exception 'invalid_live_grant_settlement';
  end if;

  select *
    into v_grant
    from public.wolfie_live_grants
   where id = p_grant_id
     and student_id = p_student_id
     and tenant_id = p_tenant_id
   for update;
  if not found then
    raise exception using errcode = '42501', message = 'live_grant_not_owned';
  end if;

  if v_grant.status in ('SETTLED', 'EXPIRED') then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'alreadySettled', true,
      'seconds', v_grant.consumed_seconds
    );
  end if;
  if v_grant.status = 'RESERVED' then
    update public.wolfie_live_grants
       set status = 'RELEASED',
           settled_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     where id = v_grant.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'releasedReservation', true,
      'seconds', 0
    );
  end if;
  if v_grant.status <> 'CLOSING'
     or v_grant.started_at is null
     or v_grant.close_requested_at is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'grant_not_closing'
    );
  end if;

  -- Browser time is diagnostic only. Billing ends at the server-authored
  -- close timestamp (or the exact lease deadline for forced expiry).
  v_close_at := least(
    v_grant.close_requested_at,
    v_grant.lease_expires_at,
    pg_catalog.now()
  );
  v_consumed_seconds := case
    when v_grant.close_reason = 'LEASE_EXPIRED' then
      v_grant.reserved_seconds
    else least(
      v_grant.client_max_seconds,
      greatest(
        1,
        pg_catalog.ceil(
          extract(epoch from (v_close_at - v_grant.started_at))
        )::integer
      )
    )
  end;
  v_plan_seconds := least(
    v_consumed_seconds,
    v_grant.reserved_plan_seconds
  );
  v_credit_seconds := v_consumed_seconds - v_plan_seconds;

  insert into public.student_live_minutes (
    tenant_id,
    student_id,
    session_id,
    seconds,
    source,
    grant_id,
    plan_seconds,
    credit_seconds,
    created_at
  ) values (
    v_grant.tenant_id,
    v_grant.student_id,
    v_grant.session_id,
    v_consumed_seconds,
    'openai_realtime_grant',
    v_grant.id,
    v_plan_seconds,
    v_credit_seconds,
    v_grant.started_at
  )
  on conflict (grant_id) where grant_id is not null do nothing;

  v_final_status := case
    when v_grant.close_reason = 'LEASE_EXPIRED' then 'EXPIRED'
    else 'SETTLED'
  end;

  update public.wolfie_live_grants
     set status = v_final_status,
         consumed_seconds = v_consumed_seconds,
         client_reported_seconds = least(
           greatest(
             coalesce(p_client_seconds, client_reported_seconds, 0),
             0
           ),
           3600
         ),
         cleanup_lease_expires_at = null,
         settled_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = v_grant.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'alreadySettled', false,
    'seconds', v_consumed_seconds
  );
end;
$function$;

drop function if exists public.record_wolfie_live_seconds(uuid, integer);

revoke all on function public.wolfie_live_balance(text, uuid)
  from public, anon, authenticated;
grant execute on function public.wolfie_live_balance(text, uuid)
  to service_role;
revoke all on function public.my_wolfie_live_balance()
  from public, anon;
grant execute on function public.my_wolfie_live_balance()
  to authenticated;
revoke all on function public.claim_wolfie_live_grant(text, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_wolfie_live_grant(text, uuid, uuid, integer)
  to service_role;
revoke all on function public.activate_wolfie_live_grant(uuid, text)
  from public, anon, authenticated;
grant execute on function public.activate_wolfie_live_grant(uuid, text)
  to service_role;
revoke all on function public.release_wolfie_live_grant(uuid)
  from public, anon, authenticated;
grant execute on function public.release_wolfie_live_grant(uuid)
  to service_role;
revoke all on function public.request_wolfie_live_grant_close(
  text,
  uuid,
  uuid,
  uuid,
  integer,
  text
) from public, anon, authenticated;
grant execute on function public.request_wolfie_live_grant_close(
  text,
  uuid,
  uuid,
  uuid,
  integer,
  text
) to service_role;
revoke all on function public.claim_wolfie_live_grants_for_cleanup(integer)
  from public, anon, authenticated;
grant execute on function public.claim_wolfie_live_grants_for_cleanup(integer)
  to service_role;
revoke all on function public.settle_wolfie_live_grant(
  text,
  uuid,
  uuid,
  integer
) from public, anon, authenticated;
grant execute on function public.settle_wolfie_live_grant(
  text,
  uuid,
  uuid,
  integer
) to service_role;

-- Provider token telemetry is not quota authority. Accept only bounded whole
-- numbers and attach it to the persisted Wolfie row (speaker='wolfie').
create or replace function public.record_wolfie_realtime_usage(
  p_session_id uuid,
  p_client_turn_id uuid,
  p_usage jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_updated integer := 0;
  v_total integer;
  v_input_text integer;
  v_input_audio integer;
  v_output_text integer;
  v_output_audio integer;
  v_cached integer;
begin
  if p_session_id is null
     or p_client_turn_id is null
     or p_usage is null
     or pg_catalog.jsonb_typeof(p_usage) <> 'object' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'invalid_input'
    );
  end if;

  if coalesce(p_usage ->> 'totalTokens', '') !~ '^\d{1,10}$'
     or coalesce(p_usage ->> 'inputTextTokens', '') !~ '^\d{1,10}$'
     or coalesce(p_usage ->> 'inputAudioTokens', '') !~ '^\d{1,10}$'
     or coalesce(p_usage ->> 'outputTextTokens', '') !~ '^\d{1,10}$'
     or coalesce(p_usage ->> 'outputAudioTokens', '') !~ '^\d{1,10}$'
     or coalesce(p_usage ->> 'cachedTokens', '') !~ '^\d{1,10}$' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'invalid_usage_values'
    );
  end if;

  v_total := least((p_usage ->> 'totalTokens')::numeric, 2147483647)::integer;
  v_input_text := least(
    (p_usage ->> 'inputTextTokens')::numeric,
    2147483647
  )::integer;
  v_input_audio := least(
    (p_usage ->> 'inputAudioTokens')::numeric,
    2147483647
  )::integer;
  v_output_text := least(
    (p_usage ->> 'outputTextTokens')::numeric,
    2147483647
  )::integer;
  v_output_audio := least(
    (p_usage ->> 'outputAudioTokens')::numeric,
    2147483647
  )::integer;
  v_cached := least(
    (p_usage ->> 'cachedTokens')::numeric,
    2147483647
  )::integer;

  update public.wolfie_turns as turn_row
     set tokens_used = v_total,
         usage_input_text_tokens = v_input_text,
         usage_input_audio_tokens = v_input_audio,
         usage_output_text_tokens = v_output_text,
         usage_output_audio_tokens = v_output_audio,
         usage_cached_tokens = v_cached
   where turn_row.session_id = p_session_id
     and turn_row.client_turn_id = p_client_turn_id
     and turn_row.speaker = 'wolfie'
     and turn_row.source_kind = 'openai_realtime';

  get diagnostics v_updated = row_count;
  return pg_catalog.jsonb_build_object(
    'ok', v_updated = 1,
    'updated', v_updated
  );
exception
  when others then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'usage_write_failed'
    );
end;
$function$;

create or replace function public.wolfie_realtime_usage_report(
  p_month text default null
)
returns table (
  student_id uuid,
  student_name text,
  sessions integer,
  turns integer,
  input_audio_tokens bigint,
  output_audio_tokens bigint,
  input_text_tokens bigint,
  output_text_tokens bigint,
  cached_tokens bigint,
  total_tokens bigint
)
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_caller uuid := (select auth.uid());
  v_tenant text;
  v_role text;
  v_start date;
begin
  v_tenant := private.active_tenant_id(v_caller);
  v_role := private.active_tenant_role(v_caller);
  if v_tenant is null
     or v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;

  v_start := date_trunc(
    'month',
    coalesce(
      to_date(nullif(p_month, ''), 'YYYY-MM'),
      current_date
    )
  )::date;

  return query
  select
    session.student_id,
    coalesce(profile.full_name, '?')::text,
    pg_catalog.count(distinct session.id)::integer,
    pg_catalog.count(turn_row.id)::integer,
    coalesce(pg_catalog.sum(turn_row.usage_input_audio_tokens), 0)::bigint,
    coalesce(pg_catalog.sum(turn_row.usage_output_audio_tokens), 0)::bigint,
    coalesce(pg_catalog.sum(turn_row.usage_input_text_tokens), 0)::bigint,
    coalesce(pg_catalog.sum(turn_row.usage_output_text_tokens), 0)::bigint,
    coalesce(pg_catalog.sum(turn_row.usage_cached_tokens), 0)::bigint,
    coalesce(pg_catalog.sum(turn_row.tokens_used), 0)::bigint
  from public.wolfie_turns as turn_row
  join public.wolfie_sessions as session
    on session.id = turn_row.session_id
  left join public.profiles as profile on profile.id = session.student_id
  where turn_row.source_kind = 'openai_realtime'
    and turn_row.speaker = 'wolfie'
    and session.tenant_id = v_tenant
    and turn_row.created_at >= v_start
    and turn_row.created_at < v_start + interval '1 month'
  group by session.student_id, profile.full_name
  order by 10 desc;
end;
$function$;

create or replace function public.ai_cost_report(p_month text default null)
returns table (
  feature text,
  model text,
  chamadas bigint,
  input_tokens bigint,
  output_tokens bigint,
  cached_tokens bigint,
  custo_usd numeric,
  tem_preco boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_caller uuid := (select auth.uid());
  v_tenant text;
  v_role text;
  v_start date;
begin
  v_tenant := private.active_tenant_id(v_caller);
  v_role := private.active_tenant_role(v_caller);
  if v_tenant is null
     or v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;

  v_start := date_trunc(
    'month',
    coalesce(
      to_date(nullif(p_month, ''), 'YYYY-MM'),
      current_date
    )
  )::date;

  return query
  select
    event_row.feature,
    event_row.model,
    pg_catalog.count(*)::bigint,
    pg_catalog.sum(event_row.input_tokens)::bigint,
    pg_catalog.sum(event_row.output_tokens)::bigint,
    pg_catalog.sum(event_row.cached_tokens)::bigint,
    pg_catalog.round(pg_catalog.sum(
      (event_row.input_tokens - event_row.cached_tokens)
        * coalesce(pricing.input_usd_per_1m, 0)
      + event_row.cached_tokens * coalesce(pricing.cached_usd_per_1m, 0)
      + event_row.output_tokens * coalesce(pricing.output_usd_per_1m, 0)
    ) / 1000000.0, 4),
    pg_catalog.bool_or(pricing.model is not null)
  from public.ai_usage_events as event_row
  left join public.ai_model_pricing as pricing
    on pricing.model = event_row.model
  where event_row.tenant_id = v_tenant
    and event_row.created_at >= v_start
    and event_row.created_at < v_start + interval '1 month'
  group by event_row.feature, event_row.model
  order by 7 desc nulls last;
end;
$function$;

revoke all on table public.ai_usage_events
  from public, anon, authenticated;
revoke all on table public.ai_model_pricing
  from public, anon, authenticated;
grant all on table public.ai_usage_events to service_role;
grant select on table public.ai_model_pricing to service_role;
revoke all on function public.record_wolfie_realtime_usage(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_wolfie_realtime_usage(uuid, uuid, jsonb)
  to service_role;
revoke all on function public.wolfie_realtime_usage_report(text)
  from public, anon;
grant execute on function public.wolfie_realtime_usage_report(text)
  to authenticated;
revoke all on function public.ai_cost_report(text)
  from public, anon;
grant execute on function public.ai_cost_report(text)
  to authenticated;

-- Explicit grants for quota/settings tables and the legacy token quota RPC.
revoke all on table public.tenant_realtime_settings
  from public, anon, authenticated;
grant select on table public.tenant_realtime_settings to authenticated;
grant all on table public.tenant_realtime_settings to service_role;
drop policy if exists trs_read on public.tenant_realtime_settings;
create policy trs_read on public.tenant_realtime_settings
  for select to authenticated
  using (tenant_id = (select public._my_tenant_id()));
revoke all on function public.wolfie_realtime_quota_status(text, uuid)
  from public, anon, authenticated;
grant execute on function public.wolfie_realtime_quota_status(text, uuid)
  to service_role;

-- A learner may belong to multiple schools, but Data API reads must expose
-- only the currently selected ACTIVE tenant. Educator policies keep their
-- existing tenant/assignment branches.
drop policy if exists wolfie_sessions_select_scope on public.wolfie_sessions;
create policy wolfie_sessions_select_scope on public.wolfie_sessions
  for select to authenticated
  using (
    (
      student_id = (select auth.uid())
      and tenant_id = (select public._my_tenant_id())
      and exists (
        select 1 from public.tenant_memberships as membership
         where membership.user_id = (select auth.uid())
           and membership.tenant_id = wolfie_sessions.tenant_id
           and membership.status = 'ACTIVE'
           and membership.role = 'STUDENT'
      )
    )
    or (select public._my_role()) = 'SUPER_ADMIN'
    or (
      (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
      and tenant_id = (select public._my_tenant_id())
    )
    or (
      (select public._my_role()) = 'TEACHER'
      and tenant_id = (select public._my_tenant_id())
      and public._teacher_can_access_student(student_id, tenant_id)
    )
  );

drop policy if exists wolfie_turns_select_scope on public.wolfie_turns;
create policy wolfie_turns_select_scope on public.wolfie_turns
  for select to authenticated
  using (
    exists (
      select 1 from public.wolfie_sessions as session
       where session.id = wolfie_turns.session_id
         and (
           (
             session.student_id = (select auth.uid())
             and session.tenant_id = (select public._my_tenant_id())
             and exists (
               select 1 from public.tenant_memberships as membership
                where membership.user_id = (select auth.uid())
                  and membership.tenant_id = session.tenant_id
                  and membership.status = 'ACTIVE'
                  and membership.role = 'STUDENT'
             )
           )
           or (select public._my_role()) = 'SUPER_ADMIN'
           or (
             (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
             and session.tenant_id = (select public._my_tenant_id())
           )
           or (
             (select public._my_role()) = 'TEACHER'
             and session.tenant_id = (select public._my_tenant_id())
             and public._teacher_can_access_student(
               session.student_id,
               session.tenant_id
             )
           )
         )
    )
  );

drop policy if exists wolfie_corrections_select_scope
  on public.wolfie_corrections;
create policy wolfie_corrections_select_scope on public.wolfie_corrections
  for select to authenticated
  using (
    exists (
      select 1 from public.wolfie_sessions as session
       where session.id = wolfie_corrections.session_id
         and (
           (
             session.student_id = (select auth.uid())
             and session.tenant_id = (select public._my_tenant_id())
             and exists (
               select 1 from public.tenant_memberships as membership
                where membership.user_id = (select auth.uid())
                  and membership.tenant_id = session.tenant_id
                  and membership.status = 'ACTIVE'
                  and membership.role = 'STUDENT'
             )
           )
           or (select public._my_role()) = 'SUPER_ADMIN'
           or (
             (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
             and session.tenant_id = (select public._my_tenant_id())
           )
           or (
             (select public._my_role()) = 'TEACHER'
             and session.tenant_id = (select public._my_tenant_id())
             and public._teacher_can_access_student(
               session.student_id,
               session.tenant_id
             )
           )
         )
    )
  );

drop policy if exists wolfie_evaluations_select_scope
  on public.wolfie_evaluations;
create policy wolfie_evaluations_select_scope on public.wolfie_evaluations
  for select to authenticated
  using (
    exists (
      select 1 from public.wolfie_sessions as session
       where session.id = wolfie_evaluations.session_id
         and (
           (
             session.student_id = (select auth.uid())
             and session.tenant_id = (select public._my_tenant_id())
             and exists (
               select 1 from public.tenant_memberships as membership
                where membership.user_id = (select auth.uid())
                  and membership.tenant_id = session.tenant_id
                  and membership.status = 'ACTIVE'
                  and membership.role = 'STUDENT'
             )
           )
           or (select public._my_role()) = 'SUPER_ADMIN'
           or (
             (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
             and session.tenant_id = (select public._my_tenant_id())
           )
           or (
             (select public._my_role()) = 'TEACHER'
             and session.tenant_id = (select public._my_tenant_id())
             and public._teacher_can_access_student(
               session.student_id,
               session.tenant_id
             )
           )
         )
    )
  );

drop policy if exists wolfie_activity_sessions_read_own
  on public.wolfie_activity_sessions;
create policy wolfie_activity_sessions_read_own
  on public.wolfie_activity_sessions
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = (select auth.uid())
         and membership.tenant_id = wolfie_activity_sessions.tenant_id
         and membership.status = 'ACTIVE'
         and membership.role = 'STUDENT'
    )
  );
drop policy if exists wolfie_activity_attempts_read_own
  on public.wolfie_activity_attempts;
create policy wolfie_activity_attempts_read_own
  on public.wolfie_activity_attempts
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = (select auth.uid())
         and membership.tenant_id = wolfie_activity_attempts.tenant_id
         and membership.status = 'ACTIVE'
         and membership.role = 'STUDENT'
    )
  );
drop policy if exists wolfie_repertoire_read_own on public.wolfie_repertoire;
create policy wolfie_repertoire_read_own on public.wolfie_repertoire
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = (select auth.uid())
         and membership.tenant_id = wolfie_repertoire.tenant_id
         and membership.status = 'ACTIVE'
         and membership.role = 'STUDENT'
    )
  );
drop policy if exists wolfie_learning_events_read_own
  on public.wolfie_learning_events;
create policy wolfie_learning_events_read_own
  on public.wolfie_learning_events
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = (select auth.uid())
         and membership.tenant_id = wolfie_learning_events.tenant_id
         and membership.status = 'ACTIVE'
         and membership.role = 'STUDENT'
    )
  );

drop policy if exists wolf_intelligence_student_select
  on public.wolf_intelligence;
create policy wolf_intelligence_student_select on public.wolf_intelligence
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = (select auth.uid())
         and membership.tenant_id = wolf_intelligence.tenant_id
         and membership.status = 'ACTIVE'
         and membership.role = 'STUDENT'
    )
  );
drop policy if exists wolfie_memory_items_student_select
  on public.wolfie_memory_items;
create policy wolfie_memory_items_student_select
  on public.wolfie_memory_items
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = (select auth.uid())
         and membership.tenant_id = wolfie_memory_items.tenant_id
         and membership.status = 'ACTIVE'
         and membership.role = 'STUDENT'
    )
  );
drop policy if exists wolfie_session_reports_student_select
  on public.wolfie_session_reports;
create policy wolfie_session_reports_student_select
  on public.wolfie_session_reports
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = (select auth.uid())
         and membership.tenant_id = wolfie_session_reports.tenant_id
         and membership.status = 'ACTIVE'
         and membership.role = 'STUDENT'
    )
  );
drop policy if exists wolfie_facts_student_select on public.wolfie_facts;
create policy wolfie_facts_student_select on public.wolfie_facts
  for select to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and exists (
      select 1 from public.tenant_memberships as membership
       where membership.user_id = (select auth.uid())
         and membership.tenant_id = wolfie_facts.tenant_id
         and membership.status = 'ACTIVE'
         and membership.role = 'STUDENT'
    )
  );

-- Enforce the provider-side maximum even if a modified browser suppresses its
-- close callback. pg_cron invokes the service-only cleanup every minute; the
-- Edge Function hangs up each OpenAI call before settling its grant.
create or replace function public.trigger_wolfie_live_grant_cleanup()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_request_id bigint;
begin
  select secret.decrypted_secret
    into v_service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;
  if v_service_key is null or v_service_key = '' then
    raise warning 'wisewolf_service_role_key is not configured';
    return -1;
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/wolfie-realtime-session',
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'x-wolfie-cleanup', 'expired-live-grants'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_request_id;
  return v_request_id;
end;
$function$;

revoke all on function public.trigger_wolfie_live_grant_cleanup()
  from public, anon, authenticated;
grant execute on function public.trigger_wolfie_live_grant_cleanup()
  to service_role;

do $cron$
begin
  if exists (
    select 1 from cron.job
     where jobname = 'wisewolf-live-grant-cleanup'
  ) then
    perform cron.unschedule('wisewolf-live-grant-cleanup');
  end if;
  perform cron.schedule(
    'wisewolf-live-grant-cleanup',
    '10 seconds',
    'select public.trigger_wolfie_live_grant_cleanup();'
  );
end;
$cron$;
