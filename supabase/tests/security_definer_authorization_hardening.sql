-- SECURITY DEFINER must deny NULL identities and cross-tenant targets while
-- preserving explicitly reviewed authenticated and bearer-link workflows.

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $function$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$function$;

grant execute on function pg_temp.assert_true(boolean, text)
  to authenticated;

-- -------------------------------------------------------------------------
-- Static boundary: secure facades, owner-only implementations and ACLs.
-- -------------------------------------------------------------------------

do $facade_acl$
declare
  audited record;
  facade_oid regprocedure;
  implementation_oid regprocedure;
begin
  for audited in
    select *
    from (values
      ('public.upsert_niche(text)',
       'public.upsert_niche_unchecked(text)'),
      ('public.update_material(uuid,jsonb)',
       'public.update_material_unchecked(uuid,jsonb)'),
      ('public.upsert_collection(uuid,text,text,text,text)',
       'public.upsert_collection_unchecked(uuid,text,text,text,text)'),
      ('public.delete_collection(uuid)',
       'public.delete_collection_unchecked(uuid)'),
      ('public.set_material_collection(uuid,uuid,integer)',
       'public.set_material_collection_unchecked(uuid,uuid,integer)'),
      ('public.rename_niche(text,text)',
       'public.rename_niche_unchecked(text,text)'),
      ('public.delete_niche(text)',
       'public.delete_niche_unchecked(text)'),
      ('public.list_pending_trial_sessions()',
       'public.list_pending_trial_sessions_unchecked()'),
      ('public.settle_trial_session(uuid,boolean)',
       'public.settle_trial_session_unchecked(uuid,boolean)'),
      ('public.director_pending_counts()',
       'public.director_pending_counts_unchecked()'),
      ('public.set_student_status(uuid,text)',
       'public.set_student_status_unchecked(uuid,text)'),
      ('public.get_cashflow(text)',
       'public.get_cashflow_unchecked(text)'),
      ('public.get_teacher_overview(uuid)',
       'public.get_teacher_overview_unchecked(uuid)'),
      ('public.list_teachers_overview()',
       'public.list_teachers_overview_unchecked()'),
      ('public.create_student_plan_change(uuid,text,numeric,boolean)',
       'public.create_student_plan_change_unchecked(uuid,text,numeric,boolean)')
    ) as reviewed(facade_signature, implementation_signature)
  loop
    facade_oid := to_regprocedure(audited.facade_signature);
    implementation_oid := to_regprocedure(audited.implementation_signature);

    perform pg_temp.assert_true(
      facade_oid is not null
      and (
        select procedure.prosecdef
          and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
          and exists (
            select 1
            from unnest(
              coalesce(procedure.proconfig, array[]::text[])
            ) as configured(setting)
            where split_part(configured.setting, '=', 1) = 'search_path'
              and replace(
                split_part(configured.setting, '=', 2), '"', ''
              ) = ''
          )
        from pg_catalog.pg_proc as procedure
        where procedure.oid = facade_oid
      )
      and pg_catalog.has_function_privilege(
        'authenticated', facade_oid, 'EXECUTE'
      )
      and pg_catalog.has_function_privilege(
        'service_role', facade_oid, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'anon', facade_oid, 'EXECUTE'
      ),
      audited.facade_signature || ' is not a secure authenticated facade'
    );

    perform pg_temp.assert_true(
      implementation_oid is not null
      and not pg_catalog.has_function_privilege(
        'anon', implementation_oid, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated', implementation_oid, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'service_role', implementation_oid, 'EXECUTE'
      )
      and pg_catalog.has_function_privilege(
        'postgres', implementation_oid, 'EXECUTE'
      ),
      audited.implementation_signature || ' is not owner-only'
    );
  end loop;
end
$facade_acl$;

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'anon', 'private.can_execute_legacy_role_rpc(text[])', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'private.can_execute_legacy_role_rpc(text[])',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'private.can_execute_legacy_role_rpc(text[])',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'private.legacy_role_rpc_target_allowed(text)',
    'EXECUTE'
  ),
  'authorization helpers are directly executable by API roles'
);

-- PUBLIC is not a login role, so effective and direct ACL checks answer
-- different questions. This probe captures the exact regression: inherited
-- execution is visible to has_function_privilege(), but must not be preserved
-- as a role-specific grant by the migration's proacl snapshot.
create or replace function public.security_definer_public_acl_test_probe()
returns boolean
language sql
security definer
set search_path = ''
as $function$
  select true;
$function$;

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'anon', 'public.security_definer_public_acl_test_probe()', 'EXECUTE'
  ),
  'a newly created function inherited anonymous EXECUTE'
);

grant execute on function public.security_definer_public_acl_test_probe()
  to public;

select pg_temp.assert_true(
  pg_catalog.has_function_privilege(
    'anon', 'public.security_definer_public_acl_test_probe()', 'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'public.security_definer_public_acl_test_probe()',
    'EXECUTE'
  )
  and not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    cross join lateral pg_catalog.aclexplode(procedure.proacl) as privilege
    join pg_catalog.pg_roles as grantee_role
      on grantee_role.oid = privilege.grantee
    where procedure.oid =
      'public.security_definer_public_acl_test_probe()'::regprocedure
      and grantee_role.rolname in ('anon', 'authenticated')
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC inheritance was confused with a direct API-role grant'
);

revoke execute on function public.security_definer_public_acl_test_probe()
  from public, anon;

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'anon', 'public.security_definer_public_acl_test_probe()', 'EXECUTE'
  ),
  'revoking PUBLIC did not remove inherited anonymous EXECUTE'
);

drop function public.security_definer_public_acl_test_probe();

-- Effective authenticated execution must always come from a role-specific
-- ACL, never from PUBLIC inheritance. This is the regression boundary for the
-- catalog snapshot used by the migration.
select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and procedure.prosecdef
      and pg_catalog.has_function_privilege(
        'authenticated', procedure.oid, 'EXECUTE'
      )
      and not exists (
        select 1
        from pg_catalog.aclexplode(procedure.proacl) as privilege
        join pg_catalog.pg_roles as grantee_role
          on grantee_role.oid = privilege.grantee
        where grantee_role.rolname = 'authenticated'
          and privilege.privilege_type = 'EXECUTE'
      )
  ),
  'authenticated inherited SECURITY DEFINER execution without a direct grant'
);

-- Trigger implementations and these reviewed cron/drain entry points are
-- internal automation surfaces, never authenticated client RPCs. Check every
-- overload when an object exists so signature drift cannot bypass the guard.
select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and procedure.prosecdef
      and (
        procedure.prorettype in (
          'pg_catalog.trigger'::regtype,
          'pg_catalog.event_trigger'::regtype
        )
        or procedure.proname = any (array[
          'trigger_dre_report',
          'trigger_oral_test_scan',
          'trigger_sdr_followups',
          'trigger_hr_backfill_drain',
          'enqueue_nf_reminders'
        ]::name[])
      )
      and pg_catalog.has_function_privilege(
        'authenticated', procedure.oid, 'EXECUTE'
      )
  ),
  'authenticated can execute an internal trigger or automation function'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and procedure.prosecdef
      and procedure.proname = any (array[
        'trigger_dre_report',
        'trigger_oral_test_scan',
        'trigger_sdr_followups',
        'trigger_hr_backfill_drain',
        'enqueue_nf_reminders'
      ]::name[])
      and (
        not pg_catalog.has_function_privilege(
          'supabase_admin', procedure.oid, 'EXECUTE'
        )
        or not pg_catalog.has_function_privilege(
          'service_role', procedure.oid, 'EXECUTE'
        )
      )
  ),
  'internal automation lost its trusted cron/service execution path'
);

-- No privileged function may retain a direct PUBLIC grant, and effective anon
-- access is limited to the exact reviewed signatures.
select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) as privilege
    where namespace.nspname in ('public', 'private')
      and procedure.prosecdef
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'a SECURITY DEFINER function still grants EXECUTE to PUBLIC'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and procedure.prosecdef
      and pg_catalog.has_function_privilege(
        'anon', procedure.oid, 'EXECUTE'
      )
      and not exists (
        select 1
        from unnest(array[
          'public.apply_student_response(text,text)',
          'public.apply_teacher_candidate(text,text,text)',
          'public.get_confirmation_public(text)',
          'public.get_plan_change_public(text)',
          'public.get_referrer_name(uuid)',
          'public.get_transfer_public(text)',
          'public.hub_get_public_settings()',
          'public.rate_attendance(text,integer)',
          'public.resolve_public_tenant(text)',
          'public.respond_teacher_transfer(text,boolean,text)',
          'public.sign_student_plan_change(text,text)'
        ]::text[]) as reviewed(signature)
        where to_regprocedure(reviewed.signature) = procedure.oid
      )
  ),
  'anon can execute a SECURITY DEFINER function outside the exact allowlist'
);

do $required_public_routes$
declare
  signature text;
begin
  foreach signature in array array[
    'public.get_plan_change_public(text)',
    'public.sign_student_plan_change(text,text)',
    'public.get_transfer_public(text)',
    'public.respond_teacher_transfer(text,boolean,text)',
    'public.resolve_public_tenant(text)',
    'public.hub_get_public_settings()'
  ]
  loop
    perform pg_temp.assert_true(
      to_regprocedure(signature) is not null
      and pg_catalog.has_function_privilege(
        'anon', to_regprocedure(signature), 'EXECUTE'
      )
      and pg_catalog.has_function_privilege(
        'authenticated', to_regprocedure(signature), 'EXECUTE'
      ),
      signature || ' lost its reviewed anonymous route'
    );
  end loop;
end
$required_public_routes$;

-- Production has a few reviewed public SECDEF routes that pre-date source
-- control. A clean rebuild may not contain them, but if the name exists it must
-- keep the exact audited signature and effective anonymous EXECUTE.
do $optional_drift_public_routes$
declare
  reviewed record;
  route_oid regprocedure;
begin
  for reviewed in
    select *
    from (values
      ('public.apply_student_response(text,text)', 'apply_student_response'),
      ('public.apply_teacher_candidate(text,text,text)', 'apply_teacher_candidate'),
      ('public.get_confirmation_public(text)', 'get_confirmation_public'),
      ('public.get_referrer_name(uuid)', 'get_referrer_name'),
      ('public.rate_attendance(text,integer)', 'rate_attendance')
    ) as drift_route(signature, function_name)
  loop
    if exists (
      select 1
      from pg_catalog.pg_proc as procedure
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = reviewed.function_name
        and procedure.prosecdef
    ) then
      route_oid := to_regprocedure(reviewed.signature);
      perform pg_temp.assert_true(
        route_oid is not null
        and pg_catalog.has_function_privilege(
          'anon', route_oid, 'EXECUTE'
        ),
        reviewed.signature
          || ' changed signature or lost reviewed anonymous EXECUTE'
      );
    end if;
  end loop;
end
$optional_drift_public_routes$;

do $service_only_routes$
declare
  signature text;
begin
  foreach signature in array array[
    'public.get_offer_public(uuid)',
    'public.get_invite_offer_public(uuid)',
    'public.get_contract_public(uuid)',
    'public.get_tenant_whatsapp_instance(uuid)',
    'public.plan_changes_awaiting_billing()',
    'public.mark_plan_change_billing(uuid,boolean,text)'
  ]
  loop
    if to_regprocedure(signature) is not null then
      perform pg_temp.assert_true(
        not pg_catalog.has_function_privilege(
          'anon', to_regprocedure(signature), 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', to_regprocedure(signature), 'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
          'service_role', to_regprocedure(signature), 'EXECUTE'
        ),
        signature || ' is not still service-role-only'
      );
    end if;
  end loop;
end
$service_only_routes$;

-- Default ACLs must also be deny-by-default. Function defaults are global to
-- each owner (defaclnamespace = 0); they cover public, private and new schemas.
-- A missing row falls back to PostgreSQL's PUBLIC EXECUTE default and fails.
select pg_temp.assert_true(
  (
    select count(*) = 2
      and bool_and(not exists (
        select 1
        from pg_catalog.aclexplode(
          coalesce(
            (
              select defaults.defaclacl
              from pg_catalog.pg_default_acl as defaults
              where defaults.defaclrole = owner_role.oid
                and defaults.defaclnamespace = 0
                and defaults.defaclobjtype = 'f'
            ),
            pg_catalog.acldefault('f', owner_role.oid)
          )
        ) as privilege
        where privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
      ))
    from pg_catalog.pg_roles as owner_role
    where owner_role.rolname in ('postgres', 'supabase_admin')
  ),
  'future functions still inherit PUBLIC EXECUTE'
);

-- -------------------------------------------------------------------------
-- Runtime boundary: NULL profile, active authenticated panel and cross tenant.
-- -------------------------------------------------------------------------

insert into public.tenants (id, name, saas_status)
values
  ('secdef-school-a', 'Security Definer School A', 'active'),
  ('secdef-school-b', 'Security Definer School B', 'active');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-00000000d101',
    'authenticated', 'authenticated', 'secdef-admin-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Security Admin A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000d102',
    'authenticated', 'authenticated', 'secdef-teacher-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Security Teacher B"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000d103',
    'authenticated', 'authenticated', 'secdef-student-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Security Student B"}', now(), now()
  );

set local app.enrollment_claim = '1';

update public.profiles
set tenant_id = 'secdef-school-a',
    role = 'SCHOOL_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Security Admin A'
where id = '00000000-0000-4000-8000-00000000d101';

update public.profiles
set tenant_id = 'secdef-school-b',
    role = 'TEACHER',
    lifecycle_status = 'active',
    full_name = 'Security Teacher B'
where id = '00000000-0000-4000-8000-00000000d102';

update public.profiles
set tenant_id = 'secdef-school-b',
    role = 'STUDENT',
    lifecycle_status = 'active',
    full_name = 'Security Student B'
where id = '00000000-0000-4000-8000-00000000d103';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  (
    '00000000-0000-4000-8000-00000000d101',
    'secdef-school-a', 'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000d102',
    'secdef-school-b', 'TEACHER', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000d103',
    'secdef-school-b', 'STUDENT', 'ACTIVE', true
  )
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  (
    '00000000-0000-4000-8000-00000000d101',
    'secdef-school-a'
  ),
  (
    '00000000-0000-4000-8000-00000000d102',
    'secdef-school-b'
  ),
  (
    '00000000-0000-4000-8000-00000000d103',
    'secdef-school-b'
  )
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

insert into public.pedagogical_collections (
  id, tenant_id, title, niche, level_tag
)
values (
  '00000000-0000-4000-8000-00000000d201',
  'secdef-school-b',
  'Cross Tenant Collection',
  'GENERAL',
  'A1'
);

insert into public.appointments (
  id, tenant_id, teacher_id, professor_id,
  student_name, student_phone, start_time, status, type
)
values (
  '00000000-0000-4000-8000-00000000d202',
  'secdef-school-b',
  '00000000-0000-4000-8000-00000000d102',
  '00000000-0000-4000-8000-00000000d102',
  'Security Trial B',
  '5511999999202',
  now() - interval '1 day',
  'scheduled',
  'experimental'
);

set local role authenticated;

-- Authenticated JWT with no profiles row: the vulnerable implementations used
-- to continue past `IF NULL NOT IN (...)` and reached validation/data lookup.
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000d109","role":"authenticated"}';

select pg_temp.assert_true(
  public.upsert_collection(
    null, 'No Profile Collection', 'GENERAL', 'A1', null
  ) ->> 'error' = 'sem_permissao',
  'authenticated user without profile crossed upsert_collection authorization'
);

select pg_temp.assert_true(
  public.settle_trial_session(
    '00000000-0000-4000-8000-00000000d202', true
  ) ->> 'error' = 'sem_permissao',
  'authenticated user without profile crossed settlement authorization'
);

select pg_temp.assert_true(
  public.director_pending_counts() = '{}'::jsonb,
  'authenticated user without profile crossed director authorization'
);

select pg_temp.assert_true(
  public.create_student_plan_change(
    '00000000-0000-4000-8000-00000000d103',
    '8x', 499.00, true
  ) ->> 'error' = 'Sem permissão',
  'NULL helper values crossed the plan-change NOT(...) authorization'
);

-- Verify mutations as the database owner. RLS deliberately hides the rows
-- from the no-profile caller, which would otherwise make a negative check pass
-- without proving that the SECURITY DEFINER body stayed side-effect free.
reset role;

select pg_temp.assert_true(
  not exists (
    select 1
    from public.pedagogical_collections
    where title = 'No Profile Collection'
  ),
  'no-profile probe changed collection data'
);

-- A real tenant admin still executes an actual dashboard RPC. This proves the
-- PUBLIC revoke did not silently remove authenticated app access.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000d101","role":"authenticated"}';

select pg_temp.assert_true(
  public.get_cashflow('2026-08') ->> 'month' = '2026-08'
  and public.get_cashflow('2026-08') ->> 'error' is null,
  'authenticated school dashboard lost get_cashflow execution'
);

select pg_temp.assert_true(
  public.director_pending_counts()
    ?& array['acolhimento', 'reposicoes']::text[],
  'authenticated school dashboard lost director pending counts execution'
);

-- IDs from another tenant cannot be used to update/read/settle privileged data.
select pg_temp.assert_true(
  public.upsert_collection(
    '00000000-0000-4000-8000-00000000d201',
    'Cross Tenant Mutated', 'GENERAL', 'B2', null
  ) ->> 'error' = 'sem_permissao',
  'school admin updated another tenant collection by UUID'
);

reset role;

select pg_temp.assert_true(
  (
    select title = 'Cross Tenant Collection'
    from public.pedagogical_collections
    where id = '00000000-0000-4000-8000-00000000d201'
  ),
  'cross-tenant collection changed despite denied response'
);

set local role authenticated;

select pg_temp.assert_true(
  public.settle_trial_session(
    '00000000-0000-4000-8000-00000000d202', true
  ) ->> 'error' = 'sem_permissao',
  'school admin received an allowed response for another tenant trial session'
);

reset role;

select pg_temp.assert_true(
  (
    select status = 'scheduled'
    from public.appointments
    where id = '00000000-0000-4000-8000-00000000d202'
  )
  and not exists (
    select 1
    from public.class_logs
    where appointment_id = '00000000-0000-4000-8000-00000000d202'
  ),
  'school admin settled another tenant trial session'
);

set local role authenticated;

select pg_temp.assert_true(
  public.get_teacher_overview(
    '00000000-0000-4000-8000-00000000d102'
  ) ->> 'error' = 'sem_permissao',
  'school admin read another tenant teacher overview'
);

select pg_temp.assert_true(
  public.create_student_plan_change(
    '00000000-0000-4000-8000-00000000d103',
    '8x', 499.00, true
  ) ->> 'error' = 'Sem permissão',
  'school admin received an allowed response for another tenant plan change'
);

reset role;

select pg_temp.assert_true(
  not exists (
    select 1
    from public.student_plan_changes
    where student_id = '00000000-0000-4000-8000-00000000d103'
  ),
  'school admin created another tenant plan change'
);

rollback;
