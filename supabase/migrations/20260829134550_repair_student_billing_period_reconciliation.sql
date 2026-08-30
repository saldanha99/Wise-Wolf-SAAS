begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preconditions$
begin
  if pg_catalog.to_regclass(
       'public.asaas_student_billing_period_claims'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.claim_asaas_student_billing_period(text,uuid,date,text,text,text,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.claim_asaas_student_billing_period_exact_impl(text,uuid,date,text,text,text,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.guard_student_billing_period_lifecycle()'
     ) is null
  then
    raise exception 'student billing period reconciliation prerequisites are missing';
  end if;
end;
$preconditions$;

-- The public wrapper already serializes every student/month with an advisory
-- transaction lock. Reuse an exact claim under a row lock before considering
-- an insert, so reconciliation cannot re-fire the BEFORE INSERT lifecycle
-- guard for a row that already owns the billing competence.
create or replace function public.claim_asaas_student_billing_period_exact_impl(
  p_tenant_id text,
  p_student_id uuid,
  p_due_date date,
  p_source text,
  p_source_key text,
  p_request_fingerprint text,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim_row public.asaas_student_billing_period_claims%rowtype;
  normalized_tenant text := nullif(
    pg_catalog.btrim(coalesce(p_tenant_id, '')),
    ''
  );
  normalized_source text := upper(
    pg_catalog.btrim(coalesce(p_source, ''))
  );
  normalized_key text := nullif(
    pg_catalog.btrim(coalesce(p_source_key, '')),
    ''
  );
  normalized_fingerprint text := lower(
    pg_catalog.btrim(coalesce(p_request_fingerprint, ''))
  );
  safe_lease integer := greatest(
    60,
    least(coalesce(p_lease_seconds, 300), 600)
  );
  retry_after integer;
begin
  if normalized_tenant is null
     or p_student_id is null
     or p_due_date is null
     or normalized_source not in ('MANUAL_PIX', 'SUBSCRIPTION')
     or normalized_key is null
     or length(normalized_key) > 240
     or normalized_fingerprint !~ '^[a-f0-9]{64}$'
     or p_claim_token is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_student_billing_period_claim';
  end if;

  if not exists (
    select 1
      from public.profiles as profile
     where profile.id = p_student_id
       and profile.tenant_id = normalized_tenant
       and profile.role = 'STUDENT'
  ) then
    raise exception using
      errcode = '42501',
      message = 'student_billing_period_scope_mismatch';
  end if;

  select billing_claim.*
    into claim_row
    from public.asaas_student_billing_period_claims as billing_claim
   where billing_claim.tenant_id = normalized_tenant
     and billing_claim.student_id = p_student_id
     and billing_claim.due_date = p_due_date
   for update;

  if not found then
    insert into public.asaas_student_billing_period_claims (
      tenant_id,
      student_id,
      due_date,
      source,
      source_key,
      request_fingerprint,
      claim_token,
      lease_expires_at
    ) values (
      normalized_tenant,
      p_student_id,
      p_due_date,
      normalized_source,
      normalized_key,
      normalized_fingerprint,
      p_claim_token,
      now() + pg_catalog.make_interval(secs => safe_lease)
    )
    returning * into claim_row;
  end if;

  if claim_row.source is distinct from normalized_source
     or claim_row.source_key is distinct from normalized_key
  then
    insert into public.asaas_reconciliation_issues (
      tenant_id,
      source,
      kind,
      severity,
      local_entity_id,
      fingerprint,
      details
    ) values (
      normalized_tenant,
      'CREATION_GUARD',
      'STUDENT_BILLING_PERIOD_CONFLICT',
      'CRITICAL',
      claim_row.id::text,
      'student-billing-period:' || claim_row.id::text || ':' || normalized_source,
      pg_catalog.jsonb_build_object(
        'studentId', p_student_id,
        'dueDate', p_due_date,
        'winningSource', claim_row.source,
        'blockedSource', normalized_source
      )
    ) on conflict do nothing;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'CONFLICT',
      'reason', 'billing_period_owned_by_another_flow',
      'attempt_id', claim_row.id,
      'status', claim_row.status,
      'provider_entity_id', claim_row.provider_entity_id
    );
  end if;

  if claim_row.request_fingerprint is distinct from normalized_fingerprint then
    if claim_row.status <> 'BOUND' then
      update public.asaas_student_billing_period_claims
         set status = 'BLOCKED',
             last_error = 'billing_period_input_mismatch',
             lease_expires_at = now(),
             updated_at = now()
       where id = claim_row.id;
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'billing_period_input_mismatch',
      'attempt_id', claim_row.id
    );
  end if;

  if claim_row.status = 'BOUND' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_BOUND',
      'attempt_id', claim_row.id,
      'provider_entity_id', claim_row.provider_entity_id,
      'status', claim_row.status
    );
  end if;

  if claim_row.status in ('FAILED', 'BLOCKED') then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'attempt_id', claim_row.id,
      'status', claim_row.status
    );
  end if;

  if claim_row.status in ('SUBMITTING', 'UNKNOWN')
     and claim_row.lease_expires_at > now()
     and claim_row.claim_token is distinct from p_claim_token
  then
    retry_after := greatest(
      1,
      ceil(extract(epoch from (claim_row.lease_expires_at - now())))::integer
    );
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', claim_row.id,
      'status', claim_row.status,
      'retry_after_seconds', retry_after
    );
  end if;

  if claim_row.status in ('SUBMITTING', 'UNKNOWN') then
    update public.asaas_student_billing_period_claims
       set status = 'UNKNOWN',
           claim_token = p_claim_token,
           lease_expires_at = now() + pg_catalog.make_interval(
             secs => safe_lease
           ),
           updated_at = now()
     where id = claim_row.id
     returning * into claim_row;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'RECONCILE_REQUIRED',
      'attempt_id', claim_row.id,
      'claim_token', claim_row.claim_token,
      'status', claim_row.status
    );
  end if;

  if claim_row.status = 'CLAIMED'
     and claim_row.claim_token is distinct from p_claim_token
     and claim_row.lease_expires_at > now()
  then
    retry_after := greatest(
      1,
      ceil(extract(epoch from (claim_row.lease_expires_at - now())))::integer
    );
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', claim_row.id,
      'status', claim_row.status,
      'retry_after_seconds', retry_after
    );
  end if;

  update public.asaas_student_billing_period_claims
     set status = 'CLAIMED',
         claim_token = p_claim_token,
         lease_expires_at = now() + pg_catalog.make_interval(
           secs => safe_lease
         ),
         updated_at = now()
   where id = claim_row.id
   returning * into claim_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'attempt_id', claim_row.id,
    'claim_token', claim_row.claim_token,
    'status', claim_row.status
  );
end;
$function$;

alter function public.claim_asaas_student_billing_period_exact_impl(
  text, uuid, date, text, text, text, uuid, integer
) owner to postgres;
revoke all on function public.claim_asaas_student_billing_period_exact_impl(
  text, uuid, date, text, text, text, uuid, integer
) from public, anon, authenticated, service_role;

-- Reassert the public wrapper boundary. The wrapper body is intentionally not
-- replaced: it retains the month-wide advisory lock and conflict detection.
alter function public.claim_asaas_student_billing_period(
  text, uuid, date, text, text, text, uuid, integer
) owner to postgres;
revoke all on function public.claim_asaas_student_billing_period(
  text, uuid, date, text, text, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.claim_asaas_student_billing_period(
  text, uuid, date, text, text, text, uuid, integer
) to service_role;

do $postconditions$
declare
  wrapper_oid regprocedure := pg_catalog.to_regprocedure(
    'public.claim_asaas_student_billing_period(text,uuid,date,text,text,text,uuid,integer)'
  );
  exact_oid regprocedure := pg_catalog.to_regprocedure(
    'public.claim_asaas_student_billing_period_exact_impl(text,uuid,date,text,text,text,uuid,integer)'
  );
begin
  if wrapper_oid is null
     or exact_oid is null
     or exists (
       select 1
         from pg_catalog.pg_proc as procedure
        where procedure.oid in (wrapper_oid, exact_oid)
          and (
            not procedure.prosecdef
            or pg_catalog.pg_get_userbyid(procedure.proowner) <> 'postgres'
            or not coalesce(
              procedure.proconfig @> array['search_path=""']::text[],
              false
            )
          )
     )
     or pg_catalog.has_function_privilege('anon', wrapper_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated', wrapper_oid, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', wrapper_oid, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role', exact_oid, 'EXECUTE'
     )
  then
    raise exception 'student billing period reconciliation boundary is invalid';
  end if;
end;
$postconditions$;

commit;
