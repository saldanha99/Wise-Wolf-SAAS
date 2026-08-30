-- DRE, weekly digests and teacher-closing notices are tenant-scoped financial
-- communications, not student communications. Keep a separate durable state
-- machine so a timeout or crash after the provider POST cannot duplicate them.
create table if not exists public.financial_report_message_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  notification_kind text not null check (
    notification_kind in ('DRE_REPORT', 'WEEKLY_DIGEST', 'MONTHLY_CLOSING')
  ),
  subject_id text not null,
  ref_date date not null,
  status text not null default 'CLAIMED' check (
    status in ('CLAIMED', 'SUBMITTING', 'SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED')
  ),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  submit_attempt_count integer not null default 0 check (
    submit_attempt_count between 0 and 1
  ),
  provider_http_status integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, notification_kind, subject_id, ref_date)
);

alter table public.financial_report_message_attempts owner to postgres;
alter table public.financial_report_message_attempts enable row level security;
alter table public.financial_report_message_attempts force row level security;
revoke all on table public.financial_report_message_attempts
  from public, anon, authenticated, service_role;
grant select on table public.financial_report_message_attempts to service_role;

create or replace function private.financial_report_message_scope_active(
  p_tenant_id text,
  p_notification_kind text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.tenants as tenant
     where tenant.id = p_tenant_id
       and tenant.whatsapp_enabled is true
       and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) in (
         'active', 'trial', 'trialing'
       )
  ) and (
    p_notification_kind = 'WEEKLY_DIGEST'
    or (
      p_notification_kind = 'DRE_REPORT'
      and exists (
        select 1
          from public.dre_report_settings as setting
        where setting.tenant_id = p_tenant_id
           and setting.is_active
      )
    )
    or (
      p_notification_kind = 'MONTHLY_CLOSING'
      and exists (
        select 1
          from public.tenant_admin_settings as setting
         where setting.tenant_id = p_tenant_id
           and setting.teacher_notifications_enabled is true
      )
    )
  );
$function$;

alter function private.financial_report_message_scope_active(text, text)
  owner to postgres;
revoke all on function private.financial_report_message_scope_active(text, text)
  from public, anon, authenticated, service_role;

create or replace function private.financial_report_message_exact_scope_active(
  p_tenant_id text,
  p_notification_kind text,
  p_subject_id text,
  p_ref_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.financial_report_message_scope_active(
    p_tenant_id,
    p_notification_kind
  ) and (
    p_notification_kind <> 'MONTHLY_CLOSING'
    or exists (
      select 1
        from public.teacher_closings as closing
        join public.profiles as teacher
          on teacher.id = closing.teacher_id
         and teacher.tenant_id = closing.tenant_id
         and teacher.role = 'TEACHER'
         and lower(pg_catalog.btrim(coalesce(teacher.lifecycle_status, ''))) = 'active'
         and coalesce(teacher.is_test_account, false) is false
       where closing.tenant_id = p_tenant_id
         and upper(pg_catalog.btrim(coalesce(closing.status, ''))) = 'PENDENTE'
         and coalesce(closing.total_lessons, 0) > 0
         and closing.month_year ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
         and p_ref_date::text = closing.month_year || '-01'
         and p_subject_id = closing.teacher_id::text || ':'
           || closing.month_year || ':' || closing.id::text || ':'
           || coalesce(closing.total_lessons, 0)::bigint::text || ':'
           || pg_catalog.round(
             coalesce(closing.total_amount, 0)::numeric * 100
           )::bigint::text
         and exists (
           select 1
             from public.tenant_memberships as membership
            where membership.user_id = closing.teacher_id
              and membership.tenant_id = closing.tenant_id
              and membership.role = 'TEACHER'
              and membership.status = 'ACTIVE'
         )
    )
  );
$function$;

alter function private.financial_report_message_exact_scope_active(
  text, text, text, date
) owner to postgres;
revoke all on function private.financial_report_message_exact_scope_active(
  text, text, text, date
) from public, anon, authenticated, service_role;

create or replace function public.claim_financial_report_message(
  p_tenant_id text,
  p_notification_kind text,
  p_subject_id text,
  p_ref_date date,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.financial_report_message_attempts%rowtype;
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  normalized_kind text := upper(pg_catalog.btrim(coalesce(p_notification_kind, '')));
  normalized_subject text := nullif(pg_catalog.btrim(coalesce(p_subject_id, '')), '');
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
begin
  if normalized_tenant is null
     or normalized_kind not in (
       'DRE_REPORT', 'WEEKLY_DIGEST', 'MONTHLY_CLOSING'
     )
     or normalized_subject is null
     or length(normalized_subject) > 240
     or p_ref_date is null
     or p_claim_token is null
     or (
       normalized_kind = 'WEEKLY_DIGEST'
       and normalized_subject <> normalized_tenant
     )
     or (
       normalized_kind = 'DRE_REPORT'
       and normalized_subject not in (
         normalized_tenant,
         normalized_tenant || ':manual'
       )
     )
  then
    raise exception using errcode = '22023', message = 'invalid_financial_report_message_claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'financial-report-message:' || normalized_tenant || ':'
        || normalized_kind || ':' || normalized_subject || ':' || p_ref_date::text,
      0
    )
  );

  if not private.financial_report_message_exact_scope_active(
    normalized_tenant,
    normalized_kind,
    normalized_subject,
    p_ref_date
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'financial_report_scope_inactive'
    );
  end if;

  insert into public.financial_report_message_attempts (
    tenant_id,
    notification_kind,
    subject_id,
    ref_date,
    claim_token,
    lease_expires_at
  ) values (
    normalized_tenant,
    normalized_kind,
    normalized_subject,
    p_ref_date,
    p_claim_token,
    pg_catalog.now() + pg_catalog.make_interval(secs => safe_lease)
  ) on conflict (tenant_id, notification_kind, subject_id, ref_date) do nothing;

  select attempt.* into attempt_row
    from public.financial_report_message_attempts as attempt
   where attempt.tenant_id = normalized_tenant
     and attempt.notification_kind = normalized_kind
     and attempt.subject_id = normalized_subject
     and attempt.ref_date = p_ref_date
   for update;

  if attempt_row.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED')
     or attempt_row.submit_attempt_count > 0
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_FINAL',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status
    );
  end if;
  if attempt_row.claim_token is distinct from p_claim_token
     and attempt_row.lease_expires_at > pg_catalog.now()
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status
    );
  end if;

  update public.financial_report_message_attempts
     set claim_token = p_claim_token,
         lease_expires_at = pg_catalog.now()
           + pg_catalog.make_interval(secs => safe_lease),
         updated_at = pg_catalog.now()
   where id = attempt_row.id
   returning * into attempt_row;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'attempt_id', attempt_row.id,
    'claim_token', attempt_row.claim_token,
    'status', attempt_row.status
  );
end;
$function$;

create or replace function public.mark_financial_report_message_submitting(
  p_attempt_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.financial_report_message_attempts%rowtype;
  monthly_source_locked boolean := true;
begin
  select attempt.* into attempt_row
    from public.financial_report_message_attempts as attempt
   where attempt.id = p_attempt_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'financial-report-message:' || attempt_row.tenant_id || ':'
        || attempt_row.notification_kind || ':' || attempt_row.subject_id
        || ':' || attempt_row.ref_date::text,
      0
    )
  );

  if attempt_row.notification_kind = 'MONTHLY_CLOSING' then
    perform 1
      from public.teacher_closings as closing
     where closing.tenant_id = attempt_row.tenant_id
       and closing.month_year ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
       and attempt_row.ref_date::text = closing.month_year || '-01'
       and attempt_row.subject_id = closing.teacher_id::text || ':'
         || closing.month_year || ':' || closing.id::text || ':'
         || coalesce(closing.total_lessons, 0)::bigint::text || ':'
         || pg_catalog.round(
           coalesce(closing.total_amount, 0)::numeric * 100
         )::bigint::text
     for update;
    monthly_source_locked := found;
  end if;

  select attempt.* into attempt_row
    from public.financial_report_message_attempts as attempt
   where attempt.id = p_attempt_id
   for update;
  if not found
     or attempt_row.status <> 'CLAIMED'
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.lease_expires_at <= pg_catalog.now()
     or attempt_row.submit_attempt_count <> 0
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if not monthly_source_locked
     or not private.financial_report_message_exact_scope_active(
    attempt_row.tenant_id,
    attempt_row.notification_kind,
    attempt_row.subject_id,
    attempt_row.ref_date
  ) then
    update public.financial_report_message_attempts
       set status = 'SUPPRESSED',
           lease_expires_at = pg_catalog.now(),
           last_error = 'financial_report_scope_changed_before_send',
           updated_at = pg_catalog.now()
     where id = attempt_row.id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'status', 'SUPPRESSED',
      'reason', 'financial_report_scope_changed_before_send'
    );
  end if;

  update public.financial_report_message_attempts
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         lease_expires_at = pg_catalog.now() + interval '10 minutes',
         updated_at = pg_catalog.now()
   where id = attempt_row.id;
  return pg_catalog.jsonb_build_object('ok', true, 'status', 'SUBMITTING');
end;
$function$;

create or replace function public.finish_financial_report_message(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_http_status integer default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.financial_report_message_attempts%rowtype;
  normalized_status text := upper(pg_catalog.btrim(coalesce(p_status, '')));
begin
  if normalized_status not in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED') then
    raise exception using errcode = '22023', message = 'invalid_financial_report_message_state';
  end if;

  select attempt.* into attempt_row
    from public.financial_report_message_attempts as attempt
   where attempt.id = p_attempt_id
   for update;
  if not found or attempt_row.claim_token is distinct from p_claim_token then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  if attempt_row.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED') then
    return pg_catalog.jsonb_build_object(
      'ok', attempt_row.status = normalized_status,
      'status', attempt_row.status,
      'ignored_regression', attempt_row.status <> normalized_status
    );
  end if;
  if normalized_status = 'SUPPRESSED' then
    if attempt_row.status <> 'CLAIMED' or attempt_row.submit_attempt_count <> 0 then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'invalid_suppression_transition'
      );
    end if;
  elsif attempt_row.status <> 'SUBMITTING'
     or attempt_row.submit_attempt_count <> 1
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'submit_not_started');
  end if;

  update public.financial_report_message_attempts
     set status = normalized_status,
         provider_http_status = p_provider_http_status,
         last_error = nullif(
           pg_catalog.left(coalesce(p_error, ''), 500),
           ''
         ),
         lease_expires_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = attempt_row.id;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', normalized_status
  );
end;
$function$;

alter function public.claim_financial_report_message(
  text, text, text, date, uuid, integer
) owner to postgres;
alter function public.mark_financial_report_message_submitting(uuid, uuid)
  owner to postgres;
alter function public.finish_financial_report_message(
  uuid, uuid, text, integer, text
) owner to postgres;

revoke all on function public.claim_financial_report_message(
  text, text, text, date, uuid, integer
) from public, anon, authenticated;
revoke all on function public.mark_financial_report_message_submitting(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.finish_financial_report_message(
  uuid, uuid, text, integer, text
) from public, anon, authenticated;
grant execute on function public.claim_financial_report_message(
  text, text, text, date, uuid, integer
) to service_role;
grant execute on function public.mark_financial_report_message_submitting(uuid, uuid)
  to service_role;
grant execute on function public.finish_financial_report_message(
  uuid, uuid, text, integer, text
) to service_role;

do $postcheck$
begin
  if pg_catalog.to_regclass('public.financial_report_message_attempts') is null
     or pg_catalog.to_regprocedure(
       'public.claim_financial_report_message(text,text,text,date,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.mark_financial_report_message_submitting(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finish_financial_report_message(uuid,uuid,text,integer,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.financial_report_message_exact_scope_active(text,text,text,date)'
     ) is null
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.financial_report_message_attempts',
       'SELECT'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.claim_financial_report_message(text,text,text,date,uuid,integer)',
       'EXECUTE'
     )
  then
    raise exception 'financial report outbound fence was not installed safely';
  end if;
end;
$postcheck$;
