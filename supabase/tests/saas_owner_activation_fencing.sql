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

create or replace function pg_temp.activation_payload(
  recipient text,
  token_suffix text
)
returns text
language sql
immutable
as $$
  select pg_catalog.jsonb_build_object(
    'from', 'Wise Wolf <test@example.invalid>',
    'to', pg_catalog.jsonb_build_array(recipient),
    'subject', 'Ative seu acesso à Wise Wolf',
    'html', '<a href="https://auth.example.invalid/verify?token=' ||
      token_suffix || '">Ativar</a>'
  )::text;
$$;

select pg_temp.assert_true(
  not has_table_privilege(
    'authenticated', 'public.saas_owner_activation_attempts', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'public.saas_owner_activation_attempts', 'SELECT'
  )
  and not has_function_privilege(
    'authenticated',
    'public.stage_saas_owner_activation_payload(uuid,uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.repair_saas_owner_access(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.ensure_saas_owner_access_locked(uuid,text,text,uuid,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'private.ensure_saas_owner_access_locked(uuid,text,text,uuid,boolean)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finish_saas_owner_activation(uuid,uuid,text,text,text)',
    'EXECUTE'
  ),
  'activation table, public RPC or private helper privileges are unsafe'
);

insert into public.saas_plans (
  id, name, description, price, price_yearly, max_students, max_users,
  max_teachers, max_storage_gb, active, features, plan_type
) values (
  '00000000-0000-4000-8000-00000000f401',
  'Activation Fence Test',
  'Fixture isolada da ativacao SaaS',
  1, 12, 2, 2, 2, 1, true, '[]'::jsonb, 'school'
);

insert into public.tenants (
  id, name, slug, saas_status, plan_id, tenant_type
) values
  (
    'saas-activation-fence',
    'SaaS Activation Fence',
    'saas-activation-fence',
    'active',
    '00000000-0000-4000-8000-00000000f401',
    'school'
  ),
  (
    'saas-activation-secondary',
    'SaaS Activation Secondary',
    'saas-activation-secondary',
    'active',
    '00000000-0000-4000-8000-00000000f401',
    'school'
  );

insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, asaas_customer_id,
  asaas_subscription_id, asaas_payment_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f402',
  '00000000-0000-4000-8000-00000000f403',
  'PROVISIONING',
  'SaaS Activation Fence',
  'saas-activation-fence-checkout',
  'Activation Owner',
  'activation-owner@example.invalid',
  '5511999999999',
  '00000000000',
  '00000000-0000-4000-8000-00000000f401',
  'MONTHLY', 'PIX', 1,
  'saas-activation-fence',
  'cus_activation_fence',
  'sub_activation_fence',
  'pay_activation_fence',
  pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);

select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f402',
    'saas-activation-fence',
    'activation-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f404',
    300
  ) ->> 'action' = 'SUBMIT_ONCE',
  'first activation claim was not accepted'
);

select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f402',
    'saas-activation-fence',
    'activation-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f405',
    300
  ) ->> 'action' = 'IN_PROGRESS',
  'active claim lease was bypassed'
);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f406',
  'authenticated',
  'authenticated',
  'activation-owner@example.invalid',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"],"saas_owner_activation_checkout_id":"00000000-0000-4000-8000-00000000f402"}',
  '{"full_name":"Activation Owner"}',
  pg_catalog.now(),
  pg_catalog.now()
);

-- Staging depends on the auth identity, not on a trigger-created profile. The
-- profile and membership are installed only inside the final SQL boundary.
delete from public.profiles
 where id = '00000000-0000-4000-8000-00000000f406';

select pg_temp.assert_true(
  public.stage_saas_owner_activation_payload(
    '00000000-0000-4000-8000-00000000f402',
    '00000000-0000-4000-8000-00000000f404',
    '00000000-0000-4000-8000-00000000f406',
    pg_temp.activation_payload(
      'activation-owner@example.invalid',
      'first'
    )
  ) ->> 'action' = 'STAGED',
  'exact activation payload was not staged'
);

select pg_temp.assert_true(
  (select provider_payload = pg_temp.activation_payload(
            'activation-owner@example.invalid', 'first'
          )
          and provider_payload_sha256 ~ '^[a-f0-9]{64}$'
          and provider_payload_staged_at is not null
          and submit_attempt_count = 0
     from public.saas_owner_activation_attempts
    where checkout_id = '00000000-0000-4000-8000-00000000f402')
  and not exists (
    select 1 from public.profiles
     where id = '00000000-0000-4000-8000-00000000f406'
  )
  and not exists (
    select 1 from public.tenant_memberships
     where user_id = '00000000-0000-4000-8000-00000000f406'
       and tenant_id = 'saas-activation-fence'
  ),
  'stage changed ACL or failed to preserve its exact unsent payload'
);

select pg_temp.assert_true(
  public.mark_saas_owner_activation_submitting(
    '00000000-0000-4000-8000-00000000f402',
    '00000000-0000-4000-8000-00000000f404',
    '00000000-0000-4000-8000-00000000f406'
  ) ->> 'status' = 'SUBMITTING',
  'staged activation did not cross the submit boundary'
);

select pg_temp.assert_true(
  (select status = 'PROVISIONED' and provisioned_at is not null
     from public.saas_checkout_intents
    where id = '00000000-0000-4000-8000-00000000f402')
  and (select tenant_id = 'saas-activation-fence'
              and role = 'SCHOOL_ADMIN'
              and status_financial = 'ACTIVE'
         from public.profiles
        where id = '00000000-0000-4000-8000-00000000f406')
  and exists (
    select 1 from public.tenant_memberships
     where user_id = '00000000-0000-4000-8000-00000000f406'
       and tenant_id = 'saas-activation-fence'
       and role = 'SCHOOL_ADMIN'
       and status = 'ACTIVE'
       and is_primary
  ),
  'checkout completion and owner ACL were not committed atomically'
);

select pg_temp.assert_true(
  (public.finish_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f402',
    '00000000-0000-4000-8000-00000000f404',
    'UNKNOWN',
    null,
    'network_outcome_unknown'
  ) ->> 'ok')::boolean,
  'ambiguous provider outcome was not persisted'
);

select pg_temp.assert_true(
  (select status = 'UNKNOWN'
          and provider_payload = pg_temp.activation_payload(
            'activation-owner@example.invalid', 'first'
          )
          and provider_payload_sha256 is not null
          and provider_payload_staged_at is not null
     from public.saas_owner_activation_attempts
    where checkout_id = '00000000-0000-4000-8000-00000000f402'),
  'UNKNOWN outcome discarded the only safely retryable payload'
);

select pg_temp.assert_true(
  (public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f402',
    'saas-activation-fence',
    'activation-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f407',
    300
  ) ->> 'provider_payload') = pg_temp.activation_payload(
    'activation-owner@example.invalid', 'first'
  ),
  'idempotent recovery did not return the exact staged payload'
);

select pg_temp.assert_true(
  public.mark_saas_owner_activation_submitting(
    '00000000-0000-4000-8000-00000000f402',
    '00000000-0000-4000-8000-00000000f407',
    '00000000-0000-4000-8000-00000000f406'
  ) ->> 'action' = 'RESUME_IDEMPOTENT',
  'owned retry did not preserve its fenced provider boundary'
);

select pg_temp.assert_true(
  (public.finish_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f402',
    '00000000-0000-4000-8000-00000000f407',
    'SENT',
    'resend-message-f401',
    null
  ) ->> 'ok')::boolean,
  'idempotent retry was not finalized'
);

select pg_temp.assert_true(
  (select status = 'SENT'
          and submit_attempt_count = 2
          and provider_payload is null
          and provider_payload_sha256 is null
          and provider_payload_staged_at is null
     from public.saas_owner_activation_attempts
    where checkout_id = '00000000-0000-4000-8000-00000000f402'),
  'terminal delivery retained a bearer payload or lost its bounded count'
);

delete from public.profiles
 where id = '00000000-0000-4000-8000-00000000f406';
select pg_temp.assert_true(
  public.repair_saas_owner_access(
    '00000000-0000-4000-8000-00000000f402',
    '00000000-0000-4000-8000-00000000f406'
  ) ->> 'action' = 'REPAIRED',
  'terminal replay could not repair owner ACL'
);
select pg_temp.assert_true(
  exists (
    select 1 from public.tenant_memberships
     where user_id = '00000000-0000-4000-8000-00000000f406'
       and tenant_id = 'saas-activation-fence'
       and role = 'SCHOOL_ADMIN'
       and status = 'ACTIVE'
  ),
  'terminal repair did not reinstall the owner membership'
);

delete from public.profiles
 where id = '00000000-0000-4000-8000-00000000f406';
select pg_temp.assert_true(
  public.repair_saas_owner_access(
    '00000000-0000-4000-8000-00000000f402',
    null
  ) ->> 'action' = 'REPAIRED',
  'bound terminal identity was mistaken for a missing identity'
);
select pg_temp.assert_true(
  exists (
    select 1 from public.profiles
     where id = '00000000-0000-4000-8000-00000000f406'
       and tenant_id = 'saas-activation-fence'
       and role = 'SCHOOL_ADMIN'
  ),
  'null terminal preflight did not prove and repair the bound identity'
);
select pg_temp.assert_true(
  public.repair_saas_owner_access(
    '00000000-0000-4000-8000-00000000f402',
    '00000000-0000-4000-8000-00000000f409'
  ) ->> 'reason' = 'owner_identity_conflict_for_access_repair',
  'a different identity was reported as safe replacement material'
);

-- A second checkout for the same operational identity gains tenant access but
-- must not issue another automatic recovery token.
insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f410',
  '00000000-0000-4000-8000-00000000f411',
  'PROVISIONING',
  'SaaS Activation Secondary',
  'saas-activation-secondary-checkout',
  'Activation Owner',
  'activation-owner@example.invalid',
  '5511999999999',
  '00000000000',
  '00000000-0000-4000-8000-00000000f401',
  'MONTHLY', 'PIX', 1,
  'saas-activation-secondary',
  pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f410',
    'saas-activation-secondary',
    'activation-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f412',
    300
  ) ->> 'action' = 'SUBMIT_ONCE',
  'second checkout could not establish a no-submit claim'
);
select pg_temp.assert_true(
  public.suppress_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f410',
    '00000000-0000-4000-8000-00000000f412',
    '00000000-0000-4000-8000-00000000f406',
    'owner_activation_not_required'
  ) ->> 'action' = 'SUPPRESSED',
  'same identity was not deduplicated atomically'
);
select pg_temp.assert_true(
  (select status = 'PROVISIONED'
     from public.saas_checkout_intents
    where id = '00000000-0000-4000-8000-00000000f410')
  and exists (
    select 1 from public.tenant_memberships
     where user_id = '00000000-0000-4000-8000-00000000f406'
       and tenant_id = 'saas-activation-secondary'
       and role = 'SCHOOL_ADMIN'
       and status = 'ACTIVE'
       and not is_primary
  ),
  'dedupe did not finalize checkout and secondary membership together'
);

-- A payload-less generation lease is at-most-once. A delayed first worker may
-- still have crossed GoTrue's recovery-token boundary, so a second worker is
-- never allowed to generate a competing link after the lease expires.
insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f440',
  '00000000-0000-4000-8000-00000000f441',
  'PROVISIONING', 'Generation Fence', 'generation-fence', 'Generation Owner',
  'generation-owner@example.invalid', '5511999999999', '00000000000',
  '00000000-0000-4000-8000-00000000f401', 'MONTHLY', 'PIX', 1,
  'saas-activation-fence', pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
select public.claim_saas_owner_activation(
  '00000000-0000-4000-8000-00000000f440',
  'saas-activation-fence',
  'generation-owner@example.invalid',
  '00000000-0000-4000-8000-00000000f442',
  300
);
update public.saas_owner_activation_attempts
   set lease_expires_at = pg_catalog.now() - interval '1 second'
 where checkout_id = '00000000-0000-4000-8000-00000000f440';
select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f440',
    'saas-activation-fence',
    'generation-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f443',
    300
  ) ->> 'status' = 'FAILED',
  'expired generation claim was handed to a competing token generator'
);
select pg_temp.assert_true(
  (select status = 'FAILED'
              and claim_token = '00000000-0000-4000-8000-00000000f442'
              and submit_attempt_count = 0
              and provider_payload is null
         from public.saas_owner_activation_attempts
        where checkout_id = '00000000-0000-4000-8000-00000000f440'),
  'expired generation audit lost the original claim identity'
);
insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f444',
  'authenticated', 'authenticated', 'generation-owner@example.invalid',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"],"saas_owner_activation_checkout_id":"00000000-0000-4000-8000-00000000f440"}',
  '{"full_name":"Generation Owner"}', pg_catalog.now(), pg_catalog.now()
);
select pg_temp.assert_true(
  public.repair_saas_owner_access(
    '00000000-0000-4000-8000-00000000f440',
    '00000000-0000-4000-8000-00000000f444'
  ) ->> 'action' = 'REPAIRED',
  'failed generation could not install access without sending a second link'
);
select pg_temp.assert_true(
  (select status = 'PROVISIONED' and provisioned_at is not null
     from public.saas_checkout_intents
    where id = '00000000-0000-4000-8000-00000000f440')
  and exists (
    select 1 from public.tenant_memberships
     where user_id = '00000000-0000-4000-8000-00000000f444'
       and tenant_id = 'saas-activation-fence'
       and role = 'SCHOOL_ADMIN'
       and status = 'ACTIVE'
  ),
  'manual-recovery fallback left the paid owner without tenant access'
);

-- A staged-but-unsent recovery token expires safely and is regenerated; no
-- provider attempt exists yet, so clearing it cannot duplicate a message.
insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f420',
  '00000000-0000-4000-8000-00000000f421',
  'PROVISIONING', 'Expiry Fence', 'expiry-fence', 'Expiry Owner',
  'expiry-owner@example.invalid', '5511999999999', '00000000000',
  '00000000-0000-4000-8000-00000000f401', 'MONTHLY', 'PIX', 1,
  'saas-activation-fence', pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f422',
  'authenticated', 'authenticated', 'expiry-owner@example.invalid',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"],"saas_owner_activation_checkout_id":"00000000-0000-4000-8000-00000000f420"}',
  '{"full_name":"Expiry Owner"}', pg_catalog.now(), pg_catalog.now()
);
select public.claim_saas_owner_activation(
  '00000000-0000-4000-8000-00000000f420',
  'saas-activation-fence',
  'expiry-owner@example.invalid',
  '00000000-0000-4000-8000-00000000f423',
  300
);
select public.stage_saas_owner_activation_payload(
  '00000000-0000-4000-8000-00000000f420',
  '00000000-0000-4000-8000-00000000f423',
  '00000000-0000-4000-8000-00000000f422',
  pg_temp.activation_payload('expiry-owner@example.invalid', 'expired')
);
update public.saas_owner_activation_attempts
   set provider_payload_staged_at = pg_catalog.now() - interval '51 minutes',
       lease_expires_at = pg_catalog.now() - interval '1 second'
 where checkout_id = '00000000-0000-4000-8000-00000000f420';
select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f420',
    'saas-activation-fence',
    'expiry-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f424',
    300
  ) ->> 'action' = 'SUBMIT_ONCE',
  'expired unsent recovery token remained retryable'
);
select pg_temp.assert_true(
  (select provider_payload is null
              and provider_payload_sha256 is null
              and provider_payload_staged_at is null
         from public.saas_owner_activation_attempts
        where checkout_id = '00000000-0000-4000-8000-00000000f420'),
  'expired unsent recovery token was not cleared before regeneration'
);

-- Cancellation wins before stage/submit and never installs owner ACL.
insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f430',
  '00000000-0000-4000-8000-00000000f431',
  'PROVISIONING', 'Cancel Fence', 'cancel-fence', 'Cancel Owner',
  'cancel-owner@example.invalid', '5511999999999', '00000000000',
  '00000000-0000-4000-8000-00000000f401', 'MONTHLY', 'PIX', 1,
  'saas-activation-fence', pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
select public.claim_saas_owner_activation(
  '00000000-0000-4000-8000-00000000f430',
  'saas-activation-fence',
  'cancel-owner@example.invalid',
  '00000000-0000-4000-8000-00000000f432',
  300
);
update public.saas_checkout_intents
   set status = 'CANCELLED', updated_at = pg_catalog.now()
 where id = '00000000-0000-4000-8000-00000000f430';
select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f430',
    'saas-activation-fence',
    'cancel-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f433',
    300
  ) ->> 'status' = 'SUPPRESSED',
  'cancelled checkout crossed the activation/access boundary'
);
select pg_temp.assert_true(
  (select status = 'CANCELLED' and provisioned_at is null
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f430'),
  'cancelled checkout was reactivated after suppression'
);

-- Cancellation may also win before the first activation claim; even then the
-- suppression decision must have a durable audit row.
insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f450',
  '00000000-0000-4000-8000-00000000f451',
  'CANCELLED', 'Early Cancel Fence', 'early-cancel-fence', 'Early Cancel Owner',
  'early-cancel@example.invalid', '5511999999999', '00000000000',
  '00000000-0000-4000-8000-00000000f401', 'MONTHLY', 'PIX', 1,
  'saas-activation-fence', pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f450',
    'saas-activation-fence',
    'early-cancel@example.invalid',
    '00000000-0000-4000-8000-00000000f452',
    300
  ) ->> 'status' = 'SUPPRESSED',
  'cancel-before-first-claim was not suppressed'
);
select pg_temp.assert_true(
  (select status = 'SUPPRESSED'
              and submit_attempt_count = 0
              and provider_payload is null
         from public.saas_owner_activation_attempts
        where checkout_id = '00000000-0000-4000-8000-00000000f450'),
  'cancel-before-first-claim did not persist its suppression audit'
);

-- Cancellation cannot erase a provider call that is already in flight. The
-- original owner may still finish UNKNOWN, while a later legitimate checkout
-- for the same email is no longer blocked by the canceled checkout.
insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f460',
  '00000000-0000-4000-8000-00000000f461',
  'PROVISIONING', 'Inflight Cancel Fence', 'inflight-cancel-fence',
  'Inflight Owner', 'inflight-owner@example.invalid', '5511999999999',
  '00000000000', '00000000-0000-4000-8000-00000000f401',
  'MONTHLY', 'PIX', 1, 'saas-activation-fence', pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f462',
  'authenticated', 'authenticated', 'inflight-owner@example.invalid',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"],"saas_owner_activation_checkout_id":"00000000-0000-4000-8000-00000000f460"}',
  '{"full_name":"Inflight Owner"}', pg_catalog.now(), pg_catalog.now()
);
select public.claim_saas_owner_activation(
  '00000000-0000-4000-8000-00000000f460',
  'saas-activation-fence', 'inflight-owner@example.invalid',
  '00000000-0000-4000-8000-00000000f463', 300
);
select public.stage_saas_owner_activation_payload(
  '00000000-0000-4000-8000-00000000f460',
  '00000000-0000-4000-8000-00000000f463',
  '00000000-0000-4000-8000-00000000f462',
  pg_temp.activation_payload('inflight-owner@example.invalid', 'inflight')
);
select public.mark_saas_owner_activation_submitting(
  '00000000-0000-4000-8000-00000000f460',
  '00000000-0000-4000-8000-00000000f463',
  '00000000-0000-4000-8000-00000000f462'
);
update public.saas_checkout_intents
   set status = 'CANCELLED', updated_at = pg_catalog.now()
 where id = '00000000-0000-4000-8000-00000000f460';
select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f460',
    'saas-activation-fence', 'inflight-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f464', 300
  ) ->> 'status' = 'SUBMITTING',
  'cancellation erased an in-flight submit audit'
);
select pg_temp.assert_true(
  (public.finish_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f460',
    '00000000-0000-4000-8000-00000000f463',
    'UNKNOWN', null, 'cancel_raced_provider_response'
  ) ->> 'ok')::boolean,
  'original in-flight owner could not persist its provider outcome'
);
select pg_temp.assert_true(
  (select status = 'UNKNOWN' and provider_payload is not null
     from public.saas_owner_activation_attempts
    where checkout_id = '00000000-0000-4000-8000-00000000f460')
  and (select status = 'CANCELLED'
         from public.saas_checkout_intents
        where id = '00000000-0000-4000-8000-00000000f460'),
  'cancellation lost ambiguous evidence or was overwritten'
);

insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f465',
  '00000000-0000-4000-8000-00000000f466',
  'PROVISIONING', 'Inflight Recovery Fence', 'inflight-recovery-fence',
  'Inflight Owner', 'inflight-owner@example.invalid', '5511999999999',
  '00000000000', '00000000-0000-4000-8000-00000000f401',
  'MONTHLY', 'PIX', 1, 'saas-activation-secondary', pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f465',
    'saas-activation-secondary', 'inflight-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f467', 300
  ) ->> 'action' = 'SUBMIT_ONCE',
  'canceled ambiguous checkout blocked a later legitimate checkout'
);
select pg_temp.assert_true(
  public.suppress_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f465',
    '00000000-0000-4000-8000-00000000f467',
    '00000000-0000-4000-8000-00000000f462',
    'owner_activation_not_required'
  ) ->> 'action' = 'SUPPRESSED',
  'later checkout could not reuse the operational owner safely'
);

-- If cancellation wins after an UNKNOWN retry claim but before mark, the old
-- payload remains UNKNOWN and no second provider call may begin.
insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f470',
  '00000000-0000-4000-8000-00000000f471',
  'PROVISIONING', 'Retry Cancel Fence', 'retry-cancel-fence',
  'Retry Owner', 'retry-owner@example.invalid', '5511999999999',
  '00000000000', '00000000-0000-4000-8000-00000000f401',
  'MONTHLY', 'PIX', 1, 'saas-activation-fence', pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f472',
  'authenticated', 'authenticated', 'retry-owner@example.invalid',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"],"saas_owner_activation_checkout_id":"00000000-0000-4000-8000-00000000f470"}',
  '{"full_name":"Retry Owner"}', pg_catalog.now(), pg_catalog.now()
);
select public.claim_saas_owner_activation(
  '00000000-0000-4000-8000-00000000f470',
  'saas-activation-fence', 'retry-owner@example.invalid',
  '00000000-0000-4000-8000-00000000f473', 300
);
select public.stage_saas_owner_activation_payload(
  '00000000-0000-4000-8000-00000000f470',
  '00000000-0000-4000-8000-00000000f473',
  '00000000-0000-4000-8000-00000000f472',
  pg_temp.activation_payload('retry-owner@example.invalid', 'retry')
);
select public.mark_saas_owner_activation_submitting(
  '00000000-0000-4000-8000-00000000f470',
  '00000000-0000-4000-8000-00000000f473',
  '00000000-0000-4000-8000-00000000f472'
);
select public.finish_saas_owner_activation(
  '00000000-0000-4000-8000-00000000f470',
  '00000000-0000-4000-8000-00000000f473',
  'UNKNOWN', null, 'first_attempt_ambiguous'
);
select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f470',
    'saas-activation-fence', 'retry-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f474', 300
  ) ->> 'action' = 'RESUME_IDEMPOTENT',
  'ambiguous delivery could not establish its exact retry claim'
);
update public.saas_checkout_intents
   set status = 'CANCELLED', updated_at = pg_catalog.now()
 where id = '00000000-0000-4000-8000-00000000f470';
select pg_temp.assert_true(
  public.mark_saas_owner_activation_submitting(
    '00000000-0000-4000-8000-00000000f470',
    '00000000-0000-4000-8000-00000000f474',
    '00000000-0000-4000-8000-00000000f472'
  ) ->> 'action' = 'REVIEW_REQUIRED',
  'canceled retry crossed a second provider boundary'
);
select pg_temp.assert_true(
  (select status = 'UNKNOWN'
          and submit_attempt_count = 1
          and provider_payload = pg_temp.activation_payload(
            'retry-owner@example.invalid', 'retry'
          )
     from public.saas_owner_activation_attempts
    where checkout_id = '00000000-0000-4000-8000-00000000f470'),
  'canceled retry erased its earlier ambiguous delivery evidence'
);

-- Deleting an auth identity after an ambiguous submit must not create an
-- endless RESUME->mark rejection loop. The old UUID remains in immutable
-- audit, the unusable link is terminalized, and a confirmed replacement can
-- receive ACL without another automatic provider submission.
insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f480',
  '00000000-0000-4000-8000-00000000f481',
  'PROVISIONING', 'Identity Replace Fence', 'identity-replace-fence',
  'Replace Owner', 'replace-owner@example.invalid', '5511999999999',
  '00000000000', '00000000-0000-4000-8000-00000000f401',
  'MONTHLY', 'PIX', 1, 'saas-activation-fence', pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f482',
  'authenticated', 'authenticated', 'replace-owner@example.invalid',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"],"saas_owner_activation_checkout_id":"00000000-0000-4000-8000-00000000f480"}',
  '{"full_name":"Replace Owner"}', pg_catalog.now(), pg_catalog.now()
);
select public.claim_saas_owner_activation(
  '00000000-0000-4000-8000-00000000f480',
  'saas-activation-fence', 'replace-owner@example.invalid',
  '00000000-0000-4000-8000-00000000f483', 300
);
select public.stage_saas_owner_activation_payload(
  '00000000-0000-4000-8000-00000000f480',
  '00000000-0000-4000-8000-00000000f483',
  '00000000-0000-4000-8000-00000000f482',
  pg_temp.activation_payload('replace-owner@example.invalid', 'replace')
);
select public.mark_saas_owner_activation_submitting(
  '00000000-0000-4000-8000-00000000f480',
  '00000000-0000-4000-8000-00000000f483',
  '00000000-0000-4000-8000-00000000f482'
);
select public.finish_saas_owner_activation(
  '00000000-0000-4000-8000-00000000f480',
  '00000000-0000-4000-8000-00000000f483',
  'UNKNOWN', null, 'identity_replacement_fixture'
);
delete from auth.users
 where id = '00000000-0000-4000-8000-00000000f482';
select pg_temp.assert_true(
  public.claim_saas_owner_activation(
    '00000000-0000-4000-8000-00000000f480',
    'saas-activation-fence', 'replace-owner@example.invalid',
    '00000000-0000-4000-8000-00000000f484', 300
  ) ->> 'status' = 'FAILED',
  'deleted submit owner remained in an unresumable nonterminal loop'
);
select pg_temp.assert_true(
  (select owner_user_id is null
          and initial_owner_user_id =
            '00000000-0000-4000-8000-00000000f482'
          and provider_payload is null
     from public.saas_owner_activation_attempts
    where checkout_id = '00000000-0000-4000-8000-00000000f480'),
  'deleted owner identity or its immutable audit was corrupted'
);
insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f485',
  'authenticated', 'authenticated', 'replace-owner@example.invalid',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"],"saas_owner_activation_checkout_id":"00000000-0000-4000-8000-00000000f480"}',
  '{"full_name":"Replace Owner"}', pg_catalog.now(), pg_catalog.now()
);
select pg_temp.assert_true(
  public.repair_saas_owner_access(
    '00000000-0000-4000-8000-00000000f480',
    '00000000-0000-4000-8000-00000000f485'
  ) ->> 'action' = 'REPAIRED',
  'replacement owner could not recover paid tenant access'
);
select pg_temp.assert_true(
  (select status = 'FAILED'
          and owner_user_id = '00000000-0000-4000-8000-00000000f485'
          and initial_owner_user_id =
            '00000000-0000-4000-8000-00000000f482'
     from public.saas_owner_activation_attempts
    where checkout_id = '00000000-0000-4000-8000-00000000f480')
  and exists (
    select 1 from public.tenant_memberships
     where user_id = '00000000-0000-4000-8000-00000000f485'
       and tenant_id = 'saas-activation-fence'
       and role = 'SCHOOL_ADMIN'
       and status = 'ACTIVE'
  ),
  'replacement owner repair lost audit or failed to install membership'
);

-- If cancellation wins after Edge created a replacement identity, SQL may
-- authorize compensation only for that checkout's untouched quarantine user.
-- A null preflight never creates an account for an inactive checkout, and any
-- sign of real access turns cleanup into manual review.
insert into public.saas_checkout_intents (
  id, idempotency_key, status, school_name, tenant_slug, owner_name,
  owner_email, owner_phone, owner_cpf_cnpj, plan_id, billing_cycle,
  billing_type, amount, tenant_id, paid_at, metadata
) values (
  '00000000-0000-4000-8000-00000000f490',
  '00000000-0000-4000-8000-00000000f491',
  'CANCELLED', 'Cleanup Race Fence', 'cleanup-race-fence', 'Cleanup Owner',
  'cleanup-owner@example.invalid', '5511999999999', '00000000000',
  '00000000-0000-4000-8000-00000000f401', 'MONTHLY', 'PIX', 1,
  'saas-activation-fence', pg_catalog.now(),
  '{"testMode":true,"test_fixture":true}'::jsonb
);
select public.claim_saas_owner_activation(
  '00000000-0000-4000-8000-00000000f490',
  'saas-activation-fence', 'cleanup-owner@example.invalid',
  '00000000-0000-4000-8000-00000000f493', 300
);
insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000f492',
  'authenticated', 'authenticated', 'cleanup-owner@example.invalid',
  pg_catalog.now(),
  '{"provider":"email","providers":["email"],"saas_owner_activation_checkout_id":"00000000-0000-4000-8000-00000000f490"}',
  '{"full_name":"Cleanup Owner"}', pg_catalog.now(), pg_catalog.now()
);
select pg_temp.assert_true(
  public.repair_saas_owner_access(
    '00000000-0000-4000-8000-00000000f490',
    null
  ) ->> 'action' = 'NOT_REQUIRED',
  'inactive checkout null preflight requested a new identity'
);
select pg_temp.assert_true(
  public.repair_saas_owner_access(
    '00000000-0000-4000-8000-00000000f490',
    '00000000-0000-4000-8000-00000000f492'
  ) ->> 'action' = 'NOT_REQUIRED',
  'inactive checkout repair remains fenced without cleanup'
);
select pg_temp.assert_true(
  public.classify_saas_owner_activation_identity(
    '00000000-0000-4000-8000-00000000f490',
    '00000000-0000-4000-8000-00000000f493',
    '00000000-0000-4000-8000-00000000f492'
  ) ->> 'action' = 'NOT_REQUIRED',
  'cancelled checkout no longer reuses dormant checkout-owned identities'
);
update public.profiles
   set tenant_id = 'saas-activation-fence',
       role = 'SCHOOL_ADMIN',
       status_financial = 'ACTIVE'
 where id = '00000000-0000-4000-8000-00000000f492';
select pg_temp.assert_true(
  public.repair_saas_owner_access(
    '00000000-0000-4000-8000-00000000f490',
    '00000000-0000-4000-8000-00000000f492'
  ) ->> 'action' = 'NOT_REQUIRED',
  'identity with real access is not destructively reclassified'
);

rollback;
