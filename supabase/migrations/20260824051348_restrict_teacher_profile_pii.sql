begin;

-- Teachers need a pedagogical directory, not the tenant's full identity,
-- financial and contractual dossier. Keep the relation check server-side so a
-- client cannot widen it by changing filters.
create or replace function public._teacher_can_access_student(
  p_student_id uuid,
  p_tenant_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.profiles as caller
      join public.profiles as student
        on student.id = p_student_id
     where caller.id = (select auth.uid())
       and caller.role = 'TEACHER'
       and caller.tenant_id = p_tenant_id
       and student.role = 'STUDENT'
       and student.tenant_id = p_tenant_id
       and (
         student.professor_id = caller.id
         or student.professor_id2 = caller.id
         or exists (
           select 1
             from public.bookings as booking
            where booking.student_id = student.id
              and booking.teacher_id = caller.id
              and booking.tenant_id = p_tenant_id
              and booking.status = 'SCHEDULED'
         )
       )
  );
$function$;

alter function public._teacher_can_access_student(uuid, text) owner to postgres;
revoke all on function public._teacher_can_access_student(uuid, text)
  from public, anon;
grant execute on function public._teacher_can_access_student(uuid, text)
  to authenticated;

drop policy if exists profiles_scoped_read_p0 on public.profiles;
drop policy if exists profiles_scoped_read_p1 on public.profiles;
create policy profiles_scoped_read_p1
on public.profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (select public._my_role()) = 'SCHOOL_ADMIN'
  )
  or (
    tenant_id = (select public._my_tenant_id())
    and (select public._my_role()) = 'TEACHER'
    and (
      role = 'TEACHER'
      or (
        role = 'STUDENT'
        and (select public._teacher_can_access_student(id, tenant_id))
      )
    )
  )
);

-- A table-level SELECT grants every present and future column. Replace it with
-- an allow-list and also clear historical column-level grants before rebuilding
-- the directory projection.
do $block$
declare
  v_all_columns text;
  v_directory_columns text;
begin
  select pg_catalog.string_agg(
           pg_catalog.format('%I', column_name),
           ', ' order by ordinal_position
         )
    into v_all_columns
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'profiles';

  select pg_catalog.string_agg(
           pg_catalog.format('%I', column_name),
           ', ' order by ordinal_position
         )
    into v_directory_columns
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'profiles'
     and column_name <> all (array[
       'hourly_rate', 'commission_rate',
       'bank_name', 'agency', 'account_number', 'pix_key', 'pix_key_type',
       'monthly_fee', 'monthly_tuition', 'fidelity_plan', 'due_day', 'paid_through',
       'prepaid_months', 'status_financial', 'first_overdue_at',
       'enrollment_fee', 'enrollment_fee_paid', 'enrollment_payment_id',
       'asaas_customer_id', 'subscription_id',
       'asaas_subscription_status', 'asaas_subscription_end_date',
       'asaas_subscription_synced_at',
       'cpf', 'rg', 'birth_date', 'cnpj', 'cnpj_company_name',
       'address', 'address_number', 'postal_code',
       'guardian_name', 'guardian_cpf', 'guardian_email', 'guardian_phone',
       'guardian_id', 'private_notes',
       'signature_ip', 'signature_url', 'contract_url',
       'student_signature_url', 'signed_document_url',
       'wise_wolf_signature_token', 'typed_signature', 'signature_hash',
       'user_ip', 'whatsapp_token'
     ]::text[]);

  if v_all_columns is null or v_directory_columns is null then
    raise exception 'public.profiles column allow-list could not be built';
  end if;

  revoke select on table public.profiles from public, anon, authenticated;
  execute pg_catalog.format(
    'revoke select (%s) on table public.profiles from public, anon, authenticated',
    v_all_columns
  );
  execute pg_catalog.format(
    'grant select (%s) on table public.profiles to authenticated',
    v_directory_columns
  );
end;
$block$;

-- Private fields are returned explicitly: never use to_jsonb(profile), because
-- a future column would silently become public through this function.
create or replace function public.get_authorized_profile_private(
  p_profile_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text := public._my_role();
  v_tenant text := public._my_tenant_id();
  v_target uuid := coalesce(p_profile_id, auth.uid());
  v_result jsonb;
begin
  if v_uid is null or v_target is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select pg_catalog.jsonb_build_object(
    'id', profile.id,
    'cpf', profile.cpf,
    'rg', profile.rg,
    'birth_date', profile.birth_date,
    'cnpj', profile.cnpj,
    'cnpj_company_name', profile.cnpj_company_name,
    'address', profile.address,
    'address_number', profile.address_number,
    'postal_code', profile.postal_code,
    'guardian_name', profile.guardian_name,
    'guardian_cpf', profile.guardian_cpf,
    'guardian_email', profile.guardian_email,
    'guardian_phone', profile.guardian_phone,
    'guardian_id', profile.guardian_id,
    'private_notes', profile.private_notes,
    'bank_name', profile.bank_name,
    'agency', profile.agency,
    'account_number', profile.account_number,
    'pix_key', profile.pix_key,
    'pix_key_type', profile.pix_key_type,
    'hourly_rate', profile.hourly_rate,
    'commission_rate', profile.commission_rate,
    'monthly_fee', profile.monthly_fee,
    'monthly_tuition', profile.monthly_tuition,
    'fidelity_plan', profile.fidelity_plan,
    'due_day', profile.due_day,
    'paid_through', profile.paid_through,
    'prepaid_months', profile.prepaid_months,
    'status_financial', profile.status_financial,
    'first_overdue_at', profile.first_overdue_at,
    'enrollment_fee', profile.enrollment_fee,
    'enrollment_fee_paid', profile.enrollment_fee_paid,
    'enrollment_payment_id', profile.enrollment_payment_id,
    'asaas_customer_id', profile.asaas_customer_id,
    'subscription_id', profile.subscription_id,
    'asaas_subscription_status', profile.asaas_subscription_status,
    'asaas_subscription_end_date', profile.asaas_subscription_end_date,
    'asaas_subscription_synced_at', profile.asaas_subscription_synced_at,
    'signature_ip', profile.signature_ip,
    'signature_url', profile.signature_url,
    'contract_url', profile.contract_url,
    'student_signature_url', profile.student_signature_url,
    'signed_document_url', profile.signed_document_url,
    'wise_wolf_signature_token', profile.wise_wolf_signature_token,
    'typed_signature', profile.typed_signature,
    'signature_hash', profile.signature_hash,
    'user_ip', profile.user_ip
  )
    into v_result
    from public.profiles as profile
   where profile.id = v_target
     and (
       profile.id = v_uid
       or v_role = 'SUPER_ADMIN'
       or (
         v_role = 'SCHOOL_ADMIN'
         and profile.tenant_id = v_tenant
       )
     );

  if v_result is null then
    raise exception 'profile private fields are not authorized'
      using errcode = '42501';
  end if;

  return v_result;
end;
$function$;

alter function public.get_authorized_profile_private(uuid) owner to postgres;
revoke all on function public.get_authorized_profile_private(uuid)
  from public, anon;
grant execute on function public.get_authorized_profile_private(uuid)
  to authenticated;

create or replace function public.get_authorized_guardian_directory(
  p_tenant_id text
)
returns table (
  id uuid,
  full_name text,
  cpf text,
  email text,
  phone text,
  postal_code text,
  address text,
  address_number text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := public._my_role();
  v_tenant text := public._my_tenant_id();
begin
  if auth.uid() is null
     or p_tenant_id is null
     or not (
       v_role = 'SUPER_ADMIN'
       or (v_role = 'SCHOOL_ADMIN' and v_tenant = p_tenant_id)
     ) then
    raise exception 'guardian directory is not authorized'
      using errcode = '42501';
  end if;

  return query
  select
    profile.id,
    profile.full_name,
    profile.cpf,
    profile.email,
    profile.phone,
    profile.postal_code,
    profile.address,
    profile.address_number
  from public.profiles as profile
  where profile.tenant_id = p_tenant_id
    and profile.cpf is not null
    and profile.cpf <> ''
  order by profile.full_name, profile.id;
end;
$function$;

alter function public.get_authorized_guardian_directory(text) owner to postgres;
revoke all on function public.get_authorized_guardian_directory(text)
  from public, anon;
grant execute on function public.get_authorized_guardian_directory(text)
  to authenticated;

create or replace function public.get_authorized_profile_dependents(
  p_guardian_id uuid
)
returns table (
  id uuid,
  full_name text,
  email text,
  monthly_fee numeric,
  subscription_id text,
  status_financial text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := public._my_role();
  v_tenant text := public._my_tenant_id();
  v_guardian_tenant text;
begin
  select profile.tenant_id
    into v_guardian_tenant
    from public.profiles as profile
   where profile.id = p_guardian_id;

  if auth.uid() is null
     or v_guardian_tenant is null
     or not (
       v_role = 'SUPER_ADMIN'
       or (v_role = 'SCHOOL_ADMIN' and v_tenant = v_guardian_tenant)
     ) then
    raise exception 'dependent billing directory is not authorized'
      using errcode = '42501';
  end if;

  return query
  select
    profile.id,
    profile.full_name,
    profile.email,
    profile.monthly_fee,
    profile.subscription_id,
    profile.status_financial
  from public.profiles as profile
  where profile.tenant_id = v_guardian_tenant
    and profile.guardian_id = p_guardian_id
  order by profile.full_name, profile.id;
end;
$function$;

alter function public.get_authorized_profile_dependents(uuid) owner to postgres;
revoke all on function public.get_authorized_profile_dependents(uuid)
  from public, anon;
grant execute on function public.get_authorized_profile_dependents(uuid)
  to authenticated;

create or replace function public.get_authorized_student_billing_summary(
  p_tenant_id text
)
returns table (
  id uuid,
  monthly_fee numeric,
  status_financial text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := public._my_role();
  v_tenant text := public._my_tenant_id();
begin
  if auth.uid() is null
     or p_tenant_id is null
     or not (
       v_role = 'SUPER_ADMIN'
       or (v_role = 'SCHOOL_ADMIN' and v_tenant = p_tenant_id)
     ) then
    raise exception 'student billing summary is not authorized'
      using errcode = '42501';
  end if;

  return query
  select profile.id, profile.monthly_fee, profile.status_financial
  from public.profiles as profile
  where profile.tenant_id = p_tenant_id
    and profile.role = 'STUDENT'
  order by profile.id;
end;
$function$;

alter function public.get_authorized_student_billing_summary(text)
  owner to postgres;
revoke all on function public.get_authorized_student_billing_summary(text)
  from public, anon;
grant execute on function public.get_authorized_student_billing_summary(text)
  to authenticated;

create or replace function public.find_authorized_profile_by_cpf(
  p_tenant_id text,
  p_cpf text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := public._my_role();
  v_tenant text := public._my_tenant_id();
  v_normalized_cpf text := pg_catalog.regexp_replace(
    coalesce(p_cpf, ''),
    '[^0-9]',
    '',
    'g'
  );
  v_profile_id uuid;
begin
  if auth.uid() is null
     or p_tenant_id is null
     or not (
       v_role = 'SUPER_ADMIN'
       or (v_role = 'SCHOOL_ADMIN' and v_tenant = p_tenant_id)
     ) then
    raise exception 'CPF lookup is not authorized' using errcode = '42501';
  end if;

  if v_normalized_cpf = '' then
    return null;
  end if;

  select profile.id
    into v_profile_id
    from public.profiles as profile
   where profile.tenant_id = p_tenant_id
     and pg_catalog.regexp_replace(
       coalesce(profile.cpf, ''),
       '[^0-9]',
       '',
       'g'
     ) = v_normalized_cpf
   order by profile.id
   limit 1;

  return v_profile_id;
end;
$function$;

alter function public.find_authorized_profile_by_cpf(text, text) owner to postgres;
revoke all on function public.find_authorized_profile_by_cpf(text, text)
  from public, anon;
grant execute on function public.find_authorized_profile_by_cpf(text, text)
  to authenticated;

-- Keep the complete function private and expose a compatibility wrapper that
-- strips guardian/financial status from the teacher response.
do $block$
begin
  if to_regprocedure('public.get_student_overview_internal_20260824(uuid)') is null
     and to_regprocedure('public.get_student_overview(uuid)') is not null then
    alter function public.get_student_overview(uuid)
      rename to get_student_overview_internal_20260824;
  end if;
end;
$block$;

alter function public.get_student_overview_internal_20260824(uuid)
  owner to postgres;
revoke all on function public.get_student_overview_internal_20260824(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_student_overview(p_student_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_profile jsonb;
begin
  v_result := public.get_student_overview_internal_20260824(p_student_id);

  if coalesce((v_result ->> 'can_edit_financial')::boolean, false) then
    return v_result;
  end if;

  v_profile := coalesce(v_result -> 'profile', '{}'::jsonb)
    - array['guardian_name', 'guardian_phone', 'status_financial']::text[];

  if v_result ? 'profile' then
    v_result := pg_catalog.jsonb_set(v_result, '{profile}', v_profile, false);
  end if;

  return v_result - array['financial', 'payments', 'audit']::text[];
end;
$function$;

comment on function public.get_student_overview(uuid) is
  'Ficha 360 com dados financeiros e do responsavel somente para direcao autorizada.';
alter function public.get_student_overview(uuid) owner to postgres;
revoke all on function public.get_student_overview(uuid) from public, anon;
grant execute on function public.get_student_overview(uuid)
  to authenticated, service_role;

-- Row authorization is not enough for UPDATE: a teacher allowed to change a
-- pedagogical field must still be unable to overwrite identity or contract data.
create or replace function public.enforce_profile_authorization_fields()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  actor_id uuid := (select auth.uid());
  actor_role text;
  privileged_runtime boolean := current_user in (
    'postgres', 'service_role', 'supabase_admin'
  );
begin
  if privileged_runtime then return new; end if;

  select profile.role into actor_role
  from public.profiles as profile
  where profile.id = actor_id;
  if actor_role = 'SUPER_ADMIN' then return new; end if;

  if new.id is distinct from old.id
     or new.role is distinct from old.role
     or new.tenant_id is distinct from old.tenant_id
     or new.whatsapp_instance is distinct from old.whatsapp_instance
     or new.whatsapp_instance_id is distinct from old.whatsapp_instance_id
     or new.whatsapp_instance_name is distinct from old.whatsapp_instance_name
     or new.whatsapp_token is distinct from old.whatsapp_token then
    raise exception 'authorization-managed profile fields cannot be changed by this role'
      using errcode = '42501';
  end if;

  if actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    if new.monthly_fee is distinct from old.monthly_fee
       or new.monthly_tuition is distinct from old.monthly_tuition
       or new.fidelity_plan is distinct from old.fidelity_plan
       or new.due_day is distinct from old.due_day
       or new.subscription_id is distinct from old.subscription_id
       or new.asaas_customer_id is distinct from old.asaas_customer_id
       or new.asaas_subscription_status is distinct from old.asaas_subscription_status
       or new.asaas_subscription_end_date is distinct from old.asaas_subscription_end_date
       or new.asaas_subscription_synced_at is distinct from old.asaas_subscription_synced_at
       or new.status_financial is distinct from old.status_financial
       or new.enrollment_fee is distinct from old.enrollment_fee
       or new.enrollment_fee_paid is distinct from old.enrollment_fee_paid
       or new.enrollment_payment_id is distinct from old.enrollment_payment_id
       or new.paid_through is distinct from old.paid_through
       or new.prepaid_months is distinct from old.prepaid_months
       or new.hourly_rate is distinct from old.hourly_rate
       or new.commission_rate is distinct from old.commission_rate then
      raise exception 'financial profile fields cannot be changed by this role'
        using errcode = '42501';
    end if;
  end if;

  if actor_role = 'TEACHER' and old.id <> actor_id then
    if new.email is distinct from old.email
       or new.phone is distinct from old.phone
       or new.cpf is distinct from old.cpf
       or new.rg is distinct from old.rg
       or new.birth_date is distinct from old.birth_date
       or new.cnpj is distinct from old.cnpj
       or new.cnpj_company_name is distinct from old.cnpj_company_name
       or new.address is distinct from old.address
       or new.address_number is distinct from old.address_number
       or new.postal_code is distinct from old.postal_code
       or new.bank_name is distinct from old.bank_name
       or new.agency is distinct from old.agency
       or new.account_number is distinct from old.account_number
       or new.pix_key is distinct from old.pix_key
       or new.pix_key_type is distinct from old.pix_key_type
       or new.guardian_name is distinct from old.guardian_name
       or new.guardian_cpf is distinct from old.guardian_cpf
       or new.guardian_email is distinct from old.guardian_email
       or new.guardian_phone is distinct from old.guardian_phone
       or new.guardian_id is distinct from old.guardian_id
       or new.private_notes is distinct from old.private_notes
       or new.signature_ip is distinct from old.signature_ip
       or new.signature_url is distinct from old.signature_url
       or new.contract_url is distinct from old.contract_url
       or new.student_signature_url is distinct from old.student_signature_url
       or new.signed_document_url is distinct from old.signed_document_url
       or new.wise_wolf_signature_token is distinct from old.wise_wolf_signature_token
       or new.typed_signature is distinct from old.typed_signature
       or new.signature_hash is distinct from old.signature_hash
       or new.user_ip is distinct from old.user_ip then
      raise exception 'private profile fields cannot be changed by a teacher'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$function$;

commit;
