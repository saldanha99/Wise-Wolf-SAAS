-- Harden anonymous institutional-site intake without exposing tenant data,
-- privileged columns, arbitrary URLs, or uploaded resumes.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table if not exists private.public_intake_rate_limits (
  intake_kind text not null,
  client_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1,
  primary key (intake_kind, client_hash, window_started_at)
);

revoke all on private.public_intake_rate_limits from public, anon, authenticated;

alter table public.crm_leads
  add column if not exists notification_sent_at timestamptz;

alter table public.job_applications
  add column if not exists welcome_notification_sent_at timestamptz;

create or replace function private.can_manage_crm_tenant(target_tenant_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and (
        p.role = 'SUPER_ADMIN'
        or (
          p.tenant_id = target_tenant_id
          and p.role in ('SCHOOL_ADMIN', 'SALESPERSON', 'COMMERCIAL')
        )
      )
  );
$$;

revoke all on function private.can_manage_crm_tenant(text) from public, anon;
grant execute on function private.can_manage_crm_tenant(text) to authenticated;

create or replace function private.can_admin_tenant(target_tenant_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and (
        p.role = 'SUPER_ADMIN'
        or (p.tenant_id = target_tenant_id and p.role = 'SCHOOL_ADMIN')
      )
  );
$$;

revoke all on function private.can_admin_tenant(text) from public, anon;
grant execute on function private.can_admin_tenant(text) to authenticated;

create or replace function public.claim_public_intake_quota(
  p_intake_kind text,
  p_client_hash text,
  p_request_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  current_window timestamptz := date_trunc('hour', clock_timestamp());
  updated_count integer;
begin
  if p_intake_kind not in ('resume_upload')
    or p_client_hash !~ '^[0-9a-f]{64}$'
    or p_request_limit not between 1 and 20
  then
    return false;
  end if;

  insert into private.public_intake_rate_limits (
    intake_kind,
    client_hash,
    window_started_at,
    request_count
  )
  values (p_intake_kind, p_client_hash, current_window, 1)
  on conflict (intake_kind, client_hash, window_started_at)
  do update set request_count = private.public_intake_rate_limits.request_count + 1
  returning request_count into updated_count;

  delete from private.public_intake_rate_limits
  where window_started_at < clock_timestamp() - interval '48 hours';

  return updated_count <= p_request_limit;
end;
$$;

revoke all on function public.claim_public_intake_quota(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_public_intake_quota(text, text, integer)
  to service_role;

create or replace function private.guard_public_intake()
returns trigger
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  request_headers jsonb := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb,
    '{}'::jsonb
  );
  client_ip text;
  v_client_hash text;
  v_current_window timestamptz := date_trunc('hour', clock_timestamp());
  updated_count integer;
  normalized_phone text;
begin
  -- Authenticated back-office writes are governed by tenant RLS and do not use
  -- the anonymous intake quota.
  if (select auth.uid()) is not null
    or coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
  then
    return new;
  end if;

  client_ip := split_part(
    coalesce(
      nullif(request_headers ->> 'x-real-ip', ''),
      nullif(request_headers ->> 'cf-connecting-ip', ''),
      nullif(request_headers ->> 'x-forwarded-for', ''),
      'unknown'
    ),
    ',',
    1
  );
  v_client_hash := encode(digest(client_ip, 'sha256'), 'hex');

  if tg_table_name = 'crm_leads' then
    if new.tenant_id <> 'school-wise-wolf'
      or char_length(btrim(coalesce(new.name, ''))) not between 2 and 120
      or char_length(coalesce(new.email, '')) > 254
      or char_length(coalesce(new.phone, '')) > 32
      or char_length(coalesce(new.goal, '')) > 500
      or char_length(coalesce(new.source, '')) > 120
      or char_length(coalesce(new.notes, '')) > 3000
    then
      raise exception 'invalid public lead payload' using errcode = '22023';
    end if;

    normalized_phone := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
    if normalized_phone <> '' and char_length(normalized_phone) not between 10 and 13 then
      raise exception 'invalid public lead phone' using errcode = '22023';
    end if;
  elsif tg_table_name = 'job_applications' then
    if new.tenant_id <> 'school-wise-wolf'
      or char_length(btrim(coalesce(new.name, ''))) not between 2 and 120
      or char_length(regexp_replace(coalesce(new.whatsapp, ''), '\D', '', 'g')) not between 10 and 13
      or char_length(coalesce(new.email, '')) > 254
      or char_length(coalesce(new.source, '')) > 120
      or char_length(coalesce(new.answers::text, '')) > 20000
      or coalesce(lower(new.role), 'professor') not in ('professor', 'vendedor')
      or new.resume_url is null
      or new.resume_url not like
        'https://api.wisewolflanguage.com.br/storage/v1/object/public/resumes/school-wise-wolf/%'
    then
      raise exception 'invalid public job application payload' using errcode = '22023';
    end if;

    if exists (
      select 1
      from public.job_applications ja
      where ja.tenant_id = new.tenant_id
        and regexp_replace(ja.whatsapp, '\D', '', 'g') =
          regexp_replace(new.whatsapp, '\D', '', 'g')
        and ja.created_at >= clock_timestamp() - interval '24 hours'
    ) then
      raise exception 'application already received recently' using errcode = '23505';
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
  do update set request_count = private.public_intake_rate_limits.request_count + 1
  returning request_count into updated_count;

  if updated_count > (case when tg_table_name = 'crm_leads' then 5 else 3 end) then
    raise exception 'public intake rate limit exceeded' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_public_intake() from public, anon, authenticated;

drop trigger if exists aaa_guard_public_crm_leads on public.crm_leads;
create trigger aaa_guard_public_crm_leads
before insert on public.crm_leads
for each row execute function private.guard_public_intake();

drop trigger if exists aaa_guard_public_job_applications on public.job_applications;
create trigger aaa_guard_public_job_applications
before insert on public.job_applications
for each row execute function private.guard_public_intake();

-- crm_leads: anonymous visitors can only create a normal lead for the
-- institutional tenant; authenticated staff can only manage their own tenant.
drop policy if exists "Public can insert leads" on public.crm_leads;
drop policy if exists "Tenants can view and manage their leads" on public.crm_leads;
drop policy if exists "Unblock Select" on public.crm_leads;
drop policy if exists "crm_leads_admin" on public.crm_leads;

revoke all on table public.crm_leads from anon, authenticated;
grant insert (tenant_id, name, email, phone, status, notes, source, goal)
  on public.crm_leads to anon;
grant select, insert, update, delete on public.crm_leads to authenticated;

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
);

create policy crm_leads_tenant_staff
on public.crm_leads
for all
to authenticated
using (private.can_manage_crm_tenant(tenant_id))
with check (private.can_manage_crm_tenant(tenant_id));

-- job_applications: prevent public callers from setting workflow/AI/booking
-- fields and prevent cross-tenant access by authenticated users.
drop policy if exists "Public can insert job applications" on public.job_applications;
drop policy if exists "job_apps_admin" on public.job_applications;
drop policy if exists "job_apps_admin_delete" on public.job_applications;
drop policy if exists "job_apps_admin_write" on public.job_applications;

revoke all on table public.job_applications from anon, authenticated;
grant insert (tenant_id, name, whatsapp, resume_url, status, source, role, email, answers)
  on public.job_applications to anon;
grant select, insert, update, delete on public.job_applications to authenticated;

create policy job_applications_public_insert
on public.job_applications
for insert
to anon
with check (
  tenant_id = 'school-wise-wolf'
  and status = 'Novo'
  and ai_score is null
  and ai_summary is null
  and ai_flags is null
  and ai_recommendation is null
  and ai_screened_at is null
  and preinterview_status is null
  and preinterview_answers is null
  and preinterview_sent_at is null
  and preinterview_done_at is null
  and interview_slot is null
  and coalesce(ai_handoff, false) = false
  and welcome_notification_sent_at is null
);

create policy job_applications_tenant_staff
on public.job_applications
for all
to authenticated
using (private.can_admin_tenant(tenant_id))
with check (private.can_admin_tenant(tenant_id));

-- Keep the resumes bucket private, bounded and non-enumerable.
update storage.buckets
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array[
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]::text[]
where id = 'resumes';

drop policy if exists "Public Read Resumes" on storage.objects;
drop policy if exists "Public Upload Resumes" on storage.objects;
drop policy if exists "resumes_anyone_insert" on storage.objects;
drop policy if exists "resumes_owner_select" on storage.objects;

create policy resumes_authenticated_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'resumes'
  and (
    owner = (select auth.uid())
    or private.can_admin_tenant((storage.foldername(name))[1])
  )
  and lower(storage.extension(name)) in ('pdf', 'doc', 'docx')
);

create policy resumes_owner_or_tenant_staff_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'resumes'
  and (
    owner = (select auth.uid())
    or private.can_admin_tenant((storage.foldername(name))[1])
  )
);

-- Replace secret-bearing/duplicate notification triggers with one internal,
-- service-authenticated dispatch per inserted row.
drop trigger if exists on_lead_created on public.crm_leads;
drop function if exists public.handle_new_lead();

create or replace function public.notify_on_new_lead()
returns trigger
language plpgsql
security definer
set search_path = public, vault, net, pg_temp
as $$
declare
  service_key text;
begin
  select decrypted_secret
  into service_key
  from vault.decrypted_secrets
  where name = 'wisewolf_service_role_key'
  limit 1;

  if service_key is null or service_key = '' then
    raise warning 'wisewolf_service_role_key is not configured';
    return new;
  end if;

  perform net.http_post(
    url := 'http://kong:8000/functions/v1/whatsapp-crm-lead-notif',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key,
      'apikey', service_key
    ),
    body := jsonb_build_object('lead_id', new.id),
    timeout_milliseconds := 10000
  );

  return new;
end;
$$;

revoke all on function public.notify_on_new_lead() from public, anon, authenticated;

drop trigger if exists trigger_crm_lead_notification on public.crm_leads;
create trigger trigger_crm_lead_notification
after insert on public.crm_leads
for each row execute function public.notify_on_new_lead();

create or replace function public.notify_hr_applicant()
returns trigger
language plpgsql
security definer
set search_path = public, vault, net, pg_temp
as $$
declare
  service_key text;
begin
  select decrypted_secret
  into service_key
  from vault.decrypted_secrets
  where name = 'wisewolf_service_role_key'
  limit 1;

  if service_key is null or service_key = '' then
    raise warning 'wisewolf_service_role_key is not configured';
    return new;
  end if;

  perform net.http_post(
    url := 'http://kong:8000/functions/v1/whatsapp-hr-welcome',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key,
      'apikey', service_key
    ),
    body := jsonb_build_object('application_id', new.id),
    timeout_milliseconds := 10000
  );

  return new;
end;
$$;

revoke all on function public.notify_hr_applicant() from public, anon, authenticated;

drop trigger if exists trigger_notify_hr_applicant on public.job_applications;
create trigger trigger_notify_hr_applicant
after insert on public.job_applications
for each row execute function public.notify_hr_applicant();

comment on function private.guard_public_intake() is
  'Validates and rate-limits anonymous institutional lead/job submissions.';
comment on function private.can_manage_crm_tenant(text) is
  'Checks authenticated CRM staff authorization against the trusted profile row.';
comment on function private.can_admin_tenant(text) is
  'Checks authenticated tenant-admin authorization against the trusted profile row.';
