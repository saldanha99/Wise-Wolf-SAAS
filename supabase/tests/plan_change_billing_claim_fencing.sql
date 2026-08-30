-- Plan-change billing queue: exclusive claims, lease recovery and fencing.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

grant execute on all functions in schema pg_temp
  to anon, authenticated, service_role;

select pg_temp.assert_true(
  pg_catalog.to_regprocedure(
    'public.plan_changes_awaiting_billing()'
  ) is null
  and pg_catalog.to_regprocedure(
    'public.mark_plan_change_billing(uuid,boolean,text)'
  ) is null,
  'unfenced plan-change queue RPCs are still installed'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.claim_plan_changes_awaiting_billing(text,integer,integer)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.finish_plan_change_billing_claim(uuid,uuid,boolean,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.claim_plan_changes_awaiting_billing(text,integer,integer)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.finish_plan_change_billing_claim(uuid,uuid,boolean,text)',
    'EXECUTE'
  ),
  'claim and finish RPCs are not service-role-only'
);

insert into public.tenants (id, name, slug, saas_status)
values
  (
    'plan-claim-school-a',
    'Plan Claim School A',
    'plan-claim-school-a',
    'active'
  ),
  (
    'plan-claim-school-b',
    'Plan Claim School B',
    'plan-claim-school-b',
    'active'
  );

insert into auth.users (
  id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-4000-8000-00000000e201',
    'authenticated',
    'authenticated',
    'plan-claim-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Plan Claim Student A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '00000000-0000-4000-8000-00000000e202',
    'authenticated',
    'authenticated',
    'plan-claim-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Plan Claim Student B"}',
    pg_catalog.now(),
    pg_catalog.now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'plan-claim-school-a',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Plan Claim Student A'
 where id = '00000000-0000-4000-8000-00000000e201';
update public.profiles
   set tenant_id = 'plan-claim-school-b',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Plan Claim Student B'
 where id = '00000000-0000-4000-8000-00000000e202';
set local app.enrollment_claim = '';

insert into public.student_plan_changes (
  id,
  tenant_id,
  student_id,
  from_frequency,
  to_frequency,
  from_monthly_fee,
  to_monthly_fee,
  status,
  signed_at,
  asaas_subscription_id,
  billing_sync_status
)
values
  (
    '10000000-0000-4000-8000-00000000e201',
    'plan-claim-school-a',
    '00000000-0000-4000-8000-00000000e201',
    '2x',
    '3x',
    200,
    300,
    'SIGNED',
    pg_catalog.now() - interval '2 minutes',
    'sub_plan_claim_a',
    'PENDING'
  ),
  (
    '10000000-0000-4000-8000-00000000e202',
    'plan-claim-school-b',
    '00000000-0000-4000-8000-00000000e202',
    '2x',
    '3x',
    210,
    310,
    'SIGNED',
    pg_catalog.now() - interval '1 minute',
    'sub_plan_claim_b',
    'PENDING'
  );

create temporary table claimed_plan_changes (
  label text not null,
  id uuid not null,
  tenant_id text not null,
  billing_attempts integer not null,
  billing_claim_token uuid not null,
  billing_lease_expires_at timestamptz not null
);
grant select, insert on table pg_temp.claimed_plan_changes to service_role;

create temporary table finished_plan_changes (
  label text primary key,
  result jsonb not null
);
grant select, insert on table pg_temp.finished_plan_changes to service_role;

set local role service_role;

insert into pg_temp.claimed_plan_changes (
  label,
  id,
  tenant_id,
  billing_attempts,
  billing_claim_token,
  billing_lease_expires_at
)
select
  'first',
  claim.id,
  claim.tenant_id,
  claim.billing_attempts,
  claim.billing_claim_token,
  claim.billing_lease_expires_at
from public.claim_plan_changes_awaiting_billing(
  'plan-claim-school-a',
  10,
  300
) as claim;

insert into pg_temp.claimed_plan_changes (
  label,
  id,
  tenant_id,
  billing_attempts,
  billing_claim_token,
  billing_lease_expires_at
)
select
  'concurrent',
  claim.id,
  claim.tenant_id,
  claim.billing_attempts,
  claim.billing_claim_token,
  claim.billing_lease_expires_at
from public.claim_plan_changes_awaiting_billing(
  'plan-claim-school-a',
  10,
  300
) as claim;

reset role;

select pg_temp.assert_true(
  (select pg_catalog.count(*) = 1
     from pg_temp.claimed_plan_changes
    where label = 'first')
  and not exists (
    select 1
      from pg_temp.claimed_plan_changes
     where label = 'concurrent'
  ),
  'a live claim was delivered to a concurrent worker'
);

select pg_temp.assert_true(
  (select tenant_id = 'plan-claim-school-a'
     from pg_temp.claimed_plan_changes
    where label = 'first')
  and (
    select billing_claim_token is null
      from public.student_plan_changes
     where id = '10000000-0000-4000-8000-00000000e202'
  ),
  'tenant-scoped claim reserved another tenant'
);

update public.student_plan_changes
   set billing_lease_expires_at = pg_catalog.now() - interval '1 second'
 where id = '10000000-0000-4000-8000-00000000e201';

set local role service_role;

insert into pg_temp.claimed_plan_changes (
  label,
  id,
  tenant_id,
  billing_attempts,
  billing_claim_token,
  billing_lease_expires_at
)
select
  'reclaimed',
  claim.id,
  claim.tenant_id,
  claim.billing_attempts,
  claim.billing_claim_token,
  claim.billing_lease_expires_at
from public.claim_plan_changes_awaiting_billing(
  'plan-claim-school-a',
  10,
  300
) as claim;

insert into pg_temp.finished_plan_changes values (
  'stale-before-success',
  public.finish_plan_change_billing_claim(
    '10000000-0000-4000-8000-00000000e201',
    (
      select billing_claim_token
        from pg_temp.claimed_plan_changes
       where label = 'first'
    ),
    false,
    'stale worker failure'
  )
);

reset role;

select pg_temp.assert_true(
  (
    select first_claim.billing_claim_token
           is distinct from reclaimed.billing_claim_token
      from pg_temp.claimed_plan_changes as first_claim
      join pg_temp.claimed_plan_changes as reclaimed on true
     where first_claim.label = 'first'
       and reclaimed.label = 'reclaimed'
  )
  and (
    select result->>'reason' = 'claim_lost'
      from pg_temp.finished_plan_changes
     where label = 'stale-before-success'
  )
  and (
    select billing_sync_status = 'PENDING'
           and billing_claim_token = (
             select billing_claim_token
               from pg_temp.claimed_plan_changes
              where label = 'reclaimed'
           )
      from public.student_plan_changes
     where id = '10000000-0000-4000-8000-00000000e201'
  ),
  'expired claim was not fenced after lease recovery'
);

set local role service_role;

insert into pg_temp.finished_plan_changes values (
  'current-success',
  public.finish_plan_change_billing_claim(
    '10000000-0000-4000-8000-00000000e201',
    (
      select billing_claim_token
        from pg_temp.claimed_plan_changes
       where label = 'reclaimed'
    ),
    true,
    null
  )
);

insert into pg_temp.finished_plan_changes values (
  'late-failure',
  public.finish_plan_change_billing_claim(
    '10000000-0000-4000-8000-00000000e201',
    (
      select billing_claim_token
        from pg_temp.claimed_plan_changes
       where label = 'first'
    ),
    false,
    'failure that arrived after success'
  )
);

reset role;

select pg_temp.assert_true(
  (
    select result->>'status' = 'SYNCED'
           and (result->>'applied')::boolean
      from pg_temp.finished_plan_changes
     where label = 'current-success'
  )
  and (
    select result->>'status' = 'SYNCED'
           and (result->>'ignored_regression')::boolean
      from pg_temp.finished_plan_changes
     where label = 'late-failure'
  )
  and (
    select billing_sync_status = 'SYNCED'
           and billing_sync_error is null
           and billing_synced_at is not null
           and billing_claim_token is null
           and billing_lease_expires_at is null
      from public.student_plan_changes
     where id = '10000000-0000-4000-8000-00000000e201'
  ),
  'late failure regressed a synchronized plan change'
);

insert into public.student_plan_changes (
  id,
  tenant_id,
  student_id,
  from_frequency,
  to_frequency,
  from_monthly_fee,
  to_monthly_fee,
  status,
  signed_at,
  asaas_subscription_id,
  billing_sync_status,
  billing_attempts
)
values (
  '10000000-0000-4000-8000-00000000e203',
  'plan-claim-school-a',
  '00000000-0000-4000-8000-00000000e201',
  '3x',
  '4x',
  300,
  400,
  'SIGNED',
  pg_catalog.now(),
  'sub_plan_claim_failure',
  'PENDING',
  5
);

set local role service_role;

insert into pg_temp.claimed_plan_changes (
  label,
  id,
  tenant_id,
  billing_attempts,
  billing_claim_token,
  billing_lease_expires_at
)
select
  'sixth-attempt',
  claim.id,
  claim.tenant_id,
  claim.billing_attempts,
  claim.billing_claim_token,
  claim.billing_lease_expires_at
from public.claim_plan_changes_awaiting_billing(
  'plan-claim-school-a',
  10,
  300
) as claim;

insert into pg_temp.finished_plan_changes values (
  'sixth-failure',
  public.finish_plan_change_billing_claim(
    '10000000-0000-4000-8000-00000000e203',
    (
      select billing_claim_token
        from pg_temp.claimed_plan_changes
       where label = 'sixth-attempt'
    ),
    false,
    'sixth explicit failure'
  )
);

reset role;

select pg_temp.assert_true(
  (
    select billing_attempts = 6
           and billing_sync_status = 'FAILED'
           and billing_sync_error = 'sixth explicit failure'
           and billing_claim_token is null
      from public.student_plan_changes
     where id = '10000000-0000-4000-8000-00000000e203'
  ),
  'sixth explicit failure did not terminate visibly'
);

rollback;
