-- Restrict public SaaS lead intake to the contact fields required for a
-- diagnosis. Workflow, conversion and tenant provisioning remain privileged.

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

create index if not exists public_intake_rate_limits_window_started_idx
on private.public_intake_rate_limits (window_started_at);

revoke all on private.public_intake_rate_limits
from public, anon, authenticated;

create or replace function private.guard_public_saas_lead_intake()
returns trigger
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  client_identity text;
  rate_limit_client_hash text;
  current_window timestamptz := date_trunc('hour', clock_timestamp());
  updated_count integer;
  normalized_phone text := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
  normalized_owner_phone text := regexp_replace(coalesce(new.owner_phone, ''), '\D', '', 'g');
begin
  if coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
    or exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.role = 'SUPER_ADMIN'
        and lower(btrim(profile.lifecycle_status)) = 'active'
    )
  then
    return new;
  end if;

  if char_length(btrim(coalesce(new.name, ''))) not between 2 and 120
    or char_length(btrim(coalesce(new.school_name, ''))) not between 2 and 160
    or char_length(btrim(coalesce(new.email, ''))) not between 5 and 254
    or position('@' in coalesce(new.email, '')) <= 1
    or char_length(normalized_phone) not between 10 and 13
    or char_length(coalesce(new.notes, '')) > 3000
    or char_length(coalesce(new.source, '')) > 120
    or char_length(coalesce(new.plan_interest, '')) > 120
    or new.lead_type not in ('school', 'teacher')
    or new.converted_tenant_id is not null
    or (new.estimated_students is not null and new.estimated_students not between 0 and 1000000)
    or (new.estimated_teachers is not null and new.estimated_teachers not between 0 and 100000)
    or (normalized_owner_phone <> '' and char_length(normalized_owner_phone) not between 10 and 13)
    or new.owner_cpf_cnpj is not null
  then
    raise exception 'invalid public SaaS lead payload' using errcode = '22023';
  end if;

  if new.lead_type = 'teacher' then
    if lower(coalesce(new.status, '')) <> 'new'
      or new.plan_interest <> 'Professor Negócio'
      or coalesce(new.estimated_teachers, 1) <> 1
      or new.source <> (case
        when new.referrer_teacher_id is not null then 'teacher_to_teacher_referral'
        when new.parent_tenant_id is not null then 'teacher_referral'
        else 'teacher_signup'
      end)
      or btrim(coalesce(new.owner_name, '')) <> btrim(new.name)
      or lower(btrim(coalesce(new.owner_email, ''))) <> lower(btrim(new.email))
      or (normalized_owner_phone <> '' and normalized_owner_phone <> normalized_phone)
      or (
        new.parent_tenant_id is not null
        and (
          new.parent_tenant_id = 'master'
          or not exists (
            select 1
            from public.tenants as tenant
            where tenant.id = new.parent_tenant_id
          )
        )
      )
      or (
        new.referrer_teacher_id is not null
        and not exists (
          select 1
          from public.profiles as teacher
          join public.tenant_memberships as membership
            on membership.user_id = teacher.id
           and membership.status = 'ACTIVE'
           and membership.role = 'TEACHER'
          where teacher.id = new.referrer_teacher_id
            and teacher.role = 'TEACHER'
            and lower(btrim(teacher.lifecycle_status)) = 'active'
            and (
              new.parent_tenant_id is null
              or membership.tenant_id = new.parent_tenant_id
            )
        )
      )
    then
      raise exception 'invalid public teacher lead payload' using errcode = '22023';
    end if;
  elsif upper(coalesce(new.status, '')) <> 'LEAD'
    or new.source <> 'public_school_diagnosis'
    or new.plan_interest <> 'Wise Wolf para Escolas — diagnóstico assistido'
    or btrim(coalesce(new.owner_name, '')) <> btrim(new.name)
    or lower(btrim(coalesce(new.owner_email, ''))) <> lower(btrim(new.email))
    or normalized_owner_phone <> normalized_phone
    or new.parent_tenant_id is not null
    or new.referrer_teacher_id is not null
  then
    raise exception 'invalid public school lead payload' using errcode = '22023';
  end if;

  client_identity := coalesce(
    (select auth.uid())::text,
    lower(btrim(new.email)) || ':' || normalized_phone
  );
  rate_limit_client_hash := encode(digest(client_identity, 'sha256'), 'hex');

  insert into private.public_intake_rate_limits (
    intake_kind,
    client_hash,
    window_started_at,
    request_count
  )
  values ('saas_leads', rate_limit_client_hash, current_window, 1)
  on conflict (intake_kind, client_hash, window_started_at)
  do update
  set request_count = private.public_intake_rate_limits.request_count + 1
  returning request_count into updated_count;

  if updated_count > 5 then
    raise exception 'public SaaS lead rate limit exceeded' using errcode = 'P0001';
  end if;

  delete from private.public_intake_rate_limits
  where window_started_at < clock_timestamp() - interval '48 hours';

  return new;
end;
$$;

revoke all on function private.guard_public_saas_lead_intake()
from public, anon, authenticated;

drop trigger if exists aaa_guard_public_saas_leads on public.saas_leads;
create trigger aaa_guard_public_saas_leads
before insert on public.saas_leads
for each row execute function private.guard_public_saas_lead_intake();

alter table public.saas_leads enable row level security;

drop policy if exists "saas_leads_insert_public" on public.saas_leads;
drop policy if exists "Super Admin access saas_leads" on public.saas_leads;
drop policy if exists "saas_leads_manage_admin" on public.saas_leads;
drop policy if exists "saas_leads_public_intake" on public.saas_leads;
drop policy if exists "saas_leads_super_admin" on public.saas_leads;

revoke all on table public.saas_leads from anon, authenticated;

grant insert (
  name,
  email,
  phone,
  school_name,
  status,
  notes,
  owner_name,
  owner_email,
  owner_phone,
  estimated_students,
  estimated_teachers,
  source,
  plan_interest,
  lead_type,
  parent_tenant_id,
  referrer_teacher_id
) on public.saas_leads to anon, authenticated;

grant select, update, delete on public.saas_leads to authenticated;

create policy saas_leads_public_intake
on public.saas_leads
for insert
to anon, authenticated
with check (
  converted_tenant_id is null
  and lead_type in ('school', 'teacher')
  and (
    (
      lead_type = 'teacher'
      and lower(status) = 'new'
      and plan_interest = 'Professor Negócio'
    )
    or (
      lead_type = 'school'
      and upper(status) = 'LEAD'
      and parent_tenant_id is null
      and referrer_teacher_id is null
    )
  )
);

create policy saas_leads_super_admin
on public.saas_leads
for all
to authenticated
using ((select public._my_role()) = 'SUPER_ADMIN')
with check ((select public._my_role()) = 'SUPER_ADMIN');

comment on function private.guard_public_saas_lead_intake() is
  'Validates and rate-limits public SaaS diagnosis requests before they enter the privileged sales workflow.';
