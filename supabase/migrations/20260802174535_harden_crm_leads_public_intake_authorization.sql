-- Close legacy permissive crm_leads policies and ensure the public intake
-- trigger only bypasses validation for service_role or tenant-authorized staff.
--
-- Wolfie quiz submissions also receive a caller-generated UUID idempotency key.
-- The unique constraint prevents duplicate rows and duplicate AFTER INSERT
-- notifications while keeping anonymous callers unable to read or update leads.

begin;

alter table public.crm_leads
  add column if not exists public_intake_idempotency_key uuid;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.crm_leads'::pg_catalog.regclass
      and conname = 'crm_leads_public_intake_idempotency_uniq'
      and contype = 'u'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_public_intake_idempotency_uniq
      unique (tenant_id, public_intake_idempotency_key);
  end if;
end;
$migration$;

-- Both helpers already qualify their trusted relation. An empty search_path
-- removes public-schema object shadowing from their SECURITY DEFINER context.
alter function private.can_manage_crm_tenant(text) set search_path = '';
alter function private.can_admin_tenant(text) set search_path = '';

create or replace function private.guard_public_intake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  request_headers pg_catalog.jsonb := coalesce(
    nullif(
      pg_catalog.current_setting('request.headers', true),
      ''
    )::pg_catalog.jsonb,
    '{}'::pg_catalog.jsonb
  );
  caller_role text := coalesce(auth.jwt() ->> 'role', '');
  client_ip text;
  v_client_hash text;
  v_current_window timestamptz := pg_catalog.date_trunc(
    'hour',
    pg_catalog.clock_timestamp()
  );
  updated_count integer;
  normalized_phone text;
  staff_authorized boolean := false;
begin
  -- service_role is the only JWT role allowed to bypass tenant checks. A
  -- regular authenticated identity must still be authorized by its trusted
  -- profile row for the tenant being written.
  if caller_role = 'service_role' then
    return new;
  end if;

  if (select auth.uid()) is not null then
    if tg_table_schema = 'public' and tg_table_name = 'crm_leads' then
      staff_authorized := private.can_manage_crm_tenant(new.tenant_id);
    elsif tg_table_schema = 'public' and tg_table_name = 'job_applications' then
      staff_authorized := private.can_admin_tenant(new.tenant_id);
    end if;

    if staff_authorized then
      return new;
    end if;
  end if;

  client_ip := pg_catalog.split_part(
    coalesce(
      nullif(request_headers ->> 'x-real-ip', ''),
      nullif(request_headers ->> 'cf-connecting-ip', ''),
      nullif(request_headers ->> 'x-forwarded-for', ''),
      'unknown'
    ),
    ',',
    1
  );
  v_client_hash := pg_catalog.encode(
    extensions.digest(client_ip, 'sha256'),
    'hex'
  );

  if tg_table_schema = 'public' and tg_table_name = 'crm_leads' then
    if new.tenant_id is distinct from 'school-wise-wolf'
      or pg_catalog.char_length(pg_catalog.btrim(coalesce(new.name, '')))
        not between 2 and 120
      or pg_catalog.char_length(coalesce(new.email, '')) > 254
      or pg_catalog.char_length(coalesce(new.phone, '')) > 32
      or pg_catalog.char_length(coalesce(new.goal, '')) > 500
      or pg_catalog.char_length(coalesce(new.source, '')) > 120
      or pg_catalog.char_length(coalesce(new.notes, '')) > 3000
      or (
        new.source = 'wolfie_quiz'
        and new.public_intake_idempotency_key is null
      )
    then
      raise exception 'invalid public lead payload' using errcode = '22023';
    end if;

    normalized_phone := pg_catalog.regexp_replace(
      coalesce(new.phone, ''),
      '\D',
      '',
      'g'
    );
    if normalized_phone <> ''
      and pg_catalog.char_length(normalized_phone) not between 10 and 13
    then
      raise exception 'invalid public lead phone' using errcode = '22023';
    end if;
  elsif tg_table_schema = 'public' and tg_table_name = 'job_applications' then
    if new.tenant_id is distinct from 'school-wise-wolf'
      or pg_catalog.char_length(pg_catalog.btrim(coalesce(new.name, '')))
        not between 2 and 120
      or pg_catalog.char_length(
        pg_catalog.regexp_replace(
          coalesce(new.whatsapp, ''),
          '\D',
          '',
          'g'
        )
      ) not between 10 and 13
      or pg_catalog.char_length(coalesce(new.email, '')) > 254
      or pg_catalog.char_length(coalesce(new.source, '')) > 120
      or pg_catalog.char_length(coalesce(new.answers::text, '')) > 20000
      or coalesce(pg_catalog.lower(new.role), 'professor')
        not in ('professor', 'vendedor')
      or new.resume_url is null
      or new.resume_url not like
        'https://api.wisewolflanguage.com.br/storage/v1/object/public/resumes/school-wise-wolf/%'
    then
      raise exception 'invalid public job application payload'
        using errcode = '22023';
    end if;

    if exists (
      select 1
      from public.job_applications as application
      where application.tenant_id = new.tenant_id
        and pg_catalog.regexp_replace(
          application.whatsapp,
          '\D',
          '',
          'g'
        ) = pg_catalog.regexp_replace(new.whatsapp, '\D', '', 'g')
        and application.created_at >=
          pg_catalog.clock_timestamp() - interval '24 hours'
    ) then
      raise exception 'application already received recently'
        using errcode = '23505';
    end if;
  else
    raise exception 'unsupported public intake table' using errcode = '22023';
  end if;

  insert into private.public_intake_rate_limits (
    intake_kind,
    client_hash,
    window_started_at,
    request_count
  )
  values (tg_table_name, v_client_hash, v_current_window, 1)
  on conflict (intake_kind, client_hash, window_started_at)
  do update
    set request_count =
      private.public_intake_rate_limits.request_count + 1
  returning request_count into updated_count;

  if updated_count > (case when tg_table_name = 'crm_leads' then 5 else 3 end) then
    raise exception 'public intake rate limit exceeded' using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

revoke all on function private.guard_public_intake()
  from public, anon, authenticated, service_role;

drop trigger if exists aaa_guard_public_crm_leads on public.crm_leads;
create trigger aaa_guard_public_crm_leads
before insert on public.crm_leads
for each row execute function private.guard_public_intake();

drop trigger if exists aaa_guard_public_job_applications
  on public.job_applications;
create trigger aaa_guard_public_job_applications
before insert on public.job_applications
for each row execute function private.guard_public_intake();

-- Remove every known legacy/broad policy explicitly before installing the
-- closed policy set. PostgreSQL combines permissive policies with OR, so one
-- forgotten WITH CHECK (true) would nullify the tenant policy.
drop policy if exists "Enable insert for authenticated users"
  on public.crm_leads;
drop policy if exists "Enable select for users based on tenant"
  on public.crm_leads;
drop policy if exists "Enable update for authenticated users"
  on public.crm_leads;
drop policy if exists "Admins insert" on public.crm_leads;
drop policy if exists "Admins select" on public.crm_leads;
drop policy if exists "Unblock Insert" on public.crm_leads;
drop policy if exists "Unblock Select" on public.crm_leads;
drop policy if exists "Unblock Update" on public.crm_leads;
drop policy if exists "Public can insert leads" on public.crm_leads;
drop policy if exists "Tenants can view and manage their leads"
  on public.crm_leads;
drop policy if exists "crm_leads_admin" on public.crm_leads;
drop policy if exists crm_leads_public_insert on public.crm_leads;
drop policy if exists crm_leads_tenant_staff on public.crm_leads;
drop policy if exists crm_leads_service_role on public.crm_leads;

alter table public.crm_leads enable row level security;

revoke all on table public.crm_leads
  from public, anon, authenticated, service_role;

-- Table-level REVOKE does not remove historical column ACLs. Clear every
-- anonymous/PUBLIC column grant before rebuilding the narrow intake allowlist.
do $column_grants$
declare
  all_columns text;
begin
  select pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', ' order by attribute.attnum
  )
  into all_columns
  from pg_catalog.pg_attribute as attribute
  where attribute.attrelid = 'public.crm_leads'::pg_catalog.regclass
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if all_columns is null then
    raise exception 'public.crm_leads has no grantable columns';
  end if;

  execute pg_catalog.format(
    'revoke all privileges (%s) on table public.crm_leads from public, anon',
    all_columns
  );
end;
$column_grants$;

grant insert (
  tenant_id,
  name,
  email,
  phone,
  status,
  notes,
  source,
  goal,
  public_intake_idempotency_key
) on public.crm_leads to anon;
grant select, insert, update, delete on public.crm_leads to authenticated;
grant all privileges on public.crm_leads to service_role;

create policy crm_leads_public_insert
on public.crm_leads
for insert
to anon
with check (
  tenant_id = 'school-wise-wolf'
  and status = 'NEW'
  and trial_lesson_id is null
  and assigned_teacher_id is null
  and coalesce(value, 0) = 0
  and coalesce(ai_handled, false) = false
  and coalesce(ai_handoff, false) = false
  and notification_sent_at is null
  and (
    source is distinct from 'wolfie_quiz'
    or public_intake_idempotency_key is not null
  )
);

create policy crm_leads_tenant_staff
on public.crm_leads
for all
to authenticated
using (private.can_manage_crm_tenant(tenant_id))
with check (private.can_manage_crm_tenant(tenant_id));

-- service_role normally has BYPASSRLS in Supabase. The explicit policy and
-- grant document the intended access and remain correct if that role is used
-- in a context where RLS is enforced.
create policy crm_leads_service_role
on public.crm_leads
for all
to service_role
using (true)
with check (true);

-- Fail closed if an unexpected policy remains. This guards against a later
-- environment-specific policy silently OR-ing around the policy set above.
do $validation$
declare
  actual_policies text[];
  anon_insert_columns text[];
begin
  select pg_catalog.array_agg(policyname::text order by policyname::text)
  into actual_policies
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'crm_leads';

  if actual_policies is distinct from array[
    'crm_leads_public_insert',
    'crm_leads_service_role',
    'crm_leads_tenant_staff'
  ]::text[] then
    raise exception 'unexpected crm_leads RLS policy set: %', actual_policies;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'crm_leads'
      and policyname = 'crm_leads_public_insert'
      and cmd = 'INSERT'
      and roles = array['anon']::name[]
      and with_check like '%school-wise-wolf%'
      and with_check like '%public_intake_idempotency_key%'
  ) then
    raise exception 'crm_leads_public_insert policy validation failed';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'crm_leads'
      and policyname = 'crm_leads_tenant_staff'
      and cmd = 'ALL'
      and roles = array['authenticated']::name[]
      and qual like '%can_manage_crm_tenant%'
      and with_check like '%can_manage_crm_tenant%'
  ) then
    raise exception 'crm_leads_tenant_staff policy validation failed';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'crm_leads'
      and policyname = 'crm_leads_service_role'
      and cmd = 'ALL'
      and roles = array['service_role']::name[]
  ) then
    raise exception 'crm_leads_service_role policy validation failed';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class
    where oid = 'public.crm_leads'::pg_catalog.regclass
      and relrowsecurity
  ) then
    raise exception 'RLS is not enabled on public.crm_leads';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.crm_leads'::pg_catalog.regclass
      and conname = 'crm_leads_public_intake_idempotency_uniq'
      and contype = 'u'
      and pg_catalog.pg_get_constraintdef(oid, true) =
        'UNIQUE (tenant_id, public_intake_idempotency_key)'
  ) then
    raise exception 'crm_leads idempotency constraint validation failed';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute
    where attrelid = 'public.crm_leads'::pg_catalog.regclass
      and attname = 'public_intake_idempotency_key'
      and atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
      and not attisdropped
  ) then
    raise exception 'crm_leads idempotency column validation failed';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_row
    join pg_catalog.pg_proc as procedure
      on procedure.oid = trigger_row.tgfoid
    join pg_catalog.pg_namespace as procedure_schema
      on procedure_schema.oid = procedure.pronamespace
    where trigger_row.tgrelid = 'public.crm_leads'::pg_catalog.regclass
      and trigger_row.tgname = 'aaa_guard_public_crm_leads'
      and not trigger_row.tgisinternal
      and procedure_schema.nspname = 'private'
      and procedure.proname = 'guard_public_intake'
  ) then
    raise exception 'crm_leads public intake trigger validation failed';
  end if;

  select pg_catalog.array_agg(attribute.attname::text order by attribute.attname)
  into anon_insert_columns
  from pg_catalog.pg_attribute as attribute
  where attribute.attrelid = 'public.crm_leads'::pg_catalog.regclass
    and attribute.attnum > 0
    and not attribute.attisdropped
    and pg_catalog.has_column_privilege(
      'anon',
      'public.crm_leads',
      attribute.attname,
      'INSERT'
    );

  if anon_insert_columns is distinct from array[
    'email',
    'goal',
    'name',
    'notes',
    'phone',
    'public_intake_idempotency_key',
    'source',
    'status',
    'tenant_id'
  ]::text[]
    or pg_catalog.has_any_column_privilege(
      'anon',
      'public.crm_leads',
      'SELECT'
    )
    or pg_catalog.has_any_column_privilege(
      'anon',
      'public.crm_leads',
      'UPDATE'
    )
    or pg_catalog.has_any_column_privilege(
      'anon',
      'public.crm_leads',
      'REFERENCES'
    )
    or pg_catalog.has_table_privilege('anon', 'public.crm_leads', 'DELETE')
  then
    raise exception 'anonymous crm_leads grants validation failed';
  end if;
end;
$validation$;

comment on column public.crm_leads.public_intake_idempotency_key is
  'Opaque client UUID used to deduplicate public lead intake; never an authorization credential.';
comment on function private.guard_public_intake() is
  'Validates/rate-limits public or unauthorized intake; bypasses only service_role and tenant-authorized staff.';

notify pgrst, 'reload schema';

commit;
